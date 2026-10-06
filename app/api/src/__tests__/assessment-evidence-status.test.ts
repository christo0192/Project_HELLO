/**
 * C3 (migration 0114 §4) — services/assessment.ts: the evidence grade is
 * computed, persisted (phone only), copied on rescore, survives a stale schema,
 * and drives ONE candidate-status rule plus the Ashby observer.
 *
 * Offline: Supabase, the LLM runner, the scorecard store, the notification
 * intent and the Ashby observer are mocked; the real runAssessmentImpl and the
 * real v2 scorer run. Same per-table response-queue harness as
 * assessment-scorecard-v2.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAssessment, injectAssessmentRunner } from '../services/assessment.js';
import type { RoleScorecardVersion, ScorecardMetricModelResult } from '../lib/scorecards/contracts.js';

const {
  mockFrom,
  runClaudeJSONWithProvenance,
  insertNotificationIntent,
  observeAshbyCompletion,
  loadActiveRoleScorecard,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  runClaudeJSONWithProvenance: vi.fn(),
  insertNotificationIntent: vi.fn(),
  observeAshbyCompletion: vi.fn(),
  loadActiveRoleScorecard: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));
vi.mock('../lib/claude.js', () => ({ runClaudeJSONWithProvenance }));
vi.mock('../lib/notification-intent.js', () => ({ insertNotificationIntent }));
vi.mock('../integrations/ashby/completion-observer.js', () => ({ observeAshbyCompletion }));
vi.mock('../lib/scorecards/store.js', () => ({ loadActiveRoleScorecard }));

const CHAIN = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'in', 'order', 'limit', 'single', 'maybeSingle',
] as const;

interface Call { table: string; method: string; args: unknown[] }
type Result = { data: unknown; error: unknown };

let calls: Call[] = [];
let queues = new Map<string, Result[]>();
let defaults = new Map<string, Result>();

const ok = (data: unknown): Result => ({ data, error: null });
const setDefault = (table: string, value: Result) => defaults.set(table, value);
const queue = (table: string, ...values: Result[]) => queues.set(table, [...(queues.get(table) ?? []), ...values]);
const callsFor = (table: string, method?: string) =>
  calls.filter((c) => c.table === table && (method === undefined || c.method === method));

mockFrom.mockImplementation((table: string) => {
  const q = queues.get(table);
  const cfg = (q && q.length > 0 ? q.shift()! : defaults.get(table)) ?? { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const m of CHAIN) {
    builder[m] = (...args: unknown[]) => {
      // Insert payloads are snapshotted: the stale-schema fallback strips the
      // evidence keys from the SAME object before retrying.
      calls.push({ table, method: m, args: m === 'insert' ? JSON.parse(JSON.stringify(args)) : args });
      return builder;
    };
  }
  builder.then = (resolveFn: (v: unknown) => unknown) => Promise.resolve(cfg).then(resolveFn);
  builder.catch = (rejectFn: (e: unknown) => unknown) => Promise.resolve(cfg).catch(rejectFn);
  return builder;
});

const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
const CANDIDATE_ID = '00000000-0000-4000-8000-0000000000a2';
const ROLE_ID = '00000000-0000-4000-8000-0000000000a3';

const rubric = { 1: 'Poor', 2: 'Average', 3: 'Good', 4: 'Excellent' } as const;
const activeScorecard: RoleScorecardVersion = {
  id: 'ver-1',
  roleId: ROLE_ID,
  version: 1,
  configurationHash: 'a'.repeat(64),
  metrics: [5000, 3000, 2000].map((weightBps, index) => ({
    id: `metric-${index}`,
    libraryMetricId: `library-${index}`,
    key: `metric_${index + 1}`,
    name: `Metric ${index + 1}`,
    instruction: 'Use direct transcript evidence.',
    rubric,
    weightBps,
    displayOrder: index,
  })),
};

function modelResults(scores: Array<1 | 2 | 3 | 4 | null>): ScorecardMetricModelResult[] {
  return scores.map((score, index) => ({
    configMetricId: `metric-${index}`,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: 'Grounded in the transcript.',
    evidenceRefs: ['turn:1'],
  }));
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    candidate_id: CANDIDATE_ID,
    owner_id: null,
    role_id: ROLE_ID,
    status: 'completed',
    terminal_reason: 'conversation_complete',
    external_call_id: `phone-${SESSION_ID}`,
    started_at: '2026-10-03T04:00:00.000Z',
    ...over,
  };
}

const progress = (...dispositions: Array<string | null>) => ok(dispositions.map((disposition) => ({ disposition })));
const EVIDENCE_KEYS = ['evidence_grade', 'evidence_reason', 'evidence_answered', 'evidence_planned'];

function insertPayloads(): Array<Record<string, unknown>> {
  return callsFor('assessments', 'insert').map((c) => c.args[0] as Record<string, unknown>);
}
function candidateUpdate(): { status: unknown; filters: Array<[string, unknown[]]> } | null {
  const idx = calls.findIndex((c) => c.table === 'candidates' && c.method === 'update');
  if (idx < 0) return null;
  const filters: Array<[string, unknown[]]> = [];
  for (let i = idx + 1; i < calls.length && calls[i].table === 'candidates' && ['eq', 'neq', 'in'].includes(calls[i].method); i += 1) {
    filters.push([calls[i].method, calls[i].args]);
  }
  return { status: (calls[idx].args[0] as { status?: unknown }).status, filters };
}

beforeEach(() => {
  vi.clearAllMocks();
  injectAssessmentRunner(null);
  calls = [];
  queues = new Map();
  defaults = new Map();
  setDefault('call_sessions', ok(session()));
  setDefault('transcript_turns', ok([
    { speaker: 'bot', text: 'Tell me about your last role.' },
    { speaker: 'candidate', text: 'I led a team.' },
  ]));
  setDefault('candidates', ok({ name: 'Asha', parsed: null, decision_use_blocked_at: null }));
  setDefault('roles', ok({ title: 'Advisor', required_skills: [] }));
  setDefault('assessments', ok({ id: 'fresh-row' }));
  setDefault('phone_session_plans', ok({ question_count: 4 }));
  setDefault('phone_session_progress', progress('asked_answered', 'asked_answered', 'asked_answered', 'asked_answered'));
  insertNotificationIntent.mockResolvedValue(undefined);
  observeAshbyCompletion.mockResolvedValue(undefined);
  loadActiveRoleScorecard.mockResolvedValue(activeScorecard);
  // All 1s -> a COMPLETE reject.
  runClaudeJSONWithProvenance.mockResolvedValue({
    data: { results: modelResults([1, 1, 1]) },
    requestedModel: 'deepseek-v4-pro',
  });
});

afterEach(() => injectAssessmentRunner(null));

describe('phone first score — grade persisted, one status rule', () => {
  it('a744741c shape (partial, 0/4 answered, MEASURED): insufficient, held at Ashby, status NOT written (0115)', async () => {
    // 0115 (M013 D1/D3): a measured 0-answer phone row was not a screening.
    // The candidate stays at its pre-assessment status (`screening`); the
    // handler relabels the engagement failed/screening_abandoned.
    setDefault('phone_session_progress', progress('asked_declined', 'asked_declined'));
    await runAssessment(SESSION_ID, { source: 'phone', partial: true, covered: 2, total: 4, disconnectReason: 'candidate_hangup' });

    const [payload] = insertPayloads();
    expect(payload).toMatchObject({
      evidence_grade: 'insufficient', evidence_reason: 'partial_thin', evidence_answered: 0, evidence_planned: 4,
      partial: true, source: 'phone',
    });
    expect(candidateUpdate()).toBeNull();
    expect(callsFor('candidates', 'update')).toHaveLength(0);
    // The scorecard and the Ashby hold are unchanged.
    expect(observeAshbyCompletion).toHaveBeenCalledWith(SESSION_ID, expect.anything(), { evidenceGrade: 'insufficient' });
  });

  it('9f60523d shape (0 candidate turns, 0/5 MEASURED): no_candidate_speech, status NOT written (0115)', async () => {
    setDefault('transcript_turns', ok([{ speaker: 'bot', text: 'Tell me about your last role.' }]));
    setDefault('phone_session_plans', ok({ question_count: 5 }));
    setDefault('phone_session_progress', progress());
    await runAssessment(SESSION_ID, {
      source: 'phone', partial: true, covered: 0, total: 5, disconnectReason: 'unobserved_disconnect',
    });
    expect(insertPayloads()[0]).toMatchObject({
      evidence_grade: 'insufficient', evidence_reason: 'no_candidate_speech', evidence_answered: 0, evidence_planned: 5,
    });
    expect(candidateUpdate()).toBeNull();
  });

  it('partial, 1/4 answered: insufficient, screened only from new/queued/screening (rule unchanged)', async () => {
    setDefault('phone_session_progress', progress('asked_answered', 'asked_declined'));
    await runAssessment(SESSION_ID, { source: 'phone', partial: true, covered: 2, total: 4, disconnectReason: 'candidate_hangup' });
    expect(insertPayloads()[0]).toMatchObject({
      evidence_grade: 'insufficient', evidence_reason: 'partial_thin', evidence_answered: 1, evidence_planned: 4,
    });
    expect(candidateUpdate()).toEqual({
      status: 'screened',
      filters: [
        ['eq', ['id', CANDIDATE_ID]],
        ['in', ['status', ['new', 'queued', 'screening']]],
        ['neq', ['status', 'advanced']],
      ],
    });
  });

  it('UNMEASURED answered (a pre-0086 NULL disposition): insufficient, still screened (0115 keys on a measured 0 only)', async () => {
    setDefault('phone_session_progress', progress(null, 'asked_declined'));
    await runAssessment(SESSION_ID, { source: 'phone', partial: true, covered: 2, total: 4, disconnectReason: 'candidate_hangup' });
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'insufficient', evidence_answered: null });
    expect(candidateUpdate()?.status).toBe('screened');
  });

  it('no plan (answered NULL): insufficient/no_plan, still screened', async () => {
    setDefault('phone_session_plans', ok(null));
    await runAssessment(SESSION_ID, { source: 'phone', partial: true, covered: 1, total: 4, disconnectReason: 'candidate_hangup' });
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'insufficient', evidence_reason: 'no_plan', evidence_answered: null });
    expect(candidateUpdate()?.status).toBe('screened');
  });

  it('e3a187ed shape (complete reject, 2/4 answered): decision, rejected, never over advanced', async () => {
    setDefault('phone_session_progress', progress('asked_answered', 'volunteered_with_evidence', 'asked_declined', 'asked_declined'));
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(insertPayloads()[0]).toMatchObject({
      evidence_grade: 'decision', evidence_reason: 'complete_call', evidence_answered: 2, evidence_planned: 4,
    });
    expect(candidateUpdate()).toEqual({
      status: 'rejected',
      filters: [['eq', ['id', CANDIDATE_ID]], ['neq', ['status', 'advanced']]],
    });
    expect(observeAshbyCompletion).toHaveBeenCalledWith(SESSION_ID, expect.anything(), { evidenceGrade: 'decision' });
  });

  it('7f6bb294 shape (complete reject, 1/4 answered): screened, not rejected', async () => {
    setDefault('phone_session_progress', progress('asked_answered', 'asked_declined', 'asked_declined', 'asked_declined'));
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(candidateUpdate()?.status).toBe('screened');
    expect(candidateUpdate()?.filters).toContainEqual(['neq', ['status', 'advanced']]);
  });

  it('01c5a5dc shape (full call, provisional reject): screened, decision (publishes)', async () => {
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([1, 1, null]) },
      requestedModel: 'deepseek-v4-pro',
    });
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'decision', scoring_status: 'incomplete_evidence' });
    expect(candidateUpdate()?.status).toBe('screened');
    expect(observeAshbyCompletion).toHaveBeenCalledWith(SESSION_ID, expect.anything(), { evidenceGrade: 'decision' });
  });

  it('a coverage read is retried once, then evidence_read_failed (fail closed)', async () => {
    queue('phone_session_plans', { data: null, error: { message: 'boom' } }, { data: null, error: { message: 'boom' } });
    await runAssessment(SESSION_ID, { source: 'phone', partial: true, covered: 3, total: 4, disconnectReason: 'disconnected' });
    expect(callsFor('phone_session_plans', 'select')).toHaveLength(2);
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'insufficient', evidence_reason: 'evidence_read_failed' });
  });

  it('a decision-blocked candidate is never rewritten', async () => {
    setDefault('candidates', ok({ name: 'Asha', parsed: null, decision_use_blocked_at: '2026-10-01T00:00:00Z' }));
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(candidateUpdate()).toBeNull();
  });
});

describe('browser — payload byte-identical, no coverage reads', () => {
  it('carries no evidence key and reads no plan/progress; status rule keeps advanced', async () => {
    setDefault('call_sessions', ok(session({ external_call_id: 'room-browser-1' })));
    await runAssessment(SESSION_ID);
    const [payload] = insertPayloads();
    for (const key of EVIDENCE_KEYS) expect(payload).not.toHaveProperty(key);
    expect(payload).not.toHaveProperty('source');
    expect(callsFor('phone_session_plans')).toHaveLength(0);
    expect(callsFor('phone_session_progress')).toHaveLength(0);
    expect(candidateUpdate()).toEqual({
      status: 'rejected',
      filters: [['eq', ['id', CANDIDATE_ID]], ['neq', ['status', 'advanced']]],
    });
    expect(observeAshbyCompletion).toHaveBeenCalledWith(SESSION_ID, expect.anything(), { evidenceGrade: 'decision' });
  });
});

describe('stale schema — the evidence columns are not there yet', () => {
  it('retries the insert WITHOUT the evidence keys and still applies the grade from memory', async () => {
    // 1 of 4 answered: insufficient, and (not being a measured 0) screened.
    setDefault('phone_session_progress', progress('asked_answered'));
    queue('assessments',
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'evidence_answered' column of 'assessments' in the schema cache" } },
      ok({ id: 'fresh-row' }));
    const result = await runAssessment(SESSION_ID, { source: 'phone', partial: true, covered: 1, total: 4, disconnectReason: 'candidate_hangup' });
    expect(result.id).toBe('fresh-row');
    const payloads = insertPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toHaveProperty('evidence_grade', 'insufficient');
    for (const key of EVIDENCE_KEYS) expect(payloads[1]).not.toHaveProperty(key);
    expect(payloads[1]).toMatchObject({ partial: true, source: 'phone' });
    expect(candidateUpdate()?.filters).toContainEqual(['in', ['status', ['new', 'queued', 'screening']]]);
    expect(observeAshbyCompletion).toHaveBeenCalledWith(SESSION_ID, expect.anything(), { evidenceGrade: 'insufficient' });
  });

  it('an unrelated insert error is not swallowed by the evidence fallback', async () => {
    queue('assessments', { data: null, error: { code: '23514', message: 'violates check constraint chk_assessments_v2_shape' } });
    await expect(runAssessment(SESSION_ID, { source: 'phone' })).rejects.toThrow(/chk_assessments_v2_shape/);
    expect(insertPayloads()).toHaveLength(1);
  });
});

describe('rescore — copies the superseded revision, recomputes only when it has none', () => {
  const REQUEST = 'req-1';
  beforeEach(() => {
    setDefault('call_sessions', ok(session({ terminal_reason: 'assessment_done' })));
  });

  it('copies an insufficient grade even when coverage now reads 4/4 (never upgrades)', async () => {
    queue('assessments',
      ok(null), // idempotency read: unused request id
      ok({ id: 'prior', revision: 1, created_at: '2026-10-01T00:00:00Z' }), // latest revision
      ok({ evidence_grade: 'insufficient', evidence_reason: 'partial_thin', evidence_answered: 1, evidence_planned: 4, partial: true, raw: {} }),
      ok({ id: 'rev-2' }));
    await runAssessment(SESSION_ID, { rescore: { requestId: REQUEST } });
    const [payload] = insertPayloads();
    expect(payload).toMatchObject({
      revision: 2, supersedes_assessment_id: 'prior',
      evidence_grade: 'insufficient', evidence_reason: 'partial_thin', evidence_answered: 1, evidence_planned: 4,
    });
    expect(callsFor('phone_session_plans')).toHaveLength(0);
    expect(candidateUpdate()?.filters).toContainEqual(['in', ['status', ['new', 'queued', 'screening']]]);
  });

  it('a copied MEASURED 0-answer grade leaves the candidate status alone (0115)', async () => {
    queue('assessments',
      ok(null),
      ok({ id: 'prior', revision: 1, created_at: '2026-10-01T00:00:00Z' }),
      ok({ evidence_grade: 'insufficient', evidence_reason: 'partial_thin', evidence_answered: 0, evidence_planned: 4, partial: true, raw: {} }),
      ok({ id: 'rev-2' }));
    await runAssessment(SESSION_ID, { rescore: { requestId: REQUEST } });
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'insufficient', evidence_answered: 0 });
    expect(candidateUpdate()).toBeNull();
  });

  it('recomputes from the STORED partial/disconnect when the prior revision has no grade', async () => {
    queue('assessments',
      ok(null),
      ok({ id: 'prior', revision: 1, created_at: '2026-10-01T00:00:00Z' }),
      ok({ evidence_grade: null, evidence_reason: null, partial: true, raw: { partial: { disconnect_reason: 'worker_crash' } } }),
      ok({ id: 'rev-2' }));
    setDefault('phone_session_progress', progress('asked_answered'));
    await runAssessment(SESSION_ID, { rescore: { requestId: REQUEST } });
    expect(insertPayloads()[0]).toMatchObject({
      evidence_grade: 'insufficient', evidence_reason: 'infra_interrupted', evidence_answered: 1, evidence_planned: 4,
    });
  });

  it('recomputes when the prior read had failed (evidence_read_failed)', async () => {
    queue('assessments',
      ok(null),
      ok({ id: 'prior', revision: 1, created_at: '2026-10-01T00:00:00Z' }),
      ok({ evidence_grade: 'insufficient', evidence_reason: 'evidence_read_failed', partial: true, raw: {} }),
      ok({ id: 'rev-2' }));
    await runAssessment(SESSION_ID, { rescore: { requestId: REQUEST } });
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'decision', evidence_reason: 'partial_sufficient' });
  });

  it('a stale prior schema (42703) recomputes from partial/raw', async () => {
    queue('assessments',
      ok(null),
      ok({ id: 'prior', revision: 1, created_at: '2026-10-01T00:00:00Z' }),
      { data: null, error: { code: '42703', message: 'column assessments.evidence_grade does not exist' } },
      ok({ partial: false, raw: {} }),
      ok({ id: 'rev-2' }));
    await runAssessment(SESSION_ID, { rescore: { requestId: REQUEST } });
    expect(insertPayloads()[0]).toMatchObject({ evidence_grade: 'decision', evidence_reason: 'complete_call' });
  });

  it('a stale schema at insert drops the evidence keys and retries within the bounded loop', async () => {
    queue('assessments',
      ok(null),
      ok({ id: 'prior', revision: 1, created_at: '2026-10-01T00:00:00Z' }),
      ok({ evidence_grade: 'decision', evidence_reason: 'complete_call', evidence_answered: 4, evidence_planned: 4, partial: false, raw: {} }),
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'evidence_grade' column" } },
      ok({ id: 'rev-2' }));
    const out = await runAssessment(SESSION_ID, { rescore: { requestId: REQUEST } });
    expect(out.id).toBe('rev-2');
    const payloads = insertPayloads();
    expect(payloads).toHaveLength(2);
    for (const key of EVIDENCE_KEYS) expect(payloads[1]).not.toHaveProperty(key);
  });
});

describe('structural', () => {
  const src = readFileSync(resolve(__dirname, '../services/assessment.ts'), 'utf8');
  it('keeps PR-B B5 catch-block lines untouched', () => {
    expect(src).toContain("const validationCode = err instanceof ScorecardValidationError ? err.code : undefined;");
    expect(src).toContain("throw validationCode !== undefined ? new Error(validationCode, { cause: err }) : err;");
  });
  it('every candidate status write excludes advanced', () => {
    const writes = src.split(".from('candidates')").slice(1).filter((chunk) => /^\s*\.update\(/.test(chunk));
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const chunk of writes) {
      expect(chunk.slice(0, 400)).toContain(".neq('status', 'advanced')");
    }
  });
  it('SCORECARD_ASSESSMENT_COLUMNS does not carry evidence_grade', () => {
    const stores = readFileSync(resolve(__dirname, '../integrations/ashby/workflow-stores.ts'), 'utf8');
    const decl = stores.split('const SCORECARD_ASSESSMENT_COLUMNS =')[1]?.split(';')[0] ?? '';
    expect(decl).toContain('schema_version');
    expect(decl).not.toMatch(/evidence/);
  });
});
