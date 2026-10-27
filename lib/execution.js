import {getEvent,AppError,acquire,release,renew,appendLeased,hash} from './store.js';
import {alpaca,observe,PAPER} from './alpaca.js';
import {validateOrder,moneyToCents} from './finance.js';
import {executionPrerequisites} from './readiness.js';
// No activation endpoint exists. This constant stays false in the reviewed preparation release.
export const OPERATING_WORKFLOW_VERIFIED=false;
export async function executeDecision(db,env,decisionId,actor,fetcher=fetch){
 if(!OPERATING_WORKFLOW_VERIFIED||env.TRADING_ENABLED!=='true')throw new AppError('Official experiment paused: operating workflow and benchmark reconciliation are not verified. No order sent.',423);
 return executeVerifiedDecision(db,env,decisionId,actor,fetcher);
}
// Private engine; tests exercise it only with an isolated source harness and synthetic fetchers.
async function executeVerifiedDecision(db,env,decisionId,actor,fetcher=fetch){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 const request=async (...args)=>{await renew(db,'execution',token);const response=await fetcher(...args);await renew(db,'execution',token);return response;};
 const persist=(record,head=null)=>appendLeased(db,record,'execution',token,new Date().toISOString(),head);
 try {
  const decisionHash=(await hash(decisionId)).slice(0,40);
  const client_order_id='blue-'+decisionHash;const intentId='order-intent:'+decisionHash;
  // Recheck under the lock. An uncertain prior intent is never submitted again.
  const existing=await getEvent(db,intentId);
  if(existing){
   const order=await alpaca(env,'/v2/orders:by_client_order_id?client_order_id='+client_order_id,{fetcher:request});
   const intended=existing.payload.order;
   if(order.client_order_id!==client_order_id||order.symbol!==intended.symbol||order.side!==intended.side||String(order.qty)!==intended.qty)throw new AppError('Prior intent broker identity differs; manual reconciliation required.',409);
   return await persist({id:'order-observed:'+(await hash(order)).slice(0,48),kind:'order_observed',payload:{intent_id:intentId,...sanitizeOrder(order)},actor});
  }
  const unresolved=await db.prepare("SELECT id FROM events WHERE kind='order_intent' AND id NOT IN (SELECT json_extract(payload,'$.intent_id') FROM events WHERE kind='order_closed') LIMIT 1").first();
  if(unresolved)throw new AppError('An earlier order is unresolved; reconcile before trading.',409);
  let prerequisites=await executionPrerequisites(db,decisionId,new Date().toISOString(),env.RELEASE_REVISION);
  const p=await observe(env,request);
  prerequisites=await executionPrerequisites(db,decisionId,new Date().toISOString(),env.RELEASE_REVISION);
  let {decision,ledger}=prerequisites;const d=decision.payload;
  assertBrokerAgreement(ledger.portfolio,p);
  const asset=await alpaca(env,'/v2/assets/'+encodeURIComponent(d.symbol),{fetcher:request});
  if(asset.symbol!==d.symbol||asset.status!=='active'||asset.tradable!==true||asset.class!=='us_equity'||!['NYSE','NASDAQ','ARCA','AMEX','BATS','NYSEAMERICAN'].includes(asset.exchange))throw new AppError('Asset is not a verified active tradable US equity/ETF on an approved exchange.',423);
  prerequisites=await executionPrerequisites(db,decisionId,new Date().toISOString(),env.RELEASE_REVISION);
  ledger=prerequisites.ledger;assertBrokerAgreement(ledger.portfolio,p);
  // Do not round observed quotes or infer the manager's limit from a last trade.
  const prices=Object.fromEntries(Object.entries(p.quotes).map(([s,q])=>[s,{price_cents:moneyToCents(String(q.price)),market_time:q.market_data_at}]));
  const sizeCents=moneyToCents(d.size);
  const sizingPrice=Math.max(d.limit_price_cents,prices[d.symbol]?.price_cents||0);
  const quantity=Math.floor(sizeCents/sizingPrice);if(quantity<1)throw new AppError('Order size is below one whole share.');
  const order={symbol:d.symbol,side:d.action,quantity,limit_price_cents:d.limit_price_cents};
  const context={runtime_verified:true,experiment_status:prerequisites.control.payload.status,paper_endpoint:PAPER,clock:p.clock,portfolio:ledger.portfolio,prices,open_orders:p.open_orders};
  const check=validateOrder(order,{...context,now:new Date().toISOString()});
  if(!check.ok)throw new AppError('Order blocked: '+check.errors.join('; '),423);
  const payload={symbol:order.symbol,qty:String(quantity),side:order.side,type:'limit',time_in_force:'day',limit_price:(order.limit_price_cents/100).toFixed(2),extended_hours:false,client_order_id};
  await renew(db,'execution',token);
  const intent=await persist({id:intentId,kind:'order_intent',payload:{decision_id:decisionId,client_order_id,order:payload,snapshot:p,asset,reconciliation_id:prerequisites.reconciliation.id},actor},prerequisites.journal_seq);
  const head=await db.prepare('SELECT MAX(seq) AS seq FROM events').first();
  if(head.seq!==intent.seq)throw new AppError('Journal changed after intent; reconcile before submission.',409);
  const finalCheck=validateOrder(order,{...context,now:new Date().toISOString()});
  if(!finalCheck.ok||Date.parse(d.valid_until)<=Date.now())throw new AppError('Decision or market evidence expired before submission; reconcile intent.',423);
  // If this POST times out or the lease is lost, the durable intent remains unresolved.
  const result=await alpaca(env,'/v2/orders',{method:'POST',body:payload,fetcher:request});
  if(result.client_order_id!==client_order_id||result.symbol!==payload.symbol||result.side!==payload.side)throw new AppError('Broker acknowledgement identity differs; reconcile durable intent.',409);
  return await persist({id:'order-submitted:'+decisionHash,kind:'order_submitted',payload:{intent_id:intentId,...sanitizeOrder(result)},actor});
 } finally {await release(db,'execution',token);}
}
function assertBrokerAgreement(portfolio,snapshot){
 if(moneyToCents(String(snapshot.account.cash))!==portfolio.cash_cents)throw new AppError('Broker cash differs from the official ledger.',423);
 const entries=Object.entries(portfolio.holdings);
 if(entries.length!==snapshot.positions.length)throw new AppError('Broker positions differ from the official ledger.',423);
 const seen=new Set();
 for(const p of snapshot.positions){const h=portfolio.holdings[p.symbol];if(seen.has(p.symbol)||!h||!Number.isSafeInteger(p.quantity)||p.quantity!==h.quantity||moneyToCents(String(p.cost_basis))!==h.cost_cents)throw new AppError('Broker position quantity or cost basis differs from the official ledger.',423);seen.add(p.symbol);}
}
function sanitizeOrder(o){return {id:o.id,client_order_id:o.client_order_id,symbol:o.symbol,side:o.side,qty:o.qty,filled_qty:o.filled_qty,filled_avg_price:o.filled_avg_price,status:o.status,created_at:o.created_at,submitted_at:o.submitted_at,filled_at:o.filled_at};}
