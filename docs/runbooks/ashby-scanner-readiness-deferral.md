# Ashby resume ingestion — scanner readiness, deferral, and recovery

**Migration:** `0037_queue_defer.sql` · **Status:** off by default with the rest of
the Ashby runtime (`ASHBY_RUNTIME_ENABLED`) · **Owner:** integrations

---

## 1. The incident this exists to prevent

A replayed canary ingestion was claimed seconds after a deploy, before
`freshclam` had established the ClamAV signature database. The pipeline
resolved a presigned URL, downloaded the candidate's resume, handed it to a
scanner that had nothing to screen with, and recorded the refusal as

    state = failed_review
    failed_reason = scan_scanner_signatures_unavailable
    attempts = 1

**The scanner was right to refuse.** The defect was that the pipeline had no
vocabulary for *"not yet"*, so it wrote a permanent verdict for a temporary
absence — and a `failed_review` ingestion blocks its invite forever, because
nothing in the runtime performs the `failed_review → queued` transition on its
own.

This was not a one-off deploy event. `fly.toml` sets `auto_stop_machines` with
no `[mounts]` block, so `/var/lib/clamav` lives on the ephemeral rootfs: the
cold window recurs on **every deploy, autostart, crash and machine
replacement**.

It is the same defect class as PR #66 — a WAIT charged against a FAILURE
budget — except that here the budget was the ingestion state machine itself and
the charge was permanent rather than merely expensive.

---

## 2. What now happens instead

### Layer 1 — admission gate (the job is never claimed)

Before every `ashby.ingestion` claim, the runner asks whether this machine has
a usable signature database. If not, **the queue is skipped entirely**:

* no attempt is spent, no lease churns;
* no `file.info` call, no presigned URL, no resume bytes move;
* the job stays `pending`, so a **different machine** whose updater has already
  succeeded can take it — behaviour no post-claim outcome can express;
* every other Ashby queue keeps draining. Only ingestion touches the scanner.

The gate reads **signature freshness only** — a 512-byte header read behind a
short TTL. It deliberately does **not** run the capability probe: that executes
the real `clamscan` behind the process-wide gate production scans take, and
putting it on a poll path would let readiness checks compete with the scans
they protect. Capability proof stays on the health surface, where its cost is
paid once an hour and cached.

The two cannot disagree dangerously: freshness is a *necessary* condition for
readiness and `/health` checks it first, so the gate admits a strict superset
of what health calls ready.

### Layer 2 — lease-safe deferral (the post-claim race)

The gate is advisory: the database can vanish between the check and the scan.
`defer_job` (0037) is the backstop. Under a compare-and-set on the live lease it

* returns the job to `delayed` behind a clamped delay (1–3600 s);
* **refunds exactly the attempt the claim charged**;
* clears the lease, clears any error text, sets no `failed_at`;
* **cannot** complete, fail, or dead-letter, and never raises `max_attempts`.

It mirrors `defer_ashby_operation` (0035) field for field. That hardening was
built for the operations outbox and never reached the generic 0028 queue, which
is why resume ingestion inherited none of it.

### Layer 3 — scan-outcome classification

`classifyScanStatus` (`lib/malware-scanner.ts`) is exhaustive over
`ScanResult['status']` — adding a status without classifying it **fails the
build**.

| status | class | outcome |
|---|---|---|
| `clean` | verdict | proceed |
| `infected` | **verdict** | `failed_review / scan_infected`, **never requeueable** |
| `scanner_signatures_unavailable` / `_stale` / `scanner_unavailable` | availability | defer, 300 s |
| `scanner_busy` / `scanner_timeout` / `scanner_error` | transient | defer, 60 s |
| `guard_*`, `parse_error`, `no_extractable_fields` | verdict (content-derived) | `failed_review`, terminal |

A non-verdict scan makes `runResumeIngestion` return `{ state: 'deferred' }`:
the resume bytes are wiped (the wipe-on-every-exit guarantee extends to this
new exit), and **no durable state is written at all** — the row gains no
failure reason, so nothing downstream reads a wait as work that needs a human.

The fail-closed posture is unchanged. Nothing unscanned is ever parsed.

### Bound — wall clock, not a counter

