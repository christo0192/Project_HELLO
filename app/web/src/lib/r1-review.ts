/**
 * R1 review page, the pure half: what the address means, who is speaking, where each turn, phase,
 * quote and logged event sits on the recording, and every sentence the page says about a result.
 * No React, no network, no clock of its own, so each rule is pinned by a plain unit test.
 *
 * Staff-only. It sits beside `lib/r1.ts` on purpose, NOT in `lib/r1/` (the candidate side).
 *
 * Speakers. The worker stores the voice of an AI turn (`ai_voice`, 0136). An older turn has none, so
 * there the phase stands in for it: the learner speaks in the role-play, Christy everywhere else. That
 * is the scorer's own proxy (`r1SpeakerLabel`, API), and it can be wrong for a reply inside an aside.
 *
 * Talk. A bar needs a stored end that can be stood behind. A cut AI line's end is the latest its audio
 * can have stopped, so it can run late by the silence in that line (0136): it stays a tick, because
 * silence is never drawn as talk. `ai_played_ms` is not used for an end at all, as 0136 warns.
 *
 * Copy is sentence case. A stored code never reaches the screen: it is mapped to words, and an
 * unknown code to a neutral sentence.
 */
import { activeTurnAt } from '../components/talent/sessionLegs';
import { isEvidenceInsufficient } from './evidence-hold';
import { RECOMMENDATION_LABELS } from './recommendation-labels';
import { r1RecordingStateCopy, turnMediaSec, viewState } from './r1-recording';
import type { Note } from '../types';
import type {
  R1RecordingSummary,
  R1ReviewAssessment,
  R1ReviewAttempt,
  R1ReviewEvent,
  R1ReviewResponse,
  R1ReviewRound,
  R1ReviewTurn,
  R1TurnPhase,
} from './r1-types';

/* ── The address ──────────────────────────────────────────────────── */

export const R1_REVIEW_TABS = ['overview', 'briefing', 'resume', 'recording'] as const;
export type R1ReviewTab = (typeof R1_REVIEW_TABS)[number];

/** An unknown tab opens Overview: a feedback link from a later build must not break the page. */
export function reviewTabFrom(value: string | null): R1ReviewTab {
  return (R1_REVIEW_TABS as readonly string[]).includes(value ?? '') ? (value as R1ReviewTab) : 'overview';
}

/** Seconds into the recording, from `?t=`. Null for anything that is not a position. */
export function cueSecFrom(value: string | null): number | null {
  if (value === null || !/^\d+(\.\d+)?$/.test(value)) return null;
  const sec = Number(value);
  return Number.isFinite(sec) ? sec : null;
}

/**
 * The attempt named in `?attempt=`, else the one that was scored, else the latest.
 *
 * The number is the attempt's place in the list, from 1, and not its `attempt_number`: a restart keeps
 * the number of the attempt it replaces (0119), so two attempts can share one. The list runs in the
 * order they started, so a place stays put as attempts are added. Inside the page an attempt is its
 * session; this is only how the address says which.
 */
export function reviewAttemptFrom(
  value: string | null,
  attempts: readonly R1ReviewAttempt[],
  assessment: Pick<R1ReviewAssessment, 'session_id'> | null,
): R1ReviewAttempt | null {
  const named = value !== null && /^[1-9]\d*$/.test(value) ? attempts[Number(value) - 1] : undefined;
  if (named) return named;
  const scored = attempts.find((attempt) => attempt.session_id === assessment?.session_id);
  return scored ?? attempts[attempts.length - 1] ?? null;
}

/** What `?attempt=` says for an attempt. Null: this session is not in the list. */
export function attemptParam(attempts: readonly Pick<R1ReviewAttempt, 'session_id'>[], sessionId: string): string | null {
  const index = attempts.findIndex((attempt) => attempt.session_id === sessionId);
  return index < 0 ? null : String(index + 1);
}

/* ── The player ───────────────────────────────────────────────────── */

export const R1_PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/* ── Speakers ─────────────────────────────────────────────────────── */

export const R1_INTERVIEWER_LABEL = 'Christy (AI interviewer)';

/** "Priya Nair (AI learner)"; "AI learner" when the worker's log does not name her. */
export function learnerLabel(name: string | null): string {
  return name ? `${name} (AI learner)` : 'AI learner';
}

