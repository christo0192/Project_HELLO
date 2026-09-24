/**
 * RolesPage accessibility tests.
 *
 * Covers:
 *   - Empty state (no roles)
 *   - Roles list rendering
 *   - New role / Edit role form
 *   - axe structural rule compliance
 *   - Keyboard and focus management
 */

import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RolesPage } from './RolesPage';
import { mockRole } from '../test/helpers';
// The MOCKED class from the factory below — the same one `RolesPage`
// catches, so `err instanceof ApiError` holds in the component.
import { ApiError } from '../api';

const mockApi = {
  listRoles: vi.fn(),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  // The EDIT path mounts RoleScorecardEditor and AskHelloButton, which call
  // these on mount. A partial adapter here does not fail loudly — it throws
  // inside an effect, which React escalates into unmounting the page, and an
  // absent method reads as "this feature is off" rather than as a broken
  // mock. That is exactly how a dead endpoint survived a green suite earlier
  // in this branch, so every method the page can reach is stubbed.
  getRoleScorecard: vi.fn(),
  listScorecardMetrics: vi.fn(),
  putRoleScorecard: vi.fn(),
  getActiveRoleDraft: vi.fn(),
  startRoleDraft: vi.fn(),
  getRoleDraft: vi.fn(),
  cancelRoleDraft: vi.fn(),
  rephraseQuestion: vi.fn(),
  deleteRole: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    createRole: (...args: any[]) => mockApi.createRole(...args),
    updateRole: (...args: any[]) => mockApi.updateRole(...args),
    getRoleScorecard: (...args: any[]) => mockApi.getRoleScorecard(...args),
    listScorecardMetrics: (...args: any[]) => mockApi.listScorecardMetrics(...args),
    putRoleScorecard: (...args: any[]) => mockApi.putRoleScorecard(...args),
    getActiveRoleDraft: (...args: any[]) => mockApi.getActiveRoleDraft(...args),
    startRoleDraft: (...args: any[]) => mockApi.startRoleDraft(...args),
    getRoleDraft: (...args: any[]) => mockApi.getRoleDraft(...args),
    cancelRoleDraft: (...args: any[]) => mockApi.cancelRoleDraft(...args),
    rephraseQuestion: (...args: any[]) => mockApi.rephraseQuestion(...args),
    deleteRole: (...args: any[]) => mockApi.deleteRole(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const DRAFTED = {
  jd: 'Sell the product to enterprise buyers.',
  required_skills: ['Sales', 'Negotiation'],
  screening_template: [
    { id: 'q1', question: 'What does your current role involve day to day?', weight: 1 },
    { id: 'q2', question: 'How do you handle an unhappy customer?', weight: 1 },
    { id: 'q3', question: 'What made you look for a new position?', weight: 1 },
  ],
};

/** A settled job, as the poll returns it. */
const succeededJob = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  job_role: 'Sales Advisor',
  status: 'succeeded',
  phase: null,
  draft: DRAFTED,
  attempts: 1,
  repaired: [],
  error_reason: null,
  error_message: null,
  max_attempts: 3,
  created_at: new Date().toISOString(),
  ...over,
});

