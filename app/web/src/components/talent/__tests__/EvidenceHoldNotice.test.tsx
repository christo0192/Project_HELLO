/**
 * C3 (0114) — the evidence-hold banner above a held scorecard, and its use in
 * the shared Scorecard view.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EvidenceHoldNotice } from '../EvidenceHoldNotice';
import { evidenceHoldReason, isEvidenceInsufficient } from '../../../lib/evidence-hold';
import { Scorecard } from '../../Scorecard';
import { mockAssessment } from '../../../test/helpers';

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
