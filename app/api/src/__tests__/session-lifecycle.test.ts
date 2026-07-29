import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionStatus, TerminalReason } from '../lib/session-lifecycle.js';
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATES,
  VALID_REASONS_FOR_STATUS,
  isValidTransition,
  createSession,
  transitionSession,
  ERR_INVALID_REASON,
  ERR_INVALID_TRANSITION,
  ERR_DB_FAILED,
} from '../lib/session-lifecycle.js';

// ── Supabase mock ────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

/** Chainable Supabase query-builder mock that resolves to `value`. */
function chain(value: unknown) {
  const c: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'eq', 'single', 'maybeSingle', 'order', 'limit'];
  for (const m of methods) {
    c[m] = (..._args: unknown[]) => chain(value);
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';
const FIXED_TS = '2026-01-01T00:00:00.000Z';
const fixedNow = () => FIXED_TS;

const baseSessionRow = {
  id: SESSION_ID,
  candidate_id: CANDIDATE_ID,
  role_id: null,
  status: 'created' as SessionStatus,
  terminal_reason: null,
  started_at: '2026-01-01T00:00:00Z',
  ended_at: null,
  waiting_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. State-machine definitions ─────────────────────────────────────

describe('ALLOWED_TRANSITIONS', () => {
  const NON_TERMINAL: SessionStatus[] = ['created', 'waiting', 'in_progress'];
  const TERMINAL: SessionStatus[] = ['completed', 'failed', 'cancelled', 'expired'];

  it('terminal states have no allowed next states', () => {
    for (const s of TERMINAL) {
      expect(ALLOWED_TRANSITIONS[s]).toHaveLength(0);
    }
  });

  it('non-terminal states have at least one allowed next state', () => {
    for (const s of NON_TERMINAL) {
      expect(ALLOWED_TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });

  it('created can reach waiting, in_progress, cancelled, failed', () => {
    expect(ALLOWED_TRANSITIONS.created).toContain('waiting');
    expect(ALLOWED_TRANSITIONS.created).toContain('in_progress');
    expect(ALLOWED_TRANSITIONS.created).toContain('cancelled');
    expect(ALLOWED_TRANSITIONS.created).toContain('failed');
  });

  it('waiting can reach in_progress, failed, cancelled, expired', () => {
    expect(ALLOWED_TRANSITIONS.waiting).toContain('in_progress');
    expect(ALLOWED_TRANSITIONS.waiting).toContain('failed');
    expect(ALLOWED_TRANSITIONS.waiting).toContain('cancelled');
    expect(ALLOWED_TRANSITIONS.waiting).toContain('expired');
  });

  it('in_progress can reach all terminal states', () => {
    for (const t of ['completed', 'failed', 'cancelled', 'expired'] as SessionStatus[]) {
      expect(ALLOWED_TRANSITIONS.in_progress).toContain(t);
    }
  });

  it('TERMINAL_STATES contains exactly the four terminal states', () => {
    expect(TERMINAL_STATES.size).toBe(4);
    for (const s of ['completed', 'failed', 'cancelled', 'expired'] as SessionStatus[]) {
      expect(TERMINAL_STATES.has(s)).toBe(true);
    }
  });
});

describe('isValidTransition — all 49 pairs', () => {
  const ALL: SessionStatus[] = [
    'created', 'waiting', 'in_progress', 'completed', 'failed', 'cancelled', 'expired',
  ];

  it('returns true for every entry in ALLOWED_TRANSITIONS', () => {
    for (const [from, nexts] of Object.entries(ALLOWED_TRANSITIONS) as [
      SessionStatus,
      readonly SessionStatus[],
    ][]) {
      for (const to of nexts) {
        expect(isValidTransition(from, to)).toBe(true);
      }
    }
  });

  it('returns false for all invalid pairs (7×7 minus valid entries)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = (ALLOWED_TRANSITIONS[from] as string[]).includes(to);
        expect(isValidTransition(from, to)).toBe(expected);
      }
    }
  });

  it('returns false for same-state transitions', () => {
    for (const s of ALL) {
      expect(isValidTransition(s, s)).toBe(false);
    }
  });

  it('terminal → non-terminal is always false', () => {
    const TERM: SessionStatus[] = ['completed', 'failed', 'cancelled', 'expired'];
    const NONT: SessionStatus[] = ['created', 'waiting', 'in_progress'];
    for (const t of TERM) {
      for (const n of NONT) {
        expect(isValidTransition(t, n)).toBe(false);
      }
    }
  });
});

describe('VALID_REASONS_FOR_STATUS', () => {
  it('completed requires conversation_complete or assessment_done (no null)', () => {
    const v = VALID_REASONS_FOR_STATUS.completed!;
    expect(v.has('conversation_complete')).toBe(true);
    expect(v.has('assessment_done')).toBe(true);
    expect(v.has(null as unknown as TerminalReason)).toBe(false);
    expect(v.has('room_create_error' as TerminalReason)).toBe(false);
    expect(v.has('worker_crash' as TerminalReason)).toBe(false);
    expect(v.has('recruiter_cancelled' as TerminalReason)).toBe(false);
  });

  it('failed only allows failed-family codes (no null)', () => {
    const v = VALID_REASONS_FOR_STATUS.failed!;
    expect(v.has(null as unknown as TerminalReason)).toBe(false);
    for (const r of [
      'room_create_error', 'worker_crash', 'provider_error',
      'assessment_error', 'shutdown_forced', 'drain_timeout',
    ] as TerminalReason[]) {
      expect(v.has(r)).toBe(true);
    }
    expect(v.has('assessment_done' as TerminalReason)).toBe(false);
    expect(v.has('recruiter_cancelled' as TerminalReason)).toBe(false);
    expect(v.has('idle_timeout' as TerminalReason)).toBe(false);
  });

  it('cancelled only allows cancelled-family codes (no null)', () => {
    const v = VALID_REASONS_FOR_STATUS.cancelled!;
    expect(v.has(null as unknown as TerminalReason)).toBe(false);
    for (const r of [
      'recruiter_cancelled', 'migrated_abandoned', 'duplicate_session', 'shutdown_drain',
    ] as TerminalReason[]) {
      expect(v.has(r)).toBe(true);
    }
    expect(v.has('assessment_done' as TerminalReason)).toBe(false);
    expect(v.has('room_create_error' as TerminalReason)).toBe(false);
  });

  it('expired only allows expiry codes (no null)', () => {
    const v = VALID_REASONS_FOR_STATUS.expired!;
    expect(v.has(null as unknown as TerminalReason)).toBe(false);
    expect(v.has('idle_timeout')).toBe(true);
    expect(v.has('grace_timeout')).toBe(true);
    expect(v.has('assessment_done' as TerminalReason)).toBe(false);
  });
});

// ── 2. createSession ─────────────────────────────────────────────────

describe('createSession', () => {
  it('inserts a row with status=created and returns it', async () => {
    mockFrom.mockReturnValue(chain({ data: baseSessionRow, error: null }));

    const result = await createSession({
      candidate_id: CANDIDATE_ID,
      role_id: null,
      mode: 'simulation',
    });

    expect(result.error).toBeNull();
    expect(result.data?.status).toBe('created');
    expect(result.data?.id).toBe(SESSION_ID);
  });

  it('returns sanitized error when supabase insert fails', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: { message: 'insert failed' } }));

    const result = await createSession({
      candidate_id: CANDIDATE_ID,
      role_id: null,
      mode: 'simulation',
    });

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    // Message is sanitized — does not expose raw DB internals
    expect(result.error!.message).toBe('ERR_INSERT_FAILED');
  });
});

