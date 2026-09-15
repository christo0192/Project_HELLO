/**
 * lib/worker-orchestration.ts — the service layer for on-demand Fly worker
 * scaling (phone-cost-and-scale-plan §2). This is the coordinator that brings a
 * STOPPED pool machine up just-in-time for one session, releases it when the
 * session ends, and reaps any machine that leaked `started` with no live room.
 *
 * ── THE TWO INVARIANTS (§2.1), AND WHERE THEY ARE ENFORCED ────────────
 *   I1  NEVER ADMIT WITHOUT A CONFIRMED-READY WORKER. `ensureReadyWorker`
 *       returns `{status:'ready'}` ONLY after the lease it claimed has been
 *       observed in state 'ready' (the worker posted its readiness ping →
 *       mark_voice_worker_ready). Every other exit — no_capacity, timeout,
 *       error — returns a NON-ready status, and the caller must not dial/admit
 *       on any of them. There is no code path that returns 'ready' without a
 *       ready lease read.
 *   I2  NEVER LEAK A STARTED MACHINE — AND NEVER STOP SOMEBODY ELSE'S.
 *       Every failure exit of `ensureReadyWorker` after a successful claim runs
 *       a best-effort cleanup so a machine that was started but never confirmed
 *       ready does not sit `started` burning cost. That cleanup acts ONLY on a
 *       claim `release_voice_worker` proved was still ours (`draining`): the
 *       stop and the reset are both unfenced, so running them on a claim that
 *       has moved on ends a live call. The one exit that skips cleanup
 *       entirely is the claim-lost branch, where the lease read already told us
 *       the machine is not ours and the release CAS — which is NOT
 *       epoch-fenced — could not tell us otherwise.
 *       `reapWorkers` is the independent backstop: it stops ANY non-stopped
 *       machine whose claimed session has no live LiveKit room beyond the grace
 *       window, even if every orchestration event was lost.
 *
 * ── DISABLED BY DEFAULT ───────────────────────────────────────────────
 * The whole module is inert unless `env.workerOrchestration` is true. Each
 * public entry point checks the flag first and no-ops (returning a `disabled`
 * status) before it claims, starts, stops, reaps, or makes ANY Fly / DB call.
 * Constructing the service does nothing; a deploy of this build starts no
 * machine and no timer until an operator turns the flag on.
 *
 * ── EVERY SEAM IS INJECTABLE ──────────────────────────────────────────
 * The RPC caller, the Fly client, the LiveKit room-lister, the lease-state
 * reader, the clock and the sleep are all injected, so the whole surface is
 * unit-testable with fakes and no network / DB. Production wiring lives in
 * `createDefaultWorkerOrchestrationService`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createFlyMachinesClient,
  isFlyMachinesError,
  type FlyMachinesClient,
} from './fly-machines.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import { createLogger } from './logger.js';
import { env } from './env.js';
import { supabase } from './supabase.js';

const log = createLogger('worker-orchestration');

// ── Bounds ─────────────────────────────────────────────────────────────────

/** Fly-side wait budget (seconds) for the machine to reach `started`. */
const DEFAULT_START_WAIT_SEC = 60;
/** Default wall-clock budget (ms) to observe the lease reach `ready`. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 120_000;
const MIN_READY_TIMEOUT_MS = 1_000;
/** Cadence (ms) at which the readiness poll re-reads the lease state. */
const DEFAULT_READY_POLL_MS = 750;
/** Per-run cap on how many reap candidates a single sweep will act on. */
const DEFAULT_REAP_MAX_PER_RUN = 50;

// ── Injection seams ────────────────────────────────────────────────────────

/**
 * The service-role RPC caller. Mirrors `supabase.rpc(name, args)`; returns the
 * jsonb envelope `{status, ...}` the RPCs answer, or throws on a transport
 * error. Injected so a test needs no database.
 */
export type RpcCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

/**
 * What the readiness poll reads back off a lease row.
 *
 * `state` ALONE is not enough, and reading only it was a real race. The poll
 * runs for up to two minutes against a row that another actor can take away:
 * the reaper releases a claim it judges dead, `claim_voice_worker` then hands
 * the same machine to the NEXT session, and that session's worker posts its
 * readiness ping. A poll watching only `state` sees `ready`, believes it, and
 * dials a candidate into a machine that belongs to somebody else — where, since
 * the worker now accepts one job at a time, the second dispatch is DECLINED and
 * the candidate hears silence. That is reachable exactly when the pool is
 * saturated, which is the load this whole change exists to survive.
 *
 * So the poll reads the claim's identity alongside its state and believes
 * `ready` only while the row still carries THIS session at THIS epoch.
 */
export interface LeaseStateSnapshot {
  /** The lifecycle state, or null when no row exists for (app, machineId). */
  readonly state: string | null;
  /** Who holds the lease right now. Null iff the machine is `stopped`. */
  readonly claimedSessionId: string | null;
  /** The fencing token of the CURRENT claim, not of ours. */
  readonly epoch: number | null;
}

