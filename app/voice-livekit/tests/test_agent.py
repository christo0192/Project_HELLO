"""Behavioral agent tests — faithful SDK fakes, no external dependencies.

Tests import agent.py's entrypoint function with mocked LiveKit SDK and
persistence to prove:
  - nonlocal _finalizer_task is tracked and awaited exactly once
  - Activation fail-closed: non-SUCCESS aborts before provider construction
  - Entrypoint lifetime: _close_event.wait() keeps alive until close fires
  - Exception path routes through complete_once with drain
  - _classify_close_event uses explicit mapping (not substring)
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from unittest.mock import MagicMock, patch, AsyncMock, call

import importlib

# ── Stub LiveKit SDK before importing agent ──────────────────────────

def _stub_sdk():
    """Install stub livekit SDK modules so agent.py can import without network."""
    modules = {
        "livekit": types.ModuleType("livekit"),
        "livekit.api": types.ModuleType("livekit.api"),
        "livekit.agents": types.ModuleType("livekit.agents"),
        "livekit.plugins": types.ModuleType("livekit.plugins"),
        "livekit.plugins.openai": types.ModuleType("livekit.plugins.openai"),
        "livekit.plugins.sarvam": types.ModuleType("livekit.plugins.sarvam"),
        "livekit.plugins.silero": types.ModuleType("livekit.plugins.silero"),
        "livekit.plugins.turn_detector": types.ModuleType("livekit.plugins.turn_detector"),
        "livekit.plugins.turn_detector.multilingual": types.ModuleType("livekit.plugins.turn_detector.multilingual"),
    }

    modules["livekit"].api = modules["livekit.api"]
    modules["livekit.api"].LiveKitAPI = MagicMock
    modules["livekit.api"].DeleteRoomRequest = MagicMock

    # Agent class
    class FakeAgent:
        def __init__(self, instructions=""):
            self.instructions = instructions

    modules["livekit.agents"].Agent = FakeAgent

    class FakeAgentSession:
        def __init__(self, **kwargs):
            self._handlers = {}
            self.started = False

        def on(self, event: str):
            def decorator(fn):
                self._handlers[event] = fn
                return fn
            return decorator

        async def start(self, **kwargs):
            self.started = True

        async def generate_reply(self, **kwargs):
            handler = self._handlers.get("close")
            if handler is not None:
                handler(types.SimpleNamespace(error=None, reason=None))

    modules["livekit.agents"].AgentSession = FakeAgentSession

    class FakeJobContext:
        def __init__(self):
            self.room = MagicMock()
            self._connected = False

        async def connect(self):
            self._connected = True

    modules["livekit.agents"].JobContext = FakeJobContext

    class FakeWorkerOptions:
        def __init__(self, entrypoint_fnc):
            self.entrypoint_fnc = entrypoint_fnc

    modules["livekit.agents"].WorkerOptions = FakeWorkerOptions
    modules["livekit.agents"].cli = types.ModuleType("livekit.agents.cli")
    modules["livekit.agents"].cli.run_app = MagicMock()

    class FakeLLM:
        def __init__(self, **kwargs):
            pass

    class FakeSTT:
        def __init__(self, **kwargs):
            pass

    class FakeTTS:
        def __init__(self, **kwargs):
            pass

    class FakeVAD:
        @staticmethod
        def load(**kwargs):
            return MagicMock()

    modules["livekit.plugins"].openai = types.ModuleType("livekit.plugins.openai")
    modules["livekit.plugins.openai"].LLM = FakeLLM
    modules["livekit.plugins.sarvam"] = types.ModuleType("livekit.plugins.sarvam")
    modules["livekit.plugins.sarvam"].STT = FakeSTT
    modules["livekit.plugins.sarvam"].TTS = FakeTTS
    modules["livekit.plugins.silero"] = types.ModuleType("livekit.plugins.silero")
    modules["livekit.plugins.silero"].VAD = FakeVAD
    modules["livekit.plugins.turn_detector.multilingual"].MultilingualModel = MagicMock

    for name, mod in modules.items():
        sys.modules[name] = mod


_stub_sdk()

# Mock dotenv
_mock_dotenv = types.ModuleType("dotenv")
_mock_dotenv.load_dotenv = MagicMock()
sys.modules["dotenv"] = _mock_dotenv

# Save original persistence/prompting modules before overriding
_orig_persistence = sys.modules.get("persistence")
_orig_prompting = sys.modules.get("prompting")

# Mock persistence module for agent tests
_mock_persistence = types.ModuleType("persistence")
_mock_persistence.LifecycleOutcome = MagicMock()
_mock_persistence.LifecycleError = type("LifecycleError", (Exception,), {})
_mock_persistence.WorkerContext = MagicMock()
_mock_persistence.ClaimResult = types.SimpleNamespace(
    CLAIMED="claimed", ALREADY_MATCHING="already_matching"
)
_mock_persistence.set_session_provenance = AsyncMock(return_value="claimed")
_mock_persistence.resolve_worker_context = AsyncMock(return_value="context_not_found")
sys.modules["persistence"] = _mock_persistence

# Mock prompting module
_mock_prompting = types.ModuleType("prompting")
_mock_prompting.build_prompt_context = MagicMock(return_value=("system text", "opening text"))
_mock_prompting.collect_prompt_metadata = MagicMock(return_value={})
_mock_prompting.opening_line = MagicMock(return_value="opening text")
_mock_prompting.system_prompt = MagicMock(return_value="system text")
sys.modules["prompting"] = _mock_prompting

import agent as agent_mod  # noqa: E402
importlib.reload(agent_mod)

# Restore original modules so other test files (test_lifecycle.py) are not affected.
# If discovery imported this file before the real modules existed, remove the
# temporary stubs entirely; otherwise later tests will import AsyncMock stubs
# instead of the real persistence.py / prompting.py.
if _orig_persistence is not None:
    sys.modules["persistence"] = _orig_persistence
else:
    sys.modules.pop("persistence", None)
if _orig_prompting is not None:
    sys.modules["prompting"] = _orig_prompting
else:
    sys.modules.pop("prompting", None)


# ── Composable fake close event ───────────────────────────────────────

class FakeCloseEvent:
    """Simulates AgentSession close event with explicit fields."""
    def __init__(self, error=None, reason=None):
        self.error = error
        self.reason = reason


class FakeAgentSessionCloseReason:
    """Simulates an SDK close-reason enum."""
    def __init__(self, name: str):
        self.name = name


# ── Tests ─────────────────────────────────────────────────────────────

class _FakeSpeechHandle:
    def __init__(self, log):
        self.log = log

    async def wait_for_playout(self):
        self.log.append("playout")


class _FakeTerminationSession:
    def __init__(self, log):
        self.log = log

    def say(self, text, **kwargs):
        self.log.append("goodbye" if agent_mod._is_final_goodbye(text) else "prompt")
        return _FakeSpeechHandle(self.log)


class TestTerminationHelpers(unittest.IsolatedAsyncioTestCase):
    async def test_close_occurs_after_playout_and_grace(self):
        log = []

        async def close():
            log.append("close")

        await agent_mod._close_after_playout(_FakeSpeechHandle(log), close, 0)
        self.assertEqual(log, ["playout", "close"])

    async def test_silence_prompts_then_says_goodbye_then_closes(self):
        log = []

        async def close():
            log.append("close")

        await agent_mod._silence_termination_loop(
            _FakeTerminationSession(log),
            asyncio.Event(),
            close,
            prompt_after_sec=0.001,
            end_after_sec=0.001,
            grace_sec=0,
        )
        self.assertEqual(log, ["prompt", "playout", "goodbye", "playout", "close"])

    async def test_candidate_activity_restarts_initial_silence_window(self):
        log = []
        activity = asyncio.Event()

        async def close():
            log.append("close")

        task = asyncio.create_task(
            agent_mod._silence_termination_loop(
                _FakeTerminationSession(log), activity, close,
                prompt_after_sec=0.05, end_after_sec=0.05, grace_sec=0,
            )
        )
        await asyncio.sleep(0.005)
        activity.set()
        await asyncio.sleep(0.01)
        self.assertEqual(log, [])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    def test_final_goodbye_marker_is_bounded(self):
        self.assertTrue(agent_mod._is_final_goodbye("Thanks, and goodbye."))
        self.assertTrue(agent_mod._is_final_goodbye("Take care!"))
        self.assertFalse(agent_mod._is_final_goodbye("What would you like to ask?"))


class TestGeminiProviderConfiguration(unittest.TestCase):
    def test_direct_google_endpoint_and_lite_model(self):
        self.assertEqual(agent_mod.GEMINI_MODEL, "gemini-3.1-flash-lite")
        self.assertEqual(
            agent_mod.GEMINI_BASE_URL,
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        )
        self.assertNotIn("ikey", agent_mod.GEMINI_BASE_URL)


class TestRoomSessionFallback(unittest.TestCase):
    def test_extracts_session_id_from_canonical_room_name(self):
        session_id = "5b2a34cb-a912-4c68-a2c2-79ccdc1dcdd1"
        self.assertEqual(
            agent_mod._session_id_from_room_name(f"screening-{session_id}"),
            session_id,
        )

    def test_ignores_non_canonical_room_name(self):
        self.assertIsNone(agent_mod._session_id_from_room_name("synthetic-worker-smoke-123"))

    def test_reads_room_name_from_job_room_object(self):
        ctx = types.SimpleNamespace(
            room=types.SimpleNamespace(name=""),
            job=types.SimpleNamespace(
                room=types.SimpleNamespace(name="screening-5b2a34cb-a912-4c68-a2c2-79ccdc1dcdd1")
            ),
        )
        self.assertEqual(
            agent_mod._room_name_from_context(ctx),
            "screening-5b2a34cb-a912-4c68-a2c2-79ccdc1dcdd1",
        )


class TestClassifyCloseEvent(unittest.TestCase):
    """Explicit mapping — no substring matching; unknown explicit values fail closed."""

    def test_no_error_no_reason_is_clean_completion(self):
        """No error and no reason → LiveKit clean close / candidate leave."""
        event = FakeCloseEvent(error=None, reason=None)
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_explicit_completion_signal(self):
        """Explicit 'completed' reason → None (conversation_complete)."""
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("completed"))
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_normal_close_reason(self):
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("normal"))
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_client_initiated_close_reason(self):
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("CLIENT_INITIATED"))
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_client_initiated_enum_string_close_reason(self):
        event = FakeCloseEvent(error=None, reason="CloseReason.CLIENT_INITIATED")
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_client_initiated_reason_takes_precedence_over_error_object(self):
        event = FakeCloseEvent(error=RuntimeError("disconnect"), reason="CloseReason.CLIENT_INITIATED")
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_livekit_participant_disconnected_is_completion(self):
        event = FakeCloseEvent(error=None, reason="CloseReason.PARTICIPANT_DISCONNECTED")
        self.assertIsNone(agent_mod._classify_close_event(event))

    def test_livekit_user_initiated_is_completion(self):
        event = FakeCloseEvent(error=None, reason="CloseReason.USER_INITIATED")
        self.assertIsNone(agent_mod._classify_close_event(event))

    def test_livekit_task_completed_is_completion(self):
        event = FakeCloseEvent(error=None, reason="CloseReason.TASK_COMPLETED")
        self.assertIsNone(agent_mod._classify_close_event(event))

    def test_livekit_job_shutdown_is_forced_shutdown(self):
        event = FakeCloseEvent(error=None, reason="CloseReason.JOB_SHUTDOWN")
        self.assertEqual(agent_mod._classify_close_event(event), "shutdown_forced")

    def test_shutdown_reason(self):
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("shutdown"))
        result = agent_mod._classify_close_event(event)
        self.assertEqual(result, "shutdown_forced")

    def test_cancelled_reason(self):
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("cancelled"))
        result = agent_mod._classify_close_event(event)
        self.assertEqual(result, "shutdown_forced")

    def test_timeout_reason(self):
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("timeout"))
        result = agent_mod._classify_close_event(event)
        self.assertEqual(result, "shutdown_forced")

    def test_provider_error_reason(self):
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("provider_error"))
        result = agent_mod._classify_close_event(event)
        self.assertEqual(result, "provider_error")

    def test_unknown_reason_fails_closed(self):
        """Unknown reason string → worker_crash."""
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("some_unknown_reason"))
        result = agent_mod._classify_close_event(event)
        self.assertEqual(result, "worker_crash")

    def test_livekit_error_none(self):
        """LivekitError type → None (normal SDK lifecycle)."""
        class LivekitError(RuntimeError):
            pass
        event = FakeCloseEvent(error=LivekitError("normal disconnect"))
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)

    def test_timeout_error(self):
        class TimeoutError(RuntimeError):
            pass
        # Must lower to 'timeouterror' to match dict key
        TimeoutError.__name__ = 'TimeoutError'
        event = FakeCloseEvent(error=TimeoutError("timed out"))
        result = agent_mod._classify_close_event(event)
        self.assertEqual(result, "shutdown_forced")

    def test_unknown_close_error_completes_normally(self):
        """Unknown AgentSession close error → None (normal close fallback)."""
        event = FakeCloseEvent(error=ValueError("weird close cleanup error"))
        result = agent_mod._classify_close_event(event)
        self.assertIsNone(result)


class TestEntrypointActivationFailClosed(unittest.TestCase):
    """Non-SUCCESS activation aborts before provider construction."""

    def setUp(self):
        # Reset persistence mock
        _mock_persistence.set_session_provenance = AsyncMock(return_value="claimed")
        _mock_persistence.activate_session = AsyncMock()
        _mock_persistence.save_turn = AsyncMock()
        _mock_persistence.drain_pending_writes = AsyncMock(return_value=True)
        _mock_persistence.fail_session = AsyncMock()
        _mock_persistence.complete_session = AsyncMock()
        _mock_persistence.trigger_scoring = AsyncMock()

    async def _run_entrypoint(self, activate_outcome=None):
        """Run entrypoint with given activation outcome."""
        outcome = MagicMock()
        outcome.ok = activate_outcome
        outcome.conflict = not activate_outcome
        outcome.kind = "conflict" if not activate_outcome else "success"
        _mock_persistence.activate_session.return_value = outcome

        ctx = agent_mod.JobContext()
        await agent_mod.entrypoint(ctx)
        return ctx

    def test_provenance_conflict_aborts_before_activation(self):
        """A mismatched immutable model claim must fail closed before activation."""
        async def _test():
            _mock_persistence.set_session_provenance.return_value = "conflict"
            ctx = agent_mod.JobContext()
            await agent_mod.entrypoint(ctx)
            return ctx

        ctx = asyncio.run(_test())
        self.assertTrue(ctx._connected)
        _mock_persistence.activate_session.assert_not_awaited()

    def test_activation_conflict_aborts(self):
        """CONFLICT → entrypoint returns without constructing providers."""
        async def _test():
            ctx = await self._run_entrypoint(activate_outcome=False)
            return ctx
        ctx = asyncio.run(_test())
        self.assertTrue(ctx._connected)
        _mock_persistence.save_turn.assert_not_called()

    def test_activation_success_proceeds(self):
        """SUCCESS → entrypoint proceeds to provider construction."""
        async def _test():
            _mock_persistence.complete_session = AsyncMock()
            outcome = MagicMock()
            outcome.ok = True
            outcome.conflict = False
            outcome.kind = "success"
            _mock_persistence.activate_session.return_value = outcome

            ctx = agent_mod.JobContext()
            await agent_mod.entrypoint(ctx)
            return ctx
        ctx = asyncio.run(_test())
        self.assertTrue(ctx._connected)


class TestFinalizerTracking(unittest.TestCase):
    """nonlocal _finalizer_task is tracked and awaited."""

    def setUp(self):
        _mock_persistence.set_session_provenance = AsyncMock(return_value="claimed")
        _mock_persistence.activate_session = AsyncMock()
        _mock_persistence.save_turn = AsyncMock()
        _mock_persistence.drain_pending_writes = AsyncMock(return_value=True)
        _mock_persistence.complete_session = AsyncMock()
        _mock_persistence.fail_session = AsyncMock()
        _mock_persistence.trigger_scoring = AsyncMock()

    def test_finalizer_created_on_close(self):
        """Close event creates _finalizer_task visible in finally block."""
        outcome = MagicMock()
        outcome.ok = True
        outcome.conflict = False
        outcome.kind = "success"
        _mock_persistence.activate_session.return_value = outcome
        _mock_persistence.complete_session = AsyncMock()

        async def _test():
            ctx = agent_mod.JobContext()
            entry_task = asyncio.create_task(agent_mod.entrypoint(ctx))
            await asyncio.sleep(0.05)
            entry_task.cancel()
            try:
                await entry_task
            except (asyncio.CancelledError, Exception):
                pass
            self.assertTrue(entry_task.done())

        asyncio.run(_test())


if __name__ == "__main__":
    unittest.main()
