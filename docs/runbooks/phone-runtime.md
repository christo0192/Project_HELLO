# Runbook — phone runtime orchestration (P5)

**Status: SHIPS DISABLED. With the flags at their defaults the runtime is never
constructed** — no scheduler, no queue runner, no timer, no database read, no queue
claim, no LiveKit object and no provider call. That is a property of *construction*,
not of a branch somewhere inside a loop, and §1 says exactly where it is enforced.

Read `phone-safe-dialer.md` (P4a — the dial controller and the consent gate) and
`phone-assessment-resume.md` (P4b — the durable assessment) first. This runbook assumes
both and does not repeat them. `phone-webhook-ingress.md` (P3) owns the inbound half.

| Piece | Where |
|---|---|
| The package | `app/api/src/lib/phone-runtime/` (8 files, inventory pinned) |
| Construction / start / stop | `app/api/src/index.ts` |
| Health surface | `app/api/src/routes/phone.ts` `GET /health`, the `runtime` block |
| Contract | `app/api/openapi/openapi.yaml` — `PhoneRuntimeState`, `PhoneRuntimeLoopState`, `PhoneRuntimeDueSummary` |
| Knobs | `app/api/.env.example`, `config/environment.schema.json` |
| Tests | `phone-runtime-core.test.ts`, `phone-runtime-structural.test.ts` |

---

## 1. What P5 is, and what it deliberately is NOT

**Everything ships disabled.** `createPhoneRuntime` opens with
`if (!isPhoneRuntimeActive(config)) return null;`, and `isPhoneRuntimeActive` is
`screeningEnabled && runtimeEnabled` — `PHONE_SCREENING_ENABLED` and
`PHONE_RUNTIME_ENABLED`, both `false` by default. Nothing below that line executes:
the `Queue`, the `PgAdapter`, the queue runner, the loop scheduler, the Supabase-backed
reader, the LiveKit room clients — none of them are constructed. `index.ts` therefore
holds `null`, `scheduler.start()` is never reached, and `registerPhoneRuntime` is never
called. A deployment that takes this build and changes no environment variable performs
**exactly the same work it performed before it**.

Importing the package changes nothing either. `index.ts` is explicit named re-exports;
`config.ts` documents that importing it performs no I/O, opens no connection and arms no
timer; the loader takes an injectable `source` map. The structural suite asserts that no
file in the package contains `setInterval(`, `setTimeout(` or `setImmediate(` at all —
the cadence comes from `lib/scheduler.ts` and the heartbeat from `lib/queue/runner.ts`,
both of which are registered, stoppable and observable.

There is a **third** switch, one level in: the due pass itself refuses to run when
`PHONE_DIAL_MODE` is `off`, which is also the default (§4). So the shipped configuration
is disabled twice over — the runtime is not constructed, and even if it were, the only
loop that can cause a call would return its zero result untouched.

**What P5 is.** The thing P4a and P4b deliberately left out: a *caller*. P4a shipped
`dialPhoneAttempt` with no production caller and said so; P3 shipped
`runPhoneReconciliation` uncalled. P5 arms **seven** supervised loops that drive the work
already written and reviewed, and adds one genuinely new capability — reading a
candidate's `phone_e164` out of SQL (§9). Five of those loops shipped with P5; two
(`phone-dayroll`, `phone-stranded`) arrived with `0045`, along with the attempt-lease
heartbeat, after review found that two transitions `0042` had assigned to P5 still had no
driver at all.

**What P5 is NOT:**

* **It is not a second copy of the admission gate.** The due pass decides *candidacy*
  only — which rows are put in front of `admit_phone_attempt`. Permission is decided
  there, under the advisory lock, where the halt, the IST window, consent, suppression,
  the per-IST-day index, the fleet cap and the number's validity are re-checked together.
  Two copies of a gate are two things that can disagree, and only one of them is enforced.
* **It is not a leader.** There is no election, no lock and no single-writer claim
  anywhere in this package. Two replicas with the flags on both run due passes. The
  correctness of that rests entirely on `admit_phone_attempt`'s advisory lock,
  `uq_phone_attempts_one_live` and `uq_phone_attempts_one_per_ist_day` — see §12.
* **It is not a fleet-wide view.** The health block is process-local and says so in three
  places (§10).
* **It does not change the disclosure gate, the purge, the budgets, the state machine or
  the scoring path.** Those are `0042`, `0043` and `0044`. P5 adds no SQL and no
  migration.
* **It does not dial from the queue handler.** §5, which is the section to read if you
  read only one.

---

## 2. The seven loops

All seven are registered on one `createLoopScheduler` with `metricPrefix: 'phone'`.
`start()` staggers each loop's first tick by up to one whole interval, which is why
staleness is measured from the later of `lastTickAt` and `startedAt` (§10).

**Two of the seven arrived with `0045`** — `phone-dayroll` and `phone-stranded`.
`phone-dayroll` drives transition **#27**, which `0042` had assigned to P5 and which had no
driver at all; `phone-stranded` resolves the wedge that left engagements pointing at an
ended session. They are the two loop names that can appear in `sweeps_not_ok` alongside
`reclaim`, `expire` and `reconcile` (§10), so an operator reading a degrade reason will find
them here.

| Loop | Cadence knob | Bound | What it does |
|---|---|---|---|
| `phone-dial` | `PHONE_RUNTIME_DUE_MS` | `PHONE_RUNTIME_JOB_LEASE_SECONDS`, concurrency 1 | Drains the durable `phone.dial` queue. **Places no call.** |
| `phone-due` | `PHONE_RUNTIME_DUE_MS` | `PHONE_RUNTIME_DUE_LIMIT` engagements per pass | Offers due engagements to admission. The only loop that can cause a call. |
| `phone-reclaim` | `PHONE_RUNTIME_RECLAIM_MS` | `PHONE_RUNTIME_RECLAIM_LIMIT` rows per pass | `reclaim_phone_attempt_leases` — expired **attempt** leases, i.e. leaked fleet slots. |
| `phone-maintain` | `PHONE_RUNTIME_EXPIRE_MS` | `PHONE_RUNTIME_RECLAIM_LIMIT` rows per pass | `expire_phone_appointments`, and nothing else. |
| `phone-dayroll` | `PHONE_RUNTIME_EXPIRE_MS` | `PHONE_RUNTIME_RECLAIM_LIMIT` rows per pass | **`0045`.** `sweep_phone_day_rolled` — posts `day.rolled`, the only edge out of `awaiting_retry`. **Places no call.** |
| `phone-stranded` | `PHONE_RUNTIME_EXPIRE_MS` | `PHONE_RUNTIME_RECLAIM_LIMIT` rows per pass | **`0045`.** `sweep_phone_stranded_sessions` — engagements pointing at an already-ended session. **Redials nobody.** |
| `phone-reconcile` | `PHONE_RUNTIME_RECONCILE_MS` | Its own defaults — 25 attempts, 6 h lookback | `runPhoneReconciliation` — P3's dropped-webhook sweep. |

**`phone-dayroll`** drives transition **#27**, which is the only edge out of
`awaiting_retry`. Nothing in this repository had ever posted `day.rolled`, so before `0045`
the FIRST unanswered call ended the ladder and the contract's "three attempts on three
distinct IST dates" was unreachable. It runs on the **expire** cadence rather than a knob
of its own, deliberately: a day boundary moves once a day, so anything under an hour is
already far more often than the thing it watches for. Its dedup id is
`dayroll:<engagement>:<ist_date>` — passed explicitly, because the `internal:` default is
identical every day and would have wedged the ladder after one roll.

**`phone-stranded`** removes the residue the heartbeat's absence used to create: a
screening that was conducted and scored, whose engagement left `in_call` before the
completion arrived, points at a terminal session, so `ensureSession` refuses and the row is
skipped `no_session` on every pass for ever. A terminal session **with** a phone assessment
row completes its engagement; one **without** becomes a truthful `failed`. It never dials.

Both new loops take a **sweep claim** before working (`claim_phone_sweep`) — see the
replica note in §12. A claim held by another replica is a healthy answer and holds the
cadence; a *broken* claim backs off rather than hot-spinning.

**`phone-dial`** exists to drain the queue, not to work it. `admit_phone_attempt`
enqueues a `phone.dial` job *inside* the admitting transaction; an admission that cannot
schedule work raises `phone_dial_enqueue_failed` and rolls the whole thing back, so
`dialing` never exists without a queue row. Without a consumer, every admission would
leave a `pending` row nothing completes — `uq_job_queue_dedup_active` covers `pending`,
and `reclaim_phone_attempt_leases` only completes jobs for attempts *it* reclaims, so a
normally-ended attempt's job would sit in the queue forever and the backlog would grow one
row per call placed. There is no separate poll knob: the loop's `intervalMs` is `dueMs`
and that is the only thing setting the cadence. The runner is *also* handed
`pollMs: dueMs`, but that option is dead — see the reading hazard in §12 before you
believe the two answers you will find.

**`phone-due`** is the only loop that can reach a carrier. Its shape is: the three
switches and then the halt gate (§4) → `listDueEngagements` → the **IST window
preflight** (§8) → one filter pass that resolves the attempt kind, applies the runtime
clock, allows each candidate at most one offer per pass and, for `scheduled` rows,
applies the appointment gate → **then** fetch numbers, once, for the survivors only →
ensure a session → `dialPhoneAttempt`. The skip codes, in the order they can be emitted:
`outside_ist_window`, `unknown_state`, `not_yet_due`, `candidate_already_offered`,
`appointment_not_due`, `no_dialable_number`, `no_session` — the seven members of
`PHONE_DUE_SKIPS` (`due-loop.ts`), which is the type's single source: `PhoneDueSkip` is
`typeof PHONE_DUE_SKIPS[number]`, so a code that is not in that array will not compile.

