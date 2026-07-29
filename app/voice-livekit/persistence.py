"""Supabase persistence helpers for the LiveKit screening worker.

LiveKit rooms are created by the dashboard API. The room metadata carries the
existing ``screening_v2.call_sessions.id``; this worker writes live transcript
turns against that id, completes the session, and triggers the same API scoring
route used by the old Pipecat flow.

OUTBOUND BOUNDARIES:
  1. Supabase DB queries (via sync supabase-py client in asyncio.to_thread).
     NOTE: supabase-py is a local library dependency; no circuit breaker wraps
     it. A future PR should add per-query timeouts and a backoff wrapper.
  2. HTTP POST to API_BASE/api/assess/{session_id} for scoring trigger.
     This uses the circuit breaker in provider_resilience.py with explicit
     connect/read/write/pool timeouts and non-disclosing diagnostics.

LOGGING: All log messages use stable event codes — no session IDs,
transcript excerpts, raw exceptions, or candidate identifiers.
FAIL_SESSION: Uses a closed reason-code mapping; never stores raw reason text.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from provider_resilience import (
    CircuitBreaker,
    CircuitBreakerConfig,
    call_with_breaker,
    get_scoring_transport,
    configure_scoring_transport,
    parse_env_float,
    parse_env_int,
    RealClock,
    ProviderError,
    BusinessError,
    redacted_log_message,
)

try:
    from supabase import create_client
except ImportError:  # pragma: no cover - keeps console mode usable without persistence deps
    create_client = None


SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")
logger = logging.getLogger("voice-livekit.persistence")
_client = None


# ── Closed reason-code mapping for fail_session ───────────────────
# Never store raw reason text from exceptions or candidate data.
_FAIL_REASON_CODES: dict[str, str] = {
    "error": "error",
    "timeout": "timeout",
    "disconnect": "disconnect",
    "unknown": "unknown",
}


def _safe_reason_code(reason: str) -> str:
    """Map a reason to a closed set of codes. Never exposes raw text."""
    code = reason.strip().lower().replace(" ", "_")
    if code in _FAIL_REASON_CODES:
        return _FAIL_REASON_CODES[code]
    # Not in allowlist — map to "unknown"
    return "unknown"


# ── Circuit breaker for scoring-trigger HTTP ─────────────────────

# Configure transport lazily — does NOT construct httpx at import time
_SCORING_BREAKER_THRESHOLD = parse_env_int(os.getenv("SCORING_BREAKER_THRESHOLD"), 3, min_val=1, max_val=100)
_SCORING_BREAKER_COOLDOWN = parse_env_float(os.getenv("SCORING_BREAKER_COOLDOWN_SEC"), 30.0, min_val=1.0, max_val=600.0)
_SCORING_BREAKER_TIMEOUT = parse_env_float(os.getenv("SCORING_BREAKER_TIMEOUT_SEC"), 180.0, min_val=1.0, max_val=600.0, allow_zero=False)

_SCORING_BREAKER = CircuitBreaker(CircuitBreakerConfig(
    failure_threshold=_SCORING_BREAKER_THRESHOLD,
    cooldown_sec=_SCORING_BREAKER_COOLDOWN,
    timeout_sec=_SCORING_BREAKER_TIMEOUT,
    clock=RealClock(),
))

# Configure transport parameters (lazy — httpx constructed on first call)
configure_scoring_transport(
    connect_timeout=parse_env_float(os.getenv("SCORING_HTTP_CONNECT_TIMEOUT"), 10.0, min_val=1.0, max_val=120.0),
    read_timeout=parse_env_float(os.getenv("SCORING_HTTP_READ_TIMEOUT"), 180.0, min_val=1.0, max_val=600.0),
    write_timeout=parse_env_float(os.getenv("SCORING_HTTP_WRITE_TIMEOUT"), 30.0, min_val=1.0, max_val=120.0),
    pool_timeout=parse_env_float(os.getenv("SCORING_HTTP_POOL_TIMEOUT"), 10.0, min_val=1.0, max_val=120.0),
)


class TriggerOutcome(Enum):
    """Typed outcome for trigger_scoring — lets callers/test know what happened."""
    SUCCESS = "success"
    BREAKER_OPEN = "breaker_open"
    TRANSPORT_FAILURE = "transport_failure"
    BUSINESS_ERROR = "business_error"  # e.g. 404, session not found


# ── Supabase client ─────────────────────────────────────────────


def _get_client():
    global _client
    if _client is not None:
        return _client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and create_client):
        logger.warning("[livekit-db] unconfigured")
        return None
    _client = create_client(url, key)
    return _client


def _table(name: str):
    client = _get_client()
    return client.schema(SCHEMA).table(name) if client else None


# ── Persistence operations ────────────────────────────────────────


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
        logger.info("[livekit-transcript] ok")
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] turn_save_failed")


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
        logger.info("[livekit-db] session_completed")
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] complete_failed")


async def fail_session(session_id: Optional[str], reason: str) -> None:
    """Mark a session as failed using a closed reason-code mapping.

    The `reason` is mapped to a safe allowlisted code — never stores raw
    reason text, exception messages, or candidate data."""
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
        logger.info("[livekit-db] session_failed")
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] fail_failed")


async def trigger_scoring(session_id: Optional[str]) -> TriggerOutcome:
    """Trigger scoring via circuit-breaker-protected HTTP call.

    Returns a typed TriggerOutcome for callers/tests. The transport is
    constructed lazily — httpx import happens only on first actual scoring
    call, not at module import time.

    Logging happens at the call_with_breaker level — no double-log here.

    NOTE: reconciliation (REL-09) is not implemented. A failed trigger
    is logged but not automatically retried or re-queued at this stage.
    """
    if not session_id:
        return TriggerOutcome.BUSINESS_ERROR

    try:
        transport = get_scoring_transport()
    except Exception:  # noqa: BLE001
        # Construction failure (e.g., httpx not installed, config error)
        # counts as transport failure through the breaker.
        logger.warning(redacted_log_message("connection", "assess"))
        return TriggerOutcome.TRANSPORT_FAILURE

    try:
        await call_with_breaker(
            "POST",
            f"{API_BASE}/api/assess/{session_id}",
            breaker=_SCORING_BREAKER,
            transport=transport,
            endpoint_hint="assess",
        )
        return TriggerOutcome.SUCCESS
    except ProviderError as exc:
        if exc.category == "circuit_open":
            return TriggerOutcome.BREAKER_OPEN
        return TriggerOutcome.TRANSPORT_FAILURE
    except BusinessError:
        return TriggerOutcome.BUSINESS_ERROR