A deferral is bounded by `ASHBY_SCANNER_DEFER_DEADLINE_MS` (default 8 h),
measured from the queue job's own `created_at`. Past it the outcome becomes a
real, loud `failed_review / scan_unavailable_deadline`.

The bound is wall-clock deliberately. A defer *counter* that gated the decision
would be a control with no reset lifecycle — the one-way-latch failure this
repo already paid for in PR #65. A deadline derived from the job resets
naturally with every enqueue. `defer_count` exists but **gates nothing**; it is
for humans reading the row.

### R-8 — a verdict is never re-downloaded

`runImport` calls `advance_ashby_ingestion(link, 'queued')` unconditionally on
every import, and `failed_review → queued` is legal. Before 0037 nothing
distinguished "we screened this and it is malware" from "we never screened
this", so a redelivered webhook or a reconciliation re-observation would
**re-download and re-scan known malware**, up to the requeue ceiling.

0037 refuses a `queued` requeue (`status: 'not_requeueable'`) when
`failed_reason` is verdict-class: `scan_infected`, `guard_%`, `parse_error`,
`no_extractable_fields`. Availability-class reasons stay requeueable — those
rows never had a verdict, and they are exactly what must stay recoverable.

This ships in the same migration as the deferral on purpose: making the
pipeline more willing to retry makes the malware-requeue path **more**
reachable, not less.

### New ingestion retry edges

`fetching → queued` and `scanning → queued` are now legal, and only these two.
Both mean the same narrow thing: the attempt was abandoned **before any
statement about the file was produced**, nothing was recorded, and the work
restarts from the beginning. `extracting` and `structuring` get no such edge —
by then the bytes have been parsed and a re-run is a re-download.

These edges are bounded by the existing 0032 requeue ceiling (5). At the
ceiling the row rests as `failed_review / scan_deferral_exhausted`.

### Cold-start updater cadence

The updater had one schedule: `intervalMs`, floored at 15 minutes, defaulting to
an hour. That floor is ClamAV's politeness request about *topping up* a
database you already have. A machine with **no** database cannot scan at all,
and one lost cold attempt (a timeout, a 429) cost a full hour of that.

While no usable database exists the updater now retries on a capped, jittered
ladder — 60 s → 120 s → 300 s — and switches to the steady-state interval the
moment a database appears. Each attempt is still bounded by freshclam's own
`MaxAttempts 3` and by `timeoutMs`, and the updater is still single-flight: the
next timer is armed only after the previous attempt settles.

### Capability probe no longer starves scans

`probeClamAvCapability` now takes the shared gate **non-blocking**. Previously
it queued behind production scans with the *scan* timeout (120 s default), so
an operator refreshing the dashboard could push a real resume scan to
`scanner_busy` — which used to be a permanent ingestion failure — and could
block an HTTP handler for two minutes. It now reports `capability_unverified`
rather than waiting. One gate is kept deliberately: a `clamscan` loads ~1 GiB of
signatures on a 2 GiB machine, so two concurrent loads is the OOM the gate
exists to prevent.

---

## 3. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASHBY_SCANNER_DEFER_SECONDS` | `45` | Wait after a handler-entry readiness deferral |
| `ASHBY_SCANNER_READINESS_TIMEOUT_MS` | `2000` | Bound on the freshness read on the poll path |
| `ASHBY_SCANNER_DEFER_DEADLINE_MS` | `28800000` | Wall-clock bound before a deferral becomes a loud failure |

All are clamped; malformed input takes the default.

---

## 4. Reading `/api/ashby/mission-control/health`

* `scanner.mode` / `.ready` / `.signatureAgeSec` / `.reason` — unchanged.
* `backlog.scannerDeferredJobs` — jobs currently deferred on the scanner
  (post-claim races only; the common cold-boot case never claims).
* `backlog.scannerDeferredOldestAgeSec` — longest uninterrupted wait. Minutes
  is a cold boot; an hour is an updater that never came back.
* `reasons` gains `scanner_deferral_stalled` past 900 s.

**A permanent scanner outage is deliberately still loud.** With the admission
gate holding jobs `pending`, three independent signals fire and none is
suppressed:

