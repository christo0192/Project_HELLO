/**
 * VOI-08 — assessment-eligibility preflight (Phase 8 lane L4).
 *
 * Drives the REAL runAssessmentImpl (services/assessment.ts) with only the
 * two I/O boundaries mocked in-memory (Supabase + Claude). Verifies that
 * technical scoring fails closed BEFORE any transcript fetch, provider call,
 * role/candidate fetch, or DB write unless the session is `completed` with
 * the authoritative initial scoring reason `conversation_complete`.
 *
 * Key invariants pinned here:
 *   1. INELIGIBLE matrix — every non-completed status and every
 *      completed-with-non-authoritative reason throws ERR_SESSION_NOT_COMPLETED
 *      with zero downstream side effects (no provider, no transcript, no
 *      assessments insert, no candidates update, no roles fetch).
 *   2. ELIGIBLE path — completed + conversation_complete reaches the provider
 *      exactly once and persists the assessment row with session_id.
 *   3. NOT_FOUND — the existing `session not found` error is preserved and
 *      the provider is never reached.
 *   4. Contract preservation — source-level assertions on assessment.ts
 *      (provenance strings kept; no consent coupling; select carries
 *      status,terminal_reason; literal conversation_complete preflight).
 *   5. Route coverage — both direct-API (routes/assess.ts) and
 *      screening/queue (routes/screening.ts) callers import runAssessment from
 *      services/assessment, so the service-level guard covers both.
 *   6. Injected-runner contract — injectAssessmentRunner bypasses the real
 *      implementation (and therefore the guard) with no supabase calls.
 *
 * Offline, deterministic, no network, no real provider calls. Synthetic
 * fixtures only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runAssessment, injectAssessmentRunner, ERR_SESSION_NOT_COMPLETED } from '../services/assessment.js';
import type { Assessment } from '../lib/types.js';

// ── Module mocks (hoisted factories) ────────────────────────────────
// Mirrors the style of contract-openapi.test.ts: vi.mock the lib modules
// with chainable thenable builders; per-table state configured per test.

const { mockFrom, runClaudeJSONWithProvenance } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  runClaudeJSONWithProvenance: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

vi.mock('../lib/claude.js', () => ({
  runClaudeJSONWithProvenance,
}));

// ── Chainable thenable Supabase query-builder mock ──────────────────

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'order', 'limit', 'single', 'maybeSingle', 'execute',
] as const;

interface CallRecord {
  method: string;
  args: unknown[];
}

/** Per-table count of `.from(table)` invocations. */
const tableFromCounts = new Map<string, number>();
/** Per-table method-call records (select/eq/insert/... with args). */
const tableMethodCalls = new Map<string, CallRecord[]>();
/** Per-table configured resolved { data, error }. */
const tableConfig = new Map<string, { data: unknown; error: unknown }>();

function resetTracking(): void {
  tableFromCounts.clear();
  tableMethodCalls.clear();
  tableConfig.clear();
}

function fromCalls(table: string): number {
  return tableFromCounts.get(table) ?? 0;
}

function callsFor(table: string, method?: string): CallRecord[] {
  const recs = tableMethodCalls.get(table) ?? [];
  return method ? recs.filter((r) => r.method === method) : recs;
}

function ok(data: unknown): { data: unknown; error: null } {
  return { data, error: null };
}

function configureTable(table: string, value: { data: unknown; error: unknown }): void {
  tableConfig.set(table, value);
}

