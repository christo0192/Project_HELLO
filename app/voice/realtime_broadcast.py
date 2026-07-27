"""
Fire-and-forget Supabase Realtime broadcast for interim STT transcripts.

Uses the Realtime broadcast HTTP API (no WebSocket needed) so the voice
server can push partial transcripts to the dashboard channel without
any persistent connection overhead.

All errors are swallowed — a broadcast failure must NEVER affect the call.
"""

import os
import time
from typing import Dict

import httpx

# Module-level throttle state: last-sent monotonic timestamp per session.
_last_send: Dict[str, float] = {}
_THROTTLE_SECS = 0.25
_HTTP_TIMEOUT = 2.0


def _broadcast_url() -> str:
    return os.environ["SUPABASE_URL"].rstrip("/") + "/realtime/v1/api/broadcast"


def _headers() -> dict:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def broadcast_interim(session_id: str, text: str) -> None:
    """Broadcast an interim transcript to the dashboard — fire-and-forget.

    Throttled to at most one send per 0.25 s per session so rapid Flux
    updates don't overwhelm Realtime.  Errors are silently swallowed.
    """
    now = time.monotonic()
    if now - _last_send.get(session_id, 0.0) < _THROTTLE_SECS:
        return
    _last_send[session_id] = now

    body = {
        "messages": [
            {
                "topic": f"live-call:session:{session_id}",
                "event": "interim",
                "payload": {"text": text},
            }
        ]
    }
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            await client.post(_broadcast_url(), headers=_headers(), json=body)
    except Exception:  # noqa: BLE001
        pass


async def clear_interim(session_id: str) -> None:
    """Broadcast an empty payload to clear the typing bubble on the dashboard.

    Resets the throttle timer so the clear always fires immediately.
    """
    _last_send.pop(session_id, None)  # reset throttle so clear is never dropped

    body = {
        "messages": [
            {
                "topic": f"live-call:session:{session_id}",
                "event": "interim",
                "payload": {"text": ""},
            }
        ]
    }
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            await client.post(_broadcast_url(), headers=_headers(), json=body)
    except Exception:  # noqa: BLE001
        pass
