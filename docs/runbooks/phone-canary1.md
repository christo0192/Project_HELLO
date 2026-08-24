# Phone lane — Canary-1 (the owner's own-number test call)

**Status: MECHANISM ONLY, SHIPPED DISARMED. No call has been placed, and `main`
cannot place one.** `CANARY1_ARMED` is a source constant shipped `false` and
pinned `false` by a test; while it is false the CLI refuses before **every**
provider seam — the dry run included. **Arming lives on `canary1/arm`, a
reviewed, CI-green branch that is never merged; `main` is disarmed permanently,
enforced on every push to the default branch by
`scripts/check-main-disarmed.mjs`.** There is no prepared revert, because
nothing is merged to revert. See §4b.

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
> PR105, PR106 or the activation artifact moves them. See §9.

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
# Default. Does nothing and says so while CANARY1_ARMED is false — and says
# THAT, first, on a bare machine with no trunk and no credentials exported.
npm run canary:phone1 -- --dry-run
# From the `canary1/arm` worktree only, and only after every approval in §9 —
# NOT from `main`. On `main` this refuses `canary1_not_armed`, by design:
npm run canary:phone1 -- --execute --confirm "CALL MY OWN PHONE"
```

**The arming gate is the FIRST thing that can refuse**, ahead of the trunk, the
credentials, the bounds and the prompt. That ordering is deliberate: the refusal
an operator sees on `main` should be the one that is actually true of `main`. An
earlier ordering ran the credential and trunk preflight first, so a bare
invocation on a fresh machine reported a missing trunk and never printed the
disarmed state at all — the property this whole mechanism exists to demonstrate
was the one thing the terminal did not say.

The only two refusals ahead of it are the destination-in-argv and
destination-in-environment ones, because a destination that reached either is
already durable — in `/proc/<pid>/cmdline`, in a shell history file — by the
time this process starts, so an operator who did that must be told whether or
not the mechanism is armed.

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
`--participant-wait-seconds`, `--join-wait-seconds`, `--wall-clock-seconds`,
`--agent-name`. Everything else is refused. **There is no `--out`.**
Three of those are **expectations rather than controls** — read §4c before
touching any of them.

## 4a. Credential acquisition — no `.env`, no argv, no history, no temp file

The CLI needs four environment values: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `PHONE_SIP_TRUNK_ID`. **Three are secrets and are read
from the owner's secret manager by hand; the fourth is a placeholder for a dry
run.** **Fly secrets are write-only — they cannot be read back, and no attempt
to read them via `fly ssh console` is part of this procedure.**

Run every command below **from the `canary1/arm` worktree** (§9 step 7), not
from the shared checkout: the CLI's pinned `.env` read resolves relative to the
tree it runs from, so step 0's precondition has to be checked where the run will
happen.

```bash
# 0. Prove the refusal's precondition first. If this file exists with a LIVEKIT_ key
#    the CLI refuses `credentials_persisted` — MOVE it aside, never delete it.
ls -la app/api/.env 2>/dev/null || echo "no app/api/.env — correct"

# 1. A subshell that CANNOT write history. ORDER MATTERS: history is disabled and
#    HISTFILE is unset INSIDE the shell, before anything is typed.
#    `env -u HISTFILE bash --noprofile --norc` is NOT enough: bash re-defaults
#    HISTFILE to ~/.bash_history during startup even with --norc, so at the
#    moment the subshell exists history is ON and pointed at the operator's real
#    file. Worse, an interactive bash with HISTFILE set writes its in-memory list
#    to that file at exit and `histappend` is off by default — so a subshell with
#    history disabled from the first line can OVERWRITE ~/.bash_history WITH
#    NOTHING. That is real data loss from a step presented as inert.
bash --noprofile --norc
set +o history          # stop recording — first statement, before anything is typed
unset HISTFILE          # and remove the file bash would rewrite on exit
umask 077

# 1a. Prove both, before the first `read -rs`. One line each, directly observable.
set -o | grep history   # must report: history  off
echo "[$HISTFILE]"      # must report: []

# 2. Each value is read by a BUILTIN into a shell variable. It is never a command
#    word, so it reaches neither argv, /proc/<pid>/cmdline, nor any history file.
#    `export FOO=value` typed literally would appear in history — hence `read -rs`.
read -rs -p 'LIVEKIT_URL: '        LIVEKIT_URL        && export LIVEKIT_URL        && echo
read -rs -p 'LIVEKIT_API_KEY: '    LIVEKIT_API_KEY    && export LIVEKIT_API_KEY    && echo
read -rs -p 'LIVEKIT_API_SECRET: ' LIVEKIT_API_SECRET && export LIVEKIT_API_SECRET && echo

# The trunk id for a DRY RUN is a placeholder, and that is not a shortcut.
# `preflight_trunk_configured` tests non-emptiness and NOTHING ELSE, and the dry
# run never reads the value again. The real trunk id is entered only for
# `--execute`, which is NO-GO.
export PHONE_SIP_TRUNK_ID=PLACEHOLDER_NOT_A_TRUNK

# 3. …run the canary from here (§9)…

