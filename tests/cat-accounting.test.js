import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNanoBenchmark,applyBrokerFee,toNanoPortfolio,initialPortfolio,portfolioValue} from '../lib/finance.js';
import {cashActivityAccounting} from '../lib/cash-accounting.js';
import {rebuildLedger,readLedger} from '../lib/reconciliation.js';
import {replayEconomicDefinitions,replaySharedActions} from '../lib/action-ledger.js';
import {managedReplay} from '../lib/managed-actions.js';
import {managedAccountProblem,managedOrderCheck} from '../lib/managed-policy.js';
import {ledgerView} from '../lib/valuation.js';
import {observedValuationHistory} from '../lib/observed-valuation.js';
import {temporaryDatabase} from './helpers.js';
import {append,hash} from '../lib/store.js';
const actual=JSON.parse(readFileSync(new URL('./fixtures/actual-cash-activities-2026-10-28.json',import.meta.url),'utf8')).records;
const start='2026-10-27T13:31:45.975Z',cutoff='2026-10-28T14:20:00.000Z';
const original=JSON.parse(readFileSync(new URL('./fixtures/actual-opening-fills-2026-10-27.json',import.meta.url),'utf8')).records;
function fixture(){return structuredClone([...original,...actual]);}
function scan(rows,n=1){const [s,p,r]=structuredClone(actual);for(const e of [s,p,r]){e.id+='-repeat-'+n;e.seq+=n*10;e.created_at=new Date(Date.parse(e.created_at)+n*1000).toISOString();}s.payload.until=new Date(Date.parse(s.payload.until)+n*1000).toISOString();p.payload.scan_id=s.id;r.payload.scan_id=s.id;r.payload.until=s.payload.until;p.payload.source_url='https://paper-api.alpaca.markets/v2/account/activities?'+new URLSearchParams({direction:'asc',page_size:'100',until:s.payload.until});for(const k of ['retrieval_started_at','observed_at'])p.payload[k]=new Date(Date.parse(p.payload[k])+n*1000).toISOString();p.payload.activities=structuredClone(rows);r.payload.page_ids=[p.id];r.payload.activity_count=rows.length;r.payload.non_fill_count=rows.filter(a=>a.activity_type!=='FILL').length;return [s,p,r];}

test('actual four-activity receipts: exact CAT expense, opening funding once, original benchmark/basis preserved',async()=>{
 for(const r of [...original,...actual])assert.equal(await hash({kind:r.kind,payload:r.payload}),r.digest);
 const events=fixture(),before=structuredClone(events),ledger=rebuildLedger(events,cutoff);
 assert.equal(ledger.status,'ready');assert.equal(ledger.fill_count,2);assert.equal(ledger.portfolio.cash_nanos,'96160010000000');assert.equal(ledger.portfolio.fees_nanos,'10000000');assert.equal(ledger.portfolio.realized_pnl_nanos,'-10000000');assert.equal(ledger.portfolio.holdings.SPY.cost_nanos,'3839980000000');assert.equal(ledger.portfolio.holdings.SPY.quantity,5);
 assert.deepEqual(ledger.benchmark,events[0].payload.benchmark);assert.equal(ledger.cash_activity_accounting.funding.length,1);assert.equal(ledger.cash_activity_accounting.funding[0].opening_id,events[0].id);
 assert.equal(ledger.cash_activity_accounting.fees[0].economic_date,'2026-10-27');assert.equal(ledger.cash_activity_accounting.fees[0].ordering_time,'2026-10-28T00:05:41.098188Z');assert.equal(ledger.cash_activity_accounting.fees[0].observed_at,actual[2].created_at);
 assert.equal(BigInt(ledger.portfolio.cash_nanos)+BigInt(ledger.portfolio.holdings.SPY.cost_nanos)+BigInt(ledger.portfolio.fees_nanos),100000000000000n);assert.deepEqual(events,before);
 for(const replay of [replaySharedActions(events[0],events,cutoff),managedReplay(events[0],events,cutoff),replayEconomicDefinitions(events[0],events,cutoff,[])])assert.deepEqual(replay.portfolio,ledger.portfolio);
});

