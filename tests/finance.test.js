import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyToCents, initialPortfolio, applyFill, applyDistribution, applySplit, portfolioValue, validateOrder, createBenchmark, riskMetrics, PAPER_ORIGIN } from '../lib/finance.js';
const at = '2026-10-26T15:00:00Z';
const fill = (id, side = 'buy', quantity = 10, price_cents = 10000, fee_cents = 0) => ({ id, symbol: 'AAPL', side, quantity, price_cents, fee_cents, occurred_at: at, observed_at: at });
const context = () => ({ runtime_verified: true, experiment_status: 'active', paper_endpoint: PAPER_ORIGIN, now: at, clock: { timestamp: at, is_open: true, next_close: '2026-10-26T20:00:00Z', next_open: '2026-10-27T13:30:00Z' }, portfolio: initialPortfolio(), prices: { AAPL: { price_cents: 10000, market_time: at }, SPY: { price_cents: 50000, market_time: at } }, open_orders: [] });
const order = { symbol: 'AAPL', side: 'buy', quantity: 10, limit_price_cents: 10000, type: 'limit', time_in_force: 'day' };
test('money conversion is exact and refuses silent precision loss', () => {
  assert.equal(moneyToCents('100000.00'), 10000000); assert.equal(moneyToCents('0.29'), 29); assert.equal(moneyToCents('-1.01'), -101);
  for (const value of ['1.001', '1e4', 'NaN', 'Infinity', Number.MAX_SAFE_INTEGER]) assert.throws(() => moneyToCents(value));
});
test('buy and partial/full sell preserve cash, basis, net realized gains, and fees', () => {
  const original = initialPortfolio(); const bought = applyFill(original, fill('b', 'buy', 3, 10000, 1));
  assert.equal(original.cash_cents, 10000000); assert.deepEqual(original.holdings, {});
  assert.equal(bought.cash_cents, 9969999); assert.equal(bought.holdings.AAPL.cost_cents, 30001);
  const partial = applyFill(bought, fill('s1', 'sell', 1, 11000, 2));
  assert.equal(partial.holdings.AAPL.cost_cents, 20001); assert.equal(partial.realized_pnl_cents, 998);
  const sold = applyFill(partial, fill('s2', 'sell', 2, 12000, 2));
  assert.deepEqual(sold.holdings, {}); assert.equal(sold.realized_pnl_cents, 4995); assert.equal(sold.cash_cents, 10004995); assert.equal(sold.fees_cents, 5);
});
test('fractional share fills allocate basis without losing a cent', () => {
  let p = applyFill(initialPortfolio(), fill('b', 'buy', .3, 10101));
  p = applyFill(p, fill('s', 'sell', .1, 10101));
  p = applyFill(p, fill('s2', 'sell', p.holdings.AAPL.quantity, 10101));
  assert.equal(p.cash_cents, 10000000); assert.deepEqual(p.holdings, {});
});
test('fill retry is idempotent; payload conflict is rejected', () => {
  const f = fill('unique'); const p = applyFill(initialPortfolio(), f);
  assert.deepEqual(applyFill(p, f), p); assert.throws(() => applyFill(p, { ...f, quantity: 11 }), /reused/); assert.equal(p.events.length, 1);
});
test('accounting refuses short sales, borrowed cash, invalid events, unsafe amounts', () => {
  assert.throws(() => applyFill(initialPortfolio(), fill('short', 'sell')), /short/);
  assert.throws(() => applyFill(initialPortfolio(), fill('leverage', 'buy', 100001)), /leverage/);
  for (const q of [0, -1, NaN, Infinity]) assert.throws(() => applyFill(initialPortfolio(), fill('q', 'buy', q)));
  assert.throws(() => applyFill(initialPortfolio(), { ...fill('time'), observed_at: '2026-10-25T15:00:00Z' }), /before/);
});
test('distributions and splits append recorded facts with consistent cost basis', () => {
  const p = applyFill(initialPortfolio(), fill('buy', 'buy', 3, 10000));
  const split = { id: 'split', symbol: 'AAPL', numerator: 2, denominator: 1, occurred_at: at, observed_at: at };
  const s = applySplit(p, split); assert.equal(s.holdings.AAPL.quantity, 6); assert.equal(s.holdings.AAPL.cost_cents, 30000);
  assert.deepEqual(applySplit(s, split), s); assert.equal(p.holdings.AAPL.quantity, 3);
  const d = { id: 'div', symbol: 'AAPL', amount_cents: 150, occurred_at: at, observed_at: at };
  const paid = applyDistribution(s, d); assert.equal(paid.cash_cents, s.cash_cents + 150); assert.equal(paid.income_cents, 150); assert.deepEqual(applyDistribution(paid, d), paid);
});
test('marking refuses missing prices; P&L and exposure reconcile', () => {
  const p = applyFill(initialPortfolio(), fill('b'));
  assert.throws(() => portfolioValue(p, {}), /price/);
  const marked = portfolioValue(p, { AAPL: 11000 }); assert.equal(marked.value_cents, 10010000); assert.equal(marked.unrealized_pnl_cents, 10000); assert.equal(marked.holdings[0].weight, 110000 / 10010000);
});
test('valid small cash-backed limit order passes', () => { assert.equal(validateOrder(order, context()).ok, true); });
test('live API, paused runtime, unknown orders, and closed sessions fail closed', () => {
  for (const patch of [{ paper_endpoint: 'https://api.alpaca.markets' }, { paper_endpoint: PAPER_ORIGIN + '.evil.test' }, { runtime_verified: false }, { experiment_status: 'paused' }, { open_orders: [{}] }, { open_orders: null }, { clock: { timestamp: at, is_open: false } }, { now: null }]) assert.equal(validateOrder(order, { ...context(), ...patch }).ok, false, JSON.stringify(patch));
});
test('freshness rejects stale/future quote and market clock', () => {
  for (const t of ['2026-10-26T14:57:59Z', '2026-10-26T15:00:06Z', null]) {
    const c = context(); c.prices.AAPL.market_time = t; assert.equal(validateOrder(order, c).ok, false);
    const clockResult = validateOrder(order, { ...context(), clock: { ...context().clock, timestamp: t } });
    assert.equal(clockResult.ok, false);
    assert.ok(clockResult.errors.some(error => error.startsWith('Market clock')));
  }
});
test('a stale held symbol blocks trading even if order symbol is fresh', () => {
  const c = context(); c.portfolio = applyFill(c.portfolio, { ...fill('spy'), symbol: 'SPY' }); c.prices.SPY.market_time = '2026-10-26T14:00:00Z';
  assert.equal(validateOrder(order, c).ok, false);
});
test('limits reject excessive size, margin, shorts, nonuniverse/options, extended hours', () => {
  for (const patch of [{ quantity: 51 }, { side: 'sell', quantity: 1 }, { symbol: 'TSLA' }, { symbol: 'AAPL261030C100000' }, { type: 'market' }, { extended_hours: true }, { time_in_force: 'gtc' }]) assert.equal(validateOrder({ ...order, ...patch }, context()).ok, false, JSON.stringify(patch));
});
test('concentration uses worst-case limit commitment; ETF cap differs from stock cap', () => {
  const c = context(); c.portfolio = applyFill(c.portfolio, fill('buy', 'buy', 95));
  assert.equal(validateOrder(order, c).ok, false);
  const c2 = context(); c2.portfolio = applyFill(c2.portfolio, fill('buy', 'buy', 90));
  assert.equal(validateOrder({ ...order, limit_price_cents: 15000 }, c2).ok, false);
  const c3 = context(); c3.portfolio = applyFill(c3.portfolio, { ...fill('b', 'buy', 45, 50000), symbol: 'SPY' });
  assert.equal(validateOrder({ ...order, symbol: 'SPY', quantity: 6, limit_price_cents: 50000 }, c3).ok, false);
});
test('cash floor/gross ceiling are enforced independently of broker buying power', () => {
  const c = context(); c.portfolio = { ...initialPortfolio(), cash_cents: 100000, holdings: { SPY: { quantity: 198, cost_cents: 9900000 } } };
  const result = validateOrder(order, c); assert.equal(result.ok, false); assert.ok(result.errors.some(e => e.includes('cash reserve'))); assert.ok(result.errors.some(e => e.includes('gross')));
});
test('benchmark buys whole SPY shares at contemporaneous observed price with residual cash', () => {
  const b = createBenchmark({ started_at: at, observed_at: at, market_time: at, price_cents: 76523 });
  assert.equal(b.holdings.SPY.quantity, 130); assert.equal(b.cash_cents, 52010); assert.equal(portfolioValue(b, { SPY: 76523 }).value_cents, 10000000);
});
test('benchmark cannot use post-start observations or stale data', () => {
  assert.throws(() => createBenchmark({ started_at: at, observed_at: '2026-10-26T15:00:01Z', market_time: at, price_cents: 50000 }), /after/);
  assert.throws(() => createBenchmark({ started_at: at, observed_at: at, market_time: '2026-10-26T14:00:00Z', price_cents: 50000 }), /stale/);
});
test('risk metrics show unavailable values until enough observations exist', () => {
  assert.equal(riskMetrics([]).max_drawdown, null); assert.equal(riskMetrics([{ at, value_cents: 100000 }]).total_return, null);
  const r = riskMetrics([{ at: '2026-10-23T20:00:00Z', value_cents: 100000 }, { at, value_cents: 90000 }]);
  assert.ok(Math.abs(r.max_drawdown + .1) < 1e-12); assert.equal(r.annualized_volatility, null);
});
test('volatility uses 20 sample daily returns, rejects duplicate and reversed NAV times', () => {
  const observations = Array.from({ length: 21 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, i + 1, 20)).toISOString(), value_cents: 100000 + i * 100 }));
  assert.ok(riskMetrics(observations).annualized_volatility > 0);
  assert.throws(() => riskMetrics([observations[1], observations[0]]), /chronological/);
  assert.throws(() => riskMetrics([observations[0], { ...observations[0], at: '2026-10-01T21:00:00Z' }]), /daily/);
});

