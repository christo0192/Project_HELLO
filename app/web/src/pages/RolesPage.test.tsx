/**
 * RolesPage accessibility tests.
 *
 * Covers:
 *   - Empty state (no roles)
 *   - Roles list rendering
 *   - New agent / Edit agent form
 *   - axe structural rule compliance
 *   - Keyboard and focus management
 */

import { render as rtlRender, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RolesPage } from './RolesPage';
import { mockRole } from '../test/helpers';
// The MOCKED class from the factory below — the same one `RolesPage`
// catches, so `err instanceof ApiError` holds in the component.
import { ApiError } from '../api';

// The page reads the viewer's role to decide whether the Scorebar trigger
// exists at all. Default to a NON-admin here so every pre-existing test sees
// exactly the header it always saw; the admin-only tests opt in explicitly.
let mockAuth: { role: string | null };

vi.mock('../lib/auth', () => ({
  useAuth: () => mockAuth,
  ALLOWED_EMAIL_DOMAIN: 'interviewkickstart.com',
  isCompanyEmail: () => true,
}));

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
  // The Scorebar drawer's metric library (admin only).
  draftMetricRubric: vi.fn(),
  createScorecardMetric: vi.fn(),
  updateScorecardMetric: vi.fn(),
  archiveScorecardMetric: vi.fn(),
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
    draftMetricRubric: (...args: any[]) => mockApi.draftMetricRubric(...args),
    createScorecardMetric: (...args: any[]) => mockApi.createScorecardMetric(...args),
    updateScorecardMetric: (...args: any[]) => mockApi.updateScorecardMetric(...args),
    archiveScorecardMetric: (...args: any[]) => mockApi.archiveScorecardMetric(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

// The page keeps its status filter in the URL, so it needs a router. Every
// test renders through this wrapper; `initialUrl` seeds a deep link and the
// probe exposes the current query string.
let initialUrl = '/roles';
beforeEach(() => {
  initialUrl = '/roles';
});

function LocationProbe() {
  const { search } = useLocation();
  return <div data-testid="location-search" hidden>{search}</div>;
}

function render(ui: React.ReactElement) {
  return rtlRender(
    <MemoryRouter initialEntries={[initialUrl]}>
      {ui}
      <LocationProbe />
    </MemoryRouter>,
  );
}

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
    mockAuth = { role: 'interviewer' };
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
    expect(screen.getByText('Loading agents…')).toBeInTheDocument();
  });

  it('titles the page "Agents" (renamed from "Roles"), in agent terms throughout the header and list', async () => {
    // Owner request: stakeholders no longer call these "roles". The route
    // stays /roles; only the words change.
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Roles' })).toBeNull();
    expect(
      screen.getByText('Each agent screens candidates for one job, using the questions it asks.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'All agents' })).toBeInTheDocument();
    expect(screen.getByText('1 agent, 1 active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New role' })).toBeNull();
  });

  it('names the form in agent terms: "New agent" / "Create agent", and "Edit agent"', async () => {
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New agent' }));
    expect(screen.getByRole('heading', { name: 'New agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeInTheDocument();
    // The job-title FIELD keeps its job wording — it is the job, not the entity.
    expect(screen.getByLabelText('Job role')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Edit agent' })).toBeInTheDocument();
  });

  it('shows empty state when no roles', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Create your first agent to start screening candidates.',
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
    // Scoped to the row: the status filter's "Active" segment shares the word.
    expect(within(screen.getByRole('list', { name: 'All agents' })).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('We need a React expert.')).toBeInTheDocument();
    expect(screen.getByText('2 screening questions')).toBeInTheDocument();
  });

  it('shows "New agent" button when no role editing', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    expect(await screen.findByRole('button', { name: 'New agent' })).toBeInTheDocument();
  });

  it('opens new role form on button click', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    const btn = await screen.findByRole('button', { name: 'New agent' });
    await userEvent.click(btn);
    expect(screen.getByText('New agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Job role')).toBeInTheDocument();
    expect(screen.getByLabelText('Job description')).toBeInTheDocument();
    expect(screen.getByLabelText('Required skills')).toBeInTheDocument();
  });

  it('reaches form fields via keyboard tab', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    const user = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'New agent' });
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
    const btn = await screen.findByRole('button', { name: 'New agent' });
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
    await user.click(await screen.findByRole('button', { name: 'New agent' }));

    await user.type(screen.getByLabelText('Job role'), 'Engineer');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

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
    await user.click(await screen.findByRole('button', { name: 'New agent' }));

    await user.type(screen.getByLabelText('Agent'), 'Gopu');
    await user.type(screen.getByLabelText('Job role'), 'Engineer');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

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
    await user.click(await screen.findByRole('button', { name: 'New agent' }));

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
    await user.click(await screen.findByRole('button', { name: 'New agent' }));

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
    await user.click(await screen.findByRole('button', { name: 'New agent' }));

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
    // "New agent" button is hidden while a form is open.
    expect(note?.textContent).toContain('Close this form');
  });

  it('reports how many questions Hello had to rephrase', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.startRoleDraft.mockResolvedValue({ ...succeededJob(), status: 'running' });
    mockApi.getRoleDraft.mockResolvedValue(succeededJob({ repaired: ['q2 was a directive'] }));
    render(<RolesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New agent' }));

    await user.type(screen.getByLabelText('Job role'), 'Sales Advisor');
    await user.click(screen.getByRole('button', { name: /Ask Hello/ }));

    await waitFor(() =>
      expect(document.querySelector('[data-role-draft-note]')?.textContent).toContain(
        'rephrased 1 question',
      ),
    );
  });

  it('leads the role row with the AGENT NAME, and puts the job underneath', async () => {
    // Owner request: agent on top, role name below — the two swapped.
    // An h3: the list's own heading ("All agents") is the h2 above the rows.
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, agent_name: '  Gopu  ' }]);
    render(<RolesPage />);
    const heading = await screen.findByRole('heading', { level: 3, name: 'Gopu' });
    expect(heading).toBeInTheDocument();
    // The job title is no longer a heading of its own, at any level...
    expect(
      screen.queryByRole('heading', { name: mockRole.title }),
    ).not.toBeInTheDocument();
    // ...it is the secondary line, labelled so nobody mistakes it for the agent.
    const secondary = document.querySelector('[data-role-title-secondary]');
    expect(secondary?.textContent).toBe(`Role: ${mockRole.title}`);
    // Sits in the same block as the heading, directly below it.
    expect(heading.nextElementSibling).toBe(secondary);
    // The old "Agent: …" line is gone, not shown twice.
    expect(screen.queryByText(/^Agent:/)).not.toBeInTheDocument();
  });

  it('lets a TRUNCATED row heading be read in full — the title carries all of it', async () => {
    // Both lines are `truncate`d; an 80-character agent name ends in an
    // ellipsis with no other way to see the rest.
    const longAgent = 'A'.repeat(40) + ' screening agent for the enterprise sales team!';
    const longTitle = 'Senior Enterprise Account Executive, Strategic Accounts (EMEA and APAC)';
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, title: longTitle, agent_name: `  ${longAgent} ` }]);
    render(<RolesPage />);
    const heading = await screen.findByRole('heading', { level: 3, name: longAgent });
    expect(heading).toHaveClass('truncate');
    expect(heading).toHaveAttribute('title', longAgent);
    // The accessible name is still the (untruncated) content, unchanged.
    expect(heading).toHaveAccessibleName(longAgent);

    const secondary = document.querySelector('[data-role-title-secondary]') as HTMLElement;
    expect(secondary).toHaveClass('truncate');
    expect(secondary).toHaveAttribute('title', `Role: ${longTitle}`);
  });

  it('titles a title-only heading with the job title', async () => {
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, agent_name: null }]);
    render(<RolesPage />);
    const heading = await screen.findByRole('heading', { level: 3, name: mockRole.title });
    expect(heading).toHaveAttribute('title', mockRole.title);
  });

  it.each([
    ['no agent name', undefined],
    ['a null agent name', null],
    ['a blank agent name', '   '],
  ])('falls back to the job TITLE as the heading for %s, without repeating it', async (_label, agent_name) => {
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, agent_name }]);
    render(<RolesPage />);
    expect(
      await screen.findByRole('heading', { level: 3, name: mockRole.title }),
    ).toBeInTheDocument();
    // The heading already IS the job; a "Role: …" line under it would say it twice.
    expect(document.querySelector('[data-role-title-secondary]')).toBeNull();
    expect(screen.queryByText(/^Role:/)).not.toBeInTheDocument();
  });

  it('new role form validates required job role', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue({ id: 'new-id' });
    render(<RolesPage />);
    const btn = await screen.findByRole('button', { name: 'New agent' });
    await userEvent.click(btn);

    // Submit without title
    const submitBtn = screen.getByRole('button', { name: 'Create agent' });
    await userEvent.click(submitBtn);
    expect(screen.getByText('Job role is required.')).toBeInTheDocument();
  });

  it('has no axe violations in empty state', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    const { container } = render(<RolesPage />);
    // Wait for loading to finish
    await screen.findByText('No agents yet');
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
    const btn = await screen.findByRole('button', { name: 'New agent' });
    await userEvent.click(btn);
    await expect(container).toHaveNoViolations();
  });
});

