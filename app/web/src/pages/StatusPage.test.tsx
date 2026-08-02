import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusPage } from './StatusPage';

const { status } = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../api', () => ({
  api: { status },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

describe('StatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({
      status: 'ok',
      maintenance: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('renders operational status from /api/status', async () => {
    render(<StatusPage />);
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    expect(status).toHaveBeenCalled();
  });

  it('renders maintenance state with the bounded reason', async () => {
    status.mockResolvedValue({
      status: 'maintenance',
      maintenance: { enabled: true, reason: 'Planned window', updated_at: '2026-01-01T00:00:00.000Z' },
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    render(<StatusPage />);
    expect(await screen.findByText('Scheduled maintenance')).toBeInTheDocument();
    expect(screen.getByText('Planned window')).toBeInTheDocument();
  });

  it('renders degraded state without internal details', async () => {
    status.mockResolvedValue({
      status: 'degraded',
      maintenance: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    render(<StatusPage />);
    expect(await screen.findByText('Service degraded')).toBeInTheDocument();
    // No model/provider/internal leakage.
    expect(screen.queryByText(/model|provider|database|haiku|sonnet/i)).not.toBeInTheDocument();
  });

  it('shows an error when the status call fails', async () => {
    status.mockRejectedValue({ message: 'unreachable' });
    render(<StatusPage />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<StatusPage />);
    await screen.findByText('All systems operational');
    await expect(container).toHaveNoViolations();
  });
});
