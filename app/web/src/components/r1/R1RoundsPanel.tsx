/**
 * R1RoundsPanel: every R1 round for a candidate, newest first.
 *
 * Shows what the list route returns today: status, when the link was sent,
 * its expiry while it can still be used, attempts used, and the result once
 * the scorer has written one. Until scoring ships (PR-5) the recommendation
 * and score are null, and the row says so in words instead of leaving a gap.
 *
 * Row actions (an admin, or the interviewer who created the round: the API's own
 * rule, so nobody is offered a button that can only answer 403):
 *   - Reissue link: replaces the link of a round nobody has started.
 *   - Cancel round: ends a live round and releases its reserved minutes.
 *   - Grant retake: the one retake, after a counted first attempt.
 * Each asks for an inline confirmation first. Only one confirmation is open
 * at a time; focus moves to it, Escape closes it and returns focus to the
 * button that opened it, and a finished action hands focus to the card.
 *
 * Renders inside `.candidate-scope` (`--c-*` tokens only, no motion import).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../../api';
import { CandidateButton, Tag } from '../design/candidate';
import type { IssuedLinkValue } from './SendR1Controls';
import { formatDateTime } from '../../lib/datetime';
import {
  R1_LINK_VALID_HOURS,
  R1_RECOMMENDATION_LABEL,
  attemptsLabel,
  canActOnRound,
  canCancel,
  canGrantRetake,
  canReissue,
  r1ErrorMessage,
  r1StatusLabel,
  r1StatusTone,
} from '../../lib/r1';
import type { R1Round } from '../../lib/r1-types';
import type { MeResponse } from '../../types';

type RoundAction = 'reissue' | 'cancel' | 'grant-retake';

interface Pending {
  roundId: string;
  action: RoundAction;
}

const CONFIRM_COPY: Record<
  RoundAction,
  { title: string; body: (round: R1Round) => ReactNode; confirm: string; keep: string }
> = {
  reissue: {
    title: 'Reissue the link?',
    body: () =>
      'The current link stops working immediately. A new link is shown once, valid for ' +
      `${R1_LINK_VALID_HOURS} hours.`,
    confirm: 'Reissue link',
    keep: 'Keep current link',
  },
  cancel: {
    title: 'Cancel this R1 round?',
    body: (round) =>
      `The link stops working and its reserved minutes are released. ${
        round.status === 'in_progress'
          ? 'This does not end a call that is already running. '
          : ''
      }A new round can be sent afterwards.`,
    confirm: 'Cancel round',
    keep: 'Keep round',
  },
  'grant-retake': {
    title: 'Grant the one retake?',
    body: () =>
      'The candidate can use their original link again for ' +
      `${R1_LINK_VALID_HOURS} hours. A retake can be granted once.`,
    confirm: 'Grant retake',
    keep: 'Not now',
  },
};

export interface R1RoundsPanelProps {
  rounds: readonly R1Round[];
  /** A viewer's rows are read-only; an interviewer acts only on rounds they created. */
  role: MeResponse['role'];
  /** The signed-in user (null until known): who "created the round" is compared to. */
  userId: string | null;
  onIssued: (link: IssuedLinkValue) => void;
  /** Server state changed: re-read the rounds. */
  onChanged: () => void;
  onMessage: (message: string | null) => void;
  /** An action finished: put focus somewhere that still exists. */
  onSettled: () => void;
}

