# ADR-0013: Phone screening runtime

**Status:** Proposed

**Decision owner:** Owner (product) with Legal for TEL-01/04/05/06

**Plan references:** TEL-01 / TEL-03 / TEL-04 / TEL-05 / TEL-06 / TEL-07 / D-002

## Context

The browser screening lane is live. The phone lane exists to reach candidates
who never open the browser link at all, by placing an outbound call, disclosing
that they are speaking to an AI, conducting the same structured screening, and
scoring it into the same `assessments` table.

Everything about that sentence is riskier than the browser lane, and the
difference is not technical. A browser session begins because a person clicked;
a phone session begins because *we* dialled. Every failure mode therefore lands
on somebody who did not ask for it, is metered, and in India is regulated. The
substrate is built around that asymmetry, and this record exists so the next
person does not have to re-derive it from five migrations and seven runbooks.

Six pull requests built it, each shipped **disabled**:

| phase | what it added |
|---|---|
| **P1** (`0042`) | the substrate: `phone_engagements` / `phone_call_attempts` / `phone_call_events` / `phone_appointments` / `phone_control` / `phone_suppressions`, the 13-state engagement machine, the three budgets, the IST window, the kill switch |
| **P2** | the API-side domain core (`lib/phone-screening`): vocabulary, admission, budgets, IST window, slots, ports — forbidden a timer, a queue and a logger, enforced structurally |
| **P3** | the webhook/callback ingress and the two reconciliation sweepers |
| **P4a** (`0043`) | the disabled safe dialer, the recording disclosure gate, and the purge path |
| **P4b** (`0044`) | assessment persistence, resume-by-key, and scoring before the completion claim |
| **P5** (`0045`) | the runtime: seven loops, the attempt-lease heartbeat, the sweep claim, the health surface |

The question this record answers is not "how does it work" — the runbooks
answer that. It is **what was decided, and what must be true before anybody
turns it on.**

### Options considered for the go-live rehearsal

1. **Turn it on for one real candidate and watch.** Rejected. Every defect this
   lane found in review was in the *wiring* between migration, API and worker —
   three separate reviews, three separate times. Finding those with a real
   person on the line is not a rehearsal, it is an incident.
2. **Unit tests only.** Rejected as insufficient. The P5 review recorded the
   reason in the migration itself: a stranded-session resolution was dead code
   that still reported a healthy sweep, and *nothing in the SQL read wrong* —
   only a real-Postgres test caught it. Text-extraction tests structurally
   cannot see that class.
3. **A synthetic canary against real Postgres, with no carrier.** Selected.
4. **An owner-only real call (Canary-1).** Deferred behind the gates in
   "Canary-1", below — not because it is unimportant but because it cannot
   legally happen yet.

## Decision

### 1. The calling window is 09:00–21:00 IST, seven days a week

`phone_ist_window_open_at()` = `09:00:00`, `phone_ist_window_close_at()` =
`21:00:00`, opening inclusive and closing exclusive, evaluated in
`Asia/Kolkata` and enforced in SQL — in `admit_phone_attempt` before any dial
and in `enforce_phone_appointment_window` before any booking, so a slot outside
it is unrepresentable rather than merely unbooked.

**This diverges from PLAN TEL-06, which names 10:00–19:00 IST as "the existing
project constraint".** The divergence is deliberate and is recorded here rather
than quietly absorbed: the wider window was chosen to make retries across three
distinct IST days practical, and TEL-06 requires Legal/Product to approve
permitted days, holidays and any narrower window regardless. **The 09–21 window
is therefore an engineering default awaiting that approval, not an approved
one.** Narrowing it is a two-line change to two `IMMUTABLE` helpers; widening it
is a decision nobody should make without TEL-01 counsel.

There is **no weekend skip and no holiday calendar.** `phone_next_window_open`
returns tomorrow's opening with no notion of a Sunday or a public holiday.
Whoever obtains the TEL-06 approval must either confirm seven-day calling is
acceptable or fund a holiday calendar; a runtime that calls on Diwali because
nobody wrote the calendar is our defect, not the substrate's.

### 2. The number comes from the resume, and from nowhere else

A dialable number must pass **both** a format gate and a **provenance** gate.
`candidates.phone_e164` is only dialable when `phone_valid` is true, and
`phone_valid` is written by the resume-ingestion lane from a number found in
the candidate's own resume. A number typed by a recruiter, inferred from a
model, or carried on a provider payload is not a dial authority.

