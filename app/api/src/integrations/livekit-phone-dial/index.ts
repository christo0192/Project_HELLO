/**
 * livekit-phone-dial — the outbound dialer, deliberately a SEPARATE directory
 * from `livekit-phone`.
 *
 * `livekit-phone` is the INGRESS: it receives signed webhooks and posts events.
 * A structural test asserts, directory-wide, that nothing under it dials,
 * originates, mutates a room or controls an egress — a genuinely useful
 * property, and one that would have to be WEAKENED into a per-file allowlist
 * if the dialer lived beside it. A weakened tripwire is worse than no
 * tripwire, because it still reads like a guarantee.
 *
 * So the dialer gets its own directory and its own structural test, and each
 * assertion stays as strong as the thing it describes:
 *
 *   * nothing under `livekit-phone`      may dial;
 *   * nothing under `livekit-phone-dial` may reach the SDK from `synthetic`,
 *     bind a recording before the disclosure, or log a phone number.
 *
 * Explicit named re-exports only; `export *` is not used anywhere in this repo.
 */

export {
  PHONE_DIAL_BOUNDS,
  describePhoneDialConfig,
  isPhoneTransportReady,
  loadPhoneDialConfig,
  type PhoneDialConfig,
} from './config.js';

export {
  REDACTED,
  unwrapDialableNumber,
  wrapDialableNumber,
  type DialableNumber,
} from './dialable-number.js';

export {
  PHONE_EPOCH_ATTRIBUTE,
  createLiveSipClient,
  createSyntheticSipClient,
  phoneParticipantIdentity,
  resolvePhoneSipClient,
  type PhoneOriginateRequest,
  type PhoneOriginateResult,
  type PhoneSipClient,
  type SipClientResolution,
} from './sip.js';

export {
  PHONE_ROOM_CHANNEL,
  PHONE_ROOM_EMPTY_TIMEOUT_SEC,
  PHONE_ROOM_MAX_PARTICIPANTS,
  buildPhoneRoomMetadata,
  phoneRoomName,
  provisionPhoneRoom,
  type PhoneAgentDispatchClientLike,
  type PhoneRoomResult,
  type PhoneRoomServiceClientLike,
  type PhoneRoomStatus,
  type ProvisionPhoneRoomDeps,
  type ProvisionPhoneRoomInput,
} from './phone-room.js';

export {
  LEASE_MARGIN_SECONDS,
  PHONE_DIAL_REFUSALS,
  dialPhoneAttempt,
  type PhoneDialDeps,
  type PhoneDialRefusal,
  type PhoneDialRequest,
  type PhoneDialResult,
} from './dial.js';

export {
  PHONE_RECORDING_STATUSES,
  startPhoneAttemptRecording,
  type PhoneEgressClientLike,
  type PhoneEgressOutputFactory,
  type PhoneRecordingStatus,
  type StartPhoneRecordingDeps,
  type StartPhoneRecordingInput,
  type StartPhoneRecordingResult,
} from './recording.js';

export {
  PHONE_PURGE_STATUSES,
  purgePhoneEngagementRecordings,
  type PhonePurgeDeps,
  type PhonePurgeResult,
  type PhonePurgeStatus,
  type PhoneRecordingStorage,
} from './recording-purge.js';
