import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * Phase 9 L3 — recruiter notes + candidate status transition schemas.
 *
 * Candidate statuses mirror the candidates.status domain
 * (new|queued|screening|screened|advanced|rejected plus the system-set
 * consent_declined). Transitions are an explicit allowlist only — anything
 * else is rejected (no silent overwrite, no unknown statuses).
 */

export const CANDIDATE_STATUSES = [
  'new',
  'queued',
  'screening',
  'screened',
  'advanced',
  'rejected',
  'consent_declined',
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Explicit transition allowlist: current → permitted next statuses. */
export const CANDIDATE_STATUS_TRANSITIONS: Record<CandidateStatus, readonly CandidateStatus[]> = {
  new: ['queued', 'screening'],
  queued: ['screening'],
  screening: ['screened'],
  screened: ['advanced', 'rejected'],
  advanced: [],
  rejected: [],
  consent_declined: [],
};

/** POST /api/notes body — append-only note on a candidate (DB bound: 1..2000). */
export const noteCreateSchema = z
  .object({
    candidate_id: uuidSchema,
    note: z
      .string()
      .trim()
      .min(1, 'note is required')
      .max(2000, 'note must be at most 2000 characters'),
  })
  .strict();

export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

/** GET /api/notes query — candidate scoping + bounded page. */
export const noteListQuerySchema = z
  .object({
    candidate_id: uuidSchema,
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type NoteListQueryInput = z.infer<typeof noteListQuerySchema>;

/** POST /api/notes/:candidateId/status body — allowlisted target status only. */
export const candidateStatusUpdateSchema = z
  .object({
    status: z.enum(['queued', 'screening', 'screened', 'advanced', 'rejected']),
  })
  .strict();

export type CandidateStatusUpdateInput = z.infer<typeof candidateStatusUpdateSchema>;

/** Path param for notes/status and export routes. */
export const candidateIdParamSchema = z.object({ candidateId: uuidSchema }).strict();

export interface NoteResponse {
  id: string;
  candidate_id: string;
  author_id: string;
  note: string;
  created_at: string;
}

export interface NoteListResponse {
  notes: NoteResponse[];
}

export interface StatusTransitionResponse {
  ok: true;
  from: string;
  to: string;
}
