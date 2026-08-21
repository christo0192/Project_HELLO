/**
 * Candidate scope integrity — the boundary, not the pixels.
 *
 * Three surfaces must sit inside exactly one `.candidate-scope` element in
 * every state (loading, error/unavailable, loaded), because that element is
 * the only place the approved tokens are declared: no scope class means no
 * palette, and a scope class in the wrong place means the palette leaks.
 *
 * The palette is light-only and fixed, so each surface is also rendered
 * inside a `.dark` document and asserted to declare no dark-mode variant of
 * anything.
 *
 * Finally: the Ashby-scoped shell must not have GAINED anything from the
 * redesign. Restyling a read-only surface is the classic way to smuggle a
 * link or a button onto it, so its affordance count is asserted directly.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CandidatesPage } from './CandidatesPage';
import { CandidateDetailPage } from './CandidateDetailPage';
import { AshbyScopedReviewPage } from './AshbyScopedReviewPage';
import { CANDIDATE_SCOPE_CLASS } from '../components/talent';
import { mockCandidate, mockCandidateDetail, mockSessionDetail } from '../test/helpers';

const LINK_ID = '11111111-1111-4111-8111-111111111111';

const mockApi = {
  listRoles: vi.fn(),
  listCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getSession: vi.fn(),
  listNotes: vi.fn(),
  listAppeals: vi.fn(),
  getCandidateAshbyWorkflow: vi.fn(),
  getAshbyScopedReview: vi.fn(),
  listAshbyScopedReviewNotes: vi.fn(),
  getAshbyScopedReviewWorkflow: vi.fn(),
};

class MockApiError extends Error {
  status: number;
  constructor(m: string, s: number) {
    super(m);
    this.status = s;
  }
}

vi.mock('../api', () => ({
  api: new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        (...args: unknown[]) => {
          const fn = (mockApi as Record<
            string,
            ((...a: unknown[]) => unknown) | undefined
          >)[prop];
          return fn ? fn(...args) : Promise.reject(new Error(`unmocked ${prop}`));
        },
    },
  ),
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('../lib/supabase', () => {
  const channel: Record<string, unknown> = {};
  channel.on = () => channel;
  channel.subscribe = () => 'mock-sub';
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.order = () => query;
  query.limit = () => Promise.resolve({ data: null, error: null });
  return {
    supabase: {
      from: () => query,
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listRoles.mockResolvedValue([]);
  mockApi.listCandidates.mockResolvedValue([mockCandidate]);
  mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
  mockApi.getSession.mockResolvedValue(mockSessionDetail);
  mockApi.listNotes.mockResolvedValue({ notes: [] });
  mockApi.listAppeals.mockResolvedValue({ appeals: [] });
  mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: null });
  mockApi.getAshbyScopedReview.mockResolvedValue(mockCandidateDetail);
  mockApi.listAshbyScopedReviewNotes.mockResolvedValue({ notes: [] });
  mockApi.getAshbyScopedReviewWorkflow.mockResolvedValue({ ok: true, workflow: null });
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

function renderCandidates() {
  return render(
    <MemoryRouter initialEntries={['/candidates']}>
      <CandidatesPage />
    </MemoryRouter>,
  );
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/candidates/candidate-1']}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderScoped() {
  return render(
    <MemoryRouter initialEntries={[`/ashby/review/${LINK_ID}`]}>
      <Routes>
        <Route
          path="/ashby/review/:applicationLinkId"
          element={<AshbyScopedReviewPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** The scope element must be present exactly once, and be the outermost node. */
function expectSingleScopeRoot(container: HTMLElement) {
  const scopes = container.querySelectorAll(`.${CANDIDATE_SCOPE_CLASS}`);
  expect(scopes).toHaveLength(1);
  expect(scopes[0].parentElement).toBe(container);
  return scopes[0] as HTMLElement;
}

describe('every candidate surface mounts one scope root', () => {
  it('Candidates list — loaded', async () => {
    const { container } = renderCandidates();
    await screen.findByText('Jane Doe');
    expectSingleScopeRoot(container);
  });

  it('Candidates list — loading and empty', async () => {
    mockApi.listCandidates.mockResolvedValue([]);
    const { container } = renderCandidates();
    expectSingleScopeRoot(container);
    expect(await screen.findByText('No candidates yet')).toBeInTheDocument();
    expectSingleScopeRoot(container);
  });

  it('Candidates list — error', async () => {
    mockApi.listCandidates.mockRejectedValue(new MockApiError('boom', 500));
    const { container } = renderCandidates();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expectSingleScopeRoot(container);
  });

  it('Candidate Detail — loading, error and loaded', async () => {
    mockApi.getCandidate.mockReturnValue(new Promise(() => {}));
    const loading = renderDetail();
    expect(screen.getByText('Loading candidate…')).toBeInTheDocument();
    expectSingleScopeRoot(loading.container);
    loading.unmount();

    mockApi.getCandidate.mockRejectedValue(new MockApiError('Candidate not found', 404));
    const failed = renderDetail();
    expect(await screen.findByText('Candidate not found')).toBeInTheDocument();
    expectSingleScopeRoot(failed.container);
    failed.unmount();

    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    const ok = renderDetail();
    await screen.findByRole('heading', { name: 'Jane Doe' });
    expectSingleScopeRoot(ok.container);
  });

  it('Ashby-scoped review — loaded and unavailable', async () => {
    const ok = renderScoped();
    await screen.findByRole('heading', { name: 'Jane Doe' });
    const scope = expectSingleScopeRoot(ok.container);
    // The standalone shell owns its own page element.
    expect(scope.tagName).toBe('MAIN');
    ok.unmount();

    mockApi.getAshbyScopedReview.mockRejectedValue(new MockApiError('nope', 403));
    const denied = renderScoped();
    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
    expectSingleScopeRoot(denied.container);
  });

  it('Candidate Detail is inset so it does not double the app Layout padding', async () => {
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'Jane Doe' });
    const scope = expectSingleScopeRoot(container);
    expect(scope.getAttribute('data-candidate-shell')).toBe('inset');
    expect(scope.className).toContain('-mx-4');
  });
});

