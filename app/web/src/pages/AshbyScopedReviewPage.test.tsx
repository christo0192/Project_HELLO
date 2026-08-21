/**
 * AshbyScopedReviewPage — the candidate-scoped Ashby review shell.
 *
 * Asserts the shell contract the deep link depends on: only the linked
 * candidate's Overview + Review content, addressed by the opaque link id, with
 * no global navigation, no backlinks, no actions, and one indistinguishable
 * "not available" state for unknown / malformed / unowned links.
 */
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyScopedReviewPage } from './AshbyScopedReviewPage';
import { mockCandidateDetail, mockSessionDetail } from '../test/helpers';
import { rememberReturnTo, consumeReturnTo, resetReturnToReplay } from '../lib/return-to';

const LINK_ID = '11111111-1111-4111-8111-111111111111';

const mockApi = {
  getAshbyScopedReview: vi.fn(),
  listAshbyScopedReviewNotes: vi.fn(),
  getSession: vi.fn(),
  getRecordingDownloadUrl: vi.fn(),
  getAshbyScopedReviewWorkflow: vi.fn().mockResolvedValue({ ok: true, workflow: null }),
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
    getAshbyScopedReviewWorkflow: (...a: any[]) => mockApi.getAshbyScopedReviewWorkflow(...a),
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
  resetReturnToReplay();
  window.sessionStorage.clear();
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

/**
 * Arrival consumes the parked SSO return-to.
 *
 * On the provider-honoured deep-link path Supabase returns the browser straight
 * to /ashby/review/<id>, so `PostAuthLanding` — the fallback path's consumer —
 * never runs. Without this the parked entry lived out its 10-minute TTL and
 * silently re-routed the next visit to `/` in the same tab.
 */
describe('parked SSO return-to', () => {
  const PARKED = `/ashby/review/${LINK_ID}`;

  it('is cleared once the page mounts, so a later landing visit cannot replay it', async () => {
    rememberReturnTo(PARKED);
    expect(window.sessionStorage.getItem('ashby.returnTo')).not.toBeNull();

    renderPage();
    await screen.findByText('Jane Doe');

    expect(window.sessionStorage.getItem('ashby.returnTo')).toBeNull();
    // What `PostAuthLanding` would read on a later visit to `/`: nothing.
    expect(consumeReturnTo()).toBeNull();
  });

  it('is cleared even when the link resolves to the unavailable state', async () => {
    rememberReturnTo(PARKED);
    mockApi.getAshbyScopedReview.mockRejectedValue(new MockApiError('not found', 404));

    renderPage();
    await screen.findByText(/not available/i);

    expect(consumeReturnTo()).toBeNull();
  });

  it('survives a StrictMode double mount without throwing or resurrecting', async () => {
    rememberReturnTo(PARKED);
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/ashby/review/${LINK_ID}`]}>
          <Routes>
            <Route path="/ashby/review/:applicationLinkId" element={<AshbyScopedReviewPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByText('Jane Doe');
    expect(consumeReturnTo()).toBeNull();
  });

  it('clears only its own key, never the rest of sessionStorage', async () => {
    window.sessionStorage.setItem('unrelated.key', 'keep-me');
    rememberReturnTo(PARKED);

    renderPage();
    await screen.findByText('Jane Doe');

    expect(window.sessionStorage.getItem('unrelated.key')).toBe('keep-me');
  });
});

describe('Ashby pipeline card in the scoped review Overview', () => {
  it('reads the workflow through the link scope only — never a candidate id', async () => {
    mockApi.getAshbyScopedReviewWorkflow.mockResolvedValue({
      ok: true,
      workflow: {
        lifecycle: 'writeback_pending',
        terminalState: null,
        ingestionState: 'ready',
        operations: [{ type: 'scorecard_write', state: 'failed', errorCode: 'provider_5xx' }],
        sessionStatus: 'completed',
        updatedAt: '2026-08-20T10:00:00.000Z',
      },
    });
    renderPage();
    // Wait for the resolved card, not the identically-headed loading state.
    expect(await screen.findByText('Writing results back to Ashby')).toBeInTheDocument();
    expect(mockApi.getAshbyScopedReviewWorkflow).toHaveBeenCalledWith(LINK_ID);
    expect(screen.getByText('provider_5xx')).toBeInTheDocument();

    // No new access and no new navigation: the card adds no control or link.
    const region = screen.getByRole('region', { name: 'Ashby screening pipeline' });
    expect(region.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
  });

  it('renders no card when the linked candidate has no Ashby workflow', async () => {
    mockApi.getAshbyScopedReviewWorkflow.mockResolvedValue({ ok: true, workflow: null });
    renderPage();
    await screen.findByText('Jane Doe');
    await waitFor(() => expect(mockApi.getAshbyScopedReviewWorkflow).toHaveBeenCalledWith(LINK_ID));
    expect(screen.queryByText('Ashby screening pipeline')).not.toBeInTheDocument();
  });
});
