/**
 * livekit-phone-dial/recording.ts — attempt-scoped recording, and the ordering
 * that makes the disclosure gate real rather than aspirational.
 *
 * ── ASK FIRST, RECORD SECOND ──────────────────────────────────────────
 * The obvious implementation starts the egress and then writes down that it
 * started one. That order records a person and asks permission afterwards, and
 * if the write is refused the audio already exists.
 *
 * So the order here is inverted, and the inversion is the feature:
 *
 *   1. `attach_phone_attempt_recording` — binds the DERIVED keys and the role.
 *      0043 refuses unless the engagement is already `in_call`, and 0042
 *      reaches `in_call` through exactly one transition: `disclosure.delivered`.
 *      A caller at originate, at ring, at join, while unclassified, on a
 *      machine, or after a refusal is refused HERE, before anything records.
 *   2. Only then start the egress.
 *   3. `finalize_phone_attempt_recording` — record the provider's egress id.
 *
 * The keys can be bound before the egress exists because they are DERIVED from
 * the attempt id, not supplied by the provider. That is also why the purge can
 * name what it must delete even if step 2 or 3 dies: step 1 already wrote the
 * key down, so an egress orphaned by a crash is still enumerable.
 *
 * ── AUTHORITATIVE VS SUPPLEMENTARY ────────────────────────────────────
 * The FIRST consented attempt of an engagement is `authoritative`; every
 * reconnect after it is `supplementary`. The role is decided by reading what
 * already exists, but it is ENFORCED by a partial unique index — so two
 * concurrent reconnects cannot both win the read and both claim authoritative.
 * The loser gets `authoritative_exists` and retries as supplementary rather
 * than silently overwriting.
 */

import {
  phoneAttemptRecordingManifestKey,
  phoneAttemptRecordingObjectKey,
  type PhoneRecordingRole,
  type PhoneStores,
} from '../../lib/phone-screening/index.js';

/** The narrow slice of `EgressClient` this module uses. */
export interface PhoneEgressClientLike {
  startRoomCompositeEgress(
    roomName: string,
    output: unknown,
    options?: { audioOnly?: boolean; videoOnly?: boolean },
  ): Promise<{ egressId?: string }>;
  stopEgress(egressId: string): Promise<unknown>;
}

/**
 * Builds the provider-specific output descriptor. Injected rather than built
 * inline so a test can drive the whole ordering without constructing SDK proto
 * objects, and so this module names no SDK symbol at all.
 */
export type PhoneEgressOutputFactory = (objectKey: string) => unknown | Promise<unknown>;

export const PHONE_RECORDING_STATUSES = [
  'started',
  'already_started',
  'refused',
  'egress_failed',
  'orphaned',
] as const;

export type PhoneRecordingStatus = (typeof PHONE_RECORDING_STATUSES)[number];

export interface StartPhoneRecordingResult {
  readonly status: PhoneRecordingStatus;
  readonly role?: PhoneRecordingRole;
  readonly objectKey?: string;
  readonly manifestKey?: string;
  readonly egressId?: string;
  /** The DB refusal, when the DB is what refused. Stable code only. */
  readonly refusal?: string;
  /** Explicit, so "no recording started" can be asserted rather than inferred. */
  readonly egressStarted: boolean;
}

export interface StartPhoneRecordingInput {
  readonly engagementId: string;
  readonly attemptId: string;
  readonly roomName: string;
  readonly now: Date;
}

export interface StartPhoneRecordingDeps {
  readonly stores: PhoneStores;
  readonly egress: PhoneEgressClientLike;
  readonly buildOutput: PhoneEgressOutputFactory;
}

/**
 * Start this attempt's recording, or refuse and record nothing.
 *
 * `egressStarted` is returned explicitly. The mandated negative tests assert
 * that no egress began on the machine, refusal and pre-disclosure paths, and
 * an assertion that infers that from a missing field would keep passing if the
 * field were dropped.
 */
export async function startPhoneAttemptRecording(
  input: StartPhoneRecordingInput,
  deps: StartPhoneRecordingDeps,
): Promise<StartPhoneRecordingResult> {
  const objectKey = phoneAttemptRecordingObjectKey(input.attemptId);
  const manifestKey = phoneAttemptRecordingManifestKey(input.attemptId);

  const role = await decideRole(input.engagementId, deps.stores);
  if (role === undefined) {
    // We could not read what already exists, so we cannot tell whether this
    // attempt would be the authoritative one. Fail closed: an unreadable
    // enumeration is not evidence that nothing is there.
    return { status: 'refused', refusal: 'role_undecidable', egressStarted: false };
  }

  // ── STEP 1. The gate. Nothing has recorded anything yet. ────────────
  const attached = await deps.stores.attachAttemptRecording({
    attemptId: input.attemptId,
    objectKey,
    manifestKey,
    role,
    now: input.now,
  });

  if (attached.status === 'ok' && attached.duplicate === true) {
    // The identical triple was already bound. A retry of a call that already
    // succeeded must not start a SECOND egress writing to the same key.
    return { status: 'already_started', role, objectKey, manifestKey, egressStarted: false };
  }
  if (attached.status !== 'ok') {
    return { status: 'refused', refusal: attached.status, egressStarted: false };
  }

  // ── STEP 2. Only now may audio be captured. ─────────────────────────
  let egressId: string | undefined;
  try {
    const info = await deps.egress.startRoomCompositeEgress(
      input.roomName,
      await deps.buildOutput(objectKey),
      // A telephone call has no video track. `audioOnly` is not an
      // optimisation here, it is the only correct description of the source.
      { audioOnly: true, videoOnly: false },
    );
    egressId = typeof info.egressId === 'string' ? info.egressId : undefined;
  } catch {
    // The binding exists and the egress does not. That is the SAFE asymmetry:
    // the purge enumerates by binding, so it will look for an object that may
    // never have been written, and "nothing to purge" is a distinct success.
    // The reverse asymmetry — audio with no binding — is the one that loses
    // data, and step 1 is what makes it impossible.
    return { status: 'egress_failed', role, objectKey, manifestKey, egressStarted: false };
  }

  if (egressId === undefined) {
    // The provider accepted the request and returned no identifier, so we have
    // an egress we cannot stop by id. Stopping is impossible, so the recording
    // is reported as orphaned rather than as started — the key is bound, so
    // the purge can still find whatever lands at it.
    return { status: 'orphaned', role, objectKey, manifestKey, egressStarted: true };
  }

  // ── STEP 3. Record the provider's identifier. ───────────────────────
  await deps.stores.finalizeAttemptRecording({
    attemptId: input.attemptId,
    egressStatus: 'active',
    egressId,
    now: input.now,
  });

  return { status: 'started', role, objectKey, manifestKey, egressId, egressStarted: true };
}

/**
 * `authoritative` for the first consented attempt of the engagement,
 * `supplementary` for every reconnect after it. `undefined` when the existing
 * set could not be read at all, which the caller must treat as a refusal.
 *
 * This read DECIDES the role; the partial unique index ENFORCES it. Two
 * concurrent reconnects can both read "no authoritative yet"; only one can
 * write it, and the other is refused by the index rather than overwriting.
 */
async function decideRole(
  engagementId: string,
  stores: PhoneStores,
): Promise<PhoneRecordingRole | undefined> {
  const existing = await stores.listEngagementRecordings({ engagementId });
  if (existing.status !== 'ok' || existing.artifacts === undefined) return undefined;
  return existing.artifacts.some((a) => a.role === 'authoritative')
    ? 'supplementary'
    : 'authoritative';
}
