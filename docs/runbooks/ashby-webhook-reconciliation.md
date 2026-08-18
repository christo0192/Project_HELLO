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
| `noEnabledMapping` | the job is unmapped, paused, or drifted |
| `stageNotAi` | mapped and enabled, but the row is at another stage |
| `ambiguousMapping` | the index held conflicting AI stages for that job |

Rows with an application id but **no readable job or stage id** are *not*
skipped — they are admitted fail-open and counted as `unclassified` (see the
schema-drift abort below).

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
show it again. So **both** mapping-write entry points force the
`application.list` checkpoint to `full_resync_required` **in the same
transaction as the write** whenever it *opens* admission:

- `set_ashby_mapping_status` — what `POST /mappings/:id/resume` in Mission
  Control actually calls. This is the operator's real resume path; hooking only
  the upsert would have left it with no backfill at all.
- `upsert_ashby_job_mapping` — admin create/update.

| Mapping write | Forces resync? |
| --- | --- |
| created **enabled** with an AI stage | yes |
| paused/drift → **enabled** | yes |
| enabled, AI stage **repointed** | yes |
| enabled, AI stage unchanged (relabel, delivery mode, owner) | no |
| enabled → **paused** | no (admission only narrows) |
| enable refused (incomplete/drifted) | no — the checkpoint is untouched |

Either both the mapping write and the forced resync land, or neither does: a
mapping can never become enabled while the cursor still hides the applications
it admits.

A `resync_epoch` counter closes the race where a run *already paging* would
clear a resync raised mid-run: `begin_ashby_sync_run` returns the epoch, the run
hands it back to `advance_ashby_sync_checkpoint`, and a mismatch means the
cursor advances while `full_resync_required` **stands** for the next pass.

### Counters

**What is observable today, and where.** Be precise about this — the difference
decides whether a gate below is executable.

| Signal | Where it actually lands | Usable now? |
| --- | --- | --- |
| `reconcile` object on Mission Control `GET /health` | HTTP, interviewer+ | **yes** — the primary gate |
| `warn` logs: `ashby_reconcile_aborted` (`enqueue_cap` / `unclassified_cap`), `ashby_reconcile_mapping_index_truncated` | app logs | **yes** |
| `reconcileNoProgressRuns`, `reconcileLastSuccessAt` on `GET /health` | HTTP, from the DB | **yes** — fleet-wide |
| DB verify queries (below) | psql | **yes** — fleet-wide |
| `ashby_reconcile_*` counters via `lib/metrics.ts` | **a no-op sink** | **no** — see below |

`runReconciliation` emits `ashby_reconcile_observed`, `_admitted`, `_enqueued`,
`_unclassified`, `_skipped_mapping`, `_skipped_stage`, `_skipped_ambiguous`,
`_skipped_no_application`, and `_mapping_index_truncated`. **These are wired but
not yet collected:** there is no production `setMetricSink` caller in this
deployment, so `counter()` reaches `NOOP_SINK` and a debug log line carrying
only the metric name. They become the alerting path the moment a sink is
installed — **do not write an alert against them today and assume it fires.**

Because of that, the counts are also published to the health surface, which is
a real consumer: every non-`locked` pass calls `publishReconcilePass(...)`, and
Mission Control `GET /health` returns them as `reconcile` (null when *this
process* has run no pass — never a fleet-wide claim, and never a claim that no
reconciliation happened). Counts and sanitized codes only; no application, job,
stage, candidate, mapping, or tenant identifier appears there. In-process,
`AshbyWorkers.lastReconcilePass()` exposes the same snapshot.

The invariant `observed === admitted + sum(skipped)` holds on any pass that
reached a normal stop and is asserted in tests; on an **aborted** pass
(`enqueue_cap` / `unclassified_cap`) the row that tripped the bound is observed
but neither admitted nor skipped, and is reconsidered next pass.

Log lines carry only allowlisted fields — the repo logger's metadata allowlist
is mirrored in the Python voice service and is deliberately not widened.

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

### Terminal vs conditional verdicts (B2)

`record_ashby_event_receipt` treats a `processed | ignored | failed` receipt as
"durable work is done" and refuses to re-drive. Because the receipt identity is
stage-centric (`stage:<application>:<stage>`), a terminal status **permanently
poisons that exact application-at-stage** — no future signal for it can ever be
enqueued again.

