import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyMissionControlPage } from './AshbyMissionControlPage';
import { ApiError } from '../api';

/**
 * The page renders router <Link>s (Review screening, the Roles page), so it
 * needs a router context. Routing itself is not under test here.
 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/ashby-mission-control']}>
      <AshbyMissionControlPage />
    </MemoryRouter>,
  );
}

/**
 * What a real browser does to a focused control the moment it is disabled:
 * focus falls to `<body>`. jsdom keeps it on the disabled control — and its
 * `blur()` is a no-op there — so a test that needs the browser's behaviour
 * does it by hand, while the request hangs.
 */
function dropFocusToBody(): void {
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.removeAttribute('tabindex');
  expect(document.body).toHaveFocus();
}

/** A pattern matching text that BEGINS with `text`, taken literally. */
function startsWith(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

/**
 * THE DIALOG'S PICKERS. Each is a `Combobox`: a trigger BUTTON named by its
 * visible label AND its current value ("Ashby job Choose a job", "Role Sales
 * Advisor Agent · Sales v1 hiring"), which opens an inline listbox. An
 * option's accessible name is its label, then its description, then its tag.
 * Option VALUES are never rendered, so a test can only pick by what an admin
 * sees — which is the point.
 */
const JOB_PICKER = /^Ashby job\b/;
const ROLE_PICKER = /^Role\b/;
const jobPicker = () => screen.getByRole('button', { name: JOB_PICKER });
const rolePicker = () => screen.getByRole('button', { name: ROLE_PICKER });

/** Clicks a picker's trigger and returns the listbox it opened. */
async function openPicker(triggerName: RegExp): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: triggerName }));
  return screen.getByRole('listbox');
}

/** Opens a picker and clicks the option with this accessible name. */
async function pick(triggerName: RegExp, optionName: string | RegExp): Promise<void> {
  const list = await openPicker(triggerName);
  await userEvent.click(within(list).getByRole('option', { name: optionName }));
}

/**
 * A MAPPING ROW'S SECONDARY ACTIONS live in its "More" menu (an APG menu
 * button named "More actions for <job>"); the row shows only the one action
 * its state calls for. This opens the `index`th mapping row's menu and
 * chooses an item by its accessible name. Workflow rows have menus too
 * ("More actions for app_…"), so they are left out by name.
 */
const MAPPING_MORE = /^More actions for (?!app_)/;
async function mappingAction(index: number, item: string | RegExp): Promise<void> {
  const triggers = await screen.findAllByRole('button', { name: MAPPING_MORE });
  await userEvent.click(triggers[index]);
  await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: item }));
}

/** The listbox offers EXACTLY these options, in this order, by accessible name. */
function expectOptions(list: HTMLElement, names: Array<string | RegExp>): void {
  const options = within(list).getAllByRole('option');
  expect(options).toHaveLength(names.length);
  options.forEach((option, i) => expect(option).toHaveAccessibleName(names[i]));
}

const { listAshbyMappings, listAshbyWorkflows, listAshbyJobs, pauseAshbyMapping, resumeAshbyMapping, archiveAshbyMapping, cancelAshbyWorkflow, retryAshbyOperation, deliverAshbyManualInvite, discoverAshbyFeedbackForm, previewAshbyScorecardBinding, previewAshbyBacklog, confirmAshbyBacklog, createAshbyMapping, listRoles } = vi.hoisted(() => ({
  listAshbyMappings: vi.fn(),
  archiveAshbyMapping: vi.fn(),
  listAshbyJobs: vi.fn(),
  listAshbyWorkflows: vi.fn(),
  pauseAshbyMapping: vi.fn(),
  resumeAshbyMapping: vi.fn(),
  cancelAshbyWorkflow: vi.fn(),
  retryAshbyOperation: vi.fn(),
  deliverAshbyManualInvite: vi.fn(),
  discoverAshbyFeedbackForm: vi.fn(),
  previewAshbyScorecardBinding: vi.fn(),
  previewAshbyBacklog: vi.fn(),
  confirmAshbyBacklog: vi.fn(),
  createAshbyMapping: vi.fn(),
  listRoles: vi.fn(),
}));

vi.mock('../api', () => ({
  api: { listAshbyMappings, listAshbyWorkflows, listAshbyJobs, pauseAshbyMapping, resumeAshbyMapping, archiveAshbyMapping, cancelAshbyWorkflow, retryAshbyOperation, deliverAshbyManualInvite, discoverAshbyFeedbackForm, previewAshbyScorecardBinding, previewAshbyBacklog, confirmAshbyBacklog, createAshbyMapping, listRoles },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

/**
 * `roleId` as the route now returns it: m1 screens for the active Sales
 * Advisor role, m2 for a role retired since — which a row must still name.
 */
const MAPPINGS = {
  ok: true,
  mappings: [
    { id: 'm1', externalJobId: 'job_1', status: 'enabled', statusReason: null, deliveryMode: 'both', hasAiStage: true, hasTaStage: true, label: null, roleId: '11111111-1111-4111-8111-111111111111', updatedAt: '2026-08-13T00:00:00Z' },
    { id: 'm2', externalJobId: 'job_2', status: 'drift', statusReason: 'stage_id_invalid', deliveryMode: 'manual', hasAiStage: true, hasTaStage: false, label: null, roleId: '22222222-2222-4222-8222-222222222222', updatedAt: '2026-08-13T00:00:00Z' },
  ],
};
const ROLES = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Sales Advisor', agent_name: 'Sales v1 hiring', jd: '', required_skills: [], screening_template: [], is_active: true, created_at: '2026-09-01T00:00:00Z' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Retired Role', jd: '', required_skills: [], screening_template: [], is_active: false, created_at: '2026-09-01T00:00:00Z' },
];

/**
 * The live Ashby job list, shaped like the route's answer: every status,
 * sorted by title. job_1 and job_2 are the jobs MAPPINGS point at, so their
 * titles are what the rows must show in place of the ids.
 */
const JOBS = {
  ok: true,
  truncated: false,
  jobs: [
    // Open AND mapped (m1): in the picker, but disabled.
    { id: 'job_1', title: 'Account Executive', status: 'Open', openedAt: '2026-07-01T12:00:00Z' },
    // Open and unmapped: the one an admin can actually pick.
    { id: 'job_3', title: 'Customer Success Lead', status: 'Open', openedAt: '2026-08-01T12:00:00Z' },
    { id: 'job_4', title: 'Draft Role', status: 'Draft', openedAt: null },
    // Mapped (m2) but CLOSED: still names its row, never offered.
    { id: 'job_2', title: 'Night Shift Advisor', status: 'Closed', openedAt: '2026-05-01T12:00:00Z' },
    { id: 'job_5', title: 'Old Archived Role', status: 'Archived', openedAt: '2025-01-01T12:00:00Z' },
  ],
};

const WORKFLOWS = {
  ok: true,
  workflows: [
    { applicationLinkId: 'l1', externalApplicationId: 'app_1', externalJobId: 'job_1', lifecycle: 'processing', terminalState: null, ingestionState: 'failed_review', operations: [{ id: 'op1', type: 'stage_move', state: 'failed', errorCode: 'transient_x' }], sessionStatus: 'in_progress', updatedAt: '2026-08-13T00:00:00Z' },
  ],
};

describe('AshbyMissionControlPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm3', status: 'paused' });
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    pauseAshbyMapping.mockResolvedValue({ ok: true, status: 'paused' });
    resumeAshbyMapping.mockResolvedValue({ ok: true, status: 'enabled' });
    cancelAshbyWorkflow.mockResolvedValue({ ok: true, cancelled_operations: 1, cancelled_ingestion: 1 });
    retryAshbyOperation.mockResolvedValue({ ok: true });
    previewAshbyBacklog.mockResolvedValue({ ok: true, preview: { runId: 'run_1', mappingId: 'm1', expectedCount: 2, cap: 500, expiresAt: '2099-01-01T00:00:00.000Z', scope: { jobId: 'job_1', stageId: 'stage_ai' } } });
    confirmAshbyBacklog.mockResolvedValue({ ok: true, status: 'ok', queued_count: 1 });
    deliverAshbyManualInvite.mockResolvedValue({
      ok: true,
      invite_id: 'inv_1',
      join_url: 'https://app.example/candidate/join#' + 'a'.repeat(64),
      expires_at: '2026-08-18T00:00:00.000Z',
      ttl_hours: 24,
      revoked_invites: 1,
    });
  });

  it('titles the page "Ashby Live Jobs" (renamed from "Ashby Mission Control")', async () => {
    renderPage();
    // Exact name: the owner retired "Ashby Mission Control" for this page.
    expect(await screen.findByRole('heading', { level: 1, name: 'Ashby Live Jobs' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Ashby Mission Control/ })).toBeNull();
    await screen.findByText('Account Executive');
  });

  it('renders sanitized mappings + workflows (no PII/tokens)', async () => {
    renderPage();
    // The job by NAME — the row never renders the id it is keyed on.
    expect(await screen.findByText('Account Executive')).toBeInTheDocument();
    expect(screen.getByText('app_1')).toBeInTheDocument();
    // Enums are humanised for operators, with explicit words where they
    // matter; the raw value stays one hover away in a `title`.
    expect(screen.getByText('Out of sync')).toHaveAttribute('title', 'drift');
    expect(screen.getByText('Live')).toHaveAttribute('title', 'enabled');
    expect(screen.getByText('Processing')).toHaveAttribute('title', 'processing');
    expect(screen.getByText('Resume import: Needs manual review')).toHaveAttribute('title', 'failed_review');
    expect(screen.getByText(/^Stage move: Failed/)).toHaveTextContent('Stage move: Failed (Transient x)');
    expect(screen.getByText(/^Stage move: Failed/)).toHaveAttribute('title', 'stage_move: failed (transient_x)');
    // A drift reason given as a code is words too.
    expect(screen.getByText('A stage on this job no longer exists in Ashby')).toHaveAttribute('title', 'stage_id_invalid');
    // No machine vocabulary as visible text.
    for (const raw of ['drift', 'enabled', 'failed_review', 'stage_move', 'stage_id_invalid', 'transient_x']) {
      expect(screen.queryByText(raw)).toBeNull();
    }
    // No candidate PII / token / URL leaks in the rendered surface.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\S+@\S+\.\S+/); // no email
    expect(text).not.toMatch(/bearer|presigned|invite_token|resume_url|https?:\/\//i);
  });

  it('pauses an enabled mapping and reloads', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    const pauseButtons = screen.getAllByRole('button', { name: 'Pause' });
    await userEvent.click(pauseButtons[0]); // job_1 is enabled → pausable
    await waitFor(() => expect(pauseAshbyMapping).toHaveBeenCalledWith('m1'));
    expect(listAshbyMappings).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('says a mapping deleted ELSEWHERE in words and refreshes the stale row', async () => {
    // The API really answers 409 `archived` (0109) for a pause/resume of a
    // mapping another tab or admin deleted. The raw code is not copy, and the
    // stale row must go so the same click is not offered again.
    pauseAshbyMapping.mockRejectedValue(new ApiError('archived', 409));
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This mapping was deleted elsewhere. The list has been refreshed.',
    );
    expect(screen.queryByText('archived')).not.toBeInTheDocument();
    expect(listAshbyMappings).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it('asks the API for every mapping (the route maximum), so none reads as unmapped', async () => {
    // Asserted on the real client, not the mock: the page's "already mapped"
    // marking is only as complete as this list.
    const real = await vi.importActual<typeof import('../api')>('../api');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, mappings: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    try {
      await real.api.listAshbyMappings();
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/mission-control/mappings?limit=200');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('cancels a non-terminal workflow — after asking — and retries a failed operation', async () => {
    renderPage();
    await screen.findByText('app_1');
    // Cancel is in the row's menu, never a filled red button on the row.
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'More actions for app_1' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel screening' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this screening?' });
    expect(cancelAshbyWorkflow).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel screening' }));
    await waitFor(() => expect(cancelAshbyWorkflow).toHaveBeenCalledWith('l1', 'manual_stage_cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Named for WHICH retry, starting with the visible word.
    await userEvent.click(screen.getByRole('button', { name: 'Retry stage move' }));
    await waitFor(() => expect(retryAshbyOperation).toHaveBeenCalledWith('op1'));
  });

  it('surfaces a load error', async () => {
    listAshbyMappings.mockRejectedValue({ message: 'boom' });
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows the bounded preview and requires a second explicit admin confirmation', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    await mappingAction(0, 'Preview existing backlog');
    expect(await screen.findByText(/snapshot expires/)).toBeInTheDocument();
    expect(screen.getByText(/future stage entries only/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm and import this snapshot' });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(confirmAshbyBacklog).toHaveBeenCalledWith('m1', 'run_1', 2));
  });

  it('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByText('Account Executive');
    await expect(container).toHaveNoViolations();
  });
});

describe('AshbyMissionControlPage — manual invite delivery (B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm3', status: 'paused' });
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    deliverAshbyManualInvite.mockResolvedValue({
      ok: true,
      invite_id: 'inv_1',
      join_url: 'https://app.example/candidate/join#' + 'a'.repeat(64),
      expires_at: '2026-08-18T00:00:00.000Z',
      ttl_hours: 24,
      revoked_invites: 1,
    });
  });

  it('lets an admin obtain a usable candidate link and shows its expiry', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: /get invite link/i });
    await userEvent.click(button);

    await waitFor(() => expect(deliverAshbyManualInvite).toHaveBeenCalledWith('l1'));
    const field = await screen.findByLabelText(/candidate link/i);
    expect((field as HTMLInputElement).value).toContain('/candidate/join#');
    // Truthful expiry, not a hardcoded string.
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
    expect((field as HTMLInputElement).readOnly).toBe(true);
  });

  it('keeps the token out of the URL, storage and telemetry', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /get invite link/i }));
    const field = (await screen.findByLabelText(/candidate link/i)) as HTMLInputElement;
    const token = field.value.split('#')[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    // Never written to local/session storage …
    for (const call of setItem.mock.calls) {
      expect(String(call[1])).not.toContain(token);
    }
    // … and never placed in the page URL.
    expect(window.location.href).not.toContain(token);
    expect(window.location.search).toBe('');
    setItem.mockRestore();
  });

  it('copies the link on demand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /get invite link/i }));
    await screen.findByLabelText(/candidate link/i);
    await userEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0][0])).toContain('/candidate/join#');
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('shows a truthful error and NO link when the server refuses', async () => {
    deliverAshbyManualInvite.mockResolvedValue({ ok: false, error: 'blocked_terminal' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /get invite link/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked_terminal/i);
    expect(screen.queryByLabelText(/candidate link/i)).toBeNull();
  });

  it('shows a truthful error when the request throws', async () => {
    deliverAshbyManualInvite.mockRejectedValue(new Error('network down'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /get invite link/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByLabelText(/candidate link/i)).toBeNull();
  });

  it('offers reissue once a delivery has succeeded', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{
        ...WORKFLOWS.workflows[0],
        operations: [{ id: 'op2', type: 'invite_delivery', state: 'succeeded', errorCode: null }],
      }],
    });
    renderPage();
    expect(await screen.findByRole('button', { name: /reissue invite link/i })).toBeInTheDocument();
  });

  it('flags a completed screening whose writeback park did not land', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'ready', sessionStatus: 'completed' }],
    });
    renderPage();
    // The completion observer is best-effort by design; this badge is what
    // makes a park that never landed visible instead of log-only — and the
    // list's summary line counts it.
    expect(await screen.findByText('Not queued for write-back')).toBeInTheDocument();
    expect(screen.getByText(/\b1 not queued for write-back\b/)).toBeInTheDocument();
  });

  it('does not flag a screening that parked correctly', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'writeback_pending', sessionStatus: 'completed' }],
    });
    renderPage();
    expect(await screen.findByText('app_1')).toBeInTheDocument();
    expect(screen.queryByText('Not queued for write-back')).toBeNull();
  });

  it('does not flag a terminal application', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'ready', sessionStatus: 'completed', terminalState: 'withdrawn' }],
    });
    renderPage();
    expect(await screen.findByText('app_1')).toBeInTheDocument();
    expect(screen.queryByText('Not queued for write-back')).toBeNull();
  });

  it('offers NO delivery (and no cancel) for a terminal application — its status says why', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], terminalState: 'withdrawn' }],
    });
    renderPage();
    expect(await screen.findByText('Withdrawn')).toHaveAttribute('title', 'withdrawn');
    expect(screen.queryByRole('button', { name: /invite link/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions for app_1' })).toBeNull();
    expect(deliverAshbyManualInvite).not.toHaveBeenCalled();
  });

  it('a completed screening leads with Review screening; the invite moves into More', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'writeback_pending', sessionStatus: 'completed', sessionId: 'sess-1' }],
    });
    renderPage();
    const review = await screen.findByRole('link', { name: 'Review screening' });
    expect(review).toHaveAttribute('href', '/sessions/sess-1');
    expect(screen.queryByRole('button', { name: /invite link/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'More actions for app_1' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Get invite link', 'Cancel screening']);
    await userEvent.click(items[0]);
    await waitFor(() => expect(deliverAshbyManualInvite).toHaveBeenCalledWith('l1'));
  });
});

