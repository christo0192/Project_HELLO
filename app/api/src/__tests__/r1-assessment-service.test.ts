/**
 * services/r1-assessment.ts: the orchestration around the scorer. The SQL semantics of the
 * attach/apply RPCs (CAS, 24 h window, override monitor) are proven on real Postgres by
 * app/supabase/tests/r1_scorer_assert.sql; these tests prove the service drives them correctly,
 * is idempotent, and fails closed to human_review.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_ID,
  ROUND_ID,
  SESSION_ID,
  baseTables,
  createFakeDb,
  happyRpc,
  type FakeDb,
  type Tables,
} from './support/r1-fake-db.js';
import { METRIC_IDS, cleanLogRows, interviewRows, modelAnswer } from './support/r1-scorer.js';
import { R1_METRICS, R1_METRIC_KEYS } from '../lib/r1/rubric.js';
import { runR1Assessment, r1ErrorCode, r1OperatorMessage } from '../services/r1-assessment.js';
import { createR1DeepseekRunner, createR1Infer } from '../lib/r1/deepseek-runner.js';
import { DeepseekError } from '../lib/deepseek.js';
import { BusinessError, ProviderError } from '../lib/provider-resilience.js';
import { ScorecardValidationError } from '../lib/scorecards/domain.js';
import { validateProvenance } from '../lib/model-provenance.js';

const NOW = new Date('2026-10-06T10:30:00Z');
const rows = interviewRows();

const allScores = (score: number | null) =>
  Object.fromEntries(R1_METRICS.map((metric) => [metric.key, score]));

function tablesWithInterview(options: { logRows?: ReturnType<typeof cleanLogRows>; turns?: typeof rows } = {}): Tables {
  const tables = baseTables();
  tables.transcript_turns = (options.turns ?? rows).map((row) => ({ ...row, session_id: SESSION_ID, is_gate: false }));
  tables.r1_admin_log = (options.logRows ?? cleanLogRows()).map((row) => ({ ...row, session_id: SESSION_ID, round_id: ROUND_ID }));
  return tables;
}

function setup(tables: Tables, rpc = happyRpc()): { db: FakeDb; rpc: ReturnType<typeof happyRpc> } {
  return { db: createFakeDb(tables, rpc), rpc };
}

const goodInfer = () => vi.fn(async (_prompt: string) => modelAnswer(rows, allScores(3)));

beforeEach(() => vi.restoreAllMocks());

describe('a valid gated score', () => {
  it('scores three times, stores a v2 assessment and settles the round', async () => {
    const { db } = setup(tablesWithInterview());
    const infer = goodInfer();
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });

    expect(infer).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      sessionId: SESSION_ID, roundId: ROUND_ID, recommendation: 'advance', valid: true,
      reused: false, attach: 'ok', statusWrite: 'flag_off',
    });
    expect(db.tables.assessments).toHaveLength(1);
    const row = db.tables.assessments![0]!;
    expect(row).toMatchObject({
      session_id: SESSION_ID,
      candidate_id: CANDIDATE_ID,
      schema_version: 2,
      revision: 1,
      scorecard_version_id: '20000000-0000-4000-8000-000000000001',
      score_scale_max: 4,
      weighted_score_5: 3,
      scoring_status: 'complete',
      overall_score: 67,
      recommendation: 'advance',
    });
    expect(row.supersedes_assessment_id).toBeUndefined();
    expect(row.source).toBeUndefined();
    expect(row.raw.recommendation).toBe('advance');
    expect(row.raw.r1).toMatchObject({
      outcome: 'scored',
      valid: true,
      scored_recommendation: 'advance',
      gate: { passed: true, failures: [] },
      agreement: { runs_agree: true, disagreement: [] },
      thresholds: { advance: 65, hold: 45 },
    });
    expect(row.raw.r1.administration_quality).toMatchObject({ status: 'ok', failures: [] });
    expect(row.raw.r1.versions).toMatchObject({
      scorer: 'r1-scoring-2026-10.1', rubric: 'r1-rubric-2026-10.2', deck_facts: 'r1-deck-facts-2026-10.1',
    });
    // The phone scorer's template version is not used: R1 has its own provenance version.
    expect(validateProvenance(row.provenance).valid).toBe(true);
    expect(row.provenance).toMatchObject({
      provider: 'deepseek', workload: 'scoring', prompt_template_version: 'r1-scoring-2026-10.1',
    });
    // Evidence is stored as strings (the shared panel) and structured (the player).
    const first = row.metric_results[0];
    expect(first.configMetricId).toBe(METRIC_IDS[R1_METRIC_KEYS.probing]);
    expect(first.evidenceRefs[0]).toMatch(/^T\d+: /);
    expect(first.evidence[0]).toMatchObject({ turn_index: expect.any(Number), quote: expect.any(String) });
  });

  it('attaches then applies, passing the recommendation, score, validity and audit metadata', async () => {
    const { db } = setup(tablesWithInterview());
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(['r1_attach_assessment', 'r1_apply_status_effect']);
    const [attach, apply] = db.rpcCalls;
    const assessmentId = db.tables.assessments![0]!.id;
    expect(attach!.args).toMatchObject({
      p_round_id: ROUND_ID, p_session_id: SESSION_ID, p_assessment_id: assessmentId,
      p_recommendation: 'advance', p_overall: 67, p_valid: true, p_now: NOW.toISOString(),
    });
    expect(apply!.args).toMatchObject({
      p_round_id: ROUND_ID, p_assessment_id: assessmentId, p_recommendation: 'advance',
    });
    expect(attach!.args.p_audit).toMatchObject({
      scorer_version: 'r1-scoring-2026-10.1',
      rubric_version: 'r1-rubric-2026-10.2',
      deck_facts_version: 'r1-deck-facts-2026-10.1',
      outcome: 'scored',
      thresholds: { advance: 65, hold: 45, settings_updated_at: '2026-10-06T09:00:00+00:00' },
      gate_passed: true,
      gate_failures: [],
      runs_agree: true,
    });
  });

  it('keeps audit metadata small (audit_events metadata is capped at 4 KB) and free of candidate text', async () => {
    const { db } = setup(tablesWithInterview());
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    const audit = JSON.stringify(db.rpcCalls[0]!.args.p_audit);
    expect(Buffer.byteLength(audit)).toBeLessThan(1200);
    expect(audit).not.toMatch(/Meera|Ava|O'Neil|current role/);
  });

  it('uses the thresholds stored in r1_settings', async () => {
    const tables = tablesWithInterview();
    tables.r1_settings![0]!.advance_threshold = '80.00';
    const { db } = setup(tables);
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result.recommendation).toBe('hold');
    expect(db.tables.assessments![0]!.recommendation).toBe('hold');
    expect(db.tables.assessments![0]!.raw.r1.thresholds).toEqual({ advance: 80, hold: 45 });
  });

  it('shows the model a masked transcript (no candidate name, no commitment line)', async () => {
    const { db } = setup(tablesWithInterview());
    const infer = goodInfer();
    await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    const prompt = infer.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("O'Neil");
    expect(prompt).not.toMatch(/\bAva\b/);
    expect(prompt).not.toContain('pay the deposit today');
    expect(prompt).toContain('[learner commitment response masked]');
    expect(prompt).toContain('Learner (simulated by the AI; never evidence)');
  });
});

describe('fail closed to human_review (no status effect)', () => {
  it('a gate failure (the worker never reported session_facts) stores human_review but keeps the score', async () => {
    const logRows = cleanLogRows().filter((row) => row.event_type !== 'session_facts');
    const { db } = setup(tablesWithInterview({ logRows }));
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false });
    const row = db.tables.assessments![0]!;
    expect(row.recommendation).toBeNull();
    expect(row.overall_score).toBe(67);
    expect(row.scoring_status).toBe('complete');
    expect(row.raw.recommendation).toBe('human_review');
    expect(row.raw.r1.scored_recommendation).toBe('advance');
    expect(row.raw.r1.gate.passed).toBe(false);
    expect(row.raw.r1.gate.failures).toContain('fidelity_facts_missing');
    expect(row.raw.r1.administration_quality.status).toBe('review');
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'human_review', p_valid: false, p_overall: 67 });
    expect(db.rpcCalls[1]!.args).toMatchObject({ p_recommendation: 'human_review' });
  });

  it('disagreeing runs store human_review with the disagreement recorded', async () => {
    let calls = 0;
    const infer = vi.fn(async () => modelAnswer(rows, allScores(calls++ === 0 ? 2 : 3)));
    const { db } = setup(tablesWithInterview());
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(result.recommendation).toBe('human_review');
    const row = db.tables.assessments![0]!;
    expect(row.raw.r1.agreement).toEqual({ runs_agree: false, disagreement: ['recommendation_differs'] });
    expect(row.raw.r1.gate.failures).toContain('runs_disagree');
  });

  it('a candidate with no evidence-eligible speech gets a placeholder and NO model call', async () => {
    const botOnly = rows.filter((row) => row.speaker === 'bot');
    const { db } = setup(tablesWithInterview({ turns: botOnly }));
    const infer = goodInfer();
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false });
    const row = db.tables.assessments![0]!;
    expect(row.scoring_status).toBe('incomplete_evidence');
    expect(row.weighted_score_5).toBeNull();
    expect(row.recommendation).toBeNull();
    expect(row.raw.r1.outcome).toBe('no_candidate_speech');
    expect(row.metric_results).toHaveLength(5);
    expect(row.metric_results.every((m: any) => m.evidenceStatus === 'insufficient_evidence' && m.score === null)).toBe(true);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'human_review', p_valid: false, p_overall: null });
  });

  it('an incomplete scorecard (a metric insufficient in every run) is human_review', async () => {
    const infer = vi.fn(async () => modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.negotiation]: null }));
    const { db } = setup(tablesWithInterview());
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(result.recommendation).toBe('human_review');
    expect(db.tables.assessments![0]!.scoring_status).toBe('incomplete_evidence');
    expect(db.tables.assessments![0]!.recommendation).toBeNull();
  });
});

describe('provider and validation failures', () => {
  it('a non-final failure throws a sanitized code and writes nothing', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('timeout'); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW }))
      .rejects.toThrow('deepseek_timeout');
    expect(db.tables.assessments).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('the FINAL attempt records a human_review placeholder, then rethrows for the DLQ', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('timeout'); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('deepseek_timeout');
    expect(db.tables.assessments).toHaveLength(1);
    const row = db.tables.assessments![0]!;
    expect(row).toMatchObject({
      schema_version: 2, revision: 1, scoring_status: 'incomplete_evidence',
      weighted_score_5: null, overall_score: null, recommendation: null,
    });
    expect(row.raw.recommendation).toBe('human_review');
    expect(row.raw.r1).toMatchObject({ outcome: 'scoring_failed', valid: false, code: 'deepseek_timeout' });
    expect(row.metric_results).toHaveLength(5);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['r1_attach_assessment', 'r1_apply_status_effect']);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'human_review', p_valid: false });
    expect(JSON.stringify(row.raw)).not.toMatch(/Meera|Ava|O'Neil/);
  });

  it('a malformed model answer that survives its repair carries the validation code', async () => {
    const infer = vi.fn(async () => ({ results: 'not an array' }));
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('scorecard_invalid:results_missing');
    expect(db.tables.assessments![0]!.raw.r1.code).toBe('scorecard_invalid:results_missing');
  });

  it('a missing scorecard fails closed with an empty placeholder on the final attempt', async () => {
    const tables = tablesWithInterview();
    tables.roles![0]!.active_scorecard_version_id = null;
    const { db } = setup(tables);
    const infer = goodInfer();
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('r1_scorecard_missing');
    expect(infer).not.toHaveBeenCalled();
    const row = db.tables.assessments![0]!;
    expect(row.scorecard_version_id).toBeNull();
    expect(row.metric_results).toEqual([]);
    expect(row.raw.r1.code).toBe('r1_scorecard_missing');
  });

  it('does not stack a second placeholder when one already exists and the retry fails again', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('connection'); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true })).rejects.toThrow();
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true })).rejects.toThrow();
    expect(db.tables.assessments).toHaveLength(1);
  });

  it('a 402 on the final attempt throws deepseek_insufficient_balance and records an operator-readable placeholder', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('protocol', 402); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('deepseek_insufficient_balance');
    expect(db.tables.assessments).toHaveLength(1);
    const row = db.tables.assessments![0]!;
    expect(row.raw.r1).toMatchObject({ outcome: 'scoring_failed', valid: false, code: 'deepseek_insufficient_balance' });
    expect(row.raw.recommendation).toBe('human_review');
    expect(row.recommendation).toBeNull();
    const rationale = row.metric_results[0].rationale as string;
    expect(rationale).toContain('the DeepSeek balance is exhausted');
    expect(rationale).toContain('the job can be replayed after the top-up');
    expect(rationale).toContain('human review is required');
    expect(row.metric_results.every((m: any) => m.rationale === rationale)).toBe(true);
  });

  it('a second final failure with another code does not stack or overwrite the placeholder', async () => {
    const { db } = setup(tablesWithInterview());
    const first = vi.fn(async () => { throw new DeepseekError('protocol', 402); });
    const second = vi.fn(async () => { throw new DeepseekError('protocol', 401); });
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer: first, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('deepseek_insufficient_balance');
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer: second, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('deepseek_auth');
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]!.raw.r1.code).toBe('deepseek_insufficient_balance');
  });

  it('a final attempt the handler will DEFER writes no placeholder and runs no round RPC, but still rethrows', async () => {
    const asked: string[] = [];
    const willDefer = (code: string): boolean => { asked.push(code); return true; };
    const infer = vi.fn(async () => { throw new DeepseekError('protocol', 429); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, {
      client: db.client, infer, now: () => NOW, finalAttempt: true, willDefer,
    })).rejects.toThrow('deepseek_rate_limited');
    // The predicate gets the sanitized code, never the error object or provider text.
    expect(asked).toEqual(['deepseek_rate_limited']);
    expect(db.tables.assessments).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('a final attempt the handler will NOT defer records the placeholder exactly as before', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('timeout'); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, {
      client: db.client, infer, now: () => NOW, finalAttempt: true, willDefer: () => false,
    })).rejects.toThrow('deepseek_timeout');
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]!.raw.r1).toMatchObject({ outcome: 'scoring_failed', code: 'deepseek_timeout' });
  });

  it('willDefer never matters before the final attempt: nothing is written either way', async () => {
    for (const willDefer of [() => true, () => false, undefined]) {
      const infer = vi.fn(async () => { throw new DeepseekError('protocol', 402); });
      const { db } = setup(tablesWithInterview());
      await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, willDefer }))
        .rejects.toThrow('deepseek_insufficient_balance');
      expect(db.tables.assessments).toHaveLength(0);
    }
  });

  it('logs the HTTP status with the code, and never the key or the provider text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.DEEPSEEK_API_KEY = 'sk-test-key-must-never-appear';
    try {
      const infer = vi.fn(async () => { throw new DeepseekError('protocol', 402); });
      const { db } = setup(tablesWithInterview());
      await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW }))
        .rejects.toThrow('deepseek_insufficient_balance');
      const lines = warn.mock.calls.map((call) => String(call[0]));
      const line = lines.find((entry) => entry.includes('r1_assessment_failed'));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string)).toMatchObject({
        error_category: 'r1_assessment_failed',
        rejection_reason: 'deepseek_insufficient_balance',
        http_status: 402,
      });
      expect(lines.join('\n')).not.toContain('sk-test-key-must-never-appear');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it('a failure with no HTTP status logs no http_status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infer = vi.fn(async () => { throw new DeepseekError('timeout'); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW })).rejects.toThrow();
    const line = warn.mock.calls.map((call) => String(call[0])).find((entry) => entry.includes('r1_assessment_failed'));
    expect(JSON.parse(line as string)).not.toHaveProperty('http_status');
  });
});

describe('scoring order (run 0 first)', () => {
  it('a provider failure on run 0 costs ONE model call, not three', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('protocol', 402); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW }))
      .rejects.toThrow('deepseek_insufficient_balance');
    expect(infer).toHaveBeenCalledTimes(1);
  });
});

describe('a real provider answer through the R1 runner', () => {
  const answerWith = (status: number, body: string) => vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));

  it.each([
    [402, 'deepseek_insufficient_balance'],
    [401, 'deepseek_auth'],
    [429, 'deepseek_rate_limited'],
    [503, 'deepseek_server_error'],
    [400, 'deepseek_http_400'],
  ])('HTTP %i reaches the queue as %s, after ONE call, with no provider text or key stored', async (status, code) => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-key-must-never-appear';
    try {
      const transport = answerWith(status, '{"error":{"message":"PROVIDER_BODY_TEXT Insufficient Balance"}}');
      const infer = createR1Infer(createR1DeepseekRunner({ transport }));
      const { db } = setup(tablesWithInterview());
      await expect(runR1Assessment(SESSION_ID, {
        client: db.client, infer, now: () => NOW, finalAttempt: true,
      })).rejects.toThrow(code);
      expect(transport).toHaveBeenCalledTimes(1);
      const stored = JSON.stringify(db.tables.assessments);
      expect(stored).toContain(code);
      expect(stored).not.toContain('PROVIDER_BODY_TEXT');
      expect(stored).not.toContain('sk-test-key-must-never-appear');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it('a 200 with an unusable body stays deepseek_protocol (no status to name)', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-key-must-never-appear';
    try {
      const transport = answerWith(200, '{"choices":[]}');
      const infer = createR1Infer(createR1DeepseekRunner({ transport }));
      const { db } = setup(tablesWithInterview());
      await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW }))
        .rejects.toThrow('deepseek_protocol');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

describe('a role whose active scorecard is not the R1 scorecard (fail closed, no model call)', () => {
  /** What the 0089 trigger attaches to every new role: five equal-weight phone metrics. */
  function withPhoneDefaultMetrics(tables: Tables): Tables {
    const keys = ['accuracy', 'communication', 'tone', 'role_fit', 'professionalism'];
    tables.role_scorecard_version_metrics!.forEach((row, index) => {
      row.metric_key = keys[index];
      row.weight_bps = 2000;
    });
    return tables;
  }

  it('records a human_review placeholder with r1_scorecard_mismatch and never calls the model', async () => {
    const { db } = setup(withPhoneDefaultMetrics(tablesWithInterview()));
    const infer = goodInfer();
    // A NON-final attempt: configuration cannot be fixed by retrying, so it must not throw.
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false, reused: false });
    expect(db.tables.assessments).toHaveLength(1);
    const row = db.tables.assessments![0]!;
    expect(row).toMatchObject({ recommendation: null, scoring_status: 'incomplete_evidence', overall_score: null });
    expect(row.raw.r1).toMatchObject({ outcome: 'scoring_failed', valid: false, code: 'r1_scorecard_mismatch' });
    expect(row.raw.r1.gate.failures).toEqual(['r1_scorecard_mismatch']);
    // The phone metrics are never shown as R1 metrics on the HR card.
    expect(row.metric_results).toEqual([]);
    expect(row.scorecard_version_id).toBeNull();
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(['r1_attach_assessment', 'r1_apply_status_effect']);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'human_review', p_valid: false, p_overall: null });
    expect(db.rpcCalls[1]!.args).toMatchObject({ p_recommendation: 'human_review' });
  });

  it('never writes a gated recommendation, whatever the model would have said', async () => {
    const { db } = setup(withPhoneDefaultMetrics(tablesWithInterview()));
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(db.tables.assessments!.every((row) => row.recommendation === null)).toBe(true);
    expect(db.rpcCalls.every((call) => call.args.p_recommendation === 'human_review')).toBe(true);
  });

  it.each([
    ['a missing R1 metric', (tables: Tables) => { tables.role_scorecard_version_metrics!.pop(); }],
    ['an extra metric', (tables: Tables) => {
      tables.role_scorecard_version_metrics!.push({
        ...tables.role_scorecard_version_metrics![0]!, id: 'extra', metric_key: 'r1_extra', display_order: 9,
      });
    }],
    ['a re-weighted R1 metric', (tables: Tables) => { tables.role_scorecard_version_metrics![0]!.weight_bps = 3000; }],
  ])('refuses %s', async (_name, arrange) => {
    const tables = tablesWithInterview();
    arrange(tables);
    const { db } = setup(tables);
    const infer = goodInfer();
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).not.toHaveBeenCalled();
    expect(result.recommendation).toBe('human_review');
    expect(db.tables.assessments![0]!.raw.r1.code).toBe('r1_scorecard_mismatch');
  });

  it('still scores the exact R1 scorecard with recruiter-edited instructions and anchors', async () => {
    const tables = tablesWithInterview();
    tables.role_scorecard_version_metrics![0]!.instruction = 'Recruiter edited instruction.';
    tables.role_scorecard_version_metrics![0]!.rubric = { '1': 'one', '2': 'two', '3': 'three', '4': 'four' };
    const { db } = setup(tables);
    const infer = goodInfer();
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).toHaveBeenCalledTimes(3);
    expect(result.recommendation).toBe('advance');
  });

  it('is idempotent: a re-run re-drives the RPCs and does not stack a second placeholder', async () => {
    const { db } = setup(withPhoneDefaultMetrics(tablesWithInterview()));
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    db.rpcCalls.length = 0;
    const again = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(db.tables.assessments).toHaveLength(1);
    expect(again).toMatchObject({ reused: true, recommendation: 'human_review', valid: false });
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(['r1_attach_assessment', 'r1_apply_status_effect']);
  });

  it('a later fix of the scorecard supersedes the placeholder with a real score (revision 2)', async () => {
    const tables = withPhoneDefaultMetrics(tablesWithInterview());
    const { db } = setup(tables);
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    const placeholderId = db.tables.assessments![0]!.id;
    // The owner runs the seed: the active scorecard is now the R1 one.
    tables.role_scorecard_version_metrics = baseTables().role_scorecard_version_metrics;
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(db.tables.assessments).toHaveLength(2);
    expect(db.tables.assessments![1]).toMatchObject({
      revision: 2, supersedes_assessment_id: placeholderId, recommendation: 'advance',
    });
    expect(result).toMatchObject({ valid: true, recommendation: 'advance', reused: false });
  });
});

