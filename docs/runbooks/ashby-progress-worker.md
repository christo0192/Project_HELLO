# Ashby progress worker: where imported applications went after Christy

**Migrations:** `0139_ashby_progress_worker.sql` (functions over the 0138 tables) and
`0141_ashby_progress_nudge.sql` (the webhook nudge) · **Status:** off by default
(`ASHBY_PROGRESS_ENABLED`, and `fly.toml` sets it `"false"`) · **Milestone:** M031 S3 and S4 ·
**Plan:** `.gsd/milestones/M031/BUSINESS-IMPACT-PLAN.md` section 5

---

## 1. What it does

The `ashby-progress` loop (`app/api/src/integrations/ashby/progress-worker.ts`, registered in
`runtime-workers.ts`) keeps, for every Ashby application HELLO imported, its Ashby status, current
stage, archive reason and full stage history. The business-impact page (S5, S6) counts from these.

Each pass:

1. **Skips itself** while the resume scanner is short of CPU: `job_queue` rows of `ashby.ingestion`
   that are `delayed` with `scanner_timeout` or `scanner_busy` (memory note: clamscan times out when
   Fly throttles the CPU). A stale or missing signature database (`scanner_signatures_*`) or a
   readiness hold (`scanner_not_ready`, `scanner_readiness_*`) also defers ingestion, often for
   hours with the CPU idle, and does **not** pause the worker. The pause is capped: after 5 skipped
   passes in a row (`MAX_SCANNER_SKIPS`) a machine reads one application anyway, and every pass
   that runs records the passes skipped before it (`scanner_paused`, see section 5).
2. **Claims** up to `ASHBY_PROGRESS_BATCH_SIZE` (10) due rows through `claim_ashby_progress_due`:
   it first seeds a progress row for every link that has none, then takes due rows
   `FOR UPDATE SKIP LOCKED` in `next_check_at` order and moves them to the end of a lease longer
   than the pass. Two machines never read the same application at once.
3. **Reads**, at most about 2 Ashby calls a second (`ASHBY_PROGRESS_MIN_CALL_INTERVAL_MS`, 500).
   Each call has its own budget, retries and any `Retry-After` wait included: 20 s
   (`CALL_BUDGET_MS`), or half the pass deadline if that is less, and never past the pass deadline.
   A call that has not answered by then is that application's `timeout` (section 3), so one
   application that never answers costs one budget and backs off; it cannot use up pass after pass.
   - `application.info`: status, current stage (type, plan order, plan, group), current job,
     archive reason (id, Ashby's catalogue text, `reasonType`, `isArchived`), `archivedAt`,
     `updatedAt`;
   - `application.listHistory`, every page (100 a page, at most 10 pages), when anything changed,
     when the history was never read, when it was last read more than
     `ASHBY_PROGRESS_HISTORY_MAX_AGE_HOURS` (168) ago, or when an open backfill began after it was
     last read. Each row's id, stage id, title, entry and exit time, stage number and **whether**
     `actorId` was set. A missing `leftStageAt` (the live API drops it on the current row) means the
     application is still in that stage;
   - `interviewStage.info` (Interviews read) for a stage known only from history, at most five per
     pass and 5 s each (`STAGE_LOOKUP_BUDGET_MS`), to give it a type and plan position. Without that
     permission, or after a lookup that did not answer, the pass makes no more lookups and the stage
     is added from its history title.
4. **Records** each application through `record_ashby_application_progress`, in one transaction,
   only while its lease still holds (otherwise `lease_lost` and nothing is written): progress,
   intervals upserted on Ashby's history id, a row Ashby stopped returning marked `gone_at` (never
   deleted), the reason catalogue, stages seen only in history (`source = 'history'`; a plan stage
   is never touched).
5. **Writes one run row** (`record_ashby_progress_run`): checked, changed, failures by code, and next
   to them two counts that are not failures: `deferred` (rows handed back unread) and
   `scanner_paused` (passes skipped for the scanner just before this one). The 0138 table has no
   column for them, so they ride in `errors_by_code`; the status route shows them apart.