It is no longer the only loop consulting the halt: `phone-dial` now refuses to *claim*
under one too, through the queue runner's `shouldClaim` (§4). `phone-due` is still the
only one whose halt decision is reported as a `last_due.status`.

**Every time-based gate runs before a single number is read** (§9). The attempt kind is
resolved once, in that filter pass, and carried forward with the row rather than
recomputed.

`listDueEngagements` selects `terminal_at is null`, state in `eligible` / `reconnecting` /
`scheduled`, ordered `updated_at` ascending — and applies a **clock predicate in SQL**:

```
.or('state.eq.reconnecting,next_eligible_at.is.null,next_eligible_at.lte.<nowIso>')
```

That predicate is not redundant with `dueByClock`, and deleting it as duplication would
be a real bug. The batch is **bounded** (`dueLimit` defaults to 3) and ordered by
`updated_at`, so without it three rows whose `next_eligible_at` is hours away would fill
every batch forever and starve the rows that are genuinely due. A filter applied only
*after* the read can observe that starvation but cannot cure it.

**The `reconnecting` disjunct is the part that looks like a mistake and is not.** A
`reconnecting` row's due time does not live in `next_eligible_at` at all — `0042` leaves
the reconnect backoff to a worker clock, so `dueByClock` derives it from `updated_at`.
Written as three chained filters instead of one `or`, the predicate would hide **every**
reconnect from the pass.

Three timing rules genuinely belong to this loop because `0042` says so: the **reconnect
backoff** (transition #26 — "a worker clock rather than a database fact", so this is the
only place it exists; a `reconnecting` row is due `PHONE_RECONNECT_BACKOFF_SECONDS` after
its `updated_at`, default 120 s), the moment a **scheduled** appointment becomes due, and
the **batch size**. `next_eligible_at` is checked here too, but that one is borrowed — the
database enforces it as well, and checking early saves a refusal rather than replacing one.

**`phone-reclaim` is not optional.** `0042` states outright that the 10-slot cap's
correctness depends on P5 heartbeating. A lapsed attempt lease otherwise holds one of ten
fleet slots against every other candidate until a human notices, and
`uq_phone_attempts_one_live` blocks every future admission for that engagement — the PR
#70 wedge. It charges **no budget**: a dead worker is our failure, not the candidate's
attempt. Its cadence is deliberately faster than the due cadence is slow, for exactly this
reason: a due engagement that waits one extra tick has lost nothing.

**`phone-maintain` does exactly one thing:** expire overdue appointments. That is a cheap
local `UPDATE` and nothing more.

**`phone-reconcile` is separate, and on its own knob.** The dropped-webhook sweep was
briefly welded into `phone-maintain`, and the split is deliberate on two grounds. The
first is honesty about configuration: sharing a loop made `PHONE_RUNTIME_RECONCILE_MS` a
knob that parsed, clamped, appeared in `.env.example` and the environment schema — and
moved nothing, because the sweep actually ran at `expireMs`. A configuration value that
cannot change anything is worse than an absent one, because an operator turning it during
an incident would believe they had acted. The second is that **they are different jobs at
different costs**: expiring an appointment is a local `UPDATE` against one table, while
reconciling reads **LiveKit room state for every live attempt** — a provider round trip
per row. Those want different default cadences (60 s against 120 s) and, when a provider
is flapping, an operator wants to move one without moving the other.

**The two sweepers must not overlap.** `reclaim_phone_attempt_leases` (`phone-reclaim`)
handles **expired** leases and charges nothing; `runPhoneReconciliation`
(`phone-reconcile`) handles **still-held** leases and posts outcomes that **do** charge.
Blurring them spends a candidate's anti-harassment budget on our own crash. Their
selection predicates are disjoint by construction and neither is handed the other's rows.

The reconciliation is gated on the **master** switch inside itself (`isPhoneWebhookActive`
= `screeningEnabled && credentialsConfigured`), not on the runtime switch. That is
deliberate: an operator who disarms the dialer mid-incident must still be able to record
events that *terminate* in-flight attempts.

---

## 3. The seven knobs

Taken from `PHONE_RUNTIME_BOUNDS` in `lib/phone-runtime/config.ts`. Every value is
clamped into its bound; a malformed value (anything that is not a plain run of up to
twelve digits) reads as the **default** and **never throws**. A runtime that refuses to
start because someone typed `PHONE_RUNTIME_DUE_MS=fast` is a runtime that stops
reclaiming leases, and a stuck lease holds a fleet slot until a human notices.

| Variable | Default | Min | Max | Going to the minimum | Going to the maximum |
|---|---|---|---|---|---|
| `PHONE_RUNTIME_DUE_MS` | 15 000 | 1 000 | 300 000 | A due pass **and** a queue poll every second — a `phone_engagements` read every second per replica, and up to `DUE_LIMIT` admissions per second competing for ten fleet slots. | Five minutes between passes. A reconnect whose backoff expired is left waiting up to 5 min, and a `phone.dial` job sits undrained for the same period. |
| `PHONE_RUNTIME_RECLAIM_MS` | 30 000 | 5 000 | 600 000 | A `reclaim_phone_attempt_leases` call every 5 s. Cheap but not free; it takes engagement-then-attempt row locks. | Ten minutes. A leaked fleet slot stays leaked for up to 10 min, and with several leaked the lane can sit at `at_capacity` refusing every admission. |
| `PHONE_RUNTIME_RECONCILE_MS` | 60 000 | 10 000 | 900 000 | A dropped-webhook sweep every 10 s. Each sweep reads **LiveKit room state per live attempt**, so this is the knob most likely to rate-limit you against the provider. | 15 minutes. A dropped `sip.*` webhook goes unrecovered that long, and an attempt whose call really ended sits live — holding a fleet slot — until either this sweep or the lease reclaim catches it. |
| `PHONE_RUNTIME_EXPIRE_MS` | 120 000 | 10 000 | 900 000 | An `expire_phone_appointments` call every 10 s. Cheap — a bounded local `UPDATE`, no provider traffic. | 15 minutes. An overdue appointment stays `overdue` on the health surface, and reads as `appointments_overdue` in `reasons`, for up to that long. |
| `PHONE_RUNTIME_DUE_LIMIT` | 3 | 1 | 25 | One engagement offered per pass. Safe; the lane drains slowly. | 25 per pass against a **10-slot** fleet cap: a burst exhausts the cap and every further admission answers `at_capacity`. Each row here is a call to a person, which is why the default is 3. |
| `PHONE_RUNTIME_RECLAIM_LIMIT` | 25 | 1 | 200 | One lease reclaimed and one appointment expired per pass — a backlog of leaked slots drains one per `RECLAIM_MS`. | 200 rows per pass; the RPC itself clamps to 500, so this is within its envelope, but it is a longer lock-holding transaction. |
| `PHONE_RUNTIME_JOB_LEASE_SECONDS` | 60 | 5 | 900 | A 5 s **queue** lease with a heartbeat every ~1.7 s. A GC pause longer than the lease loses the claim and the job is re-claimed elsewhere. | 15 minutes. A process that dies holding a claim leaves that job unavailable for up to 15 min — harmless here, because the handler does no work (§5). |

Independently, `lib/phone-screening/config.ts` owns `PHONE_SLOT_SECONDS`,
`PHONE_RECONNECT_BACKOFF_SECONDS`, `PHONE_RING_TIMEOUT_SECONDS`, `PHONE_LEASE_SECONDS`
and the webhook bounds; `lib/phone-runtime/config.ts` deliberately re-declares none of
them. Neither file declares the IST window or the fleet cap — those live in SQL (§8).

---

## 4. The halt gate

It is evaluated **first** in the due pass, before any read, and it **fails closed**.

```
if (!screeningEnabled || !runtimeEnabled || dialMode === 'off') return ZERO;  // 'disabled'

let halted = true;                                        // ← the initial value IS the policy
try {
  const backlog = await deps.stores.backlog({ now });
  halted = backlog.admission?.halted !== false
        || backlog.admission?.controlPresent !== true;
} catch {
  halted = true;
}
if (halted) return { ...ZERO, status: 'halted' };
```

### `dialMode === 'off'` is a third switch, and it sits with the other two

Before the halt is even consulted, the pass returns its disabled zero — touching no seam
at all — when `PHONE_DIAL_MODE` is `off`. That placement is deliberate and it is worth
understanding why `off` needed its own gate at all, given that it already reached no
carrier.

The dial controller does **not** gate on the mode. It gates on the two flags and a
configured trunk, then **admits**, and only afterwards hands the originate to whichever
client `resolvePhoneSipClient` chose — which for `off` is the synthetic one. So `off`
always guaranteed no carrier was reached. What it did **not** guarantee, once P5 supplied
the first production caller, is that nothing was *spent*: admission writes a real
`phone_call_attempts` row, takes one of the ten fleet slots, and charges the candidate's
IST-day index and no-answer budget. An operator who set `off` and armed the runtime
expecting a dry run would silently burn a day of every due candidate's budget against
calls that never happened — and the per-IST-day index means those candidates would not be
re-dialled until the next day.

**`synthetic` is deliberately NOT gated here.** Rehearsing admission — a real attempt row,
a real fleet slot, a real budget charge, against a client that structurally cannot reach a
carrier — is the entire point of that mode. `off` means off; `synthetic` means rehearse.