describe('a settlement failure after a scored row was stored (final attempt)', () => {
  /** The attach RPC fails once (transient), then every call succeeds. */
  function flakyAttach() {
    let attachCalls = 0;
    return vi.fn((fn: string) => {
      if (fn === 'r1_attach_assessment') {
        attachCalls += 1;
        return attachCalls === 1 ? { error: { message: 'transient' } } : { data: { status: 'ok', attached: true } };
      }
      return { data: { status: 'ok', status_write: 'flag_off' } };
    });
  }

  it('does not stack a human_review placeholder over the scored row', async () => {
    const { db } = setup(tablesWithInterview(), flakyAttach() as never);
    await expect(runR1Assessment(SESSION_ID, {
      client: db.client, infer: goodInfer(), now: () => NOW, finalAttempt: true,
    })).rejects.toThrow('r1_attach_failed');
    // Only the scored row exists, and it is still the truth: advance, valid.
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]).toMatchObject({ recommendation: 'advance', revision: 1 });
    expect(db.tables.assessments![0]!.raw.r1).toMatchObject({ outcome: 'scored', valid: true });
    // The failed attach was the only RPC call: nothing attached the scored row as human_review.
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(['r1_attach_assessment']);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'advance', p_valid: true });
  });

  it('a DLQ replay adopts the scored row and settles it as advance, without the model', async () => {
    const { db } = setup(tablesWithInterview(), flakyAttach() as never);
    await expect(runR1Assessment(SESSION_ID, {
      client: db.client, infer: goodInfer(), now: () => NOW, finalAttempt: true,
    })).rejects.toThrow('r1_attach_failed');
    db.rpcCalls.length = 0;
    const infer = goodInfer();
    const replay = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true });
    expect(infer).not.toHaveBeenCalled();
    expect(replay).toMatchObject({ reused: true, valid: true, recommendation: 'advance' });
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'advance', p_valid: true, p_overall: 67 });
  });

  it('still records the placeholder when the failure came BEFORE any scored row (control)', async () => {
    const infer = vi.fn(async () => { throw new DeepseekError('output_limit'); });
    const { db } = setup(tablesWithInterview());
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW, finalAttempt: true }))
      .rejects.toThrow('deepseek_output_limit');
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]!.raw.r1.outcome).toBe('scoring_failed');
  });
});

