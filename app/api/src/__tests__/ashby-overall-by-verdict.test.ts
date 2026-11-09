/**
 * M029 — the Ashby Overall Recommendation is decided by the HELLO verdict.
 *
 * Owner request 2026-11-09: Reject = 1, lower Borderline = 2, upper Borderline
 * = 3, Select (advance) = 4. Owner decision the same day: the Borderline split
 * is 50, so a hold scored 45-49 sends 2 and one scored 50-64 sends 3.
 *
 * Proves:
 *   - the value table at every boundary, the verdict deciding first (a hold is
 *     never 1 or 4, whatever its score);
 *   - nothing is ever made up: no verdict, or no finite score, means no value,
 *     and `buildScorecard` refuses instead of defaulting to hold or sending "1";
 *   - the marker follows the value;
 *   - a provisional v2 result is mapped like any verdict (D5);
 *   - a legacy v1 row with no verdict or no score is refused at queueing (no
 *     RPC) and failed permanently by the worker (D6).
 * Synthetic data only.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ASHBY_BORDERLINE_UPPER_MIN,
  ashbyReviewPath,
  bindFeedbackForm,
  buildScorecard,
  HELLO_CHRISTY_SCORECARD_BINDING,
  overallRecommendationValue,
  type ScorecardScale,
  type ScorecardSource,
} from '../integrations/ashby/scorecard.js';
import {
  RECOMMENDATION_ADVANCE_MIN,
  RECOMMENDATION_HOLD_MIN,
  recommendationForOverall,
} from '../lib/scorecards/domain.js';
import {
  isV2AdapterBlocked,
  scorecardSourceFromV2Assessment,
} from '../integrations/ashby/scorecard-v2-adapter.js';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import { runClaimedAshbyOperation } from '../integrations/ashby/operation-worker.js';
import type { OperationClaimRow, RuntimeWorkflowStores } from '../integrations/ashby/orchestration.js';

const SCALE: ScorecardScale = { min: 1, max: 4 };
const LINK_ID = '77777777-7777-4777-8777-777777777777';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const FORM_ID = HELLO_CHRISTY_SCORECARD_BINDING.formDefinitionId!;
const ORIGIN = 'https://hello.example.com';
const OVERALL_PATH = HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.overall;

function source(over: Partial<ScorecardSource> = {}): ScorecardSource {
  return {
    externalApplicationId: 'app_ext_m029',
    overallScore: 72,
    recommendation: 'advance',
    dimensions: [
      { key: 'english', score: 8 },
      { key: 'communication', score: 7 },
    ],
    summary: 'Synthetic summary.',
    provenance: { model: 'synthetic-model' },
    reviewPath: ashbyReviewPath(LINK_ID),
    ...over,
  };
}

/** What the worker would put in the Overall Recommendation field. */
function sentOverall(over: Partial<ScorecardSource>): unknown {
  const built = buildScorecard(source(over), SCALE);
  if (!built.ok) throw new Error(`refused: ${built.reason}`);
  const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, ORIGIN);
  if (!bound.ok) throw new Error(`unbound: ${bound.reason}`);
  const fields = bound.feedbackForm.fieldSubmissions as Array<{ path: string; value: unknown }>;
  return fields.find((f) => f.path === OVERALL_PATH)?.value;
}

// ── The value table ─────────────────────────────────────────────────────────

/** [HELLO verdict, overall score, Ashby option value] — the owner's table, every boundary. */
const VALUE_TABLE: Array<['reject' | 'hold' | 'advance', number, 1 | 2 | 3 | 4]> = [
  ['reject', 0, 1], ['reject', 44, 1], ['reject', 60, 1],
  ['hold', 44, 2], ['hold', 45, 2], ['hold', 49, 2],
  ['hold', 50, 3], ['hold', 64, 3], ['hold', 65, 3],
  ['advance', 41, 4], ['advance', 65, 4], ['advance', 100, 4],
];