// ── Read-only feedback-form schema discovery ───────────────────────────────

const FORM_SCHEMA = {
  ok: true,
  empty: false,
  truncated: false,
  forms: [
    {
      formDefinitionId: 'form_1',
      title: 'Hello Christy Feedback',
      interviewId: 'iv_1',
      interviewTitle: 'Hello Christy Screen',
      stageId: 'stage_ai',
      stageTitle: 'AI Screening',
      fieldCount: 2,
      schemaAvailable: true,
      sections: [
        {
          id: null,
          title: 'Overall',
          fields: [
            {
              id: 'field_overall',
              title: 'Overall Recommendation',
              path: 'overall_recommendation',
              type: 'ValueSelect',
              required: true,
              options: [
                { value: '4', label: '4 - Strong Yes' },
                { value: '3', label: '3 - Yes' },
              ],
              optionsTruncated: false,
            },
            {
              id: 'field_summary',
              title: 'Summary',
              path: 'summary',
              type: 'String',
              required: false,
              options: [],
              optionsTruncated: false,
            },
          ],
        },
      ],
    },
  ],
};

describe('AshbyMissionControlPage — feedback-form schema discovery (read-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm3', status: 'paused' });
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    discoverAshbyFeedbackForm.mockResolvedValue(FORM_SCHEMA);
  });

  it('renders ids, labels, types, required flags and the scale for the chosen job', async () => {
    renderPage();
    await mappingAction(0, /discover feedback form/i);

    await waitFor(() => expect(discoverAshbyFeedbackForm).toHaveBeenCalledWith('job_1'));
    expect(discoverAshbyFeedbackForm).toHaveBeenCalledTimes(1);

    expect(await screen.findByText(/form id: form_1/)).toBeInTheDocument();
    expect(screen.getByText('Hello Christy Feedback')).toBeInTheDocument();
    expect(screen.getByText(/stage: AI Screening \(stage_ai\)/)).toBeInTheDocument();
    expect(screen.getByText(/interview: Hello Christy Screen \(iv_1\)/)).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    expect(text).toContain('field_overall');
    expect(text).toContain('Overall Recommendation');
    expect(text).toContain('[overall_recommendation]');
    expect(text).toContain('ValueSelect');
    expect(text).toContain('required');
    expect(text).toContain('4 - Strong Yes | 3 - Yes');
    expect(text).toContain('field_summary');
  });

  it('labels the surface read-only and unverified and never claims a binding', async () => {
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    await screen.findByText(/form id: form_1/);

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/read-only, unverified/i);
    expect(text).toMatch(/no feedback content/i);
    expect(text).toMatch(/nothing is saved or bound/i);
    // A read must never read as a write. The disclaimer legitimately contains
    // "saved"/"bound" in the NEGATIVE, so assert against affirmative claims of
    // a write having happened rather than against the bare words.
    expect(text).not.toMatch(/binding (created|saved|applied)/i);
    expect(text).not.toMatch(/(configuration|mapping|form) (updated|saved|applied)/i);
    expect(text).not.toMatch(/write-?back (enabled|configured|ready)/i);
  });

  it('renders no candidate PII, token, or URL — structure only', async () => {
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    await screen.findByText(/form id: form_1/);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\S+@\S+\.\S+/);
    expect(text).not.toMatch(/bearer|presigned|invite_token|resume_url|https?:\/\//i);
  });

  it('says plainly when the plan names no form at all', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({ ok: true, forms: [], empty: true, truncated: false });
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    expect(await screen.findByText(/no feedback form is named/i)).toBeInTheDocument();
  });

  it('distinguishes "fields not readable here" from "the form has no fields"', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({
      ok: true,
      empty: false,
      truncated: false,
      forms: [{
        formDefinitionId: 'form_ref_only',
        title: null,
        interviewId: null,
        interviewTitle: null,
        stageId: null,
        stageTitle: null,
        sections: [],
        fieldCount: 0,
        schemaAvailable: false,
      }],
    });
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    expect(await screen.findByText(/only\s+its id could be read/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').toMatch(/not a claim that the form has no fields/i);
  });

  it('warns when a safety bound clipped the result', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({ ...FORM_SCHEMA, truncated: true });
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    expect(await screen.findByText(/truncated by a safety bound/i)).toBeInTheDocument();
  });

  it('surfaces a sanitized API error without rendering a schema', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({ ok: false, error: 'probe_unavailable' });
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    expect(await screen.findByText('probe_unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/form id:/)).not.toBeInTheDocument();
  });

  it('surfaces a thrown API error as an alert', async () => {
    discoverAshbyFeedbackForm.mockRejectedValue({ message: 'network down' });
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/form id:/)).not.toBeInTheDocument();
  });

  it('shows the schema for one mapping at a time', async () => {
    renderPage();
    await mappingAction(0, /discover feedback form/i);
    await screen.findByText(/form id: form_1/);
    discoverAshbyFeedbackForm.mockResolvedValue({ ok: true, forms: [], empty: true, truncated: false });
    await mappingAction(1, /discover feedback form/i);
    await waitFor(() => expect(discoverAshbyFeedbackForm).toHaveBeenLastCalledWith('job_2'));
    expect(screen.queryByText(/form id: form_1/)).not.toBeInTheDocument();
  });

  it('has no axe violations with a schema rendered', async () => {
    const { container } = renderPage();
    await mappingAction(0, /discover feedback form/i);
    await screen.findByText(/form id: form_1/);
    await expect(container).toHaveNoViolations();
  });
});

/**
 * Issue #275 — read-only scorecard binding preview. Metrics bind to Score
 * fields BY NAME at write time; this panel shows a recruiter which metric
 * titles are missing on the form before a candidate is ever scored.
 */
const BINDING_PREVIEW = {
  ok: true,
  scoringPath: 'v2_autobind',
  preview: {
    formDefinitionId: 'form_1',
    formTitle: 'Hello Christy Feedback',
    schemaAvailable: true,
    archived: false,
    formMatchesBinding: true,
    fixedFields: [
      { name: 'overall', path: 'overall_recommendation', expectedType: null, status: 'present', actualType: 'ValueSelect' },
      { name: 'summary', path: 'p-summary', expectedType: 'RichText', status: 'present', actualType: 'RichText' },
      { name: 'redFlags', path: 'p-red', expectedType: 'String', status: 'present', actualType: 'String' },
      { name: 'detailedReport', path: 'p-url', expectedType: 'Url', status: 'type_mismatch', actualType: 'String' },
    ],
    metrics: [
      { key: 'profile_relevance', name: 'Profile relevance', status: 'bound', fieldPath: 'p-pr', scale: { min: 1, max: 5 } },
      { key: 'communication', name: 'Communication', status: 'bound', fieldPath: 'p-co', scale: { min: 1, max: 4 } },
      { key: 'stability', name: 'Stability', status: 'no_field', fieldPath: null, scale: null },
      { key: 'night_shift_fit', name: 'Night-shift fit', status: 'ambiguous_title', fieldPath: null, scale: null },
    ],
    unusedScoreFields: [{ fieldId: 'f-old', title: 'English' }],
    ready: false,
  },
};

