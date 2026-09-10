# Runbook — phone safe dialer (P4)

**Status: DISABLED BY DEFAULT. Nothing in this change dials until an operator turns on
four independent switches and provisions a trunk.** No production or provider access was
used to build it, and no real call has been placed.

Companion runbooks: `phone-webhook-ingress.md` (P3, the inbound half).

---

## 1. What this adds

| Piece | Where |
|---|---|
| Migration `0043` | `app/supabase/migrations/0043_phone_safe_dialer.sql` |
| Dialer, room, recording, purge | `app/api/src/integrations/livekit-phone-dial/` |
| Internal worker endpoints | `app/api/src/routes/phone-worker.ts` |
| Phone voice gate + tools | `app/voice-livekit/phone.py`, `agent.py` |

It does **not** add a scheduler, a loop, or any caller for the dial controller. Arming
that is a later phase's decision, exactly as P3 left `runPhoneReconciliation` uncalled.

> **Superseded by P5.** That later phase has landed: `lib/phone-runtime/` is now the
> production caller for both `dialPhoneAttempt` and `runPhoneReconciliation`. It ships
> disabled. See `phone-runtime.md`.

---

## 2. The switches, and why there are so many

A call reaches a carrier only when **all** of these hold. They are separate on purpose:
each represents a distinct decision, and none is allowed to imply another.

| Switch | Default | Meaning |
|---|---|---|
| `PHONE_SCREENING_ENABLED` | `false` | The domain master switch. |
| `PHONE_RUNTIME_ENABLED` | `false` | Arms workers/timers, independently. |
| `PHONE_DIAL_MODE` | `off` | `off` \| `synthetic` \| `live`. Only `live` can reach a carrier. |
| `PHONE_DIAL_ALLOWLIST` | empty | SHA-256 **digests** of permitted numbers. **Empty is fail-closed** — under `allowlist` scope only. |
| `PHONE_DIAL_SCOPE` | `allowlist` | `allowlist` \| `pipeline`. Which question the pre-claim gate asks. See §2a. |
| `PHONE_SIP_TRUNK_ID` | empty | Provider-neutral trunk. **Empty is fail-closed.** |
| LiveKit credentials | — | Checked independently of the phone flags. |

### 2z. Voice-tuning rollback point — 2026-09-10

The phone worker's voice tuning lives in **Fly secrets**, which SHADOW the
`[env]` values in `fly.phone.toml`. Secrets are opaque — `fly secrets list`
shows only a digest — so the values below are recorded here BECAUSE THEY CANNOT
BE READ BACK. Update this block whenever they change, or the next rollback is a
guess.

| Secret (`project-hello-phone-voice`) | Before 2026-09-10 | Set 2026-09-10 | toml `[env]` (shadowed) |
|---|---|---|---|
| `PHONE_TTS_FLUSH_MIN_CHARS` | `20` | `40` | `60` |
| `PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC` | `1.5` | `1.25` | `2.5` |

**To roll back to the 2026-09-10 pre-change production setup:**

```
fly secrets set PHONE_TTS_FLUSH_MIN_CHARS=20 \
                PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC=1.5 \
                --app project-hello-phone-voice
```

That restarts the worker machines; no deploy and no merge is involved, so it
works even if a code change has since shipped. `PHONE_TTS_FLUSH_MIN_CHARS=0`
is the deeper rollback — it disables the first-fragment early flush entirely
and restores the ~2.9 s LLM-invoke→first-audio floor that four prior PRs were
spent removing, so prefer the table above.

Why these two moved: on the 2026-09-10 live call a word came out cracked at the
first-fragment join. `tts_node` synthesizes the first fragment and the
remainder as SEPARATE Sarvam calls, and at a 20-character cap the split lands
mid-phrase far more often than at 40. The endpointing max is a separate
complaint — the tail a slow speaker gets before their turn is closed.

