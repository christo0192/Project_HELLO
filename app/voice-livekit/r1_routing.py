"""Server-authored R1 room-routing contract.

The API creates an R1 room with JSON room metadata ``{"lane": "r1"}``.
Clients cannot mutate room metadata, so this marker authorizes selection only
when ``R1_LANE_MODE=r1_only``.  An unmarked room remains legacy unless that
mode demands R1, while a marked room with a disabled or unknown mode is
refused.  This module is import-safe and contains no phone-lane dependency.
"""
from __future__ import annotations

import json
from typing import Any

R1_ROOM_METADATA_LANE_KEY = "lane"
R1_ROOM_METADATA_LANE_VALUE = "r1"
R1_ENABLED_MODES = frozenset({"r1_only"})


def room_is_r1(metadata: Any) -> bool:
    """Return true only for the exact server-authored R1 marker in JSON metadata."""
    if not isinstance(metadata, str):
        return False
    try:
        parsed = json.loads(metadata)
    except (TypeError, ValueError):
        return False
    return (
        isinstance(parsed, dict)
        and parsed.get(R1_ROOM_METADATA_LANE_KEY) == R1_ROOM_METADATA_LANE_VALUE
    )


def r1_mode_allows(mode: str | None) -> bool:
    """Allow R1 only for an explicit known mode; unknown values are never opt-in."""
    return (mode or "").strip() in R1_ENABLED_MODES


def routing_decision(mode: str | None, marked_r1: bool) -> str:
    """Return ``r1``, ``legacy``, or ``refuse`` without assigning legacy to an R1 room."""
    normalized = (mode or "").strip()
    enabled = r1_mode_allows(normalized)
    if marked_r1:
        return "r1" if enabled else "refuse"
    if enabled:
        return "refuse"
    return "legacy"
