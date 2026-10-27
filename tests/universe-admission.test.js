import test from 'node:test';import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {reviewed,decisionChain,rolloutEnv,actor,records} from './universe-fixtures.js';
import {append,canonical,getEvent} from '../lib/store.js';
import {seedCoverage} from './action-fixtures.js';
import {policyCanonical,policyDigest,policyVersionAt,activePolicyVersion} from '../lib/investment-policy.js';
import {inspectAdmission,admissionCandidate,stageAdmission,admissionAuthorization,admissionEvents} from '../lib/universe-admission.js';
import {approveActionCoverage,coverageState} from '../lib/action-settlement.js';
import {stageRollout,rolloutPrerequisites} from '../lib/rollout-policy.js';
import {executeRolloutDecision,executeValidationDecision} from '../lib/execution.js';
import {reconcile,readLedger} from '../lib/reconciliation.js';
import {marketDate} from '../lib/action-ledger.js';
import {state} from '../lib/service.js';
const now=()=>new Date().toISOString();
async function candidateCoverage(db){
 const configuration=policyCanonical(2),configuration_digest=await policyDigest(2),base={configuration_version:2,configuration,configuration_digest};
 const fetch=await append(db,{id:'admission-fetch-v2',kind:'corporate_action_fetch',actor,payload:{...base,status:'evidence_only',query:{start:marketDate(now()),end:marketDate(now()),symbols:'AAPL,MSFT,SPY,IJR',data_quality:'all'},pages:[]}});
 const source=await append(db,{id:'candidate-ijr-source',kind:'action_source',actor,payload:{...base,symbol:'IJR',observed_at:now(),url:'https://www.ishares.com/us/products/239774/ishares-core-sp-smallcap-etf',content_sha256:'c'.repeat(64),excerpt:'Synthetic evidence only'}});
 const v1=await seedCoverage(db);const core={configuration_version:2,configuration,date:marketDate(now()),policy:'ordinary-cash-and-whole-splits-v1',fetch_id:fetch.id,source_ids:[...v1.payload.source_ids,source.id],action_ids:[]};const review_ids=[];
 for(const author of ['expanded-source-a','expanded-source-b']){const r=await append(db,{id:author,kind:'coverage_review',actor:author,payload:{configuration_version:2,configuration,status:'approved',binding:canonical(core),author}});review_ids.push(r.id);}
 return approveActionCoverage(db,{idempotency_key:'candidate-v2-coverage',payload:{...core,status:'approved',review_ids}},actor);
}
async function preparation(db,{priorRollout=false}={}){
 const pilot=await reviewed(db);let oldApproval;
 if(priorRollout)oldApproval=await stageRollout(db,rolloutEnv,{idempotency_key:'prior-v1-rollout',payload:pilot.payload},actor);
 const observation=await inspectAdmission(db,rolloutEnv,{idempotency_key:'candidate-observation',configuration_version:2},actor,pilot.f.fetcher);
 const coverage=await candidateCoverage(db);await reconcile(db,rolloutEnv,'admission-fresh-recon',actor,pilot.f.fetcher);
 const common={configuration_version:2,configuration_hash:await policyDigest(2),revision:rolloutEnv.RELEASE_REVISION,observation_id:observation.id,coverage_id:coverage.id,snapshot_ids:[pilot.opening.payload.snapshot_id]};
 const r=await append(db,{id:'admission-research',kind:'research',actor,payload:{...common,role:'researcher',author:'researcher'}});
 const c=await append(db,{id:'admission-challenge',kind:'challenge',actor,payload:{...common,role:'challenger',author:'challenger',research_id:r.id}});
 const d=await append(db,{id:'admission-decision',kind:'decision',actor,payload:{...common,role:'portfolio_manager',author:'manager',research_id:r.id,challenge_id:c.id,challenge_response:'Synthetic explicit fund review',action:'hold',size:0,symbol:'IJR',admission_approval:true,authorization_reference:'fixture-only',fund_treatment:{classification:'unleveraged_noninverse_diversified_equity_etf',account_permissions_unchanged:true,incidental_instruments_assessment:'Synthetic test interpretation only; actual parent approval remains pending.'}}});
 const input={decision_id:d.id,observation_id:observation.id,coverage_id:coverage.id};const candidate=await admissionCandidate(db,rolloutEnv,input);const review_ids=[];
 for(const author of ['admission-review-a','admission-review-b']){const r=await append(db,{id:author,kind:'verification',actor:author,payload:{author,title:'Fixture',summary:'Synthetic exact review',check:'universe_admission_review',outcome:'passed',revision:rolloutEnv.RELEASE_REVISION,binding:candidate.binding}});review_ids.push(r.id);}
 return {...pilot,observation,coverage,oldApproval,input,candidate,amendmentPayload:{...input,binding:candidate.binding,status:'approved',review_ids}};
}
const admit=(db,r)=>stageAdmission(db,rolloutEnv,{idempotency_key:'admit-candidate-ijr',payload:r.amendmentPayload},actor);

