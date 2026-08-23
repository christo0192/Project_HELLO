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

---

## 2. The switches, and why there are so many

A call reaches a carrier only when **all** of these hold. They are separate on purpose:
each represents a distinct decision, and none is allowed to imply another.

| Switch | Default | Meaning |
|---|---|---|
| `PHONE_SCREENING_ENABLED` | `false` | The domain master switch. |
| `PHONE_RUNTIME_ENABLED` | `false` | Arms workers/timers, independently. |
| `PHONE_DIAL_MODE` | `off` | `off` \| `synthetic` \| `live`. Only `live` can reach a carrier. |
| `PHONE_DIAL_ALLOWLIST` | empty | SHA-256 **digests** of permitted numbers. **Empty is fail-closed.** |
| `PHONE_SIP_TRUNK_ID` | empty | Provider-neutral trunk. **Empty is fail-closed.** |
| LiveKit credentials | — | Checked independently of the phone flags. |

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
in that mode is 60 s — exactly the default `PHONE_LEASE_SECONDS`.

If the originate outlives its lease, `reclaim_phone_attempt_leases` abandons the attempt
while the dial is still in flight: two calls hold one fleet slot, and the engagement has
already been restored to its prior state. Nothing else notices, because P3's
reconciliation sweep deliberately leaves *held* leases alone.

So the dial controller **extends the lease to cover the worst-case originate, and refuses
before touching the SDK if it cannot** — including when the heartbeat succeeds but 0042's
900 s clamp returns less than we asked for. "We asked for enough" is not "we have
enough".

Keep `PHONE_ORIGINATE_TIMEOUT_SECONDS` (default 30) well below `PHONE_LEASE_SECONDS`
(default 60).

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

> **STOP — steps 1–5 are safe; step 6 is not yet.** Step 6 places a call to a real
> person. As shipped, that call **records the candidate and produces no transcript and
> no assessment** (§12), and a reconnect re-asks every question. Do not take step 6 for a
> real candidate until the persistence path in §12 has landed. Steps 1–5 reach no
> carrier and are the whole of what this change is ready for.
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
6. **Blocked on §12.** Adding a digest to `PHONE_DIAL_ALLOWLIST` and setting
   `PHONE_DIAL_MODE=live` is the first call that can reach a carrier, and it reaches
   exactly one number — but a real candidate answering it is recorded and screened for
   nothing. Take this step only once §12 is closed, or knowingly, against a number you
   control, as a transport rehearsal rather than a screening.

Note also that every phone conversation currently terminates as `failed` /
`assessment_aborted` by design (§12). That is the truthful state, not a fault to
investigate, and it is the reason step 6 is gated.

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
- **No scheduler is armed.** `dialPhoneAttempt` has no production caller.
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