# 4. The subshell dies with the values. Nothing was written.
exit
```

**Honest limits, stated rather than glossed:**

* Exported variables are visible in `/proc/<pid>/environ` to the same user and to
  root for the life of the process. That is the same exposure the destination has
  in the V8 heap and is bounded by the same short run.
* `read -rs` leaves the value in the shell's memory until the subshell exits. It
  is not zeroable, exactly as §3 already records for the destination.
* **The placeholder is the specified value for a dry run**, not a way past a
  gate. Requiring the real id would buy an assertion the code does not make —
  the preflight tests `trim() === ''` and nothing else — and would cost a real
  provider identifier sitting in `/proc/<pid>/environ` for the length of the
  window, inside a procedure whose whole posture is minimum durable exposure. The
  transcript's PASS means *"a trunk id was present"*, which is all it has ever
  meant. If the owner prefers to rehearse the exact live environment with the
  real value, that is a legitimate choice — but it is a **rehearsal decision, not
  a property of the preflight**, and it must be made knowingly.
* Nothing here is written to a `.env`, a temp file, a manifest (there is none —
  the mechanism writes no file), a handover, or PR text. **The handover records
  that credentials were sourced transiently; it records no value and no digest.**

**What the trunk id must survive, exactly.** The CLI now puts the value through
the **production** loader (`loadPhoneDialConfig().sipTrunkId`), the same one the
real dial lane uses, so the CLI and production agree about what a trunk id may
say. That loader **trims surrounding whitespace and then matches
`^[A-Za-z0-9_-]{1,128}$`**. The operational consequences, stated as the loader
actually behaves rather than as one might guess:

| Pasted value | Result |
|---|---|
| a trailing space or newline (the realistic paste accident) | **normalised, not refused** — the trim removes it and the run proceeds |
| leading whitespace | likewise normalised |
| a `+`-prefixed E.164 shape | reduces to `''` ⇒ `trunk_not_configured`. `+` and space are outside the class **deliberately**, so this field can never be talked into holding a phone number |
| an **interior** space | reduces to `''` ⇒ `trunk_not_configured` |
| any character outside `[A-Za-z0-9_-]` | reduces to `''` ⇒ `trunk_not_configured` |
| more than 128 characters | reduces to `''` ⇒ `trunk_not_configured` |

So `trunk_not_configured` now means *"absent, **or** not a bounded opaque id"*.
You type this one blind, at a `read -rs` prompt, and cannot see what you pasted:
the refusal arrives **before** any provider seam and before the destination is
typed twice, instead of as an undetailed `originate_failed` after live provider
state already exists.

## 4b. The disarm gate — what goes red, and what it means

`scripts/check-main-disarmed.mjs` asks `main` exactly one question: does
`app/api/src/lib/phone-canary1/arming.ts` still declare the disarmed literal
`export const CANARY1_ARMED: boolean = false;`? If not, it exits non-zero.

**Why it exists as a second gate.** The structural suite already pins the
literal — but that pin **travels with the branch**. The activation artifact flips
the constant and flips the pin in the same commit, so the artifact's own PR is
green, and a *merge* of the artifact carries the inverted pin along and is green
too. **A test the artifact can rewrite is not a gate against the artifact.** This
gate does not travel: it lives on `main` and the activation branch never edits it.

**Why it is push-only, beside an always-run wiring test.** `quality.yml` wires it
as two steps:

| Step | When it runs | What it proves |
|---|---|---|
| `Validate main is disarmed (default branch only)` | `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` | the default branch is disarmed **now** |
| `Validate the disarm gate is wired (always)` | every PR, unguarded | the gate file exists, the `if:` guard is intact, and the predicate goes **red** on a seeded armed source — without reading the tree |

The guard has to be default-branch-only, because the activation artifact is a
legitimate, reviewable branch whose PR **must** stay green; a gate that turned it
red would be deleted by the first person trying to review it. The wiring test is
what stops the gate being quietly removed or loosened in some later PR: it runs
on the artifact's PR too, and it never reads `arming.ts`.

**A `workflow_dispatch` on `main` does NOT run the gate** — the guard tests
`github.event_name == 'push'`. That is a stated limit, not an oversight. The
manual path is local and needs no repo root:

```bash
node scripts/check-main-disarmed.mjs     # prints: main disarmed OK
```

**The one sentence that matters to an operator.** *If `main` ever goes red with
"main carries an ARMED Canary-1 constant", the activation artifact was merged:
revert that commit, delete the `canary1/arm` branch, and confirm `fly secrets
list -a project-hello-phone-voice` shows no `PHONE_CANARY_ENABLED`.* Nothing can
have dialled from it on its own — `CANARY1_ARMED` is read by a hand-run CLI only
— so this is the abort of a **state**, not of a call (§7).

**One thing this file cannot confirm, and you must.** Whether a red `quality`
**blocks** a merge depends on `quality` being a **required status check** under
branch protection. That is repository settings, **not visible from a worktree and
therefore UNVERIFIED here** — confirm it in the repository's branch-protection
settings. Detection holds either way: the gate reports the accident on the next
push to `main` regardless. It is the **enforcement** half that needs confirming.

## 4c. Knobs that are expectations, not controls

Three flags look like they configure the run and do not. They configure what the
**CLI believes** about a worker whose environment the CLI cannot read.

| Flag | What the worker actually reads | Failure direction if they disagree |
|---|---|---|
| `--questions` | `PHONE_CANARY_QUESTIONS` on `project-hello-phone-voice` | benign: the count asked is the worker's, not the CLI's. Count the `phone_canary_question_asked` lines (§5a) |
| `--participant-wait-seconds` | `PHONE_CANARY_PARTICIPANT_WAIT_SEC` | **LIVE-CALL HAZARD.** See below |
| `--max-call-seconds` | `PHONE_CANARY_MAX_CALL_SEC` | fails **short**, not long: the smaller of the two ends the leg first, so a mismatch cannot extend a call beyond what was intended. No live-call hazard follows from this one |

**`--participant-wait-seconds` is the one that can hurt somebody.** It was not
documented as an expectation before, and the join-wait inequality (§6) now makes
it load-bearing: the preflight refuses `origination_wait_misordered` unless
`participantWait >= joinWait + ring + 15`. That check is made against a number
**the CLI cannot enforce**. So:

> **If you raise `--participant-wait-seconds`, you MUST set
> `PHONE_CANARY_PARTICIPANT_WAIT_SEC` to the same value on
> `project-hello-phone-voice`** — otherwise the preflight passes on an
> expectation the worker does not honour, the worker gives up mid-ring, closes
> the room, and the answered handset hears nothing. That is the silent-answered-
> call failure re-entering by the back door, from the one direction the
> worker-presence gate cannot see.

**The control, not the hope.** The worker logs its **effective** bound at entry:
`phone_canary_wait_bound` carries `duration_sec` = its own
`PHONE_CANARY_PARTICIPANT_WAIT_SEC`. **Read it in `fly logs` during the dry run
and confirm it equals the value the CLI's inequality was checked against, BEFORE
`--execute` is considered** (§5a, §9 step 9). That is the only observation that
converts an expectation-only knob into something checked. The two defaults (120)
agree, and are pinned as a pair cross-language by
`phone-canary1-cross-language.test.ts` — but a *flag* is not the default, and
nothing pins a flag to a secret.

**`--join-wait-seconds` is a real control** (default 60, range [30,150]): it
bounds how long the CLI waits for the worker to appear before it originates, and
it is **charged against** the worker's participant wait by the inequality above.
At the defaults that reads `120 >= 60 + 30 + 15 = 105` — 15 s of slack, not a
tie. **150 is not satisfiable at the default ring of 30** (`150 + 30 + 15 = 195 >
180`), and the preflight refuses that combination rather than quietly accepting
it: a knob whose maximum is reachable only for some settings of another knob is
exactly why the relation is checked instead of assumed.

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
CANARY|canary1|armed|PASS|ok
CANARY|canary1|credentials_transient|PASS|ok
CANARY|canary1|preflight_trunk_configured|PASS|ok
CANARY|canary1|preflight_livekit_credentials|PASS|ok
CANARY|canary1|preflight_bounds_in_range|PASS|ok
CANARY|canary1|preflight_timeouts_ordered|PASS|ok
CANARY|canary1|preflight_waits_ordered|PASS|ok
CANARY|canary1|preflight_bounds_ordered|PASS|ok
CANARY|canary1|preflight_room_timeout_ordered|PASS|ok
CANARY|canary1|preflight_origination_wait_ordered|PASS|ok
CANARY|canary1|preflight_questions_in_range|PASS|ok
CANARY|canary1|preflight_destination_accepted|PASS|ok
CANARY|canary1|room_created|PASS|ok
CANARY|canary1|dispatch_created|PASS|ok
CANARY|canary1|worker_present_before_originate|PASS|joined
CANARY|canary1|originate_answered|PASS|ok
CANARY|canary1|conversation_observed|PASS|room_occupied
CANARYCOUNT|canary1|call_seconds|63
CANARYCOUNT|canary1|teardown_delete_returned|1
CANARY|canary1|teardown_room_absent|PASS|ok
CANARYCOUNT|canary1|teardown_attempts|1
CANARYDONE|1
```