describe('AshbyMissionControlPage — scorecard binding preview (read-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm3', status: 'paused' });
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    previewAshbyScorecardBinding.mockResolvedValue(BINDING_PREVIEW);
  });

  it('shows each metric, its field and scale, and the exact fix for an unbound one', async () => {
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    await waitFor(() => expect(previewAshbyScorecardBinding).toHaveBeenCalledWith('m1'));
    expect(previewAshbyScorecardBinding).toHaveBeenCalledTimes(1);

    expect(await screen.findByText(/Scorecard binding preview — read-only/)).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Profile relevance');
    expect(text).toContain('[p-pr]');
    expect(text).toContain('1–5 scale');
    expect(text).toContain('[p-co]');
    expect(text).toContain('1–4 scale');
    // The unbound metric names the rule the recruiter must apply on the form.
    expect(text).toMatch(/Stability.*no Score field with this title.*add an optional Score field titled exactly like the metric/);
    expect(text).toMatch(/Night-shift fit.*more than one field carries this title/);
    // Fixed-field drift is reported as fail-closed, never as "will still write".
    expect(text).toMatch(/Detailed report.*type changed to String \(expected Url\).*fail closed/);
    // A broken FIXED field blocks the whole write, so the headline says that
    // rather than "N metrics would be omitted" (which implies a card is sent).
    expect(screen.getByTestId('binding-readiness').textContent)
      .toMatch(/Not ready — 1 fixed field\(s\) no longer match the verified binding\./);
    expect(text).toContain('Score fields no metric claims');
    expect(text).toContain('English');
    // Structure only — no submitted value, address, or secret material.
    const panel = screen.getByText(/Scorecard binding preview — read-only/).closest('div')!;
    const panelText = panel.textContent ?? '';
    expect(panelText).not.toMatch(/\S+@\S+\.\S+/);
    expect(panelText).not.toMatch(/bearer|presigned|invite_token|transcript|recording/i);
  });

  it('reports metric omission only when nothing more serious is wrong', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({
      ...BINDING_PREVIEW,
      preview: {
        ...BINDING_PREVIEW.preview,
        fixedFields: BINDING_PREVIEW.preview.fixedFields.map((f) => ({ ...f, status: 'present', actualType: f.expectedType ?? 'ValueSelect' })),
      },
    });
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    expect((await screen.findByTestId('binding-readiness')).textContent)
      .toMatch(/2 of 4 metric\(s\) would be omitted from the Ashby card\./);
  });

  it('says the binding could not be checked when the read carried no field schema', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({
      ...BINDING_PREVIEW,
      preview: {
        ...BINDING_PREVIEW.preview,
        schemaAvailable: false,
        fixedFields: BINDING_PREVIEW.preview.fixedFields.map((f) => ({ ...f, status: 'missing', actualType: null })),
        metrics: BINDING_PREVIEW.preview.metrics.map((m) => ({ ...m, status: 'no_field', fieldPath: null, scale: null })),
        ready: false,
      },
    });
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    const verdict = (await screen.findByTestId('binding-readiness')).textContent ?? '';
    expect(verdict).toMatch(/Cannot be checked — this read returned no field schema/);
    // It must not claim metrics would be dropped: the worker retries instead.
    expect(verdict).not.toMatch(/would be omitted/);
    // …and a fixed field is "not checked", never reported as deleted.
    const text = document.body.textContent ?? '';
    expect(text).toContain('not checked by this read');
    expect(text).not.toContain('missing on the form');
  });

  it('reports ready when every metric and fixed field binds', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({
      ...BINDING_PREVIEW,
      preview: {
        ...BINDING_PREVIEW.preview,
        fixedFields: BINDING_PREVIEW.preview.fixedFields.map((f) => ({ ...f, status: 'present', actualType: f.expectedType ?? 'ValueSelect' })),
        metrics: BINDING_PREVIEW.preview.metrics.slice(0, 2),
        ready: true,
      },
    });
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    expect((await screen.findByTestId('binding-readiness')).textContent).toMatch(/^Ready — every metric/);
  });

  it('explains the v1 legacy path and a role-less mapping instead of an empty table', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({ ...BINDING_PREVIEW, scoringPath: 'v1_legacy', preview: { ...BINDING_PREVIEW.preview, metrics: [], ready: false } });
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    expect(await screen.findByText(/no active dashboard scorecard/i)).toBeInTheDocument();
    expect(screen.queryByTestId('binding-readiness')).not.toBeInTheDocument();
    expect(screen.queryByText(/Metrics \(bound by name\)/)).not.toBeInTheDocument();

    previewAshbyScorecardBinding.mockResolvedValue({ ...BINDING_PREVIEW, scoringPath: 'no_role', preview: { ...BINDING_PREVIEW.preview, metrics: [], ready: false } });
    await mappingAction(1, /preview scorecard binding/i);
    expect(await screen.findByText(/has no dashboard role/i)).toBeInTheDocument();
  });

  it('flags an archived or mismatched form as fail-closed, even when every metric binds', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({
      ...BINDING_PREVIEW,
      preview: {
        ...BINDING_PREVIEW.preview,
        archived: true,
        formMatchesBinding: false,
        fixedFields: BINDING_PREVIEW.preview.fixedFields.map((f) => ({ ...f, status: 'present', actualType: f.expectedType ?? 'ValueSelect' })),
        metrics: BINDING_PREVIEW.preview.metrics.slice(0, 2),
        ready: false,
      },
    });
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    expect(await screen.findByText(/archived in Ashby.*fail closed/i)).toBeInTheDocument();
    // The headline must name the archived form, not blame a fixed field.
    const verdict = screen.getByTestId('binding-readiness').textContent ?? '';
    expect(verdict).toMatch(/Not ready — the verified form is archived/);
    expect(verdict).not.toMatch(/fixed field/);
  });

  it('renders sanitized copy for each API error code and never the raw code alone', async () => {
    for (const [code, fragment] of [
      ['integration_disabled', /integration is disabled/i],
      ['probe_unavailable', /hiringProcessMetadataRead/],
      ['mapping_not_found', /no longer exists/i],
      ['binding_unverified', /not verified/i],
    ] as const) {
      previewAshbyScorecardBinding.mockResolvedValue({ ok: false, error: code });
      const view = renderPage();
      await mappingAction(0, /preview scorecard binding/i);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(fragment);
      view.unmount();
    }
    previewAshbyScorecardBinding.mockRejectedValue({ message: 'network down' });
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not preview/i);
  });

  it('has no axe violations with a preview rendered', async () => {
    const { container } = renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    await screen.findByText(/Scorecard binding preview — read-only/);
    await expect(container).toHaveNoViolations();
  });
});

