import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneAttemptHistory } from '../CandidateOverviewSections';

const getCandidatePhoneAttempts = vi.fn();
const getAttemptRecordingDownloadUrl = vi.fn();

vi.mock('../../../api', () => ({
  api: {
    getCandidatePhoneAttempts: (...args: unknown[]) => getCandidatePhoneAttempts(...args),
    getAttemptRecordingDownloadUrl: (...args: unknown[]) => getAttemptRecordingDownloadUrl(...args),
  },
}));

const ATTEMPT = {
  id: '00000000-0000-4000-8000-000000000001',
  attempt_seq: 1,
  admitted_at: '2026-09-25T13:00:00.000Z',
  answered_at: '2026-09-25T13:00:01.000Z',
  ended_at: '2026-09-25T13:00:09.000Z',
  state: 'ended',
  outcome_class: 'abandoned_pre_disclosure',
  duration_sec: 8,
  recording: { state: 'unavailable', reason: 'no_recording' },
  transcript: {
    href: '/sessions/00000000-0000-4000-8000-000000000002',
    scope: 'session',
    kind: 'gate_only',
    shared_session: true,
  },
};

function renderHistory() {
  return render(
    <MemoryRouter>
      <PhoneAttemptHistory candidateId="candidate-1" role="admin" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getCandidatePhoneAttempts.mockResolvedValue({ attempts: [ATTEMPT], next_cursor: null });
});

describe('PhoneAttemptHistory', () => {
  it('shows gate-only evidence and a truthful no-recording state', async () => {
    renderHistory();
    expect(await screen.findByText('No recording available')).toBeInTheDocument();
    expect(screen.getByText(/Pre-interview gate transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/may include multiple call legs/i)).toBeInTheDocument();
    expect(getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('fetches audio only after an explicit click', async () => {
    getCandidatePhoneAttempts.mockResolvedValue({
      attempts: [{ ...ATTEMPT, recording: { state: 'ready' }, transcript: null }],
      next_cursor: null,
    });
    getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://storage.invalid/signed' });
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderHistory();
    const button = await screen.findByRole('button', { name: /download audio/i });
    expect(getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(getAttemptRecordingDownloadUrl).toHaveBeenCalledWith(ATTEMPT.id));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('https://storage.invalid/signed', '_blank', 'noopener,noreferrer'));
    opened.mockRestore();
  });
});