### The halt itself

Three distinct conditions all mean **halted**:

1. **An explicit halt.** `POST /api/phone/halt` set the control singleton;
   `backlog.admission.halted` is `true`.
2. **A missing control singleton.** `phone_backlog` already reports a missing row as
   `halted: true`, and the port's own contract says so: *"A MISSING singleton reports
   halted TRUE. Never read as running normally."* The due pass additionally requires
   `controlPresent === true`, so an absent row stops the lane on both counts.
3. **A thrown backlog read.** The `catch` sets `halted = true`.

**The throw case is the one that matters**, and it is the one a naive implementation gets
wrong. Cases 1 and 2 are answers — the database told us something, and it told us to stop.
Case 3 is the *absence* of an answer, and the tempting reading of "we could not check" is
"carry on and let admission decide". That reading is wrong here for a specific reason: the
thing on the other side of this gate is a telephone call to a person. A transient
PostgREST failure, a connection-pool exhaustion or a network partition is *exactly* the
condition under which a lane should be at its most conservative, and it is also exactly
the condition under which a fail-open gate becomes invisible — the loop keeps churning,
the health surface shows ticks, and nothing says the halt was never consulted.

Admission would refuse a halted lane anyway. The pass still asks first, for two reasons
the code states: a halted lane should not be minting `call_sessions` rows on the way to a
refusal, and an operator who has pulled the switch is entitled to see the loops go quiet
rather than keep churning.

**This is deliberately the opposite of the recording lane.** `lib/recording/halt.ts`
fails **open** and documents why. The inversion is the point, and it should not be
"harmonised" by anyone tidying the two lanes into one pattern.

A halted pass reaches **no write**: no `listDueEngagements`, no number read, no session
creation, no dial. `phone-runtime-core.test.ts` asserts that against fakes with call
counters, because "nothing was called" is only an assertion if something is counting.

### The queue runner's `shouldClaim` — the same gate, on the other loop

`createQueueRunner` is now passed a `shouldClaim` (`runtime.ts`, `admitsClaims`). For one
commit this file's header promised one and none was passed, which is the worst of both:
a reader concludes the dial loop is halt-gated and it is not.

* **The same three shapes.** `haltAdmits = backlog.admission?.halted === false &&
  backlog.admission?.controlPresent === true`, with a `catch` that sets it `false`.
  Written as equalities against `false`/`true` rather than as negations, so an
  `undefined` field cannot read as permission.
* **Fail-closed, and cold-start closed.** `haltAdmits` initialises to `false`, so a
  process that has never successfully read the control row claims **nothing**.
* **Cached for 5 s** (`HALT_CACHE_MS`), because `shouldClaim` is consulted before *every*
  claim and its contract requires a cheap consult. At the shipped `dueMs` of 15 s the
  cache has always expired by the next `phone-dial` tick, so in practice each tick pays
  one backlog read.
* **This is deliberately the opposite of `lib/recording/runtime.ts`**, which passes
  `shouldClaim: () => halt.admits()` over a halt that fails **open**. The inversion is
  the point: the thing on the other side of this lane's gate is a telephone call to a
  person, and the cost of pausing a queue whose handler is a no-op (§5) is nothing at all.

A refused claim leaves the job `pending`: no attempt is spent, no lease churns, and the
row is still there when the halt clears.

---

## 5. Why the dial job handler never dials

This is the single most counter-intuitive decision in P5. It is not an omission and it is
not "to be wired up later"; a handler that dialled would be a defect.

**The setup.** `admit_phone_attempt` enqueues a `phone.dial` job inside the transaction
that creates the attempt, moves the engagement to `dialing` and takes the fleet slot. That
is what makes the intent durable. But admission is not reached on its own — it is reached
*through* `dialPhoneAttempt`, the P4a controller, which admits and then originates **in
the same call**. By the time the job can be claimed, the originate for its attempt has
already been placed, or the process that would have placed it is gone.

**So there are exactly two states the handler can find:**

1. The dial was placed. The attempt is live, or has already ended. Nothing is owed; the
   job is a spent durability record.
2. The process died between the admission commit and the originate. The attempt is live
   and no call is in flight.

**The handler cannot tell them apart.** A job claimed while an originate is still in
flight looks *identical* to a job claimed after the process that owned it died — same row,
same payload, same attempt state. So a handler that dialled in case 2 would also dial in
case 1, and case 1 is a candidate whose phone is **ringing right now**. On a lane whose
`uq_phone_attempts_one_per_ist_day` index exists to stop exactly that, a maybe-duplicate
call to a real person is not an acceptable trade for a faster retry.

**The dial happens in the due pass instead** — one place, synchronous with the admission
that authorised it, under the halt gate.

**Crash recovery is the attempt lease lapsing, not a retry.** Case 2 is already recovered
by machinery that has been reviewed and that charges nothing:

```
process dies  ->  the ATTEMPT lease is not heartbeaten  ->  it expires
              ->  reclaim_phone_attempt_leases (the phone-reclaim loop)
              ->  attempt 'abandoned', fleet slot freed,
                  engagement restored to prior_engagement_state (transition #30),
                  the attempt's pending/delayed phone.dial job COMPLETED
              ->  the due pass offers the engagement again
```

**No budget is charged.** The reclaimer's own audit row records
`budget_charged: false`, because a dead worker is our failure and `0042` says so in as
many words. The per-IST-day index still applies, so a reclaimed no-answer-class attempt is
re-dialled the next IST day, not immediately — that is the anti-harassment bound doing its
job, not a bug in the recovery.

**The handler exists to drain the queue.** That is its whole purpose (§2).

**A malformed payload is COMPLETED, not failed.** `isPhoneDialPayload` requires
`provider === 'phone'` and an `attemptId` matching the UUID pattern. A payload that fails
that check is counted as `malformed_payload` and the handler still **resolves** — which
makes the runner call `completeClaim`. `0040` recorded the trap this avoids: a payload the
handler cannot read is not a transient fault, so retrying it to `max_attempts` converts one
bad row into dead-letter noise and, in the meantime, wedges the queue in a retry loop. The
*count* is what an operator needs, and the count is what they get, on
`runtime.dial_jobs.malformed_payload`.

**It deliberately reads nothing.** An earlier draft read the attempt's state to label the
outcome. It was removed: the action is identical either way, and a read that cannot change
an outcome is a read a later editor will mistake for a gate.

---

## 6. The two independent lease systems

**Conflating these is a mistake, and it is the specific mistake that admits an eleventh
concurrent call.** They are different tables, different tokens, different lifetimes and
different owners. `0042`'s own column comment says it: `phone_call_attempts.lease_token`
is *"Distinct from `job_queue.lease_token`, which guards work EXECUTION and expires on a
far shorter clock."*

| | `job_queue.lease_token` (0028) | `phone_call_attempts.lease_token` (0042) |
|---|---|---|
| Guards | **Work execution** — one claim of one job by one worker | **The fleet slot** — one of the ten simultaneous live calls |
| Length | `PHONE_RUNTIME_JOB_LEASE_SECONDS`, default 60 s (5–900) | `PHONE_LEASE_SECONDS`, default **180 s** (5–900), **renewed for the whole conversation** |
| Effective lifetime | One claim — seconds | An originate, a classification and a full assessment — minutes |
| Renewed by | The queue runner's own heartbeat, at `leaseSeconds / 3` | `heartbeat_phone_attempt_by_epoch`, called by the **agent** via `POST /api/internal/phone/attempt/heartbeat` (`0045`) |
| Reclaimed by | `reclaim_expired_jobs`, queue-name-agnostic | `reclaim_phone_attempt_leases`, the `phone-reclaim` loop |
| Losing it means | The job is re-claimable by another worker | The attempt is `abandoned`, the slot is freed, the engagement is restored |

**Why they cannot be one lease.** One conversation spans an originate, a classification
and a long assessment, far beyond any single queue claim. Binding the fleet slot to the
queue lease would free the slot the moment a heartbeat lapsed — and admit an 11th call
while the 10th was still talking. `reclaim_expired_jobs` also knows nothing about
`phone_call_attempts`, so it cannot perform transition #30, and its per-pass budget is
deliberately not shared with the phone reclaimer's.

**Why they cannot be conflated in the other direction either.** Making the queue lease as
long as a conversation would leave a dead worker's job unclaimable for a quarter of an
hour, which is precisely the cost of a long `JOB_LEASE_SECONDS` — harmless *only* because
the handler does no work (§5). If the handler ever did work, that trade would change.

One consequence worth naming: `PHONE_ORIGINATE_TIMEOUT_SECONDS` must stay well below
`PHONE_LEASE_SECONDS` (`phone-safe-dialer.md` §6). That constraint is about the **attempt**
lease. `PHONE_RUNTIME_JOB_LEASE_SECONDS` has nothing to do with it, and tuning the wrong
one changes nothing about the risk it appears to address.

### Who actually renews the attempt lease, and what happens when it lapses

Before `0045` **nobody did** — the lease was extended once, pre-originate, and never again,
so any conversation outliving that single extension lost its fleet slot mid-call. `0045`
adds the missing half:

- `heartbeat_phone_attempt_by_epoch` fences on `epoch >= p_epoch`. The agent learns its
  epoch from dispatch metadata as admission minted it, and `disclosure.delivered` bumps the
  attempt row's epoch *before* the beating starts, so `>=` admits exactly the one legal
  in-attempt bump and nothing else. The session term is
  `(session_id is null or session_id = p_session_id)` on purpose: `start_phone_assessment`
  binds that column *after* the opening gate, so early beats legitimately arrive with it
  null, and a strict equality there would answer `lease_lost` to a live call.
