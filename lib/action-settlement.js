import { ACTION_KINDS, actionApproval, actionCoverage } from './action-ledger.js';
import { getEvent,parseRow,hash,canonical,acquire,renew,release,appendLeased,AppError,isoNow } from './store.js';
import { readLedger } from './reconciliation.js';
export async function actionEvents(db,asOf=isoNow()){
 const kinds=[...ACTION_KINDS,'experiment_opened'];
 const rows=await db.prepare(`SELECT * FROM events WHERE kind IN (${kinds.map(()=>'?').join(',')}) AND created_at<=? ORDER BY seq LIMIT 10001`).bind(...kinds,asOf).all();
 if(rows.results.length>10000)throw new AppError('Action history exceeds processing bound.',423);
 return rows.results.map(parseRow);
}
/** Internal reviewed operation; intentionally not exposed through generic submit_record. */
export async function confirmCorporateAction(db,input,actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const events=await actionEvents(db);const payload=actionApproval(events,input,actor);
  const id='action-confirmed:'+(await hash(input.action_id)).slice(0,48);
  await renew(db,'execution',token);
  return await appendLeased(db,{id,kind:'action_confirmed',payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
/** Append only deterministic due phases. No quote or inferred broker fill is created. */
export async function settleCorporateActions(db,actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);const saved=[];
 try{
  for(let count=0;count<1000;count++){
   await renew(db,'execution',token);const ledger=await readLedger(db);
   if(ledger.status==='not_started')return saved;
   const invalid=ledger.problems.filter(p=>p.code!=='action_settlement_pending');
   if(invalid.length)throw new AppError(invalid.map(p=>p.message).join('; '),423);
   const next=ledger.pending[0];if(!next)return saved;
   saved.push(await appendLeased(db,{...next,actor},'execution',token));
  }
  throw new AppError('Corporate-action settlement processing bound reached.',423);
 }finally{await release(db,'execution',token);}
}
export async function coverageState(db,asOf=isoNow()){return actionCoverage(await actionEvents(db,asOf),asOf);}
/** Typed evidence capture; callers must supply actual retrieved material and authored reviews. */
export async function recordActionEvidence(db,{idempotency_key,kind,payload},actor){
 if(!['action_source','action_review','coverage_review'].includes(kind)||!payload||typeof payload!=='object'||JSON.stringify(payload).length>50000)throw new AppError('Invalid typed action evidence.');
 if(kind==='action_source'){
  const domains={AAPL:['investor.apple.com','www.apple.com'],MSFT:['news.microsoft.com','www.microsoft.com'],SPY:['www.ssga.com']};let u;try{u=new URL(payload.url);}catch{}
  if(!u||u.protocol!=='https:'||!domains[payload.symbol]?.includes(u.hostname)||!payload.excerpt?.trim()||!(/^[a-f0-9]{64}$/.test(payload.content_sha256||''))||typeof payload.observed_at!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(payload.observed_at)||!Number.isFinite(Date.parse(payload.observed_at))||Date.parse(payload.observed_at)>Date.now())throw new AppError('Actual issuer source URL, symbol, excerpt, document hash and observation time required.');
 }else if(typeof payload.author!=='string'||!payload.author.trim()||!['approved','rejected'].includes(payload.status)||typeof payload.binding!=='string'||!payload.binding.length)throw new AppError('Authored review must bind exact evidence terms.');
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{return await appendLeased(db,{id:idempotency_key,kind,payload,actor},'execution',token);}finally{await release(db,'execution',token);}
}
export async function approveActionCoverage(db,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
  const events=await actionEvents(db);const now=isoNow();
  const candidate={id:idempotency_key,kind:'action_coverage',payload,actor,created_at:now,seq:Number.MAX_SAFE_INTEGER};
  const check=actionCoverage([...events,candidate],now);if(!check.ok)throw new AppError(check.problems.join('; '),423);
  return await appendLeased(db,{id:idempotency_key,kind:'action_coverage',payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