describe('Adding a job mapping', () => {
  // ITS OWN RESET. Without this the block inherits whatever the previous
  // describe's last test left on the shared mocks — which is how the first
  // test here failed to find a mapping row that every other test could see.
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm3', status: 'paused' });
  });

  // WHY THIS EXISTS. `POST .../mission-control/mappings` shipped with the
  // integration and nothing ever called it; the first form that did asked an
  // admin to TYPE an Ashby job id and two stage ids. The dialog asks for two
  // choices, both made by name.
  const SALES_ROLE = '11111111-1111-4111-8111-111111111111';
  /** The fixture's one pickable job and one active role, as the options name them. */
  const FREE_JOB = 'Customer Success Lead Opened 1 Aug 2026';
  const SALES_OPTION = 'Sales Advisor Agent · Sales v1 hiring';

  /** Opens the dialog and waits for the read it fires on open to land. */
  async function openDialog() {
    renderPage();
    // m2's status badge: on screen whatever job list a test supplies.
    await screen.findByText('Out of sync');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    const dialog = screen.getByRole('dialog', { name: 'Add job mapping' });
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    return dialog;
  }

  async function chooseAndSave(jobOption: string | RegExp) {
    await pick(JOB_PICKER, jobOption);
    // Roles are re-read on every open too; wait for that read to land.
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    await pick(ROLE_PICKER, startsWith('Sales Advisor'));
    await userEvent.click(screen.getByRole('button', { name: /Save mapping/ }));
  }

  it('opens a MODAL DIALOG with exactly two pickers and nothing to type', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    const trigger = screen.getByRole('button', { name: 'Add mapping' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Add job mapping' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Enabling is a separate, database-gated action; an admin who assumes
    // "saved" means "live" would wait for calls that never come. The dialog
    // says so in its DESCRIPTION — what a screen reader announces on open.
    expect(dialog).toHaveAccessibleDescription(
      'Screen applicants for a live Ashby job with one of your roles. New mappings start paused.',
    );
    // Two choices, no free text: no job id, no stage id, no label to type.
    // Each picker is a listbox trigger, not a field.
    const pickers = within(dialog)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-haspopup') === 'listbox');
    expect(pickers).toHaveLength(2);
    expect(pickers[0]).toHaveAccessibleName(JOB_PICKER);
    expect(pickers[1]).toHaveAccessibleName(ROLE_PICKER);
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0);
    expect(dialog.querySelectorAll('input, textarea, select, [contenteditable]')).toHaveLength(0);
    expect(within(dialog).queryByText(/stage/i)).toBeNull();
    // The list is LIVE: read on page load AND again on open.
    await waitFor(() => expect(listAshbyJobs).toHaveBeenCalledTimes(2));
  });

  it('offers only OPEN jobs, by title, and never renders a job id', async () => {
    const dialog = await openDialog();
    expect(jobPicker()).toHaveAccessibleName('Ashby job Choose a job');
    const list = await openPicker(JOB_PICKER);
    // No job id — not in the text, not in an option's value, not in a title
    // tooltip or an ARIA attribute — nowhere in the page's markup with every
    // option rendered. Checked FIRST, so it stands on its own and does not
    // hinge on the option names asserted below.
    const ids = JOBS.jobs.map((job) => job.id);
    for (const id of ids) expect(document.body.innerHTML).not.toContain(id);
    expect(list).toHaveAccessibleName('Open Ashby jobs');
    // The two Open jobs, the pickable one first; Draft, Closed and Archived
    // jobs are not offered at all.
    expectOptions(list, [FREE_JOB, 'Account Executive Opened 1 Jul 2026 Mapped']);
    for (const title of ['Draft Role', 'Night Shift Advisor', 'Old Archived Role']) {
      expect(within(list).queryByRole('option', { name: startsWith(title) })).toBeNull();
    }
    // …nor once a job is chosen and the trigger and preview name it.
    await userEvent.click(within(list).getByRole('option', { name: FREE_JOB }));
    expect(jobPicker()).toHaveAccessibleName(`Ashby job ${FREE_JOB}`);
    for (const id of ids) expect(document.body.innerHTML).not.toContain(id);
    expect(dialog.innerHTML).not.toMatch(/job_\d/);
  });

  it('keeps an already-mapped job LISTED but disabled', async () => {
    // Dropping it would read as "Ashby has no such job" to an admin looking
    // for it; disabling says why it cannot be picked.
    await openDialog();
    const list = await openPicker(JOB_PICKER);
    const group = within(list).getByRole('group', { name: 'Already mapped' });
    const mapped = within(group).getByRole('option', { name: startsWith('Account Executive') });
    const free = within(list).getByRole('option', { name: FREE_JOB });
    expect(mapped).toHaveAttribute('aria-disabled', 'true');
    expect(mapped).toHaveTextContent('Mapped');
    expect(free).not.toHaveAttribute('aria-disabled');
    expect(within(group).queryByRole('option', { name: FREE_JOB })).toBeNull();
    // A click on it chooses nothing: the list stays open, nothing is picked.
    await userEvent.click(mapped);
    expect(screen.getByRole('listbox')).toBe(list);
    expect(jobPicker()).toHaveAccessibleName('Ashby job Choose a job');
  });

  it('tells same-titled jobs apart by an "Opened" line, then a listing number — never by id', async () => {
    listAshbyJobs.mockResolvedValue({
      ok: true,
      truncated: false,
      jobs: [
        // Noon UTC, so the calendar day is the same in every test timezone.
        { id: 'ash_a', title: 'Support Agent', status: 'Open', openedAt: '2026-06-01T12:00:00Z' },
        { id: 'ash_b', title: 'Support Agent', status: 'Open', openedAt: '2026-07-15T12:00:00Z' },
        { id: 'ash_c', title: 'Support Agent', status: 'Open', openedAt: '2026-07-15T12:00:00Z' },
        { id: 'ash_d', title: '   ', status: 'Open', openedAt: null },
        { id: 'ash_e', title: null, status: 'Open', openedAt: null },
      ],
    });
    await openDialog();
    const list = await openPicker(JOB_PICKER);
    // ONE row format for every job: the title, then an "Opened" line.
    const labels = [
      'Support Agent Opened 1 Jun 2026',
      'Support Agent Opened 15 Jul 2026',
      // Same title AND same day: a listing number on the same line.
      'Support Agent Opened 15 Jul 2026 · listing 2',
      // No title (blank counts as none) and no date: numbered too.
      'Untitled job',
      'Untitled job Listing 2',
    ];
    expectOptions(list, labels);
    expect(new Set(labels).size).toBe(labels.length);
    expect(document.body.innerHTML).not.toMatch(/ash_/);
  });

  it('keeps Save disabled until BOTH a job and a role are chosen', async () => {
    await openDialog();
    const save = screen.getByRole('button', { name: /Save mapping/ });
    expect(save).toBeDisabled();
    await pick(JOB_PICKER, FREE_JOB);
    expect(save).toBeDisabled();
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    await pick(ROLE_PICKER, SALES_OPTION);
    expect(save).toBeEnabled();
  });

  it('says what Save will create — by NAME, once both are chosen, and not before', async () => {
    const dialog = await openDialog();
    const summary = () => within(dialog).queryByText(/^Applicants for/);
    // Nothing (or half) chosen: no placeholder preview restating the pickers.
    expect(summary()).toBeNull();
    await pick(JOB_PICKER, FREE_JOB);
    expect(summary()).toBeNull();

    await waitFor(() => expect(rolePicker()).toBeEnabled());
    await pick(ROLE_PICKER, SALES_OPTION);
    // The job's NAME and the role's TITLE — not the "Opened" line or the
    // agent, and never an id or uuid.
    expect(summary()).toHaveTextContent(
      "Applicants for Customer Success Lead will be screened with the Sales Advisor role's questions and scorecard.",
    );
    expect(summary()!.innerHTML).not.toMatch(/job_\d|11111111-/);
  });

  it('SENDS exactly { external_job_id, role_id, label } — no stage keys — then closes and reloads', async () => {
    await openDialog();
    await chooseAndSave(FREE_JOB);

    await waitFor(() => expect(createAshbyMapping).toHaveBeenCalledTimes(1));
    const body = createAshbyMapping.mock.calls[0][0];
    expect(body).toEqual({
      external_job_id: 'job_3',
      role_id: SALES_ROLE,
      label: 'Customer Success Lead',
    });
    // Exact KEYS, not just equal values: `toEqual` treats a key set to
    // `undefined` as absent, and the rule is that no stage key is sent at
    // all — the route fixes the screening stage itself.
    expect(Object.keys(body).sort()).toEqual(['external_job_id', 'label', 'role_id']);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Reloaded, so the new row appears without a manual refresh…
    await waitFor(() => expect(listAshbyMappings).toHaveBeenCalledTimes(2));
    // …and the keyboard user is back where they started.
    expect(screen.getByRole('button', { name: 'Add mapping' })).toHaveFocus();
  });

  it('cuts the label to the route cap, and OMITS it when the job has no title', async () => {
    const long = `  ${'X'.repeat(130)}  `;
    listAshbyJobs.mockResolvedValue({
      ok: true,
      truncated: false,
      jobs: [
        { id: 'job_long', title: long, status: 'Open', openedAt: null },
        { id: 'job_untitled', title: null, status: 'Open', openedAt: null },
      ],
    });
    await openDialog();
    await chooseAndSave('X'.repeat(130));
    await waitFor(() => expect(createAshbyMapping).toHaveBeenCalledTimes(1));
    // A 130-character label would be refused WHOLE as `invalid_label`.
    expect(createAshbyMapping.mock.calls[0][0].label).toBe('X'.repeat(120));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    await chooseAndSave('Untitled job');
    await waitFor(() => expect(createAshbyMapping).toHaveBeenCalledTimes(2));
    expect(Object.keys(createAshbyMapping.mock.calls[1][0]).sort()).toEqual([
      'external_job_id',
      'role_id',
    ]);
  });

  it("shows the route's reason INSIDE the dialog, which stays open with both choices intact", async () => {
    // THROWN, not resolved. `apiClient.request` throws `ApiError` on every
    // non-2xx and this route only emits `ok:false` with 400/409/500, so a
    // resolved `{ok:false}` is a shape the API layer cannot produce.
    createAshbyMapping.mockRejectedValue(new ApiError('invalid_external_job_id', 400));
    const dialog = await openDialog();
    await chooseAndSave(FREE_JOB);

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'That job could not be used. Pick it again from the list.',
      ),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    // Both triggers still name their choice.
    expect(jobPicker()).toHaveAccessibleName(`Ashby job ${FREE_JOB}`);
    expect(rolePicker()).toHaveAccessibleName(`Role ${SALES_OPTION}`);
    // Nothing on screen is known to be stale, so nothing is re-read.
    expect(listAshbyMappings).toHaveBeenCalledTimes(1);
    expect(listAshbyJobs).toHaveBeenCalledTimes(2);
    expect(dialog).not.toHaveTextContent('invalid_external_job_id');
  });

  it('409 conflict — the job was JUST mapped elsewhere: says so, and really refreshes both lists', async () => {
    // What the API now emits for a create on a job that already has a LIVE
    // mapping: a Postgres unique violation, surfaced as 409 `conflict`.
    createAshbyMapping.mockRejectedValue(new ApiError('conflict', 409));
    // Someone else's mapping for job_3 is on the server by the time we look.
    const TAKEN = {
      ok: true,
      mappings: [
        ...MAPPINGS.mappings,
        { ...MAPPINGS.mappings[0], id: 'm_other', externalJobId: 'job_3', status: 'paused' },
      ],
    };
    listAshbyMappings.mockResolvedValueOnce(MAPPINGS).mockResolvedValue(TAKEN);
    const dialog = await openDialog();
    await chooseAndSave(FREE_JOB);

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'This job was just mapped by someone else. The list has been refreshed.',
      ),
    );
    // "has been refreshed" is TRUE: the mapping list and the job list were
    // both read again (page load + open + this refresh = 3 job reads).
    expect(listAshbyMappings).toHaveBeenCalledTimes(2);
    expect(listAshbyJobs).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('dialog')).toBe(dialog);
    // The stale choice is gone, the role choice is kept, and Save is off.
    expect(jobPicker()).toHaveAccessibleName('Ashby job Choose a job');
    expect(rolePicker()).toHaveAccessibleName(`Role ${SALES_OPTION}`);
    expect(screen.getByRole('button', { name: /Save mapping/ })).toBeDisabled();
    // The refreshed picker shows the job as taken: listed, grouped, disabled.
    const list = await openPicker(JOB_PICKER);
    const taken = within(within(list).getByRole('group', { name: 'Already mapped' })).getByRole(
      'option',
      { name: `${FREE_JOB} Mapped` },
    );
    expect(taken).toHaveAttribute('aria-disabled', 'true');
  });

  it('409 archived — says the mapping was deleted meanwhile, and refreshes', async () => {
    createAshbyMapping.mockRejectedValue(new ApiError('archived', 409));
    const dialog = await openDialog();
    await chooseAndSave(FREE_JOB);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        "This mapping was deleted while you were working, so it can't be changed.",
      ),
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/new, paused mapping/);
    expect(listAshbyMappings).toHaveBeenCalledTimes(2);
    expect(listAshbyJobs).toHaveBeenCalledTimes(3);
    expect(dialog).not.toHaveTextContent(/\barchived\b/);
  });

  it('REFUSES to close while the save is in flight', async () => {
    let settle: (value: unknown) => void = () => {};
    createAshbyMapping.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const dialog = await openDialog();
    await chooseAndSave(FREE_JOB);

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => settle({ ok: true, id: 'm3', status: 'paused' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a LOADING picker while the job list is being read', async () => {
    // Page load answers; the read fired on open never does.
    listAshbyJobs.mockResolvedValueOnce(JOBS).mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    // Off, busy, and saying why — the placeholder is the whole of its name.
    expect(jobPicker()).toBeDisabled();
    expect(jobPicker()).toHaveAttribute('aria-busy', 'true');
    expect(jobPicker()).toHaveAccessibleName('Ashby job Loading jobs from Ashby…');
    // Nothing to choose from yet: it will not open.
    await userEvent.click(jobPicker());
    expect(screen.queryByRole('listbox')).toBeNull();
    // The rows keep the names they already had.
    expect(screen.getByText('Account Executive')).toBeInTheDocument();
  });

  const jobsLive = () => document.getElementById('ashby-mapping-jobs-live')!;
  const jobNote = () => document.getElementById('ashby-mapping-job-note')!;

  it('says WHY the jobs could not be listed — and offers "Try again" ONLY when trying again can help', async () => {
    for (const [err, copy, retryable] of [
      [new ApiError('integration_disabled', 503), "The Ashby integration is turned off, so jobs can't be listed.", false],
      [new ApiError('forbidden', 403), 'Only admins can list Ashby jobs.', false],
      [new ApiError('probe_unavailable', 502), "Couldn't load jobs from Ashby.", true],
      [new Error('network down'), "Couldn't load jobs from Ashby.", true],
    ] as const) {
      listAshbyJobs.mockRejectedValue(err);
      const view = renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Add mapping' }));
      // Announced by the dialog's persistent polite region…
      await waitFor(() => expect(jobsLive()).toHaveTextContent(copy));
      // …and shown under the picker, which it describes.
      expect(jobNote()).toHaveTextContent(copy);
      expect(jobPicker()).toBeDisabled();
      // The whole note describes the picker — the reason, then (when there
      // is one) the Try again that follows it.
      expect(jobPicker()).toHaveAccessibleDescription(startsWith(copy));
      // A switched-off integration or a missing permission fails the same
      // way every time: a Try again button would promise otherwise.
      expect(within(jobNote()).queryAllByRole('button', { name: 'Try again' })).toHaveLength(
        retryable ? 1 : 0,
      );
      view.unmount();
    }
  });

  it('"Try again" reads the jobs again and moves focus to the job picker once it is usable', async () => {
    listAshbyJobs.mockRejectedValue(new Error('network down'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add mapping' }));
    const retry = await within(jobNote()).findByRole('button', { name: 'Try again' });

    listAshbyJobs.mockClear();
    let answer: (value: unknown) => void = () => {};
    listAshbyJobs.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await userEvent.click(retry);
    // In flight: the button left with its notice, so focus waits on the
    // note — not on <body> — and the region says what is happening.
    expect(jobNote()).toHaveFocus();
    expect(jobsLive()).toHaveTextContent('Loading jobs from Ashby…');

    await act(async () => answer(JOBS));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    expect(listAshbyJobs).toHaveBeenCalledTimes(1);
    // Focus is on the picker's TRIGGER, closed — asserted before opening it,
    // which moves focus into its search field.
    expect(jobPicker()).toHaveFocus();
    expect(jobPicker()).toHaveAttribute('aria-expanded', 'false');
    // job_1 and job_3 are the Open ones.
    expect(jobsLive()).toHaveTextContent('2 open jobs');
    expect(within(jobNote()).queryByRole('button', { name: 'Try again' })).toBeNull();
    // …and the list it now opens is the one just read.
    const list = await openPicker(JOB_PICKER);
    expect(within(list).getByRole('option', { name: FREE_JOB })).toBeInTheDocument();
  });

  it('a "Try again" that fails AGAIN leaves focus on Try again, not on <body>', async () => {
    listAshbyJobs.mockRejectedValue(new ApiError('probe_unavailable', 502));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add mapping' }));
    await userEvent.click(await within(jobNote()).findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(jobNote()).getByRole('button', { name: 'Try again' })).toHaveFocus());
    expect(jobsLive()).toHaveTextContent("Couldn't load jobs from Ashby.");
  });

  it('a "Try again" that finds NO open jobs puts focus on the note that says so', async () => {
    listAshbyJobs.mockRejectedValue(new Error('network down'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add mapping' }));
    const retry = await within(jobNote()).findByRole('button', { name: 'Try again' });
    listAshbyJobs.mockResolvedValue({ ...JOBS, jobs: JOBS.jobs.filter((job) => job.status !== 'Open') });
    await userEvent.click(retry);
    await waitFor(() => expect(jobNote()).toHaveTextContent('There are no open jobs in Ashby right now.'));
    expect(jobPicker()).toBeDisabled();
    expect(jobNote()).toHaveFocus();
  });

  it('announces the job list in a PERSISTENT polite region: loading, then how many', async () => {
    let answer: (value: unknown) => void = () => {};
    listAshbyJobs.mockResolvedValueOnce(JOBS).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    const region = jobsLive();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveClass('sr-only');
    expect(region).toHaveTextContent('Loading jobs from Ashby…');
    await act(async () => answer(JOBS));
    // The SAME node, now carrying the count — a region that already exists
    // is what gets announced reliably.
    await waitFor(() => expect(jobsLive()).toHaveTextContent('2 open jobs'));
    expect(jobsLive()).toBe(region);
    // No visible notice doubles as a second live region.
    expect(within(jobNote()).queryAllByRole('status')).toHaveLength(0);
    expect(within(jobNote()).queryAllByRole('alert')).toHaveLength(0);
  });

  it("says so when Ashby WITHHELD confidential jobs — and only then", async () => {
    listAshbyJobs.mockResolvedValue({ ...JOBS, withheld: 2 });
    const view = renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    expect(within(jobNote()).getByText("Confidential jobs aren't listed here.")).toBeInTheDocument();
    expect(jobPicker()).toHaveAccessibleDescription("Confidential jobs aren't listed here.");
    // A count only — never which jobs.
    expect(jobNote()).not.toHaveTextContent(/2/);
    view.unmount();

    listAshbyJobs.mockResolvedValue({ ...JOBS, withheld: 0 });
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    expect(screen.queryByText("Confidential jobs aren't listed here.")).toBeNull();
    expect(jobPicker()).not.toHaveAccessibleDescription();
  });

  it('WARNS when the job list may be incomplete (a bound OR a slow Ashby cut it)', async () => {
    listAshbyJobs.mockResolvedValue({ ...JOBS, truncated: true });
    await openDialog();
    expect(
      screen.getByText(
        'This list may be incomplete — Ashby was slow or has more jobs than it can show. If a job is missing, close this and try again in a minute.',
      ),
    ).toBeInTheDocument();
  });

  it('SAYS SO when Ashby has no open jobs at all', async () => {
    listAshbyJobs.mockResolvedValue({
      ...JOBS,
      jobs: JOBS.jobs.filter((job) => job.status !== 'Open'),
    });
    renderPage();
    await screen.findByText('Night Shift Advisor');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() =>
      expect(within(jobNote()).getByText('There are no open jobs in Ashby right now.')).toBeInTheDocument(),
    );
    expect(jobsLive()).toHaveTextContent('There are no open jobs in Ashby right now.');
    expect(jobPicker()).toBeDisabled();
  });

  it('OFFERS ONLY ACTIVE ROLES', async () => {
    // Mapping an Ashby job to a retired role produces a screening call
    // against a script nobody maintains any more.
    await openDialog();
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    const list = await openPicker(ROLE_PICKER);
    expect(list).toHaveAccessibleName('Active roles');
    // By title, with the agent it runs on as the second line.
    expectOptions(list, [SALES_OPTION]);
    expect(within(list).queryByRole('option', { name: /Retired Role/ })).toBeNull();
  });

  it('SURVIVES a roles lookup failure', async () => {
    // The picker is a convenience; the mapping list and its pause/resume
    // actions are what this page is for and must not disappear with it.
    listRoles.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Account Executive')).toBeInTheDocument();
  });

  // ── Roles in the dialog ──────────────────────────────────────────────
  const rolesLive = () => document.getElementById('ashby-mapping-roles-live')!;
  const roleNote = () => document.getElementById('ashby-mapping-role-note')!;

  it('re-reads the roles EVERY time the dialog opens', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    await waitFor(() => expect(listRoles).toHaveBeenCalledTimes(1));
    for (const opens of [2, 3]) {
      // A role created on the Roles page since: pickable without a reload.
      listRoles.mockResolvedValue([
        ...ROLES,
        { ...ROLES[0], id: `33333333-3333-4333-8333-33333333333${opens}`, title: `New Role ${opens}`, agent_name: undefined },
      ]);
      await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
      await waitFor(() => expect(listRoles).toHaveBeenCalledTimes(opens));
      // The picker stays off (loading) until THIS read lands, so the list it
      // opens is the fresh one.
      await waitFor(() => expect(rolePicker()).toBeEnabled());
      const list = await openPicker(ROLE_PICKER);
      // No agent: the title alone names it.
      expect(within(list).getByRole('option', { name: `New Role ${opens}` })).toBeInTheDocument();
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    }
  });

  it('shows a LOADING role picker while the roles are being read', async () => {
    listRoles.mockResolvedValueOnce(ROLES).mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    expect(rolePicker()).toBeDisabled();
    expect(rolePicker()).toHaveAttribute('aria-busy', 'true');
    expect(rolePicker()).toHaveAccessibleName('Role Loading roles…');
    await userEvent.click(rolePicker());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(rolesLive()).toHaveTextContent('Loading roles…');
  });

  it('a roles read that fails says so, and "Try again" reads them again and focuses the picker', async () => {
    listRoles.mockResolvedValueOnce(ROLES).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(roleNote()).toHaveTextContent("Couldn't load roles."));
    expect(rolesLive()).toHaveTextContent("Couldn't load roles.");
    expect(rolePicker()).toBeDisabled();
    expect(rolePicker()).toHaveAccessibleDescription(startsWith("Couldn't load roles."));

    listRoles.mockResolvedValue(ROLES);
    await userEvent.click(within(roleNote()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    // Focus on the closed trigger first; opening it moves focus to its search.
    expect(rolePicker()).toHaveFocus();
    expect(rolesLive()).toHaveTextContent('1 active role');
    const list = await openPicker(ROLE_PICKER);
    expect(within(list).getByRole('option', { name: SALES_OPTION })).toBeInTheDocument();
  });

  it('with NO active agents, says so and links to the Agents page', async () => {
    listRoles.mockResolvedValue(ROLES.filter((role) => !role.is_active));
    const { container } = renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() =>
      expect(roleNote()).toHaveTextContent(
        'There are no active agents yet. Create one on the Agents page first.',
      ),
    );
    expect(within(roleNote()).getByRole('link', { name: 'Agents page' })).toHaveAttribute('href', '/roles');
    expect(rolePicker()).toBeDisabled();
    expect(rolesLive()).toHaveTextContent('There are no active agents yet. Create one on the Agents page first.');
    expect(screen.getByRole('button', { name: /Save mapping/ })).toBeDisabled();
    await expect(container).toHaveNoViolations();
  });

  it('both pickers are the design-system Combobox — listbox triggers, full width and free to shrink', async () => {
    await openDialog();
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    for (const [trigger, id] of [
      [jobPicker(), 'ashby-mapping-job'],
      [rolePicker(), 'ashby-mapping-role'],
    ] as const) {
      // A BUTTON that pops up a listbox — not a native select, whose list is
      // the operating system's — and one that can never submit the form.
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger).toHaveAttribute('type', 'button');
      expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      // Its visible <label> still points at it by the old id.
      expect(trigger).toHaveAttribute('id', id);
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
      // Full width, and free to shrink inside the dialog's column — the
      // trigger AND the control's own wrapper, since a flex item's minimum
      // width is its content's.
      expect(trigger).toHaveClass('w-full', 'min-w-0');
      expect(trigger.parentElement).toHaveClass('min-w-0');
    }
  });

  // ── Focus after a failed request ─────────────────────────────────────
  // While a request is in flight every control is disabled, and a real
  // browser moves focus off a control the moment it is disabled — to <body>.
  // jsdom does not, so each test does that by hand (`dropFocusToBody`) while the
  // request hangs; the page must then put focus back itself.

  it('a FAILED save puts focus back on Save — never leaves it on <body>', async () => {
    let fail: (reason: unknown) => void = () => {};
    createAshbyMapping.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    await openDialog();
    await chooseAndSave(FREE_JOB);
    dropFocusToBody();

    await act(async () => fail(new ApiError('mission_control_action_error', 500)));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save mapping/ })).toHaveFocus());
  });

  it('a failed save whose refresh DISABLES Save puts focus on the first control that can take it', async () => {
    let fail: (reason: unknown) => void = () => {};
    createAshbyMapping.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    await openDialog();
    await chooseAndSave(FREE_JOB);
    dropFocusToBody();

    // A conflict re-reads the job list, which clears the choice: Save is off.
    await act(async () => fail(new ApiError('conflict', 409)));
    await waitFor(() => expect(jobPicker()).toHaveFocus());
    expect(screen.getByRole('button', { name: /Save mapping/ })).toBeDisabled();
  });

  it('has no axe violations with the dialog open', async () => {
    const { container } = renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    await expect(container).toHaveNoViolations();
  });
});