describe('The role list — one surface of rows, not a card wall', () => {
  // The Roles page was a 3×2 grid of identical glass cards: the same pill,
  // chips and button pair repeated, descriptions cut mid-sentence. Design rule
  // 9 ("a strip, not a card wall") puts the roles in ONE panel as a list with
  // hairlines between rows. These pin the list's semantics and the facts each
  // row owes the operator, not its classes.
  beforeEach(() => {
    mockAuth = { role: 'interviewer' };
    vi.clearAllMocks();
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
  });

  const role = (n: number, over: Partial<typeof mockRole> & { agent_name?: string | null } = {}) => ({
    ...mockRole,
    id: `role-${n}`,
    title: `Role number ${n}`,
    ...over,
  });

  it('renders ONE list, named by its heading, with one item per role', async () => {
    mockApi.listRoles.mockResolvedValue([role(1), role(2, { is_active: false }), role(3)]);
    render(<RolesPage />);
    const list = await screen.findByRole('list', { name: 'All agents' });
    // Only the rows are items: the skills are text, not a nested chip list.
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    // The outline: the page's h1, the list's h2, one h3 per role.
    expect(screen.getByRole('heading', { level: 2, name: 'All agents' })).toBeInTheDocument();
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Role number 1',
      'Role number 2',
      'Role number 3',
    ]);
  });

  it.each([
    [[role(1), role(2), role(3, { is_active: false })], '3 agents, 2 active'],
    [[role(1)], '1 agent, 1 active'],
    [[role(1, { is_active: false }), role(2, { is_active: false })], '2 agents, none active'],
  ])('summarises the list in one line under its heading (%#)', async (roles, summary) => {
    mockApi.listRoles.mockResolvedValue(roles);
    render(<RolesPage />);
    expect(await screen.findByText(summary)).toBeInTheDocument();
  });

  it('counts EVERY role in the summary, not just the visible page, and pages only past ten', async () => {
    // Eleven roles: the first page shows ten, the summary still says eleven,
    // and paging appears because there is now a second page.
    const eleven = Array.from({ length: 11 }, (_, i) => role(i + 1));
    mockApi.listRoles.mockResolvedValue(eleven);
    render(<RolesPage />);
    const list = await screen.findByRole('list', { name: 'All agents' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('11 agents, 11 active')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'agents pagination' })).toBeInTheDocument();
  });

  it('shows NO paging controls when every role fits on one page', async () => {
    // "Showing 1–6 of 6 agents" with disabled arrows was a second way of
    // saying what the summary already says.
    mockApi.listRoles.mockResolvedValue([role(1), role(2)]);
    render(<RolesPage />);
    await screen.findByRole('list', { name: 'All agents' });
    expect(screen.queryByRole('navigation', { name: 'agents pagination' })).toBeNull();
  });

  it('says the state in WORDS on every row', async () => {
    mockApi.listRoles.mockResolvedValue([role(1), role(2, { is_active: false })]);
    render(<RolesPage />);
    const [live, retired] = within(await screen.findByRole('list', { name: 'All agents' })).getAllByRole('listitem');
    expect(within(live).getByText('Active')).toBeInTheDocument();
    expect(within(retired).getByText('Inactive')).toBeInTheDocument();
  });

  it('never cuts the description without a way to read it: two lines on screen, all of it in the title', async () => {
    const jd =
      'Own the services behind a live interview-preparation platform: design APIs in Go and TypeScript, run PostgreSQL at scale and keep p99 latency honest. You will pair with product on roadmap trade-offs.';
    mockApi.listRoles.mockResolvedValue([role(1, { jd })]);
    render(<RolesPage />);
    const description = await screen.findByText(jd);
    expect(description).toHaveClass('line-clamp-2');
    expect(description).toHaveAttribute('title', jd);
  });

  it('renders no empty description line for a role without one', async () => {
    mockApi.listRoles.mockResolvedValue([role(1, { jd: '   ' })]);
    render(<RolesPage />);
    const [row] = within(await screen.findByRole('list', { name: 'All agents' })).getAllByRole('listitem');
    expect(row.querySelector('.line-clamp-2')).toBeNull();
  });

  it('folds skills past three into "+N", and still says every one to a screen reader', async () => {
    mockApi.listRoles.mockResolvedValue([
      role(1, { required_skills: ['Go', 'PostgreSQL', 'Kubernetes', 'gRPC', 'System design'] }),
    ]);
    render(<RolesPage />);
    const [row] = within(await screen.findByRole('list', { name: 'All agents' })).getAllByRole('listitem');
    // On screen: three names and a count.
    expect(within(row).getByText(/Go, PostgreSQL, Kubernetes/)).toBeInTheDocument();
    const more = row.querySelector('[data-role-skills-more]') as HTMLElement;
    expect(more).toHaveTextContent('+2');
    // The folded ones are one hover away for a mouse...
    expect(more).toHaveAttribute('title', 'gRPC, System design');
    // ...and the count is hidden from assistive tech, which hears the names
    // themselves instead, so nothing is read twice or lost.
    expect(more).toHaveAttribute('aria-hidden', 'true');
    expect(row.textContent).toContain('gRPC, System design');
  });

  it('shows every skill, and no "+N", when there are three or fewer', async () => {
    mockApi.listRoles.mockResolvedValue([role(1)]);
    render(<RolesPage />);
    const [row] = within(await screen.findByRole('list', { name: 'All agents' })).getAllByRole('listitem');
    expect(within(row).getByText(/React, TypeScript, CSS/)).toBeInTheDocument();
    expect(row.querySelector('[data-role-skills-more]')).toBeNull();
  });

  it('keeps Delete QUIET on the row: red ink and outline, never a filled red button', async () => {
    // Design rule 10: the filled `danger` is for the confirmation step only.
    // The confirmation here is the browser's own `confirm`, pinned elsewhere.
    mockApi.listRoles.mockResolvedValue([role(1)]);
    render(<RolesPage />);
    const del = await screen.findByRole('button', { name: 'Delete agent Role number 1' });
    expect(del).toHaveClass('text-error-text');
    expect(del).not.toHaveClass('bg-error');
  });

  it('describes each Edit by its row heading, so six Edit buttons can be told apart', async () => {
    // The NAME stays "Edit" (what is on screen); the row's heading is the
    // description a screen reader adds when navigating by control.
    mockApi.listRoles.mockResolvedValue([role(1, { agent_name: 'Gopu' }), role(2)]);
    render(<RolesPage />);
    const edits = await screen.findAllByRole('button', { name: 'Edit' });
    expect(edits[0]).toHaveAccessibleDescription('Gopu');
    expect(edits[1]).toHaveAccessibleDescription('Role number 2');
  });

  it('keeps the TAB ORDER row by row: Edit, then Delete, then the next row', async () => {
    mockApi.listRoles.mockResolvedValue([role(1), role(2)]);
    render(<RolesPage />);
    const user = userEvent.setup();
    const [firstEdit, secondEdit] = await screen.findAllByRole('button', { name: 'Edit' });
    firstEdit.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Delete agent Role number 1' })).toHaveFocus();
    await user.tab();
    expect(secondEdit).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Delete agent Role number 2' })).toHaveFocus();
  });

  it('has no axe violations with an active and an inactive row', async () => {
    mockApi.listRoles.mockResolvedValue([
      role(1, { agent_name: 'Gopu', required_skills: ['Go', 'PostgreSQL', 'Kubernetes', 'gRPC'] }),
      role(2, { is_active: false }),
    ]);
    const { container } = render(<RolesPage />);
    await screen.findByRole('list', { name: 'All agents' });
    await expect(container).toHaveNoViolations();
  });
});

