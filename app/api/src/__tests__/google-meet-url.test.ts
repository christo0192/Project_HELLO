/**
 * The Google Meet link normaliser is the single gate both the Ashby interview-schedule parser
 * (`lib/r1/meet/ashby-schedule.ts`) and the Recall bot builder use, so it must accept every real
 * spelling of a Meet link and nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_MEET_CODE_RE,
  GOOGLE_MEET_ORIGIN,
  googleMeetCode,
  normalizeGoogleMeetUrl,
} from '../integrations/google-meet/url.js';

const CANONICAL = 'https://meet.google.com/abc-defg-hij';

describe('normalizeGoogleMeetUrl', () => {
  it('exports the origin and the code shape', () => {
    expect(GOOGLE_MEET_ORIGIN).toBe('https://meet.google.com');
    expect(GOOGLE_MEET_CODE_RE.test('abc-defg-hij')).toBe(true);
    expect(GOOGLE_MEET_CODE_RE.test('ABC-defg-hij')).toBe(false);
  });

  it.each([
    ['canonical', CANONICAL],
    ['upper-case code', 'https://meet.google.com/ABC-DEFG-HIJ'],
    ['mixed-case code', 'https://meet.google.com/AbC-dEfG-HiJ'],
    ['trailing slash', 'https://meet.google.com/abc-defg-hij/'],
    ['authuser query', 'https://meet.google.com/abc-defg-hij?authuser=0'],
    ['fragment', 'https://meet.google.com/abc-defg-hij#x'],
    ['slash, query and fragment', 'https://meet.google.com/abc-defg-hij/?hs=122&authuser=1#top'],
    ['empty query', 'https://meet.google.com/abc-defg-hij?'],
    ['upper-case scheme and host', 'HTTPS://MEET.GOOGLE.COM/abc-defg-hij'],
  ])('accepts %s and returns the canonical link', (_name, raw) => {
    expect(normalizeGoogleMeetUrl(raw)).toBe(CANONICAL);
  });

  it('keeps the code it was given', () => {
    expect(normalizeGoogleMeetUrl('https://meet.google.com/xyz-wxyz-uvw')).toBe('https://meet.google.com/xyz-wxyz-uvw');
  });

  it.each([
    ['http', 'http://meet.google.com/abc-defg-hij'],
    ['look-alike suffix host', 'https://meet.google.com.evil.test/abc-defg-hij'],
    ['trailing-dot host', 'https://meet.google.com./abc-defg-hij'],
    ['other host', 'https://evil.test/abc-defg-hij'],
    ['other Google host', 'https://calendar.google.com/abc-defg-hij'],
    ['short link', 'https://g.co/meet/abc-defg-hij'],
    ['no scheme', 'meet.google.com/abc-defg-hij'],
    ['scheme-less other host', 'evil.test/abc-defg-hij'],
    ['protocol-relative', '//meet.google.com/abc-defg-hij'],
    ['backslash spelling', 'https:\\\\meet.google.com\\abc-defg-hij'],
    ['userinfo', 'https://user@meet.google.com/abc-defg-hij'],
    ['userinfo with password', 'https://user:pw@meet.google.com/abc-defg-hij'],
    ['userinfo hiding another host', 'https://meet.google.com@evil.test/abc-defg-hij'],
    ['explicit default port', 'https://meet.google.com:443/abc-defg-hij'],
    ['other port', 'https://meet.google.com:8443/abc-defg-hij'],
    ['lookup path', 'https://meet.google.com/lookup/abc'],
    ['new meeting path', 'https://meet.google.com/new'],
    ['root', 'https://meet.google.com/'],
    ['origin only', 'https://meet.google.com'],
    ['extra segment', 'https://meet.google.com/abc-defg-hij/extra'],
    ['double trailing slash', 'https://meet.google.com/abc-defg-hij//'],
    ['leading extra slash', 'https://meet.google.com//abc-defg-hij'],
    ['percent-encoded hyphen', 'https://meet.google.com/abc%2Ddefg-hij'],
    ['percent-encoded slash', 'https://meet.google.com/abc-defg-hij%2F'],
    ['dot segment', 'https://meet.google.com/x/../abc-defg-hij'],
    ['4-3-3 code', 'https://meet.google.com/abcd-efg-hij'],
    ['3-4-4 code', 'https://meet.google.com/abc-defg-hijk'],
    ['code with digits', 'https://meet.google.com/ab1-defg-hij'],
    ['all digits', 'https://meet.google.com/123-4567-890'],
    ['code without hyphens', 'https://meet.google.com/abcdefghij'],
    ['code with underscores', 'https://meet.google.com/abc_defg_hij'],
    ['leading space', ' https://meet.google.com/abc-defg-hij'],
    ['trailing space', 'https://meet.google.com/abc-defg-hij '],
    ['tab inside', 'https://meet.google.com/abc-de\tfg-hij'],
    ['newline inside', 'https://meet.google.com/abc-defg\n-hij'],
    ['non-ASCII', 'https://meet.google.com/abc-défg-hij'],
    ['empty', ''],
  ])('rejects %s', (_name, raw) => {
    expect(normalizeGoogleMeetUrl(raw)).toBeNull();
  });

  it('bounds the input at 2048 characters', () => {
    const base = `${CANONICAL}?q=`;
    const atLimit = base + 'a'.repeat(2048 - base.length);
    expect(atLimit).toHaveLength(2048);
    expect(normalizeGoogleMeetUrl(atLimit)).toBe(CANONICAL);
    expect(normalizeGoogleMeetUrl(`${atLimit}a`)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { href: CANONICAL }],
    ['array', [CANONICAL]],
    ['URL object', new URL(CANONICAL)],
  ])('rejects a non-string (%s) without throwing', (_name, raw) => {
    expect(normalizeGoogleMeetUrl(raw)).toBeNull();
  });
});

describe('googleMeetCode', () => {
  it('returns the code of a canonical link', () => {
    expect(googleMeetCode(CANONICAL)).toBe('abc-defg-hij');
    expect(googleMeetCode(normalizeGoogleMeetUrl('https://meet.google.com/XYZ-WXYZ-UVW?authuser=2')!)).toBe('xyz-wxyz-uvw');
  });

  it.each([
    ['upper-case code', 'https://meet.google.com/ABC-DEFG-HIJ'],
    ['trailing slash', 'https://meet.google.com/abc-defg-hij/'],
    ['query', 'https://meet.google.com/abc-defg-hij?authuser=0'],
    ['other host', 'https://evil.test/abc-defg-hij'],
    ['http', 'http://meet.google.com/abc-defg-hij'],
    ['bad code', 'https://meet.google.com/abcd-efg-hij'],
    ['empty', ''],
  ])('returns null for a non-canonical input (%s)', (_name, raw) => {
    expect(googleMeetCode(raw)).toBeNull();
  });

  it('returns null for a non-string without throwing', () => {
    expect(googleMeetCode(null as unknown as string)).toBeNull();
    expect(googleMeetCode(7 as unknown as string)).toBeNull();
  });
});