// ── 3. transitionSession — preflight validation ──────────────────────

describe('transitionSession — preflight', () => {
  it('rejects invalid transition without hitting DB', async () => {
    const result = await transitionSession(SESSION_ID, 'created', 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(false);
      expect(result.code).toBe(ERR_INVALID_TRANSITION);
    }
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects terminal → non-terminal without hitting DB', async () => {
    const result = await transitionSession(SESSION_ID, 'completed', 'in_progress');
    expect(result.ok).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects cross-state reason (completed + failed reason)', async () => {
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'room_create_error',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(false);
      expect(result.code).toBe(ERR_INVALID_REASON);
    }
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects reason on non-terminal target', async () => {
    const result = await transitionSession(
      SESSION_ID, 'created', 'in_progress', 'room_create_error',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ERR_REASON_ON_NON_TERMINAL');
    }
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects missing reason for terminal target', async () => {
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ERR_INVALID_REASON);
    }
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('accepts valid reason for completed', async () => {
    mockFrom.mockReturnValue(chain({ data: [{ id: SESSION_ID }], error: null }));
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'assessment_done', undefined, fixedNow,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts conversation_complete reason for completed', async () => {
    mockFrom.mockReturnValue(chain({ data: [{ id: SESSION_ID }], error: null }));
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'conversation_complete', undefined, fixedNow,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts valid reason for failed', async () => {
    mockFrom.mockReturnValue(chain({ data: [{ id: SESSION_ID }], error: null }));
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'failed', 'worker_crash', undefined, fixedNow,
    );
    expect(result.ok).toBe(true);
  });
});

