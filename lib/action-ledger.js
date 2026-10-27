import {PERMITTED_SYMBOL_QUERY} from './investment-policy.js';
import { approvedPrimaryActionSource } from './issuer-source-policy.js';
import { initialPortfolio, applyFill, MANDATE, toNanoPortfolio } from './finance.js';
import { exactWholeFillCents, decimalUnits, wholeFillNanos, nanosToCents } from './precision.js';
import { canonical } from './store.js';
export const ACTION_KINDS=['corporate_action_page','corporate_action_fetch','corporate_action_fetch_failed','action_source','action_review','action_confirmed','action_entitlement','action_payment','action_split','action_coverage','coverage_review'];
export const marketDate = at => new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const date = x => {if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString().slice(0,10)!==x)throw new Error('Invalid authoritative action date');return x;};
const whole = x => {if(!Number.isSafeInteger(x)||x<0)throw new Error('Unsupported fractional or unsafe action quantity');return x;};
const add = (a,b) => {const n=a+b;if(!Number.isSafeInteger(n)||n<0)throw new Error('Unsafe economic amount');return n;};
export function normalizeAction(type,raw){
 const cusip=raw?.cusip||(raw?.old_cusip&&raw.old_cusip===raw.new_cusip?raw.old_cusip:null);
 if(!raw||typeof raw.id!=='string'||!raw.id||!MANDATE.universe.includes(raw.symbol)||typeof cusip!=='string'||!cusip)throw new Error('Missing action identity or unsupported symbol');
 const t={id:raw.id,type,symbol:raw.symbol,cusip,ex_date:date(raw.ex_date),record_date:raw.record_date?date(raw.record_date):null,currency:'USD'};
 if(type==='cash_dividends'){
  if(raw.special!==false||raw.foreign!==false||raw.due_bill_on_date||raw.due_bill_off_date)throw new Error('Only verified ordinary domestic cash dividends without due bills are supported');
  t.payable_date=date(raw.payable_date);if(t.payable_date<t.ex_date)throw new Error('Payment precedes entitlement');
  t.rate=String(raw.rate);if(decimalUnits(t.rate,9,'Distribution rate')<=0n)throw new Error('Distribution rate must be positive');
 }else if(type==='forward_splits'||type==='reverse_splits'){
  if(raw.due_bill_redemption_date||((raw.old_cusip||raw.new_cusip)&&(raw.old_cusip!==cusip||raw.new_cusip!==cusip)))throw new Error('Split identity changes or due bills require explicit reconciliation');
  t.new_rate=String(raw.new_rate);t.old_rate=String(raw.old_rate);
  const n=decimalUnits(t.new_rate,9),d=decimalUnits(t.old_rate,9);
  if(n<=0n||d<=0n)throw new Error('Split ratio must be positive');
  if(type==='forward_splits'?n<=d:n>=d)throw new Error('Split ratio direction differs from the action type');
 }else throw new Error('Unsupported corporate action type: '+type);
 return t;
}
export function notices(events){
 const versions=new Map();const problems=[];
 for(const event of events.filter(e=>e.kind==='corporate_action_page')){
  const groups=event.payload.response?.corporate_actions;
  if(!groups||typeof groups!=='object'||Array.isArray(groups)){problems.push('Malformed action receipt '+event.id);continue;}
  for(const [type,rows] of Object.entries(groups)){
   if(!Array.isArray(rows)){problems.push('Malformed action group '+type);continue;}
   for(const raw of rows){
    try{
     const terms=normalizeAction(type,raw);const signature=canonical({type,raw});
     const previous=versions.get(terms.id);
     if(previous&&previous.signature!==signature)problems.push('Conflicting raw versions for action '+terms.id);
     else if(!previous)versions.set(terms.id,{terms,signature,raw_event_id:event.id});
    }catch(error){problems.push(error.message);}
   }
  }
 }
 return {versions,problems};
}
/** Confirmation binds raw version, issuer evidence, canonical terms and two independent reviews. */
export function actionApproval(events,input,actor){
 const {versions,problems}=notices(events);if(problems.length)throw new Error(problems.join('; '));
 const notice=versions.get(input.action_id);if(!notice||notice.raw_event_id!==input.raw_event_id)throw new Error('Exact raw action receipt required');
 const source=events.find(e=>e.id===input.source_id&&e.kind==='action_source');
 if(!source||!approvedPrimaryActionSource(notice.terms.symbol,source.payload.url)||typeof source.payload.excerpt!=='string'||!source.payload.excerpt.trim()||!(/^[a-f0-9]{64}$/.test(source.payload.content_sha256||''))||canonical(source.payload.terms)!==canonical(notice.terms))throw new Error('Corroborating approved primary receipt with matching terms and document hash required');
 const binding={action_id:input.action_id,raw_event_id:input.raw_event_id,raw_signature:notice.signature,source_id:source.id,source_digest:source.digest,terms:notice.terms};
 const signature=canonical(binding);
 if(events.some(e=>e.kind==='action_review'&&e.payload.binding===signature&&e.payload.status==='rejected'))throw new Error('An independent action review rejects these terms');
 if(!Array.isArray(input.review_ids)||input.review_ids.length!==2||new Set(input.review_ids).size!==2)throw new Error('Two independent reviews required');
 const authors=new Set([actor]);
 for(const id of input.review_ids){const r=events.find(e=>e.id===id&&e.kind==='action_review');if(!r||r.seq<=Math.max(source.seq,events.find(e=>e.id===input.raw_event_id).seq)||r.payload.status!=='approved'||r.payload.binding!==signature||typeof r.payload.author!=='string'||!r.payload.author.trim()||authors.has(r.payload.author))throw new Error('Independent review does not approve these exact action terms');authors.add(r.payload.author);}
 return {...binding,review_ids:input.review_ids,confirmed_by:actor};
}

