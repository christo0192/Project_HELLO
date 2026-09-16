/**
 * ScreeningKpis — the rules that make this block safe to put in front of an
 * HR head who cannot audit the SQL behind it.
 *
 * These tests deliberately assert on MEANING, not markup: that a backlog is
 * never counted as a rejection, that a rate with no denominator reads as
 * unknown rather than zero, and that changing the range actually changes the
 * window requested. Those are the three ways this panel could quietly lie.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../../lib/theme';
import { ScreeningKpis } from './ScreeningKpis';
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../design/__tests__/helpers';

const { getScreeningFunnel, listRoles } = vi.hoisted(() => ({
  getScreeningFunnel: vi.fn(),
  listRoles: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    getScreeningFunnel: (...args: any[]) => getScreeningFunnel(...args),
    listRoles: (...args: any[]) => listRoles(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

function funnel(overrides: Partial<Record<string, number>> = {}, series: any[] = []) {
  const totals: Record<string, number> = {
    entered_parse: 0, parsed_ok: 0, needs_review: 0, parse_failed: 0,
    dialed: 0, connected: 0, consent_passed: 0, consent_dropped: 0, answered_ge1: 0,
    scored: 0, qualified: 0, on_hold: 0, disqualified: 0, human_review: 0,
    reached_reference_check: 0, attempts_total: 0, connects_total: 0,
    total_call_seconds: 0, hr_qualified: 0, hr_disqualified: 0, hr_awaiting: 0,
    candidates_total: 0,
    ...overrides,
  };
  return {
    range: { from: '2026-08-18', to: '2026-09-16' },
    totals,
    conversions: {
      parse_to_dial: null, dial_to_connect: null, connect_to_consent: null,
      consent_to_answered: null, answered_to_scored: null, scored_to_qualified: null,
      qualified_to_reference_check: null,
      hr_qualified_rate:
        totals.hr_qualified + totals.hr_disqualified > 0
          ? totals.hr_qualified / (totals.hr_qualified + totals.hr_disqualified)
          : null,
    },
    series,
    refreshed_at: null,
  };
}

/**
 * Text of the KPI CARD with this label. The explanation list deliberately
 * reuses the same wording, so a bare text query matches twice — scope to the
 * node that is not inside the <details> block.
 */
async function cardText(label: string): Promise<string> {
  await screen.findAllByText(label);
  const node = screen.getAllByText(label).find((n) => !n.closest('details'));
  if (!node) throw new Error(`no KPI card labelled "${label}"`);
  return node.closest('div')?.parentElement?.textContent ?? '';
}

function renderKpis() {
  return render(
    <ThemeProvider>
      <ScreeningKpis />
    </ThemeProvider>,
  );
}

describe('ScreeningKpis', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    allowEchartsInitWarnings();
    vi.clearAllMocks();
    listRoles.mockResolvedValue([]);
    getScreeningFunnel.mockResolvedValue(funnel());
  });

  it('never counts an untouched candidate as an HR rejection', async () => {
    // 10 screened: 2 advanced by HR, 1 rejected by HR, 7 not looked at yet.
    // The whole point of `hr_awaiting`: the 7 must NOT inflate "HR
    // disqualified", or the rejection rate rises whenever screening speeds up.
    getScreeningFunnel.mockResolvedValue(
      funnel({ scored: 10, hr_qualified: 2, hr_disqualified: 1, hr_awaiting: 7 }),
    );
    renderKpis();

    const card = await cardText('HR disqualified');
    expect(card).toContain('1');
    expect(card).not.toContain('8');

    // The backlog is stated, in words, near the pair it would otherwise skew.
    expect(
      await screen.findByText(/7 screened candidates are still waiting/i),
    ).toBeInTheDocument();
  });

  it('shows a rate with no denominator as unknown, not as zero', async () => {
    // Nobody dialled yet. "0%" would read as "we called and nobody picked up".
    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 5, dialed: 0, connected: 0 }));
    renderKpis();

    const card = await cardText('Connect rate');
    expect(card).toContain('—');
    expect(card).not.toContain('0%');
  });

  it('computes team agreement over decided candidates only', async () => {
    // 3 decided (2 advanced, 1 rejected) with 20 still waiting. Agreement is
    // 2/3 = 67%, NOT 2/23 = 9% — an untouched backlog must not drag it down.
    getScreeningFunnel.mockResolvedValue(
      funnel({ hr_qualified: 2, hr_disqualified: 1, hr_awaiting: 20 }),
    );
    renderKpis();

    const card = await cardText('Team agreement');
    expect(card).toContain('67%');
  });

  it('separates connected-but-silent from never-connected', async () => {
    // 10 dialled, 6 reached, 4 of those gave an answer.
    getScreeningFunnel.mockResolvedValue(
      funnel({ dialed: 10, connected: 6, answered_ge1: 4 }),
    );
    renderKpis();

    expect(await cardText('Connected, no answers')).toContain('2'); // 6 − 4
    expect(await cardText('Never connected')).toContain('4');       // 10 − 6
  });

  it('surfaces hold and no-recommendation as one reviewable bucket', async () => {
    // Without this card, qualified + disqualified would not reconcile against
    // `scored` and these candidates would simply never be chased.
    getScreeningFunnel.mockResolvedValue(
      funnel({ scored: 10, qualified: 4, disqualified: 3, on_hold: 2, human_review: 1 }),
    );
    renderKpis();

    expect(await cardText('Needs review')).toContain('3'); // 2 hold + 1 no rec
  });

  it('requests a different window when the range changes', async () => {
    renderKpis();
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalled());
    const firstFrom = getScreeningFunnel.mock.calls[0][0].from as string;

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalledTimes(2));
    const secondFrom = getScreeningFunnel.mock.calls[1][0].from as string;
    // A shorter window starts later. If the control did nothing, these match.
    expect(secondFrom > firstFrom).toBe(true);
  });

  it('explains every metric on the page, not in a wiki', async () => {
    renderKpis();
    expect(await screen.findByText(/How these numbers are calculated/i)).toBeInTheDocument();
    // The definition that is easiest to misread is the one most worth stating.
    expect(
      screen.getByText(/rejection rate would climb every time screening got faster/i),
    ).toBeInTheDocument();
  });

  it('degrades to a retryable error instead of a blank panel', async () => {
    getScreeningFunnel.mockRejectedValue(new Error('boom'));
    renderKpis();
    expect(await screen.findByText(/Screening metrics unavailable/i)).toBeInTheDocument();

    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 3 }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect((await screen.findAllByText('Total candidates')).length).toBeGreaterThan(0);
  });
});