`PHONE_TTS_PACE` is deliberately NOT set anywhere. The reader exists
(`phone_tts_pace()`, default `1.0`) so it can be applied as a secret, but the
value is unverified against `bulbul:v3`: the reader's `[0.5, 2.0]` clamp was
invented and Sarvam documents `0.3–3.0`, so a rejected synthesis is SILENCE, and
this lane has prior form for Sarvam 400s being swallowed rather than raised.
Apply it as a secret on ONE test call and listen before pinning it in the toml —
no secret shadows that name, so a toml entry ships hot on the next deploy.

### 2y. Conversational gate rollback point — 2026-09-10 (0095)

The identity turn before consent is behind TWO flags, and **both default to the
setup that is live today**, so merging changes nothing until they are set. Unlike
§2z these are `[env]` defaults in code, not secrets, so they CAN be read back —
but the staging order matters, so it is recorded.

| Stage | `PHONE_GATE_FLOW` | `PHONE_DETERMINISTIC_OPENER` | What the candidate hears |
|---|---|---|---|
| 0 (today, and the rollback target) | unset / `deterministic` | unset / `true` | Fixed disclosure → fixed role line → Q1 |
| 1 | `conversational` | unset / `true` | Fixed identity ask → fixed consent → fixed role → Q1 |
| 2 | `conversational` | `false` | Model-authored identity ask, consent and role line, all streamed |

Stage 1 exists on purpose: it proves the new turn ORDER, the identity classifier
and the turn-buffer barrier on a live call **without** switching on
model-authored pre-consent speech. Do not skip it.

**To enable stage 1, then stage 2:**

```
fly secrets set PHONE_GATE_FLOW=conversational --app project-hello-phone-voice
# listen to a call, then:
fly secrets set PHONE_DETERMINISTIC_OPENER=false --app project-hello-phone-voice
```

**To roll all the way back to the 2026-09-10 production setup:**

```
fly secrets unset PHONE_GATE_FLOW PHONE_DETERMINISTIC_OPENER \
                  --app project-hello-phone-voice
```

Unsetting is the true rollback: both readers default to the current behaviour, so
the gate returns to the fixed disclosure with no identity turn and no
pre-consent generation. Secrets-only, so it needs no deploy and no revert, and it
works even if later code has shipped.

A third flag, `PHONE_IDENTITY_MISMATCH_SUPPRESSES`, defaults to **off**. Both
settings post a real purging terminal event; the only difference is whether a
suppression is written:

| Value | Event posted | Recording purged | Engagement | Suppression |
|---|---|---|---|---|
| unset / `false` (default) | `candidate.deferred_pre_disclosure` | yes | deferred to next IST day | none |
| `true` | `candidate.wrong_number` | yes | terminal | **permanent, line-level** |

**Why neither option is "post nothing".** The egress starts at `call.answered`,
*before* consent (0067: "record from answer, keep only if consented"), and the
only thing that destroys that pre-consent audio is the worker posting an event in
`PURGE_BEFORE_EVENTS`. A terminal that posts nothing leaves the recording of
somebody who was never told they were being recorded in the bucket permanently,
*and* leaves the engagement in `dialing` for the lease reaper to restore — so the
same wrong number is dialled again. An earlier draft of this change did exactly
that while believing it was the safer choice.

**Why the default is `false`.** Once the deferral terminal existed, the purge
stopped being an argument for suppressing — both settings destroy the audio. What
is left is evidence, and it is weaker than it looks: the deterministic backstop
that stops a model ending a call on a name the record supports only fires when
`phone_extract_introduced_name` can pull a name out, and that reader matches
"this is X" shapes, **not** a bare "I'm X". So "No, I'm Priya" — the commonest
way a real candidate corrects a mis-heard name — is exactly the shape it misses.
Turn suppression on once the classifier has a live track record; the row it
writes is undoable only with the 0094 release RPC.

### What §2y does NOT cover

`fly secrets unset PHONE_GATE_FLOW PHONE_DETERMINISTIC_OPENER` rolls back **the
gate only**. Three things on this branch ship regardless of any flag and can only
be undone by reverting code:

- the `tts_node` word-boundary back-off (from `3cad63f`);
- `PHONE_TTS_FLUSH_MIN_CHARS = "60"` in `fly.phone.toml` — note a Fly *secret*
  of the same name shadows it, so the live value is the one in §2z;
- `PHONE_OPENING_GATE_SECONDS` 60 → 106 and the `leaseSeconds` default 180 → 240
  (`app/api/src/lib/phone-screening/config.ts`), plus the two call sites that
  carried the old literal (`app/api/.env.example`, `phone-canary1/originate.ts`).
  These size the lease so the identity turn cannot outlive it; they are API-side
  and unaffected by the worker flags. They move the pre-provider refusal
  threshold (`lease_too_short_for_gate`) for **every dial on every deployment**.
  Left at the old values, a conversational-flow call whose gate overruns meets a
  lapsed lease, the first heartbeat answers `lease_lost`, and the agent hangs up
  seconds after the candidate consented;
- `agent.py` — the leak-veto arming (`set_gate_leak_control`) runs on every call
  and reads no flag. It only writes résumé text onto the agent object; nothing
  reads it unless the gate window opens, which needs both flags. Failures are
  swallowed, so a call that armed and one that did not look identical;
- `agent.py` — `run_phone_gate` is now called unconditionally with
  `speak_gate_line=` / `reset_turn_buffer=`, and `_compose_gate_line` is gone. A
  worker running a mismatched `agent.py`/`phone.py` pair is a `TypeError`, and no
  flag undoes that: deploy them together;
- `agent.py` — `_await_output_subscription()` now also runs on the deterministic
  path, so the fixed disclosure pays a bounded wait (8 s default) it did not pay
  before. That is the point — it replaces an UNBOUNDED one — but it is a change
  on the default path;
- `agent.py` — the `voice_phone_participant_to_disclosure_sec` metric now matches
  either disclosure variant, on every call.

### 2a. `PHONE_DIAL_SCOPE` — allowlist or pipeline (0094)

`PHONE_DIAL_ALLOWLIST` was a **bring-up canary**: prove the dialer can only
reach numbers an operator nominated by hand. It answers a question about the
operator's confidence, not about the candidate, and it has three properties
that stop being acceptable once real applicants are in the funnel:

* **Nothing populates it.** Every new candidate needs a manual
  `fly secrets set` plus an API restart before they can ever be called.
* **It truncates silently** past `MAX_DIAL_ALLOWLIST_ENTRIES` (64).
* **Its refusal is invisible.** `dial_not_allowlisted` is a pre-claim
  *deferral*: no attempt row, no state change, no error. A candidate missing
  from the list sits `eligible` for ever and the dashboard shows nothing.

On 2026-09-10 a candidate added to the pipeline at 11:58Z was never dialled
because the secret had last been written at 11:12Z. There was no way to see
this from the product.

**`pipeline` moves the gate to where the facts are.** `admit_phone_attempt` is
the *sole grantor* — a local gate can refuse, it can never admit — and before
it grants a dial it already requires: the application live and not terminal,
the job mapping `enabled`, résumé ingestion `ready`, consent granted,
unexpired and carrying every type the active template requires, a valid Indian
mobile, **not suppressed**, not halted, inside the IST window, past
`next_eligible_at`, within the no-answer budget, one attempt per engagement
per IST day, one per candidate per IST day, under `phone_max_concurrent()`
and under `phone_max_daily_dials()`.

Two things ship with the flag and are what make it safe:

* **The fleet daily cap** (`phone_max_daily_dials()`, 50/IST-day). The
  allowlist's real value was bounding blast radius; this bounds it by volume
  instead of by hand. `phone_max_concurrent()` bounds *simultaneity* — ten at a
  time, all day, is thousands of calls. Raising the cap is a migration, on
  purpose: a bound any operator can raise in a hurry is not a bound.