export function R1RoundsPanel({
  rounds,
  role,
  userId,
  onIssued,
  onChanged,
  onMessage,
  onSettled,
}: R1RoundsPanelProps) {
  const uid = useId().replace(/:/g, '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wellRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // A refresh can remove the round a confirmation is about, or make its action
  // impossible (the link expired while the question was open): close it.
  useEffect(() => {
    if (!pending) return;
    const round = rounds.find((r) => r.id === pending.roundId);
    const stillPossible =
      round !== undefined &&
      (pending.action === 'reissue'
        ? canReissue(round)
        : pending.action === 'cancel'
          ? canCancel(round)
          : canGrantRetake(round));
    if (!stillPossible) {
      setPending(null);
      setError(null);
    }
  }, [pending, rounds]);

  useEffect(() => {
    if (pending) wellRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const well = wellRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      setPending(null);
      setError(null);
      openerRef.current?.focus();
    };
    well?.addEventListener('keydown', onKeyDown);
    return () => well?.removeEventListener('keydown', onKeyDown);
  }, [pending, busy]);

  function open(round: R1Round, action: RoundAction, opener: HTMLElement) {
    openerRef.current = opener;
    onMessage(null);
    setError(null);
    setPending({ roundId: round.id, action });
  }

  async function run(round: R1Round, action: RoundAction) {
    setBusy(true);
    setError(null);
    try {
      if (action === 'reissue') {
        const result = await api.reissueR1Round(round.id);
        onIssued({ url: result.join_url, expiresAt: null, roundId: round.id, kind: 'reissue' });
        onMessage('New R1 link created. Copy it now: it is shown once.');
      } else if (action === 'cancel') {
        await api.cancelR1Round(round.id);
        onMessage('R1 round cancelled. Its reserved minutes were released.');
      } else {
        await api.grantR1Retake(round.id);
        onMessage(
          'Retake granted. The candidate’s original link works again for ' +
            `${R1_LINK_VALID_HOURS} hours; reissue a link if you no longer have it.`,
        );
      }
      setPending(null);
      onChanged();
      onSettled();
    } catch (e) {
      const code = e instanceof ApiError ? e.message : '';
      setError(r1ErrorMessage(code, 'round'));
      // A version conflict means the row moved under us; show it as it is now.
      if (code === 'round_transition_conflict' || code === 'retake_not_allowed') onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ul aria-label="R1 rounds" className="divide-y divide-line">
      {rounds.map((round) => {
        const live = round.status === 'invited' || round.status === 'in_progress';
        const scored = round.recommendation !== null || round.overall !== null;
        const showsResult = round.status === 'completed' || round.status === 'in_progress';
        const active = pending?.roundId === round.id ? pending : null;
        const headingId = `r1-round-${uid}-${round.id}`;
        return (
          <li key={round.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span id={headingId} className="font-medium text-ink">
                Sent {formatDateTime(round.created_at)}
              </span>
              <Tag tone={r1StatusTone(round.status)} srPrefix="Status:">
                {r1StatusLabel(round.status)}
              </Tag>
              <span className="text-label text-ink-secondary">{attemptsLabel(round)}</span>
            </div>

            {round.status === 'invited' && (
              <p className="mt-1 text-label text-ink-secondary">
                Link valid until {formatDateTime(round.expires_at)}
              </p>
            )}

            {showsResult && (
              <p className="mt-1 text-label text-ink-secondary">
                {scored ? (
                  <>
                    {round.recommendation
                      ? `Recommendation: ${R1_RECOMMENDATION_LABEL[round.recommendation]}`
                      : null}
                    {round.recommendation && round.overall !== null ? ' · ' : null}
                    {round.overall !== null ? `Overall ${round.overall} of 100` : null}
                  </>
                ) : (
                  'No results yet. The scorecard and recommendation will appear here once R1 ' +
                  'scoring is live.'
                )}
              </p>
            )}

            {canActOnRound(round, role, userId) && (live || canGrantRetake(round)) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {canReissue(round) && (
                  <CandidateButton
                    variant="secondary"
                    size="md"
                    aria-expanded={active?.action === 'reissue'}
                    onClick={(event) => open(round, 'reissue', event.currentTarget)}
                  >
                    Reissue link
                  </CandidateButton>
                )}
                {canGrantRetake(round) && (
                  <CandidateButton
                    variant="secondary"
                    size="md"
                    aria-expanded={active?.action === 'grant-retake'}
                    onClick={(event) => open(round, 'grant-retake', event.currentTarget)}
                  >
                    Grant retake
                  </CandidateButton>
                )}
                {canCancel(round) && (
                  <CandidateButton
                    variant="danger-quiet"
                    size="md"
                    aria-expanded={active?.action === 'cancel'}
                    onClick={(event) => open(round, 'cancel', event.currentTarget)}
                  >
                    Cancel round
                  </CandidateButton>
                )}
              </div>
            )}

            {active && (
              <div
                ref={wellRef}
                role="group"
                tabIndex={-1}
                aria-labelledby={`${headingId}-confirm`}
                className="glass-sunken mt-3 p-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
              >
                <h3 id={`${headingId}-confirm`} className="text-label font-medium text-ink">
                  {CONFIRM_COPY[active.action].title}
                </h3>
                <p className="mt-1 text-sm text-ink-secondary">
                  {CONFIRM_COPY[active.action].body(round)}
                </p>
                {error && (
                  <p role="alert" className="mt-2 text-sm text-ink">
                    {error}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <CandidateButton
                    variant={active.action === 'cancel' ? 'danger-quiet' : 'primary'}
                    onClick={() => void run(round, active.action)}
                    loading={busy}
                  >
                    {CONFIRM_COPY[active.action].confirm}
                  </CandidateButton>
                  <CandidateButton
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setPending(null);
                      setError(null);
                      openerRef.current?.focus();
                    }}
                  >
                    {CONFIRM_COPY[active.action].keep}
                  </CandidateButton>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
