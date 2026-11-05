/**
 * The read behind `GET /api/interview-rounds/:id/review`: one R1 round as a reviewer sees it.
 *
 * WHO MAY READ. The rule of the R1 video (`recording/access.ts`), which owner decision 2026-11-05
 * extends to R1 transcripts: admin and viewer any candidate, an interviewer only a candidate they
 * own. This is the one place a viewer can read an R1 transcript; the phone transcript route stays
 * admin-only.
 *
 * WHAT NEVER LEAVES. Every read names its columns and every field below is projected, so nothing
 * secret reaches the answer by accident: no key, URL, ETag, digest, room name or consent proof, no
 * contact detail (`parsed` also holds the phone number), no scorer instruction, and from an
 * assessment's `raw` only the gate, administration and agreement facts. `raw.runs` holds model
 * output and stays behind.
 *
 * WHAT IS WITHHELD. While an appeal blocks decision use, the result fields are nulled as the rounds
 * list does and the assessment is not read at all: the interview itself stays, a score does not.
 *
 * AFTER CONSENT IS WITHDRAWN. An attempt made at or before the latest withdrawal or decline, the
 * erase rule's own test (`recording/erase.ts`), has its transcript hidden and its recording shown as
 * deleted for that reason, even in the moments before the erase job has run. Its transcript is not
 * read, and evidence quotes and rationales are dropped from the assessment: a quote is the transcript
 * by another route, and a rationale cites what the candidate said (`r1-prompt.ts`), up to 900 characters
 * a metric. A consent merely superseded by a newer notice is not a withdrawal.
 *
 * WHILE AN INTERVIEW RUNS. There is nothing to review yet, so a live attempt's transcript is not read:
 * `in_progress` says why it is empty.
 *
 * FAILURE. A read this page depends on fails the whole answer (503): a partial page could say "no
 * recording" or "not scored" about something that exists. Only the role title and the one line of
 * phone context are optional.
 *
 * SCALE. Everything here is one round or one candidate. Reads are keyed by the round or the session,
 * and the log by the session on purpose: its only index is (session_id, created_at), and it grows with
 * every interview in the workspace. The transcript and the log page past PostgREST's row cap.
 *
 * ATTEMPTS come back in the order they started. A restart keeps the number of the attempt it replaces
 * (0119), so `attempt_number` alone neither orders them nor tells them apart: `session_id` does that.
 */

import type { R1DbClient } from '../../services/r1-assessment.js';
import { readAllPages, type PageResult } from '../id-batches.js';
import { validateEpochMsAnchor } from '../recording-egress.js';
import { seesEveryCandidate, type R1StaffActor } from './recording/access.js';
import { withdrawalCutoffs } from './recording/erase.js';
import { RECORDINGS_TABLE, type R1RecordingRow } from './recording/service.js';
import { SUMMARY_COLUMNS, summarizeRecording, type R1RecordingSummary } from './recording/summary.js';
import { parseEvidenceRef } from './evidence.js';
import { r1LearnerName, r1PersonaLabel } from './personas.js';
import { R1_METRICS } from './rubric.js';

/** The notice a staff dry run was consented under (0120). */
const STAFF_LOCALE = 'en-IN-x-staff';

/** The most pages of one transcript or one log: far past any real interview, and never truncated. */
const MAX_PAGES = 5;

/** The session states of an interview that has not ended (0115). */
const LIVE_SESSION_STATES: ReadonlySet<unknown> = new Set(['created', 'waiting', 'in_progress']);

const ROUND_COLUMNS =
  'id,candidate_id,status,expires_at,attempts_allowed,attempts_counted,recommendation,overall,assessment_id,'
  + 'status_write,pending_reject_until,consent_locale,created_at,created_by';
const CANDIDATE_COLUMNS = 'id,owner_id,name,role_id,skills,experience_years,parsed,decision_use_blocked_at';
const ATTEMPT_COLUMNS = 'session_id,attempt_number,persona_id,counted,outcome,created_at';
const SESSION_COLUMNS = 'id,status,started_at,ended_at';
const TURN_COLUMNS = 'turn_index,speaker,text,turn_started_at_ms,turn_ended_at_ms,ai_voice,ai_played_ms,is_gate,phase,interrupted';
const ASSESSMENT_COLUMNS =
  'id,session_id,recommendation,overall_score,scoring_status,score_scale_max,metric_results,raw,created_at';
const LOG_COLUMNS = 'id,session_id,event_type,turn_index,family_id,payload,created_at';

type Row = Record<string, unknown>;

