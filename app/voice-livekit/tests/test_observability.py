"""OBS-01 / OBS-02 Python observability tests — COMPREHENSIVE SUITE.

Covers:
  - StructuredLogger schema: one JSON object per emit, fixed envelope fields.
  - Envelope field validation (timestamp, correlationId) at runtime; corrupt
    values fall back to safe defaults.
  - Key->type enforcement: booleans rejected, string/number partitioned.
  - Adversarial redaction: non-allowlisted keys and sensitive values must not
    appear in output.  MATRIX test: every seed in every string field.
  - Control-character sanitisation in allowlisted string fields.
  - Correlation ID validation: UUID v4 only; reject oversized, control chars,
    comma-joined, non-UUID.
  - TOKEN-BASED set/reset: ContextVar Token for nested restore.
  - Sequential asyncio Task context isolation: no bleed, proper reset.
  - Nested context restoration test: set within a sub-task correctly restores.
  - trigger_scoring propagates X-Correlation-ID header; classifier 2xx/4xx/5xx.
  - persistence log output contains no transcript text, raw exceptions, or
    session IDs.
  - SUITE-LEVEL network trap: socket connect/create_connection blocked.
  - No json.dumps(default=str) — only canonical scalars emitted.
  - Timestamp emitted with Z suffix (canonical UTC contract).
  - unknown_event present in _ALLOWED_EVENTS.
  - Component max length parity: 64 chars.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import socket
import sys
import types
import unittest
from typing import Any, Optional
import contextvars
from unittest.mock import patch, MagicMock

# ---------------------------------------------------------------------------
# SUITE-LEVEL NETWORK TRAP
# ---------------------------------------------------------------------------
# Trap socket operations before anything else imports networking.
_original_socket_connect = socket.socket.connect
_original_create_connection = socket.create_connection


def _trapped_connect(self, *args: Any, **kwargs: Any) -> Any:
    """Raise RuntimeError on any socket connect attempt during tests."""
    raise RuntimeError(
        "NETWORK TRAP: socket.connect() called during test — "
        "a real network call escaped the test harness. "
        "All tests must use fakes/mocks."
    )


def _trapped_create_connection(*args: Any, **kwargs: Any) -> Any:
    """Raise RuntimeError on any create_connection during tests."""
    raise RuntimeError(
        "NETWORK TRAP: socket.create_connection() called during test — "
        "a real network call escaped the test harness."
    )


# Apply traps at module level (before any test imports real networking)
socket.socket.connect = _trapped_connect  # type: ignore[assignment]
socket.create_connection = _trapped_create_connection  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Path bootstrap
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(__file__)
_LIVEKIT_DIR = os.path.abspath(os.path.join(_HERE, ".."))
if _LIVEKIT_DIR not in sys.path:
    sys.path.insert(0, _LIVEKIT_DIR)

# Stub heavy optional deps before importing our modules
# Track stubs so tearDownModule can remove them and prevent bleed into
# merged/provenance test files.
_STUBBED_MODULES: list[str] = []
for _mod_name in (
    "livekit", "livekit.agents", "livekit.plugins",
    "livekit.plugins.openai", "livekit.plugins.sarvam", "livekit.plugins.silero",
    "livekit.plugins.turn_detector", "livekit.plugins.turn_detector.multilingual",
    "dotenv",
):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)
        _STUBBED_MODULES.append(_mod_name)

# httpx stub: allow persistence to import even when httpx is absent
if "httpx" not in sys.modules:
    _fake_httpx = types.ModuleType("httpx")
    _fake_httpx.__is_stub = True  # type: ignore[attr-defined]
    sys.modules["httpx"] = _fake_httpx
    _STUBBED_MODULES.append("httpx")

import observability  # noqa: E402
from observability import (  # noqa: E402
    StructuredLogger,
    get_correlation_id,
    set_correlation_id,
    reset_correlation_id,
    validate_correlation_id,
    _correlation_id,
    _ALLOWED_EVENTS,
    _validate_timestamp,
    _validate_correlation_envelope,
    _validate_origin,
)
import persistence  # noqa: E402

# Restore network traps after module imports (which may use real networking)
socket.socket.connect = _trapped_connect  # type: ignore[assignment]
socket.create_connection = _trapped_create_connection  # type: ignore[assignment]


# ── Helpers ───────────────────────────────────────────────────────────────────

_TIMESTAMP_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


def make_logger(lines: list[str], component: str = "test") -> StructuredLogger:
    return StructuredLogger(
        component,
        clock=lambda: "2026-01-01T00:00:00.000000Z",
        writer=lambda line: lines.append(line),
    )


def reset_correlation() -> None:
    _correlation_id.set(None)


def _restore_socket_traps() -> None:
    """Re-apply socket traps (imports may have reset them)."""
    socket.socket.connect = _trapped_connect  # type: ignore[assignment]
    socket.create_connection = _trapped_create_connection  # type: ignore[assignment]


# =============================================================================
#  ORIGIN VALIDATION
# =============================================================================


class TestOriginValidation(unittest.TestCase):
    def test_rejects_origin_with_path_query_or_secret(self) -> None:
        self.assertIsNone(_validate_origin("https://example.com/path?token=secret"))

    def test_rejects_bracketed_ipv6_literal(self) -> None:
        self.assertIsNone(_validate_origin("https://[::1]"))

    def test_rejects_invalid_numeric_dotted_host(self) -> None:
        self.assertIsNone(_validate_origin("https://999.999.999.999"))

    def test_accepts_canonical_http_origin(self) -> None:
        self.assertEqual(_validate_origin("https://example.com"), "https://example.com")


# =============================================================================
#  SUITE-LEVEL NETWORK TRAP VERIFICATION
# =============================================================================

class TestNetworkTrap(unittest.TestCase):
    """Prove the suite-level network trap is active and fails real attempts."""

    def test_socket_connect_raises(self) -> None:
        """socket.socket.connect must raise RuntimeError."""
        _restore_socket_traps()
        s = socket.socket()
        with self.assertRaises(RuntimeError):
            s.connect(("127.0.0.1", 1))

    def test_create_connection_raises(self) -> None:
        """socket.create_connection must raise RuntimeError."""
        _restore_socket_traps()
        with self.assertRaises(RuntimeError):
            socket.create_connection(("127.0.0.1", 1))


# =============================================================================
#  LOGGER SCHEMA & ENVELOPE VALIDATION
# =============================================================================

class TestLoggerSchema(unittest.TestCase):
    def setUp(self) -> None:
        reset_correlation()

    def test_emits_one_valid_json_object(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log.info("startup_listen", port=8787)

        self.assertEqual(len(lines), 1)
        parsed = json.loads(lines[0])
        self.assertEqual(parsed["timestamp"], "2026-01-01T00:00:00.000000Z")
        self.assertEqual(parsed["level"], "info")
        self.assertEqual(parsed["component"], "test")
        self.assertEqual(parsed["event"], "startup_listen")
        self.assertIsNone(parsed["correlationId"])
        self.assertEqual(parsed["port"], 8787)

    def test_timestamp_is_utc_z_suffix(self) -> None:
        lines: list[str] = []
        log = StructuredLogger("test", writer=lambda line: lines.append(line))
        log.info("startup_listen")
        parsed = json.loads(lines[0])
        self.assertRegex(parsed["timestamp"], _TIMESTAMP_Z_RE)

    def test_correlationId_present_when_set(self) -> None:
        cid = "550e8400-e29b-41d4-a716-446655440000"
        set_correlation_id(cid)
        lines: list[str] = []
        log = make_logger(lines)
        log.info("db_turn_saved", turn_index=0, speaker="bot")
        parsed = json.loads(lines[0])
        self.assertEqual(parsed["correlationId"], cid)

    def test_single_line_per_emit(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log.warn("csp_violation", shape="legacy")
        self.assertEqual(len(lines), 1)
        self.assertEqual(len(lines[0].split("\n")), 1)

    def test_envelope_timestamp_validated_corrupt_fallback(self) -> None:
        """Corrupt clock output must be replaced with a valid timestamp."""
        lines: list[str] = []
        log = StructuredLogger(
            "test",
            clock=lambda: "not-a-timestamp",
            writer=lambda line: lines.append(line),
        )
        log.info("startup_listen")
        parsed = json.loads(lines[0])
        self.assertRegex(parsed["timestamp"], _TIMESTAMP_Z_RE)
        self.assertNotEqual(parsed["timestamp"], "not-a-timestamp")

    def test_envelope_correlationId_validated_non_uuid_fallback(self) -> None:
        """Non-UUID correlation ID must be replaced with null."""
        # Inject a non-UUID value through the context var directly
        _correlation_id.set("not-a-uuid")
        lines: list[str] = []
        log = make_logger(lines)
        log.info("startup_listen")
        parsed = json.loads(lines[0])
        self.assertIsNone(parsed["correlationId"])

    def test_replaces_invalid_component_with_unknown(self) -> None:
        lines: list[str] = []
        log = StructuredLogger(
            "has spaces / slashes!",
            writer=lambda line: lines.append(line),
        )
        log.info("startup_listen")
        self.assertEqual(json.loads(lines[0])["component"], "unknown")

    def test_component_max_64_chars_parity(self) -> None:
        """Component longer than 64 chars becomes 'unknown'."""
        lines: list[str] = []
        log = StructuredLogger(
            "a" * 65,
            writer=lambda line: lines.append(line),
        )
        log.info("startup_listen")
        self.assertEqual(json.loads(lines[0])["component"], "unknown")

        lines2: list[str] = []
        ok_name = "api.component-long-name.with-safe-separators.v1"
        log2 = StructuredLogger(
            ok_name,
            writer=lambda line: lines2.append(line),
        )
        log2.info("startup_listen")
        self.assertEqual(json.loads(lines2[0])["component"], ok_name)

    def test_replaces_unknown_event_with_unknown_event(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log._emit("info", "nonexistent_event_xyz")
        parsed = json.loads(lines[0])
        self.assertEqual(parsed["event"], "unknown_event")

    def test_unknown_event_in_allowed_events(self) -> None:
        self.assertIn("unknown_event", _ALLOWED_EVENTS)


# =============================================================================
#  KEY->TYPE ENFORCEMENT — NO BOOLEAN, STRICT STRING/NUMBER
# =============================================================================

class TestKeyTypeEnforcement(unittest.TestCase):
    def setUp(self) -> None:
        reset_correlation()

    def test_rejects_bool_in_string_key(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log._emit("info", "error_unhandled", {"model": True})
        self.assertNotIn("model", json.loads(lines[0]))

    def test_rejects_bool_in_numeric_key(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log._emit("info", "startup_listen", {"port": True})
        self.assertNotIn("port", json.loads(lines[0]))

    def test_rejects_string_in_numeric_key(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log._emit("info", "startup_listen", {"port": "abc"})
        self.assertNotIn("port", json.loads(lines[0]))

    def test_rejects_number_in_string_key(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log._emit("info", "error_unhandled", {"model": 123})
        self.assertNotIn("model", json.loads(lines[0]))


# =============================================================================
#  ADVERSARIAL REDACTION — NON-ALLOWLISTED KEYS
# =============================================================================

class TestAdversarialRedaction(unittest.TestCase):
    SEEDS = {
        "bearer_token":   "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "authorization":  "token private-key-abc123xyz-secret",
        "email":          "victim@example.com",
        "phone":          "+16505550123",
        "file_path":      "/home/runner/.ssh/id_rsa",
        "url_with_query": "https://api.example.com/v1/users?token=secret&key=abc",
        "nested_object":  {"deep": "secret_nested_value"},
        "array_value":    ["item1", "item2"],
    }

    def setUp(self) -> None:
        reset_correlation()

    def test_non_allowlisted_keys_and_values_absent_from_output(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log.info("error_unhandled", **self.SEEDS)  # type: ignore[arg-type]

        self.assertEqual(len(lines), 1)
        line = lines[0]

        parsed = json.loads(line)

        self.assertNotIn("eyJhbGci", line)
        self.assertNotIn("private-key-abc", line)
        self.assertNotIn("victim@example.com", line)
        self.assertNotIn("+16505550123", line)
        self.assertNotIn(".ssh/id_rsa", line)
        self.assertNotIn("token=secret", line)
        self.assertNotIn("secret_nested_value", line)
        self.assertNotIn("item1", line)
        self.assertNotIn("bearer_token", line)
        self.assertNotIn("authorization", line)
        self.assertNotIn("nested_object", line)

        for field in ("timestamp", "level", "component", "event", "correlationId"):
            self.assertIn(field, parsed)

    def test_seed_keys_not_in_parsed_output(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log.error("error_unhandled", **self.SEEDS)  # type: ignore[arg-type]
        parsed = json.loads(lines[0])
        for k in self.SEEDS:
            self.assertNotIn(k, parsed)


# =============================================================================
#  MATRIX VALUE-SAFE REDACTION — EVERY SEED IN EVERY STRING FIELD
# =============================================================================

class TestMatrixValueSafeRedaction(unittest.TestCase):
    """Place every adversarial seed in EVERY allowlisted string field."""

    STRING_FIELDS = [
        "shape", "document_origin", "violated_directive", "effective_directive",
        "blocked_origin", "error_category", "error_type", "method", "model",
        "schema", "speaker",
    ]

    SEEDS = [
        ("bearer+JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.payload"),
        ("email", "attacker@evil.com"),
        ("10plusDigits", "14155551234"),
        ("OpenAI_key", "sk-" + "abcdefghijklmnopqrstuvwxyz123456"),
        ("GitHub_token", "ghp_" + "abcdefghijklmnopqrstuv"),
        ("Slack_token", "xox" + "b-" + "123456789012-abcdefghijklmn"),
        ("AWS_key", "AKIA" + "1234567890ABCDEF"),
        ("PEM_header", "-----BEGIN RSA PRIVATE KEY-----"),
        ("high_entropy_30", "aB3dE5gH7jK9lMnOpQrStUvWxYz0123456"),
        ("path_leak", "/etc/passwd"),
        ("file_path", "/home/user/.ssh/id_rsa"),
        ("control_char", "safe\x00injected_payload"),
        ("newline_inject", "valid\n{\"fake_log\":true}"),
    ]

    def setUp(self) -> None:
        reset_correlation()

    def test_each_seed_in_each_string_field(self) -> None:
        for field in self.STRING_FIELDS:
            for label, value in self.SEEDS:
                with self.subTest(field=field, seed=label):
                    lines: list[str] = []
                    log = make_logger(lines)
                    log._emit("info", "error_unhandled", {field: value})
                    parsed = json.loads(lines[0])
                    self.assertNotIn(
                        field, parsed,
                        f"Field '{field}' should be dropped for seed '{label}'"
                    )


# =============================================================================
#  CONTROL-CHARACTER SANITISATION
# =============================================================================

class TestControlCharSanitisation(unittest.TestCase):
    def setUp(self) -> None:
        reset_correlation()

    def test_truncates_and_drops_field_at_nul_byte(self) -> None:
        """Control char in value causes entire field to be dropped."""
        lines: list[str] = []
        log = make_logger(lines)
        log.warn("csp_violation", shape="legacy",
                 violated_directive="script-src\x00injected_payload")
        line = lines[0]
        self.assertNotIn("\x00", line)
        self.assertNotIn("injected_payload", line)
        parsed = json.loads(line)
        self.assertNotIn("violated_directive", parsed,
                         "Field with control char must be dropped entirely")

    def test_drops_field_with_newline(self) -> None:
        """Newline in value causes entire field to be dropped."""
        lines: list[str] = []
        log = make_logger(lines)
        log.warn("csp_violation", shape="legacy",
                 violated_directive='script-src\n{"fake_log":true}')
        line = lines[0]
        self.assertNotIn("fake_log", line)
        parsed = json.loads(line)
        self.assertNotIn("violated_directive", parsed,
                         "Field with newline must be dropped entirely")

    def test_drops_field_with_cr(self) -> None:
        """CR in value causes entire field to be dropped."""
        lines: list[str] = []
        log = make_logger(lines)
        log.warn("csp_violation", shape="legacy",
                 violated_directive="script-src\r\ninjected")
        line = lines[0]
        self.assertNotIn("\r", line)
        self.assertNotIn("injected", line)
        parsed = json.loads(line)
        self.assertNotIn("violated_directive", parsed,
                         "Field with CR must be dropped entirely")

    def test_drops_non_scalar_in_allowlisted_key(self) -> None:
        lines: list[str] = []
        log = make_logger(lines)
        log._emit("info", "error_unhandled", {"error_category": {"nested": "secret"}})
        parsed = json.loads(lines[0])
        self.assertNotIn("error_category", parsed)
        self.assertNotIn("secret", lines[0])


# =============================================================================
#  CORRELATION ID VALIDATION (UNIT)
# =============================================================================

class TestCorrelationIdValidation(unittest.TestCase):
    def setUp(self) -> None:
        reset_correlation()

    def test_valid_uuid_v4_accepted(self) -> None:
        cid = "550e8400-e29b-41d4-a716-446655440000"
        self.assertEqual(validate_correlation_id(cid), cid)

    def test_normalised_to_lowercase(self) -> None:
        cid = "550E8400-E29B-41D4-A716-446655440000"
        self.assertEqual(validate_correlation_id(cid), cid.lower())

    def test_none_returns_none(self) -> None:
        self.assertIsNone(validate_correlation_id(None))

    def test_empty_string_returns_none(self) -> None:
        self.assertIsNone(validate_correlation_id(""))

    def test_non_uuid_returns_none(self) -> None:
        self.assertIsNone(validate_correlation_id("not-a-uuid"))

    def test_uuid_v1_rejected(self) -> None:
        v1 = "550e8400-e29b-11d4-a716-446655440000"
        self.assertIsNone(validate_correlation_id(v1))

    def test_oversized_returns_none(self) -> None:
        self.assertIsNone(validate_correlation_id("a" * 200))

    def test_control_char_returns_none(self) -> None:
        self.assertIsNone(validate_correlation_id("abc\x00def"))

    def test_newline_returns_none(self) -> None:
        self.assertIsNone(validate_correlation_id("abc\ndef"))

    def test_comma_joined_duplicate_returns_none(self) -> None:
        v = "550e8400-e29b-41d4-a716-446655440000, bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        self.assertIsNone(validate_correlation_id(v))

    def test_set_generates_uuid_when_none(self) -> None:
        cid_token = set_correlation_id(None)
        cid = get_correlation_id()
        pattern = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        )
        self.assertIsNotNone(cid)
        if cid:
            self.assertRegex(cid, pattern)
        self.assertIsNotNone(cid_token)

    def test_get_returns_value_after_set(self) -> None:
        expected = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
        set_correlation_id(expected)
        self.assertEqual(get_correlation_id(), expected)


# =============================================================================
#  TOKEN-BASED CONTEXTVAR SET/RESET
# =============================================================================

class TestTokenBasedContextVar(unittest.TestCase):
    """Verify token-based set/reset properly restores previous context."""

    def setUp(self) -> None:
        reset_correlation()

    def test_token_restores_previous_value(self) -> None:
        """Setting with a token and resetting restores the previous value."""
        # Start with "outer" value
        old_token = _correlation_id.set("outer-value")
        self.assertEqual(get_correlation_id(), "outer-value")

        # Set "inner" value, getting a token
        inner_token = set_correlation_id("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")
        self.assertEqual(get_correlation_id(), "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")

        # Reset inner → should restore "outer-value" (not None)
        reset_correlation_id(inner_token)
        self.assertEqual(get_correlation_id(), "outer-value")

        # Clean up
        _correlation_id.reset(old_token)
        self.assertIsNone(get_correlation_id())

    def test_set_returns_token(self) -> None:
        """set_correlation_id must return a contextvars.Token."""
        token = set_correlation_id(None)
        self.assertIsInstance(token, contextvars.Token)


# =============================================================================
#  CONCURRENT ASYNCIO TASK CONTEXT ISOLATION
# =============================================================================

class TestConcurrentContextIsolation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        reset_correlation()

    async def test_tasks_get_isolated_correlation_contexts(self) -> None:
        results: dict[str, Optional[str]] = {}
        id_a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
        id_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

        async def task_a() -> None:
            set_correlation_id(id_a)
            await asyncio.sleep(0)
            results["a"] = get_correlation_id()

        async def task_b() -> None:
            set_correlation_id(id_b)
            await asyncio.sleep(0)
            results["b"] = get_correlation_id()

        t1 = asyncio.create_task(task_a())
        t2 = asyncio.create_task(task_b())
        await asyncio.gather(t1, t2)

        self.assertEqual(results["a"], id_a)
        self.assertEqual(results["b"], id_b)
        self.assertNotEqual(results["a"], results["b"])

    async def test_generated_ids_are_unique_per_task(self) -> None:
        ids: list[str] = []

        async def task() -> None:
            set_correlation_id(None)
            cid = get_correlation_id()
            if cid:
                ids.append(cid)

        tasks = [asyncio.create_task(task()) for _ in range(5)]
        await asyncio.gather(*tasks)

        self.assertEqual(len(set(ids)), 5, "All generated IDs should be unique")

    async def test_nested_context_restored(self) -> None:
        """A sub-task that sets its own ID should not affect the parent's ID."""
        parent_id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
        child_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

        set_correlation_id(parent_id)

        async def child_task() -> str:
            """Set child ID, return it, but restore parent's after."""
            token = set_correlation_id(child_id)
            result = get_correlation_id()
            reset_correlation_id(token)
            assert result is not None
            return result

        child_result = await child_task()
        self.assertEqual(child_result, child_id)

        # Parent should still have its own ID
        self.assertEqual(get_correlation_id(), parent_id)


