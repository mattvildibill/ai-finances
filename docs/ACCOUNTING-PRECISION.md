# Exact monetary accounting policy: usd-nano-v1

This policy is opt-in at a new official opening. It never migrates or rewrites an existing opening, fill, thesis, receipt or action settlement. An opening without `accounting_policy: "usd-nano-v1"` retains the original integer-cent rules and precision failures. Unknown policies fail closed.

## Representation and supported scope

Canonical monetary values are signed integer strings representing USD 10^-9, calculated with BigInt. For example, `$500.123456789` is `"500123456789"` nanos. Portfolio cash, weighted-average position basis, realized P/L, income and fees have authoritative `*_nanos` fields. Negative realized P/L is permitted; negative cash, basis or modeled income is not. JSON never receives a BigInt or a binary floating-point value as the authoritative money representation.

The supported input precision is nine decimal places, with additional trailing zeroes permitted. Nine decimals is this application's explicit processing bound, not an assertion about Alpaca's monetary settlement precision. Nonzero precision beyond that bound fails closed. Scientific notation and malformed decimal text are rejected. Whole-share quantities remain mandatory. Fractional fills, fractional split outcomes, cash in lieu and newly introduced nontrade fees are not enabled by this policy.

Keep broker fill price/quantity strings and immutable raw activity receipts. Snapshots retain `cash_text`, `equity_text`, `portfolio_value_text`, position `cost_basis_text`, and observed quote `price_text` alongside convenience numeric display fields. Do not derive an execution price from average order price, infer missing fills, or round a broker fill into a fabricated cent transaction.

## Fill accounting and basis

For a supported whole-share fill, exact notional is quantity multiplied by the original decimal price. Cash and basis use that exact amount. Repeated receipts cannot account the same fill twice. Decimal display formatting does not change the ledger.

For a partial sale, allocate weighted-average basis proportionally using integer division at one nano, retaining the remainder in the unsold position. A final sale allocates the entire remaining basis. This deterministic basis-allocation convention conserves total cost and aggregate realized P/L. It does not describe broker cash rounding or claim that a broker applies the same basis-allocation convention. Any actual basis disagreement remains visible and blocks reconciliation.

## Comparison and distributions

A nano opening records the original fresh SPY reference price as decimal text. The analytical comparator buys whole shares using exact division of the same $100,000; exact residual cash and cost are recorded. Both portfolios share the same prospective start. Later valuations use exact decimal observations, not the conservative cent projection used for execution risk checks.

Ordinary distribution entitlements equal eligible whole shares multiplied by the evidenced rate, retaining all supported decimal units. Active and SPY use identical entitlement and payment rules. Payment transfers the same exact modeled amount from receivable to modeled cash; income is recognized once. Neither receivables nor modeled distribution cash increase broker cash or fund an order. Shared action events preserve `amounts_nanos`, policy and source terms. No cent-rounded modeled dividend is necessary.

## Cent projections and display

Legacy risk helpers receive conservative cent projections: operational cash, basis and operational NAV are floored; the cash-reserve NAV is ceiled; modeled receivable/cash income projections are ceiled. These projections never replace the exact ledger. The bounded validation starts flat and permits only one intent, so upward quote projection conservatively sizes its single purchase against the original cash NAV. This is not a claim that upward marks give a conservative NAV denominator for a later invested portfolio: general trading remains disabled and must use separately conservative exact denominators before broader activation. Analytical valuations retain exact marks.

Public state exposes exact cash, value, economic-value and basis strings. Dollar numbers and percentages are display conveniences; normal currency formatting may show two decimal places. A displayed zero or rounded amount is not evidence that an exact residual disappeared. Inspect the exact fields and source receipts for reconciliation.

## Broker agreement and unresolved differences

Compare broker decimal cash and basis with exact ledger values. There is no permitted cash tolerance, automatic rounding fee, balance reset or inferred normalization. A cash/basis mismatch reports both exact amounts and `unexplained_difference_nanos`, defined as broker minus ledger. Preserve the fill and raw receipts; block further execution pending actual explanation. A one-nano difference remains an unexplained difference, not a manufactured correction.

An authenticated nonzero fill and corresponding cash/basis observations are still needed to verify this particular paper account's treatment. Synthetic tests prove implementation behavior only. Alpaca's [account-activity documentation](https://docs.alpaca.markets/us/docs/account-activities) identifies executed price/quantity and nontrade net amounts, but does not establish a universal round-to-cent rule for this reconciliation. Its [paper-trading specification](https://docs.alpaca.markets/us/docs/paper-trading) excludes simulated dividends. Neither document authorizes ignoring unexplained discrepancies.
