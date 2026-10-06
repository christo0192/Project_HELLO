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

// ── M013 S02 (T04): the leg timing the worker reports on /recording/complete ──

/**
 * Sanity window for the worker's epoch-ms leg timing. A value earlier than
 * `answered_at − 30 s` or later than `now + 60 s` is DROPPED (logged by the
 * caller), never rejected: the values are display-only and the recording must
 * still be kept. The 30 s allows worker/API clock skew and a late
 * `call.answered` post.
 */
export const LEG_TIMING_BEFORE_ANSWER_SLACK_MS = 30_000;
export const LEG_TIMING_AFTER_NOW_SLACK_MS = 60_000;
/** 0118 `recording_duration_ms` CHECK: 1 ms to 24 h. */
export const LEG_TIMING_MAX_DURATION_MS = 86_400_000;
/** 0118 `observed_ended_at` CHECK floor: `admitted_at − 5 min`. */
const OBSERVED_END_ADMITTED_FLOOR_MS = 5 * 60_000;
/** 0118 `recording_started_at_ms` CHECK: [2020-01-01, 2100-01-01). */
const EPOCH_MS_CHECK_MIN = 1_577_836_800_000;
const EPOCH_MS_CHECK_MAX = 4_102_444_800_000;

/** The worker's leg-end marks (recording.py `mark_leg_end` sources). */
export const WORKER_LEG_END_SOURCES = ['sip_left', 'session_close', 'finish'] as const;
export type WorkerLegEndSource = (typeof WORKER_LEG_END_SOURCES)[number];

/** The optional timing fields of a `/recording/complete` body (T02 worker). */
export interface WorkerLegTimingReport {
  readonly recordingStartedAtMs?: number | null;
  readonly legEndedAtMs?: number | null;
  /**
   * Which worker mark `legEndedAtMs` is: `sip_left` (the SIP participant
   * left: an OBSERVED end), `session_close` (an upper bound, possibly
   * seconds late) or `finish` (the last-resort teardown time). Only
   * `sip_left` is stamped as `observed_ended_at`; anything else (or absent)
   * is a teardown time, dropped as `leg_end_not_observed`.
   */
  readonly legEndSource?: WorkerLegEndSource | null;
  /** The TRUE audio length the worker encoded (T02), not a wall-clock span. */
  readonly durationMs?: number | null;
  readonly tailFlushed?: boolean | null;
}

/** The attempt columns the stamp reads. Timestamps as ISO strings. */
export interface AttemptLegTimingRow {
  readonly answeredAt: string | null;
  readonly admittedAt: string | null;
  readonly endedAt: string | null;
  readonly observedEndedAt: string | null;
  readonly recordingStartedAtMs: number | null;
  readonly recordingDurationMs: number | null;
  readonly recordingTailFlushed: boolean | null;
}

/** Column patch for `phone_call_attempts`. Only changed columns are present. */
export interface AttemptLegTimingPatch {
  observed_ended_at?: string;
  recording_started_at_ms?: number;
  recording_duration_ms?: number;
  recording_tail_flushed?: boolean;
}

export type LegTimingDropReason =
  | 'recording_started_at_out_of_window'
  | 'leg_ended_at_out_of_window'
  | 'leg_end_not_observed'
  | 'duration_out_of_range'
  | 'no_answer_anchor';

export interface AttemptLegTimingPlan {
  readonly patch: AttemptLegTimingPatch;
  readonly dropped: ReadonlyArray<LegTimingDropReason>;
}

function isoMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide what (if anything) to stamp on the attempt. PURE: no clock, no I/O.
 *
 * Idempotent by construction, so a worker retry or the late reporter can
 * never move a stamped value:
 *   - `observed_ended_at` = the EARLIEST observed end ever reported, bounded
 *     by the ledger's `ended_at` when the attempt has ended
 *     (`least(coalesce(existing, new), new)` with `new = min(leg_end, ended_at)`);
 *   - every other column is first-write-wins (`coalesce(existing, new)`).
 * A value outside the sanity window or the 0118 CHECK ranges is dropped and
 * reported, never written.
 */
