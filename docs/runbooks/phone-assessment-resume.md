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

**A scoring *exception* is not evidence that nothing was scored.** In that same
race the loser's insert hits `23505`, and any failure to read the winner's row
back re-throws. The session IS scored. So the exception is remembered and the
**row** decides: `/assessment/complete` runs the verifying read either way, and
answers `scored` when the row is there. Returning `scoring_failed` on the throw
would have driven the engagement to terminal `failed` over a screening that
exists.

**The completion is retried, boundedly.** Every question is durable by then, and
there is no second chance from the conversation — the session is `completed`
afterwards, so a later leg's `start_phone_assessment` refuses it with
`session_not_active`. Three attempts with linear backoff, over **two** classes:

* a refusal we understand (`scoring_failed`, `completion_failed`) — a fault;
* a **transport** failure, which carries no status at all.

`phone.retryable_completion` covers both, and the second is the one that matters
most: a reset, a timeout or a 5xx is exactly the "blip between the worker and the
API" the retry exists for, and it is the case where the endpoint may have
succeeded, inserted the assessment and simply lost its response. Keying only on
`status` skipped it entirely.

`phone_assessment_error` is deliberately **absent** from
`RETRYABLE_COMPLETION_STATUSES` even though the route emits it: the route emits
it only with HTTP 500, and a 5xx is classified as a transport failure before the
body is ever parsed, so it can never arrive as a `status`. Listing it would read
as coverage the set does not have; the 500 case is covered through the transport
class.

A *state* (`plan_incomplete`, `session_not_active`, `unknown_session`) is not
retried — retrying cannot change it and would only hold the candidate on the
line. After the attempts are exhausted, an answer we understand aborts
truthfully; one we cannot parse is a **halt**, because we do not know whether it
scored and a terminal event either way would be a claim we cannot support.

**A REFUSED START IS NOT PROOF THAT NOTHING HAPPENED**, and there are two rungs
to that, because there are two different states behind one refusal.

`start_phone_assessment` answers **`already_scored`** when the session is
`completed` **and** a phone-sourced assessment row exists — a *scored* screening
whose acknowledgement was lost. It is deliberately DISTINCT from
`session_not_active`, because the two demand opposite actions: one means "you
cannot screen", the other means "the screening is finished, go and say so".
Collapsed together, the engagement can never reach `completed` from any leg — it
rests non-terminal until a budget or a sweeper ends it, or goes `failed` for an
untruthful reason.

On `already_scored` the worker posts `assessment.completed` **directly**: no
completion call, no inference, no second writeback, no question re-asked. The
post is idempotent by `0042`'s deterministic internal event id, and `0044`'s
interlock accepts it precisely because the row the RPC just found is there.

On `session_not_active` — completed but **not** scored — the worker asks the
completion endpoint, which may still be able to finish the job. Either way the
ROW decides, and an endpoint that says otherwise still aborts.

`already_scored` is decided **after** the binding checks, so it can only ever
describe a session that named this exact phone room and belongs to this
engagement's candidate. It carries no plan and no cursor: there is nothing left
to screen, and handing one back would invite a leg to re-ask answered questions.

> **The two halves of this are NOT interchangeable.** An earlier draft of this
> runbook said the transport-class retry and the adoption path each closed the
> gap on their own. That was wrong, and an independent pass corrected it: the
> **adoption path is load-bearing** and closes it unconditionally, while the
> retry only closes it when the API comes back inside the ~3-second retry
> window. The retry is still worth having — it saves a redial on the common
> short blip, which is a real anti-harassment win — but it is an optimisation.
> Do not remove the adoption path as redundant.

Note also that the `session_not_active` rung can *cause* scoring rather than
merely observe it: a session completed but never scored gets a genuine inference
from the recovery leg, and then legitimately completes. That recovers a case the
abort-after-retries residual otherwise gives up on.

---

## 4. The three terminal decisions, and the one that posts nothing

`run_phone_assessment` returns exactly one of three outcomes, and they do **not**
collapse into two:

| Outcome | Worker posts | Why |
|---|---|---|
| `scored` | `assessment.completed` | The API verified an assessment row |
| halted, **infrastructure** (`persistence_failed`, `scoring_unreachable`) | **nothing at all** | The conversation is interrupted, not over |
| halted, **conversational** (`malformed_exchange`, `no_exchange_captured`) | `assessment.aborted` | The candidate stopped answering. That is not a line drop |
| neither | `assessment.aborted` | The call happened and produced nothing scorable — P4a's truthful terminal, unchanged |

**The infrastructure row.** Both terminal events available on that path would
**end** the engagement: `assessment.aborted` is terminal `failed`, and
`assessment.completed` would be a lie. A dropped or unwritable leg is what
`0042`'s reconnect budget is *for*, and the webhook's `sip.participant_left`
drives it. Posting a terminal event there would convert a retryable problem into
a lost candidate. It is **logged** (`phone_assessment_halted_leg`) rather than
silent, because P4a's own review recorded the mirror lesson: stopping something
that fails loudly can make it fail silently.

