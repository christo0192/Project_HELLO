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

Self-hosted operation is allowed only after S0-F passes. The R1 SFU is one
Fly `sin` Machine, dedicated IPv4, LiveKit v1.13.7 digest, WSS 443, ICE/TCP
7881, and UDP 7882. It has no Redis, Egress, SIP, Ingress, webhook, or
embedded TURN. (implemented in PR-SFU-1)

Keep JSON/info logs and private metrics; do not enable debug logging containing
candidate network data. Deploys, upgrades, cert changes, and secret changes
are manual, require zero live R1 rooms, and are followed by health, UDP-pair,
worker-registration, and browser smoke checks. (implemented in PR-SFU-2)

Fallback flip procedure:

1. Pause R1 and drain all `waiting` and `in_progress` R1 sessions.
2. Confirm zero R1 rooms and worker jobs; do not make an API-only flip.
3. Put the worker `LIVEKIT_*` triple on the selected endpoint, deploy and
   verify worker registration there.
4. Set `BROWSER_LIVEKIT_TARGET` to the same target, deploy the API, and verify
   returned endpoint, candidate token, room creation, dispatch, and reaper.
5. Apply the Cloud cap before admitting new sessions when the target is Cloud.

(implemented in PR-LK-seam and PR-LK-liveness)

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
