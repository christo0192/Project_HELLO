/**
 * R1RecordingRow: a titled group around one attempt's player. The title names the group and the
 * player's controls; the row adds no controls of its own.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { R1AttemptSummary } from '../../../lib/r1-types';
import { R1RecordingRow } from '../R1RecordingRow';

const mockApi = vi.hoisted(() => ({ getR1Recording: vi.fn() }));

vi.mock('../../../api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

function attempt(over: Partial<R1AttemptSummary['recording']> = {}): R1AttemptSummary {
  return {
    session_id: 'session-7',
    attempt_number: 2,
    counted: true,
    outcome: 'completed',
    recording: { state: 'ready', reason: null, mode: 'single', has_video: true, ...over },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getR1Recording.mockResolvedValue({ state: 'deleted', reason: 'retention' });
});

describe('R1RecordingRow', () => {
  it('is a group named by the attempt, with the attempt as its heading', () => {
    render(<R1RecordingRow roundId="round-1" attempt={attempt()} label="Attempt 2 (retake)" />);
    const group = screen.getByRole('group', { name: 'Attempt 2 (retake)' });
    expect(within(group).getByRole('heading', { level: 3, name: 'Attempt 2 (retake)' })).toBeInTheDocument();
  });

  it('puts the label in the player\'s controls, and mints for this round and this attempt\'s session', () => {
    render(<R1RecordingRow roundId="round-9" attempt={attempt()} label="Attempt 2 (retake)" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load recording, Attempt 2 (retake)' }));
    expect(mockApi.getR1Recording).toHaveBeenCalledWith('round-9', 'session-7');
  });

  it('adds no control of its own: a ready recording has exactly one button', () => {
    render(<R1RecordingRow roundId="round-1" attempt={attempt()} label="Attempt 1 (counted)" />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('two rows have distinct group names', () => {
    render(
      <>
        <R1RecordingRow roundId="round-1" attempt={attempt()} label="Attempt 1 (counted)" />
        <R1RecordingRow roundId="round-1" attempt={{ ...attempt(), session_id: 'session-8' }} label="Attempt 2 (retake)" />
      </>,
    );
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby'))).toHaveLength(2);
    expect(new Set(screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby'))).size).toBe(2);
  });

  it('"Check again" is passed up when the recording is still processing', () => {
    const onNeedRefresh = vi.fn();
    render(
      <R1RecordingRow
        roundId="round-1"
        attempt={attempt({ state: 'processing' })}
        label="Attempt 1 (counted)"
        onNeedRefresh={onNeedRefresh}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again, Attempt 1 (counted)' }));
    expect(onNeedRefresh).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(<R1RecordingRow roundId="round-1" attempt={attempt()} label="Attempt 1 (counted)" />);
    await expect(container).toHaveNoViolations();
  });
});
