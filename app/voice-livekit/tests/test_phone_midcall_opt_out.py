"""M009 PR-C (C7, W3): mid-call withdrawal — classifier, confirm latch, opt-out.

RCA (e80c5fa3 / 4352df89): after consent only the explicit end-call request
short-circuited. Four decline utterances fell into the callback route and the
answer gate; the bot re-pitched, the leg aborted, and the decliner was
partial-scored as a reject with no suppression.

Pinned here:

* ``phone.classify_midcall_withdrawal`` — every positive and negative class,
  vetoes first (reported speech, hypotheticals, negated negations, now-scoped
  deferrals, object mismatch), and a corpus pass over the existing gate,
  answer and callback fixtures with ZERO new hits;
* the gate's ``_OPT_OUT_RE`` pattern string, byte-identical;
* ``phone.classify_withdrawal_confirm_reply`` — continue / stop / ambiguous;
* the orchestrator inside the REAL ``_run_native_phone_screening``: immediate
  opt-out and withdrawal, decline -> confirm -> continue / stop / ambiguous /
  silence / drop, fragment safety in both directions, a decline during the
  callback negotiation, the dispatcher's ignored-terminal and transport
  fallbacks, and the ``PHONE_MIDCALL_OPT_OUT=off`` kill switch replaying the
  production transcript shape onto today's path;
* the halt registry (11 declared halts) and the teardown label.

No candidate data appears anywhere: every utterance is synthetic.
"""

from __future__ import annotations

import ast
import asyncio
import functools
import inspect
import os
import re
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures


agent_mod = fixtures.agent_mod
phone = fixtures.phone
FakeEventClient = fixtures.FakeEventClient

_TESTS_DIR = Path(__file__).resolve().parent


def _stop_response():
    return sys.modules["livekit.agents"].StopResponse


# ── The classifier ──────────────────────────────────────────────────────


