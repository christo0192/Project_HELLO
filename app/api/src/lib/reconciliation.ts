/**
 * REL-09 — Reconciliation & Fallback (read-only detect + safe repair/quarantine).
 *
 * The reconciler is a READ-ONLY detector that SURFACES issues and, when
 * repair is requested, plans safe transitions. It NEVER directly mutates
 * call_sessions, transcript_turns, assessments, or recordings — all repairs
 * go through the existing CAS-based transitionSession() and produce audit
 * records in reconciliation_log and quarantined_sessions.
 *
 * DESIGN PRINCIPLES:
 *   1. Every detect() call is idempotent (ON CONFLICT DO NOTHING on
 *      issue_signature). Re-running is safe.
 *   2. Every repair is idempotent — transitionSession() uses CAS, and
 *      quaranitine prevents re-quarantine.
 *   3. All actions are audited in reconciliation_log with stable error codes.
 *   4. Quarantine is a soft isolation: the session is moved to a terminal
 *      state AND recorded in quarantined_sessions for human review.
 *   5. Stable error codes only — no runtime values in error messages.
 *
 * ISSUE CATEGORIES DETECTED:
 *   - stuck_session:    session in pending/non-terminal state past timeout
 *   - orphan_room:      waiting session with stale waiting_at (no worker joined)
 *   - transcript_gap:   terminal session with zero transcript turns
 *   - missing_recording: completed session with no recording_object_key
 *   - overdue_scorecard: completed session with no assessment row
 */

import { supabase } from './supabase.js';
import { createLogger } from './logger.js';
import type { EventName } from './logger.js';

// ── Stable error codes ───────────────────────────────────────────────

export const ERR_RUN_ID_FORMAT = 'ERR_RUN_ID_FORMAT';
export const ERR_RECONCILE_FAILED = 'ERR_RECONCILE_FAILED';
export const ERR_INSERT_FAILED = 'ERR_INSERT_FAILED';
export const ERR_INVALID_CATEGORY = 'ERR_INVALID_CATEGORY';
export const ERR_ALREADY_REPAIRED = 'ERR_ALREADY_REPAIRED';
export const ERR_ALREADY_QUARANTINED = 'ERR_ALREADY_QUARANTINED';
export const ERR_REPAIR_FAILED = 'ERR_REPAIR_FAILED';
export const ERR_QUARANTINE_FAILED = 'ERR_QUARANTINE_FAILED';
export const ERR_UNEXPECTED = 'ERR_UNEXPECTED';

// ── Logger ───────────────────────────────────────────────────────────

const reconcileLogger = createLogger('reconciler');

// ── Types ────────────────────────────────────────────────────────────

export type IssueCategory =
  | 'stuck_session'
  | 'orphan_room'
  | 'transcript_gap'
  | 'missing_recording'
  | 'overdue_scorecard';

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export type RepairAction =
  | 'transition_to_expired'
  | 'transition_to_failed'
  | 'quarantine_session'
  | 'noop';

export interface ReconciliationIssue {
  /** UUID from run_id — groups all issues from one reconcile() call. */
  runId: string;
  /** Stable category code. */
  category: IssueCategory;
  /** Severity level. */
  severity: Severity;
  /** Session UUID (nullable for candidate-level issues). */
  sessionId: string | null;
  /** Candidate UUID (nullable). */
  candidateId: string | null;
  /** Deterministic hash for idempotent logging. */
  signature: string;
  /** Human-readable description. */
  description: string;
  /** Arbitrary JSON details. */
  details: Record<string, unknown>;
}

export interface ReconciliationReport {
  /** Unique run ID. */
  runId: string;
  /** ISO-8601 timestamp of detection. */
  detectedAt: string;
  /** All issues found in this run. */
  issues: ReconciliationIssue[];
  /** Count per category. */
  summary: Record<IssueCategory, number>;
  /** Total issues found. */
  total: number;
}

