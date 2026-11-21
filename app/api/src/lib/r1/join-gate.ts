/**
 * The R1 exchange's full worker gate before a candidate token exists.
 *
 * Three steps, in this order:
 *
 *  1. Fence 7 (`r1WorkerGateMissing`): on the R1 SFU with no worker gate, refuse. It is
 *     asked BEFORE anything is provisioned.
 *  2. The M019 shared-name interlock (`sharedNameDispatchSafe`): with per-machine agent
 *     names not enforced, an R1 dispatch to the shared name is safe only while this is the
 *     one live R1 session.
 *  3. `runR1WorkerGate` (./worker-gate.ts): ready a worker and dispatch it into the room.
 *
 * `runR1JoinGate` is steps 2 and 3 as one composite. Callers (the browser exchange, and the
 * Meet exchange in S05) must use `runR1JoinGate`, never `runR1WorkerGate` alone: the bare
 * gate skips the interlock. Step 1 is NOT inside it: each caller asks `r1WorkerGateMissing`
 * itself, first. Skipped, a missing gate on the R1 SFU comes back from `runR1JoinGate` as a
 * silent `preparing` (a 202 retry loop, no `r1_worker_gate_missing` log) instead of the
 * caller's 503 `r1_unavailable`.
 *
 * No environment reads and no defaults: the caller passes the dependencies it resolved,
 * including its own logger, so every log line keeps the caller's component.
 */

import type { supabase } from '../supabase.js';
import type { createLogger } from '../logger.js';
import type { BrowserWorkerGate } from '../browser-orchestration.js';
import type { LiveKitEndpoint } from '../livekit-endpoints.js';
import { runR1WorkerGate, type DispatchListerLike, type R1GateVerdict } from './worker-gate.js';

type Db = typeof supabase;

/** The one logger method the gate uses; the caller passes its own logger. */
export type R1JoinGateLog = Pick<ReturnType<typeof createLogger>, 'error'>;

export interface R1JoinGateDeps {
  db: Db;
  /** Epoch ms; the clock `runR1WorkerGate` ages job-less dispatches with. */
  now: () => number;
  /** The browser worker gate, or null when on-demand orchestration is off. May throw. */
  resolveGate: () => BrowserWorkerGate | null;
  /** The endpoint's agent-dispatch client; built lazily, only when a worker is gated. */
  dispatches: (endpoint: LiveKitEndpoint) => DispatchListerLike;
  /** BROWSER_REQUIRE_MACHINE_AGENT_NAME as the caller resolved it; read before an R1 dispatch. */
  requireMachineAgentName: () => boolean;
  log: R1JoinGateLog;
}

/**
 * Fence 7 on the R1 SFU. Nothing auto-dispatches there, so with no worker gate
 * (orchestration off, `BROWSER_AGENT_NAME` empty or malformed) a candidate token
 * would be minted for a room no interviewer will ever join. True means "refuse
 * with 503 r1_unavailable", and it must be asked BEFORE anything is provisioned.
 * Cloud is never affected: its unnamed worker auto-dispatches (legacy behaviour).
 * A gate that cannot even be built counts as missing.
 */
export function r1WorkerGateMissing(
  endpoint: LiveKitEndpoint,
  deps: Pick<R1JoinGateDeps, 'resolveGate' | 'log'>,
): boolean {
  if (endpoint.target !== 'r1') return false;
  try {
    if (deps.resolveGate() !== null) return false;
  } catch {
    /* unbuildable gate: fail closed below */
  }
  deps.log.error('unknown_event', { error_category: 'r1_worker_gate_missing' });
  return true;
}

/**
 * M019 interlock at dispatch time, not only when the limit is saved. With
 * BROWSER_REQUIRE_MACHINE_AGENT_NAME off, an R1 dispatch may go to the SHARED agent name, which
 * is safe only while this is the one live R1 session: with another live, LiveKit could hand
 * this session's job to a machine leased to the other interview, whose release would then stop
 * it mid-call. So, flag off on the self-hosted target, dispatch only when no OTHER R1 session
 * is live (0131's live predicate). At limit 1 admission already guarantees that, so today's
 * behaviour is unchanged; after a misordered rollback (flag off while several were admitted,
 * or the limit still above 1) every join but one defers instead. An unreadable answer defers
 * too. Cloud, and the flag on (per-machine names enforced by the gate), skip the read.
 */
export async function sharedNameDispatchSafe(
  endpoint: LiveKitEndpoint,
  sessionId: string,
  deps: Pick<R1JoinGateDeps, 'db' | 'requireMachineAgentName' | 'log'>,
): Promise<boolean> {
  if (endpoint.target !== 'r1' || deps.requireMachineAgentName()) return true;
  try {
    const others = await deps.db
      .from('call_sessions')
      .select('id')
      .not('interview_round_id', 'is', null)
      .in('status', ['created', 'waiting', 'in_progress'])
      .neq('id', sessionId)
      .limit(1);
    if (!others.error && Array.isArray(others.data) && others.data.length === 0) return true;
    deps.log.error('unknown_event', {
      error_category: others.error ? 'r1_live_count_unreadable' : 'r1_concurrency_needs_machine_names',
    });
  } catch {
    deps.log.error('unknown_event', { error_category: 'r1_live_count_unreadable' });
  }
  return false;
}

/**
 * The exchange's gate step: the M019 interlock, then `runR1WorkerGate`. `preparing`
 * means "answer 202 and let the candidate retry"; `proceed` means a worker is in (or
 * on its way into) the room. The worker gate is resolved only when the interlock
 * passes, and a throw from resolving it propagates.
 *
 * Fence 7 is not part of it: call `r1WorkerGateMissing` before provisioning anything, as
 * the browser router does on both paths (inside `laneForNewWork` for a `created` attempt,
 * explicitly for a `waiting` one).
 */
export async function runR1JoinGate(
  input: { endpoint: LiveKitEndpoint; sessionId: string; roomName: string },
  deps: R1JoinGateDeps,
): Promise<R1GateVerdict> {
  if (!(await sharedNameDispatchSafe(input.endpoint, input.sessionId, deps))) return 'preparing';
  return runR1WorkerGate({
    gate: deps.resolveGate(),
    sessionId: input.sessionId,
    roomName: input.roomName,
    dispatches: () => deps.dispatches(input.endpoint),
    now: deps.now,
    // The R1 SFU has no unnamed worker to auto-dispatch: a null gate or a `disabled` verdict defers (fence 7).
    failClosed: input.endpoint.target === 'r1',
  });
}