export type R1SpeakerKind = 'candidate' | 'interviewer' | 'learner';

function speakerKindOf(turn: R1ReviewTurn): R1SpeakerKind {
  if (turn.speaker === 'candidate') return 'candidate';
  if (turn.ai_voice) return turn.ai_voice;
  return turn.phase === 'roleplay' ? 'learner' : 'interviewer';
}

/* ── Turns on the recording ───────────────────────────────────────── */

export interface R1Citation {
  /** The quote's number across the call: the same number on the strip and in the scorecard. */
  number: number;
  metric: string;
  quote: string;
}

export interface PlacedTurn extends R1ReviewTurn {
  /** Its place in `attempt.turns`. */
  row: number;
  speakerKind: R1SpeakerKind;
  speakerLabel: string;
  /** Seconds into the recording. Null: nothing anchors it, so it cannot seek. */
  startSec: number | null;
  /** A stored end that can be stood behind, or null. The start of the next turn is never used instead. */
  endSec: number | null;
  /** Seconds after the call's first timed turn, for the label when there is no recording. */
  callSec: number | null;
  citations: R1Citation[];
}

function metricName(name: string | null, index: number): string {
  return name?.trim() || `Metric ${index + 1}`;
}

export function placeTurns(
  attempt: R1ReviewAttempt,
  candidateName: string,
  assessment: R1ReviewAssessment | null,
): PlacedTurn[] {
  const anchors = attempt.turns
    .map((turn) => turn.turn_started_at_ms)
    .filter((ms): ms is number => typeof ms === 'number');
  const firstMs = anchors.length > 0 ? Math.min(...anchors) : null;
  const turns = attempt.turns.map((turn, row): PlacedTurn => {
    const kind = speakerKindOf(turn);
    return {
      ...turn,
      row,
      speakerKind: kind,
      speakerLabel:
        kind === 'candidate' ? candidateName : kind === 'learner' ? learnerLabel(attempt.learner_name) : R1_INTERVIEWER_LABEL,
      startSec: turnMediaSec(turn.turn_started_at_ms, attempt.recording),
      endSec: turn.speaker === 'bot' && turn.interrupted ? null : turnMediaSec(turn.turn_ended_at_ms, attempt.recording),
      callSec: firstMs !== null && typeof turn.turn_started_at_ms === 'number' ? (turn.turn_started_at_ms - firstMs) / 1000 : null,
      citations: [],
    };
  });
  // Evidence names turns of the attempt that was scored, and no other.
  if (assessment?.session_id !== attempt.session_id) return turns;
  for (const mark of evidenceMarks(assessment, turns)) {
    if (mark.row !== null) turns[mark.row].citations.push({ number: mark.number, metric: mark.metric, quote: mark.quote });
  }
  return turns;
}

/** The row at a position, by the highlight rule itself (`activeTurnAt`). */
export function cuedRow(turns: readonly PlacedTurn[], sec: number): number | null {
  return activeTurnAt(turns.map((turn) => turn.startSec), sec);
}

/**
 * The recording's length; a turn past it stretches the scale rather than fall off the end. With no stored
 * length the last turn's start is only how far the scale is known to reach, and a note pinned after it was
 * pinned to playing media, so it reaches further. A stored length needs no help from a note.
 */
export function reviewDurationSec(
  attempt: R1ReviewAttempt,
  turns: readonly PlacedTurn[],
  notes: readonly { sec: number | null }[] = [],
): number {
  const stored = attempt.recording.duration_ms;
  const pinned = typeof stored === 'number' ? [] : notes.map((note) => note.sec ?? 0);
  return Math.max(typeof stored === 'number' ? stored / 1000 : 0, ...turns.map((turn) => turn.startSec ?? 0), ...pinned, 0);
}

/* ── Phases ───────────────────────────────────────────────────────── */

const PHASE_LABEL: Readonly<Record<R1TurnPhase, string>> = {
  opening: 'Opening',
  icebreaker: 'Icebreaker',
  transition: 'Transition',
  roleplay: 'Role-play',
  aside: 'Aside',
  roleplay_exit: 'Role-play exit',
  wrapup: 'Wrap-up',
  closing: 'Closing',
};

