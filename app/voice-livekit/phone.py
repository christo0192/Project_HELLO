"""Phone-channel gate for the LiveKit screening worker (P4).

This module holds everything the voice worker needs that is SPECIFIC to an
outbound phone screening, and nothing that the browser path needs. It is
deliberately separate from ``agent.py`` so the browser session flow — a
production path — keeps exactly the shape it had before P4.

Three things live here:

1. **Room classification, and where the attempt id actually comes from.** A
   phone room is ``phone-<sessionId>`` or carries ``{"channel": "phone"}`` in
   its room metadata. The room is keyed by SESSION, deliberately: one session
   spans every reconnect attempt and they must share a transcript, so the room
   name CANNOT carry an attempt id. The attempt id arrives instead on the
   per-attempt DISPATCH metadata (``ctx.job.metadata``), a JSON object of
   exactly ``{"session_id", "attempt_id", "channel"}``. The default (unnamed)
   worker auto-dispatches into *every* room in the project, so it must be able
   to recognise a phone room and refuse it before it connects a session,
   speaks, activates, or writes anything.

2. **The human / disclosure / recording gate.** A SIP leg being up says nothing
   about who — or what — answered. ``participant_joined`` is not a human, so the
   agent waits for a participant, delivers a FIXED disclosure line, and only
   then classifies. Recording is *considered* only after an affirmative
   ``disclosure.delivered`` is accepted by the API. Every other branch —
   machine, refusal, opt-out, wrong number, no response — ends the call with no
   assessment, no recording, and no scorecard.

3. **The callback-scheduling tool.** The bot may confirm a booking ONLY after
   the server says it booked one. Confirming a slot that was refused, on a call
   whose entire purpose is to be truthful, is the worst outcome this file can
   produce; every refusal therefore has its own distinct spoken line and none of
   them claims a booking.

Logging policy (inherited, and tightened here): no phone number may appear in
room metadata, participant metadata, logs, prompts, errors or tool arguments.
This module never enumerates a participant attribute map and never logs one.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
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

_log = StructuredLogger("phone")

API_BASE = os.getenv("API_BASE", "http://localhost:8787")
_COMPANY = os.getenv("COMPANY_NAME", "Interview Kickstart")


# ── Room classification ───────────────────────────────────────────────
# The dialer provisions `phone-<sessionId>` (P4 item 1). The room is keyed by
# SESSION, not by attempt: one session spans every reconnect attempt and they
# share a transcript, so no attempt id is recoverable from the room name and
# none may ever be read out of it. The metadata channel marker is the second,
# independent signal: a room whose name was produced by some other writer still
# declares its channel, and either signal alone is enough to keep the browser
# worker out.

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
PHONE_ROOM_RE = re.compile(rf"^phone-(?P<session_id>{_UUID})$", re.IGNORECASE)
_UUID_RE = re.compile(rf"^{_UUID}$", re.IGNORECASE)
PHONE_CHANNEL = "phone"

# A 7+ digit run is the shape of a dialable number. 0042 rejects metadata that
# carries one; this module refuses to SEND one, so the two ends agree.
_DIGIT_RUN_RE = re.compile(r"\d{7,}")


def session_id_from_room_name(room_name: str) -> str | None:
    """Return the SESSION id encoded in a phone room name, or None.

    Named for what it is. There was previously an ``attempt_id_from_room_name``
    here reading the same capture group under the wrong name, and every phone
    event the worker posted therefore carried a session uuid in the
    ``attempt_id`` field — which the API resolved to no attempt at all. The two
    ids can never be confused again because only one of them has a parser here.
    """
    match = PHONE_ROOM_RE.match(str(room_name or ""))
    return match.group("session_id") if match else None


def dispatch_metadata_of(ctx: Any) -> Any:
    """Read the per-JOB dispatch metadata blob off a JobContext, defensively."""
    job = getattr(ctx, "job", None)
    return getattr(job, "metadata", None)


def attempt_id_from_dispatch_metadata(ctx: Any) -> str | None:
    """Return the attempt id from the job's dispatch metadata, or None.

    A dispatch is minted per ATTEMPT, so this is the only per-attempt channel
    the worker has; the session-keyed room name is not one. The blob is built
    by ``buildPhoneDispatchMetadata`` on the API side and carries exactly
    ``{"session_id", "attempt_id", "channel"}``.

    Fails closed: an absent, unparseable, wrong-channel or non-uuid value
    returns None, and the caller must then do nothing at all.
    """
    payload = _json_object(dispatch_metadata_of(ctx))
    channel = payload.get("channel")
    if not isinstance(channel, str) or channel.strip().lower() != PHONE_CHANNEL:
        return None
    attempt_id = payload.get("attempt_id")
    if not isinstance(attempt_id, str) or not _UUID_RE.match(attempt_id.strip()):
        return None
    return attempt_id.strip()


def _json_object(raw: Any) -> dict[str, Any]:
    """Parse a metadata blob defensively. Never raises, never logs the blob."""
    if not raw:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="ignore")
    if not isinstance(raw, str):
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def is_phone_room(room_name: Any, room_metadata: Any = None) -> bool:
    """True when the room belongs to the phone channel.

    Two independent signals, either sufficient: the deterministic room name, and
    an explicit ``channel`` marker in the room metadata. Metadata is parsed but
    never logged and never used for anything else.
    """
    if session_id_from_room_name(str(room_name or "")) is not None:
        return True
    channel = _json_object(room_metadata).get("channel")
    return isinstance(channel, str) and channel.strip().lower() == PHONE_CHANNEL


def room_metadata_of(ctx: Any) -> Any:
    """Read the room metadata blob off a JobContext, defensively."""
    room = getattr(ctx, "room", None)
    return getattr(room, "metadata", None)


def participant_identity(participant: Any) -> str | None:
    """Return ONLY the participant identity.

    Read by exact key. The `sip.*` attribute map is never enumerated and never
    returned — `sip.phoneNumber` is auto-populated by LiveKit, so enumerating
    the map is precisely how a phone number escapes into a log line.
    """
    identity = getattr(participant, "identity", None)
    if identity is None and isinstance(participant, dict):
        identity = participant.get("identity")
    return str(identity) if identity else None


# ── Fixed spoken text ─────────────────────────────────────────────────
# Constants, not model output. The identity, the purpose and the recording
# notice are the three things a screening call is legally and ethically
# required to say, so none of them may be left to a sampler.

PHONE_DISCLOSURE_TEXT = (
    f"Hi, this is Christy, an AI voice assistant calling from {_COMPANY} "
    "about your job application. This call is recorded so the hiring team can "
    "review it. Is it okay to continue?"
)

# Refusal closings. None of these claims that a recording was made, kept, or
# deleted — the worker cannot know, and a wrong claim here is unrecoverable.
PHONE_REFUSED_TEXT = (
    "That's completely fine. I won't continue with the screening. "
    "Thanks for your time, and goodbye."
)
PHONE_OPT_OUT_TEXT = (
    "Understood. I'll pass that on so you're not contacted about this again. "
    "Thanks for your time, and goodbye."
)
# Asked once when the first response cannot be read as any of the five outcomes.
# Consent must be affirmative, so an unreadable answer is re-asked rather than
# assumed either way.
PHONE_REASK_TEXT = (
    "Sorry, I just need a yes or a no — is it okay if we carry on with this "
    "recorded call?"
)
PHONE_WRONG_NUMBER_TEXT = (
    "Sorry about that, I've reached the wrong person. I'll have this number "
    "corrected. Thanks, and goodbye."
)


# ── Worker event API ──────────────────────────────────────────────────

EVENTS_PATH = "/api/internal/phone/events"
APPOINTMENTS_PATH = "/api/internal/phone/appointments"

# STRICT allowlist. The server enforces its own; this is the worker half, so a
# typo fails here rather than becoming a 4xx the caller has to interpret.
PHONE_WORKER_EVENTS: frozenset[str] = frozenset([
    "classify.human",
    "classify.machine",
    "disclosure.delivered",
    "disclosure.refused",
    "candidate.opt_out",
    "candidate.wrong_number",
    "candidate.deferred_pre_disclosure",
    "sip.participant_left",
    "assessment.completed",
    "assessment.aborted",
])

_ERR_CONFIGURATION = "configuration"
_ERR_TRANSPORT = "transport"
_ERR_BUSINESS = "business_error"
_ERR_EVENT_NOT_ALLOWED = "event_not_allowed"
_ERR_MALFORMED = "malformed_response"


def _bounded_float(raw: Any, default: float, lo: float, hi: float) -> float:
    """Parse a float env value and CLAMP it — an unbounded wait is not a bound.

    The env var is read at the CALL SITE with a literal name so the repo's
    env-contract scanner can see every variable this module consumes.
    """
    if raw in (None, ""):
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if value != value:  # NaN
        return default
    return lo if value < lo else hi if value > hi else value


def phone_event_timeout_sec() -> float:
    """Bounded per-call timeout for the internal worker event API."""
    return _bounded_float(os.getenv("PHONE_EVENT_TIMEOUT_SEC"), 10.0, 1.0, 60.0)


def phone_participant_wait_sec() -> float:
    """Bounded wall clock for 'has anything answered yet'."""
    return _bounded_float(os.getenv("PHONE_PARTICIPANT_WAIT_SEC"), 45.0, 1.0, 180.0)


def phone_classify_timeout_sec() -> float:
    """Bounded wall clock for the human/machine decision."""
    return _bounded_float(os.getenv("PHONE_CLASSIFY_TIMEOUT_SEC"), 20.0, 1.0, 120.0)


class PhoneApiOutcome:
    """Result of one internal phone-API call.

    ``ok`` is the only field a caller may branch a SAFETY decision on. A missing
    or malformed body is never ``ok`` — the worker fails closed rather than
    assuming the server applied something it never confirmed.
    """

    __slots__ = ("ok", "status", "duplicate", "ignored_reason", "error_category")

    def __init__(
        self,
        ok: bool,
        status: str | None = None,
        *,
        duplicate: bool = False,
        ignored_reason: str | None = None,
        error_category: str | None = None,
    ) -> None:
        self.ok = ok
        self.status = status
        self.duplicate = duplicate
        self.ignored_reason = ignored_reason
        self.error_category = error_category

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"PhoneApiOutcome(ok={self.ok}, status={self.status!r})"


class PhoneEventClient:
    """Authenticated worker → API client for the two internal phone endpoints.

    Shares the project's circuit-breaker boundary and its bearer contract: the
    worker secret must be at least 32 characters or the client fails closed
    BEFORE constructing a transport, so a misconfigured worker never opens a
    connection it has no right to open.
    """

    def __init__(
        self,
        *,
        transport_factory: Callable[[], Any] | None = None,
        breaker: CircuitBreaker | None = None,
        api_base: str | None = None,
    ) -> None:
        self._transport_factory = transport_factory or self._default_transport
        self._breaker = breaker or CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=3,
            cooldown_sec=10.0,
            timeout_sec=max(phone_event_timeout_sec(), 1.0),
            clock=RealClock(),
        ))
        self._api_base = api_base if api_base is not None else API_BASE

    @staticmethod
    def _default_transport() -> Any:
        timeout = phone_event_timeout_sec()
        return HttpxTransport(
            connect_timeout=min(10.0, timeout),
            read_timeout=timeout,
            write_timeout=min(10.0, timeout),
            pool_timeout=min(10.0, timeout),
            pool_connections=2,
            pool_maxsize=2,
        )

    def _headers(self) -> dict[str, str] | None:
        worker_secret = os.getenv("WORKER_CONTEXT_SECRET", "")
        if len(worker_secret) < 32:
            return None
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {worker_secret}",
        }
        correlation_id = get_correlation_id()
        if correlation_id:
            headers["X-Correlation-ID"] = correlation_id
        return headers

    async def _post(self, path: str, body: dict[str, Any], hint: str) -> Any | str:
        headers = self._headers()
        if headers is None:
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_CONFIGURATION, schema=hint,
            )
            return _ERR_CONFIGURATION
        try:
            transport = self._transport_factory()
        except Exception:  # noqa: BLE001
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_TRANSPORT, schema=hint,
            )
            return _ERR_TRANSPORT
        try:
            return await call_with_breaker(
                "POST",
                f"{self._api_base}{path}",
                breaker=self._breaker,
                transport=transport,
                headers=headers,
                json_body=body,
                endpoint_hint="unknown",
                log_failures=False,
            )
        except ProviderError as exc:
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=exc.category, schema=hint,
            )
            return _ERR_TRANSPORT
        except BusinessError:
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_BUSINESS, schema=hint,
            )
            return _ERR_BUSINESS
        except Exception:  # noqa: BLE001
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_TRANSPORT, schema=hint,
            )
            return _ERR_TRANSPORT

    async def post_event(
        self,
        attempt_id: str,
        event_type: str,
        *,
        epoch: int | None = None,
    ) -> PhoneApiOutcome:
        """Post one worker event. Fails closed on anything but a confirmed 200.

        There is deliberately NO ``metadata`` parameter. The server's request
        schema is ``.strict()`` and rejects an unknown key with a flat 400, so a
        metadata field could only ever have produced a failed post — and the
        number-shaped-value guard that once sat here guarded a parameter no
        caller passed, which is a control that cannot fire.
        """
        if event_type not in PHONE_WORKER_EVENTS:
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_EVENT_NOT_ALLOWED,
            )
            return PhoneApiOutcome(False, error_category=_ERR_EVENT_NOT_ALLOWED)

        body: dict[str, Any] = {
            "attempt_id": str(attempt_id),
            "event_type": event_type,
            "epoch": epoch,
        }

        response = await self._post(EVENTS_PATH, body, "event")
        if isinstance(response, str):
            return PhoneApiOutcome(False, error_category=response)

        data = _response_json(response)
        if not isinstance(data, dict) or data.get("ok") is not True:
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED,
            )
            return PhoneApiOutcome(False, error_category=_ERR_MALFORMED)

        status = data.get("status")
        _log.info(
            "unknown_event",
            error_type="phone_event_applied",
            schema=event_type,
            error_category=str(status) if status else None,
        )
        return PhoneApiOutcome(
            True,
            str(status) if status is not None else None,
            duplicate=bool(data.get("duplicate")),
            ignored_reason=(
                str(data["ignored_reason"]) if data.get("ignored_reason") else None
            ),
        )

    async def book_appointment(
        self,
        attempt_id: str,
        starts_at: str,
        duration_seconds: int,
    ) -> PhoneApiOutcome:
        """Ask the server to book a callback.

        The SERVER revalidates the 09:00-21:00 IST window, the not-in-the-past
        rule and the duration envelope. This client decides nothing; it reports
        what came back. A 200 body carrying ``ok: false`` is a REFUSAL, not a
        success — that shape is the one a careless caller confirms by accident.
        """
        body = {
            "attempt_id": str(attempt_id),
            "starts_at": str(starts_at),
            "duration_seconds": int(duration_seconds),
        }
        response = await self._post(APPOINTMENTS_PATH, body, "appointment")
        if isinstance(response, str):
            return PhoneApiOutcome(False, error_category=response)

        data = _response_json(response)
        if not isinstance(data, dict):
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED,
            )
            return PhoneApiOutcome(False, error_category=_ERR_MALFORMED)

        status = data.get("status")
        status_str = str(status) if status is not None else None
        if data.get("ok") is not True:
            _log.info(
                "unknown_event", error_type="phone_schedule_refused",
                error_category=status_str,
            )
            return PhoneApiOutcome(False, status_str)
        _log.info(
            "unknown_event", error_type="phone_schedule_booked",
            error_category=status_str,
        )
        return PhoneApiOutcome(True, status_str)


def _response_json(response: Any) -> Any:
    getter = getattr(response, "json", None)
    if not callable(getter):
        return None
    try:
        return getter()
    except Exception:  # noqa: BLE001
        return None


# ── The callback-scheduling tool ──────────────────────────────────────

BOOKED_STATUSES: frozenset[str] = frozenset(["ok", "ok_prereqs_pending"])

MIN_CALLBACK_DURATION_SEC = 900
MAX_CALLBACK_DURATION_SEC = 3600

# One distinct line per refusal code. Distinct because a single "sorry, that
# didn't work" teaches the candidate nothing and teaches us nothing from the
# transcript either; none of them contains a confirmation.
_SCHEDULE_REFUSAL_TEXT: dict[str, str] = {
    "attempt_in_flight": (
        "I can't lock that in from this call just yet. The team will reach out "
        "to fix a time with you."
    ),
    "slot_in_past": (
        "That time has already gone by, so I can't set it up. Could you give me "
        "a time that's still ahead of us?"
    ),
    "window_closed": (
        "I can only set up calls between nine in the morning and nine at night. "
        "Could you pick a time inside that?"
    ),
    # The engagement was released for TODAY when this call ended, so the
    # earliest the team can call back is tomorrow. Say that plainly rather than
    # falling back to the non-committal line: the fallback is safe (it claims
    # no booking) but it leaves the candidate with no idea what to ask for.
    "slot_not_yet_eligible": (
        "I can't book another call for today, but I can from tomorrow onwards. "
        "What time would suit you then?"
    ),
    "slot_duration_invalid": (
        "That length doesn't work for this call. I can set aside between fifteen "
        "minutes and an hour. What suits you?"
    ),
    "version_conflict": (
        "Something just changed on my side, so I couldn't hold that slot. The "
        "team will follow up to confirm a time."
    ),
    "engagement_terminal": (
        "I'm not able to set up another call on this application. The team will "
        "follow up with you directly."
    ),
}
_SCHEDULE_REFUSAL_FALLBACK = (
    "I wasn't able to set that up, so I don't want to promise it. The team will "
    "follow up with you to fix a time."
)
_SCHEDULE_CONFIRMED_TEXT = (
    "Done, I've got that booked. Someone will call you back then. "
    "Thanks for your time, and goodbye."
)


def schedule_refusal_text(status: Any) -> str:
    """Spoken line for a refusal code. Never contains a confirmation."""
    key = str(status).strip().lower() if status is not None else ""
    return _SCHEDULE_REFUSAL_TEXT.get(key, _SCHEDULE_REFUSAL_FALLBACK)


class ScheduleTurn:
    """What the bot should say, and whether a booking actually exists."""

    __slots__ = ("spoken", "booked", "status")

    def __init__(self, spoken: str, booked: bool, status: str | None) -> None:
        self.spoken = spoken
        self.booked = booked
        self.status = status


_ISO_UTC_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$"
)


async def schedule_callback_turn(
    client: PhoneEventClient,
    attempt_id: str,
    starts_at: str,
    duration_seconds: Any,
) -> ScheduleTurn:
    """Book a callback and return the line to speak.

    The single rule this function exists to enforce: the confirming line is
    produced ONLY when the server returned ``ok`` or ``ok_prereqs_pending``.
    Every other path — a refusal code, a transport failure, a malformed
    response, a bad argument — returns a refusal line and ``booked=False``.
    """
    if not isinstance(starts_at, str) or not _ISO_UTC_RE.match(starts_at.strip()):
        # Shape check only. The server owns the window and the not-past rule;
        # this refuses a value that is not an absolute UTC instant at all.
        return ScheduleTurn(schedule_refusal_text("slot_in_past"), False, "slot_in_past")
    try:
        duration = int(duration_seconds)
    except (TypeError, ValueError):
        duration = -1
    if not MIN_CALLBACK_DURATION_SEC <= duration <= MAX_CALLBACK_DURATION_SEC:
        return ScheduleTurn(
            schedule_refusal_text("slot_duration_invalid"), False, "slot_duration_invalid"
        )

    outcome = await client.book_appointment(attempt_id, starts_at.strip(), duration)
    if outcome.ok and outcome.status in BOOKED_STATUSES:
        return ScheduleTurn(_SCHEDULE_CONFIRMED_TEXT, True, outcome.status)
    # `ok` with an unrecognised status is NOT a booking. A future server status
    # must be added here deliberately, never confirmed by default.
    return ScheduleTurn(schedule_refusal_text(outcome.status), False, outcome.status)


# ── LLM tool binding ──────────────────────────────────────────────────
# livekit-agents 1.6 exposes `function_tool`. Resolved through a function so a
# rename in the SDK is caught by a test instead of silently degrading the agent
# to a tool-less one.


def resolve_function_tool() -> Any | None:
    """Return the SDK's ``function_tool`` decorator, or None if absent."""
    try:
        from livekit.agents import function_tool  # noqa: PLC0415
    except ImportError:
        return None
    return function_tool


