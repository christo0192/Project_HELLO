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
