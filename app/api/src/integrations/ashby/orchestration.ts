/**
 * ashby/orchestration.ts — disabled-by-default workflow orchestrators that
 * COMPOSE the pure domain modules (workflow / resume-fetch / resume-ingestion /
 * invite-delivery / scorecard) with injected persistence + client seams into
 * the four executable stages of the Ashby screening workflow:
 *
 *   1. runImport            — re-read application.info → decideImport → resolve
 *                             identity → create/reuse link → seed ingestion +
 *                             per-mode invite delivery ops.
 *   2. runIngestionJob      — file.info → SSRF-hardened ephemeral fetch → scan →
 *                             parse → structure, advancing the ingestion state
 *                             machine through the durable store.
 *   3. runInviteDelivery    — issue/reuse one active invite; manual channel is a
 *                             token-free recruiter reissue link; email is
 *                             provider-gated; delivery is an idempotent op.
 *   4. runScorecardStageSaga— scorecard_write (idempotent by marker) → persist
 *                             external anchor → stage_move ONLY if still at the
 *                             mapped AI stage; human move cancels; scorecard
 *                             success + stage failure retries the stage only; no
 *                             auto-reject.
 *
 * Every side effect goes through an injected seam (`WorkflowStores`,
 * `ApplicationReader`, gates), so the whole matrix — including every failure
 * branch — is driven by synthetic adapters with zero real network/DB/provider.
 * Real Ashby mutations + email remain gated OFF; the code paths are complete.
 */

import { decideImport, type MappingActivity, type ApplicationView, type ImportDecision } from './workflow.js';
import { extractApplicationInfo } from './extractors.js';
import { runResumeIngestion, type IngestionPorts, type IngestionOutcome } from './resume-ingestion.js';
import {
  channelsForMode,
  decideInviteIssue,
  buildManualDelivery,
  decideEmailSend,
  inviteDeliveryOperationKey,
  type DeliveryMode,
  type ActiveInviteView,
  type EmailProviderState,
} from './invite-delivery.js';
import { buildScorecard, type ScorecardSource, type ScorecardScale } from './scorecard.js';
import type { AshbyResult, OpaqueRecord } from './types.js';

// ── Injected seams ───────────────────────────────────────────────────────────

/** Narrow reader over the authoritative Ashby application/candidate APIs. */
export interface ApplicationReader {
  applicationInfo<T = OpaqueRecord>(applicationId: string): Promise<AshbyResult<T>>;
  /**
   * Optional for synthetic adapters; the production client implements it.
   * Ashby may expose an attached resume only on candidate.info, not
   * application.info, so imports use this as an authoritative fallback.
   */
  candidateInfo?<T = OpaqueRecord>(candidateId: string): Promise<AshbyResult<T>>;
}

export interface ExistingLinkRow {
  id: string;
  externalApplicationId: string;
  terminalState?: 'withdrawn' | 'deleted' | 'manual_stage_cancel' | null;
  /**
   * The link's currently-stored opaque resume handle, if the store surfaces
   * it. Needed to decide whether a REUSED link still needs the handle
   * backfilled — see the backfill in `runImport`.
   */
  externalResumeFileHandle?: string | null;
}

export interface EnqueueResult {
  status: 'inserted' | 'duplicate' | 'duplicate_marker' | 'blocked_terminal' | string;
  id?: string;
}

export interface OperationClaimRow {
  id: string;
  operationType: 'invite_delivery' | 'scorecard_write' | 'stage_move';
  /**
   * The deterministic operation key. It encodes the delivery CHANNEL
   * (`ashby:invite:<app>:<channel>:<invite>`), which is why the claim RPC
   * returns it: without the key a `delivery_mode='both'` mapping enqueues two
   * operations that are indistinguishable at execution time, and both collapse
   * to the manual channel.
   */
  operationKey: string | null;
  applicationLinkId: string;
  leaseToken: string;
  attempts: number;
  maxAttempts: number;
  marker: string | null;
}

