/**
 * attempt-leg-timing.ts — what is actually known about ONE phone leg's
 * connected window and its recording, and the per-session roll-up built from
 * those legs (M013 S02 T07, roadmap S02-2 / S02-3).
 *
 * WHY. A phone session can span several legs (a first call and reconnects).
 * `call_sessions.duration_sec` summed every leg's `answered_at -> ended_at`,
 * and a leg that nobody saw end was "ended" by the lease reclaim minutes after
 * the candidate hung up: 9f60523d read "7m 23s on the call" for 53 s + 18 s of
 * audio. The surfaces now read per-leg facts instead, each with its source:
 *
 * - connected window: `answered_at` -> the observed SIP leave (0125
 *   `observed_ended_at`, `observed`; the ledger end instead when that is
 *   earlier), else the ledger end (`ledger`). A leg ended only by the lease
 *   reclaim with no observed end is `unobserved`: its `connected_to` is the
 *   time the timeout DETECTED it, and it has no `connected_sec`, because that
 *   span is not call time. A leg whose only end is the one our reconciler
 *   sweep recorded (`sip.participant_left` posted by `source =
 *   'reconciliation'`) is `detected`: that time is when the sweep NOTICED the
 *   empty room, up to a reconcile interval after the hang-up, so it is an
 *   upper bound with no exact `connected_sec` either.
 * - recorded length: the worker's true audio length (0125
 *   `recording_duration_ms`), else, for a legacy worker MP3, an estimate from
 *   the file size at the worker's fixed 64 kbps CBR, flagged as estimated.
 * - `tail_may_be_missing`: a worker recording whose tail flush is not known to
 *   have run (legacy rows, and fail-open skips) — unless the connected span
 *   and the recorded length already agree within a few seconds.
 *
 * RELATION TO `duration_sec` (0125 §3a `phone_session_leg_duration`). For a
 * leg of a COMPLETED session the per-leg rule follows the SQL one:
 * - every leg end is capped at the session end (`least(observed, ended,
 *   session_end)`); a capped end is reported as `ledger` at the session end;
 * - a leg answered AFTER the session end is not part of the session's
 *   connected time (SQL excludes it): its own window is still reported, but
 *   the roll-up leaves it out (`answered_after_session_end`);
 * - the unobserved rule: state `abandoned`, `outcome_class` NULL,
 *   `abandon_reason` NULL, an `ended_at` AT OR BEFORE the session's end, and
 *   no `observed_ended_at`. A leg the reclaim ended only AFTER its session
 *   completed was still live when the session ended, so it counts up to the
 *   session end (`ledger`), as the first-completion trigger and the backfill
 *   count it (review round 2, S02).
 * The API is deliberately STRICTER than `duration_sec` in two cases, both
 * reported as not exact where SQL states a number. Phone pages never show
 * `duration_sec`, so these never surface as two different figures:
 * - `detected`: the SQL duration keeps a reconciler end as a ledger end;
 * - a leg reclaimed after a session that was completed only AFTER the leg's
 *   lease had lapsed (`finalize_phone_partial_sessions`' lapsed-lease arm
 *   runs before the reclaim): that session end is the sweep's time, at least
 *   lease expiry + 180 s, not a bound on the call, so the leg is
 *   `unobserved` here (review round 3, S02). SQL keeps it to the session end.
 * Pure functions: no clock, no I/O. Nothing here returns a storage key, a
 * provider id or a URL.
 */

/**
 * The in-worker recorder's synthetic egress id prefix. Mirrors
 * `WORKER_INBAND_EGRESS_ID_PREFIX` in `lib/recording-egress.ts` (not imported:
 * that module pulls the provider SDK into a read route). `recordings.ts`
 * keys its worker recovery path on the same prefix.
 */
export const WORKER_INBAND_EGRESS_ID_PREFIX = 'EG_worker_';

/** The worker's fixed MP3 bitrate (`recording.py` `_MP3_BITRATE_BPS`). */
export const WORKER_MP3_BITRATE_BPS = 64_000;

