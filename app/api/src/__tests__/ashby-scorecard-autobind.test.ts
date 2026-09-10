/**
 * ashby-scorecard-autobind — v2 metrics bind to form Score fields BY NAME.
 *
 * Owner decision (#275, 2026-09-10): a metric added in the dashboard binds to
 * the Ashby form field whose title equals the metric's name, with no code
 * change. These tests pin the matcher (normalisation, ambiguity, type, path),
 * the per-field scale handling (five-point 1:1, four-point bucketed), the
 * fail-closed compose step (form id / archived / unverified), the form
 * definition extractor, the cached reader, and the worker's v2 flow end to end
 * — including that a form read failure is RETRYABLE and never submits a card
 * with the metrics silently dropped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  autobindScorecardDimensions,
  composeAutoboundBinding,
  normalizeTitle,
  scoreScaleOf,
  DEFAULT_SCORE_SCALE,
} from '../integrations/ashby/scorecard-autobind.js';
import { extractFormDefinition, type FormDefinitionReader, type ProbeFeedbackForm, type ProbeFormField } from '../integrations/ashby/probe.js';
import {
  bindFeedbackForm,
  buildScorecard,
  dimensionValueOnScale,
  HELLO_CHRISTY_SCORECARD_BINDING,
  ashbyReviewPath,
  type ScorecardSource,
} from '../integrations/ashby/scorecard.js';
import { scorecardSourceFromV2Assessment, isV2AdapterBlocked } from '../integrations/ashby/scorecard-v2-adapter.js';
import { runClaimedAshbyOperation } from '../integrations/ashby/operation-worker.js';
import type { RuntimeWorkflowStores, OperationClaimRow } from '../integrations/ashby/orchestration.js';
import {
  readFormDefinitionCached,
  __resetFormDefinitionCacheForTest,
  FORM_DEFINITION_CACHE_MS,
} from '../integrations/ashby/runtime-workers.js';

const FORM_ID = HELLO_CHRISTY_SCORECARD_BINDING.formDefinitionId!;
const LINK_ID = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://hello.example.com';

function field(over: Partial<ProbeFormField> & { id: string }): ProbeFormField {
  return { title: null, path: `path-${over.id}`, type: 'Score', required: false, options: [], optionsTruncated: false, ...over };
}

function form(fields: ProbeFormField[], over: Partial<ProbeFeedbackForm> = {}): ProbeFeedbackForm {
  return {
    formDefinitionId: FORM_ID,
    title: 'Hello Christy AI screen',
    interviewId: null, interviewTitle: null, stageId: null, stageTitle: null,
    sections: [{ id: 'sec-1', title: 'Scores', fields }],
    fieldCount: fields.length,
    schemaAvailable: true,
    ...over,
  };
}

const FIVE_POINT = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}` }));
const FOUR_POINT = [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n}` }));

describe('normalizeTitle', () => {
  it('treats case, punctuation, separators and unicode width as the same name', () => {
    for (const v of ['Night-shift fit', 'night shift fit', 'NIGHT_SHIFT  FIT', ' Night–Shift Fit ', 'Ｎight-shift fit']) {
      expect(normalizeTitle(v)).toBe('night shift fit');
    }
    expect(normalizeTitle('Stability')).not.toBe(normalizeTitle('Stability (resume)'));
    expect(normalizeTitle(null)).toBe('');
  });
});

describe('scoreScaleOf', () => {
  it('reads the scale from the field options, else the verified four-point default', () => {
    expect(scoreScaleOf(field({ id: 'a', options: FIVE_POINT }))).toEqual({ min: 1, max: 5 });
    expect(scoreScaleOf(field({ id: 'b', options: FOUR_POINT }))).toEqual({ min: 1, max: 4 });
    expect(scoreScaleOf(field({ id: 'c' }))).toEqual(DEFAULT_SCORE_SCALE);
    expect(scoreScaleOf(field({ id: 'd', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }))).toEqual(DEFAULT_SCORE_SCALE);
    expect(scoreScaleOf(field({ id: 'e', options: [{ value: '3', label: null }] }))).toEqual(DEFAULT_SCORE_SCALE);
  });
});

describe('autobindScorecardDimensions', () => {
  const metrics = [
    { key: 'profile_relevance', name: 'Profile relevance' },
    { key: 'communication', name: 'Communication' },
    { key: 'night_shift_fit', name: 'Night-shift fit' },
    { key: 'compensation_fit', name: 'Compensation fit' },
    { key: 'stability', name: 'Stability' },
  ];

  it('binds each metric to exactly the Score field whose title equals its name', () => {
    const f = form([
      field({ id: 'f1', title: 'Profile relevance', options: FIVE_POINT }),
      field({ id: 'f2', title: 'communication', options: FOUR_POINT }),
      field({ id: 'f3', title: 'Night shift fit' }),
      field({ id: 'summary', title: 'Summary', type: 'RichText' }),
    ]);
    const r = autobindScorecardDimensions(f, metrics);
    expect(r.matched.map((m) => [m.key, m.fieldPath, m.scale.max])).toEqual([
      ['profile_relevance', 'path-f1', 5],
      ['communication', 'path-f2', 4],
      ['night_shift_fit', 'path-f3', 4],
    ]);
    expect(r.unmatched).toEqual([
      { key: 'compensation_fit', name: 'Compensation fit', reason: 'no_field' },
      { key: 'stability', name: 'Stability', reason: 'no_field' },
    ]);
    expect(r.unusedScoreFields).toEqual([]);
  });

  it('refuses an ambiguous title, a non-Score field and a field with no path — never guesses', () => {
    const f = form([
      field({ id: 'a1', title: 'Stability' }),
      field({ id: 'a2', title: 'stability' }),           // duplicate title → ambiguous
      field({ id: 'b1', title: 'Compensation fit', type: 'String' }),
      field({ id: 'c1', title: 'Communication', path: null }),
      field({ id: 'z1', title: 'Old English', options: FOUR_POINT }), // legacy, unclaimed
    ]);
    const r = autobindScorecardDimensions(f, metrics);
    expect(r.matched).toEqual([]);
    expect(r.unmatched).toEqual([
      { key: 'profile_relevance', name: 'Profile relevance', reason: 'no_field' },
      { key: 'communication', name: 'Communication', reason: 'no_path' },
      { key: 'night_shift_fit', name: 'Night-shift fit', reason: 'no_field' },
      { key: 'compensation_fit', name: 'Compensation fit', reason: 'not_score_type' },
      { key: 'stability', name: 'Stability', reason: 'ambiguous_title' },
    ]);
    expect(r.unusedScoreFields.map((u) => u.fieldId).sort()).toEqual(['a1', 'a2', 'c1', 'z1']);
  });

  it('is deterministic and binds a duplicated metric key once', () => {
    const f = form([field({ id: 'f1', title: 'Stability' })]);
    const twice = [{ key: 'stability', name: 'Stability' }, { key: 'stability', name: 'Stability' }];
    expect(autobindScorecardDimensions(f, twice).matched).toHaveLength(1);
    expect(autobindScorecardDimensions(f, metrics)).toEqual(autobindScorecardDimensions(f, metrics));
  });
});

describe('composeAutoboundBinding — fixed fields stay static, dimensions come from the form', () => {
  const f = form([field({ id: 'f1', title: 'Stability', options: FIVE_POINT })]);
  const auto = autobindScorecardDimensions(f, [{ key: 'stability', name: 'Stability' }]);

  it('keeps overall/summary/red flags/detailed report from the verified binding and replaces ONLY the dimensions', () => {
    const b = composeAutoboundBinding(HELLO_CHRISTY_SCORECARD_BINDING, f, auto)!;
    expect(b).not.toBeNull();
    expect(b.fieldPaths!.overall).toBe(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.overall);
    expect(b.fieldPaths!.summary).toBe(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary);
    expect(b.fieldPaths!.redFlags).toBe(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.redFlags);
    expect(b.fieldPaths!.detailedReport).toBe(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.detailedReport);
    expect(b.fieldPaths!.dimensions).toEqual({ stability: 'path-f1' });
    expect(b.dimensionScales).toEqual({ stability: { min: 1, max: 5 } });
    // The v1 dimension table is NOT carried: a stale v1 id can never receive a v2 score.
    expect(b.fieldPaths!.dimensions).not.toHaveProperty('english');
  });

  it('refuses a definition for a different form, an archived form, or an unverified base', () => {
    expect(composeAutoboundBinding(HELLO_CHRISTY_SCORECARD_BINDING, { ...f, formDefinitionId: 'other-form' }, auto)).toBeNull();
    expect(composeAutoboundBinding(HELLO_CHRISTY_SCORECARD_BINDING, { ...f, archived: true }, auto)).toBeNull();
    expect(composeAutoboundBinding({ ...HELLO_CHRISTY_SCORECARD_BINDING, verified: false }, f, auto)).toBeNull();
  });
});

describe('dimensionValueOnScale', () => {
  it('submits the 1–5 metric score exactly on a five-point field and buckets elsewhere', () => {
    for (const s of [1, 2, 3, 4, 5]) {
      expect(dimensionValueOnScale({ score: s * 2, metricScore: s }, { min: 1, max: 5 })).toBe(s);
    }
    // Four-point: 1→1, 2→2, 3→3, 4→4, 5→4 (the pre-existing bucketing).
    expect([1, 2, 3, 4, 5].map((s) => dimensionValueOnScale({ score: s * 2, metricScore: s }, { min: 1, max: 4 }))).toEqual([1, 2, 3, 4, 4]);
    // A v1 dimension (no metricScore) on a five-point field still buckets its 0–10 projection.
    expect(dimensionValueOnScale({ score: 10 }, { min: 1, max: 5 })).toBe(5);
    expect(dimensionValueOnScale({ score: 0 }, { min: 1, max: 5 })).toBe(1);
  });
});

describe('extractFormDefinition — the feedbackFormDefinition.info envelope', () => {
  const payload = {
    id: FORM_ID,
    organizationId: 'org-1',
    title: 'Hello Christy AI screen',
    isArchived: false,
    isDefaultForm: false,
    formDefinition: {
      sections: [{
        id: 'sec-1',
        title: 'Scores',
        fields: [
          { isRequired: false, field: { id: 'fld-1', type: 'Score', path: 'p-1', title: 'Profile relevance', selectableValues: FIVE_POINT } },
          { isRequired: true, field: { id: 'fld-2', type: 'ValueSelect', path: 'overall_recommendation', title: 'Overall', selectableValues: FOUR_POINT } },
          { field: { id: 'fld-3', type: 'RichText', path: 'p-3', title: 'Summary', candidateEmail: 'leak@example.test' } },
        ],
      }],
    },
  };

  it('reads fields, types, paths, scales and required flags — and nothing else', () => {
    const f = extractFormDefinition(payload)!;
    expect(f).not.toBeNull();
    expect(f.formDefinitionId).toBe(FORM_ID);
    expect(f.schemaAvailable).toBe(true);
    expect(f.archived).toBeUndefined();
    const fields = f.sections[0].fields;
    expect(fields.map((x) => [x.id, x.type, x.path, x.title, x.required, x.options.length])).toEqual([
      ['fld-1', 'Score', 'p-1', 'Profile relevance', false, 5],
      ['fld-2', 'ValueSelect', 'overall_recommendation', 'Overall', true, 4],
      ['fld-3', 'RichText', 'p-3', 'Summary', null, 0],
    ]);
    expect(JSON.stringify(f)).not.toContain('leak@example.test');
  });

  it('flags an archived definition and refuses a payload with no usable id', () => {
    expect(extractFormDefinition({ ...payload, isArchived: true })!.archived).toBe(true);
    expect(extractFormDefinition({ ...payload, id: 'not an id!' })).toBeNull();
    expect(extractFormDefinition(null)).toBeNull();
    expect(extractFormDefinition([payload])).toBeNull();
  });
});

describe('readFormDefinitionCached', () => {
  beforeEach(() => __resetFormDefinitionCacheForTest());

  it('reuses a good read within the TTL and re-reads after it; never caches a miss', async () => {
    const good = { id: FORM_ID, formDefinition: { sections: [{ fields: [{ field: { id: 'x', type: 'Score', path: 'p', title: 'Stability' } }] }] } };
    let now = 1_000_000;
    const info = vi.fn(async () => ({ results: good }));
    const reader = { feedbackFormDefinitionInfo: info } as unknown as FormDefinitionReader;
    const a = await readFormDefinitionCached(FORM_ID, reader, () => now);
    const b = await readFormDefinitionCached(FORM_ID, reader, () => now + 1_000);
    expect(a).toBe(b);
    expect(info).toHaveBeenCalledTimes(1);
    now += FORM_DEFINITION_CACHE_MS + 1;
    await readFormDefinitionCached(FORM_ID, reader, () => now);
    expect(info).toHaveBeenCalledTimes(2);

    __resetFormDefinitionCacheForTest();
    const missInfo = vi.fn(async () => ({ results: { id: FORM_ID } }));
    const miss = { feedbackFormDefinitionInfo: missInfo } as unknown as FormDefinitionReader;
    const m1 = await readFormDefinitionCached(FORM_ID, miss, () => now);
    const m2 = await readFormDefinitionCached(FORM_ID, miss, () => now);
    expect(m1?.schemaAvailable).toBe(false);
    expect(m2?.schemaAvailable).toBe(false);
    expect(missInfo).toHaveBeenCalledTimes(2);
  });
});

// ── End to end: a v2 assessment through the worker with the live form ──────

function metricResult(key: string, name: string, score: number | null, rationale = `why ${key}`) {
  return {
    configMetricId: `cfg-${key}`, score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale, evidenceRefs: ['turn-1'],
    metric: { id: `cfg-${key}`, libraryMetricId: `lib-${key}`, key, name, instruction: 'i', rubric: {}, weightBps: 2000, displayOrder: 0 },
  };
}

function v2Source(): ScorecardSource {
  const adapted = scorecardSourceFromV2Assessment({
    schema_version: 2, scoring_status: 'complete', weighted_score_5: 4.2, recommendation: 'advance',
    metric_results: [
      metricResult('profile_relevance', 'Profile relevance', 5),
      metricResult('communication', 'Communication', 4),
      metricResult('night_shift_fit', 'Night-shift fit', 3),
      metricResult('compensation_fit', 'Compensation fit', null),
      metricResult('stability', 'Stability', 2),
    ],
    role_fit: { score: 7, matched_skills: ['Excel'], gaps: [], red_flags: ['Unverifiable employer claim'], notes: '' },
    provenance: { requestedModel: 'deepseek-v4-pro', prompt_template_version: 'scoring-v2' },
    created_at: '2026-09-10T00:00:00Z',
  }, { reviewPath: ashbyReviewPath(LINK_ID), externalApplicationId: 'app_ext_9' });
  if (isV2AdapterBlocked(adapted)) throw new Error('unexpected block');
  return adapted;
}

function workerFixture(source: ScorecardSource | null) {
  const failures: Array<{ reason: string; retryable: boolean }> = [];
  const claim: OperationClaimRow = {
    id: 'op_9', operationType: 'scorecard_write', operationKey: `ashby:scorecard:link:${LINK_ID}`,
    applicationLinkId: LINK_ID, leaseToken: 'lease_9', attempts: 1, maxAttempts: 5, marker: 'marker_9',
  };
  const stores = {
    claimOperation: async () => claim,
    readLink: async () => ({
      id: LINK_ID, externalApplicationId: 'app_ext_9', externalJobId: 'job_9', externalResumeFileHandle: null,
      jobMappingId: null, candidateId: null, sessionId: 'sess_9', inviteId: null, lifecycle: 'scored', terminalState: null,
    }),
    readScorecardSource: async () => source,
    failOperation: async (_id: string, _tok: string, reason: string, retryable: boolean) => { failures.push({ reason, retryable }); return 'ok' as const; },
    completeOperation: async () => 'ok' as const,
  } as unknown as RuntimeWorkflowStores;
  return { stores, failures };
}

const LIVE_FORM = form([
  field({ id: 'f-pr', title: 'Profile relevance', path: 'p-pr', options: FIVE_POINT }),
  field({ id: 'f-co', title: 'Communication', path: 'ee3ca034-ea9c-451a-85de-1e22b1bce180', options: FOUR_POINT }),
  field({ id: 'f-ns', title: 'Night-shift fit', path: 'p-ns', options: FIVE_POINT }),
  // No "Stability" field yet — the metric must be omitted, not guessed.
  // The owner KEPT the v1 "Role fit" Score field; the derived role_fit.score lands on it by title.
  field({ id: 'f-rf', title: 'Role fit', path: 'd1220462-1d8a-43b9-a56f-c5635cdd5e2f', options: FOUR_POINT }),
  field({ id: 'f-sum', title: 'Summary', path: HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary, type: 'RichText' }),
]);

describe('worker — a v2 scorecard auto-binds by name against the live form definition', () => {
  it('submits the fixed fields plus exactly the matched metrics, each on its field’s own scale', async () => {
    const submit = vi.fn(async () => ({}));
    const readFormDefinition = vi.fn(async () => LIVE_FORM);
    const { stores, failures } = workerFixture(v2Source());
    const events: string[] = [];

    const out = await runClaimedAshbyOperation({
      stores, materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN, readFormDefinition },
      resolveMappingForLink: async () => null, reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false }, owner: 'w1', leaseSeconds: 30,
      onEvent: (e) => events.push(`${e.kind}:${e.code ?? ''}`),
    });

    expect(failures).toEqual([]);
    expect(out).toMatchObject({ claimed: true, committed: true, code: 'scorecard_submitted' });
    expect(readFormDefinition).toHaveBeenCalledWith(FORM_ID);
    const req = (submit.mock.calls as unknown as unknown[][])[0]![0] as {
      applicationId: string; formDefinitionId: string;
      feedbackForm: { fieldSubmissions: Array<{ path: string; value: unknown }> };
    };
    expect(req.applicationId).toBe('app_ext_9');
    expect(req.formDefinitionId).toBe(FORM_ID);
    const byPath = new Map(req.feedbackForm.fieldSubmissions.map((s) => [s.path, s.value]));
    // 4 fixed + 3 matched metrics + Role fit = 8; unmatched (stability) and unscored (compensation) absent.
    expect(req.feedbackForm.fieldSubmissions).toHaveLength(8);
    expect(byPath.get('p-pr')).toEqual({ score: 5 });   // five-point field, 5/5 → 5 (1:1)
    expect(byPath.get('ee3ca034-ea9c-451a-85de-1e22b1bce180')).toEqual({ score: 4 }); // four-point, 4/5 → 4
    expect(byPath.get('p-ns')).toEqual({ score: 3 });   // five-point, 3/5 → 3
    // The kept v1 "Role fit" field receives the derived role_fit.score (7/10) bucketed onto ITS 1–4 scale,
    // exactly as v1 did — never a metric score.
    expect(byPath.get('d1220462-1d8a-43b9-a56f-c5635cdd5e2f')).toEqual({ score: dimensionValueOnScale({ score: 7 }, { min: 1, max: 4 }) });
    expect((byPath.get('d1220462-1d8a-43b9-a56f-c5635cdd5e2f') as { score: number }).score).toBeGreaterThanOrEqual(1);
    expect(byPath.has('46ee47b9-71a7-42bd-844c-c279c0e8bebf')).toBe(false); // v1 "English" id is not on the form → nothing written
    // Fixed fields intact: overall on the 1–4 select (weighted 4.2 → 80 → 4), rich summary, red flags, deep link.
    expect(byPath.get('overall_recommendation')).toBe('4');
    expect(byPath.get(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary)).toEqual({
      type: 'PlainText',
      value: expect.stringContaining('Compensation fit — not scored (insufficient evidence)'),
    });
    expect(byPath.get(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.redFlags!)).toBe('- Unverifiable employer claim');
    expect(byPath.get(HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.detailedReport!)).toBe(`${ORIGIN}/ashby/review/${LINK_ID}`);
    expect(events).toContain('scorecard_autobind:matched_4_unmatched_1');
    // No metric NAME or rationale in the observer stream — counts only.
    expect(events.join(' ')).not.toMatch(/Stability|Profile|why /);
    // No sensitive key fragment anywhere in the request body.
    expect(JSON.stringify(req)).not.toMatch(/transcript|recording|bearer|presigned|secret|apikey|evidenceRefs|turn-1/i);
  });

  it('a form read failure is RETRYABLE and submits nothing — never a card with the metrics dropped', async () => {
    const submit = vi.fn(async () => ({}));
    for (const readFormDefinition of [
      vi.fn(async () => { throw new Error('503'); }),
      vi.fn(async () => null),
      vi.fn(async () => ({ ...LIVE_FORM, schemaAvailable: false, sections: [] })),
    ]) {
      const { stores, failures } = workerFixture(v2Source());
      const out = await runClaimedAshbyOperation({
        stores, materialization: {} as never,
        scorecard: { submit, dashboardOrigin: ORIGIN, readFormDefinition },
        resolveMappingForLink: async () => null, reissuePathFor: () => '/x',
        email: { providerApproved: false, domainVerified: false }, owner: 'w1', leaseSeconds: 30,
      });
      expect(failures).toEqual([{ reason: 'form_schema_unavailable', retryable: true }]);
      expect(out).toMatchObject({ committed: false, code: 'form_schema_unavailable' });
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('a definition for a DIFFERENT form fails closed, non-retryable', async () => {
    const submit = vi.fn(async () => ({}));
    const { stores, failures } = workerFixture(v2Source());
    await runClaimedAshbyOperation({
      stores, materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN, readFormDefinition: async () => ({ ...LIVE_FORM, formDefinitionId: 'some-other-form' }) },
      resolveMappingForLink: async () => null, reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false }, owner: 'w1', leaseSeconds: 30,
    });
    expect(failures).toEqual([{ reason: 'form_definition_mismatch', retryable: false }]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('without a form reader a v2 operation is deferred as unavailable, while a v1 operation still uses the static binding', async () => {
    const submit = vi.fn(async () => ({}));
    const v2 = workerFixture(v2Source());
    await runClaimedAshbyOperation({
      stores: v2.stores, materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN },
      resolveMappingForLink: async () => null, reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false }, owner: 'w1', leaseSeconds: 30,
    });
    expect(v2.failures).toEqual([{ reason: 'form_schema_unavailable', retryable: true }]);
    expect(submit).not.toHaveBeenCalled();

    const v1: ScorecardSource = {
      schemaVersion: 1, externalApplicationId: 'app_ext_9', overallScore: 72, recommendation: 'advance',
      dimensions: [{ key: 'english', score: 8 }, { key: 'communication', score: 8 }],
      summary: 'Legacy row.', provenance: {}, reviewPath: ashbyReviewPath(LINK_ID), redFlags: [],
    };
    const v1fx = workerFixture(v1);
    const out = await runClaimedAshbyOperation({
      stores: v1fx.stores, materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN },
      resolveMappingForLink: async () => null, reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false }, owner: 'w1', leaseSeconds: 30,
    });
    expect(out).toMatchObject({ committed: true, code: 'scorecard_submitted' });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('bindFeedbackForm with per-dimension scales', () => {
  it('uses each dimension’s own scale and falls back to the binding default', () => {
    const built = buildScorecard(v2Source(), { min: 1, max: 4 });
    if (!built.ok) throw new Error(built.reason);
    const auto = autobindScorecardDimensions(LIVE_FORM, built.scorecard.dimensions.map((d) => ({ key: d.key, name: d.name! })));
    const binding = composeAutoboundBinding(HELLO_CHRISTY_SCORECARD_BINDING, LIVE_FORM, auto)!;
    const bound = bindFeedbackForm(built.scorecard, binding, ORIGIN);
    if (!bound.ok) throw new Error(bound.reason);
    const dims = (bound.feedbackForm as { fieldSubmissions: Array<{ path: string; value: { score?: number } }> })
      .fieldSubmissions.filter((s) => typeof s.value === 'object' && s.value !== null && 'score' in s.value)
      .map((s) => [s.path, s.value.score]);
    expect(dims).toEqual([
      ['p-pr', 5], ['ee3ca034-ea9c-451a-85de-1e22b1bce180', 4], ['p-ns', 3],
      ['d1220462-1d8a-43b9-a56f-c5635cdd5e2f', dimensionValueOnScale({ score: 7 }, { min: 1, max: 4 })],
    ]);
  });
});

describe('v2 adapter — derived Role fit rides along as a named dimension', () => {
  it('adds a "Role fit" dimension from role_fit.score (0–10), omits it when absent, and never shadows a metric of the same key', () => {
    const src = v2Source();
    const rf = src.dimensions!.find((d) => d.key === 'role_fit')!;
    expect(rf).toMatchObject({ key: 'role_fit', name: 'Role fit', score: 7 });
    expect(rf).not.toHaveProperty('metricScore');
    expect(src.summary).toContain('Role fit — 7/10 (résumé vs role)');

    const base = {
      schema_version: 2, scoring_status: 'complete', weighted_score_5: 4, recommendation: 'advance',
      metric_results: [metricResult('communication', 'Communication', 4)],
      created_at: '2026-09-10T00:00:00Z',
    };
    for (const role_fit of [undefined, null, {}, { red_flags: [] }, { score: 'high' }, { score: 11 }, { score: -1 }, { score: Number.NaN }]) {
      const out = scorecardSourceFromV2Assessment({ ...base, role_fit }, { reviewPath: ashbyReviewPath(LINK_ID) });
      if (isV2AdapterBlocked(out)) throw new Error(out.blocked);
      expect(out.dimensions!.map((d) => d.key)).toEqual(['communication']);
      expect(out.summary).not.toContain('Role fit');
    }
    const shadowed = scorecardSourceFromV2Assessment(
      { ...base, metric_results: [metricResult('role_fit', 'Role fit', 2)], role_fit: { score: 9 } },
      { reviewPath: ashbyReviewPath(LINK_ID) },
    );
    if (isV2AdapterBlocked(shadowed)) throw new Error(shadowed.blocked);
    expect(shadowed.dimensions).toEqual([{ key: 'role_fit', name: 'Role fit', score: 4, metricScore: 2 }]);
  });
});
