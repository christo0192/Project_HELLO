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

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RolesPage } from './RolesPage';
import { mockRole } from '../test/helpers';

const mockApi = {
  listRoles: vi.fn(),
  createRole: vi.fn(),
  updateRole: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    createRole: (...args: any[]) => mockApi.createRole(...args),
    updateRole: (...args: any[]) => mockApi.updateRole(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

describe('RolesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Job description')).toBeInTheDocument();
    expect(screen.getByLabelText('Required skills')).toBeInTheDocument();
  });

  it('reaches form fields via keyboard tab', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    render(<RolesPage />);
    const user = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'New role' });
    await user.click(btn);

    // Tab from the New role button to the form's Title field
    await user.tab();
    const titleInput = screen.getByLabelText('Title');
    expect(document.activeElement).toBe(titleInput);

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

    await user.type(screen.getByLabelText('Title'), 'Engineer{Enter}');
    expect(mockApi.createRole).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Engineer' }),
    );
  });

  it('new role form validates required title', async () => {
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.createRole.mockResolvedValue({ id: 'new-id' });
    render(<RolesPage />);
    const btn = await screen.findByRole('button', { name: 'New role' });
    await userEvent.click(btn);

    // Submit without title
    const submitBtn = screen.getByRole('button', { name: 'Create role' });
    await userEvent.click(submitBtn);
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
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
