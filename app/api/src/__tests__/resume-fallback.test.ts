import { describe, it, expect } from 'vitest';
import { fallbackParseResumeText } from '../lib/resume-fallback.js';
import { normalizePhone } from '../lib/phone.js';

// =====================================================================
//  P0/P1 resume deterministic fallback parser hardening
//  (owner: fix/resume-parser-p0-p1-deepseek-v4)
// =====================================================================

describe('resume-fallback phone extraction (P0)', () => {
  it('keeps a "+" written with a trailing space ("+ 91 ...")', () => {
    const parsed = fallbackParseResumeText('Kingson\n+ 91 6380729078\nkingson@x.com');
    expect(parsed.phone).toBe('+91 6380729078');
  });

  it('does not absorb a preceding pincode and keeps the "+"', () => {
    const parsed = fallbackParseResumeText(
      'Kingson Erode, India 638402 + 91 6380729078\nkingson@x.com',
    );
    // The 6-digit pincode must NOT be part of the phone, and the + is retained.
    expect(parsed.phone).toBe('+91 6380729078');
    expect(parsed.phone).not.toContain('638402');
  });

  it('extracts a spaced number without a country code', () => {
    const parsed = fallbackParseResumeText('Kingson\n91 6380729078');
    expect(parsed.phone).toBe('91 6380729078');
  });

  it('extracts a bare 10-digit number', () => {
    const parsed = fallbackParseResumeText('Kingson\n6380729078');
    expect(parsed.phone).toBe('6380729078');
  });

  it('extracts a number with an internal split ("+91 63807 29078")', () => {
    const parsed = fallbackParseResumeText('Kingson\n+91 63807 29078');
    expect(parsed.phone).toBe('+91 63807 29078');
  });
});