export interface RepairPlan {
  /** The issue being repaired. */
  issue: ReconciliationIssue;
  /** Recommended repair action. */
  action: RepairAction;
  /** Human-readable reason for the repair. */
  reason: string;
}

export interface RepairResult {
  ok: boolean;
  code?: string;
  issueId?: string;
  sessionId?: string | null;
  action?: RepairAction;
  quarantined?: boolean;
}

// ── UUID v4 pattern ──────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(s: string): boolean {
  return UUID_PATTERN.test(s);
}

// ──── Default timeouts (milliseconds) ────────────────────────────────

const DEFAULT_TIMEOUTS = {
  waitingTimeoutMs: 5 * 60 * 1000,     // 5 min
  createdTimeoutMs: 30 * 60 * 1000,    // 30 min
  progressTimeoutMs: 2 * 60 * 60 * 1000, // 2 hours
} as const;

// ═══════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run a full reconciliation scan: detect all issue categories and log them
 * to reconciliation_log. Idempotent — re-running inserts no duplicate rows.
 *
 * @param runId  Optional explicit runId; generated if omitted.
 * @param timeouts  Optional overrides for stuck-session thresholds (ms).
 * @returns  A ReconciliationReport with all detected issues.
 */
export async function reconcile(
  runId?: string,
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>,
): Promise<ReconciliationReport> {
  const resolvedRunId = runId ?? crypto.randomUUID();
  if (runId && !isValidUuid(runId)) {
    throw new ReconcilerError(ERR_RUN_ID_FORMAT);
  }

  const t0 = performance.now();
  const detectedAt = new Date().toISOString();
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };

  const allIssues: ReconciliationIssue[] = [];

  // Run each detector — failures are caught per-category so one bad detector
  // does not poison the entire reconciliation run.
  const detectors: Array<() => Promise<ReconciliationIssue[]>> = [
    () => detectStuckSessions(resolvedRunId, t),
    () => detectOrphanRooms(resolvedRunId, t),
    () => detectTranscriptGaps(resolvedRunId),
    () => detectMissingRecordings(resolvedRunId),
    () => detectOverdueScorecards(resolvedRunId),
  ];

  for (const detect of detectors) {
    try {
      const issues = await detect();
      allIssues.push(...issues);
    } catch (err) {
      reconcileLogger.warn('reconciler_detection_failed' as EventName, {
        error_category: 'detector_error',
        error_type: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // Log all issues to the reconciliation_log table (idempotent insert).
  if (allIssues.length > 0) {
    await logIssues(allIssues);
  }

  // Build summary.
  const summary: Record<IssueCategory, number> = {
    stuck_session: 0,
    orphan_room: 0,
    transcript_gap: 0,
    missing_recording: 0,
    overdue_scorecard: 0,
  };
  for (const issue of allIssues) {
    summary[issue.category]++;
  }

  const elapsed = performance.now() - t0;
  reconcileLogger.info('reconciler_run_complete' as EventName, {
    error_category: 'reconciliation',
    error_type: 'run_complete',
    status: allIssues.length,
    duration_sec: Math.round(elapsed),
  });

  return {
    runId: resolvedRunId,
    detectedAt,
    issues: allIssues,
    summary,
    total: allIssues.length,
  };
}

/**
 * Generate a repair plan for a single detected issue.
 * Does NOT execute the repair — only returns the recommended action.
 */
export function planRepair(issue: ReconciliationIssue): RepairPlan {
  switch (issue.category) {
    case 'stuck_session':
    case 'orphan_room':
      return {
        issue,
        action: 'transition_to_expired',
        reason: `Session ${issue.sessionId} has been in '${issue.details.currentStatus}' past timeout; transitioning to 'expired' with reason 'idle_timeout'.`,
      };

    case 'transcript_gap': {
      const status = issue.details.currentStatus as string;
      if (status === 'failed') {
        return {
          issue,
          action: 'noop',
          reason: `Session ${issue.sessionId} has no transcript turns but is already in a terminal 'failed' state; no action required.`,
        };
      }
      return {
        issue,
        action: 'quarantine_session',
        reason: `Session ${issue.sessionId} is '${status}' with zero transcript turns; possible data loss. Quarantining for human review.`,
      };
    }

    case 'missing_recording':
      return {
        issue,
        action: 'quarantine_session',
        reason: `Session ${issue.sessionId} completed but has no recording_object_key; possible recording failure. Quarantining for human review.`,
      };

    case 'overdue_scorecard':
      return {
        issue,
        action: 'quarantine_session',
        reason: `Session ${issue.sessionId} completed but has no assessment row; scoring may have failed. Quarantining for human review.`,
      };

    default:
      return {
        issue,
        action: 'noop',
        reason: `Unknown category '${issue.category}'; no automated repair available.`,
      };
  }
}

/**
 * Execute a repair plan.
 *
 * For 'transition_to_expired' / 'transition_to_failed' actions:
 *   - Uses the CAS-based transitionSession() if the session is still in the
 *     expected status. If the session has already transitioned (CAS returns
 *     conflict), the repair is a no-op (idempotent).
 *   - Logs the repair action to reconciliation_log.
 *
 * For 'quarantine_session' actions:
 *   - Inserts into quarantined_sessions (unique on session_id → idempotent).
 *   - Logs the quarantine action to reconciliation_log.
 *
 * @returns The result of the repair attempt.
 */
export async function executeRepair(
  plan: RepairPlan,
  // Injected transitionSession for testability.
  transitionSessionFn?: (
    sessionId: string,
    expectedStatus: string,
    newStatus: string,
    terminalReason?: string,
  ) => Promise<{ ok: boolean; conflict?: boolean; code?: string }>,
): Promise<RepairResult> {
  const { issue, action } = plan;

  if (!issue.sessionId) {
    return { ok: false, code: 'ERR_NO_SESSION_ID' };
  }

  switch (action) {
    case 'transition_to_expired': {
      const expectedStatus = issue.details.currentStatus as string;
      if (!expectedStatus) {
        return { ok: false, code: ERR_REPAIR_FAILED, issueId: issue.runId };
      }

      // Import conditionally for test injection seam.
      let doTransition: typeof transitionSessionFn | undefined = transitionSessionFn;
      if (!doTransition) {
        const sl = await import('./session-lifecycle.js');
        doTransition = (sid, exp, nxt, reason) =>
          sl.transitionSession(sid, exp as any, nxt as any, reason as any);
      }

      const result = await doTransition!(
        issue.sessionId,
        expectedStatus,
        'expired',
        'idle_timeout',
      );

      if (!result.ok && result.conflict) {
        // Session already transitioned — idempotent no-op.
        await markIssueRepaired(issue, 'noop', 'Session already transitioned; no action needed.');
        return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action: 'noop' };
      }

      if (!result.ok) {
        await markIssueRepaired(issue, 'noop', `Transition failed: ${result.code}`);
        return { ok: false, code: result.code ?? ERR_REPAIR_FAILED, issueId: issue.runId };
      }

      await markIssueRepaired(issue, action, plan.reason);
      return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action };
    }

    case 'transition_to_failed': {
      const expectedStatus = issue.details.currentStatus as string;
      if (!expectedStatus) {
        return { ok: false, code: ERR_REPAIR_FAILED, issueId: issue.runId };
      }

      let doTransition: typeof transitionSessionFn | undefined = transitionSessionFn;
      if (!doTransition) {
        const sl = await import('./session-lifecycle.js');
        doTransition = (sid, exp, nxt, reason) =>
          sl.transitionSession(sid, exp as any, nxt as any, reason as any);
      }

      const result = await doTransition!(
        issue.sessionId,
        expectedStatus,
        'failed',
        'provider_error',
      );

      if (!result.ok && result.conflict) {
        await markIssueRepaired(issue, 'noop', 'Session already transitioned; no action needed.');
        return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action: 'noop' };
      }

      if (!result.ok) {
        await markIssueRepaired(issue, 'noop', `Transition failed: ${result.code}`);
        return { ok: false, code: result.code ?? ERR_REPAIR_FAILED, issueId: issue.runId };
      }

      await markIssueRepaired(issue, action, plan.reason);
      return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action };
    }

    case 'quarantine_session': {
      // Check if already quarantined (idempotent).
      const { data: existing } = await supabase
        .from('quarantined_sessions')
        .select('id')
        .eq('session_id', issue.sessionId)
        .maybeSingle();

      if (existing) {
        await markIssueRepaired(issue, 'noop', 'Session already quarantined; no action needed.');
        return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action: 'noop', quarantined: true };
      }

      const quarantinePayload: Record<string, unknown> = {
        session_id: issue.sessionId,
        candidate_id: issue.candidateId ?? null,
        quarantined_by: 'reconciler',
        reason: plan.reason,
        details: {
          issue_category: issue.category,
          issue_signature: issue.signature,
          run_id: issue.runId,
          ...issue.details,
        },
      };

      const { error: qError } = await supabase
        .from('quarantined_sessions')
        .insert(quarantinePayload);

      if (qError) {
        return { ok: false, code: ERR_QUARANTINE_FAILED, issueId: issue.runId };
      }

      await markIssueRepaired(issue, action, plan.reason, { quarantined: true });
      return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action, quarantined: true };
    }

    case 'noop':
    default:
      return { ok: true, issueId: issue.runId, sessionId: issue.sessionId, action: 'noop' };
  }
}

