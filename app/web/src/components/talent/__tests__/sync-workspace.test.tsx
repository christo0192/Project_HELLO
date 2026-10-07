/**
 * TranscriptionSyncWorkspace — the unified review workspace. Covers session
 * selection, transcript load, session context header, session scorecard,
 * seek sync, load-and-seek-before-load, retry, non-admin 403 fallback, axe.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import type { Session, Assessment, CandidatePhoneAttempt, TranscriptLine } from '../../../types';

const SESSION_COMPLETED_LIVE: Session = {
  id: 'session-1',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'live',
  duration_sec: 120,
  created_at: '2026-01-01T00:00:00.000Z',
};

const SESSION_COMPLETED_SIM: Session = {
  id: 'session-2',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'simulation',
  created_at: '2026-01-02T00:00:00.000Z',
};

const ASSESSMENT: Assessment = {
  id: 'a1',
  overall_score: 78,
  recommendation: 'advance',
  summary: 'Solid.',
  tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: '' },
  role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: '' },
  raw: null,
};

const NO_ASSESSMENTS: Assessment[] = [];

const mockApi = { getSession: vi.fn(), getCandidatePhoneAttempts: vi.fn() };
const mockRecordingApi = { getRecordingDownloadUrl: vi.fn(), getAttemptRecordingDownloadUrl: vi.fn() };

vi.mock('../../../api', () => ({
  api: {
    getSession: (...args: any[]) => mockApi.getSession(...args),
    getRecordingDownloadUrl: (...args: any[]) => mockRecordingApi.getRecordingDownloadUrl(...args),
    getAttemptRecordingDownloadUrl: (...args: any[]) => mockRecordingApi.getAttemptRecordingDownloadUrl(...args),
    getCandidatePhoneAttempts: (...args: any[]) => mockApi.getCandidatePhoneAttempts(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__allowConsole?.(/inside a test was not wrapped in act/);
  (globalThis as any).__allowConsole?.(/ReactDOMTestUtils/);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return 0; },
    set(_v: number) {},
  });
  // Default: a completed session with a transcript + no assessment.
  mockApi.getSession.mockResolvedValue({
    session: SESSION_COMPLETED_LIVE,
    transcript: [{ speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 }],
    assessment: null,
  });
});

describe('TranscriptionSyncWorkspace', () => {
  it('auto-loads transcript for the first completed session', async () => {
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    expect(await screen.findByText('Hello!')).toBeInTheDocument();
  });

  it('renders a session selector with completed sessions and context', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE, SESSION_COMPLETED_SIM]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('shows the session scorecard returned with the transcript', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [{ speaker: 'bot' as const, text: 'Hi', start_offset_sec: 0 }],
      assessment: ASSESSMENT,
    });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    expect(await screen.findByText('Scorecard for this session')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('does not auto-fetch the recording URL (explicit action only)', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION_COMPLETED_LIVE, transcript: [], assessment: null });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await screen.findByText(/no transcript lines/i);
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();
  });

  it('shows an error and a working retry when transcript load fails', async () => {
    mockApi.getSession.mockRejectedValueOnce({ message: 'transcript unavailable' });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    expect(await screen.findByText('transcript unavailable')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /try again/i });
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [{ speaker: 'bot' as const, text: 'Retried!', start_offset_sec: 0.0 }],
      assessment: null,
    });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Retried!')).toBeInTheDocument();
  });

  it('falls back to a permission note + latest scorecard for non-admins (403)', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={[ASSESSMENT]} blocked={false} />,
    );
    expect(
      await screen.findByText(/require admin access/i),
    ).toBeInTheDocument();
    // The viewer-visible latest scorecard is still shown.
    expect(screen.getByText('Latest scorecard')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('shows an empty state when no completed sessions exist', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[{ ...SESSION_COMPLETED_LIVE, status: 'in_progress' }]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
      />,
    );
    expect(screen.getByText(/No completed sessions with recordings yet/i)).toBeInTheDocument();
  });

  it('lists the call recordings under the empty state when the host provides them', () => {
    render(
      <TranscriptionSyncWorkspace
        sessions={[{ ...SESSION_COMPLETED_LIVE, status: 'expired' }]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
        callRecordings={<section aria-label="Call recordings">attempt list</section>}
      />,
    );
    expect(screen.getByText(/No completed screening yet/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Call recordings' })).toHaveTextContent('attempt list');
    expect(screen.queryByText(/No completed sessions with recordings yet/i)).toBeNull();
  });

  it('does not render the call recordings once a session has completed', () => {
    mockApi.getSession.mockReturnValue(new Promise(() => {}));
    render(
      <TranscriptionSyncWorkspace
        sessions={[SESSION_COMPLETED_LIVE]}
        assessments={NO_ASSESSMENTS}
        blocked={false}
        callRecordings={<section aria-label="Call recordings">attempt list</section>}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Call recordings' })).toBeNull();
  });

  it('suppresses the scorecard when appeal-blocked', () => {
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={true} />,
    );
    expect(
      screen.getByText(/Scorecards are suppressed while an appeal is under review/i),
    ).toBeInTheDocument();
  });

  it('mints the URL, waits for the audio, then seeks + plays on a click made BEFORE the recording is loaded', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [
        { speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 },
        { speaker: 'candidate' as const, text: 'Answer.', start_offset_sec: 5 },
      ],
      assessment: null,
    });
    mockRecordingApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() { return 2; },
    });
    const setCurrentTime = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return 0; },
      set: setCurrentTime,
    });

    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    const turnBtn = await screen.findByRole('button', { name: /Turn 2:.*Candidate/i });
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();

    fireEvent.click(turnBtn);

    await waitFor(() =>
      expect(mockRecordingApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
    );
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(setCurrentTime).toHaveBeenCalledWith(5);
  });

  it('has no axe violations', async () => {
    mockApi.getSession.mockResolvedValue({
      session: SESSION_COMPLETED_LIVE,
      transcript: [
        { speaker: 'bot' as const, text: 'Hello!', start_offset_sec: 0.0 },
        { speaker: 'candidate' as const, text: 'Hi!', start_offset_sec: 3.5 },
      ],
      assessment: null,
    });
    const { container } = render(
      <TranscriptionSyncWorkspace sessions={[SESSION_COMPLETED_LIVE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await screen.findByText('Hello!');
    await expect(container).toHaveNoViolations();
  });
});

/* ── M013 S02 (T08a): every leg of a phone session, grouped transcript ── */

