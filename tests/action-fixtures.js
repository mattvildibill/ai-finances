// Synthetic evidence helpers. Never imported by production modules.
import { append,canonical,latest } from '../lib/store.js';
import { marketDate,normalizeAction } from '../lib/action-ledger.js';
export async function seedCoverage(db,{at=new Date().toISOString(),actionIds=[],pages=[]}={}){
 const day=marketDate(at);const opening=await latest(db,'experiment_opened');const rangeStart=opening?marketDate(opening.payload.started_at):day;const unique=crypto.randomUUID();
 const fetch=await append(db,{id:'fetch:'+unique,kind:'corporate_action_fetch',actor:'fixture',payload:{status:'evidence_only',query:{start:rangeStart,end:day,symbols:'AAPL,MSFT,SPY',data_quality:'all'},pages}},at);
 const source_ids=[];
 for(const [symbol,host] of [['AAPL','investor.apple.com'],['MSFT','news.microsoft.com'],['SPY','www.ssga.com']]){
  const e=await append(db,{id:'source:'+symbol+':'+unique,kind:'action_source',actor:'fixture',payload:{symbol,observed_at:at,url:'https://'+host+'/fixture',excerpt:'Synthetic coverage evidence, not an actual document',content_sha256:'a'.repeat(64)}},at);source_ids.push(e.id);
 }
 const core={date:day,policy:'ordinary-cash-and-whole-splits-v1',fetch_id:fetch.id,source_ids,action_ids:actionIds};const review_ids=[];
 for(const author of ['coverage-reviewer-1','coverage-reviewer-2']){const r=await append(db,{id:author+':'+unique,kind:'coverage_review',actor:author,payload:{author,status:'approved',binding:canonical(core)}},at);review_ids.push(r.id);}
 return append(db,{id:'coverage:'+unique,kind:'action_coverage',actor:'coverage-manager',payload:{...core,review_ids,status:'approved'}},at);
}
export async function seedAction(db,raw,{type='cash_dividends',at=new Date().toISOString(),confirm=true}={}){
 const {confirmCorporateAction}=await import('../lib/action-settlement.js');
 const page=await append(db,{id:'raw-action:'+raw.id,kind:'corporate_action_page',actor:'fixture',payload:{response:{corporate_actions:{[type]:[raw]}}}},at);
 const terms=normalizeAction(type,raw);const host={AAPL:'investor.apple.com',MSFT:'news.microsoft.com',SPY:'www.ssga.com'}[raw.symbol];
 const source=await append(db,{id:'issuer:'+raw.id,kind:'action_source',actor:'fixture',payload:{symbol:raw.symbol,observed_at:at,url:'https://'+host+'/fixture',excerpt:'Synthetic matching terms only',content_sha256:'b'.repeat(64),terms}},at);
 const binding=canonical({action_id:raw.id,raw_event_id:page.id,raw_signature:canonical({type,raw}),source_id:source.id,source_digest:source.digest,terms});const review_ids=[];
 for(const author of ['action-reviewer-1','action-reviewer-2']){const r=await append(db,{id:author+':'+raw.id,kind:'action_review',actor:author,payload:{author,status:'approved',binding}},at);review_ids.push(r.id);}
 const input={action_id:raw.id,raw_event_id:page.id,source_id:source.id,review_ids};
 return {input,page,source,confirmation:confirm?await confirmCorporateAction(db,input,'action-manager'):null};
}
export async function releaseChecks(db,revision){
 const {RELEASE_CHECKS}=await import('../lib/readiness.js');const checks={};
 for(const check of RELEASE_CHECKS){const id='check:'+check+':'+crypto.randomUUID();await append(db,{id,kind:'verification',actor:'synthetic:release',payload:{check,revision,outcome:'passed',summary:'Synthetic measured-check fixture, not production evidence'}});checks[check]=id;}
 return checks;
}
