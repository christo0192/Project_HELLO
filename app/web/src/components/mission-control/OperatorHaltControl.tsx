/**
 * OperatorHaltControl — the global operator halt, in the Mission Control
 * header.
 *
 * One button that says what it will DO:
 *   - calling on              → RED   "Halt all calling"
 *   - halted, operator pause  → GREEN "Resume calling" (the Button `go`
 *     variant; the owner asked for green on 2026-09-29)
 *   - halted, any other reason → no button; "Calling: halted — <reason>" and
 *     where that halt is cleared (a legal hold or emergency stop is not a
 *     thing to lift from a header button)
 *   - unknown                 → neither colour; "Calling status unavailable"
 *     and a Retry
 * A line of NEUTRAL text beside the button names the current state, so
 * colour is never the only signal (WCAG 1.4.1), and colour belongs to the
 * action button alone — a red or green chip beside it put both colours on
 * screen in both states. Every decision about the switch lives in
 * `operatorHalt.ts`; this file renders it.
 *
 * ── CONFIRM, THEN WRITE, THEN RE-READ ─────────────────────────────────
 * Both actions open the centred `Dialog` first. Confirming sends the write
 * and then re-reads `GET /api/phone/health` while the dialog stays busy
 * (Escape, backdrop and Close all refuse), so when it closes the page is
 * already showing the switch as the server now has it. The result is
 * announced in a polite live region that is mounted from the start, because
 * a region only announces reliably if it exists before it gains content.
 *
 * A FAILED write is re-read too. A 409 means someone else moved the switch;
 * an audit failure on `/halt` leaves the halt IN FORCE (routes/phone.ts
 * refuses to fail open); a network error may or may not have landed. In every
 * case the truth is one read away, so it is read rather than guessed.
 *
 * ── FOCUS NEVER FALLS TO <body> ───────────────────────────────────────
 * Every state has exactly ONE focus target: its action button, Retry, or —
 * where there is no control (loading, a locked halt) — the state text itself,
 * made programmatically focusable with `tabIndex={-1}`. The dialog returns
 * focus to that target, so closing into a locked halt lands on the text that
 * explains why there is no button. And when a re-read (Retry, Refresh, or a
 * background check) removes the element that HAD focus, focus moves to the
 * new state's target rather than dropping to <body>.
 *
 * ── STAYING CURRENT, WITHOUT POLLING ──────────────────────────────────
 * The switch is read on mount, after each action, on Retry and Refresh, and
 * when the window regains focus or the tab becomes visible again — at most
 * once per `RECHECK_MIN_INTERVAL_MS`, and never while a read, a write or a
 * dialog is in flight. "Checked HH:MM IST" says how old the picture is. No
 * interval polling.
 *
 * ── WHAT THE HALT STOPS ───────────────────────────────────────────────
 * The copy in the halt dialog is the runbook's, not a paraphrase
 * (docs/runbooks/phone-canary-and-halt.md, "What a halt actually stops"):
 * `admit_phone_attempt` refuses every NEW attempt — first call, retry,
 * reconnect, scheduled — while the halt is set, and calls already in
 * progress are not terminated. The halt can be lifted here or by the
 * runbook's CLI, so the copy never says "only here".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import { api } from '../../api';
import { useAuth } from '../../lib/auth';
import { formatIstTime } from '../../lib/ist-datetime';
import { Button, ButtonSpinner, Dialog, buttonClass, cx } from '../design';
import {
  OPERATOR_PAUSE,
  RECHECK_MIN_INTERVAL_MS,
  haltFailureMessage,
  haltStateLine,
  haltSuccessMessage,
  haltViewFrom,
  isHaltConflict,
  lockedHaltNote,
  readFailureDetail,
} from './operatorHalt';
import type { HaltAction, HaltView } from './operatorHalt';

type Phase = { kind: 'loading' } | HaltView;

interface Announcement {
  text: string;
  tone: 'neutral' | 'error';
}

/** What each dialog says. The halt copy is load-bearing; see the header. */
const DIALOG_COPY: Record<
  HaltAction,
  { title: string; description: string; points: string[]; confirm: string; busy: string }
