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


# ── M013 S01 T08b: the Q1 gap, and the role line composed during consent ────

ROLE = "Sales Program Advisor"
REPHRASED_Q1 = "To start us off, what kind of work are you doing right now?"
COMPOSED_ROLE_LINE = (
    f"Perfect, so this chat is about the {ROLE} role at Interview Kickstart "
    "— let's get into it."
)


def _q1_state(*, cursor=0, role_title=ROLE):
    payload = tpg._plan_payload(
        cursor=cursor, completed=["k1"] if cursor else None, role_title=role_title)
    state = phone.PhoneAssessmentState.parse(payload)
    assert state.ok, state.status
    return state


class TestQ1Prefetch(unittest.IsolatedAsyncioTestCase):
    """`phone_start_q1_prefetch` / `phone_take_q1_prefetch` on their own."""

    def _patch_rephrase(self, *, delay=0.0, hang=False, text=REPHRASED_Q1, error=None):
        self.rephrase_calls: list[str] = []

        async def rephrase(question_text, **_k):
            self.rephrase_calls.append(question_text)
            if hang:
                await asyncio.Event().wait()
            if delay:
                await asyncio.sleep(delay)
            if error is not None:
                raise error
            return text

        patcher = mock.patch.object(phone, "phone_rephrase_first_question", rephrase)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _render(self, *, delay=0.0, frames=("f1", "f2")):
        self.rendered: list[str] = []

        async def render(text):
            self.rendered.append(text)
            if delay:
                await asyncio.sleep(delay)
            return list(frames)
        return render

    async def test_the_rephrase_starts_at_once_and_the_render_uses_its_result(self):
        self._patch_rephrase(delay=0.02)
        prefetch = phone.phone_start_q1_prefetch(_q1_state(), render=self._render())
        await asyncio.sleep(0)
        self.assertEqual(self.rephrase_calls, ["First question?"],
                         "started by the call itself, not on first await")
        self.assertEqual((prefetch.cursor, prefetch.key, prefetch.planned_text),
                         (0, "k1", "First question?"))
        frames = await prefetch.frames_task
        self.assertEqual(self.rendered, [REPHRASED_Q1], "frames match the text spoken")
        self.assertEqual(frames, ["f1", "f2"])

    async def test_a_ready_prefetch_hands_over_text_and_frames(self):
        self._patch_rephrase()
        state = _q1_state()
        prefetch = phone.phone_start_q1_prefetch(state, render=self._render())
        await prefetch.frames_task
        got = await phone.phone_take_q1_prefetch(
            prefetch, cursor=0, question=state.question_at(0))
        self.assertEqual(got, (REPHRASED_Q1, ["f1", "f2"], phone.Q1_PREFETCH_PRERENDERED))

    async def test_without_a_renderer_only_the_text_is_handed_over(self):
        self._patch_rephrase()
        state = _q1_state()
        prefetch = phone.phone_start_q1_prefetch(state)
        self.assertIsNone(prefetch.frames_task)
        got = await phone.phone_take_q1_prefetch(
            prefetch, cursor=0, question=state.question_at(0))
        self.assertEqual(got, (REPHRASED_Q1, None, phone.Q1_PREFETCH_REPHRASED))

    async def test_another_cursor_key_or_text_gets_the_VERBATIM_question(self):
        self._patch_rephrase(hang=True)
        state = _q1_state()
        resumed = _q1_state(cursor=1)
        other_text = phone.PhonePlanQuestion("k1", "A different first question?", True, None)
        for cursor, question in (
            (1, resumed.question_at(1)),     # a reconnect leg at cursor 1
            (0, resumed.question_at(1)),     # another key
            (0, other_text),                 # same key, other planned text
        ):
            with self.subTest(cursor=cursor, key=question.key):
                prefetch = phone.phone_start_q1_prefetch(state, render=self._render())
                got = await phone.phone_take_q1_prefetch(
                    prefetch, cursor=cursor, question=question)
                self.assertEqual(
                    got, (question.spoken_text, None, phone.Q1_PREFETCH_MISMATCH))
                await asyncio.sleep(0)
                self.assertTrue(prefetch.rephrase_task.cancelled())
                self.assertTrue(prefetch.frames_task.cancelled())

    async def test_a_rephrase_still_running_is_cut_at_the_wait(self):
        self._patch_rephrase(hang=True)
        state = _q1_state()
        prefetch = phone.phone_start_q1_prefetch(state, render=self._render())
        loop = asyncio.get_running_loop()
        started = loop.time()
        got = await phone.phone_take_q1_prefetch(
            prefetch, cursor=0, question=state.question_at(0), wait_sec=0.05)
        self.assertLess(loop.time() - started, 0.5)
        self.assertEqual(got, ("First question?", None, phone.Q1_PREFETCH_TIMEOUT))
        await asyncio.sleep(0)
        self.assertTrue(prefetch.rephrase_task.cancelled())

    def test_the_default_wait_is_short(self):
        # The verbatim question is always correct to say; silence is not.
        self.assertLessEqual(phone.PHONE_Q1_PREFETCH_WAIT_SEC, 0.3)

    async def test_a_failed_rephrase_gets_the_verbatim_question(self):
        self._patch_rephrase(error=RuntimeError("provider down"))
        state = _q1_state()
        prefetch = phone.phone_start_q1_prefetch(state, render=self._render())
        await asyncio.wait({prefetch.rephrase_task})
        got = await phone.phone_take_q1_prefetch(
            prefetch, cursor=0, question=state.question_at(0))
        self.assertEqual(got, ("First question?", None, phone.Q1_PREFETCH_ERROR))

    async def test_frames_not_ready_are_dropped_and_the_text_synthesised(self):
        self._patch_rephrase()
        state = _q1_state()
        prefetch = phone.phone_start_q1_prefetch(
            state, render=self._render(delay=10))
        await prefetch.rephrase_task
        got = await phone.phone_take_q1_prefetch(
            prefetch, cursor=0, question=state.question_at(0))
        self.assertEqual(got, (REPHRASED_Q1, None, phone.Q1_PREFETCH_RENDER_UNAVAILABLE))
        await asyncio.sleep(0)
        self.assertTrue(prefetch.frames_task.cancelled())

    async def test_no_prefetch_and_no_question(self):
        self.assertIsNone(await phone.phone_take_q1_prefetch(
            None, cursor=0, question=_q1_state().question_at(0)))
        exhausted = phone.PhoneAssessmentState.parse(
            tpg._plan_payload(cursor=2, completed=["k1", "k2"]))
        self.assertIsNone(phone.phone_start_q1_prefetch(exhausted))
        self.assertIsNone(phone.phone_start_q1_prefetch(
            phone.PhoneAssessmentState(False, "plan_missing")))

    def test_the_prerender_kill_switch(self):
        for value, expected in (("", True), ("true", True), ("off", False),
                                ("false", False), ("0", False), ("no", False)):
            with self.subTest(value=value), \
                    mock.patch.dict(os.environ, {"PHONE_Q1_PRERENDER": value}):
                self.assertIs(phone.phone_q1_prerender_enabled(), expected)


