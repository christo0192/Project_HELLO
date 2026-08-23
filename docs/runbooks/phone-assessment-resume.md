# Phone screening P4b — durable assessment, keyed resume, truthful completion

Migration `0044_phone_assessment_resume.sql`. Read `phone-safe-dialer.md` first:
this runbook assumes the P4a consent gate and does not repeat it.

**Nothing here is enabled by anything this change ships.** The whole phone lane
is still off behind `PHONE_SCREENING_ENABLED`, `PHONE_DIAL_MODE`,
`PHONE_RUNTIME_ENABLED` and `PHONE_AGENT_NAME`, and no scheduler calls the
dialer. What changes is what happens *once* it is on.

---

## 1. What this closes

P4a shipped the consent gate and stopped there, truthfully: the phone path
persisted no transcript, activated no session, scored nothing, and therefore
posted `assessment.aborted` on **every** call. Correct, and useless — an
engagement that always ends `failed` is a screening that never happened.

P4b makes the conversation durable and makes the completion claim checkable:

| Before (P4a) | After (P4b) |
|---|---|
| No transcript row is ever written | Every answered question is committed as an ordered turn set |
| `current_question_index` had zero readers or writers | It is the cursor, advanced only by a committed boundary |
| A reconnect re-asked every question | A reconnect asks the next unfinished **key** and never re-asks a committed one |
| Nothing is scored | `runAssessment` is called and **awaited**, with the phone source |
| `assessment.aborted`, always | `assessment.completed` only when an assessment row has been verified |

---

## 2. The three things that arrive together, and why

Shipping any one of them alone re-creates the failure the other two prevent.

**(a) An immutable, session-scoped question plan.** `lib/prompts.ts` tells the
model to *"generate the actual questions LIVE"*, and the `[MUST ASK]` items live
as prose inside a prompt string. Prose has no identity, so "never re-ask an
answered question" was not expressible — there was nothing for a cursor to point
at. `roles.screening_template` has been an ordered, id-carrying, first-class
artifact since `0001`; it was simply never read by the voice worker. `0044`
snapshots it once, per **session**, into `phone_session_plans`.

A recruiter editing the role mid-call therefore cannot renumber a conversation
in progress, and question identity is never inferred from a transcript.

**(b) An atomic question boundary.** `commit_phone_question_boundary` appends the
ordered turns, records the completed key and advances the cursor in **one**
transaction under the session row lock. Half a boundary is exactly the state a
reconnect misreads — turns without a cursor move re-ask an answered question; a
cursor move without turns scores a conversation with a hole in it — so it is not
reachable: any failure rolls the whole boundary back.

**(c) An assessment that exists before anything claims it.** `assessments` had no
uniqueness on `session_id`, and `services/assessment.ts` documented its own
TOCTOU race out loud. A reconnect is what makes that race ordinary. `0044` adds
`uq_assessments_phone_session`, and `apply_phone_event` now refuses
`assessment.completed` outright unless the row is already there.

---

## 3. The ordering, in one place

```
disclosure.delivered accepted  (P4a, engagement -> in_call)
        |
POST /assessment/start         bind + activate + snapshot plan   (idempotent)
        |
   for each key the SERVER says is owed:
        ask  ->  POST /assessment/turn   (turns + key + cursor CAS, atomic)
        |            not ok?  ->  STOP. no next question, no completion,
        |                          and NO terminal event at all.
        |
POST /assessment/complete      plan complete? -> session CAS -> AWAIT scoring
        |                       -> VERIFY the assessment row exists
        |
POST /events assessment.completed      (refused in SQL if the row is absent)
```

**The phone path does not use the browser's detached scoring timer.**
`routes/livekit.ts` fires `runAssessment` on an unref'd 8-second `setTimeout` and
swallows the error. That is right for a path whose completed session is durable
on its own and where a reconciler can retry. It is wrong here, because nothing
may claim a phone completion until the score exists — so `/assessment/complete`
awaits it and reports the failure.