/** Durable persistence for the workflow (0029/0031 tables + RPCs). */
export interface WorkflowStores {
  findLinkByApplicationId(externalApplicationId: string): Promise<ExistingLinkRow | null>;
  createLink(input: {
    externalApplicationId: string;
    externalJobId: string;
    externalStageId: string;
    jobMappingId: string | null;
    externalResumeFileHandle: string | null;
  }): Promise<{ id: string }>;
  advanceIngestion(
    applicationLinkId: string,
    nextState: string,
    provenance?: { contentSha256?: string; extractorVersion?: string; structurerVersion?: string; failedReason?: string },
  ): Promise<{ status: string; state?: string }>;
  enqueueOperation(input: {
    applicationLinkId: string;
    operationType: 'invite_delivery' | 'scorecard_write' | 'stage_move';
    operationKey: string;
    dependsOn?: string | null;
    marker?: string | null;
  }): Promise<EnqueueResult>;
  /**
   * Backfill the opaque resume handle onto an EXISTING link that has none.
   * Optional so every existing fake keeps compiling; when absent the backfill
   * is simply skipped. Implementations must never overwrite a non-null handle.
   */
  bindLinkResumeHandle?(applicationLinkId: string, handle: string): Promise<void>;
  completeOperation(id: string, leaseToken: string, externalAnchor?: string | null, marker?: string | null): Promise<'ok' | 'not_owned'>;
  failOperation(id: string, leaseToken: string, errorCode: string, retryable: boolean): Promise<{ outcome: 'retry' | 'failed' } | 'not_owned'>;
}

/**
 * The runtime's persistence surface: {@link WorkflowStores} plus the seams a
 * live worker needs. Kept as a SEPARATE interface so the pure orchestrators —
 * and every existing fake that implements `WorkflowStores` — are unchanged; a
 * decision function has no business claiming a lease or parking a lifecycle.
 */
export interface RuntimeWorkflowStores extends WorkflowStores {
  /**
   * Leased claim of the next runnable operation of `operationType`. Returns
   * null when the queue is empty. The 0032 RPC never returns an operation
   * whose application link is terminal, and honours the scorecard-before-stage
   * dependency gate.
   *
   * This closes the single most load-bearing dead seam in the merged code:
   * `claim_ashby_operation` shipped in 0031 with no TypeScript caller, so
   * `OperationClaimRow` had no producer and `completeOperation`'s required
   * `leaseToken` was unobtainable.
   */
  claimOperation(
    operationType: 'invite_delivery' | 'scorecard_write' | 'stage_move',
    owner: string,
    leaseSeconds: number,
  ): Promise<OperationClaimRow | null>;
  /** Read the durable ingestion state for a link (null when absent). */
  readIngestion(applicationLinkId: string): Promise<{ state: string; attempts: number } | null>;
  /** Read the link row needed to materialize an invite (opaque ids only). */
  readLink(applicationLinkId: string): Promise<WorkflowLinkRow | null>;
  /** Read only bounded assessment fields needed for the approved scorecard sink. */
  readScorecardSource?(applicationLinkId: string): Promise<import('./scorecard.js').ScorecardSource | null>;
  /**
   * DEFER a running operation back to pending because a prerequisite stopped
   * holding after the claim. Refunds the attempt the claim charged and
   * reschedules behind a bounded delay.
   *
   * This is NOT `failOperation(..., retryable)`: that leaves the attempt spent
   * and reschedules with no backoff, which is how a five-attempt budget was
   * consumed in ~20 seconds by an invite waiting on an ingestion that was
   * working correctly. A wait is not a failure.
   */
  deferOperation(
    id: string,
    leaseToken: string,
    reasonCode: string,
    delaySeconds: number,
  ): Promise<'ok' | 'not_owned'>;
  /** Park a completed application as `writeback_pending` (audited, idempotent). */
  markWritebackPending(applicationLinkId: string, reason: string): Promise<{ status: string }>;
  /** Enqueue the verified scorecard sink after a durable assessment insert. */
  enqueueScorecardWrite?(applicationLinkId: string, sessionId: string): Promise<{ status: string }>;
  /**
   * CAS a manual invite_delivery operation from `running` to
   * `awaiting_manual_delivery`. The invite digest exists but no recruiter has
   * obtained a usable link, so this is deliberately NOT success.
   */
  parkOperationAwaitingDelivery(
    id: string,
    leaseToken: string,
    externalAnchor: string | null,
  ): Promise<'ok' | 'not_owned'>;
}

