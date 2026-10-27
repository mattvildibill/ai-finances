import {ledgerView} from './valuation.js';
import {portfolioValue,moneyToCents} from './finance.js';
import {usdNanos} from './precision.js';
import {rebuildLedger} from './reconciliation.js';
import {readCompleteHistory} from './history.js';
import {ACTION_KINDS} from './action-ledger.js';
const LEDGER_KINDS=new Set(['mandate_amendment','experiment_opened','order_intent','order_submitted','order_observed','broker_order','order_closed','order_closure_conflict','broker_activity','ledger_fill','refresh_failed',...ACTION_KINDS]);

const unavailable=view=>({...view,portfolio:{...view.portfolio,value:null,value_nanos:null,economic_value:null,economic_value_nanos:null,gain:null,total_return:null,price_return:null,as_of:null,comparison_complete:false,valuation_status:'unavailable',holdings:view.portfolio.holdings.map(h=>({...h,market_value:null,unrealized_pl:null,weight:null}))},benchmark:{...view.benchmark,status:'unavailable',value:null,price_value:null,value_nanos:null,economic_value_nanos:null,return:null,price_return:null,excess_return:null},risk:{...view.risk,gross_exposure:null,cash_weight:null,largest_position:null}});

/** Display-only observed marks. Never used by risk, admission or order execution. */
export function observedLedgerView(ledger,snapshot,asOf,reconciliation){
 const base=ledgerView(ledger,snapshot,asOf,reconciliation);
 if(ledger.status!=='ready')return base;
 if(base.account_drift!==false||!snapshot||!reconciliation||reconciliation.payload.status!=='reconciled'||reconciliation.payload.problems?.length||reconciliation.seq<snapshot.seq||reconciliation.seq<(ledger.last_evidence_seq||0))return unavailable(base);
 const cutoff=Date.parse(asOf),received=Date.parse(snapshot.created_at);
 if(!Number.isFinite(received)||received>cutoff)return unavailable(base);
 const symbols=[...new Set([...Object.keys(ledger.portfolio.holdings),...Object.keys(ledger.benchmark.holdings)])],prices={},marks=[];
 try{
  for(const symbol of symbols){
   const q=snapshot.payload.quotes?.[symbol],at=Date.parse(q?.market_data_at);
   if(q?.feed!=='iex'||!Number.isFinite(at)||at>received||at>cutoff)throw new Error('Unavailable observed mark');
   const retrieved=q.retrieved_at??snapshot.payload.retrieved_at??null;
   if(retrieved!==null&&(!Number.isFinite(Date.parse(retrieved))||Date.parse(retrieved)>received||Date.parse(retrieved)>cutoff))throw new Error('Invalid retrieval provenance');
   const text=q.price_text??String(q.price);const nanos=usdNanos(text);if(nanos<=0n)throw new Error('Nonpositive mark');
   prices[symbol]=ledger.portfolio.accounting_policy==='usd-nano-v1'?{nanos:nanos.toString()}:moneyToCents(text);
   marks.push({symbol,price_text:text,market_data_at:q.market_data_at,retrieved_at:retrieved,feed:q.feed,source:q.source??snapshot.payload.source??null,age_seconds:Math.max(0,(cutoff-at)/1000)});
  }
  const active=portfolioValue(ledger.portfolio,prices),passive=portfolioValue(ledger.benchmark,prices);
  const dollars=m=>m.value_nanos!==undefined?Number(m.value_nanos)/1e9:m.value_cents/100;
  const income=(name)=>{const i=ledger.economic?.[name];return i?.receivable_nanos!==undefined?(BigInt(i.receivable_nanos)+BigInt(i.distribution_cash_nanos||'0')):BigInt((i?.receivable_cents||0)+(i?.distribution_cash_cents||0))*10000000n;};
  const total=(m,name)=>m.value_nanos!==undefined?(BigInt(m.value_nanos)+income(name)).toString():null;
  const complete=ledger.action_coverage?.ok===true;
  const activeTotal=complete?(total(active,'active')!==null?Number(total(active,'active'))/1e9:dollars(active)+Number(income('active'))/1e9):null;
  const passiveTotal=complete?(total(passive,'benchmark')!==null?Number(total(passive,'benchmark'))/1e9:dollars(passive)+Number(income('benchmark'))/1e9):null;
  const stale=marks.some(q=>q.age_seconds>120)||cutoff-received>120000||cutoff-Date.parse(reconciliation.created_at)>120000;
  const observation={snapshot_id:snapshot.id,snapshot_digest:snapshot.digest,reconciliation_id:reconciliation.id,reconciliation_digest:reconciliation.digest,observed_at:snapshot.created_at,accounting_cutoff:reconciliation.created_at,marks,official_close:false,execution_authorization:false};
  return {...base,portfolio:{...base.portfolio,value:dollars(active),value_nanos:active.value_nanos??null,economic_value:activeTotal,economic_value_nanos:complete?total(active,'active'):null,gain:activeTotal===null?null:activeTotal-100000,total_return:activeTotal===null?null:activeTotal/100000-1,price_return:dollars(active)/100000-1,holdings:base.portfolio.holdings.map(h=>{const m=active.holdings.find(x=>x.symbol===h.symbol);return {...h,market_value:m.value_nanos!==undefined?Number(m.value_nanos)/1e9:m.value_cents/100,unrealized_pl:m.unrealized_pnl_nanos!==undefined?Number(m.unrealized_pnl_nanos)/1e9:m.unrealized_pnl_cents/100,weight:m.weight};}),as_of:snapshot.created_at,observation,valuation_status:stale?'last_known':'available',comparison_complete:complete,performance_basis:complete?'Observed IEX marks plus reviewed modeled distributions; not official closing prices.':'Observed IEX price-only value; current action coverage incomplete.'},benchmark:{...base.benchmark,status:complete?(stale?'last_known':'modeled_total_return'):'incomplete',value:passiveTotal,price_value:dollars(passive),value_nanos:passive.value_nanos??null,economic_value_nanos:complete?total(passive,'benchmark'):null,return:passiveTotal===null?null:passiveTotal/100000-1,price_return:dollars(passive)/100000-1,excess_return:activeTotal===null||passiveTotal===null?null:(activeTotal-passiveTotal)/100000,observation,reason:'Observed IEX marks; not an official daily close.'},risk:{...base.risk,gross_exposure:active.gross_weight,cash_weight:base.portfolio.cash/dollars(active),largest_position:Math.max(0,...active.holdings.map(h=>h.weight)),observation_status:stale?'last_known':'available'} };
 }catch{return unavailable(base);}
}