`lib/phone-runtime/read.ts` is the **only** reader of `phone_e164` in the
codebase, structurally asserted, and it never binds the raw string to a local:
the value is wrapped by `wrapDialableNumber` in the same expression that reads
it, so there is nothing for a later edit to log. An unwrappable number is
dropped and never named.

Consent is a second, independent authority: `admit_phone_attempt` requires the
candidate's latest `consent_records` row to be `granted`, unexpired, and a
superset of the active template's `required_consents`, and it **pins**
`phone_engagements.consent_record_id` at admission so the authority for a
specific dial is auditable rather than re-derived later.

### 3. The screening is gated on a spoken disclosure, in SQL

Written consent authorises the *dial*. It does not authorise *recording*, and
it does not authorise *conducting the screening*. Both of those are gated on
the candidate having heard the AI disclosure and not refused it, and the gate
lives in the database:

* `in_call` is reachable through exactly one edge — `dialing --disclosure.delivered--> in_call`.
* `attach_phone_attempt_recording` refuses `disclosure_not_delivered` unless
  the engagement is `in_call`, and it **binds the object key before the egress
  starts**. Binding first and learning the egress id second is the whole point:
  the alternative records first and asks afterwards.
* `start_phone_assessment` carries the identical gate.

A worker-side ordering rule survives exactly until somebody reorders two
`await`s. This one is a state machine.

### 4. Three independent budgets, and the anti-harassment invariant is an index

* **No-answer:** at most 3 attempts, and at most **one cold call per IST day**
  per engagement — enforced by `uq_phone_attempts_one_per_ist_day`, so a second
  same-day attempt is unrepresentable rather than merely refused. `0045` adds
  the per-*candidate* equivalents (`candidate_call_in_flight`,
  `candidate_daily_attempt_exists`), because every 0042 index is keyed by
  engagement and a person is not.
* **Reconnect:** at most 3, charged **at the grant**, and reset only when a
  genuinely new conversation begins — never on a reconnect's own disclosure,
  or the bound could never exceed 1.
* **Provider failure:** at most 5, and deliberately paced by the same per-day
  index, so exhausting it takes up to five IST days. A transport rejection does
  not tell us whether the line rang; the uncertainty is resolved in the
  candidate's favour at the cost of throughput.

An opt-out or wrong-number outcome writes a `phone_suppressions` row **in the
same transaction as the terminal transition**, keyed on the SHA-256 digest of
the line. Keying on the line rather than the candidate is what makes the
obligation follow a person across two job applications.

### 5. The lane ships disabled, behind three switches

`PHONE_SCREENING_ENABLED` and `PHONE_RUNTIME_ENABLED` both default `false`, and
`createPhoneRuntime` returns `null` unless both are true — no queue, no runner,
no scheduler, no timer armed at import. `PHONE_DIAL_MODE` defaults to `off` and
gates the due pass independently, because `off` alone still wrote an attempt
row, took a fleet slot and charged the candidate's day index. `synthetic` is
deliberately **not** gated: rehearsing admission is what that mode is for.

The kill switch (`phone_control`) **fails closed** in the direction opposite to
the recording lane's: an explicit halt, an absent singleton, and a *thrown*
control read all stop admission, and a process that has never successfully read
the control row claims no work at all. The recording lane fails open and
documents why; the difference is that the thing on the other side of this gate
is a telephone call to a person.

### 6. Canary-0 is synthetic, executable, and cannot place a call

`scripts/phone-canary/` rehearses ten scenarios against a **real local
Postgres** carrying `0001..0045` — the consenting screening end to end,
voicemail, refusal with purge and cross-application suppression, disconnect and
reconnect onto the same session and cursor, three no-answer IST days into a
terminal engagement, the appointment lifecycle, the halt fail-closed path, the
attempt-lease heartbeat and reclaim, the per-candidate guards, and a genuine
two-session **halt race** in which the stop lands while an admission is already
blocked on the admission lock.

Every ingress event is synthesised. The run reaches no carrier, binds no trunk,
reads no number and loads no SDK: the telephony SDK is not resolvable from that
directory, no file there imports a network module, and every egress primitive
Node offers is trapped and counted during the run. That is a property of the
harness, not a claim about provider provisioning — see §7. **The zero is a measured zero** — the traps
are deliberately tripped afterwards and the manifest refuses to validate unless
they all fired, because a counter that reads zero and a counter that is broken
are the same observation.

