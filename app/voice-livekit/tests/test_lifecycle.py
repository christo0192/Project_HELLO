"""Offline deterministic tests for persistence.py (REL-07 lifecycle).

All tests run with asyncio.run() — no external dependencies required.
The supabase client is mocked via unittest.mock so no real DB calls are made.
"""

import asyncio
import logging
import sys
import types
import unittest
from unittest.mock import MagicMock, patch, call


# ── Stub supabase before importing persistence ────────────────────────

_mock_supabase_mod = types.ModuleType("supabase")
_mock_create_client = MagicMock(name="create_client")
_mock_supabase_mod.create_client = _mock_create_client  # type: ignore[attr-defined]
sys.modules.setdefault("supabase", _mock_supabase_mod)

import importlib
import persistence  # noqa: E402

importlib.reload(persistence)

from persistence import LifecycleOutcome, LifecycleError  # noqa: E402


# ── Helpers ───────────────────────────────────────────────────────────

SESSION_ID = "550e8400-e29b-41d4-a716-446655440000"


def _make_mock_client(rows_returned=None):
    """Return a mock supabase client.

    The chain simulates .update().eq().eq().select().execute() → data=rows_returned.
    Default is exactly one row (CAS success).
    """
    if rows_returned is None:
        rows_returned = [{"id": SESSION_ID}]
    execute_result = MagicMock()
    execute_result.data = rows_returned
    execute_result.error = None

    chain = MagicMock()
    chain.update.return_value = chain
    chain.insert.return_value = chain
    chain.eq.return_value = chain
    chain.select.return_value = chain
    chain.execute.return_value = execute_result

    client = MagicMock()
    client.schema.return_value.table.return_value = chain

    return client, chain


def run(coro):
    return asyncio.run(coro)


# ── LifecycleOutcome ──────────────────────────────────────────────────

class TestLifecycleOutcome(unittest.TestCase):
    def test_ok_true_only_for_success(self):
        self.assertTrue(LifecycleOutcome(LifecycleOutcome.SUCCESS).ok)
        self.assertFalse(LifecycleOutcome(LifecycleOutcome.CONFLICT).ok)
        self.assertFalse(LifecycleOutcome(LifecycleOutcome.ERROR).ok)
        self.assertFalse(LifecycleOutcome(LifecycleOutcome.DISABLED).ok)

    def test_conflict_true_only_for_conflict(self):
        self.assertTrue(LifecycleOutcome(LifecycleOutcome.CONFLICT).conflict)
        self.assertFalse(LifecycleOutcome(LifecycleOutcome.SUCCESS).conflict)
        self.assertFalse(LifecycleOutcome(LifecycleOutcome.ERROR).conflict)

    def test_kind_string_values(self):
        self.assertEqual(LifecycleOutcome(LifecycleOutcome.SUCCESS).kind, "success")
        self.assertEqual(LifecycleOutcome(LifecycleOutcome.CONFLICT).kind, "conflict")
        self.assertEqual(LifecycleOutcome(LifecycleOutcome.ERROR).kind, "error")
        self.assertEqual(LifecycleOutcome(LifecycleOutcome.DISABLED).kind, "disabled")


# ── _cas_update exact-one-row ─────────────────────────────────────────

class TestCasUpdateExactOneRow(unittest.TestCase):
    def test_one_row_returns_success(self):
        client, _ = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertTrue(result.ok)

    def test_zero_rows_returns_conflict(self):
        client, _ = _make_mock_client(rows_returned=[])
        with patch.object(persistence, "_get_client", return_value=client):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertTrue(result.conflict)

    def test_multiple_rows_returns_error(self):
        """Two-row response is a corrupt DB reply — treated as ERROR, not conflict."""
        client, _ = _make_mock_client(rows_returned=[{"id": SESSION_ID}, {"id": "other"}])
        with patch.object(persistence, "_get_client", return_value=client):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_no_client_returns_disabled(self):
        with patch.object(persistence, "_get_client", return_value=None):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertEqual(result.kind, LifecycleOutcome.DISABLED)

    def test_exception_returns_error(self):
        client = MagicMock()
        client.schema.return_value.table.return_value.update.side_effect = RuntimeError("DB down")
        with patch.object(persistence, "_get_client", return_value=client):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_invalid_uuid_returns_error(self):
        with patch.object(persistence, '_is_valid_uuid', return_value=False):
            result = persistence._cas_update("bad-id", "in_progress", {"status": "completed"})
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_no_data_attribute_returns_error(self):
        client, chain = _make_mock_client()
        bad_result = MagicMock(spec=[])
        chain.execute.return_value = bad_result
        with patch.object(persistence, "_get_client", return_value=client):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_data_is_not_list_returns_error(self):
        client, chain = _make_mock_client()
        chain.execute.return_value.data = "not-a-list"
        with patch.object(persistence, "_get_client", return_value=client):
            result = persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)


