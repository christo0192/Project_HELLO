/**
 * The recording chips on the R1 tab: which attempts get one, what each says, and that the tab embeds no
 * player, so each page has only one. The recording plays on the review page, which every row links to.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { R1ListedAttempt, R1RecordingSummary, R1Round } from '../../../lib/r1-types';
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

function recording(over: Partial<R1RecordingSummary> = {}): R1RecordingSummary {
  return {
    state: 'ready',
    reason: null,
    mode: 'single',
    has_video: true,
    started_at_ms: 1_790_000_000_000,
    duration_ms: 423_000,
    camera_off_ms: 0,
    degraded_at_ms: null,
    retention_until: '2027-01-12T10:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

function attempt(n: number, over: Partial<R1ListedAttempt> & { rec?: Partial<R1RecordingSummary> } = {}): R1ListedAttempt {
  const { rec, ...rest } = over;
  return {
    session_id: `session-${n}`, attempt_number: n, counted: true, outcome: 'completed', in_progress: false, session_status: 'completed',
    started_at: null, ended_at: null, consent_withdrawn: false, recording: recording(rec), ...rest,
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

function renderSection(role: 'admin' | 'interviewer' | 'viewer' = 'viewer') {
  return render(
    <MemoryRouter>
      <R1Section candidateId="cand-1" candidateName="Ava Rao" role={role} userId="user-1" />
    </MemoryRouter>,
  );
}

const rows = () => screen.findByRole('list', { name: 'R1 rounds' });
const chipWords = () => {
  const list = screen.queryByRole('list', { name: 'Recordings' });
  return list ? within(list).getAllByRole('listitem').map((chip) => chip.textContent) : [];
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
  api.getR1Availability.mockResolvedValue({ state: 'ready', hold_minutes: 55 });
});

describe('no player on this tab', () => {
  it('draws no video or audio, offers no Load, and mints nothing', async () => {
    const { container } = renderSection('admin');
    await rows();
    expect(container.querySelector('video, audio')).toBeNull();
    expect(screen.queryByRole('button', { name: /load recording/i })).toBeNull();
    expect(api.getR1Recording).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'interviewer', 'admin'] as const)('still gives a %s the way to the recording: the review', async (role) => {
    renderSection(role);
    await rows();
    expect(screen.getByRole('link', { name: 'Open R1 review' })).toHaveAttribute('href', '/interviews/round-1');
  });
});

describe('what a chip means', () => {
  it.each([
    ['ready', 'Ready', 'bg-ready-soft'],
    ['partial', 'Partial', 'bg-unresolved-soft'],
    ['deleted', 'Deleted', 'bg-closed-soft'],
  ] as const)('puts a %s recording on its family\'s wash', async (state, word, wash) => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { rec: { state } })] })] });
    renderSection();
    await rows();
    expect(screen.getByText(`Attempt 1 (counted): ${word}`)).toHaveClass(wash);
  });

  it('leaves No recording neutral', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { rec: { state: 'none' } })] })] });
    renderSection();
    await rows();
    expect(screen.getByText('Attempt 1 (counted): No recording').className).not.toMatch(/\bbg-(?:moving|ready|unresolved|closed)-soft\b/);
  });
});

describe('which attempts get a chip', () => {
  it('a completed round says plainly when an attempt has no recording', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { rec: { state: 'none' } })] })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual(['Recording: Attempt 1 (counted): No recording']);
  });

  it('an invited round with no attempts has none', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'invited', attempts_counted: 0, attempts: [] })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual([]);
  });

  it('an invited round whose first attempt was recorded (a retake is pending) shows that recording', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'invited' })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual(['Recording: Attempt 1 (counted): Ready']);
  });

  it('a live round has no "no recording" chip for an attempt that has not recorded yet', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'in_progress', attempts: [attempt(1, { rec: { state: 'none' } })] })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual([]);
  });

  it('an older API without attempts adds nothing and does not crash', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: undefined })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual([]);
  });

  it('ignores an attempt entry with no recording', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [{ ...attempt(1), recording: undefined as never }] })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual([]);
  });
});

describe('what a chip says', () => {
  it('names each attempt with its own state', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ attempts_counted: 2, attempts: [attempt(1), attempt(2, { rec: { state: 'partial' } })] })],
    });
    renderSection();
    await rows();
    expect(chipWords()).toEqual(['Recording: Attempt 1 (counted): Ready', 'Recording: Attempt 2 (retake): Partial']);
  });

  it('labels an attempt that did not count', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { counted: false })] })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual(['Recording: Attempt 1 (not counted): Ready']);
  });

  it.each([
    [{ state: 'recording' }, 'Recording'],
    [{ state: 'processing' }, 'Processing'],
    [{ state: 'failed', reason: 'capture_failed' }, 'Unavailable'],
    [{ state: 'deleted', reason: 'consent_withdrawn' }, 'Deleted'],
  ] as const)('reads %j as a word', async (rec, word) => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ attempts: [attempt(1, { rec })] })] });
    renderSection();
    await rows();
    expect(chipWords()).toEqual([`Recording: Attempt 1 (counted): ${word}`]);
  });
});

describe('accessibility', () => {
  it('has no axe violations with a chip in each of several states', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ attempts: [attempt(1), attempt(2, { rec: { state: 'processing' } }), attempt(3, { rec: { state: 'deleted', reason: 'retention' } })] })],
    });
    const { container } = renderSection('admin');
    await rows();
    await expect(container).toHaveNoViolations();
  });
});