* **The suppression write path** (`GET/POST/DELETE /api/phone/suppressions/{candidateId}`).
  `phone_suppressions` has been read by admission since 0042 and has had exactly
  one writer in all that time: `apply_phone_event`, which records a
  `candidate_opt_out` / `wrong_number` row when somebody says "don't call me"
  **during a call**. There has never been an operator path, and no way to lift a
  row once written. Under `pipeline` this is the only "never call this person"
  mechanism there is.

  Three things about it are worth knowing before you use it:

  * **It is keyed on the line, not the row.** Two candidates sharing a household
    or reassigned number resolve to one suppression. `GET` reports `owned: false`
    when the promise belongs to the other record, and `DELETE` refuses it with
    `suppressed_by_other_candidate` — a release cannot reach across and destroy
    somebody else's opt-out.
  * **Suppressing also stops a dial already queued.** Admission checks
    suppression at claim time and the dialer does not re-check, so an attempt
    admitted moments earlier would otherwise still ring. The response's
    `dials_stopped` says how many were stopped; a call already connected cannot
    be reached and is not counted.
  * **It survives a number correction.** `verify_candidate_phone` rewrites
    `candidates.phone_e164` with no suppression check, so admission checks the
    **candidate** as well as the digest. Without that, fixing a typo would undo
    an opt-out.

**To cut over:** `fly secrets set PHONE_DIAL_SCOPE=pipeline --app project-hello-api`,
wait for the roll, confirm `dialScope: "pipeline"` on `GET /api/phone/health`.
**To roll back:** unset it, or set it to `allowlist`. The allowlist value is
left untouched by the flag, so rollback needs no secret to be reconstructed.
An unrecognised value reads as `allowlist` — the narrower of the two.

**What `pipeline` does NOT do:** it does not override `PHONE_SCREENING_ENABLED`,
`PHONE_RUNTIME_ENABLED` or `PHONE_DIAL_MODE`, and it does not skip the consent
preflight. It widens the digest comparison and nothing else.

`PHONE_AGENT_NAME` is a sixth, orthogonal knob — see §5.

**`synthetic` cannot place a call, structurally.** It is not "a live client we promise
not to call": `createSyntheticSipClient` contains no reference to the LiveKit SDK at all,
and a structural test asserts that. There is no configuration in which the synthetic path
reaches a carrier — which is what makes the Canary-0 / Canary-1 split meaningful.

---

## 3. The one thing to understand: the disclosure gate

**No audio is captured until the candidate has been told they are being recorded and has
agreed.** That is enforced in the database, not by statement order in a worker:

`attach_phone_attempt_recording` refuses unless the engagement is already `in_call`, and
0042 reaches `in_call` through exactly one transition — `disclosure.delivered`. So a
caller that tries to start an egress at originate, at ring, at join, while unclassified,
on a machine, or after a refusal is refused **before anything records**.

The ordering is deliberately inverted from the obvious one:

1. `attach_phone_attempt_recording` — binds the derived keys and the role. **The gate.**
2. Start the egress.
3. `finalize_phone_attempt_recording` — record the provider's egress id.

Asking first and recording second means a refused binding leaves no audio. The reverse
order records first and asks afterwards. The keys can be bound before the egress exists
because they are *derived* from the attempt id, which is also why a crash between steps 2
and 3 still leaves an enumerable artifact for the purge to find.

---

## 4. The purge is ordered and verified — **not** atomic

This is stated plainly because implementing it as "atomic" would be implementing a lie.
The suppression is a Postgres write; the deletion is object-store calls; no transaction
spans both.

```
1. ENUMERATE   list_phone_engagement_recordings   (authoritative AND supplementary,
                                                   object AND manifest)
2. DELETE      remove each key, then VERIFY absence
3. RECORD      clear_phone_attempt_recordings      (records a deletion; performs none)
4. ACKNOWLEDGE apply_phone_event('disclosure.refused' | 'candidate.opt_out' | ...)
```

**If any step before 4 fails, steps 3 and 4 must not run.** The request stays
unacknowledged and is retried. A terminal state committed over audio we failed to delete
is invisible afterwards — the engagement would look correctly opted out while the
recording sat in the bucket.

Two rules that are easy to get wrong:

