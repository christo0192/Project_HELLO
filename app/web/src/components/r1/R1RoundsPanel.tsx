/**
 * R1RoundsPanel: every R1 round for a candidate, newest first.
 *
 * Shows what the list route returns today: status, when the link was sent,
 * its expiry while it can still be used, attempts used, and the result once
 * the scorer has written one. Until then the row says so in words instead of
 * leaving a gap, and only while a score can still arrive: past that it says not
 * scored, as the queue does.
 * While an appeal blocks decision use the result reads as withheld instead.
 * The result stays on the row through a retake, which re-opens the round.
 * A score with no recommendation is not a result: only a valid gated score
 * carries one (0122), so that figure never prints here.
 *
 * A status reads as it does on the queue and the review: a lapsed link is
 * Expired whatever is stored, so nobody here waits on a dead link.
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
 * A round held over Google Meet (`channel: 'meet'`) carries a "Via Meet" chip
 * and has no candidate link: no Reissue, "Open until" for its expiry, and its
 * cancel and retake words cover both ways it can be booked (by the candidate on
 * the public booking link, or by HR in Ashby). The panel cannot tell which: the
 * round reads carry no source, so the same words must be true for either. Nor
 * can it tell whether public booking is switched on (a flag of its own on top of
 * Meet, read by no staff page), so every word about booking on the public link
 * says "if public booking is switched on". Cancelling an unstarted Meet round
 * with no counted attempt says the candidate can still book a new interview
 * there: such a round is not an R1, so the public link takes them again.
 * A round without `channel: 'meet'` reads exactly as before.
 *
 * Recordings: one chip per attempt that has anything to say (a recording in any
 * state, or, once the round has completed, the fact that none was made), for
 * EVERY role. Nothing plays here: "Open R1 review" is where the recording is, so
 * a page has only one player.
 *
 * Renders inside `.candidate-scope` (`--c-*` tokens only, no motion import).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { CandidateButton, Tag } from '../design/candidate';
import { FAMILY_CLASSES, verdictFamily } from '../design/tones';
import type { IssuedLinkValue } from './SendR1Controls';
import { ViaMeetTag } from './ViaMeetTag';
import { formatDateTime } from '../../lib/datetime';
import {
  R1_LINK_VALID_HOURS,
  R1_RECOMMENDATION_LABEL,
  R1_RESULT_WITHHELD,
  attemptsLabel,
  canActOnRound,
  canCancel,
  canGrantRetake,
  canReissue,
  isMeetRound,
  openUntilLead,
  r1ErrorMessage,
  r1StatusTone,
} from '../../lib/r1';
import { attemptLabels, r1RecordingStateCopy, showsRecordingRow } from '../../lib/r1-recording';
import { roundStatusWord, scoreCanArrive, shownRoundStatus } from '../../lib/r1-review';
import type { R1Round } from '../../lib/r1-types';
import type { MeResponse } from '../../types';

type RoundAction = 'reissue' | 'cancel' | 'grant-retake';

interface Pending {
  roundId: string;
  action: RoundAction;
}

/**
 * Public booking is a flag of its own on top of Meet, and no staff read carries it: every word about
 * booking on the public link holds whether it is on or off.
 */
const IF_PUBLIC_ON = 'if public booking is switched on';

/**
 * Cancelling a Meet round nobody has started, with no counted attempt, does not end the candidate's R1:
 * such a round is not an R1 (contracts §9, S01-R1), so the public link books them again while their
 * Ashby application is active. Said only then: a counted attempt (a cancelled retake) ends the public
 * path, and a round in progress may count one before the cancel lands.
 */
function rebookNote(round: R1Round): string {
  return round.status === 'invited' && round.attempts_counted === 0
    ? ` The candidate can still book a new interview on the public booking link ${IF_PUBLIC_ON} and their ` +
        'Ashby application is active.'
    : '';
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
      isMeetRound(round)
        ? `Its reserved minutes are released. ${runningCallNote(round)}If the candidate booked it on the ` +
          'public booking link, it comes off Lexy’s calendar unless the slot has started. If it was ' +
          `scheduled in Ashby, it stays there until it is cancelled there.${rebookNote(round)}`
        : `The link stops working and its reserved minutes are released. ${runningCallNote(round)}` +
          'A new round can be sent afterwards.',
    confirm: 'Cancel round',
    keep: 'Keep round',
  },
  'grant-retake': {
    title: 'Grant the one retake?',
    body: (round) =>
      isMeetRound(round)
        ? `The round opens again for ${R1_LINK_VALID_HOURS} hours. Before then, you can schedule the ` +
          `retake in Ashby with Lexy, or the candidate can book it on the public booking link ${IF_PUBLIC_ON}.`
        : 'The candidate can use their original link again for ' +
          `${R1_LINK_VALID_HOURS} hours. A retake can be granted once.`,
    confirm: 'Grant retake',
    keep: 'Not now',
  },
};

