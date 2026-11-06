/**
 * C3 (0114) — the evidence-hold banner above a held scorecard, and its use in
 * the shared Scorecard view.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EvidenceHoldNotice } from '../EvidenceHoldNotice';
import { evidenceHoldReason, isEvidenceInsufficient, isResultDisowned } from '../../../lib/evidence-hold';
import { Scorecard } from '../../Scorecard';
import { mockAssessment } from '../../../test/helpers';

describe('isResultDisowned', () => {
  const r1 = { outcome: 'scored', valid: false, gate: { passed: false, failures: ['roleplay_too_short'] } };

  it.each([
    ['a held row', { evidence_grade: 'insufficient', recommendation: 'advance', raw: { recommendation: 'advance' } }],
    ['a failed-gate R1 row: NULL in the column, human_review in raw', { recommendation: null, raw: { recommendation: 'human_review', r1 } }],
    ['an R1 row with no recommendation at all', { recommendation: null, raw: { r1 } }],
    ['an R1 row with no recommendation field', { raw: { r1 } }],
    ['an R1 row whose raw says human_review beside a stale column', { recommendation: 'hold', raw: { recommendation: 'human_review', r1 } }],
  ])('disowns %s', (_case, assessment) => {
    expect(isResultDisowned(assessment)).toBe(true);
  });

  it.each([
    ['a valid R1 row', { recommendation: 'hold', raw: { recommendation: 'hold', r1: { outcome: 'scored', valid: true } } }],
    ['a phone human_review row, which no page disowns', { recommendation: null, raw: { recommendation: 'human_review' } }],
    ['a phone row with no raw', { recommendation: null, raw: null }],
    ['a phone row with a verdict', { recommendation: 'advance', raw: { recommendation: 'advance' } }],
    ['a raw.r1 that is not a record', { recommendation: null, raw: { recommendation: 'human_review', r1: 'no' } }],
    ['a NULL raw.r1', { recommendation: null, raw: { recommendation: 'human_review', r1: null } }],
    ['no row', null],
    ['a non-row', 'human_review'],
  ])('does not disown %s', (_case, assessment) => {
    expect(isResultDisowned(assessment)).toBe(false);
  });
});

describe('EvidenceHoldNotice', () => {
  it('renders nothing for a decision, a NULL grade (browser / pre-0114) or a non-row', () => {
    for (const assessment of [
      { evidence_grade: 'decision' },
      { evidence_grade: null },
      {},
      null,
      'insufficient',
    ]) {
      const { container, unmount } = render(<EvidenceHoldNotice assessment={assessment} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    expect(isEvidenceInsufficient({ evidence_grade: 'insufficient' })).toBe(true);
  });

  it('says why, that the card is held from Ashby and the status, and recommends a re-screen', () => {
    render(
      <EvidenceHoldNotice
        assessment={{ evidence_grade: 'insufficient', evidence_reason: 'partial_thin', evidence_answered: 0, evidence_planned: 4 }}
        action={<button type="button">Rescreen recommended</button>}
      />,
    );
    const note = screen.getByRole('note', { name: 'Not enough interview evidence' });
    expect(note).toHaveTextContent('The call ended after 0 of 4 planned questions were answered.');
    expect(note).toHaveTextContent(/not sent to Ashby/);
    expect(note).toHaveTextContent(/did not change the candidate's status/);
    expect(screen.getByRole('button', { name: 'Rescreen recommended' })).toBeInTheDocument();
  });

  it('prints its heading in ink, because a held card has no hue', () => {
    render(<EvidenceHoldNotice assessment={{ evidence_grade: 'insufficient', evidence_reason: 'no_candidate_speech' }} />);
    const heading = screen.getByText('Not enough interview evidence to decide');
    expect(heading).toHaveClass('text-ink');
    expect(heading).not.toHaveClass('text-warning-text');
  });

  it('words every reason without counts it does not have', () => {
    expect(evidenceHoldReason({ evidence_reason: 'infra_interrupted' })).toMatch(/cut off on our side/);
    expect(evidenceHoldReason({ evidence_reason: 'no_candidate_speech' })).toMatch(/did not answer any/);
    expect(evidenceHoldReason({ evidence_reason: 'partial_thin', evidence_answered: null, evidence_planned: 4 }))
      .toBe('The call ended before enough of the planned questions were answered.');
    expect(evidenceHoldReason({ evidence_reason: 'evidence_read_failed' })).toMatch(/could not be confirmed/);
    expect(evidenceHoldReason({ evidence_reason: 'no_plan' })).toMatch(/could not be confirmed/);
  });
});

describe('Scorecard — the hold banner sits above the card', () => {
  it('shows the banner for an insufficient row and nothing extra otherwise', () => {
    const { unmount } = render(<Scorecard assessment={{ ...mockAssessment, evidence_grade: 'insufficient', evidence_reason: 'infra_interrupted' }} />);
    expect(screen.getByRole('note', { name: 'Not enough interview evidence' })).toBeInTheDocument();
    unmount();
    render(<Scorecard assessment={{ ...mockAssessment, evidence_grade: 'decision' }} />);
    expect(screen.queryByRole('note', { name: 'Not enough interview evidence' })).toBeNull();
  });
});
