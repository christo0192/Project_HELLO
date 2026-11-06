/**
 * The call strip's arithmetic. No React and no clock: every figure on the strip is a function of the
 * turns it is given, so each rule here is pinned by a plain unit test.
 *
 * A phone turn has a start and no end. Its segment therefore runs from its start to the smaller of
 * the next turn's start and its estimated speech length, about 60 ms per character. The estimate can
 * only shorten a segment, so a pause stays empty: silence is never drawn as talk. A caller with real
 * ends (R1) passes them as `endSec` and the estimate is not used.
 */

/** How long a character of a transcript takes to say, near enough to draw it. */
export const MS_PER_CHARACTER = 60;

/**
 * A gap between calls longer than this stops being drawn to scale: a reconnect can be put off to the
 * next day, and at scale that leaves eight minutes of talk under 1% of the strip. Such a gap is a
 * break of fixed width instead, and the clock and the words still give its true length.
 */
export const STRIP_BREAK_AFTER_SEC = 15 * 60;
/** How much of the strip one break takes, in per cent. Several share `STRIP_BREAKS_MAX_PERCENT`. */
export const STRIP_BREAK_PERCENT = 6;
const STRIP_BREAKS_MAX_PERCENT = 24;

/** The most marks under the strip: past this the printed timecodes run into each other. */
export const STRIP_MAX_MARKS = 12;
/** Two marks closer than this, in per cent of the strip, would print over each other. */
const MARK_MIN_GAP_PERCENT = 6;

export interface StripTurn {
  speaker: 'candidate' | 'ai';
  /** Seconds along the strip. */
  startSec: number;
  /** Only its length is read. */
  text: string;
  /** A known end. Phone turns have none. */
  endSec?: number | null;
  /** Where the call this turn was spoken on is known to have ended: nothing is drawn past it. */
  limitSec?: number | null;
  /** Part of the consent gate. */
  gate?: boolean;
}

export type StripSegmentKind = 'candidate' | 'ai' | 'gate';

export interface StripSegment {
  kind: StripSegmentKind;
  startSec: number;
  endSec: number;
}

/** A line drop: `fromSec` is null when nobody observed where the first call ended. */
export interface StripDrop {
  fromSec: number | null;
  toSec: number;
  /**
   * The call just before this gap: where it was seen to end, else where it began. Drawing only, so a gap
   * with no talk before it can still be cut. The words read `fromSec` and never claim this as an end.
   */
  drawFromSec?: number | null;
}

export interface StripTalk {
  candidateSec: number;
  aiSec: number;
  /** Whole per cent of the talk outside the consent gate. null when nobody spoke, never 0. */
  candidateShare: number | null;
}

const SEC_PER_CHARACTER = MS_PER_CHARACTER / 1000;

/** The segments to draw, in time order. A turn with no time or no room draws nothing. */
export function stripSegments(turns: readonly StripTurn[]): StripSegment[] {
  const timed = turns
    .filter((turn) => Number.isFinite(turn.startSec))
    .map((turn, order) => ({ turn, order }))
    .sort((a, b) => a.turn.startSec - b.turn.startSec || a.order - b.order)
    .map(({ turn }) => turn);

  const segments: StripSegment[] = [];
  timed.forEach((turn, index) => {
    const next = timed[index + 1]?.startSec ?? Number.POSITIVE_INFINITY;
    const spoken = turn.endSec ?? turn.startSec + turn.text.trim().length * SEC_PER_CHARACTER;
    // A limit at or before the start says nothing about this turn: its stamp and the call's end come
    // from different clocks, and the turn was still spoken.
    const limit = turn.limitSec != null && turn.limitSec > turn.startSec ? turn.limitSec : Number.POSITIVE_INFINITY;
    const endSec = Math.min(next, spoken, limit);
    if (endSec <= turn.startSec) return;
    const kind = turn.gate ? 'gate' : turn.speaker;
    segments.push({ kind, startSec: turn.startSec, endSec });
  });
  return segments;
}

/** Who spoke for how long. Estimated from the segments, so a caller says "about". */
export function stripTalk(segments: readonly StripSegment[]): StripTalk {
  const sum = (kind: StripSegmentKind) =>
    segments.filter((s) => s.kind === kind).reduce((total, s) => total + (s.endSec - s.startSec), 0);
  const candidateSec = sum('candidate');
  const aiSec = sum('ai');
  const total = candidateSec + aiSec;
  return {
    candidateSec,
    aiSec,
    candidateShare: total > 0 ? Math.round((candidateSec / total) * 100) : null,
  };
}

