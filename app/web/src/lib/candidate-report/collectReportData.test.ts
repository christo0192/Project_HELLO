import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api-client';
import {
  MAX_AUDIO_BASE64_CHARS,
  MAX_RECORDINGS,
  collectReportData,
  mintFailureReason,
  plannedRecordingCount,
} from './collectReportData';
import type { ReportApi } from './collectReportData';
import { generateCandidateReport } from './generateCandidateReport';
import {
  FAKE_MP3_B64,
  T0,
  V1_ASSESSMENT,
  makeCandidate,
  makeLeg,
  makeSession,
  makeTurns,
} from '../../test/reportFixtures';
import type { CandidateDetail, CandidatePhoneAttempt, Session } from '../../types';

function detailOf(sessions = [makeSession()]): CandidateDetail {
  return { candidate: makeCandidate(), sessions, assessments: [V1_ASSESSMENT] };
}

function legsFor(count: number, prefix = 'leg'): CandidatePhoneAttempt[] {
  return Array.from({ length: count }, (_, i) =>
    makeLeg({
      id: `${prefix}-${i + 1}`,
      attempt_seq: i + 1,
      admitted_at: new Date(T0 + i * 120_000).toISOString(),
      recording_started_at_ms: T0 + i * 120_000 + 1500,
    }),
  );
}

function makeApi(overrides: Partial<ReportApi> & { legs?: CandidatePhoneAttempt[] } = {}) {
  const { legs = legsFor(2), ...rest } = overrides;
  const order: string[] = [];
  const api: ReportApi = {
    getSession: vi.fn(async (id: string) => ({
      // Only what the detail endpoint adds; the rest comes from the candidate's own session list.
      session: { id, recording_egress_started_at_ms: null } as Session,
      transcript: makeTurns(),
      assessment: null,
    })),
    getCandidatePhoneAttempts: vi.fn(async () => ({ attempts: legs, next_cursor: null })),
    getRecordingDownloadUrl: vi.fn(async (id: string) => {
      order.push(`session:${id}`);
      return { url: `https://signed.example/session/${id}?token=SECRET`, content_type: 'audio/mpeg' };
    }),
    getAttemptRecordingDownloadUrl: vi.fn(async (id: string) => {
      order.push(`leg:${id}`);
      return { url: `https://signed.example/leg/${id}?token=SECRET` };
    }),
    getCandidateAshbyWorkflow: vi.fn(async () => ({ ok: true, workflow: null })),
    ...rest,
  };
  return { api, order };
}

const fetchOk = vi.fn(async () => ({ base64: FAKE_MP3_B64, mime: null }));
beforeEach(() => fetchOk.mockClear());

describe('collectReportData: admin path', () => {
  it('reads each completed session, then mints and fetches recordings one at a time, in order', async () => {
    const { api, order } = makeApi();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchAudio = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { base64: FAKE_MP3_B64, mime: null };
    });
    const progress: Array<[string, number, number]> = [];
    const data = await collectReportData({
      detail: detailOf(),
      roleTitle: 'Role',
      role: 'admin',
      api,
      fetchAudio,
      onProgress: (p) => progress.push([p.phase, p.done, p.total]),
    });
    expect(api.getSession).toHaveBeenCalledWith('session-1');
    expect(order).toEqual(['leg:leg-1', 'leg:leg-2']);
    expect(maxInFlight).toBe(1);
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    const rs = data.sessions[0];
    expect(rs.transcript).toHaveLength(3);
    expect(rs.legs.map((l) => l.id)).toEqual(['leg-1', 'leg-2']);
    expect(rs.legAudio['leg-1']).toMatchObject({ kind: 'embedded', audio: { id: 'a1', mime: 'audio/mpeg', base64: FAKE_MP3_B64 } });
    expect(rs.legAudio['leg-2']).toMatchObject({ kind: 'embedded', audio: { id: 'a2' } });
    expect(progress.filter(([phase]) => phase === 'recordings').map(([, done, total]) => `${done}/${total}`)).toEqual(['0/2', '1/2', '2/2']);
    expect(data.omissions).toEqual([]);
    expect(data.attempts).toHaveLength(2);
    expect(data.generatedByRole).toBe('admin');
  });

  it('takes the content type from the mint response, and never keeps a signed URL', async () => {
    const { api } = makeApi({
      getAttemptRecordingDownloadUrl: vi.fn(async () => ({ url: 'https://signed.example/x?token=SECRET', content_type: 'audio/ogg' })),
    });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(data.sessions[0].legAudio['leg-1']).toMatchObject({ kind: 'embedded', audio: { mime: 'audio/ogg' } });
    expect(JSON.stringify(data)).not.toContain('SECRET');
    expect(JSON.stringify(data)).not.toContain('signed.example');
  });

  it('uses the session recording when there are no playable legs', async () => {
    const { api, order } = makeApi({
      legs: [makeLeg({ id: 'leg-1', recording: { state: 'unavailable', reason: 'recording_failed' } })],
    });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(order).toEqual(['session:session-1']);
    expect(data.sessions[0].sessionAudio).toMatchObject({ kind: 'embedded' });
  });

  it('does not mint for a simulation session or a session that did not complete', async () => {
    const { api, order } = makeApi();
    const data = await collectReportData({
      detail: detailOf([makeSession({ id: 's-sim', mode: 'simulation' }), makeSession({ id: 's-open', status: 'in_progress', mode: 'browser' })]),
      roleTitle: null,
      role: 'admin',
      api,
      fetchAudio: fetchOk,
    });
    expect(order).toEqual([]);
    expect(api.getSession).toHaveBeenCalledTimes(1);
    expect(data.sessions[1].transcriptNote).toContain('did not complete');
  });

  it('includeAudio:false makes no recording call and says so', async () => {
    const { api } = makeApi();
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, includeAudio: false, fetchAudio: fetchOk });
    expect(api.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(api.getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(fetchOk).not.toHaveBeenCalled();
    expect(data.omissions.join(' ')).toContain('Recordings are not included');
  });

  it('caps the report at the recording limit and notes the rest', async () => {
    const { api, order } = makeApi({ legs: legsFor(MAX_RECORDINGS + 3) });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(order).toHaveLength(MAX_RECORDINGS);
    const last = data.sessions[0].legAudio[`leg-${MAX_RECORDINGS + 1}`];
    expect(last).toMatchObject({ kind: 'omitted' });
    expect(data.omissions.join(' ')).toContain(`Only the first ${MAX_RECORDINGS} recordings`);
  });

  it('stops embedding once the size budget is spent', async () => {
    const { api } = makeApi();
    const huge = vi.fn(async () => ({ base64: 'A'.repeat(MAX_AUDIO_BASE64_CHARS - 10), mime: null }));
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: huge });
    expect(data.sessions[0].legAudio['leg-1'].kind).toBe('embedded');
    expect(data.sessions[0].legAudio['leg-2']).toMatchObject({ kind: 'omitted', reason: expect.stringContaining('size limit') });
  });
});

