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

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RolesPage } from './RolesPage';
import { mockRole } from '../test/helpers';

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
