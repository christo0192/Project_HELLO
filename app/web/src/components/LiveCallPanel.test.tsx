/**
 * LiveCallPanel accessibility tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('shows the "No call in progress" empty state', () => {
    render(<LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />);
    expect(screen.getByText('No call in progress')).toBeInTheDocument();
    expect(
      screen.getByText('The transcript appears here when a screening starts.'),
    ).toBeInTheDocument();
  });

  it('animates its "still listening" dots with a calm opacity pulse, never a bounce', () => {
    // The interim bubble only appears mid-call over a realtime channel, so
    // the motion contract is pinned on the source: no bounce anywhere, and
    // the pulse is gated on motion-safe so reduced motion leaves it static.
    const source = readFileSync(resolve(__dirname, 'LiveCallPanel.tsx'), 'utf8');
    expect(source).not.toMatch(/animate-bounce/);
    const pulses = source.match(/motion-safe:animate-\[pulse_[^\]]*\]/g) ?? [];
    expect(pulses).toHaveLength(3);
    expect(source).not.toMatch(/(?<!motion-safe:)animate-\[pulse/);
  });

  it('has no axe violations in empty state', async () => {
    const { container } = render(
      <LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    await expect(container).toHaveNoViolations();
  });
});