// ── 4. transitionSession — CAS behavior ─────────────────────────────

describe('transitionSession — CAS', () => {
  it('returns ok:true when update affects exactly 1 row', async () => {
    mockFrom.mockReturnValue(chain({ data: [{ id: SESSION_ID }], error: null }));
    const result = await transitionSession(
      SESSION_ID, 'created', 'in_progress',
    );
    expect(result.ok).toBe(true);
  });

  it('returns conflict when update affects 0 rows (status mismatch)', async () => {
    mockFrom.mockReturnValue(chain({ data: [], error: null }));
    const result = await transitionSession(
      SESSION_ID, 'created', 'in_progress',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
  });

  it('returns conflict when data is null', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: null }));
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'assessment_done',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
  });

  it('returns conflict when data is multi-row (corrupt response)', async () => {
    mockFrom.mockReturnValue(
      chain({ data: [{ id: SESSION_ID }, { id: 'other' }], error: null }),
    );
    const result = await transitionSession(
      SESSION_ID, 'created', 'in_progress',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
  });

  it('returns sanitized dbError when supabase returns an error', async () => {
    mockFrom.mockReturnValue(
      chain({ data: null, error: { message: 'constraint violation P0001 session abc-123' } }),
    );
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'assessment_done',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(false);
      // Sanitized — raw DB message is NOT forwarded
      expect(result.code).toBe(ERR_DB_FAILED);
    }
  });

  it('uses injected now() for ended_at and waiting_at timestamps', async () => {
    let capturedUpdates: Record<string, unknown> | undefined;
    mockFrom.mockImplementation(() => {
      const q: Record<string, unknown> = {};
      q.update = (data: Record<string, unknown>) => {
        capturedUpdates = data;
        return chain({ data: [{ id: SESSION_ID }], error: null });
      };
      q.select = () => chain({ data: [{ id: SESSION_ID }], error: null });
      q.eq = () => q;
      q.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: SESSION_ID }], error: null }).then(r);
      q.catch = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).catch(r);
      return q;
    });

    await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'assessment_done', undefined, fixedNow,
    );
    expect(capturedUpdates?.ended_at).toBe(FIXED_TS);

    await transitionSession(
      SESSION_ID, 'created', 'waiting', undefined, undefined, fixedNow,
    );
    expect(capturedUpdates?.waiting_at).toBe(FIXED_TS);
  });

  it('includes terminal_reason in the update payload', async () => {
    let capturedUpdates: Record<string, unknown> | undefined;
    mockFrom.mockImplementation(() => {
      const q: Record<string, unknown> = {};
      q.update = (data: Record<string, unknown>) => {
        capturedUpdates = data;
        return chain({ data: [{ id: SESSION_ID }], error: null });
      };
      q.select = () => chain({ data: [{ id: SESSION_ID }], error: null });
      q.eq = () => q;
      q.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: SESSION_ID }], error: null }).then(r);
      q.catch = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).catch(r);
      return q;
    });

    await transitionSession(
      SESSION_ID, 'created', 'failed', 'room_create_error', undefined, fixedNow,
    );
    expect(capturedUpdates?.terminal_reason).toBe('room_create_error');
    expect(capturedUpdates?.status).toBe('failed');
  });

  it('does not include extra fields not in TransitionExtra', async () => {
    let capturedUpdates: Record<string, unknown> | undefined;
    mockFrom.mockImplementation(() => {
      const q: Record<string, unknown> = {};
      q.update = (data: Record<string, unknown>) => {
        capturedUpdates = data;
        return chain({ data: [{ id: SESSION_ID }], error: null });
      };
      q.select = () => chain({ data: [{ id: SESSION_ID }], error: null });
      q.eq = () => q;
      q.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: SESSION_ID }], error: null }).then(r);
      q.catch = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).catch(r);
      return q;
    });

    await transitionSession(
      SESSION_ID, 'created', 'waiting', undefined,
      { external_call_id: 'room-abc' },
      fixedNow,
    );
    expect(capturedUpdates?.external_call_id).toBe('room-abc');
    expect(capturedUpdates?.status).toBe('waiting');
    expect(capturedUpdates?.id).toBeUndefined();
  });
});

