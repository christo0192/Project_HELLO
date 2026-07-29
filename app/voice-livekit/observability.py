"""OBS-01 / OBS-02: Structured logging and correlation ID propagation for LiveKit worker.

Schema per line: timestamp (UTC ISO-8601 with Z suffix), level, component, event,
correlationId, plus an explicit allowlisted set of scalar metadata fields.

Two-pass value safety:
  1. Key allowlist — non-allowlisted keys silently dropped.
  2. Per-field value validation — each string field has a strict format constraint.
     A defense-in-depth scan rejects high-risk patterns (JWT, bearer token, PEM
     header, email, long digit run, provider API keys, high-entropy tokens) on
     every allowlisted string value.
     If a value fails either check the entire field is dropped — no partial
     fragment ever reaches json.dumps.
  3. Numeric fields require finite values within field-appropriate ranges.
  4. Envelope fields (timestamp, correlationId) are validated at runtime.
     Boolean values rejected for all metadata fields (none are boolean-typed).

Must mirror logger.ts (TypeScript) exactly for schema and event catalogue parity.
"""

from __future__ import annotations

import contextvars
import ipaddress
import json
import math
import re
import socket
import sys
import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

# ── Correlation ID context (token-based for nested restore) ──────────────────

_correlation_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "correlation_id", default=None
)

_UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_MAX_ID_LEN = 128


def validate_correlation_id(raw: Optional[str]) -> Optional[str]:
    """Return lower-cased UUID v4 on acceptance, None on any rejection."""
    if not raw:
        return None
    if len(raw) > _MAX_ID_LEN:
        return None
    if "," in raw:
        return None
    for ch in raw:
        c = ord(ch)
        if c <= 0x1F or c == 0x7F:
            return None
    trimmed = raw.strip()
    if not _UUID_V4_RE.match(trimmed):
        return None
    return trimmed.lower()


def set_correlation_id(raw: Optional[str]) -> contextvars.Token:
    """Validate *raw*; set and return a contextvar Token (for finally-block restore).

    When *raw* is absent or invalid a fresh UUID v4 is generated.
    The caller MUST call ``reset_correlation_id(token)`` in a finally block.
    """
    validated = validate_correlation_id(raw)
    cid = validated if validated is not None else str(uuid.uuid4())
    return _correlation_id.set(cid)


def get_correlation_id() -> Optional[str]:
    """Return the current task's correlation ID, or None outside request context."""
    return _correlation_id.get()


def reset_correlation_id(token: Optional[contextvars.Token] = None) -> None:
    """Restore the correlation ContextVar to its previous state.

    When called with a token (returned by set_correlation_id), the context is
    restored to the value *before* that set call.  When called without a token
    (or with None), the correlation ID is set to None.
    """
    if token is not None:
        _correlation_id.reset(token)
    else:
        _correlation_id.set(None)


# ── Runtime schema allowlists ─────────────────────────────────────────────────

_ALLOWED_LEVELS: frozenset[str] = frozenset({"debug", "info", "warn", "error"})

# Must mirror logger.ts EVENT_NAMES_SET exactly.
_ALLOWED_EVENTS: frozenset[str] = frozenset({
    "startup_listen",
    "csp_violation",
    "error_unhandled",
    "scoring_trigger",
    "scoring_failed",
    "session_complete",
    "session_fail",
    "db_turn_saved",
    "db_error",
    "unknown_event",
})

# ── Allowlisted metadata keys and their expected type tags ────────────────────

# Must mirror the TypeScript AllowedMeta keys exactly.
_KEY_TYPE_STRING: frozenset[str] = frozenset({
    "shape",
    "document_origin",
    "violated_directive",
    "effective_directive",
    "blocked_origin",
    "error_category",
    "error_type",
    "method",
    "model",
    "schema",
    "speaker",
})

_KEY_TYPE_NUMBER: frozenset[str] = frozenset({
    "status",
    "http_status",
    "port",
    "turn_index",
    "duration_sec",
})

# Allowlisted keys for rapid key-allowlist check (union of string + number).
_ALLOWED_META_KEYS: frozenset[str] = _KEY_TYPE_STRING | _KEY_TYPE_NUMBER

# ── Per-field value constraints ───────────────────────────────────────────────