**Only `teardown_room_absent` decides.** `teardown_delete_returned` is a count,
not a verdict: a delete can legitimately throw on a room the provider has
already reaped, and reporting a cleanup failure for a room that does not exist
sends an operator to the LiveKit console for nothing and trains them to ignore
the line that matters.

`conversation_observed` is an **observation, not an inference**: the CLI cannot
hear the call, and does not claim to. `room_occupied` means it saw the room hold
both the SIP leg and the agent. Whether the audio was intelligible is what the
owner's ear is for. A disarmed run stops at
`CANARY|canary1|armed|FAIL|canary1_not_armed`.

**`worker_present_before_originate` is emitted on BOTH branches, and it is the
same observation meaning two different things.** On a dry run it is the
*evidence* — the only offline-safe proof that arming, the dispatch metadata and
the worker's inbound guard all agree end to end. On `--execute` it is a
*precondition*: the CLI waits for the worker and **originates nothing** if it
never arrives, because otherwise the handset rings, a real person answers, and
nobody speaks — not even the disclosure, which is the worker's first action.
Same code, two meanings, which is exactly why it must not be two
implementations. Its three codes are `joined`, `worker_never_joined` and
`room_reaped_before_join`; see §9 step 9 for the diagnosis order. A dry run then
emits `originate_skipped|PASS|dry_run` and tears down.

**The bound of that gate, stated so it is not over-read.**
`worker_present_before_originate` proves the worker **joined**. It does **not**
prove the worker can **start a session**. `run_phone_canary` does `ctx.connect()`
and *then* `session_factory()`, and the provider plugins read `SARVAM_API_KEY`
from the environment rather than receiving it as a kwarg — so a worker missing a
provider key **joins the room, opens this gate, and then dies constructing the
session**. On `--execute` that is again a ringing handset, an answered call and
silence, from a cause this gate cannot see. The observation that closes it is the
dry run's `phone_canary_session_started` line (§5a), and — like
`phone_canary_wait_bound` — it must be **seen before `--execute` is
considered**. §9 step 5a checks the provider keys by name for the same reason.

Anything that fails the grammar prints
`CANARY|canary1|emitter_refused|FAIL|unprintable` and **never** the offending
value.

## 5a. Reading the worker's counters

The CLI's transcript says what the **CLI** saw. The worker's own run is visible
only in its structured logs, read with:

