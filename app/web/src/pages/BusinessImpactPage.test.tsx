/**
 * Business impact (M031 S6): the role gate, the reads it makes, the filters,
 * every state (loading, failed, empty, Ashby stages not read), each section
 * drawn from the summary, and the list behind a number.
 *
 * The network trap in `src/test/setup.ts` fails any read these mocks miss.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickOption, stubMatchMedia } from '../components/design/__tests__/helpers';
import { ashbyUnreadSummary, candidatesPage, impactSummary } from '../components/impact/__tests__/impactFixture';
import { ApiError } from '../lib/api-client';

const getMe = vi.hoisted(() => vi.fn());
const fetchSummary = vi.hoisted(() => vi.fn());
const fetchCandidates = vi.hoisted(() => vi.fn());

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-client')>('../lib/api-client');
  return { api: { getMe: (...args: unknown[]) => getMe(...args) }, ApiError: actual.ApiError };
});

vi.mock('../lib/impact', async () => {
  const actual = await vi.importActual<typeof import('../lib/impact')>('../lib/impact');
  return {
    ...actual,
    fetchImpactSummary: (...args: unknown[]) => fetchSummary(...args),
    fetchImpactCandidates: (...args: unknown[]) => fetchCandidates(...args),
  };
});

import { BusinessImpactPage } from './BusinessImpactPage';

const ME = (role: 'admin' | 'interviewer' | 'viewer') => ({ userId: 'u-1', email: 'reader@example.com', role, active: true });

let location = '';
function Where() {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
}

function renderPage(path = '/impact') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/impact" element={<><BusinessImpactPage /><Where /></>} />
        <Route path="/candidates/:id" element={<><p>Candidate page</p><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The summary's last call: its filters. */
const lastSummaryCall = () => fetchSummary.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  // Wednesday 16 Sep 2026, 12:00 IST. Only Date: promises and timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-16T06:30:00.000Z'));
  stubMatchMedia(false, '(max-width: 639px)');
  getMe.mockResolvedValue(ME('admin'));
  fetchSummary.mockResolvedValue(impactSummary());
  fetchCandidates.mockResolvedValue(candidatesPage());
});

afterEach(() => {
  vi.useRealTimers();
});

const sectionNamed = (name: string | RegExp) => screen.getByRole('region', { name });

describe('who sees it', () => {
  it('shows a viewer a truthful panel and never asks the impact API anything', async () => {
    getMe.mockResolvedValue(ME('viewer'));
    renderPage();
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Business impact' })).toBeInTheDocument();
    expect(fetchSummary).not.toHaveBeenCalled();
  });

  it.each(['admin', 'interviewer'] as const)('reads the summary for an %s', async (role) => {
    getMe.mockResolvedValue(ME(role));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
    expect(fetchSummary).toHaveBeenCalledTimes(1);
  });

  it('says so when the access check fails, and checks again on Retry', async () => {
    getMe.mockRejectedValueOnce(new ApiError('Could not reach the server.', 0));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't check your access.");
    expect(fetchSummary).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
  });
});

