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

Risk checks now use exact nano-dollar marks, cash, modeled income and integer ratio comparisons for both nano and legacy-cent portfolios. Cent projections remain display conveniences and never determine order eligibility. The normal and one-share validation routes share the same reservation calculation; there is no upward-rounded NAV denominator.

With exact operational NAV V, cash C, marked holdings H, target position P, modeled income I, and reservation R = whole quantity × max(observed mark, explicit limit), enforce R/V <=5%. For buys, enforce (P+R)/V <= the instrument cap, (H+R)/V <=90%, and C-R >=10% of V+I with nonnegative remaining cash. Implement these as BigInt cross-products, with no floating-point division or tolerance. Modeled income never funds an order. The validation route additionally requires one SPY share, R <=$1,000 and R/V <=1%.

Sells use the same larger-of-mark-and-limit reservation for the order cap, retain the inventory check, and need not cure every pre-existing exposure or cash breach. A low sell limit cannot disguise a large liquidation. Every held security and the ordered asset requires a fresh positive mark, including holdings unrelated to the order.

These formulas implement conservative pre-trade reservation under the existing mandate. At an above-mark buy fill, reserving the larger limit also overstates acquired marked exposure, guarding against the associated NAV reduction. At a better-priced fill, actual retained cash improves. This is not a guarantee against subsequent market movement, unmodeled fees or broker discrepancies: actual fills and drift still require reconciliation. No broader trading permission follows from this arithmetic correction.

Public state exposes exact cash, value, economic-value and basis strings. Dollar numbers and percentages are display conveniences; normal currency formatting may show two decimal places. A displayed zero or rounded amount is not evidence that an exact residual disappeared. Inspect the exact fields and source receipts for reconciliation.

## Broker agreement and unresolved differences

Compare broker decimal cash and basis with exact ledger values. There is no permitted cash tolerance, automatic rounding fee, balance reset or inferred normalization. A cash/basis mismatch reports both exact amounts and `unexplained_difference_nanos`, defined as broker minus ledger. Preserve the fill and raw receipts; block further execution pending actual explanation. A one-nano difference remains an unexplained difference, not a manufactured correction.

An authenticated nonzero fill and corresponding cash/basis observations are still needed to verify this particular paper account's treatment. Synthetic tests prove implementation behavior only. Alpaca's [account-activity documentation](https://docs.alpaca.markets/us/docs/account-activities) identifies executed price/quantity and nontrade net amounts, but does not establish a universal round-to-cent rule for this reconciliation. Its [paper-trading specification](https://docs.alpaca.markets/us/docs/paper-trading) excludes simulated dividends. Neither document authorizes ignoring unexplained discrepancies.

## SPY basis evidence gap — 28 October 2026

Actual reconciliation seq674 reports cash43546.18 matching exactly, but 32SPY
shares have raw broker basis24654.430016 versus receipt-derived exact24654.43.
Original five-share basis3839.98 plus actual fills2×770.85 and25×770.91 total
24654.43. The difference is exactly0.000016USD (16000 nano-dollars).

An arithmetic hypothesis fits: exact position average770.4509375, rounded half-up
to six decimal places, is770.450938; multiplying by32 gives24654.430016. This is
not an observed average-entry-price receipt or a proven broker rounding policy.
The retained order average770.905556 belongs to the new27-share order, not the
entire32-share position.

Alpaca's official position-average-entry-price calculation documentation explains
weighted average and compressed FIFO and expresses average as cost_basis/quantity.
It does not establish six-decimal rounding or a tolerance contract:
https://docs.alpaca.markets/us/docs/position-average-entry-price-calculation .
Do not infer one merely from this numerical fit.

The diagnostic source addition retains the unmodified /v2/positions response
inside each new reconciliation receipt as broker_positions, with source URL and
retrieval/observation timestamps; already-acquired evidence also survives a later
reconciliation processing error when its blocked receipt can be persisted.
Both ordinary and managed snapshots retain optional avg_entry_price_text exactly
as reported. No new endpoint, credential, order or accounting operation is added.
Existing immutable receipts cannot be retroactively populated.

Strict comparison still rejects this discrepancy. Exact analytical cash/basis,
prior history and execution guards are unchanged. Parent-reviewed publication
and a fresh GET-only reconciliation are required to obtain the missing raw
position average. Any later representation handling needs explicit evidence and
review; this diagnostic change does not resolve or authorize ignoring the mismatch.
