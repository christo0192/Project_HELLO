/**
 * lib/invite-token.ts — the SINGLE implementation of candidate-invite token
 * minting and digest hashing.
 *
 * Extracted so the recruiter HTTP path (`routes/invites.ts`) and the Ashby
 * runtime materializer (`integrations/ashby/materialize.ts`) share one
 * implementation. Duplicating invite crypto across two call sites is exactly
 * how the two paths drift; there must be one.
 *
 * INVARIANTS (unchanged from the original recruiter path):
 *  - The token carries at least 256 bits of CSPRNG entropy.
 *  - Only the SHA-256 DIGEST is ever persisted. The plaintext is returned to
 *    the caller exactly once and must never be logged, audited, stored, placed
 *    in a queue payload, or sent to Ashby.
 *  - The Phase-1 TTL is exactly 24 hours (`ashby_job_mappings.invite_ttl_hours`
 *    is CHECK-pinned to 24; this constant must agree with it).
 */

import { randomBytes, createHash } from 'node:crypto';

/** Fixed Phase-1 invite TTL in hours. Must equal the DB CHECK value. */
export const INVITE_TTL_HOURS = 24 as const;

/** Fixed Phase-1 invite TTL in milliseconds. */
export const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

/** Mint a 256-bit invite token as lowercase hex. Plaintext — return once. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 digest of a token — the ONLY form that may be persisted. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

/** Expiry instant for a freshly minted invite, from an injectable clock. */
export function inviteExpiresAt(nowMs: number = Date.now()): Date {
  return new Date(nowMs + INVITE_TTL_MS);
}
