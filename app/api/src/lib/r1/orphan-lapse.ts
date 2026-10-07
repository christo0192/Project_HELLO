/**
 * lib/r1/orphan-lapse.ts: lapse R1 sessions that no worker owns any more.
 *
 * THE PROBLEM. Admission (`r1_admit_attempt`, 0119) refuses while ANY R1 session is `created`,
 * `waiting` or `in_progress`: the slot is global (`r1_in_flight`, surfaced as 409 `r1_busy`). A
 * session normally settles itself: the worker fails it on a connect or context error, expires it
 * on a no-show, ends it at the residency cap. But three cases leave no one to settle it:
 *
 *   - `created`      the tab died between admission (201) and the first exchange;
 *   - `waiting`      the room exists but no worker ever accepted the dispatch (no capacity, a boot
 *                    timeout, or the media/SFU problem the first smoke hit), and the candidate
 *                    page stopped polling after 36 s;
 *   - `in_progress`  a worker that activated the session was hard-killed.
 *
 * Nothing in production ever lapsed them (`r1.sweep` is deferred, the phone sweeps look only at
 * `mode = 'live'`, `r1_sweep_expired_rounds` skips a round with a live session), so ONE such row
 * blocked every R1 admission until someone edited the database, and the link kept answering "try
 * again in a few minutes".
 *
 * THE LAPSE. It runs inside the existing 60 s `r1-status` loop (`runtime.ts`), only while R1 is
 * enabled. A session is lapsed only when its LAST ACTIVITY is older than a bound that is far past
 * anything a live session can legitimately take, so a healthy interview is never touched:
 *
 *   created      15 min since the row was last touched (the attempt token lives 5 min)
 *   waiting      20 min (the worker's no-show timer is 120 s once it is in the room)
 *   in_progress  45 min since the last row update, transcript turn or ledger row (the worker's own
 *                residency cap is 1800 s and its rejoin grace 90 s, plus the closing line)
 *
 * A `waiting` row is also spared while its worker is demonstrably alive. A candidate who retries in
 * the same tab late in the window (the runbook's advice after a failed start) gets a worker
 * dispatched into the SAME session, and the next tick must not expire the row under it. Two guards,
 * so the lapse and the retry cannot cross:
 *
 *   - the exchange touches the row on every `waiting` rejoin (routes/r1-candidate.ts), so a retry is
 *     activity and restarts the 20 min window. Every lapse write below is also conditional on the
 *     row's `updated_at` still being past the bound, so a touch that lands between this scan and the
 *     write turns the write into zero rows (a no-op, never an error);
 *   - a stale `waiting` row is not lapsed while the R1 SFU lists a dispatch with a LIVE job
 *     (`jobIsLive`, the predicate the exchange's own worker gate uses) in its room, nor while that
 *     listing cannot be read. Both only DEFER: past `waitingLiveJobCeilingSec` of idle the row lapses
 *     whatever the SFU says, because a worker that has not activated a session in an hour is a
 *     zombie job or a dead SFU, and the global slot must not stay blocked for either. With no R1 SFU
 *     configured there is nothing to ask and the timestamps alone decide, as they always did.
 *
 * What it writes, per session, compare-and-set on the status it read (a worker that settled the
 * session first simply wins; zero rows is not an error):
 *
 *   created      -> failed   / room_create_error   attempt outcome no_show
 *   waiting      -> expired  / idle_timeout        attempt outcome configuration_failed
 *   in_progress  -> failed   / worker_crash        attempt outcome shutdown_forced
 *
 * then `r1_settle_attempt`, which records the outcome. EVERY one of these outcomes is uncounted
 * (plan D1: no-shows and system failures never count), so the link keeps its start and the
 * candidate can try again. `ended_at` is written as the LAST ACTIVITY, never `now()`: the minutes
 * estimate (`v_webrtc_minutes_estimate`) charges an unmetered session `(ended_at - started_at) x 2`,
 * so closing a 13-hour overnight orphan at `now()` would book about 1,500 phantom minutes against
 * the monthly allocation.
 *
 * Metadata only is logged (a status and a count); never an id or a payload.
 */

import { jobIsLive } from '../browser-orchestration.js';
import { createLogger } from '../logger.js';
import { roomNameForSession } from '../room-provisioning.js';
import {
  isValidReasonForStatus,
  isValidTransition,
  type SessionStatus,
  type TerminalReason,
} from '../session-lifecycle.js';
import type { R1DbClient } from '../../services/r1-assessment.js';
import type { DispatchListerLike } from './worker-gate.js';

export const R1_ORPHAN_LAPSE_BOUNDS = {
  createdIdleSec: 15 * 60,
  waitingIdleSec: 20 * 60,
  /**
   * A stale `waiting` row whose room has a live job (or whose dispatch listing cannot be read) is
   * deferred, not lapsed, but only up to this much idle time. Past it the row lapses regardless.
   */
  waitingLiveJobCeilingSec: 60 * 60,
  inProgressIdleSec: 45 * 60,
  /** How long one `listDispatch` may take before it counts as unreadable (the pass is 60 s apart). */
  dispatchProbeMs: 8_000,
  /** Live R1 sessions are at most a handful (one per round, one admitted at a time). */
  scanLimit: 50,
} as const;

