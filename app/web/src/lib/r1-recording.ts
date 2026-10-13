/**
 * R1 recording, the pure half: how a recording is described to staff and how a transcript turn
 * becomes a position in the media. No React, no network, no clock of its own (every time is passed
 * in), so each rule here is pinned by a plain unit test.
 *
 * Staff-only. This file sits beside `lib/r1.ts` on purpose, NOT in `lib/r1/` (the candidate side,
 * scanned by `pages/r1-structure.test.ts`).
 *
 * Contract: IMPLEMENTER-RULES C6 (summaries and the mint), C7 (player), C8 (timing), C11 (reasons).
 *
 *  - A summary arrives with the rounds list and carries no URL. A URL is minted by an explicit,
 *    audited click and is never rendered, logged or put in an attribute other than the media `src`.
 *  - An unknown state fails closed: it can never build a player.
 *  - Copy is sentence case and never raw API text: a code is mapped to words, an unknown code to a
 *    neutral sentence.
 */
import { formatDate } from './datetime';
import type {
  R1AttemptSummary,
  R1RecordingPlayback,
  R1RecordingState,
  R1RecordingSummary,
} from './r1-types';

/* ── Constants ────────────────────────────────────────────────────── */

/** A seek lands this far BEFORE the turn, so the first word is not clipped (VAD starts late). */
export const R1_SEEK_LEAD_SEC = 1.0;

/** A link is replaced this many seconds before it expires, when the person next plays or seeks. */
export const R1_REMINT_GUARD_SEC = 15;

/** After one automatic re-mint on a media error, another waits this long (then the error is shown). */
export const R1_AUTO_REMINT_WINDOW_MS = 30_000;

/** A split recording's follower is pulled back to the master when they differ by more than this. */
export const R1_SPLIT_DRIFT_SEC = 0.3;

/** `transcript_turns.turn_started_at_ms` is valid strictly inside (0, this) (migration 0026). */
const EPOCH_MS_LIMIT = 4_102_444_800_000;

/* ── State ────────────────────────────────────────────────────────── */

/** `unknown` = a state this build does not recognise. It is shown as such and never played. */
export type R1ViewState = R1RecordingState | 'unknown';

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'none',
  'recording',
  'processing',
  'ready',
  'partial',
  'failed',
  'deleted',
]);

export function viewState(summary: R1RecordingSummary | null | undefined): R1ViewState {
  const state = summary?.state;
  return typeof state === 'string' && KNOWN_STATES.has(state) ? (state as R1RecordingState) : 'unknown';
}

/** Only these two can have a file to play. */
export function isPlayableState(state: R1ViewState): boolean {
  return state === 'ready' || state === 'partial';
}

/* ── Numbers ──────────────────────────────────────────────────────── */

/** A finite number, or a string that is one (a bigint column can arrive as a string); else null. */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** An epoch-ms anchor in the range the database accepts, or null. */
function epochMs(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 0 && n < EPOCH_MS_LIMIT ? n : null;
}

/* ── Turn -> position in the media (C7, C8) ───────────────────────── */

/**
 * Seconds into the media at which a transcript turn starts, or null when either anchor is missing or
 * invalid (a NULL turn is honestly "untimed"; a wrong one would be misleading). A turn before the
 * recording began clamps to 0. This is the number to SHOW; `turnOffsetSec` is where to SEEK.
 *
 * The turn anchor and `started_at_ms` come from the same worker clock, so no skew correction is made.
 * `timeline_offset_ms` is a measured correction the API may publish later (default 0).
 */
export function turnMediaSec(
  turnStartedAtMs: unknown,
  summary: R1RecordingSummary | null | undefined,
): number | null {
  const turn = epochMs(turnStartedAtMs);
  const start = epochMs(summary?.started_at_ms);
  if (turn === null || start === null) return null;
  const correction = finiteNumber(summary?.timeline_offset_ms) ?? 0;
  return Math.max(0, (turn - start + correction) / 1000);
}

/**
 * Where to seek for a transcript turn: its media position less `R1_SEEK_LEAD_SEC`, never below 0.
 * Null when the turn cannot be placed.
 *
 *   max(0, (turn - started_at_ms + (timeline_offset_ms ?? 0)) / 1000 - R1_SEEK_LEAD_SEC)
 */
export function turnOffsetSec(
  turnStartedAtMs: unknown,
  summary: R1RecordingSummary | null | undefined,
): number | null {
  const media = turnMediaSec(turnStartedAtMs, summary);
  return media === null ? null : Math.max(0, media - R1_SEEK_LEAD_SEC);
}

/* ── Link expiry ──────────────────────────────────────────────────── */

/**
 * Seconds after a mint at which the link is replaced rather than risked. Normally `expires - 15`.
 * For a very short link (under 30 s) that would be at or before the mint, which would re-mint on every
 * play, so the threshold is never below half the lifetime.
 */
export function remintThresholdSec(expiresInSec: number): number {
  return Math.max(expiresInSec / 2, expiresInSec - R1_REMINT_GUARD_SEC);
}

