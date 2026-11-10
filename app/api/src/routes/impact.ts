/**
 * routes/impact.ts — the business-impact page's API (M031 S5).
 *
 *   GET /api/impact/summary                 interviewer and up: the page's aggregates
 *   GET /api/impact/candidates              interviewer and up: the applications behind
 *                                           one figure, scoped like the candidate page
 *   GET /api/impact/exclusions              admin: every mapping and whether it counts
 *   PUT /api/impact/exclusions/:mappingId   admin: leave a mapping out, keep an archived
 *                                           one in, or go back to the default
 *
 * Contract: `.gsd/milestones/M031/API-CONTRACT.md`. Errors are
 * `{ ok: false, error }`: 400 `invalid_filter`, 403 `forbidden`, 503
 * `impact_unavailable` (and 404 `not_found` for an unknown mapping).
 *
 * WHO SEES WHAT. The aggregates are counts with no personal data, so every
 * staff role from interviewer up gets them (D-M031-3). The candidate list
 * follows the candidate page's own rule exactly (lib/candidate-scope.ts,
 * D-M031-5): an interviewer is listed only the candidates they own, a role
 * that opens every candidate is listed all. What the viewer cannot open is
 * never sent, not even as an id; `hidden` counts it so total + hidden is the
 * figure. The rule is applied in the database (impact_candidates), and the
 * shaper refuses a row with no candidate for anyone who is not scoped to all.
 *
 * AUDIT. One row per call with the filter and counts, never a name. The list's
 * row is fail-closed: if it cannot be written, no name leaves (503).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { hasRoleAtLeast, type AppRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { createLogger } from '../lib/logger.js';
import { candidateScope } from '../lib/candidate-scope.js';
import {
  IMPACT_DEFAULT_PAGE_SIZE,
  createSupabaseImpactStore,
  impactProgressEnabled,
  shapeImpactCandidates,
  shapeImpactMappingSettings,
  shapeImpactSummary,
  type ImpactListTarget,
  type ImpactStore,
} from '../lib/impact.js';
import {
  impactCandidatesQuerySchema,
  impactExclusionBodySchema,
  impactExclusionParamsSchema,
  impactSummaryQuerySchema,
} from '../schemas/impact.js';

const impactLogger = createLogger('impact');

export interface ImpactRouterDeps {
  /** The database functions (tests inject one). Production calls 0140 through the service-role client. */
  store?: ImpactStore;
  /** ASHBY_PROGRESS_ENABLED, read per request so a flag flip needs no restart of this module. */
  progressEnabled?: () => boolean;
  /** The clock (tests pin it). */
  now?: () => Date;
}

type ErrorCode = 'invalid_filter' | 'forbidden' | 'impact_unavailable' | 'not_found';

function fail(res: Response, status: number, error: ErrorCode): void {
  res.status(status).json({ ok: false, error });
}

/** The contract's 403 body, with requireRole's comparison. */
function atLeast(minRole: AppRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser || !hasRoleAtLeast(req.authUser.appRole, minRole)) {
      fail(res, 403, 'forbidden');
      return;
    }
    next();
  };
}

/** Each statement the database refuses as a filter is the caller's 400; anything else is ours. */
function isFilterRefusal(status: unknown): boolean {
  return status === 'invalid_filter' || status === 'unknown_job';
}

