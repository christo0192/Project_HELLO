/**
 * ashby/signal-worker.ts — process a webhook signal as a SIGNAL, not as truth.
 *
 * A webhook only tells us "something changed for application X". The worker
 * re-reads the authoritative `application.info`, then validates against the
 * active mapping's CURRENT per-job AI screening stage before deciding anything
 * (invariant 6). No DECISION is ever taken from the payload's stage/job claims.
 *
 * ONE narrow exception, added 2026-09-16 and deliberately not a decision: the
 * optional `isStageOfInterest` pre-filter may use the payload's stage as a HINT
 * to skip the provider read when NO enabled mapping names that stage — see its
 * doc on {@link SignalWorkerDeps}. It can only ever reach the same verdict the
 * authoritative read would have reached for an unmapped stage, it is fail-open
 * at every uncertain step, and its verdict is CONDITIONAL (non-terminal), so a
 * later mapping change plus a forced resync still re-drives the application.
 * The cost of the exception is real and bounded: if a stage-change webhook is
 * LOST and a later signal for the same application hints an unmapped stage, the
 * catch-up that the unconditional re-read used to provide now falls to
 * reconciliation instead. `onStageHintObserved` exists to measure whether the
 * hint is ever wrong; a non-zero mismatch count is the signal to unwire it.
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
 * TERMINAL vs CONDITIONAL verdicts (review finding B2). `mark(...)` writes a
 * receipt status, and `record_ashby_event_receipt` treats
 * `processed|ignored|failed` as "durable work is done" and refuses to re-drive.
 * Because the receipt identity is stage-centric (`stage:<app>:<stage>`), a
 * terminal status permanently poisons that exact application-at-stage: no
 * future signal for it can ever be enqueued again.
 *
 * That is correct only for verdicts whose "no" is PERMANENT:
 *   ignored_action, capability_disabled, self_echo → terminal `ignored`
 *   import_eligible                                → terminal `processed`
 *
 * It is WRONG for CONDITIONAL verdicts, whose "no" a human can reverse:
 *   mapping_inactive  → someone can enable the mapping tomorrow
 *   stage_not_ai      → someone can move the candidate into the AI stage
 * These leave the receipt at its non-terminal `received` state — recorded, not
 * concluded — so a later forced full resync (which enabling a mapping now
 * triggers) can still recover the application. Terminalising them is what made
 * "enable a mapping after the runtime ran" silently, permanently blind.
 *
 * The leased runner (`runClaimedAshbySignal`) claims one job under an
 * unguessable lease and commits ONLY under the live matching lease: a stale
 * worker whose lease expired or was reclaimed cannot commit (invariant 8).
 */