export interface R1ReviewTurn {
  turn_index: number;
  speaker: string;
  text: string;
  turn_started_at_ms: number | null;
  /** 0136. Null on a phone or older turn, and whenever the end was not known. Not exact on a cut AI line. */
  turn_ended_at_ms: number | null;
  /** 0136. Which voice spoke an AI turn. Null when the worker could not tie it to one. */
  ai_voice: 'interviewer' | 'learner' | null;
  /** 0136. Audio played for an AI turn: never a way to work out its end. */
  ai_played_ms: number | null;
  is_gate: boolean;
  phase: string | null;
  interrupted: boolean;
}

export interface R1ReviewAttempt {
  session_id: string;
  attempt_number: number;
  counted: boolean;
  outcome: string | null;
  persona_id: string;
  persona_label: string | null;
  /** Null when no log row names the variant the worker used: the page says "AI learner". */
  learner_name: string | null;
  session_status: string | null;
  started_at: string | null;
  ended_at: string | null;
  consent_withdrawn: boolean;
  transcript_hidden: boolean;
  /** The interview has not ended: `turns` is empty until it has. */
  in_progress: boolean;
  recording: R1RecordingSummary;
  turns: R1ReviewTurn[];
}

export interface R1ReviewMetric {
  metric_id: string;
  name: string | null;
  weight_bps: number | null;
  score: number | null;
  evidence_status: string | null;
  rationale: string | null;
  evidence: Array<{ turn_index: number; quote: string }>;
}

export interface R1ReviewAssessment {
  id: string;
  session_id: string;
  recommendation: string | null;
  /** `raw.recommendation`: `human_review` is stored as NULL in the column. */
  raw_recommendation: string | null;
  overall_score: number | null;
  scoring_status: string | null;
  score_scale_max: number | null;
  created_at: string | null;
  metric_results: R1ReviewMetric[];
  r1: {
    outcome: string | null;
    valid: boolean | null;
    code: string | null;
    gate: unknown;
    administration_quality: unknown;
    agreement: unknown;
    thresholds: unknown;
  };
}

export interface R1ReviewEvent {
  session_id: string;
  event_type: string;
  turn_index: number | null;
  family_id: string | null;
  need: string | null;
  kind: string | null;
  created_at: string | null;
}

export interface R1ReviewBody {
  round: Record<string, unknown>;
  candidate: Record<string, unknown>;
  attempts: R1ReviewAttempt[];
  assessment: R1ReviewAssessment | null;
  events: R1ReviewEvent[];
  phone_screening: {
    recommendation: string | null;
    overall_score: number | null;
    created_at: string | null;
    /** `insufficient`: the score is held. A held row is no firm result. */
    evidence_grade: string | null;
    /** `incomplete_evidence`: the score is provisional. */
    scoring_status: string | null;
  } | null;
  rubric: Array<{ key: string; name: string; weight_bps: number; levels: Record<string, string> }>;
}

export type R1ReviewResult =
  | { kind: 'ok'; body: R1ReviewBody; scoresWithheld: boolean; consentWithdrawn: boolean }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' };

const UNAVAILABLE: R1ReviewResult = { kind: 'unavailable' };

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];

function roleFacts(value: unknown): Row | null {
  if (!isRecord(value)) return null;
  const facts: Row = {};
  for (const key of ['title', 'employer', 'period']) {
    const held = text(value[key]);
    if (held) facts[key] = held;
  }
  const highlights = texts(value.highlights);
  if (highlights.length > 0) facts.highlights = highlights;
  return Object.keys(facts).length > 0 ? facts : null;
}

/**
 * The facts a reviewer reads from a parsed resume, by name: `parsed` is the raw structurer output and
 * also holds the phone number and email. Null when nothing usable is there ("No resume on file").
 */
function resumeFacts(parsed: unknown): Row | null {
  if (!isRecord(parsed)) return null;
  const facts: Row = {};
  const summary = text(parsed.summary);
  if (summary) facts.summary = summary;
  const current = text(parsed.current_role);
  if (current) facts.current_role = current;
  const recent = roleFacts(parsed.recent_role);
  if (recent) facts.recent_role = recent;
  const prior = Array.isArray(parsed.prior_roles) ? parsed.prior_roles.map(roleFacts).filter((role) => role !== null) : [];
  if (prior.length > 0) facts.prior_roles = prior;
  for (const key of ['career_highlights', 'education', 'certifications']) {
    const list = texts(parsed[key]);
    if (list.length > 0) facts[key] = list;
  }
  return Object.keys(facts).length > 0 ? facts : null;
}

