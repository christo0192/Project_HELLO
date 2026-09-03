"""Worker → API client for the in-worker recording path (PR A).

Two calls against the internal phone-worker surface (Bearer
``WORKER_CONTEXT_SECRET``, mounted at ``/api/internal/phone``):

  * :func:`prepare_recording` — runs the server-side CONSENT GATE and mints the
    presigned upload URL. Returns ``{object_key, upload_url}`` on success, or
    ``None`` on refusal / error. A ``None`` means "do NOT record".
  * :func:`complete_recording` — hands the finalizer the uploaded object's
    manifest (sha256 / size / duration); the finalizer re-downloads and
    re-hashes, so these are advisory.

FAIL-OPEN everywhere: recording is strictly secondary to the screening. Any
network/transport/HTTP failure degrades to "no recording", never a raised
exception into the call path. A ``post`` seam is injected so both calls are
unit-testable with no httpx/network.
"""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable, Optional

from observability import StructuredLogger, get_correlation_id
from provider_resilience import (
    BusinessError,
    CircuitBreaker,
    CircuitBreakerConfig,
    HttpxTransport,
    ProviderError,
    RealClock,
    call_with_breaker,
)

_log = StructuredLogger("recording-api")

API_BASE = os.getenv("API_BASE", "http://localhost:8787")
_RECORDING_BASE = "/api/internal/phone/recording"
_API_TIMEOUT_SEC = 15.0

_RECORDING_BREAKER = CircuitBreaker(CircuitBreakerConfig(
    failure_threshold=3,
    cooldown_sec=10.0,
    timeout_sec=max(_API_TIMEOUT_SEC, 1.0),
    clock=RealClock(),
))

# post(method, url, headers, json_body) -> response object exposing .json()
PostFn = Callable[[str, str, dict, dict], Awaitable[Any]]


def _get_transport():
    return HttpxTransport(
        connect_timeout=10.0,
        read_timeout=_API_TIMEOUT_SEC,
        write_timeout=10.0,
        pool_timeout=10.0,
        pool_connections=2,
        pool_maxsize=2,
    )


async def _default_post(method: str, url: str, headers: dict, json_body: dict) -> Any:
    return await call_with_breaker(
        method,
        url,
        breaker=_RECORDING_BREAKER,
        transport=_get_transport(),
        headers=headers,
        json_body=json_body,
        endpoint_hint="recording",
        log_failures=False,
    )


def _headers() -> Optional[dict]:
    secret = os.getenv("WORKER_CONTEXT_SECRET")
    if not secret:
        return None
    h = {"Content-Type": "application/json", "Authorization": f"Bearer {secret}"}
    cid = get_correlation_id()
    if cid:
        h["X-Correlation-ID"] = cid
    return h


async def prepare_recording(
    attempt_id: str,
    session_id: str,
    engagement_id: Optional[str] = None,
    *,
    post: PostFn = _default_post,
) -> Optional[dict[str, str]]:
    """Run the consent gate + mint an upload URL. Returns
    ``{"object_key": ..., "upload_url": ...}`` when the server BOUND the
    recording for upload, else ``None`` (refusal, no secret, or any error).
    Fail-open.

    ``engagement_id`` is OPTIONAL: the in-worker recorder calls this from the
    phone-session function, which has no engagement id in scope. When it is
    omitted the field is left OUT of the request body entirely and the server
    resolves it authoritatively from ``attempt_id``. Existing callers that pass
    it keep the current wire shape unchanged."""
    headers = _headers()
    if headers is None:
        return None
    body: dict[str, Any] = {"attempt_id": attempt_id, "session_id": session_id}
    if engagement_id is not None:
        body["engagement_id"] = engagement_id
    try:
        resp = await post(
            "POST", f"{API_BASE}{_RECORDING_BASE}/prepare", headers, body,
        )
        data = getattr(resp, "json", lambda: {})()
    except (ProviderError, BusinessError):
        _log.info("unknown_event", error_type="phone_recording_prepare",
                  error_category="api_error")
        return None
    except Exception:  # noqa: BLE001
        _log.info("unknown_event", error_type="phone_recording_prepare",
                  error_category="unexpected")
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        return None
    object_key = data.get("object_key")
    upload_url = data.get("upload_url")
    if not isinstance(object_key, str) or not isinstance(upload_url, str):
        return None
    return {"object_key": object_key, "upload_url": upload_url}


async def fail_recording(
    attempt_id: str,
    session_id: str,
    reason: str,
    *,
    post: PostFn = _default_post,
) -> bool:
    """Tell the server the in-worker recording is PERMANENTLY gone.

    The worker deletes its local OGG/MP3 in ``finish()``'s cleanup, so a failed
    close/transcode/upload can never be retried from this side — without this
    report the finalizer keeps re-downloading an object that was never PUT until
    it exhausts (`object_unreadable` x6, live 2026-09-03) and the session stays
    `active` ("Recording is still processing") forever. Returns True iff the
    server latched the failure. Fail-open (False on any error)."""
    headers = _headers()
    if headers is None:
        return False
    body: dict[str, Any] = {
        "attempt_id": attempt_id, "session_id": session_id,
        "reason": str(reason)[:64],
    }
    try:
        resp = await post("POST", f"{API_BASE}{_RECORDING_BASE}/failed", headers, body)
        data = getattr(resp, "json", lambda: {})()
    except (ProviderError, BusinessError):
        _log.info("unknown_event", error_type="phone_recording_failed_report",
                  error_category="api_error")
        return False
    except Exception:  # noqa: BLE001
        _log.info("unknown_event", error_type="phone_recording_failed_report",
                  error_category="unexpected")
        return False
    return bool(isinstance(data, dict) and data.get("ok"))


async def complete_recording(
    attempt_id: str,
    session_id: str,
    sha256: str,
    size_bytes: int,
    duration_ms: Optional[int],
    *,
    post: PostFn = _default_post,
) -> bool:
    """Tell the finalizer the object was uploaded. Returns True iff the server
    reported the recording ready. Fail-open (False on any error)."""
    headers = _headers()
    if headers is None:
        return False
    body: dict[str, Any] = {
        "attempt_id": attempt_id, "session_id": session_id,
        "sha256": sha256, "size_bytes": size_bytes,
    }
    if duration_ms is not None:
        body["duration_ms"] = duration_ms
    try:
        resp = await post("POST", f"{API_BASE}{_RECORDING_BASE}/complete", headers, body)
        data = getattr(resp, "json", lambda: {})()
    except (ProviderError, BusinessError):
        _log.info("unknown_event", error_type="phone_recording_complete",
                  error_category="api_error")
        return False
    except Exception:  # noqa: BLE001
        _log.info("unknown_event", error_type="phone_recording_complete",
                  error_category="unexpected")
        return False
    return bool(isinstance(data, dict) and data.get("ok"))
