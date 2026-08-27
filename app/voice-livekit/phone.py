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
import inspect
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

#: Upper bound on a dispatch epoch. An epoch counts a single attempt's
#: re-dispatches, so anything past this is drift or a hostile blob, not a
#: number the worker should carry into a lease claim.
MAX_DISPATCH_EPOCH = 1_000_000

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


def epoch_from_dispatch_metadata(ctx: Any) -> int | None:
    """Return the attempt EPOCH from the job's dispatch metadata, or None.

    The epoch is minted per DISPATCH, alongside the attempt id and on the same
    blob, and it is what lets the server tell this leg's claim on the attempt
    apart from a previous leg's — ``apply_phone_event`` answers ``ignored:
    stale_epoch`` when they disagree. The heartbeat carries it for exactly that
    reason: a stale leg must not be able to renew the live leg's lease.

    Fails closed, and the caller must treat that as a REFUSAL TO CONDUCT THE
    CALL rather than as "heartbeat disabled". Without an epoch the worker
    cannot renew the concurrency lease; an unrenewed lease lapses part-way
    through the screening, the reclaim sweep marks the attempt ``abandoned``
    and frees the fleet slot while the candidate is still speaking, and the
    assessment this leg eventually scores is then ignored. A conversation the
    system cannot account for is one the worker must not have.

    Strict on the type on purpose: the API mints a JSON number, so a string, a
    float or a bool is drift rather than a value to coerce. ``bool`` is
    excluded explicitly because it is an ``int`` in Python and ``True`` would
    otherwise read as epoch 1.
    """
    payload = _json_object(dispatch_metadata_of(ctx))
    channel = payload.get("channel")
    if not isinstance(channel, str) or channel.strip().lower() != PHONE_CHANNEL:
        return None
    epoch = payload.get("epoch")
    if isinstance(epoch, bool) or not isinstance(epoch, int):
        return None
    return epoch if 0 <= epoch <= MAX_DISPATCH_EPOCH else None


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


# ── Canary-1: the separately-armed owner canary ───────────────────────
# A parallel path that never enters the screening lane. It exists so the owner
# can place ONE call to their OWN handset and verify transport, audio, STT, TTS
# and the LLM, without a candidate row, without an admission, and without
# weakening any gate that protects a real candidate.
#
# THE INBOUND GUARD BELOW IS BUILT HERE, NOT INHERITED. An earlier revision of
# the Canary-1 design claimed `_DIGIT_RUN_RE` already refused inbound metadata
# blobs. It does not: that constant has zero runtime call sites, and its tests
# assert an OUTBOUND property of fixed spoken copy. `_json_object` applies no
# such check. So the guard is implemented, with its own test and its own seeded
# positive control, rather than cited.
#
# It is deliberately whole-blob and fail-closed: an unknown key ANYWHERE, or a
# 7+ digit run ANYWHERE in the serialized form, refuses the ENTIRE blob. The
# canary branch is then not entered, and the dispatch is inert — the shipped
# worker refuses it `phone_dispatch_unresolved` before `ctx.connect()`.
#
# The outbound half of the agreement lives in `lib/phone-canary1/ids.ts`: a
# uuid segment is eight hex characters and may legitimately be all digits, so
# the CLI re-mints any identifier whose rendering would trip this rule. The
# strict inbound rule therefore stays strict AND satisfiable, instead of
# refusing a few percent of honest runs at random — which is how a real guard
# acquires a reputation for flakiness and gets deleted.

#: The dispatch `mode` value that selects the canary branch.
CANARY_MODE = "canary"

#: Closed key set for the canary DISPATCH blob. NOTE what is absent:
#: `attempt_id` and `epoch`. Without them the shipped worker refuses this
#: dispatch outright, which is what makes a disarmed or rolled-back deployment
#: degrade to "a room nobody speaks in".
CANARY_DISPATCH_KEYS: frozenset[str] = frozenset({
    "session_id", "channel", "mode", "canary_id",
})

#: Closed key set for the canary ROOM blob.
CANARY_ROOM_KEYS: frozenset[str] = frozenset({
    "session_id", "room_name", "channel", "canary",
})

#: The worker's log handle. Eight lowercase hex characters and nothing else —
#: not a uuid, so it cannot be mistaken for an attempt or session id.
_CANARY_ID_RE = re.compile(r"^[0-9a-f]{8}$")


def _canary_blob(raw: Any, allowed: frozenset) -> dict:
    """Validate a canary metadata blob BEFORE reading anything out of it.

    Three refusals, all fail-closed to ``{}``:

      1. not decodable as a JSON object;
      2. a 7+ digit run anywhere in the serialized form — the shape of a
         dialable number, and the same rule 0042's metadata sanitizer applies;
      3. any key outside ``allowed``.

    Whole-blob, not per-field. A per-field check would read the fields it knows
    about and ignore the one an attacker or a careless edit added.
    """
    if not raw:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="ignore")
    if not isinstance(raw, str):
        return {}
    if _DIGIT_RUN_RE.search(raw):
        return {}
    payload = _json_object(raw)
    if not payload:
        return {}
    if not set(payload).issubset(allowed):
        return {}
    channel = payload.get("channel")
    if not isinstance(channel, str) or channel.strip().lower() != PHONE_CHANNEL:
        return {}
    return payload


def canary_mode_of(ctx: Any) -> str | None:
    """Return the dispatch ``mode`` when this is a valid canary dispatch."""
    payload = _canary_blob(dispatch_metadata_of(ctx), CANARY_DISPATCH_KEYS)
    mode = payload.get("mode")
    if not isinstance(mode, str) or mode.strip().lower() != CANARY_MODE:
        return None
    return CANARY_MODE


def canary_id_of(ctx: Any) -> str | None:
    """Return the opaque canary log handle, or None.

    Strict on the shape so the handle can never carry anything else. It is the
    ONLY canary identifier the worker ever logs.
    """
    payload = _canary_blob(dispatch_metadata_of(ctx), CANARY_DISPATCH_KEYS)
    canary_id = payload.get("canary_id")
    if not isinstance(canary_id, str) or not _CANARY_ID_RE.match(canary_id.strip()):
        return None
    return canary_id.strip()


def is_canary_room(room_metadata: Any) -> bool:
    """True when the ROOM declares itself a canary room.

    The second of the two signals the branch requires. The production room
    builder is a literal closed-key constructor that cannot emit ``canary``, so
    a real candidate's room can never satisfy this — that is a structural fact
    about the constructor, not an observation about today's values.
    """
    payload = _canary_blob(room_metadata, CANARY_ROOM_KEYS)
    return payload.get("canary") is True


def phone_canary_enabled() -> bool:
    """The third condition: an explicit worker-side arming flag.

    A Fly app SECRET, absent from `fly.phone.toml` and from version control, so
    the armed state is a deliberate operator action with a matching disarm step
    rather than something a deploy can carry in by accident.
    """
    return (os.getenv("PHONE_CANARY_ENABLED") or "").strip().lower() == "true"