describe('idempotent re-run', () => {
  it('adopts a scored assessment, never calls the model again and re-drives both RPCs', async () => {
    const { db } = setup(tablesWithInterview());
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    const firstId = db.tables.assessments![0]!.id;
    db.rpcCalls.length = 0;

    const infer = goodInfer();
    const again = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).not.toHaveBeenCalled();
    expect(db.tables.assessments).toHaveLength(1);
    expect(again).toMatchObject({
      assessmentId: firstId, reused: true, valid: true, recommendation: 'advance',
    });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['r1_attach_assessment', 'r1_apply_status_effect']);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_assessment_id: firstId, p_recommendation: 'advance', p_valid: true, p_overall: 67 });
  });

  it('adopts a stored human_review assessment as invalid', async () => {
    const logRows = cleanLogRows().filter((row) => row.event_type !== 'session_facts');
    const { db } = setup(tablesWithInterview({ logRows }));
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    db.rpcCalls.length = 0;
    const infer = goodInfer();
    const again = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).not.toHaveBeenCalled();
    expect(again).toMatchObject({ reused: true, valid: false, recommendation: 'human_review' });
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_recommendation: 'human_review', p_valid: false });
  });

  it('a failure placeholder is superseded by a successful re-score (revision 2)', async () => {
    const { db } = setup(tablesWithInterview());
    const failing = vi.fn(async () => { throw new DeepseekError('timeout'); });
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer: failing, now: () => NOW, finalAttempt: true })).rejects.toThrow();
    const placeholderId = db.tables.assessments![0]!.id;
    db.rpcCalls.length = 0;

    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(db.tables.assessments).toHaveLength(2);
    const second = db.tables.assessments![1]!;
    expect(second).toMatchObject({ revision: 2, supersedes_assessment_id: placeholderId, recommendation: 'advance' });
    expect(result).toMatchObject({ assessmentId: second.id, reused: false, valid: true });
  });

  it('adopts the winner when a concurrent run takes the (session, revision) slot (23505)', async () => {
    const tables = tablesWithInterview();
    const { db } = setup(tables);
    const infer = vi.fn(async () => {
      // A competing worker finishes first, between our read and our insert.
      if (tables.assessments!.length === 0) {
        tables.assessments!.push({
          id: 'winner', session_id: SESSION_ID, schema_version: 2, revision: 1,
          recommendation: 'hold', overall_score: 55, raw: { r1: { outcome: 'scored', valid: true } },
        });
      }
      return modelAnswer(rows, allScores(3));
    });
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(tables.assessments).toHaveLength(1);
    expect(result.assessmentId).toBe('winner');
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_assessment_id: 'winner' });
  });
});

