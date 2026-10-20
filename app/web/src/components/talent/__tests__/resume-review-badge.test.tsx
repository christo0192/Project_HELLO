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
  IntakeBadge,
  INTAKE_TYPE_ORDER,
  intakeTypeLabel,
  isIntakeType,
  PROFILE_OUTCOME_LABELS,
} from '../ResumeReviewBadge';
import type { AshbyProfileOutcome, IntakeType } from '../../../types';

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

/**
 * M017: the intake badge says which way a candidate came in. Both values are
 * neutral and told apart by their words; anything else renders nothing, so
 * an older API (no field) leaves every surface exactly as it was.
 */
describe('IntakeBadge', () => {
  it('labels both intake types, in facet order', () => {
    expect([...INTAKE_TYPE_ORDER]).toEqual(['resume_parsing', 'phone_parsing']);
    expect(intakeTypeLabel('resume_parsing')).toBe('Resume parsing');
    expect(intakeTypeLabel('phone_parsing')).toBe('Phone parsing');
  });

  it.each([
    ['resume_parsing', 'Resume parsing'],
    ['phone_parsing', 'Phone parsing'],
  ] as const)('renders %s as its own words', (value, label) => {
    render(<IntakeBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders nothing for null, absent or an unknown value', () => {
    for (const value of [null, undefined, 'email_parsing' as IntakeType, '' as IntakeType]) {
      const { container } = render(<IntakeBadge value={value} />);
      expect(container).toBeEmptyDOMElement();
    }
    expect(intakeTypeLabel(null)).toBeNull();
    expect(intakeTypeLabel('bogus')).toBeNull();
    expect(isIntakeType(undefined)).toBe(false);
  });

  it('distinguishes the two by text alone: same neutral tone, same weight', () => {
    const { container: resume } = render(<IntakeBadge value="resume_parsing" />);
    const { container: phone } = render(<IntakeBadge value="phone_parsing" />);
    expect(resume.textContent).not.toBe(phone.textContent);
    const r = resume.firstElementChild as HTMLElement;
    const p = phone.firstElementChild as HTMLElement;
    expect(r.getAttribute('data-status-badge')).toBe('neutral');
    expect(p.getAttribute('data-status-badge')).toBe('neutral');
    expect(r.className).toBe(p.className);
  });

  it('declares no colour of its own — the palette owns colour', () => {
    for (const value of INTAKE_TYPE_ORDER) {
      const { container } = render(<IntakeBadge value={value} />);
      expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/);
    }
  });
});

describe('PROFILE_OUTCOME_LABELS', () => {
  /** The closed 0130 vocabulary, written out so a missing label fails here. */
  const VOCABULARY: AshbyProfileOutcome[] = [
    'applied',
    'number_invalid',
    'number_placeholder',
    'number_shared',
    'name_missing',
    'resume_found',
    'resume_shape_unknown',
    'stage_moved',
    'application_inactive',
    'mapping_inactive',
    'subject_request_hold',
    'engagement_active',
    'not_applicable',
    'ashby_unavailable',
    'identity_unconfirmed',
    'application_terminal',
    'candidate_missing',
  ];

  it('labels exactly the closed vocabulary', () => {
    expect(Object.keys(PROFILE_OUTCOME_LABELS).sort()).toEqual([...VOCABULARY].sort());
  });

  it('says each outcome in recruiter words, never the raw code', () => {
    expect(PROFILE_OUTCOME_LABELS.applied).toBe('Ashby number applied');
    expect(PROFILE_OUTCOME_LABELS.number_invalid).toBe('No valid Indian mobile in Ashby');
    expect(PROFILE_OUTCOME_LABELS.identity_unconfirmed).toBe(
      'Wrong person answered the Ashby number',
    );
    expect(PROFILE_OUTCOME_LABELS.ashby_unavailable).toBe('Ashby unavailable — will retry');
    for (const code of VOCABULARY) {
      const label = PROFILE_OUTCOME_LABELS[code];
      expect(label.trim().length, code).toBeGreaterThan(0);
      expect(label, code).not.toContain('_');
    }
    // Distinguished by text: no two outcomes share words.
    expect(new Set(Object.values(PROFILE_OUTCOME_LABELS)).size).toBe(VOCABULARY.length);
  });
});
