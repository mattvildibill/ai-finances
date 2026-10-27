import test from 'node:test';
import assert from 'node:assert/strict';
import {append,getEvent,listEvents} from '../lib/store.js';
import {createBenchmark} from '../lib/finance.js';
import {readLedger,reconcile} from '../lib/reconciliation.js';
import {state} from '../lib/service.js';
import {temporaryDatabase,testEnv} from './helpers.js';
import {seedCoverage} from './action-fixtures.js';
const actor='fixture:closure';const client='blue-'+'e'.repeat(40);
async function setup(t){
 const {db}=temporaryDatabase(t);const start=new Date(Date.now()-10000).toISOString();
 await append(db,{id:'closure-opening-fixture',kind:'experiment_opened',actor,payload:{initial_cash_cents:10000000,started_at:start,benchmark:createBenchmark({started_at:start,observed_at:start,market_time:start,price_cents:50000})}},start);
 await seedCoverage(db);
 await append(db,{id:'closure-intent-fixture',kind:'order_intent',actor,payload:{client_order_id:client,order:{symbol:'SPY',side:'buy',qty:'1',limit_price:'501.00'}}});
 const original={id:'closure-broker-order',client_order_id:client,symbol:'SPY',side:'buy',qty:'1',filled_qty:'1',status:'filled',type:'limit',time_in_force:'day',extended_hours:false,asset_class:'us_equity',limit_price:'501.00',filled_avg_price:'500.00'};
 let order=structuredClone(original);
 const activity={id:'closure-broker-fill',activity_type:'FILL',type:'fill',order_id:original.id,symbol:'SPY',side:'buy',qty:'1',price:'500.00',transaction_time:new Date(Date.now()-1000).toISOString()};
 const calls=[];const fetcher=async(url,options)=>{calls.push(options.method);const p=new URL(url).pathname;return Response.json(p==='/v2/orders:by_client_order_id'?order:p==='/v2/account/activities/FILL'?[activity]:p==='/v2/account'?{status:'ACTIVE',currency:'USD',cash:'99500.00'}:p==='/v2/positions'?[{symbol:'SPY',side:'long',qty:'1'}]:[]);};
 const first=await reconcile(db,testEnv,'closure-first-run',actor,fetcher);assert.equal(first.payload.status,'reconciled');
 const records=await listEvents(db,new Date().toISOString());const closure=records.find(e=>e.kind==='order_closed');const fill=records.find(e=>e.kind==='ledger_fill');
 return {db,fetcher,original,calls,closure,fill,setOrder:value=>{order=value;}};
}

test('later terminal status contradiction remains blocked after original status returns and preserves immutable evidence',async t=>{
 const f=await setup(t);f.setOrder({...f.original,status:'canceled'});
 const changed=await reconcile(f.db,testEnv,'closure-status-change',actor,f.fetcher);assert.equal(changed.payload.status,'blocked');assert.ok(changed.payload.problems.some(p=>p.code==='closed_order_conflict'));
 const records=await listEvents(f.db,new Date().toISOString());const discrepancy=records.find(e=>e.kind==='order_closure_conflict');assert.ok(discrepancy);assert.ok(discrepancy.payload.differences.includes('status'));
 assert.deepEqual(await getEvent(f.db,f.closure.id),f.closure);assert.deepEqual(await getEvent(f.db,f.fill.id),f.fill);assert.equal(records.filter(e=>e.kind==='broker_order').length,2);
 assert.equal((await readLedger(f.db)).status,'blocked');assert.equal((await state(f.db)).accounting.status,'blocked');
 f.setOrder(f.original);const reverted=await reconcile(f.db,testEnv,'closure-status-reverted',actor,f.fetcher);assert.equal(reverted.payload.status,'blocked');
 assert.equal((await listEvents(f.db,new Date().toISOString())).filter(e=>e.kind==='order_closure_conflict').length,1);assert.ok(f.calls.every(method=>method==='GET'));
});

test('post-closure identity, requested quantity, filled quantity and execution term changes are durable blockers',async t=>{
 for(const patch of [{id:'different-order'},{client_order_id:'blue-'+'f'.repeat(40)},{symbol:'AAPL'},{side:'sell'},{qty:'2'},{filled_qty:'0'},{limit_price:'502.00'}]){
  const f=await setup(t);f.setOrder({...f.original,...patch});
  const result=await reconcile(f.db,testEnv,'closure-material-change',actor,f.fetcher);assert.equal(result.payload.status,'blocked',JSON.stringify(patch));
  const records=await listEvents(f.db,new Date().toISOString());assert.equal(records.filter(e=>e.kind==='order_closure_conflict').length,1);assert.equal(records.filter(e=>e.kind==='ledger_fill').length,1);assert.deepEqual(await getEvent(f.db,f.closure.id),f.closure);
  assert.equal((await readLedger(f.db)).status,'blocked');
 }
});

