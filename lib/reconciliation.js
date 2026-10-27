import { alpaca } from './alpaca.js';
import { append, getEvent, parseRow, hash, canonical, isoNow, acquire, release, AppError } from './store.js';
import { initialPortfolio, applyFill, createBenchmark, moneyToCents, MANDATE } from './finance.js';

const MAX_EVENTS = 10000;
const MAX_ACTIVITY_PAGES = 50;
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected']);
const RELEVANT = ['experiment_opened', 'order_intent', 'order_submitted', 'order_observed', 'broker_order', 'order_closed', 'broker_activity', 'ledger_fill'];
const issue = (code, message, details = {}) => ({ code, message, ...details });
const time = (value, label) => { if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} requires an ISO timestamp with timezone`); return Date.parse(value); };
const idFor = async (prefix, value) => prefix + ':' + (await hash(value)).slice(0, 48);
function exactCents(value, label) {
  // Trailing zeros are precision, not an economic fractional cent. Never round a nonzero digit away.
  const string = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(string)) throw new Error(`${label} is not a decimal amount`);
  const normalized = string.includes('.') ? string.replace(/0+$/, '').replace(/\.$/, '') : string;
  try { return moneyToCents(normalized); } catch { throw new Error(`${label} has unsupported fractional-cent precision or magnitude`); }
}
function quantityUnits(value, label, allowZero = true) {
  const string = String(value); if (!/^\d+(?:\.\d{1,9})?$/.test(string)) throw new Error(`${label} has unsupported quantity precision`);
  const [whole, fraction = ''] = string.split('.'); const units = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if ((!allowZero && units === 0n) || units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is out of range`);
  return units;
}
async function history(db, asOf = isoNow()) {
  time(asOf, 'Replay time');
  const rows = await db.prepare(`SELECT * FROM events WHERE kind IN (${RELEVANT.map(() => '?').join(',')}) AND created_at<=? ORDER BY seq LIMIT ?`).bind(...RELEVANT, new Date(asOf).toISOString(), MAX_EVENTS + 1).all();
  if (rows.results.length > MAX_EVENTS) throw new AppError('Reconciliation history exceeds the verified processing bound; trading must remain paused.', 423);
  return rows.results.map(parseRow);
}
function rebuild(events) {
  const openings = events.filter(e => e.kind === 'experiment_opened'); const problems = [];
  if (openings.length !== 1) return { status: openings.length ? 'blocked' : 'not_started', portfolio: null, benchmark: null, started_at: null, fill_count: 0, problems: [issue(openings.length ? 'multiple_openings' : 'not_started', openings.length ? 'Multiple opening records require reconciliation.' : 'The official experiment has not started.')] };
  const opening = openings[0]; const p = opening.payload;
  if (p.initial_cash_cents !== MANDATE.initial_cash_cents || !Number.isFinite(Date.parse(p.started_at)) || p.started_at !== opening.created_at) return { status: 'blocked', portfolio: null, benchmark: null, started_at: p.started_at, fill_count: 0, problems: [issue('invalid_opening', 'Opening must record the exact prospective $100,000 start and receipt time.')] };
  let portfolio = initialPortfolio();
  const fills = events.filter(e => e.kind === 'ledger_fill').sort((a, b) => Date.parse(a.payload.fill.occurred_at) - Date.parse(b.payload.fill.occurred_at) || a.seq - b.seq);
  for (const event of fills) {
    try {
      if (Date.parse(event.payload.fill.occurred_at) < Date.parse(p.started_at)) throw new Error('Fill occurred before official experiment start');
      portfolio = applyFill(portfolio, event.payload.fill);
    } catch (error) { problems.push(issue('ledger_rebuild_failed', error.message, { event_id: event.id })); break; }
  }
  return { status: problems.length ? 'blocked' : 'ready', portfolio, benchmark: p.benchmark || null, started_at: p.started_at, fill_count: portfolio.events.length, problems, performance_basis: 'Paper price return; distributions and unsupported corporate actions are not adjusted.' };
}
/** Rebuild only from facts RECEIVED by asOf. Economic times order known fills; no records are rewritten. */
export async function readLedger(db, asOf = isoNow()) { return rebuild(await history(db, asOf)); }

