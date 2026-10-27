# Integration verification

This report is finalized after hosted checks. Official experiment: PAUSED / NOT STARTED.

Verified so far: developer-environment Alpaca authentication, paper account access and timestamped free IEX AAPL/MSFT/SPY observations. Account starts at $100,000 cash, zero positions/open orders. The account itself offers margin and shorting; the application prohibits both.

Private Sites owner-only access was provisioned. Runtime Alpaca secrets were stored through the Sites secret interface. No new paid service or AI API subscription was added.

Current sources inspected: Sites skill references for D1 storage, identity, Site-hosted MCP and cloud schedules; https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/d1/platform/pricing/ ; https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform ; https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt . ChatGPT subscription access is not an API credential. Cloud task availability and successful execution must be verified separately from documentation.

The source helpers referenced by the Sites skill are not installed in this managed executor; the documented Worker ESM output contract is built with esbuild, with a source mirror push and native archive publication. No local host is used for production.