export interface R1OrphanLapseOptions {
  /**
   * The R1 SFU's agent-dispatch lister, built lazily the first time a stale `waiting` row needs it.
   * Null (or absent): there is no R1 SFU to ask, so the row timestamps alone decide. May throw,
   * which counts as an unreadable listing.
   */
  readonly dispatches?: () => DispatchListerLike | null;
}

type LiveStatus = 'created' | 'waiting' | 'in_progress';

interface LapsePlan {
  readonly to: SessionStatus;
  readonly reason: TerminalReason;
  /** The `r1_settle_attempt` outcome. Every choice here is uncounted. */
  readonly outcome: 'no_show' | 'configuration_failed' | 'shutdown_forced';
  readonly idleSec: number;
}

const PLANS: Readonly<Record<LiveStatus, LapsePlan>> = {
  created: {
    to: 'failed', reason: 'room_create_error', outcome: 'no_show',
    idleSec: R1_ORPHAN_LAPSE_BOUNDS.createdIdleSec,
  },
  waiting: {
    to: 'expired', reason: 'idle_timeout', outcome: 'configuration_failed',
    idleSec: R1_ORPHAN_LAPSE_BOUNDS.waitingIdleSec,
  },
  in_progress: {
    to: 'failed', reason: 'worker_crash', outcome: 'shutdown_forced',
    idleSec: R1_ORPHAN_LAPSE_BOUNDS.inProgressIdleSec,
  },
};

const LIVE_STATUSES = Object.keys(PLANS) as LiveStatus[];

export interface R1OrphanLapseResult {
  /** Live R1 sessions examined. */
  readonly scanned: number;
  /** Sessions this pass moved to a terminal state. */
  readonly lapsed: number;
  /** Of those, how many attempts were settled. */
  readonly settled: number;
  /** Reads or writes that failed; the next pass retries what is still live. */
  readonly errors: number;
}

interface LiveRow {
  readonly id: string;
  readonly status: LiveStatus;
  readonly started_at: string | null;
  readonly waiting_at: string | null;
  readonly updated_at: string | null;
}

const log = createLogger('r1-orphan-lapse');

function ms(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latest(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/** The newest `column` of the session's rows in `table`, or null (none, or the read failed). */
async function newest(
  client: R1DbClient,
  table: string,
  column: string,
  sessionId: string,
): Promise<{ at: number | null; ok: boolean }> {
  const { data, error } = await client
    .from(table)
    .select(column)
    .eq('session_id', sessionId)
    .order(column, { ascending: false })
    .limit(1);
  if (error) return { at: null, ok: false };
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  return { at: row ? ms(row[column]) : null, ok: true };
}

type Ownership = 'live' | 'none' | 'unknown';

/** Reject when `work` has not settled within `limitMs`; the late result is dropped. */
function withinMs<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dispatch_probe_timeout')), limitMs);
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Does a worker own this session's room? `live`: a dispatch there has a live job. `none`: the
 * listing was read and no job is live (a room the SFU no longer knows is `none` too: a job cannot
 * outlive its room). `unknown`: the listing failed or timed out, so nothing is proven either way.
 */
async function dispatchOwnership(lister: DispatchListerLike, sessionId: string): Promise<Ownership> {
  try {
    const listed = await withinMs(
      lister.listDispatch(roomNameForSession(sessionId)),
      R1_ORPHAN_LAPSE_BOUNDS.dispatchProbeMs,
    );
    const owned = (Array.isArray(listed) ? listed : [])
      .some((dispatch) => (dispatch?.state?.jobs ?? []).some(jobIsLive));
    return owned ? 'live' : 'none';
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'not_found' ? 'none' : 'unknown';
  }
}

async function settleAttempt(
  client: R1DbClient,
  sessionId: string,
  outcome: LapsePlan['outcome'],
  now: Date,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await client.rpc('r1_settle_attempt', {
        p_session_id: sessionId,
        p_outcome: outcome,
        p_now: now.toISOString(),
      });
      const status = (data as { status?: unknown } | null)?.status;
      // `duplicate`: already settled (the worker raced us). `attempt_not_found`: nothing to settle.
      if (!error && (status === 'ok' || status === 'duplicate' || status === 'attempt_not_found')) {
        return true;
      }
    } catch {
      // Fall through to the one retry.
    }
  }
  return false;
}

/**
 * One lapse pass. Never throws for a database error: it counts it and returns, so the status
 * loop's other work (the pending-reject sweep) is never held up by it.
 */
