/**
 * evidence.ts — the INTERVIEW-COVERAGE grade of one assessment revision (C3,
 * migration 0114 §4).
 *
 * WHY. Every decision downstream of scoring — the candidate status write, the
 * Ashby scorecard — used to key on METRIC coverage: "did at least one metric
 * score?". A partial phone call where the candidate answered nothing usable
 * (a744741c: 0 of 4 questions answered) could therefore auto-reject a
 * candidate, and publish a scorecard to Ashby, while a full call (01c5a5dc)
 * landed `screened`. This module grades the INTERVIEW instead: how much of the
 * planned screening actually happened. The grade is persisted per revision
 * (`assessments.evidence_grade|evidence_reason|evidence_answered|
 * evidence_planned`) and drives exactly two things:
 *
 *   * the candidate status rule (`canAutoReject`, assessment.ts);
 *   * the Ashby gate — an `insufficient` row is HELD for human review and
 *     never enqueued, executed or written to the provider.
 *
 * Scoring itself is untouched: every disconnect mode still gets a scorecard and
 * an MP3. This grades what the scorecard may be USED for, never whether it is
 * produced.
 *
 * PURE. `gradeEvidence` and `canAutoReject` read nothing, and the thresholds are
 * named constants mirrored BY NAME in migration 0114 §4's backfill CASE (and its
 * candidate repair). A threshold change here without the same change there makes
 * the backfilled grades disagree with live ones — the vitest asserts both.
 *
 * NO PII. Grades, reasons and counts only — never transcript text, names or
 * numbers.
 */

/** The two grades. `decision`: the row may drive a status and reach Ashby. */
export const EVIDENCE_GRADES = ['decision', 'insufficient'] as const;
export type EvidenceGradeValue = (typeof EVIDENCE_GRADES)[number];

/**
 * Closed vocabulary of `evidence_reason` (0114 §4 CHECK
 * `chk_assessments_evidence_reason`).
 *   complete_call        — browser, or a phone call that was not partial;
 *   partial_sufficient   — partial phone call, answered*4 >= planned*3;
 *   no_candidate_speech  — the candidate said nothing in the scored section;
 *   infra_interrupted    — insufficient, and the call was killed by our side
 *                          (`worker_crash`), not by the candidate. An
 *                          `unobserved_disconnect` (0125) is NOT our side;
 *   partial_thin         — insufficient partial, any other disconnect;
 *   no_plan              — partial, and the session has no question plan;
 *   evidence_read_failed — the coverage read failed twice (fail closed).
 */
export const EVIDENCE_REASONS = [
  'complete_call',
  'partial_sufficient',
  'no_candidate_speech',
  'infra_interrupted',
  'partial_thin',
  'no_plan',
  'evidence_read_failed',
] as const;
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];

/**
 * A partial call is a DECISION only when answered/planned >= 3/4.
 * Mirrored in 0114 §4 (backfill CASE). Integer arithmetic only:
 * `answered * DEN >= planned * NUM`.
 */
export const PARTIAL_DECISION = { num: 3, den: 4 } as const;

/**
 * A phone row may auto-REJECT only when answered/planned >= 1/2, measured.
 * Mirrored in 0114 §4 (candidate repair). `answered * DEN >= planned * NUM`.
 */
export const AUTO_REJECT_MIN = { num: 1, den: 2 } as const;

/** Progress dispositions (0086) that count as an ANSWERED question. */
export const ANSWERED_DISPOSITIONS: readonly string[] = [
  'asked_answered',
  'volunteered_with_evidence',
];

/** The disconnect token (0071/0113 finalize) that means "our side died". */
export const INFRA_DISCONNECT_REASON = 'worker_crash';

/**
 * 0125 §4: a leg ended by the lease reclaim (or a lapsed lease) that still
 * shows TEARDOWN EVIDENCE — a verified recording upload, a completed egress or
 * the worker's observed SIP leave — so the worker was alive at the end and the
 * line simply dropped unobserved. NOT an infrastructure fault: it grades like
 * every other non-crash disconnect (`no_candidate_speech` / `partial_thin`).
 */
export const UNOBSERVED_DISCONNECT_REASON = 'unobserved_disconnect';

/**
 * Every `disconnect_reason` partial-finalize can report (0072 → 0125 §4), in
 * the order its CASE decides them. Carried as a free string end to end (job
 * payload, `raw.partial.disconnect_reason`, the runtime log's `error_type`),
 * so an older API reading a newer token degrades safely: only
 * {@link INFRA_DISCONNECT_REASON} is ever treated as our side's fault. No PII.
 */