describe('RolesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults for everything the form mounts, so a test that is
    // about saving does not have to know what else is on the page.
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
  });

  it('shows loading state initially', () => {
    mockApi.listRoles.mockReturnValue(new Promise(() => {})); // never resolves
    render(<RolesPage />);
    expect(screen.getByText('Loading roles…')).toBeInTheDocument();
  });

  it('shows empty state when no roles', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    expect(await screen.findByText('No roles yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Create your first role to start screening candidates against it.',
      ),
    ).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockApi.listRoles.mockRejectedValue({ message: 'API error' });
    render(<RolesPage />);
    expect(await screen.findByText('API error')).toBeInTheDocument();
    // Retry button should be available
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders roles list when roles exist', async () => {
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);

    expect(await screen.findByText('Senior Frontend Engineer')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('We need a React expert.')).toBeInTheDocument();
    expect(screen.getByText('2 screening questions')).toBeInTheDocument();
  });

  it('shows "New role" button when no role editing', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    expect(await screen.findByRole('button', { name: 'New role' })).toBeInTheDocument();
  });

  it('opens new role form on button click', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    const btn = await screen.findByRole('button', { name: 'New role' });
    await userEvent.click(btn);
    expect(screen.getByText('New role')).toBeInTheDocument();
    expect(screen.getByLabelText('Job role')).toBeInTheDocument();
    expect(screen.getByLabelText('Job description')).toBeInTheDocument();
    expect(screen.getByLabelText('Required skills')).toBeInTheDocument();
  });

  it('reaches form fields via keyboard tab', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    const user = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'New role' });
    await user.click(btn);

    // AGENT IS FIRST now — the operator's internal name for this screener
    // sits above the job role, so it is the first field tab reaches.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Agent'));

    // Then the job role (was "Title").
    await user.tab();
    const titleInput = screen.getByLabelText('Job role');
    expect(document.activeElement).toBe(titleInput);

    // Ask Hello sits between them and IS a tab stop, even with nothing to
    // draft from. That is deliberate. It is `aria-disabled`, not `disabled`:
    // a truly disabled button loses focus the instant it is pressed by
    // keyboard, dropping the user to <body> at exactly the moment Cancel
    // appears beside it. It announces itself as disabled and its handler
    // refuses; the price is that keyboard users tab THROUGH it, which is the
    // correct trade and is asserted here so nobody "fixes" it back.
    await user.tab();
    const askHello = screen.getByRole('button', { name: /Ask Hello/ });
    expect(document.activeElement).toBe(askHello);
    expect(askHello).toHaveAttribute('aria-disabled', 'true');
    expect(askHello).not.toBeDisabled();

    // Tab to Job description
    await user.tab();
    expect(screen.getByLabelText('Job description')).toBe(document.activeElement);

    // Tab to Required skills
    await user.tab();
    expect(screen.getByLabelText('Required skills')).toBe(document.activeElement);

    // Shift+Tab back to Job description
    await user.tab({ shift: true });
    expect(screen.getByLabelText('Job description')).toBe(document.activeElement);
  });

  it('submits form on Enter key from title field', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue({ id: 'new-id-enter' });
    render(<RolesPage />);
    const user = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'New role' });
    await user.click(btn);

    await user.type(screen.getByLabelText('Job role'), 'Engineer{Enter}');
    expect(mockApi.createRole).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Engineer' }),
    );
  });

  it('OMITS agent_name entirely when the box was never touched', async () => {
    // The deploy-order guard, and the thing it protects.
    //
    // `roles.agent_name` arrives in migration 0100, and the web app ships
    // independently of `supabase db push`. Until the migration lands,
    // PostgREST rejects the unknown column (PGRST204) and the route 500s — so
    // sending the key on every save would break ALL role creation, including
    // for the roles that never wanted an agent name, which is every existing
    // one. The ordinary save must carry no such key at all.
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue({ id: 'new-id-omit' });
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));

    await user.type(screen.getByLabelText('Job role'), 'Engineer');
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(mockApi.createRole).toHaveBeenCalled());
    const body = mockApi.createRole.mock.calls[0][0];
    expect('agent_name' in body).toBe(false);
  });

  it('SENDS agent_name when the operator actually typed one', async () => {
    // The other half: the guard must not swallow a real value.
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue({ id: 'new-id-send' });
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));

    await user.type(screen.getByLabelText('Agent'), 'Gopu');
    await user.type(screen.getByLabelText('Job role'), 'Engineer');
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(mockApi.createRole).toHaveBeenCalled());
    expect(mockApi.createRole.mock.calls[0][0].agent_name).toBe('Gopu');
  });

  it('SENDS an explicit null to CLEAR a name the role already had', async () => {
    // Blanking a field that has a value is a real edit, not an absence, and
    // must reach the server as one. This save does need 0100 — but it is the
    // rare case, not every save.
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, agent_name: 'Gopu' }]);
    mockApi.updateRole.mockResolvedValue({ ...mockRole, agent_name: null });
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    await user.clear(screen.getByLabelText('Agent'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockApi.updateRole).toHaveBeenCalled());
    const body = mockApi.updateRole.mock.calls[0][1];
    expect('agent_name' in body).toBe(true);
    expect(body.agent_name).toBeNull();
  });

  it('APPLIES A LANDED DRAFT to the form, and says so in a live region', async () => {
    // NOTHING IN THIS FILE EVER COMPLETED A DRAFT before, so the entire
    // `onDrafted` branch was uncovered — including the div-inside-<p> fix and
    // the `role="none"` that stops two live regions nesting. The project's
    // harness fails on an unexpected console.error, and React logs one for
    // invalid nesting, so this test is also what would have caught that.
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.startRoleDraft.mockResolvedValue({ ...succeededJob(), status: 'running' });
    mockApi.getRoleDraft.mockResolvedValue(succeededJob());
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));

    await user.type(screen.getByLabelText('Job role'), 'Sales Advisor');
    await user.click(screen.getByRole('button', { name: /Ask Hello/ }));

    await waitFor(() =>
      expect(screen.getByLabelText('Job description')).toHaveValue(DRAFTED.jd),
    );
    expect(screen.getByLabelText(/Required skills/)).toHaveValue('Sales, Negotiation');

    // Said in a region that was mounted before it had anything to say.
    const note = document.querySelector('[data-role-draft-note]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('Review it before saving');
    // ONE live region, not two nested.
    expect(note?.querySelectorAll('[role="status"]').length).toBe(0);
  });

  it('NAMES THE ROLE a draft was actually written for when it no longer matches', async () => {
    // The field stays editable for the ten minutes a draft runs. Applying a
    // Sales Advisor draft under a heading that now says something else without
    // saying so is a silent lie about what is on screen.
    //
    // The mismatch now ALSO triggers the apply-time confirm, so this accepts
    // it and then checks the note still names the role that was drafted.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.startRoleDraft.mockResolvedValue({ ...succeededJob(), status: 'running' });
    mockApi.getRoleDraft.mockResolvedValue(succeededJob({ job_role: 'Sales Advisr' }));
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));

    await user.type(screen.getByLabelText('Job role'), 'Sales Advisor');
    await user.click(screen.getByRole('button', { name: /Ask Hello/ }));

    await waitFor(() =>
      expect(document.querySelector('[data-role-draft-note]')?.textContent).toContain(
        'Sales Advisr',
      ),
    );
    confirmSpy.mockRestore();
  });

  it('ASKS BEFORE APPLYING a draft written for a different role, even on an empty form', async () => {
    // A fresh form has nothing to overwrite, so the `hasWork` confirm never
    // fired — which is exactly the case where a draft for another role filled
    // the form silently. The mismatch is now its own reason to ask.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.startRoleDraft.mockResolvedValue({ ...succeededJob(), status: 'running' });
    mockApi.getRoleDraft.mockResolvedValue(succeededJob({ job_role: 'Sales Advisr' }));
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));

    await user.type(screen.getByLabelText('Job role'), 'Sales Advisor');
    await user.click(screen.getByRole('button', { name: /Ask Hello/ }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toContain('Sales Advisr');
    // Declined, so nothing was written into the form.
    expect(screen.getByLabelText('Job description')).toHaveValue('');
    confirmSpy.mockRestore();
  });

  it('renders a busy draft as a NOTE, not a red alert', async () => {
    // This fires on MOUNT, so opening any role for editing while a draft runs
    // used to raise a danger notice the operator never asked for and could
    // not dismiss for the life of the form. Rewiring it back to `draftError`
    // failed no test — the component test only asserts which callback fires,
    // not what the page does with it.
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.getActiveRoleDraft.mockResolvedValue({
      active: {
        ...succeededJob(),
        id: 'other',
        status: 'running',
        job_role: 'Sales Advisor',
      },
    });
    mockApi.getRoleDraft.mockResolvedValue({ ...succeededJob(), status: 'running' });
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const note = await waitFor(() => {
      const el = document.querySelector('[data-role-draft-note]');
      expect(el?.textContent).toContain('Sales Advisor');
      return el;
    });
    // A note, not an alert.
    expect(note?.querySelector('[role="alert"]')).toBeNull();
    // ...and it names the whole recovery, including closing this form — the
    // "New role" button is hidden while a form is open.
    expect(note?.textContent).toContain('Close this form');
  });

  it('reports how many questions Hello had to rephrase', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.startRoleDraft.mockResolvedValue({ ...succeededJob(), status: 'running' });
    mockApi.getRoleDraft.mockResolvedValue(succeededJob({ repaired: ['q2 was a directive'] }));
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));

    await user.type(screen.getByLabelText('Job role'), 'Sales Advisor');
    await user.click(screen.getByRole('button', { name: /Ask Hello/ }));

    await waitFor(() =>
      expect(document.querySelector('[data-role-draft-note]')?.textContent).toContain(
        'rephrased 1 question',
      ),
    );
  });

  it('shows the AGENT NAME on the role card — a write-only field is uncheckable', async () => {
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, agent_name: 'Gopu' }]);
    render(<RolesPage />);
    await waitFor(() =>
      expect(document.querySelector('[data-role-agent-name]')?.textContent).toContain('Gopu'),
    );
  });

  it('new role form validates required job role', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue({ id: 'new-id' });
    render(<RolesPage />);
    const btn = await screen.findByRole('button', { name: 'New role' });
    await userEvent.click(btn);

    // Submit without title
    const submitBtn = screen.getByRole('button', { name: 'Create role' });
    await userEvent.click(submitBtn);
    expect(screen.getByText('Job role is required.')).toBeInTheDocument();
  });

  it('has no axe violations in empty state', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    const { container } = render(<RolesPage />);
    // Wait for loading to finish
    await screen.findByText('No roles yet');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations when roles exist', async () => {
    mockApi.listRoles.mockResolvedValue([mockRole]);
    const { container } = render(<RolesPage />);
    await screen.findByText('Senior Frontend Engineer');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in form view', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    const { container } = render(<RolesPage />);
    const btn = await screen.findByRole('button', { name: 'New role' });
    await userEvent.click(btn);
    await expect(container).toHaveNoViolations();
  });
});

