import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EVALUATION_SCHEMA_ID,
  EVALUATION_SCHEMA_VERSION,
  DIGEST_ALGORITHM,
  THRESHOLD_STATUS,
  NOT_EVALUATED,
  HARNESS_MODEL_ID,
  ALLOWED_EVALUATION_KINDS,
  ALLOWED_DATA_SOURCES,
  ALLOWED_METRIC_IDS,
  ALLOWED_SPLITS,
  OPTIONAL_COMPARE_PROVIDERS,
  EVALUATION_THRESHOLDS,
  canonicalStringify,
  computeFixtureDigest,
  verifyFixtureManifest,
  validateFixtureDocument,
  validateEvaluationReport,
  evaluateFixtures,
  buildSelfTestReport,
  buildSelfTestObservations,
  type FixtureDocument,
  type EvalFixtureInput,
  type ObservedResult,
  type EvaluationReport,
} from '../model-governance/evaluation.js';
import {
  MODEL_PROVENANCE_SCHEMA_VERSION,
  ALLOWLISTED_PROVIDERS,
  ALLOWLISTED_WORKLOADS,
  validateProvenance,
} from '../lib/model-provenance.js';

// ── Shared helpers ─────────────────────────────────────────────────────

const FIXED_CLOCK = { now: () => new Date('2026-08-02T12:00:00.000Z') };

const SHIPPED_DOC = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/model-governance/eval-synthetic-fixtures.json', import.meta.url)),
    'utf8',
  ),
) as FixtureDocument;

/** Valid fixture with sensible defaults; overrides win. */
function baseFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-example',
    scenario: 'screening-factual',
    workload: 'screening',
    provenance: {
      schema_version: 1,
      provider: 'anthropic',
      requestedModel: 'harness-self-test-v1',
      workload: 'screening',
      prompt_template_version: '2026-07-28.1',
      timestamp: '2026-07-28T09:00:00Z',
    },
    input: { kind: 'conversation', text: 'Synthetic de-identified transcript excerpt.' },
    expected: { factual: true, safe: true, disclosureMade: true, expectedScore: 5 },
    split: 'train',
    selfTestControl: { simulateError: 'none' },
    ...overrides,
  };
}

/** Build a valid fixture document with computed digests. */
function buildDoc(
  fixtures: Array<Record<string, unknown>>,
  split?: Record<string, string[]>,
): FixtureDocument {
  const ids = fixtures.map((f) => f.id as string);
  const doc = {
    schema: EVALUATION_SCHEMA_ID,
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    status: 'proposed',
    description: 'Test fixture set.',
    manifest: { algorithm: DIGEST_ALGORITHM, digests: {} as Record<string, string> },
    split: split ?? { train: ids, heldOut: [] },
    fixtures,
  };
  for (const fixture of fixtures) {
    doc.manifest.digests[fixture.id as string] = computeFixtureDigest(fixture);
  }
  return doc as unknown as FixtureDocument;
}

const reportOf = (output: ReturnType<typeof buildSelfTestReport>): EvaluationReport => {
  if (!output.ok) throw new Error(output.error);
  return output.report;
};

const metricOf = (report: EvaluationReport, id: string) =>
  report.metrics.find((m) => m.id === id);

// ── Shipped fixture file ───────────────────────────────────────────────

