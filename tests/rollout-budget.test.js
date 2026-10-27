import test from 'node:test';
import assert from 'node:assert/strict';
import {rolloutBudget} from '../lib/rollout-budget.js';
import {usdNanos} from '../lib/precision.js';

function journal(){
 const events=[];let n=0;const append=(kind,payload)=>{const e={id:'event-'+(++n),seq:n,kind,payload};events.push(e);return e;};
 const intent=({quantity=1,side='buy',limit='600.00',mark='500.00',symbol='SPY'}={})=>{
  const client='blue-'+String(n+1).padStart(40,'0');
  const order={client_order_id:client,symbol,side,qty:String(quantity),limit_price:limit,type:'limit',time_in_force:'day',extended_hours:false};
  return append('order_intent',{client_order_id:client,order,snapshot:{quotes:{[symbol]:{price_text:mark}}}});
 };
 const broker=(i,{filled='0',status='new'}={})=>append('broker_order',{intent_id:i.id,order:{...i.payload.order,id:'broker-'+i.id,filled_qty:String(filled),status}});
 const fill=(i,quantity,price)=>{
  const id='activity-'+(n+1),order_id='broker-'+i.id,transaction_time='2026-10-27T14:00:00Z';
  const activity={id,activity_type:'FILL',type:'fill',order_id,symbol:i.payload.order.symbol,side:i.payload.order.side,qty:String(quantity),price,transaction_time};
  const raw=append('broker_activity',{broker_activity_id:id,activity});
  return append('ledger_fill',{broker_activity_id:id,raw_event_id:raw.id,intent_id:i.id,order_id,fill:{id:'alpaca-fill:'+id,symbol:activity.symbol,side:activity.side,quantity,quantity_text:String(quantity),price_text:price,fee_cents:0,occurred_at:transaction_time}});
 };
 const close=(i,receipt)=>append('order_closed',{intent_id:i.id,order_id:receipt.payload.order.id,client_order_id:i.payload.client_order_id,status:receipt.payload.order.status,filled_qty:receipt.payload.order.filled_qty,accounted_quantity:receipt.payload.order.filled_qty,order:structuredClone(receipt.payload.order)});
 return {events,append,intent,broker,fill,close};
}

test('budget permanently includes pilot and subsequent purchases; sales and reported cash never restore it',()=>{
 const j=journal();const pilot=j.intent();const p=j.broker(pilot,{filled:1,status:'filled'});j.fill(pilot,1,'500.123456789');j.close(pilot,p);
 const buy=j.intent({quantity:2,limit:'200.00',mark:'190.00',symbol:'AAPL'});const b=j.broker(buy,{filled:2,status:'filled'});j.fill(buy,2,'190.123456789');j.close(buy,b);
 const sell=j.intent({quantity:2,side:'sell',limit:'190.00',mark:'200.00',symbol:'AAPL'});const s=j.broker(sell,{filled:2,status:'filled'});j.fill(sell,2,'210.00');j.close(sell,s);
 j.append('snapshot',{account:{cash:'100100.00'}});
 assert.deepEqual(rolloutBudget(j.events),{spent:usdNanos('880.370370367'),reserved:0n,total:usdNanos('880.370370367')});
});

test('unsubmitted and partially filled intents reserve exact remaining shares at max of original mark and limit',()=>{
 const j=journal();j.intent({quantity:1,limit:'500.00',mark:'500.000000001'});
 const partial=j.intent({quantity:5,limit:'10.00',mark:'12.123456789'});j.broker(partial,{filled:2,status:'partially_filled'});j.fill(partial,2,'9.123456789');
 const expected=usdNanos('536.370370368');
 assert.deepEqual(rolloutBudget(j.events),{spent:usdNanos('18.246913578'),reserved:expected,total:usdNanos('554.617283946')});
});

test('terminal cancellation releases only unused reserve after matching evidenced quantities',()=>{
 const j=journal();const i=j.intent({quantity:5,limit:'10.00',mark:'12.00'});const receipt=j.broker(i,{filled:2,status:'canceled'});j.fill(i,2,'9.00');
 assert.equal(rolloutBudget(j.events).reserved,usdNanos('36'));
 const closed=j.close(i,receipt);assert.deepEqual(rolloutBudget(j.events),{spent:usdNanos('18'),reserved:0n,total:usdNanos('18')});
 closed.payload.accounted_quantity='0';assert.throws(()=>rolloutBudget(j.events),/terminal quantities/);
});

test('unknown, missing, conflicting or duplicated fill evidence cannot disappear from the budget',()=>{
 const base=()=>{const j=journal();const i=j.intent();const b=j.broker(i,{filled:1,status:'filled'});const f=j.fill(i,1,'500');j.close(i,b);return {j,i,f};};
 for(const change of [
  ({j,f})=>{j.events.splice(j.events.indexOf(f),1);},
  ({f})=>{f.payload.intent_id='missing';},
  ({f})=>{f.payload.raw_event_id='missing';},
  ({f})=>{f.payload.fill.price_text='499';},
  ({j,f})=>{j.append('ledger_fill',structuredClone(f.payload));},
  ({j})=>{const raw=j.events.find(e=>e.kind==='broker_activity');j.append('broker_activity',{...raw.payload,activity:{...raw.payload.activity,price:'499'}});},
  ({j})=>{j.append('broker_activity',{broker_activity_id:'external',activity:{id:'external',activity_type:'FILL',type:'fill',order_id:'unknown',symbol:'SPY',side:'buy',qty:'1',price:'1'}});},
 ]){const fixture=base();change(fixture);assert.throws(()=>rolloutBudget(fixture.j.events));}
});

test('closed allowance cannot reopen through later conflicting broker status or changed order identity',()=>{
 const j=journal();const i=j.intent();const b=j.broker(i,{filled:1,status:'filled'});j.fill(i,1,'500');j.close(i,b);
 j.broker(i,{filled:0,status:'new'});assert.throws(()=>rolloutBudget(j.events),/terminal evidence/);
 const k=journal();const intent=k.intent();const receipt=k.broker(intent);receipt.payload.order.id='first';k.broker(intent);assert.throws(()=>rolloutBudget(k.events),/ambiguous/);
});

test('unsupported quantity, precision, fees, limit violations and missing marks fail closed',()=>{
 for(const config of [{quantity:0.5},{mark:'500.0000000001'},{limit:'1.001'},{side:'short'}]){const j=journal();j.intent(config);assert.throws(()=>rolloutBudget(j.events));}
 for(const change of [f=>{f.payload.fill.fee_cents=1;},f=>{f.payload.fill.quantity=0.5;},f=>{f.payload.fill.price_text='700';}]){
  const j=journal();const i=j.intent();j.broker(i,{filled:1,status:'filled'});const f=j.fill(i,1,'500');change(f);assert.throws(()=>rolloutBudget(j.events));
 }
 const j=journal();const i=j.intent();delete i.payload.snapshot;assert.throws(()=>rolloutBudget(j.events));
});

test('terminal zero-fill rejects consume no purchases; helper is deterministic and does not mutate history',()=>{
 const j=journal();const i=j.intent();const b=j.broker(i,{filled:0,status:'rejected'});j.close(i,b);
 const before=JSON.stringify(j.events);assert.deepEqual(rolloutBudget(j.events),{spent:0n,reserved:0n,total:0n});assert.deepEqual(rolloutBudget(j.events),{spent:0n,reserved:0n,total:0n});assert.equal(JSON.stringify(j.events),before);
});
