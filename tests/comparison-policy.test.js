/** Isolated synthetic policy examples. These do NOT verify production evidence acquisition. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPortfolio, applyFill, applyDistribution, applySplit, createBenchmark, portfolioValue } from '../lib/finance.js';
const start = '2026-10-01T14:00:00Z';
const exDate = '2026-10-02T13:30:00Z';
const paidAt = '2026-10-09T14:00:00Z';
const transaction = (id, side, quantity, occurred_at = start) => ({ id, symbol: 'SPY', side, quantity, price_cents: 50000, occurred_at, observed_at: occurred_at });
test('shared entitlement-date methodology pays a seller and excludes a later buyer on payment day', () => {
  let active = applyFill(initialPortfolio(), transaction('initial-holding', 'buy', 10));
  let benchmark = createBenchmark({ started_at: start, observed_at: start, market_time: start, price_cents: 50000 });
  // Synthetic entitlement snapshots, captured before later trades. Production must acquire and verify these.
  const entitlement = { active: active.holdings.SPY.quantity, benchmark: benchmark.holdings.SPY.quantity, at: exDate };
  active = applyFill(active, transaction('sale-after-entitlement', 'sell', 10, '2026-10-05T14:00:00Z'));
  active = applyFill(active, transaction('new-buy-after-entitlement', 'buy', 3, '2026-10-06T14:00:00Z'));
  const event = { id: 'synthetic-dividend', symbol: 'SPY', occurred_at: paidAt, observed_at: paidAt };
  active = applyDistribution(active, { ...event, amount_cents: entitlement.active * 125 });
  benchmark = applyDistribution(benchmark, { ...event, amount_cents: entitlement.benchmark * 125 });
  assert.equal(active.income_cents, 1250); assert.equal(benchmark.income_cents, 25000);
  assert.equal(active.holdings.SPY.quantity, 3);
  assert.equal(portfolioValue(active, { SPY: 50000 }).value_cents, 10001250);
  assert.equal(portfolioValue(benchmark, { SPY: 50000 }).value_cents, 10025000);
});
test('same split ratio preserves both portfolios basis and NAV at corresponding unadjusted marks', () => {
  const active = applyFill(initialPortfolio(), transaction('buy-before-split', 'buy', 10));
  const benchmark = createBenchmark({ started_at: start, observed_at: start, market_time: start, price_cents: 50000 });
  const split = { id: 'synthetic-split', symbol: 'SPY', numerator: 2, denominator: 1, occurred_at: exDate, observed_at: exDate };
  for (const before of [active, benchmark]) {
    const after = applySplit(before, split);
    assert.equal(after.holdings.SPY.quantity, before.holdings.SPY.quantity * 2);
    assert.equal(after.holdings.SPY.cost_cents, before.holdings.SPY.cost_cents);
    assert.equal(portfolioValue(after, { SPY: 25000 }).value_cents, portfolioValue(before, { SPY: 50000 }).value_cents);
    assert.deepEqual(applySplit(after, split), after);
  }
});
test('a later correction is represented by a new event, never by changing the original dividend', () => {
  const original = { id: 'original-payment', symbol: 'SPY', amount_cents: 100, occurred_at: paidAt, observed_at: paidAt };
  const p = applyDistribution(initialPortfolio(), original);
  assert.throws(() => applyDistribution(p, { ...original, amount_cents: 101 }), /reused/);
  const corrected = applyDistribution(p, { ...original, id: 'additional-cent', amount_cents: 1, observed_at: '2026-10-10T14:00:00Z' });
  assert.equal(corrected.income_cents, 101); assert.equal(corrected.events[0].amount_cents, 100);
  // Negative/reversal adjustments require a future explicitly supported production event.
  assert.throws(() => applyDistribution(p, { ...original, id: 'unsupported-reversal', amount_cents: -1 }));
});
