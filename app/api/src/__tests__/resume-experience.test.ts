/**
 * resume-experience.test.ts — total years derived from dated role evidence.
 *
 * The dashboard showed `—` for experience on nearly every candidate because
 * neither structurer ever added up the role dates a résumé actually carries.
 * These tests pin the arithmetic (union of spans, inclusive named end-month,
 * "Present" anywhere in the segment, multi-stint periods) and, just as
 * importantly, the REFUSALS: a period that does not describe a range yields
 * nothing, never a guess — because the figure is read back to the candidate by
 * the live résumé-conflict probe, a wrong number is worse than null.
 *
 * Every input below that produced a WRONG non-null figure in the first cut of
 * this module (adversarial review, 2026-09-10) is pinned here with the correct
 * answer. `now` is injected everywhere so the suite is stable across time.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveExperienceYearsFromRoles,
  parsePeriod,
  extractDateTokens,
  extractPeriodFromLine,
  isEducationLikeRole,
  parseDurationMonths,
  monthFromWord,
  unionMonths,
} from '../lib/resume-experience.js';

const NOW = new Date(Date.UTC(2026, 8, 10)); // 2026-09-10 → current month index = Sep

const role = (period: string | null, title = 'Sales Executive', employer: string | null = null) =>
  ({ title, employer, period, highlights: [] });
const years = (period: string) => deriveExperienceYearsFromRoles([role(period)], NOW);
const months = (period: string) => unionMonths(parsePeriod(period, NOW).spans);

describe('single stints — the counting convention', () => {
  it.each([
    ['Jan 2021 – Present', 68],            // Jan 2021 → Sep 2026, month in progress excluded
    ['January 2021 - present', 68],
    ['Jun 2018 – Dec 2020', 31],           // named end month is inclusive
    ['06/2018 - 12/2020', 31],
    ['2018-06 to 2020-12', 31],
    ['2018 – 2020', 24],                   // bare years anchor to January
    ['2019 to date', 92],
    ["Jun'18 - Dec'20", 31],
    ['Sept. 2019 — Mar. 2022', 31],
    ['Jan 2022 – Dec 2023', 24],
    ['Mar 2021 – Mar 2021', 1],            // same month: one month, not zero
    ['2020 – 2020', 1],
    ['Mar-2019 to Jun-2021', 28],          // hyphen between month word and year
    ['March 2020 - Feburary 2022', 24],    // one-edit month typo resolves
    ['Q1 2020 – Q4 2021', 24],             // quarters cover their three months
    ['01/06/2018 – 30/11/2020', 30],       // day-first full dates: the day is skipped
  ])('%s → %i months', (period, expected) => {
    expect(months(period)).toBe(expected);
  });
});

describe('"Present" anywhere in the segment ends the span at now (review C1/H2)', () => {
  it.each([
    ['Jan 2019 – Present (promoted to Manager, Jan 2021)', 7.7],
    ['Jan 2019 – Present (Acme acquired by Beta in 2022)', 7.7],
    ['Jan 2021 - Present (5 years 8 months)', 5.7],
    ['Aug 2019 – Till Date (Kolkata)', 7.1],
    ['Jun 2018 – Present | Full-time', 8.3],
    ['2021 – Present (3 yrs)', 5.7],
    ['Jan 2021 – Present, Bengaluru', 5.7],
    ['(Jan 2021 – Present)', 5.7],
    ['Jan 2021 – Currently working', 5.7],
    ['Jan 2021 - Present · 5 yrs 8 mos', 5.7],
    ['Jan-2020 – Present', 6.7],
  ])('%s → %s years', (period, expected) => {
    expect(years(period)).toBe(expected);
  });

  it('but "Present" inside another word does not', () => {
    expect(years('2020 Presentation Skills')).toBeNull();
  });
});

describe('several stints in one period are split and unioned, not first-to-last (review C1)', () => {
  it.each([
    ['Jul 2017 – Present; Team Lead since Jan 2022', 9.2],
    ['2019 – 2020, 2022 – Present', 5.7],         // comma splits only when every piece is a range
    ['Jan 2020 – Dec 2021 | Jan 2022 – Present', 6.7],
  ])('%s → %s years', (period, expected) => {
    expect(years(period)).toBe(expected);
  });
});

describe('"Month DD, YYYY" — the day is a day, not a two-digit year (review C2)', () => {
  it.each([
    ['May 12, 2021 – Jun 3, 2022', 1.2],
    ['Jan 05, 2021 – Present', 5.7],
    ['June 15, 2019 - March 20, 2022', 2.8],
    ['Jun 18, 2020 – Present', 6.3],
    ['Sep 30, 2020 – Present', 6],
  ])('%s → %s years', (period, expected) => {
    expect(years(period)).toBe(expected);
  });

  it('a two-digit year is accepted only behind an apostrophe', () => {
    expect(extractDateTokens("Jun'18", NOW)).toMatchObject([{ year: 2018, month: 6 }]);
    expect(extractDateTokens("Jun'99", NOW)).toMatchObject([{ year: 1999, month: 6 }]);
    expect(extractDateTokens('May 12', NOW)).toEqual([]);
  });
});

describe('stated durations', () => {
  it('parse in years and months', () => {
    expect(parseDurationMonths('(5 years 8 months)')).toBe(68);
    expect(parseDurationMonths('2 yrs 7 mos')).toBe(31);
    expect(parseDurationMonths('approx 2.5 years')).toBe(30);
    expect(parseDurationMonths('6 months')).toBe(6);
    expect(parseDurationMonths('Full-time')).toBeNull();
  });

  it('count on their own when the role has no dates', () => {
    expect(years('2 years 3 months')).toBe(2.3);
    expect(years('5 yrs 8 mos')).toBe(5.7);
  });

  it('outrank a bare-year range they accompany, never a dated one', () => {
    expect(years('2019 – 2020 | 2 yrs')).toBe(2);
    expect(years('2018 – 2020 (approx 2.5 years)')).toBe(2.5);
    expect(years('Jan 2021 - Present (5 years 8 months)')).toBe(5.7); // dates win
  });
});

describe('refusals — nothing rather than a guess', () => {
  it.each([
    'March 2020', 'Since 2020', 'Dec 2020 – Jan 2018', 'Full time', '', 'Jan 2021 -',
    '1899 – 2019', '2019 – 2099', '06/15/2018 – 12/2020', 'FY2020-FY2022',
  ])('%s → null', (period) => {
    expect(years(period)).toBeNull();
  });

  it('ignores implausible years rather than counting them', () => {
    expect(extractDateTokens('Page 1042 – 2019', NOW)).toMatchObject([{ year: 2019, month: 1, hasMonth: false }]);
  });

  it('a non-month word before a year yields the bare year, not a month', () => {
    expect(extractDateTokens('Quarter 2021', NOW)).toMatchObject([{ year: 2021, month: 1, hasMonth: false }]);
    expect(monthFromWord('Marketing')).toBeNull();
    expect(monthFromWord('Decade')).toBeNull();
    expect(monthFromWord('Sept')).toBe(9);
    expect(monthFromWord('Feburary')).toBe(2);
  });

  it('refuses a career longer than a human one', () => {
    expect(years('1950 – Present')).toBeNull();
  });
});

describe('deriveExperienceYearsFromRoles — the recruiter’s sum', () => {
  it('sums sequential roles to one decimal', () => {
    expect(deriveExperienceYearsFromRoles([role('Jan 2021 – Present'), role('Jun 2018 – Dec 2020')], NOW)).toBe(8.3); // 68+31=99 → 8.25 → 8.3
  });

  it('the LinkedIn PDF export shape sums correctly', () => {
    expect(deriveExperienceYearsFromRoles([
      role('Jan 2021 - Present (5 years 8 months)'), role('Jun 2018 - Dec 2020 (2 years 7 months)'),
    ], NOW)).toBe(8.3);
  });

  it('UNIONS overlapping roles instead of double-counting them', () => {
    expect(deriveExperienceYearsFromRoles([role('Jan 2019 – Dec 2021'), role('Jan 2020 – Dec 2022')], NOW)).toBe(4); // 48 months, not 72
  });

  it('adjacent roles leave no gap artefact', () => {
    expect(deriveExperienceYearsFromRoles([role('Jan 2019 – Dec 2020'), role('Jan 2021 – Present')], NOW)).toBe(7.7); // 92 months
  });

  it('skips education entries that leaked into the role list (review M3)', () => {
    expect(deriveExperienceYearsFromRoles([
      role('Jul 2022 – Present'),
      role('2018 – 2022', 'B.Tech CSE', 'VIT'),
      role('2016 – 2018', 'Higher Secondary', 'DAV School'),
    ], NOW)).toBe(4.2);
    // …but a teaching JOB at a college is employment.
    expect(deriveExperienceYearsFromRoles([role('2018 – 2022', 'Assistant Professor', 'VIT')], NOW)).toBe(4);
  });

  it('skips roles whose period does not parse and still sums the rest', () => {
    expect(deriveExperienceYearsFromRoles([role(null), role('Freelance'), role('2018 – 2020')], NOW)).toBe(2);
  });

  it('returns null when nothing parses, never zero', () => {
    expect(deriveExperienceYearsFromRoles([role(null), role('Contract')], NOW)).toBeNull();
    expect(deriveExperienceYearsFromRoles([], NOW)).toBeNull();
    expect(deriveExperienceYearsFromRoles([null, undefined], NOW)).toBeNull();
  });
});

describe('extractPeriodFromLine — the deterministic extractor’s evidence', () => {
  it('copies the date range off a structured role line, verbatim', () => {
    expect(extractPeriodFromLine('Senior Sales Executive, Acme Software Pvt Ltd — Bengaluru        Jan 2021 – Present', NOW))
      .toBe('Jan 2021 – Present');
    expect(extractPeriodFromLine('Sales Associate, Beta Solutions — Pune  Jun 2018 – Dec 2020', NOW))
      .toBe('Jun 2018 – Dec 2020');
  });

  it('keeps apostrophe-year and numeric-month tokens whole (verification F3)', () => {
    expect(extractPeriodFromLine("Sales Executive, Acme, Jun'18 – Present", NOW)).toBe("Jun'18 – Present");
    expect(extractPeriodFromLine('Sales Executive, Acme, 03/2019 - 06/2021', NOW)).toBe('03/2019 - 06/2021');
    expect(extractPeriodFromLine('Sales Executive, Acme, 2019/03 - 2021/06', NOW)).toBe('2019/03 - 2021/06');
  });

  it('anchors on the range separator so a stray number is never the start year (verification F4)', () => {
    expect(extractPeriodFromLine('Sales Executive, Acme (Est. 1985), Jan 2021 – Present', NOW)).toBe('Jan 2021 – Present');
    expect(extractPeriodFromLine('Sales Executive, Room 2019, Acme Towers, 2021 - Present', NOW)).toBe('2021 - Present');
    expect(extractPeriodFromLine('Sales Executive, Acme, Pune 411001, 9876543210, Jan 2021 – Present', NOW)).toBe('Jan 2021 – Present');
  });

  it('returns null for a line with no range', () => {
    expect(extractPeriodFromLine('Sales Associate, Beta Solutions, Pune', NOW)).toBeNull();
    expect(extractPeriodFromLine('Joined in 2019', NOW)).toBeNull();
    expect(extractPeriodFromLine('- Managing sales team since 2015, currently leading 20 reps', NOW)).toBeNull();
    expect(extractPeriodFromLine('- Won Sales Excellence award in 2010 and 2012', NOW)).toBeNull();
  });
});

describe('isEducationLikeRole — degrees are education, jobs at institutions are jobs (verification F2)', () => {
  const r = (title: string | null, employer: string | null) => ({ title, employer, period: '2018 – 2020', highlights: [] });
  it.each([
    ['Program Advisor', 'Amity University'], ['Admissions Counsellor', 'LPU'], ['School Counsellor', 'DPS'],
    ['Coordinator', 'Delhi Public School'], ['Campus Recruiter', 'Bennett University'], ['Sales Head', 'IIT Madras'],
    ['Master Trainer', "Byju's"], ['Accountant', "St Xavier's College"], ['Assistant Professor', 'VIT'],
    ['Sales Executive', 'Symbiosis Institute of Business Management'], ['College Relations Manager', 'Acme'],
    ['Master Data Analyst', 'Acme'], ['Degree Apprentice Engineer', 'Rolls-Royce'],
  ])('%s @ %s is a job', (title, employer) => {
    expect(isEducationLikeRole(r(title, employer))).toBe(false);
  });
  it.each([
    ['B.Tech CSE', 'VIT'], ['Bachelor of Engineering', 'VIT'], ['MBA (Sales & Marketing)', 'Symbiosis'],
    ['Higher Secondary', 'DAV School'], ['Class of 2019', 'IIM Indore'], ['Student', 'VIT'],
    [null, 'Anna University'], ['Bachelor of Engineering, VIT, 2014 – 2018', null],
  ])('%s @ %s is education', (title, employer) => {
    expect(isEducationLikeRole(r(title, employer))).toBe(true);
  });
});

describe('stated durations on a bare-year range go both ways', () => {
  it('shortens as well as lengthens', () => {
    expect(years('2019 – 2020 (6 months)')).toBe(0.5);
    expect(years('2019 – 2020 | 6 months')).toBe(0.5);
    expect(years('Jan 2020 – Mar 2020 (3 years)')).toBe(0.3); // month-precise end still wins
  });
});