/** Cancelling a round does not hang up an interview that is running: said only while one may be. */
function runningCallNote(round: R1Round): string {
  return round.status === 'in_progress' ? 'This does not end a call that is already running. ' : '';
}

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
  /**
   * An appeal blocks decision use. The API nulls the scores, which must not read as "no results yet":
   * every round that would show a result says it is withheld, and no score prints even if one arrives.
   * This is what the page knew when it loaded; a round's own `scores_withheld` covers an appeal opened
   * since then, once a re-read brings it.
   */
  decisionBlocked?: boolean;
}

export function R1RoundsPanel({
  rounds,
  role,
  userId,
  onIssued,
  onChanged,
  onMessage,
  onSettled,
  decisionBlocked = false,
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
          isMeetRound(round)
            ? `Retake granted. Within ${R1_LINK_VALID_HOURS} hours, you can schedule it in Ashby with ` +
                `Lexy, or the candidate can book it on the public booking link ${IF_PUBLIC_ON}.`
            : 'Retake granted. The candidate’s original link works again for ' +
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

  const nowMs = Date.now();

  return (
    <ul aria-label="R1 rounds" className="divide-y divide-line">
      {rounds.map((round) => {
        const live = round.status === 'invited' || round.status === 'in_progress';
        // One recording chip per attempt, in attempt order (the API sends them that way). An older
        // API sends no `attempts`, and then there is simply nothing to add here.
        const attempts = Array.isArray(round.attempts) ? round.attempts : [];
        const status = shownRoundStatus(round, attempts, nowMs);
        // A list with no attempts could not read them, which says nothing about a score either way.
        const scoreGone =
          round.status === 'completed' &&
          Array.isArray(round.attempts) &&
          !attempts.some((attempt) => scoreCanArrive(attempt, round.created_at, nowMs));
        const notScored =
          round.recommendation === null &&
          (round.status_write === 'human_review' || round.overall !== null || scoreGone);
        const withheld = decisionBlocked || round.scores_withheld === true;
        const showsResult =
          round.recommendation !== null ||
          notScored ||
          status === 'completed' ||
          status === 'in_progress';
        // A verdict takes its family, as the header above this card does. No verdict, no hue.
        const family = verdictFamily(round.recommendation);
        const active = pending?.roundId === round.id ? pending : null;
        const headingId = `r1-round-${uid}-${round.id}`;
        const labels = attemptLabels(attempts);
        const recordings = attempts.flatMap((attempt, index) =>
          showsRecordingRow(attempt?.recording, round.status === 'completed')
            ? [{ id: attempt.session_id, label: labels[index], copy: r1RecordingStateCopy(attempt.recording) }]
            : [],
        );
        return (
          <li key={round.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span id={headingId} className="font-medium text-ink">
                Sent {formatDateTime(round.created_at)}
              </span>
              <Tag tone={r1StatusTone(status)} srPrefix="Status:">
                {roundStatusWord(round, attempts, nowMs)}
              </Tag>
              {round.is_staff_dry_run === true && <Tag>Staff dry run</Tag>}
              <ViaMeetTag channel={round.channel} />
              <span className="text-label text-ink-secondary">{attemptsLabel(round)}</span>
              <Link
                to={`/interviews/${round.id}`}
                className="text-label text-ink underline underline-offset-2 hover:text-ink-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
              >
                Open R1 review
              </Link>
            </div>

            {status === 'invited' && (
              <p className="mt-1 text-label text-ink-secondary">
                {openUntilLead(round)} {formatDateTime(round.expires_at)}
              </p>
            )}

            {showsResult && (
              <p className="mt-1 text-label text-ink-secondary">
                {withheld ? (
                  R1_RESULT_WITHHELD
                ) : round.recommendation !== null ? (
                  <span className={family ? FAMILY_CLASSES[family].text : undefined}>
                    {`AI recommendation: ${R1_RECOMMENDATION_LABEL[round.recommendation]}` +
                      (round.overall !== null ? ` · Overall ${Math.round(round.overall)} of 100` : '')}
                  </span>
                ) : notScored ? (
                  'AI result: not scored. Open the R1 review for the reason.'
                ) : (
                  'No results yet. The scorecard and recommendation will appear here once R1 ' +
                  'scoring is live.'
                )}
              </p>
            )}

            {recordings.length > 0 && (
              <ul aria-label="Recordings" className="mt-2 flex flex-wrap gap-2">
                {recordings.map(({ id, label, copy }) => (
                  <li key={id}>
                    <Tag tone={copy.tone} srPrefix="Recording:">
                      {label}: {copy.tag}
                    </Tag>
                  </li>
                ))}
              </ul>
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
