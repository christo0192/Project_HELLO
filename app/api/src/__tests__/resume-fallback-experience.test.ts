/**
 * resume-fallback-experience.test.ts — the deterministic extractor derives
 * experience from dated ROLE lines only.
 *
 * Verification finding F1: the first cut admitted any line whose text merely
 * CONTAINED a role word — "Bachelor of Engineer|ing, VIT, 2014 – 2018" — and
 * counted it as a four-year stint, and bullet achievements with years in them
 * became stints too. These pin the whole-word gate, the bullet skip and the
 * education veto on the deterministic path.
 */

import { describe, it, expect } from 'vitest';
import { fallbackParseResumeText } from '../lib/resume-fallback.js';

const NOW_YEAR = new Date().getUTCFullYear();

function resume(educationLine: string, bullets: string[] = []): string {
  return [
    'Priya Sharma',
    'Bengaluru, Karnataka 560001 | +91 98765 43210 | priya.sharma@example.com',
    'EXPERIENCE',
    'Senior Sales Executive, Acme Software Pvt Ltd — Bengaluru        Jan 2021 – Present',
    ...bullets,
    'Sales Associate, Beta Solutions — Pune                          Jun 2018 – Dec 2020',
    'EDUCATION',
    educationLine,
  ].join('\n');
}

describe('fallbackParseResumeText — experience_years from dated role lines', () => {
  it('sums the two dated role lines and copies the current role’s period', () => {
    const out = fallbackParseResumeText(resume('B.Tech, VIT, 2014 – 2018'));
    // Jun 2018 → now, with the union covering both stints.
    const expected = Math.round((((NOW_YEAR * 12 + new Date().getUTCMonth()) - (2018 * 12 + 5)) / 12) * 10) / 10;
    expect(out.experience_years).toBe(expected);
    expect(out.recent_role?.period).toBe('Jan 2021 – Present');
    expect(out.phone).toBe('+91 98765 43210');
  });

  it.each([
    'Bachelor of Engineering, VIT, 2014 – 2018',
    'B.E. Electronics and Communication Engineering, Anna University, 2014 – 2018',
    'MBA (Sales & Marketing), Symbiosis, 2016 – 2018',
    'PGDM – Marketing & Sales, IIM Indore, 2016 – 2018',
    'Diploma in Computer Engineering, Govt Polytechnic, 2012 – 2015',
    'M.Tech Software Engineering, IIT Delhi, 2016 – 2018',
  ])('does not count the education line "%s" as a stint', (edu) => {
    const withEdu = fallbackParseResumeText(resume(edu)).experience_years;
    const without = fallbackParseResumeText(resume('B.Tech, VIT, 2014 – 2018')).experience_years;
    expect(withEdu).toBe(without);
  });

  it('does not count bullet achievements that mention years', () => {
    const bullets = [
      '- Managing sales team since 2015, currently leading 20 reps',
      '- Won Sales Excellence award in 2010 and 2012',
      '- Handled 2000 clients as sales lead from 2021 to present',
    ];
    const withBullets = fallbackParseResumeText(resume('B.Tech, VIT, 2014 – 2018', bullets)).experience_years;
    const without = fallbackParseResumeText(resume('B.Tech, VIT, 2014 – 2018')).experience_years;
    expect(withBullets).toBe(without);
  });

  it('a stated total still wins over the derivation', () => {
    const text = `${resume('B.Tech, VIT, 2014 – 2018')}\nSUMMARY\nSales professional with 3+ years of experience.`;
    expect(fallbackParseResumeText(text).experience_years).toBe(3);
  });

  it('returns null when no role line carries a range', () => {
    expect(fallbackParseResumeText('Priya Sharma\nSales Associate, Beta Solutions, Pune\nB.Tech, VIT, 2014 – 2018').experience_years).toBeNull();
  });
});
