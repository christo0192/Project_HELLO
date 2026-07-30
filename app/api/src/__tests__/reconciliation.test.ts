/**
 * REL-09 — Reconciliation & Fallback tests.
 *
 * Verified:
 *   - reconcile() runs all detectors and returns a report
 *   - stuck sessions (waiting/created/in_progress past timeout) detected
 *   - orphan rooms detected
 *   - transcript gaps detected
 *   - missing recordings detected
 *   - overdue scorecards detected
 *   - planRepair() returns appropriate repair actions per category
 *   - executeRepair() is idempotent (CAS conflicts → noop)
 *   - quarantine is idempotent (unique session_id → noop on re-insert)
 *   - ReconciliationReport summary matches detected issues
 *   - Seeded inconsistencies are detected; repair is idempotent and audited
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

vi.mock('../lib/correlation.js', () => ({
  getCorrelationId: () => '00000000-0000-4000-8000-000000000000',
}));

// ── Chainable thenable mock ──────────────────────────────────────────

/** Build a chainable thenable that resolves to `value`. */
function chain(value: unknown) {
  const c: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
    'in', 'is', 'not', 'or', 'and',
    'single', 'maybeSingle',
    'order', 'limit', 'range', 'offset',
    'textSearch', 'match', 'filter',
  ];
  for (const m of methods) {
    c[m] = (..._args: unknown[]) => chain(value);
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (_reject: (e: unknown) => unknown) => Promise.resolve(value);
  return c;
}

// ── Shared test data ─────────────────────────────────────────────────

const SESSION_ID_1 = '00000000-0000-4000-8000-000000000001';
const SESSION_ID_2 = '00000000-0000-4000-8000-000000000002';
const SESSION_ID_3 = '00000000-0000-4000-8000-000000000003';
const CANDIDATE_ID_1 = '00000000-0000-4000-8000-000000000010';
const CANDIDATE_ID_2 = '00000000-0000-4000-8000-000000000011';

const RUN_ID = '00000000-0000-4000-8000-0000000000ff';

// ── Module under test ────────────────────────────────────────────────

import type {
  ReconciliationIssue,
  IssueCategory,
  RepairAction,
  Severity,
} from '../lib/reconciliation.js';

let reconciliation: typeof import('../lib/reconciliation.js');

beforeEach(async () => {
  vi.clearAllMocks();
  reconciliation = await import('../lib/reconciliation.js');
});

// ═══════════════════════════════════════════════════════════════════════
//  reconcile() — full scan
// ═══════════════════════════════════════════════════════════════════════