// Anonymised, synthetic: the TIMINGS of the two-leg case (leg 1 ended by the
// ledger with a legacy estimated recording; leg 2 a reconnect whose end was
// never observed), no real names, numbers or audio.
const ANS_A = Date.parse('2026-10-05T03:30:46.800Z');
const ANS_B = Date.parse('2026-10-05T03:34:49.600Z');
const REC_B = ANS_B + 1050;

const SESSION_PHONE: Session = {
  id: 'session-phone',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'live',
  // 0125 excludes the unobserved leg: 75 s is NOT what was recorded, and
  // the picker must not present it as the length.
  duration_sec: 75,
  duration_unobserved_legs: 1,
  recorded_total_sec: 70.8,
  recorded_legs: 2,
  connected_complete: false,
  connected_total_sec: null,
  created_at: '2026-10-05T03:30:00.000Z',
};

function leg(over: Partial<CandidatePhoneAttempt> & Pick<CandidatePhoneAttempt, 'id' | 'attempt_seq' | 'admitted_at'>): CandidatePhoneAttempt {
  return {
    answered_at: null,
    ended_at: null,
    state: 'completed',
    abandon_reason: null,
    outcome_class: null,
    duration_sec: null,
    connected_from: null,
    connected_to: null,
    connected_to_source: null,
    connected_sec: null,
    recorded_sec: null,
    recorded_sec_estimated: false,
    recording_started_at_ms: null,
    tail_may_be_missing: false,
    session_ref: 'session-phone',
    recording: { state: 'ready' },
    consent_stage: 'after_consent',
    transcript: null,
    ...over,
  };
}

