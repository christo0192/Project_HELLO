/**
 * One clock for the Review screen.
 *
 * A turn's seek offset is into its own call's file (sessionLegs.ts), so two calls each start at 0:00.
 * The strip, the margin and the consent line need one position along the whole session, or pressing
 * a moment would light two different times. This is that position, in seconds:
 *
 *   - t = 0 is the recording of the first answered call that did not stop before consent, so that
 *     call reads exactly as its own file (or the moment it was answered, when it has no recording to
 *     read against). With no such call it is the first answered call;
 *   - a call before that one, a voicemail the redial came after, can be a day earlier. It stays in the
 *     calls list and plays on its own file, and takes no part in the strip's length or the timecodes;
 *   - a later call runs on from there, so the gap of a dropped line is drawn to scale;
 *   - with one recording for the session (no legs, or none playable) its offsets are the clock;
 *   - with no calls and no offsets (the scoped Ashby page reads no calls, and a worker phone turn has
 *     no session offset) the turns' own stamps give it, from the first turn. That clock is for reading
 *     only: it marks each turn as an estimate and plays nothing, since it is on no file.
 *
 * Pure: no clock of its own, no I/O.
 */

import type { CandidatePhoneAttempt, TranscriptLine } from '../../types';
import type { StripDrop } from '../recording/callStripGeometry';
import { timecode } from '../recording/callStripGeometry';
import { clockLegIndex, legPlayable, legRecordingAnchor, reconnectedLegs, turnStartMs } from './sessionLegs';
import type { LegGroup, LegSeekMode } from './sessionLegs';

/** Where to play a moment: a call's own file, or the session recording when `legId` is null. */
export interface SeekTarget {
  legId: string | null;
  offsetSec: number;
}

/** One transcript turn as Review places it. */
export interface ReviewRow {
  /** Index in the session transcript. The turn number is this plus one. */
  row: number;
  turn: TranscriptLine;
  /** Seconds along the whole session; null when the turn has no time, or its call came before t = 0. */
  atSec: number | null;
  /** null when this turn cannot start playback. */
  target: SeekTarget | null;
  /** The position is an estimate: the legacy file offset, or a stamp read with no call to anchor it. */
  approximate: boolean;
  /** The call it was spoken in; null with no calls or no timing. */
  legIndex: number | null;
}

function instantMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const callStart = (leg: CandidatePhoneAttempt) => instantMs(leg.connected_from ?? leg.answered_at);

/** Seconds from t = 0, never before it: a turn stamped a moment early sits at the start. */
const sinceBase = (ms: number, baseMs: number) => Math.max(0, (ms - baseMs) / 1000);

/** t = 0 of the session's clock, or null when nothing gives one. */
export function timelineBaseMs(
  legs: readonly CandidatePhoneAttempt[],
  sessionAnchorMs: number | null | undefined,
  transcript: readonly TranscriptLine[],
): number | null {
  const leg = legs[clockLegIndex(legs)];
  const answered = leg ? callStart(leg) : null;
  if (answered !== null) {
    // A call with no file to read against is timed from when it was answered.
    return (legPlayable(leg) ? legRecordingAnchor(leg, sessionAnchorMs)?.ms : null) ?? answered;
  }
  for (const turn of transcript) {
    const at = turnStartMs(turn, sessionAnchorMs);
    if (at !== null) return at;
  }
  return null;
}

/** Where a call's file starts on the clock, so its playhead can be read onto the strip. A call before t = 0 reads 0. */
export function legAxisStartSec(
  leg: CandidatePhoneAttempt,
  sessionAnchorMs: number | null | undefined,
  baseMs: number | null,
): number {
  const anchor = legRecordingAnchor(leg, sessionAnchorMs);
  return anchor && baseMs !== null ? sinceBase(anchor.ms, baseMs) : 0;
}

export interface BuildReviewRowsInput {
  transcript: readonly TranscriptLine[];
  legs: readonly CandidatePhoneAttempt[];
  groups: readonly LegGroup[];
  seekMode: LegSeekMode;
  baseMs: number | null;
}

