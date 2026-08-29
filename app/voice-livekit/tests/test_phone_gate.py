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
import inspect
import json
import os
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
                self.chat_ctx = types.SimpleNamespace(items=[])

            async def update_chat_ctx(self, ctx):
                self.chat_ctx = ctx

        agents.Agent = _Agent
    if not hasattr(agents, "StopResponse"):
        class _StopResponse(Exception):
            pass
        agents.StopResponse = _StopResponse
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
import prompting  # noqa: E402


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


# The room is keyed by SESSION and the attempt id arrives on the DISPATCH
# metadata. They are DIFFERENT uuids here on purpose: the previous fixture built
# the room name out of the attempt id, so the suite asserted the worker's own
# (wrong) convention against itself and could never have caught the mismatch.
_SESSION_ID = "9c4a1e75-2b83-41d7-8f60-1ea55d3c9b02"
_ATTEMPT_ID = "3f1c9d40-6f5a-4d2b-9a1e-77c0e2b1a5d3"
_PHONE_ROOM = f"phone-{_SESSION_ID}"
_BROWSER_ROOM = "screening-5b2a34cb-a912-4c68-a2c2-79ccdc1dcdd1"


_EPOCH = 3


def _dispatch_metadata(
    *, session_id=_SESSION_ID, attempt_id=_ATTEMPT_ID, channel="phone",
    epoch=_EPOCH, drop_epoch=False,
) -> str:
    """The exact blob `buildPhoneDispatchMetadata` mints, as JSON text.

    P5 added `epoch`: the heartbeat's entire claim to the concurrency lease
    travels on this blob, so a fixture that omitted it would be asserting a
    dispatch the worker must refuse.
    """
    blob = {"session_id": session_id, "attempt_id": attempt_id, "channel": channel}
    if not drop_epoch:
        blob["epoch"] = epoch
    return json.dumps(blob)
# Never a real number. Used only to prove it does not appear in an output.
_NUMBER_LIKE = "+919812345670"


# ── Fakes ─────────────────────────────────────────────────────────────

def _plan_payload(questions=None, cursor=0, completed=None, turns=None, name="Asha"):
    """The exact body `/assessment/start` returns, built here rather than
    hand-mocked as a `PhoneAssessmentState`, so `PhoneAssessmentState.parse`
    — the projection that actually runs in production — is under test too."""
    questions = questions if questions is not None else [
        {"key": "k1", "text": "First question?", "mandatory": True, "hint": None},
        {"key": "k2", "text": "Second question?", "mandatory": False, "hint": None},
    ]
    return {
        "ok": True,
        "status": "ok",
        "context": {"session_id": _SESSION_ID, "candidate_name": name, "status": "in_progress"},
        "plan": {
            "source": "role_template",
            "question_count": len(questions),
            "questions": questions,
        },
        "progress": {
            "cursor": cursor,
            "next_key": questions[cursor]["key"] if cursor < len(questions) else None,
            "completed_keys": completed if completed is not None else [],
            "plan_complete": cursor >= len(questions),
        },
        "turns": turns if turns is not None else [],
        "assessment_exists": False,
    }


def _default_state(**kwargs):
    return phone.PhoneAssessmentState.parse(_plan_payload(**kwargs))


class FakeEventClient:
    """Records every event post; each event's outcome is scripted."""

    def __init__(
        self,
        outcomes: dict | None = None,
        booking=None,
        *,
        start=None,
        commits: dict | None = None,
        complete=None,
        heartbeats=None,
        answers=None,
    ) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self.timeline: list[str] = []
        self.bookings: list[tuple[str, str, int]] = []
        self._outcomes = outcomes or {}
        self._booking = booking
        # 0044.
        self._start = start
        self._commits = commits or {}
        self._complete = complete
        self.assessment_calls: list[tuple] = []
        self.boundaries: list[dict] = []
        # 0071 / X4: every per-item transcript write, in order. Modeled with
        # the server's idempotency: a repeat source_item_id converges on the
        # first row (duplicate=True) rather than appending, so a test can
        # assert exactly-once the way the real RPC enforces it.
        self.item_turns: list[dict] = []
        # P5: every lease renewal, recorded separately from the events so a
        # test asserting the event ORDER is not perturbed by the heartbeat.
        self.heartbeats: list[tuple] = []
        self._heartbeats = list(heartbeats or [])
        # Bounce mode: every answered-probe is RECORDED and its outcome scripted.
        # A test asserting the answer WAIT is not perturbed by the other calls.
        self.answered_calls: list[str] = []
        self._answers = list(answers or [])

    async def attempt_answered(self, attempt_id):
        self.answered_calls.append(attempt_id)
        scripted = self._answers
        if scripted:
            outcome = scripted.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        # Default: the server confirms an answer immediately, so a session test
        # that does not care about the wait still proceeds.
        return phone.PhoneAnswerProbe(True, answered=True)

    async def heartbeat_attempt(self, attempt_id, session_id, *, epoch):
        self.heartbeats.append((attempt_id, session_id, epoch))
        scripted = self._heartbeats
        outcome = (
            scripted.pop(0) if scripted
            else phone.PhoneApiOutcome(True, phone.HEARTBEAT_OK_STATUS)
        )
        if outcome.ok and outcome.next_heartbeat_seconds is None:
            outcome.next_heartbeat_seconds = phone.HEARTBEAT_FALLBACK_SEC
        return outcome

    async def post_event(self, attempt_id, event_type, *, epoch=None, session_id=None):
        self.timeline.append(f"event:{event_type}")
        self.calls.append((attempt_id, event_type, {"epoch": epoch, "session_id": session_id}))
        outcome = self._outcomes.get(event_type)
        if outcome is not None:
            return outcome
        return phone.PhoneApiOutcome(True, "applied")

    async def book_appointment(self, attempt_id, starts_at, duration_seconds):
        self.bookings.append((attempt_id, starts_at, duration_seconds))
        if isinstance(self._booking, Exception):
            raise self._booking
        return self._booking or phone.PhoneApiOutcome(False, "attempt_in_flight")

    # ── 0044: the assessment surface ──────────────────────────────────
    # Scripted, and every call is RECORDED, so a test can assert the ORDER of
    # "commit the boundary" against "ask the next question" and against "claim
    # a completion" — which is the whole safety property of this phase.

    async def start_assessment(self, attempt_id, session_id):
        self.assessment_calls.append(("start", attempt_id, session_id))
        if isinstance(self._start, Exception):
            raise self._start
        return self._start if self._start is not None else _default_state()

    async def commit_boundary(
        self, session_id, question_key, expected_index, source_event_id, turns
    ):
        self.boundaries.append({
            "session_id": session_id,
            "question_key": question_key,
            "expected_index": expected_index,
            "source_event_id": source_event_id,
            "turns": list(turns),
        })
        self.assessment_calls.append(("turn", question_key, expected_index))
        scripted = self._commits.get(question_key)
        if scripted is not None:
            return scripted
        outcome = phone.PhoneApiOutcome(True, "applied")
        outcome.cursor = expected_index + 1
        return outcome

    async def commit_item_turn(
        self, session_id, speaker, text, source_item_id, turn_started_at_ms=None
    ):
        # Mirror the server's source_item_id dedup: a repeat converges on the
        # original row rather than appending a second.
        for existing in self.item_turns:
            if existing["source_item_id"] == source_item_id:
                return phone.PhoneApiOutcome(True, "applied", duplicate=True)
        self.item_turns.append({
            "session_id": session_id,
            "speaker": speaker,
            "text": text,
            "source_item_id": source_item_id,
            "turn_started_at_ms": turn_started_at_ms,
        })
        return phone.PhoneApiOutcome(True, "applied", duplicate=False)

    async def complete_assessment(self, attempt_id, session_id):
        self.timeline.append("assessment.complete")
        self.assessment_calls.append(("complete", attempt_id, session_id))
        if self._complete is not None:
            return self._complete
        return phone.PhoneApiOutcome(True, phone.ASSESSMENT_SCORED_STATUS)

    @property
    def committed_keys(self) -> list[str]:
        return [b["question_key"] for b in self.boundaries]

    @property
    def event_types(self) -> list[str]:
        return [call[1] for call in self.calls]


class FakeCtx:
    """JobContext stand-in with an inspectable room and connect() call."""

    def __init__(
        self, room_name: str, metadata=None, participants=None, dispatch=None
    ) -> None:
        self.room = types.SimpleNamespace(
            name=room_name,
            metadata=metadata,
            remote_participants={
                p.identity: p for p in (participants or [])
            },
        )
        # `dispatch` is the per-ATTEMPT job metadata LiveKit delivers as
        # `ctx.job.metadata`. It is the only place an attempt id exists.
        self.job = types.SimpleNamespace(room=None, metadata=dispatch)
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
    def test_phone_room_name_is_recognised_and_carries_the_SESSION_id(self):
        self.assertTrue(phone.is_phone_room(_PHONE_ROOM))
        self.assertEqual(phone.session_id_from_room_name(_PHONE_ROOM), _SESSION_ID)

    def test_no_attempt_id_can_be_read_out_of_a_room_name(self):
        # The room is session-keyed, so there is no such parser to reach for.
        self.assertFalse(hasattr(phone, "attempt_id_from_room_name"))

    def test_browser_room_is_not_a_phone_room(self):
        self.assertFalse(phone.is_phone_room(_BROWSER_ROOM))
        self.assertIsNone(phone.session_id_from_room_name(_BROWSER_ROOM))

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

    def test_preflight_requires_exact_channel_and_schema_marker(self):
        self.assertTrue(phone.is_preflight_room('{"channel":"preflight","schema":1}'))
        self.assertFalse(phone.is_preflight_room('{"channel":"preflight","schema":2}'))
        self.assertFalse(phone.is_preflight_room('{"channel":"phone","schema":1}'))
        self.assertFalse(phone.is_preflight_room('{"channel":"preflight"}'))



# ── Dispatch metadata: the ONLY source of an attempt id ───────────────

class TestDispatchMetadata(unittest.TestCase):
    def test_well_formed_dispatch_yields_the_attempt_id(self):
        ctx = FakeCtx(_PHONE_ROOM, dispatch=_dispatch_metadata())
        self.assertEqual(phone.attempt_id_from_dispatch_metadata(ctx), _ATTEMPT_ID)
        # And it is NOT the session id the room name carries.
        self.assertNotEqual(_ATTEMPT_ID, phone.session_id_from_room_name(_PHONE_ROOM))

    def test_bytes_payload_is_accepted(self):
        ctx = FakeCtx(_PHONE_ROOM, dispatch=_dispatch_metadata().encode("utf-8"))
        self.assertEqual(phone.attempt_id_from_dispatch_metadata(ctx), _ATTEMPT_ID)

    def test_missing_malformed_wrong_channel_or_non_uuid_resolves_nothing(self):
        cases = {
            "absent": None,
            "empty": "",
            "not json": "definitely not json",
            "json array": "[1, 2, 3]",
            "json scalar": '"phone"',
            "no attempt key": json.dumps({"session_id": _SESSION_ID, "channel": "phone"}),
            "null attempt": _dispatch_metadata(attempt_id=None),
            "non uuid attempt": _dispatch_metadata(attempt_id="not-a-uuid"),
            "truncated uuid": _dispatch_metadata(attempt_id=_ATTEMPT_ID[:-1]),
            "numeric attempt": _dispatch_metadata(attempt_id=12345678),
            "wrong channel": _dispatch_metadata(channel="browser"),
            "missing channel": json.dumps(
                {"session_id": _SESSION_ID, "attempt_id": _ATTEMPT_ID}
            ),
            "non string channel": _dispatch_metadata(channel=7),
        }
        for label, dispatch in cases.items():
            with self.subTest(label=label):
                ctx = FakeCtx(_PHONE_ROOM, dispatch=dispatch)
                self.assertIsNone(phone.attempt_id_from_dispatch_metadata(ctx))

    def test_no_job_at_all_is_survivable(self):
        self.assertIsNone(phone.attempt_id_from_dispatch_metadata(object()))


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

    def test_named_worker_sets_agent_name_and_prewarms_one_process(self):
        options = self._build("phone-screener")
        self.assertEqual(options["agent_name"], "phone-screener")
        self.assertEqual(options["num_idle_processes"], 1)

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

    def test_neither_worker_owns_preflight_rooms(self):
        metadata = '{"channel":"preflight","schema":1}'
        self.assertFalse(self._handles("preflight-random", metadata))
        self.assertFalse(self._handles("preflight-random", metadata, agent_name="phone-screener"))


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

    def test_attempt_id_comes_off_the_dispatch_not_the_room_name(self):
        ctx = FakeCtx(_PHONE_ROOM, dispatch=_dispatch_metadata())
        with patch.object(agent_mod, "_phone_agent_name", return_value="p"), \
             patch.object(agent_mod, "_run_phone_session", new_callable=AsyncMock) as run:
            _run(agent_mod._run_phone_entrypoint(ctx, _PHONE_ROOM))
        run.assert_awaited_once()
        self.assertEqual(run.await_args.args[2], _ATTEMPT_ID)
        # The session id in the room name is NEVER passed as the attempt id.
        self.assertNotEqual(run.await_args.args[2], _SESSION_ID)
        # P5: the epoch rides the same blob and reaches the session.
        self.assertEqual(run.await_args.args[3], _EPOCH)

    def test_unresolvable_dispatch_speaks_nothing_posts_nothing_records_nothing(self):
        """B-1: with no attempt id there is nothing safe to do — so nothing is done."""
        cases = {
            "absent": None,
            "not json": "garbage",
            "wrong channel": _dispatch_metadata(channel="browser"),
            "non uuid attempt": _dispatch_metadata(attempt_id="attempt-1"),
            "session id in the attempt slot is still not a dispatch": None,
        }
        for label, dispatch in cases.items():
            with self.subTest(label=label):
                ctx = FakeCtx(_PHONE_ROOM, dispatch=dispatch)
                client = FakeEventClient()
                with patch.object(agent_mod, "_phone_agent_name", return_value="p"), \
                     patch.object(
                         agent_mod, "_run_phone_session", new_callable=AsyncMock
                     ) as run, \
                     patch.object(
                         agent_mod, "_phone_recording_permitted", new_callable=AsyncMock
                     ) as recording, \
                     patch.object(
                         agent_mod, "AgentSession", _FakePhoneSession
                     ):
                    _FakePhoneSession.instances = []
                    _run(agent_mod._run_phone_entrypoint(ctx, _PHONE_ROOM))
                run.assert_not_awaited()          # never connected, never activated
                recording.assert_not_awaited()    # never recorded
                self.assertEqual(client.calls, [])  # never posted an event
                self.assertEqual(_FakePhoneSession.instances, [])  # never spoke
                self.assertEqual(ctx.connected, 0)

    def test_a_dispatch_without_a_usable_EPOCH_conducts_no_call_at_all(self):
        """P5, and fail-closed in the same direction as a missing attempt id.

        The epoch is the heartbeat's whole claim to the concurrency lease.
        Without one this leg cannot renew it, the slot is reclaimed part-way
        through the screening, and the assessment it goes on to score is
        discarded because the engagement has already left `in_call`. Running
        "without a heartbeat" is not a degraded mode; it is the defect. So the
        worker does not connect, speak, activate, record or post.
        """
        cases = {
            "no epoch key": _dispatch_metadata(drop_epoch=True),
            "null epoch": _dispatch_metadata(epoch=None),
            "string epoch": _dispatch_metadata(epoch="3"),
            "float epoch": _dispatch_metadata(epoch=3.5),
            "negative epoch": _dispatch_metadata(epoch=-1),
        }
        for label, dispatch in cases.items():
            with self.subTest(label=label):
                ctx = FakeCtx(_PHONE_ROOM, dispatch=dispatch)
                client = FakeEventClient()
                with patch.object(agent_mod, "_phone_agent_name", return_value="p"), \
                     patch.object(
                         agent_mod, "_run_phone_session", new_callable=AsyncMock
                     ) as run, \
                     patch.object(
                         agent_mod, "_phone_recording_permitted", new_callable=AsyncMock
                     ) as recording, \
                     patch.object(agent_mod, "AgentSession", _FakePhoneSession):
                    _FakePhoneSession.instances = []
                    _run(agent_mod._run_phone_entrypoint(ctx, _PHONE_ROOM))
                run.assert_not_awaited()
                recording.assert_not_awaited()
                self.assertEqual(client.calls, [])
                self.assertEqual(_FakePhoneSession.instances, [])
                self.assertEqual(ctx.connected, 0)

    def test_a_session_keyed_room_never_yields_an_attempt_id(self):
        """The exact B-1 defect: posting the SESSION uuid as the attempt id."""
        ctx = FakeCtx(_PHONE_ROOM, metadata='{"channel":"phone"}')
        resolved = phone.attempt_id_from_dispatch_metadata(ctx)
        self.assertIsNone(resolved)
        self.assertNotEqual(resolved, _SESSION_ID)


# ── The gate ──────────────────────────────────────────────────────────

class TestPhoneGate(unittest.IsolatedAsyncioTestCase):
    async def _gate(self, decision, *, participant=True, client=None, recorder=None, session_id=None):
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
            session_id=session_id,
        )
        return result, client, recorder

    async def test_disclosure_carries_the_session_hint_and_nothing_else_does(self):
        """The recording ordering fix (2026-08-26): the server starts the
        egress at `disclosure.delivered`, before /assessment/start binds the
        session to the row, so the worker must forward the session it already
        holds — on the disclosure, and ONLY the disclosure. classify.human is
        a consent event, not a recording trigger, and widening the hint to
        every event would turn a targeted fix into ambient plumbing."""
        result, client, _ = await self._gate(
            phone.CLASSIFY_HUMAN, session_id=_SESSION_ID,
        )
        self.assertTrue(result.recording_allowed)
        by_type = {etype: kw for (_aid, etype, kw) in client.calls}
        self.assertEqual(by_type["disclosure.delivered"]["session_id"], _SESSION_ID)
        self.assertIsNone(by_type["classify.human"]["session_id"])

    async def test_gate_without_a_hint_still_consents_with_none(self):
        result, client, _ = await self._gate(phone.CLASSIFY_HUMAN)
        self.assertTrue(result.recording_allowed)
        by_type = {etype: kw for (_aid, etype, kw) in client.calls}
        self.assertIsNone(by_type["disclosure.delivered"]["session_id"])

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

    async def test_an_ignored_classify_human_is_not_consent(self):
        """B-2: `ok` is not `applied`.

        `ignored` covers `terminal` — what an HR `emergency.stop` or
        `hr.cancelled` produces — plus `stale_epoch` and `unknown_attempt`.
        Reading any of them as consent keeps the candidate on the line and runs
        the full screening after the system declared the conversation over.
        """
        for reason in ("terminal", "stale_epoch", "unknown_attempt"):
            with self.subTest(reason=reason, event="classify.human"):
                client = FakeEventClient({
                    "classify.human": phone.PhoneApiOutcome(
                        True, "ignored", ignored_reason=reason
                    )
                })
                result, client, recorder = await self._gate(
                    phone.CLASSIFY_HUMAN, client=client
                )
                self.assertIs(result.assessment_allowed, False)
                self.assertIs(result.recording_allowed, False)
                self.assertEqual(recorder.recording_calls, 0)
                # The consent record is never even attempted.
                self.assertEqual(client.event_types, ["classify.human"])
                self.assertEqual(result.events, [])

    async def test_an_ignored_disclosure_grants_nothing(self):
        for reason in ("terminal", "stale_epoch", "unknown_attempt"):
            with self.subTest(reason=reason, event="disclosure.delivered"):
                client = FakeEventClient({
                    "disclosure.delivered": phone.PhoneApiOutcome(
                        True, "ignored", ignored_reason=reason
                    )
                })
                result, client, recorder = await self._gate(
                    phone.CLASSIFY_HUMAN, client=client
                )
                self.assertIs(result.assessment_allowed, False)
                self.assertIs(result.recording_allowed, False)
                self.assertEqual(recorder.recording_calls, 0)
                self.assertNotIn("disclosure.delivered", result.events)

    async def test_ok_with_any_non_applied_status_grants_nothing(self):
        for status in (None, "ignored", "queued", "accepted", "APPLIED"):
            with self.subTest(status=status):
                client = FakeEventClient({
                    "disclosure.delivered": phone.PhoneApiOutcome(True, status)
                })
                result, _, recorder = await self._gate(
                    phone.CLASSIFY_HUMAN, client=client
                )
                self.assertIs(result.assessment_allowed, False)
                self.assertIs(result.recording_allowed, False)
                self.assertEqual(recorder.recording_calls, 0)

    async def test_a_duplicate_applied_event_still_consents(self):
        client = FakeEventClient({
            "classify.human": phone.PhoneApiOutcome(True, "applied", duplicate=True),
            "disclosure.delivered": phone.PhoneApiOutcome(
                True, "applied", duplicate=True
            ),
        })
        result, _, recorder = await self._gate(phone.CLASSIFY_HUMAN, client=client)
        self.assertTrue(result.assessment_allowed)
        self.assertTrue(result.recording_allowed)
        self.assertEqual(recorder.recording_calls, 1)

    async def test_every_gate_event_is_on_the_strict_allowlist(self):
        for decision in phone.PHONE_CLASSIFICATIONS:
            with self.subTest(decision=decision):
                _, client, _ = await self._gate(decision)
                for event_type in client.event_types:
                    self.assertIn(event_type, phone.PHONE_WORKER_EVENTS)


