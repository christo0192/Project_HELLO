/**
 * Phase 9 L2 — public status endpoint (invariant 9).
 *
 * GET /api/status returns ONLY bounded operational/maintenance/degraded
 * state plus updated_at. It deliberately exposes NO model/provider/internal
 * dependencies and no PII. Public (L4 adds it to PUBLIC_ROUTES); the router
 * itself requires no auth so it works behind the public allowlist.
 */

import { Router } from 'express';
import { readMaintenanceState } from '../lib/maintenance.js';
import type { PublicStatusResponse } from '../schemas/status.js';

export const statusRouter = Router();

statusRouter.get('/', async (_req, res, next) => {
  try {
    const state = await readMaintenanceState();
    if (!state.ok) {
      // DB read failure → bounded 'degraded' (no internals leaked).
      const body: PublicStatusResponse = {
        status: 'degraded',
        maintenance: null,
        updated_at: new Date().toISOString(),
      };
      return res.json(body);
    }
    const body: PublicStatusResponse = state.enabled
      ? {
          status: 'maintenance',
          maintenance: {
            enabled: true,
            reason: state.reason,
            updated_at: state.updatedAt,
          },
          updated_at: state.updatedAt ?? new Date().toISOString(),
        }
      : {
          status: 'ok',
          maintenance: null,
          updated_at: state.updatedAt ?? new Date().toISOString(),
        };
    res.json(body);
  } catch (error) {
    next(error);
  }
});
