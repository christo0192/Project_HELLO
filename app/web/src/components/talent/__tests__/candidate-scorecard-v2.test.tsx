/**
 * Candidate v2 (role-scorecard) display.
 *
 * Covers the schema_version discriminator/normaliser, the v2 scorecard
 * component (per-metric score + label + rationale + weighted overall, and the
 * insufficient-evidence path), and the branch inside TranscriptionSyncWorkspace:
 * a v2 assessment renders the metric view, a v1 assessment renders the legacy
 * 1–10 view unchanged.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { readScorecardAssessmentV2, isAssessmentV2 } from '../../../types';
import type { Assessment, ScorecardAssessmentV2 } from '../../../types';
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

const RUBRIC = { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' } as const;

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
    expect(display.recommendation).toBe('hold');
    expect(display.metrics.map((m) => m.name)).toEqual(['Technical depth', 'Leadership']);
    expect(display.metrics[0].score).toBe(4);
    expect(display.metrics[0].weightBps).toBe(6000);
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
    // Score 4 carries its SCORE_LABELS word.
    expect(screen.getByText('Score · Good')).toBeInTheDocument();
    expect(screen.getByText('Score · Below average')).toBeInTheDocument();
    // Verbose rationale.
    expect(
      screen.getByText('Explained the trade-offs clearly and in depth.'),
    ).toBeInTheDocument();
    // Weighted overall.
    expect(screen.getByText('/ 100')).toBeInTheDocument();
    expect(screen.getAllByText('63').length).toBeGreaterThan(0);
    expect(screen.getByText(/3\.50/)).toBeInTheDocument();
    expect(screen.getByText('Hold')).toBeInTheDocument();
  });

  it('shows "Insufficient evidence" and withholds the overall when incomplete', () => {
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
});
