import {readCompleteHistory} from './history.js';
import {verifyReleaseAttestation} from './universe-release.js';
import {replaySharedActions} from './action-ledger.js';
import {pilotOutcomeBinding} from './rollout-policy.js';
import {readLedger} from './reconciliation.js';
import {brokerCashMatches,brokerBasisMatches} from './finance.js';
import {policyForVersion,policyCanonical,policyDigest,policyVersionAt,symbolsForVersion,policyParentVersion,candidatePolicyVersions} from './investment-policy.js';
import {AppError,canonical,hash,isoNow,acquire,renew,release,appendLeased,getEvent} from './store.js';
import {observe,assertEligibleAsset} from './alpaca.js';
import {actionCoverage} from './action-ledger.js';
const fail=m=>{throw new AppError(m,423);};
const fresh=(t,now)=>typeof t==='string'&&Number.isFinite(Date.parse(t))&&Date.parse(now)-Date.parse(t)>=-5000&&Date.parse(now)-Date.parse(t)<=120000;
export async function admissionEvents(db,asOf=isoNow()){
 return readCompleteHistory(db,asOf);
}
const find=(events,id,kind)=>events.find(e=>e.id===id&&e.kind===kind);
function admissionBindingVersion(input){const version=input.admission_binding_version===undefined?1:input.admission_binding_version;if(![1,2].includes(version))fail('Unsupported admission binding version');return version;}
function releaseRevision(revision){if(typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))fail('Exact reviewed release revision required');}
/** Explicit candidate-only GET acquisition. Does not create an active market snapshot. */
export async function inspectAdmission(db,env,{idempotency_key,configuration_version},actor,fetcher=fetch){
 try{policyForVersion(configuration_version);if(configuration_version===undefined||configuration_version===1)throw new Error();}catch{fail('Only a declared candidate configuration may be inspected');}
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!=='universe_observation'||existing.payload.configuration_version!==configuration_version)fail('Admission observation idempotency mismatch');return existing;}
  const events=await admissionEvents(db);if(policyParentVersion(configuration_version)!==policyVersionAt(events))fail('Candidate must follow the active configuration');
  const request=async(...args)=>{await renew(db,'execution',token);if(args[1]?.method!=='GET')fail('Admission inspection is GET-only');const r=await fetcher(...args);await renew(db,'execution',token);return r;};
  const observation=await observe(env,request,configuration_version);
  return await appendLeased(db,{id:idempotency_key,kind:'universe_observation',payload:observation,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
function decisionChain(events,id,version,revision,configuration_hash,observation_id,coverage_id,bindingVersion=1){
 const d=find(events,id,'decision'),p=d?.payload,r=find(events,p?.research_id,'research'),c=find(events,p?.challenge_id,'challenge');
 if(!d||!r||!c||c.payload.research_id!==r.id||r.seq>=c.seq||c.seq>=d.seq||p.action!=='hold'||p.size!==0||p.role!=='portfolio_manager'||r.payload.role!=='researcher'||c.payload.role!=='challenger'||!p.challenge_response?.trim())fail('Admission requires an actual independent research/challenge/manager hold chain');
 const authors=[r.payload.author,c.payload.author,p.author];if(authors.some(a=>typeof a!=='string'||!a.trim())||new Set(authors).size!==3)fail('Admission chain authors must be distinct');
 for(const e of [r,c,d])if(e.payload.configuration_version!==version||e.payload.configuration_hash!==configuration_hash||e.payload.revision!==revision||e.payload.observation_id!==observation_id||e.payload.coverage_id!==coverage_id)fail('Admission chain must bind exact candidate evidence and release');
 const additions=policyForVersion(version).instruments.filter(i=>!symbolsForVersion(policyParentVersion(version)).includes(i.symbol));
 const approvedSymbols=Array.isArray(p.admission_symbols)?p.admission_symbols:[p.symbol];
 if(p.admission_approval!==true||(bindingVersion===1?p.symbol!=='IJR':canonical([...approvedSymbols].sort())!==canonical(additions.map(i=>i.symbol).sort()))||typeof p.authorization_reference!=='string'||!p.authorization_reference.trim())fail('Manager must explicitly approve this concrete admission');
 for(const instrument of additions){const treatment=bindingVersion===1?p.fund_treatment:p.instrument_treatments?.[instrument.symbol]??(additions.length===1?p.fund_treatment:null);
 const classification=instrument.instrument_type==='stock'?'ordinary_us_equity':'unleveraged_noninverse_diversified_equity_etf';
 if(!treatment||treatment.classification!==classification||treatment.account_permissions_unchanged!==true||typeof treatment.incidental_instruments_assessment!=='string'||!treatment.incidental_instruments_assessment.trim())fail('Explicit fund-treatment interpretation and unchanged account permissions required');}
 if(events.some(e=>e.kind==='revision'&&[r.id,c.id,d.id].includes(e.payload.supersedes)))fail('Admission decision chain revised; fresh approval required');
 return {d,r,c};
}
export async function admissionBinding(events,input,revision,now=isoNow(),requireFresh=true){
 releaseRevision(revision);const bindingVersion=admissionBindingVersion(input),configuration_version=bindingVersion===1?2:input.configuration_version;policyForVersion(configuration_version);
 if(bindingVersion===2&&(!Number.isInteger(configuration_version)||!policyParentVersion(configuration_version)))fail('Declared successor configuration required');
 const from_version=policyParentVersion(configuration_version),configuration_hash=await policyDigest(configuration_version);
 const observation=find(events,input.observation_id,'universe_observation'),coverage=find(events,input.coverage_id,'action_coverage');
 if(!observation||observation.payload.configuration_version!==configuration_version||observation.payload.configuration_hash!==configuration_hash)fail('Actual exact-configuration candidate observation required');
 if(!coverage||coverage.payload.configuration_version!==configuration_version)fail('Explicit expanded-universe coverage required');
 const chain=decisionChain(events,input.decision_id,configuration_version,revision,configuration_hash,observation.id,coverage.id,bindingVersion);
 if(chain.r.seq<=Math.max(observation.seq,coverage.seq))fail('Admission evidence must precede authored review');
 if(bindingVersion===2){
  for(const e of [chain.r,chain.c,chain.d])if(e.payload.admission_binding_version!==2)fail('Governance chain must explicitly use admission binding version2');
  if(policyVersionAt(events.filter(e=>e.seq<observation.seq),observation.created_at)!==from_version)fail('Governance observation predates the active predecessor configuration');
  governanceIdentities(observation);
 }
 if(requireFresh&&bindingVersion===1){
  if(!fresh(observation.created_at,now)||!fresh(observation.payload.clock?.timestamp,now))fail('Fresh candidate account and clock observation required');
  for(const symbol of symbolsForVersion(2)){
   const a=observation.payload.asset_metadata?.[symbol],q=observation.payload.quotes?.[symbol];assertEligibleAsset(a,symbol,2);
   if(!fresh(a.retrieved_at,now)||a.source_url!=='https://paper-api.alpaca.markets/v2/assets/'+symbol||!fresh(q?.market_data_at,now)||!(q?.price>0)||q.feed!=='iex')fail('Fresh actual eligibility and IEX quote required for '+symbol);
  }
  if(observation.payload.open_orders?.length!==0)fail('Admission cannot proceed with open orders');
  }
 if(requireFresh){const check=actionCoverage(events,now,configuration_version);if(!check.ok||check.coverage_id!==coverage.id)fail('Current expanded coverage failed: '+check.problems.join('; '));}
 const refs=[observation,coverage,chain.r,chain.c,chain.d].map(e=>({id:e.id,kind:e.kind,digest:e.digest}));
 return {...(bindingVersion===2?{admission_binding_version:2,governance_identities:governanceIdentities(observation),previous_amendment_id:events.filter(e=>e.kind==='mandate_amendment'&&e.seq<observation.seq).at(-1)?.id??null,...(chain.d.payload.instrument_treatments?{instrument_treatments:chain.d.payload.instrument_treatments}:{})}:{}),from_version,configuration_version,mandate_version:policyForVersion(configuration_version).mandate_version,configuration:policyCanonical(configuration_version),configuration_hash,revision,decision_id:chain.d.id,observation_id:observation.id,coverage_id:coverage.id,manager:chain.d.payload.author,authorization_reference:chain.d.payload.authorization_reference,...(bindingVersion===1||chain.d.payload.fund_treatment!==undefined?{fund_treatment:chain.d.payload.fund_treatment}:{}),records:refs};
}
/** Governance retains actual immutable identity/eligibility at observation time; quotes do not expire review. */
function governanceIdentities(observation){
 const at=observation.created_at,p=observation.payload;
 if(!fresh(p.clock?.timestamp,at))fail('Governance observation must have an actual contemporaneous clock');
 return Object.fromEntries(symbolsForVersion(p.configuration_version).map(symbol=>{
  const a=p.asset_metadata?.[symbol];assertEligibleAsset(a,symbol,p.configuration_version);
  if(typeof a.id!=='string'||!a.id.trim()||a.source_url!=='https://paper-api.alpaca.markets/v2/assets/'+symbol||!fresh(a.retrieved_at,at))fail('Actual contemporaneous governance asset identity required for '+symbol);
  return [symbol,{id:a.id,symbol:a.symbol,class:a.class,exchange:a.exchange,status:a.status,tradable:a.tradable,source_url:a.source_url}];
 }));
}
function finalObservation(events,binding,payload,now){
 if(binding.admission_binding_version!==2)return find(events,binding.observation_id,'universe_observation');
 const final=find(events,payload.final_observation_id,'universe_observation');
 if(!final||final.id===binding.observation_id||final!==events.filter(e=>e.kind==='universe_observation').at(-1)||payload.review_ids.some(id=>find(events,id,'verification').seq>=final.seq))fail('New final observation must follow all governance reviews');
 if(final.payload.configuration_version!==binding.configuration_version||final.payload.configuration_hash!==binding.configuration_hash||canonical(governanceIdentities(final))!==canonical(binding.governance_identities))fail('Final observation differs from approved asset identity/configuration');
 const p=final.payload;
 if(!fresh(final.created_at,now)||!fresh(p.clock?.timestamp,now))fail('Fresh final account and clock observation required');
 for(const symbol of symbolsForVersion(binding.configuration_version)){
  const a=p.asset_metadata?.[symbol],q=p.quotes?.[symbol];
  if(!fresh(a.retrieved_at,now)||!fresh(q?.market_data_at,now)||typeof q?.price!=='number'||!Number.isFinite(q.price)||q.price<=0||q.feed!=='iex')fail('Fresh final actual eligibility and IEX trade required for '+symbol);
 }
 if(p.open_orders?.length!==0)fail('Final observation contains open orders');
 return final;
}
function reviewsValid(events,binding,review_ids,before=Infinity){
 const text=canonical(binding);if(!Array.isArray(review_ids)||review_ids.length!==2||new Set(review_ids).size!==2)fail('Two exact independent admission reviews required');
 const authors=new Set([binding.manager]);
 for(const id of review_ids){const r=find(events,id,'verification');if(!r||r.seq>=before||r.seq<=find(events,binding.decision_id,'decision').seq||r.payload.check!=='universe_admission_review'||r.payload.outcome!=='passed'||r.payload.revision!==binding.revision||r.payload.binding!==text||typeof r.payload.author!=='string'||!r.payload.author.trim()||authors.has(r.payload.author)||!r.payload.summary?.trim())fail('Admission review does not approve exact binding');authors.add(r.payload.author);}
 if(events.some(e=>e.kind==='verification'&&e.payload.check==='universe_admission_review'&&e.payload.binding===text&&e.payload.outcome!=='passed'))fail('Admission review failed or remains unresolved');
}
export async function originalAdmissionAuthorization(events,now=isoNow()){
 const version=policyVersionAt(events,now);if(version===1)return {configuration_version:1,amendment_id:null};
 let result;
 for(const amendment of events.filter(e=>e.kind==='mandate_amendment'&&e.created_at<=now)){
  const binding=await admissionBinding(events,amendment.payload,amendment.payload.revision,now,false);
  if(canonical(binding)!==amendment.payload.binding||amendment.payload.configuration_hash!==binding.configuration_hash)fail('Admission no longer matches its exact release/evidence');
  reviewsValid(events,binding,amendment.payload.review_ids,amendment.seq);
  if(binding.admission_binding_version===2){const final=finalObservation(events.filter(e=>e.seq<amendment.seq),binding,amendment.payload,amendment.created_at);if(final.digest!==amendment.payload.final_observation_digest)fail('Final admission observation receipt changed');}
  result={configuration_version:binding.configuration_version,configuration_hash:binding.configuration_hash,amendment_id:amendment.id,amendment};
 }
 return result;
}
export async function admissionAuthorization(events,revision,now=isoNow()){
 const result=await originalAdmissionAuthorization(events,now);if(result.configuration_version===1)return result;
 const current=events.filter(e=>e.kind==='universe_release_attestation'&&e.payload.binding_object?.amendment_id===result.amendment_id).at(-1);
 if(!current&&revision===result.amendment.payload.revision)return {...result,release_attestation_id:null};
 const release_attestation_id=await verifyReleaseAttestation(events,current,revision);
 return {...result,release_attestation_id};
}
export async function admissionCandidate(db,env,input){const events=await admissionEvents(db);const binding=await admissionBinding(events,input,env.RELEASE_REVISION);if(policyVersionAt(events)!==binding.from_version)fail('Candidate transition already recorded or predecessor differs');return {binding:canonical(binding),binding_sha256:await hash(binding),configuration_version:binding.configuration_version,scope:'Evidence candidate only; no admission or order authorization'};}
export async function stageAdmission(db,env,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  if(!payload||typeof payload!=='object'||JSON.stringify(payload).length>50000)fail('Bounded admission payload required');
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!=='mandate_amendment'||existing.payload.request_hash!==await hash(payload))fail('Admission idempotency mismatch');return existing;}
  const now=isoNow(),events=await admissionEvents(db,now);
  const binding=await admissionBinding(events,payload,env.RELEASE_REVISION,now);
  if(policyVersionAt(events,now)!==binding.from_version)fail('Prospective candidate transition already recorded or predecessor differs');
  if(binding.from_version>1)await admissionAuthorization(events,env.RELEASE_REVISION,now);
  if(payload.binding!==canonical(binding)||payload.status!=='approved')fail('Exact reviewed admission binding required');reviewsValid(events,binding,payload.review_ids);
  const recon=events.filter(e=>e.kind==='reconciliation').at(-1);
  if(!recon||!fresh(recon.created_at,now)||recon.payload.status!=='reconciled'||recon.payload.ledger_status!=='ready'||recon.payload.problems?.length)fail('Admission follows actual inception and fresh successful reconciliation');
  const pilot=events.find(e=>e.kind==='order_intent'&&e.payload.validation_protocol_id);
  const pilotReconciled=events.filter(e=>e.kind==='reconciliation').some(e=>{try{pilotOutcomeBinding(events,{pilot_intent_id:pilot?.id,reconciliation_id:e.id});return true;}catch{return false;}});
  if(!pilotReconciled)fail('Actual completed one-share pilot proof required before universe admission');
  const final=finalObservation(events,binding,payload,now);
  if(binding.admission_binding_version===2&&recon.seq<=final.seq)fail('Fresh successful reconciliation must follow the final observation');
  const ledger=await readLedger(db,now),observation=final.payload;
  const projected=replaySharedActions(events.find(e=>e.kind==='experiment_opened'),events,now,binding.configuration_version);
  if(projected.problems.length||projected.pending.length)fail('Projected expanded replay requires reconciliation: '+projected.problems.join('; '));
  if(canonical(projected.portfolio)!==canonical(ledger.portfolio)||canonical(projected.benchmark)!==canonical(ledger.benchmark))fail('Projected expanded replay changes existing accounting');
  if(ledger.status!=='ready'||!brokerCashMatches(ledger.portfolio,observation.account.cash_text??observation.account.cash))fail('Admission account differs from official ledger');
  const positions=observation.positions,holdings=ledger.portfolio.holdings;
  if(!Array.isArray(positions)||positions.length!==Object.keys(holdings).length||new Set(positions.map(p=>p.symbol)).size!==positions.length||positions.some(p=>!holdings[p.symbol]||p.quantity!==holdings[p.symbol].quantity||!brokerBasisMatches(holdings[p.symbol],p.cost_basis_text??p.cost_basis)))fail('Admission positions differ from official ledger');
  if(events.some(e=>e.kind==='order_intent'&&!events.some(c=>c.kind==='order_closed'&&c.payload.intent_id===e.id)))fail('Unresolved intents block admission');
  if(events.some(e=>e.seq>recon.seq&&['snapshot','ledger_fill','broker_activity','broker_order','order_intent','order_closure_conflict','refresh_failed'].includes(e.kind)))fail('New account evidence requires reconciliation');
  await renew(db,'execution',token);
  await admissionBinding(events,payload,env.RELEASE_REVISION,isoNow());
  const effective_at=isoNow();
  finalObservation(events,binding,payload,effective_at);
  if(!fresh(recon.created_at,effective_at)||!fresh(final.created_at,effective_at))fail('Admission evidence expired before durable append');
  const times=[recon.created_at,final.created_at,observation.clock.timestamp,...symbolsForVersion(binding.configuration_version).flatMap(symbol=>[observation.asset_metadata[symbol].retrieved_at,observation.quotes[symbol].market_data_at])];
  const submission_valid_until=new Date(Math.min(...times.map(t=>Date.parse(t)+120000))).toISOString();
  const record={...binding,...(binding.admission_binding_version===2?{final_observation_id:final.id,final_observation_digest:final.digest}:{}),submission_valid_until,status:'approved',binding:canonical(binding),review_ids:payload.review_ids,request_hash:await hash(payload),effective_at};
  return await appendLeased(db,{id:idempotency_key,kind:'mandate_amendment',payload:record,actor},'execution',token,effective_at,events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
export async function admissionStatus(db,env){const events=await admissionEvents(db),version=policyVersionAt(events);let authorization;try{authorization=await admissionAuthorization(events,env.RELEASE_REVISION);}catch(e){authorization={blocked:e.message};}return {active_configuration:version,active_symbols:symbolsForVersion(version),candidate_configurations:candidatePolicyVersions(version).map(v=>policyForVersion(v)),authorization,trading_permitted:false};}
