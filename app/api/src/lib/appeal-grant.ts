import { randomBytes, createHash } from 'node:crypto';
import { supabase } from './supabase.js';

/**
 * Phase 9 L3 — appeal submission grants (consistency #3).
 *
 * SEPARATE from candidate_access_grants: this lane and its lib never touch
 * that table. A high-entropy plaintext token is returned to the issuer
 * EXACTLY once; only its SHA-256 hex digest is persisted in appeal_grants
 * (DB CHECK: ^[a-f0-9]{64}$). Replay/expiry/revocation are enforced both
 * here (validation) and atomically inside the create_appeal RPC.
 */

const GRANT_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function generateAppealGrantToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashAppealGrantToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

export interface AppealGrantCreateInput {
  candidate_id: string;
  session_id: string;
  created_by: string;
  /** Explicit bounded ISO-8601 expiry (no hidden policy default). */
  expires_at: string;
}

export interface AppealGrantCreated {
  token: string;
  digest: string;
  expires_at: string;
}

/**
 * Issue an appeal grant: persists ONLY the SHA-256 digest and returns the
 * plaintext once. Throws (stable 500 via the route) on persist failure.
 */
export async function createAppealGrant(
  input: AppealGrantCreateInput,
): Promise<AppealGrantCreated> {
  const token = generateAppealGrantToken();
  const digest = hashAppealGrantToken(token);
  const { error } = await supabase.from('appeal_grants').insert({
    candidate_id: input.candidate_id,
    session_id: input.session_id,
    token_digest: digest,
    created_by: input.created_by,
    expires_at: input.expires_at,
  });
  if (error) throw new Error('failed to persist appeal grant');
  return { token, digest, expires_at: input.expires_at };
}

export interface ValidAppealGrant {
  id: string;
  candidate_id: string;
  session_id: string;
}

export type AppealGrantValidation =
  | { ok: true; grant: ValidAppealGrant }
  | { ok: false; code: 'grant_invalid' | 'grant_expired' | 'grant_revoked' | 'grant_consumed' };

/**
 * Validate a one-time appeal grant token against appeal_grants.
 * Stable per-reason codes; never returns the token or digest.
 */
export async function validateAppealGrant(token: string): Promise<AppealGrantValidation> {
  if (typeof token !== 'string' || !GRANT_TOKEN_PATTERN.test(token)) {
    return { ok: false, code: 'grant_invalid' };
  }
  const digest = hashAppealGrantToken(token);
  const { data, error } = await supabase
    .from('appeal_grants')
    .select('id, candidate_id, session_id, expires_at, consumed_at, revoked_at')
    .eq('token_digest', digest)
    .maybeSingle();

  if (error || !data) return { ok: false, code: 'grant_invalid' };
  if (data.consumed_at !== null) return { ok: false, code: 'grant_consumed' };
  if (data.revoked_at !== null) return { ok: false, code: 'grant_revoked' };
  if (new Date(data.expires_at) < new Date()) return { ok: false, code: 'grant_expired' };
  return {
    ok: true,
    grant: { id: data.id, candidate_id: data.candidate_id, session_id: data.session_id },
  };
}
