import { createBenchmark } from '../lib/finance.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { append, getEvent, listEvents } from '../lib/store.js';
import { reconcile, readLedger, createOpeningPayload } from '../lib/reconciliation.js';
import { temporaryDatabase, testEnv } from './helpers.js';

const actor = 'fixture:reconciler';
const clientId = 'blue-' + 'a'.repeat(40);
const baseTime = () => new Date(Date.now() - 10000).toISOString();
async function opening(db, start = baseTime()) { return append(db, { id: 'official-opening-fixture', kind: 'experiment_opened', payload: { initial_cash_cents: 10000000, started_at: start, benchmark: createBenchmark({ started_at: start, observed_at: start, market_time: start, price_cents: 50000 }) }, actor }, start); }
async function intent(db) { return append(db, { id: 'order-intent-fixture', kind: 'order_intent', payload: { client_order_id: clientId, decision_id: 'decision-fixture', order: { symbol: 'AAPL', side: 'buy', qty: '5', type: 'limit', time_in_force: 'day', limit_price: '11.00' } }, actor }); }
function activity(id, qty = '5', price = '10.00', extra = {}) { return { id, activity_type: 'FILL', type: 'fill', order_id: 'broker-order-fixture', symbol: 'AAPL', side: 'buy', qty, price, transaction_time: new Date(Date.now() - 1000).toISOString(), ...extra }; }
function broker({ activities = [], cash = '99950.00', qty = '5', filled = '5', status = 'filled', openOrders = [], orderPatch = {}, pageHandler } = {}) {
  const calls = []; const order = { id: 'broker-order-fixture', client_order_id: clientId, symbol: 'AAPL', side: 'buy', qty: '5', type: 'limit', time_in_force: 'day', extended_hours: false, asset_class: 'us_equity', limit_price: '11.00', filled_qty: filled, filled_avg_price: '10.000123', status, ...orderPatch };
  const fetcher = async (url, options) => {
    const u = new URL(url); calls.push({ url: String(url), method: options.method }); let response;
    assert.equal(u.origin, 'https://paper-api.alpaca.markets'); assert.equal(options.method, 'GET');
    if (u.pathname === '/v2/orders:by_client_order_id') { assert.equal(u.searchParams.get('client_order_id'), clientId); response = order; }
    else if (u.pathname === '/v2/account/activities/FILL') response = pageHandler ? pageHandler(u.searchParams) : activities;
    else if (u.pathname === '/v2/account') response = { status: 'ACTIVE', currency: 'USD', cash, equity: '100000.00' };
    else if (u.pathname === '/v2/positions') response = qty === '0' ? [] : [{ symbol: 'AAPL', side: 'long', qty }];
    else if (u.pathname === '/v2/orders') response = openOrders;
    else throw new Error('Unexpected reconciliation URL ' + u);
    return Response.json(response);
  };
  return { fetcher, calls, order };
}
const events = db => listEvents(db, new Date().toISOString());

