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

test('statement distinguishes positive, negative, zero and unavailable P&L without inventing invested capital', () => {
  const view = ui();
  for (const [gain, expected] of [[125.5, '$125.50'], [-42, '-$42.00'], [0, '$0.00'], [null, '—']]) {
    view.renderState({ as_of: '2026-10-27T14:00:00Z', experiment: { started_at: '2026-10-27T13:30:00Z', status: 'paused' }, portfolio: { value: 100000, cash: 96000, gain, total_return: gain === null ? null : gain / 100000 } });
    assert.equal(view.get('#return-value').textContent, expected);
    assert.equal(view.get('#invested-value').textContent, '$4,000.00');
  }
  view.renderState({ portfolio: { value: null, cash: 96000, holdings_status: 'unknown' } });
  assert.equal(view.get('#invested-value').textContent, '—');
  assert.equal(view.get('#holdings-empty strong').textContent, 'Holdings unavailable');
  assert.equal(view.get('#return-value').textContent, 'Not started');
});

test('quote source times distinguish stale, future and unverified observations', () => {
  const view = ui();
  view.renderMarket({ as_of: '2026-10-27T14:00:00Z', latest_snapshot: { payload: { quotes: {
    AAPL: { price: 100, market_data_at: '2026-10-27T13:00:00Z' },
    MSFT: { price: 200, market_data_at: '2026-10-27T14:01:00Z' },
    SPY: { price: null }
  } } } });
  const html = view.get('#market-quotes').innerHTML;
  for (const label of ['Stale', 'Future timestamp', 'Unverified time', 'No verified price']) assert.ok(html.includes(label));
});

test('structured research and revisions stay inspectable behind closed native details, never become holdings', () => {
  const view = ui();
  const decision = { id: 'isolated-proposal', kind: 'decision', created_at: '2026-10-27T14:00:00Z', payload: { title: 'Conditional budget', action: 'hold', size: 0, candidates: [{ symbol: 'SPY', proposed_weight: 0.04, dissent: 'Not approved' }], evidence: [{ title: 'Source', url: 'https://example.com', provenance: 'Exact receipt' }] } };
  const revision = { id: 'isolated-revision', kind: 'revision', created_at: '2026-10-27T15:00:00Z', payload: { title: 'Watch downgraded', supersedes: decision.id } };
  view.renderState({ history_truncated: true, events: [decision, revision], portfolio: { value: 100000, cash: 100000, holdings: [] } });
  const html = view.get('#decision-list').innerHTML;
  assert.match(html, /Proposal/);
  assert.match(html, /<details class="record-detail"><summary>/);
  assert.match(html, /structured-fields/);
  assert.match(html, /Not approved/);
  assert.match(html, /Exact receipt/);
  assert.doesNotMatch(html, /<details[^>]* open|&quot;proposed_weight&quot;/);
  assert.match(view.get('#journal-list').innerHTML, /Watch downgraded/);
  assert.match(view.get('#replay-list').innerHTML, /Conditional budget/);
  assert.match(view.get('#replay-status').textContent, /Recent records/);
  assert.equal(view.get('#holdings-body').innerHTML, '');
});

test('all navigation routes, refresh errors, loading retry and history controls work with isolated responses', async () => {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { id: selector.slice(1), value: '', hidden: false, textContent: '', innerHTML: '', firstChild: {}, style: {}, dataset: {}, attrs: {}, handlers: {}, classList: { toggle() {} }, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; }, focus() { this.focused=true; }, addEventListener(k,fn) { this.handlers[k]=fn; } });
    return elements.get(selector);
  }
  const routes = ['overview','decisions','journal','replay','operations'];
  const buttons = routes.map(route => Object.assign(element(`button-${route}`), { dataset: { view: route } }));
  const sections = routes.map(route => element(`#view-${route}`));
  let fail = true;
  const fixture = { as_of:'2026-10-27T14:00:00Z', history_truncated:true, portfolio:{value:100000,cash:100000}, events:[] };
  const context = vm.createContext({ document: {querySelector:element,querySelectorAll:s=>s === '[data-view]' || s === '.nav-item' ? buttons : s === '.view' ? sections : []}, URL, Intl, history:{replaceState(){}}, location:{hash:''}, window:{addEventListener(){},scrollTo(){}}, crypto:{randomUUID:()=> 'isolated-key'}, fetch:async()=> { if(fail) throw Error('Isolated failure'); return {ok:true,json:async()=>fixture}; } });
  vm.runInContext(readFileSync(new URL('../web/app.js', import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('#loading').innerHTML,/Try again/);
  assert.match(element('#global-message').textContent,/Isolated failure/);
  fail=false;
  await element('#retry-load').handlers.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(element('#loading').hidden,true);
  assert.equal(element('#app-content').hidden,false);
  for (const [index,button] of buttons.entries()) {
    button.handlers.click();
    assert.equal(sections[index].hidden,false);
    assert.equal(sections.filter(section=>!section.hidden).length,1);
    assert.equal(element(`#view-${routes[index]} h1`).focused,true);
  }
  element('#replay-date').value='invalid';
  await element('#replay-button').handlers.click();
  assert.match(element('#replay-status').textContent,/valid date/);
  element('#replay-date').value='2020-01-01T12:00';
  await element('#replay-button').handlers.click();
  assert.match(element('#replay-status').textContent,/Recent window/);
  element('#replay-reset').handlers.click();
  assert.match(element('#replay-status').textContent,/Recent records/);
  fail=true;
  await element('#refresh-button').handlers.click();
  assert.match(element('#global-message').textContent,/previous state is retained/);
  assert.equal(element('#refresh-button').disabled,false);
  assert.equal(element('#portfolio-value').textContent,'$100,000.00');
});
