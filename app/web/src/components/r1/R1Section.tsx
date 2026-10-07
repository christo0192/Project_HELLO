/**
 * R1Section: the "R1 interview" card on the candidate page. It is the Send R1
 * card and the R1 panel in one surface: the card sends (and shows the link
 * once), the panel lists the rounds and what can be done to each.
 *
 * Data. One read of the candidate's rounds (viewer and above) and, for
 * people who can send, one read of availability. The two fail independently:
 * a failed availability read must not hide the rounds, so availability then
 * reads as unknown and the server's refusal codes carry the explanation.
 * Nothing is drawn until both reads have settled, so a server that does not
 * run R1 (`not_deployed`, production today) never flashes a card.
 *
 * Who sees what (a UX gate only; the API re-checks role and ownership):
 *   - admin / interviewer: Send R1 (when the candidate has no live round and
 *     has used no attempt), availability reasons, and the round actions on
 *     their own rounds (an admin: every round);
 *   - viewer: the rounds, read-only; no card at all when there are none;
 *   - nobody: a card at all while the server does not run R1 and there is no
 *     round to show.
 *
 * Disabled state. R1 off, paused, out of allowance, not set up or
 * misconfigured is shown as a visible reason beside a focusable but inert
 * Send R1 button (see SendR1Controls). It comes from `GET
 * /api/interview-rounds/availability`, which reads `r1_settings`; the
 * settings route itself is admin-only.
 *
 * The one-time link is held in this component's state only, so leaving the
 * page or pressing "I have copied the link" drops it for good.
 *
 * Renders inside `.candidate-scope` (`--c-*` tokens only, no motion import).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { SurfaceCard, CandidateButton } from '../design/candidate';
import { IssuedLink } from './IssuedLink';
import { R1RoundsPanel } from './R1RoundsPanel';
import { SendR1Controls } from './SendR1Controls';
import type { IssuedLinkValue } from './SendR1Controls';
import { R1_LINK_VALID_HOURS, sendGate, sendGateNotice } from '../../lib/r1';
import type { R1AvailabilityResponse, R1Round } from '../../lib/r1-types';
import type { MeResponse } from '../../types';

export interface R1SectionProps {
  candidateId: string;
  candidateName: string | null;
  role: MeResponse['role'];
  /** The signed-in user, so round actions are offered only on rounds they may act on. */
  userId: string | null;
}

type RoundsState =
  | { status: 'loading' }
  | { status: 'error'; message: string; forbidden: boolean }
  | { status: 'ready'; rounds: R1Round[] };