**The conversational row, and why it is separate.** A candidate who simply goes
quiet produces the same *shape* — a boundary with no answer in it — but posting
nothing there would let the webhook grant and **charge** a reconnect, and that
candidate would be dialled back up to three times for having said nothing, on a
dialer whose per-IST-day index exists to prevent exactly that. So these end the
call truthfully instead. `phone.halt_is_retryable` enumerates which halts are
which, and an unknown or absent reason is **not** silently retryable — a new
reason has to declare its kind rather than defaulting into the silent branch.

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
- **No `duration_sec` for a phone screening.** A session spans every reconnect,
  and `0042` defers a window-closed one to the **next IST day**, so there is no
  single elapsed number that is true of the conversation. `started_at` is stamped
  when the session ROW is created — NOT NULL, defaulted, never updated — so
  measuring from it would report time-since-provisioning and clamp at 86,400 on a
  next-day reconnect: a plausible-looking measurement of something nobody asked
  about. A hardcoded `0` was worse still. The column is left NULL, which says
  "not measured", and that is true. A phone-specific instant (the attempt's
  `answered_at`, or the `disclosure.delivered` transition) would be measurable,
  and that is a deliberate later change rather than a number invented here.
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
- **A recovery leg dials the candidate and reads the full disclosure.**
  `start_phone_assessment` requires `in_call`, which requires
  `disclosure.delivered` — P4's decision #1, deliberately not undone — so an
  adoption or recovery leg must place a real call and read the recording notice
  before it can adopt. It then speaks the closing line and hangs up. Two
  consequences, both recorded as choices rather than oversights: the candidate is
  disturbed once more for a screening that is already finished, and the leg
  leaves a **disclosure-only recording stub**, because `assessment.completed` is
  not in `PURGE_BEFORE_EVENTS` and the stub is retained under normal retention.
  Neither is new — the pre-adoption refused-start path did the same — but
  adoption turns this from an error path into a designed success path.
- **A scoring failure the API can NAME is still terminal.** After three bounded
  attempts, an answer we understand (`scoring_failed`) ends the call with
  `assessment.aborted`, i.e. terminal `failed`. The transcript is durable and
  the session is scorable, so re-scoring it later through
  `POST /api/assess/:sessionId` produces an assessment and a scorecard — and it
  now lands in the **phone** partition, because the source is derived from the
  session rather than taken from the caller. But there is **no path back to
  `completed`**: the engagement is terminal and `apply_phone_event`
  short-circuits every later post with `ignored: terminal`. An operator
  recovery that also corrects the engagement outcome is not built.
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
- **`session_already_bound` is a SCHEDULER bug, not a candidate problem.** Once
  an engagement carries a `session_id`, `start_phone_assessment` refuses any
  other session for it, permanently. That is deliberate — `0042` is explicit
  that one session spans every reconnect attempt and they must share a
  transcript, so rebinding would orphan the first leg's turns and point the
  completion interlock at the wrong session. But it means a future scheduler
  that mints a NEW `call_sessions` row per dial attempt would make every attempt
  after the first fail to start. It fails LOUDLY (the leg ends
  `assessment_aborted`, i.e. terminal `failed`) rather than silently, and the
  fix is in the caller: reuse the engagement's session.
- **The resume replays the exchange into the PROMPT, not into a `ChatContext`.**
  `phone.render_resume_context` renders the persisted turns into the system
  instructions, bounded to the last 24 turns and 600 characters each. This is
  SDK-independent and testable, where reconstructing a `ChatContext` is neither.
  The model is never asked to work out from that transcript which questions
  remain — that comes from the cursor.
- **Delivery of those instructions is BEST EFFORT, and not verified against the
  real SDK.** `Agent.instructions` is a read-only property on
  livekit-agents 1.6, so `_deliver_phone_instructions` calls
  `await agent.update_instructions(...)` first and falls back to an attribute
  write. Both paths are tested against doubles shaped like each case, and a
  failure to deliver is **reported and logged** rather than swallowed — but the
  SDK is not installed in CI, so nobody has yet watched the real one accept it.
  Whether an instruction update after `session.start()` re-seeds a running
  session's context is also unverified. If it does not, the screening still runs
  correctly — the question text reaches the model through `generate_reply` and
  every boundary is still keyed by the cursor — but the tailoring and the resume
  replay would be lost.
  **`phone_instructions_not_applied` is NOT the observable to watch for that.**
  It fires when the mutator raises, and on the real SDK it will not raise — the
  log line watches the mutator's *existence*, not its *effect*. The rehearsal
  check is behavioural: on a deliberately reconnected leg, does the bot
  acknowledge the disconnect and avoid re-covering ground the candidate already
  gave? If it starts cold, the update did not re-seed the running session's
  context, whatever the logs say.
