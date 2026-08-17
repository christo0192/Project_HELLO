/**
 * ashby/signal-worker.ts — process a webhook signal as a SIGNAL, not as truth.
 *
 * A webhook only tells us "something changed for application X". The worker
 * re-reads the authoritative `application.info`, then validates against the
 * active mapping's CURRENT per-job AI screening stage before deciding anything
 * (invariant 6). It never trusts the payload's stage/job claims.
 *
 * Decisions (this PR produces a SAFE decision only — it never creates a
 * candidate, invite, session, or any Ashby mutation; that is a later PR):
 *   import_eligible      → the application is genuinely at the active AI stage
 *   ignored_action       → not the stage-change trigger (applicationUpdate is
 *                           redundant; other events are no-ops here)
 *   capability_disabled  → candidateDelete path is gated off (default) — the
 *                           receipt stands; reconciliation is the safety net
 *   skipped_no_application→ no usable application id to re-read
 *   mapping_inactive     → no enabled mapping for the job (paused/drift/unknown)
 *   stage_not_ai         → current stage is not the mapping's AI stage
 *                           (human/TA/other stage → NO import)
 *   self_echo            → the stage change was our own write-back (dedup no-op)
 *
 * The leased runner (`runClaimedAshbySignal`) claims one job under an
 * unguessable lease and commits ONLY under the live matching lease: a stale
 * worker whose lease expired or was reclaimed cannot commit (invariant 8).
 */

import {
  extractApplicationInfo,
  CANDIDATE_STAGE_CHANGE_ACTION,
} from './extractors.js';
import type { AshbySignalPayload, EnqueueSpec, ReceiptStore } from './ports.js';
import type { AshbyResult, OpaqueRecord } from './types.js';
import type { QueueJob, FailOutcome } from '../../lib/queue/types.js';

/** Queue name for inbound Ashby webhook signals. */
export const ASHBY_SIGNAL_QUEUE = 'ashby.signal';

/**
 * Deterministic queue dedup key for a signal. Identical across webhook retries
 * AND reconciliation, so the transactional outbox converges to one live job.
 */
export function signalDedupKey(action: string, webhookActionId: string): string {
  return `ashby:signal:${action}:${webhookActionId}`;
}

/**
 * Build the enqueue spec handed to the transactional-outbox receipt write.
 * The payload carries opaque ids only (never PII/body/tokens). Used identically
 * by the webhook ingress and the reconciliation recovery path so a dropped and
 * a later-delivered signal for the same application converge to one import.
 */
export function buildSignalEnqueueSpec(signal: {
  webhookActionId: string;
  action: string;
  externalApplicationId?: string;
}): EnqueueSpec {
  const payload: AshbySignalPayload = {
    provider: 'ashby',
    webhookActionId: signal.webhookActionId,
    action: signal.action,
    externalApplicationId: signal.externalApplicationId,
  };
  return {
    queueName: ASHBY_SIGNAL_QUEUE,
    dedupKey: signalDedupKey(signal.action, signal.webhookActionId),
    payload,
    maxAttempts: 5,
  };
}

/** The capability-gated delete action (disabled until a tenant probe verifies). */
export const CANDIDATE_DELETE_ACTION = 'candidateDelete';

export type SignalDecision =
  | 'import_eligible'
  | 'ignored_action'
  | 'capability_disabled'
  | 'skipped_no_application'
  | 'mapping_inactive'
  | 'stage_not_ai'
  | 'self_echo';

export interface SignalResult {
  decision: SignalDecision;
  applicationId?: string;
  jobId?: string;
  stageId?: string;
}

/** Current activity of the mapping for a job (as resolved from the DB). */
export interface MappingActivity {
  status: 'enabled' | 'paused' | 'drift' | 'unknown';
  aiScreeningStageId?: string | null;
}

export interface MappingResolver {
  /** Resolve the current mapping activity for an opaque external job id. */
  resolveByJobId(jobId: string): Promise<MappingActivity>;
}

/** Narrow reader seam — satisfied by AshbyClient. */
export interface ApplicationInfoReader {
  applicationInfo<T = OpaqueRecord>(applicationId: string, extra?: OpaqueRecord): Promise<AshbyResult<T>>;
}

