import {CASH_ACTIVITY_KINDS} from './cash-activities.js';
import {AppError,hash,isoNow,getEvent,acquire,renew,release,appendLeased} from './store.js';
import {readCompleteHistory} from './history.js';
import {alpaca} from './alpaca.js';
import {reconcile,readLedger} from './reconciliation.js';
import {managedAuthorization,managedDecision,managedOrderCheck,managedMandate,managedAccountProblem,MANAGED_RULES,MANAGED_CHECKS} from './managed-policy.js';
import {managedInstrumentFor,assertManagedAsset,observeManaged} from './managed-instruments.js';
import {managedCoverage} from './managed-actions.js';
import {fresh} from './readiness.js';
const fail=m=>{throw new AppError(m,423);};
async function prerequisites(db,env,decisionId,now=isoNow()){
 if(env.MANAGED_ENABLED!=='true')fail('Managed execution is not enabled');
 const events=await readCompleteHistory(db,now),auth=managedAuthorization(events,env.RELEASE_REVISION,now),decision=managedDecision(events,decisionId,auth.mandate,now);
 const instrument=managedInstrumentFor(events,decision.payload.symbol,now);if(!instrument||instrument.payload.mandate_id!==auth.mandate.id)fail('Target instrument has no current verified approval');
 if(decision.payload.instrument_approval_id!==instrument.id)fail('Decision must bind the current instrument approval');
 const ledger=await readLedger(db,now);if(ledger.status!=='ready'||!ledger.portfolio||!ledger.benchmark||ledger.pending?.length)fail('Accounting or corporate-action settlement requires attention');
 const symbols=[...new Set([...Object.keys(ledger.portfolio.holdings),decision.payload.symbol,'SPY'])].sort();
 const coverage=managedCoverage(events,now,symbols);if(!coverage.ok)fail('Scoped action coverage: '+coverage.problems.join('; '));
 const recon=events.filter(e=>e.kind==='reconciliation').at(-1);if(!recon||!fresh(recon.created_at,now)||recon.payload.status!=='reconciled'||recon.payload.ledger_status!=='ready'||!Array.isArray(recon.payload.problems)||recon.payload.problems.length)fail('Current successful broker reconciliation required');
 if(events.some(e=>e.kind==='order_intent'&&!events.some(c=>c.kind==='order_closed'&&c.payload.intent_id===e.id)))fail('Unresolved order commitment; recovery must use its existing ID');
 if(events.some(e=>e.seq>recon.seq&&[...CASH_ACTIVITY_KINDS,'ledger_fill','broker_activity','broker_order','order_closure_conflict','refresh_failed'].includes(e.kind)))fail('New account/failure evidence requires reconciliation');
 const approved=Object.fromEntries(symbols.map(s=>[s,managedInstrumentFor(events,s,now)]));
 return {...auth,decision,instrument,ledger,reconciliation:recon,symbols,approved,head:events.at(-1)?.seq??0};
}
export async function executeManagedDecision(db,env,decisionId,actor,fetcher=fetch){
 const token=crypto.randomUUID();await acquire(db,'execution',token);let beforePost;
 const request=async(url,options)=>{await renew(db,'execution',token);if(options.method==='POST'){if(!beforePost)fail('Final submission guard missing');await beforePost();}const r=await fetcher(url,options);await renew(db,'execution',token);return r;};
 try{
 const digest=(await hash(decisionId)).slice(0,40),client_order_id='blue-'+digest,intentId='order-intent:'+digest;
 const old=await getEvent(db,intentId);
 // GET-only recovery remains possible when authorization expires, is paused, or release changes.
 if(old){if(!old.payload.managed_mandate_id)fail('Existing intent belongs to a different execution path');
  const order=await alpaca(env,'/v2/orders:by_client_order_id?client_order_id='+client_order_id,{fetcher:request});
  if(order.client_order_id!==client_order_id||order.symbol!==old.payload.order.symbol||order.side!==old.payload.order.side||String(order.qty)!==old.payload.order.qty)fail('Existing broker order identity differs; reconcile without resubmission');
  return await appendLeased(db,{id:'managed-observed:'+(await hash(order)).slice(0,48),kind:'broker_order',payload:{intent_id:intentId,order},actor},'execution',token);
 }
 if(env.MANAGED_ENABLED!=='true')fail('Managed execution is not enabled');
 // Real GET-only settlement observation, never fabricated sale proceeds or buying power.
 await reconcile(db,env,'managed-preflight:'+crypto.randomUUID(),actor,request,token);
 let pre=await prerequisites(db,env,decisionId);
 const snapshot=await observeManaged(env,pre.symbols,pre.approved,request);
 pre=await prerequisites(db,env,decisionId);const p=pre.decision.payload;
 assertManagedAsset(snapshot.asset_metadata[p.symbol],pre.instrument);
 const order={symbol:p.symbol,side:p.action,quantity:p.quantity,limit_price_cents:p.limit_price_cents};
 const context={portfolio:pre.ledger.portfolio,broker_basis:pre.ledger.broker_basis,snapshot,valid_until:p.valid_until,ends_at:pre.mandate.payload.ends_at,fee_reserve_cents:p.fee_reserve_cents??0};
 const check=()=>{if(Object.values(snapshot.asset_metadata).some(a=>!fresh(a.retrieved_at,isoNow())))fail('Fresh broker instrument metadata required');const result=managedOrderCheck(order,{...context,now:isoNow()});if(!result.ok)fail(result.errors.join('; '));};check();
 const payload={symbol:order.symbol,qty:String(order.quantity),side:order.side,type:'limit',time_in_force:'day',limit_price:(order.limit_price_cents/100).toFixed(2),extended_hours:false,client_order_id};
 const deadline=new Date(Math.min(Date.parse(p.valid_until),Date.parse(pre.mandate.payload.ends_at),Date.parse(snapshot.clock.next_close),Date.parse(snapshot.retrieved_at)+120000,Date.parse(snapshot.clock.timestamp)+120000,...Object.values(snapshot.asset_metadata).map(a=>Date.parse(a.retrieved_at)+120000),...Object.values(snapshot.quotes).map(q=>Date.parse(q.market_data_at)+120000))).toISOString();
 const intent=await appendLeased(db,{id:intentId,kind:'order_intent',actor,payload:{managed_mandate_id:pre.mandate.id,managed_release_id:pre.release.id,instrument_approval_id:pre.instrument.id,submission_valid_until:deadline,decision_id:decisionId,client_order_id,order:payload,snapshot,asset:snapshot.asset_metadata[p.symbol],reconciliation_id:pre.reconciliation.id,fee_reserve_cents:context.fee_reserve_cents}},'execution',token,isoNow(),pre.head);
 beforePost=async()=>{
  if(env.MANAGED_ENABLED!=='true')fail('Managed execution disabled before submission');
  const events=await readCompleteHistory(db);managedAuthorization(events,env.RELEASE_REVISION);managedDecision(events,decisionId,pre.mandate);assertManagedAsset(snapshot.asset_metadata[p.symbol],managedInstrumentFor(events,p.symbol));
  if(events.at(-1)?.seq!==intent.seq)fail('Journal changed before submission; recover existing intent');
  await renew(db,'execution',token,isoNow(),intent.seq);check();if(Date.now()>=Date.parse(deadline))fail('Final submission deadline expired');
 };
 const result=await alpaca(env,'/v2/orders',{method:'POST',body:payload,fetcher:request});
 if(result.client_order_id!==client_order_id||result.symbol!==payload.symbol||result.side!==payload.side||String(result.qty)!==payload.qty)fail('Broker acknowledgement differs; reconcile existing intent');
 return await appendLeased(db,{id:'order-submitted:'+digest,kind:'order_submitted',payload:{intent_id:intentId,...result},actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
export async function managedStatus(db,env){
 const events=await readCompleteHistory(db),mandate=managedMandate(events);let problem=null;
 try{managedAuthorization(events,env.RELEASE_REVISION);}catch(e){problem=e.message;}
 const ledger=await readLedger(db),snapshot=events.filter(e=>e.kind==='snapshot').at(-1)?.payload;const coverage=mandate&&ledger.portfolio?managedCoverage(events,isoNow(),[...new Set(['SPY',...Object.keys(ledger.portfolio.holdings)])].sort()):null;
 if(!problem)problem=managedAccountProblem(events);if(!problem&&ledger.status!=='ready')problem='Accounting needs attention';if(!problem&&coverage&&!coverage.ok)problem=coverage.problems.join('; ');
 return {accounting_status:ledger.status,coverage,market_observation:{is_open:snapshot?.clock?.is_open??null,observed_at:snapshot?.clock?.timestamp??null,fresh:fresh(snapshot?.clock?.timestamp)},mode:'managed-paper',enabled:env.MANAGED_ENABLED==='true',mandate_id:mandate?.id??null,started_at:mandate?.payload.started_at??null,ends_at:mandate?.payload.ends_at??null,rules:MANAGED_RULES,required_release_checks:MANAGED_CHECKS,problem,trading_permitted:false,scope:'Standing authority is not order permission. Each actual decision requires current cash, inventory, instrument, action coverage and regular-session observations.'};
}
