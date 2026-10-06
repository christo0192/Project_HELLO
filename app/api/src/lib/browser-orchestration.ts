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
} from './livekit-endpoints.js';

const log = createLogger('browser-orchestration');

/** A dispatch name is a bounded, opaque slug — never a secret, never PII. */
const BROWSER_AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The narrow dispatch seam this module needs. */
export interface BrowserAgentDispatchClientLike {
  createDispatch(
    roomName: string,
    agentName: string,
    options?: { metadata?: string },
  ): Promise<{ id?: string } | unknown>;
  listDispatch?(roomName: string): Promise<Array<{ id?: string; state?: { jobs?: unknown[] } }>>;
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
   * like an absent gate (proceed as today). Every other non-`ready` verdict
   * DEFERS: the caller returns a "preparing" status and mints NO token.
   */
  ensureReadyWorker(input: { sessionId: string }): Promise<EnsureReadyResult>;
  /**
   * Explicitly dispatch the NAMED browser worker into the session's room.
   * Called ONLY after `ensureReadyWorker` returned `ready`. Returns true on a
   * successful dispatch; false means the room has no agent (the caller must NOT
   * mint a token into an agent-less room). Never throws.
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
  /** Test seams; production uses bounded values below and never sleeps in tests. */
  readonly dispatchVerifyMs?: number;
  readonly dispatchPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function boundedDispatchVerifyMs(): number {
  const parsed = Number(process.env.BROWSER_DISPATCH_VERIFY_SEC ?? '8');
  if (!Number.isFinite(parsed)) return 8_000;
  return Math.max(1_000, Math.min(8_000, Math.round(parsed * 1_000)));
}

function liveKitHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function browserReadyHostMatches(input: {
  reportedHost: string | null | undefined;
  target: 'cloud' | 'r1';
  expectedHost: string | null;
}): boolean {
  // Cloud remains compatible with workers that predate the host field. R1
  // requires a durable, exact report: no endpoint means no admission.
  if (input.target === 'cloud') {
    return input.reportedHost === null || input.reportedHost === undefined
      || (input.expectedHost !== null && input.reportedHost === input.expectedHost);
  }
  return input.expectedHost !== null && input.reportedHost === input.expectedHost;
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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const dispatchVerifyMs = deps.dispatchVerifyMs ?? boundedDispatchVerifyMs();
  const dispatchPollMs = Math.max(1, deps.dispatchPollMs ?? 1_000);

  let dispatchClient = deps.dispatchClient ?? null;
  const dispatchClientFor = async (): Promise<BrowserAgentDispatchClientLike> => {
    if (dispatchClient === null) {
      dispatchClient = agentDispatchClientFor(
        requireBrowserLiveKitConfigured(),
      ) as unknown as BrowserAgentDispatchClientLike;
    }
    return dispatchClient;
  };

  const dispatchAccepted = async (
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
        const dispatches = await client.listDispatch(roomName);
        const current = dispatches.find((item) => item.id === dispatchId);
        if (!current) return 'unknown';
        if ((current.state?.jobs?.length ?? 0) > 0) return 'assigned';
      } catch {
        return 'unknown';
      }
      if (now() >= deadline) return 'dropped';
      await sleep(Math.min(dispatchPollMs, Math.max(0, deadline - now())));
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
      if (browserReadyHostMatches({
        reportedHost: ready.livekitHost,
        target: endpoint.target,
        expectedHost: liveKitHostname(endpoint.url),
      })) return ready;
      // Do not disclose either hostname; a fixed event category is enough to
      // diagnose a cutover ordering/configuration fault without endpoint data.
      log.error('unknown_event', { error_category: 'browser_ready_host_mismatch' });
      try {
        await service.releaseWorker({ app, machineId: ready.machineId, sessionId: input.sessionId });
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
        const first = await client.createDispatch(input.roomName, agentName, {
          metadata: JSON.stringify({ session_id: input.sessionId, channel: 'browser' }),
        });
        const firstRecord = typeof first === 'object' && first !== null
          ? first as { id?: unknown }
          : null;
        const firstId = typeof firstRecord?.id === 'string' ? firstRecord.id : undefined;
        const firstVerdict = await dispatchAccepted(client, input.roomName, firstId);
        if (firstVerdict === 'assigned' || firstVerdict === 'unknown') return true;
        // A known dispatch that remained job-less through the bounded window is
        // the OSS drop observed in S0-F3. Delete it before one fresh attempt.
        if (!client.deleteDispatch) return true;
        await client.deleteDispatch(firstId!, input.roomName);
        const retry = await client.createDispatch(input.roomName, agentName, {
          metadata: JSON.stringify({ session_id: input.sessionId, channel: 'browser' }),
        });
        const retryRecord = typeof retry === 'object' && retry !== null
          ? retry as { id?: unknown }
          : null;
        const retryId = typeof retryRecord?.id === 'string' ? retryRecord.id : undefined;
        const retryVerdict = await dispatchAccepted(client, input.roomName, retryId);
        if (retryVerdict === 'assigned' || retryVerdict === 'unknown') return true;
        log.error('unknown_event', { error_category: 'browser_agent_dispatch_dropped' });
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
 */
export function createBrowserWorkerOrchestrationService(): WorkerOrchestrationService {
  return createDefaultWorkerOrchestrationService({
    roomNameForSession,
    liveKitEndpoint: browserLiveKitEndpoint(),
  });
}
