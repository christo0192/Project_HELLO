/**
 * ashby-candidate-profile.test.ts — the bounded contact read behind "phone
 * parsing" (ADR-0018, M017 design §2.2).
 *
 * The extractor is the first code that holds an Ashby applicant's name, email
 * and phone numbers, so the tests cover three things: it reads the shapes the
 * provider actually returns (bare strings and `{ value }` items, the
 * application nested or flat, `candidate.info` before the embedded copy); its
 * rules refuse what should not reach a call opener or a dialer; and the object
 * it returns never serializes its contents.
 *
 * Whether a number may be dialed is `deriveAshbyProfilePhone`'s decision and
 * is tested in `phone-ashby-profile-derive.test.ts`.
 *
 * Every name, email and number in this file is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractAshbyCandidateProfile,
  extractAshbyApplicationStatus,
  ASHBY_PROFILE_JSON_MARKER,
  MAX_PROFILE_EMAIL_LEN,
  MAX_PROFILE_NAME_LEN,
  MAX_PROFILE_NUMBER_LEN,
  MAX_PROFILE_OTHER_NUMBERS,
} from '../integrations/ashby/candidate-profile.js';

const NAME = 'Test Person';
const EMAIL = 'test.person@example.com';
const PRIMARY = '+91 98123 45670';
const SECONDARY = '+91 98123 45671';

/** A `candidate.info` result in the documented `{ value, type, isPrimary }` shape. */
function candidateInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cand-synthetic-1',
    name: NAME,
    primaryEmailAddress: { value: EMAIL, type: 'Personal', isPrimary: true },
    emailAddresses: [{ value: EMAIL, type: 'Personal', isPrimary: true }],
    primaryPhoneNumber: { value: PRIMARY, type: 'Mobile', isPrimary: true },
    phoneNumbers: [
      { value: SECONDARY, type: 'Work', isPrimary: false },
      { value: PRIMARY, type: 'Mobile', isPrimary: true },
    ],
    resumeFileHandle: null,
    ...overrides,
  };
}

/** An `application.info` result with the candidate embedded. */
function applicationInfo(candidate: Record<string, unknown>, nested = true): Record<string, unknown> {
  const app = { id: 'app-synthetic-1', status: 'Active', candidate };
  return nested ? { application: app } : app;
}

/** Read only the name through the public entry point. */
function nameOf(name: unknown): string | null {
  return extractAshbyCandidateProfile({}, { name }).name;
}

/** Read only the email through the public entry point. */
function emailOf(value: unknown): string | null {
  return extractAshbyCandidateProfile({}, { primaryEmailAddress: value }).email;
}