describe('overallRecommendationValue — the verdict decides, the score only splits Borderline', () => {
  it('splits Borderline at 50, between the 45 and 65 verdict cut-offs', () => {
    expect(ASHBY_BORDERLINE_UPPER_MIN).toBe(50);
    expect(RECOMMENDATION_HOLD_MIN).toBe(45);
    expect(RECOMMENDATION_ADVANCE_MIN).toBe(65);
    expect(RECOMMENDATION_HOLD_MIN).toBeLessThan(ASHBY_BORDERLINE_UPPER_MIN);
    expect(ASHBY_BORDERLINE_UPPER_MIN).toBeLessThan(RECOMMENDATION_ADVANCE_MIN);
  });

  it('names the verdict cut-offs without changing them', () => {
    expect(recommendationForOverall(null)).toBe('human_review');
    expect(recommendationForOverall(0)).toBe('reject');
    expect(recommendationForOverall(44)).toBe('reject');
    expect(recommendationForOverall(45)).toBe('hold');
    expect(recommendationForOverall(64)).toBe('hold');
    expect(recommendationForOverall(65)).toBe('advance');
    expect(recommendationForOverall(100)).toBe('advance');
  });

  for (const [verdict, score, value] of VALUE_TABLE) {
    it(`${verdict} ${score} → ${value}`, () => {
      expect(overallRecommendationValue(verdict, score)).toBe(value);
    });
  }

  it('a hold is never 1 or 4, whatever its score (D3)', () => {
    for (const score of [-10, 0, 10, 44, 49.99]) expect(overallRecommendationValue('hold', score)).toBe(2);
    for (const score of [50, 50.01, 80, 100, 150]) expect(overallRecommendationValue('hold', score)).toBe(3);
  });

  it('returns nothing when the verdict is not advance, hold or reject', () => {
    for (const verdict of [null, undefined, '', 'human_review', 'Advance', 'borderline', 'select', 4, {}]) {
      expect(overallRecommendationValue(verdict, 72), String(verdict)).toBeNull();
    }
  });

  it('returns nothing when the score is not a finite number, for every verdict', () => {
    for (const verdict of ['advance', 'hold', 'reject']) {
      for (const score of [NaN, Infinity, -Infinity, null, undefined, '72', '']) {
        expect(overallRecommendationValue(verdict, score), `${verdict} ${String(score)}`).toBeNull();
      }
    }
  });
});

// ── buildScorecard sends it, or refuses ─────────────────────────────────────

describe('buildScorecard — sends the verdict value, never a made-up one', () => {
  for (const [verdict, score, value] of VALUE_TABLE) {
    it(`sends "${value}" for ${verdict} ${score}`, () => {
      const built = buildScorecard(source({ recommendation: verdict, overallScore: score }), SCALE);
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(built.scorecard.scaleValue).toBe(value);
        expect(built.scorecard.recommendation).toBe(verdict);
      }
      expect(sentOverall({ recommendation: verdict, overallScore: score })).toBe(String(value));
    });
  }

  it('refuses a missing or unknown verdict as invalid_recommendation, never Borderline', () => {
    for (const recommendation of [null, undefined, '', 'human_review', 'maybe']) {
      expect(buildScorecard(source({ recommendation }), SCALE), String(recommendation))
        .toEqual({ ok: false, reason: 'invalid_recommendation' });
    }
  });

  it('refuses a missing or non-finite score as invalid_overall for every verdict, never "1"', () => {
    for (const recommendation of ['advance', 'hold', 'reject'] as const) {
      for (const overallScore of [null, NaN, Infinity, -Infinity]) {
        expect(buildScorecard(source({ recommendation, overallScore }), SCALE), `${recommendation} ${String(overallScore)}`)
          .toEqual({ ok: false, reason: 'invalid_overall' });
      }
    }
  });

  it('checks the verdict before the score: no verdict and no score is invalid_recommendation', () => {
    expect(buildScorecard(source({ recommendation: null, overallScore: null }), SCALE))
      .toEqual({ ok: false, reason: 'invalid_recommendation' });
  });

  it('refuses any scale other than the Ashby 1-4 select the table is defined on', () => {
    for (const scale of [{ min: 1, max: 5 }, { min: 0, max: 3 }, { min: 3, max: 3 }]) {
      expect(buildScorecard(source(), scale), JSON.stringify(scale)).toEqual({ ok: false, reason: 'invalid_overall' });
    }
  });

  it('the marker follows the value: a different value is a different marker, the same value the same one', () => {
    const lower = buildScorecard(source({ recommendation: 'hold', overallScore: 49 }), SCALE);
    const upper = buildScorecard(source({ recommendation: 'hold', overallScore: 50 }), SCALE);
    const upperAgain = buildScorecard(source({ recommendation: 'hold', overallScore: 64 }), SCALE);
    expect(lower.ok && upper.ok && upperAgain.ok).toBe(true);
    if (lower.ok && upper.ok && upperAgain.ok) {
      expect(lower.marker).not.toBe(upper.marker);
      expect(upper.marker).toBe(upperAgain.marker);
    }
  });
});