The run emits a **sanitized manifest**: scenario names, pass/fail, bounded
counts, a UTC timestamp, the git SHA, and hashes of the suite and runner. It
carries no free-text field anywhere, so a candidate id, a phone number, an
object key or a transcript fragment is *unrepresentable* rather than stripped.
A digest over the whole document detects editing; internal-consistency checks
detect a re-sealed lie.

### 7. Canary-1 was documented and NOT implemented (superseded by §8)

> **Superseded on 2026-08-24 by §8.** This section records the position as it
> was held, verbatim, because a reversed position that reads as though it was
> never held is how the next reviewer loses the reasoning. Everything below
> about TEL-01..TEL-07 still stands and still blocks the call.

Canary-1 is the owner dialling **their own number** over a real trunk. It is
described in `docs/runbooks/phone-canary-and-halt.md` §7 and it is deliberately
**not implemented here and not executed**, for two reasons.

The first is legal: it is a real outbound automated voice call on an Indian
number, which is exactly what TEL-01 through TEL-06 gate.

TEL-02's provider half is **done** and must not be recorded otherwise: Plivo
India KYC, an Indian number, a Plivo SIP trunk and a LiveKit outbound SIP trunk
were configured after the first draft of this record, and **no real call has
been placed**. That changes nothing about the decision. Provisioning a route is
not authorisation to use it, and the application is deliberately not wired to
it: `PHONE_SIP_TRUNK_ID` is bound in no app environment and the API's
`PHONE_AGENT_NAME` is empty. Trunk binding is **step 3 of
`phone-safe-dialer.md` §9** — deliberately late, and deliberately *not* last:
the `PHONE_DIAL_ALLOWLIST` digest and `PHONE_DIAL_MODE=live` (§9 step 6,
`phone-runtime.md` §11 step 9) follow it and are the first configuration that
can reach a carrier. `isLiveDialPermitted` requires **four** conditions
(`PHONE_SCREENING_ENABLED`, `PHONE_RUNTIME_ENABLED`, `PHONE_DIAL_MODE=live`, a
non-empty `PHONE_DIAL_ALLOWLIST`), so no single one of them is sufficient — and
the trunk is not among them. Trunk readiness is a separate gate,
`isPhoneTransportReady`, which `resolvePhoneSipClient` requires *in addition*.
The trunk alone therefore cannot dial: it satisfies none of the four, and the
two gates must both hold. The blockers are TEL-01, TEL-04, TEL-05,
TEL-06 and TEL-07 — approvals, not carrier capability.

The second is technical, and it is the one an engineer is likelier to get
wrong. There is **no safe ephemeral no-persistence path** through this lane, by
design. A screening that reached `disclosure.delivered` writes a
`phone_call_events` ledger row on an append-only table, an attempt row, a
session, a plan snapshot, question-boundary rows, transcript turns and — if it
completes — an `assessments` row and a terminal engagement. **That durability is
the feature.** A "canary mode" that skipped it would rehearse a different system
from the one that runs, and adding one would mean weakening the runtime to make
a test convenient. **We do not weaken the runtime for the canary.** Canary-1
therefore runs on real rows and is cleaned up afterwards by the documented purge
path, or it does not run.

### 8. Canary-1's MECHANISM is implemented and ships DISARMED — an explicit reversal of §7's second reason

**Dated 2026-08-24. PR105.** §7's first reason — the legal one — is unchanged
and still blocks the call. Its **second** reason is reversed here, deliberately
and on the record.

**1. The position, as it was held.** From `docs/runbooks/phone-canary-and-halt.md`
§7 and from §7 above, verbatim:

> "There is no safe ephemeral no-persistence path through this lane, by design.
> A screening that reaches `disclosure.delivered` writes an append-only ledger
> row, an attempt, a session, a plan snapshot, boundary rows, transcript turns
> and — on completion — an `assessments` row and a terminal engagement. That
> durability *is* the feature. A 'canary mode' that skipped it would rehearse a
> different system from the one that runs, and building one would mean
> weakening the runtime to make a test convenient. **We do not weaken the
> runtime for the canary.**"

**2. What changed, and what did not.** We are still not building an ephemeral
path *through the lane*. A `canaryMode` / `skipPersistence` branch inside the
real runtime and worker path is **still rejected, for its original reason**: a
skip-persistence branch in the real path is one refactor from being reachable
by a real candidate.

