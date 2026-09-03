/**
 * livekit-phone-dial/worker-recording.ts — the WORKER-INBAND provider branch.
 *
 * PR A, additive + flag-gated. This module is the `RECORDING_PROVIDER=worker`
 * twin of `recording.ts`'s `startPhoneAttemptRecording`, and it deliberately
 * does NOT edit that file: `recording.ts` owns the ask-first-record-second
 * ordering for the LiveKit-Cloud egress path and is pinned console-free and
 * SDK-symbol-free, so the safe move is to REUSE its store methods here rather
 * than reach into it.
 *
 * ── WHAT IS REUSED VERBATIM, AND WHY ──────────────────────────────────
 * The consent gate is `attach_phone_attempt_recording` (0043): it refuses
 * unless the engagement is already `in_call`, a state 0042 reaches through
 * exactly one transition (`disclosure.delivered`). The role decision reads
 * `listEngagementRecordings` (authoritative for the first consented attempt,
 * supplementary for every reconnect), identically to `recording.ts`'s private
 * `decideRole`. This module calls the SAME two store methods in the SAME order,
 * so a pre-consent / refused / undecidable attempt attaches NOTHING and
 * therefore gets NO upload URL — the exact invariant the egress path guarantees.
 *
 * ── WHAT DIFFERS FROM THE EGRESS PATH ─────────────────────────────────
 *   * There is no `EgressClient`. Instead of starting a room-composite egress,
 *     the object is written by the WORKER: this module mints a presigned PUT to
 *     the DERIVED attempt-scoped object key and hands it back. The worker PUTs
 *     the transcoded MP3 there, then calls `/recording/complete`.
 *   * The provider egress id is SYNTHETIC (`EG_worker_<attempt>`), shaped to
 *     pass `stamp_phone_session_egress`'s `^EG_[A-Za-z0-9_-]{4,200}$` guard.
 *     There is no LiveKit egress to stop or poll — the finalizer's worker branch
 *     downloads the already-uploaded object directly.
 *   * The session provenance is `worker_inband` (0078), stamped by the finalizer
 *     on `/recording/complete`, not `livekit_egress`.
 *
 * The object key is DERIVED from the attempt id (`phoneAttemptRecordingObjectKey`),
 * so the existing finalizer / download / purge contract keyed on that object
 * applies unchanged.
 */

import {
  phoneAttemptRecordingManifestKey,
  phoneAttemptRecordingObjectKey,
  type PhoneRecordingRole,
  type PhoneStores,
} from '../../lib/phone-screening/index.js';

/**
 * The synthetic egress id for a worker-inband recording.
 *
 * There is no LiveKit egress, but `stamp_phone_session_egress` (0051) writes
 * `recording_egress_id` on the session so the session-keyed read path (0038
 * finalize convergence, recruiter download route) can find the recording at
 * all. Its guard is `^EG_[A-Za-z0-9_-]{4,200}$`, so this id is prefixed `EG_`
 * and carries the attempt id (dashes are allowed by the class). It is stable
 * per attempt, so a retry of `/recording/prepare` stamps the same id and the
 * stamp reports `duplicate` rather than refusing.
 */
export function workerRecordingEgressId(attemptId: string): string {
  return `EG_worker_${attemptId}`;
}

/** The narrow storage slice this module needs — a single presigned-PUT mint. */
export interface WorkerRecordingUploadSigner {
  /**
   * Mint a presigned PUT for `objectKey`. The worker PUTs the MP3 to the
   * returned URL. Returns `null` on any failure so the caller can refuse
   * cleanly rather than throw a driver error at the worker.
   */
  createUploadUrl(objectKey: string): Promise<{ uploadUrl: string } | null>;
}

export const WORKER_RECORDING_PREPARE_STATUSES = [
  'prepared',
  'already_prepared',
  'refused',
  'upload_url_failed',
] as const;

export type WorkerRecordingPrepareStatus =
  (typeof WORKER_RECORDING_PREPARE_STATUSES)[number];

export interface PrepareWorkerRecordingInput {
  readonly engagementId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly now: Date;
}

export interface PrepareWorkerRecordingDeps {
  readonly stores: PhoneStores;
  readonly signer: WorkerRecordingUploadSigner;
}

