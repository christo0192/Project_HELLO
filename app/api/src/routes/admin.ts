/**
 * Phase 9 L2 — admin operations (members / maintenance / session override).
 *
 * Invariant 7: `/api/admin/*` require admin at the router boundary.
 * Membership list returns EXACTLY opaque user_id + role + active — no email,
 * no auth.users join.
 *
 * Invariant 8: session override is a bounded CAS with stable errors; no
 * arbitrary state resurrection (failed/cancelled/expired/deleted cannot be
 * resurrected — enforced in the RPC). Audit rows are written by the RPCs in
 * the SAME transaction as the mutation (service-role-only SECURITY DEFINER).
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAdmin } from '../lib/rbac.js';
import { validateBody, validateParams, validateQuery } from '../lib/validation.js';
import {
  adminAllowlistAddSchema,
  adminAllowlistIdParamSchema,
  adminAllowlistUpdateSchema,
  adminAuditListQuerySchema,
  adminMaintenanceSchema,
  adminMemberUpdateSchema,
  adminQuotaIdParamSchema,
  adminQuotaListQuerySchema,
  adminQuotaUpsertSchema,
  adminSessionIdParamSchema,
  adminSessionListQuerySchema,
  adminSessionOverrideSchema,
  adminUserIdParamSchema,
} from '../schemas/admin.js';

export const adminRouter = Router();

// ── Admin boundary: every route below requires role=admin ─────────────
adminRouter.use(requireAdmin);

/**
 * GET /api/admin/audit
 * Bounded, redacted audit list. Returns ONLY allowlisted/minimized fields
 * from audit_events: id, action, actor_type, actor_id (opaque), target_type,
 * target_id (opaque), result, created_at. Never metadata, source_ip,
 * correlation ids, contact data, transcript/resume text, token/digest, or
 * error details — minimization by construction (explicit column selection).
 */
