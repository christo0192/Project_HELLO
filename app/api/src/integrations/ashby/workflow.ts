/**
 * ashby/workflow.ts — pure decision logic for application import identity and
 * terminal cancellation (Wave 2 work item 3). DB-free, deterministic, and
 * exhaustively unit-testable; the integration layer wires these decisions to
 * the 0029 tables + RPCs. Mirrors the SQL/domain invariants:
 *
 *  - The Ashby APPLICATION ID is the sole workflow identity. Two applications
 *    are NEVER merged by shared contact data (same email/phone → still two).
 *  - Import proceeds only when the re-read application is at the mapping's
 *    CURRENT enabled, non-drifted AI screening stage (the webhook is a signal;
 *    truth is re-read). A terminal link never re-imports.
 *  - A human stage departure, withdrawal, or verified deletion TERMINAL-cancels
 *    every still-pending import/resume/delivery/writeback/stage operation and
 *    the in-flight resume ingestion — but never undoes a human action, never
 *    reverses succeeded work, and never auto-rejects.
 */

/** Current mapping activity for a job (as resolved from 0029). */
export interface MappingActivity {
  status: 'enabled' | 'paused' | 'drift' | 'unknown';
  aiScreeningStageId?: string | null;
}

/** Authoritative fields re-read from application.info. */
export interface ApplicationView {
  applicationId?: string;
  jobId?: string;
  currentStageId?: string;
  /** Candidate identity used only for the candidate.info resume fallback. */
  candidateId?: string;
}

/** Terminal triggers (parity with ashby_application_links.terminal_state). */
export const TERMINAL_TRIGGERS = ['manual_stage_cancel', 'withdrawn', 'deleted'] as const;
export type TerminalTrigger = (typeof TERMINAL_TRIGGERS)[number];

export type ImportDecision =
  | { action: 'import'; applicationId: string; jobId: string; stageId: string }
  | { action: 'skip'; reason: 'no_application' | 'no_job' | 'mapping_inactive' | 'stage_not_ai' | 'terminal' };

/**
 * Decide whether a re-read application warrants an import. Fails closed on a
 * missing/inactive/drifted mapping, a non-AI current stage, or a link that is
 * already terminal.
 */
export function decideImport(
  view: ApplicationView,
  mapping: MappingActivity,
  existingTerminalState: TerminalTrigger | null | undefined,
): ImportDecision {
  if (existingTerminalState) return { action: 'skip', reason: 'terminal' };
  if (!view.applicationId) return { action: 'skip', reason: 'no_application' };
  if (!view.jobId) return { action: 'skip', reason: 'no_job' };
  if (mapping.status !== 'enabled' || !mapping.aiScreeningStageId) {
    return { action: 'skip', reason: 'mapping_inactive' };
  }
  if (!view.currentStageId || view.currentStageId !== mapping.aiScreeningStageId) {
    return { action: 'skip', reason: 'stage_not_ai' };
  }
  return { action: 'import', applicationId: view.applicationId, jobId: view.jobId, stageId: view.currentStageId };
}

/** A minimal view of an existing application link (0029). */
export interface ExistingLink {
  id: string;
  externalApplicationId: string;
  terminalState?: TerminalTrigger | null;
}

export type IdentityDecision =
  | { action: 'reuse'; linkId: string }
  | { action: 'create' }
  | { action: 'blocked_terminal'; linkId: string };

/**
 * Resolve the local link identity for an application id. Identity is keyed
 * SOLELY by the external application id: an existing non-terminal link is
 * reused (exactly one linkage per application); a terminal link blocks new
 * work; otherwise a new link is created. Contact data is never consulted.
 */
export function resolveApplicationIdentity(
  externalApplicationId: string,
  existing: ExistingLink | null | undefined,
): IdentityDecision {
  if (!existing) return { action: 'create' };
  if (existing.externalApplicationId !== externalApplicationId) {
    // A mismatch means the caller looked up the wrong row — never merge.
    return { action: 'create' };
  }
  if (existing.terminalState) return { action: 'blocked_terminal', linkId: existing.id };
  return { action: 'reuse', linkId: existing.id };
}

/**
 * Two applications that merely share contact data are DISTINCT. Returns true
 * iff the two links may be treated as the same workflow identity — which is
 * only when their external application ids are equal.
 */
export function isSameApplicationIdentity(
  a: { externalApplicationId: string; email?: string | null },
  b: { externalApplicationId: string; email?: string | null },
): boolean {
  return a.externalApplicationId === b.externalApplicationId;
}

// ── Terminal cancellation planning ───────────────────────────────────────────

export type OperationType = 'invite_delivery' | 'scorecard_write' | 'stage_move';
export type OperationState = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface WorkflowOperation {
  id: string;
  type: OperationType;
  state: OperationState;
}

export type IngestionState =
  | 'queued' | 'fetching' | 'scanning' | 'extracting' | 'structuring' | 'ready' | 'failed_review' | 'cancelled';

/** Ingestion states that are still in flight and thus cancellable. */
const CANCELLABLE_INGESTION: readonly IngestionState[] = [
  'queued', 'fetching', 'scanning', 'extracting', 'structuring', 'failed_review',
];

/** Operation states that are still in flight and thus cancellable. */
const CANCELLABLE_OPERATION: readonly OperationState[] = ['pending', 'running', 'blocked'];

export interface TerminalPlan {
  terminalState: TerminalTrigger;
  /** Ids of operations to cancel (only still-in-flight ones). */
  cancelOperationIds: string[];
  /** Whether to cancel the in-flight resume ingestion. */
  cancelIngestion: boolean;
}

/**
 * Plan the atomic terminal cancellation for a human stage departure /
 * withdrawal / deletion. Cancels only still-in-flight operations and ingestion:
 * succeeded/failed/already-cancelled operations are left untouched (never
 * reverse a human-visible outcome, never auto-reject).
 */
export function planTerminalCancellation(
  trigger: TerminalTrigger,
  operations: readonly WorkflowOperation[],
  ingestionState: IngestionState | null | undefined,
): TerminalPlan {
  const cancelOperationIds = operations
    .filter((op) => CANCELLABLE_OPERATION.includes(op.state))
    .map((op) => op.id);
  const cancelIngestion = ingestionState != null && CANCELLABLE_INGESTION.includes(ingestionState);
  return { terminalState: trigger, cancelOperationIds, cancelIngestion };
}

/**
 * Whether a re-read stage change is a HUMAN departure from the AI stage that
 * must cancel the workflow. True iff the workflow was at the AI stage and the
 * application is now at a different (non-AI) stage — i.e. a recruiter/TA moved
 * it. A move back to the same AI stage is not a departure.
 */
export function isHumanStageDeparture(
  aiScreeningStageId: string,
  previousStageId: string | null | undefined,
  currentStageId: string | null | undefined,
): boolean {
  if (!currentStageId) return false;
  const wasAtAi = previousStageId === aiScreeningStageId;
  return wasAtAi && currentStageId !== aiScreeningStageId;
}