describe('collectReportData: never fails the whole export for one item', () => {
  it.each([
    [409, 'recording_processing', 'still processing'],
    [409, 'recording_quarantined', 'failed integrity check'],
    [403, 'forbidden', 'withdrawn'],
    [404, 'not found', 'not found'],
    [500, 'boom', 'could not be loaded'],
  ])('a %i (%s) on one recording leaves a note and the rest still embed', async (status, message, expected) => {
    const { api } = makeApi({
      getAttemptRecordingDownloadUrl: vi.fn(async (id: string) => {
        if (id === 'leg-1') throw new ApiError(message, status);
        return { url: 'https://signed.example/ok' };
      }),
    });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    const first = data.sessions[0].legAudio['leg-1'];
    expect(first.kind).toBe('omitted');
    expect(first.kind === 'omitted' && first.reason).toContain(expected);
    expect(data.sessions[0].legAudio['leg-2'].kind).toBe('embedded');
    expect(data.omissions.join(' ')).toContain('1 of 2 recordings could not be included');
  });

  it('a 429 marks the rest as rate limited without calling the server again', async () => {
    const { api } = makeApi({
      legs: legsFor(3),
      getAttemptRecordingDownloadUrl: vi.fn(async (id: string) => {
        if (id === 'leg-2') throw new ApiError('Too many requests', 429);
        return { url: 'https://signed.example/ok' };
      }),
    });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(api.getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(2);
    expect(data.sessions[0].legAudio['leg-1'].kind).toBe('embedded');
    for (const id of ['leg-2', 'leg-3']) {
      const r = data.sessions[0].legAudio[id];
      expect(r.kind === 'omitted' && r.reason).toContain('rate limiting');
    }
  });

  it('a failed byte download leaves a note for that recording only', async () => {
    const { api } = makeApi();
    const fetchAudio = vi.fn(async (url: string) => {
      void url;
      if (fetchAudio.mock.calls.length === 1) throw new Error('CORS');
      return { base64: FAKE_MP3_B64, mime: null };
    });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio });
    const first = data.sessions[0].legAudio['leg-1'];
    expect(first.kind === 'omitted' && first.reason).toContain('could not be downloaded');
    expect(data.sessions[0].legAudio['leg-2'].kind).toBe('embedded');
  });

  it('a 403 from getSession (non-admin) leaves no transcript, says why, and still reports the rest', async () => {
    const { api } = makeApi({ getSession: vi.fn(async () => { throw new ApiError('Insufficient permissions', 403); }) });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'interviewer', api, fetchAudio: fetchOk });
    expect(data.sessions[0].transcript).toBeNull();
    expect(data.sessions[0].transcriptNote).toContain('refused');
    expect(data.omissions.join(' ')).toContain('refused');
    expect(data.sessions[0].legAudio['leg-1'].kind).toBe('embedded');
    expect(data.generatedByRole).toBe('interviewer');
  });

  it('any other transcript failure is a note, not an exception', async () => {
    const { api } = makeApi({ getSession: vi.fn(async () => { throw new Error('network'); }) });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(data.sessions[0].transcriptNote).toContain('could not be loaded');
    expect(data.omissions.join(' ')).toContain('could not be loaded');
  });

  it('a failed call list or attempts summary or Ashby read does not fail the export', async () => {
    const { api } = makeApi({
      getCandidatePhoneAttempts: vi.fn(async () => { throw new Error('down'); }),
      getCandidateAshbyWorkflow: vi.fn(async () => { throw new ApiError('nope', 500); }),
    });
    const data = await collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(data.sessions[0].legsNote).toContain('could not be loaded');
    expect(data.attempts).toBeNull();
    expect(data.ashby).toBeNull();
    // With no legs listed the session recording is still offered.
    expect(data.sessions[0].sessionAudio?.kind).toBe('embedded');
  });

  it('follows the attempts cursor across pages', async () => {
    const pages = [
      { attempts: [makeLeg({ id: 'p1' })], next_cursor: 'c1' },
      { attempts: [makeLeg({ id: 'p2', attempt_seq: 2 })], next_cursor: null },
    ];
    const getCandidatePhoneAttempts = vi.fn(async () => pages.shift()!);
    const { api } = makeApi({ getCandidatePhoneAttempts });
    const data = await collectReportData({ detail: detailOf([]), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk });
    expect(data.attempts?.map((a) => a.id)).toEqual(['p1', 'p2']);
    expect(getCandidatePhoneAttempts).toHaveBeenNthCalledWith(2, expect.any(String), 'c1', expect.anything());
  });
});

