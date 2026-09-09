/**
 * lib/funnel/runtime.ts — the composition root for funnel-rollup refresh.
 *
 * A FIFTH independent runtime alongside Ashby / recording / phone / worker-
 * orchestration, built and started the same way in `index.ts`: its own gate,
 * its own try/catch, so it can neither prevent nor be prevented by the others
 * or the HTTP server. It owns ONE loop.
 *
 *   funnel-rollup-refresh  recomputes screening_v2.funnel_stage_daily via the
 *                          advisory-locked SECURITY DEFINER RPC
 *                          `refresh_funnel_rollup`. The RPC is idempotent and
 *                          bounded (a trailing window), and returns
 *                          status='busy' with no work done when another
 *                          replica already holds the advisory lock —
 *                          `auto_start_machines` means the replica count is not
 *                          ours to assume, and the DB lock, not this process,
 *                          is the coordination point.
 *
 * With the shipped default `FUNNEL_OBSERVABILITY_ENABLED=false` nothing is
 * constructed: no scheduler, no timer, no DB call. The rollup is purely
 * DERIVED from the operational tables, so leaving it stale while disabled
 * costs nothing but freshness — there is no backlog to accumulate.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLoopScheduler, type LoopSchedulerHandle } from '../scheduler.js';
import { createLogger } from '../logger.js';
import { supabase } from '../supabase.js';
import { loadFunnelRuntimeConfig, type FunnelRuntimeConfig } from './config.js';

export interface FunnelRuntimeOptions {
  client?: SupabaseClient;
  config?: FunnelRuntimeConfig;
  /** Test seams for the scheduler's timers/jitter/clock. */
  scheduler?: {
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
    clearTimer?: (handle: unknown) => void;
    random?: () => number;
    now?: () => number;
  };
}

export interface FunnelRuntimeHandle {
  scheduler: LoopSchedulerHandle;
  loopIntervalsMs: Record<string, number>;
  /** Drive one refresh pass (tests; never used in production). */
  tickOnce(): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * Build the runtime, or return null when the gate is closed.
 */
export function createFunnelRuntime(
  options: FunnelRuntimeOptions = {},
): FunnelRuntimeHandle | null {
  const config = options.config ?? loadFunnelRuntimeConfig();
  if (!config.enabled) return null;

  const logger = createLogger('funnel-runtime');
  const client = options.client ?? (supabase as unknown as SupabaseClient);

  // One bounded, never-throwing pass. Returns true only when the RPC actually
  // recomputed (status='ok'); 'busy' (another replica held the lock) and any
  // error resolve to false so the loop backs off rather than treating a
  // no-op or a transient outage as useful work.
  const tick = async (): Promise<boolean> => {
    try {
      const { data, error } = await client.rpc('refresh_funnel_rollup', {
        p_window_days: config.windowDays,
      });
      if (error) {
        // Sanitized: the error text can carry provider/DB detail. The metric
        // counter from the scheduler is the signal.
        logger.warn('unknown_event', { error_category: 'funnel_rollup_refresh_error' });
        return false;
      }
      const row = (data ?? {}) as { status?: unknown; rows?: unknown };
      return row.status === 'ok' && typeof row.rows === 'number' && row.rows > 0;
    } catch {
      logger.warn('unknown_event', { error_category: 'funnel_rollup_refresh_throw' });
      return false;
    }
  };

  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'funnel',
    loops: [
      {
        name: 'funnel-rollup-refresh',
        intervalMs: config.refreshIntervalMs,
        tick,
      },
    ],
  });

  return {
    scheduler,
    loopIntervalsMs: { 'funnel-rollup-refresh': config.refreshIntervalMs },
    async tickOnce(): Promise<boolean> {
      return tick();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
    },
  };
}
