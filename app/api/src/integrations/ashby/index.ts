/**
 * ashby/index.ts — public surface of the typed Ashby client foundation.
 *
 * This module is intentionally NOT wired to any production route, queue, or
 * worker. It provides an injectable, hardened transport for a later
 * tenant-probe / integration step. No credentials are configured here and no
 * live Ashby connectivity is claimed.
 */

export { AshbyError, isAshbyError, type AshbyErrorCategory } from './errors.js';
export {
  AshbyClient,
  createAshbyClient,
  ASHBY_API_BASE_URL,
  type AshbyClientConfig,
  type AshbyClientLogger,
  type AshbyLogRecord,
  type AshbyTransport,
  type AshbyTransportRequest,
  type AshbyTransportResponse,
  type RequestOptions,
} from './client.js';
export { createMetadataLogger } from './logging.js';

// ── Wave 2 PR B: webhook ingress + reconciliation foundation ────────────────
export {
  loadAshbyConfig,
  isAshbyWebhookActive,
  describeAshbyConfig,
  MIN_WEBHOOK_SECRET_LENGTH,
  type AshbyIntegrationConfig,
} from './config.js';
export {
  verifyAshbySignature,
  DEFAULT_WEBHOOK_MAX_BYTES,
  type WebhookVerifyResult,
  type WebhookVerifyReason,
} from './webhook-verify.js';
export {
  extractWebhookSignal,
  extractApplicationInfo,
  stageDedupId,
  CANDIDATE_STAGE_CHANGE_ACTION,
  type WebhookSignal,
  type ApplicationInfoView,
} from './extractors.js';
export { ingestWebhook, isTriggerAction, type IngressOutcome, type IngressDeps } from './ingress.js';
export {
  runReconciliation,
  resolveSyncMode,
  SYNC_TOKEN_MAX_AGE_MS,
  DEFAULT_CHECKPOINT_KEY,
  type ReconcileResult,
  type ReconcileDeps,
  type ReconcileCaps,
  type ApplicationLister,
} from './reconciliation.js';
export {
  processAshbySignal,
  runClaimedAshbySignal,
  buildSignalEnqueueSpec,
  signalDedupKey,
  ASHBY_SIGNAL_QUEUE,
  CANDIDATE_DELETE_ACTION,
  type SignalDecision,
  type SignalResult,
  type SignalWorkerDeps,
  type MappingResolver,
  type MappingActivity,
} from './signal-worker.js';
export {
  createReceiptStore,
  createCheckpointStore,
  createMappingResolver,
  createAshbySignalQueue,
} from './stores.js';
export type {
  ReceiptStore,
  ReceiptOutcome,
  EnqueueSpec,
  CheckpointStore,
  SyncCheckpoint,
  AshbySignalPayload,
} from './ports.js';
export {
  ASHBY_OPERATIONS,
  type AshbyOperation,
  type AshbyEnvelope,
  type AshbySuccessEnvelope,
  type AshbyErrorEnvelope,
  type AshbyResult,
  type PaginatedList,
  type OpaqueRecord,
  type ApplicationListParams,
  type FeedbackSubmitRequest,
  type FeedbackRequestCreateRequest,
} from './types.js';

// ── Wave 2 PR C: screening-workflow domain + SSRF-hardened ephemeral fetch ───
export {
  checkFetchUrl,
  isPublicAddress,
  assertPublicAddresses,
  isIpLiteral,
  parseIpv4,
  type UrlPolicy,
  type UrlCheck,
  type AddressCheck,
  type SsrfReason,
} from './ssrf.js';
export {
  fetchEphemeralResume,
  type ResumeFetchLimits,
  type ResumeFetchDeps,
  type ResumeFetchOutcome,
  type ResumeTransport,
  type TransportResult,
  type TransportRequest,
  type FetchReason,
} from './resume-fetch.js';
export {
  runResumeIngestion,
  type IngestionState as ResumeIngestionState,
  type IngestionPorts,
  type IngestionProvenance,
  type IngestionOutcome,
  type StructuredResume,
  type ParseOutput,
  type IngestionScanResult,
  type CancelCheck,
} from './resume-ingestion.js';
export {
  runImport,
  runIngestionJob,
  runInviteDelivery,
  enqueueScorecard,
  enqueueStageMove,
  type ApplicationReader,
  type WorkflowStores,
  type ResolvedMapping,
  type OrchestrationGates,
  type ExistingLinkRow,
  type EnqueueResult,
  type OperationClaimRow,
  type ImportDeps,
  type ImportResult,
  type IngestionJobDeps,
  type IngestionJobResult,
  type InviteDeliveryDeps,
  type InviteDeliveryResult,
  type SagaDeps,
  type SagaResult,
} from './orchestration.js';
export {
  createWorkflowStores,
  createMissionControlStore,
  type MissionControlStore,
  type MissionControlMapping,
  type MissionControlWorkflow,
} from './workflow-stores.js';
export {
  createPinnedHttpsTransport,
  classifyStatus,
  pinnedLookup,
  type PinnedTransportOptions,
} from './resume-transport.js';
export {
  buildScorecard,
  bindFeedbackForm,
  mapOverallToScale,
  isScorecardSafe,
  isRelativeReviewPath,
  RECOMMENDATIONS,
  FORBIDDEN_SCORECARD_KEY_FRAGMENTS,
  type Recommendation,
  type ScorecardSource,
  type ScorecardScale,
  type ScorecardDimension,
  type NormalizedScorecard,
  type ScorecardBuild,
  type ScorecardFormBinding,
  type BoundFeedbackForm,
} from './scorecard.js';
export {
  decideImport,
  resolveApplicationIdentity,
  isSameApplicationIdentity,
  planTerminalCancellation,
  isHumanStageDeparture,
  TERMINAL_TRIGGERS,
  type MappingActivity as WorkflowMappingActivity,
  type ApplicationView,
  type TerminalTrigger,
  type ImportDecision,
  type ExistingLink,
  type IdentityDecision,
  type WorkflowOperation,
  type OperationType as WorkflowOperationType,
  type OperationState as WorkflowOperationState,
  type IngestionState as WorkflowIngestionState,
  type TerminalPlan,
} from './workflow.js';
export {
  channelsForMode,
  isValidDeliveryMode as isValidInviteDeliveryMode,
  decideInviteIssue,
  buildManualDelivery,
  isManualArtifactSafe,
  decideEmailSend,
  inviteDeliveryOperationKey,
  planReissue,
  DELIVERY_MODES as INVITE_DELIVERY_MODES,
  INVITE_TTL_HOURS,
  FORBIDDEN_MANUAL_KEY_FRAGMENTS,
  type DeliveryMode as InviteDeliveryMode,
  type ActiveInviteView,
  type InviteIssueDecision,
  type ManualDeliveryArtifact,
  type ManualDeliveryBuild,
  type EmailProviderState,
  type EmailSendDecision,
  type ReissuePlan,
} from './invite-delivery.js';
