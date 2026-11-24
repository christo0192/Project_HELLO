/**
 * M034 S05 T1: the Meet bridge resume token (lib/r1/meet/resume-token.ts, D-S05-8).
 *
 * Pinned here: `v1.<expSec>.<mac64>` names no id; the MAC (domain `hello:r1:meet-resume:v1`,
 * recomputed independently below) binds the token to one booking and one session; the expiry is
 * 300 s and is read only after a constant-time MAC check (so only a genuine token can be
 * `expired`); a missing or short worker secret mints nothing and verifies nothing; and an attempt
 * token never verifies as a resume token.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintAttemptToken } from '../lib/r1/attempt-token.js';
import {
  R1_MEET_RESUME_DOMAIN,
  R1_MEET_RESUME_TOKEN_PATTERN,
  R1_MEET_RESUME_TTL_SEC,
  mintR1MeetResumeToken,
  verifyR1MeetResumeToken,
} from '../lib/r1/meet/resume-token.js';

const SECRET = 'w'.repeat(40);
const ENV = { WORKER_CONTEXT_SECRET: SECRET } as NodeJS.ProcessEnv;
const BOOKING = '40000000-0000-4000-8000-0000000000b1';
const SESSION = '30000000-0000-4000-8000-0000000000e1';
const BINDING = { bookingId: BOOKING, sessionId: SESSION };
const NOW = Date.parse('2030-01-01T10:00:00.000Z');
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function mint(binding = BINDING, nowMs = NOW, env = ENV): string {
  const token = mintR1MeetResumeToken(binding, nowMs, env);
  expect(token).not.toBeNull();
  return token!;
}

/** Replace the last hex character of `token` with a different one. */
function flipLast(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
}