describe('the header and filters', () => {
  it('names the page and what it counts, and asks for the last 12 IST weeks by default', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });
    expect(screen.getByText('Ashby applications Christy screened. A person decides in Ashby.')).toBeInTheDocument();
    expect(lastSummaryCall()).toEqual({ from: '2026-06-29', to: '2026-09-16', job: null });
    expect(screen.getByRole('button', { name: '12 weeks', pressed: true })).toBeInTheDocument();
  });

  it('prints when Ashby stages were checked and how much of the pipeline that covers', async () => {
    fetchSummary.mockResolvedValue(impactSummary({ meta: { ...impactSummary().meta, staleRows: 3 } }));
    renderPage();
    expect(await screen.findByTestId('impact-freshness')).toHaveTextContent(
      'Ashby stages checked 5 minutes ago, 412 of 415 applications. 3 applications are due a fresh check.',
    );
  });

  it('asks again when the weeks change, and keeps them in the address', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });
    await user.click(screen.getByRole('button', { name: '4 weeks' }));
    await waitFor(() => expect(lastSummaryCall()).toEqual({ from: '2026-08-24', to: '2026-09-16', job: null }));
    expect(location).toBe('/impact?weeks=4');
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastSummaryCall()).toEqual({ from: '2026-01-01', to: '2026-09-16', job: null }));
    await user.click(screen.getByRole('button', { name: '12 weeks' }));
    await waitFor(() => expect(location).toBe('/impact'));
  });

  it('asks for one job when one is picked from the jobs the summary names', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });
    await pickOption(user, /^Job/, 'Academic Counsellor');
    await waitFor(() => expect(lastSummaryCall()).toEqual({ from: '2026-06-29', to: '2026-09-16', job: 'job-ac' }));
    expect(location).toBe('/impact?job=job-ac');
  });

  it('reads its filters from the address', async () => {
    renderPage('/impact?weeks=26&job=job-spa');
    await screen.findByRole('heading', { name: 'The pipeline' });
    expect(fetchSummary.mock.calls[0]?.[0]).toEqual({ from: '2026-03-23', to: '2026-09-16', job: 'job-spa' });
  });

  it('drops a job the summary no longer offers, rather than filtering on one nobody can see', async () => {
    renderPage('/impact?job=job-gone');
    await waitFor(() => expect(location).toBe('/impact'));
    await waitFor(() => expect(lastSummaryCall()).toEqual({ from: '2026-06-29', to: '2026-09-16', job: null }));
  });
});

