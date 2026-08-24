# Phone lane — Canary-0 and the halt drill

**Scope.** How to rehearse the phone screening lane without calling anybody, and
how to stop it when it is calling somebody. Read
[`ADR-0013`](../adr/0013-phone-screening-runtime.md) first for *why*; this file
is *how*.

**Companions.** [`phone-runtime.md`](phone-runtime.md) (the seven loops, the
health surface, the knobs), [`phone-safe-dialer.md`](phone-safe-dialer.md) (the
disclosure gate and the purge path),
[`phone-assessment-resume.md`](phone-assessment-resume.md) (persistence and
resume), [`phone-webhook-ingress.md`](phone-webhook-ingress.md) (the ingress).

> **The lane is off.** `PHONE_SCREENING_ENABLED`, `PHONE_RUNTIME_ENABLED` and
> `PHONE_DIAL_MODE` all ship at their refusing defaults, and nothing in this
> runbook turns them on. Turning them on for a real candidate needs TEL-01
> through TEL-07 sign-off — see §7.

---

## 1. What Canary-0 is

A deterministic rehearsal of **every outcome the phone state machine can
produce**, run against a real local Postgres carrying `0001..0045`, driven
entirely by synthetic ingress events.

It is not a mock of the substrate. It calls the real
`admit_phone_attempt`, `apply_phone_event`, `start_phone_assessment`,
`commit_phone_question_boundary`, `attach_phone_attempt_recording`,
`heartbeat_phone_attempt_by_epoch`, `reclaim_phone_attempt_leases`,
`schedule_phone_appointment`, `expire_phone_appointments`, `set_phone_halt` and
`clear_phone_halt`, and asserts what the database actually did.

What is synthetic is the **wire**: the run reaches no carrier, binds no trunk,
reads no number and loads no telephony SDK. That is a statement about this
harness, not about what exists at the provider — see §7 TEL-02.

## 2. Running it

```bash
# Bring up a local Postgres with every migration applied.
bash scripts/supabase-local.sh start

# Run the canary. Prints the manifest to stdout when --out is omitted.
node scripts/phone-canary/canary0.mjs --out /tmp/canary0.json

# Against a differently-named container:
node scripts/phone-canary/canary0.mjs --container my_pg --out /tmp/canary0.json
#   …or PHONE_CANARY_CONTAINER=my_pg

# Skip the two-session lock race (it needs two concurrent psql sessions):
node scripts/phone-canary/canary0.mjs --no-race
```

Exit `0` **only** when every scenario passed, the manifest validated, the
measured network-call count was zero, and the trap positive control fired.
Anything else exits non-zero and names the reason on stderr.

**It refuses to run without Docker and a running container.** That is
deliberate: "no database" and "everything passed" must never look the same.

**One disclosure caveat.** The *manifest* is sanitized by grammar and carries
nothing identifying. The *failure path* is different: when the SQL suite aborts,
the runner writes psql's stderr through so the failure is debuggable, and a
PL/pgSQL `raise` can carry a row id. That output goes to stderr, never to the
manifest — but treat a failed CI log for this step as you would any other
database error log, rather than as publishable evidence.

**It clears the local control row before it starts.** The halt scenario asserts
`already_halted: false` on its first `set_phone_halt`, so a previous run that
died part-way through the race would otherwise redden it for an unrelated
reason. This is an explicit setup step on a local test database with no dialer
attached, taken *before* the run — it is not, and must not become, the
`finally`-clear that §5 rule 2 forbids in production.

The offline half needs nothing at all:

```bash
node scripts/phone-canary/canary0.test.mjs
```

### File layout

| file | role |
|---|---|
| `fixtures.sql` | the `_phone_canary` schema, the report tables, and the fixture/teardown helpers. Idempotent; drops nothing. |
| `canary0.sql` | the nine SQL scenarios. Creates and drops nothing; truncates the report tables at the start. |
| `teardown.sql` | drops the schema and the canary role. Run last. |
| `canary0.mjs` | the runner: applies the three SQL files in order, drives the tenth (race) scenario, arms the network traps, builds and validates the manifest. |
| `manifest.mjs` | the sanitized manifest — builder, schema validator, tamper detector. |
| `netguard.mjs` | the zero-PSTN traps and their positive control. |
| `db.mjs` | the only module that talks to a database; local-only by construction. |
| `exec.mjs` | the single `node:child_process` boundary for the directory. |
| `halt-drill.mjs` | the emergency-stop drill (§5). |
| `PROTOCOL.md` | the verdict grammar `canary0.sql` and `manifest.mjs` share. |

## 3. The ten scenarios

