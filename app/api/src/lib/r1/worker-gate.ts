/**
 * The R1 exchange's worker gate: IDEMPOTENT, READY-BEFORE-DISPATCH, dispatch at
 * most once.
 *
 * The legacy exchange ties "dispatched" to the one-time invite being consumed,
 * so a retry after a deferred (202) exchange re-enters the gate and a retry
 * after success does not. R1 has no invite to consume: a candidate may refresh
 * and exchange again for the same attempt at any time, and a session stays
 * `waiting` for the whole interview until the worker activates it, so EVERY
 * rejoin passes through here. "Already dispatched" is therefore read from
 * LiveKit itself, BEFORE anything is asked of the worker pool:
 *
 *   - a dispatch of our agent that has a LIVE JOB (a worker accepted it and the
 *     job is not finished: `jobIsLive`, the same predicate the browser worker gate
 *     uses; a JS_SUCCESS / JS_FAILED job or one with `endedAt` set is a dead
 *     interviewer, not a running one) means the interviewer is running: mint a
 *     token and touch nothing. Calling
 *     `ensureReadyWorker` here would re-claim and `startMachine` a machine that
 *     is hosting a live interview, and a failed start releases the claim and
 *     stops that machine;
 *   - a dispatch with NO live job that is younger than the verify window is
 *     another exchange's dispatch still in flight: defer, never dispatch twice;
 *   - a dispatch with no live job past that window was dropped (the S0-F3 case:
 *     the SFU accepted it with no registered worker) or its interviewer already
 *     ended. It is deleted, a worker is readied, and a fresh dispatch is made, so
 *     a stale record can never stand in for a running interviewer;
 *   - no dispatch at all: ready a worker, then dispatch once;
 *   - a dispatch listing that cannot be read defers instead of guessing.
 *
 * Calls for one session are serialized in-process so two simultaneous
 * exchanges cannot both observe "no dispatch". Across API machines the
 * serialization is best-effort; the young-dispatch rule above closes most of
 * that window. See the PR-3 open risks.
 *
 * `gate` is null when on-demand orchestration is off (or `BROWSER_AGENT_NAME` is
 * empty or malformed). On the Cloud SFU the exchange then proceeds exactly like
 * the legacy path: the unnamed worker auto-dispatches. On the R1 SFU NOTHING
 * auto-dispatches, so a null gate (and a `disabled` verdict from the service)
 * must never mint a token: the caller sets `failClosed` and both answer
 * `preparing` (fence 7; the route also refuses 503 `r1_unavailable` before it
 * provisions anything, so this is the second line of defence).
 */

import { jobIsLive, type BrowserWorkerGate } from '../browser-orchestration.js';

/** The part of an `AgentDispatch` the gate reads (the SDK type satisfies it). */
export interface DispatchLike {
  id?: string;
  agentName?: string;
  state?: {
    /** A non-empty list means a worker accepted the dispatch. */
    jobs?: unknown[];
    /** int64 epoch; the unit is not stated by the protocol, see `epochMs`. */
    createdAt?: bigint | number | string;
  };
}

export interface DispatchListerLike {
  listDispatch(roomName: string): Promise<DispatchLike[]>;
  deleteDispatch?(dispatchId: string, roomName: string): Promise<unknown>;
}

export type R1GateVerdict = 'proceed' | 'preparing';

export interface R1GateInput {
  gate: BrowserWorkerGate | null;
  sessionId: string;
  roomName: string;
  /** Resolved lazily: only built when a worker is actually being gated. */
  dispatches: () => DispatchListerLike;
  /** Epoch ms, injectable for tests. */
  now?: () => number;
  /**
   * R1 SFU: no unnamed worker auto-dispatches there, so "no gate" and a `disabled`
   * verdict can never stand in for a dispatched interviewer. When true both answer
   * `preparing` instead of `proceed`. Cloud (false/omitted) keeps the legacy
   * behaviour: it proceeds and the unnamed worker auto-dispatches.
   */
  failClosed?: boolean;
}

/**
 * How long a job-less dispatch may still be "in flight". The worker gate's own
 * dispatch verifies a job for up to 8 s and retries once, so 20 s covers a whole
 * attempt (16 s) plus clock and polling slack. Past it, nothing is coming.
 */
export const JOBLESS_DISPATCH_GRACE_MS = 20_000;

const tails = new Map<string, Promise<unknown>>();