describe('extractAshbyCandidateProfile — shapes', () => {
  it('reads `{ value }` items from the candidate.info root, isPrimary first', () => {
    const p = extractAshbyCandidateProfile({}, candidateInfo());
    expect(p.name).toBe(NAME);
    expect(p.email).toBe(EMAIL);
    expect(p.primaryNumber).toBe(PRIMARY);
    expect(p.otherNumbers).toEqual([PRIMARY, SECONDARY]);
  });

  it('reads bare-string items', () => {
    const p = extractAshbyCandidateProfile({}, {
      name: NAME,
      primaryEmailAddress: EMAIL,
      primaryPhoneNumber: PRIMARY,
      phoneNumbers: [SECONDARY, PRIMARY],
    });
    expect(p.email).toBe(EMAIL);
    expect(p.primaryNumber).toBe(PRIMARY);
    // No isPrimary flag on a bare string, so array order stands.
    expect(p.otherNumbers).toEqual([SECONDARY, PRIMARY]);
  });

  it('reads the candidate embedded in application.info, nested or flat', () => {
    const embedded = {
      id: 'cand-synthetic-1',
      name: NAME,
      primaryEmailAddress: { value: EMAIL },
      primaryPhoneNumber: { value: PRIMARY },
    };
    for (const results of [applicationInfo(embedded, true), applicationInfo(embedded, false)]) {
      const p = extractAshbyCandidateProfile(results);
      expect(p.name).toBe(NAME);
      expect(p.email).toBe(EMAIL);
      expect(p.primaryNumber).toBe(PRIMARY);
      expect(p.otherNumbers).toEqual([]);
    }
  });

  it('the candidate.info root wins over the embedded candidate', () => {
    const p = extractAshbyCandidateProfile(
      applicationInfo({ name: 'Other Person', primaryEmailAddress: 'other@example.com', primaryPhoneNumber: SECONDARY }),
      candidateInfo(),
    );
    expect(p.name).toBe(NAME);
    expect(p.email).toBe(EMAIL);
    expect(p.primaryNumber).toBe(PRIMARY);
  });

  it('a field missing from the root falls back to the embedded candidate', () => {
    const p = extractAshbyCandidateProfile(
      applicationInfo({ name: NAME, primaryEmailAddress: { value: EMAIL }, primaryPhoneNumber: { value: PRIMARY } }),
      { id: 'cand-synthetic-1', name: '   ', phoneNumbers: [] },
    );
    expect(p.name).toBe(NAME);
    expect(p.email).toBe(EMAIL);
    expect(p.primaryNumber).toBe(PRIMARY);
  });

  it('an empty list on the root shadows a list further down', () => {
    // The list comes from ONE source, so an applicant's own empty list is not
    // topped up from another copy of the record.
    const p = extractAshbyCandidateProfile(
      applicationInfo({ phoneNumbers: [{ value: SECONDARY }] }),
      { phoneNumbers: [] },
    );
    expect(p.otherNumbers).toEqual([]);
  });

  it('non-object and malformed inputs yield an empty profile, never a throw', () => {
    for (const bad of [undefined, null, 'x', 42, [], [candidateInfo()]]) {
      const p = extractAshbyCandidateProfile(bad, bad);
      expect(p).toEqual({ name: null, email: null, primaryNumber: null, otherNumbers: [] });
    }
    const p = extractAshbyCandidateProfile({}, {
      name: 42,
      primaryEmailAddress: { address: EMAIL },
      primaryPhoneNumber: { value: 9812345670 },
      phoneNumbers: [null, 5, { value: null }, { number: PRIMARY }, [PRIMARY], '', '   ', { value: '' }],
    });
    expect(p).toEqual({ name: null, email: null, primaryNumber: null, otherNumbers: [] });
  });
});

describe('extractAshbyCandidateProfile — name rules', () => {
  it('normalizes to NFC', () => {
    // "e" + COMBINING ACUTE ACCENT becomes the single precomposed letter.
    expect(nameOf('José Test')).toBe('José Test');
  });

  it('strips control and format characters, including zero-width and bidi', () => {
    expect(nameOf('Te​st Per‏son')).toBe(NAME);
    expect(nameOf('‮Test‬ Person﻿')).toBe(NAME);
    expect(nameOf('⁦Test⁩ Person')).toBe(NAME);
    expect(nameOf('Test\u0007 Person\u007F\u0085')).toBe(NAME);
    // A soft hyphen hides inside a word; stripping it restores the word.
    expect(nameOf('Te­st Person')).toBe(NAME);
  });

  it('refuses a value carrying `@` or three or more digits', () => {
    expect(nameOf(EMAIL)).toBeNull();
    expect(nameOf('Test @ Person')).toBeNull();
    expect(nameOf('Test Person 9812345670')).toBeNull();
    expect(nameOf('Test 1 Person 23')).toBeNull();
    // Any decimal digit counts, not only ASCII.
    expect(nameOf('Test Person १२३')).toBeNull();
    // Two digits are not a number; they are removed like any other symbol.
    expect(nameOf('Test Person 2')).toBe(NAME);
  });

  it('replaces symbols with spaces and trims punctuation from the edges', () => {
    expect(nameOf('Test_Person (HR)')).toBe('Test Person HR');
    expect(nameOf("  -'Test Person.-  ")).toBe(NAME);
    expect(nameOf("Test D'Souza-Person")).toBe("Test D'Souza-Person");
    expect(nameOf('Test P. Person')).toBe('Test P. Person');
    expect(nameOf('Test  　  Person')).toBe(NAME);
  });

  it('keeps letters and marks from any script', () => {
    const devanagari = 'टेस्ट पर्सन';
    expect(nameOf(devanagari)).toBe(devanagari);
  });

  it('refuses an empty result, more than 6 tokens, or more than 80 characters', () => {
    expect(nameOf('---')).toBeNull();
    expect(nameOf('!!! ???')).toBeNull();
    expect(nameOf('Aa Bb Cc Dd Ee Ff')).toBe('Aa Bb Cc Dd Ee Ff');
    expect(nameOf('Aa Bb Cc Dd Ee Ff Gg')).toBeNull();
    expect(nameOf('x'.repeat(MAX_PROFILE_NAME_LEN))).toBe('x'.repeat(MAX_PROFILE_NAME_LEN));
    expect(nameOf('x'.repeat(MAX_PROFILE_NAME_LEN + 1))).toBeNull();
  });

  it('a refused root name does not fall back to the embedded copy', () => {
    const p = extractAshbyCandidateProfile(applicationInfo({ name: NAME }), { name: 'Test 12345' });
    expect(p.name).toBeNull();
  });
});