test('exact subcent cash representation preserves sell basis and rejects ambiguity or rounding', () => {
  const b = { ...fill('subcent-buy', 'buy', 5), price_text: '10.002' }; delete b.price_cents;
  let p = applyFill(initialPortfolio(), b); assert.equal(p.holdings.AAPL.cost_cents, 5001);
  const s = { ...fill('subcent-sale', 'sell', 5), price_text: '11.004' }; delete s.price_cents;
  p = applyFill(p, s); assert.equal(p.cash_cents, 10000501); assert.equal(p.realized_pnl_cents, 501);
  assert.deepEqual(p.holdings, {});
  assert.throws(() => applyFill(initialPortfolio(), { ...b, price_text: '10.001' }), /fractional-cent/);
  assert.throws(() => applyFill(initialPortfolio(), { ...b, price_cents: 1000 }), /ambiguous/);
  assert.throws(() => applyFill(initialPortfolio(), { ...b, quantity: .5 }), /whole share/);
});
test('fractional orders are rejected even when size would fit the mandate', () => {
  assert.equal(validateOrder({ ...order, quantity: .5 }, context()).ok, false);
});

test('modeled distributions never fund orders and increase the conservative economic NAV cash reserve',()=>{
 const c=context();c.portfolio={...initialPortfolio(),cash_cents:1000200,holdings:{SPY:{quantity:180,cost_cents:9000000}}};c.prices.AAPL.price_cents=100;
 const small={...order,quantity:1,limit_price_cents:100};assert.equal(validateOrder(small,c).ok,true);
 const result=validateOrder(small,{...c,modeled_income_cents:1000000});assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.includes('cash reserve')));
});