/** Pure prospective opening helper. No route calls it and it never activates trading. */
export function createOpeningPayload(snapshotEvent, startedAt = isoNow()) {
  const snapshot = snapshotEvent?.payload; const start = time(startedAt, 'Start time');
  if (Math.abs(Date.now() - start) > 5000) throw new AppError('Opening time must be the current server time; backdating is prohibited.', 423);
  if (snapshotEvent?.kind !== 'snapshot' || snapshot?.feed !== 'iex' || !snapshot?.execution_ready || snapshot.clock?.is_open !== true) throw new AppError('Opening requires a verified fresh regular-session IEX market snapshot.', 423);
  const received = time(snapshotEvent.created_at, 'Snapshot receipt');
  if (received > start || start - received > 120000) throw new AppError('Opening snapshot was not available and fresh at start.', 423);
  if (Math.abs(start - time(snapshot.clock.timestamp, 'Market clock')) > 120000 || time(snapshot.clock.timestamp, 'Market clock') > start + 5000) throw new AppError('Opening market clock is stale or future-dated.', 423);
  if (snapshot.positions?.length !== 0 || snapshot.open_orders?.length !== 0 || exactCents(snapshot.account?.cash, 'Opening cash') !== MANDATE.initial_cash_cents || exactCents(snapshot.account?.equity, 'Opening equity') !== MANDATE.initial_cash_cents) throw new AppError('Opening requires a dedicated flat $100,000 paper account with no orders.', 423);
  const spy = snapshot.quotes?.SPY; if (spy?.feed !== 'iex') throw new AppError('SPY benchmark requires the verified IEX feed.', 423); const price_cents = exactCents(spy?.price, 'SPY reference price');
  const benchmark = createBenchmark({ started_at: startedAt, observed_at: snapshotEvent.created_at, market_time: spy?.market_data_at, price_cents });
  return { started_at: startedAt, initial_cash_cents: MANDATE.initial_cash_cents, snapshot_id: snapshotEvent.id, benchmark, costs: 'Zero modeled paper commissions; external fees and distributions require separate reconciliation.', corporate_action_support: 'not_verified' };
}