export function planAttemptLegTimingStamp(
  row: AttemptLegTimingRow,
  report: WorkerLegTimingReport,
  now: Date,
): AttemptLegTimingPlan {
  const patch: AttemptLegTimingPatch = {};
  const dropped: LegTimingDropReason[] = [];

  const admittedMs = isoMs(row.admittedAt);
  const anchorMs = isoMs(row.answeredAt) ?? admittedMs;
  const upperMs = now.getTime() + LEG_TIMING_AFTER_NOW_SLACK_MS;
  let lowerMs: number | null = anchorMs === null ? null : anchorMs - LEG_TIMING_BEFORE_ANSWER_SLACK_MS;
  if (lowerMs !== null && admittedMs !== null) {
    lowerMs = Math.max(lowerMs, admittedMs - OBSERVED_END_ADMITTED_FLOOR_MS);
  }
  const inWindow = (ms: number): boolean => lowerMs !== null
    && ms >= lowerMs && ms <= upperMs
    && ms >= EPOCH_MS_CHECK_MIN && ms < EPOCH_MS_CHECK_MAX;
  const epochReported = (v: number | null | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v);

  const epochValues = [report.recordingStartedAtMs, report.legEndedAtMs].filter(epochReported);
  if (epochValues.length > 0 && lowerMs === null) dropped.push('no_answer_anchor');

  // recording_started_at_ms — first write wins.
  if (epochReported(report.recordingStartedAtMs) && lowerMs !== null) {
    const started = Math.trunc(report.recordingStartedAtMs);
    if (!inWindow(started)) dropped.push('recording_started_at_out_of_window');
    else if (row.recordingStartedAtMs === null) patch.recording_started_at_ms = started;
  }

  // observed_ended_at — earliest wins, bounded by the ledger end. ONLY an
  // observed SIP leave: a `session_close` / `finish` mark (or a body with no
  // source) is a teardown time, possibly seconds or minutes late, and
  // stamping it would over-count the leg and pass for SIP-leave evidence.
  if (epochReported(report.legEndedAtMs) && lowerMs !== null && report.legEndSource !== 'sip_left') {
    dropped.push('leg_end_not_observed');
  } else if (epochReported(report.legEndedAtMs) && lowerMs !== null) {
    const legEnd = Math.trunc(report.legEndedAtMs);
    if (!inWindow(legEnd)) {
      dropped.push('leg_ended_at_out_of_window');
    } else {
      const endedMs = isoMs(row.endedAt);
      const candidate = endedMs === null ? legEnd : Math.min(legEnd, endedMs);
      const existing = isoMs(row.observedEndedAt);
      if (existing === null || candidate < existing) {
        patch.observed_ended_at = new Date(candidate).toISOString();
      }
    }
  }

  // recording_duration_ms — first write wins, within the 0118 CHECK.
  if (typeof report.durationMs === 'number' && Number.isFinite(report.durationMs)) {
    const duration = Math.trunc(report.durationMs);
    if (duration < 1 || duration > LEG_TIMING_MAX_DURATION_MS) dropped.push('duration_out_of_range');
    else if (row.recordingDurationMs === null) patch.recording_duration_ms = duration;
  }

  // recording_tail_flushed — first write wins.
  if (typeof report.tailFlushed === 'boolean' && row.recordingTailFlushed === null) {
    patch.recording_tail_flushed = report.tailFlushed;
  }

  return { patch, dropped };
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
  /**
   * 0105. The engagement's state at prepare time. The SESSION pointer (0051
   * stamp) is written only when this is `in_call` — i.e. consent was applied —
   * because `call_sessions` are reused across attempts: a pre-consent clip
   * that stamped the session would claim the slot, and the consented
   * screening recorded on a later attempt would upload to a key nothing ever
   * links (`finalizeAuthoritativeRecording` returns `ready` on the already
   * linked key). Unknown/absent ⇒ treated as NOT `in_call`.
   */
  readonly engagementState?: string | null;
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
  attemptId: string,
): Promise<PhoneRecordingRole | undefined> {
  const existing = await stores.listEngagementRecordings({ engagementId });
  if (existing.status !== 'ok' || existing.artifacts === undefined) return undefined;
  const own = existing.artifacts.find((artifact) => artifact.attemptId === attemptId);
  if (own !== undefined) return own.role;
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

  const role = await decideRole(input.engagementId, deps.stores, input.attemptId);
  if (role === undefined) {
    return { status: 'refused', refusal: 'role_undecidable', boundForUpload: false };
  }

  // This pointer is evidence-only. It is not phone_call_attempts.session_id,
  // does not activate an assessment, and does not claim the session recording
  // slot. Production supplies the SQL validation RPC; fail closed if a caller
  // has not wired that capability.
  if (!deps.stores.bindPhoneAttemptRecordingSession) {
    return { status: 'refused', refusal: 'evidence_binding_unavailable', boundForUpload: false };
  }
  const evidenceBinding = await deps.stores.bindPhoneAttemptRecordingSession({
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    engagementId: input.engagementId,
    now: input.now,
  });
  if (evidenceBinding.status !== 'ok') {
    return { status: 'refused', refusal: evidenceBinding.status, boundForUpload: false };
  }

  const egressId = workerRecordingEgressId(input.attemptId);
  const stampAfterConsent = async (): Promise<{ sessionStamped?: boolean; stampStatus?: string }> => {
    if (input.engagementState !== 'in_call') return { stampStatus: 'deferred_until_consent' };
    try {
      const stamped = await deps.stores.stampSessionEgress({
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        egressId,
        now: input.now,
      });
      return {
        sessionStamped: stamped.status === 'ok' || stamped.status === 'egress_already_bound',
        stampStatus: stamped.status,
      };
    } catch {
      return { sessionStamped: false, stampStatus: 'store_error' };
    }
  };

  // ── STEP 1. The gate. Nothing has an upload URL yet. ────────────────
  const attached = await deps.stores.attachAttemptRecording({
    attemptId: input.attemptId,
    objectKey,
    manifestKey,
    role,
    now: input.now,
  });

  if (attached.status === 'ok' && attached.duplicate === true) {
    // Answer-time prepare may have attached first. Re-run the idempotent
    // activation and consent-time stamp before re-minting, rather than
    // returning before the in_call session stamp.
    await deps.stores.finalizeAttemptRecording({
      attemptId: input.attemptId,
      egressStatus: 'active',
      egressId,
      now: input.now,
    });
    const stamp = await stampAfterConsent();
    const reMint = await deps.signer.createUploadUrl(objectKey);
    if (reMint === null) {
      return {
        status: 'upload_url_failed', role, objectKey, manifestKey,
        sessionStamped: stamp.sessionStamped, stampStatus: stamp.stampStatus,
        boundForUpload: false,
      };
    }
    return {
      status: 'already_prepared', role, objectKey, manifestKey,
      uploadUrl: reMint.uploadUrl, boundForUpload: true,
      sessionStamped: stamp.sessionStamped, stampStatus: stamp.stampStatus,
    };
  }
  if (attached.status !== 'ok') {
    return { status: 'refused', refusal: attached.status, boundForUpload: false };
  }

  // ── STEP 2. The binding exists. Record the synthetic egress id. ─────
  await deps.stores.finalizeAttemptRecording({
    attemptId: input.attemptId,
    egressStatus: 'active',
    egressId,
    now: input.now,
  });

  // ── STEP 3. Make the SESSION see it (0051), best-effort. ────────────
  // An unstamped recording is UNFINDABLE by the session-keyed read path; the
  // route caller logs a missed stamp loudly (this package is console-free).
  const stamp = await stampAfterConsent();

  // ── STEP 4. Mint the presigned PUT the worker uploads to. ───────────
  const minted = await deps.signer.createUploadUrl(objectKey);
  if (minted === null) {
    // The binding exists but no URL could be minted. That is the SAFE
    // asymmetry: the purge enumerates by binding, so an object that is never
    // written is simply "nothing to purge". The reverse — an object with no
    // binding — is impossible because step 1 ran first.
    return {
      status: 'upload_url_failed', role, objectKey, manifestKey,
      sessionStamped: stamp.sessionStamped, stampStatus: stamp.stampStatus, boundForUpload: false,
    };
  }

  return {
    status: 'prepared', role, objectKey, manifestKey,
    uploadUrl: minted.uploadUrl,
    sessionStamped: stamp.sessionStamped, stampStatus: stamp.stampStatus,
    boundForUpload: true,
  };
}