describe('Mapping rows name the job — never its id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
  });

  it('shows each job by its NAME, closed ones included, and renders no job id anywhere', async () => {
    renderPage();
    expect(await screen.findByText('Account Executive')).toBeInTheDocument();
    // job_2 is CLOSED: never offered in the picker, but it still names its row.
    expect(screen.getByText('Night Shift Advisor')).toBeInTheDocument();
    expect(screen.queryByText('job_1')).toBeNull();
    expect(screen.queryByText('job_2')).toBeNull();
    // Not as text, and not tucked into a `title` tooltip or any attribute.
    expect(document.body.innerHTML).not.toMatch(/job_1|job_2/);
  });

  it('falls back to the saved label, then to "(name unavailable)", and shows a differing label second', async () => {
    const base = MAPPINGS.mappings[0];
    listAshbyMappings.mockResolvedValue({
      ok: true,
      mappings: [
        // Label equal to the live title: shown ONCE, not twice.
        { ...base, id: 'm1', externalJobId: 'job_1', label: 'Account Executive' },
        // A hand-typed tag that differs from the title: shown as a second line.
        { ...base, id: 'm5', externalJobId: 'job_3', label: 'canary' },
        // Gone from the live list (confidential, deleted): the saved label.
        { ...base, id: 'm3', externalJobId: 'job_gone', label: 'Legacy Sales Role' },
        // Gone, and no label either.
        { ...base, id: 'm4', externalJobId: 'job_gone_too', label: null },
      ],
    });
    renderPage();
    expect(await screen.findByText('Legacy Sales Role')).toBeInTheDocument();
    expect(screen.getByText('Ashby job (name unavailable)')).toBeInTheDocument();
    expect(screen.getAllByText('Account Executive')).toHaveLength(1);
    expect(screen.getByText('Customer Success Lead')).toBeInTheDocument();
    expect(screen.getByText('canary')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/job_gone|job_1|job_3/);
  });

  it('says the name is LOADING, not unavailable, while Ashby is still answering', async () => {
    listAshbyJobs.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findAllByText('Loading job name…')).toHaveLength(2);
    expect(screen.queryByText('Ashby job (name unavailable)')).toBeNull();
  });

  it('SURVIVES a jobs lookup failure — rows fall back and the page stays', async () => {
    // Best effort, like roles: a failure costs the names and the picker.
    listAshbyJobs.mockRejectedValue(new ApiError('probe_unavailable', 502));
    renderPage();
    expect(await screen.findAllByText('Ashby job (name unavailable)')).toHaveLength(2);
    expect(screen.getByText('Out of sync')).toBeInTheDocument();
    // The failure is the DIALOG's to explain, when someone opens it; the
    // page itself raises no alarm over a convenience.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Deleting a job mapping', () => {
  // "Delete" ARCHIVES: the row leaves Mission Control, its history stays, and
  // the database refuses an ENABLED mapping. One row per state here — enabled
  // (m1), drift (m2) and paused (map_paused, named from the live job list).
  const PAUSED = {
    ...MAPPINGS.mappings[0],
    id: 'map_paused',
    externalJobId: 'job_3',
    status: 'paused',
    label: null,
  };
  const THREE = { ok: true, mappings: [...MAPPINGS.mappings, PAUSED] };
  const HINT = 'Pause this mapping before deleting it';
  // A deleted mapping is FROZEN: re-adding the job makes a NEW mapping, so
  // the copy must not promise the old one "comes back" — nor that the
  // candidates it imported but never screened will be picked up by the new one.
  const CONSEQUENCES =
    "It won't screen anyone again and disappears from this list. Candidates already screened — " +
    'their calls, scores and history — are kept. Candidates it imported but has not screened ' +
    "yet won't be screened. You can add this job again later as a new, paused mapping for new " +
    'applicants.';

  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(THREE);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    archiveAshbyMapping.mockResolvedValue({ ok: true, already_archived: false });
  });

  /** The row that names `job`. Call it only while no dialog repeats the name. */
  const row = (job: string) => screen.getByText(job).closest('li')!;
  /** The row's "More" menu button — where Delete lives, and where focus returns. */
  const moreOf = (job: string) => within(row(job)).getByRole('button', { name: `More actions for ${job}` });
  /** Opens the row's menu and returns its Delete item. */
  async function deleteItem(job: string): Promise<HTMLElement> {
    await userEvent.click(moreOf(job));
    return within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' });
  }

  async function openConfirm(job = 'Customer Success Lead') {
    renderPage();
    await screen.findByText(job);
    await userEvent.click(await deleteItem(job));
    return screen.getByRole('dialog', { name: 'Delete this mapping?' });
  }

  it('DISABLES Delete on an enabled mapping and says why — in words, as its description', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    const del = await deleteItem('Account Executive');
    // A menu item stays FOCUSABLE while disabled (APG), so the arrow keys
    // reach it and the reason is read with it — unlike a disabled button,
    // which leaves the tab order and could only say why in a tooltip.
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAccessibleName('Delete');
    expect(del).toHaveAccessibleDescription(HINT);
    // Rendered text, not a screen-reader-only span. (`toBeVisible` cannot
    // be used here: the page's reveal motion starts at opacity 0 in jsdom.)
    const hint = within(del).getByText(HINT);
    // The description must come FROM that line.
    expect(hint.id).not.toBe('');
    expect(del).toHaveAttribute('aria-describedby', hint.id);
    expect(hint).not.toHaveClass('sr-only');
    expect(hint).not.toHaveAttribute('aria-hidden');
    expect(hint).not.toHaveAttribute('hidden');
    // Choosing it anyway does nothing.
    await userEvent.click(del);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(archiveAshbyMapping).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    // Only the enabled row's Delete carries it.
    for (const job of ['Customer Success Lead', 'Night Shift Advisor']) {
      expect(await deleteItem(job)).not.toHaveAccessibleDescription();
      await userEvent.keyboard('{Escape}');
    }
  });

  it('ENABLES Delete on a paused mapping and on a drifted one, as the LAST, set-apart item of its menu', async () => {
    renderPage();
    await screen.findByText('Customer Success Lead');
    for (const job of ['Customer Success Lead', 'Night Shift Advisor']) {
      const del = await deleteItem(job);
      expect(del).not.toHaveAttribute('aria-disabled');
      expect(del).not.toHaveAccessibleDescription();
      expect(del).toHaveAttribute('aria-haspopup', 'dialog');
      const menu = screen.getByRole('menu');
      const items = within(menu).getAllByRole('menuitem');
      expect(items[items.length - 1]).toBe(del);
      // A hairline sets the destructive item apart from the reads above it.
      expect(within(menu).getByRole('separator').nextElementSibling).toBe(del);
      await userEvent.keyboard('{Escape}');
      expect(moreOf(job)).toHaveFocus();
      // No filled red control on the row: Delete is not a row button at all.
      expect(within(row(job)).queryByRole('button', { name: 'Delete' })).toBeNull();
    }
  });

  it('asks first, in a modal dialog that names the JOB — never an id', async () => {
    const dialog = await openConfirm();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The name is the dialog's description: announced with its title on open.
    expect(dialog).toHaveAccessibleDescription('Customer Success Lead');
    expect(dialog).toHaveTextContent(CONSEQUENCES);
    expect(dialog).not.toHaveTextContent(/brings? the mapping back|restor/i);
    // Not the Ashby job id, not the mapping id — nowhere in the markup.
    expect(dialog.innerHTML).not.toMatch(/job_\d|map_paused/);
    expect(archiveAshbyMapping).not.toHaveBeenCalled();
  });

  it("names the job by the row's own rule: saved label, then \"(name unavailable)\"", async () => {
    listAshbyMappings.mockResolvedValue({
      ok: true,
      mappings: [
        { ...PAUSED, id: 'map_gone', externalJobId: 'job_gone', label: 'Legacy Sales Role' },
        { ...PAUSED, id: 'map_gone_too', externalJobId: 'job_gone_too', label: null },
      ],
    });
    let dialog = await openConfirm('Legacy Sales Role');
    expect(dialog).toHaveAccessibleDescription('Legacy Sales Role');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await screen.findByText('Ashby job (name unavailable)');
    await userEvent.click(await deleteItem('Ashby job (name unavailable)'));
    dialog = screen.getByRole('dialog', { name: 'Delete this mapping?' });
    expect(dialog).toHaveAccessibleDescription('Ashby job (name unavailable)');
    expect(dialog.innerHTML).not.toMatch(/job_gone|map_gone/);
  });

  it('confirming archives THAT mapping, then closes and reloads — focus lands on Add mapping', async () => {
    // The reload no longer lists it.
    listAshbyMappings.mockResolvedValueOnce(THREE).mockResolvedValue(MAPPINGS);
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(archiveAshbyMapping).toHaveBeenCalledTimes(1);
    expect(archiveAshbyMapping).toHaveBeenCalledWith('map_paused');
    await waitFor(() => expect(listAshbyMappings).toHaveBeenCalledTimes(2));
    // Archived BEFORE the reload — the other order would re-list the row.
    expect(archiveAshbyMapping.mock.invocationCallOrder[0]).toBeLessThan(
      listAshbyMappings.mock.invocationCallOrder[1],
    );
    await waitFor(() => expect(screen.queryByText('Customer Success Lead')).toBeNull());
    // Its Delete button left with the row, so focus goes to the list's own
    // control rather than falling to <body>.
    expect(screen.getByRole('button', { name: 'Add mapping' })).toHaveFocus();
  });

  it("Cancel and Escape archive nothing, and focus returns to THAT row's More button", async () => {
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The menu item that opened the dialog is gone; its menu's button is not.
    expect(moreOf('Customer Success Lead')).toHaveFocus();

    // Another row, closed with Escape: focus goes back to ITS button.
    await userEvent.click(await deleteItem('Night Shift Advisor'));
    expect(screen.getByRole('dialog', { name: 'Delete this mapping?' })).toHaveAccessibleDescription(
      'Night Shift Advisor',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(moreOf('Night Shift Advisor')).toHaveFocus();

    expect(archiveAshbyMapping).not.toHaveBeenCalled();
    expect(listAshbyMappings).toHaveBeenCalledTimes(1);
  });

  it('409 mapping_enabled: says to pause first INSIDE the dialog, and refreshes the stale row', async () => {
    archiveAshbyMapping.mockRejectedValue(new ApiError('mapping_enabled', 409));
    // Enabled elsewhere since the page loaded: the reload shows the truth.
    listAshbyMappings
      .mockResolvedValueOnce(THREE)
      .mockResolvedValue({ ok: true, mappings: [...MAPPINGS.mappings, { ...PAUSED, status: 'enabled' }] });
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Pause this mapping first, then delete it.'),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(listAshbyMappings).toHaveBeenCalledTimes(2);
    // Pressing it again cannot succeed until the mapping is paused.
    expect(within(dialog).getByRole('button', { name: 'Delete mapping' })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // The row stayed, so focus goes back to its More button.
    expect(moreOf('Customer Success Lead')).toHaveFocus();
    // The row now tells the truth: Live, Pause — the advice — is its action,
    // and its Delete is off, saying why.
    expect(within(row('Customer Success Lead')).getByText('Live')).toBeInTheDocument();
    expect(within(row('Customer Success Lead')).getByRole('button', { name: 'Pause' })).toBeEnabled();
    const del = await deleteItem('Customer Success Lead');
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAccessibleDescription(HINT);
  });

  it('404 not_found: says it was already removed, reloads, and keeps naming the job', async () => {
    archiveAshbyMapping.mockRejectedValue(new ApiError('not_found', 404));
    listAshbyMappings.mockResolvedValueOnce(THREE).mockResolvedValue(MAPPINGS);
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('This mapping was already removed.'),
    );
    expect(listAshbyMappings).toHaveBeenCalledTimes(2);
    // The row left the list; the dialog still says which job it asked about.
    expect(dialog).toHaveAccessibleDescription('Customer Success Lead');
    expect(screen.getAllByText('Customer Success Lead')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Delete mapping' })).toBeDisabled();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Customer Success Lead')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add mapping' })).toHaveFocus();
  });

  it('anything else says "Try again" — and trying again works', async () => {
    archiveAshbyMapping.mockRejectedValueOnce(new ApiError('mission_control_action_error', 500));
    const dialog = await openConfirm();
    const confirm = () => within(dialog).getByRole('button', { name: 'Delete mapping' });
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not delete the mapping. Try again.'),
    );
    // Nothing on screen is known to be wrong, so no reload; and the machine
    // code never reaches the admin.
    expect(listAshbyMappings).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveTextContent('mission_control_action_error');

    archiveAshbyMapping.mockRejectedValueOnce(new Error('network down'));
    await userEvent.click(confirm());
    await waitFor(() => expect(archiveAshbyMapping).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not delete the mapping. Try again.');
    expect(confirm()).toBeEnabled();

    await userEvent.click(confirm());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(archiveAshbyMapping).toHaveBeenCalledTimes(3);
  });

  it('REFUSES to close while the delete is in flight; a repeat (already_archived) is success', async () => {
    let settle: (value: unknown) => void = () => {};
    archiveAshbyMapping.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Deleting/ })).toHaveAttribute('aria-busy', 'true');

    await act(async () => settle({ ok: true, already_archived: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listAshbyMappings).toHaveBeenCalledTimes(2));
  });

  it('a FAILED delete that can be retried puts focus back on "Delete mapping" — not on <body>', async () => {
    let fail: (reason: unknown) => void = () => {};
    archiveAshbyMapping.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));
    // What a real browser does to a focused control that becomes disabled.
    dropFocusToBody();

    await act(async () => fail(new ApiError('mission_control_action_error', 500)));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Delete mapping' })).toHaveFocus(),
    );
  });

  it('a failed delete that CANNOT be retried puts focus on Cancel, the first control that can take it', async () => {
    let fail: (reason: unknown) => void = () => {};
    archiveAshbyMapping.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    listAshbyMappings.mockResolvedValueOnce(THREE).mockResolvedValue(MAPPINGS);
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));
    dropFocusToBody();

    await act(async () => fail(new ApiError('not_found', 404)));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'Delete mapping' })).toBeDisabled();
  });

  it('confirms a delete on the page, in a status region, until the next action', async () => {
    listAshbyMappings.mockResolvedValueOnce(THREE).mockResolvedValue(MAPPINGS);
    const region = () => document.getElementById('ashby-mapping-confirmation')!;
    const dialog = await openConfirm();
    // Mounted (and empty) BEFORE there is anything to say.
    expect(region()).toHaveAttribute('role', 'status');
    expect(region()).toHaveTextContent('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete mapping' }));
    await waitFor(() => expect(region()).toHaveTextContent('Mapping deleted.'));

    // The next action — any action — clears it.
    await userEvent.click(moreOf('Night Shift Advisor'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Discover feedback form' }));
    expect(region()).toHaveTextContent('');
  });

  it('has no axe violations with the confirmation open', async () => {
    const { container } = renderPage();
    await screen.findByText('Customer Success Lead');
    await userEvent.click(await deleteItem('Customer Success Lead'));
    screen.getByRole('dialog', { name: 'Delete this mapping?' });
    await expect(container).toHaveNoViolations();
  });
});

