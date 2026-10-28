import {usdNanos} from './precision.js';
import { initialPortfolio, moneyToCents, portfolioValue, brokerCashMatches, brokerBasisMatches, brokerBasisComparison } from './finance.js';
import { fresh } from './readiness.js';
/** Receipt-time ledger facts, marked only by fresh observations known at that replay time. */
export function ledgerView(ledger,snapshot,asOf,reconciliation) {
 const unstarted=ledger.status==='not_started';const ready=ledger.status==='ready';
 const portfolio=unstarted?initialPortfolio():ready?ledger.portfolio:null;
 const p=snapshot?.payload;const prices={};const accountDrift=brokerDrift(portfolio,p,ledger.broker_basis);
 for(const [symbol,q] of Object.entries(p?.quotes||{})){
  if(q.feed!=='iex'||!fresh(q.market_data_at,asOf)||!fresh(snapshot.created_at,asOf)||Date.parse(q.market_data_at)>Date.parse(asOf))continue;
  try{prices[symbol]=portfolio?.accounting_policy==='usd-nano-v1'?{nanos:usdNanos(q.price_text??String(q.price)).toString()}:moneyToCents(String(q.price));}catch{}
 }
 const mark = value => {try{return portfolioValue(value,prices);}catch{return null;}};
 const accountingBlocked=ready&&reconciliation?.payload.status==='blocked'&&reconciliation.payload.problems?.some(p=>p.code!=='corporate_actions_unverified');
 const incomplete=ready&&(!reconciliation||reconciliation.payload.status!=='reconciled'||!fresh(reconciliation.created_at,asOf)||reconciliation.seq<(ledger.last_evidence_seq||0)||!ledger.action_coverage?.ok||accountDrift!==false||reconciliation.seq<(snapshot?.seq||0));
 const active=portfolio&&!accountingBlocked?mark(portfolio):null;const passive=ready&&!accountingBlocked&&ledger.benchmark?mark(ledger.benchmark):null;
 const holdings=portfolio?Object.entries(portfolio.holdings).map(([symbol,h])=>{
  const m=active?.holdings.find(x=>x.symbol===symbol);
  return {symbol,quantity:h.quantity,cost_basis:h.cost_nanos!==undefined?Number(h.cost_nanos)/1e9:h.cost_cents/100,...(h.cost_nanos!==undefined?{cost_nanos:h.cost_nanos}:{}),market_value:m?(m.value_nanos!==undefined?Number(m.value_nanos)/1e9:m.value_cents/100):null,unrealized_pl:m?(m.unrealized_pnl_nanos!==undefined?Number(m.unrealized_pnl_nanos)/1e9:m.unrealized_pnl_cents/100):null,weight:m?.weight??null};
 }):[];
 // An unresolved accounting action invalidates performance, even if price marks happen to exist.
 const supported=ready&&!incomplete&&!accountingBlocked;
 const activeIncome=ledger.economic?.active;const passiveIncome=ledger.economic?.benchmark;
 const economicTotal=(marked,income)=>{if(marked.value_nanos!==undefined)return Number(BigInt(marked.value_nanos)+BigInt(income?.receivable_nanos||'0')+BigInt(income?.distribution_cash_nanos||'0'))/1e7;const n=marked.value_cents+(income?.receivable_cents||0)+(income?.distribution_cash_cents||0);return Number.isSafeInteger(n)&&n>=0?n:null;};
 const economicValue=active&&supported?economicTotal(active,activeIncome):null;
 const benchmarkValue=passive&&supported?economicTotal(passive,passiveIncome):null;
 const basis=unstarted?'Not started.':supported?'Unadjusted prices plus reviewed modeled ordinary distributions; no reinvestment. Modeled income is not executable broker cash.':'Comparison incomplete: reviewed action coverage and reconciliation required.';
 return {
  portfolio:{...(portfolio?.accounting_policy==='usd-nano-v1'?{accounting_policy:portfolio.accounting_policy,cash_nanos:portfolio.cash_nanos,realized_pnl_nanos:portfolio.realized_pnl_nanos,value_nanos:active?.value_nanos??null,economic_value_nanos:active&&supported?(BigInt(active.value_nanos)+BigInt(activeIncome?.receivable_nanos||'0')+BigInt(activeIncome?.distribution_cash_nanos||'0')).toString():null}:{}),fees:portfolio?(portfolio.fees_nanos!==undefined?Number(portfolio.fees_nanos)/1e9:portfolio.fees_cents/100):null,fees_nanos:portfolio?.fees_nanos??null,fee_policy:'Actual broker CAT charges reduce active cash and performance. No hypothetical benchmark charge is inferred.',cash:portfolio?(portfolio.cash_nanos!==undefined?Number(portfolio.cash_nanos)/1e9:portfolio.cash_cents/100):null,value:active?(active.value_nanos!==undefined?Number(active.value_nanos)/1e9:active.value_cents/100):null,holdings,gain:economicValue!==null?(economicValue-10000000)/100:null,total_return:economicValue!==null?economicValue/10000000-1:null,price_return:ready&&active&&!incomplete?(active.value_nanos!==undefined?Number(active.value_nanos)/1e14:active.value_cents/10000000)-1:null,economic_value:economicValue!==null?economicValue/100:null,modeled_income:activeIncome||null,basis_method:'Analytical weighted-average; broker intraday/compressed-FIFO projection is separate.',source:unstarted?'Unstarted experiment allocation':ready?'Official append-only ledger':'Accounting blocked',as_of:active?asOf:null,performance_basis:basis,comparison_complete:supported&&economicValue!==null&&benchmarkValue!==null,valuation_status:active?'available':'unavailable',holdings_status:portfolio?'known':'unknown'},
  benchmark:{...(passive?.value_nanos!==undefined?{value_nanos:passive.value_nanos,economic_value_nanos:supported?(BigInt(passive.value_nanos)+BigInt(passiveIncome?.receivable_nanos||'0')+BigInt(passiveIncome?.distribution_cash_nanos||'0')).toString():null}:{}),status:unstarted?'not_started':accountingBlocked||incomplete?'incomplete':passive?'modeled_total_return':'unavailable',symbol:'SPY',started_at:ledger.started_at,value:benchmarkValue!==null?benchmarkValue/100:null,price_value:passive?(passive.value_nanos!==undefined?Number(passive.value_nanos)/1e9:passive.value_cents/100):null,modeled_income:passiveIncome||null,return:benchmarkValue!==null?benchmarkValue/10000000-1:null,price_return:passive&&!incomplete?(passive.value_nanos!==undefined?Number(passive.value_nanos)/1e14:passive.value_cents/10000000)-1:null,excess_return:economicValue!==null&&benchmarkValue!==null?(economicValue-benchmarkValue)/10000000:null,reason:basis},
  risk:{gross_exposure:active?.gross_weight??null,cash_weight:active?(active.value_nanos!==undefined?Number(active.cash_nanos)/Number(active.value_nanos):active.cash_cents/active.value_cents):null,largest_position:active?Math.max(0,...active.holdings.map(h=>h.weight)):null,annualized_volatility:null,max_drawdown:null,beta:null,reason:'Sufficient validated daily closing observations are not available.'},
  account_drift:accountDrift
 };
}
function brokerDrift(portfolio,snapshot,brokerBasis){
 if(!snapshot||!portfolio)return null;
 try{
  if(snapshot.account.cash_text!==undefined && Number(snapshot.account.cash_text)!==snapshot.account.cash)return true;
  if(!brokerCashMatches(portfolio,snapshot.account.cash_text??snapshot.account.cash)||!Array.isArray(snapshot.positions))return true;
  const expected=Object.entries(portfolio.holdings);if(snapshot.positions.length!==expected.length)return true;
  const seen=new Set();
  for(const p of snapshot.positions){if(seen.has(p.symbol)||p.side!=='long'||portfolio.holdings[p.symbol]?.quantity!==p.quantity)return true;if(!brokerBasis&&portfolio.accounting_policy==='usd-nano-v1'&&!brokerBasisMatches(portfolio.holdings[p.symbol],p.cost_basis_text??p.cost_basis))return true;seen.add(p.symbol);}
  if(brokerBasis&&!brokerBasisComparison(brokerBasis,snapshot.positions).matched)return true;
  return false;
 }catch{return true;}
}
