/**
 * AshbyScopedReviewPage — the candidate-scoped Ashby review shell.
 *
 * Asserts the shell contract the deep link depends on: only the linked
 * candidate's Overview + Review content, addressed by the opaque link id, with
 * no global navigation, no backlinks, no actions, and one indistinguishable
 * "not available" state for unknown / malformed / unowned links.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyScopedReviewPage } from './AshbyScopedReviewPage';
import { mockCandidateDetail, mockSessionDetail } from '../test/helpers';

const LINK_ID = '11111111-1111-4111-8111-111111111111';

const mockApi = {
  getAshbyScopedReview: vi.fn(),
  listAshbyScopedReviewNotes: vi.fn(),
  getSession: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
};

class MockApiError extends Error {
  status: number;
  constructor(m: string, s: number) {
    super(m);
    this.status = s;
  }
}

vi.mock('../api', () => ({
  api: {
    getAshbyScopedReview: (...a: any[]) => mockApi.getAshbyScopedReview(...a),
    listAshbyScopedReviewNotes: (...a: any[]) => mockApi.listAshbyScopedReviewNotes(...a),
    getSession: (...a: any[]) => mockApi.getSession(...a),
    getRecordingDownloadUrl: (...a: any[]) => mockApi.getRecordingDownloadUrl(...a),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

function renderPage(linkId = LINK_ID) {
  return render(
    <MemoryRouter initialEntries={[`/ashby/review/${linkId}`]}>
      <Routes>
        <Route path="/ashby/review/:applicationLinkId" element={<AshbyScopedReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getAshbyScopedReview.mockResolvedValue(mockCandidateDetail);
  mockApi.listAshbyScopedReviewNotes.mockResolvedValue({ notes: [] });
  mockApi.getSession.mockResolvedValue(mockSessionDetail);
});

describe('scoped review shell', () => {
  it('loads only via the opaque link id — never a candidate id', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    expect(mockApi.getAshbyScopedReview).toHaveBeenCalledWith(LINK_ID);
    expect(mockApi.getAshbyScopedReview).toHaveBeenCalledTimes(1);
  });

  it('renders no global navigation, no backlinks and no cross-candidate links', async () => {
    const { container } = renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText(/back to candidates/i)).toBeNull();
    // No anchor may leave the scoped view. The only links present are the
    // Review workspace's in-page skip targets (`#…`); nothing routes to
    // /candidates, /sessions or any other app surface.
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.every((h) => h.startsWith('#'))).toBe(true);
    expect(hrefs.some((h) => h.includes('/candidates') || h.includes('/sessions'))).toBe(false);
  });

  it('offers no actions — no note form, appeal grant, CSV export, or call start', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.queryByPlaceholderText(/add a note/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /add$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export screening data/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /appeal grant/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
  });

  it('restricts the surface to exactly the Overview and Review tabs', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Review']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders the existing Review workspace content on the Review tab', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
  });

  it('reads notes through the scoped endpoint only', async () => {
    mockApi.listAshbyScopedReviewNotes.mockResolvedValue({
      notes: [{ id: 'n1', candidate_id: 'c1', author_id: 'u1', note: 'Solid answers', created_at: '2026-08-01T00:00:00Z' }],
    });
    renderPage();
    expect(await screen.findByText('Solid answers')).toBeInTheDocument();
    expect(mockApi.listAshbyScopedReviewNotes).toHaveBeenCalledWith(LINK_ID);
  });
});

describe('unresolvable links', () => {
  it.each([
    ['unknown/unowned (404)', 404],
    ['forbidden (403)', 403],
  ])('shows one generic unavailable state for %s with no retry', async (_label, status) => {
    mockApi.getAshbyScopedReview.mockRejectedValue(new MockApiError('nope', status));
    renderPage();
    expect(await screen.findByText(/this review link is not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.queryByText('Jane Doe')).toBeNull();
  });

  it('renders no candidate content for a malformed link id', async () => {
    mockApi.getAshbyScopedReview.mockRejectedValue(new MockApiError('nope', 404));
    renderPage('not-a-uuid');
    expect(await screen.findByText(/this review link is not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('still offers a retry for a genuine server failure', async () => {
    mockApi.getAshbyScopedReview.mockRejectedValue(new MockApiError('Internal server error', 500));
    renderPage();
    expect(await screen.findByText('Internal server error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
