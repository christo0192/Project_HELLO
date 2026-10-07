/**
 * collectReportData: gather everything the stakeholder report needs, using the
 * app's own API functions, and turn every per-item failure into a plain-words
 * note instead of a failed export.
 *
 * Rules:
 *  - recording links are minted ONE AT A TIME (the recordings route is behind
 *    the strict 20-per-minute limiter and re-verifies each object's checksum
 *    on every mint), at most `MAX_RECORDINGS` per report;
 *  - a 409 (processing or quarantined), 403, 404 or 429 on one recording
 *    leaves a note for THAT recording and the export carries on;
 *  - anything the server refuses with a 403 (a transcript, say) is left out and
 *    said so, never silently;
 *  - the minted URL lives only in a local variable: it is fetched and dropped,
 *    never stored, never written into the report.
 */

import { legPlayable, sortLegs } from '../../components/talent/sessionLegs';
import type {
  AshbyCandidateWorkflowResponse,
  CandidateDetail,
  CandidatePhoneAttempt,
  CandidatePhoneAttemptsResponse,
  MembershipRole,
  RecordingDownloadResponse,
  Session,
  SessionDetail,
} from '../../types';
import { fetchAudioBase64 } from './fetchAudio';
import type { FetchedAudio } from './fetchAudio';
import type { ReportAudioResult, ReportData, ReportProgress, ReportSession } from './types';

/** Recordings embedded per report: keeps one click under the strict mint limit. */
export const MAX_RECORDINGS = 15;
/** Total base64 characters of embedded audio before further recordings are left out (~60 MB). */
export const MAX_AUDIO_BASE64_CHARS = 60 * 1024 * 1024;
const ATTEMPT_PAGE_SIZE = 50;
const ATTEMPT_PAGES_MAX = 4;

