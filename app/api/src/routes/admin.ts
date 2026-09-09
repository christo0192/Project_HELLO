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
import {
  funnelCandidatesQuerySchema,
  funnelFailuresQuerySchema,
  funnelRefreshSchema,
  funnelSummaryQuerySchema,
} from '../schemas/funnel.js';

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
      .select('id, candidate_id, role_id, status, updated_at, started_at, ended_at')
      .order('updated_at', { ascending: false });
    if (req.query.status) {
      q = q.eq('status', req.query.status as string);
    }
    const { data, error } = await q.range(offset, offset + limit - 1);
    if (error) return next(new Error('failed to list sessions'));

    const sessions = (data ?? []).map((r) => {
      const row = r as typeof r & { created_at?: string | null };
      return {
        id: row.id,
        candidate_id: row.candidate_id,
        role_id: row.role_id,
        status: row.status,
        created_at: row.updated_at ?? row.created_at,
        started_at: row.started_at,
        ended_at: row.ended_at,
      };
    });
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

// ════════════════════════════════════════════════════════════════════
//  Funnel observability (0090) — read the DERIVED funnel views + stored
//  rollup. Counts, sanitized codes and opaque ids only (the views/rollup
//  carry no PII by construction). Admin-gated at the router boundary above.
// ════════════════════════════════════════════════════════════════════

const FUNNEL_COUNT_FIELDS = [
  'entered_parse', 'parsed_ok', 'needs_review', 'parse_failed',
  'dialed', 'connected', 'consent_passed', 'consent_dropped', 'answered_ge1',
  'scored', 'qualified', 'on_hold', 'disqualified', 'human_review', 'reached_reference_check',
  'attempts_total', 'connects_total', 'total_call_seconds',
] as const;