/**
 * Whether a link minted at `mintedAtMs` is due for replacement at `nowMs` (both from one monotonic
 * clock, `performance.now()`: the staff laptop's wall clock plays no part). A response without a usable
 * lifetime is never "stale" by the clock; it is replaced only after a media error.
 */
export function isMintStale(
  mintedAtMs: number,
  nowMs: number,
  expiresInSec: number | null | undefined,
): boolean {
  if (typeof expiresInSec !== 'number' || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    return false;
  }
  return nowMs - mintedAtMs >= remintThresholdSec(expiresInSec) * 1000;
}

/** One automatic re-mint on a media error, then not again for `R1_AUTO_REMINT_WINDOW_MS`. */
export function shouldAutoRemint(lastAutoRemintAtMs: number | null, nowMs: number): boolean {
  return lastAutoRemintAtMs === null || nowMs - lastAutoRemintAtMs >= R1_AUTO_REMINT_WINDOW_MS;
}

/** Whether a follower that is `|a - b|` seconds from its master needs to be pulled back. */
export function driftExceeds(masterSec: number, followerSec: number): boolean {
  // Whole milliseconds, so 10.3 - 10 (0.30000000000000071 in floating point) is not "more than 0.3".
  return Math.round(Math.abs(masterSec - followerSec) * 1000) > R1_SPLIT_DRIFT_SEC * 1000;
}

/* ── What the mint says to play ───────────────────────────────────── */

export type R1PlaybackSources =
  | { kind: 'single'; url: string; contentType: string | null; video: boolean }
  | { kind: 'split'; videoUrl: string; audioUrl: string };

/** A media `src` this player will accept. Anything else is a fault, never a source. */
export function isSafeMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(?:https?:|data:)/i.test(value);
}

/**
 * The media to play from a mint response, or null when there is none to play: the state is not
 * ready/partial, or the response is inconsistent (a split recording missing one half).
 */
export function playbackSources(
  playback: R1RecordingPlayback | null | undefined,
): R1PlaybackSources | null {
  if (!playback || !isPlayableState(viewState(playback))) return null;
  if (playback.mode === 'split') {
    return isSafeMediaUrl(playback.video_url) && isSafeMediaUrl(playback.audio_url)
      ? { kind: 'split', videoUrl: playback.video_url, audioUrl: playback.audio_url }
      : null;
  }
  if (!isSafeMediaUrl(playback.url)) return null;
  const contentType = typeof playback.content_type === 'string' ? playback.content_type : null;
  // `has_video === false` is audio; so is an audio content type (a <video> would be a black box).
  const video = playback.has_video !== false && !(contentType ?? '').toLowerCase().startsWith('audio/');
  return { kind: 'single', url: playback.url, contentType, video };
}

/* ── Words ────────────────────────────────────────────────────────── */

