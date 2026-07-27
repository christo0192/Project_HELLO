"""
Supabase persistence (REST via supabase-py) for the screening voice service.

Reads/writes the `screening_v2` schema with the service_role key. The sync
supabase-py calls run in a thread (asyncio.to_thread) so they never block the
audio event loop. All ops are BEST-EFFORT — failures are logged, never crash the
call. Transcript turns are written LIVE (one row per turn) → the dashboard renders
the conversation in real time via Supabase Realtime.

NOTE: PostgREST must have screening_v2 in its schema cache —
`NOTIFY pgrst, 'reload schema';` is run by 0002_realtime_rls.sql after schema changes.
"""

import asyncio
import os
from datetime import datetime, timezone
from typing import Optional

from loguru import logger

try:
    from supabase import create_client
except ImportError:
    create_client = None

SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and create_client):
        logger.warning("[db] Supabase creds missing — persistence disabled (call still runs)")
        return None
    _client = create_client(url, key)
    return _client


def _table(name):
    c = _get_client()
    return c.schema(SCHEMA).table(name) if c else None


async def get_role(role_id: Optional[str]) -> Optional[dict]:
    if not role_id:
        return None

    def run():
        t = _table("roles")
        if not t:
            return None
        r = t.select("title,jd,required_skills,screening_template").eq("id", role_id).limit(1).execute()
        return r.data[0] if r.data else None

    try:
        return await asyncio.to_thread(run)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[db] get_role failed (continuing): {e}")
        return None


async def get_candidate(candidate_id: Optional[str]) -> Optional[dict]:
    if not candidate_id:
        return None

    def run():
        t = _table("candidates")
        if not t:
            return None
        r = t.select("name,parsed,role_id").eq("id", candidate_id).limit(1).execute()
        return r.data[0] if r.data else None

    try:
        return await asyncio.to_thread(run)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[db] get_candidate failed (continuing): {e}")
        return None


async def create_session(candidate_id: Optional[str], role_id: Optional[str] = None,
                         mode: str = "browser") -> Optional[str]:
    if not candidate_id:
        logger.warning("[db] no candidate_id — skipping call_session (test mode)")
        return None

    def run():
        t = _table("call_sessions")
        if not t:
            return None
        r = t.insert({
            "candidate_id": candidate_id, "role_id": role_id, "mode": mode,
            "provider": "pipecat", "status": "in_progress",
        }).execute()
        return r.data[0]["id"] if r.data else None

    try:
        sid = await asyncio.to_thread(run)
        if sid:
            logger.info(f"[db] call_session {sid} created")
        return sid
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[db] create_session failed (call continues): {e}")
        return None


async def save_turn(session_id: Optional[str], turn_index: int, speaker: str, text: str) -> None:
    """Write a single transcript turn immediately (drives the live dashboard)."""
    if not session_id:
        return

    def run():
        t = _table("transcript_turns")
        if not t:
            return
        t.insert({"session_id": session_id, "turn_index": turn_index,
                  "speaker": speaker, "text": text}).execute()

    try:
        await asyncio.to_thread(run)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[db] save_turn failed: {e}")


async def set_recording_url(session_id: Optional[str], recording_url: Optional[str]) -> None:
    if not (session_id and recording_url):
        return

    def run():
        t = _table("call_sessions")
        if not t:
            return
        t.update({"recording_url": recording_url}).eq("id", session_id).execute()

    try:
        await asyncio.to_thread(run)
        logger.info(f"[db] recording_url set for {session_id}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[db] set_recording_url failed: {e}")


async def complete_session(session_id: Optional[str], duration_sec: Optional[int] = None) -> None:
    if not session_id:
        return

    def run():
        t = _table("call_sessions")
        if not t:
            return
        t.update({
            "status": "completed",
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "duration_sec": duration_sec,
        }).eq("id", session_id).execute()

    try:
        await asyncio.to_thread(run)
        logger.info(f"[db] call_session {session_id} completed")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[db] complete_session failed: {e}")
