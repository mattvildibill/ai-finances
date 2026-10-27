import { exactWholeFillCents } from './precision.js';
/** Deterministic accounting. Monetary amounts are integer USD cents, never broker buying power. */
export const PAPER_ORIGIN = 'https://paper-api.alpaca.markets';
export const MANDATE = Object.freeze({ initial_cash_cents: 10_000_000, stock_weight: .10, etf_weight: .25, gross_weight: .90, cash_weight: .10, order_weight: .05, stale_seconds: 120, future_tolerance_seconds: 5, universe: Object.freeze(['AAPL', 'MSFT', 'SPY']) });
const integer = (n, name, min = 0) => { if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a safe integer >= ${min}`); return n; };
const quantity = n => { if (!Number.isFinite(n) || n <= 0) throw new Error('quantity must be positive and finite'); return n; };
const timestamp = (s, name) => { if (typeof s !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) throw new Error(`${name} must be a timestamp with timezone`); return Date.parse(s); };
const symbolCheck = s => { if (typeof s !== 'string' || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) throw new Error('Invalid symbol'); };
const canonical = value => {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
};
const copy = p => structuredClone(p);
export function moneyToCents(value) {
  const s = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('USD amount must have at most two decimal places');
  const negative = s.startsWith('-'); const [whole, fraction = ''] = s.replace('-', '').split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  integer(n, 'USD cents'); return negative ? -n : n;
}
export function initialPortfolio() { return { cash_cents: MANDATE.initial_cash_cents, holdings: {}, realized_pnl_cents: 0, income_cents: 0, fees_cents: 0, events: [] }; }
function assertPortfolio(p) {
  integer(p.cash_cents, 'cash');
  if (!p.holdings || typeof p.holdings !== 'object' || Array.isArray(p.holdings)) throw new Error('holdings required');
  for (const [symbol, holding] of Object.entries(p.holdings)) { symbolCheck(symbol); quantity(holding.quantity); integer(holding.cost_cents, 'cost'); }
}
function eventPortfolio(p, kind, event) {
  assertPortfolio(p);
  if (!event || typeof event.id !== 'string' || event.id.length < 1 || event.id.length > 200) throw new Error('Event ID required');
  symbolCheck(event.symbol);
  const occurred = timestamp(event.occurred_at, 'occurred_at');
  const observed = timestamp(event.observed_at, 'observed_at');
  if (observed < occurred) throw new Error('An event cannot be observed before it occurs');
  const signature = canonical(event);
  const previous = (p.events || []).find(e => e.id === event.id);
  if (previous) {
    if (previous.kind !== kind || previous.signature !== signature) throw new Error('Event ID reused with different content');
    return { portfolio: copy(p), duplicate: true };
  }
  const next = copy(p);
  next.events ??= [];
  next.events.push({ ...copy(event), id: event.id, kind, signature });
  return { portfolio: next, duplicate: false };
}
export function applyFill(p, fill) {
  const { portfolio: next, duplicate } = eventPortfolio(p, 'fill', fill); if (duplicate) return next;
  quantity(fill.quantity); if (fill.price_text === undefined) integer(fill.price_cents, 'price', 1); else if (fill.price_cents !== undefined) throw new Error('Use one unambiguous fill price representation'); integer(fill.fee_cents ?? 0, 'fee');
  if (!['buy', 'sell'].includes(fill.side)) throw new Error('Only buy/sell fills supported');
  const notional = fill.price_text === undefined ? integer(Math.round(fill.quantity * fill.price_cents), 'notional', 1) : exactWholeFillCents(fill.quantity, fill.price_text);
  const fee = fill.fee_cents ?? 0;
  const holding = next.holdings[fill.symbol] || { quantity: 0, cost_cents: 0 };
  if (fill.side === 'buy') {
    if (notional + fee > next.cash_cents) throw new Error('Fill would require leverage');
    next.cash_cents -= notional + fee;
    next.holdings[fill.symbol] = { quantity: holding.quantity + fill.quantity, cost_cents: integer(holding.cost_cents + notional + fee, 'cost') };
  } else {
    if (fill.quantity > holding.quantity) throw new Error('Fill would create a short position');
    if (notional < fee) throw new Error('Fees exceed sale proceeds');
    const soldCost = fill.quantity === holding.quantity ? holding.cost_cents : Math.round(holding.cost_cents * fill.quantity / holding.quantity);
    next.cash_cents = integer(next.cash_cents + notional - fee, 'cash');
    next.realized_pnl_cents = integer((next.realized_pnl_cents || 0) + notional - fee - soldCost, 'realized P&L', -Number.MAX_SAFE_INTEGER);
    if (fill.quantity === holding.quantity) delete next.holdings[fill.symbol];
    else next.holdings[fill.symbol] = { quantity: holding.quantity - fill.quantity, cost_cents: holding.cost_cents - soldCost };
  }
  next.fees_cents = integer((next.fees_cents || 0) + fee, 'fees');
  return next;
}
export function applyDistribution(p, distribution) {
  const { portfolio: next, duplicate } = eventPortfolio(p, 'distribution', distribution); if (duplicate) return next;
  integer(distribution.amount_cents, 'distribution', 1);
  // Explicit entitlement amount is evidence-backed externally; an ex-date holder may have sold before payment.
  next.cash_cents = integer(next.cash_cents + distribution.amount_cents, 'cash');
  next.income_cents = integer((next.income_cents || 0) + distribution.amount_cents, 'income');
  return next;
}
export function applySplit(p, split) {
  const { portfolio: next, duplicate } = eventPortfolio(p, 'split', split); if (duplicate) return next;
  integer(split.numerator, 'split numerator', 1); integer(split.denominator, 'split denominator', 1);
  if (!next.holdings[split.symbol]) throw new Error('Split requires a held position');
  next.holdings[split.symbol].quantity = quantity(next.holdings[split.symbol].quantity * split.numerator / split.denominator);
  // Total basis is unchanged. Cash in lieu requires a separate evidenced transaction, never an inferred payment.
  return next;
}
export function portfolioValue(p, prices) {
  assertPortfolio(p); let holdings_cents = 0; let cost_cents = 0;
  const holdings = Object.entries(p.holdings).map(([symbol, h]) => {
    const price_cents = integer(prices[symbol], `price for ${symbol}`, 1);
    const value_cents = integer(Math.round(h.quantity * price_cents), 'position value');
    holdings_cents = integer(holdings_cents + value_cents, 'holdings value'); cost_cents += h.cost_cents;
    return { symbol, ...h, price_cents, value_cents, unrealized_pnl_cents: value_cents - h.cost_cents };
  });
  const value_cents = integer(p.cash_cents + holdings_cents, 'NAV');
  return { cash_cents: p.cash_cents, value_cents, holdings_cents, unrealized_pnl_cents: holdings_cents - cost_cents, realized_pnl_cents: p.realized_pnl_cents || 0, income_cents: p.income_cents || 0, fees_cents: p.fees_cents || 0, gross_weight: value_cents ? holdings_cents / value_cents : null, holdings: holdings.map(h => ({ ...h, weight: value_cents ? h.value_cents / value_cents : null })) };
}
function freshness(time, now, label, errors) {
  try { const age = (now - timestamp(time, label)) / 1000; if (age > MANDATE.stale_seconds) errors.push(`${label} is stale`); if (age < -MANDATE.future_tolerance_seconds) errors.push(`${label} is in the future`); } catch { errors.push(`${label} is missing or invalid`); }
}
export function validateOrder(order, context = {}) {
  const errors = []; let projected = null;
  if (context.runtime_verified !== true) errors.push('Operating workflow is not verified');
  if (context.experiment_status !== 'active') errors.push('Experiment is paused');
  if (context.paper_endpoint !== PAPER_ORIGIN) errors.push('Only the fixed Alpaca paper origin is permitted');
  let now; try { now = timestamp(context.now, 'now'); } catch { errors.push('Current server time is required'); }
  if (context.clock?.is_open !== true) errors.push('Regular market session is closed or unknown');
  freshness(context.clock?.timestamp, now, 'Market clock', errors);
  if (!Array.isArray(context.open_orders) || context.open_orders.length !== 0) errors.push('Open or uncertain orders must be reconciled first');
  if (!MANDATE.universe.includes(order?.symbol)) errors.push('Symbol is outside the approved US stock/ETF universe');
  if (!['buy', 'sell'].includes(order?.side)) errors.push('Only long-only buy/sell orders are supported');
  if (order?.type && order.type !== 'limit') errors.push('Only limit orders are permitted');
  if (order?.time_in_force && order.time_in_force !== 'day') errors.push('Only day orders are permitted');
  if (order?.extended_hours) errors.push('Extended-hours execution is disabled');
  try {
    integer(order?.quantity, 'whole-share order quantity', 1); integer(order?.limit_price_cents, 'limit price', 1);
    const quotes = context.prices || {}; const prices = {};
    for (const symbol of new Set([order.symbol, ...Object.keys(context.portfolio?.holdings || {})])) {
      const q = quotes[symbol]; integer(q?.price_cents, `price for ${symbol}`, 1); freshness(q?.market_time, now, `${symbol} price`, errors); prices[symbol] = q.price_cents;
    }
    const current = portfolioValue(context.portfolio, prices);
    // Reserve worst-case buy cost at limit; sales use the lower of quote and limit for conservative sizing.
    const price = order.side === 'buy' ? Math.max(order.limit_price_cents, prices[order.symbol]) : Math.min(order.limit_price_cents, prices[order.symbol]);
    const notional = integer(Math.round(order.quantity * price), 'order notional', 1);
    if (notional > current.value_cents * MANDATE.order_weight) errors.push('Order exceeds 5% of NAV');
    const held = context.portfolio.holdings[order.symbol]?.quantity || 0;
    if (order.side === 'sell' && order.quantity > held) errors.push('Selling unowned shares is prohibited');
    if (order.side === 'buy') {
      const cashAfter = context.portfolio.cash_cents - notional;
      const positionAfter = held * prices[order.symbol] + notional;
      const cap = order.symbol === 'SPY' ? MANDATE.etf_weight : MANDATE.stock_weight;
      if (cashAfter < 0) errors.push('Order would require leverage');
      if (cashAfter < current.value_cents * MANDATE.cash_weight) errors.push('Order breaches the 10% cash reserve');
      if (positionAfter > current.value_cents * cap) errors.push(`Position exceeds ${cap * 100}% concentration limit`);
      if (current.holdings_cents + notional > current.value_cents * MANDATE.gross_weight) errors.push('Order breaches 90% gross exposure limit');
      projected = { reserved_cash_cents: cashAfter, position_value_cents: Math.round(positionAfter), order_notional_cents: notional };
    } else projected = { order_notional_cents: notional };
  } catch (e) { errors.push(e.message); }
  return { ok: errors.length === 0, errors, projected };
}
export function createBenchmark({ started_at, observed_at, price_cents, market_time, initial_cash_cents = MANDATE.initial_cash_cents }) {
  const now = timestamp(started_at, 'started_at'); timestamp(observed_at, 'observed_at'); integer(price_cents, 'SPY price', 1); integer(initial_cash_cents, 'initial cash', 1);
  if (Date.parse(observed_at) > now) throw new Error('Benchmark cannot use information observed after its start');
  if (now - Date.parse(observed_at) > MANDATE.stale_seconds * 1000) throw new Error('Benchmark observation is stale');
  const errors = []; freshness(market_time, now, 'SPY price', errors); if (errors.length) throw new Error(errors.join('; '));
  const shares = Math.floor(initial_cash_cents / price_cents);
  if (!shares) throw new Error('Insufficient capital for benchmark');
  return { started_at, observed_at, market_time, source: 'Alpaca IEX', execution: 'analytical reference at observed price; not an Alpaca fill', holdings: { SPY: { quantity: shares, cost_cents: shares * price_cents } }, cash_cents: initial_cash_cents - shares * price_cents, realized_pnl_cents: 0, income_cents: 0, fees_cents: 0, events: [] };
}
/** Daily closing NAV observations only, with external flows already excluded/adjusted. */
export function riskMetrics(observations) {
  if (!Array.isArray(observations)) throw new Error('Observations must be an array');
  const points = observations.map(p => ({ at: timestamp(p.at, 'NAV time'), value: integer(p.value_cents, 'NAV', 1) }));
  for (let i = 1; i < points.length; i++) if (points[i].at <= points[i - 1].at) throw new Error('NAV observations must be chronological and unique');
  const days = points.map(p => new Date(p.at).toISOString().slice(0, 10));
  if (new Set(days).size !== days.length) throw new Error('Risk series must contain at most one daily closing NAV');
  if (points.length < 2) return { observations: points.length, total_return: null, max_drawdown: null, annualized_volatility: null, volatility_status: 'At least 21 daily closing NAV observations required' };
  let peak = points[0].value; let max_drawdown = 0; const returns = [];
  for (let i = 0; i < points.length; i++) { peak = Math.max(peak, points[i].value); max_drawdown = Math.min(max_drawdown, points[i].value / peak - 1); if (i) returns.push(points[i].value / points[i - 1].value - 1); }
  let annualized_volatility = null;
  if (returns.length >= 20) { const mean = returns.reduce((a, b) => a + b, 0) / returns.length; annualized_volatility = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1)) * Math.sqrt(252); }
  return { observations: points.length, total_return: points.at(-1).value / points[0].value - 1, max_drawdown, annualized_volatility, volatility_status: annualized_volatility === null ? 'At least 21 daily closing NAV observations required' : 'Sample standard deviation of daily returns, annualized with 252 sessions' };
}