def canary_participant_wait_sec() -> float:
    """The canary's OWN wait for 'something answered'.

    Deliberately NOT `phone_participant_wait_sec()`. That clock starts at JOB
    ASSIGNMENT, before the originate, so dispatch scheduling, a cold worker
    start (`num_idle_processes: 0`, `initialize_process_timeout: 60.0`) and the
    whole ring window are all charged against it. At the production default of
    45 s it can expire ON THE HEALTHY PATH, and the failure reads to an operator
    as a provider fault: the worker closes the room while the call is connecting
    or has just been answered.

    That is a wait charged against a budget sized for failure — the same class
    as the invite deadline this lane repaired once already. The repair is a
    dedicated knob sized for the canary sequence, and an inequality the CLI
    REFUSES on (`waits_misordered`: participant wait >= ring + 60) rather than
    an ambient hope that two defaults stay ordered.
    """
    return _bounded_float(os.getenv("PHONE_CANARY_PARTICIPANT_WAIT_SEC"), 120.0, 1.0, 180.0)


def canary_max_call_sec() -> float:
    """Hard ceiling on the canary conversation, seconds. Bounded, never a default."""
    return _bounded_float(os.getenv("PHONE_CANARY_MAX_CALL_SEC"), 180.0, 30.0, 300.0)


def canary_questions() -> int:
    """How many of the fixed canary questions to ask. Clamped to what exists."""
    return int(_bounded_float(os.getenv("PHONE_CANARY_QUESTIONS"), 2.0, 1.0, 3.0))


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

# ── Recording, the SESSION half ───────────────────────────────────────
# Recording has TWO independent mechanisms in this worker, and only one of them
# is the egress/attach path gated behind `disclosure.delivered`. The other is
# the Agents session recorder, passed at `session.start(..., record=...)`. Its
# default is NOT off, and the browser path deliberately passes a recording
# configuration — so a phone session that omitted the kwarg would record while
# the spoken disclosure said it did not.
#
# The constant lives HERE rather than in `agent.py` so that the production
# phone session and the Canary-1 session import the SAME OBJECT. A second
# literal in a second file is how the two drift, and the canary's disclosure
# says "this call is not being recorded" — a defect there becomes a spoken
# falsehood, which is the one class of bug this lane cannot take back.
PHONE_NO_RECORDING = {"audio": False, "transcript": False, "traces": False, "logs": False}


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
PHONE_SILENCE_PROMPT_TEXT = "Are you still there? No worries if you need a moment."
PHONE_SILENCE_GOODBYE_TEXT = (
    "Looks like you're unavailable, so I'll end the screening here. "
    "Thanks for your time, and goodbye."
)


#: Fixed copy the bot speaks that is NOT part of the screening record.
#:
#: Two kinds live here: the identity/disclosure/refusal lines the GATE speaks
#: before any screening begins, and the confirmations the callback tool and the
#: closing speak after it. Neither is evidence of a screening, and both are
#: delivered through `session.say`, which appends a conversation item exactly
#: like a generated turn does. Without this filter a scheduling confirmation
#: spoken mid-call would be captured inside whichever question's boundary
#: happened to be open, and committed as part of the candidate's answer.
#:
#: Matched by exact text because every member is a CONSTANT. A line that
#: changes has to change here too, which is the point: fixed copy is fixed.
def gate_copy_texts() -> frozenset[str]:
    """Every fixed line the bot may speak that is not a screening turn."""
    return frozenset([
        PHONE_DISCLOSURE_TEXT,
        PHONE_REASK_TEXT,
        PHONE_REFUSED_TEXT,
        PHONE_OPT_OUT_TEXT,
        PHONE_WRONG_NUMBER_TEXT,
        PHONE_ASSESSMENT_CLOSING_TEXT,
        PHONE_CANDIDATE_END_TEXT,
        PHONE_SILENCE_PROMPT_TEXT,
        PHONE_SILENCE_GOODBYE_TEXT,
        _SCHEDULE_CONFIRMED_TEXT,
        _SCHEDULE_REFUSAL_FALLBACK,
        *_SCHEDULE_REFUSAL_TEXT.values(),
    ])


def is_gate_copy(text: Any) -> bool:
    """True when this spoken line is fixed copy rather than a screening turn."""
    return isinstance(text, str) and text.strip() in gate_copy_texts()


# ── Worker event API ──────────────────────────────────────────────────

EVENTS_PATH = "/api/internal/phone/events"
APPOINTMENTS_PATH = "/api/internal/phone/appointments"
ASSESSMENT_START_PATH = "/api/internal/phone/assessment/start"
ASSESSMENT_TURN_PATH = "/api/internal/phone/assessment/turn"
ASSESSMENT_COMPLETE_PATH = "/api/internal/phone/assessment/complete"
#: P5: the lease renewal. Under `/api/internal/phone` with every other worker
#: call, because that is the ONE mount (`app.ts`: `app.use('/api/internal/phone',
#: phoneWorkerRouter)`). An earlier constant said `/api/phone-worker/...` and
#: invented a rationale for it in this very comment; nothing served that path,
#: so every beat 404'd and the agent halted a live call after two of them. A
#: cross-language test now pins this string against the Express mount.
HEARTBEAT_PATH = "/api/internal/phone/attempt/heartbeat"

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
    """Bounded timeout for internal worker events, including final scoring.

    Completion performs the durable session CAS and may synchronously invoke
    the scorer before returning. Ten seconds is shorter than the observed
    provider/API path, so it converts a successful call into a worker timeout
    and prevents the terminal event from being posted. Keep the bound finite;
    operators can narrow it, but the production default must cover normal
    completion latency.
    """
    return _bounded_float(os.getenv("PHONE_EVENT_TIMEOUT_SEC"), 30.0, 1.0, 60.0)


def phone_participant_wait_sec() -> float:
    """Bounded wall clock for 'has anything answered yet'."""
    return _bounded_float(os.getenv("PHONE_PARTICIPANT_WAIT_SEC"), 45.0, 1.0, 180.0)


def phone_classify_timeout_sec() -> float:
    """Bounded wall clock for the human/machine decision."""
    return _bounded_float(os.getenv("PHONE_CLASSIFY_TIMEOUT_SEC"), 20.0, 1.0, 120.0)


def phone_answer_timeout_sec() -> float:
    """Bounded wall clock for ONE question's exchange.

    A bound, not a target. Without it a candidate who goes quiet mid-answer
    leaves the leg waiting forever on a queue, holding a fleet slot and a live
    call, with no boundary to commit and nothing to end it.
    """
    return _bounded_float(os.getenv("PHONE_ANSWER_TIMEOUT_SEC"), 90.0, 5.0, 300.0)


