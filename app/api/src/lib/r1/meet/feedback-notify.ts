/**
 * The scorecard-ready hook of R1 over Meet (M034 S09, dark; D-S09-8, D-S09-9): when the R1 scorer
 * settles an assessment for a Meet round, queue ONE `scorecard_feedback` job so Dex's scorecard is
 * posted to Ashby as that interview's feedback (`feedback.ts` does the posting).
 *
 * THE TRIGGER (`notifyR1MeetScorecardReady`). `lib/r1/runtime.ts` hands it to the assessment handler
 * as `onResult`, fire-and-forget. A copy of the attempt-outcome hook (`attempt-ended.ts`). The gate,
 * in this order, each step stopping quietly:
 *   1  R1 and Meet active (`r1MeetActive`): with Meet inactive nothing below runs, not even a read,
 *      so the browser path is byte-identical;
 *   2  the Ashby feedback form setting is not `off` (blank `R1_MEET_ASHBY_FEEDBACK_FORM_ID`). A
 *      malformed setting (`invalid`) still records: the job then alerts and fails the receipt for
 *      that interview, so it can be re-posted after the fix (runbook);
 *   3  the assessment is the round's current one (`attach === 'ok'`; `superseded_by_newer` means a
 *      newer attempt took the round);
 *   4  both ids are UUIDs;
 *   5  ONE read: the Meet booking bound to the session. None = a browser session (or a booking
 *      re-bound to a later attempt): nothing is queued;
 *   6  ONE RPC (`r1_meet_record_receipt` through the feedback store): the receipt
 *      `ashby-schedule:feedback:<booking>:<assessment>` and its `r1-meet` job, in one transaction.
 *      The payload is exactly `{ kind, booking_id, assessment_id }` (the RPC adds `receipt_id` and
 *      `source`). A second call for the same pair is a duplicate and queues nothing.
 * It never throws and never rejects: a refused answer or any failure logs ONE closed warning
 * (`r1_meet_feedback_enqueue_failed`), and the scoring job's own outcome is untouched. A lost trigger
 * is re-driven by the maintenance pass (below).
 *
 * THE RE-DRIVE (`redriveR1MeetFeedback`). The `maintenance` job (once per 15-minute bucket while
 * Meet is active) calls it after its own steps. It looks at the completed bookings whose slot started
 * between 26 hours and 20 minutes ago (at most 10, newest first), their rounds' current assessment,
 * and the feedback receipts that already exist, and records the missing ones (the same RPC as the
 * trigger). Idle, that is one narrow read per bucket. Inert (no read at all) without the feedback
 * ports or with the form setting `off`. The bound is deliberate (critic C8): the ten NEWEST completed
 * bookings are looked at, so a booking gets its chances in the buckets right after it settles; with
 * more than ten newer completed bookings in the window an older miss is left to the runbook's
 * re-post. It never throws: a failure logs one closed warning (`r1_meet_feedback_redrive_failed`);
 * a pass that queued something logs `r1_meet_feedback_redriven` with the count. The handler re-checks everything (settled, current, the booking's own session), so
 * a re-driven job for a booking that must not be posted simply ends `ignored`.
 *
 * LOGS: closed words and counts only, never an id.
 *
 * Loading this module performs no I/O: the database client is an argument (type-only import of
 * `lib/supabase`), and the scorer's service is never imported (the result is typed structurally).
 */

import type { supabase } from '../../supabase.js';
import { getR1Config } from '../config.js';
import {
  getR1MeetConfig,
  getR1MeetFeedbackConfig,
  r1MeetActive,
  type R1MeetConfig,
  type R1MeetFeedbackConfig,
} from './config.js';
import { createR1MeetFeedbackStore, r1MeetFeedbackReceiptKey, type R1MeetFeedbackStore } from './feedback-store.js';
import { createR1MeetLog, type R1MeetFlowDeps, type R1MeetLog } from './recall-actions.js';
import { createR1MeetStore, type R1MeetStore } from './runtime-store.js';

type Db = typeof supabase;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const ENQUEUE_FAILED_LOG = 'r1_meet_feedback_enqueue_failed';
const REDRIVE_FAILED_LOG = 'r1_meet_feedback_redrive_failed';
const REDRIVEN_LOG = 'r1_meet_feedback_redriven';

/** The re-drive's window and bound (D-S09-9). Frozen. */
export const R1_MEET_FEEDBACK_REDRIVE = Object.freeze({
  /** The oldest slot start looked at: a day of interviews, plus margin for a late scoring job. */
  lookbackMs: 26 * HOUR_MS,
  /** The newest slot start looked at: the trigger gets this long to do its own work first. */
  settleMs: 20 * MINUTE_MS,
  /** Completed bookings per pass. */
  limit: 10,
});

/**
 * What the hook reads of the scorer's result (`R1AssessmentResult`), typed structurally so this
 * module never loads the scorer's service.
 */
export interface R1MeetScorecardResult {
  readonly sessionId: unknown;
  readonly assessmentId: unknown;
  readonly attach: unknown;
}

export interface R1MeetScorecardNotifyDeps {
  readonly client: Db;
  /** Test seams; production reads the switches at call time. */
  readonly r1Config?: () => { readonly enabled: boolean };
  readonly meetConfig?: () => R1MeetConfig;
  readonly feedbackConfig?: () => R1MeetFeedbackConfig;
  readonly store?: Pick<R1MeetStore, 'getBookingBySession'>;
  readonly feedbackStore?: Pick<R1MeetFeedbackStore, 'recordFeedback'>;
  readonly now?: () => number;
  readonly log?: R1MeetLog;
}

