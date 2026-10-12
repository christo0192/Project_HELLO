/**
 * R1RecordingPlayer: one R1 attempt's recording, for staff.
 *
 * The signed link is minted ONLY by an explicit action (the Load button, or a click on a transcript
 * turn), never on mount, and it appears nowhere but the media element's `src`: not in text, not in an
 * `aria-*` or `data-*` attribute, not in a console call. Every error is mapped to words; the raw API
 * text never reaches the screen.
 *
 * What it shows, by the summary the host passes (the mint's own answer overrides it):
 *   - ready / partial   a Load button; after it, a <video> (or an <audio> when there is no picture)
 *   - recording, processing, failed, deleted, none, an unknown state
 *                       a status block and no media element at all
 *   - a recovered pair  an <audio> master with controls and a muted <video> follower that is pulled
 *                       back when it drifts more than 0.3 s, with a visible note
 *
 * A media element cannot report an HTTP status, so an expired link looks like any other failure. The
 * rules (measured, research/web-player.md section 0):
 *   - an error AFTER metadata has loaded: one automatic re-mint (none in the last 30 s), then the
 *     position and play state come back; a second error inside that window shows the error block;
 *   - an error BEFORE metadata: the error block at once, no automatic retry (a bad first link is a
 *     real fault);
 *   - at play or seek, a link older than `expires_in_sec - 15` is replaced BEFORE the request, so the
 *     person never sees the stall.
 *
 * A hidden tab keeps the panel mounted, so `active={false}` pauses (position and link survive).
 * Renders inside `.candidate-scope` (`--c-*` tokens only, no motion import).
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { SyntheticEvent } from 'react';
import { api } from '../../api';
import { CandidateButton, Tag } from '../design/candidate';
import {
  driftExceeds,
  isMintStale,
  isPlayableState,
  playbackSources,
  r1MediaErrorMessage,
  r1RecordingErrorMessage,
  r1RecordingErrorRetryable,
  r1RecordingStateCopy,
  shouldAutoRemint,
  turnOffsetSec,
  viewState,
} from '../../lib/r1-recording';
import type { R1PlaybackSources } from '../../lib/r1-recording';
import type { R1RecordingPlayback, R1RecordingState, R1RecordingSummary } from '../../lib/r1-types';

export interface R1RecordingPlayerHandle {
  /** Mint the link if there is none. Resolves when the mint has settled (the player shows the result). */
  load(): Promise<void>;
  /**
   * Play from a recording-relative offset. Owns the whole click-to-play lifecycle: with no link yet it
   * mints one, waits for metadata, then seeks and plays. The latest offset wins on rapid clicks.
   */
  playFrom(offsetSec: number): void;
  /** `playFrom` for a transcript turn: applies the anchor and the lead-in. A turn that cannot be placed is ignored. */
  playFromTurn(turnStartedAtMs: number): void;
  seek(offsetSec: number): void;
  play(): void;
  pause(): void;
  readonly currentTime: number;
  readonly hasUrl: boolean;
}

export interface R1RecordingPlayerProps {
  roundId: string;
  sessionId: string;
  /** From the rounds list (no link). The mint's own answer overrides it once there is one. */
  summary: R1RecordingSummary;
  /** "Attempt 1": the accessible name of this player's controls (several share a page). */
  label: string;
  /** False pauses the media (a hidden tab keeps its panel mounted). Default true. */
  active?: boolean;
  onTimeUpdate?: (sec: number) => void;
  onPlayState?: (playing: boolean) => void;
  /** The mint answered with a different state than the list showed (for example deleted since). */
  onStateChange?: (state: R1RecordingState) => void;
  /** "Check again": the host should re-read the rounds. */
  onNeedRefresh?: () => void;
}

/* ── Internals ────────────────────────────────────────────────────── */

type Phase = 'idle' | 'loading' | 'media' | 'blocked' | 'error';

interface Minted {
  /** Counts mints, so an effect can tell a new link from a re-render. */
  seq: number;
  sources: R1PlaybackSources;
  /** `performance.now()` at the response: the only clock the expiry uses. */
  mintedAt: number;
  expiresInSec: number | null;
}

interface Restore {
  time: number;
  play: boolean;
}

interface ErrorInfo {
  message: string;
  retryable: boolean;
}

const noop = () => undefined;