| Verdict | "No" is… | Receipt |
| --- | --- | --- |
| `ignored_action` | permanent (wrong action) | `ignored` |
| `capability_disabled` | permanent (gate off by design) | `ignored` |
| `self_echo` | permanent (our own write-back) | `ignored` |
| `import_eligible` | n/a — work done | `processed` |
| **`mapping_inactive`** | **reversible** — enable the mapping | **left `received`** |
| **`stage_not_ai`** | **reversible** — move the candidate in | **left `received`** |

Terminalising the two conditional verdicts is what made "enable a mapping after
the runtime has run" silently and permanently blind: no error, no DLQ, no
failed operation, just candidates that are never screened. Leaving them
non-terminal is safe **only in combination with admission** — without it,
reconciliation would re-observe and re-drive every non-admitted application
every pass.

### Circuit breaker and schema-drift abort

- **`maxEnqueuePerRun`** (default 200, hard max 2000): the most signal jobs one
  pass may create. Tripping it stops the run with `stop: 'enqueue_cap'` and does
  **not** advance the cursor, so any future admission-logic error is bounded at
  N jobs and becomes visible via a climbing `no_progress_runs` instead of
  another 2,000-row incident. A just-enabled mapping's first sweep may
  legitimately trip it and simply continues on the next pass.
- **`maxUnclassified`** (default 50): rows carrying an application id but no
  readable job or stage id are admitted **fail-open** (silently dropping 100% of
  real work on a provider schema change is worse than the storm) and counted.
  Exceeding the bound stops the run with `stop: 'unclassified_cap'`, does not
  advance, and flags the stream `list_schema_unclassified` — loud and bounded in
  both directions.

#### Reading `no_progress_runs` correctly

Neither cap advances the cursor, so **both make `no_progress_runs` climb** — the
same counter diagnostic 1a reads as "every run is re-storming". A newly enabled
mapping with more than 200 parked candidates legitimately trips the breaker for
several consecutive passes, which is exactly when an operator is watching that
number during re-activation. Discriminate before concluding anything:

| `stop` | `enqueued` | `no_progress_runs` | Reading |
| --- | --- | --- | --- |
| `enqueue_cap` | **> 0** | climbing | **Healthy backlog draining.** Each pass converts 200 more parked applications into work. Expect it to end. |
| `item_cap` / `page_cap` / `deadline` | 0 | climbing | **Stuck** — the corpus cannot drain in one run. See the corpus precondition below. |
| `unclassified_cap` | any | climbing | **Provider schema drift.** Investigate the list shape; it will not self-heal. |
| `drained` | any | resets to 0 | Normal. |

The fast confirmation is that work is actually moving: `enqueued > 0` on the
health `reconcile` object, or a shrinking `pending` count for `ashby.signal` in
diagnostic 1b across two passes. `no_progress_runs` climbing **with
`enqueued = 0`** is the genuine stuck case.

### One-time cleanup of the pre-fix storm backlog

The 2,000 pending `ashby.signal` jobs and their reconcile receipts predate
admission. **Do not run this before the code above is deployed.** Cleaning up
against the old code means the next boot with `ASHBY_RUNTIME_ENABLED=true`
reproduces the storm from a clean slate — and this time terminalises 2,000
receipts, making every affected candidate permanently unrecoverable (B2).

**This procedure is documented, not executed, and contains no tenant ids.** Run
it manually as `service_role`. **Precondition:** `ASHBY_RUNTIME_ENABLED` is
false fleet-wide, with no live scheduler and no lease holder.

#### 1. Diagnose first (read-only)

```sql
-- (a) Is the stream STUCK? no_progress_runs > 0 with a null last_success_at
--     means every run is re-storming, not that this was one-shot.
select checkpoint_key, status, (sync_token is not null) as has_token,
       token_issued_at, last_success_at, last_full_sync_at,
       pages_last_run, items_last_run, no_progress_runs,
       (lease_owner is not null) as lease_held, lease_expires_at
  from screening_v2.ashby_sync_checkpoints
 where provider = 'ashby';

-- (b) Storm inventory by queue and status.
select name, status, count(*)
  from screening_v2.job_queue
 where name in ('ashby.signal','ashby.import','ashby.ingestion')
 group by 1,2 order by 1,2;

-- (c) Receipt inventory by origin marker and processing status.
select coalesce(metadata->>'source','(none)') as source, status,
       count(*) filter (where application_link_id is null)     as unbound,
       count(*) filter (where application_link_id is not null) as bound,
       count(*) as total
  from screening_v2.ashby_event_receipts
 where provider = 'ashby'
 group by 1,2 order by 1,2;

-- (d) Confirm the "zero real work" claim BEFORE deleting anything.
select (select count(*) from screening_v2.ashby_application_links) as links,
       (select count(*) from screening_v2.ashby_resume_ingestions) as ingestions,
       (select count(*) from screening_v2.ashby_operations)        as operations,
       (select count(*) from screening_v2.job_dlq
         where name like 'ashby.%')                                as ashby_dlq;
```

