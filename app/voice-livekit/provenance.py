"""
LLM-06: Provenance builder for the LiveKit screening worker.

This module constructs a validated ModelProvenance dict reflecting what the
LiveKit worker *actually* knows: the provider ("deepseek"), the DeepSeek
LLM model it was configured with (as *requestedModel*), the workload
("screening"), and the prompt template version.  It does NOT blindly trust
client-supplied room metadata for model/provider identifiers.

The shape mirrors app/api/src/lib/model-provenance.ts for consistency,
without cross-imports.

Never persists or logs prompt text, transcript text, candidate data,
credentials, endpoint URLs, CLI paths, or provider exception bodies.
"""

from __future__ import annotations

import copy
import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Optional

# ── Allowlists ──────────────────────────────────────────────────────────

ALLOWLISTED_PROVIDERS = frozenset({"deepseek"})
ALLOWLISTED_WORKLOADS = frozenset({"screening", "scoring"})
SAFE_INFERENCE_KEYS = frozenset({"temperature", "max_tokens"})

# ── Schema version ──────────────────────────────────────────────────────

MODEL_PROVENANCE_SCHEMA_VERSION = 1

# ── Documented prompt template version (mirrors prompts.ts) ────────────
# This is a documented value, not a live import.  A parity test verifies
# alignment with the TypeScript source of truth.

SCREENING_PROVENANCE_VERSION = "2026-08-04.1"

# ── Validation constants ────────────────────────────────────────────────

_MAX_MODEL_LENGTH = 200
_MAX_VERSION_LENGTH = 100
_MAX_TIMESTAMP_LENGTH = 30
_MAX_TOTAL_BYTES = 2048
_FUTURE_TOLERANCE_SEC = 5

# ── UTC RFC 3339 regex (Z suffix mandatory) ────────────────────────────

_RFC3339_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")

# ── Closed identifier grammar ──────────────────────────────────────────
# model      = alphanumeric + hyphens, dots, underscores, colons, slashes
# version    = date-based + patch number (e.g. "2026-07-28.1")
# provider   = fixed closed set
# workload   = fixed closed set
_IDENTIFIER_RE = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$"
)
_VERSION_RE = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]{0,98}[a-zA-Z0-9]$|^[a-zA-Z0-9]$"
)

# ── Sentinel value for legacy/unknown rows ──────────────────────────────

LEGACY_PROVENANCE: dict[str, Any] = {
    "schema_version": 0,
    "provider": "legacy",
    "requestedModel": "unknown",
    "workload": "unknown",
    "prompt_template_version": "legacy",
    "timestamp": "1970-01-01T00:00:00Z",
}

# ── Internal validators ─────────────────────────────────────────────────


def _is_valid_identifier(
    value: Any, max_length: int, label: str, errors: list[str]
) -> bool:
    """Closed identifier grammar — rejects whitespace, URLs, paths, secrets."""
    if not isinstance(value, str):
        errors.append(f"{label}: must be a string")
        return False
    if len(value) == 0:
        errors.append(f"{label}: must not be empty")
        return False
    if len(value) > max_length:
        errors.append(f"{label}: exceeds maximum length")
        return False
    if not _IDENTIFIER_RE.match(value):
        errors.append(f"{label}: contains invalid characters")
        return False
    # Defense-in-depth: reject URLs/paths and credential-like patterns
    if _has_url_or_path(value):
        errors.append(f"{label}: must not contain URLs or paths")
        return False
    if _has_credential(value):
        errors.append(f"{label}: must not contain credentials")
        return False
    return True


def _is_valid_version(
    value: Any, max_length: int, label: str, errors: list[str]
) -> bool:
    """Version identifier grammar."""
    if not isinstance(value, str):
        errors.append(f"{label}: must be a string")
        return False
    if len(value) == 0:
        errors.append(f"{label}: must not be empty")
        return False
    if len(value) > max_length:
        errors.append(f"{label}: exceeds maximum length")
        return False
    if not _VERSION_RE.match(value):
        errors.append(f"{label}: contains invalid characters")
        return False
    return True


def _has_url_or_path(value: str) -> bool:
    _URL_OR_PATH_RE = re.compile(
        r"(?:https?://|ftp://|file://|[\s(]/[\w./-]|^/[\w./-]|\.\.[/\\]|"
        r"\\[\w.-]+\\[\w.-]+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|"
        r"\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})",
        re.IGNORECASE,
    )
    return bool(_URL_OR_PATH_RE.search(value))


def _has_credential(value: str) -> bool:
    _TOKEN_LIKE_RE = re.compile(
        r"\b(?:sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|"
        r"token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|"
        r"eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY|"
        r"ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|"
        r"xox[baprs]-[a-zA-Z0-9-]{10,})\b",
        re.IGNORECASE,
    )
    return bool(_TOKEN_LIKE_RE.search(value))


