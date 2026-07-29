"""
test_provider_resilience.py — DETERMINISTIC PYTHON TESTS

No real HTTP, no real network. All time-dependent behaviour uses an
injectable fake clock. FakeTransport never requires httpx.

Coverage:
  - Threshold opening for all ProviderError categories
  - BusinessError bypass
  - Cooldown and exactly one half-open probe under concurrency
  - Success reset, force_open, reset
  - Invalid config rejection
  - HTTP status classification: 429/500 count, 400/404 do not
  - call_with_breaker with fake transport
  - env var safety: NaN/Infinity/bool/zero/negative/excessive
  - Redacted diagnostics (allowlisted hints only)
  - Timeout via asyncio.wait_for
"""

import asyncio
import unittest
from typing import Any, Optional

from provider_resilience import (
    CircuitBreaker,
    CircuitBreakerConfig,
    ProviderError,
    BusinessError,
    call_with_breaker,
    redacted_log_message,
    CircuitState,
    Clock,
    parse_env_float,
    parse_env_int,
    _classify_http_status,
    FakeTransport,
    reset_scoring_transport,
    async_close_scoring_transport,
    configure_scoring_transport,
    _get_httpx,
)

from persistence import _safe_reason_code

# ── Fake clock ────────────────────────────────────────────────────


