import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FAIRNESS_SCHEMA_ID,
  FAIRNESS_SCHEMA_VERSION,
  FAIRNESS_THRESHOLD_STATUS,
  VOLUNTARY_DECLARATION_SOURCES,
  INFERRED_TRAIT_CHANNELS,
  FAIRNESS_METRIC_IDS,
  FAIRNESS_METRIC_STATES,
  DEFAULT_MINIMUM_N,
  FAIRNESS_THRESHOLDS,
  validateCohortDocument,
  buildFairnessReport,
  validateFairnessReport,
  computeCohortDigest,
  canonicalStringify,
  type CohortDocument,
} from '../model-governance/fairness.js';

// ── Shared helpers ─────────────────────────────────────────────────────

const FIXED_CLOCK = { now: () => new Date('2026-08-02T12:00:00.000Z') };

const SHIPPED_DOC = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/model-governance/cohort-voluntary-synthetic.json', import.meta.url)),
    'utf8',
  ),
) as CohortDocument;

const labelOf = (cohortId: string) => ({
  declared: true,
  cohortId,
  declarationSource: 'voluntary_self_declared',
  consented: true,
});

function baseMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memberId: 'member-test',
    voluntaryLabel: labelOf('cohort-x'),
    observedScore: 7,
    confidence: 0.8,
    ...overrides,
  };
}

/** Build a valid cohort document with correct per-member digests. */
function buildDoc(
  members: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): CohortDocument {
  const doc = {
    schema: FAIRNESS_SCHEMA_ID,
    schemaVersion: FAIRNESS_SCHEMA_VERSION,
    status: 'proposed',
    minimumN: 3,
    description: 'Test cohort set.',
    manifest: { algorithm: 'sha256', digests: {} as Record<string, string> },
    members,
    ...overrides,
  };
  for (const member of members) {
    doc.manifest.digests[member.memberId as string] = computeCohortDigest(member);
  }
  return doc as unknown as CohortDocument;
}

const reportOf = (output: ReturnType<typeof buildFairnessReport>) => {
  if (!output.ok) throw new Error(output.error);
  return output.report;
};

const meanOf = (report: ReturnType<typeof reportOf>, cohortId: string) =>
  report.meanScores.find((m) => m.cohortId === cohortId);

// ── Shipped cohort fixture ─────────────────────────────────────────────

