/**
 * RecordingPlayer — single <audio> element with MIG-06 on-demand signed URL.
 *
 * - URL is fetched ONLY via explicit user action (never on mount).
 * - Short-TTL expiry handled with "Refresh link" that re-mints.
 * - Stale responses ignored via generation counter + mounted guard.
 * - Exposes imperative handle: load(), seek(offsetSec), play(), pause().
 * - load() returns a Promise that resolves when the signed URL is set.
 * - Refresh preserves currentTime and play state where possible.
 * - Emits onTimeUpdate(currentTime) and onPlayState(playing) for parent sync.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { api, ApiError } from '../../api';
import { CandidateButton } from '../design';
import { cx } from '../design/cx';

export interface RecordingPlayerHandle {
  /** Mint the signed URL if not already loaded. Resolves when src is set. */
  load(): Promise<void>;
  seek(offsetSec: number): void;
  play(): void;
  pause(): void;
  /**
   * Play from a recording-relative offset. Owns the full click-to-play
   * lifecycle so a transcript click BEFORE the recording is loaded works:
   *   - if the signed URL already exists, seek + play immediately;
   *   - otherwise mint the short-lived URL, wait for the <audio> element to
   *     actually mount, wait for media readiness (loadedmetadata), then seek
   *     and play. The latest requested offset wins on rapid clicks.
   * Session changes clear any queued offset, so a stale seek never applies
   * to a different session's recording.
   */
  playFrom(offsetSec: number): void;
  readonly currentTime: number;
  readonly hasUrl: boolean;
}

export interface RecordingPlayerProps {
  sessionId: string;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayState?: (playing: boolean) => void;
  onCanPlay?: () => void;
  className?: string;
  compact?: boolean;
}