describe('resume-fallback email extraction (P1 ReDoS safety)', () => {
  it('extracts a normal email', () => {
    const parsed = fallbackParseResumeText('Name\nrijo@example.com\nSome prose.');
    expect(parsed.email).toBe('rijo@example.com');
  });

  it('handles subdomains and plus-addressing', () => {
    const parsed = fallbackParseResumeText('Name\na.b+c@sub.domain.co.in');
    expect(parsed.email).toBe('a.b+c@sub.domain.co.in');
  });

  it('completes in bounded time on a catastrophic-backtracking input', () => {
    const evil = 'x@' + '.'.repeat(40000);
    const start = performance.now();
    const parsed = fallbackParseResumeText(evil);
    const elapsedMs = performance.now() - start;
    // No valid email in the adversarial string; must not hang.
    expect(parsed.email).toBeNull();
    // Generous ceiling — the linear form completes in single-digit ms; a
    // catastrophic regex would run for seconds/minutes.
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('resume-fallback prose role extraction (P0)', () => {
  it('populates recent_role.employer from a prose "trader at Quant Tekel" bio', () => {
    // Canonical short form: the candidate's OWN role word ("trader") immediately
    // precedes "at", so the bareAt path recognizes Quant Tekel as an employer.
    const text = [
      'proprietary trader at Quant Tekel driving PnL.',
      'Customer service associate at BigCorp handling escalations.',
    ].join(' ');
    const parsed = fallbackParseResumeText(text);
    expect(parsed.recent_role).not.toBeNull();
    // The Title+Employer path fires on the clean "Customer service associate at
    // BigCorp"; a second clean employer is mined too.
    const allEmployers = [parsed.recent_role, ...(parsed.prior_roles ?? [])]
      .filter(Boolean)
      .map((r) => r!.employer);
    expect(allEmployers).toContain('BigCorp');
    // Evidence-only: no invented dates.
    expect(parsed.recent_role?.period).toBeNull();
  });

  it('extracts a clean employer via the bareAt path when the role word precedes "at"', () => {
    // The candidate's OWN role word ("trader") immediately precedes "at", and
    // the sentence carries a role indicator ("sales"), so the bareAt fallback
    // recognizes Quant Tekel as the employer.
    const parsed = fallbackParseResumeText(
      'proprietary trader at Quant Tekel driving sales and PnL.',
    );
    expect(parsed.recent_role).not.toBeNull();
    expect(parsed.recent_role?.employer).toBe('Quant Tekel');
  });

  it('does not cross a sentence boundary into the title', () => {
    const text = 'Senior Software Engineer at Acme Corp. Previously Analyst with Globex International.';
    const parsed = fallbackParseResumeText(text);
    expect(parsed.recent_role?.title).toBe('Senior Software Engineer');
    expect(parsed.recent_role?.employer).toBe('Acme Corp');
  });

  // ── F2: prose role miner must NOT invent false roles ──────────────────────
  // A false role becomes a fabricated résumé fact the live conflict judge then
  // challenges the candidate about, so each of these must yield NO role.

  it('F2: "expert at Leadership with Confidence" invents no role', () => {
    // "Leadership" contains "lead" but is not a role word on a WORD BOUNDARY;
    // "Confidence"/"Leadership" are not employers held by the candidate.
    const parsed = fallbackParseResumeText(
      'John Doe is an expert at Leadership with Confidence and drives sales results.',
    );
    expect(parsed.recent_role).toBeNull();
    expect(parsed.prior_roles ?? []).toEqual([]);
  });

  it('F2: "Reported to the Manager at Board Meetings" invents no role', () => {
    // "Reported to the Manager" is a multi-clause phrase, not a title; and the
    // role word "Manager" sits behind the article "the" (a referent, not a
    // held title), so the bareAt path does not fire either.
    const parsed = fallbackParseResumeText(
      'Jane Smith Reported to the Manager at Board Meetings while advising executives.',
    );
    expect(parsed.recent_role).toBeNull();
    expect(parsed.prior_roles ?? []).toEqual([]);
  });

  it('F2: "Strategist with vision at Deloitte" invents no role', () => {
    // "Strategist with vision" is a phrase (contains " with "), rejected as a
    // title; the word before "at" is "vision" (not an employment verb / own
    // role word), so the bareAt path does not fire.
    const parsed = fallbackParseResumeText(
      'A Strategist with vision at Deloitte led sales advisory work.',
    );
    expect(parsed.recent_role).toBeNull();
    expect(parsed.prior_roles ?? []).toEqual([]);
  });

  it('F2: "worked at Google as a manager" trims the employer to "Google"', () => {
    // bareAt fires ("worked" is an employment verb) but the employer capture is
    // trimmed at the lowercase " as a manager" tail — no over-capture.
    const parsed = fallbackParseResumeText(
      'Rob worked at Google as a manager on developer tooling.',
    );
    expect(parsed.recent_role).not.toBeNull();
    expect(parsed.recent_role?.employer).toBe('Google');
    expect(parsed.recent_role?.employer).not.toContain('manager');
  });

  it('F2: preserves the clean Title+Employer true positive', () => {
    const parsed = fallbackParseResumeText(
      'Experienced Customer service associate at BigCorp handling escalations.',
    );
    expect(parsed.recent_role?.title).toBe('Customer service associate');
    expect(parsed.recent_role?.employer).toBe('BigCorp');
  });
});

describe('resume-fallback summary contact-strip (P0)', () => {
  it('excludes the contact block; summary starts at the prose', () => {
    const text = [
      'Kingson Erode',
      'Erode, India 638402 + 91 6380729078 kingson@x.com',
      'Dynamic proprietary trader with strong analytical skills at Quant Tekel.',
    ].join('\n');
    const parsed = fallbackParseResumeText(text);
    expect(parsed.summary).not.toBeNull();
    expect(parsed.summary).not.toContain('638402');
    expect(parsed.summary).not.toContain('+91 6380729078');
    expect(parsed.summary).not.toContain('kingson@x.com');
    expect(parsed.summary).toContain('Dynamic proprietary trader');
  });

  // ── F4: the postal heuristic must not false-drop achievement lines ────────

  it('F4: keeps an achievement line with a 6-digit revenue figure', () => {
    const text = [
      'Rijo Thomas',
      'Increased revenue by 250000 in 2023 quarter.',
      'Handled portfolios worth 500000 dollars for key clients.',
    ].join('\n');
    const parsed = fallbackParseResumeText(text);
    expect(parsed.summary).not.toBeNull();
    // A 5-6 digit number in a prose sentence is NOT a postal code.
    expect(parsed.summary).toContain('250000');
    expect(parsed.summary).toContain('500000');
    expect(parsed.summary).toContain('Increased revenue');
    expect(parsed.summary).toContain('Handled portfolios');
  });

  it('F4: a single physical line with a phone/email still yields a non-empty summary', () => {
    // PDF-to-text with no newlines: the whole bio is one line carrying contact
    // tokens. Stripping the line would empty the summary — the empty-guard must
    // fall back to the text with only the contact TOKENS removed.
    const text =
      'Seasoned analyst driving growth across fintech products. Reach me at rijo@x.com or +91 6380729078 anytime.';
    const parsed = fallbackParseResumeText(text);
    expect(parsed.summary).not.toBeNull();
    expect(parsed.summary!.length).toBeGreaterThan(0);
    // The bio prose survives; the contact tokens are stripped.
    expect(parsed.summary).toContain('Seasoned analyst driving growth');
    expect(parsed.summary).not.toContain('rijo@x.com');
    expect(parsed.summary).not.toContain('6380729078');
  });

  it('F4: still strips a genuine address/postal line with an address cue', () => {
    const text = [
      'Priya Sharma',
      'Bengaluru, India 560001',
      'Built and scaled a payments platform serving millions of users.',
    ].join('\n');
    const parsed = fallbackParseResumeText(text);
    expect(parsed.summary).not.toBeNull();
    // The address/postal line (address cue "India" + 6-digit postal) is stripped.
    expect(parsed.summary).not.toContain('560001');
    expect(parsed.summary).toContain('Built and scaled');
  });
});

describe('phone.normalizePhone plus-space safety net (P1)', () => {
  it('normalizes a spaced-plus Indian mobile to E.164', () => {
    const n = normalizePhone('+ 91 6380729078');
    expect(n.valid).toBe(true);
    expect(n.e164).toBe('+916380729078');
  });

  it('still normalizes a bare 10-digit number under the IN default region', () => {
    const n = normalizePhone('6380729078');
    expect(n.valid).toBe(true);
    expect(n.e164).toBe('+916380729078');
  });

  it('returns null-safe result for empty input', () => {
    const n = normalizePhone(null);
    expect(n.valid).toBe(false);
    expect(n.e164).toBeNull();
  });
});