test('known partial fills are accounted once, close only after quantity agreement, and survive retry', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db);
  const raw = [activity('fill-001', '2', '10.00', { type: 'partial_fill', cum_qty: '2' }), activity('fill-002', '3', '11.00', { cum_qty: '5' })];
  const f = broker({ activities: raw, cash: '99947.00' }); const first = await reconcile(db, testEnv, 'reconcile-run-001', actor, f.fetcher);
  assert.equal(first.payload.new_fills, 2); assert.equal(first.payload.orders_closed, 1); assert.equal(first.payload.trading_permitted, false); assert.ok(first.payload.problems.some(p => p.code === 'corporate_actions_unverified'));
  const ledger = await readLedger(db); assert.equal(ledger.portfolio.cash_cents, 9994700); assert.equal(ledger.portfolio.holdings.AAPL.quantity, 5); assert.equal(ledger.portfolio.holdings.AAPL.cost_cents, 5300);
  const calls = f.calls.length; assert.deepEqual(await reconcile(db, testEnv, 'reconcile-run-001', actor, f.fetcher), first); assert.equal(f.calls.length, calls);
  const second = await reconcile(db, testEnv, 'reconcile-run-002', actor, f.fetcher); assert.equal(second.payload.new_fills, 0); assert.equal(second.payload.orders_closed, 0);
  const all = await events(db); assert.equal(all.filter(e => e.kind === 'broker_activity').length, 2); assert.equal(all.filter(e => e.kind === 'ledger_fill').length, 2); assert.equal(all.filter(e => e.kind === 'order_closed').length, 1);
});
test('canceled partially filled orders close when real activities account for the exact filled amount', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db);
  const f = broker({ activities: [activity('partial-cancel', '2')], cash: '99980.00', qty: '2', filled: '2', status: 'canceled' });
  const result = await reconcile(db, testEnv, 'cancel-run-001', actor, f.fetcher); assert.equal(result.payload.orders_closed, 1); assert.equal((await readLedger(db)).portfolio.holdings.AAPL.quantity, 2);
});
test('missing fill activities never become invented average-price transactions or closed orders', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db); const f = broker({ activities: [] });
  const result = await reconcile(db, testEnv, 'missing-fill-run', actor, f.fetcher);
  assert.equal(result.payload.new_fills, 0); assert.equal(result.payload.orders_closed, 0); assert.ok(result.payload.problems.some(p => p.code === 'fill_quantity_mismatch')); assert.equal((await readLedger(db)).portfolio.cash_cents, 10000000);
  assert.equal((await events(db)).filter(e => e.kind === 'ledger_fill').length, 0);
});
test('unsupported fractional-cent fill price is preserved raw, blocked, and never silently rounded', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db); const raw = activity('fractional-cent-fill', '5', '10.001');
  const result = await reconcile(db, testEnv, 'fractional-run-001', actor, broker({ activities: [raw] }).fetcher);
  assert.equal(result.payload.new_fills, 0); assert.equal(result.payload.orders_closed, 0); assert.ok(result.payload.problems.some(p => p.code === 'fill_unresolved' && /fractional-cent/.test(p.message)));
  assert.equal((await events(db)).find(e => e.kind === 'broker_activity').payload.activity.price, '10.001'); assert.equal((await readLedger(db)).portfolio.cash_cents, 10000000);
});
test('fractional-share fills and activity quantity beyond the broker total cannot enter the ledger', async t => {
  for (const raw of [activity('fractional-cash-fill', '0.5', '1.01'), activity('excess-quantity-fill', '6', '10.00')]) {
    const { db } = temporaryDatabase(t); await opening(db); await intent(db);
    const result = await reconcile(db, testEnv, 'exact-notional-run', actor, broker({ activities: [raw] }).fetcher);
    assert.equal(result.payload.new_fills, 0); assert.equal(result.payload.orders_closed, 0); assert.ok(result.payload.problems.some(p => p.code === (raw.qty === '0.5' ? 'fractional_quantity_unsupported' : 'fill_unresolved')));
    assert.equal((await events(db)).find(e => e.kind === 'broker_activity').payload.activity.qty, raw.qty);
    assert.equal((await readLedger(db)).portfolio.cash_cents, 10000000);
  }
});
test('external fills and external open orders fail closed without entering official accounting', async t => {
  const { db } = temporaryDatabase(t); await opening(db); const raw = activity('external-fill', '5', '10.00', { order_id: 'outside-order' });
  const result = await reconcile(db, testEnv, 'external-run-001', actor, broker({ activities: [raw], openOrders: [{ id: 'outside-open-order' }] }).fetcher);
  assert.equal(result.payload.new_fills, 0); assert.ok(result.payload.problems.some(p => p.code === 'external_fill')); assert.ok(result.payload.problems.some(p => p.code === 'external_open_order')); assert.ok(result.payload.problems.some(p => p.code === 'cash_mismatch'));
});
test('an altered broker activity creates a preserved second raw version, not a rewritten transaction', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db); const original = activity('same-broker-activity');
  await reconcile(db, testEnv, 'original-run-001', actor, broker({ activities: [original] }).fetcher);
  const corrected = { ...original, price: '11.00' }; const result = await reconcile(db, testEnv, 'corrected-run-001', actor, broker({ activities: [corrected], cash: '99945.00' }).fetcher);
  assert.ok(result.payload.problems.some(p => p.code === 'activity_changed')); const all = await events(db); assert.equal(all.filter(e => e.kind === 'broker_activity').length, 2); assert.equal(all.filter(e => e.kind === 'ledger_fill').length, 1); assert.equal((await readLedger(db)).portfolio.cash_cents, 9995000);
});
test('unstarted experiment can reconcile read-only while preserving its paused, unallocated ledger', async t => {
  const { db } = temporaryDatabase(t); const result = await reconcile(db, testEnv, 'unstarted-run-001', actor, broker({ cash: '100000.00', qty: '0', filled: '0' }).fetcher);
  assert.equal(result.payload.new_fills, 0); assert.equal(result.payload.ledger_status, 'not_started'); assert.equal((await readLedger(db)).portfolio, null); assert.ok(result.payload.problems.some(p => p.code === 'not_started')); assert.equal((await events(db)).filter(e => e.kind === 'experiment_opened').length, 0);
});
test('activity pagination uses last activity ID and fails closed if pages repeat', async t => {
  const { db } = temporaryDatabase(t); const firstPage = Array.from({ length: 100 }, (_, i) => activity('page-fill-' + i)); let count = 0;
  const f = broker({ cash: '100000.00', qty: '0', pageHandler: q => { count++; assert.equal(q.get('direction'), 'asc'); assert.equal(q.get('page_size'), '100'); if (count === 1) { assert.equal(q.get('page_token'), null); return firstPage; } assert.equal(q.get('page_token'), 'page-fill-99'); return []; } });
  const result = await reconcile(db, testEnv, 'paging-run-001', actor, f.fetcher); assert.equal(count, 2); assert.equal(result.payload.activity_count, 100); assert.equal((await events(db)).filter(e => e.kind === 'broker_activity').length, 100);
  const repeated = await reconcile(db, testEnv, 'paging-run-002', actor, broker({ cash: '100000.00', qty: '0', pageHandler: () => firstPage }).fetcher); assert.ok(repeated.payload.problems.some(p => p.code === 'reconciliation_failed' && /did not advance/.test(p.message))); assert.equal(repeated.payload.trading_permitted, false);
});
test('ledger as-of replay excludes fills received later despite an earlier economic fill time', async t => {
  const { db } = temporaryDatabase(t); const start = baseTime(); await opening(db, start); await intent(db);
  const before = new Date(Date.now() - 500).toISOString(); await reconcile(db, testEnv, 'replay-run-001', actor, broker({ activities: [activity('known-later-fill')] }).fetcher);
  const past = await readLedger(db, before); assert.equal(past.fill_count, 0); assert.equal(past.portfolio.cash_cents, 10000000); assert.equal((await readLedger(db)).fill_count, 1);
});
test('order/client mismatch and replacement chains are not trusted for accounting', async t => {
  for (const patch of [{ client_order_id: 'someone-else' }, { replaced_by: 'another-order' }, { qty: '6' }, { type: 'market' }, { limit_price: '12.00' }, { extended_hours: true }]) {
    const { db } = temporaryDatabase(t); await opening(db); await intent(db); const result = await reconcile(db, testEnv, 'mismatched-run-001', actor, broker({ activities: [activity('mismatch-fill')], orderPatch: patch }).fetcher);
    assert.ok(result.payload.problems.some(p => p.code === 'order_unresolved')); assert.equal(result.payload.new_fills, 0); assert.equal(result.payload.orders_closed, 0);
  }
});
test('a reported fill outside the original limit is preserved but not accounted', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db);
  const result = await reconcile(db, testEnv, 'limit-violation-run', actor, broker({ activities: [activity('limit-violation-fill', '5', '12.00')] }).fetcher);
  assert.equal(result.payload.new_fills, 0); assert.equal(result.payload.orders_closed, 0); assert.ok(result.payload.problems.some(p => p.code === 'fill_unresolved' && /limit/.test(p.message)));
});
test('prospective opening helper preserves same-time benchmark and refuses backdating/precision loss', () => {
  const start = new Date().toISOString(); const snapshot = { id: 'snapshot-start', kind: 'snapshot', created_at: start, payload: { feed: 'iex', execution_ready: true, clock: { timestamp: start, is_open: true }, account: { cash: 100000, equity: 100000 }, positions: [], open_orders: [], quotes: { SPY: { price: 500, feed: 'iex', market_data_at: start } } } };
  const payload = createOpeningPayload(snapshot, start); assert.equal(payload.started_at, payload.benchmark.started_at); assert.equal(payload.benchmark.holdings.SPY.quantity, 200); assert.equal(payload.benchmark.cash_cents, 0);
  assert.throws(() => createOpeningPayload(snapshot, '2020-01-01T00:00:00Z'), /backdating/);
  assert.throws(() => createOpeningPayload({ ...snapshot, payload: { ...snapshot.payload, quotes: { SPY: { price: 500.005, feed: 'iex', market_data_at: start } } } }, start), /fractional-cent/);
});
test('a lost execution lease stops receipt and ledger writes without deleting its new owner', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db); const f = broker({ activities: [activity('lease-fill')] }); let stolen = false;
  const fetcher = async (...args) => { const response = await f.fetcher(...args); if (!stolen) { stolen = true; db.sqlite.exec("UPDATE locks SET token='new-owner' WHERE name='execution'"); } return response; };
  await assert.rejects(reconcile(db, testEnv, 'lost-lease-run', actor, fetcher), /lease was lost/);
  assert.equal((await events(db)).filter(e => ['ledger_fill', 'broker_order', 'broker_activity', 'reconciliation'].includes(e.kind)).length, 0);
  assert.equal((await db.prepare("SELECT token FROM locks WHERE name='execution'").first()).token, 'new-owner');
});