```bash
fly logs -a project-hello-phone-voice
```

**Every line the canary branch may emit** (this list is pinned in the source by
`CANARY_LOG_EVENTS`, so a new log call cannot introduce an unreviewed
vocabulary):

| `error_type` | Extra field | What it tells you |
|---|---|---|
| `phone_canary_start` | `schema=<canary_id>` | the canary branch was entered — arming and the three-condition gate all held |
| `phone_canary_wait_bound` | `duration_sec` | **the worker's EFFECTIVE `PHONE_CANARY_PARTICIPANT_WAIT_SEC`.** This is the §4c control. Confirm it before `--execute` |
| `phone_canary_participant_waited` | `duration_sec` | how long the participant wait actually took — on **both** branches, so a near-bound value on a *healthy* run is visible rather than inferred |
| `phone_canary_session_started` | — | the provider session opened. Separates "the session constructed" from "the conversation happened"; a failure between `start` and this line is a provider-key/config fault, not a telephony one |
| `phone_canary_question_asked` | `turn_index` | one line per question actually asked |
| `phone_canary_answer_observed` / `phone_canary_answer_silent` | `turn_index` | per turn: something was heard, or nothing was. **Never what was said** |
| `phone_canary_room_closed` | — | the worker's own deleter ran. See the caveat below |
| `phone_canary_outcome` | `error_category`, `duration_sec` | the terminal verdict and the conversation's wall time, so the 180 s ceiling is observable rather than assumed |
| `phone_canary_refused` | `error_category` | the branch refused; the category says which guard |

**Count the `phone_canary_question_asked` lines.** There is deliberately no count
field. `turn_index` means *an index*, and the logger's allowlist has no "count"
key; overloading `turn_index` to also mean a total would put a second meaning on
a shared field. The count is what you get by counting lines, and this sentence is
where that is written down.

**How these lines are correlated — and it is weaker than it looks.**
`schema=<canary_id>` (eight lowercase hex) is the **only** anchor, and the newer
lines deliberately carry **no siblings**: no room name, no participant identity,
no attributes, no destination-derived value, no digest. So in practice you read
them **by time and by the fact that there is one machine**, not by id. The
worker's one-shot latch guarantees one run per *process*; one *machine* is
guaranteed only by `fly scale count 1`. Therefore:

> **If `fly status` ever shows more than one machine during the window, STOP.**
> The correlation these lines rest on has failed, and nothing in the transcript
> will tell you which run you are reading.

**A dry run does NOT evidence `phone_canary_room_closed`, and must not be read as
if it did.** The CLI returns from its join observation the moment the worker
appears and its `finally` deletes the room within ~2 s — while the worker is
still inside its participant wait. Whether `phone_canary_room_closed` is emitted
at all therefore depends on whether the job survives its room being deleted:

* **If the job is torn down with the room** (the usual `livekit-agents`
  behaviour), `phone_canary_participant_waited` and `phone_canary_room_closed`
  are **never emitted**. That is expected and is **not** a failure of the dry run.
* **If the job survives** (the wait polls the room defensively),
  `phone_canary_participant_waited` appears with `duration_sec ≈` the full wait,
  **after the CLI has already exited**.

**Record which one happened. It is an observation, not a pass/fail** — and a
`duration_sec` near the bound here is **not** a measurement of the participant-
wait inequality: there was no originate and no ring to charge against it. That
measurement exists only on a real call.

## 6. The seven bounds, and the five inequalities

| Bound | Default | Enforced by | Fails to |
|---|---|---|---|
| ring | 30 s | LiveKit SIP | no-answer, teardown |
| originate | 60 s, **must exceed ring** | LiveKit SIP; CLI refuses `timeouts_misordered` before any seam | refusal, no call |
| worker participant wait | `PHONE_CANARY_PARTICIPANT_WAIT_SEC` = 120 s | the worker; CLI refuses `waits_misordered` unless **wait ≥ ring + 60** | refusal, no call |
| **join wait** (`--join-wait-seconds`) | **60 s**, range [30, 150] | the CLI; refuses `origination_wait_misordered` unless **wait ≥ join wait + ring + 15** | refusal, no call |
| connected call | `PHONE_CANARY_MAX_CALL_SEC` = 180 s | LiveKit SIP + an `asyncio.wait_for` in the worker | provider drops the leg; room closed |
| CLI wall clock | 330 s, **derived** | the CLI; refuses `bounds_misordered` unless **wall ≥ wait + max call + 30** | teardown runs regardless |
| empty room | **210 s, derived** (`wait + 60 + 30`) | LiveKit room; CLI refuses `room_timeout_misordered` if the value passed to `createRoom` is not that derivation | the room reaps itself even if both processes die |

Every one of those knobs also has a declared `{min, max}` in
`CANARY1_BOUNDS`, and the CLI refuses `bounds_out_of_range` **before** it
reasons about ordering. That is not decoration: without it
`--max-call-seconds 3600` would set a one-hour ceiling on a live PSTN leg, and
`--participant-wait-seconds 500` would be checked against a value the worker
never uses, because `phone.py` clamps that knob to [1, 180].

**Why the third row has its own knob.** The worker's participant-wait clock
starts at **job assignment**, before the originate — so dispatch scheduling, a
cold worker start (`num_idle_processes: 0`, `initialize_process_timeout: 60.0`)
and the whole ring window are all charged against it. At the production default
of 45 s that wait can expire **on the healthy path**, and the failure reads to
an operator as a provider fault: the worker closes the room while the call is
connecting or has just been answered. That is a wait charged against a budget
sized for failure — the class this lane repaired once already.

