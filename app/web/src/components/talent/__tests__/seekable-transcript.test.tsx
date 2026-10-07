/**
 * SeekableTranscript — clickable timed turns, non-interactive untimed,
 * active highlight, aria-current, keyboard, legacy degradation, axe.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SeekableTranscript } from '../SeekableTranscript';
import type { TranscriptLine } from '../../../types';

const TIMED: TranscriptLine[] = [
  { speaker: 'bot', text: 'Welcome!', start_offset_sec: 0.0 },
  { speaker: 'candidate', text: 'Hi!', start_offset_sec: 3.5 },
  { speaker: 'bot', text: 'Tell me about your experience.', start_offset_sec: 8.2 },
];

const LEGACY: TranscriptLine[] = [
  { speaker: 'bot', text: 'Welcome!', start_offset_sec: null },
  { speaker: 'candidate', text: 'Hi!', start_offset_sec: null },
];

const MIXED: TranscriptLine[] = [
  { speaker: 'bot', text: 'Welcome!', start_offset_sec: 0.0 },
  { speaker: 'candidate', text: 'Hi!', start_offset_sec: null },
];

describe('SeekableTranscript', () => {
  it('renders timed turns as buttons (always, even without recordingReady)', () => {
    render(
      <SeekableTranscript
        transcript={TIMED}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={false}
      />,
    );
    // All 3 turns should be buttons
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('calls onSeek with the correct offset when a timed turn is clicked', () => {
    const onSeek = vi.fn();
    render(
      <SeekableTranscript
        transcript={TIMED}
        activeTurnIndex={null}
        onSeek={onSeek}
        recordingReady={true}
      />,
    );
    fireEvent.click(screen.getAllByRole('button')[1]); // candidate turn, offset 3.5
    expect(onSeek).toHaveBeenCalledWith(3.5);
  });

  it('highlights the active turn with aria-current="true"', () => {
    render(
      <SeekableTranscript
        transcript={TIMED}
        activeTurnIndex={1}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).not.toHaveAttribute('aria-current');
    expect(buttons[1]).toHaveAttribute('aria-current', 'true');
    expect(buttons[2]).not.toHaveAttribute('aria-current');
  });

  it('marks the active turn with a tint and a leading dot, never a side stripe', () => {
    const { container } = render(
      <SeekableTranscript
        transcript={TIMED}
        activeTurnIndex={1}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    const buttons = screen.getAllByRole('button');
    // The marker is decorative (aria-current carries the state) and only on
    // the active turn.
    const markers = container.querySelectorAll('[data-active-turn-marker]');
    expect(markers).toHaveLength(1);
    expect(buttons[1].contains(markers[0])).toBe(true);
    expect(markers[0]).toHaveAttribute('aria-hidden', 'true');
    // Side-stripe borders are banned by the design system.
    expect(container.innerHTML).not.toMatch(/border-[lr]-\d/);
  });

  it('renders untimed turns as non-interactive divs (not buttons)', () => {
    render(
      <SeekableTranscript
        transcript={LEGACY}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByText(/no timing data/i)).toHaveLength(2);
  });

  it('handles mixed timed/untimed turns correctly', () => {
    render(
      <SeekableTranscript
        transcript={MIXED}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/no timing data/i)).toBeInTheDocument();
  });

  it('a turn with a call time but no seek offset shows that time, not "no timing data", and is not clickable', () => {
    render(
      <SeekableTranscript
        transcript={LEGACY}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
        turnTimes={[{ sec: 2 }, { sec: 65 }]}
        unseekableReason="Recording failed for this call, so its turns cannot start playback."
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/no timing data/i)).toBeNull();
    expect(screen.getByText('0:02')).toBeInTheDocument();
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(screen.getByLabelText(/Turn 1: .*0:02 into the call.*Recording failed for this call/)).toBeInTheDocument();
    // Every turn has a time, so the "saved without timing" banner stays away.
    expect(screen.queryByText(/saved without timing/i)).toBeNull();
  });

  it('falls back to an IST clock time when only the absolute start is known', () => {
    render(
      <SeekableTranscript
        transcript={[LEGACY[0]]}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
        turnTimes={[{ sec: null, atMs: Date.parse('2026-10-03T03:43:01Z') }]}
      />,
    );
    expect(screen.getByText(/IST$/)).toBeInTheDocument();
  });

  it('shows the informational banner when recording is not yet loaded', () => {
    render(
      <SeekableTranscript
        transcript={TIMED}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={false}
      />,
    );
    expect(screen.getByText(/automatically load the recording/i)).toBeInTheDocument();
  });

  it('shows an empty state when transcript is empty', () => {
    render(
      <SeekableTranscript
        transcript={[]}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    expect(
      screen.getByText(/No transcript lines recorded/i),
    ).toBeInTheDocument();
  });

  it('shows loading skeleton', () => {
    render(
      <SeekableTranscript
        transcript={[]}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
        isLoading
      />,
    );
    expect(screen.getByRole('status', { name: /loading transcript/i })).toBeInTheDocument();
  });

  it('shows error with retry button', () => {
    const onRetry = vi.fn();
    render(
      <SeekableTranscript
        transcript={[]}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
        error="Failed to load"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('has no axe violations with timed turns', async () => {
    const { container } = render(
      <SeekableTranscript
        transcript={TIMED}
        activeTurnIndex={0}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with legacy/null turns', async () => {
    const { container } = render(
      <SeekableTranscript
        transcript={LEGACY}
        activeTurnIndex={null}
        onSeek={vi.fn()}
        recordingReady={true}
      />,
    );
    await expect(container).toHaveNoViolations();
  });
});
