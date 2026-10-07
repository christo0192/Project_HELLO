/**
 * The data the stakeholder report is built from.
 *
 * `collectReportData` fills it from the API; `buildReportHtml` renders it. The
 * builder is pure: no I/O, no clock (the generation time is a field), so every
 * rendering rule is unit-testable from a literal.
 */

import type {
  AshbyCandidateWorkflow,
  Assessment,
  Candidate,
  CandidatePhoneAttempt,
  MembershipRole,
  Session,
  TranscriptLine,
} from '../../types';

/** One recording whose bytes are embedded in the file. */
export interface ReportAudio {
  /** `a1`, `a2`, ... : the id the transcript's timestamp buttons point at. */
  id: string;
  /** From the mint response; defaults to `audio/mpeg`. */
  mime: string;
  /** Standard base64 of the file's bytes. */
  base64: string;
}

/**
 * What became of one recording the report wanted: embedded, or a plain-words
 * reason it is not (never a thrown error, never a signed URL).
 */
export type ReportAudioResult =
  | { kind: 'embedded'; audio: ReportAudio }
  | { kind: 'omitted'; reason: string };

export interface ReportSession {
  session: Session;
  /** null = the transcript was not read; `transcriptNote` says why. */
  transcript: TranscriptLine[] | null;
  transcriptNote: string | null;
  /** The session's own assessment as `GET /api/screening/:id` returned it. */
  assessment: Assessment | null;
  /** The session's phone legs in the order they happened (empty for non-phone sessions). */
  legs: CandidatePhoneAttempt[];
  /** Why the legs could not be listed, when that failed. */
  legsNote: string | null;
  /** Per-leg recording outcome, keyed by `leg.id`. A leg with no entry was not asked for. */
  legAudio: Record<string, ReportAudioResult>;
  /** The session-level recording (used when no leg can be played). */
  sessionAudio: ReportAudioResult | null;
}

export interface ReportData {
  candidate: Candidate & { decision_use_blocked_at?: string | null };
  roleTitle: string | null;
  /** The signed-in user's role: states what they could read. Never an id or email. */
  generatedByRole: MembershipRole | null;
  generatedAt: Date;
  /** Every scorecard the candidate detail returned, newest first. */
  assessments: Assessment[];
  /** All sessions, newest first as the API lists them. */
  sessions: ReportSession[];
  /** Every call attempt for the candidate (the "call attempts" summary). Null = not loaded. */
  attempts: CandidatePhoneAttempt[] | null;
  /** Ashby pipeline status when the candidate is Ashby-linked and the read succeeded. */
  ashby: AshbyCandidateWorkflow | null;
  /** Plain-language notes about anything left out, shown near the top of the file. */
  omissions: string[];
}

/** Progress while the report is being collected. */
export interface ReportProgress {
  phase: 'details' | 'recordings' | 'building';
  /** Recordings finished so far. */
  done: number;
  /** Recordings that will be attempted. */
  total: number;
}
