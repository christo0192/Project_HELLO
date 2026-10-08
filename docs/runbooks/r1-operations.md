# R1 operations runbook

**Status:** Planned R1 operations. Procedures are implemented only where
labelled with an implementation PR; do not treat this runbook as launch
authorization.**

## Merge and deploy gate

Applies to every merge that deploys `app/api/`, `app/voice-livekit/`, or
migrations. (implemented in PR-1 and deploy-guard follow-up)

1. Schedule the merge for 07:00–08:30 IST, with the latest merge at 08:00 and
   no Quality re-run or deploy dispatch after 08:15. Do not deploy outside this
   window while R1 or phone can be live.
2. Set `r1_settings.paused = true` at least 30 minutes before the merge. This
   blocks new R1 attempts but lets live R1 sessions finish. (implemented in PR-2)
3. Run read-only SQL and abort unless every result is zero:

   The live-R1-session check is available after PR-1 (implemented in PR-1:
   `interview_round_attempts` / `call_sessions.interview_round_id`).

   ```sql
   -- Available after PR-1: live R1 sessions.
   select id from screening_v2.call_sessions
   where interview_round_id is not null
     and status in ('waiting', 'in_progress');

   -- Live phone attempts.
   select id from screening_v2.phone_call_attempts
   where lease_expires_at > now();

   -- Active phone dials, or dial work scheduled in the next 30 minutes.
   select id from screening_v2.job_queue
   where name = 'phone.dial'
     and (
       status = 'active'
       or (status in ('pending', 'delayed')
           and scheduled_at <= now() + interval '30 minutes')
     );

   -- Phone appointments due in the next 30 minutes.
   select id from screening_v2.phone_appointments
   where starts_at <= now() + interval '30 minutes'
     and status in ('scheduled', 'confirmed');

   -- Active phone assessments.
   select id from screening_v2.job_queue
   where name = 'phone.assessment' and status = 'active';
   ```

   These queries use the `job_queue` and `phone_appointments` schema in the
   migrations; the deploy guard must fail closed. (implemented in PR-1)
4. Squash-merge only after applicable Quality, hosting, Supabase, secret-scan,
   and model-governance checks are green. (implemented in PR-x)
5. Verify after deployment: watermarked worker registration, unchanged phone
   role-row snapshot, a phone Canary-1 dry run at about 08:30 IST, and an R1
   worker-context-only dry call (not a 20-minute interview). (implemented in PR-4a)
6. Restore `r1_settings.paused` only after verification and the owner’s
   operating decision. (implemented in PR-2)

Web-only deployments may occur outside this slot only with zero live R1
sessions. (implemented in PR-6/PR-7)

### PR-LK-liveness (PR #345): the gate for this merge is run by hand

The automated zero-live pre-step named in the plan (section 9) does not exist
yet: no step in `deploy-fly.yml` queries for live work, so nothing in CI stops a
merge while a phone call or a screening is live. For this PR the operator runs
the gate above by hand and records the result on the PR before squashing.

One merge of this PR does all of the following:

- `migrate-production` applies 0118. It takes an ACCESS EXCLUSIVE lock on
  `voice_worker_leases` under a 10 s `lock_timeout` (a busy table fails the
  migration instead of queueing behind live traffic). The read-only drift check
  then runs three queries: `request_phone_rescreen`, `claim_voice_worker` and
  `reset_voice_worker`.
- The API, the browser voice app and the phone voice app all redeploy (the voice
  sources are shared, so a change under `app/voice-livekit/` deploys both apps).
  A live phone call is cut after the 90 s drain; a live screening is ended by
  the worker shutdown (`shutdown_forced`).
- The phone image also ships every phone change merged to `main` and not yet
  deployed. The gate review named #334 (natural opening, pre-consent scheduling,
  Q&A closing; merged 2026-10-06); confirm what else is pending before merging.

Procedure (all times IST):

1. Pick a merge slot between 07:00 and 08:00. Never later: no Quality re-run or
   deploy dispatch is allowed after 08:15, and the deploy follows the merge.
2. At least 30 minutes before the merge, set `r1_settings.paused = true`.
3. Immediately before squashing, run the five read-only queries of the gate
   above (live R1 sessions; live phone attempts; `phone.dial` jobs; phone
   appointments due in the next 30 minutes; active `phone.assessment` jobs).
   Abort on any row. This PR changes the API, so the `phone.assessment` check
   applies.
4. Confirm Quality and `supabase-check` are green on the exact commit being
   squashed, rebased on the current `main`. A new push re-runs both.
5. Squash. After the deploy verify the watermarked worker registration of BOTH
   voice apps, the unchanged phone role-row snapshot, and a phone Canary-1 dry
   run (`worker_present_before_originate|PASS`). Keep R1 paused until the owner
   decides to resume.

Transient drift-check failure. The drift script checks all three functions and
then fails the job if any check failed. A log line `drift check could not query`
or `drift check got no readable position` is transient (for example a dropped
connection); `PROD FUNCTION DRIFT ... (position 0)` is real drift. After a
transient failure `migrate-production` has already applied 0118 and every app
deploy is skipped. That state is safe (0118 is additive and compatible with the
old apps) but nothing is deployed. Recover inside the window by re-running the
failed job from the same workflow run, or by dispatching `Deploy (Fly)` with
service `all` (it re-applies pending migrations, of which there are none,
repeats the drift check and deploys). Real drift: do not deploy; investigate.

Gate record. Paste this on the PR, filled in, before squashing:

```text
Gate record, PR #345 (hand-run; the automated pre-step does not exist)
- Merge time (IST, 07:00-08:00): __:__
- r1_settings.paused = true since (IST, at least 30 minutes earlier): __:__
- Live R1 sessions: 0
- Live phone attempts (lease_expires_at > now()): 0
- phone.dial jobs active or due in 30 minutes: 0
- Phone appointments due in 30 minutes: 0
- Active phone.assessment jobs: 0
- Quality and supabase-check green on commit: <sha>
```

### PR-LK-liveness (PR #345): phone impact (plan section 9)

This PR touches the phone-shared tier, so plan section 9 requires this record.
Every new behaviour is opt-in (the table under "Browser readiness contract") and
off by default. With the defaults the phone lane and the live Cloud browser lane
run the same code paths as before. The record below states where this PR departs
from the section 9 rules, and why that is acceptable.

Phone-shared files this PR changes, and the rule each follows:

- `app/voice-livekit/agent.py`: no new top-level imports (`urlparse` and
  `AgentServer` are imported inside the one function that needs each, on the
  opted-in browser path only). It modifies exactly three pre-existing
  definitions, `_prewarm_post_machine_ready`, `build_worker_options` and the
  `__main__` block, and otherwise only adds named-browser / R1 helpers that
  those three call. `test_browser_liveness.py` pins this: the helpers may be
  referenced only from the three seams, and never from a phone helper, the job
  entrypoint or `_run_session`.
- `app/voice-livekit/worker_ready_api.py`: one optional keyword,
  `livekit_host`, sent only when set; every caller that omits it posts the
  legacy body.
- `app/api/src/routes/invites.ts`: fence 7, keyed on the R1 target; Cloud takes
  the same branches as before.
- `app/api/src/lib/worker-orchestration.ts`: a `readLivekitHost` option, default
  off, so the phone reader and the Cloud-browser reader keep the exact pre-0118
  `select`.
- Environment schema and validator: additive (two worker switches).

Three departures from section 9, each justified:

1. **R1 early return in `_prewarm_post_machine_ready`.** Section 9 says "no R1
   work in prewarm". With `R1_READINESS_HOST=on` on the named BROWSER worker the
   prewarm returns without posting, and readiness comes only from the main
   process once LiveKit accepts the registration. This cannot be done anywhere
   else: a job process can warm before the registration completes, so letting it
   post would win the readiness race. The branch is a bare `return`; it is
   unreachable for the phone worker (`_browser_r1_readiness` is false whenever
   the worker is not the named browser worker) and, with the switch absent,
   the function is unchanged.
2. **`build_worker_options` and the `__main__` block.** Section 9 allows
   "build_worker_options keys only when R1 env is present" and entrypoint
   additions only below the `_phone_agent_name()` return. The two opt-in keys
   (`load_fnc`, `load_threshold`) are written only inside the named-browser
   branch, and only when `BROWSER_WORKER_ONE_JOB=on`; the phone keys are not
   touched. The `__main__` block now calls `run_worker_app`, which is the old
   `cli.run_app(build_worker_options())` for every lane except the opted-in
   named browser worker. The new helpers sit beside the existing browser helpers
   rather than below that return, because nothing is added to the job
   entrypoint itself.
3. **0118 re-declares `claim_voice_worker` and `reset_voice_worker`.** Section 9
   puts "the phone SQL RPCs" on the never-touch list, and both functions are
   shared by the phone and the browser lane. Each is the 0112 text (their latest
   definition) plus exactly ONE added line, `livekit_host = null,`, beside
   `registered_agent_name = null`. The CHECK `livekit_host is null or pipeline =
   'browser'` means a phone row can never hold a host, so for a phone row the
   added assignment writes null over null: a no-op. Signatures, security posture
   and grants are re-issued unchanged. Proof: `r1-lk-liveness-release-gate.test.ts`
   diffs each re-declaration against 0112 line by line (nothing removed; the one
   added line); `r1_foundation_assert.sql` runs both RPCs for a phone lease and
   a browser lease.

Phone tests that stay green and unmodified: `test_phone_gate`,
`test_phone_agent_name`, `test_phone_drain` and `test_agent`. `test_worker_ready_api`
gains additive `livekit_host` cases only.
### PR-4a (#343) is also the production release of #334