- **It enumerates by ENGAGEMENT, not by session.** The session-scoped key names one
  object; a reconnect is a second attempt with its own audio. A purge written against the
  session key alone deletes the first recording, reports success, and leaves the
  reconnect's audio behind. This is why 0043 puts the keys on the attempt.
- **This code writes no suppression.** 0042 already writes it *inside*
  `apply_phone_event`'s transaction (the PR #91 repair). A second writer could only ever
  disagree with the first.

"Nothing to purge" is a **distinct success**, and an *unreadable* enumeration is never
treated as an empty one.

---

## 5. Worker isolation — read before deploying

The existing browser worker registers with **no `agent_name`**, so LiveKit
auto-dispatches it into *every* room in the project.

**Do not name it.** Naming it stops that auto-dispatch for every existing browser
session, and browser screening would silently get no agent in the window between an API
deploy and a worker deploy.

Instead:

- The **existing** worker stays unnamed and additionally **skips phone-marked rooms**
  (matched on both the `phone-<uuid>` room name and `channel: "phone"` in metadata —
  neither marker alone is a single point of failure).
- A **separate** deployment sets `PHONE_AGENT_NAME`, which makes that worker *named*.
  Named workers do not auto-dispatch, so it receives only the phone rooms the API
  explicitly dispatches it into.

**Rollback is "stop, or never deploy, the named phone worker."** It requires no Python
change and no browser redeploy.

With `PHONE_AGENT_NAME` unset, a phone room is created and simply has no agent. That is
correct, not a bug — the alternative is the browser agent talking to an unclassified
caller.

---

## 6. The lease must outlive the originate

`waitUntilAnswered: true` makes the originate **block**, and the SDK's default `timeout`
in that mode is 60 s. That was once *exactly* the default `PHONE_LEASE_SECONDS`; the lease
default is now 180 s (see `phone-runtime.md` §6 for why), so the two no longer coincide.
The hazard was never the coincidence, though — it is that a bound holding a fleet slot
would otherwise be whatever the provider SDK happens to default to.

If the originate outlives its lease, `reclaim_phone_attempt_leases` abandons the attempt
while the dial is still in flight: two calls hold one fleet slot, and the engagement has
already been restored to its prior state. Nothing else notices, because P3's
reconciliation sweep deliberately leaves *held* leases alone.

So the dial controller **extends the lease to cover the worst-case originate, and refuses
before touching the SDK if it cannot** — including when the heartbeat succeeds but 0042's
900 s clamp returns less than we asked for. "We asked for enough" is not "we have
enough".

Keep `PHONE_ORIGINATE_TIMEOUT_SECONDS` (default **60**, bounded 5–90) well below
`PHONE_LEASE_SECONDS` (default **180**, bounded 5–900). The originate default was
documented here as 30 for a while; `PHONE_DIAL_BOUNDS.originateTimeoutSeconds` has always
read `def: 60`, and 60 is what `.env.example` ships.

---

## 7. `abandoned_pre_disclosure`

0042 had no legal edge for a candidate who **answers and hangs up before the
disclosure** — it surfaced as `unexpected_event`, so the outcome was *unrecorded* rather
than classified. Both easy answers were lies: `no_answer` after someone demonstrably
picked up, or an "uncharged reconnect", which is not a thing.

0043 adds a truthful outcome that **charges nothing** — no no-answer, reconnect or
provider budget — returns the engagement to `eligible`, and is bounded by the
*already-existing* `uq_phone_attempts_one_per_ist_day` index rather than by a new
counter. A gating counter with no reset lifecycle is a one-way latch; the IST day
supplies the lifecycle for free.

It is gated on the **attempt** state (`answered_unclassified` / `human`), not the
engagement state, because `dialing` outlives the answer. An unanswered drop still falls
through to `unexpected_event`, unchanged.

`candidate.deferred_pre_disclosure` shares the branch: the candidate answered and asked
to be called back *before* the disclosure. It is a distinct event type rather than a
reused `sip.participant_left` because saying "the participant left" about someone still
holding the handset would be false, and the ledger is where an operator goes to find out
what actually happened.

