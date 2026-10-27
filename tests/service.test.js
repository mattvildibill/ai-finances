import test from 'node:test';
import assert from 'node:assert/strict';
import { append, getEvent, listEvents, acquire, release } from '../lib/store.js';
import { state, refresh, submit } from '../lib/service.js';
import { alpaca, observe, PAPER, DATA } from '../lib/alpaca.js';
import { executeDecision } from '../lib/execution.js';
import { openDatabase, temporaryDatabase, brokerFixture, testEnv } from './helpers.js';

const actor = 'test:owner';
const now = () => new Date().toISOString();
const evidence = () => [{ title: 'Test evidence', url: 'https://docs.alpaca.markets/docs/paper-trading', observed_at: now(), excerpt: 'Fixture for validation; not investment research.' }];
const researchPayload = () => ({ title: 'Test research', summary: 'Fixture thesis', author: 'research-agent', role: 'researcher', evidence: evidence(), snapshot_ids: ['snapshot-test-001'], thesis: 'Remain in cash pending verification.', horizon: 'Until operating checks pass.', uncertainties: 'Unverified corporate actions.', change_mind: 'Verified end-to-end workflow.' });
async function seedSnapshot(db) { const { fetcher } = brokerFixture(); return refresh(db, testEnv, 'snapshot-test-001', actor, fetcher); }