describe('Saving a mapping confirms it on the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm3', status: 'paused' });
    pauseAshbyMapping.mockResolvedValue({ ok: true, status: 'paused' });
  });

  it('says "Mapping added" — and that it is paused — then clears on the next action', async () => {
    const region = () => document.getElementById('ashby-mapping-confirmation')!;
    renderPage();
    await screen.findByText('Account Executive');
    expect(region()).toHaveAttribute('role', 'status');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    await pick(JOB_PICKER, startsWith('Customer Success Lead'));
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    await pick(ROLE_PICKER, startsWith('Sales Advisor'));
    await userEvent.click(screen.getByRole('button', { name: /Save mapping/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(region()).toHaveTextContent("Mapping added. It's paused — use Resume to turn it on."),
    );
    // No second live role inside the region: announced once.
    expect(within(region()).queryAllByRole('status')).toHaveLength(0);

    await userEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]);
    expect(region()).toHaveTextContent('');
    await waitFor(() => expect(pauseAshbyMapping).toHaveBeenCalledWith('m1'));
  });

  it('a FAILED save confirms nothing', async () => {
    createAshbyMapping.mockRejectedValue(new ApiError('mission_control_action_error', 500));
    renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    await pick(JOB_PICKER, startsWith('Customer Success Lead'));
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    await pick(ROLE_PICKER, startsWith('Sales Advisor'));
    await userEvent.click(screen.getByRole('button', { name: /Save mapping/ }));
    await within(screen.getByRole('dialog')).findByRole('alert');
    expect(document.getElementById('ashby-mapping-confirmation')).toHaveTextContent('');
  });
});

