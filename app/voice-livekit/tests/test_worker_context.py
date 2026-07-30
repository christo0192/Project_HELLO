"""Offline deterministic tests for worker context resolution in persistence.py.

All tests run with asyncio.run() — no external dependencies required.
The supabase client is mocked so no real DB calls are made.
httpx is installed so we patch specific functions instead of module-level stubs.
"""

import asyncio
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch, call

# ── Stub supabase before importing persistence ────────────────────────

_mock_supabase_mod = types.ModuleType("supabase")
_mock_create_client = MagicMock(name="create_client")
_mock_supabase_mod.create_client = _mock_create_client  # type: ignore[attr-defined]
sys.modules.setdefault("supabase", _mock_supabase_mod)

import persistence  # noqa: E402

from persistence import WorkerContext, parse_worker_context  # noqa: E402
from persistence import ProviderError, BusinessError  # noqa: E402

SESSION_ID = "550e8400-e29b-41d4-a716-446655440000"
ROOM_NAME = f"screening-{SESSION_ID}"
CANDIDATE_ID = "660e8400-e29b-41d4-a716-446655440001"


def run(coro):
    return asyncio.run(coro)


class TestWorkerContext(unittest.TestCase):
    """Tests for WorkerContext data class and parse_worker_context."""

    def test_worker_context_holds_expected_fields(self):
        ctx = WorkerContext(
            session_id=SESSION_ID,
            candidate_id=CANDIDATE_ID,
            role_id="role-123",
            candidate_name="Test Candidate",
            room_name=ROOM_NAME,
            status="waiting",
        )
        self.assertEqual(ctx.session_id, SESSION_ID)
        self.assertEqual(ctx.candidate_id, CANDIDATE_ID)
        self.assertEqual(ctx.role_id, "role-123")
        self.assertEqual(ctx.candidate_name, "Test Candidate")
        self.assertEqual(ctx.room_name, ROOM_NAME)
        self.assertEqual(ctx.status, "waiting")

    def test_worker_context_none_role_and_name(self):
        ctx = WorkerContext(
            session_id=SESSION_ID,
            candidate_id=CANDIDATE_ID,
            role_id=None,
            candidate_name=None,
            room_name=ROOM_NAME,
            status="in_progress",
        )
        self.assertIsNone(ctx.role_id)
        self.assertIsNone(ctx.candidate_name)

    def test_parse_worker_context_from_dict(self):
        data = {
            "session_id": SESSION_ID,
            "candidate_id": CANDIDATE_ID,
            "role_id": "role-123",
            "candidate_name": "Test Candidate",
            "room_name": ROOM_NAME,
            "status": "waiting",
        }
        ctx = parse_worker_context(data)
        self.assertEqual(ctx.session_id, SESSION_ID)
        self.assertEqual(ctx.candidate_name, "Test Candidate")

    def test_parse_worker_context_missing_fields_default_to_empty(self):
        data = {
            "session_id": SESSION_ID,
            "room_name": ROOM_NAME,
            "status": "waiting",
        }
        ctx = parse_worker_context(data)
        self.assertEqual(ctx.session_id, SESSION_ID)
        self.assertEqual(ctx.candidate_id, "")
        self.assertIsNone(ctx.role_id)
        self.assertIsNone(ctx.candidate_name)

    def test_parse_worker_context_candidate_name_none(self):
        data = {
            "session_id": SESSION_ID,
            "candidate_id": CANDIDATE_ID,
            "candidate_name": None,
            "room_name": ROOM_NAME,
            "status": "waiting",
        }
        ctx = parse_worker_context(data)
        self.assertIsNone(ctx.candidate_name)


