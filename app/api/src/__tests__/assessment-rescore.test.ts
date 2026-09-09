/**
 * Phase 4 — the EXPLICIT IMMUTABLE RESCORE workflow in services/assessment.ts.
 *
 * A rescore re-runs scoring for an already-completed session against its role's
 * CURRENT active v2 scorecard and persists a NEW immutable revision that
 * SUPERSEDES the prior one — the old row is never mutated or deleted. It is
 * idempotent per a caller-supplied `rescore_request_id`:
 *   * a repeat with the same id returns the existing revision, scores nothing,
 *     inserts nothing, and runs none of the follow-on side-effects;
 *   * a fresh rescore reads max(revision) for the session's v2 rows, writes
 *     revision = max + 1 with supersedes_assessment_id = the latest row's id;
 *   * a racing (session_id, revision) unique-violation is retried against a
 *     re-read max, WITHOUT re-scoring;
 *   * a racing rescore-request unique-violation adopts the winner's row.
 *
 * A first score (no request id) is unchanged: revision 1, no supersede, no
 * request id — asserted here as a control.
 *
 * Offline and deterministic: Supabase, the LLM runner, the role-scorecard
 * store, the notification intent and the Ashby observer are the only mocked
 * boundaries; the real `runAssessmentImpl` (and the real scorer) run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAssessment, injectAssessmentRunner } from '../services/assessment.js';
import type {
  RoleScorecardVersion,
  ScorecardMetricModelResult,
} from '../lib/scorecards/contracts.js';

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

// ── Per-table response queue (the idempotency-suite harness) ──────────
// `assessments` is touched several times on a rescore — the idempotency read,
// the max-revision read, and the insert(s) — so a single-response-per-table
// mock cannot express it.  Insert args are CLONED at call time: production
// mutates the shared payload object between revision-race retries, so a
// post-hoc read of the recorded reference would show only the final value.
const CHAIN = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'order', 'limit', 'single', 'maybeSingle',
] as const;

interface Call { table: string; method: string; args: unknown[] }

let calls: Call[] = [];
let queues = new Map<string, Array<{ data: unknown; error: unknown }>>();
let defaults = new Map<string, { data: unknown; error: unknown }>();

function enqueue(table: string, ...values: Array<{ data: unknown; error: unknown }>): void {
  queues.set(table, [...(queues.get(table) ?? []), ...values]);
}
function setDefault(table: string, value: { data: unknown; error: unknown }): void {
  defaults.set(table, value);
}
function ok(data: unknown) { return { data, error: null }; }
function callsFor(table: string, method?: string): Call[] {
  return calls.filter((c) => c.table === table && (method === undefined || c.method === method));
}

mockFrom.mockImplementation((table: string) => {
  const queue = queues.get(table);
  const cfg = (queue && queue.length > 0 ? queue.shift()! : defaults.get(table))
    ?? { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const m of CHAIN) {
    builder[m] = (...args: unknown[]) => {
      const recorded = m === 'insert' ? JSON.parse(JSON.stringify(args)) : args;
      calls.push({ table, method: m, args: recorded });
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(cfg).then(resolve);
  builder.catch = (reject: (e: unknown) => unknown) => Promise.resolve(cfg).catch(reject);
  return builder;
});

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';
const ROLE_ID = '00000000-0000-4000-8000-000000000003';
const PRIOR_ID = '00000000-0000-4000-8000-0000000000a1';
const RIVAL_ID = '00000000-0000-4000-8000-0000000000a2';
const NEW_ID = '00000000-0000-4000-8000-0000000000b0';
const EXISTING_ID = '00000000-0000-4000-8000-0000000000c0';
const WINNER_ID = '00000000-0000-4000-8000-0000000000d0';
const REQ_ID = '11111111-2222-4333-8444-555555555555';

const rubric = { 1: 'Poor', 2: 'Below average', 3: 'Average', 4: 'Good', 5: 'Excellent' } as const;

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

function modelResults(scores: Array<1 | 2 | 3 | 4 | 5 | null>): ScorecardMetricModelResult[] {
  return scores.map((score, index) => ({
    configMetricId: `metric-${index}`,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: 'Grounded in the transcript.',
    evidenceRefs: ['turn:1'],
  }));
}

/** An already-scored, completed session (terminal_reason has been flipped). */
function scoredSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    candidate_id: CANDIDATE_ID,
    owner_id: null,
    role_id: ROLE_ID,
    status: 'completed',
    terminal_reason: 'assessment_done',
    external_call_id: 'room-browser-1',
    started_at: '2026-09-01T06:00:00.000Z',
    ...overrides,
  };
}