const LEG_A = leg({
  id: 'leg-a',
  attempt_seq: 1,
  admitted_at: '2026-10-05T03:30:30.000Z',
  answered_at: '2026-10-05T03:30:46.800Z',
  ended_at: '2026-10-05T03:32:02.400Z',
  outcome_class: 'disconnected',
  duration_sec: 75.6,
  connected_from: '2026-10-05T03:30:46.800Z',
  connected_to: '2026-10-05T03:32:02.400Z',
  connected_to_source: 'ledger',
  connected_sec: 75.6,
  recorded_sec: 53.2,
  recorded_sec_estimated: true,
  tail_may_be_missing: true,
});

const LEG_B = leg({
  id: 'leg-b',
  attempt_seq: 2,
  admitted_at: '2026-10-05T03:34:30.000Z',
  answered_at: '2026-10-05T03:34:49.600Z',
  ended_at: '2026-10-05T03:40:57.500Z',
  state: 'abandoned',
  connected_from: '2026-10-05T03:34:49.600Z',
  connected_to: '2026-10-05T03:40:57.500Z',
  connected_to_source: 'unobserved',
  recorded_sec: 17.6,
  recording_started_at_ms: REC_B,
});

const PHONE_TRANSCRIPT: TranscriptLine[] = [
  { speaker: 'bot', text: 'Opening line.', start_offset_sec: null, started_at_ms: ANS_A + 1000 + 2000 },
  { speaker: 'bot', text: 'First question.', start_offset_sec: null, started_at_ms: ANS_A + 1000 + 54_660 },
  { speaker: 'bot', text: 'Welcome back.', start_offset_sec: null, started_at_ms: REC_B + 3000 },
  { speaker: 'candidate', text: 'Okay.', start_offset_sec: null, started_at_ms: REC_B + 10_500 },
  { speaker: 'bot', text: 'A turn saved without timing.', start_offset_sec: null, started_at_ms: null },
];

function renderPhone(over: { legs?: CandidatePhoneAttempt[]; transcript?: TranscriptLine[]; session?: Session } = {}) {
  const session = over.session ?? SESSION_PHONE;
  mockApi.getSession.mockResolvedValue({
    session,
    transcript: over.transcript ?? PHONE_TRANSCRIPT,
    assessment: null,
  });
  // The API lists a session's legs OLDEST first; the fixture is reversed to
  // prove the workspace orders them itself.
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({
    attempts: (over.legs ?? [LEG_A, LEG_B]).slice().reverse(),
    next_cursor: null,
  });
  return render(
    <TranscriptionSyncWorkspace sessions={[session]} assessments={NO_ASSESSMENTS} blocked={false} candidateId="c1" />,
  );
}

function stubSeekableMedia() {
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return 2; } });
  const setCurrentTime = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() { return 0; }, set: setCurrentTime });
  return setCurrentTime;
}

