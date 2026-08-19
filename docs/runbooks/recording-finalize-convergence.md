# Runbook — durable authoritative-recording finalization convergence (0038)

Scope: the server-side path that turns a completed screening's LiveKit Egress
into a linked, hashed, downloadable recording. Disabled by default.

---

## 1. What was broken

`call_sessions.recording_egress_status` is written in four statements. One
writes `'active'` at start; the other three all live inside
`finalizeAuthoritativeRecording()`. That function had exactly **two** production
callers — the candidate browser's `POST /api/livekit/:id/complete`, and a
recruiter pressing play.

But **three** code paths write `status = 'completed'`:

| writer | finalizes egress |
|---|---|
| candidate browser complete route | yes |
| **voice worker (the primary voice path)** — `persistence.py` → direct CAS | **no** |
| text screening turn route | no |

A session completed by the worker had **no actor** to finalize it. It froze at
`recording_egress_status = 'active'` with a NULL object key, permanently. There
was no LiveKit webhook receiver, no sweeper, no cron, and no health signal
anywhere in the deployment.

This is not a bug inside `finalize`. It is the **absence of any actor to call
it**, and 0038 is that actor.

Two related gaps shipped in the same change because they are the same failure
class:

* **Silence.** Every `'pending'` return wrote nothing and logged nothing while
  collapsing five distinct causes ("still flushing", "storage misconfigured",
  "the provider answered about somebody else's egress", …) into one.
* **A false compliance record.** Erasure emitted `erasure_completed` with
  `object_key_removed: true` on a path that removed nothing, and the LiveKit
  manifest object (`<key>.json`) was never removed on *any* path.

---

## 2. How convergence works now

```
terminal CAS on call_sessions
  └─ trg_enqueue_recording_finalize  (AFTER UPDATE, SAME TRANSACTION)
       └─ job_queue: 'recording.finalize', dedup 'recording.finalize:<id>',
                     scheduled_at = now() + 60s
            └─ recording-finalize loop  → finalizeAuthoritativeRecording()
                                          → stopEgress → poll → download
                                          → finalize_authoritative_recording RPC
```

Four loops, all in `createRecordingRuntime()`:

| loop | job |
|---|---|
| `recording-finalize` | drains the queue |
| `recording-sweep` | backstop for the accumulated backlog and any terminal write the trigger's `WHEN` misses |
| `recording-reclaim` | returns expired-lease jobs to pending/DLQ — **not optional**, see §6 |
| `recording-reap` | bounds terminal `job_queue` growth |

**Why a trigger and not a call site.** It is the only seam that covers the
Python worker's direct `call_sessions` UPDATE without editing the worker, and it
is *inside the completing transaction*, which structurally removes the "process
died between the CAS and the enqueue" gap that would otherwise make the sweeper
load-bearing rather than a backstop.

**Ashby independence.** Nothing in `lib/recording/**` imports an Ashby module or
reads an `ASHBY_*` variable, and `index.ts` builds this runtime in its own
`try/catch` from its own gate. A test asserts both statically. This matters
because the deployment this repair exists for has the Ashby runtime *paused*.

---

## 3. Rollout

1. **Merge with `RECORDING_FINALIZE_WORKER_ENABLED=false`.** The migration is
   additive and the trigger enqueues into a queue nobody consumes.

   Be precise about what that accumulates: the trigger fires for **every**
   egress-recorded session at the moment it becomes terminal, not only stuck
   ones (`routes/livekit.ts` commits `completed` *before* calling the
   finalizer, so `recording_object_key is null` is true for all of them). That
   is one `job_queue` row per recorded session. It is bounded only by
   `reap_completed_jobs`, which the `recording-reap` loop drives — and that
   loop does not run while the worker is disabled. Watch `job_queue` depth in
   this phase; it should track session volume, and it does not shrink until
   step 2.

2. **Enable on ONE machine** with `RECORDING_FINALIZE_SWEEP_ADMISSION=5`, and
   watch `GET /api/recordings/health`:
   * `backlog.stuckCount` should fall;
   * `backlog.queueDepth` should not climb;
   * `backlog.exhaustedCount` must stay `0`.

3. **Raise admission to the default and enable fleet-wide.**

4. Only then consider PR-2 (the LiveKit webhook, §8).

### What the sweep deliberately does not reach