/** YYYY-MM-DD `days` before today (UTC). */
function funnelDayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD `days` before the given YYYY-MM-DD (UTC). */
function funnelDayBefore(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// Defense-in-depth cap on the queryable span, so a hand-crafted from/to cannot
// pull the whole rollup / failure history in one admin call.
const FUNNEL_MAX_SPAN_DAYS = 400;

/**
 * GET /api/admin/funnel/summary
 * Topline funnel over a date window (default trailing 30d) read from the
 * stored funnel_stage_daily rollup: summed totals, derived stage-to-stage
 * conversion ratios, and the per-day series (with timing percentiles) for
 * trend charts. Empty when the rollup has not been refreshed yet — POST
 * /funnel/refresh (or the refresh loop) populates it.
 */
adminRouter.get('/funnel/summary', validateQuery(funnelSummaryQuerySchema), async (req, res, next) => {
  try {
    const to = (req.query.to as string | undefined) ?? funnelDayOffset(0);
    const requestedFrom = (req.query.from as string | undefined) ?? funnelDayOffset(29);
    const minFrom = funnelDayBefore(to, FUNNEL_MAX_SPAN_DAYS);
    const from = requestedFrom < minFrom ? minFrom : requestedFrom;
    const roleId = req.query.role_id as string | undefined;

    let q = supabase
      .from('funnel_stage_daily')
      .select(
        'cohort_day, role_id, entered_parse, parsed_ok, needs_review, parse_failed, dialed, connected, consent_passed, consent_dropped, answered_ge1, scored, qualified, on_hold, disqualified, human_review, reached_reference_check, attempts_total, connects_total, total_call_seconds, median_ttfc_sec, p95_ttfc_sec, refreshed_at',
      )
      .gte('cohort_day', from)
      .lte('cohort_day', to)
      .order('cohort_day', { ascending: true });
    if (roleId) q = q.eq('role_id', roleId);
    const { data, error } = await q;
    if (error) return next(new Error('failed to load funnel summary'));

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const totals: Record<string, number> = {};
    for (const f of FUNNEL_COUNT_FIELDS) totals[f] = 0;
    let refreshedAt: string | null = null;
    for (const r of rows) {
      for (const f of FUNNEL_COUNT_FIELDS) totals[f] += Number(r[f] ?? 0);
      const ra = r.refreshed_at as string | null | undefined;
      if (ra && (!refreshedAt || ra > refreshedAt)) refreshedAt = ra;
    }
    const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
    const conversions = {
      parse_to_dial: ratio(totals.dialed, totals.parsed_ok),
      dial_to_connect: ratio(totals.connected, totals.dialed),
      connect_to_consent: ratio(totals.consent_passed, totals.connected),
      consent_to_answered: ratio(totals.answered_ge1, totals.consent_passed),
      answered_to_scored: ratio(totals.scored, totals.answered_ge1),
      scored_to_qualified: ratio(totals.qualified, totals.scored),
      qualified_to_reference_check: ratio(totals.reached_reference_check, totals.qualified),
    };
    // Aggregate the per-(day, role) rollup rows into a per-DAY trend, summing
    // across roles when no role filter is applied, so a day is never
    // double-plotted. Percentiles cannot be summed across roles, so they are
    // carried only when a single row contributes to the day.
    const byDay = new Map<string, Record<string, unknown> & { __n: number }>();
    for (const r of rows) {
      const day = r.cohort_day as string;
      let agg = byDay.get(day);
      if (!agg) {
        agg = {
          cohort_day: day,
          role_id: null,
          median_ttfc_sec: (r.median_ttfc_sec as number | null) ?? null,
          p95_ttfc_sec: (r.p95_ttfc_sec as number | null) ?? null,
          __n: 0,
        };
        for (const f of FUNNEL_COUNT_FIELDS) agg[f] = 0;
        byDay.set(day, agg);
      }
      for (const f of FUNNEL_COUNT_FIELDS) (agg[f] as number) += Number(r[f] ?? 0);
      agg.__n += 1;
      if (agg.__n > 1) {
        agg.median_ttfc_sec = null;
        agg.p95_ttfc_sec = null;
      }
    }
    const series = [...byDay.values()]
      .sort((a, b) => ((a.cohort_day as string) < (b.cohort_day as string) ? -1 : 1))
      .map(({ __n: _n, ...row }) => row);
    res.json({ range: { from, to }, totals, conversions, series, refreshed_at: refreshedAt });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/funnel/failures
 * The unified failure taxonomy (v_funnel_failures) over an optional window +
 * stage filter: `groups` are {stage, code, count} over the returned window
 * (bounded), and `recent` is the newest-first list capped at `limit`.
 */
adminRouter.get('/funnel/failures', validateQuery(funnelFailuresQuerySchema), async (req, res, next) => {
  try {
    const limit = req.query.limit as unknown as number;
    const stage = req.query.stage as string | undefined;
    // ALWAYS bound the window (default trailing 30d, span-capped), like
    // /summary. Without a default the UI's no-arg call groups over ALL-TIME
    // rows capped at FETCH_CAP, silently biasing every count toward recent
    // failures and presenting a partial count as authoritative.
    const to = (req.query.to as string | undefined) ?? funnelDayOffset(0);
    const requestedFrom = (req.query.from as string | undefined) ?? funnelDayOffset(29);
    const minFrom = funnelDayBefore(to, FUNNEL_MAX_SPAN_DAYS);
    const from = requestedFrom < minFrom ? minFrom : requestedFrom;

    const FETCH_CAP = 1000;
    let q = supabase
      .from('v_funnel_failures')
      .select('stage, code, entity_id, occurred_at')
      .gte('occurred_at', from)
      .lte('occurred_at', `${to}T23:59:59.999Z`)
      .order('occurred_at', { ascending: false });
    if (stage) q = q.eq('stage', stage);
    const { data, error } = await q.limit(FETCH_CAP);
    if (error) return next(new Error('failed to load funnel failures'));

    const all = (data ?? []) as Array<{ stage: string; code: string; entity_id: string; occurred_at: string }>;
    const map = new Map<string, { stage: string; code: string; count: number }>();
    for (const r of all) {
      const key = `${r.stage}|${r.code}`;
      const g = map.get(key) ?? { stage: r.stage, code: r.code, count: 0 };
      g.count += 1;
      map.set(key, g);
    }
    const groups = [...map.values()].sort((a, b) => b.count - a.count);
    // `truncated` = the window still held >= FETCH_CAP failures, so `groups`
    // counts the newest FETCH_CAP only and undercounts — surfaced so the UI
    // never presents a partial count as authoritative.
    const truncated = all.length >= FETCH_CAP;
    res.json({ groups, recent: all.slice(0, limit), truncated, range: { from, to } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/funnel/candidates
 * Paginated per-candidate drill-down (v_funnel_candidate), newest intake
 * first, with optional role / furthest_stage / drop_reason filters. Opaque
 * ids + stage flags only — no name/email/phone/transcript.
 */
adminRouter.get('/funnel/candidates', validateQuery(funnelCandidatesQuerySchema), async (req, res, next) => {
  try {
    const limit = req.query.limit as unknown as number;
    const offset = req.query.offset as unknown as number;
    let q = supabase
      .from('v_funnel_candidate')
      .select(
        'candidate_id, role_id, role_title, resume_role_class, intake_at, furthest_stage, drop_reason, missing_phone, dialed, connected, consent_passed, answered_questions, attempts_total, connects_total, recommendation, scoring_status, reached_reference_check',
      )
      .order('intake_at', { ascending: false });
    if (req.query.role_id) q = q.eq('role_id', req.query.role_id as string);
    if (req.query.furthest_stage) q = q.eq('furthest_stage', req.query.furthest_stage as string);
    if (req.query.drop_reason) q = q.eq('drop_reason', req.query.drop_reason as string);
    const { data, error } = await q.range(offset, offset + limit - 1);
    if (error) return next(new Error('failed to load funnel candidates'));
    res.json({ candidates: data ?? [], limit, offset });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/funnel/refresh
 * Trigger an on-demand recompute of funnel_stage_daily (the same
 * advisory-locked, idempotent RPC the refresh loop calls). Lets an admin
 * populate/refresh the rollup even when FUNNEL_OBSERVABILITY_ENABLED is off.
 */
adminRouter.post('/funnel/refresh', validateBody(funnelRefreshSchema), async (req, res, next) => {
  try {
    const { data, error } = await supabase.rpc('refresh_funnel_rollup', {
      p_window_days: req.body.window_days,
    });
    if (error) return next(new Error('failed to refresh funnel rollup'));
    res.json({ ok: true, result: data });
  } catch (error) {
    next(error);
  }
});
