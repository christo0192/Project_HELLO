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

### 2z. Voice-tuning rollback point — rewritten 2026-10-08 (M014)

**Verified 2026-10-08:** `fly secrets list -a project-hello-phone-voice` shows
**no** secret for any voice-tuning name below, and the deployed `fly config show`
`[env]` equals `fly.phone.toml` `[env]` (zero differences). The 2026-09-10 table
that used to be here (secrets `1.25` / `40`, toml `2.5` / `60`) was stale and has
been removed: the toml pins ARE the live values. Do not create a secret for these
names; change `fly.phone.toml` and deploy. (A Fly secret of the same name would
SHADOW the toml value. `PHONE_OBJECTIVE_PREEMPTIVE` and `PHONE_TURN_MODE` ARE
shadowed by secrets whose values cannot be read back; they are out of scope here.)

| Variable (`fly.phone.toml` `[env]`) | Live value | Rollback |
|---|---|---|
| `PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC` | `0.3` (reader clamp 0.3-0.5) | n/a |
| `PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC` | `2.0` (was `1.0` until M014; clamp 0.5-3.0) | `1.0` |
| `PHONE_OPEN_ANSWER_MIN_DELAY_SEC` | `0.8` (clamp 0.3-1.2, never above the max) | `0.3` makes the per-question minimum a no-op |
| `PHONE_CONSENT_ENDPOINTING_MAX_DELAY_SEC` | unset, code default `0.5` (consent turn only) | n/a |
| `PHONE_TTS_FLUSH_MIN_CHARS` | `35` (unchanged by M014) | `0` is the deep rollback (below) |

**M014 (2026-10-08): what the endpointing change does.** Sarvam is finals-only
and delivers a final 0.9-1.0 s after the candidate stops, so the SDK used to start
(or resume) the bot's reply on 0.15-0.25 s of quiet, long before the candidate's
words existed. Two changes:

1. MAX `1.0` -> `2.0`. It costs up to +1.0 s only on a turn the end-of-utterance
   model scores incomplete (a bare "yes" can score incomplete), on SCREENING turns
   only. The identity / pickup / consent gate keeps its decision timing: the
   session STARTS at the gate max (`min(PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC, 1.0)`,
   `phone_gate_endpointing_max_delay`), the consent turn tightens to `0.5` and
   restores to that gate max, and the screening max (`2.0`) is applied only when
   the screening phase is armed (`_arm_screening_endpointing_max` in `agent.py`,
   logged as `phone_screening_endpointing` `raised`). The gate's turn-settle (how
   long finals the SDK never committed wait before the gate closes the turn) is
   sized from the gate max, so it is unchanged (1250 ms).