| scenario | what it proves |
|---|---|
| `human_screening_end_to_end` | the consenting path: dial → join → classify human → **disclosure** → recording bound → assessment started → every question boundary committed → scored → engagement `completed`. Includes the two ordering negatives (recording and assessment both refused *before* disclosure), a boundary re-commit proving idempotency, and a control proving `assessment.completed` is refused `assessment_missing` — writing **no** ledger row — when no score exists. |
| `voicemail_no_recording_no_score` | a voicemail charges one no-answer attempt, ends the attempt, and produces **no** recording, **no** plan, **no** progress and **no** assessment. |
| `refusal_purge_and_suppression` | `disclosure.refused` terminates as `opted_out`, writes a digest-keyed suppression in the same transaction, the purge RPCs are idempotent, and a **second application by the same candidate is refused `suppressed`**. |
| `disconnect_then_reconnect_same_session` | a mid-call drop grants exactly one reconnect; 120 s later the reconnect is admitted, lands back in `in_call`, resumes the **same session at the same cursor**, and `reconnects_used` is **not** refilled. |
| `three_no_answer_ist_days_then_terminal` | three no-answers across three distinct IST days (rolled by the production sweep) exhaust the budget into `abandoned_no_answer`; a fourth admission is refused `engagement_terminal`; and a second cold call on one IST day is refused. |
| `appointment_lifecycle` | book, supersede under `p_expected_version` (`version_conflict`), fulfil at the dial, expire into `missed` and back to `eligible`; plus the shape refusals. |
| `halt_admission_fail_closed` | halt refuses admission; a second halt preserves the **original** reason; clearing restores service; and a **missing control singleton** reads as halted everywhere — admission, `phone_backlog`, and `clear_phone_halt`, which refuses to invent a cleared row. |
| `attempt_lease_heartbeat_and_reclaim` | the heartbeat extends the lease **beyond** its original end; a stale dispatch epoch is still accepted (the `>=` fence) and a future one is not; an un-renewed lease is reclaimed to `abandoned` **charging no budget**; a post-reclaim heartbeat answers `lease_lost`. |
| `cross_engagement_candidate_guard` | one candidate with two engagements: guard A refuses a second call while one is in flight, guard B refuses a second cold call the same IST day, and the next IST day is admitted — a pace, not a latch. |
| `halt_race` (runner-driven) | a halt raised **while an admission is already blocked on the admission lock** still refuses that admission, and no attempt row is written. |

The race is the one scenario SQL cannot express. Its determinism comes from
`pg_stat_activity`, never from sleeping: the halt is raised only once the
admitting session is *observed* waiting on a Lock. If the RPC ever stopped
taking that lock, the wait would time out and the scenario would fail — which
is the point.

## 4. The manifest

```jsonc
{
  "schema": "phone-canary-0/v1",
  "generated_at_utc": "2026-08-24T07:06:13Z",
  "git_sha": "…", "git_dirty": true,
  "suite_sha256": "…", "runner_sha256": "…",
  "zero_pstn": { "sdk_importable": false, "network_calls": 0,
                 "trap_positive_control": "fired" },
  "scenarios": [ { "name": "…", "status": "pass",
                   "checks_passed": 26, "checks_failed": 0,
                   "checks": [ { "name": "…", "status": "pass", "code": "ok" } ],
                   "counts": { "questions_committed": 4 } } ],
  "totals": { … },
  "digest": "…"
}
```

**It is sanitized by grammar, not by redaction.** Every string in it is either a
member of a closed set or matches `^[a-z][a-z0-9_]*$`. A uuid, an E.164 number,
a room name, an object key, an email or a transcript fragment cannot be
*expressed*, so there is nothing to strip. A second, independent leak scan runs
over the finished document anyway, and every one of its patterns has a positive
control in the offline suite.

**`digest` detects editing, not forgery.** Anybody holding the file can
recompute it; what it catches is a manifest that travelled through a hand or a
diff and came out different. A tamper that re-seals the digest is caught
separately, by the internal-consistency checks (`checks_passed` must equal the
passing checks, `scenarios_declared` must equal what the SQL itself announced).

**`git_dirty` is recorded, never enforced.** A manifest produced from a dirty
tree is a real fact about that run.

Validate one you were handed:

```bash
node -e "import('./scripts/phone-canary/manifest.mjs').then(async m=>{
  const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  console.log(m.validateManifest(d));})" /tmp/canary0.json
```

## 5. The halt drill

`scripts/phone-canary/halt-drill.mjs`. Four rules, all enforced by code and
asserted by the offline suite:

1. **Defaults do nothing.** `--target` defaults to `local`; nothing mutates
   without `--execute`.
2. **Halt and clear are two invocations, never one.** There is no `--and-clear`,
   no rollback, and **no `finally` block in the file at all**. Lifting a kill
   switch because a process was ending is a fail-open on the one control that
   stops calls to real people.
