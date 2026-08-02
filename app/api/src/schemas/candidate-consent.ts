import { z } from 'zod';
import { CONSENT_TYPES } from './consent.js';

/**
 * Phase 9 L3 — candidate (pre-join) consent schemas.
 *
 * The candidate holds an opaque invite token (64-hex, as issued by
 * routes/invites.ts), NOT an access grant. All candidate-facing endpoints
 * validate the invite and never return candidate_id, PII, or any token/
 * digest material.
 */

export const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** Bounded/allowlisted BCP-47-ish locale shape (e.g. en, en-IN). */
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'locale must match language[-REGION] (e.g. en-IN)');

export const inviteTokenSchema = z
  .string()
  .regex(INVITE_TOKEN_PATTERN, 'invite token is invalid');

/** POST /api/candidate-consent/status body. */
export const consentStatusSchema = z
  .object({
    invite_token: inviteTokenSchema,
  })
  .strict();

/** POST /api/candidate-consent/submit body. */
export const consentSubmitSchema = z
  .object({
    invite_token: inviteTokenSchema,
    template_version: z.string().trim().min(1, 'template_version is required').max(64, 'template_version too long'),
    locale: localeSchema,
    consents: z.array(z.enum(CONSENT_TYPES)).max(16, 'too many consent types'),
    status: z.enum(['granted', 'declined']),
  })
  .strict();

export type ConsentSubmitInput = z.infer<typeof consentSubmitSchema>;

/** GET /api/candidate-consent/template query. */
export const consentTemplateQuerySchema = z
  .object({
    locale: localeSchema.optional(),
  })
  .strict();

export interface ConsentStatusResponse {
  /** Whether the invite-bound candidate currently has granted consent. */
  has_consent: boolean;
  /** Active template version; null when no active Legal template exists. */
  template_version: string | null;
  locale: string | null;
  required_consents: string[];
}

export interface ConsentTemplateResponse {
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: string[];
}

export interface ConsentSubmitResponse {
  id: string;
  status: 'granted' | 'declined';
  consents: string[];
  template_version: string;
  locale: string;
  created_at: string;
}
