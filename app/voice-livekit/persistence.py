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
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx

try:
    from supabase import create_client
except ImportError:  # pragma: no cover
    create_client = None


SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")
logger = logging.getLogger("voice-livekit.persistence")
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

    await asyncio.to_thread(run)


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


async def trigger_scoring(session_id: Optional[str]) -> None:
    if not session_id:
        return
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(f"{API_BASE}/api/assess/{session_id}")
            logger.info("[livekit-score] scoring triggered: HTTP %s", response.status_code)
    except Exception:  # noqa: BLE001
        logger.warning("[livekit-score] scoring trigger failed")


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
