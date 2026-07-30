/**
 * OBS-03: Metrics instrumentation helpers.
 *
 * Thin abstraction over a hypothetical metrics backend.  No real provider is
 * wired — all methods are no-ops by default and emit structured-log events
 * when a Sink is configured.
 *
 * PII REDACTION: every metric name and label key/value is run through the
 * same defense-in-depth scanner used by the logger (DEFENSE_RE patterns).
 * Any match causes the label to be dropped and the metric logged with a
 * redacted_label warning event instead.
 *
 * Supported metric kinds:
 *   - Counter: monotonic count (e.g. request count, error count)
 *   - Gauge:   point-in-time value (e.g. queue depth, connected workers)
 *   - Histogram: distribution of values (e.g. latency, payload size)
 *
 * Negative: synthetic PII patterns in metric labels are redacted before the
 * value reaches any configured sink.  No real Axiom/Slack wiring.
 */

import { createLogger } from './logger.js';

interface MetricLabels {
  [key: string]: string | number | undefined;
}

/**
 * Defence-in-depth redaction patterns — identical to logger.ts DEFENSE_RE.
 * Applied to every metric name and every label key-value pair.
 */
const PII_RE = new RegExp(
  'eyJ[A-Za-z0-9_-]{4,}'
  + '|bearer\\s+\\S{8,}'
  + '|-{5}BEGIN\\s'
  + '|[A-Za-z0-9._%+\\-]{2,}@[A-Za-z0-9.\\-]+\\.[a-z]{2,}'
  + '|\\d{10,}'
  + '|sk-[A-Za-z0-9]{20,}'
  + '|gh[psuoar]_[A-Za-z0-9]{16,}'
  + '|xox[bpsa]-[A-Za-z0-9-]{8,}'
  + '|AKIA[A-Z0-9]{16}'
  + '|[A-Za-z0-9]{30,}'
  // Path-like patterns that could indicate file system leakage (mirror logger.ts)
  + '|\\/[A-Za-z0-9_\\-\\.]{2,}(?:\\/[A-Za-z0-9_\\-\\.]+)+',
  'i',
);

const SAFE_IDENT_RE = /^[a-zA-Z0-9_:.\-]{1,64}$/;

function isPii(value: string): boolean {
  return PII_RE.test(value);
}

/**
 * Validate and optionally redact a metric identifier (name or label key).
 *
 * The value must be a "safe identifier" (alphanumeric, underscore, colon,
 * dot, hyphen; 1-64 chars) AND must not match any PII pattern.  If either
 * check fails, the identifier is dropped — the caller handles fallback.
 */
function validateMetricName(name: string): string | null {
  if (!name || typeof name !== 'string') return null;
  if (!SAFE_IDENT_RE.test(name)) return null;
  if (isPii(name)) return null;
  return name;
}

/**
 * Validate a label value.  String values are PII-scanned; numeric values
 * are checked for finiteness.  Returns the cleaned value or null (drop).
 */