describe('the fixed light palette survives a .dark ancestor', () => {
  it.each([
    ['Candidates list', renderCandidates, 'Jane Doe'],
    ['Candidate Detail', renderDetail, 'Jane Doe'],
    ['Ashby-scoped review', renderScoped, 'Jane Doe'],
  ])('%s declares no dark-mode variant', async (_label, renderFn, text) => {
    document.documentElement.classList.add('dark');
    const { container } = renderFn();
    await screen.findAllByText(text);
    const scope = expectSingleScopeRoot(container);
    expect(document.documentElement).toHaveClass('dark');
    // Nothing inside the scope may switch on the app theme.
    expect(scope.outerHTML).not.toMatch(/\bdark:/);
  });
});

describe('the redesign adds no affordance to the read-only scoped shell', () => {
  it('keeps the Overview free of controls beyond the two tabs', async () => {
    const { container } = renderScoped();
    await screen.findByRole('heading', { name: 'Jane Doe' });

    // The tablist itself, plus the Overview panel — which must contribute
    // nothing. (The hidden Review panel stays mounted and keeps its
    // pre-existing on-demand "Load recording" control, unchanged here.)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Review',
    ]);
    const overview = screen.getByRole('tabpanel', { name: 'Overview' });
    expect(overview.querySelectorAll('button, input, textarea, select')).toHaveLength(
      0,
    );
    expect(screen.queryByRole('navigation')).toBeNull();

    const hrefs = [...container.querySelectorAll('a')].map(
      (a) => a.getAttribute('href') ?? '',
    );
    expect(hrefs.every((h) => h.startsWith('#'))).toBe(true);
    expect(within(overview).queryAllByRole('link')).toHaveLength(0);
  });

  it('keeps the Ashby pipeline card read-only after restyling', async () => {
    mockApi.getAshbyScopedReviewWorkflow.mockResolvedValue({
      ok: true,
      workflow: {
        lifecycle: 'writeback_pending',
        terminalState: null,
        ingestionState: 'ready',
        operations: [],
        sessionStatus: 'completed',
        updatedAt: '2026-08-20T10:00:00.000Z',
      },
    });
    renderScoped();
    const region = await screen.findByRole('region', {
      name: 'Ashby screening pipeline',
    });
    expect(
      region.querySelectorAll('button, a, input, select, textarea'),
    ).toHaveLength(0);
    expect(within(region).getByText('Ashby screening pipeline')).toBeInTheDocument();
  });
});

describe('Candidates list at a 390px viewport', () => {
  it('scrolls the table inside its own region rather than the page', async () => {
    const { container } = renderCandidates();
    const table = await screen.findByRole('table', {
      name: /candidates in your pipeline/i,
    });
    const region = table.parentElement!;
    expect(region.className).toContain('overflow-x-auto');

    // Nothing in the scope may force the page itself wider than the viewport.
    const scope = expectSingleScopeRoot(container);
    expect(scope.className).not.toMatch(/\bmin-w-\[|\bw-\[\d/);
    expect(scope.outerHTML).not.toMatch(/class="[^"]*\boverflow-x-hidden\b/);
  });

  it('stacks the filter controls instead of overflowing them', async () => {
    mockApi.listRoles.mockResolvedValue([
      { id: 'role-1', title: 'Advisor', jd: '', required_skills: [], screening_template: [], is_active: true, created_at: '' },
    ]);
    renderCandidates();
    const roleFilter = await screen.findByLabelText('Filter by role');
    expect(roleFilter.parentElement!.className).toContain('w-full');
    expect(roleFilter.parentElement!.className).toContain('sm:w-56');
  });

  it('states control width explicitly instead of inheriting an inert one', async () => {
    mockApi.listRoles.mockResolvedValue([
      { id: 'role-1', title: 'Advisor', jd: '', required_skills: [], screening_template: [], is_active: true, created_at: '' },
    ]);
    renderCandidates();
    // Tailwind emits `w-full` after `w-auto`, so a base `w-full` would make
    // every caller override inert. The width is stated where it is wanted.
    expect((await screen.findByLabelText('Filter by role')).className).toContain(
      'w-full',
    );
  });

  it('gives every filter toggle a 44px minimum target', async () => {
    renderCandidates();
    const group = await screen.findByRole('group', { name: 'Filter by status' });
    const toggles = within(group).getAllByRole('button');
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      expect(toggle.className).toContain('min-h-11');
      // State is announced, not merely coloured.
      expect(toggle).toHaveAttribute('aria-pressed');
    }
  });

  it('has no axe violations in the loaded list', async () => {
    const { container } = renderCandidates();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations under a .dark document', async () => {
    document.documentElement.classList.add('dark');
    const { container } = renderCandidates();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });
});

describe('Candidate Detail accessibility after the restyle', () => {
  it('has no axe violations on the Overview', async () => {
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'Jane Doe' });
    await waitFor(() =>
      expect(mockApi.getCandidateAshbyWorkflow).toHaveBeenCalled(),
    );
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations under a .dark document', async () => {
    document.documentElement.classList.add('dark');
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'Jane Doe' });
    await waitFor(() =>
      expect(mockApi.getCandidateAshbyWorkflow).toHaveBeenCalled(),
    );
    await expect(container).toHaveNoViolations();
  });
});
