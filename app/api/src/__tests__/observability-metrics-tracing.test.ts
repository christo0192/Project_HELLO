/**
 * OBS-03 / OBS-04 / OBS-05: Metrics & tracing instrumentation tests.
 *
 * Covers:
 *  - Metrics counter/gauge/histogram recording with TestMetricSink.
 *  - PII redaction in metric label values (synthetic PII patterns dropped).
 *  - Invalid metric names/values rejected (NaN, non-finite, non-safe-idents).
 *  - Span creation, attributes with PII redaction, error status.
 *  - withSpan / withSpanAsync automatic lifecycle.
 *  - setMetricSink / setTracer configuration and reset.
 *  - Synthetic PII patterns: bearer/JWT/email/phone/API keys/paths/etc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  counter, gauge, histogram,
  setMetricSink, getMetricSink, TestMetricSink,
} from '../lib/metrics.js';
import {
  startSpan, withSpan, withSpanAsync,
  setTracer, getTracer, TestTracer, TestSpan,
} from '../lib/tracing.js';

// ===================================================================
//  HELPERS
// ===================================================================

const PII_SEEDS = [
  { label: 'bearer+JWT',       value: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload' },
  { label: 'email',            value: 'attacker@evil.com' },
  { label: '10plusDigits',     value: '14155551234' },
  { label: 'OpenAI_key',       value: 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456' },
  { label: 'GitHub_token',     value: 'ghp_' + 'abcdefghijklmnopqrstuv' },
  { label: 'Slack_token',      value: 'xox' + 'b-' + '123456789012-abcdefghijklmn' },
  { label: 'AWS_key',          value: 'AKIA' + '1234567890ABCDEF' },
  { label: 'PEM_header',       value: '-----BEGIN RSA PRIVATE KEY-----' },
  { label: 'high_entropy_30',  value: 'aB3dE5gH7jK9lMnOpQrStUvWxYz0123456' },
  { label: 'path_leak',        value: '/etc/passwd' },
];

// ===================================================================
//  METRICS — OBS-03
// ===================================================================

describe('OBS-03 Metrics — counter/gauge/histogram', () => {
  let sink: TestMetricSink;

  beforeEach(() => {
    sink = new TestMetricSink();
    setMetricSink(sink);
  });

  afterEach(() => {
    setMetricSink(null);
  });

  describe('counter', () => {
    it('records a counter increment', () => {
      counter('http_requests_total', 1, { method: 'GET', status: '200' });
      expect(sink.counters).toHaveLength(1);
      expect(sink.counters[0].name).toBe('http_requests_total');
      expect(sink.counters[0].value).toBe(1);
      expect(sink.counters[0].labels).toEqual({ method: 'GET', status: '200' });
    });

    it('defaults value to 1', () => {
      counter('http_requests_total');
      expect(sink.counters[0].value).toBe(1);
    });

    it('rejects negative counter values', () => {
      counter('http_requests_total', -1);
      expect(sink.counters).toHaveLength(0);
    });

    it('rejects NaN counter values', () => {
      counter('http_requests_total', NaN);
      expect(sink.counters).toHaveLength(0);
    });

    it('rejects Infinity counter values', () => {
      counter('http_requests_total', Infinity);
      expect(sink.counters).toHaveLength(0);
    });

    it('rejects invalid metric names (long)', () => {
      counter('x'.repeat(100));
      expect(sink.counters).toHaveLength(0);
    });

    it('rejects metric names with spaces', () => {
      counter('bad name with spaces');
      expect(sink.counters).toHaveLength(0);
    });

    it('accepts valid metric names with colons and dots', () => {
      counter('job_queue:jobs.pending', 1);
      expect(sink.counters).toHaveLength(1);
      expect(sink.counters[0].name).toBe('job_queue:jobs.pending');
    });

    it('drops labels with PII values', () => {
      counter('http_requests_total', 1, { user_email: 'victim@example.com', method: 'GET' });
      expect(sink.counters).toHaveLength(1);
      // The PII label should be dropped; non-PII label should survive
      expect(sink.counters[0].labels).toEqual({ method: 'GET' });
    });

    it('drops labels with PII keys', () => {
      counter('http_requests_total', 1, { 'victim@example.com': 'some_value' });
      expect(sink.counters).toHaveLength(1);
      expect(sink.counters[0].labels).toBeUndefined();
    });

    it('drops non-finite numeric label values', () => {
      counter('http_requests_total', 1, { status: NaN as unknown as number });
      expect(sink.counters).toHaveLength(1);
      expect(sink.counters[0].labels).toBeUndefined();
    });
  });

  describe('gauge', () => {
    it('records a gauge value', () => {
      gauge('queue_depth', 42, { queue: 'transcript' });
      expect(sink.gauges).toHaveLength(1);
      expect(sink.gauges[0].name).toBe('queue_depth');
      expect(sink.gauges[0].value).toBe(42);
      expect(sink.gauges[0].labels).toEqual({ queue: 'transcript' });
    });

    it('rejects NaN gauge values', () => {
      gauge('queue_depth', NaN);
      expect(sink.gauges).toHaveLength(0);
    });

    it('rejects non-finite gauge values', () => {
      gauge('queue_depth', Infinity);
      expect(sink.gauges).toHaveLength(0);
    });

    it('allows zero gauge values', () => {
      gauge('queue_depth', 0);
      expect(sink.gauges).toHaveLength(1);
      expect(sink.gauges[0].value).toBe(0);
    });

    it('redacts PII in gauge labels', () => {
      gauge('connected_workers', 5, { token: 'sk-abcdefghijklmnopqrstuvwxyz123456' });
      expect(sink.gauges).toHaveLength(1);
      expect(sink.gauges[0].labels).toBeUndefined();
    });
  });

  describe('histogram', () => {
    it('records a histogram observation', () => {
      histogram('http_request_duration_ms', 250, { method: 'POST' });
      expect(sink.histograms).toHaveLength(1);
      expect(sink.histograms[0].name).toBe('http_request_duration_ms');
      expect(sink.histograms[0].value).toBe(250);
      expect(sink.histograms[0].labels).toEqual({ method: 'POST' });
    });

    it('rejects negative histogram values', () => {
      histogram('http_request_duration_ms', -1);
      expect(sink.histograms).toHaveLength(0);
    });

    it('rejects NaN histogram values', () => {
      histogram('http_request_duration_ms', NaN);
      expect(sink.histograms).toHaveLength(0);
    });

    it('allows zero histogram values', () => {
      histogram('http_request_duration_ms', 0);
      expect(sink.histograms).toHaveLength(1);
      expect(sink.histograms[0].value).toBe(0);
    });
  });

  describe('sink management', () => {
    it('default sink is no-op (no errors)', () => {
      setMetricSink(null);
      expect(() => counter('test', 1)).not.toThrow();
      expect(() => gauge('test', 1)).not.toThrow();
      expect(() => histogram('test', 1)).not.toThrow();
    });

    it('setMetricSink swaps the active sink', () => {
      const sink2 = new TestMetricSink();
      setMetricSink(sink2);
      counter('test', 1);
      expect(sink2.counters).toHaveLength(1);
      // Original sink should be unchanged
      expect(sink.counters).toHaveLength(0);
    });
  });

  describe('PII redaction in all label values', () => {
    for (const seed of PII_SEEDS) {
      it(`redacts "${seed.label}" in counter labels`, () => {
        counter('test_metric', 1, { value: seed.value });
        expect(sink.counters).toHaveLength(1);
        expect(sink.counters[0].labels).toBeUndefined();
      });

      it(`redacts "${seed.label}" in gauge labels`, () => {
        gauge('test_gauge', 10, { value: seed.value });
        expect(sink.gauges).toHaveLength(1);
        expect(sink.gauges[0].labels).toBeUndefined();
      });

      it(`redacts "${seed.label}" in histogram labels`, () => {
        histogram('test_histogram', 1, { value: seed.value });
        expect(sink.histograms).toHaveLength(1);
        expect(sink.histograms[0].labels).toBeUndefined();
      });
    }
  });
});

// ===================================================================
//  TRACING — OBS-04
// ===================================================================

describe('OBS-04 Tracing — spans, attributes, and lifecycle', () => {
  let tracer: TestTracer;

  beforeEach(() => {
    tracer = new TestTracer();
    setTracer(tracer);
  });

  afterEach(() => {
    setTracer(null);
  });

  describe('startSpan', () => {
    it('creates a span with a name and IDs', () => {
      const span = startSpan('http_request');
      expect(span.spanId).toBeTruthy();
      expect(span.traceId).toBeTruthy();
      expect(tracer.spans).toHaveLength(1);
    });

    it('creates child spans with parent relationship', () => {
      const parent = startSpan('parent');
      const child = startSpan('child', parent);
      expect(tracer.spans).toHaveLength(2);
      const testChild = child as TestSpan;
      const testParent = parent as TestSpan;
      expect(testChild.parentSpanId).toBe(testParent.spanId);
    });

    it('rejects overly long span names', () => {
      const span = startSpan('x'.repeat(200));
      // Should return a no-op span, not added to tracer
      expect(tracer.spans).toHaveLength(0);
    });
  });

  describe('setAttributes', () => {
    it('sets attributes on a span', () => {
      const span = startSpan('test');
      span.setAttributes({ method: 'GET', status: 200 });
      const testSpan = span as TestSpan;
      expect(testSpan.attributes.method).toBe('GET');
      expect(testSpan.attributes.status).toBe(200);
    });

    it('redacts PII in attribute values', () => {
      const span = startSpan('test');
      span.setAttributes({ user_email: 'victim@example.com', safe: 'hello' });
      const testSpan = span as TestSpan;
      expect(testSpan.attributes.user_email).toBe('[REDACTED]');
      expect(testSpan.attributes.safe).toBe('hello');
    });

    for (const seed of PII_SEEDS) {
      it(`redacts "${seed.label}" in span attributes`, () => {
        const span = startSpan('test');
        span.setAttributes({ value: seed.value });
        const testSpan = span as TestSpan;
        expect(testSpan.attributes.value).toBe('[REDACTED]');
      });
    }

    it('drops NaN and Infinity attribute values', () => {
      const span = startSpan('test');
      span.setAttributes({ bad: NaN as unknown as number, good: 42 });
      const testSpan = span as TestSpan;
      expect(testSpan.attributes).not.toHaveProperty('bad');
      expect(testSpan.attributes.good).toBe(42);
    });

    it('drops null and undefined attribute values', () => {
      const span = startSpan('test');
      span.setAttributes({ a: null as unknown as string, b: undefined as unknown as string, c: 'ok' });
      const testSpan = span as TestSpan;
      expect(testSpan.attributes).not.toHaveProperty('a');
      expect(testSpan.attributes).not.toHaveProperty('b');
      expect(testSpan.attributes.c).toBe('ok');
    });
  });

  describe('addEvent', () => {
    it('adds an event to the span', () => {
      const span = startSpan('test');
      span.addEvent('cache_miss', { key: 'user_123' });
      const testSpan = span as TestSpan;
      expect(testSpan.events).toHaveLength(1);
      expect(testSpan.events[0].name).toBe('cache_miss');
    });

    it('redacts PII in event attributes', () => {
      const span = startSpan('test');
      span.addEvent('error', { token: 'sk-abcdefghijklmnopqrstuvwxyz123456' });
      const testSpan = span as TestSpan;
      expect(testSpan.events[0].attrs?.token).toBe('[REDACTED]');
    });
  });

  describe('setError', () => {
    it('records an error on the span', () => {
      const span = startSpan('test');
      const err = new Error('something went wrong');
      span.setError(err);
      const testSpan = span as TestSpan;
      expect(testSpan.error).toBe(err);
    });
  });

  describe('end', () => {
    it('marks the span as ended', () => {
      const span = startSpan('test');
      const testSpan = span as TestSpan;
      expect(testSpan.ended).toBe(false);
      span.end();
      expect(testSpan.ended).toBe(true);
    });
  });

  describe('withSpan', () => {
    it('wraps a sync function and ends the span', () => {
      const result = withSpan('operation', (span) => {
        span.setAttributes({ key: 'value' });
        return 42;
      });
      expect(result).toBe(42);
      const testSpan = tracer.spans[0] as TestSpan;
      expect(testSpan.ended).toBe(true);
      expect(testSpan.attributes.key).toBe('value');
    });

    it('records error and rethrows', () => {
      const err = new Error('boom');
      expect(() => {
        withSpan('failing', () => { throw err; });
      }).toThrow('boom');
      const testSpan = tracer.spans[0] as TestSpan;
      expect(testSpan.ended).toBe(true);
      expect(testSpan.error).toBe(err);
    });
  });

  describe('withSpanAsync', () => {
    it('wraps an async function and ends the span', async () => {
      const result = await withSpanAsync('async_op', async (span) => {
        span.setAttributes({ async: true });
        return 'done';
      });
      expect(result).toBe('done');
      const testSpan = tracer.spans[0] as TestSpan;
      expect(testSpan.ended).toBe(true);
      expect(testSpan.attributes.async).toBe(true);
    });

    it('records async error and rethrows', async () => {
      const err = new Error('async_boom');
      await expect(
        withSpanAsync('failing_async', async () => { throw err; }),
      ).rejects.toThrow('async_boom');
      const testSpan = tracer.spans[0] as TestSpan;
      expect(testSpan.ended).toBe(true);
      expect(testSpan.error).toBe(err);
    });
  });

  describe('tracer management', () => {
    it('default tracer is no-op (no errors)', () => {
      setTracer(null);
      const span = startSpan('test');
      expect(() => span.end()).not.toThrow();
      expect(() => span.setAttributes({ a: 'b' })).not.toThrow();
      expect(() => span.addEvent('e')).not.toThrow();
      expect(() => span.setError(new Error('test'))).not.toThrow();
    });

    it('setTracer swaps the active tracer', () => {
      const tracer2 = new TestTracer();
      setTracer(tracer2);
      startSpan('test');
      expect(tracer2.spans).toHaveLength(1);
      expect(tracer.spans).toHaveLength(0);
    });
  });
});
