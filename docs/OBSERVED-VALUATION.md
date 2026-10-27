# Observed portfolio tracking

The dashboard is a read-only projection of the immutable journal. It does not add fills, create a daily-close series, alter cash or change execution freshness.

`portfolio.value` marks the official holdings using the selected stored IEX trades. A verified matching account/position snapshot and successful reconciliation are required. A mark remains useful after 120 seconds for display only: `valuation_status: "last_known"` and the original trade, retrieval, snapshot and accounting-cutoff times remain visible. Execution continues to use its original strict freshness checks. Missing quotes for unheld watch-list assets do not erase a valid held-asset/SPY valuation.

An accounting failure or unmatched snapshot does not become an apparently current valuation. `last_verified_valuation` is a separate complete historical point with its own cash, holdings, NAV, benchmark, source IDs/digests and cutoff. The UI labels that number **Last verified value** and does not subtract current cash from it to invent a current invested amount. Current unknown cash, holdings or returns remain unknown.

`valuation_history` uses schema `observed-nav-v1`. Each point comes from a successful reconciliation receipt, the latest snapshot available at that receipt, and a full ledger replay restricted to that knowledge sequence and time. Later fills, amendments and action evidence cannot enter an earlier point. Points include both portfolio and SPY values, snapshot/reconciliation IDs and digests, exact underlying nano-dollar NAV where supported, held assets, cash and each required instrument's actual market/retrieval timestamps. Only held assets and SPY are required for valuation. Corporate-action comparison support is evaluated at the historical cutoff.

The full journal is read through the shared bounded keyset reader, rather than the latest 500-record UI journal. If full history cannot be read within its explicit bound, no partial valuation replay is presented. The chart shows the latest 200 successful reconciliation candidates and discloses truncation/omitted unverified observations. Repeated retries with the same snapshot and accounting evidence are deduplicated. Separate dots deliberately do not imply an interpolated continuous track record. An accessible table presents the latest 20 points.

These are observed marks, not official daily closes. A post-close IEX trade remains labeled with its actual timestamp; it is not relabeled as the closing auction. No daily volatility, annualization, cash yield or daily return statistics are inferred from these irregular observations. Existing unavailable risk metrics remain unavailable.

The state also distinguishes an expired session authorization from a recorded authorization awaiting runtime checks. Neither the read-only state nor the chart grants order permission.