/** "m:ss" into the recording. */
export function clockText(totalSec: number): string {
  const total = Math.max(0, Math.round(totalSec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "7m 3s", "45s". */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export type R1CopyTone = 'neutral' | 'accent' | 'positive' | 'caution' | 'negative';

/** What to say about a recording before (or instead of) playing it. */
export interface R1StateCopy {
  /** The chip. */
  tag: string;
  tone: R1CopyTone;
  /** The sentence under it. Null when the facts line says it all. */
  detail: string | null;
  /** A second sentence for a recording that plays but is not the full one. */
  notice: string | null;
  /** Facts about a playable recording: length, retention, camera. Empty otherwise. */
  facts: string[];
  /** `load` = the Load button; `refresh` = "Check again" re-reads the rounds; `none` = nothing to press. */
  action: 'load' | 'refresh' | 'none';
}

const FAILED_WORDS: Readonly<Record<string, string>> = {
  integrity: 'It failed an integrity check and is withheld.',
  oversize: 'The recording was too large to keep.',
  object_missing: 'The recording file is missing, so it is withheld.',
  crash_recovered: 'The recording was interrupted and nothing could be recovered.',
  capture_failed: 'Recording failed during the interview.',
};

const DELETED_WORDS: Readonly<Record<string, string>> = {
  retention: ' after the retention period',
  consent_withdrawn: ' because consent was withdrawn',
  erasure: ' on request',
};

function noticeFor(summary: R1RecordingSummary): string | null {
  const reason = typeof summary.reason === 'string' ? summary.reason : null;
  if (reason === 'audio_only_degraded') {
    const at = finiteNumber(summary.degraded_at_ms);
    return at === null
      ? 'Video stopped to protect the interview; the rest is audio only.'
      : `Video stopped at ${clockText(at / 1000)} to protect the interview; the rest is audio only.`;
  }
  if (reason === 'video_unavailable') {
    return 'The camera was not available, so this is an audio-only recording.';
  }
  if (reason === 'crash_recovered') return 'Recovered after an interruption; it may end early.';
  // A reason this build does not know still tells the reader the file is not the full recording.
  if (reason !== null) return 'Part of this recording is missing.';
  return null;
}

function factsFor(summary: R1RecordingSummary): string[] {
  const facts: string[] = [];
  const duration = finiteNumber(summary.duration_ms);
  if (duration !== null && duration > 0) facts.push(`Length ${durationWords(duration)}`);
  if (typeof summary.retention_until === 'string' && summary.retention_until) {
    facts.push(`Kept until ${formatDate(summary.retention_until)}`);
  }
  const off = finiteNumber(summary.camera_off_ms);
  if (off !== null && off >= 1000) facts.push(`Camera was off for ${durationWords(off)}`);
  return facts;
}

/**
 * The words for a summary, for every state and reason. An unknown state fails closed ("status
 * unknown", no Load), an unknown reason falls back to a neutral sentence.
 */
export function r1RecordingStateCopy(summary: R1RecordingSummary | null | undefined): R1StateCopy {
  const state = viewState(summary);
  const s = summary ?? { state: 'none' as const };
  switch (state) {
    case 'none':
      return {
        tag: 'No recording',
        tone: 'neutral',
        detail: 'No recording was made for this attempt.',
        notice: null,
        facts: [],
        action: 'none',
      };
    case 'recording':
      return {
        tag: 'Recording',
        tone: 'accent',
        detail: 'In progress. It can be played a few minutes after the interview ends.',
        notice: null,
        facts: [],
        action: 'none',
      };
    case 'processing':
      return {
        tag: 'Processing',
        tone: 'caution',
        detail: 'The recording is being prepared. This usually takes a few minutes.',
        notice: null,
        facts: [],
        action: 'refresh',
      };
    case 'ready':
    case 'partial':
      return {
        tag: state === 'ready' ? 'Ready' : 'Partial',
        tone: state === 'ready' ? 'positive' : 'caution',
        detail: null,
        notice: noticeFor(s) ?? (state === 'partial' ? 'Part of this recording is missing.' : null),
        facts: factsFor(s),
        action: 'load',
      };
    case 'failed': {
      const reason = typeof s.reason === 'string' ? s.reason : '';
      return {
        tag: 'Unavailable',
        tone: 'negative',
        detail: FAILED_WORDS[reason] ?? 'The recording is unavailable.',
        notice: null,
        facts: [],
        action: 'none',
      };
    }
    case 'deleted': {
      const reason = typeof s.reason === 'string' ? s.reason : '';
      const when = typeof s.deleted_at === 'string' && s.deleted_at ? ` on ${formatDate(s.deleted_at)}` : '';
      return {
        tag: 'Deleted',
        tone: 'neutral',
        detail: `This recording was deleted${when}${DELETED_WORDS[reason] ?? ''}.`,
        notice: null,
        facts: [],
        action: 'none',
      };
    }
    default:
      return {
        tag: 'Status unknown',
        tone: 'neutral',
        detail: 'Recording status unknown.',
        notice: null,
        facts: [],
        action: 'refresh',
      };
  }
}

/* ── Errors ───────────────────────────────────────────────────────── */

const GENERIC_ERROR = 'Could not load the recording. Try again.';

/**
 * Words for a failed mint, by HTTP status (0 = the server could not be reached). The API's code never
 * reaches the screen: a code is for logs and tests, and the raw text of an error could carry anything.
 */
export function r1RecordingErrorMessage(status: number, code?: string): string {
  if (status === 403 || code === 'access_denied' || code === 'Insufficient permissions') {
    return 'You do not have access to this recording.';
  }
  if (status === 404 || code === 'not_found') return 'This recording no longer exists.';
  if (status === 429) return 'Too many requests. Try again in a moment.';
  return GENERIC_ERROR;
}

/** Whether pressing "Try again" can help: not for "no access" and "no longer exists". */
export function r1RecordingErrorRetryable(status: number, code?: string): boolean {
  if (status === 403 || status === 404) return false;
  return code !== 'access_denied' && code !== 'not_found';
}

/** Words for a media element that failed before it ever loaded. `unsupported` = the browser cannot decode it. */
export function r1MediaErrorMessage(unsupported: boolean): string {
  return unsupported
    ? 'This browser cannot play this recording.'
    : 'The recording could not be played. Try again.';
}

/* ── Attempts ─────────────────────────────────────────────────────── */

/**
 * "Attempt 1 (counted)", "Attempt 2 (retake)", "Attempt 3 (not counted)". The attempts arrive ordered
 * by attempt number; the second COUNTED attempt is the retake (a round allows one).
 */
export function attemptLabels(attempts: readonly Pick<R1AttemptSummary, 'attempt_number' | 'counted'>[]): string[] {
  let counted = 0;
  return attempts.map((attempt) => {
    if (!attempt.counted) return `Attempt ${attempt.attempt_number} (not counted)`;
    counted += 1;
    return `Attempt ${attempt.attempt_number} (${counted === 1 ? 'counted' : 'retake'})`;
  });
}

/**
 * Whether an attempt gets a recording row. A row exists once there is anything to say: a recording in
 * any state, or (for a round that has completed) the plain fact that none was made. An attempt of a
 * link that was never used has no row.
 */
export function showsRecordingRow(
  summary: R1RecordingSummary | null | undefined,
  roundCompleted: boolean,
): boolean {
  if (!summary) return false;
  return viewState(summary) !== 'none' || roundCompleted;
}