What PR105 builds is a **parallel path that never enters the lane**. It performs
no admission, mints no attempt, writes no session row, constructs no event
client and imports no persistence, so there is nothing for it to skip. The
configuration argument is the verifiable half: `isLiveDialPermitted` and
`isPhoneTransportReady` are pure functions over injected data, so the mechanism
assembles its own `PhoneScreeningConfig` in process and **changes no environment
variable anywhere** — not on the API, not on either worker, not in any Fly
secret that a real candidate's dial reads. No runtime gate is weakened because
no runtime gate is touched.

**3. What the old position's second clause still costs.** It warned that a
canary mode "rehearses a different system", and that remains **partly true**.
The repair reduces it rather than dismissing it: `_build_phone_provider_session`
is extracted in `agent.py` as a pure refactor and called by BOTH the production
phone session and the canary, so the Sarvam STT, Sarvam TTS and Gemini
configuration under test are the production ones — a drifted `SARVAM_TTS_VOICE`
or `GEMINI_MODEL` fails the canary. What is **not** shared is the screening
agent: the canary drives a bare `Agent`, so `phone.phone_agent_class`, its
function tools, the human/machine classifier and `run_phone_gate`'s ordering are
unexercised. That is the price, and `docs/runbooks/phone-canary1.md` lists it in
full rather than leaving a green run to be read as coverage.

**4. What ships as a consequence.** Two things, both named rather than absorbed:

* **The inert-dispatch control narrows from absolute to conditional.** Today a
  dispatch without `attempt_id`/`epoch` is refused by the worker before
  `ctx.connect()`, unconditionally. PR105 adds a branch that reaches connect and
  speech WITHOUT an attempt id. It is kept unreachable from a real candidate by
  a three-condition gate — a worker-side Fly secret, the dispatch `mode`, and
  the room `canary` marker — and by the production metadata builders being
  literal closed-key constructors that cannot emit either marker. But "a
  dispatch with no attempt id is always inert" is no longer what ships, and
  pretending otherwise would be the stale-tripwire class this lane keeps
  finding.
* **A disarm lifecycle is therefore mandatory, not optional — and as of
  2026-08-24 it is a *permanent* disarm, not a window.** `CANARY1_ARMED` ships
  `false`, is pinned `false` by a test, and **stays `false` on `main` forever**.
  Arming lives on `canary1/arm`: a reviewed, CI-green branch that is **never
  merged** and is opened as a **DRAFT** pull request titled
  `ACTIVATION ARTIFACT — DO NOT MERGE` with auto-merge off. There is no prepared
  revert, because nothing is merged to revert.

  **Why, stated as the decision it is.** `CANARY1_ARMED` is read by exactly
  **one** program — `app/api/scripts/phone-canary1.ts`, a `tsx` script the owner
  runs by hand from a local checkout. No Fly app runs it, no API route reaches
  it, and no deploy consumes it. So merging `true` to `main` grants **zero**
  operational capability that the owner's checkout does not already grant, while
  paying for that nothing with a standing-armed default branch and a revert
  somebody has to remember. An activation branch buys the same capability with
  none of the standing risk, and it makes the accident single and nameable:
  somebody merges the artifact.

  That accident is what `scripts/check-main-disarmed.mjs` exists for. It runs on
  **pushes to the default branch only**, and it fails `main` if the constant is
  ever anything but the disarmed literal. It has to be a separate gate because
  the structural pin **travels with the branch** — the artifact flips the
  constant and the pin in one commit, so the artifact is green and a merge of the
  artifact is green too. A test the artifact can rewrite is not a gate against
  the artifact. Its wiring is asserted unguarded on every PR by
  `scripts/check-main-disarmed.test.mjs`, so removing or loosening the gate goes
  **red** on that PR.

  **That red does not BLOCK anything, and this record must not imply it does.**
  Queried 2026-08-24, twice and independently:
  `GET /repos/christo0192/Project_HELLO/branches/main/protection` returns
  **HTTP 404 ("Branch not protected")** and `GET …/rulesets` returns **`[]`**.
  **`main` has no branch protection and `quality` is not a required status
  check.** An earlier revision of this bullet said the gate's removal "goes red
  before it can merge"; with nothing required, a red check is a **report, not a
  veto** — the merge button stays live. The gate **detects** an accidental merge
  of the artifact on the next push to `main`; it **cannot prevent** one.

  **The prevention is therefore placed where it does not depend on a repository
  setting: the artifact is a DRAFT pull request**, which GitHub refuses to merge
  outright whatever the branch settings say. That instruction is itself pinned by
  a static assertion in `scripts/check-main-disarmed.test.mjs`, so it cannot
  regress to a non-draft in prose. Neither observation above is a secret; both
  are repository configuration and both carry their date, because a claim about a
  setting rots. **Nothing in this ADR or in PR106 changes any repository
  setting.** See `docs/runbooks/phone-canary1.md` §4b.

  The worker's flag is a Fly **secret**, and
  `scripts/validate-voice-worker-apps.mjs` scans only `[env]` tables — so a
  lingering secret is invisible to CI, which is exactly why the post-run disarm
  is an **ops assertion** (`fly secrets list`, names only) and not a CI one.

