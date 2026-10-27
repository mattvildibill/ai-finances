import test from 'node:test';import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {reviewed,rolloutEnv,actor,records} from './universe-fixtures.js';
import {append,canonical,getEvent} from '../lib/store.js';
import {seedCoverage} from './action-fixtures.js';
import {policyCanonical,policyDigest,activePolicyVersion} from '../lib/investment-policy.js';
import {observe} from '../lib/alpaca.js';
import {admissionCandidate,stageAdmission,admissionAuthorization,inspectAdmission} from '../lib/universe-admission.js';
import {approveActionCoverage} from '../lib/action-settlement.js';
import {reconcile} from '../lib/reconciliation.js';
import {marketDate} from '../lib/action-ledger.js';
const now=()=>new Date().toISOString();
async function coverage(db){
 const configuration=policyCanonical(2),base={configuration_version:2,configuration,configuration_digest:await policyDigest(2)};
 const fetch=await append(db,{id:'liveness-v2-fetch',kind:'corporate_action_fetch',actor,payload:{...base,status:'evidence_only',query:{start:marketDate(now()),end:marketDate(now()),symbols:'AAPL,MSFT,SPY,IJR',data_quality:'all'},pages:[]}});
 const source=await append(db,{id:'liveness-ijr-source',kind:'action_source',actor,payload:{...base,symbol:'IJR',observed_at:now(),url:'https://www.ishares.com/us/products/239774/ishares-core-sp-smallcap-etf',content_sha256:'c'.repeat(64),excerpt:'Synthetic isolated source'}});
 const v1=await seedCoverage(db),core={configuration_version:2,configuration,date:marketDate(now()),policy:'ordinary-cash-and-whole-splits-v1',fetch_id:fetch.id,source_ids:[...v1.payload.source_ids,source.id],action_ids:[]};const review_ids=[];
 for(const author of ['liveness-coverage-a','liveness-coverage-b']){const e=await append(db,{id:author,kind:'coverage_review',actor:author,payload:{...base,status:'approved',author,binding:canonical(core)}});review_ids.push(e.id);}
 return approveActionCoverage(db,{idempotency_key:'liveness-v2-coverage',payload:{...core,status:'approved',review_ids}},actor);
}
async function preparation(db){
 const pilot=await reviewed(db);
 const fetcher=async(url,options)=>{const response=await pilot.f.fetcher(url,options),body=await response.json();if(new URL(url).pathname.startsWith('/v2/assets/'))body.id='actual-fixture-id-'+body.symbol;return Response.json(body);};
 const data=await observe(rolloutEnv,fetcher,2),old=new Date(Date.now()-900000).toISOString();
 // Isolated old governance capture; its asset metadata was current at that capture, while IEX trades may be sparse.
 data.clock.timestamp=old;data.retrieved_at=old;for(const a of Object.values(data.asset_metadata))a.retrieved_at=old;for(const q of Object.values(data.quotes))q.market_data_at=new Date(Date.now()-3600000).toISOString();
 const observation=await append(db,{id:'liveness-old-governance',kind:'universe_observation',actor,payload:data},old);
 const cov=await coverage(db),common={admission_binding_version:2,configuration_version:2,configuration_hash:await policyDigest(2),revision:rolloutEnv.RELEASE_REVISION,observation_id:observation.id,coverage_id:cov.id};
 const r=await append(db,{id:'liveness-research',kind:'research',actor,payload:{...common,role:'researcher',author:'researcher'}});
 const c=await append(db,{id:'liveness-challenge',kind:'challenge',actor,payload:{...common,role:'challenger',author:'challenger',research_id:r.id}});
 const d=await append(db,{id:'liveness-manager',kind:'decision',actor,payload:{...common,role:'portfolio_manager',author:'manager',research_id:r.id,challenge_id:c.id,challenge_response:'Actual fixture review response',action:'hold',size:0,symbol:'IJR',admission_approval:true,authorization_reference:'isolated-fixture',fund_treatment:{classification:'unleveraged_noninverse_diversified_equity_etf',account_permissions_unchanged:true,incidental_instruments_assessment:'Explicit isolated fixture fund treatment'}}});
 const input={admission_binding_version:2,configuration_version:2,decision_id:d.id,observation_id:observation.id,coverage_id:cov.id};const candidate=await admissionCandidate(db,rolloutEnv,input),review_ids=[];
 for(const author of ['liveness-review-a','liveness-review-b']){const e=await append(db,{id:author,kind:'verification',actor,payload:{author,summary:'Actual fixture governance review',check:'universe_admission_review',outcome:'passed',revision:rolloutEnv.RELEASE_REVISION,binding:candidate.binding}});review_ids.push(e.id);}
 return {...pilot,fetcher,observation,cov,input,candidate,payload:{...input,status:'approved',binding:candidate.binding,review_ids}};
}
async function finalCapture(db,p,mutate=x=>x){
 const payload=mutate(await observe(rolloutEnv,p.fetcher,2));const final=await append(db,{id:'liveness-final-observation',kind:'universe_observation',actor,payload});
 await reconcile(db,rolloutEnv,'liveness-final-reconciliation',actor,p.fetcher);return final;
}
const stage=(db,p,id)=>stageAdmission(db,rolloutEnv,{idempotency_key:'liveness-amendment',payload:{...p.payload,final_observation_id:id}},actor);