_SPEAKER_ALLOWED: frozenset[str] = frozenset({"bot", "candidate"})
_SHAPE_ALLOWED: frozenset[str] = frozenset({"legacy", "reporting-api"})
_HTTP_METHODS: frozenset[str] = frozenset({
    "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE", "CONNECT",
})

# Component max length: 64 chars (parity with TypeScript SAFE_IDENT_RE max).
_SAFE_IDENT_RE = re.compile(r"^[a-zA-Z0-9_:.\-]{1,64}$")
_COMPONENT_RE = _SAFE_IDENT_RE
_CSP_DIRECTIVE_RE = re.compile(r"^[a-zA-Z0-9\-]{1,128}$")



# UTC ISO-8601 timestamp with Z suffix (capture groups for validation).
_TIMESTAMP_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$"
)

# ── Robust value-defense patterns ─────────────────────────────────────────────
#
# These are checked against EVERY allowlisted string value.  If any matches,
# the field is dropped entirely (never a partial fragment).
#
_DEFENSE_RE = re.compile(
    # JWT header
    r"eyJ[A-Za-z0-9_-]{4,}"
    # Bearer token
    r"|bearer\s+\S{8,}"
    # PEM key header
    r"|-{5}BEGIN\s"
    # Email address
    r"|[A-Za-z0-9._%+\-]{2,}@[A-Za-z0-9.\-]+\.[a-z]{2,}"
    # 10+ consecutive digits (phone, credit card, national ID, etc.)
    r"|\d{10,}"
    # OpenAI / Anthropic API keys
    r"|sk-[A-Za-z0-9]{20,}"
    # GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    r"|gh[psuoar]_[A-Za-z0-9]{16,}"
    # Slack tokens
    r"|xox[bpsa]-[A-Za-z0-9-]{8,}"
    # AWS Access Key ID
    r"|AKIA[A-Z0-9]{16}"
    # Generic high-entropy token: 30+ alphanumeric chars in a row with
    # at least one digit and one letter (likely an API key / secret).
    r"|[A-Za-z0-9]{30,}",
    re.IGNORECASE,
)


def _sanitise_str(val: str) -> str:
    """Truncate at first control character, then cap at 512 chars.

    Returns empty string if the original contained a control character,
    because emitting a partial fragment after truncation could leak
    a secret that was appended after the control char.
    """
    for i, ch in enumerate(val):
        c = ord(ch)
        if c <= 0x1F or c == 0x7F:
            # Truncation detected — drop the entire field to avoid
            # emitting a partial fragment of a potentially sensitive value.
            return ""
    return val[:512]


def _validate_string_field(key: str, val: str) -> Optional[str]:
    """Return validated/sanitised value or None (field must be dropped).

    Sanitisation (control-char truncation) happens FIRST, then defense
    scanning, then per-field format validation.
    """
    # 1. Sanitise first: strip control characters
    sanitised = _sanitise_str(val)
    if not sanitised:
        return None

    # 2. Defense scan on the sanitised value
    if _DEFENSE_RE.search(sanitised):
        return None

    # 3. Per-field format validation
    if key == "speaker":
        return sanitised if sanitised in _SPEAKER_ALLOWED else None
    if key == "shape":
        return sanitised if sanitised in _SHAPE_ALLOWED else None
    if key == "method":
        upper = sanitised.upper()
        return upper if upper in _HTTP_METHODS else None
    if key in ("document_origin", "blocked_origin"):
        # Use URL parser for robust origin validation
        return _validate_origin(sanitised)
    if key in ("violated_directive", "effective_directive"):
        return sanitised if _CSP_DIRECTIVE_RE.match(sanitised) else None
    if key in ("error_category", "error_type", "model", "schema"):
        return sanitised if _SAFE_IDENT_RE.match(sanitised) else None
    return sanitised


