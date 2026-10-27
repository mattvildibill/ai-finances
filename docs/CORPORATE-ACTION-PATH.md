# Proposed corporate-action evidence path

Status: **investigated and partially scaffolded; not production verified**. This does not change mandate version 1, authorize activation, or claim total-return support.

## Acquisition without new paid services

Alpaca's [data pricing](https://alpaca.markets/data) lists corporate actions in the free plan. The [corporate-actions endpoint](https://docs.alpaca.markets/us/reference/corporateactions-1) uses the fixed data host, accepts process-date ranges and paginated results, and warns that announcements may arrive late. The proposed collector in `lib/corporate-actions.js` uses existing server credentials, fixed AAPL/MSFT/SPY scope, GET only, all action types and `data_quality=all`. It saves raw pages, including malformed and unsupported evidence, before validation. It has bounded pagination and stable idempotency. Neither the collector nor its new transport exception permits paper or live POST requests. It is not exposed through a route or automatically called by refresh.

No runtime entitlement was checked and no credentials were accessed. After parent-approved deployment, verify the existing runtime connection can read this endpoint. An empty result is not evidence that no action exists. A production pipeline still needs overlapping process-date queries, rechecks of known action IDs, issuer corroboration, changed/missing version handling, and an explicit completeness review. New IDs or incomplete notices cannot automatically become economic events.

Public corroborating sources include [Apple's dividend history](https://investor.apple.com/dividend-history/default.aspx), [Microsoft's September 15, 2026 declaration](https://news.microsoft.com/source/2026/09/15/microsoft-announces-quarterly-dividend-increase-7/), and [SSGA's distribution resources](https://www.ssga.com/us/en/intermediary/resources/documents/etf-dividend-distributions). Apple’s table does not provide every ex-date; a schedule is not a declared amount. Preserve the actual document version, observation time and source, not merely its current URL. The investigator could read the issuer pages through web tools; the linked SSGA XLSX was not inspected.

## Entitlements and comparison policy to implement

For verified ordinary cash distributions only, derive entitlement from reconciled holdings immediately before the authoritative ex-date boundary. Use the applicable exchange calendar/timezone and explicit action terms. Keep all contributing fill/opening/action IDs and calculations. Do not accept payment-day quantity as entitlement. Handle both active and analytical SPY through the same derivation; an inception after the ex-date has zero entitlement. SSGA's [2026 schedule](https://www.ssga.com/library-content/products/fund-data/etfs/us/distribution/SPDR_Dividend_Distribution_Schedule.pdf) lists SPY's September 18 ex-date and October 30 payment: a prospective October 27 inception is not entitled to that payment.

Ordinary processing must explicitly exclude special/large distributions, due bills and ambiguous/late notices. [FINRA Rule 11140](https://www.finra.org/rules-guidance/rulebooks/finra-rules/11140) and [Nasdaq guidance](https://www.nasdaqtrader.com/Trader.aspx?id=nasdaq-ex-date) distinguish exceptional cases. Do not infer all ex-dates from record dates.

[Alpaca paper trading](https://docs.alpaca.markets/us/docs/paper-trading) does not simulate dividends. Therefore, maintain two separate layers: broker-reconciled executable cash and a disclosed modeled economic-return ledger. Model the verified entitlement as a receivable at ex-date and move it to modeled distribution cash at payment date; that transfer does not create a second gain. Neither receivables nor modeled cash increase executable buying power. Use identical recognition timing, precision, fees and reinvestment policy for active and SPY. The current mandate says to recognize distributions consistently but does not define this implementation; review and document the policy explicitly before release.

Use exact decimal amount multiplication. Amounts that do not resolve to cents require a verified residual/settlement policy; keep them blocked now. The existing arithmetic supports exact cent outcomes but does not establish a broker rounding rule. Initially, exact whole-share splits could preserve basis if authoritative ratio/effective time and broker position changes agree. Fractional split results, cash in lieu, return of capital, capital gains distributions without supported classification, mergers, spinoffs, withholding, fees and reversals remain blockers. Unsupported events cannot be discarded because a parser lacks a schema.

Later discoveries and corrections must be append-only. Recompute the economic timeline from known evidence while filtering historical replay by receipt time, so a late notice never appears to have been known earlier. Raw price-only and modeled total-return metrics must remain separate; unresolved actions suppress affected metrics and execution.

## Evidence still required

- Authenticated runtime access and real response shape, rate limits and completeness behavior.
- Verified issuer amounts, authoritative ex-date rules and action classification, not synthetic entitlements.
- Integrated shared entitlement/action replay and economic-overlay reconciliation with explicit precision policy.
- Tests for pre-inception distributions, ex-date buys, sales before payment, split/ex-date ordering, late fills/notices, duplicate or conflicting versions, receivable-to-payment transfers, and unsupported action suppression.
- Hosted readback and independent review of that complete flow before lifting any gate.

The current collector is acquisition scaffolding only. Current synthetic comparison tests prove arithmetic examples, not these production requirements.
