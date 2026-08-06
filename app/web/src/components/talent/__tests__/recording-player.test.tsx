/**
 * RecordingPlayer — on-demand URL, load-and-seek, refresh, errors, accessibility.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecordingPlayer } from '../RecordingPlayer';
import type { RecordingPlayerHandle } from '../RecordingPlayer';

const mockApi = {
  getRecordingDownloadUrl: vi.fn(),
};

vi.mock('../../../api', () => ({
  api: {
    getRecordingDownloadUrl: (...args: any[]) => mockApi.getRecordingDownloadUrl(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

// Stub HTMLMediaElement
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-ignore — jsdom stubs
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return 0; },
    set(_v: number) {},
  });
});

function renderPlayer(props: Partial<Parameters<typeof RecordingPlayer>[0]> = {}) {
  const ref = { current: null as RecordingPlayerHandle | null };
  const result = render(
    <RecordingPlayer
      sessionId="session-1"
      {...props}
      ref={(r: RecordingPlayerHandle | null) => { ref.current = r; }}
    />,
  );
  return { ...result, ref };
}

describe('RecordingPlayer', () => {
  it('does NOT fetch a recording URL on mount', () => {
    renderPlayer();
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('shows Load recording button initially', () => {
    renderPlayer();
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();
  });

  it('fetches the signed URL only when Load recording is clicked', async () => {
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    expect(document.querySelector('audio')).toHaveAttribute('src', 'https://x.invalid/rec');
  });

  it('shows an error and retry button when fetch fails', async () => {
    mockApi.getRecordingDownloadUrl.mockRejectedValue({ message: 'fetch failed' });
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    expect(await screen.findByText('fetch failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('retries on Try again click', async () => {
    mockApi.getRecordingDownloadUrl
      .mockRejectedValueOnce({ message: 'fail' })
      .mockResolvedValueOnce({ url: 'https://x.invalid/rec2' });
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    expect(await screen.findByText('fail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledTimes(2));
  });

  it('shows Refresh link after successful load', async () => {
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    expect(await screen.findByText(/refresh link/i)).toBeInTheDocument();
  });

  it('exposes hasUrl=false before load and true after', async () => {
    mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    const { ref } = renderPlayer();
    expect(ref.current?.hasUrl).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(ref.current?.hasUrl).toBe(true));
  });

  it('has no axe violations in idle state', async () => {
    const { container } = renderPlayer();
    await expect(container).toHaveNoViolations();
  });
});
