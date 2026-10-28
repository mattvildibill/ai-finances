import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hash,append,getEvent} from '../lib/store.js';
import {reconcile,readLedger} from '../lib/reconciliation.js';
import {brokerBasisDisplayMatch,projectBrokerBasis} from '../lib/broker-basis.js';
import {usdNanos} from '../lib/precision.js';
import {createNanoBenchmark} from '../lib/finance.js';
import {observe} from '../lib/alpaca.js';
import {temporaryDatabase,testEnv,brokerFixture} from './helpers.js';
const receipts=JSON.parse(readFileSync(new URL('./fixtures/actual-spy-basis-mismatch-2026-10-28.json',import.meta.url),'utf8')).records;

test('actual SPY receipts prove exact basis and discrepancy, not an observed position average',async()=>{
 for(const e of receipts)assert.equal(e.digest,await hash({kind:e.kind,payload:e.payload}));
 const original=JSON.parse(readFileSync(new URL('./fixtures/actual-opening-fills-2026-10-27.json',import.meta.url),'utf8')).records;
 const fills=[...original,...receipts].filter(e=>e.kind==='ledger_fill');
 const projection=projectBrokerBasis(fills,'2026-10-28T19:36:55.028Z'),holding=projection.candidates[0].holdings.SPY;
 assert.equal(holding.quantity,32);assert.equal(holding.cost_nanos.numerator,'24654430000000');assert.equal(holding.cost_nanos.denominator,'1');
 const raw=receipts.find(e=>e.seq===674).payload.broker_basis_comparison.candidates[0].checks.find(c=>c.symbol==='SPY').raw;
 assert.equal(raw,'24654.430016');assert.equal(usdNanos(raw)-BigInt(holding.cost_nanos.numerator),16000n);
 assert.equal(brokerBasisDisplayMatch(holding.cost_nanos,raw).matched,false);
 // Hypothesis arithmetic only: this average has NOT been observed in a retained position response.
 const exactAverage=BigInt(holding.cost_nanos.numerator)/32n;
 assert.equal(exactAverage,770450937500n);assert.equal(usdNanos('770.450938')*32n,usdNanos(raw));
 const order=receipts.find(e=>e.kind==='broker_order').payload.order;
 assert.equal(order.filled_avg_price,'770.905556');assert.notEqual(order.filled_avg_price,'770.450938');
});

test('reconciliation retains complete raw position evidence on mismatch without adopting its basis',async t=>{
 const {db}=temporaryDatabase(t),actor='synthetic-position-evidence',at=new Date(Date.now()-10000).toISOString();
 await append(db,{id:'synthetic-position-opening',kind:'experiment_opened',actor,payload:{accounting_policy:'usd-nano-v1',initial_cash_cents:10000000,started_at:at,benchmark:createNanoBenchmark({started_at:at,observed_at:at,market_time:at,price_text:'500'})}},at);
 await append(db,{id:'synthetic-position-fill',kind:'ledger_fill',actor,payload:{fill:{id:'synthetic-position-fill',symbol:'SPY',side:'buy',quantity:32,price_text:'770.4509375',fee_cents:0,occurred_at:at,observed_at:at}}},at);
 const position={symbol:'SPY',qty:'32',side:'long',avg_entry_price:'770.450939',cost_basis:'24654.430016',market_value:'24640',unrealized_pl:'-14.430016',asset_id:'synthetic-asset'};
 const calls=[],fetcher=async(url,options)=>{calls.push({url,method:options.method});const u=new URL(url);assert.equal(u.origin,'https://paper-api.alpaca.markets');assert.equal(options.method,'GET');return Response.json(u.pathname==='/v2/account'?{status:'ACTIVE',currency:'USD',cash:'75345.57'}:u.pathname==='/v2/positions'?[position]:[]);};
 const before=await readLedger(db);const result=await reconcile(db,testEnv,'synthetic-position-reconciliation',actor,fetcher);
 assert.equal(result.payload.status,'blocked');assert.ok(result.payload.problems.some(p=>p.code==='basis_mismatch'));
 assert.deepEqual(result.payload.broker_positions.positions,[position]);assert.equal(result.payload.broker_positions.source_url,'https://paper-api.alpaca.markets/v2/positions');assert.ok(result.payload.broker_positions.retrieval_started_at<=result.payload.broker_positions.observed_at);assert.ok(result.payload.broker_positions.observed_at<=result.created_at);
 assert.equal(result.digest,await hash({kind:result.kind,payload:result.payload}));assert.deepEqual((await readLedger(db)).portfolio,before.portfolio);
 const count=calls.length;assert.deepEqual(await reconcile(db,testEnv,'synthetic-position-reconciliation',actor,()=>{throw Error('retry must not fetch');}),result);assert.equal(calls.length,count);assert.deepEqual(await getEvent(db,result.id),result);
});

test('ordinary snapshot retains reported average text without deriving or normalizing it',async()=>{
 const f=brokerFixture({positions:[{symbol:'SPY',qty:'32',side:'long',avg_entry_price:'770.450938',cost_basis:'24654.430016',market_value:'24640',unrealized_pl:'-14.430016'}]});
 const s=await observe(testEnv,f.fetcher);assert.equal(s.positions[0].avg_entry_price_text,'770.450938');assert.equal(s.positions[0].cost_basis_text,'24654.430016');assert.ok(f.calls.every(c=>c.method==='GET'));
});
