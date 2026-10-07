import type { ReactNode } from 'react';
import '../../styles/candidate-experience.css';
import '../../styles/candidate-r1.css';
import type { R1Audience } from '../../lib/r1/r1-api';
import { Button } from '../ui';
import { R1ConsentExit } from './R1ConsentExit';
import {
  R1_DECLINE_QUESTION,
  R1_WITHDRAW_QUESTIONS,
  closedCopyFor,
  endedCopyFor,
  reviewNoteFor,
  type R1ClosedKind,
  type R1EndedKind,
} from './r1-copy';

/** The candidate page chrome: brand header and the shared candidate palette scope. */
export function R1Shell({ children }: { children: ReactNode }) {
  return (
    <main className="candidate-experience candidate-shell candidate-scope">
      <div className="candidate-shell__inner">
        <header className="candidate-brand" aria-label="Interview Kickstart">
          <img src="/ik-logo.png" alt="Interview Kickstart" />
          <div>
            <b>Interview Kickstart</b>
            <span>Private candidate interview</span>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

/** The way out of a consent a closed or ended card offers: what to do, and how it went. */
export interface R1ConsentExitControl {
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}

interface R1ClosedCardProps {
  kind: R1ClosedKind;
  /** Whom the card speaks to; a staff dry run is told about the project team. */
  audience?: R1Audience;
  /** Offered for the temporary states, where trying again is meaningful. */
  onRetry?: () => void;
  /**
   * Take a consent that is on file back. Offered whatever the link's state: R1 paused or
   * switched off, a finished interview and a lapsed or cancelled link all leave withdrawal
   * available (PR-3 invariant 5), and a card that gave no way to do it would leave the
   * person with a consent they cannot end from the page.
   */
  withdraw?: R1ConsentExitControl;
  /** Say no when no consent is on file, while R1 is paused or switched off (the notice is not gated). */
  decline?: R1ConsentExitControl;
}

/** A terminal or waiting card; interview controls it has none, consent controls only when given. */
export function R1ClosedCard({
  kind,
  audience = 'candidate',
  onRetry,
  withdraw,
  decline,
}: R1ClosedCardProps) {
  const copy = closedCopyFor(kind, audience);
  const alert = kind === 'invalid' || kind === 'unsupported';
  return (
    <section
      className="candidate-glass-card candidate-landing candidate-status-card"
      aria-labelledby="r1-closed-title"
      role={alert ? 'alert' : undefined}
    >
      <p className="candidate-eyebrow">{copy.eyebrow}</p>
      <h1 id="r1-closed-title">{copy.title}</h1>
      <p className="candidate-muted">{copy.body}</p>
      {onRetry && (
        <button type="button" className="r1-secondary-cta" onClick={onRetry}>
          Check again
        </button>
      )}
      {withdraw && (
        <R1ConsentExit
          kind="withdraw"
          question={R1_WITHDRAW_QUESTIONS.after}
          busy={withdraw.busy}
          error={withdraw.error}
          onConfirm={withdraw.onConfirm}
        />
      )}
      {decline && (
        <R1ConsentExit
          kind="decline"
          question={R1_DECLINE_QUESTION}
          busy={decline.busy}
          error={decline.error}
          onConfirm={decline.onConfirm}
        />
      )}
    </section>
  );
}

interface R1EndedCardProps {
  kind: R1EndedKind;
  /** Whom the card speaks to; a staff dry run is told it decides nothing about them. */
  audience?: R1Audience;
  /** Take the consent back after the interview: it stops the evaluation (PR-3 invariant 5). */
  withdraw?: R1ConsentExitControl;
  /**
   * Start the rejoin: back through the status check and the device check to a new attempt
   * that carries the stored nonce. Offered only after leaving or a lost connection.
   */
  onRejoin?: () => void;
}

/**
 * Shown after the room is left. The link fragment was stripped from the address bar when
 * the page opened (it must never linger there), so reloading or reopening the email link
 * cannot rejoin: the only way back within the 90 second window is this tab, where the
 * link token is still in memory and the rejoin nonce is still in session storage.
 *
 * It does NOT link to /appeal. An appeal needs a one-time grant that R1 cannot issue yet,
 * and the appeal page answers a grant-less visit with "missing, expired, revoked, or
 * already used", which would tell a candidate their own interview link is invalid.
 */
export function R1EndedCard({ kind, audience = 'candidate', withdraw, onRejoin }: R1EndedCardProps) {
  const copy = endedCopyFor(kind, audience);
  return (
    <section
      className="candidate-glass-card candidate-landing candidate-status-card"
      aria-labelledby="r1-ended-title"
    >
      <p className="candidate-eyebrow">{copy.eyebrow}</p>
      <h1 id="r1-ended-title">{copy.title}</h1>
      <p className="candidate-muted">{copy.body}</p>
      {copy.rejoin && onRejoin && (
        <Button className="candidate-primary-cta" onClick={onRejoin}>
          Rejoin interview
        </Button>
      )}
      {copy.review && (
        <p className="candidate-privacy-note r1-ended__note">{reviewNoteFor(audience)}</p>
      )}
      {withdraw && (
        <R1ConsentExit
          kind="withdraw"
          question={R1_WITHDRAW_QUESTIONS.after}
          busy={withdraw.busy}
          error={withdraw.error}
          onConfirm={withdraw.onConfirm}
        />
      )}
    </section>
  );
}
