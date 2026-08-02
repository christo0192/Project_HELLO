import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppealPage } from './AppealPage';

const { submitAppeal } = vi.hoisted(() => ({ submitAppeal: vi.fn() }));
vi.mock('../api', () => ({
  api: { submitAppeal },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/appeal']}>
      <AppealPage />
    </MemoryRouter>,
  );
}

describe('AppealPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submitAppeal.mockResolvedValue({ ok: true, appeal_id: 'appeal-1' });
  });

  it('missing fragment → no API call, fail-closed error', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/missing, expired, revoked, or already used/i)).toBeInTheDocument();
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it('removes the token fragment immediately and keeps it out of the URL', async () => {
    window.history.replaceState(null, '', '/appeal#synthetic-grant-token');
    renderPage();
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.pathname).toBe('/appeal');
  });

  it('submits a bounded appeal with category and description', async () => {
    window.history.replaceState(null, '', '/appeal#synthetic-grant-token');
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Category')).toBeInTheDocument();
    });
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'recording');
    await userEvent.type(
      screen.getByLabelText('Description'),
      'The recording cut off mid-answer.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Submit appeal' }));

    await waitFor(() => {
      expect(submitAppeal).toHaveBeenCalledWith({
        appeal_grant_token: 'synthetic-grant-token',
        category: 'recording',
        description: 'The recording cut off mid-answer.',
      });
    });
    expect(await screen.findByText('Appeal submitted')).toBeInTheDocument();
  });

  it('shows the human-review message after submission', async () => {
    window.history.replaceState(null, '', '/appeal#synthetic-grant-token');
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Category')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByLabelText('Description'), 'Please re-check.');
    await userEvent.click(screen.getByRole('button', { name: 'Submit appeal' }));
    expect(
      await screen.findByText(/automated decision use for this screening is paused/i),
    ).toBeInTheDocument();
  });

  it('surfaces stable errors without retrying the token', async () => {
    const { ApiError } = await import('../api');
    submitAppeal.mockRejectedValue(new ApiError('appeal_grant_invalid_or_expired', 404));
    window.history.replaceState(null, '', '/appeal#synthetic-grant-token');
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Category')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByLabelText('Description'), 'Please re-check.');
    await userEvent.click(screen.getByRole('button', { name: 'Submit appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('appeal_grant_invalid_or_expired');
  });

  it('has no axe violations', async () => {
    window.history.replaceState(null, '', '/appeal#synthetic-grant-token');
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeInTheDocument());
    await expect(container).toHaveNoViolations();
  });
});