describe('collectReportData: cancellation', () => {
  it('an aborted signal stops further mints and rejects with AbortError', async () => {
    const controller = new AbortController();
    const { api } = makeApi({
      legs: legsFor(4),
      getAttemptRecordingDownloadUrl: vi.fn(async (id: string) => {
        if (id === 'leg-2') controller.abort();
        return { url: 'https://signed.example/ok' };
      }),
    });
    await expect(
      collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, fetchAudio: fetchOk, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it('an already-aborted signal makes no request at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const { api } = makeApi();
    await expect(
      collectReportData({ detail: detailOf(), roleTitle: null, role: 'admin', api, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.getSession).not.toHaveBeenCalled();
  });
});

describe('mintFailureReason', () => {
  it('maps statuses to plain words and flags only 429 as rate limiting', () => {
    expect(mintFailureReason(new ApiError('x', 429)).rateLimited).toBe(true);
    expect(mintFailureReason(new ApiError('x', 404)).rateLimited).toBe(false);
    expect(mintFailureReason(new Error('x')).reason).toBe('Recording could not be loaded.');
  });
});

describe('generateCandidateReport', () => {
  it('produces the file name, the counts the audit needs, and the html', async () => {
    const { api } = makeApi();
    const report = await generateCandidateReport({
      detail: detailOf(),
      roleTitle: 'Role',
      role: 'admin',
      api,
      fetchAudio: fetchOk,
      now: () => new Date('2026-10-07T10:00:00.000Z'),
    });
    expect(report.filename).toBe('screening-report-shrinidhi-handigund-2026-10-07.html');
    expect(report.recordings).toBe(2);
    expect(report.transcript).toBe(true);
    expect(report.html.length).toBeGreaterThan(1000);
    expect('bytes' in report).toBe(false);
    expect((report.html.match(/<audio /g) ?? []).length).toBe(2);
    expect(report.html).not.toContain('SECRET');
  });
});

describe('collectReportData: R1 role-play sessions are left out', () => {
  const r1 = makeSession({ id: 'session-r1', interview_round_id: 'round-1', mode: 'browser' });

  it('does not load the transcript, legs or recording of an R1 session, and keeps it out of the plan', async () => {
    const { api, order } = makeApi();
    const data = await collectReportData({
      detail: detailOf([r1, makeSession()]),
      roleTitle: 'Role',
      role: 'admin',
      api,
      fetchAudio: fetchOk,
    });
    expect(data.sessions.map((s) => s.session.id)).toEqual(['session-1']);
    expect(data.r1Sessions?.map((s) => s.id)).toEqual(['session-r1']);
    expect(api.getSession).not.toHaveBeenCalledWith('session-r1');
    expect(order.some((o) => o.includes('session-r1'))).toBe(false);
    expect(order).toEqual(['leg:leg-1', 'leg:leg-2']);
  });

  it('plannedRecordingCount ignores R1, unfinished and simulation sessions and caps at 15', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSession({ id: `s-${i}` }));
    expect(plannedRecordingCount([r1, makeSession(), makeSession({ status: 'abandoned' }), makeSession({ mode: 'simulation' })])).toBe(1);
    expect(plannedRecordingCount([r1])).toBe(0);
    expect(plannedRecordingCount(many)).toBe(MAX_RECORDINGS);
  });
});