describe('Meet resume token', () => {
  it('round-trips: v1.<now+300>.<HMAC(HMAC(secret, domain), "booking.session.exp")>', () => {
    expect(R1_MEET_RESUME_DOMAIN).toBe('hello:r1:meet-resume:v1');
    expect(R1_MEET_RESUME_TTL_SEC).toBe(300);
    const token = mint();
    const exp = NOW / 1000 + 300;
    const key = createHmac('sha256', SECRET).update('hello:r1:meet-resume:v1').digest();
    const mac = createHmac('sha256', key).update(`${BOOKING}.${SESSION}.${exp}`).digest('hex');
    expect(token).toBe(`v1.${exp}.${mac}`);
    expect(verifyR1MeetResumeToken(token, BINDING, NOW, ENV)).toBe('ok');
  });

  it('matches the exported pattern and names no id, no secret', () => {
    const token = mint();
    expect(R1_MEET_RESUME_TOKEN_PATTERN.test(token)).toBe(true);
    expect(R1_MEET_RESUME_TOKEN_PATTERN.source).toBe('^v1\\.[0-9]{1,12}\\.[a-f0-9]{64}$');
    expect(token).not.toMatch(UUID_ANYWHERE);
    expect(token).not.toContain(BOOKING.slice(0, 8));
    expect(token).not.toContain(SESSION.slice(0, 8));
    expect(token).not.toContain(SECRET);
  });

  it('is bound to its booking and session: another booking, another session or a tamper is invalid', () => {
    const token = mint();
    const otherBooking = { bookingId: '40000000-0000-4000-8000-0000000000b2', sessionId: SESSION };
    const otherSession = { bookingId: BOOKING, sessionId: '30000000-0000-4000-8000-0000000000e2' };
    const swapped = { bookingId: SESSION, sessionId: BOOKING };
    expect(verifyR1MeetResumeToken(token, otherBooking, NOW, ENV)).toBe('invalid');
    expect(verifyR1MeetResumeToken(token, otherSession, NOW, ENV)).toBe('invalid');
    expect(verifyR1MeetResumeToken(token, swapped, NOW, ENV)).toBe('invalid');
    expect(verifyR1MeetResumeToken(flipLast(token), BINDING, NOW, ENV)).toBe('invalid');
    const [, exp, mac] = token.split('.');
    expect(verifyR1MeetResumeToken(`v1.${Number(exp) + 3600}.${mac}`, BINDING, NOW, ENV)).toBe('invalid');
    expect(verifyR1MeetResumeToken(`v1.0${exp}.${mac}`, BINDING, NOW, ENV)).toBe('invalid');
    expect(verifyR1MeetResumeToken(`v1.${exp}.${'0'.repeat(64)}`, BINDING, NOW, ENV)).toBe('invalid');
    // Upper-case ids read back from a store still verify (compared in lower case).
    const upper = { bookingId: BOOKING.toUpperCase(), sessionId: SESSION.toUpperCase() };
    expect(verifyR1MeetResumeToken(token, upper, NOW, ENV)).toBe('ok');
  });

  it('expires at exp*1000 exactly: one ms before is ok, at and after is expired', () => {
    const token = mint();
    const expMs = NOW + 300_000;
    expect(verifyR1MeetResumeToken(token, BINDING, expMs - 1, ENV)).toBe('ok');
    expect(verifyR1MeetResumeToken(token, BINDING, expMs, ENV)).toBe('expired');
    expect(verifyR1MeetResumeToken(token, BINDING, NOW + 301_000, ENV)).toBe('expired');
    // The MAC is checked first: an expired token for another session is invalid, not expired.
    const otherSession = { bookingId: BOOKING, sessionId: '30000000-0000-4000-8000-0000000000e2' };
    expect(verifyR1MeetResumeToken(token, otherSession, expMs, ENV)).toBe('invalid');
    expect(verifyR1MeetResumeToken(flipLast(token), BINDING, expMs, ENV)).toBe('invalid');
  });

  it('floors a sub-second clock and gives a fresh token each second', () => {
    expect(mint(BINDING, NOW + 999)).toBe(mint(BINDING, NOW));
    expect(mint(BINDING, NOW + 1000)).not.toBe(mint(BINDING, NOW));
  });

  it('refuses malformed strings and non-strings as invalid, without throwing', () => {
    const token = mint();
    const junk: unknown[] = [
      undefined,
      null,
      42,
      {},
      [token],
      '',
      'v1',
      'v1..',
      token.toUpperCase(),
      token.replace(/^v1/, 'v2'),
      `${token}0`,
      token.slice(0, -1),
      ` ${token}`,
      `v1.${'1'.repeat(13)}.${'0'.repeat(64)}`,
      `v1.-1.${'0'.repeat(64)}`,
    ];
    for (const bad of junk) expect(verifyR1MeetResumeToken(bad, BINDING, NOW, ENV), String(bad)).toBe('invalid');
  });

  it('mints nothing for ids that are not UUIDs or an unusable clock, and verifies nothing against them', () => {
    const token = mint();
    for (const binding of [
      { bookingId: 'booking', sessionId: SESSION },
      { bookingId: BOOKING, sessionId: '' },
      { bookingId: `${BOOKING}.x`, sessionId: SESSION },
      null,
    ]) {
      expect(mintR1MeetResumeToken(binding as never, NOW, ENV)).toBeNull();
      expect(verifyR1MeetResumeToken(token, binding as never, NOW, ENV)).toBe('invalid');
    }
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(mintR1MeetResumeToken(BINDING, nowMs, ENV)).toBeNull();
    }
  });

  it('with no or a short worker secret: mint is null and verify is invalid; another secret never verifies', () => {
    const token = mint();
    for (const env of [{}, { WORKER_CONTEXT_SECRET: 'w'.repeat(31) }] as NodeJS.ProcessEnv[]) {
      expect(mintR1MeetResumeToken(BINDING, NOW, env)).toBeNull();
      expect(verifyR1MeetResumeToken(token, BINDING, NOW, env)).toBe('invalid');
    }
    const other = { WORKER_CONTEXT_SECRET: 'v'.repeat(40) } as NodeJS.ProcessEnv;
    expect(verifyR1MeetResumeToken(token, BINDING, NOW, other)).toBe('invalid');
  });

  it('never accepts an attempt token (another domain and shape)', () => {
    const attempt = mintAttemptToken({ sessionId: SESSION, nonceDigest: 'a'.repeat(64) }, NOW, ENV)!;
    expect(attempt).not.toBeNull();
    expect(verifyR1MeetResumeToken(attempt.token, BINDING, NOW, ENV)).toBe('invalid');
    // Even re-shaped into the resume layout, the attempt MAC is not a resume MAC.
    const [, exp, mac] = attempt.token.split('.');
    expect(verifyR1MeetResumeToken(`v1.${exp}.${mac}`, BINDING, NOW, ENV)).toBe('invalid');
  });
});