class TestResolveWorkerContext(unittest.TestCase):
    """Tests for resolve_worker_context.

    Uses patch on persistence.call_with_breaker to avoid real HTTP calls.
    """

    def setUp(self):
        self.env_patcher = patch.dict(
            os.environ,
            {"WORKER_CONTEXT_SECRET": "synthetic-worker-context-secret-1234567890"},
        )
        self.env_patcher.start()
        self.addCleanup(self.env_patcher.stop)
        # Create a magic mock response for 200 OK
        self.mock_response = MagicMock()
        self.mock_response.status_code = 200
        self.mock_response.json.return_value = {
            "ok": True,
            "context": {
                "session_id": SESSION_ID,
                "candidate_id": CANDIDATE_ID,
                "role_id": None,
                "candidate_name": "Test Candidate",
                "room_name": ROOM_NAME,
                "status": "waiting",
            },
        }

    def test_successful_resolution(self):
        """Valid session and room returns WorkerContext."""
        with patch.object(
            persistence, "call_with_breaker", return_value=self.mock_response
        ) as mock_call:
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))

            self.assertIsInstance(result, WorkerContext)
            self.assertEqual(result.session_id, SESSION_ID)
            self.assertEqual(result.candidate_id, CANDIDATE_ID)
            self.assertEqual(result.candidate_name, "Test Candidate")
            self.assertEqual(result.room_name, ROOM_NAME)

    def test_api_404_raises_business_error(self):
        """404 from API raises BusinessError → returns context_not_found."""
        with patch.object(
            persistence, "call_with_breaker", side_effect=BusinessError()
        ):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertEqual(result, "context_not_found")

    def test_api_403_raises_business_error(self):
        """403 from API raises BusinessError → returns context_not_found."""
        with patch.object(
            persistence, "call_with_breaker", side_effect=BusinessError()
        ):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertEqual(result, "context_not_found")

    def test_api_500_raises_provider_error(self):
        """5xx from API raises ProviderError → returns context_api_error."""
        with patch.object(
            persistence, "call_with_breaker", side_effect=ProviderError("protocol")
        ):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertEqual(result, "context_api_error")

    def test_transport_error_returns_api_error(self):
        """Transport failure raises ProviderError → returns context_api_error."""
        with patch.object(
            persistence, "call_with_breaker", side_effect=ProviderError("timeout")
        ):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertEqual(result, "context_api_error")

    def test_invalid_uuid_returns_not_found(self):
        """Non-UUID session_id returns context_not_found without API call."""
        result = run(persistence.resolve_worker_context("not-a-uuid", ROOM_NAME))
        self.assertIsInstance(result, str)
        self.assertEqual(result, "context_not_found")

    def test_empty_session_id_returns_not_found(self):
        """Empty session_id returns context_not_found without API call."""
        result = run(persistence.resolve_worker_context("", ROOM_NAME))
        self.assertIsInstance(result, str)
        self.assertEqual(result, "context_not_found")

    def test_success_with_candidate_name_none(self):
        """Worker context with null candidate name returns WorkerContext."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "ok": True,
            "context": {
                "session_id": SESSION_ID,
                "candidate_id": CANDIDATE_ID,
                "role_id": None,
                "candidate_name": None,
                "room_name": ROOM_NAME,
                "status": "waiting",
            },
        }
        with patch.object(persistence, "call_with_breaker", return_value=mock_resp):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertIsInstance(result, WorkerContext)
            self.assertIsNone(result.candidate_name)

    def test_api_returns_ok_false(self):
        """API returns {ok: false} → returns context_not_found."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": False, "error": "ERR_SESSION_NOT_FOUND"}
        with patch.object(persistence, "call_with_breaker", return_value=mock_resp):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertEqual(result, "context_not_found")

    def test_sends_bearer_credential_when_env_set(self):
        """When WORKER_CONTEXT_SECRET is set, Authorization header is sent."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "ok": True,
            "context": {
                "session_id": SESSION_ID,
                "candidate_id": CANDIDATE_ID,
                "role_id": None,
                "candidate_name": "Test",
                "room_name": ROOM_NAME,
                "status": "waiting",
            },
        }
        with (
            patch.object(persistence, "call_with_breaker", return_value=mock_resp) as mock_call,
            patch.dict(os.environ, {"WORKER_CONTEXT_SECRET": "my-super-secret-worker-key-12345"}),
        ):
            result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
            self.assertIsInstance(result, WorkerContext)
            # Verify that call_with_breaker was called with Authorization header
            call_kwargs = mock_call.call_args[1]
            headers = call_kwargs.get("headers", {})
            self.assertIn("Authorization", headers)
            self.assertEqual(headers["Authorization"], "Bearer my-super-secret-worker-key-12345")

    def test_fails_closed_when_bearer_is_not_configured(self):
        """Without WORKER_CONTEXT_SECRET the worker must not call the API."""
        with patch.object(persistence, "call_with_breaker") as mock_call:
            with patch.dict(os.environ, {}, clear=True):
                result = run(persistence.resolve_worker_context(SESSION_ID, ROOM_NAME))
                self.assertEqual(result, "context_api_error")
                mock_call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
