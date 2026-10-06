/**
 * sessionLegs — pure helpers for the Review tab's per-leg view (M013 S02).
 *
 * A phone session can span several legs: the first call, then reconnects
 * after a drop. Each leg has its OWN recording file. The transcript is one
 * list for the whole session, so to seek within a leg's file a turn has to be
 * placed on the right leg and turned into an offset from THAT file's t = 0:
 *
 *   offset = (turn start − leg recording start) / 1000
 *
 * - The turn start is the turn's own epoch ms (`started_at_ms`), else the
 *   session anchor + `start_offset_sec` (LiveKit egress sessions).
 * - The leg recording start is the worker's `recording_started_at_ms` (or,
 *   for a LiveKit-egress leg, the session's egress anchor). A legacy worker
 *   leg has neither; it falls back to `answered_at + 1 s` (the worker
 *   starts recording about a second after the answer) and is marked
 *   approximate ("≈").
 *
 * No clock, no I/O: everything here is a function of its arguments.
 */

import type { CandidatePhoneAttempt, Session, TranscriptLine } from '../../types';
import { formatIstTime, formatIstTimeRange } from '../../lib/ist-datetime';
import { formatDurationSec } from './status';

/** Legacy legs: the worker began recording about this long after the answer. */
export const LEGACY_RECORDING_LAG_MS = 1000;
/**
 * A turn stamped a little before its leg was admitted (worker/API clock skew)
 * still belongs to that leg rather than the previous one.
 */
const LEG_BOUNDARY_SLACK_MS = 2000;

function instantMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Legs in the order they happened: admitted, then attempt number. */
export function sortLegs(attempts: readonly CandidatePhoneAttempt[]): CandidatePhoneAttempt[] {
  return attempts.slice().sort((a, b) => {
    const at = instantMs(a.admitted_at) ?? 0;
    const bt = instantMs(b.admitted_at) ?? 0;
    return at !== bt ? at - bt : a.attempt_seq - b.attempt_seq;
  });
}

/** "Call 1 of 2 · first call" / "Call 2 of 2 · reconnect". */
export function legTitle(index: number, total: number): string {
  return `Call ${index + 1} of ${total} · ${index === 0 ? 'first call' : 'reconnect'}`;
}

/** Short name for the leg's player and its group heading. */
export function legName(index: number, total: number): string {
  return `Call ${index + 1} of ${total}`;
}

/** A leg's recording can be asked for (the mint route decides the rest). */
export function legPlayable(leg: CandidatePhoneAttempt): boolean {
  return leg.recording.state === 'ready' || leg.recording.state === 'processing';
}

/**
 * t = 0 of the leg's file, and whether it is the legacy estimate.
 *
 * In order: the worker's own `recording_started_at_ms`; else the session's
 * egress anchor when it falls inside this leg (a LiveKit-egress leg's file IS
 * the session recording, whose t = 0 that anchor is); else the legacy
 * `answered_at + 1 s` estimate.
 */
export function legRecordingAnchor(
  leg: CandidatePhoneAttempt,
  sessionAnchorMs?: number | null,
): { ms: number; approximate: boolean } | null {
  const exact = finiteOrNull(leg.recording_started_at_ms);
  if (exact !== null && exact > 0) return { ms: exact, approximate: false };
  const egress = finiteOrNull(sessionAnchorMs);
  if (egress !== null && egress > 0) {
    const admitted = instantMs(leg.admitted_at);
    const ended = instantMs(leg.connected_to ?? leg.ended_at);
    if (
      admitted !== null &&
      egress >= admitted - LEG_BOUNDARY_SLACK_MS &&
      (ended === null || egress <= ended)
    ) {
      return { ms: egress, approximate: false };
    }
  }
  const answered = instantMs(leg.connected_from ?? leg.answered_at);
  if (answered !== null) return { ms: answered + LEGACY_RECORDING_LAG_MS, approximate: true };
  return null;
}

/** A turn's absolute start: its own stamp, else the session anchor + offset. */
export function turnStartMs(turn: TranscriptLine, sessionAnchorMs: number | null | undefined): number | null {
  const own = finiteOrNull(turn.started_at_ms);
  if (own !== null && own > 0) return own;
  const anchor = finiteOrNull(sessionAnchorMs);
  const offset = finiteOrNull(turn.start_offset_sec);
  if (anchor !== null && anchor > 0 && offset !== null) return anchor + offset * 1000;
  return null;
}

/** A transcript turn as one leg's group shows it. */
export interface LegTurn {
  /** Index in the session transcript (stable React key). */
  index: number;
  /** `start_offset_sec` re-based on the seek target's file; null = cannot seek. */
  turn: TranscriptLine;
}