export const RecordingPlayer = forwardRef<RecordingPlayerHandle, RecordingPlayerProps>(
  function RecordingPlayer({ sessionId, onTimeUpdate, onPlayState, onCanPlay, className, compact = false }, ref) {
    const [url, setUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement>(null);
    const mountedRef = useRef(true);
    const reqIdRef = useRef(0);
    const pendingLoadPromise = useRef<Promise<void> | null>(null);
    const pendingLoadResolve = useRef<(() => void) | null>(null);
    // Recording-relative offset (sec) requested via playFrom() while the URL
    // is still being minted / the <audio> is not yet ready. Applied once the
    // element mounts and reaches loadedmetadata. Latest write wins.
    const pendingSeekRef = useRef<number | null>(null);

    useEffect(() => {
      mountedRef.current = true;
      return () => { mountedRef.current = false; };
    }, []);

    // Invalidate on session change
    useEffect(() => {
      reqIdRef.current += 1;
      pendingLoadPromise.current = null;
      pendingLoadResolve.current = null;
      // Drop any queued seek so it can never apply to a different session.
      pendingSeekRef.current = null;
      setUrl(null);
      setError(null);
      setLoading(false);
    }, [sessionId]);

    const fetchUrl = useCallback((): Promise<void> => {
      // If already loaded with a URL, resolve immediately
      if (url && !error) return Promise.resolve();

      // If a load is already in flight, return the existing promise
      if (pendingLoadPromise.current) return pendingLoadPromise.current;

      const reqId = ++reqIdRef.current;
      setLoading(true);
      setError(null);

      const promise = new Promise<void>((resolve) => {
        pendingLoadResolve.current = resolve;
      });
      pendingLoadPromise.current = promise;

      api
        .getRecordingDownloadUrl(sessionId)
        .then((res) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setUrl(res.url);
          setLoading(false);
          pendingLoadPromise.current = null;
          pendingLoadResolve.current?.();
          pendingLoadResolve.current = null;
        })
        .catch((e: ApiError) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setError(e.message || 'Failed to load recording');
          setLoading(false);
          pendingLoadPromise.current = null;
          pendingLoadResolve.current?.();
          pendingLoadResolve.current = null;
        });

      return promise;
    }, [sessionId, url, error]);

    // Refresh: capture state, re-mint, restore on canplay
    const refreshUrl = useCallback(() => {
      const el = audioRef.current;
      const wasPlaying = el && !el.paused;
      const savedTime = el?.currentTime ?? 0;

      const reqId = ++reqIdRef.current;
      setLoading(true);
      setError(null);

      api
        .getRecordingDownloadUrl(sessionId)
        .then((res) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setUrl(res.url);
          setLoading(false);
          // After state commits, restore position
          requestAnimationFrame(() => {
            const a = audioRef.current;
            if (!a || a.src !== res.url) return;
            const restore = () => {
              if (savedTime > 0.1) { a.currentTime = savedTime; }
              if (wasPlaying) a.play().catch(() => {});
            };
            if (a.readyState >= 2) restore();
            else a.addEventListener('canplay', restore, { once: true });
          });
        })
        .catch((e: ApiError) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setError(e.message || 'Failed to load recording');
          setLoading(false);
        });
    }, [sessionId]);

    // Apply a queued playFrom() offset against the (now-mounted) <audio>.
    // With preload="none" the element may be at HAVE_NOTHING, so kick a
    // metadata load and seek+play on loadedmetadata; if it is already at
    // HAVE_METADATA or better, seek+play immediately. Never throws.
    const applyPendingSeek = useCallback(() => {
      const el = audioRef.current;
      if (!el) return;
      const offset = pendingSeekRef.current;
      if (offset == null) return;
      const run = () => {
        pendingSeekRef.current = null;
        try { el.currentTime = Math.max(0, offset); } catch { /* jsdom / not seekable yet */ }
        el.play().catch(() => { /* autoplay gesture may be lost after async mint */ });
        // P2-2: move focus to the player so keyboard users land on the controls.
        el.focus();
      };
      if (el.readyState >= 1 /* HAVE_METADATA */) {
        run();
      } else {
        el.addEventListener('loadedmetadata', run, { once: true });
        try { el.load(); } catch { /* preload="none" kick; ignore in jsdom */ }
      }
    }, []);

    // Once the signed URL is set (and the <audio> has committed to the DOM),
    // apply any queued seek. Refresh re-mints set a fresh URL but leave
    // pendingSeekRef null, so this is a no-op for the refresh path.
    useEffect(() => {
      if (url) applyPendingSeek();
    }, [url, applyPendingSeek]);

    // Media events
    useEffect(() => {
      const el = audioRef.current;
      if (!el) return;
      const onPlay = () => onPlayState?.(true);
      const onPause = () => onPlayState?.(false);
      const onEnded = () => onPlayState?.(false);
      const onTimeUp = () => { onTimeUpdate?.(el.currentTime); };
      const onCp = () => onCanPlay?.();

      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);
      el.addEventListener('timeupdate', onTimeUp);
      el.addEventListener('canplay', onCp);
      return () => {
        el.removeEventListener('play', onPlay);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('ended', onEnded);
        el.removeEventListener('timeupdate', onTimeUp);
        el.removeEventListener('canplay', onCp);
      };
    }, [onPlayState, onTimeUpdate, onCanPlay, url]);

    // Imperative handle
    useImperativeHandle(ref, () => ({
      load() { return fetchUrl(); },
      seek(offsetSec: number) {
        const el = audioRef.current;
        if (!el) return;
        el.currentTime = Math.max(0, offsetSec);
      },
      play() {
        audioRef.current?.play().catch(() => {});
      },
      pause() {
        audioRef.current?.pause();
      },
      playFrom(offsetSec: number) {
        // Latest requested offset wins on rapid clicks.
        pendingSeekRef.current = offsetSec;
        if (url != null && error == null) {
          // URL already minted and <audio> mounted — apply now. (The url
          // effect won't re-fire because url is unchanged.)
          applyPendingSeek();
        } else {
          // Mint the short-lived URL; the url effect applies the queued seek
          // once the <audio> element mounts and reaches readiness.
          void fetchUrl();
        }
      },
      get currentTime() {
        return audioRef.current?.currentTime ?? 0;
      },
      get hasUrl() {
        return url != null && error == null;
      },
    }), [fetchUrl, applyPendingSeek, url, error]);

    // ── idle state (no URL fetched yet) ──────────────────────────
    // Must exclude the error case: an error also has url==null && !loading,
    // so without the !error guard this branch would shadow the error state
    // below and swallow the failure message + retry affordance.
    if (!url && !loading && !error) {
      return (
        <div className={cx(
          'rounded-lg border border-line bg-surface p-3',
          compact && 'p-2',
          className,
        )}>
          <div className={cx('flex items-center gap-3', compact && 'gap-2')}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary shrink-0">
              Recording
            </h3>
            {!compact && (
              <p className="text-xs text-ink-tertiary">
                A short-lived link is created on request and expires automatically.
              </p>
            )}
            <CandidateButton
              variant="secondary"
              className={cx('shrink-0', compact ? 'px-3 py-2 text-xs' : 'mt-0')}
              onClick={fetchUrl}
            >
              Load recording
            </CandidateButton>
          </div>
        </div>
      );
    }

    // ── loading state ────────────────────────────────────────────
    if (loading) {
      return (
        <div className={cx('rounded-lg border border-line bg-surface p-3', compact && 'p-2', className)}>
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--c-accent)] border-t-transparent" />
            <p className="text-xs text-ink-tertiary">Loading recording…</p>
          </div>
        </div>
      );
    }

    // ── error state ──────────────────────────────────────────────
    if (error) {
      return (
        <div className={cx('rounded-lg border border-line bg-surface p-3', compact && 'p-2', className)} role="alert">
          <div className={cx('flex items-center gap-3', compact && 'gap-2')}>
            <p className="text-sm text-error">{error}</p>
            <CandidateButton
              variant="secondary"
              className={cx('shrink-0', compact ? 'px-3 py-2 text-xs' : 'mt-0')}
              onClick={fetchUrl}
            >
              Try again
            </CandidateButton>
          </div>
        </div>
      );
    }

    // ── active player ────────────────────────────────────────────
    return (
      <div className={cx('rounded-lg border border-line bg-surface p-3', compact && 'p-2', className)}>
        <div className={cx('flex items-center gap-3', compact && 'flex-col items-stretch gap-1')}>
          <h3 className={cx('text-xs font-semibold uppercase tracking-wide text-ink-secondary', compact && 'sr-only')}>
            Recording
          </h3>
          {compact && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary" aria-hidden>
              Recording
            </span>
          )}
          <audio
            ref={audioRef}
            id="sync-workspace-audio"
            controls
            preload="none"
            src={url!}
            className={cx('h-9 w-full', compact && 'h-10')}
            aria-label="Session recording player"
          >
            <a href={url!} target="_blank" rel="noreferrer">
              Download recording
            </a>
          </audio>
        </div>
        <div className={cx('mt-2 flex flex-wrap items-center gap-3', compact && 'mt-1 gap-2')}>
          <a
            href={url!}
            download
            className="text-xs font-medium text-[var(--c-accent)] underline-offset-2 hover:underline"
          >
            Download file
          </a>
          <button
            type="button"
            onClick={refreshUrl}
            className="text-xs font-medium text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Refresh link
          </button>
        </div>
      </div>
    );
  },
);
