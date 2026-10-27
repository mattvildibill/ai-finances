# Prospective universe admission — preparation candidate

This implementation does not admit IJR, publish a release, change the live mandate, or authorize an order. Version 1 remains AAPL/MSFT/SPY. Source-controlled version 2 adds only IJR as a candidate diversified equity ETF, retaining every risk limit and the SPY comparator. No caller can supply an arbitrary instrument list.

## Actual operating sequence

1. Independently review and publish the exact preparation release through the existing owner workflow. Preserve original records, opening, cash, source bindings and flags. This document is not that approval.
2. Complete and reconcile the original one-share SPY validation first. Admission checks its original protocol, raw receipts, exact accounted fill, closure and successful reconciliation. An acknowledgment or synthetic test is insufficient.
3. Use authenticated `universe_admission` operation `inspect`, `configuration_version: 2`, and a new `idempotency_key`. This uses fixed Alpaca GET endpoints with existing server-side credentials, collecting all four assets' actual metadata, quotes, clock, account and positions. It records `universe_observation`, not an active market snapshot. Candidate data alone grants no trading permission.
4. Collect actual four-symbol corporate-action inventory and actual primary evidence. Explicitly select `configuration_version: 2` for candidate acquisition, source/review/confirmation/coverage operations. Reviews must inspect the new exact bindings. Existing three-symbol approvals are not expanded. Candidate-only IJR facts do not change version 1; shared-symbol adverse facts and acquisition failures remain visible to version 1. Finish shared source acquisition before registering simultaneous current v1/v2 coverage.
5. Record distinct authored research, challenge and manager hold decision, then obtain the exact candidate binding and two distinct independent verification reviews. The manager must explicitly approve admission and the fund-treatment interpretation; an ordinary hold or favorable research is insufficient.
6. With no unresolved intents/open orders, fresh account agreement, current expanded coverage and fresh successful reconciliation, stage the immutable amendment. Evidence is rechecked after asynchronous work, under the execution lease and journal-head fence. The database clock also enforces the earliest account/reconciliation/clock/asset/quote freshness deadline at insertion. The server supplies the prospective effective timestamp; no backdating or historical rewriting.
7. Reconcile after amendment. Obtain separately approved version 2 rollout authorization with the usual eight exact-release prerequisites and actual pilot-outcome reviews. An existing v1 rollout requires an explicit successor referencing its ID; the original session, pilot and expiry cannot be extended. Every subsequent decision must reference the amendment/configuration hash. Fresh execution checks remain mandatory.

## Typed records and bindings

`universe_admission` operations are `status`, `inspect`, `review_candidate`, `stage`. They use existing private authentication and body limits. None submits an order.

Inspection input: `{operation:"inspect", input:{configuration_version:2, idempotency_key}}`.
Candidate input: `{operation:"review_candidate", input:{decision_id, observation_id, coverage_id}}`.

Research, challenge and manager payloads all bind `configuration_version:2`, `configuration_hash` (SHA-256 of canonical source-controlled policy), exact `revision`, `observation_id`, and `coverage_id`, in addition to their existing authored fields. The manager decision is `action:"hold", size:0, symbol:"IJR", admission_approval:true`, with a real `authorization_reference` and:

```json
{"fund_treatment":{"classification":"unleveraged_noninverse_diversified_equity_etf","account_permissions_unchanged":true,"incidental_instruments_assessment":"Actual reviewed assessment required, not this placeholder"}}
```

The exact canonical binding includes configuration text/hash, original version, new mandate version, release revision, manager/authorization/fund treatment, evidence IDs and immutable record digests. Two verification records use `check:"universe_admission_review"`, `outcome:"passed"`, distinct actual `author`, `revision`, exact canonical `binding`, and truthful `summary`. A failed/pending review for that binding blocks authorization.

Stage input: `{operation:"stage", input:{idempotency_key, payload:{status:"approved", decision_id, observation_id, coverage_id, binding, review_ids:[idA,idB]}}}`. The append-only `mandate_amendment` includes the canonical binding, request hash and server effective timestamp. Identical retries return the receipt; a second transition is rejected.

V2 corporate-action receipts use `configuration_version`, canonical `configuration`, and `configuration_digest`. The name `configuration_digest` in action receipts and `configuration_hash` in admission/decision records both identify SHA-256 of the same canonical policy. V2 action/coverage review bindings include their version/configuration; original v1 bindings remain unchanged.

New v2 buy/sell decisions and durable intents include `configuration_version:2`, `configuration_hash`, and `amendment_id`. Historical v1 intents retain their original universe. Replay selects the policy effective at observation time, preserving earlier holdings, receipts, benchmark and entitlements.

## Fund interpretation and evidence still pending

The actual IJR research supplied by the parent describes equity plus swaps, warrants, collateral, futures and money-market holdings; the prospectus permits sampling, derivatives and securities lending. Do not describe the fund as holding only stocks or no derivatives. Incidental fund instruments do not themselves establish a leveraged/inverse product, but that distinction needs explicit manager interpretation and independent review in the prospective amendment. Account-level borrowing, options, shorts and leveraged/inverse ETF prohibitions remain unchanged. This code has not established IJR suitability, current broker eligibility or actual source coverage.

Only the exact official IJR product-page URL is newly allowed for typed primary source evidence. Other parent-identified document URLs are research provenance, not automatically approved typed source URLs. Do not pair a document hash with a different landing-page URL. No actual raw research captures from the parent workspace are assumed present here; no hash, dividend entitlement or absence finding is invented.

## Preserved limits and bounded limitations

The one-share pilot remains version 1. Rollout remains capped at $10,000 cumulative purchases including the pilot and outstanding/ambiguous commitments, with $90,000 uncommitted cash. Sales never replenish the cumulative allowance. Stock/ETF/order/gross/cash caps and exact nano-dollar accounting remain unchanged. Admission cannot reset inception, permit a second pilot, enlarge the opening cap, or enable general trading.

The single v1-to-v2 amendment is bound to its exact reviewed release. A later release revision blocks v2 execution until a separately reviewed re-attestation mechanism is implemented; this candidate does not pretend ordinary upgrades automatically inherit authorization. Accounting and GET-only recovery remain available; a withdrawn admission review does not erase held assets or revert history.

No migration is required. Actual IJR admission, release publication, runtime source evidence, authored approval, and real IJR fills are untested/not performed by this preparation work. Synthetic tests verify mechanisms, not those external facts.