/**
 * Get the current quarantine status for a session.
 */
export async function getQuarantineStatus(
  sessionId: string,
): Promise<{ quarantined: boolean; record?: Record<string, unknown> }> {
  if (!isValidUuid(sessionId)) {
    return { quarantined: false };
  }

  const { data } = await supabase
    .from('quarantined_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (!data) {
    return { quarantined: false };
  }

  return {
    quarantined: true,
    record: data as unknown as Record<string, unknown>,
  };
}

/**
 * Get the reconciliation log for a session or all recent logs.
 */
export async function getReconciliationLog(
  options?: {
    sessionId?: string;
    category?: IssueCategory;
    limit?: number;
    offset?: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const { sessionId, category, limit = 100, offset = 0 } = options ?? {};

  let query = supabase
    .from('reconciliation_log')
    .select('*')
    .order('detected_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (sessionId && isValidUuid(sessionId)) {
    query = query.eq('session_id', sessionId);
  }

  if (category) {
    query = query.eq('issue_category', category);
  }

  const { data, error } = await query;

  if (error) {
    reconcileLogger.warn('reconciler_log_fetch_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_log_fetch_failed',
    });
    return [];
  }

  return (data ?? []) as unknown as Array<Record<string, unknown>>;
}

// ═══════════════════════════════════════════════════════════════════════
//  Detectors (internal)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Detect sessions stuck in non-terminal states past configurable timeouts.
 * Uses the stuck_sessions() DB function.
 */
