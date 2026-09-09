/**
 * scorecards.ts — HTTP API for the scorecard domain (Phase 2).
 *
 * Two surfaces:
 *   1. The global metric LIBRARY ("Scorebar") — admin-only CRUD of reusable
 *      metric templates (key/name/description/default_instruction/rubric).
 *   2. Each ROLE's scorecard — a role RBAC surface (interviewer owns their own
 *      role via owner_id, admin sees all) that reads the active immutable
 *      version and creates a NEW immutable version on every save, with the
 *      weight-redistribution preview used by the editing slider.
 *
 * The scorecard tables are service_role-only (0088 RLS denies `authenticated`),
 * so every query goes through the service-role `supabase` client. All
 * cross-field invariants are delegated to the shared domain helpers
 * (`validateRoleMetrics`, `redistributeWeights`, `hashRoleScorecard`,
 * `validateRubric`); the DB CHECK constraints + triggers are the final backstop
 * and their errors are mapped to clean 4xx responses (see `mapWriteError`).
 *
 * IMMUTABILITY: role_scorecard_versions / role_scorecard_version_metrics rows
 * are append-only (0088 BEFORE-UPDATE triggers raise 55000). This router never
 * UPDATEs a version or its metrics — a change always means a brand-new version
 * plus a repoint of roles.active_scorecard_version_id.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams } from '../lib/validation.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { loadActiveRoleScorecard } from '../lib/scorecards/store.js';
import {
  hashRoleScorecard,
  redistributeWeights,
  validateRoleMetrics,
  validateRubric,
  ScorecardValidationError,
} from '../lib/scorecards/domain.js';
import type { RoleScorecardMetric, RoleScorecardVersion } from '../lib/scorecards/contracts.js';
import {
  METRIC_KEY_RE,
  createMetricSchema,
  metricIdParamSchema,
  putRoleScorecardSchema,
  redistributeSchema,
  roleScorecardParamSchema,
  updateMetricSchema,
} from '../schemas/scorecards.js';

export const scorecardsRouter = Router();

const LIBRARY = 'scorecard_metric_library';
const VERSIONS = 'role_scorecard_versions';
const VERSION_METRICS = 'role_scorecard_version_metrics';

// ── Response helpers (shapes mirror lib/validation.ts + routes/rbac.ts) ──

function validationError(res: any, message: string) {
  return res.status(400).json({ error: { type: 'validation_error', message } });
}
function conflict(res: any, message: string) {
  return res.status(409).json({ error: { type: 'conflict', message } });
}
function internalError(res: any) {
  return res.status(500).json({ error: { type: 'internal_error', message: 'Internal server error' } });
}
function forbidden(res: any) {
  return res.status(403).json({ error: { type: 'authorization_error', message: 'Insufficient permissions' } });
}

/**
 * Map a Postgres/PostgREST error from a scorecard write to a clean status.
 *  - 23514 CHECK / weight-trigger / pointer-trigger → 400 (client-fixable)
 *  - 55000 immutability trigger → 409 (never expected from this router)
 *  - 23505 unique violation (e.g. racing version number) → 409 (retryable)
 *  - 23503 FK violation → 400 (unknown role / library metric)
 * Anything else falls through to the global error handler.
 */
function mapWriteError(res: any, next: (e: unknown) => void, err: unknown): void {
  const code = (err as { code?: string } | null)?.code;
  if (code === '23514') {
    validationError(
      res,
      'scorecard rejected by a database invariant (a version must hold 1..20 metrics whose weights total exactly 10000 bps, and the active pointer must belong to the role)',
    );
    return;
  }
  if (code === '55000') {
    conflict(res, 'scorecard configuration versions are immutable');
    return;
  }
  if (code === '23505') {
    conflict(res, 'a concurrent change advanced the scorecard version; reload and retry');
    return;
  }
  if (code === '23503') {
    validationError(res, 'referenced role or library metric does not exist');
    return;
  }
  next(err);
}

