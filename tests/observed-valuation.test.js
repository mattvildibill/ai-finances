import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase,testEnv} from './helpers.js';
import {completedPilot,actor} from './universe-fixtures.js';
import {append,latest,getEvent} from '../lib/store.js';
import {observe} from '../lib/alpaca.js';
import {readLedger,reconcile} from '../lib/reconciliation.js';
import {state} from '../lib/service.js';
import {ledgerView} from '../lib/valuation.js';
import {observedLedgerView,observedValuationHistory} from '../lib/observed-valuation.js';
const now=()=>new Date().toISOString();
async function observation(db,f,id){const snapshot=await append(db,{id,kind:'snapshot',actor,payload:await observe(testEnv,f.fetcher)});await reconcile(db,testEnv,id+'-reconcile',actor,f.fetcher);return snapshot;}

test('stale observed marks retain exact last-known display while execution valuation remains strict',async t=>{
 const {db}=temporaryDatabase(t),r=await completedPilot(db),snapshot=await observation(db,r.f,'post-fill-observation');
 const ledger=await readLedger(db),receipt=await latest(db,'reconciliation'),later=new Date(Date.now()+180000).toISOString();
 const strict=ledgerView(ledger,snapshot,later,receipt);assert.equal(strict.portfolio.value,null);
 const displayed=observedLedgerView(ledger,snapshot,later,receipt);assert.equal(displayed.portfolio.value,100000);assert.equal(displayed.portfolio.cash,99500);assert.equal(displayed.portfolio.holdings[0].market_value,500);assert.equal(displayed.portfolio.valuation_status,'last_known');assert.equal(displayed.portfolio.observation.official_close,false);assert.equal(displayed.portfolio.observation.observed_at,snapshot.created_at);assert.equal(displayed.portfolio.observation.marks[0].market_data_at,snapshot.payload.quotes.SPY.market_data_at);
 assert.deepEqual(await getEvent(db,snapshot.id),snapshot);assert.equal(displayed.benchmark.price_value,100000);
 const missingWatch=structuredClone(snapshot);delete missingWatch.payload.quotes.AAPL;delete missingWatch.payload.quotes.MSFT;assert.equal(observedLedgerView(ledger,missingWatch,later,receipt).portfolio.value,100000);
 const current=await state(db,later);assert.equal(current.portfolio.valuation_status,'last_known');assert.doesNotMatch(current.mandate.performance_basis,/Not started/);assert.equal(current.valuation_history.schema,'observed-nav-v1');assert.ok(current.valuation_history.points.length);
});
test('accounting failures, drift, missing/future/nonpositive marks never masquerade as last-known success',async t=>{
 const {db}=temporaryDatabase(t),r=await completedPilot(db),snapshot=await observation(db,r.f,'guarded-observation'),ledger=await readLedger(db),receipt=await latest(db,'reconciliation');
 for(const change of [s=>{delete s.payload.quotes.SPY;},s=>{s.payload.quotes.SPY.market_data_at=new Date(Date.now()+60000).toISOString();},s=>{s.payload.quotes.SPY.price_text='0';},s=>{s.payload.account.cash_text='1';s.payload.account.cash=1;}]){
  const copy=structuredClone(snapshot);change(copy);const v=observedLedgerView(ledger,copy,now(),receipt);assert.equal(v.portfolio.observation,undefined);assert.equal(v.portfolio.value,null);
 }
 const blocked=observedLedgerView({...ledger,status:'blocked'},snapshot,now(),receipt);assert.equal(blocked.portfolio.value,null);assert.equal(blocked.portfolio.holdings_status,'unknown');
 const bad=observedLedgerView(ledger,snapshot,now(),{...receipt,payload:{status:'blocked',problems:[{code:'cash_mismatch'}]}});assert.equal(bad.portfolio.value,null);
});
test('history uses only verified receipt-time observations, preserves old holdings and exposes gaps',async t=>{
 const {db}=temporaryDatabase(t),r=await completedPilot(db);const before=await observedValuationHistory(db,now());
 // Pre-fill snapshot cannot be revalued with later known holdings/cash.
 assert.ok(before.points.every(p=>p.cash!==99500));
 const first=await observation(db,r.f,'first-history-point');const cutoff=now();await new Promise(resolve=>setTimeout(resolve,5));
 const second=await observation(db,r.f,'second-history-point');const history=await observedValuationHistory(db,now());
 assert.ok(history.points.some(p=>p.snapshot_id===first.id));assert.ok(history.points.some(p=>p.snapshot_id===second.id));assert.equal(history.interpolation,false);assert.ok(history.points.every(p=>p.official_close===false));
 const replay=await observedValuationHistory(db,cutoff);assert.ok(!replay.points.some(p=>p.snapshot_id===second.id));assert.ok(replay.points.every(p=>Date.parse(p.at)<=Date.parse(cutoff)));
 await append(db,{id:'contradiction-visible',kind:'order_closure_conflict',actor,payload:{intent_id:'fixture',closure_id:'fixture'}});
 await append(db,{id:'blocked-history-receipt',kind:'reconciliation',actor,payload:{status:'blocked',problems:[{code:'closed_order_conflict'}]}});
 const blocked=await state(db);assert.equal(blocked.portfolio.value,null);assert.equal(blocked.portfolio.holdings_status,'unknown');assert.ok(blocked.valuation_history.points.length>=2);assert.equal(blocked.last_verified_valuation.cash,99500);assert.equal(blocked.last_verified_valuation.holdings[0].quantity,1);assert.equal(blocked.last_verified_valuation.official_close,false);
});

test('valuation replay retains inception and fills beyond the 500-record UI window',async t=>{
 const {db}=temporaryDatabase(t),r=await completedPilot(db);const snapshot=await observation(db,r.f,'long-history-observation');
 for(let i=0;i<510;i++)await append(db,{id:'tracking-unrelated-'+i,kind:'verification',actor,payload:{summary:'Isolated retained journal record '+i}});
 const current=await state(db);assert.equal(current.history_truncated,true);assert.equal(current.valuation_history.complete_history_read,true);assert.equal(current.last_verified_valuation.snapshot_id,snapshot.id);assert.equal(current.last_verified_valuation.cash,99500);assert.equal(current.portfolio.holdings[0].quantity,1);
});