3. **Credentials arrive on stdin or in `PHONE_HALT_ADMIN_TOKEN`, never in
   argv.** `--token` is explicitly *refused*, with the reason, rather than
   merely unrecognised.
4. **Nothing identifying is printed.** Every line is a boolean, a bounded count
   or a stable code; anything else prints as `unprintable`.

```bash
# Read the control state. Read-only; refuses --execute.
node scripts/phone-canary/halt-drill.mjs probe

# Dry run, then act. The precondition is mandatory, never defaulted.
node scripts/phone-canary/halt-drill.mjs halt --reason operator_pause --expect-halted false
node scripts/phone-canary/halt-drill.mjs halt --reason operator_pause --expect-halted false --execute

# Clearing NAMES the halt currently in force. Read it with `probe` first.
node scripts/phone-canary/halt-drill.mjs clear --expect-reason operator_pause --execute
```

Reasons: `operator_pause`, `provider_incident`, `cost_control`, `legal_hold`,
`emergency_stop` — the five `0042` allows, drift-checked against the migration.

### Production mode

```bash
printf '%s' "$ADMIN_TOKEN" | node scripts/phone-canary/halt-drill.mjs halt \
  --target production --reason emergency_stop --expect-halted false \
  --api-base https://api.example --execute --confirm "STOP THE PHONE DIALER"
```

Production requires **all four**: `--execute`, the exact confirmation phrase, an
`https` API base, and a token from stdin or the environment. It drives
`POST /api/phone/halt` and `/halt/clear`, which are admin-gated and write their
own `audit_events` rows.

**"Expected version", honestly.** `phone_control` has no version column — 0042
protects it with a row lock. So the precondition is the `(halted, reason)` pair
read immediately before acting, and for `clear` the server enforces the same
thing (`halt_reason_mismatch`). It is a check against carelessness and it is
time-of-check-to-time-of-use; the exposure is bounded in the safe direction.

**This mode has never been executed against production and must not be until
TEL-07's dual-control approval exists.**

### What a halt actually stops

* `admit_phone_attempt` refuses `halted` — no new dial, no new attempt row, no
  new session.
* `runPhoneDuePass` returns `status: 'halted'` **before reading the due list**,
  so a halted lane does not even look at candidate rows.
* The queue runner's `shouldClaim` stops claiming `phone.dial` jobs (5 s cache).
* **Calls already in progress are not terminated.** The other six loops keep
  running deliberately — they are what end in-flight work and free fleet slots.
  To end a live call you must terminate the room; see `phone-runtime.md` §11.

An unreadable control singleton is treated as halted everywhere. That is the
inverse of the recording lane, which fails open; the difference is what is on
the other side of the gate.

## 6. Health verdicts

Pinned by `app/api/src/__tests__/phone-canary-verdicts.test.ts`:

| state | `status` | `reasons` |
|---|---|---|
| screening flag off | `disabled` | exactly `['phone_screening_disabled']`, every count block `null` |
| runtime not registered, no failure | — | **exactly `[]`**. Off is not a fault. |
| construction or arming threw | — | exactly `['phone_runtime_start_failed']`, **and nothing else** |
| kill switch raised | `degraded` | `admission_halted` (+ `phone_due_halted` once a pass has seen it) |
| control singleton missing | `degraded` | `halt_unreadable` |
| a sweep answered non-`ok` | `degraded` | `phone_sweep_not_ok`, with the sweep named in `sweeps_not_ok` |
| backlog read failed | `degraded` | exactly `['backlog_unavailable']`, every count block `null` |

**There is no zero for unknown.** A count that could not be read is `null`, not
`0`. `last_reclaimed: 0` means "swept, found nothing"; `null` with `reclaim` in
`sweeps_not_ok` means "the sweep did not happen"; `null` with an empty
`sweeps_not_ok` means "no sweep has run in this process yet". These are three
different operational situations and the surface keeps them apart.

## 7. Canary-1 — documented, not implemented

Canary-1 is the owner dialling **their own number** over a real trunk. It is
**not implemented and has not been run.**

**Why not implemented.** There is no safe ephemeral no-persistence path through
this lane, by design. A screening that reaches `disclosure.delivered` writes an
append-only ledger row, an attempt, a session, a plan snapshot, boundary rows,
transcript turns and — on completion — an `assessments` row and a terminal
engagement. That durability *is* the feature. A "canary mode" that skipped it
would rehearse a different system from the one that runs, and building one would
mean weakening the runtime to make a test convenient. We do not weaken the
runtime for the canary.

**The gates in front of it**, all of which are PLAN P0 and none of which is
engineering:

1. **TEL-01** — written Indian telecom counsel and carrier guidance mapping
   every DLT/UCC, consent, DND, caller-ID, recording and evidence obligation to
   a control, plus the registrations themselves.
2. **TEL-02** — a verified India-capable provider account, an approved route
   and an actual number. **Status: provisioned at the provider, not bound to
   the application, and not authorised for use.** Plivo India KYC, an Indian
   number, a Plivo SIP trunk and a LiveKit outbound SIP trunk were configured
   after this list was first written; **no real call has been placed.**
   Provisioning a route is not authorisation to use it — TEL-01, TEL-04,
   TEL-05, TEL-06 and TEL-07 gate that independently, and they are open. The
   application binding is deliberately deferred too: `PHONE_SIP_TRUNK_ID` is
   unset on every app, `PHONE_AGENT_NAME` is unset on the API, and binding the
   trunk is the LAST wire to connect (`phone-runtime.md` §11 steps 8–9), not
   the first. *(This entry previously read "we do not have a number to dial
   from". That was stale, and stale in the dangerous direction: it pointed at
   carrier capability as the blocker when the real blockers are the approvals
   below and the wiring above.)*
3. **TEL-03** — authenticated SIP, IP controls, credential rotation, spend caps.
4. **TEL-04** — Legal-approved disclosure and decline wording.
5. **TEL-05** — consent-source, DND and opt-out enforcement before every dial.
6. **TEL-06** — approval of the calling window. **The shipped 09:00–21:00 IST
   window diverges from TEL-06's stated 10:00–19:00 default, and there is no
   holiday calendar.** See ADR-0013 §1.
7. **TEL-07** — the dual-controlled emergency stop, drilled. §5 is the drill;
   the dual control is not yet in place.

**When it does run**, it runs on real rows: dial the owner's own number, take
the screening to a terminal state, then purge with the documented four-step
order in `phone-safe-dialer.md` — list artifacts, delete objects and manifests,
`clear_phone_attempt_recordings`, and only then post the terminal event.

## 8. Residuals

Carried forward, and stated because a gap list with wrong entries is worse than
no gap list.

* **The 09–21 IST window is an engineering default, not an approved one**, and
  diverges from PLAN TEL-06. No weekend skip, no holiday calendar. (ADR-0013 §1)
* **`slot_straddles_ist_midnight` is unreachable** while the window closes at
  21:00 and a slot is capped at 3600 s: the latest bookable end is 22:00 IST, so
  a straddling slot is refused `window_closed` first. The canary asserts the
  refusal that *actually* fires and names it accordingly. If the window is ever
  widened past 23:00 this becomes live and must be re-checked. It is another
  instance of the "a guard that cannot fire" class this lane keeps finding.
* **A hand-posted `day.rolled` wedges the ladder after one roll.** The
  `internal` source mints `internal:<engagement>:day.rolled:-1`, identical every
  day, so day two's post is answered as a replay of day one's verdict. Only
  `sweep_phone_day_rolled`, which scopes its dedup id by IST date, may drive
  transition #27. The canary drives the rolls through the production sweep for
  exactly this reason. **Do not post `day.rolled` by hand.**
* **`daily_attempt_exists` is normally shadowed by `not_yet_eligible`**, because
  every path returning an engagement to `eligible` with today's attempt on the
  books also pushes `next_eligible_at` to the next IST day. Both guards are
  real and the canary asserts them separately.
* **`appointment_exists` shadows every slot-shape refusal**, so shape probes
  need their own engagement.
* **The halt drill's "expected version" is not a lock** — see §5.
* **Production halt mode is untested against production**, by constraint.
* **No leader election.** `claim_phone_sweep` is a claim and can lapse while its
  holder works; every sweep behind it is idempotent, which is what makes that
  acceptable. `phone-reconcile` still multiplies provider traffic per replica.
* **`reconcile()` still has no production caller** for `stuck_sessions`; whoever
  schedules it must verify the phone-aware predicate covers what they enable.
* **An unanswered `reconnect` charges the no-answer budget**, diverging from the
  P5 acceptance wording. Substrate-level; see `phone-runtime.md` §7.
* **The provider side is provisioned; the application side is deliberately
  not wired.** Plivo India KYC, an Indian number, a Plivo SIP trunk and a
  LiveKit outbound SIP trunk exist; `PHONE_SIP_TRUNK_ID` is bound nowhere, the
  API's `PHONE_AGENT_NAME` is empty, and no real call has been placed. Read
  every "no trunk / no number" sentence in this lane's docs at *harness* scope
  only. A configured trunk authorises nothing.
* **Canary-0 needs Docker.** There is no in-memory fallback and there must not
  be: a fallback would make "the substrate is fine" and "we could not check"
  look the same.