describe('round settlement outcomes', () => {
  it('does not apply a status effect when a newer attempt already owns the round', async () => {
    const rpc = vi.fn((fn: string) => (fn === 'r1_attach_assessment'
      ? { data: { status: 'superseded_by_newer' } }
      : { data: { status: 'ok', status_write: 'advanced' } }));
    const { db } = setup(tablesWithInterview(), rpc as never);
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result).toMatchObject({ attach: 'superseded_by_newer', statusWrite: null });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['r1_attach_assessment']);
  });

  it('reports a lost CAS (a human changed the candidate) without failing the job', async () => {
    const rpc = vi.fn((fn: string) => (fn === 'r1_attach_assessment'
      ? { data: { status: 'ok' } }
      : { data: { status: 'ok', status_write: 'cas_lost' } }));
    const { db } = setup(tablesWithInterview(), rpc as never);
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result.statusWrite).toBe('cas_lost');
  });

  it('reports pending_reject and already_applied outcomes as-is', async () => {
    const pending = setup(tablesWithInterview(), vi.fn((fn: string) => (fn === 'r1_attach_assessment'
      ? { data: { status: 'ok' } }
      : { data: { status: 'ok', status_write: 'pending_reject' } })) as never);
    expect((await runR1Assessment(SESSION_ID, { client: pending.db.client, infer: goodInfer(), now: () => NOW })).statusWrite)
      .toBe('pending_reject');
    const applied = setup(tablesWithInterview(), vi.fn((fn: string) => (fn === 'r1_attach_assessment'
      ? { data: { status: 'ok' } }
      : { data: { status: 'already_applied', status_write: 'advanced' } })) as never);
    expect((await runR1Assessment(SESSION_ID, { client: applied.db.client, infer: goodInfer(), now: () => NOW })).statusWrite)
      .toBe('advanced');
  });

  it('throws sanitized codes when an RPC errors or answers an unexpected status (the job retries)', async () => {
    const attachError = setup(tablesWithInterview(), vi.fn(() => ({ error: { message: 'secret detail' } })) as never);
    await expect(runR1Assessment(SESSION_ID, { client: attachError.db.client, infer: goodInfer(), now: () => NOW }))
      .rejects.toThrow('r1_attach_failed');
    const badStatus = setup(tablesWithInterview(), vi.fn(() => ({ data: { status: 'session_not_in_round' } })) as never);
    await expect(runR1Assessment(SESSION_ID, { client: badStatus.db.client, infer: goodInfer(), now: () => NOW }))
      .rejects.toThrow('r1_attach_session_not_in_round');
    const applyError = setup(tablesWithInterview(), vi.fn((fn: string) => (fn === 'r1_attach_assessment'
      ? { data: { status: 'ok' } }
      : { error: { message: 'x' } })) as never);
    await expect(runR1Assessment(SESSION_ID, { client: applyError.db.client, infer: goodInfer(), now: () => NOW }))
      .rejects.toThrow('r1_status_effect_failed');
  });
});

