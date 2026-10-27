import { initialPortfolio, moneyToCents, portfolioValue } from './finance.js';
import { fresh } from './readiness.js';
/** Receipt-time ledger facts, marked only by fresh observations known at that replay time. */
export function ledgerView(ledger,snapshot,asOf,reconciliation) {
 const unstarted=ledger.status==='not_started';const ready=ledger.status==='ready';
 const portfolio=unstarted?initialPortfolio():ready?ledger.portfolio:null;
 const p=snapshot?.payload;const prices={};
 for(const [symbol,q] of Object.entries(p?.quotes||{})){
  if(q.feed!=='iex'||!fresh(q.market_data_at,asOf)||!fresh(snapshot.created_at,asOf)||Date.parse(q.market_data_at)>Date.parse(asOf))continue;
  try{prices[symbol]=moneyToCents(String(q.price));}catch{}
 }
 const mark = value => {try{return portfolioValue(value,prices);}catch{return null;}};
 const accountingBlocked=ready&&reconciliation?.payload.status==='blocked'&&reconciliation.payload.problems?.some(p=>p.code!=='corporate_actions_unverified');
 const incomplete=ready&&(!reconciliation||reconciliation.payload.status!=='reconciled');
 const active=portfolio&&!accountingBlocked?mark(portfolio):null;const passive=ready&&!accountingBlocked&&ledger.benchmark?mark(ledger.benchmark):null;
 const holdings=portfolio?Object.entries(portfolio.holdings).map(([symbol,h])=>{
  const m=active?.holdings.find(x=>x.symbol===symbol);
  return {symbol,quantity:h.quantity,cost_basis:h.cost_cents/100,market_value:m?m.value_cents/100:null,unrealized_pl:m?m.unrealized_pnl_cents/100:null,weight:m?.weight??null};
 }):[];
 // An unresolved accounting action invalidates performance, even if price marks happen to exist.
 const basis=unstarted?'Not started.':'Price-only, distributions and some costs excluded; total return unavailable.';
 return {
  portfolio:{cash:portfolio?portfolio.cash_cents/100:null,value:active?active.value_cents/100:null,holdings,gain:ready&&active&&!incomplete?(active.value_cents-10000000)/100:null,total_return:ready&&active&&!incomplete?active.value_cents/10000000-1:null,source:unstarted?'Unstarted experiment allocation':ready?'Official append-only ledger':'Accounting blocked',as_of:active?asOf:null,performance_basis:basis,comparison_complete:ready&&!incomplete&&!accountingBlocked,valuation_status:active?'available':'unavailable',holdings_status:portfolio?'known':'unknown'},
  benchmark:{status:unstarted?'not_started':accountingBlocked||incomplete?'incomplete':passive?'price_only':'unavailable',symbol:'SPY',started_at:ledger.started_at,value:passive?passive.value_cents/100:null,return:passive&&!incomplete?passive.value_cents/10000000-1:null,excess_return:active&&passive&&!incomplete?(active.value_cents-passive.value_cents)/10000000:null,reason:basis},
  risk:{gross_exposure:active?.gross_weight??null,cash_weight:active?active.cash_cents/active.value_cents:null,largest_position:active?Math.max(0,...active.holdings.map(h=>h.weight)):null,annualized_volatility:null,max_drawdown:null,beta:null,reason:'Sufficient validated daily closing observations are not available.'},
  account_drift:brokerDrift(portfolio,p)
 };
}
function brokerDrift(portfolio,snapshot){
 if(!snapshot||!portfolio)return null;
 try{
  if(moneyToCents(String(snapshot.account.cash))!==portfolio.cash_cents||!Array.isArray(snapshot.positions))return true;
  const expected=Object.entries(portfolio.holdings);if(snapshot.positions.length!==expected.length)return true;
  const seen=new Set();
  for(const p of snapshot.positions){if(seen.has(p.symbol)||p.side!=='long'||portfolio.holdings[p.symbol]?.quantity!==p.quantity)return true;seen.add(p.symbol);}
  return false;
 }catch{return true;}
}