- **A duplicate boundary advances the cursor, and the exchange this leg captured
  is discarded.** That is correct — the question is answered and recorded — but
  the transcript will show the OTHER exchange. Logged as
  `phone_boundary_duplicate` rather than silently equated.
  **There are three causes, and the third is the one to look for.** This leg's own
  earlier attempt, or a leg that ran before it — both benign. Or **two legs live
  at once**, which the boundary RPC cannot exclude because it takes no epoch and
  no attempt id: it is the one place in the phone lane where `0042`'s "fencing
  must not be optional" doctrine is not applied. If `phone_boundary_duplicate`
  ever appears in production **without a preceding retry**, that is the unfenced
  condition, not a retry, and it wants investigating.

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

Thirty-six controls, two of them superseded and marked as such. Same contract as `phone-safe-dialer.md` §11: every guard
below was deliberately broken, the suite run, the failure recorded, then reverted and re-run green.
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
| M10 | Move the whole shape-validation block after the duplicate read-back | `policy_tests.sql` | 1 fail |
| ~~M11~~ | ~~Return `null` for `started_at` from the state RPC~~ | — | **SUPERSEDED by M18** — the RPC no longer emits `started_at`, so applying M11 as written is a no-op and comes back GREEN |
| M12 | Return on a scoring throw instead of running the verifying read | `phone-assessment-route` | 1 fail |
| ~~M13~~ | ~~Hardcode `durationSec: 0` again~~ | — | **SUPERSEDED by M17** — `elapsedSeconds` and the whole `durationSec` plumbing are gone, and the two tests M13 reddened were deleted |
| M14 | Drop `{ source: 'phone' }` from the default `scoreSession` | `phone-assessment-route` | 1 fail |
| M15 | Trust the caller's `source` instead of deriving it | `phone-assessment-idempotency` | 3 fail |
| P6 | Put the conversational halts back into `RETRYABLE_HALTS` | Python suite | 2 fail |
| P7 | Remove the bounded completion retry | Python suite | 2 fail |
| P8 | Terminalise an unparseable completion answer instead of halting | Python suite | 1 fail |
| P9 | Deliver instructions by bare `setattr` only | Python suite | 1 fail + 1 error |
| P10 | Let gate copy back into the exchange queue | Python suite | 1 fail |
| M16 | Delete the scanner's own scratch-directory `rm` | `resume-scanner-freshness` | 2 fail |
| M17 | Invent a `durationSec` on the completion again | `phone-assessment-route` | 1 fail |
| M18 | Return `started_at` from the state RPC again | `policy_tests.sql` | 1 fail |
| P11 | Key the completion retry on `status` only, skipping the transport class | Python suite | 7 fail |
| P12 | Abort blind on a refused start instead of asking the completion endpoint | Python suite | 2 fail |
| P13 | Let the recovery claim a completion the endpoint did not confirm | Python suite | 2 fail |
| M19 | Collapse `already_scored` back into `session_not_active` | `policy_tests.sql` | 1 fail |
| M20 | Stop naming `already_scored` in the state RPC | `policy_tests.sql` | 1 fail |
| M21 | Remove the candidate binding check that must precede `already_scored` | `policy_tests.sql` | 2 fail |
| M22 | Remove the adoption short-circuit in `/assessment/complete` | `phone-assessment-route` | 2 fail |
| M23 | Drop `already_scored` from the sanitized projection | `phone-assessment-route` | 1 fail |
| P14 | Make the agent ignore `already_scored` | Python suite | 1 fail |
| P15 | Treat deterministic auth/config faults as retryable again | Python suite | 3 fail |

`M2` is the one worth keeping: a plpgsql `exception` block opens a
subtransaction, so the "one transaction" claim is broken by an edit that looks
like nothing more than defensive error handling. It also trips `0042`'s own
"no phone function swallows every error" assertion, which is the control working
twice.

`M16` is not about P4b at all, and it is recorded here because P4b is what
exposed it. `resume-scanner-freshness.test.ts` asserted a GLOBAL count of
`hello-resume-scan-*` directories in the shared OS tmpdir — a prefix every
`ClamAvScanner.scan` in the process mints, and `resume-ingestion.test.ts` scans
too. Vitest runs suites in parallel workers, so the two raced; the race was
always there and only started firing when the suite grew enough to shift which
files share a worker. The assertions are now scoped to the directories the test
itself created, and `M16` — deleting the scanner's own `rm` — proves the scoped
version still catches a real leak.

**M11 and M13 are struck through rather than deleted**, and that matters more
here than it normally would: this section's own contract is *"if deleting a guard
leaves its suite green, the guard is decorative."* An operator re-running a stale
control gets green and draws exactly the wrong conclusion. A superseded control
must say so, and name the row that replaced it.

`P10` earned its place the hard way. When first written it stayed **green** —
the gate-copy filter had no test that could fail, because the test double's
`say()` did not append a conversation item the way the real SDK does, so the
fixed lines never reached the queue the filter guards. The double was made
faithful and the control now goes red. A guard whose test cannot fail is
decorative, and the way that happens is almost always a fake that is kinder than
production.

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
