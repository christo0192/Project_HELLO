"""R1 over Google Meet, worker side (M034 S08): the channel resolver and its objective profiles.

A Meet round is the same Dex R1 interview, scoring and dashboard as a browser round; only the
transport changes.  The API books the round, a meeting bot joins the Google Meet, and a bridge
page inside that bot joins the ordinary ``screening-<uuid>`` LiveKit room under one exact
identity (``meet-<first 8 hex of the session id>``), publishing the mixed Meet audio as its
microphone.  The API's agent dispatch then carries ``{"session_id", "channel": "meet",
"candidate_identity", "profile"}`` and the room metadata mirrors ``channel`` and
``candidate_identity`` (``.gsd/milestones/M034/contracts/meet-contracts.md`` section 5).

Default OFF and inert: unless ``R1_MEET_VOICE_ENABLED`` is one of ``1``/``true``/``on``/``yes``
the resolver returns the browser decision before it reads anything from the job, so the worker
behaves exactly as it does today.  With the flag on, only a dispatch whose metadata says
``channel`` ``"meet"`` selects Meet, and then every binding fact must agree (the session id of
the room, the exact bridge identity, a known profile, the room-metadata mirror) or the decision
names one closed reason and the session fails closed before it connects: a Meet round that
cannot be bound exactly is never handed to "the first standard participant".

This module is pure: standard library only, no ``r1_*`` import, no logging (the session logs
the closed labels this module returns), and no function here raises.
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

R1_MEET_VOICE_FLAG = "R1_MEET_VOICE_ENABLED"
CHANNEL_MEET = "meet"
# Dispatch and room metadata are small server-written JSON objects; anything longer is not ours.
METADATA_MAX_CHARS = 8192
MEET_IDENTITY_RE = re.compile(r"^meet-[0-9a-f]{8}$")
# The closed set of reasons a Meet dispatch is refused (the session logs exactly one of them).
MEET_INVALID_REASONS = (
    "session_mismatch",
    "identity_invalid",
    "profile_unknown",
    "room_mirror_mismatch",
    "context_identity_mismatch",
    "unreadable",
)
# Mirrors the recorder's own ranking (a test pins the two equal): off < audio < av.
RECORDING_MODE_RANK = MappingProxyType({"off": 0, "audio": 1, "av": 2})

_ON_VALUES = frozenset({"1", "true", "on", "yes"})
_SESSION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def meet_voice_enabled() -> bool:
    """``R1_MEET_VOICE_ENABLED`` (default OFF): the worker side of R1 over Google Meet.

    Turn it on only as a Fly secret at go-live (``fly secrets set R1_MEET_VOICE_ENABLED=1
    -a project-hello-voice``), before the API's ``R1_MEET_ENABLED``.  Unset, blank, ``0`` or
    anything but ``1``/``true``/``on``/``yes`` is today's browser behaviour exactly.
    """
    return (os.getenv("R1_MEET_VOICE_ENABLED") or "").strip().lower() in _ON_VALUES


@dataclass(frozen=True)
class MeetProfile:
    """One objective profile: what a Meet round of this kind may do in the worker.

    ``max_recording_mode`` caps the recording (``off`` or ``audio``: a Meet bridge has no camera
    of the candidate's own); ``ready_button`` says whether the page's "I'm ready" relay exists
    (no button exists in Meet); ``track_mute_aside`` says whether a track mute is the
    candidate's microphone (in Meet it is the bridge's mixed track, so a mute is just silence).
    """

    id: str
    max_recording_mode: str
    ready_button: bool
    track_mute_aside: bool


# Pluggable: a new persona over Meet is one entry here (plus its own lines).  The ids match the
# API's objective profiles (app/api/src/lib/r1/meet/profiles.ts).
MEET_PROFILES: Mapping[str, MeetProfile] = MappingProxyType(
    {
        "r1_dex_sales": MeetProfile(
            id="r1_dex_sales",
            max_recording_mode="audio",
            ready_button=False,
            track_mute_aside=False,
        ),
    }
)


@dataclass(frozen=True)
class MeetChannel:
    """A Meet round that passed every check: the one identity to bind, and its profile."""

    candidate_identity: str
    profile: MeetProfile


@dataclass(frozen=True)
class ChannelDecision:
    """The resolver's answer: browser (both None), Meet (``meet``) or refused (``invalid_reason``)."""

    meet: MeetChannel | None = None
    invalid_reason: str | None = None


def expected_candidate_identity(session_id: str | None) -> str | None:
    """``meet-`` plus the first 8 hex of a UUID-shaped session id (lower case), else None."""
    if not isinstance(session_id, str) or not _SESSION_ID_RE.fullmatch(session_id):
        return None
    return "meet-" + session_id.lower()[:8]