adminRouter.get('/audit', validateQuery(adminAuditListQuerySchema), async (req, res, next) => {
  try {
    const limit = req.query.limit as unknown as number;
    const offset = req.query.offset as unknown as number;
    const { data, error } = await supabase
      .from('audit_events')
      .select('id, action, actor_type, actor_id, target_type, target_id, result, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return next(new Error('failed to list audit events'));

    const audit = (data ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      target_type: r.target_type,
      target_id: r.target_id,
      result: r.result,
      created_at: r.created_at,
    }));
    res.json({ audit });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/sessions
 * Bounded admin session view with optional status filter. Returns ONLY
 * id, opaque candidate_id/role_id, status, created_at, started_at, ended_at.
 * No candidate name/email/phone/resume/transcript/recording/object key/
 * model/provider/raw error.
 */
adminRouter.get('/sessions', validateQuery(adminSessionListQuerySchema), async (req, res, next) => {
  try {
    const limit = req.query.limit as unknown as number;
    const offset = req.query.offset as unknown as number;
    let q = supabase
      .from('call_sessions')
      .select('id, candidate_id, role_id, status, created_at, started_at, ended_at')
      .order('created_at', { ascending: false });
    if (req.query.status) {
      q = q.eq('status', req.query.status as string);
    }
    const { data, error } = await q.range(offset, offset + limit - 1);
    if (error) return next(new Error('failed to list sessions'));

    const sessions = (data ?? []).map((r) => ({
      id: r.id,
      candidate_id: r.candidate_id,
      role_id: r.role_id,
      status: r.status,
      created_at: r.created_at,
      started_at: r.started_at,
      ended_at: r.ended_at,
    }));
    res.json({ sessions });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/quotas
 * Bounded quota-policy list. Policy fields only — no usage/price/currency.
 */
adminRouter.get('/quotas', validateQuery(adminQuotaListQuerySchema), async (req, res, next) => {
  try {
    const limit = req.query.limit as unknown as number;
    const offset = req.query.offset as unknown as number;
    const { data, error } = await supabase
      .from('quota_policies')
      .select(
        'id, scope, scope_id, mode, max_sessions, max_cost_units, cost_units_per_session, warning_percentage, period_days, enabled, created_at, updated_at',
      )
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) return next(new Error('failed to list quota policies'));
    // Minimization by construction — never pass through unselected columns
    // (no price/currency/usage can ever reach the response).
    const policies = (data ?? []).map((r) => ({
      id: r.id,
      scope: r.scope,
      scope_id: r.scope_id,
      mode: r.mode,
      max_sessions: r.max_sessions,
      max_cost_units: r.max_cost_units,
      cost_units_per_session: r.cost_units_per_session,
      warning_percentage: r.warning_percentage,
      period_days: r.period_days,
      enabled: r.enabled === true,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({ policies });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/quotas
 * Create a quota policy via the atomic upsert_quota_policy RPC (quota_override
 * audit row in the same transaction). Stable statuses: 201 ok, 400 invalid_*.
 * Actor id is derived from auth — never accepted from the client.
 */
adminRouter.post('/quotas', validateBody(adminQuotaUpsertSchema), async (req, res, next) => {
  try {
    const { data, error } = await supabase.rpc('upsert_quota_policy', {
      p_policy_id: null,
      p_scope: req.body.scope,
      p_scope_id: req.body.scope_id ?? null,
      p_mode: req.body.mode ?? 'simulation',
      p_max_sessions: req.body.max_sessions ?? null,
      p_max_cost_units: req.body.max_cost_units ?? null,
      p_cost_units_per_session: req.body.cost_units_per_session ?? null,
      p_warning_percentage: req.body.warning_percentage ?? null,
      p_period_days: req.body.period_days ?? 1,
      p_enabled: req.body.enabled ?? false,
      p_actor_id: req.authUser?.id ?? null,
    });
    if (error) return next(new Error('failed to create quota policy'));

    const status = (data as { status?: string } | null)?.status;
    if (status === 'ok') {
      const id = (data as { id?: string } | null)?.id;
      return res.status(201).json({ ok: true, id, created: true });
    }
    return res.status(400).json({ error: status ?? 'invalid_quota_policy' });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/quotas/:id
 * Update a quota policy via the atomic upsert RPC (quota_override audit row).
 * Stable statuses: 200 ok, 404 policy_not_found, 400 invalid_*.
 */
adminRouter.patch(
  '/quotas/:id',
  validateParams(adminQuotaIdParamSchema),
  validateBody(adminQuotaUpsertSchema),
  async (req, res, next) => {
    try {
      const policyId = req.params.id as string;
      const { data, error } = await supabase.rpc('upsert_quota_policy', {
        p_policy_id: policyId,
        p_scope: req.body.scope,
        p_scope_id: req.body.scope_id ?? null,
        p_mode: req.body.mode ?? 'simulation',
        p_max_sessions: req.body.max_sessions ?? null,
        p_max_cost_units: req.body.max_cost_units ?? null,
        p_cost_units_per_session: req.body.cost_units_per_session ?? null,
        p_warning_percentage: req.body.warning_percentage ?? null,
        p_period_days: req.body.period_days ?? 1,
        p_enabled: req.body.enabled ?? false,
        p_actor_id: req.authUser?.id ?? null,
      });
      if (error) return next(new Error('failed to update quota policy'));

      const status = (data as { status?: string } | null)?.status;
      if (status === 'ok') return res.json({ ok: true, id: policyId });
      if (status === 'not_found') return res.status(404).json({ error: 'policy_not_found' });
      return res.status(400).json({ error: status ?? 'invalid_quota_policy' });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/members
 * Returns [{ user_id, role, active }] ONLY — opaque identifiers, no email,
 * no auth.users join, no PII.
 */
adminRouter.get('/members', async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('recruiter_memberships')
      .select('user_id, role, active')
      .order('role', { ascending: true });
    if (error) return next(new Error('failed to list members'));
    const members = (data ?? []).map((m) => ({
      user_id: m.user_id,
      role: m.role,
      active: m.active === true,
    }));
    res.json(members);
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/members/:userId
 * Atomic last-admin-safe membership mutation via the update_membership RPC.
 * Stable errors: 404 member_not_found, 409 last_active_admin,
 * 409 self_modification_denied, 400 invalid_role / no_changes.
 */
adminRouter.patch(
  '/members/:userId',
  validateParams(adminUserIdParamSchema),
  validateBody(adminMemberUpdateSchema),
  async (req, res, next) => {
    try {
      const userId = req.params.userId as string;
      const { data, error } = await supabase.rpc('update_membership', {
        p_user_id: userId,
        p_role: req.body.role ?? null,
        p_active: req.body.active ?? null,
        p_actor_id: req.authUser?.id ?? null,
      });
      if (error) return next(new Error('failed to update membership'));

      const status = (data as { status?: string } | null)?.status;
      switch (status) {
        case 'ok':
          return res.json({ ok: true });
        case 'not_found':
          return res.status(404).json({ error: 'member_not_found' });
        case 'last_active_admin':
          return res.status(409).json({ error: 'last_active_admin' });
        case 'self_modification_denied':
          return res.status(409).json({ error: 'self_modification_denied' });
        case 'invalid_role':
          return res.status(400).json({ error: 'invalid_role' });
        case 'no_changes':
          return res.status(400).json({ error: 'no_changes' });
        default:
          return next(new Error('membership update failed'));
      }
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/admin/maintenance
 * Atomic maintenance toggle + audit via the toggle_maintenance RPC
 * (system_config key='maintenance'). Stable errors: 400 invalid_reason.
 */
adminRouter.post(
  '/maintenance',
  validateBody(adminMaintenanceSchema),
  async (req, res, next) => {
    try {
      const { data, error } = await supabase.rpc('toggle_maintenance', {
        p_enabled: req.body.enabled,
        p_reason: req.body.reason,
        p_actor_id: req.authUser?.id ?? null,
      });
      if (error) return next(new Error('failed to toggle maintenance'));

      const status = (data as { status?: string } | null)?.status;
      switch (status) {
        case 'ok': {
          const enabled = (data as { enabled?: boolean } | null)?.enabled === true;
          return res.json({ ok: true, enabled });
        }
        case 'invalid_reason':
          return res.status(400).json({ error: 'invalid_reason' });
        default:
          return next(new Error('maintenance toggle failed'));
      }
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/admin/sessions/:sessionId/override
 * Bounded CAS session override via the override_admin_session RPC.
 * Stable errors: 404 session_not_found, 409 resurrection_denied /
 * deleted_denied, 400 invalid_target / invalid_reason. No arbitrary state
 * resurrection — failed/cancelled/expired/deleted sessions are immutable.
 */
adminRouter.post(
  '/sessions/:sessionId/override',
  validateParams(adminSessionIdParamSchema),
  validateBody(adminSessionOverrideSchema),
  async (req, res, next) => {
    try {
      const sessionId = req.params.sessionId as string;
      const { data, error } = await supabase.rpc('override_admin_session', {
        p_session_id: sessionId,
        p_target_status: req.body.target_status,
        p_reason: req.body.reason,
        p_actor_id: req.authUser?.id ?? null,
      });
      if (error) return next(new Error('failed to override session'));

      const record = data as { status?: string; prior_status?: string } | null;
      const status = record?.status;
      switch (status) {
        case 'ok':
          return res.json({ ok: true, prior_status: record?.prior_status ?? null });
        case 'no_op':
          return res.json({ ok: true, prior_status: record?.prior_status ?? null });
        case 'session_not_found':
          return res.status(404).json({ error: 'session_not_found' });
        case 'resurrection_denied':
          return res.status(409).json({ error: 'resurrection_denied' });
        case 'deleted_denied':
          return res.status(409).json({ error: 'deleted_denied' });
        case 'invalid_target':
          return res.status(400).json({ error: 'invalid_target' });
        case 'invalid_reason':
          return res.status(400).json({ error: 'invalid_reason' });
        default:
          return next(new Error('session override failed'));
      }
    } catch (error) {
      next(error);
    }
  },
);

// ════════════════════════════════════════════════════════════════════
//  HELLO access allowlist (0016) — admin management of the normalized-
//  email access gate. Every mutation is audited atomically inside its RPC;
//  audit metadata never contains the full email (SHA-256 digest only).
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/allowlist
 * Admin-only list of allowlist entries: id, email, role, active,
 * linked_user_id, linked_at. Emails are shown to admins (management
 * surface); they never reach audit metadata or non-admin responses.
 */
adminRouter.get('/allowlist', async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('email_allowlist')
      .select('id, email, role, active, linked_user_id, linked_at, created_at')
      .order('created_at', { ascending: true });
    if (error) return next(new Error('failed to list allowlist'));

    const entries = (data ?? []).map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      active: r.active === true,
      linked_user_id: r.linked_user_id ?? null,
      linked_at: r.linked_at ?? null,
    }));
    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/allowlist
 * Add an allowlist entry via the atomic add_allowlist_entry RPC (audit row
 * in the same transaction). Normalization happens server-side identically
 * to the resolver; duplicate case/whitespace variants are rejected.
 * Stable statuses: 201 ok, 400 invalid_email / invalid_role, 409 duplicate.
 * Actor id is derived from auth — never accepted from the client.
 */
adminRouter.post(
  '/allowlist',
  validateBody(adminAllowlistAddSchema),
  async (req, res, next) => {
    try {
      const { data, error } = await supabase.rpc('add_allowlist_entry', {
        p_email: req.body.email,
        p_role: req.body.role ?? 'viewer',
        p_actor_id: req.authUser?.id ?? null,
      });
      if (error) return next(new Error('failed to add allowlist entry'));

      const record = data as { status?: string; id?: string } | null;
      const status = record?.status;
      switch (status) {
        case 'ok':
          return res.status(201).json({ ok: true, id: record?.id ?? null });
        case 'invalid_email':
          return res.status(400).json({ error: 'invalid_email' });
        case 'invalid_role':
          return res.status(400).json({ error: 'invalid_role' });
        case 'duplicate':
          return res.status(409).json({ error: 'duplicate' });
        default:
          return next(new Error('allowlist add failed'));
      }
    } catch (error) {
      next(error);
    }
  },
);

/**
 * PATCH /api/admin/allowlist/:id
 * Update/disable/demote an allowlist entry via the atomic
 * update_allowlist_entry RPC (audit row in the same transaction).
 * Stable errors: 404 not_found, 409 self_modification_denied /
 * last_linked_active_admin, 400 invalid_role / no_changes.
 * Role/active changes propagate to the linked membership row atomically.
 */
adminRouter.patch(
  '/allowlist/:id',
  validateParams(adminAllowlistIdParamSchema),
  validateBody(adminAllowlistUpdateSchema),
  async (req, res, next) => {
    try {
      const entryId = req.params.id as string;
      const { data, error } = await supabase.rpc('update_allowlist_entry', {
        p_entry_id: entryId,
        p_role: req.body.role ?? null,
        p_active: req.body.active ?? null,
        p_actor_id: req.authUser?.id ?? null,
      });
      if (error) return next(new Error('failed to update allowlist entry'));

      const status = (data as { status?: string } | null)?.status;
      switch (status) {
        case 'ok':
          return res.json({ ok: true });
        case 'not_found':
          return res.status(404).json({ error: 'not_found' });
        case 'self_modification_denied':
          return res.status(409).json({ error: 'self_modification_denied' });
        case 'last_linked_active_admin':
          return res.status(409).json({ error: 'last_linked_active_admin' });
        case 'invalid_role':
          return res.status(400).json({ error: 'invalid_role' });
        case 'no_changes':
          return res.status(400).json({ error: 'no_changes' });
        default:
          return next(new Error('allowlist update failed'));
      }
    } catch (error) {
      next(error);
    }
  },
);
