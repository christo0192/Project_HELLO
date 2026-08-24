/**
 * lib/phone-runtime — the phone lane's runtime orchestration.
 *
 * Explicit named re-exports only; `export *` is not used anywhere in this repo.
 * Importing this barrel constructs nothing and arms no timer.
 */

export {
  PHONE_DIAL_QUEUE,
  PHONE_RUNTIME_BOUNDS,
  describePhoneRuntimeConfig,
  loadPhoneRuntimeConfig,
  type PhoneRuntimeBound,
  type PhoneRuntimeConfig,
} from './config.js';

export {
  PHONE_DIAL_JOB_OUTCOMES,
  createPhoneDialHandler,
  isPhoneDialPayload,
  type PhoneDialJobOutcome,
  type PhoneDialJobPayload,
} from './dial-handler.js';

export {
  PHONE_DUE_SKIPS,
  dueAttemptKind,
  dueByClock,
  runPhoneDuePass,
  type PhoneDueDeps,
  type PhoneDueResult,
  type PhoneDueSkip,
  type PhoneDialPort,
  type PhoneSessionPort,
} from './due-loop.js';

export {
  PHONE_DUE_STATES,
  PHONE_RUNTIME_MAX_ROWS,
  PHONE_SESSION_MODE,
  REUSABLE_SESSION_STATUSES,
  boundedRowLimit,
  createPhoneRuntimeReader,
  type DuePhoneEngagement,
  type PhoneDueState,
  type PhoneRuntimeReader,
} from './read.js';

export { createPhoneRoomClients, type PhoneRoomClients } from './livekit-clients.js';

export {
  clearPhoneRuntimeRegistration,
  phoneRuntimeDegradeReasons,
  phoneRuntimeView,
  registerPhoneRuntime,
  type PhoneLoopHealthView,
  type PhoneRuntimeView,
} from './health.js';

export {
  createPhoneRuntime,
  createPhoneSessionPort,
  type PhoneRuntimeHandle,
  type PhoneRuntimeOptions,
  type PhoneRuntimeSnapshot,
} from './runtime.js';
