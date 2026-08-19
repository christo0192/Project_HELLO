/**
 * lib/recording/halt.ts — the kill switch's READ path.
 *
 * The write path is 0038's `set_recording_finalize_halt` /
 * `clear_recording_finalize_halt` against the `recording_finalize_control`
 * singleton. This is the side that the sweeper and the queue runner consult.
 *
 * WHY IT IS CACHED
 * ----------------
 * The runner's admission gate states its own contract: "Anything it consults
 * must be CHEAP — it runs on every poll of every queue", and "a throw is
 * treated as do-not-claim". An uncached DB read there would put a network
 * round-trip on every poll and, worse, would convert any transient database
 * blip into a fleet-wide claim freeze. So the flag is read at most once per
 * `haltTtlMs` and served from memory in between.
 *
 * THE STALENESS WINDOW IS THE COST, AND IT IS STATED
 * --------------------------------------------------
 * Setting the halt takes effect within `haltTtlMs` (default 5 s) on each
 * machine, not instantly. Clearing it likewise. That is acceptable because the
 * halt is a RATE control, not a safety boundary: the safety boundaries are the
 * per-tick admission budget, the sweep max-age, and the per-session attempt
 * terminus, none of which are cached.
 *
 * FAIL-OPEN, DELIBERATELY
 * -----------------------
 * When the flag cannot be read:
 *   - a cached answer newer than `MAX_STALE_MS` is reused (so a halt an
 *     operator just set is still honoured through a brief outage);
 *   - otherwise the gate ADMITS.
 * Failing closed here would mean one database error stops all claiming — and
 * the finalize handler's own first act is a database read that would fail
 * anyway, so failing closed buys nothing and costs a fleet-wide freeze. The
 * choice is recorded here rather than left to be inferred from a `catch`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../supabase.js';

/** How long a cached answer may still be trusted once reads start failing. */
export const MAX_STALE_MS = 60_000;

export interface HaltState {
  halted: boolean;
  reason: string | null;
  /** ISO instant the halt began, or null. */
  since: string | null;
  /** True when this answer came from an unreadable flag (see fail-open above). */
  degraded: boolean;
}

export interface HaltReaderOptions {
  client?: SupabaseClient;
  ttlMs: number;
  now?: () => number;
}

export interface HaltReader {
  /** Cached read; never throws. */
  read(): Promise<HaltState>;
  /** Cheap synchronous-ish gate for `shouldClaim`. Never throws. */
  admits(): Promise<boolean>;
  /** Drop the cache (test isolation, and after an operator action). */
  invalidate(): void;
}

const NOT_HALTED: HaltState = { halted: false, reason: null, since: null, degraded: false };

export function createHaltReader(options: HaltReaderOptions): HaltReader {
  const now = options.now ?? Date.now;
  const client = options.client ?? (supabase as unknown as SupabaseClient);
  let cached: { at: number; state: HaltState } | null = null;
  let inFlight: Promise<HaltState> | null = null;

  async function fetchState(): Promise<HaltState> {
    const { data, error } = await client
      .from('recording_finalize_control')
      .select('sweep_halted_at, sweep_halt_reason')
      .eq('control_key', 'default')
      .maybeSingle();
    if (error) throw new Error('recording_halt_read_error');
    const row = (data ?? null) as { sweep_halted_at?: string | null; sweep_halt_reason?: string | null } | null;
    const since = row?.sweep_halted_at ?? null;
    return {
      halted: Boolean(since),
      reason: row?.sweep_halt_reason ?? null,
      since,
      degraded: false,
    };
  }

  async function read(): Promise<HaltState> {
    const t = now();
    if (cached && t - cached.at < options.ttlMs) return cached.state;
    // Single-flight: N concurrent gate calls must not become N reads.
    if (!inFlight) {
      inFlight = fetchState()
        .then((state) => {
          cached = { at: now(), state };
          return state;
        })
        .catch(() => {
          if (cached && now() - cached.at < MAX_STALE_MS) {
            return { ...cached.state, degraded: true };
          }
          // Fail-OPEN. See the module header for why.
          return { ...NOT_HALTED, degraded: true };
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return {
    read,
    async admits(): Promise<boolean> {
      const state = await read();
      return !state.halted;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
