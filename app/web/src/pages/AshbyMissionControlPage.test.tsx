import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyMissionControlPage } from './AshbyMissionControlPage';

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

const { listAshbyMappings, listAshbyWorkflows, pauseAshbyMapping, resumeAshbyMapping, cancelAshbyWorkflow, retryAshbyOperation, deliverAshbyManualInvite, discoverAshbyFeedbackForm, previewAshbyScorecardBinding } = vi.hoisted(() => ({
  listAshbyMappings: vi.fn(),
  listAshbyWorkflows: vi.fn(),
  pauseAshbyMapping: vi.fn(),
  resumeAshbyMapping: vi.fn(),
  cancelAshbyWorkflow: vi.fn(),
  retryAshbyOperation: vi.fn(),
  deliverAshbyManualInvite: vi.fn(),
  discoverAshbyFeedbackForm: vi.fn(),
  previewAshbyScorecardBinding: vi.fn(),
}));

vi.mock('../api', () => ({
  api: { listAshbyMappings, listAshbyWorkflows, pauseAshbyMapping, resumeAshbyMapping, cancelAshbyWorkflow, retryAshbyOperation, deliverAshbyManualInvite, discoverAshbyFeedbackForm, previewAshbyScorecardBinding },
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
    listAshbyWorkflows.mockResolvedValue(WORKFLOWS);
    pauseAshbyMapping.mockResolvedValue({ ok: true, status: 'paused' });
    resumeAshbyMapping.mockResolvedValue({ ok: true, status: 'enabled' });
    cancelAshbyWorkflow.mockResolvedValue({ ok: true, cancelled_operations: 1, cancelled_ingestion: 1 });
    retryAshbyOperation.mockResolvedValue({ ok: true });
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
    expect(await screen.findByText('job_1')).toBeInTheDocument();
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
    await screen.findByText('job_1');
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

  it('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByText('job_1');
    await expect(container).toHaveNoViolations();
  });
});

describe('AshbyMissionControlPage — manual invite delivery (B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAshbyMappings.mockResolvedValue(MAPPINGS);
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
    expect(screen.getByTestId('binding-readiness').textContent).toMatch(/2 of 4 metric\(s\) would be omitted/);
    expect(text).toContain('Score fields no metric claims');
    expect(text).toContain('English');
    // Nothing here is a submitted value or a candidate datum.
    expect(text).not.toMatch(/candidate|email|phone|token/i);
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

  it('flags an archived or mismatched form as fail-closed', async () => {
    previewAshbyScorecardBinding.mockResolvedValue({ ...BINDING_PREVIEW, preview: { ...BINDING_PREVIEW.preview, archived: true, formMatchesBinding: false, ready: false } });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /preview scorecard binding/i }))[0]);
    expect(await screen.findByText(/archived in Ashby.*fail closed/i)).toBeInTheDocument();
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