/**
 * A bounded, read-only view of a machine's lease — the readiness-poll seam.
 *
 * It reads the three columns the poll must fence on and nothing else: the
 * state, and the claim identity that says whether that state is still ours.
 * There is no `get_voice_worker_lease` RPC in the committed substrate (0079),
 * so production reads the service-role-only `voice_worker_leases` table
 * directly (RLS forces service_role); this seam keeps that read injectable and
 * keeps the rest of the service ignorant of the storage shape. Must reject
 * rather than invent on a transport failure.
 */
export type LeaseStateReader = (input: {
  app: string;
  machineId: string;
}) => Promise<LeaseStateSnapshot>;

/**
 * A bounded, read-only LiveKit room-liveness check. `true` iff the named room
 * currently has at least one participant.
 *
 * The reaper treats a THROW as "unknown" and SPARES the machine (never stops on
 * an unproven-dead room), so this must reject rather than invent on failure —
 * with ONE exception it must get right: a room that does not exist is not
 * unknown, it is empty, and must answer `false`. Reporting a missing room as
 * "unknown" makes the reaper spare that machine on every pass for ever, which
 * is how a lease survives with a 32-hour-dead heartbeat while its machine burns.
 */
export type RoomLivenessChecker = (roomName: string) => Promise<boolean>;

export interface WorkerOrchestrationDeps {
  /** Master gate. Defaults to `env.workerOrchestration`. */
  readonly enabled?: boolean;
  readonly rpc: RpcCaller;
  readonly fly: FlyMachinesClient;
  readonly readLeaseState: LeaseStateReader;
  readonly roomIsLive: RoomLivenessChecker;
  /**
   * Derives the LiveKit room name a claimed session should occupy, so the
   * reaper can ask `roomIsLive`. Defaults to the phone room naming
   * (`phone-<sessionId>`); the browser pipeline can inject its own. Kept
   * injectable so the reaper is not coupled to one pipeline's room scheme.
   */
  readonly roomNameForSession?: (sessionId: string) => string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Fly-side wait budget (seconds) for `started`. Defaults to 60. */
  readonly startWaitSec?: number;
  /** Readiness poll cadence (ms). Defaults to 750. */
  readonly readyPollMs?: number;
  /** Per-sweep reap cap. Defaults to 50. */
  readonly reapMaxPerRun?: number;
  /**
   * T2③ ORPHAN-REAP grace (seconds). The conservative idle window a MANAGED
   * pool machine's lease must have been `stopped` and UNTOUCHED before the
   * orphan sweep will consider stopping it (when Fly reports it `started`).
   * Defaults to `env.workerOrphanGraceSec`. Longer than the normal reaper grace
   * because an orphan has no per-session room to prove liveness against — the
   * idle window IS the race guard.
   */
  readonly orphanGraceSec?: number;
  /**
   * Optional structured-event sink. The component logger's meta allowlist drops
   * non-allowlisted keys (counts like `released`/`stopFailed`, the `app`), so the
   * log line carries only the event KIND. This sink receives the FULL payload,
   * so operational counters and tests can observe what the log cannot. Called in
   * addition to — never instead of — the log line. Best-effort: a throwing sink
   * must never break a fail-open path, so it is wrapped.
   */
  readonly onEvent?: (kind: string, payload: Record<string, unknown>) => void;
}

// ── Result types ────────────────────────────────────────────────────────────

export type EnsureReadyResult =
  | { status: 'ready'; machineId: string }
  | { status: 'no_capacity' }
  | { status: 'timeout' }
  | { status: 'error'; code: string }
  | { status: 'disabled' };

export interface ReapResult {
  stopped: number;
  /** When the flag is off nothing is scanned; surfaced for the caller/health. */
  disabled?: boolean;
}

export interface ReleaseTerminalResult {
  released: number;
  /** When the flag is off nothing is scanned; surfaced for the caller/health. */
  disabled?: boolean;
}

