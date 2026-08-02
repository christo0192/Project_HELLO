/**
 * Phase 9 L2 — maintenance-mode guard (fail-closed for NEW-work gates).
 *
 * Semantics (invariant 10):
 *   - NEW work (simulation/live session start, new invite/session
 *     operational writes) is blocked while maintenance is enabled.
 *   - Active-call continuation (turns/finalization), worker persistence,
 *     assessment/scoring, candidate consent decline/appeal, status/health,
 *     and authenticated admin clear-toggle are NOT blocked by this guard.
 *   - A DB read failure FAILS CLOSED for new-work gates (503) — never
 *     silently proceeds into a possibly-drained system.
 *   - Authenticated admins pass through when maintenance is enabled
 *     (admin toggle / operational override paths).
 *
 * The maintenance state lives in `system_config` under key
 * MAINTENANCE_CONFIG_KEY ('maintenance'), written atomically by the
 * service-role-only `toggle_maintenance` RPC.
 */

import type { NextFunction, Request, Response } from 'express';
import { supabase } from './supabase.js';

export const MAINTENANCE_CONFIG_KEY = 'maintenance';

/** Bounded maintenance state read from system_config. */
export interface MaintenanceState {
  ok: true;
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
}

export type MaintenanceReadResult = MaintenanceState | { ok: false };

/**
 * Read the maintenance state from system_config. Never throws.
 * `{ ok: false }` means the DB read failed (callers fail closed).
 */
export async function readMaintenanceState(): Promise<MaintenanceReadResult> {
  const { data, error } = await supabase
    .from('system_config')
    .select('value, updated_at')
    .eq('key', MAINTENANCE_CONFIG_KEY)
    .maybeSingle();
  if (error) return { ok: false };

  const value = data?.value as Record<string, unknown> | null | undefined;
  const reason = value?.reason;
  return {
    ok: true,
    enabled: value?.enabled === true,
    reason: typeof reason === 'string' && reason.length > 0 ? reason.slice(0, 200) : null,
    updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : null,
  };
}

/** Stable, non-sensitive 503 body for maintenance-blocked new work. */
export function maintenanceBlockedBody(): {
  error: { type: string; message: string };
} {
  return { error: { type: 'maintenance_mode', message: 'Service temporarily unavailable' } };
}

export interface MaintenanceMiddlewareOptions {
  /**
   * Allow authenticated admins through even while maintenance is enabled.
   * Start paths use this (admin can still start/operate during maintenance).
   */
  allowAdmin?: boolean;
  /** Injectable reader (tests). */
  readState?: () => Promise<MaintenanceReadResult>;
}

/**
 * Fail-closed Express middleware for NEW-work gates.
 * Blocks when maintenance is enabled (or on DB-read failure) for
 * non-admin callers; `allowAdmin` lets authenticated admins through.
 */
export function createMaintenanceMiddleware(opts: MaintenanceMiddlewareOptions = {}) {
  const readState = opts.readState ?? readMaintenanceState;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let state: MaintenanceReadResult;
    try {
      state = await readState();
    } catch {
      // Reader threw (shouldn't, but never trust a DB boundary): fail closed.
      res.status(503).json(maintenanceBlockedBody());
      return;
    }
    if (!state.ok) {
      // DB read failure — fail closed for new work.
      res.status(503).json(maintenanceBlockedBody());
      return;
    }
    if (state.enabled) {
      if (opts.allowAdmin && req.authUser?.appRole === 'admin') {
        next();
        return;
      }
      res.status(503).json(maintenanceBlockedBody());
      return;
    }
    next();
  };
}
