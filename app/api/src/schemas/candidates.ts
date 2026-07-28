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

// ── Path params ───────────────────────────────────────────────────

export const candidateIdParamSchema = idParamSchema;
