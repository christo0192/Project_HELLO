"""Canary-1 (PR105) — the worker half of the owner's own-number test call.

Everything here runs against fakes. No provider, no network, no secret, no real
call, and no LiveKit SDK: the SDK is stubbed the same additive way
``tests/test_phone_gate.py`` stubs it, so this file passes in CI where the
livekit packages are not installed.

The properties this file exists to defend, each with a mutation control:

  * **the canary session starts with recording OFF**, using the SAME imported
    object the production phone session uses. The spoken disclosure says "this
    call is not being recorded"; a dropped or drifted ``record=`` here is not a
    bug, it is the system telling a person something untrue while recording
    them;
  * **the branch needs all three conditions** — the worker's own arming flag,
    the dispatch ``mode``, and the room ``canary`` marker — and a DISARMED
    worker refuses a canary dispatch before ``ctx.connect()``;
  * **the inbound metadata guard is real**, not cited: an unknown key anywhere,
    or a 7+ digit run anywhere, refuses the whole blob;
  * **one canary per process**, so an armed worker is not a standing
    conversational endpoint;
  * **the session opens only after something answers**, never into a ringing
    line;
  * **nothing here can post an event, write a row, or start an assessment.**
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# ── SDK stub (additive — never clobbers a stub another test file installed) ──

def _ensure_stub_sdk() -> None:
    def _module(name: str):
        mod = sys.modules.get(name)
        if mod is None:
            mod = types.ModuleType(name)
            sys.modules[name] = mod
        return mod

    livekit = _module("livekit")
    api = _module("livekit.api")
    agents = _module("livekit.agents")
    plugins = _module("livekit.plugins")
    openai_mod = _module("livekit.plugins.openai")
    sarvam_mod = _module("livekit.plugins.sarvam")
    livekit.api = api
    if not hasattr(api, "LiveKitAPI"):
        api.LiveKitAPI = MagicMock
    if not hasattr(api, "DeleteRoomRequest"):
        api.DeleteRoomRequest = MagicMock
    if not hasattr(agents, "Agent"):
        class _Agent:
            def __init__(self, instructions: str = "") -> None:
                self.instructions = instructions
        agents.Agent = _Agent
    if not hasattr(agents, "AgentSession"):
        class _AgentSession:
            def __init__(self, **kwargs):
                self._handlers = {}

            def on(self, event):
                def deco(fn):
                    self._handlers[event] = fn
                    return fn
                return deco

            async def start(self, **kwargs):
                return None
        agents.AgentSession = _AgentSession
    if not hasattr(agents, "JobContext"):
        class _JobContext:
            def __init__(self, *a, **k):
                self.room = MagicMock()

            async def connect(self):
                return None
        agents.JobContext = _JobContext
    if not hasattr(agents, "WorkerOptions"):
        class _WorkerOptions:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
        agents.WorkerOptions = _WorkerOptions
    if not hasattr(agents, "cli"):
        agents.cli = types.SimpleNamespace(run_app=MagicMock())
    plugins.openai = openai_mod
    plugins.sarvam = sarvam_mod
    for mod, names in ((openai_mod, ("LLM",)), (sarvam_mod, ("STT", "TTS"))):
        for name in names:
            if not hasattr(mod, name):
                setattr(mod, name, type(name, (), {"__init__": lambda self, **k: None}))
    dotenv = _module("dotenv")
    if not hasattr(dotenv, "load_dotenv"):
        dotenv.load_dotenv = MagicMock()


_ensure_stub_sdk()

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402
import phone_canary  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CTX = os.path.dirname(HERE)
with open(os.path.join(CTX, "phone_canary.py"), encoding="utf-8") as _handle:
    PHONE_CANARY_SRC = _handle.read()

_TRIPLE_DOUBLE = re.compile(r'"""[\s\S]*?"""')
_TRIPLE_SINGLE = re.compile(r"'''[\s\S]*?'''")
_LINE_COMMENT = re.compile(r"(?m)^\s*#.*$")


def _code(source: str) -> str:
    """Source with docstrings and comments removed.

    Load-bearing, not cosmetic. ``phone_canary.py``'s own docstring EXPLAINS
    that it never constructs ``PhoneEventClient`` and names none of the worker
    API paths -- so a scan over the raw text is defeated by the very
    documentation that describes the property. The scan has to run on code.
    """
    stripped = _TRIPLE_DOUBLE.sub("", source)
    stripped = _TRIPLE_SINGLE.sub("", stripped)
    return _LINE_COMMENT.sub("", stripped)


PHONE_CANARY_CODE = _code(PHONE_CANARY_SRC)


# ── Fixtures ──────────────────────────────────────────────────────────
# Deliberately free of digit runs, exactly as `ids.ts` guarantees on the
# sending side: a uuid segment may legitimately be all digits, and the inbound
# guard refuses those.

_SESSION_ID = "9caa1e75-2b83-41d7-8f60-1ea55d3c9b02"
_CANARY_ID = "a1b2c3d4"
_ROOM = f"phone-{_SESSION_ID}"


def _dispatch(**over) -> str:
    blob = {
        "session_id": _SESSION_ID,
        "channel": "phone",
        "mode": "canary",
        "canary_id": _CANARY_ID,
    }
    blob.update(over)
    for key in [k for k, v in blob.items() if v is None]:
        del blob[key]
    return json.dumps(blob)


def _room_meta(**over) -> str:
    blob = {
        "session_id": _SESSION_ID,
        "room_name": _ROOM,
        "channel": "phone",
        "canary": True,
    }
    blob.update(over)
    for key in [k for k, v in blob.items() if v is None]:
        del blob[key]
    return json.dumps(blob)


class FakeCtx:
    """JobContext stand-in with an inspectable room and connect() count."""

    def __init__(self, room_name=_ROOM, metadata=None, dispatch=None, participants=None):
        self.room = types.SimpleNamespace(
            name=room_name,
            metadata=metadata,
            remote_participants={p.identity: p for p in (participants or [])},
        )
        self.job = types.SimpleNamespace(room=None, metadata=dispatch)
        self.connected = 0

    async def connect(self):
        self.connected += 1


class _FakeSpeech:
    async def wait_for_playout(self):
        return None


class FakeSession:
    """AgentSession stand-in that RECORDS every start kwarg and spoken line."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.handlers = {}
        self.started_with = None
        self.start_calls = 0
        self.spoken: list[str] = []
        self.replies: list[str] = []
        self.answers: list[str] = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    async def start(self, **kwargs):
        self.start_calls += 1
        self.started_with = kwargs

    def say(self, text, **kwargs):
        self.spoken.append(text)
        # The next scripted answer arrives after the question is asked, exactly
        # as a real candidate's speech would.
        if self.answers:
            self._emit_user(self.answers.pop(0))
        return _FakeSpeech()

    def generate_reply(self, instructions=None, **kwargs):
        self.replies.append(str(instructions or ""))
        return _FakeSpeech()

    def _emit_user(self, text):
        handler = self.handlers.get("conversation_item_added")
        if handler is None:
            return
        item = types.SimpleNamespace(
            role="user", content=[types.SimpleNamespace(text=text)], interrupted=False)
        handler(types.SimpleNamespace(item=item))