describe('Phone layout — no sideways scroll at 360px', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
  });

  // jsdom has no layout, so this pins the CLASS that makes the layout work.
  // A `shrink-0` action group keeps its one-line width even after wrapping
  // onto its own line — six buttons wide, far past a 360px screen — so the
  // whole page scrolled sideways. `min-w-0` lets it shrink and wrap.
  it('lets every row action group shrink and wrap — nothing between a button and its row is shrink-0', async () => {
    renderPage();
    await screen.findByText('app_1');
    const groups = screen.getAllByTestId('row-actions');
    // Two mapping rows and one workflow row.
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group).toHaveClass('min-w-0');
      expect(group).not.toHaveClass('shrink-0');
      const buttons = within(group).getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        // Still WRAPPING: the buttons' own row keeps `flex-wrap`.
        expect(button.parentElement).toHaveClass('flex-wrap');
        for (let el = button.parentElement; el && el.tagName !== 'LI'; el = el.parentElement) {
          expect(el).not.toHaveClass('shrink-0');
        }
      }
    }
  });
});

describe('One name per job — rows, picker and Delete agree, same-titled jobs apart', () => {
  // Three jobs share a title: an OPEN one mapped long ago, a CLOSED one that
  // is also mapped, and a newer OPEN one nobody has mapped yet. The naming
  // rule runs over the WHOLE list, so the closed twin is what gives the two
  // open ones their dates — the picker and the rows must agree on that.
  const TWINS = {
    ok: true,
    truncated: false,
    jobs: [
      // Noon UTC, so the calendar day is the same in every test timezone.
      { id: 'job_twin_old', title: 'Support Agent', status: 'Open', openedAt: '2026-06-01T12:00:00Z' },
      { id: 'job_twin_closed', title: 'Support Agent', status: 'Closed', openedAt: '2026-07-15T12:00:00Z' },
      { id: 'job_twin_new', title: 'Support Agent', status: 'Open', openedAt: '2026-08-20T12:00:00Z' },
    ],
  };
  // LITERAL dates, not the test runner's locale: the disambiguated name is
  // SAVED as the mapping label, so it must read the same for every admin
  // (fixed en-GB, UTC) — a viewer-local format stored one day and rendered
  // another.
  const OLD = 'Support Agent — opened 1 Jun 2026';
  const CLOSED = 'Support Agent — opened 15 Jul 2026';
  const NEW = 'Support Agent — opened 20 Aug 2026';
  const base = MAPPINGS.mappings[0];
  const TWIN_MAPPINGS = {
    ok: true,
    mappings: [
      // Saved before disambiguation: its label is the bare title, which says
      // nothing the name does not — so it is not repeated as a line.
      { ...base, id: 'map_old', externalJobId: 'job_twin_old', status: 'paused', label: 'Support Agent' },
      { ...base, id: 'map_closed', externalJobId: 'job_twin_closed', status: 'paused', label: null },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(TWIN_MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(TWINS);
    createAshbyMapping.mockResolvedValue({ ok: true, id: 'm9', status: 'paused' });
    archiveAshbyMapping.mockResolvedValue({ ok: true, already_archived: false });
  });

  it('names two same-titled mapped jobs DIFFERENTLY in their rows — by date, never by id', async () => {
    renderPage();
    expect(await screen.findByText(OLD)).toBeInTheDocument();
    expect(screen.getByText(CLOSED)).toBeInTheDocument();
    expect(OLD).not.toBe(CLOSED);
    // The bare title is never shown on its own: it would name both rows.
    expect(screen.queryByText('Support Agent')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/job_twin/);
  });

  it('the picker tells the twins apart by their opening DATE; the Delete confirmation uses the row name', async () => {
    renderPage();
    await screen.findByText(OLD);
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    // The closed twin is not offered. The mapped twin is listed last, under
    // "Already mapped", tagged and disabled. Each carries the SAME date the
    // row name does, on its "Opened" line.
    const list = await openPicker(JOB_PICKER);
    expectOptions(list, ['Support Agent Opened 20 Aug 2026', 'Support Agent Opened 1 Jun 2026 Mapped']);
    expect(within(list).getByRole('option', { name: 'Support Agent Opened 1 Jun 2026 Mapped' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(list).queryByRole('option', { name: /15 Jul 2026/ })).toBeNull();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(
      within(screen.getByText(CLOSED).closest('li')!).getByRole('button', { name: `More actions for ${CLOSED}` }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete this mapping?' })).toHaveAccessibleDescription(CLOSED);
  });

  it('saves the DISAMBIGUATED name as the label', async () => {
    renderPage();
    await screen.findByText(OLD);
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobPicker()).toBeEnabled());
    await pick(JOB_PICKER, 'Support Agent Opened 20 Aug 2026');
    // The trigger names the choice as the picker did: title, then the date.
    expect(jobPicker()).toHaveAccessibleName('Ashby job Support Agent Opened 20 Aug 2026');
    await waitFor(() => expect(rolePicker()).toBeEnabled());
    await pick(ROLE_PICKER, startsWith('Sales Advisor'));
    await userEvent.click(screen.getByRole('button', { name: /Save mapping/ }));
    await waitFor(() => expect(createAshbyMapping).toHaveBeenCalledTimes(1));
    expect(createAshbyMapping.mock.calls[0][0]).toEqual({
      external_job_id: 'job_twin_new',
      role_id: '11111111-1111-4111-8111-111111111111',
      label: NEW,
    });
  });
});

describe('Mapping rows name the ROLE — by title, stacked under the job', () => {
  const SALES = '11111111-1111-4111-8111-111111111111';
  const RETIRED = '22222222-2222-4222-8222-222222222222';
  const GONE = '33333333-3333-4333-8333-333333333333';
  const base = MAPPINGS.mappings[0];
  const ROWS = {
    ok: true,
    mappings: [
      { ...base, id: 'm1', externalJobId: 'job_1', roleId: SALES, label: null },
      // A role retired since: still named — resolved against ALL roles.
      { ...base, id: 'm2', externalJobId: 'job_2', status: 'paused', roleId: RETIRED, label: null },
      // A role the read did not return, and a hand-typed tag worth showing.
      { ...base, id: 'm3', externalJobId: 'job_3', status: 'paused', roleId: GONE, label: 'canary' },
      // No role at all; label = the job's own title, so not repeated.
      { ...base, id: 'm4', externalJobId: 'job_4', status: 'paused', roleId: null, label: 'Draft Role' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(ROWS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
  });

  const rowOf = (job: string) => screen.getByText(job).closest('li')!;

  it("shows each row's role on its OWN line, and the label only when it adds something", async () => {
    renderPage();
    await screen.findByText('Role: Sales Advisor');
    expect(within(rowOf('Account Executive')).getByText('Role: Sales Advisor')).toBeInTheDocument();
    expect(within(rowOf('Night Shift Advisor')).getByText('Role: Retired Role')).toBeInTheDocument();
    expect(within(rowOf('Customer Success Lead')).getByText('Role: unavailable')).toBeInTheDocument();
    expect(within(rowOf('Draft Role')).getByText('Role: none')).toBeInTheDocument();

    // STACKED, not run together: name, role and label are separate lines.
    const csl = rowOf('Customer Success Lead');
    const name = within(csl).getByText('Customer Success Lead');
    const roleText = within(csl).getByText('Role: unavailable');
    const label = within(csl).getByText('canary');
    expect(new Set([name, roleText, label]).size).toBe(3);
    expect(roleText.tagName).toBe('P');
    expect(label.tagName).toBe('P');
    expect(name.compareDocumentPosition(roleText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(roleText.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A label that is just the job's title again is not repeated.
    expect(within(rowOf('Draft Role')).getAllByText('Draft Role')).toHaveLength(1);
    // No role uuid, no job id, anywhere in the markup.
    expect(document.body.innerHTML).not.toMatch(/11111111-|22222222-|33333333-|job_\d/);
  });

  it('says the role is LOADING, not unavailable, while the first roles read is in flight', async () => {
    listRoles.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByText('Account Executive');
    expect(screen.getAllByText('Role: loading…').length).toBeGreaterThan(0);
    expect(screen.queryByText('Role: unavailable')).toBeNull();
  });

  it('says "unavailable" when the roles cannot be read — and the page stays', async () => {
    listRoles.mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findByText('Account Executive');
    await waitFor(() => expect(screen.getAllByText('Role: unavailable')).toHaveLength(3));
    expect(screen.getByText('Role: none')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Scorecard binding — a mapping NOT linked to the verified form', () => {
  const ALL_GOOD = {
    ...BINDING_PREVIEW,
    preview: {
      ...BINDING_PREVIEW.preview,
      fixedFields: BINDING_PREVIEW.preview.fixedFields.map((f) => ({ ...f, status: 'present', actualType: f.expectedType ?? 'ValueSelect' })),
      metrics: BINDING_PREVIEW.preview.metrics.slice(0, 2),
      ready: true,
    },
  };
  const NOT_LINKED =
    "This mapping isn't linked to the Hello Christy scorecard form, so no scorecard will be written to Ashby.";

  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
  });

  async function preview() {
    renderPage();
    await mappingAction(0, /preview scorecard binding/i);
    await screen.findByText(/Scorecard binding preview — read-only/);
  }

  it('warns ABOVE the verdict, and never says "Ready", even when every field binds', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({ ...ALL_GOOD, mappingFormBound: false });
    await preview();
    const notice = screen.getByText(NOT_LINKED);
    const verdict = screen.getByTestId('binding-readiness');
    expect(notice.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(verdict.textContent).not.toMatch(/Ready/);
    expect(verdict.textContent).toMatch(/^Not ready — this mapping isn't linked to the Hello Christy scorecard form/);
  });

  it('warns on the v1 legacy path too — the writer refuses there as well', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({ ...ALL_GOOD, scoringPath: 'v1_legacy', mappingFormBound: false });
    await preview();
    expect(screen.getByText(NOT_LINKED)).toBeInTheDocument();
  });

  it('says nothing of the kind when the mapping IS linked, or when the API did not say', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({ ...ALL_GOOD, mappingFormBound: true });
    await preview();
    expect(screen.queryByText(NOT_LINKED)).toBeNull();
    expect(screen.getByTestId('binding-readiness').textContent).toMatch(/^Ready — every metric/);
  });

  it('an API that omits the flag is "unknown", not "not linked"', async () => {
    previewAshbyScorecardBinding.mockResolvedValue(ALL_GOOD);
    await preview();
    expect(screen.queryByText(NOT_LINKED)).toBeNull();
    expect(screen.getByTestId('binding-readiness').textContent).toMatch(/^Ready — every metric/);
  });
});

describe('A mapping row shows ONE action — the one its state calls for', () => {
  // One row per state: Live (m1), Out of sync with a missing TA stage (m2),
  // Paused and complete (job_3), Paused and missing a stage (job_4).
  const base = MAPPINGS.mappings[0];
  const ROWS = {
    ok: true,
    mappings: [
      ...MAPPINGS.mappings,
      { ...base, id: 'm3', externalJobId: 'job_3', status: 'paused', statusReason: 'Paused while the question bank is reviewed' },
      { ...base, id: 'm4', externalJobId: 'job_4', status: 'paused', hasAiStage: false },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(ROWS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    pauseAshbyMapping.mockResolvedValue({ ok: true, status: 'paused' });
    resumeAshbyMapping.mockResolvedValue({ ok: true, status: 'enabled' });
  });

  const rowOf = (job: string) => screen.getByText(job).closest('li')!;
  const rowButtons = (job: string) =>
    within(rowOf(job))
      .getAllByRole('button')
      .map((b) => b.textContent);

  it('Live and Out of sync offer Pause; Paused offers Resume; everything else is in More', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    expect(rowButtons('Account Executive')).toEqual(['Pause', 'More']);
    // The database refuses to resume an out-of-sync mapping outright, so
    // Resume is not offered there at all.
    expect(rowButtons('Night Shift Advisor')).toEqual(['Pause', 'More']);
    expect(rowButtons('Customer Success Lead')).toEqual(['Resume', 'More']);
    expect(rowButtons('Draft Role')).toEqual(['Resume', 'More']);
    // The status, in words, beside each.
    expect(within(rowOf('Account Executive')).getByText('Live')).toBeInTheDocument();
    expect(within(rowOf('Night Shift Advisor')).getByText('Out of sync')).toBeInTheDocument();
    expect(within(rowOf('Customer Success Lead')).getByText('Paused')).toBeInTheDocument();
    // A reason given as a sentence is shown as written.
    expect(within(rowOf('Customer Success Lead')).getByText('Paused while the question bank is reviewed')).toBeInTheDocument();
    // The menu holds the three reads and Delete, in that order.
    await userEvent.click(within(rowOf('Account Executive')).getByRole('button', { name: 'More actions for Account Executive' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.firstChild?.textContent)).toEqual([
      'Discover feedback form',
      'Preview scorecard binding',
      'Preview existing backlog',
      'Delete',
    ]);
  });

  it('a paused mapping missing a stage cannot be resumed, and says which stage, as Resume\'s description', async () => {
    renderPage();
    await screen.findByText('Draft Role');
    const resume = within(rowOf('Draft Role')).getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription('The AI screening stage is missing in Ashby');
    const note = within(rowOf('Draft Role')).getByText('The AI screening stage is missing in Ashby');
    expect(resume).toHaveAttribute('aria-describedby', note.id);
    // The out-of-sync row says which stage it lacks too; its Pause stays on.
    expect(within(rowOf('Night Shift Advisor')).getByText('The TA stage is missing in Ashby')).toBeInTheDocument();
    expect(within(rowOf('Night Shift Advisor')).getByRole('button', { name: 'Pause' })).toBeEnabled();
    // A complete paused mapping resumes.
    await userEvent.click(within(rowOf('Customer Success Lead')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resumeAshbyMapping).toHaveBeenCalledWith('m3'));
  });

  it('only a LIVE mapping offers its backlog; the others say why in the menu', async () => {
    renderPage();
    await screen.findByText('Customer Success Lead');
    await userEvent.click(within(rowOf('Customer Success Lead')).getByRole('button', { name: /^More actions for/ }));
    const backlog = screen.getByRole('menuitem', { name: 'Preview existing backlog' });
    expect(backlog).toHaveAttribute('aria-disabled', 'true');
    expect(backlog).toHaveAccessibleDescription('Available once this mapping is live');
  });

  it('after Pause, focus returns to the SAME button — now saying Resume — not <body>', async () => {
    let settle: (value: unknown) => void = () => {};
    pauseAshbyMapping.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    listAshbyMappings
      .mockResolvedValueOnce(ROWS)
      .mockResolvedValue({ ...ROWS, mappings: ROWS.mappings.map((m) => (m.id === 'm1' ? { ...m, status: 'paused' } : m)) });
    renderPage();
    await screen.findByText('Account Executive');
    const button = within(rowOf('Account Executive')).getByRole('button', { name: 'Pause' });
    await userEvent.click(button);
    // What a real browser does to a focused control the moment it is disabled.
    dropFocusToBody();
    await act(async () => settle({ ok: true, status: 'paused' }));
    await waitFor(() => expect(button).toHaveTextContent('Resume'));
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('says what needs a look above each list, in one sentence', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    expect(screen.getByText('1 live, 2 paused and 1 out of sync.')).toBeInTheDocument();
    expect(screen.getByText('1 with a failed operation and 1 with a resume to review.')).toBeInTheDocument();
  });

  it('has no axe violations with a row menu open', async () => {
    const { container } = renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(within(rowOf('Account Executive')).getByRole('button', { name: /^More actions for/ }));
    await userEvent.keyboard('{End}');
    await expect(container).toHaveNoViolations();
  });
});

describe('Cancelling a screening asks first', () => {
  const CONSEQUENCES =
    "Screening stops for this application. Any invite, scorecard write-back or stage move still " +
    "waiting is cancelled, and it can't be restarted from here.";
  const TERMINAL = { ok: true, workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'cancelled', terminalState: 'manual_stage_cancel' }] };

  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    listRoles.mockResolvedValue(ROLES);
    listAshbyJobs.mockResolvedValue(JOBS);
    cancelAshbyWorkflow.mockResolvedValue({ ok: true, cancelled_operations: 1, cancelled_ingestion: 1 });
  });

  const more = () => screen.getByRole('button', { name: 'More actions for app_1' });

  async function openCancel(): Promise<HTMLElement> {
    renderPage();
    await screen.findByText('app_1');
    await userEvent.click(more());
    const item = screen.getByRole('menuitem', { name: 'Cancel screening' });
    expect(item).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(item);
    return screen.getByRole('dialog', { name: 'Cancel this screening?' });
  }

  it('names the application, says what happens, and puts the red fill only on its confirm button', async () => {
    const dialog = await openCancel();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('app_1');
    expect(dialog).toHaveTextContent(CONSEQUENCES);
    expect(within(dialog).getByRole('button', { name: 'Cancel screening' })).toHaveAttribute('data-dialog-primary');
    expect(cancelAshbyWorkflow).not.toHaveBeenCalled();
  });

  it('Keep screening and Escape cancel nothing, and focus returns to the row\'s More button', async () => {
    const dialog = await openCancel();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep screening' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more()).toHaveFocus();

    await userEvent.click(more());
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel screening' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more()).toHaveFocus();
    expect(cancelAshbyWorkflow).not.toHaveBeenCalled();
  });

  it('confirming cancels, reloads, confirms on the page, and puts focus on the now-closed row', async () => {
    listAshbyWorkflows.mockResolvedValueOnce(WORKFLOWS).mockResolvedValue(TERMINAL);
    const dialog = await openCancel();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel screening' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cancelAshbyWorkflow).toHaveBeenCalledWith('l1', 'manual_stage_cancel');
    // Reloaded BEFORE closing: the row is closed and has no menu any more…
    expect(screen.getByText('Cancelled by an admin')).toHaveAttribute('title', 'manual_stage_cancel');
    expect(screen.queryByRole('button', { name: 'More actions for app_1' })).toBeNull();
    // …so focus is on the row itself, not on <body>.
    expect(screen.getByText('app_1')).toHaveFocus();
    expect(document.getElementById('ashby-mapping-confirmation')).toHaveTextContent('Screening cancelled.');
  });

  it('already closed elsewhere: says so inside the dialog, refreshes, and turns the confirm off', async () => {
    cancelAshbyWorkflow.mockRejectedValue(new ApiError('already_terminal', 409));
    listAshbyWorkflows.mockResolvedValueOnce(WORKFLOWS).mockResolvedValue(TERMINAL);
    const dialog = await openCancel();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel screening' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'This application was already closed. The list has been refreshed.',
      ),
    );
    expect(listAshbyWorkflows).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole('button', { name: 'Cancel screening' })).toBeDisabled();
    expect(dialog).not.toHaveTextContent('already_terminal');
    // Its More button left with the reload; focus goes to the row.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('app_1')).toHaveFocus();
  });

  it('anything else says "Try again", reloads nothing, and trying again works', async () => {
    cancelAshbyWorkflow.mockRejectedValueOnce(new ApiError('mission_control_action_error', 500));
    const dialog = await openCancel();
    const confirm = () => within(dialog).getByRole('button', { name: 'Cancel screening' });
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not cancel this screening. Try again.'),
    );
    expect(listAshbyWorkflows).toHaveBeenCalledTimes(1);
    expect(confirm()).toBeEnabled();
    await userEvent.click(confirm());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cancelAshbyWorkflow).toHaveBeenCalledTimes(2);
  });

  it('has no axe violations with the confirmation open', async () => {
    const { container } = renderPage();
    await screen.findByText('app_1');
    await userEvent.click(more());
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel screening' }));
    screen.getByRole('dialog', { name: 'Cancel this screening?' });
    await expect(container).toHaveNoViolations();
  });
});
