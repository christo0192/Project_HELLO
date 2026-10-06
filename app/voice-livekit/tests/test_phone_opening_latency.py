"""M013 S01 T08a: opening latency (roadmap 10, 11).

* the gate-line compose is capped by `PHONE_GATE_COMPOSE_TIMEOUT_SEC`
  (default 1.5 s, range 0.5-4.0) instead of a fixed 4 s;
* the first line's compose runs ALONGSIDE the SIP output-subscription wait,
  so turn-1 first audio <= subscription + cap, worst case;
* the consent line is composed while the identity reply is being judged, is
  discarded on every route that does not reach consent, and a composed
  consent line carries the disclosure-latency metric;
* rejected drafts are logged with a reason (`phone_gate_compose`);
* no `llm_node` model call on pre-consent turns, and the main prompt's
  prefix cache is warmed on its own, as the system message.

Driven through the real helpers, the real `phone.run_phone_gate`, the real
agent `llm_node`, and the real `_run_phone_session` (fake session). All
candidate text and names are synthetic.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import sys
import time
import types
import unittest
from unittest import mock
from unittest.mock import AsyncMock, MagicMock

from tests import test_phone_gate as tpg  # installs the SDK stub first
from tests.test_phone_conversational_gate import _GateHarness, _RecordingClient

import agent as agent_mod  # noqa: E402
import gate_judge  # noqa: E402
import phone  # noqa: E402

NAME = "Taylor Example"
IDENTITY_LINE = (
    f"Hi, this is Christy, an AI voice assistant calling from {phone._COMPANY} "
    "about your job application. Am I speaking with Taylor?"
)
#: A valid composed consent line after the identity turn (no introduction).
CONSENT_DRAFT = (
    "Before we start, one quick note. "
    + phone.PHONE_DISCLOSURE_RECORDING_SENTENCE + " Is it okay to continue?"
)
#: A valid composed consent line as the FIRST line (deterministic flow).
OPENING_DRAFT = (
    f"Hello, I'm Christy, an AI voice assistant from {phone._COMPANY} "
    "about your application. " + phone.PHONE_DISCLOSURE_RECORDING_SENTENCE
    + " Are you okay to continue?"
)


class _Sink:
    """A structured-log stand-in that keeps the fields (never text)."""

    def __init__(self):
        self.rows: list[dict] = []

    def info(self, *_a, **fields):
        self.rows.append(fields)

    warn = warning = error = info

    def categories(self, error_type, schema=None):
        return [
            r.get("error_category") for r in self.rows
            if r.get("error_type") == error_type
            and (schema is None or r.get("schema") == schema)
        ]


class _Ctx:
    def __init__(self):
        self.items: list[dict] = []

    def add_message(self, **kwargs):
        self.items.append(kwargs)


class _FakeLLM:
    """`session.llm`: `chat(...)` returns an async-context stream of chunks."""

    def __init__(self, chunks=(), *, delay=0.0, hang=False, error=None):
        self.chunks = list(chunks)
        self.delay = delay
        self.hang = hang
        self.error = error
        self.calls = 0
        self.closed = 0

    def chat(self, **_kwargs):
        self.calls += 1
        llm = self

        class _Stream:
            async def __aenter__(self):
                if llm.error is not None:
                    raise llm.error
                return self

            async def __aexit__(self, *_a):
                llm.closed += 1

            async def __aiter__(self):
                if llm.hang:
                    await asyncio.Event().wait()
                if llm.delay:
                    await asyncio.sleep(llm.delay)
                for text in llm.chunks:
                    yield types.SimpleNamespace(delta=types.SimpleNamespace(content=text))

        return _Stream()


def _session_src() -> str:
    return inspect.getsource(agent_mod._run_phone_session)


class TestComposeTimeout(unittest.IsolatedAsyncioTestCase):
    """The compose cap, and the compose running alongside the subscription."""

    def setUp(self):
        self.sink = _Sink()
        patcher = mock.patch.object(agent_mod, "_log", self.sink)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_reader_default_and_clamp(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_GATE_COMPOSE_TIMEOUT_SEC", None)
            self.assertEqual(phone.phone_gate_compose_timeout_sec(), 1.5)
        for raw, expected in (("2", 2.0), ("0.1", 0.5), ("9", 4.0), ("inf", 4.0),
                              ("nan", 1.5), ("garbage", 1.5), ("", 1.5)):
            with self.subTest(raw=raw), mock.patch.dict(
                    os.environ, {"PHONE_GATE_COMPOSE_TIMEOUT_SEC": raw}):
                self.assertEqual(phone.phone_gate_compose_timeout_sec(), expected)

    def test_the_session_compose_uses_the_reader_not_a_fixed_4s(self):
        src = _session_src()
        start = src.index("async def _compose_gate_line")
        body = src[start:src.index("async def speak_opening")]
        self.assertIn("timeout_sec=phone.phone_gate_compose_timeout_sec()", body)
        self.assertNotIn("4.0", body)
        self.assertNotIn("timeout=4", inspect.getsource(agent_mod._compose_gate_draft))

    async def test_a_hanging_model_is_cut_at_the_cap_and_its_stream_closed(self):
        llm = _FakeLLM(hang=True)
        t0 = time.monotonic()
        draft = await agent_mod._compose_gate_draft(
            llm, "instr", timeout_sec=0.1, chat_context_factory=_Ctx)
        elapsed = time.monotonic() - t0
        self.assertIsNone(draft)
        self.assertLess(elapsed, 0.6)
        self.assertEqual(llm.closed, 1, "the provider stream must be closed")
        self.assertIn("timeout", self.sink.categories("phone_gate_compose"))

    async def test_a_composed_line_is_returned_and_logged_ok(self):
        llm = _FakeLLM(["Hi, ", "there?"])
        draft = await agent_mod._compose_gate_draft(
            llm, "instr", timeout_sec=1.0, chat_context_factory=_Ctx,
            schema="identity")
        self.assertEqual(draft, "Hi, there?")
        self.assertEqual(self.sink.categories("phone_gate_compose", "identity"),
                         ["composed_ok"])
        row = [r for r in self.sink.rows if r.get("error_type") == "phone_gate_compose"][0]
        self.assertIn("duration_ms", row)
        self.assertNotIn("Hi", repr(row), "no draft text in the log")

    async def test_an_over_long_line_is_abandoned_and_logged(self):
        llm = _FakeLLM(["x" * 400, "y" * 400])
        draft = await agent_mod._compose_gate_draft(
            llm, "instr", timeout_sec=1.0, chat_context_factory=_Ctx)
        self.assertEqual(draft, "")
        self.assertEqual(self.sink.categories("phone_gate_compose"), ["rejected_too_long"])

    async def test_an_empty_or_failed_compose_is_logged(self):
        empty = await agent_mod._compose_gate_draft(
            _FakeLLM([]), "instr", timeout_sec=1.0, chat_context_factory=_Ctx)
        self.assertEqual(empty, "")
        failed = await agent_mod._compose_gate_draft(
            _FakeLLM(error=RuntimeError("provider down")), "instr",
            timeout_sec=1.0, chat_context_factory=_Ctx)
        self.assertIsNone(failed)
        missing = await agent_mod._compose_gate_draft(
            None, "instr", timeout_sec=1.0, chat_context_factory=_Ctx)
        self.assertIsNone(missing)
        self.assertEqual(self.sink.categories("phone_gate_compose"),
                         ["rejected_empty", "unavailable", "unavailable"])

    async def test_compose_runs_alongside_the_subscription_wait(self):
        async def subscription():
            await asyncio.sleep(0.3)

        async def compose():
            await asyncio.sleep(0.3)
            return "draft"

        t0 = time.monotonic()
        draft = await agent_mod._compose_alongside_subscription(compose, subscription)
        elapsed = time.monotonic() - t0
        self.assertEqual(draft, "draft")
        # In series this is >= 0.6 s; alongside, the longer of the two.
        self.assertLess(elapsed, 0.5)

    async def test_the_draft_is_handed_over_only_after_the_subscription_wait(self):
        order: list[str] = []

        async def subscription():
            await asyncio.sleep(0.15)
            order.append("subscribed")

        async def compose():
            order.append("composed")
            return "draft"

        t0 = time.monotonic()
        await agent_mod._compose_alongside_subscription(compose, subscription)
        self.assertGreaterEqual(time.monotonic() - t0, 0.14)
        self.assertEqual(order, ["composed", "subscribed"])

    async def test_cancelling_the_line_cancels_the_compose(self):
        cancelled = asyncio.Event()

        async def compose():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        async def subscription():
            await asyncio.Event().wait()

        task = asyncio.ensure_future(
            agent_mod._compose_alongside_subscription(compose, subscription))
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        self.assertTrue(cancelled.is_set())

    async def _turn_one(self, llm, *, subscription_sec, cap_sec):
        """The real gate's first line, composed the way the session does it."""
        spoken: list[tuple[float, str]] = []
        t0 = time.monotonic()

        async def subscription():
            await asyncio.sleep(subscription_sec)

        async def compose_gate_line(instruction):
            return await agent_mod._compose_alongside_subscription(
                lambda: agent_mod._compose_gate_draft(
                    llm, instruction, timeout_sec=cap_sec,
                    chat_context_factory=_Ctx),
                subscription,
            )

        async def say(text):
            spoken.append((time.monotonic() - t0, text))

        async def post(_attempt, event, **_kw):
            return phone.PhoneApiOutcome(True, "applied")

        client = types.SimpleNamespace(post_event=post)
        replies = ["Don't call me again"]

        async def next_turn():
            return replies.pop(0) if replies else ""

        with mock.patch.dict(os.environ, {"PHONE_GATE_FLOW": "conversational"}):
            await phone.run_phone_gate(
                attempt_id="synthetic-attempt", client=client,
                wait_for_participant=AsyncMock(return_value=object()),
                classify=AsyncMock(return_value=phone.CLASSIFY_HUMAN), say=say,
                compose_gate_line=compose_gate_line,
                next_candidate_turn=next_turn,
                classify_gate_reply=agent_mod.classify_answer_text,
                candidate_name=NAME, session_id="synthetic-session", epoch=1,
            )
        return spoken

    async def test_turn_one_first_audio_within_subscription_plus_cap_on_a_hung_model(self):
        sub, cap = 0.2, 0.3
        spoken = await self._turn_one(_FakeLLM(hang=True), subscription_sec=sub, cap_sec=cap)
        first_at, first_line = spoken[0]
        self.assertEqual(first_line, phone.phone_identity_text(NAME))
        self.assertLessEqual(first_at, sub + cap)
        # Alongside, not in series: the cap started with the subscription wait.
        self.assertLess(first_at, cap + 0.15)

    async def test_turn_one_speaks_the_composed_line_after_the_subscription(self):
        self.assertIsNone(phone.phone_identity_draft_rejection(IDENTITY_LINE, introduced=False))
        sub = 0.2
        spoken = await self._turn_one(
            _FakeLLM([IDENTITY_LINE], delay=0.15), subscription_sec=sub, cap_sec=1.0)
        first_at, first_line = spoken[0]
        self.assertEqual(first_line, IDENTITY_LINE)
        self.assertGreaterEqual(first_at, sub - 0.02)
        self.assertLess(first_at, sub + 0.12, "compose and wait ran in series")