A row with a NULL `ended_at` is out of the sweep's reach: the age bounds are
what stop the first pass reaching arbitrarily far back, and a row with no end
time has no age to bound. Every current terminal writer stamps `ended_at`
(`session-lifecycle.ts` for all four terminal states, `persistence.py` for both
worker paths) and the trigger covers such a row on the primary path anyway, so
this only excludes pre-existing legacy rows — visibly, rather than by accident.
If you find one, `reopen_recording_finalize` plus a manual `ended_at` backfill
is the recovery.

### The drain invariant

```
sweepAdmission  ≤  concurrency × (sweepMs / pollMs)
20              ≤  4           × (300000 / 60000) = 20   ✓
```

The three sweeper bounds all bound the **producer**; nothing bounded the
consumer. At the queue runner's default concurrency of 2 the sweeper would
enqueue 4 rows/min against a 2 rows/min drain and the backlog would grow for as
long as the sweep ran. Raising `RECORDING_FINALIZE_SWEEP_ADMISSION` past the
drain capacity is **clamped at construction and logged**
(`recording_sweep_admission_clamped`) — never silently honoured.

---

## 4. Kill switch

```sql
-- freeze the sweep AND all claiming, fleet-wide, no deploy
select screening_v2.set_recording_finalize_halt('operator_pause');

-- release
select screening_v2.clear_recording_finalize_halt();
```

Both are audited (`admin_session_override` on
`recording_finalize_control`). The clear path exists because **a gate with no
reset is a one-way latch, not a control**.

Two properties worth knowing before you rely on it:

* **It takes effect within `RECORDING_FINALIZE_HALT_TTL_MS` (default 5 s) per
  machine, not instantly.** The queue runner's admission gate consults it on
  every poll and that contract requires a cheap read, so the flag is cached.
  The staleness window is the price; the safety boundaries (per-tick admission,
  sweep max-age, per-session attempt terminus) are *not* cached.
* **An unreadable flag FAILS OPEN.** `shouldClaim` treats a throw as
  do-not-claim, so failing closed would let one transient database error stop
  all claiming fleet-wide — while buying nothing, since the handler's own first
  act is a database read that would fail anyway. A cached answer newer than
  60 s is reused first.

`RECORDING_FINALIZE_WORKER_ENABLED=false` stops the loops entirely. The trigger
keeps recording intent durably in the queue, so nothing is lost while it is off.

---

## 5. Diagnosing a session that has not converged

### 5.1 Read the row and the provider

```bash
cd app/api
npx tsx scripts/repair/inspect-egress.ts --session-id=<uuid>
```

Read-only: `listEgress` plus one DB read. No `stopEgress`, no download, no URL,
no token, no write. It prints the `EgressStatus` **enum name**, whether the
returned item's `egressId` actually matches ours (the identity check, made
observable), the provider's own `manifestLocation` next to the derived manifest
key, and the bounded finalize columns.

This is the tool the original incident needed and did not have. Both
investigations *inferred* the provider state from the room's 600 s empty
timeout; neither observed it.

### 5.2 Read `recording_finalize_defer_reason`

| reason | meaning | action |
|---|---|---|
| `poll_timeout` | the egress had not reached a terminal state within the finalize timeout, and the response was correctly filtered | wait; normal on a busy egress |
| `egress_identity_mismatch` | the provider returned items but **none of them was ours** — the `egressId` filter was ignored | provider-side; do not treat the returned status as ours |
| `object_unreadable` | the object could not be downloaded, or was zero bytes | check the storage gateway (§7) |
| `object_absent` | the download returned no object and no error | check the bucket and prefix |
| `provider_error` | `listEgress`/`stopEgress` threw | provider outage or transport |
| `provenance_conflict` | the row's provenance cannot be upgraded to `livekit_egress` | inspect the row; usually already resolved |
| `terminal_state` | deleted / revoked / quarantined | correct refusal; nothing to do |
| `rpc_unknown` | the finalize RPC returned an unrecognised status | investigate; should not happen |
| `egress_disabled` | egress is off on this build but the row carries an egress id | legacy row; enable egress or leave it deferred |

This list is the **authoritative allowlist** and lives in the 0038 CHECK. The
queue's own `defer_job` reason gate is a looser shape regex, so a code added to
the worker but not to the migration would defer the *job* normally while
failing the *session* write — silently, because that write is best-effort — and
health would under-report. **Change both together.** A test asserts they match.

### 5.3 Recover a latched row

`recording_egress_status = 'failed'` used to be a one-way door. It is not any
more:

```sql
select screening_v2.reopen_recording_finalize(
  '<session-uuid>'::uuid,
  'storage_configuration_repaired'   -- or provider_incident_resolved / operator_review
);
```