**Why the wall clock is derived, not chosen.** With a 120 s wait and a 180 s
ceiling, a participant answering late in the wait window is still talking at
t=300. A 240 s wall clock would tear the room down mid-sentence and produce
exactly the failure signature the participant-wait row exists to eliminate. If
you raise `--participant-wait-seconds` or `--max-call-seconds`, **raise
`--wall-clock-seconds` to at least their sum plus 30** or the preflight refuses
`bounds_misordered`.

**Why the join wait has its own knob, and why it is charged.** A pre-originate
wait is not free. The worker's participant-wait clock starts at **job
assignment**, before the originate — so every second the CLI spends waiting for
the worker to appear is a second subtracted from the window in which the worker
will still be waiting when the leg is answered. "Just wait for the worker first"
consumes the very resource it is protecting, and the failure is the *same*
silent-answered-call it was meant to prevent, arriving from the other side.
Hence the inequality, with a 15 s margin covering the gap between job assignment
and the join we can actually *observe*, plus the originate call itself. The
older `wait ≥ ring + 60` check is **kept**: it still governs the dry run, and two
inequalities that agree cost nothing — deleting the older one to avoid
redundancy would delete the reason it exists.

**Why the empty-room timeout is derived, and what that costs.**
`emptyTimeout` runs from room **creation**, and the canary room is created
**empty** and stays empty until the agent joins — unlike a production room, which
is dialled within seconds. A flat 120 s therefore let the provider reap the room
while the CLI was still waiting for the worker, and the join observation then
reported the same code an unarmed or scaled-to-zero worker produces: a bound
problem wearing a state problem's face. Deriving it from the participant wait
closes that, and the fourth inequality stops a raised
`--participant-wait-seconds` silently re-opening it.

**The cost, stated as a trade rather than a win:** an *empty* canary room now
survives **210 s at the defaults, and `180 + 60 + 30` = 270 s at
`--participant-wait-seconds`'s ceiling of 180**, after every process we control
has exited. That is deliberate. An empty room holds no leg, costs nothing and is
bounded; a room reaped mid-wait destroys the evidence the whole window exists to
produce. The trade is the right way round, and it is a trade.

**The CLI cannot read the worker's environment.** The two defaults are pinned as
a PAIR by `phone-canary1-cross-language.test.ts`, which reads the Python source,
so the *defaults* cannot drift apart silently. **Nothing pins a flag to a Fly
secret**, which is why raising `--participant-wait-seconds` is the hazard §4c
describes and why `phone_canary_wait_bound` is the observation that closes it.
If you change one, change both.

## 7. Abort card

**The two controls that do NOT work are named first, so nobody reaches for them
with a live leg on the line.**

* ✗ **`POST /api/phone/halt` does not stop this.** It stops admission and the due
  pass. This mechanism never admits, and the halt does not end live calls in any
  case. (Residual R-8.)
* ✗ **Scaling the browser worker changes nothing.** Different app. The canary
  dispatches by name to `project-hello-phone-voice`.

**What does work, ranked least- to most-drastic:**

1. **Ctrl-C in the CLI.** Runs the *same* teardown the happy path runs — delete
   the room (which drops the SIP leg), then verify absence by listing — and exits
   non-zero. A second Ctrl-C is ignored while the first teardown is in flight, by
   design.
2. **Hang up the handset.** Drops the SIP leg. The room then empties and is
   reaped by the worker's own `close_room`, by the CLI's teardown, or by the
   room's derived `emptyTimeout` (§6) — three independent deleters.
3. **`fly scale count 0 -a project-hello-phone-voice`.** Removes the worker
   mid-session.
4. **Delete the room by hand in the LiveKit console. Note the identification
   problem before you need it:** the canary room is named `phone-<uuid>` — **the
   same shape as a production phone room** — and **the CLI never prints it**,
   because `PROTOCOL.md`'s grammar has no free-text field. It is identified by
   its metadata (`canary: true`) and by the fact that the production lane is
   disabled for the whole window, so it should be the **only** `phone-*` room
   present. **If more than one exists, stop and treat it as an incident**
   — the lane is disabled all window, so exactly one is expected.
5. **Carrier side, last resort:** if the Plivo console exposes an active-call
   hangup for this account, that ends the leg independently of everything above.
   **UNVERIFIED** — no provider console was read while writing this; what would
   settle it is one look at the account's console before the window opens.

**If the activation artifact turns out to have been merged**, that is the abort
of a **state**, not of a call: revert the merge commit, delete `canary1/arm`, and
confirm `fly secrets list` shows no `PHONE_CANARY_ENABLED`. Nothing can have
dialled from it on its own. See §4b.

If teardown cannot verify the room gone it prints
`teardown_room_absent|FAIL|cleanup_failed`, exits non-zero, and the remedy is
steps 2–4 above performed by hand.

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

Steps 1–2 are repo actions. Steps 3–10 are **owner actions requiring app and
provider access**. Step 11 is the handover and step 12 is the STOP.

**1. PR105 is MERGED** — squash-merged as `main` @ `d2f20f48`. `CANARY1_ARMED`
is the literal `false` and `node scripts/check-phone-canary-evidence.test.mjs` is
green. Nothing to do.

**2. PR106 merges.** It touches `app/voice-livekit/`, so the Deploy (Fly)
workflow runs `migrate-production` → `deploy-browser-voice` **and**
`deploy-phone-voice`. The phone job scales the app to 0 before **and** after its
release. **That is the desired order:** the worker counters reach the image
before the window opens, and the app is left at zero. Confirm the browser worker
re-registered (its job fails closed if not) and run one ordinary browser
screening — the shared-image blast-radius check ADR-0013 promises.

