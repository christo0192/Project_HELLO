/**
 * ScorebarSection — the metric-library CRUD surface.
 *
 * Covers the add-metric form: it validates before posting (a blank form never
 * calls the API), shows each problem ON the field it concerns and moves focus
 * there, and, once complete, posts the exact create body (name, nullable
 * description, instruction, four-level rubric — 1 Poor, 2 Average, 3 Good,
 * 4 Excellent). And the library list: one row per metric that opens to its
 * instruction and its rubric scale.
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
    draftMetricRubric: vi.fn(),
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

const COMMUNICATION = {
  id: 'm1',
  key: 'communication',
  name: 'Communication',
  description: 'How clearly they explain.',
  default_instruction: 'Judge clarity.',
  rubric: { 1: 'Rambling', 2: 'Mostly clear', 3: 'Clear', 4: 'Crisp and structured' },
  archived_at: null,
  version: 3,
};

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New metric' }));
  return screen.getByRole('region', { name: 'Add a metric' });
}

async function fillRubric(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('1 Poor'), 'Very weak');
  await user.type(screen.getByLabelText('2 Average'), 'Adequate');
  await user.type(screen.getByLabelText('3 Good'), 'Strong');
  await user.type(screen.getByLabelText('4 Excellent'), 'Outstanding');
}

describe('ScorebarSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows the empty library, with the create form closed until asked for', async () => {
    render(<ScorebarSection />);
    expect(await screen.findByText('No scorecard metrics yet')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'New metric' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Add a metric' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Add a metric' })).toBeInTheDocument();
  });

  it('validates before posting — the problem is shown ON its field, which gets focus', async () => {
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await openCreate(user);

    await user.click(screen.getByRole('button', { name: 'Create metric' }));

    expect(await screen.findByText('A metric name is required.')).toBeInTheDocument();
    const name = screen.getByLabelText('Name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('A metric name is required.');
    expect(name).toHaveFocus();
    expect(api.createScorecardMetric).not.toHaveBeenCalled();
  });

  it('requires all four rubric levels — the missing level is flagged and focused', async () => {
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await openCreate(user);

    await user.type(screen.getByLabelText('Name'), 'Technical depth');
    await user.type(screen.getByLabelText('Scoring instruction'), 'Assess how deep the answers go.');
    // Only fill three of the four rubric levels.
    await user.type(screen.getByLabelText('1 Poor'), 'Very weak');
    await user.type(screen.getByLabelText('2 Average'), 'Adequate');
    await user.type(screen.getByLabelText('3 Good'), 'Strong');

    await user.click(screen.getByRole('button', { name: 'Create metric' }));

    expect(
      await screen.findByText('Rubric level 4 (Excellent) is required.'),
    ).toBeInTheDocument();
    const excellent = screen.getByLabelText('4 Excellent');
    expect(excellent).toHaveAttribute('aria-invalid', 'true');
    expect(excellent).toHaveFocus();
    expect(api.createScorecardMetric).not.toHaveBeenCalled();
  });

  it('exposes exactly the four rubric levels — no fifth "Below average" field', async () => {
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await openCreate(user);

    expect(screen.getByRole('group', { name: 'Rubric' })).toBeInTheDocument();
    expect(screen.getByLabelText('1 Poor')).toBeInTheDocument();
    expect(screen.getByLabelText('2 Average')).toBeInTheDocument();
    expect(screen.getByLabelText('3 Good')).toBeInTheDocument();
    expect(screen.getByLabelText('4 Excellent')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Below average/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('5 Excellent')).not.toBeInTheDocument();
  });

  it('posts the exact create body when the form is complete, then closes the form', async () => {
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await openCreate(user);

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
    expect(await screen.findByText('Metric “Technical depth” created.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Add a metric' })).not.toBeInTheDocument();
  });

  it('lists each metric as a closed row — named "name vN", described by its description — that opens to its details', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    render(<ScorebarSection />);
    // The accessible NAME is just name + version; the description describes.
    const header = await screen.findByRole('button', { name: 'Communication v3' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveAccessibleDescription('How clearly they explain.');
    // Closed: the long text is not on the page yet.
    expect(screen.queryByText('Judge clarity.')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: 'Communication v3' });
    expect(within(details).getByText('Judge clarity.')).toBeInTheDocument();
    // The internal key is not HR-facing and is not shown.
    expect(screen.queryByText('communication')).not.toBeInTheDocument();
  });

  it('puts focus somewhere deliberate after each action — never <body>', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    render(<ScorebarSection />);
    const user = userEvent.setup();
    const header = await screen.findByRole('button', { name: 'Communication v3' });
    await user.click(header);

    // Edit → the name field.
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const details = screen.getByRole('region', { name: 'Communication v3' });
    await waitFor(() => expect(within(details).getByLabelText('Name')).toHaveFocus());
    // Cancel edit → back on the row it belongs to.
    await user.click(within(details).getByRole('button', { name: 'Cancel edit' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Communication v3' })).toHaveFocus());

    // New metric → its name field; Cancel → back on "New metric".
    await user.click(screen.getByRole('button', { name: 'New metric' }));
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Add a metric' })).getByLabelText('Name')).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'New metric' })).toHaveFocus());
  });

  it('shows EVERY problem at once and focuses the first', async () => {
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await openCreate(user);
    await user.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('A metric name is required.')).toBeInTheDocument();
    expect(screen.getByText('A scoring instruction is required.')).toBeInTheDocument();
    expect(screen.getByText('Rubric level 1 (Poor) is required.')).toBeInTheDocument();
    expect(screen.getByText('Rubric level 4 (Excellent) is required.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('keeps the list mounted on a reload — no loader swap', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    api.archiveScorecardMetric.mockResolvedValue(undefined);
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Communication v3' }));
    let release: (v: unknown) => void = () => {};
    api.listScorecardMetrics.mockReturnValueOnce(new Promise((r) => { release = r; }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('button', { name: 'Confirm archive' }));
    // Mid-reload: the list is still there (busy), not "Loading…".
    expect(screen.queryByText('Loading scorecard metrics…')).not.toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'true');
    release([]);
  });

  it('shows the rubric as an ORDERED four-level scale, Poor to Excellent', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Communication/ }));

    const scale = screen.getByRole('list', { name: 'Rubric, 1 Poor to 4 Excellent' });
    const levels = within(scale).getAllByRole('listitem');
    expect(levels.map((l) => l.textContent)).toEqual([
      '1 PoorRambling',
      '2 AverageMostly clear',
      '3 GoodClear',
      '4 ExcellentCrisp and structured',
    ]);
    expect(within(scale).queryByText(/Below average/)).not.toBeInTheDocument();
    expect(within(scale).queryByText('5')).not.toBeInTheDocument();
  });

  it('edits in place: the open row becomes the form, prefilled', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    api.updateScorecardMetric.mockResolvedValue({ ...COMMUNICATION, version: 4 });
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Communication/ }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const details = screen.getByRole('region', { name: /Communication/ });
    expect(within(details).getByLabelText('Name')).toHaveValue('Communication');
    expect(within(details).getByLabelText('4 Excellent')).toHaveValue('Crisp and structured');
    await user.clear(within(details).getByLabelText('Scoring instruction'));
    await user.type(within(details).getByLabelText('Scoring instruction'), 'Judge clarity and structure.');
    // Saving is not destructive (a new version; roles keep their copies), so
    // there is no second confirmation step.
    await user.click(within(details).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.updateScorecardMetric).toHaveBeenCalledTimes(1));
    expect(api.updateScorecardMetric).toHaveBeenCalledWith('m1', expect.objectContaining({
      default_instruction: 'Judge clarity and structure.',
    }));
  });

  it('archives only after an explicit confirmation', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    api.archiveScorecardMetric.mockResolvedValue(undefined);
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Communication/ }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(api.archiveScorecardMetric).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm archive' }));
    await waitFor(() => expect(api.archiveScorecardMetric).toHaveBeenCalledWith('m1'));
  });

  // Ask Hello's behaviour is covered in MetricAskHello.test.tsx; these pin
  // only the wiring into this form.
  it('puts Ask Hello on the create form only — the edit form carries none', async () => {
    api.listScorecardMetrics.mockResolvedValue([COMMUNICATION]);
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Communication v3' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const details = screen.getByRole('region', { name: 'Communication v3' });
    expect(within(details).getByLabelText('Name')).toHaveValue('Communication');
    expect(details.querySelector('[data-ask-hello]')).toBeNull();
    expect(document.querySelectorAll('[data-ask-hello]')).toHaveLength(0);

    const form = await openCreate(user);
    expect(form.querySelectorAll('[data-ask-hello]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-ask-hello]')).toHaveLength(1);
    expect(within(form).getByRole('button', { name: /^Ask Hello/ })).toBeInTheDocument();
  });

  it("fills the create form's instruction and four rubric levels from Hello's draft, and creates nothing", async () => {
    api.draftMetricRubric.mockResolvedValue({
      default_instruction: 'Look for concrete examples of ownership.',
      rubric: { 1: 'No example.', 2: 'A vague claim.', 3: 'A specific example.', 4: 'Several examples.' },
    });
    render(<ScorebarSection />);
    const user = userEvent.setup();
    await openCreate(user);

    await user.type(screen.getByLabelText('Name'), 'Ownership');
    await user.click(screen.getByRole('button', { name: /^Ask Hello/ }));

    await waitFor(() =>
      expect(screen.getByLabelText('Scoring instruction')).toHaveValue(
        'Look for concrete examples of ownership.',
      ),
    );
    expect(screen.getByLabelText('1 Poor')).toHaveValue('No example.');
    expect(screen.getByLabelText('2 Average')).toHaveValue('A vague claim.');
    expect(screen.getByLabelText('3 Good')).toHaveValue('A specific example.');
    expect(screen.getByLabelText('4 Excellent')).toHaveValue('Several examples.');
    expect(api.draftMetricRubric).toHaveBeenCalledWith({ name: 'Ownership', description: null });
    expect(api.createScorecardMetric).not.toHaveBeenCalled();
  });

  it('after Create, the reopened form is empty and no longer says Hello drafted it', async () => {
    // A successful Create resets the draft and closes the form; Ask Hello's
    // "review before creating" line is about text that is gone, and must not
    // be waiting beside the empty form when "New metric" opens it again.
    api.draftMetricRubric.mockResolvedValue({
      default_instruction: 'Look for concrete examples of ownership.',
      rubric: { 1: 'No example.', 2: 'A vague claim.', 3: 'A specific example.', 4: 'Several examples.' },
    });
    render(<ScorebarSection />);
    const user = userEvent.setup();
    const drafted = 'Hello drafted the scoring instruction and rubric — review before creating.';
    await openCreate(user);

    await user.type(screen.getByLabelText('Name'), 'Ownership');
    await user.click(screen.getByRole('button', { name: /^Ask Hello/ }));
    expect(await screen.findByText(drafted)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('Metric “Technical depth” created.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add a metric' })).not.toBeInTheDocument());

    await openCreate(user);
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Scoring instruction')).toHaveValue('');
    expect(screen.queryByText(drafted)).not.toBeInTheDocument();
    expect(
      screen.getByText('Add a name and Hello can draft the instruction and rubric.'),
    ).toBeInTheDocument();
  });
});