export interface SignalWorkerDeps {
  client: ApplicationInfoReader;
  mappings: MappingResolver;
  /** Optional receipt bookkeeping sink (status update only). */
  receipts?: ReceiptStore;
  /** candidateDelete is capability-gated OFF until a tenant probe verifies it. */
  candidateDeleteEnabled?: boolean;
  /** Detect a self-generated stage echo (our own write-back). Default: never. */
  isSelfEcho?: (input: { applicationId: string; stageId: string }) => Promise<boolean> | boolean;
  /**
   * Scheduling seam invoked ONLY on the `import_eligible` verdict, before the
   * receipt is marked processed. Production binds it to a deterministic,
   * dedup-keyed import enqueue (see {@link importDedupKey}); tests assert it is
   * never called for any other decision.
   *
   * Default `undefined` — omitting it preserves the decision-only behaviour
   * exactly, so this seam adds no risk to the disabled configuration.
   *
   * It must be idempotent: a redelivered webhook and a reconciliation recovery
   * both reach this point for the same application and must converge to ONE
   * import. A throw propagates so the leased runner fails (and retries) the
   * signal job rather than acking work that was never scheduled.
   */
  onImportEligible?: (input: {
    applicationId: string;
    jobId: string;
    stageId: string;
  }) => Promise<void> | void;
}

/** Queue name for application imports scheduled from an eligible signal. */
export const ASHBY_IMPORT_QUEUE = 'ashby.import';

/**
 * Deterministic dedup key for an import. Keyed by the APPLICATION, not by the
 * webhook delivery, so a duplicate webhook, a redelivery, and a reconciliation
 * recovery for the same application all collapse onto one live job.
 */
export function importDedupKey(applicationId: string): string {
  return `ashby:import:${applicationId}`;
}

async function mark(
  deps: SignalWorkerDeps,
  payload: AshbySignalPayload,
  status: 'processed' | 'ignored' | 'failed',
): Promise<void> {
  if (!deps.receipts?.markStatus) return;
  try {
    await deps.receipts.markStatus({
      webhookActionId: payload.webhookActionId,
      action: payload.action,
      status,
    });
  } catch {
    // Bookkeeping must never turn a benign no-op into a hard failure.
  }
}

/**
 * Decide what (if anything) a signal warrants, re-reading authoritative state.
 * Produces a SAFE decision only — no candidate/invite/session/Ashby mutation.
 */
export async function processAshbySignal(
  payload: AshbySignalPayload,
  deps: SignalWorkerDeps,
): Promise<SignalResult> {
  // Only the stage-change action is a processing trigger. candidateDelete is
  // capability-gated; everything else (e.g. applicationUpdate) is redundant.
  if (payload.action !== CANDIDATE_STAGE_CHANGE_ACTION) {
    if (payload.action === CANDIDATE_DELETE_ACTION && !deps.candidateDeleteEnabled) {
      await mark(deps, payload, 'ignored');
      return { decision: 'capability_disabled' };
    }
    if (payload.action !== CANDIDATE_DELETE_ACTION) {
      await mark(deps, payload, 'ignored');
      return { decision: 'ignored_action' };
    }
    // candidateDelete enabled would be handled by a later PR; treat as gated.
    await mark(deps, payload, 'ignored');
    return { decision: 'capability_disabled' };
  }

  if (!payload.externalApplicationId) {
    await mark(deps, payload, 'failed');
    return { decision: 'skipped_no_application' };
  }

  // Re-read the authoritative application state — the payload is only a signal.
  const info = await deps.client.applicationInfo(payload.externalApplicationId);
  const view = extractApplicationInfo(info.results);
  const applicationId = view.applicationId ?? payload.externalApplicationId;
  const jobId = view.jobId;
  const stageId = view.currentStageId;

  if (!jobId) {
    await mark(deps, payload, 'ignored');
    return { decision: 'mapping_inactive', applicationId, stageId };
  }

  const mapping = await deps.mappings.resolveByJobId(jobId);
  if (mapping.status !== 'enabled' || !mapping.aiScreeningStageId) {
    await mark(deps, payload, 'ignored');
    return { decision: 'mapping_inactive', applicationId, jobId, stageId };
  }

  // The current stage must be the mapping's AI screening stage. A human/TA/other
  // stage → no import.
  if (!stageId || stageId !== mapping.aiScreeningStageId) {
    await mark(deps, payload, 'ignored');
    return { decision: 'stage_not_ai', applicationId, jobId, stageId };
  }

  // Self-generated echo (our own write-back moved the stage) → dedup no-op.
  if (deps.isSelfEcho) {
    const echoed = await deps.isSelfEcho({ applicationId, stageId });
    if (echoed) {
      await mark(deps, payload, 'ignored');
      return { decision: 'self_echo', applicationId, jobId, stageId };
    }
  }

  // Genuinely eligible. Schedule the import BEFORE marking the receipt
  // processed: `mark` is deliberately best-effort (it swallows failures), so if
  // the order were reversed a scheduling failure could leave a receipt in a
  // terminal status with no durable work — and the reconciliation re-drive
  // would then decline to re-enqueue. Scheduling first means a throw here
  // fails the leased job and the whole signal is retried.
  if (deps.onImportEligible) {
    await deps.onImportEligible({ applicationId, jobId, stageId });
  }
  await mark(deps, payload, 'processed');
  return { decision: 'import_eligible', applicationId, jobId, stageId };
}

