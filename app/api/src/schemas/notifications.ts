import { z } from 'zod';

/**
 * Phase 9 L3 — notification intent schemas.
 *
 * Intents are an idempotent log only; no provider send exists in this lane.
 * The recruiter status query returns bounded intents only — no contact
 * endpoint, no token/secret material, and no idempotency keys (internal
 * identifiers are never exposed to callers).
 */

/** Bounded idempotency key (DB column bound: 1..128 chars). */
export const notificationIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'invalid idempotency key');

export const NOTIFICATION_KINDS = [
  'quota_warning',
  'assessment_ready',
  'appeal_resolved',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationIntentResponse {
  id: string;
  kind: NotificationKind;
  candidate_id: string | null;
  consent_verified: boolean;
  created_at: string;
}

export interface NotificationIntentListResponse {
  intents: NotificationIntentResponse[];
}
