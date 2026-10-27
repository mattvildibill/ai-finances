import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Small D1 compatibility adapter backed by real SQLite, not a mock key/value store. */
export function openDatabase(path = ':memory:', migrate = true) {
  const sqlite = new DatabaseSync(path);
  if (migrate) for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const db = { sqlite, close: () => sqlite.close(), prepare(sql) {
    const statement = sqlite.prepare(sql); let values = [];
    const prepared = {
      bind(...args) { values = args; return prepared; },
      async first(column) { const row = statement.get(...values); return column ? row?.[column] ?? null : row ? { ...row } : null; },
      async all() { return { success: true, results: statement.all(...values).map(r => ({ ...r })) }; },
      async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
    };
    return prepared;
  } };
  return db;
}
export function temporaryDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'blue-capital-test-')); const path = join(dir, 'records.sqlite'); const db = openDatabase(path);
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, path };
}
export const testEnv = { ALPACA_API_KEY: 'fixture-key-not-a-credential', ALPACA_SECRET_KEY: 'fixture-secret-not-a-credential' };
export function brokerFixture(overrides = {}) {
  const now = new Date().toISOString();
  const account = { id: 'fixture-account-1234', status: 'ACTIVE', currency: 'USD', account_blocked: false, trading_blocked: false, cash: '100000', equity: '100000', portfolio_value: '100000', ...overrides.account };
  const clock = { timestamp: now, is_open: true, next_open: new Date(Date.parse(now)+86400000).toISOString(), next_close: new Date(Date.parse(now)+3600000).toISOString(), ...overrides.clock };
  const trades = Object.fromEntries(['AAPL', 'MSFT', 'SPY'].map((symbol, i) => [symbol, { t: now, p: 100 + i, x: 'V', ...overrides.trade }]));
  if (overrides.missingSymbol) delete trades[overrides.missingSymbol];
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), method: options.method, redirect: options.redirect });
    const u = new URL(url); let body;
    if (overrides.failStatus) return new Response('{}', { status: overrides.failStatus });
    if (u.pathname === '/v2/account') body = account;
    else if (u.pathname === '/v2/account/activities/FILL') body = [];
    else if (u.pathname === '/v2/clock') body = clock;
    else if (u.pathname === '/v2/positions') body = overrides.positions || [];
    else if (u.pathname === '/v2/orders') body = overrides.orders || [];
    else if (u.pathname === '/v2/stocks/trades/latest') body = { trades };
    else throw new Error('Unexpected fixture endpoint ' + u.pathname);
    return Response.json(body);
  };
  return { fetcher, calls };
}