# ── P5: the heartbeat cadence envelope ────────────────────────────────
#
# THE SERVER DICTATES THE CADENCE, because the server owns the lease. These
# three numbers are not a policy competing with it; they are the envelope the
# worker can actually honour, and they exist so a missing, absurd or hostile
# `next_heartbeat_seconds` cannot either spin this loop hot or stretch it past
# the lease.
#
#   * FALLBACK 20 s — `PHONE_BOUNDS.leaseSeconds` defaults to 60 and the queue
#     runner's own precedent is lease/3. Used only when the server told us
#     nothing usable.
#   * MAX 30 s — lease/2 at the default lease. A cadence at or past half the
#     lease cannot guarantee a second chance before it lapses, and the
#     consecutive-failure bound below is derived from this ceiling.
#   * MIN 2 s — `PHONE_BOUNDS.leaseSeconds` admits a lease as short as 5, so
#     the floor has to sit under half of that. It is a floor at all only so a
#     zero, negative or NaN value cannot turn the loop into a busy wait.
HEARTBEAT_FALLBACK_SEC = 20.0
HEARTBEAT_MIN_SEC = 2.0
HEARTBEAT_MAX_SEC = 30.0

#: How many CONSECUTIVE unconfirmed beats are tolerated before the leg halts.
#:
#: DERIVATION. The worker does not know the lease length — the server does —
#: but it knows the cadence the server chose under it, and a cadence is only
#: sound if it is at most half the lease (that is the invariant the clamp above
#: enforces from this side). So the smallest lease consistent with a cadence of
#: `interval` is `2 * interval`. Each consecutive failure costs one `interval`
#: of wall clock plus the request's own timeout, so after 2 of them the whole
#: GUARANTEED lease margin since the last confirmed renewal is spent and the
#: lease may already have lapsed. At that moment the hazard is identical to
#: `lease_lost` — the slot may already belong to another call — so the leg
#: stops. One blip is a network; two in a row is an unprovable lease.
HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 2

#: The two statuses `/attempt/heartbeat` answers. Enumerated rather than
#: inferred: anything else is drift and is treated as "we do not know",
#: never as a renewal.
HEARTBEAT_OK_STATUS = "ok"
HEARTBEAT_LEASE_LOST_STATUS = "lease_lost"


def heartbeat_interval_sec(raw: Any) -> float:
    """Clamp the server's cadence into the envelope the worker can honour.

    `bool` is rejected before the numeric parse for the same reason the epoch
    reader rejects it: `True` is an `int` and would otherwise clamp to the
    floor and look like a deliberate 2-second cadence.
    """
    if isinstance(raw, bool):
        return HEARTBEAT_FALLBACK_SEC
    return _bounded_float(
        raw, HEARTBEAT_FALLBACK_SEC, HEARTBEAT_MIN_SEC, HEARTBEAT_MAX_SEC
    )