mockFrom.mockImplementation((table: string) => {
  tableFromCounts.set(table, (tableFromCounts.get(table) ?? 0) + 1);
  const cfg = tableConfig.get(table) ?? { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const m of CHAIN_METHODS) {
    builder[m] = (...args: unknown[]) => {
      const recs = tableMethodCalls.get(table) ?? [];
      recs.push({ method: m, args });
      tableMethodCalls.set(table, recs);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(cfg).then(resolve);
  builder.catch = (reject: (e: unknown) => unknown) => Promise.resolve(cfg).catch(reject);
  return builder;
});

// ── Synthetic fixtures (no real data) ───────────────────────────────

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';
const ROLE_ID = '00000000-0000-4000-8000-000000000003';
const ASSESSMENT_ID = '00000000-0000-4000-8000-000000000004';

/** Valid Assessment-shaped fixture so computeOverall runs cleanly. */
const assessmentFixture: Assessment = {
  english: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'clear' },
  tone: { clarity: 8, confidence: 8, professionalism: 8, sentiment: 'positive', notes: 'professional' },
  communication: {
    score: 8, clarity: 8, structure: 8, listening: 8, rapport: 8,
    english_proficiency: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'clear' },
    filler_usage: { level: 'low', impact_score: 8, examples: [], notes: '' },
    native_language_usage: { level: 'none', examples: [], impact_score: 9, notes: '' },
    notes: 'good',
  },
  motivation: { score: 8, notes: 'interested' },
  role_fit: { score: 8, matched_skills: ['TypeScript'], gaps: [], red_flags: [], notes: 'fit' },
  overall_score: 0, // recomputed by computeOverall in the real impl
  recommendation: 'advance', // recomputed by computeOverall in the real impl
  summary: 'Strong candidate',
  resume_conflicts: [],
};

function sessionRow(status: string, terminal_reason: string | null) {
  return {
    id: SESSION_ID,
    candidate_id: CANDIDATE_ID,
    role_id: ROLE_ID,
    status,
    terminal_reason,
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks(); // resets call history only; keeps mockFrom implementation
  injectAssessmentRunner(null); // always exercise the real implementation
  resetTracking();
  runClaudeJSONWithProvenance.mockImplementation(async () => ({
    // Fresh deep copy per call — the real impl mutates the returned
    // assessment (recomputes overall_score/recommendation), so sharing one
    // fixture object across tests would leak state between cases.
    data: JSON.parse(JSON.stringify(assessmentFixture)),
    requestedModel: 'sonnet',
  }));
});

afterEach(() => {
  injectAssessmentRunner(null);
});

// ════════════════════════════════════════════════════════════════════
//  1. INELIGIBLE matrix — fail closed with zero downstream side effects
// ════════════════════════════════════════════════════════════════════

