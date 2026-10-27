import {decimalUnits,usdNanos,USD_NANOS_PER_CENT} from './precision.js';
import {canonical} from './store.js';

const TERMINAL=new Set(['filled','canceled','expired','rejected']);
const fail=message=>{throw new Error('Rollout budget blocked: '+message);};
const required=(value,label)=>{if(typeof value!=='string'||!value)fail(label+' missing');return value;};
function shares(value,label,{zero=false}={}){
 const units=decimalUnits(value,9,label);
 if(units%1000000000n)fail(label+' is fractional');
 const quantity=units/1000000000n;
 if((zero?quantity<0n:quantity<=0n)||quantity>BigInt(Number.MAX_SAFE_INTEGER))fail(label+' is unsupported');
 return quantity;
}
function positiveMoney(value,label){const units=usdNanos(value,label);if(units<=0n)fail(label+' must be positive');return units;}
function zeroFees(value){for(const field of ['fee','fees','commission','fee_cents','fee_nanos'])if(value[field]!==undefined&&usdNanos(value[field])!==0n)fail('unsupported nonzero fees');}

/** Complete journal required, never a truncated UI/replay page. All amounts are BigInt USD nanos.
 * No cash balance, sale proceeds or authorization revision can replenish gross purchases.
 * This budget is necessary but not sufficient authorization: fresh reconciliation and no-open-order
 * execution guards remain mandatory. Raw unknown/conflicting activity fails closed.
 */