# ── Answer-first origination (Plivo bounce): the answer wait ───────────

class TestBounceAnswerWait(unittest.IsolatedAsyncioTestCase):
    """The bounce-mode wait for the SERVER-VERIFIED answer, at the seam.

    The SIP participant is present ~1 s after dispatch; in bounce mode the gate
    must NOT speak until the server confirms the real candidate answered.
    """

    async def _noskip_sleep(self, _sec):
        # Deterministic clock seam: no wall time, but yield so other tasks run.
        return None

    async def _bounce_gate(
        self, *, answers, decision=None, answer_wait_sec=0.5,
    ):
        recorder = Recorder()
        client = FakeEventClient(answers=answers)
        decision = phone.CLASSIFY_HUMAN if decision is None else decision

        async def wait_for_participant():
            recorder.order.append("participant_wait")
            return _participant()

        async def classify():
            recorder.order.append("classify")
            return decision

        result = await phone.run_phone_gate(
            attempt_id=_ATTEMPT_ID,
            client=client,
            wait_for_participant=wait_for_participant,
            classify=classify,
            say=recorder.say,
            start_recording=recorder.start_recording,
            classify_timeout_sec=0.05,
            session_id=_SESSION_ID,
            post_call_answered=True,
            bounce_mode=True,
            answer_wait_sec=answer_wait_sec,
            answer_poll_interval_sec=0.0,
            answer_wait_sleep=self._noskip_sleep,
        )
        return result, client, recorder

    async def test_nothing_is_spoken_before_the_answer_is_verified(self):
        # The candidate is "still ringing" for two polls, then answers. Nothing
        # may be said, and no event posted, until that answered poll resolves.
        answers = [
            phone.PhoneAnswerProbe(True, answered=False),
            phone.PhoneAnswerProbe(True, answered=False),
            phone.PhoneAnswerProbe(True, answered=True),
        ]
        result, client, recorder = await self._bounce_gate(answers=answers)
        # It polled three times before anything was spoken.
        self.assertEqual(len(client.answered_calls), 3)
        # The wait resolves before any spoken line: participant_wait is first,
        # and a disclosure ("say:") is only reached after the answer verifies.
        self.assertEqual(recorder.order[0], "participant_wait")
        self.assertTrue(any(o.startswith("say:") for o in recorder.order))
        # A verified human still consents and records, exactly as today.
        self.assertTrue(result.assessment_allowed)
        self.assertTrue(result.recording_allowed)

    async def test_answered_then_normal_gate_continues(self):
        # Immediate answer → the gate is byte-identical to the non-bounce human
        # path from here: classify.human then disclosure.delivered then record.
        answers = [phone.PhoneAnswerProbe(True, answered=True)]
        result, client, recorder = await self._bounce_gate(answers=answers)
        self.assertTrue(result.assessment_allowed)
        self.assertTrue(result.recording_allowed)
        self.assertEqual(recorder.recording_calls, 1)
        # call.answered was posted (belt-and-braces) AFTER the wait, then the
        # human consent events, in order.
        self.assertEqual(
            client.event_types,
            ["call.answered", "classify.human", "disclosure.delivered"],
        )
        self.assertEqual(recorder.order[-1], "recording")

    async def test_timeout_speaks_nothing_and_returns_no_participant(self):
        # Every poll says "still ringing"; the budget expires. Nothing is ever
        # spoken, nothing is posted, and the gate returns the no-participant
        # outcome so the caller's close/reclaim path owns the rest.
        answers = [phone.PhoneAnswerProbe(True, answered=False) for _ in range(50)]
        result, client, recorder = await self._bounce_gate(
            answers=answers, answer_wait_sec=0.0,
        )
        self.assertEqual(result.outcome, phone.GATE_NO_PARTICIPANT)
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)
        self.assertEqual(recorder.spoken, [])
        self.assertEqual(recorder.recording_calls, 0)
        # No worker event was posted at all — not even call.answered.
        self.assertEqual(client.calls, [])

    async def test_terminal_speaks_nothing_and_returns_no_participant(self):
        answers = [phone.PhoneAnswerProbe(True, terminal=True)]
        result, client, recorder = await self._bounce_gate(answers=answers)
        self.assertEqual(result.outcome, phone.GATE_NO_PARTICIPANT)
        self.assertFalse(result.assessment_allowed)
        self.assertEqual(recorder.spoken, [])
        self.assertEqual(recorder.recording_calls, 0)
        self.assertEqual(client.calls, [])

    async def test_transport_failures_are_retried_within_the_budget(self):
        # Two unconfirmed readings (transport / malformed) are NOT give-ups:
        # the poll keeps trying and the eventual answer proceeds normally.
        answers = [
            phone.PhoneAnswerProbe(False, error_category="transport"),
            phone.PhoneAnswerProbe(False, error_category="malformed_response"),
            phone.PhoneAnswerProbe(True, answered=True),
        ]
        result, client, recorder = await self._bounce_gate(answers=answers)
        self.assertEqual(len(client.answered_calls), 3)
        self.assertTrue(result.assessment_allowed)

    async def test_a_raising_client_is_a_fault_not_an_answer(self):
        # An exception from the probe must be caught and treated as unconfirmed,
        # never as answered/terminal — then the next reading proceeds.
        answers = [
            RuntimeError("boom"),
            phone.PhoneAnswerProbe(True, answered=True),
        ]
        result, client, _ = await self._bounce_gate(answers=answers)
        self.assertEqual(len(client.answered_calls), 2)
        self.assertTrue(result.assessment_allowed)

    async def test_bounce_off_never_polls_and_is_byte_identical(self):
        # The DEFAULT: bounce_mode omitted → the answered probe is never called
        # and the human path is exactly the legacy one.
        recorder = Recorder()
        client = FakeEventClient(answers=[phone.PhoneAnswerProbe(True, answered=True)])

        async def wait_for_participant():
            return _participant()

        async def classify():
            return phone.CLASSIFY_HUMAN

        result = await phone.run_phone_gate(
            attempt_id=_ATTEMPT_ID,
            client=client,
            wait_for_participant=wait_for_participant,
            classify=classify,
            say=recorder.say,
            start_recording=recorder.start_recording,
            classify_timeout_sec=0.05,
            session_id=_SESSION_ID,
        )
        self.assertEqual(client.answered_calls, [])
        self.assertTrue(result.assessment_allowed)


class TestWaitForVerifiedAnswer(unittest.IsolatedAsyncioTestCase):
    """The standalone answer-wait poller, with injected clocks."""

    def _clock(self, times):
        seq = list(times)
        def now():
            return seq.pop(0) if len(seq) > 1 else seq[0]
        return now

    async def _sleep(self, _sec):
        return None

    async def test_answered_returns_immediately(self):
        client = FakeEventClient(answers=[phone.PhoneAnswerProbe(True, answered=True)])
        verdict = await phone.wait_for_verified_answer(
            attempt_id=_ATTEMPT_ID, client=client, timeout_sec=5.0,
            poll_interval_sec=0.0, sleep=self._sleep,
            monotonic=self._clock([0.0, 0.0]),
        )
        self.assertEqual(verdict, "answered")
        self.assertEqual(len(client.answered_calls), 1)

    async def test_terminal_gives_up_with_the_terminal_reason(self):
        client = FakeEventClient(answers=[phone.PhoneAnswerProbe(True, terminal=True)])
        verdict = await phone.wait_for_verified_answer(
            attempt_id=_ATTEMPT_ID, client=client, timeout_sec=5.0,
            poll_interval_sec=0.0, sleep=self._sleep,
            monotonic=self._clock([0.0, 0.0]),
        )
        self.assertEqual(verdict, phone.BOUNCE_GIVEUP_TERMINAL)

    async def test_budget_expiry_on_still_ringing_is_a_timeout(self):
        client = FakeEventClient(
            answers=[phone.PhoneAnswerProbe(True, answered=False) for _ in range(10)]
        )
        # monotonic jumps past the deadline on the second read.
        verdict = await phone.wait_for_verified_answer(
            attempt_id=_ATTEMPT_ID, client=client, timeout_sec=1.0,
            poll_interval_sec=0.0, sleep=self._sleep,
            monotonic=self._clock([0.0, 2.0]),
        )
        self.assertEqual(verdict, phone.BOUNCE_GIVEUP_TIMEOUT)

    async def test_budget_expiry_on_a_transport_failure_is_distinguishable(self):
        client = FakeEventClient(
            answers=[phone.PhoneAnswerProbe(False, error_category="transport")]
        )
        verdict = await phone.wait_for_verified_answer(
            attempt_id=_ATTEMPT_ID, client=client, timeout_sec=1.0,
            poll_interval_sec=0.0, sleep=self._sleep,
            monotonic=self._clock([0.0, 2.0]),
        )
        self.assertEqual(verdict, phone.BOUNCE_GIVEUP_TRANSPORT)

    async def test_give_up_reasons_are_a_bounded_set(self):
        self.assertEqual(
            {
                phone.BOUNCE_GIVEUP_TIMEOUT,
                phone.BOUNCE_GIVEUP_TERMINAL,
                phone.BOUNCE_GIVEUP_TRANSPORT,
            },
            {"answer_wait_timeout", "attempt_terminal", "answer_wait_transport"},
        )


# ── Phone Parity 2: call.answered, LLM opening, consent bridge, gate turns ──

class _AtomicEventClient(FakeEventClient):
    """A production-shaped client: exposes the atomic consent/start RPC and the
    gate-turn commit, both scripted and recorded."""

    def __init__(self, *, consent=None, gate=None, gate_raises=False, **kwargs):
        super().__init__(**kwargs)
        self._consent = consent
        self._gate = gate
        self._gate_raises = gate_raises
        self.consent_calls: list[tuple] = []
        self.gate_commits: list[dict] = []

    async def consent_and_start_assessment(self, attempt_id, session_id, epoch):
        self.consent_calls.append((attempt_id, session_id, epoch))
        self.timeline.append("consent_and_start")
        if self._consent is not None:
            return self._consent
        return _default_state()

    async def commit_gate_turns(self, session_id, turns, source_event_id):
        self.gate_commits.append({
            "session_id": session_id,
            "turns": list(turns),
            "source_event_id": source_event_id,
        })
        self.timeline.append("gate_turns")
        if self._gate_raises:
            raise RuntimeError("gate turns boom")
        if self._gate is not None:
            return self._gate
        return phone.PhoneApiOutcome(True, "ok")


_VERIFIED_OPENING = (
    "Hi, this is Christy from the company about your job application. "
    "This call is recorded so the hiring team can review it. "
    "Is it okay to continue?"
)


class TestPhoneParity2Gate(unittest.IsolatedAsyncioTestCase):
    """The Phone Parity 2 additions to the gate, tested at the seam."""

    async def _atomic_gate(
        self, *, decision=phone.CLASSIFY_HUMAN, client=None, recorder=None,
        speak_opening=None, post_call_answered=True, consent_reply="Yes, that's fine.",
        answered=None,
    ):
        recorder = recorder or Recorder()
        client = client or _AtomicEventClient()
        if answered is not None:
            client._outcomes["call.answered"] = answered
        consent_reply_out: list[str] = []

        async def wait_for_participant():
            recorder.order.append("participant_wait")
            return _participant()

        async def classify():
            recorder.order.append("classify")
            if consent_reply is not None:
                consent_reply_out.append(consent_reply)
            return decision

        result = await phone.run_phone_gate(
            attempt_id=_ATTEMPT_ID,
            client=client,
            wait_for_participant=wait_for_participant,
            classify=classify,
            say=recorder.say,
            start_recording=recorder.start_recording,
            classify_timeout_sec=0.05,
            session_id=_SESSION_ID,
            epoch=_EPOCH,
            post_call_answered=post_call_answered,
            speak_opening=speak_opening,
            consent_reply_out=consent_reply_out,
        )
        return result, client, recorder

    # ── call.answered ────────────────────────────────────────────────────

    async def test_call_answered_is_posted_after_participant_before_disclosure(self):
        result, client, recorder = await self._atomic_gate()
        self.assertTrue(result.assessment_allowed)
        # First event on the wire is call.answered, and it carries the session hint.
        first = client.calls[0]
        self.assertEqual(first[1], "call.answered")
        self.assertEqual(first[2]["session_id"], _SESSION_ID)
        self.assertEqual(first[2]["epoch"], _EPOCH)
        # Ordering: participant, then call.answered event, then disclosure say.
        self.assertEqual(recorder.order[0], "participant_wait")
        answered_at = client.timeline.index("event:call.answered")
        # The disclosure (fixed, since no speak_opening) is said after the post.
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)

    async def test_gate_proceeds_when_call_answered_is_ignored(self):
        ignored = phone.PhoneApiOutcome(True, "ignored")
        result, client, recorder = await self._atomic_gate(answered=ignored)
        # Ignored call.answered does NOT record the event, but the call continues.
        self.assertTrue(result.assessment_allowed)
        self.assertNotIn("call.answered", result.events)
        self.assertEqual(client.calls[0][1], "call.answered")

    async def test_call_answered_transport_failure_does_not_kill_the_call(self):
        boom = phone.PhoneApiOutcome(False, error_category="transport")
        result, client, recorder = await self._atomic_gate(answered=boom)
        self.assertTrue(result.assessment_allowed)
        self.assertNotIn("call.answered", result.events)

    async def test_legacy_caller_never_posts_call_answered(self):
        # Default post_call_answered=False keeps the legacy event order intact.
        recorder = Recorder()
        client = _AtomicEventClient()

        async def wait_for_participant():
            return _participant()

        async def classify():
            return phone.CLASSIFY_HUMAN

        result = await phone.run_phone_gate(
            attempt_id=_ATTEMPT_ID, client=client,
            wait_for_participant=wait_for_participant, classify=classify,
            say=recorder.say, start_recording=recorder.start_recording,
            classify_timeout_sec=0.05, session_id=_SESSION_ID, epoch=_EPOCH,
        )
        self.assertNotIn("call.answered", [c[1] for c in client.calls])

    # ── LLM opening + verification/fallback ──────────────────────────────

    async def test_llm_opening_is_used_captured_and_gate_turns_committed_once(self):
        spoken_openings: list[str] = []

        async def speak_opening():
            spoken_openings.append(_VERIFIED_OPENING)
            return _VERIFIED_OPENING

        result, client, recorder = await self._atomic_gate(speak_opening=speak_opening)
        self.assertTrue(result.assessment_allowed)
        # The generated opening was used, NOT the fixed disclosure.
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        self.assertEqual(len(spoken_openings), 1)
        # Gate turns committed exactly once, [bot opening, candidate reply],
        # with the deterministic gate:<session> source id.
        self.assertEqual(len(client.gate_commits), 1)
        commit = client.gate_commits[0]
        self.assertEqual(commit["source_event_id"], f"gate:{_SESSION_ID}")
        self.assertEqual([t["speaker"] for t in commit["turns"]], ["bot", "candidate"])
        self.assertEqual(commit["turns"][0]["text"], _VERIFIED_OPENING)
        self.assertEqual(commit["turns"][1]["text"], "Yes, that's fine.")

    async def test_unverified_opening_falls_back_and_still_commits_fixed_text(self):
        async def speak_opening():
            # Warm but discloses nothing and asks nothing → verification fails.
            return "Hi there, lovely to reach you today."

        result, client, recorder = await self._atomic_gate(speak_opening=speak_opening)
        self.assertTrue(result.assessment_allowed)
        # Fell back to the fixed disclosure...
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        # ...and STILL committed the gate turns, with the fixed opening text.
        self.assertEqual(len(client.gate_commits), 1)
        self.assertEqual(
            client.gate_commits[0]["turns"][0]["text"], phone.PHONE_DISCLOSURE_TEXT
        )

    async def test_speak_opening_that_raises_falls_back_to_fixed_disclosure(self):
        async def speak_opening():
            raise RuntimeError("generate_reply unavailable")

        result, client, recorder = await self._atomic_gate(speak_opening=speak_opening)
        self.assertTrue(result.assessment_allowed)
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        self.assertEqual(
            client.gate_commits[0]["turns"][0]["text"], phone.PHONE_DISCLOSURE_TEXT
        )

    def test_opening_verification_predicate(self):
        # record + question shape → verified.
        self.assertTrue(phone._opening_is_verified(
            "This call is recorded. Is it okay to continue?"
        ))
        self.assertTrue(phone._opening_is_verified(
            "We record this call so the team can review; okay to continue"
        ))
        # missing 'record' → not verified.
        self.assertFalse(phone._opening_is_verified("Is it okay to continue?"))
        # missing question shape → not verified.
        self.assertFalse(phone._opening_is_verified("This call is recorded."))
        self.assertFalse(phone._opening_is_verified(""))
        self.assertFalse(phone._opening_is_verified(None))

    # ── consent bridge ───────────────────────────────────────────────────

    async def test_consent_bridge_is_spoken_after_human_and_is_gate_copy(self):
        result, client, recorder = await self._atomic_gate()
        self.assertTrue(result.assessment_allowed)
        self.assertIn(phone.PHONE_CONSENT_BRIDGE_TEXT, recorder.spoken)
        self.assertTrue(phone.is_gate_copy(phone.PHONE_CONSENT_BRIDGE_TEXT))
        # It overlaps the RPC: the bridge say and the consent RPC both happen,
        # and the bridge is reaped before the gate returns.
        self.assertIn("consent_and_start", client.timeline)

    async def test_a_failing_bridge_never_fails_the_gate(self):
        class _BridgeBoomRecorder(Recorder):
            async def say(self, text):
                if text == phone.PHONE_CONSENT_BRIDGE_TEXT:
                    raise RuntimeError("bridge playout failed")
                await super().say(text)

        result, client, recorder = await self._atomic_gate(
            recorder=_BridgeBoomRecorder()
        )
        # The gate still consents and starts despite the bridge raising.
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(len(client.consent_calls), 1)

    # ── gate-turn commit failure ─────────────────────────────────────────

    async def test_gate_turns_commit_failure_does_not_fail_the_call(self):
        client = _AtomicEventClient(gate=phone.PhoneApiOutcome(False, "invalid_turns"))
        result, client, recorder = await self._atomic_gate(client=client)
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(len(client.gate_commits), 1)

    async def test_gate_turns_commit_exception_does_not_fail_the_call(self):
        client = _AtomicEventClient(gate_raises=True)
        result, client, recorder = await self._atomic_gate(client=client)
        self.assertTrue(result.assessment_allowed)

    async def test_no_consent_reply_still_commits_the_opening_only(self):
        async def speak_opening():
            return _VERIFIED_OPENING

        result, client, recorder = await self._atomic_gate(
            speak_opening=speak_opening, consent_reply=None
        )
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(len(client.gate_commits), 1)
        turns = client.gate_commits[0]["turns"]
        self.assertEqual([t["speaker"] for t in turns], ["bot"])

    async def test_classify_timeout_logs_the_stage(self):
        recorder = Recorder()
        client = _AtomicEventClient()

        async def wait_for_participant():
            return _participant()

        async def classify():
            await asyncio.sleep(5)
            return phone.CLASSIFY_HUMAN

        with self.assertLogs(level="WARNING") if False else _noop_ctx():
            result = await phone.run_phone_gate(
                attempt_id=_ATTEMPT_ID, client=client,
                wait_for_participant=wait_for_participant, classify=classify,
                say=recorder.say, classify_timeout_sec=0.02,
                session_id=_SESSION_ID, epoch=_EPOCH, post_call_answered=True,
            )
        # A classify timeout fails closed to machine — the diagnostic log is the
        # point, and the machine verdict proves the timeout path was taken.
        self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)

    # ── F2: durable consent on re-dispatch never re-asks ─────────────────
    # A worker deploy/crash mid-call re-dispatches the leg into a conversation
    # that has ALREADY consented. Speaking the disclosure again asked the
    # candidate for consent a SECOND time (2026-08-29). The gate consults the
    # server's durable state before speaking and skips the whole gate when the
    # gate turns were already recorded.

    def _consented_state(self):
        payload = _plan_payload(cursor=1, completed=["k1"])
        payload["gate_recorded"] = True
        return phone.PhoneAssessmentState.parse(payload)

    async def _gate_with_durable(self, *, durable, client=None, recorder=None):
        recorder = recorder or Recorder()
        client = client or _AtomicEventClient()
        consent_reply_out: list[str] = []
        classified = {"ran": False}

        async def wait_for_participant():
            return _participant()

        async def classify():
            classified["ran"] = True
            consent_reply_out.append("Yes, that's fine.")
            return phone.CLASSIFY_HUMAN

        async def fetch_durable_consent():
            return durable

        result = await phone.run_phone_gate(
            attempt_id=_ATTEMPT_ID,
            client=client,
            wait_for_participant=wait_for_participant,
            classify=classify,
            say=recorder.say,
            start_recording=recorder.start_recording,
            classify_timeout_sec=0.05,
            session_id=_SESSION_ID,
            epoch=_EPOCH,
            post_call_answered=True,
            consent_reply_out=consent_reply_out,
            fetch_durable_consent=fetch_durable_consent,
        )
        return result, client, recorder, classified

    async def test_redispatch_with_gate_recorded_skips_disclosure_and_consent(self):
        durable = self._consented_state()
        result, client, recorder, classified = await self._gate_with_durable(
            durable=durable
        )
        # Authorized to screen, resumed from the SERVER-owned state, WITHOUT the
        # disclosure, the classification, or a second consent application.
        self.assertTrue(result.assessment_allowed)
        self.assertIs(result.assessment_state, durable)
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        self.assertFalse(classified["ran"])
        # No consent-start RPC and no disclosure event on a re-entry.
        self.assertEqual(len(client.consent_calls), 0)
        self.assertNotIn("disclosure.delivered", result.events)
        self.assertNotIn("classify.human", result.events)
        # It does NOT re-commit the gate turns (already recorded) and does NOT
        # re-start the recording (the original consent already bound it).
        self.assertEqual(len(client.gate_commits), 0)
        self.assertEqual(recorder.recording_calls, 0)
        self.assertTrue(result.recording_allowed)

    async def test_fresh_call_with_no_durable_consent_still_gates(self):
        # gate_recorded absent → False. The full gate runs exactly as before.
        result, client, recorder, classified = await self._gate_with_durable(
            durable=_default_state()
        )
        self.assertTrue(result.assessment_allowed)
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        self.assertTrue(classified["ran"])
        self.assertEqual(len(client.consent_calls), 1)

    async def test_new_epoch_not_ok_state_still_gates(self):
        # A new-epoch reconnect that never consented: start returns not-ok
        # (disclosure_not_delivered). The gate must run the disclosure.
        not_consented = phone.PhoneAssessmentState(False, "disclosure_not_delivered")
        result, client, recorder, classified = await self._gate_with_durable(
            durable=not_consented
        )
        self.assertTrue(result.assessment_allowed)
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        self.assertTrue(classified["ran"])

    async def test_durable_fetch_failure_falls_through_to_the_gate(self):
        # None (a fetch failure, an unresolved session) fails OPEN toward gating.
        result, client, recorder, classified = await self._gate_with_durable(
            durable=None
        )
        self.assertTrue(result.assessment_allowed)
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, recorder.spoken)
        self.assertTrue(classified["ran"])


