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
2. Set `r1_settings.paused = true` at least 40 minutes before the merge. This
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

The automated zero-live pre-step named in the plan (section 9) covers live R1
only (PR #378): `migrate-production` counts live R1 sessions read-only, and
`deploy-browser-voice` refuses unless that count is 0 and fresh. Nothing in CI
checks live phone calls or screenings, so the operator still runs the gate above
by hand and records the result on the PR before squashing.

One merge of this PR does all of the following:

- `migrate-production` applies 0118. It takes an ACCESS EXCLUSIVE lock on
  `voice_worker_leases` under a 10 s `lock_timeout` (a busy table fails the
  migration instead of queueing behind live traffic). The read-only drift check
  then runs three queries: `request_phone_rescreen`, `claim_voice_worker` and
  `reset_voice_worker`. (Since 0130, M017, the script checks eight functions:
  those three first, then five that 0130 declares.)
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

R1 permits one live interview by default (M019 can raise it, see "Concurrent R1
interviews (PR #378)"). Reserve 65 participant-minutes per attempt;
typical use is about 57-60 and worst case about 70 (the 20-minute role-play). Track candidate/agent time,
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
| `monthly_cap_minutes` | The owner-approved **R1 allocation**: sessions x 65 (for example 20 x 65 = 1,300, about 33 x 65 = 2,145 in steady state; the hold was 55 before 0128). | Always, in both targets |
| `pause_line_minutes` | The **total Cloud-pool pause line** (4,000 = 80% of the 5,000 free-plan pool). | Only while `livekit_target` is `cloud` (Mode B) |

A self-hosted R1 (Mode A, `livekit_target = r1`) uses no LiveKit Cloud minutes,
so only the allocation gates it. In Mode B both checks must pass. Phone
admission is never gated by either check.

**Set the allocation before enabling R1.** `monthly_cap_minutes` defaults to
4,000, a placeholder from 0115 when it was a total-pool limit. As the R1
allocation it would mean 61 sessions a month (72 at the 55-minute hold), and in Mode A nothing else would
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
  session with no metering yet counts at least its 65-minute charge (the "live
  floor"). The floor is a **booked charge**, like the Send hold it replaces: it
  counts once and is never multiplied by 1.15 (a session unmetered for more than
  about 32 minutes counts its elapsed x2 instead, also unmultiplied: a few
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
  Its 65 is a hold, not a spend: it leaves `minutes_used` and joins the
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

**The checks run on the state after the change.** A Send adds a 65-minute hold:
refused as `capacity_exhausted` when `r1_committed + 65 > monthly_cap_minutes`,
or in Mode B when `pool_committed + 65 > pause_line_minutes`. Admission is
checked as if the start had already happened, so a start can never leave R1
above either limit: the new live session's 65-minute floor joins `r1_actual`.

**Send and start agree.** The start that converts a Send hold exchanges the hold
for a booked 65 and a 65-minute floor, which together count as 65 (the
`greatest()` of the booked and the floored terms), so a start admitted at Send
time is admitted again unless other usage grew in between. On the first of a
month, with nothing booked or metered, an allocation of 20 x 65 = 1,300 admits 20
Sends and then all 20 starts; the 21st Send is refused. (An earlier draft
multiplied the floor by 1.15: each start then needed 74.75 against its 65 hold and
all 20 starts were refused, "temporarily unavailable", until a link expired or HR
cancelled one.) The suite pins this in both modes.

| Start | Effect on the checked state |
|---|---|
| Converting the Send hold | the hold leaves `outstanding_holds`, 65 is booked, plus the live floor |
| Restarting an uncounted attempt (same attempt number) | the attempt's 65 returns from a hold to booked, plus the live floor: no new charge, charged once |
| Retake, or a first start with no hold | a fresh 65 is booked, plus the live floor |

When metered minutes dominate the booked ones (A-dominated: sessions running
longer than about 57 participant-minutes), the live floor shows on top of
1.15 x the metered minutes, so a start can need more than the hold it converts
once real usage has grown since the Send; that is real growth, not a rule
mismatch. Above either limit the API must show the candidate "temporarily
unavailable, your link stays valid" (plan D5). Reissuing a link that had **already lapsed** revives its hold, so it
re-checks capacity as a fresh 65 (409 `r1_capacity_exhausted`); reissuing a link
that is still alive changes nothing and is not checked.

**A hold is charged to the month that booked it (Mode A overshoot at month
end).** A link Sent on July 31 and started on August 1 converts a charge that is
already in July's `minutes_used`: its 65 is booked to July, and August's
allocation check adds no booked 65 for it. While the session is live it is
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
   expires, is refunded before it is counted and its 65 is lost from
   `minutes_used`;
2. write an **uncount after a system failure in the same transaction that
   terminalizes the session**, so no reader sees the session terminal while its
   attempt is still counted (a restart would be refused as `attempts_exhausted` in
   that window);
3. never end a session uncounted and count it later: an attempt that did not
   count is released with the link, by design.

The same rule is in the plan (`docs/design/r1/R1-PLAN-final.md` section 5.12,
"Counting contract") for the PR-4a worker and the PR-8 `r1.sweep` crash recovery.

The suite pins both orders (a count written while live keeps its 65 through the
sweep, also as a third start; a count written after the session ended finds its 65
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
`restored_holds`, `r1_minutes_used` (booked less 65 per uncounted charge, never
below 0) and `r1_estimate` give the figures the checks use, so that
`r1_committed = greatest(r1_minutes_used, r1_estimate) + outstanding_holds` can be
reproduced from one row. A no-show moves its 65 from `r1_minutes_used` into
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
       - planned Cloud test minutes) / 65)
```

Start with the 4,000-minute (80%) pause line; raise to 4,250 (85%) only after
two reconciliations agree within 5%. Apply a 1.15 reconciliation factor until
the ledger is demonstrated. Warn at 60/75/90%, pause at the line or projected
month-end ≥90%, and keep R1 paused through 12:00 UTC on the first until reset
behavior is evidenced. (implemented in PR-2)

### Deploying 0128 and 0129 (the 20-minute role-play)

0128 moves the admission hold from 55 to 65 minutes and the usage-ledger bound from 1830 to
2190 s; 0129 ships consent release 2026-10-16.1 ("about 30 minutes"). Before applying them:

- **Pause R1 and wait for zero live R1 sessions.** 0128 refuses to run while any R1 session is
  `created`, `waiting` or `in_progress` (a live session's 55 is booked, its floor would read 65).
  The merge gate's 40-minute pause covers it. Check with the query 0128 itself uses, which also
  counts `created` sessions (the gate query above does not):
  `select count(*) from screening_v2.call_sessions where interview_round_id is not null and
  status in ('created', 'waiting', 'in_progress');` must return 0.
- **Legal and owner sign-off of the 0129 bodies.** They are 0123's bodies with one sentence
  changed ("for about 30 minutes"); the digests are in 0129's verification block. The 0123
  sign-off does not carry over.
- **Re-pricing.** 0128 turns every outstanding 55 into a 65 in the same transaction: an open Send
  hold adds 10 to its hold month's `minutes_reserved`, an uncounted charge kept for the link adds
  10 to its hold month's `minutes_used`. A counted (spent) charge is untouched. Expect
  `outstanding_holds` and `r1_committed` to rise by 10 per open link.
- **Re-consent.** A candidate who consented to 2026-10-06.1 and has not started is asked to
  consent again (admission accepts only the greatest active release).
- **Fly.** `R1_SESSION_MAX_RESIDENCY_SEC` is 2160 in `app/voice-livekit/fly.toml`; the worker
  clamps it to at most 2160, so deploy the worker from this change, not just the env.
- **Allocation.** `monthly_cap_minutes` is sessions x 65 from now on; re-save it for the same
  number of sessions (for example 1,100 -> 1,300 for 20 sessions).

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

**Provider outages defer.** A DeepSeek timeout, a connection failure, a rate limit
(429), a server error (5xx) or R1's own open circuit breaker defers the job (reason
`r1_provider_unavailable`, delay 65 s, at least the 60 s breaker cooldown) instead of failing
it: the attempt is refunded, so a short outage does not dead-letter the job. The set of
deferrable codes is explicit (`R1_DEFERRABLE_CODES` in `lib/r1/assessment-handler.ts`).
The wait is bounded, from the job's own `job_queue` columns (which keep no per-code
count):

- a deferral **streak** is capped at 60 minutes (any code);
- a job is deferred at most **30 times** in its life for a provider failure
  (`job_queue.defer_count`, which a counted failure does not reset);
- a **timeout** is deferred only while the job has been deferred fewer than **3** times in
  total (`R1_TIMEOUT_DEFER_MAX_COUNT`). A timeout is a full billed 300 s reasoning call,
  and a transcript too long for one call times out every time, so waiting cannot fix it.
  A job that times out on every call makes about 8 calls (3 deferred, then its 5 attempts,
  about 45 minutes), not 31 (about 3 hours);
- the breaker **refusing** a call (`provider_circuit_open`) makes no call and bills
  nothing, so neither cap stops it, only the streak bound does (each refusal is still a
  deferral and adds to `defer_count`).

Past a bound the failure takes the normal path: up to 5 counted attempts with the queue's
retry backoff, a placeholder on the last, then the DLQ. **The refusal stays deferrable past
the cap on purpose.** By the cap every deferral cycle has been a failing half-open probe,
so the breaker is open. A terminal refusal would let the five attempts after the cap arrive
seconds apart inside its 60 s cooldown: one real probe failure and four refusals, so the
job would dead-letter as `provider_circuit_open`, which names no cause. Deferring the
refusal makes every counted attempt after the cap a real probe (about 70 s apart, about 6
minutes in all), so the DLQ row and the placeholder carry the provider's real code. A job
that sees a 429, a 5xx or a connection failure on every call therefore makes 35 calls (30
deferred, then its 5 attempts) over about 40 minutes before it dead-letters.
`r1-scoring-outage.test.ts` drives this with the real breaker.

**A job that defers writes no placeholder**, not even on its last attempt: it is alive and
will be scored, so HR sees no outcome yet instead of a wrong "scoring failed". The
placeholder is written only when the job is really ending. If the deferral on the LAST
attempt cannot be committed (a database error, or the lease is gone), the R1 runtime writes
the placeholder itself and the job then dead-letters by lease expiry as
`lease_expired_attempts_exhausted` (see the table).

**Scoring failure codes (R1-Q).** The DeepSeek HTTP status is no longer dropped. The real
code lands in `job_queue.error_message` on every counted (retried) failure and, once
dead-lettered, in `job_dlq.error_message` and `v_funnel_failures` as `r1:<code>`. While a
job defers, `error_message` is empty by design (`defer_job` clears it; `defer_reason =
r1_provider_unavailable` says it is waiting), and the code is only in the warn log line
`r1_assessment_failed` (`rejection_reason`, plus `http_status`).

| Code | Cause | Deferred? | What to do |
|---|---|---|---|
| `deepseek_insufficient_balance` | HTTP 402: the DeepSeek account balance is exhausted | No (waiting cannot fix it) | Top up the balance, then replay (below) |
| `deepseek_auth` | HTTP 401 or 403: DeepSeek rejected the API key | No | Fix the `DEEPSEEK_API_KEY` secret, then replay |
| `deepseek_rate_limited` | HTTP 429 | Yes (up to 30 times) | None unless it dead-letters (cap reached, then 5 real probes): replay once the limit clears |
| `deepseek_server_error` | HTTP 5xx | Yes (up to 30 times) | Same |
| `deepseek_connection` | The network failed | Yes (up to 30 times) | Same |
| `deepseek_timeout` | The call timed out (300 s) | Yes, but only the first 3 deferrals of a job | Same; a repeated timeout on one session means the transcript is too long for one call, so replaying it will time out again |
| `provider_circuit_open` | R1's own breaker refused a call after repeated provider failures (a side effect, never a cause). It defers; it should not be a DLQ code | Yes (streak bound only) | Look for the failure that opened it in the log lines before it. Seen as a DLQ code only after a refusal streak of over 60 minutes |
| `lease_expired_attempts_exhausted` | The worker lost its lease on the LAST attempt (a process crash, or the final deferral could not be committed) and the reclaim sweep dead-lettered the job. The queue writes this code, not the scorer | n/a | The placeholder is written when the final deferral fails to commit, but NOT after a crash, so check whether the session has an `assessments` row; if not, HR sees no outcome: replay the job |
| `deepseek_http_<status>` | Any other non-2xx status (for example 400 or 422) | No | Read the status; usually a request or model-name problem |
| `deepseek_protocol` | A 200 whose body could not be used | No | Check the provider status page |

The two actionable codes carry a plain sentence on the `human_review` placeholder HR
sees ("the DeepSeek balance is exhausted (HTTP 402); top up the DeepSeek account, and the
job can be replayed after the top-up"). No log line, code or message contains the key
or the provider's response body; the warn line `r1_assessment_failed` carries the code
and an `http_status` field.

**Scoring order and timeout (R1-Q).** Each call may take up to 300 s (the shared
ceiling; 180 s was too short for a long role-play at reasoning `high`). Run 0 is scored
alone and the other two runs start only after it succeeds. A provider failure therefore
costs one call, not three, and a half-open breaker (which admits exactly one probe) is
closed by run 0 before the other two run, so it can no longer fail an attempt that its
own probe passed. Worst case per job is 2 x 4 sequential calls = 2400 s, inside the 3600 s
absolute lease (the runner heartbeats the 600 s lease every 200 s).

**Replaying a dead-lettered scoring job (owner / operator step).** The code never
replays anything by itself, and a replay is deliberately a human decision.

1. Fix the cause first. For `deepseek_insufficient_balance`, open the DeepSeek
   dashboard for the account that owns the **production** key (the Fly secret
   `DEEPSEEK_API_KEY` on `project-hello-api`; do not assume the dev key in
   `app/api/.env` is the same account), check the balance and the usage graph for the
   failure window, and top up. For `deepseek_auth`, correct the secret and redeploy.
2. Find the job (read-only):
   `select id, attempts, max_attempts, error_message, failed_at from screening_v2.job_dlq
   where name = 'r1.assessment' order by failed_at desc;`
3. Replay it with the platform procedure, `screening_v2.replay_dlq_job(<dlq id>)` as
   the service role (`docs/runbooks/queue-leases.md`): it inserts one pending replacement
   job (attempts 0, `defer_count` 0, `dedup_key` null) and removes the DLQ row. The
   scorer then runs normally, and a successful re-score supersedes the placeholder as the
   next assessment revision.
4. Replay only AFTER the R1-Q scoring fixes (300 s timeout, run 0 first) are deployed.
   Owner test session `b58c7d9c`: DLQ id `f2123f6e-3875-441a-94c2-725d9ed21f42`, dead-lettered
   `deepseek_protocol` at 2026-10-08 08:34:37 UTC (probably a 402). Replaying it before
   the fix is deployed risks another billed hour of 180 s timeouts.
5. Confirm: the job leaves `job_queue` as `completed`, the session has an `assessments`
   row with `schema_version = 2` and the next revision, and `v_funnel_failures` no longer
   lists it.

The phone scorer shares the DeepSeek account but not this code. A `phone.assessment`
job that dead-lettered for the same balance reason is replayed with the same
procedure (step 3) once the balance is topped up; this change does not touch it.

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
`call`). Replay with the platform DLQ replay procedure (steps under "Replaying a
dead-lettered scoring job" above); a successful re-score supersedes the placeholder as
the next assessment revision.

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
`in_progress` with no row update, transcript turn or ledger row for 50 minutes -> `failed` /
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
| `ack` | The model's voicing of an owed move (an `intent` turn; the acknowledgement before the owed line before R1-Q), with `error_category` `done`, `cutoff` or `failed` |
| `eou_to_tts_first_frame`, `tts_ttfb` | To the first audio frame the TTS node produced; and its time from the first text |
| `eou_to_first_audio` | The headline: end of speech to the agent's audio starting; `error_category` is the turn kind (`llm_reply`, `intent`, `say_only`, `reply`) |
| `eou_to_reply_lost` | A reply the SDK cancelled before the candidate heard any of it: end of speech to the cancellation, `error_category` the turn kind. It is a **lower bound** of that turn's wait (the candidate went on waiting for the next reply), and it counts as one more sample in the p95 below and in the `r1_latency.py` report, so the slowest turns cannot drop out of the percentile by never being heard (a turn that reaches its audio is never counted here too) |
| `say_to_first_audio` | A scripted line, `error_category` the line id |
| `first_audio_p95` | Logged once at exit: the p95 of `eou_to_first_audio` (and `eou_to_reply_lost`) that the worker posts as `session_facts.first_audio_p95_ms` (here in seconds). `error_category` `gate` = the role-play turns the API gate reads (at least 8, else `unknown` and no `duration_sec`), `all_phases` = every phase, for information; `option_count` is the number of turns behind it. `lost_replies` is a separate line whose `option_count` is how many of the role-play samples are lost replies |
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
| `R1_ENDPOINT_MIN_DELAY_SEC` / `R1_ENDPOINT_MAX_DELAY_SEC` | 0.8 / 3.0 | Endpointing waits (SDK default 0.3 / 2.5 s). Lower the minimum for speed, raise it if candidates are cut off. The transition phase runs a quicker 0.4 / 1.2 s (never above these two): see "Turn taking and transcript rows" below |
| `R1_INTERRUPT_MIN_DURATION_SEC` / `R1_INTERRUPT_MIN_WORDS` | 0.8 / 3 | How long and how many words an interruption needs (SDK default 0.5 s / 0). With Sarvam only the words count: see "Interrupting with final-only speech recognition" below |
| `R1_TTS_FLUSH_MIN_CHARS` | 60 | Early-flush length cap; `0` turns the early-flush `tts_node` off |
| `R1_LINE_CACHE` | on | `off` speaks every scripted line live, as before PR-4c |
| `R1_SYNTH_PER_MIN` | 5 | Background Sarvam syntheses started per minute (1-30); raise only after the Sarvam tier is confirmed (D13) |

### Interrupting with final-only speech recognition

Sarvam streams final transcripts only; it never sends an interim one. livekit-agents 1.6.4 lets
the candidate's voice cut the learner's reply early only when the transcript it already holds has
`R1_INTERRUPT_MIN_WORDS` words, and it makes that check before it adds a new final to the
transcript. While the candidate speaks that transcript is empty, so with the default of 3 the
voice never cuts the reply by itself: the learner stops when the candidate's turn is committed
(a final of at least `R1_INTERRUPT_MIN_WORDS` words, after the endpointing wait), and
`R1_INTERRUPT_MIN_DURATION_SEC` has no effect. `tests/test_r1_sdk_contract.py` pins the SDK facts
this rests on.

The same setting makes the SDK refuse a shorter turn ("Yes.", "Sorry", "Thank you.") that is spoken
over a reply it may still cut. It keeps the words and prepends them to the next committed turn. R1
does not count such a fragment as part of the candidate's monologue, so `CANDIDATE_MONOLOGUE` and
the `longest_candidate_turn_sec` field of the administration log measure the answer alone.

`R1_INTERRUPT_MIN_WORDS=0` restores the SDK's voice barge-in after `R1_INTERRUPT_MIN_DURATION_SEC`,
at the price that a "yeah" or a cough cuts the learner. **Stage A decides between 3 and 0**: run
the smoke session at each value and listen for the two faults, the learner talking over the
candidate until the candidate's turn is committed (value 3) against a backchannel cutting the
learner off (value 0). Keep 3 unless the first is the worse problem; the variable is read at use,
so a restart switches it. The default was 2 in PR-4c: the owner's 4/10 session (b58c7d9c) showed a
two-word "Thank you." still cutting a reply, and "Sorry" / "Thank you." / "Hey, are you there?"
cancelling three replies before any audio (the candidate heard nothing), so R1-Q raised it to 3,
the value the phone lane uses for the same reason. That stops a single short fragment from cutting
a reply; it does not stop two of them adding up (see the next paragraph).

**What 3 does not fix: fragments that add up.** The SDK keeps the words it refused (its transcript
is cleared when a turn is committed, not when one is refused) and judges the next final together
with them. "Sorry" (1 word) is refused and banked; "Thank you." (2) then makes three; the SDK
commits, and it interrupts the reply it was still thinking of *before* it calls R1's hook. So the
owner's rows 12-14 ("Sorry", "Thank you.") would still cancel a pending reply at 3, and so would
"Hmm", "Okay", "Right" said one after the other. `tests/test_r1_core.py`
`TestBackchannelsOverAPendingReply` reproduces the sequence. R1 cannot stop the SDK committing that
turn, so it limits what the turn costs the candidate:

* the committed turn is **not counted as an answer** toward the icebreaker's soft exit (only words that
  are not backchannel count, see below), so noise cannot end the icebreaker;
* the next reply's **thinking filler is counted from the candidate's real answer**, not restarted
  with the backchannel: a candidate who has already waited 3.5 s hears the filler about 0.5 s after the
  new generation starts instead of 4 s later (`FILLER_RESTART_MIN_SECONDS` is the floor, so a reply that
  is about to arrive is not pre-empted). Anything the candidate hears, a real new answer from them, or a
  new phase starts the wait afresh;
* the reply that was lost still **counts in the p95** (`eou_to_reply_lost`, see the latency table).

None of this makes the lost reply come back: item 7 (dead air after short fragments) now depends on
the latency work above (PR-4c) and on the filler, not on `min_words` alone. At the first smoke, count
`r1_reply_cancelled_before_audio` and look for a `lost_replies` count above zero in the
`first_audio_p95` lines.

### Turn taking and transcript rows (R1-Q)

* **Endpointing 0.8 / 3.0 s** (was 0.7 / 3.5; the SDK's own 0.3 / 2.5 s committed a turn on a
  breath after a sentence-final clause, so a long answer was cut into several turns and several
  replies). The **transition phase** runs 0.4 / 1.2 s (`r1_transition_endpointing`, sent through
  `AgentSession.update_options(endpointing_opts=...)` on entering the phase; the session's own pair
  is sent back on leaving it): the candidate only says "ready" there. The quick pair is a ceiling on
  the session's numbers, never above them: an operator who sets `R1_ENDPOINT_MIN_DELAY_SEC` below 0.4
  keeps the lower value. A failed update is logged as `r1_endpointing_update_failed` (type only) and
  costs only the quicker window.
* **One transcript row per committed candidate turn.** Sarvam closes an utterance at each of its own
  pauses, and the SDK merges those finals into one turn, so a long answer used to be 5-6
  `transcript_turns` rows, and the short ones ("Hello", "Good", "Okay") made 13.7% of the owner's
  role-play rows two words or fewer, which alone fails the gate's `stt_sanity` (below 10%). The finals
  now collect in one open row whose `turn_index` is reserved at the FIRST final (so ordering against
  the bot's rows is unchanged) and which is written, once, when the SDK commits the turn, when a bot
  speech starts (what the candidate says next is a new row, after the bot's: barge-in order is kept),
  when the phase changes, and when the session exits. The phase driver still reads every final
  separately (ready and wrap-up matching). A crash between the last final and one of those events
  loses at most the one open row. A fragment the SDK banked (refused over a reply) joins the next
  committed turn's row, as it joins that turn's text.
* **The icebreaker exit is decided at a committed turn.** The soft exit (four answers once S >= 3:30)
  counts the SDK's committed turns, not STT finals, and only a turn with **at least three words that
  are not backchannel** (`content_word_count`: apology, thanks, greeting, "are you there", hesitation and
  acknowledgement words such as sorry, thank you, hello, hey, hmm, okay, right, sure are left out): one
  long answer used to count as several turns, and "Sorry", then "Thank you.", then "Hey, are you
  there?" as three more (the SDK commits them as turns of three and four words). A request to hear the
  question again or an audio check ("Sorry, can you repeat that?", "What did you say?", "I didn't catch
  that.", "Yes, I can hear you.", `_CLARIFICATION_RE`) is not an answer either, so it can never be the
  fourth answer that hands the candidate the transition line instead of the question they asked to hear
  again; the phrase is cut out of the turn and anything else the turn says still counts ("Can you repeat
  that? I work in sales" is an answer). The driver no longer
  leaves the icebreaker at a raw final (the transition line is uninterruptible, so that talked over a
  candidate who was mid-answer): the turn the SDK commits next is suppressed and answered by the
  transition line. Both ways out of the phase, the suppressed boundary turn and the hard S=4:30 cap, wait
  for a turn in flight (the candidate speaking again, or a final not yet committed) for at most the
  endpointing maximum plus one second after the last sign of speech, and never more than 30 s.
* **`r1_reply_cancelled_before_audio`** (warning, `option_count` = running total for the session, no
  text): the SDK cancelled a model reply before the candidate heard any of it. A few are normal (the
  candidate really did start a new turn, or two short fragments added up to the three words the SDK
  commits: see "What 3 does not fix" above); a run of them is the owner's "dead air". The cancelled
  turn's wait is also kept as a lower-bound latency sample (`eou_to_reply_lost`), and the next
  reply's filler counts from the candidate's real answer. When the icebreaker's exit is due and
  nobody is mid-turn, the turn that lost its reply is answered by the transition line instead of a
  silence window.

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

### Interviewer lines: names, the wrap-up close and the feedback refusal (R1-Q)

* **An unknown first name is not spoken.** The API sends the literal `there` when a candidate's name
  fails its letters-only test, and six scripted lines splice the name in after a comma ("Thank you,
  there."). `r1_script.known_first_name` treats an empty value, a rejected value, `there` (any case)
  and a single letter as unknown, and `r1_script.line` then deletes the `{first_name}` slot together
  with its comma: "Thank you. We'll now move to the role-play", "Hi, I'm Christy", "Are you still
  with me?", "Welcome back.", "I'm sorry, we need to stop here". The API is unchanged. The provisional
  `r1_lines.py` mirrors it (the drift test pins both).
* **The name the candidate gives.** While the record has no usable name, a self-introduction in the
  opening or the icebreaker ("my name is Cristo", "myself Cristo", "this is Cristo", after an optional
  greeting; `r1_script.spoken_first_name`) is adopted for the lines that follow and handed to the guard
  as the candidate's own name. It is deliberately narrow: the name must start with a capital letter
  as the speech-to-text wrote it, be letters only (2 to 24), be the first introduction of the session
  and not be the learner's or the interviewer's name; "I taught myself Python" and "this is great" are
  not names. The record's name always wins. A line warmed in the cache before the name was known is
  spoken live the first time (the cache keys on the exact text). The name is never logged: a
  `r1_spoken_name_adopted` line (no value) marks that it happened.
* **Acknowledgements close the wrap-up.** "Alright", "okay", "got it", "sounds good", "understood",
  "perfect", "cool", "noted" and "great" (with or without "thank you" and the other courtesy words) now
  count as "no more questions", like "No, that's all" and "That's it". Next to a "yes", or with any word
  that is not courtesy ("Alright, one more question about shifts"), the turn stays a question. The model
  is not asked to answer an acknowledgement any more, and its wrap-up replies carry a note
  (`r1_prompts.WRAPUP_REMINDER`) that forbids thanking, goodbye and "any more questions?": the scripted
  `L-CLOSE` is the only goodbye. Before this, the owner's session heard two.
  An acknowledgement is also what a candidate says *before* a question ("Okay, so ... [thinking] what
  are the next steps?"), so the driver believes a refusal only after candidate silence that depends on
  how final it sounds (`wrapup_settle_seconds`): an explicit "No questions." / "That's all." / "I'm good."
  1.5 s (`WRAPUP_SETTLE_SECONDS`, as before); a refusal made only of acknowledgements ("Alright.", "Thank
  you.", "Okay, got it.") twice that, 3 s; one that stops on a lead-in word ("Okay, so", "Thank you, and",
  "Okay, I think", "Thank you for", a trailing "um") 2.5 times, 3.75 s. Any further final in the window is joined to the turn and judged
  with it. The price is up to 2.25 s more before the closing line for a candidate who only said "Okay".
* **The feedback refusal ends the reply.** When the guard swaps a feedback sentence for `L-NO-FEEDBACK`,
  nothing the model says after it is spoken (the owner heard "the hiring team" twice in one turn).
  `L-NO-FEEDBACK` is one short sentence that does not name the hiring team: "I'm sorry, I can't share any
  feedback on how it went." `L-CLOSE` then carries the one mention of who reviews the interview ("The
  hiring team will review your interview and get back to you."), so a candidate who asks for feedback
  hears it once. (The first R1-Q wording also said "the hiring team will review your interview and be in
  touch", which put the same sentence twice, a few seconds apart, in front of the close.)
* **Content pin.** Any pinned text change bumps `CONTENT_REVISION` and the recomputed
  `PINNED_CONTENT_SHA256` (`tests/test_r1_content_pin.py`; the history of every revision is in the comment
  blocks of that test and of `r1_content.py`). PR-B's own revision 3 (`L-NO-FEEDBACK`, `WRAPUP_REMINDER`)
  joined the learner branch's revisions at 9 in the merge of main; learner iteration 1 (R1-Q S01, owner
  decisions of 2026-10-08) is revision 10: no scripted or prompted "hmm"/"honestly", a rotating
  opening-style note per free reply, a warm confirmation once a call is booked, the decision maker on the
  public card, the $7,000 anchor never an offer, "I can check with my manager" grants nothing, and the
  time cue is the learner's own next call; learner iteration 2 is revision 11, iteration 3 revision 12
  and the final review round 1 revision 13, and the ship restore revision 14 (see the next bullets).
  `docs/design/r1/R1-PLAN-final.md` carries the `L-NO-FEEDBACK`
  text (a test compares it). Check the pin comment and `CONTENT_REVISION` after every merge of main: a
  second branch that also changed pinned text takes one more bump and a recomputed hash.
* **Learner speaking style (R1-Q iteration 1).** The guard now also varies the learner's free replies,
  deterministically and with no extra model call: a tic word ("hmm", "honestly") is kept at most once in
  five replies and never twice in one, and a reaction opener ("Okay,", "Right,", "That's") used in the last
  six replies is taken off. Style edits are counted in the guard summary (`style_edits`), never posted and
  never a leak. Two new HYGIENE categories join `ack_format` and `repeat`: `reopen` (a question or a doubt
  after a MEDIUM or STRONG call was booked: the reply becomes a warm confirmation) and `misread` (the
  $7,000 taken for an offer, thanks for a discount nobody granted, the time cue turned round; "it's just
  me deciding" was a rule here too and is gone, see the ship restore). They show as `r1_guard_reopen` / `r1_guard_misread` log keys, count toward nothing and are
  not posted to the API (`HYGIENE_CATEGORIES`). The rehearsal scorecard gates the tics (no reaction word on
  more than 15 % of the replies, "hmm" and "honestly" on at most 20 % each); reply length is information
  only.
* **Learner iteration 2 (R1-Q S01, content revision 11).** The second live sweep found 24 defects; the
  worker side of the fixes, all deterministic and with no extra model call: `classify_learner_commitment`
  ignores an agreement a negator governs ("tomorrow won't work") (rolled back by ship restore round 1);
  `has_concession` ignores "I want to be sure
  it's worth it"; the guard's style surgery no longer garbles speech ("to be honest with myself" stays,
  `, -` and `But,` debris is cleaned, only an adjective or a verb loses a leading "That's"); a connector
  whose sentence was dropped goes with it; quote marks around a figure are removed; a reply asks at most
  one question and a free reply none when one of its last two replies asked (a bare "Okay." keeps its
  question); "a stretch" and "what would it involve" are used once per call (a second "a stretch" is said
  another way); the price notes know where the price stands (nothing at or below the $7,000 ask is "a
  stretch" or "better than before" when it did not move); (the rules that turned "that matches what I'd
  heard" about another figure into the real $7,000 line, kept the decision maker from "isn't one for calls"
  and checked spelled-out amounts were removed by the ship restore below); a proposed call stays unaccepted until the window opens (a hold
  note); a call the learner declined is not booked at the farewell; a push the learner already voiced
  (falling behind) is not owed again; an owed move waits ONE turn when the advisor asks a direct question
  about the learner or the people in their decision; a deep need takes the reply before another topic's
  hint; the WEAK stall for a CALL ask says "Call me back after I've talked to my {decision maker}, and
  I'll let you know" and the MEDIUM line books the call without a slot when none was named
  (`MEDIUM_DEFER_LINE`). The two new scripted sentences are masked in
  `app/api/src/lib/r1/transcript.ts` (the call-back WEAK sentence has its own pattern; the deferred MEDIUM
  line matches the existing "book a call ... so we can decide" frames).
* **Learner final review round 1 (R1-Q S01, content revision 13).** The two Opus reviews of the PR-A head
  and the third live sweep found a regression and several gaps; all fixes are deterministic, no extra
  model call. (Items (a), (b) in part, (c) and (f), the `pending_ask_at_farewell` label and the short mask
  frames below were rolled back by the ship restore: see the next bullet. They stay listed because the
  revision 13 text and logs still name them.) (a) "Before I go" is removed only as a closing clause
  (leading, a comma-bounded aside, or the end of the sentence): "before I go any further / down this road"
  is an ordinary sentence. (b) The enrolment ask is an invitation to act (pay, reserve, enrol, a payment
  or enrolment LINK or form): sending the payment, registration or enrolment DETAILS, options or
  information is an e-mail offer, so a strong advisor's "I'll email the curriculum and payment details" no
  longer earns a scripted "I'll pay the deposit today". STRONG is also blocked (the grade becomes MEDIUM, and WEAK after a declined call)
  when the learner turned a call down, said it will wait (the last 3 learner turns), or said it must talk
  to its decision maker first and the advisor did not address that afterwards (`strong_blocked:*` in the
  plan reasons). The STRONG line no longer says "for that plan". (c) The persona has ONE decider: a
  sentence that denies the card's decision maker ("it's up to me", "I'm the one who decides", "he'd just
  want me to weigh it myself") or names another party to the decision ("my mom gets a say", "run it by my
  sister") is replaced by the card's own answer (`misread: decider_contradicted`). (d) The decider stall,
  the "get back to you" closer and "still more than I planned for" have a per-call quota and a spacing
  window in a free reply (`PHRASE_QUOTA`, `PHRASE_WINDOW`); an owed move and the answer to "who else
  decides?" are never trimmed. (e) A released deep need is offered on the next OPEN dig ("What would help
  you two decide?") even if only the shadow judge released it, an offer whose reply missed the need is
  given back (up to 3 times), and a call or enrolment ask is never answered with a need (a proposed call
  is not a probe). (f) The call-proposal grammar learned "a quick word", "hop on a Zoom", "give you a
  buzz", "find twenty minutes", "how's Sunday ..." and "when's a good moment to reconnect"; a proposal it
  still misses is not a leak: inside the close window the model's acceptance is a hygiene hit
  (`misread: late_ask_accepted`) and the farewell answers it like any open proposal. The detectors are
  also scored on a held-out file (`tests/fixtures/r1_advisor_heldout.jsonl`, never tuned on; its first
  scores were call 0.86, e-mail 0.75, enrolment 0.86, farewell 0.86, price 1.00, anchor reply 0.83).
  (g) Reasons are logged: every R1 turn writes one `r1_turn_reason` line per reason label of its plan
  (`owed:*`, `stall_reason:*`, `ask_in_window:grade_*`, `call_declined`, `advisor_thin`,
  `advisor_pressured`, `strong_blocked:*`, `owed_deferred_*`, `pending_ask_at_farewell` ...): labels only,
  never text. Read them first when a commitment is lower than the advisor seemed to earn. (h) The
  rehearsal harness measures the literal first word of every reply (no whitelist), the decider stall and
  the money line per call and per window, and allows the offer ledger's prices in the fact check.
  The scorer-side mask (`transcript.ts`) matched the SHORT frames of the scripted wordings (replaced by
  whole-sentence frames in the ship restore). DeepSeek balance: a live sweep needs about 0.31
  USD and the harness refuses to start below 0.60; the phone scorer shares the account, so top it up before
  a sweep and before the owner test.
* **Learner ship restore (R1-Q S01 PR-A, content revision 14; owner decision 2026-10-09).** "Ship the
  improvements now": PR-A ships only what is proven better than production (`origin/main`); anything that
  was worse behaves exactly like production. Five review rounds of narrowing rules did not converge, so
  this round only restored production's code or deleted a PR-A-only rule; it added no regex, rule,
  exemption or guard category. Accepted gaps (not shipped in PR-A): co-decider and timing consistency
  (owner point 3), the deep need on follow-up digs (owner point 5), wordiness, and every detector miss or
  false positive production also has. What changed against the final review round 1 text above:
  * Enrolment ask: `r1_commitment._ENROL_ASK` and the per-sentence reading of `enrol_ask_in` are
    production's, verbatim (a test pins the pattern fingerprint and production's confusion counts on the
    detector corpus). "Can I send you the curriculum?" is an enrolment ask again, as in production; the
    resource-link, look-ahead and question-frame helpers are deleted.
  * Conditional commitments (`If Thursday works for you, great.`, `I'll reach out if I decide ...`) keep
    the level they have in production, so the gate sees them. The negation check is gone too (restore
    round 1, below).
  * Late asks: there is no `late_ask_accepted` exemption (a MEDIUM acceptance in a free reply is a
    `commitment` hit, as in production) and no `late_asks` admin-log key.
  * Farewell: no `pending_ask_at_farewell` reason. An early ask no longer turns the goodbye into a
    booking; a goodbye in the window goes through `register_close_attempt` (the WEAK stall), as in
    production. `_pending_ask` still feeds the hold note.
  * Early goodbye: the scripted redirect is production's `Oh wait, before you go... <owed line>` again
    (`REDIRECT_OPENERS[0]`), not an in-context brief voiced after the model's own "bye".
  * Call reader (kept, recall 31 of 38 on the triage set against 14 in production): the alternatives
    `message|whatsapp`, `take`, the part-of-the-day words of the time ask and the `so he/she/you ...` look-ahead
    were removed, because each added a false positive production does not have.
  * Guard: the rules `decider_alone`, `decider_contradicted`, `decider_unwilling`, `heard_not_anchor`,
    `heard_in_line`, `better_unchanged`, the three "before I go" strips and the money-cue/spelled-quantity
    amount check are deleted (the learner amount check and `r1_text.canonical_amounts` are production's);
    `anchor_taken_as_offer`, the repeat and tic guards, the stall quota and the confirm-only rule stay. Their
    canned lines (`ANCHOR_HEARD_REPLACEMENT`, `ANCHOR_HEARD_BELOW`, `PRICE_UNCHANGED_REPLACEMENT`) and the
    manifest keys that pinned them are gone, so `CONTENT_REVISION` is 14.
  * Scorer mask (`transcript.ts`): production's four frames, verbatim, plus each new scripted wording as a
    WHOLE trimmed sentence (the MEDIUM line with the advisor's slot, its moved and deferred forms, the
    call-back WEAK line, the e-mailed WEAK line). A barge-in cut of the call-back and e-mailed WEAK
    wordings is not hidden (production never hid them either); ordinary learner speech is hidden only where
    production hides it, apart from the frame below. Restore round 1 corrected the MEDIUM line (see there).
  * Cost bound: `RolePlayEngine.plan_turn` reads at most the last 4,000 characters of an advisor turn
    (`MAX_CANDIDATE_CHARS`), the identity for every real turn (the longest live turn is about 1,070
    characters) and for non-strings. It only caps the cost of pathological speech-to-text.
  Still in force from the earlier rounds (proved better than production): no WEAK stall loop (the WEAK line
  at most once, a stall quota), no verbatim deflection, intent-voiced in-context objections and topic
  triggers, the repetition guard, tic control, a confirmation only after a commitment, the $7,000 anchor
  never read as an offer, no unprompted need dumps, the MEDIUM line with the advisor's slot.
* **Learner ship restore, round 1 (R1-Q S01 PR-A; owner decision 2026-10-09).** The two reviews of the
  restore found five places still worse than production. Same rule: production's code restored or a
  PR-A-only rule deleted, no new regex, rule, exemption or guard category.
  * Call reading is a floor: `r1_commitment.ask_acts` reads a CALL when the structural reader
    (`call_proposal_in`) OR production's own `_CALL_ASK` (verbatim, fingerprint pinned in
    `test_r1_detector_corpus`) reads it. The structural reader alone missed proposals production books
    (third-person callees "Let me call your husband tomorrow at 7", a bare "I'll call you back", unframed
    offers "I'm happy to set up a call with your husband"); a proposal production reads is never lost now.
    The union keeps production's false positives (a programme description such as "You can book a slot
    with a mentor." is read as a call proposal again, as in production: accepted); it adds none of its own on
    any labelled row (`ProductionCallReadingTests`: hand 116/61/3, simulator 91/4/4, held-out 31/2/5 for
    tp/fp/fn against production's 66/61/53, 54/4/41, 18/2/18). `detect_callback` and the persona probe
    filter still use the structural reader alone (they only decide the slot and whether a question is a probe).
  * Deleted from the structural reader (each read, as a call, an advisor sentence production reads as
    nothing): the `talk|speak to/with your husband ...` call object ("Talk to your father tonight and I'll
    hold the price" was booked as a call; the owner's turn 78 "I can also talk to your husband" is answered
    as in production again, with the owed WEAK stall), the `<day or clock> ... works?` time ask and the
    `are` lead of the day/clock fit-check ("Sessions are on Sunday mornings, does that work?"), the
    `word` and `chat` alternatives of "a chat" / "have a word" ("Have a word with your father"), and three
    more alternatives that read other advisor sentences as a call, found with fresh adversarial sentences and
    each costing no labelled proposal that production reads: `how about` / `what about` + day ("How about I
    email you the brochure tomorrow?", "How about I hold the discount until tomorrow evening?"), the
    `do you have <time> <day>` question ("Do you have an hour in the mornings?") and the nouns `chat`,
    `catch-up` and `follow-up` of the call question ("Would a mentor chat help you feel more confident?").
    Known residual head-only readings (the proposals they carry outweigh them in the labelled and live data,
    but they are not zero): `I can do <thing> <day>` ("I can do the paperwork tomorrow."), `Can you join a
    call with <person>?`, `Can I get a word in about ...?` and `Can we have a conversation about ...?`.
  * Learner commitment classifier: `classify_learner_commitment` is production's plain pattern search
    again (the negation exemption `_affirms` is deleted). It dropped an affirmative commitment behind an
    unrelated negator in the same clause ("I have no more questions so count me in.") and let it be spoken
    with nothing posted; now it is blocked and posted as in production. The price is production's false
    positive on a genuine negation ("Thursday doesn't work for me." reads MEDIUM), accepted.
  * Scorer mask (`transcript.ts`): the frame `let's book a call` of the ship-gate round 2 is back. The MEDIUM
    line now carries the advisor's slot, so production's frame "book a call on Thursday at 7 PM" no longer
    reached a barge-in cut of it. Second-half cuts hidden: production's own line 48 of 48, the slot line 114 of
    570 and the moved form 114 of 786 before the frame, 570 of 570 and 786 of 786 with it; the deferred form
    (production has none) 30 of 54, the cuts that stop before "a call" stay visible. The frame hides 7 of 41
    ordinary learner sentences against production's 6, and the extra one ("Let's book a call? I'm not sure
    that's needed.") is a MEDIUM phrase the learner guard blocks in a free reply anyway.
* **Learner ship restore, round 2 (R1-Q S01 PR-A; owner decision 2026-10-09).** The round-1 review found the
  advice-to-the-decider and learner-schedule classes still open through sibling alternatives of the
  structural call reader. Only deletions, no new regex, rule or exemption. Deleted, each because it read an
  ordinary sentence as a call proposal that production reads as nothing and none carried a labelled, live
  or canonical proposal that production does not also miss:
  * Advice to talk to the decider: the call nouns `conversation`, `word`, `meeting`, `check-in`, `huddle`,
    `catch-up` and `discussion` (the "a quick call" object, the "have a quick word" call question, the
    `book ... <noun>` object and the `have a catch-up` object), and `together` in "talk together".
  * The learner's own schedule: the `which` lead and the plurals `evenings` / `mornings` of "What <day> works
    ...", the `time` noun of "When is the best time ...", the `how does` / `how's` lead of the day question,
    the `is` lead of "Is Saturday best for your assignments?", `lunch`, and the `schedule` verb of the
    "<verb> a time" object ("I will WhatsApp you the schedule this evening").
  * The advisor's promise of an answer: `get back to you`, `come back to you`, `loop back` ("Let me check with
    my manager tomorrow and get back to you on the discount"), and the filler words of "do <task> <day>"
    ("I can do the paperwork tomorrow") and the `-ing` of "meeting tomorrow".
  Cost, all proposals production misses too (the engine falls back to production's level): four labelled
  (`c1503`, `c1722`, `c1724`, `c1744`) and one live ("Let's say seven tomorrow evening."); `c0172` and `c1746`
  are no longer read by the structural reader alone, and still are by the union. Engine counts on the hand
  set are now 112/61/7 (tp/fp/fn). Fresh non-proposals read as a call by the structural reader but not by
  production: decider advice 27 of 127 before, 3 now; study-time questions 35 of 174 before, 0 now; other
  uses (answer promises, tasks on a day) 12 of 182 before, 1 now. 142 of these sentences are now
  `call_proposal = false` rows of the corpus (`iter2:ship-restore-2/*`), so
  `test_the_structural_reader_adds_no_false_positive_production_lacks` sees them.
  * Known residual head-only readings, none removable by a deletion: `Have a call with your husband tonight and
    let me know.`, `Could you have a call with your father this evening?` (the noun `call` is the proposal
    too: "Could we have a call with your father on Sunday?"), and `Can you join a call with <a mentor>?`.
    None occurs in the 3,804 live advisor sentences of sweeps 1-3.
  * Not changed, needs the owner: with a model that accepts the call ("Sure, tomorrow works for me.") on an
    early call ask, the intent stall turn blocks the text and posts `commitment`, so `out_of_level_commitment`
    fails where production (scripted WEAK on every ask) is clean: 21 of 39 fresh early asks. It is the price
    of the voiced stall reasons. Live: 0 of 87 stall turns of sweeps 1-3 had accepting model text. And the
    plain classifier (round 1) reads a genuine negation as a commitment: 6 of the 3,010 learner turns of
    sweeps 1-3, in 6 of 60 calls, would post `commitment` (3 of them on intent turns).

### Live-UI signals and the "I'm ready" relay (R1-Q)

The candidate's page follows three more participant attributes of the **agent** (the page trusts only
an agent-kind participant). They go out on the same single ordered writer as `phase`
(`R1Interview._enqueue_attributes`), so a slow write can neither reorder them nor stall the interview.
Keys are single plain lowercase words (the SDK camel-cases keys with separators, #332), values are
strings, and an empty string deletes the attribute. Only changes are sent; a phase that touches none
of them is the bare `{"phase": ...}` it always was.

| Key | Value | Written |
|---|---|---|
| `leadname` | the simulated learner's name, e.g. `Meera Iyer` (letters, spaces, `'`, `-`, at most 40; anything else is not published) | in the SAME `set_attributes` call as `phase=transition`; kept afterwards |
| `awaiting` | `ready` | with `phase=transition`; `""` with the next phase write (including a reconnect pause; the rejoin into the transition asks again, unless the button was already pressed) |
| `rpleft` | whole seconds of role-play budget left (`remaining_roleplay_seconds()`: the shorter of the 20:00 role-play clock and the 26:00 session cap), clamped 0..3600 | with every phase write while the role-play runs or is paused (`roleplay`, `aside`, a reconnect pause inside it, the rejoin); a **30 s heartbeat** while the phase is `roleplay` (`RPLEFT_HEARTBEAT_SECONDS`, refreshed value only, coalesced so a stuck writer is not flooded); `""` with the first phase write after the role-play (`roleplay_exit`, `closing`, `aborted`) |

It is an upper bound, not a promise: the role-play can end early (R >= 14:00 with the commitment
resolved). An old page ignores all three; a new page with an old worker simply shows no button and no
clock.

**The "I'm ready" button.** The candidate token has `canPublishData: false` (R1-PLAN threat 13), so the
browser cannot send anything into the room. It calls `POST /api/r1/ready` with
`{"attempt_token", "nonce"}` (the exchange's two secrets and nothing else; extra keys are a 400), and
the API relays one fixed message with the LiveKit server SDK: topic `r1ready`, reliable, bytes
`{"v":1,"kind":"ready"}`, addressed to the agent participant(s) found with `listParticipants` in that
attempt's own room (broadcast when none is found or the listing fails: the payload is the same and only
the worker acts on it). No token grant changed; two tests pin `canPublishData: false` on both tokens.

| Answer | Meaning |
|---|---|
| 200 `{"ok": true}` | the message was handed to LiveKit (not a promise the worker acted on it) |
| 404 `r1_attempt_invalid` | unknown attempt, wrong nonce, **or an attempt token older than 5 minutes**: the page re-mints a token (a rejoin: `POST /api/r1/attempts` with the link and the nonce) and presses again once |
| 409 `not_live` | no live room for the attempt (not provisioned, ended, or LiveKit says the room is gone) |
| 409 `consent_required` / `round_not_admissible` / `r1_disabled` | as for the exchange: a withdrawal, a lapsed round or the master switch stops it |
| 429 `r1_ready_rate_limited` | 6 requests a minute per attempt (sliding window, in memory, counted only after the token and nonce verified, so junk cannot spend a real candidate's allowance) |
| 503 `r1_room_unavailable` | LiveKit did not take the message (each server call is bounded at 4 s); retry |

The relay is not new work: R1 pause, maintenance and the DeepSeek probe do not stop it. Each accepted
relay writes one `resource.update` audit event (`resource: interview_round_attempt_ready`, round id,
attempt number; no secret).

**What the worker accepts** (`R1Interview._on_data_received`): topic `r1ready`; **no sending
participant** (only server credentials produce a data packet without one, and a message that names a
participant is never the button, whatever it says); the payload exactly `{"v": 1, "kind": "ready"}`
(UTF-8 JSON, at most 128 bytes, no extra key); the phase is `transition` and the worker is waiting
(`awaiting=ready` was sent and the wait has not ended); and it has not been pressed already. The press
is **latched**, not queued as a turn: the transition driver forgets the turns queued before it starts
waiting, and the button is usually pressed while the ~30 s briefing is still playing. A latched press
ends the wait at once (no "Whenever you're ready" nudge) and the learner picks up, exactly as for a
spoken "ready" (which keeps working). It is not a transcript row.

Logs, all by label (no name, no text): `r1_ready_button` (accepted); `r1_ready_rejected` with
`error_category` `sender` or `payload` (warning: something other than the relay sent on the topic),
or `not_awaiting` (info: too late, too early or a repeat, which is normal); `r1_data_ignored` with
`error_category=topic` (info, **once per session**, only while the button is awaited): a data message
arrived under another topic, and `schema` is a closed label for it, never the topic itself (the log
fence allows no runtime string): `none` (no topic), `spelling` (the button's topic with other case,
punctuation or spacing, the likeliest way for the real SFU to differ from the fakes), `livekit` (an `lk.`
topic of the SDK) or `other`. In the API,
`r1_ready_send_failed` and `r1_ready_agent_lookup_failed` are the two LiveKit failure labels.

Triage for "the button did nothing": the audit event says the API relayed it; an `r1_ready_button` line
in the worker log says the worker took it; `not_awaiting` says it came outside the transition; a `404`
on the page is a stale attempt token; an `r1_data_ignored` line means the message reached the room under
a topic the worker does not take (`schema=spelling` means a case or punctuation difference from
`R1_READY_TOPIC` in `app/api/src/routes/r1-candidate.ts`, `other` means look at what the SFU delivers);
no worker line at all with an audit event means the message did
not reach the room (check the interviewer's identity in the room and the R1 SFU's server API).

**Smoke it on the real SFU before the owner tests it.** Every test of the relay uses fakes (the API's
`sendData` and `listParticipants`, and a synthetic packet on the worker side), so that a *server-sent*
message with `destinationIdentities` reaches the agent's `data_received` with `participant=None` and
`topic == "r1ready"` rests on the pinned SDK shape (`test_r1_sdk_contract`), not on a live call. After
the merge and the deploy (merge window rules: after 21:00 IST, ping the phone session, zero live calls),
run the first R1 smoke through the normal flow and press the button once in the transition. Pass: one
`interview_round_attempt_ready` audit row, one `r1_ready_button` worker line, the learner picks up
without the nudge, and no `r1_ready_rejected` or `r1_data_ignored` line. Alternatively, in a throwaway
room: join with a Python `rtc` client, have `RoomServiceClient.send_data` (the R1 SFU's server API) send
`{"v":1,"kind":"ready"}` as `RELIABLE` with topic `r1ready` and `destination_identities` = the client,
and assert `packet.participant is None` and `packet.topic == "r1ready"`. A spoken "ready" works either
way, so a failure here costs the button only, never the interview.

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

For video/recording problems, set `r1_settings.recording_mode` to `off` (instant), or to
`audio` to continue audio-only only when the approved R1 policy permits it; unsetting the
worker secrets `R1_RECORDING` and `R1_VIDEO_RECORDING` needs zero live R1 sessions.
Investigate multipart and checkpoint state (the Recording section below) before
retrying finalization. (implemented in R1-REC)

## Recording (R1-REC): camera video and both voices, in the worker, to Cloudflare R2

(implemented in R1-REC, branch `r1/rec`; ADR-0016 and its 2026-10-13 amendment. Recording ships OFF behind
three independent locks and nothing below turns it on by itself. Real candidates stay out of scope until the
Legal gates of migration 0123 pass.)

### What it does

The R1 worker (`app/voice-livekit`) records inside the job process: the stock SDK recorder keeps writing the
stereo OGG (left candidate, right agent), a tee mixes both sides to mono and hands them, with the candidate's
camera pictures, to a niced child process (`r1_video_encoder`) that writes H.264 640x360 15 fps plus live AAC
into a fragmented MP4 in `/tmp/r1-rec/<session_id>/`. An uploader thread sends 5 MiB parts of that growing file
and a 2-minute OGG checkpoint to **presigned URLs the API hands out**; the worker holds no R2 credential. When the
interview ends the worker flushes, uploads the last part, optionally a faststart copy `video.mp4`, and calls
`complete`; the API finalizes (completes the multipart upload, verifies size, SHA-256 and file signature) and the
row becomes `ready`, `partial` or `failed`. Staff play it from the candidate page (all roles; interviewers only for
their own candidates) and admins can click a transcript turn on the Review tab to seek.

| Object under `r1/<round_id>/<session_id>/` | Written by | Kept |
|---|---|---|
| `stream.mp4` | worker, multipart | deliverable when there is no valid `video.mp4` (forced exits, crashes) |
| `video.mp4` | worker, one PUT: the faststart copy at a normal exit, or (since PR #377) the frozen fragmented-MP4 prefix a crashed encoder left, sent while the call goes on (layout `split`) | preferred deliverable; `stream.mp4` is then removed |
| `audio.partial.ogg` | worker, every 120 s | removed by finalize unless it is the only audio |
| `audio.ogg` | worker, only when the MP4 cannot carry all the audio | kept for `split` / `audio_only` |

Database: `screening_v2.interview_round_recordings` (one row per attempt session), `screening_v2.r1_recording_purge`
(outbox so a deleted row can never strand objects) and `screening_v2.r1_settings.recording_mode`. Queue names
`r1.recording.finalize`, `r1.recording.erase` and `r1.sweep` run on a second runner (`r1-storage`) of the R1 runtime.

### The three locks and the effective mode

Recording happens only when ALL of these say yes; with any lock off an R1 interview behaves exactly as before
(no recorder, no spool, no encoder, no recording call; the only changed behaviour is that the worker connects
**audio-only** and so no longer receives the camera when video is off).

| Lock | Where | Off means |
|---|---|---|
| Storage: `R1_RECORDING_S3_ENDPOINT`, `_REGION` (`auto`), `_BUCKET` (`ik-r1-recordings`), `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | Fly secrets on `project-hello-api` ONLY (never the voice apps; `validate-voice-worker-apps` refuses the two keys there) | the five unset: routes answer 503 `r1_recording_disabled` and `/context` says `off`; any one set or invalid: config `invalid` (one log line without values), recording off |
| Worker capability: `R1_RECORDING=on`, `R1_VIDEO_RECORDING=on`, optional `R1_VIDEO_X264_PRESET` (`ultrafast`/`superfast`/`veryfast`) | Fly secrets on `project-hello-voice`; must be ABSENT from `fly.toml` and `fly.phone.toml` (validator) | anything but exactly `on`: no recorder; `R1_VIDEO_RECORDING` not `on`: audio only |
| Operational switch: `r1_settings.recording_mode` `off` / `audio` / `av` | DB, admin `PUT /api/admin/r1/settings` or SQL | `off` (default), instant, no deploy |

Plus the candidate's live consent containing `video_audio_recording` (checked on every worker call). Effective mode
= min(worker capability, `recording_mode`) with `off < audio < av`; the encoder self-test can lower it at run
time (no `libx264`: audio; no `aac` or no encoder: OGG only). API knobs (optional, out of range = config `invalid`):
`R1_RECORDING_MAX_BYTES` (default 400 MiB), `R1_RECORDING_DOWNLOAD_TTL_SEC` (300), `R1_RECORDING_RETENTION_DAYS`
(90, max 90). Web (optional): `VITE_R1_RECORDINGS_ORIGIN` for the CSP `media-src`.

### Owner steps in Cloudflare (never paste a key or token into chat)

1. **Jurisdiction first; it is immutable.** Legal confirms (0123: the bucket is created only after their advice).
   Recommended: no jurisdiction, location hint Asia-Pacific (`apac`). A jurisdiction changes the endpoint host
   (`<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`).
2. **Bucket** `ik-r1-recordings`: Standard class, hint `apac`, public access OFF (no r2.dev URL, no custom domain),
   NO bucket lock (a lock would block withdrawal and DSAR deletes). Optional usage notification.
3. **Token**: R2, Manage API tokens, **Object Read & Write** on that bucket only, no IP filter (Fly egress is not
   fixed), TTL forever with a rotation entry. Note the Access Key ID, Secret Access Key (shown once) and
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
4. **Lifecycle** (dashboard login; the bucket token cannot do it): prefix `r1/`, delete after **97 days**; prefix `r1/`,
   abort incomplete multipart uploads after **1 day**. This is the backstop; the app deletes at 90 days.
5. **CORS** (plain `<video src>` needs none; this keeps HEAD probes and future captions working):
   `[{"AllowedOrigins":["https://ib-ik-project-hello.vercel.app"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["range","if-none-match","if-modified-since"],"ExposeHeaders":["Content-Length","Content-Range","Accept-Ranges","ETag","Content-Type"],"MaxAgeSeconds":3600}]`
6. **Stage the API secrets** in your own PowerShell (`--stage`: no restart, applies at the next API deploy):
   `fly secrets set --stage -a project-hello-api "R1_RECORDING_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com" "R1_RECORDING_S3_REGION=auto" "R1_RECORDING_S3_BUCKET=ik-r1-recordings" "R1_RECORDING_S3_ACCESS_KEY_ID=<id>" "R1_RECORDING_S3_SECRET_ACCESS_KEY=<secret>"`,
   then `fly secrets list -a project-hello-api | Select-String "R1_RECORDING"`. Never on `project-hello-voice` or `project-hello-phone-voice`.
7. **Smoke (S0-D part 1)**, same PowerShell with the five values exported as env vars, from `app/api`:
   `npx tsx scripts/r1-recording-smoke.ts`. It must print PASS for every item (presigned UploadPart x3 with a bare PUT,
   `ListMultipartUploads` naming the open upload by exactly the UploadId `CreateMultipartUpload` returned (a FAIL there
   means the sweep's ownership test cannot work on R2), part replacement, complete, HEAD, Range GET 206, CORS echo and
   none for another origin, prefix-complete after a simulated crash, abort and an empty `ListMultipartUploads`, 5 s
   expiry returning 403, lifecycle read-back, cleanup of `r1/smoke/`). **This is the only proof against real R2; the local S3 used in development differs in details.**
8. Optional: Vercel env `VITE_R1_RECORDINGS_ORIGIN=https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (Production and Preview).
9. Record non-secret evidence (token scope screenshot, bucket creation date and hint, the two rules, the CORS JSON) per
   `docs/security/credential-inventory.md` and flip that row to Provisioned.

### Deploy rules for this PR

- Any change under `app/voice-livekit/` deploys BOTH voice apps (`deploy-fly.yml`). After the merge, watch for the
  automatic `Deploy (Fly)` run for the merge SHA and **cancel it before `deploy-phone-voice` starts**.
- At a zero-live moment confirmed with the phone session (zero live phone and R1 sessions by SQL), by day:
  `gh workflow run "Deploy (Fly)" --ref main -f service=both` (migrations converge first, then `api` and `browser-voice`;
  the staged API secrets apply on this API deploy; `flyctl deploy` applies the new `[[vm]]`: performance-2x, 2 vCPU, 4096 MB).
- Verify: both images show `GH_SHA` = merge SHA; `/api/health` 200; `fly machines list -a project-hello-voice` shows
  `performance-2x:4096MB`, one machine, stopped; `select to_regclass('screening_v2.interview_round_recordings')` is not
  null; `select recording_mode from screening_v2.r1_settings` is `off`; `fly secrets list -a project-hello-api` shows the
  five `R1_RECORDING_S3_*` names as deployed.
- Only after 21:00 IST: `gh workflow run "Deploy (Fly)" --ref main -f service=phone-voice` so both images match `main`,
  then a phone canary dry run.

### Deploying PR #377 (browser-voice VM to performance-4x; recording upload fixes)

The rules above are the PR #372 record and stay as they were. PR #377 changes `app/voice-livekit/` (the `[[vm]]` of
`fly.toml`: performance-4x, 4 vCPU, 8192 MB; the recorder) and `app/api/` (the `r1.sweep` orphan scan and finalize), so
the automatic run would redeploy the API and both voice apps at the merge.

1. Pause R1 (`r1_settings.paused = true`) before the merge; live R1 sessions finish.
2. Merge. Watch for the automatic `Deploy (Fly)` run for the merge SHA and **cancel it before `deploy-phone-voice`
   starts**.
3. At a zero-live moment confirmed with SQL (the gate queries at the top of this runbook return no row), by day:
   `gh workflow run "Deploy (Fly)" --ref main -f service=both` (api + browser-voice; `service=browser-voice` alone would
   leave the sweep and finalize fixes undeployed, since the cancelled run deployed nothing).
4. Verify: `fly machines list -a project-hello-voice` shows `performance-4x:8192MB` (one machine, stopped); the API and
   browser-voice images show `GH_SHA` = merge SHA; `/api/health` 200.
5. Later, in the 21:00 IST window: `gh workflow run "Deploy (Fly)" --ref main -f service=phone-voice` so both voice images
   match `main` (`fly.phone.toml` is unchanged), then a phone canary dry run.
6. Unpause R1 only after verification and the owner's decision. Rollback of the VM: the "VM problem" row below.

### Enable order (staff only; flags change in this order, each step has a gate)

| # | Step | Gate |
|---|---|---|
| E1 | Flags off: `a0_retest.py rehearse` against the resized worker | the worker boots and registers; an R1 interview still works with the audio-only subscription (this is the one live-lane change in the PR) |
| E2 | Bucket, lifecycle, CORS and the smoke above (if not done before the merge) | smoke prints PASS for every item |
| E3 | Zero-live: `fly secrets set -a project-hello-voice R1_RECORDING=on R1_VIDEO_RECORDING=on`; `recording_mode='audio'`; one staff rehearsal | row `ready`, `layout=combined`, `has_video=false`, it plays |
| E4 | `recording_mode='av'`; two extended rehearsals (>= 7 min, camera toggled off and on once) | `ready`, `has_video=true`, `frames_dropped/frames_encoded < 2 %`; Chrome and Safari (desktop and iOS) play and seek to 10/50/90 %; an admin click on a Review turn lands within 1 s; a withdrawal test erases; a DSAR test erases |
| E5 | One 20-minute human staff session on a real laptop camera | loop-lag max < 250 ms, CPU p95 < 60 %, finish < 18 s; append the S0-C and S0-D evidence to ADR-0016 |
| E6 | Owner test with a FRESH staff R1 link | rule "prove before owner tests" |
| E7 | Candidates (Stage B) | only after the Legal gates of 0123 |

Setting the mode: `PUT /api/admin/r1/settings {"recording_mode": "audio"}` (admin) or, in the SQL editor,
`update screening_v2.r1_settings set recording_mode = 'audio' where singleton;`. Flipping a worker secret restarts a
started machine, so do it only with zero live R1 sessions.

### Reading the state (read-only SQL and the health route)

`GET /api/admin/r1/recording-health` (admin) returns counts only: `counts_by_status`, `oldest_live_seconds`,
`retention_overdue`, `purge_backlog`, `finalize_failed`. The same from SQL:

```sql
-- States and their oldest update; nothing should sit in a live state for long.
select status, count(*) as n, min(updated_at) as oldest_update
from screening_v2.interview_round_recordings group by status order by status;

-- Stuck: live rows older than 2 h (the sweep moves them on at 2 h) or finishing for over 30 min.
select session_id, status, requested_mode, updated_at, finalize_attempts, failure_reason
from screening_v2.interview_round_recordings
where (status in ('preparing', 'uploading') and updated_at < now() - interval '2 hours')
   or (status = 'finishing' and updated_at < now() - interval '30 minutes');

-- Retention overdue (the R1 runtime must be running, see the warning below) and the purge backlog.
select count(*) as retention_overdue from screening_v2.interview_round_recordings
where deleted_at is null and delete_after <= now();
select count(*) as purge_backlog, min(queued_at) as oldest from screening_v2.r1_recording_purge where done_at is null;

-- Queue health: live jobs and the dead-letter rows (these also feed v_funnel_failures, stage 'recording').
select name, status, count(*) from screening_v2.job_queue
where name in ('r1.recording.finalize', 'r1.recording.erase', 'r1.sweep') group by 1, 2 order by 1, 2;
select name, error_message, failed_at from screening_v2.job_dlq
where name like 'r1.recording.%' or name = 'r1.sweep' order by failed_at desc limit 20;

-- One finished recording (E3/E4 gate): no URL, key or hash leaves the database through the API.
select status, layout, has_video, requested_mode, duration_ms, video_bytes, width, height, fps,
       frames_encoded, frames_dropped,
       round(100.0 * frames_dropped / nullif(frames_encoded, 0), 2) as dropped_pct,
       camera_off_ms, degraded_reason, failure_reason
from screening_v2.interview_round_recordings where session_id = '<session id>';

-- The table is service-role only.
select has_table_privilege('anon', 'screening_v2.interview_round_recordings', 'select') as anon_can_read;  -- false
```

What the columns mean in practice: `ready` = one combined MP4 with both voices (and the picture when `av` was asked
and nothing degraded). `partial` = something usable but not the whole promise: the picture was given up under load
(`degraded_reason` `cpu_loop_lag`, `cpu_vad_slow`, `frame_drops`, `upload_backlog`), the camera never delivered
(`video_unavailable`), the encoder died (`split`: an MP4 prefix plus the whole OGG), or the worker vanished (salvage
from the uploaded parts and the last OGG checkpoint, `failure_reason='worker_lost'`). `failed` = nothing valid
(`nothing_uploaded`, `oversize`, `integrity`, `object_missing`, `finalize_exhausted`). A staff mint that finds the object
missing or changed (HEAD 404 or a different ETag) quarantines the recording (`failed`, audit `recording.quarantined`).

Known limit of `split` (crash-recovered) recordings: the OGG is the audio master and the stock recorder squeezes out any
stretch in which neither side produced audio (a candidate rejoin gap while the agent was silent), so after such a gap the
audio runs earlier than the video by the length of the gap (measured: 10 s and 20 s gaps in the local proof) and a
click-to-seek on a later turn lands early by the same amount. The player labels these recordings "Recovered recording:
audio and video may drift." A `combined` recording is gap-padded on the wall clock and does not drift (measured: beep and
flash within 20 ms before and after a 20 s gap). A salvaged recording (`worker_lost`) has no start time, so it plays but
has no click-to-seek.

Worker log codes (component `r1`, `error_type`; values are never a URL, key or id): `r1_rec_started`, `r1_rec_finished`
(`error_category` = layout), `r1_rec_degraded` (`error_category` = reason), `r1_rec_discarded` (consent withdrawn,
disabled or deleted: the spool was overwritten and nothing more is sent), `r1_rec_abandoned` (the API said stop),
`r1_rec_prepare_failed`, `r1_rec_upload_retry`, `r1_rec_complete_failed`, `r1_rec_finish_timeout`,
`r1_rec_encoder_unavailable`, `r1_rec_encoder_crashed`, `r1_rec_encoder_stalled`, `r1_rec_disk_low`,
`r1_rec_video_unavailable`, `r1_rec_camera_*`, `r1_rec_tee_failed`, `r1_rec_io_close_timeout`,
`r1_rec_prefix_uploaded` (a lost encoder's frozen MP4 went up as the `video` object; `error_category` = `mid_call` or
`finish`), `r1_rec_prefix_failed` (a prefix round failed; `option_count` = rounds so far), `r1_rec_prefix_skipped`
(`error_category` = why it cannot go up on its own), `r1_rec_multipart_gone` (a part URL answered 404: no more parts).

API log codes (`error_category`; never a key, an upload id or a URL): `r1_recording_<status>` per finalize verdict;
`r1_recording_upload_missing` (warn, component `r1-recording`): finalize found the `stream.mp4` multipart upload gone
and no `stream.mp4`, so every uploaded part was lost to somebody else's abort; the verdict is still decided from what is
left (a `video.mp4` or the OGG may save the call); `r1_sweep_done`, `r1_sweep_had_errors`, and `r1_sweep_orphan_aborted`
(warn, `error_type` = how many multipart uploads the orphan scan aborted). Since PR #377 the orphan scan never aborts the
upload of a live row (`preparing`, `uploading`, `finishing`), whatever UploadId string the listing shows; it aborts only
the uploads of a session with no row, a deleted row, or a terminal row that does not name that upload.

### Retention, withdrawal, DSAR, legal hold

- **Retention** is per row: `delete_after = created_at + R1_RECORDING_RETENTION_DAYS` (max 90), fixed at prepare.
  `r1.sweep` (every 15 minutes) erases due rows. **Finalize, erase and the sweep run whenever the R2 recording secrets
  (`R1_RECORDING_S3_*`) are set on `project-hello-api`, with `R1_ENABLED` on or off:** with it on they are the `r1-storage`
  and `r1-sweep` loops of the R1 runtime, with it off the API starts the same lane on its own at boot
  (`createR1StorageRuntime`, log line `r1_storage_runtime_standalone`), so the env switch an operator flips in an R1
  incident never strands a consent withdrawal or the retention. Neither `R1_ENABLED` nor `r1_settings.enabled` /
  `paused` / `recording_mode` stops them. They stop only when the R2 secrets are unset (jobs then wait, no attempt is spent);
  objects then outlive their 90 days until the 97-day R2 lifecycle rule removes them: `retention_overdue` above 0 is the alarm.
  Do not unset the R2 secrets while recordings exist.
- **Withdrawal** of consent (withdrawn or declined, not superseded) enqueues `r1.recording.erase` in the same transaction;
  every worker route then answers 409 `r1_consent_withdrawn` and the worker discards. A recording made after a later
  re-consent survives. A consent that is only **superseded** (a retake under a newer template closes the old consent and
  inserts the new one as two writes) is not a withdrawal: a worker route that finds no live consent still answers 409 and
  the worker still discards what it holds, but nothing already stored is erased, and finalize keeps a recording made under
  the consent then in force. Erasure for consent needs a `withdrawn` / `declined` consent at or after the recording was
  made, in the gate, in finalize and in the session-scoped erase job alike. **DSAR** erases every recording of the candidate and verifies it BEFORE any row is deleted; a failure
  leaves the DSAR `in_progress`. Both use one routine: abort multipart uploads, delete every key under the prefix, verify the
  prefix is empty and each key answers 404, only then tombstone the row (`deleted`, bytes and hash kept as evidence).
- **Known gap: a retake whose new consent leaves recording out.** A retake under a newer consent template that does not
  contain `video_audio_recording` closes the old consent as `superseded`, and a supersede is not a withdrawal (see above), so
  nothing is erased: the earlier attempt's recording stays `ready` and playable by staff until its `delete_after` (at most
  90 days after it was made) or a DSAR. The retake itself is not recorded (`/context` answers `recording.mode='off'`, every
  worker route answers 409 `r1_consent_withdrawn`, the worker discards). This is deliberate (a template bump must not erase
  consented recordings), but it means a candidate who re-consents without recording has NOT asked for the earlier recording
  to go. If they do ask, record it as a withdrawal or decline of the live consent (that erases every earlier recording of the
  round) or run a DSAR; this PR has no per-recording staff erase route. Decide before Stage B whether the re-consent step
  should ask about the earlier recording explicitly.
- **Legal hold** blocks erasure (`erasure_blocked_legal_hold`, audited at most daily) for holds on the candidate, the
  session or the recording. The copy of held objects to a `legal-hold/` prefix outside the 97-day rule is NOT built: a hold
  placed on an R1 candidate would still lose its objects at 97 days. No hold can exist in Stage A (staff only); build the copy
  step before Stage B.

### Rollback

| Problem | Action | Zero-live needed |
|---|---|---|
| Recording misbehaves, interviews fine | `recording_mode = 'off'` (in-flight sessions finish as recorded); then, if needed, `fly secrets unset R1_RECORDING R1_VIDEO_RECORDING -a project-hello-voice` | mode: no; secrets: yes |
| CPU degradation seen | the picture is given up automatically (`r1_rec_degraded`); set `recording_mode='audio'` or off | no |
| Any R1 incident | `r1_settings.paused = true` first | no |
| API cannot presign | `fly secrets unset R1_RECORDING_S3_* -a project-hello-api` restarts the API: gate it; routes then answer 503 and the worker records nothing | yes |
| VM problem (capacity, boot) | revert `cpus` and `memory_mb` in `fly.toml` (both lines), redeploy `service=browser-voice` (`fly scale vm` is overwritten by the next deploy) | yes |
| Full revert | squash-revert the PR in a zero-live slot; migration 0127 stays (disabled, never dropped while objects exist) and R2 objects are kept for retention and DSAR | yes |

### What is and is not proven (state at this PR)

Proven in CI and locally: the unit and integration suites of all three layers, the SQL assertions, and a local end-to-end
run of the real recorder, real API routes and the real S3 adapter against a local S3 (recorder output finalized through
presigned multipart uploads, played in Chromium, click-to-seek offsets checked against decoded audio; see the PR body).
**Not proven until the owner steps and E3-E5 are done:** presigned `UploadPart` and signed `Content-Type` against real R2
(smoke), Safari behaviour, real camera CPU on `performance-4x` (S0-C; it failed on `performance-2x`, ADR-0016), real
SFU camera subscription under audio-only connect, and the first seconds of video being black while the camera
subscription is requested (counted in `camera_off_ms`).

## Concurrent R1 interviews (PR #378)

M019 lets up to 25 R1 interviews run at the same time on the self-hosted SFU. **It ships inert:**
`max_concurrent_sessions` is 1, both agent-name flags are off and `R1_ASSESSMENT_CONCURRENCY` is 1,
so admission, dispatch and scoring behave exactly as before until an operator works through the
rollout below. Every figure here marked "estimate" is unmeasured until the load test.

### What limits concurrency

Admission (`r1_admit_attempt`, migration 0131) admits a new R1 session only while the live R1
count is below the **limit**:

| Target (`r1_settings.livekit_target`) | Limit |
|---|---|
| `r1` (self-hosted SFU) | `least(max_concurrent_sessions, browser worker pool size)`, never below 1 |
| `cloud` (fallback) | **1**, whatever the setting says (the Cloud Build plan's agent sessions are shared with phone) |

- **The setting.** `r1_settings.max_concurrent_sessions`, 1..25, default 1. Set it with
  `PUT /api/admin/r1/settings` and `{"max_concurrent_sessions": N}` (admin; the route audits the
  change). `GET /api/admin/r1/settings` also returns `browser_worker_pool_size`. The settings API
  refuses a limit above 1 (409 `r1_concurrency_needs_machine_names`) until the API env flag
  `BROWSER_REQUIRE_MACHINE_AGENT_NAME` is on; lowering it to 1 is always accepted.
- **The pool.** One machine runs one session. The pool size is the number of
  `voice_worker_leases` rows for app `project-hello-voice`, pipeline `browser`, in any state, so
  admission never lets in more sessions than there are machines. With no registered pool the
  limit is 1.
- **Cloud = 1.** On the Cloud fallback only one R1 session is admitted.
- Above a limit of 1, a second admission for a round that already has a live session answers
  `round_live`, and `r1_in_flight` means "the limit is reached".

Live R1 sessions right now:

```sql
select count(*) as live_r1
from screening_v2.call_sessions
where interview_round_id is not null and status in ('created', 'waiting', 'in_progress');
```

### Rollout order (each step has a gate; stop at the first that fails)

1. **Deploy inert.** Migration 0131, the API and the worker ship with the defaults. Nothing
   changes: limit 1, shared agent name, one scoring job at a time. Confirm
   `max_concurrent_sessions = 1` and run one normal interview.
2. **Per-machine agent names, in a zero-live window.** Pause R1 and wait for `live_r1 = 0`
   (a worker deploy restarts started machines and would cut a live interview).
   - Worker first: set `BROWSER_PER_MACHINE_AGENT_NAME = "true"` in `app/voice-livekit/fly.toml`
     `[env]` (the only config allowed to carry it) and deploy `project-hello-voice`. It takes
     effect only together with `R1_READINESS_HOST=on`, that is on the R1 target.
   - Gate: every browser lease that has reported carries its own name,
     `registered_agent_name = 'browser-screener-<machine_id>'`
     (`select machine_id, state, registered_agent_name from screening_v2.voice_worker_leases
     where app = 'project-hello-voice' and pipeline = 'browser'`), and one smoke interview is
     dispatched to its own machine.
   - Then the API: `fly secrets set BROWSER_REQUIRE_MACHINE_AGENT_NAME=true -a project-hello-api`
     (it restarts the API). From now on a lease that reported no per-machine name is released
     (the exchange answers `preparing`) and the shared name is never dispatched.
   - **Never with `livekit_target = cloud`.** Per-machine names are for the R1 SFU only: the
     Cloud path dispatches the shared name. Turn both flags OFF (the API first, then the worker,
     in a zero-live window) BEFORE switching to the Cloud fallback (see "Rollback, R1 to Cloud").
3. **Provision the pool, N + 3 machines.** The 3 spares cover machines still stopping (up to
   `kill_timeout` 300 s) and Fly start failures. Dry run first, then for real, from a shell that
   has `FLY_API_TOKEN`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in its environment:

   ```
   node scripts/provision-voice-worker-pool.mjs --app project-hello-voice --pipeline browser --size <N+3> --dry-run
   node scripts/provision-voice-worker-pool.mjs --app project-hello-voice --pipeline browser --size <N+3>
   ```

   Never `fly scale count`: machines without a lease row are never reaped and would take
   shared-name dispatches. Shrink only with `--retire <machineId>` (it removes the lease row of a
   stopped machine; see the script header), never with a hand-run `fly machine destroy`.
4. **Resize and deploy the SFU, in a zero-live window.** `infra/livekit-r1/fly.toml` is now
   performance-4x / 8 GB with signaling limits of soft 300 / hard 600 connections (pinned by
   `scripts/validate-livekit-r1-sfu.mjs`). The SFU is one Machine and deploys manually
   (`fly deploy infra/livekit-r1 --ha=false --remote-only -a project-hello-r1-rtc-spike`); a
   deploy ends every live room. Pause R1, wait for `live_r1 = 0`, deploy, then run the health,
   UDP-pair, worker-registration and browser smoke checks ("SFU operations and fallback").
   Signaling at N = 25 is an estimated 100-110 connections (about 3 per room plus one
   registration per pool machine). The ICE/TCP 7881 service has no explicit concurrency block,
   so include a forced-TCP client in the load test.
5. **Load test at 2, 5, 10 and 25.** At each step raise `max_concurrent_sessions` to that number
   (the pool size caps it anyway), run that many simultaneous staff interviews end to end (join,
   role-play, close, recording, scoring), and hold the step until every gate passes:

   | Gate | Pass |
   |---|---|
   | SFU CPU (Fly metrics; Prometheus on :6789) | p95 below 60% (the S0-C gate) |
   | First audio (`first_audio_p95`, `session_facts.first_audio_p95_ms`) | role-play p95 at or under 3.0 s in every session (Stage A) |
   | `r1_provider_429` (worker logs) | none sustained; a 429 at a step means a provider plan is the limit (Sarvam below) |
   | Recording | every session's recording reaches `ready` |
   | Dispatch | each lease's machine is the one running its job; ending one interview stops only its own machine |
   | API | no proxy queueing or 503 during the joint join (request limit soft 80 / hard 200, `app/api/fly.toml`) |

   Before the 25 step, an SFU-only rehearsal can run synthetic rooms with `lk load-test` (one
   640x360 / 500 kbps publisher with audio and one subscriber per room). Rooms are not
   auto-created on this SFU (`auto_create: false`), so create them first (`lk room create`) and
   use load-test room names, never a candidate's.
6. **Raise `max_concurrent_sessions` stepwise** in production the same way (1, 2, 5, 10, 25), one
   step per passed load test, and set `R1_ASSESSMENT_CONCURRENCY` (below) from N = 5.

### Scoring in parallel: `R1_ASSESSMENT_CONCURRENCY`

By default the API scores `r1.assessment` jobs one at a time, so 25 interviews ending together
queue their scoring for tens of minutes. `R1_ASSESSMENT_CONCURRENCY` (API secret or `[env]`;
default 1, clamped to 1..8; a bad value means 1 and never stops the API booting) runs that many
jobs at once per API process. Parallel jobs never score one interview twice: the 0116 trigger
keys one live job per session (`r1.assessment:<session_id>`), the claim is `SKIP LOCKED`, and a
racing insert for one session adopts the stored row (`uq_assessments_v2_session_revision`). Each
job holds at most 2 DeepSeek calls in flight, so 8 jobs are 16 calls against the account's
`deepseek-v4-pro` limit of 500. The R1 breaker is shared, so an outage defers every slot. The
recording finalize runner still runs one job at a time.

### External limits (check before each step up)

- **Sarvam (shared with phone).** The Starter plan allows about 20 concurrent STT streams and
  30 TTS requests a minute (bulbul:v3) for R1 and phone together. **Upgrade before going above
  about 15 concurrent R1 interviews**: Pro (₹10,000; 100 STT, 200 TTS a minute) or Business
  (₹50,000; 1,000 TTS a minute, needed if 25 cold machines fill their line caches at once, about
  125 TTS requests a minute).
- **Fly.** (N + 3) x performance-4x is (N + 3) x 4 dedicated vCPU in `sin` (112 at N = 25), plus
  4 for the SFU and about 12 for the phone pool (about 128 in all). Confirm the org's performance-vCPU quota and machine limit
  (about 50 machines; raised by emailing billing@fly.io) before provisioning.
- **Budget.** Each admission charges 65 minutes. Set `monthly_cap_minutes` to the intended
  sessions x 65, or admission answers `capacity_exhausted` (see "Capacity settings").

### Same-office testing: the per-IP rate limit

Every `/api/r1/*` request shares a per-IP bucket of 60 requests a minute
(`lib/r1/rate-limit.ts`), on top of the global 300 a minute per IP. Testers behind one office
NAT share both buckets, and a joining candidate polls `preparing` every 3 s while a machine
boots, so a same-office rehearsal of more than a few interviews gets `429`s that are the rate
limit, not a capacity failure. Spread testers over separate networks (mobile hotspots) or
stagger the joins. Real candidates join from their own networks.

### Cost per interview (estimate)

- Worker: about 35 minutes of performance-4x in `sin` (about $0.23 an hour), so about $0.13 per
  interview; 25 at once is about $5.75 an hour.
- SFU at performance-4x: about $165-170 a month while it runs (it auto-stops when idle).
- Stopped pool: disk only, $0.15 per GB per month (about $12.60 a month for 28 machines at 3 GB).
- Bandwidth: cents per interview (Asia-Pacific egress $0.04 per GB). DeepSeek scoring and Sarvam
  usage per interview are as today; the Sarvam plan upgrade is the step change.

### Rollback

1. **Set `max_concurrent_sessions` to 1** (`PUT /api/admin/r1/settings`). It applies at once to
   new admissions; sessions already live finish normally. In an incident, also pause R1.
2. Unset `R1_ASSESSMENT_CONCURRENCY` (or set it to 1). Running jobs finish; the queue then drains
   one at a time.
3. Flags off in a zero-live window, the reverse of the rollout: the API first
   (`BROWSER_REQUIRE_MACHINE_AGENT_NAME=false`), then remove `BROWSER_PER_MACHINE_AGENT_NAME` from
   `app/voice-livekit/fly.toml` and deploy the worker. Both must be off before any switch to
   `livekit_target = cloud`.
4. The pool and the SFU size can stay (the limit caps admission). Shrink the pool with `--retire`
   and revert the SFU size (with its validator pin) only in a zero-live window.
