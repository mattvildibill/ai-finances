import {readCompleteHistory} from './history.js';
import {activePolicyVersion,policyForVersion,policyCanonical,policyDigest,CONFIGURATION_VERSIONS} from './investment-policy.js';
import { approvedPrimaryActionSource } from './issuer-source-policy.js';
import { ACTION_KINDS, actionApproval, actionCoverage } from './action-ledger.js';
import { getEvent,hash,canonical,acquire,renew,release,appendLeased,AppError,isoNow } from './store.js';
import { readLedger } from './reconciliation.js';
export async function actionEvents(db,asOf=isoNow()){
 const kinds=[...ACTION_KINDS,'experiment_opened','mandate_amendment'];
 return readCompleteHistory(db,asOf,{kinds});
}
/** Internal reviewed operation; intentionally not exposed through generic submit_record. */
export async function confirmCorporateAction(db,input,actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const events=await actionEvents(db);
  const version=input.configuration_version===undefined?1:input.configuration_version;policyForVersion(version);
  if(events.some(e=>e.kind==='action_confirmed'&&e.payload.action_id===input.action_id&&(e.payload.configuration_version===undefined?1:e.payload.configuration_version)!==version))throw new AppError('Economic action already confirmed under another configuration; retain the original shared confirmation.',409);
  const payload=actionApproval(events,input,actor);
  const id='action-confirmed:'+(await hash(((input.configuration_version===undefined?1:input.configuration_version))===1?input.action_id:{action_id:input.action_id,configuration_version:input.configuration_version})).slice(0,48);
  await renew(db,'execution',token);
  return await appendLeased(db,{id,kind:'action_confirmed',payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
/** Append only deterministic due phases. No quote or inferred broker fill is created. */
export async function settleCorporateActions(db,actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);const saved=[];
 try{
  for(let count=0;count<1000;count++){
   await renew(db,'execution',token);const ledger=await readLedger(db);
   if(ledger.status==='not_started')return saved;
   const invalid=ledger.problems.filter(p=>p.code!=='action_settlement_pending');
   if(invalid.length)throw new AppError(invalid.map(p=>p.message).join('; '),423);
   const next=ledger.pending[0];if(!next)return saved;
   saved.push(await appendLeased(db,{...next,actor},'execution',token));
  }
  throw new AppError('Corporate-action settlement processing bound reached.',423);
 }finally{await release(db,'execution',token);}
}
export async function coverageState(db,asOf=isoNow(),configurationVersion){return actionCoverage(await actionEvents(db,asOf),asOf,configurationVersion);}
/** Typed evidence capture; callers must supply actual retrieved material and authored reviews. */
export async function recordActionEvidence(db,{idempotency_key,kind,payload},actor){
 if(!['action_source','action_review','coverage_review'].includes(kind)||!payload||typeof payload!=='object'||JSON.stringify(payload).length>50000)throw new AppError('Invalid typed action evidence.');
 // Reject URLs outside even the known candidate allowlist before touching persistence; this grants no configuration admission.
 if(kind==='action_source'&&!CONFIGURATION_VERSIONS.some(version=>approvedPrimaryActionSource(payload.symbol,payload.url,version)))throw new AppError('Actual approved primary source URL required.');
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const version=payload.configuration_version===undefined?await activePolicyVersion(db):payload.configuration_version;policyForVersion(version);
  if(version>1){if(payload.configuration!==undefined&&payload.configuration!==policyCanonical(version))throw new AppError('Evidence configuration binding differs.');payload={...payload,configuration_version:version,configuration:policyCanonical(version),configuration_digest:await policyDigest(version)};}
  if(kind==='action_source'){
   if(!approvedPrimaryActionSource(payload.symbol,payload.url,version)||!payload.excerpt?.trim()||!(/^[a-f0-9]{64}$/.test(payload.content_sha256||''))||typeof payload.observed_at!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(payload.observed_at)||!Number.isFinite(Date.parse(payload.observed_at))||Date.parse(payload.observed_at)>Date.now())throw new AppError('Actual approved primary source URL, symbol, excerpt, document hash and observation time required.');
  }else if(typeof payload.author!=='string'||!payload.author.trim()||!['approved','rejected'].includes(payload.status)||typeof payload.binding!=='string'||!payload.binding.length)throw new AppError('Authored review must bind exact evidence terms.');
  if(kind!=='action_source'){
   let binding;try{binding=JSON.parse(payload.binding);}catch{throw new AppError('Invalid independent review binding JSON.');}
   if(!binding||typeof binding!=='object'||Array.isArray(binding)||canonical(binding)!==payload.binding)throw new AppError('Invalid independent canonical review binding.');
   const boundVersion=binding.configuration_version===undefined?1:binding.configuration_version;policyForVersion(boundVersion);
   if(boundVersion!==version||(version>1&&binding.configuration!==policyCanonical(version))||(version===1&&binding.configuration!==undefined))throw new AppError('Invalid independent review configuration/binding mismatch.');
  }
  return await appendLeased(db,{id:idempotency_key,kind,payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
export async function approveActionCoverage(db,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const events=await actionEvents(db);const now=isoNow();const version=payload?.configuration_version===undefined?await activePolicyVersion(db,now):payload.configuration_version;policyForVersion(version);
  if(version>1){if(payload.configuration!==undefined&&payload.configuration!==policyCanonical(version))throw new AppError('Coverage configuration binding differs.');payload={...payload,configuration_version:version,configuration:policyCanonical(version),configuration_digest:await policyDigest(version)};}
  const candidate={id:idempotency_key,kind:'action_coverage',payload,actor,created_at:now,seq:Number.MAX_SAFE_INTEGER};
  const check=actionCoverage([...events,candidate],now,version);if(!check.ok)throw new AppError(check.problems.join('; '),423);
  return await appendLeased(db,{id:idempotency_key,kind:'action_coverage',payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
