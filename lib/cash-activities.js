import {alpaca,PAPER} from './alpaca.js';
import {AppError,canonical,hash,isoNow,getEvent,acquire,renew,release,appendLeased} from './store.js';
import {readCompleteHistory} from './history.js';

export const CASH_ACTIVITY_LIMITS=Object.freeze({page_size:100,max_pages:20,page_bytes:262144,total_bytes:2097152});
export const CASH_ACTIVITY_KINDS=['cash_activity_scan','cash_activity_page','cash_activity_result'];
/** Evidence only: no activity type is authorized to move cash by this collector. */
export function cashActivityProblems(events){
 const problems=[];
 const knownFills=new Set(events.filter(e=>e.kind==='broker_activity').map(e=>canonical(e.payload.activity)));
 const scans=events.filter(e=>e.kind==='cash_activity_scan'),last=scans.at(-1);
 if(last){const result=events.find(e=>e.kind==='cash_activity_result'&&e.payload.scan_id===last.id);
  if(!result?.payload.complete)problems.push({code:'cash_activity_incomplete',message:'Account activity acquisition is incomplete; preserved pages require review.',scan_id:last.id});
 }
 for(const page of events.filter(e=>e.kind==='cash_activity_page')){
  const rows=page.payload.activities;
  if(!Array.isArray(rows)){problems.push({code:'cash_activity_invalid',message:'Malformed account activity page requires review.',page_id:page.id});continue;}
  for(const row of rows)if(!row||typeof row.id!=='string'||!row.id||row.activity_type!=='FILL'||!['fill','partial_fill'].includes(row.type)||!knownFills.has(canonical(row))){
   problems.push({code:'cash_activity_unresolved',message:'Observed non-fill, unknown or unmatched fill activity requires evidence-backed accounting review; no adjustment applied.',page_id:page.id,broker_activity_id:typeof row?.id==='string'?row.id:null,activity_type:typeof row?.activity_type==='string'?row.activity_type:null});
  }
 }
 return problems;
}

/** Full available account history through a server-fixed cutoff. No caller URL, type or date filters. */
export async function collectCashActivities(db,env,input,actor,fetcher=fetch){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='idempotency_key')||!/^[A-Za-z0-9:_-]{8,160}$/.test(input.idempotency_key||''))throw new AppError('collect_cash_activities requires only a stable idempotency_key.');
 const key=input.idempotency_key,resultId='cash-result:'+(await hash(key)).slice(0,48);
 const prior=await getEvent(db,key);
 if(prior){if(prior.kind!=='cash_activity_scan')throw new AppError('Idempotency key belongs to a different operation.',409);return await getEvent(db,resultId)||prior;}
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 const persist=async(id,kind,payload)=>{await renew(db,'execution',token);return appendLeased(db,{id,kind,payload,actor},'execution',token);};
 try{
  const raced=await getEvent(db,key);if(raced){if(raced.kind!=='cash_activity_scan')throw new AppError('Idempotency key belongs to a different operation.',409);return await getEvent(db,resultId)||raced;}
  const {managedMandate}=await import('./managed-policy.js');
  const events=await readCompleteHistory(db),mandate=managedMandate(events);
  if(!mandate)throw new AppError('Existing managed mandate required for account diagnostics.',423);
  const until=isoNow();
  await persist(key,'cash_activity_scan',{operation:'collect_cash_activities',mandate_id:mandate.id,until,source:PAPER+'/v2/account/activities',scope:'All available activity types and dates through server cutoff, including pre-inception records; no accounting or order permission.',limits:CASH_ACTIVITY_LIMITS,complete:false,trading_permitted:false});
  const pageIds=[],seen=new Set();let cursor,bytes=0,count=0,nonfills=0;
  try{
   const boundedFetch=async(url,options)=>{
    await renew(db,'execution',token);
    const response=await fetcher(url,options);
    await renew(db,'execution',token);
    if(!response.ok)return response;
    const reader=response.body?.getReader();if(!reader)throw new AppError('Missing account activity response body.',502);
    const chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>CASH_ACTIVITY_LIMITS.page_bytes||bytes+size>CASH_ACTIVITY_LIMITS.total_bytes)throw new AppError('Account activity byte limit exceeded; acquisition incomplete.',423);chunks.push(value);}}
    finally{await reader.cancel();}
    bytes+=size;const body=new Uint8Array(size);let offset=0;for(const c of chunks){body.set(c,offset);offset+=c.byteLength;}
    await renew(db,'execution',token);return new Response(body,{status:response.status});
   };
   for(let page=0;page<CASH_ACTIVITY_LIMITS.max_pages;page++){
    const query=new URLSearchParams({direction:'asc',page_size:String(CASH_ACTIVITY_LIMITS.page_size),until});if(cursor)query.set('page_token',cursor);
    const source_url=PAPER+'/v2/account/activities?'+query,started_at=isoNow();
    const rows=await alpaca(env,'/v2/account/activities?'+query,{fetcher:boundedFetch});
    const observed_at=isoNow();
    // Retain the original response before validating its shape or interpreting any amount/date.
    const receipt=await persist('cash-page:'+(await hash({key,page})).slice(0,48),'cash_activity_page',{scan_id:key,page,source_url,retrieval_started_at:started_at,observed_at,activities:rows});pageIds.push(receipt.id);
    if(!Array.isArray(rows)||rows.length>CASH_ACTIVITY_LIMITS.page_size)throw new AppError('Invalid account activity page; acquisition incomplete.',502);
    for(const row of rows){
     count++;if(row?.activity_type!=='FILL')nonfills++;
     if(!row||typeof row.id!=='string'||!row.id||row.id.length>512||seen.has(row.id))throw new AppError('Missing, oversized or repeated activity ID; acquisition incomplete.',502);
     seen.add(row.id);
    }
    if(rows.length<CASH_ACTIVITY_LIMITS.page_size){
     return await persist(resultId,'cash_activity_result',{scan_id:key,complete:true,trading_permitted:false,until,page_ids:pageIds,activity_count:count,non_fill_count:nonfills,bytes,status:'evidence_only',scope:'Complete bounded broker response through cutoff, not reconciliation or fee approval. Raw timestamps and amounts retained; cash unchanged.'});
    }
    cursor=rows.at(-1).id;
   }
   throw new AppError('Account activity page limit exceeded; acquisition incomplete.',423);
  }catch(error){
   return await persist(resultId,'cash_activity_result',{scan_id:key,complete:false,trading_permitted:false,until,page_ids:pageIds,activity_count:count,non_fill_count:nonfills,bytes,status:'blocked',problem:error instanceof AppError?error.message:'Account activity acquisition failed; original receipts retained.'});
  }
 }finally{await release(db,'execution',token);}
}