describe('session guards', () => {
  it('refuses unknown, non-R1, and unfinished sessions with stable codes', async () => {
    const missing = setup({ ...tablesWithInterview(), call_sessions: [] });
    await expect(runR1Assessment(SESSION_ID, { client: missing.db.client, infer: goodInfer() })).rejects.toThrow('r1_session_not_found');

    const phone = tablesWithInterview();
    phone.call_sessions![0]!.interview_round_id = null;
    await expect(runR1Assessment(SESSION_ID, { client: setup(phone).db.client, infer: goodInfer() })).rejects.toThrow('r1_session_invalid');

    const live = tablesWithInterview();
    live.call_sessions![0]!.mode = 'live';
    await expect(runR1Assessment(SESSION_ID, { client: setup(live).db.client, infer: goodInfer() })).rejects.toThrow('r1_session_invalid');

    const running = tablesWithInterview();
    running.call_sessions![0]!.status = 'in_progress';
    const infer = goodInfer();
    await expect(runR1Assessment(SESSION_ID, { client: setup(running).db.client, infer })).rejects.toThrow('r1_session_not_completed');
    expect(infer).not.toHaveBeenCalled();
  });

  it('refuses a session whose attempt row is missing', async () => {
    const tables = tablesWithInterview();
    tables.interview_round_attempts = [];
    await expect(runR1Assessment(SESSION_ID, { client: setup(tables).db.client, infer: goodInfer(), now: () => NOW }))
      .rejects.toThrow('r1_attempt_missing');
  });

  it('a system-failure attempt outcome fails the gate (human_review)', async () => {
    const tables = tablesWithInterview();
    tables.interview_round_attempts![0]!.outcome = 'provider_error';
    const { db } = setup(tables);
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result.recommendation).toBe('human_review');
    expect(db.tables.assessments![0]!.raw.r1.gate.failures).toContain('system_failure_outcome');
  });
});