def _tool(fn: Callable[..., Any]) -> Callable[..., Any]:
    decorator = resolve_function_tool()
    if decorator is None:
        # Import-time stubs (and the CI test regime, which does not install the
        # SDK) reach here. Marked so a test can prove the fallback is a fallback
        # and not the production path.
        setattr(fn, "__phone_tool_unbound__", True)
        return fn
    return decorator(fn)


# ── The human / disclosure / recording gate ───────────────────────────

CLASSIFY_HUMAN = "human_affirmative"
CLASSIFY_MACHINE = "machine"
CLASSIFY_REFUSED = "disclosure_refused"
CLASSIFY_OPT_OUT = "opt_out"
CLASSIFY_WRONG_NUMBER = "wrong_number"

PHONE_CLASSIFICATIONS: frozenset[str] = frozenset([
    CLASSIFY_HUMAN,
    CLASSIFY_MACHINE,
    CLASSIFY_REFUSED,
    CLASSIFY_OPT_OUT,
    CLASSIFY_WRONG_NUMBER,
])

# Outcome → the single event that outcome posts. `classify.human` is posted
# separately and FIRST for the human branch, because `disclosure.delivered` is
# the consent record and must never precede the "a person is on the line" record.
_OUTCOME_EVENT: dict[str, str] = {
    CLASSIFY_MACHINE: "classify.machine",
    CLASSIFY_REFUSED: "disclosure.refused",
    CLASSIFY_OPT_OUT: "candidate.opt_out",
    CLASSIFY_WRONG_NUMBER: "candidate.wrong_number",
}

