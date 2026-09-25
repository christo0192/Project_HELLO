// Domain types matching the backend API contract.

export interface ScreeningQuestion {
  id: string;
  question: string;
  weight: number;
  follow_up_hint?: string;
  /**
   * Rendered as `[MUST ASK] ` in the phone worker's prompt and prioritised
   * when a call runs against its ten-minute budget.
   *
   * The API schema has accepted this for as long as the worker has read it;
   * the web types simply never carried it, so the form silently dropped the
   * flag on every save.
   */
  mandatory?: boolean;
  /**
   * Which compartment of the screening call this question belongs to.
   *
   * Optional: every role authored before compartments existed has none, and an
   * uncategorised question is ungrouped rather than invalid.
   */
  category?: ScreeningCategory;
}

/** The compartments a screening call moves through, in call order. */
export type ScreeningCategory =
  | 'introduction'
  | 'profile_relevance'
  | 'shift_fit'
  | 'stability'
  | 'compensation';

/** What each compartment is called on screen, and what it is for. */
export const SCREENING_CATEGORY_LABELS: Record<ScreeningCategory, string> = {
  introduction: 'Introduction',
  profile_relevance: 'Profile relevance',
  shift_fit: 'Shift fit',
  stability: 'Stability',
  compensation: 'Compensation and notice',
};

/**
 * The short tag shown above each question row, in the slot that used to carry
 * the raw id.
 *
 * `q1`, `q2`, `q3` told a recruiter nothing — the ids are ours, minted by the
 * generator, and they say only where a question sits. What someone reviewing a
 * screen wants to know at a glance is which topic it came from, which is
 * exactly what the compartment already records.
 *
 * SHORTER THAN `SCREENING_CATEGORY_LABELS`, on purpose: this renders in an
 * 11px monospace tag, where "Compensation and notice" would wrap and
 * "profile_relevance" reads like a database column. The full label still heads
 * the compartment above; this is the per-row reminder.
 */
export const SCREENING_CATEGORY_TAGS: Record<ScreeningCategory, string> = {
  introduction: 'intro',
  profile_relevance: 'relevance',
  shift_fit: 'shift',
  stability: 'stability',
  compensation: 'pay',
};

/**
 * The tag for one question row: its topic when it has one, and otherwise the
 * id, which is all an older role has.
 *
 * Total over an unknown category for the same reason `sectionHeading` is: the
 * value arrives off the wire and the response is cast, not parsed, so a
 * compartment this build has not shipped must fall back rather than render
 * `undefined`.
 */
export function questionTag(
  category: ScreeningCategory | undefined,
  id: string,
  index: number,
): string {
  return (category && SCREENING_CATEGORY_TAGS[category]) || id || `q${index + 1}`;
}

/**
 * What a run of UNCATEGORISED questions is called, when it follows a
 * compartment.
 *
 * Pressing "Add question" on a compartmented role appends a row with no
 * category, and a role authored before compartments existed is nothing but
 * such rows. The first case needs a break — leaving the new question under
 * "Compensation and notice" would claim it belongs to a compartment it has
 * nothing to do with — and the second needs no heading at all, which is why
 * this is applied on the BOUNDARY rather than to every uncategorised row.
 */
export const UNCATEGORISED_SECTION_LABEL = 'Additional questions';

/**
 * The heading to show above a question, or null for "this row continues the
 * run above it".
 *
 * Total over every input, including a `category` this build does not know.
 * That case is real: the value arrives off the wire, and the response is CAST
 * rather than parsed, so TypeScript cannot see a compartment the API has added
 * and the form has not. Before this function the heading was gated on "the
 * category changed" and the text was looked up separately, so an unknown
 * compartment rendered an EMPTY `<h4>` — invisible on screen, an
 * `empty-heading` violation to a screen reader, and a lie about where the
 * boundary is.
 *
 * WHAT ACTUALLY PREVENTS THAT is returning null here and gating the heading on
 * the RETURN VALUE at the call site. The `?? null` below is type honesty
 * rather than a second guard — `SCREENING_CATEGORY_LABELS` is typed
 * `Record<ScreeningCategory, string>`, so without it this function would
 * promise `string | null` and hand back `undefined`. Removing it changes no
 * rendered output, and saying otherwise would be the kind of comment this
 * repository has been bitten by.
 */
export function sectionHeading(
  category: ScreeningCategory | undefined,
  priorCategory: ScreeningCategory | undefined,
): string | null {
  // Same run — including the all-uncategorised case, where both are undefined
  // on every row and the form stays ungrouped exactly as it was before
  // compartments existed.
  if (category === priorCategory) return null;
  if (category == null) return UNCATEGORISED_SECTION_LABEL;
  return SCREENING_CATEGORY_LABELS[category] ?? null;
}

export interface Role {
  id: string;
  title: string;
  /**
   * Operator-facing internal label for the screening agent (0100).
   *
   * NEVER spoken and never used for routing — `title` is the job the candidate
   * applied for and remains the only name the phone worker reads aloud.
   * Absent on payloads that predate the column.
   */
  agent_name?: string | null;
  jd: string;
  required_skills: string[];
  screening_template: ScreeningQuestion[];
  interviewer_instructions?: string;
  is_active: boolean;
  created_at: string;
}

/** Where an Ask Hello job currently is. */
export type RoleDraftProgress =
  | { phase: 'drafting'; attempt: number; maxAttempts: number }
  | { phase: 'checking'; attempt: number; maxAttempts: number }
  | { phase: 'repairing'; attempt: number; maxAttempts: number; rejected: number }
  | { phase: 'rereading'; attempt: number; maxAttempts: number };

/**
 * An Ask Hello job.
 *
 * A JOB, not a request: drafting runs v4-pro up to three times at 133-206s a
 * call, so the work outlives the HTTP call that starts it and a refresh picks
 * it back up.
 */
export interface RoleDraftJob {
  id: string;
  job_role: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: RoleDraftProgress | null;
  draft: RoleDraft | null;
  attempts: number;
  repaired: string[];
  error_reason: string | null;
  error_message: string | null;
  max_attempts: number;
  /**
   * When the job began.
   *
   * Read on resume so the elapsed counter reports the wait the operator has
   * actually had. Without it an adopted five-minute-old draft read "3s
   * elapsed" — worse than showing nothing, because it says the wait has
   * barely begun at the moment it is nearly over.
   */
  created_at: string | null;
}

export interface RoleDraft {
  jd: string;
  required_skills: string[];
  screening_template: ScreeningQuestion[];
}

export interface RoleDraftOutcome {
  draft: RoleDraft;
  attempts: number;
  /** Questions the model had to re-phrase to get past the phone gate. */
  repaired: string[];
}