/**
 * Log one closed line (`warn` or `info`); undefined = the structured logger. A logger that throws
 * must not turn a fire-and-forget hook into an unhandled rejection, nor fail a maintenance run.
 */
function line(
  log: R1MeetLog | undefined,
  level: 'warn' | 'info',
  category: string,
  errorType?: string,
): void {
  try {
    const logger = log ?? createR1MeetLog();
    logger[level]({ error_category: category, ...(errorType === undefined ? {} : { error_type: errorType }) });
  } catch {
    // Swallowed: see above.
  }
}

/** Queue Dex's scorecard feedback for a settled Meet assessment (see the header). Never throws. */
export async function notifyR1MeetScorecardReady(
  result: R1MeetScorecardResult,
  deps: R1MeetScorecardNotifyDeps,
): Promise<void> {
  try {
    // 1. THE GATE: with Meet inactive nothing below runs, not even a read.
    const r1 = deps.r1Config === undefined ? getR1Config() : deps.r1Config();
    const meet = deps.meetConfig === undefined ? getR1MeetConfig() : deps.meetConfig();
    if (!r1MeetActive(r1, meet)) return;
    // 2. Posting to Ashby is switched off (a blank form setting).
    const feedback = deps.feedbackConfig === undefined ? getR1MeetFeedbackConfig() : deps.feedbackConfig();
    if (feedback.status === 'off') return;
    // 3. Only the round's current assessment.
    if (result === null || typeof result !== 'object' || result.attach !== 'ok') return;
    // 4. Ids only, and well formed.
    const { sessionId, assessmentId } = result;
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return;
    if (typeof assessmentId !== 'string' || !UUID.test(assessmentId)) return;
    // 5. ONE read: a browser session (or a booking re-bound since) has no booking.
    const store = deps.store ?? createR1MeetStore(deps.client);
    const booking = await store.getBookingBySession(sessionId.toLowerCase());
    if (booking === null) return;
    // 6. ONE RPC: the receipt and its job.
    const feedbackStore = deps.feedbackStore ?? createR1MeetFeedbackStore(deps.client);
    const nowMs = deps.now === undefined ? Date.now() : deps.now();
    const answer = await feedbackStore.recordFeedback(booking.id, assessmentId.toLowerCase(), nowMs);
    // A refusal is one of the RPC's seven closed words (never a value).
    if (answer.status === 'refused') line(deps.log, 'warn', ENQUEUE_FAILED_LOG, answer.reason);
  } catch {
    line(deps.log, 'warn', ENQUEUE_FAILED_LOG);
  }
}

/** One booking and assessment the re-drive may record. */
interface RedriveCandidate {
  readonly bookingId: string;
  readonly assessmentId: string;
  readonly key: string;
}

/**
 * Record the feedback receipts a lost trigger never recorded (see the header). Answers null (and
 * reads nothing) without the feedback ports or with the form setting `off`; otherwise the number of
 * jobs it queued. Never throws.
 */
export async function redriveR1MeetFeedback(
  deps: Pick<R1MeetFlowDeps, 'feedback' | 'now' | 'log'>,
): Promise<{ readonly queued: number } | null> {
  let queued = 0;
  try {
    const feedback = deps.feedback;
    if (feedback === undefined || feedback === null) return null;
    if (feedback.config().status === 'off') return null;

    const store = feedback.store;
    const nowMs = deps.now();
    const window = R1_MEET_FEEDBACK_REDRIVE;
    const bookings = await store.listRecentCompleted({
      startAfter: new Date(nowMs - window.lookbackMs).toISOString(),
      startBefore: new Date(nowMs - window.settleMs).toISOString(),
      limit: window.limit,
    });
    // A booking without its round or session can never be posted (the handler's `booking_unbound`).
    const bound = bookings.filter((booking) => booking.roundId !== null && booking.sessionId !== null);
    if (bound.length === 0) return Object.freeze({ queued });

    const current = await store.roundAssessmentIds(bound.map((booking) => booking.roundId as string));
    const candidates: RedriveCandidate[] = [];
    for (const booking of bound) {
      // A round with no assessment yet: still scoring, or never scored. Nothing to post.
      const assessmentId = current.get(booking.roundId as string);
      if (assessmentId === undefined) continue;
      candidates.push({ bookingId: booking.id, assessmentId, key: r1MeetFeedbackReceiptKey(booking.id, assessmentId) });
    }
    if (candidates.length === 0) return Object.freeze({ queued });

    const existing = await store.existingFeedbackKeys(candidates.map((candidate) => candidate.key));
    let failures = 0;
    for (const candidate of candidates) {
      if (existing.has(candidate.key)) continue;
      // One failing record never stops the others; the next bucket retries what is still missing.
      try {
        const answer = await store.recordFeedback(candidate.bookingId, candidate.assessmentId, nowMs);
        if (answer.status === 'refused') failures += 1;
        else if (answer.enqueued) queued += 1;
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) line(deps.log, 'warn', REDRIVE_FAILED_LOG);
    if (queued > 0) line(deps.log, 'info', REDRIVEN_LOG, `queued_${queued}`);
    return Object.freeze({ queued });
  } catch {
    // A read failed (or the setting could not be read): nothing more this bucket; the next one retries.
    line(deps.log, 'warn', REDRIVE_FAILED_LOG);
    return Object.freeze({ queued });
  }
}
