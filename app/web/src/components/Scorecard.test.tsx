/**
 * Scorecard — the session/screening pages' assessment view.
 *
 * Covers:
 *   - Legacy (v1) dimensions: verdict, weights as data labels, bars, chips,
 *     resume conflicts, humanized machine values
 *   - Role-scorecard (v2) rows: per-metric rubric words, pip readings,
 *     weights, rationale, evidence, "Insufficient evidence", provisional score
 *   - Defensive reads: partial and malformed assessments of either
 *     generation render without throwing (the P0 route crash)
 *   - axe structural rule compliance
 */

import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Scorecard } from './Scorecard';
import type { Assessment } from '../types';

const baseAssessment: Assessment = {
  overall_score: 78,
  recommendation: 'advance',
  summary: 'Strong candidate with good communication skills and relevant experience.',
  tone: {
    clarity: 8,
    confidence: 7,
    professionalism: 9,
    sentiment: 'positive',
    notes: 'Professional tone throughout.',
  },
  role_fit: {
    score: 8,
    matched_skills: ['React', 'TypeScript'],
    gaps: ['GraphQL'],
    red_flags: [],
    notes: 'Good match for the role.',
  },
  communication: {
    score: 7,
    notes: 'Clear communicator.',
    clarity: 7,
    structure: 7,
    listening: 6,
    rapport: 8,
  },
  motivation: {
    score: 6,
    notes: 'Showed genuine interest in the role.',
  },
  raw: null,
};

/** Metric snapshot as the role API stores it inside `raw.metricResults[].metric`. */
function metric(id: string, name: string, weightBps: number) {
  return {
    id,
    libraryMetricId: `lib-${id}`,
    key: name.toLowerCase().replace(/\s+/g, '_'),
    name,
    instruction: 'Assess it.',
    rubric: { 1: 'Poor', 2: 'Average', 3: 'Good', 4: 'Excellent' },
    weightBps,
    displayOrder: 0,
  };
}

/** A schema v2 row exactly as the wire carries it: NO v1 dimension fields. */
function v2Assessment(overrides: Record<string, unknown> = {}): Assessment {
  const metricResults = [
    {
      configMetricId: 'm1',
      score: 4,
      evidenceStatus: 'scored',
      rationale: 'Anticipated failure modes with numbers.',
      evidenceRefs: ['Moved the hot path behind a queue'],
      metric: metric('m1', 'Technical depth', 4000),
    },
    {
      configMetricId: 'm2',
      score: 2,
      evidenceStatus: 'scored',
      rationale: 'Answers drifted before landing.',
      evidenceRefs: [],
      metric: metric('m2', 'Communication clarity', 3500),
    },
    {
      configMetricId: 'm3',
      score: null,
      evidenceStatus: 'insufficient_evidence',
      rationale: 'The call ran out of time before this topic.',
      evidenceRefs: [],
      metric: metric('m3', 'Ownership', 2500),
    },
  ];
  return {
    id: 'a-v2',
    schema_version: 2,
    scorecard_version_id: 'sv-1',
    revision: 1,
    scoring_status: 'incomplete_evidence',
    weighted_score_5: 3.14,
    score_scale_max: 4,
    overall_score: 86,
    recommendation: 'advance',
    summary: 'Specific answers on scaling; motivation consistent with the resume.',
    raw: {
      schemaVersion: 2,
      scorecardVersionId: 'sv-1',
      revision: 1,
      status: 'incomplete_evidence',
      scoreScaleMax: 4,
      metricResults,
      weightedScore5: 3.14,
      overallScore: 86,
      recommendation: 'advance',
    },
    ...overrides,
  } as unknown as Assessment;
}

