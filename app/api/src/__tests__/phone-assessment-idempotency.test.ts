/**
 * P4b — `runAssessment({ source: 'phone' })`: scored exactly once, one
 * writeback, and the browser path untouched.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────
 * `services/assessment.ts` documented its own race out loud: *"Idempotent-ish:
 * inserts a new assessment row each call"*, guarded only by a `terminal_reason`
 * flip performed AFTER the insert, with an admitted TOCTOU window.
 * `assessments` carried no uniqueness on `session_id` at all. A reconnecting
 * phone call is precisely the condition that makes two concurrent completions
 * ordinary rather than exotic.
 *
 * 0044 adds `uq_assessments_phone_session`, PARTIAL over `source = 'phone'`,
 * and this file pins what the service does with it: the loser of the race
 * REUSES the winner's row and performs none of the follow-on work — no second
 * notification intent, no second candidate-status update, no second Ashby
 * writeback.
 *
 * ── AND WHAT MUST NOT CHANGE ──────────────────────────────────────────
 * The browser payload. `source` is passed ONLY for the phone path, so a
 * browser insert has exactly the keys it had before this migration and the
 * column default applies — which is what keeps a partial index over the phone
 * partition unable to touch a browser row.
 *
 * Offline and deterministic: Supabase and the provider are the only mocked
 * boundaries, and the real `runAssessmentImpl` runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAssessment,
  injectAssessmentRunner,
  ERR_SESSION_NOT_COMPLETED,
} from '../services/assessment.js';
import type { Assessment } from '../lib/types.js';

const { mockFrom, runClaudeJSONWithProvenance, insertNotificationIntent, observeAshbyCompletion } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    runClaudeJSONWithProvenance: vi.fn(),
    insertNotificationIntent: vi.fn(),
    observeAshbyCompletion: vi.fn(),
  }));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));
vi.mock('../lib/claude.js', () => ({ runClaudeJSONWithProvenance }));
vi.mock('../lib/notification-intent.js', () => ({ insertNotificationIntent }));
vi.mock('../integrations/ashby/completion-observer.js', () => ({ observeAshbyCompletion }));

// ── A per-table RESPONSE QUEUE ──────────────────────────────────────
// The single-response-per-table mock the eligibility suite uses cannot express
// this phase's central case: `assessments` is touched twice on the reuse path
// — the insert that loses, then the read that recovers the winner's row.

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
const WINNER_ID = '00000000-0000-4000-8000-00000000000a';

const assessmentFixture: Assessment = {
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
    role_id: null,
    status: 'completed',
    terminal_reason: 'conversation_complete',
  };
}

const UNIQUE_VIOLATION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "uq_assessments_phone_session"',
  details: 'Key (session_id)=(…) already exists.',
  hint: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  injectAssessmentRunner(null);
  calls = [];
  queues = new Map();
  defaults = new Map();
  setDefault('call_sessions', ok(completedSession()));
  setDefault('transcript_turns', ok([{ speaker: 'bot', text: 'Years?' }]));
  setDefault('candidates', ok({ name: 'Asha', parsed: null, decision_use_blocked_at: null }));
  setDefault('roles', ok({ title: 'Advisor', required_skills: [] }));
  setDefault('assessments', ok({ id: 'fresh-row' }));
  runClaudeJSONWithProvenance.mockImplementation(async () => ({
    data: JSON.parse(JSON.stringify(assessmentFixture)),
    requestedModel: 'sonnet',
  }));
  insertNotificationIntent.mockResolvedValue(undefined);
  observeAshbyCompletion.mockResolvedValue(undefined);
});

afterEach(() => {
  injectAssessmentRunner(null);
});

// ═══════════════════════════════════════════════════════════════════
describe('the BROWSER payload is byte-identical to what it was', () => {
  it('does not carry `source` at all, so the column default applies', async () => {
    await runAssessment(SESSION_ID);
    const insert = callsFor('assessments', 'insert')[0];
    expect(insert).toBeDefined();
    const payload = insert.args[0] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('source');
    // The keys that WERE there are still there — this is a "nothing changed"
    // assertion and it needs a positive half or it passes on an empty object.
    for (const key of ['session_id', 'candidate_id', 'overall_score', 'raw', 'provenance']) {
      expect(Object.keys(payload), key).toContain(key);
    }
  });

  it('an explicit browser source is still not passed', async () => {
    await runAssessment(SESSION_ID, { source: 'browser' });
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('source');
  });

  it('a browser unique violation is NOT swallowed as a reuse', async () => {
    // The partial index does not cover browser rows, so a 23505 here means
    // something else entirely and must surface rather than be papered over.
    enqueue('assessments', { data: null, error: UNIQUE_VIOLATION });
    await expect(runAssessment(SESSION_ID)).rejects.toThrow(/duplicate key/);
    expect(callsFor('assessments', 'maybeSingle')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('the PHONE path is idempotent for real', () => {
  it('passes `source: phone`, which is what the partial index keys on', async () => {
    await runAssessment(SESSION_ID, { source: 'phone' });
    const payload = callsFor('assessments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(payload.source).toBe('phone');
  });

  it('the LOSER of the race reuses the winner\'s row', async () => {
    enqueue(
      'assessments',
      { data: null, error: UNIQUE_VIOLATION },
      ok({ id: WINNER_ID, raw: { ...assessmentFixture, summary: 'the winner\'s summary' } }),
    );
    const result = await runAssessment(SESSION_ID, { source: 'phone' });
    expect(result.id).toBe(WINNER_ID);
    expect(result.summary).toBe('the winner\'s summary');
  });

  it('the loser performs NONE of the follow-on work — exactly one writeback', async () => {
    enqueue(
      'assessments',
      { data: null, error: UNIQUE_VIOLATION },
      ok({ id: WINNER_ID, raw: assessmentFixture }),
    );
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(insertNotificationIntent).not.toHaveBeenCalled();
    expect(observeAshbyCompletion).not.toHaveBeenCalled();
    expect(callsFor('candidates', 'update')).toHaveLength(0);
    expect(callsFor('call_sessions', 'update')).toHaveLength(0);
  });

  it('CONTROL — the WINNER does all of it, exactly once', async () => {
    // Without this the assertion above would pass if the follow-on work had
    // simply been deleted.
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(insertNotificationIntent).toHaveBeenCalledOnce();
    expect(observeAshbyCompletion).toHaveBeenCalledOnce();
    expect(callsFor('candidates', 'update')).toHaveLength(1);
    expect(callsFor('call_sessions', 'update')).toHaveLength(1);
  });

  it('a unique violation with NO recoverable row still fails — reuse is READ, not assumed', async () => {
    enqueue(
      'assessments',
      { data: null, error: UNIQUE_VIOLATION },
      { data: null, error: { message: 'read failed' } },
    );
    await expect(runAssessment(SESSION_ID, { source: 'phone' })).rejects.toThrow(/duplicate key/);
  });

  it('a non-unique insert error is never mistaken for a race', async () => {
    enqueue('assessments', {
      data: null,
      error: { code: '42501', message: 'permission denied for table assessments' },
    });
    await expect(runAssessment(SESSION_ID, { source: 'phone' })).rejects.toThrow(/permission denied/);
    expect(callsFor('assessments', 'maybeSingle')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('an already-scored phone session is a success, not a refusal', () => {
  it('reuses the row when the winner has already flipped terminal_reason', async () => {
    // The ordinary reconnect outcome: the winner scored and moved the session
    // to `assessment_done`, and the loser now arrives at the preflight.
    // Throwing would make the loser report a scoring failure for a screening
    // that IS scored — and the worker would then decline a completion it owes.
    setDefault('call_sessions', ok({ ...completedSession(), terminal_reason: 'assessment_done' }));
    enqueue('assessments', ok({ id: WINNER_ID, raw: assessmentFixture }));
    const result = await runAssessment(SESSION_ID, { source: 'phone' });
    expect(result.id).toBe(WINNER_ID);
    // Nothing was re-scored and nothing was re-written.
    expect(runClaudeJSONWithProvenance).not.toHaveBeenCalled();
    expect(callsFor('assessments', 'insert')).toHaveLength(0);
    expect(observeAshbyCompletion).not.toHaveBeenCalled();
  });

  it('with NO row it still throws — the reuse is read from the database', async () => {
    setDefault('call_sessions', ok({ ...completedSession(), terminal_reason: 'assessment_done' }));
    setDefault('assessments', ok(null));
    await expect(runAssessment(SESSION_ID, { source: 'phone' }))
      .rejects.toThrow(ERR_SESSION_NOT_COMPLETED);
  });

  it('the BROWSER path keeps failing closed on the same session', async () => {
    // The reuse is phone-only, deliberately: widening it would change the
    // browser's documented repeat-guard behaviour under this migration.
    setDefault('call_sessions', ok({ ...completedSession(), terminal_reason: 'assessment_done' }));
    enqueue('assessments', ok({ id: WINNER_ID, raw: assessmentFixture }));
    await expect(runAssessment(SESSION_ID)).rejects.toThrow(ERR_SESSION_NOT_COMPLETED);
    expect(callsFor('assessments')).toHaveLength(0);
  });

  it('an INELIGIBLE session is still refused for the phone path too', async () => {
    for (const status of ['in_progress', 'failed', 'cancelled', 'expired']) {
      calls = [];
      queues = new Map();
      setDefault('call_sessions', ok({ ...completedSession(), status, terminal_reason: null }));
      setDefault('assessments', ok(null));
      await expect(runAssessment(SESSION_ID, { source: 'phone' }), status)
        .rejects.toThrow(ERR_SESSION_NOT_COMPLETED);
      expect(runClaudeJSONWithProvenance, status).not.toHaveBeenCalled();
    }
  });
});
