import {getEvent,append,latest,AppError,acquire,release,hash} from './store.js';
import {alpaca,observe,PAPER} from './alpaca.js';
import {validateOrder,moneyToCents} from './finance.js';
// This release intentionally has no activation endpoint. The gate can only be removed
// after benchmark/corporate-action and independent cloud-workflow verification.
export const OPERATING_WORKFLOW_VERIFIED=false;
export async function executeDecision(db,env,decisionId,actor,fetcher=fetch){
 if(!OPERATING_WORKFLOW_VERIFIED||env.TRADING_ENABLED!=='true')throw new AppError('Official experiment paused: operating workflow and benchmark reconciliation are not verified. No order sent.',423);
 return executeVerifiedDecision(db,env,decisionId,actor,fetcher);
}
// Internal engine, unreachable from production while the above gate is closed.
async function executeVerifiedDecision(db,env,decisionId,actor,fetcher=fetch){
 const decision=await getEvent(db,decisionId);
 if(decision?.kind!=='decision'||!['buy','sell'].includes(decision.payload.action))throw new AppError('Executable decision required.');
 const client_order_id='blue-'+(await hash(decisionId)).slice(0,40);
 const decisionHash=(await hash(decisionId)).slice(0,40);
 const intentId='order-intent:'+decisionHash;
 const existing=await getEvent(db,intentId);
 if(existing){
  // Ambiguous POSTs are reconciled by client ID, never resubmitted automatically.
  try {const order=await alpaca(env,'/v2/orders:by_client_order_id?client_order_id='+client_order_id,{fetcher});return append(db,{id:'order-observed:'+(await hash({id:order.id,status:order.status,filled_qty:order.filled_qty})).slice(0,48),kind:'order_observed',payload:sanitizeOrder(order),actor});}
  catch {throw new AppError('Prior order intent exists; broker confirmation unavailable. Manual reconciliation required; do not retry with a new decision.',409);}
 }
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try {
  const unresolved=await db.prepare("SELECT id FROM events WHERE kind='order_intent' AND id NOT IN (SELECT json_extract(payload,'$.intent_id') FROM events WHERE kind='order_closed') LIMIT 1").first();
  if(unresolved)throw new AppError('An earlier order is unresolved; reconcile before trading.',409);
  const p=await observe(env,fetcher);
  const d=decision.payload;const price=p.quotes[d.symbol]?.price;
  if(!price)throw new AppError('Missing fresh price.');
  const quantity=Math.floor(d.size/price);if(quantity<1)throw new AppError('Order size is below one whole share.');
  const limit_price_cents=moneyToCents(price.toFixed(2));
  const portfolio={cash_cents:moneyToCents(String(p.account.cash)),holdings:Object.fromEntries(p.positions.map(h=>[h.symbol,{quantity:h.quantity,cost_cents:moneyToCents(String(h.cost_basis))}])),realized_pnl_cents:0,events:[]};
  const order={symbol:d.symbol,side:d.action,quantity,limit_price_cents};
  const check=validateOrder(order,{runtime_verified:true,experiment_status:'active',paper_endpoint:PAPER,now:new Date().toISOString(),clock:p.clock,portfolio,prices:Object.fromEntries(Object.entries(p.quotes).map(([s,q])=>[s,{price_cents:moneyToCents(q.price.toFixed(2)),market_time:q.market_data_at}])),open_orders:p.open_orders});
  if(!check.ok)throw new AppError('Order blocked: '+check.errors.join('; '),423);
  const payload={symbol:order.symbol,qty:String(quantity),side:order.side,type:'limit',time_in_force:'day',limit_price:(limit_price_cents/100).toFixed(2),extended_hours:false,client_order_id};
  await append(db,{id:intentId,kind:'order_intent',payload:{decision_id:decisionId,client_order_id,order:payload,snapshot:p},actor});
  const result=await alpaca(env,'/v2/orders',{method:'POST',body:payload,fetcher});
  return append(db,{id:'order-submitted:'+decisionHash,kind:'order_submitted',payload:{intent_id:intentId,...sanitizeOrder(result)},actor});
 } finally {await release(db,'execution',token);}
}
function sanitizeOrder(o){return {id:o.id,client_order_id:o.client_order_id,symbol:o.symbol,side:o.side,qty:o.qty,filled_qty:o.filled_qty,filled_avg_price:o.filled_avg_price,status:o.status,created_at:o.created_at,submitted_at:o.submitted_at,filled_at:o.filled_at};}
