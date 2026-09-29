/**
 * Authorized short-lived recording player/download (MIG-06 contract).
 *
 * - The signed URL is fetched ONLY on an explicit click — never on mount.
 * - The URL appears in the DOM only as the media `src`/`href` while the
 *   player is active; it is never logged or persisted.
 * - Short-TTL expiry is handled with a "Refresh link" action that mints a
 *   fresh URL; stale responses are ignored via a generation counter.
 * - Errors are shown inline with a retry path.
 *
 * NOT A CARD, despite the name. It sits inside the session page's Details
 * panel, and a bordered white box there was a card inside a glass panel,
 * which the design system rules out (no glass-in-glass). It is a section of
 * that panel instead: a hairline above it, the same `--glass-ring` hairline
 * that separates the Details rows, and no fill or border of its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Button } from '../design/Button';
import { cx } from '../design/cx';

export interface RecordingCardProps {
  sessionId: string;
  /** Heading text; defaults to "Call recording". */
  title?: string;
  className?: string;
}

export function RecordingCard({
  sessionId,
  title = 'Call recording',
  className,
}: RecordingCardProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Invalidate any in-flight request if the session changes.
  useEffect(() => {
    reqIdRef.current += 1;
    setUrl(null);
    setError(null);
    setLoading(false);
  }, [sessionId]);

  const fetchUrl = useCallback(() => {
    if (!sessionId) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    api
      .getRecordingDownloadUrl(sessionId)
      .then((res) => {
        if (!mountedRef.current || reqId !== reqIdRef.current) return;
        setUrl(res.url);
        setLoading(false);
      })
      .catch((e: ApiError) => {
        if (!mountedRef.current || reqId !== reqIdRef.current) return;
        setError(e.message || 'Failed to load recording');
        setLoading(false);
      });
  }, [sessionId]);

  return (
    // A plain div, not a labelled <section>: that would add a "region"
    // landmark per recording to a page whose panels already have headings.
    <div className={cx('border-t border-glass-ring pt-4', className)}>
      {/* Sentence case at the label step. This was an uppercase, tracked
          eyebrow, which the design system forbids everywhere. */}
      <h3 className="text-label font-medium text-ink-secondary">{title}</h3>
      <p className="mt-1 text-meta text-ink-tertiary">
        The recording link is created when you press Load recording and
        expires on its own.
      </p>

      {!url && (
        <Button
          variant="secondary"
          className="mt-3"
          onClick={fetchUrl}
          loading={loading}
          disabled={!sessionId}
        >
          {loading ? 'Loading…' : 'Load recording'}
        </Button>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-error-text">
          {error}
        </p>
      )}

      {url && !loading && (
        <div className="mt-3 space-y-2">
          <audio controls preload="none" src={url} className="h-9 w-full">
            <a href={url} target="_blank" rel="noreferrer">
              Download recording
            </a>
          </audio>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={url}
              download
              className="text-meta font-medium text-info underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
            >
              Download file
            </a>
            <button
              type="button"
              onClick={fetchUrl}
              className="text-meta font-medium text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
            >
              Refresh link
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
