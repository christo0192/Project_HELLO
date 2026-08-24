# Phone lane — Canary-1 (the owner's own-number test call)

**Status: MECHANISM ONLY, SHIPPED DISARMED. No call has been placed, and PR105
cannot place one.** `CANARY1_ARMED` is a source constant shipped `false` and
pinned `false` by a test; while it is false the CLI refuses before **every**
provider seam — the dry run included. Arming is PR106, a separate reviewed diff
with its revert commit prepared and linked before the run.

**Scope.** How the owner places ONE call to their OWN handset over a real trunk,
verifying transport, audio, STT, TTS and the LLM, without a candidate row,
without an admission, and without weakening any gate that protects a real
candidate. Read [`ADR-0013 §8`](../adr/0013-phone-screening-runtime.md) first
for *why* — it is an explicit, dated reversal of a position this lane held —
and this file for *how*.

**Companions.** [`phone-canary-and-halt.md`](phone-canary-and-halt.md) (Canary-0
and the halt drill), [`phone-safe-dialer.md`](phone-safe-dialer.md) (the
disclosure gate and the purge path),
[`phone-worker-deployment.md`](phone-worker-deployment.md) (the two Fly apps),
[`phone-runtime.md`](phone-runtime.md) (the loops and the health surface).

> **The lane is off, and stays off.** `PHONE_SCREENING_ENABLED`,
> `PHONE_RUNTIME_ENABLED` and `PHONE_DIAL_MODE` all remain at their refusing
> defaults for the whole of Canary-1, and nothing in this runbook changes them.
> That is not a caveat — it is the mechanism's central property. See §2.

> **The live call is NO-GO.** It is blocked on TEL-01, TEL-04, TEL-06 and TEL-07
> sign-off and a clean dry run. Those are approvals, not code, and nothing in
> PR105 or PR106 moves them. See §9.

---

## 1. What Canary-1 is, in one paragraph

A **separate, interactive, single-shot operator process** — `npm run
canary:phone1` under `app/api` — that holds the destination only in its own
memory, drives LiveKit through the *existing* `livekit-phone-dial` seams, and
dispatches the existing named worker `phone-screener` into a canary room whose
**dispatch metadata carries no attempt id**. A separately-armed branch in the
worker runs a short scripted conversation built from the **same provider-session
factory the production phone path uses**, with recording explicitly off, no API
client and no writes. The production API stays fully disabled throughout.

## 2. The property that makes this safe: no environment variable changes

`isLiveDialPermitted` and `isPhoneTransportReady` are **pure functions over
injected data**. So the CLI assembles its own `PhoneScreeningConfig` in process
— `screeningEnabled: true`, `runtimeEnabled: true`, `dialMode: 'live'`, a
one-entry allowlist — and `resolvePhoneSipClient` hands it a live client, while
the deployed API's flags, the Fly secrets, `PHONE_DIAL_MODE` and the real
allowlist are all exactly what they were.

The documented alternative — `phone-safe-dialer.md` §9 step 6: both flags plus
`PHONE_DIAL_MODE=live` plus a one-entry allowlist — is **three fleet-wide
weakenings for one call**, and it hands the choice of who gets dialled to the
due loop rather than to a human at a terminal. That is the option this
mechanism exists to avoid taking.

**The allowlist check on this path is VACUOUS, and that is recorded rather than
glossed.** The allowlist is built one line before the check, from the same value
the check is about, so `isDialAllowedForDigest` cannot fail here. It is still
called, because the real gate belongs on the real path — but nobody may later
read "the allowlist was checked" as evidence about this run. The control that
actually stands between a typo and a stranger's handset is **double entry at the
TTY** (§4).

**And no digest is published anywhere durable.** `PHONE_DIAL_ALLOWLIST` holds
UNSALTED SHA-256 digests of E.164 values. For an Indian mobile the space is
`+91[6-9]` plus nine digits — about four billion, exhaustible on a laptop in
minutes. A committed digest of the owner's number **is** the number. Not in
`fly secrets`, not in `.env.example`, not in a manifest (there is no manifest —
the mechanism writes no file), not in a handover, not in PR text.