// ── Leased runner: claim → process → commit under the live lease ─────────────

/** Narrow leased-queue seam — satisfied by the repo Queue. */
export interface LeasedSignalQueue {
  claim<T = unknown>(name: string, options?: { leaseSeconds?: number; owner?: string }): Promise<QueueJob<T> | null>;
  completeClaim(jobId: string, leaseToken: string): Promise<boolean>;
  failClaim(jobId: string, leaseToken: string, error: Error | string): Promise<FailOutcome>;
}

export type RunClaimedOutcome =
  | { claimed: false }
  | { claimed: true; committed: boolean; staleLease: boolean; result?: SignalResult; failure?: FailOutcome };

/** Defensively read an opaque signal payload from a queue job. */
function readSignalPayload(raw: unknown): AshbySignalPayload | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = typeof r.action === 'string' ? r.action : null;
  const webhookActionId = typeof r.webhookActionId === 'string' ? r.webhookActionId : null;
  if (!action || !webhookActionId) return null;
  const externalApplicationId = typeof r.externalApplicationId === 'string' ? r.externalApplicationId : undefined;
  return { provider: 'ashby', action, webhookActionId, externalApplicationId };
}

/**
 * Claim exactly one signal under a lease, process it, and commit ONLY under the
 * live matching lease. If processing throws, the job is failed under the lease
 * (retry/DLQ). If the lease was lost (expired/reclaimed), completion returns
 * false and nothing is committed (a stale worker cannot commit — invariant 8).
 */
export async function runClaimedAshbySignal(
  queue: LeasedSignalQueue,
  deps: SignalWorkerDeps,
  options: { leaseSeconds?: number; owner?: string } = {},
): Promise<RunClaimedOutcome> {
  const job = await queue.claim<Record<string, unknown>>(ASHBY_SIGNAL_QUEUE, options);
  if (!job || !job.leaseToken) return { claimed: false };

  const payload = readSignalPayload(job.payload);
  if (!payload) {
    // Malformed payload is a permanent failure under the lease.
    const failure = await queue.failClaim(job.id, job.leaseToken, 'malformed_signal_payload');
    return { claimed: true, committed: false, staleLease: failure === 'not_owned', failure };
  }

  let result: SignalResult;
  try {
    result = await processAshbySignal(payload, deps);
  } catch (err) {
    const failure = await queue.failClaim(job.id, job.leaseToken, err instanceof Error ? err : String(err));
    return { claimed: true, committed: false, staleLease: failure === 'not_owned', failure };
  }

  const committed = await queue.completeClaim(job.id, job.leaseToken);
  return { claimed: true, committed, staleLease: !committed, result };
}