1. `queue_not_draining` — `oldestPendingAgeSec > 900`;
2. `scanner_<reason>` — attribution from the scanner view;
3. `ingestion_stuck` — the durable row has been `queued` past the window.

`ingestion_stuck` is **not** suppressed when the scanner is the cause. It is
loud and right, and the `scanner_*` reason beside it supplies the attribution.
An admission gate that quietly hid work would be strictly worse than the
loud-but-permanent failure it replaced.

---

## 5. Recovery — the canary row currently at `failed_review`, attempts 1

State to recover: one ingestion at `failed_review /
scan_scanner_signatures_unavailable`, `attempts = 1`.

Because attempts is 1 of 5, **no attempt reset is needed** —
`reset_ashby_ingestion_attempts` (0036) is for transport-defect rows and would
refuse this reason anyway. And because the reason is availability-class, the
0037 verdict refusal does **not** block the requeue.

Order matters: deploy first, confirm the scanner, then move the data.

**Step 1 — deploy 0037 and confirm the scanner is genuinely ready.**

```
GET /api/ashby/mission-control/health
→ scanner.mode == "clamav"
  scanner.ready == true
  scanner.signatureAgeSec  well under scanner.maxAgeSec
```

Do not proceed while `ready` is false. Requeuing into a cold machine now just
defers (harmless, but it proves nothing).

**Step 2 — return the ingestion to `queued`** (service-role SQL; the RPC audits
and enforces both ceilings):

```sql
select screening_v2.advance_ashby_ingestion(
  '<application_link_id>'::uuid, 'queued', null, null, null, null);
-- expect: {"status":"ok","state":"queued","attempts":2,"max_attempts":5}
```

`not_requeueable` here would mean the row is verdict-class and must **not** be
retried — stop and read `failed_reason`.

**Step 3 — enqueue the work item.** The original job completed, so the durable
row alone will not move. Insert one job with the dedup key, which is a no-op if
a live one already exists:

```sql
insert into screening_v2.job_queue
  (name, payload, dedup_key, status, attempts, max_attempts, priority, scheduled_at)
values
  ('ashby.ingestion',
   jsonb_build_object('provider','ashby','applicationLinkId','<application_link_id>'),
   'ashby:ingestion:<application_link_id>',
   'pending', 0, 5, 0, now())
on conflict do nothing;
```

**Step 4 — confirm.** Within one poll interval the ingestion should reach
`ready` and its blocked invite should clear:

```
backlog.operationsBlockedFailedIngestion → 0
backlog.ingestionStuckQueued            → 0
```

If it defers instead, `backlog.scannerDeferredJobs` becomes 1 and
`scannerDeferredOldestAgeSec` starts climbing — that is the scanner, not the
row.

---

## 6. Known limits, stated rather than papered over

* **The gate-to-scan race is bounded, not eliminated.** Readiness is proven
  before the row leaves `queued`; the bytes are scanned a bounded moment later
  (one `file.info` plus one download, each transport-bounded). freshclam can
  only make the database newer and installs by atomic rename, so the realistic
  direction of change inside that window is safe. If the scanner genuinely
  degrades mid-flight the scan still fails closed — and now defers instead of
  condemning the resume.

* **`fail-closed` mode proceeds rather than holding.** No scanner is configured
  and no waiting produces one. The scan fails closed as before, the
  availability classification defers it under the wall-clock deadline, and it
  surfaces as a loud failure within 8 hours instead of an invisible queue.

* **The scan gate is the machine's throughput ceiling.** One active scan plus
  two waiters, shared with the recruiter upload and LiveKit upload paths.
  Deferral makes `scanner_busy` *recoverable*; it does not make it *rarer*. The
  correct response to volume is horizontal — more machines, each with its own
  gate and database — not raising the worker concurrency.

* **No persistent database directory.** Every machine start re-downloads
  ~113 MB. A Fly volume would convert the cold window from "every machine
  start" to "first boot of a new volume", at the cost of a root-privileged
  pre-start to chown the mountpoint. That trade is not taken here and remains
  open.

* **The API cannot read updater progress.** `AvUpdaterHandle.stats()` lives in
  the supervisor; the API is a spawned child. Health can therefore report the
  *absence* of a database but never "a download is in flight", so "wait" and
  "page someone" are not yet distinguishable from the health surface alone.
