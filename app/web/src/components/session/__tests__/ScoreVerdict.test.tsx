import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoleScorecardBody } from '../RoleScorecardView';
import { ScorePips, ScoreVerdict } from '../ScoreVerdict';
import type { ScorecardAssessmentDisplay, ScorecardMetricDisplay } from '../../../types';

describe('ScoreVerdict', () => {
  it.each([
    ['advance', 'text-ready-text'],
    ['hold', 'text-unresolved-text'],
    ['reject', 'text-closed-text'],
  ])('prints the figure of a %s in %s, and the scale beside it stays quiet', (recommendation, text) => {
    render(<ScoreVerdict overall={61} recommendation={recommendation} />);
    expect(screen.getByText('61')).toHaveClass(text);
    expect(screen.getByText('/ 100')).toHaveClass('text-ink-tertiary');
  });

  it('keeps the figure in ink with no recommendation of its own', () => {
    render(<ScoreVerdict overall={61} recommendation="human_review" />);
    expect(screen.getByText('61')).toHaveClass('text-ink');
  });

  it('gives "Not scored" no hue, whatever the recommendation says', () => {
    render(<ScoreVerdict overall={null} recommendation="hold" />);
    expect(screen.getByText('Not scored')).toHaveClass('text-ink');
  });

  it.each([
    ['advance', 'Select'],
    ['reject', 'Reject'],
  ])('gives a held %s no hue, and keeps its word and circle', (recommendation, word) => {
    const { container } = render(<ScoreVerdict overall={80} recommendation={recommendation} held />);
    expect(screen.getByText('80')).toHaveClass('text-ink');
    expect(screen.getByText(word).parentElement).toHaveClass('text-ink');
    expect(container.querySelector('[data-verdict-mark]')).toHaveClass('text-ink');
  });
});

describe('ScorePips', () => {
  const pips = (container: HTMLElement) => [...container.querySelectorAll('[aria-hidden="true"] > span')];

  it.each([
    [4, 4, 'bg-ready'],
    [3, 4, 'bg-ready'],
    [2, 4, 'bg-unresolved'],
    [1, 4, 'bg-closed'],
    [4, 5, 'bg-ready'],
    [3, 5, 'bg-unresolved'],
    [2, 5, 'bg-closed'],
  ])('fills %s of %s in %s and leaves the rest empty', (level, max, fill) => {
    const { container } = render(<ScorePips level={level} max={max} />);
    const all = pips(container);
    expect(all).toHaveLength(max);
    all.slice(0, level).forEach((pip) => expect(pip).toHaveClass(fill, 'data-fill'));
    all.slice(level).forEach((pip) => {
      expect(pip).toHaveClass('bg-ink/[0.12]');
      expect(pip).not.toHaveClass('data-fill');
    });
  });

  it('fills in ink when the host says the rating takes no family, still drawn in a contrast theme', () => {
    const { container } = render(<ScorePips level={3} max={4} family={null} />);
    pips(container).slice(0, 3).forEach((pip) => expect(pip).toHaveClass('bg-info', 'data-fill'));
    expect(container.innerHTML).not.toMatch(/bg-(?:ready|unresolved|closed)/);
  });
});

describe('a metric row of a role scorecard', () => {
  function metric(over: Partial<ScorecardMetricDisplay>): ScorecardMetricDisplay {
    return {
      id: 'm1',
      name: 'Technical depth',
      weightBps: 5000,
      score: 3,
      evidenceStatus: 'scored',
      rationale: '',
      evidenceRefs: [],
      ...over,
    } as ScorecardMetricDisplay;
  }

  function scorecard(metrics: ScorecardMetricDisplay[], scoreScaleMax: 4 | 5 = 4): ScorecardAssessmentDisplay {
    return {
      status: 'complete',
      scoreScaleMax,
      overallScore: 70,
      weightedScore5: null,
      recommendation: 'advance',
      metrics,
    } as unknown as ScorecardAssessmentDisplay;
  }

  it.each([
    [4, 4, 'Excellent', 'text-ready-text'],
    [2, 4, 'Average', 'text-unresolved-text'],
    [1, 4, 'Poor', 'text-closed-text'],
  ] as const)('prints a %s of %s, %s, and its figure in %s, the name stays ink', (score, max, word, text) => {
    render(<RoleScorecardBody scorecard={scorecard([metric({ score })], max)} />);
    expect(screen.getByText(word)).toHaveClass(text);
    expect(screen.getByText(`${score}/${max}`)).toHaveClass(text);
    expect(screen.getByRole('heading', { name: 'Technical depth' })).toHaveClass('text-ink');
  });

  it('gives the rows of a held scorecard no hue, the words and figures kept', () => {
    const { container } = render(<RoleScorecardBody scorecard={scorecard([metric({ score: 4 })])} held />);
    expect(screen.getByText('Excellent')).toHaveClass('text-ink');
    expect(screen.getByText('4/4')).toHaveClass('text-ink-tertiary');
    expect(screen.getByText('70')).toHaveClass('text-ink');
    expect(container.innerHTML).not.toMatch(/(?:bg|text)-(?:ready|unresolved|closed)/);
  });

  it('says insufficient evidence in the unresolved family', () => {
    const { container } = render(
      <RoleScorecardBody scorecard={scorecard([metric({ score: null, evidenceStatus: 'insufficient_evidence' })])} />,
    );
    expect(screen.getByText('Insufficient evidence')).toHaveClass('text-warning-text');
    expect(container.querySelector('[data-status-badge="warning"]')).toHaveTextContent('Insufficient evidence');
  });
});
