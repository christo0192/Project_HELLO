/**
 * The Meet-off catch-up of the "Lexy R1: Booked" tag (M035 S11, dark; PR #453 review S11-R2).
 *
 * WHY. While `R1_MEET_ENABLED` is deliberately off there is no `r1-meet` lane (`runtime.ts`:
 * `createR1MeetLane` answers null), yet the `r1-sweep` drain backstop (`drain.ts`, door (b)) keeps
 * moving future public bookings to `drained/flag_off`, and 0143's terminal trigger queues a tag
 * `remove` job for each. Nothing claims those jobs until Meet is back on, so a candidate whose
 * interview the rollback cancelled would keep "Lexy R1: Booked" in Ashby for as long as Meet stays
 * off. Owner decision 5 says the tag goes when the booking "fails before the interview", and the
 * drain's owner (M035 S05) never writes to Ashby, so this lane does it itself.
 *
 * WHAT. One bounded pass, run by the `r1-sweep` tick right after the drain backstop's pass and under
 * the same gate (`runtime.ts`: Meet status exactly `disabled` and a usable Recall key; once per
 * 15-minute bucket, again on the next tick while there is more). It pages the public bookings that
 * ENDED (`cancelled`, `failed`, `drained`) whose slot starts no earlier than `lookbackMs` (a day)
 * ago (`endedBookings`, by id, from a cursor kept across passes that wraps to the start after a
 * short page; the day back covers a booking drained shortly before its slot that the pass reaches
 * only after the slot began), and runs the tag job's own converge on each
 * (`runR1MeetAshbyBookedTag` with `removeOnly`): a fresh read, the candidate-wide WANTED rule (so a
 * failure after a bot was sent, or a drain after the start, keeps the tag exactly as the queued job
 * would), Ashby's own write switches, the same Ashby port and client, a remove per Lexy tag, the
 * final look. It NEVER adds: a candidate who still wants the tag (another of their bookings
 * stands, or the interview's time had come) is left as is (`tag_wanted_held`, no Ashby read), and
 * the queued jobs converge that once Meet is back on. Every removal it makes is one the queued
 * `remove` job would make. It queues, creates and arms nothing, and leaves the queued jobs alone:
 * when Meet is back on they find the tag gone and finish `tag_absent`.
 *
 * BOUNDS. Before ANY read: Ashby's switches on and a usable key, else the pass does nothing (zero
 * queries, zero calls). A page holds `limit` (10) bookings; a run starts only while a whole run's
 * budget (`R1_MEET_ASHBY_TAG_RUN_MS`) still fits into the pass's (`budgetMs`, the drain backstop's
 * 40 s). A booking whose run settled (`processed` or `ignored`) is remembered by this process (at
 * most `rememberMax`, the oldest forgotten first): a later pass reads its row again but never asks
 * Ashby about it again. A wait (`defer`: Ashby throttling or down, a permission fault, the tag not in
 * the catalogue, a contended write) ends the pass AND holds the catch-up for that wait's seconds, so
 * a setup alert fires at most once per wait, as the job's own does; the cursor stays on that
 * booking. A run that throws (`r1_meet_db_error`, ...) is one warning with its closed code; that
 * booking is skipped for this round and tried again after the cursor wraps.
 *
 * MULTI-MACHINE. Each process keeps its own cursor, memory and hold; two machines may converge the
 * same booking, which the run tolerates (a refused remove looks again before it alerts).
 *
 * LOGS. The run's own lines (closed words, counts, an HTTP status), plus
 * `r1_meet_ashby_tag_meet_off_error` with a closed code and the pass line
 * `r1_meet_ashby_tag_meet_off_pass` (`removed_<n>`). Never an id, a name or the tag's title.
 *
 * Loading this module performs no I/O: every port is an argument.
 */

import { R1_MEET_ASHBY_TAG_RUN_MS } from './ashby-booked-tag-ashby.js';
import { runR1MeetAshbyBookedTag, type R1MeetAshbyTagDeps } from './ashby-booked-tag.js';
import { R1MeetJobError, R1_MEET_JOB_MAX_ATTEMPTS, type R1MeetJobMeta, type R1MeetJobResult } from './jobs.js';
import type { R1MeetLog } from './recall-actions.js';

/** The catch-up's bounds (see the header). Frozen. */
export const R1_MEET_ASHBY_TAG_MEET_OFF = Object.freeze({
  /** Bookings per page (one read). */
  limit: 10,
  /** The wall-clock budget of one pass: no run starts unless a whole run still fits. */
  budgetMs: 40_000,
  /** Settled bookings this process remembers. */
  rememberMax: 1000,
  /** Bookings whose slot started up to this long ago are still paged (a slot that passed first). */
  lookbackMs: 24 * 60 * 60 * 1000,
});

/**
 * The warning of a run that threw (its booking is skipped for this round; `error_type` its closed
 * code) or of a page that could not be read (`runtime.ts`, `error_type: 'page'`).
 */
export const R1_MEET_ASHBY_TAG_MEET_OFF_ERROR = 'r1_meet_ashby_tag_meet_off_error';