**Stop and reassess** if (c) shows any `source = 'webhook'` rows, or (d) shows
non-zero links/ingestions/operations — the cleanup below assumes the storm
produced no downstream work. Note the `source` marker is **not** fully
authoritative: `record_ashby_event_receipt` writes metadata on INSERT only
(`on conflict do nothing`), so a genuine webhook that arrived *after* a reconcile
receipt is still labelled `reconcile`. `application_link_id is null` is the
safer secondary guard, since a receipt bound to real downstream work is never
storm debris — both predicates are used below.

#### 2. Neutralise (single transaction, idempotent)

```sql
begin;

-- Guard: never run while anything holds a lease or a job is active.
do $$
begin
  if exists (select 1 from screening_v2.job_queue
              where name in ('ashby.signal','ashby.import','ashby.ingestion')
                and status = 'active') then
    raise exception 'active_ashby_jobs_present';
  end if;
  if exists (select 1 from screening_v2.ashby_sync_checkpoints
              where provider = 'ashby' and lease_expires_at > now()) then
    raise exception 'reconcile_lease_held';
  end if;
end $$;

-- A. Neutralise ONLY the signal jobs whose receipt is reconcile-originated and
--    unbound. 'failed' (not 'completed') is the truthful terminal state: the
--    work was cancelled administratively, never performed. The partial unique
--    index uq_job_queue_dedup_active excludes 'failed', so the dedup key is
--    released and a legitimate future signal can re-enqueue.
with reconcile_keys as (
  select 'ashby:signal:' || r.action || ':' || r.webhook_action_id as dedup_key
    from screening_v2.ashby_event_receipts r
   where r.provider = 'ashby'
     and r.metadata->>'source' = 'reconcile'
     and r.application_link_id is null
)
update screening_v2.job_queue q
   set status = 'failed',
       failed_at = now(),
       error_message = 'reconcile_storm_cleanup'
 where q.name = 'ashby.signal'
   and q.status in ('pending','delayed')
   and q.dedup_key in (select dedup_key from reconcile_keys);

-- B. DELETE the reconcile-only receipts. Deleting rather than terminalising is
--    deliberate: a terminal receipt is exactly what would make the affected
--    applications permanently unrecoverable (B2). Webhook-sourced and
--    link-bound receipts are untouched by the predicate.
delete from screening_v2.ashby_event_receipts
 where provider = 'ashby'
   and metadata->>'source' = 'reconcile'
   and application_link_id is null
   and status in ('received','ignored');

-- C. Reset the stream so the FIRST run after the repair is a clean full pass
--    (which, with admission in place, writes only real work).
select screening_v2.mark_ashby_sync_full_resync('application.list', 'post_storm_reset');

-- Review the row counts, THEN commit (or rollback).
commit;
```

#### 3. Verify

```sql
select name, status, count(*) from screening_v2.job_queue
 where name like 'ashby.%' group by 1,2 order by 1,2;
-- expect: no pending/delayed ashby.signal

select count(*) from screening_v2.ashby_event_receipts
 where provider = 'ashby' and metadata->>'source' = 'reconcile';
-- expect: 0

select status, (sync_token is null) as token_cleared, full_resync_reason, no_progress_runs
  from screening_v2.ashby_sync_checkpoints where provider = 'ashby';
-- expect: full_resync_required, true, 'post_storm_reset'
```

Do **not** delete the checkpoint row to "start fresh" — that discards the
`full_resync_required` and epoch state the repair depends on. Use
`mark_ashby_sync_full_resync`.

### Corpus-size precondition (a hard gate, check this first)

A forced full resync must drain in **one run** or the cursor never advances. The
per-run bounds are `maxItems 5000`, `maxPages 50 × pageLimit 100 = 5000`, and
`deadlineMs 60000`, and the checkpoint advances only on `stop: 'drained'`.

A tenant whose **total application corpus exceeds ~5,000** therefore ends every
full sweep on `item_cap`/`page_cap`, never advances, never establishes an
incremental token, and re-pages the same prefix on every tick. This is
pre-existing, but this PR makes it *reachable by ordinary operator actions*:
before, a full sweep happened only on 14-day token expiry; now **every mapping
enable, resume, or AI-stage repoint forces one**.

It fails quiet and cheap rather than loud — admission means the stuck stream
creates no work — so reconciliation simply stops being a dropped-webhook safety
net for that tenant. Webhook delivery is unaffected.

