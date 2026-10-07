import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneAttemptHistory } from '../CandidateOverviewSections';
import { usePhoneAttemptHistory } from '../usePhoneAttemptHistory';

const getCandidatePhoneAttempts = vi.fn();
const getAttemptRecordingDownloadUrl = vi.fn();

vi.mock('../../../api', () => ({
  api: {
    getCandidatePhoneAttempts: (...args: unknown[]) => getCandidatePhoneAttempts(...args),
    getAttemptRecordingDownloadUrl: (...args: unknown[]) => getAttemptRecordingDownloadUrl(...args),
  },
}));

const ATTEMPT = {
  id: '00000000-0000-4000-8000-000000000001',
  attempt_seq: 1,
  admitted_at: '2026-09-25T13:00:00.000Z',
  answered_at: '2026-09-25T13:00:01.000Z',
  ended_at: '2026-09-25T13:00:09.000Z',
  state: 'ended',
  outcome_class: 'abandoned_pre_disclosure',
  duration_sec: 8,
  recording: { state: 'unavailable', reason: 'no_recording' },
  transcript: {
    href: '/sessions/00000000-0000-4000-8000-000000000002',
    scope: 'session',
    kind: 'gate_only',
    shared_session: true,
  },
};

function renderHistory() {
  return render(
    <MemoryRouter>
      <PhoneAttemptHistory candidateId="candidate-1" role="admin" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getCandidatePhoneAttempts.mockResolvedValue({ attempts: [ATTEMPT], next_cursor: null });
});

