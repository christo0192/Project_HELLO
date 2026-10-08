import { useEffect, useRef, useState } from 'react';
import { R1_READY_COPY } from './r1-copy';

type SendState = 'idle' | 'sending' | 'sent' | 'failed';

interface R1ReadyButtonProps {
  /** Send the signal. Rejects when it could not be sent; the spoken "ready" still works. */
  onReady: () => Promise<void>;
}

/**
 * "I'm ready": the button beside the voice. Saying "ready" always works and stays the main way
 * to start the role-play; this is for a candidate who would rather press than speak, or whose
 * microphone is not picking them up.
 *
 * It is shown only while the interviewer is waiting (the page decides), so it has no idle
 * state of its own to hide. While the request is in flight, and after it has gone through, the
 * button is `aria-disabled` rather than `disabled`: it keeps the keyboard focus the candidate
 * pressed it with, and a second press does nothing. A failure leaves it usable and says what to
 * do instead. The outcome is announced through a polite region that is already on the page when
 * the text changes, so a screen reader hears it.
 */
export function R1ReadyButton({ onReady }: R1ReadyButtonProps) {
  const [state, setState] = useState<SendState>('idle');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const locked = state === 'sending' || state === 'sent';

  async function press(): Promise<void> {
    if (locked) return;
    setState('sending');
    try {
      await onReady();
      if (mounted.current) setState('sent');
    } catch {
      if (mounted.current) setState('failed');
    }
  }

  return (
    <div className="r1-ready">
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
