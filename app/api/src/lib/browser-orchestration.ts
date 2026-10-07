/**
 * lib/browser-orchestration.ts — the BROWSER (WebRTC) side of on-demand Fly
 * worker orchestration (design §2.3b, option B-i).
 *
 * ── WHAT THIS ADDS, AND THE ONE CONSTRAINT IT GUARDS ──────────────────
 * The browser worker (`project-hello-voice`) is UNNAMED today and
 * auto-dispatches into EVERY screening room. Naming it silently STOPS that
 * auto-dispatch — so naming and explicit dispatch MUST be introduced together,
 * behind the SAME flag. This module is the API half of that pairing:
 *
 *   - OFF (default): `browserOrchestrationGate()` returns `null`. The exchange
 *     flow never consults it, mints the join token exactly as today, and the
 *     unnamed worker auto-dispatches. BYTE-IDENTICAL to today.
 *   - ON (`workerOrchestration` true AND `browserAgentName` set): the gate is
 *     built. The exchange flow (1) `ensureReadyWorker` for the session —
 *     READY-BEFORE-DISPATCH — then (2) explicitly `createDispatch`es the NAMED
 *     browser worker into the room, then (3) mints the join token. A non-ready
 *     verdict returns a "preparing/try-again" status and NO token.
 *
 * ── names_agree (PR100 lesson) ────────────────────────────────────────
 * The name the API dispatches to (`browserAgentName`) is the name the worker
 * registers under. There is no second source of truth here — the API only
 * knows its own configured name — so the check this module can make is that the
 * name is a well-formed, non-empty dispatch name before it is used. The
 * worker-side agreement (the worker actually registered under this exact name)
 * is asserted at the worker (agent.py `_browser_agent_name`) and surfaced by a
 * failed dispatch (the room would otherwise sit agent-less). We fail LOUDLY on
 * a malformed/absent name rather than silently dispatching to nothing.
 *
 * ── REAPER ROOM NAMING ────────────────────────────────────────────────
 * The orchestration service's reaper cross-checks LiveKit for a live room per
 * claimed session. Its default room-name scheme is the PHONE one
 * (`phone-<sessionId>`); a browser session's room is `screening-<sessionId>`.
 * `createBrowserWorkerOrchestrationService` injects `roomNameForSession =
 * roomNameForSession` (browser) so a browser reap checks the right room.
 *
 * ── R1-ONLY BEHAVIOUR (PR-LK-liveness) ────────────────────────────────
 * The production Cloud browser app is ALREADY a named, orchestrated worker, so
 * everything added for the self-hosted R1 SFU is gated on
 * `browserLiveKitEndpoint().target === 'r1'`. With any other target (the
 * default) this module is byte-identical to origin/main:
 *
 *   - READY HOST MATCH: an R1 ready lease is admitted only when its durable
 *     `livekit_host` equals the hostname of the R1 endpoint. Cloud never looks
 *     at the host (workers do not report one unless `R1_READINESS_HOST=on`).
 *   - DISPATCH-DROP SAFEGUARD: the OSS dispatch drop observed in spike S0-F3
 *     (a dispatch that stays job-less) is verified, retired and retried once on
 *     R1. Nothing proves LiveKit Cloud reports `state.jobs` on the same
 *     timeline, so Cloud keeps its single `createDispatch` and never lists or
 *     deletes a dispatch.
 *   - NEVER TWO AGENTS: a dispatch is only re-issued after the old one is
 *     deleted AND no dispatch in the room owns a LIVE job (a finished job does
 *     not count) AND no agent participant is in the room. A final dropped retry
 *     is deleted too.
 *   - FAIL CLOSED: on R1 only a proven assignment mints a token. A dispatch the
 *     safeguard cannot verify (no id, no listDispatch, a list error, a dispatch
 *     that vanished) answers false: the machine is released and the exchange
 *     defers; nothing is re-dispatched on an unproven room.
 */

