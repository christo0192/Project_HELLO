# Ashby — queued candidate shell, parse classification, and parse-class recovery

Scope: PR-A (API + migration `0039_ashby_ingestion_parse_recovery.sql`).
Status: **runtime-inert by default** (`ASHBY_RUNTIME_ENABLED=false`). Nothing in
this change flips a gate, issues an invite, moves a stage, or sends an email.

---

## 1. The defect this closes

A synthetic canary produced, for one valid mapped import:

- link created, lifecycle `imported`, resume-backed, mapping enabled/manual
- resume ingestion `failed_review` with the generic reason `parse_error`, after
  a successful fetch, a safe scanner admission, and a passed magic/MIME guard
- `invite_delivery` pending at **attempts 0**
- **no candidate, no session, no invite** — and zero stage moves, zero emails

Three separate facts sit inside that:

1. **The application was invisible.** The only thing that ever created an Ashby
   candidate was the ingestion job reaching `ready`. A resume that failed to
   parse therefore produced a link, an ingestion row and a queued invite
   operation, and no row anywhere a recruiter looks.
2. **`parse_error` collapsed nine causes into one word.** The durable row could
   not answer "which?", so no honest repair of the parser was possible: every
   candidate root cause was unfalsifiable from data.
3. **A transient parser fault was terminal.** A child killed by its wall-clock
   timeout and a bounded pool refusing a submission both landed in the same
   `catch` and were written down as a verdict about the document.

`invite_delivery` at attempts 0 is **correct** and is not a fourth defect: 0035
made "for a resume-backed link, its ingestion is `ready`" a prerequisite inside
`claim_ashby_operation`, so the operation is never selected and never charged.
That is the PR #66 repair working as designed, and this change does not touch
it — `ashby-resume-shell.test.ts` proves a shell plus a `failed_review`
ingestion still cannot produce an invite.

---

## 2. What now happens

### At import
`runImport` binds exactly one **PII-minimal candidate shell** through the same
`bindLinkColumn('candidate_id', …)` CAS the ready path uses:

| column | value |
|---|---|
| `role_id`, `owner_id` | from the job mapping (no new ownership path) |
| `status` | `queued` — already a member of `chk_candidates_status` (0004) |
| `ats_source` | `ashby` |
| `name`, `email`, `phone_raw`, `parsed`, `resume_id`, `ats_external_id` | **NULL** |

A shell failure returns `shell_unbound` and the import **queue job throws**
(`ashby_import_shell_unbound`), so the durable job cannot complete without the
row that makes the application visible. Every step of `runImport` is idempotent,
so the queue's ordinary bounded retry is safe; an exhausted job dead-letters
loudly. A terminal application or a mapping paused between the decision and the
write is `skipped`, not failed — there is genuinely nothing to own.

Identity is unchanged and application-centric: **two applications from the same
human remain two candidates**, and no lookup or merge by email or phone exists
anywhere on this path.

### At parse
Failures are mapped to ten stable codes by the parser's fixed class/detail
literals — never a message, a stack, child `stderr`, or document text:

| code | meaning | disposition |
|---|---|---|
| `parse_timeout` | child killed by the wall-clock timeout | **defer** |
| `parse_overload` | bounded pool refused the submission | **defer** |
| `parse_spawn_error` | the child could not be spawned | rest (broken deployment) |
| `parse_child_exit` | non-zero child exit | rest (broken deployment) |
| `parse_asset_missing` | compiled child asset absent | rest (broken deployment) |
| `parse_output_exceeded` | child exceeded the 500 KiB stdout bound | rest (verdict) |
| `parse_no_output` | child produced nothing | rest (verdict) |
| `parse_bad_output` | child produced non-JSON | rest (verdict) |
| `parse_extract_failed` | extraction failed on this document | rest (verdict) |
| `parse_error` | **unknown** — deliberately unchanged | rest |

`parse_error` is retained as the honest unknown. A failure the classifier does
not recognise is not "nearly" classified.

### The deferral, and its bound
Only the two availability codes defer. A deferral:

- emits **no** state transition, so the row keeps `extracting` and gains no
  failure reason (nothing downstream reads a wait as work needing a human);
- **wipes the resume bytes**, like every other exit;
- returns the row to `queued` through `defer_ashby_ingestion_parse` — the only
  function permitted to perform `extracting -> queued`;
- **charges an attempt** against the unchanged five-requeue ceiling;
- has the queue **refund** the job attempt the claim charged (a wait is not a
  failure);
