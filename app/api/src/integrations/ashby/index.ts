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
  createSignalEnqueuer,
  createAshbySignalQueue,
} from './stores.js';
export type {
  ReceiptStore,
  ReceiptOutcome,
  CheckpointStore,
  SyncCheckpoint,
  SignalEnqueuer,
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