export function rolloutBudget(events){
 if(!Array.isArray(events))fail('complete journal array required');
 const ids=new Map(),intents=new Map(),clients=new Set(),orders=new Map(),rawByActivity=new Map(),fillsByActivity=new Map(),closed=new Map();
 for(const e of events){
  required(e?.id,'event id');if(ids.has(e.id))fail('duplicate journal event '+e.id);ids.set(e.id,e);
  if(!e.payload||typeof e.payload!=='object')fail('event payload missing');
 }
 for(const e of events.filter(e=>e.kind==='order_intent')){
  const p=e.payload,o=p.order;required(p.client_order_id,'client order id');
  if(!/^blue-[a-f0-9]{40}$/.test(p.client_order_id)||clients.has(p.client_order_id))fail('ambiguous client order identity');clients.add(p.client_order_id);
  if(!o||!['buy','sell'].includes(o.side)||!/^\w[\w.-]*$/.test(o.symbol||'')||o.type!=='limit'||o.time_in_force!=='day'||o.extended_hours!==false||o.client_order_id!==p.client_order_id)fail('unsupported intent terms');
  const quantity=shares(o.qty,'intent quantity'),limit=positiveMoney(o.limit_price,'intent limit');if(limit%USD_NANOS_PER_CENT)fail('intent limit is not cent-denominated');
  const quote=p.snapshot?.quotes?.[o.symbol];const mark=positiveMoney(quote?.price_text??quote?.price,'intent mark');
  intents.set(e.id,{event:e,order:o,quantity,limit,reservePrice:mark>limit?mark:limit,filled:0n,brokerId:null,latest:null});
 }
 function bindOrder(intentId,order,seq){
  const intent=intents.get(intentId);if(!intent)fail('order has no intent');
  const o=intent.order;required(order?.id,'broker order id');
  if(order.client_order_id!==intent.event.payload.client_order_id||order.symbol!==o.symbol||order.side!==o.side||shares(order.qty,'broker order quantity')!==intent.quantity)fail('broker order identity differs from intent');
  if(order.type!==undefined&&order.type!=='limit'||order.time_in_force!==undefined&&order.time_in_force!=='day'||order.extended_hours!==undefined&&order.extended_hours!==false||order.limit_price!==undefined&&positiveMoney(order.limit_price,'broker limit')!==intent.limit||order.replaced_by||order.replaces||order.status==='replaced')fail('broker execution terms changed');
  const reported=shares(order.filled_qty,'reported fill quantity',{zero:true});if(reported>intent.quantity)fail('broker overfill');
  if(intent.brokerId&&intent.brokerId!==order.id||orders.has(order.id)&&orders.get(order.id)!==intent)fail('ambiguous order/intent identity');
  intent.brokerId=order.id;orders.set(order.id,intent);
  if(!intent.latest||seq>intent.latest.seq)intent.latest={order,seq,reported};
  return intent;
 }
 for(const e of [...events].sort((a,b)=>a.seq-b.seq)){
  if(['broker_order','order_submitted','order_observed'].includes(e.kind)){
   if(!Number.isSafeInteger(e.seq))fail('order receipt sequence missing');
   bindOrder(e.payload.intent_id,e.kind==='broker_order'?e.payload.order:e.payload,e.seq);
  }
 }
 for(const e of events.filter(e=>e.kind==='broker_activity')){
  const p=e.payload,a=p.activity;required(p.broker_activity_id,'broker activity id');
  if(!a||a.activity_type!=='FILL'||!['fill','partial_fill'].includes(a.type)||a.id!==p.broker_activity_id)fail('unsupported activity receipt');
  const previous=rawByActivity.get(a.id);if(previous&&canonical(previous.payload.activity)!==canonical(a))fail('conflicting activity versions');
  rawByActivity.set(a.id,e);
 }
 let spent=0n,reserved=0n;
 for(const e of events.filter(e=>e.kind==='ledger_fill')){
  const p=e.payload,f=p.fill,intent=intents.get(p.intent_id),raw=ids.get(p.raw_event_id),a=raw?.payload?.activity;
  if(!intent||!f||raw?.kind!=='broker_activity'||p.broker_activity_id!==a?.id||p.order_id!==intent.brokerId||a.order_id!==intent.brokerId||orders.get(p.order_id)!==intent)fail('unlinked ledger fill');
  if(fillsByActivity.has(p.broker_activity_id))fail('activity accounted more than once');
  if(f.symbol!==intent.order.symbol||f.side!==intent.order.side||a.symbol!==f.symbol||a.side!==f.side||f.id!=='alpaca-fill:'+a.id)fail('fill identity mismatch');
  const quantity=shares(f.quantity_text??f.quantity,'ledger fill quantity');
  if(quantity!==shares(f.quantity,'ledger numeric quantity')||quantity!==shares(a.qty,'activity quantity'))fail('fill quantity mismatch');
  if(f.price_text!==undefined&&f.price_cents!==undefined)fail('ambiguous fill price');
  let price;
  if(f.price_text!==undefined)price=positiveMoney(f.price_text,'ledger fill price');
  else{if(!Number.isSafeInteger(f.price_cents)||f.price_cents<=0)fail('invalid legacy fill price');price=BigInt(f.price_cents)*USD_NANOS_PER_CENT;}
  if(price!==positiveMoney(a.price,'activity price'))fail('fill price differs from activity');
  if(f.side==='buy'?price>intent.limit:price<intent.limit)fail('fill violates original limit');
  zeroFees(f);zeroFees(a);
  if(f.occurred_at!==a.transaction_time)fail('fill occurrence differs from activity');
  intent.filled+=quantity;if(intent.filled>intent.quantity)fail('accounted order overfill');
  if(f.side==='buy')spent+=quantity*price;
  fillsByActivity.set(p.broker_activity_id,e);
 }
 for(const [id,e] of rawByActivity){if(!fillsByActivity.has(id)||!orders.has(e.payload.activity.order_id))fail('raw fill lacks a supported linked ledger fill');}
 for(const e of events.filter(e=>e.kind==='order_closed')){
  const p=e.payload,intent=intents.get(p.intent_id);if(!intent||closed.has(p.intent_id))fail('unknown or duplicate terminal receipt');
  if(!TERMINAL.has(p.status)||!p.order||p.status!==p.order.status||p.order_id!==intent.brokerId||p.client_order_id!==intent.event.payload.client_order_id)fail('invalid terminal identity');
  // A closure cannot replace the actual broker receipt it was reconciled against.
  const brokerReceipt=events.some(r=>r.kind==='broker_order'&&r.payload.intent_id===p.intent_id&&r.seq<e.seq&&canonical(r.payload.order)===canonical(p.order));
  if(!brokerReceipt)fail('terminal receipt lacks matching broker evidence');
  bindOrder(p.intent_id,p.order,e.seq);
  if(shares(p.filled_qty,'terminal filled quantity',{zero:true})!==intent.filled||shares(p.accounted_quantity,'terminal accounted quantity',{zero:true})!==intent.filled||shares(p.order.filled_qty,'terminal order quantity',{zero:true})!==intent.filled)fail('terminal quantities do not match actual fills');
  if(p.status==='filled'&&intent.filled!==intent.quantity)fail('filled order is incomplete');
  if(intent.latest.reported!==intent.filled||intent.latest.order.status!==p.status)fail('terminal evidence conflicts with latest order observation');
  closed.set(p.intent_id,e);
 }
 for(const [id,intent] of intents){
  if(intent.latest&&intent.latest.reported!==intent.filled)fail('reported fills are not fully accounted');
  if(intent.order.side==='buy'&&!closed.has(id))reserved+=(intent.quantity-intent.filled)*intent.reservePrice;
 }
 return {spent,reserved,total:spent+reserved};
}