function evidenceOf(result: Row): Array<{ turn_index: number; quote: string }> {
  if (Array.isArray(result.evidence)) {
    return result.evidence.flatMap((item) => {
      if (!isRecord(item)) return [];
      const turn = num(item.turn_index);
      const quote = text(item.quote);
      return turn !== null && quote ? [{ turn_index: turn, quote }] : [];
    });
  }
  // A row written before `evidence` existed still has its references as "T12: quote".
  return texts(result.evidenceRefs).flatMap((ref) => {
    const parsed = parseEvidenceRef(ref);
    return parsed ? [{ turn_index: parsed.turnIndex, quote: parsed.quote }] : [];
  });
}

function metricOf(value: unknown, hideWords: boolean): R1ReviewMetric | null {
  if (!isRecord(value)) return null;
  const metric = isRecord(value.metric) ? value.metric : {};
  return {
    metric_id: text(value.configMetricId) ?? '',
    name: text(metric.name),
    weight_bps: num(metric.weightBps),
    score: num(value.score),
    evidence_status: text(value.evidenceStatus),
    rationale: hideWords ? null : text(value.rationale),
    evidence: hideWords ? [] : evidenceOf(value),
  };
}

function assessmentOf(row: Row, hideWords: boolean): R1ReviewAssessment {
  const raw = isRecord(row.raw) ? row.raw : {};
  const r1 = isRecord(raw.r1) ? raw.r1 : {};
  const results = Array.isArray(row.metric_results) ? row.metric_results : [];
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    recommendation: text(row.recommendation),
    raw_recommendation: text(raw.recommendation),
    overall_score: num(row.overall_score),
    scoring_status: text(row.scoring_status),
    score_scale_max: num(row.score_scale_max),
    created_at: text(row.created_at),
    metric_results: results.map((result) => metricOf(result, hideWords)).filter((metric) => metric !== null),
    r1: {
      outcome: text(r1.outcome),
      valid: typeof r1.valid === 'boolean' ? r1.valid : null,
      code: text(r1.code),
      gate: r1.gate ?? null,
      administration_quality: r1.administration_quality ?? null,
      agreement: r1.agreement ?? null,
      thresholds: r1.thresholds ?? null,
    },
  };
}

function eventOf(row: Row): R1ReviewEvent {
  const payload = isRecord(row.payload) ? row.payload : {};
  return {
    session_id: String(row.session_id),
    event_type: String(row.event_type),
    turn_index: num(row.turn_index),
    family_id: text(row.family_id),
    need: text(payload.need),
    kind: text(payload.kind),
    created_at: text(row.created_at),
  };
}

function turnOf(row: Row): R1ReviewTurn {
  return {
    turn_index: Number(row.turn_index),
    speaker: String(row.speaker),
    text: typeof row.text === 'string' ? row.text : '',
    turn_started_at_ms: num(row.turn_started_at_ms),
    turn_ended_at_ms: validateEpochMsAnchor(row.turn_ended_at_ms),
    ai_voice: row.ai_voice === 'interviewer' || row.ai_voice === 'learner' ? row.ai_voice : null,
    ai_played_ms: Number.isSafeInteger(row.ai_played_ms) && (row.ai_played_ms as number) >= 0 ? (row.ai_played_ms as number) : null,
    is_gate: row.is_gate === true,
    phase: text(row.phase),
    interrupted: row.interrupted === true,
  };
}

/** The variant the worker used for each session, from the pins on its log rows. */
function variantsBySession(rows: readonly Row[]): Map<string, string> {
  const variants = new Map<string, string>();
  for (const row of rows) {
    const pins = isRecord(row.payload) && isRecord(row.payload.pins) ? row.payload.pins : null;
    const variant = pins ? text(pins.persona_variant) : null;
    if (variant) variants.set(String(row.session_id), variant);
  }
  return variants;
}

/**
 * What consent withdrawal leaves of a summary. It reads as the summary of a recording being erased
 * does (`recordingState`): deleted, with no anchor and nothing to play. No recording stays no
 * recording, because nothing was deleted.
 */
function withdrawnSummary(summary: R1RecordingSummary): R1RecordingSummary {
  if (summary.state === 'none') return summary;
  return {
    state: 'deleted',
    reason: 'consent_withdrawn',
    mode: null,
    has_video: null,
    started_at_ms: null,
    duration_ms: null,
    camera_off_ms: null,
    degraded_at_ms: null,
    retention_until: null,
    deleted_at: summary.deleted_at,
  };
}