export interface WorkerOrchestrationService {
  ensureReadyWorker(input: {
    app: string;
    pipeline: 'phone' | 'browser';
    sessionId: string;
    epoch?: number | null;
    readyTimeoutSec?: number;
  }): Promise<EnsureReadyResult>;
  releaseWorker(input: {
    app: string;
    machineId: string;
    sessionId: string;
  }): Promise<void>;
  /**
   * Terminal-release choke point, addressed by SESSION rather than machine.
   * Restart-safe: a process that never saw the dial (and so has no machineId)
   * can still release the claim a session holds, because the lease table maps
   * machine<->session. Drains the lease via `release_voice_worker_by_session`,
   * then stops the returned machine and resets the row — the same
   * release->stop->reset order `releaseWorker` uses, each step fail-open. A
   * no-op (returns without touching Fly) when the session holds no live claim.
   */
  releaseWorkerBySession(input: { app: string; sessionId: string }): Promise<void>;
  /**
   * The PROMPT-release pass: find every live lease whose bound call_session is
   * already terminal and release it now, rather than waiting for the reaper's
   * grace window. The universal terminal signal — every terminal path drives
   * the session terminal — so this catches call completed / failed / no_answer
   * / abandoned / reconnect-exhausted / crash without any per-terminal wiring.
   * Bounded per run. The reaper remains the backstop for anything this misses
   * (e.g. a session row deleted before release).
   */
  releaseTerminalSessions(input: { app: string }): Promise<ReleaseTerminalResult>;
  /**
   * Mark the lease `busy` at the moment the API learns the dial succeeded and a
   * call is live — the second liveness signal the reaper can lean on beyond
   * LiveKit room-liveness. CAS on (machine, session, epoch): a stale caller
   * matches no row and is a silent no-op. Best-effort: a failure never fails
   * the dial (the lease is already `ready`, which the reaper spares while the
   * room is live). No-op when the gate is disabled.
   */
  markBusy(input: {
    app: string;
    machineId: string;
    sessionId: string;
    epoch: number;
  }): Promise<void>;
  reapWorkers(input: { app: string }): Promise<ReapResult>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Narrow the jsonb RPC envelope to `{status, ...}`; throw on a driver error. */
function envelope(
  op: string,
  res: { data: unknown; error: { message?: string } | null },
): Record<string, unknown> {
  if (res.error) {
    // Sanitized: the driver message can quote a row. A stable op label only.
    throw new Error(`rpc_error:${op}`);
  }
  const data = res.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`rpc_shape:${op}`);
  }
  return data as Record<string, unknown>;
}

/**
 * True when a LiveKit room read failed because the room is GONE, not because
 * the call failed.
 *
 * The server SDK raises a Twirp error carrying `code: 'not_found'` for a room
 * that no longer exists; older/newer builds have surfaced the same condition as
 * an HTTP 404 and as a message-only error. All three are checked, because the
 * cost of missing one is the reaper sparing a dead machine for ever — the
 * failure this classifier exists to end — while the cost of a false positive is
 * bounded: the reaper then treats a live room as empty and stops a machine one
 * grace window early, which `list_reapable_voice_workers` already requires to
 * be past its heartbeat grace.
 *
 * Deliberately NARROW on the message: only the SDK's own wording for a missing
 * room, never a substring that a transport failure could also produce.
 */
function isRoomNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code.toLowerCase() === 'not_found') return true;
  if (e.status === 404 || e.statusCode === 404) return true;
  return typeof e.message === 'string'
    && /requested room does not exist/i.test(e.message);
}

/** A metadata-only sweep/lifecycle log line. Never a session id or a token. */
function logEvent(kind: string, extra: Record<string, unknown> = {}): void {
  log.info('unknown_event', { error_category: `worker_orchestration_${kind}`, ...extra });
}

// ── Service ──────────────────────────────────────────────────────────────────