class TestMidcallWithdrawalClassifier(unittest.TestCase):
    OPT_OUT = [
        "Don't call me again.",
        "Please do not call me again.",
        "Do not contact me again, thank you.",
        "Never call me again.",
        "Please stop calling me.",
        "Stop calling me, I'm not interested.",
        "Remove my number from your list.",
        "Please delete my number.",
        "Take me off your calling list.",
        "I don't want to be contacted again.",
        "Don't bother calling me back.",
        "Don't call me anymore.",
        # An opt-out beats an end-call request in the same turn.
        "Stop calling me and hang up.",
        # Curly apostrophes from STT normalise.
        "Don’t call me again.",
    ]
    WITHDRAW = [
        "I want to withdraw my application.",
        "Please withdraw my application.",
        "I'd like to withdraw.",
        "I would like to withdraw from this process.",
        "I'm withdrawing my application.",
        "Please cancel my application.",
        "I have decided to withdraw from the role.",
    ]
    DECLINE = [
        "I'm not interested in this role.",
        "Actually, I'm not interested.",
        "Honestly I am not interested in the job.",
        "No, not interested.",
        "Not interested, thanks.",
        "Sorry, I'm not really interested in this position.",
        "I'm no longer interested.",
        "I didn't apply for this job.",
        "I never applied.",
        "I don't want to continue.",
        "I don't want to continue with the interview.",
        "I don't want this job.",
        "I want to stop here.",
        "I've changed my mind about the role.",
        "We're not interested at all.",
        # A withdrawal ASKED is only a decline: it gets the confirmation.
        "Can I withdraw my application?",
    ]
    NONE = [
        # Object mismatch: an answer about part of the job.
        "I'm not interested in night shifts.",
        "I'm not interested in cold calling, but I love inbound.",
        "I don't want to continue in my current company.",
        "I didn't apply for the loan.",
        "I want to withdraw from my savings account.",
        # Reported speech / objection handling: the sales population.
        "When a customer says I'm not interested, I ask them why.",
        "Customers tell me don't call me again all the time.",
        "They told me to stop calling, so I sent an email instead.",
        "I asked them to remove my number from the list.",
        "Parents often say they are not interested at first.",
        # Hypotheticals and conditionals.
        "If I'm not interested, can I leave?",
        "What if I'm not interested in relocating?",
        "Suppose I don't want this job, what happens?",
        # Negated negations.
        "It's not that I'm not interested.",
        "I never said I'm not interested.",
        # Now-scoped deferrals belong to the callback flow, not to C7.
        "I'm not interested right now, call me later.",
        "I'm busy at the moment, I don't want to continue now.",
        "Don't call me again today, I'm driving.",
        "Stop calling me at work.",
        "Stop calling me now.",
        "Can you call me back later? Now is not a good time.",
        # A decline phrased as a question is nothing.
        "So I'm not interested?",
        # Per-question declines advance, they are not withdrawals.
        "I'd rather not say.",
        "I'm not comfortable sharing that.",
        "I don't know.",
        "No.",
        # End-call is HALT_CANDIDATE_ENDED, unchanged (P6).
        "Please end the call now.",
        "Can you disconnect the call?",
        # Ordinary answers.
        "Yes, that's fine.",
        "I have five years of experience in inside sales.",
        "I am interested in this role.",
        "",
        "   ",
    ]

    def test_opt_out_positives(self):
        for text in self.OPT_OUT:
            with self.subTest(text=text):
                self.assertEqual(
                    phone.classify_midcall_withdrawal(text), phone.MIDCALL_OPT_OUT,
                )

    def test_withdraw_explicit_positives(self):
        for text in self.WITHDRAW:
            with self.subTest(text=text):
                self.assertEqual(
                    phone.classify_midcall_withdrawal(text),
                    phone.MIDCALL_WITHDRAW_EXPLICIT,
                )

    def test_decline_positives(self):
        for text in self.DECLINE:
            with self.subTest(text=text):
                self.assertEqual(
                    phone.classify_midcall_withdrawal(text), phone.MIDCALL_DECLINE,
                )

    def test_negatives(self):
        for text in self.NONE:
            with self.subTest(text=text):
                self.assertIsNone(phone.classify_midcall_withdrawal(text))

    def test_non_string_input_is_none(self):
        for value in (None, 0, b"Don't call me again", object(), ["not interested"]):
            with self.subTest(value=value):
                self.assertIsNone(phone.classify_midcall_withdrawal(value))

    def test_long_input_is_bounded_and_fast(self):
        hostile = ("not " * 3000) + ("m" * 5000) + " interested"
        started = time.monotonic()
        phone.classify_midcall_withdrawal(hostile)
        phone.classify_withdrawal_confirm_reply(hostile)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_the_gate_opt_out_regex_is_byte_identical(self):
        """C7 adds its own strict classifier; the gate's stays untouched."""
        self.assertEqual(
            agent_mod._OPT_OUT_RE.pattern,
            r"do(?:n't| not) (?:ever )?call(?: me)?(?: again)?|stop calling|"
            r"remove (?:my|this) number|take me off",
        )
        self.assertEqual(agent_mod._OPT_OUT_RE.flags & re.IGNORECASE, re.IGNORECASE)


class TestWithdrawalConfirmReply(unittest.TestCase):
    CASES = {
        phone.WITHDRAWAL_REPLY_CONTINUE: [
            "Carry on.", "Let's continue.", "Yes, please continue.", "Go ahead.",
            "No no, let's carry on.", "Don't stop, continue.", "I'm still interested.",
            "Ask me the next question.", "Sorry, I misunderstood, please go on.",
        ],
        phone.WITHDRAWAL_REPLY_STOP: [
            "Stop.", "No, stop here.", "Yes, stop.", "I don't want to continue.",
            "No, I'm not interested.", "Please end the call.", "Bye.",
            "Don't call me again.", "Withdraw my application.", "That's it, I'm done.",
        ],
        phone.WITHDRAWAL_REPLY_AMBIGUOUS: [
            "Yes.", "No.", "Okay.", "Hmm.", "", "I have five years of experience.",
            "Stop or continue, I don't know.",
        ],
    }

    def test_reply_classes(self):
        for expected, texts in self.CASES.items():
            for text in texts:
                with self.subTest(text=text):
                    self.assertEqual(
                        phone.classify_withdrawal_confirm_reply(text), expected,
                    )

    def test_non_string_reply_is_ambiguous(self):
        self.assertEqual(
            phone.classify_withdrawal_confirm_reply(None),
            phone.WITHDRAWAL_REPLY_AMBIGUOUS,
        )


