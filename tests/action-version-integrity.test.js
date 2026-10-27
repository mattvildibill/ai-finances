import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDatabase} from './helpers.js';
import {seedCoverage,seedAction} from './action-fixtures.js';
import {recordActionEvidence,confirmCorporateAction,actionEvents,coverageState} from '../lib/action-settlement.js';
import {replaySharedActions} from '../lib/action-ledger.js';
import {policyCanonical} from '../lib/investment-policy.js';
import {append,canonical,getEvent} from '../lib/store.js';
import {createBenchmark} from '../lib/finance.js';

const actor='synthetic:version-integrity';
const now=()=>new Date().toISOString();
const raw={id:'shared-spy-economic-action',symbol:'SPY',cusip:'fixture',rate:'0.25',special:false,foreign:false,ex_date:'2026-10-05',record_date:'2026-10-05',payable_date:'2026-10-09'};

test('review versions must match exact bindings; active v1 rejection cannot be hidden behind v2 tagging',async t=>{
 const {db}=temporaryDatabase(t),coverage=await seedCoverage(db);const {status,review_ids,...core}=coverage.payload;
 const original=await getEvent(db,coverage.id);
 for(const kind of ['coverage_review','action_review'])for(const status of ['approved','rejected']){
  const id='mismatched-'+kind+'-'+status;
  await assert.rejects(recordActionEvidence(db,{idempotency_key:id,kind,payload:{configuration_version:2,author:'independent',status,binding:canonical(core)}},actor),/configuration\/binding mismatch/);
  assert.equal(await getEvent(db,id),null);
 }
 const tagged={...core,configuration_version:2,configuration:policyCanonical(2)};
 await assert.rejects(recordActionEvidence(db,{idempotency_key:'reverse-mismatch',kind:'coverage_review',payload:{configuration_version:1,author:'independent',status:'rejected',binding:canonical(tagged)}},actor),/configuration\/binding mismatch/);
 assert.equal((await coverageState(db)).ok,true);
 await recordActionEvidence(db,{idempotency_key:'actual-v1-rejection',kind:'coverage_review',payload:{configuration_version:1,author:'independent',status:'rejected',binding:canonical(core)}},actor);
 assert.equal((await coverageState(db)).ok,false);assert.deepEqual(await getEvent(db,coverage.id),original);
});

test('shared action has one economic confirmation across versions; projected v2 replay preserves original identity',async t=>{
 const {db}=temporaryDatabase(t),start='2026-10-01T14:00:00.000Z';
 const opening=await append(db,{id:'integrity-opening',kind:'experiment_opened',actor,payload:{started_at:start,initial_cash_cents:10000000,benchmark:createBenchmark({started_at:start,observed_at:start,market_time:start,price_cents:50000})}},start);
 const saved=await seedAction(db,raw),before=await actionEvents(db);
 await assert.rejects(confirmCorporateAction(db,{...saved.input,configuration_version:2},'new-manager'),/already confirmed under another configuration/);
 assert.deepEqual(await actionEvents(db),before);
 assert.deepEqual(await confirmCorporateAction(db,saved.input,'action-manager'),saved.confirmation);
 const legacy=replaySharedActions(opening,before,now()),projected=replaySharedActions(opening,before,now(),2);
 assert.deepEqual(projected,legacy);assert.deepEqual(projected.problems,[]);assert.equal(projected.pending.length,2);
 assert.ok(projected.pending.every(e=>e.payload.confirmation_id===saved.confirmation.id));
 assert.equal(projected.economic.benchmark.income_cents,5000);
 // Even if unsupported historical duplicate data exists, projection must reveal it before admission.
 await append(db,{id:'historical-duplicate-fixture',kind:'action_confirmed',actor,payload:saved.confirmation.payload});
 const invalid=replaySharedActions(opening,await actionEvents(db),now(),2);
 assert.ok(invalid.problems.some(p=>/Same-day actions|Duplicate economic/.test(p)));
 assert.deepEqual(await getEvent(db,saved.confirmation.id),saved.confirmation);
});
