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
# The real persistence module is imported first so the anchor normaliser
# (which agent._turn_anchor_ms calls through ``persistence.``) is bound to
# the mock with its real implementation.
import persistence as _real_persistence_module  # noqa: E402
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
_mock_persistence.normalize_turn_anchor_ms = _real_persistence_module.normalize_turn_anchor_ms
_mock_persistence.set_session_provenance = AsyncMock(return_value="claimed")
_mock_persistence.resolve_worker_context = AsyncMock(return_value="context_not_found")
sys.modules["persistence"] = _mock_persistence

# Mock prompting module
_mock_prompting = types.ModuleType("prompting")
_mock_prompting.build_prompt_context = MagicMock(return_value=("system text", "opening text"))
_mock_prompting.collect_prompt_metadata = MagicMock(return_value={})
_mock_prompting.opening_line = MagicMock(return_value="opening text")
_mock_prompting.system_prompt = MagicMock(return_value="system text")
# 0044: `agent` also imports `format_questions` to render the phone question
# plan through the SAME helper the browser prompt uses. A stub missing it
# turns an ImportError into a collection failure for three unrelated modules.
_mock_prompting.format_questions = MagicMock(return_value="1. question flow")
_mock_prompting.format_resume_facts = MagicMock(return_value="resume facts")
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

