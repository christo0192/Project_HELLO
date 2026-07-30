/**
 * Short-lived opaque candidate access grant management (migration 0007).
 *
 * DB table: candidate_access_grants
 * Active grant = consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now.
 * Consumed = consumed_at SET (one-time use).
 *
 * The plaintext grant token is returned exactly once; only the SHA-256 digest
 * is persisted. VerifyGrantBinding compares request room independently, not
 * payload to itself.
 */

import { randomBytes, createHash } from 'node:crypto';
import { supabase } from './supabase.js';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_GRANT_TTL_MS = 15 * 60 * 1000;

export const ERR_GRANT_EXPIRED = 'ERR_GRANT_EXPIRED';
export const ERR_GRANT_INVALID = 'ERR_GRANT_INVALID';
export const ERR_GRANT_BINDING = 'ERR_GRANT_BINDING';
export const ERR_GRANT_DB = 'ERR_GRANT_DB';

// ── Types ────────────────────────────────────────────────────────────

export interface GrantPayload {
  candidate_id: string;
  session_id: string;
  room_name: string;
}

export interface GrantResult {
  grantToken: string;
  digest: string;
  expiresAt: Date;
}

export interface GrantValidationResult {
  ok: true;
  payload: GrantPayload;
}

export interface GrantValidationError {
  ok: false;
  code: string;
}

export type GrantValidationOutcome = GrantValidationResult | GrantValidationError;

// ── Helpers ──────────────────────────────────────────────────────────

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

function computeExpiry(ttlMs: number = DEFAULT_GRANT_TTL_MS): Date {
  const bounded = Math.max(1000, Math.min(ttlMs, MAX_GRANT_TTL_MS));
  return new Date(Date.now() + bounded);
}

// ── Grant creation ───────────────────────────────────────────────────

/**
 * Create an opaque candidate access grant.
 * Persists only the SHA-256 digest into candidate_access_grants.
 * consumed_at and revoked_at default NULL.
 */
export async function createGrant(
  payload: GrantPayload,
  ttlMs: number = DEFAULT_GRANT_TTL_MS,
): Promise<GrantResult> {
  const grantToken = generateToken();
  const digest = hashToken(grantToken);
  const expiresAt = computeExpiry(ttlMs);

  const { error } = await supabase
    .from('candidate_access_grants')
    .insert({
      token_digest: digest,
      candidate_id: payload.candidate_id,
      session_id: payload.session_id,
      room_name: payload.room_name,
      expires_at: expiresAt.toISOString(),
    });

  if (error) {
    throw new Error('failed to persist grant digest');
  }

  return { grantToken, digest, expiresAt };
}

// ── Grant validation ─────────────────────────────────────────────────

/**
 * Validate a grant token.
 *
 * Checks (all required):
 * 1. Digest exists in candidate_access_grants
 * 2. consumed_at IS NULL (not consumed)
 * 3. revoked_at IS NULL (not revoked)
 * 4. expires_at > now (not expired)
 *
 * Returns the bound payload on success.
 */
export async function validateGrant(token: string): Promise<GrantValidationOutcome> {
  const digest = hashToken(token);

  const { data, error } = await supabase
    .from('candidate_access_grants')
    .select('candidate_id, session_id, room_name, expires_at, consumed_at, revoked_at')
    .eq('token_digest', digest)
    .single();

  if (error || !data) {
    return { ok: false, code: ERR_GRANT_INVALID };
  }

  // Check not consumed
  if (data.consumed_at !== null) {
    return { ok: false, code: ERR_GRANT_INVALID };
  }

  // Check not revoked
  if (data.revoked_at !== null) {
    return { ok: false, code: ERR_GRANT_INVALID };
  }

  // Check not expired
  const now = new Date();
  const expiresAt = new Date(data.expires_at);
  if (now > expiresAt) {
    return { ok: false, code: ERR_GRANT_EXPIRED };
  }

  return {
    ok: true,
    payload: {
      candidate_id: data.candidate_id as string,
      session_id: data.session_id as string,
      room_name: data.room_name as string,
    },
  };
}

/**
 * Verify a grant payload is bound to the expected session and room.
 * Compares request-room independently — never compares payload to itself.
 */
export function verifyGrantBinding(
  payload: GrantPayload,
  expectedSessionId: string,
  expectedRoomName: string,
): boolean {
  return payload.session_id === expectedSessionId && payload.room_name === expectedRoomName;
}
