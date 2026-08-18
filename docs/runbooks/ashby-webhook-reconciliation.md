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
token and, for each **admitted** application, drives the **same transactional
outbox** the webhook uses — recording the stage receipt AND ensuring a live
signal job (**review F1: recovery restores processing, not just a receipt**). A
dropped webhook is recovered into processing on the next pass; already-covered
applications converge (the outbox creates no duplicate job), so a later webhook
still results in exactly one scheduled import.

### Admission (0033 — tenant-wide signal-storm guard)

**Production evidence.** The first runtime reconciliation pass, against a tenant
whose only mapping was **paused**, created exactly **2,000 pending
`ashby.signal` jobs** and zero links, operations, or imports. The pass recorded
a receipt and enqueued a signal for *every* application it observed; the
mapping/stage gate only ran later, inside the worker — after a tenant-wide
fan-out had already been durably queued. Runtime was set false immediately;
the integration flag stayed true.

Admission now happens **before any receipt write or enqueue**. An
`application.list` row is admitted **only** when it positively exposes a job id
**and** a current stage id, that job id matches an **ENABLED** mapping, and that
stage id equals the mapping's configured AI screening stage. Everything else is
skipped and touches nothing:

| Skip reason | Meaning |
| --- | --- |
| `noApplicationId` | no usable application id on the row |
| `missingFields` | job id and/or current stage id absent or unreadable |
| `noEnabledMapping` | the job is unmapped, paused, or drifted |
| `stageNotAi` | mapped and enabled, but the row is at another stage |
| `ambiguousMapping` | the index held conflicting AI stages for that job |

Properties that matter operationally:

- **Zero-cost skips.** With no enabled mapping, a pass over thousands of
  applications writes **zero** receipts, enqueues **zero** jobs, and issues
  **zero** `application.info` calls.
- **One bounded query per run.** The enabled-mapping index is loaded once per
  pass (`DEFAULT_MAX_ENABLED_MAPPINGS = 2000`), not once per application, and is
  **never cached across runs** — a pause, a drift auto-pause, or a stage-id edit
  lands on the very next pass. A tenant exceeding the bound sets
  `mappingIndexTruncated` and logs
  `ashby_reconcile_mapping_index_truncated` rather than under-admitting quietly.
- **A pre-filter, not an authority.** The signal worker still re-reads
  `application.info` authoritatively and re-applies the mapping/stage gate, so
  an admitted-but-stale row (human moved the candidate on; mapping paused in the
  interim) is still rejected downstream. Admission can only ever produce *less*
  work, never more.

### Forced resync when a mapping is enabled

With admission in place, an application that reached the trigger stage while its
mapping was paused is correctly skipped — and an incremental cursor would never
show it again. So `upsert_ashby_job_mapping` forces the `application.list`
checkpoint to `full_resync_required` **in the same transaction as the mapping
write** whenever the write *opens* admission:

| Mapping write | Forces resync? |
| --- | --- |
| created **enabled** with an AI stage | yes |
| paused/drift → **enabled** | yes |
| enabled, AI stage **repointed** | yes |
| enabled, AI stage unchanged (relabel, delivery mode, owner) | no |
| enabled → **paused** | no (admission only narrows) |

Either both the mapping write and the forced resync land, or neither does: a
mapping can never become enabled while the cursor still hides the applications
it admits.

A `resync_epoch` counter closes the race where a run *already paging* would
clear a resync raised mid-run: `begin_ashby_sync_run` returns the epoch, the run
hands it back to `advance_ashby_sync_checkpoint`, and a mismatch means the
cursor advances while `full_resync_required` **stands** for the next pass.

### Counters

Each completed pass publishes a truthful `observed → admitted → skipped` triple
through `AshbyWorkers.lastReconcilePass()` (counters and sanitized codes only —
no application, job, stage, candidate, or tenant identifier). The invariant
`observed === admitted + sum(skipped)` always holds. The pass also emits one
allowlisted `ashby_reconcile_pass` log line; the counters themselves are not
pushed through the shared logger, whose metadata allowlist is mirrored in the
Python voice service and is deliberately not widened for one integration.

