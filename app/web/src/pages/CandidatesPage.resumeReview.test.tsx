/**
 * Candidates list — the PII-minimal imported shell, and the sanitized
 * resume-review signal.
 *
 * The defect this covers: an Ashby import creates a candidate row whose
 * name/email/phone are all null and whose status is `queued`. It used to
 * render as an all-but-blank "Unnamed" link with nothing anywhere saying what
 * had happened to its resume — visible, but unreadable.
 *
 * These tests pin BOTH halves: the shell must be legible and accessible with
 * one exact neutral phrase, and the resume-review badge must say how far the
 * resume got while disclosing nothing about why it stopped.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidatesPage } from './CandidatesPage';
import { mockCandidate, mockRole } from '../test/helpers';
import { EMPTY_FUNNEL_TOTALS } from '../test/funnel';

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
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

/** Exactly what the API returns for a shell created at import time. */
const SHELL = {
  id: 'c-shell',
  name: null,
  email: null,
  phone_e164: null,
  phone_valid: false,
  skills: [] as string[],
  experience_years: null,
  status: 'queued',
  role_id: 'role-1',
  created_at: '2026-02-01T00:00:00Z',
  latest_recommendation: null,
  latest_score: null,
  resume_review: 'needs_review',
};

const PROCESSING = {
  ...SHELL,
  id: 'c-processing',
  created_at: '2026-02-02T00:00:00Z',
  resume_review: 'processing',
};
const CANCELLED = {
  ...SHELL,
  id: 'c-cancelled',
  created_at: '2026-02-03T00:00:00Z',
  resume_review: 'cancelled',
};
/** A parsed Ashby candidate — resume is done, so the badge stays quiet. */
const READY = {
  ...mockCandidate,
  id: 'c-ready',
  name: 'Ready Rita',
  email: 'rita@example.com',
  resume_review: 'ready',
};
/** A normal non-Ashby candidate — no resume-review signal at all. */
const PLAIN = { ...mockCandidate, resume_review: null };

const ALL = [SHELL, PROCESSING, CANCELLED, READY, PLAIN];

let container: HTMLElement;

function renderPage(entry = '/candidates') {
  const result = render(
    <MemoryRouter initialEntries={[entry]}>
      <CandidatesPage />
    </MemoryRouter>,
  );
  container = result.container;
  return result;
}

/**
 * Rows are located by their candidate href, not by their link text: three
 * unparsed shells legitimately share the SAME neutral title, because they are
 * genuinely indistinguishable to a recruiter until their resumes parse.
 */
function row(candidateId: string) {
  const link = container.querySelector(`a[href="/candidates/${candidateId}"]`);
  expect(link, `no row for ${candidateId}`).not.toBeNull();
  return link!.closest('tr') as HTMLElement;
}

/** Resolve once the list has rendered (rather than once a name appears). */
function findTable() {
  return screen.findByRole('table', { name: /candidates in your pipeline/i });
}