/** Every turn in session order, each with its place on the clock and where it plays. */
export function buildReviewRows({ transcript, legs, groups, seekMode, baseMs }: BuildReviewRowsInput): ReviewRow[] {
  if (groups.length === 0) {
    return transcript.map((turn, row) => {
      const offset = turn.start_offset_sec ?? null;
      const stamp = offset === null && baseMs !== null ? turnStartMs(turn, null) : null;
      return {
        row,
        turn,
        atSec: offset ?? (stamp === null ? null : sinceBase(stamp, baseMs!)),
        target: offset === null ? null : { legId: null, offsetSec: offset },
        approximate: stamp !== null,
        legIndex: null,
      };
    });
  }

  const rows: ReviewRow[] = transcript.map((turn, row) => ({
    row,
    turn,
    atSec: null,
    target: null,
    approximate: false,
    legIndex: null,
  }));
  const clockLeg = clockLegIndex(legs);
  for (const group of groups) {
    const leg = group.legIndex === null ? null : legs[group.legIndex];
    const onClock = group.legIndex === null || group.legIndex >= clockLeg;
    for (const legTurn of group.turns) {
      const offset = legTurn.turn.start_offset_sec ?? null;
      const stamped = legTurn.atMs != null && baseMs !== null ? sinceBase(legTurn.atMs, baseMs) : null;
      const session = seekMode === 'session';
      rows[legTurn.index] = {
        row: legTurn.index,
        turn: transcript[legTurn.index],
        atSec: !onClock ? null : session ? (offset ?? stamped) : stamped,
        target: offset === null ? null : { legId: session || !leg ? null : leg.id, offsetSec: offset },
        approximate: group.approximate,
        legIndex: group.legIndex,
      };
    }
  }
  return rows;
}

/** The gap before a later answered call. */
export interface LegGap extends StripDrop {
  /** The later call, by leg index. */
  legIndex: number;
  /** A consented interview the line cut off went on in this call (`reconnectedLegs`). */
  dropped: boolean;
}

/** Where a call was seen to end on the clock. An end nobody saw is left null, never estimated. */
function seenEndSec(leg: CandidatePhoneAttempt, baseMs: number): number | null {
  const seen = leg.connected_to_source === 'observed' || leg.connected_to_source === 'ledger';
  const endedAt = seen ? instantMs(leg.connected_to) : null;
  return endedAt === null ? null : sinceBase(endedAt, baseMs);
}

/**
 * The gaps between the answered calls on the clock, one before each later call. A gap is measured from
 * the call before it, and a drop from the call the line cut off, which a voicemail in between does not
 * change: "continued at" always names the call that carried the interview. An end nobody saw is left
 * null in `fromSec`, what the words read, and `drawFromSec` gives the strip a start to draw from.
 */
export function legGaps(legs: readonly CandidatePhoneAttempt[], baseMs: number | null): LegGap[] {
  if (baseMs === null) return [];
  const carried = reconnectedLegs(legs);
  const clockLeg = clockLegIndex(legs);
  const answered = legs.flatMap((leg, legIndex) =>
    legIndex < clockLeg || callStart(leg) === null ? [] : [{ leg, legIndex }],
  );
  return answered.slice(1).map(({ leg, legIndex }, at) => {
    const previous = answered[at].leg;
    const previousEnd = seenEndSec(previous, baseMs);
    const cutOff = carried.get(legIndex);
    return {
      legIndex,
      fromSec: cutOff === undefined ? previousEnd : seenEndSec(legs[cutOff], baseMs),
      drawFromSec: previousEnd ?? sinceBase(callStart(previous)!, baseMs),
      toSec: sinceBase(callStart(leg)!, baseMs),
      dropped: cutOff !== undefined,
    };
  });
}