describe('extractAshbyCandidateProfile — email rules', () => {
  it('trims and keeps a well-formed address', () => {
    expect(emailOf(`  ${EMAIL}  `)).toBe(EMAIL);
    expect(emailOf({ value: EMAIL })).toBe(EMAIL);
  });

  it('is bounded at 254 characters', () => {
    const domain = '@example.com';
    const atLimit = 'a'.repeat(MAX_PROFILE_EMAIL_LEN - domain.length) + domain;
    expect(emailOf(atLimit)).toBe(atLimit);
    expect(emailOf(`a${atLimit}`)).toBeNull();
  });

  it('requires exactly one `@` with text on both sides', () => {
    expect(emailOf('test.person.example.com')).toBeNull();
    expect(emailOf('test@person@example.com')).toBeNull();
    expect(emailOf('@example.com')).toBeNull();
    expect(emailOf('test.person@')).toBeNull();
  });

  it('refuses whitespace, control and format characters inside', () => {
    expect(emailOf('test person@example.com')).toBeNull();
    expect(emailOf('test\tperson@example.com')).toBeNull();
    expect(emailOf('test\u0000person@example.com')).toBeNull();
    expect(emailOf('test​person@example.com')).toBeNull();
  });

  it('falls back to the address list, isPrimary first, only when no primary exists', () => {
    const p = extractAshbyCandidateProfile({}, {
      emailAddresses: [{ value: 'other@example.com' }, { value: EMAIL, isPrimary: true }],
    });
    expect(p.email).toBe(EMAIL);
  });
});

describe('extractAshbyCandidateProfile — numbers', () => {
  it('keeps at most 5 list entries', () => {
    const list = Array.from({ length: 8 }, (_, i) => ({ value: `+91 98123 4567${i}` }));
    const p = extractAshbyCandidateProfile({}, { phoneNumbers: list });
    expect(p.otherNumbers).toHaveLength(MAX_PROFILE_OTHER_NUMBERS);
    expect(p.otherNumbers).toEqual(list.slice(0, 5).map((n) => n.value));
  });

  it('strips control and format characters and skips blank entries', () => {
    const p = extractAshbyCandidateProfile({}, {
      primaryPhoneNumber: { value: '‎+91 98123 45670‏' },
      phoneNumbers: ['', '   ', { value: '​' }, '+91 98123\u0000 45671'],
    });
    expect(p.primaryNumber).toBe(PRIMARY);
    expect(p.otherNumbers).toEqual(['+91 98123 45671']);
  });

  it('bounds each value at 64 characters; an over-long one fails the whole read closed', () => {
    const atLimit = 'x'.repeat(MAX_PROFILE_NUMBER_LEN);
    const overLimit = 'x'.repeat(MAX_PROFILE_NUMBER_LEN + 1);
    expect(extractAshbyCandidateProfile({}, { primaryPhoneNumber: atLimit }).primaryNumber).toBe(atLimit);

    // Dropping a garbage primary would promote the next entry to "first" and
    // hand the call to a secondary number, so nothing is read at all.
    for (const candidate of [
      { primaryPhoneNumber: overLimit, phoneNumbers: [SECONDARY] },
      { primaryPhoneNumber: PRIMARY, phoneNumbers: [{ value: overLimit, isPrimary: true }, SECONDARY] },
      { phoneNumbers: [overLimit, SECONDARY] },
    ]) {
      const p = extractAshbyCandidateProfile({}, candidate);
      expect(p.primaryNumber).toBeNull();
      expect(p.otherNumbers).toEqual([]);
    }
    // The embedded primary is held to the same bound.
    const embedded = extractAshbyCandidateProfile(
      applicationInfo({ primaryPhoneNumber: overLimit }),
      { phoneNumbers: [SECONDARY] },
    );
    expect(embedded.primaryNumber).toBeNull();
    expect(embedded.otherNumbers).toEqual([]);
  });

  it('an entry past the 5-entry cap is never read', () => {
    const list = [...Array.from({ length: 5 }, () => SECONDARY), 'x'.repeat(MAX_PROFILE_NUMBER_LEN + 1)];
    const p = extractAshbyCandidateProfile({}, { primaryPhoneNumber: PRIMARY, phoneNumbers: list });
    expect(p.primaryNumber).toBe(PRIMARY);
    expect(p.otherNumbers).toHaveLength(5);
  });

  it('the profile and its list are frozen', () => {
    const p = extractAshbyCandidateProfile({}, candidateInfo());
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.otherNumbers)).toBe(true);
  });
});

