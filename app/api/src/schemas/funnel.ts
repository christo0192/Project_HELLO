import { z } from 'zod';
import { uuidSchema } from './common.js';

/** A calendar day, YYYY-MM-DD. */
const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Funnel failure stages (matches v_funnel_failures.stage). */
export const FUNNEL_FAILURE_STAGES = [
  'resume_parse',
  'dial',
  'recording',
  'call',
  'scoring',
] as const;

/** Furthest funnel stages (matches v_funnel_candidate.furthest_stage). */
export const FUNNEL_STAGES = [
  'parsed',
  'dialed',
  'connected',
  'consent_passed',
  'answered',
  'scored',
  'qualified',
  'reference_check',
] as const;

/**
 * GET /api/admin/funnel/summary — bounded date window + optional role filter.
 * Dates are optional; the handler defaults to a trailing 30-day window.
 */
export const funnelSummaryQuerySchema = z
  .object({
    from: dayString.optional(),
    to: dayString.optional(),
    role_id: uuidSchema.optional(),
  })
  .strict();

export type FunnelSummaryQueryInput = z.infer<typeof funnelSummaryQuerySchema>;

/** GET /api/admin/funnel/failures — optional window + stage filter + bounded page. */
export const funnelFailuresQuerySchema = z
  .object({
    from: dayString.optional(),
    to: dayString.optional(),
    stage: z.enum(FUNNEL_FAILURE_STAGES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  })
  .strict();

export type FunnelFailuresQueryInput = z.infer<typeof funnelFailuresQuerySchema>;

/** GET /api/admin/funnel/candidates — drill-down filters + bounded pagination. */
export const funnelCandidatesQuerySchema = z
  .object({
    role_id: uuidSchema.optional(),
    furthest_stage: z.enum(FUNNEL_STAGES).optional(),
    // drop_reason can be a dynamic outcome_class (no_answer/busy/...), so bound
    // it as a short stable code rather than a closed enum.
    drop_reason: z.string().regex(/^[a-z0-9_.:-]{1,64}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict();

export type FunnelCandidatesQueryInput = z.infer<typeof funnelCandidatesQuerySchema>;

/** POST /api/admin/funnel/refresh — bounded trailing window (days). */
export const funnelRefreshSchema = z
  .object({
    window_days: z.number().int().min(1).max(3650).optional().default(30),
  })
  .strict();

export type FunnelRefreshInput = z.infer<typeof funnelRefreshSchema>;
