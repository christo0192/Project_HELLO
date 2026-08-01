/**
 * SEC-05: Audit logging with allowlisted typed events.
 *
 * Features:
 *  - Allowlist of typed audit events
 *  - PII redaction: strips transcript/resume text, auth headers,
 *    tokens, secrets, raw PII from logged data
 *  - Fail-closed policy: privileged mutation audit failures
 *    prevent the mutation from proceeding
 *  - Authorization-failure audit must never turn 401/403 into 500
 *  - Source IP minimized (IPv4 /24, IPv6 /48)
 *
 * Dependency-injectable sink for testability.
 *
 * DB-BACKED SINK: createDbAuditSink() writes to the `audit_events` table
 * via the service-role Supabase client. Wire in createApp().
 */

import type { Request } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from './logger.js';
import type { EventName } from './logger.js';

// ── Audit event allowlist ───────────────────────────────────────────

export type AuditEvent =
  | 'auth.login_success'
  | 'auth.login_failure'
  | 'auth.token_refresh'
  | 'auth.logout'
  | 'rbac.access_denied'
  | 'rbac.ownership_denied'
  | 'resource.create'
  | 'resource.read'
  | 'resource.update'
  | 'resource.delete'
  | 'resource.list'
  | 'rate_limit.exceeded'
  | 'audit.sink_failure'
  | 'audit.configuration_error'
  | 'recording.download'
  // REC-03/04/05 (L5, additive): browser upload + integrity lifecycle.
  // 'recording.deleted' lands now so the union is stable; L6 uses it.
  | 'recording.upload'
  | 'recording.integrity_verified'
  | 'recording.quarantined'
  | 'recording.revoked'
  | 'recording.deleted';

/** Events that, when they fail to record for a privileged mutation,
 *  should block the mutation (fail-closed). */
export const FAIL_CLOSED_EVENTS: ReadonlySet<string> = new Set([
  'resource.create',
  'resource.update',
  'resource.delete',
  // REC-03/04/05: security-relevant recording writes are fail-closed — an
  // audit-sink failure must never silently leave an upload/quarantine/
  // revocation/erasure unrecorded.
  'recording.upload',
  'recording.quarantined',
  'recording.revoked',
  'recording.deleted',
]);

/** Events that are informational and must never cause a 500. */
export const FAIL_OPEN_EVENTS: ReadonlySet<string> = new Set([
  'auth.login_failure',
  'auth.login_success',
  'auth.token_refresh',
  'auth.logout',
  'rbac.access_denied',
  'rbac.ownership_denied',
  'resource.read',
  'resource.list',
  'rate_limit.exceeded',
  'audit.sink_failure',
  'audit.configuration_error',
  'recording.download',
  // REC-04: verification is a read-adjacent/informational event — the
  // integrity state itself is already persisted; a failed audit row must not
  // turn a successful upload into a 500.
  'recording.integrity_verified',
]);

// ── PII redaction patterns ──────────────────────────────────────────

/**
 * Patterns that identify sensitive data to redact.
 * These match against JSON-stringified metadata values.
 */
const REDACT_PATTERNS: RegExp[] = [
  // Transcript/resume text blocks (long text)
  /\b(transcript|resume_text|resume_content|candidate_text|bot_text)\b.{0,1000}/gi,
  // Authorization headers
  /(?:"Authorization"\s*:\s*)"Bearer\s+\S+"/gi,
  /(?:"authorization"\s*:\s*)"Bearer\s+\S+"/gi,
  // JWT tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // API keys and secrets
  /\b(sk-[A-Za-z0-9]{20,}|gh[psuoar]_[A-Za-z0-9]{16,}|xox[bpsa]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g,
  // Email addresses
  /[A-Za-z0-9._%+\-]{2,}@[A-Za-z0-9.\-]+\.[a-z]{2,}/g,
  // Phone numbers (10+ digits)
  /\b\d{10,}\b/g,
  // High-entropy strings (likely tokens)
  /\b[A-Za-z0-9]{30,}\b/g,
];

const REDACTED = '[REDACTED]';

/**
 * Redact sensitive data from a value for audit logging.
 * Returns a safe-for-logging version of the input.
 */
export function redactForAudit(input: unknown): unknown {
  if (typeof input === 'string') {
    let result = input;
    for (const pattern of REDACT_PATTERNS) {
      result = result.replace(pattern, REDACTED);
    }
    return result;
  }
  if (input === null || input === undefined || typeof input === 'boolean' || typeof input === 'number') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(redactForAudit);
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Drop known PII-carrying keys entirely
      if (isSensitiveKey(key)) continue;
      redacted[key] = redactForAudit(value);
    }
    return redacted;
  }
  return input;
}