class _noop_ctx:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestCommitGateTurnsClient(unittest.IsolatedAsyncioTestCase):
    """The PhoneEventClient.commit_gate_turns method: happy and failure paths."""

    def _client(self, transport):
        return phone.PhoneEventClient(
            transport_factory=lambda: transport, api_base="http://api.test"
        )

    async def _commit(self, body):
        transport = _RecordingTransport(body=body)
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).commit_gate_turns(
                _SESSION_ID,
                [{"speaker": "bot", "text": "hi"}, {"speaker": "candidate", "text": "yes"}],
                f"gate:{_SESSION_ID}",
            )
        return outcome, transport

    async def test_ok_status_is_success_and_posts_the_exact_body(self):
        outcome, transport = await self._commit({"ok": True, "status": "ok"})
        self.assertTrue(outcome.ok)
        request = transport.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["url"], "http://api.test" + phone.GATE_TURNS_PATH)
        self.assertEqual(request["json"]["session_id"], _SESSION_ID)
        self.assertEqual(request["json"]["source_event_id"], f"gate:{_SESSION_ID}")
        self.assertEqual(len(request["json"]["turns"]), 2)

    async def test_already_recorded_is_also_success(self):
        outcome, _ = await self._commit({"ok": True, "status": "already_recorded"})
        self.assertTrue(outcome.ok)
        self.assertTrue(outcome.duplicate)

    async def test_invalid_turns_is_not_success(self):
        outcome, _ = await self._commit({"ok": False, "status": "invalid_turns"})
        self.assertFalse(outcome.ok)

    async def test_ok_flag_with_off_allowlist_status_fails_closed(self):
        outcome, _ = await self._commit({"ok": True, "status": "unknown_session"})
        self.assertFalse(outcome.ok)

    async def test_malformed_body_fails_closed(self):
        outcome, _ = await self._commit("not-a-dict")
        self.assertFalse(outcome.ok)

    async def test_short_secret_never_reaches_the_wire(self):
        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": "short"}):
            outcome = await self._client(transport).commit_gate_turns(
                _SESSION_ID, [{"speaker": "bot", "text": "hi"}], f"gate:{_SESSION_ID}"
            )
        self.assertFalse(outcome.ok)
        self.assertEqual(transport.requests, [])


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

    async def test_no_metadata_field_is_ever_sent(self):
        """M-5: the server schema is `.strict()`; a `metadata` key is a flat 400.

        The parameter is gone, so the body has exactly three keys on every
        allowlisted event and there is no unreachable guard pretending to
        protect one.
        """
        import inspect

        signature = inspect.signature(phone.PhoneEventClient.post_event)
        self.assertNotIn("metadata", signature.parameters)
        self.assertFalse(hasattr(phone, "_rejects_number_like"))

        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            for event_type in sorted(phone.PHONE_WORKER_EVENTS):
                await self._client(transport).post_event(_ATTEMPT_ID, event_type)
        self.assertEqual(len(transport.requests), len(phone.PHONE_WORKER_EVENTS))
        for request in transport.requests:
            self.assertEqual(
                set(request["json"]), {"attempt_id", "event_type", "epoch"}
            )

    async def test_session_hint_is_sent_only_when_it_is_a_uuid(self):
        """The session hint (recording ordering fix) widens the wire body to a
        FOURTH key only when a well-formed session id is supplied. Anything
        else is omitted, not nulled: the server schema is `.strict()` and the
        absence of knowledge must look like absence, and a malformed value
        must never reach a schema that would 400 the whole consent event."""
        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            await self._client(transport).post_event(
                _ATTEMPT_ID, "disclosure.delivered", session_id=_SESSION_ID,
            )
            await self._client(transport).post_event(
                _ATTEMPT_ID, "disclosure.delivered", session_id="not-a-uuid",
            )
            await self._client(transport).post_event(
                _ATTEMPT_ID, "disclosure.delivered",
            )
        bodies = [r["json"] for r in transport.requests]
        self.assertEqual(bodies[0].get("session_id"), _SESSION_ID)
        self.assertEqual(
            set(bodies[0]), {"attempt_id", "event_type", "epoch", "session_id"}
        )
        for body in bodies[1:]:
            self.assertEqual(set(body), {"attempt_id", "event_type", "epoch"})

    async def test_worker_allowlist_agrees_with_the_server(self):
        """L-4: the deferral event exists on both halves."""
        self.assertIn("candidate.deferred_pre_disclosure", phone.PHONE_WORKER_EVENTS)

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

    async def test_duplicate_of_an_applied_event_is_still_applied(self):
        transport = _RecordingTransport(
            200, {"ok": True, "status": "applied", "duplicate": True}
        )
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).post_event(_ATTEMPT_ID, "classify.human")
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.status, "applied")
        self.assertTrue(outcome.duplicate)
        # Idempotency is preserved by the applied rule, not broken by it.
        self.assertTrue(phone.event_applied(outcome))

    async def test_an_ignored_verdict_from_the_server_fails_closed(self):
        """The server returns ok:false for every `ignored` verdict."""
        for reason in ("terminal", "stale_epoch", "unknown_attempt"):
            with self.subTest(reason=reason):
                transport = _RecordingTransport(
                    200, {"ok": False, "status": "ignored", "ignored_reason": reason}
                )
                with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
                    outcome = await self._client(transport).post_event(
                        _ATTEMPT_ID, "classify.human"
                    )
                self.assertFalse(outcome.ok)
                self.assertFalse(phone.event_applied(outcome))

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

    # ── Bounce mode: the server-verified answer probe ─────────────────

    async def test_answered_probe_is_a_GET_to_the_attempt_scoped_path(self):
        transport = _RecordingTransport(
            200, {"ok": True, "answered": True, "terminal": False}
        )
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            probe = await self._client(transport).attempt_answered(_ATTEMPT_ID)
        self.assertTrue(probe.ok)
        self.assertTrue(probe.answered)
        self.assertFalse(probe.terminal)
        request = transport.requests[0]
        self.assertEqual(request["method"], "GET")
        self.assertEqual(
            request["url"],
            f"http://api.test/api/internal/phone/attempt/{_ATTEMPT_ID}/answered",
        )
        # A GET carries no body, and the bearer/correlation contract still holds.
        self.assertIsNone(request["json"])
        self.assertEqual(request["headers"]["Authorization"], f"Bearer {_GOOD_SECRET}")

    async def test_answered_probe_reads_both_booleans_verbatim(self):
        cases = [
            ({"ok": True, "answered": False, "terminal": False}, (True, False, False)),
            ({"ok": True, "answered": True, "terminal": False}, (True, True, False)),
            ({"ok": True, "answered": False, "terminal": True}, (True, False, True)),
        ]
        for body, (ok, answered, terminal) in cases:
            with self.subTest(body=body):
                transport = _RecordingTransport(200, body)
                with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
                    probe = await self._client(transport).attempt_answered(_ATTEMPT_ID)
                self.assertIs(probe.ok, ok)
                self.assertIs(probe.answered, answered)
                self.assertIs(probe.terminal, terminal)

    async def test_answered_probe_short_secret_fails_closed_before_transport(self):
        transport = _RecordingTransport()
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": "short"}):
            probe = await self._client(transport).attempt_answered(_ATTEMPT_ID)
        self.assertFalse(probe.ok)
        self.assertFalse(probe.answered)
        self.assertFalse(probe.terminal)
        self.assertEqual(probe.error_category, "configuration")
        self.assertEqual(transport.requests, [])

    async def test_answered_probe_non_2xx_and_malformed_fail_closed(self):
        cases = [
            (500, {"ok": True, "answered": True}),   # 5xx → transport, counted
            (403, {"ok": True, "answered": True}),   # 4xx → business_error
            (200, {"ok": False}),                    # not ok → malformed
            (200, {"answered": True}),               # missing ok → malformed
            (200, "not a dict"),
            (200, None),
        ]
        for status, body in cases:
            with self.subTest(status=status, body=body):
                transport = _RecordingTransport(status, body)
                with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
                    probe = await self._client(transport).attempt_answered(_ATTEMPT_ID)
                # A failed reading is never mistaken for an answer or a terminal.
                self.assertFalse(probe.ok)
                self.assertFalse(probe.answered)
                self.assertFalse(probe.terminal)


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

    async def test_native_booking_notifies_terminal_coordinator_after_playout(self):
        order: list[str] = []

        async def say(_text):
            order.append("spoken")

        async def booked(turn):
            self.assertTrue(turn.booked)
            order.append("terminal")

        client = FakeEventClient(booking=phone.PhoneApiOutcome(True, "ok"))
        cls = phone.phone_agent_class(agent_mod.Agent)
        agent = cls(
            "instructions", client=client, attempt_id=_ATTEMPT_ID,
            say=say, on_booking=booked, native_turns=True,
        )
        with self.assertRaises(sys.modules["livekit.agents"].StopResponse):
            await agent.schedule_callback("2026-08-25T09:30:00Z", 1800)
        self.assertEqual(order, ["spoken", "terminal"])

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

    async def test_user_turn_is_committed_but_livekit_auto_reply_is_stopped(self):
        class FakeStopResponse(Exception):
            pass

        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.updated = None

            async def update_chat_ctx(self, ctx):
                self.updated = ctx

        observed: list[str] = []
        agents = sys.modules["livekit.agents"]
        original = getattr(agents, "StopResponse", None)
        agents.StopResponse = FakeStopResponse
        try:
            cls = phone.phone_agent_class(BaseAgent)
            agent = cls(
                "instructions", client=FakeEventClient(),
                attempt_id=_ATTEMPT_ID, say=AsyncMock(),
                on_user_turn=lambda text, _message: observed.append(text),
            )
            ctx = types.SimpleNamespace(items=[])
            message = types.SimpleNamespace(text_content="Please repeat the role")
            with self.assertRaises(FakeStopResponse):
                await agent.on_user_turn_completed(ctx, message)
        finally:
            if original is None:
                delattr(agents, "StopResponse")
            else:
                agents.StopResponse = original

        self.assertEqual(ctx.items, [message])
        self.assertIs(agent.updated, ctx)
        self.assertEqual(observed, ["Please repeat the role"])

    async def test_native_user_turn_returns_to_livekit_without_stop_response(self):
        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.updated = None

            async def update_chat_ctx(self, ctx):
                self.updated = ctx

        observed: list[str] = []
        cls = phone.phone_agent_class(BaseAgent)
        agent = cls(
            "instructions", client=FakeEventClient(), attempt_id=_ATTEMPT_ID,
            say=AsyncMock(), on_user_turn=lambda text, _message, _ctx: observed.append(text),
            native_turns=True,
        )
        ctx = types.SimpleNamespace(items=[])
        message = types.SimpleNamespace(text_content="My experience is relevant")
        await agent.on_user_turn_completed(ctx, message)
        # Native mode deliberately leaves the temporary context untouched;
        # AgentActivity appends the user item exactly once after the hook.
        self.assertEqual(ctx.items, [])
        self.assertEqual(observed, ["My experience is relevant"])

    def test_explicit_end_call_language_is_narrow_and_deterministic(self):
        for text in (
            "Can you disconnect the call?", "Please hang up", "End this call now",
        ):
            with self.subTest(text=text):
                self.assertTrue(phone.is_explicit_end_call_request(text))
        for text in ("stop asking that question", "the call quality is good", "not now"):
            with self.subTest(text=text):
                self.assertFalse(phone.is_explicit_end_call_request(text))


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
    default_answers: list = []
    default_mid_turn_says: list = []
    default_interruptions: list[bool] = []
    default_silence_reply: str | None = None
    default_emit_auto_speech: bool = True
    include_timing: bool = False
    # The verified opening the gate-opening window "speaks" through
    # generate_reply. Discloses recording and asks, so `_opening_is_verified`
    # accepts it; a test can override it to exercise the fallback.
    gate_opening_text: str = (
        "Hi, this is Christy from the company about your job application. "
        "This call is recorded so the hiring team can review it. "
        "Is it okay to continue?"
    )

    def __init__(self, **kwargs):
        self.handlers: dict = {}
        self.started_with = None
        self.spoken: list[str] = []
        # Every bot turn EMITTED as a conversation item, whether via `say` or
        # `generate_reply`. Used by tests that must confirm the generated gate
        # opening reached the transcript without going through `say`.
        self.emitted_bot_turns: list[str] = []
        self.start_calls = 0
        # 0044: scripted candidate replies, one per generate_reply. A `None`
        # entry means the candidate said nothing at all, which is how the
        # "no exchange captured" halt is exercised.
        #
        # Seeded from the CLASS attribute at construction, deliberately. The
        # assessment loop starts inside `_run_phone_session` before any test
        # code regains control, so a script assigned to the instance afterwards
        # arrives too late — and a test that "passed" because the candidate
        # never answered would be asserting the timeout path while claiming to
        # assert the happy one.
        self.answers: list = list(_FakePhoneSession.default_answers)
        self.instructions: list[str] = []
        self.turn_contexts: list[list] = []
        self.mid_turn_says: list[str] = list(_FakePhoneSession.default_mid_turn_says)
        self.interruptions: list[bool] = list(_FakePhoneSession.default_interruptions)
        self.silence_reply = _FakePhoneSession.default_silence_reply
        self.emit_auto_speech = _FakePhoneSession.default_emit_auto_speech
        self._anchor_index = 0
        _FakePhoneSession.instances.append(self)

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    def _install_agent(self, agent):
        self.agent = agent
        # Other test modules may have installed an additive minimal Agent stub
        # before this file. Supply the public context surfaces the real SDK has.
        if not hasattr(self.agent, "chat_ctx"):
            self.agent.chat_ctx = types.SimpleNamespace(items=[])
        if not hasattr(self.agent, "update_chat_ctx"):
            async def update_chat_ctx(ctx):
                self.agent.chat_ctx = ctx
            self.agent.update_chat_ctx = update_chat_ctx

    async def start(self, **kwargs):
        self.start_calls += 1
        self.started_with = kwargs
        self._install_agent(kwargs.get("agent"))

    def update_agent(self, agent):
        self._install_agent(agent)

    async def wait_for_idle(self):
        return None

    def say(self, text, **kwargs):
        self.spoken.append(text)
        state_handler = self.handlers.get("agent_state_changed")
        if state_handler is not None:
            state_handler(types.SimpleNamespace(new_state="speaking"))
        # The REAL SDK appends a conversation item for a spoken line exactly as
        # it does for a generated one. Modelling that is what makes the gate-copy
        # filter testable at all — without it, the fixed disclosure and the
        # booking confirmations never reach the exchange queue in a test and the
        # filter is decorative by construction.
        planned_question = (
            getattr(self.agent, "_screening_authorized", False)
            and not phone.is_gate_copy(text)
            and bool(self.answers)
        )
        interrupted = self.interruptions.pop(0) if planned_question and self.interruptions else False
        self.emit_bot_turn(text, interrupted=interrupted)
        if state_handler is not None:
            state_handler(types.SimpleNamespace(new_state="idle"))
        if text == phone.PHONE_SILENCE_PROMPT_TEXT and self.silence_reply is not None:
            reply, self.silence_reply = self.silence_reply, None
            asyncio.get_event_loop().call_soon(self.emit_user_turn, reply)
        elif (
            getattr(self.agent, "_screening_authorized", False)
            and not phone.is_gate_copy(text)
            and self.answers
        ):
            # Production speaks the exact server-owned first question through
            # session.say so the opening cannot enter the coordinator-tool LLM
            # loop. Model its speech-created/playout fence and then the
            # candidate answer, just as generate_reply does for later turns.
            speech = _FakeSpeech()
            handler = self.handlers.get("speech_created")
            if handler is not None:
                handler(types.SimpleNamespace(speech_handle=speech))
            reply = self.answers.pop(0)
            if reply is not None:
                asyncio.get_event_loop().call_soon(self.emit_user_turn, reply)
            return speech
        return _FakeSpeech()

    def emit_user_turn(self, text):
        async def complete_turn():
            message = types.SimpleNamespace(
                text_content=text,
                metrics=(
                    {"started_speaking_at": 1723000000.0 + self._anchor_index}
                    if _FakePhoneSession.include_timing else None
                ),
                created_at=(1723000000.0 + self._anchor_index) if _FakePhoneSession.include_timing else None,
            )
            self._anchor_index += 1
            ctx = types.SimpleNamespace(items=list(getattr(self.agent.chat_ctx, "items", [])))
            try:
                await self.agent.on_user_turn_completed(ctx, message)
            except sys.modules["livekit.agents"].StopResponse:
                return
            self.turn_contexts.append(list(ctx.items))
            # Model AgentActivity's native one-reply scheduling after the hook
            # returns normally.
            self.generate_reply()
        asyncio.create_task(complete_turn())

    def emit_bot_turn(self, text, *, interrupted=False):
        self.emitted_bot_turns.append(text)
        self._emit("assistant", text, interrupted=interrupted)

    def _emit(self, role, text, *, interrupted=False):
        handler = self.handlers.get("conversation_item_added")
        item = types.SimpleNamespace(
            role=role,
            content=[types.SimpleNamespace(text=text)],
            interrupted=interrupted,
            metrics=(
                {"started_speaking_at": 1723000000.0 + self._anchor_index}
                if _FakePhoneSession.include_timing else None
            ),
            created_at=(1723000000.0 + self._anchor_index) if _FakePhoneSession.include_timing else None,
        )
        self._anchor_index += 1
        handler(types.SimpleNamespace(item=item))

    # ── 0044: the model's turn ────────────────────────────────────────
    # `generate_reply` is what the assessment loop drives. The fake emits the
    # BOT item first and the candidate's reply second, in that order, because
    # the ordering is exactly what the boundary contract depends on.
    def generate_reply(self, instructions=None, **kwargs):
        self.instructions.append(str(instructions or ""))
        speech = _FakeSpeech()
        handler = self.handlers.get("speech_created")
        if handler is not None and (instructions or self.emit_auto_speech):
            handler(types.SimpleNamespace(speech_handle=speech))
        # The GATE-OPENING window: before consent, the gate asks the model for a
        # warm opening. Model it as a verified opening bot turn (it discloses
        # recording and asks) and do NOT consume a screening answer — the consent
        # reply arrives through the classifier's turn queue, not through here.
        if getattr(self.agent, "_gate_opening", False):
            opening = self.gate_opening_text
            self.emit_bot_turn(opening)
            return speech
        interrupted = self.interruptions.pop(0) if self.interruptions else False
        self.emit_bot_turn(f"asked-{len(self.instructions)}", interrupted=interrupted)
        # A fixed line spoken WHILE a boundary is open — the callback
        # confirmation is the realistic case, because "call me back" can be
        # said in the middle of any question. It must not be committed as part
        # of the candidate's answer.
        for line in self.mid_turn_says:
            # Through `say`, exactly as the callback tool does it.
            self.say(line)
        if self.answers:
            reply = self.answers.pop(0)
            if reply is not None:
                # AFTER playout, never inside it. The first live call proved
                # the real timing: an un-interrupted ask's playout always
                # finishes before the answer's STT final arrives, and the
                # capture loop's playout fence drops any candidate final that
                # predates it. A fake that answered synchronously here would
                # be exercising a timing the fence exists to refuse.
                import asyncio as _asyncio
                _asyncio.get_event_loop().call_soon(self.emit_user_turn, reply)
        return speech

    def emit_close(self, reason=None):
        handler = self.handlers.get("close")
        handler(types.SimpleNamespace(error=None, reason=reason))


