"""Supabase persistence helpers for the LiveKit screening worker.

LiveKit rooms are created by the dashboard API. The room metadata carries the
existing ``screening_v2.call_sessions.id``; this worker writes live transcript
turns against that id, completes the session, and triggers the same API scoring
route used by the old Pipecat flow.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx

try:
    from supabase import create_client
except ImportError:  # pragma: no cover - keeps console mode usable without persistence deps
    create_client = None


SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")
logger = logging.getLogger("voice-livekit.persistence")
_client = None


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
        logger.info(f"[livekit-transcript] {speaker}: {text[:80]}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[livekit-db] save_turn failed: {exc}")


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
        logger.info(f"[livekit-db] call_session {session_id} completed")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[livekit-db] complete_session failed: {exc}")


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
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[livekit-db] fail_session failed: {exc}")


async def trigger_scoring(session_id: Optional[str]) -> None:
    if not session_id:
        return
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(f"{API_BASE}/api/assess/{session_id}")
            logger.info(f"[livekit-score] triggered for {session_id}: HTTP {response.status_code}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[livekit-score] scoring trigger failed: {exc}")