## 3. Where the number can and cannot exist

**It can exist in:** the TTY buffer; this process's V8 heap for the length of
one short run; the TLS body to LiveKit; and — unavoidably and durably — inside
LiveKit, Plivo and the carrier.

**It provably cannot exist in:**

| Location | The control |
|---|---|
| repo / git history | never typed into a file; `--number` refused; no fixture carries one |
| argv / shell history | `--number` / `--to` / `--dest` / `--destination` and any number-shaped token are **refused with a reason**; a non-TTY stdin is refused so it cannot be piped or heredoc'd |
| readline history | `historySize: 0`, `terminal: true`, history emptied and the interface closed after **each** entry |
| environment | no destination variable is read anywhere in the closure, and a destination-shaped variable being *set* is itself a refusal |
| any file | **the mechanism writes no file at all.** There is no `--out`; no `node:fs` write API appears anywhere in the closure |
| database | the closure imports no Supabase client and there is no admission, so 0042 never sees a number |
| room / dispatch metadata | closed-key builders over opaque ids; `hidePhoneNumber: true`; the epoch attribute is the only attribute set |
| our logs | a stable code, a boolean or a bounded integer — see §5, the grammar has no free-text field |
| Node's own error printer | process-level handlers installed **before** the destination is read print a bare code, run teardown and exit non-zero. No `Error:` line and no stack frame ever reaches stderr |
| SDK debug logging | the SIP client is constructed against an environment with `DEBUG`, `LIVEKIT_LOG_LEVEL`, `LOG_LEVEL` and `NODE_DEBUG` removed |
| the worker | it never receives the number in any form, and never enumerates a participant attribute map — `sip.phoneNumber` is auto-populated by LiveKit |

**Honest limits.** JS strings are immutable and cannot be zeroed; the value stays
in the heap until GC and would appear in a core dump. Run in the foreground, no
debugger, no core dumps, and let the process exit. Provider retention is
intrinsic to placing a call — see §10 R-1.

## 4. Running it

```bash
cd app/api
# Default. Does nothing and says so while CANARY1_ARMED is false.
npm run canary:phone1 -- --dry-run
# After PR106 arms the constant, and only then:
npm run canary:phone1 -- --execute --confirm "CALL MY OWN PHONE"
```