# =============================================================================
#  SEQUENTIAL-JOBS CONTEXT RESET
# =============================================================================

class TestSequentialJobsContextReset(unittest.IsolatedAsyncioTestCase):
    """Verify that sequential jobs/tasks do not inherit stale correlation context."""

    async def asyncSetUp(self) -> None:
        reset_correlation()

    async def test_context_reset_after_task_prevents_bleed(self) -> None:
        """After token-based reset, a new task starts with None."""
        id_a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"

        async def first_job() -> str:
            token = set_correlation_id(id_a)
            await asyncio.sleep(0)
            result = get_correlation_id()
            reset_correlation_id(token)  # simulate finally-block restore
            assert result is not None
            return result

        async def second_job() -> Optional[str]:
            return get_correlation_id()

        result_a = await first_job()
        self.assertEqual(result_a, id_a)

        # Second job must not inherit stale context
        result_b = await second_job()
        self.assertIsNone(result_b, "Sequential task inherited stale correlation ID")

    async def test_fresh_id_generated_after_reset(self) -> None:
        """After reset, set_correlation_id(None) generates a fresh UUID."""
        pattern = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        )
        id_a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"

        token_a = set_correlation_id(id_a)
        self.assertEqual(get_correlation_id(), id_a)

        reset_correlation_id(token_a)
        self.assertIsNone(get_correlation_id())

        token_b = set_correlation_id(None)
        fresh = get_correlation_id()
        self.assertIsNotNone(fresh)
        if fresh:
            self.assertRegex(fresh, pattern)
        self.assertIsNotNone(token_b)


