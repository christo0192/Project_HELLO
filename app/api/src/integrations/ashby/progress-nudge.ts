/**
 * ashby/progress-nudge.ts: the webhook nudge (M031 S4, plan section 5
 * "Webhook nudge").
 *
 * A candidateStageChange signal for an application HELLO imported marks that
 * application's progress row due now, so the progress worker
 * (progress-worker.ts) reads it on its next pass instead of at its cadence.
 *
 * WHERE. `processAshbySignal` (signal-worker.ts) calls the nudge first, before
 * its stage pre-filter, so the pre-filter's skip still nudges. The handler map
 * (runtime-workers.ts) wires it only while ASHBY_PROGRESS_ENABLED is on: off,
 * nothing is called and nothing is written.
 *
 * COST. One call, `nudge_ashby_application_progress` (0141): the link on its
 * unique key, S3's coverage rule for a link that exists, and one write. No
 * Ashby call.
 *
 * NEVER IN THE WAY. The nudge is freshness only; the worker's cadence is the
 * source of truth. So {@link createProgressNudge} never throws or rejects: a
 * call is bounded ({@link PROGRESS_NUDGE_TIMEOUT_MS}), a failure is reported as
 * a code and backs the nudge off ({@link PROGRESS_NUDGE_FAILURE_BACKOFF_MS}) so
 * a storm cannot pile onto a sick database, and the signal goes on exactly as
 * it would have without it: same decision, same receipt, same retries.
 *
 * PRIVACY. It sends an opaque Ashby application id and a time, and gets back a
 * status code. Nothing is logged but a code.
 *
 * A MOVE BACK INTO A CONCLUDED STAGE is not nudged. Stage-change receipts are
 * keyed `stage:<application>:<stage>` (extractors.ts `stageDedupId`), and
 * `record_ashby_event_receipt` (0030) creates no signal job for a receipt
 * already processed, ignored or failed, so that delivery never reaches
 * `processAshbySignal`. In practice: an imported application moved back into
 * its Christy stage. It shows within the cadence. Nudging from the ingress on a
 * duplicate receipt would put a database write on the webhook path, so it is
 * left out (runbook docs/runbooks/ashby-progress-worker.md, section 8).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The 0141 function the store calls. */
export const PROGRESS_NUDGE_RPC = 'nudge_ashby_application_progress';

/**
 * How long one nudge may take before the signal stops waiting for it. Short:
 * the call is one index probe and one row write, and a signal must not park
 * its slot on a sick database (the stage pre-filter's lesson).
 */
export const PROGRESS_NUDGE_TIMEOUT_MS = 2_000;

/**
 * After a failed or timed-out nudge, how long nudges are skipped on this
 * machine. A webhook storm on a sick database would otherwise add one failing
 * call, and up to one timeout, to every signal. A skipped nudge costs only
 * freshness: the cadence still reads the application.
 */
export const PROGRESS_NUDGE_FAILURE_BACKOFF_MS = 30_000;

/** What 0141 answers for a well-formed nudge. */
export const PROGRESS_NUDGE_STATUSES = ['marked', 'created', 'already_due', 'not_imported', 'not_covered'] as const;
export type ProgressNudgeStatus = (typeof PROGRESS_NUDGE_STATUSES)[number];

export type ProgressNudgeAnswer =
  | { status: ProgressNudgeStatus }
  /** 0141 refused the call (`invalid_request`) or answered something unknown. */
  | { status: 'refused'; code: string };

/** The one call. Satisfied by {@link createProgressNudgeStore}; injected for tests. */
export interface ProgressNudgeStore {
  nudge(applicationId: string, nowIso: string): Promise<ProgressNudgeAnswer>;
}

/**
 * What a guarded nudge did. Never thrown: the five statuses, or
 *   refused             0141 refused it (a code is reported);
 *   invalid_application not an id the link table could hold: nothing sent;
 *   backoff             a recent failure: nothing sent;
 *   timeout             no answer within the bound (reported, backs off);
 *   error               the call failed (reported, backs off).
 */
export type ProgressNudgeOutcome = ProgressNudgeStatus | 'refused' | 'invalid_application' | 'backoff' | 'timeout' | 'error';

/** The codes a failure is reported under. */
export type ProgressNudgeFailure = 'timeout' | 'error' | 'refused';

const STATUS_SET = new Set<string>(PROGRESS_NUDGE_STATUSES);
const CODE_RE = /^[a-z0-9_.:-]{1,64}$/;
/** The link table's own bound on external_application_id (0029). */
const MAX_APPLICATION_ID_LEN = 256;

/** The service-role store: one RPC, nothing else. */
export function createProgressNudgeStore(client: SupabaseClient): ProgressNudgeStore {
  return {
    async nudge(applicationId, nowIso) {
      const { data, error } = await client.rpc(PROGRESS_NUDGE_RPC, {
        p_external_application_id: applicationId,
        p_now: nowIso,
      });
      // The database's own message never leaves here: it may name a relation.
      if (error) throw new Error('ashby_progress_nudge_error');
      const status = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).status
        : undefined;
      if (typeof status === 'string' && STATUS_SET.has(status)) return { status: status as ProgressNudgeStatus };
      return { status: 'refused', code: typeof status === 'string' && CODE_RE.test(status) ? status : 'unknown' };
    },
  };
}

export interface ProgressNudgeDeps {
  store: ProgressNudgeStore;
  /** Wall clock (epoch ms): the time sent, and the backoff's clock. */
  nowMs?: () => number;
  timeoutMs?: number;
  failureBackoffMs?: number;
  /** Told of each failure as a code. A throw here is swallowed. */
  onFailure?: (code: ProgressNudgeFailure) => void;
}

/**
 * The nudge the signal worker calls. Build it ONCE per handler map: the
 * backoff is shared by every signal on this machine. It never throws and
 * never rejects.
 */
export function createProgressNudge(deps: ProgressNudgeDeps): (input: { applicationId: string }) => Promise<ProgressNudgeOutcome> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? PROGRESS_NUDGE_TIMEOUT_MS;
  const backoffMs = deps.failureBackoffMs ?? PROGRESS_NUDGE_FAILURE_BACKOFF_MS;
  let failedUntilMs = Number.NEGATIVE_INFINITY;

  function report(code: ProgressNudgeFailure): void {
    try {
      deps.onFailure?.(code);
    } catch {
      /* a reporter must never break the nudge */
    }
  }

  return async function nudgeProgress({ applicationId }): Promise<ProgressNudgeOutcome> {
    if (typeof applicationId !== 'string' || applicationId.length === 0 || applicationId.length > MAX_APPLICATION_ID_LEN) {
      return 'invalid_application';
    }
    const now = nowMs();
    if (now < failedUntilMs) return 'backoff';

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      // Wrapped so a store that throws synchronously is caught like one that rejects.
      const call = Promise.resolve().then(() => deps.store.nudge(applicationId, new Date(now).toISOString()));
      // A call that loses the race may still land: the write is idempotent.
      call.catch(() => undefined);
      const answer = await Promise.race([call, timeout]);
      if (answer === 'timeout') {
        failedUntilMs = nowMs() + backoffMs;
        report('timeout');
        return 'timeout';
      }
      if (answer.status === 'refused') {
        // About this one call, not the database: no backoff.
        report('refused');
        return 'refused';
      }
      return answer.status;
    } catch {
      failedUntilMs = nowMs() + backoffMs;
      report('error');
      return 'error';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
