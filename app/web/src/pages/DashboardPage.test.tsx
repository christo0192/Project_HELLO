/**
 * DashboardPage — truthful, fully-navigable recruiter business dashboard:
 *   - KPIs derived from candidate statuses, each a drill-down link
 *   - screening funnel donut with per-status legend links + click-to-navigate
 *   - completion + outcome links, all → /candidates?status=…
 *   - candidate intake trend (all roles) from created_at
 *   - prioritized work queue from notification intents (interviewer/admin)
 *   - viewer/empty/error/retry, axe, reduced-motion + dark render
 *
 * Charts run under jsdom with the same stubs as the chart-lib suite.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { ThemeProvider } from '../lib/theme';
import { DashboardPage } from './DashboardPage';
import { candidatesHref } from '../components/talent';
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../components/design/__tests__/helpers';

const { getMe, listCandidates, listNotificationIntents } = vi.hoisted(() => ({
  getMe: vi.fn(),
  listCandidates: vi.fn(),
  listNotificationIntents: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    getMe: (...args: any[]) => getMe(...args),
    listCandidates: (...args: any[]) => listCandidates(...args),
    listNotificationIntents: (...args: any[]) => listNotificationIntents(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const ADMIN_ME = { userId: 'u-admin', email: 'admin@example.com', role: 'admin' as const, active: true };
const VIEWER_ME = { userId: 'u-viewer', email: 'viewer@example.com', role: 'viewer' as const, active: true };
const INTERVIEWER_ME = { userId: 'u-int', email: 'int@example.com', role: 'interviewer' as const, active: true };

const CANDIDATES = [
  { id: 'c1', name: 'Jane Doe', email: 'jane@example.com', phone_e164: '+1', phone_valid: true, skills: ['React'], experience_years: 5, status: 'new', role_id: null, created_at: '2026-06-01T00:00:00Z' },
  { id: 'c2', name: 'Bob Smith', email: 'bob@example.com', phone_e164: null, phone_valid: false, skills: [], experience_years: null, status: 'screened', role_id: null, created_at: '2026-06-02T00:00:00Z' },
  { id: 'c3', name: 'Alice Wu', email: 'alice@example.com', phone_e164: '+2', phone_valid: true, skills: ['Python'], experience_years: 3, status: 'screening', role_id: null, created_at: '2026-06-03T00:00:00Z' },
  { id: 'c4', name: 'Ken Ito', email: 'ken@example.com', phone_e164: '+3', phone_valid: true, skills: [], experience_years: 2, status: 'advanced', role_id: null, created_at: '2026-06-04T00:00:00Z' },
];

const INTENTS = [
  { id: 'i1', kind: 'assessment_ready', candidate_id: 'c1', consent_verified: true, created_at: '2026-06-04T00:00:00Z' },
  { id: 'i2', kind: 'appeal_resolved', candidate_id: 'c2', consent_verified: false, created_at: '2026-06-04T01:00:00Z' },
  { id: 'i3', kind: 'quota_warning', candidate_id: null, consent_verified: false, created_at: '2026-06-04T02:00:00Z' },
];

function CandidatesProbe() {
  const [params] = useSearchParams();
  return <div data-testid="probe">status={params.get('status') ?? ''}</div>;
}

function wrap(ui: ReactNode) {
  return (
    <MemoryRouter initialEntries={['/dashboard']}>
      <ThemeProvider>
        <Routes>
          <Route path="/dashboard" element={ui} />
          <Route path="/candidates" element={<CandidatesProbe />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>
  );
}

function renderDashboard() {
  return render(wrap(<DashboardPage />));
}

describe('DashboardPage', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    allowEchartsInitWarnings();
    vi.clearAllMocks();
    getMe.mockResolvedValue(ADMIN_ME);
    listCandidates.mockResolvedValue(CANDIDATES);
    listNotificationIntents.mockResolvedValue({ intents: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a loading state until the core data loads', () => {
    getMe.mockReturnValue(new Promise(() => {}));
    renderDashboard();
    expect(screen.getByText('Loading dashboard…')).toBeInTheDocument();
  });

  it('shows an error state with retry on candidate failure', async () => {
    listCandidates.mockRejectedValueOnce({ message: 'API unavailable' });
    renderDashboard();
    expect(await screen.findByText('API unavailable')).toBeInTheDocument();
    listCandidates.mockResolvedValue(CANDIDATES);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Recent candidates')).toBeInTheDocument();
  });

  it('renders KPI drill-down links for every stage (any role)', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();

    const total = await screen.findByRole('link', { name: /candidates in pipeline/i });
    expect(total).toHaveAttribute('href', candidatesHref());

    expect(
      screen.getByRole('link', { name: /awaiting screening/i }),
    ).toHaveAttribute('href', candidatesHref({ statuses: ['new'] }));
    expect(screen.getByRole('link', { name: /in screening/i })).toHaveAttribute(
      'href',
      candidatesHref({ statuses: ['queued', 'screening'] }),
    );
    expect(
      screen.getByRole('link', { name: /awaiting a decision/i }),
    ).toHaveAttribute('href', candidatesHref({ statuses: ['screened'] }));
  });

  it('derives the funnel donut + data table from candidate statuses', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    const table = await screen.findByRole('table', { name: 'Screening funnel data' });
    expect(within(table).getByRole('cell', { name: 'New' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Screened' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Advanced' })).toBeInTheDocument();
  });

  it('drills down when a KPI link is clicked (URL filter applied)', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    const link = await screen.findByRole('link', { name: /awaiting a decision/i });
    fireEvent.click(link);
    expect(await screen.findByTestId('probe')).toHaveTextContent('status=screened');
  });

  it('exposes the funnel legend stages as navigable links', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    const legendLink = await screen.findByRole('link', {
      name: /New:.*View these candidates/i,
    });
    expect(legendLink).toHaveAttribute('href', candidatesHref({ statuses: ['new'] }));
  });

  it('shows completion and outcome links', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    // 1 decided (advanced) of 4 considered = 25%
    expect(await screen.findByText(/1 of 4 decided/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /advanced candidates/i }),
    ).toHaveAttribute('href', candidatesHref({ statuses: ['advanced'] }));
    expect(
      screen.getByRole('link', { name: /rejected candidates/i }),
    ).toHaveAttribute('href', candidatesHref({ statuses: ['rejected'] }));
  });

  it('renders a candidate intake trend from created_at', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    expect(
      await screen.findByRole('table', { name: 'Candidates added per day data' }),
    ).toBeInTheDocument();
  });

  it('renders the prioritized work queue from intents joined to candidates', async () => {
    getMe.mockResolvedValue(INTERVIEWER_ME);
    listNotificationIntents.mockResolvedValue({ intents: INTENTS });
    renderDashboard();

    expect(await screen.findByText('Screening ready for review')).toBeInTheDocument();
    const queue = screen.getByRole('region', { name: 'Action queue' });
    const reviewLink = within(queue).getByRole('link', { name: 'Jane Doe' });
    expect(reviewLink).toHaveAttribute('href', '/candidates/c1');
    expect(within(queue).getByText('consent verified')).toBeInTheDocument();
    expect(within(queue).getByText('Workspace-wide')).toBeInTheDocument();
  });

  it('gates the work queue for viewers and never fetches intents', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    await screen.findByText('Recent candidates');
    expect(listNotificationIntents).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Action items require interviewer or admin access/i),
    ).toBeInTheDocument();
  });

  it('shows the admin Mission Control link only for admins', async () => {
    renderDashboard();
    expect(await screen.findByRole('link', { name: /Open Mission Control/i })).toBeInTheDocument();
  });

  it('handles a completely empty pipeline truthfully', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    listCandidates.mockResolvedValue([]);
    renderDashboard();
    expect(await screen.findByText('No candidates yet')).toBeInTheDocument();
    expect(screen.getAllByText(/will appear here/).length).toBeGreaterThan(0);
  });

  it('has no axe violations on a populated interviewer view', async () => {
    getMe.mockResolvedValue(INTERVIEWER_ME);
    listNotificationIntents.mockResolvedValue({ intents: INTENTS });
    const { container } = renderDashboard();
    await screen.findByText('Recent candidates');
    await expect(container).toHaveNoViolations();
  });

  it('renders under dark + reduced motion without crashing', async () => {
    stubMatchMedia(true);
    listNotificationIntents.mockResolvedValue({ intents: INTENTS });
    renderDashboard();
    expect(await screen.findByText('Recent candidates')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(
      screen.getByRole('table', { name: 'Screening funnel data' }),
    ).toBeInTheDocument();
  });
});