class _CancelProbe:
    """Stands in for a `PhoneQ1Prefetch`: counts cancellations."""

    def __init__(self):
        self.cancels = 0

    def cancel(self):
        self.cancels += 1


class TestGateStartsTheQ1PrefetchAtConsent(unittest.IsolatedAsyncioTestCase):
    """`run_phone_gate`: the prefetch and role-compose seams."""

    async def _gate(self, *, decision=phone.CLASSIFY_HUMAN, recorder=None,
                    client=None, **seams):
        recorder = recorder or tpg.Recorder()
        client = client or tpg._AtomicEventClient(state=tpg._default_state(role_title=ROLE))

        async def classify():
            recorder.order.append("classify")
            return decision

        result = await phone.run_phone_gate(
            attempt_id=tpg._ATTEMPT_ID, client=client,
            wait_for_participant=lambda: asyncio.sleep(0, result=tpg._participant()),
            classify=classify, say=recorder.say,
            start_recording=recorder.start_recording,
            classify_timeout_sec=0.05, session_id=tpg._SESSION_ID, epoch=tpg._EPOCH,
            post_call_answered=True, consent_reply_out=["Yes, go ahead."],
            **seams,
        )
        return result, recorder, client

    async def test_the_prefetch_starts_from_the_rpc_state_before_the_role_line(self):
        probe = _CancelProbe()
        seen = []

        def start_q1_prefetch(state):
            seen.append(state)
            recorder.order.append("q1_prefetch")
            return probe

        recorder = tpg.Recorder()
        result, recorder, client = await self._gate(
            recorder=recorder, start_q1_prefetch=start_q1_prefetch)
        self.assertTrue(result.assessment_allowed)
        self.assertIs(result.q1_prefetch, probe)
        self.assertEqual(len(seen), 1)
        self.assertIs(seen[0], result.assessment_state, "the consent/start RPC's state")
        role_line = phone.phone_role_opening_text(ROLE)
        role_say = f"say:{role_line[:24]}"
        self.assertLess(recorder.order.index("q1_prefetch"), recorder.order.index(role_say))
        self.assertEqual(probe.cancels, 0)

    async def test_no_prefetch_on_a_gate_that_does_not_consent(self):
        calls = []
        result, _recorder, _client = await self._gate(
            decision=phone.CLASSIFY_REFUSED,
            start_q1_prefetch=lambda state: calls.append(state))
        self.assertFalse(result.assessment_allowed)
        self.assertEqual(calls, [])
        self.assertIsNone(result.q1_prefetch)

    async def test_a_gate_that_fails_after_the_rpc_cancels_the_prefetch(self):
        probe = _CancelProbe()

        class _BrokenRecorder(tpg.Recorder):
            async def start_recording(self):
                raise RuntimeError("egress boom")

        with self.assertRaises(RuntimeError):
            await self._gate(recorder=_BrokenRecorder(),
                             start_q1_prefetch=lambda state: probe)
        self.assertEqual(probe.cancels, 1)

    async def test_a_failing_seam_never_fails_the_gate(self):
        def boom(_state):
            raise RuntimeError("prefetch boom")
        result, _recorder, _client = await self._gate(start_q1_prefetch=boom)
        self.assertTrue(result.assessment_allowed)
        self.assertIsNone(result.q1_prefetch)

    async def test_the_role_compose_starts_once_before_the_consent_line(self):
        recorder = tpg.Recorder()
        fired = []

        def start_role_compose():
            fired.append(1)
            recorder.order.append("role_compose")

        result, recorder, _client = await self._gate(
            recorder=recorder, start_role_compose=start_role_compose)
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(len(fired), 1)
        disclosure = next(i for i, step in enumerate(recorder.order)
                          if step.startswith("say:"))
        self.assertLess(recorder.order.index("role_compose"), disclosure)
        self.assertLess(recorder.order.index("role_compose"),
                        recorder.order.index("classify"))

    def test_the_result_defaults_to_no_prefetch(self):
        self.assertIsNone(phone.PhoneGateResult(phone.CLASSIFY_HUMAN).q1_prefetch)