> = {
  halt: {
    title: 'Halt all calling?',
    description: 'The bot will stop starting new calls.',
    points: [
      'The bot stops placing calls: no first calls, retries, reconnects or scheduled calls will start while calling is halted.',
      'Calls already in progress are not cut off. They carry on until they end.',
      'Nothing restarts on its own. No new calls will start until calling is resumed.',
      'The one exception is a single test call an admin has set up.',
    ],
    confirm: 'Yes, halt all calling',
    busy: 'Halting…',
  },
  resume: {
    title: 'Resume calling?',
    description: 'The operator pause will be lifted, so the bot can start calling candidates again.',
    points: [
      'Every eligible candidate may be dialled as soon as the scheduler next runs — including everyone who came due while calling was halted.',
      'Calls still start only inside the approved calling window.',
      'You can halt calling again at any time from here.',
    ],
    confirm: 'Yes, resume calling',
    busy: 'Resuming…',
  },
};

/** Admin-only. The page is admin-gated already; this is defence in depth. */
export function OperatorHaltControl() {
  const { role } = useAuth();
  if (role !== 'admin') return null;
  return <OperatorHaltPanel />;
}

function OperatorHaltPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<HaltAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** When the switch was last read, as a UTC ISO instant. */
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  // The ONE focus target the current state offers (see the header). The
  // dialog returns focus here, and a re-read that removes the focused element
  // hands focus here. A callback ref, because the target is a button in some
  // states and a text block in others.
  const focusTargetRef = useRef<HTMLElement | null>(null);
  const setFocusTarget = useCallback<RefCallback<HTMLElement>>((el) => {
    focusTargetRef.current = el;
  }, []);
  /** The element that had focus when a re-read's answer was put on screen. */
  const displaced = useRef<Element | null>(null);
  // Mirrors of state the window listeners must read without re-subscribing.
  const confirmingRef = useRef<HaltAction | null>(null);
  const mounted = useRef(true);
  const readSeq = useRef(0);
  const reading = useRef(false);
  /** `Date.now()` when the last read STARTED; the automatic-recheck throttle. */
  const lastReadAt = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * One read of the switch. Resolves null when the answer is stale — the
   * component unmounted, or a newer read started (an action's re-read always
   * supersedes a background one).
   */
  const readSwitch = useCallback(async (): Promise<HaltView | null> => {
    const seq = ++readSeq.current;
    reading.current = true;
    lastReadAt.current = Date.now();
    let next: HaltView;
    try {
      next = haltViewFrom(await api.getPhoneHealth());
    } catch (error) {
      next = { kind: 'unavailable', detail: readFailureDetail(error) };
    }
    // A newer read owns the `reading` flag; only the latest may clear it.
    if (seq !== readSeq.current) return null;
    reading.current = false;
    if (!mounted.current) return null;
    return next;
  }, []);

  /**
   * Put a read's answer (or the loading state) on screen. If focus is inside
   * this control — and not in the dialog, which returns focus itself —
   * remember where, so the effect below can move it if that element is about
   * to disappear. `at` is when the answer arrived.
   */
  const showRead = useCallback((next: Phase, at: string = new Date().toISOString()) => {
    const active = document.activeElement;
    if (
      confirmingRef.current === null &&
      active &&
      active !== document.body &&
      rootRef.current?.contains(active)
    ) {
      displaced.current = active;
    }
    setPhase(next);
    if (next.kind !== 'loading') setCheckedAt(at);
  }, []);

  // After a re-read is on screen: if it removed the element that had focus,
  // focus the new state's target instead of leaving it on <body>. Runs after
  // the commit, so the target ref already points at the new state's element.
  useEffect(() => {
    const was = displaced.current;
    if (!was) return;
    displaced.current = null;
    if (!was.isConnected) focusTargetRef.current?.focus();
  }, [phase]);

  const load = useCallback(async () => {
    const next = await readSwitch();
    if (next) showRead(next);
  }, [readSwitch, showRead]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = useCallback(() => {
    // Through `loading`, which unmounts Retry: `showRead` notes the focus so
    // it lands on the loading text, and then on whatever the answer offers.
    showRead({ kind: 'loading' });
    void load();
  }, [load, showRead]);

  /**
   * Re-read WITHOUT the loading state, so the current picture stays on
   * screen until the new one replaces it. `manual` is the Refresh button:
   * never throttled, and it announces what it found. `background` is the
   * window/tab returning: throttled, and silent.
   */
  const refresh = useCallback(
    async (source: 'manual' | 'background') => {
      if (reading.current || inFlight.current || confirmingRef.current !== null) return;
      if (source === 'background' && Date.now() - lastReadAt.current < RECHECK_MIN_INTERVAL_MS) {
        return;
      }
      setRefreshing(true);
      const next = await readSwitch();
      if (!mounted.current) return;
      setRefreshing(false);
      if (!next) return;
      const at = new Date().toISOString();
      showRead(next, at);
      if (source === 'manual') {
        // Refresh is a press like any other: say what it found (WCAG 4.1.3),
        // not only in a timestamp a screen reader never hears change.
        setAnnouncement({
          text: `${haltStateLine(next)} (checked ${formatIstTime(at)}).`,
          tone: 'neutral',
        });
      }
    },
    [readSwitch, showRead],
  );

  // The page may sit open in a tab for hours while someone else — another
  // admin, or the runbook CLI — moves the switch. Re-read when the admin
  // comes back to it. `visibilitychange` and `focus` usually fire together;
  // the throttle and the in-flight guard make that a single read.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh('background');
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [refresh]);

  const openDialog = useCallback((action: HaltAction) => {
    confirmingRef.current = action;
    setConfirming(action);
  }, []);

  const closeDialog = useCallback(() => {
    confirmingRef.current = null;
    setConfirming(null);
  }, []);

  const runAction = useCallback(
    async (action: HaltAction) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setAnnouncement(null);

      let result: Announcement;
      try {
        if (action === 'halt') {
          const res = await api.setPhoneHalt({ reason: OPERATOR_PAUSE });
          result = { text: haltSuccessMessage('halt', !res.already_halted), tone: 'neutral' };
        } else {
          // `/halt/clear` must NAME the halt in force. This control offers
          // Resume only while that halt is the operator pause, so that is the
          // current reason; if it changed meanwhile the API answers 409 and
          // the re-read below shows what it changed to.
          const res = await api.clearPhoneHalt({ reason: OPERATOR_PAUSE });
          result = { text: haltSuccessMessage('resume', res.was_halted), tone: 'neutral' };
        }
      } catch (error) {
        result = {
          text: haltFailureMessage(error, action),
          tone: isHaltConflict(error) ? 'neutral' : 'error',
        };
      }

      const next = await readSwitch();
      inFlight.current = false;
      if (!mounted.current) return;
      // Not `showRead`: focus is in the dialog, and the dialog hands it back
      // to the new state's target as it closes in this same render.
      if (next) {
        setPhase(next);
        setCheckedAt(new Date().toISOString());
      }
      setAnnouncement(result);
      setBusy(false);
      closeDialog();
    },
    [readSwitch, closeDialog],
  );

  const copy = DIALOG_COPY[confirming ?? 'halt'];
  const showChecked =
    checkedAt !== null &&
    (phase.kind === 'live' || phase.kind === 'paused' || phase.kind === 'locked');

  return (
    <div
      ref={rootRef}
      className="flex min-w-0 flex-col items-start gap-1.5 sm:items-end"
      data-operator-halt=""
    >
      {/* Keyed by state, so a change of state REPLACES the control instead of
          relabelling the focused one in place: "Halt all calling" never turns
          into "Resume calling" silently under a keyboard user. */}
      <HaltState
        key={phase.kind}
        phase={phase}
        busy={busy}
        focusRef={setFocusTarget}
        onHalt={() => openDialog('halt')}
        onResume={() => openDialog('resume')}
        onRetry={retry}
      />

      {showChecked && (
        <p className="flex items-center gap-1 text-xs leading-5 text-ink-tertiary" data-halt-checked="">
          <span>{refreshing ? 'Checking…' : `Checked ${formatIstTime(checkedAt)}`}</span>
          <button
            type="button"
            aria-label="Refresh calling status"
            aria-disabled={refreshing || undefined}
            onClick={() => {
              if (!refreshing) void refresh('manual');
            }}
            className="inline-flex min-h-6 items-center rounded px-1 font-medium text-ink-secondary underline underline-offset-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            Refresh
          </button>
        </p>
      )}

      <p
        role="status"
        aria-live="polite"
        className={cx(
          'max-w-sm text-[13px] leading-5 sm:text-right',
          announcement?.tone === 'error' ? 'text-error-text' : 'text-ink-secondary',
        )}
      >
        {announcement?.text}
      </p>

      <Dialog
        open={confirming !== null}
        onClose={closeDialog}
        idPrefix="operator-halt"
        title={copy.title}
        description={copy.description}
        returnFocusRef={focusTargetRef}
        busy={busy}
      >
        <div className="flex flex-col gap-4">
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-ink-secondary">
            {copy.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="lg" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={confirming === 'resume' ? 'go' : 'danger'}
              size="lg"
              loading={busy}
              onClick={() => {
                if (confirming) void runAction(confirming);
              }}
            >
              {busy ? copy.busy : copy.confirm}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

interface HaltStateProps {
  phase: Phase;
  busy: boolean;
  focusRef: RefCallback<HTMLElement>;
  onHalt: () => void;
  onResume: () => void;
  onRetry: () => void;
}

/** The neutral state text and the one control that state offers. */
function HaltState({ phase, busy, focusRef, onHalt, onResume, onRetry }: HaltStateProps) {
  const row = 'flex flex-wrap items-center gap-2 sm:justify-end';
  const stateText = 'text-[13px] font-medium leading-5 text-ink';

  switch (phase.kind) {
    case 'loading':
      return (
        <p
          ref={focusRef}
          tabIndex={-1}
          className="inline-flex h-11 items-center gap-2 rounded text-[13px] text-ink-secondary"
        >
          <ButtonSpinner className="h-4 w-4 text-ink-tertiary" />
          Checking calling status…
        </p>
      );

    case 'unavailable':
      return (
        <>
          <div className={row}>
            <p className={stateText}>{haltStateLine(phase)}</p>
            <button
              ref={focusRef}
              type="button"
              onClick={onRetry}
              className={buttonClass('secondary', 'lg')}
            >
              Retry
            </button>
          </div>
          <p className="max-w-sm text-[13px] leading-5 text-ink-tertiary sm:text-right">{phase.detail}</p>
        </>
      );

    case 'live':
      return (
        <div className={row}>
          <p className={stateText}>{haltStateLine(phase)}</p>
          <button
            ref={focusRef}
            type="button"
            onClick={onHalt}
            disabled={busy}
            aria-haspopup="dialog"
            data-halt-action="halt"
            className={buttonClass('danger', 'lg')}
          >
            Halt all calling
          </button>
        </div>
      );

    case 'paused':
      return (
        <div className={row}>
          <p className={stateText}>{haltStateLine(phase)}</p>
          <button
            ref={focusRef}
            type="button"
            onClick={onResume}
            disabled={busy}
            aria-haspopup="dialog"
            data-halt-action="resume"
            className={buttonClass('go', 'lg')}
          >
            Resume calling
          </button>
        </div>
      );

    case 'locked':
      // No control, so the text is the focus target: a dialog closing into
      // this state, or a re-read arriving at it, lands here and reads out
      // both the halt and why there is no button.
      return (
        <div
          ref={focusRef}
          tabIndex={-1}
          data-halt-locked=""
          className="flex max-w-sm flex-col items-start gap-1 rounded sm:items-end"
        >
          <p className={cx(stateText, 'inline-flex min-h-11 items-center')}>{haltStateLine(phase)}</p>
          <p className="text-[13px] leading-5 text-ink-secondary sm:text-right">
            {lockedHaltNote(phase.reason)}
          </p>
        </div>
      );
  }
}