It reads Ashby only (`PROGRESS_READ_OPERATIONS`, all `mutation: false`) and writes only the five 0138
tables. It never writes `ashby_application_links`, `candidates` or `assessments`.

**Which links.** One rule, `ashby_progress_covered_links()`, used by every 0139 function. A link is
never seeded, claimed, marked or counted when:

- a data-subject erasure ended it (`terminal_reason = 'subject_erasure'`);
- it was **already** ended (withdrawn, deleted, cancelled) and has no candidate. `lib/dsar.ts`
  leaves an already-ended link's state alone, then deletes the candidate, which nulls
  `candidate_id` and deletes the erasure request with it. So "ended, no candidate" is the only trace
  an erasure leaves on such a link. An import cancelled before it ever became a candidate drops
  out too; HELLO had stopped work on it anyway;
- its candidate has a pending, in-progress or fulfilled restriction or erasure request.

Progress rows such a link already had stay as they were (opaque ids and stage times, nothing
personal) and are not read again.

**Privacy.** Opaque ids, stage titles, Ashby's own reason catalogue, closed codes, booleans and
timestamps. No name, email, phone, resume, custom field, hiring team, offer or Ashby staff id. Each
field is copied off the payload by name and validated; `moved_by_person` replaces the actor id.

**Webhook nudge (M031 S4).** A `candidateStageChange` webhook for an application HELLO imported
marks its progress row due now, so the next pass (an idle loop ticks every 30 to 60 s) reads it
instead of waiting for the cadence (6 h for a recently moved application). `integrations/ashby/progress-nudge.ts`, called by
the signal worker (`processAshbySignal`), through `nudge_ashby_application_progress` (0141):

- **When.** Only while `ASHBY_PROGRESS_ENABLED` is `true`: off, the signal handler wires no nudge,
  so nothing is called and nothing is written. Once per stage-change signal that carries an
  application id, first, before the stage pre-filter (`ASHBY_STAGE_PREFILTER_ENABLED`), so a stage
  the pre-filter skips is still nudged. A signal reconciliation re-drives (only ever for an
  application sitting in a mapped Christy stage) is nudged too; an admin's explicit backlog import
  is not (it is an import run, not a stage move).
- **Cost.** One database call and no Ashby call: the link on its unique key (an application HELLO
  never imported, the usual case, answers `not_imported` after one index probe), then the
  coverage rule (`ashby_progress_covered_links()`, the same one the worker uses) for a link that
  exists, then one write. Measured on Postgres 17 with 20,000 links: about 0.3 ms for an
  application HELLO never imported, about 9 ms for one it did.
- **What it writes.** `ashby_application_progress` only. A missing row is created due now, as the
  claim seeds one (`created`); a row due later is moved to now (`marked`); a row already due is left
  alone (`already_due`). `next_check_at` only ever moves earlier, and nothing else on the row
  changes (not the stored state, the attempts, the error code or `updated_at`). A link the coverage
  rule leaves out (erasure, an ended link with no candidate, a restriction) is never nudged
  (`not_covered`). An application Ashby no longer had (`application_not_found`, never due) is due
  once more: the webhook is proof it exists.
- **Never in the way.** It is not a decision: the signal's decision, receipt, provider reads, order
  and retries are exactly as without it. The call is bounded at 2 s (`PROGRESS_NUDGE_TIMEOUT_MS`);
  a failure or timeout is logged as `ashby_progress_nudge` with `error_type` `error`, `timeout` or
  `refused` (a code only, never an id) and skips nudges on that machine for 30 s
  (`PROGRESS_NUDGE_FAILURE_BACKOFF_MS`), so a webhook storm cannot pile onto a sick database. A
  skipped nudge costs freshness only: the cadence still reads the application.
- **A row being read.** A nudge that lands while a pass is reading that application moves the row to
  now: the read in flight may predate the move, so it is refused (`lease_lost` on the run) and the
  next pass reads the application again.