class PhoneApiOutcome:
    """Result of one internal phone-API call.

    ``ok`` is the only field a caller may branch a SAFETY decision on. A missing
    or malformed body is never ``ok`` — the worker fails closed rather than
    assuming the server applied something it never confirmed.
    """

    __slots__ = (
        "ok", "status", "duplicate", "ignored_reason", "error_category",
        # 0044: carried only by the assessment calls. Declared here rather
        # than on a subclass so a caller that reads them on an event outcome
        # gets a truthful `None` instead of an AttributeError.
        "cursor", "plan_complete", "expected_key", "adopted",
        # P5: carried only by `heartbeat_attempt` — the SERVER's cadence for
        # the next beat, already clamped. Never a lease token: the response
        # carries none and never will.
        "next_heartbeat_seconds",
    )

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
        self.cursor: int | None = None
        self.plan_complete: bool = False
        self.expected_key: str | None = None
        self.adopted: bool = False
        self.next_heartbeat_seconds: float | None = None

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
        session_id: str | None = None,
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
        # The SESSION HINT (recording ordering fix, 2026-08-26). The server
        # starts the recording egress when `disclosure.delivered` is APPLIED,
        # but the session is not bound to the attempt row until
        # `/assessment/start` — later than the disclosure — so its DB read
        # came back empty and the recording start silently skipped on EVERY
        # call. The worker has known the session all along (dispatch metadata
        # and the `phone-<session>` room name), so it forwards it; the server
        # uses it only as the fallback for deriving the room to record. Omitted
        # entirely when absent: the server schema treats it as optional, and a
        # null key would say "I know it is null" rather than "I do not know".
        if session_id is not None and _UUID_RE.match(str(session_id).strip()):
            body["session_id"] = str(session_id).strip()

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

    async def heartbeat_attempt(
        self,
        attempt_id: str,
        session_id: str,
        *,
        epoch: int,
    ) -> PhoneApiOutcome:
        """Renew this attempt's concurrency lease for one more cadence.

        THREE OUTCOMES, and the caller acts differently on every one of them.
        Collapsing any two of them is the defect this method exists to make
        impossible:

          * ``ok`` True, ``status`` ``ok``, ``next_heartbeat_seconds`` set —
            the lease is renewed and the SERVER has said when to beat next.
          * ``ok`` False, ``status`` ``lease_lost`` — the slot is gone. The
            conversation must STOP: the reclaim sweep has already freed the
            slot and another call may be holding it, so continuing would run
            two conversations against one fleet slot.
          * ``ok`` False, ``status`` None, ``error_category`` set — we do not
            know. A blip is not a lost lease and must not halt a live call, but
            an unrenewed lease becomes a lost one, which is why the caller
            bounds how many of these it will accept in a row.

        ``ok`` is read from the server's flag AND its status, exactly as
        ``complete_assessment`` does. ``lease_lost`` arrives inside a 200 whose
        body says ``ok: true`` — reading that as success is precisely the
        mistake that keeps a candidate talking to a leg that owns nothing.

        THE RESPONSE CARRIES NO LEASE TOKEN and never will. The worker's claim
        on the lease is the triple it sends (attempt, epoch, session); there is
        nothing here to hold, hand on, or leak. The body is never logged, and
        neither is any of the triple.
        """
        body = {
            "attempt_id": str(attempt_id),
            "epoch": int(epoch),
            "session_id": str(session_id),
        }
        response = await self._post(HEARTBEAT_PATH, body, "attempt_heartbeat")
        if isinstance(response, str):
            return PhoneApiOutcome(False, error_category=response)

        data = _response_json(response)
        if not isinstance(data, dict) or data.get("ok") is not True:
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED, schema="attempt_heartbeat",
            )
            return PhoneApiOutcome(False, error_category=_ERR_MALFORMED)

        status = data.get("status")
        status_str = str(status) if status is not None else None
        if status_str == HEARTBEAT_LEASE_LOST_STATUS:
            _log.warn(
                "unknown_event", error_type="phone_lease_lost",
                error_category=HEARTBEAT_LEASE_LOST_STATUS,
            )
            return PhoneApiOutcome(False, HEARTBEAT_LEASE_LOST_STATUS)
        if status_str != HEARTBEAT_OK_STATUS:
            # An unrecognised status is NOT a renewal. It falls into the "we do
            # not know" class deliberately, so a server that starts answering
            # something new still runs out the failure bound rather than
            # letting the leg keep talking on a lease nobody confirmed.
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED, schema="attempt_heartbeat",
            )
            return PhoneApiOutcome(False, error_category=_ERR_MALFORMED)

        outcome = PhoneApiOutcome(True, HEARTBEAT_OK_STATUS)
        outcome.next_heartbeat_seconds = heartbeat_interval_sec(
            data.get("next_heartbeat_seconds")
        )
        return outcome

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


    # ── 0044: the durable half of a screening ─────────────────────────

    async def start_assessment(
        self,
        attempt_id: str,
        session_id: str,
    ) -> "PhoneAssessmentState":
        """Bind, activate and snapshot the plan; get the whole state back.

        Idempotent on the server, so a reconnecting leg calls exactly this and
        receives ITS OWN conversation — the original plan, the cursor, the
        completed keys and the persisted turns.

        A refusal is not an exception. The server distinguishes "the disclosure
        was never delivered" from "this session is not yours", and the caller
        must be able to act on the difference rather than on a thrown error.
        """
        body = {"attempt_id": str(attempt_id), "session_id": str(session_id)}
        response = await self._post(ASSESSMENT_START_PATH, body, "assessment_start")
        if isinstance(response, str):
            return PhoneAssessmentState(False, response)
        data = _response_json(response)
        if not isinstance(data, dict):
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED, schema="assessment_start",
            )
            return PhoneAssessmentState(False, _ERR_MALFORMED)
        return PhoneAssessmentState.parse(data)

    async def commit_boundary(
        self,
        session_id: str,
        question_key: str,
        expected_index: int,
        source_event_id: str,
        turns: list[dict[str, Any]],
    ) -> PhoneApiOutcome:
        """Commit ONE completed question boundary.

        ``ok`` is the only field a caller may branch on, and it is read from
        the server's own flag rather than inferred from the status string. A
        boundary that is not ``ok`` was not written, and the worker must
        neither ask the next question nor claim a completion.
        """
        body = {
            "session_id": str(session_id),
            "question_key": str(question_key),
            "expected_index": int(expected_index),
            "source_event_id": str(source_event_id),
            "turns": turns,
        }
        response = await self._post(ASSESSMENT_TURN_PATH, body, "assessment_turn")
        if isinstance(response, str):
            return PhoneApiOutcome(False, error_category=response)
        data = _response_json(response)
        if not isinstance(data, dict):
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED, schema="assessment_turn",
            )
            return PhoneApiOutcome(False, error_category=_ERR_MALFORMED)
        status = data.get("status")
        outcome = PhoneApiOutcome(
            data.get("ok") is True,
            str(status) if status is not None else None,
            duplicate=bool(data.get("duplicate")),
        )
        # Carried so the caller can re-sync its cursor from the SERVER rather
        # than from its own count — the count is what a reconnect invalidates.
        outcome.cursor = _bounded_int(data.get("cursor"))
        outcome.plan_complete = data.get("plan_complete") is True
        expected = data.get("expected_key")
        outcome.expected_key = str(expected) if isinstance(expected, str) else None
        return outcome

    async def complete_assessment(
        self,
        attempt_id: str,
        session_id: str,
    ) -> PhoneApiOutcome:
        """Complete the session, wait for scoring, and verify the row exists.

        ``ok`` here means an assessment EXISTS. It is the only thing that
        entitles the worker to post ``assessment.completed`` — and 0044 refuses
        that event anyway when the row is absent, so the claim is gated twice.
        """
        body = {"attempt_id": str(attempt_id), "session_id": str(session_id)}
        response = await self._post(ASSESSMENT_COMPLETE_PATH, body, "assessment_complete")
        if isinstance(response, str):
            return PhoneApiOutcome(False, error_category=response)
        data = _response_json(response)
        if not isinstance(data, dict):
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED, schema="assessment_complete",
            )
            return PhoneApiOutcome(False, error_category=_ERR_MALFORMED)
        status = data.get("status")
        status_str = str(status) if status is not None else None
        # `ok` alone is not enough, and a future server status must be added
        # here DELIBERATELY rather than confirmed by default.
        outcome = PhoneApiOutcome(
            data.get("ok") is True and status_str == ASSESSMENT_SCORED_STATUS,
            status_str,
        )
        outcome.adopted = data.get("adopted") is True
        return outcome


def _response_json(response: Any) -> Any:
    getter = getattr(response, "json", None)
    if not callable(getter):
        return None
    try:
        return getter()
    except Exception:  # noqa: BLE001
        return None


# ── 0044: the assessment plan, the resume, and the boundary loop ──────
#
# THE ONE IDEA IN THIS SECTION. A phone screening is a sequence of KEYED
# question boundaries, and the SERVER owns the key and the cursor. The worker
# never counts turns, never infers "which question was that", and never decides
# on its own that a question is done. It asks the key it is told it owes,
# commits the exchange, and re-reads the cursor from the answer.
#
# That is what makes a reconnect work at all: a second leg calls the same start
# endpoint, gets the same plan and a cursor that already reflects the first
# leg's work, and carries on from there. Nothing about "already answered" is
# derived from prose.

ASSESSMENT_SCORED_STATUS = "scored"
ASSESSMENT_QUEUED_STATUS = "scoring_queued"

#: `start_phone_assessment`'s answer for a session that is already `completed`
#: AND already carries a phone-sourced assessment: a SCORED screening whose
#: acknowledgement was lost. It is NOT a refusal to be retried and NOT a reason
#: to abort — the only legitimate action on it is to post
#: `assessment.completed`, which 0044 accepts because the row is there.
ASSESSMENT_ALREADY_SCORED_STATUS = "already_scored"

#: Completion answers worth trying again inside the same leg. Everything else
#: — `plan_incomplete`, `session_not_active`, `unknown_session`, `plan_missing`
#: — is a STATE rather than a fault, and retrying cannot change it.
#:
#: `phone_assessment_error` is deliberately ABSENT even though the route emits
#: it: the route emits it only with HTTP 500, and a 5xx is classified as a
#: transport failure before the body is ever parsed, so that string can never
#: arrive here as a `status`. Listing it would be vocabulary with no reachable
#: writer — it would read as coverage this set does not have. The 500 case is
#: covered by `retryable_completion` below, through the transport class.
RETRYABLE_COMPLETION_STATUSES: frozenset[str] = frozenset([
    "scoring_failed",
    "completion_failed",
    "scoring_queued",
])


