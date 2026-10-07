/**
 * The R1 evidence contract (plan 6.2).
 *
 * The phone scorer asks for 80-character excerpts that are never speaker-checked. R1 does
 * better: every evidence reference is `T<turn index>: <verbatim excerpt>` and is validated
 * against the transcript the model was shown. A reference must point at a CANDIDATE turn in
 * a phase the metric may use, and its excerpt must actually occur in that turn. On a
 * violation the scorer resamples once with a fixed hint; a second violation marks the run's
 * evidence invalid and the recommendation falls back to `human_review`.
 *
 * A metric scored 3 or 4 must carry at least one VALID reference. The 3 and 4 anchors count
 * behaviours ("at least 4 open questions ..."), so a high level with no verifiable candidate
 * quote behind it is unsupported (`r1_evidence_missing`). The absence of a behaviour is
 * evidence only for the LOW levels, so levels 1 and 2 (and `insufficient_evidence`) may
 * carry none.
 *
 * References stay plain strings, so the persisted `metric_results[].evidenceRefs` keeps the
 * shape the shared HR panel already renders.
 */

import type { R1Turn } from './transcript.js';
import type { R1TurnPhase } from './rubric.js';

export const R1_EVIDENCE_CODES = [
  'r1_evidence_format',
  'r1_evidence_turn_unknown',
  'r1_evidence_not_candidate',
  'r1_evidence_phase',
  'r1_evidence_quote',
  'r1_evidence_missing',
] as const;
export type R1EvidenceCode = (typeof R1_EVIDENCE_CODES)[number];

/** Thrown by the per-run validator; carries the stable, PII-free code only. */
export class R1EvidenceError extends Error {
  readonly code: R1EvidenceCode;

  constructor(code: R1EvidenceCode) {
    super(code);
    this.name = 'R1EvidenceError';
    this.code = code;
  }
}

export interface R1EvidenceRef {
  readonly turnIndex: number;
  readonly quote: string;
}

const REF_PATTERN = /^T(\d{1,6})\s*:\s*([\s\S]+)$/;

export function parseEvidenceRef(ref: string): R1EvidenceRef | null {
  const match = REF_PATTERN.exec(ref.trim());
  if (!match) return null;
  const quote = (match[2] ?? '').trim();
  if (!quote) return null;
  return { turnIndex: Number(match[1]), quote };
}

/** Case, punctuation and spacing are not evidence-relevant; the truncation marker is dropped. */
export function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[….]+$/u, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface R1EvidenceCheck {
  /** The references that passed, in input order. */
  readonly valid: readonly R1EvidenceRef[];
  /** One entry per rejected reference, in input order. */
  readonly violations: readonly R1EvidenceCode[];
}

/** Check ONE metric's references against the turns the model saw. */
export function checkMetricEvidence(
  refs: readonly string[],
  turnsByIndex: ReadonlyMap<number, R1Turn>,
  allowedPhases: readonly R1TurnPhase[],
): R1EvidenceCheck {
  const valid: R1EvidenceRef[] = [];
  const violations: R1EvidenceCode[] = [];
  for (const raw of refs) {
    const ref = parseEvidenceRef(raw);
    if (ref === null) {
      violations.push('r1_evidence_format');
      continue;
    }
    const turn = turnsByIndex.get(ref.turnIndex);
    if (!turn) {
      violations.push('r1_evidence_turn_unknown');
      continue;
    }
    if (turn.speaker !== 'candidate') {
      violations.push('r1_evidence_not_candidate');
      continue;
    }
    if (turn.phase === null || !allowedPhases.includes(turn.phase)) {
      violations.push('r1_evidence_phase');
      continue;
    }
    const needle = normalizeForQuote(ref.quote);
    if (needle.length < 3 || !normalizeForQuote(turn.text).includes(needle)) {
      violations.push('r1_evidence_quote');
      continue;
    }
    valid.push(ref);
  }
  return { valid, violations };
}

/**
 * The ONLY text appended to a repair prompt for an evidence violation: one fixed sentence per
 * code, never the error, the model's text, or the candidate's.
 */
export const R1_EVIDENCE_REPAIR_SUFFIX: Readonly<Record<R1EvidenceCode, string>> = Object.freeze({
  r1_evidence_format:
    'every evidenceRefs entry must start with "T<turn number>: " followed by an excerpt of ' +
    'that turn.',
  r1_evidence_turn_unknown:
    'every evidenceRefs entry must cite a turn number that exists in the transcript.',
  r1_evidence_not_candidate:
    'evidenceRefs may cite only CANDIDATE turns; never cite an Interviewer or a Learner line.',
  r1_evidence_phase:
    'evidenceRefs may cite only candidate turns in the phases listed for that metric.',
  r1_evidence_quote:
    'each excerpt must be copied verbatim from the turn it cites.',
  r1_evidence_missing:
    'a score of 3 or 4 must cite at least one candidate turn.',
});