test('governance review survives old sparse trades; fresh final observation admits with preserved history',async t=>{
 const {db}=temporaryDatabase(t),p=await preparation(db),before=await records(db);
 assert.ok(Date.now()-Date.parse(p.observation.created_at)>120000);assert.equal(await activePolicyVersion(db),1);
 await assert.rejects(stage(db,p,p.observation.id),/Fresh|reconciliation|New final/);
 const final=await finalCapture(db,p),saved=await stage(db,p,final.id);
 assert.equal(saved.payload.admission_binding_version,2);assert.equal(saved.payload.final_observation_digest,final.digest);assert.equal(saved.payload.observation_id,p.observation.id);
 assert.equal(await activePolicyVersion(db),2);assert.equal((await admissionAuthorization(await records(db),rolloutEnv.RELEASE_REVISION)).amendment_id,saved.id);
 for(const e of before)assert.deepEqual(await getEvent(db,e.id),e);
 assert.deepEqual(await stage(db,p,final.id),saved);assert.equal(p.f.posts,1);
});

test('fresh final gate rejects stale trades, changed identity, wrong config and account mismatch',async t=>{
 const mutations=[
  x=>{x.quotes.IJR.market_data_at=new Date(Date.now()-121000).toISOString();return x;},
  x=>{x.asset_metadata.IJR.id='different-fixture-identity';return x;},
  x=>{x.configuration_hash='f'.repeat(64);return x;},
  x=>{x.account.cash_text='100000';return x;},
  x=>{x.asset_metadata.IJR.tradable=false;return x;},
  x=>{x.clock.timestamp=new Date(Date.now()-121000).toISOString();return x;}
 ];
 for(const mutate of mutations){const {db}=temporaryDatabase(t),p=await preparation(db),final=await finalCapture(db,p,mutate);await assert.rejects(stage(db,p,final.id));assert.equal(await activePolicyVersion(db),1);assert.equal(p.f.posts,1);}
});

test('new adverse coverage and review evidence still invalidate delayed governance approval',async t=>{
 for(const kind of ['coverage_review','verification']){const {db}=temporaryDatabase(t),p=await preparation(db),final=await finalCapture(db,p);
  if(kind==='verification')await append(db,{id:'liveness-adverse-review',kind,actor,payload:{check:'universe_admission_review',outcome:'pending',binding:p.candidate.binding}});
  else await append(db,{id:'liveness-action-failure',kind:'corporate_action_fetch_failed',actor,payload:{message:'Synthetic failed acquisition'}});
  await assert.rejects(stage(db,p,final.id),/coverage|failed|unresolved/);assert.equal(await activePolicyVersion(db),1);
 }
});

test('a later final observation cannot replace the reviewed identities or be silently ignored',async t=>{
 const {db}=temporaryDatabase(t),p=await preparation(db),final=await finalCapture(db,p);
 await inspectAdmission(db,rolloutEnv,{configuration_version:2,idempotency_key:'liveness-newer-observation'},actor,p.fetcher);
 await assert.rejects(stage(db,p,final.id),/New final/);assert.equal(await activePolicyVersion(db),1);
});

test('final observation expiration during asynchronous staging still blocks the new governance protocol',async t=>{
 const {db}=temporaryDatabase(t),p=await preparation(db),final=await finalCapture(db,p),started=Date.now();let crossed=false;
 const delayed={prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('UPDATE locks SET expires_at='))return statement;
  const run=statement.run.bind(statement);statement.run=async()=>{const result=await run();crossed=true;t.mock.timers.enable({apis:['Date'],now:started+121000});return result;};return statement;
 }};
 try{await assert.rejects(stage(delayed,p,final.id),/Fresh|expired/);assert.equal(crossed,true);}finally{t.mock.timers.reset();}
 assert.equal(await activePolicyVersion(db),1);assert.equal(await getEvent(db,'liveness-amendment'),null);assert.equal(p.f.posts,1);
});

test('new governance bindings cannot be silently downgraded or staged without post-review runtime evidence',async t=>{
 const {db}=temporaryDatabase(t),p=await preparation(db);await finalCapture(db,p);
 for(const patch of [{admission_binding_version:1},{admission_binding_version:null},{admission_binding_version:3},{configuration_version:999},{final_observation_id:p.observation.id}]){
  await assert.rejects(stageAdmission(db,rolloutEnv,{idempotency_key:'liveness-downgrade',payload:{...p.payload,...patch}},actor));
 }
 assert.equal(await activePolicyVersion(db),1);
});
