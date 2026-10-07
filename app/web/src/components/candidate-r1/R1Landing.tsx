import { useState } from 'react';
import { Button } from '../ui';

interface R1LandingProps {
  roleTitle: string;
  /** The format pills: duration, camera, privacy. */
  pills: readonly string[];
  attemptsLeft: number;
  error: string | null;
  busy: boolean;
  onContinue: () => void;
  onWithdraw: () => void;
}

/**
 * The page a candidate with consent on file lands on. It describes the format,
 * states how many attempts remain, and offers the one consent control the
 * plan requires after agreeing: withdrawal (plan section 7.8), behind an
 * explicit confirmation because it ends the interview for this link.
 */
export function R1Landing({
  roleTitle,
  pills,
  attemptsLeft,
  error,
  busy,
  onContinue,
  onWithdraw,
}: R1LandingProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section
      className="candidate-glass-card candidate-landing candidate-status-card"
      aria-labelledby="r1-landing-title"
    >
      <p className="candidate-eyebrow">Your invitation</p>
      <h1 id="r1-landing-title">Video interview</h1>
      <h2 className="candidate-role">{roleTitle}</h2>
      <p className="candidate-muted">
        A conversation with our AI interviewer that includes a short sales role-play. Your
        consent is on file. Next we will check your camera, microphone and connection.
      </p>
      <div className="candidate-landing__meta">
        {pills.map((pill) => (
          <span className="candidate-pill" key={pill}>
            {pill}
          </span>
        ))}
      </div>
      <p className="candidate-muted">
        {attemptsLeft === 1
          ? 'You have 1 attempt left.'
          : `You have ${attemptsLeft} attempts left.`}
      </p>
      {error && (
        <p className="candidate-error" role="alert">
          {error}
        </p>
      )}
      <Button className="candidate-primary-cta" loading={busy} onClick={onContinue}>
        Check my camera and microphone
      </Button>
      {confirming ? (
        <div className="r1-withdraw" role="group" aria-label="Withdraw consent">
          <p className="candidate-muted">
            Withdraw your consent? Your interview cannot go ahead without it.
          </p>
          <div className="r1-actions">
            <button type="button" className="r1-secondary-cta" disabled={busy} onClick={onWithdraw}>
              Withdraw my consent
            </button>
            <button
              type="button"
              className="r1-secondary-cta"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep my consent
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="r1-link-button" onClick={() => setConfirming(true)}>
          Withdraw my consent
        </button>
      )}
    </section>
  );
}