def parse_metadata_object(raw: Any) -> dict[str, Any]:
    """A JSON object from a metadata string or UTF-8 bytes; ``{}`` for anything else.

    Not a string or bytes, bytes that are not UTF-8, longer than ``METADATA_MAX_CHARS``
    characters, not JSON, or JSON that is not an object: all ``{}``.  Never raises.
    """
    try:
        if isinstance(raw, (bytes, bytearray)):
            # A UTF-8 character is at most 4 bytes: anything longer cannot fit the bound.
            if len(raw) > METADATA_MAX_CHARS * 4:
                return {}
            raw = bytes(raw).decode("utf-8")
        if not isinstance(raw, str) or len(raw) > METADATA_MAX_CHARS:
            return {}
        parsed = json.loads(raw)
    except Exception:  # noqa: BLE001 - malformed metadata reads as no metadata
        return {}
    return parsed if isinstance(parsed, dict) else {}


def dispatch_metadata_of(ctx: Any) -> Any:
    """The agent dispatch's metadata (``ctx.job.metadata``), server-written; None when absent."""
    return getattr(getattr(ctx, "job", None), "metadata", None)


def room_metadata_of(ctx: Any) -> Any:
    """``ctx.room.metadata`` when set, else ``ctx.job.room.metadata`` (the order agent.py reads)."""
    metadata = getattr(getattr(ctx, "room", None), "metadata", None)
    if metadata:
        return metadata
    return getattr(getattr(getattr(ctx, "job", None), "room", None), "metadata", None)


def _is_meet(metadata: Mapping[str, Any]) -> bool:
    channel = metadata.get("channel")
    return isinstance(channel, str) and channel == CHANNEL_MEET


def _validate_meet(ctx: Any, session_id: str | None, dispatch: Mapping[str, Any]) -> ChannelDecision:
    """The Meet checks, in order; the first that fails names the decision's reason."""
    dispatch_session = dispatch.get("session_id")
    if not (
        isinstance(session_id, str)
        and session_id
        and isinstance(dispatch_session, str)
        and dispatch_session.lower() == session_id.lower()
    ):
        return ChannelDecision(invalid_reason="session_mismatch")
    identity = dispatch.get("candidate_identity")
    expected = expected_candidate_identity(session_id)
    if not (
        expected is not None
        and isinstance(identity, str)
        and MEET_IDENTITY_RE.fullmatch(identity)
        and identity == expected
    ):
        return ChannelDecision(invalid_reason="identity_invalid")
    profile_id = dispatch.get("profile")
    profile = MEET_PROFILES.get(profile_id) if isinstance(profile_id, str) else None
    if profile is None:
        return ChannelDecision(invalid_reason="profile_unknown")
    mirror = parse_metadata_object(room_metadata_of(ctx))
    mirror_identity = mirror.get("candidate_identity")
    if not (_is_meet(mirror) and isinstance(mirror_identity, str) and mirror_identity == identity):
        return ChannelDecision(invalid_reason="room_mirror_mismatch")
    return ChannelDecision(meet=MeetChannel(candidate_identity=identity, profile=profile))


def resolve_channel(ctx: Any, session_id: str | None, *, enabled: bool) -> ChannelDecision:
    """Browser, Meet or refused, for one session; never raises.

    ``enabled`` False returns the browser decision without touching ``ctx``.  Otherwise Meet is
    selected only when the dispatch metadata is a JSON object whose ``channel`` is exactly
    ``"meet"``; anything else is browser, silently.  Once Meet is selected every check must hold
    (``session_mismatch``, ``identity_invalid``, ``profile_unknown``, ``room_mirror_mismatch``, in
    that order), and an unexpected failure after that point is ``unreadable``.
    """
    if not enabled:
        return ChannelDecision()
    try:
        dispatch = parse_metadata_object(dispatch_metadata_of(ctx))
        if not _is_meet(dispatch):
            return ChannelDecision()
    except Exception:  # noqa: BLE001 - before Meet is known, a failure is the browser channel
        return ChannelDecision()
    try:
        return _validate_meet(ctx, session_id, dispatch)
    except Exception:  # noqa: BLE001 - a Meet dispatch that cannot be read fails closed
        return ChannelDecision(invalid_reason="unreadable")


def cap_recording_context(context: Mapping[str, Any], max_mode: str) -> dict[str, Any]:
    """A copy of the worker context whose ``recording.mode`` is at most ``max_mode``.

    Only a known mode ranked above the cap is lowered (``av`` to ``audio`` for a Meet round);
    ``off``, ``audio``, a missing or malformed ``recording`` pass through unchanged, and the input
    is never mutated.  An unknown ``max_mode`` caps to ``off`` (record nothing).  Never raises.
    """
    try:
        capped = dict(context) if isinstance(context, Mapping) else {}
        cap = max_mode if isinstance(max_mode, str) and max_mode in RECORDING_MODE_RANK else "off"
        recording = capped.get("recording")
        if not isinstance(recording, Mapping):
            return capped
        mode = recording.get("mode")
        if (
            isinstance(mode, str)
            and mode in RECORDING_MODE_RANK
            and RECORDING_MODE_RANK[mode] > RECORDING_MODE_RANK[cap]
        ):
            capped["recording"] = {**recording, "mode": cap}
        return capped
    except Exception:  # noqa: BLE001 - a context that cannot be copied records nothing
        return {}