# ── Corpus pass: zero NEW hits over the existing fixtures ────────────────


class TestCorpusHasNoNewHits(unittest.TestCase):
    """Every candidate-shaped string literal in the existing gate, answer,
    callback and call-quality suites is classified. The ONLY hits allowed are
    the pre-consent refusal fixtures below, which the gate already treats as
    refusals/opt-outs; anything else is a new false positive."""

    FILES = (
        "test_phone_gate.py", "test_phone_callback.py", "test_phone_answer.py",
        "test_phone_conversational_gate.py", "test_call_quality_round1.py",
        "test_call_quality_call2_rca.py", "test_call_quality_se_rca.py",
        "test_codex_d_mixed_intent.py", "test_phone_gate_turn_barrier.py",
        "test_closing.py", "test_phone_assessment.py",
    )
    #: Pre-consent gate fixtures (answers to the DISCLOSURE), already
    #: classified opt_out/refused by the gate. Not new hits.
    EXPECTED_GATE_HITS = frozenset({
        "I'm not interested", "I am not interested", "We are not interested",
        "No, not interested.", "Not interested.",
        "understood, but I'm not interested", "no problem but I'm not interested",
        "Don't call me again", "Don't call me again.", "No, don't call me again.",
        "cool, but don't call me again", "Stop calling me", "Stop calling me.",
        "Remove my number", "Remove my number.", "Take me off your list",
        "Take me off your list.",
    })

    @classmethod
    def _corpus(cls):
        for name in cls.FILES:
            path = _TESTS_DIR / name
            if not path.exists():
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                    continue
                value = node.value
                if (
                    "\n" in value or "_" in value or len(value) > 400
                    or len(value.split()) < 2 or not re.search(r"[A-Za-z]", value)
                ):
                    continue
                yield name, value

    def test_zero_new_hits(self):
        seen = 0
        new_hits = []
        for name, value in self._corpus():
            seen += 1
            if phone.classify_midcall_withdrawal(value) is None:
                continue
            if value in self.EXPECTED_GATE_HITS:
                continue
            new_hits.append((name, value))
        self.assertGreater(seen, 1000, "the corpus walk found too few fixtures")
        self.assertEqual(new_hits, [])


# ── Registry, copy, prompt, kill switch ──────────────────────────────────