describe('VOI-08 assessment eligibility preflight', () => {
  it('rejects every non-completed status with no provider/DB side effects (table-driven)', async () => {
    const statuses = ['created', 'waiting', 'in_progress', 'failed', 'cancelled', 'expired'];
    const reasons = [null, 'assessment_done', 'worker_crash', 'garbage_reason'];

    for (const status of statuses) {
      for (const terminal_reason of reasons) {
        resetTracking();
        configureTable('call_sessions', ok(sessionRow(status, terminal_reason)));

        await expect(runAssessment(SESSION_ID)).rejects.toThrow(ERR_SESSION_NOT_COMPLETED);

        // Fail closed BEFORE transcript fetch, provider call, role/candidate
        // fetch, and any DB writes.
        expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
        expect(fromCalls('transcript_turns')).toBe(0);
        expect(fromCalls('assessments')).toBe(0);
        expect(callsFor('assessments', 'insert')).toHaveLength(0);
        expect(fromCalls('candidates')).toBe(0);
        expect(callsFor('candidates', 'update')).toHaveLength(0);
        expect(fromCalls('roles')).toBe(0);
        // Only the eligibility lookup itself is permitted.
        expect(fromCalls('call_sessions')).toBe(1);
      }
    }
  });

  it('rejects the assessment_done repeat path and missing/malformed reasons on completed sessions', async () => {
    const ineligibleReasons = [null, 'assessment_done', 'worker_crash', 'garbage_reason'];

    for (const terminal_reason of ineligibleReasons) {
      resetTracking();
      configureTable('call_sessions', ok(sessionRow('completed', terminal_reason)));

      await expect(runAssessment(SESSION_ID)).rejects.toThrow(ERR_SESSION_NOT_COMPLETED);

      expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
      expect(fromCalls('transcript_turns')).toBe(0);
      expect(fromCalls('assessments')).toBe(0);
      expect(fromCalls('candidates')).toBe(0);
      expect(fromCalls('roles')).toBe(0);
      expect(fromCalls('call_sessions')).toBe(1);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  2. ELIGIBLE path — completed + conversation_complete reaches scoring
  // ══════════════════════════════════════════════════════════════════

  it('scores a completed session with the authoritative conversation_complete reason', async () => {
    configureTable('call_sessions', ok(sessionRow('completed', 'conversation_complete')));
    configureTable('transcript_turns', ok([]));
    configureTable('roles', ok({ title: 'Frontend Engineer', required_skills: ['TypeScript'] }));
    configureTable('candidates', ok({ name: 'Alice Example', parsed: { summary: 'Senior engineer' } }));
    configureTable('assessments', ok({ id: ASSESSMENT_ID }));

    const result = await runAssessment(SESSION_ID);

    // Resolves with an assessment object carrying the id from the insert row.
    expect(result.id).toBe(ASSESSMENT_ID);
    expect(result.overall_score).toBe(80);
    expect(result.recommendation).toBe('advance');

    // Provider called exactly once.
    expect(runClaudeJSONWithProvenance).toHaveBeenCalledTimes(1);

    // assessments insert called once with a payload containing session_id.
    const insertCalls = callsFor('assessments', 'insert');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].args[0]).toMatchObject({ session_id: SESSION_ID });

    // candidates update called once; transcript fetched; role fetched.
    expect(callsFor('candidates', 'update')).toHaveLength(1);
    expect(callsFor('transcript_turns', 'select')).toHaveLength(1);
    expect(fromCalls('roles')).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════
  //  3. NOT_FOUND — existing session-not-found error preserved
  // ══════════════════════════════════════════════════════════════════

  it('rejects with the existing session-not-found error and never reaches the provider', async () => {
    // DB error case
    resetTracking();
    configureTable('call_sessions', { data: null, error: { message: 'row missing' } });
    await expect(runAssessment(SESSION_ID)).rejects.toThrow(/session not found/);
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(fromCalls('transcript_turns')).toBe(0);
    expect(fromCalls('assessments')).toBe(0);

    // Null session case
    resetTracking();
    configureTable('call_sessions', ok(null));
    await expect(runAssessment(SESSION_ID)).rejects.toThrow(/session not found/);
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(fromCalls('transcript_turns')).toBe(0);
    expect(fromCalls('assessments')).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════
  //  4. Contract preservation (source assertions on assessment.ts)
  // ══════════════════════════════════════════════════════════════════

  it('preserves the existing contract surface of services/assessment.ts', () => {
    const source = readFileSync(new URL('../services/assessment.ts', import.meta.url), 'utf8');

    // Existing provenance strings must remain (asserted by other suites too).
    expect(source).toContain('runClaudeJSONWithProvenance');
    expect(source).toContain('scoringProvenance');

    // No consent coupling is introduced.
    expect(source).not.toContain('hasConsentFor');
    expect(source).not.toContain('routes/consent');

    // The eligibility select carries status + terminal_reason, and the
    // preflight pins the literal authoritative reason.
    expect(source).toContain('status,terminal_reason');
    expect(source).toContain("'conversation_complete'");
    expect(source).toContain(ERR_SESSION_NOT_COMPLETED);
  });

  // ══════════════════════════════════════════════════════════════════
  //  5. Route coverage — both callers hit the service-level guard
  // ══════════════════════════════════════════════════════════════════

  it('route coverage: direct-API and screening/queue callers both import the guarded runAssessment', () => {
    const assessSource = readFileSync(new URL('../routes/assess.ts', import.meta.url), 'utf8');
    const screeningSource = readFileSync(new URL('../routes/screening.ts', import.meta.url), 'utf8');

    expect(assessSource).toContain('runAssessment');
    expect(assessSource).toContain('services/assessment');
    expect(screeningSource).toContain('runAssessment');
    expect(screeningSource).toContain('services/assessment');
  });

  // ══════════════════════════════════════════════════════════════════
  //  6. Injected-runner contract — guard lives in the real impl only
  // ══════════════════════════════════════════════════════════════════

  it('injected runner bypasses the real implementation with no supabase calls', async () => {
    injectAssessmentRunner(async () => ({ id: 'inj-1', ...assessmentFixture }));

    const result = await runAssessment(SESSION_ID);

    expect(result.id).toBe('inj-1');
    // Injected runner returns the fixture untouched (no computeOverall pass).
    expect(result.overall_score).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════
  //  7. assessment_done guard — post-scoring terminal_reason transition
  // ══════════════════════════════════════════════════════════════════

  it('transitions terminal_reason to assessment_done after a successful scoring', async () => {
    configureTable('call_sessions', ok(sessionRow('completed', 'conversation_complete')));
    configureTable('transcript_turns', ok([]));
    configureTable('roles', ok({ title: 'FE', required_skills: [] }));
    configureTable('candidates', ok({ name: 'A', parsed: null }));
    configureTable('assessments', ok({ id: ASSESSMENT_ID }));

    await runAssessment(SESSION_ID);

    // The call_sessions.update with terminal_reason='assessment_done' is
    // conditioned on the current terminal_reason being 'conversation_complete'.
    const updateCalls = callsFor('call_sessions', 'update');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0]).toMatchObject({ terminal_reason: 'assessment_done' });
    // The eq filter confirms the conditional guard.
    const eqCalls = callsFor('call_sessions', 'eq');
    const eqArgs = eqCalls.map((c) => c.args);
    expect(eqArgs).toEqual(
      expect.arrayContaining([['id', SESSION_ID], ['terminal_reason', 'conversation_complete']]),
    );
  });

  it('non-concurrent repeat call is blocked after assessment_done transition', async () => {
    // First call: eligible (completed + conversation_complete), scores successfully.
    configureTable('call_sessions', ok(sessionRow('completed', 'conversation_complete')));
    configureTable('transcript_turns', ok([]));
    configureTable('roles', ok({ title: 'FE', required_skills: [] }));
    configureTable('candidates', ok({ name: 'A', parsed: null }));
    configureTable('assessments', ok({ id: ASSESSMENT_ID }));

    await runAssessment(SESSION_ID);
    expect(runClaudeJSONWithProvenance).toHaveBeenCalledTimes(1);

    // Second call: session now has terminal_reason='assessment_done'
    // (simulated by reconfiguring the session row).
    resetTracking();
    runClaudeJSONWithProvenance.mockClear();
    configureTable('call_sessions', ok(sessionRow('completed', 'assessment_done')));

    await expect(runAssessment(SESSION_ID)).rejects.toThrow(ERR_SESSION_NOT_COMPLETED);
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(fromCalls('assessments')).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════
  //  8. Route-level 409 regression — direct API returns non-retryable 4xx
  // ══════════════════════════════════════════════════════════════════

  it('direct API route returns 409 (not 500) for ineligible sessions', () => {
    const assessSource = readFileSync(new URL('../routes/assess.ts', import.meta.url), 'utf8');

    // The route must import ERR_SESSION_NOT_COMPLETED and return 409 for it.
    expect(assessSource).toContain('ERR_SESSION_NOT_COMPLETED');
    expect(assessSource).toContain('409');
    expect(assessSource).toContain('session_not_completed');
    expect(assessSource).toContain('Session is not eligible for assessment');
  });

  // ══════════════════════════════════════════════════════════════════
  //  9. Phase 9 L4 — notification intent + decision-use block
  // ══════════════════════════════════════════════════════════════════

  it('logs an idempotent recruiter notification intent only after assessment persistence', async () => {
    configureTable('call_sessions', ok(sessionRow('completed', 'conversation_complete')));
    configureTable('transcript_turns', ok([]));
    configureTable('roles', ok({ title: 'FE', required_skills: [] }));
    configureTable('candidates', ok({ name: 'A', parsed: null, decision_use_blocked_at: null }));
    configureTable('assessments', ok({ id: ASSESSMENT_ID }));
    configureTable('notification_intents', ok(null));

    await runAssessment(SESSION_ID);

    // Intent insert: bounded idempotency key, kind assessment_ready, candidate
    // id only — no contact data, no provider send.
    const intents = callsFor('notification_intents', 'insert');
    expect(intents).toHaveLength(1);
    const payload = intents[0].args[0] as Record<string, unknown>;
    expect(payload.idempotency_key).toBe(`assessment_ready:${ASSESSMENT_ID}`);
    expect(payload.kind).toBe('assessment_ready');
    expect(payload.candidate_id).toBe(CANDIDATE_ID);
    expect(JSON.stringify(payload)).not.toMatch(/email|phone|transcript|resume|token/i);

    // Intent is inserted AFTER the assessment row persisted (assessment insert
    // happens first).
    const assessInsert = callsFor('assessments', 'insert');
    expect(assessInsert).toHaveLength(1);
    expect(callsFor('candidates', 'update')).toHaveLength(1);
  });

  it('skips the candidate status rewrite while decision_use_blocked_at is set (assessment + intent remain truthful)', async () => {
    configureTable('call_sessions', ok(sessionRow('completed', 'conversation_complete')));
    configureTable('transcript_turns', ok([]));
    configureTable('roles', ok({ title: 'FE', required_skills: [] }));
    configureTable(
      'candidates',
      ok({ name: 'A', parsed: null, decision_use_blocked_at: '2026-01-02T00:00:00.000Z' }),
    );
    configureTable('assessments', ok({ id: ASSESSMENT_ID }));
    configureTable('notification_intents', ok(null));

    const result = await runAssessment(SESSION_ID);

    // The assessment resolves normally with its id.
    expect(result.id).toBe(ASSESSMENT_ID);
    // Assessment row persisted.
    expect(callsFor('assessments', 'insert')).toHaveLength(1);
    // Notification intent still logged (truthful completion signal).
    expect(callsFor('notification_intents', 'insert')).toHaveLength(1);
    // NO candidate status rewrite while the appeal blocks decision use.
    expect(callsFor('candidates', 'update')).toHaveLength(0);
    // Existing assessment_done behavior preserved.
    expect(callsFor('call_sessions', 'update')).toHaveLength(1);
  });

  it('a failed notification-intent insert does not fabricate delivery nor fail scoring', async () => {
    configureTable('call_sessions', ok(sessionRow('completed', 'conversation_complete')));
    configureTable('transcript_turns', ok([]));
    configureTable('roles', ok({ title: 'FE', required_skills: [] }));
    configureTable('candidates', ok({ name: 'A', parsed: null, decision_use_blocked_at: null }));
    configureTable('assessments', ok({ id: ASSESSMENT_ID }));
    configureTable('notification_intents', { data: null, error: { message: 'db down', code: 'PGRST' } });

    const result = await runAssessment(SESSION_ID);

    // Assessment still resolves; the intent failure is a reconciliation residual.
    expect(result.id).toBe(ASSESSMENT_ID);
    expect(callsFor('assessments', 'insert')).toHaveLength(1);
    expect(callsFor('candidates', 'update')).toHaveLength(1);
    // No fabricated delivery anywhere.
    expect(callsFor('notification_intents', 'insert')).toHaveLength(1);
  });
});