`Deploy (Fly)` decides what to deploy from the merge commit alone
(`git diff <sha>^ <sha>`), and any change under `app/voice-livekit/` redeploys BOTH
voice apps, browser and phone, from `main` HEAD, because they share that source
(`scripts/deploy-fly-workflow.test.mjs` runs that decision against a real commit). The
newest commit on `main` that changed `app/voice-livekit/` before PR-4a is `fd40050c`
(#334, "natural opening, pre-consent scheduling, and Q&A closing": 271 changed lines in
`agent.py` and 213 in `phone.py`), and it has not been confirmed live. Merging PR-4a
therefore ships #334's phone changes to live calls together with the R1 core. The R1 code
is inert for phone (the phone worker options are identical and the phone entrypoint never
imports `r1_*`; `tests/test_r1_routing.py` pins both), so a phone regression after this
merge comes from #334 until shown otherwise and is never attributed to R1. If the
`Deploy (Fly)` runs and `fly releases` already show a live release of both voice apps
that carries `fd40050c`, this section reduces to the ordinary gate above.

Choose one path BEFORE the merge, and state it in the PR body's phone-impact section:

1. Release #334 on its own first. Inside the merge window, with the zero-live-call
   queries above passing, dispatch `Deploy (Fly)` with `service=phone-voice` from `main`
   as it stands before PR-4a (a dispatch deploys the ref it is dispatched from), and pass
   the phone checks below. The PR-4a merge then redeploys an already verified phone
   worker.
2. The owner explicitly accepts that the PR-4a merge itself ships #334. Merge only in
   the window, with the zero-live-call queries above passing, and run the phone checks
   below straight after the deploy.

Phone checks after the deploy, on either path: the deploy job's own current-registration
proof for BOTH voice apps (a missing current registration is a failed deploy, never a
warning), the unchanged phone role-row snapshot, and a phone Canary-1 dry run
(`docs/runbooks/phone-canary1.md`). The opening line, scheduling before consent and the
Q&A closing are #334's behaviour, so the dry run is the signal for it. If any check
fails, keep `r1_settings.paused = true` and roll the phone worker back
(`docs/runbooks/phone-worker-deployment.md` section 5) before touching R1.

## Budget, cap, and reconciliation

R1 permits one live interview. Reserve 55 participant-minutes per attempt;
typical use is about 45 and worst case about 60. Track candidate/agent time,
preflight, manual tests, Fly uptime/egress, DeepSeek, Sarvam, failures, and
active sessions. (implemented in PR-2)

For the self-hosted SFU, R1 consumes no LiveKit Cloud participant-minutes.
Pause at the owner-approved R1 operating cap or projected provider/operational
overload. Reconcile the R1 ledger with Fly and provider dashboards daily during
launch and weekly thereafter. (implemented in PR-2)

### Capacity settings and the two checks (implemented in PR-2b, migration 0119)

Two settings control R1 capacity. They mean different things and must be set
separately:

| Setting | Meaning | Applies |
|---|---|---|
| `monthly_cap_minutes` | The owner-approved **R1 allocation**: sessions x 55 (for example 20 x 55 = 1,100 in December, about 40 x 55 = 2,200 in steady state). | Always, in both targets |
| `pause_line_minutes` | The **total Cloud-pool pause line** (4,000 = 80% of the 5,000 free-plan pool). | Only while `livekit_target` is `cloud` (Mode B) |

A self-hosted R1 (Mode A, `livekit_target = r1`) uses no LiveKit Cloud minutes,
so only the allocation gates it. In Mode B both checks must pass. Phone
admission is never gated by either check.

**Set the allocation before enabling R1.** `monthly_cap_minutes` defaults to
4,000, a placeholder from 0115 when it was a total-pool limit. As the R1
allocation it would mean 72 sessions a month, and in Mode A nothing else would
stop it. The settings API therefore refuses `enabled = true` (409
`r1_allocation_not_set`) while the stored allocation is still 4,000, it has
never been saved (`r1_settings.allocation_set_at` is NULL) and the same request
does not set `monthly_cap_minutes`. The database stamps `allocation_set_at` only
when a write names `monthly_cap_minutes`, so a deliberate save of an unchanged
4,000 counts, and **nothing else does**: a dashboard reading, a pause, a
threshold or an empty save records `updated_by` but leaves the guard in place
(`PUT {dashboard_minutes: 1200}` then `PUT {enabled: true}` is still refused
while the allocation is 4,000). The column is NULL on every existing row after
0119, so an operator who had chosen 4,000 saves it once more. Launch checklist
for these settings: (1) set the allocation, (2) set the pause line (Mode B), (3)
enter the first dashboard reading, (4) only then enable; a reading entered
early does not count as step 1.

Both Send R1 and the candidate's admission evaluate one database function,
`screening_v2.r1_capacity_snapshot`, which `v_r1_budget_month` also reads, so
Mission Control and the RPCs cannot disagree. For the current month (minutes):