function validateLabelValue(value: string | number): string | number | null {
  if (typeof value === 'string') {
    if (isPii(value)) return null;
    if (value.length > 512) return value.slice(0, 512);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  return null;
}

/**
 * Filter labels: drop keys with PII values, non-safe-ident keys, and
 * non-scalar values.  Returns a clean label map.
 */
function filterLabels(labels?: MetricLabels): Record<string, string | number> | undefined {
  if (!labels) return undefined;
  const cleaned: Record<string, string | number> = {};
  for (const [key, val] of Object.entries(labels)) {
    const safeKey = validateMetricName(key);
    if (!safeKey) continue;
    if (val === undefined || val === null) continue;
    const safeVal = validateLabelValue(val);
    if (safeVal === null) continue;
    cleaned[safeKey] = safeVal;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ── Sink interface ───────────────────────────────────────────────

/**
 * Abstract metric sink.  By default all methods are no-ops.
 * A real sink (e.g. Prometheus client, OpenTelemetry metrics SDK, or a
 * test collector) implements this interface.
 */
export interface MetricSink {
  counter(name: string, value: number, labels?: Record<string, string | number>): void;
  gauge(name: string, value: number, labels?: Record<string, string | number>): void;
  histogram(name: string, value: number, labels?: Record<string, string | number>): void;
}

/** No-op sink — used when no backend is configured. */
const NOOP_SINK: MetricSink = {
  counter: () => {},
  gauge: () => {},
  histogram: () => {},
};

// ── Metrics registry ─────────────────────────────────────────────

let _sink: MetricSink = NOOP_SINK;
const _log = createLogger('metrics', { correlationIdGetter: () => null });

/**
 * Set the active metric sink.  Call once at startup.
 * Pass `null` to reset to the no-op sink (useful in tests).
 */
export function setMetricSink(sink: MetricSink | null): void {
  _sink = sink ?? NOOP_SINK;
}

/** Return the current sink (for test inspection). */
export function getMetricSink(): MetricSink {
  return _sink;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Increment a counter metric.
 *
 * @param name   Metric name (safe identifier, 1-64 chars).
 * @param value  Amount to increment (default 1).
 * @param labels Optional dimension labels (values are PII-scanned).
 */
export function counter(name: string, value: number = 1, labels?: MetricLabels): void {
  const safeName = validateMetricName(name);
  if (!safeName) {
    _log.warn('unknown_event', { error_type: 'invalid_metric_name' });
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    _log.warn('unknown_event', { error_type: 'invalid_counter_value' });
    return;
  }
  const safeLabels = filterLabels(labels);
  _sink.counter(safeName, value, safeLabels);
  _log.debug('scoring_trigger', { schema: safeName });
}

/**
 * Set a gauge metric.
 *
 * @param name   Metric name (safe identifier, 1-64 chars).
 * @param value  Current value.
 * @param labels Optional dimension labels (values are PII-scanned).
 */
export function gauge(name: string, value: number, labels?: MetricLabels): void {
  const safeName = validateMetricName(name);
  if (!safeName) {
    _log.warn('unknown_event', { error_type: 'invalid_metric_name' });
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    _log.warn('unknown_event', { error_type: 'invalid_gauge_value' });
    return;
  }
  const safeLabels = filterLabels(labels);
  _sink.gauge(safeName, value, safeLabels);
}

/**
 * Record a histogram observation.
 *
 * @param name   Metric name (safe identifier, 1-64 chars).
 * @param value  Observed value (must be finite).
 * @param labels Optional dimension labels (values are PII-scanned).
 */
export function histogram(name: string, value: number, labels?: MetricLabels): void {
  const safeName = validateMetricName(name);
  if (!safeName) {
    _log.warn('unknown_event', { error_type: 'invalid_metric_name' });
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    _log.warn('unknown_event', { error_type: 'invalid_histogram_value' });
    return;
  }
  const safeLabels = filterLabels(labels);
  _sink.histogram(safeName, value, safeLabels);
}

// ── Test collector sink ──────────────────────────────────────────

/**
 * In-memory test sink that records every metric emission.
 * Use in unit tests to verify metric calls without a real backend.
 */
export class TestMetricSink implements MetricSink {
  public counters: Array<{ name: string; value: number; labels?: Record<string, string | number> }> = [];
  public gauges: Array<{ name: string; value: number; labels?: Record<string, string | number> }> = [];
  public histograms: Array<{ name: string; value: number; labels?: Record<string, string | number> }> = [];

  counter(name: string, value: number, labels?: Record<string, string | number>): void {
    this.counters.push({ name, value, labels });
  }

  gauge(name: string, value: number, labels?: Record<string, string | number>): void {
    this.gauges.push({ name, value, labels });
  }

  histogram(name: string, value: number, labels?: Record<string, string | number>): void {
    this.histograms.push({ name, value, labels });
  }

  /** Reset all recorded values. */
  reset(): void {
    this.counters = [];
    this.gauges = [];
    this.histograms = [];
  }
}
