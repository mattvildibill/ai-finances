import {usdNanos,USD_NANOS_PER_CENT} from './precision.js';
import {AppError,latest,getEvent,canonical,hash,isoNow,acquire,renew,release,appendLeased} from './store.js';
import {executionDecision,fresh} from './readiness.js';
import {readLedger,createOpeningPayload} from './reconciliation.js';
import {coverageState} from './action-settlement.js';
import {moneyToCents,orderRiskAmounts,initialPortfolio} from './finance.js';
export const VALIDATION_AUTHORIZATION='Sentinel_6fb8b1bcb8708191969bb46e2ae4dfa5';
export const VALIDATION_LIMITS=Object.freeze({symbol:'SPY',side:'buy',quantity:1,max_notional_cents:100000,max_nav_basis_points:100,max_intents:1,time_in_force:'day',extended_hours:false});
export const VALIDATION_CHECKS=['private_hosting','persistent_readback','unattended_auth','corporate_action_reconciliation','runtime_asset_metadata','independent_code_review','isolated_accounting_safeguards','primary_action_scan'];
export const VALIDATION_PENDING=['actual_nonzero_fill_settlement','actual_partial_fill_if_observed','actual_ambiguous_submission_if_observed'];
const block=message=>{throw new AppError(message,423);};
export function assertValidationEnabled(env){if(env.VALIDATION_ENABLED!=='true')block('Limited validation is disabled. No inception or order permitted.');}
function validRevision(revision){if(typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))block('Exact reviewed validation release revision required.');}
function validateProtocolShape(p,revision,now){
 validRevision(revision);
 if(!p||p.revision!==revision||p.status!=='approved'||p.mandate_version!==1||p.protocol_version!==1||p.authorization_reference!==VALIDATION_AUTHORIZATION||p.general_trading_enabled!==false||canonical(p.limits)!==canonical(VALIDATION_LIMITS)||canonical(p.pending_evidence)!==canonical(VALIDATION_PENDING))block('Exact authorized one-share validation protocol required.');
 if(typeof p.decision_id!=='string'||!p.decision_id||typeof p.valid_until!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(p.valid_until)||!Number.isFinite(Date.parse(p.valid_until))||Date.parse(p.valid_until)<=Date.parse(now)||Date.parse(p.valid_until)>Date.parse(now)+86400000)block('Validation protocol requires a decision and future expiry within 24 hours.');
}
/** Pinned approvals cannot conceal a later failed, pending or malformed result. */
async function validateChecks(db,checks,revision,approvalSeq=Infinity){
 for(const check of VALIDATION_CHECKS){
  const id=checks?.[check],e=typeof id==='string'?await getEvent(db,id):null;
  if(e?.kind!=='verification'||e.seq>=approvalSeq||e.payload.check!==check||e.payload.revision!==revision||e.payload.outcome!=='passed'||typeof e.payload.summary!=='string'||!e.payload.summary.trim())block('Missing actual prevalidation evidence: '+check);
  const invalidation=await db.prepare("SELECT id FROM events WHERE kind='verification' AND seq>? AND json_extract(payload,'$.check')=? AND json_extract(payload,'$.revision')=? AND COALESCE(json_extract(payload,'$.outcome'),'')!='passed' LIMIT 1").bind(e.seq,check,revision).first();
  if(invalidation)block('Validation evidence was superseded by a non-passed result: '+check);
 }
}
export async function validationEvidence(db,revision,now=isoNow()){
 const protocol=await latest(db,'validation_protocol',now);validateProtocolShape(protocol?.payload,revision,now);
 if(Date.parse(protocol.created_at)>Date.parse(now))block('Validation protocol is future-dated.');
 const approval=await latest(db,'validation_release',now);
 if(!approval||approval.payload.status!=='approved'||approval.payload.revision!==revision||approval.payload.protocol_id!==protocol.id||approval.seq<=protocol.seq)block('Missing exact-revision validation release approval.');
 await validateChecks(db,approval.payload.checks,revision,approval.seq);
 return {protocol,approval};
}
export async function stageValidation(db,env,{idempotency_key,kind,payload},actor){
 if(!['validation_protocol','validation_release'].includes(kind)||!payload||typeof payload!=='object'||JSON.stringify(payload).length>50000)throw new AppError('Invalid validation metadata.');
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.digest!==await hash({kind,payload}))throw new AppError('Idempotency key already used for different content.',409);return existing;}
  if(await latest(db,'experiment_opened')||await db.prepare("SELECT id FROM events WHERE kind='order_intent' LIMIT 1").first())block('Validation metadata cannot be replaced after official inception or intent.');
  const now=isoNow();
  const head=await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();
  if(kind==='validation_protocol'){
   if(await latest(db,kind))block('The single validation protocol is already staged; no replacement authorization is inferred.');
   validateProtocolShape(payload,env.RELEASE_REVISION,now);
   const decision=await executionDecision(db,payload.decision_id,now);
   if(decision.payload.symbol!=='SPY'||decision.payload.action!=='buy'||moneyToCents(decision.payload.size)>100000||decision.payload.limit_price_cents>100000||Date.parse(payload.valid_until)>Date.parse(decision.payload.valid_until))block('Protocol must bind a capped SPY buy and may not outlive its decision.');
  }else{
   validRevision(env.RELEASE_REVISION);const protocol=await latest(db,'validation_protocol');validateProtocolShape(protocol?.payload,env.RELEASE_REVISION,now);
   if(payload.protocol_id!==protocol.id||payload.revision!==env.RELEASE_REVISION||payload.status!=='approved')block('Validation release must bind its protocol and exact revision.');
   await validateChecks(db,payload.checks,env.RELEASE_REVISION);
  }
  await renew(db,'execution',token);return await appendLeased(db,{id:idempotency_key,kind,payload,actor},'execution',token,isoNow(),head.seq);
 }finally{await release(db,'execution',token);}
}
export async function validationOpeningPreflight(db,snapshotId,now,revision){
 const evidence=await validationEvidence(db,revision,now);const decision=await executionDecision(db,evidence.protocol.payload.decision_id,now);
 if(decision.payload.symbol!=='SPY'||decision.payload.action!=='buy')block('Only the authorized SPY decision is permitted.');
 if(await latest(db,'experiment_opened'))block('Official inception already exists.');
 if(await db.prepare("SELECT id FROM events WHERE kind='order_intent' LIMIT 1").first())block('No pre-inception order intent permitted.');
 const snapshot=await getEvent(db,snapshotId);const opening=createOpeningPayload(snapshot,now,'usd-nano-v1');
 validationOrderLimits({symbol:'SPY',side:'buy',quantity:1,limit_price_cents:decision.payload.limit_price_cents},{portfolio:initialPortfolio(),prices:{SPY:{price_nanos:usdNanos(snapshot.payload.quotes.SPY.price_text??String(snapshot.payload.quotes.SPY.price)).toString()}}},decision,evidence.protocol,now);
 const recon=await latest(db,'reconciliation');
 if(!recon||!fresh(recon.created_at,now)||recon.seq<=snapshot.seq||recon.payload.ledger_status!=='not_started'||!Array.isArray(recon.payload.problems)||recon.payload.problems.some(p=>p.code!=='not_started'))block('Fresh flat-account reconciliation after snapshot required.');
 const coverage=await coverageState(db,now);if(!coverage.ok)block(coverage.problems.join('; '));
 return {...evidence,decision,opening,reconciliation:recon};
}
export async function validationPrerequisites(db,decisionId,now,revision){
 const head=await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();
 const evidence=await validationEvidence(db,revision,now);
 if(decisionId!==evidence.protocol.payload.decision_id)block('Validation is bound to one specific decision.');
 const decision=await executionDecision(db,decisionId,now);
 if(decision.payload.symbol!=='SPY'||decision.payload.action!=='buy'||moneyToCents(decision.payload.size)>100000)block('Only the capped SPY validation buy is permitted.');
 const opening=await latest(db,'experiment_opened');const ledger=await readLedger(db,now);const control=opening?.payload.control;
 if(ledger.status!=='ready'||!ledger.portfolio||!ledger.benchmark||control?.status!=='validation_pending'||control.started_at!==ledger.started_at||control.validation_protocol_id!==evidence.protocol.id||control.verification_id!==evidence.approval.id||control.release_revision!==revision||opening.seq<=Math.max(evidence.protocol.seq,evidence.approval.seq))block('Official simultaneous validation opening must bind this protocol and release.');
 if(await latest(db,'experiment_control'))block('A later control record requires explicit review; validation cannot override it.');
 if(await db.prepare("SELECT id FROM events WHERE kind='order_intent' LIMIT 1").first())block('The single validation order allowance has been consumed.');
 const coverage=await coverageState(db,now);if(!coverage.ok)block(coverage.problems.join('; '));
 const reconciliation=await latest(db,'reconciliation',now);
 if(!reconciliation||!fresh(reconciliation.created_at,now)||reconciliation.payload.status!=='reconciled'||reconciliation.payload.ledger_status!=='ready'||!Array.isArray(reconciliation.payload.problems)||reconciliation.payload.problems.length)block('Fresh successful validation reconciliation required.');
 const later=await db.prepare("SELECT id FROM events WHERE seq>? AND kind IN ('snapshot','ledger_fill','broker_activity','broker_order','order_intent','experiment_opened','corporate_action','corporate_action_page','corporate_action_fetch_failed','action_confirmed','action_entitlement','action_payment','action_split','action_source','action_coverage','refresh_failed') LIMIT 1").bind(reconciliation.seq).first();if(later)block('New accounting evidence requires reconciliation.');
 const after=await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();if(after.seq!==head.seq)block('Journal changed during validation checks.');
 return {...evidence,decision,ledger,reconciliation,control:{...opening,payload:control},journal_seq:head.seq};
}
export function validationOrderLimits(order,context,decision,protocol,now=isoNow()){
 if(order.symbol!=='SPY'||order.side!=='buy'||order.quantity!==1||Date.parse(protocol.payload.valid_until)<=Date.parse(now)||decision.id!==protocol.payload.decision_id)block('Validation order or protocol has expired or exceeds its scope.');
 const {V,R}=orderRiskAmounts(order,context);
 const size=BigInt(moneyToCents(decision.payload.size))*USD_NANOS_PER_CENT;
 if(R>100000n*USD_NANOS_PER_CENT||R*10000n>V*100n||size<R||size>100000n*USD_NANOS_PER_CENT)block('One-share commitment exceeds $1,000, 1% of fresh NAV, or the manager size.');
}
export async function validationStatus(db,env){
 const protocol=await latest(db,'validation_protocol');const opening=await latest(db,'experiment_opened');const intent=await db.prepare("SELECT id FROM events WHERE kind='order_intent' AND json_extract(payload,'$.validation_protocol_id') IS NOT NULL LIMIT 1").first();
 return {phase:!protocol?'not_staged':!opening?'awaiting_inception':intent?'allowance_consumed_review_required':'validation_pending',enabled:env.VALIDATION_ENABLED==='true',general_trading_enabled:false,protocol_id:protocol?.id??null,intent_id:intent?.id??null,unused_order_capacity:protocol&&!intent?1:0,remaining_order_allowance:protocol&&!intent&&env.VALIDATION_ENABLED==='true'&&Date.parse(protocol.payload.valid_until)>Date.now()?1:0,pending_evidence:VALIDATION_PENDING,limits:VALIDATION_LIMITS};
}