**A completion CAS conflict is not a failure.** Two legs racing to complete is
exactly what a reconnect produces. The loser still scores (idempotently) and
still verifies.

---

## 4. The three terminal decisions, and the one that posts nothing

`run_phone_assessment` returns exactly one of three outcomes, and they do **not**
collapse into two:

| Outcome | Worker posts | Why |
|---|---|---|
| `scored` | `assessment.completed` | The API verified an assessment row |
| `halted` | **nothing at all** | A persistence or infrastructure failure. The conversation is interrupted, not over |
| neither | `assessment.aborted` | The call happened and produced nothing scorable — P4a's truthful terminal, unchanged |

The middle row is the one worth understanding. Both terminal events available on
that path would **end** the engagement: `assessment.aborted` is terminal `failed`,
and `assessment.completed` would be a lie. A dropped or unwritable leg is what
`0042`'s reconnect budget is *for*, and the webhook's `sip.participant_left`
drives it. Posting a terminal event there would convert a retryable problem into
a lost candidate.

It is **logged** (`phone_assessment_halted_leg` with a halt reason) rather than
silent, because P4a's own review recorded the mirror lesson: stopping something
that fails loudly can make it fail silently.

---

## 5. Why the completion interlock is in SQL, and why it writes nothing

`apply_phone_event` refuses `assessment.completed` with `assessment_missing`
unless a phone-sourced assessment row exists for the engagement's bound session.
It is in SQL for the same reason `0043` put the disclosure gate in
`attach_phone_attempt_recording`: a worker-side ordering rule is a convention,
and a convention survives exactly until someone reorders two awaits.

**The refusal is decided BEFORE the insert and records no ledger row**, exactly
like `attempt_required`. This is not tidiness. The `internal` source mints a
*deterministic* `provider_event_id`, so a recorded refusal would be read back
verbatim by every later delivery of the same claim — and a worker that posted one
moment too early could then **never complete the call at all**. Recording it
would turn a retryable timing problem into a permanent wedge. A local rehearsal
caught exactly that during implementation.

The refusal charges nothing: no budget moves, no state changes, and a re-post
once scoring lands succeeds.

---

## 6. What is deliberately NOT here

- **No new terminal reason and no new failure policy.**
  `chk_call_sessions_terminal_reason` is untouched. A persistence or provider
  failure mid-screening stays retryable through `0042`'s existing reconnect
  budget; exhaustion uses the terminal reasons that already exist.
- **No stage move, no email, no scorecard write.** Scoring's only completion
  observer is the one `runAssessment` already calls, which parks an Ashby link at
  `writeback_pending` and publishes nothing.
- **No change to the browser path.** `assessments.source` defaults to `browser`,
  the new unique index is **partial** over `source = 'phone'`, and no browser
  caller passes the column at all — so the browser insert payload is byte-identical
  to what it was. The browser transcript, completion and scoring suites are run
  and reported, not merely declared unchanged.
- **The wind-down line is not a transcript turn.** `PHONE_ASSESSMENT_CLOSING_TEXT`
  is a constant, like the disclosure, and is excluded from the transcript for the
  same reason: it is gate copy, not evidence of a screening. The durability
  requirement before completion is that every plan key is committed.

---

## 7. Known residuals

- **The model cannot skip an optional question.** The cursor advances strictly by
  one and a commit for any key other than the current one is refused
  `key_not_current`. That is stronger than the contract requires (which only
  forbids skipping *mandatory* keys) and it is the safe direction, but a role
  whose template contains a question that genuinely does not apply will still
  have it asked. Relaxing this needs its own migration and its own review.
- **A malformed `screening_template` refuses the leg.** It is refused before a
  single question is put, so nothing is lost but the leg — but a role saved
  outside the API's zod validation could make every call to that role fail to
  start. The API validates on write; a direct database edit does not.
- **Follow-ups are bounded at one per question**, and only when the plan question
  carries a `follow_up_hint`. The boundary RPC accepts up to twelve turns, so
  richer follow-up behaviour is a worker change, not a schema change.
