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
  mode?: string;                 // "simulation" | "live"
  /** @deprecated MIG-03/04/05 — use getRecordingDownloadUrl() for on-demand signed URL. */
  recording_url?: string | null;
  duration_sec?: number | null;
  created_at: string;
}

export type Speaker = "bot" | "candidate";

export interface TranscriptLine {
  speaker: Speaker;
  text: string;
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
  candidate: Candidate;
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
  model: string;
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
