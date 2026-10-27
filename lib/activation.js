import {assertValidationEnabled,validationEvidence,validationOpeningPreflight} from './validation-policy.js';
import { OPERATING_WORKFLOW_VERIFIED } from './execution.js';
import { acquire,release,renew,appendLeased,getEvent,latest,hash,AppError,isoNow } from './store.js';
import { observe,assertEligibleAsset } from './alpaca.js';
import { reconcile,createOpeningPayload } from './reconciliation.js';
import { activationPreflight,releaseEvidence } from './readiness.js';
/** General activation stays hard-disabled; the bounded validation route is separate. */
export async function activateExperiment(db,env,input,actor,fetcher=fetch){
 if(!OPERATING_WORKFLOW_VERIFIED||env.TRADING_ENABLED!=='true')throw new AppError('Activation hard-disabled in this preparation release.',423);
 return activateVerified(db,env,input,actor,fetcher);
}
export async function activateValidation(db,env,input,actor,fetcher=fetch){
 assertValidationEnabled(env);return activateVerified(db,env,input,actor,fetcher,true);
}
/** One atomic authoritative opening contains cash, benchmark AND active control. */
async function activateVerified(db,env,{idempotency_key},actor,fetcher=fetch,validationMode=false){
 if(!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotency_key||''))throw new AppError('Stable activation key required.');
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 const request=async(...args)=>{await renew(db,'execution',token);const result=await fetcher(...args);await renew(db,'execution',token);return result;};
 try{
  const existing=await latest(db,'experiment_opened');
  if(existing){if(existing.payload.activation_key!==idempotency_key||existing.payload.control?.release_revision!==env.RELEASE_REVISION||validationMode&&existing.payload.control?.status!=='validation_pending')throw new AppError('Experiment already started; inception cannot be reset.',409);return existing;}
  await (validationMode?validationEvidence:releaseEvidence)(db,env.RELEASE_REVISION,isoNow());
  const suffix=(await hash(idempotency_key)).slice(0,40);
  // Every attempt gets new evidence, never a cached reconciliation from an earlier uncertain attempt.
  const attempt=crypto.randomUUID();
  const market=await observe(env,request);
  if(validationMode){market.validation_asset=market.asset_metadata.SPY;assertEligibleAsset(market.validation_asset,'SPY');}
  const snapshot=await appendLeased(db,{id:'activation-snapshot:'+attempt,kind:'snapshot',payload:market,actor},'execution',token);
  await reconcile(db,env,'activation-reconcile:'+attempt,actor,request,token);
  const validationHead=await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();
  const checkedAt=isoNow();
  const check=validationMode?await validationOpeningPreflight(db,snapshot.id,checkedAt,env.RELEASE_REVISION):await activationPreflight(db,snapshot.id,checkedAt,env.RELEASE_REVISION);
  if(!validationMode&&!check.prerequisites_complete)throw new AppError('Activation blocked: '+check.problems.join('; '),423);
  const release=await (validationMode?validationEvidence:releaseEvidence)(db,env.RELEASE_REVISION,checkedAt);
  const head=await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').first();
  if(head.seq!==validationHead.seq)throw new AppError('Journal changed during activation checks.',409);
  await renew(db,'execution',token);
  const started_at=isoNow();
  if(validationMode&&(Date.parse(release.protocol.payload.valid_until)<=Date.parse(started_at)||Date.parse(check.decision.payload.valid_until)<=Date.parse(started_at)))throw new AppError('Validation authorization or decision expired before inception.',423);
  const opening=createOpeningPayload(snapshot,started_at,validationMode?'usd-nano-v1':undefined);
  const payload={...opening,activation_key:idempotency_key,corporate_action_support:'reviewed-ordinary-cash-and-whole-splits-v1',control:validationMode?{status:'validation_pending',started_at,release_revision:env.RELEASE_REVISION,validation_protocol_id:release.protocol.id,submission_valid_until:new Date(Math.min(Date.parse(release.protocol.payload.valid_until),Date.parse(check.decision.payload.valid_until),Date.parse(snapshot.payload.clock.next_close))).toISOString(),approval_id:release.protocol.id,verification_id:release.approval.id,general_trading_enabled:false}:{status:'active',started_at,release_revision:env.RELEASE_REVISION,approval_id:release.launch_approval.id,verification_id:release.release_verification.id}};
  // Unique database inception index + lease/head fence make partial or competing activation impossible.
  return await appendLeased(db,{id:'experiment-opening:'+suffix,kind:'experiment_opened',payload,actor},'execution',token,started_at,head.seq);
 }finally{await release(db,'execution',token);}
}