export const PHONE_DISCONNECT_REASONS = [
  'candidate_hangup',
  INFRA_DISCONNECT_REASON,
  UNOBSERVED_DISCONNECT_REASON,
  'disconnected',
] as const;
export type PhoneDisconnectReason = (typeof PHONE_DISCONNECT_REASONS)[number];

/**
 * The coverage of one phone session, read from `phone_session_plans` and
 * `phone_session_progress`.
 *
 * `planned`: the plan's `question_count`, or null when the session has no plan.
 * `progressRows`: every progress row (one per completed question boundary).
 * `answeredRows`: rows whose disposition is in {@link ANSWERED_DISPOSITIONS}.
 * `nullDispositionRows`: pre-0086 rows that carry no disposition at all.
 */
export interface EvidenceMeasurement {
  readonly planned: number | null;
  readonly progressRows: number;
  readonly answeredRows: number;
  readonly nullDispositionRows: number;
}

export interface GradeEvidenceInput {
  readonly source: 'browser' | 'phone';
  /** `assessments.partial` — the phone call ended before the plan completed. */
  readonly partial: boolean;
  /** Candidate (non-bot) turns in the SCORED (non-gate) transcript. */
  readonly candidateTurns: number;
  /**
   * `raw.partial.disconnect_reason`, one of {@link PHONE_DISCONNECT_REASONS}
   * (`candidate_hangup|worker_crash|unobserved_disconnect|disconnected`).
   */
  readonly disconnectReason: string | null;
  /**
   * The coverage read. `null` when it was not attempted (browser), the string
   * `'read_failed'` when it failed after its one retry.
   */
  readonly measurement: EvidenceMeasurement | null | 'read_failed';
}

