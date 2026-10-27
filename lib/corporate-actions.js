import {activePolicyVersion,policyForVersion,symbolsForVersion,policyCanonical,policyDigest} from './investment-policy.js';
import { alpaca } from './alpaca.js';
import { getEvent, acquire, release, renew, appendLeased, hash, canonical, AppError } from './store.js';
/** Evidence acquisition only. No entitlement, distribution, split, cash or order is inferred here. */
export async function collectCorporateActions(db,env,{idempotency_key,start,end,configuration_version},actor,fetcher=fetch){
 for(const value of [start,end])if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new AppError('Corporate-action process-date range requires valid YYYY-MM-DD dates.');
 if(start>end||Date.parse(end)-Date.parse(start)>370*86400000)throw new AppError('Corporate-action range must be ordered and at most 370 days.');
 if(!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotency_key||''))throw new AppError('Stable corporate-action idempotency key required.');
 const runId='action-fetch:'+(await hash(idempotency_key)).slice(0,48);
 const token=crypto.randomUUID();await acquire(db,'execution',token);const pages=[];let query,metadata={};
 const persist=record=>appendLeased(db,record,'execution',token);
 try{
  const version=configuration_version===undefined?await activePolicyVersion(db):configuration_version;policyForVersion(version);
  if(version>1)metadata={configuration_version:version,configuration:policyCanonical(version),configuration_digest:await policyDigest(version)};
  query={start,end,symbols:symbolsForVersion(version).join(','),data_quality:'all',limit:'1000',sort:'asc'};
  const existing=await getEvent(db,runId);
  if(existing){if(canonical(existing.payload.query)!==canonical(query)||((existing.payload.configuration_version===undefined?1:existing.payload.configuration_version))!==version||(version>1&&existing.payload.configuration!==metadata.configuration))throw new AppError('Corporate-action idempotency key reused with different query or configuration.',409);return existing;}
  const seen=new Set();let pageToken;
  for(let page=0;page<50;page++){
   await renew(db,'execution',token);
   const params=new URLSearchParams(query);if(pageToken)params.set('page_token',pageToken);
   const response=await alpaca(env,'/v1/corporate-actions?'+params,{data:true,fetcher});
   await renew(db,'execution',token);
   // Raw malformed/incomplete/unsupported evidence is preserved before parsing.
   const receipt=await persist({id:'action-page:'+(await hash({...metadata,query,pageToken:pageToken??null,response})).slice(0,48),kind:'corporate_action_page',payload:{...metadata,query,page_token:pageToken??null,response},actor});pages.push(receipt.id);
   if(!response||typeof response.corporate_actions!=='object'||response.corporate_actions===null||Array.isArray(response.corporate_actions)||Object.values(response.corporate_actions).some(rows=>!Array.isArray(rows)))throw new AppError('Invalid corporate-action response shape; evidence preserved.',503);
   const next=response.next_page_token;
   if(next===null||next===undefined||next==='')return await persist({id:runId,kind:'corporate_action_fetch',payload:{...metadata,query,pages,status:'evidence_only',trading_permitted:false,scope:'All returned action types, including incomplete announcements. Absence is not proof of completeness; no entitlements inferred.'},actor});
   if(typeof next!=='string'||seen.has(next))throw new AppError('Corporate-action pagination did not advance.',503);
   seen.add(next);pageToken=next;
  }
  throw new AppError('Corporate-action pagination exceeds verified processing bound.',423);
 }catch(error){
  if(!query)throw error;
  await renew(db,'execution',token);
  await persist({id:'action-failed:'+(await hash({runId,pages,message:error.message})).slice(0,48),kind:'corporate_action_fetch_failed',payload:{...metadata,query,pages,status:'blocked',trading_permitted:false,message:error.message},actor});
  throw error;
 }finally{await release(db,'execution',token);}
}
