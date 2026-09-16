/**
 * routes/funnel.ts — the recruiter-facing read of the screening funnel.
 *
 * Same aggregation as `GET /api/admin/funnel/summary` (both call
 * `loadFunnelSummary`), exposed at interviewer-and-above so the recruiter
 * dashboard and the HR head can see the KPIs without an admin account.
 *
 * WHY A SEPARATE ROUTER rather than relaxing the admin one: `adminRouter` puts
 * `requireAdmin` at the router boundary, which is a single, auditable statement
 * that everything beneath it is admin-only. Punching a per-route exception
 * through that boundary is how such a guarantee quietly stops being true — the
 * next route added under it inherits an assumption that no longer holds. A
 * second router keeps the admin boundary absolute and states this route's own
 * gate explicitly.
 *
 * SAFE TO WIDEN because of what the payload is, not merely who asks for it:
 * the response is counts, ISO days and derived ratios read from the
 * `funnel_stage_daily` rollup. No name, phone, email, transcript, résumé text
 * or candidate id crosses this boundary — the rollup has no column that could
 * carry one. `role_id` is nulled during per-day aggregation.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { validateQuery } from '../lib/validation.js';
import { funnelSummaryQuerySchema } from '../schemas/funnel.js';
import { loadFunnelSummary } from '../lib/funnel/summary.js';

export const funnelRouter = Router();

/**
 * GET /api/funnel/summary?from&to&role_id
 * Topline funnel over a date window (default trailing 30d), the derived
 * stage-to-stage conversions, and the per-day series for the trend charts.
 * Empty until the rollup has been refreshed at least once.
 */
funnelRouter.get(
  '/summary',
  requireRole('interviewer'),
  validateQuery(funnelSummaryQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await loadFunnelSummary(supabase, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        roleId: req.query.role_id as string | undefined,
        // Per-day latency percentiles are not aggregated on a role-filtered
        // day and can describe a single candidate. Admin keeps them.
        omitTimings: true,
      });
      res.json(summary);
    } catch {
      // Sanitized: never surface a driver message to a non-admin caller.
      next(new Error('failed to load funnel summary'));
    }
  },
);