/** The summary part of a mint answer: the link fields are dropped so a URL is never kept in state twice. */
function summaryOf(playback: R1RecordingPlayback): R1RecordingSummary {
  return {
    state: playback.state,
    reason: playback.reason ?? null,
    mode: playback.mode ?? null,
    has_video: playback.has_video ?? null,
    started_at_ms: playback.started_at_ms ?? null,
    duration_ms: playback.duration_ms ?? null,
    camera_off_ms: playback.camera_off_ms ?? null,
    degraded_at_ms: playback.degraded_at_ms ?? null,
    retention_until: playback.retention_until ?? null,
    deleted_at: playback.deleted_at ?? null,
    timeline_offset_ms: playback.timeline_offset_ms ?? null,
  };
}

function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

function errorCode(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Let go of a media element's network connection. Never throws.
 *
 * Called explicitly where the player drops its media (an error block, a state without a file, a
 * reset, unmount), NEVER from a ref callback: React 19 StrictMode detaches and re-attaches a ref
 * while the element stays live, and a release there would strip the `src` of a healthy player.
 */
function release(el: HTMLMediaElement | null): void {
  if (!el) return;
  try {
    el.pause();
  } catch {
    /* an element that cannot pause has nothing to release */
  }
  try {
    el.removeAttribute('src');
    el.load();
  } catch {
    /* ditto */
  }
}

function sourceKey(sources: R1PlaybackSources): string {
  return sources.kind === 'single' ? sources.url : `${sources.videoUrl}\n${sources.audioUrl}`;
}

/** Whether this browser could decode a type. An unanswerable question is "yes": the element decides. */
function browserCanPlay(contentType: string | null, video: boolean): boolean {
  if (!contentType) return true;
  try {
    const probe = document.createElement(video ? 'video' : 'audio');
    return typeof probe.canPlayType !== 'function' || probe.canPlayType(contentType) !== '';
  } catch {
    return true;
  }
}

/* ── Component ────────────────────────────────────────────────────── */

export const R1RecordingPlayer = forwardRef<R1RecordingPlayerHandle, R1RecordingPlayerProps>(
  function R1RecordingPlayer(props, ref) {
    const { roundId, sessionId, summary, label, active = true } = props;

    const [phase, setPhase] = useState<Phase>('idle');
    const [minted, setMinted] = useState<Minted | null>(null);
    const [override, setOverride] = useState<R1RecordingSummary | null>(null);
    const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [followerFailed, setFollowerFailed] = useState(false);

    // Refs hold what event handlers and the imperative handle read, so none of them goes stale.
    const mountedRef = useRef(true);
    const genRef = useRef(0);
    const seqRef = useRef(0);
    const inflightRef = useRef<Promise<void> | null>(null);
    const mintedRef = useRef<Minted | null>(null);
    const phaseRef = useRef<Phase>('idle');
    const summaryRef = useRef<R1RecordingSummary>(summary);
    const metaRef = useRef(false);
    const restoreRef = useRef<Restore | null>(null);
    const pendingSeekRef = useRef<number | null>(null);
    const lastAutoRemintRef = useRef<number | null>(null);
    const lastTimeRef = useRef(0);
    const lastKeyRef = useRef<string | null>(null);
    const masterRef = useRef<HTMLMediaElement | null>(null);
    const followerRef = useRef<HTMLVideoElement | null>(null);
    // The elements this player last had, kept after React detaches the refs, so unmount can still
    // let go of their connections (refs are already null by the time effect cleanups run).
    const lastMasterRef = useRef<HTMLMediaElement | null>(null);
    const lastFollowerRef = useRef<HTMLMediaElement | null>(null);
    const activeRef = useRef(active);
    const cbRef = useRef(props);

    // Latest props for the handlers below (assigned during render on purpose: they are read only
    // from event handlers and promise callbacks, never during render).
    cbRef.current = props;
    activeRef.current = active;

    const effective = override ?? summary;
    summaryRef.current = effective;
    phaseRef.current = phase;
    mintedRef.current = minted;

    /* ── Lifecycle ─────────────────────────────────────────────────── */

    /** Stop both elements' downloads (the player is about to drop them). */
    const releaseMedia = useCallback(() => {
      release(masterRef.current);
      release(followerRef.current);
    }, []);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        genRef.current += 1;
        inflightRef.current = null;
        // Unmount: the refs are already null, so use the elements remembered from the last render.
        release(lastMasterRef.current);
        release(lastFollowerRef.current);
      };
    }, []);

    /** Back to "nothing loaded": a stale answer can no longer land, nothing is queued. */
    const reset = useCallback(() => {
      releaseMedia();
      genRef.current += 1;
      inflightRef.current = null;
      mintedRef.current = null;
      metaRef.current = false;
      restoreRef.current = null;
      pendingSeekRef.current = null;
      lastAutoRemintRef.current = null;
      lastTimeRef.current = 0;
      lastKeyRef.current = null;
      setMinted(null);
      setOverride(null);
      setErrorInfo(null);
      setRefreshing(false);
      setFollowerFailed(false);
      setPhase('idle');
    }, [releaseMedia]);

    // A different recording (another attempt, another round): start over.
    const identityRef = useRef(`${roundId}\n${sessionId}`);
    useEffect(() => {
      const identity = `${roundId}\n${sessionId}`;
      if (identityRef.current === identity) return;
      identityRef.current = identity;
      reset();
    }, [roundId, sessionId, reset]);

    // The list says the recording is now in a different state (the host re-read it): the mint's
    // answer, and any link, belong to the old state. Start over from the list.
    const listedState = viewState(summary);
    const listedRef = useRef(listedState);
    useEffect(() => {
      if (listedRef.current === listedState) return;
      listedRef.current = listedState;
      reset();
    }, [listedState, reset]);

    // A hidden tab keeps this mounted: stop the sound, keep the position and the link.
    useEffect(() => {
      if (active) return;
      masterRef.current?.pause();
      followerRef.current?.pause();
    }, [active]);

    // A new link whose address is unchanged is not reloaded by the browser; make it start over so the
    // saved position and play state are restored (a real mint always has a new signature).
    useEffect(() => {
      if (!minted) return;
      const key = sourceKey(minted.sources);
      const same = lastKeyRef.current === key;
      lastKeyRef.current = key;
      if (!same) return;
      try {
        masterRef.current?.load();
        followerRef.current?.load();
      } catch {
        /* nothing to reload */
      }
    }, [minted]);

    /* ── Mint ──────────────────────────────────────────────────────── */

    const applyMint = useCallback((answer: R1RecordingPlayback, restore: Restore | null) => {
      const answerSummary = summaryOf(answer);
      const answered = viewState(answerSummary);
      if (answered !== 'unknown' && answered !== viewState(summaryRef.current)) {
        cbRef.current.onStateChange?.(answered);
      }
      setOverride(answerSummary);
      summaryRef.current = answerSummary;

      const sources = playbackSources(answer);
      if (sources) {
        seqRef.current += 1;
        const next: Minted = {
          seq: seqRef.current,
          sources,
          mintedAt: performance.now(),
          expiresInSec:
            typeof answer.expires_in_sec === 'number' && Number.isFinite(answer.expires_in_sec)
              ? answer.expires_in_sec
              : null,
        };
        mintedRef.current = next;
        metaRef.current = false;
        restoreRef.current = restore;
        setFollowerFailed(false);
        setErrorInfo(null);
        setMinted(next);
        setPhase('media');
        return;
      }

      // Nothing to play. Either the recording is in a state without a file (the player becomes that
      // state's block), or the server said ready/partial with no usable link (a fault).
      release(masterRef.current);
      release(followerRef.current);
      mintedRef.current = null;
      restoreRef.current = null;
      pendingSeekRef.current = null;
      setMinted(null);
      if (isPlayableState(answered)) {
        setErrorInfo({ message: r1RecordingErrorMessage(0), retryable: true });
        setPhase('error');
      } else {
        setErrorInfo(null);
        setPhase('blocked');
      }
    }, []);

    const mint = useCallback(
      (restore: Restore | null = null): Promise<void> => {
        if (inflightRef.current) return inflightRef.current;
        const gen = genRef.current;
        if (mintedRef.current === null) {
          setErrorInfo(null);
          setPhase('loading');
        } else {
          // A re-mint under a player that is already on screen: it keeps its place meanwhile.
          setRefreshing(true);
        }
        // The request goes out in this very call (the executor runs now); a client without the
        // method, or one that throws, becomes an ordinary rejection instead of a crash.
        const promise: Promise<void> = new Promise<R1RecordingPlayback>((resolve) =>
          resolve(api.getR1Recording(roundId, sessionId)),
        )
          .then(
            (answer) => {
              if (!mountedRef.current || gen !== genRef.current) return;
              applyMint(answer, restore);
            },
            (error: unknown) => {
              if (!mountedRef.current || gen !== genRef.current) return;
              const status = errorStatus(error);
              const code = errorCode(error);
              release(masterRef.current);
              release(followerRef.current);
              mintedRef.current = null;
              restoreRef.current = null;
              pendingSeekRef.current = null;
              setMinted(null);
              setErrorInfo({
                message: r1RecordingErrorMessage(status, code),
                retryable: r1RecordingErrorRetryable(status, code),
              });
              setPhase('error');
            },
          )
          .finally(() => {
            if (inflightRef.current === promise) inflightRef.current = null;
            if (mountedRef.current && gen === genRef.current) setRefreshing(false);
          });
        inflightRef.current = promise;
        return promise;
      },
      [applyMint, roundId, sessionId],
    );

    /** Replace a link that is about to expire, before the request that would fail. True = a re-mint started. */
    const refreshIfStale = useCallback(
      (restore: Restore): boolean => {
        const current = mintedRef.current;
        if (!current || inflightRef.current) return false;
        if (!isMintStale(current.mintedAt, performance.now(), current.expiresInSec)) return false;
        void mint(restore);
        return true;
      },
      [mint],
    );

    /* ── Seeking ───────────────────────────────────────────────────── */

    const seekElements = useCallback((sec: number) => {
      const target = Math.max(0, sec);
      const master = masterRef.current;
      if (master) {
        try {
          master.currentTime = target;
        } catch {
          /* not seekable yet: the metadata handler applies it */
        }
      }
      const follower = followerRef.current;
      if (follower && follower !== master) {
        try {
          follower.currentTime = target;
        } catch {
          /* ditto */
        }
      }
    }, []);

    /** Once metadata is there: the queued click wins over a saved position. */
    const applyQueued = useCallback(() => {
      const el = masterRef.current;
      if (!el) return;
      const restore = restoreRef.current;
      const pending = pendingSeekRef.current;
      restoreRef.current = null;
      pendingSeekRef.current = null;
      if (pending !== null) {
        seekElements(pending);
        if (activeRef.current) el.play().catch(noop);
        // Land keyboard users on the controls (a transcript click moved them away).
        el.focus();
      } else if (restore) {
        seekElements(restore.time);
        if (restore.play && activeRef.current) el.play().catch(noop);
      }
    }, [seekElements]);

    const playFrom = useCallback(
      (offsetSec: number) => {
        if (!Number.isFinite(offsetSec)) return;
        // Only a recording that has a file can be played; the list's word is what we know.
        if (!isPlayableState(viewState(summaryRef.current))) return;
        pendingSeekRef.current = Math.max(0, offsetSec);
        if (!mintedRef.current) {
          void mint();
          return;
        }
        if (refreshIfStale({ time: offsetSec, play: true })) return;
        if (metaRef.current) applyQueued();
        // Otherwise the metadata handler applies it as soon as it loads.
      },
      [applyQueued, mint, refreshIfStale],
    );

    useImperativeHandle(
      ref,
      () => ({
        load() {
          if (mintedRef.current) return Promise.resolve();
          if (!isPlayableState(viewState(summaryRef.current))) return Promise.resolve();
          return mint();
        },
        playFrom,
        playFromTurn(turnStartedAtMs: number) {
          const offset = turnOffsetSec(turnStartedAtMs, summaryRef.current);
          if (offset !== null) playFrom(offset);
        },
        seek(offsetSec: number) {
          const el = masterRef.current;
          if (!el || !Number.isFinite(offsetSec)) return;
          if (refreshIfStale({ time: offsetSec, play: !el.paused })) return;
          seekElements(offsetSec);
        },
        play() {
          const el = masterRef.current;
          if (!el) return;
          if (refreshIfStale({ time: el.currentTime, play: true })) return;
          el.play().catch(noop);
        },
        pause() {
          masterRef.current?.pause();
          followerRef.current?.pause();
        },
        get currentTime() {
          return masterRef.current?.currentTime ?? 0;
        },
        get hasUrl() {
          return mintedRef.current !== null && phaseRef.current === 'media';
        },
      }),
      [mint, playFrom, refreshIfStale, seekElements],
    );

    /* ── Media events ──────────────────────────────────────────────── */

    // Plain ref callbacks: they only remember the element. (See `release` for why they never let go.)
    const attachMaster = useCallback((el: HTMLMediaElement | null) => {
      masterRef.current = el;
      if (el) lastMasterRef.current = el;
    }, []);

    const attachFollower = useCallback((el: HTMLVideoElement | null) => {
      followerRef.current = el;
      if (el) lastFollowerRef.current = el;
    }, []);

    const onLoadedMetadata = useCallback(() => {
      metaRef.current = true;
      applyQueued();
    }, [applyQueued]);

    const onMediaError = useCallback(() => {
      const el = masterRef.current;
      const current = mintedRef.current;
      if (!el || !current) return;
      const now = performance.now();

      if (!metaRef.current) {
        // It never loaded: a bad first link is a real fault, so no automatic retry.
        const single = current.sources.kind === 'single' ? current.sources : null;
        const code = el.error?.code ?? 0;
        const unsupported =
          code === 4 && single !== null && !browserCanPlay(single.contentType, single.video);
        releaseMedia();
        mintedRef.current = null;
        pendingSeekRef.current = null;
        restoreRef.current = null;
        setMinted(null);
        setErrorInfo({ message: r1MediaErrorMessage(unsupported), retryable: !unsupported });
        setPhase('error');
        return;
      }

      const place: Restore = { time: el.currentTime, play: !el.paused };
      lastTimeRef.current = place.time;
      if (shouldAutoRemint(lastAutoRemintRef.current, now)) {
        // Most likely the link expired mid-view: swap in a fresh one and carry on where it stopped.
        lastAutoRemintRef.current = now;
        void mint(place);
        return;
      }
      releaseMedia();
      mintedRef.current = null;
      pendingSeekRef.current = null;
      restoreRef.current = null;
      setMinted(null);
      setErrorInfo({ message: r1MediaErrorMessage(false), retryable: true });
      setPhase('error');
    }, [mint, releaseMedia]);

    const onTimeUpdate = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
      const el = event.currentTarget;
      lastTimeRef.current = el.currentTime;
      cbRef.current.onTimeUpdate?.(el.currentTime);
      const follower = followerRef.current;
      if (follower && follower !== el && !el.paused && driftExceeds(el.currentTime, follower.currentTime)) {
        try {
          follower.currentTime = el.currentTime;
        } catch {
          /* not seekable yet */
        }
      }
    }, []);

    const onPlay = useCallback(
      (event: SyntheticEvent<HTMLMediaElement>) => {
        const el = event.currentTarget;
        cbRef.current.onPlayState?.(true);
        followerRef.current?.play().catch(noop);
        // The person pressed the native Play on a link that is about to expire.
        refreshIfStale({ time: el.currentTime, play: true });
      },
      [refreshIfStale],
    );

    const onPause = useCallback(() => {
      cbRef.current.onPlayState?.(false);
      followerRef.current?.pause();
    }, []);

    const onEnded = useCallback(() => {
      cbRef.current.onPlayState?.(false);
      followerRef.current?.pause();
    }, []);

    /** The picture follows the sound: after any seek it is put where the audio is. */
    const syncFollower = useCallback((el: HTMLMediaElement) => {
      const follower = followerRef.current;
      if (!follower || follower === el) return;
      try {
        follower.currentTime = el.currentTime;
      } catch {
        /* not seekable yet */
      }
    }, []);

    const onSeeking = useCallback(
      (event: SyntheticEvent<HTMLMediaElement>) => {
        const el = event.currentTarget;
        syncFollower(el);
        // The person seeks on a link that is about to expire: replace it before the request fails.
        refreshIfStale({ time: el.currentTime, play: !el.paused });
      },
      [refreshIfStale, syncFollower],
    );

    const onSeeked = useCallback(
      (event: SyntheticEvent<HTMLMediaElement>) => syncFollower(event.currentTarget),
      [syncFollower],
    );

    const onRateChange = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
      const follower = followerRef.current;
      if (follower) follower.playbackRate = event.currentTarget.playbackRate;
    }, []);

    const onWaiting = useCallback(() => {
      followerRef.current?.pause();
    }, []);

    const onPlaying = useCallback(() => {
      followerRef.current?.play().catch(noop);
    }, []);

    /* ── Render ────────────────────────────────────────────────────── */

    const view = viewState(effective);
    const copy = r1RecordingStateCopy(effective);
    const refreshable = typeof props.onNeedRefresh === 'function';

    const retry = () => {
      const place = lastTimeRef.current;
      void mint(place > 0 ? { time: place, play: false } : null);
    };

    const aspect = { aspectRatio: '16 / 9' } as const;
    const sources = minted?.sources ?? null;
    const showMedia = phase === 'media' && sources !== null;
    const hasPicture = sources !== null && (sources.kind === 'split' || sources.video);
    const mediaName = `${hasPicture ? 'Interview recording' : 'Interview audio recording'}, ${label}`;

    return (
      <div className="space-y-2 text-sm" data-r1-recording-state={view}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Tag tone={copy.tone} srPrefix="Recording:">
            {copy.tag}
          </Tag>
          {copy.facts.length > 0 && (
            <span className="text-label text-ink-secondary">{copy.facts.join(' · ')}</span>
          )}
        </div>

        {copy.detail && <p className="text-ink-secondary">{copy.detail}</p>}
        {copy.notice && <p className="text-ink-secondary">{copy.notice}</p>}

        {phase === 'loading' && (
          <p role="status" className="text-ink-secondary">
            Loading recording…
          </p>
        )}

        {phase === 'error' && errorInfo && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-ink-secondary">{errorInfo.message}</p>
            {errorInfo.retryable && (
              <CandidateButton
                variant="secondary"
                size="md"
                onClick={retry}
                aria-label={`Try again, ${label}`}
              >
                Try again
              </CandidateButton>
            )}
          </div>
        )}

        {showMedia && sources.kind === 'single' && sources.video && (
          <video
            ref={attachMaster}
            src={sources.url}
            controls
            preload="metadata"
            playsInline
            controlsList="nodownload"
            aria-label={mediaName}
            style={aspect}
            className="block w-full max-w-[640px] rounded-lg bg-[var(--c-ink)]"
            onLoadedMetadata={onLoadedMetadata}
            onError={onMediaError}
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay}
            onPause={onPause}
            onEnded={onEnded}
            onSeeking={onSeeking}
          />
        )}

        {showMedia && sources.kind === 'single' && !sources.video && (
          <audio
            ref={attachMaster}
            src={sources.url}
            controls
            preload="metadata"
            controlsList="nodownload"
            aria-label={mediaName}
            className="block h-10 w-full max-w-[640px]"
            onLoadedMetadata={onLoadedMetadata}
            onError={onMediaError}
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay}
            onPause={onPause}
            onEnded={onEnded}
            onSeeking={onSeeking}
          />
        )}

        {showMedia && sources.kind === 'split' && (
          <div className="space-y-2">
            {/* The picture only: muted, no controls, and not announced (the audio is the recording
                for assistive technology). A failed picture leaves the audio playing. */}
            {!followerFailed && (
              <video
                ref={attachFollower}
                src={sources.videoUrl}
                muted
                playsInline
                preload="metadata"
                aria-hidden="true"
                style={aspect}
                className="block w-full max-w-[640px] rounded-lg bg-[var(--c-ink)]"
                onLoadedMetadata={() => {
                  const master = masterRef.current;
                  const follower = followerRef.current;
                  if (master && follower && master.currentTime > 0) follower.currentTime = master.currentTime;
                }}
                onError={() => setFollowerFailed(true)}
              />
            )}
            <audio
              ref={attachMaster}
              src={sources.audioUrl}
              controls
              preload="metadata"
              controlsList="nodownload"
              aria-label={mediaName}
              className="block h-10 w-full max-w-[640px]"
              onLoadedMetadata={onLoadedMetadata}
              onError={onMediaError}
              onTimeUpdate={onTimeUpdate}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onEnded}
              onSeeking={onSeeking}
              onSeeked={onSeeked}
              onRateChange={onRateChange}
              onWaiting={onWaiting}
              onPlaying={onPlaying}
            />
            <p role="note" className="text-label text-ink-secondary">
              Recovered recording: audio and video may drift.
              {followerFailed ? ' The picture could not be loaded; the audio is playing.' : ''}
            </p>
          </div>
        )}

        {refreshing && showMedia && (
          <p role="status" className="sr-only">
            Refreshing the recording link.
          </p>
        )}

        {phase !== 'loading' && phase !== 'media' && phase !== 'error' && copy.action === 'load' && (
          <CandidateButton
            variant="secondary"
            size="md"
            onClick={() => void mint()}
            aria-label={`Load recording, ${label}`}
          >
            Load recording
          </CandidateButton>
        )}

        {phase !== 'loading' && phase !== 'media' && phase !== 'error' && copy.action === 'refresh' && refreshable && (
          <CandidateButton
            variant="secondary"
            size="md"
            onClick={() => props.onNeedRefresh?.()}
            aria-label={`Check again, ${label}`}
          >
            Check again
          </CandidateButton>
        )}
      </div>
    );
  },
);