- **Sync mode:** incremental with the stored token, unless the token is absent,
  the stream is `full_resync_required`, or the token is older than the **14-day**
  provider expiry → a safe full resync (`SYNC_TOKEN_MAX_AGE_MS`).
- **Bounds:** pages, items, wall-clock deadline; a repeated cursor (loop) aborts.
  Skipped rows still count against the item cap, so paging stays bounded.
- **Checkpoint safety:** the opaque token advances **only after a fully drained,
  successful run**. A page/item cap, deadline, or mid-run failure never advances
  the cursor — the next run safely reprocesses (dedup makes it idempotent).
- **Progress semantics:** a pass that observed thousands of applications and
  admitted none counts as **idle**, not busy, so the scheduler does not spin.

`advance_ashby_sync_checkpoint` / `mark_ashby_sync_full_resync` are the atomic
mutators; `ashby_sync_checkpoints` is service-role-only with the sync token
stored as an opaque black box (never logged).

### One-time cleanup of the pre-fix storm backlog

The 2,000 pending `ashby.signal` jobs and their reconcile receipts predate
admission. They are **not** dangerous while `ASHBY_RUNTIME_ENABLED=false` (no
worker claims them), and processing them under the fixed worker would be a
no-op — but they distort backlog health and would all be claimed at once the
moment runtime is turned on. Delete them deliberately, not incidentally.

**This procedure is documented, not executed, and contains no tenant ids.**
Run it manually, as service_role, against the target project.

Preconditions — verify **all** of them first, and stop if any fails:

1. `ASHBY_RUNTIME_ENABLED` is **false** (no worker is running).
2. `select count(*) from screening_v2.ashby_application_links;` returns **0** —
   nothing was imported, so no job is tied to real work.
3. `select count(*) from screening_v2.ashby_operations;` returns **0**.
4. The pending jobs are all reconcile-generated:
   `select count(*) from screening_v2.job_queue where name = 'ashby.signal' and status = 'pending';`
   matches the receipt count in step 5.
5. `select count(*) from screening_v2.ashby_event_receipts where metadata->>'source' = 'reconcile';`

Then, in ONE transaction:

```sql
begin;
-- Only pending, never claimed/leased work, and only the signal queue.
delete from screening_v2.job_queue
 where name = 'ashby.signal'
   and status = 'pending'
   and lease_expires_at is null;

-- Only receipts this reconciliation path created. `record_ashby_event_receipt`
-- writes metadata on INSERT only (`on conflict do nothing`), so this marker
-- identifies exactly the rows reconciliation inserted; webhook receipts are
-- evidence of real deliveries and are KEPT.
delete from screening_v2.ashby_event_receipts
 where metadata->>'source' = 'reconcile';

-- Force the next pass to be a full sweep so nothing is missed afterwards.
select screening_v2.mark_ashby_sync_full_resync('application.list', 'post_cleanup');
-- Review the row counts, THEN commit (or rollback).
commit;
```

After cleanup, enabling a mapping forces its own full resync (0033), so the
backlog is rebuilt correctly and only for applications that genuinely match an
enabled mapping's AI stage.

## Security posture

- Route mounted **before recruiter auth** (HMAC is its boundary), still under the
  global per-IP limiter. Documented as a public route in the OpenAPI security
  model with an exact method+path allowlist entry.
- Migrations 0030 and 0033 are forward-only/additive; the new table has RLS
  enabled and no browser grants; every RPC is `SECURITY DEFINER` with a pinned
  `search_path`, revoked from anon/authenticated/public, granted to
  `service_role` only. 0033 adds one `NOT NULL DEFAULT 0` column
  (`resync_epoch`), replaces four functions, and drops only the superseded
  six-argument `advance_ashby_sync_checkpoint` overload — which would otherwise
  stay callable and bypass the epoch guard.
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
