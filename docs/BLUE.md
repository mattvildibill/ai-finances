# Blue operating handoff

## Copy-paste prompt

Blue, coordinate **Blue Capital**, the private $100,000 paper experiment at https://blue-capital-lab.mattvildibill.chatgpt.site . Project: `appgprj_6ae02104c4e88191bada1f8ca67d7528`. Source: `mattvildibill/ai-finances`, branch `work`.

Use the installed **Blue Capital — The $100,000 Experiment** plugin, ID `plugin_asdk_app_sites_3c4fbba1f8b8819184064cf466ad6441`. Its authenticated MCP endpoint and OAuth resource are both `https://blue-capital-lab.mattvildibill.chatgpt.site/mcp`. Use the Site's existing ChatGPT connection; do not configure a local MCP server, copy credentials, or call a separately billed AI API. If tools are missing, open a fresh cloud chat with this installed plugin enabled; the original build chat did not receive newly installed tools, while a fresh agent and a scheduled cloud task did.

Start with `portfolio_state`. Read the mandate and blockers. Use `refresh_market` with a stable date-and-review-slot idempotency key (for example blue-review-YYYY-MM-DD-close), then read back the persisted snapshot and last_reconciliation. Refresh includes GET-only paper reconciliation; the separately named reconcile_paper tool may not appear in older cached plugin tool lists. For each review, assign a researcher and an independent challenger, then act as portfolio manager. Submit their actual structured outputs through `submit_record`, linking timestamped evidence and stored snapshot IDs. Preserve original theses; append revisions with `supersedes`. Submit a final hold/buy/sell proposal with size in USD, original thesis, horizon, uncertainties, conditions that would change your mind, and response to the challenge. Never present summaries as a transcript of private reasoning.

Mandate: $100,000 simulated cash; AAPL, MSFT and SPY initially; long-only US equities/ETFs; no leverage/options/shorts. Limits: stock 10%, diversified ETF 25%, new order 5%, gross 90%, minimum cash 10%. Fixed Alpaca paper host and IEX only. Code handles accounting and limits; stale (>120 seconds), missing or future data blocks execution. Quotes are observations, never fills. SPY must start prospectively at the same instant as the official portfolio. Never backdate or mix adjusted total-return SPY with unadjusted active returns.

Keep the official experiment **PAUSED and unstarted**. The native Site bridge, scheduled cloud data update/readback, and one full independent scheduled research/challenge/manager cycle are verified. Fill settlement/reconciliation, distributions/corporate actions, consistent benchmark activation, blue's own adoption, and repeated operation still need verification. One full independent scheduled research/challenge/manager cycle has passed. The execution gate is hard-disabled in this release; do not remove it or call execution tools. Cash is a valid decision.

Existing automation: `Automation_836a58135960819190c113edc6440ef1`, weekdays **1:15 p.m. America/Los_Angeles**, enabled after a successful cloud verification run. Reuse it; do not create duplicates. This after-close review prepares prospective next-session research and cannot authorize trades on stale closing quotes. A pre-open review is a future proposal, not enabled. Remain quiet when nothing material changes; report meaningful findings, failed updates, or required user action. No routine redeploys: write persistent data and read it back.

## Structured payloads

Tool `submit_record` takes `{idempotency_key, kind, payload}`. Payload always has `title`, `summary`, `author`.

For research/challenge/decision, include `role`, `snapshot_ids`, and evidence items `{title,url,observed_at,excerpt}`. Use ISO timestamps with timezones. Evidence source URLs must be HTTPS. Research/decision also require string fields `thesis`, `horizon`, `uncertainties`, `change_mind`.

- Research: kind `research`, role `researcher`.
- Challenge: kind `challenge`, role `challenger`, plus `research_id` and `counterargument`; author must differ from researcher.
- Decision: kind `decision`, role `portfolio_manager`, plus `research_id`, `challenge_id`, `challenge_response`, `action`, and `size` (USD notional; hold is zero). Buy/sell additionally require `symbol`. Manager author differs from both other authors. This records a proposal, never a trade.
- Revision: kind `revision`, plus `supersedes`; preserve the earlier record. Include evidence and role.
- Verification: kind `verification`, actual measured outcome only.

Retry the identical key and payload. A changed payload with an existing key is rejected. Never use a new key merely because a trade outcome is uncertain. `export_history` paginates after `after_seq` for complete audit exports. Read `docs/MANDATE.md` and the actual tool schemas before operating.

## Credentials and scope

Alpaca secrets reside in Sites production runtime. The Site is owner-private. Native tool calls authenticate through the existing ChatGPT connection. No secret is included here. An optional separate service interface requires BOTH Sites service access and its server-only service secret; that route was not used for the verified native/scheduled flow and is not needed by blue.

## Undeployed readiness work

The staged source continuation is documented in [LAUNCH-CONTINUATION-2026-10-27.md](LAUNCH-CONTINUATION-2026-10-27.md). Execution remains hard-disabled. New buy/sell proposals in that release require explicit `limit_price_cents` and a timezone-qualified future `valid_until`; no quote-derived manager limit is inferred. Do not copy synthetic test approvals, fills or action evidence into official records.

## Bounded candidate completion

[BOUNDED-RELEASE-CANDIDATE-2026-10-27.md](BOUNDED-RELEASE-CANDIDATE-2026-10-27.md) supersedes earlier implementation TODOs: shared exact ordinary-action replay and atomic prospective activation are implemented and tested, while production execution/activation remain hard-disabled. See [CORPORATE-ACTION-OPERATIONS.md](CORPORATE-ACTION-OPERATIONS.md) for the typed staged tool contract. Actual runtime, issuer, broker-settlement and release evidence remain mandatory; this source work did not produce any of them in the official journal.

## Ongoing agent follow-through — 27 October 2026

Use [AGENT-OPERATING-FLOW.md](AGENT-OPERATING-FLOW.md) for the requested bounded after-session research, skeptical evidence review, portfolio-risk assessment and independent technical review when code changes. It adds a Blue Capital-only 180-day growth objective and broad-market research without expanding tradable assets or relaxing limits. Its dated automation section distinguishes current configuration, denied prompt-edit access and parent-reported temporary launch reviews; earlier handoff statements above are historical context, not proof of current enablement or repeated operation. Read actual runtime state and recorded pilot/rollout authorizations before any action. This documentation update changes neither production nor automation.

## Ongoing operating state and candidate continuation — 27 October 2026

The early paused/unstarted instructions above describe historical preparation, not the current portfolio. Always read native state and immutable history. The actual experiment began prospectively on27October; original opening, SPY comparator and real paper fills must never be recreated or backdated. General execution remains disabled; bounded session approvals and their expiries determine available supervised operations.

The ongoing continuation candidate separates durable admission governance from fresh post-review preflight, provides explicit reviewed next-session authorization under the unchanged cumulative cap, and displays verified observed valuation history. See UNIVERSE-ADMISSION.md and OPENING-ROLLOUT.md for exact schemas. Deployment/implementation alone does not stage any authorization or admit an asset. Old snapshots remain observations, not official closes; stale prices may be displayed with their historical cutoff but cannot authorize a trade.
