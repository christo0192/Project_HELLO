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

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, forwardRef } from 'react';
import { api, ApiError } from '../../api';
import { CandidateButton } from '../design/candidate';
import { cx } from '../design/cx';

/**
 * A distinct accessible name for a leg player's control (WCAG 2.4.6): several
 * leg players render on one page, and "Load recording" N times tells a
 * screen-reader user nothing. The visible text comes FIRST, so the name still
 * contains what is on screen (WCAG 2.5.3, label in name): "Load recording,
 * Call 1 of 2". The single session player (no label) keeps its visible text
 * as its name.
 */
function labelledAction(visible: string, label: string | undefined): string | undefined {
  return label ? `${visible}, ${label}` : undefined;
}

/**
 * What the player is doing, for a host that shows it somewhere else. `message` is set on `error` (the
 * link could not be minted) and on `ready` when the media would not load, which is how an expired link
 * looks: a media element cannot report an HTTP status.
 */
export interface RecordingPlayerStatus {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  message: string | null;
}

/** The player's own fallback words, for when the API says nothing. */
const LOAD_FAILED = 'Failed to load recording';

export interface RecordingPlayerHandle {
  /** Mint the signed URL if not already loaded. Resolves when src is set. */
  load(): Promise<void>;
  /** "Refresh link": re-mint, keeping the position and play state. */
  refresh(): void;
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
  /**
   * M013 S02: play ONE LEG of the session instead of the session recording.
   * The URL is minted through the attempt download route (same role,
   * lifecycle, integrity and audit checks as the call-attempt list), still
   * only on an explicit action.
   */
  attemptId?: string;
  /**
   * Accessible name for the player (and its heading). Each leg's player
   * names its leg, so two players never share a label.
   */
  label?: string;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayState?: (playing: boolean) => void;
  /** The file ran out. `onPlayState(false)` has already been reported. */
  onEnded?: () => void;
  onCanPlay?: () => void;
  /** Reported in the commit, so a host's copy of the state is never a frame behind this row's. */
  onStatus?: (status: RecordingPlayerStatus) => void;
  /**
   * Driven from the tape above the transcript. A seek leaves keyboard focus where it is, because the
   * ticks and quotes it came from stay on screen and focusing the audio would scroll the pane away from
   * the moment. The tape also says how the recording loads, so the idle row does not say it again.
   */
  tapeDriven?: boolean;
  className?: string;
  /**
   * Retained for call-site compatibility. The player is now always the
   * compact toolbar row it used to become only under this flag, so it no
   * longer selects a presentation — it is a no-op alias.
   */
  compact?: boolean;
}

