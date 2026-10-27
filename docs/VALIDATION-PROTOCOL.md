# One-order supervised paper-validation protocol

This amendment describes a narrowly authorized way to obtain the first authentic paper-fill evidence without inventing historical fills or resetting the dedicated account. It is not certification that validation has passed, permission for general trading, or a record that an order was sent. Implementation, independent exact-release review, deployment verification and actual prerequisite evidence must precede any runtime staging or execution.

Authorization reference: `Sentinel_6fb8b1bcb8708191969bb46e2ae4dfa5`, as supplied in the parent task. The authorization is for this bounded validation scope. An authorization reference alone does not prove any technical check passed.

## Fixed scope

- Same existing private Blue Capital Site, dedicated Alpaca paper account and append-only official journal. No live orders, new account, credentials, paid API, cash reset or external cash movement.
- At most one order: buy exactly one whole share of SPY with a day limit during a fresh open regular session. No extended-hours or market order.
- Conservative commitment must be no more than both $1,000 and 1% of fresh NAV, as well as every existing mandate limit. The explicitly approved limit price and fresh marks remain subject to the existing financial guards. An unmet cap means no order; it does not authorize a different quantity or security.
- One recorded protocol, one bound decision and one durable validation intent for this experiment. Bind authorization, decision, exact source revision and an explicit expiration no more than 24 hours after protocol staging. A revision requires new review; it does not replenish the allowance.
- No second order, replacement, chasing, automatic sale or renewed protocol after an intent has consumed the allowance. Broker rejection, cancellation, no fill, partial fill, timeout and decision expiry do not restore it.

Database uniqueness and the shared execution lease must enforce the single protocol and intent. Request IDs alone are insufficient: changing a request key or decision must not permit another order. The allowance is consumed by durable intent creation before the broker POST, including when a subsequent guard stops submission. An ambiguous outcome permits only observation and reconciliation of the same client order ID, never another POST or a new order ID.

## Separate evidence stages

The ordinary release-verification requirements remain unchanged. This protocol uses a separate validation attestation rather than pretending missing ordinary launch checks passed. Each required evidence record must identify the actual measured outcome, observation time and reviewed release revision.

Before validation staging and use, require evidence for private hosting, persistent write/readback, unattended authenticated access, corporate-action reconciliation and runtime asset eligibility, together with independent exact-release code review, isolated accounting/safeguard tests and the primary corporate-action source scan. Existing production broker access must be demonstrated through authenticated reads. A saved enabled schedule or an access-modification denial is not proof of successful unattended access. A synthetic test is not hosted/broker evidence.

At use time, repeat the existing current-account, eligible-asset, market-session, freshness, reconciliation and reviewed corporate-action coverage checks. The source scan alone does not establish issuer terms or entitlement correctness; current reviewed coverage must pass independently. Unsupported actions or quantities/precision remain blockers. Require independently authored, linked research, challenge and manager decision, an explicit limit and unexpired decision. No authored assertion can override a failed guard.

Actual nonzero fill settlement and actual partial-fill behavior are deliberately **pending**, not prerequisite successes for this single validation attempt. Prospective inception is enforced by the live atomic opening operation rather than a claim that an opening already happened. These narrowly deferred observations do not waive any other prerequisite or authorize general operation.

## Official prospective inception

First obtain authenticated evidence of the dedicated flat $100,000 account with no holdings, orders or prior intents. Establish the official portfolio and analytical SPY comparator atomically at the same prospective inception time, using an actually observed fresh IEX SPY price, whole comparator shares and residual cash. Revalidate the saved clock's session boundaries at inception; a recently observed open session cannot authorize inception after its recorded close.

This is the real official experiment start, not an off-ledger rehearsal. Time spent in cash, an unfilled order, partial fills, any profit or loss and all failures remain in its permanent history. No start-date reset or compensating fictional cash adjustment is permitted. The comparator remains an analytical reference, not a claimed broker fill.

Record the operating scope as bounded validation; do not describe it as unrestricted activation. The ordinary `OPERATING_WORKFLOW_VERIFIED` constant remains false, keeping general execution disabled. A separate validation entry point additionally requires explicit runtime validation enablement and the revision-bound protocol; adding code or staging evidence alone must not enable it. Runtime validation enablement is not set merely to test the implementation.

## Submission expiry and accepted order lifetime

The earlier of decision and protocol expiration limits when a broker POST may begin. Check that expiry, fresh market evidence, session close and all order limits immediately after the final asynchronous lease renewal and immediately before submission.

Expiry does **not** cancel an accepted Alpaca day order. That order can remain open until the broker reports its terminal status, ordinarily at the session's end. Do not claim local intent expiry removed broker exposure. This protocol does not authorize a replacement or a new cancellation mechanism. If a stricter intraday cancellation deadline is required, stop and obtain an explicitly specified, independently reviewed cancellation workflow before submitting an order.

## Observation and completion

Preserve the real broker acknowledgement and every raw activity version. Link supported fill activities to the one durable intent and broker order; account each unique fill exactly once. Require exact cash, quantity, cost-basis and order-status agreement. New validation openings opt into [usd-nano-v1 exact monetary accounting](ACCOUNTING-PRECISION.md). Whole-share fills and modeled distributions retain supported subcent amounts exactly; no cent-rounded fill is invented. Fractional-share outcomes or monetary precision beyond nine nonzero decimal places remain raw evidence and block progression. Exact broker cash/basis disagreements remain unexplained blockers, never tolerated or relabeled as rounding.

Repeat GET-only reconciliation and same-intent observation to demonstrate the behavior actually exercised. A complete single fill can prove nonzero paper accounting but cannot prove actual partial-fill behavior or a network timeout. Partial fills are not guaranteed. A rejected or unfilled order supplies no nonzero settlement proof. Do not send more orders to obtain a desired outcome.

Retain separate statuses for isolated synthetic partial-fill/retry tests, observed broker partial fills, observed idempotent readback and any actual ambiguous transport outcome. Alpaca paper execution is simulated and does not prove live securities settlement. Its simulator does not credit dividends; use the existing separately labeled, evidence-backed shared action methodology without increasing broker-spendable cash.

After the sole attempt, keep further trading blocked pending independent review. Successful bounded validation does not automatically approve general activation or change ordinary release checks. Report unresolved evidence honestly and preserve all original records and theses.

## Minimum independent acceptance coverage

- Concurrent requests, different keys/decisions and retries cannot create a second validation intent or broker POST; failed attempts never replenish the allowance.
- Wrong symbol, side, quantity, revision, authorization linkage, either cap, missing evidence, stale prices or invalid/closed session fail before submission.
- A session closing or decision/protocol expiring during final renewal prevents POST, with the existing intent preserved.
- Inception uses the same prospective timestamp for both portfolios, rejects post-close observations and cannot be reset.
- Ambiguous acceptance is reconciled by the same identity; changed, missing or unsupported fill evidence fails closed.
- Matching expired record retries return the original receipt without making its expired decision executable.
- Ordinary activation/execution remain hard-disabled even after validation evidence or a successful validation fill exists.

Source semantics: [Alpaca paper-trading specification](https://docs.alpaca.markets/us/docs/paper-trading). The actual runtime receipts, reviewed code revision and test results must be recorded separately; this document supplies none of them.
