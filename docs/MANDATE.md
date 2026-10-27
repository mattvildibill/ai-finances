# Blue Capital investment mandate — version 1

The question is what happens when an AI manages **$100,000 of imaginary money against real US stock markets**. This is an educational paper experiment, not a promise of returns. The official experiment remains **paused** until its complete operating and reconciliation workflow is verified. Preparation records and observed prices are real; they are not a portfolio track record. A valid decision is to hold cash.

## Capital and permitted instruments

- Initial experiment capital: $100,000 cash. No deposits, withdrawals, borrowing, short selling, options, crypto, or leveraged/inverse ETFs.
- Only US-listed, active, tradable equities and plain diversified ETFs. The initial explicitly approved universe is AAPL, MSFT, and SPY. Expanding it requires a new recorded mandate version and validated asset metadata before an order.
- Maximum individual stock weight: 10% of NAV. Maximum diversified ETF weight: 25%. Maximum aggregate invested exposure: 90%; minimum cash: 10%. Maximum single order: 5% of NAV. Broker-provided buying power, leverage, and shorting permissions never expand these limits.
- New buys must pass limits using fresh marks for every held security and conservative limit-price cash reservation. Drift above a cap freezes further purchases in the affected position and prompts a review; reducing positions is allowed if other checks pass. Never submit another order while an earlier order is open or its outcome is uncertain.

## Research, challenge, and portfolio management

The researcher submits a dated, structured thesis with links, source publication/observation times, the actual evidence used, expected horizon, uncertainties, and explicit disconfirming conditions. An independently assigned challenger submits counterevidence, missing assumptions, alternatives, and conditions under which cash is preferable. The portfolio manager responds to those challenges, records any revisions as new records, and chooses hold, buy, or sell with a position size and limit price. These are authored outputs and evidence summaries, **not a transcript of hidden model reasoning**.

Ordinary code validates timestamps, accounting, instrument eligibility, cash, concentration, and execution limits. AI text cannot override a failed guard. The initial suggested review cadence is one weekday preparation review before the US regular session and one weekday afternoon review, using the market calendar to skip closed sessions; the actual connected cloud schedule and its verified status are recorded in operations metadata.

## Execution assumptions

All trading requests target the hard-coded `https://paper-api.alpaca.markets` origin. Live-trading origins, caller-supplied broker URLs, extended-hours orders, and market orders are prohibited. Orders are day limit orders during a fresh, open regular market session. An order requires runtime verification, an active experiment, fresh authenticated account/position/order state, a fresh Alpaca clock, fresh IEX data, a complete research/challenge/manager decision, and an available append-only audit store. Prices or clocks older than 120 seconds, or over five seconds in the future, block affected execution. Never treat retrieval time as market-data time.

Create a durable intent with a unique client order ID before broker submission. On a timeout or retry, reconcile that ID against Alpaca; do not issue a new ID or assume failure. Outstanding orders reserve cash and inventory. Fills, not decisions or order acknowledgements, change accounting. Partial fills must be recorded separately or reconciled by monotonically increasing cumulative filled quantity without double counting. No official start, fill, or benchmark price may be backdated.

Paper execution is hypothetical. Alpaca's simulator does not reproduce market impact, order queue priority, latency slippage, price improvement, regulatory fees, or dividends. IEX is one venue and is not consolidated SIP/NBBO data; paper fills may use a different market reference. Last trades may be several hours old outside the session and cannot authorize a trade. Report each price's feed and timestamp as well as its retrieval time and the market clock/session.

## Accounting and passive SPY comparison

Maintain cash, weighted-average cost basis, realized/unrealized P&L, and fees in integer USD cents. Quantity supports fractional shares, with each cash transaction rounded once to cents. The current accounting input requires cent-denominated fill prices; fractional-cent broker average prices require a validated normalization/reconciliation step before an official launch and must not be silently rounded as if they were original fills.

The passive SPY analytical comparator starts **at the official experiment start time**, with the same $100,000, an actually observed fresh IEX price available at that time, whole SPY shares, and residual cash. It is an explicitly labeled analytical reference, not a claimed Alpaca execution. It is exempt from the active portfolio's concentration cap because its purpose is a 100% passive SPY strategy. Never manufacture earlier observations or start it at the first later trade to hide time spent in cash. Comparator cash earns zero interest, as does active idle cash. Initial explicit modeled commissions are zero on both sides. Actual evidenced charges, if present, must be recorded consistently and disclosed.

**Total-return comparison is unsupported until a shared distribution and corporate-action reconciliation process is verified.** Alpaca paper dividends are not credited. Both portfolios must eventually recognize the same evidence-backed distribution entitlement methodology, payment dates, split ratios, cash-in-lieu rules, and modeled costs. Distribution entitlement cannot simply use payment-day holdings; use the relevant entitlement record. Keep price return separate from adjusted/total return, never mixing adjusted SPY prices with unadjusted active prices. Until supported, label any available comparison “price-only, distributions and some costs excluded,” mark it incomplete after an unresolved action, and pause affected trading/metrics. Return of capital, mergers, spinoffs, delistings, withholding, and fractional cash-in-lieu are not automatically supported; they require explicit reconciled events.

Every adjustment is a new event with economic occurrence/effective time, the time it was first observed, source evidence, and an ID. Original transactions and theses are preserved. A historical replay uses **observation/recording time** to show only what was available then, even when a later correction describes an earlier economic date. Corrections append compensating records; they do not rewrite prior rows.

## Risk and integrity

Expose cash weight, gross exposure, security concentration, total return, and drawdown with their observation window. Drawdown needs at least two valid chronological NAV observations; annualized volatility needs at least 21 daily closing NAV observations (20 returns), uses sample standard deviation and 252 sessions, and is an estimate rather than a forecast. The caller must supply consistent consecutive trading-session closes and account for external flows. Sharpe, beta, and value-at-risk are unavailable until a sufficient, validated methodology and history exist. Unavailable metrics display as unavailable, never as reassuring zeroes.

The store is append-only at the application/schema level; duplicate IDs are idempotent only when payloads match. A database owner with administrative access can still alter infrastructure; this is not externally notarized or independently write-once storage. Preserve source-controlled migrations, deployment revision, transaction IDs, and audit exports. Authentication protects read and write interfaces; runtime secrets remain server-side. An authentication, persistence, market-data, broker reconciliation, or automation-health failure prevents new trades. The website must clearly distinguish a saved schedule from a proven successful unattended run.

## Launch conditions

Launch requires verified private hosting, persistent write/readback, unattended authenticated access, broker secret configuration in production, independent agent submissions, research-to-decision linkage, idempotent paper-order reconciliation, fresh market-session execution checks, cash/position agreement with the dedicated paper account, and a consistent SPY/corporate-action/cost policy. Keep the official experiment paused while any essential condition is unmet. No paid AI API or subscription is required or assumed; blue must use a verified existing ChatGPT cloud connection to submit actual outputs.

Sources reviewed for this mandate: [Alpaca paper trading](https://docs.alpaca.markets/docs/paper-trading), [Alpaca market data](https://docs.alpaca.markets/docs/about-market-data-api), and the repository's dated `ALPACA.md` verification notes.