/**
 * A connected span and a recorded length that agree within this many seconds
 * show the recording covers the call; no "may end early" note is raised.
 */
export const TAIL_NOTE_TOLERANCE_SEC = 3;

export type ConnectedToSource = 'observed' | 'ledger' | 'detected' | 'unobserved';

/** The attempt columns the timing needs. Extra columns are ignored. */
export interface AttemptLegTimingRow {
  /**
   * Not a column: true when the leg's `ended_at` was written by our
   * reconciler sweep (an applied `sip.participant_left` from `source =
   * 'reconciliation'`), i.e. it is the sweep's DETECTION time. Loaded by
   * `loadSweepDetectedLegEnds`.
   */
  end_detected_by_sweep?: boolean;
  /**
   * Not a column: the `ended_at` of the session this leg belongs to, ONLY
   * when that session is `completed` (the sessions 0125 §3 computes a
   * duration for); null/absent otherwise. Bounds a leg the reclaim ended
   * after the session ended, as §3a does.
   */
  session_ended_at?: string | null;
  /**
   * The leg's concurrency lease expiry (0042; the reclaim keeps it). Read
   * only to tell a session the worker completed while it still held the leg
   * (session end <= lease expiry) from one a sweep completed after the lease
   * had lapsed. Never returned by a route.
   */
  lease_expires_at?: string | null;
  answered_at: string | null;
  ended_at: string | null;
  state: string | null;
  outcome_class: string | null;
  abandon_reason?: string | null;
  observed_ended_at?: string | null;
  recording_started_at_ms?: number | string | null;
  recording_duration_ms?: number | string | null;
  recording_tail_flushed?: boolean | null;
  recording_object_key?: string | null;
  /**
   * The object was uploaded and verified (`/recording/complete`). The key is
   * bound at `/recording/prepare`, BEFORE any byte is uploaded, so a key
   * alone is no evidence of audio.
   */
  recording_ready?: boolean | null;
  recording_size_bytes?: number | string | null;
  recording_content_type?: string | null;
  egress_id?: string | null;
  egress_status?: string | null;
}

export interface AttemptLegTiming {
  /** `answered_at`; null for a leg that was never answered. */
  connected_from: string | null;
  /** The leg end, per `connected_to_source`; null while live or unanswered. */
  connected_to: string | null;
  connected_to_source: ConnectedToSource | null;
  /** Seconds from `connected_from` to `connected_to`; null when `unobserved`. */
  connected_sec: number | null;
  /** Length of the leg's recording in seconds; null when unknown. */
  recorded_sec: number | null;
  /** True when `recorded_sec` is a size-based estimate (legacy MP3). */
  recorded_sec_estimated: boolean;
  /** Epoch ms of t = 0 in the leg's recording file (worker clock). */
  recording_started_at_ms: number | null;
  /** The recording may end a few seconds before the call did. */
  tail_may_be_missing: boolean;
  /**
   * The leg has usable audio (an uploaded, ready object or a length stamped
   * at `/recording/complete`, and no latched failure). Internal: lets the roll-up count legs whose audio
   * exists but whose length is unknown. Never returned by a route.
   */
  has_recording: boolean;
  /**
   * The leg was answered after its completed session ended, so it is not
   * part of that session's connected time (0125 §3a leaves it out). Internal:
   * the roll-up skips it. Never returned by a route.
   */
  answered_after_session_end: boolean;
}

