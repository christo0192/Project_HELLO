"""Offline deterministic tests for persistence.py REL-02/03 outbox/ingestion helpers.

All tests run with asyncio.run() — no external dependencies required.
The supabase client is mocked via unittest.mock so no real DB calls are made.
"""

import asyncio
import sys
import types
import unittest
from unittest.mock import MagicMock, patch


# ── Stub supabase before importing persistence ────────────────────────

_mock_supabase_mod = types.ModuleType("supabase")
_mock_create_client = MagicMock(name="create_client")
_mock_supabase_mod.create_client = _mock_create_client  # type: ignore[attr-defined]
sys.modules.setdefault("supabase", _mock_supabase_mod)

# NOTE: do NOT importlib.reload(persistence) here. These tests patch
# persistence._table at call time and never depend on a fresh module. Reloading
# swaps the identity of persistence.LifecycleError, which breaks other test
# modules (e.g. test_lifecycle) that bound `LifecycleError` by value before the
# reload — their assertRaises(LifecycleError) would no longer match.
import persistence  # noqa: E402


# ── Helpers ───────────────────────────────────────────────────────────

SESSION_ID = "550e8400-e29b-41d4-a716-446655440000"
EVENT_ID = "66000000-e29b-41d4-a716-446655440000"


def run(coro):
    return asyncio.run(coro)


def _make_chain(execute_side_effect=None):
    """Build a chainable mock for postgrest query builder.

    Every method returns self for chaining.
    """
    chain = MagicMock()
    for method in (
        "select", "insert", "update", "upsert", "delete",
        "eq", "neq", "gt", "gte", "lt", "lte",
        "order", "limit", "single", "maybe_single",
    ):
        getattr(chain, method).return_value = chain

    if execute_side_effect:
        chain.execute.side_effect = execute_side_effect
        return chain

    exec_result = MagicMock()
    exec_result.data = None
    chain.execute.return_value = exec_result
    return chain


# ═══════════════════════════════════════════════════════════════════════
#  1. save_transcript_event
# ═══════════════════════════════════════════════════════════════════════