---

## 8. The scheduling tool must never confirm an unbooked slot

`schedule_phone_appointment` refuses outright while the engagement is `dialing`
(`attempt_in_flight`) — a live dial owns the engagement. But "call me later" is *most
likely* said during the identity/disclosure exchange, i.e. exactly while `dialing`.

So `POST /api/internal/phone/appointments` first ends the attempt truthfully and
uncharged via `candidate.deferred_pre_disclosure`, then books from a legal state.

**The worker speaks a confirmation only on `ok` / `ok_prereqs_pending`.** Every other
status — including `unknown_status`, which means we never got an answer we understand —
is returned as `ok: false` and spoken as a distinct refusal. Confirming a booking that
did not happen is the worst possible outcome on a call whose purpose is to be truthful.

The server revalidates the 09:00–21:00 IST window and not-in-the-past; the worker only
proposes. An LLM-driven caller is exactly the client that will confidently propose 03:00.

---

## 9. Enabling, in order

> **UPDATED BY P4b — the §12 block is lifted** (merged as `ee09ae1`, PR #98, migration
> `0044`; see `phone-assessment-resume.md`). Two statements this banner used to make are
> no longer true. The phone lane now persists a session-scoped question plan, an ordered
> transcript and a cursor through `start_phone_assessment` and
> `commit_phone_question_boundary`, so **a reconnect asks the next unfinished key and
> never re-asks a committed one**; and a completed phone screening now **produces a real
> scored assessment row** — `/assessment/complete` awaits `runAssessment` and verifies
> the row before anything claims a completion.
>
> **Steps 1–5 are still safe; step 6 still places a call to a real person**, and it is
> still the step to take deliberately rather than by following a list. What gated it has
> changed from a block into an interlock: **P4b must be deployed with P4a.** Apply `0044`
> and deploy the P4b worker before step 6 — on P4a alone the conversation is recorded and
> scored for nothing, which is exactly what the old block existed to prevent
> (`phone-assessment-resume.md` §8).
>
> This warning exists because the rest of this section reads like a green light, and an
> operator following it at 3am would not think to cross-check §12.

1. Deploy with everything off. Confirm `/api/phone/health` reports the domain disabled.
2. Set `PHONE_SCREENING_ENABLED=true`, leave the rest off. No dial is possible.
3. Provision `PHONE_SIP_TRUNK_ID`. Still no dial — the mode is `off`.
4. `PHONE_DIAL_MODE=synthetic` and `PHONE_RUNTIME_ENABLED=true`. Rehearse. **Structurally
   cannot reach a carrier.**
5. Deploy the named phone worker with `PHONE_AGENT_NAME` set. Verify browser screening is
   unaffected (it must be — the browser worker was not touched).
6. **The first step that can reach a carrier.** Adding a digest to
   `PHONE_DIAL_ALLOWLIST` and setting `PHONE_DIAL_MODE=live` reaches exactly one number.
   §12 is closed, so a candidate answering it is now screened and scored — **provided the
   deployment carries P4b**. Take this step only where `0044` is applied and the P4b
   worker is deployed (`phone-assessment-resume.md` §8). On a P4a-only deployment it is a
   transport rehearsal against a number you control, never a screening.

Note also that `failed` / `assessment_aborted` is **no longer the outcome of every phone
conversation** — that was P4a's truthful-but-useless terminal and P4b replaced it. A
finished screening now reaches `completed`, and it can only get there through a verified
assessment row: `apply_phone_event` refuses `assessment.completed` with
`assessment_missing` unless a phone-sourced row already exists, so the completion claim is
enforced in SQL rather than by worker ordering. `failed` / `assessment_aborted` now means
what it says — a call that produced nothing scorable, or a named scoring failure that
survived three bounded retries (`phone-assessment-resume.md` §4 and §7). It is worth
investigating rather than expected.

Kill switch at any point: `POST /api/phone/halt`. It refuses admission, which refuses
every dial.

---

## 10. Known residuals

