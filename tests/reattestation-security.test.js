import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseChecks} from '../lib/universe-release.js';
import {VALIDATION_CHECKS} from '../lib/validation-policy.js';
const revision='e'.repeat(40);
function fixture(){const events=VALIDATION_CHECKS.map((check,i)=>({id:'check-'+check,kind:'verification',seq:i+1,digest:'digest-'+check,payload:{check,revision,outcome:'passed',summary:'Synthetic reviewed release evidence'}}));return {events,checks:Object.fromEntries(events.map(e=>[e.payload.check,e.id]))};}
test('independent re-attestation check audit: every exact-release prerequisite and later adverse outcome enforced',()=>{
 const {events,checks}=fixture();assert.equal(releaseChecks(events,checks,revision).length,8);
 for(const check of VALIDATION_CHECKS){
  const r=events.find(e=>e.payload.check===check);
  for(const patch of [{outcome:'failed'},{outcome:'pending'},{revision:'f'.repeat(40)},{summary:''},{check:'other'}]){const changed=structuredClone(events);Object.assign(changed.find(e=>e.id===r.id).payload,patch);assert.throws(()=>releaseChecks(changed,checks,revision));}
  assert.throws(()=>releaseChecks(events,{...checks,[check]:'missing'},revision));
  for(const outcome of ['failed','pending'])assert.throws(()=>releaseChecks([...events,{id:'later-'+check,kind:'verification',seq:100,payload:{check,revision,outcome}}],checks,revision),/Superseding/);
 }
 assert.throws(()=>releaseChecks(events,checks,revision,8));
 const unrelated=[...events,{kind:'verification',seq:100,payload:{check:'independent_code_review',revision:'f'.repeat(40),outcome:'failed'}}];
 assert.equal(releaseChecks(unrelated,checks,revision).length,8,'Unrelated release evidence is not falsely labeled a failure for this revision');
});