class TestRegistryAndCopy(unittest.TestCase):
    def test_halt_is_declared_and_not_retryable(self):
        self.assertEqual(phone.HALT_CANDIDATE_OPTED_OUT, "candidate_opted_out")
        self.assertFalse(phone.halt_is_retryable(phone.HALT_CANDIDATE_OPTED_OUT))
        self.assertNotIn(phone.HALT_CANDIDATE_OPTED_OUT, phone.RETRYABLE_HALTS)
        self.assertNotEqual(phone.HALT_CANDIDATE_OPTED_OUT, phone.HALT_CANDIDATE_ENDED)

    def test_teardown_label_is_bounded(self):
        self.assertEqual(
            agent_mod._teardown_label(phone.HALT_CANDIDATE_OPTED_OUT),
            "candidate_opted_out",
        )

    def test_confirm_lines_are_gate_copy(self):
        for line in (
            phone.PHONE_WITHDRAWAL_CONFIRM_TEXT,
            phone.PHONE_WITHDRAWAL_CONFIRM_REASK_TEXT,
            phone.PHONE_OPT_OUT_TEXT,
        ):
            with self.subTest(line=line):
                self.assertTrue(phone.is_gate_copy(line))

    def test_no_new_worker_event_type(self):
        """Allowlist parity: C7 reuses the existing `candidate.opt_out`."""
        self.assertIn("candidate.opt_out", phone.PHONE_WORKER_EVENTS)

    def test_kill_switch_reads_the_literal_off(self):
        for value, enabled in (
            (None, True), ("", True), ("on", True), ("ON", True), ("true", True),
            ("off", False), (" OFF ", False), ("Off", False),
        ):
            with self.subTest(value=value):
                env = {} if value is None else {"PHONE_MIDCALL_OPT_OUT": value}
                with patch.dict(phone.os.environ, env, clear=False):
                    if value is None:
                        phone.os.environ.pop("PHONE_MIDCALL_OPT_OUT", None)
                    self.assertEqual(phone.phone_midcall_opt_out_enabled(), enabled)

    def test_prompt_addendum_is_phone_only_and_switchable(self):
        state = fixtures._default_state()
        with patch.dict(phone.os.environ, {"PHONE_MIDCALL_OPT_OUT": "on"}):
            on_text = agent_mod._phone_instructions_text(state)
        with patch.dict(phone.os.environ, {"PHONE_MIDCALL_OPT_OUT": "off"}):
            off_text = agent_mod._phone_instructions_text(state)
        self.assertIn(phone.PHONE_WITHDRAWAL_POLICY_TEXT, on_text)
        self.assertNotIn(phone.PHONE_WITHDRAWAL_POLICY_TEXT, off_text)
        # Appended after the callback policy, never inside prompting.py.
        self.assertGreater(
            on_text.index(phone.PHONE_WITHDRAWAL_POLICY_TEXT),
            on_text.index(phone.PHONE_CALLBACK_POLICY_TEXT),
        )
        prompting_src = (_TESTS_DIR.parent / "prompting.py").read_text(encoding="utf-8")
        self.assertNotIn("Withdrawal policy", prompting_src)

    def test_env_contract_declares_the_kill_switch(self):
        root = _TESTS_DIR.parent.parent.parent
        schema = (root / "config" / "environment.schema.json").read_text(encoding="utf-8")
        self.assertIn('"PHONE_MIDCALL_OPT_OUT"', schema)
        example = (_TESTS_DIR.parent / ".env.example").read_text(encoding="utf-8")
        self.assertIn("PHONE_MIDCALL_OPT_OUT=on", example)


# ── The orchestrator, against the REAL coordinator ───────────────────────


