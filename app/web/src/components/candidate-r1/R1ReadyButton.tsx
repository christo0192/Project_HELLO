import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { classifyR1Error } from '../../lib/r1/r1-api';
import { R1_READY_COPY } from './r1-copy';

type SendState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * After a failed press the button stays locked for a moment. Each press costs the server a few
 * requests and the spoken "ready" is the way through anyway, so a candidate hammering a button
 * that is refused (or rate limited) would only make the refusal last. A rate limit waits longer.
 */
export const R1_READY_RETRY_MS = 5_000;
export const R1_READY_RATE_LIMITED_RETRY_MS = 15_000;

interface R1ReadyButtonProps {
  /** Send the signal. Rejects when it could not be sent; the spoken "ready" still works. */
  onReady: () => Promise<void>;
  /**
   * The button is going away while it holds the keyboard focus (the interviewer moved on). The
   * page uses it to park the focus somewhere stable instead of letting it fall to the page.
   */
  onRemovedWithFocus?: () => void;
}

/**
 * "I'm ready": the button beside the voice. Saying "ready" always works and stays the main way
 * to start the role-play; this is for a candidate who would rather press than speak, or whose
 * microphone is not picking them up.
 *
 * It is shown only while the interviewer is waiting (the page decides), so it has no idle
 * state of its own to hide. While the request is in flight, and after it has gone through, the
 * button is `aria-disabled` rather than `disabled`: it keeps the keyboard focus the candidate
 * pressed it with, and a second press does nothing. A failure says what to do instead and locks
 * the button for a few seconds before it can be pressed again. The outcome is announced through
 * a polite region that is already on the page when the text changes, so a screen reader hears it.
 */
export function R1ReadyButton({ onReady, onRemovedWithFocus }: R1ReadyButtonProps) {
  const [state, setState] = useState<SendState>('idle');
  const [cooling, setCooling] = useState(false);
  const mounted = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const removedWithFocus = useRef(onRemovedWithFocus);
  const coolTimer = useRef<number | null>(null);

  useEffect(() => {
    removedWithFocus.current = onRemovedWithFocus;
  }, [onRemovedWithFocus]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (coolTimer.current !== null) window.clearTimeout(coolTimer.current);
    };
  }, []);

  // A layout cleanup runs while the button is still in the page, so this is the one moment the
  // browser can still say whether it held the focus (afterwards the focus is already gone).
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      if (root && root.contains(document.activeElement)) removedWithFocus.current?.();
    };
  }, []);

  const locked = state === 'sending' || state === 'sent' || cooling;

  function coolDown(error: unknown): void {
    const wait = classifyR1Error(error) === 'rate_limited'
      ? R1_READY_RATE_LIMITED_RETRY_MS
      : R1_READY_RETRY_MS;
    setCooling(true);
    coolTimer.current = window.setTimeout(() => {
      coolTimer.current = null;
      if (mounted.current) setCooling(false);
    }, wait);
  }

  async function press(): Promise<void> {
    if (locked) return;
    setState('sending');
    try {
      await onReady();
      if (mounted.current) setState('sent');
    } catch (error) {
      if (!mounted.current) return;
      setState('failed');
      coolDown(error);
    }
  }

  return (
    <div className="r1-ready" ref={rootRef}>
      <button
        type="button"
        className="r1-ready__button"
        aria-disabled={locked ? true : undefined}
        onClick={() => void press()}
      >
        {state === 'sending' ? R1_READY_COPY.sending : R1_READY_COPY.button}
      </button>
      <p className="r1-ready__note" role="status">
        {state === 'sent' ? R1_READY_COPY.sent : ''}
      </p>
      {state === 'failed' && (
        <p className="candidate-error r1-ready__error" role="alert">
          {R1_READY_COPY.failed}
        </p>
      )}
    </div>
  );
}