/**
 * What removing a role actually did.
 *
 * Three outcomes, not one: a role nothing references is deleted, a role with
 * candidates or sessions is ARCHIVED so those records still say which job
 * they belonged to, and a role mapped to an Ashby job is refused outright.
 */
export interface RoleDeleteResult {
  outcome: 'deleted' | 'archived';
  reason?: string;
  candidates?: number;
  sessions?: number;
}

export interface RoleInput {
  title: string;
  agent_name?: string | null;
  jd: string;
  required_skills: string[];
  screening_template: ScreeningQuestion[];
  interviewer_instructions: string;
}

export type CandidateStatus = string;

/**
 * The ONE sanitized resume-review signal a candidate row may carry
 * (`GET /api/candidates`). Mirrors the API's `ResumeReview` union exactly.
 *
 * `null` for every non-Ashby candidate, and for an Ashby candidate whose
 * ingestion row cannot be read. Nothing else about the integration crosses
 * this boundary — no link id, no external id, no file handle, no failure
 * reason, no attempt counter.
 */
export type ResumeReview = 'ready' | 'processing' | 'needs_review' | 'cancelled';

export interface CandidateResumeFacts {
  current_role?: string | null;
  recent_role?: {
    title?: string | null;
    employer?: string | null;
    period?: string | null;
    highlights?: string[];
  } | null;
  prior_roles?: Array<{
    title?: string | null;
    employer?: string | null;
    period?: string | null;
    highlights?: string[];
  }>;
  career_highlights?: string[];
  education?: string[];
  certifications?: string[];
  summary?: string | null;
}

export interface Candidate {
  id: string;
  /**
   * Nullable, and truthfully so: `screening_v2.candidates.name` has no NOT
   * NULL constraint (0001) and a PII-minimal shell created at Ashby import
   * carries `null` here until its resume parses. Render it through
   * `candidateDisplayName` rather than inventing an identity.
   */
  name: string | null;
  email: string | null;
  phone_e164: string | null;
  phone_valid: boolean;
  skills: string[];
  experience_years: number | null;
  status: CandidateStatus;
  role_id: string | null;
  created_at: string;
  /** Latest assessment recommendation, null when unassessed or decision-use blocked. */
  latest_recommendation?: Recommendation | null;
  /** Latest assessment overall score (0–100), null when unassessed or blocked. */
  latest_score?: number | null;
  /**
   * Sanitized resume-review state from the list endpoint. Absent on payloads
   * that predate the field; null when the candidate has no Ashby ingestion.
   */
  resume_review?: ResumeReview | null;
  /** Bounded parsed resume evidence returned on candidate detail. */
  parsed?: CandidateResumeFacts | null;
}

/** Aggregate pipeline assessment metrics (GET /api/candidates/summary). */
export interface CandidatesSummary {
  /** Candidates with a non-suppressed latest assessment score. */
  assessed_count: number;
  /** Mean latest score across the assessed cohort; null when none. */
  average_score: number | null;
  /** Deterministic per-recommendation counts (decision-use blocked excluded). */
  recommendation_distribution: {
    advance: number;
    hold: number;
    reject: number;
  };
}

export interface Resume {
  id: string;
  candidate_id: string;
  created_at: string;
}

export interface PhoneInfo {
  raw: string;
  e164: string;
  valid: boolean;
}

export interface UploadResumeResult {
  candidate: Candidate;
  resume: Resume;
  phone: PhoneInfo;
}

export interface Session {
  id: string;
  candidate_id: string;
  role_id: string | null;
  status: string;
  done?: boolean;
  mode?: string;                 // "browser" (web voice) | "live" (telephony) | "simulation"
  /** @deprecated MIG-03/04/05 — use getRecordingDownloadUrl() for on-demand signed URL. */
  recording_url?: string | null;
  duration_sec?: number | null;
  /** Session creation instant (ISO). Persisted column; null only for unrecoverable legacy rows. */
  created_at: string | null;
  /** Call start instant (ISO). NOT NULL in storage; may be absent on older payloads. */
  started_at?: string | null;
  /** Call end instant (ISO), null while in progress. */
  ended_at?: string | null;
  /**
   * Words the CANDIDATE said in this session, from the transcript.
   *
   * Not talk time — no per-speaker duration is stored anywhere — but a real
   * engagement signal, and one `duration_sec` cannot give: a call whose bot
   * turns were all barged-in and truncated has a long wall clock and very few
   * candidate words. Absent on payloads that predate this field.
   *
   * NULL when no transcript was read for the session — which is not the same
   * claim as 0. Zero says the candidate said nothing; null says we do not
   * know, and the badge is then absent rather than accusing them of silence.
   */
  candidate_words?: number | null;
}

export type Speaker = "bot" | "candidate";

export interface TranscriptLine {
  speaker: Speaker;
  text: string;
  /** Seconds from the authoritative recording start. null when timing data is unavailable (legacy, simulation). */
  start_offset_sec?: number | null;
}

export interface EnglishScore {
  band: string;
  grammar: number;
  vocabulary: number;
  fluency: number;
  coherence: number;
  notes: string;
}

export interface SpeechPatternSignal {
  level: "none" | "low" | "moderate" | "high";
  examples: string[];
  impact_score: number;
  notes: string;
}

export interface ToneScore {
  clarity: number;
  confidence: number;
  professionalism: number;
  sentiment: string;
  notes: string;
}

export interface RoleFitScore {
  score: number;
  matched_skills: string[];
  gaps: string[];
  red_flags: string[];
  notes: string;
}

export type Recommendation = "advance" | "hold" | "reject";

export interface ResumeConflict {
  topic: string;
  resume_says: string;
  candidate_said: string;
  resolved: boolean;
  note: string;
}

export interface SimpleScore {
  score: number;
  notes: string;
}

export interface CommunicationScore extends SimpleScore {
  clarity?: number;
  structure?: number;
  listening?: number;
  rapport?: number;
  english_proficiency?: EnglishScore;
  filler_usage?: Omit<SpeechPatternSignal, "level"> & {
    level: "low" | "moderate" | "high";
  };
  native_language_usage?: SpeechPatternSignal;
}

export interface Assessment {
  id?: string;
  english?: EnglishScore;
  tone: ToneScore;
  communication?: CommunicationScore;
  motivation?: SimpleScore;
  role_fit: RoleFitScore;
  resume_conflicts?: ResumeConflict[];
  overall_score: number;
  recommendation: Recommendation;
  summary: string;
  raw?: Partial<Assessment> | null;
  /**
   * Assessment schema version (scorecard rework Phase 1+). Absent or `1` is a
   * legacy dimension assessment — THIS shape, with `tone`/`role_fit`/… — and is
   * rendered by the existing legacy view unchanged. `2` is a role-scorecard v2
   * row whose v1 dimension fields are NOT populated on the wire; never read them
   * on a v2 row. Branch with `isAssessmentV2` / `readScorecardAssessmentV2`
   * below, which read the rich v2 payload out of `raw` (see contracts.ts).
   *
   * These extra columns ride along on the same `assessments` rows the API
   * projects with `select('*')`, so they are optional on the shared type
   * rather than a separate carrier — no existing v1 consumer is disturbed.
   */
  schema_version?: 1 | 2;
  scorecard_version_id?: string | null;
  revision?: number;
  scoring_status?: ScorecardAssessmentStatus;
  weighted_score_5?: number | null;
  /** Rubric scale the row was scored on (4 since the four-level rubric; 5 before). Absent on older API payloads. */
  score_scale_max?: ScoreScaleMax | null;
  metric_results?: ScorecardMetricModelResult[];
}