export function createWorkerOrchestrationService(
  deps: WorkerOrchestrationDeps,
): WorkerOrchestrationService {
  const enabled = deps.enabled ?? env.workerOrchestration;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const roomNameForSession = deps.roomNameForSession ?? phoneRoomName;
  const startWaitSec = deps.startWaitSec ?? DEFAULT_START_WAIT_SEC;
  const readyPollMs = Math.max(50, deps.readyPollMs ?? DEFAULT_READY_POLL_MS);
  const reapMaxPerRun = Math.max(1, deps.reapMaxPerRun ?? DEFAULT_REAP_MAX_PER_RUN);
  const orphanGraceSec = deps.orphanGraceSec ?? env.workerOrphanGraceSec;

  /**
   * Emit a lifecycle event. Always logs (KIND only, per the meta allowlist), and
   * ALSO hands the full payload to the optional structured sink so counts the log
   * cannot carry are still observable. The sink is wrapped so a throwing one can
   * never break a fail-open path.
   */
  const event = (kind: string, payload: Record<string, unknown> = {}): void => {
    logEvent(kind, payload);
    if (deps.onEvent) {
      try {
        deps.onEvent(kind, payload);
      } catch {
        /* a sink must never break orchestration */
      }
    }
  };

  /**
   * Give a claimed machine back — and ONLY a machine this session still holds.
   *
   * `release_voice_worker` is CAS'd on (app, machine_id, session); the two
   * steps after it are not. `stopMachine` kills whatever is running on that
   * machine and `reset_voice_worker` is documented "unconditional on
   * session/epoch by design", so running them for a claim we no longer hold
   * stops SOMEBODY ELSE'S live call and marks their lease free for a third
   * session to claim.
   *
   * That is reachable: this runs on the failure exits of `ensureReadyWorker`,
   * up to two minutes after the claim, and in between the reaper can stop and
   * reset our machine (our session's room has no participants yet, so the
   * liveness check cannot spare it) and the next dial can claim it. At a
   * saturated pool, "the next dial" is always waiting.
   *
   * So the release is the AUTHORITY, not a formality: only a `draining` answer
   * proves the claim was still ours, and only then do we stop anything.
   * Anything else — `already_released`, an unexpected status, a transport
   * throw — means we cannot prove ownership, and the machine is left to the
   * reaper, which is the designed backstop for exactly this.
   */
  async function cleanupClaim(app: string, machineId: string, sessionId: string): Promise<void> {
    let held = false;
    try {
      const released = envelope(
        'release_voice_worker',
        await deps.rpc('release_voice_worker', {
          p_app: app,
          p_machine_id: machineId,
          p_session_id: sessionId,
          p_now: new Date(now()).toISOString(),
        }),
      );
      held = released.status === 'draining';
    } catch {
      /* fail-open: reaper backstops. `held` stays false — we stop nothing. */
    }
    if (!held) {
      // Not ours (or unprovable). Stopping here would be the destructive act.
      event('cleanup_not_held', { app });
      return;
    }
    try {
      await deps.fly.stopMachine(app, machineId);
    } catch {
      // Could not stop it; do NOT reset a machine we did not confirm stopped —
      // that would return a still-running machine to the claimable pool.
      event('cleanup_stop_failed', { app });
      return;
    }
    try {
      await deps.rpc('reset_voice_worker', {
        p_app: app,
        p_machine_id: machineId,
        p_now: new Date(now()).toISOString(),
      });
    } catch {
      /* fail-open: reaper backstops */
    }
  }

  async function ensureReadyWorker(input: {
    app: string;
    pipeline: 'phone' | 'browser';
    sessionId: string;
    epoch?: number | null;
    readyTimeoutSec?: number;
  }): Promise<EnsureReadyResult> {
    if (!enabled) return { status: 'disabled' };

    const { app, pipeline, sessionId } = input;
    const readyTimeoutMs = boundReadyTimeout(input.readyTimeoutSec);

    // ── 1. Claim a stopped machine atomically. ──────────────────────────
    let machineId: string;
    let epoch: number;
    try {
      const claim = envelope(
        'claim_voice_worker',
        await deps.rpc('claim_voice_worker', {
          p_app: app,
          p_pipeline: pipeline,
          p_session_id: sessionId,
          p_epoch: input.epoch ?? null,
          p_now: new Date(now()).toISOString(),
        }),
      );
      if (claim.status === 'no_capacity') {
        event('no_capacity', { app });
        return { status: 'no_capacity' };
      }
      if (claim.status !== 'claimed'
          || typeof claim.machine_id !== 'string'
          || typeof claim.epoch !== 'number') {
        event('claim_unexpected', { app });
        return { status: 'error', code: 'claim_failed' };
      }
      machineId = claim.machine_id;
      epoch = claim.epoch;
    } catch {
      event('claim_error', { app });
      return { status: 'error', code: 'claim_error' };
    }

    // From here on a machine is claimed. EVERY failure exit must clean it up
    // (I2) and must NOT return 'ready' (I1).

    // ── 2. Start the machine and wait for the Fly-reported `started`. ────
    try {
      await deps.fly.startMachine(app, machineId);
      await deps.fly.waitForState(app, machineId, 'started', startWaitSec);
    } catch (err) {
      const code = isFlyMachinesError(err) ? err.code : 'fly_error';
      event('start_failed', { app, code });
      await cleanupClaim(app, machineId, sessionId);
      // A start timeout is a timeout; any other Fly failure is an error. Both
      // are non-ready, so the caller defers/retries and never dials.
      return code === 'timeout'
        ? { status: 'timeout' }
        : { status: 'error', code };
    }

    // ── 3. Poll the lease until it is `ready`, or the wall-clock budget. ─
    // The worker posts /internal/voice-worker/ready on LiveKit registration →
    // mark_voice_worker_ready flips the lease to 'ready'. We NEVER return ready
    // until we have READ that state (I1). A poll read error is treated as
    // not-ready-yet and simply retried within the budget.
    const deadline = now() + readyTimeoutMs;
    let observedReady = false;
    let claimLost = false;

    /**
     * Believe a lease read only while the row is still OUR claim.
     *
     * A row carrying another session, or a HIGHER epoch, has been re-claimed
     * out from under this poll and nothing on it is ours to act on — not even
     * a `ready`. A row that has gone `stopped` (null session) is merely not
     * ready yet from our side; the cleanup path handles it and the CAS in
     * `release_voice_worker` makes a late release harmless. Reading `null`
     * state (no row) is likewise just "not yet".
     */
    const verdict = (snap: LeaseStateSnapshot): 'ready' | 'lost' | 'waiting' => {
      if (snap.claimedSessionId !== null && snap.claimedSessionId !== sessionId) return 'lost';
      if (typeof snap.epoch === 'number' && snap.epoch > epoch) return 'lost';
      // 'busy' can only be reached from 'ready' (mark_voice_worker_busy CAS),
      // so observing it also satisfies "was confirmed ready".
      return snap.state === 'ready' || snap.state === 'busy' ? 'ready' : 'waiting';
    };

    // Read once immediately, then poll until the deadline.
    // (A first read before the initial sleep avoids waiting a full cadence when
    // the worker was already ready — e.g. a warm-standby machine.)
    for (;;) {
      let seen: 'ready' | 'lost' | 'waiting' = 'waiting';
      try {
        seen = verdict(await deps.readLeaseState({ app, machineId }));
      } catch {
        seen = 'waiting'; // transient; retry within budget
      }
      if (seen === 'ready') {
        observedReady = true;
        break;
      }
      if (seen === 'lost') {
        claimLost = true;
        break;
      }
      if (now() >= deadline) break;
      await sleep(readyPollMs);
      if (now() >= deadline) {
        // One last read after the final sleep, so a ready that landed during
        // the sleep is not missed.
        try {
          const last = verdict(await deps.readLeaseState({ app, machineId }));
          if (last === 'ready') observedReady = true;
          if (last === 'lost') claimLost = true;
        } catch {
          /* keep observedReady false */
        }
        break;
      }
    }

    if (claimLost) {
      // ── 4a. Somebody else owns this machine now. ────────────────────
      // Deliberately NOT a `ready`: the readiness we may have just seen is
      // theirs.
      //
      // AND DELIBERATELY NO TEARDOWN. The obvious move — "cleanup is safe, the
      // release CAS will answer `already_released`" — is WRONG for half the
      // cases that get here. `release_voice_worker` (0079) matches on
      // `(app, machine_id, claimed_session_id)` and NOT on epoch, so when the
      // same session re-claimed the same machine at a higher epoch the row
      // still matches ours: release answers `draining`, the teardown believes
      // it holds the claim, and it stops the machine the NEWER claim just
      // booted. (`claim_voice_worker` orders `by machine_id limit 1`, so a
      // re-claim deterministically prefers the same machine — this is not a
      // rare interleaving.)
      //
      // We could not prove ownership from the lease read, so we do not act on
      // the lease at all. The machine belongs to whoever holds it now; if that
      // claim is itself dead, the reaper is the thing designed to notice.
      event('claim_lost', { app });
      return { status: 'timeout' };
    }

    if (!observedReady) {
      // ── 4b. Readiness timeout → clean up, return timeout (never ready). ─
      event('ready_timeout', { app });
      await cleanupClaim(app, machineId, sessionId);
      return { status: 'timeout' };
    }

    // Confirmed ready. This is the ONLY place 'ready' is returned, and only
    // after a ready/busy lease read. `epoch` is intentionally not surfaced to
    // the caller here — the caller re-reads it via the lease if it needs to
    // mark_busy; the invariant is satisfied by the state observation.
    void epoch;
    event('ready', { app });
    return { status: 'ready', machineId };
  }

  async function releaseWorker(input: {
    app: string;
    machineId: string;
    sessionId: string;
  }): Promise<void> {
    if (!enabled) return;
    const { app, machineId, sessionId } = input;
    // release → stop → reset, in that order. The order matters: release drops
    // the claim (so the reaper won't fight us), stop halts the cost, reset
    // returns the row to the stopped pool.
    //
    // Routed through the SAME ownership proof the claim teardown uses, and for
    // the same reason: `stopMachine` and `reset_voice_worker` are both
    // unfenced, so running them for a claim that has moved on stops somebody
    // else's live call. This path's window is shorter — the claim is seconds
    // old, not two minutes — but "shorter" is not an argument for keeping the
    // destructive version of a sequence we already have a safe version of.
    await cleanupClaim(app, machineId, sessionId);
  }

  /**
   * Drain a session's lease, then stop + reset the machine it named. Shared by
   * the terminal handler (`releaseWorkerBySession`) and the prompt-release pass
   * (`releaseTerminalSessions`).
   *
   * ── P4: FAIL-OPEN IS NOT FAIL-SILENT, AND `released` MEANS STOPPED ─────
   * Every step is still fail-open (the reaper backstops), but each failure now
   * emits a DISTINCT event so a swallowed error is observable rather than
   * invisible. And the return distinguishes THREE outcomes so the pass can count
   * honestly:
   *   * `{ stopped: null }`           — no live claim / no machine id / release
   *                                     RPC threw. Nothing was stopped.
   *   * `{ stopped: id }`             — the machine was CONFIRMED stopped. Only
   *                                     this counts toward `released`.
   *   * `{ stopped: null, stopFailedMachineId: id }` — a machine was named but
   *                                     the Fly stop threw. It is STILL RUNNING;
   *                                     it must NOT count as released. The
   *                                     reaper (or the next pass) retries.
   * The old code returned the machine id even when the stop threw, so
   * `releaseTerminalSessions` counted a still-running machine as `released` and
   * reported success while cost kept accruing — the exact fail-open-as-success
   * defect P4 flags.
   */
  async function drainSessionLease(
    app: string,
    sessionId: string,
  ): Promise<{ stopped: string | null; stopFailedMachineId?: string }> {
    let machineId: string | null = null;
    try {
      const res = envelope(
        'release_voice_worker_by_session',
        await deps.rpc('release_voice_worker_by_session', {
          p_app: app,
          p_session_id: sessionId,
          p_now: new Date(now()).toISOString(),
        }),
      );
      // 'already_released' carries no machine id (idempotent): nothing to stop.
      if (res.status === 'draining' && typeof res.machine_id === 'string') {
        machineId = res.machine_id;
      }
    } catch {
      // The release RPC threw. Distinct event so it is not silently swallowed;
      // the reaper backstops. Nothing to stop and nothing released.
      event('terminal_release_rpc_error', { app });
      return { stopped: null };
    }
    if (machineId === null) return { stopped: null };
    try {
      await deps.fly.stopMachine(app, machineId);
    } catch {
      // Could not stop — the machine is STILL RUNNING. Do NOT reset a row we did
      // not confirm stopped, and do NOT count it released. Emit a distinct event
      // and hand back the machine id under `stopFailedMachineId` so the pass can
      // tally it separately. The lease is 'draining', which the reaper treats as
      // reapable, and the next pass retries.
      event('terminal_release_stop_failed', { app, machineId });
      return { stopped: null, stopFailedMachineId: machineId };
    }
    try {
      await deps.rpc('reset_voice_worker', {
        p_app: app,
        p_machine_id: machineId,
        p_now: new Date(now()).toISOString(),
      });
    } catch {
      // The machine IS stopped (cost is halted), only the pool-row reset failed.
      // Distinct event; the row can be reset on a later pass. Still counts as
      // released — the expensive thing (a running machine) is gone.
      event('terminal_release_reset_failed', { app, machineId });
    }
    return { stopped: machineId };
  }

  async function releaseWorkerBySession(input: {
    app: string;
    sessionId: string;
  }): Promise<void> {
    if (!enabled) return;
    await drainSessionLease(input.app, input.sessionId);
  }

  async function releaseTerminalSessions(input: {
    app: string;
  }): Promise<ReleaseTerminalResult> {
    if (!enabled) return { released: 0, disabled: true };
    const { app } = input;

    let sessions: string[];
    try {
      const raw = await deps.rpc('list_terminal_session_leases', {
        p_app: app,
        p_limit: reapMaxPerRun,
      });
      if (raw.error) throw new Error('list_error');
      const rows = Array.isArray(raw.data) ? raw.data : [];
      sessions = rows
        .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
        .map((r) => (typeof r.claimed_session_id === 'string' ? r.claimed_session_id : ''))
        .filter((s) => s !== '');
    } catch {
      event('terminal_release_list_error', { app });
      return { released: 0 };
    }

    let released = 0;
    let stopFailed = 0;
    let scanned = 0;
    for (const sessionId of sessions) {
      if (scanned >= reapMaxPerRun) break;
      scanned += 1;
      const outcome = await drainSessionLease(app, sessionId);
      // Count `released` ONLY on a confirmed stop. A named-but-not-stopped
      // machine is tallied separately as `stopFailed` (it is still running); the
      // per-session `terminal_release_stop_failed` event already fired.
      if (outcome.stopped !== null) released += 1;
      else if (outcome.stopFailedMachineId !== undefined) stopFailed += 1;
    }
    event('terminal_release_swept', { app, released, stopFailed, scanned });
    return { released };
  }

  async function markBusy(input: {
    app: string;
    machineId: string;
    sessionId: string;
    epoch: number;
  }): Promise<void> {
    if (!enabled) return;
    try {
      await deps.rpc('mark_voice_worker_busy', {
        p_app: input.app,
        p_machine_id: input.machineId,
        p_session_id: input.sessionId,
        p_epoch: input.epoch,
        p_now: new Date(now()).toISOString(),
      });
    } catch {
      /* best-effort: the lease is already 'ready', which the reaper spares */
    }
  }

  async function reapWorkers(input: { app: string }): Promise<ReapResult> {
    if (!enabled) return { stopped: 0, disabled: true };
    const { app } = input;

    // The cost-safety backstop (§2.5). List stale non-stopped machines; for
    // each, ask LiveKit whether the claimed session's room is still LIVE. A
    // machine with no live room (or no claim) beyond grace is always stopped.
    let candidates: Array<{ machineId: string; claimedSessionId: string | null; state: string }>;
    try {
      const raw = await deps.rpc('list_reapable_voice_workers', {
        p_app: app,
        p_grace_sec: env.workerReaperGraceSec,
        p_now: new Date(now()).toISOString(),
      });
      if (raw.error) throw new Error('list_error');
      const rows = Array.isArray(raw.data) ? raw.data : [];
      candidates = rows
        .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
        .map((r) => ({
          machineId: typeof r.machine_id === 'string' ? r.machine_id : '',
          claimedSessionId: typeof r.claimed_session_id === 'string' ? r.claimed_session_id : null,
          state: typeof r.state === 'string' ? r.state : '',
        }))
        .filter((r) => r.machineId !== '');
    } catch {
      event('reap_list_error', { app });
      return { stopped: 0 };
    }

    let stopped = 0;
    let scanned = 0;
    for (const c of candidates) {
      if (scanned >= reapMaxPerRun) break; // bounded per run
      scanned += 1;

      // Is the claimed session's room still live? A row with no claim is by
      // definition a leaked started machine — reap it. A row with a claim is
      // spared IFF its room currently has participants. A THROW from the room
      // check means "unknown" → SPARE (never stop on an unproven-dead room).
      let live = false;
      if (c.claimedSessionId !== null) {
        try {
          live = await deps.roomIsLive(roomNameForSession(c.claimedSessionId));
        } catch (err) {
          // ── A ROOM THAT IS GONE IS NOT "UNKNOWN" ──────────────────────
          // The rule is never to stop on an UNPROVEN-dead room, and a
          // `not_found` proves the opposite of unknown: the room has already
          // been torn down, so nobody is in it. Reading that as unknown is how
          // a lease survives with a 32-hour-dead heartbeat while its machine
          // burns — the reaper asks about a room that no longer exists, gets a
          // throw, and declines to act, on every pass, for ever. One such
          // lease held half a two-machine pool for four days.
          //
          // Classified HERE rather than inside the checker so the rule holds
          // for every injected `RoomLivenessChecker`, and so it is reachable
          // from a test that does not need the LiveKit SDK.
          if (!isRoomNotFound(err)) {
            // Anything else really is unknown — a transport failure proves
            // nothing about the room. Spare it this pass.
            continue;
          }
          live = false;
        }
      }
      if (live) continue; // a live room is real work; leave it alone.

      // No live room (or no claim) beyond grace → stop + reset.
      try {
        await deps.fly.stopMachine(app, c.machineId);
      } catch {
        // Could not stop this one; leave the lease as-is so the next pass
        // retries. Do NOT reset a machine we did not confirm stopped.
        continue;
      }
      try {
        await deps.rpc('reset_voice_worker', {
          p_app: app,
          p_machine_id: c.machineId,
          p_now: new Date(now()).toISOString(),
        });
      } catch {
        /* fail-open: the row can be reset on a later pass */
      }
      stopped += 1;
    }

    event('reap_swept', { app, stopped, scanned });

    // ── T2③ ORPHAN SWEEP (the reaper blind spot) ────────────────────────────
    // The sweep above only sees NON-stopped leases. A pool machine that leaked
    // `started` on Fly while its lease reads `stopped` (a manual start, prewarm,
    // or secret-update restart) is invisible to it and burns VM-hours forever
    // (observed ≥4×). This second sweep closes that hole conservatively:
    //   1. `list_orphaned_voice_worker_leases` returns MANAGED pool machines
    //      (they HAVE a lease row for this app — so unmanaged always-on
    //      browser/API machines, which have NO row, can NEVER be candidates)
    //      whose lease is `stopped` AND untouched for `orphanGraceSec` (the race
    //      guard: a machine mid-claim moved its lease within seconds, so it is
    //      excluded).
    //   2. We read Fly's ACTUAL machine state ONCE (`listMachines`) and stop a
    //      candidate ONLY when Fly reports it EXACTLY `started`. A transitional
    //      `starting`/`stopping` is skipped (a claim may be bringing it up right
    //      now); a `stopped`/`destroyed`/`suspended` is a false alarm (the DB was
    //      right) and left alone.
    //   3. Stop → reset via the SAME path a normal reap uses. Reset returns the
    //      row to the clean stopped pool.
    // There is deliberately NO room-liveness check here: an orphan by definition
    // holds no claimed session (its lease is `stopped`), so there is no session
    // room to consult — the long-idle guard is what makes stopping safe. Bounded
    // by the same per-run cap (shared budget with the sweep above).
    let orphanCandidates: Array<{ machineId: string }>;
    try {
      const raw = await deps.rpc('list_orphaned_voice_worker_leases', {
        p_app: app,
        p_grace_sec: orphanGraceSec,
        p_now: new Date(now()).toISOString(),
      });
      if (raw.error) throw new Error('list_error');
      const rows = Array.isArray(raw.data) ? raw.data : [];
      orphanCandidates = rows
        .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
        .map((r) => ({ machineId: typeof r.machine_id === 'string' ? r.machine_id : '' }))
        .filter((r) => r.machineId !== '');
    } catch {
      // A failed orphan-candidate read must not lose the sweep's own result.
      event('orphan_list_error', { app });
      return { stopped };
    }

    if (orphanCandidates.length > 0 && scanned < reapMaxPerRun) {
      // Read Fly's actual machine states ONCE for the whole app. A THROW here is
      // "unknown" for every candidate → stop nothing this pass (the DB believing
      // a machine stopped is not, by itself, proof it is running).
      let flyStateById: Map<string, string> | null = null;
      try {
        const machines = await deps.fly.listMachines(app);
        flyStateById = new Map(
          (Array.isArray(machines) ? machines : []).map((m) => [m.id, m.state]),
        );
      } catch {
        event('orphan_fly_list_error', { app });
        flyStateById = null;
      }

      let orphansStopped = 0;
      if (flyStateById !== null) {
        for (const c of orphanCandidates) {
          if (scanned >= reapMaxPerRun) break; // shared bounded budget
          scanned += 1;
          // Stop ONLY a machine Fly reports EXACTLY `started`. Absent from the
          // list (id not found) or any non-`started` state → skip: either Fly
          // agrees it is stopped (false alarm) or it is transitional (a
          // concurrent claim may own it). Never stop on a guess.
          const flyState = flyStateById.get(c.machineId);
          if (flyState !== 'started') continue;
          try {
            await deps.fly.stopMachine(app, c.machineId);
          } catch {
            // Could not stop — leave the lease as-is; the next pass retries. Do
            // NOT reset a machine we did not confirm stopped.
            continue;
          }
          try {
            await deps.rpc('reset_voice_worker', {
              p_app: app,
              p_machine_id: c.machineId,
              p_now: new Date(now()).toISOString(),
            });
          } catch {
            /* fail-open: the row can be reset on a later pass */
          }
          orphansStopped += 1;
          stopped += 1;
        }
      }
      event('orphan_swept', { app, orphansStopped, candidates: orphanCandidates.length });
    }

    return { stopped };
  }

  return {
    ensureReadyWorker,
    releaseWorker,
    releaseWorkerBySession,
    releaseTerminalSessions,
    markBusy,
    reapWorkers,
  };
}

