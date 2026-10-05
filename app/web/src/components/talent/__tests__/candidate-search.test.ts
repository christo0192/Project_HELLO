import { describe, it, expect } from 'vitest';
import type { Candidate } from '../../../types';
import {
  candidateSearchTokens,
  foldSearchText,
  matchesCandidateSearch,
  PHONE_MIN_DIGITS,
} from '../candidateSearch';

function cand(partial: Partial<Candidate>): Candidate {
  return {
    id: 'c',
    name: 'Jane Doe',
    email: 'jane.doe@example.com',
    phone_e164: null,
    phone_valid: false,
    skills: ['React', 'TypeScript'],
    experience_years: null,
    status: 'new',
    role_id: 'role-1',
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('foldSearchText / candidateSearchTokens', () => {
  it('folds case and accents', () => {
    expect(foldSearchText('José ÑÚÑEZ')).toBe('jose nunez');
    expect(foldSearchText('Zoë Brontë')).toBe('zoe bronte');
  });

  it('splits on any whitespace and drops empty tokens', () => {
    expect(candidateSearchTokens('  Jane \t DOE ')).toEqual(['jane', 'doe']);
    expect(candidateSearchTokens('   ')).toEqual([]);
  });
});

describe('matchesCandidateSearch', () => {
  it('matches everything for an empty or blank query', () => {
    expect(matchesCandidateSearch(cand({}), '')).toBe(true);
    expect(matchesCandidateSearch(cand({}), '   ')).toBe(true);
    expect(matchesCandidateSearch(cand({ name: null, email: null }), '')).toBe(true);
  });

  it('matches the name case- and accent-insensitively, in either direction', () => {
    const jose = cand({ name: 'José Álvarez', email: null });
    expect(matchesCandidateSearch(jose, 'jose')).toBe(true);
    expect(matchesCandidateSearch(jose, 'ALVAREZ')).toBe(true);
    expect(matchesCandidateSearch(cand({ name: 'Jose Alvarez' }), 'José')).toBe(true);
  });

  it('matches part of the email, the domain included', () => {
    expect(matchesCandidateSearch(cand({}), 'jane.doe@')).toBe(true);
    expect(matchesCandidateSearch(cand({}), 'example.com')).toBe(true);
    expect(matchesCandidateSearch(cand({}), 'other.org')).toBe(false);
  });

  it('requires EVERY token to match (AND), across name and email', () => {
    const rows = [
      cand({ id: 'a', name: 'Sam Rao', email: 'sam@acme.io' }),
      cand({ id: 'b', name: 'Sam Iyer', email: 'sam@globex.io' }),
    ];
    expect(rows.filter((r) => matchesCandidateSearch(r, 'sam acme')).map((r) => r.id)).toEqual(['a']);
    expect(rows.filter((r) => matchesCandidateSearch(r, 'sam')).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.filter((r) => matchesCandidateSearch(r, 'sam nobody'))).toEqual([]);
  });

  it('never matches a token across the name/email boundary', () => {
    // "doe" ends the name and "jane" starts the email: "doejane" is in neither.
    expect(matchesCandidateSearch(cand({}), 'doejane')).toBe(false);
  });

  it('does NOT search skills, role or status (name, email and phone only)', () => {
    const c = cand({ skills: ['Kubernetes'], status: 'screened' });
    expect(matchesCandidateSearch(c, 'kubernetes')).toBe(false);
    expect(matchesCandidateSearch(c, 'screened')).toBe(false);
  });

  it('is null-safe: a shell row with no name, email or phone matches nothing', () => {
    const shell = cand({ name: null, email: null, phone_e164: null });
    expect(() => matchesCandidateSearch(shell, 'jane')).not.toThrow();
    expect(matchesCandidateSearch(shell, 'jane')).toBe(false);
    expect(matchesCandidateSearch(cand({ name: null }), 'jane.doe')).toBe(true);
    expect(matchesCandidateSearch(cand({ email: null }), 'doe')).toBe(true);
  });

  it('treats regex metacharacters as literal text', () => {
    const c = cand({ name: 'C++ (Ops) Dev', email: 'a.b@x.io' });
    expect(matchesCandidateSearch(c, 'c++')).toBe(true);
    expect(matchesCandidateSearch(c, '(ops)')).toBe(true);
    expect(matchesCandidateSearch(c, '.*')).toBe(false);
    expect(matchesCandidateSearch(c, '[')).toBe(false);
    expect(matchesCandidateSearch(c, 'a.b')).toBe(true);
    expect(matchesCandidateSearch(cand({ email: 'aXb@x.io' }), 'a.b')).toBe(false);
  });

  describe('phone digits', () => {
    const withPhone = cand({ phone_e164: '+919876543210' });

    it('matches a partial number, a formatted number and the full E.164', () => {
      expect(matchesCandidateSearch(withPhone, '98765')).toBe(true);
      expect(matchesCandidateSearch(withPhone, '+91 98765 43210')).toBe(true);
      expect(matchesCandidateSearch(withPhone, '(987) 654-3210')).toBe(true);
      expect(matchesCandidateSearch(withPhone, '+919876543210')).toBe(true);
      expect(matchesCandidateSearch(withPhone, '11111')).toBe(false);
    });

    it(`never phone-matches fewer than ${PHONE_MIN_DIGITS} digits`, () => {
      expect(matchesCandidateSearch(withPhone, '987')).toBe(false);
      expect(matchesCandidateSearch(withPhone, '+9')).toBe(false);
    });

    it('combines a phone token with a name token (AND)', () => {
      expect(matchesCandidateSearch(withPhone, 'jane 43210')).toBe(true);
      expect(matchesCandidateSearch(withPhone, 'sam 43210')).toBe(false);
    });

    it('never matches digits when the row carries no phone (redacted for this viewer)', () => {
      const redacted = cand({ phone_e164: null });
      expect(matchesCandidateSearch(redacted, '98765')).toBe(false);
      expect(matchesCandidateSearch(redacted, '+91 98765 43210')).toBe(false);
    });

    it('does not treat a mixed token as a phone number', () => {
      expect(matchesCandidateSearch(withPhone, 'x98765')).toBe(false);
    });
  });
});
