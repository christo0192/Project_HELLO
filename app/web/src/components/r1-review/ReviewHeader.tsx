/**
 * The header of the review page: breadcrumb, title, and the chips that say what this interview is.
 *
 * "R1 interviews" is plain text until the queue exists (R1 PR 3). The name links to the candidate's
 * Overview, where the R1 card is today.
 *
 * A pending rejection can be cancelled from here, after a confirmation, by an admin or the interviewer
 * who sent the round: the API's own rule, so nobody is offered a button that can only answer 403.
 * Cancelling is the safe direction, and it is an audited override. Once the API has said yes the
 * chip and the button go, whether or not the re-read that follows can get through.
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog, SegmentedControl } from '../design';
import { Tag } from '../design/candidate';
import { api } from '../../api';
import { plainErrorText } from '../../lib/api-error-copy';
import { formatDateTime, formatRelative } from '../../lib/datetime';
import { r1RecordingStateCopy, attemptLabels } from '../../lib/r1-recording';
import { r1StatusLabel } from '../../lib/r1';
import { roundIsRunning } from '../../lib/r1-review';
import type { R1ReviewAttempt, R1ReviewResponse } from '../../lib/r1-types';

const nameLink =
  'underline underline-offset-4 hover:text-ink-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]';

function Chip({ children }: { children: ReactNode }) {
  return (
    <li>
      <Tag>{children}</Tag>
    </li>
  );
}

function cancelErrorWords(error: unknown): string {
  const code = (error as { message?: unknown } | null)?.message;
  if (code === 'not_pending') return 'This rejection is no longer pending.';
  return plainErrorText(typeof code === 'string' ? code : '');
}

export interface ReviewHeaderProps {
  review: R1ReviewResponse;
  candidateName: string;
  attempt: R1ReviewAttempt | null;
  mayCancelRejection: boolean;
  onSelectAttempt: (sessionId: string) => void;
  onChanged: () => void;
}

export function ReviewHeader({ review, candidateName, attempt, mayCancelRejection, onSelectAttempt, onChanged }: ReviewHeaderProps) {
  const { round, candidate, attempts } = review;
  const labels = attemptLabels(attempts);
  const label = attempt ? labels[attempts.indexOf(attempt)] : null;
  const recording = attempt ? r1RecordingStateCopy(attempt.recording) : null;
  const keptUntil = recording?.facts.find((fact) => fact.startsWith('Kept until'));
  const statusWord = round.status === 'in_progress' && !roundIsRunning(attempts) ? 'Link open' : r1StatusLabel(round.status);

  const [cancelledRound, setCancelledRound] = useState<string | null>(null);
  const pending = round.status_write === 'pending_reject' && round.pending_reject_until !== null && cancelledRound !== round.id;

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const cancelRejection = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancelR1PendingReject(round.id);
      setCancelledRound(round.id);
      setConfirming(false);
      onChanged();
    } catch (failure) {
      setError(cancelErrorWords(failure));
      // It may have changed under us: show the round as it is now.
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <header>
      <nav aria-label="Breadcrumb" className="text-label text-ink-tertiary">
        R1 interviews <span aria-hidden="true">/</span> {candidateName}
      </nav>
      <h1 className="mt-1 text-title text-ink">
        Sales Program Advisor role-play,{' '}
        <Link to={`/candidates/${candidate.id}?tab=overview`} className={nameLink}>
          {candidateName}
        </Link>
      </h1>

      <ul aria-label="About this interview" className="mt-3 flex flex-wrap items-center gap-2">
        {round.status !== 'completed' && <Chip>{statusWord}</Chip>}
        {attempt?.ended_at && <Chip>Ended {formatRelative(attempt.ended_at)}</Chip>}
        {candidate.role_title && <Chip>{candidate.role_title}</Chip>}
        {attempts.length === 1 && label && <Chip>{label}</Chip>}
        {attempts.length > 1 && attempt && (
          <li className="min-w-0 max-w-full">
            <SegmentedControl
              size="sm"
              className="flex-wrap"
              ariaLabel="Attempt"
              value={attempt.session_id}
              onChange={onSelectAttempt}
              options={attempts.map((item, index) => ({ value: item.session_id, label: labels[index] }))}
            />
          </li>
        )}
        {recording && (
          <Chip>
            <span className="sr-only">Recording: </span>
            {recording.tag}
            {keptUntil ? ` · ${keptUntil}` : ''}
          </Chip>
        )}
        {round.is_staff_dry_run && <Chip>Staff dry run</Chip>}
        {pending && (
          <li className="flex items-center gap-2">
            <Tag>Rejection pending until {formatDateTime(round.pending_reject_until)}</Tag>
            {mayCancelRejection && (
              <Button
                ref={cancelRef}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
              >
                Cancel rejection
              </Button>
            )}
          </li>
        )}
      </ul>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Cancel this pending rejection?"
        description="The candidate's status stays as it is. The cancellation is recorded as an override of the AI result."
        idPrefix="r1-cancel-rejection"
        returnFocusRef={cancelRef}
        busy={busy}
      >
        {error && (
          <p role="alert" className="mt-3 text-sm text-ink">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            Keep it pending
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void cancelRejection()}>
            Cancel the rejection
          </Button>
        </div>
      </Dialog>
    </header>
  );
}
