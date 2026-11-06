/**
 * CandidateDetailPage and R1: the tabs by pipeline, what each opens on, old links, the R1 tab, and the
 * header line that keeps the R1 result apart from the phone score. The recording itself plays on the
 * review page, so nothing here plays or mints anything.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail, mockSession, mockSessionDetail } from '../test/helpers';

const mockApi = vi.hoisted(() => ({
  getCandidate: vi.fn(),
  getMe: vi.fn(),
  getSession: vi.fn(),
  listNotes: vi.fn(),
  listAppeals: vi.fn(),
  getCandidateAshbyWorkflow: vi.fn(),
  listR1Rounds: vi.fn(),
  getR1Availability: vi.fn(),
  getR1Recording: vi.fn(),
  getCandidatePhoneAttempts: vi.fn(),
  getCandidatePhoneScreenings: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  listRoles: vi.fn(),
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

const R1_SESSION = { ...mockSession, id: 'session-r1', mode: 'browser', interview_round_id: 'round-1' };
const SUMMARY = {
  state: 'ready' as const,
  reason: null,
  mode: 'single' as const,
  has_video: true,
  started_at_ms: 1_790_000_000_000,
  duration_ms: 600_000,
  camera_off_ms: 0,
  degraded_at_ms: null,
  retention_until: '2027-01-12T10:00:00.000Z',
  deleted_at: null,
};
const ROUND = {
  id: 'round-1',
  status: 'completed',
  expires_at: '2026-10-09T10:00:00.000Z',
  attempts_allowed: 2,
  attempts_counted: 1,
  recommendation: 'hold',
  overall: 58,
  created_at: '2026-10-06T10:00:00.000Z',
  created_by: 'user-1',
  attempts: [{ session_id: 'session-r1', attempt_number: 1, counted: true, outcome: 'completed', recording: SUMMARY }],
};

function Address() {
  const { search } = useLocation();
  return <output data-testid="address">{search}</output>;
}

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/candidates/candidate-1${search}`]}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });
const panel = (name: string) => screen.getByRole('tabpanel', { name });
const selected = () => screen.getByRole('tab', { selected: true }).textContent;
const opened = () => screen.findByRole('heading', { level: 1, name: 'Jane Doe' });

beforeEach(() => {
  vi.clearAllMocks();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getMe.mockResolvedValue({ userId: 'user-1', email: null, role: 'admin', active: true });
  mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [R1_SESSION, ...mockCandidateDetail.sessions] });
  mockApi.getSession.mockResolvedValue(mockSessionDetail);
  mockApi.listNotes.mockResolvedValue({ notes: [] });
  mockApi.listAppeals.mockResolvedValue({ appeals: [] });
  mockApi.listRoles.mockResolvedValue([]);
  mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: null });
  mockApi.getR1Availability.mockResolvedValue({ state: 'ready', hold_minutes: 55 });
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
  mockApi.getCandidatePhoneScreenings.mockResolvedValue({ ok: true, enabled: false, cycles: [], current_cycle: null });
  mockApi.listR1Rounds.mockResolvedValue({ rounds: [ROUND] });
});

describe('the tabs', () => {
  it('are named by pipeline, phone first', async () => {
    renderPage();
    await opened();
    expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['Phone screening', 'R1 interview', 'Profile']);
  });

  it.each([
    ['?tab=phone', 'Phone screening'],
    ['?tab=r1', 'R1 interview'],
    ['?tab=profile', 'Profile'],
    ['?tab=review', 'Phone screening'],
    ['?tab=overview', 'Profile'],
  ])('%s opens %s', async (search, name) => {
    renderPage(search);
    await opened();
    expect(selected()).toBe(name);
    expect(panel(name)).not.toHaveAttribute('hidden');
  });

  it('an unknown tab is no error: the page chooses', async () => {
    renderPage('?tab=sessions');
    await opened();
    expect(selected()).toBe('Phone screening');
  });

  it('writes the new names into the address, and keeps whatever else is there', async () => {
    const user = userEvent.setup();
    renderPage('?tab=overview&from=list');
    await opened();
    await user.click(tab('R1 interview'));
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('?tab=r1&from=list'));
    await user.click(tab('Profile'));
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('?tab=profile&from=list'));
    await user.click(tab('Phone screening'));
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('?tab=phone&from=list'));
  });
});

describe('what a bare link opens on', () => {
  it('Phone screening while a phone review is pending, though an R1 interview exists', async () => {
    renderPage();
    await opened();
    expect(selected()).toBe('Phone screening');
  });

  it('the R1 interview once the candidate is decided', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, status: 'advanced' },
      sessions: [R1_SESSION, ...mockCandidateDetail.sessions],
    });
    renderPage();
    await opened();
    expect(selected()).toBe('R1 interview');
  });

  it('the R1 interview when that is all there is to read, and no "Review screening" for an empty phone tab', async () => {
    mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [R1_SESSION], assessments: [] });
    renderPage();
    await opened();
    expect(selected()).toBe('R1 interview');
    expect(screen.queryByRole('button', { name: 'Review screening' })).toBeNull();
  });

  it('Profile when there is nothing to read', async () => {
    mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [], assessments: [] });
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [] });
    renderPage();
    await opened();
    expect(selected()).toBe('Profile');
  });
});

describe('the R1 interview tab', () => {
  it('holds the rounds, with the AI result labelled, the chip and the way to the review', async () => {
    renderPage('?tab=r1');
    await opened();
    const rounds = await within(panel('R1 interview')).findByRole('list', { name: 'R1 rounds' });
    expect(within(rounds).getByText('AI recommendation: Borderline · Overall 58 of 100')).toBeInTheDocument();
    expect(within(rounds).getByText('Completed')).toBeInTheDocument();
    expect(within(rounds).getByText('1 of 2 attempts used')).toBeInTheDocument();
    expect(within(rounds).getByText(/Attempt 1 \(counted\): Ready/)).toBeInTheDocument();
    expect(within(rounds).getByRole('link', { name: 'Open R1 review' })).toHaveAttribute('href', '/interviews/round-1');
  });

  it('embeds no player, on this tab or any other, and mints nothing', async () => {
    const { container } = renderPage('?tab=r1');
    await opened();
    await within(panel('R1 interview')).findByRole('list', { name: 'R1 rounds' });
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('button', { name: /load recording, (attempt|r1)/i })).toBeNull();
    expect(mockApi.getR1Recording).not.toHaveBeenCalled();
  });

  it('keeps the retake and its confirmation, which moved here from the Overview card', async () => {
    const user = userEvent.setup();
    renderPage('?tab=r1');
    await opened();
    await user.click(await within(panel('R1 interview')).findByRole('button', { name: 'Grant retake' }));
    expect(await screen.findByRole('group', { name: 'Grant the one retake?' })).toBeInTheDocument();
  });

  it('keeps Send R1 for someone who can send, when no round blocks it', async () => {
    mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: mockCandidateDetail.sessions });
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [] });
    renderPage('?tab=r1');
    await opened();
    expect(await within(panel('R1 interview')).findByRole('button', { name: 'Send R1' })).toBeInTheDocument();
  });

  it('says so when there is nothing to show, rather than an empty panel', async () => {
    mockApi.getMe.mockResolvedValue({ userId: 'user-2', email: null, role: 'viewer', active: true });
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [] });
    renderPage('?tab=r1');
    await opened();
    expect(await within(panel('R1 interview')).findByText('No R1 round has been sent yet.')).toBeInTheDocument();
  });

  it('is the only place the rounds are: Profile carries no R1 card', async () => {
    renderPage('?tab=profile');
    await opened();
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalledTimes(1));
    expect(within(panel('Profile')).queryByRole('heading', { name: 'R1 interview' })).toBeNull();
  });
});

describe('the Phone screening tab', () => {
  it('leaves R1 sessions out of its picker', async () => {
    renderPage('?tab=phone');
    await opened();
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalled());
    expect(mockApi.getSession).not.toHaveBeenCalledWith('session-r1');
    // The one phone session left to choose is a line of text, not a picker.
    expect(within(panel('Phone screening')).queryByRole('button', { name: /^Screening/ })).toBeNull();
    expect(panel('Phone screening').querySelector('[data-session-text]')).not.toHaveTextContent('R1');
  });
});

describe('the header', () => {
  const score = () => screen.getByRole('region', { name: 'Latest screening score' });

  it('keeps the phone score, with the R1 result on its own line, labelled AI', async () => {
    renderPage('?tab=profile');
    await opened();
    expect(await screen.findByText('R1 role-play: Borderline 58 (AI)')).toBeInTheDocument();
    expect(within(score()).getByText('78')).toBeInTheDocument();
    expect(within(score()).queryByText(/R1/)).toBeNull();
  });

  it('keeps the R1 result in the compact header on Phone screening, where the score steps aside', async () => {
    renderPage('?tab=phone');
    await opened();
    expect(await screen.findByText('R1 role-play: Borderline 58 (AI)')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Latest screening score' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Jane Doe' })).toHaveClass('inline');
  });

  it('keeps the full header on Phone screening for an R1 interview alone: there are no panes to make room for', async () => {
    mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [R1_SESSION], assessments: [] });
    renderPage('?tab=phone');
    await opened();
    expect(await screen.findByText(/No completed screening yet/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Jane Doe' })).not.toHaveClass('inline');
  });

  it('says the newest round with a result, as a whole figure', async () => {
    mockApi.listR1Rounds.mockResolvedValue({
      rounds: [
        { ...ROUND, id: 'round-3', status: 'invited', recommendation: null, overall: null },
        { ...ROUND, id: 'round-2', recommendation: 'advance', overall: 71.5 },
        ROUND,
      ],
    });
    renderPage();
    await opened();
    expect(await screen.findByText('R1 role-play: Select 72 (AI)')).toBeInTheDocument();
  });

  describe('going straight from one candidate to another', () => {
    const SECOND = { ...mockCandidateDetail.candidate, id: 'candidate-2', name: 'Second Person' };

    /** The route stays mounted across the change of id, as a jump in the browser's history leaves it. */
    function renderBoth() {
      render(
        <MemoryRouter initialEntries={['/candidates/candidate-1']}>
          <Routes>
            <Route path="/candidates/:id" element={<CandidateDetailPage />} />
          </Routes>
          <Link to="/candidates/candidate-2">Next candidate</Link>
        </MemoryRouter>,
      );
    }

    /** Jane Doe's verdict is on screen, then the page moves to the second candidate. */
    async function moveOn() {
      expect(await screen.findByText('R1 role-play: Borderline 58 (AI)')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('link', { name: 'Next candidate' }));
      await screen.findByRole('heading', { level: 1, name: 'Second Person' });
    }

    beforeEach(() => {
      mockApi.getCandidate.mockImplementation(async (id: string) => (
        id === 'candidate-2'
          ? { ...mockCandidateDetail, candidate: SECOND, sessions: [] }
          : { ...mockCandidateDetail, sessions: [R1_SESSION, ...mockCandidateDetail.sessions] }
      ));
    });

    it('never shows the first candidate\'s verdict while the second one\'s read is out', async () => {
      renderBoth();
      mockApi.listR1Rounds.mockReturnValueOnce(Promise.resolve({ rounds: [ROUND] })).mockReturnValue(new Promise(() => undefined));
      await moveOn();
      expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
    });

    it('shows no verdict at all when the second candidate\'s read fails', async () => {
      renderBoth();
      mockApi.listR1Rounds.mockResolvedValueOnce({ rounds: [ROUND] }).mockRejectedValue(new Error('service_unavailable'));
      await moveOn();
      await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalledWith('candidate-2'));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
    });

    it('shows the second candidate\'s own verdict once it is read', async () => {
      renderBoth();
      mockApi.listR1Rounds.mockImplementation(async (id: string) => ({
        rounds: [id === 'candidate-2' ? { ...ROUND, id: 'round-2', recommendation: 'reject', overall: 31 } : ROUND],
      }));
      await moveOn();
      expect(await screen.findByText('R1 role-play: Reject 31 (AI)')).toBeInTheDocument();
      expect(screen.queryByText('R1 role-play: Borderline 58 (AI)')).toBeNull();
    });
  });

  it('has no line while nothing is scored', async () => {
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [{ ...ROUND, recommendation: null, overall: null }] });
    renderPage('?tab=r1');
    await opened();
    await within(panel('R1 interview')).findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
  });

  it('hides the line while decision use is blocked, even from an API that still sent the score', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, decision_use_blocked_at: '2026-01-02T00:00:00.000Z' },
    });
    renderPage('?tab=r1');
    await opened();
    await within(panel('R1 interview')).findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
  });

  // The compact header is the one place only the page's own guard covers. A silent refresh can make the
  // candidate blocked while the rounds read stays older, so the rounds here still carry the verdict.
  it('hides the line in the compact header on Phone screening too, while decision use is blocked', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, decision_use_blocked_at: '2026-01-02T00:00:00.000Z' },
      sessions: [R1_SESSION, ...mockCandidateDetail.sessions],
    });
    renderPage('?tab=phone');
    await opened();
    expect(screen.getByRole('heading', { level: 1, name: 'Jane Doe' })).toHaveClass('inline');
    await waitFor(() => expect(mockApi.listR1Rounds).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
  });

  it('hides the line when the round says the result is withheld', async () => {
    mockApi.listR1Rounds.mockResolvedValue({ rounds: [{ ...ROUND, scores_withheld: true }] });
    renderPage('?tab=r1');
    await opened();
    await within(panel('R1 interview')).findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByText(/^R1 role-play:/)).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no axe violations with the R1 tab open', async () => {
    const { container } = renderPage('?tab=r1');
    await opened();
    await within(panel('R1 interview')).findByRole('list', { name: 'R1 rounds' });
    await expect(container).toHaveNoViolations();
  });
});
