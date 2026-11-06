/**
 * AshbyScopedReviewPage — the candidate-scoped Ashby review shell.
 *
 * Asserts the shell contract the deep link depends on: only the linked
 * candidate's Overview + Review content, addressed by the opaque link id, with
 * no global navigation, no backlinks, no actions, and one indistinguishable
 * "not available" state for unknown / malformed / unowned links.
 */
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

  /** The same shared fallback copy as the list and Candidate Detail. */
  it('falls back to the shared neutral title for a nullable shell', async () => {
    mockApi.getAshbyScopedReview.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        name: null,
        email: null,
        phone_e164: null,
        phone_valid: false,
        skills: [],
        experience_years: null,
        status: 'queued',
      },
    });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Awaiting resume details' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unnamed/i)).toBeNull();
    expect(screen.getByText('Not provided')).toBeInTheDocument();
    expect(screen.getByText('None parsed')).toBeInTheDocument();
    // Still action-free: the shell state adds no affordance here either.
    expect(screen.queryByRole('button', { name: /retry|reprocess|re-?parse|start|export|note|appeal/i })).toBeNull();
  });

  it('shows the stored status through the shared display helper (no phone fields here)', async () => {
    // The scoped payload never carries dial_count / phone_state, so the badge
    // degrades to the plain stored status — never "(dialed …)".
    mockApi.getAshbyScopedReview.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, status: 'queued' },
    });
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/dialed/)).toBeNull();
  });

  it('names the phone outcome the scoped payload now carries, like the main pages', async () => {
    mockApi.getAshbyScopedReview.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        status: 'queued',
        dial_count: 5,
        phone_state: 'abandoned_no_answer',
      },
    });
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.getAllByText('Abandoned: no answer').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Queued')).toBeNull();
  });

  it('renders no global navigation, no backlinks and no cross-candidate links', async () => {
    const { container } = renderPage();
    await screen.findByText('Jane Doe');
    // Review is the tab this page opens on, so its skip links are in the tree. They stay inside the
    // page; any other navigation here would be a way out of the scoped view.
    expect(screen.getAllByRole('navigation').map((nav) => nav.getAttribute('aria-label'))).toEqual(['Skip to a pane']);
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
    // Ashby's Detailed report link lands on the evidence, with the verdict above it.
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Latest screening score' })).toBeInTheDocument();
  });

  describe('during an appeal', () => {
    const blocked = {
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, decision_use_blocked_at: '2026-01-02T00:00:00.000Z' },
    };

    it('shows no score and no verdict anywhere on the page', async () => {
      mockApi.getAshbyScopedReview.mockResolvedValue(blocked);
      const { container } = renderPage();
      await screen.findByText('Jane Doe');
      await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
      await screen.findByText('Welcome to the screening.');
      expect(screen.queryByRole('region', { name: 'Latest screening score' })).toBeNull();
      expect(container.querySelector('[data-recommendation]')).toBeNull();
    });

    it('prints that verdict mark when no appeal holds it back, so the check above can fail', async () => {
      const { container } = renderPage();
      await screen.findByText('Jane Doe');
      expect(container.querySelector('[data-recommendation]')).not.toBeNull();
    });
  });

  it('renders the existing Review workspace content on the Review tab', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
  });

  it('gives the Review tab a sheet: this shell is on the desk, and the workspace is drawn for paper', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    await screen.findByText('Welcome to the screening.');
    const sheet = document.querySelector('[data-review-workspace]')!.parentElement!;
    expect(sheet).toHaveClass('bg-paper');
    expect(sheet.closest('[role="tabpanel"]')).not.toBeNull();
    // The Overview's cards are their own surfaces: it stays on the desk.
    expect(document.querySelector('[role="tabpanel"][hidden] .bg-paper')).toBeNull();
  });

  it('a viewer with an R1 session is told the candidate page holds its recording: this shell has no R1 card', async () => {
    mockApi.getSession.mockRejectedValue(new MockApiError('forbidden', 403));
    mockApi.getAshbyScopedReview.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], status: 'completed', interview_round_id: 'round-1' }],
    });
    renderPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    // The transcript pane says the same while the load is out, so wait for the denied pane itself.
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(
      screen.getByText('The recording for this R1 session is on the candidate page, under R1 interview.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Overview tab/)).toBeNull();
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

describe('the log header on the scoped Review tab', () => {
  const header = () => document.querySelector<HTMLElement>('[data-log-header]')!;
  const linked = {
    lifecycle: 'writeback_pending',
    terminalState: null,
    ingestionState: 'ready',
    operations: [],
    sessionStatus: 'completed',
    updatedAt: null,
  };

  it('says where the candidate stands, through the link scope, and leaves out a role it cannot name', async () => {
    mockApi.getAshbyScopedReviewWorkflow.mockResolvedValue({ ok: true, workflow: linked });
    renderPage();
    await screen.findByText('Ashby screening pipeline');
    await waitFor(() => expect(header()).toHaveTextContent('Writing results back to Ashby'));
    expect(header()).not.toHaveTextContent('Not linked');
    expect(header()).not.toHaveTextContent('Role');
    expect(mockApi.getAshbyScopedReviewWorkflow).toHaveBeenCalledWith(LINK_ID);
  });

  it('never says "Not linked" for a read that failed', async () => {
    mockApi.getAshbyScopedReviewWorkflow.mockRejectedValue(new MockApiError('boom', 500));
    renderPage();
    await screen.findByText('Ashby screening pipeline');
    await waitFor(() => expect(mockApi.getAshbyScopedReviewWorkflow).toHaveBeenCalled());
    expect(header()).toHaveTextContent('Not available');
    expect(header()).not.toHaveTextContent('Not linked');
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    // Wait for the resolved card, not the identically-headed loading state. Within the card, because
    // the hidden Review panel stays mounted and its log header prints the same words.
    await waitFor(() => {
      const card = screen.getByRole('region', { name: 'Ashby screening pipeline' });
      expect(within(card).getByText('Writing results back to Ashby')).toBeInTheDocument();
    });
    expect(mockApi.getAshbyScopedReviewWorkflow).toHaveBeenCalledWith(LINK_ID);
    expect(screen.getByText('Ashby server error')).toHaveAttribute('title', 'provider_5xx');

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
