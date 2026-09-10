/**
 * ScorebarSection — the metric-library CRUD surface in Mission Control.
 *
 * Covers the add-metric form: it validates before posting (a blank form never
 * calls the API) and, once complete, posts the exact create body (name,
 * nullable description, instruction, four-level rubric — 1 Poor, 2 Average,
 * 3 Good, 4 Excellent).
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: {
    listScorecardMetrics: vi.fn(),
    createScorecardMetric: vi.fn(),
    updateScorecardMetric: vi.fn(),
    archiveScorecardMetric: vi.fn(),
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

import { ScorebarSection } from '../ScorebarSection';

async function fillRubric(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('1 · Poor'), 'Very weak');
  await user.type(screen.getByLabelText('2 · Average'), 'Adequate');
  await user.type(screen.getByLabelText('3 · Good'), 'Strong');
  await user.type(screen.getByLabelText('4 · Excellent'), 'Outstanding');
}

describe('ScorebarSection', () => {
  beforeEach(() => {
    api.listScorecardMetrics.mockResolvedValue([]);
    api.createScorecardMetric.mockResolvedValue({
      id: 'metric-1',
      key: 'technical_depth',
      name: 'Technical depth',
      description: null,
      default_instruction: 'Assess depth.',
      rubric: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' },
      archived_at: null,
      version: 1,
    });
  });

  it('renders the add-metric form once the (empty) library loads', async () => {
    render(<ScorebarSection />);
    expect(await screen.findByText('Add a metric')).toBeInTheDocument();
    expect(screen.getByText('No scorecard metrics yet')).toBeInTheDocument();
  });

  it('validates before posting — a blank form shows an error and never calls the API', async () => {
    render(<ScorebarSection />);
    await screen.findByText('Add a metric');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create metric' }));

    expect(await screen.findByText('A metric name is required.')).toBeInTheDocument();
    expect(api.createScorecardMetric).not.toHaveBeenCalled();
  });

  it('requires all four rubric levels before posting', async () => {
    render(<ScorebarSection />);
    await screen.findByText('Add a metric');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Name'), 'Technical depth');
    await user.type(screen.getByLabelText('Scoring instruction'), 'Assess how deep the answers go.');
    // Only fill three of the four rubric levels.
    await user.type(screen.getByLabelText('1 · Poor'), 'Very weak');
    await user.type(screen.getByLabelText('2 · Average'), 'Adequate');
    await user.type(screen.getByLabelText('3 · Good'), 'Strong');

    await user.click(screen.getByRole('button', { name: 'Create metric' }));

    expect(
      await screen.findByText('Rubric level 4 (Excellent) is required.'),
    ).toBeInTheDocument();
    expect(api.createScorecardMetric).not.toHaveBeenCalled();
  });

  it('exposes exactly the four rubric levels — no fifth "Below average" field', async () => {
    render(<ScorebarSection />);
    await screen.findByText('Add a metric');

    expect(screen.getByText('Rubric — 1 (Poor) to 4 (Excellent)')).toBeInTheDocument();
    expect(screen.getByLabelText('1 · Poor')).toBeInTheDocument();
    expect(screen.getByLabelText('2 · Average')).toBeInTheDocument();
    expect(screen.getByLabelText('3 · Good')).toBeInTheDocument();
    expect(screen.getByLabelText('4 · Excellent')).toBeInTheDocument();
    expect(screen.queryByLabelText('2 · Below average')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('5 · Excellent')).not.toBeInTheDocument();
  });

  it('posts the exact create body when the form is complete', async () => {
    render(<ScorebarSection />);
    await screen.findByText('Add a metric');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Name'), 'Technical depth');
    await user.type(screen.getByLabelText('Scoring instruction'), 'Assess how deep the answers go.');
    await fillRubric(user);

    await user.click(screen.getByRole('button', { name: 'Create metric' }));

    await waitFor(() => expect(api.createScorecardMetric).toHaveBeenCalledTimes(1));
    expect(api.createScorecardMetric).toHaveBeenCalledWith({
      name: 'Technical depth',
      description: null,
      default_instruction: 'Assess how deep the answers go.',
      rubric: { 1: 'Very weak', 2: 'Adequate', 3: 'Strong', 4: 'Outstanding' },
    });
  });

  it('lists existing metrics with their key and version', async () => {
    api.listScorecardMetrics.mockResolvedValue([
      {
        id: 'm1',
        key: 'communication',
        name: 'Communication',
        description: 'How clearly they explain.',
        default_instruction: 'Judge clarity.',
        rubric: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' },
        archived_at: null,
        version: 3,
      },
    ]);
    render(<ScorebarSection />);
    expect(await screen.findByText('Communication')).toBeInTheDocument();
    expect(screen.getByText('communication · v3')).toBeInTheDocument();
    expect(screen.getByText('Judge clarity.')).toBeInTheDocument();
    // The read-only rubric on the row lists the four current levels with their
    // labels (scoped to the row — the create form below repeats them as labels).
    const row = within(document.querySelector('[data-metric-row="m1"]') as HTMLElement);
    expect(row.getByText('1 · Poor')).toBeInTheDocument();
    expect(row.getByText('2 · Average')).toBeInTheDocument();
    expect(row.getByText('3 · Good')).toBeInTheDocument();
    expect(row.getByText('4 · Excellent')).toBeInTheDocument();
    expect(screen.queryByText('5 · Excellent')).not.toBeInTheDocument();
    expect(screen.queryByText('2 · Below average')).not.toBeInTheDocument();
  });
});
