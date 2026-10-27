'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (value, digits = 2) => Number.isFinite(Number(value)) && value !== null && value !== undefined ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value)) : '—';
const number = (value, digits = 2) => Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const percent = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${number(Number(value) * 100, 2)}%`;
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
  if (updateHash) history.replaceState(null, '', `#${view}`);
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
  const started = Boolean(experiment.started_at);
  const paused = experiment.status !== 'active' && experiment.status !== 'running';
  const value = portfolio.value ?? portfolio.equity;
  const cash = portfolio.cash;
  $('#portfolio-value').textContent = money(value);
  $('#cash-value').textContent = money(cash);
  $('#capital-state').textContent = started ? (paused ? 'PAUSED' : 'PAPER PORTFOLIO') : 'PRE-LAUNCH';
  $('#capital-title').firstChild.textContent = started ? 'PORTFOLIO VALUE ' : 'EXPERIMENT CAPITAL ';
  $('#capital-context').textContent = started ? `Since ${formatTime(experiment.started_at, true)}` : 'Allocated starting cash · Official experiment not started';
  $('#return-value').textContent = started ? percent(portfolio.total_return) : 'Not started';
  $('#return-value').style.fontSize = started ? '' : '27px';
  $('#return-detail').textContent = started ? `${money(portfolio.gain ?? portfolio.total_gain)} since inception · ${portfolio.performance_basis || 'Performance basis unavailable'}` : 'Performance starts at inception.';
  $('#relative-return').textContent = started && state.benchmark?.excess_return !== undefined ? percent(state.benchmark.excess_return) : state.benchmark?.status === 'not_started' || !started ? 'Not started' : 'Not available';
  const cashRatio = Number(value) > 0 && cash !== undefined ? Number(cash) / Number(value) : null;
  $('#cash-percent').textContent = cashRatio === null ? 'Waiting for accounting state' : `${percent(cashRatio)} of portfolio`;
  $('#cash-track').style.width = `${cashRatio === null ? 0 : Math.min(100, Math.max(0, cashRatio * 100))}%`;
  $('#pause-banner').hidden = !paused;
  $('#pause-detail').textContent = experiment.pause_reason || (started ? 'New trading is paused. Existing records remain available for inspection.' : 'Capital is reserved. Trading begins only after the operating workflow is verified.');
  $('#operations-status').textContent = paused ? 'Paused' : 'Active · paper only';
  renderMarket(state);
  renderHoldings(portfolio, started);
  renderChart(state, started);
  renderRisk(state, started);
  renderRecords(state);
  renderHealth(state);
  renderMandate(state.mandate || {});
  $('#loading').hidden = true;
  $('#app-content').hidden = false;
}

function renderMarket(state) {
  const snapshot = latestSnapshot(state);
  const payload = snapshot?.payload || {};
  const quotes = payload.quotes || payload.trades || payload.market?.quotes || {};
  const clock = payload.clock || {};
  const retrieved = payload.retrieved_at || snapshot?.created_at || payload.retrieval_time;
  const names = { AAPL: 'Apple Inc.', MSFT: 'Microsoft', SPY: 'S&P 500 ETF' };
  $('#market-quotes').innerHTML = ['AAPL', 'MSFT', 'SPY'].map((symbol) => {
    const raw = Array.isArray(quotes) ? quotes.find((entry) => entry.symbol === symbol) : quotes[symbol];
    const quote = raw?.latestTrade || raw?.trade || raw || {};
    const price = quote.price ?? quote.p;
    const timestamp = quote.market_data_at || quote.timestamp || quote.t;
    return `<div class="quote-row"><div class="quote-symbol"><span class="ticker-icon ${symbol === 'SPY' ? 'spy' : ''}" aria-hidden="true">${symbol === 'SPY' ? 'S' : symbol === 'AAPL' ? 'A' : 'M'}</span><div class="ticker-name"><strong>${symbol}</strong><span>${names[symbol]}</span></div></div><div class="quote-price"><strong>${money(price, 3).replace(/0$/, '')}</strong><time ${timestamp ? `datetime="${escapeHTML(timestamp)}"` : ''}>${timestamp ? escapeHTML(formatTime(timestamp, true)) : 'No verified price'}</time></div></div>`;
  }).join('');
  $('#retrieval-time').textContent = retrieved ? formatTime(retrieved, true) : 'No successful retrieval';
  $('#session-badge').textContent = typeof clock.is_open === 'boolean' ? clock.is_open ? 'Market open' : 'Market closed' : 'Unverified';
  $('#session-time').textContent = typeof clock.is_open === 'boolean' ? clock.is_open ? `Closes ${formatTime(clock.next_close, true)}` : `Next open ${formatTime(clock.next_open, true)}` : 'Not yet verified';
}