describe('extractAshbyCandidateProfile — never serializes its contents', () => {
  it(`JSON.stringify gives ${ASHBY_PROFILE_JSON_MARKER}`, () => {
    expect(ASHBY_PROFILE_JSON_MARKER).toBe('[ashby-profile]');
    const p = extractAshbyCandidateProfile({}, candidateInfo());
    expect(JSON.stringify(p)).toBe('"[ashby-profile]"');
    const wrapped = JSON.stringify({ outcome: 'applied', profile: p });
    expect(wrapped).toBe('{"outcome":"applied","profile":"[ashby-profile]"}');
    for (const value of [NAME, EMAIL, '98123', '45670']) {
      expect(wrapped).not.toContain(value);
    }
    // An empty profile is redacted the same way.
    expect(JSON.stringify(extractAshbyCandidateProfile(null))).toBe('"[ashby-profile]"');
  });

  it('toJSON is not enumerable, so key lists and spreads never see it', () => {
    const p = extractAshbyCandidateProfile({}, candidateInfo());
    expect(Object.getOwnPropertyDescriptor(p, 'toJSON')?.enumerable).toBe(false);
    expect(Object.keys(p)).toEqual(['name', 'email', 'primaryNumber', 'otherNumbers']);
    expect('toJSON' in { ...p }).toBe(false);
  });
});

describe('extractAshbyApplicationStatus', () => {
  it('reads (results.application ?? results).status', () => {
    expect(extractAshbyApplicationStatus({ status: 'Active' })).toBe('Active');
    expect(extractAshbyApplicationStatus({ application: { status: 'Archived' } })).toBe('Archived');
    expect(extractAshbyApplicationStatus({ status: 'Active', application: { status: 'Hired' } })).toBe('Hired');
  });

  it('is null only when the field is absent or not a string', () => {
    for (const bad of [undefined, null, 'Active', 42, [], {}, { status: 1 }, { application: { status: null } }]) {
      expect(extractAshbyApplicationStatus(bad)).toBeNull();
    }
  });

  it('an unreadable present status stays a string that is not Active', () => {
    // The profile job proceeds on null ("field absent"), so a present but
    // odd value must never collapse to null.
    expect(extractAshbyApplicationStatus({ status: '' })).toBe('');
    const long = extractAshbyApplicationStatus({ status: 'Active'.padEnd(500, 'x') });
    expect(long).toHaveLength(64);
    expect(long).not.toBe('Active');
  });
});

describe('module boundary', () => {
  it('is pure: no logger, no client, no network import', () => {
    // M017 design §2.2: the extractor holds personal data, so it must not be
    // able to log it or send it anywhere. Asserted on the import graph.
    const src = readFileSync(join(process.cwd(), 'src/integrations/ashby/candidate-profile.ts'), 'utf8');
    const imports = src.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
    for (const imp of imports) {
      expect(imp).not.toMatch(/logger|logging|client|supabase|node:https?|undici|axios|queue/);
    }
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/console\./);
  });
});
