/**
 * CandidateDetailPage — Overview + Review workspace.
 *
 * Covers: loading/error, profile, back link, live actions, session summary,
 * the Review tab (session scorecard + on-demand recording), decision-use
 * block suppression, notes, appeals, CSV export, axe.
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
  getSession: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  addNote: vi.fn().mockResolvedValue({ id: 'n1' }),
  listAppeals: vi.fn().mockResolvedValue({ appeals: [] }),
  issueAppealGrant: vi.fn().mockResolvedValue({
    appeal_grant_token: 'c'.repeat(64),
    expires_at: '2999-01-01T00:00:00.000Z',
  }),
  exportCsv: vi.fn().mockResolvedValue('﻿candidate_id,status\n'),
};

vi.mock('../api', () => ({
  api: {
    getCandidate: (...args: any[]) => mockApi.getCandidate(...args),
    getRecordingDownloadUrl: (...args: any[]) => mockApi.getRecordingDownloadUrl(...args),
    getSession: (...args: any[]) => mockApi.getSession(...args),
    listNotes: (...args: any[]) => mockApi.listNotes(...args),
    addNote: (...args: any[]) => mockApi.addNote(...args),
    listAppeals: (...args: any[]) => mockApi.listAppeals(...args),
    issueAppealGrant: (...args: any[]) => mockApi.issueAppealGrant(...args),
    exportCsv: (...args: any[]) => mockApi.exportCsv(...args),
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
    listCandidates: vi.fn().mockResolvedValue([]),
  },
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

function renderDetailPage(id = 'candidate-1') {
  return render(
    <MemoryRouter initialEntries={[`/candidates/${id}`]}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function reviewTab() {
  return screen.getByRole('tab', { name: 'Review' });
}

describe('CandidateDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    mockApi.getSession.mockResolvedValue(mockSessionDetail);
  });

  it('shows loading state initially', () => {
    mockApi.getCandidate.mockReturnValue(new Promise(() => {}));
    renderDetailPage();
    expect(screen.getByText('Loading candidate…')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockApi.getCandidate.mockRejectedValue({ message: 'Candidate not found' });
    renderDetailPage();
    expect(await screen.findByText('Candidate not found')).toBeInTheDocument();
  });

  it('renders candidate profile', async () => {
    renderDetailPage();
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('5 years')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });

  it('renders Back to candidates link', async () => {
    renderDetailPage();
    expect(await screen.findByText('← Back to candidates')).toBeInTheDocument();
  });

  it('renders LiveKit voice screening + Live call panel', async () => {
    renderDetailPage();
    expect(await screen.findByText('LiveKit voice screening')).toBeInTheDocument();
    expect(screen.getByText('Live call')).toBeInTheDocument();
  });

  it('renders the session summary in Overview', async () => {
    renderDetailPage();
    expect(await screen.findByText('Screening sessions')).toBeInTheDocument();
    // Session status is shown (also appears in the Review context header).
    expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the session scorecard in the Review tab', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(reviewTab());
    expect(await screen.findByText('Scorecard for this session')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderDetailPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });

  describe('on-demand recording (MIG-06)', () => {
    it('does not fetch a recording URL until an explicit click', async () => {
      mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
      renderDetailPage();
      await screen.findByText('Jane Doe');
      fireEvent.click(reviewTab());
      const loadBtn = await screen.findByRole('button', { name: /load recording/i });
      expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
      fireEvent.click(loadBtn);
      await waitFor(() =>
        expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
      );
      await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    });

    it('shows an error when the recording fetch fails', async () => {
      mockApi.getRecordingDownloadUrl.mockRejectedValue({ message: 'expired' });
      renderDetailPage();
      await screen.findByText('Jane Doe');
      fireEvent.click(reviewTab());
      fireEvent.click(await screen.findByRole('button', { name: /load recording/i }));
      expect(await screen.findByText('expired')).toBeInTheDocument();
    });
  });

  describe('Phase 9 additions', () => {
    it('suppresses the scorecard under a decision-use block', async () => {
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
      fireEvent.click(reviewTab());
      expect(
        await screen.findByText(/Scorecards are suppressed while an appeal is under review/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('78')).not.toBeInTheDocument();
    });

    it('renders the notes section and adds a note', async () => {
      mockApi.listNotes.mockResolvedValue({
        notes: [{ id: 'n1', candidate_id: 'candidate-1', author_id: 'u1', note: 'Call back next week', created_at: '2026-01-01T00:00:00Z' }],
      });
      renderDetailPage();
      expect(await screen.findByText('Call back next week')).toBeInTheDocument();
      await userEvent.type(screen.getByPlaceholderText('Add a note…'), 'Follow up');
      await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(mockApi.addNote).toHaveBeenCalledWith('candidate-1', 'Follow up'));
    });

    it('exports the scorecard CSV on click', async () => {
      const createObjSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock');
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      renderDetailPage();
      const btn = await screen.findByRole('button', {
        name: 'Export screening data (scorecard + transcript)',
      });
      fireEvent.click(btn);
      await waitFor(() => expect(mockApi.exportCsv).toHaveBeenCalledWith('candidate-1'));
      await waitFor(() => expect(createObjSpy).toHaveBeenCalled());
      expect(revokeSpy).toHaveBeenCalled();
      createObjSpy.mockRestore();
      revokeSpy.mockRestore();
    });

    it('issues a one-time appeal grant and shows a fragment link', async () => {
      renderDetailPage();
      const issueBtn = await screen.findByRole('button', { name: 'Issue one-time appeal grant' });
      fireEvent.click(issueBtn);
      await waitFor(() => {
        expect(mockApi.issueAppealGrant).toHaveBeenCalledWith('candidate-1', 'session-1', 24);
      });
      expect(await screen.findByText(/\/appeal#/)).toBeInTheDocument();
      expect(screen.queryByText(/\/appeal\?/)).not.toBeInTheDocument();
    });
  });
});
