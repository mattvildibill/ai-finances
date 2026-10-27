# Delivery and verification

Private production URL: https://blue-capital-lab.mattvildibill.chatgpt.site

Project `appgprj_6ae02104c4e88191bada1f8ca67d7528`; Site plugin `plugin_asdk_app_sites_3c4fbba1f8b8819184064cf466ad6441`; repository `mattvildibill/ai-finances`, branch `work`. Deployment source is mirrored to Sites at the same commit. The Codex cloud environment is a development workspace, never the production server. No user's PC resources are used.

## Completed integrations

- **Alpaca developer preflight:** six HTTP 200 checks, authenticated ACTIVE USD paper account with $100,000 cash/equity and no positions/open orders. Actual AAPL/MSFT/SPY free-IEX observations are in `alpaca-verification.json` with independent retrieval, market and session timestamps.
- **Private production hosting:** Sites deployment succeeded; owner-only access unchanged; D1 `DB` has events and locks. Alpaca credentials are server-side secrets. No Vercel resources, paid subscriptions or AI API dependencies were added.
- **Production source access:** actual hosted refresh succeeded after correcting a Workers redirect-option incompatibility. Immutable snapshot `blue-hosted-initial-verification`, seq3, receipt 2026-10-27T04:13:05.045Z. $100,000 cash/equity, no positions/orders; AAPL343.93, MSFT532.54, SPY765.225 were prior-session IEX trades, not current execution quotes.
- **Authentication, persistence and idempotency:** native authenticated tool state/read/write/export succeeded. Exact refresh retry returned identical ID, sequence, receipt and digest. Hosted replay before research submission excluded that later knowledge. An original failed refresh is preserved, not erased.
- **Real agent outputs:** researcher seq4, independent challenger seq5, portfolio manager hold-$0 decision seq9. Distinct authored summaries, source evidence, original thesis, horizon, uncertainty, and response to challenge are visible. This is not private chain-of-thought disclosure or a fabricated conversation.
- **Unattended data update:** cloud run `6b5a5066-35c0-8327-b492-9e33199d7bd3` completed, with matching successful result and persisted snapshot seq7 plus verification seq8. It used the Site plugin and read its writes back without deployment or a PC. See `automation-verification.json`. A second scheduled run `b4d27216-4a04-8331-b1c1-26cfa7d8cc60` completed a genuinely delegated researcher→challenger→manager cycle: snapshot seq10, research seq11, challenge seq12, hold decision seq13 and read-back verification seq14. See `independent-cycle-verification.json`. Regular schedule `Automation_836a58135960819190c113edc6440ef1` is enabled weekdays at 13:15 America/Los_Angeles.

## Tests and honest limits

Final suite: **63 passing tests** for money/basis, fills/splits/distributions, fresh-data and exposure guards, authentication, CSRF, real-SQLite persistence/reopen, append-only SQL triggers, idempotency, research/challenge linkage, replay, and zero broker calls while paused. This includes 14 reconciliation tests for real-activity mapping, partial fills, unsupported precision, immutable raw versions, terminal-order agreement, pagination, and execution-lease loss. These fixture-based tests do not prove an actual fill occurred. No order was sent. The newly added standalone reconcile_paper action did not appear in the cached connector tool list; normal refresh includes the same GET-only reconciliation so the existing verified update path remains sufficient.

Frontend: **19 DOM assertions passed**, including actual quote rendering, five-view rendering, navigation, filtering, snapshot replay, escaped hostile payloads, and refresh/readback. No visual browser screenshot test was available. Production logs show authenticated browser GETs for the page, assets and state returning 200. The screenshot renderer lacked user identity and was denied, so there is no claimed visual screenshot QA.

The scheduler's run-now action returned Action not found. A supported one-time schedule successfully executed instead; regular scheduling was restored. The first completed scheduled run proved data updates/readback; the second completed the independently staffed research/challenge/manager cycle. The user's blue dot has not itself completed its handoff, and multi-day reliability is not yet established.

Automatic approval review rejected a hosted call intended to test the paused paper-order guard before invocation, because the official experiment was required to remain paused. No order request reached the Worker. That hosted negative test is unverified; local tests confirm the hard gate sends zero broker requests.

## Remaining launch work

Official experiment **PAUSED / NOT STARTED**, $100,000 initial cash allocation, no holdings, no SPY inception or invented performance curve.

1. Verify actual broker fills, settlement normalization, cancellation/partial-fill reconciliation and retry handling under an expressly authorized test workflow. The release's execution gate remains hard-disabled.
2. Verify a consistent distributions, fees and corporate-action policy for active portfolio and passive SPY. Paper dividends/regulatory fees are omitted by Alpaca; unsupported actions must pause affected accounting. Fractional-cent prices are preserved and rejected by cent-only ledger normalization until explicitly reconciled, never silently rounded.
3. Verify the prospective shared experiment/benchmark opening and repeated multi-day operation of the already-once-verified independent cloud cycle. Adopt the supplied prompt in blue before claiming it coordinates the work.

## Documentation and access inspected

Current official Alpaca documentation sources are in `ALPACA.md`. Also reviewed Sites skill documentation for private identity, secrets, D1, Site MCP and cloud schedules; Cloudflare D1 pricing/limits; OpenAI separate ChatGPT/API billing and scheduled-tasks documentation. The chosen Sites path uses existing account connections and managed storage; no separately billed service was provisioned. Included usage limits still apply.

The Sites shell helpers were not installed in this executor. The build follows the documented Worker ESM output contract using esbuild and native Site archive publication. The valid archive contains root `.openai/hosting.json`, `dist/server/index.js`, and `drizzle/` migrations; D1's manifest binding is the string `DB`. Immutable journal triggers are in migration 0001.
