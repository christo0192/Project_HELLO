/**
 * RoleScorecardEditor — attach/tune the per-role scorecard.
 *
 * Load-bearing coverage: dragging a metric's weight slider redistributes the
 * others so the set always totals 100%, and Save posts a PUT body whose weights
 * total exactly 10000 bps with the dragged metric pinned.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: {
    getRoleScorecard: vi.fn(),
    listScorecardMetrics: vi.fn(),
    putRoleScorecard: vi.fn(),
    redistributeRoleScorecardWeights: vi.fn(),
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

import { RoleScorecardEditor } from '../RoleScorecardEditor';

const RUBRIC = { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' };

function metric(i: number, name: string, key: string, weightBps: number) {
  return {
    id: `sm-${i}`,
    libraryMetricId: `lib-${i}`,
    key,
    name,
    instruction: `Instruction ${i}`,
    rubric: RUBRIC,
    weightBps,
    displayOrder: i,
  };
}

const SCORECARD = {
  id: 'ver-1',
  roleId: 'r1',
  version: 2,
  configurationHash: 'hash',
  metrics: [
    metric(0, 'Communication', 'communication', 3334),
    metric(1, 'Motivation', 'motivation', 3333),
    metric(2, 'Culture', 'culture', 3333),
  ],
};

describe('RoleScorecardEditor', () => {
  beforeEach(() => {
    api.getRoleScorecard.mockResolvedValue({ scorecard: SCORECARD });
    api.listScorecardMetrics.mockResolvedValue([]);
    api.putRoleScorecard.mockResolvedValue({ scorecard: SCORECARD });
  });

  it('loads the active scorecard and shows weights totalling 100%', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    expect(await screen.findByText('Communication')).toBeInTheDocument();
    expect(screen.getByText('Motivation')).toBeInTheDocument();
    expect(screen.getByText('Culture')).toBeInTheDocument();
    expect(screen.getByText('Total 100%')).toBeInTheDocument();
  });

  it('redistributes to a 100% total when a weight slider moves', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const slider = screen.getByLabelText('Weight for Communication');
    fireEvent.change(slider, { target: { value: '50' } });

    // Communication pinned to 50%, the other two split the remaining 50% evenly.
    expect(await screen.findByText('50%')).toBeInTheDocument();
    expect(screen.getAllByText('25%')).toHaveLength(2);
    // The running total stays exactly 100%.
    expect(screen.getByText('Total 100%')).toBeInTheDocument();
  });

  it('saves a PUT whose weights total 10000 bps with the dragged metric pinned', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));

    await waitFor(() => expect(api.putRoleScorecard).toHaveBeenCalledTimes(1));
    const [roleId, body] = api.putRoleScorecard.mock.calls[0];
    expect(roleId).toBe('r1');
    const total = body.metrics.reduce((s: number, m: { weightBps: number }) => s + m.weightBps, 0);
    expect(total).toBe(10000);
    expect(body.metrics).toHaveLength(3);
    const communication = body.metrics.find(
      (m: { libraryMetricId: string }) => m.libraryMetricId === 'lib-0',
    );
    expect(communication.weightBps).toBe(5000);
    // Each attached metric carries its library reference and per-role instruction.
    for (const m of body.metrics) {
      expect(m.libraryMetricId).toMatch(/^lib-/);
      expect(typeof m.weightBps).toBe('number');
    }
  });

  it('reorders metrics with the move controls', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    // Move Motivation (index 1) up → it becomes first.
    fireEvent.click(screen.getByRole('button', { name: 'Move Motivation up' }));
    await waitFor(() => {
      const order = [...document.querySelectorAll('[data-metric-row] .text-sm.font-medium')].map(
        (el) => el.textContent,
      );
      expect(order[0]).toBe('Motivation');
    });
  });

  it('shows the legacy-fallback note when the role has no scorecard', async () => {
    api.getRoleScorecard.mockResolvedValue({ scorecard: null });
    render(<RoleScorecardEditor roleId="r1" />);
    expect(
      await screen.findByText(/This role uses the legacy scoring until a scorecard is saved\./),
    ).toBeInTheDocument();
  });
});
