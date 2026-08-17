/**
 * ashby/completion-observer.ts — the production caller for `writeback_pending`.
 *
 * Review finding H1: migration 0032 shipped `mark_ashby_writeback_pending`,
 * the `writeback_pending` lifecycle value, and the store adapter — and
 * NOTHING called any of them. The runbook claimed a completed screening
 * "therefore parks"; in fact nothing observed completion at all, and the two
 * tests asserted stubs the tests themselves had written. This module is the
 * missing observer.
 *
 * WHERE IT HOOKS. `services/assessment.ts` `runAssessmentImpl` is the
 * authoritative terminal path: it refuses to run unless the session is
 * `completed` with `terminal_reason = 'conversation_complete'`, and it only
 * reaches the end after the assessment row is durably inserted. Hooking there
 * means a failed, cancelled, expired, abandoned, or still-running session can
 * never be marked complete — the guard is upstream of us and we inherit it.
 *
 * WHAT IT DOES, AND DELIBERATELY DOES NOT DO. It parks the Ashby application
 * link as `writeback_pending` and stops. It publishes nothing: no scorecard
 * write, no stage move, no feedback submission, no auto-reject. That is the
 * whole point — there is no tenant-verified Ashby result sink, so the honest
 * terminal state is "screened, awaiting manual publication".
 *
 * FAILURE POSTURE. The observer is best-effort with respect to scoring: a
 * failure here must never lose a completed assessment, which is the primary
 * product artifact. It is idempotent (the RPC returns `already_pending` on a
 * second call), and an un-parked application remains visible in Mission
 * Control as a completed session whose link is not `writeback_pending`.
 */

import { createLogger } from '../../lib/logger.js';

const logger = createLogger('ashby-completion');

/** The reason recorded on every park. Stable and greppable. */
export const NO_RESULT_SINK_REASON = 'no_verified_result_sink';

/** Narrow store seam — satisfied by `RuntimeWorkflowStores`. */
export interface CompletionStore {
  markWritebackPending(applicationLinkId: string, reason: string): Promise<{ status: string }>;
}

/** Resolve the Ashby application link bound to a screening session, if any. */
export interface AshbyLinkLookup {
  /** Returns the link id + terminal state for a session, or null when the
   *  session is not Ashby-originated (the overwhelmingly common case). */
  findLinkBySessionId(sessionId: string): Promise<
    { id: string; terminalState: string | null } | null
  >;
}

export interface CompletionObserverDeps {
  lookup: AshbyLinkLookup;
  stores: CompletionStore;
}

export type CompletionObserverOutcome =
  | { status: 'not_ashby' }
  | { status: 'blocked_terminal' }
  | { status: 'parked'; applicationLinkId: string }
  | { status: 'already_pending'; applicationLinkId: string }
  | { status: 'error' };

/**
 * Park a completed Ashby-linked screening as `writeback_pending`.
 *
 * Never throws: the caller is the assessment path, and a bookkeeping failure
 * must not discard a scored assessment.
 */
export async function observeAshbyCompletion(
  sessionId: string,
  deps: CompletionObserverDeps,
): Promise<CompletionObserverOutcome> {
  try {
    const link = await deps.lookup.findLinkBySessionId(sessionId);
    // Not an Ashby-originated session — the ordinary recruiter-upload path.
    if (!link) return { status: 'not_ashby' };

    // A withdrawn/deleted/cancelled application is already terminal. Parking it
    // would overwrite that terminal record with a "waiting to publish" state
    // that is not true, so we refuse — as does the RPC itself.
    if (link.terminalState) return { status: 'blocked_terminal' };

    const result = await deps.stores.markWritebackPending(link.id, NO_RESULT_SINK_REASON);
    if (result.status === 'ok') return { status: 'parked', applicationLinkId: link.id };
    if (result.status === 'already_pending') {
      return { status: 'already_pending', applicationLinkId: link.id };
    }
    if (result.status === 'blocked_terminal') return { status: 'blocked_terminal' };
    return { status: 'error' };
  } catch {
    // Sanitized: the underlying message can carry connection/row detail.
    logger.warn('unknown_event', {
      error_category: 'ashby_completion_observer',
      error_type: 'park_failed',
    });
    return { status: 'error' };
  }
}
