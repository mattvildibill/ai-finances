import {nextSyntheticSession} from './session-time-fixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {reviewed,decisionChain,rolloutEnv,actor,records} from './universe-fixtures.js';
import {stageRollout,rolloutSessionCandidate,rolloutPrerequisites} from '../lib/rollout-policy.js';
import {executeRolloutDecision} from '../lib/execution.js';
import {append,getEvent} from '../lib/store.js';
import {observe} from '../lib/alpaca.js';
import {reconcile} from '../lib/reconciliation.js';
import {seedCoverage} from './action-fixtures.js';
import {marketDate} from '../lib/action-ledger.js';
async function prepare(t){
 const {db}=temporaryDatabase(t),r=await reviewed(db);const previous=await stageRollout(db,rolloutEnv,{idempotency_key:'first-session',payload:r.payload},actor);
 const d=await decisionChain(db,r.f,'first-addition',{size:1500});await reconcile(db,rolloutEnv,'first-addition-recon',actor,r.f.fetcher);await executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher);r.f.settle();await reconcile(db,rolloutEnv,'first-addition-fill',actor,r.f.fetcher);
 const tomorrow=nextSyntheticSession(previous.payload.valid_until);t.mock.timers.enable({apis:['Date'],now:tomorrow});
 const fetcher=async(url,options)=>new URL(url).pathname==='/v2/clock'?Response.json({is_open:true,timestamp:new Date().toISOString(),next_open:new Date(Date.now()+86400000).toISOString(),next_close:new Date(Date.now()+3600000).toISOString()}):r.f.fetcher(url,options);
 await seedCoverage(db);await append(db,{id:'next-session-snapshot',kind:'snapshot',actor,payload:await observe(rolloutEnv,fetcher)});await reconcile(db,rolloutEnv,'next-session-recon',actor,fetcher);
 const payload={...r.payload,protocol_version:2,previous_approval_id:previous.id,session_date:marketDate(new Date().toISOString()),valid_until:new Date(Date.now()+60000).toISOString(),session_authorization_reference:'synthetic-explicit-next-session-approval',session_close_at:new Date(Date.now()+3600000).toISOString()};
 const candidate=await rolloutSessionCandidate(db,{payload});const session_review_ids=[];
 for(const author of ['next-session-review-a','next-session-review-b']){const e=await append(db,{id:author,kind:'verification',actor,payload:{check:'session_authorization_review',revision:payload.revision,binding:candidate.binding,outcome:'passed',author,summary:'Isolated carry-forward review'}});session_review_ids.push(e.id);}
 return {db,r,previous,fetcher,payload:{...payload,session_binding:candidate.binding,session_review_ids}};
}
test('explicit next session preserves inception and lifetime purchases; expired authorization cannot execute',async t=>{
 const {db,r,previous,fetcher,payload}=await prepare(t);const before=await records(db);assert.equal(r.f.posts,2);
 const stale=await decisionChain(db,{fetcher},'before-next-approval');await reconcile(db,rolloutEnv,'before-next-approval-recon',actor,fetcher);await assert.rejects(executeRolloutDecision(db,rolloutEnv,stale.id,actor,fetcher),/expired|another New York/);
 const approval=await stageRollout(db,rolloutEnv,{idempotency_key:'next-session-approval',payload},actor);assert.deepEqual(await stageRollout(db,rolloutEnv,{idempotency_key:'next-session-approval',payload},actor),approval);
 const raw=await decisionChain(db,{fetcher},'next-session-buy',{size:1000});const d=await append(db,{id:'named-next-session-buy',kind:'decision',actor,payload:{...raw.payload,session_approval_id:approval.id}});await reconcile(db,rolloutEnv,'next-buy-recon',actor,fetcher);
 const pre=await rolloutPrerequisites(db,d.id,new Date().toISOString(),rolloutEnv.RELEASE_REVISION);assert.equal(pre.budget.spent,2000000000000n);
 await executeRolloutDecision(db,rolloutEnv,d.id,actor,fetcher);assert.equal(r.f.posts,3);await executeRolloutDecision(db,rolloutEnv,d.id,actor,fetcher);assert.equal(r.f.posts,3);
 assert.deepEqual(await getEvent(db,r.opening.id),r.opening);assert.deepEqual(await getEvent(db,previous.id),previous);for(const e of before)assert.deepEqual(await getEvent(db,e.id),e);
 const after=await records(db);assert.equal(after.filter(e=>e.kind==='experiment_opened').length,1);
});
test('next-session authorization rejects cap resets, absent reviews, changed binding and pending review',async t=>{
 const {db,r,payload}=await prepare(t);
 for(const patch of [{limits:{...payload.limits,cumulative_purchase_cap_cents:2000000}},{session_review_ids:[]},{session_binding:'{}'},{previous_approval_id:'unknown'},{session_authorization_reference:''}])await assert.rejects(stageRollout(db,rolloutEnv,{idempotency_key:'invalid-next-session',payload:{...payload,...patch}},actor));
 await append(db,{id:'pending-session-review',kind:'verification',actor,payload:{check:'session_authorization_review',binding:payload.session_binding,outcome:'pending'}});await assert.rejects(stageRollout(db,rolloutEnv,{idempotency_key:'next-session-blocked',payload},actor),/failed|pending/);assert.equal(r.f.posts,2);
});