**Credentials go in a transient subshell, never a `.env`.** The CLI **refuses
to run** (`credentials_persisted`) if `app/api/.env` exists and carries any
`LIVEKIT_*` key, because a dotfile is exactly the durability the rest of this
design avoids. Source the four values from the secret manager into a subshell,
run, then exit the subshell. `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `PHONE_SIP_TRUNK_ID`.

**The prompt.**

```
Destination (owner's own number, +91XXXXXXXXXX). Input is hidden.
>
Re-enter to confirm.
>
```

Echo is suppressed **entirely**, not masked with bullets — a mask still leaks
the length to anyone watching the screen. The two entries are compared by
**digest**; neither the string nor the digest is printed. A mismatch prints
`destination_mismatch` and exits **with no retry**: a retry loop is a second
chance to typo into a live carrier.

**Flags.** `--dry-run` (default), `--execute`, `--confirm <phrase>`,
`--questions 1..3`, `--max-call-seconds`, `--ring-seconds`,
`--participant-wait-seconds`, `--wall-clock-seconds`, `--agent-name`.
Everything else is refused. **There is no `--out`.**

## 5. Reading the output

Every line obeys `scripts/phone-canary/PROTOCOL.md` verbatim, with `canary1` in
the *scenario* field. The grammar has **no free-text field**, so a uuid, a
phone number, a room name, a provider payload or a transcript fragment cannot
be expressed in it. The sanitizer is a **parser**, not a redactor: there is
nothing to strip because nothing else can be said. That is what makes the
terminal transcript safe to keep, paste into a handover, or read aloud — and it
is the only evidence this mechanism produces.

```
CANARY|canary1|argv_accepted|PASS|ok
CANARY|canary1|environment_accepted|PASS|ok
CANARY|canary1|credentials_transient|PASS|ok
CANARY|canary1|preflight_trunk_configured|PASS|ok
CANARY|canary1|preflight_livekit_credentials|PASS|ok
CANARY|canary1|preflight_timeouts_ordered|PASS|ok
CANARY|canary1|preflight_waits_ordered|PASS|ok
CANARY|canary1|preflight_bounds_ordered|PASS|ok
CANARY|canary1|preflight_questions_in_range|PASS|ok
CANARY|canary1|armed|PASS|ok
CANARY|canary1|preflight_destination_accepted|PASS|ok
CANARY|canary1|room_created|PASS|ok
CANARY|canary1|dispatch_created|PASS|ok
CANARY|canary1|originate_answered|PASS|ok
CANARY|canary1|conversation_observed|PASS|room_occupied
CANARYCOUNT|canary1|call_seconds|63
CANARY|canary1|teardown_room_deleted|PASS|ok
CANARY|canary1|teardown_room_absent|PASS|ok
CANARYCOUNT|canary1|teardown_attempts|1
CANARYDONE|1
```

`conversation_observed` is an **observation, not an inference**: the CLI cannot
hear the call, and does not claim to. `room_occupied` means it saw the room hold
both the SIP leg and the agent. Whether the audio was intelligible is what the
owner's ear is for. A disarmed run stops at
`CANARY|canary1|armed|FAIL|canary1_not_armed`; a dry run stops at
`CANARY|canary1|originate_skipped|PASS|dry_run`.

Anything that fails the grammar prints
`CANARY|canary1|emitter_refused|FAIL|unprintable` and **never** the offending
value.

## 6. The six bounds, and the three inequalities

| Bound | Default | Enforced by | Fails to |
|---|---|---|---|
| ring | 30 s | LiveKit SIP | no-answer, teardown |
| originate | 60 s, **must exceed ring** | LiveKit SIP; CLI refuses `timeouts_misordered` before any seam | refusal, no call |
| worker participant wait | `PHONE_CANARY_PARTICIPANT_WAIT_SEC` = 120 s | the worker; CLI refuses `waits_misordered` unless **wait ≥ ring + 60** | refusal, no call |
| connected call | `PHONE_CANARY_MAX_CALL_SEC` = 180 s | LiveKit SIP + an `asyncio.wait_for` in the worker | provider drops the leg; room closed |
| CLI wall clock | 330 s, **derived** | the CLI; refuses `bounds_misordered` unless **wall ≥ wait + max call + 30** | teardown runs regardless |
| empty room | 120 s | LiveKit room | the room reaps itself even if both processes die |

**Why the third row has its own knob.** The worker's participant-wait clock
starts at **job assignment**, before the originate — so dispatch scheduling, a
cold worker start (`num_idle_processes: 0`, `initialize_process_timeout: 60.0`)
and the whole ring window are all charged against it. At the production default
of 45 s that wait can expire **on the healthy path**, and the failure reads to
an operator as a provider fault: the worker closes the room while the call is
connecting or has just been answered. That is a wait charged against a budget
sized for failure — the class this lane repaired once already.

**Why the fifth row is derived, not chosen.** With a 120 s wait and a 180 s
ceiling, a participant answering late in the wait window is still talking at
t=300. A 240 s wall clock would tear the room down mid-sentence and produce
exactly the failure signature the third row exists to eliminate. If you raise
`--participant-wait-seconds` or `--max-call-seconds`, **raise
`--wall-clock-seconds` to at least their sum plus 30** or the preflight refuses
`bounds_misordered`.

**The CLI cannot read the worker's environment.** The two defaults are pinned as
a PAIR by `phone-canary1-cross-language.test.ts`, which reads the Python source,
so they cannot drift apart silently. If you change one, change both.

## 7. Aborting, and what the halt does NOT cover

**`POST /api/phone/halt` does not stop this call.** The halt stops admission and
the due pass; this mechanism never admits, and the halt does not end live calls
in any case. The abort is:

1. **Ctrl-C** — runs the SAME teardown the happy path runs: delete the room
   (which drops the SIP leg), then verify absence by listing it.
2. **Hang up the handset.**
3. `fly scale count 0 -a project-hello-phone-voice`.

If teardown cannot verify the room gone it prints
`teardown_room_absent|FAIL|cleanup_failed`, exits non-zero, and the remedy is
the three steps above performed by hand, with the room deleted in the LiveKit
console.

**This is a real reduction in emergency-stop coverage** compared with the
production lane. It is acceptable only because the destination is the operator's
own handset, in their hand, in a supervised ~3-minute window, **with a second
person present** — which is also the TEL-07 mitigation.

`/api/phone/health` reports the domain **disabled** for the whole run. That is
correct, not a fault: the API is not involved in Canary-1 at all.

## 8. What a green run does NOT prove

Read this before treating a green Canary-1 as coverage.

**Verified:** the LiveKit↔Plivo trunk binding, PSTN origination to a real
handset, ring and answer semantics, real-network audio both ways, named-worker
dispatch, channel isolation, room lifecycle and teardown — and, **because the
provider-session factory is shared and only because of that**, the production
Sarvam STT, Sarvam TTS and Gemini configuration.

**Not verified, at all:** `admit_phone_attempt` and every gate inside it (halt,
IST window, consent, suppression, the per-IST-day index, the fleet cap, number
validity); the concurrency lease, heartbeat and reclaim; the disclosure **event**
and its SQL-enforced ordering; recording/egress attach, finalize and purge;
`start_phone_assessment`, the question plan, boundary commits, resume, scoring
and the `assessments` row; webhook ingress and reconciliation; the
no-answer/reconnect budgets; the day-roll sweep; the appointment lifecycle; the
halt's effect on a live lane.

**And not verified on the worker side either:** `phone.phone_agent_class` and its
function tools, the human/machine classifier, `run_phone_gate`'s ordering, and
the callback-scheduling tool. The canary drives a **bare `Agent`** with fixed
instructions. It exercises the provider *pipeline*, not the screening *agent*.

**Canary-0 proves the state machine without a call; Canary-1 proves the call
without the state machine.** Neither substitutes for the other, and the two
together still do not prove the joined system — which only a supervised first
real-candidate call closes.

## 9. The operational sequence, stopping before the call

1. **PR105 merges.** CI green; `CANARY1_ARMED === false` asserted on `main`.
2. **PR106 merges**, with its revert commit prepared and linked. Nothing
   deployed or scaled.
3. **Owner** sets `PHONE_CANARY_ENABLED=true` as a Fly **secret** on
   `project-hello-phone-voice` only, and confirms `fly.phone.toml` still carries
   no such key (`node scripts/validate-voice-worker-apps.mjs`).
4. **Owner** deploys the voice image. Both apps share it; browser behaviour is
   unchanged, and that is re-verified by an ordinary browser screening
   afterwards.
5. **Owner** `fly scale count 1 -a project-hello-phone-voice`; confirms a
   **current** watermarked `registered worker` line.
6. **Dry run — the last step before a call.** In a transient subshell:
   `npm run canary:phone1 -- --dry-run`, destination typed at the prompt. It
   creates the room, dispatches, the worker enters the canary branch, finds no
   participant and closes; the CLI tears down and verifies absence. **No
   originate.** This proves dispatch, isolation, arming, metadata parsing
   (including the inbound guard), the wait/ring inequality, teardown and the
   grammar, with zero telephony.
   **6b.** Read the room state **once, by hand**, during a dry run and record
   **only the key names** present on the participant. This converts
   `hidePhoneNumber` from an assumption into an observation, *before* it is ever
   load-bearing.
7. **Confirm no side effects:** no new `call_sessions`, `phone_engagements`,
   `phone_call_attempts`, `phone_call_events`, `assessments` or `audit_events`
   rows; `/api/phone/health` still reports the domain disabled.
8. **Disarm and tear down:** `fly scale count 0` → `fly secrets unset
   PHONE_CANARY_ENABLED` → `fly secrets list` confirms it is gone (**names
   only, never values**) → exit the credential subshell → confirm no `.env` was
   created. **`validate-voice-worker-apps.mjs` scans only `[env]` tables, so a
   lingering secret is invisible to CI.** That is why this step is an ops
   assertion and not a CI one, and why it is a numbered step rather than a
   memory.
9. **Handover.** Record the PR shas, the dry-run verdict lines (safe by
   grammar), the exact remaining commands, the abort card, the arming/disarm
   state, and — explicitly — that no number was entered into anything durable
   and none appears in the handover.
10. **STOP.** The live call is step 11 and is **not taken here.**

**Step 11 — NO-GO.** It requires **TEL-01** (written Indian telecom counsel that
an owner-to-self test call is out of DLT/UCC scope), **TEL-04** (Legal approval
of the *canary* disclosure copy specifically — it is new copy and must not
inherit `PHONE_DISCLOSURE_TEXT`'s approval, which covers a different, recorded,
candidate-facing call; and the approval is ordered **after** the recording
control is in place, because approving copy the system does not honour is worse
than approving none), **TEL-06** (run inside 09:00–21:00 IST — not enforced on
this path, because there is no admission), **TEL-07** (a second person present
for the abort), and a clean dry run including 6b.

## 10. Residuals

* **R-1 — Plivo CDR retention is not purgeable by us.** The dialled number will
  exist in Plivo's CDRs and console and in LiveKit's SIP-side records, per their
  retention policies. **"The number never becomes durable" is a claim about OUR
  systems only.**
* **R-2 — `hidePhoneNumber: true` is documented but not yet observed by us.**
  Converted to an observation at step 6b. Defence in depth meanwhile: the canary
  branch never reads or logs participant attributes.
* **R-3 — V8 heap residency.** Unavoidable in Node; mitigated operationally.
* **R-4 — the allowlist gate is vacuous on this path** (§2). Double entry is the
  real control. Recorded so nobody later reads "the allowlist was checked" as
  evidence.
* **R-5 — a new local-credential surface.** Running the CLI puts production
  LiveKit credentials and the trunk id on a laptop. Controls: the transient
  subshell, the `credentials_persisted` refusal, and the numbered post-run
  teardown. Not a contract violation (credential, not PII), but new exposure.
* **R-6 — third-party dialling risk is ACCEPTED, not closed.** Double entry
  catches a typo; it does not catch a consistently-wrong number, or a mistaken
  or coerced operator. There is no binding between the typed value and a
  pre-registered owner identity, and the design **refuses to create one**,
  because a durable digest would defeat §2. Compensating controls, not
  oversold: the operator is the data subject and is at the terminal, a second
  person is present, the call is bounded at 180 s with a Ctrl-C abort, and one
  invocation places at most one call.
* **R-7 — the inert-dispatch control narrows from absolute to conditional.** See
  ADR-0013 §8.4.
* **R-8 — the DB halt does not cover the canary** (§7).
* **R-9 — Canary-1's zero-network test claim is weaker than Canary-0's.** The
  SDK IS resolvable from `app/api/src/__tests__`, so the property rests on
  dependency injection and the runtime traps rather than on unresolvability.
  Both are asserted; the difference is pinned by a test rather than described.
* **R-10 — the CLI's `--questions` is an expectation, not a control.** The
  worker reads `PHONE_CANARY_QUESTIONS` from its own environment; the dispatch
  metadata key set is closed at four and deliberately carries no question count.
  The two are kept in step by this runbook and by the shared copy constants,
  which ARE pinned cross-language — not by the wire.