class TestRejectedDraftsAreLogged(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.sink = _Sink()
        patcher = mock.patch.object(phone, "_log", self.sink)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_identity_rejection_reasons(self):
        cases = {
            None: "empty",
            "   ": "empty",
            IDENTITY_LINE + " " + "x" * 700: "too_long",
            "Hi Taylor. Is this Taylor? Can we talk?": "question_count",
            f"Hi, this is Christy, an AI voice assistant from {phone._COMPANY}. "
            "Is it okay to continue?": "no_identity_ask",
            "Hi there, am I speaking with Taylor?": "no_ai_introduction",
        }
        for draft, reason in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(
                    phone.phone_identity_draft_rejection(draft, introduced=False), reason)
        # An earlier gate line already introduced us: the AI check is waived,
        # exactly as before.
        self.assertIsNone(phone.phone_identity_draft_rejection(
            "Sorry, am I speaking with Taylor?", introduced=True))
        self.assertIsNone(phone.phone_identity_draft_rejection(IDENTITY_LINE, introduced=False))

    def test_consent_rejection_reasons_and_the_bool_is_unchanged(self):
        sentence = phone.PHONE_DISCLOSURE_RECORDING_SENTENCE
        self.assertIsNone(phone.phone_opening_draft_rejection(OPENING_DRAFT))
        self.assertIsNone(phone.phone_opening_draft_rejection(
            CONSENT_DRAFT, identity_done=True))
        self.assertEqual(phone.phone_opening_draft_rejection(
            CONSENT_DRAFT, identity_done=False), "no_ai_introduction")
        self.assertEqual(phone.phone_opening_draft_rejection(None), "empty")
        self.assertEqual(phone.phone_opening_draft_rejection(
            "We record calls. Is it okay to continue?", identity_done=True),
            "no_recording_sentence")
        self.assertEqual(phone.phone_opening_draft_rejection(
            "Hello there.", identity_done=True), "unverified")
        for draft in (OPENING_DRAFT, CONSENT_DRAFT, None, "", "x",
                      f"**{sentence}** Is it okay to continue?"):
            for done in (True, False):
                self.assertEqual(
                    phone.phone_opening_draft_verified(draft, identity_done=done),
                    phone.phone_opening_draft_rejection(draft, identity_done=done) is None)

    def test_a_rejected_consent_draft_is_logged_with_its_reason(self):
        self.assertFalse(phone.phone_opening_draft_verified(
            "We record calls. Is it okay to continue?", identity_done=True))
        self.assertEqual(self.sink.categories("phone_gate_compose", "consent"),
                         ["rejected_no_recording_sentence"])

    def test_a_missing_draft_is_not_logged_as_a_rejection(self):
        self.assertFalse(phone.phone_opening_draft_verified(None))
        self.assertFalse(phone.phone_opening_draft_verified(""))
        self.assertEqual(self.sink.categories("phone_gate_compose"), [])

    async def test_a_rejected_identity_draft_is_logged_and_the_fixed_line_spoken(self):
        spoken: list[str] = []

        async def say(text):
            spoken.append(text)

        async def post(_attempt, _event, **_kw):
            return phone.PhoneApiOutcome(True, "applied")

        replies = ["Don't call me again"]
        with mock.patch.dict(os.environ, {"PHONE_GATE_FLOW": "conversational"}):
            await phone.run_phone_gate(
                attempt_id="synthetic-attempt",
                client=types.SimpleNamespace(post_event=post),
                wait_for_participant=AsyncMock(return_value=object()),
                classify=AsyncMock(return_value=phone.CLASSIFY_HUMAN), say=say,
                compose_gate_line=AsyncMock(return_value="Hi! Is this Taylor? Got a minute?"),
                next_candidate_turn=lambda: asyncio.sleep(0, result=replies.pop(0) if replies else ""),
                classify_gate_reply=agent_mod.classify_answer_text,
                candidate_name=NAME, session_id="synthetic-session", epoch=1,
            )
        self.assertEqual(spoken[0], phone.phone_identity_text(NAME))
        self.assertEqual(self.sink.categories("phone_gate_compose", "identity"),
                         ["rejected_question_count"])


class TestConsentLineComposedDuringIdentityVerdict(unittest.IsolatedAsyncioTestCase):
    """The consent draft starts when the identity reply's turn closes."""

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"PHONE_GATE_FLOW": "conversational"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sink = _Sink()
        log_patch = mock.patch.object(phone, "_log", self.sink)
        log_patch.start()
        self.addCleanup(log_patch.stop)
        self.order: list[str] = []
        self.compose_calls = 0
        self.compose_cancelled = 0

    def _compose(self, *, delay=0.0, hang=False, draft=CONSENT_DRAFT, spoken=None):
        async def compose_opening():
            self.compose_calls += 1
            self.order.append("compose_start")
            try:
                if hang:
                    await asyncio.Event().wait()
                if delay:
                    await asyncio.sleep(delay)
            except asyncio.CancelledError:
                self.compose_cancelled += 1
                if spoken is not None:
                    self.spoken_at_cancel = list(spoken)
                raise
            self.order.append("compose_done")
            return draft
        return compose_opening

    def _judge(self, intents, *, delay=0.0):
        intents = list(intents)

        async def judge_identity(_reply):
            self.order.append("judge_start")
            if delay:
                await asyncio.sleep(delay)
            self.order.append("judge_done")
            return intents.pop(0) if intents else None
        return judge_identity

    async def _gate(self, harness, **overrides):
        kwargs = dict(
            attempt_id="a1", client=_RecordingClient(harness),
            wait_for_participant=lambda: asyncio.sleep(0, result=object()),
            classify=harness.classify, say=harness.say,
            session_id="s1", epoch=1,
            next_candidate_turn=harness.next_candidate_turn,
            speak_gate_line=harness.speak_gate_line,
            mark_question_asked=harness.mark_question_asked,
            candidate_name=NAME,
        )
        kwargs.update(overrides)
        return await phone.run_phone_gate(**kwargs)

    async def test_the_draft_starts_before_the_verdict_and_is_the_line_spoken(self):
        self.assertTrue(phone.phone_opening_draft_verified(CONSENT_DRAFT, identity_done=True))
        h = _GateHarness(replies=["Yes, speaking."], verdicts=[])
        result = await self._gate(
            h, compose_opening=self._compose(delay=0.05),
            judge_identity=self._judge([gate_judge.INTENT_IDENTITY_CONFIRMED], delay=0.1))
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        self.assertLess(self.order.index("compose_start"), self.order.index("judge_done"))
        self.assertEqual(self.compose_calls, 1, "composed once, not again at consent")
        self.assertIn(CONSENT_DRAFT, h.spoken)

    async def test_the_consent_line_waits_for_the_longer_not_the_sum(self):
        h = _GateHarness(replies=["Yes, speaking."], verdicts=[])
        said_at: dict[str, float] = {}
        inner_say = h.say

        async def say(text):
            said_at.setdefault(text, time.monotonic())
            await inner_say(text)

        replied_at: list[float] = []
        inner_next = h.next_candidate_turn

        async def next_turn():
            reply = await inner_next()
            replied_at.append(time.monotonic())
            return reply

        await self._gate(
            h, say=say, next_candidate_turn=next_turn,
            compose_opening=self._compose(delay=0.3),
            judge_identity=self._judge([gate_judge.INTENT_IDENTITY_CONFIRMED], delay=0.3))
        gap = said_at[CONSENT_DRAFT] - replied_at[0]
        # Serial was judge + compose >= 0.6 s.
        self.assertLess(gap, 0.5)
        self.assertGreaterEqual(gap, 0.28)

    async def test_a_judged_opt_out_discards_the_draft_unspoken(self):
        h = _GateHarness(replies=["Please don't call me."], verdicts=[])

        async def slow_say(text):
            await asyncio.sleep(0.01)  # the closing plays for a while
            await _GateHarness.say(h, text)

        result = await self._gate(
            h, say=slow_say, compose_opening=self._compose(hang=True, spoken=h.spoken),
            judge_identity=self._judge([gate_judge.INTENT_OPT_OUT], delay=0.02))
        await asyncio.sleep(0)
        self.assertEqual(result.outcome, phone.CLASSIFY_OPT_OUT)
        self.assertEqual(self.compose_cancelled, 1)
        # Discarded as soon as the route is known: before the closing line,
        # not after it (a draft is never left running behind a terminal).
        self.assertEqual(self.spoken_at_cancel, [phone.phone_identity_text(NAME)])
        self.assertFalse(any(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE in s for s in h.spoken))
        self.assertIn("consent_draft_discarded", self.sink.categories("phone_gate_compose"))

    async def test_a_judged_busy_discards_the_draft_and_takes_the_callback_route(self):
        h = _GateHarness(replies=["I'm busy right now", ""], verdicts=[])
        result = await self._gate(
            h, compose_opening=self._compose(hang=True),
            classify_gate_reply=agent_mod.classify_answer_text,
            judge_identity=self._judge([gate_judge.INTENT_NOT_NOW_BUSY], delay=0.02))
        await asyncio.sleep(0)
        self.assertEqual(result.outcome, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(self.compose_cancelled, 1)
        self.assertFalse(any(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE in s for s in h.spoken))

    async def test_a_re_ask_recomposes_from_the_second_reply(self):
        h = _GateHarness(replies=["No, wrong person.", "Oh sorry, yes it is me."], verdicts=[])
        drafts = [CONSENT_DRAFT.replace("one quick note", "first draft"), CONSENT_DRAFT]
        seen: list[str] = []

        async def compose_opening():
            draft = drafts.pop(0)
            seen.append(draft)
            self.compose_calls += 1
            try:
                await asyncio.sleep(0.2 if len(seen) == 1 else 0)
            except asyncio.CancelledError:
                self.compose_cancelled += 1
                raise
            return draft

        result = await self._gate(
            h, compose_opening=compose_opening,
            # The verdict takes a moment, so the first draft is under way
            # (and has to be discarded) when the re-ask is decided.
            judge_identity=self._judge([gate_judge.INTENT_WRONG_PERSON,
                                        gate_judge.INTENT_IDENTITY_CONFIRMED], delay=0.05))
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        self.assertEqual(self.compose_calls, 2)
        self.assertEqual(self.compose_cancelled, 1, "the first draft is discarded")
        self.assertIn(CONSENT_DRAFT, h.spoken)
        self.assertNotIn(seen[0], h.spoken)

    async def test_a_draft_that_fails_is_the_fixed_continuation(self):
        async def broken():
            raise RuntimeError("compose failed")

        h = _GateHarness(replies=["Yes, speaking."], verdicts=[])
        result = await self._gate(
            h, compose_opening=broken,
            judge_identity=self._judge([gate_judge.INTENT_IDENTITY_CONFIRMED]))
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)

    async def test_the_deterministic_flow_composes_inline_once(self):
        os.environ["PHONE_GATE_FLOW"] = "deterministic"
        h = _GateHarness(replies=["Yes."], verdicts=[])
        result = await self._gate(h, compose_opening=self._compose(draft=OPENING_DRAFT))
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        self.assertEqual(self.compose_calls, 1)
        self.assertEqual(h.spoken[0], OPENING_DRAFT)

    def test_the_consent_instruction_is_verdict_neutral(self):
        src = _session_src()
        body = src[src.index("async def speak_opening"):src.index("async def speak_role_opening")]
        self.assertNotIn("Continue naturally from their", body)
        self.assertIn("Do NOT acknowledge, thank, or", body)
        self.assertIn('schema="consent"', body)


class TestNoStrayPreconsentGeneration(unittest.IsolatedAsyncioTestCase):
    """The REAL phone `llm_node`: no model call before consent."""

    def setUp(self):
        self.sink = _Sink()
        patcher = mock.patch.object(phone, "_log", self.sink)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _agent(self, *, model_sec=0.0):
        calls: list[int] = []

        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.chat_ctx = types.SimpleNamespace(items=[])

            def llm_node(self, chat_ctx, tools, model_settings):
                calls.append(1)

                async def _gen():
                    if model_sec:
                        await asyncio.sleep(model_sec)
                    yield "Sure, let's continue."
                return _gen()

        agent = phone.phone_agent_class(BaseAgent)(
            "instructions", client=None, attempt_id="a1", say=None,
            on_user_turn=lambda *a, **k: None, native_turns=True,
        )
        return agent, calls

    @staticmethod
    async def _drain(agent):
        out = []
        async for chunk in agent.llm_node(types.SimpleNamespace(items=[]), [], None):
            out.append(chunk)
        return out

    async def test_a_preconsent_turn_makes_no_model_call_and_ends_at_once(self):
        agent, calls = self._agent(model_sec=1.0)
        t0 = time.monotonic()
        out = await self._drain(agent)
        self.assertEqual(out, [], "nothing to speak, so no assistant row")
        self.assertEqual(calls, [], "super().llm_node must not run before consent")
        # A slow model cannot hold the reply open: a gate `say` right after a
        # pre-consent final does not queue behind a generated speech.
        self.assertLess(time.monotonic() - t0, 0.05)
        self.assertEqual(self.sink.categories("phone_llm_node"),
                         ["preconsent_generation_skipped"])

    async def test_the_gate_window_and_screening_still_generate(self):
        agent, calls = self._agent()
        agent.set_gate_opening(True)
        await self._drain(agent)
        self.assertEqual(len(calls), 1)
        agent.set_gate_opening(False)
        agent.authorize_screening()
        await self._drain(agent)
        self.assertEqual(len(calls), 2)

    async def test_the_user_turn_is_still_delivered_to_the_gate(self):
        # The skip is in `llm_node`, after the turn hook: the gate's capture
        # (and the gate transcript buffer behind it) still sees the turn. A
        # `StopResponse` in the hook would have dropped the committed row.
        seen: list[str] = []
        agent, calls = self._agent()
        agent._on_user_turn = lambda text, *_a: seen.append(text)
        ctx = types.SimpleNamespace(items=[])
        await agent.on_user_turn_completed(ctx, types.SimpleNamespace(text_content="Yes, go ahead."))
        self.assertEqual(seen, ["Yes, go ahead."])
        self.assertEqual(await self._drain(agent), [])
        self.assertEqual(calls, [])

    def test_an_empty_assistant_item_is_never_persisted(self):
        src = _session_src()
        hook = src[src.index('@session.on("conversation_item_added")'):]
        hook = hook[:hook.index("if role == \"user\":")]
        self.assertIn("if not text:\n            return", hook)


class TestPrefixWarmupCoversTheMainPrompt(unittest.IsolatedAsyncioTestCase):
    """The stray generation is gone, so the dedicated warm-up must seed the
    main prompt's cache on its own: same text, same (system) role."""

    def test_the_session_warms_the_exact_prompt_the_agent_runs_on(self):
        src = _session_src()
        self.assertIn("phone_instructions = _phone_instructions_text(instruction_state)", src)
        self.assertIn("phone.phone_agent_class(Agent)(\n        phone_instructions,", src)
        self.assertIn("phone.phone_warm_prefix_cache(phone_instructions)", src)

    def test_the_warm_request_sends_the_prompt_as_the_system_message(self):
        body = phone.phone_prefix_warm_request_body("SYNTHETIC SYSTEM PROMPT")
        self.assertEqual(body["messages"][0],
                         {"role": "system", "content": "SYNTHETIC SYSTEM PROMPT"})
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertEqual(body["max_tokens"], 1)
        self.assertEqual(body["model"], phone.phone_primary_model())

    async def test_the_default_warm_up_posts_that_request(self):
        post = AsyncMock()
        with mock.patch.object(phone, "phone_llm_api_key", return_value="synthetic-key"), \
                mock.patch.object(phone, "_phone_coverage_transport", return_value=None), \
                mock.patch.object(phone, "call_with_breaker", post):
            await phone.phone_warm_prefix_cache("SYNTHETIC SYSTEM PROMPT")
        post.assert_awaited_once()
        sent = post.await_args.kwargs["json_body"]
        self.assertEqual(sent["messages"][0]["role"], "system")
        self.assertEqual(sent["messages"][0]["content"], "SYNTHETIC SYSTEM PROMPT")

    async def test_a_failing_or_keyless_warm_up_never_raises(self):
        with mock.patch.object(phone, "phone_llm_api_key", return_value="synthetic-key"), \
                mock.patch.object(phone, "_phone_coverage_transport", return_value=None), \
                mock.patch.object(phone, "call_with_breaker",
                                  AsyncMock(side_effect=RuntimeError("down"))):
            self.assertIsNone(await phone.phone_warm_prefix_cache("PROMPT"))
        post = AsyncMock()
        with mock.patch.object(phone, "phone_llm_api_key", return_value=None), \
                mock.patch.object(phone, "call_with_breaker", post):
            self.assertIsNone(await phone.phone_warm_prefix_cache("PROMPT"))
        post.assert_not_awaited()


class TestComposedConsentLineCarriesTheDisclosureMetric(unittest.IsolatedAsyncioTestCase):
    """`voice_phone_participant_to_disclosure_sec` for a COMPOSED consent line."""

    def test_the_first_piece_of_a_composed_line_is_a_disclosure_start(self):
        starts = agent_mod._consent_line_starts(OPENING_DRAFT)
        part_a, part_b = phone.phone_split_consent_line(OPENING_DRAFT)
        self.assertTrue(part_a.strip())
        self.assertTrue(agent_mod._is_disclosure_line_start(part_a.rstrip(), starts))
        self.assertFalse(agent_mod._is_disclosure_line_start(part_b, starts))
        self.assertTrue(agent_mod._is_disclosure_line_start(
            phone.PHONE_DISCLOSURE_TEXT, set()))
        self.assertFalse(agent_mod._is_disclosure_line_start("Hello?", starts))
        self.assertEqual(agent_mod._consent_line_starts(None), set())
        # A line that opens with the sentence is spoken whole.
        whole = phone.PHONE_DISCLOSURE_RECORDING_SENTENCE + " Is it okay to continue?"
        self.assertTrue(agent_mod._is_disclosure_line_start(
            whole, agent_mod._consent_line_starts(whole)))

    async def test_a_session_speaking_a_composed_line_emits_the_metric_once(self):
        emitted: list[tuple[str, float]] = []

        def safe_emit(_fn, name, value, *_a, **_k):
            emitted.append((name, value))

        def chat(**_kwargs):
            return _FakeLLM([OPENING_DRAFT]).chat()

        class _ComposingSession(tpg._FakePhoneSession):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.llm = types.SimpleNamespace(chat=chat)

        tpg._FakePhoneSession.instances = []
        tpg._FakePhoneSession.default_answers = ["Yes, that's fine.", "First answer."]
        tpg._FakePhoneSession.default_gate_user_turns = []
        ctx = tpg.FakeCtx(tpg._PHONE_ROOM, participants=[tpg._participant()])
        client = tpg.FakeEventClient()

        async def classifier(_turns, _say):
            return phone.CLASSIFY_HUMAN

        async def recording_seam():
            return None

        with mock.patch.dict(os.environ, {"PHONE_DETERMINISTIC_OPENER": "false"}), \
                mock.patch.dict(sys.modules, {
                    "livekit.agents.llm": types.SimpleNamespace(ChatContext=_Ctx)}), \
                mock.patch.object(agent_mod, "AgentSession", _ComposingSession), \
                mock.patch.object(agent_mod, "_safe_emit", safe_emit), \
                mock.patch.object(agent_mod, "persistence", MagicMock()), \
                mock.patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
                mock.patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
                mock.patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC",
                                  tpg._HARNESS_RESIDENCY_SEC):
            os.environ.pop("PHONE_GATE_FLOW", None)
            await asyncio.wait_for(
                agent_mod._run_phone_session(
                    ctx, tpg._PHONE_ROOM, tpg._ATTEMPT_ID, tpg._EPOCH,
                    client=client, classifier=classifier,
                ),
                timeout=5,
            )
        session = tpg._FakePhoneSession.instances[-1]
        part_a, part_b = phone.phone_split_consent_line(OPENING_DRAFT)
        self.assertIn(part_a.rstrip(), session.spoken, "the composed line was spoken")
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, session.spoken)
        names = [name for name, _ in emitted]
        self.assertEqual(names.count("voice_phone_participant_to_disclosure_sec"), 1)


if __name__ == "__main__":
    unittest.main()
