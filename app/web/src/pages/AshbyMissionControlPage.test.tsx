import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyMissionControlPage } from './AshbyMissionControlPage';
import { ApiError } from '../api';

/**
 * The page header now carries a real <Link> back to Mission Control, so the
 * page needs a router context. Routing itself is not under test here.
 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/ashby-mission-control']}>
      <AshbyMissionControlPage />
    </MemoryRouter>,
  );
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

const MAPPINGS = {
  ok: true,
  mappings: [
    { id: 'm1', externalJobId: 'job_1', status: 'enabled', statusReason: null, deliveryMode: 'both', hasAiStage: true, hasTaStage: true, label: null, updatedAt: '2026-08-13T00:00:00Z' },
    { id: 'm2', externalJobId: 'job_2', status: 'drift', statusReason: 'stage_id_invalid', deliveryMode: 'manual', hasAiStage: true, hasTaStage: false, label: null, updatedAt: '2026-08-13T00:00:00Z' },
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

  it('renders sanitized mappings + workflows (no PII/tokens)', async () => {
    renderPage();
    // The job by NAME — the row never renders the id it is keyed on.
    expect(await screen.findByText('Account Executive')).toBeInTheDocument();
    expect(screen.getByText('drift')).toBeInTheDocument();
    expect(screen.getByText('app_1')).toBeInTheDocument();
    // Enums are humanised for operators (raw value kept in `title`).
    expect(screen.getByText(/Ingest · Failed review/)).toBeInTheDocument();
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

  it('cancels a non-terminal workflow and retries a failed operation', async () => {
    renderPage();
    await screen.findByText('app_1');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelAshbyWorkflow).toHaveBeenCalledWith('l1', 'manual_stage_cancel'));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
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
    await userEvent.click(screen.getAllByRole('button', { name: 'Preview existing backlog' })[0]);
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
    // makes a park that never landed visible instead of log-only.
    expect(await screen.findByText(/screened: not parked/i)).toBeInTheDocument();
  });

  it('does not flag a screening that parked correctly', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'writeback_pending', sessionStatus: 'completed' }],
    });
    renderPage();
    expect(await screen.findByText('app_1')).toBeInTheDocument();
    expect(screen.queryByText(/screened: not parked/i)).toBeNull();
  });

  it('does not flag a terminal application', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'ready', sessionStatus: 'completed', terminalState: 'withdrawn' }],
    });
    renderPage();
    expect(await screen.findByText('app_1')).toBeInTheDocument();
    expect(screen.queryByText(/screened: not parked/i)).toBeNull();
  });

  it('disables delivery for a terminal application', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], terminalState: 'withdrawn' }],
    });
    renderPage();
    const button = await screen.findByRole('button', { name: /get invite link/i });
    expect(button).toBeDisabled();
    expect(deliverAshbyManualInvite).not.toHaveBeenCalled();
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
    const buttons = await screen.findAllByRole('button', { name: /discover feedback form/i });
    await userEvent.click(buttons[0]);

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
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
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
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
    await screen.findByText(/form id: form_1/);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\S+@\S+\.\S+/);
    expect(text).not.toMatch(/bearer|presigned|invite_token|resume_url|https?:\/\//i);
  });

  it('says plainly when the plan names no form at all', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({ ok: true, forms: [], empty: true, truncated: false });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
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
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
    expect(await screen.findByText(/only\s+its id could be read/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').toMatch(/not a claim that the form has no fields/i);
  });

  it('warns when a safety bound clipped the result', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({ ...FORM_SCHEMA, truncated: true });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
    expect(await screen.findByText(/truncated by a safety bound/i)).toBeInTheDocument();
  });

  it('surfaces a sanitized API error without rendering a schema', async () => {
    discoverAshbyFeedbackForm.mockResolvedValue({ ok: false, error: 'probe_unavailable' });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
    expect(await screen.findByText('probe_unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/form id:/)).not.toBeInTheDocument();
  });

  it('surfaces a thrown API error as an alert', async () => {
    discoverAshbyFeedbackForm.mockRejectedValue({ message: 'network down' });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/form id:/)).not.toBeInTheDocument();
  });

  it('shows the schema for one mapping at a time', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /discover feedback form/i });
    await userEvent.click(buttons[0]);
    await screen.findByText(/form id: form_1/);
    discoverAshbyFeedbackForm.mockResolvedValue({ ok: true, forms: [], empty: true, truncated: false });
    await userEvent.click(buttons[1]);
    await waitFor(() => expect(discoverAshbyFeedbackForm).toHaveBeenLastCalledWith('job_2'));
    expect(screen.queryByText(/form id: form_1/)).not.toBeInTheDocument();
  });

  it('has no axe violations with a schema rendered', async () => {
    const { container } = renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /discover feedback form/i }))[0]);
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
    const buttons = await screen.findAllByRole('button', { name: /preview scorecard binding/i });
    await userEvent.click(buttons[0]);
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
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
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
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
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
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
    expect((await screen.findByTestId('binding-readiness')).textContent).toMatch(/^Ready — every metric/);
  });

  it('explains the v1 legacy path and a role-less mapping instead of an empty table', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({ ...BINDING_PREVIEW, scoringPath: 'v1_legacy', preview: { ...BINDING_PREVIEW.preview, metrics: [], ready: false } });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
    expect(await screen.findByText(/no active dashboard scorecard/i)).toBeInTheDocument();
    expect(screen.queryByTestId('binding-readiness')).not.toBeInTheDocument();
    expect(screen.queryByText(/Metrics \(bound by name\)/)).not.toBeInTheDocument();

    previewAshbyScorecardBinding.mockResolvedValue({ ...BINDING_PREVIEW, scoringPath: 'no_role', preview: { ...BINDING_PREVIEW.preview, metrics: [], ready: false } });
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[1]);
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
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
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
      await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(fragment);
      view.unmount();
    }
    previewAshbyScorecardBinding.mockRejectedValue({ message: 'network down' });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not preview/i);
  });

  it('has no axe violations with a preview rendered', async () => {
    const { container } = renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
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
  const jobSelect = () => screen.getByLabelText('Ashby job') as HTMLSelectElement;
  const roleSelect = () => screen.getByLabelText(/^Role$/) as HTMLSelectElement;
  const optionTexts = (select: HTMLSelectElement) =>
    [...select.options].map((o) => o.textContent ?? '');

  /** Opens the dialog and waits for the read it fires on open to land. */
  async function openDialog() {
    renderPage();
    // m2's status badge: on screen whatever job list a test supplies.
    await screen.findByText('drift');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    const dialog = screen.getByRole('dialog', { name: 'Add job mapping' });
    await waitFor(() => expect(jobSelect()).toBeEnabled());
    return dialog;
  }

  async function chooseAndSave(jobLabel: string) {
    await userEvent.selectOptions(jobSelect(), jobLabel);
    await userEvent.selectOptions(roleSelect(), SALES_ROLE);
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
    // "saved" means "live" would wait for calls that never come.
    expect(dialog).toHaveAccessibleDescription(/saves paused — use Resume to turn it on/);
    // Two choices, no free text: no job id, no stage id, no label to type.
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(2);
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(dialog).queryByText(/stage/i)).toBeNull();
    // The list is LIVE: read on page load AND again on open.
    await waitFor(() => expect(listAshbyJobs).toHaveBeenCalledTimes(2));
  });

  it('offers only OPEN jobs, by title, and never renders a job id', async () => {
    const dialog = await openDialog();
    expect(optionTexts(jobSelect())).toEqual([
      'Choose a job…',
      'Account Executive — already mapped',
      'Customer Success Lead',
    ]);
    // Not in the text, not in an option's value, not in a title tooltip —
    // nowhere in the dialog's markup at all.
    for (const option of jobSelect().options) {
      expect(option.value).not.toMatch(/job_/);
      expect(option.textContent).not.toMatch(/job_/);
    }
    expect(dialog.innerHTML).not.toMatch(/job_\d/);
  });

  it('keeps an already-mapped job LISTED but disabled', async () => {
    // Dropping it would read as "Ashby has no such job" to an admin looking
    // for it; disabling says why it cannot be picked.
    await openDialog();
    const options = [...jobSelect().options];
    const mapped = options.find((o) => o.textContent === 'Account Executive — already mapped')!;
    const free = options.find((o) => o.textContent === 'Customer Success Lead')!;
    expect(mapped.disabled).toBe(true);
    expect(free.disabled).toBe(false);
  });

  it('tells same-titled jobs apart by opening date, then by number — never by id', async () => {
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
    const labels = optionTexts(jobSelect()).slice(1);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(/^Support Agent — opened \S/);
    expect(labels[1]).toMatch(/^Support Agent — opened \S/);
    expect(labels[1]).not.toBe(labels[0]);
    // Same title AND same day: numbered, in list order.
    expect(labels[2]).toBe(`${labels[1]} (2)`);
    // No title (blank counts as none) and no date: numbered too.
    expect(labels[3]).toBe('Untitled job');
    expect(labels[4]).toBe('Untitled job (2)');
    for (const label of labels) expect(label).not.toMatch(/ash_/);
  });

  it('keeps Save disabled until BOTH a job and a role are chosen', async () => {
    await openDialog();
    const save = screen.getByRole('button', { name: /Save mapping/ });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(jobSelect(), 'Customer Success Lead');
    expect(save).toBeDisabled();
    await userEvent.selectOptions(roleSelect(), SALES_ROLE);
    expect(save).toBeEnabled();
  });

  it('SENDS exactly { external_job_id, role_id, label } — no stage keys — then closes and reloads', async () => {
    await openDialog();
    await chooseAndSave('Customer Success Lead');

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
    await waitFor(() => expect(jobSelect()).toBeEnabled());
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
    createAshbyMapping.mockRejectedValue(new ApiError('conflict', 409));
    const dialog = await openDialog();
    await chooseAndSave('Customer Success Lead');

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('This Ashby job is already mapped.'),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(jobSelect().selectedOptions[0].textContent).toBe('Customer Success Lead');
    expect(roleSelect().value).toBe(SALES_ROLE);

    createAshbyMapping.mockRejectedValue(new ApiError('invalid_external_job_id', 400));
    await userEvent.click(screen.getByRole('button', { name: /Save mapping/ }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'That job could not be used. Pick it again from the list.',
      ),
    );
  });

  it('REFUSES to close while the save is in flight', async () => {
    let settle: (value: unknown) => void = () => {};
    createAshbyMapping.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const dialog = await openDialog();
    await chooseAndSave('Customer Success Lead');

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
    expect(jobSelect()).toBeDisabled();
    expect(optionTexts(jobSelect())).toEqual(['Loading jobs from Ashby…']);
    // The rows keep the names they already had.
    expect(screen.getByText('Account Executive')).toBeInTheDocument();
  });

  it('says WHY the jobs could not be listed, and "Try again" reads them again', async () => {
    for (const [err, copy] of [
      [new ApiError('integration_disabled', 503), "The Ashby integration is turned off, so jobs can't be listed."],
      [new ApiError('forbidden', 403), 'Only admins can list Ashby jobs.'],
      [new ApiError('probe_unavailable', 502), "Couldn't load jobs from Ashby."],
    ] as const) {
      listAshbyJobs.mockRejectedValue(err);
      const view = renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Add mapping' }));
      const dialog = screen.getByRole('dialog', { name: 'Add job mapping' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(copy);
      expect(jobSelect()).toBeDisabled();
      view.unmount();
    }

    listAshbyJobs.mockRejectedValue(new Error('network down'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add mapping' }));
    const dialog = screen.getByRole('dialog', { name: 'Add job mapping' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't load jobs from Ashby.");

    listAshbyJobs.mockClear();
    listAshbyJobs.mockResolvedValue(JOBS);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(jobSelect()).toBeEnabled());
    expect(listAshbyJobs).toHaveBeenCalledTimes(1);
    expect(optionTexts(jobSelect())).toContain('Customer Success Lead');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('WARNS when Ashby returned more jobs than the list can show', async () => {
    listAshbyJobs.mockResolvedValue({ ...JOBS, truncated: true });
    await openDialog();
    expect(
      screen.getByText(
        'Ashby returned more jobs than this list can show. If a job is missing, ask an engineer.',
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
    expect(await screen.findByText('There are no open jobs in Ashby right now.')).toBeInTheDocument();
    expect(jobSelect()).toBeDisabled();
  });

  it('OFFERS ONLY ACTIVE ROLES', async () => {
    // Mapping an Ashby job to a retired role produces a screening call
    // against a script nobody maintains any more.
    await openDialog();
    const labels = optionTexts(roleSelect());
    expect(labels).toContain('Sales Advisor — Sales v1 hiring');
    expect(labels).not.toContain('Retired Role');
  });

  it('SURVIVES a roles lookup failure', async () => {
    // The picker is a convenience; the mapping list and its pause/resume
    // actions are what this page is for and must not disappear with it.
    listRoles.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Account Executive')).toBeInTheDocument();
  });

  it('has no axe violations with the dialog open', async () => {
    const { container } = renderPage();
    await screen.findByText('Account Executive');
    await userEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(jobSelect()).toBeEnabled());
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
    expect(screen.getByText('drift')).toBeInTheDocument();
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
  const CONSEQUENCES =
    'It stops screening for good and disappears from this list. Candidates already screened — ' +
    'their calls, scores and history — are kept. Adding this job again later brings the ' +
    'mapping back, paused.';

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
  const deleteButton = (job: string) => within(row(job)).getByRole('button', { name: 'Delete' });

  async function openConfirm(job = 'Customer Success Lead') {
    renderPage();
    await screen.findByText(job);
    await userEvent.click(deleteButton(job));
    return screen.getByRole('dialog', { name: 'Delete this mapping?' });
  }

  it('DISABLES Delete on an enabled mapping and says why — on the page, and as its description', async () => {
    renderPage();
    await screen.findByText('Account Executive');
    const del = deleteButton('Account Executive');
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', HINT);
    // A disabled button is out of the tab order, so the tooltip alone would
    // never reach a keyboard user: the reason is visible text, tied to the
    // button for a screen reader.
    expect(del).toHaveAccessibleDescription(HINT);
    // Rendered text, not a screen-reader-only span. (`toBeVisible` cannot
    // be used here: the page's reveal motion starts at opacity 0 in jsdom.)
    const hint = within(row('Account Executive')).getByText(HINT);
    // The description must come FROM that line. Asserting the text alone
    // would pass on the `title` fallback with the link gone.
    expect(hint.id).not.toBe('');
    expect(del).toHaveAttribute('aria-describedby', hint.id);
    expect(hint).not.toHaveClass('sr-only');
    expect(hint).not.toHaveAttribute('aria-hidden');
    expect(hint).not.toHaveAttribute('hidden');
    // Only the enabled row carries it.
    expect(screen.getAllByText(HINT)).toHaveLength(1);
  });

  it('ENABLES Delete on a paused mapping and on a drifted one, as the LAST action in the row', async () => {
    renderPage();
    await screen.findByText('Customer Success Lead');
    for (const job of ['Customer Success Lead', 'Night Shift Advisor']) {
      const del = deleteButton(job);
      expect(del).toBeEnabled();
      expect(del).not.toHaveAttribute('title');
      expect(del).not.toHaveAccessibleDescription();
      expect(del).toHaveAttribute('aria-haspopup', 'dialog');
      const actions = within(row(job)).getAllByRole('button');
      expect(actions[actions.length - 1]).toBe(del);
      expect(within(row(job)).queryByText(HINT)).toBeNull();
    }
  });

  it('asks first, in a modal dialog that names the JOB — never an id', async () => {
    const dialog = await openConfirm();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The name is the dialog's description: announced with its title on open.
    expect(dialog).toHaveAccessibleDescription('Customer Success Lead');
    expect(dialog).toHaveTextContent(CONSEQUENCES);
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
    await userEvent.click(deleteButton('Ashby job (name unavailable)'));
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

  it("Cancel and Escape archive nothing, and focus returns to THAT row's Delete button", async () => {
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteButton('Customer Success Lead')).toHaveFocus();

    // Another row, closed with Escape: focus goes back to ITS button.
    await userEvent.click(deleteButton('Night Shift Advisor'));
    expect(screen.getByRole('dialog', { name: 'Delete this mapping?' })).toHaveAccessibleDescription(
      'Night Shift Advisor',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteButton('Night Shift Advisor')).toHaveFocus();

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
    // The row now tells the truth, and Pause — the advice — is live.
    expect(deleteButton('Customer Success Lead')).toBeDisabled();
    expect(within(row('Customer Success Lead')).getByRole('button', { name: 'Pause' })).toBeEnabled();
    // Its Delete is disabled and cannot take focus; the list's own control does.
    expect(screen.getByRole('button', { name: 'Add mapping' })).toHaveFocus();
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

  it('has no axe violations with the confirmation open', async () => {
    const { container } = renderPage();
    await screen.findByText('Customer Success Lead');
    await userEvent.click(deleteButton('Customer Success Lead'));
    screen.getByRole('dialog', { name: 'Delete this mapping?' });
    await expect(container).toHaveNoViolations();
  });
});