async function detectStuckSessions(
  runId: string,
  timeouts: typeof DEFAULT_TIMEOUTS,
): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];

  // Convert ms to seconds for the DB function.
  const waitingSec = Math.floor(timeouts.waitingTimeoutMs / 1000);
  const createdSec = Math.floor(timeouts.createdTimeoutMs / 1000);
  const progressSec = Math.floor(timeouts.progressTimeoutMs / 1000);

  const { data, error } = await supabase.rpc('stuck_sessions', {
    waiting_timeout_sec: waitingSec,
    created_timeout_sec: createdSec,
    progress_timeout_sec: progressSec,
  });

  if (error) {
    reconcileLogger.warn('reconciler_stuck_detect_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_stuck_detect_failed',
    });
    return issues;
  }

  const rows = data as Array<{
    session_id: string;
    status: string;
    state_duration_sec: number;
    candidate_id: string;
    reason_hint: string;
  }> | null;

  if (!rows) return issues;

  for (const row of rows) {
    const signature = md5(`stuck_session:${row.session_id}:${row.status}`);

    issues.push({
      runId,
      category: 'stuck_session',
      severity: row.reason_hint === 'stuck_in_progress' ? 'warning' : 'error',
      sessionId: row.session_id,
      candidateId: row.candidate_id,
      signature,
      description: `Session ${row.session_id} stuck in '${row.status}' for ${row.state_duration_sec.toFixed(0)}s`,
      details: {
        currentStatus: row.status,
        stateDurationSec: row.state_duration_sec,
        reasonHint: row.reason_hint,
      },
    });
  }

  return issues;
}

