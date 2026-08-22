"""Phone-channel tests (P4) — worker isolation, the disclosure gate, the tool.

Everything here runs against fakes. No provider, no network, no secret, no real
call. The SDK is stubbed the same way ``tests/test_agent.py`` stubs it, so this
file passes in CI, where the livekit packages are not installed.

The three inseparable safety properties this file exists to defend:

  * recording is *considered* only after an affirmative ``disclosure.delivered``
    was ACCEPTED by the API;
  * a machine-classified call can neither score nor write back nor record;
  * the scheduling tool confirms a booking only after the server booked one.

Each of those has a mutation control recorded in the P4 handoff: with the guard
removed, the corresponding test must fail.
"""

from __future__ import annotations

import asyncio
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
            def __init__(self):
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

    if "dotenv" not in sys.modules:
        dotenv = types.ModuleType("dotenv")
        dotenv.load_dotenv = MagicMock()
        sys.modules["dotenv"] = dotenv


_ensure_stub_sdk()

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


def _ensure_plugin_classes() -> None:
    """Top up whatever plugin stubs ``agent`` bound at import time.

    Another test file may have installed a leaner stub before this one was
    discovered, and ``agent`` holds direct references to the modules it imported
    then. Only stub modules (no ``__file__``) are touched, so a real installed
    SDK is never mutated.
    """
    for mod, names in ((agent_mod.openai, ("LLM",)), (agent_mod.sarvam, ("STT", "TTS"))):
        if getattr(mod, "__file__", None) is not None:
            continue
        for name in names:
            if not hasattr(mod, name):
                setattr(mod, name, type(name, (), {"__init__": lambda self, **k: None}))


_ensure_plugin_classes()


_ATTEMPT_ID = "3f1c9d40-6f5a-4d2b-9a1e-77c0e2b1a5d3"
_PHONE_ROOM = f"phone-{_ATTEMPT_ID}"
_BROWSER_ROOM = "screening-5b2a34cb-a912-4c68-a2c2-79ccdc1dcdd1"
# Never a real number. Used only to prove it does not appear in an output.
_NUMBER_LIKE = "+919812345670"


# ── Fakes ─────────────────────────────────────────────────────────────

class FakeEventClient:
    """Records every event post; each event's outcome is scripted."""

    def __init__(self, outcomes: dict | None = None, booking=None) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self.bookings: list[tuple[str, str, int]] = []
        self._outcomes = outcomes or {}
        self._booking = booking

    async def post_event(self, attempt_id, event_type, *, epoch=None, metadata=None):
        self.calls.append((attempt_id, event_type, {"epoch": epoch, "metadata": metadata}))
        outcome = self._outcomes.get(event_type)
        if outcome is not None:
            return outcome
        return phone.PhoneApiOutcome(True, "applied")

    async def book_appointment(self, attempt_id, starts_at, duration_seconds):
        self.bookings.append((attempt_id, starts_at, duration_seconds))
        if isinstance(self._booking, Exception):
            raise self._booking
        return self._booking or phone.PhoneApiOutcome(False, "attempt_in_flight")

    @property
    def event_types(self) -> list[str]:
        return [call[1] for call in self.calls]


class FakeCtx:
    """JobContext stand-in with an inspectable room and connect() call."""

    def __init__(self, room_name: str, metadata=None, participants=None) -> None:
        self.room = types.SimpleNamespace(
            name=room_name,
            metadata=metadata,
            remote_participants={
                p.identity: p for p in (participants or [])
            },
        )
        self.job = types.SimpleNamespace(room=None, metadata=None)
        self.connected = 0

    async def connect(self):
        self.connected += 1


def _participant(identity="sip_candidate"):
    return types.SimpleNamespace(identity=identity)


async def _noop_say(text):  # pragma: no cover - replaced in most tests
    return None


class Recorder:
    """Collects the spoken lines and the order of gate side effects."""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.order: list[str] = []
        self.recording_calls = 0

    async def say(self, text):
        self.spoken.append(text)
        self.order.append(f"say:{text[:24]}")

    async def start_recording(self):
        self.recording_calls += 1
        self.order.append("recording")


def _run(coro):
    return asyncio.run(coro)


# ── Room classification ───────────────────────────────────────────────