def _canary_agent_stub(*, instructions: str):
    """A stand-in for `livekit.agents.Agent` that is as STRICT as the real one.

    `Agent.__init__` is `(self, *, instructions: str, ...)` in the pinned
    1.6.4 series, and `agent.py`'s `Christy` and `phone.py`'s
    `PhoneScreeningAgent` both construct it by keyword. Modelling that here is
    the point: a permissive fake accepts a call the real SDK refuses, and the
    refusal would land at `session.start` -- after the owner had answered the
    phone -- with the whole suite green.
    """
    return types.SimpleNamespace(instructions=instructions)


def _participant(identity="sip_owner"):
    return types.SimpleNamespace(identity=identity)


def _run(coro):
    return asyncio.run(coro)


# ══════════════════════════════════════════════════════════════════════
#  1. The inbound guard — BUILT by PR105, not inherited.
# ══════════════════════════════════════════════════════════════════════

class TestInboundGuard(unittest.TestCase):
    """`_DIGIT_RUN_RE` had ZERO runtime call sites before PR105.

    Its only references were tests asserting an OUTBOUND property of fixed
    spoken copy, and `_json_object` applied no check at all. The design's first
    revision cited it as an existing inbound defence; it was not one. These
    tests cover the guard that was actually built.
    """

    def test_a_valid_canary_dispatch_is_read(self):
        ctx = FakeCtx(dispatch=_dispatch())
        self.assertEqual(phone.canary_mode_of(ctx), "canary")
        self.assertEqual(phone.canary_id_of(ctx), _CANARY_ID)
        self.assertTrue(phone.is_canary_room(_room_meta()))

    def test_an_unknown_key_refuses_the_WHOLE_blob(self):
        # Whole-blob, not per-field: a per-field check reads the fields it
        # knows about and ignores the one somebody added.
        ctx = FakeCtx(dispatch=_dispatch(phone_e164="+919812345670"))
        self.assertIsNone(phone.canary_mode_of(ctx))
        self.assertIsNone(phone.canary_id_of(ctx))
        self.assertFalse(phone.is_canary_room(_room_meta(number="x")))

    def test_a_digit_run_anywhere_refuses_the_whole_blob(self):
        for blob in (
            _dispatch(canary_id="12345678"),
            _dispatch(session_id="11111111-2b83-41d7-8f60-1ea55d3c9b02"),
        ):
            with self.subTest(blob=blob):
                ctx = FakeCtx(dispatch=blob)
                self.assertIsNone(phone.canary_mode_of(ctx))
        self.assertFalse(
            phone.is_canary_room(_room_meta(session_id="11111111-2b83-41d7-8f60-1ea55d3c9b02")))

    def test_POSITIVE_CONTROL_the_guard_can_fire(self):
        # A seeded blob that differs from a good one ONLY by a digit run. If
        # the guard were removed, this would parse.
        seeded = _dispatch(canary_id="12345678")
        payload = json.loads(seeded)
        self.assertEqual(set(payload), phone.CANARY_DISPATCH_KEYS)
        self.assertTrue(re.search(r"\d{7,}", seeded))
        self.assertIsNone(phone.canary_mode_of(FakeCtx(dispatch=seeded)))
        # ...and without the run it parses, so the refusal is ABOUT the run.
        self.assertEqual(phone.canary_mode_of(FakeCtx(dispatch=_dispatch())), "canary")

    def test_wrong_channel_wrong_mode_and_malformed_all_fail_closed(self):
        for blob in (
            _dispatch(channel="browser"),
            _dispatch(mode="production"),
            _dispatch(mode=None),
            "not json",
            "",
            None,
            b"\x00\x01",
            json.dumps(["not", "an", "object"]),
        ):
            with self.subTest(blob=blob):
                self.assertIsNone(phone.canary_mode_of(FakeCtx(dispatch=blob)))

    def test_a_bad_canary_id_shape_is_refused(self):
        for bad in ("A1B2C3D4", "a1b2c3", "a1b2c3d4e5", "../../etc", ""):
            with self.subTest(bad=bad):
                self.assertIsNone(phone.canary_id_of(FakeCtx(dispatch=_dispatch(canary_id=bad))))

    def test_a_production_dispatch_is_not_a_canary(self):
        production = json.dumps({
            "session_id": _SESSION_ID,
            "attempt_id": "3f1c9d40-6f5a-4d2b-9a1e-77c0e2b1a5d3",
            "epoch": 3,
            "channel": "phone",
        })
        ctx = FakeCtx(dispatch=production)
        self.assertIsNone(phone.canary_mode_of(ctx))
        # And it still resolves as production, untouched.
        self.assertEqual(
            phone.attempt_id_from_dispatch_metadata(ctx),
            "3f1c9d40-6f5a-4d2b-9a1e-77c0e2b1a5d3")
        self.assertEqual(phone.epoch_from_dispatch_metadata(ctx), 3)

    def test_a_production_room_is_never_a_canary_room(self):
        # `buildPhoneRoomMetadata` is a literal closed-key constructor that
        # CANNOT emit `canary`. This is the Python-side half of that claim.
        production_room = json.dumps({
            "session_id": _SESSION_ID, "room_name": _ROOM, "channel": "phone",
            "correlation_id": "abc",
        })
        self.assertFalse(phone.is_canary_room(production_room))
        self.assertTrue(phone.is_phone_room(_ROOM, production_room))


# ══════════════════════════════════════════════════════════════════════
#  2. Arming — three conditions, and a disarmed worker refuses inertly.
# ══════════════════════════════════════════════════════════════════════

