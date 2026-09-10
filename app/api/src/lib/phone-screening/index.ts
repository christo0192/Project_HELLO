/**
 * phone-screening — the provider-neutral phone domain core.
 *
 * A DOMAIN ONLY. There is no provider client, no SIP, no dialing, no route, no
 * worker and no timer anywhere under this directory, and structural tests
 * assert each of those absences rather than trusting the description. Nothing
 * here can place a call, and the substrate it speaks to remains unreachable in
 * production until a validated Indian mobile exists on the candidate row.
 *
 * Deliberately NOT named `lib/phone` — `lib/phone.ts` already exists and an
 * extensionless import of `'../lib/phone'` would silently resolve to the FILE.
 * Two different modules one character apart is a trap; a distinct name is not.
 *
 * Explicit named re-exports only; `export *` is not used anywhere in this repo.
 */

export {
  PHONE_ENGAGEMENT_STATES,
  PHONE_TERMINAL_ENGAGEMENT_STATES,
  PHONE_ATTEMPT_STATES,
  PHONE_LIVE_ATTEMPT_STATES,
  PHONE_ATTEMPT_KINDS,
  PHONE_ADMISSIBLE_PRIOR_STATES,
  PHONE_OUTCOME_CLASSES,
  PHONE_APPOINTMENT_STATUSES,
  PHONE_LIVE_APPOINTMENT_STATUSES,
  PHONE_APPOINTMENT_SOURCES,
  PHONE_APPOINTMENT_CANCEL_REASONS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_VOICE_CALLBACK_DURATION_SECONDS,
  PHONE_VOICE_CALLBACK_MIN_LEAD_SECONDS,
  PHONE_EVENT_SOURCES,
  PHONE_RECORDING_ROLES,
  isPhoneRecordingRole,
  phoneAttemptRecordingObjectKey,
  phoneAttemptRecordingManifestKey,
  PHONE_EVENT_IGNORED_REASONS,
  PHONE_EVENT_TYPE_PATTERN,
  PHONE_PROVIDER_EVENT_ID_PATTERN,
  PHONE_HALT_REASONS,
  PHONE_SUPPRESSION_REASONS,
  PHONE_SUPPRESSION_SOURCES,
  PHONE_CONTROL_KEY,
  PHONE_BUDGET_CEILINGS,
  PHONE_DIAL_QUEUE_NAME,
  CONSENT_RECORD_STATUSES,
  CONSENT_TYPES,
  phoneDialDedupKey,
  isTerminalEngagementState,
  isLiveAttemptState,
  isPhoneOutcomeClass,
  type PhoneEngagementState,
  type PhoneTerminalEngagementState,
  type PhoneAttemptState,
  type PhoneLiveAttemptState,
  type PhoneAttemptKind,
  type PhoneAdmissiblePriorState,
  type PhoneOutcomeClass,
  type PhoneAppointmentStatus,
  type PhoneAppointmentSource,
  type PhoneAppointmentCancelReason,
  type PhoneEventSource,
  type PhoneEventIgnoredReason,
  type PhoneHaltReason,
  type PhoneSuppressionReason,
  type PhoneSuppressionSource,
  type PhoneRecordingRole,
  type ConsentRecordStatus,
  type ConsentType,
} from './vocabulary.js';

export {
  decidePhoneOutcome,
  decisionIsTerminal,
  resetsReconnectBudget,
  PHONE_OUTCOME_MIGRATION_REASONS,
  type PhoneBudgetCounters,
  type PhoneChargeClass,
  type PhoneDeferral,
  type PhoneDisconnectCause,
  type PhoneOutcomeContext,
  type PhoneOutcomeDecision,
} from './budget.js';

export {
  IST_TIME_ZONE,
  PHONE_IST_WINDOW,
  PHONE_24X7_WINDOW,
  PHONE_TEMPORARY_247_UNTIL_IST,
  PHONE_IST_WINDOW_OPEN_AT,
  PHONE_IST_WINDOW_CLOSE_AT,
  PHONE_MAX_CONCURRENT,
  istDate,
  istSecondsOfDay,
  istWallClock,
  istWallClockToInstant,
  istWindowForDate,
  istWindowOpen,
  narrowIstWindow,
  nextIstDayWindowOpen,
  nextIstWindowOpen,
  parseIstClockTime,
  type IstWallClock,
  type IstWindowBounds,
} from './ist-window.js';

export {
  PHONE_OPENING_GATE_SECONDS,
  PHONE_BOUNDS,
  PHONE_DIAL_MODES,
  MAX_DIAL_ALLOWLIST_ENTRIES,
  describePhoneScreeningConfig,
  isDialAllowedForDigest,
  isLiveDialPermitted,
  isPhoneRuntimeActive,
  loadPhoneScreeningConfig,
  parseDialAllowlist,
  parseDialMode,
  type PhoneDialMode,
  type PhoneScreeningConfig,
} from './config.js';