/** Derive a stable metric key from a display name, or null if not derivable. */
function deriveKey(name: string): string | null {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const cleaned = slug.replace(/^[^a-z]+/, '').slice(0, 63).replace(/_+$/, '');
  return METRIC_KEY_RE.test(cleaned) ? cleaned : null;
}

// ═══════════════════════════════════════════════════════════════════════
// Metric library — admin only
// ═══════════════════════════════════════════════════════════════════════

// GET /metrics — list non-archived templates, ordered by name.
scorecardsRouter.get('/metrics', requireRole('admin'), async (_req, res, next) => {
  const { data, error } = await supabase
    .from(LIBRARY)
    .select('*')
    .is('archived_at', null)
    .order('name', { ascending: true });
  if (error) return next(error);
  res.json(data ?? []);
});

// POST /metrics — create a template.
scorecardsRouter.post('/metrics', requireRole('admin'), validateBody(createMetricSchema), async (req, res, next) => {
  const body = req.body as import('../schemas/scorecards.js').CreateMetricInput;

  const key = body.key ?? deriveKey(body.name);
  if (!key || !METRIC_KEY_RE.test(key)) {
    return validationError(
      res,
      'could not derive a valid metric key from the name; provide an explicit `key` (^[a-z][a-z0-9_]{1,62}$)',
    );
  }

  let rubric;
  try {
    rubric = validateRubric(body.rubric);
  } catch (err) {
    if (err instanceof ScorecardValidationError) return validationError(res, err.message);
    return next(err);
  }

  const { data, error } = await supabase
    .from(LIBRARY)
    .insert({
      key,
      name: body.name,
      description: body.description ?? null,
      default_instruction: body.default_instruction,
      rubric,
      created_by: req.authUser!.id,
      version: 1,
    })
    .select()
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') return conflict(res, 'a metric with this key already exists');
    return next(error);
  }

  try {
    await recordAudit(req, 'resource.create', 201, { metadata: { metric_id: data.id, metric_key: key } });
  } catch {
    return internalError(res);
  }
  res.status(201).json(data);
});

// PATCH /metrics/:id — edit template fields in place and bump its version.
// Library edits DO NOT touch existing role snapshots: those were copied at
// attach time into role_scorecard_version_metrics and are immutable.
scorecardsRouter.patch(
  '/metrics/:id',
  requireRole('admin'),
  validateParams(metricIdParamSchema),
  validateBody(updateMetricSchema),
  async (req, res, next) => {
    const id = req.params.id;
    const body = req.body as import('../schemas/scorecards.js').UpdateMetricInput;

    const { data: current, error: readErr } = await supabase
      .from(LIBRARY)
      .select('id, version')
      .eq('id', id)
      .maybeSingle();
    if (readErr) return next(readErr);
    if (!current) return res.status(404).json({ error: 'metric_not_found' });

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.default_instruction !== undefined) patch.default_instruction = body.default_instruction;
    if (body.rubric !== undefined) {
      try {
        patch.rubric = validateRubric(body.rubric);
      } catch (err) {
        if (err instanceof ScorecardValidationError) return validationError(res, err.message);
        return next(err);
      }
    }
    patch.version = (current.version ?? 0) + 1;
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from(LIBRARY).update(patch).eq('id', id).select().single();
    if (error) return next(error);

    try {
      await recordAudit(req, 'resource.update', 200, { metadata: { metric_id: id } });
    } catch {
      return internalError(res);
    }
    res.json(data);
  },
);

// POST /metrics/:id/archive — soft-archive a template (never rewrites role
// snapshots; existing role scorecards keep working against their copies).
scorecardsRouter.post(
  '/metrics/:id/archive',
  requireRole('admin'),
  validateParams(metricIdParamSchema),
  async (req, res, next) => {
    const id = req.params.id;
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from(LIBRARY)
      .update({ archived_at: now, updated_at: now })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) return next(error);
    if (!data) return res.status(404).json({ error: 'metric_not_found' });

    try {
      await recordAudit(req, 'resource.update', 200, { metadata: { metric_id: id } });
    } catch {
      return internalError(res);
    }
    res.json(data);
  },
);

