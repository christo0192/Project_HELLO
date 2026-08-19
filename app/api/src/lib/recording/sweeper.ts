/**
 * lib/recording/sweeper.ts — the BACKSTOP, not the primary detector.
 *
 * The 0038 trigger runs inside the completing CAS transaction, so the intent
 * to finalize is durable the instant a session becomes terminal. This sweep
 * exists for what the trigger structurally cannot cover:
 *
 *   * rows that became terminal BEFORE 0038 shipped (the accumulated
 *     backlog, including the canary's own population);
 *   * a job that completed without converging and needs re-driving after its
 *     dedup key freed up;
 *   * any future path that writes a terminal status through a channel the
 *     trigger's WHEN clause does not match.
 *
 * IT ENQUEUES, IT DOES NOT FINALIZE. Running the finalizer inline here would
 * put provider calls and byte downloads outside the lease, in a loop with no
 * concurrency bound and no failure accounting. Every execution stays behind
 * the one lease-safe path.
 *
 * THREE INDEPENDENT BOUNDS, because the first enable runs against history:
 *   1. `sweepAdmission`   — rows enqueued per tick, itself clamped by the
 *                           drain invariant in `config.ts`;
 *   2. `sweepMaxAgeSec`   — how far back a sweep may reach at all;
 *   3. the halt flag      — freezes the sweep with no deploy, and freezes
 *                           claiming at the other end too.
 * A truncated pass is LOGGED. A silent cap reads as "covered everything".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Queue } from '../queue/index.js';
import { createLogger } from '../logger.js';
import {
  RECORDING_FINALIZE_QUEUE,
  recordingFinalizeDedupKey,
  TERMINAL_SESSION_STATUSES,
} from './config.js';
import type { HaltReader } from './halt.js';

export interface SweeperOptions {
  client: SupabaseClient;
  queue: Pick<Queue, 'enqueue'>;
  halt: HaltReader;
  /** Rows enqueued per tick (already clamped by the drain invariant). */
  admission: number;
  /** Seconds a row must have been terminal before the sweep may touch it. */
  graceSec: number;
  /** How far back the sweep may reach. */
  maxAgeSec: number;
  /** Queue-job attempt budget for genuine throws. */
  maxAttempts: number;
  now?: () => number;
}

export interface SweepResult {
  /** Eligible rows read this pass. */
  scanned: number;
  /** Rows for which a finalize job was enqueued (or already existed). */
  enqueued: number;
  /** True when the pass filled its admission budget — more work remains. */
  truncated: boolean;
  /** Why the pass did no work, when it did none. */
  stop: 'ok' | 'halted' | 'read_error' | 'enqueue_error';
}

/**
 * One bounded sweep pass.
 *
 * Never throws: a read or enqueue failure is reported as a stop code so the
 * scheduler loop keeps its cadence and backs off, rather than counting a
 * transient outage as a dead loop.
 */
export async function runRecordingSweep(options: SweeperOptions): Promise<SweepResult> {
  const logger = createLogger('recording-sweeper');
  const nowMs = (options.now ?? Date.now)();

  if (!(await options.halt.admits())) {
    // Loud, because a frozen sweep and a healthy idle sweep look identical.
    logger.warn('unknown_event', {
      error_category: 'recording_sweep_halted',
      error_type: 'halt_flag',
    });
    return { scanned: 0, enqueued: 0, truncated: false, stop: 'halted' };
  }

  const notBefore = new Date(nowMs - options.maxAgeSec * 1000).toISOString();
  const notAfter = new Date(nowMs - options.graceSec * 1000).toISOString();

  // This predicate must remain a SUPERSET of the 0038 partial index predicate
  // — not identical to it. It adds the deleted/revoked/quarantined exclusions
  // that the index omits, which is fine (a query narrower than a partial index
  // is still served by it) and deliberate (never re-drive a finished
  // recording). Widening the index, or narrowing this query below the index,
  // is what would break.
  //
  // Note the full terminal set: `expired` is the reconciler's own repair for a
  // candidate who closed the tab, which is exactly the stuck population.
  //
  // A row with a NULL `ended_at` is deliberately OUT OF REACH of this sweep:
  // the age bounds are what stop the first pass reaching arbitrarily far back,
  // and a row with no end time has no age to bound. Every current terminal
  // writer stamps `ended_at` (`session-lifecycle.ts` for all four terminal
  // states, `persistence.py` for both worker paths), and the 0038 trigger
  // covers such a row on the primary path regardless — so this only excludes
  // pre-existing legacy rows, and it excludes them visibly rather than by
  // accident.
  let rows: Array<{ id: string }> = [];
  try {
    const { data, error } = await options.client
      .from('call_sessions')
      .select('id')
      .in('status', [...TERMINAL_SESSION_STATUSES])
      .not('recording_egress_id', 'is', null)
      .is('recording_object_key', null)
      .eq('recording_egress_status', 'active')
      .is('recording_finalize_exhausted_at', null)
      .is('recording_deleted_at', null)
      .is('recording_revoked_at', null)
      .eq('recording_quarantined', false)
      .gt('ended_at', notBefore)
      .lt('ended_at', notAfter)
      .order('ended_at', { ascending: true })
      .limit(options.admission);
    if (error) throw new Error('recording_sweep_read_error');
    rows = (data ?? []) as Array<{ id: string }>;
  } catch {
    logger.error('unknown_event', {
      error_category: 'recording_sweep_read_error',
      error_type: 'db_unavailable',
    });
    return { scanned: 0, enqueued: 0, truncated: false, stop: 'read_error' };
  }

  let enqueued = 0;
  let stop: SweepResult['stop'] = 'ok';
  for (const row of rows) {
    try {
      // Same dedup key the trigger writes, so the two producers converge on
      // exactly one live job per session.
      await options.queue.enqueue(
        RECORDING_FINALIZE_QUEUE,
        { session_id: row.id },
        {
          dedupKey: recordingFinalizeDedupKey(row.id),
          maxAttempts: options.maxAttempts,
        },
      );
      enqueued += 1;
    } catch {
      stop = 'enqueue_error';
      logger.error('unknown_event', {
        error_category: 'recording_sweep_enqueue_error',
        error_type: 'queue_unavailable',
      });
      break;
    }
  }

  const truncated = rows.length >= options.admission;
  if (truncated) {
    // The bound did its job — say so. Otherwise a capped pass is indistinguishable
    // from a pass that found everything.
    logger.warn('unknown_event', {
      error_category: 'recording_sweep_truncated',
      error_type: 'admission_budget',
    });
  }

  return { scanned: rows.length, enqueued, truncated, stop };
}