export interface LegGroup {
  /** null = the "no timing" bucket. */
  legIndex: number | null;
  turns: LegTurn[];
  /** Offsets are the legacy `answered_at + 1 s` estimate. */
  approximate: boolean;
}

/**
 * How the transcript seeks:
 * - `leg`: each turn seeks within its own leg's file;
 * - `session`: no leg can be played, so turns keep the session offsets and
 *   seek the session recording (the pre-S02 behaviour).
 */
export type LegSeekMode = 'leg' | 'session';

/**
 * Place every turn on a leg. A turn belongs to the latest leg admitted at or
 * before it (with a small slack for clock skew); one before the first leg
 * goes to the first. A turn with no start at all goes to the trailing
 * "no timing" group. Empty groups are dropped, so a leg with no turns (a
 * silent reconnect) still shows in the call list but adds no heading here.
 */
export function groupTurnsByLeg(
  transcript: readonly TranscriptLine[],
  legs: readonly CandidatePhoneAttempt[],
  sessionAnchorMs: number | null | undefined,
  seekMode: LegSeekMode,
): LegGroup[] {
  const starts = legs.map((leg) => instantMs(leg.admitted_at) ?? instantMs(leg.connected_from) ?? null);
  const anchors = legs.map((leg) => legRecordingAnchor(leg, sessionAnchorMs));
  const byLeg: LegTurn[][] = legs.map(() => []);
  const untimed: LegTurn[] = [];

  transcript.forEach((turn, index) => {
    const at = turnStartMs(turn, sessionAnchorMs);
    if (at === null || legs.length === 0) {
      untimed.push({ index, turn: seekMode === 'session' ? turn : { ...turn, start_offset_sec: null } });
      return;
    }
    let legIndex = 0;
    for (let i = 0; i < legs.length; i++) {
      const start = starts[i];
      if (start !== null && start - LEG_BOUNDARY_SLACK_MS <= at) legIndex = i;
    }
    let offset: number | null;
    if (seekMode === 'session') {
      offset = finiteOrNull(turn.start_offset_sec);
    } else {
      const anchor = anchors[legIndex];
      offset = anchor && legPlayable(legs[legIndex])
        ? Math.round(Math.max(0, at - anchor.ms)) / 1000
        : null;
    }
    byLeg[legIndex].push({ index, turn: { ...turn, start_offset_sec: offset } });
  });

  const groups: LegGroup[] = byLeg
    .map((turns, legIndex) => ({
      legIndex,
      turns,
      approximate:
        seekMode === 'leg' &&
        anchors[legIndex]?.approximate === true &&
        turns.some((t) => t.turn.start_offset_sec != null),
    }))
    .filter((g) => g.turns.length > 0);
  if (untimed.length > 0) groups.push({ legIndex: null, turns: untimed, approximate: false });
  return groups;
}

/**
 * Why a listed leg cannot be played, in a recruiter's words. The same
 * wording as the call-attempt list, so one leg reads the same everywhere.
 */
export function legNoAudioLabel(reason: CandidatePhoneAttempt['recording']['reason']): string {
  switch (reason) {
    case 'access_unavailable':
      return 'Recording access unavailable';
    case 'recording_failed':
      return 'Recording unavailable (capture failed)';
    case 'quarantined':
      return 'Recording withheld (failed integrity check)';
    case 'deleted':
      return 'Recording deleted';
    case 'revoked':
      return 'Recording withdrawn';
    default:
      return 'No recording available';
  }
}

/*
 * One leg's figures and notes, in the words every surface uses (the Review
 * tab's leg rows and the Overview's call-attempt list), so the same leg never
 * reads two ways on one page.
 */

/** "Connected 09:00–09:02 IST (1m 15s)", "Connected from 09:04 IST", or "Not answered". */
export function legConnectedWords(leg: CandidatePhoneAttempt): string {
  const from = leg.connected_from ?? leg.answered_at;
  if (!from) return 'Not answered';
  const to = leg.connected_to;
  if (!to || leg.connected_to_source === 'unobserved') return `Connected from ${formatIstTime(from)}`;
  const length = leg.connected_sec != null ? ` (${formatDurationSec(leg.connected_sec)})` : '';
  return `Connected ${formatIstTimeRange(from, to)}${length}`;
}

/** "Recorded 53s", "Recorded ≈53s (estimated)", or null when unknown. */
export function legRecordedWords(leg: CandidatePhoneAttempt): string | null {
  if (leg.recorded_sec == null || !Number.isFinite(leg.recorded_sec)) return null;
  return leg.recorded_sec_estimated
    ? `Recorded ≈${formatDurationSec(leg.recorded_sec)} (estimated)`
    : `Recorded ${formatDurationSec(leg.recorded_sec)}`;
}

/**
 * The note for a leg only the lease reclaim ended (`unobserved`), or null.
 * Its `connected_to` is when the timeout DETECTED the drop, never the real
 * end, so it is named as such rather than shown as a call length.
 */
