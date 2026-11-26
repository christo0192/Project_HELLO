/**
 * M035 S04 T1: the public booking form's normalisers (lib/r1/meet/public/normalize.ts; D-S04-5,
 * D-S04-6). The email form is the one the local match, the Ashby search filter and the on-file check
 * all compare; the phone form is the only one `candidates.phone_e164` can ever hold (a strict Indian
 * mobile), so anything else is null. Every address and number below is synthetic.
 *
 * Where libphonenumber decides something surprising, the case name says "pinned": the expectation is
 * what the library does today, and it is accepted because the output is still strict or null.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sanitizeEmail } from '../integrations/ashby/candidate-profile.js';
import { STRICT_IN_MOBILE_E164 } from '../lib/candidate-phone.js';
import { normalizePublicEmail, normalizePublicPhone } from '../lib/r1/meet/public/normalize.js';

const DOMAIN = '@example.com';
const atLength = (total: number): string => 'a'.repeat(total - DOMAIN.length) + DOMAIN;

describe('normalizePublicEmail', () => {
  it.each<[string, unknown, string | null]>([
    ['lower-cases the whole address', 'Test.Person@Example.COM', 'test.person@example.com'],
    ['trims surrounding spaces and tabs', ' \t test.person@example.com\t ', 'test.person@example.com'],
    ['trims surrounding newlines', '\r\ntest.person@example.com\n', 'test.person@example.com'],
    ['keeps plus and dots (no Gmail folding)', 'a.b+c@gmail.com', 'a.b+c@gmail.com'],
    ['lower-cases but does not fold plus and dots', 'A.B+C@GMAIL.COM', 'a.b+c@gmail.com'],
    ['lower-cases non-ASCII letters', 'ÉLODIE@EXAMPLE.COM', 'élodie@example.com'],
    ['composes to NFC (e + combining acute)', 'josé@example.com', 'josé@example.com'],
    ['keeps an already precomposed address', 'josé@example.com', 'josé@example.com'],
    ['accepts exactly 254 characters', atLength(254), atLength(254)],
    ['measures 254 after the trim', `  ${atLength(254)}  `, atLength(254)],
    ['refuses 255 characters', atLength(255), null],
    ['refuses an inner space', 'test person@example.com', null],
    ['refuses an inner tab', 'test\tperson@example.com', null],
    ['refuses a zero-width space', 'test​person@example.com', null],
    ['refuses a leading zero-width space (trim keeps it)', '​test.person@example.com', null],
    ['refuses a bidi override', 'test‮person@example.com', null],
    ['pinned: a leading byte-order mark is trimmed (JS trim treats U+FEFF as space)', '﻿test.person@example.com', 'test.person@example.com'],
    ['refuses an inner byte-order mark', 'test.person﻿@example.com', null],
    ['refuses a control character', 'test\u0007person@example.com', null],
    ['refuses two @', 'a@b@example.com', null],
    ['refuses a doubled @', 'a@@example.com', null],
    ['refuses a leading @', '@example.com', null],
    ['refuses a trailing @', 'test.person@', null],
    ['refuses no @', 'test.person.example.com', null],
    ['refuses empty', '', null],
    ['refuses blank', '   ', null],
    ['refuses a raw value over 1024 characters even if it trims to a valid one', ' '.repeat(1020) + 'a@example.com', null],
    ['refuses a number', 42, null],
    ['refuses null', null, null],
    ['refuses undefined', undefined, null],
    ['refuses an object', { value: 'test.person@example.com' }, null],
  ])('%s', (_name, raw, expected) => {
    expect(normalizePublicEmail(raw as string)).toBe(expected);
  });

  it('treats the decomposed and precomposed spellings as one address', () => {
    expect(normalizePublicEmail('JOSÉ@EXAMPLE.COM')).toBe(normalizePublicEmail('josé@example.com'));
  });

  it('uses the shared Ashby contact rules (sanitizeEmail is exported, unchanged)', () => {
    expect(sanitizeEmail('  test.person@example.com ')).toBe('test.person@example.com');
    expect(sanitizeEmail('Test.Person@Example.com')).toBe('Test.Person@Example.com');
    expect(sanitizeEmail('a@b@example.com')).toBeNull();
    expect(sanitizeEmail('test​person@example.com')).toBeNull();
  });

  it('property: an RFC-shaped address normalises to its lower-case form, idempotently', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (address) => {
        const once = normalizePublicEmail(address);
        if (address.length > 254) {
          expect(once).toBeNull();
          return;
        }
        expect(once).toBe(address.toLowerCase());
        expect(normalizePublicEmail(once!)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('property: any string is null or a fixed point (NFC, one @, nothing invisible)', () => {
    const anyText = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 40 }),
      fc.string({ unit: 'grapheme', maxLength: 40 }),
      fc
        .tuple(
          fc.string({ unit: 'grapheme', maxLength: 16 }),
          fc.constantFrom('@', ' @', '@ ', '@@', '́@'),
          fc.string({ unit: 'grapheme', maxLength: 16 }),
        )
        .map(([local, at, domain]) => local + at + domain),
    );
    fc.assert(
      fc.property(anyText, (raw) => {
        const once = normalizePublicEmail(raw);
        if (once === null) return;
        expect(normalizePublicEmail(once)).toBe(once);
        expect(once).toBe(once.normalize('NFC'));
        expect(once.length).toBeLessThanOrEqual(254);
        expect(once.split('@')).toHaveLength(2);
        expect(once).not.toMatch(/[\s\p{Cc}\p{Cf}]/u);
      }),
      { numRuns: 500 },
    );
  });
});

describe('normalizePublicPhone', () => {
  const MOBILE = '+919812345670';

  it.each<[string, unknown, string | null]>([
    ['E.164 as is', '+919812345670', MOBILE],
    ['+91 with spaces', '+91 98123 45670', MOBILE],
    ['+91 with dashes', '+91-98123-45670', MOBILE],
    ['+91 with brackets', '+91 (981) 234-5670', MOBILE],
    ['surrounding spaces', '  +91 98123 45670  ', MOBILE],
    ['a spaced leading plus', '+ 91 98123 45670', MOBILE],
    ['ten national digits', '9812345670', MOBILE],
    ['ten national digits with a space', '98123 45670', MOBILE],
    ['the national trunk 0', '098123 45670', MOBILE],
    ['the 00 international prefix', '0091 98123 45670', MOBILE],
    ['pinned: twelve digits starting 91 read as +91', '919812345670', MOBILE],
    ['pinned: full-width digits are read', '９８１２３４５６７０', MOBILE],
    ['a 7-leading mobile', '+917012345678', '+917012345678'],
    ['a 6-leading mobile', '+916012345678', '+916012345678'],
    ['an Indian landline (+91)', '+91 22 2345 6789', null],
    ['an Indian landline (national)', '022 2345 6789', null],
    ['pinned: a 5-leading Indian number libphonenumber accepts is not a mobile', '+91 58123 45670', null],
    ['pinned: a 5-leading national number', '5812345670', null],
    ['a UK drama-range number', '+44 7700 900123', null],
    ['a UK mobile', '+44 7911 123456', null],
    ['pinned: a US number libphonenumber accepts is foreign', '+1 202 555 0143', null],
    ['pinned: Devanagari digits are not read', '+९१ ९८१२३ ४५६७०', null],
    ['letters', 'call me maybe', null],
    ['too few digits', '98123', null],
    ['empty', '', null],
    ['blank', '   ', null],
    ['over 64 characters', '+91 98123 45670' + ' '.repeat(50), null],
    ['a number', 9812345670, null],
    ['null', null, null],
    ['undefined', undefined, null],
  ])('%s', (_name, raw, expected) => {
    expect(normalizePublicPhone(raw as string)).toBe(expected);
  });

  it('accepts exactly 64 characters', () => {
    const raw = '+91 98123 45670'.padEnd(64, ' ');
    expect(raw).toHaveLength(64);
    expect(normalizePublicPhone(raw)).toBe(MOBILE);
  });

  it('property: every output is a strict Indian mobile and a fixed point', () => {
    const phoneish = fc.oneof(
      fc.string({ unit: fc.constantFrom(...'0123456789 +-()'.split('')), maxLength: 20 }),
      fc
        .tuple(fc.constantFrom('+91', '91', '0', '', '+91 ', '0091'), fc.constantFrom('6', '7', '8', '9', '5', '2'), fc.stringMatching(/^[0-9]{9}$/))
        .map(([prefix, lead, rest]) => prefix + lead + rest),
      fc.string({ maxLength: 30 }),
    );
    fc.assert(
      fc.property(phoneish, (raw) => {
        const once = normalizePublicPhone(raw);
        if (once === null) return;
        expect(once).toMatch(STRICT_IN_MOBILE_E164);
        expect(normalizePublicPhone(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});