/** The link fields the runtime needs; deliberately no PII and no tokens. */
export interface WorkflowLinkRow {
  id: string;
  externalApplicationId: string;
  externalJobId: string | null;
  /**
   * Opaque resume file handle, or null when the application carried none.
   *
   * This — not "does an ingestion row exist" — is the authoritative answer to
   * "is this application resume-backed?". `runImport` seeds an ingestion row
   * for EVERY link, so the row-existence test was always true and a no-resume
   * application would have waited forever for an ingestion with nothing to do.
   */
  externalResumeFileHandle: string | null;
  jobMappingId: string | null;
  candidateId: string | null;
  sessionId: string | null;
  inviteId: string | null;
  lifecycle: string;
  terminalState: 'withdrawn' | 'deleted' | 'manual_stage_cancel' | null;
}

/** Mapping activity + tenant config resolved for a job. */
export interface ResolvedMapping extends MappingActivity {
  id: string | null;
  deliveryMode: DeliveryMode;
  externalResumeFileHandleFromApp?: string | null;
}

export interface OrchestrationGates {
  /** Master integration switch. When false, orchestrators no-op with 'disabled'. */
  enabled: boolean;
  /** Email provider gate. */
  email: EmailProviderState;
}

// ── 1. Import orchestrator ───────────────────────────────────────────────────

export type ImportResult =
  | { status: 'imported'; applicationLinkId: string; reused: boolean; decision: ImportDecision }
  | { status: 'skipped'; reason: string }
  | { status: 'disabled' };

export interface ImportDeps {
  gates: OrchestrationGates;
  client: ApplicationReader;
  stores: WorkflowStores;
  /** Resolve mapping activity + config for the re-read job id. */
  resolveMapping(jobId: string): Promise<ResolvedMapping>;
  /** Read the app's resume file handle from the authoritative info (opaque). */
  readResumeFileHandle?(info: unknown): string | null;
}

/**
 * Import one application by its opaque id. Re-reads the authoritative
 * application.info, applies {@link decideImport}, then (on eligibility) resolves
 * the application-id-only identity, creates/reuses exactly one link, seeds the
 * ingestion row, and enqueues the per-delivery-mode invite operation(s).
 */
export async function runImport(externalApplicationId: string, deps: ImportDeps): Promise<ImportResult> {
  if (!deps.gates.enabled) return { status: 'disabled' };

  const info = await deps.client.applicationInfo(externalApplicationId);
  const view: ApplicationView = extractApplicationInfo(info.results);
  const appId = view.applicationId ?? externalApplicationId;

  const existing = await deps.stores.findLinkByApplicationId(appId);
  if (existing?.terminalState) return { status: 'skipped', reason: 'terminal' };

  const jobId = view.jobId;
  if (!jobId) return { status: 'skipped', reason: 'no_job' };
  const mapping = await deps.resolveMapping(jobId);

  const decision = decideImport(view, mapping, existing?.terminalState ?? null);
  if (decision.action !== 'import') return { status: 'skipped', reason: decision.reason };

  // Application-id-only identity: reuse the existing non-terminal link or create one.
  // Ashby does not consistently include candidate-level attachments in
  // application.info. Fall back to candidate.info only when the application
  // payload has no usable handle; immediately discard everything except the
  // bounded opaque handle extracted by the injected reader.
  let resumeHandle = deps.readResumeFileHandle?.(info.results) ?? null;
  if (!resumeHandle && view.candidateId && deps.client.candidateInfo && deps.readResumeFileHandle) {
    const candidate = await deps.client.candidateInfo(view.candidateId);
    resumeHandle = deps.readResumeFileHandle(candidate.results);
  }
  let linkId: string;
  let reused: boolean;
  if (existing && existing.externalApplicationId === appId) {
    linkId = existing.id;
    reused = true;
    // Backfill-on-reuse. The handle used to be captured ONLY in the create
    // branch, so a link first imported before the application carried a resume
    // (or before the handle was readable) never acquired one on any later
    // re-import: `external_resume_file_handle` stayed null forever, ingestion
    // had nothing to resolve, and the invite went out down the no-resume path
    // with no resume ever ingested. Never overwrites an existing handle.
    if (resumeHandle && !existing.externalResumeFileHandle && deps.stores.bindLinkResumeHandle) {
      await deps.stores.bindLinkResumeHandle(linkId, resumeHandle);
    }
  } else {
    const created = await deps.stores.createLink({
      externalApplicationId: appId,
      externalJobId: jobId,
      externalStageId: decision.stageId,
      jobMappingId: mapping.id,
      externalResumeFileHandle: resumeHandle,
    });
    linkId = created.id;
    reused = false;
  }

  // Seed the ingestion row (idempotent) and enqueue invite delivery per mode.
  await deps.stores.advanceIngestion(linkId, 'queued');
  const channels = channelsForMode(mapping.deliveryMode);
  if (channels.email) {
    await deps.stores.enqueueOperation({
      applicationLinkId: linkId,
      operationType: 'invite_delivery',
      operationKey: inviteDeliveryOperationKey({ externalApplicationId: appId, channel: 'email', inviteId: 'pending' }),
    });
  }
  if (channels.manual) {
    await deps.stores.enqueueOperation({
      applicationLinkId: linkId,
      operationType: 'invite_delivery',
      operationKey: inviteDeliveryOperationKey({ externalApplicationId: appId, channel: 'manual', inviteId: 'pending' }),
    });
  }

  return { status: 'imported', applicationLinkId: linkId, reused, decision };
}

