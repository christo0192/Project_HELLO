import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_TOKEN_TTL_SEC,
  attemptTokensConfigured,
  generateNonce,
  hashNonce,
  isNonceShape,
  mintAttemptToken,
  nonceMatchesDigest,
  peekAttemptToken,
  verifyAttemptToken,
} from '../lib/r1/attempt-token.js';

const SESSION = '30000000-0000-4000-8000-0000000000e1';
const SECRET = 's'.repeat(40);
const ENV = { WORKER_CONTEXT_SECRET: SECRET } as NodeJS.ProcessEnv;
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const DIGEST = hashNonce('a'.repeat(64));

function mint(env = ENV, nowMs = NOW, sessionId = SESSION, nonceDigest = DIGEST) {
  return mintAttemptToken({ sessionId, nonceDigest }, nowMs, env)!;
}

describe('R1 nonce', () => {
  it('is 256 random bits, and only its digest verifies', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
    expect(isNonceShape(a)).toBe(true);
    expect(nonceMatchesDigest(a, hashNonce(a))).toBe(true);
    expect(nonceMatchesDigest(a, hashNonce(b))).toBe(false);
    // The digest is not an acceptable nonce, and bad shapes never throw.
    expect(nonceMatchesDigest(hashNonce(a), hashNonce(a))).toBe(false);
    expect(nonceMatchesDigest('short', hashNonce(a))).toBe(false);
    expect(nonceMatchesDigest(a, 'not-a-digest')).toBe(false);
    expect(nonceMatchesDigest(undefined, undefined)).toBe(false);
  });
});

describe('R1 attempt token', () => {
  it('verifies for its attempt until it expires, and not a second after', () => {
    const minted = mint();
    expect(minted.expiresAt.getTime()).toBe(NOW + ATTEMPT_TOKEN_TTL_SEC * 1000);
    expect(peekAttemptToken(minted.token)).toEqual({
      sessionId: SESSION,
      expiresSec: NOW / 1000 + ATTEMPT_TOKEN_TTL_SEC,
    });
    expect(verifyAttemptToken(minted.token, DIGEST, NOW, ENV)).toBe(true);
    expect(verifyAttemptToken(minted.token, DIGEST, NOW + 299_999, ENV)).toBe(true);
    expect(verifyAttemptToken(minted.token, DIGEST, NOW + 300_000, ENV)).toBe(false);
  });

  it('is bound to its attempt: another digest, session or a tamper never verifies', () => {
    const minted = mint();
    expect(verifyAttemptToken(minted.token, hashNonce('b'.repeat(64)), NOW, ENV)).toBe(false);
    const otherSession = minted.token.replace(SESSION, '30000000-0000-4000-8000-0000000000e2');
    expect(verifyAttemptToken(otherSession, DIGEST, NOW, ENV)).toBe(false);
    const parts = minted.token.split('.');
    const extended = `${parts[0]}.${Number(parts[1]) + 3600}.${parts[2]}`;
    expect(verifyAttemptToken(extended, DIGEST, NOW, ENV)).toBe(false);
    const flipped = `${minted.token.slice(0, -1)}${minted.token.endsWith('0') ? '1' : '0'}`;
    expect(verifyAttemptToken(flipped, DIGEST, NOW, ENV)).toBe(false);
  });

  it('does not verify under another secret, and a missing or short secret mints nothing', () => {
    const minted = mint();
    const other = { WORKER_CONTEXT_SECRET: 't'.repeat(40) } as NodeJS.ProcessEnv;
    expect(verifyAttemptToken(minted.token, DIGEST, NOW, other)).toBe(false);
    for (const env of [{}, { WORKER_CONTEXT_SECRET: 'short' }] as NodeJS.ProcessEnv[]) {
      expect(attemptTokensConfigured(env)).toBe(false);
      expect(mintAttemptToken({ sessionId: SESSION, nonceDigest: DIGEST }, NOW, env)).toBeNull();
      expect(verifyAttemptToken(minted.token, DIGEST, NOW, env)).toBe(false);
    }
    expect(attemptTokensConfigured(ENV)).toBe(true);
  });

  it('never embeds the nonce, its digest or the secret', () => {
    const nonce = generateNonce();
    const digest = hashNonce(nonce);
    const { token } = mint(ENV, NOW, SESSION, digest);
    expect(token).not.toContain(nonce);
    expect(token).not.toContain(digest);
    expect(token).not.toContain(SECRET);
  });

  it('rejects malformed input without throwing', () => {
    const junk = [undefined, null, 42, '', 'a.b.c', `${SESSION}.1.zz`];
    for (const bad of [...junk, `${SESSION}.x.${'0'.repeat(64)}`]) {
      expect(peekAttemptToken(bad)).toBeNull();
      expect(verifyAttemptToken(bad, DIGEST, NOW, ENV)).toBe(false);
    }
    expect(verifyAttemptToken(mint().token, undefined, NOW, ENV)).toBe(false);
    expect(verifyAttemptToken(mint().token, 'nope', NOW, ENV)).toBe(false);
    expect(mintAttemptToken({ sessionId: 'nope', nonceDigest: DIGEST }, NOW, ENV)).toBeNull();
    expect(mintAttemptToken({ sessionId: SESSION, nonceDigest: 'nope' }, NOW, ENV)).toBeNull();
  });

  it('is deterministic for fixed inputs, so a replay inside the TTL is the same bearer', () => {
    expect(mint().token).toBe(mint().token);
    expect(mint(ENV, NOW + 1000).token).not.toBe(mint().token);
  });
});