- **Terminal reasons for phone disconnects are bucketed as `provider_error`.** A
  candidate rejecting a call is not a provider error. Making it truthful requires
  widening both `chk_call_sessions_terminal_reason` and `persistence._FAILED_REASONS`
  together; that pair was left alone deliberately rather than half-done. Blast radius is
  an operator-facing label on `call_sessions` — no budget is affected.
- **The default human/machine classifier is a deterministic rule set behind an injectable
  seam.** An unreadable answer is re-asked once and then fails closed to `machine`, which
  costs a no-answer budget charge for a mumbling human. The direction is safe (no consent
  → no recording, no score) but the mis-classification risk is real.
- **The worker always sends a null epoch.** The phone room name carries only the attempt
  id; P3 projects `phone_epoch` at the ingress boundary. Both the client and the gate
  accept an epoch, so wiring it is a one-line change once there is a worker-visible
  source.
- ~~**No scheduler is armed.** `dialPhoneAttempt` has no production caller.~~
  **CLOSED by P5** — `lib/phone-runtime/` is that caller, and it ships disabled. See
  `phone-runtime.md`.
- **A purge takes two passes when an egress is live.** The first stops the egress and
  refuses; the retry deletes. That is deliberate — LiveKit uploads asynchronously *after*
  the stop is accepted, so deleting in the same pass would race the upload exactly as
  before the fix — but it means a terminal refusal is acknowledged one retry later than
  the happy path. `/api/internal/phone/events` answers **503** on that pass, which the
  worker retries. Nothing else is armed to drive it.
- **`abandoned_pre_disclosure` is bounded per IST day, not overall.** A candidate who
  hangs up during the identity line every morning is re-dialled each day. The per-day
  index is the accepted bound; recorded so the choice is deliberate rather than assumed.

---

## 11. The mutation controls, and how to re-run them

Every safety guard below was deliberately broken, the suite run, and the failure
recorded — then reverted and re-run green. **If deleting a guard leaves its suite
green, the guard is decorative.** This lane has shipped a green suite around a real
defect more than once, which is why these are mandatory rather than nice to have.

They are recorded here rather than shipped as a script: a script that edits source and
reverts with `git checkout` will silently destroy uncommitted work if anyone runs it on
a dirty tree. Re-run them by hand, on a **clean** tree, one at a time.

| # | Break this | Suite | Expect |
|---|---|---|---|
| M1 | The `attached.status !== 'ok'` refusal in `recording.ts` | `phone-recording` | 9 fail |
| M2 | The `role === undefined` refusal in `recording.ts` | `phone-recording` | 4 fail |
| M3 | Drop supplementary rows / manifest keys in `artifactKeys` | `phone-recording-purge` | 12 fail |
| M4 | Force `safeToAcknowledge: true` everywhere | `phone-recording-purge` | 13 fail |
| M5 | Make the booking branch unconditional in `phone-worker.ts` | `phone-worker-route` | 13 fail |
| M6 | Replace `z.enum(WORKER_PHONE_EVENTS)` with `z.string()` | `phone-worker-route` | 4 fail |
| M7 | Skip the `leaseOutlivesOriginate` gate | `phone-dial-controller` | 9 fail |
| M8 | Skip the purge before a terminal refusal | `phone-worker-route` | 12 fail |
| M9 | Ignore an `active` egress in the purge | `phone-recording-purge` | 5 fail |
| M10 | Remove the ring-vs-originate ordering gate | `phone-dial-controller` | 2 fail |
| P1 | Start the recording before classification (Python) | `test_phone_gate` | 9 fail |
| P2 | Let a machine-classified call score (Python) | `test_phone_gate` | 5 fail |
| P3 | Confirm a booking before the server answers (Python) | `test_phone_gate` | 7 fail |
| P4 | Accept `ignored` as consent (Python) | `test_phone_gate` | 11 fail |

**M8 is the one to understand.** Before the purge had a production caller it could not
have failed *any* suite — the independent review caught exactly that. A mutation control
proves nothing about code nothing calls, so a control that stays green is a question
about the wiring, not a reassurance about the guard.