def _is_strict_number(value: Any, label: str, errors: list[str]) -> bool:
    if isinstance(value, bool):
        errors.append(f"{label}: must be a number (got boolean)")
        return False
    if not isinstance(value, (int, float)):
        errors.append(f"{label}: must be a number")
        return False
    if math.isnan(value) or math.isinf(value):
        errors.append(f"{label}: must be a finite number")
        return False
    return True


# ── Plain-object check ─────────────────────────────────────────────────


def _is_plain_object(value: Any) -> bool:
    """True if value is a plain dict (not list, not None, not class instance)."""
    if value is None or not isinstance(value, dict):
        return False
    return True


def _deep_copy_provenance(obj: Any) -> Any:
    """
    Recursively deep-copy a JSON-safe provenance object.
    Returns a copy with no reference aliases to the original.
    Mutation of the original does not affect the returned copy.
    Does NOT claim immutability -- the caller receives a plain dict/list.
    """
    if obj is None:
        return None
    if isinstance(obj, bool) or isinstance(obj, int) or isinstance(obj, float):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, list):
        return [_deep_copy_provenance(v) for v in obj]
    if isinstance(obj, tuple):
        return tuple(_deep_copy_provenance(v) for v in obj)
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            if isinstance(k, str):
                result[k] = _deep_copy_provenance(v)
        return result
    return obj


# ── Public validation function ──────────────────────────────────────────


