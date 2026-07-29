"""Supabase persistence helpers for the LiveKit screening worker.

LiveKit rooms are created by the dashboard API. The room metadata carries the
existing ``screening_v2.call_sessions.id``; this worker writes live transcript
turns against that id, completes the session, and triggers the same API scoring
route used by the old Pipecat flow.

LLM-06 adds provenance claiming via ``set_session_provenance()`` with
compare-and-set semantics. OBS-01/OBS-02 route output through the redacting
``StructuredLogger`` and propagate ``X-Correlation-ID``. REL-05/REL-06 protect
the scoring trigger with a circuit breaker, explicit transport timeouts, lazy
transport construction, typed outcomes, and a closed failure-reason mapping.
No transcript text, raw exceptions, session IDs, URLs, response bodies, or raw
provenance values are logged.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from provider_resilience import (
    BusinessError,
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitState,
    ProviderError,
    RealClock,
    call_with_breaker,
    configure_scoring_transport,
    get_scoring_transport,
    parse_env_float,
    parse_env_int,
)

try:
    from supabase import create_client
except ImportError:  # pragma: no cover — keeps console mode usable without persistence deps
    create_client = None

from observability import StructuredLogger, get_correlation_id

SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")

_log = StructuredLogger("persistence")
_client = None


# ── Provenance claim result enum ───────────────────────────────────────

class ClaimResult:
    """Result of a provenance claim attempt."""

    CLAIMED = "claimed"
    ALREADY_MATCHING = "already_matching"
    CONFLICT = "conflict"
    MISSING = "missing"
    ERROR = "error"


class TriggerOutcome(Enum):
    """Typed result of the breaker-protected scoring trigger."""

    SUCCESS = "success"
    BREAKER_OPEN = "breaker_open"
    TRANSPORT_FAILURE = "transport_failure"
    BUSINESS_ERROR = "business_error"


_FAIL_REASON_CODES = frozenset({"error", "timeout", "disconnect", "unknown"})


def _safe_reason_code(reason: str) -> str:
    code = reason.strip().lower().replace(" ", "_")
    return code if code in _FAIL_REASON_CODES else "unknown"


_SCORING_BREAKER = CircuitBreaker(CircuitBreakerConfig(
    failure_threshold=parse_env_int(
        os.getenv("SCORING_BREAKER_THRESHOLD"), 3, min_val=1, max_val=100,
    ),
    cooldown_sec=parse_env_float(
        os.getenv("SCORING_BREAKER_COOLDOWN_SEC"), 30.0, min_val=1.0, max_val=600.0,
    ),
    timeout_sec=parse_env_float(
        os.getenv("SCORING_BREAKER_TIMEOUT_SEC"),
        180.0,
        min_val=1.0,
        max_val=600.0,
        allow_zero=False,
    ),
    clock=RealClock(),
))

configure_scoring_transport(
    connect_timeout=parse_env_float(
        os.getenv("SCORING_HTTP_CONNECT_TIMEOUT"), 10.0, min_val=1.0, max_val=120.0,
    ),
    read_timeout=parse_env_float(
        os.getenv("SCORING_HTTP_READ_TIMEOUT"), 180.0, min_val=1.0, max_val=600.0,
    ),
    write_timeout=parse_env_float(
        os.getenv("SCORING_HTTP_WRITE_TIMEOUT"), 30.0, min_val=1.0, max_val=120.0,
    ),
    pool_timeout=parse_env_float(
        os.getenv("SCORING_HTTP_POOL_TIMEOUT"), 10.0, min_val=1.0, max_val=120.0,
    ),
)


# ── Internal client ────────────────────────────────────────────────────

def _get_client():
    global _client
    if _client is not None:
        return _client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and create_client):
        _log.warn("db_error", error_category="supabase_creds_missing")
        return None
    _client = create_client(url, key)
    return _client


def _table(name: str):
    client = _get_client()
    return client.schema(SCHEMA).table(name) if client else None


# ── Provenance claiming (LLM-06) ──────────────────────────────────────

async def set_session_provenance(
    session_id: Optional[str],
    provenance: dict[str, Any],
) -> str:
    """
    Atomically claim provenance for a LiveKit session (compare-and-set).

    Uses an exact one-row UPDATE: ``WHERE id = ? AND provenance IS NULL``
    with ``.select("id")`` to confirm exactly one row affected.
    This ensures only the first claim succeeds.

    Returns one of ``ClaimResult.*`` values.

    Never logs the raw provenance dict or session identifier.
    """
    if not session_id:
        _log.warn("db_error", error_category="provenance_session_missing")
        return ClaimResult.MISSING

    def run():
        table = _table("call_sessions")
        if not table:
            return None
        result = (
            table.update({"provenance": provenance})
            .eq("id", session_id)
            .is_("provenance", "null")
            .select("id")
            .execute()
        )
        return result

    try:
        result = await asyncio.to_thread(run)
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="provenance_claim_failed")
        return ClaimResult.ERROR

    if result is None:
        _log.warn("db_error", error_category="provenance_store_missing")
        return ClaimResult.MISSING

    rows = result.data if hasattr(result, "data") else None
    if rows and len(rows) > 0:
        return ClaimResult.CLAIMED

    # Rows affected = 0 — provenance was not null.  Read current value to
    # distinguish ALREADY_MATCHING from CONFLICT.
    try:
        def read_provenance():
            tbl = _table("call_sessions")
            if not tbl:
                return None
            return tbl.select("provenance").eq("id", session_id).single().execute()

        session_result = await asyncio.to_thread(read_provenance)
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="provenance_read_failed")
        return ClaimResult.MISSING

    existing = None
    if session_result and hasattr(session_result, "data") and session_result.data:
        existing = session_result.data.get("provenance")

    if existing is None:
        _log.warn("db_error", error_category="provenance_claim_race")
        return ClaimResult.ERROR

    if existing == provenance:
        return ClaimResult.ALREADY_MATCHING

    _log.warn("db_error", error_category="provenance_conflict")
    return ClaimResult.CONFLICT


# ── Transcript persistence ─────────────────────────────────────────────

async def save_turn(session_id: Optional[str], turn_index: int, speaker: str, text: str) -> None:
    if not (session_id and text.strip()):
        return

    def run():
        table = _table("transcript_turns")
        if not table:
            return
        table.insert(
            {
                "session_id": session_id,
                "turn_index": turn_index,
                "speaker": speaker,
                "text": text.strip(),
            }
        ).execute()

    try:
        await asyncio.to_thread(run)
        # No transcript text or session ID logged.
        _log.info("db_turn_saved", turn_index=turn_index, speaker=speaker)
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="save_turn_failed")


async def complete_session(session_id: Optional[str], duration_sec: Optional[int] = None) -> None:
    if not session_id:
        return

    def run():
        table = _table("call_sessions")
        if not table:
            return
        table.update(
            {
                "status": "completed",
                "ended_at": datetime.now(timezone.utc).isoformat(),
                "duration_sec": duration_sec,
            }
        ).eq("id", session_id).execute()

    try:
        await asyncio.to_thread(run)
        # No session ID logged.
        _log.info("session_complete", duration_sec=duration_sec)
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="complete_session_failed")


async def fail_session(session_id: Optional[str], reason: str) -> None:
    """Mark a session failed without persisting raw provider/error text."""
    if not session_id:
        return

    safe_code = _safe_reason_code(reason)

    def run():
        table = _table("call_sessions")
        if not table:
            return
        table.update(
            {
                "status": "failed",
                "ended_at": datetime.now(timezone.utc).isoformat(),
                "external_call_id": safe_code,
            }
        ).eq("id", session_id).execute()

    try:
        await asyncio.to_thread(run)
        _log.info("session_fail")
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="fail_session_failed")


async def trigger_scoring(session_id: Optional[str]) -> TriggerOutcome:
    """Trigger scoring through the shared typed circuit-breaker boundary."""
    if not session_id:
        return TriggerOutcome.BUSINESS_ERROR

    # Reject before lazy httpx construction so open-state classification is
    # preserved even in minimal environments without the transport dependency.
    if _SCORING_BREAKER.state == CircuitState.OPEN:
        _log.warn("scoring_failed", error_category="circuit_open")
        return TriggerOutcome.BREAKER_OPEN

    try:
        transport = get_scoring_transport()
    except Exception:  # noqa: BLE001
        _log.warn("scoring_failed", error_category="connection")
        return TriggerOutcome.TRANSPORT_FAILURE

    headers: dict[str, str] = {}
    correlation_id = get_correlation_id()
    if correlation_id:
        headers["X-Correlation-ID"] = correlation_id

    try:
        response = await call_with_breaker(
            "POST",
            f"{API_BASE}/api/assess/{session_id}",
            breaker=_SCORING_BREAKER,
            transport=transport,
            headers=headers,
            endpoint_hint="assess",
            log_failures=False,
        )
        status = getattr(response, "status_code", None)
        if isinstance(status, int):
            _log.info("scoring_trigger", http_status=status)
        else:
            _log.info("scoring_trigger")
        return TriggerOutcome.SUCCESS
    except ProviderError as exc:
        _log.warn("scoring_failed", error_category=exc.category)
        if exc.category == "circuit_open":
            return TriggerOutcome.BREAKER_OPEN
        return TriggerOutcome.TRANSPORT_FAILURE
    except BusinessError:
        _log.warn("scoring_failed", error_category="business_error")
        return TriggerOutcome.BUSINESS_ERROR
