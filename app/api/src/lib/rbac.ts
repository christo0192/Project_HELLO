/**
 * SEC-03: Role-Based Access Control.
 *
 * Enforces admin/interviewer/viewer least privilege:
 *   - viewer: read-only access to allowed resources
 *   - interviewer: access/manage only owned records
 *   - admin: full access within single-org scope
 *
 * Denials happen before service-role query/mutation and generate
 * data-minimized audit attempts.
 */

import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from './auth.js';

// ── Role hierarchy ───────────────────────────────────────────────────

export type AppRole = 'admin' | 'interviewer' | 'viewer';

const ROLE_HIERARCHY: Record<AppRole, number> = {
  viewer: 0,
  interviewer: 1,
  admin: 2,
};

function roleLevel(role: AppRole): number {
  return ROLE_HIERARCHY[role] ?? -1;
}

// ── Middleware factories ─────────────────────────────────────────────

/**
 * RBAC error body — stable, non-sensitive JSON.
 */
function forbiddenBody(): Record<string, unknown> {
  return {
    error: {
      type: 'authorization_error',
      message: 'Insufficient permissions',
    },
  };
}

/**
 * Require minimum role level. Calls next() if allowed, responds 403 otherwise.
 */
export function requireRole(minRole: AppRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.authUser;
    if (!user) {
      res.status(403).json(forbiddenBody());
      return;
    }
    if (roleLevel(user.appRole) < roleLevel(minRole)) {
      res.status(403).json(forbiddenBody());
      return;
    }
    next();
  };
}

/**
 * Require viewer role (read-only) — only GET/HEAD allowed.
 */
export function requireViewer(req: Request, res: Response, next: NextFunction): void {
  const user = req.authUser;
  if (!user) {
    res.status(403).json(forbiddenBody());
    return;
  }
  if (roleLevel(user.appRole) < roleLevel('viewer')) {
    res.status(403).json(forbiddenBody());
    return;
  }
  next();
}

/**
 * Viewer mutation guard: rejects non-GET/HEAD for viewers.
 * Must be used after requireAuth and requireViewer.
 */
export function viewerReadOnly(req: Request, res: Response, next: NextFunction): void {
  const user = req.authUser;
  if (!user) {
    res.status(403).json(forbiddenBody());
    return;
  }
  if (user.appRole === 'viewer' && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(403).json(forbiddenBody());
    return;
  }
  next();
}

/**
 * Require interviewer or above. For ownership checks, use requireOwnership.
 */
export function requireInterviewer(req: Request, res: Response, next: NextFunction): void {
  const user = req.authUser;
  if (!user) {
    res.status(403).json(forbiddenBody());
    return;
  }
  if (roleLevel(user.appRole) < roleLevel('interviewer')) {
    res.status(403).json(forbiddenBody());
    return;
  }
  next();
}

/**
 * Require admin role.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.authUser;
  if (!user) {
    res.status(403).json(forbiddenBody());
    return;
  }
  if (roleLevel(user.appRole) < roleLevel('admin')) {
    res.status(403).json(forbiddenBody());
    return;
  }
  next();
}

// ── Ownership helper ────────────────────────────────────────────────

/**
 * Ownership check for interviewer-scoped resources.
 *
 * Interviewers may only access resources they own (matched by a resource's
 * `created_by` or `interviewer_id` field equalling the user's auth id).
 * Admins bypass ownership checks.
 *
 * Pass a function that returns the owner ID from the resource.
 * If the check fails, responds 403 and returns false.
 */
export function requireOwnership(
  getOwnerId: (req: Request) => string | null | Promise<string | null>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.authUser;
    if (!user) {
      res.status(403).json(forbiddenBody());
      return;
    }

    // Admins bypass ownership check
    if (user.appRole === 'admin') {
      next();
      return;
    }

    // Interviewers must own the resource
    if (user.appRole === 'interviewer') {
      try {
        const ownerId = await getOwnerId(req);
        if (!ownerId || ownerId !== user.id) {
          res.status(403).json(forbiddenBody());
          return;
        }
        next();
        return;
      } catch {
        res.status(403).json(forbiddenBody());
        return;
      }
    }

    // Viewers should not reach here if viewerReadOnly is in chain
    res.status(403).json(forbiddenBody());
  };
}