// ── Provisional v2 results (D5) ─────────────────────────────────────────────

function metricResult(key: string, score: number | null) {
  return {
    configMetricId: `cfg-${key}`, score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: `synthetic ${key}`, evidenceRefs: [],
    metric: { id: `cfg-${key}`, libraryMetricId: `lib-${key}`, key, name: `Metric ${key}`, instruction: 'i', rubric: {}, weightBps: 5000, displayOrder: 0 },
  };
}

describe('a provisional v2 result is mapped like any verdict (D5)', () => {
  const cases: Array<[string, number, 'advance' | 'hold' | 'reject', string]> = [
    // weighted/4 → overall = round((w-1)/3*100)
    ['provisional Select', 3.5, 'advance', '4'], // 83
    ['provisional upper Borderline', 2.5, 'hold', '3'], // 50
    ['provisional lower Borderline', 2.4, 'hold', '2'], // 47
    ['provisional Reject', 2.0, 'reject', '1'], // 33
  ];
  for (const [label, weighted, recommendation, expected] of cases) {
    it(`${label} sends "${expected}"`, () => {
      const adapted = scorecardSourceFromV2Assessment({
        schema_version: 2, scoring_status: 'incomplete_evidence', score_scale_max: 4,
        weighted_score_5: weighted, recommendation,
        metric_results: [metricResult('communication', 3), metricResult('compensation_fit', null)],
        provenance: { requestedModel: 'synthetic-model' }, created_at: '2026-11-09T00:00:00Z',
      }, { reviewPath: ashbyReviewPath(LINK_ID), externalApplicationId: 'app_ext_m029' });
      expect(isV2AdapterBlocked(adapted)).toBe(false);
      if (isV2AdapterBlocked(adapted)) return;
      const built = buildScorecard(adapted, SCALE);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, ORIGIN);
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      const fields = bound.feedbackForm.fieldSubmissions as Array<{ path: string; value: unknown }>;
      expect(fields.find((f) => f.path === OVERALL_PATH)?.value).toBe(expected);
    });
  }
});

// ── Legacy v1 rows (D6): passed through raw, refused, never invented ────────

interface TableResult { data: unknown; error: unknown }