test('real SQL migration makes history append-only against UPDATE and DELETE', async t => {
  const { db } = temporaryDatabase(t);
  const event = await append(db, { id: 'immutable-event', kind: 'verification', payload: { summary: 'original' }, actor });
  assert.throws(() => db.sqlite.exec("UPDATE events SET payload='{}'"), /immutable|append.only/i);
  assert.throws(() => db.sqlite.exec('DELETE FROM events'), /immutable|append.only/i);
  assert.deepEqual(await getEvent(db, event.id), event);
});
test('same id and identical content retries once; differing nested content conflicts', async t => {
  const { db } = temporaryDatabase(t);
  const e = { id: 'retry-record-001', kind: 'verification', payload: { nested: { original: true } }, actor };
  const first = await append(db, e); const repeated = await append(db, e);
  assert.deepEqual(repeated, first);
  await assert.rejects(append(db, { ...e, payload: { nested: { original: false } } }), e => e.status === 409);
  assert.equal((await listEvents(db, now())).length, 1);
});
test('records survive database close and reopen without a deployment or reseed', async t => {
  const { db, path } = temporaryDatabase(t);
  await append(db, { id: 'persistent-record', kind: 'verification', payload: { summary: 'persist me' }, actor });
  db.close(); const reopened = openDatabase(path, false);
  try { assert.equal((await getEvent(reopened, 'persistent-record')).payload.summary, 'persist me'); } finally { reopened.close(); }
});
test('replay filters by recording time and cannot leak a later correction about an earlier event', async t => {
  const { db } = temporaryDatabase(t);
  await append(db, { id: 'original-record', kind: 'verification', payload: { summary: 'known then' }, actor }, '2026-10-26T13:00:00.000Z');
  await append(db, { id: 'later-correction', kind: 'revision', payload: { summary: 'learned later', occurred_at: '2026-10-26T12:00:00Z', supersedes: 'original-record' }, actor }, '2026-10-26T15:00:00.000Z');
  const replay = await state(db, '2026-10-26T14:00:00Z'); assert.deepEqual(replay.events.map(e => e.id), ['original-record']);
  const later = await state(db, '2026-10-26T16:00:00Z'); assert.deepEqual(later.events.map(e => e.id), ['original-record', 'later-correction']);
});
test('refresh persists an actual service result; retry does not call broker or duplicate snapshot', async t => {
  const { db } = temporaryDatabase(t); const f = brokerFixture();
  const first = await refresh(db, testEnv, 'snapshot-test-001', actor, f.fetcher); assert.equal(f.calls.length, 9);
  const second = await refresh(db, testEnv, 'snapshot-test-001', actor, f.fetcher); assert.equal(f.calls.length, 9); assert.deepEqual(first, second);
  const readback = await state(db); assert.equal(readback.latest_snapshot.id, first.id); assert.equal(readback.broker_account.cash, 100000); assert.equal(readback.portfolio.value, 100000); assert.equal(readback.experiment.status, 'paused'); assert.equal(readback.snapshots.length, 1); assert.equal(readback.last_reconciliation.payload.ledger_status, 'not_started'); assert.equal(readback.last_reconciliation.payload.activity_count, 0); assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('source failure records health event, preserves last successful data, releases lock', async t => {
  const { db } = temporaryDatabase(t); await seedSnapshot(db);
  await assert.rejects(refresh(db, testEnv, 'failure-test-001', actor, brokerFixture({ failStatus: 503 }).fetcher), /HTTP 503/);
  const result = await state(db); assert.equal(result.health.source_status, 'failed'); assert.equal(result.latest_snapshot.id, 'snapshot-test-001'); assert.equal(result.experiment.status, 'paused');
  await acquire(db, 'refresh', 'another-owner'); await release(db, 'refresh', 'another-owner');
});
test('locks exclude competing writers and expire rather than blocking forever', async t => {
  const { db } = temporaryDatabase(t); const start = '2026-10-26T13:00:00.000Z';
  await acquire(db, 'execution', 'first', start);
  await assert.rejects(acquire(db, 'execution', 'second', start), e => e.status === 409);
  await release(db, 'execution', 'not-the-owner');
  await assert.rejects(acquire(db, 'execution', 'second', start), e => e.status === 409);
  await acquire(db, 'execution', 'second', '2026-10-26T13:02:01.000Z'); await release(db, 'execution', 'second');
});
test('research/challenge/manager update-readback flow requires distinct linked authors', async t => {
  const { db } = temporaryDatabase(t); await seedSnapshot(db);
  const r = await submit(db, { idempotency_key: 'research-test-001', kind: 'research', payload: researchPayload() }, actor);
  const challenge = { title: 'Test challenge', summary: 'Independent counterpoint', author: 'challenge-agent', role: 'challenger', evidence: evidence(), snapshot_ids: ['snapshot-test-001'], research_id: r.id, counterargument: 'No trading while accounting is unverified.' };
  await assert.rejects(submit(db, { idempotency_key: 'invalid-challenge', kind: 'challenge', payload: { ...challenge, author: r.payload.author } }, actor), /different author/);
  const c = await submit(db, { idempotency_key: 'challenge-test-001', kind: 'challenge', payload: challenge }, actor);
  const decision = { ...researchPayload(), title: 'Test hold decision', author: 'manager-agent', role: 'portfolio_manager', research_id: r.id, challenge_id: c.id, action: 'hold', size: 0, challenge_response: 'Accept the challenge and preserve cash.' };
  await assert.rejects(submit(db, { idempotency_key: 'unlinked-decision', kind: 'decision', payload: { ...decision, challenge_id: 'unknown-challenge' } }, actor), /independent challenge/);
  await assert.rejects(submit(db, { idempotency_key: 'same-author-decision', kind: 'decision', payload: { ...decision, author: c.payload.author } }, actor), /distinct author/);
  await assert.rejects(submit(db, { idempotency_key: 'nonzero-hold-decision', kind: 'decision', payload: { ...decision, size: 100 } }, actor), /hold must have size zero/);
  const d = await submit(db, { idempotency_key: 'decision-test-001', kind: 'decision', payload: decision }, actor);
  const result = await state(db); assert.equal(result.events.filter(e => ['research', 'challenge', 'decision'].includes(e.kind)).length, 3); assert.equal(result.health.last_successful_review, d.created_at); assert.equal(result.experiment.status, 'paused');
  assert.deepEqual((await getEvent(db, r.id)).payload, r.payload);
});
test('invalid evidence, missing snapshots, and invalid roles cannot enter history', async t => {
  const { db } = temporaryDatabase(t); await seedSnapshot(db);
  for (const patch of [{ evidence: [] }, { snapshot_ids: ['missing-snapshot'] }, { role: 'portfolio_manager' }, { evidence: [{ ...evidence()[0], url: 'javascript:alert(1)' }] }, { evidence: [{ ...evidence()[0], observed_at: '2099-01-01T00:00:00Z' }] }]) {
    await assert.rejects(submit(db, { idempotency_key: 'invalid-research', kind: 'research', payload: { ...researchPayload(), ...patch } }, actor));
  }
  assert.equal((await listEvents(db, now())).filter(e => e.kind === 'research').length, 0);
});
test('paused execution sends zero requests even if TRADING_ENABLED is set', async t => {
  const { db } = temporaryDatabase(t); let calls = 0;
  await assert.rejects(executeDecision(db, { ...testEnv, TRADING_ENABLED: 'true' }, 'any-decision', actor, async () => { calls++; throw new Error('must not call'); }), e => e.status === 423);
  assert.equal(calls, 0); assert.equal((await listEvents(db, now())).length, 0);
});
test('Alpaca transport hard-codes paper origin and explicit free IEX data feed', async () => {
  const f = brokerFixture(); const p = await observe({ ...testEnv, ALPACA_BASE_URL: 'https://api.alpaca.markets' }, f.fetcher);
  assert.equal(p.feed, 'iex'); assert.equal(p.execution_ready, true); assert.equal(f.calls.length, 5);
  for (const call of f.calls) { assert.equal(call.redirect, 'manual'); assert.equal(call.method, 'GET'); assert.ok([PAPER, DATA].includes(new URL(call.url).origin)); }
  const data = f.calls.find(c => c.url.startsWith(DATA)); assert.equal(new URL(data.url).searchParams.get('feed'), 'iex');
  await assert.rejects(alpaca(testEnv, 'https://api.alpaca.markets/v2/orders', { fetcher: f.fetcher }), /Invalid Alpaca path/);
  await assert.rejects(alpaca(testEnv, '/v2/../v2/account', { fetcher: f.fetcher }), /Invalid Alpaca path/);
  await assert.rejects(alpaca({}, '/v2/account', { fetcher: f.fetcher }), /not configured/);
});
test('stale clock, missing symbol, future quote, invalid account balances fail data verification', async () => {
  const stale = new Date(Date.now() - 121000).toISOString(); const future = new Date(Date.now() + 10000).toISOString();
  for (const overrides of [{ clock: { timestamp: stale } }, { missingSymbol: 'SPY' }, { trade: { t: future } }, { account: { cash: 'not-a-number' } }, { account: { equity: '-1' } }, { account: { currency: 'EUR' } }, { account: { trading_blocked: true } }]) {
    await assert.rejects(observe(testEnv, brokerFixture(overrides).fetcher), undefined, JSON.stringify(overrides));
  }
});
test('old prices remain labeled observations and never become executable data', async () => {
  const p = await observe(testEnv, brokerFixture({ trade: { t: new Date(Date.now() - 3600000).toISOString() }, clock: { is_open: false } }).fetcher);
  assert.equal(p.execution_ready, false); assert.equal(p.session.is_open, false); assert.ok(p.quotes.SPY.age_seconds > 3500); assert.notEqual(p.quotes.SPY.market_data_at, p.retrieved_at);
});

// Build first: the Worker imports the actual generated assets module used in deployment.
const worker = () => import('../worker/index.js').then(m => m.default);
test('worker rejects anonymous/invalid-token reads and supports an authenticated persistent read', async t => {
  const { db } = temporaryDatabase(t); const app = await worker(); const env = { DB: db, SERVICE_TOKEN: 'fixture-service-token' };
  for (const headers of [{}, { authorization: 'Bearer wrong' }]) assert.equal((await app.fetch(new Request('https://private.test/api/state', { headers }), env)).status, 401);
  const response = await app.fetch(new Request('https://private.test/api/state', { headers: { authorization: 'Bearer fixture-service-token' } }), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).experiment.status, 'paused'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
test('API cross-origin and non-JSON writes fail without storing a record', async t => {
  const { db } = temporaryDatabase(t); const app = await worker(); const env = { DB: db };
  const payload = { idempotency_key: 'csrf-attempt-001', kind: 'verification', payload: { title: 'No', summary: 'Must not be stored', author: 'attacker' } };
  const headers = { 'oai-authenticated-user-id': 'fixture-owner', 'content-type': 'application/json', origin: 'https://evil.test' };
  const cross = await app.fetch(new Request('https://private.test/api/records', { method: 'POST', headers, body: JSON.stringify(payload) }), env); assert.equal(cross.status, 403);
  const plain = await app.fetch(new Request('https://private.test/api/records', { method: 'POST', headers: { ...headers, origin: 'https://private.test', 'content-type': 'text/plain' }, body: JSON.stringify(payload) }), env); assert.equal(plain.status, 415);
  assert.equal(await getEvent(db, payload.idempotency_key), null);
});
test('MCP tools/call rejects anonymous calls and cross-origin plain-text mutation', async t => {
  const { db } = temporaryDatabase(t); const app = await worker(); const env = { DB: db };
  const payload = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_record', arguments: { idempotency_key: 'mcp-csrf-attempt', kind: 'verification', payload: { title: 'No', summary: 'Must not persist', author: 'attacker' } } } };
  const anon = await app.fetch(new Request('https://private.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), env);
  const anonymous = await anon.json(); assert.ok(anon.status === 401 || anonymous.result?.isError || anonymous.error);
  const cross = await app.fetch(new Request('https://private.test/mcp', { method: 'POST', headers: { 'oai-authenticated-user-id': 'fixture-owner', origin: 'https://evil.test', 'content-type': 'text/plain' }, body: JSON.stringify(payload) }), env);
  const result = await cross.json(); assert.ok([403, 415].includes(cross.status) || result.result?.isError || result.error);
  assert.equal(await getEvent(db, 'mcp-csrf-attempt'), null);
});
test('authenticated MCP update/readback uses the same persistent data as HTTP state', async t => {
  const { db } = temporaryDatabase(t); const app = await worker(); const env = { DB: db, SERVICE_TOKEN: 'fixture-service-token' };
  const headers = { authorization: 'Bearer fixture-service-token', 'content-type': 'application/json' };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_record', arguments: { idempotency_key: 'mcp-roundtrip-001', kind: 'verification', payload: { title: 'Test round trip', summary: 'Test write persisted', author: 'test-harness' } } } };
  const result = await (await app.fetch(new Request('https://private.test/mcp', { method: 'POST', headers, body: JSON.stringify(rpc) }), env)).json(); assert.equal(result.result.isError, undefined);
  const readback = await (await app.fetch(new Request('https://private.test/api/state', { headers }), env)).json(); assert.equal(readback.events.find(e => e.id === 'mcp-roundtrip-001').payload.summary, 'Test write persisted');
});