test('duplicate scans and duplicate helper calls charge once, including fully consumed cash',()=>{
 const events=fixture(),rows=actual[1].payload.activities;events.push(...scan(rows));const ledger=rebuildLedger(events,cutoff);assert.equal(ledger.status,'ready');assert.equal(ledger.portfolio.cash_nanos,'96160010000000');assert.equal(ledger.cash_activity_accounting.fees.length,1);
 const p=toNanoPortfolio(initialPortfolio());p.cash_nanos='10000000';p.cash_cents=1;const fee=ledger.cash_activity_accounting.fees[0],first=applyBrokerFee(p,fee);assert.deepEqual(applyBrokerFee(first,fee),first);assert.throws(()=>applyBrokerFee(first,{...fee,amount_nanos:'20000000'}),/Conflicting/);
});

test('knowledge-time replay never imports later fee receipts; completion and chronology both required',()=>{
 const events=fixture();for(const at of ['2026-10-28T03:33:36.613Z','2026-10-28T14:19:49.300Z']){const old=rebuildLedger(events,at);assert.equal(old.status,'ready');assert.equal(old.portfolio.cash_nanos,'96160020000000');assert.equal(old.portfolio.fees_nanos,'0');}
 const pending=rebuildLedger(events,actual[1].created_at);assert.equal(pending.status,'blocked');assert.equal(pending.portfolio.fees_nanos,'0');
 assert.equal(rebuildLedger(events,actual[2].created_at).portfolio.fees_nanos,'10000000');
 const broken=fixture();broken[6].payload.activities[0].created_at='2026-10-28T16:00:00Z';assert.equal(rebuildLedger(broken,cutoff).status,'blocked');assert.equal(rebuildLedger(broken,cutoff).portfolio.fees_nanos,'0');
});

test('unsupported fee/funding fields, reversals, precision and incomplete provenance never become adjustments',()=>{
 const cases=[{status:'reversed'},{currency:'EUR'},{activity_sub_type:'OTHER'},{net_amount:'0.01'},{net_amount:'-0'},{net_amount:'-0.0000000001'},{created_at:'bad'},{date:'2026-02-30'},{reversal_id:'other'},{created_at:'2026-10-26T12:00:00Z',date:'2026-10-26'}];
 for(const change of cases){const events=fixture();Object.assign(events[6].payload.activities[0],change);const l=rebuildLedger(events,cutoff);assert.equal(l.status,'blocked',JSON.stringify(change));assert.equal(l.portfolio.fees_nanos,'0');}
 for(const change of [{net_amount:'100001'},{net_amount:'-100000'},{created_at:'2026-10-27T16:00:00Z'},{activity_type:'JNLS'},{status:'pending'}]){const e=fixture();Object.assign(e[6].payload.activities[1],change);assert.equal(rebuildLedger(e,cutoff).status,'blocked');assert.equal(rebuildLedger(e,cutoff).portfolio.cash_nanos,'96160010000000');}
 for(const mutate of [e=>e[7].payload.complete=false,e=>e[7].payload.page_ids=[],e=>e[6].payload.source_url='https://evil.invalid',e=>e[6].payload.observed_at='2026-10-28T00:00:00Z',e=>e[7].payload.activity_count=3]){const e=fixture();mutate(e);assert.equal(rebuildLedger(e,cutoff).status,'blocked');assert.equal(rebuildLedger(e,cutoff).portfolio.fees_nanos,'0');}
});

test('contradictions, disappearance, unknown cash and duplicate funding block without inferred compensation',()=>{
 for(const mutate of [rows=>{rows[0].net_amount='-0.02';},rows=>{rows[0].status='reversed';},rows=>{rows[2].price='800';},rows=>rows.splice(0,1),rows=>rows.push({...rows[1],id:'new-funding'}),rows=>rows.push({...rows[0],id:'unknown',activity_type:'DIV'})]){
  const e=fixture(),rows=structuredClone(actual[1].payload.activities);mutate(rows);e.push(...scan(rows));const l=rebuildLedger(e,cutoff);assert.equal(l.status,'blocked');assert.equal(l.portfolio.cash_nanos,'96160010000000');assert.match(managedAccountProblem(e),/activity evidence/);
 }
});

