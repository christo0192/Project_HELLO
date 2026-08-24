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
`runPhoneReconciliation` uncalled. P5 arms five supervised loops that drive the work
already written and reviewed, and adds one genuinely new capability — reading a
candidate's `phone_e164` out of SQL (§9).

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

## 2. The five loops

All five are registered on one `createLoopScheduler` with `metricPrefix: 'phone'`.
`start()` staggers each loop's first tick by up to one whole interval, which is why
staleness is measured from the later of `lastTickAt` and `startedAt` (§10).

| Loop | Cadence knob | Bound | What it does |
|---|---|---|---|
| `phone-dial` | `PHONE_RUNTIME_DUE_MS` | `PHONE_RUNTIME_JOB_LEASE_SECONDS`, concurrency 1 | Drains the durable `phone.dial` queue. **Places no call.** |
| `phone-due` | `PHONE_RUNTIME_DUE_MS` | `PHONE_RUNTIME_DUE_LIMIT` engagements per pass | Offers due engagements to admission. The only loop that can cause a call. |
| `phone-reclaim` | `PHONE_RUNTIME_RECLAIM_MS` | `PHONE_RUNTIME_RECLAIM_LIMIT` rows per pass | `reclaim_phone_attempt_leases` — expired **attempt** leases, i.e. leaked fleet slots. |
| `phone-maintain` | `PHONE_RUNTIME_EXPIRE_MS` | `PHONE_RUNTIME_RECLAIM_LIMIT` rows per pass | `expire_phone_appointments`, and nothing else. |
| `phone-reconcile` | `PHONE_RUNTIME_RECONCILE_MS` | Its own defaults — 25 attempts, 6 h lookback | `runPhoneReconciliation` — P3's dropped-webhook sweep. |

**`phone-dial`** exists to drain the queue, not to work it. `admit_phone_attempt`
enqueues a `phone.dial` job *inside* the admitting transaction; an admission that cannot
schedule work raises `phone_dial_enqueue_failed` and rolls the whole thing back, so
`dialing` never exists without a queue row. Without a consumer, every admission would
leave a `pending` row nothing completes — `uq_job_queue_dedup_active` covers `pending`,
and `reclaim_phone_attempt_leases` only completes jobs for attempts *it* reclaims, so a
normally-ended attempt's job would sit in the queue forever and the backlog would grow one
row per call placed. The runner's `pollMs` is also `dueMs`; there is no separate poll knob.

**`phone-due`** is the only loop gated on the halt, and the only one that can reach a
carrier. Its shape is: the three switches and then the halt gate (§4) →
`listDueEngagements` → one filter pass that resolves the attempt kind, applies the
runtime clock and, for `scheduled` rows, the appointment gate → **then** fetch numbers,
once, for the survivors only → ensure a session → `dialPhoneAttempt`. The skip codes,
in the order they can be emitted: `unknown_state`, `not_yet_due`, `appointment_not_due`,
`no_dialable_number`, `no_session`.

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
| Length | `PHONE_RUNTIME_JOB_LEASE_SECONDS`, default 60 s (5–900) | `PHONE_LEASE_SECONDS`, default 60 s (5–900), **renewed for the whole conversation** |
| Effective lifetime | One claim — seconds | An originate, a classification and a full assessment — minutes |
| Renewed by | The queue runner's own heartbeat, at `leaseSeconds / 3` | `heartbeat_phone_attempt` |
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

---

## 7. The three independent budgets

All three live on `phone_engagements`, all three are CHECK-bounded, and `0042`'s table
comment says they are *"never mixed"*.

