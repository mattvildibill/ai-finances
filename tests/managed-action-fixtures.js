// Isolated test fixture only. Never uses production tools or actual source assertions.
import {listEvents} from '../lib/store.js';
import {marketDate} from '../lib/action-ledger.js';
import {collectManagedActions,recordManagedAction,managedCoverageCandidate} from '../lib/managed-actions.js';
import {testEnv} from './helpers.js';
export async function seedManagedCoverage(db,symbols,approvedBySymbol,fetcher){
 const now=()=>new Date().toISOString(),actor='synthetic-source-manager',scope_symbols=[...symbols].sort();
 const events=()=>listEvents(db,now(),1000),opening=(await events()).find(e=>e.kind==='experiment_opened');
 const id='managed-empty-'+(await events()).at(-1).seq;
 const sourceFetch=async(url,options)=>new URL(url).pathname==='/v1/corporate-actions'?Response.json({corporate_actions:{},next_page_token:null}):fetcher(url,options);
 const fetched=await collectManagedActions(db,testEnv,{idempotency_key:id+'-fetch',start:marketDate(opening.created_at),end:marketDate(new Date(Date.now()+90*86400000).toISOString()),scope_symbols},actor,sourceFetch);
 const source_ids=[];
 for(const symbol of scope_symbols){const saved=await recordManagedAction(db,{idempotency_key:id+'-source-'+symbol,kind:'managed_action_source',payload:{symbol,instrument_id:approvedBySymbol[symbol].id,url:'https://issuer.example.com/'+symbol+'/actions',publisher_name:'Synthetic issuer',source_type:'issuer',observed_at:now(),content_sha256:'e'.repeat(64),excerpt:'Isolated empty-inventory primary scan fixture; not actual research.',scope_description:'Only scoped test inventory, not universal absence.'}},actor);source_ids.push(saved.id);}
 const payload={scope_symbols,fetch_id:fetched.id,source_ids};const candidate=managedCoverageCandidate(await events(),payload);
 const review=await recordManagedAction(db,{idempotency_key:id+'-review',kind:'managed_coverage_review',payload:{author:'synthetic-source-reviewer',status:'approved',summary:'Independent empty-inventory fixture review only',binding:candidate.binding}},actor);
 return recordManagedAction(db,{idempotency_key:id+'-coverage',kind:'managed_action_coverage',payload:{...payload,status:'approved',author:actor,binding:candidate.binding,review_id:review.id,valid_until:new Date(Date.now()+7*86400000).toISOString()}},actor);
}
