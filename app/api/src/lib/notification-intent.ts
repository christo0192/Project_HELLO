import { supabase } from './supabase.js';

/**
 * Phase 9 L3 — notification intent service helper.
 *
 * - insertNotificationIntent: idempotent pending-intent log (UNIQUE
 *   idempotency_key); a replay returns created:false without a duplicate
 *   row. NO provider send happens anywhere in this lane.
 * - queueCandidateNotification: candidate-facing delivery is REJECTED unless
 *   channel AND template approval AND consent_verified are all explicit.
 *   No approved provider/template exists (external-pending register), so
 *   candidate delivery remains disabled and this helper never returns ok.
 *
 * The recruiter query endpoint (routes/notifications.ts) only ever returns
 * the caller's own/authorized intents.
 */

export const NOTIFICATION_KINDS = [
  'quota_warning',
  'assessment_ready',
  'appeal_resolved',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * No approved candidate channel or template exists (external-pending:
 * product + provider). These sets are intentionally EMPTY so candidate
 * delivery can never be queued through this lane.
 */
export const APPROVED_CANDIDATE_CHANNELS: readonly string[] = [];
export const APPROVED_CANDIDATE_TEMPLATES: readonly string[] = [];

export interface InsertNotificationIntentOptions {
  idempotency_key: string;
  kind: NotificationKind;
  candidate_id?: string | null;
  consent_verified?: boolean;
  payload?: Record<string, unknown> | null;
}

export interface InsertNotificationIntentResult {
  ok: true;
  /** false ⇒ idempotent replay (key already present, count unchanged). */
  created: boolean;
}

/**
 * Insert a pending notification intent idempotently. A UNIQUE
 * (idempotency_key) violation is a replay → no-op. No send is attempted.
 */
export async function insertNotificationIntent(
  opts: InsertNotificationIntentOptions,
): Promise<InsertNotificationIntentResult> {
  if (!IDEMPOTENCY_KEY_RE.test(opts.idempotency_key)) {
    throw new Error('invalid notification idempotency key');
  }
  const { error } = await supabase.from('notification_intents').insert({
    idempotency_key: opts.idempotency_key,
    kind: opts.kind,
    candidate_id: opts.candidate_id ?? null,
    consent_verified: opts.consent_verified ?? false,
    payload: opts.payload ?? null,
  });
  if (!error) return { ok: true, created: true };
  // Postgres unique_violation (23505) = idempotent replay, not an error.
  if ((error as { code?: string }).code === '23505') {
    return { ok: true, created: false };
  }
  throw new Error('failed to insert notification intent');
}

export type CandidateNotificationAttempt = {
  ok: false;
  reason: 'channel_not_approved' | 'template_not_approved' | 'consent_not_verified' | 'delivery_disabled';
};

export interface CandidateNotificationOptions {
  idempotency_key: string;
  kind: 'assessment_ready' | 'appeal_resolved';
  candidate_id: string;
  consent_verified: boolean;
  channel: string;
  template: string;
}

/**
 * Candidate notification delivery gate. Rejected unless channel AND template
 * approval AND consent_verified are all explicit. With no approved provider/
 * template, delivery is disabled and this always returns ok:false — it never
 * touches a provider and never queues candidate intents.
 */
export async function queueCandidateNotification(
  opts: CandidateNotificationOptions,
): Promise<CandidateNotificationAttempt> {
  if (opts.consent_verified !== true) {
    return { ok: false, reason: 'consent_not_verified' };
  }
  if (!APPROVED_CANDIDATE_CHANNELS.includes(opts.channel)) {
    return { ok: false, reason: 'channel_not_approved' };
  }
  if (!APPROVED_CANDIDATE_TEMPLATES.includes(opts.template)) {
    return { ok: false, reason: 'template_not_approved' };
  }
  // No send function exists by design — provider delivery is external-pending.
  return { ok: false, reason: 'delivery_disabled' };
}
