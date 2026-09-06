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
 * - Renders as a single toolbar ROW (no card chrome): it sits directly under
 *   the Transcript card's title, so the host card owns the surface. The old
 *   bordered box was the only thing in a 20rem column and left the rest of
 *   that column empty.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { api, ApiError } from '../../api';
import { CandidateButton } from '../design/candidate';
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
  /**
   * Retained for call-site compatibility. The player is now always the
   * compact toolbar row it used to become only under this flag, so it no
   * longer selects a presentation — it is a no-op alias.
   */
  compact?: boolean;
}

export const RecordingPlayer = forwardRef<RecordingPlayerHandle, RecordingPlayerProps>(
  function RecordingPlayer({ sessionId, onTimeUpdate, onPlayState, onCanPlay, className }, ref) {
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

    // The player is a TOOLBAR ROW inside the Transcript card, not a card of
    // its own: the old bordered box left a 20rem column empty beneath it.
    // Every state is therefore a single row with no surface chrome; the host
    // card supplies the surface.
    const row = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2';

    // ── idle state (no URL fetched yet) ──────────────────────────
    // Must exclude the error case: an error also has url==null && !loading,
    // so without the !error guard this branch would shadow the error state
    // below and swallow the failure message + retry affordance.
    if (!url && !loading && !error) {
      return (
        <div className={cx(row, className)}>
          <h3 className="sr-only">Recording</h3>
          <p className="text-[13px] text-[var(--c-ink-secondary)]">
            Recording loads on request; the link expires automatically.
          </p>
          <CandidateButton
            variant="secondary"
            className="shrink-0"
            onClick={fetchUrl}
          >
            Load recording
          </CandidateButton>
        </div>
      );
    }

    // ── loading state ────────────────────────────────────────────
    if (loading) {
      return (
        <div className={cx('flex items-center gap-3', className)}>
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--c-accent)] border-t-transparent" />
          <p className="text-[13px] text-[var(--c-ink-secondary)]">Loading recording…</p>
        </div>
      );
    }

    // ── error state ──────────────────────────────────────────────
    if (error) {
      return (
        <div className={cx(row, className)} role="alert">
          <h3 className="sr-only">Recording</h3>
          <p className="text-[13px] text-[var(--c-ink-secondary)]">{error}</p>
          <CandidateButton
            variant="secondary"
            className="shrink-0"
            onClick={fetchUrl}
          >
            Try again
          </CandidateButton>
        </div>
      );
    }

    // ── active player ────────────────────────────────────────────
    return (
      <div className={cx('flex flex-col gap-1.5', className)}>
        <h3 className="sr-only">Recording</h3>
        <audio
          ref={audioRef}
          id="sync-workspace-audio"
          controls
          preload="none"
          src={url!}
          className="h-9 w-full"
          aria-label="Session recording player"
        >
          <a href={url!} target="_blank" rel="noreferrer">
            Download recording
          </a>
        </audio>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
            className="text-xs font-medium text-[var(--c-ink-secondary)] underline-offset-2 hover:text-[var(--c-ink)] hover:underline"
          >
            Refresh link
          </button>
        </div>
      </div>
    );
  },
);
