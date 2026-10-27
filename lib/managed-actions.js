import {alpaca} from './alpaca.js';
import {managedInstrumentFor,assertPublicEvidenceURL} from './managed-instruments.js';
import {readCompleteHistory} from './history.js';
import {marketDate,normalizeAction,confirmedActions,notices,replayEconomicDefinitions,ACTION_KINDS} from './action-ledger.js';
import {policyVersionAt,policyForVersion} from './investment-policy.js';
import {canonical,hash,isoNow,AppError,getEvent,acquire,renew,release,appendLeased} from './store.js';

export const MANAGED_ACTION_KINDS=['managed_action_page','managed_action_fetch','managed_action_fetch_failed','managed_action_source','managed_action_review','managed_action_confirmed','managed_action_coverage','managed_coverage_review'];
const fail=message=>{throw new AppError(message,423);};
const symbolPattern=/^[A-Z][A-Z0-9.-]{0,9}$/;
const sortedSymbols=symbols=>{if(!Array.isArray(symbols)||!symbols.length||symbols.length>100||symbols.some(s=>typeof s!=='string'||!symbolPattern.test(s))||new Set(symbols).size!==symbols.length)fail('A bounded unique symbol scope is required');return [...symbols].sort();};
const find=(events,id,kind)=>events.find(e=>e.id===id&&e.kind===kind);
const current=(events,asOf)=>events.filter(e=>e.created_at<=asOf);
const text=(value,label)=>{if(typeof value!=='string'||!value.trim()||value.length>12000)fail('Actual '+label+' required');return value;};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const day=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('Valid process-date range required');return value;};
const stamp=value=>typeof value==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
const inScope=(event,symbols)=>!Array.isArray(event.payload.scope_symbols)||event.payload.scope_symbols.some(s=>symbols.includes(s));

