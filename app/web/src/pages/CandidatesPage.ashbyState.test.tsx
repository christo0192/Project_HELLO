/**
 * CandidatesPage — the Active / Paused Ashby job scope and the search box
 * living in the candidate-list panel.
 *
 * Active = the role has a non-archived mapping that is `enabled` (Live in
 * Ashby Live Jobs); Paused = one that is `paused`; `drift` is in neither. The
 * scope must reach the table, the counts, both bars, the Pipeline-by-role
 * panel and the role dropdown, so no figure counts a hidden candidate.
 */
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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
    // The role dropdown still lists EVERY mapped role: the scope and the role
    // intersect, the scope never narrows or resets the role control.
    const select = screen.getByLabelText('Filter by role');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['All roles', 'Drift Role', 'Live Role', 'Paused Role']);
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

// ─── PR #359 review fixes ────────────────────────────────────────────────

/** Candidates that carry the per-candidate `ashby_job_status` (current API). */
const withStatus = (c: ReturnType<typeof cand>, ashby_job_status: 'enabled' | 'paused' | 'drift' | null) => ({
  ...c,
  ashby_job_status,
});

const ONE_ROLE_TWO_JOBS = [
  withStatus(cand('c1', 'Livia Live', 'r-live'), 'enabled'),
  withStatus(cand('c2', 'Pavel Paused', 'r-live'), 'paused'),
  withStatus(cand('c3', 'Nora NoLink', 'r-live'), null),
  withStatus(cand('c4', 'Pia Paused', 'r-paused'), 'paused'),
];

/** The API's role filter: only rows of the asked role come back. */
const byRole = (rows: any[]) => (roleId?: string) =>
  Promise.resolve(roleId ? rows.filter((r) => r.role_id === roleId) : rows);

describe('Active / Paused is attributed per candidate, and intersects with ?role=', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue(ROLES);
    mockApi.listCandidates.mockImplementation(byRole(ONE_ROLE_TWO_JOBS));
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('a candidate on a PAUSED job is not Active just because the role also has a live job', async () => {
    renderPage();
    const group = await screen.findByRole('group', { name: 'Filter by Ashby job status' });
    expect(within(group).getByRole('button', { name: /^Active/ })).toHaveTextContent('1');
    expect(within(group).getByRole('button', { name: /^Paused/ })).toHaveTextContent('2');
    fireEvent.click(within(group).getByRole('button', { name: /^Active/ }));
    expect(names()).toEqual(['Livia Live']);
    fireEvent.click(within(group).getByRole('button', { name: /^Paused/ }));
    expect(names().sort()).toEqual(['Pavel Paused', 'Pia Paused']);
  });

  it('each segment count equals the rows it shows, with a role selected', async () => {
    renderPage('/candidates?role=r-live');
    const group = await screen.findByRole('group', { name: 'Filter by Ashby job status' });
    await screen.findByText('Livia Live');
    // Counts are over the role-scoped load: 3 candidates, 1 active, 1 paused.
    expect(within(group).getByRole('button', { name: /^All/ })).toHaveTextContent('3');
    expect(within(group).getByRole('button', { name: /^Active/ })).toHaveTextContent('1');
    expect(within(group).getByRole('button', { name: /^Paused/ })).toHaveTextContent('1');
    fireEvent.click(within(group).getByRole('button', { name: /^Paused/ }));
    expect(names()).toEqual(['Pavel Paused']);
  });

  it('choosing a segment KEEPS the role; ?role= and ?ashby= are both in the URL', async () => {
    renderPage('/candidates?role=r-live');
    const group = await screen.findByRole('group', { name: 'Filter by Ashby job status' });
    await screen.findByText('Livia Live');
    fireEvent.click(within(group).getByRole('button', { name: /^Paused/ }));
    const search = screen.getByTestId('location').textContent ?? '';
    expect(search).toContain('role=r-live');
    expect(search).toContain('ashby=paused');
    expect(screen.getByLabelText('Filter by role')).toHaveValue('r-live');
    // No second load, no reset: the role was never dropped.
    expect(mockApi.listCandidates.mock.calls.map((c) => c[0])).toEqual(['r-live']);
  });

  it('an empty role x scope intersection is a calm empty state with a clear-filter action', async () => {
    // r-drift's only candidate is on a drift job: neither Active nor Paused.
    mockApi.listCandidates.mockImplementation(
      byRole([...ONE_ROLE_TWO_JOBS, withStatus(cand('c9', 'Dara Drift', 'r-drift'), 'drift')]),
    );
    renderPage('/candidates?role=r-drift&ashby=paused');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
    expect(screen.queryByText('No candidates yet')).not.toBeInTheDocument();
    // The role survives, and the segment advertises exactly what the rows show.
    expect(screen.getByLabelText('Filter by role')).toHaveValue('r-drift');
    const group = screen.getByRole('group', { name: 'Filter by Ashby job status' });
    expect(within(group).getByRole('button', { name: /^Paused/ })).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('location').textContent).toBe('');
  });

  it('falls back to the role-level rule, still keeping the role, when candidates lack the field', async () => {
    // CANDIDATES carry no ashby_job_status (an older API).
    mockApi.listCandidates.mockImplementation(byRole(CANDIDATES));
    renderPage('/candidates?role=r-live');
    const group = await screen.findByRole('group', { name: 'Filter by Ashby job status' });
    await screen.findByText('Livia Live');
    expect(within(group).getByRole('button', { name: /^Paused/ })).toHaveTextContent('0');
    fireEvent.click(within(group).getByRole('button', { name: /^Paused/ }));
    expect(screen.getByTestId('location').textContent).toContain('role=r-live');
    expect(screen.getByLabelText('Filter by role')).toHaveValue('r-live');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
  });

  it('shows the cap notice from the RAW load when an Ashby scope narrows it below 1,000', async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      withStatus(cand(`m${i}`, `Person ${i}`, 'r-live'), i < 3 ? 'enabled' : 'paused'),
    );
    mockApi.listCandidates.mockImplementation(byRole(many));
    renderPage('/candidates?ashby=active');
    await screen.findByText('Person 0');
    expect(names()).toHaveLength(3);
    expect(screen.getByText(/Showing the newest 1,000 candidates/)).toBeInTheDocument();
  });
});