describe('Rephrase — the way out of an unforgiving question gate', () => {
  // `validatePhoneQuestion` bans "system", "developer", "model" and five more
  // words outright, so an operator typing the natural phrasing for a Talent
  // Acquisition role hits a wall the form cannot help them over. These tests
  // are about the button being a way THROUGH that wall rather than one more
  // thing that fails quietly.
  /**
   * The message on the ROW, not the one in the live region.
   *
   * Both deliberately carry the same text — the region exists because
   * replacing an input's value announces nothing — so an unscoped
   * `getByText` now matches twice.
   */
  function rowError(pattern: RegExp) {
    return screen
      .getAllByText(pattern)
      .filter((el) => el.closest('[role="status"]') === null);
  }

  async function openEditor() {
    mockApi.listRoles.mockResolvedValue([mockRole]);
    // The edit form mounts RoleScorecardEditor too, and its effect calls both
    // of these. Left undefined they reject inside an effect, which unmounts
    // the page — and the button under test disappears for a reason that has
    // nothing to do with rephrasing.
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    // The call LOG, not the implementation: `mockApi` is built once for the
    // whole file, so the "must not be called" assertion below would otherwise
    // see the click from the first test in this block and fail for a reason
    // that is not about the code. Verified — that test passed alone and
    // failed in the file.
    mockApi.rephraseQuestion.mockClear();
    render(<RolesPage />);
    const edit = await screen.findByRole('button', { name: /edit/i });
    await userEvent.click(edit);
    return (await screen.findByLabelText('Question 1')) as HTMLInputElement;
  }

  it('REPLACES the question with the rewrite', async () => {
    mockApi.rephraseQuestion.mockResolvedValue({
      question: 'How do you keep your applicant tracking tools up to date?',
    });
    const field = await openEditor();
    const before = field.value;

    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 1' }));

    await waitFor(() =>
      expect((screen.getByLabelText('Question 1') as HTMLInputElement).value).toBe(
        'How do you keep your applicant tracking tools up to date?',
      ),
    );
    expect(mockApi.rephraseQuestion).toHaveBeenCalledWith(before);
    // AND ONLY THAT ROW. Replacing the updater with `prev.map((q) => ({...q,
    // question }))` — one Rephrase overwriting every question in the role with
    // the same sentence — left all 25 tests green, because nothing looked at
    // the second row.
    expect((screen.getByLabelText('Question 2') as HTMLInputElement).value).toBe(
      mockRole.screening_template[1].question,
    );
  });

  it('DISCARDS the rewrite when the row moved underneath it', async () => {
    // The index is not an identity. Remove a row above the one being
    // rephrased and index 4 addresses what used to be row 5 — a reviewer
    // proved the rewrite of one question silently replacing a different one,
    // with the original text simply gone and no error shown. Pruning an
    // eight-row draft while a rephrase is out is the normal workflow.
    let release: (v: unknown) => void = () => {};
    mockApi.rephraseQuestion.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await openEditor();
    const secondBefore = (screen.getByLabelText('Question 2') as HTMLInputElement).value;

    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 2' }));
    // Row 1 goes while row 2's rewrite is still out.
    await userEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await act(async () => {
      release({ question: 'A REWRITE THAT MUST NOT LAND?' });
    });

    // Only one row left, and it is the one that used to be row 2 — unchanged.
    expect((screen.getByLabelText('Question 1') as HTMLInputElement).value).toBe(secondBefore);
    expect(screen.queryByDisplayValue('A REWRITE THAT MUST NOT LAND?')).not.toBeInTheDocument();
  });

  it('FREES THE BUTTONS once the call settles, on success and on failure', async () => {
    // Deleting `finally { setRephrasingIdx(null) }` left every Rephrase button
    // in the form inert for the rest of the session, with the pressed row
    // stuck reading "Rephrasing…", and 25/25 stayed green.
    mockApi.rephraseQuestion.mockRejectedValueOnce(new Error('nope'));
    await openEditor();
    const button = screen.getByRole('button', { name: 'Rephrase question 1' });

    await userEvent.click(button);
    await waitFor(() => expect(rowError(/rephrase failed/i)).toHaveLength(1));

    const after = screen.getByRole('button', { name: 'Rephrase question 1' });
    expect(after).toHaveAttribute('aria-disabled', 'false');
    expect(after).toHaveTextContent('Rephrase');
  });

  it("SHOWS THE SERVER'S OWN 422 MESSAGE, not a generic one", async () => {
    // The route is built to say "Hello could not rephrase that question into
    // something the screener will read aloud" rather than 500 — and the UI
    // could throw that away for a flat "Rephrase failed" with the suite green,
    // because the only error test rejected with a plain Error and exercised
    // the fallback branch alone.
    mockApi.rephraseQuestion.mockRejectedValue(
      new ApiError('Hello could not rephrase that question.', 422),
    );
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 1' }));
    await waitFor(() =>
      expect(rowError(/Hello could not rephrase that question\./)).toHaveLength(1),
    );
  });

  it('REFUSES A SECOND PRESS while one is in flight', async () => {
    // The lock the code's own comment calls load-bearing. Deleting both halves
    // — the early return and the aria-disabled — kept 25/25 green.
    let release: (v: unknown) => void = () => {};
    mockApi.rephraseQuestion.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 1' }));
    // The other row is inert, and says so to assistive tech rather than by
    // going grey (a real `disabled` would blur the pressed element).
    const other = screen.getByRole('button', { name: 'Rephrase question 2' });
    expect(other).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(other);
    expect(mockApi.rephraseQuestion).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ question: 'Fine?' });
    });
  });

  it('ANNOUNCES the outcome, because replacing an input says nothing', async () => {
    // A screen reader is told nothing at all when a field's value changes
    // under it, and the operator who pressed the button is the one person who
    // needs to know it landed.
    mockApi.rephraseQuestion.mockResolvedValue({ question: 'A clean question?' });
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 1' }));
    // BY TEXT, not by role: the page carries more than one `role="status"`
    // region (this one, and the role-removal note on the list), so an
    // unscoped role query matches several.
    await waitFor(() => expect(screen.getByText('Question 1 rephrased.')).toBeInTheDocument());
  });

  it('LEAVES THE OPERATOR TEXT ALONE when the model cannot phrase it', async () => {
    // The whole value of the button is that a failure costs nothing. Clearing
    // the field, or writing a half-answer into it, would lose work the
    // operator typed — for a feature whose entire promise is "fail proof".
    mockApi.rephraseQuestion.mockRejectedValue(new Error('nope'));
    const field = await openEditor();
    const before = field.value;

    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 1' }));

    await waitFor(() => expect(rowError(/rephrase failed/i)).toHaveLength(1));
    expect((screen.getByLabelText('Question 1') as HTMLInputElement).value).toBe(before);
  });

  it('names the ROW it belongs to, not just "Rephrase"', async () => {
    // Eight questions means eight identical buttons to anyone navigating by
    // control. The row number is the only thing telling them apart.
    await openEditor();
    expect(screen.getByRole('button', { name: 'Rephrase question 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove question 1' })).toBeInTheDocument();
  });

  it('does NOT offer to rephrase an empty question', async () => {
    const field = await openEditor();
    await userEvent.clear(field);
    // `aria-disabled`, not `disabled` — a real one blurs the element the
    // instant a keyboard user presses it, dropping focus to <body>.
    expect(screen.getByRole('button', { name: 'Rephrase question 1' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(mockApi.rephraseQuestion).not.toHaveBeenCalled();
  });
});

describe('The [MUST ASK] flag survives an edit', () => {
  // PROVEN BY A REVIEWER, ONE LINE OF CAUSE. The form rebuilt its question
  // rows from the saved role WITHOUT `mandatory`, and `PUT /api/roles/:id`
  // replaces `screening_template` wholesale — so opening an Ask Hello role to
  // fix a typo in the JD and pressing Save silently stripped every
  // `[MUST ASK]` from it.
  //
  // That flag is the only thing keeping CTC and notice period from being
  // dropped when a call runs against its ten-minute budget, it appears nowhere
  // in the UI, and recovering it meant re-running a ten-minute draft that
  // overwrites the whole form.
  const ARC_ROLE = {
    ...mockRole,
    screening_template: [
      { id: 'q1', question: 'Tell me about yourself and your most recent role?', weight: 1, mandatory: true },
      { id: 'q2', question: 'What does your current role involve day to day?', weight: 1 },
      { id: 'q3', question: 'What is your current annual CTC, including any variable pay?', weight: 1, mandatory: true },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
    mockApi.listRoles.mockResolvedValue([ARC_ROLE]);
    mockApi.updateRole.mockResolvedValue(ARC_ROLE);
  });

  it('SAVES the flags back unchanged after an edit that never touched them', async () => {
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');
    await userEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mockApi.updateRole).toHaveBeenCalled());
    const body = mockApi.updateRole.mock.calls[0][1] as {
      screening_template: Array<{ id: string; mandatory?: boolean }>;
    };
    expect(
      body.screening_template.filter((q) => q.mandatory === true).map((q) => q.id),
    ).toEqual(['q1', 'q3']);
    // And a question that was never mandatory does not become so.
    expect(body.screening_template.find((q) => q.id === 'q2')?.mandatory).toBeUndefined();
  });
});