describe('Scorecard (legacy v1)', () => {
  it('renders the overall score as the verdict', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
    expect(screen.getByText('Overall score')).toBeInTheDocument();
  });

  it('renders the recommendation', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Advance')).toBeInTheDocument();
  });

  it('renders each dimension as a heading with its weight as a data label', () => {
    render(<Scorecard assessment={baseAssessment} />);
    for (const title of ['Communication', 'Motivation', 'Tone', 'Role fit']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }
    expect(screen.getByText('Weight 50%')).toBeInTheDocument();
    expect(screen.getAllByText('Weight 20%')).toHaveLength(2);
    expect(screen.getByText('Weight 10%')).toBeInTheDocument();
  });

  it('renders metric bars with labels and readings', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getAllByText('Score').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Clarity').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Structure')).toBeInTheDocument();
    expect(screen.getByText('Listening')).toBeInTheDocument();
    expect(screen.getByText('Rapport')).toBeInTheDocument();
    expect(screen.getByText('Listening').parentElement).toHaveTextContent('Listening6/10');
  });

  it('renders the summary under the verdict', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(
      screen.getByText('Strong candidate with good communication skills and relevant experience.'),
    ).toBeInTheDocument();
  });

  it('humanizes machine values (sentiment)', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Positive')).toBeInTheDocument();
    expect(screen.queryByText('positive')).not.toBeInTheDocument();
  });

  it('renders matched skills, gaps, and red flags', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Matched skills')).toBeInTheDocument();
    expect(screen.getByText('React')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Gaps')).toBeInTheDocument();
    expect(screen.getByText('GraphQL')).toBeInTheDocument();
    expect(screen.getByText('Red flags')).toBeInTheDocument();
  });

  it('renders the conflict section when conflicts exist', () => {
    const assessmentWithConflicts: Assessment = {
      ...baseAssessment,
      resume_conflicts: [
        {
          topic: 'Years of experience',
          resume_says: '5 years',
          candidate_said: '3 years',
          resolved: false,
          note: 'Discrepancy in experience.',
        },
      ],
    };
    render(<Scorecard assessment={assessmentWithConflicts} />);
    expect(screen.getByText('Resume conflicts')).toBeInTheDocument();
    expect(screen.getByText('Years of experience')).toBeInTheDocument();
    expect(screen.getByText('Unresolved')).toBeInTheDocument();
    expect(screen.getByText('5 years')).toBeInTheDocument();
    expect(screen.getByText('3 years')).toBeInTheDocument();
  });

  it('renders hold and reject recommendations', () => {
    const { rerender } = render(
      <Scorecard assessment={{ ...baseAssessment, overall_score: 55, recommendation: 'hold' }} />,
    );
    expect(screen.getByText('Hold')).toBeInTheDocument();
    rerender(<Scorecard assessment={{ ...baseAssessment, overall_score: 35, recommendation: 'reject' }} />);
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('falls back to the raw copy of a missing block', () => {
    const { communication: _c, ...rest } = baseAssessment;
    render(
      <Scorecard
        assessment={{ ...rest, raw: { communication: { score: 4, notes: 'From raw.' } } } as Assessment}
      />,
    );
    expect(screen.getByText('From raw.')).toBeInTheDocument();
    expect(screen.getByText('4/10')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Scorecard assessment={baseAssessment} />);
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with conflicts', async () => {
    const assessmentWithConflicts: Assessment = {
      ...baseAssessment,
      resume_conflicts: [
        {
          topic: 'Experience discrepancy',
          resume_says: '5 years',
          candidate_said: '3 years',
          resolved: false,
          note: 'Need to verify.',
        },
      ],
    };
    const { container } = render(<Scorecard assessment={assessmentWithConflicts} />);
    await expect(container).toHaveNoViolations();
  });
});