/** A drop in words, for the transcript row and "Check before deciding". */
export function dropWords({ fromSec, toSec }: StripDrop): string {
  const reconnect = `the call continued at ${timecode(toSec)}`;
  return fromSec === null ? `Line dropped; ${reconnect}` : `Line dropped at ${timecode(fromSec)}; ${reconnect}`;
}

/** Where a call was seen to end on the clock, and where its recording stops; null for what is unknown. */
function legEnds(
  leg: CandidatePhoneAttempt,
  sessionAnchorMs: number | null | undefined,
  baseMs: number,
): { seen: number | null; recorded: number | null } {
  const anchor = legRecordingAnchor(leg, sessionAnchorMs);
  const known = typeof leg.recorded_sec === 'number' && Number.isFinite(leg.recorded_sec);
  return {
    seen: seenEndSec(leg, baseMs),
    recorded: anchor && known ? sinceBase(anchor.ms, baseMs) + (leg.recorded_sec as number) : null,
  };
}

/**
 * Ends the strip may run to: where a call was seen to end, and where its recording stops. A timed-out
 * end is when somebody noticed, not when the call stopped (`legUnobservedNote`), so it does not count,
 * and a call before t = 0 is no part of the strip's length.
 */
export function timelineEnds(
  legs: readonly CandidatePhoneAttempt[],
  sessionAnchorMs: number | null | undefined,
  baseMs: number | null,
): number[] {
  if (baseMs === null) return [];
  return legs.slice(clockLegIndex(legs)).flatMap((leg) => {
    const { seen, recorded } = legEnds(leg, sessionAnchorMs, baseMs);
    return [seen, recorded].filter((sec): sec is number => sec !== null);
  });
}

/**
 * The last moment each call can have talk on it, by leg index: the end that was seen, else the end of
 * its recording. null when neither is known, and the estimate stands alone, and for a call before t = 0,
 * which has no talk on the clock to limit.
 */
export function legTalkLimits(
  legs: readonly CandidatePhoneAttempt[],
  sessionAnchorMs: number | null | undefined,
  baseMs: number | null,
): (number | null)[] {
  if (baseMs === null) return legs.map(() => null);
  const clockLeg = clockLegIndex(legs);
  return legs.map((leg, index) => {
    if (index < clockLeg) return null;
    const { seen, recorded } = legEnds(leg, sessionAnchorMs, baseMs);
    return seen ?? recorded;
  });
}

/** The consent gate, as far as the transcript proves it was passed. */
export interface ConsentSummary {
  firstRow: number;
  lastRow: number;
  /** How many turns the gate took. */
  count: number;
  /** When the candidate gave their answer. */
  atSec: number;
  approximate: boolean;
}

/**
 * The leading gate turns, when they show that consent was given: the candidate answered at the gate
 * and the interview went on after it, on one call, at a known time. Anything less claims nothing, so
 * the turns stay in full with no line over them. A call that ended at the gate, or that was recorded
 * before consent, must never read "Consent given". The gate is the one on the clock: a notice read to a
 * voicemail before t = 0 stays in full under its own call, and costs the real call nothing.
 */
export function consentSummary(
  rows: readonly ReviewRow[],
  legs: readonly CandidatePhoneAttempt[],
): ConsentSummary | null {
  const clockLeg = clockLegIndex(legs);
  const onClock = rows.filter((row) => row.legIndex === null || row.legIndex >= clockLeg);
  const end = onClock.findIndex((row) => row.turn.is_gate !== true);
  if (end <= 0) return null;
  const gate = onClock.slice(0, end);

  const legIndexes = new Set(gate.map((row) => row.legIndex));
  if (legIndexes.size !== 1) return null;
  const [legIndex] = legIndexes;
  if (legIndex !== null && legs[legIndex]?.consent_stage === 'before_consent') return null;

  const reply = [...gate].reverse().find((row) => row.turn.speaker === 'candidate');
  if (!reply || reply.atSec === null) return null;
  return {
    firstRow: gate[0].row,
    lastRow: gate[gate.length - 1].row,
    count: gate.length,
    atSec: reply.atSec,
    approximate: reply.approximate,
  };
}