describe('PhoneAttemptHistory', () => {
  it('shows gate-only evidence and a truthful no-recording state', async () => {
    renderHistory();
    expect(await screen.findByText('No recording available')).toBeInTheDocument();
    expect(screen.getByText(/Pre-interview gate transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/may include multiple call legs/i)).toBeInTheDocument();
    expect(getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('mints audio only after an explicit click and plays it inline', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://storage.invalid/signed', content_type: 'audio/mpeg' });
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = renderHistory();
    const button = await screen.findByRole('button', { name: 'Play recording' });
    // Nothing is minted on mount or on list load, and no <audio> exists yet.
    expect(getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).toBeNull();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    await waitFor(() => expect(getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(1));
    expect(getAttemptRecordingDownloadUrl).toHaveBeenCalledWith(ATTEMPT.id);
    const player = await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    expect(player).toHaveAttribute('src', 'https://storage.invalid/signed');
    expect(player).toHaveAttribute('preload', 'none');
    expect(player).toHaveAttribute('controls');
    expect(screen.getByRole('link', { name: 'Download file' })).toHaveAttribute('href', 'https://storage.invalid/signed');
    expect(screen.getByRole('button', { name: 'Hide player' })).toHaveAttribute('aria-expanded', 'true');
    // Inline, not a popup that a blocker can stop.
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it('closing the player discards the URL; reopening mints a fresh one', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl
      .mockResolvedValueOnce({ url: 'https://storage.invalid/first' })
      .mockResolvedValueOnce({ url: 'https://storage.invalid/second' });
    const { container } = renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'Play recording' }));
    await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide player' }));
    expect(container.querySelector('audio')).toBeNull();
    expect(container.innerHTML).not.toContain('storage.invalid/first');
    fireEvent.click(screen.getByRole('button', { name: 'Play recording' }));
    const player = await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    expect(player).toHaveAttribute('src', 'https://storage.invalid/second');
    expect(getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it('keeps one player open at a time', async () => {
    const second = { ...ATTEMPT, id: '00000000-0000-4000-8000-000000000021', attempt_seq: 2, recording: { state: 'ready' }, transcript: null };
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [second, { ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockImplementation(async (id: string) => ({ url: `https://storage.invalid/${id}` }));
    const { container } = renderHistory();
    const buttons = await screen.findAllByRole('button', { name: 'Play recording' });
    fireEvent.click(buttons[0]);
    await screen.findByLabelText('Attempt 2 recording', { selector: 'audio' });
    fireEvent.click(screen.getByRole('button', { name: 'Play recording' }));
    await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    expect(container.querySelectorAll('audio')).toHaveLength(1);
    expect(screen.queryByLabelText('Attempt 2 recording', { selector: 'audio' })).toBeNull();
  });

  it('tags a recording made before consent and explains that playback is logged', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [
        { ...ATTEMPT, recording: { state: 'ready' }, consent_stage: 'before_consent', transcript: null },
        { ...ATTEMPT, id: '00000000-0000-4000-8000-000000000022', attempt_seq: 2, recording: { state: 'ready' }, consent_stage: 'after_consent', transcript: null },
        // No audio: no tag even when the leg never consented.
        { ...ATTEMPT, id: '00000000-0000-4000-8000-000000000023', attempt_seq: 3, consent_stage: 'before_consent', transcript: null },
      ],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://storage.invalid/signed' });
    renderHistory();
    const tags = await screen.findAllByText('Recorded before consent');
    expect(tags).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Play recording' })[0]);
    expect(await screen.findByText(/Every playback is logged/)).toBeInTheDocument();
  });

  it('offers an explicit load for a processing recording (the route recovery path), minting only on click', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'processing' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl
      .mockRejectedValueOnce(Object.assign(new Error('Recording is still processing. Try again shortly.'), { status: 409 }))
      .mockResolvedValueOnce({ url: 'https://storage.invalid/recovered' });
    renderHistory();
    expect(await screen.findByText('Recording processing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play recording' })).toBeNull();
    expect(getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try to load recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still processing');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const player = await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    expect(player).toHaveAttribute('src', 'https://storage.invalid/recovered');
  });

  it('names a recording whose consent was withdrawn, and offers no player', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'unavailable', reason: 'revoked' }, transcript: null }],
      next_cursor: null,
    });
    renderHistory();
    expect(await screen.findByText('Recording withdrawn')).toBeInTheDocument();
    expect(screen.queryByText('No recording available')).toBeNull();
    expect(screen.queryByRole('button', { name: /recording/i })).toBeNull();
  });

  it('announces loading and ready through a persistent live region, and leaves focus on the toggle', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    let resolveMint: (v: { url: string }) => void = () => {};
    getAttemptRecordingDownloadUrl.mockImplementation(() => new Promise((r) => { resolveMint = r; }));
    renderHistory();
    const button = await screen.findByRole('button', { name: 'Play recording' });
    // Mounted before anything happens, so its later text is announced.
    const live = document.querySelector('[data-player-announcer]') as HTMLElement;
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('');
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(live).toHaveTextContent('Loading recording'));
    resolveMint({ url: 'https://storage.invalid/signed' });
    await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    expect(live).toHaveTextContent('Recording ready');
    expect(screen.getByRole('button', { name: 'Hide player' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Hide player' }));
    expect(live).toHaveTextContent('');
  });

  it('names a quarantined and a deleted recording and offers no player for either', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [
        { ...ATTEMPT, recording: { state: 'unavailable', reason: 'quarantined' }, consent_stage: 'before_consent', transcript: null },
        { ...ATTEMPT, id: '00000000-0000-4000-8000-000000000024', attempt_seq: 2, recording: { state: 'unavailable', reason: 'deleted' }, consent_stage: 'before_consent', transcript: null },
      ],
      next_cursor: null,
    });
    renderHistory();
    expect(await screen.findByText('Recording withheld (failed integrity check)')).toBeInTheDocument();
    expect(screen.getByText('Recording deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play recording' })).toBeNull();
    expect(screen.queryByText('Recorded before consent')).toBeNull();
    expect(getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('reports a failed mint as an alert and retries on request', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl
      .mockRejectedValueOnce(Object.assign(new Error('Internal error'), { status: 500 }))
      .mockResolvedValueOnce({ url: 'https://storage.invalid/retried' });
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'Play recording' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the recording.");
    // A failed mint is not a failed history: the list stays.
    expect(screen.queryByText('Attempt history unavailable.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const player = await screen.findByLabelText('Attempt 1 recording', { selector: 'audio' });
    expect(player).toHaveAttribute('src', 'https://storage.invalid/retried');
  });

  it('explains a quarantine or deletion discovered at click time, without a retry', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [
        { ...ATTEMPT, recording: { state: 'ready' }, transcript: null },
        { ...ATTEMPT, id: '00000000-0000-4000-8000-000000000025', attempt_seq: 2, recording: { state: 'ready' }, transcript: null },
      ],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockImplementation(async (id: string) => {
      throw id === ATTEMPT.id
        ? Object.assign(new Error('Recording is quarantined'), { status: 409 })
        : Object.assign(new Error('Forbidden'), { status: 403 });
    });
    renderHistory();
    const [first, second] = await screen.findAllByRole('button', { name: 'Play recording' });
    fireEvent.click(first);
    expect(await screen.findByRole('alert')).toHaveTextContent('Recording withheld: it failed an integrity check.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(second);
    expect(await screen.findByRole('alert')).toHaveTextContent('it was deleted or access was withdrawn');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers a retry while a recording is still processing at click time', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockRejectedValueOnce(
      Object.assign(new Error('Recording is still processing. Try again shortly.'), { status: 409 }),
    );
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'Play recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still processing');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('ignores a late mint after the player was closed', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    let resolveMint: (value: { url: string }) => void = () => {};
    getAttemptRecordingDownloadUrl.mockImplementation(() => new Promise((resolve) => { resolveMint = resolve; }));
    const { container } = renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'Play recording' }));
    await waitFor(() => expect(getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Hide player' }));
    resolveMint({ url: 'https://storage.invalid/late' });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('audio')).toBeNull();
    expect(container.innerHTML).not.toContain('storage.invalid/late');
  });

  it('renders a shared list without fetching it again', async () => {
    render(
      <MemoryRouter>
        <PhoneAttemptHistory
          candidateId="candidate-1"
          role="viewer"
          title="Call recordings"
          source={{
            attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }] as never,
            nextCursor: null,
            error: false,
            reload: vi.fn(),
            loadOlder: vi.fn(),
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Call recordings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play recording' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(getCandidatePhoneAttempts).not.toHaveBeenCalled();
  });

  it('labels a lease-reclaimed attempt "Call interrupted" and only an infra defer "Not placed"', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [
        {
          ...ATTEMPT,
          id: '00000000-0000-4000-8000-000000000011',
          attempt_seq: 2,
          state: 'abandoned',
          abandon_reason: null,
          outcome_class: null,
          recording: { state: 'ready' },
          transcript: null,
        },
        {
          ...ATTEMPT,
          id: '00000000-0000-4000-8000-000000000012',
          attempt_seq: 1,
          state: 'abandoned',
          abandon_reason: 'infra_deferred',
          outcome_class: null,
          answered_at: null,
          duration_sec: null,
          transcript: null,
        },
      ],
      next_cursor: null,
    });
    renderHistory();
    const interrupted = await screen.findByText('Call interrupted');
    expect(interrupted).toHaveAttribute('title', 'state: abandoned');
    const notPlaced = screen.getByText('Not placed');
    expect(notPlaced).toHaveAttribute('title', 'state: abandoned · abandon_reason: infra_deferred');
    expect(screen.getAllByText('Not placed')).toHaveLength(1);
  });
});

