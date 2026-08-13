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
  is_active: boolean;
  created_at: string;
}

export interface RoleInput {
  title: string;
  jd: string;
  required_skills: string[];
  screening_template: ScreeningQuestion[];
}

export type CandidateStatus = string;

export interface Candidate {
  id: string;
  name: string;
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
  updatedAt: string;
}

export interface AshbyMcMappingsResponse {
  ok: boolean;
  mappings: AshbyMcMapping[];
}

export interface AshbyMcWorkflowsResponse {
  ok: boolean;
  workflows: AshbyMcWorkflow[];
}

export interface AshbyMcActionResponse {
  ok: boolean;
  status?: string;
  error?: string;
  cancelled_operations?: number;
  cancelled_ingestion?: number;
}