/**
 * Keys that carry PII and should be dropped entirely (not just redacted).
 */
const SENSITIVE_KEYS = new Set([
  'transcript',
  'resume_text',
  'resume_content',
  'candidate_text',
  'bot_text',
  'authorization',
  'Authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'token',
  'api_key',
  'apiKey',
  'private_key',
  'privateKey',
  'access_token',
  'refresh_token',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token');
}

// ── Source IP minimization (SEC-06 LOW) ──────────────────────────────

/**
 * Minimize an IP address for audit logging.
 *   - IPv4: truncate to /24 (zero out last octet)
 *   - IPv6: truncate to /48 (zero out last 80 bits)
 *   - Invalid/private: return as-is
 */
export function minimizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) → extract and minimize as IPv4
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    return minimizeIp(v4Mapped[1]);
  }

  // IPv4 /24
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) {
    return `${v4[1]}.0/24`;
  }

  // IPv6 /48 — keep first 3 hextets
  const v6 = ip.match(
    /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4})(?::[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})?$/i,
  );
  if (v6) {
    return `${v6[1]}::/48`;
  }

  // Fallback: return as-is for unrecognized formats
  return ip;
}

// ── Audit entry shape ───────────────────────────────────────────────

export interface AuditEntry {
  event: AuditEvent;
  /** Correlation ID from the request context. */
  correlationId: string | null;
  /** Authenticated user ID (if available). */
  userId: string | null;
  /** User's app role at time of action. */
  userRole: string | null;
  /** HTTP method. */
  method: string;
  /** URL path (no query). */
  path: string;
  /** HTTP status code returned (or intended). */
  statusCode?: number;
  /** Data-minimized metadata (already redacted). */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Source IP (minimized to /24 or /48 prefix). */
  sourceIp?: string;
}

// ── Audit sink (injectable) ─────────────────────────────────────────

export type AuditSink = (entry: AuditEntry) => Promise<void> | void;

let _auditSink: AuditSink = defaultAuditSink;

const auditLogger = createLogger('audit');

/**
 * Default audit sink: logs to the structured logger.
 */
function defaultAuditSink(entry: AuditEntry): void {
  const level = entry.event.includes('failure') || entry.event.includes('denied') ? 'warn' : 'info';
  auditLogger[level]('unknown_event' as EventName, {
    ...(entry.metadata as Record<string, string | number>),
    method: entry.method,
    status: entry.statusCode,
  });
}

/**
 * Create a DB-backed audit sink that writes to the `audit_events` table.
 *
 * Used in production: persists every audit event to the audit_events table
 * via the service-role client. Sink failures on privileged mutations are
 * handled by recordAudit()'s fail-closed policy.
 */
const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

function auditTarget(entry: AuditEntry): { type: string; id: string } {
  const metadata = entry.metadata ?? {};
  const idEntry = Object.entries(metadata).find(
    ([key, value]) => key.endsWith('_id') && typeof value === 'string' && value.length <= 128,
  );
  const segment = entry.path.split('/').filter(Boolean).at(1) ?? 'api';
  return {
    type: segment.replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'api',
    id: idEntry ? String(idEntry[1]) : entry.path.slice(0, 256),
  };
}