export function createImpactRouter(deps: ImpactRouterDeps = {}): Router {
  const router = Router();
  let lazyStore: ImpactStore | null = deps.store ?? null;
  const store = (): ImpactStore => {
    lazyStore ??= createSupabaseImpactStore(supabase as never);
    return lazyStore;
  };
  const progressEnabled = deps.progressEnabled ?? (() => impactProgressEnabled());
  const now = deps.now ?? (() => new Date());

  router.get('/summary', atLeast('interviewer'), async (req: Request, res: Response) => {
    const parsed = impactSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) { fail(res, 400, 'invalid_filter'); return; }
    const q = parsed.data;
    const enabled = progressEnabled();
    let body;
    try {
      const answer = await store().summary({ from: q.from ?? null, to: q.to ?? null, job: q.job ?? null }, enabled, now());
      if (isFilterRefusal(answer.status)) { fail(res, 400, 'invalid_filter'); return; }
      if (answer.status !== 'ok') throw new Error('impact_summary_refused');
      body = shapeImpactSummary(answer.summary);
    } catch (err) {
      impactLogger.error('error_unhandled', { error_type: err instanceof Error ? err.name : 'unknown', phase: 'summary' });
      fail(res, 503, 'impact_unavailable');
      return;
    }
    // Filter and counts only: dates, the mapping id, and how much is known.
    await recordAudit(req, 'resource.read', 200, {
      metadata: {
        resource: 'impact_summary',
        ...(q.job ? { job_mapping_id: q.job } : {}),
        from: body.filters.from,
        to: body.filters.to,
        progress_enabled: body.meta.progressEnabled,
        came_in: body.pipeline[0]?.reached ?? null,
        coverage_checked: body.meta.coverage.checked,
        coverage_total: body.meta.coverage.total,
      },
    });
    res.json({ ok: true, ...body });
  });

  router.get('/candidates', atLeast('interviewer'), async (req: Request, res: Response) => {
    const parsed = impactCandidatesQuerySchema.safeParse(req.query);
    if (!parsed.success) { fail(res, 400, 'invalid_filter'); return; }
    const q = parsed.data;
    const target: ImpactListTarget = q.step !== undefined
      ? { kind: 'step', step: q.step, dropped: q.dropped === 'true' }
      : q.verdict !== undefined && q.outcome !== undefined
        ? { kind: 'verdict', verdict: q.verdict, outcome: q.outcome }
        : { kind: 'leave', stageId: q.leaveStageId as string };
    // The candidate page's rule (GET /api/candidates/:id), never restated here.
    const scope = candidateScope(req.authUser);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? IMPACT_DEFAULT_PAGE_SIZE;
    let body;
    try {
      const answer = await store().candidates(
        { from: q.from ?? null, to: q.to ?? null, job: q.job ?? null, target, scope, page, pageSize },
        progressEnabled(),
        now(),
      );
      if (isFilterRefusal(answer.status)) { fail(res, 400, 'invalid_filter'); return; }
      if (answer.status !== 'ok') throw new Error('impact_candidates_refused');
      body = shapeImpactCandidates(answer, scope.kind === 'all');
    } catch (err) {
      impactLogger.error('error_unhandled', { error_type: err instanceof Error ? err.name : 'unknown', phase: 'candidates' });
      fail(res, 503, 'impact_unavailable');
      return;
    }
    // Who asked (the audit row's actor), the filter and the counts. No name, no candidate id.
    try {
      await recordAudit(req, 'resource.list', 200, {
        failClosed: true,
        metadata: {
          resource: 'impact_candidates',
          ...(q.job ? { job_mapping_id: q.job } : {}),
          ...(q.from ? { from: q.from } : {}),
          ...(q.to ? { to: q.to } : {}),
          ...(target.kind === 'step' ? { step: target.step, dropped: target.dropped } : {}),
          ...(target.kind === 'verdict' ? { verdict: target.verdict, outcome: target.outcome } : {}),
          ...(target.kind === 'leave' ? { leave_stage_id: target.stageId } : {}),
          scope: scope.kind,
          page: body.page,
          page_size: body.pageSize,
          total: body.total,
          hidden: body.hidden,
          returned: body.rows.length,
        },
      });
    } catch {
      impactLogger.error('error_unhandled', { error_type: 'audit_sink_failure', phase: 'candidates' });
      fail(res, 503, 'impact_unavailable');
      return;
    }
    res.json({ ok: true, ...body });
  });

  // ── The per-mapping switch (admin) ─────────────────────────────────────
  // Test or staff applications would inflate every figure, so an admin can
  // leave a mapping out; an archived mapping is out by default and can be kept.

  router.get('/exclusions', atLeast('admin'), async (req: Request, res: Response) => {
    let body;
    try {
      body = shapeImpactMappingSettings(await store().mappingSettings());
    } catch (err) {
      impactLogger.error('error_unhandled', { error_type: err instanceof Error ? err.name : 'unknown', phase: 'exclusions' });
      fail(res, 503, 'impact_unavailable');
      return;
    }
    await recordAudit(req, 'resource.list', 200, {
      metadata: {
        resource: 'ashby_impact_exclusions',
        count: body.mappings.length,
        excluded: body.mappings.filter((m) => !m.inImpact).length,
        truncated: body.truncated,
      },
    });
    res.json({ ok: true, ...body });
  });

  router.put('/exclusions/:mappingId', atLeast('admin'), async (req: Request, res: Response) => {
    const actorId = req.authUser?.id;
    if (!actorId) { fail(res, 403, 'forbidden'); return; }
    const params = impactExclusionParamsSchema.safeParse(req.params);
    const parsedBody = impactExclusionBodySchema.safeParse(req.body);
    if (!params.success || !parsedBody.success) { fail(res, 400, 'invalid_filter'); return; }
    const mappingId = params.data.mappingId;
    const excluded = parsedBody.data.excluded;
    let answer;
    try {
      // The switch and its audit row (the admin as actor) are one transaction in 0140.
      answer = await store().setExclusion(mappingId, excluded, actorId);
    } catch (err) {
      impactLogger.error('error_unhandled', { error_type: err instanceof Error ? err.name : 'unknown', phase: 'exclusion' });
      fail(res, 503, 'impact_unavailable');
      return;
    }
    if (answer.status === 'not_found') { fail(res, 404, 'not_found'); return; }
    if (answer.status !== 'ok' || typeof answer.archived !== 'boolean' || typeof answer.in_impact !== 'boolean') {
      fail(res, 503, 'impact_unavailable');
      return;
    }
    const excludedFrom = typeof answer.excluded_from === 'boolean' ? answer.excluded_from : null;
    // The request-level trail is extra: the database already audited the change,
    // so a failure here is logged and never turns a saved switch into an error.
    try {
      await recordAudit(req, 'resource.update', 200, {
        metadata: {
          resource: 'ashby_impact_exclusion',
          job_mapping_id: mappingId,
          excluded_from: excludedFrom,
          excluded_to: excluded,
          in_impact: answer.in_impact,
        },
      });
    } catch {
      impactLogger.error('error_unhandled', { error_type: 'audit_sink_failure', phase: 'exclusion' });
    }
    res.json({
      ok: true,
      mappingId,
      excluded,
      excludedFrom,
      archived: answer.archived,
      inImpact: answer.in_impact,
    });
  });

  return router;
}

export const impactRouter = createImpactRouter();