| Budget | Column | Bound | Charged |
|---|---|---|---|
| No-answer | `no_answer_attempts` | 0..3 | **At the outcome** — `sip.no_answer`, busy, voicemail (#11/#12) |
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

**Why a reconnect does not consume the daily no-answer budget.** The two are independent
because the index that bounds the daily budget **excludes `reconnect` by construction**:

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

**09:00:00 inclusive to 21:00:00 exclusive, Asia/Kolkata, all seven days.** Defined once,
in SQL:

```sql
phone_ist_window_open_at()  -> time '09:00:00'
phone_ist_window_close_at() -> time '21:00:00'
phone_ist_window_open(at)   -> (at at time zone 'Asia/Kolkata')::time >= open_at()
                            and (at at time zone 'Asia/Kolkata')::time <  close_at()
```

There is **no weekday exclusion** — Saturday and Sunday are inside the window, and the
comment on `phone_ist_window_open` says "Monday to Sunday" for that reason.

`lib/phone-runtime/` re-declares no part of it. The window is enforced in
`admit_phone_attempt` under the advisory lock, is mirrored (never re-declared) in
`ist-window.ts`, and a structural assertion keeps its bounds out of the phone-screening
configuration. A second definition would be silent in TypeScript and enforced in SQL,
which is the drift `0042` was shaped to prevent. If a due pass offers a row at 21:30 IST,
admission refuses it and the refusal is counted on `runtime.last_due.refusals` — the
correct outcome, and the reason a `window`-shaped refusal count is not a fault.

`ist_date` on `phone_call_attempts` is a stored column written at admission, and it exists
solely to carry the per-day uniqueness in §7.

---

## 9. The one place a phone number is read

Until P5, a candidate's `phone_e164` **never left SQL**. Admission reads it *inside*
`admit_phone_attempt`, digests it and compares the digest against the suppression list;
the value never crosses a process boundary. `lib/phone-screening/read-stores.ts` forbids
the column outright, and a structural test enumerates it among nineteen others that may
not appear in any declared column list.

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

One important ambiguity: `index.ts` wraps construction in its own try/catch and logs
`phone_runtime_start_failed` on a throw. At the health surface a runtime that **failed to
construct** is indistinguishable from one that is **deliberately off** — both are
`enabled: false`. Check the startup log before concluding the flags are off. See §12.

### The four degradation reasons

These are appended to `reasons` **after** the pre-existing backlog reasons, so the older
codes keep their order and meaning. They are additive: a stale or erroring loop degrades
the surface even when every backlog count is healthy — which is precisely the silent-stall
case, a healthy backlog with no worker turning.

| Reason | What it means | What to do |
|---|---|---|
| `phone_runtime_stopped` | A runtime **is** registered but `scheduler.health().running` is false. The process has loops that are not turning. | This process is placing no calls and reclaiming no leases. Check whether shutdown ran without clearing the registration, then restart the replica. Confirm another replica is covering by reading `concurrency` and `engagements_by_state` in the backlog block. |
| `phone_loop_stale` | Some loop's anchor — the **later** of `lastTickAt` and `startedAt` — is older than `max(30 s, interval × 3)`. A tick is wedged, almost always on an `await` that never resolved. | Read `runtime.loops[]` and find *which* loop by name. `phone-due` stale ⇒ nothing is being dialled. `phone-reclaim` stale ⇒ fleet slots are leaking; cross-check `concurrency.live_with_unexpired_lease` against `max_concurrent` (10) and expect `at_capacity` refusals next. `phone-dial` stale ⇒ the queue is filling. `phone-maintain` stale ⇒ appointments will read `overdue`. `phone-reconcile` stale ⇒ dropped webhooks are unrecovered, so attempts whose calls really ended stay live and hold fleet slots. A stale loop is a restart, not a tuning problem. |
| `phone_loop_erroring` | Some loop has `consecutiveErrors > 0`. The loop is still armed and still ticking; the errors are counted, not swallowed. | Distinguish transient from persistent by polling twice: `consecutiveErrors` resets on a clean tick. A rising count on `phone-due` with a rising `last_due.refusals` is a downstream refusal, not a loop fault. A rising count with `last_due` unchanged means the pass is throwing before it completes — check database reachability first, since every read in the seam throws a bare code and the detail is deliberately not in the response. |
| `phone_due_halted` | The most recent due pass returned `status: 'halted'`. **No call was attempted and no session was created.** | Decide *which* halt (§4) using the backlog block on the same response. `admission.halted: true` with a `halt_reason` ⇒ someone raised the kill switch; that is working as intended and the fix is `POST /api/phone/halt/clear`. `halt_unreadable` also present ⇒ the control singleton is missing or unreadable, which is a **database** problem, not a dialer problem, and the lane is correctly refusing to guess. The other four loops keep running throughout — deliberately, because they terminate in-flight work and free slots. Note this reason fires only on a genuine halt: a pass stopped by `PHONE_DIAL_MODE=off` reports `last_due.status: 'disabled'`, which is not a degradation reason at all. |

### The counts

`last_due` carries `status` (`ok` / `halted` / `disabled`), `examined`, `offered`,
`dialing`, and `skipped` / `refusals` keyed by **stable code only** — never by row
identity. An operator learns how many were skipped and for which reason, never which
candidate. The five skip codes are `not_yet_due`, `no_dialable_number`, `no_session`,
`appointment_not_due` and `unknown_state`; the refusal codes come from the dial
controller and from `admit_phone_attempt` (`at_capacity`, `phone_invalid`,
`kind_not_admissible`, `room_unavailable`, …).

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
   read at construction, so this needs a restart. `runtime.enabled` becomes `true`, **five**
   loops appear in `runtime.loops[]`, and `runtime.config` reports the seven integers this
   process clamped. `last_due.status` reads **`disabled`**, not `halted` — because
   `PHONE_DIAL_MODE` is still `off`, and the mode gate is evaluated before the halt (§4).
   Watch `ticks` climb and `consecutiveErrors` stay 0.
5. **Confirm the three sweep loops are healthy before going further.** `phone-reclaim`,
   `phone-maintain` and `phone-reconcile` are all doing real work now — reclaiming leases,
   expiring appointments and reading LiveKit room state — while the due pass does nothing
   at all. This is the cheapest place to find a credential or connectivity problem, and it
   is free of any effect on a candidate.
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
* `PHONE_RUNTIME_ENABLED=false` — no runtime is constructed on the next boot, so all five
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
- **There is no leader election and no replica coordination.** Every replica with both
  flags on runs its own due pass on its own clock. Safety rests entirely on
  `admit_phone_attempt`'s advisory lock, `uq_phone_attempts_one_live`,
  `uq_phone_attempts_one_per_ist_day` and the fleet cap — all of which are database
  guarantees and all of which have been reviewed. What P5 adds is *load*: N replicas mean N
  due reads, N number reads and N sets of losing admissions per `DUE_MS`. Enabling the
  runtime on one replica is the recommended posture and is not enforced by anything. The
  three sweep loops (`phone-reclaim`, `phone-maintain`, `phone-reconcile`) are individually
  safe to run everywhere — they are bounded sweeps over disjoint predicates — but running
  them N times over is still N times the load, and `phone-reconcile` is N times the provider
  traffic.
- **A construction failure is indistinguishable from "off" at the health surface.**
  `index.ts` catches, logs `phone_runtime_start_failed` and leaves `phoneRuntime` null, so
  `runtime.enabled` reads `false` — the same value a deliberately-disabled process reports,
  and it contributes no degradation reason. The startup log is the only place the
  difference appears.
- **All runtime counters are in-process and reset on restart.** `last_due`, `dial_jobs`,
  `last_reclaimed`, `last_expired` and `last_reconciled` describe this process's life since
  boot. There is no durable time series and no aggregation across replicas; the durable
  record is `audit_events` and the backlog.
- **`phone-dial` and `phone-due` share one cadence.** Both use `dueMs`, as does the queue
  runner's `pollMs`. There is no way to poll the queue more often than the due sweep runs,
  or less.
- **The dial handler cannot report which case it saw.** By design (§5) it reads nothing, so
  `dial_jobs.completed` counts spent durability records and post-crash records
  indistinguishably. The signal for the crash case is `last_reclaimed`, not `dial_jobs`.
- **Nothing here drives the P4a recording purge.** `phone-safe-dialer.md` §10 records that
  the purge has no armed driver; P5 does not add one. The maintain loop runs the appointment
  expiry and the webhook reconciliation, and nothing else.
- **`enabled: false` still hides a stopped fleet.** Because a disabled process contributes
  no degradation reason, a deployment where **every** replica failed to construct its
  runtime reports `status: ok` with a healthy-looking backlog and no reason at all — until
  the backlog itself ages into `attempt_leases_expired` or `appointments_overdue`. There is
  no "somebody should be running the loops" assertion anywhere, because no process can
  honestly make it.
- **The `unknown_state` skip is unreachable in normal operation.** `dueAttemptKind` returns
  null only for a state outside `PHONE_DUE_STATES`, and `listDueEngagements` filters on
  exactly those three. It remains as a fail-closed guard rather than a live signal: a
  non-zero count means the two lists have drifted apart, which is a code defect and not an
  operational condition.
- **`findReusableSession` adopts by candidate, not by engagement.** It takes the newest
  `call_sessions` row for the candidate with `mode = 'live'` and status `created` or
  `waiting`, and requires `external_call_id` to already equal `phoneRoomName(id)`. A
  candidate with two concurrent phone engagements (which `uq_phone_engagements_application`
  makes unusual, since engagements are keyed per application link) could in principle adopt
  the other engagement's pending session. `start_phone_assessment`'s `session_already_bound`
  refusal would then fail that leg loudly — see `phone-assessment-resume.md` §7, which
  records the same interlock from the other side.