## 2. Switch and tunables

| Variable | Default | Meaning |
|---|---|---|
| `ASHBY_PROGRESS_ENABLED` | `false` | Only the literal `true` turns it on. Also needs the Ashby runtime on. Turns on the webhook nudge too (section 1). |
| `ASHBY_PROGRESS_INTERVAL_MS` | 120000 | Base loop interval. `lib/scheduler.ts` caps idle backoff at 60 s, so an idle loop ticks every 30 to 60 s; a tick with nothing due is two small queries and no Ashby call. |
| `ASHBY_PROGRESS_DRAIN_INTERVAL_MS` | 5000 | Interval after a pass that filled its batch (a backfill draining). |
| `ASHBY_PROGRESS_BATCH_SIZE` | 10 | Applications one pass claims (1 to 50). |
| `ASHBY_PROGRESS_PASS_DEADLINE_MS` | 45000 | One pass's budget, every call and retry included. The lease is this plus 60 s. |
| `ASHBY_PROGRESS_MIN_CALL_INTERVAL_MS` | 500 | Gap between two Ashby calls of one pass. Each machine paces itself. |
| `ASHBY_PROGRESS_ACTIVE_RECENT_HOURS` | 6 | Active (or Lead) and moved or updated in the last 14 days. |
| `ASHBY_PROGRESS_ACTIVE_HOURS` | 24 | Any other Active. |
| `ASHBY_PROGRESS_TERMINAL_HOURS` | 168 | Hired or Archived within 90 days of finishing (archive time; for a hire, entry to the Hired stage). |
| `ASHBY_PROGRESS_TERMINAL_OLD_HOURS` | 720 | Hired or Archived longer ago. Every such check re-reads the history. |
| `ASHBY_PROGRESS_HISTORY_MAX_AGE_HOURS` | 168 | The history is re-read on a check at least this often, change or not (a history edit may not move `updatedAt`). |

Every value is clamped (`PROGRESS_BOUNDS` in `config.ts`). Kill switch, no deploy needed (a Fly
secret overrides `[env]`):

    fly secrets set ASHBY_PROGRESS_ENABLED=false -a project-hello-api

Off, the loop still ticks (so `/health` sees it) and does nothing.

## 3. Failures and what to do

Every failure is stored on its row as `check_error_code` and counted on `GET .../progress/status`
(`byError`). None stops the pass, except a rate limit.