export function R1Section({ candidateId, candidateName, role, userId }: R1SectionProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const canManage = role === 'admin' || role === 'interviewer';
  const isAdmin = role === 'admin';

  const [rounds, setRounds] = useState<RoundsState>({ status: 'loading' });
  const [availability, setAvailability] = useState<R1AvailabilityResponse | null>(null);
  // True once the availability read has answered or failed (null then means "unknown").
  const [availabilitySettled, setAvailabilitySettled] = useState(false);
  const [issued, setIssued] = useState<IssuedLinkValue | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Only the newest read may write state: a slow answer to an older read must
  // not overwrite what a newer one already showed.
  const roundsTicket = useRef(0);
  const availabilityTicket = useRef(0);

  const loadRounds = useCallback(() => {
    const ticket = ++roundsTicket.current;
    // `Promise.resolve().then(...)`, not a bare call: this is an add-on card on
    // a page that carries the transcript, scorecard and appeal controls, and a
    // synchronous throw inside an effect (an API adapter without this endpoint)
    // would unmount all of it. Inside the chain it is an ordinary rejection.
    Promise.resolve()
      .then(() => api.listR1Rounds(candidateId))
      .then((result) => {
        if (ticket !== roundsTicket.current) return;
        setRounds({ status: 'ready', rounds: Array.isArray(result?.rounds) ? result.rounds : [] });
      })
      .catch((e: unknown) => {
        if (ticket !== roundsTicket.current) return;
        const forbidden = e instanceof ApiError && e.status === 403;
        setRounds({
          status: 'error',
          forbidden,
          message: forbidden
            ? 'R1 is not available for this candidate.'
            : 'R1 rounds could not be loaded.',
        });
      });
  }, [candidateId]);

  const loadAvailability = useCallback(() => {
    if (!canManage) return;
    const ticket = ++availabilityTicket.current;
    Promise.resolve()
      .then(() => api.getR1Availability())
      .then((result) => {
        if (ticket !== availabilityTicket.current) return;
        setAvailability(result);
        setAvailabilitySettled(true);
      })
      .catch(() => {
        // Unknown, not "off": the server still decides on send.
        if (ticket !== availabilityTicket.current) return;
        setAvailability(null);
        setAvailabilitySettled(true);
      });
  }, [canManage]);

  useEffect(() => {
    setRounds({ status: 'loading' });
    setAvailability(null);
    setAvailabilitySettled(false);
    setIssued(null);
    setMessage(null);
    loadRounds();
    loadAvailability();
  }, [candidateId, loadRounds, loadAvailability]);

  const settle = useCallback(() => {
    headingRef.current?.focus();
  }, []);

  // The card never flashes in only to disappear: nothing is drawn until what decides
  // whether it exists has answered. A viewer has nothing to do until a round exists;
  // a 403 means the candidate is not theirs; and a server that does not run R1 has no
  // card unless a round already exists to show.
  if (rounds.status === 'loading') return null;
  if (rounds.status === 'error' && rounds.forbidden) return null;
  if (rounds.status === 'ready') {
    if (!canManage && rounds.rounds.length === 0) return null;
    if (canManage && !availabilitySettled) return null;
    if (rounds.rounds.length === 0 && availability?.state === 'not_deployed') return null;
  }

  const list = rounds.status === 'ready' ? rounds.rounds : [];
  const gate = sendGate(list);
  const gateNotice = sendGateNotice(gate);
  const issuedExpiry =
    issued?.expiresAt ?? list.find((round) => round.id === issued?.roundId)?.expires_at ?? null;

  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-section text-ink outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        R1 interview
      </h2>
      <p className="mt-0.5 text-label text-ink-secondary">
        Sales Program Advisor role-play. The link is shown once, valid for{' '}
        {R1_LINK_VALID_HOURS} hours, with one retake.
      </p>

      {rounds.status === 'error' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-ink-secondary">
            {rounds.message}
          </p>
          <CandidateButton
            variant="secondary"
            size="md"
            onClick={() => {
              setRounds({ status: 'loading' });
              loadRounds();
              loadAvailability();
            }}
          >
            Retry
          </CandidateButton>
        </div>
      )}

      {rounds.status === 'ready' && (
        <>
          {issued && (
            <IssuedLink
              url={issued.url}
              expiresAt={issuedExpiry}
              kind={issued.kind}
              onDismiss={() => {
                setIssued(null);
                settle();
              }}
            />
          )}

          {canManage && gate.kind === 'open' && (
            <div className="mt-4">
              <SendR1Controls
                candidateId={candidateId}
                candidateName={candidateName}
                availability={availability?.state ?? null}
                holdMinutes={availability?.hold_minutes ?? 55}
                isAdmin={isAdmin}
                onIssued={setIssued}
                onSent={loadRounds}
                onAvailabilityRefused={loadAvailability}
                onMessage={setMessage}
              />
            </div>
          )}

          {canManage && gateNotice && (
            <p className="mt-3 text-sm text-ink-secondary">{gateNotice}</p>
          )}

          {/* Always mounted, so a change of text is announced reliably. A polite
              live region rather than `role="status"`: the phone card above has
              its own status line, and a page with two of them is ambiguous to
              anything that looks the status up by role. */}
          <p aria-live="polite" className="mt-3 min-h-5 text-sm text-ink">
            {message}
          </p>

          {list.length > 0 ? (
            <div className="mt-2">
              <R1RoundsPanel
                rounds={list}
                role={role}
                userId={userId}
                onIssued={setIssued}
                onChanged={() => {
                  loadRounds();
                  loadAvailability();
                }}
                onMessage={setMessage}
                onSettled={settle}
              />
            </div>
          ) : (
            <p className="mt-1 text-sm text-ink-secondary">No R1 round has been sent yet.</p>
          )}
        </>
      )}
    </SurfaceCard>
  );
}
