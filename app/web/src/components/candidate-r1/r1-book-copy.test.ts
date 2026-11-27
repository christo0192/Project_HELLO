import { describe, expect, it } from 'vitest';
import type { BookFieldError } from '../../lib/r1/r1-book';
import { R1_BOOK_COPY, R1_BOOK_MANAGE_COPY, r1MovesLeftText } from './r1-book-copy';

/** Every string of a copy object with its dotted path; functions are checked on their own. */
function strings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => strings(child, `${path}.${key}`));
  }
  return [];
}

function frozenProblems(value: unknown, path: string): string[] {
  if (!value || typeof value !== 'object') return [];
  const own = Object.isFrozen(value) ? [] : [path];
  return [
    ...own,
    ...Object.entries(value).flatMap(([key, child]) => frozenProblems(child, `${path}.${key}`)),
  ];
}

const ALL: Array<[string, string]> = [
  ...strings(R1_BOOK_COPY, 'R1_BOOK_COPY'),
  ...strings(R1_BOOK_MANAGE_COPY, 'R1_BOOK_MANAGE_COPY'),
  // The one templated line, at the counts a manage link can show.
  ['view.movesLeft(1)', R1_BOOK_MANAGE_COPY.view.movesLeft(1)],
  ['view.movesLeft(3)', R1_BOOK_MANAGE_COPY.view.movesLeft(3)],
];

/** Proper nouns that keep their capitals inside a sentence. Longest first. */
const PROPER_NOUNS = [
  "Interview Kickstart's",
  'Interview Kickstart',
  'India Standard Time',
  'Google Meet',
  "Dex's",
  'Dex',
  'Meet',
  'India',
];
const ACRONYMS = new Set(['IST', 'AI', 'R1']);