def retryable_completion(outcome: "PhoneApiOutcome") -> bool:
    """True when this completion answer is worth trying again in this leg.

    TWO classes, and the second is the one that matters most. A refusal we
    understand (`scoring_failed`, `completion_failed`) is a fault. A TRANSPORT
    failure — a reset, a timeout, a 5xx — carries no status at all, and it is
    precisely the "blip between the worker and the API" this retry exists for.
    Keying only on `status` skipped it entirely, which meant the endpoint could
    succeed, insert the assessment, and lose its response, with zero retries.

    That is the worst of the three outcomes: the screening IS scored, the
    worker does not know it, and one leg later a refused start turns it
    terminal. Retrying is safe because the endpoint is idempotent by
    construction, which is what makes this a real fix rather than a hopeful one.

    ── AND THE SECOND CLASS IS NARROW, DELIBERATELY ──────────────────
    `error_category is not None` was too broad. `_post` also produces
    `configuration` (the worker secret is missing or under 32 characters) and
    `business_error` (a 4xx — for this endpoint, a 401/403 from a rotated
    secret, or a 400 from schema drift). Those are DETERMINISTIC: three
    attempts change nothing, and the caller then treats the exhausted result as
    "we do not know whether it scored" and posts nothing — which lets the
    webhook grant and CHARGE a reconnect, so the candidate is redialled.

    Rotating `WORKER_CONTEXT_SECRET` on the API before the worker would 403
    every completion in flight and redial each of those candidates up to three
    times. That is the same failure as laundering a quiet candidate into a line
    drop, arriving through the auth door instead of the conversational one. A
    request that never reached a decision-maker is a state we DO know, and it
    should end the call truthfully rather than spend a budget that belongs to
    the candidate.
    """
    if outcome.status is not None:
        return outcome.status in RETRYABLE_COMPLETION_STATUSES
    return outcome.error_category in (_ERR_TRANSPORT, _ERR_MALFORMED)

# What the bot says once every question is durable. A CONSTANT, like the
# disclosure, and for the same reason: the closing of a recorded screening call
# is not something a sampler should improvise. It is deliberately NOT persisted
# as a transcript turn — it is gate copy, exactly like the disclosure line, and
# the transcript is the evidence of the screening rather than a recording of
# every noise made on the call.
PHONE_ASSESSMENT_CLOSING_TEXT = (
    "That's everything I needed from my side. Thanks so much for your time "
    "today — the team will be in touch about next steps. Take care, bye."
)
PHONE_CANDIDATE_END_TEXT = (
    "Of course. I'll end the call now. Thanks for your time. Goodbye."
)

# Halt reasons. Every one stops the loop; they do NOT all mean the same thing
# afterwards, and collapsing them was a real defect.
#
#   * RETRYABLE (infrastructure): the boundary could not be made durable, or
#     the scorer could not be reached. The leg posts NO terminal event, because
#     the conversation is interrupted rather than over and 0042's reconnect
#     budget owns what happens next.
#   * CONVERSATIONAL: the candidate stopped answering. That is not a line drop
#     and must not be laundered into one — posting nothing would let the
#     webhook's `sip.participant_left` grant and CHARGE a reconnect, and the
#     candidate would be dialled back up to three times for having gone quiet,
#     on a dialer whose per-day index exists to prevent exactly that. These end
#     the call truthfully with `assessment.aborted`.
HALT_PERSISTENCE = "persistence_failed"
HALT_SCORING = "scoring_unreachable"
HALT_MALFORMED_EXCHANGE = "malformed_exchange"
HALT_NO_ANSWER = "no_exchange_captured"
# P5, and RETRYABLE in exactly the sense above. A lost or unprovable
# concurrency lease is an infrastructure failure, not a candidate outcome: the
# reclaim sweep has already moved the engagement out of `in_call` and restored
# its previous state, so `assessment.aborted` would be both untrue and — being
# gated on `in_call` — ignored anyway. The conversation is interrupted, and
# 0042's reconnect budget owns what happens next.
#
# TWO reasons rather than one, because they are two different facts and an
# operator has to be able to tell them apart: the server SAID the lease is gone,
# versus the worker could no longer prove the lease is his. The hazard is the
# same, which is why both halt; the diagnosis is not.
HALT_LEASE_LOST = "lease_lost"
HALT_LEASE_UNCONFIRMED = "lease_unconfirmed"
# A BOOKED CALLBACK. Not an infrastructure failure and not a candidate who went
# quiet: the schedule_callback tool ran, the server said ok, and 0042 has
# already moved the engagement to `scheduled` (in_call -> scheduled), so the
# room close's participant_left drop-edge (gated on in_call) is a no-op — no
# reconnect is charged and the redial happens at the booked slot. The leg must
# post NOTHING: `assessment.aborted` would terminalise an engagement the
# server just scheduled, and `assessment.completed` would be a lie.
HALT_CALLBACK_SCHEDULED = "callback_scheduled"
# The candidate explicitly asked to end THIS call. This is not an opt-out from
# future contact, so it must not write the digest suppression used by
# `candidate.opt_out`; the assessment is aborted and the room is closed.
HALT_CANDIDATE_ENDED = "candidate_ended_call"

#: The halt reasons that must post NOTHING. Enumerated rather than inferred, so
#: a new reason has to declare which kind it is instead of defaulting into the
#: silent one.
#: (`callback_scheduled` is in this set for its post-nothing PROPERTY, not
#: because it is retryable: the booking already owns the engagement's future.)
RETRYABLE_HALTS: frozenset[str] = frozenset([
    HALT_PERSISTENCE, HALT_SCORING, HALT_LEASE_LOST, HALT_LEASE_UNCONFIRMED,
    HALT_CALLBACK_SCHEDULED,
])


def halt_is_retryable(reason: Any) -> bool:
    """True when a halt must post no terminal event at all."""
    return isinstance(reason, str) and reason in RETRYABLE_HALTS


def _bounded_int(raw: Any) -> int | None:
    """Read a non-negative bounded integer, or None. Never raises."""
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    return raw if 0 <= raw <= 1000 else None


class PhonePlanQuestion:
    """One question in the immutable, session-scoped plan."""

    __slots__ = ("key", "text", "mandatory", "hint")

    def __init__(self, key: str, text: str, mandatory: bool, hint: str | None) -> None:
        self.key = key
        self.text = text
        self.mandatory = mandatory
        self.hint = hint


