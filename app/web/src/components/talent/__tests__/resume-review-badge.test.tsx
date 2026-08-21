/**
 * ResumeReviewBadge + candidateDisplayName.
 *
 * The two things this module must never do: fabricate an identity for a
 * PII-minimal shell, and leak anything about WHY a resume needs review.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  ResumeReviewBadge,
  CANDIDATE_SHELL_TITLE,
  candidateDisplayName,
  isBadgedResumeReview,
  resumeReviewLabel,
  RESUME_REVIEW_ORDER,
} from '../ResumeReviewBadge';

describe('candidateDisplayName', () => {
  it('returns the exact neutral shell copy for a null/blank name', () => {
    expect(CANDIDATE_SHELL_TITLE).toBe('Awaiting resume details');
    expect(candidateDisplayName(null)).toBe('Awaiting resume details');
    expect(candidateDisplayName(undefined)).toBe('Awaiting resume details');
    expect(candidateDisplayName('')).toBe('Awaiting resume details');
    expect(candidateDisplayName('   ')).toBe('Awaiting resume details');
  });

  it('passes a real name through untouched', () => {
    expect(candidateDisplayName('Jane Doe')).toBe('Jane Doe');
  });

  it('never invents a placeholder identity', () => {
    expect(candidateDisplayName(null)).not.toMatch(/unnamed|unknown|candidate #/i);
  });
});

describe('resumeReviewLabel', () => {
  it('labels exactly the three loud states', () => {
    expect(resumeReviewLabel('processing')).toBe('Resume processing');
    expect(resumeReviewLabel('needs_review')).toBe('Resume needs review');
    expect(resumeReviewLabel('cancelled')).toBe('Resume cancelled');
  });

  it('stays quiet for ready, null and anything unrecognized', () => {
    expect(resumeReviewLabel('ready')).toBeNull();
    expect(resumeReviewLabel(null)).toBeNull();
    expect(resumeReviewLabel(undefined)).toBeNull();
    expect(resumeReviewLabel('failed_review')).toBeNull();
    expect(isBadgedResumeReview('ready')).toBe(false);
  });

  it('offers only the three loud states as facets, in journey order', () => {
    expect([...RESUME_REVIEW_ORDER]).toEqual(['processing', 'needs_review', 'cancelled']);
  });
});

describe('ResumeReviewBadge', () => {
  it.each([
    ['processing', 'Resume processing'],
    ['needs_review', 'Resume needs review'],
    ['cancelled', 'Resume cancelled'],
  ] as const)('renders %s as its own words', (value, label) => {
    render(<ResumeReviewBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders nothing for ready or null', () => {
    const { container: ready } = render(<ResumeReviewBadge value="ready" />);
    expect(ready).toBeEmptyDOMElement();
    const { container: none } = render(<ResumeReviewBadge value={null} />);
    expect(none).toBeEmptyDOMElement();
  });

  it('distinguishes needs_review by text and weight, not hue alone', () => {
    const { container: needs } = render(<ResumeReviewBadge value="needs_review" />);
    const { container: processing } = render(<ResumeReviewBadge value="processing" />);
    // Every state carries a distinct, self-describing sentence...
    expect(needs.textContent).not.toBe(processing.textContent);
    // ...and needs_review additionally differs in weight, so the distinction
    // survives greyscale and colour-vision deficiency.
    expect(needs.firstElementChild?.className).toContain('font-semibold');
    expect(processing.firstElementChild?.className).not.toContain('font-semibold');
  });

  it('declares no colour of its own — the palette owns colour', () => {
    const { container } = render(<ResumeReviewBadge value="needs_review" />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/);
  });

  it('discloses no failure code, id or operator detail', () => {
    for (const value of RESUME_REVIEW_ORDER) {
      const { container } = render(<ResumeReviewBadge value={value} />);
      expect(container.textContent).not.toMatch(
        /failed_review|fetch_http_error|parse|scan|ashby|application|link|attempt|retry|null|undefined/i,
      );
    }
  });
});
