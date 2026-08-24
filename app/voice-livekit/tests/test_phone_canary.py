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
                agent_factory=lambda instructions: types.SimpleNamespace(
                    instructions=instructions),
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
            agent_factory=lambda instructions: None,
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

    def test_the_canary_drives_a_BARE_agent_and_says_so(self):
        # Honest scoping: `phone_agent_class`, its function tools, the
        # human/machine classifier and `run_phone_gate`'s ordering are all
        # UNEXERCISED by a green canary run.
        self.assertIn("agent_factory(CANARY_AGENT_INSTRUCTIONS)", PHONE_CANARY_CODE)
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


if __name__ == "__main__":
    unittest.main()