class TestRoomClassification(unittest.TestCase):
    def test_phone_room_name_is_recognised(self):
        self.assertTrue(phone.is_phone_room(_PHONE_ROOM))
        self.assertEqual(phone.attempt_id_from_room_name(_PHONE_ROOM), _ATTEMPT_ID)

    def test_browser_room_is_not_a_phone_room(self):
        self.assertFalse(phone.is_phone_room(_BROWSER_ROOM))
        self.assertIsNone(phone.attempt_id_from_room_name(_BROWSER_ROOM))

    def test_metadata_channel_marks_a_phone_room(self):
        self.assertTrue(phone.is_phone_room("some-other-room", '{"channel": "phone"}'))
        self.assertTrue(phone.is_phone_room("some-other-room", b'{"channel": "PHONE"}'))

    def test_non_json_and_wrong_channel_metadata_is_not_phone(self):
        for meta in (None, "", "not json", "[1,2]", '{"channel": "browser"}', '{"channel": 7}'):
            with self.subTest(meta=meta):
                self.assertFalse(phone.is_phone_room("some-other-room", meta))

    def test_near_miss_room_names_are_not_phone_rooms(self):
        for name in ("phone-", "phone-nope", f"phone-{_ATTEMPT_ID}-extra", f"xphone-{_ATTEMPT_ID}"):
            with self.subTest(name=name):
                self.assertFalse(phone.is_phone_room(name))

    def test_participant_identity_is_the_only_thing_read(self):
        participant = types.SimpleNamespace(
            identity="sip_abc",
            attributes={"sip.phoneNumber": _NUMBER_LIKE},
        )
        self.assertEqual(phone.participant_identity(participant), "sip_abc")


# ── Worker isolation ──────────────────────────────────────────────────

class _OptionsRecorder:
    last: dict = {}

    def __init__(self, **kwargs):
        _OptionsRecorder.last = kwargs
        self.kwargs = kwargs


class TestWorkerOptions(unittest.TestCase):
    def _build(self, env_value=None):
        env = {} if env_value is None else {"PHONE_AGENT_NAME": env_value}
        clear = env_value is None
        with patch.object(agent_mod, "WorkerOptions", _OptionsRecorder):
            with patch.dict(agent_mod.os.environ, env, clear=False):
                if clear:
                    agent_mod.os.environ.pop("PHONE_AGENT_NAME", None)
                agent_mod.build_worker_options()
        return dict(_OptionsRecorder.last)

    def test_default_worker_has_no_agent_name(self):
        options = self._build(None)
        self.assertNotIn("agent_name", options)
        # And nothing else drifted from the browser worker's options.
        self.assertEqual(options["num_idle_processes"], 0)
        self.assertEqual(options["initialize_process_timeout"], 60.0)
        self.assertEqual(options["job_memory_warn_mb"], 1400)
        self.assertEqual(options["job_memory_limit_mb"], 0)
        self.assertIs(options["entrypoint_fnc"], agent_mod.entrypoint)

    def test_named_worker_sets_agent_name(self):
        options = self._build("phone-screener")
        self.assertEqual(options["agent_name"], "phone-screener")

    def test_blank_agent_name_stays_unnamed(self):
        for value in ("", "   "):
            with self.subTest(value=value):
                self.assertNotIn("agent_name", self._build(value))


class TestWorkerRoomOwnership(unittest.TestCase):
    def _handles(self, room_name, metadata=None, agent_name=""):
        with patch.object(agent_mod, "_phone_agent_name", return_value=agent_name):
            return agent_mod._worker_handles_room(room_name, metadata)

    def test_default_worker_owns_browser_rooms_only(self):
        self.assertTrue(self._handles(_BROWSER_ROOM))
        self.assertFalse(self._handles(_PHONE_ROOM))
        self.assertFalse(self._handles("odd-room", '{"channel": "phone"}'))

    def test_named_worker_owns_phone_rooms_only(self):
        self.assertTrue(self._handles(_PHONE_ROOM, agent_name="phone-screener"))
        self.assertTrue(self._handles("odd-room", '{"channel": "phone"}', agent_name="p"))
        self.assertFalse(self._handles(_BROWSER_ROOM, agent_name="phone-screener"))


