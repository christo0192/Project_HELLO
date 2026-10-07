/**
 * CandidatesPage — the Active / Paused Ashby job scope and the search box
 * living in the candidate-list panel.
 *
 * Active = the role has a non-archived mapping that is `enabled` (Live in
 * Ashby Live Jobs); Paused = one that is `paused`; `drift` is in neither. The
 * scope must reach the table, the counts, both bars, the Pipeline-by-role
 * panel and the role dropdown, so no figure counts a hidden candidate.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidatesPage } from './CandidatesPage';
import { mockCandidate, mockRole } from '../test/helpers';
import { EMPTY_FUNNEL_TOTALS, funnelTotals } from '../test/funnel';

const mockApi = {
  listRoles: vi.fn(),
  listCandidates: vi.fn(),
  uploadResume: vi.fn(),
  getScreeningFunnel: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    listCandidates: (...args: any[]) => mockApi.listCandidates(...args),
    uploadResume: (...args: any[]) => mockApi.uploadResume(...args),
    getScreeningFunnel: (...args: any[]) => mockApi.getScreeningFunnel(...args),
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
  },
  ApiError: class extends Error {},
}));

const role = (id: string, title: string, statuses?: string[]) => ({
  ...mockRole,
  id,
  title,
  has_ashby_mapping: (statuses ?? []).length > 0,
  ...(statuses ? { ashby_mapping_statuses: statuses } : {}),
});

const ROLES = [
  role('r-live', 'Live Role', ['enabled']),
  role('r-paused', 'Paused Role', ['paused']),
  role('r-drift', 'Drift Role', ['drift']),
  role('r-none', 'Unmapped Role', []),
];

const cand = (id: string, name: string, roleId: string | null, status = 'new') => ({
  ...mockCandidate,
  id,
  name,
  email: `${id}@example.com`,
  role_id: roleId,
  status,
});

const CANDIDATES = [
  cand('c1', 'Livia Live', 'r-live'),
  cand('c2', 'Lars Live', 'r-live', 'screened'),
  cand('c3', 'Paula Paused', 'r-paused'),
  cand('c4', 'Dara Drift', 'r-drift'),
  cand('c5', 'Nobody Role', null),
];

function Probe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPage(entry = '/candidates') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CandidatesPage />
      <Probe />
    </MemoryRouter>,
  );
}

const names = () =>
  Array.from(screen.getByRole('table').querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('a')?.textContent ?? '',
  );

describe('CandidatesPage Active / Paused scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue(ROLES);
    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('offers All | Active | Paused with counts, All pressed by default', async () => {
    renderPage();
    const group = await screen.findByRole('group', { name: 'Filter by Ashby job status' });
    const all = within(group).getByRole('button', { name: /^All/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /^Active/ })).toHaveTextContent('2');
    expect(within(group).getByRole('button', { name: /^Paused/ })).toHaveTextContent('1');
    expect(names()).toHaveLength(5);
  });

  it('Active shows only candidates of live roles; Paused only paused; drift in neither', async () => {
    renderPage();
    const group = await screen.findByRole('group', { name: 'Filter by Ashby job status' });
    fireEvent.click(within(group).getByRole('button', { name: /^Active/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('ashby=active');
    expect(names().sort()).toEqual(['Lars Live', 'Livia Live']);

    fireEvent.click(within(group).getByRole('button', { name: /^Paused/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('ashby=paused');
    expect(names()).toEqual(['Paula Paused']);

    fireEvent.click(within(group).getByRole('button', { name: /^All/ }));
    expect(screen.getByTestId('location')).not.toHaveTextContent('ashby');
    expect(names()).toHaveLength(5);
  });

  it('re-bases the heading, the bars and the role dropdown on the scope', async () => {
    renderPage('/candidates?ashby=active');
    await screen.findByText('Livia Live');
    // Heading counts the scoped set, not all five.
    expect(screen.getByRole('heading', { name: /All candidates/ })).toHaveTextContent('2');
    // Status bar: 1 new + 1 screened inside the scope.
    const bar = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(bar).getByRole('button', { name: /New/ })).toHaveTextContent('1');
    expect(within(bar).getByRole('button', { name: /Screened/ })).toHaveTextContent('1');
    // The role dropdown lists only roles in the scope.
    const select = screen.getByLabelText('Filter by role');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['All roles', 'Live Role']);
    // Removable chip.
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Ashby jobs: Active' }));
    expect(screen.getByTestId('location')).not.toHaveTextContent('ashby');
  });

  it('feeds only in-scope roles to the Pipeline by role panel', async () => {
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: funnelTotals({ candidates_total: 3 }) });
    renderPage('/candidates?ashby=paused');
    await screen.findByText('Paula Paused');
    // One in-scope role is charted, so the disclosure says "Show 1 role".
    expect(await screen.findByRole('button', { name: /^Show 1 role/ })).toBeInTheDocument();
    const charted = mockApi.getScreeningFunnel.mock.calls.map((c) => (c[0] as { role_id: string }).role_id);
    expect(charted).toEqual(['r-paused']);
  });

  it('hides the control and ignores ?ashby on an API without ashby_mapping_statuses', async () => {
    mockApi.listRoles.mockResolvedValue(ROLES.map(({ ashby_mapping_statuses: _s, ...r }: any) => r));
    renderPage('/candidates?ashby=active');
    await screen.findByText('Livia Live');
    expect(screen.queryByRole('group', { name: 'Filter by Ashby job status' })).toBeNull();
    expect(names()).toHaveLength(5);
  });

  it('shows the empty-match state, not "No candidates yet", when the scope is empty', async () => {
    mockApi.listCandidates.mockResolvedValue([cand('c4', 'Dara Drift', 'r-drift')]);
    renderPage('/candidates?ashby=active');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
    expect(screen.queryByText('No candidates yet')).not.toBeInTheDocument();
  });
});

describe('CandidatesPage search lives in the candidate-list panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue(ROLES);
    mockApi.listCandidates.mockResolvedValue(CANDIDATES);
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('puts the searchbox in the panel with the table, not in the Filters panel', async () => {
    renderPage();
    const box = await screen.findByRole('searchbox', { name: 'Search candidates' });
    const panel = screen.getByRole('region', { name: 'Candidate list' });
    expect(panel.contains(box)).toBe(true);
    expect(panel.contains(screen.getByRole('table'))).toBe(true);
    expect(screen.getByRole('region', { name: 'Filters' }).contains(box)).toBe(false);
  });

  it('keeps the box mounted when a search matches nothing, so it can be cleared', async () => {
    renderPage('/candidates?q=zzzznomatch');
    expect(await screen.findByText(/No candidates match/)).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: 'Search candidates' });
    expect(box).toHaveValue('zzzznomatch');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear search' })[0]);
    expect(await screen.findByText('Livia Live')).toBeInTheDocument();
  });
});
