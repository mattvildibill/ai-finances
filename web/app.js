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
  $('#portfolio-value').textContent = money(value);
  $('#state-time').textContent = `State · ${formatTime(state.as_of)}${portfolio.valuation_status === 'unavailable' ? ' · Valuation unavailable' : ''}`;
  $('#invested-value').textContent = knownRatio(cash, value) === null ? '—' : money(Number(value) - Number(cash));
  $('#cash-value').textContent = money(cash);
  $('#capital-state').textContent = !statusKnown ? 'UNVERIFIED' : started ? (paused ? 'PAUSED' : 'PAPER PORTFOLIO') : unstarted ? 'PRE-LAUNCH' : 'UNVERIFIED';
  $('#capital-title').firstChild.textContent = unstarted ? 'OPENING CAPITAL ' : 'TOTAL VALUE ';
  $('#capital-context').textContent = started ? `Official ledger · Since ${formatTime(experiment.started_at, true)} · Modeled comparison NAV ${money(portfolio.economic_value)}` : unstarted ? 'Allocated starting cash · Official experiment not started' : 'Experiment state unavailable';
  const gain = presentOrLegacy(portfolio.gain, portfolio.total_gain);
  $('#return-value').textContent = started ? money(gain) : unstarted ? 'Not started' : '—';
  $('#return-value').classList.toggle('negative', started && numeric(gain) && Number(gain) < 0);
  $('#return-value').classList.toggle('positive', started && numeric(gain) && Number(gain) > 0);
  $('#return-value').style.fontSize = started ? '' : '27px';
  $('#return-detail').textContent = started ? `${percent(portfolio.total_return)} since inception · ${portfolio.performance_basis || 'Performance basis unavailable'}` : unstarted ? 'Awaiting inception' : 'Inception unverified';
  $('#relative-return').textContent = started && state.benchmark?.excess_return !== undefined ? percent(state.benchmark.excess_return) : unstarted ? 'Not started' : 'Not available';
  const cashRatio = knownRatio(cash, value);
  $('#cash-percent').textContent = cashRatio === null ? 'Waiting for accounting state' : `${percent(cashRatio)} of portfolio`;
  $('#cash-track').hidden = cashRatio === null;
  $('#cash-track').style.width = `${cashRatio === null ? 0 : Math.min(100, Math.max(0, cashRatio * 100))}%`;
  $('#pause-banner').hidden = !paused || !statusKnown;
  $('#pause-detail').textContent = experiment.pause_reason || (started ? 'New trading is paused. Existing records remain available for inspection.' : 'Awaiting verified inception.');
  $('#operations-status').textContent = !statusKnown ? 'Unverified' : paused ? 'Paused' : 'Active · paper only';
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
  const names = { AAPL: 'Apple Inc.', MSFT: 'Microsoft', SPY: 'S&P 500 ETF' };
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
    return `<tr><td><strong>${escapeHTML(holding.symbol)}</strong></td><td>${number(presentOrLegacy(holding.qty, holding.quantity), 8)}</td><td>${money(holding.cost_basis)}</td><td>${money(marketValue)}</td><td class="${Number(gain) < 0 ? 'negative' : Number(gain) > 0 ? 'positive' : ''}">${money(gain)}</td><td>${percent(weight)}</td></tr>`;
  }).join('');
  $('#holdings-empty').hidden = holdings.length > 0;
  $('#holdings-empty strong').textContent = (portfolio.holdings_status === 'unknown' || !Array.isArray(portfolio.holdings)) ? 'Holdings unavailable' : 'No holdings';
  $('#holdings-empty p').textContent = (portfolio.holdings_status === 'unknown' || !Array.isArray(portfolio.holdings)) ? 'Holdings could not be verified.' : started ? 'All cash.' : 'Awaiting inception.';
}

function renderChart(state, started, unstarted = state.experiment?.started_at === null && state.experiment?.phase === 'unstarted') {
  // /api/state provides the latest valuation, not a chronological NAV series.
  $('#performance-chart').innerHTML = `<div class="chart-empty"><span aria-hidden="true"></span><strong>${unstarted ? 'Not started' : 'Performance history unavailable'}</strong><p>${unstarted ? 'Awaiting inception.' : 'No verified NAV series supplied.'}</p></div>`;
  $('#chart-note').textContent = 'No portfolio or SPY series available.';
}

