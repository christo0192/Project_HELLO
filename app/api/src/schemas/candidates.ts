import { z } from 'zod';
import { idParamSchema, roleIdQuerySchema } from './common.js';

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
