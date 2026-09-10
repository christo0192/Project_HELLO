/**
 * resume-structurer-tolerant-shape.test.ts — the validator no longer throws a
 * whole résumé away over a benign JSON type.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `coerceStructuredResume` rejected the ENTIRE model answer when any present
 * key had an unexpected JSON type. Measured against ordinary model output
 * (`"experience_years": "5+"`, `"phone": 9876543210`, `"skills": "Sales,
 * CRM"`, a role written as a string), 7 of 7 such answers were discarded, the
 * deterministic keyword extractor took over, and the candidate surfaced with
 * `Sales / Communication / Excel` skills, no experience and — because the
 * regex tag is not dialable — no callable phone. That is the exact row shape
 * the recruiter dashboard was showing.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────
 *  1. Each benign deviation coerces (or nulls its own field); the result is
 *     kept. Whole-result rejection is reserved for "not an object" and a
 *     throwing getter.
 *  2. Dialing safety did not move: a coerced numeric phone still has to pass
 *     `deriveCandidatePhone`'s strict gate and provenance allowlist, which are
 *     exercised end-to-end below.
 *  3. `experience_years` is derived from dated roles when the model gave none.
 *  4. `current_role` mirrors `recent_role.title` when the model left it empty.
 */

import { describe, it, expect } from 'vitest';
import { coerceStructuredResume, mergeStructuredResume } from '../lib/resume-structurer.js';
import { fallbackParseResumeText } from '../lib/resume-fallback.js';
import { deriveCandidatePhone, MODEL_STRUCTURER_VERSION } from '../lib/candidate-phone.js';

const BASE = { name: 'Priya Sharma', skills: ['B2B SaaS Sales'] };

