# Blue Capital

A private cloud-hosted experiment: $100,000 imaginary capital, real Alpaca IEX observations, actual authored agent research, and an immutable decision journal. **The official experiment is paused and has not started. No orders have been sent.**

## Architecture

- Private ChatGPT Sites Worker: browser UI, authenticated `/mcp`, and JSON API.
- Sites-managed D1: append-only journal, snapshots, reviews, idempotency and update locks. SQL triggers reject UPDATE and DELETE of journal rows. SHA-256 content digests support export verification; privileged infrastructure administrators are outside this application-level immutability boundary.
- Fixed Alpaca paper host and free IEX data. Alpaca credentials and optional service token are server secrets, never bundled.
- AI research uses existing ChatGPT agents through the Site plugin; there is no AI API key, SDK, or independently billed model dependency.
- Sites cloud tasks are the intended unattended runner. Runtime records change without rebuilds. Scheduling is subject to successful hosted verification and the user's included ChatGPT limits; no paid plan or paid API has been added.

Source of record: https://github.com/mattvildibill/ai-finances . Sites requires a deployment mirror of the exact same commit. The cloud development environment builds/tests source; it is not the production server. No PC process or file is involved.

## Run checks

Node 24: `npm ci`, `npm test`, `npm run build`. `npm run db:generate` creates schema migrations after changes; never rewrite applied SQL. Build embeds `web/` in a Worker and packages migrations. Publish `dist/` as a tar archive after pushing the matching commit to the Site repository. Production secrets belong in Sites, not `.env` or hosting.json.

## Readiness and limits

See [the operating mandate](docs/MANDATE.md), [Alpaca preflight](docs/ALPACA.md), [integration report](docs/DELIVERY.md), and [blue's handoff](docs/BLUE.md). Original preflight evidence is `docs/alpaca-verification.json`; hosted observations are independently retrieved and stored in D1, not served from that source fixture.

The internal execution engine persists an order intent before a POST, uses a deterministic Alpaca client order ID, and does not automatically repeat ambiguous requests. It is **hard-disabled in this release**. GET-only reconciliation preserves actual broker activities and rebuilds supported cent-denominated fills. Fractional-cent settlement normalization, live fill verification, distributions/corporate actions and benchmark activation remain release prerequisites. A submitted buy/sell decision is a proposal, never an executed trade. The initial UI is an honest paused allocation, not invented performance.

## API and identity

Site dispatch enforces owner-only access. The Worker additionally requires the trusted Site identity for browser/MCP access. A service caller must pass both Sites' supported service access and the server-only `SERVICE_TOKEN`; credentials are acquired securely, never embedded in prompts. MCP tools: `portfolio_state`, `refresh_market`, `submit_record`, `execute_decision`, `reconcile_paper`, `export_history`. See schemas in `worker/index.js`.

Use a stable idempotency key on retries. Existing content with the same key returns the original event; changed content is rejected. Timestamps are server receipts, distinct from source observation and market data time. Replay filters by receipt time so later knowledge cannot leak into an earlier view. Revisions append records and refer to originals; they never overwrite them.