export interface EvidenceGrade {
  readonly grade: EvidenceGradeValue;
  readonly reason: EvidenceReason;
  /**
   * MEASURED answered count — null when unmeasured (no read, a failed read, no
   * plan, or any pre-0086 NULL disposition). Persisted as `evidence_answered`.
   * A null here can never satisfy {@link canAutoReject}.
   */
  readonly answered: number | null;
  /** The plan's question count, or null. Persisted as `evidence_planned`. */
  readonly planned: number | null;
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * How many questions were answered, and whether that number is MEASURED.
 * "NULL dispositions: use the row count, and answered counts as unmeasured" —
 * a pre-0086 row cannot say whether its question was answered or declined, so
 * the row count is the best grading estimate but never a reject basis.
 */
function answeredOf(m: EvidenceMeasurement): { count: number; measured: boolean } {
  const rows = nonNegInt(m.progressRows);
  if (nonNegInt(m.nullDispositionRows) > 0) return { count: rows, measured: false };
  return { count: Math.min(nonNegInt(m.answeredRows), rows), measured: true };
}

/**
 * Grade one assessment revision. Rule order is load-bearing (RESEARCH C3 fix 1):
 *   1. browser                         -> decision / complete_call (no reads);
 *   2. 0 candidate non-gate turns      -> insufficient / infra_interrupted
 *                                         (worker_crash) | no_candidate_speech;
 *   3. phone, not partial              -> decision / complete_call — the grade
 *                                         needs no read; the counts, when the
 *                                         read succeeded, still ride along for
 *                                         the reject rule;
 *   4. partial, read failed            -> insufficient / evidence_read_failed;
 *   5. partial, no plan                -> insufficient / no_plan;
 *   6. answered*4 >= planned*3         -> decision / partial_sufficient;
 *   7. otherwise                       -> insufficient / infra_interrupted
 *                                         (worker_crash) | partial_thin.
 */
export function gradeEvidence(input: GradeEvidenceInput): EvidenceGrade {
  if (input.source !== 'phone') {
    return { grade: 'decision', reason: 'complete_call', answered: null, planned: null };
  }
  const infra = input.disconnectReason === INFRA_DISCONNECT_REASON;
  const m = input.measurement;
  const measured = m !== null && m !== 'read_failed' ? m : null;
  const planned = measured && typeof measured.planned === 'number' && measured.planned > 0
    ? Math.floor(measured.planned)
    : null;
  const answer = measured && planned !== null ? answeredOf(measured) : null;
  const answered = answer && answer.measured ? answer.count : null;

  if (nonNegInt(input.candidateTurns) === 0) {
    return {
      grade: 'insufficient',
      reason: infra ? 'infra_interrupted' : 'no_candidate_speech',
      answered,
      planned,
    };
  }
  if (!input.partial) {
    return { grade: 'decision', reason: 'complete_call', answered, planned };
  }
  if (m === 'read_failed' || m === null) {
    return { grade: 'insufficient', reason: 'evidence_read_failed', answered: null, planned: null };
  }
  if (planned === null || answer === null) {
    return { grade: 'insufficient', reason: 'no_plan', answered: null, planned: null };
  }
  if (answer.count * PARTIAL_DECISION.den >= planned * PARTIAL_DECISION.num) {
    return { grade: 'decision', reason: 'partial_sufficient', answered, planned };
  }
  return {
    grade: 'insufficient',
    reason: infra ? 'infra_interrupted' : 'partial_thin',
    answered,
    planned,
  };
}

export interface CanAutoRejectInput {
  readonly source: 'browser' | 'phone';
  /** The scorer's recommendation (v2 may be `human_review`). */
  readonly recommendation: string | null | undefined;
  /** v2 `scoring_status`; null/undefined for a v1 row (v1 is always complete). */
  readonly scoringStatus: string | null | undefined;
  readonly evidence: Pick<EvidenceGrade, 'grade' | 'answered' | 'planned'>;
}

/**
 * May this revision move the candidate to `rejected`?
 *   * the recommendation is `reject`;
 *   * scoring is complete (or v1, which has no partial-metric mode);
 *   * the evidence grade is `decision`;
 *   * browser: nothing more; phone: answered is MEASURED and
 *     answered*2 >= planned (AUTO_REJECT_MIN).
 *
 * Prod calibration (2026-10-03, 11 phone rows): e3a187ed (complete, 2/4) stays
 * rejected; 7f6bb294 (complete, 1/4) and a744741c (partial, 0/4) do not.
 */
export function canAutoReject(input: CanAutoRejectInput): boolean {
  if (input.recommendation !== 'reject') return false;
  if (input.scoringStatus != null && input.scoringStatus !== 'complete') return false;
  if (input.evidence.grade !== 'decision') return false;
  if (input.source !== 'phone') return true;
  const { answered, planned } = input.evidence;
  if (typeof answered !== 'number' || typeof planned !== 'number' || planned <= 0) return false;
  return answered * AUTO_REJECT_MIN.den >= planned * AUTO_REJECT_MIN.num;
}

/** Narrow a persisted value to a grade; anything else (incl. NULL) is null. */
export function parseEvidenceGrade(value: unknown): EvidenceGradeValue | null {
  return value === 'decision' || value === 'insufficient' ? value : null;
}

/** Narrow a persisted value to a reason; anything else is null. */
export function parseEvidenceReason(value: unknown): EvidenceReason | null {
  return typeof value === 'string' && (EVIDENCE_REASONS as readonly string[]).includes(value)
    ? (value as EvidenceReason)
    : null;
}

/** The four persisted columns, as the insert payload carries them. */
export function evidenceColumns(grade: EvidenceGrade): Record<string, unknown> {
  return {
    evidence_grade: grade.grade,
    evidence_reason: grade.reason,
    evidence_answered: grade.answered,
    evidence_planned: grade.planned,
  };
}

/** The four persisted column names (stale-schema insert fallback strips these). */
export const EVIDENCE_COLUMN_NAMES = [
  'evidence_grade',
  'evidence_reason',
  'evidence_answered',
  'evidence_planned',
] as const;

/**
 * Is this PostgREST/Postgres error "the evidence column does not exist yet"?
 * 42703 (undefined_column) on a select, PGRST204 (schema-cache miss) on an
 * insert/update. Anything else is a real failure and must propagate.
 */
export function isMissingColumnError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

/** Minimal client surface — the service-role singleton satisfies it. */
export interface EvidenceReadClient {
  from(table: string): any;
}

/**
 * TOLERANT separate read of one row's `evidence_grade`.
 *
 * Deliberately NOT part of `SCORECARD_ASSESSMENT_COLUMNS`: that list feeds both
 * scorecard build sites and the marker, and a stale schema (0114 not applied,
 * or a stale PostgREST cache) must never break enqueue or execute. A missing
 * column reads as null, which callers treat as `decision` (pre-0114 behaviour).
 * Any other error throws `assessment_evidence_read_error` — callers fail
 * closed.
 */
export async function readAssessmentEvidenceGrade(
  client: EvidenceReadClient,
  assessmentId: string,
): Promise<EvidenceGradeValue | null> {
  const { data, error } = await client
    .from('assessments')
    .select('evidence_grade')
    .eq('id', assessmentId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return null;
    throw new Error('assessment_evidence_read_error');
  }
  return parseEvidenceGrade((data as { evidence_grade?: unknown } | null)?.evidence_grade);
}