async def _make_coordinator(*, client=None, state=None):
    """`fixtures._make_native_coordinator`, plus the silence-loop events.

    Identical construction (toolless lane); it additionally exposes
    `agent_listening`, `candidate_activity` and the hang-up helper, which the
    shared factory keeps private.
    """
    class BaseAgent:
        def __init__(self, instructions=""):
            self.instructions = instructions

    agent = phone.phone_agent_class(BaseAgent)(
        "instructions", client=FakeEventClient(), attempt_id=fixtures._ATTEMPT_ID,
        say=AsyncMock(), native_turns=True, turn_mode="toolless",
    )
    session = fixtures._InertSession()
    state = state if state is not None else fixtures._default_state()
    client = client if client is not None else FakeEventClient()
    events = {
        name: asyncio.Event() for name in (
            "candidate_end_requested", "reply_started", "speech_first_audio",
            "assistant_delivery_complete", "candidate_activity",
            "agent_listening", "agent_activity_changed", "close_event",
        )
    }
    latest_assistant: list = [None]
    latest_assistant_anchor: list = [None]
    reply_handle: list = [None]
    spy = MagicMock(wraps=agent_mod._log)
    log_patch = patch.object(agent_mod, "_log", spy)
    log_patch.start()
    task = asyncio.ensure_future(
        agent_mod._run_native_phone_screening(
            session=session, agent=agent, events=client, state=state,
            attempt_id=fixtures._ATTEMPT_ID, session_id=fixtures._SESSION_ID,
            room_name=fixtures._PHONE_ROOM,
            result=phone.PhoneGateResult(phone.CLASSIFY_HUMAN, assessment_allowed=True),
            latest_assistant=latest_assistant,
            latest_assistant_anchor=latest_assistant_anchor,
            latest_candidate_anchor=[None],
            candidate_end_requested=events["candidate_end_requested"],
            reply_started=events["reply_started"],
            speech_first_audio=events["speech_first_audio"],
            speech_sequence=[0], reply_handle=reply_handle,
            assistant_delivery_complete=events["assistant_delivery_complete"],
            candidate_activity=events["candidate_activity"],
            agent_listening=events["agent_listening"],
            agent_activity_changed=events["agent_activity_changed"],
            close_event=events["close_event"],
            turn_mode="toolless",
        )
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if getattr(agent, "_on_user_turn", None) is not None:
            break
    return types.SimpleNamespace(
        agent=agent, session=session, state=state, client=client, task=task,
        log=spy, log_patch=log_patch, reply_handle=reply_handle, **events,
    )


class _OrchestratorCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._env = patch.dict(os.environ, {"PHONE_MIDCALL_OPT_OUT": "on"})
        self._env.start()
        self.addCleanup(self._env.stop)
        self._fast_retry = patch.object(
            agent_mod, "_post_phone_event_with_retry",
            functools.partial(agent_mod._post_phone_event_with_retry, delay_sec=0),
        )
        self._fast_retry.start()
        self.addCleanup(self._fast_retry.stop)

    async def _turn(self, c, text, *, continuation=False):
        """One candidate final. `continuation` models a second STT final that
        lands while the previous reply is still pre-first-audio."""
        if continuation:
            c.reply_started.set()
        ctx = types.SimpleNamespace(items=[])
        try:
            await c.agent._on_user_turn(
                text, types.SimpleNamespace(text_content=text), ctx,
            )
            swallowed = False
        except _stop_response():
            swallowed = True
        return str(ctx.items), swallowed

    async def _deliver_and_finish(self, c):
        """The armed terminal reply plays cleanly, then teardown runs."""
        delivered = getattr(c.agent, "_on_reply_delivered", None)
        if callable(delivered):
            value = delivered(False)
            if inspect.isawaitable(value):
                await value
        await self._await_task(c)

    async def _hang_up(self, c):
        c.close_event.set()
        await self._await_task(c)

    async def _await_task(self, c):
        with patch.object(agent_mod, "PHONE_TERMINAL_REPLY_TIMEOUT_SEC", 0.05), \
             patch.object(agent_mod, "PHONE_FAREWELL_PLAYOUT_FLOOR_SEC", 0.05), \
             patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock):
            await asyncio.wait_for(c.task, timeout=5)
        c.log_patch.stop()

    @staticmethod
    def _categories(spy, error_type, level=None):
        levels = (level,) if level else ("info", "warn")
        return [
            call.kwargs.get("error_category")
            for lvl in levels
            for call in getattr(spy, lvl).call_args_list
            if call.kwargs.get("error_type") == error_type
        ]

    def _assert_opted_out(self, c, *, expected_events=("candidate.opt_out",)):
        self.assertEqual(c.client.event_types, list(expected_events))
        self.assertIn(
            "candidate_opted_out", self._categories(c.log, "phone_room_teardown", "info"),
        )
        self.assertEqual(c.client.committed_keys, [])