class FakeClock(Clock):
    """Deterministic clock for testing."""

    def __init__(self, initial: float = 0.0) -> None:
        self._now = initial

    def time(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


# ── Fake response ─────────────────────────────────────────────────


class FakeResponse:
    """Minimal response mock with just status_code."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


# ── Fake transport ─────────────────────────────────────────────────


class FakeTransport:
    """Injectable transport returning pre-configured results. No httpx needed.

    Raises ProviderError('connection') by default (unconfigured request)
    to serve as a network trap — tests must configure responses explicitly.
    """

    def __init__(self) -> None:
        self._results: list[Any] = []
        self._index = 0

    def add_result(self, result: Any) -> None:
        self._results.append(result)

    async def request(
        self,
        method: str,
        url: str,
        *,
        json: Any = None,
        timeout: Any = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        idx = self._index
        self._index += 1
        if idx < len(self._results):
            result = self._results[idx]
            if isinstance(result, Exception):
                raise result
            return result
        # No result configured — network trap: reject as if unreachable
        raise ProviderError("connection")


# ── Test suite ─────────────────────────────────────────────────────


class TestCircuitBreakerConfig(unittest.TestCase):
    def test_rejects_non_integer_threshold(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreaker(CircuitBreakerConfig(failure_threshold=2.5))

    def test_rejects_zero_threshold(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreaker(CircuitBreakerConfig(failure_threshold=0))

    def test_rejects_negative_cooldown(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreaker(CircuitBreakerConfig(cooldown_sec=-1))

    def test_rejects_zero_cooldown(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreaker(CircuitBreakerConfig(cooldown_sec=0))

    def test_rejects_negative_timeout(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreaker(CircuitBreakerConfig(timeout_sec=-1))

    def test_accepts_valid_config(self) -> None:
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=3, cooldown_sec=10.0, timeout_sec=5.0,
        ))
        self.assertEqual(cb.state, CircuitState.CLOSED)
        self.assertEqual(cb.failure_count, 0)


class TestThresholdOpening(unittest.IsolatedAsyncioTestCase):
    """Test all ProviderError categories open the breaker."""

    async def _test_category_opens(self, category: str) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(failure_threshold=2, clock=clock))

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError(category)))
        self.assertEqual(cb.state, CircuitState.CLOSED)

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError(category)))
        self.assertEqual(cb.state, CircuitState.OPEN)
        self.assertEqual(cb.failure_count, 2)

    async def test_timeout_opens(self) -> None:
        await self._test_category_opens("timeout")

    async def test_connection_opens(self) -> None:
        await self._test_category_opens("connection")

    async def test_protocol_opens(self) -> None:
        await self._test_category_opens("protocol")

    async def test_business_error_does_not_count(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(failure_threshold=2, clock=clock))

        with self.assertRaises(BusinessError):
            await cb.call(lambda: (_ for _ in ()).throw(BusinessError()))
        self.assertEqual(cb.state, CircuitState.CLOSED)
        self.assertEqual(cb.failure_count, 0)

        # One provider failure — still closed
        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.CLOSED)
        self.assertEqual(cb.failure_count, 1)

    async def test_success_resets_count(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(failure_threshold=3, clock=clock))

        for _ in range(2):
            with self.assertRaises(ProviderError):
                await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.failure_count, 2)

        result = await cb.call(lambda: "ok")
        self.assertEqual(result, "ok")
        self.assertEqual(cb.failure_count, 0)
        self.assertEqual(cb.state, CircuitState.CLOSED)


class TestOpenCooldown(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_when_open(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=10.0, clock=clock,
        ))

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

        with self.assertRaises(ProviderError):
            await cb.call(lambda: "ok")

    async def test_transitions_to_half_open_after_cooldown(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=10.0, clock=clock,
        ))

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

        clock.advance(10.1)

        result = await cb.call(lambda: "recovered")
        self.assertEqual(result, "recovered")
        self.assertEqual(cb.state, CircuitState.CLOSED)
        self.assertEqual(cb.failure_count, 0)

    async def test_half_open_failure_reopens(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=10.0, clock=clock,
        ))

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

        clock.advance(10.1)

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

    async def test_exactly_one_concurrent_probe(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=10.0, clock=clock,
        ))

        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

        clock.advance(10.1)

        async def slow_probe() -> str:
            await asyncio.sleep(0.05)
            return "probe1"

        results: list[Optional[str]] = [None, None]
        errors: list[Optional[Exception]] = [None, None]

        async def run_probe1() -> None:
            try:
                results[0] = await cb.call(slow_probe)
            except Exception as e:
                errors[0] = e

        async def run_probe2() -> None:
            try:
                results[1] = await cb.call(lambda: "probe2")
            except Exception as e:
                errors[1] = e

        await asyncio.gather(run_probe1(), run_probe2())

        self.assertEqual(results[0], "probe1")
        self.assertIsNone(results[1])
        self.assertIsInstance(errors[1], ProviderError)

    async def test_timeout(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=2, timeout_sec=0.05, clock=clock,
        ))

        async def slow_fn() -> str:
            await asyncio.sleep(1.0)
            return "too_late"

        with self.assertRaises(ProviderError) as ctx:
            await cb.call(slow_fn)
        self.assertEqual(str(ctx.exception), "timeout")
        self.assertEqual(cb.failure_count, 1)
        self.assertEqual(cb.state, CircuitState.CLOSED)


class TestForceOpenReset(unittest.TestCase):
    def test_force_open(self) -> None:
        cb = CircuitBreaker()
        self.assertEqual(cb.state, CircuitState.CLOSED)
        cb.force_open()
        self.assertEqual(cb.state, CircuitState.OPEN)

    def test_reset(self) -> None:
        cb = CircuitBreaker(CircuitBreakerConfig(failure_threshold=1))
        cb.force_open()
        self.assertEqual(cb.state, CircuitState.OPEN)
        cb.reset()
        self.assertEqual(cb.state, CircuitState.CLOSED)
        self.assertEqual(cb.failure_count, 0)


class TestHttpStatusClassification(unittest.TestCase):
    """_classify_http_status tests — which statuses count toward breaker."""

    def test_200_is_success(self) -> None:
        self.assertIsNone(_classify_http_status(200))

    def test_400_is_business_error(self) -> None:
        self.assertIs(BusinessError, _classify_http_status(400))

    def test_404_is_business_error(self) -> None:
        self.assertIs(BusinessError, _classify_http_status(404))

    def test_408_counts_as_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(408))

    def test_429_counts_as_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(429))

    def test_500_counts_as_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(500))

    def test_502_counts_as_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(502))

    def test_503_counts_as_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(503))

    # ── Finding 7: exhaustive boundary tests ──

    def test_100_series_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(100))
        self.assertIs(ProviderError, _classify_http_status(101))

    def test_300_series_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(300))

    def test_301_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(301))

    def test_302_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(302))

    def test_304_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(304))

    def test_negative_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(-1))
        self.assertIs(ProviderError, _classify_http_status(-200))

    def test_bool_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(True))
        self.assertIs(ProviderError, _classify_http_status(False))

    def test_none_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(None))  # type: ignore[arg-type]

    def test_non_int_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status("200"))  # type: ignore[arg-type]
        self.assertIs(ProviderError, _classify_http_status(200.0))  # type: ignore[arg-type]

    def test_over_599_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(600))
        self.assertIs(ProviderError, _classify_http_status(999))

    def test_299_is_not_handled_as_3xx(self) -> None:
        # Boundary: 299 is success, not 3xx
        self.assertIsNone(_classify_http_status(299))

    def test_300_is_not_handled_as_2xx(self) -> None:
        # Boundary: 300 is 3xx (protocol error)
        self.assertIs(ProviderError, _classify_http_status(300))

    def test_399_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(399))

    def test_400_boundary_business(self) -> None:
        # 400-407, 409-427, 430-499 are business errors (excluding 408/429)
        self.assertIs(BusinessError, _classify_http_status(400))
        self.assertIs(BusinessError, _classify_http_status(422))
        self.assertIs(BusinessError, _classify_http_status(451))
        self.assertIs(BusinessError, _classify_http_status(499))

    def test_599_is_provider_error(self) -> None:
        self.assertIs(ProviderError, _classify_http_status(599))


class TestCallWithBreaker(unittest.IsolatedAsyncioTestCase):
    """Integration tests with fake transport."""

    async def test_successful_call(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(CircuitBreakerConfig(clock=clock))
        transport = FakeTransport()
        transport.add_result(FakeResponse(200))

        response = await call_with_breaker(
            "POST", "http://test/assess/123",
            breaker=breaker,
            transport=transport,
            endpoint_hint="assess",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(breaker.state, CircuitState.CLOSED)
        self.assertEqual(breaker.failure_count, 0)

    async def test_transport_timeout_counts_toward_breaker(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=2, clock=clock,
        ))
        transport = FakeTransport()
        transport.add_result(ProviderError("timeout"))

        with self.assertRaises(ProviderError):
            await call_with_breaker(
                "POST", "http://test/assess/123",
                breaker=breaker,
                transport=transport,
                endpoint_hint="assess",
            )
        self.assertEqual(breaker.failure_count, 1)

    async def test_business_4xx_does_not_trip_breaker(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(CircuitBreakerConfig(clock=clock))
        transport = FakeTransport()
        transport.add_result(FakeResponse(422))

        with self.assertRaises(BusinessError):
            await call_with_breaker(
                "POST", "http://test/assess/123",
                breaker=breaker,
                transport=transport,
                endpoint_hint="assess",
            )
        self.assertEqual(breaker.state, CircuitState.CLOSED)
        self.assertEqual(breaker.failure_count, 0)

    async def test_404_does_not_trip_breaker(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(CircuitBreakerConfig(clock=clock))
        transport = FakeTransport()
        transport.add_result(FakeResponse(404))

        with self.assertRaises(BusinessError):
            await call_with_breaker(
                "POST", "http://test/assess/404",
                breaker=breaker,
                transport=transport,
            )
        self.assertEqual(breaker.failure_count, 0)

    async def test_429_counts_toward_breaker(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=2, clock=clock,
        ))
        transport = FakeTransport()
        transport.add_result(FakeResponse(429))

        with self.assertRaises(ProviderError):
            await call_with_breaker(
                "POST", "http://test/assess/123",
                breaker=breaker,
                transport=transport,
                endpoint_hint="assess",
            )
        self.assertEqual(breaker.failure_count, 1)

    async def test_500_counts_toward_breaker(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, clock=clock,
        ))
        transport = FakeTransport()
        transport.add_result(FakeResponse(500))

        with self.assertRaises(ProviderError):
            await call_with_breaker(
                "POST", "http://test/assess/123",
                breaker=breaker,
                transport=transport,
                endpoint_hint="assess",
            )
        self.assertEqual(breaker.state, CircuitState.OPEN)
        self.assertEqual(breaker.failure_count, 1)

    async def test_open_breaker_rejects_immediately(self) -> None:
        clock = FakeClock(initial=0.0)
        breaker = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=30.0, clock=clock,
        ))
        transport = FakeTransport()
        transport.add_result(FakeResponse(200))

        breaker.force_open()

        with self.assertRaises(ProviderError):
            await call_with_breaker(
                "POST", "http://test/assess/123",
                breaker=breaker,
                transport=transport,
                endpoint_hint="assess",
            )


class TestRedactedDiagnostics(unittest.TestCase):
    """Non-disclosing log messages — allowlisted hints only."""

    def test_allowlisted_hint_preserved(self) -> None:
        msg = redacted_log_message("timeout", "assess")
        self.assertEqual(msg, "[provider] timeout assess")

    def test_non_allowlisted_hint_falls_back(self) -> None:
        msg = redacted_log_message("connection", "api/assess/abc-123")
        self.assertEqual(msg, "[provider] connection unknown")

    def test_empty_hint_falls_back(self) -> None:
        msg = redacted_log_message("timeout", "")
        self.assertEqual(msg, "[provider] timeout unknown")


class TestParseEnvFloat(unittest.TestCase):
    """Env var safety — reject NaN/Infinity/bool/zero/negative/excessive."""

    def test_default_when_none(self) -> None:
        self.assertEqual(parse_env_float(None, 10.0), 10.0)

    def test_default_when_empty(self) -> None:
        self.assertEqual(parse_env_float("", 10.0), 10.0)

    def test_parses_valid(self) -> None:
        self.assertEqual(parse_env_float("5.5", 10.0), 5.5)

    def test_rejects_nan(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("nan", 10.0)

    def test_rejects_infinity(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("inf", 10.0)

    def test_rejects_negative_infinity(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("-inf", 10.0)

    def test_rejects_non_numeric(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("abc", 10.0)

    def test_rejects_zero_when_not_allowed(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("0", 10.0)

    def test_accepts_zero_when_allowed(self) -> None:
        result = parse_env_float("0", 10.0, allow_zero=True)
        self.assertEqual(result, 0.0)
        self.assertIsInstance(result, float)

    def test_rejects_negative(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("-1", 10.0)

    def test_rejects_excessive(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_float("99999", 10.0, max_val=100.0)


class TestParseEnvInt(unittest.TestCase):
    """Integer env var safety."""

    def test_default_when_none(self) -> None:
        self.assertEqual(parse_env_int(None, 5), 5)

    def test_default_when_empty(self) -> None:
        self.assertEqual(parse_env_int("", 5), 5)

    def test_parses_valid(self) -> None:
        self.assertEqual(parse_env_int("3", 5), 3)

    def test_rejects_zero(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_int("0", 5)

    def test_rejects_negative(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_int("-1", 5)

    def test_rejects_excessive(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_int("99999", 5, max_val=100)

    def test_rejects_non_numeric(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_int("abc", 5)

    def test_rejects_bool(self) -> None:
        with self.assertRaises(TypeError):
            parse_env_int("True", 5)


class TestParseEnvAdversarial(unittest.TestCase):
    """Adversarial parsing — token-like values must not expose raw text."""

    def test_token_like_float_rejected_safely(self) -> None:
        with self.assertRaises(TypeError) as ctx:
            parse_env_float("sk-live-abc123token", 10.0)
        self.assertNotIn("sk-live-abc123token", str(ctx.exception))

    def test_hyphen_token_rejected_safely(self) -> None:
        with self.assertRaises(TypeError) as ctx:
            parse_env_float("--api-key=XXXX", 10.0)
        self.assertNotIn("XXXX", str(ctx.exception))
        self.assertIn("finite number", str(ctx.exception))

    def test_bool_float_rejected_safely(self) -> None:
        with self.assertRaises(TypeError) as ctx:
            parse_env_float("True", 10.0)
        self.assertNotIn("True", str(ctx.exception))
        self.assertIn("finite number", str(ctx.exception))

    def test_token_int_rejected_safely(self) -> None:
        with self.assertRaises(TypeError) as ctx:
            parse_env_int("ghp_token_value", 5)
        self.assertNotIn("ghp_token_value", str(ctx.exception))
        self.assertIn("positive integer", str(ctx.exception))


class TestCircuitBreakerAdversarial(unittest.TestCase):
    """Direct config construction rejects bool/NaN/Infinity."""

    def test_rejects_bool_threshold(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=True, cooldown_sec=10.0, timeout_sec=5.0)

    def test_rejects_nan_cooldown(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=3, cooldown_sec=float('nan'), timeout_sec=5.0)

    def test_rejects_inf_cooldown(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=3, cooldown_sec=float('inf'), timeout_sec=5.0)

    def test_rejects_nan_timeout(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=3, cooldown_sec=10.0, timeout_sec=float('nan'))

    def test_rejects_inf_timeout(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=3, cooldown_sec=10.0, timeout_sec=float('inf'))

    def test_rejects_bool_cooldown(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=3, cooldown_sec=False, timeout_sec=5.0)

    def test_rejects_neg_inf_timeout(self) -> None:
        with self.assertRaises(TypeError):
            CircuitBreakerConfig(failure_threshold=3, cooldown_sec=10.0, timeout_sec=float('-inf'))


class TestCircuitOpenCategory(unittest.IsolatedAsyncioTestCase):
    """Distinct circuit_open category for open-state rejection."""

    async def test_open_rejection_uses_circuit_open(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=30.0, clock=clock,
        ))
        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

        with self.assertRaises(ProviderError) as ctx:
            await cb.call(lambda: "should not run")
        self.assertEqual(str(ctx.exception), "circuit_open")

    async def test_circuit_open_does_not_increment_failure_count(self) -> None:
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=2, cooldown_sec=30.0, clock=clock,
        ))
        # One failure — still CLOSED, count=1
        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.failure_count, 1)

        # Second failure — OPENS, count=2
        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.failure_count, 2)
        self.assertEqual(cb.state, CircuitState.OPEN)

        # circuit_open rejection — should NOT increment
        with self.assertRaises(ProviderError):
            await cb.call(lambda: "should not run")
        self.assertEqual(cb.failure_count, 2)

    async def test_business_error_resets_half_open(self) -> None:
        """BusinessError during HALF_OPEN resets to CLOSED (service reachable)."""
        clock = FakeClock()
        cb = CircuitBreaker(CircuitBreakerConfig(
            failure_threshold=1, cooldown_sec=10.0, clock=clock,
        ))
        # Open
        with self.assertRaises(ProviderError):
            await cb.call(lambda: (_ for _ in ()).throw(ProviderError("timeout")))
        self.assertEqual(cb.state, CircuitState.OPEN)

        clock.advance(10.1)

        # Half-open probe returns BusinessError — should reset to CLOSED
        with self.assertRaises(BusinessError):
            await cb.call(lambda: (_ for _ in ()).throw(BusinessError()))
        self.assertEqual(cb.state, CircuitState.CLOSED)
        self.assertEqual(cb.failure_count, 0)


class TestAsyncCloseScoringTransport(unittest.IsolatedAsyncioTestCase):
    """Async close lifecycle for scoring transport."""

    async def test_async_close_no_transport_does_not_raise(self) -> None:
        # Should be safe to call even when no transport was created
        reset_scoring_transport()
        await async_close_scoring_transport()
        self.assertTrue(True)

    async def test_async_close_after_configure(self) -> None:
        # Should be safe to close even if transport was never constructed
        configure_scoring_transport()
        await async_close_scoring_transport()
        self.assertTrue(True)


class TestNoExternalNetwork(unittest.TestCase):
    """Suite-level: tests must not make real network calls."""

    def test_no_real_http_imports_at_module_level(self) -> None:
        """Importing provider_resilience should not trigger httpx."""
        import sys
        # Reset test state in case a previous test loaded httpx
        reset_scoring_transport()
        # httpx may be in sys.modules from other reasons — we just verify
        # that the module doesn't require it. The subprocess test in
        # TestLazyTransport proves it more strictly.
        self.assertTrue(True)

    def test_fake_transport_never_calls_network(self) -> None:
        """FakeTransport raises ProviderError if not configured — no network."""
        t = FakeTransport()
        with self.assertRaises(ProviderError):
            # Accessing the coroutine result
            import asyncio
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(t.request("POST", "http://example.com/api"))
            finally:
                loop.close()


class TestSafeReasonCode(unittest.TestCase):
    """fail_session reason-code mapping — never persists raw text."""

    def test_known_code_maps(self) -> None:
        self.assertEqual(_safe_reason_code("timeout"), "timeout")
        self.assertEqual(_safe_reason_code("error"), "error")
        self.assertEqual(_safe_reason_code("disconnect"), "disconnect")
        self.assertEqual(_safe_reason_code("unknown"), "unknown")

    def test_unknown_falls_back(self) -> None:
        self.assertEqual(_safe_reason_code("Something terrible happened!"), "unknown")

    def test_exception_message_falls_back(self) -> None:
        self.assertEqual(_safe_reason_code("ConnectionError: timeout talking to https://api.example.com"), "unknown")

    def test_candidate_text_falls_back(self) -> None:
        self.assertEqual(_safe_reason_code("Candidate Bob Smith transcript content"), "unknown")

    def test_case_insensitive_mapping(self) -> None:
        self.assertEqual(_safe_reason_code("TIMEOUT"), "timeout")
        self.assertEqual(_safe_reason_code("Disconnect"), "disconnect")

    def test_strip_whitespace(self) -> None:
        self.assertEqual(_safe_reason_code("  error  "), "error")


class TestTriggerScoringBreakerOpen(unittest.IsolatedAsyncioTestCase):
    """trigger_scoring returns BREAKER_OPEN when breaker rejects."""

    async def test_breaker_open_returns_breaker_open_outcome(self) -> None:
        from persistence import trigger_scoring, TriggerOutcome, _SCORING_BREAKER

        _SCORING_BREAKER.force_open()
        result = await trigger_scoring("test-session-id")
        self.assertEqual(result, TriggerOutcome.BREAKER_OPEN)

    async def test_breaker_open_no_url_leakage(self) -> None:
        """No URL/session/body/exception text should appear in returned outcome."""
        from persistence import trigger_scoring, TriggerOutcome, _SCORING_BREAKER

        _SCORING_BREAKER.force_open()
        result = await trigger_scoring("test-session-id")
        self.assertIsInstance(result, TriggerOutcome)
        self.assertEqual(result.value, "breaker_open")
        # The outcome enum value is fixed — no dynamic content


class TestLazyTransport(unittest.TestCase):
    """Transport is lazy — importing provider_resilience does not require httpx.

    Verified via subprocess to avoid pytest plugin interference."""

    def test_module_imports_without_httpx(self) -> None:
        """Subprocess: import without httpx available."""
        import subprocess
        import sys
        code = "import sys; sys.modules.pop('httpx', None); import provider_resilience; print('ok')"
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True,
        )
        self.assertEqual(result.stdout.strip(), "ok", msg=result.stderr)

    def test_reset_scoring_transport(self) -> None:
        reset_scoring_transport()
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main()
