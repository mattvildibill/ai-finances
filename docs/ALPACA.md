# Alpaca feasibility evidence

Verified on 26 October 2026 at approximately 20:57 America/Los_Angeles
(27 October 03:57 UTC). The original sanitized response is preserved in
`alpaca-verification.json`. No orders were submitted.

## Observed API results

All six requests returned HTTP 200 using the environment's credentials:

| Check | Result |
| --- | --- |
| Fixed paper host `/v2/account` | ACTIVE; USD cash, equity and portfolio value each $100,000 |
| `/v2/positions` | Zero positions |
| `/v2/orders?status=open&limit=500` | Zero open orders |
| `/v2/clock` | Closed; next open 27 October 2026, 09:30 America/New_York |
| IEX latest trades | AAPL, MSFT and SPY all returned timestamped observations |
| IEX snapshots | All three symbols returned snapshots |

The account advertises $400,000 buying power, a margin multiplier of 4 and
shorting enabled. Those permissions are **not the experiment mandate**. The
application must independently restrict spending to simulated cash, prohibit
shorting, leverage, options and non-US-equity assets, and never use buying power
as its spending limit.

| Symbol | Observed IEX last trade (USD) | Market-data timestamp (UTC) |
| --- | ---: | --- |
| AAPL | 343.93 | 2026-10-26T19:59:58.611425103Z |
| MSFT | 532.54 | 2026-10-26T19:59:58.275641289Z |
| SPY | 765.225 | 2026-10-26T19:59:59.950174796Z |

These are observations from the prior regular trading session, approximately
eight hours before retrieval. They are not live executable quotes at retrieval
time. The report preserves each request's start/completion time separately from
the exchange-data timestamp and the authoritative Alpaca market clock. Timestamp
window labels are descriptive; the clock/calendar must govern trading sessions.

## Current documentation checked

- [Paper trading](https://docs.alpaca.markets/us/docs/paper-trading), accessed
  27 October 2026: simulated fills use NBBO; paper trading does not model market
  impact, latency slippage, queue position, price improvement, regulatory fees
  or dividends. Partial fills can occur. Default paper balance is $100,000.
- [Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api),
  accessed 27 October 2026: Basic is free and covers US stocks/ETFs, with real-time
  equities coverage limited to IEX. The documented historical rate limit is 200
  calls/minute; other feed/history entitlements must not be inferred from this
  successful IEX check.
- [Latest trades](https://docs.alpaca.markets/us/reference/stocklatesttrades-1),
  accessed 27 October 2026: explicitly request `feed=iex`. This endpoint excludes
  trades with conditions that do not update bar prices, including odd lots.

IEX is one exchange, not the consolidated US market; its latest trade may differ
from the NBBO used by Alpaca paper execution. Use broker-reported fills for
transaction accounting, not a last-trade estimate. Keep a separate fill timestamp.

## Comparison and unsupported behavior

Do not label a price-only SPY comparison as total return. Alpaca paper omits
dividends; either explicitly exclude distributions consistently from both sides
and identify the limitation, or implement a separately sourced, auditable
distribution ledger for both. No dividend, split or merger adjustment is verified
by this preflight. An unhandled corporate action must pause affected trading and
performance attribution until reconciled. Do not silently assume zero economic
costs because the simulator does not charge fees. Record actual paper fees (if
any), disclose omitted costs, and keep any hypothetical cost scenario separate.

## Reproduce safely

From the cloud checkout, run `python3 scripts/verify_alpaca.py`. It uses only the
two environment credentials, fixes trading access to the paper hostname, disables
redirect following, issues GET requests only, writes a uniquely named sanitized
report, and refuses to overwrite an existing evidence file. API errors omit
response bodies and credentials. This checks access, not production secret
provisioning, unattended scheduling, or order execution. No execution workflow
has been verified by these read-only calls.