test('candidate evidence does not admit IJR; prospective amendment preserves old universe and original pilot',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);const before=await records(db);
 assert.equal(await activePolicyVersion(db),1);assert.deepEqual((await state(db)).mandate.universe,['AAPL','MSFT','SPY']);
 assert.equal((await coverageState(db)).ok,true);assert.equal((await coverageState(db,now(),2)).ok,true);
 const amendment=await admit(db,r);assert.equal(amendment.payload.effective_at,amendment.created_at);assert.equal(await activePolicyVersion(db),2);
 assert.deepEqual((await state(db)).mandate.universe,['AAPL','MSFT','SPY','IJR']);assert.equal(policyVersionAt(before),1);
 assert.deepEqual(await getEvent(db,r.opening.id),r.opening);assert.equal((await readLedger(db)).benchmark.holdings.IJR,undefined);
 for(const e of before)assert.deepEqual(await getEvent(db,e.id),e);
 assert.deepEqual(await admit(db,r),amendment);assert.equal((await records(db)).filter(e=>e.kind==='mandate_amendment').length,1);
 await assert.rejects(stageAdmission(db,rolloutEnv,{idempotency_key:'second-admission',payload:r.amendmentPayload},actor),/already recorded/);
});

test('admission rejects altered binding, missing reviews, stale observations and pending reviews',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);
 for(const patch of [{binding:'{}'},{status:'pending'},{review_ids:[]},{review_ids:['admission-review-a','admission-review-a']}])await assert.rejects(stageAdmission(db,rolloutEnv,{idempotency_key:'bad-admission-key',payload:{...r.amendmentPayload,...patch}},actor));
 t.mock.timers.enable({apis:['Date'],now:Date.now()+121000});await assert.rejects(admit(db,r),/Fresh/);t.mock.timers.reset();
 await append(db,{id:'admission-pending-review',kind:'verification',actor,payload:{check:'universe_admission_review',binding:r.candidate.binding,outcome:'pending'}});
 await assert.rejects(admit(db,r),/failed|unresolved/);assert.equal(await activePolicyVersion(db),1);
});

test('version2 rollout binds admission and retains original spending, exact fills and benchmark',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db),amendment=await admit(db,r);
 await reconcile(db,rolloutEnv,'after-admission-reconcile',actor,r.f.fetcher);
 const payload={...r.payload,mandate_version:2,amendment_id:amendment.id,configuration_hash:await policyDigest(2)};
 await stageRollout(db,rolloutEnv,{idempotency_key:'expanded-rollout',payload},actor);
 const d=await decisionChain(db,r.f,'buy-ijr-decision',{symbol:'IJR',size:1500,limit:10000});
 await reconcile(db,rolloutEnv,'decision-snapshot-reconcile',actor,r.f.fetcher);
 const pre=await rolloutPrerequisites(db,d.id,now(),rolloutEnv.RELEASE_REVISION);assert.equal(pre.budget.spent,500000000000n);
 await executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher);r.f.settle();
 const result=await reconcile(db,rolloutEnv,'ijr-fill-reconcile',actor,r.f.fetcher);assert.equal(result.payload.status,'reconciled');
 const ledger=await readLedger(db);assert.equal(ledger.portfolio.holdings.IJR.quantity,15);assert.equal(ledger.portfolio.cash_nanos,'98000000000000');assert.equal(ledger.benchmark.holdings.IJR,undefined);assert.equal(r.f.posts,2);
 assert.deepEqual(await getEvent(db,r.opening.id),r.opening);
 const events=await records(db),intent=events.filter(e=>e.kind==='order_intent').at(-1);assert.equal(intent.payload.amendment_id,amendment.id);
 await append(db,{id:'later-admission-failure',kind:'verification',actor,payload:{check:'universe_admission_review',binding:r.candidate.binding,outcome:'failed'}});
 await assert.rejects(admissionAuthorization(await admissionEvents(db),rolloutEnv.RELEASE_REVISION),/failed/);
 await executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher);assert.equal(r.f.posts,2);assert.equal((await readLedger(db)).portfolio.holdings.IJR.quantity,15);
});

