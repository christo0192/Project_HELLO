/**
 * resume-experience.test.ts — total years derived from dated role evidence.
 *
 * The dashboard showed `—` for experience on nearly every candidate because
 * neither structurer ever added up the role dates a résumé actually carries.
 * These tests pin the arithmetic (union of spans, month precision, inclusive
 * named end-month, "Present" anchoring) and, just as importantly, the
 * REFUSALS: a period that does not describe a range yields nothing, never a
 * guess.
 *
 * `now` is injected everywhere so the suite is stable across calendar time.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveExperienceYearsFromRoles,
  parsePeriodMonths,
  extractDateTokens,
} from '../lib/resume-experience.js';

const NOW = new Date(Date.UTC(2026, 8, 10)); // 2026-09-10 → current month index = Sep

const role = (period: string | null) => ({ title: 'x', employer: null, period, highlights: [] });
const months = (span: [number, number] | null) => (span ? span[1] - span[0] : null);

describe('parsePeriodMonths — one role period into a month interval', () => {
  it.each([
    ['Jan 2021 – Present', 12 * 5 + 8],          // Jan 2021 → Sep 2026 (exclusive of the month in progress)
    ['January 2021 - present', 12 * 5 + 8],
    ['Jun 2018 – Dec 2020', 31],                  // named end month is inclusive
    ['06/2018 - 12/2020', 31],
    ['2018-06 to 2020-12', 31],
    ['2018 – 2020', 24],                          // bare years anchor to January
    ['2019 to date', 12 * 7 + 8],
    ["Jun'18 - Dec'20", 31],
    ['Sept. 2019 — Mar. 2022', 31],
    ['Jan 2022 – Dec 2023', 24],
    ['Mar 2021 – Mar 2021', 1],                   // same month: one month, not zero
    ['2020 – 2020', 1],
  ])('%s → %i months', (period, expected) => {
    expect(months(parsePeriodMonths(period, NOW))).toBe(expected);
  });

  it('refuses a lone date with no present marker, an inverted range, and junk', () => {
    expect(parsePeriodMonths('March 2020', NOW)).toBeNull();
    expect(parsePeriodMonths('Since 2020', NOW)).toBeNull(); // "since" is not a marker this module vouches for
    expect(parsePeriodMonths('Dec 2020 – Jan 2018', NOW)).toBeNull();
    expect(parsePeriodMonths('Full time', NOW)).toBeNull();
    expect(parsePeriodMonths('', NOW)).toBeNull();
    expect(parsePeriodMonths(null, NOW)).toBeNull();
  });

  it('ignores implausible years (page numbers, typos) rather than counting them', () => {
    expect(extractDateTokens('Page 1042 – 2019', NOW)).toEqual([{ year: 2019, month: 1, hasMonth: false }]);
    expect(parsePeriodMonths('1899 – 2019', NOW)).toBeNull();
    expect(parsePeriodMonths('2019 – 2099', NOW)).toBeNull();
  });

  it('a word that is not a month still yields the year it precedes; a day-of-month is not a token', () => {
    expect(extractDateTokens('Quarter 2021', NOW)).toEqual([{ year: 2021, month: 1, hasMonth: false }]);
    expect(extractDateTokens('12 May 2021 – 3 Jun 2022', NOW)).toEqual([
      { year: 2021, month: 5, hasMonth: true }, { year: 2022, month: 6, hasMonth: true },
    ]);
  });

  it('does not let "Present" inside another word open a range', () => {
    expect(parsePeriodMonths('2020 Presentation Skills', NOW)).toBeNull();
  });

  it('expands two-digit years around the current century', () => {
    expect(extractDateTokens("Jun'18", NOW)).toEqual([{ year: 2018, month: 6, hasMonth: true }]);
    expect(extractDateTokens("Jun'99", NOW)).toEqual([{ year: 1999, month: 6, hasMonth: true }]);
  });
});

describe('deriveExperienceYearsFromRoles — the recruiter’s sum', () => {
  it('sums sequential roles to one decimal', () => {
    const years = deriveExperienceYearsFromRoles([
      role('Jan 2021 – Present'), role('Jun 2018 – Dec 2020'),
    ], NOW);
    // 68 + 31 = 99 months = 8.25 → 8.3
    expect(years).toBe(8.3);
  });

  it('UNIONS overlapping roles instead of double-counting them', () => {
    const years = deriveExperienceYearsFromRoles([
      role('Jan 2019 – Dec 2021'), role('Jan 2020 – Dec 2022'),
    ], NOW);
    // Jan 2019 → Dec 2022 inclusive = 48 months = 4.0, NOT 36 + 36 = 6.0
    expect(years).toBe(4);
  });

  it('skips roles whose period does not parse and still sums the rest', () => {
    expect(deriveExperienceYearsFromRoles([role(null), role('Freelance'), role('2018 – 2020')], NOW)).toBe(2);
  });

  it('returns null when no period parses, never zero and never a guess', () => {
    expect(deriveExperienceYearsFromRoles([role(null), role('Contract')], NOW)).toBeNull();
    expect(deriveExperienceYearsFromRoles([], NOW)).toBeNull();
    expect(deriveExperienceYearsFromRoles([null, undefined], NOW)).toBeNull();
  });

  it('refuses a career longer than a human one', () => {
    expect(deriveExperienceYearsFromRoles([role('1950 – Present')], NOW)).toBeNull();
  });
});