function boundReadyTimeout(readyTimeoutSec: number | undefined): number {
  const ms = typeof readyTimeoutSec === 'number' && Number.isFinite(readyTimeoutSec)
    ? Math.round(readyTimeoutSec * 1000)
    : DEFAULT_READY_TIMEOUT_MS;
  if (ms < MIN_READY_TIMEOUT_MS) return MIN_READY_TIMEOUT_MS;
  if (ms > MAX_READY_TIMEOUT_MS) return MAX_READY_TIMEOUT_MS;
  return ms;
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * Build the service from the real env + service-role client. Inert unless
 * `env.workerOrchestration` is true (every entry point checks first). The Fly
 * client fails closed on a blank token; the lease reader reads the
 * service-role-only `voice_worker_leases` table directly (no read RPC exists in
 * 0079); the room-liveness check lazily constructs a LiveKit RoomServiceClient
 * from the EXISTING credentials and reports a room live iff it has participants.
 */
export function createDefaultWorkerOrchestrationService(
  overrides: {
    /**
     * Room-name scheme for the reaper's liveness cross-check. Defaults to the
     * phone naming (`phone-<sessionId>`). The browser pipeline injects its own
     * (`screening-<sessionId>`) so a browser reap checks the correct LiveKit
     * room. Only the reaper reads this; ensure/release never derive a room name.
     */
    roomNameForSession?: (sessionId: string) => string;
  } = {},
): WorkerOrchestrationService {
  const client = supabase as unknown as SupabaseClient;
  const fly = createFlyMachinesClient({
    token: env.flyApiToken,
    baseUrl: env.flyApiBaseUrl,
  });

  const rpc: RpcCaller = async (name, args) => {
    const { data, error } = await client.rpc(name, args);
    return { data, error: error ? { message: error.message } : null };
  };

  const readLeaseState: LeaseStateReader = async ({ app, machineId }) => {
    const { data, error } = await client
      .from('voice_worker_leases')
      .select('state, claimed_session_id, epoch')
      .eq('app', app)
      .eq('machine_id', machineId)
      .maybeSingle();
    if (error) throw new Error('lease_read_error');
    const row = data as {
      state?: unknown;
      claimed_session_id?: unknown;
      epoch?: unknown;
    } | null;
    return {
      state: typeof row?.state === 'string' ? row.state : null,
      claimedSessionId:
        typeof row?.claimed_session_id === 'string' ? row.claimed_session_id : null,
      // `epoch` is a bigint; PostgREST hands bigints back as strings on some
      // driver versions, so accept both and refuse to guess on anything else —
      // an unparsed epoch must read as "no fence available", not as zero.
      epoch: typeof row?.epoch === 'number'
        ? row.epoch
        : typeof row?.epoch === 'string' && /^\d+$/.test(row.epoch)
          ? Number(row.epoch)
          : null,
    };
  };

  // The LiveKit RoomServiceClient is imported lazily on first use, so a
  // deployment that never reaps never loads the SDK. A room is LIVE iff it has
  // at least one participant.
  //
  // It REJECTS rather than inventing, including for a room that no longer
  // exists — `listParticipants` throws `not_found` for that. The reaper
  // classifies the rejection (see `isRoomNotFound` at its call site): a missing
  // room is empty, anything else is genuinely unknown and spares the machine.
  // An earlier comment here claimed this checker performed that translation
  // itself. It did not, and it should not — putting the rule in the reaper
  // makes it hold for every injected checker, not just this one.
  let roomClient: { listParticipants(room: string): Promise<Array<unknown>> } | undefined;
  const roomIsLive: RoomLivenessChecker = async (roomName) => {
    if (!roomClient) {
      const { RoomServiceClient } = await import('livekit-server-sdk');
      roomClient = new RoomServiceClient(
        env.livekitUrl,
        env.livekitApiKey,
        env.livekitApiSecret,
      ) as unknown as { listParticipants(room: string): Promise<Array<unknown>> };
    }
    const participants = await roomClient.listParticipants(roomName);
    return Array.isArray(participants) && participants.length > 0;
  };

  return createWorkerOrchestrationService({
    enabled: env.workerOrchestration,
    rpc,
    fly,
    readLeaseState,
    roomIsLive,
    ...(overrides.roomNameForSession
      ? { roomNameForSession: overrides.roomNameForSession }
      : {}),
  });
}