describe('CandidatesPage — imported shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(ALL);
    // The per-role pipeline chart fans out one funnel call per role on mount;
    // zeroed totals render nothing, so nothing else here moves.
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('renders the shell as a keyboard-reachable link with the exact neutral copy', async () => {
    renderPage();
    await findTable();
    const link = within(row('c-shell')).getByRole('link');
    expect(link).toHaveAccessibleName('Awaiting resume details');
    expect(link).toHaveAttribute('href', '/candidates/c-shell');
  });

  it('keeps the shell status as queued and badges its resume review', async () => {
    renderPage();
    await findTable();
    const cells = within(row('c-shell'));
    expect(cells.getByText('Queued')).toBeInTheDocument();
    expect(cells.getByText('Resume needs review')).toBeInTheDocument();
    expect(cells.getByText('Queued for screening')).toBeInTheDocument();
  });

  it('fabricates no identity and leaks no null/id/code/raw detail in the shell row', async () => {
    renderPage();
    await findTable();
    const text = row('c-shell').textContent ?? '';
    expect(text).not.toMatch(/null|undefined|NaN/);
    expect(text).not.toMatch(/unnamed|unknown candidate/i);
    expect(text).not.toContain('c-shell');
    expect(text).not.toContain('role-1');
    expect(text).not.toMatch(/failed_review|fetch_http_error|scan|malware|ashby|application link/i);
    // The one non-identity fact is the resume-review state, and only that.
    expect(text).toContain('Resume needs review');
  });

  it('offers no retry or recovery affordance on the shell row', async () => {
    renderPage();
    await findTable();
    const cells = within(row('c-shell'));
    expect(cells.queryByRole('button', { name: /retry|recover|reprocess|re-?parse/i })).toBeNull();
  });

  it('leaves a normal candidate completely unaffected and unbadged', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const plain = within(row('candidate-1'));
    expect(plain.getByText('New')).toBeInTheDocument();
    expect(plain.queryByText(/^Resume /)).toBeNull();
  });

  it('stays quiet for a ready resume', async () => {
    renderPage();
    await screen.findByText('Ready Rita');
    expect(within(row('c-ready')).queryByText(/^Resume /)).toBeNull();
  });

  it('labels processing and cancelled with their own words', async () => {
    renderPage();
    const table = await findTable();
    expect(within(table).getByText('Resume processing')).toBeInTheDocument();
    expect(within(table).getByText('Resume cancelled')).toBeInTheDocument();
  });

  it('has no axe violations with shells in the list', async () => {
    const { container: root } = renderPage();
    await findTable();
    await expect(root).toHaveNoViolations();
  });
});