/** The slice of `api` the collector uses. Injected so the unit tests need no network. */
export interface ReportApi {
  getSession(sessionId: string): Promise<SessionDetail>;
  getCandidatePhoneAttempts(
    candidateId: string,
    before?: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<CandidatePhoneAttemptsResponse>;
  getRecordingDownloadUrl(sessionId: string): Promise<RecordingDownloadResponse>;
  getAttemptRecordingDownloadUrl(attemptId: string): Promise<RecordingDownloadResponse>;
  getCandidateAshbyWorkflow?(candidateId: string): Promise<AshbyCandidateWorkflowResponse>;
}

export interface CollectReportInput {
  detail: CandidateDetail;
  roleTitle: string | null;
  role: MembershipRole | null;
  api: ReportApi;
  /** Default true. */
  includeAudio?: boolean;
  onProgress?: (progress: ReportProgress) => void;
  signal?: AbortSignal;
  now?: () => Date;
  /** Injected in tests; defaults to a real fetch of the signed URL. */
  fetchAudio?: (url: string, signal?: AbortSignal) => Promise<FetchedAudio>;
}

type Task =
  | { kind: 'leg'; session: ReportSession; leg: CandidatePhoneAttempt }
  | { kind: 'session'; session: ReportSession };

function abortError(): Error {
  const err = new Error('Report export cancelled.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** The HTTP status an `ApiError` carries (duck-typed so a re-exported or mocked class still counts). */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** Plain-words reason a recording link could not be minted. Never includes a URL. */
export function mintFailureReason(error: unknown): { reason: string; rateLimited: boolean } {
  const status = statusOf(error);
  if (status !== null) {
    const text = String((error as { message?: unknown }).message ?? '').toLowerCase();
    switch (status) {
      case 409:
        if (text.includes('quarantin')) return { reason: 'Recording withheld (failed integrity check).', rateLimited: false };
        if (text.includes('processing')) {
          return { reason: 'Recording is still processing. Export again in a few minutes to include it.', rateLimited: false };
        }
        return { reason: 'Recording is not available yet.', rateLimited: false };
      case 403:
        return { reason: 'Recording access was withdrawn, or is not permitted for your role.', rateLimited: false };
      case 404:
        return { reason: 'Recording not found (deleted, or never uploaded).', rateLimited: false };
      case 429:
        return { reason: 'Not included: the server is rate limiting recording downloads. Export again in a minute.', rateLimited: true };
      default:
        break;
    }
  }
  return { reason: 'Recording could not be loaded.', rateLimited: false };
}

async function fetchAllAttempts(
  api: ReportApi,
  candidateId: string,
  sessionId?: string,
): Promise<CandidatePhoneAttempt[]> {
  const all: CandidatePhoneAttempt[] = [];
  let before: string | undefined;
  for (let page = 0; page < ATTEMPT_PAGES_MAX; page++) {
    const res = await api.getCandidatePhoneAttempts(candidateId, before, {
      limit: ATTEMPT_PAGE_SIZE,
      ...(sessionId ? { sessionId } : {}),
    });
    all.push(...res.attempts);
    if (!res.next_cursor) break;
    before = res.next_cursor;
  }
  return all;
}

/** An R1 sales role-play session: not part of the screening report. */
export function isR1Session(session: Session): boolean {
  return session.interview_round_id != null;
}

/**
 * Upper bound of the recordings a report will embed, known before anything is
 * fetched: one per completed, non-simulation, non-R1 session (a session with
 * several playable legs can add more), capped at MAX_RECORDINGS. Used as the
 * audit's `planned_recordings`.
 */
export function plannedRecordingCount(sessions: readonly Session[]): number {
  const eligible = sessions.filter(
    (s) => !isR1Session(s) && s.status === 'completed' && s.mode !== 'simulation',
  ).length;
  return Math.min(MAX_RECORDINGS, eligible);
}

export async function collectReportData(input: CollectReportInput): Promise<ReportData> {
  const { detail, api, signal } = input;
  const includeAudio = input.includeAudio !== false;
  const fetchAudio = input.fetchAudio ?? fetchAudioBase64;
  const now = input.now ?? (() => new Date());
  const omissions: string[] = [];
  const emit = (phase: ReportProgress['phase'], done: number, total: number) =>
    input.onProgress?.({ phase, done, total });
  const candidateId = detail.candidate.id;

  emit('details', 0, 0);

  // Sessions: transcript, session scorecard, phone legs.
  const sessions: ReportSession[] = [];
  let transcriptDenied = false;
  let transcriptFailed = false;
  const r1Sessions = detail.sessions.filter(isR1Session);
  for (const session of detail.sessions.filter((s) => !isR1Session(s))) {
    throwIfAborted(signal);
    const rs: ReportSession = {
      session,
      transcript: null,
      transcriptNote: null,
      assessment: null,
      legs: [],
      legsNote: null,
      legAudio: {},
      sessionAudio: null,
    };
    if (session.status !== 'completed') {
      rs.transcriptNote = 'This session did not complete, so there is no transcript.';
    } else {
      try {
        const loaded = await api.getSession(session.id);
        rs.transcript = Array.isArray(loaded.transcript) ? loaded.transcript : [];
        rs.assessment = loaded.assessment ?? null;
        if (loaded.session) rs.session = { ...session, ...loaded.session };
      } catch (error) {
        if (statusOf(error) === 403) {
          transcriptDenied = true;
          rs.transcriptNote = 'Transcript not included: the server refused access to it (403).';
        } else {
          transcriptFailed = true;
          rs.transcriptNote = 'Transcript could not be loaded for this session.';
        }
      }
    }
    if (session.mode === 'live') {
      try {
        rs.legs = sortLegs(await fetchAllAttempts(api, candidateId, session.id));
      } catch {
        rs.legsNote = 'The list of calls could not be loaded for this session.';
      }
    }
    sessions.push(rs);
  }
  if (transcriptDenied) {
    omissions.push('Transcripts are not included: the server refused to share them with your access (403).');
  }
  if (transcriptFailed) omissions.push('One or more transcripts could not be loaded.');

  // The call-attempts summary (every attempt, including calls that ended before a session existed).
  let attempts: CandidatePhoneAttempt[] | null = null;
  try {
    attempts = await fetchAllAttempts(api, candidateId);
  } catch {
    omissions.push('The call attempts summary could not be loaded.');
  }

  // Ashby pipeline status, when linked.
  let ashby: ReportData['ashby'] = null;
  if (typeof api.getCandidateAshbyWorkflow === 'function') {
    try {
      ashby = (await api.getCandidateAshbyWorkflow(candidateId)).workflow ?? null;
    } catch {
      ashby = null;
    }
  }

  // Recordings: one task per playable leg, else one for the session recording.
  const tasks: Task[] = [];
  for (const rs of sessions) {
    if (rs.session.status !== 'completed' || rs.session.mode === 'simulation') continue;
    const playable = rs.legs.filter(legPlayable);
    if (playable.length > 0) {
      for (const leg of playable) tasks.push({ kind: 'leg', session: rs, leg });
    } else {
      // No leg can be played (or no legs): the session's own recording, as the Review tab does.
      tasks.push({ kind: 'session', session: rs });
    }
  }

  const planned = includeAudio ? tasks.slice(0, MAX_RECORDINGS) : [];
  const skipped = includeAudio ? tasks.slice(MAX_RECORDINGS) : tasks;
  const store = (task: Task, result: ReportAudioResult) => {
    if (task.kind === 'leg') task.session.legAudio[task.leg.id] = result;
    else task.session.sessionAudio = result;
  };
  if (!includeAudio && tasks.length > 0) {
    omissions.push('Recordings are not included in this report.');
  }
  for (const task of skipped) {
    if (includeAudio) {
      store(task, {
        kind: 'omitted',
        reason: `Not included: a report embeds at most ${MAX_RECORDINGS} recordings.`,
      });
    }
  }
  if (skipped.length > 0 && includeAudio) {
    omissions.push(`Only the first ${MAX_RECORDINGS} recordings are embedded; ${skipped.length} more were left out.`);
  }

  let embedded = 0;
  let nextAudio = 1;
  let rateLimited = false;
  let budget = 0;
  let sizeCapped = false;
  emit('recordings', 0, planned.length);
  for (let i = 0; i < planned.length; i++) {
    throwIfAborted(signal);
    const task = planned[i];
    if (rateLimited) {
      store(task, { kind: 'omitted', reason: 'Not included: the server is rate limiting recording downloads. Export again in a minute.' });
      emit('recordings', i + 1, planned.length);
      continue;
    }
    if (sizeCapped) {
      store(task, { kind: 'omitted', reason: 'Not included: the report reached its size limit.' });
      emit('recordings', i + 1, planned.length);
      continue;
    }
    let result: ReportAudioResult;
    try {
      const minted =
        task.kind === 'leg'
          ? await api.getAttemptRecordingDownloadUrl(task.leg.id)
          : await api.getRecordingDownloadUrl(task.session.session.id);
      throwIfAborted(signal);
      try {
        const fetched = await fetchAudio(minted.url, signal);
        if (budget + fetched.base64.length > MAX_AUDIO_BASE64_CHARS) {
          sizeCapped = true;
          result = { kind: 'omitted', reason: 'Not included: the report reached its size limit.' };
        } else {
          budget += fetched.base64.length;
          embedded += 1;
          result = {
            kind: 'embedded',
            audio: {
              id: `a${nextAudio++}`,
              mime: minted.content_type || fetched.mime || 'audio/mpeg',
              base64: fetched.base64,
            },
          };
        }
      } catch (error) {
        if (signal?.aborted) throw abortError();
        void error;
        result = { kind: 'omitted', reason: 'Recording could not be downloaded (network or storage error).' };
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const failure = mintFailureReason(error);
      if (failure.rateLimited) rateLimited = true;
      result = { kind: 'omitted', reason: failure.reason };
    }
    store(task, result);
    emit('recordings', i + 1, planned.length);
  }
  const failed = planned.length - embedded;
  if (failed > 0 && !skipped.length) {
    omissions.push(`${failed} of ${planned.length} recordings could not be included; each is marked where it would play.`);
  } else if (failed > 0) {
    omissions.push(`${failed} of ${planned.length} attempted recordings could not be included; each is marked where it would play.`);
  }

  emit('building', planned.length, planned.length);
  return {
    candidate: detail.candidate,
    roleTitle: input.roleTitle,
    generatedByRole: input.role,
    generatedAt: now(),
    assessments: detail.assessments,
    sessions,
    r1Sessions,
    attempts,
    ashby,
    omissions,
  };
}
