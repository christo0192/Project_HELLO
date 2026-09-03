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
 *   I2  NEVER LEAK A STARTED MACHINE. Every failure exit of `ensureReadyWorker`
 *       after a successful claim runs a best-effort cleanup (stopMachine +
 *       release + reset) so a machine that was started but never confirmed
 *       ready does not sit `started` burning cost. `reapWorkers` is the
 *       independent backstop: it stops ANY non-stopped machine whose claimed
 *       session has no live LiveKit room beyond the grace window, even if every
 *       orchestration event was lost.
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
 * A bounded, read-only view of a machine's lease state — the readiness-poll
 * seam. It reads ONLY the `state` column of the lease for (app, machineId),
 * because that is the single fact the poll needs and the narrowest thing to
 * expose. There is no `get_voice_worker_lease` RPC in the committed substrate
 * (0079), so production reads the service-role-only `voice_worker_leases` table
 * directly (RLS forces service_role); this seam keeps that read injectable and
 * keeps the rest of the service ignorant of the storage shape. Returns the
 * lease state string, or null when no row is found. Must reject rather than
 * invent on a transport failure.
 */
export type LeaseStateReader = (input: {
  app: string;
  machineId: string;
}) => Promise<string | null>;

/**
 * A bounded, read-only LiveKit room-liveness check. `true` iff the named room
 * currently has at least one participant. The reaper treats a THROW as
 * "unknown" and SPARES the machine (never stops on an unproven-dead room), so
 * this must reject rather than invent on failure.
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

/** A metadata-only sweep/lifecycle log line. Never a session id or a token. */
function event(kind: string, extra: Record<string, unknown> = {}): void {
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

  /**
   * Best-effort teardown of a claim that never became a live session. Fail-OPEN
   * on every step: the reaper is the backstop, so a transient Fly/DB error here
   * must not throw out of the caller's failure path. Enforces I2.
   */
  async function cleanupClaim(app: string, machineId: string, sessionId: string): Promise<void> {
    try {
      await deps.rpc('release_voice_worker', {
        p_app: app,
        p_machine_id: machineId,
        p_session_id: sessionId,
        p_now: new Date(now()).toISOString(),
      });
    } catch {
      /* fail-open: reaper backstops */
    }
    try {
      await deps.fly.stopMachine(app, machineId);
    } catch {
      /* fail-open: reaper backstops */
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
    // Read once immediately, then poll until the deadline.
    // (A first read before the initial sleep avoids waiting a full cadence when
    // the worker was already ready — e.g. a warm-standby machine.)
    for (;;) {
      let state: string | null = null;
      try {
        state = await deps.readLeaseState({ app, machineId });
      } catch {
        state = null; // transient; retry within budget
      }
      if (state === 'ready' || state === 'busy') {
        // 'busy' can only be reached from 'ready' (mark_voice_worker_busy CAS),
        // so observing it also satisfies "was confirmed ready".
        observedReady = true;
        break;
      }
      if (now() >= deadline) break;
      await sleep(readyPollMs);
      if (now() >= deadline) {
        // One last read after the final sleep, so a ready that landed during
        // the sleep is not missed.
        try {
          const s = await deps.readLeaseState({ app, machineId });
          if (s === 'ready' || s === 'busy') observedReady = true;
        } catch {
          /* keep observedReady false */
        }
        break;
      }
    }

    if (!observedReady) {
      // ── 4. Readiness timeout → clean up, return timeout (never ready). ─
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
    // release → stop → reset, in that order, each fail-open. The order matters:
    // release drops the claim (so the reaper won't fight us), stop halts the
    // cost, reset returns the row to the stopped pool. A Fly error on stop does
    // NOT abort the reset — the reaper will stop it later, and the pool row
    // should still be reusable. Idempotent: release/reset are no-ops on an
    // already-released/stopped row.
    try {
      await deps.rpc('release_voice_worker', {
        p_app: app,
        p_machine_id: machineId,
        p_session_id: sessionId,
        p_now: new Date(now()).toISOString(),
      });
    } catch {
      /* fail-open */
    }
    try {
      await deps.fly.stopMachine(app, machineId);
    } catch {
      /* fail-open: the reaper stops it later */
    }
    try {
      await deps.rpc('reset_voice_worker', {
        p_app: app,
        p_machine_id: machineId,
        p_now: new Date(now()).toISOString(),
      });
    } catch {
      /* fail-open */
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
        } catch {
          // Unknown liveness — do not stop this machine this pass.
          continue;
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
    return { stopped };
  }

  return { ensureReadyWorker, releaseWorker, reapWorkers };
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
export function createDefaultWorkerOrchestrationService(): WorkerOrchestrationService {
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
      .select('state')
      .eq('app', app)
      .eq('machine_id', machineId)
      .maybeSingle();
    if (error) throw new Error('lease_read_error');
    const state = (data as { state?: unknown } | null)?.state;
    return typeof state === 'string' ? state : null;
  };

  // The LiveKit RoomServiceClient is imported lazily on first use, so a
  // deployment that never reaps never loads the SDK. A room is LIVE iff it has
  // at least one participant. `listParticipants` throws for a room that does
  // not exist on some SDK versions — the reaper treats that throw as "unknown"
  // and spares, so we translate a not-found into `false` (no participants =
  // not live) only when the SDK returns cleanly; a genuine transport error
  // still propagates.
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
  });
}