class _TimedTTS:
    """`session.tts`: renders a few frames after a delay (fake synthesis)."""

    def __init__(self, render_sec):
        self.render_sec = render_sec
        self.texts: list[str] = []

    def synthesize(self, text):
        self.texts.append(text)
        tts = self

        async def _frames():
            await asyncio.sleep(tts.render_sec)
            for index in range(3):
                yield types.SimpleNamespace(frame=f"frame-{index}")

        return _frames()


class _TimedSession(tpg._FakePhoneSession):
    """A fake session whose lines take time to play, with a fake TTS.

    On-demand synthesis costs `TTFB_SEC` before first audio; a line given
    pre-rendered `audio` starts at once. A line's conversation item lands at
    the end of its playout, as on the real SDK.
    """

    ROLE_SEC = 0.6
    LINE_SEC = 0.02
    TTFB_SEC = 0.3

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.tts = _TimedTTS(0.1)
        self.say_log: list[tuple[str, bool]] = []
        self.first_frame: dict[str, float] = {}
        self.role_end: float | None = None

    def say(self, text, **kwargs):
        loop = asyncio.get_running_loop()
        has_audio = kwargs.get("audio") is not None
        self.say_log.append((text, has_audio))
        start = loop.time() + (0.0 if has_audio else self.TTFB_SEC)
        self.first_frame.setdefault(text, start)
        is_role = ROLE in text
        playout = start - loop.time() + (self.ROLE_SEC if is_role else self.LINE_SEC)
        session = self

        class _Speech:
            interrupted = False

            def interrupt(self, **_k):
                return self

            async def wait_for_playout(self):
                await asyncio.sleep(playout)
                if is_role:
                    session.role_end = loop.time()
                # The item (and, for a question, the scripted answer) lands now.
                tpg._FakePhoneSession.say(session, text)

        return _Speech()