class PhoneAssessmentState:
    """What ``/assessment/start`` returned.

    ``ok`` is the only field a caller may branch a SAFETY decision on. A
    refusal carries its stable ``status`` so the worker can tell
    ``disclosure_not_delivered`` from ``session_candidate_mismatch``; neither
    is a reason to ask a question.
    """

    __slots__ = (
        "ok", "status", "candidate_name", "role_title", "role_focus",
        "role_required_skills", "interviewer_instructions", "resume_facts",
        "questions", "cursor", "next_key", "completed_keys", "turns", "assessment_exists",
        "already_scored", "plan_complete", "plan_source",
    )

    def __init__(self, ok: bool, status: str | None = None) -> None:
        self.ok = ok
        self.status = status
        self.candidate_name: str | None = None
        self.role_title: str | None = None
        self.role_focus: str | None = None
        self.role_required_skills: list[str] = []
        self.interviewer_instructions: str | None = None
        self.resume_facts: dict[str, Any] = {}
        self.questions: list[PhonePlanQuestion] = []
        self.cursor: int = 0
        self.next_key: str | None = None
        self.completed_keys: list[str] = []
        self.turns: list[dict[str, str]] = []
        self.assessment_exists: bool = False
        self.already_scored: bool = False
        self.plan_complete: bool = False
        self.plan_source: str | None = None

    @classmethod
    def parse(cls, data: dict[str, Any]) -> "PhoneAssessmentState":
        """Read the body FIELD BY FIELD. Never spreads, never trusts a shape.

        A plan that came back short of what it claims, or with no questions at
        all, is refused rather than run: a screening with a plan the worker only
        partly understood would ask a subset of the questions and then report a
        complete conversation.
        """
        status = data.get("status")
        status_str = str(status) if status is not None else None
        if data.get("ok") is not True:
            return cls(False, status_str)

        state = cls(True, status_str)
        context = data.get("context")
        if isinstance(context, dict):
            name = context.get("candidate_name")
            state.candidate_name = str(name) if isinstance(name, str) and name else None
            role_title = context.get("role_title")
            state.role_title = str(role_title)[:200] if isinstance(role_title, str) and role_title else None
            role_focus = context.get("role_focus")
            state.role_focus = str(role_focus)[:900] if isinstance(role_focus, str) and role_focus else None
            required = context.get("role_required_skills")
            if isinstance(required, list):
                state.role_required_skills = [
                    str(item)[:200] for item in required[:100]
                    if isinstance(item, str) and item.strip()
                ]
            instructions = context.get("interviewer_instructions")
            state.interviewer_instructions = (
                str(instructions)[:10000]
                if isinstance(instructions, str) and instructions else None
            )
            facts = context.get("candidate_evidence")
            if isinstance(facts, dict):
                # Keep the projection as data; prompting.format_resume_facts
                # applies the field-specific bounds before model delivery.
                state.resume_facts = dict(facts)

        plan = data.get("plan")
        declared = None
        if isinstance(plan, dict):
            source = plan.get("source")
            state.plan_source = str(source) if isinstance(source, str) else None
            declared = _bounded_int(plan.get("question_count"))
            raw_questions = plan.get("questions")
            if isinstance(raw_questions, list):
                for entry in raw_questions:
                    if not isinstance(entry, dict):
                        continue
                    key = entry.get("key")
                    text = entry.get("text")
                    if not isinstance(key, str) or not key:
                        continue
                    if not isinstance(text, str) or not text.strip():
                        continue
                    hint = entry.get("hint")
                    state.questions.append(PhonePlanQuestion(
                        key,
                        text.strip(),
                        entry.get("mandatory") is True,
                        str(hint) if isinstance(hint, str) and hint else None,
                    ))

        if not state.questions or declared != len(state.questions):
            _log.warn(
                "unknown_event", error_type="phone_api_failed",
                error_category=_ERR_MALFORMED, schema="assessment_plan",
            )
            return cls(False, _ERR_MALFORMED)

        progress = data.get("progress")
        if isinstance(progress, dict):
            state.cursor = _bounded_int(progress.get("cursor")) or 0
            nxt = progress.get("next_key")
            state.next_key = str(nxt) if isinstance(nxt, str) and nxt else None
            keys = progress.get("completed_keys")
            if isinstance(keys, list):
                state.completed_keys = [k for k in keys if isinstance(k, str)]
            state.plan_complete = progress.get("plan_complete") is True

        raw_turns = data.get("turns")
        if isinstance(raw_turns, list):
            for entry in raw_turns:
                if not isinstance(entry, dict):
                    continue
                speaker = entry.get("speaker")
                text = entry.get("text")
                if speaker in ("bot", "candidate") and isinstance(text, str) and text:
                    state.turns.append({"speaker": speaker, "text": text})

        state.assessment_exists = data.get("assessment_exists") is True
        state.already_scored = data.get("already_scored") is True
        return state

    def question_at(self, index: int) -> PhonePlanQuestion | None:
        if 0 <= index < len(self.questions):
            return self.questions[index]
        return None


def plan_source_event_id(question_key: str) -> str:
    """The idempotency key for one boundary.

    Derived from the QUESTION KEY, not from a counter or a clock, so a retry
    of the same boundary — in this leg or in a later one — converges on the
    original success instead of appending the exchange a second time. The
    server also enforces one row per (session, key), so the two agree.
    """
    return f"q:{question_key}"


#: The phone-call policy appended to the assessment agent's instructions.
#: The first live call proved its absence: the candidate said "I'm busy, call
#: me tomorrow" and the model IMPROVISED a promise ("I'll send you a link")
#: it has no ability to keep, while the question loop kept going. The policy
#: names the one legitimate path and forbids the improvisation.
PHONE_CALLBACK_POLICY_TEXT = (
    "\n\nPhone-call policy (mandatory):\n"
    "- If the candidate says they are busy, cannot talk, or asks to be called "
    "back later, STOP asking interview questions immediately.\n"
    "- Offer to book a callback and, once they name a time, call the "
    "schedule_callback tool with that time. The tool speaks the confirmation "
    "itself.\n"
    "- Never promise links, emails, messages, or follow-ups of any kind: you "
    "cannot send anything. Booking through schedule_callback is the ONLY "
    "commitment you may make.\n"
    "- If the tool refuses, say only what it said; do not improvise an "
    "alternative promise.\n"
    "- Ask one question at a time and wait for the answer. Never re-ask a "
    "question the candidate has already answered; briefly acknowledge and "
    "move on instead."
)


INTERRUPTED_QUESTION_PREFIX = "[interrupted question] "


# The rehydration bound. A reconnect's prior exchange is replayed into the
# prompt so the model can refer to what the candidate already said — but it is
# BOUNDED, because a long screening's transcript would otherwise grow the system
# prompt on every leg and eventually crowd out the instructions themselves.
RESUME_MAX_TURNS = 8
RESUME_MAX_CHARS = 300


