/**
 * The R1 queue: what it opens on, what a row says, and how the address, the search and the pages move.
 * What each view holds is the API's rule (r1-queue-route.test.ts), so here the rows are as answered.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { R1ListedAttempt, R1QueueResponse, R1QueueRound } from '../lib/r1-types';
import { R1InterviewsPage } from './R1InterviewsPage';

const mockApi = vi.hoisted(() => ({ listR1Queue: vi.fn() }));

vi.mock('../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status = 0;
  },
}));

const attempt = (over: Partial<R1ListedAttempt> = {}): R1ListedAttempt => ({
  session_id: 'session-1', attempt_number: 1, counted: true, outcome: 'complete', in_progress: false, session_status: 'completed', started_at: null,
  ended_at: '2026-11-02T10:30:00.000Z', consent_withdrawn: false, recording: { state: 'ready' }, ...over,
});

const round = (over: Partial<R1QueueRound> = {}): R1QueueRound => ({
  id: 'round-1', candidate_id: 'cand-1', candidate_name: 'Ava Example', status: 'completed', expires_at: '2099-01-01T00:00:00.000Z',
  attempts_allowed: 2, attempts_counted: 1, recommendation: 'hold', overall: 58, status_write: 'hold_flag', pending_reject_until: null,
  scores_withheld: false, is_staff_dry_run: false, created_at: '2026-11-01T10:00:00.000Z', attempts: [attempt()], ...over,
});

const answer = (over: Partial<R1QueueResponse> = {}): R1QueueResponse => ({
  view: 'to-review', sort: 'oldest', page: 1, page_size: 25, total: 1, rounds: [round()], r1_deployed: true, ...over,
});

function Address() {
  const { pathname, search, state } = useLocation();
  return (
    <>
      <output data-testid="address">{`${pathname}${search}`}</output>
      <output data-testid="state">{JSON.stringify(state)}</output>
    </>
  );
}

function open(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/interviews${search}`]}>
      <Routes>
        <Route path="/interviews" element={<R1InterviewsPage />} />
        <Route path="/interviews/:roundId" element={<p>The review</p>} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';
const lastAsked = () => mockApi.listR1Queue.mock.calls.at(-1)?.[0];
const handedOver = () => JSON.parse(screen.getByTestId('state').textContent ?? 'null');

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listR1Queue.mockResolvedValue(answer());
});

describe('opening the queue', () => {
  it('asks for To review, oldest first, and says so', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'R1 interviews' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Ava Example' })).toBeInTheDocument();
    expect(mockApi.listR1Queue).toHaveBeenCalledTimes(1);
    expect(lastAsked()).toEqual({ view: 'to-review', sort: 'oldest', page: 1, search: '', includeDryRuns: false });
    expect(screen.getByRole('button', { name: 'To review' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Oldest first' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives the figure with what it counts', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ total: 12, rounds: [round()] }));
    open();
    await screen.findByRole('link', { name: 'Ava Example' });
    expect(screen.getByTestId('queue-summary')).toHaveTextContent('12 interviews to review, oldest first');
  });

  it('opens the view, order and page the address names', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ view: 'all', sort: 'oldest', page: 2, total: 40 }));
    open('?view=all&sort=oldest&page=2');
    await screen.findByRole('link', { name: 'Ava Example' });
    expect(lastAsked()).toEqual({ view: 'all', sort: 'oldest', page: 2, search: '', includeDryRuns: false });
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('holds its place while the answer is out, then shows the rows', async () => {
    let settle: (value: R1QueueResponse) => void = () => undefined;
    mockApi.listR1Queue.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    open();
    expect(screen.getByRole('status', { name: 'Loading R1 interviews' })).toBeInTheDocument();
    settle(answer());
    expect(await screen.findByRole('link', { name: 'Ava Example' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading R1 interviews' })).toBeNull();
  });
});

describe('a row', () => {
  it('links to the review and names the result as the AI one, in words', async () => {
    open();
    const link = await screen.findByRole('link', { name: 'Ava Example' });
    expect(link).toHaveAttribute('href', '/interviews/round-1');
    expect(screen.getByRole('columnheader', { name: 'AI recommendation' })).toBeInTheDocument();
    const row = link.closest('tr')!;
    expect(row).toHaveTextContent('Borderline');
    expect(row).toHaveTextContent('58');
    expect(row).toHaveTextContent('Completed');
    expect(row).toHaveTextContent('1 of 2 attempts used');
    expect(row).toHaveTextContent('Ready');
    expect(row.querySelector('[data-verdict-mark="half"]')).not.toBeNull();
  });

  it('opens the review', async () => {
    open();
    await userEvent.click(await screen.findByRole('link', { name: 'Ava Example' }));
    expect(await screen.findByText('The review')).toBeInTheDocument();
    expect(address()).toBe('/interviews/round-1');
  });

  it('says a result is withheld, and prints no score, while an appeal blocks decision use', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ rounds: [round({ recommendation: null, overall: null, status_write: null, scores_withheld: true })] }));
    open();
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent('Scorecards are suppressed while an appeal is under review.');
    expect(row).not.toHaveTextContent('Not scored');
  });

  it('marks a staff dry run', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ rounds: [round({ is_staff_dry_run: true })] }));
    open('?dry_runs=include');
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent('Staff dry run');
  });

  it('says a rejection is pending', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ rounds: [round({ recommendation: 'reject', pending_reject_until: '2026-11-03T10:00:00.000Z', status_write: 'pending_reject' })] }));
    open();
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent(/Rejection pending until/);
  });

  it('says nothing is pending once the rejection has landed, though the sweep leaves the date on the row', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ view: 'reviewed', sort: 'newest', rounds: [round({ recommendation: 'reject', pending_reject_until: '2026-10-08T10:00:00.000Z', status_write: 'rejected' })] }));
    open('?view=reviewed');
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).not.toHaveTextContent(/Rejection pending/);
  });

  it('reads a round nobody is in as an open link, not as an interview running', async () => {
    const idle = round({ status: 'in_progress', recommendation: null, overall: null, status_write: null, attempts: [attempt({ counted: false })] });
    mockApi.listR1Queue.mockResolvedValue(answer({ view: 'in-progress', sort: 'newest', rounds: [idle] }));
    open('?view=in-progress');
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent('Link open');
  });

  it('reads a lapsed link as expired, not as one to wait on', async () => {
    const lapsed = round({ status: 'in_progress', expires_at: '2026-11-04T10:00:00.000Z', recommendation: null, overall: null, status_write: null, attempts: [attempt({ counted: false })] });
    mockApi.listR1Queue.mockResolvedValue(answer({ view: 'all', sort: 'newest', rounds: [lapsed] }));
    open('?view=all');
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent('Expired');
    expect(row).not.toHaveTextContent('Link open');
  });

  it('says a round that will never be scored is not scored, not that scoring is on its way', async () => {
    const withdrawn = attempt({ consent_withdrawn: true, ended_at: new Date().toISOString(), recording: { state: 'deleted', reason: 'consent_withdrawn' } });
    mockApi.listR1Queue.mockResolvedValue(answer({ rounds: [round({ recommendation: null, overall: null, status_write: null, attempts: [withdrawn] })] }));
    open();
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent('Not scored');
    expect(row).not.toHaveTextContent('Not scored yet');
  });

  it('names a recording that exists over a retake that left none, and has no chip for a link nobody used', async () => {
    const retake = round({ attempts: [attempt(), attempt({ session_id: 'session-2', attempt_number: 2, counted: false, recording: { state: 'none' } })] });
    const unused = round({ id: 'round-2', candidate_name: 'Bela Example', status: 'invited', recommendation: null, overall: null, status_write: null, attempts: [] });
    mockApi.listR1Queue.mockResolvedValue(answer({ total: 2, rounds: [retake, unused] }));
    open();
    const row = (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
    expect(row).toHaveTextContent('Ready');
    expect(row).not.toHaveTextContent('No recording');
    expect(screen.getByRole('link', { name: 'Bela Example' }).closest('tr')).not.toHaveTextContent('No recording');
  });
});

describe('a fact reads as it does on the R1 tab and the review', () => {
  const opened = async (rows: R1QueueRound[], search = '') => {
    mockApi.listR1Queue.mockResolvedValue(answer({ total: rows.length, rounds: rows }));
    open(search);
    return (await screen.findByRole('link', { name: 'Ava Example' })).closest('tr')!;
  };
  const NO_FAMILY = /\btext-(?:moving|ready|unresolved|closed)-text\b/;

  it.each([
    ['advance', 'Select', 'ready'],
    ['hold', 'Borderline', 'unresolved'],
    ['reject', 'Reject', 'closed'],
  ] as const)('prints %s in its family: circle, word and figure', async (recommendation, word, family) => {
    const row = await opened([round({ recommendation, overall: 58 })]);
    expect(row.querySelector('[data-verdict-mark]')).toHaveClass(`text-${family}`);
    expect(within(row).getByText(word).parentElement).toHaveClass(`text-${family}-text`);
    expect(within(row).getByText('58')).not.toHaveClass('text-ink-secondary');
  });

  it.each<[string, Partial<R1QueueRound>]>([
    ['Not scored', { status_write: 'human_review' }],
    ['No result', { status: 'invited', attempts: [] }],
    ['Scorecards are suppressed while an appeal is under review.', { scores_withheld: true }],
  ])('leaves "%s" without a family', async (words, over) => {
    const row = await opened([round({ recommendation: null, overall: null, status_write: null, ...over })]);
    const cell = within(row).getByText(words);
    expect(cell).toHaveClass('text-ink-secondary');
    expect(cell.className).not.toMatch(NO_FAMILY);
  });

  it('leaves "Not scored" without a family on the row production sends, which keeps the figure the checks refused', async () => {
    const row = await opened([round({ recommendation: null, overall: 42, status_write: 'human_review' })]);
    const cell = within(row).getByText('Not scored');
    expect(cell).toHaveClass('text-ink-secondary');
    expect(cell.className).not.toMatch(NO_FAMILY);
    expect(row.querySelector('[data-verdict-mark]')).toBeNull();
    expect(within(row).queryByText('42')).toBeNull();
  });

  it.each([
    ['invited', [], 'Link sent', 'moving'],
    ['in_progress', [attempt({ counted: false })], 'Link open', 'moving'],
    ['in_progress', [attempt({ in_progress: true, ended_at: null })], 'In progress', 'moving'],
    ['completed', [attempt()], 'Completed', 'ready'],
    ['expired', [], 'Expired', 'closed'],
    ['cancelled', [], 'Cancelled', 'closed'],
  ] as const)('prints a %s round as "%s" in its family, in both layouts', async (status, attempts, word, family) => {
    const row = await opened([round({ status, attempts: [...attempts] })]);
    const printed = within(row).getAllByText(word);
    expect(printed).toHaveLength(2);
    for (const span of printed) expect(span).toHaveClass(`text-${family}-text`);
  });

  it('takes a lapsed link\'s family from the word it prints, not the stored status', async () => {
    const lapsed = round({ status: 'in_progress', expires_at: '2026-11-04T10:00:00.000Z', attempts: [attempt({ counted: false })] });
    const row = await opened([lapsed]);
    for (const span of within(row).getAllByText('Expired')) expect(span).toHaveClass('text-closed-text');
  });

  it.each([
    ['ready', 'Ready', 'bg-ready-soft'],
    ['partial', 'Partial', 'bg-unresolved-soft'],
    ['processing', 'Processing', 'bg-moving-soft'],
    ['deleted', 'Deleted', 'bg-closed-soft'],
  ] as const)('puts a %s recording on its family\'s wash', async (state, word, wash) => {
    const row = await opened([round({ attempts: [attempt({ recording: { state } })] })]);
    expect(within(row).getByRole('cell', { name: `Recording: ${word}` }).querySelector('span')).toHaveClass(wash);
  });

  it('leaves No recording neutral', async () => {
    const row = await opened([round({ attempts: [attempt({ recording: { state: 'none' } })] })]);
    const tag = within(row).getByRole('cell', { name: 'Recording: No recording' }).querySelector('span');
    expect(tag?.className).not.toMatch(/\bbg-(?:moving|ready|unresolved|closed)-soft\b/);
  });

  it.each([
    ['', 'to-review', 'text-success-text'],
    ['?view=in-progress', 'in-progress', 'text-moving-text'],
    ['?view=reviewed', 'reviewed', 'text-closed-text'],
    ['?view=all', 'all', 'text-ink'],
  ] as const)('gives the figure on "%s" its view\'s family', async (search, view, shade) => {
    mockApi.listR1Queue.mockResolvedValue(answer({ view, total: 12 }));
    open(search);
    await screen.findByRole('link', { name: 'Ava Example' });
    expect(within(screen.getByTestId('queue-summary')).getByText('12')).toHaveClass(shade);
  });

  it('keeps a zero in ink, in a view that would colour it', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ total: 0, rounds: [] }));
    open();
    await screen.findByText('Nothing is waiting for review.');
    expect(within(screen.getByTestId('queue-summary')).getByText('0')).toHaveClass('text-ink');
  });
});

describe('changing what is shown', () => {
  it('a view goes into the address, back to its first page, with its own order', async () => {
    open('?page=3');
    await screen.findByRole('link', { name: 'Ava Example' });
    await userEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(lastAsked()).toEqual({ view: 'reviewed', sort: 'newest', page: 1, search: '', includeDryRuns: false }));
    expect(address()).toBe('/interviews?view=reviewed');
  });

  it('a row hands the review the address it was on, for the breadcrumb to come back to', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ view: 'all', sort: 'oldest', page: 2, total: 30 }));
    open('?view=all&sort=oldest&page=2&dry_runs=include');
    await userEvent.click(await screen.findByRole('link', { name: 'Ava Example' }));
    await waitFor(() => expect(address()).toBe('/interviews/round-1'));
    expect(handedOver()).toEqual({ listSearch: '?view=all&sort=oldest&page=2&dry_runs=include' });
  });

  it('a row hands over no name while a search is on', async () => {
    open('?view=all');
    await screen.findByRole('link', { name: 'Ava Example' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a candidate by name' }), 'ava');
    await waitFor(() => expect(lastAsked()).toMatchObject({ search: 'ava' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Ava Example' }));
    await waitFor(() => expect(address()).toBe('/interviews/round-1'));
    expect(handedOver()).toEqual({ listSearch: '?view=all' });
  });

  it('To review leaves the address bare again', async () => {
    open('?view=all');
    await screen.findByRole('link', { name: 'Ava Example' });
    await userEvent.click(screen.getByRole('button', { name: 'To review' }));
    await waitFor(() => expect(address()).toBe('/interviews'));
  });

  it('the order goes into the address', async () => {
    open();
    await screen.findByRole('link', { name: 'Ava Example' });
    await userEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    await waitFor(() => expect(lastAsked()).toMatchObject({ sort: 'newest' }));
    expect(address()).toBe('/interviews?sort=newest');
  });

  it('staff dry runs can be shown, and the row says which they are', async () => {
    open();
    await screen.findByRole('link', { name: 'Ava Example' });
    await userEvent.click(screen.getByRole('switch', { name: 'Show staff dry runs' }));
    await waitFor(() => expect(lastAsked()).toMatchObject({ includeDryRuns: true }));
    expect(address()).toBe('/interviews?dry_runs=include');
  });

  it('never shows the last view\'s rows under the new view', async () => {
    open();
    await screen.findByRole('link', { name: 'Ava Example' });
    mockApi.listR1Queue.mockReturnValue(new Promise(() => undefined));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Ava Example' })).toBeNull());
    expect(screen.getByRole('status', { name: 'Loading R1 interviews' })).toBeInTheDocument();
  });

  it('nor from a later page: the rows are the answer to this read or nothing', async () => {
    mockApi.listR1Queue.mockResolvedValue(answer({ page: 2, total: 30 }));
    open('?page=2');
    await screen.findByRole('link', { name: 'Ava Example' });
    mockApi.listR1Queue.mockReturnValue(new Promise(() => undefined));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Ava Example' })).toBeNull());
  });

  it('a slow answer to an older read does not replace a newer one', async () => {
    let slow: (value: R1QueueResponse) => void = () => undefined;
    mockApi.listR1Queue.mockReturnValueOnce(new Promise((resolve) => { slow = resolve; }));
    mockApi.listR1Queue.mockResolvedValue(answer({ view: 'all', sort: 'newest', rounds: [round({ candidate_name: 'Bela Example' })] }));
    open();
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await screen.findByRole('link', { name: 'Bela Example' });
    slow(answer({ rounds: [round({ candidate_name: 'Slow Answer' })] }));
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: 'Slow Answer' })).toBeNull();
  });
});

describe('the search', () => {
  it('asks the API once the typing stops, from the first page, and keeps the name out of the address', async () => {
    open('?page=2');
    await screen.findByRole('link', { name: 'Ava Example' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a candidate by name' }), 'ava');
    await waitFor(() => expect(lastAsked()).toEqual({ view: 'to-review', sort: 'oldest', page: 1, search: 'ava', includeDryRuns: false }));
    expect(address()).toBe('/interviews');
    expect(address()).not.toContain('ava');
  });

  it('says when nobody matches', async () => {
    open();
    await screen.findByRole('link', { name: 'Ava Example' });
    mockApi.listR1Queue.mockResolvedValue(answer({ total: 0, rounds: [] }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a candidate by name' }), 'zed');
    expect(await screen.findByText('No interview in this view matches that name.')).toBeInTheDocument();
  });
});

describe('the pages', () => {
  const page = (n: number) => answer({ total: 30, page: n, rounds: [round({ candidate_name: `On page ${n}` })] });

  it('moves through the server\'s pages, and the address follows', async () => {
    mockApi.listR1Queue.mockResolvedValueOnce(page(1)).mockResolvedValue(page(2));
    open();
    await screen.findByRole('link', { name: 'On page 1' });
    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 1–25 of 30 interviews');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('link', { name: 'On page 2' });
    expect(lastAsked()).toMatchObject({ page: 2 });
    expect(address()).toBe('/interviews?page=2');
    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 26–30 of 30 interviews');
  });

  it('follows the API to its last page when the address runs past the end', async () => {
    mockApi.listR1Queue.mockResolvedValue(page(2));
    open('?page=9');
    await screen.findByRole('link', { name: 'On page 2' });
    await waitFor(() => expect(address()).toBe('/interviews?page=2'));
  });
});

describe('when there is nothing to show', () => {
  it.each([
    ['', 'Nothing is waiting for review.'],
    ['?view=in-progress', 'No R1 interview is in progress.'],
    ['?view=reviewed', 'No R1 interview has a settled outcome yet.'],
    ['?view=all', 'No R1 interview has been sent yet.'],
  ])('%s says so in its own words', async (search, words) => {
    mockApi.listR1Queue.mockResolvedValue(answer({ total: 0, rounds: [] }));
    open(search);
    expect(await screen.findByText(words)).toBeInTheDocument();
  });
});

describe('when the read fails', () => {
  it('says so in plain words, and Try again reads again', async () => {
    mockApi.listR1Queue.mockRejectedValueOnce(new Error('service_unavailable'));
    open();
    const panel = await screen.findByRole('alert');
    expect(panel).not.toHaveTextContent('service_unavailable');
    await userEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Ava Example' })).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations with rows, and with none', async () => {
    const { container, unmount } = open();
    await screen.findByRole('link', { name: 'Ava Example' });
    await expect(container).toHaveNoViolations();
    unmount();
    mockApi.listR1Queue.mockResolvedValue(answer({ total: 0, rounds: [] }));
    const empty = open();
    await screen.findByText('Nothing is waiting for review.');
    await expect(empty.container).toHaveNoViolations();
  });
});
