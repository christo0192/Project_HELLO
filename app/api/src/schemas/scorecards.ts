import { z } from 'zod';
import { uuidSchema } from './common.js';
import {
  SCORECARD_MAX_INSTRUCTION_LENGTH,
  SCORECARD_MAX_METRICS,
  SCORECARD_MAX_NAME_LENGTH,
  SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH,
  SCORECARD_WEIGHT_TOTAL_BPS,
} from '../lib/scorecards/contracts.js';

/**
 * Request-body schemas for the scorecard HTTP API.
 *
 * These are the first line of validation (shape/bounds/whitelisting). The
 * scorecard DOMAIN helpers (`validateRubric`, `validateRoleMetrics`,
 * `redistributeWeights`) remain the authority on cross-field invariants
 * (weights totalling 10000 bps, four-level rubric normalisation, unique
 * keys/orders); the route calls them after these schemas pass. The database
 * CHECK constraints and triggers are the final backstop. Bounds here are kept
 * in lock-step with the shared `SCORECARD_*` constants so the three layers can
 * never silently diverge.
 */

/** Stable metric-key grammar shared with the DB CHECK and domain validators. */
export const METRIC_KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * A four-level rubric ({"1".."4"} → short descriptors): 1 Poor, 2 Average,
 * 3 Good, 4 Excellent. Four-level since migration 0093 — Ashby Score fields
 * are four-point, so a metric score is written there 1:1. `.strict()` means a
 * request still carrying the retired `"5"` is rejected here rather than
 * reaching `validateRubric`.
 */
const rubricSchema = z
  .object({
    '1': z.string().trim().min(1).max(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    '2': z.string().trim().min(1).max(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    '3': z.string().trim().min(1).max(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    '4': z.string().trim().min(1).max(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
  })
  .strict();

// ── Metric library (admin) ──────────────────────────────────────────────

export const createMetricSchema = z
  .object({
    // Optional: the route derives a slug from `name` when omitted.
    key: z.string().trim().regex(METRIC_KEY_RE, 'key must match ^[a-z][a-z0-9_]{1,62}$').optional(),
    name: z.string().trim().min(1).max(SCORECARD_MAX_NAME_LENGTH),
    description: z.string().trim().max(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH).nullable().optional(),
    default_instruction: z.string().trim().min(1).max(SCORECARD_MAX_INSTRUCTION_LENGTH),
    rubric: rubricSchema,
  })
  .strict();

export type CreateMetricInput = z.infer<typeof createMetricSchema>;

export const updateMetricSchema = z
  .object({
    name: z.string().trim().min(1).max(SCORECARD_MAX_NAME_LENGTH).optional(),
    description: z.string().trim().max(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH).nullable().optional(),
    default_instruction: z.string().trim().min(1).max(SCORECARD_MAX_INSTRUCTION_LENGTH).optional(),
    rubric: rubricSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export type UpdateMetricInput = z.infer<typeof updateMetricSchema>;

export const metricIdParamSchema = z.object({ id: uuidSchema }).strict();

// ── Role scorecard (interviewer owns own role, admin all) ────────────────

/**
 * One desired metric in a role's scorecard. The role only supplies the
 * library reference, the per-role instruction override, and the weight/order;
 * name/key/rubric are snapshotted server-side from the library at write time.
 * `instruction` and `displayOrder` are optional — the route falls back to the
 * library's default_instruction and the array index respectively.
 */
const putMetricSchema = z
  .object({
    libraryMetricId: uuidSchema,
    instruction: z.string().trim().min(1).max(SCORECARD_MAX_INSTRUCTION_LENGTH).optional(),
    weightBps: z.number().int().min(1).max(SCORECARD_WEIGHT_TOTAL_BPS),
    displayOrder: z.number().int().min(0).max(SCORECARD_MAX_METRICS - 1).optional(),
  })
  .strict();

export const putRoleScorecardSchema = z
  .object({
    metrics: z.array(putMetricSchema).min(1).max(SCORECARD_MAX_METRICS),
  })
  .strict();

export type PutRoleScorecardInput = z.infer<typeof putRoleScorecardSchema>;

export const roleScorecardParamSchema = z.object({ roleId: uuidSchema }).strict();

/**
 * Redistribute-preview body. The preview is a pure calculator over the client's
 * working metric set, so it carries the FULL RoleScorecardMetric shape — the
 * exact set returned by GET /roles/:roleId/scorecard — which lets the server run
 * `redistributeWeights` unchanged (it validates the whole set) and lets the
 * slider round-trip authoritative weights without any fabricated placeholder
 * data. No database row is read or written from the supplied metrics.
 */
const previewMetricSchema = z
  .object({
    id: uuidSchema,
    libraryMetricId: uuidSchema,
    key: z.string().trim().regex(METRIC_KEY_RE),
    name: z.string().trim().min(1).max(SCORECARD_MAX_NAME_LENGTH),
    instruction: z.string().trim().min(1).max(SCORECARD_MAX_INSTRUCTION_LENGTH),
    rubric: rubricSchema,
    weightBps: z.number().int().min(1).max(SCORECARD_WEIGHT_TOTAL_BPS),
    displayOrder: z.number().int().min(0),
  })
  .strict();

export const redistributeSchema = z
  .object({
    metrics: z.array(previewMetricSchema).min(1).max(SCORECARD_MAX_METRICS),
    editedMetricId: uuidSchema,
    newWeightBps: z.number().int().min(1).max(SCORECARD_WEIGHT_TOTAL_BPS),
  })
  .strict();

export type RedistributeInput = z.infer<typeof redistributeSchema>;