function normalizeFill(activity, rawEvent, intent, order) {
  if (activity.activity_type !== 'FILL' || !['fill', 'partial_fill'].includes(activity.type)) throw new Error('Unsupported activity or trade correction type');
  if (activity.order_id !== order.id || activity.symbol !== intent.payload.order.symbol || activity.side !== intent.payload.order.side || !['buy', 'sell'].includes(activity.side)) throw new Error('Fill does not match the recorded experiment order');
  if (!MANDATE.universe.includes(activity.symbol)) throw new Error('Fill is outside the approved universe');
  time(activity.transaction_time, 'Fill time');
  if (Date.parse(activity.transaction_time) > Date.parse(rawEvent.created_at) + 5000) throw new Error('Fill is future-dated');
  const units = quantityUnits(activity.qty, 'Fill quantity', false); const price_cents = exactCents(activity.price, 'Fill price');
  if (units % 1000000000n !== 0n) { const error = new Error('Fractional-share activity requires fixed-point quantity accounting; initial production reconciliation supports whole shares only. Raw evidence is preserved.'); error.reconciliationCode = 'fractional_quantity_unsupported'; throw error; }
  if (price_cents <= 0) throw new Error('Fill price must be positive');
  const limit = exactCents(intent.payload.order.limit_price, 'Intended limit price');
  if (activity.side === 'buy' && price_cents > limit || activity.side === 'sell' && price_cents < limit) throw new Error('Fill price violates the original limit order');
  if (BigInt(price_cents) * units % 1000000000n !== 0n) throw new Error('Fractional-cent fill cash amount requires explicit broker normalization; no rounding applied');
  if (units > quantityUnits(order.qty, 'Order quantity', false)) throw new Error('Fill quantity exceeds the experiment order');
  for (const field of ['fee', 'fees', 'commission']) if (activity[field] !== undefined && exactCents(activity[field], field) !== 0) throw new Error('Nonzero fill charges require an explicit supported fee ledger');
  // Do not invent a fill from cumulative quantity or average order price.
  return { id: 'alpaca-fill:' + activity.id, symbol: activity.symbol, side: activity.side, quantity: Number(units) / 1e9, quantity_text: String(activity.qty), price_cents, fee_cents: 0, fee_basis: 'Zero modeled paper fill fees; regulatory fees are unsupported.', occurred_at: activity.transaction_time, observed_at: rawEvent.created_at };
}
async function allActivities(env, fetcher, receivePage) {
  const activities = []; const seenPages = new Set(); let token;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const query = new URLSearchParams({ direction: 'asc', page_size: '100' }); if (token) query.set('page_token', token);
    const rows = await alpaca(env, '/v2/account/activities/FILL?' + query, { fetcher });
    if (!Array.isArray(rows) || rows.length > 100) throw new AppError('Invalid paper fill activities response.', 503);
    await receivePage(rows);
    activities.push(...rows);
    if (rows.length < 100) return activities;
    const next = rows.at(-1)?.id;
    if (typeof next !== 'string' || !next || seenPages.has(next)) throw new AppError('Paper fill pagination did not advance; reconciliation is incomplete.', 503);
    seenPages.add(next); token = next;
  }
  throw new AppError('Paper fill pagination exceeded its processing bound; reconciliation is incomplete.', 423);
}
function validateOrder(order, intent) {
  if (!order || typeof order.id !== 'string' || !order.id || order.client_order_id !== intent.payload.client_order_id || order.symbol !== intent.payload.order.symbol || order.side !== intent.payload.order.side) throw new Error('Broker order does not match its durable experiment intent');
  const requested = quantityUnits(intent.payload.order.qty, 'Intent quantity', false);
  if (quantityUnits(order.qty, 'Broker order quantity', false) !== requested || quantityUnits(order.filled_qty, 'Broker filled quantity') > requested) throw new Error('Broker order quantities differ from its intent');
  if (order.status === 'filled' && quantityUnits(order.filled_qty, 'Broker filled quantity') !== requested) throw new Error('Filled order does not report its complete requested quantity');
  if (order.type !== 'limit' || order.time_in_force !== 'day' || order.extended_hours !== false || order.asset_class !== 'us_equity' || exactCents(order.limit_price, 'Broker limit price') !== exactCents(intent.payload.order.limit_price, 'Intent limit price')) throw new Error('Broker order execution terms differ from the permitted intent');
  if (order.replaced_by || order.replaces || order.status === 'replaced') throw new Error('Order replacement chains require manual reconciliation');
}
function compareBroker(ledger, account, positions, openOrders, knownOrders, problems) {
  if (!account || account.status !== 'ACTIVE' || account.currency !== 'USD' || account.account_blocked || account.trading_blocked || !Array.isArray(positions) || !Array.isArray(openOrders)) { problems.push(issue('invalid_broker_state', 'Invalid or blocked paper account/position/order response.')); return; }
  try {
    const expected = ledger.portfolio || initialPortfolio();
    if (exactCents(account.cash, 'Broker cash') !== expected.cash_cents) problems.push(issue('cash_mismatch', 'Broker cash differs from the evidenced experiment ledger. External cash movement, fees, or missing fills require reconciliation.'));
    const actualSymbols = new Set();
    for (const p of positions) {
      if (!p || p.side !== 'long' || typeof p.symbol !== 'string' || actualSymbols.has(p.symbol)) throw new Error('Invalid or non-long broker position');
      actualSymbols.add(p.symbol);
      const expectedHolding = expected.holdings[p.symbol];
      if (!expectedHolding || quantityUnits(p.qty, 'Broker position quantity', false) !== quantityUnits(expectedHolding.quantity.toFixed(9), 'Ledger position quantity', false)) problems.push(issue('position_mismatch', 'Broker position differs from the evidenced experiment ledger.', { symbol: p.symbol }));
    }
    for (const symbol of Object.keys(expected.holdings)) if (!actualSymbols.has(symbol)) problems.push(issue('position_missing', 'An expected experiment holding is missing from the broker.', { symbol }));
    for (const order of openOrders) if (!knownOrders.has(order.id)) problems.push(issue('external_open_order', 'An open broker order is not linked to the experiment.', { order_id: String(order.id) }));
  } catch (error) { problems.push(issue('invalid_broker_state', error.message)); }
}

