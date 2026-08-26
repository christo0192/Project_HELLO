// Domain types matching the backend API contract.

export interface ScreeningQuestion {
  id: string;
  question: string;
  weight: number;
  follow_up_hint?: string;
}

export interface Role {
  id: string;
  title: string;
  jd: string;
  required_skills: string[];
  screening_template: ScreeningQuestion[];
  interviewer_instructions?: string;
  is_active: boolean;
  created_at: string;
}

export interface RoleInput {
  title: string;
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
}

export interface CandidateConsentTemplate {
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: string[];
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
  /** Exclusive close, IST wall clock. */
  close_ist: string;
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