describe('shipped synthetic fixture document — non-vacuous and valid', () => {
  it('validates cleanly (shape, provenance, disjoint split, digest manifest)', () => {
    const result = validateFixtureDocument(SHIPPED_DOC);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('has at least six fixtures with digests for every fixture', () => {
    expect(SHIPPED_DOC.fixtures.length).toBeGreaterThanOrEqual(6);
    for (const fixture of SHIPPED_DOC.fixtures) {
      expect(SHIPPED_DOC.manifest.digests[fixture.id]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('has a disjoint train/held-out split', () => {
    const train = new Set(SHIPPED_DOC.split.train);
    for (const id of SHIPPED_DOC.split.heldOut) {
      expect(train.has(id)).toBe(false);
    }
  });

  it('every fixture provenance validates with the real LLM-06 validator', () => {
    for (const fixture of SHIPPED_DOC.fixtures) {
      expect(validateProvenance(fixture.provenance).valid).toBe(true);
    }
  });

  it('shipped fixtures are all synthetic and de-identified', () => {
    for (const fixture of SHIPPED_DOC.fixtures) {
      expect(fixture.input.text).toMatch(/Synthetic de-identified/i);
    }
  });
});

// ── Deterministic canonical serialization / digests ────────────────────

describe('canonical stringify and digest determinism', () => {
  it('is order-independent', () => {
    expect(canonicalStringify({ b: 1, a: { y: 2, x: 1 } })).toBe(
      canonicalStringify({ a: { x: 1, y: 2 }, b: 1 }),
    );
  });

  it('produces stable sha256 digests', () => {
    const fixture = baseFixture({ id: 'fixture-a' });
    expect(computeFixtureDigest(fixture)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFixtureDigest(fixture)).toBe(computeFixtureDigest(fixture));
  });

  it('changes when fixture content changes', () => {
    const fixture = baseFixture({ id: 'fixture-a' });
    const tampered = { ...fixture, expected: { ...(fixture.expected as object), safe: false } };
    expect(computeFixtureDigest(tampered)).not.toBe(computeFixtureDigest(fixture));
  });
});

// ── Mandatory negative controls ────────────────────────────────────────

describe('negative controls — digest drift, split overlap, no samples', () => {
  it('rejects a corrupted fixture digest (digest drift)', () => {
    const doc = buildDoc([baseFixture({ id: 'fixture-a' })]);
    const tampered = JSON.parse(JSON.stringify(doc));
    tampered.fixtures[0].expected.safe = false;
    const manifestCheck = verifyFixtureManifest(tampered as FixtureDocument);
    expect(manifestCheck.valid).toBe(false);
    expect(manifestCheck.driftedIds).toContain('fixture-a');
    const docCheck = validateFixtureDocument(tampered);
    expect(docCheck.valid).toBe(false);
    expect(docCheck.error).toMatch(/digest/i);
  });

  it('rejects a missing manifest digest', () => {
    const doc = buildDoc([baseFixture({ id: 'fixture-a' })]);
    const tampered = JSON.parse(JSON.stringify(doc));
    delete tampered.manifest.digests['fixture-a'];
    expect(verifyFixtureManifest(tampered as FixtureDocument).valid).toBe(false);
  });

  it('rejects a fixture in both train and held-out (split overlap)', () => {
    const doc = buildDoc([baseFixture({ id: 'fixture-a' })], {
      train: ['fixture-a'],
      heldOut: ['fixture-a'],
    });
    const result = validateFixtureDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/both train and held-out/);
  });

  it('rejects a split label inconsistent with the split map', () => {
    const doc = buildDoc([baseFixture({ id: 'fixture-a', split: 'held_out' })], {
      train: ['fixture-a'],
      heldOut: [],
    });
    const result = validateFixtureDocument(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects observed results outside the evaluated split (held-out protection)', () => {
    const heldOutObs: ObservedResult[] = [
      {
        fixtureId: 'fixture-screening-factual-heldout',
        producedFactual: true,
        producedSafe: true,
        producedDisclosure: true,
        producedScore: 5,
      },
    ];
    const output = evaluateFixtures({
      fixtureDocument: SHIPPED_DOC,
      splitUsed: 'train',
      evaluationKind: 'harness_self_test',
      dataSource: 'synthetic',
      modelUnderTest: HARNESS_MODEL_ID,
      observedResults: heldOutObs,
      clock: FIXED_CLOCK,
      reportId: 'eval-heldout-protection',
    });
    expect(output.ok).toBe(false);
    if (!output.ok) expect(output.error).toMatch(/outside evaluated split/);
  });

  it('reports insufficient_data for every quality metric with no samples', () => {
    const output = evaluateFixtures({
      fixtureDocument: SHIPPED_DOC,
      splitUsed: 'train',
      evaluationKind: 'harness_self_test',
      dataSource: 'synthetic',
      modelUnderTest: HARNESS_MODEL_ID,
      observedResults: [],
      observedResultsSecondPass: [],
      clock: FIXED_CLOCK,
      reportId: 'eval-no-samples',
    });
    expect(output.ok).toBe(true);
    if (!output.ok) return;
    for (const id of [
      'factuality',
      'safety',
      'disclosure',
      'scoring_consistency',
      'calibration',
      'variance',
    ]) {
      const m = metricOf(output.report, id);
      expect(m?.state).toBe('insufficient_data');
      expect(m?.sampleCount).toBe(0);
      expect(m?.value).toBeUndefined();
    }
  });

  it('reports insufficient_data for consistency/variance with a single pass', () => {
    const { firstPass } = buildSelfTestObservations(SHIPPED_DOC, 'train');
    const output = evaluateFixtures({
      fixtureDocument: SHIPPED_DOC,
      splitUsed: 'train',
      evaluationKind: 'harness_self_test',
      dataSource: 'synthetic',
      modelUnderTest: HARNESS_MODEL_ID,
      observedResults: firstPass,
      clock: FIXED_CLOCK,
      reportId: 'eval-single-pass',
    });
    expect(output.ok).toBe(true);
    if (!output.ok) return;
    expect(metricOf(output.report, 'scoring_consistency')?.state).toBe('insufficient_data');
    expect(metricOf(output.report, 'variance')?.state).toBe('insufficient_data');
  });
});

// ── Fake approval / winner negative controls ───────────────────────────

describe('negative controls — fake approved threshold and winner', () => {
  it('rejects a report whose threshold carries an APPROVED value', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    const bad = JSON.parse(JSON.stringify(report)) as EvaluationReport;
    (bad.thresholds as unknown as Array<Record<string, unknown>>)[0].status = 'APPROVED';
    const result = validateEvaluationReport(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/authentic human-annotated/);
  });

  it('rejects a metric whose threshold carries an APPROVED value', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    const bad = JSON.parse(JSON.stringify(report)) as EvaluationReport;
    (bad.metrics as unknown as Array<Record<string, unknown>>)[0].threshold = {
      ...bad.metrics[0].threshold,
      status: 'APPROVED',
    } as unknown as (typeof bad.metrics)[0]['threshold'];
    expect(validateEvaluationReport(bad).valid).toBe(false);
  });

  it('rejects any report carrying a winner claim', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    const bad = { ...report, winner: 'anthropic' } as unknown as EvaluationReport;
    const result = validateEvaluationReport(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/winner/);
  });

  it('rejects a report that names a real model in a harness self-test', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    const bad = { ...report, modelUnderTest: 'claude-3-5-sonnet-20241022' };
    expect(validateEvaluationReport(bad).valid).toBe(false);
  });

  it('rejects a self-test report claiming authentic annotations', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    const bad = { ...report, dataSource: 'authentic_human_annotated' };
    const result = validateEvaluationReport(bad);
    expect(result.valid).toBe(false);
  });

  it('rejects authentic evaluation without an annotation source', () => {
    const output = evaluateFixtures({
      fixtureDocument: SHIPPED_DOC,
      splitUsed: 'train',
      evaluationKind: 'authentic',
      dataSource: 'authentic_human_annotated',
      modelUnderTest: 'claude-3-5-sonnet-20241022',
      clock: FIXED_CLOCK,
      reportId: 'eval-auth-missing-source',
    });
    expect(output.ok).toBe(false);
    if (!output.ok) expect(output.error).toMatch(/annotation source/);
  });

  it('rejects authentic evaluation whose conclusion is not owner-review-pending', () => {
    const output = evaluateFixtures({
      fixtureDocument: SHIPPED_DOC,
      splitUsed: 'train',
      evaluationKind: 'authentic',
      dataSource: 'authentic_human_annotated',
      modelUnderTest: 'claude-3-5-sonnet-20241022',
      annotationSource: 'owner-annotated-2026-08-02',
      clock: FIXED_CLOCK,
      reportId: 'eval-auth-001',
    });
    expect(output.ok).toBe(true);
    if (!output.ok) return;
    expect(output.report.conclusion.kind).toBe('authentic_owner_review_pending');
    expect(output.report.thresholds.every((t) => t.status === THRESHOLD_STATUS)).toBe(true);
  });
});

// ── Harness self-test report — honest plumbing validation ──────────────

describe('harness self-test report — honest and non-vacuous', () => {
  const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK, reportId: 'eval-self-test-001' }));

  it('is labeled as harness plumbing only, never a model conclusion', () => {
    expect(report.evaluationKind).toBe('harness_self_test');
    expect(report.dataSource).toBe('synthetic');
    expect(report.modelUnderTest).toBe(HARNESS_MODEL_ID);
    expect(report.conclusion.kind).toBe('harness_plumbing_only');
    expect(report.conclusion.text).toMatch(/no claim about any model/i);
  });

  it('never uses the held-out split for threshold tuning', () => {
    expect(report.splitUsage.splitUsed).toBe('train');
    expect(report.splitUsage.heldOutUsedForThresholdTuning).toBe(false);
    expect(report.splitUsage.heldOutFixtureCount).toBeGreaterThan(0);
  });

  it('keeps every threshold PROPOSED', () => {
    for (const t of report.thresholds) {
      expect(t.status).toBe(THRESHOLD_STATUS);
    }
    expect(report.thresholds.length).toBe(ALLOWED_METRIC_IDS.length);
  });

  it('leaves Gemini/DeepSeek compare slots NOT_EVALUATED', () => {
    for (const provider of OPTIONAL_COMPARE_PROVIDERS) {
      expect(report.optionalComparisons[provider].status).toBe(NOT_EVALUATED);
      expect(report.optionalComparisons[provider].role).toBe('optional_compare_slot');
      expect(report.optionalComparisons[provider].requires.length).toBeGreaterThan(0);
    }
  });

  it('measures non-vacuous metric values (simulated errors produce spread)', () => {
    const safety = metricOf(report, 'safety');
    expect(safety?.state).toBe('measured');
    expect(safety?.value).toBeLessThan(1);
    const disclosure = metricOf(report, 'disclosure');
    expect(disclosure?.state).toBe('measured');
    expect(disclosure?.value).toBeLessThan(1);
    const consistency = metricOf(report, 'scoring_consistency');
    expect(consistency?.state).toBe('measured');
    expect(consistency?.value).toBeLessThan(1);
    const calibration = metricOf(report, 'calibration');
    expect(calibration?.state).toBe('measured');
    expect(calibration?.value).toBeGreaterThan(0);
    expect(calibration?.value).toBeLessThan(1);
    const variance = metricOf(report, 'variance');
    expect(variance?.state).toBe('measured');
    expect(variance?.value).toBeLessThan(1);
    const coverage = metricOf(report, 'coverage');
    expect(coverage?.state).toBe('measured');
    expect(coverage?.value).toBe(1);
  });

  it('is deterministic under a fixed clock', () => {
    const a = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK, reportId: 'eval-det' }));
    const b = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK, reportId: 'eval-det' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces deterministic self-test observations across runs', () => {
    const a = buildSelfTestObservations(SHIPPED_DOC, 'train');
    const b = buildSelfTestObservations(SHIPPED_DOC, 'train');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.firstPass.length).toBe(SHIPPED_DOC.split.train.length);
  });

  it('passes the full report validator', () => {
    expect(validateEvaluationReport(report).valid).toBe(true);
  });
});