/*
 * M013 S02: per-leg connected and recorded figures with the truthful notes,
 * and the two new consent tags. Anonymised session shapes, synthetic times.
 */
describe('PhoneAttemptHistory per-leg truth (M013 S02)', () => {
  const T0 = Date.parse('2026-10-05T03:30:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const LEG = {
    ...ATTEMPT,
    state: 'completed',
    outcome_class: 'disconnected',
    recording: { state: 'ready' },
    consent_stage: 'after_consent',
    transcript: null,
  };

  it('the 9f60523d shape: a reconciler-detected leg with an estimated recording, and a leg whose end nobody observed', async () => {
    // Leg A was ended by our reconciler's sip.participant_left (its
    // DETECTION time, ~14 s after the hang-up), so the API reads it
    // `detected`, with no length (review round 2 nit).
    const legA = {
      ...LEG,
      id: '00000000-0000-4000-8000-000000000031',
      attempt_seq: 1,
      admitted_at: iso(T0),
      answered_at: iso(T0 + 10_000),
      ended_at: iso(T0 + 85_000),
      duration_sec: null,
      connected_from: iso(T0 + 10_000),
      connected_to: iso(T0 + 85_000),
      connected_to_source: 'detected',
      connected_sec: null,
      recorded_sec: 53.2,
      recorded_sec_estimated: true,
      tail_may_be_missing: true,
    };
    const legB = {
      ...LEG,
      id: '00000000-0000-4000-8000-000000000032',
      attempt_seq: 2,
      state: 'abandoned',
      abandon_reason: null,
      outcome_class: null,
      admitted_at: iso(T0 + 240_000),
      answered_at: iso(T0 + 250_000),
      // The lease reclaim DETECTED the drop 6m 8s after the answer.
      ended_at: iso(T0 + 618_000),
      duration_sec: null,
      connected_from: iso(T0 + 250_000),
      connected_to: iso(T0 + 618_000),
      connected_to_source: 'unobserved',
      connected_sec: null,
      recorded_sec: 17.6,
      recorded_sec_estimated: false,
      tail_may_be_missing: false,
    };
    getCandidatePhoneAttempts.mockResolvedValue({ attempts: [legB, legA], next_cursor: null });
    const { container } = renderHistory();
    await screen.findByText('Attempt 2');
    const rows = Array.from(container.querySelectorAll('li'));
    const [rowB, rowA] = rows;

    expect(rowA.textContent).toContain('Connected, end time approximate · Recorded ≈53s (estimated)');
    expect(rowA.textContent).not.toContain('1m 15s');
    expect(rowA.querySelector('[data-attempt-note="tail"]')?.textContent).toBe(
      'This recording may end a few seconds before the call did.',
    );
    expect(rowA.querySelector('[data-attempt-note="unobserved"]')?.textContent).toMatch(
      /^End time approximate: our check found the call over by \d\d:\d\d IST\.$/,
    );

    expect(rowB.textContent).toContain('Connected, end not observed · Recorded 18s');
    expect(rowB.querySelector('[data-attempt-note="unobserved"]')?.textContent).toMatch(
      /^Line dropped; end not observed \(detected \d\d:\d\d IST by timeout\)\.$/,
    );
    expect(rowB.querySelector('[data-attempt-note="tail"]')).toBeNull();
    // No reclaim span is presented as a call length anywhere.
    expect(container.textContent).not.toMatch(/6m 8s|6m 7s|7m 23s|1m 15s/);
    // An ordinary consented leg carries no consent tag.
    expect(container.querySelector('[data-attempt-consent]')).toBeNull();
  });

  it('the 32757295 shape: before consent, recorded and connected within 3 s, no truncation note', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{
        ...LEG,
        outcome_class: 'voicemail',
        consent_stage: 'before_consent',
        duration_sec: 34.6,
        connected_from: iso(T0),
        connected_to: iso(T0 + 34_600),
        connected_to_source: 'observed',
        connected_sec: 34.6,
        recorded_sec: 32.7,
        recorded_sec_estimated: false,
        tail_may_be_missing: false,
      }],
      next_cursor: null,
    });
    const { container } = renderHistory();
    // The outcome shows AS RECORDED (D10: S02 does not relabel it).
    expect(await screen.findByText('Voicemail')).toBeInTheDocument();
    expect(container.textContent).toContain('Connected 35s · Recorded 33s');
    expect(screen.getByText('Recorded before consent')).toBeInTheDocument();
    expect(container.querySelector('[data-attempt-note]')).toBeNull();
  });

  it('a payload without the per-leg fields keeps its duration as the connected length', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({ attempts: [{ ...LEG, duration_sec: 84 }], next_cursor: null });
    const { container } = renderHistory();
    await screen.findByText('Attempt 1');
    expect(container.textContent).toContain('Connected 1m 24s');
    expect(container.textContent).not.toContain('Recorded ');
  });

  it('tags a withdrawn consent and an in-call callback request, each with its own retention note', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [
        { ...LEG, id: '00000000-0000-4000-8000-000000000041', attempt_seq: 2, consent_stage: 'deferred_after_consent' },
        { ...LEG, id: '00000000-0000-4000-8000-000000000042', attempt_seq: 1, consent_stage: 'consent_withdrawn' },
        // No audio: no tag, whatever the stage.
        { ...LEG, id: '00000000-0000-4000-8000-000000000043', attempt_seq: 3, consent_stage: 'consent_withdrawn',
          recording: { state: 'unavailable', reason: 'no_recording' } },
      ],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://storage.invalid/signed' });
    renderHistory();
    expect(await screen.findAllByText('Consent withdrawn – recording kept')).toHaveLength(1);
    expect(screen.getAllByText('Callback requested after consent – recording kept')).toHaveLength(1);
    // A deferral is never worded as a withdrawal.
    expect(screen.queryByText(/Callback requested.*withdr/i)).toBeNull();

    const [deferredPlay, withdrawnPlay] = screen.getAllByRole('button', { name: 'Play recording' });
    fireEvent.click(withdrawnPlay);
    expect(await screen.findByText(/withdrew consent on this call.*2026-09-26 retention decision/)).toBeInTheDocument();
    fireEvent.click(deferredPlay);
    expect(await screen.findByText(/asked to be called back later.*2026-09-26 retention decision/)).toBeInTheDocument();
  });
});

