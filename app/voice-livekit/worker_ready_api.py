"""Worker → API readiness handshake for on-demand Fly orchestration (PR B).

phone-cost-and-scale-plan §2.2/§2.3: when the phone worker pool is scaled to
zero, the API must not place a PSTN call until a machine is STARTED, REGISTERED
with LiveKit and confirmed READY for the session it was claimed for. This module
is the worker end of that handshake: it POSTs
``/api/internal/voice-worker/ready {app, machine_id, session_id, epoch}`` so the
API's ``ensureReadyWorker`` poll can stop waiting and let the dial proceed.

Mirrors :mod:`recording_api` exactly — same ``API_BASE``, same Bearer
``WORKER_CONTEXT_SECRET``, same ``call_with_breaker`` transport, same injected
``post`` seam so the client is unit-testable with no httpx/network.

GATED OFF BY DEFAULT and FAIL-OPEN. :func:`worker_orchestration_enabled` reads
``WORKER_ORCHESTRATION`` the same way :func:`recording.recording_provider`
reads ``RECORDING_PROVIDER``: only the exact string ``"worker"`` arms it, and
anything else (including unset) is off. When off, :func:`post_worker_ready` is a
no-op that returns ``False`` and touches nothing. When on, any
network/transport/HTTP failure degrades to ``False`` — never a raised exception
into the call path. Signalling readiness is best-effort: the API's start-wait
budget and the reaper are the backstops if the ping is lost.
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

_log = StructuredLogger("worker-ready-api")

API_BASE = os.getenv("API_BASE", "http://localhost:8787")
_READY_URL = "/api/internal/voice-worker/ready"
_READY_MACHINE_URL = "/api/internal/voice-worker/ready-machine"
_API_TIMEOUT_SEC = 15.0

_READY_BREAKER = CircuitBreaker(CircuitBreakerConfig(
    failure_threshold=3,
    cooldown_sec=10.0,
    timeout_sec=max(_API_TIMEOUT_SEC, 1.0),
    clock=RealClock(),
))

# post(method, url, headers, json_body) -> response object exposing .json()
PostFn = Callable[[str, str, dict, dict], Awaitable[Any]]


def worker_orchestration_enabled() -> bool:
    """True only when ``WORKER_ORCHESTRATION=worker`` — mirrors
    ``recording_provider``'s exact-string gate. Anything else (including unset)
    is off, and :func:`post_worker_ready` is then a no-op."""
    return os.getenv("WORKER_ORCHESTRATION") == "worker"


def worker_machine_id() -> Optional[str]:
    """The Fly machine id, injected at runtime as ``FLY_MACHINE_ID``. None when
    absent (not running on Fly), which fails the readiness post closed."""
    value = os.getenv("FLY_MACHINE_ID")
    return value if value else None


def worker_app_name() -> Optional[str]:
    """The Fly app slug. ``FLY_APP_NAME`` is injected by Fly at runtime; a
    configured ``PHONE_VOICE_APP`` overrides it for a non-Fly / test host.
    None when neither is set, which fails the readiness post closed."""
    return os.getenv("PHONE_VOICE_APP") or os.getenv("FLY_APP_NAME") or None


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
        breaker=_READY_BREAKER,
        transport=_get_transport(),
        headers=headers,
        json_body=json_body,
        endpoint_hint="voice_worker_ready",
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


async def post_worker_ready(
    session_id: str,
    epoch: int,
    *,
    app: Optional[str] = None,
    machine_id: Optional[str] = None,
    post: PostFn = _default_post,
) -> bool:
    """Tell the API this worker is registered and ready for ``session_id``.

    Returns True iff the API answered ``ok: true`` (lease flipped to ``ready``).
    A no-op returning False when the flag is off, when the worker secret / Fly
    identity is unavailable, or on any transport/HTTP failure. Fail-open — the
    caller must NOT gate the call on the result; the API's start-wait budget and
    the reaper are the backstops.

    ``app`` / ``machine_id`` default to the Fly-injected environment
    (:func:`worker_app_name` / :func:`worker_machine_id`); they are overridable
    for tests. ``session_id`` + ``epoch`` come from the worker's already-resolved
    dispatch metadata."""
    if not worker_orchestration_enabled():
        return False
    resolved_app = app if app is not None else worker_app_name()
    resolved_machine = machine_id if machine_id is not None else worker_machine_id()
    if not resolved_app or not resolved_machine:
        # No Fly identity ⇒ nothing addressable to mark ready. Fail-open.
        _log.info("unknown_event", error_type="voice_worker_ready",
                  error_category="identity_missing")
        return False
    headers = _headers()
    if headers is None:
        return False
    body: dict[str, Any] = {
        "app": resolved_app,
        "machine_id": resolved_machine,
        "session_id": session_id,
        "epoch": epoch,
    }
    try:
        resp = await post("POST", f"{API_BASE}{_READY_URL}", headers, body)
        data = getattr(resp, "json", lambda: {})()
    except (ProviderError, BusinessError):
        _log.info("unknown_event", error_type="voice_worker_ready",
                  error_category="api_error")
        return False
    except Exception:  # noqa: BLE001
        _log.info("unknown_event", error_type="voice_worker_ready",
                  error_category="unexpected")
        return False
    return bool(isinstance(data, dict) and data.get("ok"))


async def post_worker_ready_machine(
    *,
    app: Optional[str] = None,
    machine_id: Optional[str] = None,
    post: PostFn = _default_post,
) -> bool:
    """Tell the API this MACHINE's worker process is up and registered.

    The BROWSER worker (named, explicit dispatch — design §2.3b B-i) posts THIS
    at registration/prewarm, BEFORE it knows its session, so the API's
    ready-before-dispatch gate can confirm readiness and only THEN dispatch. It
    carries only {app, machine_id}; the API flips the row it already claimed
    (which already holds the session + epoch) to `ready` via the session-less
    RPC (migration 0080). See ``post_worker_ready`` for the session-keyed phone
    variant, which is UNCHANGED by this.

    Same gate, auth, transport and fail-open contract as ``post_worker_ready``:
    a no-op returning False when orchestration is off or the Fly identity /
    worker secret is unavailable, and False (never a raised exception) on any
    transport/HTTP failure. Fail-open — the caller must NOT block on the result;
    the API's start-wait budget and the reaper are the backstops."""
    if not worker_orchestration_enabled():
        return False
    resolved_app = app if app is not None else worker_app_name()
    resolved_machine = machine_id if machine_id is not None else worker_machine_id()
    if not resolved_app or not resolved_machine:
        _log.info("unknown_event", error_type="voice_worker_ready_machine",
                  error_category="identity_missing")
        return False
    headers = _headers()
    if headers is None:
        return False
    body: dict[str, Any] = {"app": resolved_app, "machine_id": resolved_machine}
    try:
        resp = await post("POST", f"{API_BASE}{_READY_MACHINE_URL}", headers, body)
        data = getattr(resp, "json", lambda: {})()
    except (ProviderError, BusinessError):
        _log.info("unknown_event", error_type="voice_worker_ready_machine",
                  error_category="api_error")
        return False
    except Exception:  # noqa: BLE001
        _log.info("unknown_event", error_type="voice_worker_ready_machine",
                  error_category="unexpected")
        return False
    return bool(isinstance(data, dict) and data.get("ok"))