const UV_REVISION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "uq_assessments_v2_session_revision"',
};
const UV_RESCORE = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "uq_assessments_rescore_request"',
};

beforeEach(() => {
  vi.clearAllMocks();
  injectAssessmentRunner(null);
  calls = [];
  queues = new Map();
  defaults = new Map();
  setDefault('call_sessions', ok(scoredSession()));
  setDefault('transcript_turns', ok([{ speaker: 'candidate', text: 'I led a team of five.' }]));
  setDefault('candidates', ok({ name: 'Asha', parsed: null, decision_use_blocked_at: null }));
  setDefault('roles', ok({ title: 'Advisor', required_skills: [] }));
  loadActiveRoleScorecard.mockResolvedValue(activeScorecard);
  runClaudeJSONWithProvenance.mockResolvedValue({
    data: { results: modelResults([5, 3, 1]) },
    requestedModel: 'deepseek-v4-pro',
  });
  insertNotificationIntent.mockResolvedValue(undefined);
  observeAshbyCompletion.mockResolvedValue(undefined);
});

afterEach(() => {
  injectAssessmentRunner(null);
});

// ═══════════════════════════════════════════════════════════════════════
describe('a fresh rescore writes a superseding revision, prior row untouched', () => {
  it('inserts revision=2 with supersedes_assessment_id=prior and the request id', async () => {
    enqueue(
      'assessments',
      ok(null), // idempotency-first: no assessment under this request id yet
      ok({ id: PRIOR_ID, revision: 1 }), // latest v2 revision for the session
      ok({ id: NEW_ID }), // the insert
    );

    const result = await runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } });

    const insert = callsFor('assessments', 'insert')[0];
    expect(insert).toBeDefined();
    const payload = insert.args[0] as Record<string, unknown>;
    expect(payload.schema_version).toBe(2);
    expect(payload.revision).toBe(2);
    expect(payload.supersedes_assessment_id).toBe(PRIOR_ID);
    expect(payload.rescore_request_id).toBe(REQ_ID);
    expect(payload.scorecard_version_id).toBe('ver-1');
    expect(payload.scoring_status).toBe('complete');
    expect(payload.weighted_score_5).toBe(3.6);

    expect(result.id).toBe(NEW_ID);
    // Scoring ran exactly once.
    expect(runClaudeJSONWithProvenance).toHaveBeenCalledOnce();
    // IMMUTABILITY: the prior row is never mutated or deleted.
    expect(callsFor('assessments', 'update')).toHaveLength(0);
    expect(callsFor('assessments', 'delete')).toHaveLength(0);
    // Exactly one new row.
    expect(callsFor('assessments', 'insert')).toHaveLength(1);
  });

  it('runs the candidate/status side-effects for the NEW row, once', async () => {
    enqueue(
      'assessments',
      ok(null),
      ok({ id: PRIOR_ID, revision: 1 }),
      ok({ id: NEW_ID }),
    );
    await runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } });
    expect(insertNotificationIntent).toHaveBeenCalledOnce();
    expect(observeAshbyCompletion).toHaveBeenCalledOnce();
    expect(callsFor('candidates', 'update')).toHaveLength(1);
    expect(callsFor('call_sessions', 'update')).toHaveLength(1);
  });

  it('treats a session with NO prior v2 assessment as revision 1, no supersede', async () => {
    enqueue(
      'assessments',
      ok(null), // idempotency-first
      ok(null), // no latest v2 revision at all
      ok({ id: NEW_ID }),
    );
    await runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } });
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.revision).toBe(1);
    expect(payload.supersedes_assessment_id).toBeNull();
    expect(payload.rescore_request_id).toBe(REQ_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('a repeat with the SAME request id is idempotent', () => {
  it('returns the existing revision without scoring, inserting, or side-effects', async () => {
    enqueue(
      'assessments',
      ok({ id: EXISTING_ID, raw: { marker: 'existing-revision', weightedScore5: 3.6 } }),
    );

    const result = await runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } });

    expect(result.id).toBe(EXISTING_ID);
    expect((result as unknown as { marker: string }).marker).toBe('existing-revision');
    // Nothing was scored or inserted.
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(callsFor('assessments', 'insert')).toHaveLength(0);
    // Short-circuits BEFORE the scorecard load and the transcript fetch.
    expect(loadActiveRoleScorecard).not.toHaveBeenCalled();
    expect(callsFor('transcript_turns')).toHaveLength(0);
    // None of the follow-on work runs.
    expect(insertNotificationIntent).not.toHaveBeenCalled();
    expect(observeAshbyCompletion).not.toHaveBeenCalled();
    expect(callsFor('candidates', 'update')).toHaveLength(0);
    expect(callsFor('call_sessions', 'update')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('a first score (no request id) is unchanged', () => {
  it('writes revision 1 with neither a supersede nor a request id', async () => {
    setDefault('call_sessions', ok(scoredSession({ terminal_reason: 'conversation_complete' })));
    setDefault('assessments', ok({ id: 'fresh-row' }));

    const result = await runAssessment(SESSION_ID);

    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.revision).toBe(1);
    expect(payload.schema_version).toBe(2);
    expect(Object.keys(payload)).not.toContain('supersedes_assessment_id');
    expect(Object.keys(payload)).not.toContain('rescore_request_id');
    // No idempotency read and no max-revision read happen on the first-score path.
    expect(callsFor('assessments', 'maybeSingle')).toHaveLength(0);
    expect(result.id).toBe('fresh-row');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('concurrency at the insert', () => {
  it('retries a (session_id, revision) race against a re-read max, without re-scoring', async () => {
    enqueue(
      'assessments',
      ok(null), // idempotency-first
      ok({ id: PRIOR_ID, revision: 1 }), // latest → attempt revision 2
      { data: null, error: UV_REVISION }, // insert #1 loses the revision slot
      ok(null), // winner read → not an idempotency race
      ok({ id: RIVAL_ID, revision: 2 }), // re-read latest → attempt revision 3
      ok({ id: NEW_ID }), // insert #2 succeeds
    );

    const result = await runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } });

    const inserts = callsFor('assessments', 'insert');
    expect(inserts).toHaveLength(2);
    // The first attempt aimed at revision 2, the retry advanced to 3 and
    // re-pointed the supersede at the row that won the earlier slot.
    expect((inserts[0].args[0] as Record<string, unknown>).revision).toBe(2);
    expect((inserts[0].args[0] as Record<string, unknown>).supersedes_assessment_id).toBe(PRIOR_ID);
    expect((inserts[1].args[0] as Record<string, unknown>).revision).toBe(3);
    expect((inserts[1].args[0] as Record<string, unknown>).supersedes_assessment_id).toBe(RIVAL_ID);
    expect((inserts[1].args[0] as Record<string, unknown>).rescore_request_id).toBe(REQ_ID);

    expect(result.id).toBe(NEW_ID);
    // Scoring is NOT repeated on a revision retry.
    expect(runClaudeJSONWithProvenance).toHaveBeenCalledOnce();
  });

  it('adopts the winner when the rescore-request id lost the race at insert time', async () => {
    enqueue(
      'assessments',
      ok(null), // idempotency-first
      ok({ id: PRIOR_ID, revision: 1 }), // latest
      { data: null, error: UV_RESCORE }, // insert loses on the request-id index
      ok({ id: WINNER_ID, raw: { marker: 'winner' } }), // winner read resolves it
    );

    const result = await runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } });

    expect(result.id).toBe(WINNER_ID);
    // Only one insert attempt; the winner is adopted, not re-inserted.
    expect(callsFor('assessments', 'insert')).toHaveLength(1);
    // The adopting caller performs NONE of the follow-on work.
    expect(insertNotificationIntent).not.toHaveBeenCalled();
    expect(observeAshbyCompletion).not.toHaveBeenCalled();
    expect(callsFor('candidates', 'update')).toHaveLength(0);
    expect(callsFor('call_sessions', 'update')).toHaveLength(0);
  });

  it('a non-unique insert error is never mistaken for a race', async () => {
    enqueue(
      'assessments',
      ok(null),
      ok({ id: PRIOR_ID, revision: 1 }),
      { data: null, error: { code: '42501', message: 'permission denied for table assessments' } },
    );
    await expect(runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } }))
      .rejects.toThrow(/permission denied/);
    expect(callsFor('assessments', 'insert')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('rescore eligibility and the no-scorecard case', () => {
  it('refuses a rescore on a session that never completed', async () => {
    setDefault('call_sessions', ok(scoredSession({ status: 'in_progress', terminal_reason: null })));
    await expect(runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } }))
      .rejects.toThrow('ERR_SESSION_NOT_COMPLETED');
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(callsFor('assessments', 'insert')).toHaveLength(0);
  });

  it('refuses a rescore when the role has no active scorecard (ERR_RESCORE_NO_SCORECARD)', async () => {
    loadActiveRoleScorecard.mockResolvedValue(null);
    enqueue('assessments', ok(null)); // idempotency-first: none
    await expect(runAssessment(SESSION_ID, { rescore: { requestId: REQ_ID } }))
      .rejects.toThrow('ERR_RESCORE_NO_SCORECARD');
    // Fails BEFORE the LLM call and before any insert.
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(callsFor('assessments', 'insert')).toHaveLength(0);
  });
});