class TestEntrypointIsolation(unittest.TestCase):
    """The regression that matters: browser screening keeps working."""

    class _WC:  # real stand-in type so the entrypoint's isinstance() holds
        pass

    def _entrypoint(self, ctx, agent_name=""):
        persistence_spy = MagicMock()
        with patch.object(agent_mod, "_phone_agent_name", return_value=agent_name), \
             patch.object(agent_mod, "persistence", persistence_spy), \
             patch.object(agent_mod, "WorkerContext", self._WC), \
             patch.object(agent_mod, "_run_session", new_callable=AsyncMock) as run_session, \
             patch.object(agent_mod, "_run_phone_entrypoint", new_callable=AsyncMock) as run_phone, \
             patch.object(
                 agent_mod, "_resolve_worker_context_with_retry", new_callable=AsyncMock
             ) as resolve:
            resolve.return_value = self._WC()
            _run(agent_mod.entrypoint(ctx))
        return run_session, run_phone, persistence_spy

    def test_browser_room_still_handled_by_unnamed_worker(self):
        ctx = FakeCtx(_BROWSER_ROOM)
        run_session, run_phone, _ = self._entrypoint(ctx)
        self.assertEqual(ctx.connected, 1)
        run_session.assert_awaited_once()
        run_phone.assert_not_awaited()

    def test_unnamed_worker_skips_a_phone_room_entirely(self):
        ctx = FakeCtx(_PHONE_ROOM)
        run_session, run_phone, persistence_spy = self._entrypoint(ctx)
        self.assertEqual(ctx.connected, 0)          # never connected
        run_session.assert_not_awaited()            # never spoke, never activated
        run_phone.assert_not_awaited()
        self.assertEqual(persistence_spy.mock_calls, [])  # not one DB write

    def test_unnamed_worker_skips_a_metadata_marked_phone_room(self):
        ctx = FakeCtx("interview-room-7", metadata='{"channel":"phone"}')
        run_session, run_phone, persistence_spy = self._entrypoint(ctx)
        self.assertEqual(ctx.connected, 0)
        run_session.assert_not_awaited()
        self.assertEqual(persistence_spy.mock_calls, [])

    def test_named_worker_handles_a_dispatched_phone_room(self):
        ctx = FakeCtx(_PHONE_ROOM)
        run_session, run_phone, _ = self._entrypoint(ctx, agent_name="phone-screener")
        run_phone.assert_awaited_once()
        run_session.assert_not_awaited()
        self.assertEqual(ctx.connected, 0)  # the phone flow owns its own connect

    def test_named_worker_skips_a_browser_room(self):
        ctx = FakeCtx(_BROWSER_ROOM)
        run_session, run_phone, persistence_spy = self._entrypoint(ctx, agent_name="phone-screener")
        self.assertEqual(ctx.connected, 0)
        run_session.assert_not_awaited()
        run_phone.assert_not_awaited()
        self.assertEqual(persistence_spy.mock_calls, [])

    def test_phone_room_without_an_attempt_id_does_nothing(self):
        ctx = FakeCtx("interview-room-7", metadata='{"channel":"phone"}')
        with patch.object(agent_mod, "_phone_agent_name", return_value="p"), \
             patch.object(agent_mod, "_run_phone_session", new_callable=AsyncMock) as run:
            _run(agent_mod._run_phone_entrypoint(ctx, "interview-room-7"))
        run.assert_not_awaited()


# ── The gate ──────────────────────────────────────────────────────────

