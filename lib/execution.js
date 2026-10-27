import {assertRolloutEnabled,rolloutPrerequisites,rolloutOrderLimits} from './rollout-policy.js';
import {usdNanos,USD_NANOS_PER_CENT} from './precision.js';
import {assertValidationEnabled,validationEvidence,validationPrerequisites,validationOrderLimits} from './validation-policy.js';
import {getEvent,AppError,acquire,release,renew,appendLeased,hash} from './store.js';
import {alpaca,observe,PAPER,assertEligibleAsset} from './alpaca.js';
import {validateOrder,moneyToCents,brokerCashMatches,brokerBasisMatches,orderRiskAmounts} from './finance.js';
import {executionPrerequisites} from './readiness.js';
// General activation and execution remain hard-disabled; validation uses a separate bounded gate.
export const OPERATING_WORKFLOW_VERIFIED=false;
export async function executeDecision(db,env,decisionId,actor,fetcher=fetch){
 if(!OPERATING_WORKFLOW_VERIFIED||env.TRADING_ENABLED!=='true')throw new AppError('Official experiment paused: operating workflow and benchmark reconciliation are not verified. No order sent.',423);
 return executeVerifiedDecision(db,env,decisionId,actor,fetcher);
}
export async function executeValidationDecision(db,env,decisionId,actor,fetcher=fetch){
 assertValidationEnabled(env);return executeVerifiedDecision(db,env,decisionId,actor,fetcher,true);
}
export async function executeRolloutDecision(db,env,decisionId,actor,fetcher=fetch){
 assertRolloutEnabled(env);return executeVerifiedDecision(db,env,decisionId,actor,fetcher,false,true);
}
// Private engine; tests exercise it only with an isolated source harness and synthetic fetchers.
async function executeVerifiedDecision(db,env,decisionId,actor,fetcher=fetch,validationMode=false,rolloutMode=false){
 const prerequisitesFor=rolloutMode?rolloutPrerequisites:validationMode?validationPrerequisites:executionPrerequisites;
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 let beforePost;
 const request=async (...args)=>{await renew(db,'execution',token);if(args[1]?.method==='POST'){if(!beforePost)throw new AppError('Missing final submission guard.',423);await beforePost();}const response=await fetcher(...args);await renew(db,'execution',token);return response;};
 const persist=(record,head=null)=>appendLeased(db,record,'execution',token,new Date().toISOString(),head);
 try {
  const decisionHash=(await hash(decisionId)).slice(0,40);
  const client_order_id='blue-'+decisionHash;const intentId='order-intent:'+decisionHash;
  // Recheck under the lock. An uncertain prior intent is never submitted again.
  const existing=await getEvent(db,intentId);
  if(existing){
   if(rolloutMode&&!existing.payload.rollout_approval_id)throw new AppError('Existing intent is outside the opening rollout.',423);
   if(validationMode&&!existing.payload.validation_protocol_id)throw new AppError('Existing intent is outside the validation protocol.',423);
   const order=await alpaca(env,'/v2/orders:by_client_order_id?client_order_id='+client_order_id,{fetcher:request});
   const intended=existing.payload.order;
   if(order.client_order_id!==client_order_id||order.symbol!==intended.symbol||order.side!==intended.side||String(order.qty)!==intended.qty)throw new AppError('Prior intent broker identity differs; manual reconciliation required.',409);
   return await persist({id:'order-observed:'+(await hash(order)).slice(0,48),kind:'order_observed',payload:{intent_id:intentId,...sanitizeOrder(order)},actor});
  }
  const unresolved=await db.prepare("SELECT id FROM events WHERE kind='order_intent' AND id NOT IN (SELECT json_extract(payload,'$.intent_id') FROM events WHERE kind='order_closed') LIMIT 1").first();
  if(unresolved)throw new AppError('An earlier order is unresolved; reconcile before trading.',409);
  let prerequisites=await prerequisitesFor(db,decisionId,new Date().toISOString(),env.RELEASE_REVISION);
  const p=await observe(env,request,(prerequisites.configuration_version===undefined?1:prerequisites.configuration_version));
  prerequisites=await prerequisitesFor(db,decisionId,new Date().toISOString(),env.RELEASE_REVISION);
  let {decision,ledger}=prerequisites;const d=decision.payload;
  assertBrokerAgreement(ledger.portfolio,p);
  const asset=await alpaca(env,'/v2/assets/'+encodeURIComponent(d.symbol),{fetcher:request});
  assertEligibleAsset(asset,d.symbol,(prerequisites.configuration_version===undefined?1:prerequisites.configuration_version));
  prerequisites=await prerequisitesFor(db,decisionId,new Date().toISOString(),env.RELEASE_REVISION);
  ledger=prerequisites.ledger;assertBrokerAgreement(ledger.portfolio,p);
  // Preserve exact observed marks for risk; the manager supplies an explicit cent limit.
  const prices=Object.fromEntries(Object.entries(p.quotes).map(([symbol,q])=>[symbol,{price_nanos:usdNanos(q.price_text??String(q.price)).toString(),market_time:q.market_data_at}]));
  const sizeCents=moneyToCents(d.size);
  const perShare=orderRiskAmounts({symbol:d.symbol,quantity:1,limit_price_cents:d.limit_price_cents},{portfolio:ledger.portfolio,prices}).R;
  const quantity=validationMode?1:Number(BigInt(sizeCents)*USD_NANOS_PER_CENT/perShare);if(!Number.isSafeInteger(quantity)||quantity<1)throw new AppError('Order size is below one whole share or unsafe.');
  const order={symbol:d.symbol,side:d.action,quantity,limit_price_cents:d.limit_price_cents};
  const context={configuration_version:(prerequisites.configuration_version===undefined?1:prerequisites.configuration_version),runtime_verified:true,experiment_status:(validationMode||rolloutMode)?'active':prerequisites.control.payload.status,paper_endpoint:PAPER,clock:p.clock,portfolio:ledger.portfolio,modeled_income_nanos:ledger.portfolio.accounting_policy==='usd-nano-v1'?(BigInt(ledger.economic?.active.receivable_nanos||'0')+BigInt(ledger.economic?.active.distribution_cash_nanos||'0')).toString():((BigInt(ledger.economic?.active.receivable_cents||0)+BigInt(ledger.economic?.active.distribution_cash_cents||0))*USD_NANOS_PER_CENT).toString(),prices,open_orders:p.open_orders};
  // The separate validation prerequisite proves its bounded validation_pending control.
  if(validationMode)validationOrderLimits(order,context,decision,prerequisites.protocol);
  if(rolloutMode)rolloutOrderLimits(order,context,prerequisites.approval,prerequisites.budget);
  const check=validateOrder(order,{...context,now:new Date().toISOString()});
  if(!check.ok)throw new AppError('Order blocked: '+check.errors.join('; '),423);
  const payload={symbol:order.symbol,qty:String(quantity),side:order.side,type:'limit',time_in_force:'day',limit_price:(order.limit_price_cents/100).toFixed(2),extended_hours:false,client_order_id};
  await renew(db,'execution',token);
  const intent=await persist({id:intentId,kind:'order_intent',payload:{...(prerequisites.configuration_version>1?{configuration_version:prerequisites.configuration_version,configuration_hash:prerequisites.configuration_hash,amendment_id:prerequisites.amendment_id}:{}),...(rolloutMode?{rollout_approval_id:prerequisites.approval.id,submission_valid_until:new Date(Math.min(Date.parse(prerequisites.approval.payload.valid_until),Date.parse(d.valid_until),Date.parse(p.clock.next_close))).toISOString(),rollout_limits:prerequisites.approval.payload.limits}:{}),...(validationMode?{validation_protocol_id:prerequisites.protocol.id,submission_valid_until:new Date(Math.min(Date.parse(prerequisites.protocol.payload.valid_until),Date.parse(d.valid_until),Date.parse(p.clock.next_close))).toISOString(),validation_limits:prerequisites.protocol.payload.limits}:{}),decision_id:decisionId,client_order_id,order:payload,snapshot:p,asset,reconciliation_id:prerequisites.reconciliation.id},actor},prerequisites.journal_seq);
  const head=await db.prepare('SELECT MAX(seq) AS seq FROM events').first();
  if(head.seq!==intent.seq)throw new AppError('Journal changed after intent; reconcile before submission.',409);
  beforePost=async()=>{
   if(validationMode)await validationEvidence(db,env.RELEASE_REVISION,new Date().toISOString());
   const finalHead=await db.prepare('SELECT MAX(seq) AS seq FROM events').first();
   if(finalHead.seq!==intent.seq)throw new AppError('Journal changed before submission; reconcile intent.',409);
   // Re-fence lease ownership and the journal atomically after asynchronous evidence reads.
   await renew(db,'execution',token,new Date().toISOString(),intent.seq);
   if(validationMode)validationOrderLimits(order,context,decision,prerequisites.protocol);
   if(rolloutMode)rolloutOrderLimits(order,context,prerequisites.approval,prerequisites.budget);
   const finalCheck=validateOrder(order,{...context,now:new Date().toISOString()});
   if(!finalCheck.ok||Date.parse(d.valid_until)<=Date.now())throw new AppError('Decision or market evidence expired before submission; reconcile intent.',423);
  };
  // If this POST times out or the lease is lost, the durable intent remains unresolved.
  const result=await alpaca(env,'/v2/orders',{method:'POST',body:payload,fetcher:request});
  if(result.client_order_id!==client_order_id||result.symbol!==payload.symbol||result.side!==payload.side)throw new AppError('Broker acknowledgement identity differs; reconcile durable intent.',409);
  return await persist({id:'order-submitted:'+decisionHash,kind:'order_submitted',payload:{intent_id:intentId,...sanitizeOrder(result)},actor});
 } finally {await release(db,'execution',token);}
}
function assertBrokerAgreement(portfolio,snapshot){
 if(!brokerCashMatches(portfolio,snapshot.account.cash_text??snapshot.account.cash))throw new AppError('Broker cash differs from the official ledger.',423);
 const entries=Object.entries(portfolio.holdings);
 if(entries.length!==snapshot.positions.length)throw new AppError('Broker positions differ from the official ledger.',423);
 const seen=new Set();
 for(const p of snapshot.positions){const h=portfolio.holdings[p.symbol];if(seen.has(p.symbol)||!h||!Number.isSafeInteger(p.quantity)||p.quantity!==h.quantity||!brokerBasisMatches(h,p.cost_basis_text??p.cost_basis))throw new AppError('Broker position quantity or cost basis differs from the official ledger.',423);seen.add(p.symbol);}
}
function sanitizeOrder(o){return {id:o.id,client_order_id:o.client_order_id,symbol:o.symbol,side:o.side,qty:o.qty,filled_qty:o.filled_qty,filled_avg_price:o.filled_avg_price,status:o.status,created_at:o.created_at,submitted_at:o.submitted_at,filled_at:o.filled_at};}

export {assertEligibleAsset} from './alpaca.js';