- is bounded by a **wall clock** derived from the job's own `createdAt`
  (1 hour). Past it the outcome becomes a loud `failed_review` /
  `parse_defer_deadline`. Wall clock, not a defer counter — a counter that
  gates a control needs a reset lifecycle or it becomes a one-way latch.

The bound ships in the same change as the deferral, on purpose.

`advance_ashby_ingestion` **refuses** `extracting -> queued` outright, so a
redelivered webhook (which calls it unconditionally) can never re-download a
resume that is mid-parse.

### At `ready` — persistence happens BEFORE the terminal transition

`ready` is **terminal** in the 0029 machine. Materializing the candidate after
it was already durable meant a single transient database fault left a candidate
with `name: null, email: null` for ever while the durable row — and the
candidates list — reported the ingestion finished. Nothing could repair it: no
automatic path re-runs a terminal ingestion, and the audited recovery requires
`failed_review`, so it answered `not_recoverable`.

So the durable `ready` transition is now the **last** thing that happens, and
only after the approved candidate/resume rows are written. A persistence
failure writes `failed_review` / **`materialize_failed`** instead — truthful,
visible, and recoverable through two doors that are **not** equally reliable:

- the **audited admin retry** below. This is the reliable door: it moves the
  row *and* admits the `ashby.ingestion` job in the **same database
  transaction** (0040), so a successful retry always leaves live, claimable
  work;
- the **generic** requeue (`advance_ashby_ingestion … 'queued'`), which the
  import path calls when a signal arrives. It repairs the row automatically
  **only when a genuinely new provider event produces a new signal** — a
  stage change that mints a receipt the 0030 outbox has not already seen.

> **Do not rely on redelivery or reconciliation for an unchanged
> application.** Once an application has been imported, its event receipt is
> `processed`; the 0030 outbox suppresses re-drive on a terminal receipt, and
> reconciliation keys on (application, stage) while a webhook redelivery keys
> on the same provider action id. An unchanged, already-linked application
> therefore mints no new receipt, produces no `ashby.signal` job, and so no
> `ashby.import` and no `ashby.ingestion` job — every pass, forever. Before
> 0040 that made the operator retry a bookkeeping-only action: the row went to
> `queued`, left the `ingestionFailedParse` queue that was watching it, and
> nothing was ever scheduled. **The audited retry is the door; the automatic
> self-heal is a bonus that only a new event can deliver.**

Reaching `ready` at all therefore means the candidate is already populated.
**A blank `ready` row can no longer be written.**

The ready path **updates the shell in place** under a CAS on
`resume_id is null`, so running it twice writes once and never leaves a
duplicate resume row. The update is an allowlist of parse-derived fields:
`role_id`, `owner_id`, `status` and `ats_source` are deliberately absent — a
parse completing is not an event that may revise ownership or funnel position.
A link bound before the shell existed still takes the original create path.

---

## 3. Operator: recovering a parse-class `failed_review`

### Step 1 — see the queue
`GET /api/integrations/ashby/mission-control/health` reports
`backlog.ingestionFailedParse`: resume ingestions rested on a `parse_*` reason
on a live application.

> `materialize_failed` does **not** match that `parse_*` counter — it is a
> different class and the counter's name would become untruthful. It is still
> visible: `backlog.operationsBlockedFailedIngestion` counts invites blocked
> behind **any** `failed_review` ingestion and **does** degrade the health
> verdict, so a materialization failure that does not self-heal is surfaced
> there. It counts the legacy generic `parse_error` and every
sub-classified code alike.

It is **reported and not wired into the degradation verdict**: a genuinely
unparseable document belongs in this number. It is a queue you work, not an
alarm. (`operationsBlockedFailedIngestion` remains the alarm for an invite
blocked behind any failed ingestion.)

### Step 2 — read the specific code
`GET …/mission-control/workflows` shows `ingestionState`. The `failed_reason`
itself is intentionally **not** exposed on any API surface; read it from the
database when you need it:

```sql
select failed_reason, attempts, updated_at
  from screening_v2.ashby_resume_ingestions
 where application_link_id = '<uuid>';
```

### Step 3 — decide, then retry
```
POST /api/integrations/ashby/mission-control/ingestions/<applicationLinkId>/retry
```
Admin only. Audited (`ashby_ingestion_parse_recovery`, carrying the matched
reason and both attempt counts). Returns `{ok:true}` or a 409 with a stable
status.