class TestSaveTranscriptEvent(unittest.TestCase):
    """Test REL-02/03 save_transcript_event persistence helper."""

    def _make_events_chain(self, seq_data=None, upsert_data=None, upsert_error=False):
        """Create a transcript_events chain that handles:
        - First .select(...).execute() = sequence query → seq_data
        - Then .upsert(...).execute() = upsert → upsert_data
        """
        chain = _make_chain()

        # Sequence query execute
        seq_exec = MagicMock()
        seq_exec.data = seq_data
        # Upsert execute
        upsert_exec = MagicMock()
        upsert_exec.data = upsert_data

        if upsert_error:
            chain.execute.side_effect = [seq_exec, Exception("upsert failed")]
        else:
            chain.execute.side_effect = [seq_exec, upsert_exec]

        return chain

    def test_inserts_event_and_outbox_on_success(self):
        """Happy path: event upserted + outbox entry created."""
        events_chain = self._make_events_chain(
            seq_data=None,
            upsert_data={"id": EVENT_ID, "session_id": SESSION_ID, "turn_index": 0,
                         "speaker": "bot", "text": "hello", "sequence": 1},
        )
        outbox_chain = _make_chain()

        def table_router(name):
            if name == "transcript_events":
                return events_chain
            elif name == "outbox":
                return outbox_chain
            return _make_chain()

        with patch.object(persistence, "_table", side_effect=table_router):
            error = run(persistence.save_transcript_event(
                SESSION_ID, 0, "bot", "Hello"
            ))

        self.assertEqual(error, "", f"Expected empty string on success, got: {error}")
        # Verify upsert was called with correct data
        upsert_call_args = events_chain.upsert.call_args
        self.assertIsNotNone(upsert_call_args)
        upsert_kwargs = upsert_call_args[0][0]
        self.assertEqual(upsert_kwargs["session_id"], SESSION_ID)
        self.assertEqual(upsert_kwargs["turn_index"], 0)
        self.assertEqual(upsert_kwargs["speaker"], "bot")
        self.assertEqual(upsert_kwargs["text"], "Hello")
        # Verify outbox insert was called
        outbox_chain.insert.assert_called_once()

    def test_strips_text_whitespace(self):
        """Text is stripped before insert."""
        events_chain = self._make_events_chain(
            seq_data=None,
            upsert_data={"id": EVENT_ID, "session_id": SESSION_ID, "turn_index": 0,
                         "speaker": "bot", "text": "hello world", "sequence": 1},
        )
        outbox_chain = _make_chain()

        def table_router(name):
            if name == "transcript_events":
                return events_chain
            elif name == "outbox":
                return outbox_chain
            return _make_chain()

        with patch.object(persistence, "_table", side_effect=table_router):
            error = run(persistence.save_transcript_event(
                SESSION_ID, 0, "bot", "  hello world  "
            ))

        self.assertEqual(error, "")
        upsert_kwargs = events_chain.upsert.call_args[0][0]
        self.assertEqual(upsert_kwargs["text"], "hello world")

    def test_no_op_for_missing_session_id(self):
        """Empty session_id returns empty string without DB calls."""
        with patch.object(persistence, "_table") as mock_table:
            result = run(persistence.save_transcript_event(None, 0, "bot", "hello"))  # type: ignore
        self.assertEqual(result, "")
        mock_table.assert_not_called()

    def test_no_op_for_empty_text(self):
        """Blank text returns empty string without DB calls."""
        with patch.object(persistence, "_table") as mock_table:
            result = run(persistence.save_transcript_event(SESSION_ID, 0, "bot", "   "))
        self.assertEqual(result, "")
        mock_table.assert_not_called()

    def test_returns_error_on_event_upsert_failure(self):
        """When transcript_events upsert fails, returns error code."""
        events_chain = self._make_events_chain(
            seq_data=None,
            upsert_data=None,
            upsert_error=True,
        )
        outbox_chain = _make_chain()

        def table_router(name):
            if name == "transcript_events":
                return events_chain
            elif name == "outbox":
                return outbox_chain
            return _make_chain()

        with patch.object(persistence, "_table", side_effect=table_router):
            error = run(persistence.save_transcript_event(
                SESSION_ID, 0, "bot", "hello"
            ))

        self.assertIn("transcript event", error)

    def test_no_client_returns_disabled(self):
        """When no client is available, returns persistence disabled error."""
        with patch.object(persistence, "_table", return_value=None):
            error = run(persistence.save_transcript_event(
                SESSION_ID, 0, "bot", "hello"
            ))
        self.assertIn("disabled", error)

    def test_event_durable_even_if_outbox_fails(self):
        """Event is persisted even when outbox insert fails."""
        events_chain = self._make_events_chain(
            seq_data=None,
            upsert_data={"id": EVENT_ID, "session_id": SESSION_ID, "turn_index": 0,
                         "speaker": "bot", "text": "Hello", "sequence": 1},
        )
        outbox_chain = _make_chain()
        outbox_exec = MagicMock()
        outbox_exec.data = None
        outbox_chain.execute.side_effect = Exception("outbox insert failed")

        def table_router(name):
            if name == "transcript_events":
                return events_chain
            elif name == "outbox":
                return outbox_chain
            return _make_chain()

        with patch.object(persistence, "_table", side_effect=table_router):
            error = run(persistence.save_transcript_event(
                SESSION_ID, 0, "bot", "Hello"
            ))

        self.assertIn("outbox", error, f"Expected outbox error, got: {error}")
        # Event upsert was called despite outbox failure
        events_chain.upsert.assert_called_once()

    def test_duplicate_turn_ignored(self):
        """Duplicate (session_id, turn_index) is silently ignored (idempotent)."""
        events_chain = _make_chain()
        # Four execute calls: seq, upsert, seq, upsert
        seq_exec_1 = MagicMock(); seq_exec_1.data = None
        upsert_exec_1 = MagicMock(); upsert_exec_1.data = {"id": EVENT_ID}
        seq_exec_2 = MagicMock(); seq_exec_2.data = None
        upsert_exec_2 = MagicMock(); upsert_exec_2.data = {"id": EVENT_ID}
        events_chain.execute.side_effect = [seq_exec_1, upsert_exec_1, seq_exec_2, upsert_exec_2]

        outbox_chain = _make_chain()

        def table_router(name):
            if name == "transcript_events":
                return events_chain
            elif name == "outbox":
                return outbox_chain
            return _make_chain()

        with patch.object(persistence, "_table", side_effect=table_router):
            error1 = run(persistence.save_transcript_event(SESSION_ID, 0, "bot", "Hello"))
            error2 = run(persistence.save_transcript_event(SESSION_ID, 0, "bot", "Hello"))

        self.assertEqual(error1, "")
        self.assertEqual(error2, "")

    def test_out_of_order_turn_inserts(self):
        """Out-of-order turn index (arrives late) inserts as new record."""
        events_chain = _make_chain()
        # First call: seq→None (no rows), upsert→turn 5, seq→{sequence:1}, upsert→turn 2
        seq_exec_1 = MagicMock(); seq_exec_1.data = None
        upsert_exec_1 = MagicMock(); upsert_exec_1.data = {
            "id": EVENT_ID, "turn_index": 5, "sequence": 1
        }
        seq_exec_2 = MagicMock(); seq_exec_2.data = {"sequence": 1}
        upsert_exec_2 = MagicMock(); upsert_exec_2.data = {
            "id": "event-2", "turn_index": 2, "sequence": 2
        }
        events_chain.execute.side_effect = [seq_exec_1, upsert_exec_1, seq_exec_2, upsert_exec_2]

        outbox_chain = _make_chain()

        def table_router(name):
            if name == "transcript_events":
                return events_chain
            elif name == "outbox":
                return outbox_chain
            return _make_chain()

        with patch.object(persistence, "_table", side_effect=table_router):
            error1 = run(persistence.save_transcript_event(SESSION_ID, 5, "bot", "Turn five"))
            error2 = run(persistence.save_transcript_event(SESSION_ID, 2, "candidate", "Turn two late"))

        self.assertEqual(error1, "", f"First call failed: {error1}")
        self.assertEqual(error2, "", f"Second call failed: {error2}")