// ═══════════════════════════════════════════════════════════════════════
// Role scorecard — interviewer owns own role via owner_id, admin all
// ═══════════════════════════════════════════════════════════════════════

interface RoleAccessRow {
  id: string;
  owner_id: string | null;
  active_scorecard_version_id: string | null;
}

/**
 * Load the role and enforce ownership. Returns the role row, or null after
 * having already responded (404 unknown role, 403 non-owner interviewer, 500
 * on read error). Viewers and admins are never owner-scoped here.
 */
async function loadRoleWithAccess(req: any, res: any): Promise<RoleAccessRow | null> {
  const { data, error } = await supabase
    .from('roles')
    .select('id, owner_id, active_scorecard_version_id')
    .eq('id', req.params.roleId)
    .maybeSingle();
  if (error) {
    internalError(res);
    return null;
  }
  if (!data) {
    res.status(404).json({ error: 'role_not_found' });
    return null;
  }
  if (req.authUser?.appRole === 'interviewer' && data.owner_id !== req.authUser.id) {
    forbidden(res);
    return null;
  }
  return data as RoleAccessRow;
}

// GET /roles/:roleId/scorecard — the active immutable version (or null).
scorecardsRouter.get(
  '/roles/:roleId/scorecard',
  requireRole('viewer'),
  validateParams(roleScorecardParamSchema),
  async (req, res, next) => {
    const role = await loadRoleWithAccess(req, res);
    if (!role) return;
    if (!role.active_scorecard_version_id) return res.json({ scorecard: null });
    try {
      const version = await loadActiveRoleScorecard(supabase, req.params.roleId);
      return res.json({ scorecard: version ?? null });
    } catch (err) {
      return next(err);
    }
  },
);