Guarded by a reason allowlist so it cannot become a general-purpose unfail.
Refuses deleted/revoked/quarantined rows, an already-linked key, and a session
with no egress. Resets the attempt counter and the exhaustion terminus, moves
`'failed'` → `'active'`, and writes an attributable audit row.

**Never hand-edit `recording_egress_status` to `'complete'`.** It would satisfy
every read gate while leaving a NULL key and no integrity event.

---

## 6. Why `recording-reclaim` is not optional

`uq_job_queue_dedup_active` (0009) covers `pending`, `active`, **and**
`delayed`. A machine that dies mid-`recording.finalize` leaves the job `active`
with an expired lease. From that moment:

* the trigger's `on conflict do nothing` is a silent no-op;
* the sweeper's dedup-keyed `enqueue` returns the *existing* stuck job;
* nothing else touches it.

The only recovery is `reclaim_expired_jobs` — whose sole production caller was
the **Ashby** scheduler, which is disabled on the very deployment this repair
targets. Without its own reclaim loop, this change would reproduce the exact
failure it fixes, one level up, in the queue.

`reclaim_expired_jobs` is **queue-name-agnostic** (signature
`(timestamptz, integer)`, no queue name), so with both runtimes enabled the
Ashby loop (limit 50) and this one (limit 25) share ONE global per-pass budget.
The limits are set so neither starves the other.

---

## 7. Residual uncertainty — read this before concluding "it works"

Production values of `RECORDING_EGRESS_ENABLED`, `RECORDING_EGRESS_REQUIRED`,
and `RECORDING_EGRESS_FINALIZE_TIMEOUT_MS` were not read, and **whether the S3
gateway endpoint (`RECORDING_EGRESS_S3_ENDPOINT`, the Supabase S3 gateway) and
the Storage-API download used by the finalizer resolve to the same bucket and
prefix has never been tested.**

If they do not, this change converges the *state machine* but every finalize
will still defer with `object_unreadable` forever. The difference from before is
that it will be **immediately visible** on `GET /api/recordings/health` and in
`recording_finalize_defer_reason`, instead of being an indistinguishable
silence.

---

## 8. Deferred, truthfully

* **PR-2 — the LiveKit `egress_ended` / `room_finished` webhook.** A **latency**
  improvement over a now-proven path, not a correctness one. It adds a new
  unauthenticated public ingress, an HMAC raw-byte verification path, and a
  dedup receipt table, and it depends on LiveKit-side configuration that cannot
  be verified from this repository. Reuse the raw-byte HMAC path and dedup
  receipt pattern from `routes/ashby-webhook.ts` + migration 0030 — do not
  reinvent them. It must tolerate replay and out-of-order delivery, and must
  treat an unknown egress id as a **retryable defer**, never a discard (it can
  arrive before the link CAS commits).

  The honest cost of deferring it: convergence is **eventual, not immediate** —
  bounded by `grace + poll cadence`, target ~2 minutes after `ended_at`.

* **The billing tail, stated conditionally.** The sweeper does not call
  `stopEgress`; it enqueues, and `stopEgress` is issued inside
  `finalizeAuthoritativeRecording`, reached only through the queue. So the tail
  closes at `ended_at + grace + queue latency` **provided the queue is draining
  and the halt flag is clear**. Under a backlog, under a halt, or for a session
  whose deferral budget is exhausted, it does not close and the room's 600 s
  `emptyTimeout` remains the backstop. `ROOM_EMPTY_TIMEOUT_SEC` deliberately
  stays at 600 — lowering it would shorten the mid-screening reconnect window
  for a candidate on a flaky network, a real regression.

* **Room deletion on `participant_disconnected` — refused, not postponed.** It
  would race the worker's `delete_room` against the server's `stopEgress`,
  which is the mechanism most likely to produce `EGRESS_ABORTED` — the exact
  latch §5.2 was just taught not to mis-fire.

* **`visibilitychange → hidden` as a completion trigger — refused.** That event
  also fires when a candidate switches tabs or backgrounds a mobile browser
  *mid-interview*, and the handler ends the session. `pagehide` is the event
  that actually means "this page is going away".

* **Bucket-wide orphan sweep.** The erasure repair closes the gap for sessions
  the database knows about. A listing-based sweep for objects with no row at
  all is a separate compliance workstream.

* **Not attempted as a fix, and should not be:** raising
  `RECORDING_EGRESS_FINALIZE_TIMEOUT_MS`. It widens one window inside a path
  that only runs while a browser tab is open, creates no continuation, and
  lengthens the candidate's wait on the healthy path.