export interface SessionRecordedFacts {
  /** Sum of the legs' known recorded lengths; null when none is known. */
  recorded_total_sec: number | null;
  /** How many legs have a known recorded length; null for a session with no legs. */
  recorded_legs: number | null;
  /**
   * Legs that HAVE audio whose length is unknown (an OGG fallback, a legacy
   * OGG row): `recorded_total_sec` leaves them out, so it is a lower bound
   * whenever this is > 0. null for a session with no legs.
   */
  recorded_unknown_legs: number | null;
  /**
   * Every answered leg has an observed or ledger end. false when any answered
   * leg is `unobserved` or `detected` or has not ended; null when no leg was
   * answered.
   */
  connected_complete: boolean | null;
  /** Sum of the answered legs' `connected_sec`, only when `connected_complete`. */
  connected_total_sec: number | null;
  /**
   * WHY `connected_complete` is false, as counts of the answered legs: ends
   * nobody observed (`unobserved`), ends only our reconciler detected
   * (`detected`, approximate), and legs not ended yet (a call in progress).
   * null for a session with no legs.
   */
  connected_unobserved_legs: number | null;
  connected_detected_legs: number | null;
  connected_open_legs: number | null;
}

function epochMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function positiveNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Millisecond precision; keeps float sums like 53.2 + 17.6 exact-looking. */
function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** The recorded file came from the in-worker recorder (0078 worker_inband). */
export function isWorkerInbandAttempt(row: Pick<AttemptLegTimingRow, 'egress_id'>): boolean {
  return typeof row.egress_id === 'string' && row.egress_id.startsWith(WORKER_INBAND_EGRESS_ID_PREFIX);
}

/** The lease-reclaim signature with no observed end, whatever the session end. */
function isReclaimSignature(
  row: Pick<AttemptLegTimingRow, 'observed_ended_at' | 'state' | 'outcome_class' | 'abandon_reason' | 'ended_at'>,
): boolean {
  return epochMs(row.observed_ended_at) === null
    && row.state === 'abandoned'
    && (row.outcome_class ?? null) === null
    && (row.abandon_reason ?? null) === null
    && epochMs(row.ended_at) !== null;
}

/**
 * A leg the reclaim ended AFTER its completed session ended: it was still
 * live at the session end, so 0125 §3a bounds it by that end instead of
 * excluding it.
 */
function isReclaimedAfterSessionEnd(
  row: Pick<AttemptLegTimingRow, 'observed_ended_at' | 'state' | 'outcome_class' | 'abandon_reason' | 'ended_at' | 'session_ended_at'>,
): boolean {
  const endedMs = epochMs(row.ended_at);
  const sessionEndMs = epochMs(row.session_ended_at);
  return isReclaimSignature(row) && sessionEndMs !== null && endedMs !== null && endedMs > sessionEndMs;
}

/**
 * The lease-reclaim signature with no observed end, at or before the
 * completed session's end (0125 §3a): the leg's `ended_at` is the sweep's
 * time, not the call's end. The SAME predicate as the SQL rule, session-end
 * clause included (see the header for the cases where the per-leg read is
 * stricter than `duration_sec`). With no
 * completed session end (a live or non-completed session) every reclaim is
 * unobserved: the session will end after it.
 */
export function isUnobservedReclaim(
  row: Pick<AttemptLegTimingRow, 'observed_ended_at' | 'state' | 'outcome_class' | 'abandon_reason' | 'ended_at' | 'session_ended_at'>,
): boolean {
  return isReclaimSignature(row) && !isReclaimedAfterSessionEnd(row);
}

/**
 * The session was completed while the leg's lease was still held (session
 * end at or before the lease expiry), i.e. by a worker that was alive, so
 * its end is a real bound on the leg. false when the lease had already
 * lapsed: `finalize_phone_partial_sessions`' lapsed-lease arm completes such
 * a session at its own clock (lease expiry + at least the 180 s grace), and
 * that time says nothing about when the call ended. false when the expiry is
 * unknown.
 */
function sessionEndedWhileLeaseHeld(
  row: Pick<AttemptLegTimingRow, 'session_ended_at' | 'lease_expires_at'>,
): boolean {
  const sessionEndMs = epochMs(row.session_ended_at);
  const leaseMs = epochMs(row.lease_expires_at);
  return sessionEndMs !== null && leaseMs !== null && sessionEndMs <= leaseMs;
}

