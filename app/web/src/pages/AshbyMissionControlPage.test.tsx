import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyMissionControlPage } from './AshbyMissionControlPage';

const { listAshbyMappings, listAshbyWorkflows, pauseAshbyMapping, resumeAshbyMapping, cancelAshbyWorkflow, retryAshbyOperation, deliverAshbyManualInvite } = vi.hoisted(() => ({
  listAshbyMappings: vi.fn(),
  listAshbyWorkflows: vi.fn(),
  pauseAshbyMapping: vi.fn(),
  resumeAshbyMapping: vi.fn(),
  cancelAshbyWorkflow: vi.fn(),
  retryAshbyOperation: vi.fn(),
  deliverAshbyManualInvite: vi.fn(),
}));

vi.mock('../api', () => ({
  api: { listAshbyMappings, listAshbyWorkflows, pauseAshbyMapping, resumeAshbyMapping, cancelAshbyWorkflow, retryAshbyOperation, deliverAshbyManualInvite },
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
    render(<AshbyMissionControlPage />);
    expect(await screen.findByText('job_1')).toBeInTheDocument();
    expect(screen.getByText('drift')).toBeInTheDocument();
    expect(screen.getByText('app_1')).toBeInTheDocument();
    expect(screen.getByText(/ingest: failed_review/)).toBeInTheDocument();
    // No candidate PII / token / URL leaks in the rendered surface.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\S+@\S+\.\S+/); // no email
    expect(text).not.toMatch(/bearer|presigned|invite_token|resume_url|https?:\/\//i);
  });

  it('pauses an enabled mapping and reloads', async () => {
    render(<AshbyMissionControlPage />);
    await screen.findByText('job_1');
    const pauseButtons = screen.getAllByRole('button', { name: 'Pause' });
    await userEvent.click(pauseButtons[0]); // job_1 is enabled → pausable
    await waitFor(() => expect(pauseAshbyMapping).toHaveBeenCalledWith('m1'));
    expect(listAshbyMappings).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('cancels a non-terminal workflow and retries a failed operation', async () => {
    render(<AshbyMissionControlPage />);
    await screen.findByText('app_1');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelAshbyWorkflow).toHaveBeenCalledWith('l1', 'manual_stage_cancel'));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryAshbyOperation).toHaveBeenCalledWith('op1'));
  });

  it('surfaces a load error', async () => {
    listAshbyMappings.mockRejectedValue({ message: 'boom' });
    render(<AshbyMissionControlPage />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<AshbyMissionControlPage />);
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
    render(<AshbyMissionControlPage />);
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
    render(<AshbyMissionControlPage />);
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
    render(<AshbyMissionControlPage />);
    await userEvent.click(await screen.findByRole('button', { name: /get invite link/i }));
    await screen.findByLabelText(/candidate link/i);
    await userEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0][0])).toContain('/candidate/join#');
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('shows a truthful error and NO link when the server refuses', async () => {
    deliverAshbyManualInvite.mockResolvedValue({ ok: false, error: 'blocked_terminal' });
    render(<AshbyMissionControlPage />);
    await userEvent.click(await screen.findByRole('button', { name: /get invite link/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked_terminal/i);
    expect(screen.queryByLabelText(/candidate link/i)).toBeNull();
  });

  it('shows a truthful error when the request throws', async () => {
    deliverAshbyManualInvite.mockRejectedValue(new Error('network down'));
    render(<AshbyMissionControlPage />);
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
    render(<AshbyMissionControlPage />);
    expect(await screen.findByRole('button', { name: /reissue invite link/i })).toBeInTheDocument();
  });

  it('flags a completed screening whose writeback park did not land', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'ready', sessionStatus: 'completed' }],
    });
    render(<AshbyMissionControlPage />);
    // The completion observer is best-effort by design; this badge is what
    // makes a park that never landed visible instead of log-only.
    expect(await screen.findByText(/screened: not parked/i)).toBeInTheDocument();
  });

  it('does not flag a screening that parked correctly', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'writeback_pending', sessionStatus: 'completed' }],
    });
    render(<AshbyMissionControlPage />);
    expect(await screen.findByText('app_1')).toBeInTheDocument();
    expect(screen.queryByText(/screened: not parked/i)).toBeNull();
  });

  it('does not flag a terminal application', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], lifecycle: 'ready', sessionStatus: 'completed', terminalState: 'withdrawn' }],
    });
    render(<AshbyMissionControlPage />);
    expect(await screen.findByText('app_1')).toBeInTheDocument();
    expect(screen.queryByText(/screened: not parked/i)).toBeNull();
  });

  it('disables delivery for a terminal application', async () => {
    listAshbyWorkflows.mockResolvedValue({
      ok: true,
      workflows: [{ ...WORKFLOWS.workflows[0], terminalState: 'withdrawn' }],
    });
    render(<AshbyMissionControlPage />);
    const button = await screen.findByRole('button', { name: /get invite link/i });
    expect(button).toBeDisabled();
    expect(deliverAshbyManualInvite).not.toHaveBeenCalled();
  });
});
