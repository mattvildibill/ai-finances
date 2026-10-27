'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value));
const money = (value, digits = 2) => numeric(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value)) : '—';
const number = (value, digits = 2) => numeric(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const presentOrLegacy = (value, legacy) => value === undefined ? legacy : value;
const knownRatio = (part, whole) => numeric(part) && numeric(whole) && Number(whole) > 0 ? Number(part) / Number(whole) : null;
const percent = (value) => !numeric(value) ? '—' : `${number(Number(value) * 100, 2)}%`;
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeURL = (value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
const asText = (value) => Array.isArray(value) ? value.map(asText).join('\n') : value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '');
const formatTime = (value, short = false) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit', ...(short ? {} : { second: '2-digit' }), timeZoneName: 'short' }).format(new Date(value));
};
const byTime = (a, b) => new Date(b.created_at || b.recorded_at || 0) - new Date(a.created_at || a.recorded_at || 0);
let currentState = null;
let currentView = 'overview';
let replayRequest = 0;

function showMessage(message, isError = false) {
  const element = $('#global-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = !message;
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error(response.status === 401 || response.status === 403 ? 'Sign in to your private workspace to view the experiment.' : 'The server returned an unreadable response. Please try again.'); }
  if (!response.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `The request failed (${response.status}).`);
  return data;
}