describe('Active / Paused edge states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue(ROLES);
    mockApi.listCandidates.mockImplementation(byRole(ONE_ROLE_TWO_JOBS));
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('strips an ?ashby= this API cannot answer, with no chip-less "Active filters" row', async () => {
    mockApi.listRoles.mockResolvedValue(ROLES.map(({ ashby_mapping_statuses: _s, ...r }: any) => r));
    mockApi.listCandidates.mockImplementation(byRole(CANDIDATES));
    renderPage('/candidates?ashby=active');
    await screen.findByText('Livia Live');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(''));
    expect(screen.queryByText('Active filters:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('strips ?ashby= when the roles call fails and the candidates have no per-candidate field', async () => {
    mockApi.listRoles.mockRejectedValue(new Error('boom'));
    mockApi.listCandidates.mockImplementation(byRole(CANDIDATES));
    renderPage('/candidates?ashby=paused');
    await screen.findByText('Livia Live');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(''));
    expect(screen.queryByText('Active filters:')).not.toBeInTheDocument();
  });

  it('keeps ?ashby= in the URL for an EMPTY load even when the roles call failed', async () => {
    mockApi.listRoles.mockRejectedValue(new Error('boom'));
    mockApi.listCandidates.mockResolvedValue([]);
    renderPage('/candidates?ashby=paused');
    await screen.findByText('No candidates yet');
    // Give the (not-fired) strip effect a chance to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('location').textContent).toContain('ashby=paused');
  });

  it('falls back to the role-level rule when the server omits ashby_job_status (failed status read)', async () => {
    mockApi.listCandidates.mockImplementation(byRole(CANDIDATES));
    renderPage('/candidates?ashby=active');
    expect(await screen.findByText('Livia Live')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toContain('ashby=active');
  });

  it('never shows the loading panel and "No candidates yet" together', async () => {
    // Roles never settle, candidates are empty, deep link carries ?ashby=.
    mockApi.listRoles.mockReturnValue(new Promise(() => {}));
    mockApi.listCandidates.mockResolvedValue([]);
    renderPage('/candidates?ashby=active');
    expect(await screen.findByText('Loading candidates…')).toBeInTheDocument();
    expect(screen.queryByText('No candidates yet')).not.toBeInTheDocument();
  });

  it('keeps the search box and its live region mounted across a reload', async () => {
    renderPage();
    const box = await screen.findByRole('searchbox', { name: 'Search candidates' });
    const liveRegion = () =>
      screen.getByRole('region', { name: 'Candidate list' }).querySelector('p[role="status"]');
    const region = liveRegion();
    let release: (rows: unknown[]) => void = () => {};
    mockApi.listCandidates.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: 'r-live' } });
    // Mid-reload: same DOM nodes, loading shown inside the panel.
    expect(await screen.findByText('Loading candidates…')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search candidates' })).toBe(box);
    expect(liveRegion()).toBe(region);
    release(ONE_ROLE_TWO_JOBS.filter((c) => c.role_id === 'r-live'));
    expect(await screen.findByText('Livia Live')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search candidates' })).toBe(box);
  });

  it('keeps the search box when a role-scoped load is empty but ?q= is set', async () => {
    mockApi.listCandidates.mockImplementation(byRole([]));
    renderPage('/candidates?role=r-live&q=zed');
    const box = await screen.findByRole('searchbox', { name: 'Search candidates' });
    expect(box).toHaveValue('zed');
    expect(screen.queryByText('No candidates yet')).not.toBeInTheDocument();
    expect(screen.getByText('No candidates match these filters')).toBeInTheDocument();
  });
});
