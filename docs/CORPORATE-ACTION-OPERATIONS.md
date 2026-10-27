# Staged corporate-action and activation operations

Use only after parent review and deployment of the exact paused candidate. These tool descriptions are an operating contract, not instructions to create records in production during development. Use actual retrieved evidence and actual independent authored reviews. Never copy test fixtures.

## Corporate actions

Authenticated MCP tool `corporate_actions` takes `{operation,input}`:

- `collect`: input `{idempotency_key,start,end}` with YYYY-MM-DD **process-date** range. Retains all action types, all quality levels, pages and failed receipts. No accounting inference.
- `record`: input `{idempotency_key,kind,payload}`. Kinds are `action_source`, `action_review`, `coverage_review`. Sources require approved symbol, HTTPS primary issuer URL, actual `observed_at`, excerpt and full-document `content_sha256`; action corroboration also includes exact normalized `terms`. Reviews require `author`, `status` (approved/rejected), and exact canonical `binding`.
- `confirm`: input `{action_id,raw_event_id,source_id,review_ids}`. The two selected reviews must be distinct authors and approve the identical raw/source/terms binding. The confirmation operation is distinct from both reviewers. It appends a stable action-confirmed event.
- `coverage`: input `{idempotency_key,payload}` with `date`, policy `ordinary-cash-and-whole-splits-v1`, `fetch_id`, `source_ids` (all three issuers), `action_ids` (complete acquired inventory), two `review_ids`, and `status:'approved'`. Validates observed source freshness, range coverage, complete pages, confirmations and review bindings before append.
- `settle`: no input. Appends deterministic due entitlement/payment/split phases for the opened experiment, under the execution lease. Does not place orders, adjust broker cash, or initialize capital. Repeating it is idempotent.
- `status`: read-only coverage result and specific blockers.

Canonical JSON recursively sorts object keys and preserves array order (`lib/store.js canonical`). An action-review binding is the canonical JSON of `{action_id,raw_event_id,raw_signature,source_id,source_digest,terms}`. `raw_signature` is canonical `{type,raw}`; `source_digest` is the saved issuer receipt's digest. Normalized terms are produced by `normalizeAction` in `lib/action-ledger.js`. Do not guess terms absent from issuer/raw evidence. Coverage-review binding is canonical `{date,policy,fetch_id,source_ids,action_ids}`. A later rejection, changed version, new source evidence or unresolved notice invalidates readiness.

## Release and activation

`stage_release_attestation` accepts `{idempotency_key,kind,payload}` for `launch_approval` or `release_verification`. It stages metadata only. Payload includes `status:'approved'`, `mandate_version:1`, exact deployed `revision`, and existing passing `evidence_ids`. Launch approval additionally requires the actual `authorization_reference`. Release verification additionally maps each required check to its existing measured verification ID:

`private_hosting`, `persistent_readback`, `unattended_auth`, `nonzero_fill_settlement`, `partial_fill_retry`, `corporate_action_reconciliation`, `prospective_inception`, `runtime_asset_metadata`.

Each measured verification has `outcome:'passed'`, exact `check` and matching `revision`, in addition to ordinary verification title/summary/author. The code validates linkage and content structure; reviewers must establish that each claim is true. Synthetic tests do not establish actual broker or hosted behavior.

`activation_readiness({snapshot_id})` is read-only. It reports unmet prerequisites and always reports the hard-disabled gate in this candidate. `activate_experiment({idempotency_key})` also remains hard-disabled; neither environment flags nor attestations override that code gate. The tested private engine performs a fresh GET-only observation/reconciliation and writes a single prospective opening/control/benchmark event atomically. There is no backdating option. Never remove the gate solely to make a test or conditional approval pass.

The new source must not be routinely redeployed for data updates. After an approved release, use persistent tools and readback. Existing schedule and universe remain unchanged.