describe('the states', () => {
  it('shows a loading state while the summary is read', async () => {
    fetchSummary.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByText('Loading business impact…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'The pipeline' })).toBeNull();
  });

  it('says what failed, in words, and reads again on Retry', async () => {
    fetchSummary.mockRejectedValueOnce(new ApiError('impact_unavailable', 503, 'impact_unavailable'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Business impact couldn’t load. These figures are not available just now.');
    expect(alert).not.toHaveTextContent('impact_unavailable');
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
    expect(fetchSummary).toHaveBeenCalledTimes(2);
  });

  it('offers no Retry on a refusal that a retry cannot change', async () => {
    fetchSummary.mockRejectedValueOnce(new ApiError('forbidden', 403, 'forbidden'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your role does not give you access to this.');
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('resets the filters when the API refuses them', async () => {
    fetchSummary.mockRejectedValueOnce(new ApiError('invalid_filter', 400, 'invalid_filter'));
    renderPage('/impact?weeks=4');
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(location).toBe('/impact'));
    expect(await screen.findByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
    expect(fetchSummary).toHaveBeenCalledTimes(2);
  });

  it('reads again, once, when a reset leaves the window as it was', async () => {
    fetchSummary.mockRejectedValueOnce(new ApiError('invalid_filter', 400, 'invalid_filter'));
    // `?weeks=9` names no option, so the page already reads the default 12 weeks.
    renderPage('/impact?weeks=9');
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(location).toBe('/impact'));
    expect(await screen.findByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
    expect(fetchSummary).toHaveBeenCalledTimes(2);
  });

  it('offers Try again, not a reset that would change nothing, when the refused read had no filter set', async () => {
    fetchSummary.mockRejectedValueOnce(new ApiError('invalid_filter', 400, 'invalid_filter'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Business impact couldn’t load.');
    expect(alert).not.toHaveTextContent('Reset them');
    expect(within(alert).queryByRole('button', { name: 'Reset filters' })).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
    expect(fetchSummary).toHaveBeenCalledTimes(2);
    expect(lastSummaryCall()).toMatchObject({ from: '2026-06-29', to: '2026-09-16', job: null });
  });

  it('says nothing came in only after a read that succeeded, and draws no section', async () => {
    const empty = impactSummary();
    empty.pipeline = empty.pipeline.map((row) => ({ ...row, reached: 0, ofPrevious: null, ofCameIn: null, stillHere: 0, droppedHere: 0 }));
    fetchSummary.mockResolvedValue({ ...empty, cohorts: [], byJob: [], leaves: [] });
    renderPage();
    expect(await screen.findByText('No Ashby application came in during these weeks')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'The pipeline' })).toBeNull();
    expect(screen.getByText('How these numbers are calculated')).toBeInTheDocument();
  });

  it.each([
    ['the progress worker is off', { progressEnabled: false, lastPassAt: null, coverage: { checked: 0, total: 415 } }],
    ['no application has been checked', { coverage: { checked: 0, total: 415 } }],
  ])('says Ashby stages are not being read when %s, and prints dashes, never zeros', async (_why, meta) => {
    fetchSummary.mockResolvedValue(ashbyUnreadSummary(meta));
    renderPage();
    expect(await screen.findByText(/Ashby stages are not being read yet/)).toBeInTheDocument();
    const pipeline = sectionNamed('The pipeline');
    const hired = within(pipeline).getAllByRole('row').find((row) => row.getAttribute('data-step') === 'hired');
    expect(hired).toBeDefined();
    expect(within(hired!).getAllByText('Not available').length).toBeGreaterThanOrEqual(3);
    expect(within(hired!).queryByText('0')).toBeNull();
    // Christy's own steps still count.
    expect(within(pipeline).getByRole('button', { name: /^240, reached Christy connected/ })).toBeInTheDocument();
    expect(within(sectionNamed('Where candidates leave')).getByText(/Not known yet/)).toBeInTheDocument();
  });

  it('names stages nobody has labelled yet', async () => {
    fetchSummary.mockResolvedValue(impactSummary({ meta: { ...impactSummary().meta, unlabelledStages: 2 } }));
    renderPage();
    expect(await screen.findByText(/2 Ashby stages have no milestone label yet/)).toBeInTheDocument();
  });
});

describe('the sections', () => {
  it('draws every section in the plan’s order', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      'The pipeline',
      'Christy’s verdict against what happened next',
      'Where candidates leave',
      'Time between steps',
      'Weekly cohorts',
      'By job',
    ]);
  });

  it('prints the pipeline with the call answered line and its shares', async () => {
    renderPage();
    const pipeline = await screen.findByRole('region', { name: 'The pipeline' });
    expect(within(pipeline).getByText('Call answered')).toBeInTheDocument();
    const connected = within(pipeline).getAllByRole('row').find((row) => row.getAttribute('data-step') === 'connected')!;
    expect(connected).toHaveTextContent('Christy connected');
    expect(connected).toHaveTextContent('63%');
    expect(connected).toHaveTextContent('58%');
    const hired = within(pipeline).getAllByRole('row').find((row) => row.getAttribute('data-step') === 'hired')!;
    expect(hired).toHaveTextContent('1.4%');
    expect(within(pipeline).getByRole('group', { name: 'Headline counts' })).toBeInTheDocument();
  });

  it('prints each verdict in words with its family, and each cell with its share of the row', async () => {
    renderPage();
    const verdicts = await screen.findByRole('region', { name: 'Christy’s verdict against what happened next' });
    expect(within(verdicts).getByText('Select').closest('[data-recommendation]')).toHaveAttribute('data-recommendation', 'advance');
    expect(within(verdicts).getByText('Reject').closest('[data-recommendation]')).toHaveClass('text-closed-text');
    expect(within(verdicts).getByText('Held (thin evidence)').closest('[data-recommendation]')).toHaveClass('text-ink');
    const select = within(verdicts).getAllByRole('row').find((row) => row.getAttribute('data-verdict') === 'select')!;
    // 18 of 21 moved forward.
    expect(within(select).getByRole('button', { name: '18, Select, Moved forward. Show these applications' })).toBeInTheDocument();
    expect(select).toHaveTextContent('86%');
  });

  it('prints n too small, with n, for a timing the API withheld', async () => {
    renderPage();
    const timings = await screen.findByRole('region', { name: 'Time between steps' });
    const row = within(timings).getAllByRole('row').find((r) => r.getAttribute('data-timing') === 'r1_to_r2')!;
    expect(row).toHaveTextContent('n too small');
    expect(row).toHaveTextContent('3');
  });

  it('marks a young week as still maturing, newest first', async () => {
    renderPage();
    const cohorts = await screen.findByRole('region', { name: 'Weekly cohorts' });
    const weeks = within(cohorts).getAllByRole('row').slice(1).map((row) => row.getAttribute('data-week'));
    expect(weeks).toEqual(['2026-09-14', '2026-08-31', '2026-07-06']);
    const young = within(cohorts).getAllByRole('row')[1]!;
    expect(within(young).getByText('Still maturing')).toBeInTheDocument();
    const old = within(cohorts).getAllByRole('row')[3]!;
    expect(within(old).queryByText('Still maturing')).toBeNull();
  });

  it('closes with every definition behind one disclosure', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });
    const summary = screen.getByText('How these numbers are calculated');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Christy connected', { selector: 'dt' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });
    await expect(container).toHaveNoViolations();
  });
});

describe('the list behind a number', () => {
  it('opens the applications behind a count, for the page’s weeks and job, and moves focus into it', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    const pipeline = await screen.findByRole('region', { name: 'The pipeline' });
    const count = within(pipeline).getByRole('button', { name: '240, reached Christy connected. Show these applications' });
    await user.click(count);
    const dialog = await screen.findByRole('dialog', { name: 'Reached: Christy connected' });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAccessibleDescription(/^240 applications, last 12 weeks, all jobs\./);
    expect(fetchCandidates).toHaveBeenCalledWith(
      { from: '2026-06-29', to: '2026-09-16', job: null, target: { kind: 'step', step: 'connected' }, page: 1, pageSize: 50 },
      expect.any(AbortSignal),
    );
    const link = await within(dialog).findByRole('link', { name: 'Ishita Varma' });
    expect(link).toHaveAttribute('href', '/candidates/cand-1?tab=phone');
    expect(within(dialog).getByText('Provisional')).toBeInTheDocument();
    expect(within(dialog).queryByText(/@/)).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count).toHaveFocus();
  });

  it('asks for a dropped step, a verdict cell and a stage archive with the contract’s words', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole('heading', { name: 'The pipeline' });

    await user.click(screen.getByRole('button', { name: '40, dropped at Christy called. Show these applications' }));
    expect(fetchCandidates.mock.calls.at(-1)?.[0].target).toEqual({ kind: 'step', step: 'called', dropped: true });
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: '38, Reject, Moved forward. Show these applications' }));
    expect(await screen.findByRole('dialog', { name: 'Reject · Moved forward' })).toBeInTheDocument();
    expect(fetchCandidates.mock.calls.at(-1)?.[0].target).toEqual({ kind: 'verdict', verdict: 'reject', outcome: 'moved_forward' });
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: '95, archived at Hello Christy. Show these applications' }));
    expect(fetchCandidates.mock.calls.at(-1)?.[0].target).toEqual({ kind: 'leave', stageId: 'stage-christy' });
  });

  it('narrows a cohort’s list to its week, and a job row’s to its job', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    const cohorts = await screen.findByRole('region', { name: 'Weekly cohorts' });
    await user.click(within(cohorts).getByRole('button', { name: /^40, came in, week of 31 Aug 2026/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Came in · Week of 31 Aug 2026' });
    expect(dialog).toHaveAccessibleDescription(/week of 31 Aug 2026, all jobs/);
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ from: '2026-08-31', to: '2026-09-06', job: null });
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /^115, came in, Academic Counsellor/ }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleDescription(/last 12 weeks, Academic Counsellor/);
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ from: '2026-06-29', to: '2026-09-16', job: 'job-ac' });
  });

  it('names the oldest week as a week, though it starts on the same Monday as the page’s weeks', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const summary = impactSummary();
    summary.cohorts.push({ weekStart: '2026-06-29', ageDays: 79, maturing: false, cameIn: 33, shares: { connected: 0.7, scored: 0.6 } });
    fetchSummary.mockResolvedValue(summary);
    renderPage();
    const cohorts = await screen.findByRole('region', { name: 'Weekly cohorts' });
    await user.click(within(cohorts).getByRole('button', { name: /^33, came in, week of 29 Jun 2026/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Came in · Week of 29 Jun 2026' });
    expect(dialog).toHaveAccessibleDescription(/week of 29 Jun 2026, all jobs/);
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ from: '2026-06-29', to: '2026-07-05', job: null });
  });

  it('never asks for a day past today: the current week’s list ends on today', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const summary = impactSummary();
    summary.cohorts = summary.cohorts.map((cohort) => (cohort.weekStart === '2026-09-14' ? { ...cohort, cameIn: 9 } : cohort));
    fetchSummary.mockResolvedValue(summary);
    renderPage();
    const cohorts = await screen.findByRole('region', { name: 'Weekly cohorts' });
    await user.click(within(cohorts).getByRole('button', { name: /^9, came in, week of 14 Sep 2026/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Came in · Week of 14 Sep 2026' });
    expect(dialog).toHaveAccessibleDescription(/week of 14 Sep 2026, all jobs/);
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ from: '2026-09-14', to: '2026-09-16', job: null });
  });

  it('opens a list again on its first page, with none of the rows it showed before', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const later = candidatesPage({ total: 120, page: 2 });
    later.rows = later.rows.map((row, index) => ({ ...row, candidateId: `cand-p2-${index}`, name: `Second Page ${index + 1}` }));
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 120 })).mockResolvedValueOnce(later);
    renderPage();
    const count = await screen.findByRole('button', { name: '415, reached Came in. Show these applications' });
    await user.click(count);
    const first = await screen.findByRole('dialog');
    await waitFor(() => expect(within(first).getByRole('status')).toHaveTextContent('Showing 1–2 of 120 applications'));
    await user.click(within(first).getByRole('button', { name: 'Next page' }));
    expect(await within(first).findByRole('link', { name: 'Second Page 1' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    let release: (value: unknown) => void = () => {};
    fetchCandidates.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await user.click(count);
    const again = await screen.findByRole('dialog');
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ page: 1 });
    expect(within(again).getByText('Loading applications…')).toBeInTheDocument();
    expect(within(again).queryByRole('link')).toBeNull();
    await act(async () => release(candidatesPage({ total: 120 })));
    await waitFor(() => expect(within(again).getByRole('status')).toHaveTextContent('Showing 1–2 of 120 applications'));
    expect(within(again).getByRole('link', { name: 'Ishita Varma' })).toBeInTheDocument();
  });

  it('lists an application that never became a candidate, saying so, with nothing to open', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const page = candidatesPage({ total: 3 });
    page.rows.push({ ...page.rows[0]!, candidateId: null, name: null, verdict: null, score: null, currentStageTitle: 'Hello Christy', currentMilestone: 'christy' });
    fetchCandidates.mockResolvedValueOnce(page);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '415, reached Came in. Show these applications' }));
    const dialog = await screen.findByRole('dialog');
    const stuck = (await within(dialog).findByText('Not a candidate yet')).closest('tr')!;
    expect(stuck).toHaveTextContent('Resume not processed');
    expect(within(stuck).queryByRole('link')).toBeNull();
    expect(within(dialog).getAllByRole('link')).toHaveLength(2);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('opens a count from the headline strip too', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Headline counts' });
    await user.click(within(strip).getByRole('button', { name: 'Hired: 6. Show these applications' }));
    expect(await screen.findByRole('dialog', { name: 'Reached: Hired' })).toBeInTheDocument();
  });

  it('pages through a long list, keeping the rows on screen while the next page loads', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 120 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '415, reached Came in. Show these applications' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/of/, { selector: '[role="status"]' })).toHaveTextContent('Showing 1–2 of 120 applications');
    let release: (value: unknown) => void = () => {};
    fetchCandidates.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await user.click(within(dialog).getByRole('button', { name: 'Next page' }));
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2, pageSize: 50 });
    expect(within(dialog).getByRole('link', { name: 'Ishita Varma' })).toBeInTheDocument();
    await act(async () => release(candidatesPage({ total: 120, page: 2 })));
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Showing 51–52 of 120 applications'));
  });

  it('says when the list fails, and reads it again on Retry', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    fetchCandidates.mockRejectedValueOnce(new ApiError('internal_error', 500, 'internal_error'));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '6, reached Hired. Show these applications' }));
    const dialog = await screen.findByRole('dialog');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The applications couldn’t load.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('link', { name: 'Rahul Menon' })).toBeInTheDocument();
  });

  it('says when a list comes back empty', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 0, rows: [] }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '6, reached Hired. Show these applications' }));
    expect(await screen.findByText('No applications to show')).toBeInTheDocument();
  });

  it('takes a name to the candidate’s Phone screening tab', async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '6, reached Hired. Show these applications' }));
    await user.click(await screen.findByRole('link', { name: 'Ishita Varma' }));
    expect(await screen.findByText('Candidate page')).toBeInTheDocument();
    expect(location).toBe('/candidates/cand-1?tab=phone');
  });

  it('makes no button of a zero, which has nobody behind it', async () => {
    renderPage();
    const pipeline = await screen.findByRole('region', { name: 'The pipeline' });
    const scored = within(pipeline).getAllByRole('row').find((row) => row.getAttribute('data-step') === 'scored')!;
    expect(within(scored).queryByRole('button', { name: /dropped at Scored/ })).toBeNull();
    expect(within(scored).getByText('0')).toBeInTheDocument();
  });
});

