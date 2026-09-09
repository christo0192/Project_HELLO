"""SE call #2 RCA slate (2026-09-07, session 1adb50ae) — seven fixes.

F-P0a — the terminal ``completed`` commit is CONTENT-GATED: a delivered terminal
reply that is not closing-shaped (the LLM disobeyed "do not ask another
question") must not commit; the deterministic ``PHONE_ASSESSMENT_CLOSING_TEXT``
is spoken as its own armed terminal reply instead.
F-P0c — bounded Q&A rounds are counted per COALESCED logical turn, not per STT
final (a fragment-split question burned 2 of the rounds on the live call).
F-Q3a — the boundary-commit fence also skips a boundary captured on a turn the
conflict machinery CONSUMED (pending cleared on arrival charged the
clarification to ``se_built_e2e`` and ran the cursor one-ahead all call).
F-Q3b — the answer disposition runs on the COALESCED exchange text, and a short
"?"-terminated turn that fails ``phone_answer_covers_objective`` is a NONANSWER
even when the interrogative word is stranded mid-sentence by STT splits.
F-Q3c — ``ask_delivered`` is derived honestly from the coverage signals for ALL
questions (recording only; non-mandatory questions keep advancing).
F-Q2a — the SYNC deterministic conflict detector bumps its own telemetry bucket
and a sync-authored probe's delivery bumps ``conflict_probe_delivered``.
F-Q4a — the watchdog's recovery say() defers (bounded) while the candidate is
actively speaking, then fires on end-of-speech; it is never dropped.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

# Reuse the phone-gate harness: its module bootstrap installs the stub SDK and
# exposes the REAL coordinator driver + fakes.
from tests.test_phone_gate import (  # noqa: E402
    FakeEventClient,
    _FakeSpeech,
    _QnaEventClient,
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


_GOODBYE_TEXT = (
    "Thanks so much for your time today — the team will be in touch about "
    "next steps. Take care, bye."
)
#: The RCA shape: the model disobeyed "do not ask another question" on the
#: terminal turn and asked one — playout completed cleanly.
_DISOBEDIENT_TERMINAL = (
    "Before we finish, one more thing — what is your current CTC?"
)


class _Call2Harness(unittest.IsolatedAsyncioTestCase):
    async def _turn(self, hooks, text):
        ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](
            text, types.SimpleNamespace(text_content=text), ctx,
        )
        return ctx

    async def _drain(self, predicate, tries=100):
        for _ in range(tries):
            await asyncio.sleep(0.005)
            if predicate():
                return True
        return False

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    def _logs(self, hooks, error_type, category, *, level="info"):
        spy = hooks["log"].warn if level == "warn" else hooks["log"].info
        return [
            c for c in spy.call_args_list
            if c.kwargs.get("error_type") == error_type
            and c.kwargs.get("error_category") == category
        ]


# ── F-P0a: content-gated terminal reply ──────────────────────────────────────

class TestTerminalReplyContentGate(_Call2Harness):
    """Driven through the REAL coordinator: the QnA close arms ``completed`` at
    author-time; `on_reply_delivered` may commit it only for a closing-shaped
    delivered reply."""

    @staticmethod
    def _one_question_state():
        return _default_state(questions=[
            {"key": "k1", "text": "First question?", "mandatory": True, "hint": None},
        ])

    async def _enter_closing_pending(self):
        client = _QnaEventClient()
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", client=client, state=self._one_question_state(),
        )
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "First question?",
            "candidate": "A substantive answer.",
            "message": None,
            "turn_ctx": types.SimpleNamespace(items=[]),
            "probe_used": False,
            "source_event_id": phone.plan_source_event_id("k1"),
        })
        await agent._on_advance()
        # The candidate has nothing else: the LLM-authored close is armed.
        close_ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](
            "Nothing else", types.SimpleNamespace(text_content="Nothing else"),
            close_ctx,
        )
        self.assertEqual(
            agent._closing_state_machine.state.value, "closing_pending",
        )
        return agent, session, state, client, hooks

    async def _finish(self, hooks):
        hooks["reply_handle"][0] = _FakeSpeech()
        hooks["reply_started"].set()
        await hooks["drive_terminal"]()

    async def test_non_goodbye_terminal_speaks_deterministic_closing(self):
        # The LLM's delivered "terminal" reply was ANOTHER QUESTION (call #2:
        # playout completed → goodbye_delivered → room deleted 2s later while
        # the candidate answered). The commit must be refused, the failure
        # logged, and the deterministic closing spoken as its own terminal
        # reply — after which the screening still completes truthfully.
        agent, session, _, client, hooks = await self._enter_closing_pending()
        hooks["latest_assistant"][0] = _DISOBEDIENT_TERMINAL
        await self._finish(hooks)
        self.assertTrue(self._logs(
            hooks, "phone_terminal_reply", "terminal_reply_not_closing",
            level="warn",
        ))
        # The deterministic closing was spoken EXACTLY once (the retry; the
        # teardown fallback must not add a second one — delivery was proven).
        self.assertEqual(
            session.spoken.count(phone.PHONE_ASSESSMENT_CLOSING_TEXT), 1,
        )
        self.assertIn("assessment.completed", client.event_types)

    async def test_goodbye_shaped_terminal_commits_without_extra_closing(self):
        # The obedient case is untouched: a closing-shaped delivered reply
        # commits directly and no deterministic closing is spoken.
        agent, session, _, client, hooks = await self._enter_closing_pending()
        hooks["latest_assistant"][0] = _GOODBYE_TEXT
        await self._finish(hooks)
        self.assertFalse(self._logs(
            hooks, "phone_terminal_reply", "terminal_reply_not_closing",
            level="warn",
        ))
        self.assertNotIn(phone.PHONE_ASSESSMENT_CLOSING_TEXT, session.spoken)
        self.assertIn("assessment.completed", client.event_types)

    def test_the_deterministic_closing_passes_its_own_gate(self):
        # The recovery text must satisfy the very shape predicate that gates
        # the commit — otherwise the recovery could never commit itself.
        self.assertTrue(phone.phone_closing_goodbye_shape(
            phone.PHONE_ASSESSMENT_CLOSING_TEXT,
        ))
        self.assertTrue(phone.phone_closing_goodbye_shape(_GOODBYE_TEXT))
        self.assertFalse(phone.phone_closing_goodbye_shape(
            _DISOBEDIENT_TERMINAL,
        ))

    async def test_t4a_non_closing_after_goodbye_latch_skips_the_extra_closing(self):
        # T4(a) POST-GOODBYE TAIL (Call D): a closing goodbye ALREADY played
        # (goodbye_latched is set — it arms only on uninterrupted closing
        # playout). The candidate said one more thing, the model answered with a
        # NON-closing reply, and the deterministic-closing recovery would speak
        # the closing AGAIN (the extra T27/T28 dead tail). With the latch set the
        # recovery is SKIPPED: no closing is spoken at all (the goodbye is already
        # on the wire), the latched-skip INFO fires, and completion still posts.
        agent, session, _, client, hooks = await self._enter_closing_pending()
        agent._goodbye_latched["value"] = True
        hooks["latest_assistant"][0] = _DISOBEDIENT_TERMINAL
        await self._finish(hooks)
        # The redundant deterministic closing was NOT spoken.
        self.assertNotIn(phone.PHONE_ASSESSMENT_CLOSING_TEXT, session.spoken)
        # It took the latched-skip path (INFO), not the warn recovery.
        self.assertTrue(self._logs(
            hooks, "phone_terminal_reply",
            "terminal_reply_not_closing_latched_skip", level="info",
        ))
        self.assertFalse(self._logs(
            hooks, "phone_terminal_reply", "terminal_reply_not_closing",
            level="warn",
        ))
        # The screening still completes truthfully.
        self.assertIn("assessment.completed", client.event_types)


# ── F-P0c: Q&A rounds per coalesced logical turn ─────────────────────────────

class TestQnaRoundsPerCoalescedTurn(_Call2Harness):
    @staticmethod
    def _one_question_state():
        return _default_state(questions=[
            {"key": "k1", "text": "First question?", "mandatory": True, "hint": None},
        ])

    async def _enter_qna(self):
        client = _QnaEventClient()
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", client=client, state=self._one_question_state(),
        )
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "First question?",
            "candidate": "A substantive answer.",
            "message": None,
            "turn_ctx": types.SimpleNamespace(items=[]),
            "probe_used": False,
            "source_event_id": phone.plan_source_event_id("k1"),
        })
        await agent._on_advance()
        return agent, session, state, client, hooks

    async def test_fragment_split_question_burns_one_round(self):
        # Call #2: one question STT-split into two finals burned TWO of the
        # bounded rounds. With the cap at 2, the second FRAGMENT (arriving
        # while the round-1 reply is still pre-first-audio — the coalescer's
        # structural signal) must NOT trip the cap round.
        with patch.object(phone, "PHONE_QNA_MAX_ROUNDS", 2):
            agent, _, _, client, hooks = await self._enter_qna()
            ctx1 = await self._turn(hooks, "What are the work timings for this role?")
            self.assertIn("anything else", str(ctx1.items).lower())
            # Model the round-1 reply streaming with no first audio yet.
            hooks["reply_started"].set()
            hooks["speech_first_audio"].clear()
            ctx2 = await self._turn(hooks, "And does that also include the weekend shifts?")
            injected = str(ctx2.items).lower()
            self.assertNotIn("before you wrap up", injected)
            self.assertIn("anything else", injected)
            self.assertTrue(self._logs(
                hooks, "phone_turn_fragment", "qna_round_fragment_coalesced",
            ))
            self.assertNotIn("assessment.completed", client.event_types)
            await self._close(hooks)

    async def test_a_real_second_question_still_advances_the_rounds(self):
        # Control: a second question on a DELIVERED prior reply (first audio
        # seen) is a genuine new round and reaches the cap round as before.
        with patch.object(phone, "PHONE_QNA_MAX_ROUNDS", 2):
            agent, _, _, client, hooks = await self._enter_qna()
            await self._turn(hooks, "What are the work timings for this role?")
            hooks["reply_started"].set()
            hooks["speech_first_audio"].set()
            ctx2 = await self._turn(hooks, "And does that also include the weekend shifts?")
            self.assertIn("before you wrap up", str(ctx2.items).lower())
            self.assertFalse(self._logs(
                hooks, "phone_turn_fragment", "qna_round_fragment_coalesced",
            ))
            await self._close(hooks)


# ── F-Q3a: conflict-consumed commit fence ────────────────────────────────────

class TestConflictConsumedCommitFence(_Call2Harness):
    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])

    async def _coordinator(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = state.questions[0].spoken_text
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def test_boundary_on_a_consumed_turn_is_fenced(self):
        # A boundary captured on the SAME logical turn the conflict machinery
        # consumed (pending cleared on arrival) must not advance the cursor —
        # even though `conflict_reply_pending` is no longer set, which is
        # exactly why the pre-existing fence missed it on call #2.
        agent, _, state, client, hooks = await self._coordinator()
        agent._conflict_consumed_turn_seqs.add(4)
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "Tell me about your recent role.",
            "candidate": "I led operations for four years.",
            "message": None,
            "source_event_id": phone.plan_source_event_id("k1"),
            "probe_used": False,
            "ask_delivered": True,
            "expected_index": 0,
            "turn_seq": 4,
        })
        await agent._commit_after_reply()
        self.assertEqual(client.committed_keys, [])
        self.assertTrue(self._logs(
            hooks, "phone_toolless_commit", "conflict_consumed_commit_skipped",
        ))
        # A boundary from a NON-consumed turn commits normally under the same
        # still-owed key — the fence held, it did not lose the answer.
        agent._pending.update({"turn_seq": 5})
        await agent._commit_after_reply()
        self.assertEqual(client.committed_keys, ["k1"])
        await self._close(hooks)

    async def test_consumption_records_the_turn_seq(self):
        # Driven through the REAL hook: a pending clarification reply arriving
        # records its logical turn in the consumed set (the input the fence
        # reads), whichever way the bounded loop resolves it.
        agent, _, _, client, hooks = await self._coordinator()
        agent._conflict_reply_pending.update({
            "value": True,
            "conflict": {
                "resume_fact": "Data Engineer per the resume",
                "spoken_claim": "sales and advisory work",
            },
            "repursued": False,
            "armed_turn": None,
            "armed_turn_seq": 0,
        })
        self.assertEqual(set(agent._conflict_consumed_turn_seqs), set())
        await self._turn(
            hooks, "Yeah but I don't really understand what you mean here.",
        )
        self.assertEqual(set(agent._conflict_consumed_turn_seqs), {1})
        self.assertEqual(client.committed_keys, [])
        await self._close(hooks)


# ── F-Q3b: disposition on coalesced text + split counter-question ────────────

class TestSplitCounterQuestionDisposition(unittest.TestCase):
    NOTICE_Q = "Ask about notice period and practical availability for the role."

    def test_mid_sentence_interrogative_counter_question_is_nonanswer(self):
        # Call #2 turn [10]: STT fragment-splitting stranded the interrogative
        # mid-sentence ("…does…?"), defeating the leading-anchored
        # _QUESTION_OPEN_RE — the turn was scored substantive/ANSWERED.
        text = "The second round, how long does it usually take from your side?"
        self.assertIsNone(
            phone._QUESTION_OPEN_RE.match(text),
            "precondition: the leading-anchored regex must NOT catch this",
        )
        self.assertEqual(
            phone.phone_answer_disposition(self.NOTICE_Q, None, text),
            phone.PHONE_ANSWER_NONANSWER,
        )

    def test_short_question_terminated_answer_that_covers_still_advances(self):
        # A genuine answer with a trailing "?" that COVERS the owed objective
        # is not swept up — only an uncovering counter-question re-asks.
        self.assertEqual(
            phone.phone_answer_disposition(
                self.NOTICE_Q, None, "I can join in 30 days, is that okay?",
            ),
            phone.PHONE_ANSWER_ANSWERED,
        )

    def test_long_question_terminated_turn_is_untouched(self):
        # The catch is bounded to short turns: a long substantive answer that
        # happens to end on a question is not re-classified.
        text = (
            "I have been serving a sixty day notice period and I have already "
            "discussed an early release with my manager, so realistically I "
            "can join within about thirty days of an offer — I hope that "
            "works for the role and the team's timeline, does it?"
        )
        self.assertGreater(len(text.split()), 30)
        self.assertEqual(
            phone.phone_answer_disposition(self.NOTICE_Q, None, text),
            phone.PHONE_ANSWER_ANSWERED,
        )


class TestCoalescedDisposition(_Call2Harness):
    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])

    async def _coordinator(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = state.questions[0].spoken_text
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def test_coalesced_counter_question_reasks_and_holds_cursor(self):
        # Fragment 1 alone reads as a substantive ANSWER and captures the
        # boundary; the coalesced whole is a counter-question. The merged
        # disposition must re-ask the SAME question and the in-flight commit
        # must be fence-skipped — cursor held, nothing committed.
        agent, _, state, client, hooks = await self._coordinator()
        await self._turn(hooks, "I have been working in operations for a while now")
        # The round-trip reply is streaming, no first audio yet: the second
        # final is a continuation fragment of the SAME logical turn.
        stale = _FakeSpeech()
        hooks["reply_handle"][0] = stale
        hooks["reply_started"].set()
        hooks["speech_first_audio"].clear()
        ctx2 = await self._turn(
            hooks, "and the next steps for this role, what does that involve?",
        )
        self.assertTrue(self._logs(
            hooks, "phone_answer_gate", "coalesced_nonanswer_reask",
        ))
        # The advancing reply was interrupted and the SAME question re-asked.
        self.assertEqual(stale.interrupt_calls, [True])
        self.assertIn(state.questions[0].spoken_text, str(ctx2.items))
        self.assertEqual(getattr(agent, "_turn_policy", None), "answer_reask")
        # The in-flight boundary was skipped by the nonanswer fence (it reads
        # the same merged candidate text) — no commit, cursor held.
        for _ in range(30):
            await asyncio.sleep(0.005)
        self.assertEqual(client.committed_keys, [])
        self.assertTrue(self._logs(
            hooks, "phone_toolless_commit", "nonanswer_commit_skipped",
        ))
        await self._close(hooks)

    async def test_interrupted_cap_folds_into_commit_fence_so_mandatory_advances(self):
        # Baseline-fix repair (2026-09-09): the commit-side nonanswer fence must
        # fold `interrupted_reask_counts` into its combined-cap check exactly as
        # the two LIVE gates (agent.py 4460/4548) do. Once the shared re-ask
        # budget for the key is exhausted, a genuine nonanswer boundary must
        # COMMIT (advance) instead of being re-held — otherwise 2a/2b's
        # terminal-advance is defeated on the commit side and a mandatory item
        # (compensation is a LATER key) stays unreachable. Pre-repair the fence
        # composed only answer+drift, so this same turn was skipped (RED: revert
        # the interrupted_reask_counts term → committed_keys == []).
        agent, _, state, client, hooks = await self._coordinator()
        # Exhaust the shared budget for k1 via the interrupted machinery.
        agent._interrupted_reask_counts[state.questions[0].key] = 3  # combined_reask_cap
        await self._turn(hooks, "I have been working in operations for a while now")
        stale = _FakeSpeech()
        hooks["reply_handle"][0] = stale
        hooks["reply_started"].set()
        hooks["speech_first_audio"].clear()
        await self._turn(
            hooks, "and the next steps for this role, what does that involve?",
        )
        for _ in range(30):
            await asyncio.sleep(0.005)
        # Budget exhausted → the nonanswer fence does NOT re-hold; commit proceeds.
        self.assertEqual(client.committed_keys, [state.questions[0].key])
        self.assertFalse(self._logs(
            hooks, "phone_toolless_commit", "nonanswer_commit_skipped",
        ))
        await self._close(hooks)


# ── F-Q3c: honest ask_delivered recording ────────────────────────────────────

class TestHonestAskDelivered(_Call2Harness):
    OFF_OBJECTIVE_PROMPT = "Tell me, what do you usually do on your weekends?"

    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "k1", "text": "Ask about total experience and customer-facing, counselling, advisory, or sales experience.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "Second question?", "mandatory": True, "hint": None},
        ])

    async def _coordinator(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def test_drifted_ask_commits_but_records_ask_delivered_false(self):
        # Non-mandatory question, delivered ask never pursued the key: the
        # exchange still ADVANCES (no new holds — recording only), but the
        # boundary now records ask_delivered=False and the commit logs it, so
        # "committed but never asked" is visible in data.
        agent, _, _, client, hooks = await self._coordinator()
        hooks["latest_assistant"][0] = self.OFF_OBJECTIVE_PROMPT
        await self._turn(
            hooks, "I have four years of customer-facing sales experience.",
        )
        self.assertIs(agent._pending.get("ask_delivered"), False)
        self.assertTrue(await self._drain(
            lambda: client.committed_keys == ["k1"]))
        self.assertTrue(self._logs(
            hooks, "phone_objective_delivery", "committed_without_ask",
        ))
        await self._close(hooks)

    async def test_on_objective_ask_records_true_and_stays_silent(self):
        agent, _, state, client, hooks = await self._coordinator()
        hooks["latest_assistant"][0] = state.questions[0].spoken_text
        await self._turn(
            hooks, "I have four years of customer-facing sales experience.",
        )
        self.assertIs(agent._pending.get("ask_delivered"), True)
        self.assertTrue(await self._drain(
            lambda: client.committed_keys == ["k1"]))
        self.assertFalse(self._logs(
            hooks, "phone_objective_delivery", "committed_without_ask",
        ))
        await self._close(hooks)

    async def test_unpopulated_boundary_is_still_skipped(self):
        # The old gate's real job — never commit an unpopulated pending — is
        # preserved: question is None AND ask_delivered is not True → skip.
        agent, _, _, client, hooks = await self._coordinator()
        await agent._commit_after_reply()
        self.assertEqual(client.committed_keys, [])
        self.assertTrue(self._logs(
            hooks, "phone_toolless_commit", "ask_not_delivered_commit_skipped",
        ))
        await self._close(hooks)


# ── F-Q2a: deterministic-conflict telemetry ──────────────────────────────────

class TestDeterministicConflictTelemetry(_Call2Harness):
    RESUME_FACTS = {"current_role": {"title": "Data Engineer"}}
    CONFLICT_TEXT = "I spent two years in sales and advisory roles."

    @staticmethod
    def _state():
        state = _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])
        state.resume_facts = {"current_role": {"title": "Data Engineer"}}
        return state

    async def _coordinator(self, call_metrics, *, coverage_judge_enabled=True):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
            coverage_judge_enabled=coverage_judge_enabled,
            call_metrics=call_metrics,
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = state.questions[0].spoken_text
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def test_sync_detector_and_probe_delivery_are_counted(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            # Precondition: the detector fires on this answer.
            self.assertIsInstance(
                phone.phone_deterministic_resume_conflict(
                    self.CONFLICT_TEXT, self.RESUME_FACTS,
                ), dict,
            )
            await self._turn(hooks, self.CONFLICT_TEXT)
            self.assertEqual(
                call_metrics["coverage_judge"]["conflict_found_deterministic"], 1,
            )
            # The sync probe has not been proven delivered yet.
            self.assertEqual(
                call_metrics["coverage_judge"]["conflict_probe_delivered"], 0,
            )
            # Playout completes: on_reply_delivered proves delivery by
            # key-presence and closes the found→delivered funnel.
            value = agent._on_reply_delivered(False)
            if asyncio.iscoroutine(value):
                await value
            self.assertEqual(
                call_metrics["coverage_judge"]["conflict_probe_delivered"], 1,
            )
            # The async judge's own bucket is untouched by the sync path.
            self.assertEqual(call_metrics["coverage_judge"]["conflict_found"], 0)
            await self._close(hooks)

    async def test_coalesce_site_detector_is_counted_too(self):
        # The merged-fragment detector site (judge disabled — the coalesce site
        # runs on both lanes) also bumps the deterministic bucket.
        call_metrics = agent_mod._new_phone_call_metrics()
        agent, _, _, _, hooks = await self._coordinator(
            call_metrics, coverage_judge_enabled=False,
        )
        await self._turn(hooks, "I have been working in operations lately")
        hooks["reply_handle"][0] = _FakeSpeech()
        hooks["reply_started"].set()
        hooks["speech_first_audio"].clear()
        await self._turn(hooks, self.CONFLICT_TEXT)
        self.assertEqual(
            call_metrics["coverage_judge"]["conflict_found_deterministic"], 1,
        )
        await self._close(hooks)

    def test_new_bucket_summarizes_with_honest_zero(self):
        snapshot = agent_mod._summarize_phone_call_metrics(
            agent_mod._new_phone_call_metrics(),
        )
        self.assertEqual(
            snapshot["coverage_judge"]["conflict_found_deterministic"], 0,
        )


# ── F-Q4a: the watchdog never speaks over the candidate ──────────────────────

class TestWatchdogSpeechDefer(_Call2Harness):
    async def _coordinator(self, speaking, ended):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
            candidate_speaking=speaking, candidate_speech_ended=ended,
        )
        return agent, session, state, client, hooks

    async def test_recovery_defers_while_speaking_then_fires_on_end(self):
        speaking = {"value": True}
        ended = asyncio.Event()
        agent, session, _, _, hooks = await self._coordinator(speaking, ended)
        before = len(session.spoken)
        with patch.object(agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", 0.01):
            await agent._on_reply_expected()
            await asyncio.sleep(0.1)
            # The watchdog FIRED (deadline elapsed) but the say is deferred —
            # nothing was spoken over the candidate.
            self.assertEqual(len(session.spoken), before)
            self.assertTrue(self._logs(
                hooks, "phone_speech_lifecycle",
                "recovery_deferred_candidate_speaking",
            ))
            # The candidate stops: the deferred recovery fires — it is
            # deferred, never dropped (the barge-in lesson).
            speaking["value"] = False
            ended.set()
            await asyncio.sleep(0.1)
        self.assertEqual(len(session.spoken), before + 1)
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_defer_is_bounded_a_monologue_cannot_silence_recovery(self):
        speaking = {"value": True}
        ended = asyncio.Event()
        agent, session, _, _, hooks = await self._coordinator(speaking, ended)
        before = len(session.spoken)
        with patch.object(agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", 0.01), \
             patch.object(agent_mod, "PHONE_WATCHDOG_SPEECH_DEFER_MAX_SEC", 0.05):
            await agent._on_reply_expected()
            await asyncio.sleep(0.3)
        self.assertEqual(len(session.spoken), before + 1)
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_not_speaking_recovers_immediately_as_before(self):
        speaking = {"value": False}
        ended = asyncio.Event()
        agent, session, _, _, hooks = await self._coordinator(speaking, ended)
        before = len(session.spoken)
        with patch.object(agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", 0.01):
            await agent._on_reply_expected()
            await asyncio.sleep(0.08)
        self.assertEqual(len(session.spoken), before + 1)
        self.assertFalse(self._logs(
            hooks, "phone_speech_lifecycle",
            "recovery_deferred_candidate_speaking",
        ))
        hooks["close_event"].set()
        await hooks["drive_terminal"]()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
