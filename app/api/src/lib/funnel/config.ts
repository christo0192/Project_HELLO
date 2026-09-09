/**
 * lib/funnel/config.ts — the bounded shape of the funnel-observability
 * rollup-refresh runtime. Every value arrives already clamped from
 * `lib/env.ts`; this module just names the subset the runtime reads.
 */

import { env } from '../env.js';

export interface FunnelRuntimeConfig {
  /** Master gate. When false, createFunnelRuntime() constructs nothing. */
  enabled: boolean;
  /** Base cadence (ms) of the rollup recompute loop. */
  refreshIntervalMs: number;
  /** Trailing window (days) each recompute reaches back over. */
  windowDays: number;
}

/** Read the runtime shape from the process env (already clamped there). */
export function loadFunnelRuntimeConfig(): FunnelRuntimeConfig {
  return {
    enabled: env.funnelObservabilityEnabled,
    refreshIntervalMs: env.funnelRollupIntervalMs,
    windowDays: env.funnelRollupWindowDays,
  };
}
