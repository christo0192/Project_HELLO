/**
 * RecordingCard — signed-URL lifecycle: on-demand fetch only, expiry refresh,
 * inline errors, no URL exposure until active, and axe compliance.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecordingCard } from '../RecordingCard';

const getRecordingDownloadUrl = vi.fn();

/** `<audio>` has no ARIA role — query the raw element. */
function audioEl(): HTMLAudioElement | null {
  return document.querySelector('audio');
}

vi.mock('../../../api', () => ({
  api: {
    getRecordingDownloadUrl: (...args: any[]) => getRecordingDownloadUrl(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

describe('RecordingCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT fetch the signed URL on render (explicit action only)', () => {
    render(<RecordingCard sessionId="s1" />);
    expect(getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();
  });

  it('fetches the short-lived URL only when the recruiter clicks', async () => {
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    render(<RecordingCard sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(getRecordingDownloadUrl).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(audioEl()).not.toBeNull());
    expect(audioEl()?.src).toContain('x.invalid/rec');
  });

  it('exposes the URL only through the media href when active', async () => {
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    const { container } = render(<RecordingCard sessionId="s1" />);
    expect(container.innerHTML).not.toContain('x.invalid/rec');
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(audioEl()).not.toBeNull());
    expect(container.innerHTML).toContain('x.invalid/rec');
  });

  it('re-mints a fresh URL via Refresh link (expiry handling)', async () => {
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec1' });
    render(<RecordingCard sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    await waitFor(() => expect(audioEl()).not.toBeNull());
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec2' });
    fireEvent.click(screen.getByRole('button', { name: /refresh link/i }));
    await waitFor(() => expect(getRecordingDownloadUrl).toHaveBeenCalledTimes(2));
    expect(audioEl()).toHaveAttribute('src', 'https://x.invalid/rec2');
  });

  it('shows an inline error with a retry path when the fetch fails', async () => {
    getRecordingDownloadUrl.mockRejectedValue({ message: 'link expired' });
    render(<RecordingCard sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /load recording/i }));
    expect(await screen.findByText('link expired')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
    const { container } = render(<RecordingCard sessionId="s1" />);
    await expect(container).toHaveNoViolations();
  });
});