class TestPhoneGate(unittest.IsolatedAsyncioTestCase):
    async def _gate(self, decision, *, participant=True, client=None, recorder=None):
        recorder = recorder or Recorder()
        client = client or FakeEventClient()

        async def wait_for_participant():
            recorder.order.append("participant_wait")
            return _participant() if participant else None

        async def classify():
            recorder.order.append("classify")
            if isinstance(decision, Exception):
                raise decision
            if decision == "__hang__":
                await asyncio.sleep(5)
            return decision

        result = await phone.run_phone_gate(
            attempt_id=_ATTEMPT_ID,
            client=client,
            wait_for_participant=wait_for_participant,
            classify=classify,
            say=recorder.say,
            start_recording=recorder.start_recording,
            classify_timeout_sec=0.05,
        )
        return result, client, recorder

    async def test_no_participant_means_no_speech_no_event_no_recording(self):
        result, client, recorder = await self._gate(phone.CLASSIFY_HUMAN, participant=False)
        self.assertEqual(result.outcome, phone.GATE_NO_PARTICIPANT)
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)
        self.assertEqual(recorder.spoken, [])
        self.assertEqual(client.calls, [])
        self.assertEqual(recorder.recording_calls, 0)

    async def test_disclosure_is_spoken_before_classification(self):
        _, _, recorder = await self._gate(phone.CLASSIFY_HUMAN)
        self.assertEqual(recorder.order[0], "participant_wait")
        self.assertTrue(recorder.order[1].startswith("say:"))
        self.assertEqual(recorder.order[2], "classify")
        self.assertEqual(recorder.spoken[0], phone.PHONE_DISCLOSURE_TEXT)

    async def test_disclosure_text_is_fixed_and_complete(self):
        text = phone.PHONE_DISCLOSURE_TEXT.lower()
        self.assertIn("ai voice assistant", text)   # identity
        self.assertIn("job application", text)      # purpose
        self.assertIn("recorded", text)             # recording notice
        self.assertIn("okay to continue", text)     # consent question

    async def test_machine_posts_only_classify_machine_and_never_records(self):
        result, client, recorder = await self._gate(phone.CLASSIFY_MACHINE)
        self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)
        self.assertEqual(client.event_types, ["classify.machine"])
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)
        self.assertEqual(recorder.recording_calls, 0)
        # nothing that could score or write back was even reachable
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("disclosure.delivered", client.event_types)

    async def test_classifier_timeout_is_a_machine(self):
        result, client, recorder = await self._gate("__hang__")
        self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)
        self.assertEqual(client.event_types, ["classify.machine"])
        self.assertEqual(recorder.recording_calls, 0)

    async def test_broken_or_unknown_classifier_is_a_machine(self):
        for decision in (RuntimeError("boom"), "definitely-not-a-verdict", None):
            with self.subTest(decision=decision):
                result, client, recorder = await self._gate(decision)
                self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)
                self.assertEqual(client.event_types, ["classify.machine"])
                self.assertEqual(recorder.recording_calls, 0)

    async def test_human_affirmative_orders_events_then_recording(self):
        result, client, recorder = await self._gate(phone.CLASSIFY_HUMAN)
        self.assertEqual(client.event_types, ["classify.human", "disclosure.delivered"])
        self.assertTrue(result.assessment_allowed)
        self.assertTrue(result.recording_allowed)
        self.assertEqual(recorder.recording_calls, 1)
        # recording is the LAST side effect, after the disclosure was accepted
        self.assertEqual(recorder.order[-1], "recording")

    async def test_recording_never_starts_when_disclosure_is_not_recorded(self):
        client = FakeEventClient(
            {"disclosure.delivered": phone.PhoneApiOutcome(False, error_category="transport")}
        )
        result, client, recorder = await self._gate(phone.CLASSIFY_HUMAN, client=client)
        self.assertEqual(client.event_types, ["classify.human", "disclosure.delivered"])
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)
        self.assertEqual(recorder.recording_calls, 0)

    async def test_disclosure_is_not_posted_when_classify_human_fails(self):
        client = FakeEventClient(
            {"classify.human": phone.PhoneApiOutcome(False, error_category="transport")}
        )
        result, client, recorder = await self._gate(phone.CLASSIFY_HUMAN, client=client)
        self.assertEqual(client.event_types, ["classify.human"])
        self.assertFalse(result.recording_allowed)
        self.assertEqual(recorder.recording_calls, 0)

    async def test_refusal_paths_post_their_own_event_and_never_record(self):
        cases = {
            phone.CLASSIFY_REFUSED: ("disclosure.refused", phone.PHONE_REFUSED_TEXT),
            phone.CLASSIFY_OPT_OUT: ("candidate.opt_out", phone.PHONE_OPT_OUT_TEXT),
            phone.CLASSIFY_WRONG_NUMBER: ("candidate.wrong_number", phone.PHONE_WRONG_NUMBER_TEXT),
        }
        for decision, (event_type, closing) in cases.items():
            with self.subTest(decision=decision):
                result, client, recorder = await self._gate(decision)
                self.assertEqual(client.event_types, [event_type])
                self.assertFalse(result.assessment_allowed)
                self.assertFalse(result.recording_allowed)
                self.assertEqual(recorder.recording_calls, 0)
                self.assertEqual(recorder.spoken[-1], closing)

    async def test_refusal_closings_never_claim_a_recording_was_kept(self):
        for closing in (
            phone.PHONE_REFUSED_TEXT,
            phone.PHONE_OPT_OUT_TEXT,
            phone.PHONE_WRONG_NUMBER_TEXT,
        ):
            with self.subTest(closing=closing):
                lowered = closing.lower()
                self.assertNotIn("record", lowered)
                self.assertNotIn("delete", lowered)

    async def test_every_gate_event_is_on_the_strict_allowlist(self):
        for decision in phone.PHONE_CLASSIFICATIONS:
            with self.subTest(decision=decision):
                _, client, _ = await self._gate(decision)
                for event_type in client.event_types:
                    self.assertIn(event_type, phone.PHONE_WORKER_EVENTS)


# ── The default answer classifier ─────────────────────────────────────