def _validate_origin(val: str) -> Optional[str]:
    """Validate a URL origin: http(s), no credentials/path/query/fragment.

    Uses ``urllib.parse.urlsplit`` for parsing and ``ipaddress`` for
    strict IP validation.  Returns the canonical origin string or None.

    Only bare http(s)://host:port origins are accepted — no userinfo,
    path, query, fragment, control chars, or IDNA surprises.
    """
    if not isinstance(val, str):
        return None
    if not val.startswith("http://") and not val.startswith("https://"):
        return None
    # Reject control characters
    for ch in val:
        c = ord(ch)
        if c <= 0x1F or c == 0x7F:
            return None
    try:
        parsed = urllib.parse.urlsplit(val)
    except Exception:  # noqa: BLE001
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    if parsed.username or parsed.password:
        return None  # Reject userinfo
    if parsed.path not in ("", "/"):
        return None  # Must not have path
    if parsed.query:
        return None
    if parsed.fragment:
        return None
    hostname = parsed.hostname
    if not hostname:
        return None
    # Match the API logger contract: only canonical URL-standard origins are
    # accepted here. Do not accept bracketed IPv6 literals because Python's
    # urlsplit/netloc reconstruction is not byte-for-byte parity with browser
    # URL.origin handling across all runtimes.
    if ":" in hostname:
        return None
    # Reject IDNA-encoded hostnames  (ASCII-encoded punycode)
    if hostname.startswith("xn--"):
        return None
    # Validate host: valid IPv4 or a conservative DNS hostname. Numeric dotted
    # quads that fail ipaddress validation are never valid hostnames for this
    # logging allowlist (e.g., 999.999.999.999 must be rejected).
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        if re.fullmatch(r"\d+(?:\.\d+){3}", hostname):
            return None
        hostname_re = re.compile(
            r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
            r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$"
        )
        if not hostname_re.match(hostname):
            return None
        if len(hostname) > 253:
            return None
    port = parsed.port
    if port is not None and (port < 1 or port > 65535):
        return None
    # Reconstruct exact canonical origin using urlsplit's netloc
    netloc = parsed.netloc.rsplit("@", 1)[-1]  # strip any userinfo
    return f"{parsed.scheme}://{netloc}"


def _validate_numeric_field(key: str, val: Any) -> Optional[Any]:
    """Return validated value or None (field must be dropped)."""
    if isinstance(val, bool):  # bool is int subclass; reject for numeric fields
        return None
    if not isinstance(val, (int, float)):
        return None
    if not math.isfinite(float(val)):
        return None
    if key == "port":
        return val if (isinstance(val, int) and 1 <= val <= 65535) else None
    if key in ("status", "http_status"):
        return val if (isinstance(val, int) and 100 <= val <= 599) else None
    if key == "turn_index":
        return val if (isinstance(val, int) and val >= 0) else None
    if key == "duration_sec":
        # Must be finite, non-negative, and capped at 1e6 (about 11.5 days)
        return val if (isinstance(val, (int, float)) and 0 <= val <= 1_000_000) else None
    return val


_FIXED_EPOCH = "1970-01-01T00:00:00.000Z"

_DAYS_IN_MONTH_NORMAL = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _days_in_month(yy: int, mm: int) -> int:
    if mm == 2:
        leap = (yy % 4 == 0 and (yy % 100 != 0 or yy % 400 == 0))
        return 29 if leap else 28
    return _DAYS_IN_MONTH_NORMAL[mm - 1]


def _validate_timestamp(val: Any) -> str:
    """Parse, calendar-validate, and re-serialize a UTC ISO-8601 timestamp.

    Returns the canonical Z-suffixed string on success, or FIXED_EPOCH
    when the value is missing, non-string, structurally invalid, or
    contains impossible date components (e.g., month=99, day=30 in Feb).
    Non-string / object clock output is caught and never calls __str__.

    Uses deterministic FIXED_EPOCH rather than ``datetime.now()``
    so that tests with injected corrupt clocks produce repeatable output.
    """
    if not isinstance(val, str):
        return _FIXED_EPOCH
    m = _TIMESTAMP_RE.match(val)
    if not m:
        return _FIXED_EPOCH

    yyyy = int(m.group(1))
    mm = int(m.group(2))
    dd = int(m.group(3))
    hh = int(m.group(4))
    min_ = int(m.group(5))
    sec = int(m.group(6))
    frac = (m.group(7) or "")[:9]

    if yyyy < 1970 or yyyy > 2100:
        return _FIXED_EPOCH
    if mm < 1 or mm > 12:
        return _FIXED_EPOCH
    if dd < 1 or dd > _days_in_month(yyyy, mm):
        return _FIXED_EPOCH
    if hh > 23:
        return _FIXED_EPOCH
    if min_ > 59:
        return _FIXED_EPOCH
    if sec > 59:
        return _FIXED_EPOCH

    # Re-serialize to canonical Z form
    y = f"{yyyy:04d}-{mm:02d}-{dd:02d}T{hh:02d}:{min_:02d}:{sec:02d}"
    if frac:
        return f"{y}.{frac}{'0' * max(0, 3 - len(frac))}Z"
    return f"{y}.000Z"


