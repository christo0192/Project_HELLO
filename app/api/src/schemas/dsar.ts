/**
 * GOV-05: DSAR request schemas — export/delete/correct route validation.
 */

import { z } from 'zod';
import { zod3Datetime, zod3Uuid } from '../lib/zod-compat.js';

// ── Common ───────────────────────────────────────────────────────────

export const dsarIdParamSchema = z
  .object({
    dsarId: zod3Uuid('dsarId must be a valid UUID'),
  })
  .strict();

export const candidateIdParamSchema = z
  .object({
    candidateId: zod3Uuid('candidateId must be a valid UUID'),
  })
  .strict();

// ── POST /api/dsar — Create DSAR request ────────────────────────────

export const createDSARBodySchema = z
  .object({
    candidate_id: zod3Uuid('candidate_id must be a valid UUID'),
    request_type: z.enum(['export', 'delete', 'correct', 'restrict'], {
      error: 'request_type must be one of: export, delete, correct, restrict',
    }),
    notes: z.string().max(2000, 'notes must not exceed 2000 characters').optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (val) => JSON.stringify(val).length <= 4096,
        'metadata must not exceed 4KB when serialized',
      )
      .optional(),
  })
  .strict();

export type CreateDSARBodyInput = z.infer<typeof createDSARBodySchema>;

// ── GET /api/dsar/:dsarId — Get DSAR status ─────────────────────────

export const getDSARQuerySchema = z
  .object({
    include_export: z.enum(['true', 'false']).optional(),
  })
  .strict();

export type GetDSARQueryInput = z.infer<typeof getDSARQuerySchema>;

// ── GET /api/dsar/candidate/:candidateId — List DSARs for candidate ─

export const listCandidateDSARsQuerySchema = z
  .object({
    status: z
      .enum(['pending', 'in_progress', 'fulfilled', 'rejected', 'cancelled'])
      .optional(),
    type: z
      .enum(['export', 'delete', 'correct', 'restrict'])
      .optional(),
  })
  .strict();

export type ListCandidateDSARsQueryInput = z.infer<typeof listCandidateDSARsQuerySchema>;

// ── POST /api/dsar/:dsarId/fulfill — Fulfill/reject/cancel DSAR ─────

export const fulfillDSARBodySchema = z
  .object({
    status: z.enum(['fulfilled', 'rejected', 'cancelled'], {
      error: 'status must be one of: fulfilled, rejected, cancelled',
    }),
    rejection_reason: z
      .string()
      .max(2000, 'rejection_reason must not exceed 2000 characters')
      .optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.status === 'rejected' && !data.rejection_reason) {
        return false;
      }
      return true;
    },
    { message: 'rejection_reason is required when status is rejected' },
  );

export type FulfillDSARBodyInput = z.infer<typeof fulfillDSARBodySchema>;

// ── POST /api/dsar/:dsarId/correct — Apply corrections ──────────────

export const correctDSARBodySchema = z
  .object({
    corrections: z
      .array(
        z
          .object({
            field: z
              .string()
              .min(1, 'field must not be empty')
              .max(128, 'field must not exceed 128 characters'),
            // zod 3 treated an `unknown` key as optional; zod 4 requires it.
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .min(1, 'At least one correction is required')
      .max(50, 'Cannot apply more than 50 corrections at once'),
  })
  .strict();

export type CorrectDSARBodyInput = z.infer<typeof correctDSARBodySchema>;

// ── Legal hold schemas ───────────────────────────────────────────────

export const createLegalHoldBodySchema = z
  .object({
    entity_type: z.enum(
      ['candidate', 'session', 'transcript', 'recording', 'assessment', 'resume'],
      { error: 'entity_type must be a valid governance entity type' },
    ),
    entity_id: zod3Uuid('entity_id must be a valid UUID'),
    hold_reason: z
      .string()
      .min(1, 'hold_reason is required')
      .max(2000, 'hold_reason must not exceed 2000 characters'),
    hold_source: z.enum(
      ['court_order', 'internal_investigation', 'litigation_hold', 'regulatory', 'other'],
      { error: 'hold_source must be a valid hold source' },
    ),
    expires_at: zod3Datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CreateLegalHoldBodyInput = z.infer<typeof createLegalHoldBodySchema>;

export const releaseLegalHoldBodySchema = z
  .object({
    release_reason: z
      .string()
      .min(1, 'release_reason is required')
      .max(2000, 'release_reason must not exceed 2000 characters'),
  })
  .strict();

export type ReleaseLegalHoldBodyInput = z.infer<typeof releaseLegalHoldBodySchema>;