class TestArming(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        phone_canary.reset_canary_latch()

    async def _entrypoint(self, *, enabled, dispatch, room_metadata):
        env = {"PHONE_CANARY_ENABLED": "true"} if enabled else {}
        ctx = FakeCtx(metadata=room_metadata, dispatch=dispatch,
                      participants=[_participant()])
        ran: list[str] = []

        async def fake_canary(*a, **k):
            ran.append("canary")
            return "canary_completed"

        with patch.dict(os.environ, env, clear=False), \
             patch.object(phone_canary, "run_phone_canary", fake_canary):
            if not enabled:
                os.environ.pop("PHONE_CANARY_ENABLED", None)
            await agent_mod._run_phone_entrypoint(ctx, _ROOM)
        return ctx, ran

    async def test_all_three_conditions_enter_the_branch(self):
        ctx, ran = await self._entrypoint(
            enabled=True, dispatch=_dispatch(), room_metadata=_room_meta())
        self.assertEqual(ran, ["canary"])

    async def test_disarmed_worker_refuses_WITHOUT_connecting(self):
        # This is the mechanism's strongest control: the dispatch carries no
        # attempt id and no epoch, so on any worker that has not been armed it
        # is INERT — `phone_dispatch_unresolved / attempt_id_missing`, returned
        # before `ctx.connect()`.
        ctx, ran = await self._entrypoint(
            enabled=False, dispatch=_dispatch(), room_metadata=_room_meta())
        self.assertEqual(ran, [])
        self.assertEqual(ctx.connected, 0)

    async def test_dispatch_mode_without_the_room_marker_is_refused(self):
        ctx, ran = await self._entrypoint(
            enabled=True, dispatch=_dispatch(),
            room_metadata=json.dumps({"session_id": _SESSION_ID, "room_name": _ROOM,
                                      "channel": "phone"}))
        self.assertEqual(ran, [])
        self.assertEqual(ctx.connected, 0)

    async def test_room_marker_without_the_dispatch_mode_is_refused(self):
        ctx, ran = await self._entrypoint(
            enabled=True, dispatch=json.dumps({
                "session_id": _SESSION_ID, "channel": "phone", "mode": "production",
                "canary_id": _CANARY_ID}),
            room_metadata=_room_meta())
        self.assertEqual(ran, [])
        self.assertEqual(ctx.connected, 0)

    async def test_a_canary_shaped_dispatch_with_a_bad_handle_refuses(self):
        ctx, ran = await self._entrypoint(
            enabled=True, dispatch=_dispatch(canary_id="ZZZZ"), room_metadata=_room_meta())
        self.assertEqual(ran, [])
        self.assertEqual(ctx.connected, 0)

    def test_the_flag_requires_the_literal_true(self):
        for value, expected in (("true", True), ("TRUE", True), ("  true ", True),
                                ("1", False), ("yes", False), ("", False), ("false", False)):
            with self.subTest(value=value):
                with patch.dict(os.environ, {"PHONE_CANARY_ENABLED": value}):
                    self.assertIs(phone.phone_canary_enabled(), expected)


# ══════════════════════════════════════════════════════════════════════
#  3. The call itself — ordering, recording, one-shot, bounds.
# ══════════════════════════════════════════════════════════════════════

class TestCanaryCall(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        phone_canary.reset_canary_latch()

    async def _run(self, *, participant=True, answers=("yes I can hear you",),
                   questions="2", session=None, wait=None):
        ctx = FakeCtx(metadata=_room_meta(), dispatch=_dispatch())
        session = session if session is not None else FakeSession()
        session.answers = list(answers)
        closed: list[str] = []

        async def close_room(name):
            closed.append(name)

        async def wait_for_participant():
            if wait is not None:
                return await wait()
            return _participant() if participant else None

        # The per-answer bound is 30 s in production. Patched here so a test of
        # the SILENT path finishes in milliseconds instead of a minute — the
        # bound itself is asserted separately, against the constant.
        with patch.dict(os.environ, {"PHONE_CANARY_QUESTIONS": questions}), \
             patch.object(phone_canary, "CANARY_ANSWER_TIMEOUT_SEC", 0.01):
            outcome = await phone_canary.run_phone_canary(
                ctx, _ROOM, _CANARY_ID,
                session_factory=lambda: session,
                # KEYWORD-ONLY, deliberately. `livekit-agents` 1.6.4 declares
                # `Agent.__init__(self, *, instructions: str, ...)`, and every
                # other construction of that base class in this repository
                # passes it by keyword. A stub that accepted a positional
                # argument would be a fake more permissive than the real class
                # -- which is exactly how a `TypeError` at `session.start`, on a
                # live call, after the owner answered, stayed invisible.
                agent_factory=_canary_agent_stub,
                close_room=close_room,
                wait_for_participant=wait_for_participant,
            )
        return outcome, ctx, session, closed

    # ── B-1: recording ────────────────────────────────────────────────

    async def test_recording_is_off_and_uses_the_SAME_imported_object(self):
        _, _, session, _ = await self._run()
        record = session.started_with["record"]
        self.assertEqual(record, {"audio": False, "transcript": False,
                                  "traces": False, "logs": False})
        # IDENTITY OF SOURCE, not equality of a literal. `dict(...)` copies, so
        # the passed value is not the constant itself — what must hold is that
        # the ONE constant is what was copied, and that both callers share it.
        self.assertIs(phone.PHONE_NO_RECORDING, agent_mod._PHONE_NO_RECORDING)
        self.assertEqual(record, phone.PHONE_NO_RECORDING)
        # A copy, so a mutation of the passed dict cannot poison the constant.
        self.assertIsNot(record, phone.PHONE_NO_RECORDING)

    def test_NEGATIVE_CONTROL_no_session_start_lacks_a_record_argument(self):
        starts = re.findall(r"session\.start\(", PHONE_CANARY_CODE)
        self.assertEqual(len(starts), 1, "the canary must have exactly one session start")
        self.assertIn("record=dict(phone.PHONE_NO_RECORDING)", PHONE_CANARY_CODE)
        # Dropping the kwarg is what the control is about: the default is NOT
        # off, and the spoken disclosure claims it is.
        mutated = PHONE_CANARY_CODE.replace("record=dict(phone.PHONE_NO_RECORDING),", "")
        self.assertNotIn("record=", mutated.split("session.start(")[1][:200])

    def test_NEGATIVE_CONTROL_the_canary_declares_no_recording_dict_of_its_own(self):
        # A second literal is how the two copies drift, and the canary is the
        # one whose spoken line would then be false.
        self.assertNotRegex(PHONE_CANARY_CODE, r'=\s*\{"audio":')

    # ── F20/H-4: ordering ─────────────────────────────────────────────

    async def test_the_session_opens_only_AFTER_something_answers(self):
        order: list[str] = []

        async def wait():
            order.append("waited")
            return _participant()

        session = FakeSession()
        original_start = session.start

        async def start(**kwargs):
            order.append("started")
            await original_start(**kwargs)

        session.start = start
        await self._run(session=session, wait=wait)
        self.assertEqual(order, ["waited", "started"])

    async def test_no_participant_means_no_session_and_a_closed_room(self):
        outcome, ctx, session, closed = await self._run(participant=False)
        self.assertEqual(outcome, "canary_no_participant")
        self.assertEqual(session.start_calls, 0)
        self.assertEqual(session.spoken, [])
        self.assertEqual(closed, [_ROOM])
        # It DID connect — the wait happens inside the room, as production does
        # it — but nothing was ever spoken into a ringing line.
        self.assertEqual(ctx.connected, 1)

    async def test_the_canary_wait_is_its_own_knob_and_not_the_production_one(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_CANARY_PARTICIPANT_WAIT_SEC", None)
            os.environ.pop("PHONE_PARTICIPANT_WAIT_SEC", None)
            self.assertEqual(phone.canary_participant_wait_sec(), 120.0)
            self.assertEqual(phone.phone_participant_wait_sec(), 45.0)
        # And it satisfies the inequality the CLI refuses on: 120 >= 30 + 60.
        self.assertGreaterEqual(phone.canary_participant_wait_sec(), 30 + 60)

    # ── The conversation ──────────────────────────────────────────────

    async def test_it_discloses_asks_and_closes_in_order(self):
        _, _, session, _ = await self._run(answers=("yes", "sunny"), questions="2")
        self.assertEqual(session.spoken, [
            phone_canary.CANARY_DISCLOSURE_TEXT,
            phone_canary.CANARY_QUESTIONS[0],
            phone_canary.CANARY_QUESTIONS[1],
            phone_canary.CANARY_CLOSING_TEXT,
        ])
        # The LLM was driven once per answered question — the whole point is
        # the model responding to something it did not script.
        self.assertEqual(len(session.replies), 2)

    async def test_the_question_count_is_bounded_by_the_copy_that_exists(self):
        _, _, session, _ = await self._run(answers=("a", "b", "c"), questions="9")
        asked = [line for line in session.spoken if line in phone_canary.CANARY_QUESTIONS]
        self.assertEqual(len(asked), len(phone_canary.CANARY_QUESTIONS))

    async def test_a_silent_answer_does_not_stall_the_sequence(self):
        _, _, session, _ = await self._run(answers=(), questions="2")
        # No answer means no generated reply, but the closing line is still
        # spoken and the room is still closed.
        self.assertEqual(session.replies, [])
        self.assertIn(phone_canary.CANARY_CLOSING_TEXT, session.spoken)

    # ── M-3: the one-shot latch ───────────────────────────────────────

    async def test_a_SECOND_canary_job_is_refused_without_connecting(self):
        # Without this, an armed worker is a STANDING conversational endpoint:
        # every canary-shaped dispatch it ever receives would be answered with
        # a live conversation, indefinitely.
        first, _, _, _ = await self._run()
        self.assertEqual(first, "canary_completed")
        self.assertTrue(phone_canary.canary_has_run())

        ctx = FakeCtx(metadata=_room_meta(), dispatch=_dispatch())
        closed: list[str] = []
        outcome = await phone_canary.run_phone_canary(
            ctx, _ROOM, _CANARY_ID,
            session_factory=lambda: self.fail("a second session was built"),
            agent_factory=_canary_agent_stub,
            close_room=lambda name: closed.append(name),
            wait_for_participant=lambda: self.fail("a second wait was started"),
        )
        self.assertEqual(outcome, "canary_already_run")
        self.assertEqual(ctx.connected, 0)
        self.assertEqual(closed, [])

    # ── Bounds ────────────────────────────────────────────────────────

    async def test_a_hung_conversation_ENDS_the_call_and_closes_the_room(self):
        class HungSession(FakeSession):
            def say(self, text, **kwargs):
                self.spoken.append(text)

                class _Hang:
                    async def wait_for_playout(self):
                        await asyncio.sleep(10)
                return _Hang()

        with patch.dict(os.environ, {"PHONE_CANARY_MAX_CALL_SEC": "30"}):
            with patch.object(phone, "canary_max_call_sec", lambda: 0.05):
                outcome, _, session, closed = await self._run(session=HungSession())
        self.assertEqual(outcome, "canary_deadline_exceeded")
        self.assertEqual(closed, [_ROOM])

    def test_the_per_answer_bound_is_real_and_bounded(self):
        # A bound, not a target: without it a handset left on a table holds the
        # leg until the outer ceiling.
        self.assertEqual(phone_canary.CANARY_ANSWER_TIMEOUT_SEC, 30.0)
        self.assertLess(
            phone_canary.CANARY_ANSWER_TIMEOUT_SEC * len(phone_canary.CANARY_QUESTIONS),
            phone.canary_max_call_sec(),
            "the per-answer bounds must fit inside the call ceiling")

    def test_the_bounds_are_clamped_and_never_left_to_a_default(self):
        for name, fn, lo, hi in (
            ("PHONE_CANARY_MAX_CALL_SEC", phone.canary_max_call_sec, 30.0, 300.0),
            ("PHONE_CANARY_PARTICIPANT_WAIT_SEC", phone.canary_participant_wait_sec, 1.0, 180.0),
        ):
            with self.subTest(name=name):
                with patch.dict(os.environ, {name: "0"}):
                    self.assertEqual(fn(), lo)
                with patch.dict(os.environ, {name: "99999"}):
                    self.assertEqual(fn(), hi)
                with patch.dict(os.environ, {name: "not a number"}):
                    self.assertGreaterEqual(fn(), lo)


# ══════════════════════════════════════════════════════════════════════
#  4. What the module structurally cannot do.
# ══════════════════════════════════════════════════════════════════════

class TestNoPersistenceSurface(unittest.TestCase):
    def test_the_stripper_is_honest(self):
        # A stripper that ate the file would satisfy every "must not contain"
        # assertion below by leaving nothing to find.
        self.assertGreater(len(PHONE_CANARY_CODE), 1_500)
        self.assertIn("async def run_phone_canary(", PHONE_CANARY_CODE)
        self.assertIn("record=dict(phone.PHONE_NO_RECORDING)", PHONE_CANARY_CODE)
        # ...and it DID remove the prose, which is what makes the scan real.
        self.assertIn("PhoneEventClient", PHONE_CANARY_SRC)
        self.assertNotIn("PhoneEventClient", PHONE_CANARY_CODE)

    def test_it_names_no_worker_API_path_and_no_event_client(self):
        for symbol in ("PhoneEventClient", "EVENTS_PATH", "APPOINTMENTS_PATH",
                       "ASSESSMENT_START_PATH", "ASSESSMENT_TURN_PATH",
                       "ASSESSMENT_COMPLETE_PATH", "HEARTBEAT_PATH",
                       "phone_agent_class", "persistence", "httpx", "requests",
                       "supabase"):
            with self.subTest(symbol=symbol):
                self.assertNotIn(symbol, PHONE_CANARY_CODE)

    def test_POSITIVE_CONTROL_the_scan_would_catch_a_seeded_reference(self):
        # Seeded as CODE, not as prose -- the same shape the scan runs on.
        seeded = _code(PHONE_CANARY_SRC + "\nclient = phone.PhoneEventClient()\n")
        self.assertIn("PhoneEventClient", seeded)
        seeded_path = _code(PHONE_CANARY_SRC + "\nurl = phone.HEARTBEAT_PATH\n")
        self.assertIn("HEARTBEAT_PATH", seeded_path)

    def test_it_imports_no_agent_module_and_so_has_no_cycle(self):
        self.assertNotRegex(PHONE_CANARY_CODE, r"(?m)^import agent$")
        self.assertNotRegex(PHONE_CANARY_CODE, r"(?m)^from agent import")
        # Everything it needs is INJECTED, which is what makes that possible.
        for kwarg in ("session_factory", "agent_factory", "close_room", "wait_for_participant"):
            self.assertIn(kwarg, PHONE_CANARY_CODE)

    def test_it_never_enumerates_a_participant_attribute_map(self):
        # `sip.phoneNumber` is auto-populated by LiveKit on a SIP participant,
        # so enumerating that map is precisely how a number reaches a log line.
        self.assertNotIn("attributes", PHONE_CANARY_CODE)
        self.assertNotIn("remote_participants", PHONE_CANARY_CODE)

    def test_the_copy_says_nothing_untrue_and_carries_no_digit_run(self):
        self.assertNotEqual(phone_canary.CANARY_DISCLOSURE_TEXT, phone.PHONE_DISCLOSURE_TEXT)
        self.assertIn("not being recorded", phone_canary.CANARY_DISCLOSURE_TEXT)
        self.assertNotIn("recorded so the hiring team",
                         phone_canary.CANARY_DISCLOSURE_TEXT)
        for line in (phone_canary.CANARY_DISCLOSURE_TEXT,
                     phone_canary.CANARY_CLOSING_TEXT,
                     phone_canary.CANARY_AGENT_INSTRUCTIONS,
                     *phone_canary.CANARY_QUESTIONS):
            with self.subTest(line=line[:32]):
                self.assertIsNone(re.search(r"\d{7,}", line))

    def test_the_agent_is_constructed_BY_KEYWORD_against_a_strict_stub(self):
        # A positional call raises on the real class. Proved here by calling
        # the strict stub both ways: keyword works, positional raises -- so the
        # stub is genuinely strict and the assertion is not vacuous.
        self.assertEqual(_canary_agent_stub(instructions="x").instructions, "x")
        with self.assertRaises(TypeError):
            _canary_agent_stub("x")  # type: ignore[misc]

    def test_the_canary_drives_a_BARE_agent_and_says_so(self):
        # Honest scoping: `phone_agent_class`, its function tools, the
        # human/machine classifier and `run_phone_gate`'s ordering are all
        # UNEXERCISED by a green canary run.
        # BY KEYWORD. This pin used to assert the POSITIONAL form, so the
        # correct fix would have gone red against its own tripwire -- a
        # tripwire that pins the riskier shape is worse than none.
        self.assertIn("agent_factory(instructions=CANARY_AGENT_INSTRUCTIONS)", PHONE_CANARY_CODE)
        self.assertNotIn("agent_factory(CANARY_AGENT_INSTRUCTIONS)", PHONE_CANARY_CODE)
        self.assertIn("bare ``Agent``", PHONE_CANARY_SRC)


# ══════════════════════════════════════════════════════════════════════
#  5. Packaging — the module has to be IN the image.
# ══════════════════════════════════════════════════════════════════════

class TestPackaging(unittest.TestCase):
    """PR102's incident, applied to the new module.

    `agent.py` imports `phone_canary`, so the module is on the transitive
    runtime import closure. A module on that closure that is not COPY'd into
    the image does not fail a dispatch — it crash-loops the worker at startup
    with `ModuleNotFoundError`, which is how the phone app spent v40.
    """

    def setUp(self):
        import importlib.util
        repo = os.path.dirname(os.path.dirname(CTX))
        spec = importlib.util.spec_from_file_location(
            "docker_import_closure", os.path.join(repo, "scripts", "docker_import_closure.py"))
        self.dic = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.dic)
        with open(os.path.join(CTX, "Dockerfile"), encoding="utf-8") as handle:
            self.dockerfile = handle.read()

    def test_phone_canary_is_on_the_closure_and_is_copied(self):
        result = self.dic.analyze(CTX)
        self.assertIn("phone_canary", result["closure"])
        self.assertEqual(result["missing"], [])
        self.assertIn("phone_canary.py", self.dic.copy_sources(self.dockerfile))

    def test_NEGATIVE_CONTROL_dropping_the_new_COPY_goes_red(self):
        mutated = self.dockerfile.replace(" phone_canary.py", "")
        mutated_set = {t.rstrip("/") for t in self.dic.copy_sources(mutated)}
        self.assertNotIn("phone_canary.py", mutated_set)
        # And it is still a MEMBER of the closure, so the analyser would report
        # it missing rather than simply not looking for it.
        local = self.dic.local_modules(CTX)
        closure = self.dic.import_closure(CTX, "agent")
        missing = [local[m].rstrip("/") for m in closure
                   if local[m].rstrip("/") not in mutated_set]
        self.assertIn("phone_canary.py", missing)

    def test_the_module_name_is_not_secret_shaped(self):
        # `is_forbidden` rejects anything whose basename contains a
        # credential-ish substring; a module named e.g. `phone_token.py` would
        # be silently unshippable.
        self.assertFalse(self.dic.is_forbidden("phone_canary.py"))


# ══════════════════════════════════════════════════════════════════════
#  6. The run counters (PR106) — structured LOG LINES, not metrics.
# ══════════════════════════════════════════════════════════════════════
#
# A canary run that produces an outcome code and nothing else is unreadable
# after the fact: an operator holding "canary_deadline_exceeded" cannot tell
# whether the owner answered, whether a question was ever asked, or whether the
# leg was given its whole wait. These tests defend the counters that answer
# that -- and, as much, defend the two ways a counter here dies SILENTLY:
#
#   * through `counter_metric()`, whose sink in this process is
#     `_NoOpMetricSink` -- a validated, filtered, discarded number;
#   * through a meta key outside `observability._ALLOWED_META_KEYS`, which
#     `_emit` drops without a word: the call succeeds, the line is written, and
#     the field is simply not in it.
#
# So every counter assertion below runs against the REAL `StructuredLogger`.
# A stub logger would record a kwarg the production allowlist throws away.

_FIXED_CLOCK = "2026-08-24T00:00:00.000Z"

#: Seeded into the fake candidate's speech so the leak sweep has something real
#: to look for. `_item_text` returns these; nothing may log them.
_PLANTED_NUMBER = "9812345670"
_PLANTED_TEXT = "the flat above mine has a leaking pipe and the landlord"


class _Capture:
    """A writer that keeps every line the real logger actually emitted."""

    def __init__(self):
        self.lines: list[str] = []

    def __call__(self, line: str) -> None:
        self.lines.append(line)

    @property
    def entries(self) -> list[dict]:
        return [json.loads(line) for line in self.lines]

    @property
    def codes(self) -> list[str]:
        return [entry.get("error_type") for entry in self.entries]

    def where(self, code: str) -> list[dict]:
        return [e for e in self.entries if e.get("error_type") == code]


def _real_logger(capture: _Capture):
    """The PRODUCTION logger, with only the sink and the clock replaced.

    Not a stub. The allowlist, the per-field validation and the defence scan
    are the things under test: a stub would happily record a kwarg that
    `observability` drops on the floor, and the counter would be green here and
    absent in Fly's log stream.
    """
    from observability import StructuredLogger
    return StructuredLogger("phone_canary", clock=lambda: _FIXED_CLOCK, writer=capture)


async def _drive(*, capture, participant=True, answers=("yes I can hear you",),
                 questions="2", session=None, wait=None, monotonic=None):
    """Drive one full canary run through the existing fakes, capturing logs.

    Same shape as `TestCanaryCall._run` -- same fakes, same patched per-answer
    bound -- with the module logger swapped for the real one writing into
    *capture*.
    """
    ctx = FakeCtx(metadata=_room_meta(), dispatch=_dispatch())
    session = session if session is not None else FakeSession()
    session.answers = list(answers)
    closed: list[str] = []

    async def close_room(name):
        closed.append(name)

    async def wait_for_participant():
        if wait is not None:
            return await wait()
        return _participant() if participant else None

    clock_patch = (
        patch.object(phone_canary, "time", types.SimpleNamespace(monotonic=monotonic))
        if monotonic is not None
        # Patching the module ATTRIBUTE, never `time.monotonic` itself: the
        # event loop reads the same function, and a loop whose clock runs
        # backwards does not run this test, it hangs it.
        else patch.object(phone_canary, "time", phone_canary.time)
    )

    with patch.dict(os.environ, {"PHONE_CANARY_QUESTIONS": questions}), \
         patch.object(phone_canary, "CANARY_ANSWER_TIMEOUT_SEC", 0.01), \
         patch.object(phone_canary, "_log", _real_logger(capture)), \
         clock_patch:
        outcome = await phone_canary.run_phone_canary(
            ctx, _ROOM, _CANARY_ID,
            session_factory=lambda: session,
            agent_factory=_canary_agent_stub,
            close_room=close_room,
            wait_for_participant=wait_for_participant,
        )
    return outcome, ctx, session, closed


def _scan_log_calls(source: str):
    """Every `_log.<level>(...)` call in *source*, as (kwargs, error_type codes).

    Parsed, not regexed. A regex over source text cannot tell a kwarg from a
    nested call's kwarg or from a `==` comparison, and this scan is the thing
    that decides whether a NEW log line is reviewed -- a scan that mis-reads
    the source is a gate that passes whatever it failed to parse.
    """
    import ast
    kwargs: list[str] = []
    codes: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name) and func.value.id == "_log"):
            continue
        for keyword in node.keywords:
            if keyword.arg is None:      # **kwargs would defeat the whole scan
                kwargs.append("**")
                continue
            kwargs.append(keyword.arg)
            if keyword.arg == "error_type":
                codes.extend(_literal_strings(keyword.value))
    return kwargs, codes


