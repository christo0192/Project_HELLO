/**
 * The recording rows on the R1 card (Overview tab): which attempts get a row, who sees it, what a
 * viewer can do with it, the labels, the refresh path, and that a hidden tab pauses the media.
 *
 * The player itself is covered in R1RecordingPlayer.test.tsx; here it is exercised through the card,
 * as a staff member meets it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { R1AttemptSummary, R1RecordingSummary, R1Round } from '../../../lib/r1-types';
import { R1Section } from '../R1Section';

const api = vi.hoisted(() => ({
  listR1Rounds: vi.fn(),
  getR1Availability: vi.fn(),
  getR1Recording: vi.fn(),
  sendR1Round: vi.fn(),
  cancelR1Round: vi.fn(),
  reissueR1Round: vi.fn(),
  grantR1Retake: vi.fn(),
}));

vi.mock('../../../api', () => ({
  api,
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const START = 1_790_000_000_000;
const MINT_URL = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/r1/x/video.mp4?X-Amz-Signature=SIG_ROW_1';

function recording(over: Partial<R1RecordingSummary> = {}): R1RecordingSummary {
  return {
    state: 'ready',
    reason: null,
    mode: 'single',
    has_video: true,
    started_at_ms: START,
    duration_ms: 423_000,
    camera_off_ms: 0,
    degraded_at_ms: null,
    retention_until: '2027-01-12T10:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

function attempt(n: number, over: Partial<R1AttemptSummary> & { rec?: Partial<R1RecordingSummary> } = {}): R1AttemptSummary {
  const { rec, ...rest } = over;
  return {
    session_id: `session-${n}`,
    attempt_number: n,
    counted: true,
    outcome: 'completed',
    recording: recording(rec),
    ...rest,
  };
}

function round(over: Partial<R1Round> = {}): R1Round {
  return {
    id: 'round-1',
    status: 'completed',
    expires_at: '2026-10-09T10:00:00.000Z',
    attempts_allowed: 2,
    attempts_counted: 1,
    recommendation: null,
    overall: null,
    created_at: '2026-10-06T10:00:00.000Z',
    created_by: 'creator-1',
    attempts: [attempt(1)],
    ...over,
  };
}

function renderSection(
  role: 'admin' | 'interviewer' | 'viewer' = 'viewer',
  over: { userId?: string | null; active?: boolean } = {},
) {
  const props = { candidateId: 'cand-1', candidateName: 'Ava Rao', role, userId: 'user-1', ...over };
  const view = render(
    <MemoryRouter>
      <R1Section {...props} />
    </MemoryRouter>,
  );
  return {
    ...view,
    rerenderWith: (next: { active?: boolean }) =>
      view.rerender(
        <MemoryRouter>
          <R1Section {...props} {...next} />
        </MemoryRouter>,
      ),
  };
}

const rows = async () => screen.findByRole('list', { name: 'R1 rounds' });
const loadButtons = () => screen.queryAllByRole('button', { name: /^load recording/i });

beforeEach(() => {
  vi.clearAllMocks();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
  api.getR1Availability.mockResolvedValue({ state: 'ready', hold_minutes: 55 });
  api.getR1Recording.mockResolvedValue({
    ...recording(),
    url: MINT_URL,
    content_type: 'video/mp4',
    expires_in_sec: 300,
  });
});

describe('who sees a recording row', () => {
  it('a viewer sees a completed round with a ready recording: exactly one button, Load recording', async () => {
    renderSection('viewer');
    await rows();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Load recording, Attempt 1 (counted)');
    expect(screen.getByRole('heading', { name: 'Attempt 1 (counted)' })).toBeInTheDocument();
    expect(screen.getByText(/Length 7m 3s/)).toBeInTheDocument();
    // Read-only: none of the round's actions.
    for (const name of ['Reissue link', 'Cancel round', 'Grant retake', 'Send R1']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(api.getR1Availability).not.toHaveBeenCalled();
  });

  it('an interviewer who owns the candidate but did not create the round sees the row, not the actions', async () => {
    renderSection('interviewer', { userId: 'user-1' });
    await rows();
    expect(loadButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Grant retake' })).not.toBeInTheDocument();
  });

  it('the creator and an admin see the row beside the round actions', async () => {
    renderSection('admin', { userId: 'admin-1' });
    await rows();
    expect(loadButtons()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Grant retake' })).toBeInTheDocument();
  });

  it('an invited round with no attempts has no recording row (and keeps a viewer button-free)', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'invited', attempts_counted: 0, attempts: [] })] });
    renderSection('viewer');
    await rows();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Attempt/ })).not.toBeInTheDocument();
  });

  it('an invited round whose first attempt was recorded (a retake is pending) shows that recording', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'invited', attempts_counted: 1 })] });
    renderSection('viewer');
    await rows();
    expect(loadButtons()).toHaveLength(1);
  });

  it('a live round shows no "no recording" line for an attempt that has not recorded yet', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ status: 'in_progress', attempts: [attempt(1, { rec: { state: 'none' } })] })],
    });
    renderSection('viewer');
    await rows();
    expect(screen.queryByText('No recording was made for this attempt.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Attempt/ })).not.toBeInTheDocument();
  });

  it('a completed round says plainly when an attempt has no recording', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { rec: { state: 'none' } })] })] });
    renderSection('viewer');
    await rows();
    expect(screen.getByText('No recording was made for this attempt.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('an older API without attempts adds nothing and does not crash', async () => {
    const legacy = round();
    delete legacy.attempts;
    api.listR1Rounds.mockResolvedValue({ rounds: [legacy] });
    renderSection('viewer');
    await rows();
    expect(screen.queryByRole('heading', { name: /Attempt/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ignores an attempt entry with no recording', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ attempts: [{ session_id: 's', attempt_number: 1, counted: true } as unknown as R1AttemptSummary] })],
    });
    renderSection('viewer');
    await rows();
    expect(screen.queryByRole('heading', { name: /Attempt/ })).not.toBeInTheDocument();
  });
});

describe('one row per attempt', () => {
  it('labels the first counted attempt counted and the second the retake, each with its own button', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ attempts_counted: 2, attempts: [attempt(1), attempt(2)] })],
    });
    renderSection('viewer');
    await rows();
    expect(screen.getByRole('heading', { name: 'Attempt 1 (counted)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Attempt 2 (retake)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load recording, Attempt 1 (counted)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load recording, Attempt 2 (retake)' })).toBeInTheDocument();
  });

  it('labels an attempt that did not count', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ attempts: [attempt(1, { counted: false, rec: { state: 'failed', reason: 'capture_failed' } }), attempt(2)] })],
    });
    renderSection('viewer');
    await rows();
    expect(screen.getByRole('heading', { name: 'Attempt 1 (not counted)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Attempt 2 (counted)' })).toBeInTheDocument();
    expect(screen.getByText('Recording failed during the interview.')).toBeInTheDocument();
  });

  it('each row groups its own player, named by the attempt', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ attempts: [attempt(1), attempt(2, { rec: { state: 'processing' } })] })],
    });
    renderSection('viewer');
    await rows();
    const first = screen.getByRole('group', { name: 'Attempt 1 (counted)' });
    const second = screen.getByRole('group', { name: 'Attempt 2 (retake)' });
    expect(within(first).getByRole('button', { name: /load recording/i })).toBeInTheDocument();
    expect(within(second).queryByRole('button', { name: /load recording/i })).not.toBeInTheDocument();
    expect(within(second).getByText('The recording is being prepared. This usually takes a few minutes.')).toBeInTheDocument();
  });

  it('every state in the list is drawn for its attempt', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [
        round({
          attempts: [
            attempt(1, { rec: { state: 'deleted', reason: 'retention', deleted_at: '2027-01-12T10:00:00.000Z' } }),
            attempt(2, { rec: { state: 'recording' } }),
            attempt(3, { rec: { state: 'partial', reason: 'audio_only_degraded', degraded_at_ms: 60_000 } }),
          ],
        }),
      ],
    });
    renderSection('viewer');
    await rows();
    expect(screen.getByText(/This recording was deleted on .*2027 after the retention period\./)).toBeInTheDocument();
    expect(screen.getByText('In progress. It can be played a few minutes after the interview ends.')).toBeInTheDocument();
    expect(screen.getByText('Video stopped at 1:00 to protect the interview; the rest is audio only.')).toBeInTheDocument();
    expect(loadButtons()).toHaveLength(1);
  });
});

describe('playing from the card', () => {
  it('mints nothing until Load is pressed, then with (round id, session id) and shows the video', async () => {
    renderSection('viewer');
    await rows();
    expect(api.getR1Recording).not.toHaveBeenCalled();
    fireEvent.click(loadButtons()[0]);
    expect(api.getR1Recording).toHaveBeenCalledWith('round-1', 'session-1');
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(document.querySelector('video')).toHaveAttribute('src', MINT_URL);
    expect(document.body.textContent).not.toContain('SIG_ROW_1');
  });

  it('a viewer who is refused (403) is told so in words', async () => {
    api.getR1Recording.mockRejectedValue(Object.assign(new Error('access_denied'), { status: 403 }));
    renderSection('viewer');
    await rows();
    fireEvent.click(loadButtons()[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to this recording.');
  });

  it('"Check again" on a processing recording re-reads the rounds', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { rec: { state: 'processing' } })] })] });
    renderSection('viewer');
    await rows();
    expect(api.listR1Rounds).toHaveBeenCalledTimes(1);
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    fireEvent.click(screen.getByRole('button', { name: 'Check again, Attempt 1 (counted)' }));
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(2));
    // The re-read found it ready: Load is offered now.
    expect(await screen.findByRole('button', { name: 'Load recording, Attempt 1 (counted)' })).toBeInTheDocument();
  });

  it('pauses the media when the tab is hidden (active=false) and keeps the link', async () => {
    const view = renderSection('viewer', { active: true });
    await rows();
    fireEvent.click(loadButtons()[0]);
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video') as HTMLVideoElement;
    const pause = vi.fn();
    video.pause = pause;
    view.rerenderWith({ active: false });
    expect(pause).toHaveBeenCalled();
    expect(document.querySelector('video')).toBe(video);
    expect(video).toHaveAttribute('src', MINT_URL);
  });

  it('a re-read of the list does not drop a player that is already loaded', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'invited', attempts_counted: 1 })] });
    renderSection('interviewer', { userId: 'creator-1' });
    await rows();
    fireEvent.click(loadButtons()[0]);
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    const video = document.querySelector('video');
    // Cancelling the round re-reads the list; the recording on screen stays.
    api.cancelR1Round.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel round' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Cancel this R1 round?' })).getByRole('button', { name: 'Cancel round' }));
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(2));
    expect(document.querySelector('video')).toBe(video);
  });
});

describe('accessibility', () => {
  it('has no axe violations with a recording row in each of several states', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [
        round({
          attempts: [
            attempt(1),
            attempt(2, { rec: { state: 'processing' } }),
            attempt(3, { counted: false, rec: { state: 'failed', reason: 'integrity' } }),
          ],
        }),
      ],
    });
    const { container } = renderSection('viewer');
    await rows();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with the video loaded', async () => {
    const { container } = renderSection('viewer');
    await rows();
    fireEvent.click(loadButtons()[0]);
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    await expect(container).toHaveNoViolations();
  });
});
