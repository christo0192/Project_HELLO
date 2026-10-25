import { z } from 'zod';
import { zod3Int } from '../lib/zod-compat.js';
import { uuidSchema } from './common.js';

/**
 * Phase 9 L3 — appeal schemas (consistency #3/#4: separate appeal_grants
 * table/lib; append-only appeal_review_events via the atomic review RPC).
 *
 * - Grant issuance requires an EXPLICIT bounded expiry (no hidden policy
 *   default).
 * - Candidate submission never accepts an assessment_snapshot — it is
 *   built server-side (IDs/version hash/numeric scores/bands only).
 * - Review accepts only legal CAS transitions (open → under_review →
 *   granted|denied); it never accepts assessment_snapshot or "created"
 *   evidence mutations (strict schema rejects unknown keys).
 */

export const APPEAL_CATEGORIES = ['scoring', 'recording', 'accessibility', 'other'] as const;

export const APPEAL_REVIEW_TARGETS = ['under_review', 'granted', 'denied'] as const;

/** POST /api/appeals/grants body — explicit bounded expiry is REQUIRED. */
export const appealGrantCreateSchema = z
  .object({
    candidate_id: uuidSchema,
    session_id: uuidSchema,
    expires_in_hours: z
      .number({
        // zod 3 `invalid_type_error`: only a PRESENT non-number. A missing key
        // keeps the default "Required", and ±Infinity (a number zod 3
        // accepted) keeps "Number must be finite".
        error: (issue) => {
          if (issue.code !== 'invalid_type' || issue.expected !== 'number') return undefined;
          const input = issue.input;
          if (input === undefined) return undefined;
          if (typeof input === 'number' && !Number.isNaN(input)) return undefined;
          return 'expires_in_hours is required';
        },
      })
      .check(zod3Int('expires_in_hours must be an integer'))
      .min(1, 'expires_in_hours must be 1..72')
      .max(72, 'expires_in_hours must be 1..72'),
  })
  .strict();

export type AppealGrantCreateInput = z.infer<typeof appealGrantCreateSchema>;

/** POST /api/appeals body (public candidate submission). */
export const appealCreateSchema = z
  .object({
    appeal_grant_token: z.string().regex(/^[a-f0-9]{64}$/, 'appeal grant token is invalid'),
    category: z.enum(APPEAL_CATEGORIES),
    description: z.string().trim().min(1, 'description is required').max(2000, 'description must be at most 2000 characters'),
  })
  .strict();

export type AppealCreateInput = z.infer<typeof appealCreateSchema>;

/** GET /api/appeals query — recruiter list scoped to one candidate. */
export const appealListQuerySchema = z.object({ candidate_id: uuidSchema }).strict();

/** POST /api/appeals/:appealId/review body — legal CAS target + bounded notes/evidence. */
export const appealReviewSchema = z
  .object({
    to_status: z.enum(APPEAL_REVIEW_TARGETS),
    notes: z.string().trim().max(2000, 'notes must be at most 2000 characters').optional(),
    evidence: z
      .record(
        z.string().min(1).max(64),
        z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();

export type AppealReviewInput = z.infer<typeof appealReviewSchema>;

/** Path param for POST /api/appeals/:appealId/review. */
export const appealIdParamSchema = z.object({ appealId: uuidSchema }).strict();
