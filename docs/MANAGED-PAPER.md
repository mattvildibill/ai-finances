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
