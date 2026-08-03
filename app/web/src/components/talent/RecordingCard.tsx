/**
 * Authorized short-lived recording player/download (MIG-06 contract).
 *
 * - The signed URL is fetched ONLY on an explicit click — never on mount.
 * - The URL appears in the DOM only as the media `src`/`href` while the
 *   player is active; it is never logged or persisted.
 * - Short-TTL expiry is handled with a "Refresh link" action that mints a
 *   fresh URL; stale responses are ignored via a generation counter.
 * - Errors are shown inline with a retry path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Button } from '../ui';
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
    <div className={cx('rounded-lg border border-line bg-surface p-3', className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        {title}
      </h3>
      <p className="mt-1 text-xs text-ink-tertiary">
        A short-lived link is created only when you request playback and
        expires automatically. Object keys and signed URLs are never exposed.
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
        <p role="alert" className="mt-2 text-sm text-error">
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
              className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
            >
              Download file
            </a>
            <button
              type="button"
              onClick={fetchUrl}
              className="text-xs font-medium text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
            >
              Refresh link
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