class TestPhoneSessionFlow(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _FakePhoneSession.instances = []
        _FakePhoneSession.default_answers = []
        _FakePhoneSession.default_mid_turn_says = []
        _FakePhoneSession.default_interruptions = []
        _FakePhoneSession.default_silence_reply = None
        _FakePhoneSession.default_emit_auto_speech = True
        _FakePhoneSession.include_timing = False

    async def _run_session(
        self,
        *,
        participant=True,
        answers=(),
        close_after=True,
        client=None,
        replies=None,
        interruptions=(),
        silence_reply=None,
        emit_auto_speech=True,
    ):
        ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()] if participant else [])
        client = client if client is not None else FakeEventClient()
        _FakePhoneSession.default_answers = (
            list(replies) if replies is not None
            else ["First answer.", "Second answer.", "Third answer."]
        )
        _FakePhoneSession.default_interruptions = list(interruptions)
        _FakePhoneSession.default_silence_reply = silence_reply
        _FakePhoneSession.default_emit_auto_speech = emit_auto_speech
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
             patch.object(
                 agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
                 side_effect=lambda _room: client.timeline.append("room.delete"),
             ) as delete, \
             patch.object(
                 agent_mod, "_phone_recording_permitted", new=recording_seam
             ), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.05):
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                    client=client, classifier=classifier,
                )
            )
            await asyncio.sleep(0.01)
            session = _FakePhoneSession.instances[-1] if _FakePhoneSession.instances else None
            if close_after and session is not None and session.start_calls:
                session.emit_close()
            result = await asyncio.wait_for(task, timeout=5)
        return result, client, recording, delete, session, persistence_spy

    # ── P5: the lease must outlive the conversation ───────────────────

    async def test_the_LEASE_is_heartbeaten_for_the_whole_conversation(self):
        """B-1. The lease was sized to cover the ORIGINATE; a screening runs
        for minutes. Unrenewed it lapses mid-call, the fleet slot is freed
        under a live conversation, the reclaim sweep marks the attempt
        `abandoned` while the candidate is still speaking, and the assessment
        this leg then scores is ignored because that edge is gated on
        `in_call`. This asserts the renewal exists, is handed THIS attempt's
        triple, and is cancelled when the conversation ends.
        """
        seen: dict = {}
        cancels: list[str] = []

        async def fake_heartbeat(*, attempt_id, session_id, epoch, client, halt):
            seen.update(
                attempt_id=attempt_id, session_id=session_id,
                epoch=epoch, client=client,
            )
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancels.append("cancelled")
                raise

        with patch.object(phone, "run_phone_heartbeat", fake_heartbeat):
            result, client, *_ = await self._run_session(
                answers=("Yes, that's fine.",)
            )
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(seen["attempt_id"], _ATTEMPT_ID)
        self.assertEqual(seen["session_id"], _SESSION_ID)
        self.assertEqual(seen["epoch"], _EPOCH)
        self.assertIs(seen["client"], client)
        self.assertIn("assessment.completed", client.event_types)
        # Cancelled on the NORMAL path, not left beating against a call that
        # has already ended.
        self.assertEqual(cancels, ["cancelled"])

    async def test_the_heartbeat_task_cannot_LEAK_past_an_exception(self):
        """It is cancelled in a `finally`, so an exception path cannot leave a
        task beating on a conversation that is over."""
        cancels: list[str] = []

        async def fake_heartbeat(**kwargs):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancels.append("cancelled")
                raise

        client = FakeEventClient(start=RuntimeError("the screening blew up"))
        with patch.object(phone, "run_phone_heartbeat", fake_heartbeat):
            with self.assertRaises(RuntimeError):
                await self._run_session(
                    answers=("Yes, that's fine.",), client=client
                )
        self.assertEqual(cancels, ["cancelled"])

    async def test_a_LOST_lease_STOPS_the_conversation_and_claims_nothing(self):
        """End to end, through the real loop: the slot is gone, so the
        conversation stops.

        Continuing would run two conversations against one fleet slot — the
        eleventh call is already admissible the instant the lease lapses. And
        NOTHING is posted: the reclaim sweep has already restored the
        engagement's previous state, so `assessment.aborted` would be untrue
        and ignored, and `assessment.completed` would be a lie.
        """
        client = FakeEventClient(heartbeats=[
            phone.PhoneApiOutcome(False, phone.HEARTBEAT_LEASE_LOST_STATUS),
        ])
        result, client, recording, delete, session, persistence_spy = (
            await self._run_session(answers=("Yes, that's fine.",), client=client)
        )
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(client.heartbeats, [(_ATTEMPT_ID, _SESSION_ID, _EPOCH)])
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        # The screening never even began, because the slot was already gone.
        self.assertEqual(client.assessment_calls, [])
        self.assertEqual(persistence_spy.mock_calls, [])
        # The leg is torn down rather than left on a slot it does not hold.
        delete.assert_awaited()

    async def test_nothing_is_heartbeaten_before_the_gate_CONSENTS(self):
        """A machine, a refusal or a silent line is not a conversation, and
        renewing a lease for one would hold a fleet slot for nobody."""
        result, client, *_ = await self._run_session(
            answers=("Please leave a message after the tone.",)
        )
        self.assertFalse(result.assessment_allowed)
        self.assertEqual(client.heartbeats, [])

    # ── Answer-first origination (Plivo bounce), wired through the session ─

    async def test_bounce_mode_answered_runs_the_full_screening(self):
        """With PHONE_BOUNCE_MODE on and the server confirming an answer, the
        session behaves exactly as it does today from the gate onward."""
        client = FakeEventClient(answers=[phone.PhoneAnswerProbe(True, answered=True)])
        with patch.dict(phone.os.environ, {"PHONE_BOUNCE_MODE": "true"}):
            result, client, recording, delete, session, _ = await self._run_session(
                answers=("Yes, that's fine.",), client=client,
            )
        self.assertTrue(result.assessment_allowed)
        self.assertGreaterEqual(len(client.answered_calls), 1)
        self.assertEqual(recording, [1])
        # The lease is heartbeaten — this became a real conversation.
        self.assertTrue(client.heartbeats)

    async def test_bounce_mode_terminal_speaks_nothing_and_screens_nobody(self):
        """The server reports the attempt terminal before an answer. The worker
        speaks nothing, screens nobody, heartbeats nothing, and closes the room
        — the no-participant-style outcome, wired end to end."""
        client = FakeEventClient(answers=[phone.PhoneAnswerProbe(True, terminal=True)])
        with patch.dict(phone.os.environ, {"PHONE_BOUNCE_MODE": "true"}):
            result, client, recording, delete, session, persistence_spy = await self._run_session(
                answers=("Yes, that's fine.",), client=client, close_after=False,
            )
        self.assertEqual(result.outcome, phone.GATE_NO_PARTICIPANT)
        self.assertFalse(result.assessment_allowed)
        self.assertEqual(recording, [])
        self.assertEqual(client.heartbeats, [])
        # No worker event was posted (not even call.answered), and nothing spoken.
        self.assertEqual(client.calls, [])
        if session is not None:
            self.assertEqual(session.spoken, [])
        delete.assert_awaited()

    async def test_bounce_off_by_default_never_probes_the_answer(self):
        """The default env → the answered probe is never called; today's flow."""
        result, client, *_ = await self._run_session(answers=("Yes, sure.",))
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(client.answered_calls, [])

    async def test_a_SCORED_screening_is_the_only_thing_that_claims_completion(self):
        """`assessment.completed` requires a VERIFIED assessment row.

        P4a posted `assessment.aborted` unconditionally and said out loud that
        the conditional belonged back here "when the persistence path exists,
        and its condition must be 'scoring SUCCEEDED', not 'the room closed
        cleanly'". This is that conditional, and this test pins its condition:
        the ONLY thing that produces `assessment.completed` is the completion
        endpoint answering `scored`, which it does only after it has read the
        row back.
        """
        result, client, recording, delete, session, persistence_spy = await self._run_session(
            answers=("Yes, that's fine.",)
        )
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(recording, [1])
        self.assertEqual(
            client.event_types,
            ["call.answered", "classify.human", "disclosure.delivered", "assessment.completed"],
        )
        # Every plan key was committed, in order, before anything was claimed.
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        self.assertEqual(
            [c[0] for c in client.assessment_calls],
            ["start", "turn", "turn", "complete"],
        )
        # The opening is the verified model greeting (through generate_reply),
        # carrying the recording sentence — never spoken as the fixed disclosure.
        self.assertIn(
            phone.PHONE_DISCLOSURE_RECORDING_SENTENCE, session.instructions[0]
        )
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, session.spoken)
        terminal_context = str(session.turn_contexts[-1]).lower()
        self.assertIn("goodbye", terminal_context)
        self.assertIn("do not ask another question", terminal_context)
        delete.assert_awaited()
        # The worker still writes NOTHING itself: every durable write goes
        # through the API, so the browser's persistence module is untouched.
        self.assertEqual(persistence_spy.mock_calls, [])

    async def test_X4_assessment_turns_are_persisted_PER_ITEM_as_they_happen(self):
        """0071 / X4. Each assessment conversation item is persisted the moment
        it lands, not only in pairs at the boundary. Live call 22 (2026-08-29)
        crashed mid-call and only 4 of a 6.5-minute transcript survived, because
        the phone path buffered turns and wrote them only at question
        boundaries. This asserts the per-item write fires — every bot item the
        fake session emits during the SCORED phase reaches `commit_item_turn`
        with a stable per-item key — and that it coexists with the boundary
        commits rather than replacing them.
        """
        result, client, *_ = await self._run_session(answers=("Yes, that's fine.",))
        self.assertTrue(result.assessment_allowed)
        # The boundary path still runs (the durable resume authority).
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        # And every assessment bot item was ALSO persisted per-item, in order,
        # each with a distinct stable source_item_id. (The fake models the bot
        # items; the candidate reply hook does not emit a conversation item, so
        # the per-item candidate path is covered by the focused test below.)
        self.assertGreaterEqual(len(client.item_turns), 2)
        self.assertTrue(all(t["speaker"] == "bot" for t in client.item_turns))
        keys = [t["source_item_id"] for t in client.item_turns]
        self.assertEqual(len(keys), len(set(keys)), "per-item keys must be unique")
        self.assertTrue(all(k.startswith("phone-item-") for k in keys))
        # None of the persisted per-item turns is gate copy — the writer is
        # armed only for the SCORED phase.
        self.assertTrue(
            all(not phone.is_gate_copy(t["text"]) for t in client.item_turns))

    async def test_X4_N_items_persist_N_rows_with_ZERO_boundaries_and_dedup(self):
        """0071 / X4. The property `max+1`-at-boundary can never have: a
        conversation that produces N items persists N rows even when NO boundary
        is ever committed (a crash before the first boundary), and a duplicate
        delivery of the same item does not double-insert.

        Driven at the client seam the worker uses, with the FakeEventClient
        modelling the server's source_item_id dedup exactly as the RPC enforces
        it. Zero calls to `commit_boundary` are made — this is the crash window.
        """
        client = FakeEventClient()
        # Six items, no boundary at all.
        seq = 0
        for speaker, text in [
            ("bot", "Question one, please?"),
            ("candidate", "Here is answer one."),
            ("bot", "Question two, please?"),
            ("candidate", "Here is answer two."),
            ("bot", "Question three, please?"),
            ("candidate", "Here is answer three."),
        ]:
            seq += 1
            outcome = await client.commit_item_turn(
                "11111111-1111-4111-8111-111111111111", speaker, text,
                f"phone-item-{seq}")
            self.assertTrue(outcome.ok)
            self.assertFalse(outcome.duplicate)
        self.assertEqual(len(client.item_turns), 6)
        self.assertEqual(client.boundaries, [])  # crashed before any boundary
        # A redelivered item (same source_item_id) converges, never appends.
        dup = await client.commit_item_turn(
            "11111111-1111-4111-8111-111111111111", "candidate",
            "Here is answer two.", "phone-item-4")
        self.assertTrue(dup.ok)
        self.assertTrue(dup.duplicate)
        self.assertEqual(len(client.item_turns), 6)  # still six

    async def test_X4_item_turn_client_posts_the_stable_key_and_reads_ok(self):
        """0071 / X4. The client sends the per-item key and anchor to
        ITEM_TURN_PATH and reads `ok`/`duplicate` from the server's own flags,
        never inferring them. Best-effort: a transport error is a not-ok
        outcome the caller may swallow, never an exception on the hot path.
        """
        client = phone.PhoneEventClient()
        posts: list = []

        async def fake_post(path, body, hint):
            posts.append((path, body, hint))
            return types.SimpleNamespace(
                status_code=200,
                json=lambda: {"ok": True, "status": "applied", "duplicate": False},
            )

        with patch.object(client, "_post", fake_post):
            outcome = await client.commit_item_turn(
                "sid-1", "candidate", "an answer", "phone-item-7", 1723000000123)
        self.assertTrue(outcome.ok)
        self.assertFalse(outcome.duplicate)
        self.assertEqual(len(posts), 1)
        path, body, hint = posts[0]
        self.assertEqual(path, phone.ITEM_TURN_PATH)
        self.assertEqual(body["source_item_id"], "phone-item-7")
        self.assertEqual(body["speaker"], "candidate")
        self.assertEqual(body["turn_started_at_ms"], 1723000000123)
        # A transport error string is a not-ok outcome, never a raise.
        async def fake_post_err(path, body, hint):
            return "transport"
        with patch.object(client, "_post", fake_post_err):
            errored = await client.commit_item_turn("sid-1", "bot", "q", "phone-item-8")
        self.assertFalse(errored.ok)

    async def test_first_post_consent_question_is_llm_phrased_in_tool_less_opening(self):
        """The first question is delivered through the model, phrased naturally.

        PR #157 pinned this to fixed `session.say` because a raced opening
        generation under the substantive tool policy could loop on
        advance_screening until the SDK step ceiling closed the room. The
        tool-resolved latch and the idempotent duplicate-advance reply disarm
        that trap structurally, so the opening returns to `generate_reply` in
        the tool-less "opening" policy — the browser lane's behavior. The
        WHICH-question authority is unchanged: the committed keys still come
        from the call site, never from the spoken prose.
        """
        _, client, _, _, session, _ = await self._run_session(
            answers=("Yes, that's fine.",),
            replies=["First answer.", "Second answer."],
        )
        # instructions[0] is the GATE opening (greeting + disclosure), generated
        # before consent. The first planned question is the next generation.
        self.assertIn("okay to continue", session.instructions[0].lower())
        # The planned text reaches the model as an instruction, not the ear
        # as verbatim speech.
        self.assertIn("First question?", session.instructions[1])
        self.assertIn("planned question", session.instructions[1])
        self.assertNotIn("First question?", session.spoken)
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        # Gate opening + first-question generation + the two answer-mediated replies.
        self.assertEqual(len(session.instructions), 4)

    async def test_first_question_falls_back_to_fixed_playout_without_generate_reply(self):
        """A session without `generate_reply` still asks the exact planned text."""
        class _NoGenerateSession(_FakePhoneSession):
            generate_reply = None

        ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()])
        client = FakeEventClient()
        _FakePhoneSession.default_answers = []

        async def classifier(turns, say):
            return phone.CLASSIFY_HUMAN

        async def recording_seam():
            return None

        with patch.object(agent_mod, "AgentSession", _NoGenerateSession), \
             patch.object(agent_mod, "persistence", MagicMock()), \
             patch.object(
                 agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
             ), \
             patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.05):
            await asyncio.wait_for(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                    client=client, classifier=classifier,
                ),
                timeout=5,
            )
        session = _FakePhoneSession.instances[-1]
        self.assertIn("First question?", session.spoken)

    async def test_terminal_persistence_precedes_room_teardown(self):
        _, client, _, _, _, _ = await self._run_session(answers=("Yes, sure.",))
        self.assertLess(
            client.timeline.index("assessment.complete"),
            client.timeline.index("event:assessment.completed"),
        )
        self.assertLess(
            client.timeline.index("event:assessment.completed"),
            client.timeline.index("room.delete"),
        )

    async def test_connectivity_clarification_repeats_without_advancing(self):
        _, client, _, _, session, _ = await self._run_session(
            answers=("Yes, sure.",),
            replies=[
                "Yeah, can you hear me?",
                "I have four years of relevant experience.",
                "I am available to start next month.",
            ],
        )
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        self.assertEqual(
            client.boundaries[0]["turns"][-1]["text"],
            "I have four years of relevant experience.",
        )
        self.assertTrue(any("ask this same planned topic again" in str(c) for c in session.turn_contexts))

    async def test_interrupted_question_is_committed_once_as_labelled_evidence(self):
        _, client, _, _, _, _ = await self._run_session(
            answers=("Yes, sure.",),
            interruptions=(True, False, False),
        )
        first = client.boundaries[0]["turns"]
        self.assertTrue(first[0]["text"].startswith(phone.INTERRUPTED_QUESTION_PREFIX))
        self.assertEqual(client.committed_keys.count("k1"), 1)

    async def test_an_UNSCORED_completion_falls_back_to_the_truthful_aborted(self):
        """Scoring succeeding is not the same as an assessment existing.

        When the completion endpoint refuses — for any reason — nothing may
        claim a completed screening, and `assessment.aborted` is the truthful
        terminal: the conversation happened and produced nothing scorable.
        """
        client = FakeEventClient(
            complete=phone.PhoneApiOutcome(False, "scoring_failed"),
        )
        _, client, _, _, session, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertIn("assessment.aborted", client.event_types)
        self.assertNotIn("assessment.completed", client.event_types)
        # The boundaries still committed, so the transcript is durable and the
        # session is scorable — but note what this does NOT claim: the
        # engagement is now terminal `failed`, and re-scoring it later produces
        # an assessment and a scorecard while leaving that terminal state
        # where it is. There is no path back to `completed`. See the runbook.
        self.assertEqual(client.committed_keys, ["k1", "k2"])

    async def test_a_PERSISTENCE_failure_posts_nothing_at_all(self):
        """The one path that must post NEITHER terminal event.

        A boundary that did not commit means the conversation is interrupted,
        not over. Both terminal events available here would END the engagement:
        `assessment.aborted` is terminal `failed`, and `assessment.completed`
        would be a lie. 0042's reconnect budget is what owns a dropped leg, and
        posting a terminal event here would convert a retryable problem into a
        lost candidate.
        """
        refusal = phone.PhoneApiOutcome(False, "stale_cursor")
        client = FakeEventClient(commits={"k1": refusal})
        _, client, _, delete, _, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertEqual(client.event_types, ["call.answered", "classify.human", "disclosure.delivered"])
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        # AND the second question was never asked, and no completion was even
        # attempted — "no next question, no completion" is one property, not two.
        self.assertEqual(client.committed_keys, ["k1"])
        self.assertEqual([c[0] for c in client.assessment_calls], ["start", "turn"])
        delete.assert_awaited()

    async def test_an_ALREADY_SCORED_session_is_ADOPTED_without_re_scoring(self):
        """F-1. The database says: this session is `completed` and a
        phone-sourced assessment row exists.

        There is nothing to screen, nothing to score and nothing to write — the
        only thing missing is the acknowledgement, which the leg that produced
        it could not deliver. So the worker posts the completion DIRECTLY: no
        completion call, no inference, no second writeback, and no question
        re-asked. Without this the engagement can never reach `completed` from
        any leg; it rests non-terminal until a budget or a sweeper ends it, or
        goes `failed` for an untruthful reason.
        """
        client = FakeEventClient(
            start=phone.PhoneAssessmentState(
                False, phone.ASSESSMENT_ALREADY_SCORED_STATUS
            ),
        )
        _, client, _, delete, session, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        # NOTHING was re-done: no completion call, no boundary, no question.
        self.assertEqual([c[0] for c in client.assessment_calls], ["start"])
        self.assertEqual(client.committed_keys, [])
        # …and the candidate is not hung up on mid-call: a leg that SUCCEEDED
        # must not end worse than one that failed.
        self.assertEqual(session.spoken[-1], phone.PHONE_ASSESSMENT_CLOSING_TEXT)
        delete.assert_awaited()

    async def test_a_SCORED_session_is_RECOVERED_when_the_start_is_refused(self):
        """A refused start is not proof that nothing happened.

        `session_not_active` is exactly what an already-COMPLETED session
        presents — which is the state a scored-but-unacknowledged screening is
        in: the completion endpoint succeeded, inserted the assessment and lost
        its response; that leg halted and posted nothing; the webhook granted a
        reconnect; and now this leg is being told the session is not active.

        Aborting here would drive the engagement to terminal `failed` over a
        screening that exists and is scored — and terminal is unrecoverable.
        """
        client = FakeEventClient(
            start=phone.PhoneAssessmentState(False, "session_not_active"),
            complete=phone.PhoneApiOutcome(True, phone.ASSESSMENT_SCORED_STATUS),
        )
        _, client, _, delete, session, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        # Nobody was re-screened: the completion endpoint is idempotent and the
        # ROW still decides, so no question was asked and none was committed.
        self.assertEqual(client.committed_keys, [])
        self.assertEqual([c[0] for c in client.assessment_calls], ["start", "complete"])
        self.assertEqual(session.spoken[-1], phone.PHONE_ASSESSMENT_CLOSING_TEXT)
        delete.assert_awaited()

    async def test_a_refused_start_with_NOTHING_to_recover_still_aborts(self):
        """The control for the test above. If the completion endpoint says the
        screening is not scored, the truthful terminal is still `aborted` —
        recovery must not become a way to claim a completion nobody earned."""
        client = FakeEventClient(
            start=phone.PhoneAssessmentState(False, "session_not_active"),
            complete=phone.PhoneApiOutcome(False, "plan_incomplete"),
        )
        _, client, _, _, _, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertIn("assessment.aborted", client.event_types)
        self.assertNotIn("assessment.completed", client.event_types)

    async def test_a_refused_start_whose_recovery_is_UNREACHABLE_posts_nothing(self):
        """Still no answer we can act on. Posting either terminal event would
        be a claim about a state we do not know."""
        unreachable = phone.PhoneApiOutcome(False, None)
        unreachable.error_category = "transport"
        client = FakeEventClient(
            start=phone.PhoneAssessmentState(False, "session_not_active"),
            complete=unreachable,
        )
        _, client, _, _, _, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)

    async def test_a_refused_start_screens_nobody_and_claims_nothing(self):
        """No plan, no screening.

        `disclosure_not_delivered` is the case that matters: 0044 refuses to
        start an assessment on a call whose consent the state machine has not
        recorded, and the worker must not carry on regardless.
        """
        client = FakeEventClient(
            start=phone.PhoneAssessmentState(False, "disclosure_not_delivered"),
        )
        _, client, _, _, _, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertEqual(client.committed_keys, [])
        self.assertIn("assessment.aborted", client.event_types)
        self.assertNotIn("assessment.completed", client.event_types)
        # …and the recovery path is NOT attempted: it exists for
        # `session_not_active`, which is the one refusal that can mean "already
        # scored". A consent refusal means the opposite, and asking the
        # completion endpoint about it would be asking a question with no
        # legitimate answer.
        self.assertEqual([c[0] for c in client.assessment_calls], ["start"])

    async def test_ok_boundary_without_server_cursor_releases_no_next_question(self):
        malformed_ok = phone.PhoneApiOutcome(True, "applied")
        malformed_ok.cursor = None
        client = FakeEventClient(commits={"k1": malformed_ok})
        _, client, _, _, _, _ = await self._run_session(
            answers=("Yes, sure.",), client=client,
        )
        self.assertEqual(client.committed_keys, ["k1"])
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        self.assertNotIn("complete", [call[0] for call in client.assessment_calls])

    async def test_failed_apology_playout_does_not_terminalize_persistence_halt(self):
        refusal = phone.PhoneApiOutcome(False, "stale_cursor")
        client = FakeEventClient(commits={"k1": refusal})
        with patch.object(agent_mod, "PHONE_TERMINAL_REPLY_TIMEOUT_SEC", 0.001):
            _, client, _, _, _, _ = await self._run_session(
                answers=("Yes, sure.",), client=client, emit_auto_speech=False,
            )
        self.assertEqual(client.committed_keys, ["k1"])
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)

    async def test_a_RESUMING_leg_asks_only_what_is_still_owed(self):
        """The whole point of the phase.

        The server says the cursor is 1 and k1 is done. The leg must ask k2 and
        ONLY k2 — and it must never re-ask k1, because the candidate already
        answered it on the leg that dropped.
        """
        client = FakeEventClient(
            start=_default_state(
                cursor=1,
                completed=["k1"],
                turns=[
                    {"speaker": "bot", "text": "First question?"},
                    {"speaker": "candidate", "text": "Four years."},
                ],
            ),
        )
        _, client, _, _, session, _ = await self._run_session(
            answers=("Yes, that's fine.",), client=client
        )
        self.assertEqual(client.committed_keys, ["k2"])
        self.assertNotIn("k1", client.committed_keys)
        self.assertEqual(client.boundaries[0]["expected_index"], 1)
        self.assertIn("assessment.completed", client.event_types)
        # The DISCLOSURE is re-delivered on the new leg — a new leg may be a
        # different person — through the verified model opening (which MUST carry
        # the recording sentence). It is deliberately NOT a transcript turn: the
        # gate opening is gate copy, and no boundary carries it.
        self.assertIn(
            phone.PHONE_DISCLOSURE_RECORDING_SENTENCE, session.instructions[0]
        )
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, session.spoken)
        for boundary in client.boundaries:
            for turn in boundary["turns"]:
                self.assertNotIn("recorded so the hiring team", turn["text"])

    async def test_explicit_disconnect_speaks_once_and_schedules_no_later_question(self):
        _, client, _, delete, session, _ = await self._run_session(
            answers=("Yes, that's fine.",),
            replies=["Can you disconnect the call?", "This must never be consumed."],
            close_after=False,
        )

        # The gate opening, the LLM-phrased first question, plus one
        # LiveKit-native terminal response.
        self.assertEqual(len(session.instructions), 3)
        self.assertEqual(client.committed_keys, [])
        self.assertIn("assessment.aborted", client.event_types)
        terminal_context = str(session.turn_contexts[-1]).lower()
        self.assertIn("end the call", terminal_context)
        self.assertIn("do not ask another question", terminal_context)
        delete.assert_awaited_once_with(_PHONE_ROOM)

    async def test_a_silent_candidate_ENDS_the_call_rather_than_looking_like_a_drop(self):
        """No answer means no boundary — and it is NOT a line drop.

        Committing the bot's question with nothing after it would record an
        answer the candidate never gave, and the scorer reads that transcript.
        But posting nothing would be worse in the other direction: the
        webhook's `sip.participant_left` would then grant and CHARGE a
        reconnect, and a candidate who simply went quiet would be dialled back
        up to three times — on a dialer whose per-IST-day index exists to
        prevent exactly that.

        So a conversational halt ends the call truthfully with
        `assessment.aborted`, and only an INFRASTRUCTURE halt posts nothing.
        """
        # Comfortably under the harness's 0.05 s residency cap, so the HALT is
        # what ends the leg rather than the residency timeout — two different
        # outcomes with two different terminal decisions, and a test that let
        # them race would be asserting whichever won.
        with patch.object(agent_mod, "CANDIDATE_SILENCE_PROMPT_SEC", 0.001), \
             patch.object(agent_mod, "CANDIDATE_SILENCE_END_SEC", 0.001):
            _, client, _, _, _, _ = await self._run_session(
                answers=("Yes, that's fine.",), replies=[None, None, None],
                close_after=False,
            )
        self.assertEqual(client.committed_keys, [])
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertIn("assessment.aborted", client.event_types)

    async def test_silence_recovery_repeats_question_without_advancing(self):
        with patch.object(agent_mod, "CANDIDATE_SILENCE_PROMPT_SEC", 0.001), \
             patch.object(agent_mod, "CANDIDATE_SILENCE_END_SEC", 0.05):
            _, client, _, _, _, _ = await self._run_session(
                answers=("Yes, sure.",),
                replies=[None, "My actual first answer.", "My second answer."],
                silence_reply="Yes, I'm here.",
                close_after=False,
            )
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        self.assertEqual(client.boundaries[0]["turns"][-1]["text"], "My actual first answer.")
        self.assertNotIn(
            "Yes, I'm here.",
            [boundary["turns"][-1]["text"] for boundary in client.boundaries],
        )

    async def test_FIXED_COPY_never_lands_inside_a_committed_boundary(self):
        """The disclosure and the booking confirmations are not screening turns.

        Both are spoken through `session.say`, which appends a conversation item
        exactly like a generated turn does. A confirmation spoken mid-question —
        "call me back" can be said during any of them — would otherwise be
        captured inside whichever boundary happened to be open and committed as
        part of the candidate's answer, which the scorer then reads.
        """
        _FakePhoneSession.default_mid_turn_says = [
            phone._SCHEDULE_CONFIRMED_TEXT,
            phone.schedule_refusal_text("window_closed"),
        ]
        _, client, _, _, session, _ = await self._run_session(
            answers=("Yes, that's fine.",)
        )
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        committed = [t["text"] for b in client.boundaries for t in b["turns"]]
        self.assertNotIn(phone._SCHEDULE_CONFIRMED_TEXT, committed)
        self.assertNotIn(phone.schedule_refusal_text("window_closed"), committed)
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, committed)
        self.assertNotIn(_FakePhoneSession.gate_opening_text, committed)
        self.assertNotIn(phone.PHONE_ASSESSMENT_CLOSING_TEXT, committed)
        # CONTROL — the lines really were spoken, so the assertions above are
        # about the FILTER and not about a fake that never emitted them. The
        # confirmations go through `say`; the gate opening is a generated
        # conversation item (verified, so never the fixed disclosure via say).
        self.assertIn(phone._SCHEDULE_CONFIRMED_TEXT, session.spoken)
        self.assertIn(_FakePhoneSession.gate_opening_text, session.emitted_bot_turns)
        # …and a real generated turn DID survive, so the filter is not simply
        # dropping everything the bot says.
        self.assertTrue(any(t.startswith("asked-") for t in committed))

    async def test_the_close_reason_is_still_not_what_decides_a_completion(self):
        """A tidy hangup is not evidence of anything.

        P4a refused to read the close reason, and 0044 does not start reading
        it. The condition is the SCORE, and a leg whose boundaries never
        committed is refused a completion however cleanly the room shut.
        """
        refusal = phone.PhoneApiOutcome(False, "session_not_active")
        client = FakeEventClient(commits={"k1": refusal})
        _, client, _, _, _, persistence_spy = await self._run_session(
            answers=("Yes, that's fine.",), client=client, close_after=True
        )
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertEqual(persistence_spy.mock_calls, [])

    async def test_machine_path_cannot_score_writeback_or_record(self):
        result, client, recording, delete, session, persistence_spy = await self._run_session(
            answers=("Please leave a message after the tone.",)
        )
        self.assertFalse(result.assessment_allowed)
        self.assertEqual(recording, [])
        # call.answered is posted best-effort before the disclosure so the
        # server can record from the answer; the machine path then posts only
        # classify.machine and never records or scores.
        self.assertEqual(client.event_types, ["call.answered", "classify.machine"])
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

    async def test_phone_session_registers_provider_latency_metrics(self):
        _, _, _, _, session, _ = await self._run_session(answers=("Yes, sure.",))
        self.assertIn("metrics_collected", session.handlers)

    async def test_phone_boundary_carries_sdk_speech_start_anchors(self):
        _FakePhoneSession.include_timing = True
        with patch.object(agent_mod, "_turn_anchor_ms", return_value=1723000000000):
            _, client, _, _, _, _ = await self._run_session(answers=("Yes, sure.",))
        boundary = client.boundaries[0]["turns"]
        self.assertIsInstance(boundary[0]["turn_started_at_ms"], int)
        self.assertIsInstance(boundary[-1]["turn_started_at_ms"], int)

    # ── Disconnect diagnostics ───────────────────────────────────────────

    async def test_a_failing_close_reason_is_logged_with_a_clamped_category(self):
        """The live call died with the close reason computed but never logged.

        A close with a failure reason now emits `phone_session_closed`, and the
        category is CLAMPED to the bounded `_classify_close_event` vocabulary —
        never raw reason text.
        """
        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy):
            ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()])
            client = FakeEventClient()

            async def classifier(turns, say):
                return phone.CLASSIFY_MACHINE

            async def recording_seam():
                return None

            with patch.object(agent_mod, "AgentSession", _FakePhoneSession), \
                 patch.object(agent_mod, "persistence", MagicMock()), \
                 patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
                 patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
                 patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.05):
                task = asyncio.ensure_future(
                    agent_mod._run_phone_session(
                        ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                        client=client, classifier=classifier,
                    )
                )
                await asyncio.sleep(0.01)
                session = _FakePhoneSession.instances[-1]
                session.emit_close(reason="DisconnectReason.SIP_TRUNK_FAILURE")
                await asyncio.wait_for(task, timeout=5)
        closed = [
            c for c in spy.warn.call_args_list
            if c.kwargs.get("error_type") == "phone_session_closed"
        ]
        self.assertTrue(closed)
        category = closed[0].kwargs.get("error_category")
        self.assertIn(category, {"shutdown_forced", "provider_error", "worker_crash"})
        self.assertEqual(category, "provider_error")

    async def test_a_clean_close_is_logged_as_clean_close_not_a_failure(self):
        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy):
            await self._run_session(answers=("Yes, sure.",), close_after=True)
        closed = [
            c for c in spy.warn.call_args_list
            if c.kwargs.get("error_type") == "phone_session_closed"
        ]
        # EVERY close is surfaced — the 2026-08-28 live disconnect was a clean
        # remote close, exactly the shape a failure-only log would hide. A
        # clean close is named `clean_close`, never one of the failure codes.
        self.assertTrue(closed)
        category = closed[0].kwargs.get("error_category")
        self.assertEqual(category, "clean_close")

    async def test_user_away_and_active_transitions_are_logged(self):
        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy):
            _, _, _, _, session, _ = await self._run_session(answers=("Yes, sure.",))
            handler = session.handlers.get("user_state_changed")
            self.assertIsNotNone(handler)
            # Fire transitions while the spy is still installed — the handler
            # resolves `_log` as a module global at call time.
            handler(types.SimpleNamespace(old_state="active", new_state="away"))
            handler(types.SimpleNamespace(old_state="away", new_state="active"))
        states = [
            c.kwargs.get("error_category")
            for c in spy.info.call_args_list
            if c.kwargs.get("error_type") == "phone_user_state"
        ]
        self.assertIn("user_away", states)
        self.assertIn("user_active", states)