/** Capitalised words that are neither a sentence start, a proper noun, "I" nor an acronym. */
function sentenceCaseProblems(text: string): string[] {
  let rest = text;
  for (const noun of PROPER_NOUNS) rest = rest.split(noun).join(' ');
  const problems: string[] = [];
  for (const word of rest.match(/\b[A-Z][A-Z0-9]+\b/g) ?? []) {
    if (!ACRONYMS.has(word)) problems.push(word);
  }
  for (const sentence of rest.split(/(?<=[.?!])\s+/)) {
    for (const word of sentence.trim().split(/\s+/).slice(1)) {
      const bare = word.replace(/[^A-Za-z0-9']/g, '');
      // A run of capitals was judged above; this is a capitalised ordinary word.
      if (/^[A-Z](?![A-Z0-9])/.test(bare) && bare !== 'I') problems.push(bare);
    }
  }
  return problems;
}

/** Strings allowed a digit: the limits stated to the person, and the phone example. */
const DIGITS_ALLOWED = new Set([
  'R1_BOOK_COPY.form.phoneHint',
  'R1_BOOK_COPY.errors.phone_invalid',
  'R1_BOOK_COPY.errors.name_too_long',
  'view.movesLeft(1)',
  'view.movesLeft(3)',
]);

describe('the public booking copy', () => {
  it('finds the strings it checks', () => {
    expect(ALL.length).toBeGreaterThan(90);
  });

  it('is frozen all the way down', () => {
    expect(frozenProblems(R1_BOOK_COPY, 'R1_BOOK_COPY')).toEqual([]);
    expect(frozenProblems(R1_BOOK_MANAGE_COPY, 'R1_BOOK_MANAGE_COPY')).toEqual([]);
  });

  it('has no empty string and no untrimmed one', () => {
    for (const [path, text] of ALL) {
      expect(text.trim(), path).not.toBe('');
      expect(text, path).toBe(text.trim());
      expect(text, path).not.toMatch(/\s{2,}/);
    }
  });

  it('is in sentence case, with capitals only for a sentence start, a name or IST, AI, R1', () => {
    for (const [path, text] of ALL) {
      expect(sentenceCaseProblems(text), `${path}: "${text}"`).toEqual([]);
    }
  });

  it('NEGATIVE CONTROL: the sentence-case check catches title case and shouting', () => {
    expect(sentenceCaseProblems('Book Your Interview With Dex')).toEqual(['Your', 'Interview', 'With']);
    expect(sentenceCaseProblems('Please check the OTP.')).toEqual(['OTP']);
    expect(sentenceCaseProblems('Dex is the AI interviewer. Pick a time (India Standard Time).')).toEqual([]);
  });

  it('never uses the old interviewer name', () => {
    for (const [path, text] of ALL) expect(text, path).not.toMatch(/christy/i);
  });

  it('holds no address, link, placeholder or server value', () => {
    for (const [path, text] of ALL) {
      expect(text, path).not.toMatch(/https?:|www\./i);
      if (path !== 'R1_BOOK_COPY.errors.email_invalid') expect(text, path).not.toContain('@');
      expect(text, path).not.toMatch(/[{}$<>]/);
    }
    // The one example address is the format hint, on the reserved example domain.
    expect(R1_BOOK_COPY.errors.email_invalid).toBe(
      'Enter an email address in the format name@example.com.',
    );
  });

  it('prints a number only where it states a limit or the phone example', () => {
    for (const [path, text] of ALL) {
      if (DIGITS_ALLOWED.has(path)) continue;
      expect(text, path).not.toMatch(/\d/);
    }
    expect(R1_BOOK_COPY.form.phoneHint).toContain('+91 98765 43210');
    expect(R1_BOOK_COPY.errors.phone_invalid).toContain('+91 98765 43210');
  });

  it('never shows a seat count, a capacity or a guarantee', () => {
    for (const [path, text] of ALL) {
      expect(text, path).not.toMatch(/\bseats?\b|\bcapacity\b|\bremaining\b|guarantee/i);
    }
  });

  it('says exactly one not-found text, the one the owner brief gives', () => {
    expect(R1_BOOK_COPY.states.notFound.body).toBe(
      "We couldn't find an application you can book with. Check the email and phone number you used when you applied, or reply to the email from the hiring team.",
    );
    const notFoundLike = ALL.filter(([, text]) => /couldn't find an application/.test(text));
    expect(notFoundLike.map(([path]) => path)).toEqual(['R1_BOOK_COPY.states.notFound.body']);
  });

  it('sends the invite to the email on the application, and never shows or names "your email"', () => {
    const booked = strings(R1_BOOK_COPY.states.booked, 'booked');
    expect(R1_BOOK_COPY.states.booked.body).toContain('the email address on your application');
    expect(R1_BOOK_COPY.states.booked.body).toContain("Dex's calendar invite is on its way");
    for (const [path, text] of booked) {
      expect(text, path).not.toMatch(/your email/i);
      // The link is in the invite; the page has none to click.
      expect(text, path).not.toMatch(/\bclick\b/i);
    }
    expect(R1_BOOK_COPY.states.booked.spam).toMatch(/spam/);
  });

  it('has the field messages for every validation code, and the summary and server lines', () => {
    const codes: BookFieldError[] = [
      'name_required',
      'name_too_long',
      'email_required',
      'email_invalid',
      'phone_required',
      'phone_invalid',
      'slot_required',
      'consents_required',
      'in_india_required',
    ];
    for (const code of codes) expect(R1_BOOK_COPY.errors[code], code).toMatch(/\.$/);
    expect(Object.keys(R1_BOOK_COPY.errors).sort()).toEqual(
      [...codes, 'serverInvalid', 'summaryTitle'].sort(),
    );
  });

  it('pins the lines the pages and the owner decisions depend on', () => {
    expect(R1_BOOK_COPY.form.title).toBe('Book your interview with Dex');
    expect(R1_BOOK_COPY.form.indiaLabel).toBe('I confirm I am located in India.');
    expect(R1_BOOK_COPY.form.purposesLegend).toBe('Please agree to each purpose separately');
    expect(R1_BOOK_COPY.form.slotLegend).toBe('Pick a time (India Standard Time)');
    expect(R1_BOOK_COPY.states.notOpen.title).toBe('Booking is not open yet');
    expect(R1_BOOK_COPY.states.alreadyBooked.body).toBe(
      'To change or cancel it, use the link in your calendar invite from Dex.',
    );
    expect(R1_BOOK_COPY.states.loading).toBe(R1_BOOK_COPY.live.loading);
    expect(R1_BOOK_MANAGE_COPY.inactive.title).toBe('This link is no longer active');
    expect(R1_BOOK_MANAGE_COPY.notAllowed.body).toMatch(/too close to the start/);
    expect(R1_BOOK_MANAGE_COPY.notAllowed.body).toMatch(/change limit has been reached/);
  });

  it('names each page in the browser tab, never with the recruiter tool name', () => {
    expect(R1_BOOK_COPY.pageTitle).toBe('Book your interview with Dex · Interview Kickstart');
    expect(R1_BOOK_MANAGE_COPY.pageTitle).toBe('Manage your interview with Dex · Interview Kickstart');
    for (const title of [R1_BOOK_COPY.pageTitle, R1_BOOK_MANAGE_COPY.pageTitle]) {
      expect(title).not.toMatch(/hello|talent workspace|mission control/i);
    }
  });

  it('names the notice region from the copy, not from a component', () => {
    expect(R1_BOOK_COPY.form.noticeRegionLabel).toBe('Full notice');
  });

  it('never says a booking failed when it may have gone through', () => {
    const { uncertain, retry } = R1_BOOK_COPY.states;
    // A dropped request or a gateway error: the server may have booked and sent the invite.
    expect(uncertain.title).toBe('We could not confirm your booking');
    expect(uncertain.body).toBe(
      'Your interview may already be booked. Check for an invite from Dex at the email address on '
        + 'your application before you try again.',
    );
    for (const [path, text] of strings(uncertain, 'uncertain')) {
      expect(text, path).not.toMatch(/could not complete|failed|not booked/i);
    }
    expect(uncertain.action).toBe(retry.action);
    expect(uncertain.back).toBe(retry.back);
    // The definite refusal keeps its own card.
    expect(retry.title).toBe('We could not complete your booking');
  });

  it('counts the moves left in words that read right for one and for more', () => {
    expect(r1MovesLeftText(1)).toBe('1 more time');
    expect(r1MovesLeftText(2)).toBe('2 more times');
    expect(r1MovesLeftText(10)).toBe('10 more times');
    expect(R1_BOOK_MANAGE_COPY.view.movesLeft(1)).toBe('You can change the time 1 more time.');
    expect(R1_BOOK_MANAGE_COPY.view.movesLeft(3)).toBe('You can change the time 3 more times.');
  });
});