describe('Scorecard (role scorecard v2)', () => {
  it('renders a v2 row without reading any v1 field (the route crash)', () => {
    expect(() => render(<Scorecard assessment={v2Assessment()} />)).not.toThrow();
    // None of the legacy dimensions leak in.
    expect(screen.queryByRole('heading', { name: 'Tone' })).not.toBeInTheDocument();
  });

  it('renders the verdict: overall, weighted rubric average, recommendation, summary', () => {
    render(<Scorecard assessment={v2Assessment()} />);
    expect(screen.getByText('86')).toBeInTheDocument();
    expect(screen.getByText('Overall score')).toBeInTheDocument();
    expect(screen.getByText('3.14')).toBeInTheDocument();
    expect(screen.getByText('Advance')).toBeInTheDocument();
    expect(
      screen.getByText('Specific answers on scaling; motivation consistent with the resume.'),
    ).toBeInTheDocument();
  });

  it('renders each metric with its rubric word, reading and weight', () => {
    render(<Scorecard assessment={v2Assessment()} />);
    const list = screen.getByRole('list', { name: 'Metrics' });
    const rows = within(list).getAllByRole('listitem').filter((li) => li.parentElement === list);
    expect(rows).toHaveLength(3);

    const [depth, clarity, ownership] = rows;
    expect(within(depth).getByRole('heading', { level: 4, name: 'Technical depth' })).toBeInTheDocument();
    expect(within(depth).getByText('Excellent')).toBeInTheDocument();
    expect(within(depth).getByText('4 out of 4')).toBeInTheDocument();
    expect(within(depth).getByText('Weight 40%')).toBeInTheDocument();
    expect(within(depth).getByText('Anticipated failure modes with numbers.')).toBeInTheDocument();
    expect(within(depth).getByText('“Moved the hot path behind a queue”')).toBeInTheDocument();

    expect(within(clarity).getByText('Average')).toBeInTheDocument();
    expect(within(clarity).getByText('2 out of 4')).toBeInTheDocument();
    expect(within(clarity).getByText('Weight 35%')).toBeInTheDocument();

    expect(within(ownership).getByText('Insufficient evidence')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 scored')).toBeInTheDocument();
  });

  it('flags a provisional score when a metric lacked evidence', () => {
    render(<Scorecard assessment={v2Assessment()} />);
    expect(screen.getByText(/Provisional: scored from 2 of 3 metrics/)).toBeInTheDocument();
  });

  it('reads a pre-migration five-level row on its own scale', () => {
    const row = v2Assessment();
    const raw = row.raw as unknown as Record<string, unknown>;
    delete raw.scoreScaleMax;
    render(<Scorecard assessment={{ ...row, score_scale_max: null } as Assessment} />);
    // 4 on the retired 1–5 scale is "Good", not "Excellent".
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('4 out of 5')).toBeInTheDocument();
  });

  it('never prints an opaque metric id as a heading on a raw-less row', () => {
    render(
      <Scorecard
        assessment={v2Assessment({
          raw: null,
          metric_results: [
            { configMetricId: 'e0000101-0000-4000-8000-000000000101', score: 3, evidenceStatus: 'scored', rationale: '', evidenceRefs: [] },
          ],
        })}
      />,
    );
    const heading = screen.getByRole('heading', { level: 4, name: 'Metric 1' });
    expect(heading).toHaveAttribute('title', 'e0000101-0000-4000-8000-000000000101');
    expect(screen.queryByText('e0000101-0000-4000-8000-000000000101')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Scorecard assessment={v2Assessment()} />);
    await expect(container).toHaveNoViolations();
  });
});

describe('Scorecard (partial and malformed rows never throw)', () => {
  const cases: Array<[string, unknown]> = [
    ['v1 with no dimension blocks', { overall_score: 40, recommendation: 'hold', summary: '' }],
    ['v1 with null blocks', { overall_score: 40, recommendation: 'hold', tone: null, role_fit: null, communication: null, motivation: null, raw: null }],
    ['v1 with wrong-typed fields', { overall_score: 'n/a', recommendation: 7, tone: { sentiment: 3, notes: {} }, role_fit: { matched_skills: 'Go', gaps: null, red_flags: [null, 'Late'] }, resume_conflicts: [null, 'x', { topic: 5 }] }],
    ['v1 with a raw string', { overall_score: 60, recommendation: 'advance', raw: 'not json' }],
    ['v2 with null metric entries', v2Assessment({ raw: { schemaVersion: 2, metricResults: [null, { configMetricId: 'm1', score: 3 }] }, metric_results: [null] })],
    ['v2 with no raw and no metric_results', v2Assessment({ raw: null, metric_results: undefined })],
    ['v2 stringy schema_version with garbage scores', v2Assessment({ schema_version: '2', raw: { metricResults: [{ configMetricId: 'm1', score: 'high', metric: null, evidenceRefs: 'x' }] } })],
  ];

  it.each(cases)('%s', (_name, assessment) => {
    expect(() => render(<Scorecard assessment={assessment as Assessment} />)).not.toThrow();
  });

  it('says "Not scored" instead of drawing a missing overall score as a number', () => {
    render(<Scorecard assessment={{ recommendation: 'hold' } as unknown as Assessment} />);
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.queryByText('NaN')).not.toBeInTheDocument();
    expect(screen.getByText('This assessment carries no dimension scores.')).toBeInTheDocument();
  });

  it('shows an unknown recommendation plainly instead of inventing "Hold"', () => {
    render(<Scorecard assessment={{ ...baseAssessment, recommendation: 'needs_panel' } as unknown as Assessment} />);
    expect(screen.getByText('Needs panel')).toBeInTheDocument();
    expect(screen.queryByText('Hold')).not.toBeInTheDocument();
  });

  it('leaves out a missing reading instead of drawing it as zero', () => {
    render(
      <Scorecard
        assessment={{ ...baseAssessment, communication: { notes: 'Only notes.' } } as unknown as Assessment}
      />,
    );
    expect(screen.getByText('Only notes.')).toBeInTheDocument();
    expect(screen.queryByText('0/10')).not.toBeInTheDocument();
  });
});