// D-M031-5: the list follows the candidate page's own rule. What the viewer cannot open is never
// listed; the API counts it in `hidden`, and the panel says so in one plain line.
describe('applications the viewer cannot open', () => {
  async function openList(name: string) {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await user.click(await screen.findByRole('button', { name }));
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('lists the ones the viewer can open, then says in one line how many more there are', async () => {
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 2, hidden: 4 }));
    const { dialog } = await openList('6, reached Hired. Show these applications');
    const line = await within(dialog).findByText('4 more belong to other recruiters and are not listed.');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Showing 1–2 of 2 applications');
    expect(within(dialog).getAllByRole('link')).toHaveLength(2);
    // Plain words in the panel's footer, read after the range: nothing hides them from a screen reader.
    expect(line.tagName).toBe('P');
    expect(line.closest('[aria-hidden="true"]')).toBeNull();
    expect(line).not.toHaveClass('sr-only');
    expect(line).toBeVisible();
    expect(within(dialog).getByRole('navigation').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(dialog).toHaveNoViolations();
  });

  it('says one in the singular', async () => {
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 2, hidden: 1 }));
    const { dialog } = await openList('3, dropped at Came in. Show these applications');
    expect(await within(dialog).findByText('1 more belongs to another recruiter and is not listed.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/belong to other recruiters/)).toBeNull();
  });

  it('shows only that line when every application behind the figure is someone else’s, never that nobody is there', async () => {
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 0, hidden: 6, rows: [] }));
    const { dialog } = await openList('6, reached Hired. Show these applications');
    const line = await within(dialog).findByText('6 more belong to other recruiters and are not listed.');
    expect(line.closest('[aria-hidden="true"]')).toBeNull();
    expect(within(dialog).queryByText('No applications to show')).toBeNull();
    expect(within(dialog).queryByText(/figures may have moved/)).toBeNull();
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(within(dialog).queryByRole('navigation')).toBeNull();
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // No name is listed, so the panel's description promises none.
    expect(within(dialog).queryByText(/Each name opens/)).toBeNull();
    await expect(dialog).toHaveNoViolations();
  });

  it('pages on the applications it lists, never on the ones it leaves out', async () => {
    fetchCandidates.mockResolvedValueOnce(candidatesPage({ total: 50, hidden: 190 }));
    const { dialog } = await openList('240, reached Christy connected. Show these applications');
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Showing 1–2 of 50 applications'));
    // 50 fit on one page. Counting the 190 left out would offer five.
    expect(within(dialog).getByText('1 / 1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(within(dialog).getByText('190 more belong to other recruiters and are not listed.')).toBeInTheDocument();
  });

  it('pages a longer list by its own total, and keeps the line on every page', async () => {
    fetchCandidates
      .mockResolvedValueOnce(candidatesPage({ total: 120, hidden: 120 }))
      .mockResolvedValueOnce(candidatesPage({ total: 120, hidden: 120, page: 2 }));
    const { user, dialog } = await openList('240, reached Christy connected. Show these applications');
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Showing 1–2 of 120 applications'));
    expect(within(dialog).getByText('1 / 3')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next page' }));
    expect(fetchCandidates.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2, pageSize: 50 });
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Showing 51–52 of 120 applications'));
    expect(within(dialog).getByText('2 / 3')).toBeInTheDocument();
    expect(within(dialog).getByText('120 more belong to other recruiters and are not listed.')).toBeInTheDocument();
  });

  it('says nothing about other recruiters when the viewer can open every application', async () => {
    const { dialog } = await openList('6, reached Hired. Show these applications');
    expect(await within(dialog).findByRole('link', { name: 'Ishita Varma' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/recruiter/)).toBeNull();
  });
});