// ── Scorecards (Phase 3 web UI) ──────────────────────────────────────────
//
// Mirrors app/api/src/lib/scorecards/contracts.ts. Two wire conventions coexist
// and are mirrored FAITHFULLY here rather than idealised:
//   - the metric LIBRARY endpoints (GET/POST/PATCH/archive /metrics) return raw
//     snake_case DB rows (and GET returns a BARE array, not `{ metrics }`);
//   - the ROLE scorecard endpoints return camelCase domain objects.

export const SCORECARD_WEIGHT_TOTAL_BPS = 10000 as const;
export const SCORECARD_MAX_METRICS = 20 as const;
export const SCORECARD_MAX_NAME_LENGTH = 100 as const;
export const SCORECARD_MAX_INSTRUCTION_LENGTH = 1000 as const;
export const SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH = 500 as const;

/**
 * Rubric scale — FOUR levels since 2026-09-10 (owner decision; mirrors
 * contracts.ts SCORE_MIN/SCORE_MAX/SCORE_LABELS). Ashby `Score` fields are
 * four-point, so the dashboard rubric uses the same four levels. Assessments
 * scored before the change are NOT rescored: they carry `scoreScaleMax = 5`
 * and are displayed on their own scale with {@link LEGACY_SCORE_LABELS_5}.
 */
export const SCORE_MIN = 1 as const;
export const SCORE_MAX = 4 as const;

/** Every scale a persisted assessment may carry (`assessments.score_scale_max`). */
export type ScoreScaleMax = 4 | 5;

/** 1..4 rubric level labels — Poor → Excellent (contracts.ts SCORE_LABELS). */
export const SCORE_LABELS = {
  1: 'Poor',
  2: 'Average',
  3: 'Good',
  4: 'Excellent',
} as const;

/** Labels of the retired five-level scale, for DISPLAY of pre-migration assessments only. */
export const LEGACY_SCORE_LABELS_5 = {
  1: 'Poor',
  2: 'Below average',
  3: 'Average',
  4: 'Good',
  5: 'Excellent',
} as const;

/** A rubric level on the CURRENT (four-level) scale — what the library/role editors author. */
export type ScoreValue = 1 | 2 | 3 | 4;
export type ScorecardRubric = Record<ScoreValue, string>;
/**
 * A metric score as PERSISTED on an assessment row — on that row's own scale,
 * so `5` is valid for a historical `scoreScaleMax = 5` row. Deliberately wider
 * than {@link ScoreValue}: the read path must render old rows truthfully, never
 * narrow or re-bucket them.
 */
export type PersistedScoreValue = 1 | 2 | 3 | 4 | 5;

export function isScoreScaleMax(value: unknown): value is ScoreScaleMax {
  return value === 4 || value === 5;
}

/** The label for a persisted metric score on the scale it was scored on. */
export function scoreLabel(score: number, scaleMax: ScoreScaleMax): string {
  const labels: Record<number, string> = scaleMax === 5 ? LEGACY_SCORE_LABELS_5 : SCORE_LABELS;
  return labels[score] ?? String(score);
}
export type MetricEvidenceStatus = 'scored' | 'insufficient_evidence';
export type ScorecardAssessmentStatus = 'complete' | 'incomplete_evidence';
export type ScorecardRecommendation = 'advance' | 'hold' | 'reject' | 'human_review';

/** Global metric library template — the wire is the snake_case DB row. */
export interface ScorecardMetricTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  default_instruction: string;
  rubric: ScorecardRubric;
  archived_at: string | null;
  version: number;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
}

export interface ScorecardMetricCreateInput {
  /** Optional — the API derives a stable key from `name` when omitted. */
  key?: string;
  name: string;
  description?: string | null;
  default_instruction: string;
  rubric: ScorecardRubric;
}

export interface ScorecardMetricUpdateInput {
  name?: string;
  description?: string | null;
  default_instruction?: string;
  rubric?: ScorecardRubric;
}

/** Immutable per-role metric snapshot (camelCase, as the role API returns it). */
export interface RoleScorecardMetric {
  id: string;
  libraryMetricId: string;
  key: string;
  name: string;
  instruction: string;
  rubric: ScorecardRubric;
  weightBps: number;
  displayOrder: number;
}

export interface RoleScorecardVersion {
  id: string;
  roleId: string;
  version: number;
  configurationHash: string;
  metrics: RoleScorecardMetric[];
}

export interface RoleScorecardResponse {
  scorecard: RoleScorecardVersion | null;
}

/** One desired metric in a PUT body. name/key/rubric are snapshotted server-side. */
export interface PutRoleScorecardMetricInput {
  libraryMetricId: string;
  instruction?: string;
  weightBps: number;
  displayOrder?: number;
}

export interface PutRoleScorecardInput {
  metrics: PutRoleScorecardMetricInput[];
}

export interface RedistributeWeightsInput {
  metrics: RoleScorecardMetric[];
  editedMetricId: string;
  newWeightBps: number;
}

export interface RedistributeWeightsResponse {
  metrics: RoleScorecardMetric[];
}

/** Model output per metric — the top-level `metric_results` column shape. */
export interface ScorecardMetricModelResult {
  configMetricId: string;
  /** On the row's own scale (`scoreScaleMax`) — see {@link PersistedScoreValue}. */
  score: PersistedScoreValue | null;
  evidenceStatus: MetricEvidenceStatus;
  rationale: string;
  evidenceRefs: string[];
}

/** A model result joined to its immutable metric snapshot (from `raw`). */
export interface ScorecardMetricResult extends ScorecardMetricModelResult {
  metric: RoleScorecardMetric;
}

/** The full v2 assessment object carried in the row's `raw` field. */
export interface ScorecardAssessmentV2 {
  schemaVersion: 2;
  scorecardVersionId: string;
  revision: number;
  status: ScorecardAssessmentStatus;
  metricResults: ScorecardMetricResult[];
  /**
   * The rubric scale this assessment was scored on. `4` since the four-level
   * rubric; a `raw` object persisted before that LACKS the field and readers
   * treat it as `5` (see `readScorecardAssessmentV2`). `weightedScore5` keeps
   * its historical name; its range is 1..scoreScaleMax.
   */
  scoreScaleMax: ScoreScaleMax;
  weightedScore5: number | null;
  overallScore: number | null;
  recommendation: ScorecardRecommendation;
}

