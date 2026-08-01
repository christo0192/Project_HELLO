"""Offline voice-quality validation harness (VOI-02..06), stdlib only.

This module is the pure-Python, offline-only foundation for the phase-8-l4
voice-quality lane. It computes deterministic text metrics (WER, entity
match) and validates *proposed* configuration fixtures (turn-taking / noise /
network / pronunciation / WER pairs).

Deliberate boundaries:
- No network, TTS, STT, audio, livekit, or supabase imports -- stdlib only.
- No runtime VAD tuning: profiles are validated for shape and bounds only.
- No measured-quality claims: validate_mos_rating performs bounds
  validation only and is never an acceptance/pass-fail decision.
"""

import math
import re
from dataclasses import dataclass
from typing import FrozenSet, List

PROPOSED_STATUS = "proposed"
DEFAULT_MAX_WORDS = 500

Entity = tuple[int, int, str]  # (start, end, label); end is exclusive.


class ProfileValidationError(ValueError):
    """Stable, non-sensitive validation failure for proposed fixtures."""


# ── Text normalization / WER ────────────────────────────────────────────


def normalize_text(text: str) -> List[str]:
    """Lowercase free text and split it into word tokens ([a-z0-9']+)."""
    return re.findall(r"[a-z0-9']+", text.lower())


def _levenshtein(source: List[str], target: List[str]) -> int:
    """Deterministic word-level Levenshtein distance (unit-cost edits)."""
    n, m = len(source), len(target)
    if n == 0:
        return m
    if m == 0:
        return n
    previous = list(range(m + 1))
    for i in range(1, n + 1):
        current = [i] + [0] * m
        source_token = source[i - 1]
        for j in range(1, m + 1):
            substitution_cost = 0 if source_token == target[j - 1] else 1
            current[j] = min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitution_cost,
            )
        previous = current
    return previous[m]


def word_error_rate(
    reference: str,
    hypothesis: str,
    *,
    max_words: int = DEFAULT_MAX_WORDS,
) -> float:
    """Deterministic word-level WER over normalized token lists.

    WER = (substitutions + deletions + insertions) / len(reference tokens),
    where the numerator is the unit-cost Levenshtein distance. Results are
    rounded to 6 decimal places. max_words guards the O(n*m) computation
    against abuse on both sides.
    """
    if not isinstance(reference, str) or not isinstance(hypothesis, str):
        raise TypeError("reference and hypothesis must be strings")
    reference_tokens = normalize_text(reference)
    hypothesis_tokens = normalize_text(hypothesis)
    if not reference_tokens:
        raise ValueError("reference must contain at least one word")
    if len(reference_tokens) > max_words or len(hypothesis_tokens) > max_words:
        raise ValueError("input exceeds max_words bound")
    distance = _levenshtein(reference_tokens, hypothesis_tokens)
    return round(distance / len(reference_tokens), 6)


# ── Entity metrics ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class EntityMetrics:
    """Deterministic entity-match metrics for one text."""

    precision: float
    recall: float
    f1: float
    matched: int
    reference_count: int
    predicted_count: int


def _validate_entity(entity, text_length: int) -> None:
    """Validate a single (start, end, label) entity tuple."""
    if not isinstance(entity, tuple) or len(entity) != 3:
        raise ValueError("entity must be a (start, end, label) tuple")
    start, end, label = entity
    if not isinstance(start, int) or isinstance(start, bool):
        raise ValueError("entity start must be an integer")
    if not isinstance(end, int) or isinstance(end, bool):
        raise ValueError("entity end must be an integer")
    if not (0 <= start < end <= text_length):
        raise ValueError("entity span out of bounds")
    if not isinstance(label, str) or not label:
        raise ValueError("entity label must be a non-empty string")