import { env } from './env.js';
import {
  createDefaultWorkerOrchestrationService,
  type WorkerOrchestrationService,
  type EnsureReadyResult,
} from './worker-orchestration.js';
import { BROWSER_FLY_APP } from './worker-orchestration-runtime.js';
import { roomNameForSession } from './room-provisioning.js';
import { createLogger } from './logger.js';
import {
  agentDispatchClientFor,
  browserLiveKitEndpoint,
  requireBrowserLiveKitConfigured,
  roomServiceClientFor,
} from './livekit-endpoints.js';

const log = createLogger('browser-orchestration');

/** A dispatch name is a bounded, opaque slug — never a secret, never PII. */
const BROWSER_AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * One dispatch as the safeguard reads it. `state.jobs` is populated by the
 * server only once a worker has accepted the dispatch's JobRequest, and each
 * job carries a `state.status` (protocol `JobStatus`). `state.deletedAt` is the
 * protocol's int64 tombstone timestamp: 0 / absent while the dispatch is live.
 */
interface DispatchRecordLike {
  id?: string;
  state?: { jobs?: unknown[]; deletedAt?: bigint | number | string };
}

/** The narrow dispatch seam this module needs. */
export interface BrowserAgentDispatchClientLike {
  createDispatch(
    roomName: string,
    agentName: string,
    options?: { metadata?: string },
  ): Promise<{ id?: string } | unknown>;
  /**
   * R1 safeguard only. Absent (mocks/older clients) means "cannot verify", which
   * on R1 fails closed (no token). The real SDK client always provides both.
   */
  listDispatch?(roomName: string): Promise<DispatchRecordLike[]>;
  deleteDispatch?(dispatchId: string, roomName: string): Promise<void>;
}

export interface BrowserWorkerGate {
  /** The Fly app the browser worker pool lives in. */
  readonly app: string;
  /** The dispatch name the API createDispatches to (== the worker's name). */
  readonly agentName: string;
  /**
   * Confirm a ready on-demand worker for this session (READY-BEFORE-DISPATCH).
   * `disabled` is the service's own flag-off answer; a caller treats it exactly
   * like an absent gate (proceed as today) on Cloud. Every other non-`ready`
   * verdict DEFERS: the caller returns a "preparing" status and mints NO token.
   */
  ensureReadyWorker(input: { sessionId: string }): Promise<EnsureReadyResult>;
  /**
   * Explicitly dispatch the NAMED browser worker into the session's room.
   * Called ONLY after `ensureReadyWorker` returned `ready`. Returns true on a
   * successful dispatch; false means the room has no agent (the caller must NOT
   * mint a token into an agent-less room). On the R1 target true additionally
   * means the dispatch was PROVEN accepted by a worker; an unverifiable dispatch
   * is false. Never throws.
   */
  dispatch(input: { sessionId: string; roomName: string }): Promise<boolean>;
  /** Best-effort release of a worker gated onto but then not used. Never throws. */
  releaseWorker(input: { machineId: string; sessionId: string }): Promise<void>;
}