/** Bounded full receipt-time replay; dots are observations, never interpolated daily closes. */
export async function observedValuationHistory(db,asOf){
 let events;try{events=await readCompleteHistory(db,asOf);}catch(error){return {schema:'observed-nav-v1',points:[],status:'unavailable',reason:'Complete journal unavailable; no partial valuation replay presented.'};}
 const receipts=events.filter(e=>e.kind==='reconciliation'&&e.payload.status==='reconciled');
 const candidates=receipts.slice(-200),points=[],seen=new Set();let omitted=0;
 for(const receipt of candidates){
  const known=events.filter(e=>e.seq<=receipt.seq&&e.created_at<=receipt.created_at),snapshot=known.filter(e=>e.kind==='snapshot').at(-1);
  if(!snapshot)continue;
  // The authoritative pure rebuild ignores unrelated event kinds. Include full known action/fill history.
  const relevant=known.filter(e=>LEDGER_KINDS.has(e.kind));
  const ledger=rebuildLedger(relevant,receipt.created_at),view=observedLedgerView(ledger,snapshot,receipt.created_at,receipt);
  if(!view.portfolio.observation||view.portfolio.economic_value===null||view.benchmark.value===null){omitted++;continue;}
  const key=snapshot.id+':'+ledger.last_evidence_seq;if(seen.has(key))continue;seen.add(key);
  points.push({at:receipt.created_at,knowledge_seq:receipt.seq,snapshot_id:snapshot.id,snapshot_digest:snapshot.digest,reconciliation_id:receipt.id,reconciliation_digest:receipt.digest,value:view.portfolio.economic_value,benchmark_value:view.benchmark.value,cash:view.portfolio.cash,holdings:view.portfolio.holdings,portfolio_value_nanos:view.portfolio.economic_value_nanos,benchmark_value_nanos:view.benchmark.economic_value_nanos,valuation_status:view.portfolio.valuation_status,marks:view.portfolio.observation.marks,observed_at:snapshot.created_at,official_close:false});
 }
 return {schema:'observed-nav-v1',status:points.length?'available':'unavailable',basis:'Observed IEX marks and receipt-time official accounting, including separately modeled distributions; not official daily closes.',points,omitted_unverified:omitted,truncated:receipts.length>200,complete_history_read:true,interpolation:false};
}