export function createDbAuditSink(supabase: SupabaseClient): AuditSink {
  return async (entry: AuditEntry) => {
    const target = auditTarget(entry);
    const status = entry.statusCode ?? 200;
    const { error } = await supabase
      .from('audit_events')
      .insert({
        actor_id: entry.userId ?? SYSTEM_ACTOR_ID,
        actor_type: entry.userId ? 'recruiter' : 'system',
        action: entry.event.replaceAll('.', '_'),
        target_type: target.type,
        target_id: target.id,
        result: status >= 400 ? 'failure' : 'success',
        correlation_id: entry.correlationId,
        metadata: {
          ...(entry.metadata ?? {}),
          method: entry.method,
          path: entry.path,
          status_code: status,
          user_role: entry.userRole,
          source_ip_prefix: entry.sourceIp,
        },
        created_at: entry.timestamp,
      });
    if (error) throw new Error('audit db insert failed');
  };
}

export function setAuditSink(sink: AuditSink): void {
  _auditSink = sink;
}

export function getAuditSink(): AuditSink {
  return _auditSink;
}

// ── Recording audit entries (fail-closed / fail-open) ───────────────

export interface AuditOptions {
  /** Override the event name (e.g., for failure variants). */
  eventOverride?: AuditEvent;
  /** Additional metadata for the audit entry. */
  metadata?: Record<string, unknown>;
  /** Override to skip redaction (e.g., already-sanitized data). */
  skipRedact?: boolean;
}

/**
 * Record an audit entry.
 *
 * For FAIL_CLOSED_EVENTS: if the sink throws, this function throws,
 * causing the caller (mutation handler) to fail safe.
 *
 * For FAIL_OPEN_EVENTS: sink errors are logged but swallowed;
 * the caller proceeds normally.
 */
export async function recordAudit(
  req: Request,
  event: AuditEvent,
  statusCode?: number,
  opts: AuditOptions = {},
): Promise<void> {
  const metadata = opts.skipRedact
    ? (opts.metadata ?? {})
    : (redactForAudit(opts.metadata ?? {}) as Record<string, unknown>);

  const entry: AuditEntry = {
    event: opts.eventOverride ?? event,
    correlationId: (req as any).correlationId ?? null,
    userId: req.authUser?.id ?? null,
    userRole: req.authUser?.appRole ?? null,
    method: req.method,
    path: req.path,
    statusCode,
    metadata,
    timestamp: new Date().toISOString(),
    sourceIp: minimizeIp(req.ip ?? req.socket.remoteAddress),
  };

  const isFailClosed = FAIL_CLOSED_EVENTS.has(event);

  try {
    await _auditSink(entry);
  } catch (sinkError) {
    if (isFailClosed) {
      // Fail-closed: rethrow so the caller can abort the mutation
      throw new Error('Audit sink failure — mutation aborted (fail-closed)');
    }
    // Fail-open: log and swallow (for auth-failure events, rate limits, etc.)
    auditLogger.error('error_unhandled', { error_type: 'audit_sink_failure' });
  }
}

/**
 * Body data that should be stripped from audit metadata before recording.
 * Always called by recordAudit via redactForAudit.
 */
export const AUDIT_STRIP_KEYS = SENSITIVE_KEYS;

// ── Quick helpers ───────────────────────────────────────────────────

/**
 * Record an RBAC access denial. Always fail-open — must never turn 403 into 500.
 */
export async function auditAccessDenied(req: Request, reason?: string): Promise<void> {
  await recordAudit(
    req,
    'rbac.access_denied',
    403,
    {
      metadata: { reason: reason ?? 'insufficient_role' },
    },
  );
}

/**
 * Record an authentication failure. Always fail-open.
 */
export async function auditAuthFailure(req: Request, reason?: string): Promise<void> {
  await recordAudit(
    req,
    'auth.login_failure',
    401,
    {
      metadata: { reason: reason ?? 'invalid_token' },
    },
  );
}

/**
 * Record a rate-limit exceeded event. Always fail-open.
 */
export async function auditRateLimitExceeded(req: Request): Promise<void> {
  await recordAudit(
    req,
    'rate_limit.exceeded',
    429,
    {
      metadata: { reason: 'token_bucket_exhausted' },
    },
  );
}