**It is not a counter reset.** It performs the ordinary
`failed_review -> queued` transition and charges an attempt against the same
five-requeue ceiling, so an exhausted row answers `retry_exhausted` and stays
rested. This is deliberately different from 0036, which zeroes the counter for a
transport defect proven to have recorded one fault five times.

**It is atomic** (0040): the transition, the attempt charge, the audit row and
the `ashby.ingestion` queue job are one transaction, and a concurrent second
click is refused with `not_recoverable` rather than charging a second attempt or
admitting a second job.

Two refusals are specific to the queue admission, and neither spends anything:

| 409 `error` | meaning | what to do |
|---|---|---|
| `ingestion_job_in_flight` | a worker has already claimed an `ashby.ingestion` job for this link — the row is `failed_review` only because the handler has not returned yet | normally clears within one lease; see below if it persists |
| a 500 `mission_control_action_error` on this route | the queue job could not be made durable, so the whole recovery rolled back | retry; the row is still `failed_review` with its full budget |

#### When `ingestion_job_in_flight` does not clear

The refusal is honest — the dedup index forbids a second live job while one is
`active`, so the recovery cannot admit work and will not pretend it did. But the
only thing that returns an `active` job to `pending` is
`reclaim_expired_jobs` (0028), and **that runs only from the `reclaim` scheduler
loop inside `createAshbyWorkers`**. With `ASHBY_RUNTIME_ENABLED` false — the
shipped default — nothing sweeps expired leases, so a job left `active` by a
machine that stopped mid-claim (the Fly `auto_stop_machines` case that loop
exists for) pins the row at `ingestion_job_in_flight` indefinitely.

Diagnose before waiting any longer:

```sql
select status, lease_owner, lease_expires_at, attempts, max_attempts
  from screening_v2.job_queue
 where dedup_key = 'ashby:ingestion:<applicationLinkId>'
   and status in ('pending','active','delayed');
```

- `status = 'active'` with `lease_expires_at` **in the future** — a worker
  genuinely holds it. Wait out the lease and retry; nothing is wrong.
- `status = 'active'` with `lease_expires_at` **in the past** — the claim is
  wedged. It is *eligible* for reclaim (every Ashby claim goes through
  `claim_job`, which always stamps a lease), but reclaim only runs while the
  runtime does. **Re-enable the Ashby runtime** and let the `reclaim` loop
  requeue it — one pass returns it to `pending`, or dead-letters it if its job
  attempts are exhausted, and the retry then succeeds normally.
- **no row at all** — nothing is in flight; the refusal came from a job that
  completed between your two clicks. Retry immediately.

Do not clear the row by hand. A manual `update … set status='completed'` leaves
the ingestion `queued` with nothing runnable, which is the exact defect 0040
exists to remove.

| `failed_reason` | retryable here? |
|---|---|
| `parse_timeout`, `parse_overload` | yes |
| `parse_spawn_error`, `parse_child_exit`, `parse_asset_missing` | yes — fix the deployment first |
| `parse_defer_deadline`, `parse_defer_exhausted`, `parse_defer_unavailable` | yes |
| `parse_defer_clock_invalid` (the job timestamp was unparseable, so the wall-clock bound could not be computed and the wait was stopped rather than left unbounded) | yes |
| `materialize_failed` (the parse succeeded; writing the approved candidate/resume rows did not) | **yes** — and it additionally self-heals if a genuinely NEW stage-change event arrives; a redelivery or re-observation of the same event does **not** repair it |
| `parse_error` (legacy) | **yes — one bounded retry, so the new classifier can NAME it** |
| `parse_extract_failed`, `parse_bad_output`, `parse_no_output`, `parse_output_exceeded` | **no** — document verdict |
| `no_extractable_fields`, `guard_*`, `scan_infected` | **no** |
| transport (`fetch_*`) | no — that is 0036's `reset_ashby_ingestion_attempts` |

A refused document verdict is not a gap to widen the allowlist for. The honest
recovery for a genuinely malformed, encrypted or unsupported document is a new
application carrying a valid document, plus an operator note. **Malformed,
encrypted and unsupported documents remain `needs_review`. No heap or timeout
value makes them acceptable, and none should.**

### Step 4 — observe
The retried ingestion re-enters `queued` **and a live `ashby.ingestion` job is
admitted in the same transaction** (0040), so an ordinary ingestion worker
claims it on its next poll. If the RPC answers `ok`, that job exists; if the
enqueue could not be made durable, the whole recovery rolls back and the row
stays in `failed_review` with its attempt budget intact — the retry never
reports work it did not schedule. Confirm with:

