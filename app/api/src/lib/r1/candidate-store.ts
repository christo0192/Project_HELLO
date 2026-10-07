/**
 * Narrow, typed reads for the R1 candidate routes.
 *
 * Every function returns `{ ok: false }` for a database error so a route can
 * answer 503 without ever mistaking an outage for "not found". None of them
 * select a digest column except `loadAttempt`, whose `nonce_digest` is compared
 * server-side and never returned. `link_token_digest` is looked up by, never
 * selected (Secret class, plan 8.1).
 */

import type { supabase } from '../supabase.js';
import { hashInviteToken } from '../invite-token.js';
import type { Read } from './consent.js';

type Db = typeof supabase;

export const LIVE_SESSION_STATUSES = ['created', 'waiting', 'in_progress'] as const;
const ROUND_COLUMNS =
  'id, candidate_id, role_id, status, expires_at, attempts_allowed, attempts_counted, starts_used, '
  + 'consent_locale';

export interface RoundRow {
  id: string;
  candidate_id: string;
  role_id: string;
  status: string;
  expires_at: string;
  attempts_allowed: number;
  attempts_counted: number;
  starts_used: number;
  /**
   * Which notice the round is shown: the locale of the consent template (migration 0120,
   * PR-CT's audience contract). Owned by the server, never by the client.
   */
  consent_locale: string;
}

/** Look a round up by the link token the candidate holds. Digest only; no plaintext. */
export async function loadRoundByLink(db: Db, token: string): Promise<Read<RoundRow | null>> {
  const { data, error } = await db
    .from('interview_rounds')
    .select(ROUND_COLUMNS)
    .eq('link_token_digest', hashInviteToken(token))
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as RoundRow | null) ?? null };
}

export async function loadRoundById(db: Db, id: string): Promise<Read<RoundRow | null>> {
  const { data, error } = await db
    .from('interview_rounds')
    .select(ROUND_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as RoundRow | null) ?? null };
}

/** A round accepts candidate work only while invited/in progress and unexpired. */
export function roundIsActive(round: RoundRow, nowMs: number): boolean {
  return (round.status === 'invited' || round.status === 'in_progress')
    && Date.parse(round.expires_at) > nowMs;
}

/** The status shown to the link holder: a lapsed round reads `expired` at once. */
export function effectiveRoundStatus(round: RoundRow, nowMs: number): string {
  const lapsed = (round.status === 'invited' || round.status === 'in_progress')
    && Date.parse(round.expires_at) <= nowMs;
  return lapsed ? 'expired' : round.status;
}

export interface SessionRow {
  id: string;
  candidate_id: string;
  status: string;
  external_call_id: string | null;
  interview_round_id: string | null;
  mode: string;
}

const SESSION_COLUMNS = 'id, candidate_id, status, external_call_id, interview_round_id, mode';

export async function loadSession(db: Db, id: string): Promise<Read<SessionRow | null>> {
  const { data, error } = await db
    .from('call_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as SessionRow | null) ?? null };
}

/** The round's live session, if any. At most one: `uq_call_sessions_interview_round_live`. */
export async function loadLiveSession(db: Db, roundId: string): Promise<Read<SessionRow | null>> {
  const { data, error } = await db
    .from('call_sessions')
    .select(SESSION_COLUMNS)
    .eq('interview_round_id', roundId)
    .in('status', [...LIVE_SESSION_STATUSES])
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as SessionRow | null) ?? null };
}

export interface AttemptRow {
  session_id: string;
  round_id: string;
  attempt_number: number;
  nonce_digest: string;
}

export async function loadAttempt(db: Db, sessionId: string): Promise<Read<AttemptRow | null>> {
  const { data, error } = await db
    .from('interview_round_attempts')
    .select('session_id, round_id, attempt_number, nonce_digest')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as AttemptRow | null) ?? null };
}

export interface SettingsRow {
  enabled: boolean;
  paused: boolean;
  livekit_target: string;
}

export async function loadSettings(db: Db): Promise<Read<SettingsRow | null>> {
  const { data, error } = await db
    .from('r1_settings')
    .select('enabled, paused, livekit_target')
    .eq('singleton', true)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as SettingsRow | null) ?? null };
}

/** The role title shown on the landing page; absent rather than failing the page. */
export async function loadRoleTitle(db: Db, roleId: string): Promise<string | null> {
  const { data, error } = await db.from('roles').select('title').eq('id', roleId).maybeSingle();
  if (error || typeof data?.title !== 'string') return null;
  const title = data.title.trim();
  return title.length > 0 && title.length <= 200 ? title : null;
}