describe('coerceStructuredResume — benign type deviations are coerced, not fatal', () => {
  it.each([
    ['experience_years "5+"', { experience_years: '5+' }, (o: any) => expect(o.experience_years).toBe(5)],
    ['experience_years "5.5 years"', { experience_years: '5.5 years' }, (o: any) => expect(o.experience_years).toBe(5.5)],
    ['experience_years "7-9 years"', { experience_years: '7-9 years' }, (o: any) => expect(o.experience_years).toBe(7)],
    ['experience_years "N/A" nulls only itself', { experience_years: 'N/A' }, (o: any) => expect(o.experience_years).toBeNull()],
    ['name as number renders', { name: 42 }, (o: any) => expect(o.name).toBe('42')],
    ['summary as sentence array joins', { summary: ['Sells software.', 'Leads a team.'] }, (o: any) => expect(o.summary).toBe('Sells software. Leads a team.')],
    ['summary as object nulls only itself', { summary: { text: 'x' } }, (o: any) => expect(o.summary).toBeNull()],
    ['skills as comma string splits', { skills: 'Sales, Negotiation; CRM' }, (o: any) => expect(o.skills).toEqual(['Sales', 'Negotiation', 'CRM'])],
    ['skills as object entries unwrap', { skills: [{ name: 'Excel' }, 'Salesforce', 7] }, (o: any) => expect(o.skills).toEqual(['Excel', 'Salesforce'])],
    ['education as single string stays ONE entry (commas live inside a degree line)', { education: 'MBA, Symbiosis 2018' }, (o: any) => expect(o.education).toEqual(['MBA, Symbiosis 2018'])],
    ['recent_role as plain string → title', { recent_role: 'Senior Sales Executive at Acme' },
      (o: any) => expect(o.recent_role).toEqual({ title: 'Senior Sales Executive at Acme', employer: null, period: null, highlights: [] })],
    ['recent_role with alias keys', { recent_role: { position: 'Sales Lead', company: 'Acme', dates: '2020 – 2022', achievements: ['Grew ARR'] } },
      (o: any) => expect(o.recent_role).toEqual({ title: 'Sales Lead', employer: 'Acme', period: '2020 – 2022', highlights: ['Grew ARR'] })],
    ['prior_roles with a string entry', { prior_roles: ['Sales Associate at Beta', { title: 'Intern' }] },
      (o: any) => expect(o.prior_roles.map((r: any) => r.title)).toEqual(['Sales Associate at Beta', 'Intern'])],
    ['prior_roles as a lone object', { prior_roles: { title: 'Intern' } }, (o: any) => expect(o.prior_roles).toHaveLength(1)],
    ['null-words become null', { current_role: 'Not specified', email: 'none', summary: 'Not applicable.' }, (o: any) => { expect(o.current_role).toBeNull(); expect(o.email).toBeNull(); expect(o.summary).toBeNull(); }],
    ['experience_years in MONTHS converts to years (review: "6 months" was 6)', { experience_years: '18 months' }, (o: any) => expect(o.experience_years).toBe(1.5)],
    ['experience_years "6 months" → 0.5', { experience_years: '6 months' }, (o: any) => expect(o.experience_years).toBe(0.5)],
    ['experience_years negative / percentage → null', { experience_years: '-5' }, (o: any) => expect(o.experience_years).toBeNull()],
    ['experience_years "less than 1 year" → 1 (leading figure)', { experience_years: 'about 1 year' }, (o: any) => expect(o.experience_years).toBe(1)],
    ['prose fields are NOT comma-split', { career_highlights: 'Grew ARR 40%, closed 12 enterprise deals, built a team of 8' },
      (o: any) => expect(o.career_highlights).toEqual(['Grew ARR 40%, closed 12 enterprise deals, built a team of 8'])],
    ['education keeps degree, institute, year together', { education: 'B.Tech, Computer Science, IIT Delhi, 2015\nMBA, IIM Bangalore, 2019' },
      (o: any) => expect(o.education).toEqual(['B.Tech, Computer Science, IIT Delhi, 2015', 'MBA, IIM Bangalore, 2019'])],
    ['bulleted string lists drop the bullets on every line', { skills: '- Sales\n- CRM\n- Excel' }, (o: any) => expect(o.skills).toEqual(['Sales', 'CRM', 'Excel'])],
    ['a junk numeric phone (a PIN, a "5") is null so the regex number can win the merge', { phone: 560001 }, (o: any) => expect(o.phone).toBeNull()],
    ['a junk short string phone is null too', { phone: 'ext 22' }, (o: any) => expect(o.phone).toBeNull()],
  ])('%s — result KEPT', (_label, extra, check) => {
    const out = coerceStructuredResume({ ...BASE, ...extra });
    expect(out).not.toBeNull();
    expect(out!.name === '42' || out!.name === 'Priya Sharma').toBe(true);
    check(out);
  });

  it('a numeric phone coerces to its digits — and dialability is STILL decided downstream', () => {
    const out = coerceStructuredResume({ ...BASE, phone: 9876543210 })!;
    expect(out.phone).toBe('9876543210');
    // Model provenance + strict IN mobile → dialable, exactly as the string form would be.
    expect(deriveCandidatePhone(out.phone, MODEL_STRUCTURER_VERSION)).toEqual({
      raw: '9876543210', e164: '+919876543210', valid: true,
    });
    // A landline-shaped or foreign number stays undialable through the same gate.
    const landline = coerceStructuredResume({ ...BASE, phone: 2212345678 })!;
    expect(deriveCandidatePhone(landline.phone, MODEL_STRUCTURER_VERSION).valid).toBe(false);
    // Non-integer / unsafe numbers are not phone numbers.
    expect(coerceStructuredResume({ ...BASE, phone: 98765.5 })!.phone).toBeNull();
    expect(coerceStructuredResume({ ...BASE, phone: 2 ** 60 })!.phone).toBeNull();
    // A fallback-tagged coerced phone is refused by provenance, as before.
    expect(deriveCandidatePhone(out.phone, `${MODEL_STRUCTURER_VERSION}+fallback`).valid).toBe(false);
  });

  it('splits a long whitespace-padded list string in linear time (review: the old splitter was ~n³)', () => {
    const padded = `Sales${' '.repeat(20_000)}CRM`;
    const t0 = performance.now();
    const out = coerceStructuredResume({ ...BASE, skills: padded, career_highlights: padded, education: padded })!;
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out.skills.length).toBeGreaterThanOrEqual(1);
  });

  it('the merge lets the regex number win when the model’s phone was junk', () => {
    const model = coerceStructuredResume({ ...BASE, phone: 5 })!;
    const det = fallbackParseResumeText('Priya Sharma\nBengaluru | +91 98765 43210 | p@example.com');
    const merged = mergeStructuredResume(model, det);
    expect(merged.structured.phone).toBe('+91 98765 43210');
    expect(merged.phoneFromModel).toBe(false); // …and it is tagged +fallback, undialable, as before
  });

  it('still rejects the WHOLE answer when it is not an object, or reading it throws', () => {
    for (const v of [null, undefined, 'text', 42, true, [], [{ phone: '9876543210' }]]) {
      expect(coerceStructuredResume(v)).toBeNull();
    }
    const hostile = Object.defineProperty({}, 'phone', {
      get() { throw new Error('hostile'); }, enumerable: true, configurable: true,
    });
    expect(coerceStructuredResume(hostile)).toBeNull();
  });
});

