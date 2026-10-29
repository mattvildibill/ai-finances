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
  vm.runInContext(`${source}\nglobalThis.renderers = { renderState, renderMarket, renderHoldings, renderChart, recordCard, renderRecords, renderBrokerDisplay };`, context);
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
  view.renderChart({ experiment: { started_at: null, phase: 'unstarted' } }, false);
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
  assert.equal(view.get('#return-value').textContent, '—');
});

test('quote source times distinguish stale, future and unverified observations', () => {
  const view = ui();
  view.renderMarket({ mandate: { universe: ['AAPL', 'MSFT', 'SPY'] }, as_of: '2026-10-27T14:00:00Z', latest_snapshot: { payload: { quotes: {
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
  let responseGate = null;
  const fixture = { as_of:'2026-10-27T14:00:00Z', history_truncated:true, portfolio:{value:100000,cash:100000}, events:[] };
  const context = vm.createContext({ AbortSignal, setTimeout:()=>1, clearTimeout(){}, document: {addEventListener(){},querySelector:element,querySelectorAll:s=>s === '[data-view]' || s === '.nav-item' ? buttons : s === '.view' ? sections : []}, URL, Intl, history:{replaceState(){}}, location:{hash:''}, window:{addEventListener(){},scrollTo(){}}, crypto:{randomUUID:()=> 'isolated-key'}, fetch:async()=> { if(responseGate) await responseGate; if(fail) throw Error('Isolated failure'); return {ok:true,json:async()=>fixture}; } });
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
  let releaseResponse;
  responseGate = new Promise(resolve => { releaseResponse = resolve; });
  element('#replay-date').value='2020-01-01T12:00';
  const pendingReplay = element('#replay-button').handlers.click();
  element('#replay-reset').handlers.click();
  releaseResponse();
  await pendingReplay;
  responseGate = null;
  assert.match(element('#replay-status').textContent,/Recent records/);
  assert.equal(element('#replay-date').value,'');
  fail=true;
  buttons[0].handlers.click();
  await element('#refresh-button').handlers.click();
  assert.match(element('#broker-status').textContent,/Price update unavailable/);
  assert.equal(element('#refresh-button').disabled,false);
  assert.equal(element('#portfolio-value').textContent,'$100,000.00');
});

test('verification checks expose failed outcome and exact revision without implying execution permission', () => {
  const view = ui();
  view.renderState({ health: { data_fresh: true, verification: [{ title: 'Release check', check: 'broker_settlement', outcome: 'failed', status: 'passed', revision: 'isolated-revision', summary: 'Unresolved receipt' }] } });
  const html = view.get('#health-list').innerHTML;
  assert.match(html, /Check: broker_settlement/);
  assert.match(html, /Revision: isolated-revision/);
  assert.match(html, /health-value warning">failed/);
  assert.doesNotMatch(html, /Experiment pause still blocks trades/);
  assert.match(html, /recorded protocol and release-specific gates/);
});

test('offline review artifact retains literal JavaScript dollar tokens and compiles', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['scripts/ui-review.mjs'], { cwd: new URL('..', import.meta.url) });
  const html = readFileSync(new URL('../outputs/blue-design-review.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.ok(script.includes("const $$ = (selector)"));
  assert.ok(script.includes("$$('[data-view]')"));
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(html, /src="\/app.js"|href="\/styles.css"/);
});

test('only a verified sole pre-inception reconciliation blocker is Awaiting start', () => {
  const view = ui();
  const base = { experiment: { status:'paused', phase:'unstarted', started_at:null }, accounting: { status:'not_started', problems:[{code:'not_started'}] }, account_drift:false, health:{source_status:'connected',data_fresh:false}, last_reconciliation:{created_at:'2026-10-27T09:49:16Z',payload:{status:'blocked',ledger_status:'not_started',trading_permitted:false,problems:[{code:'not_started',message:'The official experiment has not started.'}]}} };
  const row = state => { view.renderState(state); return view.get('#health-list').innerHTML.split('</strong></div>')[0] + '</strong></div>'; };
  const original = JSON.stringify(base);
  assert.match(row(base), />Awaiting start</);
  assert.match(row(base), /execution remains gated/);
  assert.equal(JSON.stringify(base), original);
  for (const code of ['cash_mismatch','position_mismatch','external_open_order','reconciliation_failed','corporate_actions_unverified','invalid_broker_state']) {
    const mixed = structuredClone(base);
    mixed.last_reconciliation.payload.problems.push({code,message:`Actual ${code}`});
    assert.doesNotMatch(row(mixed), /Awaiting start/);
    assert.match(row(mixed), new RegExp(`Actual ${code}`));
    assert.match(row(mixed), />blocked</);
  }
  for (const alter of [
    state=>state.account_drift=true,
    state=>delete state.account_drift,
    state=>state.account_drift=null,
    state=>delete state.health.source_status,
    state=>state.health.source_status='unverified',
    state=>state.accounting.problems=[],
    state=>state.health.source_status='failed',
    state=>state.health.last_error='Source unavailable',
    state=>state.experiment.started_at='2026-10-27T13:30:00Z',
    state=>delete state.experiment.started_at,
    state=>delete state.accounting,
    state=>state.accounting.problems.push({code:'invalid_opening'}),
    state=>state.last_reconciliation.payload.problems=[],
    state=>state.last_reconciliation.payload.problems=['not_started'],
    state=>delete state.last_reconciliation.payload.problems,
    state=>delete state.last_reconciliation.payload.ledger_status,
    state=>state.last_reconciliation.payload.trading_permitted=true
  ]) { const state=structuredClone(base);alter(state);assert.doesNotMatch(row(state),/Awaiting start/); }
  const started=structuredClone(base);started.experiment.started_at='2026-10-27T13:30:00Z';started.accounting.status='ready';started.last_reconciliation.payload={status:'reconciled',ledger_status:'ready',problems:[],trading_permitted:false};
  assert.match(row(started),/>reconciled</);
  started.last_reconciliation.payload={status:'blocked',problems:[{code:'cash_mismatch',message:'Cash mismatch'}]};
  assert.match(row(started),/Cash mismatch/);
  assert.match(row({}),/>Not run</);
  assert.match(row({last_reconciliation:{payload:{}}}),/>Unverified</);
});

test('unknown and malformed numeric state never becomes reassuring zero or pre-launch', () => {
  const view=ui();
  for (const value of [null, undefined, '', '  ', false, true, [], {}, 'NaN']) {
    view.renderState({portfolio:{value,cash:value}});
    assert.equal(view.get('#portfolio-value').textContent,'—');
    assert.equal(view.get('#cash-value').textContent,'—');
    assert.equal(view.get('#invested-value').textContent,'—');
    assert.equal(view.get('#capital-state').textContent,'UNVERIFIED');
    assert.equal(view.get('#operations-status').textContent,'Unverified');
    assert.equal(view.get('#return-value').textContent,'—');
    assert.equal(view.get('#holdings-count').textContent,'Holdings unavailable');
    assert.doesNotMatch(view.get('#risk-grid').innerHTML,/No invested exposure/);
  }
  view.renderState({experiment:{status:'paused',phase:'unstarted',started_at:null},portfolio:{value:100000,cash:100000,holdings:[]}});
  assert.equal(view.get('#return-value').textContent,'Not started');
  assert.equal(view.get('#capital-state').textContent,'PRE-LAUNCH');
  assert.equal(view.get('#holdings-count').textContent,'0 positions');
});

test('market rows and mandate versions use only the returned approved universe', () => {
  const view = ui();
  const state = { mandate: { universe: ['AAPL', 'MSFT', 'SPY', 'IJR'], universe_version: 2, configuration_version: 2, mandate_version: 3 }, latest_snapshot: { payload: { quotes: { IJR: {price: 115}, PENNY: {price: 1} } } }, candidates: ['PENNY'] };
  view.renderState(state);
  const html = view.get('#market-quotes').innerHTML;
  assert.equal((html.match(/class="quote-row"/g) || []).length, 4);
  assert.match(html, /<strong>IJR<\/strong>/);
  assert.match(html, /\$115\.00/);
  assert.doesNotMatch(html, /PENNY/);
  assert.match(view.get('#mandate-grid').innerHTML, /AAPL · MSFT · SPY · IJR/);
  assert.equal(view.get('#mandate-version').textContent, 'Mandate 3 · Universe 2');
  view.renderState({mandate:{universe:['SPY'], configuration_version:1, mandate_version:1}});
  assert.equal(view.get('#mandate-version').textContent, 'Mandate 1 · Universe 1');
  assert.doesNotMatch(view.get('#market-quotes').innerHTML, /AAPL|MSFT|IJR/);
});

test('malformed or absent universe and version metadata remain unavailable, never expand from quotes', () => {
  const view = ui();
  for (const universe of [undefined, null, [], 'AAPL,SPY', [null], [{}], ['SPY', 'SPY'], ['SPY', '<img src=x onerror=alert(1)>']]) {
    view.renderState({mandate:{universe,mandate_version:'<script>bad()</script>',universe_version:null,configuration_version:2},latest_snapshot:{payload:{quotes:{SPY:{price:100}}}}});
    assert.match(view.get('#market-quotes').innerHTML, /Approved universe unavailable/);
    assert.doesNotMatch(view.get('#market-quotes').innerHTML, /quote-row|<img|<script>/);
    assert.match(view.get('#mandate-grid').innerHTML, /Eligible universe<\/h3><strong>Unavailable/);
    assert.equal(view.get('#mandate-version').textContent,'Mandate unavailable · Universe unavailable');
  }
  for (const value of [undefined,null,0,-1,1.5,'2',{},true]) {
    view.renderState({mandate:{universe:['IJR'],mandate_version:value,configuration_version:value}});
    assert.equal(view.get('#mandate-version').textContent,'Mandate unavailable · Universe unavailable');
  }
  view.renderState({mandate:{universe:['IJR']},latest_snapshot:{payload:{quotes:[null,{symbol:'IJR',price:'<script>bad()</script>',market_data_at:'\" onmouseover=\"bad()'}]}}});
  assert.doesNotMatch(view.get('#market-quotes').innerHTML, /<script>|datetime="" onmouseover=/);
  assert.match(view.get('#market-quotes').innerHTML, /&quot; onmouseover=&quot;bad\(\)/);
  view.renderState({});
  assert.match(view.get('#market-quotes').innerHTML,/Approved universe unavailable/);
});

test('observed NAV dots expose timestamped values without pretending continuous lines or official closes',()=>{
 const view=ui();const points=[{at:'2026-10-27T19:59:36Z',value:100008.42,benchmark_value:100270.40,snapshot_id:'actual-fixture-1',official_close:false},{at:'2026-10-27T20:00:59Z',value:100007.92,benchmark_value:100257.40,snapshot_id:'actual-fixture-2',official_close:false,valuation_status:'last_known'}];
 view.renderChart({valuation_history:{schema:'observed-nav-v1',points,interpolation:false}},true);
 const html=view.get('#performance-chart').innerHTML;assert.match(html,/<svg/);assert.equal((html.match(/<circle /g)||[]).length,2);assert.doesNotMatch(html,/<polyline|<path/);assert.match(html,/100,008.42/);assert.doesNotMatch(html,/actual-fixture-2/);assert.match(view.get('#chart-note').textContent,/Not official closes/);
 points[0].snapshot_id='<script>unsafe</script>';view.renderChart({valuation_history:{schema:'observed-nav-v1',points}},true);assert.doesNotMatch(view.get('#performance-chart').innerHTML,/<script>/);
});
test('last verified historical NAV is separated from current unknown accounting',()=>{
 const view=ui();view.renderState({as_of:'2026-10-27T21:00:00Z',experiment:{status:'paused',started_at:'2026-10-27T13:31:45Z'},portfolio:{value:null,cash:null,holdings:[],holdings_status:'unknown',valuation_status:'unavailable'},last_verified_valuation:{at:'2026-10-27T20:00:59Z',value:100007.92,cash:96160.02}});
 assert.equal(view.get('#portfolio-value').textContent,'$100,007.92');assert.equal(view.get('#capital-title').firstChild.textContent,'LAST VERIFIED VALUE ');assert.match(view.get('#capital-context').textContent,/Historical observation/);assert.equal(view.get('#cash-value').textContent,'—');assert.equal(view.get('#invested-value').textContent,'—');assert.equal(view.get('#return-value').textContent,'—');
});

test('investment highlights use exact-source plain copy and retain every original behind details',()=>{
 const view=ui();view.get('#decision-filter').value='investment';
 const hold={id:'blue-review-hold-2026-10-27-close',digest:'1791147c1f660e251bfac7fadf9c055ce69024056a26cf5ee83f446920ec8dd0',kind:'decision',created_at:'2026-10-27T20:20:00Z',payload:{action:'hold',title:'accept narrower reconciliation and distribution conclusions',summary:'Original complex statement',thesis:'Full original thesis'}};
 const setup={id:'blue-opening-limit-policy-2026-10-27',digest:'1366c967ee77352dcc2e8d8177cdf131d7d6eca127fdd4b8d705ae09775f47aa',kind:'decision',created_at:'2026-10-27T20:21:00Z',payload:{action:'hold',title:'Setup',summary:'Actual setup wording'}};
 const earlier={id:'prior-hold',kind:'decision',created_at:'2026-10-27T19:00:00Z',payload:{action:'hold',summary:'Earlier hold'}};
 const before=JSON.stringify([hold,setup,earlier]);view.renderRecords({events:[hold,setup,earlier]});
 const html=view.get('#latest-decision').innerHTML;
 assert.match(html,/Keep SPY; make no new purchase/);assert.match(html,/Prices were too old/);
 const visible=html.split('<details')[0];assert.doesNotMatch(visible,/narrower reconciliation|2026-|Recorded |Immutable/);
 assert.match(html,/Original complex statement/);assert.match(html,/Full original thesis/);
 const list=view.get('#decision-list').innerHTML;assert.match(list,/Earlier reviews, research &amp; setup \(2\)/);assert.match(list,/Actual setup wording/);assert.equal(JSON.stringify([hold,setup,earlier]),before);
 hold.digest='changed';view.renderRecords({events:[hold]});assert.doesNotMatch(view.get('#latest-decision').innerHTML,/Prices were too old/);assert.match(view.get('#latest-decision').innerHTML,/Original complex statement/);
});

test('trade highlights require linked actual fill evidence and distinguish partial, full and conflicting outcomes',()=>{
 const view=ui();view.get('#decision-filter').value='investment';
 const decision={id:'d',kind:'decision',payload:{action:'buy',symbol:'SPY',summary:'Proposal',plain_language_summary:'Small first purchase <img src=x onerror=bad()>'}};
 const intent={id:'i',kind:'order_intent',payload:{decision_id:'d',order:{symbol:'SPY',side:'buy',qty:'2'}}};
 const fill={id:'f',kind:'ledger_fill',payload:{intent_id:'i',fill:{symbol:'SPY',side:'buy',quantity:1,price_text:'767.5'}}};
 const closure={id:'c',kind:'order_closed',payload:{intent_id:'i',status:'filled',accounted_quantity:'2'}};
 const render=events=>{view.renderRecords({events});return view.get('#latest-decision').innerHTML;};
 assert.match(render([decision]),/Proposed purchase · not a confirmed fill/);
 assert.match(render([decision,intent]),/outcome not confirmed/);
 assert.match(render([decision,intent,fill,closure]),/Partial fill recorded/);
 fill.payload.fill.quantity=2;assert.match(render([decision,intent,fill]),/Fill recorded · completion unconfirmed/);const full=render([decision,intent,fill,closure]);assert.match(full,/Filled paper purchase/);assert.match(full,/2 SPY shares at \$767.50 each/);assert.doesNotMatch(full,/<img/);assert.match(full,/&lt;img/);
 assert.match(render([decision,intent,fill,closure,{kind:'order_closure_conflict',id:'bad',payload:{intent_id:'i'}}]),/Trade record needs checking/);
 fill.payload.intent_id='unrelated';assert.doesNotMatch(render([decision,intent,fill,closure]),/Filled paper purchase|Recorded fills:/);
 fill.payload.intent_id='i';fill.payload.fill.quantity=null;assert.doesNotMatch(render([decision,intent,fill,closure]),/Filled paper purchase|Recorded fills:/);
});

test('simplified dashboard retains blocked-state warnings, SPY explanation and unchanged monetary loss',()=>{
 const view=ui();view.renderState({experiment:{status:'paused',started_at:'2026-10-27T13:30:00Z'},operation:{authorization:'expired'},accounting:{status:'ready'},portfolio:{value:99958,cash:96000,gain:-42,total_return:-0.00042,holdings:[{symbol:'SPY',quantity:5,cost_basis:4000,market_value:3958,unrealized_pl:-42}]}});
 assert.equal(view.get('#return-value').textContent,'-$42.00');assert.match(view.get('#pause-detail').textContent,/permission has ended/);assert.match(view.get('#holdings-body').innerHTML,/Fund holding large US companies/);assert.doesNotMatch(view.get('#capital-state').textContent,/READY/);
 view.renderState({experiment:{status:'paused',started_at:'2026-10-27T13:30:00Z'},operation:{authorization:'expired'},account_drift:true,portfolio:{}});assert.equal(view.get('#pause-detail').textContent,'Account checks need attention. No new trades.');
 const page=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');assert.match(page,/<option value="investment" selected>/);assert.match(page,/CHANGE SINCE START/);assert.match(page,/What we own/);
});


test('managed standing authority displays closed session separately from blocked accounting and keeps chart visible',()=>{
 const v=ui(),base={experiment:{status:'active',started_at:'2026-10-27T13:31:45Z'},portfolio:{holdings:{}},mandate:{managed_mode:true,universe:['SPY']},operation:{mode:'managed-paper',enabled:true,problem:null,market_session_observation:{fresh:true,is_open:false}},events:[]};
 v.renderState(base);assert.equal(v.get('#operations-status').textContent,'Enabled · market closed');
 v.renderState({...base,operation:{...base.operation,problem:'Accounting discrepancy'}});assert.equal(v.get('#operations-status').textContent,'Needs attention');
 v.renderState({...base,operation:{...base.operation,market_session_observation:{fresh:false,is_open:false}}});assert.equal(v.get('#operations-status').textContent,'Enabled · fresh trade checks required');
 const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
 const before=html.slice(0,html.indexOf('id="performance-chart"'));assert.equal((before.match(/<details[ >]/g)||[]).length,(before.match(/<\/details>/g)||[]).length);
});

test('actual broker fees are plainly disclosed as expenses rather than hidden rounding',()=>{
 const view=ui();view.renderState({experiment:{started_at:'2026-10-27T13:31:45.975Z',status:'active'},portfolio:{value:100000.01,cash:96160.01,gain:0.01,fees:0.01,total_return:0.0000001}});
 assert.match(view.get('#capital-context').textContent,/Broker fees paid: \$0\.01; deducted from cash and returns/);
 assert.match(view.get('#capital-context').textContent,/SPY comparator has no inferred fee/);
});

test('market comparator is opt-in and chart clears obsolete headline when history is unavailable',()=>{
 const view=ui(),state={valuation_history:{schema:'observed-nav-v1',points:[{at:'2026-10-28T15:00:00Z',value:99990,benchmark_value:100100,official_close:false}]}};
 view.renderChart(state,true);assert.equal((view.get('#performance-chart').innerHTML.match(/<circle /g)||[]).length,1);assert.match(view.get('#chart-summary').textContent,/-\$10.00 since opening/);
 view.get('#compare-market').checked=true;view.renderChart(state,true);assert.equal((view.get('#performance-chart').innerHTML.match(/<circle /g)||[]).length,2);assert.match(view.get('#performance-chart').innerHTML,/Starting money invested in SPY/);
 view.renderChart({},true);assert.equal(view.get('#chart-summary').textContent,'');
});

test('human decision detail separates rationale from technical IDs and preserves original payload exactly',()=>{
 const view=ui();view.get('#decision-filter').value='investment';
 const event={kind:'decision',id:'private-record-id',created_at:'2026-10-29T01:00:00Z',payload:{title:'Keep watching Microsoft',action:'hold',size:0,plain_language_summary:'Strong growth, but spending also rose.',summary:'Original contingent15k statement',research_id:'technical-research-id',snapshot_ids:['technical-snapshot'],thesis:'Evaluate growth and price.',horizon:'Within original180days.',uncertainties:'callQ&A unverified.',evidence:[null,{title:'Company results',url:'https://example.com/results'}]}};
 const before=JSON.stringify(event);view.renderRecords({events:[event]});const html=view.get('#decision-list').innerHTML;const visible=html.split('<details class="record-detail technical">')[0];
 assert.match(visible,/Strong growth/);assert.match(visible,/Why/);assert.match(visible,/Next checkpoint/);assert.match(visible,/original 180 days/);assert.match(visible,/call Q&amp;A/);assert.doesNotMatch(visible,/technical-research-id|technical-snapshot|private-record-id|\$0.00|Proposal/);
 assert.match(html,/Original contingent15k statement/);assert.match(html,/technical-research-id/);assert.equal(JSON.stringify(event),before);
 event.payload.evidence={unexpected:'shape'};assert.doesNotThrow(()=>view.renderRecords({events:[event]}));
});

test('actual October29 observation separates broker valuation from older IEX history without changing either',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/actual-dashboard-observation-2026-10-29.json',import.meta.url)));
 const view=ui();const before=JSON.stringify(fixture);
 view.renderState({experiment:{started_at:'2026-10-27T13:31:45.975Z',initial_cash:100000,status:'active'},portfolio:fixture.analytical_portfolio});
 assert.equal(view.get('#portfolio-value').textContent,'$100,053.34');
 view.renderBrokerDisplay({status:'available',observation:{equity:fixture.account.equity,cash:fixture.account.cash,retrieved_at:fixture.retrieved_at,is_open:false,holdings:fixture.positions}});
 assert.equal(view.get('#portfolio-value').textContent,'$99,783.48');assert.equal(view.get('#cash-value').textContent,'$43,546.18');assert.equal(view.get('#return-value').textContent,'-$216.52');
 assert.match(view.get('#holdings-body').innerHTML,/12,001.50/);assert.match(view.get('#fee-note').textContent,/\$0.01/);assert.match(view.get('#fee-note').textContent,/no hypothetical fee/);
 assert.equal(JSON.stringify(fixture),before);
});