def _literal_strings(node) -> list[str]:
    """Every string literal an `error_type=` expression can evaluate to.

    Handles the conditional form (`"a" if cond else "b"`); anything else that
    is not a plain literal is reported as the unreviewable value it is.
    """
    import ast
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.IfExp):
        return _literal_strings(node.body) + _literal_strings(node.orelse)
    return ["<not-a-literal>"]


def _leaks(line: str) -> str | None:
    """What a log line must never carry. Returns the reason, or None."""
    if re.search(r"\d{7,}", line):
        return "digit_run"
    if _PLANTED_NUMBER in line:
        return "planted_number"
    if _PLANTED_TEXT in line:
        return "planted_text"
    if _ROOM in line:
        return "room_name"
    return None


class TestRunCounters(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        phone_canary.reset_canary_latch()

    # ── T1 ────────────────────────────────────────────────────────────

    async def test_the_happy_run_emits_the_vocabulary_IN_ORDER(self):
        # SCOPED TO THE COMPLETED RUN, deliberately. The refusal paths have
        # DIFFERENT orders -- `canary_no_participant` returns from inside the
        # `try`, so its refusal precedes the `finally`'s `room_closed` and
        # `phone_canary_outcome` is never reached at all, and
        # `canary_already_run` returns before the `try` and emits nothing else.
        # Asserting one sequence over all three would either be wrong or would
        # have to be loosened until it asserted nothing. T5 owns the refusals.
        capture = _Capture()
        outcome, _, _, _ = await _drive(capture=capture, answers=("yes", "sunny"),
                                        questions="2")
        self.assertEqual(outcome, "canary_completed")
        self.assertEqual(capture.codes, [
            "phone_canary_start",
            "phone_canary_wait_bound",
            "phone_canary_session_built",
            "phone_canary_participant_waited",
            "phone_canary_session_started",
            "phone_canary_question_asked",
            "phone_canary_answer_observed",
            "phone_canary_question_asked",
            "phone_canary_answer_observed",
            "phone_canary_room_closed",
            "phone_canary_outcome",
        ])
        # The indices are indices: 0 then 1, never a running total.
        self.assertEqual(
            [e["turn_index"] for e in capture.where("phone_canary_question_asked")],
            [0, 1])
        # And the count of questions is DERIVED by counting the lines, which is
        # the whole reason no count field exists.
        self.assertEqual(len(capture.where("phone_canary_question_asked")),
                         phone.canary_questions())

    async def test_session_BUILT_is_emitted_before_the_wait_and_survives_a_dry_run(self):
        # THE DRY-RUN GATE. `phone_canary_session_started` is emitted only
        # after something has ANSWERED, so on a dry run -- which originates
        # nothing, so no remote participant ever arrives -- it is unreachable
        # by construction. Requiring it as dry-run evidence would be a gate
        # that cannot pass, which is a gate that gets waived.
        #
        # `phone_canary_session_built` is the half that IS reachable: it is
        # emitted at construction, which is where a missing provider key
        # actually fails, and it is emitted BEFORE the wait rather than after
        # it.
        order: list[str] = []

        class _Session(FakeSession):
            pass

        async def wait():
            order.append("wait_entered")
            return None

        capture = _Capture()
        outcome, _, session, _ = await _drive(
            capture=capture, session=_Session(), wait=wait)
        self.assertEqual(outcome, "canary_no_participant")
        # The line exists on the path a dry run actually takes...
        self.assertEqual(len(capture.where("phone_canary_session_built")), 1)
        # ...and `session_started` does NOT, which is the whole point.
        self.assertEqual(capture.where("phone_canary_session_started"), [])
        self.assertEqual(session.start_calls, 0)
        # ...and it precedes the wait, so the CLI's ~2 s teardown of a dry-run
        # room cannot swallow it the way it can swallow
        # `phone_canary_participant_waited`.
        self.assertEqual(order, ["wait_entered"])
        self.assertLess(capture.codes.index("phone_canary_session_built"),
                        capture.codes.index("phone_canary_participant_waited"))

    async def test_NEGATIVE_CONTROL_a_failing_session_factory_emits_no_built_line(self):
        # The control ON the assertion above: `session_built` claims the
        # session was CONSTRUCTED. If the constructor raises -- which is
        # exactly what a missing `SARVAM_API_KEY` does, because the plugin
        # reads it from the environment at construction -- the line must not
        # appear, or it would report a session that does not exist.
        capture = _Capture()
        ctx = FakeCtx(metadata=_room_meta(), dispatch=_dispatch())

        def boom():
            raise RuntimeError("provider key missing")

        with patch.object(phone_canary, "_log", _real_logger(capture)):
            with self.assertRaises(RuntimeError):
                await phone_canary.run_phone_canary(
                    ctx, _ROOM, _CANARY_ID,
                    session_factory=boom,
                    agent_factory=_canary_agent_stub,
                    close_room=lambda name: None,
                    wait_for_participant=lambda: None,
                )
        self.assertEqual(capture.codes,
                         ["phone_canary_start", "phone_canary_wait_bound"])
        self.assertNotIn("phone_canary_session_built", capture.codes)

    async def test_a_silent_answer_is_its_own_code_at_the_same_index(self):
        capture = _Capture()
        await _drive(capture=capture, answers=(), questions="2")
        self.assertEqual(capture.codes.count("phone_canary_answer_silent"), 2)
        self.assertEqual(capture.codes.count("phone_canary_answer_observed"), 0)
        self.assertEqual(
            [e["turn_index"] for e in capture.where("phone_canary_answer_silent")],
            [0, 1])

    # ── T2 ────────────────────────────────────────────────────────────

    async def test_the_counters_SURVIVE_the_observability_allowlist(self):
        # The failure this defends against is invisible: `_emit` drops a
        # non-allowlisted key silently, so a "counter" on a new key produces a
        # log line that looks right and carries nothing.
        capture = _Capture()
        await _drive(capture=capture, answers=("yes", "sunny"), questions="2")
        durations = [e for e in capture.entries if "duration_sec" in e]
        indices = [e for e in capture.entries if "turn_index" in e]
        self.assertEqual(
            sorted({e["error_type"] for e in durations}),
            ["phone_canary_outcome", "phone_canary_participant_waited",
             "phone_canary_wait_bound"])
        self.assertEqual(
            sorted({e["error_type"] for e in indices}),
            ["phone_canary_answer_observed", "phone_canary_question_asked"])
        for entry in durations:
            self.assertIsInstance(entry["duration_sec"], (int, float))
        for entry in indices:
            self.assertIsInstance(entry["turn_index"], int)

    def test_POSITIVE_CONTROL_a_renamed_key_vanishes_from_the_line(self):
        # The control ON the assertion above: the same real logger, the same
        # call shape, one key renamed -- and the field is simply not there. No
        # exception, no warning, no line missing. That is what makes "the field
        # is present" a claim worth asserting.
        capture = _Capture()
        log = _real_logger(capture)
        log.info("unknown_event", error_type="phone_canary_outcome", duration_sec=1.5)
        log.info("unknown_event", error_type="phone_canary_outcome", elapsed_sec=1.5)
        kept, renamed = capture.entries
        self.assertEqual(kept["duration_sec"], 1.5)
        self.assertNotIn("elapsed_sec", renamed)
        self.assertNotIn("duration_sec", renamed)
        # The LINE still arrived, which is exactly why the drop is invisible.
        self.assertEqual(renamed["error_type"], "phone_canary_outcome")

    # ── T3 ────────────────────────────────────────────────────────────

    def test_every_log_call_uses_a_DECLARED_key_and_a_DECLARED_code(self):
        kwargs, codes = _scan_log_calls(PHONE_CANARY_SRC)
        self.assertGreater(len(kwargs), 10, "the scan found no log calls to check")
        for name in sorted(set(kwargs)):
            with self.subTest(kwarg=name):
                self.assertIn(name, phone_canary.CANARY_LOG_META_KEYS)
        for code in sorted(set(codes)):
            with self.subTest(code=code):
                self.assertIn(code, phone_canary.CANARY_LOG_EVENTS)
        # Both declarations must be honest in the other direction too: a code
        # declared and never used is a vocabulary nobody reviewed against.
        self.assertEqual(set(codes), set(phone_canary.CANARY_LOG_EVENTS))

    def test_POSITIVE_CONTROL_the_source_scan_catches_a_seeded_call(self):
        seeded_key = PHONE_CANARY_SRC + (
            '\n_log.info("unknown_event", error_type="phone_canary_start", model="x")\n')
        kwargs, _ = _scan_log_calls(seeded_key)
        self.assertIn("model", kwargs)
        self.assertNotIn("model", phone_canary.CANARY_LOG_META_KEYS)

        seeded_code = PHONE_CANARY_SRC + (
            '\n_log.info("unknown_event", error_type="phone_canary_undeclared")\n')
        _, codes = _scan_log_calls(seeded_code)
        self.assertIn("phone_canary_undeclared", codes)
        self.assertNotIn("phone_canary_undeclared", phone_canary.CANARY_LOG_EVENTS)

        # ...and a computed `error_type` is reported as unreviewable rather
        # than quietly skipped, which is how a scan goes vacuous.
        seeded_dynamic = PHONE_CANARY_SRC + (
            '\n_log.info("unknown_event", error_type=outcome)\n')
        _, dynamic = _scan_log_calls(seeded_dynamic)
        self.assertIn("<not-a-literal>", dynamic)

    def test_the_module_routes_no_counter_through_the_NOOP_metric_sink(self):
        # `observability._metric_sink` is `_NoOpMetricSink` in this process and
        # in production. A counter through it is validated, filtered, and then
        # handed to a method whose body is `pass`.
        for symbol in ("counter_metric", "gauge_metric", "histogram_metric"):
            with self.subTest(symbol=symbol):
                self.assertNotIn(symbol, PHONE_CANARY_CODE)

    # ── T4 ────────────────────────────────────────────────────────────

    async def test_no_counter_line_carries_a_number_a_transcript_or_a_room(self):
        capture = _Capture()
        await _drive(capture=capture, questions="2",
                     answers=(f"you can call me back on {_PLANTED_NUMBER} any time",
                              _PLANTED_TEXT))
        self.assertTrue(capture.lines)
        for line in capture.lines:
            with self.subTest(line=line[:80]):
                self.assertIsNone(_leaks(line))
        # The seeded speech DID reach `_item_text` -- otherwise the sweep swept
        # a run in which there was nothing to find.
        self.assertEqual(len(capture.where("phone_canary_answer_observed")), 2)

    def test_POSITIVE_CONTROL_the_leak_sweep_can_actually_fire(self):
        # A sweep that cannot fire is not a sweep. Same function, same planted
        # values, on a synthetic line.
        self.assertEqual(_leaks(json.dumps({"schema": _PLANTED_NUMBER})), "digit_run")
        self.assertEqual(_leaks(json.dumps({"schema": _PLANTED_TEXT})), "planted_text")
        self.assertEqual(_leaks(json.dumps({"schema": _ROOM})), "room_name")
        self.assertIsNone(_leaks(json.dumps({"error_type": "phone_canary_outcome"})))

    # ── T5 ────────────────────────────────────────────────────────────

    async def test_the_no_participant_refusal_still_reports_its_WAIT(self):
        # The wait IS the evidence: "no participant" after two seconds and "no
        # participant" after the full budget are different incidents.
        capture = _Capture()
        outcome, ctx, session, closed = await _drive(capture=capture, participant=False)
        self.assertEqual(outcome, "canary_no_participant")
        self.assertEqual(capture.codes, [
            "phone_canary_start",
            "phone_canary_wait_bound",
            "phone_canary_session_built",
            "phone_canary_participant_waited",
            "phone_canary_refused",
            "phone_canary_room_closed",
        ])
        waited, = capture.where("phone_canary_participant_waited")
        self.assertIn("duration_sec", waited)
        self.assertGreaterEqual(waited["duration_sec"], 0.0)
        # No outcome line: the function returned from inside the `try`.
        self.assertEqual(capture.where("phone_canary_outcome"), [])
        self.assertEqual(closed, [_ROOM])
        self.assertEqual(session.start_calls, 0)

    async def test_the_deadline_refusal_still_reports_the_call_DURATION(self):
        class HungSession(FakeSession):
            def say(self, text, **kwargs):
                self.spoken.append(text)

                class _Hang:
                    async def wait_for_playout(self):
                        await asyncio.sleep(10)
                return _Hang()

        capture = _Capture()
        with patch.object(phone, "canary_max_call_sec", lambda: 0.05):
            outcome, _, _, closed = await _drive(capture=capture, session=HungSession())
        self.assertEqual(outcome, "canary_deadline_exceeded")
        outcome_line, = capture.where("phone_canary_outcome")
        self.assertEqual(outcome_line["error_category"], "canary_deadline_exceeded")
        self.assertIn("duration_sec", outcome_line)
        self.assertGreaterEqual(outcome_line["duration_sec"], 0.0)
        # The room still closed, and it closed BEFORE the outcome was written.
        self.assertEqual(closed, [_ROOM])
        self.assertLess(capture.codes.index("phone_canary_room_closed"),
                        capture.codes.index("phone_canary_outcome"))

    async def test_the_latch_refusal_emits_its_refusal_and_NOTHING_else(self):
        first_capture = _Capture()
        first, _, _, _ = await _drive(capture=first_capture)
        self.assertEqual(first, "canary_completed")

        capture = _Capture()
        ctx = FakeCtx(metadata=_room_meta(), dispatch=_dispatch())
        closed: list[str] = []
        with patch.object(phone_canary, "_log", _real_logger(capture)):
            outcome = await phone_canary.run_phone_canary(
                ctx, _ROOM, _CANARY_ID,
                session_factory=lambda: self.fail("a second session was built"),
                agent_factory=_canary_agent_stub,
                close_room=lambda name: closed.append(name),
                wait_for_participant=lambda: self.fail("a second wait was started"),
            )
        self.assertEqual(outcome, "canary_already_run")
        self.assertEqual(capture.codes, ["phone_canary_refused"])
        self.assertEqual(capture.entries[0]["error_category"], "canary_already_run")
        # Not even a wait bound: the refusal is BEFORE the `try`, and before
        # `ctx.connect()`.
        self.assertEqual(ctx.connected, 0)
        self.assertEqual(closed, [])

    # ── T6 ────────────────────────────────────────────────────────────

    async def test_a_duration_is_never_negative_and_never_non_finite(self):
        # A monotonic source that goes BACKWARDS. `duration_sec` outside
        # [0, 1e6] -- or non-finite -- is dropped by `_validate_numeric_field`,
        # and a dropped field is invisible: the counter would not read wrong,
        # it would silently cease to exist.
        import itertools
        backwards = itertools.count(1000.0, -100.0)
        capture = _Capture()
        outcome, _, _, _ = await _drive(capture=capture, answers=("yes", "sunny"),
                                        questions="2",
                                        monotonic=lambda: next(backwards))
        self.assertEqual(outcome, "canary_completed")
        durations = [e["duration_sec"] for e in capture.entries if "duration_sec" in e]
        self.assertGreaterEqual(len(durations), 3)
        for value in durations:
            with self.subTest(value=value):
                self.assertGreaterEqual(value, 0.0)
                self.assertTrue(math.isfinite(value))
        # Every line that should carry one still does -- the clamp keeps the
        # field, it does not drop it.
        self.assertIn("duration_sec", capture.where("phone_canary_outcome")[0])

    def test_the_clamp_handles_what_a_bad_clock_can_actually_produce(self):
        self.assertEqual(phone_canary._duration(-5.0), 0.0)
        self.assertEqual(phone_canary._duration(float("nan")), 0.0)
        self.assertEqual(phone_canary._duration(float("-inf")), 0.0)
        self.assertEqual(phone_canary._duration(float("inf")), 0.0)
        # The upper clamp is for a finite absurdity -- 1e6 is the exact ceiling
        # `_validate_numeric_field` drops above, so a value past it must land
        # ON the ceiling rather than be dropped.
        self.assertEqual(phone_canary._duration(2_000_000.0), 1_000_000.0)
        self.assertEqual(phone_canary._duration(1.2345), 1.2)
        # And each clamped value SURVIVES the numeric validator, which is the
        # property that matters -- not the arithmetic.
        capture = _Capture()
        log = _real_logger(capture)
        for raw in (-5.0, float("nan"), float("inf"), 2_000_000.0, 1.2345):
            log.info("unknown_event", error_type="phone_canary_outcome",
                     duration_sec=phone_canary._duration(raw))
        for entry in capture.entries:
            with self.subTest(entry=entry):
                self.assertIn("duration_sec", entry)

    # ── T7 ────────────────────────────────────────────────────────────

    async def test_the_wait_BOUND_is_logged_once_at_entry(self):
        # Without it, "participant_waited: 118.4" is unreadable: an operator
        # cannot tell a wait that nearly expired from one with a minute to
        # spare, and the bound lives in a different file.
        capture = _Capture()
        await _drive(capture=capture)
        bounds = capture.where("phone_canary_wait_bound")
        self.assertEqual(len(bounds), 1)
        self.assertEqual(capture.codes.index("phone_canary_wait_bound"), 1)
        self.assertEqual(bounds[0]["duration_sec"], phone.canary_participant_wait_sec())
        # It is the CANARY's knob, not production's -- the distinction this
        # lane already paid for once.
        self.assertNotEqual(phone.canary_participant_wait_sec(),
                            phone.phone_participant_wait_sec())

    async def test_the_wait_bound_FOLLOWS_the_configured_knob(self):
        capture = _Capture()
        with patch.dict(os.environ, {"PHONE_CANARY_PARTICIPANT_WAIT_SEC": "90"}):
            await _drive(capture=capture)
            self.assertEqual(
                capture.where("phone_canary_wait_bound")[0]["duration_sec"], 90.0)


if __name__ == "__main__":
    unittest.main()