_OUTCOME_CLOSING: dict[str, str] = {
    CLASSIFY_REFUSED: PHONE_REFUSED_TEXT,
    CLASSIFY_OPT_OUT: PHONE_OPT_OUT_TEXT,
    CLASSIFY_WRONG_NUMBER: PHONE_WRONG_NUMBER_TEXT,
}

GATE_NO_PARTICIPANT = "no_participant"
GATE_PARTICIPANT_LEFT = "participant_left"

# The one status that means the API actually RECORDED the event.
EVENT_STATUS_APPLIED = "applied"


def event_applied(outcome: PhoneApiOutcome) -> bool:
    """True only when the API confirmed it APPLIED the event.

    ``ok`` alone is not enough, and must never be treated as enough. An
    ``ignored`` verdict covers ``terminal`` — which is exactly what an HR
    ``emergency.stop`` or ``hr.cancelled`` produces — as well as ``stale_epoch``
    and ``unknown_attempt``. Reading any of those as consent keeps the candidate
    on the line and runs the full screening after the system has already
    declared the conversation over.

    A ``duplicate`` re-post of an already-applied event comes back ``applied``,
    so idempotency is preserved by this rule rather than broken by it.
    """
    return bool(outcome.ok) and outcome.status == EVENT_STATUS_APPLIED