/** `raw` as it may actually sit on a persisted row: pre-migration objects have no `scoreScaleMax`. */
export type ScorecardAssessmentV2Raw = Omit<ScorecardAssessmentV2, 'scoreScaleMax'> & {
  scoreScaleMax?: ScoreScaleMax;
};

/** Flattened, display-ready per-metric result (what the candidate v2 view needs). */
export interface ScorecardMetricDisplay {
  id: string;
  name: string;
  /** On the assessment's own scale (`ScorecardAssessmentDisplay.scoreScaleMax`). */
  score: PersistedScoreValue | null;
  evidenceStatus: MetricEvidenceStatus;
  rationale: string;
  evidenceRefs: string[];
  /** From the metric snapshot when available; null on a `raw`-less fallback. */
  weightBps: number | null;
}

/** Normalised v2 read model the candidate scorecard renders. */
export interface ScorecardAssessmentDisplay {
  status: ScorecardAssessmentStatus;
  /** Scale every metric score and `weightedScore5` on this card are read against (4 or 5). */
  scoreScaleMax: ScoreScaleMax;
  weightedScore5: number | null;
  overallScore: number | null;
  recommendation: ScorecardRecommendation;
  metrics: ScorecardMetricDisplay[];
}

/**
 * True when an assessment row is a role-scorecard v2 row (schema_version == 2).
 * Uses `Number(...)` so a stringy `'2'` on the wire still routes to the v2
 * display — matching export.ts and the Ashby adapter, which both coerce with
 * `Number(schema_version) === 2`.
 */
export function isAssessmentV2(a: Assessment | null | undefined): boolean {
  return !!a && Number((a as { schema_version?: number | string }).schema_version) === 2;
}

/**
 * Normalise a v2 assessment row into a flat display model, or `null` when the
 * row is not v2. Prefers the rich `raw` object (it carries each metric's name
 * and weight); falls back to the top-level columns (metric names then read as
 * their opaque ids) so a `raw`-less row still renders truthfully rather than
 * throwing. Never invents v1 fields.
 */
export function readScorecardAssessmentV2(
  a: Assessment | null | undefined,
): ScorecardAssessmentDisplay | null {
  if (!isAssessmentV2(a)) return null;
  const row = a as unknown as {
    scoring_status?: ScorecardAssessmentStatus;
    weighted_score_5?: number | null;
    score_scale_max?: number | null;
    overall_score?: number | null;
    recommendation?: ScorecardRecommendation | null;
    metric_results?: ScorecardMetricModelResult[];
    raw?: ScorecardAssessmentV2Raw | null;
  };
  const raw =
    row.raw && Array.isArray(row.raw.metricResults) ? row.raw : null;

  // Scale resolution: the raw object (new rows) → the DB column (new reads of
  // older rows) → 5. A row with neither predates the four-level rubric and was
  // scored 1–5; it is displayed on that scale, never re-bucketed.
  const scaleCandidate = raw?.scoreScaleMax ?? row.score_scale_max ?? 5;
  const scoreScaleMax: ScoreScaleMax = isScoreScaleMax(scaleCandidate) ? scaleCandidate : 5;

  const metrics: ScorecardMetricDisplay[] = raw
    ? raw.metricResults.map((r) => ({
        id: r.configMetricId ?? r.metric?.id ?? '',
        name: r.metric?.name ?? r.configMetricId ?? 'Metric',
        score: r.score,
        evidenceStatus: r.evidenceStatus,
        rationale: r.rationale ?? '',
        evidenceRefs: Array.isArray(r.evidenceRefs) ? r.evidenceRefs : [],
        weightBps: typeof r.metric?.weightBps === 'number' ? r.metric.weightBps : null,
      }))
    : (row.metric_results ?? []).map((r) => ({
        id: r.configMetricId,
        name: r.configMetricId,
        score: r.score,
        evidenceStatus: r.evidenceStatus,
        rationale: r.rationale ?? '',
        evidenceRefs: Array.isArray(r.evidenceRefs) ? r.evidenceRefs : [],
        weightBps: null,
      }));

  return {
    status: raw?.status ?? row.scoring_status ?? 'incomplete_evidence',
    scoreScaleMax,
    weightedScore5: raw?.weightedScore5 ?? row.weighted_score_5 ?? null,
    overallScore: raw?.overallScore ?? row.overall_score ?? null,
    recommendation:
      (raw?.recommendation ?? row.recommendation ?? 'human_review') as ScorecardRecommendation,
    metrics,
  };
}

export interface CandidateDetail {
  candidate: Candidate & { decision_use_blocked_at?: string | null };
  sessions: Session[];
  assessments: Assessment[];
}

export interface StartScreeningResult {
  session_id: string;
  message: string;
  done: boolean;
}

export interface StartLiveKitResult {
  session_id: string;
  room_name: string;
  url: string;
}

export interface CandidateInviteResult {
  token: string;
  expires_at: string;
}

export interface CandidateInviteExchangeResult {
  grant_token: string;
  url: string;
  room_name: string;
  session_id: string;
  expires_at: string;
  livekit_token: string;
}

/**
 * On-demand orchestration (design §2.3b B-i): when the browser worker pool is
 * scaled to zero and no ready worker could be confirmed for this session, the
 * exchange returns 202 `{status:'preparing'}` instead of a join token. The
 * candidate is shown "Preparing your interview…" and retries; the one-time
 * invite is NOT consumed, so a retry is meaningful. When orchestration is off
 * (default) this shape never occurs and the exchange always returns the full
 * `CandidateInviteExchangeResult`.
 */
export interface CandidateInvitePreparingResult {
  status: 'preparing';
}

export type CandidateInviteExchangeResponse =
  | CandidateInviteExchangeResult
  | CandidateInvitePreparingResult;

/** Narrow the exchange response to the preparing (no-token) branch. */
export function isPreparingExchange(
  r: CandidateInviteExchangeResponse,
): r is CandidateInvitePreparingResult {
  return (r as CandidateInvitePreparingResult).status === 'preparing';
}

export interface TurnResult {
  message: string;
  done: boolean;
  assessment: Assessment | null;
}

export interface SessionDetail {
  session: Session;
  transcript: TranscriptLine[];
  assessment: Assessment | null;
}

export interface RecordingDownloadResponse {
  /** Short-lived signed URL for the recording. Must not be cached/stored. */
  url: string;
}

export interface HealthResult {
  ok: boolean;
}

// ── Phase 9: status / me / admin / notes / consent / appeals ────────

