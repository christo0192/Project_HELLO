import { describe, expect, it } from 'vitest';
import { candidateTabFrom, defaultCandidateTab, hasPhoneReview, hasR1Session } from './candidate-tabs';

type Detail = Parameters<typeof defaultCandidateTab>[0];

const phoneSession = { id: 'p1', status: 'completed', interview_round_id: null };
const failedPhoneSession = { id: 'p2', status: 'failed', interview_round_id: null };
const r1Session = { id: 'r1', status: 'completed', interview_round_id: 'round-1' };

function detail(over: Partial<{ status: string; sessions: unknown[]; assessments: unknown[] }> = {}): Detail {
  return {
    candidate: { status: over.status ?? 'screened' },
    sessions: over.sessions ?? [],
    assessments: over.assessments ?? [],
  } as unknown as Detail;
}

describe('candidateTabFrom', () => {
  it.each([
    ['phone', 'phone'],
    ['r1', 'r1'],
    ['profile', 'profile'],
    ['review', 'phone'],
    ['overview', 'profile'],
  ] as const)('reads ?tab=%s as %s, so an old link keeps working', (param, tab) => {
    expect(candidateTabFrom(param)).toBe(tab);
  });

  it.each([null, '', 'sessions', 'PHONE', 'constructor'])('has no tab for %s: the page then chooses', (param) => {
    expect(candidateTabFrom(param)).toBeNull();
  });
});

describe('hasR1Session', () => {
  it('finds an R1 session whatever its status, and never a phone one', () => {
    expect(hasR1Session(detail({ sessions: [phoneSession, r1Session] }))).toBe(true);
    expect(hasR1Session(detail({ sessions: [{ ...r1Session, status: 'in_progress' }] }))).toBe(true);
    expect(hasR1Session(detail({ sessions: [phoneSession, failedPhoneSession] }))).toBe(false);
    expect(hasR1Session(detail())).toBe(false);
  });
});

describe('hasPhoneReview', () => {
  it('counts a completed phone session and a phone assessment', () => {
    expect(hasPhoneReview(detail({ sessions: [phoneSession] }))).toBe(true);
    expect(hasPhoneReview(detail({ sessions: [failedPhoneSession], assessments: [{ session_id: 'p2' }] }))).toBe(true);
  });

  it('counts nothing R1: an R1 session and its assessment are not a phone review', () => {
    expect(hasPhoneReview(detail({ sessions: [r1Session], assessments: [{ session_id: 'r1' }] }))).toBe(false);
    expect(hasPhoneReview(detail({ sessions: [failedPhoneSession] }))).toBe(false);
  });

  // GET /api/candidates/:id leaves `sessions` empty when that read fails, and the assessments still come.
  describe('when the page has no session for an assessment', () => {
    const stamped = { session_id: 'r1', raw: { r1: { attempt: 1 } } };

    it('does not take a row the R1 scorer stamped for a phone review, as the header does not', () => {
      expect(hasPhoneReview(detail({ assessments: [stamped] }))).toBe(false);
      expect(defaultCandidateTab(detail({ assessments: [stamped] }))).toBe('profile');
    });

    it('keeps a row with no stamp: that is a phone screening whose session it cannot see', () => {
      expect(hasPhoneReview(detail({ assessments: [{ session_id: 'p9', raw: {} }] }))).toBe(true);
      expect(hasPhoneReview(detail({ assessments: [stamped, { session_id: 'p9', raw: null }] }))).toBe(true);
      expect(hasPhoneReview(detail({ assessments: [{ session_id: null }] }))).toBe(true);
    });
  });
});

describe('defaultCandidateTab', () => {
  it('opens on Phone screening while a phone review is pending, R1 or no R1', () => {
    expect(defaultCandidateTab(detail({ sessions: [phoneSession] }))).toBe('phone');
    expect(defaultCandidateTab(detail({ sessions: [r1Session, phoneSession] }))).toBe('phone');
  });

  it('opens on the R1 interview once the candidate is decided and an R1 interview exists', () => {
    expect(defaultCandidateTab(detail({ status: 'advanced', sessions: [r1Session, phoneSession] }))).toBe('r1');
    expect(defaultCandidateTab(detail({ status: 'rejected', sessions: [r1Session, phoneSession] }))).toBe('r1');
  });

  it('opens on the R1 interview when that is all there is to read', () => {
    expect(defaultCandidateTab(detail({ sessions: [r1Session] }))).toBe('r1');
  });

  it('keeps a decided candidate with no R1 on the phone screening', () => {
    expect(defaultCandidateTab(detail({ status: 'advanced', sessions: [phoneSession] }))).toBe('phone');
  });

  it('opens on Profile when there is nothing to review', () => {
    expect(defaultCandidateTab(detail({ status: 'new' }))).toBe('profile');
    expect(defaultCandidateTab(detail({ status: 'queued', sessions: [failedPhoneSession] }))).toBe('profile');
  });
});