test('new executed fee evidence reduces cash and NAV exactly; portfolio risk sees lower spendable cash',()=>{
 const e=fixture(),rows=structuredClone(actual[1].payload.activities);rows.push({...rows[0],id:'new-cat-fee',net_amount:'-0.02',created_at:'2026-10-28T14:19:00Z',date:'2026-10-28'});e.push(...scan(rows));const l=rebuildLedger(e,cutoff);assert.equal(l.status,'ready');assert.equal(l.portfolio.cash_nanos,'96159990000000');assert.equal(l.portfolio.fees_nanos,'30000000');
 assert.equal(portfolioValue(l.portfolio,{SPY:{nanos:'768000000000'}}).value_nanos,'99999990000000');
 const snapshot={retrieved_at:cutoff,clock:{timestamp:cutoff,is_open:true,next_close:'2026-10-28T20:00:00Z',next_open:'2026-10-29T13:30:00Z'},account:{cash:96159.99,cash_text:'96159.99',status:'ACTIVE',currency:'USD'},positions:[{symbol:'SPY',side:'long',quantity:5,cost_basis_text:'3839.98'}],open_orders:[],quotes:{SPY:{price:768,price_text:'768',market_data_at:cutoff,feed:'iex'}}};
 const check=managedOrderCheck({symbol:'SPY',side:'buy',quantity:1,limit_price_cents:9616000},{portfolio:l.portfolio,snapshot,now:cutoff,valid_until:'2026-10-28T15:00:00Z',ends_at:'2027-04-25T13:31:45.975Z',broker_basis:l.broker_basis});assert.equal(check.ok,false);assert.ok(check.errors.some(s=>/cash/i.test(s)));
 l.action_coverage={ok:true};const view=ledgerView(l,{seq:500,created_at:cutoff,payload:snapshot},cutoff,{seq:501,created_at:cutoff,payload:{status:'reconciled',problems:[]}});assert.equal(view.portfolio.fees,0.03);assert.equal(view.portfolio.cash,96159.99);assert.equal(view.portfolio.gain,-0.01);
});

test('persistent receipt-time ledger and observed valuations retain old cash, then recognize actual expense',async t=>{
 const {db}=temporaryDatabase(t);for(const e of original)await append(db,{id:e.id,kind:e.kind,payload:e.payload,actor:e.actor},e.created_at);
 const oldAt='2026-10-28T03:33:36.613Z',before=await readLedger(db,oldAt);assert.equal(before.portfolio.cash_nanos,'96160020000000');
 for(const e of actual)await append(db,{id:e.id,kind:e.kind,payload:e.payload,actor:e.actor},e.created_at);
 assert.deepEqual(await readLedger(db,oldAt),before);const after=await readLedger(db,cutoff);assert.equal(after.portfolio.cash_nanos,'96160010000000');
 for(const [l,at,cash,expected] of [[before,oldAt,'96160.02','100000020000000'],[after,cutoff,'96160.01','100000010000000']]){
  l.action_coverage={ok:true};const snapshot={id:'synthetic-observation',seq:900,created_at:at,payload:{account:{cash:Number(cash),cash_text:cash},positions:[{symbol:'SPY',side:'long',quantity:5,cost_basis_text:'3839.98'}],quotes:{SPY:{price:768,price_text:'768',market_data_at:at,feed:'iex'}}}};
  const {observedLedgerView}=await import('../lib/observed-valuation.js');const v=observedLedgerView(l,snapshot,at,{seq:901,created_at:at,payload:{status:'reconciled',problems:[]}});assert.equal(v.portfolio.value_nanos,expected);assert.equal(v.portfolio.fees,at===oldAt?0:0.01);
 }
});

test('recovery binds expense to a complete page while preserving first observation and rejecting URL ambiguity',()=>{
 const e=fixture();e[7].payload.complete=false;e.push(...scan(actual[1].payload.activities));const ledger=rebuildLedger(e,cutoff);assert.equal(ledger.status,'ready');assert.equal(ledger.portfolio.cash_nanos,'96160010000000');const fee=ledger.cash_activity_accounting.fees[0];assert.equal(fee.raw_event_id,e[9].id);assert.equal(fee.first_seen_raw_event_id,e[6].id);assert.equal(fee.completion_id,e[10].id);
 for(const suffix of ['#extra','&after=2026-10-28']){const broken=fixture();broken[6].payload.source_url+=suffix;assert.equal(rebuildLedger(broken,cutoff).status,'blocked');assert.equal(rebuildLedger(broken,cutoff).portfolio.fees_nanos,'0');}
});