export function legUnobservedNote(leg: CandidatePhoneAttempt): string | null {
  if (leg.connected_to_source !== 'unobserved') return null;
  return leg.connected_to
    ? `Line dropped; end not observed (detected ${formatIstTime(leg.connected_to)} by timeout).`
    : 'Line dropped; end not observed.';
}

/** The note for a leg whose recording may stop before the call did. */
export const LEG_TAIL_NOTE = 'This recording may end a few seconds before the call did.';

/**
 * The consent tag for a leg's recording (0105 retention, M013 D8), or null
 * for an ordinary consented leg. Every recording is kept; the tag says under
 * what consent it was captured or what the candidate did about it on THIS
 * leg. `note` is the line shown with the open player.
 */
export function legConsentTag(
  stage: CandidatePhoneAttempt['consent_stage'],
): { label: string; note: string } | null {
  const kept = 'kept under the 2026-09-26 retention decision. Every playback is logged.';
  switch (stage) {
    case 'before_consent':
      return {
        label: 'Recorded before consent',
        note: `Recorded before the candidate consented and ${kept}`,
      };
    case 'consent_withdrawn':
      return {
        label: 'Consent withdrawn – recording kept',
        note: `The candidate withdrew consent on this call. The recording up to that point is ${kept}`,
      };
    case 'deferred_after_consent':
      return {
        label: 'Callback requested after consent – recording kept',
        note: `The candidate consented, then asked to be called back later. The recording is ${kept}`,
      };
    default:
      return null;
  }
}

/**
 * The session picker's length words. A phone session shows what was
 * RECORDED across its legs, never `duration_sec`: that figure excludes a
 * dropped leg whose end was never observed, so it can contradict the files.
 * Other modes keep their own length.
 */
export function sessionLengthLabel(session: Session): string | null {
  if (session.mode === 'live') {
    const total = session.recorded_total_sec;
    if (total == null || !Number.isFinite(total) || total <= 0) return null;
    const calls = session.recorded_legs ?? 0;
    return `Recorded ${formatDurationSec(total)}${calls > 1 ? ` across ${calls} calls` : ''}`;
  }
  return session.duration_sec ? formatDurationSec(session.duration_sec) : null;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The call figures the candidate header shows, all from ONE session. */
export interface HeadlineCallFacts {
  sessionId: string;
  /**
   * Time on the call. For a phone session only when every leg's end is known
   * (`connected_complete`), never `duration_sec`; null otherwise.
   */
  callSeconds: number | null;
  /** Phone sessions: audio recorded across the session's legs; else null. */
  recordedSeconds: number | null;
  /** How many legs that recorded total spans. */
  recordedCalls: number | null;
  candidateWords: number | null;
}

/**
 * The session the header describes, and its figures: the LONGEST one by what
 * is actually known about it, not the latest (a nine-second consent-gate
 * drop must not stand for a seven-minute screen). A phone session's length
 * is its connected total when complete, else what was recorded across its
 * legs; `duration_sec` is never used for it, because it leaves out a dropped
 * leg whose end was never observed and so contradicts the recordings. Other
 * modes keep `duration_sec`. null when no session has a known positive
 * length, so the header shows no figure rather than a zero.
 */
export function headlineCallFacts(sessions: readonly Session[]): HeadlineCallFacts | null {
  let best: HeadlineCallFacts | null = null;
  let bestLength = 0;
  for (const session of sessions) {
    let facts: HeadlineCallFacts;
    if (session.mode === 'live') {
      const recorded = positiveOrNull(session.recorded_total_sec);
      facts = {
        sessionId: session.id,
        callSeconds: session.connected_complete === true ? positiveOrNull(session.connected_total_sec) : null,
        recordedSeconds: recorded,
        recordedCalls: recorded !== null ? positiveOrNull(session.recorded_legs) : null,
        candidateWords: session.candidate_words ?? null,
      };
    } else {
      facts = {
        sessionId: session.id,
        callSeconds: positiveOrNull(session.duration_sec),
        recordedSeconds: null,
        recordedCalls: null,
        candidateWords: session.candidate_words ?? null,
      };
    }
    const length = Math.max(facts.callSeconds ?? 0, facts.recordedSeconds ?? 0);
    if (length > bestLength) {
      best = facts;
      bestLength = length;
    }
  }
  return best;
}

/** The latest turn at or before the playhead, within one group. */
export function activeTurnIn(turns: readonly LegTurn[], currentTime: number, toleranceSec = 0.25): number | null {
  let active: number | null = null;
  for (let i = 0; i < turns.length; i++) {
    const offset = turns[i].turn.start_offset_sec;
    if (offset != null && offset <= currentTime + toleranceSec) active = i;
  }
  return active;
}
