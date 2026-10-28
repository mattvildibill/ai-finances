# Managed paper portfolio

This prospective mode implements Matt's October 27 authorization (`Sentinel_b8a876d72e5c8191839b02795b30ec8b`). It is not activated by publishing code or this document.

The experiment keeps its original $100,000 inception, existing holdings, benchmark and every recorded result. Authority ends 180 days after that original inception. There is no fixed position percentage, order percentage, minimum cash balance or lifetime purchase ceiling. Concentration is a manager judgment that must be explained, including correlated exposure and the consequence of being wrong. Gains are not guaranteed.

Only cash-funded, whole-share paper purchases and sales of owned shares are supported. No borrowing, shorts, options, leveraged/inverse funds, private-market access or extended-hours orders. Regular-session day limits can remain unfilled. Initial capital is not a turnover budget: genuinely reconciled sale proceeds can be reinvested.

## Standing authority and release review

The owner-authenticated `managed_portfolio` tool exposes `transition`, `control`, `approve_release`, instrument and action evidence operations, `status`, and `execute`. Existing launch paths retain their historical limits; after transition they cannot create competing new intents. Existing uncertain intents remain recoverable through GET-only reads.

`transition` takes `idempotency_key` and `payload` containing `protocol_version:1`, `status:"approved"`, `authorization_reference`, exact `revision`, manager `author`, the exact `MANAGED_RULES` object returned by status, and `checks`. Checks map `managed_code_review`, `managed_accounting_review` and `managed_security_review` to actual independent passed verification IDs for that revision. Later pending/failed evidence blocks execution. The server binds the original inception and its digest, fixed end date and previous launch approval. A fresh successful account reconciliation is needed; an open market is not. No order is placed.

`MANAGED_ENABLED=true` is a separate deployment setting. `control` records a manager's pause/resume with `mandate_id`, `status`, `author` and `reason`. A changed executable release requires `approve_release` with the mandate, exact new revision, predecessor release ID, actual independent checks, author and approved status. This neither resets the portfolio nor extends authority. There is no daily mandate renewal.

## Instruments and decisions

`inspect_instrument` obtains real metadata from the fixed paper broker endpoint. An `instrument_candidate` binds that receipt, ordinary-US-stock or unleveraged/noninverse-fund classification, actual primary source URL/hash/observation/excerpt, research and an independent instrument challenge. `approve_instrument` records manager approval of that exact binding and mandate. Unknown, inactive, untradable, changed or revoked instruments remain unavailable. Ordinary new tickers do not require a code release. Fund tracking tools are disclosed; a fund must not be mislabeled as holding no derivatives merely because it does not seek leveraged returns.

Material decisions use actual researcher, independent challenger and manager records. A managed buy/sell decision names `managed_mandate_id`, current `instrument_approval_id`, symbol, whole `quantity`, `limit_price_cents`, dollar `size`, explicit `valid_until`, research/challenge IDs and snapshot IDs. It explains `why_asset`, `why_now`, `why_size`, `correlated_exposure`, `downside_case` and `challenge_response`. A fee reserve may be specified in integer cents. Unchanged theses can be reused; the final order observation is obtained after deliberation.

## Cash, execution and recovery

Before a new order, the engine reconciles actual receipts, then obtains fresh account, holdings, open orders, asset identity, clock and IEX marks for held/proposed instruments plus SPY. Data must meet the existing 120-second/future-time and actual regular-session boundaries. Buying power is never cash. Modeled distributions are never spendable broker cash. All unresolved/open commitments block another submission, rather than allowing overlapping reservations.

A buy reserves quantity times its limit plus the explicit fee reserve against exact broker-matching ledger cash. A sale cannot exceed owned inventory. Cash availability follows **the paper account's actual cash and matching fill receipts**, not an invented settlement credit or a claim of real-world T+1 settled-funds eligibility. The simulator's stated zero modeled commission is not a promise of zero actual charges: unexplained fees/cash differences block reconciliation. Sale gains/losses and weighted-average basis are computed with the same exact nano-dollar ledger used for buys; raw broker decimals remain preserved. Unsupported precision remains blocked.