// ── 2. Ingestion job orchestrator ────────────────────────────────────────────

export type IngestionJobResult =
  | { status: 'done'; outcome: IngestionOutcome }
  | { status: 'disabled' }
  | { status: 'no_resume' };

export interface IngestionJobDeps {
  gates: OrchestrationGates;
  stores: WorkflowStores;
  /** Build the ephemeral ingestion ports (fetch/scan/guard/parse/fallback). */
  buildIngestionPorts(input: {
    applicationLinkId: string;
    onState: IngestionPorts['onState'];
  }): IngestionPorts | null;
  /** Poll: has the application become terminal since the job started? */
  isCancelled(applicationLinkId: string): Promise<boolean>;
}

/**
 * Run the ephemeral ingestion for one link, wiring each state emission through
 * the durable `advanceIngestion` store so restarts resume from the last state.
 */
export async function runIngestionJob(applicationLinkId: string, deps: IngestionJobDeps): Promise<IngestionJobResult> {
  if (!deps.gates.enabled) return { status: 'disabled' };
  const ports = deps.buildIngestionPorts({
    applicationLinkId,
    onState: async (state, provenance) => {
      await deps.stores.advanceIngestion(applicationLinkId, state, provenance);
    },
  });
  if (!ports) return { status: 'no_resume' };
  const outcome = await runResumeIngestion(ports, () => deps.isCancelled(applicationLinkId));
  return { status: 'done', outcome };
}

// ── 3. Invite delivery orchestrator ──────────────────────────────────────────

export type InviteDeliveryResult =
  | { status: 'issued' | 'reused'; channel: 'email' | 'manual'; delivery: 'sent' | 'blocked_provider' | 'manual_reissue' }
  | { status: 'blocked_terminal' }
  | { status: 'disabled' };

export interface InviteDeliveryDeps {
  gates: OrchestrationGates;
  /** Existing active invite for the application (if any). */
  existingActiveInvite: ActiveInviteView | null;
  applicationTerminal: boolean;
  externalApplicationId: string;
  /** Site-relative recruiter reissue path for the manual channel. */
  recruiterReissuePath: string;
}