const RUBRIC = R1_METRICS.map((metric) => ({
  key: metric.key,
  name: metric.name,
  weight_bps: metric.weightBps,
  levels: { 1: metric.rubric[1], 2: metric.rubric[2], 3: metric.rubric[3], 4: metric.rubric[4] },
}));

/** The candidate's newest phone assessment, for one line of context. Optional: null when it cannot be read. */
async function phoneScreening(db: R1DbClient, candidateId: string): Promise<R1ReviewBody['phone_screening']> {
  try {
    const sessions = await db
      .from('call_sessions')
      .select('id')
      .eq('candidate_id', candidateId)
      .is('interview_round_id', null);
    if (sessions.error || !Array.isArray(sessions.data)) return null;
    const phoneSessionIds = (sessions.data as Row[]).map((session) => String(session.id));
    if (phoneSessionIds.length === 0) return null;
    const { data, error } = await db
      .from('assessments')
      .select('recommendation,overall_score,created_at,evidence_grade,scoring_status')
      .in('session_id', phoneSessionIds)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = !error && Array.isArray(data) ? (data[0] as Row | undefined) : undefined;
    if (!row) return null;
    return {
      recommendation: text(row.recommendation),
      overall_score: num(row.overall_score),
      created_at: text(row.created_at),
      evidence_grade: text(row.evidence_grade),
      scoring_status: text(row.scoring_status),
    };
  } catch {
    return null;
  }
}

