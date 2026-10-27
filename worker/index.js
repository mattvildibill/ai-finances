import {collectManagedActions,recordManagedAction,managedActionCandidate,managedCoverageCandidate} from '../lib/managed-actions.js';
import {readCompleteHistory} from '../lib/history.js';
import {transitionManaged,managedControl,approveManagedRelease} from '../lib/managed-policy.js';
import {executeManagedDecision,managedStatus} from '../lib/managed-execution.js';
import {inspectManagedInstrument,managedInstrumentCandidate,approveManagedInstrument} from '../lib/managed-instruments.js';
import {releaseCandidate,stageReleaseAttestation as stageUniverseRelease} from '../lib/universe-release.js';
import {inspectAdmission,admissionCandidate,stageAdmission,admissionStatus} from '../lib/universe-admission.js';
import {stageRollout,rolloutStatus,rolloutReviewCandidate,rolloutSessionCandidate} from '../lib/rollout-policy.js';
import {stageValidation,validationOpeningPreflight,validationStatus} from '../lib/validation-policy.js';
import { collectCorporateActions } from '../lib/corporate-actions.js';
import { recordActionEvidence,confirmCorporateAction,approveActionCoverage,settleCorporateActions,coverageState } from '../lib/action-settlement.js';
import { activationPreflight,stageReleaseAttestation } from '../lib/readiness.js';
import { activateExperiment,activateValidation } from '../lib/activation.js';
import {state,refresh,submit,observeManagedTarget} from '../lib/service.js';
import {AppError,isoNow,listEvents} from '../lib/store.js';
import {executeDecision,executeValidationDecision,executeRolloutDecision} from '../lib/execution.js';
import {reconcile} from '../lib/reconciliation.js';
import {validateWriteRequest,readJSONBody as body} from '../lib/request-security.js';
import {assets} from './assets.generated.js';
const schemaRecord={type:'object',additionalProperties:false,required:['idempotency_key','kind','payload'],properties:{idempotency_key:{type:'string',minLength:8,maxLength:160},kind:{enum:['research','challenge','decision','revision','verification']},payload:{type:'object',description:'Authored summary, never private chain of thought. Requires title, summary, author. Research/challenge/decision additionally role, evidence [{title,url,observed_at,excerpt}], snapshot_ids. Research/decision: thesis,horizon,uncertainties,change_mind. Challenge: research_id,counterargument. Decision: research_id,challenge_id,action (hold/buy/sell),size USD,symbol for buy/sell,limit_price_cents and valid_until for buy/sell,challenge_response. Revision: supersedes. Distinct authors for each role.'}}};
const toolDefs=[
{name:'managed_portfolio',description:'Standing 180-day cash-funded paper portfolio. Typed mandate transition preserves original inception; supported instrument evidence is verified on demand. Buys and owned sales require actual independent research, manager reasoning and fresh regular-session/account/action evidence. No borrowing, shorts, options, extended hours or fabricated fills. No old launch concentration or turnover caps. Status never grants an order.',inputSchema:{type:'object',required:['operation'],properties:{operation:{enum:['status','transition','control','approve_release','inspect_instrument','observe_target','instrument_candidate','approve_instrument','collect_actions','record_action','action_candidate','coverage_candidate','execute']},input:{type:'object',description:'observe_target: {idempotency_key, symbol}; GET-only broker snapshot for an approved managed target plus held assets and SPY. No decision or trading enablement required; no order permission. Retry returns original timestamped observation.'}},additionalProperties:false}},
{name:'universe_admission',description:'Prospective reviewed universe admission. Candidate observation is GET-only and never an order or admission. Stage requires exact configuration, release, actual expanded evidence, explicit manager interpretation and two independent reviews. No arbitrary symbols or risk changes.',inputSchema:{type:'object',required:['operation'],properties:{operation:{enum:['status','inspect','review_candidate','stage','release_candidate','reattest_release']},input:{type:'object'}},additionalProperties:false}},
{name:'opening_rollout',description:'Separate capped post-pilot paper purchases. Read status or exact actual-pilot review candidate; stage a reviewed session-limited approval; execute requires ROLLOUT_ENABLED, two actual independent pilot reviews, current release checks and all ordinary guards. $10000 cumulative purchases including pilot/commitments; $90000 uncommitted cash. No sales recycling, inception reset or general activation.',inputSchema:{type:'object',required:['operation'],properties:{operation:{enum:['status','review_candidate','session_candidate','stage','execute']},input:{type:'object'}},additionalProperties:false}},
{name:'validation_phase',description:'Separately authorized one-SPY-share paper validation only. Stage exact protocol/release evidence; inspect readiness/status; prospective inception and one expiring day-limit intent require VALIDATION_ENABLED and every gate. Never certifies unobserved fills, allows a second order, or enables general trading. No automatic cancellation or price chasing.',inputSchema:{type:'object',required:['operation'],properties:{operation:{enum:['stage','readiness','status','activate','execute']},input:{type:'object',description:'stage: {idempotency_key,kind:validation_protocol|validation_release,payload}. Protocol: exact revision, mandate_version1, protocol_version1,status approved, authorization_reference, decision_id, valid_until <=24h and decision expiry, general_trading_enabled:false, exact fixed limits and pending_evidence from status. Release: status approved,revision,protocol_id,checks map of existing actual verification IDs. readiness:{snapshot_id}; activate:{idempotency_key}; execute:{decision_id}. No limit overrides or skip flags.'}},additionalProperties:false}},
{name:'stage_release_attestation',description:'Append a release-specific attestation only for actual completed checks or actual user authorization. Requires existing measured verification IDs; never substitute synthetic tests for broker or hosted evidence. Does not enable execution or activation.',inputSchema:{type:'object',required:['idempotency_key','kind','payload'],properties:{idempotency_key:{type:'string'},kind:{enum:['launch_approval','release_verification']},payload:{type:'object'}},additionalProperties:false}},
{name:'corporate_actions',description:'Reviewed corporate-action workflow. collect only acquires real raw notices; record captures actual issuer evidence or authored reviews; confirm and coverage validate exact independent bindings; settle appends exact due shared economic phases. Never invent sources or entitlements. Modeled dividends never increase broker cash. Does not enable execution.',inputSchema:{type:'object',required:['operation'],properties:{operation:{enum:['collect','record','confirm','coverage','settle','status']},input:{type:'object'}},additionalProperties:false}},
{name:'activation_readiness',description:'Read-only prospective activation checks. Returns specific unmet evidence and never enables execution.',inputSchema:{type:'object',required:['snapshot_id'],properties:{snapshot_id:{type:'string'}},additionalProperties:false}},
{name:'activate_experiment',description:'Controlled single-event prospective inception. Hard-disabled in this preparation release; cannot override any failed prerequisite or backdate the benchmark.',inputSchema:{type:'object',required:['idempotency_key'],properties:{idempotency_key:{type:'string'}},additionalProperties:false}},
{name:'portfolio_state',description:'Read the paused Blue Capital experiment, latest actual IEX observations, immutable journal, mandate and health. Optionally replay knowledge as of a UTC time.',inputSchema:{type:'object',properties:{as_of:{type:'string'}},additionalProperties:false}},
{name:'refresh_market',description:'Fetch Alpaca paper account and AAPL/MSFT/SPY IEX observations, then inspect fill activities for read-only reconciliation in persistent storage. No trade. Use a stable idempotency key for retries.',inputSchema:{type:'object',required:['idempotency_key'],properties:{idempotency_key:{type:'string'}},additionalProperties:false}},
{name:'submit_record',description:'Append structured researcher, independent challenger or portfolio-manager output. Originals cannot be edited. A hold decision is valid. This does not execute trades.',inputSchema:schemaRecord},
{name:'execute_decision',description:'Attempt a permitted paper order for an existing approved decision. Fails closed while the experiment or its operating checks are paused. Never live trading.',inputSchema:{type:'object',required:['decision_id'],properties:{decision_id:{type:'string'}},additionalProperties:false}},
{name:'reconcile_paper',description:'GET-only inspection of paper fill activities, known orders, cash and positions. Appends reconciliation receipts; never submits or cancels orders, activates trading, or initializes the experiment. Unsupported precision and corporate actions remain blockers.',inputSchema:{type:'object',required:['idempotency_key'],properties:{idempotency_key:{type:'string'}},additionalProperties:false}},
{name:'export_history',description:'Export immutable records after a sequence number, up to 500 per page. Digests are SHA-256 of canonical {kind,payload}.',inputSchema:{type:'object',properties:{after_seq:{type:'integer',minimum:0}},additionalProperties:false}}
];
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
function authorize(request,env){
 // Dispatch verifies the private Site audience and strips/spoof-protects identity headers.
 // Service access is intentionally limited by an additional server-only bearer.
 const user=request.headers.get('oai-authenticated-user-id');
 if(user)return 'chatgpt:'+user;
 const service=request.headers.get('authorization');
 if(env.SERVICE_TOKEN&&service==='Bearer '+env.SERVICE_TOKEN)return 'cloud-service';
 throw new AppError('Sign in to this private Site with ChatGPT.',401);
}
async function call(name,args,env,actor){
 if(!env.DB)throw new AppError('Persistent database is not bound.',503);
 if(name==='managed_portfolio'){const i=args.input||{};if(args.operation==='status')return managedStatus(env.DB,env);if(args.operation==='transition')return transitionManaged(env.DB,env,i,actor);if(args.operation==='control')return managedControl(env.DB,env,i,actor);if(args.operation==='approve_release')return approveManagedRelease(env.DB,env,i,actor);if(args.operation==='observe_target')return observeManagedTarget(env.DB,env,i,actor);if(args.operation==='inspect_instrument')return inspectManagedInstrument(env.DB,env,i,actor);if(args.operation==='instrument_candidate')return managedInstrumentCandidate(env.DB,i);if(args.operation==='approve_instrument')return approveManagedInstrument(env.DB,env,i,actor);if(args.operation==='collect_actions')return collectManagedActions(env.DB,env,i,actor);if(args.operation==='record_action')return recordManagedAction(env.DB,i,actor);if(args.operation==='action_candidate')return managedActionCandidate(await readCompleteHistory(env.DB),i);if(args.operation==='coverage_candidate')return managedCoverageCandidate(await readCompleteHistory(env.DB),i);if(args.operation==='execute')return executeManagedDecision(env.DB,env,i.decision_id,actor);throw new AppError('Unknown managed operation');}
 if(name==='universe_admission'){const input=args.input||{};if(args.operation==='release_candidate')return releaseCandidate(env.DB,env,input);if(args.operation==='reattest_release')return stageUniverseRelease(env.DB,env,input,actor);if(args.operation==='status')return admissionStatus(env.DB,env);if(args.operation==='inspect')return inspectAdmission(env.DB,env,input,actor);if(args.operation==='review_candidate')return admissionCandidate(env.DB,env,input);if(args.operation==='stage')return stageAdmission(env.DB,env,input,actor);throw new AppError('Unknown admission operation');}
 if(name==='opening_rollout'){
  const input=args.input||{};
  if(args.operation==='status')return rolloutStatus(env.DB,env);
  if(args.operation==='review_candidate')return rolloutReviewCandidate(env.DB,input);
  if(args.operation==='session_candidate')return rolloutSessionCandidate(env.DB,input);
  if(args.operation==='stage')return stageRollout(env.DB,env,input,actor);
  if(args.operation==='execute')return executeRolloutDecision(env.DB,env,input.decision_id,actor);
  throw new AppError('Unknown opening rollout operation.');
 }
 if(name==='validation_phase'){
  const input=args.input||{};
  if(args.operation==='stage')return stageValidation(env.DB,env,input,actor);
  if(args.operation==='status')return validationStatus(env.DB,env);
  if(args.operation==='readiness'){
   const status=await validationStatus(env.DB,env);const problems=[];
   if(!status.enabled)problems.push('Limited validation remains disabled.');
   try{await validationOpeningPreflight(env.DB,input.snapshot_id,isoNow(),env.RELEASE_REVISION);}catch(error){problems.push(error.message);}
   return {...status,ready:problems.length===0,problems,trading_permitted:false};
  }
  if(args.operation==='activate')return activateValidation(env.DB,env,input,actor);
  if(args.operation==='execute')return executeValidationDecision(env.DB,env,input.decision_id,actor);
  throw new AppError('Unknown validation operation.');
 }
 if(name==='corporate_actions'){
  const input=args.input||{};
  if(args.operation==='collect')return collectCorporateActions(env.DB,env,input,actor);
  if(args.operation==='record')return recordActionEvidence(env.DB,input,actor);
  if(args.operation==='confirm')return confirmCorporateAction(env.DB,input,actor);
  if(args.operation==='coverage')return approveActionCoverage(env.DB,input,actor);
  if(args.operation==='settle')return settleCorporateActions(env.DB,actor);
  if(args.operation==='status')return coverageState(env.DB);
  throw new AppError('Unknown corporate-action operation.');
 }
 if(name==='stage_release_attestation')return stageReleaseAttestation(env.DB,env,args,actor);
 if(name==='activation_readiness')return activationPreflight(env.DB,args.snapshot_id,isoNow(),env.RELEASE_REVISION);
 if(name==='activate_experiment')return activateExperiment(env.DB,env,args,actor);
 if(name==='portfolio_state')return state(env.DB,args.as_of,env);
 if(name==='refresh_market')return refresh(env.DB,env,args.idempotency_key,actor);
 if(name==='submit_record')return submit(env.DB,args,actor);
 if(name==='reconcile_paper')return reconcile(env.DB,env,args.idempotency_key,actor);
 if(name==='execute_decision')return executeDecision(env.DB,env,args.decision_id,actor);
 if(name==='export_history'){
  if(!Number.isSafeInteger(args.after_seq??0)||(args.after_seq??0)<0)throw new AppError('Invalid sequence.');
  const r=await env.DB.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500').bind(args.after_seq??0).all();
  return {records:r.results.map(e=>({...e,payload:JSON.parse(e.payload)})),next_after_seq:r.results.at(-1)?.seq??null};
 }
 throw new AppError('Unknown tool.',404);
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 try {
  if(request.method==='POST'&&(url.pathname==='/mcp'||url.pathname.startsWith('/api/')))validateWriteRequest(request);
  if(url.pathname==='/mcp'&&request.method==='POST'){
   const b=await body(request);let result;
   if(b.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
   else if(b.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'blue-capital',version:'1.0.0'}};
   else if(b.method==='tools/list')result={tools:toolDefs};
   else if(b.method==='notifications/initialized')return new Response(null,{status:204});
   else if(b.method==='tools/call'){
    try{const actor=authorize(request,env);result={content:[{type:'text',text:JSON.stringify(await call(b.params.name,b.params.arguments||{},env,actor))}]};}
    catch(e){result={isError:true,content:[{type:'text',text:e instanceof AppError?e.message:'Operation failed. No new trade should be assumed.'}]};}
   }else return json({jsonrpc:'2.0',id:b.id??null,error:{code:-32601,message:'Method not found'}});
   return json({jsonrpc:'2.0',id:b.id??null,result});
  }
  const actor=authorize(request,env);
  if(url.pathname.startsWith('/api/')){
   if(url.pathname==='/api/state'&&request.method==='GET')return json(await call('portfolio_state',{as_of:url.searchParams.get('as_of')||undefined},env,actor));
   if(url.pathname==='/api/refresh'&&request.method==='POST')return json(await call('refresh_market',await body(request),env,actor));
   if(url.pathname==='/api/records'&&request.method==='POST')return json(await call('submit_record',await body(request),env,actor));
   if(url.pathname==='/api/export'&&request.method==='GET')return json(await call('export_history',{after_seq:Number(url.searchParams.get('after_seq')||0)},env,actor));
   if(url.pathname==='/api/reconcile'&&request.method==='POST')return json(await call('reconcile_paper',await body(request),env,actor));
   if(url.pathname==='/api/execute'&&request.method==='POST')return json(await call('execute_decision',await body(request),env,actor));
   return json({error:'Not found'},404);
  }
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];
  if(!asset)return json({error:'Not found'},404);
  return new Response(asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 }catch(e){return json({error:e instanceof AppError?e.message:'Service unavailable. Records are retained and trading stays paused.'},e instanceof AppError?e.status:503);}
}};
export {toolDefs,authorize};