def _validate_correlation_envelope(val: Optional[str]) -> Optional[str]:
    """Validate the correlation ID envelope field.

    Must be None or a canonical UUID v4 string.
    Returns the validated value, or None as fallback.
    """
    if val is None:
        return None
    if _UUID_V4_RE.match(val):
        return val.lower()
    return None


def _default_writer(line: str) -> None:
    print(line, flush=True)  # noqa: T201 — intentional structured log output


# ── Structured logger ─────────────────────────────────────────────────────────

class StructuredLogger:
    """Component-scoped structured JSON logger.

    :param component:  Safe identifier for the source component.
    :param clock:      Optional override; returns an ISO-8601 UTC string with Z suffix.
    :param writer:     Optional override for the output sink.
    """

    def __init__(
        self,
        component: str,
        clock: Optional[Callable[[], str]] = None,
        writer: Optional[Callable[[str], None]] = None,
    ) -> None:
        # Defense-scan component too: drop secrets/high-entropy to "unknown"
        raw_comp = component
        if _COMPONENT_RE.match(raw_comp) and not _DEFENSE_RE.search(raw_comp):
            self._component = raw_comp
        else:
            self._component = "unknown"

        self._clock = clock or (lambda: datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
        self._writer = writer or _default_writer

    def _emit(self, level: str, event: str, meta: Optional[dict[str, Any]] = None) -> None:
        # Python rewrites invalid levels to "info" (divergence from JS which
        # silently drops).  See runbook for documented parity exception.
        if level not in _ALLOWED_LEVELS:
            level = "info"
        if event not in _ALLOWED_EVENTS:
            event = "unknown_event"

        # Validate envelope fields; fall back to safe values if corrupted.
        raw_ts = self._clock()
        raw_cid = _correlation_id.get()

        entry: dict[str, Any] = {
            "timestamp": _validate_timestamp(raw_ts),
            "level": level,
            "component": self._component,
            "event": event,
            "correlationId": _validate_correlation_envelope(raw_cid),
        }
        if meta:
            for k, v in meta.items():
                if k not in _ALLOWED_META_KEYS:
                    continue
                if v is None:
                    continue
                # Reject boolean — no boolean metadata fields exist
                if isinstance(v, bool):
                    continue
                if isinstance(v, str):
                    if k in _KEY_TYPE_STRING:
                        safe = _validate_string_field(k, v)
                        if safe is not None:
                            entry[k] = safe
                    # string value for a numeric-type key → drop
                elif isinstance(v, (int, float)):
                    if k in _KEY_TYPE_NUMBER:
                        safe = _validate_numeric_field(k, v)
                        if safe is not None:
                            entry[k] = safe
                    # numeric value for a string-type key → drop
                # non-scalar (object, array, etc.) → silently dropped

        # Serialise safely: default=None (which is merely the default and
        # does NOT add a custom serializer) means non-serialisable values
        # (e.g. objects with __str__) raise TypeError instead of being
        # silently stringified.  Catch TypeError so a malformed injected
        # clock/context/meta does not crash the request/job.
        try:
            self._writer(json.dumps(entry, default=None))
        except TypeError:
            # Last-resort fallback: emit minimal entry without the bad values
            safe: dict[str, Any] = {
                "timestamp": _validate_timestamp(raw_ts),
                "level": level,
                "component": self._component,
                "event": event,
                "correlationId": _validate_correlation_envelope(raw_cid),
            }
            self._writer(json.dumps(safe, default=None))

    def debug(self, event: str, **meta: Any) -> None:
        self._emit("debug", event, meta or None)

    def info(self, event: str, **meta: Any) -> None:
        self._emit("info", event, meta or None)

    def warn(self, event: str, **meta: Any) -> None:
        self._emit("warn", event, meta or None)

    def error(self, event: str, **meta: Any) -> None:
        self._emit("error", event, meta or None)