/** Chainable Supabase double: one canned result per table. */
function fakeClient(results: Record<string, TableResult>) {
  const rpc = vi.fn(async () => ({ data: { status: 'inserted' }, error: null }));
  const client = {
    from(table: string) {
      const result = results[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is']) builder[m] = chain;
      const settle = () => Promise.resolve(result);
      builder.maybeSingle = settle;
      builder.single = settle;
      builder.then = (onOk: (v: unknown) => unknown) => settle().then(onOk);
      return builder;
    },
    rpc,
  };
  return { client, rpc };
}

function v1Row(over: Record<string, unknown> = {}): TableResult {
  return {
    data: {
      id: 'assess_m029',
      english: { grammar: 8, vocabulary: 8, fluency: 8, coherence: 8 },
      tone: { clarity: 7, confidence: 7, professionalism: 7 },
      communication: { score: 8 }, motivation: { score: 7 }, role_fit: { score: 6 },
      overall_score: 50,
      recommendation: 'hold',
      summary: 'Synthetic legacy summary.',
      provenance: { requestedModel: 'm', prompt_template_version: 'v1' },
      created_at: '2026-08-20T00:00:00Z',
      ...over,
    },
    error: null,
  };
}

const ENABLED_LINK: TableResult = {
  data: {
    external_application_id: 'app_ext_m029', external_job_id: 'job_1', job_mapping_id: 'map_1', session_id: SESSION_ID,
    ashby_job_mappings: { status: 'enabled', feedback_form_id: FORM_ID },
  },
  error: null,
};

function storesFor(row: TableResult) {
  return fakeClient({
    ashby_operations: { data: null, error: null },
    ashby_application_links: ENABLED_LINK,
    assessments: row,
  });
}

describe('v1 rows — the raw verdict and a missing score reach buildScorecard (D6)', () => {
  it('a v1 hold at 50 still enqueues', async () => {
    const { client, rpc } = storesFor(v1Row());
    expect(await createWorkflowStores(client as never).enqueueScorecardWrite!(LINK_ID, SESSION_ID)).toEqual({ status: 'inserted' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a v1 row with no verdict is refused at queueing as scorecard_invalid_recommendation, with no RPC', async () => {
    for (const recommendation of [null, 'human_review', 'borderline']) {
      const { client, rpc } = storesFor(v1Row({ recommendation }));
      expect(await createWorkflowStores(client as never).enqueueScorecardWrite!(LINK_ID, SESSION_ID), String(recommendation))
        .toEqual({ status: 'scorecard_invalid_recommendation' });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('a v1 row with no score is refused at queueing as scorecard_invalid_overall, with no RPC', async () => {
    for (const overall_score of [null, undefined, 'n/a']) {
      const { client, rpc } = storesFor(v1Row({ overall_score }));
      expect(await createWorkflowStores(client as never).enqueueScorecardWrite!(LINK_ID, SESSION_ID), String(overall_score))
        .toEqual({ status: 'scorecard_invalid_overall' });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('the execute-time read passes the stored verdict and score through untouched', async () => {
    const missing = storesFor(v1Row({ recommendation: null, overall_score: null }));
    const src = await createWorkflowStores(missing.client as never).readScorecardSource!(LINK_ID, SESSION_ID);
    expect(src).toMatchObject({ schemaVersion: 1, recommendation: null, overallScore: null });

    const raw = storesFor(v1Row({ recommendation: 'human_review', overall_score: 47 }));
    const rawSrc = await createWorkflowStores(raw.client as never).readScorecardSource!(LINK_ID, SESSION_ID);
    expect(rawSrc).toMatchObject({ recommendation: 'human_review', overallScore: 47 });
  });
});

describe('worker — a v1 row with no verdict or no score fails permanently, nothing submitted', () => {
  async function run(src: ScorecardSource) {
    const failures: Array<{ reason: string; retryable: boolean }> = [];
    const claim: OperationClaimRow = {
      id: 'op_m029', operationType: 'scorecard_write', operationKey: `ashby:scorecard:link:${LINK_ID}`,
      applicationLinkId: LINK_ID, leaseToken: 'lease_m029', attempts: 1, maxAttempts: 5, marker: 'marker_m029',
    };
    const stores = {
      claimOperation: async () => claim,
      readLink: async () => ({
        id: LINK_ID, externalApplicationId: 'app_ext_m029', externalJobId: 'job_1', externalResumeFileHandle: null,
        jobMappingId: null, candidateId: null, sessionId: SESSION_ID, inviteId: null, lifecycle: 'scored', terminalState: null,
      }),
      readScorecardSource: async () => src,
      failOperation: async (_id: string, _tok: string, reason: string, retryable: boolean) => { failures.push({ reason, retryable }); return 'ok' as const; },
      completeOperation: async () => 'ok' as const,
    } as unknown as RuntimeWorkflowStores;
    const submit = vi.fn(async () => ({}));
    const out = await runClaimedAshbyOperation({
      stores, materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN },
      resolveMappingForLink: async () => null, reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false }, owner: 'w1', leaseSeconds: 30,
    });
    return { out, failures, submit };
  }

  it('no verdict → scorecard_invalid_recommendation, not retryable', async () => {
    const { out, failures, submit } = await run(source({ schemaVersion: 1, recommendation: null }));
    expect(out).toMatchObject({ claimed: true, committed: false, code: 'scorecard_invalid_recommendation' });
    expect(failures).toEqual([{ reason: 'scorecard_invalid_recommendation', retryable: false }]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('no score → scorecard_invalid_overall, not retryable', async () => {
    const { out, failures, submit } = await run(source({ schemaVersion: 1, recommendation: 'reject', overallScore: null }));
    expect(out).toMatchObject({ claimed: true, committed: false, code: 'scorecard_invalid_overall' });
    expect(failures).toEqual([{ reason: 'scorecard_invalid_overall', retryable: false }]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('a v1 hold at 49 is written as "2"', async () => {
    const { out, failures, submit } = await run(source({ schemaVersion: 1, recommendation: 'hold', overallScore: 49 }));
    expect(failures).toEqual([]);
    expect(out).toMatchObject({ committed: true, code: 'scorecard_submitted' });
    const req = (submit.mock.calls as unknown as unknown[][])[0]![0] as { feedbackForm: { fieldSubmissions: Array<{ path: string; value: unknown }> } };
    expect(req.feedbackForm.fieldSubmissions.find((f) => f.path === OVERALL_PATH)?.value).toBe('2');
  });
});