// PUT /roles/:roleId/scorecard — create a NEW immutable version and repoint.
scorecardsRouter.put(
  '/roles/:roleId/scorecard',
  requireRole('interviewer'),
  validateParams(roleScorecardParamSchema),
  validateBody(putRoleScorecardSchema),
  async (req, res, next) => {
    const role = await loadRoleWithAccess(req, res);
    if (!role) return;
    const roleId = req.params.roleId;
    const input = (req.body as import('../schemas/scorecards.js').PutRoleScorecardInput).metrics;

    // Reject duplicate library references early (the DB also enforces this via
    // uq_role_scorecard_metric_library, but a clear 400 beats a raw 23505).
    const libIds = input.map((m) => m.libraryMetricId);
    if (new Set(libIds).size !== libIds.length) {
      return validationError(res, 'each library metric may appear at most once in a scorecard');
    }

    // Resolve the CURRENT library snapshot (name/key/rubric) for each metric.
    const { data: libRows, error: libErr } = await supabase
      .from(LIBRARY)
      .select('id, key, name, default_instruction, rubric, archived_at')
      .in('id', libIds);
    if (libErr) return next(libErr);
    const libById = new Map((libRows ?? []).map((r: any) => [r.id as string, r]));
    const missing = libIds.filter((id) => !libById.has(id));
    if (missing.length) return validationError(res, `unknown library metric(s): ${missing.join(', ')}`);
    const archived = libIds.filter((id) => libById.get(id)?.archived_at);
    if (archived.length) return validationError(res, `archived library metric(s) cannot be attached: ${archived.join(', ')}`);

    // Build the immutable snapshots. Row ids are generated up front so the
    // stored configuration_hash is reproducible from the stored rows (the
    // domain hash folds each metric's id + libraryMetricId).
    const built: RoleScorecardMetric[] = input.map((m, index) => {
      const lib = libById.get(m.libraryMetricId)!;
      return {
        id: randomUUID(),
        libraryMetricId: lib.id,
        key: lib.key,
        name: lib.name,
        instruction: m.instruction ?? lib.default_instruction,
        rubric: lib.rubric,
        weightBps: m.weightBps,
        displayOrder: m.displayOrder ?? index,
      };
    });

    let ordered: readonly RoleScorecardMetric[];
    let configurationHash: string;
    try {
      ordered = validateRoleMetrics(built); // sum=10000, unique keys/orders, bounds
      configurationHash = hashRoleScorecard(built);
    } catch (err) {
      if (err instanceof ScorecardValidationError) return validationError(res, err.message);
      return next(err);
    }

    // Next version number for this role.
    const { data: maxRow, error: maxErr } = await supabase
      .from(VERSIONS)
      .select('version')
      .eq('role_id', roleId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) return next(maxErr);
    const nextVersion = (maxRow?.version ?? 0) + 1;
    const versionId = randomUUID();

    // (1) Parent version row first (metrics FK to it).
    const { error: vErr } = await supabase.from(VERSIONS).insert({
      id: versionId,
      role_id: roleId,
      version: nextVersion,
      configuration_hash: configurationHash,
      created_by: req.authUser!.id,
    });
    if (vErr) return mapWriteError(res, next, vErr);

    // (2) All metric rows in a SINGLE statement. The exact-weights trigger is
    // AFTER-ROW, but Postgres fires AFTER-ROW triggers only once the whole
    // statement's rows are in place, so the set is validated as a unit (total
    // 10000 bps, 1..20 metrics). Inserting rows one-by-one would trip the
    // trigger on the first partial set — hence the single bulk insert.
    const metricRows = ordered.map((m) => ({
      id: m.id,
      scorecard_version_id: versionId,
      library_metric_id: m.libraryMetricId,
      metric_key: m.key,
      name: m.name,
      instruction: m.instruction,
      rubric: m.rubric,
      weight_bps: m.weightBps,
      display_order: m.displayOrder,
    }));
    const { error: mErr } = await supabase.from(VERSION_METRICS).insert(metricRows);
    if (mErr) return mapWriteError(res, next, mErr);

    // (3) Repoint the role's active version (pointer trigger asserts the
    // version belongs to the role). Owner-scope the update for interviewers.
    let updateQ = supabase.from('roles').update({ active_scorecard_version_id: versionId }).eq('id', roleId);
    if (req.authUser?.appRole === 'interviewer') updateQ = updateQ.eq('owner_id', req.authUser.id);
    const { data: updated, error: uErr } = await updateQ.select('id').maybeSingle();
    if (uErr) return mapWriteError(res, next, uErr);
    if (!updated) return res.status(404).json({ error: 'role_not_found' });

    try {
      await recordAudit(req, 'resource.create', 201, {
        metadata: { role_id: roleId, scorecard_version_id: versionId, version: nextVersion },
      });
    } catch {
      return internalError(res);
    }

    const version: RoleScorecardVersion = {
      id: versionId,
      roleId,
      version: nextVersion,
      configurationHash,
      metrics: ordered,
    };
    res.status(201).json({ scorecard: version });
  },
);

// POST /roles/:roleId/scorecard/redistribute — preview only, no DB write.
// Pure calculator over the client's working set so the slider round-trips the
// exact server math.
scorecardsRouter.post(
  '/roles/:roleId/scorecard/redistribute',
  requireRole('interviewer'),
  validateParams(roleScorecardParamSchema),
  validateBody(redistributeSchema),
  async (req, res, next) => {
    const role = await loadRoleWithAccess(req, res);
    if (!role) return;
    const { metrics, editedMetricId, newWeightBps } = req.body as import('../schemas/scorecards.js').RedistributeInput;
    try {
      const result = redistributeWeights(metrics as unknown as RoleScorecardMetric[], editedMetricId, newWeightBps);
      return res.json({ metrics: result });
    } catch (err) {
      if (err instanceof ScorecardValidationError) return validationError(res, err.message);
      return next(err);
    }
  },
);