describe('shipped synthetic voluntary cohort fixture — valid and non-vacuous', () => {
  it('validates cleanly (shape, digests, voluntary labels, disjoint cohorts)', () => {
    const result = validateCohortDocument(SHIPPED_DOC);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('has at least ten members with a digest for every member', () => {
    expect(SHIPPED_DOC.members.length).toBeGreaterThanOrEqual(10);
    for (const member of SHIPPED_DOC.members) {
      expect(SHIPPED_DOC.manifest.digests[member.memberId]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('contains at least two voluntary cohorts and no inferred traits', () => {
    const cohorts = new Set(
      SHIPPED_DOC.members
        .map((m) => m.voluntaryLabel?.cohortId)
        .filter((c): c is string => c !== undefined),
    );
    expect(cohorts.size).toBeGreaterThanOrEqual(2);
    for (const member of SHIPPED_DOC.members) {
      if (member.voluntaryLabel) {
        expect(member.voluntaryLabel.declared).toBe(true);
        expect(member.voluntaryLabel.consented).toBe(true);
      }
    }
  });

  it('excludes members without a voluntary label (never infers them)', () => {
    const result = validateCohortDocument(SHIPPED_DOC);
    expect(result.excludedMembers?.length).toBeGreaterThanOrEqual(1);
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    expect(report.excludedMembers.length).toBeGreaterThanOrEqual(1);
    // Excluded members never appear in any cohort metric.
    const allCohortIds = new Set(report.meanScores.map((m) => m.cohortId));
    for (const id of report.excludedMembers) {
      expect(id).toMatch(/^member-0/);
      expect(allCohortIds.has(id)).toBe(false);
    }
  });
});

// ── Mandatory negative controls ────────────────────────────────────────

describe('negative controls — protected-trait inference, minimum N, labels', () => {
  it('rejects a member carrying an inferred_from_voice field', () => {
    const doc = buildDoc([
      baseMember({ inferred_from_voice: true }),
    ]);
    const result = validateCohortDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/inference is rejected/i);
  });

  it('rejects an inferred_from_* trait on the voluntary label itself', () => {
    const doc = buildDoc([
      baseMember({
        voluntaryLabel: { ...labelOf('cohort-x'), inferred_from_transcript: true },
      }),
    ]);
    const result = validateCohortDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/inference is rejected/i);
  });

  it('rejects every documented protected-trait channel', () => {
    for (const channel of INFERRED_TRAIT_CHANNELS) {
      const member = baseMember({});
      (member as Record<string, unknown>)[`inferred_from_${channel}`] = true;
      const result = validateCohortDocument(buildDoc([member]));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/inference is rejected/i);
    }
  });

  it('rejects a non-voluntary / non-consented label', () => {
    expect(
      validateCohortDocument(
        buildDoc([baseMember({ voluntaryLabel: { ...labelOf('cohort-x'), declared: false } })]),
      ).valid,
    ).toBe(false);
    expect(
      validateCohortDocument(
        buildDoc([baseMember({ voluntaryLabel: { ...labelOf('cohort-x'), consented: false } })]),
      ).valid,
    ).toBe(false);
  });

  it('rejects a cohort below minimum N by suppression (no value, no approval)', () => {
    // Shipped cohort-a has 2 members while minimumN = 3 → suppressed.
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const cohortA = meanOf(report, 'cohort-a');
    expect(cohortA?.state).toBe('suppressed');
    expect(cohortA?.value).toBeUndefined();
    expect(cohortA?.reason).toBe('below_minimum_n');
    expect(report.measuredCohorts).toBe(2); // cohort-b + cohort-c
  });

  it('reports insufficient_data when no member supplies label confidence', () => {
    const doc = buildDoc([
      baseMember({ memberId: 'member-1', confidence: undefined }),
      baseMember({ memberId: 'member-2', confidence: undefined }),
      baseMember({ memberId: 'member-3', confidence: undefined }),
      baseMember({ memberId: 'member-4', confidence: undefined }),
      baseMember({ memberId: 'member-5', confidence: undefined }),
    ]);
    const report = reportOf(buildFairnessReport({ fixtureDocument: doc, clock: FIXED_CLOCK }));
    const uncertaintyX = report.uncertainty.find((m) => m.cohortId === 'cohort-x');
    expect(uncertaintyX?.state).toBe('insufficient_data');
    expect(uncertaintyX?.value).toBeUndefined();
    expect(uncertaintyX?.reason).toBe('no_observations');
    // mean score is still measured from observedScore values
    expect(report.meanScores[0]?.state).toBe('measured');
  });

  it('rejects a cohort document with zero members', () => {
    const result = validateCohortDocument({ ...buildDoc([]), members: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-empty array/);
  });

  it('excludes missing voluntary labels rather than bucketing them', () => {
    const doc = buildDoc([
      baseMember({ memberId: 'member-aaa', voluntaryLabel: undefined }),
      baseMember({ memberId: 'member-bbb', voluntaryLabel: undefined }),
    ]);
    const result = validateCohortDocument(doc);
    expect(result.valid).toBe(true);
    expect(result.excludedMembers).toContain('member-aaa');
    expect(result.excludedMembers).toContain('member-bbb');
    const report = reportOf(buildFairnessReport({ fixtureDocument: doc, clock: FIXED_CLOCK }));
    expect(report.excludedMembers.sort()).toEqual(['member-aaa', 'member-bbb']);
    expect(report.meanScores.length).toBe(0);
    expect(report.declaredCohorts).toBe(0);
    expect(report.cohortCoverage.state).toBe('insufficient_data');
  });
});

// ── Report negative controls — no approval, no winner, descriptive only ─

describe('negative controls — fairness approval is never derived', () => {
  it('rejects a report whose threshold carries an APPROVED value', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const bad = JSON.parse(JSON.stringify(report));
    bad.thresholds[0].status = 'APPROVED';
    const result = validateFairnessReport(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/authentic voluntary cohort approval/);
  });

  it('rejects a report carrying a winner claim', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const bad = { ...report, winner: 'cohort-b' } as unknown as CohortDocument;
    const result = validateFairnessReport(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/winner/);
  });

  it('rejects a report carrying an approvalStatus claim', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const bad = { ...report, approvalStatus: 'APPROVED' } as unknown as CohortDocument;
    const result = validateFairnessReport(bad);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/fairness approval is rejected/);
  });

  it('keeps every threshold PROPOSED and every conclusion descriptive_only', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    for (const t of report.thresholds) {
      expect(t.status).toBe(FAIRNESS_THRESHOLD_STATUS);
    }
    expect(report.conclusion.kind).toBe('descriptive_only');
    expect(report.disparity.role).toBe('descriptive_only');
    expect(report.conclusion.text).toMatch(/no model-quality or fairness approval/i);
  });

  it('reports insufficient_data disparity when fewer than two cohorts are measured', () => {
    const doc = buildDoc([
      baseMember({ memberId: 'member-1' }),
      baseMember({ memberId: 'member-2' }),
      baseMember({ memberId: 'member-3' }),
    ]);
    const report = reportOf(buildFairnessReport({ fixtureDocument: doc, clock: FIXED_CLOCK }));
    expect(report.disparity.state).toBe('insufficient_data');
    expect(report.disparity.value).toBeUndefined();
    expect(report.disparity.role).toBe('descriptive_only');
  });

  it('rejects a disparity record that is not descriptive_only', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const bad = JSON.parse(JSON.stringify(report));
    bad.disparity.role = 'acceptance_gate';
    expect(validateFairnessReport(bad).valid).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(report));
    bad2.disparity.state = 'suppressed';
    expect(validateFairnessReport(bad2).valid).toBe(false);
  });

  it('rejects unknown report fields and non-PROPOSED thresholds', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    expect(validateFairnessReport({ ...report, extra: 1 }).valid).toBe(false);
    const bad = JSON.parse(JSON.stringify(report));
    bad.thresholds[0].status = 'ACCEPTED';
    expect(validateFairnessReport(bad).valid).toBe(false);
  });
});