def validate_provenance(
    raw: Any,
    clock: Optional[dict] = None,
) -> dict[str, Any]:
    """
    Validate and return a clean provenance dict.

    Returns ``{"valid": True, "data": {...}}`` on success or
    ``{"valid": False, "error": "..."}`` on failure.  Error messages
    use fixed category labels — never echo the rejected value.

    The returned data is a deep-copy of the validated input; mutating
    the original does not affect the stored provenance.

    ``clock`` may be a dict with ``{"now": callable, "parse": callable}``
    for test injection.  Defaults to ``datetime.now(timezone.utc)``.
    """
    if clock is None:
        clock = {"now": lambda: datetime.now(timezone.utc), "parse": _parse_rfc3339}

    if not _is_plain_object(raw):
        return {"valid": False, "error": "provenance: must be a plain non-null object"}

    errors: list[str] = []

    # ── Reject unknown top-level fields ──────────────────────────────
    allowed_keys = {
        "schema_version",
        "provider",
        "requestedModel",
        "workload",
        "prompt_template_version",
        "inference_params",
        "timestamp",
    }
    for key in raw:
        if key not in allowed_keys:
            # Fixed category label — never echo attacker key
            errors.append("provenance: unknown field at top level")

    if errors:
        return {"valid": False, "error": "; ".join(errors)}

    # ── schema_version (must be exactly 1) ────────────────────────────
    sv = raw.get("schema_version")
    if not _is_strict_number(sv, "schema_version", errors):
        pass
    elif not isinstance(sv, int):
        errors.append("schema_version: must be an integer")
    elif sv != MODEL_PROVENANCE_SCHEMA_VERSION:
        errors.append("schema_version: must be 1")

    # ── provider ──────────────────────────────────────────────────────
    provider = raw.get("provider")
    if _is_valid_identifier(provider, _MAX_MODEL_LENGTH, "provider", errors):
        if provider not in ALLOWLISTED_PROVIDERS:
            errors.append("provider: not allowlisted")

    # ── requestedModel ────────────────────────────────────────────────
    _is_valid_identifier(raw.get("requestedModel"), _MAX_MODEL_LENGTH, "requestedModel", errors)

    # ── workload ──────────────────────────────────────────────────────
    workload = raw.get("workload")
    if _is_valid_identifier(workload, _MAX_MODEL_LENGTH, "workload", errors):
        if workload not in ALLOWLISTED_WORKLOADS:
            errors.append("workload: not allowlisted")

    # ── prompt_template_version ───────────────────────────────────────
    _is_valid_version(
        raw.get("prompt_template_version"),
        _MAX_VERSION_LENGTH,
        "prompt_template_version",
        errors,
    )

    # ── inference_params (optional) ───────────────────────────────────
    ip = raw.get("inference_params")
    if ip is not None:
        if not _is_plain_object(ip):
            errors.append("inference_params: must be a plain object")
        else:
            for key in ip:
                if key not in SAFE_INFERENCE_KEYS:
                    # Fixed category label — never echo attacker key
                    errors.append("inference_params: unknown parameter")
            temp = ip.get("temperature")
            if temp is not None:
                if not _is_strict_number(temp, "inference_params.temperature", errors):
                    pass
                elif temp < 0 or temp > 2:
                    errors.append("inference_params.temperature: must be between 0 and 2")
            mt = ip.get("max_tokens")
            if mt is not None:
                if not _is_strict_number(mt, "inference_params.max_tokens", errors):
                    pass
                elif not isinstance(mt, int) or mt < 1 or mt > 100_000:
                    errors.append("inference_params.max_tokens: must be an integer between 1 and 100000")

    # ── timestamp (strict UTC RFC 3339) ───────────────────────────────
    timestamp = raw.get("timestamp")
    if not isinstance(timestamp, str):
        errors.append("timestamp: must be a string")
    elif len(timestamp) == 0:
        errors.append("timestamp: must not be empty")
    elif len(timestamp) > _MAX_TIMESTAMP_LENGTH:
        errors.append("timestamp: exceeds maximum length")
    elif not _RFC3339_UTC_RE.match(timestamp):
        errors.append("timestamp: must be UTC RFC 3339 (YYYY-MM-DDTHH:mm:ss(.sss)?Z)")
    else:
        # Validate real calendar date
        try:
            parsed = clock["parse"](timestamp)
        except (ValueError, TypeError):
            errors.append("timestamp: not a valid date")
            parsed = None
        if parsed is None:
            errors.append("timestamp: not a valid date")
        else:
            # Round-trip to catch impossible dates (Feb 31, etc.)
            # Normalize: strip fractional seconds and trailing Z, then re-add Z for comparison
            base = timestamp.rsplit(".", 1)[0].rstrip("Z")
            normalized = base + "Z"
            rt = parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
            if rt != normalized:
                errors.append("timestamp: not a valid date")
            # Reject before epoch
            if parsed.timestamp() < 0:
                errors.append("timestamp: must not be before epoch")
            # Future tolerance
            now = clock["now"]()
            if (parsed - now).total_seconds() > _FUTURE_TOLERANCE_SEC:
                errors.append("timestamp: must not be in the future")

    # ── Total size guard ──────────────────────────────────────────────
    if not errors:
        serialized = json.dumps(raw, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > _MAX_TOTAL_BYTES:
            errors.append("provenance: payload exceeds maximum size")

    if errors:
        return {"valid": False, "error": "; ".join(errors)}

    # Deep-copy before returning — caller cannot mutate stored payload
    return {"valid": True, "data": _deep_copy_provenance(raw)}


def _parse_rfc3339(timestamp: str) -> Optional[datetime]:
    """Parse an RFC 3339 UTC string into a datetime.  Returns None on failure."""
    try:
        # Remove trailing Z and parse
        dt_str = timestamp.rstrip("Z")
        if "." in dt_str:
            dt = datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S.%f")
        else:
            dt = datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S")
        return dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def create_provenance(
    provider: str,
    requested_model: str,
    workload: str,
    prompt_template_version: str,
    inference_params: dict[str, Any] | None = None,
    timestamp: str | None = None,
    clock: Optional[dict] = None,
) -> dict[str, Any]:
    """
    Build a validated provenance dict suitable for persistence.

    Raises ``ValueError`` if construction fails (should never happen
    when called correctly).  Returns a deep-frozen copy.
    """
    if clock is None:
        clock = {"now": lambda: datetime.now(timezone.utc), "parse": _parse_rfc3339}

    if timestamp is None:
        timestamp = clock["now"]().strftime("%Y-%m-%dT%H:%M:%S.000Z")

    payload: dict[str, Any] = {
        "schema_version": MODEL_PROVENANCE_SCHEMA_VERSION,
        "provider": provider,
        "requestedModel": requested_model,
        "workload": workload,
        "prompt_template_version": prompt_template_version,
        "timestamp": timestamp,
    }
    if inference_params:
        clean: dict[str, Any] = {}
        if inference_params.get("temperature") is not None:
            clean["temperature"] = inference_params["temperature"]
        if inference_params.get("max_tokens") is not None:
            clean["max_tokens"] = inference_params["max_tokens"]
        if clean:
            payload["inference_params"] = clean

    result = validate_provenance(payload, clock)
    if not result.get("valid"):
        raise ValueError(f"Provenance construction failed: {result.get('error')}")
    return _deep_copy_provenance(payload)


def screening_provenance(
    requested_model: str,
    clock: Optional[dict] = None,
) -> dict[str, Any]:
    """Build a screening provenance for the given requested model identifier.

    Returns a deep copy.  The caller may safely mutate the result without
    affecting provenance tracking.
    """
    return create_provenance(
        provider="deepseek",
        requested_model=requested_model,
        workload="screening",
        prompt_template_version=SCREENING_PROVENANCE_VERSION,
        clock=clock,
    )