export function phaseLabel(phase: R1TurnPhase | null): string | null {
  return phase ? PHASE_LABEL[phase] ?? null : null;
}

export interface PhaseSegment {
  phase: R1TurnPhase;
  label: string;
  startSec: number;
  endSec: number;
}

/** Neighbouring turns of one phase, in time order. A turn with no phase stays in the one before it. */
export function phaseSegments(turns: readonly PlacedTurn[], durationSec: number): PhaseSegment[] {
  const timed = turns
    .filter((turn): turn is PlacedTurn & { startSec: number } => turn.startSec !== null)
    .sort((a, b) => a.startSec - b.startSec);
  const segments: PhaseSegment[] = [];
  for (const turn of timed) {
    const label = phaseLabel(turn.phase);
    if (!turn.phase || !label) continue;
    const last = segments[segments.length - 1];
    if (last?.phase === turn.phase) continue;
    if (last) last.endSec = turn.startSec;
    segments.push({ phase: turn.phase, label, startSec: turn.startSec, endSec: durationSec });
  }
  return segments;
}

/** The role-play clock's two lines: when an offer to wrap up may first come, and when it ends. */
const ROLE_PLAY_MARKS = [
  { rSec: 14 * 60, label: '14:00', detail: 'Earliest offer to wrap up' },
  { rSec: 20 * 60, label: '20:00', detail: 'End of the role-play' },
] as const;

export interface RolePlayMark {
  sec: number;
  label: string;
  detail: string;
}

/**
 * 14:00 and 20:00 are readings of the role-play clock, not of the call: it starts at the pickup and
 * stops through an aside. A mark the role-play never reached is not drawn.
 */
export function rolePlayMarks(segments: readonly PhaseSegment[]): RolePlayMark[] {
  const marks: RolePlayMark[] = [];
  let elapsed = 0;
  let started = false;
  for (const segment of segments) {
    if (segment.phase === 'roleplay') {
      started = true;
      const length = segment.endSec - segment.startSec;
      for (const { rSec, label, detail } of ROLE_PLAY_MARKS) {
        if (rSec > elapsed && rSec <= elapsed + length) marks.push({ sec: segment.startSec + (rSec - elapsed), label, detail });
      }
      elapsed += length;
    } else if (started && segment.phase !== 'aside') {
      break;
    }
  }
  return marks;
}

/* ── Evidence ─────────────────────────────────────────────────────── */

export interface EvidenceMark {
  number: number;
  metricId: string;
  metric: string;
  turnIndex: number;
  quote: string;
  /** Null: the quote names a turn this attempt does not have. It is still shown, unplaced. */
  row: number | null;
  startSec: number | null;
}

/** Every quote in the assessment, numbered in call order. */
export function evidenceMarks(assessment: R1ReviewAssessment | null, turns: readonly PlacedTurn[]): EvidenceMark[] {
  if (!assessment) return [];
  const byIndex = new Map(turns.map((turn) => [turn.turn_index, turn]));
  return assessment.metric_results
    .flatMap((metric, index) =>
      metric.evidence.map((item) => {
        const turn = byIndex.get(item.turn_index);
        return {
          metricId: metric.metric_id,
          metric: metricName(metric.name, index),
          turnIndex: item.turn_index,
          quote: item.quote,
          row: turn?.row ?? null,
          startSec: turn?.startSec ?? null,
        };
      }),
    )
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .map((mark, index) => ({ ...mark, number: index + 1 }));
}

/**
 * Where in `text` the cited quotes are, as merged `[start, end)` ranges. A quote can carry the
 * scorer's truncation mark; one the words do not contain draws nothing, and the row still says it
 * was cited.
 */
