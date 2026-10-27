# Blue Capital readiness continuation — 27 October 2026

**Judgment: suitable for review as a paused preparation release; not ready to launch.** This report supplements the first-pass report and local commit `fd6f8f16c6efaf56456aa5dbd780af9655dea61f`. No push, deployment, runtime-secret access, official record mutation, order submission, automation change or unpause occurred.

## Implemented continuation

- Added read-only activation preflight. It checks a prospective flat-account snapshot, subsequent reconciliation, existing inception, and internal release/approval attestations bound to an exact 40-character source revision and supporting verification records. It always returns `ready:false` while corporate-action workflow and the release gate remain unverified. These attestations are not accepted by public submit_record; their presence is not automatically generated approval. No activation endpoint was added.
- The private execution engine now validates persisted research/challenge/manager links, distinct authors, record order, referenced snapshots, explicit limit price and expiry, revisions, official ledger/benchmark, active control, release revision/approval references and a fresh successful reconciliation. Later accounting evidence invalidates that reconciliation. It checks broker cash, quantities and basis against the ledger, plus current fixed-paper asset metadata before intent creation. Only approved-universe active/tradable US-equity assets on the allowed US exchanges pass. Fractional quotes without exact cent marks remain blocked rather than rounded.
- Lease acquisition precedes intent lookup and all brokerage access. Ownership and expiry are checked before and after requests. Receipt insertion is fenced atomically by lease ownership and database execution time. Prerequisite reads use an optimistic journal head check; intent insertion compares the same head atomically. Public record submission shares this lease and uses fenced append, preventing a decision revision during submission. Freshness/decision expiry is checked again immediately before POST. An ambiguous response or post-acceptance lease loss leaves the durable intent unresolved; a retry only queries its client ID.
- Added `0002_orange_hydra.sql`, a generated partial unique index allowing only one experiment_opened record. One opening already contains both initial cash and the simultaneous analytical benchmark. Identical ID retries remain idempotent; a second inception is rejected. No existing migration or original event is rewritten. A database already containing multiple openings would fail this migration and require investigation, not deletion. The final controlled activation/pause/resume workflow remains unwired.
- Public state derives inception, cash, holdings, marks, exposure and passive reference from the ledger. Missing/stale marks and unresolved reconciliation suppress affected values/returns while retaining known quantities. Unknown accounting no longer appears as $100,000, zero holdings or 0% concentration. The execution status remains paused regardless of synthetic active-control fixtures. UI labels comparison basis and respects null returns. No browser rendering test was run; server outputs and source null handling were tested/reviewed.
- Added an unwired, GET-only corporate-action evidence collector for the existing Alpaca connection. It requests the fixed universe, all action types and incomplete announcements, preserves raw pages, bounds pagination and rejects query/key conflicts. It never creates entitlements or accounting entries. See CORPORATE-ACTION-PATH.md for primary sources, proposed shared entitlement/economic-cash policy and known limitations.

## Actual verification

On Node v24.19.0:

- `npm run db:generate`: generated the additive single-inception index and matching Drizzle metadata.
- `npm run build`: passed.
- `npm test`: **95 tests passed, zero failed/skipped/cancelled**.
- `git diff --check`: passed.

The continuation adds 23 tests to the prior 72. They exercise missing activation/reconciliation prerequisites, release-revision/evidence binding, expired/revised decisions, broker drift, current asset eligibility, concurrent attempts, ambiguous POST retry, lease theft before and after simulated acceptance, queued lease expiration, atomic journal fencing, shared record-submission lock, ledger-derived state, stale values, unresolved corrections, unique inception, and raw corporate-action pagination/security/idempotency.

All trading-path tests use synthetic credentials and fetchers in temporary SQLite databases. A test-only in-memory source harness exposes the private engine to tests; production source does not export it and has no bypass flag. Production executeDecision remains hard-disabled and its zero-request tests pass. No synthetic result is evidence of real broker settlement.

## Separate independent review

The independent reviewer initially ran 83 tests and found four defects through isolated adversarial reproductions: a revision race before intent creation, a captured-time lease expiry race, unresolved reconciliation still showing returns, and unknown UI holdings falling back to zero concentration. All four were fixed and regression-tested. The reviewer reran the adversarial cases and build/tests at 91 tests, then reviewed the asset/freshness additions and passed **94/94**. Their final judgment was a paused preparation release only. The additive inception index and its 95th test were added afterward and passed the main suite; that last database-only delta was not separately reviewed by the agent.

No independently found issue is being presented as passed before its fix. The earlier first-pass independent 50,000-case arithmetic check remains relevant; it was not rerun unnecessarily.

## Remaining code/workflow gaps

1. **Shared corporate-action accounting is not complete.** Raw acquisition does not prove coverage or terms. Implement reviewed ordinary-action classification, authoritative ex-date entitlement replay, receivable/payment transitions, split handling, late/corrected event replay, and an economic ledger separated from executable broker cash. The same method must apply to active and SPY. Public free sources exist, but missing/ambiguous terms must block. This is implementation work plus evidence/policy review, not a reason to weaken the mandate.
2. **Unsupported precision/actions remain fail-closed.** Fractional shares, cash totals not exactly representable in cents, fractional split residuals, cash in lieu, exceptional distributions, fees, withholding, mergers/spinoffs and reversals need explicit semantics and reconciliation. Current exact arithmetic does not establish those semantics.
3. **Controlled prospective activation remains unwired.** Preflight, single-inception storage and execution prerequisites are implemented, but no public activation/control writer exists. Before launch, a parent-reviewed flow must atomically establish prospective inception and required control/approval state under the shared lease, revalidate current evidence and preserve that single start forever. Keeping this unwired prevents this preparation release from acting on conditional approval automatically.

## External evidence and human-action requirements

- Parent-approved deployment is required before hosted tests of these changes. This task explicitly forbids push/deploy; no approval or deploy attempt was made.
- Verify authenticated corporate-action access with the existing runtime connection. No new credential/account/paid service is required by the proposed path, but actual runtime entitlement was not tested.
- Obtain real authoritative action terms and verify completeness/corrections; do not fabricate dividend entitlement or backdate prices. A prospective October 27 start cannot inherit SPY's September ex-date entitlement merely because its payment date is October 30.
- Actual nonzero broker-fill settlement, partial fills and ambiguous submission recovery remain untested externally. The task forbids paper orders, so no fills were manufactured for this purpose. A dedicated later test/launch authorization and plan are required; zero-fill production reconciliation does not replace this evidence.
- Parent must review release-specific evidence, the distribution policy and remaining code before any activation. Internal attestation records must represent actual approval/verification, not a synthetic fixture copied into production.

The original $100,000 mandate and AAPL/MSFT/SPY universe are unchanged. Their concentration caps still allow only 45% combined target exposure at fixed NAV. The existing weekday automation was not retried or duplicated. Production remains as reported by the parent; this environment did not reverify it.