**Blast radius.** No migration, no API route, no API environment variable, no
Fly config, no browser-worker change. The browser session in `agent.py`
constructs separately and is untouched.

## Consequences

**Positive.** Every outcome in the state machine has now been executed against
real Postgres, deterministically, with a machine-checkable artifact. The three
review rounds' worth of wiring defects — an epoch fence that hung up on every
consented call, a worker posting to a path the router did not mount, a
resolution that was dead code reporting health — are all now covered by a
scenario that would go red. The halt has a drill that defaults to doing
nothing.

**Negative / operational.**

* Canary-0 needs Docker and a migrated local Postgres. It **refuses to run**
  without them rather than reporting a vacuous pass, so a machine without
  Docker cannot run this gate at all. That is the intended trade.
* The halt drill's production mode exists but has never been executed against
  production, and must not be until TEL-07's dual-control approval is in place.
* `phone_control` has no version column, so the drill's "expected version" is
  the `(halted, reason)` pair read immediately before acting. It is a check
  against carelessness and it is time-of-check-to-time-of-use. The exposure is
  bounded in the safe direction — the worst outcome is a halt carrying a stale
  but real reason, never a dialer that resumes unnoticed.

**Security / privacy.** The manifest is publishable by construction. The health
surface publishes booleans, bounded integers, ISO timestamps and stable codes
and no row identity. Suppression is recorded against a digest and the digest is
the audit row's target id, so no number appears in the audit trail.

**Blast radius.** No migration, and no behavioural change — but **not**
"scripts, tests and docs only", and this record said exactly that in an earlier
draft. It was wrong in the way that matters: an auditor reading it would not
have gone looking for the production-runtime file the change actually touches.
The honest enumeration is:

* **`app/voice-livekit/agent.py` — production worker runtime.**
  `_await_candidate_activity` is extracted out of `_silence_termination_loop`
  and passed back in as a defaulted `wait_for_activity` parameter. It is a
  **behaviour-preserving DI refactor**: the default *is* the `asyncio.wait_for`
  the loop previously called inline, production passes nothing, and the browser
  worker's silence handling is byte-for-byte what it was. The claim is not
  asserted on the strength of the default alone — `test_agent.py` covers the
  production default directly in both directions, and three mutations (breaking
  either window's restart, or inverting the default's answer) each turn the new
  tests red where the old timing-based test could detect none of them.
* **CI and build wiring** — `.github/workflows/quality.yml` (the offline gate),
  `.github/workflows/supabase-ci.yml` (path filters, `.mjs` syntax, trailing
  whitespace), `scripts/supabase-test.sh` (runs Canary-0 against the migrated
  database before the TST-15 double reset), and `app/api/package.json` (three
  convenience scripts). These change what CI *runs*, not what the product does.
* **Everything else** — `scripts/phone-canary/**`, one new API test file, this
  ADR and `docs/runbooks/phone-canary-and-halt.md`.

The offline gate keeps this list honest, in **both** directions:
`scripts/phone-canary/canary0.test.mjs` §12 fails if this record stops naming
`agent.py` or its seam, **and** fails if `agent.py` stops carrying that seam or
stops defaulting to the production wait. A one-sided grep would sail through the
second case, which is the one a later revert actually produces.

## Evidence

* `scripts/phone-canary/canary0.mjs` — 10 scenarios, **133 checks**, all
  passing against a real `0001..0045` database; two consecutive runs byte-identical
  apart from the timestamp and digest; measured network calls **0** with the
  trap positive control confirmed firing.
