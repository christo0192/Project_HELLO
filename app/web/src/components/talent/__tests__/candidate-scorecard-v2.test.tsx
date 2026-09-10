/**
 * Candidate v2 (role-scorecard) display.
 *
 * Covers the schema_version discriminator/normaliser, the v2 scorecard
 * component (per-metric score + label + rationale + weighted overall, and the
 * insufficient-evidence path), the per-assessment rubric SCALE (new rows are
 * 1–4 with Poor/Average/Good/Excellent; historical rows stay 1–5 with the legacy
 * labels), and the branch inside TranscriptionSyncWorkspace: a v2 assessment
 * renders the metric view, a v1 assessment renders the legacy 1–10 view
 * unchanged.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { readScorecardAssessmentV2, isAssessmentV2 } from '../../../types';
import type {
  Assessment,
  ScorecardAssessmentV2,
  ScorecardAssessmentV2Raw,
} from '../../../types';
import { CandidateScorecardV2 } from '../CandidateScorecardV2';
import { CandidateShell } from '../CandidateShell';

// TranscriptionSyncWorkspace imports the api module; the empty-sessions branch
// (used below) makes no calls, but mocking the module keeps the real Supabase
// client out of the test and satisfies the network trap.
vi.mock('../../../api', () => ({
  api: { getSession: vi.fn(), getRecordingDownloadUrl: vi.fn() },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';

const RUBRIC = { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } as const;

function snapshot(i: number, name: string, key: string, weightBps: number) {
  return {
    id: `sm-${i}`,
    libraryMetricId: `lib-${i}`,
    key,
    name,
    instruction: `Instruction ${i}`,
    rubric: RUBRIC,
    weightBps,
    displayOrder: i,
  };
}

const V2_COMPLETE_RAW: ScorecardAssessmentV2 = {
  schemaVersion: 2,
  scorecardVersionId: 'ver-1',
  revision: 1,
  status: 'complete',
  scoreScaleMax: 4,
  weightedScore5: 3.5,
  overallScore: 63,
  recommendation: 'hold',
  metricResults: [
    {
      configMetricId: 'sm-0',
      score: 4,
      evidenceStatus: 'scored',
      rationale: 'Explained the trade-offs clearly and in depth.',
      evidenceRefs: ['Discussed the CAP theorem unprompted'],
      metric: snapshot(0, 'Technical depth', 'technical_depth', 6000),
    },
    {
      configMetricId: 'sm-1',
      score: 2,
      evidenceStatus: 'scored',
      rationale: 'Some ownership, but leaned on the team for decisions.',
      evidenceRefs: [],
      metric: snapshot(1, 'Leadership', 'leadership', 4000),
    },
  ],
};

const V2_COMPLETE = {
  id: 'a-v2',
  schema_version: 2,
  scorecard_version_id: 'ver-1',
  revision: 1,
  scoring_status: 'complete',
  weighted_score_5: 3.5,
  overall_score: 63,
  recommendation: 'hold',
  metric_results: V2_COMPLETE_RAW.metricResults.map((r) => ({
    configMetricId: r.configMetricId,
    score: r.score,
    evidenceStatus: r.evidenceStatus,
    rationale: r.rationale,
    evidenceRefs: r.evidenceRefs,
  })),
  raw: V2_COMPLETE_RAW,
} as unknown as Assessment;

const V2_INCOMPLETE_RAW: ScorecardAssessmentV2 = {
  schemaVersion: 2,
  scorecardVersionId: 'ver-2',
  revision: 1,
  status: 'incomplete_evidence',
  scoreScaleMax: 4,
  weightedScore5: null,
  overallScore: null,
  recommendation: 'human_review',
  metricResults: [
    {
      configMetricId: 'sm-0',
      score: null,
      evidenceStatus: 'insufficient_evidence',
      rationale: 'The candidate never spoke to this area.',
      evidenceRefs: [],
      metric: snapshot(0, 'Communication', 'communication', 10000),
    },
  ],
};

const V2_INCOMPLETE = {
  id: 'a-v2b',
  schema_version: 2,
  scoring_status: 'incomplete_evidence',
  weighted_score_5: null,
  overall_score: null,
  recommendation: null,
  raw: V2_INCOMPLETE_RAW,
} as unknown as Assessment;

// PARTIAL: incomplete_evidence but WITH a provisional score (the recovered /
// go-forward shape). Two metrics scored, one insufficient → weighted 3.0 /
// overall 50 / 'hold'. The card must show the number + a "Provisional score"
// banner, NOT a blank "—" / human-review card.
const V2_PARTIAL_RAW: ScorecardAssessmentV2 = {
  schemaVersion: 2,
  scorecardVersionId: 'ver-3',
  revision: 1,
  status: 'incomplete_evidence',
  scoreScaleMax: 4,
  weightedScore5: 3.0,
  overallScore: 50,
  recommendation: 'hold',
  metricResults: [
    {
      configMetricId: 'sm-0',
      score: 3,
      evidenceStatus: 'scored',
      rationale: 'Clear, structured answers throughout.',
      evidenceRefs: [],
      metric: snapshot(0, 'Communication', 'communication', 3400),
    },
    {
      configMetricId: 'sm-1',
      score: null,
      evidenceStatus: 'insufficient_evidence',
      rationale: 'Compensation was never discussed on this call.',
      evidenceRefs: [],
      metric: snapshot(1, 'Compensation fit', 'compensation_fit', 3300),
    },
    {
      configMetricId: 'sm-2',
      score: 3,
      evidenceStatus: 'scored',
      rationale: 'Consistent tenure across roles.',
      evidenceRefs: [],
      metric: snapshot(2, 'Stability', 'stability', 3300),
    },
  ],
};

const V2_PARTIAL = {
  id: 'a-v2c',
  schema_version: 2,
  scoring_status: 'incomplete_evidence',
  weighted_score_5: 3.0,
  overall_score: 50,
  recommendation: 'hold',
  raw: V2_PARTIAL_RAW,
} as unknown as Assessment;

// A v2 row that ALSO carries the supplementary integrity signals (résumé
// conflicts + role fit) the extended scorer now persists into the v1-shaped
// columns. The candidate workspace must surface both sections for it.
const V2_WITH_INTEGRITY = {
  ...V2_PARTIAL,
  id: 'a-v2d',
  role_fit: {
    score: 4,
    matched_skills: ['Python', 'TypeScript'],
    gaps: ['No verifiable software engineering role on resume'],
    red_flags: ['Claimed 11 years at Amazon, but resume lists no such role'],
    notes: 'Background does not clearly support the role.',
  },
  resume_conflicts: [
    {
      topic: 'Amazon tenure',
      resume_says: 'No software-engineer role at Amazon.',
      candidate_said: 'Said 11 years as a software engineer at Amazon.',
      resolved: false,
      note: '',
    },
  ],
} as unknown as Assessment;

const V1: Assessment = {
  id: 'a-v1',
  overall_score: 72,
  recommendation: 'advance',
  summary: 'Solid legacy candidate.',
  tone: { clarity: 8, confidence: 7, professionalism: 8, sentiment: 'positive', notes: '' },
  role_fit: { score: 7, matched_skills: ['React'], gaps: [], red_flags: [], notes: '' },
  raw: null,
};

describe('readScorecardAssessmentV2 / isAssessmentV2', () => {
  it('returns null for a v1 assessment and a display model for a v2 row', () => {
    expect(isAssessmentV2(V1)).toBe(false);
    expect(readScorecardAssessmentV2(V1)).toBeNull();

    expect(isAssessmentV2(V2_COMPLETE)).toBe(true);
    const display = readScorecardAssessmentV2(V2_COMPLETE)!;
    expect(display).not.toBeNull();
    expect(display.overallScore).toBe(63);
    expect(display.weightedScore5).toBe(3.5);
    expect(display.scoreScaleMax).toBe(4);
    expect(display.recommendation).toBe('hold');
    expect(display.metrics.map((m) => m.name)).toEqual(['Technical depth', 'Leadership']);
    expect(display.metrics[0].score).toBe(4);
    expect(display.metrics[0].weightBps).toBe(6000);
  });

  it('treats a stringy schema_version "2" as v2 (FIX 7 — Number coercion)', () => {
    // export.ts and the Ashby adapter coerce with Number(schema_version) === 2;
    // isAssessmentV2 now matches, so a stringy '2' still routes to the v2 display.
    const stringy = { ...V2_COMPLETE, schema_version: '2' } as unknown as Assessment;
    expect(isAssessmentV2(stringy)).toBe(true);
    const display = readScorecardAssessmentV2(stringy)!;
    expect(display).not.toBeNull();
    expect(display.overallScore).toBe(63);
    // A v1 (no schema_version) still reads false — Number(undefined) is NaN.
    expect(isAssessmentV2(V1)).toBe(false);
  });
});

describe('CandidateScorecardV2', () => {
  it('renders per-metric score + label + rationale and the weighted overall', () => {
    render(
      <CandidateShell>
        <CandidateScorecardV2 scorecard={readScorecardAssessmentV2(V2_COMPLETE)!} />
      </CandidateShell>,
    );
    expect(screen.getByText('Technical depth')).toBeInTheDocument();
    expect(screen.getByText('Leadership')).toBeInTheDocument();
    // Scores carry their four-level SCORE_LABELS word (4 → Excellent, 2 → Average).
    expect(screen.getByText('Score · Excellent')).toBeInTheDocument();
    expect(screen.getByText('Score · Average')).toBeInTheDocument();
    expect(screen.queryByText('Score · Below average')).not.toBeInTheDocument();
    // Verbose rationale.
    expect(
      screen.getByText('Explained the trade-offs clearly and in depth.'),
    ).toBeInTheDocument();
    // Weighted overall.
    expect(screen.getByText('/ 100')).toBeInTheDocument();
    expect(screen.getAllByText('63').length).toBeGreaterThan(0);
    expect(screen.getByText(/3\.50/)).toBeInTheDocument();
    expect(screen.getByText('/ 4 weighted')).toBeInTheDocument();
    expect(screen.getByText('Hold')).toBeInTheDocument();
  });

  it('shows "Insufficient evidence" and withholds the overall when NO metric was scored', () => {
    render(
      <CandidateShell>
        <CandidateScorecardV2 scorecard={readScorecardAssessmentV2(V2_INCOMPLETE)!} />
      </CandidateShell>,
    );
    expect(screen.getByText('Insufficient evidence')).toBeInTheDocument();
    expect(screen.getByText('Incomplete evidence')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Needs human review')).toBeInTheDocument();
  });

  it('shows a PROVISIONAL score (never blank) when some metrics scored and some did not', () => {
    render(
      <CandidateShell>
        <CandidateScorecardV2 scorecard={readScorecardAssessmentV2(V2_PARTIAL)!} />
      </CandidateShell>,
    );
    // The overall number is shown (NOT the blank "—"), with its recommendation.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(screen.getAllByText('50').length).toBeGreaterThan(0);
    expect(screen.getByText(/3\.00/)).toBeInTheDocument();
    expect(screen.getByText('Hold')).toBeInTheDocument();
    // It is flagged PROVISIONAL, not "Incomplete evidence".
    expect(screen.getByText('Provisional score')).toBeInTheDocument();
    expect(screen.queryByText('Incomplete evidence')).not.toBeInTheDocument();
    // The coverage caveat names the scored/total split (2 of 3 here).
    expect(screen.getByText(/Provisional score from 2 of 3 metrics/)).toBeInTheDocument();
    // The scored metrics carry their real SCORE_LABELS word; the unevidenced one is flagged.
    expect(screen.getByText('Insufficient evidence')).toBeInTheDocument();
    expect(screen.getAllByText('Score · Good').length).toBe(2); // score 3 → SCORE_LABELS[3]
  });
});

// ── Rubric scale per assessment ──────────────────────────────────────────
//
// Historical rows were scored 1–5 and are NOT rescored: their `raw` predates
// `scoreScaleMax` (and older API payloads may also lack the `score_scale_max`
// column), so the reader resolves them to 5 and the card renders them on that
// scale with the legacy labels. New rows carry `scoreScaleMax: 4`.
const V2_HISTORICAL_RAW: ScorecardAssessmentV2Raw = {
  schemaVersion: 2,
  scorecardVersionId: 'ver-old',
  revision: 1,
  status: 'complete',
  // No `scoreScaleMax` — persisted before the four-level rubric.
  weightedScore5: 3.8,
  overallScore: 70,
  recommendation: 'advance',
  metricResults: [
    {
      configMetricId: 'sm-0',
      score: 5,
      evidenceStatus: 'scored',
      rationale: 'Outstanding depth on the old scale.',
      evidenceRefs: [],
      metric: snapshot(0, 'Technical depth', 'technical_depth', 6000),
    },
    {
      configMetricId: 'sm-1',
      score: 2,
      evidenceStatus: 'scored',
      rationale: 'Weak ownership on the old scale.',
      evidenceRefs: [],
      metric: snapshot(1, 'Leadership', 'leadership', 4000),
    },
  ],
};

const V2_HISTORICAL = {
  id: 'a-v2-old',
  schema_version: 2,
  scoring_status: 'complete',
  weighted_score_5: 3.8,
  overall_score: 70,
  recommendation: 'advance',
  // No `score_scale_max` column either — an older API payload.
  raw: V2_HISTORICAL_RAW,
} as unknown as Assessment;

describe('scoreScaleMax — four-level rubric vs historical 1–5 rows', () => {
  it('resolves a raw lacking scoreScaleMax (and no column) to the historical 5', () => {
    const display = readScorecardAssessmentV2(V2_HISTORICAL)!;
    expect(display.scoreScaleMax).toBe(5);
    expect(display.metrics[0].score).toBe(5);
  });

  it('falls back to the score_scale_max column when raw lacks the field', () => {
    const fromColumn = { ...V2_HISTORICAL, score_scale_max: 5 } as unknown as Assessment;
    expect(readScorecardAssessmentV2(fromColumn)!.scoreScaleMax).toBe(5);
    const migrated = { ...V2_HISTORICAL, score_scale_max: 4 } as unknown as Assessment;
    expect(readScorecardAssessmentV2(migrated)!.scoreScaleMax).toBe(4);
  });

  it('prefers raw.scoreScaleMax over the column, and treats an unknown scale as 5', () => {
    const rawWins = { ...V2_COMPLETE, score_scale_max: 5 } as unknown as Assessment;
    expect(readScorecardAssessmentV2(rawWins)!.scoreScaleMax).toBe(4);
    const garbage = { ...V2_HISTORICAL, score_scale_max: 6 } as unknown as Assessment;
    expect(readScorecardAssessmentV2(garbage)!.scoreScaleMax).toBe(5);
  });

  it('renders a historical assessment on its own 1–5 scale with the legacy labels', () => {
    render(
      <CandidateShell>
        <CandidateScorecardV2 scorecard={readScorecardAssessmentV2(V2_HISTORICAL)!} />
      </CandidateShell>,
    );
    // Weighted line reads "/ 5 weighted", not "/ 4".
    expect(screen.getByText(/3\.80/)).toBeInTheDocument();
    expect(screen.getByText('/ 5 weighted')).toBeInTheDocument();
    expect(screen.queryByText('/ 4 weighted')).not.toBeInTheDocument();
    // A score of 5 is "Excellent" on the legacy scale and the meter runs to 5.
    const top = screen.getByRole('meter', { name: 'Score · Excellent' });
    expect(top).toHaveAttribute('aria-valuenow', '5');
    expect(top).toHaveAttribute('aria-valuemax', '5');
    // A score of 2 keeps its legacy "Below average" word (NOT the new "Average").
    const low = screen.getByRole('meter', { name: 'Score · Below average' });
    expect(low).toHaveAttribute('aria-valuenow', '2');
    expect(low).toHaveAttribute('aria-valuemax', '5');
    expect(screen.queryByText('Score · Average')).not.toBeInTheDocument();
  });

  it('renders a new assessment on the 1–4 scale with the four-level labels', () => {
    render(
      <CandidateShell>
        <CandidateScorecardV2 scorecard={readScorecardAssessmentV2(V2_COMPLETE)!} />
      </CandidateShell>,
    );
    expect(screen.getByText('/ 4 weighted')).toBeInTheDocument();
    expect(screen.queryByText('/ 5 weighted')).not.toBeInTheDocument();
    // A score of 4 is "Excellent" on the new scale and the meter runs to 4.
    const top = screen.getByRole('meter', { name: 'Score · Excellent' });
    expect(top).toHaveAttribute('aria-valuenow', '4');
    expect(top).toHaveAttribute('aria-valuemax', '4');
    expect(screen.queryByText('Score · Below average')).not.toBeInTheDocument();
  });
});

describe('TranscriptionSyncWorkspace scorecard branch', () => {
  it('renders the v2 metric view for a schema_version=2 assessment', () => {
    render(
      <CandidateShell>
        <TranscriptionSyncWorkspace sessions={[]} assessments={[V2_COMPLETE]} blocked={false} />
      </CandidateShell>,
    );
    expect(screen.getByRole('heading', { name: 'Metrics' })).toBeInTheDocument();
    expect(screen.getByText('Technical depth')).toBeInTheDocument();
    // The legacy "Signals" card is NOT rendered for a v2 assessment.
    expect(screen.queryByText('Signals')).not.toBeInTheDocument();
  });

  it('renders the legacy 1–10 view unchanged for a v1 assessment', () => {
    render(
      <CandidateShell>
        <TranscriptionSyncWorkspace sessions={[]} assessments={[V1]} blocked={false} />
      </CandidateShell>,
    );
    expect(screen.getByRole('heading', { name: 'Signals' })).toBeInTheDocument();
    // No v2 metric leaks into the legacy view.
    expect(screen.queryByText('Technical depth')).not.toBeInTheDocument();
  });

  it('surfaces résumé conflicts + role fit for a v2 assessment that carries them', () => {
    render(
      <CandidateShell>
        <TranscriptionSyncWorkspace sessions={[]} assessments={[V2_WITH_INTEGRITY]} blocked={false} />
      </CandidateShell>,
    );
    // Both integrity sections render alongside the v2 metric card.
    expect(screen.getByRole('heading', { name: 'Metrics' })).toBeInTheDocument();
    // The conflicts heading carries a count badge, so match by prefix.
    expect(screen.getByRole('heading', { name: /Resume conflicts/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Role fit' })).toBeInTheDocument();
    expect(screen.getByText('Amazon tenure')).toBeInTheDocument();
    expect(screen.getByText('Claimed 11 years at Amazon, but resume lists no such role')).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
    // Supplementary role fit: NO generic fit-score meter — the configured
    // metrics own the weighted verdict, so a second 0–10 score is not shown.
    expect(screen.queryByText('Fit score')).not.toBeInTheDocument();
  });

  it('does NOT render the integrity sections for a v2 assessment without that data', () => {
    render(
      <CandidateShell>
        <TranscriptionSyncWorkspace sessions={[]} assessments={[V2_COMPLETE]} blocked={false} />
      </CandidateShell>,
    );
    expect(screen.getByRole('heading', { name: 'Metrics' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Resume conflicts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Role fit' })).not.toBeInTheDocument();
  });
});
