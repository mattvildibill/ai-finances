# Supervised opening rollout proposal

This is a prospective, bounded extension after the actual one-share SPY pilot. User authorization `Sentinel_fcfb4545f0d08191aff52c9996d911dd` requested iterative opening-session checks and small simulated investments; the manager chose the lower $10,000 ceiling. It does not alter the existing security universe or ordinary risk caps. Implementation alone does not authorize an order.

## Controls and accounting

`ROLLOUT_ENABLED` defaults off and is separate from `VALIDATION_ENABLED`. General execution remains hard-disabled. This route permits purchases only, for the original opening's New York calendar date, until a reviewed explicit expiry no later than regular-session close. There is one immutable rollout approval; no replacement, budget reset, second inception or cash reset.

The hard ceiling is $10,000 of cumulative actual purchase principal plus unresolved buy commitments, including the pilot. Whole-share fills use their exact raw broker price, represented in integer nano-dollars. An unfilled commitment reserves remaining shares times the greater of the original observed mark and limit. Unused commitment is released only after a matching actual terminal broker receipt, exact fill accounting and closure. Ambiguous or unmatched activity blocks further purchases. Sale proceeds never reduce cumulative purchases. No fees or unsupported fractional quantities are silently ignored.

Before each new intent and again immediately before submission, the new order reserves quantity times max(fresh mark, limit). Existing commitments plus that reservation must leave at least $90,000 of uncommitted operational broker cash. Modeled distributions do not count as spendable cash. Existing position, order, gross exposure and minimum-cash checks still apply, including fresh positive marks for every holding. The current no-open-orders guard is stricter than the cumulative reservation calculation: further buys wait for reconciliation.

## Required sequence

1. Keep the currently reviewed pilot release stable while obtaining its real outcome. An unfilled, canceled or ambiguous pilot does not graduate. It is reconciled without creating a replacement order or inventing a fill.
2. After one actual whole SPY share fills, refresh and reconcile. Preserve the original opening, benchmark, old release authorization, intent, raw activity, fill, broker terminal receipt and reconciliation.
3. Obtain `opening_rollout` operation `review_candidate` with `input: {pilot_intent_id, reconciliation_id}`. It returns a canonical `binding` string and SHA-256 over the exact immutable historical evidence. Historical proof may remain valid after the original decision expires; current account and market observations must still be fresh.
4. Two distinct reviewers independently inspect that actual outcome, then append ordinary `verification` records with `check: "pilot_outcome_review"`, `outcome: "passed"`, the new exact rollout `revision`, exact canonical `pilot_binding`, distinct `author`, and truthful `summary`. They must be distinct from the approving manager. Failed or withdrawn evidence blocks graduation. Isolated partial-fill tests are not represented as observed partial fills.
5. Independently review and publish the rollout release only with parent approval. Obtain genuine new-revision verification records for all eight `VALIDATION_CHECKS`: private hosting, persistence/readback, cloud authentication, corporate-action reconciliation, runtime asset metadata, independent code review, isolated accounting safeguards and primary-action scan. Cloud authentication does not assert timer-triggered success. Retain current-day source coverage qualifications.
6. With fresh successful account reconciliation, current source coverage and a fresh regular-session snapshot, stage the single approval using the schema below. Enable only the separate bounded rollout setting through the supported release workflow after parent approval; neither staging nor enablement submits an order.
7. Author a new evidence-linked research/challenge/manager buy decision after approval, using an actual fresh limit and expiry. Execute via the bounded route. Every request rechecks exact release, approval, account, asset, session, cash, inventory, source coverage and risk. The existing lease serializes requests and the durable intent prevents a second POST on retry. Ambiguous results permit GET-only lookup/reconciliation.
8. Reconcile every actual outcome before considering another investment. Stop at expiry, any failed guard, unavailable evidence, or the cumulative cap. Further sessions or broader general trading require a separately reviewed protocol; this implementation does not silently extend permission.

## Typed approval payload

`opening_rollout` operation `stage` takes `input: {idempotency_key, payload}`. Payload fields are:

```json
{
  "protocol_version": 1,
  "mandate_version": 1,
  "status": "approved",
  "revision": "<exact independently reviewed deployed 40-character commit>",
  "authorization_reference": "Sentinel_fcfb4545f0d08191aff52c9996d911dd",
  "author": "<actual approving manager>",
  "general_trading_enabled": false,
  "session_date": "<original opening's current New York date>",
  "valid_until": "<explicit timestamp no later than regular close>",
  "pilot_intent_id": "<actual pilot intent>",
  "reconciliation_id": "<actual successful pilot reconciliation>",
  "pilot_binding": "<exact canonical binding returned by review_candidate>",
  "review_ids": ["<actual independent review A>", "<actual independent review B>"],
  "checks": {"<each VALIDATION_CHECKS name>": "<actual revision-bound verification id>"},
  "limits": {
    "cumulative_purchase_cap_cents": 1000000,
    "minimum_uncommitted_cash_cents": 9000000,
    "include_pilot": true,
    "recycle_sales": false,
    "buy_only": true
  }
}
```

`execute` takes `input: {decision_id}`; `status` is read-only. Placeholders above are schema documentation, never executable authorizations. A status display or successful staging is not a claim that the next order will pass its checks.

## Deployment boundary

This proposal requires no database migration and no historical record rewrite. It reuses the existing shared execution lease, append-only journal and exact accounting. It does not expand AAPL/MSFT/SPY, add credentials, change automation, bypass paper-only endpoints or enable general autonomous trading. Source and authorization checks fail closed; the bounded full-history reader also refuses truncated history beyond its processing limit.