class TestAnswerClassifier(unittest.TestCase):
    def test_machine_markers(self):
        for text in (
            "Please leave a message after the tone.",
            "The person you are calling is not available right now.",
            "Press 1 for sales.",
        ):
            with self.subTest(text=text):
                self.assertEqual(agent_mod.classify_answer_text(text), phone.CLASSIFY_MACHINE)

    def test_wrong_number_and_opt_out_beat_a_bare_refusal(self):
        self.assertEqual(
            agent_mod.classify_answer_text("No, wrong number."), phone.CLASSIFY_WRONG_NUMBER
        )
        self.assertEqual(
            agent_mod.classify_answer_text("No, don't call me again."), phone.CLASSIFY_OPT_OUT
        )

    def test_refusals(self):
        for text in ("No thanks.", "Please don't record this.", "I'm not comfortable with that."):
            with self.subTest(text=text):
                self.assertEqual(agent_mod.classify_answer_text(text), phone.CLASSIFY_REFUSED)

    def test_affirmatives(self):
        for text in ("Yes, that's fine.", "Sure, go ahead.", "Okay."):
            with self.subTest(text=text):
                self.assertEqual(agent_mod.classify_answer_text(text), phone.CLASSIFY_HUMAN)

    def test_unreadable_answers_are_not_consent(self):
        for text in ("", "   ", "Hmm, who is this exactly?"):
            with self.subTest(text=text):
                self.assertIsNone(agent_mod.classify_answer_text(text))

    def test_reask_once_then_fail_closed_to_machine(self):
        async def _test():
            turns: asyncio.Queue = asyncio.Queue()
            turns.put_nowait("Hmm, who is this exactly?")
            turns.put_nowait("Still not sure what you want")
            spoken: list[str] = []

            async def say(text):
                spoken.append(text)

            decision = await agent_mod._classify_phone_answer(turns, say)
            return decision, spoken

        decision, spoken = _run(_test())
        self.assertEqual(decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(spoken, [phone.PHONE_REASK_TEXT])

    def test_reask_recovers_a_late_affirmative(self):
        async def _test():
            turns: asyncio.Queue = asyncio.Queue()
            turns.put_nowait("Sorry, what?")
            turns.put_nowait("Yes, go ahead.")

            async def say(text):
                return None

            return await agent_mod._classify_phone_answer(turns, say)

        self.assertEqual(_run(_test()), phone.CLASSIFY_HUMAN)


# ── The event client ──────────────────────────────────────────────────

_UNSET = object()


class _RecordingTransport:
    def __init__(self, status_code=200, body=_UNSET):
        self.requests: list[dict] = []
        self._status = status_code
        self._body = {"ok": True, "status": "applied"} if body is _UNSET else body

    async def request(self, method, url, *, json=None, timeout=None, headers=None):
        self.requests.append(
            {"method": method, "url": url, "json": json, "headers": headers}
        )
        return types.SimpleNamespace(
            status_code=self._status, json=lambda: self._body
        )


_GOOD_SECRET = "x" * 32


class TestPhoneEventClient(unittest.IsolatedAsyncioTestCase):
    def _client(self, transport):
        return phone.PhoneEventClient(
            transport_factory=lambda: transport, api_base="http://api.test"
        )

    async def test_posts_the_exact_body_and_auth_header(self):
        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).post_event(
                _ATTEMPT_ID, "classify.human", epoch=3
            )
        self.assertTrue(outcome.ok)
        request = transport.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["url"], "http://api.test/api/internal/phone/events")
        self.assertEqual(
            request["json"],
            {"attempt_id": _ATTEMPT_ID, "event_type": "classify.human", "epoch": 3},
        )
        self.assertEqual(request["headers"]["Authorization"], f"Bearer {_GOOD_SECRET}")
        self.assertEqual(request["headers"]["Content-Type"], "application/json")

    async def test_short_secret_fails_closed_before_any_transport(self):
        transport = _RecordingTransport()
        for secret in ("", "too-short"):
            with self.subTest(secret=secret):
                with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": secret}):
                    outcome = await self._client(transport).post_event(
                        _ATTEMPT_ID, "classify.human"
                    )
                self.assertFalse(outcome.ok)
                self.assertEqual(outcome.error_category, "configuration")
                self.assertEqual(transport.requests, [])

    async def test_event_outside_the_allowlist_never_reaches_the_wire(self):
        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).post_event(_ATTEMPT_ID, "session.scored")
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.error_category, "event_not_allowed")
        self.assertEqual(transport.requests, [])

    async def test_number_like_metadata_is_refused_before_the_wire(self):
        transport = _RecordingTransport()
        cases = [
            {"dialed": _NUMBER_LIKE},
            {"digits": 9812345670},
            {"nested": {"a": 1}},
            {"note": "call 9812345670 back"},
        ]
        for metadata in cases:
            with self.subTest(metadata=metadata):
                with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
                    outcome = await self._client(transport).post_event(
                        _ATTEMPT_ID, "classify.human", metadata=metadata
                    )
                self.assertFalse(outcome.ok)
                self.assertEqual(outcome.error_category, "metadata_rejected")
                self.assertEqual(transport.requests, [])

    async def test_benign_metadata_is_allowed_through(self):
        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).post_event(
                _ATTEMPT_ID, "classify.machine", metadata={"reason": "voicemail"}
            )
        self.assertTrue(outcome.ok)
        self.assertEqual(transport.requests[0]["json"]["metadata"], {"reason": "voicemail"})

    async def test_non_2xx_and_malformed_bodies_fail_closed(self):
        cases = [
            (500, {"ok": True}),
            (403, {"ok": True}),
            (200, {"ok": False, "status": "rejected"}),
            (200, "not a dict"),
            (200, None),
        ]
        for status, body in cases:
            with self.subTest(status=status, body=body):
                transport = _RecordingTransport(status, body)
                with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
                    outcome = await self._client(transport).post_event(
                        _ATTEMPT_ID, "classify.human"
                    )
                self.assertFalse(outcome.ok)

    async def test_duplicate_and_ignored_are_surfaced(self):
        transport = _RecordingTransport(
            200, {"ok": True, "status": "ignored", "ignored_reason": "terminal", "duplicate": True}
        )
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).post_event(_ATTEMPT_ID, "classify.human")
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.status, "ignored")
        self.assertTrue(outcome.duplicate)
        self.assertEqual(outcome.ignored_reason, "terminal")

    async def test_appointment_body_shape(self):
        transport = _RecordingTransport(200, {"ok": True, "status": "ok"})
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).book_appointment(
                _ATTEMPT_ID, "2026-08-25T09:30:00Z", 1800
            )
        self.assertTrue(outcome.ok)
        self.assertEqual(
            transport.requests[0]["json"],
            {
                "attempt_id": _ATTEMPT_ID,
                "starts_at": "2026-08-25T09:30:00Z",
                "duration_seconds": 1800,
            },
        )
        self.assertEqual(
            transport.requests[0]["url"], "http://api.test/api/internal/phone/appointments"
        )

    async def test_a_200_carrying_ok_false_is_a_refusal(self):
        transport = _RecordingTransport(200, {"ok": False, "status": "window_closed"})
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).book_appointment(
                _ATTEMPT_ID, "2026-08-25T09:30:00Z", 1800
            )
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.status, "window_closed")


