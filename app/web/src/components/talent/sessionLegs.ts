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

/** The latest turn at or before the playhead, within one group. */
export function activeTurnIn(turns: readonly LegTurn[], currentTime: number, toleranceSec = 0.25): number | null {
  let active: number | null = null;
  for (let i = 0; i < turns.length; i++) {
    const offset = turns[i].turn.start_offset_sec;
    if (offset != null && offset <= currentTime + toleranceSec) active = i;
  }
  return active;
}
