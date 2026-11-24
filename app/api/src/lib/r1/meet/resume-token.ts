/**
 * The Meet bridge resume token (M034 S05, dark; contracts §9 S07 item 4, D-S05-8).
 *
 * The bridge ticket is single use and is claimed BEFORE admission, so when the Meet exchange has
 * to answer 202 `preparing` (the worker is still booting, or the room needs another try) the page
 * cannot simply present the ticket again: a second claim would be refused as
 * `ticket_already_claimed` and raise an alert. Every 202 therefore carries a FRESH resume token,
 * and `{ ticket, resume_token }` continues the same booking and the same session without a second
 * claim or admission.
 *
 * Shape: `v1.<expSec>.<mac64>` with `mac = HMAC(resumeKey, "<bookingId>.<sessionId>.<expSec>")`,
 * where `resumeKey = HMAC(WORKER_CONTEXT_SECRET, "hello:r1:meet-resume:v1")` (the same derivation
 * as the bridge ticket's key, in its own domain). The token names no id: the server re-derives the
 * booking from the ticket digest and the session from the booking, then verifies the MAC against
 * that pair. A re-arm changes the ticket, so an old resume token dies with its ticket.
 *
 * Verification is constant time and checks the MAC BEFORE the expiry, exactly like
 * `../attempt-token.ts`: a forged token and an expired one cost the same work, and only a token
 * this server minted for this booking and session can ever read as `expired`. Stateless, never
 * logged, never audited, never persisted. No I/O at import.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { r1MeetDerivedKey } from './ticket.js';

/** The HMAC domain of the resume token key. */
export const R1_MEET_RESUME_DOMAIN = 'hello:r1:meet-resume:v1';
/** A resume token is good for this long (about 5 minutes, like the attempt token). */
export const R1_MEET_RESUME_TTL_SEC = 5 * 60;
/** The only shape a resume token may have (the exchange's strict body schema uses it too). */
export const R1_MEET_RESUME_TOKEN_PATTERN = /^v1\.[0-9]{1,12}\.[a-f0-9]{64}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The booking and the bound session a resume token continues. */
export interface R1MeetResumeBinding {
  readonly bookingId: string;
  readonly sessionId: string;
}

export type R1MeetResumeVerdict = 'ok' | 'invalid' | 'expired';

/** Ids are compared in lower case, so a binding read back from PostgREST verifies either way. */
function canonicalBinding(binding: R1MeetResumeBinding): R1MeetResumeBinding | null {
  if (typeof binding !== 'object' || binding === null) return null;
  const { bookingId, sessionId } = binding;
  if (typeof bookingId !== 'string' || typeof sessionId !== 'string') return null;
  if (!UUID.test(bookingId) || !UUID.test(sessionId)) return null;
  return { bookingId: bookingId.toLowerCase(), sessionId: sessionId.toLowerCase() };
}

/** The MAC covers the expiry exactly as written in the token, so `v1.0300.<mac>` is not `v1.300.<mac>`. */
function mac(key: Buffer, binding: R1MeetResumeBinding, expiresText: string): string {
  return createHmac('sha256', key)
    .update(`${binding.bookingId}.${binding.sessionId}.${expiresText}`)
    .digest('hex');
}

/**
 * Mint a resume token for a claimed booking and its bound session, valid for 300 s from `nowMs`.
 * Null when no resume key exists (no or short worker secret), an id is not UUID-shaped, or the
 * clock is unusable.
 */
export function mintR1MeetResumeToken(
  binding: R1MeetResumeBinding,
  nowMs: number,
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = r1MeetDerivedKey(R1_MEET_RESUME_DOMAIN, source);
  const canonical = canonicalBinding(binding);
  if (!key || !canonical || typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) return null;
  const expiresSec = Math.floor(nowMs / 1000) + R1_MEET_RESUME_TTL_SEC;
  return `v1.${expiresSec}.${mac(key, canonical, String(expiresSec))}`;
}

/**
 * Verify a presented resume token against the booking and session the server re-derived.
 * `invalid`: not a token, no key, a binding that is not UUID-shaped, or a MAC that does not match
 * (another booking, another session, a tampered expiry or MAC). `expired`: the MAC matches but
 * `expSec * 1000 <= nowMs`. `ok` otherwise. The MAC is compared in constant time first; the expiry
 * is read only after it.
 */
export function verifyR1MeetResumeToken(
  token: unknown,
  binding: R1MeetResumeBinding,
  nowMs: number,
  source: NodeJS.ProcessEnv = process.env,
): R1MeetResumeVerdict {
  const key = r1MeetDerivedKey(R1_MEET_RESUME_DOMAIN, source);
  const canonical = canonicalBinding(binding);
  if (!key || !canonical || typeof token !== 'string' || !R1_MEET_RESUME_TOKEN_PATTERN.test(token)) {
    return 'invalid';
  }
  const [, expiresText, presented] = token.split('.') as [string, string, string];
  const expected = mac(key, canonical, expiresText);
  const macOk = timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
  if (!macOk) return 'invalid';
  const expiresSec = Number(expiresText);
  return typeof nowMs === 'number' && Number.isFinite(nowMs) && expiresSec * 1000 > nowMs ? 'ok' : 'expired';
}