class TestImmediateExits(_OrchestratorCase):
    async def test_opt_out_ends_immediately_with_candidate_opt_out(self):
        c = await _make_coordinator()
        injected, _ = await self._turn(c, "Please don't call me again.")
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, injected)
        self.assertNotIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, injected)
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)
        self.assertNotIn("assessment.aborted", c.client.event_types)
        self.assertIn("opt_out", self._categories(c.log, "phone_midcall_withdrawal"))

    async def test_explicit_withdrawal_ends_immediately(self):
        c = await _make_coordinator()
        injected, _ = await self._turn(c, "I want to withdraw my application.")
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, injected)
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)

    async def test_opt_out_beats_an_end_call_in_the_same_turn(self):
        c = await _make_coordinator()
        await self._turn(c, "Stop calling me and hang up.")
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)

    async def test_an_explicit_end_call_is_unchanged(self):
        c = await _make_coordinator()
        await self._turn(c, "Please end the call now.")
        await self._deliver_and_finish(c)
        self.assertEqual(c.client.event_types, ["assessment.aborted"])

    async def test_a_per_question_decline_still_falls_through(self):
        c = await _make_coordinator()
        injected, _ = await self._turn(c, "I'd rather not say.")
        self.assertNotIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, injected)
        self.assertNotIn(phone.PHONE_OPT_OUT_TEXT, injected)
        await self._hang_up(c)
        self.assertNotIn("candidate.opt_out", c.client.event_types)


class TestDeclineConfirmLatch(_OrchestratorCase):
    async def test_decline_asks_once_then_stop_opts_out(self):
        c = await _make_coordinator()
        injected, _ = await self._turn(c, "Honestly, I'm not interested in this role.")
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, injected)
        self.assertEqual(c.client.event_types, [])
        injected, _ = await self._turn(c, "Yes, please stop.")
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, injected)
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)
        categories = self._categories(c.log, "phone_midcall_withdrawal")
        self.assertIn("decline_confirm_asked", categories)
        self.assertIn("confirmed_stop", categories)

    async def test_decline_then_continue_reasks_the_same_owed_question(self):
        c = await _make_coordinator()
        owed = c.state.question_at(c.state.cursor)
        await self._turn(c, "I'm not interested.")
        injected, _ = await self._turn(c, "Sorry, let's carry on.")
        self.assertIn(owed.spoken_text, injected)
        self.assertNotIn(phone.PHONE_OPT_OUT_TEXT, injected)
        self.assertIn(
            "confirmed_continue", self._categories(c.log, "phone_midcall_withdrawal"),
        )
        # A later decline-shaped turn is an answer now: no second confirm.
        injected, _ = await self._turn(c, "No, not interested.")
        self.assertNotIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, injected)
        self.assertIn(
            "decline_ignored_after_continue",
            self._categories(c.log, "phone_midcall_withdrawal"),
        )
        # ...but a contact-level opt-out still ends the call.
        injected, _ = await self._turn(c, "Actually, don't call me again.")
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, injected)
        await self._deliver_and_finish(c)
        self.assertEqual(c.client.event_types, ["candidate.opt_out"])

    async def test_ambiguous_gets_one_reask_then_opts_out(self):
        c = await _make_coordinator()
        await self._turn(c, "I didn't apply for this job.")
        injected, _ = await self._turn(c, "Yes.")
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_REASK_TEXT, injected)
        injected, _ = await self._turn(c, "Okay.")
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, injected)
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)
        self.assertIn(
            "ambiguous_after_reask", self._categories(c.log, "phone_midcall_withdrawal"),
        )

    async def test_ambiguous_then_continue_resumes(self):
        c = await _make_coordinator()
        await self._turn(c, "I'm not interested.")
        await self._turn(c, "Hmm, okay.")
        injected, _ = await self._turn(c, "Continue, please.")
        owed = c.state.question_at(c.state.cursor)
        self.assertIn(owed.spoken_text, injected)
        await self._hang_up(c)
        self.assertEqual(c.client.event_types, [])

    async def test_latch_then_drop_ends_as_opted_out(self):
        c = await _make_coordinator()
        await self._turn(c, "I'm not interested in this job.")
        await self._hang_up(c)
        self._assert_opted_out(c)
        self.assertIn("latched_drop", self._categories(c.log, "phone_midcall_withdrawal"))

    async def test_latch_then_silence_ends_as_opted_out(self):
        c = await _make_coordinator()
        await self._turn(c, "I'm not interested.")
        with patch.object(agent_mod, "CANDIDATE_SILENCE_PROMPT_SEC", 0.001), \
             patch.object(agent_mod, "CANDIDATE_SILENCE_END_SEC", 0.001), \
             patch.object(agent_mod, "CANDIDATE_SILENCE_SECOND_NUDGE_SEC", 0.001):
            c.agent_listening.set()
            await self._await_task(c)
        self._assert_opted_out(c)
        self.assertIn(
            "latched_silence", self._categories(c.log, "phone_midcall_withdrawal"),
        )

    async def test_without_the_latch_a_drop_is_still_a_nonterminal_disconnect(self):
        c = await _make_coordinator()
        await self._hang_up(c)
        self.assertEqual(c.client.event_types, [])


