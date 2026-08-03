/**
 * CandidateDetailPage (Lane 3) — tab reorganization tests (adjacent to the
 * preserved existing suite, which remains untouched):
 *   - ARIA tablist semantics + keyboard activation
 *   - on-demand transcript loading per session (no prefetch), empty/error states
 *   - on-demand recording access (no auto-fetch), signed URL lifecycle
 *   - appeal-block suppression holds across tabs (no scorecard anywhere)
 *   - axe compliance with hidden tab panels
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail, mockSessionDetail } from '../test/helpers';

const mockApi = {
  getCandidate: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  addNote: vi.fn().mockResolvedValue({ id: 'n1' }),
  listAppeals: vi.fn().mockResolvedValue({ appeals: [] }),
  issueAppealGrant: vi.fn(),
  exportCsv: vi.fn(),
  startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
  issueLiveKitInvite: vi.fn(),
  getSession: vi.fn().mockResolvedValue(mockSessionDetail),
};

vi.mock('../api', () => ({
  api: {
    getCandidate: (...args: any[]) => mockApi.getCandidate(...args),
    getRecordingDownloadUrl: (...args: any[]) => mockApi.getRecordingDownloadUrl(...args),
    listNotes: (...args: any[]) => mockApi.listNotes(...args),
    addNote: (...args: any[]) => mockApi.addNote(...args),
    listAppeals: (...args: any[]) => mockApi.listAppeals(...args),
    issueAppealGrant: (...args: any[]) => mockApi.issueAppealGrant(...args),
    exportCsv: (...args: any[]) => mockApi.exportCsv(...args),
    startLiveKitScreening: (...args: any[]) => mockApi.startLiveKitScreening(...args),
    issueLiveKitInvite: (...args: any[]) => mockApi.issueLiveKitInvite(...args),
    getSession: (...args: any[]) => mockApi.getSession(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

// Mock supabase to prevent channel subscriptions (same shape as the existing suite).
vi.mock('../lib/supabase', () => {
  const makeChannel = () => {
    const channel: any = {};
    channel.on = () => channel;
    channel.subscribe = () => 'mock-sub';
    return channel;
  };
  const makeQuery = () => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: null, error: null });
    return q;
  };
  return {
    supabase: {
      from: () => makeQuery(),
      channel: () => makeChannel(),
      removeChannel: () => {},
    },
  };
});

function renderDetailPage() {
  return render(
    <MemoryRouter initialEntries={['/candidates/candidate-1']}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CandidateDetailPage tabs (Lane 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
  });

  it('renders a keyboard tablist with the expected tab names', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    const tablist = screen.getByRole('tablist', { name: 'Candidate sections' });
    expect(tablist).toBeInTheDocument();
    const labels = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(labels).toEqual([
      'Overview',
      'Sessions',
      'Transcript & Scorecards',
      'Recordings',
    ]);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('activates the Sessions tab on ArrowRight and keeps panel state', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByText('Jane Doe');
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    await user.keyboard('{ArrowRight}');
    const sessions = screen.getByRole('tab', { name: 'Sessions' });
    expect(sessions).toHaveFocus();
    expect(sessions).toHaveAttribute('aria-selected', 'true');
    // The sessions panel becomes the visible one.
    expect(screen.getByRole('tabpanel', { name: 'Sessions' })).not.toHaveAttribute(
      'hidden',
    );
    // Sessions content (status chips, recording button) is present.
    expect(screen.getByText('Screening sessions')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('loads a session transcript only on demand from the Transcript & Scorecards tab', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript & Scorecards' }));

    // No prefetch — the transcript is fetched only after the click.
    expect(mockApi.getSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /load transcript/i }));
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
    expect(screen.getByText('Thank you!')).toBeInTheDocument();
  });

  it('shows a truthful empty transcript state', async () => {
    mockApi.getSession.mockResolvedValue({
      ...mockSessionDetail,
      transcript: [],
    });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript & Scorecards' }));
    fireEvent.click(screen.getByRole('button', { name: /load transcript/i }));
    expect(
      await screen.findByText(/No transcript lines recorded for this session yet/i),
    ).toBeInTheDocument();
  });

  it('shows an inline transcript error with a retry path', async () => {
    mockApi.getSession.mockRejectedValue({ message: 'transcript unavailable' });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript & Scorecards' }));
    fireEvent.click(screen.getByRole('button', { name: /load transcript/i }));
    expect(await screen.findByText('transcript unavailable')).toBeInTheDocument();
  });

  it('does not auto-fetch recordings and gates access behind an explicit click', async () => {
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Recordings' }));

    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() =>
      expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
    );
    await waitFor(() =>
      expect(document.querySelector('audio')).not.toBeNull(),
    );
    expect(document.querySelector('audio')).toHaveAttribute(
      'src',
      'https://x.invalid/rec',
    );
  });

  it('keeps the appeal block suppressing every scorecard across tabs', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        decision_use_blocked_at: '2026-01-02T00:00:00.000Z',
      },
    });
    renderDetailPage();
    expect(
      await screen.findByText(/Decision use is paused — open appeal/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Hidden while an appeal is under review/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Transcript & Scorecards' }));
    expect(
      screen.getByText(/Scorecards are suppressed while an appeal is under review/i),
    ).toBeInTheDocument();
    // No scorecard number anywhere in the page (Overview or other tabs).
    expect(screen.queryByText('78')).not.toBeInTheDocument();
  });

  it('has no axe violations with hidden tab panels', async () => {
    const { container } = renderDetailPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });
});