Every decision has one durable intent and stable broker client ID. Lease, journal-head, database-clock deadline, current review and final fresh-observation checks fence submission. Ambiguous outcomes and retries use that same ID with GET-only recovery, even after pause, expiry or release changes. No price chasing, replacement order or second ID is automatic.

## Corporate actions and history

Managed action acquisition is scoped to held/proposed instruments and SPY. It retains actual all-category broker pages and primary source evidence. Shared economic definitions are reused, not duplicated across mandate versions. Ordinary cash distributions and supported whole-share splits use the same active/comparator ledger; unknown actions, contradictions and unsupported cash-in-lieu remain blocking.

A complete current-New-York-day broker acquisition is required. An independent substantive source review can be reused for unchanged bound inventory until its explicit expiry (at most 30 days); new material evidence requires review. This is bounded observed coverage, not a guarantee that all unknown actions are absent. Entitlements remain tied to historical eligible holdings even after sale. Neither later payment dates nor a new mandate manufacture pre-inception income.

Historical valuations use the evidence available at each recorded cutoff. The visible chart shows observed values, not invented continuous prices or official closes. Last verified value stays distinct from current ledger facts when new valuation is unavailable. Raw sources, timestamps and audit details remain accessible without dominating the dashboard.

## Verification limits

Isolated tests cover large/full-cash purchases, cash shortfalls, owned sales, partial/duplicate fills, reinvestment beyond initial capital, ambiguous recovery, adverse evidence and concurrency fences. Those tests do not establish live admission, actual managed-mode fills or unattended operation. Production transition and trading require the parent's separate reviewed runtime actions. Private access, original data, original benchmark and all old failures remain preserved.

## Separate broker cost-basis projection