| Code | Means | Retried | Do |
|---|---|---|---|
| `missing_endpoint_permission` | Ashby named it, on HTTP 403 or HTTP 200 `success: false` (the S1 access check's rule). | daily | Ask the Ashby admin to tick Candidates read on HELLO's key. Run `GET .../access-check`. |
| `forbidden` / `unauthorized` | A 403 without that code: the key itself was refused. | daily | Replace the `ASHBY_API_KEY` secret. |
| `rate_limited` | A 429 the client could not wait out inside the pass. The rest of the batch is handed back for 5 minutes and the pass ends. | 15 min | Nothing; lower the pace (`ASHBY_PROGRESS_MIN_CALL_INTERVAL_MS`) if it persists. |
| `application_not_found` | `application.info` answered 404 (or `success: false` naming it): Ashby no longer has it. The row is never due again. | never; a backfill reads it once more | Nothing. |
| `history_page_cap` | More than 1,000 history rows. Nothing is written rather than a partial history marking rows gone. | 15 min doubling, to a day | Raise `MAX_HISTORY_PAGES` in code if it is real. |
| `malformed_response` | A payload or history row without an id, stage or time, or a broken cursor. | 15 min doubling | Check Ashby's changelog; nothing is written. |
| `timeout` | A call that did not answer inside its own budget (20 s), or a row whose own slow reads ran the pass out after it began with more than one call budget left. | 15 min doubling, to a day | Nothing unless it persists; a growing count means Ashby is slow for those applications. |
| `server_error`, `network`, ... | The access check's coarse codes. | 15 min doubling, to a day | Nothing unless it persists. |
| `record_error`, `record_refused`, `internal_error` | HELLO's own write or read failed. Backed off like the above. | 15 min doubling | Check Supabase. |
| `lease_lost` | Counted on the run only: a backfill or a webhook nudge re-marked the row while it was read. Nothing written; it is read again soon. | at once | Nothing. |

A row the pass never started, or one the **pass's** deadline cut short after it began with no more
than one call budget left, is handed back unread (`deferred`) with its claim refunded and is due
again at once; the rows behind a rate limit are handed back for 5 minutes. A hand-back is not a
failure and is not stored on the row, but each pass counts its hand-backs on its run row
(`deferred` on `lastPass` and `recentRuns`), so a pass that only handed rows back still shows.

## 4. Backfill

`POST /api/integrations/ashby/mission-control/progress/backfill` (admin):

- `{ "dryRun": true }`: counts only, nothing changes: `links`, `alreadyChecked`, `neverChecked`,
  `toCheck`, `expectedCalls`, `estimatedMinutes` at the worker's pace, and the open backfill if one
  is running. A backfill re-reads **every** application's whole history (the claim answers when the
  backfill began, and a history read before then is read again, change or not), so `expectedCalls`
  is two per application (`application.info` and one history page), one per application Ashby no
  longer has (`application.info` answers 404 again), plus a page per 100 history rows past the
  first. Ashby time only; the gaps between passes come on top (with the drain interval, roughly 40
  applications a minute per machine). It answers with the worker off too.
- `{ "dryRun": false }`: `start_ashby_progress_backfill` marks every covered link due now, newest
  first, seeding any link with no progress row (an application Ashby no longer has is read once
  more), opens one backfill run and writes its `audit_events` row (`resource_update`, target
  `ashby_progress/backfill`, counts only, under the admin) in one transaction. `state`:
  - `started`;
  - `already_running`: a backfill is open; nothing changed (idempotent);
  - `worker_disabled`: the worker is off (switch or runtime); nothing was marked.

The route never calls Ashby. The worker reads every application through the same code path as its
sweeps, re-reading each history read before the backfill began, so a backfill rebuilds every
application's intervals (after a fix to the history reader, or a history edited in Ashby without
moving `updatedAt`). The backfill closes on its own (finished, with the summed counts and codes of
the passes since it began) once every covered link has been written since it started (read,
failed or gone; a hand-back does not count); a pass with nothing to read still records an empty run
while a backfill is open so that it can close.

## 5. Status

`GET /api/integrations/ashby/mission-control/progress/status` (admin), counts only: `worker`
(switch, runtime, pace, cadences), `coverage` (links, checked, never checked, excluded), `due` (now,
stale = overdue by more than 24 h, gone), `byStatus`, `byError`, `intervals` (open, gone),
`historyStages`, `openBackfill`, `lastPass`, `recentRuns` (last ten; each with `deferred`, the rows
it handed back, and `scannerPaused`, the passes skipped for the scanner just before it, apart from
its `errors`), and `scannerPause` (`skippedPasses` over the last 24 h and `lastAt`, when the newest
pass that recorded some ran). One audit row per request.

**A paused worker.** `worker.running` true, `lastPass` getting older and `due.now` rising: look at
`scannerPause` and `lastPass.scannerPaused`. A machine that keeps skipping still runs a pass of one
application every sixth tick (every 3 to 6 minutes: an idle loop ticks every 30 to 60 s), and that
pass records the skips, so a pause shows within minutes. Then check Fly CPU metrics and `backlog.scannerDeferredJobs` on Mission
Control health (memory note on clamscan CPU throttling).

## 6. Turning it on (GO-LIVE)