describe('coerceStructuredResume — experience_years and current_role gaps filled from evidence', () => {
  const NOW_YEAR = new Date().getUTCFullYear();

  it('derives experience_years from dated roles when the model returned none', () => {
    const out = coerceStructuredResume({
      ...BASE,
      recent_role: { title: 'Sr Sales Exec', employer: 'Acme', period: 'Jan 2021 – Dec 2023', highlights: [] },
      prior_roles: [{ title: 'Sales Associate', employer: 'Beta', period: 'Jun 2018 – Dec 2020', highlights: [] }],
    })!;
    // 36 + 31 = 67 months (named end months inclusive) → 5.6
    expect(out.experience_years).toBe(5.6);
  });

  it('prefers the model’s own figure over the derivation', () => {
    const out = coerceStructuredResume({
      ...BASE, experience_years: 9,
      recent_role: { title: 'x', employer: null, period: '2020 – 2022', highlights: [] },
    })!;
    expect(out.experience_years).toBe(9);
  });

  it('leaves experience_years null when neither a figure nor a parseable period exists', () => {
    const out = coerceStructuredResume({ ...BASE, recent_role: { title: 'x', period: 'Full time' } })!;
    expect(out.experience_years).toBeNull();
    expect(NOW_YEAR).toBeGreaterThan(2000); // sanity: the derivation clock is real time here
  });

  it('mirrors recent_role.title into an empty current_role, and never overwrites a given one', () => {
    expect(coerceStructuredResume({ ...BASE, recent_role: { title: 'Sales Lead' } })!.current_role).toBe('Sales Lead');
    expect(coerceStructuredResume({ ...BASE, current_role: 'Given', recent_role: { title: 'Other' } })!.current_role).toBe('Given');
  });
});

describe('mergeStructuredResume — the derivation also covers the merged result', () => {
  it('fills experience_years from the model’s dated roles when both sides lack a figure', () => {
    const model = coerceStructuredResume({
      ...BASE,
      // Model gave dated roles but the coercion above already derived years; force
      // the merge path by clearing it, as an older cached structured blob could.
      recent_role: { title: 'x', period: 'Jan 2022 – Dec 2023' },
    })!;
    const cleared = { ...model, experience_years: null };
    const merged = mergeStructuredResume(cleared, fallbackParseResumeText('no years phrase here'));
    expect(merged.structured.experience_years).toBe(2);
  });
});

describe('the fallback signature the dashboard showed', () => {
  it('the keyword extractor on a sales résumé yields the Sales/Communication/Excel shape — i.e. a model-tier surrender', () => {
    const det = fallbackParseResumeText(
      'Christo\nBengaluru 560001 | 98765 43210\nSales professional with strong communication skills; advanced Excel user.',
    );
    expect(det.skills).toEqual(['Sales', 'Communication', 'Excel']);
    // …and the regex tag can never make that phone dialable — which is why the
    // owner saw "invalid phone" on exactly these rows.
    expect(deriveCandidatePhone(det.phone, 'deterministic-fallback-1').valid).toBe(false);
  });
});