class TestFragmentSafety(_OrchestratorCase):
    async def test_a_decline_split_across_two_finals_is_heard(self):
        c = await _make_coordinator()
        first, _ = await self._turn(c, "I'm not.")
        self.assertNotIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, first)
        second, _ = await self._turn(c, "Interested in this role.", continuation=True)
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, second)
        await self._turn(c, "Stop.")
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)

    async def test_a_latch_released_by_its_continuation_reasks_the_question(self):
        c = await _make_coordinator()
        owed = c.state.question_at(c.state.cursor)
        first, _ = await self._turn(c, "I'm not interested.")
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, first)
        second, _ = await self._turn(c, "In night shifts, though.", continuation=True)
        self.assertIn(owed.spoken_text, second)
        self.assertIn(
            "latch_released_fragment", self._categories(c.log, "phone_midcall_withdrawal"),
        )
        await self._hang_up(c)
        # Released: the drop is an ordinary non-terminal disconnect.
        self.assertEqual(c.client.event_types, [])

    async def test_a_continuation_that_keeps_the_decline_is_swallowed(self):
        c = await _make_coordinator()
        await self._turn(c, "I'm not interested.")
        _, swallowed = await self._turn(c, "Sorry.", continuation=True)
        self.assertTrue(swallowed)
        await self._turn(c, "Stop.")
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)

    async def test_a_fragmented_confirm_reply_is_decided_on_the_joined_text(self):
        c = await _make_coordinator()
        await self._turn(c, "I'm not interested.")
        first, _ = await self._turn(c, "Uh.")
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_REASK_TEXT, first)
        second, _ = await self._turn(c, "Carry on.", continuation=True)
        owed = c.state.question_at(c.state.cursor)
        self.assertIn(owed.spoken_text, second)
        await self._hang_up(c)
        self.assertEqual(c.client.event_types, [])


class TestDeclineDuringCallback(_OrchestratorCase):
    async def test_a_decline_beats_the_callback_negotiation(self):
        c = await _make_coordinator()
        text = "Can you call me back later? Now is not a good time."
        self.assertEqual(phone.candidate_turn_route(text), "callback_deferral")
        await self._turn(c, text)
        injected, _ = await self._turn(c, "Actually, I'm not interested in this role.")
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, injected)
        await self._turn(c, "Stop, please.")
        await self._deliver_and_finish(c)
        self._assert_opted_out(c)
        self.assertNotIn("callback.deferred_in_call", c.client.event_types)


