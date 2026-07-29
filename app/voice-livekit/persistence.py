"""Supabase persistence helpers for the LiveKit screening worker.

LiveKit rooms are created by the dashboard API. The room metadata carries the
existing ``screening_v2.call_sessions.id``; this worker writes live transcript
turns against that id, completes the session, and triggers the same API scoring
route used by the old Pipecat flow.

LLM-06: Adds provenance claiming via set_session_provenance() with
compare-and-set CAS semantics.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

try:
    from supabase import create_client
except ImportError:  # pragma: no cover - keeps console mode usable without persistence deps
    create_client = None


SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")
logger = logging.getLogger("voice-livekit.persistence")
_client = None


# ── Provenance claim result enum ───────────────────────────────────────

class ClaimResult:
    """Result of a provenance claim attempt.

    - CLAIMED: first-time claim succeeded (null → value)
    - ALREADY_MATCHING: provenance already set to the exact same value
    - CONFLICT: provenance already set to a DIFFERENT value (immutable conflict)
    - MISSING: expected table/column not found
    - ERROR: transport or server error
    """
    CLAIMED = "claimed"
    ALREADY_MATCHING = "already_matching"
    CONFLICT = "conflict"
    MISSING = "missing"
    ERROR = "error"


# ── Internal client ────────────────────────────────────────────────────

def _get_client():
    global _client
    if _client is not None:
        return _client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and create_client):
        logger.warning("[livekit-db] Supabase creds missing - persistence disabled")
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

    Never logs the raw provenance dict — only the session_id and result type.
    """
    if not session_id:
        logger.warning("set_session_provenance MISSING session_id none")
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
    except Exception:
        logger.warning("set_session_provenance ERROR session=%s", session_id)
        return ClaimResult.ERROR

    if result is None:
        logger.warning("set_session_provenance MISSING session=%s", session_id)
        return ClaimResult.MISSING

    rows = result.data if hasattr(result, "data") else None
    if rows and len(rows) > 0:
        logger.info("set_session_provenance CLAIMED session=%s", session_id)
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
    except Exception:
        logger.warning("set_session_provenance MISSING session=%s", session_id)
        return ClaimResult.MISSING

    existing = None
    if session_result and hasattr(session_result, "data") and session_result.data:
        existing = session_result.data.get("provenance")

    if existing is None:
        logger.warning("set_session_provenance ERROR session=%s race", session_id)
        return ClaimResult.ERROR

    if existing == provenance:
        logger.info("set_session_provenance ALREADY_MATCHING session=%s", session_id)
        return ClaimResult.ALREADY_MATCHING

    logger.warning("set_session_provenance CONFLICT session=%s", session_id)
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
        logger.info("save_turn session=%s turn=%d speaker=%s", session_id, turn_index, speaker)
    except Exception as exc:
        logger.warning("save_turn failed session=%s: %s", session_id, exc)


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
        logger.info("call_session %s completed", session_id)
    except Exception as exc:
        logger.warning("complete_session failed session=%s: %s", session_id, exc)


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
    except Exception as exc:
        logger.warning("fail_session failed session=%s: %s", session_id, exc)


async def trigger_scoring(session_id: Optional[str]) -> None:
    if not session_id:
        return
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(f"{API_BASE}/api/assess/{session_id}")
            logger.info("scoring triggered session=%s HTTP %d", session_id, response.status_code)
    except Exception as exc:
        logger.warning("scoring trigger failed session=%s: %s", session_id, exc)