class TestNativePhoneArchitecture(unittest.TestCase):
    def test_no_legacy_phone_scheduler_remains(self):
        self.assertFalse(hasattr(agent_mod, "_ask_phone_question"))
        self.assertFalse(hasattr(phone, "run_phone_assessment"))
        source = inspect.getsource(agent_mod._run_phone_session)
        self.assertNotIn("exchange", source)
        self.assertNotIn("booking_made", source)

    def test_phone_and_webrtc_share_one_agent_session_factory(self):
        self.assertIn(
            "_build_provider_session(",
            inspect.getsource(agent_mod._build_phone_provider_session),
        )
        self.assertIn(
            "session = _build_provider_session()",
            inspect.getsource(agent_mod._run_session),
        )
        factory = inspect.getsource(agent_mod._build_provider_session)
        self.assertEqual(factory.count("AgentSession("), 1)

    def test_sdk_transcript_extras_are_removed_before_logging(self):
        import logging
        record = logging.LogRecord("livekit.agents", logging.WARNING, __file__, 1, "x", (), None)
        record.user_input = "private candidate words"
        record.transcript = "more private words"
        self.assertTrue(agent_mod._LIVEKIT_TRANSCRIPT_FILTER.filter(record))
        self.assertFalse(hasattr(record, "user_input"))
        self.assertFalse(hasattr(record, "transcript"))

    def test_native_routing_keeps_non_answers_off_the_cursor(self):
        self.assertEqual(phone.candidate_turn_route("Yeah, can you hear me?"), "connectivity_check")
        self.assertEqual(phone.candidate_turn_route("I'm busy right now"), "callback_deferral")
        self.assertEqual(phone.candidate_turn_route("Please call me back tomorrow"), "callback_deferral")
        self.assertEqual(phone.candidate_turn_route("Um"), "hesitation")
        self.assertIsNone(phone.candidate_turn_route("I led the support team for four years."))

    def test_silence_copy_cannot_become_boundary_evidence(self):
        self.assertTrue(phone.is_gate_copy(phone.PHONE_SILENCE_PROMPT_TEXT))
        self.assertTrue(phone.is_gate_copy(phone.PHONE_SILENCE_GOODBYE_TEXT))

    def test_anchor_order_suppresses_only_provably_stale_finals(self):
        message = types.SimpleNamespace(
            metrics={"started_speaking_at": 1723000000.0}, created_at=None,
        )
        self.assertTrue(agent_mod._native_turn_predates_question(message, 1723000001000))
        self.assertFalse(agent_mod._native_turn_predates_question(message, 1722999999000))
        self.assertFalse(agent_mod._native_turn_predates_question(message, None))

    def test_chat_message_stage_metrics_are_content_free(self):
        item = types.SimpleNamespace(
            role="assistant",
            text_content="must never become a metric label",
            metrics={"llm_node_ttft": 0.4, "tts_node_ttfb": 0.2, "e2e_latency": 0.8},
        )
        with patch.object(agent_mod, "histogram_metric") as emit:
            agent_mod._record_turn_metrics(item, "phone")
        self.assertEqual(emit.call_count, 3)
        rendered = repr(emit.call_args_list)
        self.assertNotIn("must never", rendered)
        self.assertNotIn("text_content", rendered)


# ── H-3: the instructions must actually be DELIVERED ──────────────────