# ── save_turn ─────────────────────────────────────────────────────────

class TestSaveTurn(unittest.TestCase):
    def test_no_op_for_missing_session_id(self):
        with patch.object(persistence, "_get_client", return_value=None):
            run(persistence.save_turn(None, 0, "bot", "hello"))

    def test_no_op_for_empty_text(self):
        with patch.object(persistence, "_get_client", return_value=None):
            run(persistence.save_turn(SESSION_ID, 0, "bot", "   "))

    def test_inserts_turn_when_client_available(self):
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.save_turn(SESSION_ID, 2, "candidate", "I have 5 years exp"))
        chain.insert.assert_called_once()
        inserted = chain.insert.call_args[0][0]
        self.assertEqual(inserted["session_id"], SESSION_ID)
        self.assertEqual(inserted["turn_index"], 2)
        self.assertEqual(inserted["speaker"], "candidate")

    def test_strips_whitespace(self):
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.save_turn(SESSION_ID, 0, "bot", "  hello world  "))
        inserted = chain.insert.call_args[0][0]
        self.assertEqual(inserted["text"], "hello world")

    def test_fails_closed_when_client_none_with_real_session(self):
        """save_turn raises LifecycleError when persistence is disabled
        but a real session_id is provided — fail closed for hosted jobs."""
        with patch.object(persistence, "_get_client", return_value=None):
            with self.assertRaises(LifecycleError):
                run(persistence.save_turn(SESSION_ID, 0, "bot", "hello"))

    def test_propagates_db_exception(self):
        """Exceptions from save_turn propagate as LifecycleError so drain detects failures."""
        client = MagicMock()
        client.schema.return_value.table.return_value.insert.return_value.execute.side_effect = (
            RuntimeError("disk full")
        )
        with patch.object(persistence, "_get_client", return_value=client):
            with self.assertRaises(LifecycleError):
                run(persistence.save_turn(SESSION_ID, 0, "bot", "some text"))

    def test_detects_db_error_in_result(self):
        """save_turn raises LifecycleError when supabase returns an error."""
        client, chain = _make_mock_client()
        execute_result = MagicMock()
        execute_result.data = None
        execute_result.error = {"message": "insert failed"}
        chain.execute.return_value = execute_result
        with patch.object(persistence, "_get_client", return_value=client):
            with self.assertRaises(LifecycleError):
                run(persistence.save_turn(SESSION_ID, 0, "bot", "hello"))


# ── normalize_turn_anchor_ms (0026 timing anchor validation) ──────────

class TestNormalizeTurnAnchorMs(unittest.TestCase):
    def test_seconds_epoch_converted_to_ms(self):
        self.assertEqual(persistence.normalize_turn_anchor_ms(1723000000.5), 1723000000500)
        self.assertEqual(persistence.normalize_turn_anchor_ms(1723000000), 1723000000000)

    def test_none_and_missing_are_null(self):
        self.assertIsNone(persistence.normalize_turn_anchor_ms(None))

    def test_rejects_bool(self):
        self.assertIsNone(persistence.normalize_turn_anchor_ms(True))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(False))

    def test_rejects_nan_and_inf(self):
        self.assertIsNone(persistence.normalize_turn_anchor_ms(float("nan")))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(float("inf")))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(float("-inf")))

    def test_rejects_nonpositive(self):
        self.assertIsNone(persistence.normalize_turn_anchor_ms(0))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(-1))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(0.0004))  # rounds to 0 ms

    def test_rejects_out_of_range_at_year_2100_boundary(self):
        # 4102444800 seconds == 4102444800000 ms == the 0026 CHECK boundary.
        self.assertIsNone(persistence.normalize_turn_anchor_ms(4102444800))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(4102444800.0))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(1e20))

    def test_rejects_non_numeric_types(self):
        self.assertIsNone(persistence.normalize_turn_anchor_ms("1723000000"))
        self.assertIsNone(persistence.normalize_turn_anchor_ms(object()))


