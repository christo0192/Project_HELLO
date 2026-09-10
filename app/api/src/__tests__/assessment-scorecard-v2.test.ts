/**
 * services/assessment.ts — the v2 selection branch.
 *
 * When the role has an ACTIVE scorecard, a completed screening is scored against
 * that role's configured metrics and persisted as a `schema_version = 2` row
 * (metric_results array + weighted_score_5 + scoring_status), and every existing
 * post-persist side-effect still fires. When the role has NO active scorecard,
 * the legacy v1 dimension path runs, byte-identical to before.
 *
 * Offline and deterministic: Supabase, the LLM runner, the role-scorecard store,
 * the notification intent and the Ashby observer are the only mocked boundaries;
 * the real `runAssessmentImpl` (and, on the v2 path, the real scorer) run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAssessment, injectAssessmentRunner } from '../services/assessment.js';
import type { Assessment } from '../lib/types.js';
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
  loggerWarn,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  runClaudeJSONWithProvenance: vi.fn(),
  insertNotificationIntent: vi.fn(),
  observeAshbyCompletion: vi.fn(),
  loadActiveRoleScorecard: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));
vi.mock('../lib/claude.js', () => ({ runClaudeJSONWithProvenance }));
vi.mock('../lib/notification-intent.js', () => ({ insertNotificationIntent }));
vi.mock('../integrations/ashby/completion-observer.js', () => ({ observeAshbyCompletion }));
vi.mock('../lib/scorecards/store.js', () => ({ loadActiveRoleScorecard }));
// Spread the ACTUAL logger module (keeps EVENT_NAMES_SET etc. that transitive
// modules import) and override only createLogger so we can spy on the scorer
// boundary warning without disturbing the real event-name contract.
vi.mock('../lib/logger.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/logger.js')>();
  return { ...actual, createLogger: () => ({ warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});

// ── Per-table response queue (same harness as the idempotency suite) ──
const CHAIN = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'order', 'limit', 'single', 'maybeSingle',
] as const;

interface Call { table: string; method: string; args: unknown[] }

let calls: Call[] = [];
let queues = new Map<string, Array<{ data: unknown; error: unknown }>>();
let defaults = new Map<string, { data: unknown; error: unknown }>();

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
      calls.push({ table, method: m, args });
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

// A complete v1 assessment fixture (used by the NO-scorecard control).
const v1Fixture: Assessment = {
  english: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'clear' },
  tone: { clarity: 8, confidence: 8, professionalism: 8, sentiment: 'positive', notes: 'ok' },
  communication: {
    score: 8, clarity: 8, structure: 8, listening: 8, rapport: 8,
    english_proficiency: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'c' },
    filler_usage: { level: 'low', impact_score: 8, examples: [], notes: '' },
    native_language_usage: { level: 'none', examples: [], impact_score: 9, notes: '' },
    notes: 'good',
  },
  motivation: { score: 8, notes: 'interested' },
  role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: 'fit' },
  overall_score: 0,
  recommendation: 'advance',
  summary: 'Strong candidate',
  resume_conflicts: [],
};

function completedSession() {
  return {
    id: SESSION_ID,
    candidate_id: CANDIDATE_ID,
    owner_id: null,
    role_id: ROLE_ID,
    status: 'completed',
    terminal_reason: 'conversation_complete',
    external_call_id: 'room-browser-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  injectAssessmentRunner(null);
  calls = [];
  queues = new Map();
  defaults = new Map();
  setDefault('call_sessions', ok(completedSession()));
  setDefault('transcript_turns', ok([{ speaker: 'candidate', text: 'I led a team of five.' }]));
  setDefault('candidates', ok({ name: 'Asha', parsed: null, decision_use_blocked_at: null }));
  setDefault('roles', ok({ title: 'Advisor', required_skills: [] }));
  setDefault('assessments', ok({ id: 'fresh-row' }));
  insertNotificationIntent.mockResolvedValue(undefined);
  observeAshbyCompletion.mockResolvedValue(undefined);
});

afterEach(() => {
  injectAssessmentRunner(null);
});

// ═══════════════════════════════════════════════════════════════════
describe('v2 branch — a role with an active scorecard', () => {
  beforeEach(() => {
    loadActiveRoleScorecard.mockResolvedValue(activeScorecard);
    // The v2 scorer's default infer calls runClaudeJSONWithProvenance.
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([4, 3, 1]) },
      requestedModel: 'deepseek-v4-pro',
    });
  });

  it('persists a schema_version=2 row with metric_results / weighted_score_5 / scoring_status', async () => {
    const result = await runAssessment(SESSION_ID);
    const insert = callsFor('assessments', 'insert')[0];
    expect(insert).toBeDefined();
    const payload = insert.args[0] as Record<string, unknown>;

    expect(payload.schema_version).toBe(2);
    expect(payload.revision).toBe(1);
    expect(payload.scorecard_version_id).toBe('ver-1');
    expect(payload.scoring_status).toBe('complete');
    // (5000*4 + 3000*3 + 2000*1) / 10000 = 3.1 on the four-point rubric,
    // → round(((3.1-1)/3)*100) = 70.
    expect(payload.weighted_score_5).toBe(3.1);
    expect(payload.overall_score).toBe(70);
    // 0093: the row records the rubric scale it was scored on, so the Ashby
    // adapter and the candidate card project it correctly forever after.
    expect(payload.score_scale_max).toBe(4);
    expect(payload.recommendation).toBe('advance');
    expect(Array.isArray(payload.metric_results)).toBe(true);
    expect(payload.metric_results as unknown[]).toHaveLength(3);
    expect(payload.provenance).toBeDefined();

    // No v1 dimension columns are set on a v2 row (they stay NULL in the DB).
    for (const k of ['english', 'tone', 'communication', 'motivation', 'role_fit', 'summary', 'resume_conflicts']) {
      expect(Object.keys(payload)).not.toContain(k);
    }

    expect(result.id).toBe('fresh-row');
  });

  it('still fires every post-persist side-effect exactly once', async () => {
    await runAssessment(SESSION_ID);
    expect(insertNotificationIntent).toHaveBeenCalledOnce();
    expect(observeAshbyCompletion).toHaveBeenCalledOnce();
    expect(callsFor('candidates', 'update')).toHaveLength(1);
    expect(callsFor('call_sessions', 'update')).toHaveLength(1);
  });

  it('a PARTIAL incomplete-evidence result persists a PROVISIONAL score + recommendation (never blank)', async () => {
    // The production failure this repairs: one un-evidenced metric must NOT void
    // the card. [4, 3, null] over weights [5000, 3000, 2000] renormalizes to
    // (20000+9000)/8000 = 3.625 → overall 88 → 'advance'. The row is v2 +
    // incomplete_evidence but carries a real score the recruiter can see.
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([4, 3, null]) },
      requestedModel: 'deepseek-v4-pro',
    });
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.scoring_status).toBe('incomplete_evidence');
    expect(payload.weighted_score_5).toBe(3.625);
    expect(payload.overall_score).toBe(88);
    expect(payload.recommendation).toBe('advance');
    // The full provisional verdict is also in `raw` (what the candidate card reads),
    // including the scale it must be rendered on.
    expect((payload.raw as { recommendation: string }).recommendation).toBe('advance');
    expect((payload.raw as { weightedScore5: number }).weightedScore5).toBe(3.625);
    expect((payload.raw as { scoreScaleMax: number }).scoreScaleMax).toBe(4);
  });

  it('nulls weighted/overall/recommendation ONLY when NOT ONE metric was scored', async () => {
    // Genuinely unscoreable — nothing to renormalize. human_review is not an
    // allowed column value (chk_assessments_recommendation), so it stores NULL.
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([null, null, null]) },
      requestedModel: 'deepseek-v4-pro',
    });
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.scoring_status).toBe('incomplete_evidence');
    expect(payload.weighted_score_5).toBeNull();
    expect(payload.overall_score).toBeNull();
    expect(payload.recommendation).toBeNull();
  });

  it('a PROVISIONAL reject does NOT auto-terminate the candidate (status screened, not rejected)', async () => {
    // [1, 1, null] → weighted 1.0 → overall 0 → 'reject', but status is
    // incomplete_evidence (metric-2 unscored). A partial-evidence reject must
    // land 'screened' for human confirmation, never auto-reject the candidate.
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([1, 1, null]) },
      requestedModel: 'deepseek-v4-pro',
    });
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.scoring_status).toBe('incomplete_evidence');
    expect(payload.recommendation).toBe('reject'); // shown on the card…
    const update = callsFor('candidates', 'update')[0].args[0] as Record<string, unknown>;
    expect(update.status).toBe('screened'); // …but the candidate is NOT auto-rejected.
  });

  it('a COMPLETE reject still auto-terminates the candidate (status rejected)', async () => {
    // [1, 1, 1] → all scored → weighted 1.0 → 'reject', status complete. A fully
    // evidenced reject keeps the existing auto-terminate behavior.
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([1, 1, 1]) },
      requestedModel: 'deepseek-v4-pro',
    });
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.scoring_status).toBe('complete');
    expect(payload.recommendation).toBe('reject');
    const update = callsFor('candidates', 'update')[0].args[0] as Record<string, unknown>;
    expect(update.status).toBe('rejected');
  });

  it('FAILS CLOSED on a hard scorer failure: rejects, persists nothing, logs the named boundary', async () => {
    // A malformed model output makes the scorer throw. assessment.ts must emit a
    // NAMED boundary signal (error_category=scorecard_scoring_failed — the code
    // the queue DLQs and v_funnel_failures surfaces) and rethrow, WITHOUT writing
    // a half-baked assessment row or touching the candidate's status.
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: 'not-an-array' },
      requestedModel: 'deepseek-v4-pro',
    });
    await expect(runAssessment(SESSION_ID)).rejects.toThrow();
    expect(callsFor('assessments', 'insert')).toHaveLength(0);
    expect(callsFor('candidates', 'update')).toHaveLength(0);
    expect(loggerWarn).toHaveBeenCalledWith(
      'unknown_event',
      expect.objectContaining({ error_category: 'scorecard_scoring_failed' }),
    );
  });

  it('a phone v2 assessment carries source=phone and revision=1 (index coverage)', async () => {
    await runAssessment(SESSION_ID, { source: 'phone' });
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.source).toBe('phone');
    expect(payload.revision).toBe(1);
    expect(payload.schema_version).toBe(2);
  });

  // The v2 scorer makes TWO model calls: the metric scorer, then the
  // supplementary integrity analysis. The mock branches on the prompt (only the
  // integrity prompt asks for "resume_conflicts") to return the right shape.
  const integrityAwareInfer = (integrityData: unknown) =>
    async (prompt: string) => ({
      data: prompt.includes('"resume_conflicts"') ? integrityData : { results: modelResults([4, 3, 1]) },
      requestedModel: 'deepseek-v4-pro',
    });

  it('persists role_fit + resume_conflicts (v1-shaped columns) from the integrity analysis', async () => {
    runClaudeJSONWithProvenance.mockImplementation(
      integrityAwareInfer({
        role_fit: {
          score: 4,
          matched_skills: ['Python'],
          gaps: ['No verifiable SWE role on resume'],
          red_flags: ['Identity mismatch: resume Christo, said Kopu/Bopu'],
          notes: 'Weak fit; claims unverifiable.',
        },
        resume_conflicts: [
          { topic: 'Amazon tenure', resume_says: 'no Amazon role', candidate_said: '11 years at Amazon', resolved: false, note: '' },
        ],
      }),
    );
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.schema_version).toBe(2);
    const roleFit = payload.role_fit as { matched_skills: string[]; red_flags: string[] };
    expect(roleFit.matched_skills).toEqual(['Python']);
    expect(roleFit.red_flags).toEqual(['Identity mismatch: resume Christo, said Kopu/Bopu']);
    const conflicts = payload.resume_conflicts as Array<{ topic: string }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].topic).toBe('Amazon tenure');
  });

  it('omits role_fit + resume_conflicts when the integrity analysis finds nothing', async () => {
    runClaudeJSONWithProvenance.mockImplementation(
      integrityAwareInfer({
        role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: [], notes: '' },
        resume_conflicts: [],
      }),
    );
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('role_fit');
    expect(Object.keys(payload)).not.toContain('resume_conflicts');
  });

  it('FAIL-SOFT: a scorecard still persists when the integrity analysis throws', async () => {
    runClaudeJSONWithProvenance.mockImplementation(async (prompt: string) => {
      if (prompt.includes('"resume_conflicts"')) throw new Error('integrity provider 500');
      return { data: { results: modelResults([4, 3, 1]) }, requestedModel: 'deepseek-v4-pro' };
    });
    await runAssessment(SESSION_ID);
    const inserts = callsFor('assessments', 'insert');
    expect(inserts).toHaveLength(1); // the scorecard was NOT blocked
    const payload = inserts[0].args[0] as Record<string, unknown>;
    expect(payload.schema_version).toBe(2);
    expect(payload.weighted_score_5).toBe(3.1);
    expect(Object.keys(payload)).not.toContain('role_fit');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('v1 fallthrough — a role with NO active scorecard is unchanged', () => {
  beforeEach(() => {
    loadActiveRoleScorecard.mockResolvedValue(null);
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: JSON.parse(JSON.stringify(v1Fixture)),
      requestedModel: 'deepseek-v4-pro',
    });
  });

  it('persists the legacy v1 dimension payload with no v2 metadata', async () => {
    const result = await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;

    // v1 columns present…
    for (const k of ['english', 'tone', 'communication', 'motivation', 'role_fit', 'overall_score', 'recommendation', 'summary', 'raw', 'provenance']) {
      expect(Object.keys(payload), k).toContain(k);
    }
    // …and no v2 metadata keys.
    for (const k of ['schema_version', 'revision', 'scorecard_version_id', 'metric_results', 'weighted_score_5', 'scoring_status']) {
      expect(Object.keys(payload), k).not.toContain(k);
    }
    expect(result.id).toBe('fresh-row');
    expect((result as Assessment).summary).toBe('Strong candidate');
  });

  it('still fires every post-persist side-effect exactly once', async () => {
    await runAssessment(SESSION_ID);
    expect(insertNotificationIntent).toHaveBeenCalledOnce();
    expect(observeAshbyCompletion).toHaveBeenCalledOnce();
    expect(callsFor('candidates', 'update')).toHaveLength(1);
    expect(callsFor('call_sessions', 'update')).toHaveLength(1);
  });
});
