/**
 * FunnelSection — the Mission Control funnel observability surface (PR2).
 * Covers: it renders the stage table + failure taxonomy from the summary and
 * failures endpoints; shows a truthful empty state when the rollup is empty;
 * and "Recompute" triggers the refresh RPC then reloads.
 */

import { render, screen, waitFor } from '@testing-library/react';
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
  },
  conversions: {
    parse_to_dial: 0.75, dial_to_connect: 0.6667, connect_to_consent: 0.75,
    consent_to_answered: 1, answered_to_scored: 0.6667, scored_to_qualified: 0.5, qualified_to_reference_check: 1,
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

  it('warns that failure counts are a lower bound when the window is truncated', async () => {
    api.listFunnelFailures.mockResolvedValue({ ...FAILURES, truncated: true });
    render(<FunnelSection />);
    expect(await screen.findByText(/counts are a lower bound/i)).toBeInTheDocument();
  });
});
