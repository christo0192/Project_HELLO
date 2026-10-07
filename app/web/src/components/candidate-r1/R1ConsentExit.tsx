import { useState } from 'react';

type R1ConsentExitKind = 'withdraw' | 'decline';

interface R1ConsentExitProps {
  /**
   * `withdraw` takes back a consent that is on file; `decline` says no when none is. Neither
   * is gated by the interview being open: R1 paused or switched off, a finished interview and
   * a live room all leave both available (plan section 7.8, PR-3 invariant 5).
   */
  kind: R1ConsentExitKind;
  /** The question asked before anything is recorded; it differs by where the person is. */
  question: string;
  busy: boolean;
  /** Why the last attempt failed, shown beside the control so the person can retry. */
  error?: string | null;
  onConfirm: () => void;
}

const WORDING: Readonly<
  Record<R1ConsentExitKind, { open: string; group: string; confirm: string; keep: string }>
> = Object.freeze({
  withdraw: {
    open: 'Withdraw my consent',
    group: 'Withdraw consent',
    confirm: 'Withdraw my consent',
    keep: 'Keep my consent',
  },
  decline: {
    open: 'I do not want to take this interview',
    group: 'Decline the interview',
    confirm: 'Decline the interview',
    keep: 'Keep my invitation',
  },
});

/**
 * The one way out of a consent, behind an explicit confirmation because it ends the
 * interview for this link. Used on every screen that can be reached while a consent is on
 * file (or while none is, for a decline), so the control is the same everywhere.
 */
export function R1ConsentExit({ kind, question, busy, error, onConfirm }: R1ConsentExitProps) {
  const [confirming, setConfirming] = useState(false);
  const words = WORDING[kind];
  return (
    <>
      {confirming ? (
        <div className="r1-withdraw" role="group" aria-label={words.group}>
          <p className="candidate-muted">{question}</p>
          <div className="r1-actions">
            <button type="button" className="r1-secondary-cta" disabled={busy} onClick={onConfirm}>
              {words.confirm}
            </button>
            <button
              type="button"
              className="r1-secondary-cta"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {words.keep}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="r1-link-button" onClick={() => setConfirming(true)}>
          {words.open}
        </button>
      )}
      {error && (
        <p className="candidate-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
