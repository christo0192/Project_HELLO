/**
 * livekit-phone-dial/agent-name.ts — the phone lane's names for the per-machine
 * worker dispatch name (M009 E2).
 *
 * ── WHY A PER-MACHINE NAME EXISTS AT ALL ──────────────────────────────
 * Every phone machine used to register with LiveKit under the same shared
 * name, so a dispatch for session S could be picked up by ANY idle phone
 * worker — not the machine the orchestrator leased for S. Every stop path
 * (reaper, terminal-release, cleanup) judges a machine by the session on its
 * lease, so a machine running somebody else's interview was stopped mid-call.
 * Binding the dispatch to `<base>-<flyMachineId>` makes the lease's session
 * the session the machine is actually running again.
 *
 * ── WHY THE WORKER REPORTS IT AND THE API ONLY CHECKS IT ──────────────
 * The worker registers the name and reports it on its machine-level ready
 * ping; the API stores it on the lease and dispatches to it. The API never
 * INVENTS a per-machine name for a lease that did not report one: a machine
 * that registered the shared name would then receive no job at all and the
 * candidate would be dialled into a room with no agent. So these helpers only
 * VALIDATE — `isReportedAgentNameFor` is the gate dial.ts uses before it
 * trusts a reported name, and `phoneMachineAgentName` exists for the operator
 * tools (Canary-1 `--machine`) that must spell the same name the worker does.
 *
 * ── ONE DEFINITION, SHARED WITH THE BROWSER LANE (M019) ───────────────
 * The patterns and the checks live in `lib/worker-agent-name.ts`, which the
 * R1 browser gate uses too, so the two lanes can never disagree on what a
 * valid per-machine name is. This file keeps the phone lane's exported names
 * and behaviour exactly as they were: every export below is the shared
 * definition, unchanged.
 *
 * ── THE TWO PATTERNS ARE A CONTRACT WITH TWO OTHER LANGUAGES ──────────
 * `AGENT_NAME_RE` is the same pattern as the 0112 CHECK constraint on
 * `voice_worker_leases.registered_agent_name` and the `/ready-machine` schema;
 * `PER_MACHINE_ID_RE` is the same pattern as the Python worker's
 * `_PER_MACHINE_ID_RE`. A cross-language test pins the latter. Change none of
 * them alone: a name the API accepts but the database rejects turns every
 * ready ping into a 500, and a name the worker registers but the API rejects
 * defers every dial.
 *
 * Importing this module performs NO I/O and reads NO ambient state. Its one
 * import is `lib/worker-agent-name.ts`, which has zero imports of its own, so
 * a module that imports this file (the Canary-1 entry) gains two leaves and
 * nothing behind them.
 */

import {
  AGENT_NAME_RE,
  PER_MACHINE_ID_RE,
  isReportedMachineAgentName,
  machineAgentName,
} from '../../lib/worker-agent-name.js';

/**
 * A Fly machine id as the per-machine suffix accepts it (8-32 of [0-9a-z]),
 * and a reported per-machine agent name (the 0112 CHECK pattern). Re-exported
 * from the shared definition; see `lib/worker-agent-name.ts`.
 */
export { AGENT_NAME_RE, PER_MACHINE_ID_RE };

/**
 * The per-machine dispatch name for `machineId` under the shared `base` name,
 * or `null` when the id is not a valid per-machine suffix.
 *
 * `null` rather than a throw, and rather than falling back to `base`: a caller
 * that asked for ONE machine and silently got the shared name would dispatch
 * to whichever worker LiveKit picks, which is exactly the defect this name
 * exists to remove. The caller decides what an invalid id means (Canary-1
 * refuses the run).
 */
export function phoneMachineAgentName(base: string, machineId: string): string | null {
  return machineAgentName(base, machineId);
}

/**
 * True iff `reported` is EXACTLY the per-machine name for `machineId` under
 * `base`.
 *
 * Exact equality, never a suffix or prefix test: a name reported for another
 * machine (a stale row, a wrong boot) must not pass for this lease's machine,
 * and a name under a different base must not pass for this deployment's
 * worker. Anything that fails here is not trusted and the dial defers rather
 * than guessing.
 */
export function isReportedAgentNameFor(
  base: string,
  machineId: string,
  reported: string | null | undefined,
): boolean {
  return isReportedMachineAgentName(base, machineId, reported);
}