Blue retains its original analytical weighted-average cost and realized gain/loss. Alpaca's displayed position basis can legitimately differ: [Alpaca's basis documentation](https://docs.alpaca.markets/us/docs/position-average-entry-price-calculation) describes intraday weighted average and end-of-day compressed FIFO. [Its daily-process schedule](https://docs.alpaca.markets/us/docs/daily-processes-and-reconcilations) places beginning-of-day synchronization at 02:15–02:30 New York time, following daylight saving time.

The independent `alpaca-daily-compressed-fifo-v1` projection uses only received fill timestamps and verified split receipts. Prior trading-day purchases are compressed into daily lots; sales consume those lots FIFO when the day is compressed. The still-intraday portion uses weighted average. During the documented BOD window either the immediately preceding day's uncompressed or compressed state may match, but **one whole-portfolio state** must match all holdings. Older days cannot retain arbitrary average-cost alternatives. Outside that window only the corresponding derived state is accepted. Processing delays outside the documented window remain discrepancies requiring evidence; the system never adopts an arbitrary broker number.

Example: buy two shares at $100 on day1, two at $200 on day2, sell one at $150 on day3. Analytical remaining basis stays $450 and realized P/L stays $0. After day3 compression, broker-projected remaining basis is $500 and broker-method realized P/L is $50. Cash, share count, total NAV and total gain are identical. The changed allocation between realized and unrealized P/L is not a new gain or cash adjustment. Historical snapshots use their own knowledge/observation cutoff and BOD phase.

Projection costs use exact rational nano-dollars. Exact nano-dollar results must match exactly. Repeating rational results may use the explicitly named application policy `derived-basis-display-half-up-v1`: round the derived display half-up to the reported precision, with a minimum of two and maximum of nine decimal places. This is **not** a claim that Alpaca documents that rounding convention. An integer string never grants whole-dollar tolerance. Raw broker basis, exact rational expected basis, displayed comparison and matched phase are retained in reconciliation evidence. This bounded display normalization never changes cash, fills, analytical basis or NAV; unsupported precision and unexplained differences still block.

Supported whole-account splits preserve total cost and scale daily-lot quantities, including rational internal lots when the account total remains whole. Fractional account shares/cash-in-lieu, fees needing unimplemented allocation, and trade corrections remain unsupported rather than being silently absorbed. Tests use isolated synthetic receipts; actual multi-day managed settlement and BOD synchronization have not yet been observed in production.

### Target price observations before a decision

`managed_portfolio` operation `observe_target`, input `{ "idempotency_key": "unique-observation-key", "symbol": "IJR" }`, records a real broker snapshot for an already approved managed instrument together with held assets and SPY. It uses the existing fixed-host GET-only observation and reconciliation path, including its execution lease. It works with managed execution disabled and during market closure; it does not require a buy decision, grant permission, change instrument/action approvals, or place an order. The snapshot retains IEX feed, actual trade/retrieval times, age, asset approval identity, account and holdings. Old prints remain labeled with their actual age, never refreshed synthetically. Use its snapshot ID in research; execution still obtains its own fresh regular-session evidence. A retry returns the original observation, not a newly dated quote; use a new key for a new observation. Keys cannot be reused for a different target or ordinary refresh.

## Read-only account cash activity diagnostics — 28 October 2026

`managed_portfolio` operation `collect_cash_activities` accepts only
`input: {idempotency_key}`. It requires the existing managed mandate, but remains
available with execution disabled, stale quotes, expired trading authority or
failed account reconciliation. This is evidence acquisition, never an order,
fee approval, cash adjustment or successful reconciliation.

The existing runtime credentials are used only through the fixed Alpaca paper
transport: GET `/v2/account/activities`, all activity types, ascending order,
100 rows per page, last returned activity ID as cursor. A server-captured `until`
cutoff is fixed across pages. No caller URL, credentials, filters, dates or account
ID are accepted. All available history through that cutoff is requested, including
pre-inception records, to avoid suppressing an unexplained activity. A short page
completes the broker response scan; this does not prove broker-side completeness
or explain cash. Endpoint/query contract reference: Alpaca's maintained legacy
SDK `get_activities`, https://github.com/alpacahq/alpaca-trade-api-python/blob/master/alpaca_trade_api/rest.py .

Limits: 20 pages, 100 rows/page, 256 KiB/page and 2 MiB total response bytes.
Missing/repeated IDs, invalid pages, HTTP/quota/redirect errors and exceeded bounds
produce incomplete results. No automatic retry bypasses a quota or limit. The
execution lease is renewed and fenced around requests and receipt writes. A lost
lease leaves the started scan incomplete and cannot write with the old token.

Immutable `cash_activity_scan`, `cash_activity_page` and `cash_activity_result`
records retain the request cutoff, URL, retrieval start/observation times and raw
broker JSON (including original economic dates, decimal text and IDs). No source
amount/date is normalized into a ledger entry. Results reference page receipt IDs;
read those pages with existing history export. Identical keys return the original
result, or the original incomplete start after interruption, without refetching.
A distinct deliberately initiated scan needs its own key. A successful later scan
can resolve a transport-only incomplete scan, but cannot erase earlier unknown,
non-fill or contradictory fill evidence.

Every non-fill activity remains an accounting blocker pending a separately
reviewed evidence-backed implementation. Collected fills must exactly match
retained `broker_activity` JSON; missing or changed evidence also blocks.
Receipt-time replay retains the original historical state. Fresh ordinary
reconciliation is still required after any acquisition; a successful scan does
not grant trading permission. Never turn a one-cent discrepancy into a tolerance.

The initial failure under deployed f9af95ac showed $96,160.02 evidenced cash
versus $96,160.01 broker cash with five SPY shares and matching $3,839.98 basis.
This diagnostic implementation does not identify its cause. Actual non-fill
receipts require parent-reviewed publication and a subsequent native scan.
No deployment, enablement, source review attestation or actual fee is implied by
these instructions or synthetic tests.
