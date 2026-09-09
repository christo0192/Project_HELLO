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
      data: { results: modelResults([5, 3, 1]) },
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
    expect(payload.weighted_score_5).toBe(3.6);
    expect(payload.overall_score).toBe(65);
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

  it('an incomplete-evidence result nulls the weighted score and recommendation column', async () => {
    runClaudeJSONWithProvenance.mockResolvedValue({
      data: { results: modelResults([5, 3, null]) },
      requestedModel: 'deepseek-v4-pro',
    });
    await runAssessment(SESSION_ID);
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.scoring_status).toBe('incomplete_evidence');
    expect(payload.weighted_score_5).toBeNull();
    expect(payload.overall_score).toBeNull();
    // human_review is not an allowed value for chk_assessments_recommendation,
    // so the column is stored NULL (the true value lives in raw/metric_results).
    expect(payload.recommendation).toBeNull();
  });

  it('a phone v2 assessment carries source=phone and revision=1 (index coverage)', async () => {
    await runAssessment(SESSION_ID, { source: 'phone' });
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.source).toBe('phone');
    expect(payload.revision).toBe(1);
    expect(payload.schema_version).toBe(2);
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
