"""OBS-06 Phase 8 L3: worker instrumentation tests (bounded, deterministic).

Covers the Phase 8 L3 instrumentation added to agent.py:

  - Five truthful observable boundaries: session setup/start, opening
    ``generate_reply`` invocation-to-completion (NOT first audio, NOT
    component STT/LLM/TTS latency), turn persistence, finalization, and
    total session duration.
  - Bounded session outcome counter with an explicit fixed mapping;
    unknown values map to ``other_failure`` — never dynamic text.
  - Negative controls: raw close reasons, session/candidate IDs, room
    names and transcript text never leak into metric names/labels or span
    attributes.
  - Lifecycle invariants: finalizer runs exactly once, writes drain, CAS
    outcome is checked before any metric is emitted, scoring happens only
    after a successful completion CAS, and instrumentation failure (broken
    sink/tracer) does not alter the business flow.
  - Deterministic clock: ``agent_mod._monotonic`` is patched with a
    step-based fake — no sleeps, no wall-clock assertions.

The agent module is loaded under a unique module name (not ``agent``) so
this file cannot interfere with ``tests/test_agent.py``'s module bindings.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import types
import unittest
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock

# ---------------------------------------------------------------------------
# Path bootstrap & SDK stubs (corrected aliasing so `from livekit.plugins
# import openai` binds the module that actually carries `.LLM`).
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(__file__)
_LIVEKIT_DIR = os.path.abspath(os.path.join(_HERE, ".."))
if _LIVEKIT_DIR not in sys.path:
    sys.path.insert(0, _LIVEKIT_DIR)

_SDK_MODULES = [
    "livekit",
    "livekit.api",
    "livekit.agents",
    "livekit.plugins",
    "livekit.plugins.openai",
    "livekit.plugins.sarvam",
    "livekit.plugins.silero",
    "livekit.plugins.turn_detector",
    "livekit.plugins.turn_detector.multilingual",
]


class FakeAgentSession:
    """Deterministic SDK session fake.

    Class-level CONFIG drives behavior:
      - conversation_events: fired (in order) right after start().
      - auto_close_event:    fired from generate_reply() (then the agent
                             releases its close wait and finalizes).
      - start_exc:           raised by start() to simulate a provider
                             construction/start failure.
    """

    CONFIG: dict[str, Any] = {
        "conversation_events": [],
        "auto_close_event": None,
        "start_exc": None,
    }
    instances: list["FakeAgentSession"] = []

    def __init__(self, **kwargs: Any):
        self._handlers: dict[str, Any] = {}
        self.started = False
        FakeAgentSession.instances.append(self)

    @classmethod
    def reset(cls) -> None:
        cls.CONFIG = {"conversation_events": [], "auto_close_event": None, "start_exc": None}
        cls.instances.clear()

    def on(self, event: str):
        def decorator(fn):
            self._handlers[event] = fn
            return fn

        return decorator

    async def start(self, **kwargs: Any) -> None:
        self.started = True
        if FakeAgentSession.CONFIG["start_exc"] is not None:
            raise FakeAgentSession.CONFIG["start_exc"]
        for ev in FakeAgentSession.CONFIG["conversation_events"]:
            handler = self._handlers.get("conversation_item_added")
            if handler is not None:
                handler(ev)

    async def generate_reply(self, **kwargs: Any) -> None:
        ev = FakeAgentSession.CONFIG["auto_close_event"]
        if ev is not None:
            handler = self._handlers.get("close")
            if handler is not None:
                handler(ev)


def _install_sdk_stubs() -> None:
    modules = {n: types.ModuleType(n) for n in _SDK_MODULES}

    modules["livekit"].api = modules["livekit.api"]
    modules["livekit.api"].LiveKitAPI = MagicMock
    modules["livekit.api"].DeleteRoomRequest = MagicMock

    class FakeAgent:
        def __init__(self, instructions: str = ""):
            self.instructions = instructions

    modules["livekit.agents"].Agent = FakeAgent
    modules["livekit.agents"].AgentSession = FakeAgentSession

    class FakeJobContext:
        def __init__(self):
            self.room = MagicMock()
            self._connected = False

        async def connect(self) -> None:
            self._connected = True

    modules["livekit.agents"].JobContext = FakeJobContext

    class FakeWorkerOptions:
        def __init__(self, entrypoint_fnc):
            self.entrypoint_fnc = entrypoint_fnc

    modules["livekit.agents"].WorkerOptions = FakeWorkerOptions
    modules["livekit.agents"].cli = types.ModuleType("livekit.agents.cli")
    modules["livekit.agents"].cli.run_app = MagicMock()

    class FakeLLM:
        def __init__(self, **kwargs: Any):
            pass

    class FakeSTT:
        def __init__(self, **kwargs: Any):
            pass

    class FakeTTS:
        def __init__(self, **kwargs: Any):
            pass

    class FakeVAD:
        @staticmethod
        def load(**kwargs: Any) -> MagicMock:
            return MagicMock()

    # Populate the leaf modules that agent.py imports from.
    modules["livekit.plugins.openai"].LLM = FakeLLM
    modules["livekit.plugins.sarvam"].STT = FakeSTT
    modules["livekit.plugins.sarvam"].TTS = FakeTTS
    modules["livekit.plugins.silero"].VAD = FakeVAD
    modules["livekit.plugins.turn_detector.multilingual"].MultilingualModel = MagicMock

    # Alias parent attributes to the SAME module objects held in sys.modules so
    # `from livekit.plugins import openai` and deep from-imports agree.
    modules["livekit.plugins"].openai = modules["livekit.plugins.openai"]
    modules["livekit.plugins"].sarvam = modules["livekit.plugins.sarvam"]
    modules["livekit.plugins"].silero = modules["livekit.plugins.silero"]
    modules["livekit.plugins"].turn_detector = modules["livekit.plugins.turn_detector"]

    for name, mod in modules.items():
        sys.modules[name] = mod


_install_sdk_stubs()

# Stub dotenv (agent.py calls load_dotenv()).
_mock_dotenv = types.ModuleType("dotenv")
_mock_dotenv.load_dotenv = MagicMock()
sys.modules["dotenv"] = _mock_dotenv

# Stub persistence + prompting for THIS module load only; restore afterwards so
# the real modules stay available to the other test files.
_orig_persistence = sys.modules.get("persistence")
_orig_prompting = sys.modules.get("prompting")

persistence_mock = types.ModuleType("persistence")
persistence_mock.LifecycleError = type("LifecycleError", (Exception,), {})
persistence_mock.WorkerContext = type("WorkerContext", (), {})
persistence_mock.ClaimResult = SimpleNamespace(
    CLAIMED="claimed", ALREADY_MATCHING="already_matching",
    CONFLICT="conflict", MISSING="missing", ERROR="error",
)
persistence_mock.set_session_provenance = AsyncMock(return_value="claimed")
persistence_mock.resolve_worker_context = AsyncMock(return_value="context_not_found")
sys.modules["persistence"] = persistence_mock

prompting_mock = types.ModuleType("prompting")
prompting_mock.build_prompt_context = MagicMock(return_value=("s", "o"))
prompting_mock.collect_prompt_metadata = MagicMock(return_value={})
prompting_mock.opening_line = MagicMock(return_value="opening text")
prompting_mock.system_prompt = MagicMock(return_value="system text")
sys.modules["prompting"] = prompting_mock

# Load agent.py under a unique module name: completely isolated from the
# `sys.modules["agent"]` binding used by tests/test_agent.py.
_AGENT_MODULE_NAME = "agent_phase8_l3_instrumentation"
_spec = importlib.util.spec_from_file_location(
    _AGENT_MODULE_NAME, os.path.join(_LIVEKIT_DIR, "agent.py")
)
agent_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
sys.modules[_AGENT_MODULE_NAME] = agent_mod
_spec.loader.exec_module(agent_mod)  # type: ignore[union-attr]

if _orig_persistence is not None:
    sys.modules["persistence"] = _orig_persistence
else:
    sys.modules.pop("persistence", None)
if _orig_prompting is not None:
    sys.modules["prompting"] = _orig_prompting
else:
    sys.modules.pop("prompting", None)

# Real observability (shared with the other test files).
from observability import (  # noqa: E402
    TestMetricSink,
    TestTracer,
    set_metric_sink,
    set_tracer,
)

# ---------------------------------------------------------------------------
# Deterministic clock seam
# ---------------------------------------------------------------------------


class FakeMonotonic:
    """Step-based monotonic clock: every call advances by ``step`` seconds.

    Deltas between any two calls therefore depend only on the number of calls
    between them — fully deterministic, no sleeps.
    """

    def __init__(self, start: float = 1000.0, step: float = 1.0) -> None:
        self._t = start
        self.step = step

    def __call__(self) -> float:
        v = self._t
        self._t += self.step
        return v


# ---------------------------------------------------------------------------
# Persistence mock helpers
# ---------------------------------------------------------------------------

SESSION_ID = "550e8400-e29b-41d4-a716-446655440000"
CORRELATION_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


def _ok_outcome() -> SimpleNamespace:
    return SimpleNamespace(ok=True, conflict=False, kind="success")


def _not_ok_outcome(kind: str = "error") -> SimpleNamespace:
    return SimpleNamespace(ok=False, conflict=False, kind=kind)


async def _drain_all(tasks: set, timeout_sec: float = 10.0) -> bool:
    """Mirror the real drain: await every pending write task."""
    if not tasks:
        return True
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return not any(isinstance(r, BaseException) for r in results)


async def _drain_false(tasks: set, timeout_sec: float = 10.0) -> bool:
    return False


def _configure_persistence(**overrides: Any) -> None:
    defaults: dict[str, Any] = {
        "set_session_provenance": AsyncMock(return_value="claimed"),
        "resolve_worker_context": AsyncMock(return_value="context_not_found"),
        "activate_session": AsyncMock(return_value=_ok_outcome()),
        "save_turn": AsyncMock(),
        "drain_pending_writes": AsyncMock(side_effect=_drain_all),
        "fail_session": AsyncMock(return_value=_ok_outcome()),
        "complete_session": AsyncMock(return_value=_ok_outcome()),
        "trigger_scoring": AsyncMock(),
    }
    defaults.update(overrides)
    for name, value in defaults.items():
        setattr(persistence_mock, name, value)


def _meta_with_session() -> dict[str, str]:
    return {
        "session_id": SESSION_ID,
        "sessionId": SESSION_ID,
        "correlation_id": CORRELATION_ID,
        "room_name": "room-livekit-e2e",
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class FakeCloseReason:
    def __init__(self, name: str):
        self.name = name


class FakeCloseEvent:
    def __init__(self, error=None, reason=None):
        self.error = error
        self.reason = reason


def _item(role: str, text: str, interrupted: bool = False) -> SimpleNamespace:
    item = SimpleNamespace(
        role=role, interrupted=interrupted, content=[SimpleNamespace(text=text)]
    )
    # SDK conversation_item_added events carry the item under ``.item``.
    return SimpleNamespace(item=item)


def _run_entrypoint(close_event: Any = None, items: tuple = ()) -> Any:
    """Run entrypoint to completion with the given close event and turns.

    Deterministic: no sleeps — the fake session fires events synchronously
    inside start()/generate_reply() and the finalizer drains write tasks via
    the mocked drain (which actually awaits them).
    """
    FakeAgentSession.reset()
    FakeAgentSession.CONFIG["conversation_events"] = list(items)
    FakeAgentSession.CONFIG["auto_close_event"] = close_event
    ctx = agent_mod.JobContext()
    asyncio.run(agent_mod.entrypoint(ctx))
    return ctx


# ---------------------------------------------------------------------------
# Bounded outcome mapping
# ---------------------------------------------------------------------------


class TestBoundedOutcomeMapping(unittest.TestCase):
    def test_fixed_allowlist(self) -> None:
        self.assertEqual(agent_mod._bounded_outcome(None), "conversation_complete")
        self.assertEqual(agent_mod._bounded_outcome("worker_crash"), "worker_crash")
        self.assertEqual(agent_mod._bounded_outcome("shutdown_forced"), "shutdown_forced")
        self.assertEqual(agent_mod._bounded_outcome("provider_error"), "provider_error")

    def test_unknown_values_map_to_other_failure(self) -> None:
        for raw in ("bogus", "", "recruiter_cancelled", "drain_timeout", "some_unknown_xyz"):
            with self.subTest(raw=raw):
                self.assertEqual(agent_mod._bounded_outcome(raw), "other_failure")

    def test_allowlist_is_exactly_four_plus_bucket(self) -> None:
        values = set(agent_mod._SESSION_OUTCOME_ALLOWLIST.values())
        self.assertEqual(values, {"conversation_complete", "worker_crash", "shutdown_forced", "provider_error"})


# ---------------------------------------------------------------------------
# Happy path: all five boundaries + bounded counter
# ---------------------------------------------------------------------------


class TestHappyPathInstrumentation(unittest.TestCase):
    def setUp(self) -> None:
        _configure_persistence()
        self.sink = TestMetricSink()
        self.tracer = TestTracer()
        set_metric_sink(self.sink)
        set_tracer(self.tracer)
        self._orig_monotonic = agent_mod._monotonic
        agent_mod._monotonic = FakeMonotonic(step=1.0)

    def tearDown(self) -> None:
        agent_mod._monotonic = self._orig_monotonic
        set_metric_sink(None)
        set_tracer(None)
        FakeAgentSession.reset()

    def test_truthful_span_structure(self) -> None:
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        names = [s.name for s in self.tracer.spans]
        # Parent session span plus the four child boundaries.
        self.assertIn("voice_session", names)
        for expected in ("session_setup", "session_generate_reply", "session_finalize"):
            self.assertIn(expected, names)
        session_span = next(s for s in self.tracer.spans if s.name == "voice_session")
        for child in (s for s in self.tracer.spans if s.name != "voice_session"):
            self.assertEqual(child.parent_span_id, session_span.span_id)
        # Every span ended (happy path).
        for s in self.tracer.spans:
            self.assertTrue(s.is_ended)

    def test_truthful_metric_names(self) -> None:
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        hist_names = {h["name"] for h in self.sink.histograms}
        self.assertEqual(
            hist_names,
            {
                "session_setup_duration_sec",
                "session_generate_reply_duration_sec",
                "session_finalize_duration_sec",
                "session_duration_sec",
                "session_turn_persistence_duration_sec",
            },
        )
        # Naming is truthful: nothing implies "first audio" or component
        # STT/LLM/TTS latency.
        joined = " ".join(hist_names | {c["name"] for c in self.sink.counters}).lower()
        self.assertNotIn("audio", joined)
        self.assertNotIn("stt", joined)
        self.assertNotIn("tts", joined)
        self.assertNotIn("llm", joined)

    def test_deterministic_clock_seam(self) -> None:
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        setup = next(h for h in self.sink.histograms if h["name"] == "session_setup_duration_sec")
        generate = next(h for h in self.sink.histograms if h["name"] == "session_generate_reply_duration_sec")
        finalize = next(h for h in self.sink.histograms if h["name"] == "session_finalize_duration_sec")
        # With a 1s-step fake clock each section is exactly its call-distance
        # apart: setup/generate are direct boundaries; finalize also drains the
        # explicit opener transcript write before terminal CAS/scoring.
        self.assertEqual(setup["value"], 1.0)
        self.assertEqual(generate["value"], 1.0)
        self.assertEqual(finalize["value"], 4.0)
        for h in self.sink.histograms:
            self.assertIsInstance(h["value"], float)
            self.assertGreaterEqual(h["value"], 0.0)

    def test_session_duration_matches_persisted_duration(self) -> None:
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        duration_call = persistence_mock.complete_session.await_args.args[1]
        hist = next(h for h in self.sink.histograms if h["name"] == "session_duration_sec")
        self.assertEqual(hist["value"], float(duration_call))
        self.assertGreaterEqual(hist["value"], 0.0)

    def test_bounded_outcome_counter_on_completion(self) -> None:
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        self.assertEqual(len(self.sink.counters), 1)
        counter = self.sink.counters[0]
        self.assertEqual(counter["name"], "session_outcome_total")
        self.assertEqual(counter["value"], 1.0)
        self.assertEqual(counter["labels"], {"outcome": "conversation_complete"})
        # Finalize span carries the same bounded outcome attribute.
        finalize_span = next(s for s in self.tracer.spans if s.name == "session_finalize")
        self.assertEqual(finalize_span.attributes.get("outcome"), "conversation_complete")

    def test_lifecycle_order_scoring_after_success(self) -> None:
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        # Exactly-once terminal transition + scoring only after successful CAS.
        persistence_mock.complete_session.assert_awaited_once()
        persistence_mock.trigger_scoring.assert_awaited_once()
        persistence_mock.fail_session.assert_not_awaited()
        # Writes drained exactly once, before the terminal CAS.
        self.assertTrue(persistence_mock.drain_pending_writes.called)


# ---------------------------------------------------------------------------
# Turn persistence boundary
# ---------------------------------------------------------------------------


class TestTurnPersistenceInstrumented(unittest.TestCase):
    def setUp(self) -> None:
        _configure_persistence()
        self.sink = TestMetricSink()
        self.tracer = TestTracer()
        set_metric_sink(self.sink)
        set_tracer(self.tracer)
        self._orig_monotonic = agent_mod._monotonic
        agent_mod._monotonic = FakeMonotonic(step=1.0)

    def tearDown(self) -> None:
        agent_mod._monotonic = self._orig_monotonic
        set_metric_sink(None)
        set_tracer(None)
        FakeAgentSession.reset()

    def test_turn_persistence_spans_and_histograms(self) -> None:
        items = (_item("assistant", "Hi there"), _item("user", "Hello!"))
        _run_entrypoint(
            close_event=FakeCloseEvent(reason=FakeCloseReason("completed")),
            items=items,
        )
        turn_spans = [s for s in self.tracer.spans if s.name == "turn_persistence"]
        self.assertEqual(len(turn_spans), 3)
        session_span = next(s for s in self.tracer.spans if s.name == "voice_session")
        for span in turn_spans:
            self.assertTrue(span.is_ended)
            self.assertEqual(span.parent_span_id, session_span.span_id)
            self.assertIn(span.attributes.get("speaker"), {"bot", "candidate"})

        histograms = [h for h in self.sink.histograms if h["name"] == "session_turn_persistence_duration_sec"]
        self.assertEqual(len(histograms), 3)
        speakers = {h["labels"]["speaker"] for h in histograms}
        self.assertEqual(speakers, {"bot", "candidate"})
        for h in histograms:
            self.assertGreaterEqual(h["value"], 0.0)

        # Explicit opener plus both conversation items persisted.
        self.assertEqual(persistence_mock.save_turn.await_count, 3)

    def test_empty_text_turn_is_not_instrumented(self) -> None:
        items = (_item("assistant", "   "), _item("user", ""))
        _run_entrypoint(
            close_event=FakeCloseEvent(reason=FakeCloseReason("completed")),
            items=items,
        )
        turn_spans = [s for s in self.tracer.spans if s.name == "turn_persistence"]
        self.assertEqual(len(turn_spans), 1)
        self.assertEqual(turn_spans[0].attributes.get("speaker"), "bot")
        turn_hists = [h for h in self.sink.histograms if h["name"] == "session_turn_persistence_duration_sec"]
        self.assertEqual(len(turn_hists), 1)
        self.assertEqual(turn_hists[0]["labels"], {"speaker": "bot"})
        persistence_mock.save_turn.assert_awaited_once()


# ---------------------------------------------------------------------------
# Bounded outcome counter across terminal paths
# ---------------------------------------------------------------------------


class TestOutcomeCounterPaths(unittest.TestCase):
    def setUp(self) -> None:
        self.sink = TestMetricSink()
        self.tracer = TestTracer()
        set_metric_sink(self.sink)
        set_tracer(self.tracer)
        self._orig_monotonic = agent_mod._monotonic
        agent_mod._monotonic = FakeMonotonic(step=1.0)

    def tearDown(self) -> None:
        agent_mod._monotonic = self._orig_monotonic
        set_metric_sink(None)
        set_tracer(None)
        FakeAgentSession.reset()

    def _captured_outcome(self) -> str:
        self.assertEqual(len(self.sink.counters), 1)
        return self.sink.counters[0]["labels"]["outcome"]

    def test_provider_error_close_reason(self) -> None:
        _configure_persistence()
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("provider_error")))
        self.assertEqual(self._captured_outcome(), "provider_error")
        self.assertEqual(persistence_mock.fail_session.await_args.args, (None, "provider_error"))

    def test_unknown_close_reason_fails_closed_to_bounded(self) -> None:
        _configure_persistence()
        raw = "some_unknown_xyz"
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason(raw)))
        # Unknown close reason fails closed to worker_crash (classifier), which
        # is itself mapped through the fixed allowlist.
        self.assertEqual(self._captured_outcome(), "worker_crash")
        # Negative control: the raw reason never appears anywhere.
        self._assert_no_leak(raw)

    def test_unknown_close_error_completes_normally(self) -> None:
        _configure_persistence()
        _run_entrypoint(close_event=FakeCloseEvent(error=ValueError("sdk cleanup error")))
        self.assertEqual(self._captured_outcome(), "conversation_complete")
        persistence_mock.complete_session.assert_awaited_once()
        persistence_mock.trigger_scoring.assert_awaited_once()
        persistence_mock.fail_session.assert_not_awaited()

    def test_drain_timeout_maps_to_shutdown_forced(self) -> None:
        _configure_persistence(drain_pending_writes=_drain_false)
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        self.assertEqual(self._captured_outcome(), "shutdown_forced")
        self.assertEqual(persistence_mock.fail_session.await_args.args, (None, "shutdown_forced"))

    def test_start_exception_maps_to_worker_crash(self) -> None:
        _configure_persistence()
        FakeAgentSession.reset()
        FakeAgentSession.CONFIG["start_exc"] = RuntimeError("provider start boom")
        ctx = agent_mod.JobContext()
        asyncio.run(agent_mod.entrypoint(ctx))
        self.assertEqual(self._captured_outcome(), "worker_crash")
        self.assertEqual(persistence_mock.fail_session.await_args.args, (None, "worker_crash"))
        persistence_mock.complete_session.assert_not_awaited()
        persistence_mock.trigger_scoring.assert_not_awaited()
        # The setup span ended with the provider error recorded.
        setup_span = next(s for s in self.tracer.spans if s.name == "session_setup")
        self.assertTrue(setup_span.is_ended)
        self.assertIsInstance(setup_span.error, RuntimeError)
        # Parent session span still ended (exception paths end spans).
        session_span = next(s for s in self.tracer.spans if s.name == "voice_session")
        self.assertTrue(session_span.is_ended)

    def test_explicit_shutdown_close_reason(self) -> None:
        _configure_persistence()
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("shutdown")))
        self.assertEqual(self._captured_outcome(), "shutdown_forced")

    def _assert_no_leak(self, needle: str) -> None:
        haystack = " ".join(
            [str(h["name"]) for h in self.sink.histograms]
            + [str(c["name"]) for c in self.sink.counters]
            + [str(c["name"]) for c in self.sink.gauges]
            + [
                str(v)
                for rec in self.sink.histograms + self.sink.counters + self.sink.gauges
                for k, v in (rec.get("labels") or {}).items()
            ]
            + [
                str(v)
                for s in self.tracer.spans
                for v in ([s.name] + list(s.attributes.keys()) + list(s.attributes.values())
                          + [e["name"] for e in s.events]
                          + [str(a) for e in s.events for a in (e.get("attrs") or {}).values()])
            ]
        )
        self.assertNotIn(needle, haystack)


# ---------------------------------------------------------------------------
# Negative controls: PII / identity never leaks
# ---------------------------------------------------------------------------


class TestNoSensitiveLeak(unittest.TestCase):
    def setUp(self) -> None:
        _configure_persistence(resolve_worker_context=AsyncMock(
            return_value=persistence_mock.WorkerContext()
        ))
        prompting_mock.collect_prompt_metadata = MagicMock(return_value=_meta_with_session())
        self.sink = TestMetricSink()
        self.tracer = TestTracer()
        set_metric_sink(self.sink)
        set_tracer(self.tracer)
        self._orig_monotonic = agent_mod._monotonic
        agent_mod._monotonic = FakeMonotonic(step=1.0)

    def tearDown(self) -> None:
        agent_mod._monotonic = self._orig_monotonic
        prompting_mock.collect_prompt_metadata = MagicMock(return_value={})
        set_metric_sink(None)
        set_tracer(None)
        FakeAgentSession.reset()

    def test_no_session_room_transcript_or_reason_leak(self) -> None:
        secret_text = "my_secret_answer_42_with_pii"
        _run_entrypoint(
            close_event=FakeCloseEvent(reason=FakeCloseReason("completed")),
            items=(_item("candidate", secret_text),),
        )
        needles = [SESSION_ID, CORRELATION_ID, "room-livekit-e2e", secret_text]
        for needle in needles:
            self._assert_never_present(needle)

    def test_counter_labels_always_bounded(self) -> None:
        allowed = {"conversation_complete", "worker_crash", "shutdown_forced", "provider_error", "other_failure"}
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        for c in self.sink.counters:
            self.assertIn(c["labels"]["outcome"], allowed)

    def _assert_never_present(self, needle: str) -> None:
        haystack = " ".join(
            [str(h["name"]) for h in self.sink.histograms]
            + [str(c["name"]) for c in self.sink.counters]
            + [str(c["name"]) for c in self.sink.gauges]
            + [
                str(v)
                for rec in self.sink.histograms + self.sink.counters + self.sink.gauges
                for k, v in (rec.get("labels") or {}).items()
            ]
            + [
                str(v)
                for s in self.tracer.spans
                for v in ([s.name] + list(s.attributes.keys()) + list(s.attributes.values())
                          + [e["name"] for e in s.events]
                          + [str(a) for e in s.events for a in (e.get("attrs") or {}).values()])
            ]
        )
        self.assertNotIn(needle, haystack)


# ---------------------------------------------------------------------------
# Lifecycle invariants: exactly-once finalizer, CAS checked before metrics
# ---------------------------------------------------------------------------


class TestLifecyclePreserved(unittest.TestCase):
    def setUp(self) -> None:
        self.sink = TestMetricSink()
        self.tracer = TestTracer()
        set_metric_sink(self.sink)
        set_tracer(self.tracer)
        self._orig_monotonic = agent_mod._monotonic
        agent_mod._monotonic = FakeMonotonic(step=1.0)

    def tearDown(self) -> None:
        agent_mod._monotonic = self._orig_monotonic
        set_metric_sink(None)
        set_tracer(None)
        FakeAgentSession.reset()

    def test_cas_failure_raises_and_emits_nothing(self) -> None:
        _configure_persistence(fail_session=AsyncMock(return_value=_not_ok_outcome()))
        with self.assertRaises(agent_mod.LifecycleError):
            _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("worker_crash")))
        # Exactly-once finalizer: fail_session awaited once, never retried.
        persistence_mock.fail_session.assert_awaited_once()
        # No metrics after a failed CAS (CAS outcome checked first): the
        # finalize span emitted neither outcome counter nor duration metrics.
        self.assertEqual(self.sink.counters, [])
        finalize_names = {h["name"] for h in self.sink.histograms if h["name"] in (
            "session_finalize_duration_sec", "session_duration_sec")}
        self.assertEqual(finalize_names, set())
        # Spans still end on the exception path.
        finalize_span = next(s for s in self.tracer.spans if s.name == "session_finalize")
        self.assertTrue(finalize_span.is_ended)
        self.assertIsInstance(finalize_span.error, agent_mod.LifecycleError)
        session_span = next(s for s in self.tracer.spans if s.name == "voice_session")
        self.assertTrue(session_span.is_ended)
        # Scoring never ran without a successful completion CAS.
        persistence_mock.complete_session.assert_not_awaited()
        persistence_mock.trigger_scoring.assert_not_awaited()

    def test_completion_cas_failure_skips_scoring(self) -> None:
        _configure_persistence(complete_session=AsyncMock(return_value=_not_ok_outcome()))
        with self.assertRaises(agent_mod.LifecycleError):
            _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        persistence_mock.complete_session.assert_awaited_once()
        persistence_mock.trigger_scoring.assert_not_awaited()
        self.assertEqual(self.sink.counters, [])
        finalize_names = {h["name"] for h in self.sink.histograms if h["name"] in (
            "session_finalize_duration_sec", "session_duration_sec")}
        self.assertEqual(finalize_names, set())
        session_span = next(s for s in self.tracer.spans if s.name == "voice_session")
        self.assertTrue(session_span.is_ended)

    def test_activation_conflict_not_instrumented(self) -> None:
        _configure_persistence(activate_session=AsyncMock(return_value=_not_ok_outcome("conflict")))
        ctx = agent_mod.JobContext()
        asyncio.run(agent_mod.entrypoint(ctx))
        # Session never started → no spans, no metrics.
        self.assertEqual(self.tracer.spans, [])
        self.assertEqual(self.sink.histograms, [])
        self.assertEqual(self.sink.counters, [])


# ---------------------------------------------------------------------------
# Instrumentation failure isolation
# ---------------------------------------------------------------------------


class RaisingSink:
    def counter(self, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("sink broken")

    def gauge(self, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("sink broken")

    def histogram(self, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("sink broken")


class RaisingTracer:
    def start_span(self, name: str, parent: Any = None) -> Any:
        raise RuntimeError("tracer broken")


class TestInstrumentationFailureIsolation(unittest.TestCase):
    def setUp(self) -> None:
        _configure_persistence()
        self._orig_monotonic = agent_mod._monotonic
        agent_mod._monotonic = FakeMonotonic(step=1.0)

    def tearDown(self) -> None:
        agent_mod._monotonic = self._orig_monotonic
        set_metric_sink(None)
        set_tracer(None)
        FakeAgentSession.reset()

    def test_raising_metric_sink_does_not_alter_flow(self) -> None:
        set_metric_sink(RaisingSink())
        set_tracer(TestTracer())
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        # Business flow fully completed despite a broken sink.
        persistence_mock.complete_session.assert_awaited_once()
        persistence_mock.trigger_scoring.assert_awaited_once()
        persistence_mock.fail_session.assert_not_awaited()

    def test_raising_tracer_does_not_alter_flow(self) -> None:
        set_tracer(RaisingTracer())
        set_metric_sink(TestMetricSink())
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        # Guarded span start: business body still runs when the tracer is broken.
        persistence_mock.complete_session.assert_awaited_once()
        persistence_mock.trigger_scoring.assert_awaited_once()

    def test_default_noop_sink_tracer_flow_unaffected(self) -> None:
        # Explicitly reset to the production no-ops.
        set_metric_sink(None)
        set_tracer(None)
        _run_entrypoint(close_event=FakeCloseEvent(reason=FakeCloseReason("completed")))
        persistence_mock.complete_session.assert_awaited_once()
        persistence_mock.trigger_scoring.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
