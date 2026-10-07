/**
 * R1 attempt token and nonce (plan section 4 step 6).
 *
 * `POST /api/r1/attempts` returns two secrets for one admitted attempt:
 *
 *  - the NONCE: 256 random bits that only the creating browser tab keeps (in
 *    sessionStorage). Only its SHA-256 digest is stored
 *    (`interview_round_attempts.nonce_digest`), exactly like the link token.
 *  - the ATTEMPT TOKEN: a short-lived, stateless HMAC that names the attempt
 *    and expires. It is what `POST /api/r1/exchange` redeems, together with
 *    the nonce.
 *
 * Joining a live room therefore needs a fresh attempt token (obtainable only
 * with the link, or the link AND the nonce for a rejoin) plus the nonce. A
 * leaked link cannot hijack a live attempt, and a leaked attempt token cannot
 * be redeemed without the nonce or after it expires.
 *
 * The MAC covers the attempt's stored `nonce_digest`, so a token is bound to
 * exactly one attempt row and never verifies for another. Neither secret nor
 * digest appears in the token, and the key is derived with a fixed domain
 * label so it is never the raw `WORKER_CONTEXT_SECRET`.
 *
 * Never logged, never audited, never persisted.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** An attempt token is redeemable for this long; a rejoin mints a fresh one. */
export const ATTEMPT_TOKEN_TTL_SEC = 5 * 60;

const KEY_DOMAIN = 'hello:r1:attempt-token:v1';
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^([0-9a-f-]{36})\.(\d{1,12})\.([a-f0-9]{64})$/i;

/** Mint a 256-bit nonce as lowercase hex. Plaintext: return once, never store. */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 digest of a nonce: the only form that may be persisted. */
export function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf-8').digest('hex');
}

/** True when `nonce` is the shape `generateNonce` produces. */
export function isNonceShape(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce);
}

/** Constant-time comparison of a presented nonce against a stored digest. */
export function nonceMatchesDigest(nonce: unknown, storedDigest: unknown): boolean {
  if (!isNonceShape(nonce) || typeof storedDigest !== 'string') return false;
  if (!NONCE_PATTERN.test(storedDigest)) return false;
  return timingSafeEqual(Buffer.from(hashNonce(nonce), 'hex'), Buffer.from(storedDigest, 'hex'));
}

/**
 * The signing key, or null when the shared worker secret is absent or short.
 * Read lazily so a malformed value can never stop the API from booting; the R1
 * routes answer 503 instead.
 */
function signingKey(source: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = source.WORKER_CONTEXT_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac('sha256', secret).update(KEY_DOMAIN).digest();
}

/** True when attempt tokens can be minted and verified in this process. */
export function attemptTokensConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
  return signingKey(source) !== null;
}

function mac(key: Buffer, sessionId: string, expiresSec: number, nonceDigest: string): string {
  return createHmac('sha256', key)
    .update(`${sessionId}.${expiresSec}.${nonceDigest}`)
    .digest('hex');
}

export interface MintedAttemptToken {
  token: string;
  expiresAt: Date;
}

/** Mint a token for an admitted attempt, or null when no signing key exists. */
export function mintAttemptToken(
  input: { sessionId: string; nonceDigest: string },
  nowMs: number = Date.now(),
  source: NodeJS.ProcessEnv = process.env,
): MintedAttemptToken | null {
  const key = signingKey(source);
  if (!key || !SESSION_PATTERN.test(input.sessionId) || !NONCE_PATTERN.test(input.nonceDigest)) {
    return null;
  }
  const expiresSec = Math.floor(nowMs / 1000) + ATTEMPT_TOKEN_TTL_SEC;
  const signature = mac(key, input.sessionId, expiresSec, input.nonceDigest);
  return {
    token: `${input.sessionId}.${expiresSec}.${signature}`,
    expiresAt: new Date(expiresSec * 1000),
  };
}

/** The attempt a well-formed token names. Nothing is trusted until verified. */
export function peekAttemptToken(token: unknown): { sessionId: string; expiresSec: number } | null {
  if (typeof token !== 'string') return null;
  const parts = TOKEN_PATTERN.exec(token);
  if (!parts) return null;
  return { sessionId: parts[1]!.toLowerCase(), expiresSec: Number(parts[2]) };
}

/**
 * Verify a token against the attempt's stored nonce digest. Constant-time MAC
 * comparison; expiry is checked after the MAC so the two failures are
 * indistinguishable to a caller.
 */
export function verifyAttemptToken(
  token: unknown,
  storedNonceDigest: unknown,
  nowMs: number = Date.now(),
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const key = signingKey(source);
  const peeked = peekAttemptToken(token);
  if (!key || !peeked || typeof storedNonceDigest !== 'string') return false;
  if (!NONCE_PATTERN.test(storedNonceDigest)) return false;
  const presented = (token as string).slice(-64);
  const expected = mac(key, peeked.sessionId, peeked.expiresSec, storedNonceDigest);
  const macOk = timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
  return macOk && peeked.expiresSec * 1000 > nowMs;
}