/** Decide+shape one channel's invite delivery (no real send; gated). */
export function runInviteDelivery(channel: 'email' | 'manual', deps: InviteDeliveryDeps): InviteDeliveryResult {
  if (!deps.gates.enabled) return { status: 'disabled' };
  const decision = decideInviteIssue(deps.existingActiveInvite, deps.applicationTerminal);
  if (decision.action === 'blocked_terminal') return { status: 'blocked_terminal' };
  const status = decision.action === 'reuse_active' ? 'reused' : 'issued';

  if (channel === 'email') {
    const send = decideEmailSend(deps.gates.email);
    return { status, channel, delivery: send.action === 'send' ? 'sent' : 'blocked_provider' };
  }
  // Manual channel: token-free recruiter reissue indirection only.
  const manual = buildManualDelivery({
    externalApplicationId: deps.externalApplicationId,
    recruiterReissuePath: deps.recruiterReissuePath,
  });
  // A malformed path is surfaced as blocked; never a fabricated send.
  return { status, channel, delivery: manual.ok ? 'manual_reissue' : 'blocked_provider' };
}

// ── 4. Scorecard → stage saga ────────────────────────────────────────────────

export type SagaResult =
  | { status: 'scorecard_enqueued' | 'scorecard_duplicate'; marker: string }
  | { status: 'stage_enqueued' }
  | { status: 'stage_skipped'; reason: 'not_ai_stage' | 'human_moved' | 'scorecard_unconfirmed' }
  | { status: 'blocked_scorecard'; reason: string }
  | { status: 'disabled' };

export interface SagaDeps {
  gates: OrchestrationGates;
  stores: WorkflowStores;
  client: ApplicationReader;
  scale: ScorecardScale;
  applicationLinkId: string;
  externalApplicationId: string;
  /** The mapping's current AI screening stage id (for the re-read guard). */
  aiScreeningStageId: string;
  /** The scorecard_write operation id (if already enqueued) for the dependency. */
}

/**
 * Phase 1 of the saga: build the redaction-safe scorecard and enqueue the
 * scorecard_write op. The key is derived from the APPLICATION LINK alone, so
 * `uq_ashby_operations_key` enforces at most one scorecard per link no matter
 * how the content marker (or the review path inside it) changes — an Ashby
 * scorecard cannot be retracted. A duplicate key or marker short-circuits
 * (already written).
 */
export async function enqueueScorecard(source: ScorecardSource, deps: SagaDeps): Promise<SagaResult> {
  if (!deps.gates.enabled) return { status: 'disabled' };
  const built = buildScorecard(source, deps.scale);
  if (!built.ok) return { status: 'blocked_scorecard', reason: built.reason };
  const res = await deps.stores.enqueueOperation({
    applicationLinkId: deps.applicationLinkId,
    operationType: 'scorecard_write',
    operationKey: `ashby:scorecard:link:${deps.applicationLinkId}`,
    marker: built.marker,
  });
  if (res.status === 'inserted') return { status: 'scorecard_enqueued', marker: built.marker };
  if (res.status === 'duplicate' || res.status === 'duplicate_marker') {
    return { status: 'scorecard_duplicate', marker: built.marker };
  }
  return { status: 'blocked_scorecard', reason: res.status };
}

/**
 * Phase 2 of the saga: enqueue the stage_move ONLY after re-reading the
 * authoritative application and confirming it is STILL at the mapped AI stage
 * (a human move away → skip, never undo). The stage op depends on the scorecard
 * op so it cannot run before the scorecard succeeds.
 */
export async function enqueueStageMove(
  scorecardOperationId: string,
  deps: SagaDeps,
): Promise<SagaResult> {
  if (!deps.gates.enabled) return { status: 'disabled' };
  const info = await deps.client.applicationInfo(deps.externalApplicationId);
  const view = extractApplicationInfo(info.results);
  if (!view.currentStageId || view.currentStageId !== deps.aiScreeningStageId) {
    // A human/TA moved the application away from the AI stage — never undo it.
    return { status: 'stage_skipped', reason: 'human_moved' };
  }
  const res = await deps.stores.enqueueOperation({
    applicationLinkId: deps.applicationLinkId,
    operationType: 'stage_move',
    operationKey: `ashby:stage:${deps.externalApplicationId}:${deps.aiScreeningStageId}`,
    dependsOn: scorecardOperationId,
  });
  if (res.status === 'inserted' || res.status === 'duplicate') return { status: 'stage_enqueued' };
  return { status: 'stage_skipped', reason: 'scorecard_unconfirmed' };
}