2. Per-question MIN: while the bot waits for an OPEN answer (what / how / tell me,
   candidate Q&A, resume conflict, patience) the minimum is `0.8`. The SDK's
   reply-start gate is `min / 2` of quiet, but the deployed Silero VAD ends speech
   after 0.25 s of silence and the SDK then releases the gate regardless, so the
   **effective gain is about 0.1 s (the gate moves from 0.15 s to about 0.25 s),
   not 0.4 s.** A longer gate needs a longer VAD `min_silence_duration`, a VAD
   change that also touches the consent gate and barge-in; it is an owner
   decision and is NOT part of this change. Yes/no screening questions,
   name confirm, callback and every terminal phase keep `0.3`, and the identity,
   pickup and consent turns are never changed (the minimum is applied only once
   the screening phase is armed). The class is read from the reply snapshot (the
   question the reply asks) when that reply STARTS PLAYING (the session's
   `speaking` state, bound to the reply's own speech handle), never earlier, so
   the reply to an answer is still gated by that answer's own class, and only
   when the class actually changes. A reply with no phase keeps the current
   class. The first planned question is a spoken line,
   so its class is applied once it has been heard. Fixed-local endpointing only:
   the opt-in dynamic mode and `PHONE_TURN_DETECTION=stt` are not touched. A
   failed update is logged and swallowed; the call carries on with the previous
   minimum.

**Turns that inherit the 2.0 max.** After the screening phase is armed EVERY turn
runs at max 2.0, including turns whose minimum stays `0.3`: yes/no screening
questions, name confirm, callback, and the consent-withdrawal / revocation
confirm ("do you want to stop?" -> "yes"). A bare "yes"/"no" the end-of-utterance
model scores incomplete can therefore wait up to +1.0 s more than before M014.
This is the accepted cost (owner decision 2026-10-09); a later change could pair
the short class with a lower max. The opt-in dynamic mode is built at the gate
max (1.0) and is not raised. Known edges: a yes/no question that follows an open
answer drops the minimum back to 0.3 as soon as it starts playing (a candidate
who keeps talking over it gets the short gate); the `wind_down` "any questions?"
line is deliberately OPEN.

This change never delays or drops a reply; the next step for the finals-latency
problem is streaming STT, not more waiting.

**Rollbacks.** Edit `fly.phone.toml` and deploy (the normal path). In an
emergency, with no deploy:

```
fly secrets set PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC=1.0 \
                PHONE_OPEN_ANSWER_MIN_DELAY_SEC=0.3 \
                --app project-hello-phone-voice
```

That restarts the worker machines. **Unset the secrets afterwards**
(`fly secrets unset NAME ... --app project-hello-phone-voice`) once the toml is
changed and deployed, or the toml stays documentation. `PHONE_TTS_FLUSH_MIN_CHARS=0`
disables the first-fragment early flush entirely and restores the ~2.9 s
LLM-invoke-to-first-audio floor that four prior PRs were spent removing.

**Logs to watch after an endpointing deploy (categories and timings only; never
text):**

- First call after the deploy: `phone_turn_detection` `duration_sec=1.0` (the max
  the session is CONSTRUCTED with: the gate max) followed, after consent, by
  `phone_screening_endpointing` `schema=raised` `duration_sec=2.0` (the screening
  max actually applied). A missing `raised` line, or `raise_failed`, means the
  screening runs at the old 1.0 max; a `duration_sec` other than the above means a
  Fly secret is shadowing the toml (`fly secrets list` shows names only).
- `phone_endpointing_phase`: `open` | `short` (`duration_sec` = the minimum
  applied, `phase`), `apply_failed`.
- The headline latency (alarm: median candidate-stop to bot-audio above 3.2 s);
  the nightly talk-over rate (target 0).

**Historical (2026-09-10, SUPERSEDED, kept for the audit trail).** The previous
rollback point recorded two voice-tuning values that had been set by hand as Fly
secrets (secrets are opaque; `fly secrets list` shows names and digests only):

| Secret (`project-hello-phone-voice`) | Before 2026-09-10 | Set 2026-09-10 | toml `[env]` (shadowed) |
|---|---|---|---|
| `PHONE_TTS_FLUSH_MIN_CHARS` | `20` | `40` | `60` |
| `PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC` | `1.5` | `1.25` | `2.5` |

Evidence for superseding it: on 2026-10-08 `fly secrets list` showed none of the
voice-tuning names, and `fly config show` `[env]` matched `fly.phone.toml`. Re-run
`fly secrets list -a project-hello-phone-voice` as a pre-deploy check; if any of
the names in the table above appears, unset it AFTER the deploy.

`PHONE_TTS_PACE` is deliberately NOT set anywhere. The reader exists
(`phone_tts_pace()`, default `1.0`) so it can be applied as a secret, but the
value is unverified against `bulbul:v3`: the reader's `[0.5, 2.0]` clamp was
invented and Sarvam documents `0.3–3.0`, so a rejected synthesis is SILENCE, and
this lane has prior form for Sarvam 400s being swallowed rather than raised.
Apply it as a secret on ONE test call and listen before pinning it in the toml —
no secret shadows that name, so a toml entry ships hot on the next deploy.

### 2x. Gate judge, consent backstop and opening — M013 S01

The gate (identity → consent → role line → Q1) now reads replies with an LLM
judge, **DeepSeek V4 Flash** (owner decision), behind one switch. Every row
below is an `[env]` value or a code default. A Fly secret of the same name
overrides it, so each rollback is `fly secrets set …` with no deploy; unset the
secret again afterwards so the repo shows the live value.

| Variable | Shipped (fly.phone.toml / code default) | What it does | Rollback |
|---|---|---|---|
| `PHONE_GATE_JUDGE` | `llm` / `legacy` | `legacy`: the regex rules decide and the judge is never called. `shadow`: the regex rules decide; the judge runs on the same reply and only logs. `llm`: a valid judge verdict decides; the regex decides only when the judge is unavailable | `PHONE_GATE_JUDGE=legacy` |
| `PHONE_GATE_JUDGE_MODEL` | `deepseek-v4-flash` | The judge model id. A non-DeepSeek id disables the judge (legacy decides) | Swap the id, e.g. `deepseek-flash` |
| `PHONE_GATE_JUDGE_TIMEOUT_SEC` | `1.7` (clamp 1.0–4.0) | Judge wall clock for identity, consent and callback time | Raise it |
| `PHONE_QNA_JUDGE_TIMEOUT_SEC` | `1.6` (clamp 0.8–3.0) | Judge wall clock after consent (revocation window, Q&A close) | Raise it |
| `PHONE_GATE_GRANT_MIN_SPEECH_MS` | default `250` (clamp 120–600) | A judge grant needs this much VAD speech behind its evidence | Recalibrate from logged `segment_speech_ms` |
| `PHONE_GATE_COMPOSE_TIMEOUT_SEC` | default `1.5` (clamp 0.5–4.0) | Cap on composing one gate line; a miss speaks the fixed line | `4.0` (the old cap) |
| `PHONE_Q1_PRERENDER` | default `true` | Q1 audio is pre-rendered under the role line | `false` |
| `PHONE_DETERMINISTIC_OPENER` | default `false` (composed openings) | `true` speaks the fixed scripted lines | `PHONE_DETERMINISTIC_OPENER=true` |
| `PHONE_GATE_MAX_SECONDS` | default `180` | Gate wall clock; the lease heartbeat now runs from the answer and a budget is checked before every new ask | `116` (the old value), but ONLY together with `PHONE_GATE_JUDGE=legacy` or `shadow` (consent backstop 50.4 s). In `llm` mode the backstop is 137.3 s and 116 gives a budget deadline 106 s after the answer, so consenting candidates who need a re-ask or ask a question back are deferred; keep it at or above ~150 in `llm` mode |
| `PHONE_CLASSIFY_TIMEOUT_SEC` | not set; derived 137.3 s as shipped (`llm`), 50.4 s in `legacy`/`shadow` | Consent backstop: in `llm` mode 3 × (answer window + 2 × 6 + 3 × judge timeout + 2 × 6 s quiescence) + 5; in `legacy`/`shadow` 2 × (answer window + 6 + judge timeout) + 5; an explicit value can only raise it. The gate budget (`PHONE_GATE_MAX_SECONDS`) still caps it | Set a higher value |

**Why `llm` is the default.** `llm` ships by the owner's explicit decision of
2026-10-06: the LLM judge decides consent and the other gate turns, and the
regex rules decide only when the judge is unavailable (error, timeout, bad
JSON, breaker open, judge disabled). A judge error never grants by itself. The
code default (variable unset) stays `legacy`. The trade-off, from the T11 bank
(`.gsd/milestones/M013/slices/S01/S01-BANK.md`), recorded as measured:
- **False grants:** the judge made **0** on the 32 real consent items; the regex
  made **2** (and 9 on the synthetic bank).
- **Recall:** the judge granted **16 of 17** real consenting replies; the regex
  granted **17 of 17**. So `llm` fails the plan's "recall ≥ legacy" rule, and
  the owner accepted that.
- **The one miss** (13921f1f:11) is unstable (the judge granted it 4 times in 5
  repeat calls) and is a reply to the retired "I just need a yes or a no"
  re-ask, which this release no longer speaks. Its cost is one extra re-ask, not
  a lost call.

Rollback, no deploy: `fly secrets set PHONE_GATE_JUDGE=legacy -a project-hello-phone-voice`
(the regex decides and the judge is never called). `PHONE_GATE_JUDGE=shadow`
is the halfway step: the regex decides and the judge only logs. Unset the
secret again once the repo shows the value you want.

**Consent rules (owner constraints):**
- In every mode (`legacy`, `shadow`, `llm`) a regex grant needs speech that
  started at or after the recording sentence: a "yes" said over the first half
  of the consent line is never consent (log `phone_gate_turn_barrier` /
  `legacy_grant_before_recording_anchor`); the bot listens about 3 s more,
  then re-asks.
- In `llm` mode a judge error (timeout, transport error, bad JSON, breaker
  open, judge disabled) **never grants**. The regex rules decide instead and
  may grant, under the same recording-sentence rule.
- In `llm` mode a judged opt-out, wrong person or decline must quote the
  candidate's own words spoken after the question, or it is `unclear` (a
  re-ask), never a suppression.
