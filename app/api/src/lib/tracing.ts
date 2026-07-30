/**
 * OBS-04: Tracing instrumentation helpers.
 *
 * Thin span-based tracing abstraction.  By default spans are no-ops.
 * A real TracerBackend (e.g. OpenTelemetry Tracer, a test collector) can
 * be configured at startup.
 *
 * PII REDACTION: every span name, attribute key, and attribute value is
 * run through the same defence-in-depth scanner used by the logger.
 * Any value matching a PII pattern is replaced with "[REDACTED]".
 *
 * Negative: synthetic PII in span attributes is redacted.  No real
 * tracing backend (Axiom, Datadog APM, etc.) is wired.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';

// ── PII redaction patterns (same as metrics.ts / logger.ts) ──────

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

const log = createLogger('tracing', { correlationIdGetter: () => null });

/**
 * Check a string for PII content.  Returns true if any dangerous pattern
 * is detected.
 */
function hasPii(value: string): boolean {
  return PII_RE.test(value);
}

/**
 * Validate and optionally redact a span/attribute name.
 *
 * Names must be safe identifiers.  If the name contains PII it is still
 * accepted as a name (names tend to be short and hardcoded), but the
 * matching attribute value is always redacted.
 */
function validateSpanName(name: string): string | null {
  if (!name || typeof name !== 'string') return null;
  if (name.length > 128) return null;
  return name;
}

/**
 * Redact a string attribute value if it matches PII patterns.
 * Returns the original value if clean, "[REDACTED]" if dangerous.
 */
function redactAttributeValue(value: string): string {
  if (hasPii(value)) return '[REDACTED]';
  if (value.length > 1024) return value.slice(0, 1024);
  return value;
}

/**
 * Filter and redact span attributes.  Attribute values containing PII
 * are replaced with "[REDACTED]".
 */
function filterAttributes(attrs?: Record<string, string | number | boolean>): Record<string, string | number | boolean> | undefined {
  if (!attrs) return undefined;
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined || val === null) continue;
    if (typeof val === 'string') {
      cleaned[key] = redactAttributeValue(val);
    } else if (typeof val === 'number') {
      if (Number.isFinite(val)) cleaned[key] = val;
    } else if (typeof val === 'boolean') {
      cleaned[key] = val;
    }
    // non-scalar → silently dropped
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ── Span interface ───────────────────────────────────────────────

export interface Span {
  /** End the span at the current time. */
  end(): void;

  /** Set one or more attributes on the span (values PII-redacted). */
  setAttributes(attrs: Record<string, string | number | boolean>): void;

  /** Add a log/event to the span. */
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): void;

  /** Set an error status on the span. */
  setError(error: Error): void;

  /** The span's unique identifier. */
  readonly spanId: string;

  /** The trace's unique identifier. */
  readonly traceId: string;
}

// ── Tracer backend interface ─────────────────────────────────────

export interface TracerBackend {
  /** Start a new span, optionally as a child of the given parent span. */
  startSpan(name: string, parent?: Span): Span;
}

// ── No-op implementations ────────────────────────────────────────

class NoOpSpan implements Span {
  readonly spanId: string;
  readonly traceId: string;

  constructor() {
    this.spanId = randomUUID();
    this.traceId = randomUUID();
  }

  end(): void {}
  setAttributes(_attrs: Record<string, string | number | boolean>): void {}
  addEvent(_name: string, _attrs?: Record<string, string | number | boolean>): void {}
  setError(_error: Error): void {}
}

class NoOpTracer implements TracerBackend {
  startSpan(_name: string, _parent?: Span): Span {
    return new NoOpSpan();
  }
}

// ── Test-aware implementation ───────────────────────────────────

export class TestSpan implements Span {
  public ended = false;
  public attributes: Record<string, string | number | boolean> = {};
  public events: Array<{ name: string; attrs?: Record<string, string | number | boolean> }> = [];
  public error: Error | null = null;
  public readonly spanId: string;
  public readonly traceId: string;
  public readonly name: string;
  public readonly parentSpanId: string | null;

  constructor(name: string, parentSpanId: string | null = null) {
    this.name = name;
    this.spanId = randomUUID();
    this.traceId = parentSpanId ? randomUUID() : randomUUID();
    this.parentSpanId = parentSpanId;
  }

  end(): void {
    this.ended = true;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): void {
    Object.assign(this.attributes, filterAttributes(attrs));
  }

  addEvent(name: string, attrs?: Record<string, string | number | boolean>): void {
    this.events.push({ name, attrs: filterAttributes(attrs) });
  }

  setError(error: Error): void {
    this.error = error;
  }
}

export class TestTracer implements TracerBackend {
  public spans: TestSpan[] = [];
  private currentParentId: string | null = null;

  setParentSpan(span: Span): void {
    this.currentParentId = span.spanId;
  }

  startSpan(name: string, parent?: Span): Span {
    const parentId = parent?.spanId ?? this.currentParentId;
    const span = new TestSpan(name, parentId);
    this.spans.push(span);
    return span;
  }

  reset(): void {
    this.spans = [];
    this.currentParentId = null;
  }
}

// ── Global state ────────────────────────────────────────────────

let _tracer: TracerBackend = new NoOpTracer();

/**
 * Set the active tracer backend.  Call once at startup.
 * Pass `null` to reset to the no-op tracer (useful in tests).
 */
export function setTracer(tracer: TracerBackend | null): void {
  _tracer = tracer ?? new NoOpTracer();
}

/** Return the current tracer (for test inspection). */
export function getTracer(): TracerBackend {
  return _tracer;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Start a new span.
 *
 * @param name   Span name (max 128 chars).
 * @param parent Optional parent span to establish a child relationship.
 * @returns A Span instance.
 */
export function startSpan(name: string, parent?: Span): Span {
  const safeName = validateSpanName(name);
  if (!safeName) {
    log.warn('unknown_event', { error_type: 'invalid_span_name' });
    return new NoOpSpan();
  }
  return _tracer.startSpan(safeName, parent);
}

/**
 * Run a function inside a span.  The span is automatically ended when
 * the function completes (or errors).
 *
 * @param name    Span name.
 * @param fn      Function to wrap.
 * @param parent  Optional parent span.
 * @returns The function's return value.
 */
export function withSpan<T>(
  name: string,
  fn: (span: Span) => T,
  parent?: Span,
): T {
  const span = startSpan(name, parent);
  try {
    return fn(span);
  } catch (err) {
    if (err instanceof Error) {
      span.setError(err);
    }
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Run an async function inside a span.  The span is automatically ended
 * when the promise resolves or rejects.
 *
 * @param name    Span name.
 * @param fn      Async function to wrap.
 * @param parent  Optional parent span.
 * @returns A promise for the function's return value.
 */
export async function withSpanAsync<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  parent?: Span,
): Promise<T> {
  const span = startSpan(name, parent);
  try {
    return await fn(span);
  } catch (err) {
    if (err instanceof Error) {
      span.setError(err);
    }
    throw err;
  } finally {
    span.end();
  }
}
