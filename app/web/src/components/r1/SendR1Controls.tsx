/**
 * SendR1Controls: the "Send R1" action of the candidate's R1 card.
 *
 * Flow: a trigger opens an inline confirmation (non-modal, like the phone
 * card's) that carries the India-location attestation the API requires
 * (plan D14) and states what sending does; "Create link" posts it and hands
 * the one-time URL to the card through `onIssued`.
 *
 * Disabled state. When availability says R1 cannot take a send, the trigger
 * stays focusable with `aria-disabled` and a visible reason tied to it by
 * `aria-describedby`: a natively disabled button drops out of the tab order,
 * and the reason is the whole point. The reason is a hint, not a guarantee in
 * either direction: when availability was `ready` and the send is still
 * refused for a capacity or switch reason, the card re-reads availability
 * (see `onAvailabilityRefused`) so the button then shows why.
 *
 * Renders inside `.candidate-scope` (`--c-*` tokens only, no motion import).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { CandidateButton } from '../design/candidate';
import {
  R1_AVAILABILITY_COPY,
  R1_LINK_VALID_HOURS,
  availabilityFixableInSettings,
  isAvailabilityRefusal,
  r1ErrorMessage,
} from '../../lib/r1';
import type { R1AvailabilityState } from '../../lib/r1-types';

export interface IssuedLinkValue {
  url: string;
  /** Null for a reissue: the API returns only the URL, the card reads the expiry back. */
  expiresAt: string | null;
  /** The round the link belongs to, so a missing expiry can be read from the rounds list. */
  roundId: string;
  kind: 'send' | 'reissue';
}

export interface SendR1ControlsProps {
  candidateId: string;
  candidateName: string | null;
  /** `null` while unknown (the availability read failed): the server decides. */
  availability: R1AvailabilityState | null;
  holdMinutes: number;
  /** Admins are pointed at R1 settings when the fix lives there. */
  isAdmin: boolean;
  onIssued: (link: IssuedLinkValue) => void;
  /** The send changed server state (a round now exists): re-read the rounds. */
  onSent: () => void;
  /** The server refused for a reason availability should have shown. */
  onAvailabilityRefused: () => void;
  /** Politely announced and shown beside the controls. */
  onMessage: (message: string | null) => void;
}

export function SendR1Controls({
  candidateId,
  candidateName,
  availability,
  holdMinutes,
  isAdmin,
  onIssued,
  onSent,
  onAvailabilityRefused,
  onMessage,
}: SendR1ControlsProps) {
  const uid = useId().replace(/:/g, '');
  const confirmHeadingId = `r1-send-${uid}-confirm`;
  const reasonId = `r1-send-${uid}-reason`;
  const attestId = `r1-send-${uid}-attest`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const attestRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = availability !== null && availability !== 'ready';
  const reason = blocked ? R1_AVAILABILITY_COPY[availability] : null;
  const name = candidateName?.trim() || 'this candidate';

  const closeConfirm = useCallback(() => {
    setConfirming(false);
    setAttested(false);
    setError(null);
    triggerRef.current?.focus();
  }, []);

  // Availability can flip while the confirmation is open (a pause, a refused
  // send). A confirmation for a send that cannot happen is closed.
  useEffect(() => {
    if (blocked && confirming) {
      setConfirming(false);
      setAttested(false);
    }
  }, [blocked, confirming]);

  useEffect(() => {
    if (confirming) attestRef.current?.focus();
  }, [confirming]);

  // Escape closes the (non-modal) confirmation and returns focus to its trigger.
  useEffect(() => {
    if (!confirming) return;
    const well = confirmRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      closeConfirm();
    };
    well?.addEventListener('keydown', onKeyDown);
    return () => well?.removeEventListener('keydown', onKeyDown);
  }, [confirming, busy, closeConfirm]);

  async function send() {
    if (!attested || busy) return;
    setBusy(true);
    setError(null);
    onMessage(null);
    try {
      const created = await api.sendR1Round(candidateId, { india_location_attested: true });
      setConfirming(false);
      setAttested(false);
      onIssued({
        url: created.join_url,
        expiresAt: created.expires_at,
        roundId: created.id,
        kind: 'send',
      });
      onMessage('R1 link created. Copy it now: it is shown once.');
      onSent();
    } catch (e) {
      const code = e instanceof ApiError ? e.message : '';
      setError(r1ErrorMessage(code, 'send'));
      if (isAvailabilityRefusal(code)) onAvailabilityRefused();
      // A 409 from a race (another tab, another recruiter) leaves a round
      // behind that this page has not seen yet.
      if (code === 'round_active') onSent();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {reason && (
        <div
          id={reasonId}
          className="rounded-xl border border-[var(--c-caution)] bg-[var(--c-caution-light)] p-3"
        >
          <p className="text-sm font-medium text-ink">{reason.title}</p>
          <p className="mt-0.5 text-sm text-ink-secondary">{reason.detail}</p>
          {isAdmin && availability && availabilityFixableInSettings(availability) && (
            <Link
              to="/admin/r1"
              className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-ink underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
            >
              Open R1 settings
            </Link>
          )}
        </div>
      )}

      <div className={blocked ? 'mt-3' : undefined}>
        <CandidateButton
          ref={triggerRef}
          variant="primary"
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? reasonId : undefined}
          aria-expanded={confirming}
          aria-controls={confirming ? `${confirmHeadingId}-well` : undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (blocked) return;
            onMessage(null);
            setConfirming(true);
          }}
        >
          Send R1
        </CandidateButton>
      </div>

      {confirming && !blocked && (
        <div
          id={`${confirmHeadingId}-well`}
          ref={confirmRef}
          role="group"
          aria-labelledby={confirmHeadingId}
          className="glass-sunken mt-4 p-4"
        >
          <h3 id={confirmHeadingId} className="text-label font-medium text-ink">
            Send R1 to {name}
          </h3>
          <p className="mt-1 text-sm text-ink-secondary">
            This creates a one-time link to the Sales Program Advisor role-play. The link is
            shown once, is valid for {R1_LINK_VALID_HOURS} hours and allows one retake.
            Sending reserves {holdMinutes} minutes of this month’s R1 allowance.
          </p>
          <label
            htmlFor={attestId}
            className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink"
          >
            <input
              id={attestId}
              ref={attestRef}
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
              disabled={busy}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--c-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] focus-visible:ring-offset-2"
            />
            <span>I confirm this candidate is located in India.</span>
          </label>
          {error && (
            <p role="alert" className="mt-2 text-sm text-ink">
              {error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <CandidateButton
              variant="primary"
              onClick={() => void send()}
              loading={busy}
              disabled={!attested}
            >
              Create link
            </CandidateButton>
            <CandidateButton variant="secondary" onClick={closeConfirm} disabled={busy}>
              Cancel
            </CandidateButton>
          </div>
        </div>
      )}
    </div>
  );
}