// ── Digest / document validation edges ─────────────────────────────────

describe('cohort document validation edges', () => {
  it('rejects a corrupted member digest (tamper detection)', () => {
    const doc = buildDoc([baseMember({ memberId: 'member-x', observedScore: 7 })]);
    const tampered = JSON.parse(JSON.stringify(doc));
    tampered.members[0].observedScore = 10;
    const result = validateCohortDocument(tampered);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/digest drift/i);
  });

  it('rejects a missing member digest', () => {
    const doc = buildDoc([baseMember({ memberId: 'member-x' })]);
    const tampered = JSON.parse(JSON.stringify(doc));
    delete tampered.manifest.digests['member-x'];
    expect(validateCohortDocument(tampered).valid).toBe(false);
  });

  it('rejects out-of-range scores/confidences and bad ids', () => {
    expect(validateCohortDocument(buildDoc([baseMember({ observedScore: 11 })])).valid).toBe(false);
    expect(validateCohortDocument(buildDoc([baseMember({ observedScore: -1 })])).valid).toBe(false);
    expect(validateCohortDocument(buildDoc([baseMember({ confidence: 1.5 })])).valid).toBe(false);
    expect(validateCohortDocument(buildDoc([baseMember({ memberId: 'Bad ID' })])).valid).toBe(false);
    expect(
      validateCohortDocument(buildDoc([baseMember({ voluntaryLabel: { ...labelOf('cohort-x'), cohortId: 'BAD' } })])).valid,
    ).toBe(false);
  });

  it('rejects non-voluntary declaration sources and duplicate members', () => {
    expect(
      validateCohortDocument(
        buildDoc([baseMember({ voluntaryLabel: { ...labelOf('cohort-x'), declarationSource: 'inferred' } })]),
      ).valid,
    ).toBe(false);
    expect(
      validateCohortDocument(
        buildDoc([baseMember({ memberId: 'member-x' }), baseMember({ memberId: 'member-x' })]),
      ).valid,
    ).toBe(false);
  });

  it('rejects unknown fields and a non-plain document', () => {
    expect(validateCohortDocument({ not: 'a doc' }).valid).toBe(false);
    expect(validateCohortDocument(buildDoc([baseMember({ evil: 1 })])).valid).toBe(false);
    expect(validateCohortDocument([]).valid).toBe(false);
  });
});

