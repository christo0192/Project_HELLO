/**
 * "Ask Hello" — draft a role's JD, skills and questions from its job title.
 *
 * THE BUTTON IS THE PROGRESS BAR. v4-pro takes 133-206s per call and the
 * server retries up to three times, so this can legitimately run for the
 * better part of ten minutes. A plain spinner over that duration is
 * indistinguishable from a hang, so the label is driven by the server's own
 * NDJSON phase stream — "Rephrasing 2 questions… (2 of 3)" is a fact the
 * server sent, not a timer pretending to know something.
 *
 * An elapsed counter runs alongside it, because even a truthful phase label
 * looks stuck if it sits unchanged for three minutes. The two together say
 * "still working, here is what on, here is how long" without inventing
 * progress that does not exist.
 *
 * Cancel aborts the fetch. Without it the only way out of a ten-minute draft
 * is to leave the page, and the stream would go on writing into a component
 * that is no longer mounted.
 *
 * The animation is decorative and stops entirely under
 * `prefers-reduced-motion` — a looping gradient behind a control someone is
 * waiting on is exactly the kind of motion that rule exists for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { draftRole } from '../../api';
import type { RoleDraftOutcome, RoleDraftProgress } from '../../types';

export interface AskHelloButtonProps {
  /** The job role to draft from. Empty disables the button. */
  jobRole: string;
  /** Applied to the form. Called only on a complete, gate-passing draft. */
  onDrafted: (outcome: RoleDraftOutcome) => void;
  /** Surface a failure in the form's own error area. */
  onError: (message: string) => void;
  /** True when the form already holds content a draft would overwrite. */
  wouldOverwrite: boolean;
  className?: string;
}

function phaseLabel(p: RoleDraftProgress | null): string {
  if (!p) return 'Starting…';
  const of = `${p.attempt} of ${p.maxAttempts}`;
  if (p.phase === 'drafting') return `Writing the role… (${of})`;
  if (p.phase === 'checking') return `Checking the questions are speakable… (${of})`;
  return `Rephrasing ${p.rejected} question${p.rejected === 1 ? '' : 's'} the screener won't read aloud… (${of})`;
}

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function AskHelloButton({
  jobRole,
  onDrafted,
  onError,
  wouldOverwrite,
  className,
}: AskHelloButtonProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RoleDraftProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Abort in flight work on unmount: the stream would otherwise keep reading
  // and call `onDrafted` on a component that no longer exists.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);

  const run = useCallback(async () => {
    const role = jobRole.trim();
    if (!role || running) return;
    if (
      wouldOverwrite &&
      typeof window !== 'undefined' &&
      !window.confirm(
        'This will replace the job description, skills and questions already in this form. Continue?',
      )
    ) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setProgress(null);
    try {
      const outcome = await draftRole(role, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      onDrafted(outcome);
    } catch (err) {
      // An abort is the user's own doing, not a failure to report.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        onError(err instanceof Error ? err.message : 'Hello could not draft this role.');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
    }
  }, [jobRole, running, wouldOverwrite, onDrafted, onError]);

  const disabled = !jobRole.trim() || running;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={disabled}
          aria-busy={running}
          data-ask-hello=""
          className="ask-hello relative inline-flex min-h-11 items-center gap-2 overflow-hidden rounded-full px-5 text-[13px] font-semibold text-white transition-opacity duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--c-accent)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span aria-hidden="true" className="ask-hello__sheen" />
          <span aria-hidden="true" className="relative">
            {running ? '◐' : '✦'}
          </span>
          <span className="relative">{running ? 'Asking Hello…' : 'Ask Hello'}</span>
        </button>

        {running && (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] font-medium text-[var(--c-ink-secondary)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
          >
            Cancel
          </button>
        )}
      </div>

      {/* A PERMANENT live region, not one mounted when it has something to
          say: a region created at the same moment its content appears is not
          reliably announced. */}
      <p
        role="status"
        aria-live="polite"
        data-ask-hello-status=""
        className="mt-2 min-h-5 text-xs leading-5 text-[var(--c-ink-secondary)]"
      >
        {running ? (
          <>
            {phaseLabel(progress)}{' '}
            <span className="tabular-nums">· {elapsedLabel(elapsed)} elapsed</span>
          </>
        ) : (
          ''
        )}
      </p>
    </div>
  );
}
