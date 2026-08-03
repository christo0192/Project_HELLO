/**
 * DashboardPage — truthful KPIs/charts/action queue:
 *   - KPIs + status donut from candidates
 *   - admin-only session charts (403-free role gating)
 *   - interviewer/admin action queue from notification intents
 *   - viewer truthful empty/notes states
 *   - loading/error/retry, empty data, axe, reduced-motion + dark render
 *
 * Charts run under jsdom with the same stubs as the chart-lib suite
 * (ResizeObserver, canvas context, matchMedia) and reduced-motion so KPI
 * count-up renders targets instantly. Every api method gets a default
 * resolution in beforeEach — the page loads them all in one effect.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { ThemeProvider } from '../lib/theme';
import { DashboardPage } from './DashboardPage';
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../components/design/__tests__/helpers';

const { getMe, listCandidates, listAdminSessions, listNotificationIntents } = vi.hoisted(() => ({
  getMe: vi.fn(),
  listCandidates: vi.fn(),
  listAdminSessions: vi.fn(),
  listNotificationIntents: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    getMe: (...args: any[]) => getMe(...args),
    listCandidates: (...args: any[]) => listCandidates(...args),
    listAdminSessions: (...args: any[]) => listAdminSessions(...args),
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
];

const SESSIONS = [
  { id: 's1', candidate_id: 'c1', role_id: null, status: 'completed', created_at: '2026-06-01T00:00:00Z', started_at: null, ended_at: null },
  { id: 's2', candidate_id: 'c2', role_id: null, status: 'completed', created_at: '2026-06-02T00:00:00Z', started_at: null, ended_at: null },
  { id: 's3', candidate_id: 'c3', role_id: null, status: 'in_progress', created_at: '2026-06-03T00:00:00Z', started_at: null, ended_at: null },
];

const INTENTS = [
  { id: 'i1', kind: 'assessment_ready', candidate_id: 'c1', consent_verified: true, created_at: '2026-06-04T00:00:00Z' },
  { id: 'i2', kind: 'appeal_resolved', candidate_id: 'c2', consent_verified: false, created_at: '2026-06-04T01:00:00Z' },
  { id: 'i3', kind: 'quota_warning', candidate_id: null, consent_verified: false, created_at: '2026-06-04T02:00:00Z' },
];

function wrap(ui: ReactNode) {
  return (
    <MemoryRouter initialEntries={['/dashboard']}>
      <ThemeProvider>{ui}</ThemeProvider>
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
    listAdminSessions.mockResolvedValue({ sessions: [] });
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

  it('shows an error state with a retry action on candidate failure', async () => {
    listCandidates.mockRejectedValueOnce({ message: 'API unavailable' });
    renderDashboard();
    expect(await screen.findByText('API unavailable')).toBeInTheDocument();
    listCandidates.mockResolvedValue(CANDIDATES);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Recent candidates')).toBeInTheDocument();
  });

  it('renders truthful KPIs and the candidate-status donut for any role', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    listNotificationIntents.mockResolvedValue({ intents: [] });
    renderDashboard();

    expect(await screen.findByText('Candidates')).toBeInTheDocument();
    const candidatesCard = screen
      .getByText('Candidates')
      .closest('.shadow-card') as HTMLElement;
    expect(within(candidatesCard).getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Awaiting screening')).toBeInTheDocument();
    expect(screen.getByText('In screening')).toBeInTheDocument();

    // Status donut pairs with an sr-only data table — the authoritative data.
    const statusTable = screen.getByRole('table', { name: 'Candidate status data' });
    expect(within(statusTable).getByRole('cell', { name: 'New' })).toBeInTheDocument();
    expect(within(statusTable).getByRole('cell', { name: 'Screened' })).toBeInTheDocument();
    expect(within(statusTable).getByRole('cell', { name: 'Screening' })).toBeInTheDocument();
  });

  it('does NOT fetch admin session data for viewers and shows a truthful note', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    listNotificationIntents.mockResolvedValue({ intents: [] });
    renderDashboard();
    await screen.findByText('Recent candidates');
    expect(listAdminSessions).not.toHaveBeenCalled();
    expect(listNotificationIntents).not.toHaveBeenCalled();
    expect(screen.getByText('Session metrics require admin access')).toBeInTheDocument();
    expect(
      screen.getByText(/Action items require interviewer or admin access/i),
    ).toBeInTheDocument();
  });

  it('renders admin session charts from real session data only', async () => {
    listAdminSessions.mockResolvedValue({ sessions: SESSIONS });
    renderDashboard();

    const sessionsTable = await screen.findByRole('table', {
      name: 'Sessions by status data',
    });
    expect(listAdminSessions).toHaveBeenCalledTimes(1);
    expect(within(sessionsTable).getByRole('cell', { name: 'Completed' })).toBeInTheDocument();
    expect(within(sessionsTable).getByRole('cell', { name: 'In progress' })).toBeInTheDocument();
    // The sessions-over-time line chart also pairs with a data table.
    expect(
      screen.getByRole('table', { name: 'Sessions started per day data' }),
    ).toBeInTheDocument();
  });

  it('renders the action queue from notification intents joined to candidates', async () => {
    getMe.mockResolvedValue(INTERVIEWER_ME);
    listNotificationIntents.mockResolvedValue({ intents: INTENTS });
    renderDashboard();

    expect(await screen.findByText('Screening ready for review')).toBeInTheDocument();
    expect(screen.getByText('Appeal resolved — review outcome')).toBeInTheDocument();
    expect(screen.getByText('Session quota nearing its limit')).toBeInTheDocument();
    // Intent → candidate join is a local name lookup, never an extra request.
    const queue = screen.getByRole('region', { name: 'Action queue' });
    const reviewLink = within(queue).getByRole('link', { name: 'Jane Doe' });
    expect(reviewLink).toHaveAttribute('href', '/candidates/c1');
    expect(within(queue).getByText('consent verified')).toBeInTheDocument();
    expect(within(queue).getByText('Workspace-wide')).toBeInTheDocument();
  });

  it('shows a caught-up empty state for the action queue', async () => {
    getMe.mockResolvedValue(INTERVIEWER_ME);
    listNotificationIntents.mockResolvedValue({ intents: [] });
    renderDashboard();
    expect(
      await screen.findByText(/You're all caught up — no pending items/i),
    ).toBeInTheDocument();
  });

  it('shows an inline error when intents cannot be loaded', async () => {
    getMe.mockResolvedValue(INTERVIEWER_ME);
    listNotificationIntents.mockRejectedValue({ message: 'intents unavailable' });
    renderDashboard();
    expect(await screen.findByText('intents unavailable')).toBeInTheDocument();
  });

  it('handles a completely empty pipeline truthfully', async () => {
    listCandidates.mockResolvedValue([]);
    listAdminSessions.mockResolvedValue({ sessions: [] });
    listNotificationIntents.mockResolvedValue({ intents: [] });
    renderDashboard();

    expect(await screen.findByText('No candidates yet')).toBeInTheDocument();
    // Both donuts show their truthful empty state (no fabricated statuses);
    // the hardcoded hint text is shared by DonutChart, so expect ≥ 1.
    expect(screen.getAllByText(/will appear here/).length).toBeGreaterThan(0);
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it('renders recent candidates with links to their detail pages', async () => {
    getMe.mockResolvedValue(VIEWER_ME);
    renderDashboard();
    const table = await screen.findByRole('table', { name: 'Recent candidates, newest first' });
    const janeLink = within(table).getByRole('link', { name: 'Jane Doe' });
    expect(janeLink).toHaveAttribute('href', '/candidates/c1');
    expect(within(table).getByText('5 yr')).toBeInTheDocument();
  });

  it('has no axe violations on a populated admin view', async () => {
    listAdminSessions.mockResolvedValue({ sessions: SESSIONS });
    listNotificationIntents.mockResolvedValue({ intents: INTENTS });
    const { container } = renderDashboard();
    await screen.findByText('Recent candidates');
    await expect(container).toHaveNoViolations();
  });

  it('renders under dark + reduced motion without crashing', async () => {
    stubMatchMedia(true); // dark (prefers-color-scheme) + reduced motion
    listAdminSessions.mockResolvedValue({ sessions: SESSIONS });
    listNotificationIntents.mockResolvedValue({ intents: INTENTS });
    renderDashboard();
    expect(await screen.findByText('Recent candidates')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(
      screen.getByRole('table', { name: 'Candidate status data' }),
    ).toBeInTheDocument();
  });
});
