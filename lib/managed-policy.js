import {cashActivityProblems,CASH_ACTIVITY_KINDS} from './cash-activities.js';
import {AppError,canonical,hash,isoNow,getEvent,acquire,renew,release,appendLeased} from './store.js';
import {readCompleteHistory} from './history.js';
import {readLedger} from './reconciliation.js';
import {fresh} from './readiness.js';
import {sessionBoundaryErrors,brokerCashMatches,brokerBasisMatches,brokerBasisComparison,moneyToCents} from './finance.js';
import {usdNanos,USD_NANOS_PER_CENT} from './precision.js';
export const MANAGED_AUTHORIZATION='Sentinel_b8a876d72e5c8191839b02795b30ec8b';
export const MANAGED_RULES=Object.freeze({paper_only:true,cash_funded:true,long_only:true,owned_sales:true,reinvest_reconciled_proceeds:true,regular_hours_only:true,whole_shares_only:true,options:false,borrowing:false,shorting:false,initial_capital_cents:10000000,duration_days:180,position_cap:null,order_cap:null,cash_floor:null,turnover_cap:null});
export const MANAGED_CHECKS=['managed_code_review','managed_accounting_review','managed_security_review'];
const fail=m=>{throw new AppError(m,423);};
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const revision=r=>typeof r==='string'&&/^[a-f0-9]{40}$/.test(r);
export function managedMandate(events,now=isoNow()){
 const rows=events.filter(e=>e.kind==='managed_mandate'&&e.created_at<=now);if(!rows.length)return null;if(rows.length!==1)fail('Conflicting managed mandate records');
 const e=rows[0],p=e.payload,opening=events.find(x=>x.kind==='experiment_opened');
 if(!opening||p.opening_id!==opening.id||p.opening_digest!==opening.digest||p.started_at!==opening.payload.started_at||p.ends_at!==new Date(Date.parse(p.started_at)+180*86400000).toISOString()||p.authorization_reference!==MANAGED_AUTHORIZATION||p.protocol_version!==1||p.status!=='approved'||canonical(p.rules)!==canonical(MANAGED_RULES)||e.seq<=opening.seq||!revision(p.revision)||!nonempty(p.author))fail('Managed mandate does not preserve the authorized original experiment');
 return e;
}
function checkReviews(events,p,revisionValue,before=Infinity){
 if(!revision(revisionValue))fail('Exact reviewed release required');
 for(const check of MANAGED_CHECKS){const r=events.find(e=>e.id===p.checks?.[check]);if(!r||r.kind!=='verification'||r.seq>=before||r.payload.check!==check||r.payload.revision!==revisionValue||r.payload.outcome!=='passed'||!nonempty(r.payload.author)||r.payload.author===p.author||!nonempty(r.payload.summary))fail('Missing actual independent '+check);
  if(events.some(e=>e.kind==='verification'&&e.seq>r.seq&&e.payload.check===check&&e.payload.revision===revisionValue&&e.payload.outcome!=='passed'))fail('Managed release review has failed or is pending: '+check);
 }
}
export function managedAuthorization(events,revisionValue,now=isoNow()){
 const mandate=managedMandate(events,now);if(!mandate)fail('Managed mandate not recorded');
 if(Date.parse(now)>=Date.parse(mandate.payload.ends_at))fail('Standing 180-day experiment authority has expired');
 const control=events.filter(e=>e.kind==='managed_control'&&e.payload.mandate_id===mandate.id&&e.created_at<=now).at(-1);
 if(control&&control.payload.status!=='active')fail('Managed trading paused by recorded control');
 const releases=events.filter(e=>e.kind==='managed_release'&&e.payload.mandate_id===mandate.id&&e.created_at<=now);
 const current=releases.at(-1)||mandate;
 if(current.payload.revision!==revisionValue)fail('Current code release has not been independently approved for managed execution');
 checkReviews(events,current.payload,revisionValue,current.seq);
 return {mandate,release:current};
}
export async function transitionManaged(db,env,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{
 const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!=='managed_mandate'||existing.payload.request_hash!==await hash(payload))fail('Transition idempotency mismatch');return existing;}
 const now=isoNow(),events=await readCompleteHistory(db,now);if(events.some(e=>e.kind==='managed_mandate'))fail('Managed transition already recorded; original authority cannot be reset');
 const opening=events.find(e=>e.kind==='experiment_opened'),ledger=await readLedger(db,now),recon=events.filter(e=>e.kind==='reconciliation').at(-1);
 if(!opening||ledger.status!=='ready'||!ledger.portfolio||!ledger.benchmark||ledger.pending?.length||events.some(e=>e.kind==='order_intent'&&!events.some(c=>c.kind==='order_closed'&&c.payload.intent_id===e.id)))fail('Original inception and reconciled portfolio with no uncertain orders required');
 if(!recon||recon.payload.status!=='reconciled'||recon.payload.problems?.length||!fresh(recon.created_at,now))fail('Current successful account reconciliation required for transition');
 if(!payload||payload.authorization_reference!==MANAGED_AUTHORIZATION||payload.status!=='approved'||payload.protocol_version!==1||!nonempty(payload.author)||payload.revision!==env.RELEASE_REVISION||canonical(payload.rules)!==canonical(MANAGED_RULES))fail('Explicit authorized managed mandate and unchanged practical rules required');
 checkReviews(events,payload,env.RELEASE_REVISION);
 const ends_at=new Date(Date.parse(opening.payload.started_at)+180*86400000).toISOString();if(Date.parse(ends_at)<=Date.now())fail('Original experiment period has expired');
 const record={...payload,opening_id:opening.id,opening_digest:opening.digest,started_at:opening.payload.started_at,ends_at,previous_launch_approval_id:events.filter(e=>e.kind==='rollout_approval').at(-1)?.id??null,request_hash:await hash(payload),submission_valid_until:new Date(Date.parse(recon.created_at)+120000).toISOString()};
 await renew(db,'execution',token);return await appendLeased(db,{id:idempotency_key,kind:'managed_mandate',payload:record,actor},'execution',token,isoNow(),events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
export async function managedControl(db,env,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{const events=await readCompleteHistory(db),mandate=managedMandate(events);if(!mandate||payload?.mandate_id!==mandate.id||!['paused','active'].includes(payload.status)||!nonempty(payload.author)||!nonempty(payload.reason))fail('Explicit manager pause/resume and reason required');
 if(payload.status==='active'){const current=events.filter(e=>e.kind==='managed_release').at(-1)||mandate;if(current.payload.revision!==env.RELEASE_REVISION)fail('Reviewed current release required to resume');checkReviews(events,current.payload,env.RELEASE_REVISION,current.seq);if(Date.now()>=Date.parse(mandate.payload.ends_at))fail('Experiment expired');}
 return await appendLeased(db,{id:idempotency_key,kind:'managed_control',payload,actor},'execution',token);
 }finally{await release(db,'execution',token);}
}
export async function approveManagedRelease(db,env,{idempotency_key,payload},actor){
 const token=crypto.randomUUID();await acquire(db,'execution',token);
 try{const existing=await getEvent(db,idempotency_key);if(existing){if(existing.kind!=='managed_release'||canonical(existing.payload)!==canonical(payload))fail('Release idempotency mismatch');return existing;}const events=await readCompleteHistory(db),mandate=managedMandate(events);if(!mandate||payload?.mandate_id!==mandate.id||payload.revision!==env.RELEASE_REVISION||payload.status!=='approved'||!nonempty(payload.author))fail('Existing mandate and exact reviewed release required');checkReviews(events,payload,env.RELEASE_REVISION);
 const previous=events.filter(e=>e.kind==='managed_release').at(-1)||mandate;if(payload.previous_release_id!==previous.id)fail('Release predecessor differs');
 if(events.some(e=>['managed_mandate','managed_release'].includes(e.kind)&&e.payload.revision===payload.revision))fail('Release already authorized; use its original receipt');
 return await appendLeased(db,{id:idempotency_key,kind:'managed_release',payload,actor},'execution',token,isoNow(),events.at(-1)?.seq??0);
 }finally{await release(db,'execution',token);}
}
export function managedDecision(events,decisionId,mandate,now=isoNow()){
 const d=events.find(e=>e.id===decisionId),p=d?.payload,r=events.find(e=>e.id===p?.research_id),c=events.find(e=>e.id===p?.challenge_id);
 if(d?.kind!=='decision'||!['buy','sell'].includes(p.action)||p.managed_mandate_id!==mandate.id||d.seq<=mandate.seq||r?.kind!=='research'||c?.kind!=='challenge'||c.payload.research_id!==r.id||r.seq>=c.seq||c.seq>=d.seq||r.payload.role!=='researcher'||c.payload.role!=='challenger'||p.role!=='portfolio_manager')fail('Managed decision needs actual linked independent research and challenge');
 const authors=[p.author,r.payload.author,c.payload.author];if(authors.some(a=>!nonempty(a))||new Set(authors).size!==3)fail('Independent research, challenge and accountable manager required');
 for(const k of ['challenge_response','why_asset','why_now','why_size','correlated_exposure','downside_case'])if(!nonempty(p[k]))fail('Decision must explain '+k);
 for(const e of [r,c,d]){if(Date.parse(e.created_at)>Date.parse(now)||!Array.isArray(e.payload.snapshot_ids)||!e.payload.snapshot_ids.length||e.payload.snapshot_ids.some(id=>!events.some(s=>s.id===id&&s.kind==='snapshot'&&s.seq<e.seq)))fail('Actual earlier snapshot evidence required');}
 if(events.some(e=>e.kind==='revision'&&[r.id,c.id,d.id].includes(e.payload.supersedes)))fail('Decision evidence revised; new linked decision required');
 if(!Number.isSafeInteger(p.quantity)||p.quantity<1||!Number.isSafeInteger(p.limit_price_cents)||p.limit_price_cents<=0||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(p.valid_until||'')||Date.parse(p.valid_until)<=Date.parse(now)||!Number.isFinite(Date.parse(p.valid_until)))fail('Explicit whole quantity, cent limit and unexpired decision required');
 const size=moneyToCents(p.size);if(size<=0||BigInt(p.quantity)*BigInt(p.limit_price_cents)>BigInt(size))fail('Explicit decision budget does not cover quantity at limit');
 return d;
}
/** Only physical cash and owned inventory constrain size; no old concentration or turnover caps. */
export function managedOrderCheck(order,{portfolio,snapshot,now=isoNow(),valid_until,ends_at,broker_basis,fee_reserve_cents=0}){
 const errors=[];if(!Number.isSafeInteger(order.quantity)||order.quantity<1||!Number.isSafeInteger(order.limit_price_cents)||order.limit_price_cents<=0)errors.push('Whole quantity and positive cent limit required');
 if(!['buy','sell'].includes(order.side))errors.push('Only funded buys and owned sales');
 if(!Number.isSafeInteger(fee_reserve_cents)||fee_reserve_cents<0)errors.push('Explicit nonnegative fee reserve required');
 if(!fresh(snapshot?.retrieved_at,now)||!fresh(snapshot?.clock?.timestamp,now)||snapshot?.clock?.is_open!==true)errors.push('Fresh regular-session account/clock required');
 errors.push(...sessionBoundaryErrors(snapshot?.clock,Date.parse(now)));
 if(!Array.isArray(snapshot?.open_orders)||snapshot.open_orders.length)errors.push('Open commitments must be reconciled before another order');
 for(const s of new Set([order.symbol,...Object.keys(portfolio?.holdings||{}),'SPY']))if(!fresh(snapshot?.quotes?.[s]?.market_data_at,now)||snapshot.quotes[s].feed!=='iex'||!Number.isFinite(snapshot.quotes[s].price)||snapshot.quotes[s].price<=0)errors.push('Fresh actual IEX mark required: '+s);
 if(!Number.isFinite(Date.parse(valid_until))||Date.parse(valid_until)<=Date.parse(now)||Date.parse(valid_until)>Date.parse(snapshot?.clock?.next_close)||!Number.isFinite(Date.parse(ends_at))||Date.parse(now)>=Date.parse(ends_at))errors.push('Decision or experiment authority expired/outside regular session');
 try{
 if(!brokerCashMatches(portfolio,snapshot.account.cash_text??snapshot.account.cash))errors.push('Broker cash differs from ledger');
 const holdings=Object.entries(portfolio.holdings);if(!Array.isArray(snapshot.positions)||holdings.length!==snapshot.positions.length||new Set(snapshot.positions.map(p=>p.symbol)).size!==snapshot.positions.length||snapshot.positions.some(p=>!portfolio.holdings[p.symbol]||p.quantity!==portfolio.holdings[p.symbol].quantity||(!broker_basis&&!brokerBasisMatches(portfolio.holdings[p.symbol],p.cost_basis_text??p.cost_basis))))errors.push('Broker quantities/basis differ from ledger');
 if(broker_basis&&!brokerBasisComparison(broker_basis,snapshot.positions).matched)errors.push('Broker basis differs from receipt-derived broker projection');
 const cash=portfolio.accounting_policy==='usd-nano-v1'?BigInt(portfolio.cash_nanos):BigInt(portfolio.cash_cents)*USD_NANOS_PER_CENT;
 const cost=(BigInt(order.quantity)*BigInt(order.limit_price_cents)+BigInt(fee_reserve_cents))*USD_NANOS_PER_CENT;
 // Day limit bounds maximum purchase cost even when current last trade exceeds it; no market order or chasing.
 if(order.side==='buy'&&cost>cash)errors.push('Insufficient actual cash including fee reserve');
 if(order.side==='sell'&&order.quantity>(portfolio.holdings[order.symbol]?.quantity||0))errors.push('Cannot sell unowned shares');
 }catch{errors.push('Exact cash/inventory/fee evidence invalid');}
 return {ok:errors.length===0,errors};
}

/** Read-only account status; closed markets and stale quotes are separate runtime conditions. */
export function managedAccountProblem(events){
 if(cashActivityProblems(events).length)return 'Awaiting order/account checks: account activity evidence requires review.';
 const recon=events.filter(e=>e.kind==='reconciliation').at(-1);
 if(events.some(e=>e.kind==='order_intent'&&!events.some(c=>c.kind==='order_closed'&&c.payload.intent_id===e.id)))return 'Awaiting order/account checks: an order is open or its outcome is unresolved.';
 if(!recon||recon.payload.status!=='reconciled'||recon.payload.ledger_status!=='ready'||!Array.isArray(recon.payload.problems)||recon.payload.problems.length)return 'Awaiting order/account checks: broker reconciliation has not passed.';
 if(events.some(e=>e.seq>recon.seq&&[...CASH_ACTIVITY_KINDS,'ledger_fill','broker_activity','broker_order','order_closure_conflict','refresh_failed'].includes(e.kind)))return 'Awaiting order/account checks: new account evidence needs reconciliation.';
 return null;
}
