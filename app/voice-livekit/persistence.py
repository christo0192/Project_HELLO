"""Supabase persistence helpers for the LiveKit screening worker.

REL-07: All status updates use compare-and-set (.eq on both id and status).
Exactly one updated row = success; zero rows = conflict (another writer won);
malformed/multi-row response = ERROR (corrupt DB reply).

Terminal reasons are REQUIRED — null is not accepted for any terminal state.
Use `conversation_complete` for normal interview completion, not `assessment_done`
(which is only for the post-session scoring pipeline).

`legacy_unknown` is migration-only — never accepted for a live transition.

DISABLED persistence (no Supabase client) fails closed for hosted jobs:
save_turn raises LifecycleError; lifecycle helpers return DISABLED outcome.
Callers must fail closed on DISABLED or ERROR outcomes.

Logging policy:
  - Never log session IDs, candidate data, transcript text, or raw exception text.
  - Fixed log strings only; exception context is internal and stays in memory.
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from provider_resilience import (
    BusinessError,
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitState,
    ProviderError,
    HttpxTransport,
    RealClock,
    call_with_breaker,
    configure_scoring_transport,
    get_scoring_transport,
    parse_env_float,
    parse_env_int,
)


try:
    from supabase import create_client
except ImportError:  # pragma: no cover
    create_client = None

from observability import StructuredLogger, get_correlation_id


SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")
_log = StructuredLogger("persistence")


class _LifecycleLogger:
    """Compatibility shim that emits only structured, fixed-category events."""

    def warning(self, *_args: Any, **_kwargs: Any) -> None:
        _log.warn("db_error", error_category="lifecycle_error")

    def info(self, *_args: Any, **_kwargs: Any) -> None:
        _log.info("unknown_event")


logger = _LifecycleLogger()
_client = None

_DRAIN_TIMEOUT_SEC = int(os.getenv("LIVEKIT_WORKER_DRAIN_SEC", "10"))
_MAX_DURATION_SEC = 86400
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)

# ── Allowlisted reason codes per terminal status (no null) ──────────
_FAILED_REASONS: frozenset[str] = frozenset([
    "room_create_error", "worker_crash", "provider_error",
    "assessment_error", "shutdown_forced", "drain_timeout",
])
_CANCELLED_REASONS: frozenset[str] = frozenset([
    "recruiter_cancelled", "migrated_abandoned", "duplicate_session", "shutdown_drain",
])
_EXPIRED_REASONS: frozenset[str] = frozenset(["idle_timeout", "grace_timeout"])
_COMPLETED_REASONS: frozenset[str] = frozenset(
    ["conversation_complete", "assessment_done"]
    # NOTE: legacy_unknown is NOT in this set — migration-only backfill value.
    # Live transitions must never use legacy_unknown.
)

_NON_TERMINAL_STATUSES: frozenset[str] = frozenset(["created", "waiting", "in_progress"])

# Fixed error messages (never echo runtime values)
_ERR_PERSISTENCE_DISABLED = "persistence disabled for active session"
_ERR_INVALID_REASON = "invalid terminal_reason for status"
_ERR_INVALID_EXPECTED = "expected_status is terminal"
_ERR_WRITE_FAILED = "transcript write failed"
_ERR_LEGACY_REASON = "legacy_unknown is migration-only and cannot be used for live transitions"
_ERR_INVALID_SESSION_ID = "invalid session_id format (expected UUID)"
_ERR_INVALID_DURATION = "duration_sec out of valid range (0-86400)"
_ERR_MALFORMED_RESPONSE = "malformed DB response (expected single row)"
_ERR_CLIENT_FAILURE = "persistence client construction failed"


# ── Typed CAS outcome ─────────────────────────────────────────────────

class LifecycleOutcome:
    """Typed result for lifecycle CAS operations.

    Callers MUST check ``.ok`` (or ``.conflict`` / ``.kind``) before proceeding.
    Never inspect the string value programmatically outside of this module.
    """
    SUCCESS = "success"
    CONFLICT = "conflict"   # 0 rows updated — another writer won or already terminal
    ERROR = "error"         # DB exception, malformed response, or validation failure
    DISABLED = "disabled"   # persistence not configured

    __slots__ = ("kind",)

    def __init__(self, kind: str) -> None:
        self.kind = kind

    @property
    def ok(self) -> bool:
        return self.kind == self.SUCCESS

    @property
    def conflict(self) -> bool:
        return self.kind == self.CONFLICT

    def __repr__(self) -> str:  # pragma: no cover
        return f"LifecycleOutcome({self.kind})"


class LifecycleError(Exception):
    """Fixed internal error code for lifecycle operations — no dynamic values."""


class ClaimResult:
    """Result of an immutable provenance claim attempt."""

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


_SAFE_LEGACY_REASON_CODES = frozenset({"error", "timeout", "disconnect", "unknown"})


def _safe_reason_code(reason: str) -> str:
    """Compatibility helper for closed reason-code validation tests."""
    code = reason.strip().lower().replace(" ", "_")
    return code if code in _SAFE_LEGACY_REASON_CODES else "unknown"


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


def _get_client():
    global _client
    if _client is not None:
        return _client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and create_client):
        logger.warning("[livekit-db] persistence disabled — no credentials")
        return None
    try:
        _client = create_client(url, key)
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] client construction failed")
        return None
    return _client


def _table(name: str):
    client = _get_client()
    return client.schema(SCHEMA).table(name) if client else None


async def set_session_provenance(
    session_id: Optional[str],
    provenance: dict[str, Any],
) -> str:
    """Atomically claim immutable model provenance without logging values or IDs."""
    if not session_id:
        _log.warn("db_error", error_category="provenance_session_missing")
        return ClaimResult.MISSING

    def claim():
        table = _table("call_sessions")
        if not table:
            return None
        return (
            table.update({"provenance": provenance})
            .eq("id", session_id)
            .is_("provenance", None)
            .select("id")
            .execute()
        )

    try:
        result = await asyncio.to_thread(claim)
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="provenance_claim_failed")
        return ClaimResult.ERROR
    if result is None:
        return ClaimResult.MISSING
    rows = getattr(result, "data", None)
    if isinstance(rows, list) and len(rows) == 1:
        return ClaimResult.CLAIMED
    if rows is not None and (not isinstance(rows, list) or len(rows) > 1):
        return ClaimResult.ERROR

    def read_existing():
        table = _table("call_sessions")
        if not table:
            return None
        return table.select("provenance").eq("id", session_id).single().execute()

    try:
        current = await asyncio.to_thread(read_existing)
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="provenance_read_failed")
        return ClaimResult.MISSING
    data = getattr(current, "data", None) if current is not None else None
    existing = data.get("provenance") if isinstance(data, dict) else None
    if existing is None:
        return ClaimResult.ERROR
    if existing == provenance:
        return ClaimResult.ALREADY_MATCHING
    _log.warn("db_error", error_category="provenance_conflict")
    return ClaimResult.CONFLICT


# ── Runtime validation helpers ───────────────────────────────────────

def _is_valid_uuid(session_id: str) -> bool:
    """Validate session_id is a well-formed UUID."""
    return bool(_UUID_PATTERN.match(session_id))


def _is_valid_duration(duration_sec: Optional[int]) -> bool:
    """Validate duration_sec is None or a non-negative finite integer within bounds."""
    if duration_sec is None:
        return True
    return isinstance(duration_sec, int) and 0 <= duration_sec <= _MAX_DURATION_SEC


# ── REL-07 compare-and-set helper ────────────────────────────────────

def _cas_update(
    session_id: str,
    expected_status: str,
    updates: dict,
) -> LifecycleOutcome:
    """CAS update on call_sessions.

    Returns:
      SUCCESS  — exactly one row updated.
      CONFLICT — zero rows matched (another writer already transitioned).
      ERROR    — malformed response (multi-row), DB exception, client failure,
                 or validation failure (invalid session_id, etc.).
      DISABLED — no persistence client available.

    The update explicitly selects/returns `id` to detect malformed responses.
    Multi-row replies from a PK CAS are treated as ERROR (not CONFLICT).
    """
    # Validate session_id is a UUID
    if not _is_valid_uuid(session_id):
        logger.warning("[livekit-db] CAS update: invalid session_id format")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    try:
        table = _table("call_sessions")
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] CAS update: table() construction failed")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    if not table:
        return LifecycleOutcome(LifecycleOutcome.DISABLED)

    try:
        result = (
            table.update(updates)
            .eq("id", session_id)
            .eq("status", expected_status)
            .select("id")  # Explicitly request returned id
            .execute()
        )
        data = getattr(result, "data", None)
        if data is None:
            # No data attribute at all — unexpected response shape
            logger.warning("[livekit-db] CAS update: no data in response")
            return LifecycleOutcome(LifecycleOutcome.ERROR)

        if not isinstance(data, list):
            # Non-list response — malformed
            logger.warning("[livekit-db] CAS update: non-list response data")
            return LifecycleOutcome(LifecycleOutcome.ERROR)

        if len(data) == 1:
            return LifecycleOutcome(LifecycleOutcome.SUCCESS)

        if len(data) == 0:
            return LifecycleOutcome(LifecycleOutcome.CONFLICT)

        # Multiple rows from a PK update = corrupt DB reply → ERROR
        logger.warning("[livekit-db] CAS update: multiple rows returned (corrupt)")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] CAS update failed")
        return LifecycleOutcome(LifecycleOutcome.ERROR)


# ── Public lifecycle helpers ─────────────────────────────────────────

async def save_turn(
    session_id: Optional[str], turn_index: int, speaker: str, text: str
) -> None:
    """Insert one transcript turn.

    Raises LifecycleError on persistence errors so tracked_write/drain
    can detect failures.  No-ops on missing session_id or empty text.
    """
    if not (session_id and text.strip()):
        return

    def run() -> None:
        try:
            table = _table("transcript_turns")
        except Exception:  # noqa: BLE001
            raise LifecycleError(_ERR_CLIENT_FAILURE)
        if not table:
            raise LifecycleError(_ERR_PERSISTENCE_DISABLED)
        try:
            result = table.insert(
                {
                    "session_id": session_id,
                    "turn_index": turn_index,
                    "speaker": speaker,
                    "text": text.strip(),
                }
            ).execute()
        except Exception:  # noqa: BLE001
            raise LifecycleError(_ERR_WRITE_FAILED)
        if hasattr(result, "error") and result.error:
            raise LifecycleError(_ERR_WRITE_FAILED)

    try:
        await asyncio.to_thread(run)
        _log.info("db_turn_saved", turn_index=turn_index, speaker=speaker)
    except LifecycleError:
        _log.warn("db_error", error_category="save_turn_failed")
        raise


async def activate_session(session_id: Optional[str]) -> LifecycleOutcome:
    """REL-07: CAS waiting → in_progress when worker begins processing.

    Returns SUCCESS, CONFLICT, DISABLED, or ERROR.
    Callers must fail closed on any non-SUCCESS outcome.
    """
    if not session_id:
        return LifecycleOutcome(LifecycleOutcome.DISABLED)

    def run() -> LifecycleOutcome:
        return _cas_update(session_id, "waiting", {"status": "in_progress"})

    try:
        result = await asyncio.to_thread(run)
        if result.ok:
            logger.info("[livekit-db] session activated (waiting->in_progress)")
        elif result.conflict:
            logger.info("[livekit-db] session activate conflict")
        elif result.kind == LifecycleOutcome.ERROR:
            logger.warning("[livekit-db] session activate error")
        return result
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] activate_session thread error")
        return LifecycleOutcome(LifecycleOutcome.ERROR)


async def complete_session(
    session_id: Optional[str],
    duration_sec: Optional[int] = None,
    terminal_reason: str = "conversation_complete",
) -> LifecycleOutcome:
    """REL-07: CAS in_progress → completed with REQUIRED terminal_reason.

    Defaults to ``conversation_complete`` for normal interview completion.
    Use ``assessment_done`` when completing because scoring already ran.
    ``legacy_unknown`` is rejected — migration-only.

    Returns SUCCESS, CONFLICT, DISABLED, or ERROR.
    """
    if not session_id:
        return LifecycleOutcome(LifecycleOutcome.DISABLED)

    # Reject legacy_unknown — migration-only value
    if terminal_reason == "legacy_unknown":
        logger.warning("[livekit-db] complete_session: legacy_unknown rejected")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    if terminal_reason not in _COMPLETED_REASONS:
        logger.warning("[livekit-db] complete_session: invalid terminal_reason")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    if not _is_valid_duration(duration_sec):
        logger.warning("[livekit-db] complete_session: invalid duration")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    updates: dict = {
        "status": "completed",
        "terminal_reason": terminal_reason,
        "ended_at": datetime.now(timezone.utc).isoformat(),
    }
    if duration_sec is not None:
        updates["duration_sec"] = duration_sec

    def run() -> LifecycleOutcome:
        return _cas_update(session_id, "in_progress", updates)

    try:
        result = await asyncio.to_thread(run)
        if result.ok:
            logger.info("[livekit-db] session completed (%s)", terminal_reason)
        elif result.conflict:
            logger.info("[livekit-db] session complete conflict")
        return result
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] complete_session thread error")
        return LifecycleOutcome(LifecycleOutcome.ERROR)


async def fail_session(
    session_id: Optional[str],
    terminal_reason: str,
    *,
    expected_status: str = "in_progress",
) -> LifecycleOutcome:
    """REL-07: CAS expected_status → failed with REQUIRED terminal_reason.

    Validates:
      - terminal_reason is in the failed-state allowlist.
      - legacy_unknown is rejected (migration-only).
      - expected_status is a non-terminal state.

    Returns SUCCESS, CONFLICT, DISABLED, or ERROR.
    """
    if not session_id:
        return LifecycleOutcome(LifecycleOutcome.DISABLED)

    if terminal_reason == "legacy_unknown":
        logger.warning("[livekit-db] fail_session: legacy_unknown rejected")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    if terminal_reason not in _FAILED_REASONS:
        logger.warning("[livekit-db] fail_session: invalid terminal_reason")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    if expected_status not in _NON_TERMINAL_STATUSES:
        logger.warning("[livekit-db] fail_session: expected_status is terminal")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    if not _is_valid_uuid(session_id):
        logger.warning("[livekit-db] fail_session: invalid session_id")
        return LifecycleOutcome(LifecycleOutcome.ERROR)

    updates: dict = {
        "status": "failed",
        "terminal_reason": terminal_reason,
        "ended_at": datetime.now(timezone.utc).isoformat(),
    }

    def run() -> LifecycleOutcome:
        return _cas_update(session_id, expected_status, updates)

    try:
        result = await asyncio.to_thread(run)
        if result.ok:
            logger.info("[livekit-db] session failed (%s)", terminal_reason)
        elif result.conflict:
            logger.info("[livekit-db] session fail conflict")
        return result
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-db] fail_session thread error")
        return LifecycleOutcome(LifecycleOutcome.ERROR)


async def trigger_scoring(session_id: Optional[str]) -> TriggerOutcome:
    """Trigger scoring through the shared typed circuit-breaker boundary."""
    if not session_id:
        return TriggerOutcome.BUSINESS_ERROR
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


# ── Shutdown drain helper ─────────────────────────────────────────────

async def drain_pending_writes(
    pending_tasks: "set[asyncio.Task]",
    *,
    timeout_sec: float = _DRAIN_TIMEOUT_SEC,
) -> bool:
    """Await all pending write tasks within a bounded timeout.

    Returns True only if ALL tasks completed successfully within the budget.
    Returns False on timeout, cancellation of any task, or any task failure
    (including LifecycleError raised by save_turn on DISABLED client).
    Remaining tasks are cancelled and awaited before returning.
    """
    if not pending_tasks:
        return True

    snapshot = list(pending_tasks)

    async def _cancel_remaining() -> None:
        for t in snapshot:
            if not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*snapshot, return_exceptions=True),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "[livekit-db] drain_pending_writes: timed out after %.1fs", timeout_sec
        )
        await _cancel_remaining()
        return False

    await _cancel_remaining()

    for r in results:
        if isinstance(r, BaseException):
            logger.warning("[livekit-db] drain_pending_writes: a write task failed")
            return False

    return True


# ── Worker context resolution ────────────────────────────────────────
# Worker context comes from authenticated server-side Supabase/persistence lookup
# using strict session/room UUID binding — never from client-visible metadata.

_API_TIMEOUT_SEC = float(os.getenv("WORKER_CONTEXT_TIMEOUT_SEC", "5"))
_WORKER_CONTEXT_BREAKER = CircuitBreaker(CircuitBreakerConfig(
    failure_threshold=3,
    cooldown_sec=10.0,
    timeout_sec=max(_API_TIMEOUT_SEC, 1.0),
    clock=RealClock(),
))


def _get_worker_context_transport():
    """Create the existing lazy HTTP transport with bounded context timeouts."""
    return HttpxTransport(
        connect_timeout=5.0,
        read_timeout=_API_TIMEOUT_SEC,
        write_timeout=5.0,
        pool_timeout=5.0,
        pool_connections=2,
        pool_maxsize=2,
    )


_ERR_CONTEXT_NOT_FOUND = "context_not_found"
_ERR_CONTEXT_BINDING = "context_binding_mismatch"
_ERR_CONTEXT_INACTIVE = "context_not_active"
_ERR_CONTEXT_API_ERROR = "context_api_error"


class WorkerContext:
    """Minimal server-side worker context — no PII, no resume data."""

    __slots__ = ("session_id", "candidate_id", "role_id", "candidate_name", "room_name", "status")

    def __init__(
        self,
        session_id: str,
        candidate_id: str,
        role_id: str | None,
        candidate_name: str | None,
        room_name: str,
        status: str,
    ) -> None:
        self.session_id = session_id
        self.candidate_id = candidate_id
        self.role_id = role_id
        self.candidate_name = candidate_name
        self.room_name = room_name
        self.status = status


def parse_worker_context(data: dict) -> WorkerContext:
    """Parse a worker context dict into a WorkerContext object."""
    return WorkerContext(
        session_id=str(data.get("session_id", "")),
        candidate_id=str(data.get("candidate_id", "")),
        role_id=data.get("role_id"),
        candidate_name=data.get("candidate_name"),
        room_name=str(data.get("room_name", "")),
        status=str(data.get("status", "")),
    )


async def resolve_worker_context(
    session_id: str,
    room_name: str,
) -> WorkerContext | str:
    """Resolve worker context from the API via server-side lookup.

    Returns a WorkerContext on success, or an error code string on failure.
    Error codes are stable strings — never echo runtime values.

    This is called by the worker to get the minimal context needed for the
    interview (candidate name for prompting, etc.) without relying on
    client-visible room/participant metadata.
    """
    if not session_id or not _is_valid_uuid(session_id):
        return _ERR_CONTEXT_NOT_FOUND

    # HIGH SEC-13: fail closed before constructing a network transport unless
    # a worker-only bearer credential exists.
    worker_secret = os.getenv("WORKER_CONTEXT_SECRET")
    if not worker_secret or len(worker_secret) < 32:
        return _ERR_CONTEXT_API_ERROR

    try:
        transport = _get_worker_context_transport()
    except Exception:  # noqa: BLE001
        return _ERR_CONTEXT_API_ERROR

    correlation_id = get_correlation_id()
    headers: dict[str, str] = {
        "Content-Type": "application/json",
    }
    headers["Authorization"] = f"Bearer {worker_secret}"
    if correlation_id:
        headers["X-Correlation-ID"] = correlation_id

    try:
        # call_with_breaker raises BusinessError for 4xx responses
        # and ProviderError for 5xx/transport errors.
        # 200 OK is returned normally.
        response = await call_with_breaker(
            "POST",
            f"{API_BASE}/api/livekit/worker-context",
            breaker=_WORKER_CONTEXT_BREAKER,
            transport=transport,
            headers=headers,
            json_body={
                "session_id": session_id,
                "room_name": room_name,
            },
            endpoint_hint="worker-context",
            log_failures=False,
        )
        data = getattr(response, "json", lambda: {})()
        if isinstance(data, dict) and data.get("ok"):
            return parse_worker_context(data.get("context", {}))
        return _ERR_CONTEXT_NOT_FOUND
    except ProviderError:
        return _ERR_CONTEXT_API_ERROR
    except BusinessError:
        return _ERR_CONTEXT_NOT_FOUND
    except Exception:  # noqa: BLE001
        return _ERR_CONTEXT_API_ERROR


# ── REL-02/03 outbox/ingestion helpers ─────────────────────────────────

_ERR_TRANSCRIPT_EVENT_FAILED = "transcript event upsert failed"
_ERR_OUTBOX_FAILED = "outbox entry creation failed"
_ERR_TRANSCRIPT_EVENT_FETCH_FAILED = "transcript event fetch failed"
_OUTBOX_AGGREGATE_TYPE = "transcript_event"
_OUTBOX_EVENT_TYPE = "transcript_turn.created"


def _get_next_sequence(session_id: str) -> int:
    """Get the next sequence number for a session's transcript events.
    Returns 1 if no events exist yet."""
    table = _table("transcript_events")
    if not table:
        return 1
    try:
        result = (
            table.select("sequence")
            .eq("session_id", session_id)
            .order("sequence", desc=True)
            .limit(1)
            .maybe_single()
            .execute()
        )
        data = getattr(result, "data", None)
        if isinstance(data, dict) and "sequence" in data:
            return data["sequence"] + 1
        return 1
    except Exception:  # noqa: BLE001
        return 1


async def save_transcript_event(
    session_id: str,
    turn_index: int,
    speaker: str,
    text: str,
) -> str:
    """Upsert a transcript event with outbox entry.

    Dedup key is (session_id, turn_index). Duplicate delivery of the same turn
    is silently ignored (idempotent). Out-of-order events insert cleanly.

    Returns '' (empty string) on success, or a stable error code on failure.
    Unlike save_turn, this does NOT raise LifecycleError — failures are
    returned as error codes so callers can decide whether to fail closed.
    """
    if not session_id or not text.strip():
        return ""

    def run() -> str:
        table_events = _table("transcript_events")
        table_outbox = _table("outbox")
        if not table_events or not table_outbox:
            return _ERR_PERSISTENCE_DISABLED

        # Compute next sequence
        seq = _get_next_sequence(session_id)

        # Upsert transcript event (ignore duplicates)
        try:
            result = (
                table_events.upsert(
                    {
                        "session_id": session_id,
                        "turn_index": turn_index,
                        "speaker": speaker,
                        "text": text.strip(),
                        "sequence": seq,
                    },
                    on_conflict="session_id, turn_index",
                    ignore_duplicates=True,
                )
                .select()
                .single()
                .execute()
            )
        except Exception:  # noqa: BLE001
            return _ERR_TRANSCRIPT_EVENT_FAILED

        data = getattr(result, "data", None)
        if not isinstance(data, dict):
            return _ERR_TRANSCRIPT_EVENT_FAILED

        event_id = data.get("id")
        if not event_id:
            return _ERR_TRANSCRIPT_EVENT_FAILED

        # Create pending outbox entry
        try:
            table_outbox.insert(
                {
                    "aggregate_type": _OUTBOX_AGGREGATE_TYPE,
                    "aggregate_id": event_id,
                    "event_type": _OUTBOX_EVENT_TYPE,
                    "payload": {
                        "sessionId": session_id,
                        "turnIndex": turn_index,
                        "speaker": speaker,
                        "text": text.strip(),
                        "sequence": seq,
                    },
                    "status": "pending",
                }
            ).execute()
        except Exception:  # noqa: BLE001
            # Event is durable even if outbox insert fails
            _log.warn("db_error", error_category="outbox_insert_failed")
            return _ERR_OUTBOX_FAILED

        return ""

    try:
        error = await asyncio.to_thread(run)
        if error:
            _log.warn("db_error", error_category="save_transcript_event_failed")
        else:
            _log.info("db_turn_saved", turn_index=turn_index, speaker=speaker)
        return error
    except Exception:  # noqa: BLE001
        _log.warn("db_error", error_category="save_transcript_event_failed")
        return _ERR_TRANSCRIPT_EVENT_FAILED


async def get_transcript_events(
    session_id: str,
) -> list[dict]:
    """Retrieve all transcript events for a session in sequence order.

    Returns an empty list on any error (never None). Callers should check
    the list length rather than relying on error signalling.
    """
    if not session_id:
        return []

    def run() -> list[dict]:
        table = _table("transcript_events")
        if not table:
            return []
        try:
            result = (
                table.select("*")
                .eq("session_id", session_id)
                .order("sequence", desc=False)
                .execute()
            )
            data = getattr(result, "data", None)
            if isinstance(data, list):
                return data
            return []
        except Exception:  # noqa: BLE001
            return []

    try:
        return await asyncio.to_thread(run)
    except Exception:  # noqa: BLE001
        return []