describe('a COUNTED attempt that did not complete is still scored (never a dead-ended round)', () => {
  /** The candidate left (or the residency cap hit) after the role-play began: counted per plan D1. */
  function failedCounted(
    outcome: 'candidate_left' | 'residency_timeout',
    terminal: 'worker_crash' | 'residency_timeout',
    options: { turns?: typeof rows } = {},
  ): Tables {
    const tables = tablesWithInterview({ turns: options.turns });
    tables.call_sessions![0] = { ...tables.call_sessions![0]!, status: 'failed', terminal_reason: terminal };
    tables.interview_round_attempts![0] = {
      ...tables.interview_round_attempts![0]!, outcome, counted: true,
    };
    tables.interview_round_consents = [{ id: 'consent-1', round_id: ROUND_ID, withdrawn_at: null }];
    return tables;
  }

  it('scores a candidate who left after the role-play: a real scorecard, human_review, and the reason', async () => {
    const { db, rpc } = setup(failedCounted('candidate_left', 'worker_crash'));
    const infer = goodInfer();
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });

    expect(infer).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false, attach: 'ok' });
    const row = db.tables.assessments![0]!;
    expect(row.scoring_status).toBe('complete');
    expect(row.overall_score).toBe(67);
    // Stored NULL (the CHECK admits only advance|hold|reject); human_review preserved in raw.
    expect(row.recommendation).toBeNull();
    expect(row.raw.recommendation).toBe('human_review');
    expect(row.raw.r1.scored_recommendation).toBe('advance');
    expect(row.raw.r1.valid).toBe(false);
    expect(row.raw.r1.gate.failures).toEqual(['session_not_completed', 'session_not_clean']);
    expect(row.raw.r1.administration_quality.status).toBe('review');
    // The round is settled: attach then apply, neither valid nor with a status effect.
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(db.rpcCalls[0]).toMatchObject({ fn: 'r1_attach_assessment' });
    expect(db.rpcCalls[0]!.args).toMatchObject({
      p_round_id: ROUND_ID, p_session_id: SESSION_ID, p_recommendation: 'human_review', p_valid: false, p_overall: 67,
    });
    expect(db.rpcCalls[1]).toMatchObject({ fn: 'r1_apply_status_effect' });
    expect(db.rpcCalls[1]!.args).toMatchObject({ p_recommendation: 'human_review' });
  });

  it('a residency-timeout end also records the system failure', async () => {
    const { db } = setup(failedCounted('residency_timeout', 'residency_timeout'));
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false });
    expect(db.tables.assessments![0]!.raw.r1.gate.failures)
      .toEqual(['system_failure_outcome', 'session_not_completed', 'session_not_clean']);
  });

  it('an incomplete role-play is scored with its coverage gaps listed, never silently', async () => {
    // The candidate gave only the first two role-play answers and left.
    const firstTwo = new Set(
      rows.filter((r) => r.speaker === 'candidate' && r.phase === 'roleplay').slice(0, 2).map((r) => r.turn_index),
    );
    const turns = rows.filter((r) => r.phase !== 'wrapup' && r.phase !== 'closing' && r.phase !== 'roleplay_exit'
      && !(r.speaker === 'candidate' && r.phase === 'roleplay' && !firstTwo.has(r.turn_index)));
    const { db } = setup(failedCounted('candidate_left', 'worker_crash', { turns }));
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false });
    const failures = db.tables.assessments![0]!.raw.r1.gate.failures as string[];
    expect(failures).toEqual(expect.arrayContaining(['too_few_candidate_turns', 'session_not_completed', 'session_not_clean']));
  });

  it('a failed session with no candidate speech gets the human_review placeholder and no model call', async () => {
    const botOnly = rows.filter((r) => r.speaker === 'bot');
    const { db } = setup(failedCounted('candidate_left', 'worker_crash', { turns: botOnly }));
    const infer = goodInfer();
    const result = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recommendation: 'human_review', valid: false });
    expect(db.tables.assessments![0]!.raw.r1.outcome).toBe('no_candidate_speech');
  });

  it('is idempotent: a second run adopts the stored row and never calls the model again', async () => {
    const { db } = setup(failedCounted('candidate_left', 'worker_crash'));
    const infer = goodInfer();
    await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    const again = await runR1Assessment(SESSION_ID, { client: db.client, infer, now: () => NOW });
    expect(infer).toHaveBeenCalledTimes(3);
    expect(again).toMatchObject({ reused: true, recommendation: 'human_review', valid: false });
    expect(db.tables.assessments).toHaveLength(1);
  });

  it('never scores an UNCOUNTED failed attempt (no-show, early exit, system failure)', async () => {
    const tables = failedCounted('candidate_left', 'worker_crash');
    tables.interview_round_attempts![0]!.counted = false;
    const infer = goodInfer();
    await expect(runR1Assessment(SESSION_ID, { client: setup(tables).db.client, infer }))
      .rejects.toThrow('r1_session_not_completed');
    expect(infer).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'expired', 'in_progress', 'waiting', 'created'])(
    'never scores a %s session, counted or not',
    async (status) => {
      const tables = failedCounted('candidate_left', 'worker_crash');
      tables.call_sessions![0]!.status = status;
      const infer = goodInfer();
      await expect(runR1Assessment(SESSION_ID, { client: setup(tables).db.client, infer }))
        .rejects.toThrow('r1_session_not_completed');
      expect(infer).not.toHaveBeenCalled();
    },
  );

  it('never scores a failed session once the consent was withdrawn (a withdrawal stops all processing)', async () => {
    const tables = failedCounted('candidate_left', 'worker_crash');
    tables.interview_round_consents![0]!.withdrawn_at = '2026-10-06T10:20:00Z';
    const infer = goodInfer();
    const { db } = setup(tables);
    await expect(runR1Assessment(SESSION_ID, { client: db.client, infer })).rejects.toThrow('r1_consent_withdrawn');
    expect(infer).not.toHaveBeenCalled();
    expect(db.tables.assessments).toHaveLength(0);
    // No consent row at all is the same fail-closed answer.
    const none = failedCounted('candidate_left', 'worker_crash');
    none.interview_round_consents = [];
    await expect(runR1Assessment(SESSION_ID, { client: setup(none).db.client, infer })).rejects.toThrow('r1_consent_withdrawn');
  });

  it('a failed consent read is a retryable error, not a score', async () => {
    const { db } = setup(failedCounted('candidate_left', 'worker_crash'));
    const failing = {
      ...db.client,
      from: (table: string) => {
        if (table === 'interview_round_consents') {
          const q: any = {
            select: () => q,
            eq: () => q,
            is: () => q,
            limit: () => Promise.resolve({ data: null, error: { message: 'down' } }),
          };
          return q;
        }
        return db.client.from(table);
      },
    };
    await expect(runR1Assessment(SESSION_ID, { client: failing as never, infer: goodInfer() }))
      .rejects.toThrow('r1_consent_read_error');
  });

  it('does not change the completed-session path: no consent read and one attempt read', async () => {
    const { db } = setup(tablesWithInterview());
    await runR1Assessment(SESSION_ID, { client: db.client, infer: goodInfer(), now: () => NOW });
    expect(db.fromCalls).not.toContain('interview_round_consents');
    expect(db.fromCalls.filter((t) => t === 'interview_round_attempts')).toHaveLength(1);
  });
});