**3. Open the activation artifact.** From `main`, branch `canary1/arm`, PR titled
**"ACTIVATION ARTIFACT — DO NOT MERGE"**, carrying the two-file flip
(`arming.ts` and its structural pin) and nothing else. Let CI go green. **Record
the sha. Do not merge.** Explicitly confirm auto-merge is **off** for this PR —
this lane has already been bitten once by an auto-merge dropping a gate.

**4. MERGE FREEZE begins.** From here until step 10, **no merge to `main` may
touch `app/voice-livekit/`**: such a merge deploys and re-zeroes the phone app
mid-window (residual R-12). The owner is the only merger; the check is
`gh run list --workflow "Deploy (Fly)" --limit 5` before and after the window.

**5. Arm the worker.**

```bash
fly secrets set PHONE_CANARY_ENABLED=true -a project-hello-phone-voice
node scripts/validate-voice-worker-apps.mjs   # confirms the CONFIG still has no such key
```

The validator scans `[env]` tables only, so it confirms the *config*, not the
secret. Confirming the secret is step 5a.

**5a. Confirm the secrets are PRESENT, by name, before scaling up.**

```bash
fly secrets list -a project-hello-phone-voice     # NAMES ONLY, never values
```

**All six must be present:**

| Key | If it is missing |
|---|---|
| `PHONE_CANARY_ENABLED` | **STOP. Do not scale up.** The canary branch is unreachable |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the worker cannot register at all |
| `SARVAM_API_KEY` | **the worker JOINS and then dies at `session.start`** |
| `GEMINI_API_KEY` | likewise |

**Why the provider keys belong in this check and not in a diagnosis step.** If
`PHONE_CANARY_ENABLED` did not take, `phone.phone_canary_enabled()` is false, the
worker skips the canary branch, falls through to the attempt-id resolution,
logs `phone_dispatch_unresolved` and **returns without `ctx.connect()`**. The
worker never joins and the CLI reports exactly
`worker_present_before_originate|FAIL|worker_never_joined` — **the same line a
mid-window re-zeroing produces.** Two causes, one symptom, opposite remedies; a
check that costs one command should not be a diagnosis step.

The provider keys are the *other* half, and they fail in the direction the
worker-presence gate cannot see: `run_phone_canary` does `ctx.connect()` and
**then** `session_factory()`, and the provider plugins read `SARVAM_API_KEY` from
the environment rather than receiving it as a kwarg. So a worker missing one
**joins the room, opens the gate, and dies constructing the session** — on
`--execute`, a ringing handset, an answered call and silence. Names only, never
values. Paired with step 10's names-only confirmation that `PHONE_CANARY_ENABLED`
is **gone**, this is two-sided: one command at each end.

**6. Capture the watermark BY HAND, then scale up.** The phone deploy job
deliberately captures no registration proof (a stopped app has none to gate), so
the owner captures the one the browser job would have:

```bash
WM="$(date -u +%Y-%m-%dT%H:%M:%S)"; echo "$WM"
fly scale count 1 -a project-hello-phone-voice
# Accept ONLY a 'registered worker' line whose ISO-8601 timestamp is >= $WM.
fly logs -a project-hello-phone-voice --no-tail | grep 'registered worker'
```

A stale line from an earlier window must not satisfy the eye. **No current line
⇒ stop.** Also confirm `fly status` shows exactly **one** machine (§5a).

**7. Check out the activation artifact, and prove it is only the artifact.**

```bash
git fetch origin
git worktree add /tmp/wt-canary1-arm origin/canary1/arm   # ISOLATED — not the shared checkout
cd /tmp/wt-canary1-arm
git log --oneline origin/main..HEAD    # exactly ONE commit
git diff origin/main...HEAD --stat     # exactly TWO files: arming.ts, phone-canary1-structural.test.ts
git diff origin/main...HEAD            # read it at the terminal, in full
cd app/api && npm ci                   # the armed run uses THIS tree
```

**`origin/main`, not `main`.** `git fetch origin` updates `origin/main`; it does
**not** move the local `main` ref. The owner may have merged through the GitHub UI
and never pulled, so a local `main` that is behind makes `main..HEAD` list the arm
commit **plus every commit the local ref is missing** — "exactly ONE commit" then
fails for a reason that has nothing to do with the artifact, at the step whose
whole purpose is building confidence. A local `main` that is *ahead* is worse: it
silently changes what the two-dot range means.

**A dedicated worktree, not the shared checkout.** A second session can move a
branch under you, and an armed run is the one place that hazard is expensive. The
worktree also makes step 10 **subtractive**: `git worktree remove` needs no `git
checkout main` and cannot leave the shared checkout sitting on an armed branch if
the session is interrupted.

**8. Enter the credential subshell** (§4a), **from `/tmp/wt-canary1-arm`**.
Confirm `app/api/.env` is absent **in that tree** — the CLI's pinned read
resolves to the `app/api/.env` of whichever tree it runs from, so the
precondition must be checked where the run happens.

**9. Dry run — the last step before a call.**

```bash
cd /tmp/wt-canary1-arm/app/api && npm run canary:phone1 -- --dry-run
```

Type the destination twice at the hidden prompt. **Expect exactly this order:**

