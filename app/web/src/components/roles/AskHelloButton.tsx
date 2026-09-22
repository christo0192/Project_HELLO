/**
 * "Ask Hello" — draft a role's JD, skills and questions from its job title.
 *
 * APP-SCOPE TOKENS ONLY. This briefly used `var(--c-accent)` and
 * `var(--c-ink-secondary)`, which are declared under `.candidate-scope` — a
 * class the Roles page does not apply. Off-scope, `--tw-ring-color:
 * var(--c-accent)` is invalid at computed-value time and falls back to
 * Tailwind's preflight default rgba(59,130,246,.5): 1.84:1 against the white
 * ring offset, where SC 1.4.11 needs 3:1. A focus ring nobody can see is the
 * same as no focus ring.
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
  /**
   * Called when a running job is ADOPTED on mount and the form's job role is
   * blank — a reload, typically. The form fills the field from it, so what is
   * on screen matches what is actually being drafted instead of showing an
   * empty field above a button that says "Asking Hello…".
   */
  onResumed?: (jobRole: string) => void;
  /**
   * Called on mount when a draft is running for a DIFFERENT job role.
   *
   * Separate from `onError` because it is not an error: the operator opened a
   * form while something else was drafting. Rendering it as a red alert on
   * every role edit was noise they could not dismiss.
   */
  onBusy?: (message: string) => void;
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
  onResumed,
  onBusy,
  className,
}: AskHelloButtonProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<RoleDraftProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [starting, setStarting] = useState(false);
  const running = starting || jobId !== null;

  // Latest callbacks, so the poll effect does not restart whenever the parent
  // re-renders with new closures — which would reset the interval every keystroke.
  const cbs = useRef({ onDrafted, onError, onResumed, onBusy });
  cbs.current = { onDrafted, onError, onResumed, onBusy };
  /**
   * The CURRENT job role, for the mount effect.
   *
   * A ref rather than a dependency: adding `jobRole` to the resume effect
   * would re-run the lookup on every keystroke.
   */
  const jobRoleRef = useRef(jobRole);
  jobRoleRef.current = jobRole;

  /**
   * Set when Cancel is pressed before `startRoleDraft` has answered.
   *
   * `running` is `starting || jobId !== null`, so Cancel renders the instant
   * the button is pressed — but `cancel()` had nothing to cancel yet and bailed
   * on `if (!id) return`, recording nothing. The POST then landed, `setJobId`
   * fired unconditionally, the poll began, and the draft applied ten minutes
   * later to a form where neither confirm fires. The operator pressed Cancel
   * and got the exact behaviour this whole architecture exists to end: the
   * spinner stopped, the model kept billing.
   *
   * The POST is three round trips plus an awaited audit write, so the window
   * is hundreds of milliseconds on a warm pooler and seconds on a cold one.
   */
  const cancelRequestedRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * When the job being watched actually began, for the elapsed counter.
   *
   * STATE, not a ref. `running` flips true the moment the button is pressed,
   * so the counter's effect runs before the server has answered — and a ref
   * written afterwards cannot re-run it, leaving "0s elapsed" on a job that
   * was already five minutes old. As state, the correction re-runs the effect.
   *
   * Null when this component started the job: "now" is right then.
   */
  const [resumeBase, setResumeBase] = useState<number | null>(null);
  /**
   * Put focus back on the main button before Cancel unmounts.
   *
   * Only when focus is actually inside this component — stealing it from
   * wherever the operator has moved on to would be its own bug.
   */
  const returnFocus = useCallback(() => {
    if (typeof document === 'undefined') return;
    const activeEl = document.activeElement;
    if (activeEl && rootRef.current?.contains(activeEl)) buttonRef.current?.focus();
  }, []);

  /**
   * PICK UP A JOB THAT IS ALREADY RUNNING.
   *
   * The job id lives in this component's state and nowhere else, so a reload,
   * a navigation, or switching to another role in the list used to abandon a
   * running draft: it kept billing, its result landed in a row no endpoint
   * could name, and the operator's only move was to press the button again
   * and start a second one. The row is the durable copy — this asks the
   * server what is already in flight and resumes watching it.
   *
   * Guarded on `jobId` being null so it cannot stomp a job started in this
   * same session, and `live` so a slow answer cannot write into a component
   * that has since gone.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { active } = await api.getActiveRoleDraft();
        if (!live || !active) return;

        // ADOPTION IS NOT UNCONDITIONAL, and that is the whole point.
        //
        // `readActiveRoleDraft` has no role filter — it answers "what is this
        // operator drafting", not "is this form's role drafting". Adopting
        // whatever it returns reached the exact end state the 409 on `start`
        // was added to prevent, by the sibling path: leave a Sales Advisor
        // draft running, reopen New role, and the button says "Asking Hello…"
        // without being pressed. Type "Data Engineer", and when the draft
        // lands a fresh form has nothing to overwrite — so the confirm never
        // fires and a Sales Advisor script fills a form headed Data Engineer.
        //
        // Empty field: adopt, and hand the role back so the form can say what
        // is actually running. That is the refresh case, where the field is
        // blank because the page reloaded, not because nothing was asked for.
        const current = jobRoleRef.current.trim();
        const drafting = active.job_role.trim();
        if (current && current !== drafting) {
          // Different role. Do not adopt — the operator is looking at their
          // own subject and must not have it replaced.
          //
          // REPORTED AS INFORMATION, not as an error. This fires on MOUNT, so
          // opening any role for editing while a draft runs raised a red
          // `role="alert"` the operator never asked for and could not dismiss
          // for the life of the form. They did not do anything wrong; there is
          // simply a draft in progress.
          //
          // And it names a recovery that EXISTS. "Open that role to cancel it"
          // was wrong for the feature's main path — a draft for a brand-new
          // role has no saved role to open. The route back is a blank New role
          // form, which the mount effect adopts.
          cbs.current.onBusy?.(
            `Hello is already drafting "${active.job_role}". Open a new role form and leave the job role blank to watch or cancel it.`,
          );
          return;
        }

        const startedAt = active.created_at ? Date.parse(active.created_at) : NaN;
        setResumeBase(Number.isFinite(startedAt) ? startedAt : null);
        setJobId((existing) => existing ?? active.id);
        if (!current) cbs.current.onResumed?.(active.job_role);
      } catch {
        // Nothing to recover, or the lookup failed. Either way the button is
        // usable; this is a convenience, not a precondition.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    // COUNTS FROM WHEN THE JOB STARTED, not from when this component started
    // watching it. A resumed draft five minutes old used to read "3s elapsed",
    // which is a worse lie than showing nothing: it says the wait has barely
    // begun at the moment it is nearly over. `startedAt` is null for a job
    // this component started (they coincide) and set when one is adopted.
    const base = resumeBase ?? Date.now();
    setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    const id = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000))), 1000);
    return () => clearInterval(id);
    // `resumeBase` IS A DEPENDENCY. `running` flips true the moment the button
    // is pressed, so this effect runs before the server has answered; the
    // correction that arrives afterwards has to re-run it, or the counter
    // stays on the wrong clock for the whole draft.
  }, [running, resumeBase]);

  // THE POLL. Tears itself down on unmount, so a job that finishes after the
  // form has gone cannot write into a component that is no longer there.
  useEffect(() => {
    if (!jobId) return;
    let live = true;

    const settle = (job: RoleDraftJob) => {
      if (!live) return;
      // FOCUS FIRST, because Cancel is about to unmount. If the keyboard user
      // is standing on it when it disappears, focus falls to <body> and the
      // next Tab restarts from the top of the page — the same failure the main
      // button uses `aria-disabled` to avoid, reintroduced two elements away.
      returnFocus();
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
        // A single failed poll is a blip for a 5xx or a dropped connection —
        // the job is still running server-side and the next tick finds it.
        //
        // It is NOT harmless for a 404 or a 403, where every subsequent tick
        // fails the same way and the button sits on "Asking Hello…" forever.
        // Nothing deletes `role_drafts` rows today, so that is narrow rather
        // than theoretical-only; said plainly rather than left implied,
        // because the stale-heartbeat verdict does not help here (it needs a
        // successful read to deliver it).
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
    cancelRequestedRef.current = false;
    // Started here, so "now" is when the wait began — until the server says
    // otherwise below.
    setResumeBase(null);
    try {
      const job = await api.startRoleDraft(role);
      // `startRoleDraft` RETURNS AN EXISTING JOB when one is already running
      // for this role — a second tab, typically. Its clock started when that
      // job did, not when this button was pressed, so the counter reads from
      // `created_at` on this path too. Without it a second tab showed "3s
      // elapsed" for a draft five minutes from finishing.
      // CANCELLED WHILE WE WERE ASKING. The job exists now — the server made
      // it — so it has to be stopped rather than merely not watched. Adopting
      // it instead would ignore a decision the operator has already made.
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
        await api.cancelRoleDraft(job.id).catch(() => {
          cbs.current.onError(
            'Hello may not have stopped — the cancel did not reach the server. Reopen this form to check.',
          );
        });
        return;
      }
      const startedAt = job.created_at ? Date.parse(job.created_at) : NaN;
      setResumeBase(Number.isFinite(startedAt) ? startedAt : null);
      setJobId(job.id);
    } catch (err) {
      // A 409 carries a sentence written for a human — "A draft for
      // \"Sales Advisor\" is already running." — so it is shown as-is rather
      // than flattened into a generic failure.
      cbs.current.onError(err instanceof Error ? err.message : 'Hello could not be started.');
    } finally {
      setStarting(false);
    }
  }, [jobRole, running, wouldOverwrite]);

  const cancel = useCallback(async () => {
    const id = jobId;
    // Cleared first, deliberately: the operator should not wait on the network
    // to stop watching. Focus moves before the unmount for the same reason as
    // in `settle` — Cancel is the element being removed.
    returnFocus();
    setJobId(null);
    setPhase(null);
    if (!id) {
      // No job to cancel YET — the start POST is still in flight. Remember the
      // decision so the response handler stops the job it is about to be
      // handed, instead of adopting it. Without this the press did nothing at
      // all and the draft landed ten minutes later unasked.
      cancelRequestedRef.current = true;
      setStarting(false);
      return;
    }
    try {
      await api.cancelRoleDraft(id);
    } catch {
      // NOT SWALLOWED. The headline claim is that Cancel stops the spending
      // rather than the spinner, and a cancel that never reached the server
      // stops only the spinner — v4-pro keeps running, for up to another ten
      // minutes, and the operator has been told otherwise. Say so.
      cbs.current.onError(
        'Hello may not have stopped — the cancel did not reach the server. Reopen this form to check.',
      );
    }
  }, [jobId]);

  const idle = !jobRole.trim();

  return (
    <div className={className} ref={rootRef}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          onClick={start}
          // `aria-disabled`, not `disabled`: a disabled button loses focus the
          // instant it is pressed by keyboard, dropping the user to <body> at
          // exactly the moment Cancel appears. The handler guards instead.
          aria-disabled={idle || running}
          aria-busy={running}
          data-ask-hello=""
          // NO `opacity-60` HERE, and that is the whole point of this class
          // list. CSS opacity composites the entire subtree, so fading the
          // button fades the LABEL with it: white 14px semibold on the
          // gradient measures 7.0-8.3:1, but at .6 over a white page it
          // collapses to 2.82-3.05:1, and 2.39-2.53:1 under the sheen. That is
          // a WCAG AA failure (14px semibold is not "large text", so the bar
          // is 4.5:1) and it landed in the ONE state this whole feature exists
          // to make legible — a ten-minute wait.
          //
          // Unavailability is carried by a flat measured fill instead, which
          // leaves the white label alone. There is no shortage of signal
          // either way: the label itself changes to "Asking Hello…", the glyph
          // changes, Cancel appears, and the live region narrates the phase.
          className={`ask-hello relative inline-flex min-h-11 items-center gap-2 overflow-hidden rounded-full px-5 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-info ${
            idle ? 'ask-hello--idle cursor-not-allowed' : ''
          }${running ? ' cursor-progress' : ''}`}
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
            className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] font-medium text-ink-secondary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-info"
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
            className="text-xs tabular-nums text-ink-secondary"
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
        className="mt-2 min-h-5 text-xs leading-5 text-ink-secondary"
      >
        {running ? phaseLabel(phase) : ''}
      </p>
    </div>
  );
}
