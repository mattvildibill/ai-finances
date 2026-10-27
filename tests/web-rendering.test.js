import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual render functions without network, production records, or bootstrap.
function ui() {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', value: 'all', style: {}, firstChild: {}, classList: { toggle() {} }, hidden: false });
    return elements.get(selector);
  };
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').split("$$('[data-view]')")[0];
  const context = vm.createContext({ document: { querySelector: get, querySelectorAll: () => [] }, URL, Intl });
  vm.runInContext(`${source}\nglobalThis.renderers = { renderState, renderMarket, renderHoldings, renderChart, recordCard, renderRecords };`, context);
  return { ...context.renderers, get };
}

test('decision room, journal, and replay cards preserve full original thesis and arbitrary authored evidence', () => {
  const view = ui();
  const thesis = `Original thesis ${'long substantive rationale. '.repeat(30)} FINAL DISCONFIRMATION`;
  const payload = { title: 'Decision', summary: 'Short summary', thesis, required_before_purchase_thesis: ['Observe cash flow', 'Challenge valuation'], custom_condition: { trigger: '<script>bad()</script>', approved: false }, change_mind: 'Margins fall', evidence: [{ title: 'Issuer', url: 'javascript:alert(1)', extra_provenance: 'Original receipt' }] };
  const event = { id: 'isolated-record', kind: 'decision', created_at: '2026-10-27T06:00:00Z', payload };
  view.renderRecords({ events: [event] });
  for (const html of [view.get('#decision-list').innerHTML, view.get('#journal-list').innerHTML, view.recordCard(event)]) {
    assert.ok(html.includes(thesis));
    assert.match(html, /Required before purchase thesis/);
    assert.match(html, /Observe cash flow\nChallenge valuation/);
    assert.match(html, /Margins fall/);
    assert.match(html, /Original receipt/);
    assert.match(html, /&lt;script&gt;bad/);
    assert.doesNotMatch(html, /<script>|href="javascript:/);
  }
  assert.equal(payload.thesis, thesis);
});

test('missing NAV history is unavailable even if undocumented history-like fields are supplied', () => {
  const view = ui();
  const series = [{ at: '2026-10-26', value: 100000 }, { at: '2026-10-27', value: 110000 }];
  view.renderChart({ performance: series, history: series }, true);
  assert.match(view.get('#performance-chart').innerHTML, /Performance history unavailable/);
  assert.doesNotMatch(view.get('#performance-chart').innerHTML, /svg|polyline|second observation/);
  view.renderChart({}, false);
  assert.match(view.get('#performance-chart').innerHTML, /Not started/);
});

test('saved market clock is explicitly historical with age at state cutoff, never live market status', () => {
  const view = ui();
  const state = { as_of: '2026-10-27T14:00:00Z', latest_snapshot: { payload: { clock: { is_open: true, timestamp: '2026-10-26T14:00:00Z' } } } };
  view.renderMarket(state);
  assert.equal(view.get('#session-badge').textContent, 'At snapshot: open');
  assert.match(view.get('#session-time').textContent, /86,400 seconds old as of/);
  assert.match(view.get('#session-time').textContent, /not a live session check/);
  state.as_of = '2026-10-26T13:59:59Z';
  view.renderMarket(state);
  assert.equal(view.get('#session-badge').textContent, 'Session unverified');
  delete state.latest_snapshot.payload.clock.timestamp;
  view.renderMarket(state);
  assert.equal(view.get('#session-badge').textContent, 'Session unverified');
});

test('unknown cash, NAV, and holding values remain unknown rather than zero or legacy fallback', () => {
  const view = ui();
  view.renderState({ portfolio: { value: 100000, cash: null } });
  assert.equal(view.get('#cash-value').textContent, '—');
  assert.equal(view.get('#cash-percent').textContent, 'Waiting for accounting state');
  assert.equal(view.get('#cash-track').hidden, true);
  view.renderState({ portfolio: { value: null, equity: 100000, cash: 0 } });
  assert.equal(view.get('#portfolio-value').textContent, '—');
  assert.equal(view.get('#cash-percent').textContent, 'Waiting for accounting state');
  view.renderHoldings({ value: 100000, holdings: [{ symbol: 'AAPL', market_value: null, value: 1200, unrealized_pl: null, unrealized_gain: 50 }] }, true);
  assert.match(view.get('#holdings-body').innerHTML, /<td>—<\/td><td class="">—<\/td><td>—<\/td>/);
  assert.doesNotMatch(view.get('#holdings-body').innerHTML, /1,200|50\.00|0%/);
  view.renderState({ portfolio: { value: 100000, cash: 0 } });
  assert.equal(view.get('#cash-percent').textContent, '0% of portfolio');
  assert.equal(view.get('#cash-track').hidden, false);
});
