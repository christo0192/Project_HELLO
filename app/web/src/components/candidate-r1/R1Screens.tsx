import type { ReactNode } from 'react';
import '../../styles/candidate-experience.css';
import '../../styles/candidate-r1.css';
import { Button } from '../ui';
import {
  R1_CLOSED_COPY,
  R1_ENDED_COPY,
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

interface R1ClosedCardProps {
  kind: R1ClosedKind;
  /** Offered for the temporary states, where trying again is meaningful. */
  onRetry?: () => void;
}

/** A terminal or waiting card with no interview controls. */
export function R1ClosedCard({ kind, onRetry }: R1ClosedCardProps) {
  const copy = R1_CLOSED_COPY[kind];
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
    </section>
  );
}

interface R1EndedCardProps {
  kind: R1EndedKind;
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
export function R1EndedCard({ kind, onRejoin }: R1EndedCardProps) {
  const copy = R1_ENDED_COPY[kind];
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
        <p className="candidate-privacy-note r1-ended__note">
          An AI helps evaluate this interview and the hiring team reviews the result. To contest
          the result, reply to the hiring team&rsquo;s email and they will send you an appeal link.
        </p>
      )}
    </section>
  );
}
