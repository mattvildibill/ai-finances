# Blue Capital launch readiness — 27 October 2026

Decision: **remain paused and unstarted**. This is an undeployed source review, not an activation or production verification receipt. No paper orders, runtime-secret access, production writes, deployment, automation changes, or mandate expansion occurred.

## Scope and source

Inspected `mattvildibill/ai-finances`, branch `work`, starting at `8ec7bb1a7ed7a5ffc984df9675ad229c574382a8`. The initially empty local checkout was populated from that authoritative remote branch. Read BLUE.md, MANDATE.md, reconciliation documentation and source. No AGENTS.md or repository .agents/skills files were present. Original research, challenge, decision and verification documents, database migrations and journal records were not edited.

The parent reports production remains paused/unstarted with $100,000 cash, zero holdings/orders and zero drift. Its 27 October journal sequences 21–26 are parent-provided evidence, not reverified from this environment. October 26 closing observations cannot authorize execution.

## Proposed changes

- Exact decimal arithmetic for whole-share fills with subcent unit prices, preserving original price text. Five shares at $10.002 account for exactly $50.01; five at $10.001 remain blocked rather than rounded. Fractional shares remain unsupported, and order validation now explicitly requires whole shares. No broker fee or settlement rounding convention was invented.
- Rebuild validates the complete same-time analytical SPY opening, including contemporaneous observation, original mark, whole shares and residual cash. Missing, delayed or altered benchmarks fail closed.
- Reconciliation refetches even closed orders by their durable client ID. Missing historical activities and conflicting raw versions remain blockers across subsequent runs. Original cash entries and raw versions remain unchanged.
- Removed export of the dormant execution engine; only the hard-disabled public execution entry point remains exported. This reduces direct accidental invocation and does not make the internal engine launch-ready.
- Corrected documented build/test order; added isolated synthetic regression and comparison-policy tests.

## Measured verification

Node v24.19.0. Dependencies installed using `npm ci --cache /tmp/blue-npm-cache`. The first install failed because the default npm cache was unavailable; using writable /tmp resolved it. An initial test run before build exposed four missing generated-asset failures; building resolved them, without changing dependencies or lockfile.

`npm run build` passed. `npm test` passed **72/72**, with zero failures, skipped tests or cancellations. Tests use synthetic broker fetchers and temporary SQLite databases; they cannot reach official records. Coverage includes partial fill settlement, cancellation, duplicate retries, cash/basis/realized P&L, raw activity corrections, missing activities, stale/future observations, pagination, external orders, lost reconciliation lock, append-only storage and authentication. New regressions cover exact subcent transaction amounts and ambiguous-price rejection, fractional-order rejection, closed-order rechecks, disappearing activity, persistent corrections, and invalid opening benchmarks. The public execution test verifies zero broker requests even with TRADING_ENABLED=true.

An independently assigned code/safeguard reviewer inspected the baseline and diff, ran build plus **69/69** tests before the three comparison-policy tests were added, and ran **50,000** exact-notional oracle cases successfully. The reviewer found no introduced defect in the scoped changes. Their baseline isolated reproduction reached one mocked POST through the then-exported dormant engine without opening/reconciliation prerequisites; no real network request occurred. Removing the export is containment, not a substitute for future prerequisite enforcement.

Three later policy tests verify arithmetic only: both active and passive portfolios use a pre-payment entitlement snapshot despite intervening sales/buys; a common 2:1 split preserves both bases and NAV with corresponding unadjusted marks; a positive dividend correction appends a new event and negative reversals remain unsupported. They do not verify production entitlement sources, tax treatment, action ingestion, or historical corporate-action replay.

## Launch blockers and proposed next release

1. **Production corporate-action workflow absent.** readLedger does not ingest distributions/splits. Acquire verified entitlements, effective/payment times, action IDs, source evidence and observation time, and reconcile the same methodology for active and SPY. Paper dividends are not broker cash credits; maintain an explicit modeled-income layer and reconcile broker cash separately. Test sold-before-payment, bought-after-entitlement, split/ex-date ordering, repeated/corrected notices, and observation-time replay. Unsupported return of capital, mergers, spinoffs, withholding, fractional cash-in-lieu and reversals must pause affected metrics/trading. Do not advertise total return from the current pure helper tests.
2. **Quantity/settlement coverage incomplete.** Whole shares and exactly representable cent totals are tested; fractional-share holdings/fills and fractional-cent cash totals remain blocked. Obtain actual settlement evidence and an explicit verified precision policy; do not infer fill cash from average order prices or silently round unit prices. Actual hosted nonzero-fill settlement, partial-fill settlement and timeout recovery remain untested. Existing zero-fill reconciliation is insufficient.
3. **Execution and activation are not ready.** No activation route exists. Before any gate removal, validate a unique atomic prospective opening and SPY benchmark using fresh regular-session observations and a dedicated flat account. Enforce latest successful reconciliation, official active state, fresh authenticated broker state, complete linked independent research/challenge/manager records, and lease ownership immediately before a POST. The dormant engine currently hardcodes active/verified context and lacks execution lease renewal. Do not merely flip OPERATING_WORKFLOW_VERIFIED.
4. **Public state/UI is still the preparation view.** service.state hardcodes paused/unstarted allocation; it must derive official balances, inception and benchmark from the verified ledger before launch, show unavailable marks/metrics honestly, and keep price-only versus total-return treatment explicit.
5. **Deployment and hosted verification pending parent review.** Review and publish an exact matched source/build revision through the existing Site workflow only after approval, then verify authenticated readback and repeatable operation. No deployment was attempted here.

The AAPL/MSFT/SPY caps permit only 45% combined target exposure at fixed NAV. Keep the universe and all limits unchanged; cash remains a valid decision. The existing weekday automation was not touched, retried, or duplicated. No new schedule is proposed for activation by this patch.