describe('CandidatesPage — resume-review facet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(ALL);
  });

  it('applies a resume deep link and shows a removable chip', async () => {
    renderPage('/candidates?resume=needs_review');
    await findTable();
    expect(row('c-shell')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(screen.queryByText('Ready Rita')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Resume needs review' })).toBeInTheDocument();
  });

  it('toggles the facet and clears it without touching the status filters', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const group = screen.getByRole('group', { name: 'Filter by resume review' });
    const toggle = within(group).getByRole('button', { name: /Resume cancelled/ });
    // Counts are derived from the one loaded page — no second request.
    expect(toggle).toHaveTextContent('1');
    fireEvent.click(toggle);
    expect(await screen.findByText('1 of 5')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);
  });

  it('combines with the status filter rather than replacing it', async () => {
    renderPage('/candidates?status=queued&resume=processing');
    const table = await findTable();
    expect(within(table).getByText('Resume processing')).toBeInTheDocument();
    expect(within(table).queryByText('Resume needs review')).toBeNull();
    expect(screen.getByText('1 of 5')).toBeInTheDocument();
    // Both chips survive together.
    expect(screen.getByRole('button', { name: 'Remove filter Queued' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Resume processing' })).toBeInTheDocument();
  });

  it('leaves the status vocabulary and its counts unchanged', async () => {
    renderPage();
    await screen.findByText('Jane Doe');
    const statuses = screen.getByRole('group', { name: 'Filter by status' });
    // Three shells are queued; the status counts are computed from status only.
    expect(within(statuses).getByRole('button', { name: /^Queued/ })).toHaveTextContent('3');
    expect(within(statuses).getByRole('button', { name: /^New/ })).toHaveTextContent('2');
    // No resume-review value has become a status.
    for (const bad of ['Resume processing', 'Resume needs review', 'Resume cancelled']) {
      expect(within(statuses).queryByRole('button', { name: bad })).toBeNull();
    }
  });

  it('hides the facet entirely when no loaded candidate carries the signal', async () => {
    mockApi.listCandidates.mockResolvedValue([PLAIN]);
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.queryByRole('group', { name: 'Filter by resume review' })).toBeNull();
    // The pre-existing filter dimensions are untouched.
    expect(screen.getByRole('group', { name: 'Filter by status' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Filter by recommendation' })).toBeInTheDocument();
  });

  it('keeps the facet reachable from a deep link even when nothing matches', async () => {
    mockApi.listCandidates.mockResolvedValue([PLAIN]);
    renderPage('/candidates?resume=cancelled');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Filter by resume review' });
    expect(within(group).getByRole('button', { name: /Resume cancelled/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('issues exactly one list request for the page', async () => {
    renderPage('/candidates?resume=needs_review,processing');
    await findTable();
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);
  });
});

/**
 * M017 (Addendum A): the intake type. An Ashby applicant with no resume is
 * screened from the name and number on the Ashby application ("Phone
 * parsing"); everyone else came in by a resume ("Resume parsing"). Recruiters
 * see which on every row and can filter by it. The ALL fixtures above carry
 * no `intake_type` — an older API — and must render exactly as they did.
 */
const PHONE = {
  ...SHELL,
  id: 'c-phone',
  name: 'Test Person',
  created_at: '2026-02-04T00:00:00Z',
  resume_review: null,
  intake_type: 'phone_parsing',
};
const RESUMED = {
  ...READY,
  id: 'c-resumed',
  name: 'Test Resumed',
  email: 'resumed@example.com',
  created_at: '2026-02-05T00:00:00Z',
  intake_type: 'resume_parsing',
};
const WITH_INTAKE = [...ALL, PHONE, RESUMED];

describe('CandidatesPage — intake type (M017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listCandidates.mockResolvedValue(WITH_INTAKE);
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: EMPTY_FUNNEL_TOTALS });
  });

  it('shows a phone-parsing row by its name, "Phone parsing", and no resume badge', async () => {
    renderPage();
    await findTable();
    const cells = within(row('c-phone'));
    expect(cells.getByRole('link')).toHaveAccessibleName('Test Person');
    expect(cells.getByText('Queued')).toBeInTheDocument();
    expect(cells.getByText('Phone parsing')).toBeInTheDocument();
    expect(cells.queryByText(/^Resume /)).toBeNull();
    expect(row('c-phone').textContent ?? '').not.toMatch(/null|undefined|phone_parsing/);
  });

  it('never badges a resume on a phone-parsing row, whatever resume_review says', async () => {
    mockApi.listCandidates.mockResolvedValue([{ ...PHONE, resume_review: 'processing' }]);
    renderPage();
    await findTable();
    expect(within(row('c-phone')).getByText('Phone parsing')).toBeInTheDocument();
    expect(within(row('c-phone')).queryByText('Resume processing')).toBeNull();
  });

  it('stacks status, intake, then resume review in a resume-parsing row', async () => {
    mockApi.listCandidates.mockResolvedValue([{ ...PROCESSING, intake_type: 'resume_parsing' }]);
    renderPage();
    await findTable();
    const text = row('c-processing').textContent ?? '';
    expect(text.indexOf('Queued')).toBeGreaterThan(-1);
    expect(text.indexOf('Queued')).toBeLessThan(text.indexOf('Resume parsing'));
    expect(text.indexOf('Resume parsing')).toBeLessThan(text.indexOf('Resume processing'));
  });

  it('leaves a legacy row (no intake_type) exactly as it was', async () => {
    renderPage();
    await findTable();
    for (const id of ['c-shell', 'c-ready', 'candidate-1']) {
      expect(within(row(id)).queryByText(/parsing$/)).toBeNull();
    }
    expect(within(row('c-shell')).getByText('Resume needs review')).toBeInTheDocument();
    expect(within(row('c-resumed')).getByText('Resume parsing')).toBeInTheDocument();
  });

  it('offers an Intake facet with per-value counts from the one loaded page', async () => {
    renderPage();
    await findTable();
    const group = screen.getByRole('group', { name: 'Filter by intake' });
    expect(group).toHaveTextContent(/^Intake:/);
    const resume = within(group).getByRole('button', { name: /^Resume parsing/ });
    const phone = within(group).getByRole('button', { name: /^Phone parsing/ });
    expect(resume).toHaveTextContent('1');
    expect(phone).toHaveTextContent('1');
    expect(resume).toHaveAttribute('aria-pressed', 'false');
    expect(phone).toHaveAttribute('aria-pressed', 'false');
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);
  });

  it('keeps the Resume facet counts and the status counts; a phone row never counts as a resume', async () => {
    renderPage();
    await findTable();
    const resumeGroup = screen.getByRole('group', { name: 'Filter by resume review' });
    expect(within(resumeGroup).getByRole('button', { name: /Resume processing/ })).toHaveTextContent('1');
    expect(within(resumeGroup).getByRole('button', { name: /Resume needs review/ })).toHaveTextContent('1');
    expect(within(resumeGroup).getByRole('button', { name: /Resume cancelled/ })).toHaveTextContent('1');
    // The phone row is a queued candidate like any other: three shells + it.
    const statuses = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(statuses).getByRole('button', { name: /^Queued/ })).toHaveTextContent('4');
    // No intake value has become a status.
    expect(within(statuses).queryByRole('button', { name: /parsing/ })).toBeNull();
  });

  it('toggles the facet, shows an "Intake:" chip, and clears with Clear all', async () => {
    renderPage();
    await findTable();
    const group = screen.getByRole('group', { name: 'Filter by intake' });
    fireEvent.click(within(group).getByRole('button', { name: /^Phone parsing/ }));
    expect(await screen.findByText('1 of 7')).toBeInTheDocument();
    expect(row('c-phone')).toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(screen.queryByText('Test Resumed')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Filter by intake' })).getByRole('button', {
        name: /^Phone parsing/,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Remove filter Intake: Phone parsing' }),
    ).toBeInTheDocument();
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove filter Intake/ })).toBeNull();
    expect(mockApi.listCandidates).toHaveBeenCalledTimes(1);
  });

  it('applies an intake deep link, excluding every row without an intake type', async () => {
    renderPage('/candidates?intake=resume_parsing,phone_parsing');
    await findTable();
    // Two of seven: the five legacy rows carry no intake type.
    expect(screen.getByText('2 of 7')).toBeInTheDocument();
    expect(row('c-phone')).toBeInTheDocument();
    expect(row('c-resumed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Intake: Resume parsing' })).toBeInTheDocument();
    // Removing one chip keeps the other.
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Intake: Resume parsing' }));
    expect(await screen.findByText('1 of 7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Intake: Phone parsing' })).toBeInTheDocument();
  });

  it('combines with the resume facet rather than replacing it', async () => {
    renderPage('/candidates?intake=phone_parsing&resume=needs_review');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Intake: Phone parsing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Resume needs review' })).toBeInTheDocument();
  });

  it('hides the facet when no loaded row has an intake type', async () => {
    mockApi.listCandidates.mockResolvedValue(ALL);
    renderPage();
    await findTable();
    expect(screen.queryByRole('group', { name: 'Filter by intake' })).toBeNull();
    // The resume facet it sits beside is unaffected.
    expect(screen.getByRole('group', { name: 'Filter by resume review' })).toBeInTheDocument();
  });

  it('keeps the facet reachable from a deep link even when nothing carries the signal', async () => {
    mockApi.listCandidates.mockResolvedValue([PLAIN]);
    renderPage('/candidates?intake=phone_parsing');
    expect(await screen.findByText('No candidates match these filters')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Filter by intake' });
    expect(within(group).getByRole('button', { name: /^Phone parsing/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('drops an unknown intake value from a deep link', async () => {
    renderPage('/candidates?intake=bogus');
    await findTable();
    expect(screen.queryByText(/ of 7$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove filter Intake/ })).toBeNull();
    expect(row('c-phone')).toBeInTheDocument();
    expect(row('candidate-1')).toBeInTheDocument();
  });

  it('has no axe violations with the facet and phone-parsing rows', async () => {
    const { container: root } = renderPage('/candidates?intake=phone_parsing');
    await findTable();
    await expect(root).toHaveNoViolations();
  });
});
