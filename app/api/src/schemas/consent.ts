/**
 * GOV-03/GOV-08/GOV-09/GOV-10: Consent and privacy notice schemas.
 *
 * Consent types (migration 0013 enum):
 *   ai_interview, recording, purpose, data_processing,
 *   retention, rights, job_application
 *
 * GOV-10: job_application alone cannot unlock ai_interview or recording.
 * The consumer-side route guard enforces this.
 */

import { z } from 'zod';

// ── Consent type enum ───────────────────────────────────────────────

export const CONSENT_TYPES = [
  'ai_interview',
  'recording',
  'purpose',
  'data_processing',
  'retention',
  'rights',
  'job_application',
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

// ── Consent statuses ────────────────────────────────────────────────

export const CONSENT_STATUSES = ['granted', 'declined', 'withdrawn'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

// ── POST /api/consent/submit ────────────────────────────────────────
// Candidate submits consent (accept or decline individual consent types).

export const consentSubmitSchema = z
  .object({
    candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
    version: z.string().min(1, 'version is required').default('1.0'),
    consents: z
      .array(z.enum(CONSENT_TYPES))
      .min(1, 'at least one consent type is required'),
    status: z.enum(CONSENT_STATUSES).default('granted'),
    proof: z
      .object({
        ip_address: z.string().ip().optional(),
        user_agent: z.string().max(512).optional(),
        captured_at: z.string().datetime().optional(),
        notice_version: z.string().optional(),
        note: z.string().max(2000).optional(),
      })
      .optional()
      .default({}),
    expires_at: z.string().datetime().optional(),
  })
  .strict();

export type ConsentSubmitInput = z.infer<typeof consentSubmitSchema>;

export interface ConsentSubmitResponse {
  id: string;
  candidate_id: string;
  status: ConsentStatus;
  consents: ConsentType[];
  version: string;
  created_at: string;
}

// ── GET /api/consent/:candidateId/status ────────────────────────────
// Check candidate's current consent status for a specific type.

export const consentStatusQuerySchema = z
  .object({
    type: z.enum(CONSENT_TYPES).optional(),
  })
  .strict();

export type ConsentStatusQuery = z.infer<typeof consentStatusQuerySchema>;

export interface ConsentStatusResponse {
  candidate_id: string;
  has_consent: boolean;
  has_ai_consent: boolean;
  has_recording_consent: boolean;
  latest_consent: {
    id: string;
    status: ConsentStatus;
    consents: ConsentType[];
    version: string;
    created_at: string;
  } | null;
}

// ── POST /api/consent/recording/check ───────────────────────────────
// GOV-10: Check if candidate has granted recording consent.
// Used by routes that gate recording or AI screening.

export const consentCheckSchema = z
  .object({
    candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
    required: z
      .array(z.enum(CONSENT_TYPES))
      .min(1)
      .default(['ai_interview', 'recording']),
  })
  .strict();

export type ConsentCheckInput = z.infer<typeof consentCheckSchema>;

export interface ConsentCheckResponse {
  ok: boolean;
  missing: ConsentType[];
}

// ── GET /api/consent/templates ──────────────────────────────────────
// Fetch active consent/privacy notice templates.

export interface ConsentTemplateResponse {
  id: string;
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: ConsentType[];
  is_active: boolean;
}

// ── POST /api/consent/withdraw ──────────────────────────────────────
// Withdraw previously granted consent.

export const consentWithdrawSchema = z
  .object({
    candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
    consent_types: z.array(z.enum(CONSENT_TYPES)).optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export type ConsentWithdrawInput = z.infer<typeof consentWithdrawSchema>;

export interface ConsentWithdrawResponse {
  id: string;
  status: ConsentStatus;
  updated_at: string;
}
