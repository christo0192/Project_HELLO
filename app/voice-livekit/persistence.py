"""Supabase persistence helpers for the LiveKit screening worker.

LiveKit rooms are created by the dashboard API. The room metadata carries the
existing ``screening_v2.call_sessions.id``; this worker writes live transcript
turns against that id, completes the session, and triggers the same API scoring
route used by the old Pipecat flow.

OBS-01/OBS-02: all log output goes through StructuredLogger with redaction.
No transcript text, raw exceptions, session IDs, URLs, or response bodies are
logged.  The scoring trigger propagates X-Correlation-ID to the API.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Optional

try:
    import httpx
except ImportError:  # pragma: no cover — keeps syntax-check mode usable
    httpx = None  # type: ignore[assignment]

try:
    from supabase import create_client
except ImportError:  # pragma: no cover — keeps console mode usable without persistence deps
    create_client = None

from observability import StructuredLogger, get_correlation_id

SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")

_log = StructuredLogger("persistence")
_client = None


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
        # No transcript text, no session ID logged.
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
    if not session_id:
        return

    def run():
        table = _table("call_sessions")
        if not table:
            return
        table.update(
            {
                "status": "failed",
                "ended_at": datetime.now(timezone.utc).isoformat(),
                "external_call_id": reason[:200],
            }
        ).eq("id", session_id).execute()

    try:
        await asyncio.to_thread(run)
        _log.info("session_fail")
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="fail_session_failed")


async def trigger_scoring(session_id: Optional[str]) -> bool:
    """Post to the scoring API; return True on 2xx, False otherwise."""
    if not session_id:
        return False
    if httpx is None:  # pragma: no cover
        _log.warn("db_error", error_category="httpx_unavailable")
        return False

    # Propagate correlation ID to the API (OBS-02).
    headers: dict[str, str] = {}
    cid = get_correlation_id()
    if cid:
        headers["X-Correlation-ID"] = cid

    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(
                f"{API_BASE}/api/assess/{session_id}",
                headers=headers,
            )
            # Log HTTP status only — no URL, no response body, no session ID.
            sc = response.status_code
            if isinstance(sc, int) and 200 <= sc < 300:
                _log.info("scoring_trigger", http_status=sc)
                return True
            # Non-2xx: use deterministic taxonomy
            if not isinstance(sc, int) or sc < 100 or sc > 599:
                cat = "invalid_status"
            elif 100 <= sc < 200:
                cat = "http_informational"
            elif 300 <= sc < 400:
                cat = "http_redirect"
            elif 400 <= sc < 500:
                cat = "http_client_error"
            else:
                cat = "http_server_error"
            _log.warn("scoring_failed", http_status=sc,
                      error_category=cat)
            return False
    except Exception:  # noqa: BLE001
        _log.warn("scoring_failed", error_category="http_error")
        return False
