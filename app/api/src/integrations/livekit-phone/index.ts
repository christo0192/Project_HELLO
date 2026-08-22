/**
 * livekit-phone — inbound LiveKit phone webhook ingress and dropped-webhook
 * reconciliation over the 0042 substrate.
 *
 * Explicit named re-exports only (no `export *`), so the module's surface is
 * a decision rather than a side effect of what happens to be exported.
 */

export {
  loadLiveKitPhoneConfig,
  isPhoneWebhookActive,
  describeLiveKitPhoneConfig,
  MIN_LIVEKIT_CREDENTIAL_LENGTH,
  type LiveKitPhoneConfig,
} from './config.js';

export {
  LIVEKIT_WEBHOOK_EVENTS,
  PHONE_EVENT_BY_LIVEKIT_EVENT,
  APPROVED_PARTICIPANT_ATTRIBUTES,
  isLiveKitWebhookEvent,
  attemptIdFromIdentity,
  parsePhoneEpoch,
  phoneProviderEventId,
  resolvePhoneEvent,
  type LiveKitWebhookEvent,
  type LiveKitPhoneEnvelope,
  type PhoneEventResolution,
} from './events.js';

export {
  LIVEKIT_AUTH_HEADER,
  PHONE_WEBHOOK_VERIFY_REASONS,
  createPhoneWebhookVerifier,
  type PhoneWebhookVerifier,
  type PhoneWebhookVerifyReason,
  type PhoneWebhookVerifyResult,
} from './verify.js';

export {
  PHONE_UNRECORDED_STATUSES,
  isUnrecordedStatus,
  createPhoneIngressHealth,
  phoneIngressHealth,
  classifyApplyResult,
  ingestPhoneWebhook,
  type PhoneIngressHealth,
  type PhoneIngressOutcome,
  type PhoneIngressCode,
  type PhoneUnrecordedStatus,
} from './ingress.js';

export {
  PHONE_RECONCILE_BOUNDS,
  reconcileMinAgeSeconds,
  recoveredEventType,
  reconcileProviderEventId,
  runPhoneReconciliation,
  type PhoneReconcileResult,
  type PhoneReconcileDeps,
  type PhoneReconcileOptions,
} from './reconciliation.js';

export {
  createDuePhoneAttemptReader,
  createLiveKitRoomReader,
  createDefaultLiveKitRoomReader,
} from './stores.js';

export type {
  DuePhoneAttempt,
  DuePhoneAttemptReader,
  LiveKitParticipantSnapshot,
  LiveKitRoomReader,
} from './ports.js';