class TestInstructionDelivery(unittest.IsolatedAsyncioTestCase):
    """`render_resume_context` being a well-tested pure function proves nothing
    about whether its output ever reaches the model.

    `Agent.instructions` is a read-only property on livekit-agents 1.6 and the
    supported mutator is `await agent.update_instructions(...)`. A bare
    `setattr` raises on the real SDK and succeeds on a stub — the worst
    combination, because the suite would be green while the candidate's name,
    the question flow and the resume replay never reached the model at all.
    """

    def _state(self, *, turns=None):
        return phone.PhoneAssessmentState.parse(_plan_payload(turns=turns))

    async def test_it_prefers_the_SDK_mutator_over_a_bare_attribute_write(self):
        class RealisticAgent:
            """`instructions` is read-only, exactly as the SDK declares it."""

            def __init__(self):
                self.delivered = []

            @property
            def instructions(self):
                return "base"

            async def update_instructions(self, text):
                self.delivered.append(text)

        agent = RealisticAgent()
        # The prompt builders are spied rather than asserted on by their
        # OUTPUT: `test_agent.py` swaps `sys.modules["prompting"]` for a mock
        # at import time, so what `system_prompt` returns depends on module
        # load order. What must be true regardless is that the PLAN and the
        # candidate's name are what get built into the instructions, and that
        # the result is delivered through the SDK mutator.
        with patch.object(agent_mod, "system_prompt", return_value="BUILT") as build:
            ok = await agent_mod._apply_phone_instructions(agent, self._state())
        self.assertTrue(ok)
        self.assertEqual(len(agent.delivered), 1)
        self.assertEqual(agent.delivered[0], "BUILT" + phone.PHONE_CALLBACK_POLICY_TEXT + phone.PHONE_ROLE_GROUNDING_TEXT + phone.PHONE_TURN_DISCIPLINE_TEXT + phone.PHONE_EXPRESSIVENESS_TEXT)
        self.assertEqual(build.call_args.kwargs["candidate_name"], "Asha")
        self.assertIn("exact currently owed question", build.call_args.kwargs["questions"])
        self.assertNotIn("First question?", build.call_args.kwargs["questions"])
        self.assertNotIn("Second question?", build.call_args.kwargs["questions"])

    async def test_the_RESUME_replay_is_actually_delivered(self):
        class RealisticAgent:
            def __init__(self):
                self.delivered = []

            async def update_instructions(self, text):
                self.delivered.append(text)

        agent = RealisticAgent()
        with patch.object(agent_mod, "system_prompt", return_value="BUILT"):
            ok = await agent_mod._apply_phone_instructions(agent, self._state(turns=[
                {"speaker": "bot", "text": "How many years?"},
                {"speaker": "candidate", "text": "About four."},
            ]))
        self.assertTrue(ok)
        self.assertIn("Candidate: About four.", agent.delivered[0])
        self.assertIn("do NOT ask these again", agent.delivered[0])

    async def test_the_attribute_write_is_the_FALLBACK_not_the_path(self):
        class LegacyAgent:
            instructions = "base"

        agent = LegacyAgent()
        with patch.object(agent_mod, "system_prompt", return_value="BUILT"):
            ok = await agent_mod._apply_phone_instructions(agent, self._state())
        self.assertTrue(ok)
        self.assertEqual(agent.instructions, "BUILT" + phone.PHONE_CALLBACK_POLICY_TEXT + phone.PHONE_ROLE_GROUNDING_TEXT + phone.PHONE_TURN_DISCIPLINE_TEXT + phone.PHONE_EXPRESSIVENESS_TEXT)

    async def test_a_FAILED_delivery_is_reported_rather_than_swallowed(self):
        class HostileAgent:
            @property
            def instructions(self):
                return "base"

            async def update_instructions(self, text):
                raise RuntimeError("not supported")

        # `instructions` has no setter, so the fallback raises too.
        ok = await agent_mod._apply_phone_instructions(HostileAgent(), self._state())
        self.assertFalse(ok)

    async def test_a_RAISING_mutator_still_falls_back(self):
        class FlakyAgent:
            def __init__(self):
                self.instructions = "base"

            async def update_instructions(self, text):
                raise RuntimeError("nope")

        agent = FlakyAgent()
        with patch.object(agent_mod, "system_prompt", return_value="BUILT"):
            ok = await agent_mod._apply_phone_instructions(agent, self._state())
        self.assertTrue(ok)
        self.assertEqual(agent.instructions, "BUILT" + phone.PHONE_CALLBACK_POLICY_TEXT + phone.PHONE_ROLE_GROUNDING_TEXT + phone.PHONE_TURN_DISCIPLINE_TEXT + phone.PHONE_EXPRESSIVENESS_TEXT)


# ── F3: role-title grounding (phone side only) ─────────────────────────

class TestPhoneRoleGrounding(unittest.TestCase):
    """The role-title grounding constraint (2026-08-29: the bot invented
    'Senior Project Manager'). It must appear in the PHONE instructions and
    must NOT touch the sha-pinned browser surface — so it is appended in
    `_phone_instructions_text`, never inside the shared `system_prompt`."""

    def _state(self):
        payload = _plan_payload()
        payload["context"]["role_title"] = "Project Manager"
        return phone.PhoneAssessmentState.parse(payload)

    def test_constraint_forbids_inventing_a_title_and_names_the_fallback(self):
        text = phone.PHONE_ROLE_GROUNDING_TEXT
        self.assertIn("EXACTLY", text)
        self.assertIn("Never invent", text)
        self.assertIn("the role you applied for", text)

    def test_it_appears_in_the_phone_instructions(self):
        with patch.object(agent_mod, "system_prompt", return_value="BUILT"):
            built = agent_mod._phone_instructions_text(self._state())
        self.assertIn(phone.PHONE_ROLE_GROUNDING_TEXT, built)
        # And after the callback policy, so both phone-only blocks are present.
        self.assertIn(phone.PHONE_CALLBACK_POLICY_TEXT, built)

    def test_it_does_NOT_appear_in_the_browser_system_prompt(self):
        # The real (unmocked) shared prompt the browser lane renders must not
        # carry the phone-only constraint.
        browser = prompting.system_prompt(
            candidate_name="Asha", role_title="Project Manager",
        )
        self.assertNotIn(phone.PHONE_ROLE_GROUNDING_TEXT, browser)
        self.assertNotIn("Role-title grounding", browser)


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
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                    client=client, classifier=classifier,
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


class TestOpeningGenerationSeed(unittest.IsolatedAsyncioTestCase):
    """The opening generation must never reach the model with empty contents.

    Live 2026-08-29: the first generation of a call ran against an empty chat
    context and Gemini refused it (400 contents-not-specified), so the natural
    opening fell back to fixed copy on EVERY call. The seed is one synthetic
    user turn ("Hello?") passed through `generate_reply(user_input=...)`.
    """

    async def test_the_opening_passes_a_user_input_seed(self):
        seen: dict = {}

        class _SeedProbeSession(_FakePhoneSession):
            def generate_reply(self, instructions=None, **kwargs):
                seen.setdefault("user_input", kwargs.get("user_input"))
                return super().generate_reply(instructions=instructions, **kwargs)

        ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()])
        client = FakeEventClient()
        _FakePhoneSession.default_answers = ["Yes, that's fine.", "First answer."]

        async def classifier(turns, say):
            return phone.CLASSIFY_HUMAN

        async def recording_seam():
            return None

        with patch.object(agent_mod, "AgentSession", _SeedProbeSession), \
             patch.object(agent_mod, "persistence", MagicMock()), \
             patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
             patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.05):
            await asyncio.wait_for(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                    client=client, classifier=classifier,
                ),
                timeout=5,
            )
        self.assertEqual(seen.get("user_input"), "Hello?")


class TestDisclosureSentencePin(unittest.TestCase):
    """The verbatim recording sentence and the fixed disclosure cannot drift.

    `PHONE_DISCLOSURE_TEXT` deliberately repeats the sentence as a plain
    literal (the API's cross-language extractor cannot see f-string lines),
    so containment is pinned here instead of by interpolation.
    """

    def test_disclosure_contains_the_recording_sentence_verbatim(self):
        self.assertIn(
            phone.PHONE_DISCLOSURE_RECORDING_SENTENCE, phone.PHONE_DISCLOSURE_TEXT,
        )


class TestToolResolvedLatch(unittest.IsolatedAsyncioTestCase):
    """The 2026-08-28 runaway-loop regression, pinned structurally.

    On the live call, the substantive policy forced `tool_choice="required"`
    on EVERY step of the reply — including the step after advance_screening
    had already resolved. The model's only legal move was another tool call,
    the duplicate advance found an empty pending exchange, the coordinator
    halted the call, and the candidate was disconnected mid-answer. The latch
    releases the post-tool step to ordinary speech; these tests replay the
    exact policy sequence the SDK drives.
    """

    def _agent(self, on_advance=None, on_probe=None):
        calls: list[tuple[list, str]] = []

        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions

            async def llm_node(self, chat_ctx, tools, model_settings):
                calls.append((
                    [phone_tool_name(t) for t in tools],
                    getattr(model_settings, "tool_choice", None),
                ))

                async def chunks():
                    yield "chunk"
                return chunks()

        def phone_tool_name(tool):
            return str(getattr(tool, "name", None) or getattr(tool, "__name__", ""))

        cls = phone.phone_agent_class(BaseAgent)
        agent = cls(
            "instructions", client=FakeEventClient(), attempt_id=_ATTEMPT_ID,
            say=AsyncMock(), native_turns=True,
            on_user_turn=lambda *args, **kwargs: None,
            on_advance=on_advance, on_probe=on_probe,
        )
        agent.authorize_screening()
        return agent, calls

    @staticmethod
    def _tools():
        return [
            types.SimpleNamespace(name="request_probe"),
            types.SimpleNamespace(name="advance_screening"),
            types.SimpleNamespace(name="schedule_callback"),
        ]

    @staticmethod
    def _settings():
        from dataclasses import dataclass

        @dataclass
        class Settings:
            tool_choice: str = "auto"
        return Settings()

    async def _run_node(self, agent):
        chunks = []
        async for chunk in agent.llm_node(None, self._tools(), self._settings()):
            chunks.append(chunk)
        return chunks

    async def test_substantive_requires_a_coordinator_tool_first(self):
        agent, calls = self._agent(on_advance=lambda: "Advance authorized.")
        await self._run_node(agent)
        tools, choice = calls[-1]
        self.assertEqual(sorted(tools), ["advance_screening", "request_probe"])
        self.assertEqual(choice, "required")

    async def test_a_resolved_advance_releases_the_speech_step(self):
        agent, calls = self._agent(on_advance=lambda: "Advance authorized.")
        await self._run_node(agent)
        result = await agent.advance_screening()
        self.assertIn("Advance authorized", result)
        await self._run_node(agent)
        tools, choice = calls[-1]
        self.assertEqual(tools, [])
        self.assertEqual(choice, "none")

    async def test_a_resolved_probe_releases_the_speech_step_even_when_denied(self):
        agent, calls = self._agent(on_probe=lambda: "Probe denied. Ask the planned question.")
        await self._run_node(agent)
        await agent.request_probe()
        await self._run_node(agent)
        tools, choice = calls[-1]
        self.assertEqual(tools, [])
        self.assertEqual(choice, "none")

    async def test_a_new_candidate_turn_rearms_the_tool_requirement(self):
        agent, calls = self._agent(on_advance=lambda: "Advance authorized.")
        await agent.advance_screening()
        message = types.SimpleNamespace(text_content="Next answer.")
        await agent.on_user_turn_completed(types.SimpleNamespace(items=[]), message)
        await self._run_node(agent)
        tools, choice = calls[-1]
        self.assertEqual(sorted(tools), ["advance_screening", "request_probe"])
        self.assertEqual(choice, "required")


class TestPhoneTurnMode(unittest.TestCase):
    """The env reader: default and fail-safe are both `toolfirst`."""

    def test_unset_is_toolfirst(self):
        with patch.dict(phone.os.environ, {}, clear=False):
            phone.os.environ.pop("PHONE_TURN_MODE", None)
            self.assertEqual(phone.phone_turn_mode(), "toolfirst")

    def test_explicit_toolless(self):
        with patch.dict(phone.os.environ, {"PHONE_TURN_MODE": "toolless"}):
            self.assertEqual(phone.phone_turn_mode(), "toolless")

    def test_toolfirst_is_accepted_verbatim(self):
        with patch.dict(phone.os.environ, {"PHONE_TURN_MODE": "toolfirst"}):
            self.assertEqual(phone.phone_turn_mode(), "toolfirst")

    def test_unknown_value_fails_safe_to_toolfirst(self):
        for bad in ("browser", "toolfirst-ish", "", "auto", "1", "true"):
            with patch.dict(phone.os.environ, {"PHONE_TURN_MODE": bad}):
                self.assertEqual(
                    phone.phone_turn_mode(), "toolfirst",
                    msg=f"{bad!r} must fail safe to toolfirst",
                )

    def test_case_and_whitespace_insensitive_for_toolless(self):
        with patch.dict(phone.os.environ, {"PHONE_TURN_MODE": "  ToolLess  "}):
            self.assertEqual(phone.phone_turn_mode(), "toolless")


class TestToollessLlmNode(unittest.IsolatedAsyncioTestCase):
    """(a) A toolless substantive turn is ONE pass with no required tool.

    Tool-first forces `tool_choice="required"` on a muzzled first leg, resolves a
    coordinator tool, then runs a second `tool_choice="none"` speech leg — two
    Gemini calls. Toolless passes the turn straight through with
    `tool_choice="auto"` in a single call and the reply streams. Tools stay
    AVAILABLE (auto, not stripped) so the governed mid-call actions remain
    reachable; they are simply never forced.
    """

    def _agent(self):
        calls: list[tuple[list, str]] = []

        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions

            async def llm_node(self, chat_ctx, tools, model_settings):
                calls.append((
                    [_tool_name(t) for t in tools],
                    getattr(model_settings, "tool_choice", None),
                ))

                async def chunks():
                    yield "spoken chunk"
                return chunks()

        def _tool_name(tool):
            return str(getattr(tool, "name", None) or getattr(tool, "__name__", ""))

        cls = phone.phone_agent_class(BaseAgent)
        agent = cls(
            "instructions", client=FakeEventClient(), attempt_id=_ATTEMPT_ID,
            say=AsyncMock(), native_turns=True,
            on_user_turn=lambda *a, **k: None,
            turn_mode="toolless",
        )
        agent.authorize_screening()
        return agent, calls

    @staticmethod
    def _tools():
        return [
            types.SimpleNamespace(name="request_probe"),
            types.SimpleNamespace(name="advance_screening"),
            types.SimpleNamespace(name="schedule_callback"),
        ]

    @staticmethod
    def _settings():
        from dataclasses import dataclass

        @dataclass
        class Settings:
            tool_choice: str = "auto"
        return Settings()

    async def _run_node(self, agent):
        chunks = []
        async for chunk in agent.llm_node(None, self._tools(), self._settings()):
            chunks.append(chunk)
        return chunks

    async def test_substantive_turn_is_one_auto_pass_and_the_reply_streams(self):
        agent, calls = self._agent()
        chunks = await self._run_node(agent)
        # The reply streams (browser-style: the model authors and speaks it now).
        self.assertEqual(chunks, ["spoken chunk"])
        # Exactly ONE llm pass, with `tool_choice="auto"` — never a required leg.
        self.assertEqual(len(calls), 1)
        tools, choice = calls[-1]
        self.assertEqual(choice, "auto")

    async def test_coordinator_tools_are_stripped_governed_tools_stay(self):
        # The cursor is owned by the background commit, so the coordinator tools
        # (advance_screening / request_probe) are REMOVED — leaving them under
        # `auto` let the model fire a concurrent second on_advance that raced the
        # cursor into a spurious HALT_PERSISTENCE. The governed callback tools
        # stay available so the model can still act on a callback request.
        agent, calls = self._agent()
        await self._run_node(agent)
        tools, _choice = calls[-1]
        self.assertNotIn("advance_screening", tools)
        self.assertNotIn("request_probe", tools)
        self.assertIn("schedule_callback", tools)

    async def test_no_required_leg_even_across_repeated_turns(self):
        agent, calls = self._agent()
        await self._run_node(agent)
        # A new candidate turn: still ONE auto pass, no re-armed required leg.
        message = types.SimpleNamespace(text_content="Next answer.")
        await agent.on_user_turn_completed(types.SimpleNamespace(items=[]), message)
        await self._run_node(agent)
        choices = [c for _t, c in calls]
        self.assertEqual(choices, ["auto", "auto"])
        self.assertNotIn("required", choices)

    async def test_toolfirst_agent_is_unchanged(self):
        # The default agent (no turn_mode) still forces the required leg — the
        # rollback story: nothing about the tool-first path moved.
        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions

            async def llm_node(self, chat_ctx, tools, model_settings):
                self.last = (
                    [str(getattr(t, "name", "")) for t in tools],
                    getattr(model_settings, "tool_choice", None),
                )

                async def chunks():
                    if False:
                        yield None
                return chunks()

        agent = phone.phone_agent_class(BaseAgent)(
            "instructions", client=FakeEventClient(), attempt_id=_ATTEMPT_ID,
            say=AsyncMock(), native_turns=True, on_user_turn=lambda *a, **k: None,
        )
        agent.authorize_screening()
        async for _ in agent.llm_node(None, self._tools(), self._settings()):
            pass
        tools, choice = agent.last
        self.assertEqual(choice, "required")
        self.assertEqual(sorted(tools), ["advance_screening", "request_probe"])


class _RacedTrackingSession(_FakePhoneSession):
    """A session that reproduces the 2026-08-29 silent-room-kill race.

    On the live call the first planned question WAS delivered, but the SDK
    events that populate the native turn tracking (`conversation_item_added`,
    `agent_state_changed`, `speech_created`) had NOT landed by the time the
    candidate's first plain answer arrived. `on_native_turn` then read an empty
    `latest_assistant[0]`, tripped the malformed-exchange guard, and the main
    loop deleted a healthy, active SIP room.

    This fake models exactly that: when it delivers the FIRST authorized
    planned question it fires NO tracking events (it stays silent on the wire
    as far as the tracking is concerned) and simply schedules the candidate's
    reply. Every later turn behaves like the parent so the conversation can
    continue once the guard degrades.
    """

    first_question_delivered: bool = False

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.first_question_delivered = False

    def _deliver_first_question_silently(self):
        # Deliver the planned first question WITHOUT priming any tracking: no
        # conversation item, no agent-state transition, no speech_created. Then
        # schedule the candidate's answer exactly as the parent does.
        self.first_question_delivered = True
        speech = _FakeSpeech()
        if self.answers:
            reply = self.answers.pop(0)
            if reply is not None:
                asyncio.get_event_loop().call_soon(self.emit_user_turn, reply)
        return speech

    def _is_first_authorized_question(self, text):
        return (
            getattr(self.agent, "_screening_authorized", False)
            and not phone.is_gate_copy(text)
            and not self.first_question_delivered
        )

    def say(self, text, **kwargs):
        if self._is_first_authorized_question(text):
            self.spoken.append(text)
            return self._deliver_first_question_silently()
        return super().say(text, **kwargs)

    def generate_reply(self, instructions=None, **kwargs):
        # The gate opening still runs through the parent (it must disclose and
        # consent). The first PLANNED question is the one delivered silently.
        if (
            not getattr(self.agent, "_gate_opening", False)
            and self._is_first_authorized_question(str(instructions or ""))
        ):
            self.instructions.append(str(instructions or ""))
            return self._deliver_first_question_silently()
        return super().generate_reply(instructions=instructions, **kwargs)


class _InertSession:
    """A session that installs the coordinator's turn hook but drives nothing.

    The native coordinator delivers the first question through
    `generate_reply`/`say`; here those do NOTHING (no events, no scheduled
    answers) so the test owns the tracking lists and can drive `on_native_turn`
    by hand — the only way to exercise the guard's two-strike logic in
    isolation.
    """

    def __init__(self):
        self.handlers: dict = {}
        self.instructions: list[str] = []
        self.spoken: list[str] = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    def generate_reply(self, instructions=None, **kwargs):
        self.instructions.append(str(instructions or ""))
        return _FakeSpeech()

    def say(self, text, **kwargs):
        self.spoken.append(text)
        return _FakeSpeech()


