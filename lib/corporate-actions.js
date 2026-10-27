import { alpaca } from './alpaca.js';
import { getEvent, acquire, release, renew, appendLeased, hash, canonical, AppError } from './store.js';
/** Evidence acquisition only. No entitlement, distribution, split, cash or order is inferred here. */
export async function collectCorporateActions(db,env,{idempotency_key,start,end},actor,fetcher=fetch){
 for(const value of [start,end])if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new AppError('Corporate-action process-date range requires valid YYYY-MM-DD dates.');
 if(start>end||Date.parse(end)-Date.parse(start)>370*86400000)throw new AppError('Corporate-action range must be ordered and at most 370 days.');
 if(!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotency_key||''))throw new AppError('Stable corporate-action idempotency key required.');
 const query={start,end,symbols:'AAPL,MSFT,SPY',data_quality:'all',limit:'1000',sort:'asc'};
 const runId='action-fetch:'+(await hash(idempotency_key)).slice(0,48);
 const check=existing=>{if(existing&&canonical(existing.payload.query)!==canonical(query))throw new AppError('Corporate-action idempotency key reused with different query.',409);return existing;};
 const existing=check(await getEvent(db,runId));if(existing)return existing;
 const token=crypto.randomUUID();await acquire(db,'execution',token);const pages=[];
 const persist=record=>appendLeased(db,record,'execution',token);
 try{
  const raced=check(await getEvent(db,runId));if(raced)return raced;
  const seen=new Set();let pageToken;
  for(let page=0;page<50;page++){
   await renew(db,'execution',token);
   const params=new URLSearchParams(query);if(pageToken)params.set('page_token',pageToken);
   const response=await alpaca(env,'/v1/corporate-actions?'+params,{data:true,fetcher});
   await renew(db,'execution',token);
   // Raw malformed/incomplete/unsupported evidence is preserved before parsing.
   const receipt=await persist({id:'action-page:'+(await hash({query,pageToken:pageToken??null,response})).slice(0,48),kind:'corporate_action_page',payload:{query,page_token:pageToken??null,response},actor});pages.push(receipt.id);
   if(!response||typeof response.corporate_actions!=='object'||response.corporate_actions===null||Array.isArray(response.corporate_actions)||Object.values(response.corporate_actions).some(rows=>!Array.isArray(rows)))throw new AppError('Invalid corporate-action response shape; evidence preserved.',503);
   const next=response.next_page_token;
   if(next===null||next===undefined||next==='')return await persist({id:runId,kind:'corporate_action_fetch',payload:{query,pages,status:'evidence_only',trading_permitted:false,scope:'All returned action types, including incomplete announcements. Absence is not proof of completeness; no entitlements inferred.'},actor});
   if(typeof next!=='string'||seen.has(next))throw new AppError('Corporate-action pagination did not advance.',503);
   seen.add(next);pageToken=next;
  }
  throw new AppError('Corporate-action pagination exceeds verified processing bound.',423);
 }catch(error){
  await renew(db,'execution',token);
  await persist({id:'action-failed:'+(await hash({runId,pages,message:error.message})).slice(0,48),kind:'corporate_action_fetch_failed',payload:{query,pages,status:'blocked',trading_permitted:false,message:error.message},actor});
  throw error;
 }finally{await release(db,'execution',token);}
}
