/**
 * QuotasSection — abstract quota policy configuration.
 * Covers: scope clarity, create/update/toggle with explicit confirmation,
 * abstract-units-only (never currency/price), stable failure copy, axe.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { QuotasSection } from '../QuotasSection';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const POLICIES = [
  { id: 'p1', scope: 'global' as const, scope_id: null, mode: 'simulation' as const, max_sessions: 10, max_cost_units: null, cost_units_per_session: 5, warning_percentage: null, period_days: 1, enabled: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'p2', scope: 'candidate' as const, scope_id: 'cand-1234-5678-9abc-def0', mode: 'live' as const, max_sessions: 3, max_cost_units: 1000, cost_units_per_session: 8, warning_percentage: 80, period_days: 7, enabled: true, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
];

function renderQuotas() {
  return render(<QuotasSection />);
}

describe('QuotasSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.listAdminQuotas.mockResolvedValue({ policies: POLICIES });
    apiFns.createQuotaPolicy.mockResolvedValue({ ok: true, id: 'p-new', created: true });
    apiFns.updateQuotaPolicy.mockResolvedValue({ ok: true, id: 'p1' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state until policies resolve', () => {
    apiFns.listAdminQuotas.mockReturnValue(new Promise(() => {}));
    renderQuotas();
    expect(screen.getByText('Loading quota policies…')).toBeInTheDocument();
  });

  it('renders scope clarity, limits and state — never currency/price', async () => {
    renderQuotas();
    await screen.findByText('Quota policies');

    const globalRow = screen.getByText('Global').closest('tr') as HTMLElement;
    expect(within(globalRow).getByText(/max sessions 10/)).toBeInTheDocument();
    expect(within(globalRow).getByText('disabled')).toBeInTheDocument();

    const candidateRow = screen.getByText('Candidate').closest('tr') as HTMLElement;
    expect(within(candidateRow).getAllByText(/cand-1234-567/).length).toBeGreaterThan(0);
    expect(within(candidateRow).getByText('enabled')).toBeInTheDocument();

    // No currency/price anywhere.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/usd|eur|inr/i)).not.toBeInTheDocument();
    // The section explicitly states the abstraction.
    expect(screen.getByText(/Abstract cost units only/)).toBeInTheDocument();
  });

  it('creates a policy after explicit confirmation with exact scope in the summary', async () => {
    renderQuotas();
    await screen.findByRole('heading', { name: 'Create policy' });

    await userEvent.type(screen.getByLabelText('Max sessions (blank = unlimited)'), '50');
    await userEvent.type(screen.getByLabelText('Max cost units (abstract)'), '1000');
    await userEvent.type(screen.getByLabelText('Cost units per session (abstract)'), '8');
    await userEvent.type(screen.getByLabelText('Warning % (blank = off)'), '80');
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));

    // Confirmation shows the exact scope + limits before anything is sent.
    expect(
      screen.getByText(/with max sessions 50, max cost units 1000/i),
    ).toBeInTheDocument();
    expect(apiFns.createQuotaPolicy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm create' }));
    await waitFor(() => {
      expect(apiFns.createQuotaPolicy).toHaveBeenCalledWith({
        scope: 'global',
        scope_id: null,
        max_sessions: 50,
        max_cost_units: 1000,
        cost_units_per_session: 8,
        warning_percentage: 80,
        enabled: false,
      });
    });
    expect(await screen.findByText(/Quota policy created/)).toBeInTheDocument();
    // Never price/currency keys.
    expect(apiFns.createQuotaPolicy.mock.calls[0][0]).not.toHaveProperty('price');
    expect(apiFns.createQuotaPolicy.mock.calls[0][0]).not.toHaveProperty('currency');
  });

  it('toggles a policy state only after confirmation', async () => {
    renderQuotas();
    await screen.findByText('Quota policies');

    const enableBtn = screen.getByRole('button', { name: 'Enable' });
    fireEvent.click(enableBtn);
    expect(screen.getByRole('button', { name: 'Confirm enable' })).toBeInTheDocument();
    expect(apiFns.updateQuotaPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm enable' }));
    await waitFor(() => {
      expect(apiFns.updateQuotaPolicy).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ enabled: true, scope: 'global' }),
      );
    });
    expect(await screen.findByText('Policy enabled.')).toBeInTheDocument();
  });

  it('edits a policy with confirmation and keeps scope read-only', async () => {
    renderQuotas();
    await screen.findByText('Quota policies');

    const globalRow = screen.getByText('Global').closest('tr') as HTMLElement;
    fireEvent.click(within(globalRow).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(globalRow).getByLabelText(/Max sessions for p1/));
    await userEvent.type(within(globalRow).getByLabelText(/Max sessions for p1/), '25');

    fireEvent.click(within(globalRow).getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('button', { name: 'Confirm update' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm update' }));
    await waitFor(() => {
      expect(apiFns.updateQuotaPolicy).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ scope: 'global', scope_id: null, max_sessions: 25 }),
      );
    });
    expect(await screen.findByText('Quota policy updated.')).toBeInTheDocument();
  });

  it('maps a stable failure code to operator copy', async () => {
    apiFns.createQuotaPolicy.mockRejectedValue(
      new missionApi.ApiError('invalid_role', 400),
    );
    renderQuotas();
    await screen.findByRole('heading', { name: 'Create policy' });
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm create' }));
    expect(
      await screen.findByText("That role isn't supported here."),
    ).toBeInTheDocument();
  });

  it('shows a truthful empty state when no policies exist', async () => {
    apiFns.listAdminQuotas.mockResolvedValue({ policies: [] });
    renderQuotas();
    expect(await screen.findByText('No quota policies configured')).toBeInTheDocument();
    expect(screen.getByText(/Quota enforcement is off/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderQuotas();
    await screen.findByText('Quota policies');
    await expect(container).toHaveNoViolations();
  });
});
