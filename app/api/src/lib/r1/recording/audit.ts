/**
 * Audit rows written by background jobs (no HTTP request, no authenticated user).
 *
 * `recordAudit` needs an Express request; a queue job has none. This writes a system-actor entry
 * straight to the audit sink with the same shape `recordAudit` produces (actor = the system user, the
 * metadata redacted by the same function). It is for FAIL-OPEN events only (`recording.integrity_verified`):
 * a sink outage is swallowed, because the state it describes is already persisted.
 */

import { getAuditSink, redactForAudit, type AuditEntry, type AuditEvent } from '../../audit.js';

export async function auditSystemEvent(
  event: AuditEvent,
  jobPath: string,
  metadata: Record<string, unknown>,
  now: () => Date = () => new Date(),
): Promise<void> {
  const entry: AuditEntry = {
    event,
    correlationId: null,
    userId: null,
    userRole: null,
    method: 'JOB',
    path: jobPath,
    statusCode: 200,
    metadata: redactForAudit(metadata) as Record<string, unknown>,
    timestamp: now().toISOString(),
  };
  try {
    await getAuditSink()(entry);
  } catch {
    /* fail-open: see above */
  }
}