export interface PublicStatus {
  status: 'ok' | 'maintenance' | 'degraded';
  maintenance: {
    enabled: boolean;
    reason: string | null;
    updated_at: string | null;
  } | null;
  updated_at: string;
}

export type MembershipRole = 'admin' | 'interviewer' | 'viewer';

export interface MeResponse {
  userId: string;
  email: string | null;
  role: MembershipRole;
  active: boolean;
}

// ── Phase 9: candidate pre-join consent (invite-opaque) ─────────────

export interface CandidateConsentStatusInput {
  invite_token: string;
}

export interface CandidateConsentStatus {
  has_consent: boolean;
  template_version: string | null;
  locale: string | null;
  required_consents: string[];
  role_title?: string;
}

export interface CandidateConsentItem {
  type: string;
  label: string;
  description?: string;
}

export interface CandidateConsentTemplate {
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: string[];
  summary?: string;
  consent_items?: CandidateConsentItem[];
}

export interface CandidatePreflightResult {
  url: string;
  livekit_token: string;
  expires_at: string;
  policy_version: 'voice-v1';
}

export interface CandidateConsentSubmitInput {
  invite_token: string;
  template_version: string;
  locale: string;
  consents: string[];
  status: 'granted' | 'declined';
}

export interface CandidateConsentSubmitResponse {
  id: string;
  status: 'granted' | 'declined';
  consents: string[];
  template_version: string;
  locale: string;
  created_at: string;
}

// ── Phase 9: recruiter notes + status transitions ───────────────────

export interface Note {
  id: string;
  candidate_id: string;
  author_id: string;
  note: string;
  created_at: string;
}

export interface NoteListResponse {
  notes: Note[];
}

export interface StatusTransitionResponse {
  ok: boolean;
  from: string;
  to: string;
}

// ── Phase 9: notification intents ───────────────────────────────────

export interface NotificationIntent {
  id: string;
  kind: 'quota_warning' | 'assessment_ready' | 'appeal_resolved';
  candidate_id: string | null;
  consent_verified: boolean;
  created_at: string;
}

export interface NotificationIntentListResponse {
  intents: NotificationIntent[];
}

// ── Phase 9: appeals ────────────────────────────────────────────────

export interface AppealRow {
  id: string;
  candidate_id: string;
  session_id: string;
  assessment_id: string | null;
  category: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AppealListResponse {
  appeals: AppealRow[];
}

export interface AppealGrantResult {
  appeal_grant_token: string;
  expires_at: string;
}

export interface AppealCreateInput {
  appeal_grant_token: string;
  category: 'scoring' | 'recording' | 'accessibility' | 'other';
  description: string;
}

export interface AppealCreateResponse {
  ok: boolean;
  appeal_id: string;
}

export interface AppealReviewInput {
  to_status: 'under_review' | 'granted' | 'denied';
  notes?: string;
}

// ── Phase 9: admin ──────────────────────────────────────────────────

export interface AdminMember {
  user_id: string;
  role: MembershipRole;
  active: boolean;
}

export interface AdminMemberUpdateInput {
  role?: MembershipRole;
  active?: boolean;
}

export interface AdminMaintenanceInput {
  enabled: boolean;
  reason: string;
}

export interface AdminSessionOverrideInput {
  target_status: string;
  reason: string;
}

export interface AdminAuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  result: string;
  created_at: string;
}

export interface AdminAuditListResponse {
  audit: AdminAuditRow[];
}

// ── Funnel observability (0090 / PR2) ────────────────────────────────
export interface FunnelSummaryTotals {
  entered_parse: number;
  parsed_ok: number;
  needs_review: number;
  parse_failed: number;
  dialed: number;
  connected: number;
  consent_passed: number;
  consent_dropped: number;
  answered_ge1: number;
  scored: number;
  qualified: number;
  on_hold: number;
  disqualified: number;
  human_review: number;
  reached_reference_check: number;
  attempts_total: number;
  connects_total: number;
  total_call_seconds: number;
  /** HR disposition of bot-screened candidates (0098). */
  hr_qualified: number;
  hr_disqualified: number;
  /**
   * Bot-screened but still sitting in the AI screening stage — an HR BACKLOG,
   * never a rejection. Kept separate so the rejection rate is not a function
   * of how recently the bot ran.
   */
  hr_awaiting: number;
  /** Bot-screened but their Ashby stage cannot be observed (unconfigured
   *  mapping, unsynced stage, or no Ashby link). Never an HR rejection. */
  hr_unknown: number;
  /** Candidates in the window. Every other cohort field is a FILTERED count. */
  candidates_total: number;
}

export interface FunnelConversions {
  parse_to_dial: number | null;
  dial_to_connect: number | null;
  connect_to_consent: number | null;
  consent_to_answered: number | null;
  answered_to_scored: number | null;
  scored_to_qualified: number | null;
  qualified_to_reference_check: number | null;
  /**
   * Share of the candidates HR DECIDED on that HR advanced. Not "agreement":
   * it never compares HR's decision to the bot's recommendation.
   */
  hr_advance_rate: number | null;
}

/**
 * One day of the funnel series.
 *
 * `/api/funnel/summary` REMOVES fields from these rows: the latency percentiles
 * always, and the per-individual call counters on a day that resolves to a
 * single candidate. Typing them as required let a future chart read
 * `r.total_call_seconds`, compile clean, and plot `undefined`.
 */
export interface FunnelDailyRow extends Partial<FunnelSummaryTotals> {
  cohort_day: string;
  role_id: string | null;
  median_ttfc_sec: number | null;
  p95_ttfc_sec: number | null;
}

/** Facts the dashboard must be TOLD, never infer. See lib/funnel/summary.ts. */
export interface FunnelMeta {
  hr_tracking_configured: boolean;
  schema_current: boolean;
  /** Meaningful only when `rollup_freshness_known` is true. */
  rollup_refreshed_at: string | null;
  /** False when the freshness probe failed — "unknown", not "never ran". */
  rollup_freshness_known: boolean;
  refresh_window_days: number;
}

export interface FunnelSummaryResponse {
  range: { from: string; to: string };
  totals: FunnelSummaryTotals;
  conversions: FunnelConversions;
  series: FunnelDailyRow[];
  refreshed_at: string | null;
  meta?: FunnelMeta;
}

export interface FunnelFailureGroup {
  stage: string;
  code: string;
  count: number;
}

export interface FunnelFailureRow {
  stage: string;
  code: string;
  entity_id: string;
  occurred_at: string;
}

export interface FunnelFailuresResponse {
  groups: FunnelFailureGroup[];
  recent: FunnelFailureRow[];
  /** True when the window held more failures than the fetch cap, so the group counts undercount. */
  truncated: boolean;
  range: { from: string; to: string };
}