def render_resume_context(turns: list[dict[str, str]]) -> str:
    """Render the persisted exchange for the prompt, or "" when there is none.

    This is how a reconnecting leg's model learns what was already said. It is
    deliberately NOT how the leg learns what to ask NEXT — that comes from the
    cursor, and a model reading this transcript is never asked to work out
    which questions remain. The two are separate on purpose: prose is what has
    no identity, and inferring identity from it is the failure this phase
    exists to prevent.

    Only the most recent turns are kept, and each is clipped, so the prompt has
    a bound no conversation length can breach.
    """
    if not turns:
        return ""
    recent = turns[-RESUME_MAX_TURNS:]
    lines = [
        "EARLIER IN A PREVIOUS PHONE LEG — use only for continuity; do NOT ask "
        "these again, but do NOT assume the line dropped or that every candidate "
        "utterance answered a question:"
    ]
    for turn in recent:
        speaker = "You" if turn.get("speaker") == "bot" else "Candidate"
        text = str(turn.get("text") or "").strip()
        if not text:
            continue
        if len(text) > RESUME_MAX_CHARS:
            text = text[:RESUME_MAX_CHARS] + "..."
        lines.append(f"{speaker}: {text}")
    if len(lines) == 1:
        return ""
    lines.append(
        "This is a fresh phone leg. Briefly re-establish the role and say you "
        "will continue, then ask the planned question supplied for this turn. "
        "Do not begin with a contextless acknowledgment such as 'Thanks'."
    )
    return "\n".join(lines)


class PhoneAssessmentResult:
    """The verdict of one leg's assessment run.

    Exactly one of the three outcomes is true, and each maps to a DIFFERENT
    terminal decision:

      * ``scored``  -> the worker may post ``assessment.completed``.
      * ``halted``  -> a persistence or infrastructure failure. The worker
        posts NOTHING: the conversation is not over, it is interrupted, and
        0042's existing reconnect budget owns what happens next. Posting a
        terminal event here would convert a retryable problem into a lost
        candidate.
      * neither     -> the conversation ended without completing. The worker
        posts ``assessment.aborted``, exactly as P4a did — truthful that the
        call happened and produced nothing.
    """

    __slots__ = ("scored", "halted", "halt_reason", "cursor", "completed", "status")

    def __init__(
        self,
        *,
        scored: bool = False,
        halted: bool = False,
        halt_reason: str | None = None,
        cursor: int = 0,
        completed: Optional[list[str]] = None,
        status: str | None = None,
    ) -> None:
        self.scored = scored
        self.halted = halted
        self.halt_reason = halt_reason
        self.cursor = cursor
        self.completed = completed if completed is not None else []
        self.status = status

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return (
            f"PhoneAssessmentResult(scored={self.scored}, halted={self.halted}, "
            f"halt_reason={self.halt_reason!r}, cursor={self.cursor})"
        )


# ── P5: the heartbeat that keeps the lease alive for the whole call ───
#
# THE ONE IDEA IN THIS SECTION. A concurrency lease sized to cover the
# ORIGINATE is not a lease on the CONVERSATION. 0042 sets the fleet cap's slot
# to be held only while `lease_expires_at > now`, extends the lease far enough
# to cover the dial, and says in as many words that the cap's correctness
# depends on the worker renewing it. Nothing renewed it. A screening runs for
# minutes, so the lease lapsed mid-call on every answered call, the slot was
# freed under a live conversation, the reclaim sweep marked the attempt
# `abandoned` while the candidate was still speaking, and the assessment this
# leg then scored was ignored because its edge is gated on `in_call`.
#
# This loop is that renewal. It does exactly one thing and it fails in exactly
# one direction: when it can no longer PROVE the slot is ours, it stops the
# conversation rather than keeping a candidate on a line the system has already
# given to somebody else.