- **`PHONE_ANSWER_TIMEOUT_SEC` bounds one question's exchange** (default 90 s,
  clamped 5–300). A candidate who goes quiet mid-answer ends the boundary
  uncommitted, which halts the leg rather than recording an answer they did not
  give.
- **The plan is snapshotted from the role at the FIRST start.** An engagement
  whose session is re-created (a different `call_sessions` row) gets a fresh
  snapshot, because the plan is session-scoped. That is intended — a new session
  is a new conversation — but it means "the plan is immutable" is a per-session
  guarantee, not a per-engagement one.

---

## 8. Enabling order

Unchanged from `phone-safe-dialer.md` §9, with one addition at the front:

0. **Apply `0044` before deploying the P4b worker.** The worker's
   `/assessment/start` call fails closed without the RPCs, which means no
   screening runs — safe, but every call would end `assessment.aborted`.

Then steps 1–6 of §9 as written. **Do not enable `PHONE_DIAL_MODE=live` for a
real candidate on a deployment carrying P4a without P4b**: P4a alone conducts a
recorded conversation and scores nothing.

Kill switch at any point: `POST /api/phone/halt`.

---

## 9. The mutation controls, and how to re-run them

Same contract as `phone-safe-dialer.md` §11: every guard below was deliberately
broken, the suite run, the failure recorded, then reverted and re-run green.
**If deleting a guard leaves its suite green, the guard is decorative.**

Recorded here rather than shipped as a script, for the same reason: a script that
edits source and reverts with `git checkout` will destroy uncommitted work.
Re-run them by hand, on a **clean** tree, one at a time.

| # | Break this | Suite | Expect |
|---|---|---|---|
| M1 | Neutralise the `v_needs_assessment` guard in `apply_phone_event` (0044) | `policy_tests.sql` | 2 fail |
| M2 | Wrap the boundary's turn insert in its own `exception when others` sub-block | `policy_tests.sql` | 3 fail |
| M3 | Neutralise the `key_not_current` refusal | `policy_tests.sql` | 6 fail |
| M4 | Re-snapshot the plan on every start instead of `on conflict do nothing` | `policy_tests.sql` | 1 fail |
| M5 | Drop the post-scoring row verification in `/assessment/complete` | `phone-assessment-route` | 4 fail |
| M6 | Neutralise the `planComplete` gate in `/assessment/complete` | `phone-assessment-route` | 1 fail |
| M7 | `void scoreSession(...)` instead of `await` | `phone-assessment-route` | 1 fail |
| M8 | Neutralise the unique-violation reuse in `runAssessment` | `phone-assessment-idempotency` | 2 fail |
| M9 | Pass `source` on the browser payload too | `phone-assessment-idempotency` | 2 fail |
| P1 | Start the loop at cursor 0 instead of `state.cursor` | Python suite | 3 fail |
| P2 | Let a refused boundary fall through instead of halting | Python suite | 3 fail |
| P3 | Post `assessment.completed` unconditionally (the P4a defect, restored) | Python suite | 4 fail |
| P4 | Skip `valid_boundary_turns` and commit whatever was captured | Python suite | 2 fail |
| P5 | Post a terminal event on the halted path | Python suite | 2 fail |

`M2` is the one worth keeping: a plpgsql `exception` block opens a
subtransaction, so the "one transaction" claim is broken by an edit that looks
like nothing more than defensive error handling. It also trips `0042`'s own
"no phone function swallows every error" assertion, which is the control working
twice.

Commands:

```
# SQL
bash scripts/supabase-test.sh                 # or apply 0001-0044 and run policy_tests.sql
# TypeScript
cd app/api && npx vitest run src/__tests__/phone-assessment-route.test.ts
cd app/api && npx vitest run src/__tests__/phone-assessment-idempotency.test.ts
# Python
cd app/voice-livekit && python3 -m unittest discover -s tests -p 'test_*.py'
```
