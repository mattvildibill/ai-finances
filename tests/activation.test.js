import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { append,listEvents,acquire,release } from '../lib/store.js';
import { activateExperiment } from '../lib/activation.js';
import { readLedger } from '../lib/reconciliation.js';
import { seedCoverage,releaseChecks } from './action-fixtures.js';
import { temporaryDatabase,brokerFixture,testEnv } from './helpers.js';
const revision='a'.repeat(40);const env={...testEnv,RELEASE_REVISION:revision};const actor='synthetic:activation';
async function setup(db){await append(db,{id:'activation-evidence',kind:'verification',actor,payload:{outcome:'passed',summary:'Synthetic validation only'}});const checks=await releaseChecks(db,revision);for(const kind of ['launch_approval','release_verification'])await append(db,{id:kind+'-activation',kind,actor,payload:{status:'approved',authorization_reference:'Synthetic authorization fixture only',revision,mandate_version:1,checks,evidence_ids:['activation-evidence']}});await seedCoverage(db);}
async function engine(){let s=await readFile(new URL('../lib/activation.js',import.meta.url),'utf8');s=s.replace(/from '(.+?)'/g,(_,path)=>`from '${new URL(path,new URL('../lib/activation.js',import.meta.url)).href}'`);s+='\nexport {activateVerified as testEngine};';return (await import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'))).testEngine;}
test('one atomic prospective activation contains matching benchmark, cash and active control; retry has no requests',async t=>{
 const {db}=temporaryDatabase(t);await setup(db);const run=await engine();const f=brokerFixture();const before=Date.now();
 const opened=await run(db,env,{idempotency_key:'activation-attempt-001'},actor,f.fetcher);
 assert.equal(opened.kind,'experiment_opened');assert.equal(opened.created_at,opened.payload.started_at);assert.equal(opened.payload.control.started_at,opened.payload.started_at);assert.equal(opened.payload.benchmark.started_at,opened.payload.started_at);assert.ok(Date.parse(opened.created_at)>=before);assert.equal(opened.payload.initial_cash_cents,10000000);
 const count=f.calls.length;assert.deepEqual(await run(db,env,{idempotency_key:'activation-attempt-001'},actor,f.fetcher),opened);assert.equal(f.calls.length,count);assert.ok(f.calls.every(c=>c.method==='GET'));
 assert.equal((await readLedger(db)).status,'ready');assert.equal((await listEvents(db,new Date().toISOString())).filter(e=>e.kind==='experiment_control').length,0);
 await assert.rejects(run(db,env,{idempotency_key:'different-activation'},actor,f.fetcher),/already started/);
});
test('concurrent activation cannot create a second inception',async t=>{
 const {db}=temporaryDatabase(t);await setup(db);const run=await engine();const f=brokerFixture();let contested=false;
 const fetcher=async(...args)=>{if(!contested){contested=true;await assert.rejects(run(db,env,{idempotency_key:'concurrent-activation'},actor,f.fetcher),/progress/);}return f.fetcher(...args);};
 await run(db,env,{idempotency_key:'first-activation-key'},actor,fetcher);assert.equal((await listEvents(db,new Date().toISOString())).filter(e=>e.kind==='experiment_opened').length,1);
});
test('lost lease or closed session leaves no partial opening/control',async t=>{
 for(const mode of ['lease','closed']){const {db}=temporaryDatabase(t);await setup(db);const run=await engine();const f=brokerFixture(mode==='closed'?{clock:{is_open:false}}:{});let stolen=false;
 const fetcher=async(...args)=>{const response=await f.fetcher(...args);if(mode==='lease'&&!stolen){stolen=true;db.sqlite.exec("UPDATE locks SET token='new-owner'");}return response;};
 await assert.rejects(run(db,env,{idempotency_key:'failed-activation'},actor,fetcher),/lease|Activation blocked/);const records=await listEvents(db,new Date().toISOString());assert.equal(records.filter(e=>['experiment_opened','experiment_control'].includes(e.kind)).length,0);}
});
test('missing coverage or source failure blocks activation without invented starting prices',async t=>{
 const {db}=temporaryDatabase(t);const run=await engine();const f=brokerFixture();await assert.rejects(run(db,env,{idempotency_key:'missing-proof-activation'},actor,f.fetcher),/evidence/);assert.equal(f.calls.length,0);
 await setup(db);await assert.rejects(run(db,env,{idempotency_key:'source-failed-activation'},actor,brokerFixture({failStatus:503}).fetcher),/HTTP 503/);assert.equal((await readLedger(db)).status,'not_started');
});
test('public activation gate rejects even fully populated synthetic release evidence',async t=>{
 const {db}=temporaryDatabase(t);await setup(db);let calls=0;await assert.rejects(activateExperiment(db,{...env,TRADING_ENABLED:'true'},{idempotency_key:'disabled-activation'},actor,async()=>{calls++;}),/hard-disabled/);assert.equal(calls,0);assert.equal((await readLedger(db)).status,'not_started');
});

test('staging requires actual named verification records and never opens the experiment',async t=>{
 const {db}=temporaryDatabase(t);const {stageReleaseAttestation}=await import('../lib/readiness.js');
 await assert.rejects(stageReleaseAttestation(db,env,{idempotency_key:'invalid-release-stage',kind:'release_verification',payload:{status:'approved',revision,mandate_version:1,evidence_ids:['missing']}},actor),/supporting evidence/);
 await setup(db);const records=await listEvents(db,new Date().toISOString());const verification=records.find(e=>e.kind==='release_verification');
 const missing={...verification.payload,checks:{...verification.payload.checks,nonzero_fill_settlement:'missing'}};
 await assert.rejects(stageReleaseAttestation(db,env,{idempotency_key:'incomplete-release-stage',kind:'release_verification',payload:missing},actor),/nonzero_fill_settlement/);
 const saved=await stageReleaseAttestation(db,env,{idempotency_key:'valid-fixture-stage',kind:'release_verification',payload:verification.payload},actor);assert.equal(saved.kind,'release_verification');assert.equal((await readLedger(db)).status,'not_started');
});
test('a queued activation insert cannot persist a backdated inception even with a valid lease',async t=>{
 const {db}=temporaryDatabase(t);const {appendLeased}=await import('../lib/store.js');await acquire(db,'execution','queue-fixture');
 const old=new Date(Date.now()-6000).toISOString();await assert.rejects(appendLeased(db,{id:'delayed-opening-001',kind:'experiment_opened',actor,payload:{started_at:old}},'execution','queue-fixture',old),/lease|journal/);
 assert.equal((await readLedger(db)).status,'not_started');await release(db,'execution','queue-fixture');
});