test('version1 rollout continuation needs explicit version2 approval without resetting its cap or expiry',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db,{priorRollout:true}),amendment=await admit(db,r);
 await reconcile(db,rolloutEnv,'continuation-reconcile',actor,r.f.fetcher);
 const payload={...r.payload,mandate_version:2,amendment_id:amendment.id,configuration_hash:await policyDigest(2),previous_approval_id:r.oldApproval.id};
 await assert.rejects(stageRollout(db,rolloutEnv,{idempotency_key:'bad-continuation',payload:{...payload,valid_until:new Date(Date.parse(payload.valid_until)+1000).toISOString()}},actor),/bounded/);
 await stageRollout(db,rolloutEnv,{idempotency_key:'bounded-continuation',payload},actor);
 const d=await decisionChain(db,r.f,'continued-ijr',{symbol:'IJR',size:9600,limit:10000});
 await reconcile(db,rolloutEnv,'continuation-decision-reconcile',actor,r.f.fetcher);
 await assert.rejects(executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher),/10,000|5%/);assert.equal(r.f.posts,1);
});

test('admission rechecks candidate freshness after asynchronous lease renewal',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);const started=Date.now();let crossed=false;
 const delayed={prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('UPDATE locks SET expires_at='))return statement;
  const run=statement.run.bind(statement);statement.run=async()=>{const result=await run();crossed=true;t.mock.timers.enable({apis:['Date'],now:started+121000});return result;};return statement;
 }};
 try{await assert.rejects(admit(delayed,r),/Fresh|expired/);assert.equal(crossed,true);}
 finally{t.mock.timers.reset();}
 assert.equal(await activePolicyVersion(db),1);assert.equal(await getEvent(db,'admit-candidate-ijr'),null);
 assert.equal(r.f.posts,1,'Only the synthetic original pilot was posted');
});

test('later release cannot silently inherit the immutable admission authorization',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);const amendment=await admit(db,r),before=await records(db);
 await assert.rejects(admissionAuthorization(await admissionEvents(db),'c'.repeat(40)),/exact candidate evidence and release|exact release/);
 assert.equal(await activePolicyVersion(db),2,'Historical admission and holdings are not erased by authorization failure');
 assert.deepEqual(await getEvent(db,amendment.id),amendment);assert.deepEqual(await records(db),before);
 assert.equal((await admissionAuthorization(await admissionEvents(db),rolloutEnv.RELEASE_REVISION)).amendment_id,amendment.id);
});

test('candidate evidence and favorable reconciliation cannot replace actual completed pilot proof',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);const history=await records(db);
 for(const missingKind of ['order_intent','ledger_fill','order_closed']){
  const {db:incomplete}=temporaryDatabase(t);
  // A separate synthetic history lacks one essential pilot receipt. The complete
  // source fixture and all production records remain untouched.
  for(const event of history.filter(e=>e.kind!==missingKind))await incomplete.prepare('INSERT INTO events(seq,id,kind,created_at,actor,payload,digest) VALUES(?,?,?,?,?,?,?)').bind(event.seq,event.id,event.kind,event.created_at,event.actor,JSON.stringify(event.payload),event.digest).run();
  await assert.rejects(admit(incomplete,r),/Actual completed one-share pilot proof/);
  assert.equal(await activePolicyVersion(incomplete),1);assert.equal(await getEvent(incomplete,'admit-candidate-ijr'),null);
 }
 assert.deepEqual(await records(db),history);
});

