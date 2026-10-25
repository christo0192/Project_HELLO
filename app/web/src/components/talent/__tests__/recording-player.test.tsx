/**
 * RecordingPlayer — on-demand URL, load-and-seek, refresh, errors, accessibility.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecordingPlayer } from '../RecordingPlayer';
import type { RecordingPlayerHandle } from '../RecordingPlayer';

const mockApi = {
  getRecordingDownloadUrl: vi.fn(),
  getAttemptRecordingDownloadUrl: vi.fn(),
};

vi.mock('../../../api', () => ({
  api: {
    getRecordingDownloadUrl: (...args: any[]) => mockApi.getRecordingDownloadUrl(...args),
    getAttemptRecordingDownloadUrl: (...args: any[]) => mockApi.getAttemptRecordingDownloadUrl(...args),
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

/*
 * playFrom() races. React runs a commit's passive effects (useEffect) AFTER the
 * commit, and when the render that mounted the player came from a data load
 * (not a click) it may yield to the browser in between: on a slow device, or a
 * loaded CI runner, once the render has used its time slice. A turn click that
 * lands in that gap reaches playFrom() before the player's own effects have run.
 *
 * The host below occupies exactly that slot, deterministically: its layout
 * effect runs after the commit that mounted (or re-pointed) the player and
 * before any passive effect of that commit.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function PlayOnCommit(props: { sessionId: string; attemptId?: string; offset: number }) {
  const ref = useRef<RecordingPlayerHandle>(null);
  const { sessionId, attemptId, offset } = props;
  useLayoutEffect(() => {
    ref.current?.playFrom(offset);
  }, [sessionId, attemptId, offset]);
  return <RecordingPlayer ref={ref} sessionId={sessionId} attemptId={attemptId} />;
}

describe('RecordingPlayer: playFrom before the commit\'s effects have run', () => {
  const readyStateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
  // Every seek, with the src of the element it was applied to.
  let seeks: Array<[string | null, number]>;

  beforeEach(() => {
    seeks = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return 2; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return 0; },
      set(this: HTMLMediaElement, v: number) { seeks.push([this.getAttribute('src'), v]); },
    });
  });

  afterEach(() => {
    if (readyStateDesc) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', readyStateDesc);
  });

  it('a click in the commit that MOUNTS the player still seeks and plays once the URL is minted', async () => {
    const mint = deferred<{ url: string }>();
    mockApi.getRecordingDownloadUrl.mockReturnValue(mint.promise);

    render(<PlayOnCommit sessionId="session-1" offset={54.66} />);
    expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledTimes(1);
    expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1');

    // The mint resolves only after the mount's passive effects have all run.
    await act(async () => { mint.resolve({ url: 'https://x.invalid/session' }); });

    expect(document.querySelector('audio')).toHaveAttribute('src', 'https://x.invalid/session');
    expect(seeks).toEqual([['https://x.invalid/session', 54.66]]);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('the same holds for a leg player (attemptId)', async () => {
    const mint = deferred<{ url: string }>();
    mockApi.getAttemptRecordingDownloadUrl.mockReturnValue(mint.promise);

    render(<PlayOnCommit sessionId="session-phone" attemptId="leg-b" offset={3} />);
    expect(mockApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-b');
    await act(async () => { mint.resolve({ url: 'https://x.invalid/leg-b' }); });

    expect(seeks).toEqual([['https://x.invalid/leg-b', 3]]);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('a click in the commit that SWITCHES the session seeks the new recording, never the old one', async () => {
    mockApi.getRecordingDownloadUrl.mockImplementation((id: string) => Promise.resolve({ url: `https://x.invalid/${id}` }));

    const view = render(<PlayOnCommit sessionId="s1" offset={5} />);
    await waitFor(() => expect(seeks).toEqual([['https://x.invalid/s1', 5]]));

    view.rerender(<PlayOnCommit sessionId="s2" offset={7} />);
    await waitFor(() => expect(document.querySelector('audio')).toHaveAttribute('src', 'https://x.invalid/s2'));
    await waitFor(() => expect(seeks).toEqual([['https://x.invalid/s1', 5], ['https://x.invalid/s2', 7]]));
    expect(mockApi.getRecordingDownloadUrl.mock.calls).toEqual([['s1'], ['s2']]);
  });

  it('a seek queued for one session is dropped when the session changes before its URL arrives', async () => {
    const mint = deferred<{ url: string }>();
    mockApi.getRecordingDownloadUrl.mockReturnValue(mint.promise);
    const ref = { current: null as RecordingPlayerHandle | null };
    const view = render(<RecordingPlayer ref={(r) => { ref.current = r; }} sessionId="s1" />);

    act(() => ref.current!.playFrom(12));
    view.rerender(<RecordingPlayer ref={(r) => { ref.current = r; }} sessionId="s2" />);
    await act(async () => { mint.resolve({ url: 'https://x.invalid/s1' }); });

    expect(document.querySelector('audio')).toBeNull();
    expect(screen.getByRole('button', { name: /load recording/i })).toBeInTheDocument();
    expect(seeks).toEqual([]);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('a click while "Refresh link" re-mints is applied when the refreshed URL arrives, even if unchanged', async () => {
    mockApi.getRecordingDownloadUrl.mockResolvedValueOnce({ url: 'https://x.invalid/rec' });
    const { ref } = renderPlayer();
    act(() => ref.current!.playFrom(5));
    await waitFor(() => expect(seeks).toEqual([['https://x.invalid/rec', 5]]));

    const refresh = deferred<{ url: string }>();
    mockApi.getRecordingDownloadUrl.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: /refresh link/i }));
    expect(document.querySelector('audio')).toBeNull(); // the loading row replaces the player

    act(() => ref.current!.playFrom(9));
    await act(async () => { refresh.resolve({ url: 'https://x.invalid/rec' }); });

    await waitFor(() => expect(seeks).toEqual([['https://x.invalid/rec', 5], ['https://x.invalid/rec', 9]]));
  });
});