describe('r1ErrorCode', () => {
  it('maps every error class to a sanitized, queue-safe code', () => {
    const queueSafe = /^[a-z][a-z0-9_.:-]{2,63}$/;
    const cases: Array<[unknown, string]> = [
      [new ScorecardValidationError('x', 'scorecard_invalid:result_count'), 'scorecard_invalid:result_count'],
      [new DeepseekError('timeout'), 'deepseek_timeout'],
      [new DeepseekError('output_limit'), 'deepseek_output_limit'],
      // The HTTP status is no longer dropped: each non-2xx answer gets a code that names it.
      [new DeepseekError('protocol', 402), 'deepseek_insufficient_balance'],
      [new DeepseekError('protocol', 401), 'deepseek_auth'],
      [new DeepseekError('protocol', 403), 'deepseek_auth'],
      [new DeepseekError('protocol', 429), 'deepseek_rate_limited'],
      [new DeepseekError('protocol', 500), 'deepseek_server_error'],
      [new DeepseekError('protocol', 503), 'deepseek_server_error'],
      [new DeepseekError('protocol', 599), 'deepseek_server_error'],
      [new DeepseekError('protocol', 400), 'deepseek_http_400'],
      [new DeepseekError('protocol', 404), 'deepseek_http_404'],
      [new DeepseekError('protocol', 422), 'deepseek_http_422'],
      // No status (a 200 with an unusable body), or a status that is not an HTTP one.
      [new DeepseekError('protocol'), 'deepseek_protocol'],
      [new DeepseekError('protocol', 0), 'deepseek_protocol'],
      [new DeepseekError('protocol', 600), 'deepseek_protocol'],
      [new DeepseekError('protocol', 402.5), 'deepseek_protocol'],
      [new ProviderError('circuit_open'), 'provider_circuit_open'],
      [new BusinessError(), 'deepseek_parse_error'],
      [new Error('r1_attach_failed'), 'r1_attach_failed'],
      [new Error('Some provider text with spaces and a secret'), 'r1_assessment_failed'],
      ['not an error', 'r1_assessment_failed'],
    ];
    for (const [error, expected] of cases) {
      const code = r1ErrorCode(error);
      expect(code).toBe(expected);
      expect(code).toMatch(queueSafe);
    }
  });

  it('keeps every status code inside the DB defer-reason and queue error-code shapes', () => {
    for (let status = 100; status <= 599; status += 1) {
      expect(r1ErrorCode(new DeepseekError('protocol', status))).toMatch(/^[a-z][a-z0-9_.:-]{2,63}$/);
    }
  });

  it('explains in words only the codes an operator has to act on, and never carries provider text', () => {
    expect(r1OperatorMessage('deepseek_insufficient_balance')).toMatch(/DeepSeek balance is exhausted.*replayed after the top-up/);
    expect(r1OperatorMessage('deepseek_auth')).toMatch(/rejected the API key.*replayed/);
    for (const code of ['deepseek_timeout', 'deepseek_rate_limited', 'deepseek_protocol', 'r1_assessment_failed']) {
      expect(r1OperatorMessage(code), code).toBeNull();
    }
    for (const code of ['deepseek_insufficient_balance', 'deepseek_auth']) {
      expect(r1OperatorMessage(code)).not.toMatch(/sk-|bearer|authorization/i);
    }
  });
});
