import { ledgerView } from './valuation.js';
import { fresh } from './readiness.js';
import {append,getEvent,listEvents,latest,AppError,isoNow,acquire,release,renew,appendLeased,hash} from './store.js';
import {observe} from './alpaca.js';
import {readLedger,reconcile} from './reconciliation.js';
export const mandate={initial_cash:100000,currency:'USD',universe:['AAPL','MSFT','SPY'],stock_limit:0.1,etf_limit:0.25,max_order:0.05,gross_limit:0.9,min_cash:0.1,long_only:true,paper_only:true,leverage:false,options:false,price_max_age_seconds:120,benchmark:'SPY, simultaneous prospective start; never backfilled',performance_basis:'Not started. Total return unavailable until distribution/corporate-action reconciliation is verified.'};
export const blockers=['Official experiment has not started.','Corporate-action and distribution reconciliation for portfolio and SPY is not verified.','Repeated unattended operation of this release remains unverified.'];
/** Display recorded operational evidence; configuration never certifies execution. */
export function operationalHealth(events) {
 const verifications=events.filter(e=>e.kind==='verification').sort((a,b)=>a.seq-b.seq);
 const adoption=verifications.find(e=>e.id==='blue-adoption-verification-2026-10-27' && e.payload.verified_components?.includes('native_plugin_read_refresh_readback') && e.payload.verified_components?.includes('independent_research_and_challenge_outputs'));
 const observed=verifications.filter(e=>e.payload.operational_status).at(-1);
 const status=observed?.payload.operational_status;
 const enabled=typeof status?.schedule_enabled==='boolean' ? (status.schedule_enabled?'Enabled':'Disabled') : 'Configuration not observed';
 const weekdaySchedule=typeof status?.schedule==='string' && status.schedule.split(/\r?\n/).includes('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=13;BYMINUTE=15;BYSECOND=0') && status.timezone==='America/Los_Angeles';
 const schedule=weekdaySchedule?'weekdays at 1:15 p.m. America/Los_Angeles':status?.schedule || 'No recorded schedule configuration';
 return {
  blue_connection:adoption?'Native adoption verified · evidence '+adoption.id:'Native adoption evidence unavailable in this replay',
  scheduler:'Repeated unattended execution unverified'+(status?.schedule_modification==='denied'?' · modification access denied':''),
  schedule:enabled+': '+schedule+(status?.observed_at?' · observed '+status.observed_at:''),
  operations_evidence_id:observed?.id||null,
 };
}
export async function state(db,asOf=isoNow()){
 if(!Number.isFinite(Date.parse(asOf)))throw new AppError('Invalid replay timestamp.');
 asOf=new Date(asOf).toISOString();
 const [events,snapshot,refreshFailure,review,ledger,reconciliation]=await Promise.all([listEvents(db,asOf),latest(db,'snapshot',asOf),latest(db,'refresh_failed',asOf),latest(db,'decision',asOf),readLedger(db,asOf),latest(db,'reconciliation',asOf)]);
 const p=snapshot?.payload;
 const healthEvents=events.filter(e=>e.kind==='verification');
 const view=ledgerView(ledger,snapshot,asOf,reconciliation);
 const {account_drift}=view;
 return {as_of:asOf,experiment:{id:'blue-capital-v1',status:'paused',initial_cash:100000,started_at:ledger.started_at,pause_reason:'Execution is hard-disabled in this release.'},portfolio:view.portfolio,broker_account:p?.account||null,account_drift,benchmark:view.benchmark,risk:view.risk,snapshots:events.filter(e=>e.kind==='snapshot'),events:events.filter(e=>e.kind!=='snapshot'),latest_snapshot:snapshot,health:{last_successful_update:snapshot?.created_at||null,last_successful_review:review?.created_at||null,last_failure:refreshFailure?.created_at||null,source_status:refreshFailure&&(!snapshot||refreshFailure.seq>snapshot.seq)?'failed':p?'connected':'unverified',data_fresh:Boolean(p?.execution_ready&&fresh(p.retrieved_at,asOf)&&Object.values(p.quotes||{}).every(q=>fresh(q.market_data_at,asOf))),persistence:'Connected · append-only D1',...operationalHealth(events),verification:healthEvents.map(e=>e.payload),trading:'paused',blockers:[...blockers.filter(message=>ledger.status==='not_started'||!message.startsWith('Official experiment')), ...ledger.problems.map(problem=>problem.message),...(account_drift?['Paper account differs from the official ledger; reconcile before trading.']:[])]},mandate,accounting:ledger,last_reconciliation:reconciliation,history_limit:500,history_truncated:events.length===500};
}
export async function refresh(db,env,id,actor,fetcher=fetch){
 if(!/^[A-Za-z0-9:_-]{8,160}$/.test(id||''))throw new AppError('Refresh requires a stable idempotency key.');
 const reconKey='market-reconcile:'+(await hash(id)).slice(0,48);
 const existing=await getEvent(db,id);if(existing){if(existing.kind!=='snapshot')throw new AppError('Key already used.',409);await reconcile(db,env,reconKey,actor,fetcher);return existing;}
 const token=crypto.randomUUID();await acquire(db,'refresh',token);
 try {const payload=await observe(env,fetcher);const snapshot=await append(db,{id,kind:'snapshot',payload,actor});await reconcile(db,env,reconKey,actor,fetcher);return snapshot;}
 catch(e){await append(db,{id:'failure:'+(await hash({id,message:e instanceof AppError?e.message:'source unavailable'})),kind:'refresh_failed',payload:{summary:e instanceof AppError?e.message:'Market source unavailable; trading remains paused.'},actor});throw e;}
 finally {await release(db,'refresh',token);}
}
function textField(p,k,max=12000){if(typeof p[k]!=='string'||!p[k].trim()||p[k].length>max)throw new AppError(k+' must be a nonempty string up to '+max+' characters.');}
export async function submit(db,input,actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{return await submitUnlocked(db,input,actor,token);}finally{await release(db,'execution',token);}
}
async function submitUnlocked(db,input,actor,token){
 const {idempotency_key:id,kind,payload:p}=input;
 if(!['research','challenge','decision','revision','verification'].includes(kind))throw new AppError('Unsupported record kind.');
 if(!p||typeof p!=='object'||Array.isArray(p)||JSON.stringify(p).length>50000)throw new AppError('Invalid record payload.');
 textField(p,'title',200);textField(p,'summary');textField(p,'author',200);
 const now=isoNow();
 if(kind!=='verification'){
  textField(p,'role',60);const expected={research:'researcher',challenge:'challenger',decision:'portfolio_manager'};
  if(expected[kind]&&p.role!==expected[kind])throw new AppError('Role must be '+expected[kind]);
  if(!Array.isArray(p.evidence)||!p.evidence.length||p.evidence.length>25)throw new AppError('At least one timestamped evidence item is required.');
  for(const e of p.evidence){textField(e,'title',500);textField(e,'url',2000);textField(e,'observed_at',50);textField(e,'excerpt',10000);let u;try{u=new URL(e.url);}catch{throw new AppError('Evidence URL invalid.');}if(u.protocol!=='https:')throw new AppError('Evidence URLs must use HTTPS.');if(!Number.isFinite(Date.parse(e.observed_at))||Date.parse(e.observed_at)>Date.parse(now)+5000)throw new AppError('Evidence observation cannot be future-dated.');}
  if(!Array.isArray(p.snapshot_ids)||!p.snapshot_ids.length)throw new AppError('Link at least one stored market snapshot.');
  for(const sid of p.snapshot_ids){const s=await getEvent(db,sid);if(s?.kind!=='snapshot')throw new AppError('Unknown market snapshot '+sid);}
 }
 if(kind==='research'||kind==='decision'){for(const k of ['thesis','horizon','uncertainties','change_mind'])textField(p,k);}
 if(kind==='challenge'){const r=await getEvent(db,p.research_id);if(r?.kind!=='research'||r.payload.author===p.author)throw new AppError('Challenge requires research by a different author.');textField(p,'counterargument');}
 if(kind==='decision'){
  const [r,c]=await Promise.all([getEvent(db,p.research_id),getEvent(db,p.challenge_id)]);
  if(r?.kind!=='research'||c?.kind!=='challenge'||c.payload.research_id!==r.id)throw new AppError('Decision requires linked research and its independent challenge.');
  if(p.author===r.payload.author||p.author===c.payload.author)throw new AppError('Portfolio manager must be a distinct author.');
  if(!['hold','buy','sell'].includes(p.action))throw new AppError('Unknown action.');
  if(!Number.isFinite(p.size)||p.size<0||p.size>100000||(p.action==='hold'&&p.size!==0))throw new AppError('Size is USD notional; hold must have size zero.');
  if(p.action!=='hold'&&!mandate.universe.includes(p.symbol))throw new AppError('Symbol outside approved universe.');
  if(p.action!=='hold'){if(!Number.isSafeInteger(p.limit_price_cents)||p.limit_price_cents<=0)throw new AppError('Buy/sell proposals require explicit limit_price_cents.');if(typeof p.valid_until!=='string'||! /T.*(?:Z|[+-]\d\d:\d\d)$/.test(p.valid_until)||!Number.isFinite(Date.parse(p.valid_until))||Date.parse(p.valid_until)<=Date.parse(now))throw new AppError('Buy/sell proposals require a future valid_until timestamp with timezone.');}
  textField(p,'challenge_response');
 }
 if(kind==='revision'){const original=await getEvent(db,p.supersedes);if(!original||!['research','challenge','decision','revision'].includes(original.kind))throw new AppError('Revision requires an existing research or decision record.');}
 await renew(db,'execution',token);
 return appendLeased(db,{id,kind,payload:p,actor},'execution',token);
}