// ── 5. Terminal immutability ─────────────────────────────────────────

describe('terminal state immutability (application layer)', () => {
  it('preflight rejects terminal → non-terminal before DB is called', async () => {
    const result = await transitionSession(SESSION_ID, 'completed', 'in_progress');
    expect(result.ok).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('DB constraint violation returned as sanitized error code', async () => {
    mockFrom.mockReturnValue(
      chain({ data: null, error: { message: 'P0001: terminal state' } }),
    );
    const result = await transitionSession(
      SESSION_ID, 'in_progress', 'completed', 'assessment_done',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(false);
      expect(result.code).toBe(ERR_DB_FAILED);
    }
  });
});

// ── 6. Concurrent CAS — stateful fake ────────────────────────────────

describe('concurrent transitionSession — stateful CAS fake', () => {
  function makeStatefulStore(initialStatus: SessionStatus) {
    let currentStatus = initialStatus;

    return function fromFake(table: string) {
      const q: Record<string, unknown> = {};
      let updatePayload: Record<string, unknown> = {};
      let predicateStatus: string | null = null;

      q.update = (data: Record<string, unknown>) => {
        updatePayload = data;
        return q;
      };
      q.eq = (col: string, val: unknown) => {
        if (col === 'status') predicateStatus = val as string;
        return q;
      };
      q.select = (_cols?: string) => q;
      q.then = (resolve: (v: unknown) => unknown) => {
        if (predicateStatus !== null && currentStatus === predicateStatus) {
          const newStatus = updatePayload.status as SessionStatus;
          currentStatus = newStatus;
          return Promise.resolve({ data: [{ id: SESSION_ID }], error: null }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      };
      q.catch = (r: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).catch(r);
      return q;
    };
  }

  it('exactly one caller wins when two concurrent CAS race on same session', async () => {
    const fromFake = makeStatefulStore('created');
    mockFrom.mockImplementation(fromFake);

    const [r1, r2] = await Promise.all([
      transitionSession(SESSION_ID, 'created', 'in_progress'),
      transitionSession(SESSION_ID, 'created', 'in_progress'),
    ]);

    const wins = [r1, r2].filter((r) => r.ok);
    const conflicts = [r1, r2].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    if (!conflicts[0]!.ok) expect(conflicts[0]!.conflict).toBe(true);
  });

  it('second call to same transition is a stable conflict, not success', async () => {
    const fromFake = makeStatefulStore('created');
    mockFrom.mockImplementation(fromFake);

    const r1 = await transitionSession(SESSION_ID, 'created', 'in_progress');
    expect(r1.ok).toBe(true);

    const r2 = await transitionSession(SESSION_ID, 'created', 'in_progress');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.conflict).toBe(true);
  });
});