# =============================================================================
#  PERSISTENCE LOG OUTPUT — NO SENSITIVE DATA
# =============================================================================

class TestPersistenceLogging(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        reset_correlation()

    async def test_save_turn_does_not_log_transcript_text(self) -> None:
        lines: list[str] = []
        table = MagicMock()
        table.insert.return_value.execute.return_value = types.SimpleNamespace(error=None)
        original_writer = persistence._log._writer
        persistence._log._writer = lambda line: lines.append(line)
        try:
            with patch.object(persistence, "_table", return_value=table):
                await persistence.save_turn(
                    "test-session-id", 0, "bot", "Hello this is secret candidate text"
                )
        finally:
            persistence._log._writer = original_writer

        for line in lines:
            self.assertNotIn("Hello", line)
            self.assertNotIn("secret candidate text", line)

    async def test_save_turn_does_not_log_session_id(self) -> None:
        lines: list[str] = []
        table = MagicMock()
        table.insert.return_value.execute.return_value = types.SimpleNamespace(error=None)
        original_writer = persistence._log._writer
        persistence._log._writer = lambda line: lines.append(line)
        try:
            with patch.object(persistence, "_table", return_value=table):
                await persistence.save_turn("my-secret-session-id", 1, "candidate", "text")
        finally:
            persistence._log._writer = original_writer

        for line in lines:
            self.assertNotIn("my-secret-session-id", line)

    async def test_complete_session_does_not_log_session_id(self) -> None:
        lines: list[str] = []
        original_writer = persistence._log._writer
        persistence._log._writer = lambda line: lines.append(line)
        try:
            await persistence.complete_session("confidential-session-xyz", 120)
        finally:
            persistence._log._writer = original_writer

        for line in lines:
            self.assertNotIn("confidential-session-xyz", line)


# =============================================================================
#  TRIGGER SCORING — CORRELATION HEADER PROPAGATION (LOOPBACK-FREE)
# =============================================================================

class TestTriggerScoringHeaderPropagation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        reset_correlation()
        persistence._SCORING_BREAKER.reset()
        self._worker_secret = "w" * 32
        self._worker_secret_patcher = patch.dict(
            os.environ, {"WORKER_CONTEXT_SECRET": self._worker_secret}
        )
        self._worker_secret_patcher.start()

    async def asyncTearDown(self) -> None:
        self._worker_secret_patcher.stop()

    @staticmethod
    def _transport(status: int, captured: Optional[dict] = None):
        class FakeTransport:
            async def request(self, **kwargs):  # noqa: ANN003
                if captured is not None:
                    captured.update(kwargs)
                return types.SimpleNamespace(status_code=status)
        return FakeTransport()

    async def _invoke(self, status: int, *, session_id: str = "session-id"):
        lines: list[str] = []
        original_writer = persistence._log._writer
        persistence._log._writer = lambda line: lines.append(line)
        try:
            with patch.object(
                persistence, "get_scoring_transport", return_value=self._transport(status)
            ):
                result = await persistence.trigger_scoring(session_id)
        finally:
            persistence._log._writer = original_writer
        return result, lines

    async def test_correlation_id_sent_as_request_header(self) -> None:
        expected_cid = "550e8400-e29b-41d4-a716-446655440000"
        set_correlation_id(expected_cid)
        captured: dict = {}
        with patch.object(
            persistence, "get_scoring_transport", return_value=self._transport(202, captured)
        ):
            result = await persistence.trigger_scoring("session-id-irrelevant")
        self.assertEqual(result, persistence.TriggerOutcome.SUCCESS)
        self.assertEqual(captured["headers"]["X-Correlation-ID"], expected_cid)
        self.assertEqual(
            captured["headers"]["Authorization"], f"Bearer {self._worker_secret}"
        )
        self.assertIn("/api/internal/assess/", captured["url"])

    async def test_no_url_or_session_id_in_log_output(self) -> None:
        result, lines = await self._invoke(200, session_id="secret-session-id-123")
        self.assertEqual(result, persistence.TriggerOutcome.SUCCESS)
        self.assertGreater(len(lines), 0)
        for line in lines:
            self.assertNotIn("api/assess", line)
            self.assertNotIn("secret-session-id-123", line)
        self.assertEqual(json.loads(lines[0])["event"], "scoring_trigger")

    async def test_transport_error_logs_stable_category_only(self) -> None:
        class ErrorTransport:
            async def request(self, **_kwargs):  # noqa: ANN003
                raise persistence.ProviderError("connection")

        lines: list[str] = []
        original_writer = persistence._log._writer
        persistence._log._writer = lambda line: lines.append(line)
        try:
            with patch.object(persistence, "get_scoring_transport", return_value=ErrorTransport()):
                result = await persistence.trigger_scoring("session-id")
        finally:
            persistence._log._writer = original_writer
        self.assertEqual(result, persistence.TriggerOutcome.TRANSPORT_FAILURE)
        self.assertEqual(json.loads(lines[0])["error_category"], "connection")
        self.assertNotIn("session-id", lines[0])

    async def test_400_is_business_error(self) -> None:
        result, lines = await self._invoke(400)
        self.assertEqual(result, persistence.TriggerOutcome.BUSINESS_ERROR)
        self.assertEqual(json.loads(lines[0])["error_category"], "business_error")

    async def test_429_is_transport_failure(self) -> None:
        result, lines = await self._invoke(429)
        self.assertEqual(result, persistence.TriggerOutcome.TRANSPORT_FAILURE)
        self.assertEqual(json.loads(lines[0])["error_category"], "protocol")

    async def test_500_is_transport_failure(self) -> None:
        result, lines = await self._invoke(500)
        self.assertEqual(result, persistence.TriggerOutcome.TRANSPORT_FAILURE)
        self.assertEqual(json.loads(lines[0])["error_category"], "protocol")

    async def test_202_is_success(self) -> None:
        result, lines = await self._invoke(202)
        self.assertEqual(result, persistence.TriggerOutcome.SUCCESS)
        parsed = json.loads(lines[0])
        self.assertEqual(parsed["event"], "scoring_trigger")
        self.assertEqual(parsed["http_status"], 202)


# ── Module-level tear-down ────────────────────────────────────────────────

def tearDownModule() -> None:
    """Restore socket originals and remove stubbed modules so merged/provenance
    test files cannot inherit fake modules based on import order."""
    socket.socket.connect = _original_socket_connect  # type: ignore[assignment]
    socket.create_connection = _original_create_connection  # type: ignore[assignment]
    # Remove only the modules we explicitly stubbed (tracked in _STUBBED_MODULES)
    for _mod_name in _STUBBED_MODULES:
        if _mod_name in sys.modules and getattr(sys.modules[_mod_name], "__is_stub", False):
            del sys.modules[_mod_name]


if __name__ == "__main__":
    unittest.main()
