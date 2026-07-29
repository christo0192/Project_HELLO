/**
 * LiveCallPanel accessibility tests.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiveCallPanel } from './LiveCallPanel';

// Mock supabase — the factory is hoisted, so use plain object/function,
// no vi.fn() calls inside the factory.
vi.mock('../lib/supabase', () => {
  // A channel object that supports chaining on().on().subscribe()
  const makeChannel = () => {
    const channel: any = {};
    channel.on = () => channel;
    channel.subscribe = () => 'mock-sub';
    return channel;
  };

  // A query builder that supports from().select().eq().order().limit()
  const makeQuery = () => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: null, error: null });
    return q;
  };

  return {
    supabase: {
      from: () => makeQuery(),
      channel: () => makeChannel(),
      removeChannel: () => {},
    },
  };
});

describe('LiveCallPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders header', () => {
    render(<LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />);
    expect(screen.getByText('Live call')).toBeInTheDocument();
  });

  it('shows "No active call" empty state', () => {
    render(<LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />);
    expect(screen.getByText('No active call')).toBeInTheDocument();
    expect(
      screen.getByText('Click Start Screening to begin.'),
    ).toBeInTheDocument();
  });

  it('has no axe violations in empty state', async () => {
    const { container } = render(
      <LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    await expect(container).toHaveNoViolations();
  });
});