/** Where the strip ends: the last talk, or a later end the call is known to have had. */
export function stripEndSec(segments: readonly StripSegment[], knownEnds: readonly (number | null)[]): number {
  return Math.max(0, ...segments.map((s) => s.endSec), ...knownEnds.filter((sec): sec is number => sec !== null));
}

/** A moment as a percentage of the strip, always on it. */
export function stripPercent(sec: number, endSec: number): number {
  if (endSec <= 0) return 0;
  return Math.min(100, Math.max(0, (sec / endSec) * 100));
}

/** How far apart the marks go on `lengthSec` of drawn talk. */
function scaleStep(lengthSec: number): number {
  let step = lengthSec < 60 ? 15 : lengthSec <= 600 ? 60 : lengthSec <= 1200 ? 120 : 300;
  while (lengthSec / step >= STRIP_MAX_MARKS) step *= 2;
  return step;
}

/** The printed marks under the strip, in seconds: a minute apart on an ordinary call. */
export function stripScale(endSec: number): number[] {
  const step = scaleStep(endSec);
  const marks: number[] = [];
  for (let sec = 0; sec <= endSec; sec += step) marks.push(sec);
  return marks;
}

/** Where the last talk before a moment stopped; null when nobody had spoken. */
function lastTalkEndSec(sec: number, segments: readonly StripSegment[]): number | null {
  const before = segments.filter((segment) => segment.endSec <= sec);
  return before.length > 0 ? before[before.length - 1].endSec : null;
}

/**
 * Where a drop's dotted line starts: the seen end, else the later of the last talk before the reconnect
 * and where the strip may draw from.
 */
export function dropStartSec(drop: StripDrop, segments: readonly StripSegment[]): number {
  if (drop.fromSec !== null) return drop.fromSec;
  const known = [lastTalkEndSec(drop.toSec, segments), drop.drawFromSec ?? null].filter((sec) => sec !== null);
  return known.length > 0 ? Math.max(...known) : drop.toSec;
}

/**
 * Where a long gap's cut starts. A drop can reach back past a call in between, and only what follows
 * that call's talk is empty: a cut from further back would swallow it and overlap the gap before it.
 */
function breakStartSec(drop: StripDrop, segments: readonly StripSegment[]): number {
  const start = dropStartSec(drop, segments);
  if (drop.drawFromSec == null) return start;
  return Math.max(start, drop.drawFromSec, lastTalkEndSec(drop.toSec, segments) ?? start);
}

/** A stretch of the clock the strip draws at a fixed width rather than to scale. */
export interface StripBreak {
  fromSec: number;
  toSec: number;
}

/** The drops too long to draw to scale, in time order. */
export function stripBreaks(drops: readonly StripDrop[], segments: readonly StripSegment[]): StripBreak[] {
  return drops
    .map((drop) => ({ fromSec: breakStartSec(drop, segments), toSec: drop.toSec }))
    .filter((gap) => gap.toSec - gap.fromSec > STRIP_BREAK_AFTER_SEC)
    .sort((a, b) => a.fromSec - b.fromSec);
}

/** How the strip reads the clock: a moment's place across it, and the marks printed under it. */
export interface StripAxis {
  /** A moment as a percentage of the strip, always on it. */
  percent: (sec: number) => number;
  marks: number[];
  /** The middle of each break, in per cent. */
  breakCentres: number[];
}

/**
 * To scale, unless a gap is too long to be: each break then takes a fixed width, the talk shares the
 * rest in proportion, and the marks start again after the break from the moment the next call began.
 */