- A valid judge verdict that is not a grant (no, busy, question, unclear) is
  never overridden by the regex.
- A judge grant that fails a deterministic guard (evidence not in the
  candidate's words, started before the recording sentence, too little speech,
  candidate still talking) is a re-ask, never a regex fallback.
- The AI-disclosure wording is unchanged and pinned by
  `tests/test_phone_disclosure_pinned.py`.

**The "a person spoke" rule (`candidate_spoke`, all modes).** Once a reply that
is not voicemail wording is heard, the call can no longer end as `machine`.
Words a reader skipped (said before the question, or over the consent line)
count too, but only weakly: they turn a silent ending into the deferral, while
voicemail wording heard afterwards still makes it `machine`.
Voicemail wording, silence or an unreadable reply after that ends with the
deferral goodbye ("Sorry, I'll let you go for now. Our team will call you
another time. Bye!") and `candidate.deferred_pre_disclosure` (uncharged, next IST
day). `machine` means nobody was heard, or the first words were voicemail or
carrier wording. Busy, "call me later" and "abhi nahi" go to the callback flow,
never to a yes/no re-ask. S01 posts only existing events and never stops or
purges a recording itself; what happens to the audio is S02's (the recording
flag), not this section's.

**Logs to watch (categories, lengths and timings only; never text).** The
structured logger only accepts its allowlisted keys, so the fields are:
- `phone_gate_decision`: one per decision that acted. `phase` = the gate
  phase (`identity`, `consent`, `post_consent`, ...); `model` = the judge
  model id; `error_category` =
  `<source>.<intent>` (source `llm` / `legacy_fallback` / `legacy`, e.g.
  `llm.consent_granted`); `duration_sec` = judge latency; `rejection_reason` =
  the guard that turned a judge verdict into `unclear` (`before_recording_anchor`,
  `speech_too_short`, `not_quiescent`, `evidence_not_post_question`,
  `voicemail_not_machine_shaped` (a judged voicemail at identity/consent whose
  cited words do not read as a machine: a re-ask or a deferral, never a
  silent hang-up), ...) or
  `err.<category>` for a judge failure; `turn_index` = the evidence utterance;
  `option_count` = utterances shown; `schema` = packed
  `pv:<prompt version>_el:<evidence len>_nt:<tagged>_ac:<speech ms>_cf:<confidence>_rj:<re-judges>`.
  Query `rejection_reason`, not `guard_rejected_reason` or `latency_ms`
  (those names are internal and never logged).
