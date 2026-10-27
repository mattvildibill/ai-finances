import {AppError,isoNow,parseRow} from './store.js';

export const HISTORY_LIMITS=Object.freeze({page_size:1000,max_records:50000,max_bytes:32*1024*1024});
const fail=message=>{throw new AppError('Complete journal replay unavailable: '+message,423);};
/** Complete keyset replay at a fixed receipt-time/head boundary, never a latest-row window.
 * Limits fail closed instead of returning a partial accounting or commitment history.
 */
export async function readCompleteHistory(db,asOf=isoNow(),{kinds}={}){
 if(typeof asOf!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(asOf)||!Number.isFinite(Date.parse(asOf)))fail('valid timezone-qualified cutoff required');
 const cutoff=new Date(asOf).toISOString();
 if(kinds!==undefined&&(!Array.isArray(kinds)||kinds.length===0||kinds.length>100||kinds.some(k=>typeof k!=='string'||!k)||new Set(kinds).size!==kinds.length))fail('invalid event-kind selection');
 const selected=kinds===undefined?'':` AND kind IN (${kinds.map(()=>'?').join(',')})`,parameters=[cutoff,...(kinds||[])];
 const boundary=await db.prepare(`SELECT COALESCE(MAX(seq),0) AS head,COUNT(*) AS count FROM events WHERE created_at<=?${selected}`).bind(...parameters).first();
 const head=boundary?.head,count=boundary?.count;
 if(!Number.isSafeInteger(head)||head<0||!Number.isSafeInteger(count)||count<0)fail('invalid fixed journal boundary');
 if(count>HISTORY_LIMITS.max_records)fail(`record bound ${HISTORY_LIMITS.max_records} exceeded; no partial replay returned`);
 const events=[];let cursor=0,bytes=0;const encoder=new TextEncoder();
 while(events.length<count){
  const page=await db.prepare(`SELECT * FROM events WHERE created_at<=?${selected} AND seq>? AND seq<=? ORDER BY seq LIMIT ?`).bind(...parameters,cursor,head,HISTORY_LIMITS.page_size).all();
  if(!Array.isArray(page.results)||!page.results.length||page.results.length>HISTORY_LIMITS.page_size)fail('incomplete or malformed journal page');
  for(const row of page.results){
   if(!Number.isSafeInteger(row.seq)||row.seq<=cursor||row.seq>head||row.created_at>cutoff)fail('journal page violates fixed boundary');
   bytes+=encoder.encode(JSON.stringify(row)).byteLength;
   if(bytes>HISTORY_LIMITS.max_bytes)fail(`byte bound ${HISTORY_LIMITS.max_bytes} exceeded; no partial replay returned`);
   cursor=row.seq;events.push(parseRow(row));
   if(events.length>count)fail('journal changed inside fixed boundary');
  }
 }
 return events;
}