function confirmedActions(events){
 const definitions=[];const problems=[];
 for(const c of events.filter(e=>e.kind==='action_confirmed')){
  try{const approved=actionApproval(events.filter(e=>e.seq<c.seq),c.payload,c.payload.confirmed_by);if(canonical(approved)!==canonical(c.payload))throw new Error('Confirmation terms changed');const {review_ids,confirmed_by,...binding}=approved;if(events.some(e=>e.kind==='action_review'&&e.payload.binding===canonical(binding)&&e.payload.status==='rejected'))throw new Error('Confirmed action approval was subsequently rejected');if(events.some(e=>e.kind==='action_source'&&e.payload.terms?.id===approved.action_id&&canonical(e.payload.terms)!==canonical(approved.terms)))throw new Error('Conflicting issuer action terms');definitions.push(c);}catch(error){problems.push(error.message);}
 }
 return {definitions,problems};
}
export function actionCoverage(events,asOf){
 const problems=[];const {versions,problems:rawProblems}=notices(events);problems.push(...rawProblems,...confirmedActions(events).problems);
 for(const [id] of versions)if(!events.some(e=>e.kind==='action_confirmed'&&e.payload.action_id===id))problems.push('Unconfirmed action '+id);
 const coverage=events.filter(e=>e.kind==='action_coverage').at(-1);
 const p=coverage?.payload;const day=marketDate(asOf);
 if(!p||p.date!==day||p.policy!=='ordinary-cash-and-whole-splits-v1'||p.status!=='approved')problems.push('Current reviewed action coverage required');
 else{
  const fetch=events.find(e=>e.id===p.fetch_id&&e.kind==='corporate_action_fetch');
  if(!fetch||fetch.seq>=coverage.seq||fetch.payload.status!=='evidence_only'||fetch.payload.query.start>day||fetch.payload.query.end<day||marketDate(fetch.created_at)!==day)problems.push('Coverage lacks a current complete acquisition receipt');
  const opening=events.find(e=>e.kind==='experiment_opened');const previous=events.filter(e=>e.kind==='action_coverage'&&e.seq<coverage.seq).at(-1);
  const requiredFrom=opening?marketDate(opening.payload.started_at):previous?.payload.date||day;
  if(fetch&&fetch.payload.query.start>requiredFrom)problems.push('Corporate-action acquisition has an uncovered process-date gap');
  const sources=Array.isArray(p.source_ids)?p.source_ids.map(id=>events.find(e=>e.id===id&&e.kind==='action_source'&&e.seq<coverage.seq)):[];

  if(MANDATE.universe.some(symbol=>!sources.some(e=>{try{return e?.payload.symbol===symbol&&approvedPrimaryActionSource(symbol,e.payload.url)&&e.payload.excerpt?.trim()&&/^[a-f0-9]{64}$/.test(e.payload.content_sha256)&&marketDate(e.created_at)===day&&typeof e.payload.observed_at==='string'&&Number.isFinite(Date.parse(e.payload.observed_at))&&Date.parse(e.payload.observed_at)<=Date.parse(asOf)&&marketDate(e.payload.observed_at)===day;}catch{return false;}})))problems.push('Coverage requires current approved primary evidence for every approved symbol');
  if(!fetch||!Array.isArray(fetch.payload.pages)||fetch.payload.pages.some(id=>!events.some(e=>e.id===id&&e.kind==='corporate_action_page'&&e.seq<fetch.seq))||fetch.payload.query.symbols!==PERMITTED_SYMBOL_QUERY||fetch.payload.query.data_quality!=='all')problems.push('Coverage acquisition pages or universe are incomplete');
  const signature=canonical({date:p.date,policy:p.policy,fetch_id:p.fetch_id,source_ids:p.source_ids,action_ids:p.action_ids});
  if(events.some(e=>e.kind==='coverage_review'&&e.payload.binding===signature&&e.payload.status==='rejected'))problems.push('Coverage was rejected by an independent reviewer');
  const authors=new Set([coverage.actor]);
  if(!Array.isArray(p.review_ids)||p.review_ids.length!==2)problems.push('Coverage requires two independent reviews');
  else for(const id of p.review_ids){const r=events.find(e=>e.id===id&&e.kind==='coverage_review');if(!r||r.seq>=coverage.seq||r.seq<=(fetch?.seq||0)||sources.some(s=>s&&s.seq>=r.seq)||r.payload.status!=='approved'||r.payload.binding!==signature||!r.payload.author||authors.has(r.payload.author))problems.push('Invalid independent coverage review');else authors.add(r.payload.author);}
  if(canonical([...(Array.isArray(p.action_ids)?p.action_ids:[])].sort())!==canonical([...versions.keys()].sort()))problems.push('Coverage action inventory is incomplete');
  if(events.some(e=>['corporate_action_page','corporate_action_fetch_failed','action_source'].includes(e.kind)&&e.seq>coverage.seq))problems.push('New action evidence invalidates coverage');
 }
 return {ok:problems.length===0,problems,coverage_id:coverage?.id??null};
}
const overlay=(nano=false)=>({receivable_cents:0,distribution_cash_cents:0,income_cents:0,...(nano?{receivable_nanos:'0',distribution_cash_nanos:'0',income_nanos:'0'}:{})});
function projectOverlay(o){for(const key of ['receivable','distribution_cash','income'])o[key+'_cents']=nanosToCents(o[key+'_nanos'],{ceil:true});}
/** Economic replay is deterministic; settlement records must match newly known history exactly. */
export function replaySharedActions(opening,events,asOf){
 const nano=opening.payload.accounting_policy==='usd-nano-v1';
 let portfolio=nano?toNanoPortfolio(initialPortfolio()):initialPortfolio();let benchmark=nano?toNanoPortfolio(opening.payload.benchmark):structuredClone(opening.payload.benchmark);
 const economic={active:overlay(nano),benchmark:overlay(nano)};const pending=[];const problems=[];const contributing=[];let fill_count=0;
 const start=opening.payload.started_at;const startDay=marketDate(start);const day=marketDate(asOf);const definitions=[];
 const {versions,problems:rawProblems}=notices(events);problems.push(...rawProblems);
 for(const [id] of versions)if(!events.some(e=>e.kind==='action_confirmed'&&e.payload.action_id===id))problems.push('Unconfirmed action '+id);
 const checked=confirmedActions(events);definitions.push(...checked.definitions);problems.push(...checked.problems);
 const collisions=new Set();for(const c of definitions){const key=c.payload.terms.symbol+':'+c.payload.terms.ex_date;if(collisions.has(key))problems.push('Same-day actions require explicit combined treatment');collisions.add(key);}
 const timeline=events.filter(e=>e.kind==='ledger_fill').map(e=>({day:marketDate(e.payload.fill.occurred_at),rank:3,time:e.payload.fill.occurred_at,event:e}));
 for(const c of definitions){const t=c.payload.terms;if(t.ex_date<=startDay)continue;if(t.ex_date<=day)timeline.push({day:t.ex_date,rank:0,time:t.ex_date,event:c,phase:t.type==='cash_dividends'?'entitlement':'split'});if(t.type==='cash_dividends'&&t.payable_date<=day)timeline.push({day:t.payable_date,rank:1,time:t.payable_date,event:c,phase:'payment'});}
 timeline.sort((a,b)=>a.day.localeCompare(b.day)||a.rank-b.rank||Date.parse(a.time)-Date.parse(b.time)||a.event.seq-b.event.seq);
 const entitlements=new Map();const seen=new Set();
 for(const item of timeline){
  const e=item.event;
  try{
   if(!item.phase){if(Date.parse(e.payload.fill.occurred_at)<Date.parse(start)||Date.parse(e.payload.fill.occurred_at)>Date.parse(asOf))throw new Error('Fill is outside the official replay window');portfolio=applyFill(portfolio,e.payload.fill);contributing.push(e.id);fill_count++;continue;}
   const t=e.payload.terms;const key=t.id+':'+item.phase;if(seen.has(key))throw new Error('Duplicate economic action');seen.add(key);
   const eligible=t.ex_date>startDay;
   const quantities={active:eligible?whole(portfolio.holdings[t.symbol]?.quantity||0):0,benchmark:eligible?whole(benchmark.holdings[t.symbol]?.quantity||0):0};
   let expected;
   if(item.phase==='entitlement'){
    const amounts_nanos=nano?Object.fromEntries(Object.entries(quantities).map(([name,q])=>[name,q?wholeFillNanos(q,t.rate).toString():'0'])):null;
    const amounts=Object.fromEntries(Object.entries(quantities).map(([name,q])=>[name,nano?nanosToCents(amounts_nanos[name],{ceil:true}):q?exactWholeFillCents(q,t.rate):0]));
    expected={action_id:t.id,confirmation_id:e.id,symbol:t.symbol,effective_date:t.ex_date,quantities,amounts,contributing_ids:[opening.id,...contributing],...(nano?{amounts_nanos,accounting_policy:'usd-nano-v1'}:{}),convention:nano?'New York ex-date boundary; whole-share exact nano entitlement':'New York ex-date boundary; whole-share exact-cent entitlement'};
    entitlements.set(t.id,expected);for(const name of ['active','benchmark']){if(nano){economic[name].receivable_nanos=(BigInt(economic[name].receivable_nanos)+BigInt(amounts_nanos[name])).toString();economic[name].income_nanos=(BigInt(economic[name].income_nanos)+BigInt(amounts_nanos[name])).toString();projectOverlay(economic[name]);}else{economic[name].receivable_cents=add(economic[name].receivable_cents,amounts[name]);economic[name].income_cents=add(economic[name].income_cents,amounts[name]);}}
   }else if(item.phase==='payment'){
    const entitlement=entitlements.get(t.id);if(!entitlement)throw new Error('Payment without entitlement');
    expected={action_id:t.id,confirmation_id:e.id,symbol:t.symbol,effective_date:t.payable_date,amounts:entitlement.amounts,...(nano?{amounts_nanos:entitlement.amounts_nanos,accounting_policy:'usd-nano-v1'}:{}),convention:'Modeled payable-date transfer; not a broker cash receipt'};
    for(const name of ['active','benchmark']){if(nano){economic[name].receivable_nanos=(BigInt(economic[name].receivable_nanos)-BigInt(expected.amounts_nanos[name])).toString();economic[name].distribution_cash_nanos=(BigInt(economic[name].distribution_cash_nanos)+BigInt(expected.amounts_nanos[name])).toString();projectOverlay(economic[name]);}else{economic[name].receivable_cents-=expected.amounts[name];economic[name].distribution_cash_cents=add(economic[name].distribution_cash_cents,expected.amounts[name]);}}
   }else{
    const numerator=decimalUnits(t.new_rate,9),denominator=decimalUnits(t.old_rate,9);
    const after={};for(const name of ['active','benchmark']){const product=BigInt(quantities[name])*numerator;if(product%denominator)throw new Error('Fractional split result/cash in lieu unsupported');after[name]=whole(Number(product/denominator));}
    expected={action_id:t.id,confirmation_id:e.id,symbol:t.symbol,effective_date:t.ex_date,before:quantities,after,contributing_ids:[opening.id,...contributing]};
    if(eligible)for(const [name,p] of [['active',portfolio],['benchmark',benchmark]])if(p.holdings[t.symbol])p.holdings[t.symbol].quantity=after[name];
   }
   const kind='action_'+item.phase;const prior=events.filter(r=>r.kind===kind&&r.payload.action_id===t.id);
   if(prior.length>1||prior.length===1&&canonical(prior[0].payload)!==canonical(expected))throw new Error('Recorded action differs from newly known entitlement/history; reviewed compensation required');
   if(!prior.length)pending.push({id:'action-'+item.phase+':'+e.id.replace(/^action-confirmed:/,''),kind,payload:expected});
   else if(item.phase==='split')contributing.push(prior[0].id);
  }catch(error){problems.push(error.message);break;}
 }
 return {portfolio,benchmark,economic,pending,problems,fill_count};
}