/** One leg's connected window and recording facts. */
export function attemptLegTiming(input: AttemptLegTimingRow): AttemptLegTiming {
  const answeredMs = epochMs(input.answered_at);
  const observedMs = epochMs(input.observed_ended_at);
  const endedMs = epochMs(input.ended_at);
  // A leg answered after its completed session ended is not part of that
  // session's connected time (0125 §3a `answered_at <= p_session_ended_at`).
  // Its own window is still stated, unbounded by a session it is not in.
  const inputSessionEndMs = epochMs(input.session_ended_at);
  const answeredAfterSessionEnd = answeredMs !== null && inputSessionEndMs !== null
    && answeredMs > inputSessionEndMs;
  const row: AttemptLegTimingRow = answeredAfterSessionEnd ? { ...input, session_ended_at: null } : input;
  const sessionEndMs = answeredAfterSessionEnd ? null : inputSessionEndMs;

  let connectedTo: string | null = null;
  let source: ConnectedToSource | null = null;
  let connectedSec: number | null = null;
  const sweptEnd = row.end_detected_by_sweep === true;
  if (answeredMs !== null) {
    let toMs: number | null = null;
    if (observedMs !== null && !(endedMs !== null && !sweptEnd && endedMs < observedMs)) {
      // The observed SIP leave, unless a non-sweep ledger end is EARLIER
      // (the 0125 §3a `least(observed, ended)`): a skewed worker clock never
      // stretches a leg past the ledger.
      connectedTo = row.observed_ended_at as string;
      source = 'observed';
      toMs = observedMs;
    } else if (endedMs !== null && isReclaimedAfterSessionEnd(row)) {
      if (sessionEndedWhileLeaseHeld(row)) {
        // Still live when the worker completed the session; the reclaim came
        // later. The session end bounds it (0125 §3a, the 0076 bound): a
        // ledger end, the figure `duration_sec` counts, never the span up to
        // the reclaim.
        connectedTo = row.session_ended_at as string;
        source = 'ledger';
        toMs = sessionEndMs;
      } else {
        // The session was completed by a sweep after the lease lapsed
        // (finalize's lapsed-lease arm before the reclaim): its end is lease
        // expiry + the grace, minutes of possible dead air, not a bound.
        // Nobody saw this leg end. Stricter than duration_sec (review
        // round 3, S02).
        connectedTo = row.ended_at as string;
        source = 'unobserved';
      }
    } else if (endedMs !== null) {
      connectedTo = row.ended_at as string;
      if (isUnobservedReclaim(row)) {
        // The detection time, kept so the UI can say when the timeout saw it;
        // the span up to it is NOT call time.
        source = 'unobserved';
      } else if (sweptEnd && observedMs === null) {
        // Our reconciler's detection time: an upper bound, up to a reconcile
        // interval after the hang-up. Kept for the UI to name; not call time.
        source = 'detected';
      } else {
        source = 'ledger';
        toMs = endedMs;
      }
    }
    if (toMs !== null && sessionEndMs !== null && toMs > sessionEndMs) {
      // Never past the completed session's end (0125 §3a `least(..., session
      // end)`): e.g. the agent completed the session at T and the SIP leave
      // arrived at T + 3 s. The session end is a ledger time.
      connectedTo = row.session_ended_at as string;
      source = 'ledger';
      toMs = sessionEndMs;
    }
    if (toMs !== null) {
      const span = (toMs - answeredMs) / 1000;
      connectedSec = Number.isFinite(span) && span >= 0 ? roundMs(span) : null;
    }
  }

  // A latched failed capture has no usable audio, whatever was stamped.
  const failed = row.egress_status === 'failed';
  const worker = isWorkerInbandAttempt(row);
  const durationMs = positiveNumber(row.recording_duration_ms);
  const sizeBytes = positiveNumber(row.recording_size_bytes);
  let recordedSec: number | null = null;
  let estimated = false;
  if (!failed && durationMs !== null) {
    recordedSec = roundMs(durationMs / 1000);
  } else if (!failed && worker && row.recording_content_type === 'audio/mpeg'
    && row.recording_object_key && sizeBytes !== null) {
    // CBR: bytes x 8 / bitrate. Rounded to 0.1 s: it is an estimate (the
    // container header is counted as audio), never presented as exact.
    recordedSec = Math.round(((sizeBytes * 8) / WORKER_MP3_BITRATE_BPS) * 10) / 10;
    estimated = true;
  }

  const startedAt = positiveNumber(row.recording_started_at_ms);
  // Uploaded audio only: a key bound at prepare whose upload never happened
  // (a crashed worker that never latched `failed`) is not audio. A stamped
  // length comes only from `/recording/complete`, i.e. after the upload.
  const hasRecording = !failed
    && ((row.recording_ready === true && Boolean(row.recording_object_key)) || durationMs !== null);
  const coversCall = connectedSec !== null && recordedSec !== null
    && connectedSec - recordedSec <= TAIL_NOTE_TOLERANCE_SEC;
  const tailMayBeMissing = worker && hasRecording && row.recording_tail_flushed !== true && !coversCall;

  return {
    connected_from: answeredMs !== null ? (row.answered_at as string) : null,
    connected_to: connectedTo,
    connected_to_source: source,
    connected_sec: connectedSec,
    recorded_sec: recordedSec,
    recorded_sec_estimated: recordedSec !== null && estimated,
    recording_started_at_ms: startedAt !== null ? Math.trunc(startedAt) : null,
    tail_may_be_missing: tailMayBeMissing,
    has_recording: hasRecording,
    answered_after_session_end: answeredAfterSessionEnd,
  };
}