export interface FunnelCandidateRow {
  candidate_id: string;
  role_id: string | null;
  role_title: string | null;
  resume_role_class: string | null;
  intake_at: string;
  furthest_stage: string;
  drop_reason: string | null;
  missing_phone: boolean;
  dialed: boolean;
  connected: boolean;
  consent_passed: boolean;
  answered_questions: number;
  attempts_total: number;
  connects_total: number;
  recommendation: string | null;
  scoring_status: string | null;
  reached_reference_check: boolean;
}

export interface FunnelCandidatesResponse {
  candidates: FunnelCandidateRow[];
  limit: number;
  offset: number;
}

export interface FunnelRefreshResponse {
  ok: boolean;
  result: unknown;
}

export interface AdminSessionRow {
  id: string;
  candidate_id: string;
  role_id: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface AdminSessionListResponse {
  sessions: AdminSessionRow[];
}

export interface QuotaPolicy {
  id: string;
  scope: 'global' | 'candidate';
  scope_id: string | null;
  mode: 'simulation' | 'live';
  max_sessions: number | null;
  max_cost_units: number | null;
  cost_units_per_session: number | null;
  warning_percentage: number | null;
  period_days: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface QuotaPolicyListResponse {
  policies: QuotaPolicy[];
}

export interface QuotaPolicyInput {
  scope: 'global' | 'candidate';
  scope_id?: string | null;
  mode?: 'simulation' | 'live';
  max_sessions?: number | null;
  max_cost_units?: number | null;
  cost_units_per_session?: number | null;
  warning_percentage?: number | null;
  period_days?: number;
  enabled?: boolean;
}

export interface QuotaPolicyMutationResponse {
  ok: boolean;
  id: string;
  created?: boolean;
}

// ── Consent types (GOV-03/GOV-08/GOV-09/GOV-10) ─────────────────────

export type ConsentType =
  | 'ai_interview'
  | 'recording'
  | 'purpose'
  | 'data_processing'
  | 'retention'
  | 'rights'
  | 'job_application';

export type ConsentStatus = 'granted' | 'declined' | 'withdrawn';

export interface ConsentSubmitInput {
  candidate_id: string;
  version?: string;
  consents: ConsentType[];
  status?: ConsentStatus;
  proof?: {
    ip_address?: string;
    user_agent?: string;
    captured_at?: string;
    notice_version?: string;
    note?: string;
  };
  expires_at?: string;
}

export interface ConsentSubmitResponse {
  id: string;
  candidate_id: string;
  status: ConsentStatus;
  consents: ConsentType[];
  version: string;
  created_at: string;
}

export interface ConsentStatusResponse {
  candidate_id: string;
  has_consent: boolean;
  has_ai_consent: boolean;
  has_recording_consent: boolean;
  latest_consent: {
    id: string;
    status: ConsentStatus;
    consents: ConsentType[];
    version: string;
    created_at: string;
  } | null;
}

export interface ConsentCheckResponse {
  ok: boolean;
  missing: ConsentType[];
}

export interface ConsentTemplateResponse {
  id: string;
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: ConsentType[];
  is_active: boolean;
}

export interface ConsentWithdrawInput {
  candidate_id: string;
  consent_types?: ConsentType[];
  reason?: string;
}

export interface ConsentWithdrawResponse {
  id: string;
  status: ConsentStatus;
  updated_at: string;
}

// ── HELLO access allowlist (0016): normalized-email access gate ────────
// Lane 2 backend contract (GET/POST /api/admin/allowlist,
// PATCH /api/admin/allowlist/:id). Emails are the admin management
// surface only — they never appear in audit metadata or non-admin
// responses; normalization/validation is authoritative server-side.

export interface AdminAllowlistEntry {
  id: string;
  email: string;
  role: MembershipRole;
  active: boolean;
  linked_user_id: string | null;
  linked_at: string | null;
}

export interface AdminAllowlistListResponse {
  entries: AdminAllowlistEntry[];
}

export interface AdminAllowlistAddInput {
  email: string;
  role?: MembershipRole;
}

export interface AdminAllowlistAddResponse {
  ok: boolean;
  id: string | null;
}

export interface AdminAllowlistUpdateInput {
  role?: MembershipRole;
  active?: boolean;
}

export interface AdminAllowlistUpdateResponse {
  ok: boolean;
}

// ── Ashby Mission Control (sanitized; no PII/tokens) ─────────────────
export interface AshbyMcMapping {
  id: string;
  externalJobId: string;
  status: 'paused' | 'enabled' | 'drift';
  statusReason: string | null;
  deliveryMode: string;
  hasAiStage: boolean;
  hasTaStage: boolean;
  label: string | null;
  updatedAt: string;
}

/**
 * What creating a mapping needs. Mirrors `POST .../mission-control/mappings`.
 *
 * The TTL is deliberately absent: a DB CHECK fixes it at 24h and the route
 * refuses an explicit disagreement rather than silently overriding it, so
 * there is nothing for a form to offer.
 */
export interface AshbyMappingInput {
  external_job_id: string;
  role_id: string;
  delivery_mode?: 'email' | 'manual' | 'both';
  ai_screening_stage_id?: string | null;
  ta_screening_stage_id?: string | null;
  label?: string | null;
}

export interface AshbyMappingCreated {
  ok: boolean;
  id?: string;
  status?: string;
  error?: string;
}

export interface AshbyMcWorkflowOperation {
  id: string;
  type: string;
  state: string;
  errorCode: string | null;
}

export interface AshbyMcWorkflow {
  applicationLinkId: string;
  externalApplicationId: string;
  externalJobId: string | null;
  lifecycle: string;
  terminalState: string | null;
  ingestionState: string | null;
  operations: AshbyMcWorkflowOperation[];
  /**
   * Screening-session status, or null when no session exists yet. A `completed`
   * session on a non-terminal workflow whose lifecycle is not
   * `writeback_pending` is a screening whose completion park did not land.
   */
  sessionStatus: string | null;
  sessionId?: string | null;
  updatedAt: string;
}

/**
 * Candidate-scoped, read-only Ashby workflow projection.
 *
 * Same state vocabulary as the Mission Control workflow list — this is not a
 * second state model — but a deliberately narrower payload. It carries NO
 * external Ashby identifiers, no internal row ids (link/operation/ingestion/
 * session), no operation keys, markers or leases, no tokens, no provider
 * payloads, and no candidate PII. `errorCode` is the sanitized stable code the
 * database CHECK constrains to `^[a-z0-9_.:-]{1,64}$`.
 */
export type AshbyCandidateWorkflowOperationType = 'invite_delivery' | 'scorecard_write';

export interface AshbyCandidateWorkflowOperation {
  type: AshbyCandidateWorkflowOperationType;
  state: string;
  errorCode: string | null;
}

export interface AshbyCandidateWorkflow {
  lifecycle: string;
  terminalState: string | null;
  ingestionState: string | null;
  operations: AshbyCandidateWorkflowOperation[];
  sessionStatus: string | null;
  /** Null when the workflow row carries no usable timestamp. */
  updatedAt: string | null;
}

/** `workflow: null` = the candidate is not Ashby-linked. Never an error. */
export interface AshbyCandidateWorkflowResponse {
  ok: boolean;
  workflow: AshbyCandidateWorkflow | null;
}

export interface AshbyMcMappingsResponse {
  ok: boolean;
  mappings: AshbyMcMapping[];
}

export interface AshbyMcWorkflowsResponse {
  ok: boolean;
  workflows: AshbyMcWorkflow[];
}

/**
 * One-time manual invite hand-off. `joinUrl` carries the candidate token in the
 * URL FRAGMENT and is returned exactly once — it is never persisted by the API
 * and must never be written to storage, a query string, or telemetry here.
 */
export interface AshbyManualInviteResponse {
  ok: boolean;
  invite_id?: string;
  join_url?: string;
  expires_at?: string;
  ttl_hours?: number;
  revoked_invites?: number;
  error?: string;
}

/**
 * Read-only Ashby feedback-form SCHEMA discovery (admin). Structure only —
 * opaque ids, bounded labels, input types, and scale options. It never carries
 * a submitted answer, score, comment, or any candidate field, and nothing here
 * is persisted or bound to write-back by viewing it.
 */
export interface AshbyFormOption {
  value: string | null;
  label: string | null;
}

export interface AshbyFormField {
  id: string;
  title: string | null;
  path: string | null;
  type: string | null;
  /** `null` = the payload did not say. Never inferred. */
  required: boolean | null;
  options: AshbyFormOption[];
  optionsTruncated: boolean;
}

export interface AshbyFormSection {
  id: string | null;
  title: string | null;
  fields: AshbyFormField[];
}

export interface AshbyFeedbackForm {
  formDefinitionId: string;
  title: string | null;
  interviewId: string | null;
  interviewTitle: string | null;
  stageId: string | null;
  stageTitle: string | null;
  sections: AshbyFormSection[];
  fieldCount: number;
  /**
   * FALSE = the interview plan named this form but carried no field schema.
   * An empty `sections` is then "not readable here", NOT "the form is empty".
   */
  schemaAvailable: boolean;
}

export interface AshbyFeedbackFormResponse {
  ok: boolean;
  forms?: AshbyFeedbackForm[];
  empty?: boolean;
  /** True when a bound clipped the result — the view is partial. */
  truncated?: boolean;
  error?: string;
}

/**
 * Read-only preview of what a v2 scorecard write WOULD bind for one mapping's
 * role (issue #275): metrics bind to form Score fields BY NAME at write time.
 * Structure only — field paths, titles, types, scales. Never a submitted
 * value or a candidate datum, and viewing it binds nothing.
 */
export type AshbyScorecardMetricBindStatus =
  | 'bound'
  | 'no_field'
  | 'ambiguous_title'
  /** Two metrics carry this name, so neither may claim the field. */
  | 'ambiguous_metric'
  | 'not_score_type'
  | 'no_path';

export interface AshbyScorecardFixedFieldCheck {
  name: 'overall' | 'summary' | 'redFlags' | 'detailedReport';
  path: string;
  expectedType: string | null;
  status: 'present' | 'missing' | 'type_mismatch';
  actualType: string | null;
}

export interface AshbyScorecardMetricBindRow {
  key: string;
  name: string;
  status: AshbyScorecardMetricBindStatus;
  fieldPath: string | null;
  scale: { min: number; max: number } | null;
}

export interface AshbyScorecardBindingPreview {
  formDefinitionId: string;
  formTitle: string | null;
  schemaAvailable: boolean;
  archived: boolean;
  formMatchesBinding: boolean;
  fixedFields: AshbyScorecardFixedFieldCheck[];
  metrics: AshbyScorecardMetricBindRow[];
  unusedScoreFields: Array<{ fieldId: string; title: string | null }>;
  /** True only when every fixed field and EVERY metric would bind. */
  ready: boolean;
}

export interface AshbyScorecardBindingPreviewResponse {
  ok: boolean;
  /**
   * `v2_autobind` = the role has an active dashboard scorecard and metrics
   * bind by name; `v1_legacy` = no active scorecard, the fixed v1 binding is
   * used; `no_role` = the mapping carries no role.
   */
  scoringPath?: 'v2_autobind' | 'v1_legacy' | 'no_role';
  preview?: AshbyScorecardBindingPreview;
  error?: string;
}

export interface AshbyMcActionResponse {
  ok: boolean;
  status?: string;
  error?: string;
  cancelled_operations?: number;
  cancelled_ingestion?: number;
}

// ── P7: internal phone screening calendar (sanitized operator projection) ──
//
// These mirror the P6 `Phone*` schemas in app/api/openapi/openapi.yaml, which
// are `additionalProperties: false` and contract-tested against the live
// handlers. Two rules govern what may appear here, and both are enforced on
// the server by OMISSION rather than redaction — the read never selects the
// columns at all:
//
//   1. No provider or contact identifier is ever in this projection. No phone
//      number in any form, no suppression digest, no SIP call id, no room
//      name, no participant identity, no egress id, no lease token or owner,
//      no provider event id, no provider metadata, no transcript.
//   2. Every instant on the wire is a UTC ISO-8601 string ending in `Z`. The
//      IST wall-clock fields that sit beside them (`ist_date`, `ist_start`,
//      `ist_end`) are derived by a 0042 trigger, so no client re-derives the
//      zone and no two clients can disagree about it.
//
// Adding a field to any interface below without the API returning it is a
// silent lie to the operator, so these are kept in step with the OpenAPI
// document rather than with what a component happens to want.

/** Closed vocabulary of appointment statuses (0042). */
export type PhoneAppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'cancelled'
  | 'superseded'
  | 'fulfilled'
  | 'missed';

/** How an appointment came to exist. This UI only ever creates `hr_manual`. */
export type PhoneAppointmentSource = 'candidate_voice' | 'hr_manual' | 'system_deferral';

/** Closed vocabulary of engagement states (0042). Six of these are terminal. */
export type PhoneEngagementState =
  | 'pending_prereqs'
  | 'eligible'
  | 'scheduled'
  | 'dialing'
  | 'in_call'
  | 'reconnecting'
  | 'awaiting_retry'
  | 'completed'
  | 'abandoned_no_answer'
  | 'opted_out'
  | 'wrong_number'
  | 'failed'
  | 'cancelled';

/**
 * The cancel reasons an OPERATOR may give. Deliberately narrower than the
 * 0042 vocabulary: `superseded` is written only by the scheduling RPC and
 * `system_deferral_expired` only by the expiry sweep, so offering either here
 * would let an operator write an audit trail that misdescribes what happened.
 */
export type PhoneOperatorCancelReason =
  | 'candidate_request'
  | 'hr_cancelled'
  | 'emergency_stop'
  | 'engagement_cancelled';

/** The approved IST calling window, mirrored from the 0042 control row. */
export interface PhoneWindow {
  time_zone: string;
  /** Inclusive open, IST wall clock. */
  open_ist: string;
  /** Exclusive close, IST wall clock for the restored normal schedule. */
  close_ist: string;
  /** Inclusive final IST date for the temporary all-day calling window. */
  temporary_247_until_ist: string;
}

/**
 * The candidate fields an operator calendar may show. Never an email address,
 * never a phone number in any form, never resume content.
 */
export interface PhoneCandidateRef {
  id: string;
  /** Display name. Null when the candidate row carries none — never invented. */
  name: string | null;
  status: string;
  /** ATS external reference, or null for a candidate that never came from an ATS. */
  reference: string | null;
}

/** One calendar row: an appointment plus the engagement and candidate it belongs to. */
export interface PhoneCalendarAppointment {
  id: string;
  engagement_id: string;
  starts_at: string;
  ends_at: string;
  ist_date: string;
  ist_start: string | null;
  ist_end: string | null;
  status: PhoneAppointmentStatus;
  source: PhoneAppointmentSource;
  /**
   * ALWAYS null today — nothing in migration 0042 writes it. Surfaced rather
   * than dropped so the published residual stays visible.
   */
  confirmed_at: string | null;
  cancel_reason: string | null;
  /** Optimistic-concurrency token. Required on reschedule and cancel. */
  version: number;
  created_at: string;
  updated_at: string;
  /** Null only on a torn read between the batched queries, never as a guess. */
  engagement_state: PhoneEngagementState | null;
  candidate: PhoneCandidateRef | null;
}

/** The half-open UTC range that was queried, echoed back verbatim. */
export interface PhoneCalendarRange {
  from: string;
  to: string;
}

export interface PhoneCalendarResponse {
  ok: boolean;
  /** False while the feature flag is off; the list is then empty and no DB work ran. */
  enabled: boolean;
  range: PhoneCalendarRange;
  window: PhoneWindow;
  count: number;
  /** True when the range held more than the 200-row cap. Rows are never dropped silently. */
  truncated: boolean;
  appointments: PhoneCalendarAppointment[];
}

/** Why a slot cannot be booked. A closed vocabulary, never free text. */
export type PhoneSlotRefusal = 'slot_in_past' | 'at_projected_capacity';

export interface PhoneSlot {
  starts_at: string;
  /** May fall after the IST close: the window bounds only the START. */
  ends_at: string;
  ist_start: string;
  ist_end: string;
  /** Live scheduled or confirmed appointments overlapping this slot. */
  booked: number;
  remaining: number;
  /**
   * True iff `refusals` is empty. ADVISORY, not a reservation — and when the
   * response's `occupancy_truncated` is true this is OPTIMISTIC, because
   * `booked` is then only a lower bound.
   */
  bookable: boolean;
  refusals: PhoneSlotRefusal[];
}

export interface PhoneSlotsResponse {
  ok: boolean;
  enabled: boolean;
  date: string;
  window: PhoneWindow;
  /** The grid step. NOT a schema guarantee — reported so it is not mistaken for one. */
  slot_seconds: number;
  /**
   * The fleet cap mirrored from `phone_max_concurrent`. Null means UNKNOWN —
   * it is null while the feature is disabled — and must never be rendered or
   * treated as zero.
   */
  max_concurrent: number | null;
  booked_total: number;
  /**
   * True when the IST day held more live appointments than the projection
   * counted. `booked` is then a LOWER bound and `remaining` an UPPER one.
   */
  occupancy_truncated: boolean;
  slots: PhoneSlot[];
}

// ── P7: phone appointment writes (admin only) ─────────────────────────

/** `source` is deliberately absent: this route books `hr_manual` by definition. */
export interface PhoneAppointmentCreateInput {
  engagement_id: string;
  starts_at: string;
  ends_at: string;
}

/** `version` is REQUIRED — a version-free supersede is the lost update it exists to prevent. */
export interface PhoneAppointmentPatchInput {
  starts_at: string;
  ends_at: string;
  version: number;
}

export interface PhoneAppointmentCancelInput {
  reason: PhoneOperatorCancelReason;
  version: number;
}

export interface PhoneCandidateAppointmentCreateInput {
  starts_at: string;
  ends_at: string;
}

export interface PhoneCandidateAppointmentPatchInput {
  starts_at: string;
  ends_at: string;
  version: number;
}

export interface PhoneAppointmentWriteResponse {
  ok: boolean;
  appointment_id: string | null;
  version: number | null;
  engagement_state: string | null;
  /**
   * A SUCCESS with a warning: the slot is real and HR can see it, but the
   * engagement's prerequisites are unmet, so nothing will dial it. Collapsing
   * this into plain success would let an operator believe a call is going to
   * happen at that time.
   */
  prereqs_pending: boolean;
  /** Returned verbatim from the RPC — which row was ACTUALLY superseded. */
  superseded_appointment_id: string | null;
}

export interface PhoneCancelResponse {
  ok: boolean;
  appointment_id: string;
  version: number | null;
  /** Idempotent success, not a conflict: a retry after a dropped response. */
  already_cancelled: boolean;
}

export type PhoneRescreenReason =
  | 'candidate_requested'
  | 'incomplete_screening'
  | 'technical_issue'
  | 'role_changed'
  | 'quality_review';

export interface PhoneScreeningCycleAppointment {
  appointment_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: string | null;
  source: string | null;
  version: number | null;
}

export interface PhoneScreeningCycle {
  cycle_number: number | null;
  state: PhoneEngagementState | 'unknown';
  state_reason: string | null;
  version: number | null;
  no_answer_attempts: number | null;
  no_answer_limit: number | null;
  reconnects_used: number | null;
  provider_failures: number | null;
  next_eligible_at: string | null;
  last_attempt_at: string | null;
  terminal_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  has_session: boolean;
  has_assessment: boolean;
  appointment: PhoneScreeningCycleAppointment | null;
}

export interface PhoneScreeningsResponse {
  ok: boolean;
  enabled: boolean;
  cycles: PhoneScreeningCycle[];
  current_cycle: number | null;
}

export interface PhoneRescreenResponse {
  ok: boolean;
  status: 'ok' | 'already_requested';
  cycle_number: number | null;
}

export interface PhoneRescreenInput {
  request_id: string;
  reason: PhoneRescreenReason;
}

export interface PhoneVerificationInput {
  phone_e164: string;
}

export interface PhoneVerificationResponse {
  ok: boolean;
}
