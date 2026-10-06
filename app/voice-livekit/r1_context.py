"""Fail-closed client for the isolated R1 worker context endpoint."""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Callable
from urllib.error import URLError
from urllib.request import Request, urlopen


class R1ContextError(RuntimeError):
    """The worker must not start an R1 interview without server context."""


def _endpoint(path: str) -> str:
    return (os.getenv("API_BASE") or "http://localhost:8787").rstrip("/") + path


def _request_json(path: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    secret = os.getenv("WORKER_CONTEXT_SECRET")
    if not secret:
        raise R1ContextError("r1_worker_auth_not_configured")
    request = Request(
        _endpoint(path), data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # nosec B310: configured internal API
            if response.status not in (200, 201):
                raise R1ContextError("r1_context_rejected")
            decoded = json.loads(response.read().decode("utf-8"))
    except (URLError, OSError, ValueError) as exc:
        raise R1ContextError("r1_context_unavailable") from exc
    if not isinstance(decoded, dict):
        raise R1ContextError("r1_context_invalid")
    return decoded


async def fetch_context(room: str, *, timeout: float = 10.0, requester: Callable[..., dict[str, Any]] = _request_json) -> dict[str, Any]:
    if not room:
        raise R1ContextError("r1_room_missing")
    try:
        context = await asyncio.to_thread(requester, "/api/internal/r1/context", {"room": room}, timeout)
    except Exception as exc:  # requester is injected in bare tests; fail closed too
        raise R1ContextError("r1_context_unavailable") from exc
    required = ("first_name", "round_id", "attempt_id", "attempt", "settings")
    if any(key not in context for key in required):
        raise R1ContextError("r1_context_incomplete")
    return context