class TestTurnAnchorExtraction(unittest.TestCase):
    """_turn_anchor_ms: metrics.started_speaking_at primary, created_at fallback."""

    def _item(self, **attrs):
        return types.SimpleNamespace(**attrs)

    def test_primary_metrics_started_speaking_at_wins(self):
        item = self._item(
            role="user",
            content=[types.SimpleNamespace(text="hello")],
            metrics={"started_speaking_at": 1723000000.25, "stopped_speaking_at": 1723000008.5},
            created_at=1723000009.0,
        )
        self.assertEqual(agent_mod._turn_anchor_ms(item), 1723000000250)

    def test_fallback_created_at_when_metrics_missing(self):
        item = self._item(role="assistant", created_at=1723000005.75)
        self.assertEqual(agent_mod._turn_anchor_ms(item), 1723000005750)

    def test_fallback_created_at_when_metrics_not_a_mapping(self):
        for bad_metrics in (None, [1, 2], "nope", 42):
            with self.subTest(bad_metrics=bad_metrics):
                item = self._item(role="assistant", metrics=bad_metrics, created_at=1723000001.0)
                self.assertEqual(agent_mod._turn_anchor_ms(item), 1723000001000)

    def test_fallback_when_primary_present_but_invalid(self):
        # Primary exists but is bool / NaN / out-of-range → fall back to created_at.
        for bad_primary in (True, float("nan"), 0, -1, 4102444800.0):
            with self.subTest(bad_primary=bad_primary):
                item = self._item(
                    role="user",
                    metrics={"started_speaking_at": bad_primary},
                    created_at=1723000007.25,
                )
                self.assertEqual(agent_mod._turn_anchor_ms(item), 1723000007250)

    def test_metrics_mapping_missing_key_falls_back(self):
        item = self._item(role="assistant", metrics={}, created_at=1723000003.5)
        self.assertEqual(agent_mod._turn_anchor_ms(item), 1723000003500)

    def test_null_when_no_valid_anchor(self):
        for item in (self._item(role="assistant"), self._item(role="assistant", metrics={})):
            with self.subTest(item=item):
                self.assertIsNone(agent_mod._turn_anchor_ms(item))

    def test_null_when_both_anchors_invalid(self):
        item = self._item(
            role="user",
            metrics={"started_speaking_at": float("inf")},
            created_at=float("nan"),
        )
        self.assertIsNone(agent_mod._turn_anchor_ms(item))


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
    async def test_close_occurs_immediately_after_playout_without_grace_sleep(self):
        log = []

        async def close():
            log.append("close")

        with patch.object(agent_mod.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            await agent_mod._close_after_playout(_FakeSpeechHandle(log), close)

        self.assertEqual(log, ["playout", "close"])
        sleep.assert_not_awaited()

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
        )
        self.assertEqual(log, ["prompt", "playout", "goodbye", "playout", "close"])

    async def test_candidate_activity_restarts_initial_silence_window(self):
        """Activity inside the window restarts it, so no prompt fires.

        ── NO CLOCK, DELIBERATELY ────────────────────────────────────────
        This used to sleep 5 ms, set the event, sleep 10 ms and assert. Two
        things were wrong with it, and the second is worse than the first.

        It was FRAGILE: the assertion had to land inside the RESTARTED window,
        so a runner that stalled that 10 ms sleep past ~40 ms saw a legitimate
        prompt and failed. That is what it did in CI, and the mechanism is
        reproducible — injecting a 45 ms stall AFTER `set()` yields the same
        `['prompt', 'playout']` on both 3.12 and 3.14. (A stall BEFORE `set()`
        does not, because expired timers dispatch earliest-deadline-first, so
        the 5 ms sleep still wins. The vulnerable sleep was the assertion one.)

        It was also NON-DISCRIMINATING: the assertion at 15 ms sat *before* the
        original 50 ms deadline, so deleting the restart from the loop entirely
        left it green. Zero signal, non-zero noise.

        Widening the sleeps only moves the race. So the clock is gone from the
        decision instead: the seam reports "activity arrived" or "the window
        lapsed" directly, and the loop's BEHAVIOUR is asserted rather than its
        timing. The real `asyncio.wait_for` default stays covered by
        `test_silence_prompt_then_goodbye_then_close` above and by
        `test_the_PRODUCTION_wait_seam_answers_both_ways` below.
        """
        log = []
        activity = asyncio.Event()
        seen: list[tuple[bool, float]] = []

        async def close():
            log.append("close")

        async def wait_for_activity(event, timeout):
            # Record whether the loop CLEARED the event before waiting. That
            # clear is what makes the window restart rather than resolve
            # instantly on a stale set.
            seen.append((event.is_set(), timeout))
            if len(seen) == 1:
                return True                   # activity arrived in window one
            await asyncio.Event().wait()      # then hold, so the test can assert

        task = asyncio.create_task(
            agent_mod._silence_termination_loop(
                _FakeTerminationSession(log), activity, close,
                prompt_after_sec=0.5, end_after_sec=0.5,
                wait_for_activity=wait_for_activity,
            )
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        # Nothing was said: activity restarted the window instead.
        self.assertEqual(log, [])
        # The loop went back round and is waiting on the PROMPT window again,
        # having cleared the event before each wait.
        self.assertEqual(seen, [(False, 0.5), (False, 0.5)])

        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_CONTROL_a_lapsed_window_really_does_prompt(self):
        """Without this the test above would pass on a loop that never speaks.

        Same seam, opposite answer: the window lapses, so the prompt fires and
        then the goodbye and the close. Deterministic — no clock either.
        """
        log = []
        activity = asyncio.Event()

        async def close():
            log.append("close")

        async def always_lapsed(event, timeout):
            return False

        await agent_mod._silence_termination_loop(
            _FakeTerminationSession(log), activity, close,
            prompt_after_sec=0.5, end_after_sec=0.5,
            wait_for_activity=always_lapsed,
        )
        self.assertEqual(log, ["prompt", "playout", "goodbye", "playout", "close"])

    async def test_activity_in_the_SECOND_window_cancels_the_goodbye(self):
        """The other restart: after the prompt, activity must stop the close.

        A candidate who answers "are you still there?" must not then be hung up
        on. The loop goes back to the top instead.
        """
        log = []
        activity = asyncio.Event()
        answers = [False, True]

        async def close():
            log.append("close")

        async def scripted(event, timeout):
            if answers:
                return answers.pop(0)
            await asyncio.Event().wait()

        task = asyncio.create_task(
            agent_mod._silence_termination_loop(
                _FakeTerminationSession(log), activity, close,
                prompt_after_sec=0.5, end_after_sec=0.5,
                wait_for_activity=scripted,
            )
        )
        for _ in range(6):
            await asyncio.sleep(0)

        # Prompted, then the candidate answered — so no goodbye and no close.
        self.assertEqual(log, ["prompt", "playout"])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_the_PRODUCTION_wait_seam_answers_both_ways(self):
        """The default is what production runs, so it is covered directly.

        Both directions, and the timing bias of each is SAFE: the True case
        completes as soon as the event is set, and the False case waits FOR a
        lapse. A slow runner can only make either later, never wrong — which is
        the property the old test lacked.
        """
        already = asyncio.Event()
        already.set()
        self.assertTrue(await agent_mod._await_candidate_activity(already, 5.0))
        never = asyncio.Event()
        self.assertFalse(await agent_mod._await_candidate_activity(never, 0.001))

    def test_final_goodbye_marker_is_bounded(self):
        for closing in (
            "Thanks, and goodbye.",
            "Thanks, and good bye.",
            "Thanks, bye!",
            "Take care!",
        ):
            with self.subTest(closing=closing):
                self.assertTrue(agent_mod._is_final_goodbye(closing))
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

    def test_close_reason_error_is_provider_error_not_clean_close(self):
        """X7a: the 1.6.4 `CloseReason.ERROR` value ("error") — the shape a
        Sarvam STT websocket death (close 1006 keepalive timeout) produces — is
        classified as `provider_error`, never `None` (clean_close)."""
        # Reason "error" WITH a provider error object attached, as the SDK emits.
        event = FakeCloseEvent(
            error=RuntimeError("STTError: websocket closed 1006"),
            reason="CloseReason.ERROR",
        )
        self.assertEqual(agent_mod._classify_close_event(event), "provider_error")

    def test_close_reason_error_bare_enum_string_is_provider_error(self):
        """The bare enum value form is classified identically."""
        event = FakeCloseEvent(error=None, reason=FakeAgentSessionCloseReason("error"))
        self.assertEqual(agent_mod._classify_close_event(event), "provider_error")


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

    def test_entrypoint_passes_resolved_room_name_to_session(self):
        async def _test():
            ctx = agent_mod.JobContext()
            ctx.room.name = "synthetic-worker-room"
            with patch.object(agent_mod, "_run_session", new_callable=AsyncMock) as run_session:
                await agent_mod.entrypoint(ctx)
            run_session.assert_awaited_once()
            self.assertEqual(run_session.await_args.args[4], "synthetic-worker-room")

        asyncio.run(_test())

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


class TestWorkerContextResolveRetry(unittest.IsolatedAsyncioTestCase):
    """_resolve_worker_context_with_retry: bounded retry, then fail closed.

    A transient worker-context failure (API cold start / DB blip) must not
    permanently abandon a valid call — it is retried before giving up — while a
    genuinely-unresolvable session still fails closed after the attempts.
    """

    class _WC:  # real stand-in type so isinstance(...) works under the mock
        pass

    def setUp(self):
        self._wc_patch = patch.object(agent_mod, "WorkerContext", self._WC)
        self._wc_patch.start()

    def tearDown(self):
        self._wc_patch.stop()

    async def test_retries_transient_failures_then_succeeds(self):
        wc = self._WC()
        agent_mod.persistence.resolve_worker_context = AsyncMock(
            side_effect=["context_api_error", "context_not_found", wc]
        )
        result = await agent_mod._resolve_worker_context_with_retry(
            "sid", "screening-room", attempts=3, backoff_sec=0.0
        )
        self.assertIs(result, wc)
        self.assertEqual(
            agent_mod.persistence.resolve_worker_context.await_count, 3
        )

    async def test_fails_closed_after_exhausting_attempts(self):
        agent_mod.persistence.resolve_worker_context = AsyncMock(
            return_value="context_not_found"
        )
        result = await agent_mod._resolve_worker_context_with_retry(
            "sid", "screening-room", attempts=3, backoff_sec=0.0
        )
        self.assertEqual(result, "context_not_found")
        self.assertEqual(
            agent_mod.persistence.resolve_worker_context.await_count, 3
        )

    async def test_single_attempt_does_not_retry(self):
        agent_mod.persistence.resolve_worker_context = AsyncMock(
            return_value="context_api_error"
        )
        result = await agent_mod._resolve_worker_context_with_retry(
            "sid", "screening-room", attempts=1, backoff_sec=0.0
        )
        self.assertEqual(result, "context_api_error")
        self.assertEqual(
            agent_mod.persistence.resolve_worker_context.await_count, 1
        )

    async def test_succeeds_on_first_attempt_without_retry(self):
        wc = self._WC()
        agent_mod.persistence.resolve_worker_context = AsyncMock(return_value=wc)
        result = await agent_mod._resolve_worker_context_with_retry(
            "sid", "screening-room", attempts=3, backoff_sec=0.0
        )
        self.assertIs(result, wc)
        self.assertEqual(
            agent_mod.persistence.resolve_worker_context.await_count, 1
        )


class TestPhoneInstructionStateProjection(unittest.TestCase):
    """The construction-time phone prompt is projected from authenticated context."""

    def test_projects_role_guidance_and_allowlisted_resume_evidence(self):
        context = types.SimpleNamespace(
            candidate_name="Asha",
            role_title="Data Engineer",
            role_focus="Build reliable pipelines",
            role_required_skills=["Python", "SQL"],
            interviewer_instructions="Probe for ownership",
            candidate_evidence={"current_role": "Analytics Lead", "skills": ["Python"]},
        )

        state = agent_mod._phone_instruction_state(context)

        self.assertTrue(state.ok)
        self.assertEqual(state.candidate_name, "Asha")
        self.assertEqual(state.role_title, "Data Engineer")
        self.assertEqual(state.role_required_skills, ["Python", "SQL"])
        self.assertEqual(state.resume_facts["current_role"], "Analytics Lead")

    def test_missing_context_produces_no_invented_prompt_facts(self):
        state = agent_mod._phone_instruction_state(None)
        self.assertFalse(state.ok)
        self.assertIsNone(state.role_title)
        self.assertEqual(state.resume_facts, {})


class TestSingleFinalNameMismatchWireUp(unittest.TestCase):
    """FIX 4 (adversarial-review repair). `phone_name_mismatch` must be wired at
    the single-STT-final conflict site too, not only the coalesce branch, so a
    genuine "my name is X" intro arriving as ONE final is still caught.
    """

    def test_single_final_composition_detects_name_conflict(self):
        # The exact idiom the single-final path runs: a deterministic role/
        # employer conflict comes back None (no role contradiction in this turn),
        # and the name-mismatch fallback supplies the identity conflict.
        phone = agent_mod.phone
        resume_facts = {"name": "Rijo"}
        text = "Hi there, my name is Christo, thanks for calling."
        deterministic = phone.phone_deterministic_resume_conflict(text, resume_facts)
        self.assertIsNone(deterministic)  # no role/employer contradiction here
        conflict = deterministic or phone.phone_name_mismatch(
            text,
            resume_facts.get("name") if isinstance(resume_facts, dict) else None,
        )
        self.assertIsInstance(conflict, dict)
        self.assertIn("rijo", conflict["resume_fact"])
        self.assertIn("christo", conflict["spoken_claim"])

    def test_both_conflict_sites_wire_the_name_mismatch(self):
        # Static guard: the name-mismatch fallback must appear at BOTH conflict
        # detection sites in agent.py (coalesce branch AND single-STT-final).
        # A wire-up dropped from one site would silently regress FIX 4.
        import inspect
        source = inspect.getsource(agent_mod)
        occurrences = source.count("phone.phone_name_mismatch(")
        self.assertGreaterEqual(
            occurrences, 2,
            "phone_name_mismatch must be wired at both conflict sites "
            f"(found {occurrences})",
        )


if __name__ == "__main__":
    unittest.main()
