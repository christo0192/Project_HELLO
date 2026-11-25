/**
 * The attempt-outcome hook of R1 over Meet (M034 S06, dark; D-S06-29, critic C5): when the R1 worker
 * settles an attempt (`POST /api/internal/r1/attempt-outcome` answered `ok` or `duplicate`), the Meet
 * call must learn of it. The route calls `notifyR1MeetAttemptEnded` fire-and-forget; it queues one
 * `r1-meet` job `attempt_ended { booking_id, session_id }` 5 seconds later (the closing words are still
 * playing), deduplicated per session, and the `r1-meet` lane does the rest from the settled attempt
 * itself: a counted attempt leaves at Recall, `in_call -> completed/attempt_settled`, release; one that
 * did not count re-arms the bridge while the round has a start left (or ends the call as failed).
 *
 * WHY HERE AND NOT IN THE WORKER: the voice worker's teardown has a hard time budget
 * (TestTeardownBudget) and no Recall key; a vendor call there could delay or break the outcome itself.
 * The worker only reports the outcome, as it does for every R1 attempt.
 *
 * GUARANTEES
 *  - Meet inactive (R1 or Meet off): it returns before any read, so the browser path is byte-identical.
 *  - Active: ONE read (the booking bound to the session); none = a browser session, nothing queued.
 *  - It never throws and never rejects: a failed read or enqueue logs one closed warning
 *    (`r1_meet_attempt_ended_enqueue_failed`) and the outcome's own answer is untouched. A lost job is
 *    re-driven by the maintenance pass (an `in_call` booking whose session ended).
 *  - The payload holds two ids and nothing else; no log line holds an id.
 *
 * Loading this module performs no I/O. The database client and the queue's enqueue are arguments.
 */

import type { supabase } from '../../supabase.js';
import { getR1Config } from '../config.js';
import { getR1MeetConfig, r1MeetActive, type R1MeetConfig } from './config.js';
import { R1_MEET_QUEUE, r1MeetJobs } from './jobs.js';
import { createR1MeetLog, type R1MeetLog } from './recall-actions.js';
import { createR1MeetStore, type R1MeetStore } from './runtime-store.js';

type Db = typeof supabase;

/** The job waits this long after the outcome: the closing words may still be playing. */
export const R1_MEET_ATTEMPT_ENDED_DELAY_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `Queue.enqueue` as the route has it (the lazy queue of `routes/r1.ts`). */
export type R1MeetQueueEnqueue = (
  name: string,
  payload: unknown,
  options: { readonly dedupKey: string; readonly maxAttempts: number; readonly scheduledAt: string },
) => Promise<unknown>;

export interface R1MeetAttemptEndedDeps {
  readonly client: Db;
  readonly enqueue: R1MeetQueueEnqueue;
  /** Test seams; production reads the switches at call time. */
  readonly r1Config?: () => { readonly enabled: boolean };
  readonly meetConfig?: () => R1MeetConfig;
  readonly store?: Pick<R1MeetStore, 'getBookingBySession'>;
  readonly now?: () => number;
  readonly log?: R1MeetLog;
}

/** Queue the Meet bot's leave for a settled attempt (see the header). Never throws. */
export async function notifyR1MeetAttemptEnded(sessionId: unknown, deps: R1MeetAttemptEndedDeps): Promise<void> {
  try {
    const r1 = deps.r1Config === undefined ? getR1Config() : deps.r1Config();
    const meet = deps.meetConfig === undefined ? getR1MeetConfig() : deps.meetConfig();
    // THE GATE: with Meet inactive nothing below runs, not even a read.
    if (!r1MeetActive(r1, meet)) return;
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return;
    const id = sessionId.toLowerCase();
    const store = deps.store ?? createR1MeetStore(deps.client);
    const booking = await store.getBookingBySession(id);
    // A browser session (or a booking re-bound since): not a Meet call.
    if (booking === null) return;
    const spec = r1MeetJobs.attemptEnded(booking.id, id);
    const nowMs = deps.now === undefined ? Date.now() : deps.now();
    await deps.enqueue(R1_MEET_QUEUE, spec.payload, {
      dedupKey: spec.dedupKey,
      maxAttempts: spec.maxAttempts,
      scheduledAt: new Date(nowMs + R1_MEET_ATTEMPT_ENDED_DELAY_MS).toISOString(),
    });
  } catch {
    try {
      (deps.log ?? createR1MeetLog()).warn({ error_category: 'r1_meet_attempt_ended_enqueue_failed' });
    } catch {
      // A logger that throws must not turn a fire-and-forget hook into an unhandled rejection.
    }
  }
}
