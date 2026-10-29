# Dashboard display and saved accounting

## Observed discrepancy

Native portfolio_state read at 2026-10-29 02:06:27.371 UTC retained snapshot `d74ba342-921e-48a5-b4f8-75b8c461b7f2`, digest `2ac6cfab0174db6405b3d6e03e2ad83b323e742824b877a6e11c4818e6df371f`, retrieved 01:56:56.277 UTC. The sanitized test fixture is an extract of this saved observation, not a fresh broker response or manufactured raw receipt.

The snapshot itself reports broker equity $99,783.48 and cash $43,546.18. Its analytical ledger value is $100,053.335, including the evidenced $0.01 CAT expense. Both have SPY32, SOFI701, TOST250 and JPM35. The difference is valuation marks, not an unexplained cash/quantity change:

| Asset | Broker position value | Analytical IEX value | IEX trade time, Oct28 UTC |
|---|---:|---:|---|
| SPY | 24,612.48 | 24,633.60 | 20:54:40 |
| SOFI | 11,790.82 | 12,008.13 | 19:59:59 |
| TOST | 7,832.50 | 7,986.25 | 19:59:56 |
| JPM | 12,001.50 | 11,879.175 | 19:59:52 |

The user screenshot reports $99,795.29 around02:00UTC, a different observation time. It cannot prove a same-time API/dashboard discrepancy. Alpaca's [positions documentation](https://docs.alpaca.markets/us/docs/working-with-positions) describes session-dependent prices, including after-hours marks and an overnight official-close regime. It does not provide individual mark timestamps in these saved positions. We do not claim a broker feed, a consolidated live entitlement, or exact synchronization with its website. Its [market-data documentation](https://docs.alpaca.markets/us/docs/about-market-data-api) limits free Basic real-time equities data to IEX. Existing IEX retrievals work; no paid feed was tested or added.

## Cost and isolation

Before this change the browser read /api/state once. Manual Refresh POSTed /api/refresh: read full accounting history, acquired the execution fence, fetched account/clock/positions/open orders/IEX trades/asset metadata, appended a snapshot, then fetched paginated fills/account/positions/orders and appended reconciliation evidence. This is deterministic code, not an AI call, but repeated full acquisition adds broker traffic, journal rows and replay work. It is unchanged for the authorized research workflow and is never called by automatic page refresh.

New authenticated GET /api/display accepts no parameters. It fetches only three fixed paper endpoints: account, positions, clock. A dedicated mutable singleton display_cache row shares throttling across Worker instances and tabs: at least30seconds after successful regular-session fetch,120seconds outside regular hours. Concurrent callers cannot duplicate a fetch; a60second claim expires after a crash; token fencing rejects a superseded result. Failures retain the old retrieval time and back off120seconds. No upstream errors, account identifiers, credentials or margin buying-power fields are returned.

A visible Portfolio tab polls after completion, not on a concurrent interval. Hidden tabs and other views stop scheduling; the one already-issued bounded request may finish. Browser errors back off up to5minutes. Manual Refresh rereads saved state once and requests the same cached display; System details has Reload saved records. Automatic price refresh never rereads the complete journal. Saved reviews/controls are dated historical state, not freshly polled authority.

Maximum ordinary broker traffic is6 GETs/minute during a regular session or1.5 GETs/minute outside it, shared across browsers. A cached response needs one D1 row read. Each fetch claim/result uses two small D1 writes plus reads; initialization creates one row. There is no append-only history growth from polling, no AI/model/agent invocation, no new schedule, subscription or paid API. Hosting/database usage still exists; this is not a claim of zero platform cost. Native request timeouts remain15seconds; UI request timeout20seconds. Failed updates never authorize trades.

The new cache is display-only: no accounting, reconciliation, replay, benchmark, execution or guard imports it. Migration0004 creates only this table. Existing immutable journal, ledger and locks are unchanged. A missing migration fails the display endpoint; the frontend keeps explicitly labeled saved values.

## Presentation

Headline, cash, change against original capital and holdings use the same broker account response group, labeled with retrieval time. Account and positions are separate GETs, not an atomic market tick. Current holdings show broker remaining-share cost basis, not a rewritten analytical basis or lifetime spend. Price may be derived from position value/quantity when a position price is absent; no timestamp is invented. No broker response becomes an immutable historical point. A stale display says last broker value; errors retain the timestamp.

The main history chart remains the original saved analytical IEX series with observed dots, dollar axes and the original $100,000 reference. No points, inception, fees, SPY start or interpolation are manufactured. SPY is opt-in, described as starting money invested in SPY. Fees remain visible, including the absence of an inferred hypothetical benchmark fee. Saved risk metrics are labeled separately.

Decisions show actual proposals/hold decisions/linked fill outcomes with concise summaries and dates. Reasons, risks, next checkpoint and named links are separate from optional original technical records. Research is a distinct tab; Past reviews uses the existing knowledge-time cutoff. System details retains controls/status/audit material. Whitespace presentation repairs and excerpts do not mutate originals. No AI rewrites run in the browser.

## Validation and publication

Run npm test and npm run build. Display tests exercise fixed GET scope, private route authorization, no caller URLs, cross-request coalescing, cache fencing, retry behavior, malformed broker data, no event/lock writes, visibility/backoff and actual observed broker-versus-IEX values. Rendering tests retain original arbitrary payloads and verify opt-in comparator/empty history behavior.

At Oct29 ~02UTC, four pre-existing session tests fail with 'Explicit later-session authorization and expired predecessor required' in next-session.test.js and ongoing-security.test.js. The same four fail on untouched0e32552 in a separate checkout. Their next-day New York dates and UTC-midnight predecessor test depend on current time. No trading policy or guard is changed to make them pass. Report this baseline limit instead of claiming an all-green suite.

Local Chromium reviewed five tabs at1440×1000 and390×844 using saved actual state and an isolated broker-display extract: no page errors, no page-width overflow, only /api/state and /api/display requests. These are local UI checks, not hosted/runtime validation. Parent owns canonical Sites packaging, migration application, private publication and fresh endpoint readback. No deployment or release approval is performed here.