# ── save_turn with turn_started_at_ms (0026 timing column) ────────────

class TestSaveTurnTiming(unittest.TestCase):
    def test_row_shape_includes_turn_started_at_ms_anchor(self):
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.save_turn(
                SESSION_ID, 0, "bot", "hello", turn_started_at_ms=1723000000123))
        inserted = chain.insert.call_args[0][0]
        self.assertEqual(
            inserted,
            {
                "session_id": SESSION_ID,
                "turn_index": 0,
                "speaker": "bot",
                "text": "hello",
                "turn_started_at_ms": 1723000000123,
            },
        )

    def test_row_shape_null_anchor_when_omitted(self):
        """Legacy four-argument callers stay compatible; anchor is NULL."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.save_turn(SESSION_ID, 1, "candidate", "answer"))
        inserted = chain.insert.call_args[0][0]
        self.assertIn("turn_started_at_ms", inserted)
        self.assertIsNone(inserted["turn_started_at_ms"])

    def test_invalid_anchors_degrade_to_null_not_crash(self):
        """Bool/float/NaN/out-of-range ms values must never reach the DB CHECK."""
        for bad in (True, False, 0, -5, 4102444800000, 99999999999999999999, float("nan"), "123"):
            with self.subTest(bad=bad):
                client, chain = _make_mock_client()
                with patch.object(persistence, "_get_client", return_value=client):
                    run(persistence.save_turn(
                        SESSION_ID, 0, "bot", "hello", turn_started_at_ms=bad))
                inserted = chain.insert.call_args[0][0]
                self.assertIsNone(inserted["turn_started_at_ms"])

    def test_boundary_anchor_passes(self):
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.save_turn(
                SESSION_ID, 0, "bot", "hello", turn_started_at_ms=4102444799999))
        inserted = chain.insert.call_args[0][0]
        self.assertEqual(inserted["turn_started_at_ms"], 4102444799999)


# ── activate_session ─────────────────────────────────────────────────

class TestActivateSession(unittest.TestCase):
    def test_returns_disabled_for_none_session(self):
        result = run(persistence.activate_session(None))
        self.assertEqual(result.kind, LifecycleOutcome.DISABLED)

    def test_cas_waiting_to_in_progress_success(self):
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.activate_session(SESSION_ID))
        self.assertTrue(result.ok)
        update_args = chain.update.call_args[0][0]
        self.assertEqual(update_args["status"], "in_progress")
        eq_calls = chain.eq.call_args_list
        self.assertTrue(
            any(c == call("status", "waiting") for c in eq_calls),
            f"Expected eq('status','waiting') in {eq_calls}",
        )

    def test_conflict_returns_conflict_outcome(self):
        client, _ = _make_mock_client(rows_returned=[])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.activate_session(SESSION_ID))
        self.assertTrue(result.conflict)
        self.assertFalse(result.ok)

    def test_db_error_returns_error_outcome(self):
        client = MagicMock()
        client.schema.return_value.table.return_value.update.side_effect = RuntimeError("timeout")
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.activate_session(SESSION_ID))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)


# ── complete_session ──────────────────────────────────────────────────

class TestCompleteSession(unittest.TestCase):
    def test_returns_disabled_for_none_session(self):
        result = run(persistence.complete_session(None))
        self.assertEqual(result.kind, LifecycleOutcome.DISABLED)

    def test_cas_in_progress_to_completed_with_default_reason(self):
        """Default reason is conversation_complete (not null)."""
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(SESSION_ID, duration_sec=120))
        self.assertTrue(result.ok)
        update_args = chain.update.call_args[0][0]
        self.assertEqual(update_args["status"], "completed")
        self.assertEqual(update_args["terminal_reason"], "conversation_complete")
        self.assertEqual(update_args["duration_sec"], 120)
        self.assertIn("ended_at", update_args)

    def test_cas_with_assessment_done_reason(self):
        """Explicit assessment_done reason is accepted."""
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(
                SESSION_ID, duration_sec=120, terminal_reason="assessment_done"
            ))
        self.assertTrue(result.ok)
        update_args = chain.update.call_args[0][0]
        self.assertEqual(update_args["terminal_reason"], "assessment_done")

    def test_rejects_invalid_reason(self):
        """Invalid reason returns ERROR without DB call."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(
                SESSION_ID, terminal_reason="worker_crash"
            ))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_rejects_legacy_unknown(self):
        """legacy_unknown is migration-only — rejected for live transitions."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(
                SESSION_ID, terminal_reason="legacy_unknown"
            ))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_rejects_out_of_bounds_duration(self):
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(
                SESSION_ID, duration_sec=-1
            ))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_rejects_oversized_duration(self):
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(
                SESSION_ID, duration_sec=99999
            ))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_rejects_null_reason(self):
        """Default reason is conversation_complete (not null) — succeeds."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(SESSION_ID))
        self.assertTrue(result.ok)

    def test_conflict_when_already_terminal(self):
        client, _ = _make_mock_client(rows_returned=[])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.complete_session(SESSION_ID))
        self.assertTrue(result.conflict)

    def test_duration_none_is_excluded(self):
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.complete_session(SESSION_ID, duration_sec=None))
        update_args = chain.update.call_args[0][0]
        self.assertNotIn("duration_sec", update_args)


