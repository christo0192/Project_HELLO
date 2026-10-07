import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HeaderScore } from '../HeaderScore';
import { latestScreeningAssessment } from '../../../lib/latest-screening-assessment';
import type { Assessment, Session } from '../../../types';

function assessment(over: Record<string, unknown>): Assessment {
  return {
    overall_score: 39,
    recommendation: 'reject',
    summary: '',
    tone: {},
    role_fit: {},
    created_at: '2026-10-07T09:00:00.000Z',
    ...over,
  } as unknown as Assessment;
}

function session(over: Record<string, unknown>): Session {
  return { id: 's1', candidate_id: 'c1', role_id: null, status: 'completed', created_at: null, ...over } as Session;
}

function region() {
  return screen.getByRole('region', { name: 'Latest screening score' });
}

describe('HeaderScore', () => {
  it('shows the figure, the recommendation and the caption with the date', () => {
    render(<HeaderScore assessments={[assessment({})]} sessions={[session({})]} />);
    const r = region();
    expect(within(r).getByText('39')).toBeInTheDocument();
    expect(within(r).getByText('/ 100')).toBeInTheDocument();
    expect(within(r).getByText('Reject')).toBeInTheDocument();
    expect(within(r).getByText(/Latest screening · /)).toBeInTheDocument();
    expect(within(r).queryByText('Provisional')).not.toBeInTheDocument();
  });

  it('says Not scored, never 0, when there is no assessment or no readable figure', () => {
    const { rerender } = render(<HeaderScore assessments={[]} sessions={[]} />);
    expect(within(region()).getByText('Not scored')).toBeInTheDocument();
    expect(within(region()).queryByText('0')).not.toBeInTheDocument();
    rerender(
      <HeaderScore assessments={[assessment({ overall_score: null, recommendation: null })]} sessions={[]} />,
    );
    expect(within(region()).getByText('Not scored')).toBeInTheDocument();
  });

  it('tags a v2 score from incomplete evidence as Provisional', () => {
    const v2 = assessment({
      schema_version: 2,
      overall_score: 39,
      recommendation: 'reject',
      scoring_status: 'incomplete_evidence',
      raw: { status: 'incomplete_evidence', overallScore: 39, recommendation: 'reject', metricResults: [] },
      metric_results: [],
    });
    render(<HeaderScore assessments={[v2]} sessions={[session({})]} />);
    expect(within(region()).getByText('39')).toBeInTheDocument();
    expect(within(region()).getByText('Provisional')).toBeInTheDocument();
  });

  it('says Held, in words, when the evidence was graded insufficient', () => {
    render(
      <HeaderScore
        assessments={[assessment({ evidence_grade: 'insufficient', evidence_reason: 'partial_thin' })]}
        sessions={[session({})]}
      />,
    );
    expect(within(region()).getByText('Held: not enough evidence')).toBeInTheDocument();
  });

  it('skips an R1 role-play assessment: the screening score is the newest PHONE one', () => {
    const r1 = assessment({ session_id: 'r1-s', overall_score: 91, recommendation: 'advance' });
    const phone = assessment({ session_id: 'p-s', overall_score: 39 });
    const sessions = [session({ id: 'r1-s', interview_round_id: 'round-1' }), session({ id: 'p-s' })];
    expect(latestScreeningAssessment([r1, phone], sessions)).toBe(phone);
    render(<HeaderScore assessments={[r1, phone]} sessions={sessions} />);
    expect(within(region()).getByText('39')).toBeInTheDocument();
    expect(within(region()).queryByText('91')).not.toBeInTheDocument();
  });

  it('is Not scored when every assessment is an R1 round', () => {
    const r1 = assessment({ session_id: 'r1-s', overall_score: 91 });
    render(
      <HeaderScore assessments={[r1]} sessions={[session({ id: 'r1-s', interview_round_id: 'round-1' })]} />,
    );
    expect(within(region()).getByText('Not scored')).toBeInTheDocument();
  });
});
