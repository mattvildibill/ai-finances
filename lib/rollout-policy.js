import {policyVersionAt} from './investment-policy.js';
import {admissionAuthorization} from './universe-admission.js';
import {AppError,parseRow,canonical,hash,isoNow,acquire,release,renew,appendLeased,getEvent} from './store.js';
import {executionDecision,fresh} from './readiness.js';
import {readLedger} from './reconciliation.js';
import {coverageState} from './action-settlement.js';
import {marketDate} from './action-ledger.js';
import {VALIDATION_CHECKS,VALIDATION_LIMITS} from './validation-policy.js';
import {orderRiskAmounts,sessionBoundaryErrors} from './finance.js';
import {rolloutBudget} from './rollout-budget.js';
export const ROLLOUT_AUTHORIZATION='Sentinel_fcfb4545f0d08191aff52c9996d911dd';
export const ROLLOUT_LIMITS=Object.freeze({cumulative_purchase_cap_cents:1000000,minimum_uncommitted_cash_cents:9000000,include_pilot:true,recycle_sales:false,buy_only:true});
const block=message=>{throw new AppError(message,423);};
const last=(events,kind)=>events.filter(e=>e.kind===kind).at(-1);
const find=(events,id,kind)=>events.find(e=>e.id===id&&(!kind||e.kind===kind));
export function assertRolloutEnabled(env){if(env.ROLLOUT_ENABLED!=='true')block('Opening rollout disabled; no additional order permitted.');}
export async function rolloutEvents(db,now=isoNow()){
 const rows=await db.prepare('SELECT * FROM events WHERE created_at<=? ORDER BY seq LIMIT 10001').bind(now).all();
 if(rows.results.length>10000)block('Complete rollout history exceeds processing bound.');
 return rows.results.map(parseRow);
}
/** Durable actual-outcome evidence; historical proof does not expire with the old pilot decision. */
export function pilotOutcomeBinding(events,{pilot_intent_id,reconciliation_id}){
 const recon=find(events,reconciliation_id,'reconciliation');
 if(!recon||recon.payload.status!=='reconciled'||recon.payload.ledger_status!=='ready'||recon.payload.problems?.length!==0)block('Actual successful pilot reconciliation required.');
 const proof=events.filter(e=>e.seq<=recon.seq);
 const openings=proof.filter(e=>e.kind==='experiment_opened');const intents=proof.filter(e=>e.kind==='order_intent');
 const opening=openings[0],intent=find(proof,pilot_intent_id,'order_intent');
 if(openings.length!==1||intents.length!==1||!intent||intent!==intents[0]||opening?.payload.accounting_policy!=='usd-nano-v1'||opening.payload.control?.status!=='validation_pending')block('Proof must contain only the original official opening and single pilot intent.');
 const protocol=find(proof,intent.payload.validation_protocol_id,'validation_protocol');
 const approval=find(proof,opening.payload.control.verification_id,'validation_release');
 if(!protocol||!approval||protocol.id!==opening.payload.control.validation_protocol_id||approval.payload.protocol_id!==protocol.id||intent.payload.decision_id!==protocol.payload.decision_id||protocol.payload.revision!==opening.payload.control.release_revision||approval.payload.revision!==protocol.payload.revision||canonical(protocol.payload.limits)!==canonical(VALIDATION_LIMITS))block('Pilot provenance does not match its original validation authorization.');
 const order=intent.payload.order;
 const closed=proof.filter(e=>e.kind==='order_closed'&&e.payload.intent_id===intent.id);
 if(order?.symbol!=='SPY'||order.side!=='buy'||order.qty!=='1'||closed.length!==1||closed[0].payload.status!=='filled'||Number(closed[0].payload.filled_qty)!==1||Number(closed[0].payload.accounted_quantity)!==1)block('Pilot must have an actual fully filled and closed one-share SPY order.');
 const fills=proof.filter(e=>e.kind==='ledger_fill'&&e.payload.intent_id===intent.id);
 if(!fills.length||fills.reduce((sum,e)=>sum+e.payload.fill.quantity,0)!==1||fills.some(e=>e.payload.fill.symbol!=='SPY'||e.payload.fill.side!=='buy'))block('Actual uniquely accounted one-share pilot fills required.');
 const raws=fills.map(e=>find(proof,e.payload.raw_event_id,'broker_activity'));
 if(raws.some((r,i)=>!r||r.payload.broker_activity_id!==fills[i].payload.broker_activity_id))block('Pilot fills lack their actual raw receipts.');
 const broker=proof.filter(e=>e.kind==='broker_order'&&e.payload.intent_id===intent.id).at(-1);
 if(!broker||canonical(broker.payload.order)!==canonical(closed[0].payload.order))block('Pilot closure lacks its matching broker order receipt.');
 rolloutBudget(proof); // Cross-check raw, fill, order quantities and original commitments.
 const refs=[opening,protocol,approval,intent,broker,...raws,...fills,closed[0],recon].sort((a,b)=>a.seq-b.seq).map(e=>({id:e.id,kind:e.kind,digest:e.digest}));
 return {opening_id:opening.id,pilot_intent_id:intent.id,reconciliation_id:recon.id,records:refs};
}
export async function rolloutReviewCandidate(db,input){const binding=pilotOutcomeBinding(await rolloutEvents(db),input);return {binding:canonical(binding),binding_sha256:await hash(binding),scope:'Actual historical pilot evidence only; separate release approval and fresh execution checks required.'};}
function approvalEvidence(events,p,revision,now,approvalSeq=Infinity){
 if(typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||!p||p.revision!==revision||p.status!=='approved'||p.protocol_version!==1||p.mandate_version!==policyVersionAt(events,now)||p.authorization_reference!==ROLLOUT_AUTHORIZATION||p.general_trading_enabled!==false||canonical(p.limits)!==canonical(ROLLOUT_LIMITS)||typeof p.author!=='string'||!p.author.trim())block('Exact reviewed opening-rollout authorization required.');
 if(p.session_date!==marketDate(now)||typeof p.valid_until!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(p.valid_until)||!Number.isFinite(Date.parse(p.valid_until))||Date.parse(p.valid_until)<=Date.parse(now)||marketDate(p.valid_until)!==p.session_date)block('Rollout approval expired or belongs to another New York session.');
 const binding=pilotOutcomeBinding(events,p);
 if(p.pilot_binding!==canonical(binding)||marketDate(find(events,binding.opening_id).payload.started_at)!==p.session_date)block('Rollout must bind the exact reviewed pilot outcome from this opening session.');
 if(!Array.isArray(p.review_ids)||p.review_ids.length!==2||new Set(p.review_ids).size!==2)block('Two independent actual pilot reviews required.');
 const authors=new Set([p.author]);
 for(const id of p.review_ids){const r=find(events,id,'verification');if(!r||r.seq>=approvalSeq||r.seq<=find(events,p.reconciliation_id).seq||r.payload.check!=='pilot_outcome_review'||r.payload.outcome!=='passed'||r.payload.revision!==revision||r.payload.pilot_binding!==p.pilot_binding||typeof r.payload.author!=='string'||!r.payload.author.trim()||authors.has(r.payload.author)||!r.payload.summary?.trim())block('Independent reviewer did not approve this actual pilot outcome.');authors.add(r.payload.author);}
 if(events.some(e=>e.kind==='verification'&&e.payload.check==='pilot_outcome_review'&&e.payload.pilot_binding===p.pilot_binding&&e.payload.outcome!=='passed'))block('Pilot outcome has a failed or unresolved review.');
 for(const check of VALIDATION_CHECKS){const r=find(events,p.checks?.[check],'verification');if(!r||r.seq>=approvalSeq||r.payload.check!==check||r.payload.revision!==revision||r.payload.outcome!=='passed'||!r.payload.summary?.trim())block('Missing measured rollout release evidence: '+check);if(events.some(e=>e.kind==='verification'&&e.seq>r.seq&&e.payload.check===check&&e.payload.revision===revision&&e.payload.outcome!=='passed'))block('A later release check failed or remains unresolved: '+check);}
 const protectedIds=new Set([...binding.records.map(r=>r.id),...p.review_ids,...Object.values(p.checks),...events.filter(e=>e.kind==='rollout_approval').map(e=>e.id)]);
 if(events.some(e=>e.kind==='revision'&&protectedIds.has(e.payload.supersedes)))block('Rollout evidence or approval has been revised; explicit new review required.');
 if(events.some(e=>e.kind==='experiment_control'))block('A separate control record requires review; rollout cannot override it.');
 return binding;
}
async function currentAccounting(db,events,now){
 const reconciliation=last(events,'reconciliation');
 if(!reconciliation||!fresh(reconciliation.created_at,now)||reconciliation.payload.status!=='reconciled'||reconciliation.payload.ledger_status!=='ready'||reconciliation.payload.problems?.length!==0)block('Fresh successful post-fill reconciliation required.');
 const invalidating=['mandate_amendment','snapshot','ledger_fill','broker_activity','broker_order','order_intent','experiment_opened','corporate_action','corporate_action_page','corporate_action_fetch_failed','action_confirmed','action_entitlement','action_payment','action_split','action_source','action_coverage','refresh_failed'];
 if(events.some(e=>e.seq>reconciliation.seq&&invalidating.includes(e.kind)))block('New accounting evidence requires reconciliation.');
 const ledger=await readLedger(db,now);if(ledger.status!=='ready'||ledger.portfolio?.accounting_policy!=='usd-nano-v1')block('Ready exact official ledger required.');
 const coverage=await coverageState(db,now);if(!coverage.ok)block(coverage.problems.join('; '));
 return {ledger,reconciliation};
}
export async function stageRollout(db,env,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.digest!==await hash({kind:'rollout_approval',payload}))throw new AppError('Idempotency key already used for different content.',409);return existing;}
  if(!payload||JSON.stringify(payload).length>50000)block('Bounded rollout approval required.');
  const now=isoNow(),events=await rolloutEvents(db,now);
  const previous=last(events,'rollout_approval'),version=policyVersionAt(events,now);
  const admission=await admissionAuthorization(events,env.RELEASE_REVISION,now);
  if(version===2&&(payload.amendment_id!==admission.amendment_id||payload.configuration_hash!==admission.configuration_hash||(payload.release_attestation_id??null)!==(admission.release_attestation_id??null)))block('Rollout must bind current admission');
  if(previous){
   if(version!==2||!(previous.payload.mandate_version===1||(previous.payload.mandate_version===2&&previous.payload.revision!==payload.revision&&admission.release_attestation_id))||payload.previous_approval_id!==previous.id||payload.session_date!==previous.payload.session_date||Date.parse(payload.valid_until)>Date.parse(previous.payload.valid_until)||payload.pilot_binding!==previous.payload.pilot_binding)block('Single rollout already approved; only bounded admission or reviewed-release continuation is permitted, no reset');
  }else if(payload.previous_approval_id!==undefined)block('Unknown previous rollout approval');
  approvalEvidence(events,payload,env.RELEASE_REVISION,now);
  if(!previous&&events.filter(e=>e.kind==='order_intent').length!==1)block('No additional intent is permitted before graduation review.');
  await currentAccounting(db,events,now);
  const snapshot=last(events,'snapshot');const clock=snapshot?.payload.clock;
  if(!snapshot||!fresh(snapshot.created_at,now)||!fresh(clock?.timestamp,now)||clock?.is_open!==true||sessionBoundaryErrors(clock,Date.parse(now)).length||Date.parse(payload.valid_until)>Date.parse(clock.next_close))block('Approval requires a fresh open-session observation and expiry no later than its close.');
  await renew(db,'execution',token);
  return await appendLeased(db,{id:idempotency_key,kind:'rollout_approval',payload,actor},'execution',token,isoNow(),events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
export async function rolloutPrerequisites(db,decisionId,now,revision){
 const events=await rolloutEvents(db,now),approval=last(events,'rollout_approval');
 approvalEvidence(events,approval?.payload,revision,now,approval?.seq);
 const admission=await admissionAuthorization(events,revision,now);
 if(admission.configuration_version===2&&(approval.payload.amendment_id!==admission.amendment_id||approval.payload.configuration_hash!==admission.configuration_hash||(approval.payload.release_attestation_id??null)!==(admission.release_attestation_id??null)))block('Rollout admission binding differs');
 const {ledger,reconciliation}=await currentAccounting(db,events,now);
 const decision=await executionDecision(db,decisionId,now);
 if(decision.payload.action!=='buy'||decision.seq<=approval.seq)block('Rollout requires a newly authored buy decision after graduation approval.');
 const budget=rolloutBudget(events);
 const head=await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();if(head.seq!==events.at(-1)?.seq)block('Journal changed during rollout checks.');
 return {...admission,decision,ledger,reconciliation,approval,budget,journal_seq:head.seq};
}
export function rolloutOrderLimits(order,context,approval,budget,now=isoNow()){
 if(order.side!=='buy'||Date.parse(approval.payload.valid_until)<=Date.parse(now)||marketDate(now)!==approval.payload.session_date)block('Opening rollout permits only unexpired same-session purchases.');
 const {C,R}=orderRiskAmounts(order,context);
 if(budget.total+R>10000000000000n)block('Opening rollout exceeds $10,000 cumulative purchases plus commitments, including the pilot.');
 if(C-budget.reserved-R<90000000000000n)block('Opening rollout must retain $90,000 uncommitted broker cash.');
}
export async function rolloutStatus(db,env){
 const events=await rolloutEvents(db),approval=last(events,'rollout_approval');let budget=null,problem=null;
 try{const b=rolloutBudget(events);budget=Object.fromEntries(Object.entries(b).map(([k,v])=>[k,v.toString()]));}catch(error){problem=error.message;}
 return {enabled:env.ROLLOUT_ENABLED==='true',general_trading_enabled:false,approval_id:approval?.id??null,limits:ROLLOUT_LIMITS,budget_nanos:budget,problem,trading_permitted:false};
}