// ── Deterministic report behavior ──────────────────────────────────────

describe('fairness report — deterministic and honest', () => {
  it('is deterministic under a fixed clock', () => {
    const a = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK, reportId: 'fairness-det' }));
    const b = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK, reportId: 'fairness-det' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('measures mean scores for cohorts meeting minimum N and suppresses the rest', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const cohortB = meanOf(report, 'cohort-b');
    const cohortC = meanOf(report, 'cohort-c');
    expect(cohortB?.state).toBe('measured');
    expect(cohortB?.memberCount).toBe(5);
    expect(cohortB?.value).toBeGreaterThan(0);
    expect(cohortC?.state).toBe('measured');
    expect(cohortC?.memberCount).toBe(3);
    // cohort-a suppressed
    expect(meanOf(report, 'cohort-a')?.state).toBe('suppressed');
  });

  it('reports cohort coverage from measured/declared cohorts', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    expect(report.declaredCohorts).toBe(3);
    expect(report.cohortCoverage.state).toBe('measured');
    expect(report.cohortCoverage.value).toBeCloseTo(2 / 3, 5);
  });

  it('reports uncertainty as mean label-confidence deficit and suppresses small cohorts', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    const uncertaintyB = report.uncertainty.find((m) => m.cohortId === 'cohort-b');
    expect(uncertaintyB?.state).toBe('measured');
    expect(uncertaintyB?.value).toBeGreaterThan(0);
    const uncertaintyA = report.uncertainty.find((m) => m.cohortId === 'cohort-a');
    expect(uncertaintyA?.state).toBe('suppressed');
  });

  it('reports disparity as descriptive max-minus-min across measured cohorts', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    expect(report.disparity.state).toBe('measured');
    expect(report.disparity.role).toBe('descriptive_only');
    expect(report.disparity.value).toBeGreaterThan(0);
    expect(report.disparity.value).toBeLessThanOrEqual(1);
  });

  it('passes the full report validator', () => {
    const report = reportOf(buildFairnessReport({ fixtureDocument: SHIPPED_DOC, clock: FIXED_CLOCK }));
    expect(validateFairnessReport(report).valid).toBe(true);
  });

  it('rejects a build attempt over an invalid document', () => {
    const output = buildFairnessReport({ fixtureDocument: { bad: true } });
    expect(output.ok).toBe(false);
    if (!output.ok) expect(output.error).toMatch(/cohort document/i);
  });
});

// ── Constants / closed sets ────────────────────────────────────────────

describe('fairness constants and closed sets', () => {
  it('exposes stable constants', () => {
    expect(FAIRNESS_SCHEMA_VERSION).toBe(1);
    expect(FAIRNESS_SCHEMA_ID).toBe('model-governance-fairness.schema.json');
    expect(VOLUNTARY_DECLARATION_SOURCES).toEqual(['voluntary_self_declared', 'synthetic_fixture']);
    expect(INFERRED_TRAIT_CHANNELS).toEqual(['voice', 'name', 'accent', 'transcript', 'language', 'metadata']);
    expect(FAIRNESS_METRIC_IDS).toContain('cohort_coverage');
    expect(FAIRNESS_METRIC_IDS).toContain('disparity');
    expect(FAIRNESS_METRIC_STATES).toEqual(['measured', 'insufficient_data', 'suppressed']);
    expect(DEFAULT_MINIMUM_N).toBe(5);
    for (const t of FAIRNESS_THRESHOLDS) {
      expect(t.status).toBe(FAIRNESS_THRESHOLD_STATUS);
    }
  });

  it('canonical stringify is order-independent and digest is stable', () => {
    expect(canonicalStringify({ b: 1, a: { y: 2, x: 1 } })).toBe(
      canonicalStringify({ a: { x: 1, y: 2 }, b: 1 }),
    );
    const member = baseMember({ memberId: 'member-x' });
    expect(computeCohortDigest(member)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCohortDigest(member)).toBe(computeCohortDigest(member));
    expect(computeCohortDigest({ ...member, observedScore: 9 })).not.toBe(computeCohortDigest(member));
  });
});