export const RecordingPlayer = forwardRef<RecordingPlayerHandle, RecordingPlayerProps>(
  function RecordingPlayer({ sessionId, attemptId, label, onTimeUpdate, onPlayState, onEnded, onCanPlay, onStatus, tapeDriven = false, className }, ref) {
    // The recording this player points at. A minted URL belongs to exactly
    // one source, so a URL minted for another one is never shown or played,
    // not even in the commit that re-points the player.
    const source = attemptId ? `attempt:${attemptId}` : `session:${sessionId}`;
    const [minted, setMinted] = useState<{ source: string; url: string } | null>(null);
    const url = minted && minted.source === source ? minted.url : null;
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The <audio> refused the URL it was given. Cleared by the next URL.
    const [mediaFailedUrl, setMediaFailedUrl] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement>(null);
    const mountedRef = useRef(true);
    const reqIdRef = useRef(0);
    const pendingLoadPromise = useRef<Promise<void> | null>(null);
    const pendingLoadResolve = useRef<(() => void) | null>(null);
    // Recording-relative offset (sec) requested via playFrom() while the URL
    // is still being minted / the <audio> is not yet ready. Applied once the
    // element mounts and reaches loadedmetadata. Latest write wins.
    const pendingSeekRef = useRef<number | null>(null);
    // Bumped by every playFrom(), so a refresh never restores its saved
    // position over a seek the user asked for while it was re-minting.
    const seekGenRef = useRef(0);
    const tapeDrivenRef = useRef(tapeDriven);
    tapeDrivenRef.current = tapeDriven;
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    const onPlayStateRef = useRef(onPlayState);
    onPlayStateRef.current = onPlayState;

    // What the host was last told. An <audio> taken off the page fires no pause, so a refresh or an
    // unmount says it here, or the host's Pause would stand over nothing.
    const playingRef = useRef(false);
    const reportPlaying = useCallback((playing: boolean) => {
      playingRef.current = playing;
      onPlayStateRef.current?.(playing);
    }, []);
    const reportAudioGone = useCallback(() => {
      if (playingRef.current) reportPlaying(false);
    }, [reportPlaying]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        reportAudioGone();
      };
    }, [reportAudioGone]);

    const phase: RecordingPlayerStatus['phase'] = loading ? 'loading' : error ? 'error' : url ? 'ready' : 'idle';
    const statusMessage = phase === 'error' ? error : phase === 'ready' && mediaFailedUrl === url ? LOAD_FAILED : null;
    useLayoutEffect(() => {
      onStatusRef.current?.({ phase, message: statusMessage });
    }, [phase, statusMessage]);

    // One mint for both sources: the session recording, or one leg of it.
    const mintUrl = useCallback(
      () => (attemptId ? api.getAttemptRecordingDownloadUrl(attemptId) : api.getRecordingDownloadUrl(sessionId)),
      [attemptId, sessionId],
    );

    // Invalidate on a real session (or leg) change, never on mount: there is
    // nothing to invalidate yet. It is a LAYOUT effect so it runs inside the
    // commit, before anything can call the handle. As a passive effect it ran
    // after the commit, and React may yield to the browser in between (a
    // render from a data load, on a slow device): a turn click in that gap
    // started a mint, then this bumped reqIdRef and cleared the queued seek,
    // so the minted URL was dropped as stale and the click did nothing.
    const sourceRef = useRef(source);
    useLayoutEffect(() => {
      if (sourceRef.current === source) return;
      sourceRef.current = source;
      reqIdRef.current += 1;
      pendingLoadPromise.current = null;
      pendingLoadResolve.current = null;
      // Drop any queued seek so it can never apply to a different session.
      pendingSeekRef.current = null;
      setMinted(null);
      setError(null);
      setLoading(false);
    }, [source]);

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

      mintUrl()
        .then((res) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setMinted({ source, url: res.url });
          setLoading(false);
          pendingLoadPromise.current = null;
          pendingLoadResolve.current?.();
          pendingLoadResolve.current = null;
        })
        .catch((e: ApiError) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setError(e.message || LOAD_FAILED);
          setLoading(false);
          pendingLoadPromise.current = null;
          pendingLoadResolve.current?.();
          pendingLoadResolve.current = null;
        });

      return promise;
    }, [mintUrl, source, url, error]);

    // Refresh: capture state, re-mint, restore on canplay
    const refreshUrl = useCallback(() => {
      const el = audioRef.current;
      const wasPlaying = el && !el.paused;
      const savedTime = el?.currentTime ?? 0;
      const seekGen = seekGenRef.current;

      const reqId = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      setMediaFailedUrl(null);
      // The loading row replaces the <audio>. If the new link works, `restore` plays it again.
      reportAudioGone();

      mintUrl()
        .then((res) => {
          if (!mountedRef.current || reqId !== reqIdRef.current) return;
          setMinted({ source, url: res.url });
          setLoading(false);
          // After state commits, restore position
          requestAnimationFrame(() => {
            const a = audioRef.current;
            if (!a || a.src !== res.url) return;
            // A turn clicked during the re-mint wins over the saved position.
            if (seekGenRef.current !== seekGen) return;
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
          setError(e.message || LOAD_FAILED);
          setLoading(false);
        });
    }, [mintUrl, source, reportAudioGone]);

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
        if (!tapeDrivenRef.current) el.focus();
      };
      if (el.readyState >= 1 /* HAVE_METADATA */) {
        run();
      } else {
        el.addEventListener('loadedmetadata', run, { once: true });
        try { el.load(); } catch { /* preload="none" kick; ignore in jsdom */ }
      }
    }, []);

    // Once the signed URL is set and the <audio> is on screen, apply any queued
    // seek. `loading` is a dependency too: during a "Refresh link" re-mint the
    // URL is kept but the loading row replaces the <audio>, so a click then
    // finds no element; it is applied when the player is back, even when the
    // refreshed URL is unchanged (the url alone would not re-run this).
    useEffect(() => {
      if (url && !loading) applyPendingSeek();
    }, [url, loading, applyPendingSeek]);

    // Imperative handle
    useImperativeHandle(ref, () => ({
      load() { return fetchUrl(); },
      refresh() { refreshUrl(); },
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
        seekGenRef.current += 1;
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
    }), [fetchUrl, refreshUrl, applyPendingSeek, url, error]);

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
          <h3 className="sr-only">{label ?? 'Recording'}</h3>
          {!tapeDriven && (
            <p className="text-label text-[var(--c-ink-secondary)]">
              Recording loads on request; the link expires automatically.
            </p>
          )}
          <CandidateButton
            variant="secondary"
            className="shrink-0"
            onClick={fetchUrl}
            aria-label={labelledAction('Load recording', label)}
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
          <p className="text-label text-[var(--c-ink-secondary)]">Loading recording…</p>
        </div>
      );
    }

    // ── error state ──────────────────────────────────────────────
    if (error) {
      return (
        <div className={cx(row, className)} role="alert">
          <h3 className="sr-only">{label ?? 'Recording'}</h3>
          <p className="text-label text-[var(--c-ink-secondary)]">{error}</p>
          <CandidateButton
            variant="secondary"
            className="shrink-0"
            onClick={fetchUrl}
            aria-label={labelledAction('Try again', label)}
          >
            Try again
          </CandidateButton>
        </div>
      );
    }

    // ── active player ────────────────────────────────────────────
    return (
      <div className={cx('flex flex-col gap-1.5', className)}>
        <h3 className="sr-only">{label ?? 'Recording'}</h3>
        <audio
          ref={audioRef}
          // The fixed id belongs to the single session player; a leg player
          // has none, so several legs never repeat an id.
          id={attemptId ? undefined : 'sync-workspace-audio'}
          controls
          preload="none"
          src={url!}
          className="h-9 w-full"
          aria-label={label ? `${label} recording player` : 'Session recording player'}
          // Media events as props: React wires them when the element is created,
          // so none is missed between the <audio> appearing and a passive effect
          // subscribing (the old addEventListener effect ran after the commit).
          onPlay={() => reportPlaying(true)}
          onPause={() => reportPlaying(false)}
          onEnded={() => {
            reportPlaying(false);
            onEnded?.();
          }}
          onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
          onCanPlay={() => onCanPlay?.()}
          onError={() => setMediaFailedUrl(url)}
        >
          <a href={url!} target="_blank" rel="noreferrer">
            Download recording
          </a>
        </audio>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            href={url!}
            download
            className="textlink text-xs font-medium text-[var(--c-accent)]"
            aria-label={labelledAction('Download file', label)}
          >
            Download file
          </a>
          <button
            type="button"
            onClick={refreshUrl}
            aria-label={labelledAction('Refresh link', label)}
            className="textlink text-xs font-medium text-[var(--c-ink-secondary)] hover:text-[var(--c-ink)]"
          >
            Refresh link
          </button>
        </div>
      </div>
    );
  },
);