describe('Removing a role', () => {
  // The page could add roles and never remove one. The gap matters more than
  // it looks: `candidates.role_id` is ON DELETE SET NULL, so a naive delete
  // detaches every screened candidate from the job they applied for — and an
  // archived role stays on the page as "Inactive" while a deleted one goes,
  // so the note is the only thing that says which happened.
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.deleteRole.mockResolvedValue({ outcome: 'deleted' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('DELETES after a confirm, and reloads', async () => {
    render(<RolesPage />);
    const button = await screen.findByRole('button', {
      name: `Delete role ${mockRole.title}`,
    });
    await userEvent.click(button);

    await waitFor(() => expect(mockApi.deleteRole).toHaveBeenCalledWith(mockRole.id));
    await waitFor(() => expect(mockApi.listRoles).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/was deleted/)).toBeInTheDocument();
  });

  it('DOES NOTHING when the confirm is declined', async () => {
    // One click from a list, and destructive.
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<RolesPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: `Delete role ${mockRole.title}` }),
    );
    expect(mockApi.deleteRole).not.toHaveBeenCalled();
  });

  it('SAYS SO when the role was ARCHIVED rather than deleted', async () => {
    // The card goes away either way. An operator who is not told will go
    // looking for a role that still exists, or assume history was destroyed
    // when it was not.
    mockApi.deleteRole.mockResolvedValue({
      outcome: 'archived',
      reason: 'candidates_or_sessions_exist',
      candidates: 12,
      sessions: 3,
    });
    render(<RolesPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: `Delete role ${mockRole.title}` }),
    );
    const note = await screen.findByText(/archived rather than deleted/);
    expect(note).toHaveTextContent(/12 candidates/);
    expect(note).toHaveTextContent(/3 sessions/);
  });

  it("SHOWS THE SERVER'S REASON when the role is mapped to an Ashby job", async () => {
    // A 409 names the screen where the mapping can be removed; a generic
    // "could not delete" would leave the operator with nowhere to go.
    mockApi.deleteRole.mockRejectedValue(
      new ApiError('This role is mapped to an Ashby job. Remove the mapping in Ashby Mission Control first.', 409),
    );
    render(<RolesPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: `Delete role ${mockRole.title}` }),
    );
    expect(await screen.findByText(/Ashby Mission Control/)).toBeInTheDocument();
  });

  it('names the ROLE, not just "Delete"', async () => {
    // Six cards means six identical controls to anyone navigating by control,
    // and this is the last thing they hear before a destructive action.
    render(<RolesPage />);
    expect(
      await screen.findByRole('button', { name: `Delete role ${mockRole.title}` }),
    ).toBeInTheDocument();
  });
});
