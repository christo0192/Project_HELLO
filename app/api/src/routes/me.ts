/**
 * Phase 9 L2 — /api/me (invariant 7).
 *
 * GET /api/me requires an existing recruiter auth (NOT public — L4 keeps it
 * out of PUBLIC_ROUTES). Returns the current validated JWT email plus the
 * authoritative membership role/active resolved by requireAuth's membership
 * resolver (req.authUser.appRole / req.authUser.active).
 */

import { Router } from 'express';
import { requireRole } from '../lib/rbac.js';
import type { MeResponse } from '../schemas/me.js';

export const meRouter = Router();

// Any active recruiter (admin/interviewer/viewer) may read their own profile.
meRouter.use(requireRole('viewer'));

meRouter.get('/', (req, res) => {
  const user = req.authUser;
  if (!user) {
    res.status(403).json({ error: { type: 'authorization_error', message: 'Insufficient permissions' } });
    return;
  }
  const body: MeResponse = {
    userId: user.id,
    email: user.email ?? null,
    role: user.appRole,
    active: user.active,
  };
  res.json(body);
});