/**
 * The same leg with its RECORDING facts withheld: the audio was erased,
 * revoked, quarantined or latched failed, or the caller may not read it. A
 * withheld leg contributes nothing to a recorded total and raises no tail
 * note; its connected window (a call fact) is unchanged.
 */
export function withoutRecordingFacts(leg: AttemptLegTiming): AttemptLegTiming {
  return {
    ...leg,
    recorded_sec: null,
    recorded_sec_estimated: false,
    recording_started_at_ms: null,
    tail_may_be_missing: false,
    has_recording: false,
  };
}

/**
 * The session header's facts, from that session's legs (`session_id` or
 * `recording_session_id` = the session). Replaces "on the call" built from
 * `duration_sec`: the recorded total is always shown, the connected total only
 * when every answered leg's end is known.
 */
export function sessionRecordedFacts(legs: readonly AttemptLegTiming[]): SessionRecordedFacts {
  if (legs.length === 0) {
    return {
      recorded_total_sec: null,
      recorded_legs: null,
      recorded_unknown_legs: null,
      connected_complete: null,
      connected_total_sec: null,
      connected_unobserved_legs: null,
      connected_detected_legs: null,
      connected_open_legs: null,
    };
  }
  const recorded = legs.filter((leg) => leg.recorded_sec !== null);
  const unknownLength = legs.filter((leg) => leg.has_recording && leg.recorded_sec === null);
  // A leg answered after the completed session ended is not part of its
  // connected time (0125 §3a); its recording, if any, still counts above.
  const answered = legs.filter((leg) => leg.connected_from !== null && !leg.answered_after_session_end);
  const complete = answered.length === 0
    ? null
    : answered.every((leg) => (leg.connected_to_source === 'observed' || leg.connected_to_source === 'ledger')
      && leg.connected_sec !== null);
  return {
    recorded_total_sec: recorded.length > 0
      ? roundMs(recorded.reduce((sum, leg) => sum + (leg.recorded_sec as number), 0))
      : null,
    recorded_legs: recorded.length,
    recorded_unknown_legs: unknownLength.length,
    connected_complete: complete,
    connected_total_sec: complete
      ? roundMs(answered.reduce((sum, leg) => sum + (leg.connected_sec as number), 0))
      : null,
    connected_unobserved_legs: answered.filter((leg) => leg.connected_to_source === 'unobserved').length,
    connected_detected_legs: answered.filter((leg) => leg.connected_to_source === 'detected').length,
    connected_open_legs: answered.filter((leg) => leg.connected_to_source === null).length,
  };
}