# ── The scheduling tool ───────────────────────────────────────────────

_CONFIRM_MARKERS = ("booked", "i've got that")


def _claims_a_booking(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _CONFIRM_MARKERS)


class TestScheduleCallback(unittest.IsolatedAsyncioTestCase):
    async def _turn(self, booking, starts_at="2026-08-25T09:30:00Z", duration=1800):
        client = FakeEventClient(booking=booking)
        turn = await phone.schedule_callback_turn(client, _ATTEMPT_ID, starts_at, duration)
        return turn, client

    async def test_confirms_only_after_ok(self):
        for status in ("ok", "ok_prereqs_pending"):
            with self.subTest(status=status):
                turn, client = await self._turn(phone.PhoneApiOutcome(True, status))
                self.assertTrue(turn.booked)
                self.assertTrue(_claims_a_booking(turn.spoken))
                self.assertEqual(len(client.bookings), 1)

    async def test_every_refusal_code_is_distinct_and_confirms_nothing(self):
        codes = [
            "attempt_in_flight",
            "slot_in_past",
            "window_closed",
            "slot_duration_invalid",
            "version_conflict",
            "engagement_terminal",
        ]
        spoken: dict[str, str] = {}
        for code in codes:
            turn, _ = await self._turn(phone.PhoneApiOutcome(False, code))
            self.assertFalse(turn.booked, code)
            self.assertFalse(_claims_a_booking(turn.spoken), code)
            spoken[code] = turn.spoken
        self.assertEqual(len(set(spoken.values())), len(codes))

    async def test_unknown_refusal_code_uses_the_non_committal_fallback(self):
        turn, _ = await self._turn(phone.PhoneApiOutcome(False, "brand_new_refusal"))
        self.assertFalse(turn.booked)
        self.assertFalse(_claims_a_booking(turn.spoken))

    async def test_ok_with_an_unrecognised_status_is_not_a_booking(self):
        turn, _ = await self._turn(phone.PhoneApiOutcome(True, "ok_probably"))
        self.assertFalse(turn.booked)
        self.assertFalse(_claims_a_booking(turn.spoken))

    async def test_transport_failure_is_not_a_booking(self):
        turn, _ = await self._turn(phone.PhoneApiOutcome(False, None, error_category="transport"))
        self.assertFalse(turn.booked)
        self.assertFalse(_claims_a_booking(turn.spoken))

    async def test_bad_arguments_never_reach_the_server(self):
        cases = [
            ("2026-08-25 09:30:00", 1800),
            ("2026-08-25T09:30:00+05:30", 1800),
            ("tomorrow morning", 1800),
            (None, 1800),
            ("2026-08-25T09:30:00Z", 60),
            ("2026-08-25T09:30:00Z", 7200),
            ("2026-08-25T09:30:00Z", "soon"),
        ]
        for starts_at, duration in cases:
            with self.subTest(starts_at=starts_at, duration=duration):
                turn, client = await self._turn(
                    phone.PhoneApiOutcome(True, "ok"), starts_at, duration
                )
                self.assertFalse(turn.booked)
                self.assertFalse(_claims_a_booking(turn.spoken))
                self.assertEqual(client.bookings, [])

    async def test_duration_envelope_boundaries_are_accepted(self):
        for duration in (900, 3600):
            with self.subTest(duration=duration):
                turn, client = await self._turn(
                    phone.PhoneApiOutcome(True, "ok"), duration=duration
                )
                self.assertTrue(turn.booked)
                self.assertEqual(client.bookings[0][2], duration)

    async def test_tool_never_mentions_google_calendar_or_email(self):
        texts = [phone._SCHEDULE_CONFIRMED_TEXT, phone._SCHEDULE_REFUSAL_FALLBACK]
        texts.extend(phone._SCHEDULE_REFUSAL_TEXT.values())
        for text in texts:
            with self.subTest(text=text):
                lowered = text.lower()
                for banned in ("google", "calendar", "email", "e-mail", "invite"):
                    self.assertNotIn(banned, lowered)

    async def test_agent_tool_speaks_the_turn(self):
        spoken: list[str] = []

        async def say(text):
            spoken.append(text)

        client = FakeEventClient(booking=phone.PhoneApiOutcome(True, "ok"))
        cls = phone.phone_agent_class(agent_mod.Agent)
        agent = cls("instructions", client=client, attempt_id=_ATTEMPT_ID, say=say)
        result = await agent.schedule_callback("2026-08-25T09:30:00Z", 1800)
        self.assertTrue(_claims_a_booking(result))
        self.assertEqual(spoken, [result])
        self.assertTrue(agent.bookings[0].booked)

    async def test_agent_tool_refusal_speaks_no_confirmation(self):
        spoken: list[str] = []

        async def say(text):
            spoken.append(text)

        client = FakeEventClient(booking=phone.PhoneApiOutcome(False, "attempt_in_flight"))
        cls = phone.phone_agent_class(agent_mod.Agent)
        agent = cls("instructions", client=client, attempt_id=_ATTEMPT_ID, say=say)
        result = await agent.schedule_callback("2026-08-25T09:30:00Z", 1800)
        self.assertFalse(_claims_a_booking(result))
        self.assertFalse(agent.bookings[0].booked)


