/**
 * Phase-aware R1 transcript model for the scorer (plan 6.2).
 *
 * Today every bot line in the phone scorer prompt is labelled "Interviewer" (prompt.ts).
 * R1 needs more: the role-play learner is an AI and its lines are NEVER evidence, the
 * learner's scripted commitment response is masked, interrupted learner turns are kept
 * with a flag, the candidate's name is masked, and every line carries its turn index and
 * phase so an evidence reference can be validated against a real candidate turn.
 *
 * Pure: reads nothing, writes nothing. The label vocabulary is part of the scorer prompt.
 */

import { R1_PHASES, type R1TurnPhase } from './rubric.js';

export interface R1TurnRow {
  readonly turn_index: number;
  readonly speaker: string;
  readonly text: string;
  readonly phase: string | null;
  readonly interrupted: boolean | null;
}

export type R1Speaker = 'bot' | 'candidate';

export interface R1Turn {
  readonly index: number;
  readonly speaker: R1Speaker;
  /** Null for a row written without a phase: never evidence-eligible. */
  readonly phase: R1TurnPhase | null;
  readonly text: string;
  readonly interrupted: boolean;
}

const PHASE_SET: ReadonlySet<string> = new Set<string>(R1_PHASES);

/** A turn longer than this is truncated: a runaway speech-to-text result must not flood the prompt. */
export const MAX_TURN_CHARS = 4000;

/**
 * One turn is ONE prompt line. Collapsing every run of whitespace, newlines included, means a
 * candidate cannot forge a `[T99 | roleplay] ...` line or a fence marker by speaking a line break,
 * and quotes compare the same way the model saw them.
 */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TURN_CHARS
    ? `${collapsed.slice(0, MAX_TURN_CHARS)} [truncated]`
    : collapsed;
}

/** Rows to turns: drop unknown speakers, empty text and bad indices, keep order by turn index. */
export function toR1Turns(rows: readonly R1TurnRow[]): R1Turn[] {
  const turns: R1Turn[] = [];
  for (const row of rows) {
    if (row.speaker !== 'bot' && row.speaker !== 'candidate') continue;
    if (!Number.isInteger(row.turn_index) || row.turn_index < 0) continue;
    const text = oneLine(typeof row.text === 'string' ? row.text : '');
    if (!text) continue;
    const phase = typeof row.phase === 'string' && PHASE_SET.has(row.phase)
      ? (row.phase as R1TurnPhase)
      : null;
    turns.push({
      index: row.turn_index,
      speaker: row.speaker,
      phase,
      text,
      interrupted: row.interrupted === true,
    });
  }
  return turns.sort((a, b) => a.index - b.index);
}

/** The label the scorer prompt shows for a turn. */
export function r1SpeakerLabel(turn: R1Turn): string {
  if (turn.speaker === 'candidate') {
    return turn.phase === 'roleplay' ? 'Candidate (as Program Advisor)' : 'Candidate';
  }
  return turn.phase === 'roleplay'
    ? 'Learner (simulated by the AI; never evidence)'
    : 'Interviewer';
}

export const R1_COMMITMENT_MASK = '[learner commitment response masked]';
export const R1_NAME_MASK = '[CANDIDATE]';

/**
 * The three scripted commitment lines (plan 5.5). The commitment outcome is logged by the
 * worker and is NOT scoring evidence, so the scorer sees a masked placeholder instead of
 * which level the learner chose. Matching is sentence-level so surrounding talk survives.
 */
const COMMITMENT_PATTERNS: readonly RegExp[] = [
  /send me the enrol+ment link/i,
  /pay the deposit today/i,
  /book a call on thursday at 7\s?pm/i,
  /email me the details and i['’]?ll get back to you/i,
];

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

export function maskCommitmentLines(text: string): string {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) =>
      COMMITMENT_PATTERNS.some((pattern) => pattern.test(sentence)) ? R1_COMMITMENT_MASK : sentence)
    .join(' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mask every whole-word occurrence of any name part (two or more characters). */
export function maskCandidateName(text: string, candidateName: string | null): string {
  if (!candidateName) return text;
  const parts = candidateName
    .split(/\s+/)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((part) => part.length >= 2);
  if (parts.length === 0) return text;
  const alternatives = parts.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return text.replace(pattern, R1_NAME_MASK);
}

/** Apply the commitment and name masks. Learner commitment lines exist only in role-play. */
export function maskR1Turns(
  turns: readonly R1Turn[],
  candidateName: string | null,
): R1Turn[] {
  return turns.map((turn) => {
    let text = turn.text;
    if (turn.speaker === 'bot' && turn.phase === 'roleplay') text = maskCommitmentLines(text);
    text = maskCandidateName(text, candidateName);
    return { ...turn, text };
  });
}

/** One line per turn: `[T12 | roleplay] Candidate (as Program Advisor): ...`. */
export function formatR1Transcript(turns: readonly R1Turn[]): string {
  if (turns.length === 0) return '(no turns were captured)';
  return turns
    .map((turn) => {
      const flag = turn.interrupted ? ' [interrupted]' : '';
      const head = `[T${turn.index} | ${turn.phase ?? 'unknown'}] ${r1SpeakerLabel(turn)}`;
      return `${head}: ${turn.text}${flag}`;
    })
    .join('\n');
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** True when the text carries no letter at all (digits, punctuation, filler marks). */
export function isNonLexical(text: string): boolean {
  return !/\p{L}/u.test(text);
}

export interface R1TranscriptStats {
  readonly candidateTurns: number;
  readonly candidateRoleplayTurns: number;
  /** Role-play candidate turns of at least MIN_QUALIFYING_WORDS words. */
  readonly candidateRoleplayQualifyingTurns: number;
  /** Share of role-play candidate turns that are at most two words or non-lexical. */
  readonly suspectShare: number;
  /** Candidate share of role-play words, 0..100; null with no role-play words at all. */
  readonly roleplayWordSharePct: number | null;
  readonly roleplayQuestions: number;
  /** Candidate turns in a phase an evidence reference may use (any metric). */
  readonly evidenceEligibleCandidateTurns: number;
}

export const MIN_QUALIFYING_WORDS = 3;

export function computeTranscriptStats(turns: readonly R1Turn[]): R1TranscriptStats {
  let candidateTurns = 0;
  let roleplay = 0;
  let qualifying = 0;
  let suspect = 0;
  let candidateWords = 0;
  let learnerWords = 0;
  let questions = 0;
  let eligible = 0;
  for (const turn of turns) {
    const words = wordCount(turn.text);
    if (turn.speaker === 'candidate') {
      candidateTurns += 1;
      if (turn.phase === 'roleplay' || turn.phase === 'icebreaker' || turn.phase === 'wrapup') {
        eligible += 1;
      }
      if (turn.phase === 'roleplay') {
        roleplay += 1;
        candidateWords += words;
        if (words >= MIN_QUALIFYING_WORDS) qualifying += 1;
        if (words <= 2 || isNonLexical(turn.text)) suspect += 1;
        questions += (turn.text.match(/\?/g) ?? []).length;
      }
    } else if (turn.phase === 'roleplay') {
      learnerWords += words;
    }
  }
  const totalWords = candidateWords + learnerWords;
  return {
    candidateTurns,
    candidateRoleplayTurns: roleplay,
    candidateRoleplayQualifyingTurns: qualifying,
    suspectShare: roleplay === 0 ? 1 : suspect / roleplay,
    roleplayWordSharePct: totalWords === 0
      ? null
      : Math.round((candidateWords / totalWords) * 1000) / 10,
    roleplayQuestions: questions,
    evidenceEligibleCandidateTurns: eligible,
  };
}