class _SlowGateWritesClient(tpg._AtomicEventClient):
    """Gate rows are slow to write, screening rows fast: a screening row that
    did not wait for the gate flush would land FIRST."""

    # Longer than the 400 ms target on its own, so a flush awaited in front
    # of Q1 (the old order) fails the gap test too.
    GATE_WRITE_SEC = 0.45

    def __init__(self, *, preloaded=None, **kwargs):
        super().__init__(**kwargs)
        self._preloaded = preloaded

    async def commit_item_turn(self, session_id, speaker, text, source_item_id,
                               turn_started_at_ms=None, *, is_gate=False):
        await asyncio.sleep(self.GATE_WRITE_SEC if is_gate else 0.01)
        return await super().commit_item_turn(
            session_id, speaker, text, source_item_id, turn_started_at_ms,
            is_gate=is_gate)

    async def fetch_assessment_state(self, _session_id):
        # The pre-call projection: the role title is known before the call.
        return self._preloaded


class TestQ1GapEndToEnd(unittest.IsolatedAsyncioTestCase):
    """The real `_run_phone_session`, with fake TTS timings (roadmap 7)."""

    REPHRASE_SEC = 0.5
    COMPOSE_SEC = 0.2

    def setUp(self):
        self.rephrase_at: list[tuple[float, str]] = []
        self.compose_at: list[tuple[float, str]] = []

    async def _run(self, *, pre_title=ROLE, server_title=ROLE, consent_sec=0.3):
        loop = asyncio.get_running_loop()

        async def rephrase(question_text, **_k):
            self.rephrase_at.append((loop.time(), question_text))
            await asyncio.sleep(self.REPHRASE_SEC)
            return REPHRASED_Q1

        async def compose_role(role_title, **_k):
            self.compose_at.append((loop.time(), role_title))
            await asyncio.sleep(self.COMPOSE_SEC)
            return COMPOSED_ROLE_LINE.replace(ROLE, str(role_title))

        self.classified_at: list[float] = []

        async def classifier(_turns, _say):
            await asyncio.sleep(consent_sec)
            self.classified_at.append(loop.time())
            return phone.CLASSIFY_HUMAN

        async def recording_seam():
            return None

        preloaded = phone.PhoneAssessmentState.parse(
            tpg._plan_payload(role_title=pre_title))
        client = _SlowGateWritesClient(
            preloaded=preloaded, state=tpg._default_state(role_title=server_title))
        tpg._FakePhoneSession.instances = []
        tpg._FakePhoneSession.default_answers = ["First answer."]
        tpg._FakePhoneSession.default_gate_user_turns = []
        ctx = tpg.FakeCtx(tpg._PHONE_ROOM, participants=[tpg._participant()])
        with mock.patch.dict(os.environ, {"PHONE_DETERMINISTIC_OPENER": "false"}), \
                mock.patch.dict(sys.modules, {
                    "livekit.agents.llm": types.SimpleNamespace(ChatContext=_Ctx)}), \
                mock.patch.object(agent_mod, "AgentSession", _TimedSession), \
                mock.patch.object(agent_mod, "persistence", MagicMock()), \
                mock.patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
                mock.patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
                mock.patch.object(phone, "phone_rephrase_first_question", rephrase), \
                mock.patch.object(phone, "phone_compose_role_opening", compose_role), \
                mock.patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC",
                                  tpg._HARNESS_RESIDENCY_SEC):
            os.environ.pop("PHONE_GATE_FLOW", None)
            os.environ.pop("PHONE_Q1_PRERENDER", None)
            await asyncio.wait_for(
                agent_mod._run_phone_session(
                    ctx, tpg._PHONE_ROOM, tpg._ATTEMPT_ID, tpg._EPOCH,
                    client=client, classifier=classifier,
                ),
                timeout=10,
            )
        return tpg._FakePhoneSession.instances[-1], client

    async def test_role_line_end_to_q1_first_frame_is_within_400ms(self):
        session, _client = await self._run()
        self.assertIsNotNone(session.role_end, "the role line played")
        self.assertIn((REPHRASED_Q1, True), session.say_log,
                      "Q1 is the rephrase, played from pre-rendered frames")
        gap = session.first_frame[REPHRASED_Q1] - session.role_end
        self.assertGreaterEqual(gap, 0.0, "Q1 never starts over the role line")
        self.assertLessEqual(gap, 0.4, f"role line end -> Q1 first frame {gap:.3f}s")
        # Non-vacuous: rephrase + gate flush + synthesis, in series (the old
        # order), would have been well over the target.
        self.assertGreater(
            self.REPHRASE_SEC + _SlowGateWritesClient.GATE_WRITE_SEC
            + _TimedSession.TTFB_SEC, 0.4)
        # The rephrase began at consent, under the role line.
        self.assertEqual(len(self.rephrase_at), 1)
        self.assertLess(self.rephrase_at[0][0], session.role_end)
        self.assertEqual(session.tts.texts.count(REPHRASED_Q1), 1)
        # Two utterances: the role line, then Q1 (never merged).
        role_lines = [t for t, _a in session.say_log if ROLE in t]
        self.assertEqual(role_lines, [COMPOSED_ROLE_LINE])
        self.assertNotIn(REPHRASED_Q1, COMPOSED_ROLE_LINE)

    async def test_the_gate_transcript_lands_before_the_first_screening_row(self):
        _session, client = await self._run()
        flags = [row["is_gate"] for row in client.item_turns]
        self.assertIn(True, flags)
        self.assertIn(False, flags, "a screening row was written")
        last_gate = max(i for i, flag in enumerate(flags) if flag)
        first_screening = flags.index(False)
        self.assertLess(last_gate, first_screening, client.item_turns)
        gate_texts = [row["text"] for row in client.item_turns if row["is_gate"]]
        self.assertIn(COMPOSED_ROLE_LINE, gate_texts, "the role line is a gate row")

    async def test_the_role_line_composes_during_the_consent_wait(self):
        session, _client = await self._run(consent_sec=0.3)
        self.assertEqual([title for _t, title in self.compose_at], [ROLE],
                         "composed once, from the pre-call title")
        self.assertLess(self.compose_at[0][0], self.classified_at[0],
                        "started before the consent reply was read")
        self.assertIn(COMPOSED_ROLE_LINE, [t for t, _a in session.say_log])

    async def test_a_changed_role_title_is_composed_again_from_the_server_title(self):
        server = "Senior Sales Program Advisor"
        session, _client = await self._run(pre_title="Inside Sales Advisor",
                                           server_title=server)
        self.assertEqual([title for _t, title in self.compose_at],
                         ["Inside Sales Advisor", server])
        spoken = [t for t, _a in session.say_log]
        self.assertIn(COMPOSED_ROLE_LINE.replace(ROLE, server), spoken)
        self.assertFalse(any("Inside Sales Advisor" in t for t in spoken))


if __name__ == "__main__":
    unittest.main()
