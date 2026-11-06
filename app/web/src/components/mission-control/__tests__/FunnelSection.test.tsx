/**
 * FunnelSection — the Mission Control funnel observability surface (PR2).
 * Covers: it renders the stage table + failure taxonomy from the summary and
 * failures endpoints; shows a truthful empty state when the rollup is empty;
 * and "Recompute" triggers the refresh RPC then reloads.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FunnelSummaryResponse, FunnelFailuresResponse } from '../../../types';

const { api } = vi.hoisted(() => ({
  api: {
    getFunnelSummary: vi.fn(),
    listFunnelFailures: vi.fn(),
    refreshFunnel: vi.fn(),
  },
}));

vi.mock('../../../api', () => ({
  api,
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

import { FunnelSection } from '../FunnelSection';

const SUMMARY: FunnelSummaryResponse = {
  range: { from: '2026-09-01', to: '2026-09-09' },
  totals: {
    entered_parse: 10, parsed_ok: 8, needs_review: 1, parse_failed: 1,
    dialed: 6, connected: 4, consent_passed: 3, consent_dropped: 1, answered_ge1: 3,
    scored: 2, qualified: 1, on_hold: 1, disqualified: 0, human_review: 0, reached_reference_check: 1,
    attempts_total: 9, connects_total: 4, total_call_seconds: 600,
    // 0098. `hr_tracking_configured` is false for this fixture's tenant, so the
    // HR states are all `unknown` — which is what every tenant reads today.
    hr_qualified: 0, hr_disqualified: 0, hr_awaiting: 0, hr_unknown: 2,
    candidates_total: 10,
  },
  conversions: {
    parse_to_dial: 0.75, dial_to_connect: 0.6667, connect_to_consent: 0.75,
    consent_to_answered: 1, answered_to_scored: 0.6667, scored_to_qualified: 0.5, qualified_to_reference_check: 1,
    // Null, not 0: nothing has been decided, and a 0% advance rate would be a
    // lie of arithmetic.
    hr_advance_rate: null,
  },
  series: [{ cohort_day: '2026-09-01', role_id: 'r1', median_ttfc_sec: 12, p95_ttfc_sec: 30,
    entered_parse: 10, parsed_ok: 8, needs_review: 1, parse_failed: 1, dialed: 6, connected: 4,
    consent_passed: 3, consent_dropped: 1, answered_ge1: 3, scored: 2, qualified: 1, on_hold: 1,
    disqualified: 0, human_review: 0, reached_reference_check: 1, attempts_total: 9, connects_total: 4, total_call_seconds: 600 }],
  refreshed_at: '2026-09-09T10:00:00Z',
};

const FAILURES: FunnelFailuresResponse = {
  groups: [{ stage: 'resume_parse', code: 'parse_bad_output', count: 2 }],
  recent: [{ stage: 'resume_parse', code: 'parse_bad_output', entity_id: 'a', occurred_at: '2026-09-02T00:00:00Z' }],
  truncated: false,
  range: { from: '2026-08-11', to: '2026-09-09' },
};

const EMPTY_SUMMARY: FunnelSummaryResponse = {
  ...SUMMARY,
  totals: { ...SUMMARY.totals, entered_parse: 0 },
  series: [],
  refreshed_at: null,
};

describe('FunnelSection', () => {
  beforeEach(() => {
    api.getFunnelSummary.mockReset();
    api.listFunnelFailures.mockReset();
    api.refreshFunnel.mockReset();
    api.getFunnelSummary.mockResolvedValue(SUMMARY);
    api.listFunnelFailures.mockResolvedValue(FAILURES);
    api.refreshFunnel.mockResolvedValue({ ok: true, result: { status: 'ok', rows: 1 } });
  });

  it('renders the funnel stages and failure taxonomy from the endpoints', async () => {
    render(<FunnelSection />);
    expect(await screen.findByText('Entered parser')).toBeInTheDocument();
    expect(screen.getByText('Reached reference check')).toBeInTheDocument();
    // step conversions render (parse_to_dial and connect_to_consent are both 75%)
    expect(screen.getAllByText('75%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Failures by stage')).toBeInTheDocument();
    expect(screen.getByText('parse_bad_output')).toBeInTheDocument();
  });

  it('asks for a second look at a low conversion: crimson is a fault, and this is not one', async () => {
    api.getFunnelSummary.mockResolvedValue({
      ...SUMMARY,
      conversions: { ...SUMMARY.conversions, parse_to_dial: 0.1, dial_to_connect: 0.5, connect_to_consent: 0.9, scored_to_qualified: 0.7 },
    });
    render(<FunnelSection />);
    const badge = async (figure: string) => (await screen.findByText(figure)).closest('[data-status-badge]');
    expect(await badge('10%')).toHaveAttribute('data-status-badge', 'warning');
    expect(await badge('50%')).toHaveAttribute('data-status-badge', 'neutral');
    expect(await badge('90%')).toHaveAttribute('data-status-badge', 'success');
  });

  it('prints a drop bucket by its meaning only above zero, and a plain total in ink', async () => {
    api.getFunnelSummary.mockResolvedValue({
      ...SUMMARY,
      totals: {
        ...SUMMARY.totals,
        needs_review: 11, parse_failed: 12, consent_dropped: 13, disqualified: 14, on_hold: 15, human_review: 0,
      },
    });
    render(<FunnelSection />);
    const figure = async (label: string) => (await screen.findByText(label)).parentElement!.querySelector('p:last-child');
    expect(await figure('Needs manual review')).toHaveClass('text-warning-text');
    expect(await figure('Parse failed')).toHaveClass('text-warning-text');
    expect(await figure('Dropped at consent')).toHaveClass('text-closed-text');
    expect(await figure('Disqualified')).toHaveClass('text-closed-text');
    expect(await figure('Borderline')).toHaveClass('text-warning-text');
    expect(await figure('Human review')).toHaveClass('text-ink');
    expect(await figure('Attempts')).toHaveClass('text-ink');
  });

  it('words the on_hold drop bucket as Borderline', async () => {
    render(<FunnelSection />);
    expect(await screen.findByText('Borderline')).toBeInTheDocument();
    expect(screen.queryByText('On hold')).not.toBeInTheDocument();
  });

  describe('the reference check, which is HR tracking', () => {
    const META = {
      schema_current: true,
      rollup_refreshed_at: '2026-09-09T10:00:00Z',
      rollup_freshness_known: true,
      refresh_window_days: 30,
    };
    const stepRow = async () =>
      (await screen.findByText('Reached reference check')).closest('tr') as HTMLElement;

    it('reads as not tracked until HR tracking is on, never as a 0 or a red 0%', async () => {
      api.getFunnelSummary.mockResolvedValue({
        ...SUMMARY,
        meta: { ...META, hr_tracking_configured: false },
        totals: { ...SUMMARY.totals, reached_reference_check: 0 },
        conversions: { ...SUMMARY.conversions, qualified_to_reference_check: 0 },
      });
      render(<FunnelSection />);
      const row = within(await stepRow());
      expect(row.getByText('—')).toBeInTheDocument();
      expect(row.getByText('Not tracked yet')).toBeInTheDocument();
      expect(row.queryByText('0')).not.toBeInTheDocument();
      expect(row.queryByText('0%')).not.toBeInTheDocument();
    });

    it('shows the real step once HR tracking is on', async () => {
      api.getFunnelSummary.mockResolvedValue({ ...SUMMARY, meta: { ...META, hr_tracking_configured: true } });
      render(<FunnelSection />);
      const row = within(await stepRow());
      expect(row.getByText('1')).toBeInTheDocument();
      expect(row.getByText('100%')).toBeInTheDocument();
      expect(row.queryByText('Not tracked yet')).not.toBeInTheDocument();
    });
  });

  it('shows a truthful empty state when the rollup has no data', async () => {
    api.getFunnelSummary.mockResolvedValue(EMPTY_SUMMARY);
    render(<FunnelSection />);
    expect(await screen.findByText('No funnel data yet')).toBeInTheDocument();
  });

  it('Recompute triggers the refresh RPC then reloads', async () => {
    render(<FunnelSection />);
    await screen.findByText('Entered parser');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Recompute' }));

    await waitFor(() => expect(api.refreshFunnel).toHaveBeenCalledWith(30));
    // reload re-fetches the summary (initial load + post-recompute reload)
    await waitFor(() => expect(api.getFunnelSummary).toHaveBeenCalledTimes(2));
  });

  it('prints a failed Recompute in crimson: it is a fault on our side', async () => {
    api.refreshFunnel.mockRejectedValue(new Error('rollup is busy'));
    render(<FunnelSection />);
    await screen.findByText('Entered parser');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recompute' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Recompute failed:/);
    expect(alert).toHaveClass('text-error-text');
  });

  it('warns that failure counts are a lower bound when the window is truncated', async () => {
    api.listFunnelFailures.mockResolvedValue({ ...FAILURES, truncated: true });
    render(<FunnelSection />);
    expect(await screen.findByText(/counts are a lower bound/i)).toBeInTheDocument();
  });
});