test('equivalent numeric receipts and nonmaterial metadata updates preserve reconciliation',async t=>{
 const f=await setup(t);f.setOrder({...f.original,qty:'1.000000000',filled_qty:'1.0',limit_price:'501.000',updated_at:new Date().toISOString(),name:'new display metadata'});
 const equivalent=await reconcile(f.db,testEnv,'closure-equivalent-run',actor,f.fetcher);assert.equal(equivalent.payload.status,'reconciled');assert.equal(equivalent.payload.new_fills,0);
 assert.deepEqual(await getEvent(f.db,f.closure.id),f.closure);assert.equal((await listEvents(f.db,new Date().toISOString())).some(e=>e.kind==='order_closure_conflict'),false);
});

test('a contradiction already preserved by an older release cannot be erased by a later equivalent receipt',async t=>{
 const f=await setup(t);
 await append(f.db,{id:'legacy-contradictory-order',kind:'broker_order',actor,payload:{intent_id:'closure-intent-fixture',order:{...f.original,status:'canceled'}}});
 const result=await reconcile(f.db,testEnv,'closure-history-scan',actor,f.fetcher);assert.equal(result.payload.status,'blocked');
 const conflict=(await listEvents(f.db,new Date().toISOString())).find(e=>e.kind==='order_closure_conflict');assert.equal(conflict.payload.broker_order_event_id,'legacy-contradictory-order');assert.equal((await readLedger(f.db)).status,'blocked');
});


test('later GET-only order observation conflicts persist; equivalent sanitized observations do not',async t=>{
 for(const status of ['filled','canceled']){
  const f=await setup(t);
  await append(f.db,{id:'sanitized-order-observation',kind:'order_observed',actor,payload:{intent_id:'closure-intent-fixture',id:f.original.id,client_order_id:client,symbol:'SPY',side:'buy',qty:'1',filled_qty:'1',status}});
  const result=await reconcile(f.db,testEnv,'closure-observation-scan',actor,f.fetcher);
  assert.equal(result.payload.status,status==='filled'?'reconciled':'blocked');
 }
});

test('either replacement-chain field remains a durable conflict after a later clean receipt',async t=>{
 for(const field of ['replaces','replaced_by']){
  const f=await setup(t);f.setOrder({...f.original,[field]:'another-broker-order'});
  const first=await reconcile(f.db,testEnv,'replacement-observed',actor,f.fetcher);assert.equal(first.payload.status,'blocked');
  const records=await listEvents(f.db,new Date().toISOString()),conflict=records.find(e=>e.kind==='order_closure_conflict');
  assert.ok(conflict.payload.differences.includes(field));
  const raw=await getEvent(f.db,conflict.payload.broker_order_event_id);assert.equal(raw.payload.order[field],'another-broker-order');
  f.setOrder(f.original);const clean=await reconcile(f.db,testEnv,'replacement-then-clean',actor,f.fetcher);
  assert.equal(clean.payload.status,'blocked');assert.equal((await state(f.db)).accounting.status,'blocked');
  assert.deepEqual(await getEvent(f.db,f.closure.id),f.closure);assert.deepEqual(await getEvent(f.db,f.fill.id),f.fill);
  assert.deepEqual(await getEvent(f.db,raw.id),raw);assert.equal((await listEvents(f.db,new Date().toISOString())).filter(e=>e.kind==='order_closure_conflict').length,1);
 }
});

test('historical-only replacement-chain receipts remain material even when current broker receipt is clean',async t=>{
 for(const field of ['replaces','replaced_by'])for(const kind of ['broker_order','order_observed']){
  const f=await setup(t),order={...f.original,[field]:'historical-replacement'};
  const raw=await append(f.db,{id:'historical-replacement-receipt',kind,actor,payload:kind==='broker_order'?{intent_id:'closure-intent-fixture',order}:{intent_id:'closure-intent-fixture',...order}});
  const result=await reconcile(f.db,testEnv,'historical-replacement-scan',actor,f.fetcher);assert.equal(result.payload.status,'blocked');
  const conflict=(await listEvents(f.db,new Date().toISOString())).find(e=>e.kind==='order_closure_conflict');
  assert.equal(conflict.payload.broker_order_event_id,raw.id);assert.ok(conflict.payload.differences.includes(field));
  assert.deepEqual(await getEvent(f.db,raw.id),raw);assert.deepEqual(await getEvent(f.db,f.closure.id),f.closure);assert.deepEqual(await getEvent(f.db,f.fill.id),f.fill);
  assert.equal((await readLedger(f.db)).status,'blocked');
 }
});
