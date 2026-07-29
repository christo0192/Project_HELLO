/**
 * Scorecard component accessibility tests.
 *
 * Covers:
 *   - Overall score display
 *   - Recommendation badge
 *   - Section headings (Communication, Motivation, Tone, Role fit)
 *   - Metric bars with labels
 *   - Summary section
 *   - axe structural rule compliance
 *   - Resume conflicts display
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
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

describe('Scorecard', () => {
  beforeEach(() => {});

  it('renders overall score', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
    expect(screen.getByText('Overall score')).toBeInTheDocument();
  });

  it('renders recommendation badge', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Advance')).toBeInTheDocument();
  });

  it('renders section headings', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Communication - 50%')).toBeInTheDocument();
    expect(screen.getByText('Motivation - 20%')).toBeInTheDocument();
    expect(screen.getByText('Tone - 10%')).toBeInTheDocument();
    expect(screen.getByText('Role fit - 20%')).toBeInTheDocument();
  });

  it('renders metric bars with labels', () => {
    render(<Scorecard assessment={baseAssessment} />);
    // Use getAllByText for 'Score' and 'Clarity' since they appear in multiple sections
    const scoreLabels = screen.getAllByText('Score');
    expect(scoreLabels.length).toBeGreaterThanOrEqual(1);
    const clarityLabels = screen.getAllByText('Clarity');
    expect(clarityLabels.length).toBeGreaterThanOrEqual(1);
    // Structure appears only in communication
    expect(screen.getByText('Structure')).toBeInTheDocument();
    expect(screen.getByText('Listening')).toBeInTheDocument();
    expect(screen.getByText('Rapport')).toBeInTheDocument();
  });

  it('renders summary section', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Strong candidate with good communication skills and relevant experience.',
      ),
    ).toBeInTheDocument();
  });

  it('renders matched skills, gaps, and red flags', () => {
    render(<Scorecard assessment={baseAssessment} />);
    expect(screen.getByText('Matched skills')).toBeInTheDocument();
    expect(screen.getByText('React')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Gaps')).toBeInTheDocument();
    expect(screen.getByText('GraphQL')).toBeInTheDocument();
  });

  it('renders conflict section when conflicts exist', () => {
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
    expect(screen.getByText('unresolved')).toBeInTheDocument();
  });

  it('renders hold recommendation correctly', () => {
    const holdAssessment: Assessment = {
      ...baseAssessment,
      overall_score: 55,
      recommendation: 'hold',
    };
    render(<Scorecard assessment={holdAssessment} />);
    expect(screen.getByText('Hold')).toBeInTheDocument();
  });

  it('renders reject recommendation correctly', () => {
    const rejectAssessment: Assessment = {
      ...baseAssessment,
      overall_score: 35,
      recommendation: 'reject',
    };
    render(<Scorecard assessment={rejectAssessment} />);
    expect(screen.getByText('Reject')).toBeInTheDocument();
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