export interface BrowserWorkerGateDeps {
  /** Master gate. Defaults to `env.workerOrchestration && browserAgentName set`. */
  readonly enabled?: boolean;
  /** The configured browser agent name. Defaults to `env.browserAgentName`. */
  readonly agentName?: string;
  /** The orchestration service (tests inject a fake). */
  readonly service?: WorkerOrchestrationService;
  /** The LiveKit agent-dispatch client (tests inject a fake; absent = lazy real). */
  readonly dispatchClient?: BrowserAgentDispatchClientLike;
  /**
   * R1 safeguard: is an AGENT-kind participant already in the room? Tests inject
   * a fake; absent = lazy real (`RoomServiceClient.listParticipants` on the
   * selected endpoint). A rejection means "cannot prove no agent", which blocks
   * the retry dispatch — it never permits one.
   */
  readonly roomHasAgent?: (roomName: string) => Promise<boolean>;
  /** Test seams; production uses bounded values below and never sleeps in tests. */
  readonly dispatchVerifyMs?: number;
  readonly dispatchPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * R1 dispatch acceptance window. It must outlast the worker SDK's server
 * assignment latency allowance (livekit-agents ASSIGNMENT_TIMEOUT = 7.5 s) or a
 * slow-but-alive dispatch would be judged dropped and deleted under its worker.
 * Default 10 s; an explicit positive BROWSER_DISPATCH_VERIFY_SEC is clamped to
 * 1..15 s (an operator value below 8 undercuts the SDK allowance on purpose).
 */
const DEFAULT_DISPATCH_VERIFY_MS = 10_000;
const MIN_DISPATCH_VERIFY_MS = 1_000;
const MAX_DISPATCH_VERIFY_MS = 15_000;
/** How long a deleted dispatch may linger in listDispatch before we give up. */
const RETIRE_VERIFY_MS = 3_000;

/**
 * The verification window in ms. UNSET, blank, whitespace, non-numeric,
 * non-finite, zero or negative all mean "no usable value" and yield the 10 s
 * default: a set-but-empty variable (`BROWSER_DISPATCH_VERIFY_SEC=`) is the usual
 * operator slip and must never degrade to the 1 s floor, which would judge a
 * slow-but-alive dispatch dropped. Only an explicit positive value is clamped.
 */
function boundedDispatchVerifyMs(): number {
  const raw = process.env.BROWSER_DISPATCH_VERIFY_SEC?.trim();
  if (raw === undefined || raw === '') return DEFAULT_DISPATCH_VERIFY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPATCH_VERIFY_MS;
  return Math.max(
    MIN_DISPATCH_VERIFY_MS,
    Math.min(MAX_DISPATCH_VERIFY_MS, Math.round(parsed * 1_000)),
  );
}

/** The production pause between dispatch polls; tests inject `deps.sleep`. */
function realSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function liveKitHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * R1 only. The ready lease must carry the EXACT host of the R1 endpoint: no
 * endpoint, no report, or a different host all fail closed.
 */
function r1ReadyHostMatches(
  reportedHost: string | null | undefined,
  expectedHost: string | null,
): boolean {
  return expectedHost !== null && reportedHost === expectedHost;
}

/** `ParticipantInfo_Kind.AGENT` (number), or its JSON spelling — see dial.ts. */
function isAgentParticipant(participant: unknown): boolean {
  const kind = (participant as { kind?: unknown } | null)?.kind;
  return kind === 4 || kind === 'AGENT';
}

/** Production agent-presence check for the retry safeguard (R1 endpoint). */
async function roomHasAgentOnBrowserEndpoint(roomName: string): Promise<boolean> {
  const client = roomServiceClientFor(requireBrowserLiveKitConfigured());
  const participants = await client.listParticipants(roomName);
  return Array.isArray(participants) && participants.some(isAgentParticipant);
}

function dispatchIdOf(dispatch: unknown): string | undefined {
  const id = (dispatch as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Does this protocol int64 timestamp say "set"? An int64 arrives as a bigint
 * (SDK), number or string (JSON); 0, absent, empty or anything that does not
 * parse to a positive integer means "not set".
 */
function isPositiveTimestamp(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  try {
    return BigInt(value as bigint | number | string) > 0n;
  } catch {
    return false;
  }
}

/**
 * Does this job still back a live agent? Protocol `JobStatus`: JS_PENDING (0)
 * and JS_RUNNING (1) are live, JS_SUCCESS (2) and JS_FAILED (3) are over. A job
 * whose `state.endedAt` (protocol int64 `JobState.ended_at`) is set is over too,
 * whatever its status field still says: the server stamps the end time itself,
 * so a positive value is proof the job finished. A job with no `state`
 * (proto3 default = JS_PENDING) or an unrecognised status and no end time is
 * treated as LIVE: this predicate only ever relaxes "an agent exists" for a job
 * that is positively finished, so it can never add a second agent. A finished
 * job left behind by an earlier exchange for the same room must not make a new
 * dispatch look accepted. Exported so the R1 exchange's worker gate
 * (lib/r1/worker-gate.ts) reads "a worker owns this room" through the SAME
 * predicate: a dead job must not make a rejoin look like a running interviewer.
 *
 * RESIDUAL (R1, two failures in a row; cannot happen on Cloud): a job orphaned
 * by a stopped machine that the OSS server leaves at JS_RUNNING with NO end time
 * still reads live here, so the next exchange could be answered `assigned`
 * before its own dispatch is accepted. Whether OSS does that is an open S0-F3
 * observation (docs/runbooks/r1-operations.md, "S0-F3 dispatch-matrix rerun");
 * the "any dispatch" rule itself is deliberate and must not be narrowed blindly.
 */
export function jobIsLive(job: unknown): boolean {
  const state = (job as { state?: { status?: unknown; endedAt?: unknown } } | null)?.state;
  const status = state?.status;
  if (
    status === 2 ||
    status === 3 ||
    status === 'JS_SUCCESS' ||
    status === 'JS_FAILED'
  ) {
    return false;
  }
  return !isPositiveTimestamp(state?.endedAt);
}

/**
 * Is this dispatch a tombstone (`deletedAt` set)? A server that keeps deleted
 * dispatches in the listing must not make a retired dispatch look still listed.
 */
function dispatchIsDeleted(dispatch: DispatchRecordLike): boolean {
  return isPositiveTimestamp(dispatch.state?.deletedAt);
}

/**
 * Build the browser worker gate, or return `null` when the pairing is off.
 *
 * Returns `null` (the exchange proceeds unchanged, unnamed auto-dispatch) UNLESS
 * `workerOrchestration` is on AND a well-formed `browserAgentName` is set. A
 * malformed configured name is a LOUD failure (logged) that still returns null,
 * so a misconfiguration degrades to today's behaviour rather than dispatching to
 * a nonexistent worker.
 */
export function browserOrchestrationGate(
  deps: BrowserWorkerGateDeps = {},
): BrowserWorkerGate | null {
  const orchestrationOn = deps.enabled ?? env.workerOrchestration;
  const agentName = (deps.agentName ?? env.browserAgentName).trim();

  if (!orchestrationOn) return null;
  if (agentName === '') {
    // Orchestration is on but the browser worker is NOT named — so it is still
    // unnamed + auto-dispatching. Do NOT gate or dispatch (that would be the
    // half-change the #1 constraint forbids). Proceed exactly as today.
    return null;
  }
  if (!BROWSER_AGENT_NAME_RE.test(agentName)) {
    // names_agree, negative case: a malformed dispatch name can never match a
    // worker registration. Fail LOUDLY and fall back to today's behaviour
    // rather than dispatch into nothing.
    log.error('unknown_event', { error_category: 'browser_agent_name_invalid' });
    return null;
  }

  const service = deps.service ?? createBrowserWorkerOrchestrationService();
  const app = BROWSER_FLY_APP;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const dispatchVerifyMs = deps.dispatchVerifyMs ?? boundedDispatchVerifyMs();
  const dispatchPollMs = Math.max(1, deps.dispatchPollMs ?? 1_000);
  const roomHasAgent = deps.roomHasAgent ?? roomHasAgentOnBrowserEndpoint;

  let dispatchClient = deps.dispatchClient ?? null;
  const dispatchClientFor = async (): Promise<BrowserAgentDispatchClientLike> => {
    if (dispatchClient === null) {
      dispatchClient = agentDispatchClientFor(
        requireBrowserLiveKitConfigured(),
      ) as unknown as BrowserAgentDispatchClientLike;
    }
    return dispatchClient;
  };

  /**
   * One read of the room's dispatches: does ANY own a LIVE job (pending or
   * running; a finished job left by an earlier exchange does not count); is
   * `dispatchId` still listed (a tombstoned dispatch is not).
   */
  const readDispatches = async (
    client: BrowserAgentDispatchClientLike,
    roomName: string,
    dispatchId: string,
  ): Promise<{ anyJob: boolean; listed: boolean }> => {
    const dispatches = await client.listDispatch!(roomName);
    return {
      anyJob: dispatches.some((item) => (item.state?.jobs ?? []).some(jobIsLive)),
      listed: dispatches.some((item) => item.id === dispatchId && !dispatchIsDeleted(item)),
    };
  };

  /**
   * R1 only. Watch one dispatch until a worker owns a job for the room.
   *   assigned — some dispatch in the room owns a live job (an agent exists).
   *   dropped  — still listed, still job-less, window elapsed (the S0-F3 drop).
   *   unknown  — cannot judge (no id / no listDispatch / vanished / list error):
   *              never treated as a drop, so never retried. The caller fails
   *              CLOSED on it: acceptance was not proven, so no token is minted.
   */
  const observeDispatch = async (
    client: BrowserAgentDispatchClientLike,
    roomName: string,
    dispatchId: string | undefined,
  ): Promise<'assigned' | 'dropped' | 'unknown'> => {
    // The SDK returns AgentDispatch.id. If an older/mock client cannot identify
    // its dispatch, do not guess and risk double-dispatching an active agent.
    if (!dispatchId || !client.listDispatch) return 'unknown';
    const deadline = now() + dispatchVerifyMs;
    for (;;) {
      try {
        const seen = await readDispatches(client, roomName, dispatchId);
        if (seen.anyJob) return 'assigned';
        if (!seen.listed) return 'unknown';
      } catch {
        return 'unknown';
      }
      if (now() >= deadline) return 'dropped';
      await sleep(Math.min(dispatchPollMs, Math.max(0, deadline - now())));
    }
  };

  /**
   * R1 only. Delete a dropped dispatch and PROVE nothing can still answer for
   * this room before a second dispatch may be issued.
   *   clear    — dispatch gone, no dispatch owns a job, no agent participant.
   *   assigned — a job or an agent appeared (never re-dispatch).
   *   unproven — the deletion did not show up, or a check failed: never
   *              re-dispatch on an unproven room.
   */
  const retireDispatch = async (
    client: BrowserAgentDispatchClientLike,
    roomName: string,
    dispatchId: string,
  ): Promise<'clear' | 'assigned' | 'unproven'> => {
    await client.deleteDispatch!(dispatchId, roomName);
    const deadline = now() + RETIRE_VERIFY_MS;
    for (;;) {
      let seen: { anyJob: boolean; listed: boolean };
      try {
        seen = await readDispatches(client, roomName, dispatchId);
      } catch {
        return 'unproven';
      }
      if (seen.anyJob) return 'assigned';
      if (!seen.listed) break;
      if (now() >= deadline) return 'unproven';
      await sleep(Math.min(dispatchPollMs, Math.max(0, deadline - now())));
    }
    try {
      return (await roomHasAgent(roomName)) ? 'assigned' : 'clear';
    } catch {
      return 'unproven';
    }
  };

  /**
   * R1 only. Best-effort removal of a dispatch we are about to abandon, so a
   * later exchange for the same room never meets a second agent that wins its
   * in-flight JobRequest after the caller released the machine. Never throws; a
   * dispatch with no known id (or a client that cannot delete) is left to the
   * release that follows and the reaper.
   */
  const discardDispatch = async (
    client: BrowserAgentDispatchClientLike,
    roomName: string,
    dispatchId: string | undefined,
  ): Promise<void> => {
    if (!dispatchId || !client.deleteDispatch) return;
    try {
      await client.deleteDispatch(dispatchId, roomName);
    } catch {
      /* the release that follows and the reaper remain the backstops */
    }
  };

  return {
    app,
    agentName,
    async ensureReadyWorker(input) {
      const ready = await service.ensureReadyWorker({
        app,
        pipeline: 'browser',
        sessionId: input.sessionId,
      });
      if (ready.status !== 'ready') return ready;
      const endpoint = browserLiveKitEndpoint();
      // Cloud (the default target): byte-identical to origin/main. The verdict
      // is returned untouched and the lease host is never consulted.
      if (endpoint.target !== 'r1') return ready;
      if (r1ReadyHostMatches(ready.livekitHost, liveKitHostname(endpoint.url))) return ready;
      // Do not disclose either hostname; a fixed event category is enough to
      // diagnose a cutover ordering/configuration fault without endpoint data.
      log.error('unknown_event', { error_category: 'browser_ready_host_mismatch' });
      try {
        await service.releaseWorker({
          app,
          machineId: ready.machineId,
          sessionId: input.sessionId,
        });
      } catch {
        /* the reaper remains the cost backstop */
      }
      return { status: 'timeout' };
    },
    async dispatch(input) {
      try {
        const client = await dispatchClientFor();
        // The browser dispatch carries only the session id (opaque), mirroring
        // the room metadata already minted by room-provisioning. No PII.
        const metadata = JSON.stringify({ session_id: input.sessionId, channel: 'browser' });
        const first = await client.createDispatch(input.roomName, agentName, { metadata });
        // Cloud (the default target): a single createDispatch and nothing else,
        // exactly as on origin/main — never a listDispatch or deleteDispatch.
        if (browserLiveKitEndpoint().target !== 'r1') return true;

        // FAIL CLOSED. On R1 only an ASSIGNED dispatch (a live job exists in the
        // room) returns true. Anything the safeguard cannot prove (no dispatch
        // id, no listDispatch, a list error, a dispatch that vanished from the
        // room) mints no token: false releases the machine (which also ends any
        // agent that did join) and the exchange answers "preparing". Nothing is
        // re-dispatched on an unproven room, so a second agent is still never
        // added; the abandoned dispatch is deleted best-effort.
        const firstId = dispatchIdOf(first);
        const firstVerdict = await observeDispatch(client, input.roomName, firstId);
        if (firstVerdict === 'assigned') return true;
        if (firstVerdict === 'unknown') {
          await discardDispatch(client, input.roomName, firstId);
          log.error('unknown_event', { error_category: 'browser_agent_dispatch_unverified' });
          return false;
        }
        // A known dispatch that stayed job-less through the whole window is the
        // OSS drop observed in S0-F3. Without the means to retire it we cannot
        // prove the room is clear to re-dispatch, and a job-less dispatch is not
        // an agent: fail closed rather than mint into a probably agent-less room.
        if (!client.deleteDispatch) {
          log.error('unknown_event', { error_category: 'browser_agent_dispatch_unproven' });
          return false;
        }
        const retired = await retireDispatch(client, input.roomName, firstId!);
        if (retired === 'assigned') return true;
        if (retired === 'unproven') {
          log.error('unknown_event', { error_category: 'browser_agent_dispatch_unproven' });
          return false;
        }

        const retry = await client.createDispatch(input.roomName, agentName, { metadata });
        const retryId = dispatchIdOf(retry);
        const retryVerdict = await observeDispatch(client, input.roomName, retryId);
        if (retryVerdict === 'assigned') return true;
        // Final drop or unverifiable retry. The retry could still win its
        // in-flight JobRequest after this window and join a room the caller is
        // about to release and return 202 for; retire it too so a later exchange
        // never meets a second agent.
        await discardDispatch(client, input.roomName, retryId);
        log.error('unknown_event', {
          error_category:
            retryVerdict === 'dropped'
              ? 'browser_agent_dispatch_dropped'
              : 'browser_agent_dispatch_unverified',
        });
        return false;
      } catch {
        // A room with no agent must not receive a candidate token. The caller
        // treats false as "not ready" and returns a preparing status.
        log.error('unknown_event', { error_category: 'browser_agent_dispatch_error' });
        return false;
      }
    },
    async releaseWorker(input) {
      try {
        await service.releaseWorker({ app, machineId: input.machineId, sessionId: input.sessionId });
      } catch {
        /* fail-open: the reaper backstops */
      }
    },
  };
}

/**
 * The browser orchestration service — the default production wiring with the
 * BROWSER room-name scheme injected (`screening-<sessionId>`) so the reaper
 * cross-checks the correct LiveKit room for a claimed browser session. The
 * ensure/release path never derives a room name, so this override matters only
 * for a browser reap, but injecting it keeps the browser service correct if the
 * reaper ever shares it.
 *
 * The lease reader selects `livekit_host` (0118) ONLY for the R1 target, where
 * the host match needs it. The Cloud target keeps the exact pre-0118 select, so
 * the live lane neither depends on 0118 nor changes its verdict shape.
 */
export function createBrowserWorkerOrchestrationService(): WorkerOrchestrationService {
  const liveKitEndpoint = browserLiveKitEndpoint();
  return createDefaultWorkerOrchestrationService({
    roomNameForSession,
    liveKitEndpoint,
    readLivekitHost: liveKitEndpoint.target === 'r1',
  });
}
