/**
 * "Ask Hello" — draft a role's JD, skills and questions from its job title.
 *
 * A JOB, NOT A TEN-MINUTE REQUEST. Drafting runs v4-pro up to three times at
 * 133-206s a call. Tied to one socket that meant nothing survived a refresh, a
 * proxy idle timeout killed it mid-draft, and Cancel stopped the spinner while
 * the model kept billing. This starts a job, polls it, and can pick up a job
 * that is already running after a reload.
 *
 * THE BUTTON IS THE PROGRESS BAR. Over ten minutes a plain spinner is
 * indistinguishable from a hang, so the label reports the SERVER's phase —
 * "Rephrasing 2 questions… (2 of 3)" is a fact the server sent.
 *
 * THE ELAPSED COUNTER IS OUTSIDE THE LIVE REGION, deliberately. `role="status"`
 * is implicitly `aria-atomic`, so a counter inside it re-announces the whole
 * sentence every second — roughly 600 times over a long draft, with the polite
 * queue never draining and nothing else on the page audible. Screen readers
 * get the phase; the seconds are visual reassurance only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { RoleDraft, RoleDraftJob, RoleDraftProgress } from '../../types';

export interface AskHelloButtonProps {
  /** The job role to draft from. Empty disables the button. */
  jobRole: string;
  /** Applied to the form. Called once, with a complete gate-passing draft. */
  onDrafted: (draft: RoleDraft, repaired: string[], jobRole: string) => void;
  /** Surface a failure where the operator is looking. */
  onError: (message: string) => void;
  /** True when the form holds content a draft would overwrite. */
  wouldOverwrite: () => boolean;
  className?: string;
}

/** How often to ask. Short enough to feel live, long enough not to hammer. */
const POLL_MS = 2_000;

function phaseLabel(p: RoleDraftProgress | null): string {
  if (!p) return 'Starting…';
  const of = `${p.attempt} of ${p.maxAttempts}`;
  if (p.phase === 'drafting') return `Writing the role… (${of})`;
  if (p.phase === 'checking') return `Checking the questions are speakable… (${of})`;
  if (p.phase === 'rereading') return `Hello's answer was unreadable — asking again… (${of})`;
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
  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<RoleDraftProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [starting, setStarting] = useState(false);
  const running = starting || jobId !== null;

  // Latest callbacks, so the poll effect does not restart whenever the parent
  // re-renders with new closures — which would reset the interval every keystroke.
  const cbs = useRef({ onDrafted, onError });
  cbs.current = { onDrafted, onError };

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);

  // THE POLL. Tears itself down on unmount, so a job that finishes after the
  // form has gone cannot write into a component that is no longer there.
  useEffect(() => {
    if (!jobId) return;
    let live = true;

    const settle = (job: RoleDraftJob) => {
      if (!live) return;
      setJobId(null);
      setPhase(null);
      if (job.status === 'succeeded' && job.draft) {
        // The job's OWN job_role is handed back, not the form's current value:
        // the field can be edited while a draft runs, and applying a draft for
        // "Sales Advisr" under a heading that now reads "Senior Sales Advisor"
        // is a silent lie.
        cbs.current.onDrafted(job.draft, job.repaired, job.job_role);
      } else if (job.status === 'failed') {
        cbs.current.onError(job.error_message ?? 'Hello could not draft this role.');
      }
      // `cancelled` is the operator's own doing — nothing to report.
    };

    const tick = async () => {
      try {
        const job = await api.getRoleDraft(jobId);
        if (!live) return;
        if (job.status === 'running') setPhase(job.phase);
        else settle(job);
      } catch {
        // A single failed poll is a blip, not a failure: the job is still
        // running server-side and the next tick will find it.
      }
    };

    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [jobId]);

  const start = useCallback(async () => {
    const role = jobRole.trim();
    if (!role || running) return;
    if (
      wouldOverwrite() &&
      typeof window !== 'undefined' &&
      !window.confirm(
        'This will replace the job description, skills and questions already in this form. Continue?',
      )
    ) {
      return;
    }
    setStarting(true);
    setPhase(null);
    try {
      const job = await api.startRoleDraft(role);
      setJobId(job.id);
    } catch (err) {
      cbs.current.onError(err instanceof Error ? err.message : 'Hello could not be started.');
    } finally {
      setStarting(false);
    }
  }, [jobRole, running, wouldOverwrite]);

  const cancel = useCallback(async () => {
    const id = jobId;
    setJobId(null);
    setPhase(null);
    // Best effort, and deliberately after clearing local state: the operator
    // should not wait on the network to stop watching.
    if (id) await api.cancelRoleDraft(id).catch(() => undefined);
  }, [jobId]);

  const idle = !jobRole.trim();

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={start}
          // `aria-disabled`, not `disabled`: a disabled button loses focus the
          // instant it is pressed by keyboard, dropping the user to <body> at
          // exactly the moment Cancel appears. The handler guards instead.
          aria-disabled={idle || running}
          aria-busy={running}
          data-ask-hello=""
          className={`ask-hello relative inline-flex min-h-11 items-center gap-2 overflow-hidden rounded-full px-5 text-sm font-semibold text-white transition-opacity duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--c-accent)] ${
            idle || running ? 'cursor-not-allowed opacity-60' : ''
          }`}
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
            onClick={cancel}
            className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] font-medium text-[var(--c-ink-secondary)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
          >
            Cancel
          </button>
        )}

        {/* OUTSIDE the live region — see the file header. A per-second counter
            inside an implicitly-atomic `status` re-announces the whole
            sentence every second for the length of the draft. */}
        {running && (
          <span
            aria-hidden="true"
            data-ask-hello-elapsed=""
            className="text-xs tabular-nums text-[var(--c-ink-secondary)]"
          >
            {elapsedLabel(elapsed)} elapsed
          </span>
        )}
      </div>

      {/* A PERMANENT live region, not one mounted when it has something to
          say: a region created at the same moment its content appears is not
          reliably announced, so the first phase would be silent. */}
      <p
        role="status"
        aria-live="polite"
        data-ask-hello-status=""
        className="mt-2 min-h-5 text-xs leading-5 text-[var(--c-ink-secondary)]"
      >
        {running ? phaseLabel(phase) : ''}
      </p>
    </div>
  );
}