/** Current relevant scope: held/proposed assets plus the unchanged SPY comparator. */
export function managedActionScope(portfolio,target){return sortedSymbols([...new Set(['SPY',...Object.keys(portfolio?.holdings||{}),...(target?[target]:[])])]);}
function historicalScope(events){return sortedSymbols([...new Set(['SPY',...events.filter(e=>e.kind==='ledger_fill').map(e=>e.payload.fill.symbol)])]);}
function validateSource(payload,events,now){
 if(!payload||!symbolPattern.test(payload.symbol||''))fail('Action source symbol required');
 const instrument=managedInstrumentFor(events,payload.symbol,now);if(!instrument)fail('Instrument identity must be approved before action evidence');
 assertPublicEvidenceURL(payload.url);
 if(!['issuer','regulatory_filing','exchange'].includes(payload.source_type)||!sha(payload.content_sha256)||!stamp(payload.observed_at)||Date.parse(payload.observed_at)>Date.parse(now)||Date.parse(now)-Date.parse(payload.observed_at)>30*86400000)fail('Actual primary-source provenance/hash and recent observation required');
 text(payload.publisher_name,'publisher');text(payload.excerpt,'source excerpt');text(payload.scope_description,'source scope and limitations');
 if(payload.instrument_id!==instrument.id)fail('Source must bind exact approved instrument identity');
 // A different document is allowed only as explicitly attributed evidence, never fetched by the server.
 return instrument;
}
export function managedNotices(events,scope){
 const symbols=sortedSymbols(scope),versions=new Map(),problems=[];
 for(const e of events.filter(e=>e.kind==='managed_action_page'&&inScope(e,symbols))){
  const groups=e.payload.response?.corporate_actions;
  if(!groups||typeof groups!=='object'||Array.isArray(groups)){problems.push('Malformed managed action receipt '+e.id);continue;}
  for(const [type,rows] of Object.entries(groups)){
   if(!Array.isArray(rows)){problems.push('Malformed managed action group '+type);continue;}
   for(const raw of rows){
    if(raw&&typeof raw.symbol==='string'&&!e.payload.scope_symbols?.includes(raw.symbol)){problems.push('Action receipt contains an unexpected symbol '+raw.symbol);continue;}
    if(raw&&typeof raw.symbol==='string'&&!symbols.includes(raw.symbol))continue;
    try{
     const terms=normalizeAction(type,raw,1,symbols),signature=canonical({type,raw});
     const prior=versions.get(terms.id);
     if(prior&&prior.signature!==signature)problems.push('Conflicting raw versions for action '+terms.id);
     else if(!prior)versions.set(terms.id,{terms,signature,raw_event_id:e.id});
    }catch(error){problems.push(error.message);}
   }
  }
 }
 return {versions,problems};
}
function review(events,id,kind,binding,manager,before=Infinity){
 const e=find(events,id,kind);if(!e||e.seq>=before||e.payload.status!=='approved'||e.payload.binding!==canonical(binding)||!e.payload.author||e.payload.author===manager)fail('Actual independent review of exact evidence required');
 if(events.some(r=>r.kind===kind&&r.payload.binding===canonical(binding)&&r.payload.status!=='approved'))fail('Evidence review rejected or unresolved');
 return e;
}
function actionBinding(events,input){
 const source=find(events,input.source_id,'managed_action_source');if(!source)fail('Actual source receipt required');
 validateSource(source.payload,events.filter(e=>e.seq<=source.seq),source.created_at);
 const {versions,problems}=managedNotices(events,[source.payload.symbol]);if(problems.length)fail(problems.join('; '));
 const n=versions.get(input.action_id);if(!n||n.raw_event_id!==input.raw_event_id||canonical(n.terms)!==canonical(source.payload.terms))fail('Exact broker receipt and corroborated economic terms required');
 return {action_id:input.action_id,raw_event_id:n.raw_event_id,raw_signature:n.signature,source_id:source.id,source_digest:source.digest,instrument_id:source.payload.instrument_id,terms:n.terms};
}
export function managedActionCandidate(events,input){const binding=actionBinding(events,input);return {binding:canonical(binding),binding_object:binding};}
// Read-only projection scopes legacy adverse facts without changing stored receipts or raw row signatures.
function scopedLegacy(events,scope){
 return events.filter(e=>!MANAGED_ACTION_KINDS.includes(e.kind)).flatMap(e=>{
  if(e.kind==='action_confirmed')return scope.includes(e.payload.terms?.symbol)?[e]:[];
  if(e.kind==='action_source')return scope.includes(e.payload.symbol)?[e]:[];
  if(e.kind!=='corporate_action_page')return [e];
  const queried=e.payload.query?.symbols?.split(',');
  if(queried&&!queried.some(s=>scope.includes(s)))return [];
  const groups=e.payload.response?.corporate_actions;if(!groups||typeof groups!=='object'||Array.isArray(groups))return [e];
  const filtered={};for(const [type,rows] of Object.entries(groups))filtered[type]=Array.isArray(rows)?rows.filter(raw=>!raw||typeof raw.symbol!=='string'||scope.includes(raw.symbol)||queried&&!queried.includes(raw.symbol)):rows;
  return [{...e,payload:{...e.payload,response:{...e.payload.response,corporate_actions:filtered}}}];
 });
}
function managedDefinitions(events,scope){
 const definitions=[],problems=[];
 const legacy=scopedLegacy(events,scope);
 // Evidence can be approved for a candidate configuration without admitting it.
 // Include every retained evidence version; confirmedActions still validates each
 // original confirmation against its own immutable configuration and reviews.
 // This is accounting reuse, not a change to the active trading universe.
 let version=policyVersionAt(legacy);
 for(const e of legacy.filter(e=>ACTION_KINDS.includes(e.kind))){
  const evidenceVersion=e.payload.configuration_version===undefined?1:e.payload.configuration_version;
  policyForVersion(evidenceVersion);version=Math.max(version,evidenceVersion);
 }
 const old=confirmedActions(legacy,version);problems.push(...old.problems);definitions.push(...old.definitions.filter(e=>scope.includes(e.payload.terms.symbol)));
 const ids=new Set(definitions.map(e=>e.payload.action_id));
 for(const e of events.filter(e=>e.kind==='managed_action_confirmed'&&scope.includes(e.payload.terms?.symbol))){
  try{
   const prior=events.filter(r=>r.seq<e.seq),binding=actionBinding(prior,e.payload);
   if(canonical(binding)!==e.payload.binding)fail('Managed confirmation binding changed');
   const checked=review(events,e.payload.review_id,'managed_action_review',binding,e.payload.author,e.seq);
   if(checked.seq<=Math.max(find(events,binding.source_id,'managed_action_source').seq,find(events,binding.raw_event_id,'managed_action_page').seq))fail('Action review predates its source evidence');
   if(ids.has(binding.action_id))fail('Duplicate shared economic definition');
   ids.add(binding.action_id);definitions.push({...e,payload:{...e.payload,terms:binding.terms}});
  }catch(error){problems.push(error.message);}
 }
 const {versions,problems:raw}=managedNotices(events,scope),legacyRaw=notices(legacy,version);problems.push(...raw,...legacyRaw.problems);
 for(const [id,n] of [...legacyRaw.versions,...versions]){const d=definitions.find(e=>e.payload.action_id===id);if(!d)problems.push('Unconfirmed action '+id);else if(canonical(d.payload.terms)!==canonical(n.terms)||d.payload.raw_signature!==n.signature)problems.push('Changed shared economic action '+id);}
 // Preserve later changed primary economic terms as adverse evidence, including past sold holdings.
 for(const source of events.filter(e=>['action_source','managed_action_source'].includes(e.kind)&&scope.includes(e.payload.symbol)&&e.payload.terms)){
  const d=definitions.find(e=>e.payload.action_id===source.payload.terms.id);if(d&&canonical(d.payload.terms)!==canonical(source.payload.terms))problems.push('Conflicting primary action terms '+source.payload.terms.id);
 }
 return {definitions,problems};
}
/** No second accounting implementation: managed evidence feeds the same exact replay loop. */
export function managedReplay(opening,events,asOf){
 events=current(events,asOf);const scope=historicalScope(events),checked=managedDefinitions(events,scope);
 return replayEconomicDefinitions(opening,events,asOf,checked.definitions,checked.problems);
}
function coverageBinding(events,input,now){
 const symbols=sortedSymbols(input.scope_symbols),fetch=find(events,input.fetch_id,'managed_action_fetch');
 if(!fetch||canonical(fetch.payload.scope_symbols)!==canonical(symbols)||fetch.payload.status!=='evidence_only')fail('Exact complete scoped acquisition required');
 const sourceIds=Array.isArray(input.source_ids)?[...input.source_ids].sort():[];
 if(!sourceIds.length||new Set(sourceIds).size!==sourceIds.length)fail('Distinct primary scan source receipts required');
 const sources=sourceIds.map(id=>find(events,id,'managed_action_source'));
 for(const s of sources){if(!s)fail('Missing scoped primary source');validateSource(s.payload,events,now);}
 if(symbols.some(symbol=>!sources.some(s=>s.payload.symbol===symbol)))fail('Primary evidence required for held, proposed and benchmark scope');
 const checked=managedDefinitions(events,symbols);if(checked.problems.length)fail(checked.problems.join('; '));
 const {versions}=managedNotices(events,symbols);
 return {policy:'managed-ordinary-actions-v1',scope_symbols:symbols,inventory:[...versions.values()].map(n=>({action_id:n.terms.id,signature:n.signature})).sort((a,b)=>a.action_id.localeCompare(b.action_id)),sources:sources.map(s=>({id:s.id,digest:s.digest,instrument_id:s.payload.instrument_id})),confirmations:checked.definitions.map(e=>({id:e.id,digest:e.digest})).sort((a,b)=>a.id.localeCompare(b.id))};
}
export function managedCoverageCandidate(events,input,now=isoNow()){const binding=coverageBinding(events,input,now);return {binding:canonical(binding),binding_object:binding,scope:'Current acquired inventory and observed primary evidence only, not universal absence or permission to trade.'};}
export function managedCoverage(events,asOf,scope){
 events=current(events,asOf);const symbols=sortedSymbols(scope),problems=[];
 const coverages=events.filter(e=>e.kind==='managed_action_coverage'&&symbols.every(s=>e.payload.scope_symbols?.includes(s)));
 const coverage=coverages.at(-1),p=coverage?.payload;
 try{
  if(!coverage||p.status!=='approved')fail('Reviewed managed source coverage required for held/proposed assets and SPY');
  if(!stamp(p.valid_until)||Date.parse(p.valid_until)<=Date.parse(asOf))fail('Primary source coverage review expired');
  const reviewedScope=sortedSymbols(p.scope_symbols);
  const fetch=events.filter(e=>e.kind==='managed_action_fetch'&&canonical(e.payload.scope_symbols)===canonical(reviewedScope)).at(-1);
  if(!fetch||marketDate(fetch.created_at)!==marketDate(asOf)||fetch.payload.query.data_quality!=='all'||fetch.payload.query.end<marketDate(asOf))fail('Current-day complete scoped broker action acquisition required');
  const opening=events.find(e=>e.kind==='experiment_opened');if(!opening||fetch.payload.query.start>marketDate(opening.created_at))fail('Scoped acquisition must cover the original inception onward');
  const pages=fetch.payload.pages?.map(id=>find(events,id,'managed_action_page'));
  if(!pages?.length||pages.some(e=>!e||e.seq>=fetch.seq||canonical(e.payload.scope_symbols)!==canonical(reviewedScope))||pages.at(-1).payload.response.next_page_token)fail('Incomplete scoped acquisition pages');
  if(events.some(e=>(e.kind==='managed_action_fetch_failed'&&inScope(e,reviewedScope)||e.kind==='corporate_action_fetch_failed'&&(!e.payload.query?.symbols||e.payload.query.symbols.split(',').some(s=>reviewedScope.includes(s))))&&e.seq>fetch.seq))fail('Later scoped action acquisition failed');
  const binding=coverageBinding(events,{scope_symbols:reviewedScope,fetch_id:fetch.id,source_ids:p.source_ids},asOf);
  if(p.binding!==canonical(binding))fail('Material action/source inventory changed; renewed review required');
  const r=review(events,p.review_id,'managed_coverage_review',binding,p.author,coverage.seq);
  const initial=find(events,p.fetch_id,'managed_action_fetch');if(!initial||r.seq<=initial.seq||p.source_ids.some(id=>find(events,id,'managed_action_source').seq>=r.seq))fail('Coverage review predates evidence');
  if(events.some(e=>e.kind==='managed_action_source'&&reviewedScope.includes(e.payload.symbol)&&e.seq>coverage.seq))fail('New primary evidence requires coverage review');
 }catch(error){problems.push(error.message);}
 return {ok:problems.length===0,problems,coverage_id:coverage?.id??null,scope_symbols:symbols};
}
export async function collectManagedActions(db,env,{idempotency_key,start,end,scope_symbols},actor,fetcher=fetch){
 day(start);day(end);if(start>end||Date.parse(end)-Date.parse(start)>370*86400000)fail('Process-date range must be ordered and bounded to370days');
 const symbols=sortedSymbols(scope_symbols);if(!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotency_key||''))fail('Stable acquisition key required');
 const token=crypto.randomUUID();await acquire(db,'execution',token);const pages=[];let query;
 try{
  const events=await readCompleteHistory(db);for(const symbol of symbols)if(!managedInstrumentFor(events,symbol,isoNow()))fail('Approved instrument required: '+symbol);
  query={start,end,symbols:symbols.join(','),data_quality:'all',limit:'1000',sort:'asc'};
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!=='managed_action_fetch'||canonical(existing.payload.query)!==canonical(query))fail('Acquisition idempotency mismatch');return existing;}
  const seen=new Set();let pageToken;
  for(let page=0;page<50;page++){
   await renew(db,'execution',token);const params=new URLSearchParams(query);if(pageToken)params.set('page_token',pageToken);
   const response=await alpaca(env,'/v1/corporate-actions?'+params,{data:true,fetcher});await renew(db,'execution',token);
   const receipt=await appendLeased(db,{id:'managed-action-page:'+(await hash({query,pageToken:pageToken??null,response,run:idempotency_key})).slice(0,48),kind:'managed_action_page',payload:{scope_symbols:symbols,query,page_token:pageToken??null,response},actor},'execution',token);pages.push(receipt.id);
   if(!response||!response.corporate_actions||typeof response.corporate_actions!=='object'||Array.isArray(response.corporate_actions)||Object.values(response.corporate_actions).some(rows=>!Array.isArray(rows)))fail('Malformed scoped action receipt preserved');
   const next=response.next_page_token;
   if(next===null||next===undefined||next==='')return await appendLeased(db,{id:idempotency_key,kind:'managed_action_fetch',payload:{scope_symbols:symbols,query,pages,status:'evidence_only',scope:'All returned categories; process dates are not universal ex-date completeness.'},actor},'execution',token);
   if(typeof next!=='string'||seen.has(next))fail('Scoped action pagination did not advance');seen.add(next);pageToken=next;
  }
  fail('Scoped action pagination bound exceeded');
 }catch(error){if(query){await renew(db,'execution',token);await appendLeased(db,{id:'managed-action-failure:'+(await hash({idempotency_key,pages,message:error.message})).slice(0,48),kind:'managed_action_fetch_failed',payload:{scope_symbols:symbols,query,pages,message:error.message},actor},'execution',token);}throw error;}
 finally{await release(db,'execution',token);}
}
/** Typed evidence and approvals; no arbitrary kind, cash mutation or broker writes. */
export async function recordManagedAction(db,{idempotency_key,kind,payload},actor){
 const allowed=['managed_action_source','managed_action_review','managed_coverage_review','managed_action_confirmed','managed_action_coverage'];
 if(!allowed.includes(kind)||!payload||JSON.stringify(payload).length>50000)fail('Bounded typed managed action evidence required');
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!==kind||existing.payload.request_hash!==await hash(payload))fail('Managed evidence idempotency mismatch');return existing;}
  const now=isoNow(),events=await readCompleteHistory(db,now);let result={...payload};
  if(kind==='managed_action_source')validateSource(payload,events,now);
  else if(['managed_action_review','managed_coverage_review'].includes(kind)){
   text(payload.author,'review author');text(payload.summary,'review rationale');if(!['approved','rejected'].includes(payload.status))fail('Explicit review outcome required');
   let binding;try{binding=JSON.parse(payload.binding);}catch{fail('Canonical review binding required');}if(canonical(binding)!==payload.binding)fail('Canonical review binding required');
   if(kind==='managed_action_review'){const expected=actionBinding(events,binding);if(canonical(expected)!==payload.binding)fail('Review differs from actual action evidence');}
   else {const fetch=events.filter(e=>e.kind==='managed_action_fetch'&&canonical(e.payload.scope_symbols)===canonical(binding.scope_symbols)).at(-1);const expected=coverageBinding(events,{scope_symbols:binding.scope_symbols,fetch_id:fetch?.id,source_ids:binding.sources?.map(s=>s.id)},now);if(canonical(expected)!==payload.binding)fail('Review differs from actual coverage evidence');}
  }else if(kind==='managed_action_confirmed'){
   text(payload.author,'confirming manager');const binding=actionBinding(events,payload);if(payload.binding!==canonical(binding))fail('Exact action candidate binding required');
   if(events.some(e=>['action_confirmed','managed_action_confirmed'].includes(e.kind)&&e.payload.action_id===binding.action_id))fail('Shared economic action already confirmed; reuse original');
   const r=review(events,payload.review_id,'managed_action_review',binding,payload.author);if(r.seq<=Math.max(find(events,binding.source_id,'managed_action_source').seq,find(events,binding.raw_event_id,'managed_action_page').seq))fail('Review predates evidence');result={...payload,...binding};
  }else{
   text(payload.author,'coverage manager');const binding=coverageBinding(events,payload,now);if(payload.binding!==canonical(binding)||payload.status!=='approved')fail('Exact coverage candidate required');
   if(!stamp(payload.valid_until)||Date.parse(payload.valid_until)<=Date.parse(now)||Date.parse(payload.valid_until)>Date.parse(now)+30*86400000)fail('Coverage expiry must be within30days; daily actual broker acquisition still required');
   review(events,payload.review_id,'managed_coverage_review',binding,payload.author);
   const candidate={id:idempotency_key,kind,payload:result,created_at:now,seq:Number.MAX_SAFE_INTEGER,actor};const check=managedCoverage([...events,candidate],now,payload.scope_symbols);if(!check.ok)fail(check.problems.join('; '));
  }
  result.request_hash=await hash(payload);await renew(db,'execution',token);return await appendLeased(db,{id:idempotency_key,kind,payload:result,actor},'execution',token,isoNow(),events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
