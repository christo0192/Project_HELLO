/**
 * Client-side free-text search over the candidate list (the `q` dimension of
 * the candidate filter contract, see candidateFilters.ts).
 *
 * What it matches, and nothing else:
 *   - the candidate's `name`
 *   - the candidate's `email` (the whole address, domain included)
 *   - the candidate's phone DIGITS — only when the row carries a phone at
 *     all. The list API nulls `phone_e164` for every role that may not see
 *     it (`redactCandidatePhone`), so a viewer or interviewer can never use
 *     search to test whether a number belongs to a candidate: there is no
 *     number in their payload to match against.
 *
 * Matching rules:
 *   - case- and accent-insensitive ("jose" finds "José");
 *   - the query is split on whitespace and EVERY token must match (AND);
 *   - substring matching with `String.includes`, never a RegExp, so `c++`,
 *     `(` or `.*` are literal text;
 *   - a token made only of phone characters (digits, space, `+ ( ) . -`) with
 *     at least `PHONE_MIN_DIGITS` digits ALSO matches when its digits occur in
 *     the phone's digits ("98765", "+91 98765 43210").
 *
 * Pure and synchronous: no React, no network, no logging. The query never
 * leaves the browser.
 */

import type { Candidate } from '../../types';

/** Fewest digits a token needs before it is tried against the phone. */
export const PHONE_MIN_DIGITS = 4;

const PHONE_TOKEN = /^[\d\s+().-]+$/;

/** Case- and accent-insensitive match key (NFD, strip marks, lowercase). */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

/** The folded tokens of a query; empty for a blank query. */
export function candidateSearchTokens(query: string): string[] {
  return foldSearchText(query).split(/\s+/).filter(Boolean);
}

type Searchable = Pick<Candidate, 'name' | 'email' | 'phone_e164'>;

/**
 * True when the candidate matches every token of `query`. An empty query
 * matches everything.
 */
export function matchesCandidateSearch(candidate: Searchable, query: string): boolean {
  const tokens = candidateSearchTokens(query);
  if (tokens.length === 0) return true;
  // A newline separator: tokens never contain whitespace, so no token can
  // match across the name/email boundary.
  const haystack = `${foldSearchText(candidate.name ?? '')}\n${foldSearchText(candidate.email ?? '')}`;
  const phoneDigits = candidate.phone_e164 ? digitsOf(candidate.phone_e164) : '';
  const phoneMatches = (text: string): boolean => {
    if (!phoneDigits || !PHONE_TOKEN.test(text)) return false;
    const digits = digitsOf(text);
    return digits.length >= PHONE_MIN_DIGITS && phoneDigits.includes(digits);
  };
  // A whole query that is one spaced-out number ("+91 98765 43210") is tried
  // as ONE number first: split into tokens, its "+91" would be too short to
  // phone-match on its own.
  if (phoneMatches(query.trim())) return true;
  return tokens.every((token) => haystack.includes(token) || phoneMatches(token));
}