1. Migrations 0139 and 0141 are applied (the owner's `supabase db push`, after 0138). The switch
   also turns on the webhook nudge, which calls 0141: with 0141 missing every nudge fails, is
   logged as `ashby_progress_nudge` `error` and backs off, and the signals go on unharmed.
2. Run the S2 stage-catalogue refresh, so plan stages are known (`POST .../stage-catalog/refresh`).
3. **Before** the switch: `POST .../progress/backfill` with `{ "dryRun": true }`; note `toCheck`,
   `expectedCalls` and `estimatedMinutes`. The dry run answers with the worker off, and with the
   switch off nothing has been read yet, so the numbers are what the whole first read costs.
4. Set `ASHBY_PROGRESS_ENABLED = "true"` in `fly.toml` `[env]` and deploy, after the live-call
   check (phone `live` 0, no R1 round `in_progress`). From the first tick each claim seeds the links
   with no progress row (500 a pass, newest first) and reads them: the switch alone starts the
   first full read.
5. `GET .../progress/status`: `worker.running` true.
6. Straight away, `POST .../progress/backfill` with `{ "dryRun": false }`. It gives the first read a
   run that closes when every link has been read, with its counts. Do it at once: the applications
   the seeding read before it began are read once more (a backfill re-reads every history read
   before it began), so every minute of delay costs about 40 applications read twice.
7. Watch `GET .../progress/status`: `openBackfill.remaining` falls; `byError` stays small;
   `scannerPause.skippedPasses` stays 0. Check Fly CPU metrics if the resume backlog is large (the
   worker pauses while scans time out or the scanner is full).

First numbers by SQL, aggregates only (no ids):

```sql
select status, count(*) from screening_v2.ashby_application_progress group by 1 order by 2 desc;
select c.milestone, count(distinct i.application_link_id) as applications
  from screening_v2.ashby_application_stage_intervals i
  join screening_v2.ashby_stage_catalog c on c.stage_id = i.stage_id
 where i.gone_at is null
 group by 1 order by 2 desc;
```

## 7. Rollback

Set the switch off: it stops the worker and the webhook nudge. Nothing else needs undoing: the
tables and functions are additive, the worker and the nudge write only them, and no existing table,
row or candidate is touched.

## 8. Limits, recorded honestly

- The monthly tier (Hired or Archived more than 90 days ago) re-reads the history on each check,
  so such an application's history is read monthly, not weekly.
- The webhook nudge only sees moves whose webhook arrives. Ashby's docs do not say whether
  archiving fires `candidateStageChange`, Ashby stops retrying after about 2.8 hours, and
  reconciliation re-drives only applications in a mapped Christy stage, so a lost webhook for a
  later move is never replayed. Such a move shows within the cadence (6 h for a recent active
  application).
- A move back into a stage whose receipt is already concluded is not nudged. Stage-change receipts
  are keyed per application and stage (`stage:<application>:<stage>`), and
  `record_ashby_event_receipt` (0030) creates no signal job for a receipt already `processed`,
  `ignored` or `failed`: the delivery answers `duplicate`, so `processAshbySignal`, and the nudge
  with it, never runs. In practice that is an imported application moved back into its Christy stage
  (its receipt was `processed` by the import); the signal worker leaves every other stage's receipt
  `received`, so a move back into one of those is re-driven and nudged. Such a move shows within the
  cadence; no import decision changes. Nudging from the ingress on a duplicate receipt would put a
  database write on the webhook path, so it is left out.
- The nudge's backoff is per machine and in memory: after a failure that machine skips nudges for
  30 s. Nudges are not counted on the status route; only failures show, in the logs.
- The Mission Control UI does not show these counters yet; the status route does.
- A machine's pace is its own: with two API machines the tenant sees up to about 4 calls a second.
- The scanner signal is the fleet's, not the machine's: `job_queue` clears a job's lease owner when
  it is deferred, so a `scanner_timeout` on one machine pauses the worker on every machine. The cap
  (one application every sixth tick) bounds that; a machine-local signal would need a hook in the
  resume-ingestion handler, left out of this worker.
- The skip count lives in each machine's memory until a pass records it: a machine that restarts
  mid-pause loses the skips not yet recorded (at most five).