class TestFunctionToolBinding(unittest.TestCase):
    """The SDK symbol is read by its real name — a rename must fail loudly."""

    def test_resolver_reads_function_tool_from_livekit_agents(self):
        sentinel = object()
        agents = sys.modules["livekit.agents"]
        had = hasattr(agents, "function_tool")
        original = getattr(agents, "function_tool", None)
        try:
            agents.function_tool = sentinel
            self.assertIs(phone.resolve_function_tool(), sentinel)
        finally:
            if had:
                agents.function_tool = original
            else:
                delattr(agents, "function_tool")

    def test_resolver_returns_none_when_the_symbol_is_absent(self):
        agents = sys.modules["livekit.agents"]
        original = getattr(agents, "function_tool", None)
        if original is not None:
            delattr(agents, "function_tool")
        try:
            self.assertIsNone(phone.resolve_function_tool())
        finally:
            if original is not None:
                agents.function_tool = original

    def test_tool_decorator_is_applied_when_the_sdk_provides_one(self):
        applied: list = []

        def fake_function_tool(fn):
            applied.append(fn)
            return fn

        agents = sys.modules["livekit.agents"]
        original = getattr(agents, "function_tool", None)
        agents.function_tool = fake_function_tool
        try:
            def sample():
                return None

            phone._tool(sample)
        finally:
            if original is None:
                delattr(agents, "function_tool")
            else:
                agents.function_tool = original
        self.assertEqual(applied, [sample])


# ── Disconnect mapping ────────────────────────────────────────────────

class TestPhoneDisconnectMapping(unittest.TestCase):
    def _classify(self, reason):
        return agent_mod._classify_close_event(
            types.SimpleNamespace(error=None, reason=reason)
        )

    def test_sip_reasons_are_mapped_to_a_failure_bucket(self):
        for reason in ("USER_UNAVAILABLE", "USER_REJECTED", "SIP_TRUNK_FAILURE"):
            with self.subTest(reason=reason):
                self.assertEqual(self._classify(f"DisconnectReason.{reason}"), "provider_error")

    def test_unknown_reason_still_fails_closed_to_worker_crash(self):
        for reason in ("SOMETHING_NEW", "sip_unknown_future_reason", "media_failure"):
            with self.subTest(reason=reason):
                self.assertEqual(self._classify(reason), "worker_crash")

    def test_browser_reasons_are_unchanged(self):
        self.assertIsNone(self._classify("CloseReason.CLIENT_INITIATED"))
        self.assertIsNone(self._classify("CloseReason.PARTICIPANT_DISCONNECTED"))
        self.assertEqual(self._classify("CloseReason.JOB_SHUTDOWN"), "shutdown_forced")


# ── The phone session ─────────────────────────────────────────────────

class _FakeSpeech:
    async def wait_for_playout(self):
        return None


class _FakePhoneSession:
    instances: list = []

    def __init__(self, **kwargs):
        self.handlers: dict = {}
        self.started_with = None
        self.spoken: list[str] = []
        self.start_calls = 0
        _FakePhoneSession.instances.append(self)

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
        return _FakeSpeech()

    def emit_user_turn(self, text):
        handler = self.handlers.get("conversation_item_added")
        item = types.SimpleNamespace(
            role="user", content=[types.SimpleNamespace(text=text)]
        )
        handler(types.SimpleNamespace(item=item))

    def emit_close(self, reason=None):
        handler = self.handlers.get("close")
        handler(types.SimpleNamespace(error=None, reason=reason))