/** The info line of a pass that settled a booking (`runtime.ts`, `error_type: 'removed_<n>'`). */
export const R1_MEET_ASHBY_TAG_MEET_OFF_PASS = 'r1_meet_ashby_tag_meet_off_pass';

/** What the catch-up runs with. Production builds it in `runtime.ts` (`createR1MeetSweepTick`). */
export interface R1MeetAshbyTagMeetOffDeps {
  readonly ashbyTag: R1MeetAshbyTagDeps;
  /** Epoch ms. */
  readonly now: () => number;
  readonly log: R1MeetLog;
}

/** One pass's outcome. Counts only. */
export interface R1MeetAshbyTagMeetOffReport {
  /** Runs that removed the tag (`tag_removed`). */
  readonly removed: number;
  /** Bookings whose run settled this pass (`processed` or `ignored`), the removals included. */
  readonly settled: number;
  /** Runs that threw (skipped for this round). */
  readonly failed: number;
  /** A full page, or the budget ran out first: the next tick goes on. */
  readonly more: boolean;
}

const IDLE: R1MeetAshbyTagMeetOffReport = Object.freeze({ removed: 0, settled: 0, failed: 0, more: false });

function report(removed: number, settled: number, failed: number, more: boolean): R1MeetAshbyTagMeetOffReport {
  return Object.freeze({ removed, settled, failed, more });
}

/** Ashby's switches on AND a usable key; a switch or a port that throws counts as off. */
function ashbyUsable(tag: R1MeetAshbyTagDeps): boolean {
  try {
    return tag.ashbyActive() === true && tag.ashby() !== null;
  } catch {
    return false;
  }
}

/**
 * The meta of a catch-up run: a first delivery that never waited. The run consults it only for its
 * deferral bound and back-off, so a wait is always answered (never thrown) and its delay is the base.
 */
function catchUpMeta(nowMs: number): R1MeetJobMeta {
  return Object.freeze({
    attempts: 1,
    maxAttempts: R1_MEET_JOB_MAX_ATTEMPTS.ashby_booked_tag,
    deferCount: 0,
    deferredAt: null,
    createdAt: new Date(nowMs).toISOString(),
    isRerun: false,
    finalAttempt: false,
    lastDeferReason: null,
    lastError: null,
  });
}

/**
 * The catch-up (see the header): a function that runs one pass per call and keeps its cursor, its
 * memory of settled bookings and its hold between calls. A failed page read throws (the caller logs
 * it); nothing else does.
 */
export function createR1MeetAshbyTagMeetOffPass(
  deps: R1MeetAshbyTagMeetOffDeps,
): () => Promise<R1MeetAshbyTagMeetOffReport> {
  const bounds = R1_MEET_ASHBY_TAG_MEET_OFF;
  let cursor: string | null = null;
  let holdUntilMs = Number.NEGATIVE_INFINITY;
  const settledIds = new Set<string>();

  const remember = (id: string): void => {
    settledIds.add(id);
    while (settledIds.size > bounds.rememberMax) {
      const oldest = settledIds.values().next();
      if (oldest.done === true) break;
      settledIds.delete(oldest.value);
    }
  };

  return async () => {
    const startedMs = deps.now();
    if (startedMs < holdUntilMs) return IDLE;
    const tag = deps.ashbyTag;
    // Ashby's switches off or no usable key: not even a read.
    if (!ashbyUsable(tag)) return IDLE;

    const ids = await tag.store.endedBookings({
      startAfterIso: new Date(startedMs - bounds.lookbackMs).toISOString(),
      afterId: cursor,
      limit: bounds.limit,
    });
    let removed = 0;
    let settled = 0;
    let failed = 0;
    for (const id of ids) {
      if (!settledIds.has(id)) {
        // A run starts only while a whole run's budget still fits (the cursor stays before it).
        if (deps.now() - startedMs + R1_MEET_ASHBY_TAG_RUN_MS > bounds.budgetMs) return report(removed, settled, failed, true);
        let result: R1MeetJobResult;
        try {
          result = await runR1MeetAshbyBookedTag(
            deps,
            { kind: 'ashby_booked_tag', op: 'remove', bookingId: id },
            catchUpMeta(deps.now()),
            { removeOnly: true },
          );
        } catch (error) {
          failed += 1;
          deps.log.warn({
            error_category: R1_MEET_ASHBY_TAG_MEET_OFF_ERROR,
            error_type: error instanceof R1MeetJobError ? error.code : 'unexpected',
          });
          cursor = id;
          continue;
        }
        if (result.outcome === 'defer') {
          // Ashby is not ready: hold for the run's own wait, and start from this booking next time.
          holdUntilMs = deps.now() + result.delaySeconds * 1000;
          return report(removed, settled, failed, false);
        }
        remember(id);
        settled += 1;
        if (result.code === 'tag_removed') removed += 1;
      }
      cursor = id;
    }
    if (ids.length < bounds.limit) {
      // The last page: the next pass starts from the first booking again.
      cursor = null;
      return report(removed, settled, failed, false);
    }
    return report(removed, settled, failed, true);
  };
}
