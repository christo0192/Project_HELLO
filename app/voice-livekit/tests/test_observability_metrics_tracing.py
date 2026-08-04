"""OBS-06: Python metrics & tracing instrumentation tests.

Covers:
  - counter_metric / gauge_metric / histogram_metric recording with TestMetricSink.
  - PII redaction in metric label values (synthetic PII patterns dropped).
  - Invalid metric names/values rejected (non-finite, non-safe-idents).
  - Span creation, attributes with PII redaction, error status.
  - with_span / with_span_async automatic lifecycle.
  - set_metric_sink / set_tracer configuration and reset.
"""

from __future__ import annotations

import json
import math
import os
import socket
import sys
import types
import unittest
from typing import Any, Optional
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Path bootstrap & stubs
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(__file__)
_LIVEKIT_DIR = os.path.abspath(os.path.join(_HERE, ".."))
if _LIVEKIT_DIR not in sys.path:
    sys.path.insert(0, _LIVEKIT_DIR)

_STUBBED_MODULES: list[str] = []
for _mod_name in (
    "livekit", "livekit.agents", "livekit.plugins",
    "livekit.plugins.openai", "livekit.plugins.sarvam", "livekit.plugins.silero",
    "livekit.plugins.turn_detector", "livekit.plugins.turn_detector.multilingual",
    "dotenv",
):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)
        _STUBBED_MODULES.append(_mod_name)

if "httpx" not in sys.modules:
    _fake_httpx = types.ModuleType("httpx")
    _fake_httpx.__is_stub = True  # type: ignore[attr-defined]
    sys.modules["httpx"] = _fake_httpx
    _STUBBED_MODULES.append("httpx")

import observability  # noqa: E402
from observability import (  # noqa: E402
    TestMetricSink,
    TestTracer,
    counter_metric,
    gauge_metric,
    histogram_metric,
    set_metric_sink,
    start_span,
    set_tracer,
    with_span,
    with_span_async,
    _validate_metric_name,
    _filter_metric_labels,
)

# ── Helpers ───────────────────────────────────────────────────────────────

PII_SEEDS: list[tuple[str, str]] = [
    ("bearer+JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.payload"),
    ("email", "attacker@evil.com"),
    ("10plusDigits", "14155551234"),
    ("OpenAI_key", "sk-" + "abcdefghijklmnopqrstuvwxyz123456"),
    ("GitHub_token", "ghp_" + "abcdefghijklmnopqrstuv"),
    ("Slack_token", "xox" + "b-" + "123456789012-abcdefghijklmn"),
    ("AWS_key", "AKIA" + "1234567890ABCDEF"),
    ("PEM_header", "-----BEGIN RSA PRIVATE KEY-----"),
    ("high_entropy_30", "aB3dE5gH7jK9lMnOpQrStUvWxYz0123456"),
    ("path_leak", "/etc/passwd"),
]


def tearDownModule() -> None:
    for _mod_name in _STUBBED_MODULES:
        if _mod_name in sys.modules and getattr(sys.modules[_mod_name], "__is_stub", False):
            del sys.modules[_mod_name]


# =============================================================================
#  METRICS TESTS
# =============================================================================


class TestMetricsCounter(unittest.TestCase):
    def setUp(self) -> None:
        self.sink = TestMetricSink()
        set_metric_sink(self.sink)

    def tearDown(self) -> None:
        set_metric_sink(None)

    def test_counter_records_increment(self) -> None:
        counter_metric("http_requests_total", 1, {"method": "GET", "status": "200"})
        self.assertEqual(len(self.sink.counters), 1)
        self.assertEqual(self.sink.counters[0]["name"], "http_requests_total")
        self.assertEqual(self.sink.counters[0]["value"], 1.0)
        self.assertEqual(self.sink.counters[0]["labels"]["method"], "GET")

    def test_counter_defaults_value_to_1(self) -> None:
        counter_metric("http_requests_total")
        self.assertEqual(self.sink.counters[0]["value"], 1.0)

    def test_counter_rejects_negative(self) -> None:
        counter_metric("test", -1)
        self.assertEqual(len(self.sink.counters), 0)

    def test_counter_rejects_nan(self) -> None:
        counter_metric("test", float("nan"))
        self.assertEqual(len(self.sink.counters), 0)

    def test_counter_rejects_infinity(self) -> None:
        counter_metric("test", float("inf"))
        self.assertEqual(len(self.sink.counters), 0)

    def test_counter_rejects_invalid_name_long(self) -> None:
        counter_metric("x" * 100)
        self.assertEqual(len(self.sink.counters), 0)

    def test_counter_rejects_name_with_spaces(self) -> None:
        counter_metric("bad name with spaces")
        self.assertEqual(len(self.sink.counters), 0)

    def test_counter_accepts_colon_name(self) -> None:
        counter_metric("job_queue:jobs.pending", 1)
        self.assertEqual(len(self.sink.counters), 1)
        self.assertEqual(self.sink.counters[0]["name"], "job_queue:jobs.pending")

    def test_counter_drops_pii_label(self) -> None:
        counter_metric("test", 1, {"user_email": "victim@example.com", "method": "GET"})
        self.assertEqual(len(self.sink.counters), 1)
        self.assertNotIn("user_email", self.sink.counters[0]["labels"])
        self.assertEqual(self.sink.counters[0]["labels"]["method"], "GET")