describe('usePhoneAttemptHistory', () => {
  it("drops the previous candidate's attempts as soon as the candidate changes", async () => {
    const forA = { attempts: [{ ...ATTEMPT, id: 'a-1' }], next_cursor: 'cursor-a' };
    let resolveB: (v: unknown) => void = () => {};
    getCandidatePhoneAttempts.mockImplementation((id: string) =>
      id === 'cand-a' ? Promise.resolve(forA) : new Promise((r) => { resolveB = r; }));
    const { result, rerender } = renderHook(({ id }) => usePhoneAttemptHistory(id), {
      initialProps: { id: 'cand-a' },
    });
    await waitFor(() => expect(result.current.attempts?.[0]?.id).toBe('a-1'));
    expect(result.current.nextCursor).toBe('cursor-a');

    rerender({ id: 'cand-b' });
    // B is still loading: nothing of A's (no rows, no cursor, no play buttons).
    expect(result.current.attempts).toBeNull();
    expect(result.current.nextCursor).toBeNull();

    // The request is issued from a microtask; resolve it once it exists.
    await waitFor(() => expect(getCandidatePhoneAttempts).toHaveBeenCalledWith('cand-b', undefined));
    expect(result.current.attempts).toBeNull();
    resolveB({ attempts: [{ ...ATTEMPT, id: 'b-1' }], next_cursor: null });
    await waitFor(() => expect(result.current.attempts?.[0]?.id).toBe('b-1'));
  });

  it('clears the list when switched off', async () => {
    const { result, rerender } = renderHook(({ on }) => usePhoneAttemptHistory('cand-a', on), {
      initialProps: { on: true },
    });
    await waitFor(() => expect(result.current.attempts).not.toBeNull());
    rerender({ on: false });
    expect(result.current.attempts).toBeNull();
  });
});
