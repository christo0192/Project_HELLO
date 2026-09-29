/**
 * LiveCallPanel accessibility tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiveCallPanel } from './LiveCallPanel';

/**
 * What the mocked client serves, and every `on()` registration, so a test can
 * put the panel mid-call and deliver a broadcast. Hoisted: `vi.mock`
 * factories run before imports.
 */
const rt = vi.hoisted(() => ({
  /** The row `call_sessions … limit(1)` returns; `null` means no call. */
  latestSession: null as Record<string, unknown> | null,
  listeners: [] as Array<{
    type: string;
    filter: { event?: string };
    handler: (payload: unknown) => void;
  }>,
}));

// Mock supabase — the factory is hoisted, so use plain object/function,
// no vi.fn() calls inside the factory.
vi.mock('../lib/supabase', () => {
  // A channel object that supports chaining on().on().subscribe()
  const makeChannel = () => {
    const channel: any = {};
    channel.on = (type: string, filter: { event?: string }, handler: (payload: unknown) => void) => {
      rt.listeners.push({ type, filter, handler });
      return channel;
    };
    channel.subscribe = () => 'mock-sub';
    return channel;
  };

  // A query builder that supports from().select().eq().order().limit(), and
  // is itself awaitable where the panel awaits `order()` (transcript turns).
  const makeQuery = () => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.limit = () =>
      Promise.resolve({ data: rt.latestSession ? [rt.latestSession] : null, error: null });
    q.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
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
    rt.latestSession = null;
    rt.listeners.length = 0;
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

  it('keeps the interim words readable: full ink on a solid tint, never faded white', async () => {
    // Was white text on the accent at opacity 70%: ~2.95:1, which fails the
    // 4.5:1 WCAG 1.4.3 asks of 14px text.
    rt.latestSession = {
      id: 's-live',
      candidate_id: 'candidate-1',
      role_id: null,
      mode: 'phone',
      status: 'in_progress',
      started_at: '2026-09-30T05:00:00Z',
      ended_at: null,
      duration_sec: null,
    };
    const { container } = render(
      <LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    await screen.findByRole('region', { name: 'Live transcript' });
    const interim = rt.listeners.find(
      (l) => l.type === 'broadcast' && l.filter.event === 'interim',
    );
    expect(interim).toBeDefined();
    act(() => interim!.handler({ payload: { text: 'I have five years in support' } }));

    const words = await screen.findByText(/I have five years in support/);
    const bubble = words.closest('[data-interim]') as HTMLElement;
    const classes = bubble.className.split(/\s+/);
    // Nothing fades the whole bubble (text included) any more…
    expect(classes.some((c) => c.startsWith('opacity-'))).toBe(false);
    // …and the words are ink on the soft tint, not white on the accent.
    expect(classes).toContain('text-ink');
    expect(classes).toContain('bg-info-soft');
    expect(classes).not.toContain('text-white');
    // "Not final yet" is still said, by style rather than by fading.
    expect(classes).toContain('italic');
    expect(classes).toContain('border-dashed');

    // No 11px text anywhere in the panel: the smallest step is text-meta.
    expect(container.innerHTML).not.toContain('text-[11px]');
    expect(screen.getByText('Jane Doe').className.split(/\s+/)).toContain('text-meta');
  });

  it('has no axe violations in empty state', async () => {
    const { container } = render(
      <LiveCallPanel candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    await expect(container).toHaveNoViolations();
  });
});