export interface PrepareWorkerRecordingResult {
  readonly status: WorkerRecordingPrepareStatus;
  readonly role?: PhoneRecordingRole;
  readonly objectKey?: string;
  readonly manifestKey?: string;
  /** Present ONLY on `prepared`. A refusal never returns an upload URL. */
  readonly uploadUrl?: string;
  /** The DB refusal code, when the DB refused. Stable code only. */
  readonly refusal?: string;
  /** 0051 session-level egress stamp outcome (session-keyed read findability). */
  readonly sessionStamped?: boolean;
  readonly stampStatus?: string;
  /** Explicit, so "no recording bound / no URL minted" is asserted, not inferred. */
  readonly boundForUpload: boolean;
}

/**
 * Decide the role the SAME way `recording.ts` does: authoritative for the first
 * consented attempt of the engagement, supplementary for every reconnect;
 * `undefined` when the existing set is unreadable (which the caller treats as a
 * refusal — an unreadable enumeration is not evidence that nothing is there).
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

/**
 * Prepare the worker-inband recording for one attempt, or refuse and bind
 * nothing.
 *
 * The ORDER is the feature, exactly as it is in `recording.ts`:
 *   1. role decision (fail closed if unreadable)
 *   2. the consent gate — `attach_phone_attempt_recording` — binds the DERIVED
 *      keys and the role, or refuses. NOTHING has an upload URL yet.
 *   3. only AFTER a successful attach: record the synthetic egress id on the
 *      attempt, stamp the session (0051), and mint the presigned PUT.
 *
 * A refusal at step 1 or 2 returns NO `uploadUrl` and `boundForUpload:false`.
 */
export async function prepareWorkerRecording(
  input: PrepareWorkerRecordingInput,
  deps: PrepareWorkerRecordingDeps,
): Promise<PrepareWorkerRecordingResult> {
  const objectKey = phoneAttemptRecordingObjectKey(input.attemptId);
  const manifestKey = phoneAttemptRecordingManifestKey(input.attemptId);

  const role = await decideRole(input.engagementId, deps.stores);
  if (role === undefined) {
    return { status: 'refused', refusal: 'role_undecidable', boundForUpload: false };
  }

  // ── STEP 1. The gate. Nothing has an upload URL yet. ────────────────
  const attached = await deps.stores.attachAttemptRecording({
    attemptId: input.attemptId,
    objectKey,
    manifestKey,
    role,
    now: input.now,
  });

  if (attached.status === 'ok' && attached.duplicate === true) {
    // The identical triple was already bound by an earlier prepare. Re-mint the
    // upload URL so a retrying worker can still upload, but do not re-attach.
    const reMint = await deps.signer.createUploadUrl(objectKey);
    if (reMint === null) {
      return {
        status: 'upload_url_failed', role, objectKey, manifestKey,
        boundForUpload: false,
      };
    }
    return {
      status: 'already_prepared', role, objectKey, manifestKey,
      uploadUrl: reMint.uploadUrl, boundForUpload: true,
    };
  }
  if (attached.status !== 'ok') {
    return { status: 'refused', refusal: attached.status, boundForUpload: false };
  }

  // ── STEP 2. The binding exists. Record the synthetic egress id. ─────
  const egressId = workerRecordingEgressId(input.attemptId);
  await deps.stores.finalizeAttemptRecording({
    attemptId: input.attemptId,
    egressStatus: 'active',
    egressId,
    now: input.now,
  });

  // ── STEP 3. Make the SESSION see it (0051), best-effort. ────────────
  // An unstamped recording is UNFINDABLE by the session-keyed read path; the
  // route caller logs a missed stamp loudly (this package is console-free).
  let stampStatus: string;
  try {
    const stamped = await deps.stores.stampSessionEgress({
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      egressId,
      now: input.now,
    });
    stampStatus = stamped.status;
  } catch {
    stampStatus = 'store_error';
  }

  // ── STEP 4. Mint the presigned PUT the worker uploads to. ───────────
  const minted = await deps.signer.createUploadUrl(objectKey);
  if (minted === null) {
    // The binding exists but no URL could be minted. That is the SAFE
    // asymmetry: the purge enumerates by binding, so an object that is never
    // written is simply "nothing to purge". The reverse — an object with no
    // binding — is impossible because step 1 ran first.
    return {
      status: 'upload_url_failed', role, objectKey, manifestKey,
      sessionStamped: stampStatus === 'ok', stampStatus, boundForUpload: false,
    };
  }

  return {
    status: 'prepared', role, objectKey, manifestKey,
    uploadUrl: minted.uploadUrl,
    sessionStamped: stampStatus === 'ok', stampStatus,
    boundForUpload: true,
  };
}