```
CANARY|canary1|argv_accepted|PASS|ok
CANARY|canary1|environment_accepted|PASS|ok
CANARY|canary1|armed|PASS|ok
CANARY|canary1|credentials_transient|PASS|ok
CANARY|canary1|preflight_trunk_configured|PASS|ok
CANARY|canary1|preflight_livekit_credentials|PASS|ok
CANARY|canary1|preflight_bounds_in_range|PASS|ok
CANARY|canary1|preflight_timeouts_ordered|PASS|ok
CANARY|canary1|preflight_waits_ordered|PASS|ok
CANARY|canary1|preflight_bounds_ordered|PASS|ok
CANARY|canary1|preflight_room_timeout_ordered|PASS|ok
CANARY|canary1|preflight_origination_wait_ordered|PASS|ok
CANARY|canary1|preflight_questions_in_range|PASS|ok
CANARY|canary1|preflight_destination_accepted|PASS|ok
CANARY|canary1|room_created|PASS|ok
CANARY|canary1|dispatch_created|PASS|ok
   ↑ then a bounded wait of up to `--join-wait-seconds` (60 s by default,
     NOT the participant wait) while the worker cold-starts
CANARY|canary1|worker_present_before_originate|PASS|joined
CANARY|canary1|originate_skipped|PASS|dry_run
CANARYCOUNT|canary1|teardown_delete_returned|1
CANARY|canary1|teardown_room_absent|PASS|ok
CANARYCOUNT|canary1|teardown_attempts|1
CANARYDONE|1
```

**No originate. Exit code 0.** `armed` is the **third** line, deliberately (§4).
The nine `preflight_*` lines are emitted in the preflight record's insertion
order, which is why the two newest sit between `preflight_bounds_ordered` and
`preflight_questions_in_range` rather than at the end. **The worker-presence
check precedes `originate_skipped`**, because both branches wait before they
diverge (§5).

**Expect this step to look idle while it runs:** the worker starts no idle job
processes, so a cold start alone can take a minute.

**Diagnosis order when it is not `joined`.** Take these in order; the first is
first because it is the only one of the three whose remedy is a **bound** rather
than a **state**:

1. **`room_reaped_before_join`** — the provider reaped the room while the CLI was
   still watching it. **A bound problem.** Do not go looking at secrets or scale.
   Check `--participant-wait-seconds` / `--join-wait-seconds` and the derived
   `emptyTimeout` (§6). This code exists precisely so this case stops being
   reported as a missing worker.
2. **`worker_never_joined`** — a **state** problem, in this order:
   **secret** (step 5a: is `PHONE_CANARY_ENABLED` still present?) → **scale**
   (`fly scale count` — is the machine still there?) → **deploy history**
   (`gh run list --workflow "Deploy (Fly)" --limit 5` — did a voice-touching
   merge land mid-window and re-zero the app? residual R-12) → **dispatch**
   (agent name agreement) → **the trunk LAST.** The trunk is not involved in a
   dry run at all, and reaching for it first is the misdiagnosis this order
   exists to prevent.

**In a second terminal**, `fly logs -a project-hello-phone-voice` (§5a). Two
observations are **required before `--execute` is ever considered**:

* **`phone_canary_wait_bound`** — its `duration_sec` must equal the value the
  CLI's join-wait inequality was checked against (§4c).
* **`phone_canary_session_started`** — the only thing that shows the provider
  session actually constructs. The worker-presence gate cannot see this failure
  (§5).

Then record which of the two `phone_canary_room_closed` outcomes happened (§5a).
It is an observation, not a pass/fail.

**9b. Convert `hidePhoneNumber` from assumption to observation** (residual R-2).
During the wait, read the room state **once, by hand**, in the LiveKit console
and record **only the key names** present on the participant. **Never a value.**

**10. Confirm no side effects, then disarm — in this order.** No new
`call_sessions`, `phone_engagements`, `phone_call_attempts`, `phone_call_events`,
`assessments` or `audit_events` rows; `/api/phone/health` still reports the
domain **disabled** (correct — the API is not involved). Then:

```bash
fly scale count 0 -a project-hello-phone-voice
fly secrets unset PHONE_CANARY_ENABLED -a project-hello-phone-voice
fly secrets list -a project-hello-phone-voice     # NAMES ONLY — confirm it is GONE
exit                                              # the credential subshell
git worktree remove /tmp/wt-canary1-arm
```

Then confirm no `app/api/.env` was created in **either** tree, and **the MERGE
FREEZE ends**. `validate-voice-worker-apps.mjs` scans only `[env]` tables, so a
lingering secret is **invisible to CI** — that is why this is an ops assertion
and a numbered step, not a memory. Removing the worktree is **subtractive**:
there is no `git checkout main` to remember, and the shared checkout was never on
the armed branch to begin with.

**11. Handover.** Record the PR105/PR106 shas, the `canary1/arm` sha **and that
it is unmerged**, the dry-run verdict lines (safe by grammar), the worker counter
lines, the step-9b key names, the abort card, the arming/disarm state, and —
explicitly — **that no number was entered into anything durable and none appears
in the handover.**

**12. STOP.** The live call (`--execute --confirm "CALL MY OWN PHONE"`) is not
taken here.

**What the remaining gate now is.** The owner reports TEL-01, TEL-04, TEL-06,
TEL-07 and provider-security as **approved for the owner-only test call**. That
is recorded as an **owner attestation** and nothing more: this repository
observed no approval artifact, contacted no counsel, and read no provider
console. **What the attestation does not cover, stated so it is not over-read:**