class TestMetricsGauge(unittest.TestCase):
    def setUp(self) -> None:
        self.sink = TestMetricSink()
        set_metric_sink(self.sink)

    def tearDown(self) -> None:
        set_metric_sink(None)

    def test_gauge_records_value(self) -> None:
        gauge_metric("queue_depth", 42, {"queue": "transcript"})
        self.assertEqual(len(self.sink.gauges), 1)
        self.assertEqual(self.sink.gauges[0]["name"], "queue_depth")
        self.assertEqual(self.sink.gauges[0]["value"], 42.0)

    def test_gauge_rejects_nan(self) -> None:
        gauge_metric("test", float("nan"))
        self.assertEqual(len(self.sink.gauges), 0)

    def test_gauge_allows_zero(self) -> None:
        gauge_metric("test", 0)
        self.assertEqual(len(self.sink.gauges), 1)
        self.assertEqual(self.sink.gauges[0]["value"], 0.0)


class TestMetricsHistogram(unittest.TestCase):
    def setUp(self) -> None:
        self.sink = TestMetricSink()
        set_metric_sink(self.sink)

    def tearDown(self) -> None:
        set_metric_sink(None)

    def test_histogram_records_observation(self) -> None:
        histogram_metric("latency_ms", 250, {"method": "POST"})
        self.assertEqual(len(self.sink.histograms), 1)
        self.assertEqual(self.sink.histograms[0]["name"], "latency_ms")
        self.assertEqual(self.sink.histograms[0]["value"], 250.0)

    def test_histogram_rejects_negative(self) -> None:
        histogram_metric("test", -1)
        self.assertEqual(len(self.sink.histograms), 0)

    def test_histogram_rejects_nan(self) -> None:
        histogram_metric("test", float("nan"))
        self.assertEqual(len(self.sink.histograms), 0)


class TestMetricsPIISweep(unittest.TestCase):
    """Every PII seed in every metric type."""

    def setUp(self) -> None:
        self.sink = TestMetricSink()
        set_metric_sink(self.sink)

    def tearDown(self) -> None:
        set_metric_sink(None)

    def test_pii_redacted_in_counter_labels(self) -> None:
        for label, value in PII_SEEDS:
            with self.subTest(seed=label):
                self.sink.reset()
                counter_metric("test", 1, {"value": value})
                self.assertEqual(len(self.sink.counters), 1)
                if self.sink.counters[0]["labels"]:
                    self.assertNotIn("value", self.sink.counters[0]["labels"])

    def test_pii_redacted_in_gauge_labels(self) -> None:
        for label, value in PII_SEEDS:
            with self.subTest(seed=label):
                self.sink.reset()
                gauge_metric("test", 10, {"value": value})
                self.assertEqual(len(self.sink.gauges), 1)
                if self.sink.gauges[0]["labels"]:
                    self.assertNotIn("value", self.sink.gauges[0]["labels"])

    def test_pii_redacted_in_histogram_labels(self) -> None:
        for label, value in PII_SEEDS:
            with self.subTest(seed=label):
                self.sink.reset()
                histogram_metric("test", 1, {"value": value})
                self.assertEqual(len(self.sink.histograms), 1)
                if self.sink.histograms[0]["labels"]:
                    self.assertNotIn("value", self.sink.histograms[0]["labels"])


class TestMetricsSinkManagement(unittest.TestCase):
    def test_default_sink_is_noop(self) -> None:
        set_metric_sink(None)
        # Should not raise
        counter_metric("test", 1)
        gauge_metric("test", 1)
        histogram_metric("test", 1)

    def test_set_metric_sink_swaps(self) -> None:
        sink1 = TestMetricSink()
        sink2 = TestMetricSink()
        set_metric_sink(sink1)
        counter_metric("test", 1)
        self.assertEqual(len(sink1.counters), 1)
        self.assertEqual(len(sink2.counters), 0)
        set_metric_sink(sink2)
        counter_metric("test", 2)
        self.assertEqual(len(sink1.counters), 1)
        self.assertEqual(len(sink2.counters), 1)


# =============================================================================
#  TRACING TESTS
# =============================================================================