async def run_phone_heartbeat(
    *,
    attempt_id: str,
    session_id: str,
    epoch: int,
    client: PhoneEventClient,
    halt: Callable[[str], Awaitable[Any]],
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    interval_sec: float | None = None,
    max_consecutive_failures: int = HEARTBEAT_MAX_CONSECUTIVE_FAILURES,
) -> str | None:
    """Beat until cancelled, or until the lease can no longer be proved.

    Returns the halt reason it stopped on, or runs forever — the caller is
    expected to cancel it in a ``finally`` when the conversation ends.

    ``sleep`` is the injected clock seam so the whole loop is testable without
    wall time. ``halt`` is how it stops the conversation; it is a callback
    rather than a raise because the conversation is being conducted by another
    task and the honest way to end it is to cancel that task, not to let an
    exception escape a background beat nobody is awaiting.

    THE FIRST BEAT IS IMMEDIATE. It is the only chance to learn the server's
    cadence before spending one, and a call answered on the last ring may have
    very little of the originate lease left.
    """
    interval = heartbeat_interval_sec(interval_sec)
    bound = max(1, int(max_consecutive_failures))
    failures = 0

    while True:
        try:
            outcome = await client.heartbeat_attempt(
                attempt_id, session_id, epoch=epoch,
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # A raising client is a fault, not a renewal. It counts against the
            # bound like any other unconfirmed beat rather than killing this
            # task silently — a dead heartbeat task is the original defect
            # wearing a different hat.
            outcome = PhoneApiOutcome(False, error_category=_ERR_TRANSPORT)

        if outcome.ok:
            failures = 0
            # Clamped HERE as well as in the client. The loop is what actually
            # spends the time, so it does not take the length of its own sleep
            # on trust from a field somebody else filled in.
            interval = heartbeat_interval_sec(outcome.next_heartbeat_seconds)
            _log.info("unknown_event", error_type="phone_lease_renewed")
        elif outcome.status == HEARTBEAT_LEASE_LOST_STATUS:
            # THE SLOT IS GONE. Another call may already be holding it, so
            # there is no version of "carry on" that is safe.
            _log.warn(
                "unknown_event", error_type="phone_heartbeat_halted",
                error_category=HALT_LEASE_LOST,
            )
            await halt(HALT_LEASE_LOST)
            return HALT_LEASE_LOST
        else:
            failures += 1
            _log.warn(
                "unknown_event", error_type="phone_heartbeat_failed",
                error_category=outcome.error_category or _ERR_MALFORMED,
            )
            if failures >= bound:
                # The guaranteed lease margin since the last confirmed renewal
                # is spent — see HEARTBEAT_MAX_CONSECUTIVE_FAILURES. From here
                # the hazard is indistinguishable from `lease_lost`.
                _log.warn(
                    "unknown_event", error_type="phone_heartbeat_halted",
                    error_category=HALT_LEASE_UNCONFIRMED,
                )
                await halt(HALT_LEASE_UNCONFIRMED)
                return HALT_LEASE_UNCONFIRMED

        await sleep(interval)


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
    session_id: str | None = None,
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
        attempt_id, "disclosure.delivered", epoch=epoch, session_id=session_id,
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


_END_CALL_RE = re.compile(
    r"\b(?:disconnect|hang\s*up|end|stop)\s+(?:the\s+|this\s+)?call\b|"
    r"\b(?:please\s+)?(?:disconnect|hang\s*up)\b",
    re.IGNORECASE,
)


def is_explicit_end_call_request(text: Any) -> bool:
    """Recognise an unambiguous request to end the current call only."""
    return isinstance(text, str) and _END_CALL_RE.search(text) is not None


_HESITATION_ONLY_RE = re.compile(
    r"^\s*(?:(?:um+|uh+|h+m+|er+|ah+|sorry|okay|ok|one moment|"
    r"give me (?:a|one) (?:moment|second)|let me think)[\s,.!?-]*){1,4}$",
    re.IGNORECASE,
)
_ROLE_CLARIFICATION_RE = re.compile(
    r"\b(?:which|what)\s+(?:job\s+)?(?:role|position)\b|"
    r"\b(?:role|position)\b.{0,48}\b(?:appl(?:y|ied)|interview)\b|"
    r"\b(?:tell|remind|repeat|revise)\b.{0,48}\b(?:role|position|job)\b",
    re.IGNORECASE,
)
_QUESTION_OPEN_RE = re.compile(
    r"^\s*(?:can|could|would|will|what|which|who|where|when|why|how|"
    r"is|are|do|does|did)\b",
    re.IGNORECASE,
)
_GENERAL_CLARIFICATION_RE = re.compile(
    r"\b(?:can|could|would)\s+you\s+(?:please\s+)?"
    r"(?:repeat|rephrase|explain|clarify|say\s+that\s+again)\b|"
    r"\b(?:i\s+did(?:n't|\s+not)\s+(?:hear|understand)|what\s+do\s+you\s+mean)\b|"
    r"\b(?:forgot|not\s+sure)\b.{0,40}\bwhich\b",
    re.IGNORECASE,
)
_CONNECTIVITY_RE = re.compile(
    r"^(?:(?:yeah|yes|okay|ok|hello|hi|sorry)[\s,.-]+){0,3}"
    r"(?:can|could|do)\s+you\s+(?:still\s+)?(?:hear|see)\s+me\??$|"
    r"^(?:(?:yeah|yes|okay|ok|hello|hi)[\s,.-]+){0,3}"
    r"(?:are\s+you\s+there|is\s+the\s+line\s+(?:working|clear))\??$",
    re.IGNORECASE,
)
_CALLBACK_DEFERRAL_RE = re.compile(
    r"\b(?:call|ring)\s+me\s+(?:back\s+)?(?:later|tomorrow|another\s+time)\b|"
    r"\b(?:can|could)\s+(?:you|we)\s+(?:call\s+back|reschedule)\b|"
    r"\b(?:i(?:'m|\s+am)\s+busy\s+(?:right\s+now|at\s+the\s+moment)|"
    r"i\s+(?:cannot|can't)\s+talk\s+(?:right\s+now|at\s+the\s+moment)|"
    r"this\s+is\s+not\s+a\s+good\s+time)\b",
    re.IGNORECASE,
)


def candidate_turn_route(text: Any) -> str | None:
    """Classify only the local conversational turns that must not advance.

    This deliberately is not a semantic answer scorer. It recognises the
    bounded, high-confidence cases observed on the production call: a filler
    while the candidate gathers their thoughts, or a direct question to the
    interviewer. Everything else remains candidate evidence and is handled by
    the existing durable boundary contract.
    """
    if not isinstance(text, str):
        return None
    clean = " ".join(text.strip().split())
    if not clean or is_explicit_end_call_request(clean):
        return None
    if _HESITATION_ONLY_RE.fullmatch(clean):
        return "hesitation"
    if _ROLE_CLARIFICATION_RE.search(clean):
        return "role_clarification"
    if _CONNECTIVITY_RE.fullmatch(clean):
        return "connectivity_check"
    if _CALLBACK_DEFERRAL_RE.search(clean):
        return "callback_deferral"
    if _GENERAL_CLARIFICATION_RE.search(clean):
        return "candidate_question"
    if clean.endswith("?") and _QUESTION_OPEN_RE.search(clean):
        return "candidate_question"
    return None


def _message_text(message: Any) -> str:
    """Read the complete text surface exposed by LiveKit ChatMessage.

    The SDK's normal surface is ``text_content``. A few provider/test message
    shapes expose content parts instead, so falling back to every text-bearing
    part prevents the first or last fragment from disappearing at the adapter
    boundary.
    """
    text = getattr(message, "text_content", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    content = getattr(message, "content", None) or []
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        else:
            value = getattr(part, "text", None)
            if isinstance(value, str):
                parts.append(value)
    return "".join(parts).strip()


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
            on_user_turn: Callable[[str, Any, Any], Any] | None = None,
            on_booking: Callable[[ScheduleTurn], Any] | None = None,
            native_turns: bool = False,
        ) -> None:
            super().__init__(instructions=instructions)
            self._client = client
            self._attempt_id = attempt_id
            self._say = say
            self._on_user_turn = on_user_turn
            self._on_booking = on_booking
            # Native mode lets LiveKit continue its normal reply lifecycle after
            # the durable callback. The legacy scripted loop remains available
            # only to old injected callers while the migration is staged.
            self._native_turns = native_turns
            self.bookings: list[ScheduleTurn] = []

        async def on_user_turn_completed(self, turn_ctx: Any, new_message: Any) -> None:
            """Persist the user turn and optionally return to LiveKit's scheduler.

            Native phone screening deliberately does not raise ``StopResponse``:
            after the durable callback, LiveKit owns the ordinary reply,
            interruption, and playout lifecycle just as it does for WebRTC.
            """
            text = _message_text(new_message)
            if self._native_turns:
                # `turn_ctx` is the SDK's temporary context for THIS reply.
                # Do not mutate the durable Agent chat context or append the
                # user message: AgentActivity owns both, and will add the
                # message exactly once after this hook returns.
                if self._on_user_turn is not None and text:
                    observed = self._on_user_turn(text, new_message, turn_ctx)
                    if inspect.isawaitable(observed):
                        await observed
                return

            items = getattr(turn_ctx, "items", None)
            if not isinstance(items, list):
                raise RuntimeError("phone_turn_context_unavailable")
            items.append(new_message)
            await self.update_chat_ctx(turn_ctx)
            if self._on_user_turn is not None and text:
                observed = self._on_user_turn(text, new_message)
                if inspect.isawaitable(observed):
                    await observed
            # Legacy scripted-loop compatibility. Native production screening
            # never reaches this branch.
            from livekit.agents import StopResponse  # noqa: PLC0415
            raise StopResponse()

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
            if turn.booked and self._on_booking is not None:
                observed = self._on_booking(turn)
                if inspect.isawaitable(observed):
                    await observed
                if self._native_turns:
                    # Fixed confirmation already completed playout. Suppress
                    # only the tool follow-up so the model cannot append another
                    # promise or interview question after a booked callback.
                    from livekit.agents import StopResponse  # noqa: PLC0415
                    raise StopResponse()
            return turn.spoken

    return PhoneScreeningAgent