* `scripts/phone-canary/canary0.test.mjs` — **139 offline assertions** covering the
  manifest schema, tamper detection, every leak pattern's positive control, the
  network traps *including a disarmed-trap control*, the static import scan
  including a seeded positive control, and the halt drill's refusal state
  machine. This count is the gate's own summary line — reproduce with
  `node scripts/phone-canary/canary0.test.mjs`, which prints
  `phone-canary offline gate: 139 passed, 0 failed`. It is a DIFFERENT number
  from the 133 above and always will be: 133 counts the SQL checks the full run
  makes against a live database, 139 counts the offline assertions that need no
  database at all. `scripts/check-phone-canary-evidence.test.mjs` runs the
  offline gate in CI and fails the build in EITHER direction if this record and
  the gate disagree; it also refuses to let the two counts be collapsed back
  into one. It does not re-verify the 133 — that needs a live database this
  gate has no Docker for, and pretending otherwise would be the decorative
  evidence this lane keeps deleting.
* `app/api/src/__tests__/phone-canary1-*.test.ts` — **183 declared test cases**
  across seven files covering Canary-1's structural closure (the explicit file
  list including `app/api/scripts/phone-canary1.ts`, the moved-not-duplicated
  `node:fs` read permission, the no-write sweep, the containment ordering), the
  refusals, the bounds and their inequalities, the originate seam, the
  teardown, a `fast-check` privacy property over the whole valid destination
  space, and the two-sided cross-language pin against `phone_canary.py`.
  The count moved from 169 with PR106's live-call close-out, which adds the
  worker-presence precondition on the originate path, the derived room
  `emptyTimeout` and its ordering inequality, the join-wait inequality, and the
  trunk-id sanitiser — each with the control that goes red without it — and then
  to 183 with PR106's review repair, which adds the two cases proving the join
  observation does not latch a transient empty listing into
  `room_reaped_before_join` and returns at once on a confirmed reap. **The
  number above is whatever the gate below reports; it is not a remembered
  constant and must not be edited to match a memory.**
  `scripts/check-phone-canary-evidence.test.mjs` derives this figure from the
  test sources and fails in EITHER direction if it and this record disagree.
  This number is **not comparable** to the two above and never will be: 133
  counts SQL checks against a live database, 139 counts offline assertions in a
  dependency-free gate, and 181 counts test-case DECLARATIONS in a vitest suite
  — the runtime total is higher because several cases are `it.each(...)` tables.
  The checker counts declarations because it runs before `npm ci` in
  `quality.yml` and cannot execute the suite; `npm test` in `app/api` is what
  proves they pass. Canary-1's zero-network claim is also weaker than
  Canary-0's, and is labelled so in `PROTOCOL.md`: the telephony SDK IS
  resolvable from `app/api/src/__tests__`, so the property rests on dependency
  injection and the runtime traps rather than on unresolvability.
* `app/voice-livekit/tests/test_phone_canary.py` — the worker half: the
  `record=`/`PHONE_NO_RECORDING` identity-of-source pin with its
  drop-the-kwarg and second-literal controls, the three-condition gate, the
  disarmed-worker inert-dispatch proof, the inbound closed-key + digit-run
  guard with a seeded positive control, the per-process one-shot latch, and the
  Dockerfile COPY closure with a negative control.
* `app/api/src/__tests__/phone-canary-verdicts.test.ts` — the health verdict
  assertions (`off` is healthy-disabled; `start_failed` is exclusive; halt,
  unreadable control and sweep errors degrade truthfully; `null` and `0` stay
  distinct) and the three-way fail-closed proof for `runPhoneDuePass`.
* Substrate mutation proofs recorded during authoring: removing the `in_call`
  gate from `attach_phone_attempt_recording` turns two scenarios red; changing
  the heartbeat fence from `epoch >= p_epoch` to `epoch = p_epoch` reproduces
  the P5 round-3 BLOCKER; resetting `reconnects_used` on any disclosure breaks
  the reconnect budget. All three restored byte-identically.
* `docs/runbooks/phone-canary-and-halt.md` — operating procedure, the halt
  drill, and the residual list.
* Prior art and constraints: `docs/runbooks/phone-runtime.md`,
  `phone-safe-dialer.md`, `phone-assessment-resume.md`, `phone-webhook-ingress.md`.

## Supersession

None. This record supplements ADR-0002 (voice and model runtime) and ADR-0006
(recording capture and storage) for the phone lane; it replaces neither.
Turning the lane on for real candidates is **not** authorised by this record —
that requires TEL-01 through TEL-07 sign-off and a superseding decision that
names the approved window and the approved provider.
