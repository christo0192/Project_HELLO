# Ashby webhook ingress + reconciliation (Wave 2, PR B)

Foundation for receiving Ashby webhooks and reconciling dropped signals. This
PR is **disabled by default** and performs **no live Ashby call, candidate
import, invitation, scorecard/stage mutation, resume fetch, or deployment**. It
provides the hardened ingress boundary, the durable dedup-safe receipt, the
reconciliation cursor, and the signal-processing decision logic — all gated
behind an explicit flag and a provisioned secret.

Depends on the 0029 schema (PR A) and the 0028 lease-safe queue.

## Components

| Concern | Module |
|---|---|
| Signature verification | `integrations/ashby/webhook-verify.ts` |
| Enablement + secret gating | `integrations/ashby/config.ts` |
| Payload extraction (defensive) | `integrations/ashby/extractors.ts` |
| Durable ingress orchestration | `integrations/ashby/ingress.ts` |
| HTTP route | `routes/ashby-webhook.ts` → `POST /api/integrations/ashby/webhook` |
| Reconciliation | `integrations/ashby/reconciliation.ts` |
| Signal worker (decision + leased runner) | `integrations/ashby/signal-worker.ts` |
| Persistence ports + Supabase adapters | `integrations/ashby/ports.ts`, `stores.ts` |
| Migration | `app/supabase/migrations/0030_ashby_webhook_reconciliation.sql` |

## Enablement (fail-closed)

The webhook route returns **503** and does nothing unless BOTH are set:

- `ASHBY_INTEGRATION_ENABLED=true`
- `ASHBY_WEBHOOK_SECRET=<per-webhook HMAC secret>` (≥ 16 chars, not `replace_me`)

The secret is loaded from the validated env-name contract only; it is **never
logged, printed, returned, or embedded in errors**. Disabled ⇒ no DB or network
call.

## Signature verification (the only trust boundary)

`Ashby-Signature: sha256=<64 lowercase hex>` is verified as **HMAC-SHA256 over
the exact raw request bytes**, before any JSON parsing. Strict single format;
constant-time compare on equal-length digests; bounded body (default 512 KiB).

Response mapping (fail-closed): missing → 401, malformed / empty / unparseable →
400, oversized → 413, mismatch → 403, disabled/no-secret → 503. A 4xx is
non-retryable (Ashby will not retry-storm); durable-ingress failure is **500**
(retryable — Ashby redelivers).

> **Tenant probe gate.** The canonical header name (`Ashby-Signature`), the
> `sha256=` envelope, and the raw-bytes MAC domain must be re-confirmed against
> the tenant's Ashby webhook configuration before enabling with production data.

## Durable ingress + transactional outbox

1. Verify signature → parse JSON.
2. Extract a sanitized signal (action + dedup identity + opaque ids). A
   `candidateStageChange` uses a **stage-centric dedup identity**
   `stage:<applicationId>:<stageId>` so retries and reconciliation converge.
3. `record_ashby_event_receipt` is a **transactional outbox**: in ONE
   transaction it inserts-or-noops the receipt on
   `(provider, webhook_action_id, action)` AND — for a stage-change trigger —
   ensures exactly one live signal job exists for the deterministic dedup key
   `ashby:signal:candidateStageChange:<stageId identity>`. Receipt and queue job
   commit or roll back together, so a durably-recorded trigger is always durably
   queued (**no receipt-then-enqueue strand — review F2**).
4. **Re-drive:** a duplicate delivery (or reconciliation) whose signal was never
   queued — or whose job was lost (DLQ'd) — re-inserts one job, unless durable
   work already exists (a live pending/active/delayed job, or a receipt the
   worker already drove to `processed`/`ignored`/`failed`). The route acks **200
   only when `work_pending`** is true; otherwise it returns a retryable **500**.
5. `applicationUpdate` is redundant (recorded, not enqueued); `candidateDelete`
   is **capability-gated off** (recorded, not enqueued — reconciliation is the
   safety net). Duplicate deliveries never create a second job.

Only a sanitized `{ source }` marker is stored as receipt metadata — never the
body, signature, secret, or contact data. The queue payload carries opaque ids
only.

## Signal worker (signal, not truth)

`processAshbySignal` re-reads authoritative `application.info` and validates the
**current** per-job AI screening stage of an **enabled** mapping before deciding.
Decisions are safe-state only — **no candidate/invite/session/Ashby mutation**:

- `import_eligible` — current stage IS the mapping AI stage (safe signal only).
- `stage_not_ai` — human/TA/other stage → **no import**.
- `mapping_inactive` — paused/drift/unknown mapping → no import.
- `self_echo` — our own write-back → dedup no-op.
- `ignored_action` / `capability_disabled` / `skipped_no_application`.

The leased runner (`runClaimedAshbySignal`) claims under an unguessable lease
and commits **only under the live matching lease**; a stale/reclaimed worker
cannot commit (0028 compare-and-set).

## Reconciliation (dropped-signal safety net)

`runReconciliation` pages `application.list` with the opaque incremental sync
token and, for each observed application, drives the **same transactional
outbox** the webhook uses — recording the stage receipt AND ensuring a live
signal job (**review F1: recovery restores processing, not just a receipt**). A
dropped webhook is recovered into processing on the next pass; already-covered
applications converge (the outbox creates no duplicate job), so a later webhook
still results in exactly one scheduled import. The worker re-reads authoritative
state and gates on mapping/stage, so enqueuing every observed application is
safe (non-AI-stage / paused / unknown → no-op).

- **Sync mode:** incremental with the stored token, unless the token is absent,
  the stream is `full_resync_required`, or the token is older than the **14-day**
  provider expiry → a safe full resync (`SYNC_TOKEN_MAX_AGE_MS`).
- **Bounds:** pages, items, wall-clock deadline; a repeated cursor (loop) aborts.
- **Checkpoint safety:** the opaque token advances **only after a fully drained,
  successful run**. A page/item cap, deadline, or mid-run failure never advances
  the cursor — the next run safely reprocesses (dedup makes it idempotent).

`advance_ashby_sync_checkpoint` / `mark_ashby_sync_full_resync` are the atomic
mutators; `ashby_sync_checkpoints` is service-role-only with the sync token
stored as an opaque black box (never logged).

## Security posture

- Route mounted **before recruiter auth** (HMAC is its boundary), still under the
  global per-IP limiter. Documented as a public route in the OpenAPI security
  model with an exact method+path allowlist entry.
- Migration 0030 is forward-only/additive; the new table has RLS enabled and no
  browser grants; every RPC is `SECURITY DEFINER` with a pinned `search_path`,
  revoked from anon/authenticated/public, granted to `service_role` only.
- Logs/errors/DB payloads carry no signature, secret, raw body, candidate
  contact, resume handle/URL, or sync token.

## Health / disabled detection

`describeAshbyConfig` returns `{ enabled, webhookSecretConfigured, active }`
booleans (never the secret) for health/metadata without any live-connectivity
claim. When `active` is false, the webhook is intentionally 503.

## Not in this PR (later work / go-live gates)

Real webhook registration/secret, tenant `application.info`/`list` calls against
production, candidate import creation beyond safe signal state, resume fetch,
invitation lifecycle, scorecard/stage saga, `candidateDelete` enablement, UI,
Plivo, and deployment. `candidateDelete` and local erasure policy remain
privacy/legal + tenant-probe gated.