import {
  extractApplicationInfo,
  CANDIDATE_STAGE_CHANGE_ACTION,
  MAX_ID_LEN,
} from './extractors.js';
import type { AshbySignalPayload, EnqueueSpec, ReceiptStore } from './ports.js';
import type { AshbyResult, OpaqueRecord } from './types.js';
import { admitStageAfterActivation, type ApplicationHistoryLister } from './activation-admission.js';
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
  source?: 'webhook' | 'reconcile';
}): EnqueueSpec {
  const payload: AshbySignalPayload = {
    provider: 'ashby',
    webhookActionId: signal.webhookActionId,
    action: signal.action,
    externalApplicationId: signal.externalApplicationId,
    source: signal.source ?? 'webhook',
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
  | 'stage_not_of_interest'
  | 'self_echo';

/**
 * Upper bound `stageDedupId` enforces on a receipt identity. An id at exactly
 * this length may have been TRUNCATED, which would silently corrupt the stage
 * segment — see {@link stageIdFromWebhookActionId}. DERIVED from the extractor's
 * own bound so the two can never drift into accepting a truncated prefix.
 */
export const MAX_WEBHOOK_ACTION_ID_LEN = MAX_ID_LEN;

/**
 * Sentinel `stageDedupId` substitutes when the signal carried no stage at all.
 * It is not a stage id and must never be matched against the mapping set.
 */
export const NO_STAGE_SENTINEL = 'nostage';

/**
 * The stage id embedded in a stage-change receipt identity (`stage:<app>:<stage>`).
 *
 * Returns null — meaning "no usable hint, do the authoritative read" — for
 * anything that is not unambiguously a complete stage id. The bar is high on
 * purpose: this value's ONLY job is to authorise skipping a provider read, so
 * every failure mode here must degrade into doing more work, never less.
 *
 * Rejected, each for a reason that would otherwise yield a stage id matching no
 * mapping and thus a WRONG skip:
 *  - not a string, or not exactly `stage:<a>:<b>` with both parts non-empty;
 *  - length exactly {@link MAX_WEBHOOK_ACTION_ID_LEN}: `stageDedupId` slices at
 *    that bound, so the trailing stage segment may be a truncated prefix;
 *  - the {@link NO_STAGE_SENTINEL} placeholder, which encodes "stage unknown" —
 *    precisely the case that must consult the provider rather than skip.
 */
export function stageIdFromWebhookActionId(
  webhookActionId: unknown,
  expectedApplicationId?: unknown,
): string | null {
  if (typeof webhookActionId !== 'string') return null;
  // A possibly-truncated id cannot be trusted to carry a whole stage segment.
  if (webhookActionId.length >= MAX_WEBHOOK_ACTION_ID_LEN) return null;
  const parts = webhookActionId.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'stage') return null;
  const applicationPart = parts[1] ?? '';
  const stagePart = parts[2] ?? '';
  if (applicationPart.length === 0 || stagePart.length === 0) return null;
  if (stagePart === NO_STAGE_SENTINEL) return null;
  // Defence in depth: an identity describing a DIFFERENT application than the
  // payload carries is incoherent, and its stage segment says nothing about
  // the application we are about to decide on. Both current producers build
  // the two from one struct, so this should be unreachable — which is exactly
  // why it must fail open rather than be assumed.
  if (expectedApplicationId !== undefined && applicationPart !== expectedApplicationId) {
    return null;
  }
  return stagePart;
}

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
  activationAt?: string | null;
  activationEpoch?: number;
  configVersion?: number;
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
   * Cheap, LOCAL pre-filter answering "could any enabled mapping ever import an
   * application sitting at this stage?" — consulted BEFORE the authoritative
   * `application.info` read, purely to avoid spending a provider round-trip on
   * a stage no mapping names.
   *
   * This is the ONLY place the payload's stage claim is used, and it is used as
   * a HINT, never as truth:
   *   - Absent seam → behaviour is byte-identical to before (no fast path).
   *   - Unparseable receipt identity → no fast path.
   *   - A throw, or any inability to answer → treated as "of interest", so the
   *     authoritative read still happens. It fails OPEN, always.
   * The resulting verdict is CONDITIONAL (`stage_not_of_interest`): the receipt
   * is left non-terminal exactly like `stage_not_ai`, so enabling a mapping
   * later and forcing a full resync still re-drives the application (B2).
   */
  isStageOfInterest?: (stageId: string) => Promise<boolean> | boolean;
  /**
   * Observer invoked ONLY on the path that already paid for the authoritative
   * read, reporting the payload's hinted stage alongside the real one. It is
   * the sole way to learn whether the hint above is trustworthy: the skip path
   * performs no read, so a systematically wrong hint is otherwise undetectable
   * at any volume. Never throws into the caller — observation must not fail a
   * signal. Metadata only; the ids are opaque provider strings.
   */
  onStageHintObserved?: (input: {
    hintedStageId: string;
    authoritativeStageId: string | undefined;
  }) => void;
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
    source?: AshbySignalPayload['source'];
    explicitImportRunId?: string;
  }) => Promise<void> | void;
  /** Verify an explicit snapshot entry against the durable run and mapping. */
  isExplicitImportAuthorized?: (input: {
    runId: string;
    applicationId: string;
    jobId: string;
    stageId: string;
  }) => Promise<boolean>;
  isSnapshotApplicationAuthorized?: (input: { applicationId: string; jobId: string; stageId: string }) => Promise<boolean>;
  /** Production composition turns this on; test-only decision seams may omit it. */
  enforceActivationFence?: boolean;
  /** Required by the production composition for every non-explicit signal. */
  history?: ApplicationHistoryLister;
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
  context: { createdAt?: string; deadlineAt?: number } = {},
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

  // ── Local pre-filter: skip the provider read for a stage no mapping names ──
  // An external bulk stage-move can deliver tens of thousands of stage changes
  // for stages this tenant has never mapped. Each one previously cost a full
  // `application.info` round-trip before the mapping check could reject it,
  // which is what let one external burst saturate the runtime for hours.
  //
  // The skip is only ever taken when EVERY one of these holds: the seam is
  // wired, the receipt identity parses to a stage id, and the seam answers a
  // definite "no". Anything else — no seam, no parse, a throw, an
  // indeterminate answer — falls through to the authoritative read below.
  const hintedStageId = stageIdFromWebhookActionId(
    payload.webhookActionId,
    payload.externalApplicationId,
  );
  if (deps.isStageOfInterest) {
    if (hintedStageId !== null) {
      let ofInterest = true;
      try {
        const answer = await deps.isStageOfInterest(hintedStageId);
        // ONLY a literal `false` grants a skip. Anything else — `undefined`,
        // `null`, a non-boolean — is an inability to answer, and an inability
        // to answer must cost a provider read, never a skipped candidate.
        ofInterest = answer !== false;
      } catch {
        // A filter that cannot answer has not granted a skip.
        ofInterest = true;
      }
      if (!ofInterest) {
        // CONDITIONAL — no `mark`, so the receipt stays `received`. Identical
        // to the `stage_not_ai` treatment below, and for the same reason: a
        // human can map this stage tomorrow, and the stage-centric dedup
        // identity would suppress the re-entry forever if terminalised (B2).
        return {
          decision: 'stage_not_of_interest',
          applicationId: payload.externalApplicationId,
          stageId: hintedStageId,
        };
      }
    }
  }

  // Re-read the authoritative application state — the payload is only a signal.
  const info = await deps.client.applicationInfo(payload.externalApplicationId);
  const view = extractApplicationInfo(info.results);
  const applicationId = view.applicationId ?? payload.externalApplicationId;
  const jobId = view.jobId;
  const stageId = view.currentStageId;

  // Free evidence about the hint: this read already happened. Observation must
  // never turn a healthy signal into a failure, so it is fully isolated.
  if (deps.onStageHintObserved && hintedStageId !== null) {
    try {
      deps.onStageHintObserved({ hintedStageId, authoritativeStageId: stageId });
    } catch { /* an observer must never break the worker */ }
  }

  if (!jobId) {
    // CONDITIONAL — leave the receipt non-terminal (B2). Deliberately no mark.
    return { decision: 'mapping_inactive', applicationId, stageId };
  }

  const mapping = await deps.mappings.resolveByJobId(jobId);
  if (mapping.status !== 'enabled' || !mapping.aiScreeningStageId) {
    // CONDITIONAL — the mapping can be enabled later, and enabling forces a
    // full resync that must be able to re-drive this application (B2).
    return { decision: 'mapping_inactive', applicationId, jobId, stageId };
  }

  // The current stage must be the mapping's AI screening stage. A human/TA/other
  // stage → no import.
  if (!stageId || stageId !== mapping.aiScreeningStageId) {
    // CONDITIONAL — a human can move the candidate INTO the AI stage, and the
    // stage-centric dedup identity would suppress that re-entry forever if we
    // terminalised here (B2).
    return { decision: 'stage_not_ai', applicationId, jobId, stageId };
  }

  if (deps.enforceActivationFence) {
    const explicitRunId = payload.source === 'explicit_backlog' ? payload.explicitImportRunId : undefined;
    let authorized = deps.isSnapshotApplicationAuthorized
      ? await deps.isSnapshotApplicationAuthorized({ applicationId, jobId, stageId })
      : false;
    if (!authorized && explicitRunId && deps.isExplicitImportAuthorized) {
      authorized = await deps.isExplicitImportAuthorized({ runId: explicitRunId, applicationId, jobId, stageId });
    }
    if (!authorized) {
      const activationMs = typeof mapping.activationAt === 'string' ? Date.parse(mapping.activationAt) : Number.NaN;
      if (!deps.history || !Number.isFinite(activationMs)) {
        return { decision: 'mapping_inactive', applicationId, jobId, stageId };
      }
      // A stale snapshot payload is not a veto on a NEW, independently proven
      // stage transition. Conversely provider failure is not a negative verdict:
      // throw so the leased queue retries rather than silently completing it.
      const verdict = await admitStageAfterActivation(deps.history, {
        applicationId, stageId, activationAt: mapping.activationAt!,
        deadlineAt: context.deadlineAt,
      });
      if (verdict !== 'admit') return { decision: 'mapping_inactive', applicationId, jobId, stageId };
    }
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
    const scheduled: { applicationId: string; jobId: string; stageId: string; source?: AshbySignalPayload['source']; explicitImportRunId?: string } = { applicationId, jobId, stageId };
    if (payload.source) scheduled.source = payload.source;
    if (payload.explicitImportRunId) scheduled.explicitImportRunId = payload.explicitImportRunId;
    await deps.onImportEligible(scheduled);
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
  const source = r.source === 'explicit_backlog' ? 'explicit_backlog' : undefined;
  const explicitImportRunId = typeof r.explicitImportRunId === 'string' ? r.explicitImportRunId : undefined;
  return { provider: 'ashby', action, webhookActionId, externalApplicationId, source, explicitImportRunId };
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
    result = await processAshbySignal(payload, deps, { createdAt: job.createdAt });
  } catch (err) {
    const failure = await queue.failClaim(job.id, job.leaseToken, err instanceof Error ? err : String(err));
    return { claimed: true, committed: false, staleLease: failure === 'not_owned', failure };
  }

  const committed = await queue.completeClaim(job.id, job.leaseToken);
  return { claimed: true, committed, staleLease: !committed, result };
}
