import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

/**
 * Phase 9 L3 — candidate invite validation (pre-join consent).
 *
 * The candidate holds an opaque invite token, NOT an access grant.
 * validateInvite hashes the token with SHA-256 (the existing safe crypto
 * pattern from routes/invites.ts) and queries candidate_invites. It fails
 * STABLY for unknown/expired/revoked/consumed invites — callers must never
 * be able to distinguish them — and never returns the raw token or its
 * digest in any response/log.
 */

const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

export interface ValidInvite {
  /** Opaque candidate_invites row id (safe binding; never the token/digest). */
  id: string;
  candidate_id: string;
  session_id: string;
}

export type InviteValidationResult =
  | { ok: true; invite: ValidInvite }
  | { ok: false; code: 'invite_invalid' };

/** Stable error string shared by the candidate-consent routes. */
export const STABLE_INVITE_ERROR = 'invite_token_invalid_or_expired';

/**
 * Validate a candidate invite token.
 *
 * Hash lookup on candidate_invites; active = not consumed, not revoked,
 * not expired. Returns the opaque invite id + candidate/session binding on
 * success. Never distinguishes failure reasons, never leaks the digest.
 */
export async function validateInvite(token: string): Promise<InviteValidationResult> {
  if (typeof token !== 'string' || !INVITE_TOKEN_PATTERN.test(token)) {
    return { ok: false, code: 'invite_invalid' };
  }
  const digest = hashInviteToken(token);
  const { data, error } = await supabase
    .from('candidate_invites')
    .select('id, candidate_id, session_id, expires_at, consumed_at, revoked_at')
    .eq('token_digest', digest)
    .maybeSingle();

  if (error || !data) return { ok: false, code: 'invite_invalid' };
  if (data.consumed_at !== null || data.revoked_at !== null) {
    return { ok: false, code: 'invite_invalid' };
  }
  if (new Date(data.expires_at) < new Date()) {
    return { ok: false, code: 'invite_invalid' };
  }
  return {
    ok: true,
    invite: { id: data.id, candidate_id: data.candidate_id, session_id: data.session_id },
  };
}