describe('reconcile() — full scan', () => {
  it('returns an empty report when no issues exist', async () => {
    // All detectors return empty.
    mockRpc.mockReturnValue(chain({ data: [], error: null }));
    mockFrom.mockReturnValue(chain({ data: [], error: null }));

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.runId).toBe(RUN_ID);
    expect(report.total).toBe(0);
    expect(report.summary.stuck_session).toBe(0);
    expect(report.summary.orphan_room).toBe(0);
    expect(report.summary.transcript_gap).toBe(0);
    expect(report.summary.missing_recording).toBe(0);
    expect(report.summary.overdue_scorecard).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  it('generates a runId when none provided', async () => {
    mockRpc.mockReturnValue(chain({ data: [], error: null }));
    mockFrom.mockReturnValue(chain({ data: [], error: null }));

    const report = await reconciliation.reconcile();

    expect(report.runId).toBeDefined();
    expect(report.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('detects stuck sessions from stuck_sessions() RPC', async () => {
    // Mock stuck_sessions RPC to return issues.
    const stuckRows = [
      {
        session_id: SESSION_ID_1,
        status: 'waiting',
        state_duration_sec: 400,
        candidate_id: CANDIDATE_ID_1,
        reason_hint: 'stuck_in_waiting',
      },
      {
        session_id: SESSION_ID_2,
        status: 'created',
        state_duration_sec: 2000,
        candidate_id: CANDIDATE_ID_2,
        reason_hint: 'stuck_in_created',
      },
    ];

    // First call: stuck_sessions rpc
    // Second call: sessions_without_transcripts rpc
    // Third call: sessions_missing_recording rpc
    // Fourth call: missing_assessment_sessions rpc
    mockRpc
      .mockReturnValueOnce(chain({ data: stuckRows, error: null }))    // stuck_sessions
      .mockReturnValueOnce(chain({ data: [], error: null }))           // sessions_without_transcripts
      .mockReturnValueOnce(chain({ data: [], error: null }))           // sessions_missing_recording
      .mockReturnValueOnce(chain({ data: [], error: null }));          // missing_assessment_sessions

    // Mock the .from('call_sessions') for orphan rooms (returns empty)
    // and the reconciliation_log insert.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        return chain({ data: [], error: null }); // orphan rooms empty
      }
      if (table === 'reconciliation_log') {
        return chain({ data: [{ id: 'log-1' }, { id: 'log-2' }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.total).toBe(2);
    expect(report.summary.stuck_session).toBe(2);
    expect(report.summary.orphan_room).toBe(0);
    expect(report.issues[0].category).toBe('stuck_session');
    expect(report.issues[0].sessionId).toBe(SESSION_ID_1);
    expect(report.issues[0].runId).toBe(RUN_ID);
    expect(report.issues[1].category).toBe('stuck_session');
    expect(report.issues[1].sessionId).toBe(SESSION_ID_2);
  });

  it('detects orphan rooms from call_sessions query', async () => {
    // All RPCs return empty.
    mockRpc
      .mockReturnValueOnce(chain({ data: [], error: null }))    // stuck_sessions
      .mockReturnValueOnce(chain({ data: [], error: null }))   // sessions_without_transcripts
      .mockReturnValueOnce(chain({ data: [], error: null }))   // sessions_missing_recording
      .mockReturnValueOnce(chain({ data: [], error: null }));  // missing_assessment_sessions

    const orphanRows = [
      {
        id: SESSION_ID_1,
        candidate_id: CANDIDATE_ID_1,
        waiting_at: new Date(Date.now() - 600_000).toISOString(),
        created_at: new Date(Date.now() - 3600_000).toISOString(),
      },
    ];

    // reconciliation_log insert returns success.
    let orphanCalled = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        if (!orphanCalled) {
          orphanCalled = true;
          return chain({ data: orphanRows, error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === 'reconciliation_log') {
        return chain({ data: [{ id: 'log-1' }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.total).toBe(1);
    expect(report.summary.orphan_room).toBe(1);
    expect(report.issues[0].category).toBe('orphan_room');
    expect(report.issues[0].sessionId).toBe(SESSION_ID_1);
  });

  it('detects transcript gaps', async () => {
    mockRpc
      .mockReturnValueOnce(chain({ data: [], error: null }))   // stuck_sessions
      .mockReturnValueOnce(chain({                                // sessions_without_transcripts
        data: [
          { session_id: SESSION_ID_1, candidate_id: CANDIDATE_ID_1, ended_at: '2026-07-30T12:00:00Z', status: 'completed' },
        ],
        error: null,
      }))
      .mockReturnValueOnce(chain({ data: [], error: null }))   // sessions_missing_recording
      .mockReturnValueOnce(chain({ data: [], error: null }));  // missing_assessment_sessions

    // Orphan rooms empty, log insert succeeds.
    let orphanCalled = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        if (!orphanCalled) {
          orphanCalled = true;
          return chain({ data: [], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === 'reconciliation_log') {
        return chain({ data: [{ id: 'log-1' }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.total).toBe(1);
    expect(report.summary.transcript_gap).toBe(1);
    expect(report.issues[0].category).toBe('transcript_gap');
    expect(report.issues[0].sessionId).toBe(SESSION_ID_1);
    expect(report.issues[0].severity).toBe('critical');
  });

  it('detects missing recordings', async () => {
    mockRpc
      .mockReturnValueOnce(chain({ data: [], error: null }))   // stuck_sessions
      .mockReturnValueOnce(chain({ data: [], error: null }))   // sessions_without_transcripts
      .mockReturnValueOnce(chain({                                // sessions_missing_recording
        data: [
          { session_id: SESSION_ID_1, candidate_id: CANDIDATE_ID_1, ended_at: '2026-07-30T12:00:00Z', status: 'completed' },
        ],
        error: null,
      }))
      .mockReturnValueOnce(chain({ data: [], error: null }));  // missing_assessment_sessions

    let orphanCalled = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        if (!orphanCalled) {
          orphanCalled = true;
          return chain({ data: [], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === 'reconciliation_log') {
        return chain({ data: [{ id: 'log-1' }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.total).toBe(1);
    expect(report.summary.missing_recording).toBe(1);
    expect(report.issues[0].category).toBe('missing_recording');
  });

  it('detects overdue scorecards', async () => {
    mockRpc
      .mockReturnValueOnce(chain({ data: [], error: null }))   // stuck_sessions
      .mockReturnValueOnce(chain({ data: [], error: null }))   // sessions_without_transcripts
      .mockReturnValueOnce(chain({ data: [], error: null }))   // sessions_missing_recording
      .mockReturnValueOnce(chain({                                // missing_assessment_sessions
        data: [
          { session_id: SESSION_ID_1, candidate_id: CANDIDATE_ID_1, completed_at: '2026-07-30T12:00:00Z', status: 'completed' },
        ],
        error: null,
      }));

    let orphanCalled = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        if (!orphanCalled) {
          orphanCalled = true;
          return chain({ data: [], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === 'reconciliation_log') {
        return chain({ data: [{ id: 'log-1' }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.total).toBe(1);
    expect(report.summary.overdue_scorecard).toBe(1);
    expect(report.issues[0].category).toBe('overdue_scorecard');
  });

  it('handles a mix of all five categories', async () => {
    mockRpc
      .mockReturnValueOnce(chain({                               // stuck_sessions
        data: [
          { session_id: SESSION_ID_1, status: 'waiting', state_duration_sec: 400, candidate_id: CANDIDATE_ID_1, reason_hint: 'stuck_in_waiting' },
        ],
        error: null,
      }))
      .mockReturnValueOnce(chain({                               // sessions_without_transcripts
        data: [
          { session_id: SESSION_ID_2, candidate_id: CANDIDATE_ID_2, ended_at: '2026-07-30T12:00:00Z', status: 'failed' },
        ],
        error: null,
      }))
      .mockReturnValueOnce(chain({                               // sessions_missing_recording
        data: [], error: null,
      }))
      .mockReturnValueOnce(chain({                               // missing_assessment_sessions
        data: [
          { session_id: SESSION_ID_3, candidate_id: CANDIDATE_ID_1, completed_at: '2026-07-30T12:00:00Z', status: 'completed' },
        ],
        error: null,
      }));

    let orphanCallIndex = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        if (orphanCallIndex === 0) {
          orphanCallIndex++;
          return chain({ data: [], error: null }); // orphan rooms empty on first call
        }
        return chain({ data: [], error: null });
      }
      if (table === 'reconciliation_log') {
        return chain({ data: [{ id: 'log-1' }, { id: 'log-2' }, { id: 'log-3' }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);

    expect(report.total).toBe(3);
    expect(report.summary.stuck_session).toBe(1);
    expect(report.summary.transcript_gap).toBe(1);
    expect(report.summary.missing_recording).toBe(0);
    expect(report.summary.overdue_scorecard).toBe(1);
    expect(report.summary.orphan_room).toBe(0);
    expect(report.detectedAt).toBeDefined();
  });

  it('continues when one detector fails', async () => {
    // First RPC (stuck_sessions) fails.
    mockRpc
      .mockReturnValueOnce(chain({ data: null, error: new Error('DB error') }))
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: [], error: null }));

    mockFrom.mockReturnValue(chain({ data: [], error: null }));

    const report = await reconciliation.reconcile(RUN_ID);

    // Should still return a report with 0 issues (remaining detectors worked).
    expect(report.total).toBe(0);
    expect(report.runId).toBe(RUN_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  planRepair()
// ═══════════════════════════════════════════════════════════════════════

describe('planRepair()', () => {
  function makeIssue(
    category: IssueCategory,
    status: string,
    sId = SESSION_ID_1,
  ): ReconciliationIssue {
    return {
      runId: RUN_ID,
      category,
      severity: 'error',
      sessionId: sId,
      candidateId: CANDIDATE_ID_1,
      signature: `test:${category}:${sId}`,
      description: `Test ${category} for ${sId}`,
      details: { currentStatus: status },
    };
  }

  it('plans transition_to_expired for stuck_session', () => {
    const issue = makeIssue('stuck_session', 'waiting');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('transition_to_expired');
    expect(plan.reason).toContain('idle_timeout');
  });

  it('plans transition_to_expired for orphan_room', () => {
    const issue = makeIssue('orphan_room', 'waiting');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('transition_to_expired');
  });

  it('plans noop for transcript_gap with failed status', () => {
    const issue = makeIssue('transcript_gap', 'failed');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('noop');
  });

  it('plans quarantine for transcript_gap with completed status', () => {
    const issue = makeIssue('transcript_gap', 'completed');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('quarantine_session');
  });

  it('plans quarantine for missing_recording', () => {
    const issue = makeIssue('missing_recording', 'completed');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('quarantine_session');
  });

  it('plans quarantine for overdue_scorecard', () => {
    const issue = makeIssue('overdue_scorecard', 'completed');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('quarantine_session');
  });

  it('plans noop for unknown category', () => {
    const issue = makeIssue('stuck_session' as any, 'created');
    // Override category to simulate unknown
    (issue as any).category = 'unknown_category';
    const plan = reconciliation.planRepair(issue as any);
    expect(plan.action).toBe('noop');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  executeRepair()
// ═══════════════════════════════════════════════════════════════════════

describe('executeRepair()', () => {
  function makeIssue(
    category: IssueCategory,
    status: string,
    sId = SESSION_ID_1,
  ): ReconciliationIssue {
    return {
      runId: RUN_ID,
      category,
      severity: 'error',
      sessionId: sId,
      candidateId: CANDIDATE_ID_1,
      signature: `test:${category}:${sId}`,
      description: `Test ${category} for ${sId}`,
      details: { currentStatus: status },
    };
  }

  it('executes transition_to_expired via injected transitionSessionFn', async () => {
    const issue = makeIssue('stuck_session', 'waiting');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('transition_to_expired');

    // Mock transitionSessionFn that returns success.
    const transitionSessionFn = vi.fn().mockResolvedValue({ ok: true });
    // Mock markIssueRepaired: the function internally calls supabase.from('reconciliation_log').update
    mockFrom.mockReturnValue(chain({ data: null, error: null }));

    const result = await reconciliation.executeRepair(plan, transitionSessionFn);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('transition_to_expired');
    expect(result.sessionId).toBe(SESSION_ID_1);
    expect(transitionSessionFn).toHaveBeenCalledWith(
      SESSION_ID_1,
      'waiting',
      'expired',
      'idle_timeout',
    );
  });

  it('handles CAS conflict gracefully (idempotent)', async () => {
    const issue = makeIssue('stuck_session', 'waiting');
    const plan = reconciliation.planRepair(issue);

    // CAS conflict — session already transitioned.
    const transitionSessionFn = vi.fn().mockResolvedValue({ ok: false, conflict: true });

    // markIssueRepaired calls supabase.from('reconciliation_log').update
    mockFrom.mockReturnValue(chain({ data: null, error: null }));

    const result = await reconciliation.executeRepair(plan, transitionSessionFn);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('noop'); // Falls back to noop on conflict
  });

  it('returns error when transitionSessionFn fails', async () => {
    const issue = makeIssue('stuck_session', 'waiting');
    const plan = reconciliation.planRepair(issue);

    const transitionSessionFn = vi.fn().mockResolvedValue({ ok: false, conflict: false, code: 'ERR_DB_FAILED' });

    mockFrom.mockReturnValue(chain({ data: null, error: null }));

    const result = await reconciliation.executeRepair(plan, transitionSessionFn);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERR_DB_FAILED');
  });

  it('executes quarantine and logs it', async () => {
    const issue = makeIssue('missing_recording', 'completed');
    const plan = reconciliation.planRepair(issue);
    expect(plan.action).toBe('quarantine_session');

    // Mock: no existing quarantine (maybeSingle returns null), insert succeeds.
    let callIndex = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quarantined_sessions' && callIndex === 0) {
        callIndex++;
        return chain({ data: null, error: null }); // maybeSingle returns null
      }
      if (table === 'quarantined_sessions' && callIndex === 1) {
        callIndex++;
        return chain({ data: null, error: null }); // insert succeeds
      }
      if (table === 'reconciliation_log') {
        return chain({ data: null, error: null }); // update succeeds
      }
      return chain({ data: null, error: null });
    });

    const result = await reconciliation.executeRepair(plan);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('quarantine_session');
    expect(result.quarantined).toBe(true);
  });

  it('quarantine is idempotent on re-insert', async () => {
    const issue = makeIssue('missing_recording', 'completed');
    const plan = reconciliation.planRepair(issue);

    // Mock: existing quarantine found.
    let callIndex = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quarantined_sessions' && callIndex === 0) {
        callIndex++;
        return chain({ data: { id: 'existing-quarantine' }, error: null }); // already quarantined
      }
      if (table === 'reconciliation_log') {
        return chain({ data: null, error: null }); // update for markIssueRepaired
      }
      return chain({ data: null, error: null });
    });

    const result = await reconciliation.executeRepair(plan);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('noop'); // Falls back to noop since already quarantined
    expect(result.quarantined).toBe(true);
  });

  it('returns error for repair with no sessionId', async () => {
    const issue = makeIssue('stuck_session', 'waiting');
    issue.sessionId = null;
    const plan = reconciliation.planRepair(issue);

    const result = await reconciliation.executeRepair(plan);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERR_NO_SESSION_ID');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  getQuarantineStatus()
// ═══════════════════════════════════════════════════════════════════════

describe('getQuarantineStatus()', () => {
  it('returns false for invalid session ID', async () => {
    const result = await reconciliation.getQuarantineStatus('not-a-uuid');
    expect(result.quarantined).toBe(false);
  });

  it('returns false when no quarantine record exists', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: null }));

    const result = await reconciliation.getQuarantineStatus(SESSION_ID_1);
    expect(result.quarantined).toBe(false);
  });

  it('returns true with record when quarantine exists', async () => {
    const quarantineRecord = {
      id: 'q-1',
      session_id: SESSION_ID_1,
      reason: 'test quarantine',
      resolved: false,
    };

    mockFrom.mockReturnValue(chain({ data: quarantineRecord, error: null }));

    const result = await reconciliation.getQuarantineStatus(SESSION_ID_1);
    expect(result.quarantined).toBe(true);
    expect(result.record).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  getReconciliationLog()
// ═══════════════════════════════════════════════════════════════════════

describe('getReconciliationLog()', () => {
  it('returns empty array on error', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: new Error('DB error') }));

    const logs = await reconciliation.getReconciliationLog();
    expect(logs).toHaveLength(0);
  });

  it('returns log entries', async () => {
    const logEntries = [
      { id: 'log-1', issue_category: 'stuck_session', session_id: SESSION_ID_1 },
      { id: 'log-2', issue_category: 'orphan_room', session_id: SESSION_ID_2 },
    ];

    mockFrom.mockReturnValue(chain({ data: logEntries, error: null }));

    const logs = await reconciliation.getReconciliationLog();
    expect(logs).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  ReconcilerError
// ═══════════════════════════════════════════════════════════════════════

describe('ReconcilerError', () => {
  it('has stable code and no runtime values', () => {
    const err = new reconciliation.ReconcilerError('ERR_RUN_ID_FORMAT');
    expect(err.name).toBe('ReconcilerError');
    expect(err.code).toBe('ERR_RUN_ID_FORMAT');
    expect(err.message).toBe('ERR_RUN_ID_FORMAT');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Seeded inconsistency negative tests
// ═══════════════════════════════════════════════════════════════════════

describe('Negative: seeded inconsistencies detected; repair is idempotent and audited', () => {
  it('stuck sessions are detected with severity error or warning', async () => {
    const stuckRows = [
      {
        session_id: SESSION_ID_1,
        status: 'waiting',
        state_duration_sec: 400,
        candidate_id: CANDIDATE_ID_1,
        reason_hint: 'stuck_in_waiting',
      },
      {
        session_id: SESSION_ID_2,
        status: 'in_progress',
        state_duration_sec: 8000,
        candidate_id: CANDIDATE_ID_2,
        reason_hint: 'stuck_in_progress',
      },
    ];

    mockRpc
      .mockReturnValueOnce(chain({ data: stuckRows, error: null }))
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: [], error: null }));

    mockFrom.mockImplementation((table: string) => {
      if (table === 'call_sessions') return chain({ data: [], error: null });
      if (table === 'reconciliation_log') return chain({ data: [{ id: 'log-1' }, { id: 'log-2' }], error: null });
      return chain({ data: [], error: null });
    });

    const report = await reconciliation.reconcile(RUN_ID);
    expect(report.total).toBe(2);

    // stuck_in_waiting → error severity
    expect(report.issues[0].severity).toBe('error');
    // stuck_in_progress → warning severity
    expect(report.issues[1].severity).toBe('warning');
  });

  it('transcript_gap in completed gets quarantine; in failed gets noop', async () => {
    // Test planRepair directly for both sub-cases.
    const completedIssue: ReconciliationIssue = {
      runId: RUN_ID,
      category: 'transcript_gap',
      severity: 'critical',
      sessionId: SESSION_ID_1,
      candidateId: CANDIDATE_ID_1,
      signature: 'test:transcript_gap:completed',
      description: 'Test',
      details: { currentStatus: 'completed' },
    };

    const failedIssue: ReconciliationIssue = {
      runId: RUN_ID,
      category: 'transcript_gap',
      severity: 'warning',
      sessionId: SESSION_ID_2,
      candidateId: CANDIDATE_ID_2,
      signature: 'test:transcript_gap:failed',
      description: 'Test',
      details: { currentStatus: 'failed' },
    };

    expect(reconciliation.planRepair(completedIssue).action).toBe('quarantine_session');
    expect(reconciliation.planRepair(failedIssue).action).toBe('noop');
  });

  it('repair is audited in reconciliation_log', async () => {
    const issue: ReconciliationIssue = {
      runId: RUN_ID,
      category: 'stuck_session',
      severity: 'error',
      sessionId: SESSION_ID_1,
      candidateId: CANDIDATE_ID_1,
      signature: 'test:audit:stuck_session',
      description: 'Test audit',
      details: { currentStatus: 'waiting' },
    };

    const plan = reconciliation.planRepair(issue);
    const transitionSessionFn = vi.fn().mockResolvedValue({ ok: true });

    // Expect reconciliation_log.update to be called (markIssueRepaired).
    let updateCalled = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'reconciliation_log') {
        updateCalled = true;
        return chain({ data: null, error: null });
      }
      return chain({ data: null, error: null });
    });

    await reconciliation.executeRepair(plan, transitionSessionFn);
    expect(updateCalled).toBe(true);
  });
});