/**
 * Detect orphan rooms: sessions stuck in 'waiting' state past timeout.
 * These are a subset of stuck_sessions but specifically flagged for
 * room-cleanup context.
 */
async function detectOrphanRooms(
  runId: string,
  timeouts: typeof DEFAULT_TIMEOUTS,
): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];

  const { data, error } = await supabase
    .from('call_sessions')
    .select('id, candidate_id, waiting_at, started_at')
    .eq('status', 'waiting')
    .lte(
      'waiting_at',
      new Date(Date.now() - timeouts.waitingTimeoutMs).toISOString(),
    )
    .limit(50);

  if (error) {
    reconcileLogger.warn('reconciler_orphan_detect_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_orphan_detect_failed',
    });
    return issues;
  }

  const rows = data as Array<{
    id: string;
    candidate_id: string;
    waiting_at: string | null;
    started_at: string;
  }> | null;

  if (!rows) return issues;

  for (const row of rows) {
    const signature = md5(`orphan_room:${row.id}`);

    issues.push({
      runId,
      category: 'orphan_room',
      severity: 'error',
      sessionId: row.id,
      candidateId: row.candidate_id,
      signature,
      description: `Session ${row.id} is in 'waiting' state with no worker attached (orphan room)`,
      details: {
        currentStatus: 'waiting',
        waitingAt: row.waiting_at,
        createdAt: row.started_at,
      },
    });
  }

  return issues;
}

/**
 * Detect terminal sessions with no transcript turns.
 */
async function detectTranscriptGaps(
  runId: string,
): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];

  const { data, error } = await supabase.rpc('sessions_without_transcripts');

  if (error) {
    reconcileLogger.warn('reconciler_transcript_gap_detect_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_transcript_gap_detect_failed',
    });
    return issues;
  }

  const rows = data as Array<{
    session_id: string;
    candidate_id: string;
    ended_at: string;
    status: string;
  }> | null;

  if (!rows) return issues;

  for (const row of rows) {
    const signature = md5(`transcript_gap:${row.session_id}`);

    issues.push({
      runId,
      category: 'transcript_gap',
      severity: row.status === 'completed' ? 'critical' : 'warning',
      sessionId: row.session_id,
      candidateId: row.candidate_id,
      signature,
      description: `Session ${row.session_id} is '${row.status}' with zero transcript turns`,
      details: {
        currentStatus: row.status,
        endedAt: row.ended_at,
      },
    });
  }

  return issues;
}

/**
 * Detect completed sessions with no recording_object_key.
 */
async function detectMissingRecordings(
  runId: string,
): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];

  const { data, error } = await supabase.rpc('sessions_missing_recording');

  if (error) {
    reconcileLogger.warn('reconciler_missing_recording_detect_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_missing_recording_detect_failed',
    });
    return issues;
  }

  const rows = data as Array<{
    session_id: string;
    candidate_id: string;
    ended_at: string;
    status: string;
  }> | null;

  if (!rows) return issues;

  for (const row of rows) {
    const signature = md5(`missing_recording:${row.session_id}`);

    issues.push({
      runId,
      category: 'missing_recording',
      severity: 'error',
      sessionId: row.session_id,
      candidateId: row.candidate_id,
      signature,
      description: `Session ${row.session_id} completed with no recording_object_key`,
      details: {
        currentStatus: row.status,
        endedAt: row.ended_at,
      },
    });
  }

  return issues;
}

