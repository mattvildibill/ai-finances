import test from 'node:test';import assert from 'node:assert/strict';
import {temporaryDatabase,testEnv} from './helpers.js';
import {completedPilot,actor} from './universe-fixtures.js';
import {append,latest} from '../lib/store.js';
import {observe} from '../lib/alpaca.js';
import {readLedger,reconcile} from '../lib/reconciliation.js';
import {observedLedgerView} from '../lib/observed-valuation.js';
test('observed valuation preserves unknown legacy provenance and rejects future receipt provenance',async t=>{
 const {db}=temporaryDatabase(t),r=await completedPilot(db);const snapshot=await append(db,{id:'independent-mark-review',kind:'snapshot',actor,payload:await observe(testEnv,r.f.fetcher)});await reconcile(db,testEnv,'independent-mark-recon',actor,r.f.fetcher);
 const ledger=await readLedger(db),receipt=await latest(db,'reconciliation'),asOf=new Date().toISOString();
 const legacy=structuredClone(snapshot);delete legacy.payload.source;delete legacy.payload.retrieved_at;delete legacy.payload.quotes.SPY.source;delete legacy.payload.quotes.SPY.retrieved_at;
 const observed=observedLedgerView(ledger,legacy,asOf,receipt);assert.equal(observed.portfolio.value,100000);assert.equal(observed.portfolio.observation.marks[0].source,null);assert.equal(observed.portfolio.observation.marks[0].retrieved_at,null);
 const future=structuredClone(snapshot);future.payload.quotes.SPY.retrieved_at=new Date(Date.parse(asOf)+60000).toISOString();assert.equal(observedLedgerView(ledger,future,asOf,receipt).portfolio.value,null);
 const markOnly=structuredClone(snapshot);markOnly.payload.positions[0].market_value=1;markOnly.payload.positions[0].unrealized_pl=-499;
 const unaffected=observedLedgerView(ledger,markOnly,asOf,receipt);assert.equal(unaffected.account_drift,false);assert.equal(unaffected.portfolio.value,100000);
});
