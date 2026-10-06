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
 * - connected window: `answered_at` -> the observed SIP leave (0118
 *   `observed_ended_at`, `observed`; the ledger end instead when that is
 *   earlier), else the ledger end (`ledger`). A leg ended only by the lease
 *   reclaim with no observed end is `unobserved`: its `connected_to` is the
 *   time the timeout DETECTED it, and it has no `connected_sec`, because that
 *   span is not call time. A leg whose only end is the one our reconciler
 *   sweep recorded (`sip.participant_left` posted by `source =
 *   'reconciliation'`) is `detected`: that time is when the sweep NOTICED the
 *   empty room, up to a reconcile interval after the hang-up, so it is an
 *   upper bound with no exact `connected_sec` either.
 * - recorded length: the worker's true audio length (0118
 *   `recording_duration_ms`), else, for a legacy worker MP3, an estimate from
 *   the file size at the worker's fixed 64 kbps CBR, flagged as estimated.
 * - `tail_may_be_missing`: a worker recording whose tail flush is not known to
 *   have run (legacy rows, and fail-open skips) — unless the connected span
 *   and the recorded length already agree within a few seconds.
 *
 * The unobserved rule is the SQL one (0118 §3a `phone_session_leg_duration`):
 * state `abandoned`, `outcome_class` NULL, `abandon_reason` NULL, an
 * `ended_at`, and no `observed_ended_at` — whatever the session's end, in
 * both places. (`detected` is API-only: the SQL duration keeps a reconciler
 * end as a ledger end.) Pure functions: no clock, no I/O. Nothing here
 * returns a storage key, a provider id or a URL.
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
   * The leg has usable audio (an uploaded object or a known length, and no
   * latched failure). Internal: lets the roll-up count legs whose audio
   * exists but whose length is unknown. Never returned by a route.
   */
  has_recording: boolean;
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

/**
 * The lease-reclaim signature with no observed end (0118 §3a): the leg's
 * `ended_at` is the sweep's time, not the call's end. The SAME predicate as
 * the SQL rule, with no session-end clause in either (a leg reclaimed after
 * its session ended is unobserved too), so the session header and
 * `duration_sec` agree.
 */
export function isUnobservedReclaim(
  row: Pick<AttemptLegTimingRow, 'observed_ended_at' | 'state' | 'outcome_class' | 'abandon_reason' | 'ended_at'>,
): boolean {
  return epochMs(row.observed_ended_at) === null
    && row.state === 'abandoned'
    && (row.outcome_class ?? null) === null
    && (row.abandon_reason ?? null) === null
    && epochMs(row.ended_at) !== null;
}

/** One leg's connected window and recording facts. */
export function attemptLegTiming(row: AttemptLegTimingRow): AttemptLegTiming {
  const answeredMs = epochMs(row.answered_at);
  const observedMs = epochMs(row.observed_ended_at);
  const endedMs = epochMs(row.ended_at);

  let connectedTo: string | null = null;
  let source: ConnectedToSource | null = null;
  let connectedSec: number | null = null;
  const sweptEnd = row.end_detected_by_sweep === true;
  if (answeredMs !== null) {
    let toMs: number | null = null;
    if (observedMs !== null && !(endedMs !== null && !sweptEnd && endedMs < observedMs)) {
      // The observed SIP leave, unless a non-sweep ledger end is EARLIER
      // (the 0118 §3a `least(observed, ended)`): a skewed worker clock never
      // stretches a leg past the ledger.
      connectedTo = row.observed_ended_at as string;
      source = 'observed';
      toMs = observedMs;
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
  const hasRecording = !failed && (Boolean(row.recording_object_key) || durationMs !== null);
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
    };
  }
  const recorded = legs.filter((leg) => leg.recorded_sec !== null);
  const unknownLength = legs.filter((leg) => leg.has_recording && leg.recorded_sec === null);
  const answered = legs.filter((leg) => leg.connected_from !== null);
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
  };
}