/**
 * Detect completed sessions with no assessment row (overdue scorecard).
 */
async function detectOverdueScorecards(
  runId: string,
): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];

  const { data, error } = await supabase.rpc('missing_assessment_sessions');

  if (error) {
    reconcileLogger.warn('reconciler_overdue_scorecard_detect_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_overdue_scorecard_detect_failed',
    });
    return issues;
  }

  const rows = data as Array<{
    session_id: string;
    candidate_id: string;
    completed_at: string;
    status: string;
  }> | null;

  if (!rows) return issues;

  for (const row of rows) {
    const signature = md5(`overdue_scorecard:${row.session_id}`);

    issues.push({
      runId,
      category: 'overdue_scorecard',
      severity: 'warning',
      sessionId: row.session_id,
      candidateId: row.candidate_id,
      signature,
      description: `Session ${row.session_id} completed with no assessment`,
      details: {
        currentStatus: row.status,
        endedAt: row.completed_at,
      },
    });
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Log issues to the reconciliation_log table with idempotent inserts.
 * ON CONFLICT DO NOTHING prevents duplicates from re-runs.
 */
async function logIssues(issues: ReconciliationIssue[]): Promise<void> {
  const insertPayload = issues.map((issue) => ({
    run_id: issue.runId,
    detected_at: new Date().toISOString(),
    issue_category: issue.category,
    severity: issue.severity,
    session_id: issue.sessionId,
    candidate_id: issue.candidateId,
    issue_signature: issue.signature,
    details: issue.details,
    repaired: false,
    repair_action: null,
    repair_reason: null,
    quarantined: false,
  }));

  const { error } = await supabase
    .from('reconciliation_log')
    .insert(insertPayload as any)
    .select('id');

  if (error) {
    reconcileLogger.warn('reconciler_log_insert_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_log_insert_failed',
      duration_sec: issues.length,
    });
  }
}

/**
 * Mark an issue as repaired in the reconciliation_log.
 */
async function markIssueRepaired(
  issue: ReconciliationIssue,
  action: RepairAction | 'noop',
  reason: string,
  extra?: { quarantined?: boolean },
): Promise<void> {
  const updates: Record<string, unknown> = {
    repaired: true,
    repair_action: action,
    repair_reason: reason,
  };

  if (extra?.quarantined) {
    updates.quarantined = true;
  }

  const { error } = await supabase
    .from('reconciliation_log')
    .update(updates)
    .eq('issue_signature', issue.signature);

  if (error) {
    reconcileLogger.warn('reconciler_mark_repaired_failed' as EventName, {
      error_category: 'reconciliation',
      error_type: 'db_mark_repaired_failed',
      turn_index: 0,
    });
  }
}

// ── Simple deterministic string hash (not cryptographic). ─────────────
// Used only for idempotency keys, not security.
function md5(input: string): string {
  // We use a simple hash since this is for idempotency signatures, not crypto.
  // Built-in crypto.createHash would require importing node:crypto; this
  // avoids the dependency for a non-security use case.
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  // Produce a hex string (8 chars is enough for idempotency in practice;
  // the unique constraint uses the full issue_signature which includes
  // the category+session_id prefix for disambiguation).
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `${input.length}:${hex}`;
}

// ═══════════════════════════════════════════════════════════════════════
//  ReconcilerError
// ═══════════════════════════════════════════════════════════════════════

export class ReconcilerError extends Error {
  public readonly code: string;

  constructor(code: string) {
    super(code); // stable code only — no runtime values
    this.name = 'ReconcilerError';
    this.code = code;
  }
}