describe('The status filter — All / Active / Inactive', () => {
  beforeEach(() => {
    mockAuth = { role: 'interviewer' };
    vi.clearAllMocks();
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
  });

  const role = (n: number, over: Partial<typeof mockRole> = {}) => ({
    ...mockRole,
    id: `role-${n}`,
    title: `Role number ${n}`,
    ...over,
  });
  const mixed = () => [role(1), role(2, { is_active: false }), role(3), role(4, { is_active: false }), role(5, { is_active: false })];
  const titles = async () =>
    within(await screen.findByRole('list', { name: 'All agents' }))
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
  const search = () => screen.getByTestId('location-search').textContent;

  it('offers All, Active and Inactive with a count on each', async () => {
    mockApi.listRoles.mockResolvedValue(mixed());
    render(<RolesPage />);
    const group = await screen.findByRole('group', { name: 'Filter agents by status' });
    expect(within(group).getByRole('button', { name: /^All\s*5$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /^Active\s*2$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: /^Inactive\s*3$/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters the rows, writes ?status= to the URL, and leaves the summary counting every agent', async () => {
    mockApi.listRoles.mockResolvedValue(mixed());
    render(<RolesPage />);
    const user = userEvent.setup();
    expect(await titles()).toHaveLength(5);

    await user.click(screen.getByRole('button', { name: /^Inactive/ }));
    expect(await titles()).toEqual(['Role number 2', 'Role number 4', 'Role number 5']);
    expect(search()).toBe('?status=inactive');
    expect(screen.getByText('5 agents, 2 active')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Showing 3 of 5 agents');

    await user.click(screen.getByRole('button', { name: /^Active/ }));
    expect(await titles()).toEqual(['Role number 1', 'Role number 3']);
    expect(search()).toBe('?status=active');

    await user.click(screen.getByRole('button', { name: /^All/ }));
    expect(await titles()).toHaveLength(5);
    expect(search()).toBe('');
  });

  it('opens already filtered from a deep link, and ignores an unknown value', async () => {
    initialUrl = '/roles?status=inactive';
    mockApi.listRoles.mockResolvedValue(mixed());
    const first = render(<RolesPage />);
    expect(await titles()).toEqual(['Role number 2', 'Role number 4', 'Role number 5']);
    expect(screen.getByRole('button', { name: /^Inactive/ })).toHaveAttribute('aria-pressed', 'true');
    first.unmount();

    initialUrl = '/roles?status=bogus';
    render(<RolesPage />);
    expect(await titles()).toHaveLength(5);
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps other query params when the filter changes', async () => {
    initialUrl = '/roles?foo=1';
    mockApi.listRoles.mockResolvedValue(mixed());
    render(<RolesPage />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Active/ }));
    expect(search()).toBe('?foo=1&status=active');
  });

  it('shows a calm empty state with "Show all agents" when the filter matches nothing', async () => {
    initialUrl = '/roles?status=inactive';
    mockApi.listRoles.mockResolvedValue([role(1), role(2)]);
    render(<RolesPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('No inactive agents. Every agent is active.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'All agents' })).toBeNull();
    // Not the first-run empty state.
    expect(screen.queryByText('No agents yet')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show all agents' }));
    expect(await titles()).toHaveLength(2);
    expect(search()).toBe('');
  });

  it('says so when no agent is active', async () => {
    initialUrl = '/roles?status=active';
    mockApi.listRoles.mockResolvedValue([role(1, { is_active: false })]);
    render(<RolesPage />);
    expect(await screen.findByText('No active agents right now.')).toBeInTheDocument();
    expect(screen.getByText('1 agent, none active')).toBeInTheDocument();
  });

  it('returns to page 1 when the filter changes', async () => {
    const many = Array.from({ length: 14 }, (_, i) => role(i + 1, { is_active: i % 2 === 0 }));
    mockApi.listRoles.mockResolvedValue(many);
    render(<RolesPage />);
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'agents pagination' });
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await titles()).toEqual(['Role number 11', 'Role number 12', 'Role number 13', 'Role number 14']);
    await user.click(screen.getByRole('button', { name: /^Active/ }));
    // Seven active agents fit one page, and the list starts at its top.
    expect((await titles())[0]).toBe('Role number 1');
    expect(screen.queryByRole('navigation', { name: 'agents pagination' })).toBeNull();
  });

  it('survives a removal reload: the filter stays and the counts update', async () => {
    initialUrl = '/roles?status=inactive';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi.listRoles
      .mockResolvedValueOnce([role(1), role(2, { is_active: false })])
      .mockResolvedValue([role(1), role(2, { is_active: false })]);
    mockApi.deleteRole.mockResolvedValue({ outcome: 'archived', candidates: 1, sessions: 0 });
    render(<RolesPage />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete agent Role number 2' }));
    await waitFor(() => expect(mockApi.listRoles).toHaveBeenCalledTimes(2));
    expect(await titles()).toEqual(['Role number 2']);
    expect(search()).toBe('?status=inactive');
  });

  it('is reachable by keyboard and has no axe violations, filtered or not', async () => {
    mockApi.listRoles.mockResolvedValue(mixed());
    const { container } = render(<RolesPage />);
    const user = userEvent.setup();
    const inactive = await screen.findByRole('button', { name: /^Inactive/ });
    inactive.focus();
    await user.keyboard('{Enter}');
    expect(inactive).toHaveAttribute('aria-pressed', 'true');
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

  async function openEditor(role: typeof mockRole = mockRole) {
    // PARAMETERISED. It used to hard-code `[mockRole]`, so a test that set up
    // a different role immediately before calling it had that setup silently
    // overwritten — which is how the three-row fixture below ended up running
    // against two rows and failing to find its own third question.
    mockApi.listRoles.mockResolvedValue([role]);
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
    // THREE ROWS, DELIBERATELY. The index is not an identity: remove a row
    // above the one being rephrased and that index now addresses what used to
    // be the row BELOW it, so the rewrite of one question silently replaces a
    // different one. With only two rows the shifted index falls off the end
    // and a naive `prev.map((q,i) => i === idx ? … : q)` is a harmless no-op
    // — the fixture passed with the guard deleted, which is the one thing a
    // regression test must not do.
    const threeRows = {
      ...mockRole,
      screening_template: [
        { id: 'q1', question: 'FIRST-original?', weight: 1 },
        { id: 'q2', question: 'SECOND-original?', weight: 1 },
        { id: 'q3', question: 'THIRD-original?', weight: 1 },
      ],
    };
    let release: (v: unknown) => void = () => {};
    mockApi.rephraseQuestion.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await openEditor(threeRows);

    // Rephrase row 2, then delete row 1 while it is still out. Index 1 now
    // addresses what was row 3.
    await userEvent.click(screen.getByRole('button', { name: 'Rephrase question 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await act(async () => {
      release({ question: 'A REWRITE THAT MUST NOT LAND?' });
    });

    const values = [1, 2].map(
      (n) => (screen.getByLabelText(`Question ${n}`) as HTMLInputElement).value,
    );
    // The two survivors are untouched, and nothing anywhere took the rewrite.
    expect(values).toEqual(['SECOND-original?', 'THIRD-original?']);
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

  it('SURVIVES the Ask Hello draft -> form -> save path', async () => {
    // The API half is pinned end to end; the FORM was the unguarded link, and
    // no web test contained the string `mandatory` at all. Either the draft
    // mapping or the save payload could drop it and the arc would quietly go
    // back to being form-deep — the exact defect this work exists to fix.
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue(mockRole);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
    mockApi.startRoleDraft.mockResolvedValue(succeededJob());
    mockApi.getRoleDraft.mockResolvedValue(
      succeededJob({
        draft: {
          jd: 'Sell the product to enterprise buyers.',
          required_skills: ['Sales'],
          screening_template: [
            { id: 'q1', question: 'Tell me about yourself and your recent role?', weight: 1, mandatory: true, category: 'introduction' as const },
            { id: 'q2', question: 'What does your current role involve day to day?', weight: 1, category: 'profile_relevance' as const },
            { id: 'q3', question: 'What is your current annual CTC, including any variable pay?', weight: 1, mandatory: true, category: 'compensation' as const },
          ],
        },
      }),
    );
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New agent' }));
    await userEvent.type(screen.getByLabelText('Job role'), 'Sales Advisor');
    await userEvent.click(screen.getByRole('button', { name: /Ask Hello/ }));
    await waitFor(() =>
      expect((screen.getByLabelText('Question 3') as HTMLInputElement).value).toMatch(/CTC/),
    );

    await userEvent.click(screen.getByRole('button', { name: /Create agent/i }));
    await waitFor(() => expect(mockApi.createRole).toHaveBeenCalled());
    const body = mockApi.createRole.mock.calls[0][0] as {
      screening_template: Array<{ id: string; mandatory?: boolean; category?: string }>;
    };
    expect(body.screening_template.filter((q) => q.mandatory === true).map((q) => q.id)).toEqual([
      'q1',
      'q3',
    ]);
    // AND THE COMPARTMENT, on the same path and for the same reason. Dropping
    // `category` from the draft -> form map left the entire 93-file web suite
    // green: the edit round trip is covered, but the CREATE path — the one a
    // generated role actually takes — was not, and this fixture carried no
    // category at all to notice with.
    expect(body.screening_template.map((q) => q.category)).toEqual([
      'introduction',
      'profile_relevance',
      'compensation',
    ]);
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
      name: `Delete agent ${mockRole.title}`,
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
      await screen.findByRole('button', { name: `Delete agent ${mockRole.title}` }),
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
      await screen.findByRole('button', { name: `Delete agent ${mockRole.title}` }),
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
      await screen.findByRole('button', { name: `Delete agent ${mockRole.title}` }),
    );
    expect(await screen.findByText(/Ashby Mission Control/)).toBeInTheDocument();
  });

  it('names the ROLE, not just "Delete"', async () => {
    // Six cards means six identical controls to anyone navigating by control,
    // and this is the last thing they hear before a destructive action.
    render(<RolesPage />);
    expect(
      await screen.findByRole('button', { name: `Delete agent ${mockRole.title}` }),
    ).toBeInTheDocument();
  });

  it('names the AGENT first when the card leads with one — the name a screen reader hears matches the heading', async () => {
    mockApi.listRoles.mockResolvedValue([{ ...mockRole, agent_name: 'Gopu' }]);
    render(<RolesPage />);
    const button = await screen.findByRole('button', {
      name: `Delete agent Gopu (${mockRole.title})`,
    });
    await userEvent.click(button);
    // The confirm and the outcome note name the same card the same way.
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining(`Remove "Gopu (${mockRole.title})"?`),
    );
    expect(
      await screen.findByText(`"Gopu (${mockRole.title})" was deleted.`),
    ).toBeInTheDocument();
  });
});

describe('The screening call is shown in compartments', () => {
  // The recruiter edits a list that IS the call, in order. Grouping by
  // re-ordering the rows would silently re-order the conversation, so the rows
  // stay exactly as they will be asked and a heading marks where each
  // compartment begins.
  const COMPARTMENTED = {
    ...mockRole,
    screening_template: [
      { id: 'q1', question: 'Tell me about yourself and your recent role?', weight: 1, category: 'introduction' as const },
      { id: 'q2', question: 'What does your current role involve day to day?', weight: 1, category: 'profile_relevance' as const },
      { id: 'q3', question: 'How do you handle an unhappy customer?', weight: 1, category: 'profile_relevance' as const },
      { id: 'q4', question: 'How do you feel about working nights regularly?', weight: 1, category: 'shift_fit' as const },
      { id: 'q5', question: 'How long have you stayed in your recent positions?', weight: 1, category: 'stability' as const },
      { id: 'q6', question: 'What is your current annual CTC?', weight: 1, category: 'compensation' as const },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
    mockApi.listRoles.mockResolvedValue([COMPARTMENTED]);
    mockApi.updateRole.mockResolvedValue(COMPARTMENTED);
  });

  it('HEADS each compartment, once', async () => {
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');

    for (const label of ['Introduction', 'Profile relevance', 'Shift fit', 'Stability', 'Compensation and notice']) {
      expect(screen.getAllByText(label), label).toHaveLength(1);
    }
  });

  it('KEEPS THE ROWS IN CALL ORDER, because the plan copies the array verbatim', async () => {
    // `0044`'s builder materialises `screening_template` in order, so this
    // list is the conversation. Sorting or bucketing the rows for display
    // would change what the bot actually asks.
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');

    const values = [1, 2, 3, 4, 5, 6].map(
      (n) => (screen.getByLabelText(`Question ${n}`) as HTMLInputElement).value,
    );
    expect(values).toEqual(COMPARTMENTED.screening_template.map((q) => q.question));
  });

  it('CARRIES the category through an edit, like `mandatory`', async () => {
    // The PUT replaces `screening_template` wholesale, so a category dropped
    // on load is a category deleted on save — the same defect `mandatory` had.
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');
    await userEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mockApi.updateRole).toHaveBeenCalled());
    const body = mockApi.updateRole.mock.calls[0][1] as {
      screening_template: Array<{ id: string; category?: string }>;
    };
    expect(body.screening_template.map((q) => q.category)).toEqual(
      COMPARTMENTED.screening_template.map((q) => q.category),
    );
  });

  it('GIVES AN ADDED QUESTION ITS OWN BREAK, not the previous compartment', async () => {
    // "Add question" appends a row with no category. Rendering it under
    // "Compensation and notice" would tell the recruiter their new question
    // belongs to a compartment it has nothing to do with — and the earlier
    // guard, `q.category != null`, did exactly that: removing the guard
    // altogether left all 41 tests green while producing an EMPTY <h4>.
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');
    await userEvent.click(screen.getByRole('button', { name: /Add question/i }));
    await screen.findByLabelText('Question 7');

    expect(screen.getAllByText('Additional questions')).toHaveLength(1);
    // No heading may be empty: an empty <h4> is invisible on screen and an
    // `empty-heading` violation to a screen reader.
    for (const heading of screen.getAllByRole('heading', { level: 4 })) {
      expect(heading.textContent?.trim()).toBeTruthy();
    }
  });

  it('RENDERS NO HEADING for a compartment this build does not know', async () => {
    // `category` arrives off the wire and the label lookup is typed as total
    // but is not. A sixth compartment added API-side must not render an empty
    // heading in a form that has not shipped its name yet.
    mockApi.listRoles.mockResolvedValue([
      {
        ...mockRole,
        screening_template: [
          { id: 'q1', question: 'Tell me about yourself?', weight: 1, category: 'introduction' as const },
          // Deliberately not a member of the union; this is what drift looks
          // like on the wire, and TypeScript cannot see it because the API
          // response is cast rather than parsed.
          { id: 'q2', question: 'How do you pick your tools?', weight: 1, category: 'tooling_fit' as unknown as 'stability' },
        ],
      },
    ]);
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');

    expect(screen.getAllByText('Introduction')).toHaveLength(1);
    for (const heading of screen.getAllByRole('heading', { level: 4 })) {
      expect(heading.textContent?.trim()).toBeTruthy();
    }
    // The row still renders and is still editable — an unknown compartment
    // costs a heading, never the question.
    expect((screen.getByLabelText('Question 2') as HTMLInputElement).value).toBe(
      'How do you pick your tools?',
    );
  });

  it('TAGS EACH ROW WITH ITS TOPIC, not with the id', async () => {
    // `q1`, `q2`, `q3` say only where a question sits. The ids are ours, minted
    // by the generator, and a stakeholder reading the screen wants to know
    // which topic it came from — which the compartment already records.
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');

    for (const tag of ['intro', 'relevance', 'shift', 'stability', 'pay']) {
      expect(screen.getAllByText(tag).length, tag).toBeGreaterThan(0);
    }
    // And the ids are gone from that slot.
    for (const id of ['q1', 'q2', 'q4']) {
      expect(screen.queryByText(id), id).not.toBeInTheDocument();
    }
  });

  it('keeps the id as the tag for a role that has no topics', async () => {
    // An older role carries no category, and its id is all there is.
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');
    expect(screen.getByText(mockRole.screening_template[0].id)).toBeInTheDocument();
  });

  it('renders an OLDER role with no categories at all', async () => {
    // Every role authored before compartments existed has none. An
    // uncategorised question is ungrouped, not broken.
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    expect(await screen.findByLabelText('Question 1')).toBeInTheDocument();
    expect(screen.queryByText('Profile relevance')).not.toBeInTheDocument();
  });
});

describe('Scorebar — the metric library moved here from Mission Control', () => {
  // Every describe in this file resets its own mocks. Without it the call
  // COUNTS leak across tests, which is exactly what the mount test below
  // asserts on.
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getRoleScorecard.mockResolvedValue({ scorecard: { metrics: [] } });
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
  });

  const trigger = () => screen.queryByRole('button', { name: 'Scorebar' });

  it('is INVISIBLE to a non-admin, because the API would refuse them anyway', async () => {
    // Every `/api/scorecards/metrics` route is `requireRole('admin')`. A
    // trigger shown to an interviewer opens a drawer onto a 403 and a save
    // that cannot land, so the control does not exist for them at all.
    mockAuth = { role: 'interviewer' };
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);
    await screen.findByRole('button', { name: /edit/i });
    expect(trigger()).toBeNull();
  });

  it('opens the drawer for an admin and closes it back onto the trigger', async () => {
    mockAuth = { role: 'admin' };
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    render(<RolesPage />);

    const open = await screen.findByRole('button', { name: 'Scorebar' });
    // The trigger says what it does before it is pressed.
    expect(open).toHaveAttribute('aria-haspopup', 'dialog');
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(open);
    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveAccessibleName('Scorebar');
    expect(screen.getByRole('button', { name: 'Scorebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Scorebar' })).toHaveFocus();
  });

  it('stays reachable WHILE editing a role — that is the whole point of the move', async () => {
    // `New agent` is hidden once the form is open. The metric library must not
    // be, or an admin has to leave a half-written role to reach it.
    mockAuth = { role: 'admin' };
    mockApi.listRoles.mockResolvedValue([mockRole]);
    render(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Question 1');

    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
    expect(trigger()).toBeInTheDocument();
  });

  it("a dialog ON TOP of the drawer keeps Escape and Tab to itself — the drawer and the admin's typing survive", async () => {
    // The Scorebar is a SlideOver; Ask Hello's "Replace what you've written?"
    // is a Dialog portalled on top of it. Both listen for keys on the
    // document. Before the modal stack, one Escape closed BOTH — unmounting
    // the create form and losing the metric being typed — and the two Tab
    // traps pinned focus to the dialog's first control, so "Replace with
    // Hello's draft" could not be reached by keyboard at all.
    mockAuth = { role: 'admin' };
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    render(<RolesPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Scorebar' }));
    const drawer = await screen.findByRole('dialog', { name: 'Scorebar' });
    // The create form opens on demand, from the library's own toolbar.
    await userEvent.click(await within(drawer).findByRole('button', { name: 'New metric' }));
    await within(drawer).findByRole('region', { name: 'Add a metric' });
    await userEvent.type(within(drawer).getByLabelText('Name'), 'Ownership');
    await userEvent.type(within(drawer).getByLabelText('Scoring instruction'), 'My own instruction.');
    await userEvent.type(within(drawer).getByLabelText('1 Poor'), 'No example.');

    // Existing text, so Ask Hello asks before replacing it.
    await userEvent.click(within(drawer).getByRole('button', { name: /^Ask Hello/ }));
    const confirm = await screen.findByRole('dialog', { name: "Replace what you've written?" });
    expect(confirm).toHaveFocus();

    // Tab walks the dialog's own controls, all the way to the one that matters.
    await userEvent.tab();
    expect(within(confirm).getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();
    expect(within(confirm).getByRole('button', { name: 'Keep my text' })).toHaveFocus();
    await userEvent.tab();
    expect(
      within(confirm).getByRole('button', { name: "Replace with Hello's draft" }),
    ).toHaveFocus();

    // Escape closes ONLY the dialog.
    await userEvent.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: "Replace what you've written?" }),
    ).not.toBeInTheDocument();
    const stillOpen = screen.getByRole('dialog', { name: 'Scorebar' });
    expect(within(stillOpen).getByLabelText('Name')).toHaveValue('Ownership');
    expect(within(stillOpen).getByLabelText('Scoring instruction')).toHaveValue('My own instruction.');
    expect(within(stillOpen).getByLabelText('1 Poor')).toHaveValue('No example.');
    expect(mockApi.draftMetricRubric).not.toHaveBeenCalled();
    // Focus is back on the button that opened the dialog, inside the drawer.
    expect(within(stillOpen).getByRole('button', { name: /^Ask Hello/ })).toHaveFocus();

    // And the drawer has Escape back once the dialog is gone.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scorebar' })).toHaveFocus();
  });

  it('does NOT mount the metric library until the drawer is opened', async () => {
    // The drawer returns null while closed, so the panel's mount-time fetch
    // does not run on every visit to this page.
    mockAuth = { role: 'admin' };
    mockApi.listRoles.mockResolvedValue([mockRole]);
    mockApi.listScorecardMetrics.mockResolvedValue([]);
    render(<RolesPage />);
    await screen.findByRole('button', { name: 'Scorebar' });
    expect(mockApi.listScorecardMetrics).not.toHaveBeenCalled();
  });
});