function renderHoldings(portfolio, started) {
  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  $('#holdings-count').textContent = portfolio.holdings_status === 'unknown' ? 'Holdings unavailable' : `${holdings.length} position${holdings.length === 1 ? '' : 's'}`;
  $('#holdings-body').innerHTML = holdings.map((holding) => {
    const marketValue = holding.market_value ?? holding.value;
    const gain = holding.unrealized_pl ?? holding.unrealized_gain;
    const weight = holding.weight ?? (Number(portfolio.value) > 0 ? Number(marketValue) / Number(portfolio.value) : null);
    return `<tr><td><strong>${escapeHTML(holding.symbol)}</strong></td><td>${number(holding.qty ?? holding.quantity, 8)}</td><td>${money(holding.cost_basis)}</td><td>${money(marketValue)}</td><td class="${Number(gain) < 0 ? 'negative' : Number(gain) > 0 ? 'positive' : ''}">${money(gain)}</td><td>${percent(weight)}</td></tr>`;
  }).join('');
  $('#holdings-empty').hidden = holdings.length > 0;
  $('#holdings-empty p').textContent = portfolio.holdings_status === 'unknown' ? 'Accounting is blocked; holdings are unavailable pending reconciliation.' : started ? 'The portfolio currently holds cash. Holding cash is a valid investment decision.' : 'No holdings in the official experiment. Nothing is being invested while it is paused.';
}