test('subcent unit prices settle only when exact whole-share cash is cent-denominated', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db);
  const raw = activity('exact-subcent', '5', '10.002');
  const f = broker({ activities: [raw], cash: '99949.99' });
  const result = await reconcile(db, testEnv, 'exact-subcent-run', actor, f.fetcher);
  assert.equal(result.payload.new_fills, 1); assert.equal(result.payload.orders_closed, 1);
  const ledger = await readLedger(db); assert.equal(ledger.portfolio.cash_cents, 9994999);
  assert.equal(ledger.portfolio.holdings.AAPL.cost_cents, 5001);
  assert.equal(ledger.portfolio.events[0].price_text, '10.002');
  assert.equal(ledger.portfolio.events[0].price_cents, undefined);
  await reconcile(db, testEnv, 'exact-subcent-retry', actor, f.fetcher);
  assert.equal((await readLedger(db)).portfolio.cash_cents, 9994999);
});
test('closed orders are refreshed and disappeared activity remains a blocker', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db);
  await reconcile(db, testEnv, 'before-disappearance', actor, broker({ activities: [activity('later-missing')] }).fetcher);
  const f = broker({ activities: [], filled: '4', status: 'canceled' });
  const result = await reconcile(db, testEnv, 'after-disappearance', actor, f.fetcher);
  assert.ok(f.calls.some(c => c.url.includes('by_client_order_id')));
  assert.ok(result.payload.problems.some(p => p.code === 'activity_history_missing'));
  assert.ok(result.payload.problems.some(p => p.code === 'fill_quantity_mismatch'));
  assert.equal((await readLedger(db)).portfolio.cash_cents, 9995000);
});
test('conflicting activity versions remain blocked when omitted in a later response', async t => {
  const { db } = temporaryDatabase(t); await opening(db); await intent(db);
  const raw = activity('persistent-correction');
  await reconcile(db, testEnv, 'conflict-original', actor, broker({ activities: [raw] }).fetcher);
  await reconcile(db, testEnv, 'conflict-changed', actor, broker({ activities: [{ ...raw, price: '11.00' }] }).fetcher);
  const result = await reconcile(db, testEnv, 'conflict-omitted', actor, broker({ activities: [] }).fetcher);
  assert.ok(result.payload.problems.some(p => p.code === 'activity_changed'));
  assert.equal((await readLedger(db)).fill_count, 1);
});
test('replay rejects missing, delayed, or financially inconsistent opening benchmarks', async t => {
  for (const patch of [null, { started_at: '2000-01-01T00:00:00Z' }, { cash_cents: 1 }]) {
    const { db } = temporaryDatabase(t); const start = baseTime();
    const benchmark = patch === null ? null : { ...createBenchmark({ started_at: start, observed_at: start, market_time: start, price_cents: 50000 }), ...patch };
    await append(db, { id: 'invalid-opening-test', kind: 'experiment_opened', payload: { initial_cash_cents: 10000000, started_at: start, benchmark }, actor }, start);
    const result = await readLedger(db); assert.equal(result.status, 'blocked'); assert.equal(result.portfolio, null);
    assert.equal(result.problems[0].code, 'invalid_opening');
  }
});
