import {append,getEvent,listEvents,latest,AppError,isoNow,acquire,release} from './store.js';
import {observe} from './alpaca.js';
export const mandate={initial_cash:100000,currency:'USD',universe:['AAPL','MSFT','SPY'],stock_limit:0.1,etf_limit:0.25,max_order:0.05,gross_limit:0.9,min_cash:0.1,long_only:true,paper_only:true,leverage:false,options:false,price_max_age_seconds:120,benchmark:'SPY, simultaneous prospective start; never backfilled',performance_basis:'Not started. Total return unavailable until distribution/corporate-action reconciliation is verified.'};
export const blockers=['Official experiment has not started.','Corporate-action and distribution reconciliation for portfolio and SPY is not verified.','Independent cloud research cycle and blue connection require operating verification.'];
export async function state(db,asOf=isoNow()){
 if(!Number.isFinite(Date.parse(asOf)))throw new AppError('Invalid replay timestamp.');
 asOf=new Date(asOf).toISOString();
 const [events,snapshot,refreshFailure,review]=await Promise.all([listEvents(db,asOf),latest(db,'snapshot',asOf),latest(db,'refresh_failed',asOf),latest(db,'decision',asOf)]);
 const p=snapshot?.payload;
 const healthEvents=events.filter(e=>e.kind==='verification');
 const known={cash:100000,value:100000,holdings:[],gain:0,source:'Unstarted experiment allocation',as_of:null};
 // External/manual activity never silently becomes experiment transactions.
 const account_drift=p&&(p.positions.length>0||p.open_orders.length>0||Math.abs(p.account.cash-100000)>0.005);
 return {as_of:asOf,experiment:{id:'blue-capital-v1',status:'paused',initial_cash:100000,started_at:null},portfolio:known,broker_account:p?.account||null,account_drift:Boolean(account_drift),benchmark:{status:'not_started',symbol:'SPY',value:null,return:null,reason:'Starts prospectively with the experiment; no backdated benchmark.'},risk:{gross_exposure:0,cash_weight:1,largest_position:0,volatility:null,max_drawdown:null,beta:null,reason:'No official performance observations yet.'},snapshots:events.filter(e=>e.kind==='snapshot'),events:events.filter(e=>e.kind!=='snapshot'),latest_snapshot:snapshot,health:{last_successful_update:snapshot?.created_at||null,last_successful_review:review?.created_at||null,last_failure:refreshFailure?.created_at||null,source_status:refreshFailure&&(!snapshot||refreshFailure.seq>snapshot.seq)?'failed':p?'connected':'unverified',data_fresh:Boolean(p?.execution_ready&&Date.now()-Date.parse(p.retrieved_at)<120000),scheduler:'pending verification',verification:healthEvents.map(e=>e.payload),trading:'paused',blockers:[...blockers,...(account_drift?['Paper account differs from initial allocation; reconcile external activity.']:[])]},mandate,history_limit:500,history_truncated:events.length===500};
}
export async function refresh(db,env,id,actor,fetcher=fetch){
 const existing=await getEvent(db,id);if(existing){if(existing.kind!=='snapshot')throw new AppError('Key already used.',409);return existing;}
 const token=crypto.randomUUID();await acquire(db,'refresh',token);
 try {const payload=await observe(env,fetcher);return await append(db,{id,kind:'snapshot',payload,actor});}
 catch(e){await append(db,{id:'failure:'+id,kind:'refresh_failed',payload:{summary:e instanceof AppError?e.message:'Market source unavailable; trading remains paused.'},actor});throw e;}
 finally {await release(db,'refresh',token);}
}
function textField(p,k,max=12000){if(typeof p[k]!=='string'||!p[k].trim()||p[k].length>max)throw new AppError(k+' must be a nonempty string up to '+max+' characters.');}
export async function submit(db,input,actor){
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
  textField(p,'challenge_response');
 }
 if(kind==='revision'){const original=await getEvent(db,p.supersedes);if(!original||!['research','challenge','decision','revision'].includes(original.kind))throw new AppError('Revision requires an existing research or decision record.');}
 return append(db,{id,kind,payload:p,actor},now);
}