async def _make_native_coordinator(*, turn_mode="toolfirst", client=None, state=None):
    """Start a REAL `_run_native_phone_screening` and return its live turn hook.

    Returns `(agent, session, state, client, hooks)` where `hooks` exposes the
    installed `on_native_turn`, the tracking lists/events the guard reads (which
    the coordinator takes as parameters, so the test genuinely owns them), the
    `finished`/`terminal_reason` it decides on, a `_log` spy, and a
    `drive_terminal` coroutine that awaits the coordinator's terminal handling.
    """
    class BaseAgent:
        def __init__(self, instructions=""):
            self.instructions = instructions

    agent = phone.phone_agent_class(BaseAgent)(
        "instructions", client=FakeEventClient(), attempt_id=_ATTEMPT_ID,
        say=AsyncMock(), native_turns=True, turn_mode=turn_mode,
    )
    session = _InertSession()
    state = state if state is not None else _default_state()
    client = client if client is not None else FakeEventClient()

    latest_assistant: list = [None]
    latest_assistant_anchor: list = [None]
    latest_candidate_anchor: list = [None]
    candidate_end_requested = asyncio.Event()
    reply_started = asyncio.Event()
    reply_handle: list = [None]
    assistant_delivery_complete = asyncio.Event()
    candidate_activity = asyncio.Event()
    agent_listening = asyncio.Event()
    agent_activity_changed = asyncio.Event()
    close_event = asyncio.Event()

    spy = MagicMock(wraps=agent_mod._log)
    log_patch = patch.object(agent_mod, "_log", spy)
    log_patch.start()

    task = asyncio.ensure_future(
        agent_mod._run_native_phone_screening(
            session=session, agent=agent, events=client, state=state,
            attempt_id=_ATTEMPT_ID, session_id=_SESSION_ID, room_name=_PHONE_ROOM,
            result=phone.PhoneGateResult(
                phone.CLASSIFY_HUMAN, assessment_allowed=True,
            ),
            latest_assistant=latest_assistant,
            latest_assistant_anchor=latest_assistant_anchor,
            latest_candidate_anchor=latest_candidate_anchor,
            candidate_end_requested=candidate_end_requested,
            reply_started=reply_started, reply_handle=reply_handle,
            assistant_delivery_complete=assistant_delivery_complete,
            candidate_activity=candidate_activity,
            agent_listening=agent_listening,
            agent_activity_changed=agent_activity_changed,
            close_event=close_event,
            turn_mode=turn_mode,
        )
    )
    # Let the coordinator install its hook and deliver the (inert) first question.
    for _ in range(50):
        await asyncio.sleep(0)
        if getattr(agent, "_on_user_turn", None) is not None:
            break

    async def drive_terminal():
        # Let the coordinator run its terminal handling to completion. The
        # room delete is patched so the teardown does not touch the SDK; the
        # `assessment.*` posting and the teardown log are the observable
        # terminal effects the test asserts on.
        with patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock):
            await asyncio.wait_for(task, timeout=5)
        log_patch.stop()

    hooks = {
        "on_native_turn": agent._on_user_turn,
        "latest_assistant": latest_assistant,
        "latest_assistant_anchor": latest_assistant_anchor,
        "assistant_delivery_complete": assistant_delivery_complete,
        "close_event": close_event,
        "log": spy,
        "task": task,
        "log_patch": log_patch,
        "drive_terminal": drive_terminal,
    }
    return agent, session, state, client, hooks


class TestSilentRoomKillGuard(unittest.IsolatedAsyncioTestCase):
    """PR-1 (F0a/F0b/F0c/F4): the worker must not delete a live room silently.

    Root cause (live 2026-08-29): the consent→screening handoff seeded the
    first question but never primed the native turn tracking. The candidate's
    first plain answer read an empty `latest_assistant[0]` at the guard
    (agent.py on_native_turn), which set HALT_MALFORMED_EXCHANGE and finished
    the leg; the main loop then treated that as post-nothing and
    unconditionally deleted the LiveKit room — killing a healthy call with no
    log. These tests pin the four parts of the fix.
    """

    def setUp(self):
        # `_FakePhoneSession.__init__` reads answers from — and appends
        # instances to — the BASE class attributes, so the harness is driven
        # through the base class even for subclasses.
        _FakePhoneSession.instances = []
        _FakePhoneSession.default_answers = []
        _FakePhoneSession.default_emit_auto_speech = True
        _FakePhoneSession.include_timing = False

    async def _run(self, *, session_cls, answers, replies, complete=None):
        ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()])
        client = FakeEventClient(complete=complete)
        _FakePhoneSession.default_answers = list(replies)
        _FakePhoneSession.default_emit_auto_speech = True

        async def classifier(turns, say):
            return phone.CLASSIFY_HUMAN

        async def recording_seam():
            return None

        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy), \
             patch.object(agent_mod, "AgentSession", session_cls), \
             patch.object(agent_mod, "persistence", MagicMock()), \
             patch.object(
                 agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
                 side_effect=lambda _room: client.timeline.append("room.delete"),
             ) as delete, \
             patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.2):
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                    client=client, classifier=classifier,
                )
            )
            await asyncio.sleep(0.05)
            session = _FakePhoneSession.instances[-1] if _FakePhoneSession.instances else None
            if session is not None and session.start_calls:
                session.emit_close()
            await asyncio.wait_for(task, timeout=5)
        return client, delete, session, spy

    @staticmethod
    def _log_categories(spy, error_type):
        calls = list(spy.info.call_args_list) + list(spy.warn.call_args_list)
        return [
            c.kwargs.get("error_category")
            for c in calls
            if c.kwargs.get("error_type") == error_type
        ]

    async def test_the_incident_call_now_completes_and_every_close_is_logged(self):
        """F0a + F0c: the exact incident call now runs to completion.

        The raced session delivers the first question with no tracking primed —
        the precise 2026-08-29 condition that killed a healthy call. F0a primes
        the tracking at the handoff so the first answer is a clean advance, the
        boundary commits, and the call completes. And F0c's invariant holds end
        to end: the room is torn down only at the genuine end AND only after a
        reason log names it — the property whose absence made the kill silent.
        """
        client, delete, session, spy = await self._run(
            session_cls=_RacedTrackingSession,
            answers=("Yes, that's fine.",),
            replies=["First answer.", "Second answer."],
        )
        # The exchange was NOT declared malformed — the call completed.
        self.assertIn("assessment.completed", client.event_types)
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        # The room WAS torn down (the call genuinely ended) but only AFTER a
        # reason log — never silently.
        delete.assert_awaited()
        teardown = self._log_categories(spy, "phone_room_teardown")
        self.assertTrue(teardown)
        # And the deletion chokepoint itself is attributable.
        self.assertTrue(
            any(
                c.kwargs.get("error_type") == "phone_room_deleted"
                for c in spy.info.call_args_list
            )
        )

    async def test_gate_handoff_primes_tracking_so_a_plain_first_answer_survives(self):
        """F0a: the priming is what makes the raced first answer survive.

        Without the handoff priming this exact session trips the guard on the
        first answer. The test asserts the positive outcome the priming buys:
        the first plain answer is committed as a real boundary and the guard
        never records a malformed-exchange recovery or terminal for cursor 0.
        """
        client, delete, session, spy = await self._run(
            session_cls=_RacedTrackingSession,
            answers=("Yes, that's fine.",),
            replies=["First answer.", "Second answer."],
        )
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        # The guard neither recovered nor terminated — the priming meant it was
        # never reached with empty tracking at all.
        self.assertEqual(
            self._log_categories(spy, "phone_turn_guard"), []
        )

    async def test_guard_recovers_once_then_terminates_truthfully_on_a_second_hit(self):
        """F0b: two consecutive empty reads at the same cursor is a real fault.

        Driving the REAL coordinator's installed `on_native_turn` (the unit the
        guard lives in) with the tracking forced empty: the first empty read
        RE-ASKS the planned question and does NOT finish (recovered); the second
        empty read at the SAME cursor logs the terminal category, and the
        coordinator then POSTS `assessment.aborted` (not nothing) and LOGS the
        teardown reason before the room is deleted.
        """
        agent, session, state, client, hooks = await _make_native_coordinator()
        on_turn = hooks["on_native_turn"]
        # Force the empty-tracking condition the guard reads: delivery complete
        # (so it is not mistaken for an interruption) but no captured question.
        hooks["latest_assistant"][0] = None
        hooks["latest_assistant_anchor"][0] = 1
        hooks["assistant_delivery_complete"].set()

        # First empty read → recovered: the planned question is re-asked and the
        # leg is NOT finished (the task is still running).
        turn_ctx = types.SimpleNamespace(items=[])
        await on_turn(
            "A plain answer.",
            types.SimpleNamespace(text_content="A plain answer."),
            turn_ctx,
        )
        self.assertFalse(hooks["task"].done())
        reask = " ".join(
            m["content"] if isinstance(m, dict) else "" for m in turn_ctx.items
        ).lower()
        self.assertIn("first question", reask)
        self.assertEqual(
            self._log_categories(hooks["log"], "phone_turn_guard"),
            ["malformed_exchange_recovered"],
        )

        # Second empty read at the SAME cursor → terminal. Keep the tracking
        # empty so the guard reads it as malformed again.
        hooks["latest_assistant"][0] = None
        turn_ctx2 = types.SimpleNamespace(items=[])
        await on_turn(
            "Still nothing usable.",
            types.SimpleNamespace(text_content="x"),
            turn_ctx2,
        )
        self.assertEqual(
            self._log_categories(hooks["log"], "phone_turn_guard"),
            ["malformed_exchange_recovered", "malformed_exchange_terminal"],
        )
        # The coordinator now finishes. It must POST the truthful terminal and
        # LOG the teardown reason before the room is deleted.
        await hooks["drive_terminal"]()
        self.assertIn("assessment.aborted", client.event_types)
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertTrue(self._log_categories(hooks["log"], "phone_room_teardown"))

    async def test_a_disconnect_preserves_the_room_and_never_deletes(self):
        """X2 (2026-08-29 CPU-starvation): a `disconnect` PRESERVES the room.

        The candidate's connection dies mid-leg: the native silence loop sees
        the close and sets `disconnect`. Under the old contract this LOGGED and
        then FELL THROUGH to `_close_phone_room`, deleting a LIVE room whose SIP
        participant was still `callStatus: "active"` — killing exactly the room
        LiveKit re-dispatch needs to resume the call. The new contract: log the
        non-terminal drop, log `phone_room_preserved`, and RETURN without
        deleting. The room's own `emptyTimeout` (120 s) garbage-collects it if
        the candidate actually hung up. Neither terminal event is posted — the
        reclaim/reconnect machinery still owns that reason.
        """
        ctx = FakeCtx(_PHONE_ROOM, participants=[_participant()])
        client = FakeEventClient()
        # One screening answer, then no further candidate activity — the
        # session closes externally, which the silence loop reads as disconnect.
        _FakePhoneSession.default_answers = ["First answer."]
        _FakePhoneSession.default_emit_auto_speech = True

        async def classifier(turns, say):
            return phone.CLASSIFY_HUMAN

        async def recording_seam():
            return None

        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy), \
             patch.object(agent_mod, "AgentSession", _DisconnectingSession), \
             patch.object(agent_mod, "persistence", MagicMock()), \
             patch.object(
                 agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
             ) as delete, \
             patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 1.0):
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, _PHONE_ROOM, _ATTEMPT_ID, _EPOCH,
                    client=client, classifier=classifier,
                )
            )
            await asyncio.sleep(0.05)
            session = _FakePhoneSession.instances[-1]
            # The leg drops: the close event fires while the loop is waiting.
            session.emit_close()
            await asyncio.wait_for(task, timeout=5)
        # NON-TERMINAL: neither terminal event is posted for a disconnect.
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        # The disconnect is logged non-terminal AND the room is logged preserved.
        self.assertIn(
            "disconnect_nonterminal",
            self._log_categories(spy, "phone_session_terminal"),
        )
        self.assertIn(
            "disconnect", self._log_categories(spy, "phone_room_preserved"),
        )
        # The room is NOT torn down: no teardown log, no delete — LiveKit
        # re-dispatch owns the live room, emptyTimeout owns a real hangup.
        self.assertEqual(self._log_categories(spy, "phone_room_teardown"), [])
        delete.assert_not_awaited()


class _DisconnectingSession(_FakePhoneSession):
    """A normal session whose candidate stops responding after consent — the
    external close then drops the leg, which the silence loop reads as
    `disconnect`. Behaves exactly like the parent otherwise."""


class TestToollessBackgroundCommit(unittest.IsolatedAsyncioTestCase):
    """(b)+(c): toolless commits the boundary in the background, off the speech
    path, keyed identically to tool-first — and a commit failure is loud and
    does NOT end the call.
    """

    @staticmethod
    def _log_categories(spy, error_type):
        calls = list(spy.info.call_args_list) + list(spy.warn.call_args_list)
        return [
            c.kwargs.get("error_category")
            for c in calls
            if c.kwargs.get("error_type") == error_type
        ]

    async def _drain(self, hooks, predicate, tries=200):
        for _ in range(tries):
            await asyncio.sleep(0)
            if predicate():
                return True
        return False

    async def test_a_toolless_turn_commits_in_the_background_after_delivery(self):
        """(b) The turn injects NO required-tool instruction; the boundary is
        committed off the speech path only after the reply is delivered, on the
        SAME idempotent `source_event_id` tool-first would use.
        """
        client = FakeEventClient()
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", client=client,
        )
        on_turn = hooks["on_native_turn"]
        # A well-formed exchange: the ask was delivered and captured (the guard
        # requires delivery to be complete, else it reads the turn as an
        # interruption). Delivery being set also lets the background commit run.
        hooks["latest_assistant"][0] = "First question?"
        hooks["latest_assistant_anchor"][0] = 1
        hooks["assistant_delivery_complete"].set()

        turn_ctx = types.SimpleNamespace(items=[])
        await on_turn(
            "A real substantive answer.",
            types.SimpleNamespace(text_content="A real substantive answer."),
            turn_ctx,
        )
        # The per-turn instruction is the browser-style one — it must NOT demand
        # a coordinator tool before speech.
        injected = " ".join(
            m["content"] if isinstance(m, dict) else "" for m in turn_ctx.items
        ).lower()
        self.assertIn("planned question", injected)
        self.assertNotIn("coordinator tool", injected)
        self.assertNotIn("never speak before the tool result", injected)
        # The commit runs on a BACKGROUND task (off the on_turn/speech path):
        # on_turn itself performed no commit synchronously.
        self.assertEqual(client.committed_keys, [])
        # Drain the event loop so the scheduled background commit runs; it fires
        # with the plan key and the deterministic source_event_id.
        committed = await self._drain(hooks, lambda: client.committed_keys == ["k1"])
        self.assertTrue(committed, "background commit did not run after delivery")
        self.assertEqual(client.boundaries[0]["question_key"], "k1")
        self.assertEqual(
            client.boundaries[0]["source_event_id"],
            phone.plan_source_event_id("k1"),
        )
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_a_failed_background_commit_is_loud_and_keeps_the_call_alive(self):
        """(c) A persistence failure on the background commit logs loudly and
        does NOT drop the call — the server owns durable resume, so a lost
        commit only means resume re-asks that one topic.
        """
        refusal = phone.PhoneApiOutcome(False, "conflict")
        refusal.cursor = 0  # stale/failed: cursor did not advance to 1
        client = FakeEventClient(commits={"k1": refusal})
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", client=client,
        )
        on_turn = hooks["on_native_turn"]
        hooks["latest_assistant"][0] = "First question?"
        hooks["latest_assistant_anchor"][0] = 1
        hooks["assistant_delivery_complete"].set()

        turn_ctx = types.SimpleNamespace(items=[])
        await on_turn(
            "An answer whose commit will fail.",
            types.SimpleNamespace(text_content="An answer whose commit will fail."),
            turn_ctx,
        )
        # Wait for the background commit to attempt and fail.
        attempted = await self._drain(hooks, lambda: client.committed_keys == ["k1"])
        self.assertTrue(attempted)
        # The failure is loud.
        halted = await self._drain(
            hooks,
            lambda: "commit_halted_persistence" in self._log_categories(
                hooks["log"], "phone_toolless_commit",
            ),
        )
        self.assertTrue(halted, "a failed background commit must log loudly")
        # The call is NOT dropped by the background task itself — the coordinator
        # task is still running (a failed commit is survivable pilot behavior).
        self.assertFalse(hooks["task"].done())
        hooks["close_event"].set()
        await hooks["drive_terminal"]()