class PhoneGateResult:
    """The gate's verdict.

    ``assessment_allowed`` and ``recording_allowed`` are both False on every
    path except an affirmative human whose ``disclosure.delivered`` the API
    ACCEPTED. They are computed once, here, so no caller can arrive at "well,
    probably fine" independently.
    """

    __slots__ = (
        "outcome",
        "assessment_allowed",
        "recording_allowed",
        "events",
        "spoken",
    )

    def __init__(
        self,
        outcome: str,
        *,
        assessment_allowed: bool = False,
        recording_allowed: bool = False,
        events: Optional[list[str]] = None,
        spoken: Optional[list[str]] = None,
    ) -> None:
        self.outcome = outcome
        self.assessment_allowed = assessment_allowed
        self.recording_allowed = recording_allowed
        self.events = events if events is not None else []
        self.spoken = spoken if spoken is not None else []

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return (
            f"PhoneGateResult(outcome={self.outcome!r}, "
            f"assessment_allowed={self.assessment_allowed}, "
            f"recording_allowed={self.recording_allowed})"
        )


async def run_phone_gate(
    *,
    attempt_id: str,
    client: PhoneEventClient,
    wait_for_participant: Callable[[], Awaitable[Any]],
    classify: Callable[[], Awaitable[str]],
    say: Callable[[str], Awaitable[Any]],
    start_recording: Optional[Callable[[], Awaitable[Any]]] = None,
    epoch: int | None = None,
    classify_timeout_sec: float | None = None,
) -> PhoneGateResult:
    """Run the phone screening's opening, in the ONLY order that is safe.

    1. Wait for the SIP participant. Nothing is spoken, activated, timed or
       recorded before one exists — a ringing leg has no listener, and a silence
       timer started at originate measures the network, not the candidate.
    2. Deliver the FIXED identity + purpose + recording disclosure.
    3. Classify through a BOUNDED, INJECTABLE seam. Voicemail and IVR are
       machines. A seam that hangs, or answers something unrecognised, is a
       machine too — that is the fail-closed direction, because a machine gets
       no assessment and no recording.
    4. Only an affirmative human whose ``classify.human`` AND
       ``disclosure.delivered`` were both accepted may proceed.

    ``start_recording`` is invoked at exactly one point in this function, after
    ``disclosure.delivered`` succeeded. That single call site is the whole
    control; a caller must not have its own.
    """
    events: list[str] = []
    spoken: list[str] = []

    async def _say(text: str) -> None:
        spoken.append(text)
        await say(text)

    participant = await wait_for_participant()
    if participant is None:
        # Nothing answered inside the bound. The attempt's outcome belongs to
        # the dialer's no-answer accounting, not to a worker event.
        _log.info(
            "unknown_event", error_type="phone_gate_outcome",
            schema=GATE_NO_PARTICIPANT,
        )
        return PhoneGateResult(GATE_NO_PARTICIPANT, events=events, spoken=spoken)

    await _say(PHONE_DISCLOSURE_TEXT)

    timeout = (
        classify_timeout_sec if classify_timeout_sec is not None
        else phone_classify_timeout_sec()
    )
    try:
        decision = await asyncio.wait_for(classify(), timeout=timeout)
    except asyncio.TimeoutError:
        decision = CLASSIFY_MACHINE
    except Exception:  # noqa: BLE001
        # A broken classifier must not become consent.
        decision = CLASSIFY_MACHINE
    if decision not in PHONE_CLASSIFICATIONS:
        decision = CLASSIFY_MACHINE

    if decision != CLASSIFY_HUMAN:
        event_type = _OUTCOME_EVENT[decision]
        outcome = await client.post_event(
            attempt_id, event_type, epoch=epoch,
        )
        if event_applied(outcome):
            events.append(event_type)
        closing = _OUTCOME_CLOSING.get(decision)
        if closing is not None:
            await _say(closing)
        _log.info(
            "unknown_event", error_type="phone_gate_outcome", schema=decision,
        )
        return PhoneGateResult(decision, events=events, spoken=spoken)

    human = await client.post_event(attempt_id, "classify.human", epoch=epoch)
    if not event_applied(human):
        # `ok` is not consent. An `ignored` verdict — terminal, stale_epoch,
        # unknown_attempt — means the API recorded NOTHING, and proceeding on it
        # would screen a candidate whose conversation the system has ended.
        _log.warn(
            "unknown_event", error_type="phone_gate_blocked",
            error_category="classify_human_failed",
        )
        return PhoneGateResult(CLASSIFY_HUMAN, events=events, spoken=spoken)
    events.append("classify.human")

    disclosure = await client.post_event(
        attempt_id, "disclosure.delivered", epoch=epoch,
    )
    if not event_applied(disclosure):
        # Consent was given on the wire but not recorded. Proceeding would score
        # a call whose consent the system cannot prove. An `ignored` verdict is
        # exactly that case: a 200 body that recorded nothing.
        _log.warn(
            "unknown_event", error_type="phone_gate_blocked",
            error_category="disclosure_not_recorded",
        )
        return PhoneGateResult(CLASSIFY_HUMAN, events=events, spoken=spoken)
    events.append("disclosure.delivered")

    if start_recording is not None:
        await start_recording()

    _log.info(
        "unknown_event", error_type="phone_gate_outcome", schema="human_consented",
    )
    return PhoneGateResult(
        CLASSIFY_HUMAN,
        assessment_allowed=True,
        recording_allowed=True,
        events=events,
        spoken=spoken,
    )