class TestTracingSpans(unittest.TestCase):
    def setUp(self) -> None:
        self.tracer = TestTracer()
        set_tracer(self.tracer)

    def tearDown(self) -> None:
        set_tracer(None)

    def test_start_span_creates_span_with_ids(self) -> None:
        span = start_span("http_request")
        self.assertIsNotNone(span.span_id)
        self.assertIsNotNone(span.trace_id)
        self.assertEqual(len(self.tracer.spans), 1)

    def test_child_span_links_to_parent(self) -> None:
        parent = start_span("parent")
        child = start_span("child", parent)
        self.assertEqual(len(self.tracer.spans), 2)
        self.assertEqual(child.parent_span_id, parent.span_id)

    def test_rejects_long_span_names(self) -> None:
        span = start_span("x" * 200)
        self.assertEqual(span.name, "unnamed")

    def test_rejects_empty_span_names(self) -> None:
        span = start_span("")
        self.assertEqual(span.name, "unnamed")

    def test_set_attributes(self) -> None:
        span = start_span("test")
        span.set_attributes({"method": "GET", "status": 200})
        self.assertEqual(span.attributes["method"], "GET")
        self.assertEqual(span.attributes["status"], 200)

    def test_redacts_pii_in_attributes(self) -> None:
        span = start_span("test")
        span.set_attributes({"email": "victim@example.com", "safe": "hello"})
        self.assertEqual(span.attributes["email"], "[REDACTED]")
        self.assertEqual(span.attributes["safe"], "hello")

    def test_all_pii_seeds_redacted_in_attributes(self) -> None:
        for label, value in PII_SEEDS:
            with self.subTest(seed=label):
                span = start_span("test")
                span.set_attributes({"value": value})
                self.assertEqual(span.attributes["value"], "[REDACTED]")

    def test_drops_nan_attribute(self) -> None:
        span = start_span("test")
        span.set_attributes({"bad": float("nan"), "good": 42})
        self.assertNotIn("bad", span.attributes)
        self.assertEqual(span.attributes["good"], 42)

    def test_drops_none_attribute(self) -> None:
        span = start_span("test")
        span.set_attributes({"a": None, "b": "ok"})
        self.assertNotIn("a", span.attributes)
        self.assertEqual(span.attributes["b"], "ok")

    def test_add_event(self) -> None:
        span = start_span("test")
        span.add_event("cache_miss", {"key": "user_123"})
        self.assertEqual(len(span.events), 1)
        self.assertEqual(span.events[0]["name"], "cache_miss")

    def test_redacts_pii_in_event_attrs(self) -> None:
        span = start_span("test")
        span.add_event("error", {"token": "sk-abcdefghijklmnopqrstuvwxyz123456"})
        self.assertEqual(span.events[0]["attrs"]["token"], "[REDACTED]")

    def test_set_error(self) -> None:
        span = start_span("test")
        err = ValueError("something went wrong")
        span.set_error(err)
        self.assertIs(span.error, err)

    def test_end(self) -> None:
        span = start_span("test")
        self.assertFalse(span.is_ended)
        span.end()
        self.assertTrue(span.is_ended)

    def test_with_span_sync(self) -> None:
        result = with_span("operation", lambda span: 42)
        self.assertEqual(result, 42)
        span = self.tracer.spans[0]
        self.assertTrue(span.is_ended)

    def test_with_span_records_error_and_rethrows(self) -> None:
        def fail(_span):
            raise ValueError("boom")

        with self.assertRaises(ValueError):
            with_span("failing", fail)
        span = self.tracer.spans[0]
        self.assertTrue(span.is_ended)
        self.assertIsInstance(span.error, ValueError)

    def test_default_tracer_noop(self) -> None:
        set_tracer(None)
        span = start_span("test")
        span.end()
        span.set_attributes({"a": "b"})
        span.add_event("e")
        span.set_error(ValueError())


class TestTracingAsync(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tracer = TestTracer()
        set_tracer(self.tracer)

    def tearDown(self) -> None:
        set_tracer(None)

    async def test_with_span_async(self) -> None:
        async def op(span):
            span.set_attributes({"async": True})
            return "done"

        result = await with_span_async("async_op", op)
        self.assertEqual(result, "done")
        span = self.tracer.spans[0]
        self.assertTrue(span.is_ended)
        self.assertTrue(span.attributes["async"])

    async def test_with_span_async_error(self) -> None:
        async def fail(_span):
            raise ValueError("async_boom")

        with self.assertRaises(ValueError):
            await with_span_async("failing_async", fail)
        span = self.tracer.spans[0]
        self.assertTrue(span.is_ended)
        self.assertIsInstance(span.error, ValueError)


if __name__ == "__main__":
    unittest.main()
