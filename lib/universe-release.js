import {admissionEvents,admissionBinding,originalAdmissionAuthorization} from './universe-admission.js';
import {policyVersionAt,policyDigest} from './investment-policy.js';
import {VALIDATION_CHECKS} from './validation-policy.js';
import {canonical,hash,isoNow,acquire,renew,release,appendLeased,getEvent,AppError} from './store.js';
const fail=m=>{throw new AppError(m,423);};
const find=(events,id)=>events.find(e=>e.id===id);
export function releaseChecks(events,checks,revision,before=Infinity){
 const refs=[];
 for(const check of VALIDATION_CHECKS){const r=find(events,checks?.[check]);
  if(!r||r.kind!=='verification'||r.seq>=before||r.payload.check!==check||r.payload.revision!==revision||r.payload.outcome!=='passed'||!r.payload.summary?.trim())fail('Measured re-attestation release check required: '+check);
  if(events.some(e=>e.kind==='verification'&&e.seq>r.seq&&e.payload.check===check&&e.payload.revision===revision&&e.payload.outcome!=='passed'))fail('Superseding release check blocks re-attestation: '+check);
  refs.push({id:r.id,digest:r.digest,check});
 }
 return refs;
}
export async function releaseBinding(events,input,revision,before=Infinity){
 if(policyVersionAt(events)!==2||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))fail('Existing admission and exact reviewed release required');
 await originalAdmissionAuthorization(events);
 const amendment=events.find(e=>e.kind==='mandate_amendment');
 const original=await admissionBinding(events,amendment.payload,amendment.payload.revision,isoNow(),false);
 if(canonical(original)!==amendment.payload.binding)fail('Original admission binding changed');
 const history=events.filter(e=>e.kind==='universe_release_attestation'&&e.seq<before);
 for(const old of history){reviews(events,old.payload,old.seq);if(events.some(e=>e.kind==='revision'&&[old.id,...old.payload.review_ids].includes(e.payload.supersedes)))fail('Prior re-attestation withdrawn or revised');}
 const prior=history.at(-1);
 if(revision===amendment.payload.revision||events.some(e=>e.kind==='universe_release_attestation'&&e.seq<before&&e.payload.revision===revision))fail('Re-attestation requires a new release, not a downgrade or duplicate');
 const checks=releaseChecks(events,input.checks,revision,before);
 return {amendment_id:amendment.id,amendment_digest:amendment.digest,configuration_version:2,configuration_hash:await policyDigest(2),original_revision:amendment.payload.revision,revision,previous_id:prior?.id??amendment.id,checks};
}
function reviews(events,p,before=Infinity){
 if(!Array.isArray(p.review_ids)||p.review_ids.length!==2||new Set(p.review_ids).size!==2||typeof p.author!=='string'||!p.author.trim())fail('Two independent re-attestation reviews and manager author required');
 const authors=new Set([p.author]);
 for(const id of p.review_ids){const r=find(events,id);if(!r||r.kind!=='verification'||r.seq>=before||r.seq<=Math.max(...p.binding_object.checks.map(c=>find(events,c.id).seq))||r.payload.check!=='universe_release_review'||r.payload.outcome!=='passed'||r.payload.revision!==p.revision||r.payload.binding!==p.binding||!r.payload.summary?.trim()||typeof r.payload.author!=='string'||!r.payload.author.trim()||authors.has(r.payload.author))fail('Independent exact release re-attestation review required');authors.add(r.payload.author);}
 if(events.some(e=>e.kind==='verification'&&e.payload.check==='universe_release_review'&&e.payload.binding===p.binding&&e.payload.outcome!=='passed'))fail('Re-attestation review failed or pending');
}
export async function verifyReleaseAttestation(events,record,revision){
 const p=record?.payload;if(!p||p.status!=='approved'||p.revision!==revision)fail('Current exact release re-attestation required');
 const binding=await releaseBinding(events,p,revision,record.seq);
 if(p.binding!==canonical(binding)||canonical(p.binding_object)!==canonical(binding))fail('Re-attestation configuration or history differs');
 reviews(events,p,record.seq);
 const protectedIds=[record.id,...p.review_ids,...binding.checks.map(c=>c.id)];
 if(events.some(e=>e.kind==='revision'&&protectedIds.includes(e.payload.supersedes)))fail('Re-attestation evidence revised');
 return record.id;
}
export async function releaseCandidate(db,env,input){
 const events=await admissionEvents(db),binding=await releaseBinding(events,input,env.RELEASE_REVISION);
 return {binding:canonical(binding),binding_sha256:await hash(binding),scope:'Unchanged admitted configuration; no rollout or order authority'};
}
export async function stageReleaseAttestation(db,env,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  if(!payload||JSON.stringify(payload).length>50000)fail('Bounded re-attestation payload required');
  const old=await getEvent(db,idempotency_key);if(old){if(old.kind!=='universe_release_attestation'||old.payload.request_hash!==await hash(payload))fail('Re-attestation idempotency mismatch');return old;}
  const events=await admissionEvents(db),binding=await releaseBinding(events,payload,env.RELEASE_REVISION);
  if(payload.binding!==canonical(binding)||payload.status!=='approved')fail('Exact release re-attestation binding required');
  const record={...payload,revision:env.RELEASE_REVISION,binding_object:binding,request_hash:await hash(payload)};
  reviews(events,record);await renew(db,'execution',token);
  return await appendLeased(db,{id:idempotency_key,kind:'universe_release_attestation',payload:record,actor},'execution',token,isoNow(),events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