test('fresh open clock cannot authorize execution at or after its recorded session close', () => {
  const c = context();
  c.clock.timestamp = '2026-10-26T14:59:30Z';
  for (const close of ['2026-10-26T14:59:50Z', at]) {
    c.clock.next_close = close;
    const result = validateOrder(order, c);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('recorded close')));
    assert.ok(!result.errors.some(error => error.includes('stale')));
  }
  c.clock.next_close = '2026-10-26T15:00:00.001Z';
  assert.equal(validateOrder(order, c).ok, true);
});

test('missing, timezone-free, invalid or inconsistent open-session boundaries fail closed', () => {
  for (const key of ['next_open', 'next_close']) {
    for (const value of [undefined, null, 'not-a-date', '2026-10-26T20:00:00']) {
      const c = context(); c.clock[key] = value;
      const result = validateOrder(order, c);
      assert.equal(result.ok, false, `${key}=${value}`);
      assert.ok(result.errors.some(error => error.includes('boundaries')));
    }
  }
  for (const patch of [
    { next_open: '2026-10-26T19:00:00Z' },
    { next_open: '2026-10-26T20:00:00Z' },
    { timestamp: '2026-10-26T15:00:01Z', next_close: '2026-10-26T15:00:00.500Z' },
  ]) {
    const c = context(); Object.assign(c.clock, patch);
    const result = validateOrder(order, c);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('boundaries')));
  }
});