/** Never rejects: Express 4 does not catch a rejection from an async route handler. */
export async function readR1Review(
  db: R1DbClient,
  actor: R1StaffActor,
  roundId: string,
  nowMs: number = Date.now(),
): Promise<R1ReviewResult> {
  if (!actor.active) return { kind: 'forbidden' };
  try {
    const roundRead = await db.from('interview_rounds').select(ROUND_COLUMNS).eq('id', roundId).maybeSingle();
    if (roundRead.error) return UNAVAILABLE;
    const round = roundRead.data as Row | null;
    // As the playback mint: someone who cannot see every candidate learns nothing from a missing id.
    if (!round) return { kind: seesEveryCandidate(actor) ? 'not_found' : 'forbidden' };

    const candidateId = String(round.candidate_id);
    const candidateRead = await db.from('candidates').select(CANDIDATE_COLUMNS).eq('id', candidateId).maybeSingle();
    if (candidateRead.error) return UNAVAILABLE;
    const candidate = candidateRead.data as Row | null;
    if (!candidate) return { kind: seesEveryCandidate(actor) ? 'not_found' : 'forbidden' };
    if (!seesEveryCandidate(actor) && !(actor.appRole === 'interviewer' && candidate.owner_id === actor.id)) {
      return { kind: 'forbidden' };
    }

    // The stored spelling from here on: Postgres matches an id in any case, and `withdrawalCutoffs` is
    // keyed by what is stored, so the caller's spelling must never decide what counts as withdrawn.
    const storedRoundId = String(round.id);
    const [attemptsRead, recordingsRead, sessionsRead, cutoffs] = await Promise.all([
      db.from('interview_round_attempts').select(ATTEMPT_COLUMNS).eq('round_id', storedRoundId)
        .order('attempt_number', { ascending: true }).order('created_at', { ascending: true }),
      db.from(RECORDINGS_TABLE).select(SUMMARY_COLUMNS).eq('round_id', storedRoundId),
      db.from('call_sessions').select(SESSION_COLUMNS).eq('interview_round_id', storedRoundId),
      withdrawalCutoffs(db, [storedRoundId]),
    ]);
    if (attemptsRead.error || recordingsRead.error || sessionsRead.error) return UNAVAILABLE;

    const cutoff = cutoffs.get(storedRoundId);
    const withdrawnFor = (createdAt: unknown): boolean => {
      if (cutoff === undefined) return false;
      const at = Date.parse(String(createdAt));
      // A time that cannot be read is treated as covered: hiding is the safe direction.
      return !Number.isFinite(at) || at <= cutoff;
    };

    const sessions = new Map<string, Row>();
    for (const row of (Array.isArray(sessionsRead.data) ? sessionsRead.data : []) as Row[]) sessions.set(String(row.id), row);
    const liveFor = (sessionId: unknown): boolean => LIVE_SESSION_STATES.has(sessions.get(String(sessionId))?.status);

    const attemptRows = (Array.isArray(attemptsRead.data) ? attemptsRead.data : []) as Row[];
    const sessionIds = attemptRows.map((attempt) => String(attempt.session_id));
    const [logRead, turnsRead] = await Promise.all([
      sessionIds.length === 0
        ? { ok: true as const, rows: [] as Row[] }
        : readAllPages<Row>(
            (from, to) => db.from('r1_admin_log').select(LOG_COLUMNS).in('session_id', sessionIds)
              .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to) as unknown as PageResult,
            MAX_PAGES,
          ),
      Promise.all(attemptRows.map((attempt) =>
        withdrawnFor(attempt.created_at) || liveFor(attempt.session_id)
          ? null
          : readAllPages<Row>(
              (from, to) => db.from('transcript_turns').select(TURN_COLUMNS).eq('session_id', String(attempt.session_id))
                .order('turn_index', { ascending: true }).range(from, to) as unknown as PageResult,
              MAX_PAGES,
            ))),
    ]);
    if (!logRead.ok || turnsRead.some((read) => read !== null && !read.ok)) return UNAVAILABLE;

    const recordings = new Map<string, R1RecordingRow>();
    for (const row of (Array.isArray(recordingsRead.data) ? recordingsRead.data : []) as R1RecordingRow[]) {
      recordings.set(row.session_id, row);
    }
    const variants = variantsBySession(logRead.rows);

    const attempts = attemptRows.map((row, index): R1ReviewAttempt => {
      const sessionId = String(row.session_id);
      const personaId = String(row.persona_id);
      const session = sessions.get(sessionId);
      const withdrawn = withdrawnFor(row.created_at);
      const summary = summarizeRecording(recordings.get(sessionId) ?? null, nowMs);
      const read = turnsRead[index];
      return {
        session_id: sessionId,
        attempt_number: Number(row.attempt_number),
        counted: row.counted === true,
        outcome: text(row.outcome),
        persona_id: personaId,
        persona_label: r1PersonaLabel(personaId),
        learner_name: r1LearnerName(personaId, variants.get(sessionId) ?? null),
        session_status: text(session?.status),
        started_at: text(session?.started_at),
        ended_at: text(session?.ended_at),
        consent_withdrawn: withdrawn,
        transcript_hidden: withdrawn,
        in_progress: liveFor(sessionId),
        recording: withdrawn ? withdrawnSummary(summary) : summary,
        turns: read?.ok ? read.rows.map(turnOf) : [],
      };
    });

    const scoresWithheld = candidate.decision_use_blocked_at !== null && candidate.decision_use_blocked_at !== undefined;
    let assessment: R1ReviewAssessment | null = null;
    if (!scoresWithheld && typeof round.assessment_id === 'string') {
      const { data, error } = await db.from('assessments').select(ASSESSMENT_COLUMNS).eq('id', round.assessment_id).maybeSingle();
      if (error) return UNAVAILABLE;
      if (data) {
        const row = data as Row;
        const scored = attempts.find((attempt) => attempt.session_id === String(row.session_id));
        assessment = assessmentOf(row, scored?.transcript_hidden === true);
      }
    }

    const roleId = text(candidate.role_id);
    const [roleRead, phone] = await Promise.all([
      roleId ? db.from('roles').select('title').eq('id', roleId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      scoresWithheld ? Promise.resolve(null) : phoneScreening(db, candidateId),
    ]);

    return {
      kind: 'ok',
      scoresWithheld,
      consentWithdrawn: attempts.some((attempt) => attempt.consent_withdrawn),
      body: {
        round: {
          id: round.id,
          candidate_id: round.candidate_id,
          status: round.status,
          expires_at: round.expires_at,
          attempts_allowed: round.attempts_allowed,
          attempts_counted: round.attempts_counted,
          recommendation: scoresWithheld ? null : round.recommendation,
          overall: scoresWithheld ? null : num(round.overall),
          status_write: scoresWithheld ? null : round.status_write,
          pending_reject_until: scoresWithheld ? null : round.pending_reject_until,
          scores_withheld: scoresWithheld,
          is_staff_dry_run: round.consent_locale === STAFF_LOCALE,
          created_at: round.created_at,
          created_by: round.created_by,
        },
        candidate: {
          id: candidate.id,
          name: text(candidate.name),
          role_title: roleRead.error ? null : text((roleRead.data as Row | null)?.title),
          skills: texts(candidate.skills),
          experience_years: num(candidate.experience_years),
          resume: resumeFacts(candidate.parsed),
        },
        attempts,
        assessment,
        events: logRead.rows.map(eventOf),
        phone_screening: phone,
        rubric: RUBRIC,
      },
    };
  } catch {
    return UNAVAILABLE;
  }
}
