import { z } from 'zod';
import { zod3Int } from '../lib/zod-compat.js';
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

/** The longest time a note can point at, as 0137's CHECK: a day, far past any interview. */
export const NOTE_MEDIA_MS_MAX = 86_400_000;

/**
 * POST /api/notes body — append-only note on a candidate (DB bound: 1..2000).
 *
 * A note can also say where it belongs: a round, an attempt of it, and a time in that attempt's
 * recording (0137). Each needs the one before it, as the CHECKs do. Whether the attempt really is one
 * of the round's and the round the candidate's takes a read, so the route decides that.
 */
export const noteCreateSchema = z
  .object({
    candidate_id: uuidSchema,
    note: z
      .string()
      .trim()
      .min(1, 'note is required')
      .max(2000, 'note must be at most 2000 characters'),
    round_id: uuidSchema.optional(),
    session_id: uuidSchema.optional(),
    media_ms: z.number().check(zod3Int()).min(0).max(NOTE_MEDIA_MS_MAX).optional(),
  })
  .strict()
  .refine((body) => body.session_id === undefined || body.round_id !== undefined, {
    message: 'session_id needs round_id',
    path: ['session_id'],
  })
  .refine((body) => body.media_ms === undefined || body.session_id !== undefined, {
    message: 'media_ms needs session_id',
    path: ['media_ms'],
  });

export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

/** GET /api/notes query — candidate scoping + bounded page. */
export const noteListQuerySchema = z
  .object({
    candidate_id: uuidSchema,
    limit: z.coerce.number().check(zod3Int()).min(1).max(100).optional(),
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

/** Path param for one round's notes. */
export const roundIdParamSchema = z.object({ roundId: uuidSchema }).strict();

export interface NoteResponse {
  id: string;
  candidate_id: string;
  author_id: string;
  note: string;
  created_at: string;
  /** 0137. Each is null on a note that does not say. */
  round_id: string | null;
  session_id: string | null;
  media_ms: number | null;
}

export interface NoteListResponse {
  notes: NoteResponse[];
}

export interface StatusTransitionResponse {
  ok: true;
  from: string;
  to: string;
}