- `POST /api/internal/phone/attempt/heartbeat` is the worker route in front of it. **The
  server owns the cadence** — it answers `next_heartbeat_seconds` as
  `max(1, floor(leaseSeconds / 3))` — so a worker cannot drift, and only a literal
  `lease_lost` from the RPC is forwarded as `lease_lost`. An unrecognised status from a
  future revision is a retryable 500, because an answer we did not understand is not
  evidence the lease is gone.
- The agent loop beats immediately, re-clamps from the server's answer rather than trusting
  its own timer, treats a raising client as an *unconfirmed* beat rather than dying
  silently, and halts on `lease_lost`. It tolerates two consecutive failures: the cadence is
  at most a third of the lease, so the smallest lease consistent with it is `2 × interval`,
  and after two failures the whole guaranteed margin is spent.

**`lease_lost` means hang up.** It is the one signal that stops a live call, which is why a
false positive on it is worse than a missed beat — and why the two loosened terms above are
loosened in the direction of *not* claiming the lease is gone.

### Why the attempt lease defaults to 180 s, and why that is ENFORCED

The attempt lease is extended **once**, pre-originate, to
`max(originateTimeoutSeconds + 15, leaseSeconds)`. After that **nobody heartbeats** until
the agent's first beat — and the agent's first beat is a long way off:

```
originate begins ── lease extended once, here, and not again
the line rings ──── up to PHONE_RING_TIMEOUT_SECONDS (45 default, 120 max)
somebody answers ── and only NOW does the opening gate start
the gate runs ───── classify.human, the spoken disclosure, the candidate's
                    answer, the `disclosure.delivered` post, and an AWAITED
                    LiveKit egress call inside that same request
the agent beats ─── first heartbeat, at last
```

At the old default of 60 the pre-originate lease was `max(75, 60) = 75 s` from the *start*
of the originate, so a candidate answering on the last ring left roughly **thirty seconds**
for a gate that spends part of it waiting on a provider. A gate that overran met an
already-lapsed lease: the first beat answered `lease_lost` and the agent hung up seconds
after the candidate had consented — and because the engagement is `in_call` by then, the
room close charged a **reconnect**, so the next leg carried the same risk.

`PHONE_OPENING_GATE_SECONDS` (60) is the allowance for that gate. It is an allowance, not a
measurement: nothing enforces it on the agent, and its only job is to size the lease. 180
covers `ringTimeoutSeconds` **at its maximum** plus a full gate, and still leaves the
published heartbeat cadence (a third of the lease) under half of it.

**The relation is a refusal, not a default.** `dialPhoneAttempt` answers
`lease_too_short_for_gate` — before it contacts the provider, and before admission, so a
misconfiguration burns no attempt, no fleet slot and no day of the candidate's budget —
whenever:

```
PHONE_LEASE_SECONDS < PHONE_RING_TIMEOUT_SECONDS + PHONE_OPENING_GATE_SECONDS
```

It refuses rather than silently stretching the lease, because a lease long enough to be
safe is a deployment decision and quietly extending it would hold fleet slots nobody
budgeted for. The consequence to know before tuning: **a lease under that sum places no
calls at all.** `.env.example` ships 180 against a 45 s ring for exactly this reason — the
old 60/45 pair is now a refusal, so a config copied from an older deployment will dial
nothing until the lease is raised.

This bound is asserted in code rather than described here because this lane has twice
shipped a bound that lived only in a paragraph — `reclaimMs` against the lease, and this
one — and had it missed both times. A default is a suggestion; a refusal is a bound.

---

## 7. The three independent budgets

All three live on `phone_engagements`, all three are CHECK-bounded, and `0042`'s table
comment says they are *"never mixed"*.