def entity_metrics(
    text: str,
    reference: List[Entity],
    predicted: List[Entity],
) -> EntityMetrics:
    """Compute precision/recall/f1 for exact (start, end, label) matching.

    Predicted overlaps are well-defined: exact matches are greedy in the
    given predicted order, and each reference entity matches at most once.
    """
    if not isinstance(text, str) or not text:
        raise ValueError("text must be a non-empty string")
    for entity in reference:
        _validate_entity(entity, len(text))
    for entity in predicted:
        _validate_entity(entity, len(text))
    if not reference:
        raise ValueError("reference entities must not be empty")

    ordered = sorted(reference, key=lambda entity: (entity[0], entity[1]))
    for previous, current in zip(ordered, ordered[1:]):
        if current[0] < previous[1]:
            raise ValueError("overlapping reference entities")

    matched = 0
    consumed = [False] * len(reference)
    for predicted_entity in predicted:
        for index, reference_entity in enumerate(reference):
            if not consumed[index] and reference_entity == predicted_entity:
                consumed[index] = True
                matched += 1
                break

    predicted_count = len(predicted)
    reference_count = len(reference)
    precision = (matched / predicted_count) if predicted_count else 0.0
    recall = matched / reference_count
    f1 = 0.0 if (precision + recall) == 0.0 else (2 * precision * recall) / (precision + recall)
    return EntityMetrics(
        precision=round(precision, 6),
        recall=round(recall, 6),
        f1=round(f1, 6),
        matched=matched,
        reference_count=reference_count,
        predicted_count=predicted_count,
    )


# ── MOS bounds (validation only -- never a pass/fail decision) ───────────