* **No provider configuration is verified by anything here.** Nothing confirms
  that the LiveKit outbound trunk exists, that its termination points at Plivo,
  that the Plivo trunk and caller-ID number are provisioned, that the IP
  allowlist admits LiveKit, or that the account's DLT/UCC posture matches what
  TEL-01 was granted against. This repository **cannot** verify any of it:
  `sipTrunkId` is provider-neutral and opaque, and the health surface publishes
  only `sipTrunkConfigured: boolean`, never the value. **A green
  `preflight_trunk_configured` asserts that a bounded opaque string was present
  — not that a carrier path works** (§4a).
* **An approval does not close a code gap**, and it does not substitute for an
  observation. A clean dry run including 9b is still required, and so are the
  `phone_canary_wait_bound` and `phone_canary_session_started` confirmations.

**So the remaining gate on the live call is:** PR106 merged, `canary1/arm` cut
and reviewed, a clean dry run, the wait bound and the session-started line
confirmed, and the owner present with TEL-07's second person.

## 10. Residuals

* **R-1 — Plivo CDR retention is not purgeable by us.** The dialled number will
  exist in Plivo's CDRs and console and in LiveKit's SIP-side records, per their
  retention policies. **"The number never becomes durable" is a claim about OUR
  systems only.**
* **R-2 — `hidePhoneNumber: true` is documented but not yet observed by us.**
  Converted to an observation at §9 step 9b. Defence in depth meanwhile: the canary
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
  which ARE pinned cross-language — not by the wire. **`--participant-wait-seconds`
  has the same character and is the dangerous one** — see §4c.
* **R-11 — the inert-dispatch comment in `deploy-fly.yml` is narrowed, not
  absolute.** It used to say a dispatch to no name means "no room is ever routed
  to this worker". With the Canary-1 CLI existing, that is true of the **API**
  and no longer of the **system**: the CLI dispatches to this name directly to
  LiveKit, bypassing the API entirely. The workflow's conclusion still holds —
  an automatic shared-source deploy cannot make the phone app live and
  dispatchable on its own — but it now holds for **two** reasons (`CANARY1_ARMED`
  false on `main`, plus the unset `PHONE_CANARY_ENABLED` secret), and neither is
  automatic. The comment itself was corrected rather than the correction being
  filed somewhere the next editor of that job will not read.
* **R-12 — a mid-window merge to `main` touching `app/voice-livekit/` re-zeroes
  the phone app.** `deploy-fly.yml`'s `detect` job sets `phone=true` for **any**
  push to `main` whose diff touches that tree (the two voice apps share one
  source), and `deploy-phone-voice` then runs `flyctl scale count 0` before and
  after its release. There is no opt-out and no window exemption. **The symptom
  is `worker_present_before_originate|FAIL|worker_never_joined`** — the same line
  a missing `PHONE_CANARY_ENABLED` produces, with the opposite remedy, which is
  why §9's diagnosis order names deploy history explicitly. Prevented by the step-4
  merge freeze; detected by re-checking the watermarked registration immediately
  before step 9. **Fail-closed and harmless when it happens:** the dispatch reaches
  no worker, the CLI refuses before any originate, tears the room down and exits 1.
  **What must NOT be done about it:** removing the two `scale count 0` lines is
  `phone-worker-deployment.md` §6 — a much larger posture change that leaves the
  phone worker persistently live and requires the API's `PHONE_AGENT_NAME` to move
  with it. Canary-1 does neither (`phone-worker-deployment.md` §6a).
* **R-m — the worker's one-shot latch may be weaker than it reads. UNVERIFIED.**
  `_canary_ran` is module-level and therefore **per job process**. With
  `num_idle_processes: 0` a job process is created on demand, so if
  `livekit-agents` runs each job in its own process the latch guards against a
  second dispatch into the *same* process, not against a second *job*. This could
  not be settled offline (the SDK is not installed and there is no network), and
  the comment in `phone_canary.py` has been softened to match: it now claims that
  a second conversation requires a second **deliberate act**, not that arming
  buys exactly one conversation. **The observation that settles it:** during the
  window, send a **second dry-run dispatch** and see whether the worker refuses
  `canary_already_run` or conducts a second run. Until then the one-conversation
  property rests only on the controls known to hold — the CLI's own single-shot,
  `fly scale count 1`, and the operator.

## 11. Rollback card

Six subtractive layers, least- to most-drastic. **None touches the API, the
browser worker, the database, or any production flag — because none of them was
ever changed.**

| # | Action | Effect | Reversible by |
|---|---|---|---|
| 1 | `fly secrets unset PHONE_CANARY_ENABLED -a project-hello-phone-voice` | the worker's canary branch becomes unreachable; a canary dispatch is refused before `ctx.connect()` | re-setting it |
| 2 | `fly scale count 0 -a project-hello-phone-voice` | no worker exists at all | `fly scale count 1` |
| 3 | `git worktree remove /tmp/wt-canary1-arm` / `git push origin --delete canary1/arm` | the CLI refuses `canary1_not_armed` before every provider seam | re-create the worktree / re-push the branch |
| 4 | revert PR106 | the counters, the live-call close-out and these cards leave the tree | re-merge |
| 5 | revert PR105 | the whole mechanism leaves the tree | re-merge |

Layers 4 and 5 touch `app/voice-livekit/` and therefore trigger a deploy that
**re-zeroes the phone app** — in the rollback direction, which is correct.

**There is no "merge the prepared revert" layer**, because there is nothing
merged to revert: arming never reaches `main` (§4b).

**Layer 0, always in force and needing no preparation:**
`scripts/check-main-disarmed.mjs`. It is not a rollback *action* — it is what
**tells you a rollback is needed**, on the one failure the layers above cannot
report: the activation artifact having been merged. See §4b for the remedy, and
for the one thing about it this file cannot confirm.
