import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {reviewed,rolloutEnv,actor,records,decisionChain} from './universe-fixtures.js';
import {stageRollout,sessionBinding,rolloutSessionCandidate} from '../lib/rollout-policy.js';
import {executeRolloutDecision} from '../lib/execution.js';
import {reconcile} from '../lib/reconciliation.js';
import {acquire,appendLeased,getEvent,append} from '../lib/store.js';
import {marketDate} from '../lib/action-ledger.js';

test('independent continuation binding preserves root lineage and ambiguous commitments; no candidate binding grants execution',async t=>{
 const {db}=temporaryDatabase(t),r=await reviewed(db);
 const prior=await stageRollout(db,rolloutEnv,{idempotency_key:'security-original-approval',payload:r.payload},actor);
 const d=await decisionChain(db,r.f,'security-unresolved-buy',{size:1000});await reconcile(db,rolloutEnv,'security-pre-buy-reconciliation',actor,r.f.fetcher);
 await executeRolloutDecision(db,rolloutEnv,d.id,actor,r.f.fetcher); // Synthetic order intentionally left open.
 const events=await records(db),future=new Date(Date.now()+86400000),close=new Date(future.getTime()+3600000).toISOString();
 const p={...r.payload,protocol_version:2,previous_approval_id:prior.id,session_authorization_reference:'synthetic manager authority',session_date:marketDate(future.toISOString()),valid_until:new Date(future.getTime()+60000).toISOString(),session_close_at:close};
 const b=sessionBinding(events,p);
 assert.equal(b.budget_root.opening_id,r.opening.id);assert.equal(b.budget_root.opening_digest,r.opening.digest);assert.equal(b.budget_root.initial_approval_id,prior.id);assert.equal(b.previous_digest,prior.digest);
 assert.deepEqual(b.budget_nanos,{spent:'500000000000',reserved:'1000000000000',total:'1500000000000'});
 assert.equal((await records(db)).filter(e=>e.kind==='rollout_approval').length,1);
 for(const patch of [{previous_approval_id:'missing'},{protocol_version:1},{session_authorization_reference:''},{session_close_at:null},{session_close_at:'not-a-time'},{valid_until:new Date(Date.parse(close)+1).toISOString()},{session_date:'2000-01-01'}])assert.throws(()=>sessionBinding(events,{...p,...patch}));
 const competing={...prior,id:'competing-predecessor',seq:events.at(-1).seq+1};assert.throws(()=>sessionBinding([...events,competing],p),/predecessor/);
 assert.equal(r.f.posts,2);
});

test('protocol2 continuation uses existing atomic SQL deadline and cannot insert expired approval with earlier caller time',async t=>{
 const {db}=temporaryDatabase(t),token='security-next-session-lease';await acquire(db,'execution',token);
 const payload={protocol_version:2,valid_until:new Date(Date.now()-1000).toISOString()};
 await assert.rejects(appendLeased(db,{id:'security-expired-next-session',kind:'rollout_approval',actor,payload},'execution',token,new Date(Date.now()-10000).toISOString()));
 assert.equal(await getEvent(db,'security-expired-next-session'),null);
});

import {seedCoverage} from './action-fixtures.js';
import {observe} from '../lib/alpaca.js';
test('later sessions cannot bypass a withdrawn earlier session review',async t=>{
 const {db}=temporaryDatabase(t),r=await reviewed(db);let previous=await stageRollout(db,rolloutEnv,{idempotency_key:'withdrawal-original',payload:r.payload},actor);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+86400000});
 const fetcher=async(url,options)=>new URL(url).pathname==='/v2/clock'?Response.json({is_open:true,timestamp:new Date().toISOString(),next_open:new Date(Date.now()+86400000).toISOString(),next_close:new Date(Date.now()+3600000).toISOString()}):r.f.fetcher(url,options);
 async function prepareSession(label){
  await seedCoverage(db);await append(db,{id:label+'-snapshot',kind:'snapshot',actor,payload:await observe(rolloutEnv,fetcher)});await reconcile(db,rolloutEnv,label+'-reconciliation',actor,fetcher);
  const p={...r.payload,protocol_version:2,previous_approval_id:previous.id,session_authorization_reference:'Synthetic independent review',session_date:marketDate(new Date().toISOString()),valid_until:new Date(Date.now()+60000).toISOString(),session_close_at:new Date(Date.now()+3600000).toISOString()};
  const candidate=await rolloutSessionCandidate(db,{payload:p}),session_review_ids=[];
  for(const author of ['reviewer-a','reviewer-b']){const e=await append(db,{id:label+'-'+author,kind:'verification',actor,payload:{check:'session_authorization_review',revision:p.revision,binding:candidate.binding,outcome:'passed',author,summary:'Isolated approval'}});session_review_ids.push(e.id);}
  return {...p,session_binding:candidate.binding,session_review_ids};
 }
 const first=await prepareSession('withdrawal-session-2');previous=await stageRollout(db,rolloutEnv,{idempotency_key:'withdrawal-session-2-approval',payload:first},actor);
 await append(db,{id:'withdrawn-session-2-review',kind:'verification',actor,payload:{check:'session_authorization_review',binding:first.session_binding,outcome:'failed'}});
 t.mock.timers.tick(86400000);const second=await prepareSession('withdrawal-session-3');
 await assert.rejects(stageRollout(db,rolloutEnv,{idempotency_key:'withdrawal-session-3-approval',payload:second},actor),/Prior session review failed/);
 assert.equal(await getEvent(db,'withdrawal-session-3-approval'),null);assert.equal(r.f.posts,1);
});