# ═══════════════════════════════════════════════════════════════════════
#  2. get_transcript_events
# ═══════════════════════════════════════════════════════════════════════

class TestGetTranscriptEvents(unittest.TestCase):
    """Test REL-02/03 get_transcript_events persistence helper."""

    def test_returns_events_ordered_by_sequence(self):
        """Returns events sorted by sequence number."""
        rows = [
            {"id": "e1", "session_id": SESSION_ID, "turn_index": 0,
             "speaker": "bot", "text": "first", "sequence": 1},
            {"id": "e2", "session_id": SESSION_ID, "turn_index": 5,
             "speaker": "candidate", "text": "second", "sequence": 2},
        ]
        chain = _make_chain()
        exec_result = MagicMock()
        exec_result.data = rows
        chain.execute.return_value = exec_result

        with patch.object(persistence, "_table", return_value=chain):
            result = run(persistence.get_transcript_events(SESSION_ID))

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["turn_index"], 0)
        self.assertEqual(result[1]["turn_index"], 5)

    def test_returns_empty_list_for_no_events(self):
        """Session with no events returns empty list."""
        chain = _make_chain()
        exec_result = MagicMock()
        exec_result.data = []
        chain.execute.return_value = exec_result

        with patch.object(persistence, "_table", return_value=chain):
            result = run(persistence.get_transcript_events(SESSION_ID))
        self.assertEqual(result, [])

    def test_returns_empty_list_for_missing_session_id(self):
        """None session_id returns empty list."""
        result = run(persistence.get_transcript_events(""))
        self.assertEqual(result, [])

    def test_returns_empty_list_when_client_disabled(self):
        """No _table returns empty list."""
        with patch.object(persistence, "_table", return_value=None):
            result = run(persistence.get_transcript_events(SESSION_ID))
        self.assertEqual(result, [])

    def test_returns_empty_list_on_db_error(self):
        """DB error returns empty list."""
        chain = _make_chain()
        chain.execute.side_effect = Exception("DB error")

        with patch.object(persistence, "_table", return_value=chain):
            result = run(persistence.get_transcript_events(SESSION_ID))
        self.assertEqual(result, [])


# ═══════════════════════════════════════════════════════════════════════
#  3. _get_next_sequence (internal helper)
# ═══════════════════════════════════════════════════════════════════════

class TestGetNextSequence(unittest.TestCase):
    """Test the internal _get_next_sequence helper."""

    def test_returns_1_when_no_existing_rows(self):
        """No existing events returns 1."""
        with patch.object(persistence, "_table", return_value=None):
            seq = persistence._get_next_sequence(SESSION_ID)
        self.assertEqual(seq, 1)

    def test_returns_incremented_value(self):
        """Existing sequence of 5 returns 6."""
        chain = _make_chain()
        exec_result = MagicMock()
        exec_result.data = {"sequence": 5}
        chain.execute.return_value = exec_result

        with patch.object(persistence, "_table", return_value=chain):
            seq = persistence._get_next_sequence(SESSION_ID)
        self.assertEqual(seq, 6)

    def test_returns_1_on_db_error(self):
        """DB error falls back to 1."""
        chain = _make_chain()
        chain.execute.side_effect = Exception("DB error")

        with patch.object(persistence, "_table", return_value=chain):
            seq = persistence._get_next_sequence(SESSION_ID)
        self.assertEqual(seq, 1)


if __name__ == "__main__":
    unittest.main()
