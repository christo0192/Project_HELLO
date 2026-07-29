"""
provider_resilience.py — REUSABLE ASYNCIO CIRCUIT BREAKER + TIMEOUT HTTP

Provides:
  1. Deterministic async circuit breaker (CLOSED / OPEN / HALF_OPEN).
  2. Safe HTTP helper with connect/read/write/pool timeouts and non-disclosing
     diagnostics using allowlisted endpoint codes only.
  3. Injectable transport and clock for deterministic testing — no real HTTP.
  4. Lazy httpx transport — only resolved at first scoring call via factory.

FAILURE RULES (classified INSIDE the breaker):
  - Transport errors (timeout, connection refused, DNS failure) → count
  - HTTP 408, 429, 3xx, and 5xx → count toward breaker threshold
  - HTTP 4xx (excluding 408/429) → BusinessError, do NOT count
  - All error messages use stable category codes — no dynamic values.

Transport is constructed lazily via create_scoring_transport(). Tests using
FakeTransport never need httpx installed.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

logger = logging.getLogger("voice-livekit.provider_resilience")

# Lazy httpx import — only needed for HttpxTransport
_httpx: Any = None


def _get_httpx():
    global _httpx
    if _httpx is None:
        import httpx as _httpx_module
        _httpx = _httpx_module
    return _httpx


# ── Safe env parser ────────────────────────────────────────────────

_ALLOWED_HINTS = frozenset({"assess", "unknown"})

_FIXED_NAN_MSG = "env var must be a finite number"
_FIXED_POSITIVE_MSG = "env var must be positive"
_FIXED_NONNEG_MSG = "env var must be non-negative"
_FIXED_RANGE_MSG = "env var outside allowed range"
_FIXED_INT_MSG = "env var must be a positive integer"


def parse_env_float(
    raw: Optional[str],
    default: float,
    *,
    min_val: float = 0.1,
    max_val: float = 3600.0,
    allow_zero: bool = False,
) -> float:
    """Parse an env var with strict validation. Rejects NaN/Infinity/bool/zero/negative/excessive.

    Error messages use fixed text only — no raw values."""
    if raw is None or raw.strip() == "":
        return default
    try:
        v = float(raw)
    except (ValueError, TypeError):
        raise TypeError(_FIXED_NAN_MSG)
    if isinstance(v, bool) or math.isnan(v) or math.isinf(v):
        raise TypeError(_FIXED_NAN_MSG)
    if not allow_zero and v <= 0:
        raise TypeError(_FIXED_POSITIVE_MSG)
    if allow_zero and v < 0:
        raise TypeError(_FIXED_NONNEG_MSG)
    if v > max_val:
        raise TypeError(_FIXED_RANGE_MSG)
    if v != 0.0 and v < min_val:
        raise TypeError(_FIXED_RANGE_MSG)
    return v


def parse_env_int(
    raw: Optional[str],
    default: int,
    *,
    min_val: int = 1,
    max_val: int = 1000,
) -> int:
    """Parse an env var as positive integer. Fixed non-disclosing messages."""
    if raw is None or raw.strip() == "":
        return default
    try:
        v = int(raw)
    except (ValueError, TypeError):
        raise TypeError(_FIXED_INT_MSG)
    if isinstance(v, bool):
        raise TypeError(_FIXED_INT_MSG)
    if v < min_val or v > max_val:
        raise TypeError(_FIXED_RANGE_MSG)
    return v


# ── Circuit state enum ─────────────────────────────────────────────


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


# ── Error types ────────────────────────────────────────────────────


class ProviderError(Exception):
    """A provider-availability failure that SHOULD count toward the breaker.

    Message is always the stable category code — no dynamic values."""

    def __init__(self, category: str = "connection") -> None:
        super().__init__(category)
        self.category = category


class BusinessError(Exception):
    """A business/validation error that does NOT count toward the breaker."""

    def __init__(self) -> None:
        super().__init__("business_error")


def _is_provider_failure(err: Exception) -> bool:
    """Check whether an exception is a provider-availability failure."""
    if isinstance(err, ProviderError):
        return True
    return False


# ── Clock abstraction ─────────────────────────────────────────────


class Clock:
    """Abstract clock. Override for deterministic tests."""

    def time(self) -> float:
        return time.monotonic()


class RealClock(Clock):
    pass


# ── HTTP status classification ─────────────────────────────────────


def _classify_http_status(status: Any) -> Optional[type]:
    """Classify an HTTP status.

    Returns:
        None          — 2xx success
        ProviderError — 3xx, 408, 429, 5xx, or invalid/non-integer/bool/1xx/negative
        BusinessError — other 4xx (400-407, 409-427, 430-499 excl. 408/429)

    ProviderError counts toward breaker; BusinessError does not.
    Invalid types (bool, non-int, None, negative, out-of-range) are protocol errors."""
    # Reject non-integer / bool / None
    if status is None or isinstance(status, bool) or not isinstance(status, int):
        return ProviderError
    # Reject out-of-range (1xx, negative, very-large)
    if status < 200 or status > 599:
        return ProviderError
    # 2xx success
    if 200 <= status < 300:
        return None
    # Provider protocol errors
    if (300 <= status < 400) or status in (408, 429) or status >= 500:
        return ProviderError
    # Other 4xx (business errors)
    if 400 <= status < 500:
        return BusinessError
    return ProviderError


# ── Async transport (abstract) ────────────────────────────────────


class AsyncTransport:
    """Abstract async HTTP client. Override for tests — no real network."""

    async def request(
        self,
        method: str,
        url: str,
        *,
        json: Any = None,
        timeout: Any = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        raise NotImplementedError

    async def close(self) -> None:
        pass


class FakeTransport(AsyncTransport):
    """Deterministic transport for testing. No real network or httpx dependency."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, Any]] = []
        self._response = None
        self._error: Optional[Exception] = None

    def set_response(self, status_code: int, body: Any = None) -> None:
        self._response = _FakeResponse(status_code, body)
        self._error = None

    def set_error(self, err: Exception) -> None:
        self._error = err
        self._response = None

    async def request(
        self,
        method: str,
        url: str,
        *,
        json: Any = None,
        timeout: Any = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        self.requests.append((method, url, json))
        if self._error:
            raise self._error
        if self._response:
            return self._response
        raise ProviderError("connection")


class _FakeResponse:
    """Minimal fake HTTP response."""

    def __init__(self, status_code: int, body: Any = None) -> None:
        self.status_code = status_code
        self._body = body


class NullTransport(AsyncTransport):
    """A transport that raises ProviderError on any request."""

    async def request(
        self,
        method: str,
        url: str,
        *,
        json: Any = None,
        timeout: Any = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        raise ProviderError("connection")


class HttpxTransport(AsyncTransport):
    """Real httpx-based transport with configurable timeouts.

    httpx is imported lazily — this class can be imported without httpx
    being installed.
    """

    def __init__(
        self,
        connect_timeout: float = 10.0,
        read_timeout: float = 30.0,
        write_timeout: float = 30.0,
        pool_timeout: float = 10.0,
        pool_connections: int = 10,
        pool_maxsize: int = 10,
    ) -> None:
        httpx = _get_httpx()
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=connect_timeout,
                read=read_timeout,
                write=write_timeout,
                pool=pool_timeout,
            ),
            limits=httpx.Limits(
                max_connections=pool_connections,
                max_keepalive_connections=pool_maxsize,
            ),
        )

    async def request(
        self,
        method: str,
        url: str,
        *,
        json: Any = None,
        timeout: Any = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        try:
            return await self._client.request(
                method=method,
                url=url,
                json=json,
                timeout=timeout,
                headers=headers,
            )
        except _get_httpx().TimeoutException:
            raise ProviderError("timeout")
        except _get_httpx().ConnectError:
            raise ProviderError("connection")
        except _get_httpx().RemoteProtocolError:
            raise ProviderError("protocol")
        except _get_httpx().HTTPError:
            raise ProviderError("connection")

    async def close(self) -> None:
        await self._client.aclose()


# ── Transport factory (lazy construction) ──────────────────────────
# The global transport is created lazily at first use, not at import time.
# This means tests without httpx installed can use FakeTransport without
# triggering an httpx import.

_SCORING_TRANSPORT_INSTANCE: Optional[HttpxTransport] = None
_SCORING_TRANSPORT_CONFIG: dict[str, float] = {}


def configure_scoring_transport(
    connect_timeout: float = 10.0,
    read_timeout: float = 30.0,
    write_timeout: float = 30.0,
    pool_timeout: float = 10.0,
    pool_connections: int = 10,
    pool_maxsize: int = 10,
) -> None:
    """Configure the scoring transport parameters (does NOT construct httpx yet)."""
    global _SCORING_TRANSPORT_CONFIG
    _SCORING_TRANSPORT_CONFIG = {
        "connect_timeout": connect_timeout,
        "read_timeout": read_timeout,
        "write_timeout": write_timeout,
        "pool_timeout": pool_timeout,
        "pool_connections": pool_connections,
        "pool_maxsize": pool_maxsize,
    }
    # Reset any existing transport so next call rebuilds
    reset_scoring_transport()


def get_scoring_transport() -> HttpxTransport:
    """Get or create the scoring transport. Lazily constructs httpx on first call.

    Raises:
        RuntimeError: If httpx is not installed or construction fails.
    """
    global _SCORING_TRANSPORT_INSTANCE
    if _SCORING_TRANSPORT_INSTANCE is None:
        cfg = _SCORING_TRANSPORT_CONFIG
        _SCORING_TRANSPORT_INSTANCE = HttpxTransport(
            connect_timeout=cfg.get("connect_timeout", 10.0),
            read_timeout=cfg.get("read_timeout", 30.0),
            write_timeout=cfg.get("write_timeout", 30.0),
            pool_timeout=cfg.get("pool_timeout", 10.0),
            pool_connections=cfg.get("pool_connections", 10),
            pool_maxsize=cfg.get("pool_maxsize", 10),
        )
    return _SCORING_TRANSPORT_INSTANCE


async def async_close_scoring_transport() -> None:
    """Async close the scoring transport if it exists.

    Safe to call even if there is no running event loop (no-op).
    Always resets the global instance to None after closing.
    """
    global _SCORING_TRANSPORT_INSTANCE
    instance = _SCORING_TRANSPORT_INSTANCE
    if instance is not None:
        try:
            await instance.close()
        except Exception:
            pass
    _SCORING_TRANSPORT_INSTANCE = None


def reset_scoring_transport() -> None:
    """Synchronously discard the scoring transport without awaiting close.

    For test isolation between tests without an event loop.
    Use async_close_scoring_transport() for production shutdown.
    """
    global _SCORING_TRANSPORT_INSTANCE
    _SCORING_TRANSPORT_INSTANCE = None


# ── Circuit breaker ───────────────────────────────────────────────


@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    cooldown_sec: float = 30.0
    timeout_sec: float = 60.0
    clock: Clock = field(default_factory=RealClock)

    def __post_init__(self) -> None:
        """Validate configuration values."""
        _validate_breaker_config(self.failure_threshold, self.cooldown_sec, self.timeout_sec)


def _validate_breaker_config(threshold: int, cooldown: float, timeout: float) -> None:
    """Validate breaker parameters with strict checks. Rejects bool/NaN/Infinity."""
    if isinstance(threshold, bool) or not isinstance(threshold, int) or threshold < 1:
        raise TypeError("failure_threshold must be a positive integer")
    if isinstance(cooldown, bool) or not isinstance(cooldown, (int, float)) or math.isnan(cooldown) or math.isinf(cooldown) or cooldown <= 0:
        raise TypeError("cooldown_sec must be a finite positive number")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or math.isnan(timeout) or math.isinf(timeout) or timeout < 0:
        raise TypeError("timeout_sec must be a finite non-negative number")


class CircuitBreaker:
    """Async circuit breaker with closed/open/half-open states.

    BusinessError during HALF_OPEN resets to CLOSED (service is reachable).
    Open-state rejection throws ProviderError('circuit_open').
    """

    def __init__(self, config: Optional[CircuitBreakerConfig] = None) -> None:
        self._config = config or CircuitBreakerConfig()
        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._last_failure_time: float = 0.0
        self._probe_in_flight: bool = False
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        return self._state

    @property
    def failure_count(self) -> int:
        return self._failure_count

    async def call(self, fn: Callable[[], Any]) -> Any:
        """Call `fn` through the breaker.

        BusinessError passes through without affecting state.
        ProviderError increments the failure counter.
        BusinessError during HALF_OPEN resets to CLOSED (service reachable,
        just business logic error).
        """
        async with self._lock:
            now = self._config.clock.time()

            if self._state == CircuitState.OPEN:
                if now - self._last_failure_time < self._config.cooldown_sec:
                    raise ProviderError("circuit_open")
                self._state = CircuitState.HALF_OPEN
                self._probe_in_flight = False

            if self._state == CircuitState.HALF_OPEN:
                if self._probe_in_flight:
                    raise ProviderError("circuit_open")
                self._probe_in_flight = True

        try:
            result = await self._invoke_with_timeout(fn)
            async with self._lock:
                if self._state == CircuitState.HALF_OPEN:
                    self._reset()
                else:
                    self._failure_count = 0
            return result
        except ProviderError as err:
            async with self._lock:
                self._record_failure()
            raise
        except BusinessError:
            # BusinessError resets the streak — service is reachable
            async with self._lock:
                if self._state == CircuitState.HALF_OPEN:
                    self._reset()
                else:
                    self._failure_count = 0
            raise
        finally:
            async with self._lock:
                if self._state == CircuitState.HALF_OPEN:
                    self._probe_in_flight = False

    def reset(self) -> None:
        """Reset breaker to CLOSED state."""
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._probe_in_flight = False

    def force_open(self) -> None:
        """Force breaker into OPEN state."""
        self._state = CircuitState.OPEN
        self._last_failure_time = self._config.clock.time()
        self._probe_in_flight = False

    def _record_failure(self) -> None:
        """Increment failure count and potentially open the circuit."""
        # circuit_open errors should not count toward threshold
        self._failure_count += 1
        self._last_failure_time = self._config.clock.time()
        if self._failure_count >= self._config.failure_threshold:
            self._state = CircuitState.OPEN
            self._probe_in_flight = False

    def _reset(self) -> None:
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._probe_in_flight = False

    async def _invoke_with_timeout(self, fn: Callable[[], Any]) -> Any:
        """Invoke fn with optional timeout. Handles both sync and async fns."""
        result = fn()
        if asyncio.iscoroutine(result):
            if self._config.timeout_sec <= 0:
                return await result
            try:
                return await asyncio.wait_for(result, timeout=self._config.timeout_sec)
            except asyncio.TimeoutError:
                raise ProviderError("timeout")
        else:
            return result


# ── Redacted diagnostics ──────────────────────────────────────────


def redacted_log_message(category: str, endpoint_hint: str) -> str:
    """Return a non-disclosing log message using allowlisted codes only.

    endpoint_hint must be in _ALLOWED_HINTS; otherwise defaults to 'unknown'."""
    safe_hint = endpoint_hint if endpoint_hint in _ALLOWED_HINTS else "unknown"
    return f"[provider] {category} {safe_hint}"


# ── Safe HTTP call with breaker ────────────────────────────────────


async def call_with_breaker(
    method: str,
    url: str,
    *,
    breaker: CircuitBreaker,
    transport: AsyncTransport,
    json_body: Any = None,
    headers: Optional[dict[str, str]] = None,
    endpoint_hint: str = "",
    log_failures: bool = True,
) -> Any:
    """Make an HTTP call through a circuit breaker.

    Transport failures (timeout, connection, protocol) → ProviderError, counted.
    HTTP 408, 429, 3xx, 5xx → ProviderError, counted.
    HTTP 4xx (excluding 408/429) → BusinessError, not counted.
    Log messages use allowlisted endpoint_hint only.

    HTTP status classification happens INSIDE the breaker call so that
    5xx/429/408 responses correctly increment the failure counter.
    Returns the response object on success (2xx only).
    """
    try:
        response = await breaker.call(lambda: _call_and_classify(
            transport, method, url, json_body, headers,
        ))
        return response
    except ProviderError as exc:
        if log_failures:
            logger.warning(redacted_log_message(exc.category, endpoint_hint))
        raise
    except BusinessError:
        raise


async def _call_and_classify(
    transport: AsyncTransport,
    method: str,
    url: str,
    json_body: Any,
    headers: Optional[dict[str, str]],
) -> Any:
    """Transport request + status classification — runs INSIDE breaker.call()."""
    response = await transport.request(
        method=method,
        url=url,
        json=json_body,
        headers=headers,
    )
    cls = _classify_http_status(response.status_code)
    if cls is ProviderError:
        raise ProviderError("protocol")
    elif cls is BusinessError:
        raise BusinessError()
    return response
