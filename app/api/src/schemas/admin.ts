import { z } from 'zod';
import { uuidSchema } from './common.js';

/** Path param schema for PATCH /api/admin/members/:userId */
export const adminUserIdParamSchema = z.object({ userId: uuidSchema }).strict();

/** Path param schema for POST /api/admin/sessions/:sessionId/override */
export const adminSessionIdParamSchema = z.object({ sessionId: uuidSchema }).strict();

/** Path param schema for PATCH /api/admin/quotas/:id */
export const adminQuotaIdParamSchema = z.object({ id: uuidSchema }).strict();

/**
 * GET /api/admin/audit query — bounded pagination only. offset is bounded
 * so a page depth cannot exceed a safe window (fail closed on abuse).
 */
export const adminAuditListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(100),
    offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict();

export type AdminAuditListQueryInput = z.infer<typeof adminAuditListQuerySchema>;

/** Known session lifecycle statuses for the admin session view filter. */
export const ADMIN_SESSION_STATUSES = [
  'created',
  'waiting',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'abandoned',
] as const;

/** GET /api/admin/sessions query — optional status filter + bounded pagination. */
export const adminSessionListQuerySchema = z
  .object({
    status: z.enum(ADMIN_SESSION_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(100),
    offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict();

export type AdminSessionListQueryInput = z.infer<typeof adminSessionListQuerySchema>;

/** GET /api/admin/quotas — bounded pagination. */
export const adminQuotaListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(100),
    offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict();

export type AdminQuotaListQueryInput = z.infer<typeof adminQuotaListQuerySchema>;

/**
 * POST /api/admin/quotas body — bounded, fail-closed. Cost units are
 * ABSTRACT admin integers (never currency/price); warning_percentage is
 * nullable with no default (null → no warning).
 */
export const adminQuotaUpsertSchema = z
  .object({
    scope: z.enum(['global', 'recruiter']),
    scope_id: uuidSchema.nullable().optional(),
    mode: z.enum(['simulation', 'live']).optional().default('simulation'),
    max_sessions: z.number().int().positive().max(1_000_000).nullable().optional(),
    max_cost_units: z.number().int().positive().max(1_000_000_000).nullable().optional(),
    cost_units_per_session: z.number().int().positive().max(1_000_000).nullable().optional(),
    warning_percentage: z.number().int().min(1).max(100).nullable().optional(),
    period_days: z.number().int().min(1).max(365).optional().default(1),
    enabled: z.boolean().optional().default(false),
  })
  .strict()
  .refine((v) => (v.scope === 'global' ? v.scope_id == null : v.scope_id != null), {
    message: 'global policies must have no scope_id; recruiter policies require one',
    path: ['scope_id'],
  });

export type AdminQuotaUpsertInput = z.infer<typeof adminQuotaUpsertSchema>;

/**
 * PATCH /api/admin/members/:userId body.
 * At least one of role/active is required; both are bounded.
 */
export const adminMemberUpdateSchema = z
  .object({
    role: z.enum(['admin', 'interviewer', 'viewer']).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.active !== undefined, {
    message: 'at least one of role or active is required',
  });

export type AdminMemberUpdateInput = z.infer<typeof adminMemberUpdateSchema>;

/** Bounded target statuses for the admin session override (no resurrection of terminal states). */
export const ADMIN_OVERRIDE_TARGET_STATUSES = [
  'created',
  'waiting',
  'in_progress',
  'failed',
  'cancelled',
  'completed',
] as const;

/** POST /api/admin/sessions/:sessionId/override body — bounded CAS with reason. */
export const adminSessionOverrideSchema = z
  .object({
    target_status: z.enum(ADMIN_OVERRIDE_TARGET_STATUSES),
    reason: z.string().trim().min(1, 'reason is required').max(200, 'reason must be at most 200 characters'),
  })
  .strict();

export type AdminSessionOverrideInput = z.infer<typeof adminSessionOverrideSchema>;

/** POST /api/admin/maintenance body — bounded toggle + reason. */
export const adminMaintenanceSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().trim().min(1, 'reason is required').max(200, 'reason must be at most 200 characters'),
  })
  .strict();

export type AdminMaintenanceInput = z.infer<typeof adminMaintenanceSchema>;
