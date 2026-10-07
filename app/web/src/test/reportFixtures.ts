/** Shared literals for the candidate-report tests. */

import type {
  Assessment,
  Candidate,
  CandidatePhoneAttempt,
  Session,
  TranscriptLine,
} from '../types';
import type { ReportData, ReportSession } from '../lib/candidate-report/types';

export const T0 = Date.parse('2026-10-03T03:42:00.000Z');

export function makeCandidate(overrides: Partial<Candidate & { decision_use_blocked_at?: string | null }> = {}) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Shrinidhi Handigund',
    email: 'shree@example.com',
    phone_e164: '+919876543210',
    phone_valid: true,
    skills: ['Recruiting', 'Sourcing'],
    experience_years: 2,
    status: 'screened',
    role_id: 'role-1',
    created_at: '2026-10-01T05:00:00.000Z',
    parsed: {
      summary: 'Early-career recruiter.',
      current_role: 'Recruiting intern',
      recent_role: { title: 'Intern', employer: 'Acme', period: '2025', highlights: ['Sourced 40 profiles'] },
      prior_roles: [],
      career_highlights: ['Built a referral sheet'],
      education: ['BBA, Example University'],
      certifications: ['LinkedIn Recruiter basics'],
    },
    ...overrides,
  } as Candidate & { decision_use_blocked_at?: string | null };
}

export function makeLeg(overrides: Partial<CandidatePhoneAttempt> = {}): CandidatePhoneAttempt {
  return {
    id: 'leg-1',
    attempt_seq: 1,
    admitted_at: new Date(T0).toISOString(),
    answered_at: new Date(T0 + 1000).toISOString(),
    ended_at: new Date(T0 + 60_000).toISOString(),
    state: 'completed',
    abandon_reason: null,
    outcome_class: 'completed',
    duration_sec: 59,
    connected_from: new Date(T0 + 1000).toISOString(),
    connected_to: new Date(T0 + 60_000).toISOString(),
    connected_to_source: 'observed',
    connected_sec: 59,
    recorded_sec: 58,
    recording_started_at_ms: T0 + 1500,
    recording: { state: 'ready' },
    consent_stage: 'after_consent',
    transcript: null,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    candidate_id: '11111111-2222-4333-8444-555555555555',
    role_id: 'role-1',
    status: 'completed',
    mode: 'live',
    created_at: '2026-10-03T03:40:00.000Z',
    recorded_total_sec: 80,
    recorded_legs: 2,
    ...overrides,
  };
}

export function makeTurns(): TranscriptLine[] {
  return [
    { speaker: 'bot', text: 'Hello, this call is recorded.', is_gate: true, started_at_ms: T0 + 2000 },
    { speaker: 'candidate', text: 'Hello', started_at_ms: T0 + 4500 },
    { speaker: 'bot', text: '[planned question] Tell me about yourself.', started_at_ms: T0 + 9500 },
  ];
}

export const V1_ASSESSMENT = {
  id: 'assess-v1',
  overall_score: 72,
  recommendation: 'advance',
  summary: 'Solid communicator.',
  tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: 'Clear and calm.' },
  communication: { score: 7, notes: 'Answers were structured.' },
  motivation: { score: 6, notes: 'Keen to learn.' },
  role_fit: {
    score: 6,
    matched_skills: ['Sourcing'],
    gaps: ['ATS depth'],
    red_flags: [],
    notes: 'Good junior fit.',
  },
  resume_conflicts: [
    { topic: 'Tenure', resume_says: '2 years', candidate_said: '1 year', resolved: false, note: 'Ask again' },
  ],
  raw: null,
  created_at: '2026-10-03T04:00:00.000Z',
  session_id: 'session-1',
} as unknown as Assessment;

export const V2_ASSESSMENT = {
  id: 'assess-v2',
  schema_version: 2,
  overall_score: 39,
  recommendation: 'reject',
  summary: '',
  tone: undefined,
  role_fit: { score: 3, matched_skills: [], gaps: ['Everything'], red_flags: ['Evasive'], notes: 'Low fit.' },
  scoring_status: 'incomplete_evidence',
  weighted_score_5: 2.18,
  score_scale_max: 4,
  evidence_grade: 'decision',
  raw: {
    schemaVersion: 2,
    scorecardVersionId: 'v1',
    revision: 1,
    status: 'incomplete_evidence',
    scoreScaleMax: 4,
    weightedScore5: 2.18,
    overallScore: 39,
    recommendation: 'reject',
    metricResults: [
      {
        configMetricId: 'm1',
        metric: { id: 'm1', name: 'Communication', weightBps: 7000 },
        score: 2,
        evidenceStatus: 'scored',
        rationale: 'Gave some clear answers.',
        evidenceRefs: ['"I study recruiting"'],
      },
      {
        configMetricId: 'm2',
        metric: { id: 'm2', name: 'Motivation', weightBps: 3000 },
        score: null,
        evidenceStatus: 'insufficient_evidence',
        rationale: 'Not enough said.',
        evidenceRefs: [],
      },
    ],
  },
  created_at: '2026-10-03T04:05:00.000Z',
  session_id: 'session-1',
} as unknown as Assessment;

export function makeReportSession(overrides: Partial<ReportSession> = {}): ReportSession {
  return {
    session: makeSession(),
    transcript: makeTurns(),
    transcriptNote: null,
    assessment: null,
    legs: [],
    legsNote: null,
    legAudio: {},
    sessionAudio: null,
    ...overrides,
  };
}

export function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    candidate: makeCandidate(),
    roleTitle: 'Intern Talent Acquisition',
    generatedByRole: 'admin',
    generatedAt: new Date('2026-10-07T18:00:00.000Z'),
    assessments: [V2_ASSESSMENT, V1_ASSESSMENT],
    sessions: [makeReportSession()],
    attempts: [],
    ashby: null,
    omissions: [],
    ...overrides,
  };
}

/** A tiny, valid base64 payload (the bytes "ID3" plus padding) standing in for an MP3. */
export const FAKE_MP3_B64 = 'SUQzBAAAAAAA';
