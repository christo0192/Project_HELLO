/**
 * CandidateDetailPage x R1 recordings: both tab panels stay mounted, so the page must tell each
 * recording whether its tab is the open one. A recording on a hidden tab pauses (its position and
 * link survive); switching back does not restart it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail, mockSession, mockSessionDetail } from '../test/helpers';

const mockApi = vi.hoisted(() => ({
  getCandidate: vi.fn(),
  getSession: vi.fn(),
  listNotes: vi.fn(),
  listAppeals: vi.fn(),
  getCandidateAshbyWorkflow: vi.fn(),
  listR1Rounds: vi.fn(),
  getR1Availability: vi.fn(),
  getR1Recording: vi.fn(),
  getCandidatePhoneAttempts: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
}));

vi.mock('../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('../lib/supabase', () => {
  const makeChannel = () => {
    const channel: Record<string, unknown> = {};
    channel.on = () => channel;
    channel.subscribe = () => 'mock-sub';
    return channel;
  };
  const makeQuery = () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: null, error: null });
    return q;
  };
  return {
    supabase: { from: () => makeQuery(), channel: () => makeChannel(), removeChannel: () => undefined },
  };
});

const START = 1_790_000_000_000;
const R1_SESSION = { ...mockSession, id: 'session-1', mode: 'browser', interview_round_id: 'round-1' };
const SUMMARY = {
  state: 'ready' as const,
  reason: null,
  mode: 'single' as const,
  has_video: true,
  started_at_ms: START,
  duration_ms: 600_000,
  camera_off_ms: 0,
  degraded_at_ms: null,
  retention_until: '2027-01-12T10:00:00.000Z',
  deleted_at: null,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/candidates/candidate-1']}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A position-and-sound stub for one media element, so a test can see whether it was told to pause. */
function drive(el: HTMLMediaElement) {
  const state = { paused: true, pause: vi.fn(), play: vi.fn() };
  state.play.mockImplementation(() => {
    state.paused = false;
    return Promise.resolve();
  });
  state.pause.mockImplementation(() => {
    state.paused = true;
  });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => state.paused });
  el.play = state.play as unknown as HTMLMediaElement['play'];
  el.pause = state.pause as unknown as HTMLMediaElement['pause'];
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [R1_SESSION] });
  mockApi.getSession.mockResolvedValue({
    ...mockSessionDetail,
    session: R1_SESSION,
    transcript: [
      { speaker: 'bot', text: 'Hi there.', start_offset_sec: null, started_at_ms: START + 5_000 },
      { speaker: 'candidate', text: 'Hello.', start_offset_sec: null, started_at_ms: START + 20_000 },
    ],
  });
  mockApi.listNotes.mockResolvedValue({ notes: [] });
  mockApi.listAppeals.mockResolvedValue({ appeals: [] });
  mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: null });
  mockApi.getR1Availability.mockResolvedValue({ state: 'disabled', hold_minutes: 55 });
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
  mockApi.listR1Rounds.mockResolvedValue({
    rounds: [
      {
        id: 'round-1',
        status: 'completed',
        expires_at: '2026-10-09T10:00:00.000Z',
        attempts_allowed: 2,
        attempts_counted: 1,
        recommendation: null,
        overall: null,
        created_at: '2026-10-06T10:00:00.000Z',
        attempts: [{ session_id: 'session-1', attempt_number: 1, counted: true, outcome: 'completed', recording: SUMMARY }],
      },
    ],
  });
  mockApi.getR1Recording.mockResolvedValue({
    ...SUMMARY,
    url: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/r1/x/video.mp4?X-Amz-Signature=SIG_PAGE',
    content_type: 'video/mp4',
    expires_in_sec: 300,
  });
});

describe('R1 recordings on the candidate page', () => {
  it('the Overview recording pauses when the Review tab opens, keeps its link, and stays paused on return', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    const overview = screen.getByRole('tabpanel', { name: 'Overview' });
    fireEvent.click(await within(overview).findByRole('button', { name: 'Load recording, Attempt 1 (counted)' }));
    const video = (await waitFor(() => {
      const el = overview.querySelector('video');
      expect(el).not.toBeNull();
      return el;
    })) as HTMLVideoElement;
    const state = drive(video);
    state.paused = false; // playing

    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(state.pause).toHaveBeenCalled();
    expect(state.paused).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(overview.querySelector('video')).toBe(video);
    expect(video).toHaveAttribute('src', expect.stringContaining('SIG_PAGE'));
    expect(state.play).not.toHaveBeenCalled();
    expect(mockApi.getR1Recording).toHaveBeenCalledTimes(1);
  });

  it('the Review recording pauses when the Overview tab opens', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    fireEvent.click(await within(review).findByRole('button', { name: 'Load recording, R1 role-play' }));
    const video = (await waitFor(() => {
      const el = review.querySelector('video');
      expect(el).not.toBeNull();
      return el;
    })) as HTMLVideoElement;
    const state = drive(video);
    state.paused = false;

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(state.pause).toHaveBeenCalled();
    expect(state.paused).toBe(true);
  });

  it('Review is the default tab for an R1 session and uses the R1 player, not the legacy one', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    expect(review).not.toHaveAttribute('hidden');
    expect(await within(review).findByRole('button', { name: 'Load recording, R1 role-play' })).toBeInTheDocument();
    expect(within(review).queryByText('Recording loads on request; the link expires automatically.')).not.toBeInTheDocument();
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    // Turns are timed from the attempt's anchor.
    expect(await within(review).findByRole('button', { name: /Turn 1: .*At 0:05\./ })).toBeInTheDocument();
  });
});