export {
  PHONE_RPC_NAMES,
  PHONE_RPC_PARAMETERS,
  PHONE_RPC_RESULT_KEYS,
  PHONE_RPC_STATUSES,
  PHONE_RPC_STATUS_COUNT,
  PHONE_RPC_STATUS_UNION,
  PHONE_RPC_UNKNOWN_STATUS,
  narrowPhoneRpcStatus,
  type AdmitPhoneAttemptStatus,
  type ApplyPhoneEventStatus,
  type CancelPhoneAppointmentStatus,
  type ClearPhoneHaltStatus,
  type ExpirePhoneAppointmentsStatus,
  type HeartbeatPhoneAttemptStatus,
  type PhoneBacklogStatus,
  type PhoneRpcName,
  type ReclaimPhoneAttemptLeasesStatus,
  type SchedulePhoneAppointmentStatus,
  type ConfirmCandidateVoiceCallbackStatus,
  type SetPhoneHaltStatus,
  type AttachPhoneAttemptRecordingStatus,
  type FinalizePhoneAttemptRecordingStatus,
  type ListPhoneEngagementRecordingsStatus,
  type ClearPhoneAttemptRecordingsStatus,
  type RequestPhoneRescreenStatus,
} from './rpc-contract.js';

export type {
  AdmitPhoneAttemptInput,
  AdmitPhoneAttemptResult,
  ApplyPhoneEventInput,
  ApplyPhoneEventResult,
  CancelPhoneAppointmentInput,
  CancelPhoneAppointmentResult,
  ClearPhoneHaltResult,
  ExpirePhoneAppointmentsResult,
  HeartbeatPhoneAttemptInput,
  HeartbeatPhoneAttemptResult,
  PhoneAdmissionRefusalDetail,
  PhoneBacklogResult,
  PhoneStores,
  ReclaimPhoneAttemptLeasesResult,
  SchedulePhoneAppointmentInput,
  SchedulePhoneAppointmentResult,
  ConfirmCandidateVoiceCallbackInput,
  ConfirmCandidateVoiceCallbackResult,
  RequestPhoneRescreenInput,
  RequestPhoneRescreenResult,
  SetPhoneHaltResult,
  AttachPhoneAttemptRecordingInput,
  AttachPhoneAttemptRecordingResult,
  FinalizePhoneAttemptRecordingResult,
  ListPhoneEngagementRecordingsResult,
  ClearPhoneAttemptRecordingsResult,
  PhoneRecordingArtifact,
  CommitPhoneQuestionBoundaryInput,
  CommitPhoneQuestionBoundaryResult,
  PhoneAssessmentState,
  PhoneAssessmentStateStatus,
  PhoneAssessmentTurn,
  PhoneBoundaryTurn,
  PhonePlanQuestion,
  StartPhoneAssessmentInput,
  RecordPhoneProbeInput,
  RecordPhoneProbeResult,
  ConsentAndStartPhoneAssessmentInput,
  ConsentAndStartPhoneAssessmentResult,
  CommitPhoneGateTurnsInput,
  CommitPhoneGateTurnsResult,
  CommitPhoneGateTurnsStatus,
} from './ports.js';

export { createPhoneStores, PHONE_SYSTEM_ACTOR } from './stores.js';

export {
  CONSENT_PREFLIGHT_REFUSALS,
  consentPreflight,
  type ConsentPreflightRefusal,
  type ConsentPreflightResult,
  type ConsentReader,
  type ConsentRecordSnapshot,
  type ConsentTemplateSnapshot,
} from './consent.js';

export {
  PHONE_DEFERRAL_CODES,
  admitPhoneEngagement,
  type PhoneAdmissionDeps,
  type PhoneAdmissionRequest,
  type PhoneAdmissionResult,
  type PhoneDeferralCode,
} from './admission.js';

export type {
  PhoneAppointmentRow,
  PhoneAttemptRow,
  PhoneCandidateRow,
  PhoneEngagementRow,
  PhoneReadStore,
} from './read-ports.js';

export { createPhoneReadStore, boundedRowLimit, PHONE_READ_MAX_ROWS } from './read-stores.js';

export {
  PHONE_SLOT_REFUSALS,
  buildPhoneSlotGrid,
  istDayInstantRange,
  parseIstCalendarDate,
  type IstCalendarDate,
  type PhoneSlot,
  type PhoneSlotGridInput,
  type PhoneSlotOccupancy,
  type PhoneSlotRefusal,
} from './slots.js';

export {
  PHONE_RESIDUAL_CODES,
  PHONE_SUBSTRATE_RESIDUALS,
  type PhoneResidualCode,
  type PhoneSubstrateResidual,
} from './residuals.js';