function renderChart(state, started) {
  const history = (state.performance || state.history || []).filter((entry) => entry.value !== null && entry.value !== undefined && Number.isFinite(Number(entry.value)) && Number.isFinite(new Date(entry.at || entry.created_at).getTime()));
  if (!started || history.length < 2) {
    $('#performance-chart').innerHTML = `<div class="chart-empty-grid" aria-hidden="true"></div><div class="chart-empty"><span aria-hidden="true">${started ? '↗' : 'Ⅱ'}</span><strong>${started ? 'Waiting for a second observation' : 'The first chapter is still unwritten.'}</strong><p>${started ? 'A line appears only when there are recorded valuations to connect.' : 'A performance line will appear here after the experiment officially begins.'}</p></div>`;
    $('#chart-note').textContent = started ? 'Only real recorded valuations are plotted. No synthetic history or backfilled trades.' : 'No performance history yet. A baseline is recorded when the official experiment starts.';
    return;
  }
  history.sort((a, b) => new Date(a.at || a.created_at) - new Date(b.at || b.created_at));
  const values = history.flatMap((point) => [Number(point.value), ...(Number.isFinite(Number(point.benchmark_value)) && point.benchmark_value !== null && point.benchmark_value !== undefined ? [Number(point.benchmark_value)] : [])]);
  const low = Math.min(...values), high = Math.max(...values), spread = Math.max(high - low, high * .005, 1);
  const width = 620, height = 170, minTime = new Date(history[0].at || history[0].created_at).getTime(), maxTime = new Date(history[history.length - 1].at || history[history.length - 1].created_at).getTime();
  const point = (item, key) => `${20 + ((new Date(item.at || item.created_at).getTime() - minTime) / Math.max(maxTime - minTime, 1)) * (width - 40)},${height - 15 - ((Number(item[key]) - low) / spread) * (height - 35)}`;
  const blue = history.map((item) => point(item, 'value')).join(' ');
  const spy = history.filter((item) => item.benchmark_value !== null && item.benchmark_value !== undefined && Number.isFinite(Number(item.benchmark_value))).map((item) => point(item, 'benchmark_value')).join(' ');
  $('#performance-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height + 20}" role="img" aria-label="Recorded portfolio value over time; latest ${escapeHTML(money(history[history.length - 1].value))}"><path d="M20 30H600M20 75H600M20 120H600M20 165H600" stroke="#e6e8de" fill="none"/>${spy ? `<polyline points="${spy}" fill="none" stroke="#9aa88a" stroke-width="2"/>` : ''}<polyline points="${blue}" fill="none" stroke="#164dff" stroke-width="2.5" stroke-linejoin="round"/></svg><div class="chart-labels"><span>${escapeHTML(formatTime(history[0].at || history[0].created_at, true))}</span><span>${escapeHTML(formatTime(history[history.length - 1].at || history[history.length - 1].created_at, true))}</span></div>`;
  $('#chart-note').textContent = 'Observed valuations only. Read Operations for distribution, cost, and corporate-action treatment.';
}

function renderRisk(state, started) {
  const risk = state.risk || state.portfolio?.risk || {};
  const positions = state.portfolio?.holdings || [];
  const weights = positions.map((entry) => entry.weight ?? (Number(state.portfolio?.value) > 0 ? Number(entry.market_value ?? entry.value) / Number(state.portfolio.value) : null)).filter((value) => value !== null && Number.isFinite(value));
  const concentration = weights.length ? Math.max(...weights) : positions.length === 0 ? 0 : null;
  const items = [
    { label: 'Largest position', value: percent(risk.largest_position), note: state.portfolio?.holdings_status === 'unknown' ? 'Accounting unavailable' : positions.length ? 'Share of portfolio value' : 'No invested exposure' },
    { label: 'Max. drawdown', value: started ? percent(risk.max_drawdown) : '—', note: started ? 'Peak-to-trough decline' : 'Requires active history' },
    { label: 'Annualized volatility', value: started ? percent(risk.annualized_volatility) : '—', note: 'Requires sufficient daily returns' },
  ];
  $('#risk-grid').innerHTML = items.map((item) => `<div class="risk-metric"><span>${item.label}</span><strong>${item.value}</strong><small>${item.note}</small></div>`).join('');
}

function roleName(event) {
  return ({ researcher: 'Researcher', challenger: 'Independent challenger', portfolio_manager: 'Portfolio manager' }[event.payload.role]) || ({ research: 'Researcher', challenge: 'Independent challenger', decision: 'Portfolio manager', revision: 'Revision', system: 'System record', snapshot: 'Market observation' }[event.kind] || event.payload.role || event.kind || 'Record');
}

function recordCard(event, journal = false) {
  const payload = event.payload || {};
  if (event.kind === 'snapshot') {
    return `<article class="record-card"><div class="record-topline"><span class="role-tag">Market observation · Alpaca IEX</span><time>Recorded ${escapeHTML(formatTime(event.created_at))}</time></div><h2>The market, as observed.</h2><div class="record-summary">Retrieved ${escapeHTML(formatTime(payload.retrieved_at))}. ${payload.clock?.is_open === true ? 'The regular trading session was open.' : payload.clock?.is_open === false ? 'The regular trading session was closed.' : 'Session status was unverified.'}</div><div class="record-facts">${Object.entries(payload.quotes || {}).map(([symbol, quote]) => `<dl><dt>${escapeHTML(symbol)} · IEX last trade</dt><dd>${money(quote.price, 3)}<br>Market time: ${escapeHTML(formatTime(quote.market_data_at))}</dd></dl>`).join('')}</div><p class="record-id">Immutable snapshot ${escapeHTML(event.id)}</p></article>`;
  }
  const facts = journal ? [ ['Original thesis', payload.thesis], ['Expected horizon', payload.horizon], ['Uncertainties', payload.uncertainties], ['What would change our mind', payload.change_mind || payload.invalidation_conditions] ] : [ ['Action', payload.action], ['Position size · USD notional', payload.size === undefined ? payload.position_size : money(payload.size)], ['Expected horizon', payload.horizon], ['Independent counterargument', payload.counterargument], ['Response to the challenge', payload.challenge_response], ['Revision of', payload.supersedes || payload.revises || payload.revision_of], ['Research record', payload.research_id], ['Challenge record', payload.challenge_id], ['Uncertainties', payload.uncertainties], ['Source snapshots', payload.snapshot_ids] ];
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const evidenceHTML = evidence.length ? `<details class="evidence"><summary>${evidence.length} evidence source${evidence.length === 1 ? '' : 's'} · inspect provenance</summary><ul>${evidence.map((source) => {
    const url = safeURL(source.url);
    const label = source.title || source.url || 'Recorded source';
    return `<li>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} ↗</a>` : escapeHTML(label)}<time>Observed: ${escapeHTML(formatTime(source.observed_at || source.retrieved_at))}</time>${source.published_at ? `<time>Published: ${escapeHTML(formatTime(source.published_at))}</time>` : ''}${source.excerpt ? `<p>${escapeHTML(source.excerpt)}</p>` : ''}</li>`;
  }).join('')}</ul></details>` : '';
  const kind = ['research', 'challenge', 'decision'].includes(event.kind) ? event.kind : '';
  return `<article class="record-card"><div class="record-topline"><span class="role-tag ${kind}">${escapeHTML(roleName(event))}</span><time datetime="${escapeHTML(event.created_at || event.recorded_at)}">Recorded ${escapeHTML(formatTime(event.created_at || event.recorded_at))}</time></div><h2>${escapeHTML(payload.title || (payload.action === 'hold' ? 'A decision to hold.' : payload.summary?.slice(0, 85) || 'Recorded contribution'))}</h2><div class="record-summary">${escapeHTML(payload.summary || payload.thesis || payload.message || 'No summary supplied.')}</div>${facts.some(([, value]) => value !== undefined && value !== null && value !== '') ? `<div class="record-facts">${facts.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => `<dl><dt>${label}</dt><dd>${escapeHTML(asText(value))}</dd></dl>`).join('')}</div>` : ''}${evidenceHTML}<p class="record-id">${payload.author ? `Authored by ${escapeHTML(payload.author)} · ` : ''}Immutable record ${escapeHTML(event.id || 'ID unavailable')}</p></article>`;
}

function renderRecords(state) {
  const events = getEvents(state);
  const contributions = events.filter((event) => ['research', 'challenge', 'decision', 'revision'].includes(event.kind));
  const decisions = contributions.filter((event) => event.kind === 'decision');
  $('#decision-count').textContent = decisions.length;
  $('#contribution-total').textContent = `${contributions.length} recorded contribution${contributions.length === 1 ? '' : 's'}${state.history_truncated ? ' · recent window only; export for full history' : ''}`;
  const filter = $('#decision-filter').value;
  const filtered = contributions.filter((event) => filter === 'all' || event.kind === filter);
  $('#decision-list').innerHTML = filtered.length ? filtered.map((event) => recordCard(event)).join('') : emptyState(filter === 'all' ? 'Good decisions leave a trail.' : 'No contributions in this view.', filter === 'all' ? 'The first research brief, independent challenge, and final decision will appear here as they are submitted. No conversations have been invented.' : 'Try another contribution type, or return after the next review.', '↗');
  $('#journal-list').innerHTML = decisions.length ? decisions.map((event) => recordCard(event, true)).join('') : emptyState('A blank page, by design.', 'No investment thesis has been approved. The journal will preserve each original thesis, uncertainty, time horizon, and invalidation condition as decisions arrive.', 'Ⅰ');
  const latest = decisions[0];
  $('#latest-decision').innerHTML = latest ? `<div class="latest-content"><div class="eyebrow">${escapeHTML(latest.payload.action || 'RECORDED DECISION')}</div><h3>${escapeHTML(latest.payload.title || 'A recorded decision')}</h3><p>${escapeHTML(latest.payload.summary || latest.payload.thesis || '')}</p><p class="latest-meta">Recorded ${escapeHTML(formatTime(latest.created_at, true))}</p></div>` : `<div class="latest-content"><div class="eyebrow">AWAITING FIRST REVIEW</div><h3>We’re starting with a question.<br>Not a trade.</h3><p>No investment decision has been submitted. Research and independent challenges will be preserved before capital is put to work.</p></div>`;
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

function renderHealth(state) {
  const health = state.health || {};
  const snapshot = latestSnapshot(state);
  const account = snapshot?.payload?.account;
  const review = health.last_successful_review || health.last_review_at;
  const automation = health.automation || health.automation_status || health.scheduler;
  const rows = [
    healthItem('Paper reconciliation', state.last_reconciliation ? healthValue(state.last_reconciliation.payload?.status) : 'Not run', state.last_reconciliation ? `Last receipt ${formatTime(state.last_reconciliation.created_at)}. ${state.last_reconciliation.payload?.scope || 'Inspect the audit export for exact broker receipts.'}` : 'GET-only reconciliation never submits an order.'),
    healthItem('Official experiment', state.experiment?.status || 'Unverified', state.experiment?.started_at ? `Started ${formatTime(state.experiment.started_at)}` : 'No inception timestamp; no official performance history.', 'warning'),
    healthItem('Alpaca paper connection', healthValue(health.alpaca ?? health.alpaca_status ?? health.source_status ?? (account?.status === 'ACTIVE' ? 'Authenticated' : null)), 'Server-side paper endpoint only.', health.source_status === 'connected' ? 'ok' : ''),
    healthItem('Market data', snapshot ? 'Snapshot available' : 'No verified snapshot', snapshot ? `Last retrieval ${formatTime(snapshot.payload.retrieved_at || snapshot.created_at)}` : 'Alpaca IEX, with source timestamps.'),
    healthItem('Persistent records', healthValue(health.persistence ?? health.database), health.persistence_detail || 'Append-only decisions and source evidence.'),
    healthItem('Blue connection', healthValue(health.blue_connection ?? health.mcp), 'Authenticated Site tools; no separate AI API billing.'),
    healthItem('Unattended updates', healthValue(automation, 'Not verified'), health.schedule || health.automation_detail || 'A saved schedule alone does not prove a successful run.'),
    healthItem('Last successful review', review ? formatTime(review) : 'No completed review', 'Research, independent challenge, and final decision.'),
    healthItem('Execution readiness', healthValue(health.execution ?? health.execution_status ?? health.trading, 'Locked while paused'), health.data_fresh === true ? 'The latest observation passed the freshness check. Experiment pause still blocks trades.' : 'Data has not passed current execution freshness checks. Trading stays blocked.', 'warning'),
  ];
  if (health.last_error) rows.push(healthItem('Last update error', 'Needs attention', asText(health.last_error), 'warning'));
  else if (health.last_failure) rows.push(healthItem('Last failed update', formatTime(health.last_failure), 'See the immutable timeline for the recorded failure.', 'warning'));
  if (state.account_drift) rows.push(healthItem('External account activity', 'Reconciliation required', 'Broker holdings or cash differ from the original allocation. Official experiment accounting has not silently adopted those changes.', 'warning'));
  if (Array.isArray(health.verification)) health.verification.forEach((item) => rows.push(healthItem(item.title || 'Recorded verification', item.status || 'See recorded result', item.summary || '', item.status === 'passed' ? 'ok' : '')));
  if (Array.isArray(health.blockers)) health.blockers.forEach((item, index) => rows.push(healthItem(`Readiness blocker ${index + 1}`, 'Unresolved', asText(item), 'warning')));
  $('#health-list').innerHTML = rows.join('');
}

function renderMandate(mandate) {
  const single = mandate.max_position_weight ?? mandate.max_single_position ?? mandate.stock_limit;
  const etf = mandate.max_etf_weight ?? mandate.etf_limit;
  const cashFloor = mandate.min_cash_weight ?? mandate.cash_reserve ?? mandate.min_cash;
  const items = [
    ['Starting capital', '$100,000', 'Imaginary USD. No deposits, withdrawals, leverage, shorts, or options.'],
    ['Eligible universe', Array.isArray(mandate.universe) ? mandate.universe.join(' · ') : 'US stocks + ETFs', 'Long-only approved universe. Any expansion requires a recorded mandate revision.'],
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
    if (loaded) showMessage(result.message || 'Market refresh completed and the persistent state was read back. The official experiment remains paused.');
  } catch (error) { showMessage(`${error.message} The previous state is retained; a failed update does not authorize a trade.`, true); }
  finally { button.disabled = false; button.innerHTML = '<span aria-hidden="true">↻</span> Refresh data'; }
});

$('#replay-button').addEventListener('click', async () => {
  const value = $('#replay-date').value;
  if (!value || !Number.isFinite(new Date(value).getTime())) { $('#replay-status').textContent = 'Choose a valid date and time first.'; return; }
  const date = new Date(value);
  if (date > new Date()) { $('#replay-status').textContent = 'Choose a time in the past. Future information is not available.'; return; }
  const button = $('#replay-button');
  button.disabled = true;
  $('#replay-status').textContent = 'Loading the historical record…';
  try {
    const replay = await request(`/api/state?as_of=${encodeURIComponent(date.toISOString())}`);
    const events = getEvents(replay).filter((event) => new Date(event.created_at || event.recorded_at) <= date);
    $('#replay-status').textContent = `${events.length} record${events.length === 1 ? '' : 's'} available as of ${formatTime(date.toISOString())}. This is a receipt-time view, not a reconstructed conversation.`;
    $('#replay-list').innerHTML = events.length ? events.map((event) => recordCard(event)).join('') : emptyState('Before the record began.', 'No information had been recorded by the chosen moment. Information received later has been excluded.', '↶');
  } catch (error) { $('#replay-status').textContent = error.message; $('#replay-list').innerHTML = ''; }
  finally { button.disabled = false; }
});
$('#replay-reset').addEventListener('click', () => {
  $('#replay-date').value = '';
  $('#replay-status').textContent = 'Showing the present record. Choose a past moment to restrict available information.';
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