// ── LLM-06 provenance linkage (by import, no duplication) ──────────────

describe('LLM-06 provenance linkage — references real constants', () => {
  const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));

  it('links the real provenance schema version by import', () => {
    expect(report.provenanceLinkage.schemaVersion).toBe(MODEL_PROVENANCE_SCHEMA_VERSION);
  });

  it('links the real provenance allowlists by import', () => {
    expect(report.provenanceLinkage.providers).toEqual([...ALLOWLISTED_PROVIDERS]);
    expect(report.provenanceLinkage.workloads).toEqual([...ALLOWLISTED_WORKLOADS]);
  });

  it('references the real provenance module path without duplicating it', () => {
    expect(report.provenanceLinkage.module).toBe('app/api/src/lib/model-provenance.ts');
    expect(report.provenanceLinkage.note).toMatch(/not duplicated/i);
  });
});

// ── Fixture/report validation edges ────────────────────────────────────

describe('fixture and report validation edges', () => {
  it('rejects a non-array / empty fixture document', () => {
    expect(validateFixtureDocument({ not: 'a document' }).valid).toBe(false);
    expect(validateFixtureDocument([]).valid).toBe(false);
  });

  it('rejects unknown fields, bad workload, bad split, bad provenance', () => {
    expect(validateFixtureDocument(buildDoc([baseFixture({ malicious: 1 })])).valid).toBe(false);
    expect(validateFixtureDocument(buildDoc([baseFixture({ workload: 'openai' })])).valid).toBe(false);
    expect(validateFixtureDocument(buildDoc([baseFixture({ split: 'val' })])).valid).toBe(false);
    expect(
      validateFixtureDocument(buildDoc([baseFixture({ provenance: { schema_version: 9 } })])).valid,
    ).toBe(false);
  });

  it('rejects an invalid selfTestControl value', () => {
    expect(
      validateFixtureDocument(
        buildDoc([baseFixture({ selfTestControl: { simulateError: 'leak_all' } })]),
      ).valid,
    ).toBe(false);
  });

  it('rejects a report with an unknown field or bad metric state', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    expect(validateEvaluationReport({ ...report, extra: true }).valid).toBe(false);
    const badMetric = JSON.parse(JSON.stringify(report)) as EvaluationReport;
    (badMetric.metrics as unknown as Array<Record<string, unknown>>)[0].state = 'weird';
    expect(validateEvaluationReport(badMetric).valid).toBe(false);
  });

  it('rejects a measured metric without a value and an insufficient metric with a value', () => {
    const report = reportOf(buildSelfTestReport(SHIPPED_DOC, { clock: FIXED_CLOCK }));
    const bad = JSON.parse(JSON.stringify(report)) as EvaluationReport;
    const m = bad.metrics.find((x) => x.id === 'safety')!;
    delete m.value;
    expect(validateEvaluationReport(bad).valid).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(report)) as EvaluationReport;
    const m2 = bad2.metrics.find((x) => x.id === 'factuality')!;
    m2.state = 'insufficient_data';
    m2.value = 0.5;
    expect(validateEvaluationReport(bad2).valid).toBe(false);
  });

  it('exposes stable constants', () => {
    expect(EVALUATION_SCHEMA_VERSION).toBe(1);
    expect(EVALUATION_SCHEMA_ID).toBe('model-governance-eval.schema.json');
    expect(ALLOWED_EVALUATION_KINDS).toEqual(['harness_self_test', 'authentic']);
    expect(ALLOWED_DATA_SOURCES).toContain('authentic_human_annotated');
    expect(ALLOWED_SPLITS).toEqual(['train', 'held_out']);
    expect(OPTIONAL_COMPARE_PROVIDERS).toEqual(['gemini', 'deepseek']);
    expect(EVALUATION_THRESHOLDS.every((t) => t.status === THRESHOLD_STATUS)).toBe(true);
    for (const id of ALLOWED_METRIC_IDS) {
      expect(EVALUATION_THRESHOLDS.some((t) => t.metricId === id)).toBe(true);
    }
  });
});