- `phone_gate_shadow_decision` and `phone_gate_shadow` (`agree` / `disagree` /
  `judge_unavailable`): what the judge would have done in `shadow` (only after
  a rollback to `shadow`; `llm` logs `phone_gate_decision` instead).
- `gate_judge_fallback_legacy` (with the reason) and `gate_judge_disabled`
  (once per process). **Alias-retirement risk:** if the provider retires
  `deepseek-v4-flash`, every call falls back to legacy. A rising
  `gate_judge_fallback_legacy` rate is the signal; swap `PHONE_GATE_JUDGE_MODEL`.
- `phone_gate_compose` (`composed_ok` / `timeout` / `rejected_<reason>` /
  `unavailable`; `schema` = the line, `duration_sec` = compose time),
  `phone_q1_prefetch` (`duration_sec` = the wait for Q1 after the role line),
  `phone_gate_budget`, `phone_gate_heartbeat`, the `gate_lease_halted` outcome,
  and `consent_turn_skipped` (a reply read as belonging to an earlier question).
- `phone_gate_turn_barrier`: `consent_turn_skipped`, `consent_turn_not_grant_evidence`
  and `legacy_grant_before_recording_anchor` (with `phase` = the tag and
  `schema` = signed ms deltas); `phone_gate_quiescence` (a judge grant waiting
  for the candidate to stop talking); `phone_gate_final` (`paired`,
  `paired_chained`, `open_segment`, `shared_segment`, `no_segment`, with
  `duration_sec` = the longest paired VAD segment).
- `phone_callback_judge` (`spans_not_in_reply`, `spans_disagree`,
  `resolved_match` / `resolved_mismatch`) and `phone_callback_turn`.
- After consent: `phone_revocation_window` (busy, decline or opt-out spoken
  before Q1 is answered; `shadow_<intent>` in shadow mode) and its per-call
  `phone_gate_decision` / `phone_gate_shadow_decision` lines (phase
  `post_consent`).