/** GET-only reconciliation. It never submits/cancels trades and never opens the experiment. */
export async function reconcile(db, env, idempotencyKey, actor, fetcher = fetch) {
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotencyKey || '')) throw new AppError('Reconciliation requires a stable idempotency key of 8–160 safe characters.');
  const runId = await idFor('reconciliation', idempotencyKey); const existing = await getEvent(db, runId); if (existing) return existing;
  const token = crypto.randomUUID(); await acquire(db, 'execution', token);
  const originalFetcher = fetcher;
  // Renew before every persisted receipt and bounded network request, including long paginated runs.
  const renewLease = async () => {
    await db.prepare('UPDATE locks SET expires_at=? WHERE name=? AND token=?').bind(new Date(Date.now() + 120000).toISOString(), 'execution', token).run();
    const lock = await db.prepare('SELECT token FROM locks WHERE name=?').bind('execution').first();
    if (lock?.token !== token) throw new AppError('Reconciliation execution lease was lost; retry after review.', 409);
  };
  const persist = async record => { await renewLease(); return append(db, record); };
  fetcher = async (...args) => {
    await renewLease();
    return originalFetcher(...args);
  };
  const problems = []; let activityCount = 0; let addedFills = 0; let closedOrders = 0;
  try {
    // Recheck under the same lock used by execution so a retry cannot race its original run.
    const raced = await getEvent(db, runId); if (raced) return raced;
    let events = await history(db); const intents = events.filter(e => e.kind === 'order_intent'); const closed = new Map(events.filter(e => e.kind === 'order_closed').map(e => [e.payload.intent_id, e]));
    const orders = new Map(); const intentByOrder = new Map();
    for (const intent of intents) {
      try {
        if (!/^blue-[a-f0-9]{40}$/.test(intent.payload.client_order_id || '')) throw new Error('Invalid experiment client order ID');
        let order;
        if (closed.has(intent.id)) order = closed.get(intent.id).payload.order;
        else {
          order = await alpaca(env, '/v2/orders:by_client_order_id?client_order_id=' + encodeURIComponent(intent.payload.client_order_id), { fetcher });
          await persist({ id: await idFor('broker-order', { intent_id: intent.id, order }), kind: 'broker_order', payload: { intent_id: intent.id, order }, actor });
        }
        validateOrder(order, intent); orders.set(order.id, order); intentByOrder.set(order.id, intent);
      } catch (error) { problems.push(issue('order_unresolved', error instanceof AppError ? error.message : String(error.message), { intent_id: intent.id })); }
    }
    const rawVersions = new Map();
    for (const event of events.filter(e => e.kind === 'broker_activity')) {
      const versions = rawVersions.get(event.payload.broker_activity_id) || new Set(); versions.add(canonical(event.payload.activity)); rawVersions.set(event.payload.broker_activity_id, versions);
    }
    const rawReceipts = [];
    await allActivities(env, fetcher, async rows => {
      for (const activity of rows) {
        const brokerId = typeof activity?.id === 'string' && activity.id ? activity.id : 'missing:' + await hash(activity);
        const raw = await persist({ id: await idFor('broker-activity', { brokerId, activity }), kind: 'broker_activity', payload: { broker_activity_id: brokerId, activity }, actor });
        const versions = rawVersions.get(brokerId) || new Set(); versions.add(canonical(activity)); rawVersions.set(brokerId, versions); rawReceipts.push(raw); activityCount++;
      }
    });
    const [account, positions, openOrders] = await Promise.all([
      alpaca(env, '/v2/account', { fetcher }), alpaca(env, '/v2/positions', { fetcher }), alpaca(env, '/v2/orders?status=open&limit=500', { fetcher })
    ]);
    if (openOrders?.length >= 500) problems.push(issue('open_orders_truncated', 'Open-order query reached its limit; completeness is unverified.'));
    activityCount = rawReceipts.length;
    // Receipt time is retained even when a later run discovers an economically earlier fill.
    rawReceipts.sort((a, b) => Date.parse(a.payload.activity.transaction_time) - Date.parse(b.payload.activity.transaction_time) || a.seq - b.seq);
    events = await history(db); let ledger = rebuild(events); const unresolvedOrders = new Set();
    for (const raw of rawReceipts) {
      const activity = raw.payload.activity; const brokerId = raw.payload.broker_activity_id; const order = orders.get(activity?.order_id); const intent = intentByOrder.get(activity?.order_id);
      if (!activity?.id || rawVersions.get(brokerId).size !== 1) { if (order) unresolvedOrders.add(order.id); problems.push(issue('activity_changed', 'Missing activity ID or multiple broker versions require explicit correction; original fills are preserved.', { broker_activity_id: brokerId })); continue; }
      if (!intent || !order) { problems.push(issue('external_fill', 'A broker fill is not linked to a known experiment order.', { broker_activity_id: brokerId, order_id: activity.order_id })); continue; }
      if (ledger.status === 'not_started') continue;
      try {
        const fillId = await idFor('ledger-fill', brokerId); const found = await getEvent(db, fillId);
        if (found) continue;
        const fill = normalizeFill(activity, raw, intent, order);
        const previouslyAccounted = events.filter(e => e.kind === 'ledger_fill' && e.payload.order_id === order.id).reduce((sum, e) => sum + quantityUnits(e.payload.fill.quantity_text ?? e.payload.fill.quantity, 'Accounted fill quantity', false), 0n);
        if (previouslyAccounted + quantityUnits(fill.quantity_text, 'New fill quantity', false) > quantityUnits(order.filled_qty, 'Broker filled quantity')) throw new Error('Activity fills exceed the broker-reported filled quantity; await consistent evidence');
        const payload = { broker_activity_id: brokerId, raw_event_id: raw.id, intent_id: intent.id, order_id: order.id, fill };
        const candidate = { id: fillId, kind: 'ledger_fill', payload, created_at: isoNow(), seq: Number.MAX_SAFE_INTEGER };
        const projected = rebuild([...events, candidate]); if (projected.status !== 'ready') throw new Error(projected.problems.map(p => p.message).join('; '));
        const saved = await persist({ id: fillId, kind: 'ledger_fill', payload, actor }); events.push(saved); ledger = rebuild(events); addedFills++;
      } catch (error) { unresolvedOrders.add(order.id); problems.push(issue(error.reconciliationCode || 'fill_unresolved', error.message, { broker_activity_id: brokerId })); }
    }
    const fills = events.filter(e => e.kind === 'ledger_fill');
    for (const [orderId, order] of orders) {
      const intent = intentByOrder.get(orderId);
      try {
        if (unresolvedOrders.has(orderId)) continue;
        const accounted = fills.filter(e => e.payload.order_id === orderId).reduce((sum, e) => sum + quantityUnits(e.payload.fill.quantity_text ?? e.payload.fill.quantity, 'Accounted fill quantity', false), 0n);
        const reported = quantityUnits(order.filled_qty, 'Broker filled quantity');
        if (accounted !== reported) { problems.push(issue('fill_quantity_mismatch', 'Order filled quantity does not match uniquely accounted activity fills; no average-price fill will be invented.', { order_id: orderId, accounted_quantity: String(Number(accounted) / 1e9), broker_filled_quantity: String(order.filled_qty) })); continue; }
        if (TERMINAL.has(order.status)) {
          if (!closed.has(intent.id)) { await persist({ id: await idFor('order-closed', intent.id), kind: 'order_closed', payload: { intent_id: intent.id, order_id: orderId, client_order_id: order.client_order_id, status: order.status, filled_qty: String(order.filled_qty), accounted_quantity: String(Number(accounted) / 1e9), order }, actor }); closedOrders++; }
        } else problems.push(issue('order_open', 'An experiment order remains open or in an unverified terminal state.', { order_id: orderId, status: order.status }));
      } catch (error) { problems.push(issue('order_unresolved', error.message, { order_id: orderId })); }
    }
    ledger = await readLedger(db); problems.push(...ledger.problems); compareBroker(ledger, account, positions, openOrders, orders, problems);
    if (ledger.portfolio) problems.push(issue('corporate_actions_unverified', 'Distribution, corporate-action, and fee reconciliation remain unsupported; this run does not authorize trading or total-return claims.'));
    const payload = { status: problems.length ? 'blocked' : 'reconciled', trading_permitted: false, activity_count: activityCount, new_fills: addedFills, orders_closed: closedOrders, ledger_status: ledger.status, ledger_cash_cents: ledger.portfolio?.cash_cents ?? null, problems, source: 'Alpaca paper API', retrieved_at: isoNow(), scope: 'FILL activities, known orders, cash and quantities; distributions/corporate actions are not supported.' };
    return await persist({ id: runId, kind: 'reconciliation', payload, actor });
  } catch (error) {
    const payload = { status: 'blocked', trading_permitted: false, activity_count: activityCount, new_fills: addedFills, orders_closed: closedOrders, problems: [...problems, issue('reconciliation_failed', error instanceof AppError ? error.message : 'Reconciliation failed; preserved receipts require review.')], source: 'Alpaca paper API', retrieved_at: isoNow() };
    return await persist({ id: runId, kind: 'reconciliation', payload, actor });
  } finally { await release(db, 'execution', token); }
}