| Budget | Column | Bound | Charged |
|---|---|---|---|
| No-answer | `no_answer_attempts` | 0..3 | **At the outcome** — `sip.no_answer`, busy, voicemail (#11/#12), **whatever the attempt's `kind`** — see the exception below |
| Reconnect | `reconnects_used` | 0..3 | **At the grant** (#19) |
| Provider | `provider_failures` | 0..5 | At the outcome — `provider_error` (#13); the fifth transitions to `failed` |

**The reconnect budget is charged at the grant, not at the dial.** When an `in_call`
engagement sees `sip.participant_left` inside the IST window, `apply_phone_event` moves it
to `reconnecting` **and increments `reconnects_used` in the same transaction**.
`reconnects_used` counts drops that have been *granted* a reconnect, and the grant that
takes it to 3 is precisely the one the next admission redeems. Two consequences follow:
a granted-but-never-redeemed reconnect is still charged, and the fourth drop takes the #21
edge to terminal `failed` with `reconnect_budget_exhausted` rather than granting a fourth.
A drop **outside** the window charges nothing at all (#20) — the boundary is evaluated when
the reconnect would be *acted on*, so it becomes `scheduled` with `window_closed` instead.
The counter is reset only when a genuinely new conversation begins: an epoch bump whose
attempt kind is *not* `reconnect`. Resetting it on a reconnect's disclosure would make
"max 3 reconnects" unenforceable — every reconnect that reached `in_call` would zero it.

**An UNANSWERED RECONNECT charges the no-answer budget. This is a known divergence from
the acceptance contract's wording, and it is deliberate to leave as-is.** The charge
branches on the *event*, not on the attempt's kind — in `0045`'s `apply_phone_event`, which
is the authoritative definition:

```sql
when v_eng.state = 'dialing' and p_event_type = 'sip.originate_timeout' then
  v_att_state := 'ended'; v_outcome := 'no_answer'; v_charge := 'no_answer'; -- #12
```

There is no `v_att.kind` test on that branch, and `reconnect` is a kind that reaches
`dialing`. So a reconnect leg that rings out increments `no_answer_attempts`. The *grant*
honours the contract exactly — #19 charges `reconnects_used`, and the IST-day index
excludes `kind='reconnect'` (below) — and only the **unanswered reconnect dial** diverges.

The direction is safe: it spends the candidate's own no-answer allowance rather than
granting extra calls, so the failure mode is *fewer* rings, never more. It is left in place
because the alternative — a kind-guarded charge — means an unanswered reconnect costs
nothing at all, and a flapping call could then be redialled indefinitely on a budget that
never moves. **Whoever reconciles this should change the acceptance wording, not the
branch.** Do not "fix" it by adding a kind test without replacing the bound it removes.

**Why a reconnect does not consume the daily *attempt* budget.** Distinct from the above,
and about a different mechanism — the IST-day index, not the counter. The two are
independent because the index that bounds the daily budget **excludes `reconnect` by
construction**:

```sql
create unique index if not exists uq_phone_attempts_one_per_ist_day
  on screening_v2.phone_call_attempts(engagement_id, ist_date)
  where kind in ('initial','no_answer_retry','scheduled');
```

`kind = 'reconnect'` is not in that predicate, so a reconnect attempt is simply not a row
the index sees. That single `where` clause is the whole mechanism: it is what makes "three
immediate reconnects" and "one no-answer-class attempt per IST calendar day" two separate
budgets rather than one shared counter, and `0042`'s own comment beside the index says so.
If someone ever widens that predicate to cover `reconnect`, the second reconnect of a
flapping call fails admission with a duplicate-key refusal and the two budgets silently
collapse into one.

The runtime enforces **none** of this. It reads `no_answer_attempts` for exactly one
purpose — `dueAttemptKind` chooses `initial` when it is 0 and `no_answer_retry` when it is
not — and that is a *kind*, not a permission. `admit_phone_attempt` refuses
`kind_not_admissible` when the state and the kind disagree, so it is the only kind that
state can be admitted with.

---

## 8. The IST calling window

The permanent fallback is **09:00:00 inclusive to 21:00:00 exclusive, Asia/Kolkata,
all seven days**. The reviewed temporary override is **24/7 through September 6, 2026
inclusive**; the permanent 09:00–21:00 window resumes automatically on September 7,
2026 IST. The override is fixed in migration `0064_phone_temporary_247_window.sql`,
not an environment variable and not an operator-editable bypass.

The permanent bounds remain defined once in SQL:

```sql
phone_ist_window_open_at()  -> time '09:00:00'
phone_ist_window_close_at() -> time '21:00:00'
phone_temporary_247_until() -> date '2026-09-06'
```

`phone_ist_window_open(at)` applies the temporary all-day rule through the cutoff and
then applies the permanent bounds. `phone_next_window_open(at)` follows the same rule,
so a deferred call is never parked at a time the admission function would reject.
There is **no weekday exclusion** — Saturday and Sunday are calling days in both modes.
The API exposes `temporary_247_until_ist` so operators can see the automatic reversion.


`lib/phone-runtime/` re-declares no part of it. The window is enforced in
`admit_phone_attempt` under the advisory lock, is mirrored (never re-declared) in
`ist-window.ts`, and a structural assertion keeps its bounds out of the phone-screening
configuration. A second definition would be silent in TypeScript and enforced in SQL,
which is the drift `0042` was shaped to prevent.

**The due pass now preflights the window itself**, and it does so by *calling* the shared
predicate rather than by restating it. `due-loop.ts` takes exactly one value import from
the domain package — `istWindowOpen` from `lib/phone-screening` — which is the same
function `admission.ts:190` calls through the same effective-window policy in
`ist-window.ts`. So there is exactly one TypeScript policy matching admission and 0064,
while the permanent 09:00-inclusive / 21:00-exclusive bounds remain available for
automatic reversion.

The preflight sits **after** the halt gate and the due read, and **before** the number
read, the session mint and the dial — so through the closed hours the pass returns
`skipped: { outside_ist_window: <examined> }` and writes nothing. Before it existed the
pass reached admission first, which meant that through every closed hour it read every due
candidate's `phone_e164` out of SQL and minted a `call_sessions` row for each, four times
a minute, only to be refused `window_closed` every time.

`admit_phone_attempt` remains the **authority**: it re-evaluates the effective window
under the advisory lock, so a row offered during the temporary period is still checked
against the cutoff, while a row offered at 21:00:00.001 after September 6 is refused
there and counted on `runtime.last_due.refusals`. The preflight is a cheap gate, not a
second opinion.

`ist_date` on `phone_call_attempts` is a stored column written at admission, and it exists
solely to carry the per-day uniqueness in §7.

---

## 9. The one place a phone number becomes dialable

### State the guarantee at its true scope

An earlier draft of this section — and the header comment on `read.ts` and one test
name — said that until P5 a candidate's `phone_e164` **never left SQL**. That is wrong
repo-wide, and a reviewer who trusts it will look for a disclosure in the wrong places.
A repo-wide grep for the column finds these readers **outside** the phone lane, all of
them predating P5:

- `app/api/src/routes/candidates.ts:116` — `GET /api/candidates` **selects** the column
  on a `requireRole('viewer')` route. It is not a leak: every row goes through
  `redactCandidatePhone` (`lib/candidate-phone.ts:233-243`), which nulls `phone_e164`
  and drops `phone_raw` for every role below `admin`. `GET /api/candidates/:id` selects
  `*` and is redacted by the same helper. But it *is* a read, and for an admin the
  number reaches the response body.
- `app/api/src/lib/dsar.ts:355` — the DSAR subject-access export copies the column into
  its payload. `routes/dsar.ts:92-97` (`redactDSARExport`) nulls it below `admin`, and
  the deliberate residual is named there: `resumes[].text_extracted` still carries the
  number verbatim for any interviewer running an export.
- `app/web/src/components/talent/CandidateOverviewSections.tsx:65-67` — the operator UI
  renders whatever the API returned, i.e. the number for an admin and `null` otherwise.
- `app/api/scripts/smoke-http.ts` — printed the number to stdout against a **live**
  Supabase DB. Fixed in this PR: the script now prints `[redacted]` / `(none)` and the
  `phone_valid` boolean, never digits.

So the honest structural claim, and the one the tests actually enforce, is narrower and
still worth having:

> **`read.ts` is the only reader of `phone_e164` in the phone-runtime package, and the
> only place in the repository where the column becomes a *dialable value*.**

Both halves are checkable. `phone-runtime-structural.test.ts:129-138` asserts the column
appears in exactly one file **of this package** and asserts it as an equality, not a
containment. The dialable half is the stronger one: everywhere else the column is a
string that ends up in a response body or a screen, and only `listDialableNumbers` turns
it into a `DialableNumber` — the opaque wrapper `dialPhoneAttempt` requires and the only
form the SIP originate will accept. Nothing above can reach a carrier; this one can.

What *is* true unconditionally is the SQL-side story: admission reads the column *inside*
`admit_phone_attempt`, digests it and compares the digest against the suppression list,
and that value never crosses a process boundary. `lib/phone-screening/read-stores.ts`
forbids the column outright, and a structural test enumerates it among nineteen others
that may not appear in any declared column list.

### The reader itself

`dialPhoneAttempt` needs a `DialableNumber`, and only a process can hold one. So P5 must
introduce exactly one reader, and the entire cost of that decision is concentrated in
`lib/phone-runtime/read.ts`, in `listDialableNumbers`:

* `phone_valid !== true` → the row is skipped before the number is looked at. That is the
  ingestion lane's operator-visible verdict, and it is honoured **before** parsing: a
  number marked invalid must not be dialled even if it happens to match the pattern.
* **The raw string is wrapped in the same expression that reads it.** The only three lines
  of comment-stripped code in the whole file that name `raw` are:
  `const raw = row.phone_e164;`, `if (typeof raw !== 'string') continue;`, and
  `out.set(id, wrapDialableNumber(raw));`. No local, no field and no return value ever
  holds the bare string, so there is nothing for a later edit to log.
* A number that does not wrap is **dropped and counted, never returned and never named**.
  `admit_phone_attempt` would refuse it `phone_invalid` anyway; refusing earlier saves a
  round trip and means an unusable value never travels further than the row it came from.
* The seam returns `ReadonlyMap<string, DialableNumber>` — the opaque wrapper, not a
  string — so a caller wanting the bare value would have to unwrap it somewhere a test can
  see.
* **The read happens strictly last.** Every time-based gate — the attempt-kind
  resolution, the runtime clock, and the `scheduled` appointment gate — runs first, and
  `listDialableNumbers` is called once, for the survivors only. An earlier draft fetched
  numbers after the clock filter but *before* the appointment gate, which meant a
  `scheduled` row whose slot was still an hour away had its number read anyway: a read
  that could not change the outcome, over the one column this whole lane exists to keep
  in SQL.
* An empty candidate-id list performs **no query at all**. PostgREST answers `in.()` with
  every row, which is the failure mode that turns a bounded read into a table scan — over
  the one table that holds every subscriber number.
* Every thrown error is a bare stable code (`phone_runtime_number_read_error` and friends).
  A PostgREST error carries the failing statement and can carry row values; none of it
  propagates.

`phone-runtime-structural.test.ts` enforces all of it over the source text, because a
guarantee that only exists in a comment is not a guarantee.

### What a reviewer must check if a file is ever added to this package

Adding a file **fails the suite by design** — family 1 asserts the file inventory as a
**bijection**, in both directions, so a new file cannot join without a reviewer touching
the test. That failure is the prompt. Before adding the name to `EXPECTED_FILES`, confirm:

1. **It does not name the number.** `phone_e164` must appear in `read.ts` and nowhere
   else (family 2 asserts the mention list *equals* `['read.ts']`). Nor may it name any
   phone-bearing identifier the value could arrive as on a DTO: `phoneE164`, `phone_raw`,
   `phoneRaw`, `phoneNumber`, `phone_number`, `msisdn`, `callerId`, `caller_id`,
   `toNumber`, `fromNumber`.
2. **It does not unwrap.** No `unwrapDialableNumber`, no `.value`, no
   `revealDialableNumber` anywhere in the package.
3. **It has no logger and no console.** `runtime.ts` is the *only* file permitted a
   logger — asserted as an exact set, so the exemption cannot spread. `console.*` is banned
   everywhere, including `runtime.ts`, because it bypasses the logger's redaction.
4. **Every `new Error(...)` argument is a bare `'[a-z0-9_]+'` literal**, with no
   interpolation, no template literal, no concatenation and no `cause:`.
5. **It arms no timer.** No `setInterval(`, `setTimeout(` or `setImmediate(`. Cadence
   comes from `lib/scheduler.ts`; a timer here would be unmanaged, unstoppable by the
   shutdown path and invisible to the health view.
6. **It does not statically import `livekit-server-sdk`.** Every mention must sit inside
   an `await import('livekit-server-sdk')`.
7. **It carries no `+91` literal at all** — India publishes no reserved documentation
   range, so the only safe committed literal is none — and every UUID literal is the
   all-zero sentinel.
8. **If it reads tables:** column lists are single plain string literals declared as
   `const X_COLUMNS`, never `select('*')`, never an inline select, and there is at least
   one `.limit(` per `.from(`.
9. **If it is `read.ts` or replaces it:** no `.insert(`, `.update(`, `.upsert(`,
   `.delete(` and no `.rpc(`. Every phone write goes through an RPC carrying `0042`'s
   advisory lock, budgets and uniqueness index; a direct write from the read seam would
   satisfy every type in the repository while bypassing all of them.
10. **It is longer than 200 characters of code.** Every rule above is a negative
    assertion, and an empty file passes all of them.
11. **If it imports the phone domain core**, register it in the `ALLOWED_IMPORTERS`
    bijection in `phone-screening-structural.test.ts` too — that set is asserted in both
    directions as well.

---

## 10. Operator guide — the health surface

`GET /api/phone/health` (interviewer+). The `runtime` block is present on **all three**
response shapes — screening disabled, backlog unreadable, and normal — because an operator
needs to know whether the loops are turning in every one of them.

### `runtime.enabled: false` is not a fault

It means **this process has no registered runtime**. It is the shipped default, and it is
the normal state of every machine that is not running the loops. `phoneRuntimeDegradeReasons`
returns an empty array for it, on purpose: a disabled process contributes **no** degradation
reason.

**The view is PROCESS-LOCAL and says nothing about other replicas.** On a multi-process
deployment each replica answers for itself. `enabled: false` from one machine is not
evidence that the fleet is idle — another machine may be running every loop. The
fleet-wide question is answered by the **durable backlog** on the same response
(`engagements_by_state`, `concurrency`, `appointments`, `admission`), which is read from
the database and is true of everybody. If the backlog shows live attempts while this
process reports `enabled: false`, that is a correctly-behaving fleet, not a contradiction.

**`enabled: false` no longer hides a BROKEN runtime.** This used to be a genuine ambiguity
— a runtime that threw on construction reported exactly what a deliberately-disabled one
reports — and it is now closed. `index.ts` still wraps construction in its own try/catch
and logs `phone_runtime_start_failed`, but the failure is also **recorded** as
`runtime.start_failed`, and a disabled-but-failed process contributes the
`phone_runtime_start_failed` degradation reason. Arming is guarded on the same terms:
`armPhoneRuntime` does `scheduler.start()` and registration in order, records a failure and
never throws, because a runtime that constructs and then fails to arm is just as broken and
was just as invisible.

So `enabled: false` with **no** reasons is the shipped default and healthy; `enabled: false`
with `phone_runtime_start_failed` is a fault on this replica. A successful registration
clears the flag, because a registered runtime is proof that construction succeeded.

### The six degradation reasons

Five are additive; the sixth is exclusive. `phone_runtime_start_failed` is returned **on its
own and nothing else is evaluated** — a runtime that never constructed has no loops to be
stale and no sweeps to have failed, so every other reason would be noise about a process
that isn't running.

The other five are appended to `reasons` **after** the pre-existing backlog reasons, so the
older codes keep their order and meaning. They are additive: a stale or erroring loop
degrades the surface even when every backlog count is healthy — which is precisely the
silent-stall case, a healthy backlog with no worker turning.

| Reason | What it means | What to do |
|---|---|---|
| `phone_runtime_start_failed` | **Exclusive.** `createPhoneRuntime` or `armPhoneRuntime` threw in this process, so `enabled` is `false` for a *fault* rather than by choice. No other reason is reported alongside it. | This replica is placing no calls and running no sweeps, and it looks disabled. Read the `phone_runtime_start_failed` startup log for the throw. Restart the replica; if it recurs, the construction dependency (config parse, Supabase client, scheduler) is the fault and the flags are not the fault. Confirm cover by reading the durable backlog, which is fleet-wide. |
| `phone_runtime_stopped` | A runtime **is** registered but `scheduler.health().running` is false. The process has loops that are not turning. | This process is placing no calls and reclaiming no leases. Check whether shutdown ran without clearing the registration, then restart the replica. Confirm another replica is covering by reading `concurrency` and `engagements_by_state` in the backlog block. |
| `phone_loop_stale` | Some loop's anchor — the **later** of `lastTickAt` and `startedAt` — is older than `max(30 s, interval × 3)`. A tick is wedged, almost always on an `await` that never resolved. | Read `runtime.loops[]` and find *which* loop by name. `phone-due` stale ⇒ nothing is being dialled. `phone-reclaim` stale ⇒ fleet slots are leaking; cross-check `concurrency.live_with_unexpired_lease` against `max_concurrent` (10) and expect `at_capacity` refusals next. `phone-dial` stale ⇒ the queue is filling. `phone-maintain` stale ⇒ appointments will read `overdue`. `phone-dayroll` stale ⇒ the no-answer ladder stops advancing, so engagements sit in `awaiting_retry` and are never retried on the next IST day. `phone-stranded` stale ⇒ engagements pointing at ended sessions accumulate and are skipped `no_session` on every pass. `phone-reconcile` stale ⇒ dropped webhooks are unrecovered, so attempts whose calls really ended stay live and hold fleet slots. A stale loop is a restart, not a tuning problem. |
| `phone_loop_erroring` | Some loop has `consecutiveErrors > 0`. The loop is still armed and still ticking; the errors are counted, not swallowed. | Distinguish transient from persistent by polling twice: `consecutiveErrors` resets on a clean tick. A rising count on `phone-due` with a rising `last_due.refusals` is a downstream refusal, not a loop fault. A rising count with `last_due` unchanged means the pass is throwing before it completes — check database reachability first, since every read in the seam throws a bare code and the detail is deliberately not in the response. |
| `phone_due_halted` | The most recent due pass returned `status: 'halted'`. **No call was attempted and no session was created.** | Decide *which* halt (§4) using the backlog block on the same response. `admission.halted: true` with a `halt_reason` ⇒ someone raised the kill switch; that is working as intended and the fix is `POST /api/phone/halt/clear`. `halt_unreadable` also present ⇒ the control singleton is missing or unreadable, which is a **database** problem, not a dialer problem, and the lane is correctly refusing to guess. The other six loops keep running throughout — deliberately, because they terminate in-flight work and free slots. Note this reason fires only on a genuine halt: a pass stopped by `PHONE_DIAL_MODE=off` reports `last_due.status: 'disabled'`, which is not a degradation reason at all. |
| `phone_sweep_not_ok` | A sweep's most recent RPC did not answer `ok`. The offending sweep names itself in `runtime.sweeps_not_ok` — one or more of `reclaim`, `expire`, `reconcile`, `dayroll`, `stranded` — as stable codes only. | This is the reason that exists because a count of `0` could not carry it. On a non-`ok` status the loop reports the count as **`null`**, not `0`, and names the sweep here — so `last_reclaimed: 0` now means "swept, found nothing", `last_reclaimed: null` with `reclaim` in `sweeps_not_ok` means "the sweep did not happen", and `null` with an empty `sweeps_not_ok` means "no sweep has run in this process yet". `reclaim` listed ⇒ expired attempt leases are accumulating and each one holds a fleet slot, so expect `at_capacity` refusals next; check the RPC's grants and that `reclaim_phone_attempt_leases` still exists under that name. `expire` listed ⇒ appointments will read `overdue` in the backlog block. `dayroll` listed ⇒ transition #27 is not being posted, so the no-answer ladder is stalled and candidates who did not answer are never called again. `stranded` listed ⇒ engagements pointing at a terminal session are not being resolved and are skipped `no_session` every pass. `reconcile` listed ⇒ P3's dropped-webhook sweep is not running. All are database-side failures, not loop faults: the loop is still ticking, which is why `phone_loop_erroring` does NOT fire alongside. **A `broken` sweep claim lands here too** — see the replica note in §12 for why the claim is not an election. |

### The counts

Alongside `last_reclaimed`, `last_expired` and `last_reconciled`, `0045` adds
**`last_rolled`** (`phone-dayroll`: rows advanced past the IST day boundary) and
**`last_stranded`** (`phone-stranded`: engagements resolved — completed plus failed). All
five follow the same `null`-versus-`0` convention described in the `phone_sweep_not_ok` row
above: `0` means "swept, found nothing", `null` with the sweep named in `sweeps_not_ok`
means "the sweep did not happen", and `null` with an empty `sweeps_not_ok` means "no sweep
has run in this process yet".

`last_due` carries `status` (`ok` / `halted` / `disabled`), `examined`, `offered`,
`dialing`, and `skipped` / `refusals` keyed by **stable code only** — never by row
identity. An operator learns how many were skipped and for which reason, never which
candidate. The seven skip codes are `outside_ist_window`, `not_yet_due`,
`candidate_already_offered`, `appointment_not_due`, `no_dialable_number`, `no_session`
and `unknown_state`; the refusal codes come from the dial controller and from
`admit_phone_attempt` (`at_capacity`, `phone_invalid`, `kind_not_admissible`,
`room_unavailable`, …).

Two of those seven read as normal operation rather than as trouble.
`outside_ist_window` equal to `examined` with `offered: 0` is simply the closed hours
(§8) — expect it on every pass between 21:00 and 09:00 IST, and expect it to be the ONLY
skip code present, because the window preflight returns before the per-row filter runs.
`candidate_already_offered` means one person had two due engagements in one pass and the
second waits a tick (§12); a persistently non-zero count means someone has applied to two
roles, not that the lane is malfunctioning.

**`last_due` is `null` until this process finishes its first due pass** — which, at the
shipped defaults (both switches `false`), is *every* process, forever. That makes the
null the common case, not the edge case, so the OpenAPI schema has to say so. It does:
`PhoneRuntimeState.last_due` is written as `nullable: true` over
`allOf: [ { $ref: PhoneRuntimeDueSummary } ]`. The `allOf` is load-bearing and not a
style choice — the document is OpenAPI **3.0.3**, and in 3.0.x every sibling of a `$ref`
is ignored, so `nullable: true` written directly beside a `$ref` documents a
**non-nullable required object** and breaks the first `GET /api/phone/health` any
generated client makes. `contract-openapi.test.ts` now enforces this as a rule over the
whole document: no `$ref` anywhere may have a sibling key.

There is deliberately **no `halted` skip code**. The halted case returns early with an
empty `skipped` map, so a code for it could never be emitted — and a vocabulary entry
nothing can produce reads to an operator as a state that has *never occurred* rather than
one that *cannot*. The halt is reported as `last_due.status`, which is where it belongs.

`offered` minus `dialing` is the refusal count. A persistent gap with
`refusals.at_capacity` high means the fleet cap is saturated — check `phone-reclaim` before
raising `DUE_LIMIT`, because a leaked slot and a busy one look identical from the cap's
side. A high `no_dialable_number` means candidate rows are failing `phone_valid` or failing
to wrap, which is an ingestion problem, not a runtime one.

`runtime.config` carries the seven cadence integers — `due_ms`, `reclaim_ms`,
`reconcile_ms`, `expire_ms`, `due_limit`, `reclaim_limit`, `job_lease_seconds`. **These
are the values THIS PROCESS clamped at boot, not a re-read of the environment**, and the
distinction is the point of publishing them at all. Every knob is read once, at
construction, so an edit made after boot does not take effect until a restart; a surface
that re-read the live environment would show that edit as though it *had* taken effect,
which is the exact wrong answer to "what is this process actually doing?". So when the
reported value disagrees with the deployed environment, the deployment is pending a
restart — that disagreement is a signal, not a bug. It is empty (`{}`) when this process
runs no runtime, and it is publishable by construction: integers only, no identifier, no
credential, no digest, nothing derived from a candidate.

`dial_jobs` counts `phone.dial` outcomes **since this process started**:
`completed` is the normal path, `malformed_payload` means a job carried a payload
`isPhoneDialPayload` rejected. Neither ever fails a job (§5). `last_reclaimed`,
`last_expired` and `last_reconciled` are the most recent sweep's row counts, `null` before
the first sweep in this process. **All of these are in-process counters and reset on
restart**; the durable record is `audit_events` and the backlog.

The disclosure boundary of the whole block: booleans, bounded integers, ISO timestamps and
stable codes. No engagement id, attempt id, session id, candidate field, phone number,
digest, room name, lease token or provider payload appears anywhere in it, and the OpenAPI
schemas say so.

---

## 11. Turning it on, and turning it off fast

### On, in order

This extends `phone-safe-dialer.md` §9 and `phone-assessment-resume.md` §8 rather than
replacing them. Do those first.

0. **Apply `0042`, `0043` and `0044`, and deploy the P4b worker.** P4a alone conducts a
   recorded conversation and scores nothing.
1. **Deploy P5 with every flag off.** Confirm `/api/phone/health` reports the domain
   disabled and `runtime.enabled: false`. Nothing was constructed; this is the no-op
   deployment.
2. **`PHONE_SCREENING_ENABLED=true`, `PHONE_RUNTIME_ENABLED` still false.** The backlog
   block populates. `runtime.enabled` stays `false` — the runtime is still not constructed,
   because the gate is *both* switches.
3. **Raise the halt before arming the runtime:** `POST /api/phone/halt`. Belt and braces —
   the `off` mode gate in step 4 already stops the due pass — but it costs nothing and it
   is the control you will want to have already proved works.
4. **`PHONE_RUNTIME_ENABLED=true` on ONE replica, and restart it.** Every knob and flag is
   read at construction, so this needs a restart. `runtime.enabled` becomes `true`,
   **seven** loops appear in `runtime.loops[]`, and `runtime.config` reports the seven
   integers this process clamped. `last_due.status` reads **`disabled`**, not `halted` — because
   `PHONE_DIAL_MODE` is still `off`, and the mode gate is evaluated before the halt (§4).
   Watch `ticks` climb and `consecutiveErrors` stay 0.
5. **Confirm the five sweep loops are healthy before going further.** `phone-reclaim`,
   `phone-maintain`, `phone-dayroll`, `phone-stranded` and `phone-reconcile` are all doing
   real work now — reclaiming leases, expiring appointments, rolling the IST day, resolving
   stranded sessions and reading LiveKit room state — while the due pass does nothing at
   all. This is the cheapest place to find a credential or connectivity problem, and it is
   free of any effect on a candidate. Check `sweeps_not_ok` is empty and that
   `last_reclaimed`, `last_expired`, `last_rolled`, `last_stranded` and `last_reconciled`
   are numbers rather than `null` — a `null` here means the sweep did not run, not that it
   found nothing.
6. **`PHONE_DIAL_MODE=synthetic`, and restart.** The due pass now runs, and the halt from
   step 3 stops it: `last_due.status` moves from `disabled` to `halted`. That transition is
   the proof that both gates are wired.
7. **`POST /api/phone/halt/clear`, and rehearse.**
   > **Know what a synthetic rehearsal actually spends.** `synthetic` is not gated (§4),
   > deliberately — rehearsing admission is the point. The due pass reads due engagements,
   > creates or adopts `call_sessions` rows, and calls `dialPhoneAttempt`, which **admits**:
   > a real `phone_call_attempts` row, one of the ten fleet slots, and a real charge against
   > the candidate's IST-day index and no-answer budget. Only the originate is fake —
   > `createSyntheticSipClient` contains no reference to the LiveKit SDK at all and a
   > structural test asserts it, so **no carrier is reached**. Rehearse against test
   > engagements, never against a real candidate's row: a rehearsed candidate is not
   > re-dialable until the next IST day.

   Confirm `last_due.dialing` climbs, that `phone-reclaim` reclaims an attempt you kill,
   and that `concurrency` returns to zero afterwards.
8. **Deploy the named phone worker with `PHONE_AGENT_NAME` set.** Verify browser screening
   is unaffected.
9. **`PHONE_DIAL_ALLOWLIST` digest + `PHONE_DIAL_MODE=live`.** The first configuration
   that can reach a carrier, and it reaches exactly one number. Keep `PHONE_RUNTIME_DUE_LIMIT`
   at its default of 3 for the first live day.

Enable the runtime on **one** replica first. Nothing in P5 coordinates replicas (§1, §12);
the database does, but there is no reason to test both properties at once.

### Off, fast

**`POST /api/phone/halt` is the kill switch, and it is the fast one.** It is fleet-wide,
takes effect with no deploy and no restart, and needs no code change. Within one `DUE_MS`
tick every replica's due pass reads the control row, goes to `status: 'halted'` and stops
before any read or write. Admission refuses independently, so even an in-flight pass
cannot get a call out. `set_phone_halt` writes its own `audit_events` row inside the same
transaction as the halt.

**What the halt stops:** the due pass (`status: 'halted'`, no read and no write) and, now,
the dial loop's *claims* — `shouldClaim` refuses while the halt stands (§4), so `phone.dial`
rows stay `pending` with no attempt spent and no lease churn, and are drained when it
clears. The loop itself keeps ticking; it just takes nothing.

**What the halt does NOT stop, deliberately:** `phone-reclaim` keeps reclaiming expired
attempt leases, `phone-maintain` keeps expiring appointments, and `phone-reconcile` keeps
reconciling dropped webhooks. Those free fleet slots and terminate in-flight attempts
truthfully; stopping them would strand exactly the calls the operator is trying to end. The
reconciliation is gated on the master switch inside itself for this reason.

**The flags are the slow path**, because every one of them is read once at construction and
therefore needs a restart:

* `PHONE_DIAL_MODE=off` — the due pass returns its disabled zero and touches no seam. This
  now genuinely stops admissions; before the mode became a due-pass gate it only downgraded
  the SIP client, leaving attempt rows, fleet slots and budget charges still moving (§4).
* `PHONE_RUNTIME_ENABLED=false` — no runtime is constructed on the next boot, so all seven
  loops stop, including the ones that free fleet slots.
* `PHONE_SCREENING_ENABLED=false` — the whole domain, and with it the reconciliation's own
  internal gate.

**Halt first, then change flags.** The halt takes effect within one `DUE_MS` tick across
the whole fleet; a flag takes effect when that one replica next boots.

On shutdown, `clearPhoneRuntimeRegistration()` runs before `phoneRuntime.stop()`, each in
its own try/catch so a worker-stop failure never changes the process exit code. An
in-flight `phone.dial` claim either completes or fails under its lease; an abandoned queue
lease is recovered by `reclaim_expired_jobs` and an abandoned attempt lease by
`reclaim_phone_attempt_leases`, on any machine.

---

## 12. Residuals and known gaps

Recorded as choices or as gaps, not smoothed over.

- **The reconciliation's own bounds are not operator-settable.** `runPhoneReconciliation`
  is invoked with `{ now }` only, so its `limit` (25) and `lookbackSeconds` (21 600, i.e.
  6 h) come from `PHONE_RECONCILE_BOUNDS` defaults. `PHONE_RUNTIME_RECONCILE_MS` sets how
  *often* the sweep runs; nothing sets how *much* it takes per sweep, and
  `PHONE_RUNTIME_RECLAIM_LIMIT` does not reach it.
- **The appointment expiry shares `PHONE_RUNTIME_RECLAIM_LIMIT`.** There is no separate
  bound; raising the reclaim batch also raises the expiry batch.
- **There is still no leader election. There IS now partial replica coordination, and it
  is a CLAIM rather than an election.** Every replica with both flags on runs its own due
  pass on its own clock. Safety rests on `admit_phone_attempt`'s advisory lock,
  `uq_phone_attempts_one_live`, `uq_phone_attempts_one_per_ist_day` and the fleet cap — all
  database guarantees, all reviewed — **plus two things `0045` added that are now
  load-bearing**:

  *The two candidate guards inside admission.* Guard A refuses when somebody is already on
  the phone with this person, on any engagement and of any kind; Guard B refuses a second
  cold call to the same person on the same IST day. Together they close, at the database,
  the cross-pass and cross-replica halves of the one-offer-per-candidate hazard that the
  due pass's in-memory `Set` can only close within a single pass. Guard B deliberately
  excludes `reconnect` **and** `scheduled`: a booked slot is not a cold call, and refusing
  it would mean the candidate agreed to a time and nobody rang.

  *The sweep claim* (`claim_phone_sweep`), taken by `phone-dayroll` and `phone-stranded`.
  It is **not an election** and must not be read as one — it can lapse while its holder is
  still working. That is acceptable only because every sweep behind it is idempotent, and
  it is the reason those two loops are safe to leave armed on every replica. `claimed()`
  distinguishes `held_by_other` — the normal answer every replica but one hears, which
  holds the cadence — from `broken`, a genuine fault that backs off and surfaces as
  `phone_sweep_not_ok`. Conflating those two would have disabled both new loops fleet-wide
  behind a green health surface.

  *What P5 adds is load.* N replicas mean N due reads, N number reads and N sets of losing
  admissions per `DUE_MS`. Enabling the runtime on one replica is the recommended posture
  and is not enforced by anything. The five sweep loops (`phone-reclaim`, `phone-maintain`,
  `phone-dayroll`, `phone-stranded`, `phone-reconcile`) are individually safe to run
  everywhere — they are bounded sweeps over disjoint predicates, and the two newest also
  take the claim above — but running them N times over is still N times the load, and
  `phone-reconcile` is N times the provider traffic.
- **~~A construction failure is indistinguishable from "off" at the health surface.~~
  CLOSED by `0045`.** `runtime.start_failed` now records the throw and a failed process
  contributes the exclusive `phone_runtime_start_failed` reason (§10). Arming is guarded on
  the same terms via `armPhoneRuntime`, because a runtime that constructs and then fails to
  arm was just as broken and just as invisible. Kept here, struck through, only because the
  gap was cited in enough places to be worth contradicting explicitly.
- **All runtime counters are in-process and reset on restart.** `last_due`, `dial_jobs`,
  `last_reclaimed`, `last_expired`, `last_reconciled`, `last_rolled` and `last_stranded`
  describe this process's life since boot. There is no durable time series and no aggregation across replicas; the durable
  record is `audit_events` and the backlog.
- **`phone-dial` and `phone-due` share one cadence.** Both scheduler loops are armed at
  `dueMs` (`runtime.ts`, the `loops:` array and the `loopIntervalsMs` map that reports it).
  There is no way to tick the queue more often than the due sweep runs, or less.
- **READING HAZARD — `pollMs` on the queue runner is inert, and it is the more obvious of
  two answers.** `createQueueRunner` is also handed `pollMs: runtimeConfig.dueMs`. That
  option is **never read**: `pollMs` occurs exactly once in `lib/queue/runner.ts` — its
  declaration in the options interface (*"Base delay between polls when work was found
  (ms)"*) — and `createQueueRunner` arms no poll loop of its own. The dial cadence comes
  entirely from the `phone-dial` scheduler loop, whose `tick` is
  `queueRunnerTick(runner)` (`lib/scheduler.ts:281-283`, i.e. `runner.tick()` with the
  return value mapped to a boolean so a productive pass keeps the fast cadence). A reader
  tracing *"why does the dial loop poll at `dueMs`?"* will find both, and only the
  scheduler loop is real — change `pollMs` and nothing happens; change the loop's
  `intervalMs` and the cadence moves. This is a **pre-existing house pattern**, not a P5
  invention: `recording/runtime.ts` and `integrations/ashby/runtime-workers.ts` pass the
  same dead option. Left alone deliberately — removing it is a house-wide cleanup of the
  shared `QueueRunnerOptions` type, not a phone change — so it is recorded here instead.
  (Unrelated to `nextPollDelayMs` in `runner.ts`, which is a real backoff helper and *is*
  used, by callers that drive their own loop.)
- **READING HAZARD — `tickAll()` does not tick all.** The handle's `tickAll()` is
  `await runner.tick()` and nothing else: it drives the **queue runner only** and touches
  none of the seven scheduler loops, so it never runs a due pass, a reclaim, an expiry, a
  day roll, a stranded-session resolution or a reconciliation. Tests that call it are
  testing the dial queue, whatever the surrounding `describe` is named. If you want a due pass in a test, call the loop's `tick` (or
  `runPhoneDuePass`) directly; `tickAll()` will silently do nothing for you. The name is
  the whole hazard — `tickQueue()` would say what it does — and it is left as-is here only
  because it is part of `PhoneRuntimeHandle` and renaming it is a code change.
- **The dial handler cannot report which case it saw.** By design (§5) it reads nothing, so
  `dial_jobs.completed` counts spent durability records and post-crash records
  indistinguishably. The signal for the crash case is `last_reclaimed`, not `dial_jobs`.
- **Nothing here drives the P4a recording purge.** `phone-safe-dialer.md` §10 records that
  the purge has no armed driver; P5 does not add one. The maintain loop runs the appointment
  expiry and the webhook reconciliation, and nothing else.
- **`enabled: false` still hides a DELIBERATELY stopped fleet — but no longer a broken
  one.** A deployment where every replica *failed to construct* its runtime now reports
  `phone_runtime_start_failed` on every replica (§10), so that case is visible. What remains
  invisible is a fleet where every replica is deliberately disabled: it reports `status: ok`
  with a healthy-looking backlog and no reason at all, until the backlog itself ages into
  `attempt_leases_expired` or `appointments_overdue`. There is still no "somebody should be
  running the loops" assertion anywhere, because no single process can honestly make it —
  the view is process-local by construction.
- **An unanswered RECONNECT charges the no-answer budget, which diverges from the
  acceptance contract's wording.** `apply_phone_event`'s `sip.originate_timeout` branch sets
  `v_charge := 'no_answer'` without testing `v_att.kind`, and `reconnect` is a kind that
  reaches `dialing`. The grant side honours the contract exactly; only the unanswered
  reconnect dial diverges. Documented in full at §7, including why it should be resolved in
  the contract rather than by adding a kind test — the charge is currently the only thing
  bounding redials of a flapping call. Substrate-level, so a `0042`-family migration.

- **The `unknown_state` skip is unreachable in normal operation, and is KEPT on purpose.**
  `dueAttemptKind` returns null only for a state outside `PHONE_DUE_STATES`, and
  `listDueEngagements` filters on exactly those three, so the production reader cannot
  produce a row that emits it. It remains as a fail-closed guard rather than a live signal:
  a non-zero count means the two lists have drifted apart, which is a code defect and not
  an operational condition — so treat it as a bug report, not a tuning signal.

  It is worth being precise about why this is **not** the same case as the absent `halted`
  code, since the vocabulary in `due-loop.ts` states the rule for one right above the entry
  for the other. The rule is *"every member must have a reachable emitter"*, not *"every
  member must have a non-zero count"*. `unknown_state` has an emitter — the `kind === null`
  branch — reachable by any reader whose state filter drifts from `dueAttemptKind`.
  `halted` has no branch at all: the halted pass returns early with an empty map, so no
  code path could ever reach it.
- **`findReusableSession` still LOOKS up by candidate; adoption is now scoped by
  ownership.** `call_sessions` carries no engagement column, so the candidate is the only
  key the lookup can use: the newest row for the candidate with `mode = 'live'`, status
  `created` or `waiting`, and `external_call_id` already equal to `phoneRoomName(id)`. The
  scoping is the second step — `ensureSession` then asks `engagementOwningSession`, and
  adopts only when the session is owned by **this** engagement or by none. A session
  another engagement has bound through `phone_engagements.session_id` is refused and this
  engagement mints its own, so two engagements for one person can no longer be pointed at
  one room. The `existingSessionId` path is verified on the same terms rather than
  trusted: `readSessionForReuse` must come back with a status in
  `RESUMABLE_SESSION_STATUSES` (`created`, `waiting`, `in_progress`) **and**
  `roomVerified`, otherwise the row is skipped `no_session` instead of dialled. Before
  that check, a `reconnecting` engagement whose session had gone terminal was dialled and
  then refused `session_not_active` — a real call to a real person that could never have
  gone anywhere, charged against a reconnect budget that is spent at the grant. See
  `phone-assessment-resume.md` §7, which records the same interlock from the other side.
- **One offer per candidate is bounded to ONE PASS, and that is all.** The due pass keeps
  a `Set` of candidate ids and skips a second row for the same person
  `candidate_already_offered`. That is a real guard — `uq_phone_engagements_application`
  keys an engagement to an application link, the candidate index is deliberately not
  unique, and nothing in 0042 stops two engagements for one person being admitted in the
  same second, so without it one phone could ring twice from a single pass. But it does
  **not** close the hazard across passes, and it does not close it across replicas: two
  processes running their own due passes share no `Set`. Closing it properly needs a
  per-candidate guard **inside `admit_phone_attempt`** — a partial unique index over the
  live attempt states via the engagement join — which is a 0042 migration and was
  deliberately not smuggled into P5. Note also that the slot is claimed by the first due
  row for that candidate in the pass, *before* the `scheduled` appointment gate runs, so a
  row that is then skipped `appointment_not_due` has still spent the candidate's offer for
  that pass. The other row waits one `DUE_MS`.
- **The global stale-session sweep has no phone exemption, and P5 creates the population
  it would flag.** `screening_v2.stuck_sessions` (`0011_reconciliation.sql:176-232`)
  selects on `status` alone — `waiting` over 300 s, `created` over 1 800 s, `in_progress`
  over 7 200 s — with **no `mode` filter**, so a phone session (`mode = 'live'`, like every
  other) is in scope. P5 mints `call_sessions` rows that sit in `waiting` *legitimately*
  for a long time: from the moment the due pass provisions one until the candidate actually
  answers, and across no-answer retries that fall on distinct IST days. Against a
  five-minute waiting timeout, every one of those looks stuck.

  **It does not fire today.** `reconcile()` (`lib/reconciliation.ts:143`) is the only entry
  point that calls `detectStuckSessions`, and it has **no caller outside its own tests** —
  grepped in both directions. Nothing drives the sweep, so nothing acts on the detection,
  and `planRepair` / `executeRepair` are likewise undriven.

  So the acceptance clause *"do not weaken global stale-session timeout; use phone-scoped
  exemption only during bounded active reconnect"* is satisfied by **inaction**: P5 weakens
  no timeout, and there is no running sweep to exempt anything from. **P5 implements no
  exemption** — that is stated plainly here rather than dressed up as coverage. The latent
  residual is for whoever wires the sweep up: the moment `reconcile()` gets a production
  caller it will flag every phone session in `waiting` as stuck and recommend
  `transition_to_expired` / `idle_timeout` on sessions that are working correctly. The fix
  at that point is a `mode`-aware predicate in `stuck_sessions` — a migration — not a
  change in the phone lane. Read this before you schedule that sweep, not after.