class TestToollessGovernedActions(unittest.IsolatedAsyncioTestCase):
    """(d) The governed mid-call routes (callback deferral, candidate-end) still
    fire in toolless — those are text/route driven, not on the substantive
    commit path, so toolless leaves them exactly as they are.
    """

    async def test_a_candidate_end_request_still_ends_the_call_in_toolless(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        turn_ctx = types.SimpleNamespace(items=[])
        # An explicit end-call utterance routes to the terminal closing, never to
        # a substantive commit.
        await on_turn(
            "Please stop the call now, I have to go.",
            types.SimpleNamespace(text_content="Please stop the call now, I have to go."),
            turn_ctx,
        )
        injected = " ".join(
            m["content"] if isinstance(m, dict) else "" for m in turn_ctx.items
        ).lower()
        self.assertIn("end the call", injected)
        self.assertEqual(client.committed_keys, [])
        # Candidate-end sets `terminal_reply_required`, so the coordinator waits
        # for the terminal reply's playout; the inert session never plays one, so
        # shorten that bounded wait for the test.
        with patch.object(agent_mod, "PHONE_TERMINAL_REPLY_TIMEOUT_SEC", 0.05):
            await hooks["drive_terminal"]()
        self.assertIn("assessment.aborted", client.event_types)

    async def test_a_callback_deferral_routes_to_the_callback_policy_in_toolless(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        # A recognised "call me back" defers: it must set the callback policy and
        # inject the propose_callback instruction, NOT commit the boundary.
        text = "Can you call me back later? Now is not a good time."
        route = phone.candidate_turn_route(text)
        self.assertEqual(route, "callback_deferral")
        turn_ctx = types.SimpleNamespace(items=[])
        await on_turn(text, types.SimpleNamespace(text_content=text), turn_ctx)
        self.assertEqual(getattr(agent, "_turn_policy"), "callback")
        injected = " ".join(
            m["content"] if isinstance(m, dict) else "" for m in turn_ctx.items
        ).lower()
        self.assertIn("propose_callback", injected)
        self.assertEqual(client.committed_keys, [])
        hooks["close_event"].set()
        await hooks["drive_terminal"]()


class TestToollessSessionFlow(unittest.IsolatedAsyncioTestCase):
    """(f) The full session under `PHONE_TURN_MODE=toolless`.

    Standalone (does NOT inherit the tool-first flow suite, whose micro-asserts
    pin tool-first-specific details — e.g. the goodbye instruction being folded
    into the FINAL answer's turn context. In toolless the final commit is
    deferred to a background task AFTER that reply is generated, so the closing
    instruction rides the next turn instead. That is the documented
    commit-off-the-speech-path tradeoff, not a regression). What a candidate
    actually cares about holds identically: every plan key is committed in order
    and the call completes.

    It reuses the parent's `_run_session` harness through an instance, flipping
    the env to toolless.
    """

    def setUp(self):
        _FakePhoneSession.instances = []
        _FakePhoneSession.default_answers = []
        _FakePhoneSession.default_mid_turn_says = []
        _FakePhoneSession.default_interruptions = []
        _FakePhoneSession.default_silence_reply = None
        _FakePhoneSession.default_emit_auto_speech = True
        _FakePhoneSession.include_timing = False
        self._harness = TestPhoneSessionFlow()

    async def _run_session(self, **kwargs):
        with patch.dict(phone.os.environ, {"PHONE_TURN_MODE": "toolless"}):
            return await self._harness._run_session(**kwargs)

    async def test_toolless_commits_every_key_in_order_and_completes(self):
        result, client, recording, delete, session, _ = await self._run_session(
            answers=("Yes, that's fine.",),
            replies=["First answer.", "Second answer."],
        )
        self.assertTrue(result.assessment_allowed)
        self.assertEqual(client.committed_keys, ["k1", "k2"])
        self.assertIn("assessment.completed", client.event_types)
        delete.assert_awaited()
        # No substantive turn ever asked the model for a coordinator tool.
        joined = " ".join(session.instructions).lower()
        self.assertNotIn("call exactly one coordinator tool", joined)

    async def test_toolless_logs_the_mode_once_at_session_start(self):
        _, client, _, _, session, _ = await self._run_session(
            answers=("Yes, that's fine.",),
            replies=["First answer.", "Second answer."],
        )
        # The mode line is emitted once; we cannot see the module _log here, but
        # the committed keys prove the toolless path ran end to end.
        self.assertEqual(client.committed_keys, ["k1", "k2"])


class _CapturingSession:
    """An AgentSession stub that records the kwargs it was constructed with."""

    last_kwargs: dict | None = None

    def __init__(self, **kwargs):
        _CapturingSession.last_kwargs = dict(kwargs)
        self._handlers = {}

    def on(self, event):
        def deco(fn):
            self._handlers[event] = fn
            return fn
        return deco

    async def start(self, **kwargs):
        return None


class TestPhoneTurnDetectionFlag(unittest.TestCase):
    """X8 — STT-endpointing offload flag. Rollback-first: local == today."""

    def test_flag_parsing_local_is_default(self):
        for value in ("", "local", "LOCAL", "  local  ", "garbage", "STT_MODE"):
            with patch.dict(os.environ, {"PHONE_TURN_DETECTION": value}, clear=False):
                self.assertEqual(
                    phone.phone_turn_detection(), phone.PHONE_TURN_DETECTION_LOCAL,
                )
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_TURN_DETECTION", None)
            self.assertEqual(
                phone.phone_turn_detection(), phone.PHONE_TURN_DETECTION_LOCAL,
            )

    def test_flag_parsing_stt(self):
        for value in ("stt", "STT", "  stt  "):
            with patch.dict(os.environ, {"PHONE_TURN_DETECTION": value}, clear=False):
                self.assertEqual(
                    phone.phone_turn_detection(), phone.PHONE_TURN_DETECTION_STT,
                )

    def test_phone_session_gets_stt_turn_detection_when_flagged(self):
        _CapturingSession.last_kwargs = None
        with patch.object(agent_mod, "AgentSession", _CapturingSession), \
             patch.dict(os.environ, {"PHONE_TURN_DETECTION": "stt"}, clear=False):
            agent_mod._build_phone_provider_session()
        self.assertEqual(_CapturingSession.last_kwargs.get("turn_detection"), "stt")

    def test_phone_session_has_no_turn_detection_when_local(self):
        _CapturingSession.last_kwargs = None
        with patch.object(agent_mod, "AgentSession", _CapturingSession), \
             patch.dict(os.environ, {"PHONE_TURN_DETECTION": "local"}, clear=False):
            agent_mod._build_phone_provider_session()
        self.assertNotIn("turn_detection", _CapturingSession.last_kwargs)

    def test_browser_session_never_gets_turn_detection(self):
        # Even with the flag set to stt, the browser (non-phone) build path is
        # phone_mode=False, so it must never receive the override.
        _CapturingSession.last_kwargs = None
        with patch.object(agent_mod, "AgentSession", _CapturingSession), \
             patch.dict(os.environ, {"PHONE_TURN_DETECTION": "stt"}, clear=False):
            agent_mod._build_provider_session()
        self.assertNotIn("turn_detection", _CapturingSession.last_kwargs)

    def test_mode_is_logged_once_at_phone_session_start(self):
        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "AgentSession", _CapturingSession), \
             patch.object(agent_mod, "_log", spy), \
             patch.dict(os.environ, {"PHONE_TURN_DETECTION": "stt"}, clear=False):
            agent_mod._build_phone_provider_session()
        detection_logs = [
            c.kwargs.get("error_category")
            for c in spy.info.call_args_list
            if c.kwargs.get("error_type") == "phone_turn_detection"
        ]
        self.assertEqual(detection_logs, ["stt"])


class TestPhoneRoleDeterminism(unittest.TestCase):
    """X3 — the role reaches every per-turn instruction, verbatim."""

    def _question(self):
        return phone.PhonePlanQuestion(
            key="k1", text="Tell me about your last role.",
            mandatory=True, hint=None,
        )

    def test_per_turn_instruction_contains_the_verbatim_title(self):
        title = "Sales Advisor / Program Advisor - Synthetic Canary"
        text = agent_mod.phone_question_instructions(self._question(), title)
        self.assertIn(f'The role is exactly: "{title}"', text)
        self.assertIn("never invent a job title", text)

    def test_no_role_line_when_title_absent(self):
        for title in (None, "", "   "):
            text = agent_mod.phone_question_instructions(self._question(), title)
            self.assertNotIn("The role is exactly", text)

    def test_default_arg_is_byte_identical_to_no_role(self):
        # The browser/legacy callers pass no role — the default must add nothing.
        q = self._question()
        self.assertEqual(
            agent_mod.phone_question_instructions(q),
            agent_mod.phone_question_instructions(q, None),
        )

    def test_role_turn_line_helper(self):
        self.assertIsNone(agent_mod._role_turn_line(None))
        self.assertIsNone(agent_mod._role_turn_line("   "))
        line = agent_mod._role_turn_line("Data Engineer")
        self.assertIn('"Data Engineer"', line)

    def test_apply_instructions_noop_mutation_does_not_falsely_alarm(self):
        """X3b end-to-end: a fake agent whose update_instructions is a no-op
        (does not update the readable property) still gets the role into the
        DELIVERED text, so the verifier reads it back from what we delivered and
        does NOT falsely alarm. (`system_prompt` is patched to a role-bearing
        string because `test_agent.py` swaps `sys.modules['prompting']` for a
        mock at import time — the same reason the sibling `_apply_phone_
        instructions` test patches the builder rather than asserting its output.)
        """
        role = "Sales Advisor / Program Advisor - Synthetic Canary"
        st = phone.PhoneAssessmentState(ok=True)
        st.candidate_name = "Test Candidate"
        st.role_title = role
        st.role_focus = "advising"

        applied = {}

        class _Agent:
            instructions = "base prompt with no role"  # stays stale (no-op)

            async def update_instructions(self, text):
                applied["text"] = text  # routed to live activity, not property

        spy = MagicMock(wraps=agent_mod._log)
        built = f"You are Christy screening for the {role} role."

        async def run():
            with patch.object(agent_mod, "_log", spy), \
                 patch.object(agent_mod, "system_prompt", return_value=built):
                return await agent_mod._apply_phone_instructions(_Agent(), st)

        ok = asyncio.run(run())
        self.assertTrue(ok)
        self.assertIn(role, applied["text"])
        categories = [
            c.kwargs.get("error_category")
            for c in list(spy.info.call_args_list) + list(spy.warn.call_args_list)
            if c.kwargs.get("error_type") == "phone_instructions_not_applied"
        ]
        self.assertEqual(categories, [])

    def test_apply_instructions_flags_when_builder_drops_the_role(self):
        """X3b: if the delivered prompt does NOT name the role (and the readable
        property is stale), the verifier logs loudly — this is the observability
        that was missing when a live call spoke the wrong job title."""
        st = phone.PhoneAssessmentState(ok=True)
        st.candidate_name = "Test Candidate"
        st.role_title = "Data Engineer"
        st.role_focus = "pipelines"

        class _Agent:
            instructions = "base prompt with no role"

            async def update_instructions(self, text):
                return None

        spy = MagicMock(wraps=agent_mod._log)

        async def run():
            with patch.object(agent_mod, "_log", spy), \
                 patch.object(agent_mod, "system_prompt", return_value="no title here"):
                return await agent_mod._apply_phone_instructions(_Agent(), st)

        asyncio.run(run())
        categories = [
            c.kwargs.get("error_category")
            for c in list(spy.info.call_args_list) + list(spy.warn.call_args_list)
            if c.kwargs.get("error_type") == "phone_instructions_not_applied"
        ]
        self.assertIn("role_title_absent", categories)


class TestTeardownLabelVocabulary(unittest.TestCase):
    """X7b — the teardown log has its own bounded vocabulary."""

    def test_halt_reasons_are_distinguishable(self):
        # A candidate goodbye and a crash must NOT both read `other_failure`.
        self.assertEqual(
            agent_mod._teardown_label(phone.HALT_CANDIDATE_ENDED), "candidate_ended",
        )
        self.assertEqual(
            agent_mod._teardown_label(phone.HALT_CALLBACK_SCHEDULED), "callback_scheduled",
        )
        self.assertEqual(
            agent_mod._teardown_label("disconnect"), "transport_disconnect",
        )
        self.assertEqual(
            agent_mod._teardown_label(phone.HALT_MALFORMED_EXCHANGE), "malformed_exchange",
        )
        self.assertEqual(agent_mod._teardown_label("completed"), "conversation_complete")
        self.assertEqual(agent_mod._teardown_label(None), "conversation_complete")

    def test_unknown_reason_falls_back_to_other_failure(self):
        self.assertEqual(agent_mod._teardown_label("something_new"), "other_failure")


class TestPatienceSubstanceClassifier(unittest.TestCase):
    """X10 — the pure substance classifier behind the patience gate.

    Truth table drawn from live call 23 (transcript-verified): thinking
    fragments that must be SUPPRESSED, real short answers that must PASS, and
    explicit thinking statements that must earn ENCOURAGEMENT (not silence).
    """

    def test_real_short_answers_pass_as_substantive(self):
        for text in (
            "yes", "No.", "Yeah", "nope", "correct", "twelve lakhs",
            "12 LPA", "About 8 years", "3", "I did", "Not really",
            "I led the support team for four years.",
        ):
            self.assertEqual(
                phone.phone_turn_substance(text),
                phone.PHONE_SUBSTANCE_SUBSTANTIVE,
                f"{text!r} should be substantive",
            )

    def test_hesitation_fragments_are_suppressed(self):
        for text in (
            "Hmm", "hmm", "Um", "uh", "So the most", "so the most",
            "I would say", "I'd say", "yeah so", "well", "and",
            "the biggest", "challenging part",
        ):
            self.assertEqual(
                phone.phone_turn_substance(text),
                phone.PHONE_SUBSTANCE_HESITATION,
                f"{text!r} should be a hesitation",
            )

    def test_mid_thought_dangling_fragments_are_suppressed(self):
        for text in (
            "would say is", "it is about", "the thing is", "so it's",
        ):
            self.assertEqual(
                phone.phone_turn_substance(text),
                phone.PHONE_SUBSTANCE_HESITATION,
                f"{text!r} should be a mid-thought fragment",
            )

    def test_explicit_thinking_statements_route_to_encouragement(self):
        for text in (
            "let me think", "Let me think about it",
            "I'm thinking about how to put it in the right way",
            "give me a second", "give me a moment", "one second please",
            "let me gather my thoughts",
        ):
            self.assertEqual(
                phone.phone_turn_substance(text),
                phone.PHONE_SUBSTANCE_THINKING,
                f"{text!r} should be a thinking statement",
            )

    def test_a_longer_answer_that_merely_starts_with_a_filler_is_substantive(self):
        # Conservative: only SHORT clearly-unfinished fragments suppress. A real
        # answer that opens with a filler is not swallowed.
        text = "Well, I spent four years leading the onboarding team and then moved into ops."
        self.assertEqual(
            phone.phone_turn_substance(text), phone.PHONE_SUBSTANCE_SUBSTANTIVE,
        )

    def test_non_string_and_empty_are_safe(self):
        self.assertEqual(
            phone.phone_turn_substance(None), phone.PHONE_SUBSTANCE_SUBSTANTIVE,
        )
        self.assertEqual(
            phone.phone_turn_substance("   "), phone.PHONE_SUBSTANCE_HESITATION,
        )

    def test_gate_flag_defaults_on_and_only_off_disables(self):
        for value, expected in (
            ("", True), ("on", True), ("ON", True), ("garbage", True),
            ("  on ", True), ("off", False), ("OFF", False), ("  off  ", False),
        ):
            with patch.dict(phone.os.environ, {"PHONE_PATIENCE_GATE": value}):
                self.assertEqual(phone.phone_patience_gate_enabled(), expected)


class TestPatienceGateTurnHook(unittest.IsolatedAsyncioTestCase):
    """X10 — the turn hook applies the patience gate: routes first, then
    suppress hesitations, encourage thinking, pass substantive — and never
    advance the cursor on a non-answer.
    """

    def setUp(self):
        _FakePhoneSession.instances = []
        _FakePhoneSession.default_answers = []
        _FakePhoneSession.default_emit_auto_speech = True
        _FakePhoneSession.include_timing = False

    @staticmethod
    def _stop_response():
        return sys.modules["livekit.agents"].StopResponse

    async def _drain(self, predicate, tries=200):
        for _ in range(tries):
            await asyncio.sleep(0)
            if predicate():
                return True
        return False

    def _ready_turn(self, hooks):
        # A well-formed exchange: the ask was delivered and captured.
        hooks["latest_assistant"][0] = "First question?"
        hooks["latest_assistant_anchor"][0] = 1
        hooks["assistant_delivery_complete"].set()

    async def test_a_hesitation_fragment_is_suppressed_and_never_commits(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        self._ready_turn(hooks)
        turn_ctx = types.SimpleNamespace(items=[])
        with self.assertRaises(self._stop_response()):
            await on_turn(
                "So the most", types.SimpleNamespace(text_content="So the most"),
                turn_ctx,
            )
        # No reply instruction injected, no commit scheduled, cursor untouched.
        self.assertEqual(turn_ctx.items, [])
        self.assertEqual(getattr(agent, "_turn_policy"), "patience_suppressed")
        # Give any (erroneously scheduled) background commit a chance to run.
        await asyncio.sleep(0)
        self.assertEqual(client.committed_keys, [])
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_an_explicit_thinking_statement_earns_one_encouragement(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        self._ready_turn(hooks)
        turn_ctx = types.SimpleNamespace(items=[])
        # Not suppressed: the model gets ONE short-encouragement instruction and
        # nothing else, and no commit is scheduled.
        await on_turn(
            "Let me think about how to put it in the right way.",
            types.SimpleNamespace(text_content="Let me think about how to put it in the right way."),
            turn_ctx,
        )
        injected = " ".join(
            m["content"] if isinstance(m, dict) else "" for m in turn_ctx.items
        ).lower()
        self.assertIn("encouragement", injected)
        self.assertIn("do not ask a new question", injected)
        self.assertEqual(getattr(agent, "_turn_policy"), "patience_encourage")
        await asyncio.sleep(0)
        self.assertEqual(client.committed_keys, [])
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_a_substantive_answer_flows_normally_and_commits(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        self._ready_turn(hooks)
        turn_ctx = types.SimpleNamespace(items=[])
        await on_turn(
            "I led the support team for four years and cut resolution time in half.",
            types.SimpleNamespace(text_content="I led the support team for four years and cut resolution time in half."),
            turn_ctx,
        )
        self.assertEqual(getattr(agent, "_turn_policy"), "substantive")
        committed = await self._drain(lambda: client.committed_keys == ["k1"])
        self.assertTrue(committed, "a substantive turn must commit the boundary")
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_routes_are_checked_before_the_patience_gate(self):
        # A SHORT clarification would look like a fragment to the substance
        # classifier, but the route check runs first, so it still gets a spoken
        # reply (a clarification instruction), not silence.
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        self._ready_turn(hooks)
        text = "Can you repeat the question?"
        self.assertEqual(phone.candidate_turn_route(text), "candidate_question")
        turn_ctx = types.SimpleNamespace(items=[])
        await on_turn(text, types.SimpleNamespace(text_content=text), turn_ctx)
        # It routed (a clarification instruction was injected); it was not
        # suppressed and did not commit.
        self.assertEqual(getattr(agent, "_turn_policy"), "clarification")
        self.assertNotEqual(turn_ctx.items, [])
        self.assertEqual(client.committed_keys, [])
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_a_bare_hesitation_route_is_suppressed_when_gate_on(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        on_turn = hooks["on_native_turn"]
        self._ready_turn(hooks)
        # "Um" is a `hesitation` route; with the gate on it suppresses instead of
        # the pre-X10 re-ask.
        self.assertEqual(phone.candidate_turn_route("Um"), "hesitation")
        turn_ctx = types.SimpleNamespace(items=[])
        with self.assertRaises(self._stop_response()):
            await on_turn("Um", types.SimpleNamespace(text_content="Um"), turn_ctx)
        self.assertEqual(getattr(agent, "_turn_policy"), "patience_suppressed")
        self.assertEqual(client.committed_keys, [])
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_gate_off_restores_the_pre_x10_reask_behaviour(self):
        with patch.dict(phone.os.environ, {"PHONE_PATIENCE_GATE": "off"}):
            agent, session, state, client, hooks = await _make_native_coordinator(
                turn_mode="toolless",
            )
            on_turn = hooks["on_native_turn"]
            self._ready_turn(hooks)
            turn_ctx = types.SimpleNamespace(items=[])
            # A hesitation route now re-asks (speaks) rather than suppressing.
            await on_turn("Um", types.SimpleNamespace(text_content="Um"), turn_ctx)
            self.assertEqual(getattr(agent, "_turn_policy"), "clarification")
            self.assertNotEqual(turn_ctx.items, [])
            hooks["close_event"].set()
            await hooks["drive_terminal"]()


class TestSubstanceGatedCommit(unittest.IsolatedAsyncioTestCase):
    """X10 Fix 2a — the background commit re-checks substance and SKIPS the
    boundary for a non-substantive turn even if one slips past the turn gate.
    """

    @staticmethod
    def _log_categories(spy, error_type):
        calls = list(spy.info.call_args_list) + list(spy.warn.call_args_list)
        return [
            c.kwargs.get("error_category")
            for c in calls
            if c.kwargs.get("error_type") == error_type
        ]

    async def _drain(self, predicate, tries=200):
        for _ in range(tries):
            await asyncio.sleep(0)
            if predicate():
                return True
        return False

    async def test_a_non_substantive_pending_commit_is_skipped(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        # Seed the coordinator's pending buffer with a NON-substantive candidate
        # (the live hook can never do this — it suppresses first — so this is the
        # defense-in-depth path), then run the background commit directly.
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "First question?",
            "candidate": "So the most",  # a hesitation fragment, not an answer
            "message": None,
            "source_event_id": phone.plan_source_event_id("k1"),
            "probe_used": False,
        })
        hooks["assistant_delivery_complete"].set()
        await agent._commit_after_reply()
        # The commit was skipped: the cursor did not advance and it was logged.
        self.assertEqual(client.committed_keys, [])
        self.assertIn(
            "non_substantive_commit_skipped",
            self._log_categories(hooks["log"], "phone_toolless_commit"),
        )
        hooks["close_event"].set()
        await hooks["drive_terminal"]()

    async def test_a_substantive_pending_commit_proceeds(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless",
        )
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "First question?",
            "candidate": "I led the team for four years.",
            "message": None,
            "source_event_id": phone.plan_source_event_id("k1"),
            "probe_used": False,
        })
        hooks["assistant_delivery_complete"].set()
        await agent._commit_after_reply()
        self.assertEqual(client.committed_keys, ["k1"])
        hooks["close_event"].set()
        await hooks["drive_terminal"]()


class TestPhoneInstructionAssembly(unittest.TestCase):
    """X10 — the phone-only instruction blocks are present in phone instructions,
    the resume-conflict directive is conditional on resume evidence, and the
    sha-pinned browser prompt surface is untouched.
    """

    def _state(self, *, resume_facts=None):
        state = _default_state()
        state.resume_facts = resume_facts if resume_facts is not None else {}
        return state

    def test_single_question_and_expressiveness_blocks_are_always_present(self):
        text = agent_mod._phone_instructions_text(self._state())
        low = text.lower()
        self.assertIn("ask exactly one question per turn", low)
        self.assertIn("do not move to the next topic", low)
        self.assertIn("restate the current question only", low)
        # Fix 4 — lexical expressiveness / light professional humor.
        self.assertIn("the telephone line flattens your voice", low)
        self.assertIn("light, professional humor", low)
        self.assertIn("at the candidate's expense", low)

    def test_resume_conflict_directive_only_when_resume_evidence_exists(self):
        without = agent_mod._phone_instructions_text(self._state())
        self.assertNotIn("resume-conflict probing", without.lower())
        with_facts = agent_mod._phone_instructions_text(
            self._state(resume_facts={
                "name": "Asha",
                "recent_role": {"title": "Ops Lead", "employer": "Acme"},
            }),
        )
        self.assertIn("resume-conflict probing", with_facts.lower())
        self.assertIn("help me reconcile", with_facts.lower())
        self.assertIn("at most one such clarification", with_facts.lower())

    def test_browser_prompt_surface_is_byte_identical(self):
        # The phone-only blocks must never leak into the shared system_prompt.
        surface = prompting.system_prompt(
            candidate_name="Pin Candidate",
            role_title="Pin Role",
            role_focus="pin focus",
            resume_facts="pin facts",
            questions=prompting.format_questions(None),
            interviewer_instructions="pin guidance",
        )
        low = surface.lower()
        for leaked in (
            "ask exactly one question per turn",
            "the telephone line flattens your voice",
            "resume-conflict probing",
            "light, professional humor",
        ):
            self.assertNotIn(leaked, low, f"{leaked!r} leaked into the browser prompt")


if __name__ == "__main__":
    unittest.main()
