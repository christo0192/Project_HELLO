import { Button } from '../ui';
import { R1ConsentExit } from './R1ConsentExit';
import { R1_WITHDRAW_QUESTIONS } from './r1-copy';

interface R1LandingProps {
  roleTitle: string;
  /** The format pills: duration, camera, privacy. */
  pills: readonly string[];
  attemptsLeft: number;
  /** A join that failed just now; the link is still usable. */
  error: string | null;
  /**
   * Something the person should know before they start, that is not a failure: their
   * interview is open somewhere else, or the one they were in has ended and starting
   * again is a new one.
   */
  notice?: string | null;
  /** Why the last withdrawal did not go through. */
  withdrawError?: string | null;
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
  notice = null,
  withdrawError = null,
  busy,
  onContinue,
  onWithdraw,
}: R1LandingProps) {
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
      {notice && (
        <p className="candidate-muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="candidate-error" role="alert">
          {error}
        </p>
      )}
      <Button className="candidate-primary-cta" loading={busy} onClick={onContinue}>
        Check my camera and microphone
      </Button>
      <R1ConsentExit
        kind="withdraw"
        question={R1_WITHDRAW_QUESTIONS.before}
        busy={busy}
        error={withdrawError}
        onConfirm={onWithdraw}
      />
    </section>
  );
}
