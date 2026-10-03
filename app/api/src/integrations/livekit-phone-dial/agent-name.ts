/**
 * livekit-phone-dial/agent-name.ts — the ONE definition of a per-machine phone
 * worker's LiveKit dispatch name (M009 E2).
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
 * ── THE TWO PATTERNS ARE A CONTRACT WITH TWO OTHER LANGUAGES ──────────
 * `AGENT_NAME_RE` is the same pattern as the 0112 CHECK constraint on
 * `voice_worker_leases.registered_agent_name` and the `/ready-machine` schema;
 * `PER_MACHINE_ID_RE` is the same pattern as the Python worker's
 * `_PER_MACHINE_ID_RE`. A cross-language test pins the latter. Change none of
 * them alone: a name the API accepts but the database rejects turns every
 * ready ping into a 500, and a name the worker registers but the API rejects
 * defers every dial.
 *
 * Importing this module performs NO I/O and reads NO ambient state.
 */

/**
 * A Fly machine id as the per-machine suffix accepts it: lowercase hex/base36,
 * bounded. Deliberately narrower than the route's generic Fly-id pattern — the
 * suffix becomes part of a LiveKit dispatch name, so nothing outside this
 * class (dots, uppercase, separators) is allowed to reach it.
 */
export const PER_MACHINE_ID_RE = /^[0-9a-z]{8,32}$/;

/**
 * A reported per-machine agent name: a bounded base, one '-', then a machine
 * id of the `PER_MACHINE_ID_RE` class. Mirrors the 0112 CHECK constraint
 * byte-for-byte.
 */
export const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}-[0-9a-z]{8,32}$/;

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
  if (typeof base !== 'string' || typeof machineId !== 'string') return null;
  if (!PER_MACHINE_ID_RE.test(machineId)) return null;
  const name = `${base}-${machineId}`;
  // The composed name must itself satisfy the stored-name contract, so an
  // empty or over-long base cannot produce a name the database would refuse.
  return AGENT_NAME_RE.test(name) ? name : null;
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
  if (typeof reported !== 'string') return false;
  const expected = phoneMachineAgentName(base, machineId);
  return expected !== null && reported === expected;
}