# ── The phone agent ───────────────────────────────────────────────────


def phone_agent_class(agent_base: Any) -> Any:
    """Build the phone Agent subclass over the SDK's ``Agent``.

    Built through a factory so the class is created against whatever ``Agent``
    the caller has (the real SDK in production, the stub under test) without
    this module importing the SDK at module scope.
    """

    class PhoneScreeningAgent(agent_base):  # type: ignore[misc, valid-type]
        """Christy on the phone. One tool: schedule a callback."""

        def __init__(
            self,
            instructions: str,
            *,
            client: PhoneEventClient,
            attempt_id: str,
            say: Callable[[str], Awaitable[Any]],
        ) -> None:
            super().__init__(instructions=instructions)
            self._client = client
            self._attempt_id = attempt_id
            self._say = say
            self.bookings: list[ScheduleTurn] = []

        @_tool
        async def schedule_callback(
            self,
            starts_at: str,
            duration_seconds: int,
        ) -> str:
            """Book a callback for a candidate who cannot talk right now.

            Args:
                starts_at: The absolute UTC instant to call back, ISO-8601 with
                    a literal Z, for example 2026-08-25T09:30:00Z.
                duration_seconds: How long to reserve, between 900 and 3600.
            """
            turn = await schedule_callback_turn(
                self._client, self._attempt_id, starts_at, duration_seconds
            )
            self.bookings.append(turn)
            await self._say(turn.spoken)
            return turn.spoken

    return PhoneScreeningAgent