- The Q&A close: `phone_qna_close` (`judged_<kind>`, `judged_other_question_shape`,
  `judged_decline_question_shape`, `judge_unavailable`,
  `fallback_other_answered`, `go_ahead`, `non_question_acknowledged`,
  `non_question_close`, `filler_cap_close`, `after_close_question_shape` (a
  turn after the goodbye was authored reopened on its question shape; the
  `*_question_shape` overrides are only logged in the open Q&A, a turn read
  after the goodbye logs its plain `judged_<kind>`); `phase` = who decided THIS turn:
  `judge` (a valid `qna_close` verdict), `fallback` (the fallback grammar:
  `legacy`/`shadow`, or the judge unavailable) or `rule` (the bare-yes
  go-ahead and the filler cap, which no reader decides)),
  `phone_qna_close_judge` (the `qna_close` judge's own lines),
  `phone_qna_terminal_interlock` (`pending_close_cancelled`: a late question
  reopened Q&A over an unplayed goodbye; `late_question_after_goodbye_dropped`:
  a question judged while the goodbye finished, when the once-per-call late
  answer was no longer available), `phone_qna_late_question` and
  `phone_silence` (`qna_silence_nudge`, `qna_silence_close`). A bare "yes"
  gets "Sure, go ahead."; a decline closes on the first one; silence after the
  invite or the go-ahead gets one "Are you still there?", then completes;
  silence after a decline or an answer completes.

**What the switches do NOT undo.** `PHONE_GATE_JUDGE=legacy` stops every judge
call (identity, consent, revocation window, Q&A close) and
`PHONE_DETERMINISTIC_OPENER=true` restores the scripted lines, but the Q&A
closing changes have **no runtime switch**: the wider decline grammar (closes
on the first "No, I don't have any questions"), the one-nudge-then-complete
silence close, the filler/go-ahead cap and the fallback that answers every
other Q&A turn. So do the turn-barrier changes (capture of finals the SDK
dropped, the recording-sentence rule, the "a person spoke" deferral). Undoing
those needs a revert and a redeploy of the previous image.

### 2y. Conversational gate rollback point — 2026-09-10 (0095)

The identity turn before consent is behind TWO flags, and **both default to the
setup that is live today**, so merging changes nothing until they are set. Unlike
§2z these are `[env]` defaults in code, not secrets, so they CAN be read back —
but the staging order matters, so it is recorded.

> **Superseded default (#334, M013 S01).** `PHONE_DETERMINISTIC_OPENER` now
> defaults to **false**: an unset value gives composed (model-authored,
> validated-before-speech) openings, not scripted ones. The table below is the
> 2026-09-10 history. Today the scripted rollback must be SET, not unset:
> `fly secrets set PHONE_DETERMINISTIC_OPENER=true --app project-hello-phone-voice`.
> See §2x.

| Stage | `PHONE_GATE_FLOW` | `PHONE_DETERMINISTIC_OPENER` | What the candidate hears |
|---|---|---|---|
| 0 (2026-09-10; the rollback target) | unset / `deterministic` | `true` (was the unset default then) | Fixed disclosure → fixed role line → Q1 |
| 1 | `conversational` | `true` (was the unset default then) | Fixed identity ask → fixed consent → fixed role → Q1 |
| 2 | `conversational` | `false` (unset today) | Model-authored identity ask, consent and role line, all streamed |

Stage 1 exists on purpose: it proves the new turn ORDER, the identity classifier
and the turn-buffer barrier on a live call **without** switching on
model-authored pre-consent speech. Do not skip it.

**Both stages ran clean on live owner-test calls 2026-09-11** (candidate Christo
Kingson): each reached `disclosure.delivered`, the model-authored copy kept
recording and the job out of the identity turn, and Christy introduced herself
exactly once. PRODUCTION now runs stage 2 by secret.

The code DEFAULTS deliberately stay at stage 0. A flip was drafted and dropped
on review: it gains nothing production does not already have, and costs two
things — a mistyped rollback token would fail OPEN (`determinstic` selects the
conversational gate), and a fresh or rebuilt deployment would speak
model-authored copy before consent with nothing configured. `fly secrets unset`
therefore remains a true rollback.

(A third reason given when the flip was dropped — "no test exercises `agent.py`
with the conversational gate on" — no longer holds:
`TestDroppedLegOnTheConversationalGate` and `TestUnsetEnvSelectsTheScriptedGate`
now drive `_run_phone_session` on both sides of the flag. The first two reasons
stand on their own.)

**To enable stage 1, then stage 2:**

```
fly secrets set PHONE_GATE_FLOW=conversational --app project-hello-phone-voice
# listen to a call, then:
fly secrets set PHONE_DETERMINISTIC_OPENER=false --app project-hello-phone-voice
```

**To roll all the way back to the 2026-09-10 production setup:**

```
fly secrets unset PHONE_GATE_FLOW --app project-hello-phone-voice
fly secrets set PHONE_DETERMINISTIC_OPENER=true --app project-hello-phone-voice
```

Since #334 unsetting `PHONE_DETERMINISTIC_OPENER` is **not** a rollback: its
default is now `false` (composed openings). Set it to `true` explicitly. With
`PHONE_GATE_FLOW` unset and the opener `true`, the gate returns to the fixed
disclosure with no identity turn and no pre-consent generation by the main
model. The gate judge (`PHONE_GATE_JUDGE=llm`, as shipped, or `shadow`) still
sends candidate replies to DeepSeek, verbatim and unscrubbed, with the bot's
own line and the candidate's first name only: the identity reply, the consent
replies, the callback-time replies, every post-consent reply until Q1 is
answered (the revocation window) and every Q&A-phase reply (the Q&A close
judge); `shadow` sends the same replies and only logs the verdicts. Set `PHONE_GATE_JUDGE=legacy` as well to stop all of
that. Secrets-only, so
it needs no deploy and no revert, and it works even if later code has shipped.

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
  `speak_gate_line=` / `mark_question_asked=`, and `_compose_gate_line` is gone. A
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
- **The human/machine and consent reader is the gate judge with a deterministic fallback
  (M013 S01, §2x).** With `PHONE_GATE_JUDGE=llm` a valid DeepSeek V4 Flash verdict decides;
  when the judge is unavailable the deterministic rule set (`classify_answer_text`, the
  code default under `legacy`, and the deciding reader under `shadow`) decides, and it may
  grant consent only on speech that started after the recording sentence. A judge error
  never grants by itself. The `candidate_spoke` rule applies in every mode: once a person
  was heard the call can no longer end as `machine`, and an unreadable answer is re-asked
  and then ends with the spoken deferral goodbye and `candidate.deferred_pre_disclosure`
  (uncharged, next IST day) instead of a no-answer charge. `machine` is left for calls where
  nobody was heard or the first words were voicemail/carrier wording. The residual risk is
  the opposite direction: a voicemail greeting that does not look like one after a real
  "hello" defers instead of ending as `machine`, which costs a redial the next IST day.
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

---

## 13. Recording integrity (M013 S02, migration `0125`)

This section covers what changed so that a phone call's recording, its length and its
label match what happened on the line. The case that prompted it was live session
9f60523d. The candidate answered two legs and none of the five questions. The page read
**"Screened"** and **7m 23s on the call**. The real audio was 53 s + 18 s, and leg 1 was
missing its last ~7 s, including Q1.

### 13a. The pieces

| Piece | Where | What it does |
|---|---|---|
| Tail flush | `app/voice-livekit/recording.py` (`_FlushingRecorderIO`, `InWorkerRecorder`) | Writes the recording tail when a leg closes. |
| Leg-timing report | `recording.py` (`RecordingManifest`), `recording_api.py` | Sends the true audio length and the leg timing on `/recording/complete`. |
| Leg-timing stamp | `routes/phone-worker.ts`, `lib/recording-egress.ts` (`stampWorkerAttemptLegTiming`) | Stores those facts on the attempt row. |
| Reconciler room fallback | `integrations/livekit-phone/reconciliation.ts`, 0125 §2 | Lets the reconciler see reconnect legs. |
| Truthful `duration_sec` | 0125 §3 | Builds a session's length from observed leg ends only (see `session-lifecycle.md`). |
| Finalize guard and `unobserved_disconnect` | 0125 §4 | Stops a session being scored while a reconnect is pending, and labels an unobserved drop truthfully. |
| Zero-answer relabel | 0125 §5, `assessment-handler.ts` | Labels a session with 0 answers "Abandoned: dropped before screening", never "Screened" (see `session-lifecycle.md`). |
| Per-leg display | `routes/candidates.ts`, `lib/attempt-leg-timing.ts`, web `TranscriptionSyncWorkspace.tsx` and the candidate pages | Shows every leg with its own length, player and notes. |

### 13b. `PHONE_RECORDING_TAIL_FLUSH`: the tail flush and its kill switch

**The problem.** RecorderIO (livekit-agents 1.6.4) writes a bot utterance only when its
playback finishes, and holds back the candidate's audio while bot audio is pending. When
the candidate hangs up mid-utterance, that utterance and everything held back after it
were never written.

**The fix.** On close, the recorder writes the **played** part of the pending utterance
and the held-back candidate audio. Then it closes as before. The cut-off is the **leg
end**, not the session close, so bot audio the candidate never heard is not written. The
leg end comes from these sources; the earliest one wins:

1. The recorder's own `participant_disconnected` listener for this attempt's SIP
   identity (`source=sip_left`). This is the primary source. It is a separate listener
   from the gate's own disconnect handling.
2. The SDK session `close` event (`source=session_close`). This is only an upper bound,
   because the SDK emits it after its drain and transcript commit, which can be seconds
   after the hang-up.
3. The moment `finish()` runs (`source=finish`), as a last resort.

| Value | Effect |
|---|---|
| unset or `on` (default) | Tail flush on. |
| `off`, `false`, `0`, `no` or `disabled` | The plain RecorderIO, byte-for-byte the pre-S02 behaviour. |

The switch lives in code (default `on`) and in `.env.example`. It is not in
`fly.phone.toml`. The flush is **fail-open**: any error skips it, and the recording is
still uploaded. Recording stays strictly secondary to the screening.

**Rollback (no deploy needed):**

```
fly secrets set PHONE_RECORDING_TAIL_FLUSH=off --app project-hello-phone-voice
```

This restarts the phone worker machines. Remove the secret, or set it to `on`, to restore
the flush.

**Worker log lines.** They carry counts, times and categories only, never audio or
candidate text.

| Line | Meaning |
|---|---|
| `in_worker_recording_tail_flush out_ms= in_ms=` | The flush ran, with the bot and candidate milliseconds it wrote. |
| `in_worker_recording_tail_flush_skipped category=` | The flush failed open. Expect about 0 of these. A steady rate means the SDK internals moved. |
| `in_worker_recording_tail_flush_disabled` | The kill switch is off. |
| `in_worker_recording_tail_flush_sdk_unverified version= verified=1.6.4` | The SDK is not the verified version. The flush is still attempted. Re-verify it before trusting it. |
| `in_worker_recording_leg_end source= leg_end_ms= last_input_frame_ms= begun_at_ms=` | Which leg-end source won, as a cross-check against the last candidate audio frame. |
| `in_worker_recording_leg_end_reopened` | The same SIP identity rejoined after a departure, so capture reopened. |

The flush relies on SDK internals, which are pinned to 1.6.4. The CI step that runs
`tests.test_recorder_flush` against the real SDK fails if those tests are skipped. **Any
livekit-agents upgrade must re-run it.**

### 13c. The leg-timing fields

The worker now adds these fields to `/recording/complete`. Every one is optional, so an
older worker's body is unchanged.

| Body field | Stored on `phone_call_attempts` | Meaning |
|---|---|---|
| `duration_ms` | `recording_duration_ms` | The **true audio length** (samples encoded divided by the rate). It is no longer a wall-clock span. Unknown is sent as null, never 0. |
| `recording_started_at_ms` | `recording_started_at_ms` | Epoch ms of t = 0 in the file, used to place transcript turns on that leg's audio. |
| `leg_ended_at_ms` | `observed_ended_at` | The worker's earliest leg-end mark (§13b). Stored **only** when `leg_end_source` is `sip_left`. |
| `leg_end_source` | (not stored) | Which mark `leg_ended_at_ms` is: `sip_left` (the SIP participant left, an observed end), `session_close` (an upper bound, possibly seconds late) or `finish` (the last-resort teardown time). A non-`sip_left` mark is dropped with the log line `dropped:leg_end_not_observed`, so a teardown time never passes for an observed end. |
| `tail_flushed` | `recording_tail_flushed` | True only when the flush ran **and** the recorder closed cleanly. |

**How the API stores them:**

- The stamp runs **before and independently of** the recording finalize. A `pending` or
  `fallback_required` finalize, or the 503 `session_recording_pending` path, still keeps
  the timing.
- It is idempotent. `observed_ended_at` keeps the earliest value, and the other fields
  keep the first value written. A worker retry or the late reporter cannot move them.
- It is data only: no ledger event, no state transition, and it writes the attempt row
  only, never `call_sessions`.
- A legacy body, with none of the new fields, stamps nothing. Its `duration_ms` is a
  wall-clock span and is not stored as an audio length.
- A value outside `[answered_at − 30 s, now + 60 s]`, or outside the 0125 column limits,
  is **dropped and logged**. The request is never rejected, so the recording is kept.
  - Log: `schema=recording_complete_timing`, `error_category=dropped:<code>`. The codes
    are `recording_started_at_out_of_window`, `leg_ended_at_out_of_window`,
    `duration_out_of_range` and `no_answer_anchor`.
  - A failed stamp logs `stamp:<status>` (`store_error`, `attempt_not_found`,
    `attempt_mismatch`, `conflict`) or `stamp:error`. It never blocks the completion.
- The stamp runs on the worker recording provider only.

**Compatibility retry (worker side).** If an older API answers **400** with `status:
'invalid_request'` to a body carrying the new fields, the worker re-posts the legacy body
**once**. A rolled-back API therefore never loses a completion. The worker does not retry
on any other status.

**Display.** A leg whose `recording_tail_flushed` is not `true` shows "This recording may
end a few seconds before the call did". The note is not shown when the connected and
recorded lengths agree within 3 s. An older MP3 with no `recording_duration_ms` shows an
estimated length (from the file size at 64 kbps), marked "≈".

### 13d. Reconciler room fallback

**The problem.** The reconciler reads LiveKit room participants by `room_name`. A
reconnect leg was bound to its session but admitted with `room_name` NULL. The reconciler
therefore skipped it as `no_room`, and the lease reclaim ended it about 6 minutes later
with no outcome (9f60523d leg 2).

**The fix:**

- 0125 §2 stamps `room_name = 'phone-' || session_id` whenever a leg is bound to a
  session and has no room name. Existing rows were backfilled.
- The reconciler falls back to `phone-<session_id>` for a **bound** attempt with no room
  name. An unbound attempt still counts as `no_room`.
- A room LiveKit does not know:
  - On an **answered** leg, it counts as "our participant is gone", and the reconciler
    posts `sip.participant_left`.
  - On a **pre-answer** leg (ringing or admitted), the room may not exist yet. The
    reconciler skips it as `room_not_found_pre_answer` and posts nothing.
  - Any other read error stays `room_read_failed`.

**Limit.** The due-attempt reader returns only attempts whose lease is still **held**
(240 s after the last heartbeat by default). This fix therefore works only inside the lease, and a
lapsed lease remains the reclaim's job. `PHONE_RUNTIME_RECONCILE_MS` (default 60 000)
must stay small enough that a tick lands inside the lease and inside LiveKit's 120 s
empty-room timeout.

**What to check.** The reconcile tick does not log its `skipped` counts today.
- A reconnect leg that drops should end `disconnected` within about 2 reconcile ticks,
  with `room_name` set.
- A leg ending `abandoned` by the reclaim with no `observed_ended_at` means the fallback
  did not catch it.

### 13e. The finalize guard

**The problem.** `finalize_phone_partial_sessions` completed and scored the 9f60523d
session while the engagement was still `dialing` its next reconnect. The score was 0 of
5, and the candidate read "Screened".

**The fix.** 0125 §4 puts a guard in the sweep's WHERE clause, so a held session is not
selected and cannot crowd others out of the window. A session is held while its
engagement is either:
- `reconnecting` or `dialing`; or
- has a newer live leg that is not yet bound to the session.

**The hold is bounded.** It lapses **30 minutes** (`v_reconnect_hold`) after the end, or
the lapsed lease, of the session's latest bound leg. An engagement stuck in
`reconnecting` cannot hold a session out of scoring and the MP3 transition indefinitely.
The normal exit is the engagement leaving those states: a failed reconnect goes
`eligible` within about a minute.

**Known residue (owner follow-up).** A drop outside the IST window sends the engagement
to `scheduled / window_closed`, a next-day reconnect. The guard does not cover that
state, so such a session still finalizes before the reconnect, as it did before 0125.

### 13f. The `unobserved_disconnect` label

Partial finalize used to label every reclaimed or lease-lapsed leg `worker_crash`,
meaning our side died. It now uses `unobserved_disconnect` when the leg shows **teardown
evidence**, meaning the worker was alive at the end:
- a verified recording upload (`recording_ready`);
- a completed egress **of this leg** (the worker's `EG_worker_<attempt>` id, or any
  egress id that is not the session's). The session's own egress, which 0062 copies onto
  every bound attempt, is not evidence about one leg; or
- an observed SIP leave (`observed_ended_at`, stamped only from a `sip_left` mark).

`worker_crash` is kept only when there is no such evidence.

`unobserved_disconnect` is **not** an infrastructure fault. It grades like any other
disconnect (`no_candidate_speech` / `partial_thin`), never `infra_interrupted`. The token
is carried as a free string end to end, and an older API treats any value other than
`worker_crash` as not our fault, so the two are compatible during a deploy.

**What to watch:** the runtime's `phone_partial_finalize` log line carries the disconnect
reason in `error_type`. Compare `unobserved_disconnect` against `worker_crash`. A rise in
`worker_crash` alone is a real worker problem.

### 13g. What did NOT change

- **The wrong-number / wrong-person discard.** A third party's voice is still deleted
  locally and never uploaded. Every other leg's recording is kept, whatever the consent
  outcome, and is flagged on the server.
- **No consent decisions.** The AI-disclosure wording, the gate and the judge belong to
  the gate work (S01), not here.
- **The duplicate-application hold.** It still matches only `completed` or live
  engagements. A fresh re-application after a `failed / screening_abandoned` screen is
  screened, following the 0114 policy that "a failed screen never blocks".
- **Historical seed rows and session 32757295** (stuck in `waiting`, with a leg where the
  person spoke recorded as `voicemail`). These are owner follow-ups, not handled here.

### 13h. 48-hour watch after a deploy

| Signal | Expect |
|---|---|
| `in_worker_recording_tail_flush_skipped` | About 0. |
| `in_worker_recording_tail_flush` with `in_ms`/`out_ms` > 0 | Present on calls that ended mid-utterance. |
| `recording_complete_timing` `dropped:*` | Rare. A burst of `leg_ended_at_out_of_window` points to worker clock skew. |
| Reconnect legs ending `abandoned` by the reclaim with no `observed_ended_at` | About 0 inside the lease window. |
| Finalize `examined` / `skipped` | Skips rise only while reconnects are pending, and never pin the window (no starvation). |
| `unobserved_disconnect` vs `worker_crash` | Most reclaimed legs now read `unobserved_disconnect`. |

**Rollback:**
- **Worker:** the §13b secret. No code redeploy is needed.
- **API:** redeploy the previous image. The worker's compatibility retry covers an older
  API.
- **0125 is forward-only.** The columns are additive and harmless. A DB rollback
  re-declares the 0114 or 0076 bodies of `finalize_phone_partial_sessions`,
  `enforce_phone_engagement_transition` and `set_phone_session_duration`.