function setView(view, updateHash = true) {
  if (!['overview', 'decisions', 'journal', 'replay', 'operations'].includes(view)) view = 'overview';
  currentView = view;
  $$('.view').forEach((element) => { element.hidden = element.id !== `view-${view}`; });
  $$('.nav-item').forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (updateHash) { history.replaceState(null, '', `#${view}`); const heading = $(`#view-${view} h1`); heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

function emptyState(title, description, mark = '○') {
  return `<div class="empty-state"><div class="empty-mark" aria-hidden="true">${escapeHTML(mark)}</div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(description)}</p></div>`;
}

function getEvents(state) {
  const rows = [...(state.events || []), ...(state.snapshots || [])];
  if (state.latest_snapshot && !rows.some((event) => event.id === state.latest_snapshot.id)) rows.push(state.latest_snapshot);
  return [...new Map(rows.map((event) => [event.id, event])).values()].map((event) => ({ ...event, payload: typeof event.payload === 'string' ? parseJSON(event.payload) : event.payload || {} })).sort(byTime);
}

function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

function latestSnapshot(state) {
  const snapshots = [...(state.snapshots || [])].sort(byTime);
  const entry = state.latest_snapshot || snapshots[0];
  if (!entry) return null;
  return { ...entry, payload: typeof entry.payload === 'string' ? parseJSON(entry.payload) : entry.payload || entry };
}

function renderState(state) {
  currentState = state;
  const experiment = state.experiment || {};
  const portfolio = state.portfolio || {};
  const started = Number.isFinite(Date.parse(experiment.started_at));
  const unstarted = experiment.started_at === null && (experiment.phase === 'unstarted' || state.accounting?.status === 'not_started');
  const statusKnown = ['paused', 'active', 'running'].includes(experiment.status);
  const paused = experiment.status !== 'active' && experiment.status !== 'running';
  const value = presentOrLegacy(portfolio.value, portfolio.equity);
  const cash = portfolio.cash;
  const historical = !numeric(value) && state.last_verified_valuation && numeric(state.last_verified_valuation.value) ? state.last_verified_valuation : null;
  $('#portfolio-value').textContent = money(historical ? historical.value : value);
  $('#state-time').textContent = 'Simulated investing · Real market prices';
  $('#invested-value').textContent = knownRatio(cash, value) === null ? '—' : money(Number(value) - Number(cash));
  $('#cash-value').textContent = money(cash);
  $('#capital-state').textContent = !statusKnown ? 'UNVERIFIED' : started ? (state.operation?.authorization==='expired'?'NO NEW TRADES':paused ? 'PAUSED' : 'PAPER PORTFOLIO') : unstarted ? 'PRE-LAUNCH' : 'UNVERIFIED';
  $('#capital-title').firstChild.textContent = unstarted ? 'OPENING CAPITAL ' : historical ? 'LAST VERIFIED VALUE ' : 'TOTAL VALUE ';
  $('#capital-context').textContent = historical ? `Historical observation · ${formatTime(historical.at)} · Current valuation unavailable; cash and holdings below are separate.` : started ? `${portfolio.valuation_status === 'last_known' ? 'Last available price' : 'Prices observed'} ${formatTime(portfolio.observation?.observed_at || portfolio.as_of, true)} · Not an official close` : unstarted ? 'Allocated starting cash · Official experiment not started' : 'Experiment state unavailable';
  const gain = presentOrLegacy(portfolio.gain, portfolio.total_gain);
  $('#return-value').textContent = started ? money(gain) : unstarted ? 'Not started' : '—';
  $('#return-value').classList.toggle('negative', started && numeric(gain) && Number(gain) < 0);
  $('#return-value').classList.toggle('positive', started && numeric(gain) && Number(gain) > 0);
  $('#return-value').style.fontSize = started ? '' : '27px';
  $('#return-detail').textContent = started ? `${percent(portfolio.total_return)} since we started` : unstarted ? 'Awaiting inception' : 'Inception unverified';
  $('#relative-return').textContent = started && state.benchmark?.excess_return !== undefined ? percent(state.benchmark.excess_return) : unstarted ? 'Not started' : 'Not available';
  const cashRatio = knownRatio(cash, value);
  $('#cash-percent').textContent = cashRatio === null ? 'Waiting for accounting state' : `${percent(cashRatio)} of portfolio`;
  $('#cash-track').hidden = cashRatio === null;
  $('#cash-track').style.width = `${cashRatio === null ? 0 : Math.min(100, Math.max(0, cashRatio * 100))}%`;
  $('#pause-banner').hidden = !paused || !statusKnown;
  $('#pause-detail').textContent = state.account_drift || state.accounting?.status === 'blocked' ? 'Account checks need attention. No new trades.' : state.operation?.authorization === 'expired' ? 'Today’s trading permission has ended. Holdings stay invested; a new review is needed before buying again.' : 'No new trades until the required checks pass.';
  $('#operations-status').textContent = state.operation?.mode==='managed-paper' ? (state.operation.problem ? 'Needs attention' : state.operation.enabled ? 'Managed paper portfolio · trade checks required' : 'Managed trading not enabled') : !statusKnown ? 'Unverified' : state.operation?.authorization==='expired'?'Session authorization expired':state.operation?.authorization==='recorded'?'Authorization recorded · runtime checks required':paused ? 'Paused' : 'Active · paper only';
  renderMarket(state);
  renderHoldings(portfolio, started);
  renderChart(state, started, unstarted);
  renderRisk(state, started);
  renderRecords(state);
  renderHealth(state);
  renderMandate(state.mandate || {});
  $('#loading').hidden = true;
  $('#app-content').hidden = false;
}

function approvedUniverse(mandate) {
  const symbols = mandate?.universe;
  return Array.isArray(symbols) && symbols.length > 0 && symbols.every(symbol => typeof symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) && new Set(symbols).size === symbols.length ? symbols : null;
}

function renderMarket(state) {
  const snapshot = latestSnapshot(state);
  const payload = snapshot?.payload || {};
  const quotes = payload.quotes || payload.trades || payload.market?.quotes || {};
  const clock = payload.clock || {};
  const retrieved = payload.retrieved_at || snapshot?.created_at || payload.retrieval_time;
  const names = { AAPL: 'Apple Inc.', MSFT: 'Microsoft', SPY: 'Fund holding large US companies' };
  const universe = approvedUniverse(state.mandate);
  $('#market-quotes').innerHTML = universe ? universe.map((symbol) => {
    const raw = Array.isArray(quotes) ? quotes.find((entry) => entry?.symbol === symbol) : quotes[symbol];
    const quote = raw?.latestTrade || raw?.trade || raw || {};
    const price = presentOrLegacy(quote.price, quote.p);
    const timestamp = quote.market_data_at || quote.timestamp || quote.t;
    const age = (new Date(state.as_of).getTime() - new Date(timestamp).getTime()) / 1000;
    const freshness = !timestamp || !Number.isFinite(age) ? 'Unverified time' : age < -5 ? 'Future timestamp' : age > 120 ? 'Stale' : 'At state cutoff';
    return `<div class="quote-row"><div class="quote-symbol"><span class="ticker-icon ${symbol === 'SPY' ? 'spy' : ''}" aria-hidden="true">${escapeHTML(symbol[0])}</span><div class="ticker-name"><strong>${escapeHTML(symbol)}</strong><span>${escapeHTML(names[symbol] || 'Approved instrument')}</span></div></div><div class="quote-price"><strong>${money(price, 3).replace(/0$/, '')}</strong><time ${timestamp ? `datetime="${escapeHTML(timestamp)}"` : ''}>${timestamp ? escapeHTML(formatTime(timestamp)) : 'No verified price'}</time><span class="quote-freshness">${freshness}</span></div></div>`;
  }).join('') : emptyState('Approved universe unavailable', 'No approved symbol list was returned with this state.');
  $('#retrieval-time').textContent = retrieved ? formatTime(retrieved, true) : 'No successful retrieval';
  const observedAt = clock.timestamp;
  const observedMs = observedAt ? new Date(observedAt).getTime() : NaN;
  const asOfMs = state.as_of ? new Date(state.as_of).getTime() : NaN;
  const ageSeconds = Number.isFinite(observedMs) && Number.isFinite(asOfMs) && asOfMs >= observedMs ? Math.floor((asOfMs - observedMs) / 1000) : null;
  const verified = typeof clock.is_open === 'boolean' && ageSeconds !== null;
  $('#session-badge').textContent = verified ? `At snapshot: ${clock.is_open ? 'open' : 'closed'}` : 'Session unverified';
  $('#session-time').textContent = verified ? `Clock observed ${formatTime(observedAt)} · ${number(ageSeconds, 0)} seconds old as of ${formatTime(state.as_of)}. Saved observation; not a live session check.` : 'No timestamped session observation valid at this state’s as-of time.';
}

function renderHoldings(portfolio, started) {
  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  $('#holdings-count').textContent = (portfolio.holdings_status === 'unknown' || !Array.isArray(portfolio.holdings)) ? 'Holdings unavailable' : `${holdings.length} position${holdings.length === 1 ? '' : 's'}`;
  $('#holdings-body').innerHTML = holdings.map((holding) => {
    const marketValue = presentOrLegacy(holding.market_value, holding.value);
    const gain = presentOrLegacy(holding.unrealized_pl, holding.unrealized_gain);
    const weight = presentOrLegacy(holding.weight, knownRatio(marketValue, portfolio.value));
    return `<tr><td><strong>${escapeHTML(holding.symbol)}</strong>${holding.symbol === 'SPY' ? '<small class="holding-description">Fund holding large US companies</small>' : ''}</td><td>${number(presentOrLegacy(holding.qty, holding.quantity), 8)}</td><td>${money(holding.cost_basis)}</td><td>${money(marketValue)}</td><td class="${Number(gain) < 0 ? 'negative' : Number(gain) > 0 ? 'positive' : ''}">${money(gain)}</td><td>${percent(weight)}</td></tr>`;
  }).join('');
  $('#holdings-empty').hidden = holdings.length > 0;
  $('#holdings-empty strong').textContent = (portfolio.holdings_status === 'unknown' || !Array.isArray(portfolio.holdings)) ? 'Holdings unavailable' : 'No holdings';
  $('#holdings-empty p').textContent = (portfolio.holdings_status === 'unknown' || !Array.isArray(portfolio.holdings)) ? 'Holdings could not be verified.' : started ? 'All cash.' : 'Awaiting inception.';
}

function renderChart(state, started, unstarted = state.experiment?.started_at === null && state.experiment?.phase === 'unstarted') {
  const history=state.valuation_history;
  const points=history?.schema==='observed-nav-v1'&&Array.isArray(history.points)?history.points.filter(p=>Number.isFinite(Date.parse(p.at))&&numeric(p.value)&&numeric(p.benchmark_value)&&Number(p.value)>0&&Number(p.benchmark_value)>0&&p.official_close===false&&(!Number.isFinite(Date.parse(state.as_of))||Date.parse(p.at)<=Date.parse(state.as_of))):[];
  if(!started||!points.length){
    $('#performance-chart').innerHTML = `<div class="chart-empty"><span aria-hidden="true"></span><strong>${unstarted ? 'Not started' : 'Performance history unavailable'}</strong><p>${unstarted ? 'Awaiting inception.' : 'No verified NAV series supplied.'}</p></div>`;
    $('#chart-note').textContent = history?.reason || 'No portfolio or SPY series available.';
    return;
  }
  const width=640,height=240,pad=35,times=points.map(p=>Date.parse(p.at)),values=points.flatMap(p=>[Number(p.value),Number(p.benchmark_value)]),lo=Math.min(...values),hi=Math.max(...values),spread=Math.max(hi-lo,1),first=Math.min(...times),last=Math.max(...times);
  const x=t=>pad+(width-2*pad)*(last===first?.5:(t-first)/(last-first));
  const y=v=>height-pad-(height-2*pad)*(v-lo+spread*.08)/(spread*1.16);
  const dots=points.map(p=>['value','benchmark_value'].map((key,i)=>`<circle cx="${x(Date.parse(p.at)).toFixed(2)}" cy="${y(Number(p[key])).toFixed(2)}" r="3.5" fill="${i?'#947338':'#164f78'}"><title>${escapeHTML(i?'SPY comparator':'Blue')}: ${escapeHTML(money(p[key]))} · ${escapeHTML(formatTime(p.at))} · ${escapeHTML(p.snapshot_id)}${p.valuation_status==='last_known'?' · Last-known mark':''}</title></circle>`).join('')).join('');
  $('#performance-chart').innerHTML=`<svg class="observed-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Observed Blue and SPY portfolio values. Separate dots, not official daily closes."><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" stroke="#bdc5c6"/><text x="${pad}" y="16">${escapeHTML(money(hi))}</text><text x="${pad}" y="${height-5}">${escapeHTML(formatTime(new Date(first).toISOString(),true))}</text>${dots}</svg><div class="observed-legend"><span>● Blue</span><span>● SPY comparator</span></div>`;
  const rows=points.slice(-20).reverse().map(p=>`<tr><td>${escapeHTML(formatTime(p.at))}</td><td>${escapeHTML(money(p.value))}</td><td>${escapeHTML(money(p.benchmark_value))}</td><td>${Array.isArray(p.marks)?p.marks.map(m=>`${escapeHTML(m.symbol)} ${escapeHTML(formatTime(m.market_data_at))}`).join('<br>'):'Source timestamps unavailable'}</td></tr>`).join('');
  $('#performance-chart').innerHTML+=`<details class="observation-table"><summary>Read latest ${Math.min(points.length,20)} observations</summary><div class="table-scroll"><table><caption>Recorded values, not official closes</caption><thead><tr><th>Accounting cutoff</th><th>Blue</th><th>SPY</th><th>Trade timestamps</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  $('#chart-note').textContent=`${points.length} observed points · ${formatTime(new Date(last).toISOString(),true)} latest. Not official closes; gaps are not interpolated.${history.truncated?' Recent 200 reconciliation receipts only.':''}${history.omitted_unverified?' Unverified observations omitted.':''}`;
}

function renderRisk(state, started) {
  const risk = state.risk || state.portfolio?.risk || {};
  const positions = state.portfolio?.holdings || [];
  const items = [
    { label: 'Largest position', value: percent(risk.largest_position), note: (state.portfolio?.holdings_status === 'unknown' || !Array.isArray(state.portfolio?.holdings)) ? 'Accounting unavailable' : positions.length ? (risk.observation_status==='last_known'?'Share at last-known marks':'Share of portfolio value') : 'No invested exposure' },
    { label: 'Max. drawdown', value: started ? percent(risk.max_drawdown) : '—', note: started ? 'Peak-to-trough decline' : 'Requires active history' },
    { label: 'Annualized volatility', value: started ? percent(risk.annualized_volatility) : '—', note: 'Requires sufficient daily returns' },
  ];
  $('#risk-grid').innerHTML = items.map((item) => `<div class="risk-metric"><span>${item.label}</span><strong>${item.value}</strong><small>${item.note}</small></div>`).join('');
}

function roleName(event) {
  return ({ researcher: 'Researcher', challenger: 'Independent challenger', portfolio_manager: 'Portfolio manager' }[event.payload.role]) || ({ research: 'Researcher', challenge: 'Independent challenger', decision: 'Portfolio manager', revision: 'Revision', system: 'System record', snapshot: 'Market observation' }[event.kind] || event.payload.role || event.kind || 'Record');
}

function readableValue(value) {
  if (value === null) return 'null (recorded)';
  if (Array.isArray(value)) return value.every(item => item === null || typeof item !== 'object') ? escapeHTML(value.map(item => item === null ? 'null (recorded)' : asText(item)).join('\n')) : `<ul class="structured-list">${value.map(item => `<li>${readableValue(item)}</li>`).join('')}</ul>`;
  if (value && typeof value === 'object') return `<dl class="structured-fields">${Object.entries(value).map(([key, item]) => `<dt>${escapeHTML(key.replace(/_/g, ' '))}</dt><dd>${readableValue(item)}</dd>`).join('')}</dl>`;
  return escapeHTML(asText(value));
}

function recordCard(event, journal = false) {
  const payload = event.payload || {};
  if (event.kind === 'snapshot') {
    return `<article class="record-card"><div class="record-topline"><span class="role-tag">Market observation · Alpaca IEX</span><time>Recorded ${escapeHTML(formatTime(event.created_at))}</time></div><h2>The market, as observed.</h2><div class="record-summary">Retrieved ${escapeHTML(formatTime(payload.retrieved_at))}. ${payload.clock?.is_open === true ? 'The regular trading session was open.' : payload.clock?.is_open === false ? 'The regular trading session was closed.' : 'Session status was unverified.'}</div><div class="record-facts">${Object.entries(payload.quotes || {}).map(([symbol, quote]) => `<dl><dt>${escapeHTML(symbol)} · IEX last trade</dt><dd>${money(quote.price, 3)}<br>Market time: ${escapeHTML(formatTime(quote.market_data_at))}</dd></dl>`).join('')}</div><p class="record-id">Immutable snapshot ${escapeHTML(event.id)}</p><details class="record-detail"><summary>Full observation receipt</summary>${readableValue(payload)}</details></article>`;
  }
  // Every authored payload field remains inspectable in every record view.
  const labels = { thesis: 'Original thesis', horizon: 'Expected horizon', change_mind: 'What would change our mind', invalidation_conditions: 'Invalidation conditions', size: 'Proposed size · USD notional', position_size: 'Position size', counterargument: 'Independent counterargument', challenge_response: 'Response to the challenge', snapshot_ids: 'Source snapshots', required_before_purchase_thesis: 'Required before purchase thesis' };
  const facts = Object.entries(payload).filter(([key]) => !['title', 'summary', 'author', 'role'].includes(key)).map(([key, value]) => [labels[key] || key.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase()), value === null ? 'null (recorded)' : key === 'size' ? money(value) : value]);
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const evidenceHTML = evidence.length ? `<details class="evidence"><summary>${evidence.length} evidence source${evidence.length === 1 ? '' : 's'} · inspect provenance</summary><ul>${evidence.map((source) => {
    const url = safeURL(source.url);
    const label = source.title || source.url || 'Recorded source';
    return `<li>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} <svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></a>` : escapeHTML(label)}<time>Observed: ${escapeHTML(formatTime(source.observed_at || source.retrieved_at))}</time>${source.published_at ? `<time>Published: ${escapeHTML(formatTime(source.published_at))}</time>` : ''}${source.excerpt ? `<p>${escapeHTML(source.excerpt)}</p>` : ''}</li>`;
  }).join('')}</ul></details>` : '';
  const kind = ['research', 'challenge', 'decision'].includes(event.kind) ? event.kind : '';
  return `<article class="record-card"><div class="record-topline"><span class="role-tag ${kind}">${escapeHTML(roleName(event))}${event.kind === 'decision' ? ' · Proposal' : ''}</span></div><h2>${escapeHTML(payload.title || (payload.action === 'hold' ? 'A decision to hold.' : payload.summary?.slice(0, 85) || 'Recorded contribution'))}</h2><details class="record-detail"><summary>Original wording &amp; details</summary><time>Recorded ${escapeHTML(formatTime(event.created_at || event.recorded_at))}</time><div class="record-summary">${escapeHTML(payload.summary || payload.thesis || payload.message || 'No summary supplied.')}</div>${facts.some(([, value]) => value !== undefined && value !== null && value !== '') ? `<div class="record-facts">${facts.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => `<dl><dt>${escapeHTML(label)}</dt><dd>${readableValue(value)}</dd></dl>`).join('')}</div>` : ''}${evidenceHTML}<p class="record-id">${payload.author ? `Authored by ${escapeHTML(payload.author)} · ` : ''}Immutable record ${escapeHTML(event.id || 'ID unavailable')}</p></details></article>`;
}

// Presentation copy is matched to the immutable record digest, never used by execution.
const decisionCopy = {
  "blue-decision-hold-001": {
    "digest": "3b5e4c208c0655dd2abed5b3f089b88cc944ed86eebe88cbee1c9041c515e6bb",
    "category": "setup",
    "title": "Wait before investing",
    "reason": "The account checks worked, but trade accounting and the comparison portfolio still needed testing."
  },
  "blue-cycle-hold-20261027": {
    "digest": "69f308592612991b87aab86707fb784815fa894596b52e671110c30b25f0d738",
    "category": "setup",
    "title": "Keep the starting money in cash",
    "reason": "The connection worked. More trading and accounting checks were still needed before starting."
  },
  "blue-adoption-hold-2026-10-27": {
    "digest": "19dd1ef046f2e1fa4b98934c90b665c188dc8a9fb81ea7b2ef637e969b98cecf",
    "category": "setup",
    "title": "Keep trading paused",
    "reason": "Blue could read and save reviews, but scheduled-task controls were still unresolved."
  },
  "blue-initial-universe-hold-2026-10-27": {
    "digest": "b864e55d2cf6e16dd8e285d5f10ea125130c0ad8b1cc78a9f3ced83a5223cc45",
    "category": "setup",
    "title": "Wait for a stronger buying case",
    "reason": "SPY was a candidate, but launch checks and the reason to buy were not complete."
  },
  "blue-broader-plan-2026-10-27": {
    "digest": "94c09544fc6871db61ce2d6fdc7feffa3d232bace63772b8a22be88e9a936288",
    "category": "setup",
    "title": "Research a more varied portfolio",
    "reason": "Consider funds covering different markets after the first small test purchase. No purchase was approved here."
  },
  "blue-opening-manager-plan-2026-10-27": {
    "digest": "287dc38b6d59dcf2d590365e24ec73f201d8b1de751fcdc09dff2b58ebc002d5",
    "category": "setup",
    "title": "Plan a small start with SPY",
    "reason": "First test one share, then consider a total SPY investment of up to $4,000 after reviewing the result."
  },
  "blue-opening-limit-policy-2026-10-27": {
    "digest": "1366c967ee77352dcc2e8d8177cdf131d7d6eca127fdd4b8d705ae09775f47aa",
    "category": "setup",
    "title": "Set a maximum buying price",
    "reason": "Prepare a price limit for the planned SPY purchases. This record did not place an order."
  },
  "blue-spy-pilot-decision-2026-10-27": {
    "digest": "cfc2c892d1a0ff628ff2221af35da2a5bb75f418818790db3743e0ef677c559c",
    "category": "investment",
    "title": "Start with one SPY share",
    "reason": "Start small to check the paper-trading process before investing more."
  },
  "blue-spy-core-buy-2026-10-27": {
    "digest": "c976766f9b2078271ffe92e8015cb457c9aa3ab71d1f3117c5d2a84fbb9c2c8f",
    "category": "investment",
    "title": "Add four SPY shares",
    "reason": "Build the first broad US-market position while keeping total SPY spending below $4,000."
  },
  "blue-ijr-admission-deferred-2026-10-27": {
    "digest": "1d6f2cc1212dfa4afc52426b3b38ae2596cfb8095187f965adb10c77f024341b",
    "category": "investment",
    "title": "Wait on a small-company fund",
    "reason": "IJR research was complete, but the approval process could not finish before its price checks expired. No IJR was bought."
  },
  "blue-launch-decision-2026-10-27-1530Z": {
    "digest": "ab14eb1f0baae780c12665355acd0b7ab42439a2d0169ebe60b82163e9a4d854",
    "category": "investment",
    "title": "Keep SPY and hold the cash",
    "reason": "The new information did not justify buying Apple or Microsoft. The IJR approval process still needed a repair."
  },
  "blue-launch-decision-2026-10-27-1730Z": {
    "digest": "b067f8577e817225a7260aa89dc04638e7575da07f6a9673a46cb2cb2b58dc42",
    "category": "investment",
    "title": "Keep the portfolio unchanged",
    "reason": "The account checks found no problem. Blue chose not to make another purchase."
  },
  "blue-launch-decision-2026-10-27-1930Z": {
    "digest": "5a83008a77f9e223b8b5079074cc8fb42935b5fc03a7c522f80616685003ce83",
    "category": "investment",
    "title": "Keep the five SPY shares",
    "reason": "No further purchase was proposed. Next, record the portfolio value near the market close."
  },
  "blue-review-hold-2026-10-27-close": {
    "digest": "1791147c1f660e251bfac7fadf9c055ce69024056a26cf5ee83f446920ec8dd0",
    "category": "investment",
    "title": "Keep SPY; make no new purchase",
    "reason": "Keep the five SPY shares and the remaining cash. Prices were too old for a new trade, and upcoming company results and a Federal Reserve decision were still pending."
  }
};
function decisionPresentation(event, events) {
  const p=event.payload || {}, saved=decisionCopy[event.id];
  const copy=saved && saved.digest===event.digest ? saved : null;
  const category=copy?.category || (p.admission_approval===true ? 'setup' : 'investment');
  const intents=events.filter(e=>e.kind==='order_intent' && e.payload.decision_id===event.id);
  const fills=events.filter(e=>e.kind==='ledger_fill' && intents.some(i=>i.id===e.payload.intent_id && i.payload.order?.symbol===e.payload.fill?.symbol && i.payload.order?.side===e.payload.fill?.side) && e.payload.fill?.symbol===p.symbol && e.payload.fill?.side===p.action && numeric(e.payload.fill?.quantity) && Number(e.payload.fill.quantity)>0 && numeric(e.payload.fill.price_text) && Number(e.payload.fill.price_text)>0);
  const conflict=events.some(e=>e.kind==='order_closure_conflict' && intents.some(i=>i.id===e.payload.intent_id));
  const completed=intents.length===1 && fills.length>0 && events.some(e=>e.kind==='order_closed' && e.payload.intent_id===intents[0].id && e.payload.status==='filled' && numeric(e.payload.accounted_quantity) && numeric(intents[0].payload.order?.qty) && Number(e.payload.accounted_quantity)===Number(intents[0].payload.order.qty) && fills.reduce((n,f)=>n+Number(f.payload.fill.quantity),0)===Number(e.payload.accounted_quantity));
  const partial=intents.length===1 && numeric(intents[0].payload.order?.qty) && fills.length>0 && fills.reduce((n,f)=>n+Number(f.payload.fill.quantity),0)<Number(intents[0].payload.order.qty);
  const status=conflict?'Trade record needs checking':completed?(p.action==='sell'?'Filled paper sale':'Filled paper purchase'):fills.length?(partial?'Partial fill recorded':'Fill recorded · completion unconfirmed'):intents.length?'Order recorded · outcome not confirmed':p.action==='hold'?'No new purchase':p.action==='buy'?'Proposed purchase · not a confirmed fill':p.action==='sell'?'Proposed sale · not a confirmed fill':'Recorded review';
  return {category,status,title:copy?.title || (p.action==='buy'?`Consider buying ${p.symbol || 'an investment'}`:p.action==='sell'?`Consider selling ${p.symbol || 'an investment'}`:p.action==='hold'?'Leave the portfolio unchanged':'Review the plan'),reason:copy?.reason || (typeof p.plain_language_summary==='string' && p.plain_language_summary.trim() ? p.plain_language_summary : 'The original explanation is available below.'),fills};
}
function investmentCard(event,events) {
  const d=decisionPresentation(event,events);
  const receipts=d.fills.map(e=>{const f=e.payload.fill;return `${number(f.quantity,8)} ${escapeHTML(f.symbol)} share${Number(f.quantity)===1?'':'s'} at ${money(f.price_text)} each`;}).join(' · ');
  return `<article class="record-card investment-card"><div class="role-tag">${escapeHTML(d.status)}</div><h2>${escapeHTML(d.title)}</h2><p class="record-summary">${escapeHTML(d.reason)}</p>${receipts?`<p class="fill-summary">Recorded fills: ${receipts}</p>`:''}<details class="record-detail"><summary>Why, sources &amp; original record</summary>${recordCard(event)}${d.fills.map(e=>`<details><summary>Fill receipt</summary>${readableValue(e)}</details>`).join('')}</details></article>`;
}
function renderRecords(state) {
  const events = getEvents(state);
  const contributions = events.filter((event) => ['research', 'challenge', 'decision', 'revision'].includes(event.kind));
  const decisions = contributions.filter((event) => event.kind === 'decision');
  const investments=decisions.filter(e=>decisionPresentation(e,events).category==='investment');
  $('#decision-count').textContent = investments.length;
  $('#contribution-total').textContent = state.history_truncated ? 'Recent history · full records in System details' : 'Original records kept in full';
  const filter = $('#decision-filter').value;
  const filtered = contributions.filter((event) => filter === 'all' || event.kind === filter);
  const latestHold=investments.find(e=>e.payload.action==='hold');
  const highlights=investments.filter(e=>e.payload.action!=='hold'||e===latestHold);
  const older=contributions.filter(e=>!highlights.includes(e));
  $('#decision-list').innerHTML = filter==='investment' ? (highlights.length?highlights.map(e=>investmentCard(e,events)).join(''):emptyState('No investment decision yet','Planning and account checks are kept below.')) + (older.length?`<details class="desk-detail"><summary>Earlier reviews, research &amp; setup (${older.length})</summary>${older.map(e=>recordCard(e)).join('')}</details>`:'') : filtered.length ? filtered.map((event) => recordCard(event)).join('') : emptyState('No contributions', 'No records in this view.');
  const journal = contributions.filter(event => ['decision', 'revision'].includes(event.kind));
  $('#journal-list').innerHTML = journal.length ? journal.map((event) => recordCard(event, true)).join('') : emptyState('No decisions yet', 'Awaiting manager review.');
  if (!$('#replay-date').value || $('#replay-date').value === 'all') {
    $('#replay-list').innerHTML = events.length ? events.map(event => recordCard(event)).join('') : emptyState('No history yet', '');
    $('#replay-status').textContent = state.history_truncated ? 'Recent records · Download the full audit log in Operations.' : 'Present record';
  }
  const latest = investments[0];
  $('#latest-decision').innerHTML = latest ? investmentCard(latest,events) : `<div class="latest-content"><h3>No investment decision yet</h3><p>Account setup and research are available in Decisions.</p></div>`;
}

function healthItem(label, value, detail = '', kind = '') {
  return `<div class="health-row"><div>${escapeHTML(label)}${detail ? `<span>${escapeHTML(detail)}</span>` : ''}</div><strong class="health-value ${kind}">${escapeHTML(value)}</strong></div>`;
}

function healthValue(value, fallback = 'Unverified') {
  if (value === true) return 'Verified';
  if (value === false) return 'Not verified';
  if (value && typeof value === 'object') return value.status || value.message || fallback;
  return value ? String(value) : fallback;
}

function reconciliationDisplay(state) {
  const receipt = state.last_reconciliation;
  if (!receipt) return { value: 'Not run', detail: '', kind: '' };
  const payload = typeof receipt.payload === 'string' ? parseJSON(receipt.payload) : receipt.payload || {};
  const problems = Array.isArray(payload.problems) ? payload.problems : null;
  const onlyNotStarted = problems?.length === 1 && problems[0]?.code === 'not_started';
  const awaiting = payload.status === 'blocked' && payload.ledger_status === 'not_started' &&
    payload.trading_permitted === false && onlyNotStarted && state.experiment?.started_at === null &&
    state.accounting?.status === 'not_started' && Array.isArray(state.accounting.problems) &&
    state.accounting.problems.length === 1 && state.accounting.problems[0]?.code === 'not_started' &&
    state.account_drift === false && state.health?.source_status === 'connected' && !state.health?.last_error;
  const value = awaiting ? 'Awaiting start' : healthValue(payload.status);
  const reasons = problems?.map(problem => typeof problem === 'object' && problem !== null ? problem.message || problem.code || 'Unspecified problem' : asText(problem)).join(' · ');
  return { value, detail: [`Last receipt ${formatTime(receipt.created_at)}`, awaiting ? 'Official inception pending; execution remains gated.' : reasons].filter(Boolean).join(' · '), kind: awaiting ? '' : payload.status === 'blocked' ? 'warning' : '' };
}

function renderHealth(state) {
  const health = state.health || {};
  const snapshot = latestSnapshot(state);
  const account = snapshot?.payload?.account;
  const review = health.last_successful_review || health.last_review_at;
  const automation = health.automation || health.automation_status || health.scheduler;
  const reconciliation = reconciliationDisplay(state);
  const rows = [
    healthItem('Paper reconciliation', reconciliation.value, reconciliation.detail, reconciliation.kind),
    healthItem('Official experiment', state.experiment?.status || 'Unverified', state.experiment?.started_at ? `Started ${formatTime(state.experiment.started_at)}` : 'No inception timestamp; no official performance history.', 'warning'),
    healthItem('Alpaca paper connection', healthValue(health.alpaca ?? health.alpaca_status ?? health.source_status ?? (account?.status === 'ACTIVE' ? 'Authenticated' : null)), 'Server-side paper endpoint only.', health.source_status === 'connected' ? 'ok' : ''),
    healthItem('Market data', health.source_status === 'failed' ? 'Update failed' : snapshot ? health.data_fresh === true ? 'Fresh at state cutoff' : 'Not execution-fresh' : 'No verified snapshot', snapshot ? `Last retrieval ${formatTime(snapshot.payload.retrieved_at || snapshot.created_at)}` : 'Alpaca IEX, with source timestamps.'),
    healthItem('Persistent records', healthValue(health.persistence ?? health.database), health.persistence_detail || 'Append-only decisions and source evidence.'),
    healthItem('Blue connection', healthValue(health.blue_connection ?? health.mcp), 'Authenticated Site tools; no separate AI API billing.'),
    healthItem('Unattended updates', healthValue(automation, 'Not verified'), health.schedule || health.automation_detail || 'A saved schedule alone does not prove a successful run.'),
    healthItem('Last successful review', review ? formatTime(review) : 'No completed review', 'Research, independent challenge, and final decision.'),
    healthItem('Execution readiness', healthValue(health.execution ?? health.execution_status ?? health.trading, 'See recorded protocol'), health.data_fresh === true ? 'Freshness check passed. Execution remains subject to the recorded protocol and release-specific gates.' : 'Current execution freshness is unverified. This display grants no execution permission.', 'warning'),
  ];
  if (health.last_error) rows.push(healthItem('Last update error', 'Needs attention', asText(health.last_error), 'warning'));
  else if (health.last_failure) rows.push(healthItem('Last failed update', formatTime(health.last_failure), 'See the immutable timeline for the recorded failure.', 'warning'));
  if (state.account_drift) rows.push(healthItem('External account activity', 'Reconciliation required', 'Broker holdings or cash differ from the original allocation. Official experiment accounting has not silently adopted those changes.', 'warning'));
  const verificationRows = [];
  if (Array.isArray(health.verification)) health.verification.forEach((item) => {
    const outcome = item.outcome ?? item.status ?? 'Not recorded';
    const detail = [`Check: ${item.check || 'Not recorded'}`, `Revision: ${item.revision || item.release_revision || item.commit_sha || 'Not recorded'}`, item.summary].filter(Boolean).join(' · ');
    verificationRows.push(healthItem(item.title || 'Recorded verification', asText(outcome), detail, outcome === 'passed' ? 'ok' : outcome === 'failed' ? 'warning' : ''));
  });
  if (Array.isArray(health.blockers)) [...new Set(health.blockers)].forEach((item, index) => rows.push(healthItem(`Readiness blocker ${index + 1}`, 'Unresolved', asText(item), 'warning')));
  $('#health-list').innerHTML = rows.join('') + (verificationRows.length ? `<details class="desk-detail"><summary>Technical checks &amp; audit records (${verificationRows.length})</summary>${verificationRows.join('')}</details>` : '');
}

function renderMandate(mandate) {
  const universe = approvedUniverse(mandate);
  if(mandate.managed_mode){$('#mandate-version').textContent='Managed paper portfolio';$('#mandate-grid').innerHTML=[['Goal','180 days','Grow the original simulated $100,000 responsibly; returns are not guaranteed.'],['Spending','Available cash only','No borrowing. Reconciled sale proceeds can be reinvested.'],['Investment size','Manager judgment','Each material decision explains its size, concentration and downside. No fixed launch allocation cap.'],['Investments','Verified stocks and funds','Ordinary supported US stocks and nonleveraged, noninverse funds; no shorts or options.'],['Trading hours','Regular session only','Fresh prices and account checks are required before each order.'],['Original portfolio','Preserved','No reset of holdings, cash, history or the SPY comparison.']].map(([label,value,detail])=>`<div class="mandate-item"><h3>${label}</h3><strong>${value}</strong><p>${detail}</p></div>`).join('');return;}
  const version = value => Number.isSafeInteger(value) && value > 0 ? String(value) : 'unavailable';
  const universeVersion = mandate.universe_version === undefined ? mandate.configuration_version : mandate.universe_version;
  $('#mandate-version').textContent = `Mandate ${version(mandate.mandate_version)} · Universe ${version(universeVersion)}`;
  const single = mandate.max_position_weight ?? mandate.max_single_position ?? mandate.stock_limit;
  const etf = mandate.max_etf_weight ?? mandate.etf_limit;
  const cashFloor = mandate.min_cash_weight ?? mandate.cash_reserve ?? mandate.min_cash;
  const items = [
    ['Starting capital', '$100,000', 'Imaginary USD. No deposits, withdrawals, leverage, shorts, or options.'],
    ['Eligible universe', universe ? universe.join(' · ') : 'Unavailable', 'Long-only approved universe. Any expansion requires a recorded mandate revision.'],
    ['Single-stock limit', single !== undefined ? percent(single) : 'See approved mandate', 'Proposed weights include existing holdings and outstanding commitments.'],
    ['ETF concentration limit', etf !== undefined ? percent(etf) : 'See approved mandate', 'ETF exposure must also satisfy the experiment’s concentration rules.'],
    ['Cash reserve', cashFloor !== undefined ? percent(cashFloor) : 'Unlevered cash', 'Buying power is not a spending budget. Unlevered cash controls sizing; settlement must be reconciled before activation.'],
    ['Execution policy', 'Paper-only', 'Regular-session, fresh-data orders only. Retries use stable identities to prevent duplicates.'],
    ['Maximum new order', mandate.max_order !== undefined ? percent(mandate.max_order) : 'See approved mandate', 'Fraction of portfolio value per order; lower concentration or cash limits still apply.'],
    ['Maximum gross exposure', mandate.gross_limit !== undefined ? percent(mandate.gross_limit) : 'No leverage', 'Aggregate invested exposure is bounded independently of individual positions.'],
    ['Maximum price age', mandate.price_max_age_seconds !== undefined ? `${number(mandate.price_max_age_seconds, 0)} seconds` : 'Fresh data required', 'Retrieval time never substitutes for the timestamp of the actual market observation.'],
  ];
  $('#mandate-grid').innerHTML = items.map(([label, value, detail]) => `<div class="mandate-item"><h3>${escapeHTML(label)}</h3><strong>${escapeHTML(value)}</strong><p>${escapeHTML(detail)}</p></div>`).join('');
}

async function loadState() {
  if (!currentState) { $('#loading').hidden = false; $('#loading').textContent = 'Opening the experiment…'; }
  try {
    const state = await request('/api/state');
    renderState(state);
    return true;
  } catch (error) {
    $('#loading').hidden = true;
    showMessage(`${error.message} ${currentState ? 'The last displayed state has been retained and may be stale.' : 'No portfolio values have been fabricated.'}`, true);
    if (!currentState) {
      $('#loading').hidden = false;
      $('#loading').innerHTML = 'The experiment is temporarily unavailable.<br><button id="retry-load" class="button button-outline" style="margin-top:20px">Try again</button>';
      $('#retry-load').addEventListener('click', () => { showMessage(''); loadState(); });
    }
    return false;
  }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => { setView(button.dataset.go); $('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));
$('#decision-filter').addEventListener('change', () => { if (currentState) renderRecords(currentState); });

$('#refresh-button').addEventListener('click', async () => {
  const button = $('#refresh-button');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  showMessage('');
  try {
    const result = await request('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: crypto.randomUUID() }) });
    const loaded = await loadState();
    if (loaded) showMessage(result.message || 'Market observations refreshed.');
  } catch (error) { showMessage(`${error.message} The previous state is retained; a failed update does not authorize a trade.`, true); }
  finally { button.disabled = false; button.innerHTML = '<span aria-hidden="true"><svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5"/></svg></span> Refresh'; }
});

$('#replay-button').addEventListener('click', async () => {
  const value = $('#replay-date').value;
  if (!value || !Number.isFinite(new Date(value).getTime())) { $('#replay-status').textContent = 'Choose a valid date and time first.'; return; }
  const date = new Date(value);
  if (date > new Date()) { $('#replay-status').textContent = 'Choose a time in the past. Future information is not available.'; return; }
  const button = $('#replay-button');
  const requestId = ++replayRequest;
  button.disabled = true;
  $('#replay-status').textContent = 'Loading the historical record…';
  try {
    const replay = await request(`/api/state?as_of=${encodeURIComponent(date.toISOString())}`);
    if (requestId !== replayRequest) return;
    const events = getEvents(replay).filter((event) => new Date(event.created_at || event.recorded_at) <= date);
    $('#replay-status').textContent = `${events.length} record${events.length === 1 ? '' : 's'} available as of ${formatTime(date.toISOString())}. ${replay.history_truncated ? 'Recent window only; download the full audit log in Operations.' : 'Receipt-time view.'}`;
    $('#replay-list').innerHTML = events.length ? events.map((event) => recordCard(event)).join('') : emptyState('Before the record began.', 'No information had been recorded by the chosen moment. Information received later has been excluded.', '↶');
  } catch (error) { if (requestId === replayRequest) { $('#replay-status').textContent = error.message; $('#replay-list').innerHTML = ''; } }
  finally { if (requestId === replayRequest) button.disabled = false; }
});
$('#replay-reset').addEventListener('click', () => {
  replayRequest++;
  $('#replay-button').disabled = false;
  $('#replay-date').value = '';
  $('#replay-status').textContent = currentState?.history_truncated ? 'Recent records · Download the full audit log in Operations.' : 'Present record';
  const events = currentState ? getEvents(currentState) : [];
  $('#replay-list').innerHTML = events.length ? events.map((event) => recordCard(event)).join('') : emptyState('Nothing to rewind yet.', 'The immutable timeline begins when the first record is received.', '↶');
});

$('#export-history').addEventListener('click', async () => {
  const button = $('#export-history'); button.disabled = true; button.textContent = 'Preparing audit log…';
  try {
    const records = []; let cursor = 0;
    for (let page = 0; page < 100; page++) {
      const result = await request(`/api/export?after_seq=${cursor}`);
      records.push(...result.records);
      if (result.records.length < 500) break;
      if (page === 99) throw new Error('Export exceeds browser limit; use the paginated export_history Site tool.');
      cursor = result.next_after_seq;
    }
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), experiment: 'blue-capital-v1', records }, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'blue-capital-audit.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage(`Exported ${records.length} immutable records with receipt times and content digests.`);
  } catch (error) { showMessage(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Download audit log'; }
});

setView(location.hash.slice(1), false);
loadState();