def validate_mos_rating(
    value,
    *,
    scale_min: float = 1.0,
    scale_max: float = 5.0,
) -> float:
    """Validate a MOS rating is numeric, finite, and within the scale.

    This is bounds validation only. It is not an acceptance/pass-fail
    decision and makes no measured-quality claim.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TypeError("MOS rating must be numeric")
    rating = float(value)
    if math.isnan(rating) or math.isinf(rating):
        raise ValueError("MOS rating must be finite")
    if rating < scale_min or rating > scale_max:
        raise ValueError("MOS rating out of range")
    return rating


# ── Fixture / profile validation ────────────────────────────────────────


def validate_fixture_document(
    doc: dict,
    *,
    allowed_collections: FrozenSet[str],
) -> dict:
    """Validate the shared fixture-document envelope (schema/version/status).

    Each name in allowed_collections may be present; collection-shaped
    values are lists, and singleton object sections (e.g. the pronunciation
    "protocol") are accepted as dicts.
    """
    if not isinstance(doc, dict):
        raise ProfileValidationError("document must be an object")
    allowed = frozenset({"schema", "version", "status", "description"}) | frozenset(allowed_collections)
    for key in doc:
        if key not in allowed:
            raise ProfileValidationError("unknown top-level key")
    for key in ("schema", "version", "status"):
        if key not in doc:
            raise ProfileValidationError("missing required key")
    schema = doc["schema"]
    if not isinstance(schema, str) or not schema:
        raise ProfileValidationError("invalid schema value")
    version = doc["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ProfileValidationError("invalid document version")
    status = doc["status"]
    if not isinstance(status, str) or status != PROPOSED_STATUS:
        raise ProfileValidationError("document status must be proposed")
    if "description" in doc and not isinstance(doc["description"], str):
        raise ProfileValidationError("invalid description value")
    for name in allowed_collections:
        if name in doc and not isinstance(doc[name], (list, dict)):
            raise ProfileValidationError("collection must be a list")
    return doc


def validate_profile_envelope(
    profile: dict,
    *,
    allowed_params: FrozenSet[str],
) -> dict:
    """Validate the shared profile envelope (id/name/version/status/params)."""
    if not isinstance(profile, dict):
        raise ProfileValidationError("profile must be an object")
    allowed = frozenset({"id", "name", "version", "status", "params"})
    for key in profile:
        if key not in allowed:
            raise ProfileValidationError("unknown profile key")
    for key in ("id", "name", "version", "status", "params"):
        if key not in profile:
            raise ProfileValidationError("missing profile key")
    profile_id = profile["id"]
    if not isinstance(profile_id, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile_id):
        raise ProfileValidationError("invalid profile id")
    name = profile["name"]
    if not isinstance(name, str) or not name:
        raise ProfileValidationError("invalid profile name")
    version = profile["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ProfileValidationError("invalid profile version")
    status = profile["status"]
    if not isinstance(status, str) or status != PROPOSED_STATUS:
        raise ProfileValidationError("profile status must be proposed")
    params = profile["params"]
    if not isinstance(params, dict):
        raise ProfileValidationError("params must be an object")
    for key in params:
        if key not in allowed_params:
            raise ProfileValidationError("unknown parameter")
    return profile


def _require_param(params: dict, name: str) -> None:
    if name not in params:
        raise ProfileValidationError("missing parameter")


def _require_number(value, minimum, maximum, *, integer: bool) -> float:
    """Validate an inclusive numeric bound; integer params reject bools."""
    if integer:
        if not isinstance(value, int) or isinstance(value, bool):
            raise ProfileValidationError("parameter must be an integer")
    else:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ProfileValidationError("parameter must be a number")
    number = float(value)
    if number < minimum or number > maximum:
        raise ProfileValidationError("parameter out of range")
    return number


def validate_turn_profile(profile) -> dict:
    """Validate a turn-taking control profile (VOI-02)."""
    profile = validate_profile_envelope(
        profile,
        allowed_params=frozenset(
            {
                "barge_in_sensitivity",
                "barge_in_trigger_ms",
                "candidate_cutoff_ms",
                "double_talk_window_ms",
                "vad_aggression",
            }
        ),
    )
    params = profile["params"]
    _require_param(params, "barge_in_sensitivity")
    _require_param(params, "barge_in_trigger_ms")
    _require_param(params, "candidate_cutoff_ms")
    _require_param(params, "double_talk_window_ms")
    _require_param(params, "vad_aggression")
    _require_number(params["barge_in_sensitivity"], 0.0, 1.0, integer=False)
    _require_number(params["barge_in_trigger_ms"], 50, 2000, integer=True)
    _require_number(params["candidate_cutoff_ms"], 50, 3000, integer=True)
    _require_number(params["double_talk_window_ms"], 0, 5000, integer=True)
    _require_number(params["vad_aggression"], 0, 3, integer=True)
    return profile


def validate_noise_profile(profile) -> dict:
    """Validate an ambient noise simulation profile (VOI-05)."""
    profile = validate_profile_envelope(
        profile,
        allowed_params=frozenset(
            {"scene", "noise_snr_db", "reverb_rt60_ms", "double_talk_overlap_ratio"}
        ),
    )
    params = profile["params"]
    _require_param(params, "scene")
    _require_param(params, "noise_snr_db")
    _require_param(params, "reverb_rt60_ms")
    _require_param(params, "double_talk_overlap_ratio")
    scene = params["scene"]
    if not isinstance(scene, str) or scene not in {
        "quiet_office",
        "coffee_shop",
        "street",
        "home",
        "meeting_room",
        "crowded",
    }:
        raise ProfileValidationError("unknown scene value")
    _require_number(params["noise_snr_db"], 0.0, 40.0, integer=False)
    _require_number(params["reverb_rt60_ms"], 0, 2000, integer=True)
    _require_number(params["double_talk_overlap_ratio"], 0.0, 1.0, integer=False)
    return profile


def validate_network_profile(profile) -> dict:
    """Validate a network condition profile (VOI-06)."""
    profile = validate_profile_envelope(
        profile,
        allowed_params=frozenset(
            {
                "bandwidth_kbps",
                "latency_ms",
                "jitter_ms",
                "packet_loss_pct",
                "reconnect",
            }
        ),
    )
    params = profile["params"]
    _require_param(params, "bandwidth_kbps")
    _require_param(params, "latency_ms")
    _require_param(params, "jitter_ms")
    _require_param(params, "packet_loss_pct")
    _require_param(params, "reconnect")
    _require_number(params["bandwidth_kbps"], 32, 100000, integer=True)
    _require_number(params["latency_ms"], 0, 2000, integer=True)
    _require_number(params["jitter_ms"], 0, 1000, integer=True)
    _require_number(params["packet_loss_pct"], 0.0, 100.0, integer=False)
    reconnect = params["reconnect"]
    if not isinstance(reconnect, dict):
        raise ProfileValidationError("reconnect must be an object")
    reconnect_keys = frozenset({"enabled", "max_reconnects", "reconnect_timeout_ms"})
    for key in reconnect:
        if key not in reconnect_keys:
            raise ProfileValidationError("unknown reconnect key")
    for key in reconnect_keys:
        if key not in reconnect:
            raise ProfileValidationError("missing reconnect key")
    if not isinstance(reconnect["enabled"], bool):
        raise ProfileValidationError("reconnect enabled must be a boolean")
    _require_number(reconnect["max_reconnects"], 0, 10, integer=True)
    _require_number(reconnect["reconnect_timeout_ms"], 0, 60000, integer=True)
    return profile


def validate_pronunciation_entry(entry) -> dict:
    """Validate one pronunciation protocol entry (VOI-04)."""
    if not isinstance(entry, dict):
        raise ProfileValidationError("entry must be an object")
    allowed = frozenset({"name", "role", "synthetic"})
    for key in entry:
        if key not in allowed:
            raise ProfileValidationError("unknown entry key")
    for key in ("name", "role", "synthetic"):
        if key not in entry:
            raise ProfileValidationError("missing entry key")
    name = entry["name"]
    if not isinstance(name, str) or not name:
        raise ProfileValidationError("invalid entry name")
    role = entry["role"]
    if not isinstance(role, str) or not role:
        raise ProfileValidationError("invalid entry role")
    synthetic = entry["synthetic"]
    if not isinstance(synthetic, bool) or not synthetic:
        raise ProfileValidationError("entry must be synthetic")
    return entry


def validate_pronunciation_protocol(doc) -> dict:
    """Validate the pronunciation protocol fixture document (VOI-04)."""
    doc = validate_fixture_document(
        doc,
        allowed_collections=frozenset({"protocol", "entries"}),
    )
    protocol = doc.get("protocol")
    if not isinstance(protocol, dict):
        raise ProfileValidationError("protocol must be an object")
    entries = doc.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ProfileValidationError("entries must be a non-empty list")
    protocol_keys = frozenset({"rating_scale", "raters_required", "synthetic_only"})
    for key in protocol:
        if key not in protocol_keys:
            raise ProfileValidationError("unknown protocol key")
    for key in protocol_keys:
        if key not in protocol:
            raise ProfileValidationError("missing protocol key")
    rating_scale = protocol["rating_scale"]
    if not isinstance(rating_scale, str) or not rating_scale:
        raise ProfileValidationError("invalid rating scale")
    raters_required = protocol["raters_required"]
    if not isinstance(raters_required, int) or isinstance(raters_required, bool) or raters_required < 1:
        raise ProfileValidationError("invalid raters required")
    synthetic_only = protocol["synthetic_only"]
    if not isinstance(synthetic_only, bool):
        raise ProfileValidationError("invalid synthetic only flag")
    for entry in entries:
        validate_pronunciation_entry(entry)
    return doc


def resolve_profile(profiles: list, profile_id: str, validator) -> dict:
    """Validate every profile with the given validator, then resolve by id."""
    if not isinstance(profiles, list):
        raise TypeError("profiles must be a list")
    validated = [validator(profile) for profile in profiles]
    for profile in validated:
        if profile["id"] == profile_id:
            return profile
    raise ProfileValidationError(f"unknown profile id: {profile_id}")