import {releaseCandidate,stageReleaseAttestation} from '../lib/universe-release.js';
import {VALIDATION_CHECKS} from '../lib/validation-policy.js';
async function reattestation(db,r,revision='e'.repeat(40)){
 const env={...rolloutEnv,RELEASE_REVISION:revision},checks={};
 for(const check of VALIDATION_CHECKS){const receipt=await append(db,{id:'new-release-'+check,kind:'verification',actor,payload:{check,revision,outcome:'passed',summary:'Isolated new-release fixture'}});checks[check]=receipt.id;}
 const candidate=await releaseCandidate(db,env,{checks}),review_ids=[];
 for(const author of ['new-release-review-a','new-release-review-b']){const receipt=await append(db,{id:author,kind:'verification',actor:author,payload:{check:'universe_release_review',outcome:'passed',revision,author,binding:candidate.binding,summary:'Synthetic unchanged-configuration review'}});review_ids.push(receipt.id);}
 const payload={status:'approved',author:'manager',checks,review_ids,binding:candidate.binding};
 return {env,payload,candidate,stage:()=>stageReleaseAttestation(db,env,{idempotency_key:'new-release-attestation',payload},actor)};
}
test('unchanged configuration re-attests a new release without new admission or reset and retains failed-evidence guards',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db),amendment=await admit(db,r);
 await reconcile(db,rolloutEnv,'prior-v2-recon',actor,r.f.fetcher);
 const oldPayload={...r.payload,mandate_version:2,amendment_id:amendment.id,configuration_hash:await policyDigest(2)};
 const old=await stageRollout(db,rolloutEnv,{idempotency_key:'old-v2-approval',payload:oldPayload},actor);
 const next=await reattestation(db,r);await assert.rejects(admissionAuthorization(await records(db),next.env.RELEASE_REVISION),/re-attestation/);
 const receipt=await next.stage();assert.deepEqual(await next.stage(),receipt);
 assert.equal((await admissionAuthorization(await records(db),next.env.RELEASE_REVISION)).release_attestation_id,receipt.id);
 await assert.rejects(admissionAuthorization(await records(db),rolloutEnv.RELEASE_REVISION),/re-attestation/);
 const review_ids=[];for(const author of ['new-pilot-review-a','new-pilot-review-b']){const e=await append(db,{id:author,kind:'verification',actor,payload:{check:'pilot_outcome_review',outcome:'passed',revision:next.env.RELEASE_REVISION,author,summary:'Same actual fixture pilot reviewed under new code',pilot_binding:r.payload.pilot_binding}});review_ids.push(e.id);}
 await reconcile(db,next.env,'new-release-reconcile',actor,r.f.fetcher);
 const continuation={...oldPayload,revision:next.env.RELEASE_REVISION,previous_approval_id:old.id,release_attestation_id:receipt.id,checks:next.payload.checks,review_ids};
 await assert.rejects(stageRollout(db,next.env,{idempotency_key:'extended-release-rollout',payload:{...continuation,valid_until:new Date(Date.parse(oldPayload.valid_until)+1000).toISOString()}},actor),/bounded/);
 await stageRollout(db,next.env,{idempotency_key:'new-release-rollout',payload:continuation},actor);
 const d=await decisionChain(db,r.f,'new-code-ijr',{symbol:'IJR',size:1500,limit:10000});await reconcile(db,next.env,'new-code-decision-reconcile',actor,r.f.fetcher);
 const pre=await rolloutPrerequisites(db,d.id,now(),next.env.RELEASE_REVISION);assert.equal(pre.budget.spent,500000000000n);assert.equal(pre.release_attestation_id,receipt.id);
 assert.equal((await records(db)).filter(e=>e.kind==='mandate_amendment').length,1);assert.deepEqual(await getEvent(db,r.opening.id),r.opening);
 await append(db,{id:'new-release-pending-check',kind:'verification',actor,payload:{check:'independent_code_review',revision:next.env.RELEASE_REVISION,outcome:'pending',summary:'Later evidence'}});
 await assert.rejects(rolloutPrerequisites(db,d.id,now(),next.env.RELEASE_REVISION),/failed|unresolved|Superseding/);assert.equal(r.f.posts,1);
});
test('re-attestation rejects altered bindings, missing checks, non-independent reviewers and adverse original admission evidence',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);await admit(db,r);const next=await reattestation(db,r);
 for(const patch of [{binding:'{}'},{checks:{}},{review_ids:['new-release-review-a','new-release-review-a']},{author:'new-release-review-a'},{status:'pending'}])await assert.rejects(stageReleaseAttestation(db,next.env,{idempotency_key:'invalid-reattestation',payload:{...next.payload,...patch}},actor));
 await append(db,{id:'original-admission-withdrawn',kind:'verification',actor,payload:{check:'universe_admission_review',binding:r.candidate.binding,outcome:'failed'}});
 await assert.rejects(next.stage(),/failed|unresolved/);assert.equal((await records(db)).filter(e=>e.kind==='universe_release_attestation').length,0);
});

test('a later release cannot bypass a withdrawn prior re-attestation review',async t=>{
 const {db}=temporaryDatabase(t),r=await preparation(db);await admit(db,r);const next=await reattestation(db,r);await next.stage();
 await append(db,{id:'withdrawn-prior-release-review',kind:'verification',actor,payload:{check:'universe_release_review',binding:next.candidate.binding,outcome:'failed'}});
 await assert.rejects(releaseCandidate(db,{...rolloutEnv,RELEASE_REVISION:'f'.repeat(40)},{checks:next.payload.checks}),/review failed|pending/);
});