class TestDispatcherFallbacks(_OrchestratorCase):
    async def test_ignored_terminal_posts_no_fallback(self):
        client = FakeEventClient(outcomes={
            "candidate.opt_out": phone.PhoneApiOutcome(
                False, "ignored", ignored_reason="terminal",
            ),
        })
        c = await _make_coordinator(client=client)
        await self._turn(c, "Don't call me again.")
        await self._deliver_and_finish(c)
        self.assertEqual(c.client.event_types, ["candidate.opt_out"])
        self.assertEqual(
            self._categories(c.log, "phone_opt_out_not_applied", "warn"),
            ["ignored_terminal"],
        )

    async def test_another_ignore_falls_back_to_aborted(self):
        client = FakeEventClient(outcomes={
            "candidate.opt_out": phone.PhoneApiOutcome(
                False, "ignored", ignored_reason="stale_epoch",
            ),
        })
        c = await _make_coordinator(client=client)
        await self._turn(c, "Don't call me again.")
        await self._deliver_and_finish(c)
        self.assertEqual(
            c.client.event_types, ["candidate.opt_out", "assessment.aborted"],
        )
        self.assertEqual(
            self._categories(c.log, "phone_opt_out_not_applied", "warn"),
            ["fallback_aborted"],
        )

    async def test_transport_failure_falls_back_to_aborted(self):
        client = FakeEventClient(outcomes={
            "candidate.opt_out": phone.PhoneApiOutcome(
                False, None, error_category="transport_error",
            ),
        })
        c = await _make_coordinator(client=client)
        await self._turn(c, "Don't call me again.")
        await self._deliver_and_finish(c)
        types_ = c.client.event_types
        self.assertGreaterEqual(types_.count("candidate.opt_out"), 1)
        self.assertEqual(types_[-1], "assessment.aborted")
        self.assertEqual(types_.count("assessment.aborted"), 1)
        self.assertIn(
            "fallback_aborted", self._categories(c.log, "phone_opt_out_not_applied", "warn"),
        )


class TestKillSwitch(_OrchestratorCase):
    #: The production shape (e80c5fa3 / 4352df89): four decline utterances in
    #: one screening. Synthetic wording, no candidate data.
    PROD_SHAPE = (
        "Honestly, I'm not interested in this role.",
        "I didn't apply for this job.",
        "Not interested, sorry.",
        "I am not interested.",
    )

    async def _replay(self, value):
        with patch.dict(os.environ, {"PHONE_MIDCALL_OPT_OUT": value}):
            c = await _make_coordinator()
            injected = []
            for text in self.PROD_SHAPE:
                ctx, _ = await self._turn(c, text)
                injected.append(ctx)
            await self._hang_up(c)
        return c, injected

    async def test_off_replays_the_production_transcript_onto_todays_path(self):
        c, injected = await self._replay("off")
        for ctx in injected:
            self.assertNotIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, ctx)
            self.assertNotIn(phone.PHONE_OPT_OUT_TEXT, ctx)
        self.assertNotIn("candidate.opt_out", c.client.event_types)
        self.assertEqual(self._categories(c.log, "phone_midcall_withdrawal"), [])

    async def test_on_the_same_transcript_asks_the_confirmation(self):
        c, injected = await self._replay("on")
        self.assertIn(phone.PHONE_WITHDRAWAL_CONFIRM_TEXT, injected[0])
        # The second utterance answers the confirmation with a withdrawal
        # class (a STOP reply), so the opt-out closing is armed; the hang-up
        # before it finished playing still ends the leg as an opt-out.
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, injected[1])
        self.assertEqual(c.client.event_types, ["candidate.opt_out"])
        self.assertIn("armed_drop", self._categories(c.log, "phone_midcall_withdrawal"))


class TestOptOutTerminalSource(unittest.TestCase):
    """Structural pins on the dispatcher branch."""

    def test_branch_posts_candidate_opt_out_with_bounded_fallback(self):
        src = inspect.getsource(agent_mod._run_native_phone_screening)
        start = src.index("elif reason == phone.HALT_CANDIDATE_OPTED_OUT:")
        end = src.index("elif reason in {", start)
        branch = src[start:end]
        self.assertIn('"candidate.opt_out"', branch)
        self.assertIn('"assessment.aborted"', branch)
        self.assertIn('"terminal"', branch)
        self.assertIn("phone_opt_out_not_applied", branch)
        self.assertNotIn("sip.participant_left", branch)


if __name__ == "__main__":
    unittest.main()
