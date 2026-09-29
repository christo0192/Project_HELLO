/**
 * OperatorHaltControl — the global operator halt, in the Mission Control
 * header.
 *
 * One button that says what it will DO:
 *   - calling live            → RED   "Halt all calling"
 *   - halted, operator pause  → GREEN "Resume calling"
 *   - halted, any other reason → no button; "Calling halted — <reason>" and a
 *     pointer to the runbook (a legal hold or emergency stop is not a thing
 *     to lift from a header button)
 *   - unknown                 → neither colour; "Calling status unavailable"
 *     and a Retry
 * A text badge beside the button names the current state, so colour is never
 * the only signal (WCAG 1.4.1). Every decision about the switch lives in
 * `operatorHalt.ts`; this file renders it.
 *
 * ── CONFIRM, THEN WRITE, THEN RE-READ ─────────────────────────────────
 * Both actions open the centred `Dialog` first. Confirming sends the write
 * and then re-reads `GET /api/phone/health` while the dialog stays busy
 * (Escape, backdrop and Close all refuse), so when it closes the page is
 * already showing the switch as the server now has it — and focus returns to
 * whichever control that state offers. The result is announced in a polite
 * live region that is mounted from the start, because a region only
 * announces reliably if it exists before it gains content.
 *
 * A FAILED write is re-read too. A 409 means someone else moved the switch;
 * an audit failure on `/halt` leaves the halt IN FORCE (routes/phone.ts
 * refuses to fail open); a network error may or may not have landed. In every
 * case the truth is one read away, so it is read rather than guessed.
 *
 * ── WHAT THE HALT STOPS ───────────────────────────────────────────────
 * The copy in the halt dialog is the runbook's, not a paraphrase
 * (docs/runbooks/phone-canary-and-halt.md, "What a halt actually stops"):
 * `admit_phone_attempt` refuses every NEW attempt — first call, retry,
 * reconnect, scheduled — while the halt is set, and calls already in
 * progress are not terminated.
 *
 * No polling: the switch is read on mount, after each action, and on Retry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { api } from '../../api';
import { useAuth } from '../../lib/auth';
import { Button, ButtonSpinner, Dialog, StatusBadge, buttonClass, cx } from '../design';
import {
  OPERATOR_PAUSE,
  haltFailureMessage,
  haltReasonLabel,
  haltViewFrom,
  isHaltConflict,
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
    description: 'No new calls will start until an admin resumes calling.',
    points: [
      'The bot stops placing calls: no first calls, retries, reconnects or scheduled calls will start while calling is halted.',
      'Calls already in progress are not cut off. They carry on until they end.',
      'Nothing restarts on its own. Calling stays halted until someone presses “Resume calling” here.',
      'The one exception is a single-candidate test call that an admin arms on purpose.',
    ],
    confirm: 'Yes, halt all calling',
    busy: 'Halting…',
  },
  resume: {
    title: 'Resume calling?',
    description: 'The bot will start calling candidates again.',
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
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  // The one control each state offers (the action button, or Retry). Focus
  // returns here when the dialog closes — to the NEW state's control after a
  // successful action, because the dialog closes only once that state is on
  // screen.
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  const readSeq = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** One read of the switch. Resolves null when the answer is stale. */
  const readSwitch = useCallback(async (): Promise<Phase | null> => {
    const seq = ++readSeq.current;
    let next: Phase;
    try {
      next = haltViewFrom(await api.getPhoneHealth());
    } catch (error) {
      next = { kind: 'unavailable', detail: readFailureDetail(error) };
    }
    if (!mounted.current || seq !== readSeq.current) return null;
    return next;
  }, []);

  const load = useCallback(async () => {
    const next = await readSwitch();
    if (next) setPhase(next);
  }, [readSwitch]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = useCallback(() => {
    setPhase({ kind: 'loading' });
    void load();
  }, [load]);

  const closeDialog = useCallback(() => {
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
          result = {
            text: res.already_halted ? 'Calling was already halted.' : 'Calling halted.',
            tone: 'neutral',
          };
        } else {
          // `/halt/clear` must NAME the halt in force. This control offers
          // Resume only while that halt is the operator pause, so that is the
          // current reason; if it changed meanwhile the API answers 409 and
          // the re-read below shows what it changed to.
          const res = await api.clearPhoneHalt({ reason: OPERATOR_PAUSE });
          result = {
            text: res.was_halted ? 'Calling resumed.' : 'Calling was already live.',
            tone: 'neutral',
          };
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
      if (next) setPhase(next);
      setAnnouncement(result);
      setBusy(false);
      setConfirming(null);
    },
    [readSwitch],
  );

  const copy = DIALOG_COPY[confirming ?? 'halt'];

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5 sm:items-end" data-operator-halt="">
      <HaltState
        phase={phase}
        busy={busy}
        controlRef={controlRef}
        onHalt={() => setConfirming('halt')}
        onResume={() => setConfirming('resume')}
        onRetry={retry}
      />

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
        returnFocusRef={controlRef}
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
              variant={confirming === 'resume' ? 'success' : 'danger'}
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
  controlRef: RefObject<HTMLButtonElement | null>;
  onHalt: () => void;
  onResume: () => void;
  onRetry: () => void;
}

/** The state badge and the one control that state offers. */
function HaltState({ phase, busy, controlRef, onHalt, onResume, onRetry }: HaltStateProps) {
  const row = 'flex flex-wrap items-center gap-2 sm:justify-end';

  switch (phase.kind) {
    case 'loading':
      return (
        <p className="inline-flex h-11 items-center gap-2 text-[13px] text-ink-secondary">
          <ButtonSpinner className="h-4 w-4 text-ink-tertiary" />
          Checking calling status…
        </p>
      );

    case 'unavailable':
      return (
        <>
          <div className={row}>
            <StatusBadge tone="neutral">Calling status unavailable</StatusBadge>
            <button
              ref={controlRef}
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
          <StatusBadge tone="success">Calling is live</StatusBadge>
          <button
            ref={controlRef}
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
          <StatusBadge tone="danger">Calling is halted</StatusBadge>
          <button
            ref={controlRef}
            type="button"
            onClick={onResume}
            disabled={busy}
            aria-haspopup="dialog"
            data-halt-action="resume"
            className={buttonClass('success', 'lg')}
          >
            Resume calling
          </button>
        </div>
      );

    case 'locked':
      return (
        <>
          <div className={row}>
            <StatusBadge tone="danger">Calling halted — {haltReasonLabel(phase.reason)}</StatusBadge>
          </div>
          <p className="max-w-sm text-[13px] leading-5 text-ink-secondary sm:text-right">
            This halt was not raised as an operator pause, so it cannot be lifted from here. It can
            only be cleared through the phone halt runbook.
          </p>
        </>
      );
  }
}