export function highlightRanges(text: string, quotes: readonly string[]): Array<[number, number]> {
  const haystack = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const quote of quotes) {
    const needle = quote.toLowerCase().replace(/[….\s]+$/u, '').trim();
    if (!needle) continue;
    const at = haystack.indexOf(needle);
    if (at >= 0) ranges.push([at, at + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/* ── The log ──────────────────────────────────────────────────────── */

const needOrdinal = (need: string | null): string | null => /^H(\d)$/.exec(need ?? '')?.[1] ?? null;

function eventWords(event: R1ReviewEvent): string | null {
  switch (event.event_type) {
    case 'need_revealed': {
      const ordinal = needOrdinal(event.need);
      return ordinal ? `Need ${ordinal} revealed` : 'Need revealed';
    }
    case 'family_delivered':
      return 'Objection raised';
    case 'push_delivered':
      return 'Objection pressed';
    case 'counter_delivered':
      return 'Counter-offer made';
    case 'discount_detected':
      return 'Discount offered';
    case 'guard_hit':
      return 'Learner guard triggered';
    default:
      return null;
  }
}

export interface EventMark {
  key: string;
  label: string;
  turnIndex: number;
  row: number;
  startSec: number | null;
}

/** This attempt's logged moments that sit at a turn and that the page has words for. */
export function eventMarks(events: readonly R1ReviewEvent[], sessionId: string, turns: readonly PlacedTurn[]): EventMark[] {
  const byIndex = new Map(turns.map((turn) => [turn.turn_index, turn]));
  return events.flatMap((event, index) => {
    const label = eventWords(event);
    const turn = event.turn_index === null ? undefined : byIndex.get(event.turn_index);
    if (event.session_id !== sessionId || !label || !turn) return [];
    return [{ key: `${event.event_type}-${index}`, label, turnIndex: turn.turn_index, row: turn.row, startSec: turn.startSec }];
  });
}

/* ── Notes ────────────────────────────────────────────────────────── */

/** The API's window on a note's time (0137). */
const NOTE_MEDIA_MS_MAX = 86_400_000;

export interface AttemptNote extends Note {
  /** Seconds into the recording. Null: the note names no moment. */
  sec: number | null;
}

/**
 * The notes of one attempt, in the order of the recording, and then the ones with no time. A note on the
 * round alone belongs to each attempt. The answer runs oldest first, so a tie stays as it was written.
 */
export function attemptNotes(notes: readonly Note[], sessionId: string): AttemptNote[] {
  const place = (note: AttemptNote) => note.sec ?? Number.MAX_SAFE_INTEGER;
  return notes
    .filter((note) => (note.session_id ?? sessionId) === sessionId)
    .map((note) => ({ ...note, sec: typeof note.media_ms === 'number' ? note.media_ms / 1000 : null }))
    .sort((a, b) => place(a) - place(b));
}

/** The playhead as a note's time. Rounded down: the clock floors too, so a note prints the second it was added at. */
export function noteMediaMs(sec: number): number {
  const ms = Math.floor(sec * 1000);
  return Number.isFinite(ms) ? Math.min(NOTE_MEDIA_MS_MAX, Math.max(0, ms)) : 0;
}

/**
 * Who wrote a note, as far as this page may say. Staff names are not available to it: an allowlist email
 * never reaches a non-admin, and no other name is held. "You" is known, and a short piece of the opaque id
 * tells two colleagues apart. Never a guess at a name.
 */
export function noteAuthor(authorId: string, reviewerId: string | null): string {
  return authorId === reviewerId ? 'You' : `Reviewer ${authorId.slice(0, 4)}`;
}

export interface NeedReveal {
  need: string;
  label: string;
  /** The log has the reveal. Its turn can still be unknown: the worker could not map it to one. */
  revealed: boolean;
  turnIndex: number | null;
  row: number | null;
  startSec: number | null;
}

/** The learner's three held-back needs, revealed or not. */
export function neededReveals(events: readonly R1ReviewEvent[], sessionId: string, turns: readonly PlacedTurn[]): NeedReveal[] {
  const byIndex = new Map(turns.map((turn) => [turn.turn_index, turn]));
  return ['H1', 'H2', 'H3'].map((need) => {
    const event = events.find((item) => item.session_id === sessionId && item.event_type === 'need_revealed' && item.need === need);
    const turn = event?.turn_index == null ? undefined : byIndex.get(event.turn_index);
    return {
      need,
      label: `Need ${needOrdinal(need)}`,
      revealed: event !== undefined,
      turnIndex: event?.turn_index ?? null,
      row: turn?.row ?? null,
      startSec: turn?.startSec ?? null,
    };
  });
}

/* ── Where the round stands ───────────────────────────────────────── */

export type R1ReviewStage = 'withheld' | 'scored' | 'not_scored' | 'scoring' | 'invited' | 'in_progress' | 'link_open' | 'closed';

const notScored = (assessment: R1ReviewAssessment): boolean =>
  assessment.raw_recommendation === 'human_review' || assessment.recommendation === null;

/**
 * How long after an attempt ends a score is still expected. The scorer's own limits are far shorter:
 * a provider outage defers for about an hour, and a job that gives up leaves a placeholder. Past this
 * no job exists: an attempt from before 0126, or a round left with no live consent.
 */
export const R1_SCORE_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a score can still arrive for an attempt. A completed session is queued; a failed one only
 * when the attempt counted (0126); and none is promised once consent is withdrawn, which stops the
 * scoring of the interview.
 */
function scoreCanArrive(attempt: R1ReviewAttempt, roundCreatedAt: string, nowMs: number): boolean {
  if (attempt.consent_withdrawn) return false;
  if (attempt.session_status !== 'completed' && !(attempt.session_status === 'failed' && attempt.counted)) return false;
  return nowMs - Date.parse(attempt.ended_at ?? attempt.started_at ?? roundCreatedAt) < R1_SCORE_WAIT_MS;
}

/**
 * Whether anyone is in an interview now. The round's own status cannot say: an attempt that ended
 * uncounted leaves it `in_progress` until the link lapses (`r1_settle_attempt`), with nobody in it.
 */
export function roundIsRunning(attempts: readonly Pick<R1ReviewAttempt, 'in_progress'>[]): boolean {
  return attempts.some((attempt) => attempt.in_progress);
}

export function reviewStage(review: Pick<R1ReviewResponse, 'round' | 'attempts' | 'assessment'>, nowMs: number): R1ReviewStage {
  const { round, attempts, assessment } = review;
  if (round.scores_withheld) return 'withheld';
  // The round is what carries a usable result: only a valid gated score reaches it (0122).
  if (assessment) return notScored(assessment) || !round.recommendation ? 'not_scored' : 'scored';
  if (attempts.some((attempt) => scoreCanArrive(attempt, round.created_at, nowMs))) return 'scoring';
  if (round.status === 'completed' || round.status === 'expired' || round.status === 'cancelled') return 'closed';
  if (round.status !== 'in_progress') return 'invited';
  return roundIsRunning(attempts) ? 'in_progress' : 'link_open';
}

export function notScoredSentence(assessment: R1ReviewAssessment): string {
  switch (assessment.r1.outcome) {
    case 'no_candidate_speech':
      return 'Not scored: the candidate said too little in the scored phases.';
    case 'scored':
      return 'Not scored: the interview did not pass its checks.';
    default:
      return 'Not scored: scoring could not be completed.';
  }
}

export interface R1Verdict {
  word: string;
  /** Position, not colour: full is Select, half Borderline, empty Reject. */
  mark: 'full' | 'half' | 'empty';
  overall: number | null;
}

const VERDICT_MARK = { advance: 'full', hold: 'half', reject: 'empty' } as const;

export function verdictOf(round: Pick<R1ReviewRound, 'recommendation' | 'overall'>): R1Verdict | null {
  if (!round.recommendation) return null;
  return {
    word: RECOMMENDATION_LABELS[round.recommendation],
    mark: VERDICT_MARK[round.recommendation],
    overall: round.overall,
  };
}

/**
 * The phone screening's one line, in the candidate header's own terms. A held score is no result to
 * set beside the R1 verdict, so it gives no verdict or figure at all.
 */
export function phoneResultWords(phone: NonNullable<R1ReviewResponse['phone_screening']>): string | null {
  if (isEvidenceInsufficient(phone)) return 'Held: not enough evidence';
  const word = phone.recommendation ? (RECOMMENDATION_LABELS as Readonly<Record<string, string>>)[phone.recommendation] : null;
  const figure = phone.overall_score === null ? null : Math.round(phone.overall_score);
  const result = [word, figure].filter((part) => part !== null && part !== undefined).join(' ');
  if (!result) return null;
  return phone.scoring_status === 'incomplete_evidence' ? `${result}, provisional` : result;
}

/* ── Check before trusting it ─────────────────────────────────────── */

const CHECK_WORDS: Readonly<Record<string, string>> = {
  roleplay_duration_unknown: 'The length of the role-play could not be measured.',
  roleplay_too_short: 'The role-play was too short to score reliably.',
  too_few_candidate_turns: 'The candidate took too few turns in the role-play.',
  family_missing: 'The learner did not raise every planned objection.',
  push_missing: 'The learner did not press every planned objection.',
  family_slip: 'An objection came later than planned.',
  family_slip_unknown: 'The timing of an objection could not be confirmed.',
  counter_missing: 'The learner did not make the planned counter-offer.',
  counter_slip: 'The counter-offer came later than planned.',
  counter_slip_unknown: 'The timing of the counter-offer could not be confirmed.',
  need_reveal_turn_unknown: 'The turn where a need was revealed could not be confirmed.',
  unprobed_reveal: 'A need came out without the candidate asking for it.',
  out_of_level_commitment: 'The learner committed further than the script allows.',
  out_of_level_concession: 'The learner conceded further than the script allows.',
  guard_hits: 'The learner went off script too often.',
  fidelity_facts_missing: 'The facts about how the interview ran were not recorded.',
  latency_unknown: 'The AI voice\'s response time could not be measured.',
  latency_p95_exceeded: 'The AI voice was slow to respond.',
  stt_sanity: 'The speech-to-text looked unreliable.',
  scoring_incomplete: 'Scoring did not finish.',
  runs_disagree: 'The two scoring runs disagreed.',
  evidence_invalid: 'A quote could not be matched to the transcript.',
  system_failure_outcome: 'The interview ended on a system failure.',
  session_not_completed: 'The interview did not finish.',
  session_not_clean: 'The interview did not end cleanly.',
};

const OTHER_CHECK = 'Another check did not pass.';

/** A placeholder row's only failure: the "Not scored" headline already says it. */
const HEADLINE_CODES: ReadonlySet<string> = new Set(['no_candidate_speech', 'scoring_failed', 'r1_scorecard_mismatch']);

/** "family_missing:f2" -> its plain sentence. The family is detail a reviewer cannot act on. */
function checkWords(code: string): string {
  return CHECK_WORDS[code.split(':')[0]] ?? OTHER_CHECK;
}

export interface TrustCheck {
  key: string;
  text: string;
}

function recordingCheck(summary: R1RecordingSummary): string | null {
  const copy = r1RecordingStateCopy(summary);
  if (viewState(summary) === 'partial' || copy.notice) return copy.notice;
  return summary.has_video === false ? 'This is an audio-only recording.' : null;
}

/** Everything that should slow a reader down: failed checks, a disagreement, an incomplete recording. */
export function trustChecks(assessment: R1ReviewAssessment | null, attempt: R1ReviewAttempt | null): TrustCheck[] {
  const sentences: string[] = [];
  const add = (sentence: string | null) => {
    if (sentence && !sentences.includes(sentence)) sentences.push(sentence);
  };
  if (assessment) {
    const { gate, administration_quality: quality, agreement } = assessment.r1;
    for (const code of [...(gate?.failures ?? []), ...(quality?.failures ?? [])]) {
      if (!HEADLINE_CODES.has(code)) add(checkWords(code));
    }
    if (agreement?.runs_agree === false) add(CHECK_WORDS.runs_disagree);
  }
  if (attempt) add(recordingCheck(attempt.recording));
  return sentences.map((text) => ({ key: text, text }));
}

/* ── Bands on the strip ───────────────────────────────────────────── */

export interface RecordingBand {
  startSec: number;
  endSec: number;
  label: string;
}

/** Where the recording is not the whole picture. */
export function recordingBands(summary: R1RecordingSummary, durationSec: number): RecordingBand[] {
  if (summary.has_video === false) return [{ startSec: 0, endSec: durationSec, label: 'Audio only' }];
  if (typeof summary.degraded_at_ms === 'number') {
    return [{ startSec: summary.degraded_at_ms / 1000, endSec: durationSec, label: 'Audio only' }];
  }
  return viewState(summary) === 'partial' ? [{ startSec: 0, endSec: durationSec, label: 'Partial recording' }] : [];
}