describe('TranscriptionSyncWorkspace: phone legs (M013 S02)', () => {
  it('loads only the selected session legs, and only for a phone session with a candidate', async () => {
    renderPhone();
    await screen.findByRole('list', { name: 'Calls in this session' });
    expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalledTimes(1);
    expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalledWith('c1', undefined, { sessionId: 'session-phone', limit: 50 });
  });

  it('does not list legs without a candidate id (the scoped host) or for a browser session', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION_PHONE, transcript: PHONE_TRANSCRIPT, assessment: null });
    const { unmount } = render(
      <TranscriptionSyncWorkspace sessions={[SESSION_PHONE]} assessments={NO_ASSESSMENTS} blocked={false} />,
    );
    await screen.findByText('Welcome back.');
    expect(mockApi.getCandidatePhoneAttempts).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Calls in this session' })).toBeNull();
    unmount();

    const browser: Session = { ...SESSION_COMPLETED_LIVE, id: 'session-browser', mode: 'browser', duration_sec: 300 };
    mockApi.getSession.mockResolvedValue({ session: browser, transcript: [], assessment: null });
    render(
      <TranscriptionSyncWorkspace sessions={[browser]} assessments={NO_ASSESSMENTS} blocked={false} candidateId="c1" />,
    );
    await screen.findByText(/no transcript lines/i);
    expect(mockApi.getCandidatePhoneAttempts).not.toHaveBeenCalled();
    // A browser session keeps its own length in the picker.
    expect(screen.getByRole('option')).toHaveTextContent('5m 0s');
  });

  it('shows every leg in order with its window, recorded length and truthful notes', async () => {
    renderPhone();
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent('Call 1 of 2 · first call');
    expect(rows[0]).toHaveTextContent('Dropped mid-call');
    expect(rows[0]).toHaveTextContent('Connected 09:00–09:02 IST (1m 16s)');
    expect(rows[0]).toHaveTextContent('Recorded ≈53s (estimated)');
    expect(rows[0]).toHaveTextContent('This recording may end a few seconds before the call did.');
    expect(rows[0]).not.toHaveTextContent(/end not observed/);

    expect(rows[1]).toHaveTextContent('Call 2 of 2 · reconnect');
    expect(rows[1]).toHaveTextContent('Connected from 09:04 IST');
    expect(rows[1]).toHaveTextContent('Recorded 18s');
    expect(rows[1]).toHaveTextContent('Line dropped; end not observed (detected 09:10 IST by timeout).');
    expect(rows[1]).not.toHaveTextContent(/may end a few seconds/);
    // The reclaim span (about 6 minutes) is never presented as the call length.
    expect(rows[1]).not.toHaveTextContent(/6m/);
  });

  it('the picker shows the recorded total across the calls, never duration_sec', async () => {
    renderPhone();
    await screen.findByRole('list', { name: 'Calls in this session' });
    const option = screen.getByRole('option');
    expect(option).toHaveTextContent('Recorded 1m 11s across 2 calls');
    expect(option).not.toHaveTextContent('1m 15s');
  });

  it('a phone session with no recorded facts shows no length rather than duration_sec', async () => {
    const bare: Session = { ...SESSION_PHONE, recorded_total_sec: null, recorded_legs: null };
    renderPhone({ session: bare });
    await screen.findByRole('list', { name: 'Calls in this session' });
    expect(screen.getByRole('option')).not.toHaveTextContent(/1m 15s|Recorded/);
  });

  it('mints nothing on load; each leg has its own player named after the leg', async () => {
    renderPhone();
    await screen.findByRole('list', { name: 'Calls in this session' });
    await screen.findByText('Welcome back.');
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    // One load button per leg; no separate session player.
    expect(screen.getAllByRole('button', { name: /load recording/i })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Call 1 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Call 2 of 2' })).toBeInTheDocument();

    mockRecordingApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/leg-b' });
    const rows = within(screen.getByRole('list', { name: 'Calls in this session' })).getAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-b'));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    const audio = document.querySelector('audio')!;
    expect(audio).toHaveAttribute('aria-label', 'Call 2 of 2 recording player');
    expect(audio).toHaveAttribute('preload', 'none');
    expect(audio).not.toHaveAttribute('id');
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('groups the transcript by leg; legacy leg times are marked approximate, untimed turns go last', async () => {
    renderPhone();
    const first = await screen.findByRole('group', { name: 'Call 1 of 2 · first call' });
    const second = screen.getByRole('group', { name: 'Call 2 of 2 · reconnect' });
    const untimed = screen.getByRole('group', { name: 'Turns without timing' });

    expect(within(first).getByText('Opening line.')).toBeInTheDocument();
    expect(within(first).getByText('First question.')).toBeInTheDocument();
    expect(within(first).getByText(/estimated from when it was answered/)).toBeInTheDocument();
    // answered + 1 s fallback: 2.0 s and 54.66 s into the legacy file.
    expect(within(first).getByRole('button', { name: /^Turn 1: .*\. At about 0:02\. Click to play from here\.$/ })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: /Turn 2:.*At about 0:54/ })).toHaveTextContent('≈0:54');

    expect(within(second).getByText('Welcome back.')).toBeInTheDocument();
    expect(within(second).queryByText(/estimated from when it was answered/)).toBeNull();
    // Turn numbers stay session-wide.
    expect(within(second).getByRole('button', { name: /^Turn 3: .*\. At 0:03\. Click to play from here\.$/ })).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: /Turn 4:.*At 0:10/ })).toBeInTheDocument();

    expect(within(untimed).getByText('A turn saved without timing.')).toBeInTheDocument();
  });

  it('a turn click seeks within ITS leg file, minting that leg only', async () => {
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/leg' });
    const setCurrentTime = stubSeekableMedia();

    renderPhone();
    const second = await screen.findByRole('group', { name: 'Call 2 of 2 · reconnect' });
    fireEvent.click(within(second).getByRole('button', { name: /Turn 3:/ }));

    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-b'));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(setCurrentTime).toHaveBeenCalledWith(3);
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalledWith('leg-a');
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();

    // A legacy leg seeks at its estimated offset in its own file.
    const first = screen.getByRole('group', { name: 'Call 1 of 2 · first call' });
    fireEvent.click(within(first).getByRole('button', { name: /Turn 2:/ }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-a'));
    await waitFor(() => expect(setCurrentTime).toHaveBeenCalledWith(54.66));
  });

  it('a single pre-consent leg: listed under its session, outcome as recorded, no notes', async () => {
    const answered = Date.parse('2026-10-05T05:00:10.000Z');
    const only = leg({
      id: 'leg-only',
      attempt_seq: 1,
      admitted_at: '2026-10-05T05:00:00.000Z',
      answered_at: '2026-10-05T05:00:10.000Z',
      ended_at: '2026-10-05T05:00:44.600Z',
      outcome_class: 'voicemail',
      connected_from: '2026-10-05T05:00:10.000Z',
      connected_to: '2026-10-05T05:00:44.600Z',
      connected_to_source: 'ledger',
      connected_sec: 34.6,
      recorded_sec: 32.7,
      recording_started_at_ms: answered + 1000,
      consent_stage: 'before_consent',
    });
    renderPhone({
      legs: [only],
      session: { ...SESSION_PHONE, recorded_total_sec: 32.7, recorded_legs: 1 },
      transcript: [{ speaker: 'bot', text: 'Hello.', start_offset_sec: null, started_at_ms: answered + 1500 }],
    });
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    const row = within(list).getByRole('listitem');
    expect(row).toHaveTextContent('Call 1 of 1 · first call');
    expect(row).toHaveTextContent('Voicemail');
    expect(row).toHaveTextContent('Connected 10:30–10:30 IST (35s)');
    expect(row).toHaveTextContent('Recorded 33s');
    expect(row).not.toHaveTextContent(/may end a few seconds|end not observed/);
    // T08b: the same consent tag as the call-attempt list.
    expect(within(row).getByText('Recorded before consent')).toBeInTheDocument();
    expect(screen.getByRole('option')).toHaveTextContent('Recorded 33s');
    expect(screen.getByRole('option')).not.toHaveTextContent('across');
  });

  it('T08b: tags a withdrawn consent and an in-call callback request on their legs only', async () => {
    renderPhone({
      legs: [
        { ...LEG_A, consent_stage: 'deferred_after_consent' },
        { ...LEG_B, consent_stage: 'consent_withdrawn' },
      ],
    });
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    const [rowA, rowB] = within(list).getAllByRole('listitem');
    expect(within(rowA).getByText('Callback requested after consent – recording kept')).toBeInTheDocument();
    expect(within(rowA).queryByText(/Consent withdrawn/)).toBeNull();
    expect(within(rowB).getByText('Consent withdrawn – recording kept')).toBeInTheDocument();
    expect(within(rowB).queryByText(/Callback requested/)).toBeNull();
  });

  it('T08b: an ordinary consented leg carries no consent tag', async () => {
    renderPhone();
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    expect(list.querySelector('[data-leg-consent]')).toBeNull();
  });

  it('when no leg can be played, the session player stays and turns seek it with the session offsets', async () => {
    const anchor = Date.parse('2026-10-05T03:30:47.000Z');
    mockRecordingApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/session' });
    const setCurrentTime = stubSeekableMedia();

    renderPhone({
      session: { ...SESSION_PHONE, recording_egress_started_at_ms: anchor },
      legs: [
        { ...LEG_A, recording: { state: 'unavailable', reason: 'no_recording' } },
        { ...LEG_B, recording: { state: 'unavailable', reason: 'recording_failed' } },
      ],
      // An egress-era session: offsets from the session anchor, no own stamp.
      transcript: [
        { speaker: 'bot', text: 'Egress turn one.', start_offset_sec: 4 },
        { speaker: 'bot', text: 'Egress turn two.', start_offset_sec: 260 },
      ],
    });
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    expect(within(list).getByText('No recording available')).toBeInTheDocument();
    expect(within(list).getByText('Recording unavailable (capture failed)')).toBeInTheDocument();
    expect(screen.getByText(/the session recording follows/)).toBeInTheDocument();

    // The anchor places turn two in the reconnect; the click seeks the SESSION file.
    const second = await screen.findByRole('group', { name: 'Call 2 of 2 · reconnect' });
    fireEvent.click(within(second).getByRole('button', { name: /Turn 2:.*At 4:20/ }));
    await waitFor(() => expect(mockRecordingApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-phone'));
    await waitFor(() => expect(setCurrentTime).toHaveBeenCalledWith(260));
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('a session with no listed legs keeps the single session player', async () => {
    renderPhone({ legs: [] });
    await screen.findByText('Welcome back.');
    expect(screen.queryByRole('list', { name: 'Calls in this session' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /load recording/i })).toHaveLength(1);
  });

  it('a failed leg list says so, keeps the session player, and retries', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION_PHONE, transcript: PHONE_TRANSCRIPT, assessment: null });
    mockApi.getCandidatePhoneAttempts.mockRejectedValueOnce(new Error('boom'));
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_PHONE]} assessments={NO_ASSESSMENTS} blocked={false} candidateId="c1" />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The calls in this session could not be listed.');
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();

    mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [LEG_A, LEG_B], next_cursor: null });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('list', { name: 'Calls in this session' });
    expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalledTimes(2);
  });

  it('follows the leg cursor so a long session lists every leg', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION_PHONE, transcript: [], assessment: null });
    mockApi.getCandidatePhoneAttempts
      .mockResolvedValueOnce({ attempts: [LEG_A], next_cursor: 'cursor-1' })
      .mockResolvedValueOnce({ attempts: [LEG_B], next_cursor: null });
    render(
      <TranscriptionSyncWorkspace sessions={[SESSION_PHONE]} assessments={NO_ASSESSMENTS} blocked={false} candidateId="c1" />,
    );
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(mockApi.getCandidatePhoneAttempts).toHaveBeenLastCalledWith('c1', 'cursor-1', { sessionId: 'session-phone', limit: 50 });
  });

  it('has no axe violations with two legs and a grouped transcript', async () => {
    const { container } = renderPhone();
    await screen.findByRole('group', { name: 'Call 2 of 2 · reconnect' });
    await expect(container).toHaveNoViolations();
  });
});