export async function lapseOrphanedR1Sessions(
  client: R1DbClient,
  now: Date,
  options: R1OrphanLapseOptions = {},
): Promise<R1OrphanLapseResult> {
  let scanned = 0;
  let lapsed = 0;
  let settled = 0;
  let errors = 0;
  const nowMs = now.getTime();

  // Built at most once per pass, and only when a stale `waiting` row needs it.
  let lister: DispatchListerLike | null | 'unreadable' | undefined;
  const listerForPass = (): DispatchListerLike | null | 'unreadable' => {
    if (lister === undefined) {
      try {
        lister = options.dispatches?.() ?? null;
      } catch {
        lister = 'unreadable';
      }
    }
    return lister;
  };

  const { data, error } = await client
    .from('call_sessions')
    .select('id,status,started_at,waiting_at,updated_at')
    .not('interview_round_id', 'is', null)
    .eq('mode', 'browser')
    .in('status', LIVE_STATUSES)
    .limit(R1_ORPHAN_LAPSE_BOUNDS.scanLimit);
  if (error) return { scanned, lapsed, settled, errors: 1 };

  const rows = (Array.isArray(data) ? data : []) as LiveRow[];
  scanned = rows.length;
  for (const row of rows) {
    // The status READ here is the one every write below compares against (compare-and-set).
    const fromStatus = row.status;
    const plan = LIVE_STATUSES.includes(fromStatus) ? PLANS[fromStatus] : undefined;
    const startedAt = ms(row.started_at);
    // An unparseable start can never be proven stale: leave it for a human, never guess.
    if (!plan || startedAt === null) continue;

    // Cheap pass on the row's own timestamps first; the extra reads only for what looks stale.
    let lastActivity = latest([startedAt, ms(row.waiting_at), ms(row.updated_at)]) as number;
    if (nowMs - lastActivity <= plan.idleSec * 1000) continue;

    if (fromStatus === 'in_progress') {
      // A worker that is alive writes turns and ledger rows; either keeps the session alive.
      const turn = await newest(client, 'transcript_turns', 'created_at', row.id);
      const usage = await newest(client, 'r1_usage_ledger', 'occurred_at', row.id);
      if (!turn.ok || !usage.ok) {
        errors += 1;
        continue; // Cannot prove it is idle: do not lapse on a failed read.
      }
      lastActivity = latest([lastActivity, turn.at, usage.at]) as number;
      if (nowMs - lastActivity <= plan.idleSec * 1000) continue;
    }

    if (
      fromStatus === 'waiting'
      && nowMs - lastActivity <= R1_ORPHAN_LAPSE_BOUNDS.waitingLiveJobCeilingSec * 1000
    ) {
      // Stale by its timestamps, but a worker dispatched into this room is not an orphan: leave the
      // row for the worker to activate or settle. An unreadable listing proves nothing: retry next pass.
      const asked = listerForPass();
      if (asked !== null) {
        const owner = asked === 'unreadable' ? 'unknown' : await dispatchOwnership(asked, row.id);
        if (owner === 'live') continue;
        if (owner === 'unknown') {
          errors += 1;
          continue;
        }
      }
    }

    // Defensive: the constants above must stay a legal transition with a legal reason.
    if (!isValidTransition(fromStatus, plan.to) || !isValidReasonForStatus(plan.reason, plan.to)) {
      errors += 1;
      continue;
    }

    // The last evidence of life, never later than now: see the header (phantom minutes).
    const endedAt = new Date(Math.min(nowMs, Math.max(startedAt, lastActivity))).toISOString();
    let move = client
      .from('call_sessions')
      .update({ status: plan.to, terminal_reason: plan.reason, ended_at: endedAt })
      .eq('id', row.id)
      .eq('status', fromStatus);
    // Compare-and-set on the row's age too: `updated_at` is bumped by the database on every write
    // (trigger 0004), so a candidate's rejoin touch or a worker's write since the scan makes this
    // zero rows. A cutoff, not an equality on the string read, so the column's text format cannot
    // matter. `updated_at` is NOT NULL; an unreadable value just keeps the status-only check.
    if (ms(row.updated_at) !== null) {
      move = move.lte('updated_at', new Date(nowMs - plan.idleSec * 1000).toISOString());
    }
    const { data: moved, error: moveError } = await move.select('id');
    if (moveError) {
      errors += 1;
      continue;
    }
    // Zero rows: a worker or the withdrawal path settled it first. That is the right outcome.
    if (!Array.isArray(moved) || moved.length !== 1) continue;

    lapsed += 1;
    log.warn('unknown_event', { error_category: 'r1_orphan_session_lapsed', error_type: fromStatus });
    if (await settleAttempt(client, row.id, plan.outcome, now)) {
      settled += 1;
    } else {
      // The session is terminal and the slot is free; only the attempt's outcome is unrecorded.
      errors += 1;
      log.warn('unknown_event', { error_category: 'r1_orphan_settle_failed', error_type: fromStatus });
    }
  }
  return { scanned, lapsed, settled, errors };
}