- `r1_actual` is the R1 **session** minutes: the candidate and agent ledger
  plus a session-timestamp fallback for sessions with no positive candidate or
  agent ledger row. The fallback counts candidate and agent (x2, like legacy
  browser); a zero-second row, or a preflight row, does not suppress it; a live
  session with no metering yet counts at least its 55-minute charge (the "live
  floor"). The floor is a **booked charge**, like the Send hold it replaces: it
  counts once and is never multiplied by 1.15 (a session unmetered for more than
  about 27 minutes counts its elapsed x2 instead, also unmultiplied: a few
  minutes under until the metering replaces it). A metered session counts 1x
  elapsed in the ledger while the fallback for a crashed one counts 2x: the
  ledger stays authoritative when the worker supplies it, so the two
  conventions are expected to differ.
- `preflight` and `manual_test` ledger minutes are **pool-only**: they count in
  `pool_pure` but not in `r1_actual`, because the cap formula already subtracts
  planned test minutes from the session allocation.
- **Uncounted charges**: a charged attempt that ended without counting (a
  no-show or technical failure, plan 5.11: "not counted; the hold is kept for
  the link") has `charged_attempt_number > attempts_counted` and no live session.
  Its 55 is a hold, not a spend: it leaves `minutes_used` and joins the
  outstanding holds while the link lives. This is derived by the snapshot, so it
  does not wait for any sweep.
- `outstanding_holds` is every unconverted Send hold plus those uncounted
  charges, in **any** month (a hold is future minutes whenever its calendar
  month ends), but only while the link can still be used (status `invited` or
  `in_progress`, `expires_at` in the future). A lapsed or cancelled link stops
  counting immediately, before any sweep.
- `minutes_used` is the month's booked minutes less its uncounted charges
  (`booked_minutes_used` is the stored column).
- `floors` are the live floors plus the floor of the start being checked.
  `r1_estimate = 1.15 x (r1_actual - floors) + floors`.
- `r1_committed = greatest(minutes_used, r1_estimate) + outstanding_holds`.
- `pool_pure` is R1 actual + preflight/test + phone + legacy browser;
  `pool_settled` is `pool_pure` less the live floors;
  `pool_estimate = 1.15 x (pool_pure - floors) + floors`.
- `pool_guard` is `pool_estimate`, or, when a dashboard reading from **this**
  month exists, `greatest(dashboard, dashboard + 1.15 x (pool_pure - floors -
  baseline) + floors, pool_estimate)`. The authoritative dashboard figure is never
  multiplied, the guard is never below it, and a reading from an earlier month is
  ignored.
- `pool_committed = pool_guard + greatest(0, minutes_used - r1_estimate) +
  outstanding_holds`: the admitted R1 minutes not yet visible in the estimate.

**The checks run on the state after the change.** A Send adds a 55-minute hold:
refused as `capacity_exhausted` when `r1_committed + 55 > monthly_cap_minutes`,
or in Mode B when `pool_committed + 55 > pause_line_minutes`. Admission is
checked as if the start had already happened, so a start can never leave R1
above either limit: the new live session's 55-minute floor joins `r1_actual`.

**Send and start agree.** The start that converts a Send hold exchanges the hold
for a booked 55 and a 55-minute floor, which together count as 55 (the
`greatest()` of the booked and the floored terms), so a start admitted at Send
time is admitted again unless other usage grew in between. On the first of a
month, with nothing booked or metered, an allocation of 20 x 55 = 1,100 admits 20
Sends and then all 20 starts; the 21st Send is refused. (An earlier draft
multiplied the floor by 1.15: each start then needed 63.25 against its 55 hold and
all 20 starts were refused, "temporarily unavailable", until a link expired or HR
cancelled one.) The suite pins this in both modes.

| Start | Effect on the checked state |
|---|---|
| Converting the Send hold | the hold leaves `outstanding_holds`, 55 is booked, plus the live floor |
| Restarting an uncounted attempt (same attempt number) | the attempt's 55 returns from a hold to booked, plus the live floor: no new charge, charged once |
| Retake, or a first start with no hold | a fresh 55 is booked, plus the live floor |

When metered minutes dominate the booked ones (A-dominated: sessions running
longer than about 48 participant-minutes), the live floor shows on top of
1.15 x the metered minutes, so a start can need more than the hold it converts
once real usage has grown since the Send; that is real growth, not a rule
mismatch. Above either limit the API must show the candidate "temporarily
unavailable, your link stays valid" (plan D5). Reissuing a link that had **already lapsed** revives its hold, so it
re-checks capacity as a fresh 55 (409 `r1_capacity_exhausted`); reissuing a link
that is still alive changes nothing and is not checked.

**A hold is charged to the month that booked it (Mode A overshoot at month
end).** A link Sent on July 31 and started on August 1 converts a charge that is
already in July's `minutes_used`: its 55 is booked to July, and August's
allocation check adds no booked 55 for it. While the session is live it is
absorbed by August's `greatest(booked, estimate)`. Mode A's allocation therefore
**can be exceeded by one session per link that straddles a month end**: the links
Sent in the last 72 hours of a month. For example, with August at 18 sessions
booked, a July-Sent session running and an allocation of 20, two more August
Sends are still admitted, so August hosts 21 sessions against an allocation of 20. The total across the two months is unchanged and the
overshoot is bounded by the Sends of the last 72 hours; the owner may accept it or
stop sending in the last three days of a month. (Mode B's pool is unaffected in
substance: the session's metered minutes enter the estimate and the dashboard
reading in the month they run.) The suite pins this behaviour.

**No-shows do not consume the allocation.** The charge of an attempt that ended
uncounted is a hold kept for the link, so a restart (up to three starts per
link) takes it back instead of paying twice, and it is released when the link
ends: cancel and expiry refund it from the month that booked it, exactly once
(the marker is `interview_rounds.charged_attempt_number`, which lives on the
round, so deleting an attempt row by retention cannot cause a second charge).
`r1_sweep_expired_rounds` also releases the hold or uncounted charge of a round
that is still `in_progress` (or already terminal) with a lapsed link, without
changing its status. The sweep is scheduled by the PR-8 `r1.sweep` job; capacity
decisions never depend on it, because the snapshot already ignores lapsed links.

**Worker contract for counting (PR-4 and PR-8).** The no-show derivation treats a
round with `charged_attempt_number > attempts_counted` and no live session as a
hold kept for the link, and the sweep, cancel and expiry refund it for good once
the link is dead (three starts used, a lapsed link, or a terminal status). The
worker must therefore:

1. write `attempts_counted` (and flip `interview_round_attempts.counted`) **while
   the session is still live**, at TRANSITION (plan D1), never after the session
   has left live status. A count written afterwards can lose the race with the
   sweep: a counted third start, or a session that ends just before the link
   expires, is refunded before it is counted and its 55 is lost from
   `minutes_used`;
2. write an **uncount after a system failure in the same transaction that
   terminalizes the session**, so no reader sees the session terminal while its
   attempt is still counted (a restart would be refused as `attempts_exhausted` in
   that window);
3. never end a session uncounted and count it later: an attempt that did not
   count is released with the link, by design.

The same rule is in the plan (`docs/design/r1/R1-PLAN-final.md` section 5.12,
"Counting contract") for the PR-4a worker and the PR-8 `r1.sweep` crash recovery.

The suite pins both orders (a count written while live keeps its 55 through the
sweep, also as a third start; a count written after the session ended finds its 55
refunded). Cancelling a round while its session is **live** refunds nothing, for
the same reason: the worker may still count that session, and the refund waits
until it has ended uncounted.

`v_r1_budget_month` exposes `r1_committed`, `pool_committed`, `pool_guard`,
`outstanding_holds`, `r1_headroom` and `pool_headroom` (the limit minus the
committed minutes) for the current month, and `pool_check_applies` (true in Mode
B). The current month is always present, even before its first Send creates a
budget row. It is read-only for the service role.

For reconciliation the raw columns keep their meaning and the derived terms are
appended: `minutes_used` is the **booked** column and `starts_admitted` counts
**charged** starts (a restart of an uncounted attempt is not charged again, so it
does not increment it); `booked_minutes_used`, `uncounted_charges`,
`restored_holds`, `r1_minutes_used` (booked less 55 per uncounted charge, never
below 0) and `r1_estimate` give the figures the checks use, so that
`r1_committed = greatest(r1_minutes_used, r1_estimate) + outstanding_holds` can be
reproduced from one row. A no-show moves its 55 from `r1_minutes_used` into
`restored_holds` while `minutes_used` keeps it. The derived terms exist for the
current month only.

Reconcile by entering the dashboard's month-to-date figure through the settings
API (`dashboard_minutes`). The **database** stamps `dashboard_read_at` with its
own clock and `dashboard_estimate_baseline` with its own `pool_settled` at that
instant, in one statement under the settings lock; clients cannot supply either
value and the API rejects them. The baseline excludes the live floors: the
metering later replaces a floor, which would otherwise read as negative growth
and pull the guard under the authoritative figure. A reading counts as new when
its value changes, was never stamped, or was stamped in an earlier month (an
unchanged figure, such as 0 on the 1st, is a new month's reading), so re-saving
other settings cannot reset the baseline of an unchanged current-month reading. `dashboard_read_at` is the **entry** time: usage between
looking at the dashboard and entering the figure is not added, so enter it
promptly. Enter the figure daily during S0 through Stage B, then weekly.

A current-month reading entered under 0117 has no baseline. Migration 0119
backfills it with the estimate now (net of live floors), because the estimate at
read time is not computable from stored rows (the estimate has no as-of
dimension): usage before the migration is not added on top of that reading,
usage after it is. A reading with no baseline is always treated that way by the
snapshot. Re-enter the dashboard figure after deploying 0119 to re-stamp it
exactly.

For Cloud fallback, calculate the permitted sessions as:

```
floor((pause line - 1.2 * measured trailing-30-day non-R1 minutes
       - planned Cloud test minutes) / 55)
```

Start with the 4,000-minute (80%) pause line; raise to 4,250 (85%) only after
two reconciliations agree within 5%. Apply a 1.15 reconciliation factor until
the ledger is demonstrated. Warn at 60/75/90%, pause at the line or projected
month-end ≥90%, and keep R1 paused through 12:00 UTC on the first until reset
behavior is evidenced. (implemented in PR-2)

### Deploying 0119

0119 backfills `charged_attempt_number` from the latest attempt of every existing
round (each start 0115 or 0117 admitted was charged). It cannot repair 0117's
restarts: 0117 charged a fresh 55 for the **restart of an uncounted attempt**,
which this model charges once, and the months of those charges are not recorded.
Production has never enabled R1, so there should be no rounds, but verify it
before applying, with read-only SQL, and record the results in the PR:

```sql
select count(*) from screening_v2.interview_rounds;                           -- expect 0
select month_start, minutes_used, minutes_reserved from screening_v2.r1_budget_month;  -- expect no rows, or zeros
select round_id, attempt_number, count(*) from screening_v2.interview_round_attempts
 group by 1, 2 having count(*) > 1;                                            -- expect no rows
```

If the first count is not 0, stop and review each round (its `starts_used`
against its latest attempt number): a restart left a second attempt row with the
same attempt number, and the migration itself refuses to run while any such
rows exist (`0119 refused: N R1 round(s) were charged twice ...`). Correct the
affected months' `minutes_used` and `starts_admitted` (55 and 1 per extra
restart, in the month of the restart), remove the duplicate attempt rows, and apply
again. After 0119 is live, save the allocation once (see the
launch checklist: `allocation_set_at` is NULL on the existing row) and re-enter
the dashboard figure to re-stamp its baseline.
## Scoring, status effects and the override monitor

Implemented in PR-5 (migration 0122). R1 sessions are scored by their own queue
runtime (`r1.assessment`, concurrency 1, started only when `R1_ENABLED=true` and
claiming only while `r1_settings.enabled` is true), with its own DeepSeek runner
and circuit breaker. The phone scorer, its prompt and the phone runtime handler
set (`phone.dial`, `phone.assessment`) are untouched and fenced by tests.

**Flow.** A completed R1 session enqueues `r1.assessment` (0116 trigger). The
handler scores the phase-labelled transcript three times (median per metric),
evaluates the coverage and fidelity gate, stores a v2 assessment, attaches it to
the round (`r1_attach_assessment`) and applies the status effect
(`r1_apply_status_effect`). A re-run adopts the stored assessment and never calls
the model again. Anything that cannot be trusted ends in `human_review`, which has
no status effect: a gate failure, disagreeing runs, invalid evidence references (a
metric scored 3 or 4 must cite at least one valid candidate turn), an incomplete
scorecard, a role whose active scorecard is not the R1 scorecard, or (on the final
queue attempt) a provider or validation failure, which first records a `human_review`
placeholder and then dead-letters.

**Wrong scorecard.** If the R1 role's active scorecard is not exactly the five R1
metric keys with their plan 6.1 weights (for example the role still carries the
default phone metrics because the manual seed has not run), no model call is made:
the session gets a `human_review` placeholder with code `r1_scorecard_mismatch`,
the job succeeds, and nothing is retried. Run the seed (below) to fix it; a later
re-score supersedes the placeholder.

**Provider outages defer.** A DeepSeek timeout, a connection failure or R1's own open
circuit breaker defers the job (reason `r1_provider_unavailable`, delay at least the
60 s breaker cooldown) instead of failing it: the attempt is refunded, so a short
outage does not dead-letter the job. A deferral streak is capped at 60 minutes; past
it the failure takes the normal retry, placeholder and DLQ path.

**Switches.** `R1_ENABLED` (API env) builds the runtime. `r1_settings.enabled`
gates claiming. `r1_settings.auto_status_enabled` (default **off**, owner-only,
audited) gates every candidate status write. With it off the outcome is recorded
as `status_write = 'flag_off'` and is never applied retroactively. Thresholds
(`advance_threshold` 65, `hold_threshold` 45) live in `r1_settings`; a level 1 on
objection handling or negotiation caps an advance at hold.

**`interview_rounds.status_write`.**

| Value | Meaning |
|---|---|
| `human_review` | No auto effect: gate failed, runs disagreed, evidence invalid, or scoring failed |
| `hold_flag` | Hold: a flag only, no write |
| `flag_off` | An advance/reject was recommended but auto-status is off |
| `advanced` | Candidate moved to `advanced` by compare-and-set |
| `pending_reject` | 24 h cancellable window open (`pending_reject_until`) |
| `rejected` | The window closed and the candidate was moved to `rejected` |
| `pending_reject_cancelled` | HR cancelled the window (an override) |
| `pending_reject_dropped` | Closed without executing: auto-status off, window overdue by more than an hour (`window_stale`), round no longer final (`round_not_final`), candidate changed by a human, appeal block, or a newer attempt replaced the assessment. The reason is in the audit row |
| `cas_lost` | A human changed the candidate after sending; the human change wins |
| `decision_blocked` | `decision_use_blocked_at` is set (appeal) |
| `round_not_final` | The round was cancelled by HR, or a manual retake re-opened it, so no candidate status is written (D1: status is written only when the round is final) |

**Pending reject.** HR cancels on the card (`POST
/api/interview-rounds/{id}/cancel-pending-reject`, admin or owning interviewer).
The `r1-status` loop closes due windows once a minute, and only while R1 is enabled.
A window the loop did not get to within an hour of its close (R1 was switched off, or
the API was down) is dropped as `window_stale`, never executed late: a human decides.
A window whose round HR cancelled or re-opened with a manual retake is dropped as
`round_not_final`. Every write, drop and cancellation is in `audit_events` (actor
`system:r1` or the recruiter; scorer, rubric and thresholds versions the window was
opened with; prior and new status).

**Override monitor.** Over the latest 20 resolved R1 rejects (executed or
cancelled), an override is an HR cancellation or an executed reject whose candidate
was later moved off `rejected`. Above 10% auto-status is switched off and audited
(`reason: override_rate_exceeded`). With fewer than 20 resolved rejects the
denominator is the actual count, so a single early override trips it: switching off
is the safe direction. The owner re-enables only after reviewing the overrides, and
the re-enable starts a NEW window: `r1_settings.override_window_reset_at` is stamped
by a trigger whenever auto-status goes from off to on, and only decisions resolved
after it count. (Nothing can resolve while auto-status is off, so without the reset the
same window would trip the monitor again on the next status tick.) Whether a minimum
number of resolved decisions should be required before the monitor may trip is an
open owner decision; today it is one.

**Alerts.** Dead-lettered scoring jobs appear in `v_funnel_failures` as stage
`scoring` with code `r1:<code>` (`r1.recording.*` as `recording`, other `r1.*` as
`call`). Replay with the platform DLQ replay procedure; a successful re-score
supersedes the placeholder as the next assessment revision.

**Worker contract (`session_facts`).** The gate fails closed on anything the worker
does not report. The worker (PR-4b) must post, through `POST
/api/internal/r1/admin-log`: `need_revealed` (turn_index, `{need, probed_turn}`),
`family_delivered` / `push_delivered` (family F1-F4, turn_index,
`{slip_seconds}`), `counter_delivered` (F1, `{slip_seconds}`), `discount_detected`
(`{amount_usd, conditional, value_before}`), `guard_hit` (`{kind}` of commitment,
concession, control, persona, feedback or other), `time_cue`
(`{roleplay_seconds}`) and one `session_facts` (`{roleplay_seconds,
talk_share_pct, longest_monologue_seconds, barge_in_count, question_count,
interruption_count, first_audio_p95_ms}`). Until `session_facts` is posted no
session can pass the gate, which is the safe state while auto-status is off.

`first_audio_p95_ms` is measured by the PR-4c latency tracker (`r1_latency.LatencyTracker`): the
nearest-rank p95 of candidate end of speech to the agent's first audio over the **role-play** turns
only, a JSON number in **milliseconds** (the gate's limit is 3000). A session with fewer than 8
measured role-play turns posts an explicit `null`, so the gate says `latency_unknown` instead of
reading a number nobody measured. The worker logs the same figure as an `r1_latency` line
(`schema=first_audio_p95`, `error_category=gate`, `option_count` the turns behind it) beside the
all-phase figure (`error_category=all_phases`), so a posted value can be compared with the Stage A
report. The other four communication facts (`talk_share_pct`, `barge_in_count`, `question_count`,
`interruption_count`) are still sent as `null`; they do not fail the gate.

**Ordering: post everything BEFORE the terminal transition.** The admin-log route
answers 409 `r1_session` once the session has left `waiting`/`in_progress`, and the
`r1.assessment` job is enqueued by the 0116 trigger at that same transition. Every
row, `session_facts` included, must therefore be posted before the worker completes
the session; a row posted afterwards is refused and the session fails the gate with
`fidelity_facts_missing`. This is the opposite order to the attempt outcome, which PR-4a
posts after the transition. A gate failure on `fidelity_facts_missing` for every
session is the symptom of the wrong order.

**Admission contract (PR-3).** "The later attempt wins" is safe only if attempt 2 can
start solely when attempt 1 has no valid gated score (the D1 automatic retake) or HR
granted the manual retake. Between attempt 1's completion and its attach (queue poll
plus three model runs) the round is still `in_progress` with one attempt counted, and
the admission in 0117 would admit attempt 2. PR-3's `r1_admit_attempt` must refuse a
new attempt while the latest counted attempt's session is `completed` but the round
holds no `assessment_id` for it; otherwise attempt 2's score replaces a valid
attempt-1 score in `r1_attach_assessment`.

**Gate rule for F1 (PR-B).** The deck defines F1 as the $7,000 anchor plus the counter
after the advisor's first answer; it has no push (`r1_scheduler.py` PLAN). The worker
posts the anchor as `family_delivered` and the counter as `counter_delivered`, both with
`family_id: 'F1'`. The gate therefore requires a primary and a push for F2-F4, and the
anchor and the counter for F1; an `F1` `push_delivered` row is neither required nor
judged. The scorer prompt prints F1 as `anchor ...; counter ...`.

**Attempts that did not complete (PR-B, migration 0126).** A candidate who leaves after
the role-play began (or whom the residency cap ends) is a COUNTED attempt (plan D1):
`candidate_left` and `residency_timeout` count once TRANSITION started, the session ends
`failed`, and the round closes. Before 0126 nothing ever scored such a session (only a
`completed` session enqueued `r1.assessment`) and Grant retake answered
`retake_not_allowed`. Now `r1_settle_attempt` enqueues the same `r1.assessment` job in the
same transaction when the counted attempt's session is `failed` and the round holds a live
(not withdrawn) consent. The scorer scores it, and the gate can never pass it
(`session_not_completed`, `session_not_clean`, plus `system_failure_outcome` for the
residency cap): HR sees a real scorecard with a `human_review` recommendation and the
failure codes, and may Grant retake (it now needs exactly one counted attempt, whatever its
session status). An attempt that did not count (a no-show, leaving before TRANSITION, a
system failure) is never scored and the link keeps its start. A withdrawn consent is never
scored. To find rounds in this state:
`select r.id, r.status, r.attempts_counted, a.outcome, s.status, s.terminal_reason from
screening_v2.interview_rounds r join screening_v2.interview_round_attempts a on a.round_id =
r.id and a.counted join screening_v2.call_sessions s on s.id = a.session_id where s.status =
'failed'`.

**Orphaned sessions lapse (PR-B).** Admission's one-live-R1 rule is global (`r1_in_flight`,
409 `r1_busy`), so a session no worker owns blocked every R1 start. The `r1-status` loop
(60 s, only while R1 is enabled) now lapses them, compare-and-set on the status it read:
`created` untouched for 15 minutes -> `failed` / `room_create_error` (attempt `no_show`);
`waiting` for 20 minutes -> `expired` / `idle_timeout` (`configuration_failed`);
`in_progress` with no row update, transcript turn or ledger row for 45 minutes -> `failed` /
`worker_crash` (`shutdown_forced`). All three outcomes are uncounted, `ended_at` is written
as the last real activity (never `now()`, so no phantom minutes are booked against the
allocation), and a worker that settles the session first simply wins. The snapshot
(`lastOrphansLapsed`, `orphanLapseErrors`) and the log categories
`r1_orphan_session_lapsed`, `r1_orphan_settle_failed`, `r1_orphan_lapse_throw` show it ran.
After a failed start the tester still retries in the SAME tab (the stored nonce rejoins a
live session); another tab or device sees `r1_busy` until the lapse runs.

**Rubric.** Seed with `npx tsx scripts/seed-r1-role.ts` (dry run) then `--apply`.
The five metrics, weights and four-level anchors are defined once in
`app/api/src/lib/r1/rubric.ts`, derived from plan 6.1 and the HR prep deck; the
deck is the only product source. Changing an anchor requires a version bump, a new
scorecard version and a refreshed pin in `r1-scorer-rubric.test.ts`. Version
`r1-rubric-2026-10.2` ties the level-4 negotiation discount to "a payment plan or a
prep-guide urgency lever (application deadline, seasonal discount)", the plan 6.1
wording; the deck lists both levers. The owner's confirmation of that wording is
pending. Re-run the seed after a rubric change: the scorer refuses a scorecard whose
metric keys or weights differ from the rubric (see "Wrong scorecard").

## SFU operations and fallback

## Room-routing contract

R1 selection requires both `R1_LANE_MODE=r1_only` on the browser worker and
the API-authored room metadata JSON marker `{"lane":"r1"}`. Browser clients
cannot set room metadata. The marker is always derived from the session, never
from the endpoint alone, under two rules:

- The R1 exchange (`POST /api/r1/exchange`, provisioning with `lane: 'r1'`) marks
  its room on EITHER SFU, the R1 SFU or the Cloud fallback, but only for an R1
  round session: it requires `interview_round_id`, otherwise provisioning fails
  closed with `r1_lane_mismatch`. The room is egress-free and carries the R1 limits
  on both.
- Every other caller (`/api/livekit/start` and exchange, Ashby) keeps the agreement
  rule: the marker is set only when the session is an R1 round (`interview_round_id`
  is not null) AND API provisioning selected the R1 endpoint. A session and an
  endpoint that disagree (an R1 round on the Cloud endpoint, or a legacy session
  while `BROWSER_LIVEKIT_TARGET=r1`) fail provisioning closed with `r1_lane_mismatch`
  before any provider call (no room is created, updated or deleted, in either
  provisioning mode).

The R1 exchange also re-asserts the marked room of a `waiting` attempt on EVERY
exchange, before the worker gate (R1 sessions stay `waiting` for the whole
interview, so this is every refresh). The room lapses after 180 s empty and a
refusing worker deletes it; on the R1 SFU (no auto-create) a missing room would
otherwise be a permanent `preparing` loop, and on Cloud the join would auto-create
an UNMARKED room. The re-assert is idempotent and a provider failure answers 503
`r1_room_unavailable` with no token. `in_progress` attempts are left alone.

The same fence runs in `/api/livekit/exchange` for a session whose room already
exists (`waiting` or `in_progress`, for example a recruiter `/start` before a flip),
and before the browser worker gate, the invite consume and any token: it answers 503
`screening_room_unavailable`, leaves the invite unconsumed and mints nothing. Both
places use one predicate, `r1LaneMismatch` in `lib/livekit-endpoints.ts`. Terminal
sessions keep the stable 404.

A marked room with mode `off` or an unknown mode is refused. In `r1_only`, an
unmarked room is likewise refused. A refusal logs `r1_room_routing_refused`,
deletes the room (`JobContext.delete_room`) and ends the job
(`JobContext.shutdown`); livekit-agents 1.6.4 has no `close_room`, and a job
that never connected is otherwise never released. Unmarked rooms with mode
`off` or an unknown value retain the legacy browser path. The mode value is
compared trimmed everywhere (one predicate, `r1_routing.r1_mode_allows`). Never
use dispatch metadata as the authorization marker.

R1 rooms are created with `departureTimeout` of 120 s (rejoin grace 90 s plus
30 s): the LiveKit server default of 20 s would close the room before the
candidate's 90 s reconnect window ends.

Flip ordering. A worker and an endpoint that disagree refuse and delete every new
room (worker `r1_only` with legacy rooms, or API target `r1` with a worker in mode
`off`), which is a candidate-visible outage. So the mode and the endpoint change
TOGETHER, inside a drained, maintenance-mode window with no `created`, `waiting` or
`in_progress` session on either lane: follow the fallback flip procedure below, and
set `R1_LANE_MODE` and `BROWSER_LIVEKIT_TARGET` in the same window. Never flip only
one of them. The API refuses part of the mismatch itself: target `r1` with no worker
gate, and the Cloud fallback while the legacy browser lane is enabled, both answer
`503 r1_unavailable` (see "Fence 7 on the R1 candidate routes" and "Cloud fallback
guard" below); a worker in the wrong mode is still only visible as refused rooms.

Teardown budget. A drain never wakes a running interview by itself: livekit-agents 1.6.4
`Worker.drain` only waits for the running jobs (up to `R1_DRAIN_TIMEOUT_SEC`, 60 s), and
`add_shutdown_callback` callbacks run only after the entrypoint has ended, so R1 registers
none (`tests/test_r1_sdk_contract.py` pins that order). An interview therefore keeps going
for up to the drain timeout, and learns of the drain only when the SDK cancels the
entrypoint 15 s after the job's shutdown request; the process is killed at
`shutdown_process_timeout` (production 90 s). The R1 cancel path is therefore sized
to `shutdown - 15 s` = 75 s in total: closing line 15 s, `phase=ended` 5 s,
transcript drain 10 s, the ordered exit steps (recording, ledger, terminal, attempt
outcome) 30 s together, session close 5 s and room delete 10 s. The room close is
not part of the shared 30 s, so a hung database write never leaves the agent in the
room. A smaller `R1_SHUTDOWN_PROCESS_TIMEOUT_SEC` scales every bound down in
proportion (`r1_session.teardown_scale`); the tests pin the sum for every allowed
value.

Browser worker drain budget: `kill_timeout`, `R1_DRAIN_TIMEOUT_SEC` and
`R1_SHUTDOWN_PROCESS_TIMEOUT_SEC` are NOT in `app/voice-livekit/fly.toml` while
R1 is dormant, because `kill_timeout = 300` would change how the live legacy
browser lane stops (Fly default 5 s). The PR that sets `R1_LANE_MODE = "r1_only"`
must add all three together; `scripts/validate-voice-worker-apps.mjs` requires
them in that case and checks `drain + 2 x shutdown + 30 <= kill_timeout`.

## SFU operations and fallback

Self-hosted operation is allowed only after S0-F passes. The R1 SFU is one
Fly `sin` Machine, dedicated IPv4, LiveKit v1.13.7 digest, WSS 443, ICE/TCP
7881, and UDP 7882. It has no Redis, Egress, SIP, Ingress, webhook, or
embedded TURN. (implemented in PR-SFU-1)

Keep JSON/info logs and private metrics; do not enable debug logging containing
candidate network data. Deploys, upgrades, cert changes, and secret changes
are manual, require zero live R1 rooms, and are followed by health, UDP-pair,
worker-registration, and browser smoke checks. (implemented in PR-SFU-2)

### Browser readiness contract (PR-LK-liveness)

The production Cloud browser worker is already a named, orchestrated worker
(`BROWSER_AGENT_NAME`, `WORKER_ORCHESTRATION=worker`), so every R1 behaviour is
OPT-IN and the Cloud lane is byte-identical to before this PR. Nothing below
changes Cloud until the cutover steps explicitly turn it on.

| Switch | Where | Absent / off (default, ships in `fly.toml`) | On (R1 cutover only) |
| --- | --- | --- | --- |
| `R1_READINESS_HOST=on` (exact) | browser worker | Prewarm posts the legacy `{app, machine_id}` readiness body; the worker starts through `cli.run_app(WorkerOptions)`; no `livekit_host` is ever sent. | Readiness is posted once from the main process when LiveKit accepts the registration (and again on every reconnect), carrying `livekit_host`, the lowercase DNS hostname of the worker's `LIVEKIT_URL`. The idle-process prewarm posts nothing. |
| `BROWSER_WORKER_ONE_JOB=on` (exact) | browser worker | SDK CPU load average, as before. | One job per machine: an idle worker is always available, a busy one never is. |
| `BROWSER_LIVEKIT_TARGET=r1` (exact) | API | Host match, dispatch verification and the token fence below never run. | They apply (below). |

Both worker switches are validated absent from `fly.toml` and `fly.phone.toml`
(`scripts/validate-voice-worker-apps.mjs`) and registered in
`config/environment.schema.json`; they are set per cutover, never baked in.

API behaviour with target `r1` only (with Cloud none of it runs):

- **Host match.** A ready lease is admitted only when its durable
  `voice_worker_leases.livekit_host` equals the hostname of `R1_LIVEKIT_URL`
  (lowercase, port and path ignored). A missing or different host releases the
  machine and answers `preparing`; no dispatch and no candidate token.
- **Boot-scoped host.** Migration 0118 nulls the host on every new claim and on
  reset, exactly like `registered_agent_name` (0112). A host report is recorded
  before the lease is marked ready; if recording fails the lease is NOT marked
  ready (500), and a stale lease answers `stale`. The host RPC accepts browser
  leases only.
- **Dispatch-drop safeguard.** After `createDispatch` the API waits for a job
  (`BROWSER_DISPATCH_VERIFY_SEC`; above the worker SDK's 7.5 s assignment
  allowance). Unset, blank, non-numeric, zero or negative means the default of
  10 s; only an explicit positive value is used, clamped to 1-15 s (a value
  below 8 deliberately undercuts the SDK allowance and can delete a slow but
  live dispatch, so leave it unset). A dispatch that stays job-less is deleted
  and re-issued ONCE, and only when the deletion is confirmed, no dispatch in
  the room owns a LIVE job (a finished job left by an earlier exchange, status
  `JS_SUCCESS`/`JS_FAILED` or a set `state.endedAt`, does not count; a
  tombstoned dispatch, `deletedAt` set, is not still listed), and no agent
  participant is in the room; anything unproven answers `preparing` instead.
  A final dropped retry is deleted too. Two agents never share a room. Only a
  double drop is slow: the exchange then waits about two windows plus up to 3 s
  of deletion proof before answering `preparing`. LiveKit Cloud keeps its
  single `createDispatch` (the drop evidence is OSS-only).
- **Fails closed.** On R1 only a PROVEN assignment mints a token. A dispatch the
  API cannot verify (no dispatch id, a `listDispatch` error, a dispatch that
  vanished from the room) answers `preparing`: the machine is released, which
  also ends any agent that did join, nothing is re-dispatched on an unproven
  room, and the abandoned dispatch is deleted best-effort. The cost is a retry
  for the candidate during a LiveKit API outage, never an agent-less room.
- **Fence 7.** An R1 candidate token requires the orchestration gate. With
  target `r1`, `WORKER_ORCHESTRATION` off, an empty/malformed
  `BROWSER_AGENT_NAME`, or a `disabled` gate verdict yields no token: `503
  screening_room_unavailable` (invite unconsumed) or `preparing`. Never turn
  `WORKER_ORCHESTRATION` off on the API while target is `r1`.
- **Fence 7 on the R1 candidate routes.** `/api/r1/*` is not the legacy exchange
  and has no invite, so it carries the same fence itself. With target `r1` and no
  worker gate (`WORKER_ORCHESTRATION` off, an empty or malformed
  `BROWSER_AGENT_NAME`), `/preflight`, `/attempts` and the exchange of a new or
  `waiting` attempt answer `503 r1_unavailable` BEFORE admission, provisioning, any
  room or any start spent, and a `disabled` gate verdict answers `202 preparing`
  (`retry_after_sec`), never a token. Nothing auto-dispatches on the R1 SFU, so
  proceeding without a gate would mint a token into an interviewer-less room. On
  Cloud nothing changes: the unnamed worker auto-dispatches.
- **Dead jobs do not count.** The R1 exchange's rejoin check reads a dispatch as a
  running interviewer only while it owns a LIVE job (the same `jobIsLive` rule as
  above: `JS_SUCCESS`, `JS_FAILED` or a set `endedAt` is over). A finished job left
  in the room is replaced like a dropped dispatch, never minted into.

Cloud fallback guard (target Cloud, the one R1 rule that runs on Cloud). While the
legacy browser lane is enabled (`LEGACY_BROWSER_SCREENING_ENABLED` not `false`), the
Cloud browser worker must stay in `R1_LANE_MODE=off` to serve legacy rooms, so it
would refuse and delete every marked R1 room AFTER a start and capacity were spent.
The R1 new-work gate (`/preflight`, `/attempts`, a new exchange) therefore answers
`503 r1_unavailable` before admission spends anything. The API's `fly.toml` sets the
switch to `false`, so this is a no-op in production today; it is the API-side
backstop for the worker-mode pairing, not a substitute for the flip procedure.

Deploy order and skew safety:

- 0118 is additive and applied first by `deploy-fly` (`migrate-production`).
  The API and browser-voice deploys then run in parallel; every order is safe
  because both sides default off. The `/ready-machine` schema accepts an
  optional `livekit_host` additively and stays `.strict()` otherwise, a Cloud
  ready post makes no host RPC, and the Cloud and phone lease readers select
  the same columns as before 0118 (neither lane depends on 0118).
- A worker must never send `livekit_host` to an API that predates it: an older
  strict schema answers 400 and readiness is lost. That is why
  `R1_READINESS_HOST=on` is set only AFTER the host-aware API is live (step 3).
- The worker's `LIVEKIT_URL` host must be a plain DNS name equal to the API's
  `R1_LIVEKIT_URL` host. An IPv6 literal or a trailing-dot FQDN cannot be
  stored: the worker then posts host-less and R1 never admits it (fails
  closed; readiness itself is not lost). A private/`.internal` worker address
  that differs from the public API URL fails the match for the same reason.
- livekit-agents 1.6 emits only `worker_started` and `worker_registered`; there
  is no disconnect event, so readiness cannot be withdrawn on a websocket drop.
  It is re-asserted on every reconnect, and the residual window (socket down,
  lease still `ready`) is closed by the dispatch-drop safeguard and the reaper.
- The post-registration readiness post is retried ONCE after a 2 s backoff when
  the API call fails (transport error, HTTP failure, or the API's fail-closed
  500 for a host-write error). That is the only retry: a worker whose two
  attempts both fail stays `starting` until the claim's ready budget expires,
  the candidate sees `preparing`, and the next claim starts clean.

Fallback flip procedure.

Invariant: **the API target is never Cloud while a browser worker is on the R1
SFU.** The host check runs only when the API target is `r1`. If a worker were on
the R1 SFU while the API still pointed at Cloud, that API would skip the host
check, admit the worker's ready lease, `createDispatch` against Cloud and mint a
Cloud candidate token into a room with no worker. So the target r1 flip is
ordered API FIRST, workers second; the two deploys cannot be made atomic, and
the order below leaves no window that skips the host check. The window between
the two deploys is fail-closed (every browser exchange answers `preparing`), so
run it with browser exchanges quiesced.

Forward flip, Cloud to R1 (target `r1`):

1. Pause R1 and drain all `waiting` and `in_progress` R1 sessions. Also confirm
   zero live browser sessions: rerun the first merge-gate query without its
   `interview_round_id` filter (over-inclusive on purpose; abort on any row).
   No browser exchange may run between steps 4 and 5.
2. Confirm zero R1 rooms and worker jobs; do not make an API-only flip without
   this. Wait out the invite re-exchange grace window (5 minutes) before
   changing the API target: a re-exchange inside it re-issues a token against
   the CURRENT endpoint without re-entering the worker gate.
3. Make sure the host-aware readiness API (PR-LK-liveness) and migration 0118
   are already deployed (target still Cloud). They must be live BEFORE any
   worker sets `R1_READINESS_HOST=on`.
4. API FIRST: set `BROWSER_LIVEKIT_TARGET=r1` (with the `R1_LIVEKIT_*` triple)
   and deploy the API. The host check now runs and fails closed: workers still
   on Cloud report no host (or another), are released, and never get a dispatch
   or a candidate token. Verify the API's returned endpoint is the R1 SFU.
5. THEN the workers: put the worker `LIVEKIT_*` triple on the R1 SFU and set
   `BROWSER_WORKER_ONE_JOB=on` and `R1_READINESS_HOST=on`. Deploy, then verify
   the worker registered there: its post-registration ready record carries that
   endpoint's `livekit_host`. Verify candidate token, room creation, dispatch
   and reaper with one smoke session; with a different or missing host the
   record is not ready and no candidate token or dispatch is issued.
6. Resume only after step 5 verifies and the owner's operating decision.

Rollback, R1 to Cloud, is the reverse and keeps the invariant: WORKERS FIRST,
then the API.

1. Pause R1 and drain as above (zero R1 rooms, zero live browser sessions).
2. Return the worker to its Cloud `LIVEKIT_*` triple and remove
   `BROWSER_WORKER_ONE_JOB` and `R1_READINESS_HOST` (or set anything other than
   `on`); deploy. The API is still on `r1`, so a Cloud worker's host-less
   report fails the host match closed: `preparing`, no token.
3. Select Cloud on the API (`BROWSER_LIVEKIT_TARGET` unset or any value other
   than `r1`) and deploy. Only now do exchanges resume, against Cloud workers.
4. Wait out the 5 minute re-exchange grace window, and apply the Cloud cap
   before admitting new sessions (the target is Cloud again).

(implemented in PR-LK-seam and PR-LK-liveness)

### S0-F3 dispatch-matrix rerun: what it must also record

The API's "any dispatch in the room owns a live job" rule (`jobIsLive`) is
deliberate: concurrent exchanges share the idempotently claimed machine, so it
must not be narrowed blindly. One residual is open and needs evidence from the
required S0-F3 dispatch-matrix rerun (R1 SFU, Config B):

- Stop a worker machine in the middle of a job and, for 60 s, poll
  `listDispatch` for that room. Record the job's `JobStatus`, its
  `state.endedAt`, and whether the dispatch stays listed.
- Record whether deleting a dispatch ends its running job.

Why it matters (R1 only; it cannot happen on Cloud and needs two failures in a
row). Exchange 1: `listDispatch` errors, the best-effort discard of the dispatch
also fails, and the claimed machine is stopped. If the OSS server leaves that
orphaned job at JS_RUNNING with no `endedAt`, the candidate's next exchange sees
it on its first poll and answers `assigned` (a token is minted) with no proof
that its own new dispatch was accepted.

Already in `jobIsLive`: a job counts as over when its status is JS_SUCCESS or
JS_FAILED, or when `state.endedAt` is set (the server stamps it, so a positive
value is proof). If the rerun shows a stopped machine's job stays JS_RUNNING with
`endedAt` 0, the follow-up must also stop counting a job owned by a dispatch the
API already abandoned. The gate is built per request, so that fact has to be
carried across exchanges (for example by recording the abandoned dispatch id);
it is not implemented now because doing it without evidence would relax the
never-two-agents rule. This is not a blocker for the PR-LK-liveness merge.

## Key rotation

Use distinct R1 server credentials (`LIVEKIT_KEYS`) and API credentials
(`R1_LIVEKIT_*`); never reuse the phone/Cloud key. Maintain two active R1 keys
during rotation. Add the new key, stage matching API/worker credentials, drain
to zero rooms, deploy in the merge window, verify a new R1 room and worker,
then remove the old key and record non-secret rotation evidence. (implemented
in PR-SFU-2)

## Legacy browser screening retirement (PR-L, plan section 8.5, D12)

Status: implemented in PR-L. This section is the drain procedure, the read-only
SQL that shows legacy usage, and the rollback. It is a procedure for the owner
or operator to run; no step here is automated and none is a launch
authorisation. Claude has no production SQL or Fly access.

### What PR-L changes

One switch retires the legacy browser lane: `LEGACY_BROWSER_SCREENING_ENABLED`
in `app/api/fly.toml` `[env]`, shipped as `"false"`. Unset or `"true"` leaves
the lane running (the code default), and any other value fails closed
(retired). The API reads it lazily on every request, so it never blocks boot.

| Surface | Retired behaviour |
|---|---|
| `POST /api/livekit/start` | 410 `browser_screening_retired`; no session, quota reservation, room or egress |
| `POST /api/livekit/invite` | 410; no invite minted |
| `POST /api/livekit/preflight` | 410; no diagnostic room |
| `POST /api/livekit/exchange` | 410, except the same-bearer re-exchange of an invite consumed within the last 5 minutes (the drain exception below) |
| `POST /api/candidate-consent/status` and `/submit` | 410 before validation; no invite read and no `consent_records` write, for a grant or a decline. `GET .../template` stays open (invite-free, read-only) |
| Ashby Mission Control `POST .../workflows/:id/invite` | 410 after the admin role check |
| Ashby import (`runImport`) for non-`phone_primary` mappings | enqueues no browser `invite_delivery`; logs `ashby_legacy_browser_invite_skipped`; the application is still linked and ingested |
| Ashby `invite_delivery` operation queued or deferred before T0 | the operation worker fails it with `browser_screening_retired` (terminal, never deferred), creates no session or invite, and logs `ashby_legacy_browser_invite_skipped`. `scorecard_write` is untouched |
| `GET /api/me` | `legacyBrowserScreeningEnabled: false` |
| Web, candidate detail | the "Browser voice screening" card and its Create invite action are not rendered; the Live call panel stays while a call is live |
| Web, Ashby Mission Control | "Get invite link" and "Reissue invite link" are not rendered (button and More menu); Review screening and Cancel screening stay |
| Web, candidate link | a retired link shows "no longer active, contact your recruiter" at the first call (the consent status), with no consent form |

The response body is `{"error":"browser_screening_retired"}` (plus `"ok":false`
on Mission Control), status 410, `Cache-Control: no-store`.

The drain, meaning what an already-started legacy session still needs, is left
open on purpose: `POST /api/livekit/worker-context`, `/:id/complete`,
`/:id/recording`, `/grant/recording`, the agent worker, scoring and recording
finalization, plus the one join-path step, the same-bearer re-exchange of an
invite consumed within the last 5 minutes.

The candidate consent routes are NOT part of the drain. They validate the
invite, and validation rejects a consumed one, so they only ever serve a link
whose session never started. Left open, a dead link could still write the
candidate's latest `consent_records` row, which phone admission reads: a decline
through a dead link would stop phone dialing for that candidate.

R1 (`/api/r1`, `/api/internal/r1`, R1 rooms) and phone (`/api/phone*`, the phone
webhook, `fly.phone.toml`, the phone worker) never read the switch; a test pins
that.

### Read-only SQL

Legacy means `mode = 'browser'` and `interview_round_id is null` (R1 rows carry
a round id). Run these in the Supabase SQL editor or `psql`. They only read.

```sql
-- Q1. Legacy usage by week, last 60 days. Negligible use is the D12 precondition.
select date_trunc('week', created_at) as week_start,
       count(*) as sessions_created,
       count(*) filter (where status = 'completed') as completed,
       count(*) filter (where status in ('failed', 'cancelled', 'expired')) as not_completed,
       count(distinct candidate_id) as candidates,
       coalesce(sum(duration_sec) filter (where status = 'completed'), 0) / 60 as completed_minutes
  from screening_v2.call_sessions
 where mode = 'browser'
   and interview_round_id is null
   and created_at > now() - interval '60 days'
 group by 1
 order by 1 desc;
```

```sql
-- Q2. The 20 most recent legacy sessions (ids and states only, no candidate data).
select id, created_at, status, terminal_reason, started_at, ended_at, duration_sec
  from screening_v2.call_sessions
 where mode = 'browser'
   and interview_round_id is null
 order by created_at desc
 limit 20;
```

```sql
-- Q3. Legacy sessions that are live or leftover. Zero rows means the drain is done.
-- candidate_joined = the invite was consumed, i.e. a candidate is in or was in the room.
select s.id,
       s.status,
       s.created_at,
       now() - s.created_at as age,
       exists (
         select 1
           from screening_v2.candidate_invites i
          where i.session_id = s.id
            and i.consumed_at is not null
       ) as candidate_joined,
       exists (
         select 1
           from screening_v2.candidate_invites i
          where i.session_id = s.id
            and i.revoked_at is null
            and i.expires_at > now()
       ) as has_unexpired_invite
  from screening_v2.call_sessions s
 where s.mode = 'browser'
   and s.interview_round_id is null
   and s.status in ('created', 'waiting', 'in_progress')
 order by s.created_at;
```

```sql
-- Q4. Outstanding legacy invites. latest_expiry is when the invite drain ends.
select count(*) filter (
         where i.consumed_at is null and i.revoked_at is null and i.expires_at > now()
       ) as unconsumed_unexpired,
       max(i.expires_at) as latest_expiry
  from screening_v2.candidate_invites i
  join screening_v2.call_sessions s on s.id = i.session_id
 where s.mode = 'browser'
   and s.interview_round_id is null;
```

```sql
-- Q5. Ashby mappings that would still want a browser invite. Plan 8.5 step 1
-- requires NO row with screening_mode = 'browser_primary' and status = 'enabled'.
select screening_mode, status, count(*) as mappings
  from screening_v2.ashby_job_mappings
 group by 1, 2
 order by 1, 2;
```

```sql
-- Q6. Legacy sessions created at or after T0 (the deploy time). Must be 0.
-- Replace the placeholder with the actual timestamp, for example
-- '2026-11-02 08:20:00+05:30'.
select count(*) as created_since_t0
  from screening_v2.call_sessions
 where mode = 'browser'
   and interview_round_id is null
   and created_at >= '<T0 timestamp with time zone>'::timestamptz;
```

### Merge preconditions (hard gate)

Merging this PR IS the retirement. It ships `LEGACY_BROWSER_SCREENING_ENABLED =
"false"` in `app/api/fly.toml`, and `deploy-fly.yml` deploys on any `app/api`
change. Plan section 8.5 step 1 and D12 make the usage evidence a prerequisite,
and only the owner can run it (Claude has no production SQL access). Do not merge
until the owner has run Q1, Q3, Q4 and Q5 against production and pasted the four
results into the PR.

| Query | Merge only if |
|---|---|
| Q1 | recent legacy use is negligible. The owner judges it and records the weekly counts |
| Q3 | no row is `in_progress`, and no `waiting` row has `candidate_joined = true`. Each is a candidate in a live call, and the API restart of the deploy would cut it |
| Q4 | `unconsumed_unexpired = 0`, or the owner accepts the count in the PR. Each one is a candidate holding a link that becomes "no longer active" at T0 |
| Q5 | no row has `screening_mode = 'browser_primary'` and `status = 'enabled'`. Such a mapping would silently stop getting invites |

Then merge only in the 07:00 to 08:30 IST window under the standard merge gate
above (`r1_settings.paused = true` and its zero checks). If the evidence is not
ready, do not merge as is. Either wait, or drop the
`LEGACY_BROWSER_SCREENING_ENABLED` line from `app/api/fly.toml` together with its
pin in `legacy-browser-retirement-isolation.test.ts`. The code default is
enabled, so that merge is inert, and the lane is retired later, once the four
checks pass, with `fly secrets set LEGACY_BROWSER_SCREENING_ENABLED=false -a
project-hello-api` (no PR cycle; verify with `GET /api/me` as in the rollback).

### Drain procedure

Define T0 as the moment the API deploy that carries `"false"` is serving (or the
secret above has restarted the API).

1. Before merging. Meet every merge precondition above, with the results pasted
   in the PR.
2. Merge and deploy. The Vercel web deploy for the same merge hides the card.
3. At T0, verify (all must hold):
   - `POST /api/livekit/exchange` with a well-formed unknown token
     (64 hex characters) returns HTTP 410 and `{"error":"browser_screening_retired"}`.
     Do the same for `/api/livekit/preflight` (body `{"invite_token": ...}`).
   - An authenticated `GET /api/me` shows `legacyBrowserScreeningEnabled: false`.
   - A candidate detail page shows no "Browser voice screening" card.
   - The R1 settings page and the phone pages still load, and the next phone
     Canary-1 dry run is unaffected.
4. Live-session drain. Re-run Q3 until no `in_progress` row remains. Those
   sessions keep working through worker-context, /complete and the recording
   routes, and are scored normally. A stuck room ends on the worker residency
   cap (`failed` with `residency_timeout`). Do not cancel an `in_progress`
   session by hand.
5. Invite drain. Invites last 24 hours (`lib/invite-token.ts`), and no new one
   can be minted after T0, so every legacy invite has expired by T0 plus 24
   hours. Q4 shows `unconsumed_unexpired = 0` once that is true.
6. Leftovers. After T0 plus 24 hours, run Q3 again. Remaining `created` or
   `waiting` rows have no joinable invite. Review the list, then cancel them
   with the owner-run statement below. It is the only write in this procedure.

   ```sql
   -- OWNER-RUN WRITE. Review the Q3 rows first. created -> cancelled and
   -- waiting -> cancelled are both allowed transitions.
   begin;
   update screening_v2.call_sessions
      set status = 'cancelled',
          terminal_reason = 'recruiter_cancelled',
          ended_at = now()
    where mode = 'browser'
      and interview_round_id is null
      and status in ('created', 'waiting')
      and created_at < '<T0 timestamp with time zone>'::timestamptz
   returning id, candidate_id, status;
   -- Check the returned rows against Q3, then commit; otherwise roll back.
   commit;
   ```
7. Close out. Q3 returns no rows, Q4 shows `unconsumed_unexpired = 0`, and Q6
   returns 0. Only then may PR-4a set `R1_LANE_MODE=r1_only`.

Ashby effects to expect after T0. An `invite_delivery` operation that was queued
or deferred before T0 is failed once with `browser_screening_retired`. It is
terminal and creates no session, so it cannot raise Q6, and it never blocks Q3.
Mission Control shows it as failed and the runtime health `operationsFailed`
count rises by that number, once: expected, not a fault. Operations already
parked at `awaiting_manual_delivery` stay parked. Their link can no longer be
delivered, and nothing in this procedure resolves them.

### Rollback

PR-L has no migration and writes no data, so there is nothing to restore.

- Fast rollback, no PR (use this first):
  `fly secrets set LEGACY_BROWSER_SCREENING_ENABLED=true -a project-hello-api`.
  It restarts the API with the lane enabled and takes minutes, not a PR cycle.
  It relies on a Fly secret overriding the `[env]` value of the same name, the
  precedence `ashby-runtime-activation.md` section 4 already uses to turn
  `ASHBY_RUNTIME_ENABLED` on over its `"false"` in `fly.toml`. Verify it rather
  than assume it: an authenticated `GET /api/me` must show
  `legacyBrowserScreeningEnabled: true` once the API is back. If it still shows
  `false`, the secret did not take precedence, so use the `fly.toml` route below.
  The web follows on its own because it reads `/api/me`. Afterwards make
  `fly.toml` agree (`"true"`, or delete the line) in the next PR, then run
  `fly secrets unset LEGACY_BROWSER_SCREENING_ENABLED` so a stale secret cannot
  hide the file.
- Durable rollback: set `LEGACY_BROWSER_SCREENING_ENABLED = "true"` (or delete
  the line) in `app/api/fly.toml` and deploy the API in the merge window. No web
  deploy is needed. Equivalently, squash-revert PR-L in the window. This takes
  the full PR cycle (three adversarial reviews, green CI, the merge window).
- Sessions cancelled in step 6 stay cancelled (terminal rows are immutable).
  Recruiters create fresh sessions and invites after a rollback.
- Ashby applications imported while the lane was retired have no browser
  invite, and that includes those whose queued invite operation was failed with
  `browser_screening_retired`. After a rollback, use Mission Control "Get invite
  link" per workflow; nothing is back-filled automatically.
- Do not roll back by editing any R1 or phone setting. Neither depends on this
  switch, and `fly.phone.toml` must stay untouched.

## Latency: what R1 logs, how to read it, and the switches (PR-4c, plan 5.15)

Measure first: the metric sink is a no-op, so every R1 turn writes one structured log
line per stage (component `r1`, event `unknown_event`, `error_type=r1_latency`). Each line
carries `schema` (the stage), `duration_sec`, `phase`, `turn_index` (the transcript row of the
candidate turn) and `error_category`. No line holds an utterance or a name.

| `schema` | Meaning (seconds) |
|---|---|
| `eou_to_turn_hook` | Candidate end of speech to `on_user_turn_completed` (endpointing plus the transcript wait); `error_category` says which anchor was used (`vad`, `final`, `hook`). This is the window a preemptive generation could overlap |
| `eou_to_llm_first_token`, `llm_ttft` | To the model's first text; and from the model call to it |
| `eou_to_guard_release`, `guard_hold` | To the first vetted sentence leaving the output guard; and how long the guard held it after the first token (it releases a sentence only once the next has begun) |
| `ack` | The acknowledgement before an owed line, with `error_category` `done`, `cutoff` or `failed` |
| `eou_to_tts_first_frame`, `tts_ttfb` | To the first audio frame the TTS node produced; and its time from the first text |
| `eou_to_first_audio` | The headline: end of speech to the agent's audio starting; `error_category` is the turn kind (`llm_reply`, `ack_then_say`, `say_only`, `reply`) |
| `say_to_first_audio` | A scripted line, `error_category` the line id |
| `first_audio_p95` | Logged once at exit: the p95 of `eou_to_first_audio` that the worker posts as `session_facts.first_audio_p95_ms` (here in seconds). `error_category` `gate` = the role-play turns the API gate reads (at least 8, else `unknown` and no `duration_sec`), `all_phases` = every phase, for information; `option_count` is the number of turns behind it |
| `sdk_*` | The SDK's own per-turn timings (`sdk_e2e`, `sdk_end_of_turn`, `sdk_transcription`, ...), to cross-check the stamps above |

Stage A targets (plan 5.15): `eou_to_first_audio` p50 <= 1.8 s and p95 <= 3.0 s, scripted lines
(`say_to_first_audio`) within 0.5 s. `fly logs --json | python app/voice-livekit/r1_latency.py`
reads a smoke session's lines (plain JSON lines work too) and prints the verdict against those
targets; its exit code is 0 for a pass, 1 for a miss and 2 when nothing was measured. Then
`eou_to_turn_hook` and `guard_hold` say where the time went.

Related lines: `r1_line_cache_play` (`cached` or `live`, with the line id as `schema`) and
`r1_line_cache_*` (warm-up events: `synth_ok`, `disk_hit`, `rate_limited`, `gave_up`, ...), and
`r1_provider_429` (a provider 429 on lane `r1`, `error_category` the component, `option_count`
the running total for this worker). Sarvam's limits are per account and shared with the phone
lane, so a phone TTS 429 burst that lines up with `r1_line_cache_rate_limited` lines is R1's.

Switches (all read at use, so a restart is enough; every one is optional):

| Variable | Default | Effect and rollback |
|---|---|---|
| `R1_ENDPOINT_MIN_DELAY_SEC` / `R1_ENDPOINT_MAX_DELAY_SEC` | 0.7 / 3.5 | Endpointing waits (SDK default 0.3 / 2.5 s). Lower the minimum for speed, raise it if candidates are cut off |
| `R1_INTERRUPT_MIN_DURATION_SEC` / `R1_INTERRUPT_MIN_WORDS` | 0.7 / 2 | How long and how many words an interruption needs (SDK default 0.5 s / 0). With Sarvam only the words count: see "Interrupting with final-only speech recognition" below |
| `R1_TTS_FLUSH_MIN_CHARS` | 60 | Early-flush length cap; `0` turns the early-flush `tts_node` off |
| `R1_LINE_CACHE` | on | `off` speaks every scripted line live, as before PR-4c |
| `R1_SYNTH_PER_MIN` | 5 | Background Sarvam syntheses started per minute (1-30); raise only after the Sarvam tier is confirmed (D13) |

### Interrupting with final-only speech recognition

Sarvam streams final transcripts only; it never sends an interim one. livekit-agents 1.6.4 lets
the candidate's voice cut the learner's reply early only when the transcript it already holds has
`R1_INTERRUPT_MIN_WORDS` words, and it makes that check before it adds a new final to the
transcript. While the candidate speaks that transcript is empty, so with the default of 2 the
voice never cuts the reply by itself: the learner stops when the candidate's turn is committed
(a final of at least `R1_INTERRUPT_MIN_WORDS` words, after the endpointing wait), and
`R1_INTERRUPT_MIN_DURATION_SEC` has no effect. `tests/test_r1_sdk_contract.py` pins the SDK facts
this rests on.

The same setting makes the SDK refuse a shorter turn ("Yes.") that is spoken over a reply it may
still cut. It keeps the words and prepends them to the next committed turn. R1 does not count
such a fragment as part of the candidate's monologue, so `CANDIDATE_MONOLOGUE` and the
`longest_candidate_turn_sec` field of the administration log measure the answer alone.

`R1_INTERRUPT_MIN_WORDS=0` restores the SDK's voice barge-in after `R1_INTERRUPT_MIN_DURATION_SEC`,
at the price that a "yeah" or a cough cuts the learner. **Stage A decides between 2 and 0**: run
the smoke session at each value and listen for the two faults, the learner talking over the
candidate until the candidate's turn is committed (value 2) against a backchannel cutting the
learner off (value 0). Keep 2 unless the first is the worse problem; the variable is read at use,
so a restart switches it.

Preemptive generation stays off: livekit-agents 1.6.4 starts it before the per-turn decision and
cannot be told the decision differs (see `_agent_turn_handling` in `r1_session.py` and
`tests/test_r1_sdk_contract.py`). Buying it back is a separate change that needs the engine's
decision to be repeatable first.

The line cache keeps candidate-free lines on this machine's disk (`r1-line-cache` under the temp
directory, keyed by the text and the voice) and the lines that carry the candidate's first name in
memory only. It is rebuilt after a restart. Listen to one cached and one live line at the first
smoke: a clip that sounds wrong is removed with `R1_LINE_CACHE=off`.

Only a line that reaches `session.say` can play cached audio, so the warm list (`_WARM_ORDER` in
`r1_session.py`) holds exactly the lines the driver says: `L-TRANSITION`, `L-TRANSITION-NUDGE`,
`L-PICKUP`, `L-EXIT`, `L-WRAP`, `L-CLOSE`, `L-ASIDE-COACH`, `L-MUTE`, `L-SIL-IB`, `L-SIL-RP1`,
`L-SIL-RP2`, `L-REJOIN`, `L-REJOIN-RP`, `L-SIL-END` and `L-SYSTEM-STOP`. `L-OPEN` is spoken at once, and
`L-TIME-CUE`, `L-NO-FEEDBACK` and `L-FAQ-DEFER` are never passed to `say` (the first two travel inside
a reply stream; the third has no runtime caller), so they are not synthesised.

## Incident handling and rollback

For any active R1 incident, set `r1_settings.paused = true` first. Preserve
session, ledger, administration-log, queue, and recording metadata for review;
do not expose recordings or presigned URLs in incident chat. (implemented in PR-2)

If the SFU has a media, reachability, or key failure, keep R1 paused, assess
S0-F evidence, and either repair/retest or execute the drained Cloud fallback
procedure. Do not route phone through the R1 SFU. (implemented in PR-SFU-2)

If an R1 deployment regresses the worker or API, pause R1, squash-revert in
the merge window, and follow the phone release rollback runbook if phone is
affected. Additive migrations are disabled rather than dropped; R2 objects are
kept for retention/DSAR handling. The restored worker must keep R1 routes on
the R1-only lane; it must not use the legacy session path. (implemented in PR-x)

For video/recording problems, switch `R1_VIDEO_RECORDING` off to continue
audio-only only when the approved R1 policy permits it; investigate multipart
and checkpoint state before retrying finalization. (implemented in PR-9a/PR-9b)