class TestPhoneSessionFlow(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _FakePhoneSession.instances = []

    async def _run_session(self, *, participant=True, answers=(), close_after=True):
        ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()] if participant else [])
        client = FakeEventClient()
        recording: list[int] = []

        async def recording_seam():
            recording.append(1)

        async def classifier(turns, say):
            for text in answers:
                pass
            return agent_mod.classify_answer_text(answers[0]) or phone.CLASSIFY_MACHINE

        persistence_spy = MagicMock()
        with patch.object(agent_mod, "AgentSession", _FakePhoneSession), \
             patch.object(agent_mod, "persistence", persistence_spy), \
             patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock) as delete, \
             patch.object(
                 agent_mod, "_phone_recording_permitted", new=recording_seam
             ), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.05):
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, client=client, classifier=classifier
                )
            )
            await asyncio.sleep(0.01)
            session = _FakePhoneSession.instances[-1] if _FakePhoneSession.instances else None
            if close_after and session is not None and session.start_calls:
                session.emit_close()
            result = await asyncio.wait_for(task, timeout=5)
        return result, client, recording, delete, session, persistence_spy

    async def test_human_path_records_and_completes(self):
        result, client, recording, delete, session, persistence_spy = await self._run_session(
            answers=("Yes, that's fine.",)
        )
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(recording, [1])
        self.assertEqual(
            client.event_types,
            ["classify.human", "disclosure.delivered", "assessment.completed"],
        )
        self.assertEqual(session.spoken[0], phone.PHONE_DISCLOSURE_TEXT)
        delete.assert_awaited()
        self.assertEqual(persistence_spy.mock_calls, [])

    async def test_machine_path_cannot_score_writeback_or_record(self):
        result, client, recording, delete, session, persistence_spy = await self._run_session(
            answers=("Please leave a message after the tone.",)
        )
        self.assertFalse(result.assessment_allowed)
        self.assertEqual(recording, [])
        self.assertEqual(client.event_types, ["classify.machine"])
        self.assertNotIn("assessment.completed", client.event_types)
        # No scoring trigger, no session writeback — persistence is untouched.
        self.assertEqual(persistence_spy.mock_calls, [])
        delete.assert_awaited()

    async def test_session_never_starts_and_nothing_is_spoken_without_a_participant(self):
        with patch.object(phone, "phone_participant_wait_sec", lambda: 0.01):
            result, client, recording, delete, session, _ = await self._run_session(
                participant=False, answers=("Yes",), close_after=False
            )
        self.assertEqual(result.outcome, phone.GATE_NO_PARTICIPANT)
        self.assertEqual(session.start_calls, 0)
        self.assertEqual(session.spoken, [])
        self.assertEqual(client.calls, [])
        self.assertEqual(recording, [])

    async def test_recording_is_off_at_session_start(self):
        _, _, _, _, session, _ = await self._run_session(answers=("Yes, sure.",))
        self.assertEqual(
            session.started_with["record"],
            {"audio": False, "transcript": False, "traces": False, "logs": False},
        )


# ── Number safety ─────────────────────────────────────────────────────

class TestNumberNeverCarried(unittest.IsolatedAsyncioTestCase):
    """A phone number must not appear in a log, a prompt, a tool argument or an
    event body. Asserted at the CALL SITE, before the logger's own redaction —
    a grep of sanitised output would pass even if the call site leaked."""

    async def test_no_digit_run_reaches_a_log_call_or_an_event_body(self):
        raw_log_args: list = []

        def _capture(level, event, meta=None):
            raw_log_args.append((level, event, dict(meta or {})))

        ctx = FakeCtx(
            _PHONE_ROOM,
            metadata='{"channel":"phone"}',
            participants=[_participant(identity=f"sip_{_NUMBER_LIKE}")],
        )
        client = FakeEventClient()

        async def classifier(turns, say):
            return phone.CLASSIFY_HUMAN

        with patch.object(agent_mod._log, "_emit", _capture), \
             patch.object(phone._log, "_emit", _capture), \
             patch.object(agent_mod, "AgentSession", _FakePhoneSession), \
             patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.05):
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, client=client, classifier=classifier
                )
            )
            await asyncio.sleep(0.01)
            session = _FakePhoneSession.instances[-1]
            session.emit_close()
            await asyncio.wait_for(task, timeout=5)

        digits = phone._DIGIT_RUN_RE
        for level, event, meta in raw_log_args:
            for value in list(meta.values()) + [event]:
                self.assertIsNone(digits.search(str(value)), f"{event}:{value}")
        for _attempt, _event, extra in client.calls:
            self.assertIsNone(digits.search(str(extra)))
        for text in session.spoken:
            self.assertIsNone(digits.search(text))

    def test_the_prompt_and_the_fixed_lines_carry_no_number(self):
        digits = phone._DIGIT_RUN_RE
        for text in (
            phone.PHONE_DISCLOSURE_TEXT,
            phone.PHONE_REASK_TEXT,
            phone.PHONE_REFUSED_TEXT,
            phone.PHONE_OPT_OUT_TEXT,
            phone.PHONE_WRONG_NUMBER_TEXT,
        ):
            with self.subTest(text=text):
                self.assertIsNone(digits.search(text))


if __name__ == "__main__":
    unittest.main()