/** Run `work` after every earlier call for `key` has settled. */
export async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/**
 * `AgentDispatchState.createdAt` is an int64 whose unit the protocol does not
 * state (the server writes nanoseconds). Normalize by magnitude, so a unit
 * change on the server cannot turn every dispatch into "brand new" or "ancient".
 * Null when absent or unusable.
 */
export function epochMs(value: bigint | number | string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e17) return Math.floor(n / 1e6); // nanoseconds
  if (n >= 1e14) return Math.floor(n / 1e3); // microseconds
  if (n >= 1e11) return Math.floor(n); // milliseconds
  return Math.floor(n * 1000); // seconds
}

/**
 * A worker owns a LIVE job for this dispatch. A finished or failed job (status
 * JS_SUCCESS / JS_FAILED, or `endedAt` set) is the remains of an interviewer that
 * is gone, so it must not make a rejoin `proceed` into an agent-less room.
 */
function hasJob(dispatch: DispatchLike): boolean {
  return (dispatch.state?.jobs ?? []).some(jobIsLive);
}

/** Young enough that a worker may still pick it up. Unknown age counts as stale. */
function isInFlight(dispatch: DispatchLike, nowMs: number): boolean {
  const created = epochMs(dispatch.state?.createdAt);
  if (created === null) return false;
  return nowMs - created <= JOBLESS_DISPATCH_GRACE_MS;
}

/** Best-effort removal of dropped, job-less dispatches of `agentName`. */
async function deleteJobless(
  lister: DispatchListerLike,
  roomName: string,
  dispatches: DispatchLike[],
): Promise<void> {
  if (!lister.deleteDispatch) return;
  for (const dispatch of dispatches) {
    if (!dispatch.id) continue;
    try {
      await lister.deleteDispatch(dispatch.id, roomName);
    } catch {
      /* the next exchange re-reads the room; a leftover is deleted then */
    }
  }
}

async function gateOnce(input: R1GateInput): Promise<R1GateVerdict> {
  const { gate, sessionId, roomName } = input;
  if (gate === null) return input.failClosed ? 'preparing' : 'proceed';
  const nowMs = (input.now ?? Date.now)();

  // 1. Read what LiveKit already holds. Unreadable: defer, never guess (a
  //    dispatch now could add a second interviewer, a skipped one none).
  const lister = input.dispatches();
  let mine: DispatchLike[];
  try {
    const existing = await lister.listDispatch(roomName);
    mine = existing.filter((item) => item.agentName === gate.agentName);
  } catch {
    return 'preparing';
  }

  // 2. The interviewer is already running (or on its way): touch nothing.
  if (mine.some(hasJob)) return 'proceed';
  if (mine.some((item) => isInFlight(item, nowMs))) return 'preparing';

  // 3. Nothing usable is dispatched. Ready a worker first.
  const ready = await gate.ensureReadyWorker({ sessionId });
  // The service's own flag-off answer: an inert gate. Cloud proceeds as with no
  // gate (the unnamed worker auto-dispatches); the R1 SFU has no such worker, so
  // it defers rather than mint a token into an agent-less room (fence 7).
  if (ready.status === 'disabled') return input.failClosed ? 'preparing' : 'proceed';
  // no_capacity | timeout | error: the service already released what it claimed.
  if (ready.status !== 'ready') return 'preparing';

  // 4. Replace any dropped dispatch, then dispatch once.
  await deleteJobless(lister, roomName, mine);
  const dispatched = await gate.dispatch({ sessionId, roomName });
  if (dispatched) return 'proceed';
  // The worker is ready but the room could not be given an agent. Release the
  // claim, clear the job-less record the failed attempt left (it must not pass
  // for a running interviewer), and defer; never mint a token into an
  // agent-less room.
  await gate.releaseWorker({ machineId: ready.machineId, sessionId });
  try {
    const left = (await lister.listDispatch(roomName))
      .filter((item) => item.agentName === gate.agentName && !hasJob(item));
    await deleteJobless(lister, roomName, left);
  } catch {
    /* best effort: the grace window above ages it out regardless */
  }
  return 'preparing';
}

/** Ensure a ready worker is in (or on its way into) the room, or defer. */
export function runR1WorkerGate(input: R1GateInput): Promise<R1GateVerdict> {
  return serialize(`r1-gate:${input.sessionId}`, () => gateOnce(input));
}