```sql
select status, attempts, max_attempts, scheduled_at
  from screening_v2.job_queue
 where dedup_key = 'ashby:ingestion:<applicationLinkId>'
   and status in ('pending','active','delayed');
```

A cold scanner does **not** consume the job: the readiness gate holds the claim
before anything is downloaded, so the row waits in `queued` at no cost.

If it reaches `ready`:

- the **existing shell candidate is populated in place** — no second row;
- the 0035 invite prerequisite then holds and exactly one manual invite becomes
  available through the ordinary operation worker.

Zero stage moves. Zero emails. This route issues neither.

---

## 4. Parser configuration

Both values are read and **clamped** inside `lib/resume-parser.ts`, so a typo
degrades to the built-in default rather than taking ingestion down. Neither is a
secret; both live in `fly.toml [env]`.

| variable | code default | production | clamp |
|---|---|---|---|
| `RESUME_PARSER_TIMEOUT_MS` | 30 000 | **120 000** | [1 000, 300 000] |
| `RESUME_PARSER_CHILD_HEAP_MB` | 256 | **512** | [128, 1 024] |

The timeout matches the scanner's already-corrected shared-CPU value: the same
single shared vCPU may be mid-`clamscan` (~1 GiB of signatures) when a parse
starts, and 30 s was chosen before that was true. The heap cap was previously a
hard literal; pdf.js materialises font/glyph tables that make 256 MiB tight for
a real-world PDF on a `shared/1cpu/2048MB` machine.

Before this change `RESUME_PARSER_TIMEOUT_MS` was honoured by the synchronous
HTTP resume route only — the Ashby ingestion path reaches the parser through
`createResumeParserPool()` with no config and got the 30 s built-in. Both
callers honour both values now.

Every other control is unchanged and re-asserted by test: the magic/MIME guard
runs before the parse, the 25 MiB input cap, the 500 KiB stdout cap, the
50 000-character text cap, `shell:false`, bytes via binary stdin (never argv),
discarded stderr, the fail-closed compiled-asset check, and the pool's
concurrency/queue caps.

---

## 5. The honest limit

**This change does not claim to have fixed the canary's parser failure.** The
canary's row says `parse_error`, which by construction names nothing. What ships
here is the classification that will name it on the next run, evidence-led
headroom on the two suspected bounds, and a bounded audited path to re-run that
specific row so the name is produced.

Closing that gate needs, in order:

1. this PR deployed;
2. the canary's row retried through §3 (its reason is the legacy `parse_error`,
   which the allowlist admits for exactly this purpose);
3. the resulting specific `parse_*` code read from the database;
4. only then a targeted parser change, if the named code calls for one.

Until step 3 produces a code, no cause is asserted anywhere in this change.

---

## 6. Known residual — a doubly-failed write can rest at `structuring`

Stated plainly rather than left to be discovered. If the persistence fails
**and** the subsequent `failed_review` write also fails, the row rests at
`structuring`. `structuring` has no edge back to `queued`, so that row needs
operator attention.

Two things bound it. First, it is **truthful**: the row never claims `ready`,
so the blank-`ready` defect this repair closes cannot recur through it. Second,
it is the **pre-existing** shape shared by every `failIngestion` call site in
this worker — the scanner-deferral paths have behaved this way since before
this change, and it is not made worse here. Repairing it properly means giving
`structuring` a guarded recovery edge, which is a separate, deliberately-scoped
migration rather than something to bolt onto this one.

Reaching it requires two independent database failures in the same job.

## 7. Residual gates (not closable by code)

| gate | owner | status |
|---|---|---|
| Ashby runtime activation (`ASHBY_RUNTIME_ENABLED`, API key, webhook secret) | owner / ops | pending — disabled by default |
| `ASHBY_RESUME_HOSTS` SSRF allowlist (empty ⇒ fail-closed) | owner / ops | pending |
| Deployment of this PR before the canary retry in §5 | owner | blocking §5 steps 2–4 |
| Real-candidate data / production canary | legal / security | out of scope — synthetic only |
| Email delivery channel | provider + domain verification | pending; `gates.email` stays false/false |
| `consent_at` capture semantics | legal D-010 | pending — the shell leaves it null and does not change this |
| Web surfacing of `resume_review` | follow-up PR | not in PR-A; the API field is additive and nullable |