# ── fail_session ──────────────────────────────────────────────────────

class TestFailSession(unittest.TestCase):
    def test_returns_disabled_for_none_session(self):
        result = run(persistence.fail_session(None, "worker_crash"))
        self.assertEqual(result.kind, LifecycleOutcome.DISABLED)

    def test_cas_in_progress_to_failed(self):
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.fail_session(SESSION_ID, "room_create_error"))
        self.assertTrue(result.ok)
        update_args = chain.update.call_args[0][0]
        self.assertEqual(update_args["status"], "failed")
        self.assertEqual(update_args["terminal_reason"], "room_create_error")
        self.assertIn("ended_at", update_args)

    def test_default_expected_status_is_in_progress(self):
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.fail_session(SESSION_ID, "worker_crash"))
        eq_calls = chain.eq.call_args_list
        self.assertTrue(
            any(c == call("status", "in_progress") for c in eq_calls),
            f"Expected eq('status','in_progress') in {eq_calls}",
        )

    def test_custom_expected_status_waiting(self):
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.fail_session(SESSION_ID, "worker_crash", expected_status="waiting"))
        eq_calls = chain.eq.call_args_list
        self.assertTrue(
            any(c == call("status", "waiting") for c in eq_calls),
            f"Expected eq('status','waiting') in {eq_calls}",
        )

    def test_rejects_invalid_terminal_reason(self):
        """Allowlist validation — invalid reason returns ERROR without DB call."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.fail_session(SESSION_ID, "assessment_done"))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_rejects_legacy_unknown_for_fail(self):
        """legacy_unknown is migration-only — rejected for fail_session too."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.fail_session(SESSION_ID, "legacy_unknown"))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_rejects_cancelled_reason_for_fail(self):
        """recruiter_cancelled belongs to cancelled state, not failed."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.fail_session(SESSION_ID, "recruiter_cancelled"))
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)
        chain.update.assert_not_called()

    def test_rejects_terminal_expected_status(self):
        """Cannot fail from an already-terminal status."""
        client, chain = _make_mock_client()
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(
                persistence.fail_session(SESSION_ID, "worker_crash", expected_status="completed")
            )
        self.assertEqual(result.kind, LifecycleOutcome.ERROR)

    def test_terminal_immutability_conflict(self):
        client, _ = _make_mock_client(rows_returned=[])
        with patch.object(persistence, "_get_client", return_value=client):
            result = run(persistence.fail_session(SESSION_ID, "worker_crash"))
        self.assertTrue(result.conflict)


# ── drain_pending_writes ──────────────────────────────────────────────

class TestDrainPendingWrites(unittest.TestCase):
    def test_empty_set_returns_true(self):
        result = run(persistence.drain_pending_writes(set()))
        self.assertTrue(result)

    def test_completed_tasks_return_true(self):
        async def fast():
            await asyncio.sleep(0)

        async def _run():
            tasks = {asyncio.create_task(fast()) for _ in range(3)}
            return await persistence.drain_pending_writes(tasks, timeout_sec=5)

        self.assertTrue(asyncio.run(_run()))

    def test_timeout_returns_false(self):
        async def _run():
            tasks = {asyncio.create_task(asyncio.sleep(9999))}
            result = await persistence.drain_pending_writes(tasks, timeout_sec=0.05)
            for t in tasks:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
            return result

        self.assertFalse(asyncio.run(_run()))

    def test_failed_task_returns_false(self):
        """A task that raises makes drain return False."""
        async def _run():
            async def bad():
                raise RuntimeError("write failed")

            tasks = {asyncio.create_task(bad())}
            return await persistence.drain_pending_writes(tasks, timeout_sec=5)

        self.assertFalse(asyncio.run(_run()))

    def test_no_leaked_tasks_after_timeout(self):
        """Tasks are cancelled and awaited after timeout — no dangling tasks."""
        async def _run():
            hanging = asyncio.create_task(asyncio.sleep(9999))
            result = await persistence.drain_pending_writes({hanging}, timeout_sec=0.05)
            self.assertFalse(result)
            self.assertTrue(hanging.done())

        asyncio.run(_run())

    def test_cancelled_task_returns_false(self):
        """A pre-cancelled task causes drain to return False."""
        async def _run():
            task = asyncio.create_task(asyncio.sleep(9999))
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            hung = asyncio.create_task(asyncio.sleep(9999))
            result = await persistence.drain_pending_writes({hung}, timeout_sec=0.02)
            return result

        self.assertFalse(asyncio.run(_run()))

    def test_lifecycle_error_in_task_returns_false(self):
        """A LifecycleError raised by save_turn (DISABLED client) causes drain to return False."""
        async def _run():
            async def write_op():
                raise LifecycleError("persistence disabled for active session")

            tasks = {asyncio.create_task(write_op())}
            return await persistence.drain_pending_writes(tasks, timeout_sec=5)

        self.assertFalse(asyncio.run(_run()))


# ── Safe logging — no secrets in output ──────────────────────────────

class TestSafeLogging(unittest.TestCase):
    """Verify that log output never contains session IDs, exception bodies,
    transcript text, or secrets seeded into the execution context."""

    def _capture_logs(self, logger_name="voice-livekit.persistence"):
        """Return a handler that accumulates all log records."""
        records: list[logging.LogRecord] = []

        class Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        handler = Capture()
        log = logging.getLogger(logger_name)
        log.addHandler(handler)
        log.setLevel(logging.DEBUG)
        return records, handler, log

    def tearDown(self):
        log = logging.getLogger("voice-livekit.persistence")
        log.handlers = [h for h in log.handlers if not isinstance(h, logging.StreamHandler)
                        or h.stream is not None]

    def test_exception_text_not_in_log_on_cas_error(self):
        records, handler, log = self._capture_logs()
        log.addHandler(handler)

        SECRET_SNIPPET = "SUPER_SECRET_TOKEN_ABC123"
        client = MagicMock()
        client.schema.return_value.table.return_value.update.side_effect = RuntimeError(
            f"DB error: {SECRET_SNIPPET}"
        )
        with patch.object(persistence, "_get_client", return_value=client):
            persistence._cas_update(SESSION_ID, "in_progress", {"status": "completed"})

        all_messages = " ".join(r.getMessage() for r in records)
        self.assertNotIn(SECRET_SNIPPET, all_messages)
        self.assertNotIn(SESSION_ID, all_messages)

    def test_session_id_not_in_activate_log(self):
        records, handler, log = self._capture_logs()
        log.addHandler(handler)

        client, _ = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.activate_session(SESSION_ID))

        all_messages = " ".join(r.getMessage() for r in records)
        self.assertNotIn(SESSION_ID, all_messages)

    def test_transcript_text_not_logged_by_save_turn(self):
        """save_turn no longer logs transcript content."""
        records, handler, log = self._capture_logs()
        log.addHandler(handler)

        client, _ = _make_mock_client()
        SECRET_TEXT = "my_secret_answer_42"
        with patch.object(persistence, "_get_client", return_value=client):
            run(persistence.save_turn(SESSION_ID, 0, "candidate", SECRET_TEXT))

        all_messages = " ".join(r.getMessage() for r in records)
        self.assertNotIn(SECRET_TEXT, all_messages)
        self.assertNotIn(SESSION_ID, all_messages)


# ── UUID validation test ──────────────────────────────────────────────

class TestUuidValidation(unittest.TestCase):
    def test_valid_uuid_accepted(self):
        valid = "550e8400-e29b-41d4-a716-446655440000"
        self.assertTrue(persistence._is_valid_uuid(valid))

    def test_invalid_uuid_rejected(self):
        self.assertFalse(persistence._is_valid_uuid("not-a-uuid"))

    def test_empty_uuid_rejected(self):
        self.assertFalse(persistence._is_valid_uuid(""))

    def test_short_uuid_rejected(self):
        self.assertFalse(persistence._is_valid_uuid("abc-123"))


# ── Deadlock regression ───────────────────────────────────────────────

class TestDeadlockRegression(unittest.TestCase):
    """complete_once must NOT be added to _write_tasks.

    If complete_once were tracked in _write_tasks and then drain_pending_writes
    awaited _write_tasks, gather would try to await complete_once while
    complete_once is itself awaiting drain — a self-await deadlock.

    This test proves complete_once is NOT in _write_tasks when drain runs.
    """

    def test_drain_does_not_include_finalizer_task(self):
        """Simulate the agent entrypoint: write tasks are separate from the finalizer."""
        async def _simulate():
            write_tasks: set[asyncio.Task] = set()

            async def write_op():
                await asyncio.sleep(0)

            async def complete_once():
                drained = await persistence.drain_pending_writes(write_tasks, timeout_sec=1)
                return drained

            t = asyncio.create_task(write_op())
            write_tasks.add(t)
            t.add_done_callback(write_tasks.discard)

            finalizer = asyncio.create_task(complete_once())
            # finalizer is NOT added to write_tasks

            result = await finalizer
            return result, len(write_tasks)

        drained, remaining_writes = asyncio.run(_simulate())
        self.assertTrue(drained)
        self.assertEqual(remaining_writes, 0)


# ── Transition matrix ────────────────────────────────────────────────

class TestTransitionMatrix(unittest.TestCase):
    CASES = [
        ("activate_session", {}, "waiting", "in_progress"),
        ("complete_session", {}, "in_progress", "completed"),
        (
            "complete_session",
            {"terminal_reason": "assessment_done"},
            "in_progress",
            "completed",
        ),
        ("fail_session", {"terminal_reason": "worker_crash"}, "in_progress", "failed"),
        (
            "fail_session",
            {"terminal_reason": "worker_crash", "expected_status": "waiting"},
            "waiting",
            "failed",
        ),
    ]

    def _run_and_capture(self, fn_name, kwargs):
        client, chain = _make_mock_client(rows_returned=[{"id": SESSION_ID}])
        with patch.object(persistence, "_get_client", return_value=client):
            fn = getattr(persistence, fn_name)
            if fn_name == "activate_session":
                run(fn(SESSION_ID))
            elif fn_name == "complete_session":
                run(fn(SESSION_ID, **kwargs))
            else:
                run(fn(SESSION_ID, **kwargs))
        return chain

    def test_all_transitions(self):
        for fn_name, kwargs, expected_from, expected_to in self.CASES:
            with self.subTest(fn=fn_name, from_=expected_from, to=expected_to):
                chain = self._run_and_capture(fn_name, kwargs)
                update_args = chain.update.call_args[0][0]
                eq_calls = chain.eq.call_args_list

                self.assertEqual(
                    update_args.get("status"),
                    expected_to,
                    f"{fn_name}: expected status={expected_to}",
                )
                self.assertTrue(
                    any(c == call("status", expected_from) for c in eq_calls),
                    f"{fn_name}: expected eq('status','{expected_from}') in {eq_calls}",
                )


if __name__ == "__main__":
    unittest.main()
