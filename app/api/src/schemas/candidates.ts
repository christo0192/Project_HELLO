import { z } from 'zod';
import { idParamSchema, roleIdQuerySchema, uuidSchema } from './common.js';
import { appointmentVersionSchema, utcInstantSchema } from './phone-api.js';

// ── GET /api/candidates — list candidates ────────────────────────

export const listCandidatesQuerySchema = roleIdQuerySchema;

// ── POST /api/resumes — upload resume (multipart body fields) ────

export const uploadResumeBodySchema = z
  .object({
    role_id: z.string().uuid('role_id must be a valid UUID').optional(),
  })
  .strict();

export type UploadResumeBodyInput = z.infer<typeof uploadResumeBodySchema>;

// ── Recruiter authorization guard contract ───────────────────────

/**
 * Schema for recruiter authorization header.
 *
 * In production, this header must be present and valid. The route
 * fails closed (rejects upload) when absent in production.
 *
 * The header value is a bearer token that the auth middleware resolves
 * to a recruiter identity. This schema only validates the structural
 * format; actual token verification is handled by the auth guard
 * injected at the route level.
 */
export const recruiterAuthHeaderSchema = z
  .string()
  .min(1, 'Recruiter auth header must not be empty')
  .max(1024, 'Recruiter auth header must not exceed 1024 characters');

/**
 * Injectable recruiter authorization guard contract.
 *
 * Implementations must validate the incoming request and return the
 * recruiter's identity or throw/fail. The route fails closed when
 * no guard is provided in production.
 *
 * For Codex integration, swap this with a real auth middleware.
 */
export interface RecruiterAuthGuard {
  /** Name of this guard implementation for logging. */
  readonly name: string;
  /**
   * Validate the request carries recruiter authorization.
   * Returns the recruiter identifier on success.
   * Throws an error or returns null on failure.
   */
  authorize(req: {
    headers: Record<string, string | string[] | undefined>;
    authUser?: { id: string; appRole: 'admin' | 'interviewer' | 'viewer' };
  }): Promise<string | null>;
}

// ── Path params ───────────────────────────────────────────────────

export const candidateIdParamSchema = idParamSchema;

/** Explicit confirmation is required; the server still applies every phone gate. */
export const manualPhoneCallBodySchema = z
  .object({ confirm: z.literal(true) })
  .strict();

export type ManualPhoneCallBodyInput = z.infer<typeof manualPhoneCallBodySchema>;

/** Closed, auditable reasons for starting a new immutable phone cycle. */
export const PHONE_RESCREEN_REASONS = [
  'candidate_requested',
  'incomplete_screening',
  'technical_issue',
  'role_changed',
  'quality_review',
] as const;

export const phoneRescreenBodySchema = z
  .object({
    request_id: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'request_id must be a bounded idempotency key'),
    reason: z.enum(PHONE_RESCREEN_REASONS),
  })
  .strict();

export type PhoneRescreenBodyInput = z.infer<typeof phoneRescreenBodySchema>;

/** Admin-only number reverification input. The value is never echoed or audited. */
export const phoneVerificationBodySchema = z
  .object({
    phone_e164: z.string().regex(/^\\+91[6-9][0-9]{9}$/, 'phone_e164 must be an Indian mobile'),
  })
  .strict();

export type PhoneVerificationBodyInput = z.infer<typeof phoneVerificationBodySchema>;

/** Candidate-profile booking uses the same UTC/slot shape as the calendar API. */
export const phoneCandidateAppointmentCreateSchema = z
  .object({ starts_at: utcInstantSchema, ends_at: utcInstantSchema })
  .strict();

export type PhoneCandidateAppointmentCreateInput = z.infer<typeof phoneCandidateAppointmentCreateSchema>;

export const phoneCandidateAppointmentPatchSchema = z
  .object({
    appointment_id: uuidSchema,
    starts_at: utcInstantSchema,
    ends_at: utcInstantSchema,
    version: appointmentVersionSchema,
  })
  .strict();

export type PhoneCandidateAppointmentPatchInput = z.infer<typeof phoneCandidateAppointmentPatchSchema>;