---

## 12. UNMET CONTRACT ITEM — phone-side transcript, cursor and assessment

> **CLOSED by P4b (migration `0044`, `docs/runbooks/phone-assessment-resume.md`).**
> The section below is kept verbatim as the record of what was true at `620c702`
> and of the decision the owner was asked to make. Two of its statements are no
> longer true: a reconnect no longer re-asks every question, and a finished phone
> screening now yields a transcript and an assessment. The third — *"do not fix
> the `failed` terminal by restoring `assessment.completed`"* — is now enforced
> in SQL rather than by convention: `apply_phone_event` refuses that event with
> `assessment_missing` unless a phone-sourced assessment row already exists.
>
> **The activation interlock still stands.** P4b must be deployed with P4a
> before a real candidate is dialled; see §9 and the P4b runbook.

**This is a scope gap, not a residual, and it is disclosed here because I did not
disclose it earlier.** The acceptance contract asks for two things this PR does not
deliver, and both were in scope (`voice-livekit Python/prompt/tools/tests` is explicitly
allowed).

**What the contract asks**

- Item 6: *"Same session/transcript/current_question_index; new attempt/epoch/participant"*
- The human path: *"...then and only then start attempt egress, store exact
  object/manifest keys+role, **activate assessment**/in_call"*

**What is actually true at `620c702`** — verified, not recalled:

| Claim | State |
|---|---|
| Same **session** across reconnects | **Met.** The room is session-keyed, a reconnect adopts it, and the engagement's `session_id` is stable. |
| Same **transcript** | **NOT met.** `_run_phone_session` makes **zero** `persistence.*` calls — no `save_turn`. The phone path persists no turns at all. |
| Same **`current_question_index`** | **NOT met.** `current_question_index` has **zero** non-test readers or writers anywhere in `app/api/src` or `app/voice-livekit`. |
| **Activate assessment** | **NOT met.** No `activate_session`, no `complete_session`, no `trigger_scoring`. The session posts `assessment.completed` to 0042 — so the ENGAGEMENT reaches `completed` — while nothing is scored. |

**Consequences, stated plainly**

1. A reconnect leg starts with a fresh `AgentSession` and no prior `ChatContext`, so it
   **re-asks every question**. There is no artifact — cursor or persisted transcript —
   from which "already answered" could be derived, so this cannot be fixed by a test or a
   small patch; it needs the persistence path built.
2. A finished phone screening yields **no transcript row and no assessment**. It no
   longer *claims* one: the path posts `assessment.aborted`, so the engagement lands on
   terminal `failed` with reason `assessment_aborted` rather than on `completed`.
   That is deliberate and it is the truthful state — the conversation happened and
   produced nothing. **Every phone engagement will therefore terminate as `failed`
   until the persistence path lands**, which is correct but will look alarming on an
   operator dashboard; do not "fix" it by restoring `assessment.completed`.

**Why it is not repaired in this PR.** Building it means adding phone-side turn
persistence, session activation and a resume path — through `sessions` and
`transcript_turns`, the same write paths the **browser** uses. That is a materially
larger change than the gate this PR is about, it is unreviewed and untested territory,
and it lands on a branch that is otherwise green with every blocker repaired. Doing it
quietly at the end of a long session, on a shared write path, is exactly how a browser
regression gets introduced.

**This is the owner's call, not mine.** The options are:

- **(a) Ship P4 as the gate it is**, with this recorded as an explicit unmet item, and
  build transcript/cursor/assessment as its own PR with its own review. Nothing about the
  safety properties changes: consent still gates recording, a machine still scores
  nothing — because nothing scores at all.
- **(b) Hold P4** until the persistence path is added here.

**The safety direction is intact either way.** The failure is that a phone screening is
currently *incomplete*, not that it is *unsafe*: no audio is captured without consent, no
machine is scored, no budget is mis-charged. But a phone screening that records the
candidate and then scores nothing is not a finished feature, and calling P4 done without
saying so would be the same class of error as claiming a repair I had not made.