> **Gate:** before enabling any mapping on a tenant, confirm the corpus is
> comfortably below the item/page bound. If it is not, do **not** enable —
> land page-anchored partial checkpointing first.

Measure it from the provider side (the count of applications `application.list`
would page, not the count of rows we hold — we hold none before activation).
After a first pass, the same fact is readable from the health surface:
`reconcile.observed` at or above 5000 with `advanced: false` and a `stop` of
`item_cap`/`page_cap` **is** the stuck state.

The observed canary corpus was ~2,000, comfortably under the bound.

### Re-activation sequence

Only after the above is deployed, applied, and cleaned up. Every gate below is
executable as written — each names the exact surface it is read from.

1. Confirm `ASHBY_RUNTIME_ENABLED=false` fleet-wide and no lease holder (§1a).
2. Deploy this code with the flag still false — `createAshbyRuntime` returns
   null, so it is a genuine no-op deploy.
3. Apply migration 0033 (verified against a real Docker `0001→0033` run).
4. Execute the cleanup and verify it.
5. Confirm the **corpus precondition** above.
6. Keep **every mapping paused**. Enable the runtime on **one** machine with a
   conservative `ASHBY_RECONCILE_INTERVAL_MS`.
7. Observe one full reconcile cycle, then read the gate from Mission Control:

   ```bash
   curl -sS -H "Authorization: Bearer $TOKEN" \
     "$API/api/integrations/ashby/mission-control/health" \
   | jq '{status, reconcile, noProgress: .backlog.reconcileNoProgressRuns}'
   ```

   **Required, with every mapping paused:**

   ```jsonc
   "reconcile": {
     "admitted": 0,        // ← any non-zero here is STOP-AND-REVERT
     "enqueued": 0,        // ← ditto
     "enabledMappings": 0, // nothing could be admitted
     "advanced": true,     // the pass drained and the cursor moved
     "stop": "drained"
   }
   ```

   `reconcile: null` means *this* machine has not run a pass yet — wait for one
   interval, or query the machine running the scheduler. It is **not** evidence
   that nothing ran.

   Cross-check the durable, fleet-wide side (no reconcile-generated work at all):

   ```sql
   select name, status, count(*) from screening_v2.job_queue
    where name like 'ashby.%' group by 1,2 order by 1,2;   -- expect: no new rows

   select status, last_success_at, no_progress_runs
     from screening_v2.ashby_sync_checkpoints where provider = 'ashby';
                                                            -- expect: idle, fresh, 0
   ```

8. Enable **exactly one** mapping for a low-volume job via Mission Control.
   Confirm the resume forced the resync in the same transaction:

   ```sql
   select status, (sync_token is null) as token_cleared, full_resync_reason, resync_epoch
     from screening_v2.ashby_sync_checkpoints
    where provider = 'ashby' and checkpoint_key = 'application.list';
   -- expect: full_resync_required, true, 'mapping_enabled', epoch incremented
   ```

9. Observe the next run. `reconcile.admitted` should equal the applications
   genuinely sitting at that mapping's AI stage, each producing exactly one link
   and one import — verify against Mission Control `/workflows`. If `stop` is
   `enqueue_cap` with `enqueued > 0`, that is the backlog draining normally
   (see "Reading `no_progress_runs` correctly"); let it run further passes.
10. Only then widen, one mapping at a time, re-reading `reconcile` at each step.

**Rollback at any step:** set `ASHBY_RUNTIME_ENABLED=false`. No timer is armed,
no client exists, and durable state stays consistent.

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

Mission Control `GET /health` (interviewer+) additionally returns `reconcile` —
the last reconciliation pass observed by that process, as sanitized counts
(`observed`, `admitted`, `skipped.*`, `unclassified`, `enabledMappings`,
`mappingIndexTruncated`, `recovered`, `duplicates`, `enqueued`, `advanced`,
`stop`, `mode`, `observedAt`), or `null` when that process has run none. It is a
per-process observation, not a fleet-wide claim, and it deliberately does **not**
feed the degradation verdict — the durable backlog and the scheduler heartbeat
remain the liveness signals. See the re-activation gates for how it is read.

## Not in this PR (later work / go-live gates)

Real webhook registration/secret, tenant `application.info`/`list` calls against
production, candidate import creation beyond safe signal state, resume fetch,
invitation lifecycle, scorecard/stage saga, `candidateDelete` enablement, UI,
Plivo, and deployment. `candidateDelete` and local erasure policy remain
privacy/legal + tenant-probe gated.