export function stripAxis(endSec: number, breaks: readonly StripBreak[]): StripAxis {
  const brokenSec = breaks.reduce((total, gap) => total + (gap.toSec - gap.fromSec), 0);
  const drawnSec = endSec - brokenSec;
  if (breaks.length === 0 || drawnSec <= 0) {
    return { percent: (sec) => stripPercent(sec, endSec), marks: stripScale(endSec), breakCentres: [] };
  }

  const breakShare = Math.min(STRIP_BREAK_PERCENT, STRIP_BREAKS_MAX_PERCENT / breaks.length);
  const perSec = (100 - breakShare * breaks.length) / drawnSec;

  const percent = (sec: number): number => {
    const moment = Math.min(endSec, Math.max(0, sec));
    let at = 0;
    let cursor = 0;
    for (const gap of breaks) {
      if (moment <= gap.fromSec) return at + (moment - cursor) * perSec;
      at += (gap.fromSec - cursor) * perSec;
      if (moment < gap.toSec) return at + (breakShare * (moment - gap.fromSec)) / (gap.toSec - gap.fromSec);
      at += breakShare;
      cursor = gap.toSec;
    }
    return at + (moment - cursor) * perSec;
  };

  const step = scaleStep(drawnSec);
  const marks: number[] = [];
  let spanStart = 0;
  for (const span of [...breaks, { fromSec: endSec, toSec: endSec }]) {
    for (let sec = spanStart; sec <= span.fromSec; sec += step) {
      const previous = marks[marks.length - 1];
      if (previous === undefined || percent(sec) - percent(previous) >= MARK_MIN_GAP_PERCENT) marks.push(sec);
    }
    spanStart = span.toSec;
  }

  return { percent, marks, breakCentres: breaks.map((gap) => percent((gap.fromSec + gap.toSec) / 2)) };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** A position in a recording: "05:38", or "24:00:13" once a reconnect has run it past the hour. */
export function timecode(totalSec: number): string {
  const whole = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${pad(minutes)}:${pad(whole % 60)}`;
}

/**
 * Where each tick's numbered box sits, in px across a strip `width` wide. Two quotes in one turn share
 * a moment, and a box you cannot reach is a quote you cannot press, so a box steps aside just far
 * enough and the stem under it stays on the true moment. `centres` must be in order.
 */
export function layoutTickLabels(centres: readonly number[], width: number, labelWidth: number): number[] {
  const half = labelWidth / 2;
  const placed: number[] = [];
  for (const centre of centres) {
    const previous = placed[placed.length - 1];
    placed.push(Math.max(centre, half, previous === undefined ? half : previous + labelWidth));
  }
  // Pushed off the far end: walk back from the right edge until the boxes fit again.
  let limit = width - half;
  for (let index = placed.length - 1; index >= 0 && placed[index] > limit; index -= 1) {
    placed[index] = limit;
    limit -= labelWidth;
  }
  return placed;
}

function spokenLength(totalSec: number): string {
  const whole = Math.max(0, Math.round(totalSec));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  if (hours > 0) return `${hours} h ${minutes} min ${seconds} s`;
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds} s`;
}

export interface StripAlternativeInput {
  endSec: number;
  calls: number;
  candidateName: string;
  talk: StripTalk;
  /** The moment consent was given, or null when the transcript does not show it. */
  consentAt: string | null;
  drops: readonly StripDrop[];
  /** Gaps before a later call that no drop explains. */
  gaps?: readonly StripDrop[];
  quotes: number;
}

/** The strip in words: its length, the candidate's share, consent, the drops, the gaps and the quotes. */
export function stripAlternative({ endSec, calls, candidateName, talk, consentAt, drops, gaps = [], quotes }: StripAlternativeInput): string {
  const parts = [`Call strip: ${spokenLength(endSec)}${calls > 1 ? ` across ${calls} calls` : ''}.`];
  if (talk.candidateShare !== null) {
    parts.push(`${candidateName} spoke about ${spokenLength(talk.candidateSec)}, about ${talk.candidateShare}% of the talk.`);
  }
  if (consentAt) parts.push(`Consent given at ${consentAt}.`);
  for (const drop of drops) {
    parts.push(
      drop.fromSec === null
        ? `Line dropped and reconnected at ${timecode(drop.toSec)}.`
        : `Line dropped at ${timecode(drop.fromSec)} and reconnected at ${timecode(drop.toSec)}.`,
    );
  }
  for (const gap of gaps) parts.push(`Next call at ${timecode(gap.toSec)}.`);
  parts.push(quotes === 0 ? 'No evidence quotes.' : `${quotes} evidence ${quotes === 1 ? 'quote' : 'quotes'}.`);
  return parts.join(' ');
}