function renderRisk(state, started) {
  const risk = state.risk || state.portfolio?.risk || {};
  const positions = state.portfolio?.holdings || [];
  const items = [
    { label: 'Largest position', value: percent(risk.largest_position), note: (state.portfolio?.holdings_status === 'unknown' || !Array.isArray(state.portfolio?.holdings)) ? 'Accounting unavailable' : positions.length ? 'Share of portfolio value' : 'No invested exposure' },
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
  return `<article class="record-card"><div class="record-topline"><span class="role-tag ${kind}">${escapeHTML(roleName(event))}${event.kind === 'decision' ? ' · Proposal' : ''}</span><time datetime="${escapeHTML(event.created_at || event.recorded_at)}">Recorded ${escapeHTML(formatTime(event.created_at || event.recorded_at))}</time></div><h2>${escapeHTML(payload.title || (payload.action === 'hold' ? 'A decision to hold.' : payload.summary?.slice(0, 85) || 'Recorded contribution'))}</h2><div class="record-summary">${escapeHTML(payload.summary || payload.thesis || payload.message || 'No summary supplied.')}</div><details class="record-detail"><summary>Read thesis, dissent &amp; sources</summary>${facts.some(([, value]) => value !== undefined && value !== null && value !== '') ? `<div class="record-facts">${facts.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => `<dl><dt>${escapeHTML(label)}</dt><dd>${readableValue(value)}</dd></dl>`).join('')}</div>` : ''}${evidenceHTML}<p class="record-id">${payload.author ? `Authored by ${escapeHTML(payload.author)} · ` : ''}Immutable record ${escapeHTML(event.id || 'ID unavailable')}</p></details></article>`;
}

function renderRecords(state) {
  const events = getEvents(state);
  const contributions = events.filter((event) => ['research', 'challenge', 'decision', 'revision'].includes(event.kind));
  const decisions = contributions.filter((event) => event.kind === 'decision');
  $('#decision-count').textContent = decisions.length;
  $('#contribution-total').textContent = `${contributions.length} recorded contribution${contributions.length === 1 ? '' : 's'}${state.history_truncated ? ' · recent window only; export for full history' : ''}`;
  const filter = $('#decision-filter').value;
  const filtered = contributions.filter((event) => filter === 'all' || event.kind === filter);
  $('#decision-list').innerHTML = filtered.length ? filtered.map((event) => recordCard(event)).join('') : emptyState('No contributions', 'No records in this view.');
  const journal = contributions.filter(event => ['decision', 'revision'].includes(event.kind));
  $('#journal-list').innerHTML = journal.length ? journal.map((event) => recordCard(event, true)).join('') : emptyState('No decisions yet', 'Awaiting manager review.');
  if (!$('#replay-date').value || $('#replay-date').value === 'all') {
    $('#replay-list').innerHTML = events.length ? events.map(event => recordCard(event)).join('') : emptyState('No history yet', '');
    $('#replay-status').textContent = state.history_truncated ? 'Recent records · Download the full audit log in Operations.' : 'Present record';
  }
  const latest = decisions[0];
  $('#latest-decision').innerHTML = latest ? `<div class="latest-content"><div class="eyebrow">Manager proposal · ${escapeHTML(latest.payload.action || 'Decision')}</div><h3>${escapeHTML(latest.payload.title || 'A recorded decision')}</h3><p>${escapeHTML(latest.payload.summary || latest.payload.thesis || '')}</p><p class="latest-meta">Recorded ${escapeHTML(formatTime(latest.created_at, true))}</p></div>` : `<div class="latest-content"><h3>No manager action yet</h3></div>`;
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
  if (Array.isArray(health.verification)) health.verification.forEach((item) => {
    const outcome = item.outcome ?? item.status ?? 'Not recorded';
    const detail = [`Check: ${item.check || 'Not recorded'}`, `Revision: ${item.revision || item.release_revision || item.commit_sha || 'Not recorded'}`, item.summary].filter(Boolean).join(' · ');
    rows.push(healthItem(item.title || 'Recorded verification', asText(outcome), detail, outcome === 'passed' ? 'ok' : outcome === 'failed' ? 'warning' : ''));
  });
  if (Array.isArray(health.blockers)) [...new Set(health.blockers)].forEach((item, index) => rows.push(healthItem(`Readiness blocker ${index + 1}`, 'Unresolved', asText(item), 'warning')));
  $('#health-list').innerHTML = rows.join('');
}

function renderMandate(mandate) {
  const universe = approvedUniverse(mandate);
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
