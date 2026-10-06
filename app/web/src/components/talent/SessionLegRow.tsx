/**
 * SessionLegRow — one call leg of a phone session on the Review tab (M013 S02).
 *
 * Says which call it was ("Call 2 of 2 · reconnect"), how it ended, when it
 * was connected and how much of it was recorded, with the truthful notes:
 * a dropped line whose end nobody observed, and a recording that may stop a
 * few seconds before the call did. Its player is the workspace
 * `RecordingPlayer` in leg mode: the signed URL is minted only on an explicit
 * click, through the attempt download route the call-attempt list uses.
 */

import { forwardRef } from 'react';
import type { CandidatePhoneAttempt } from '../../types';
import { formatIstTime, formatIstTimeRange } from '../../lib/ist-datetime';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle } from './RecordingPlayer';
import { legNoAudioLabel, legName, legPlayable, legTitle } from './sessionLegs';
import { attemptOutcomeLabel, attemptRawStatus, formatDurationSec } from './status';

export interface SessionLegRowProps {
  leg: CandidatePhoneAttempt;
  index: number;
  total: number;
  sessionId: string;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayState?: (playing: boolean) => void;
}

/** "Connected 09:00–09:02 IST (1m 15s)", "Connected from 09:04 IST", or "Not answered". */
function connectedWords(leg: CandidatePhoneAttempt): string {
  const from = leg.connected_from ?? leg.answered_at;
  if (!from) return 'Not answered';
  const to = leg.connected_to;
  if (!to || leg.connected_to_source === 'unobserved') return `Connected from ${formatIstTime(from)}`;
  const length = leg.connected_sec != null ? ` (${formatDurationSec(leg.connected_sec)})` : '';
  return `Connected ${formatIstTimeRange(from, to)}${length}`;
}

function recordedWords(leg: CandidatePhoneAttempt): string | null {
  if (leg.recorded_sec == null || !Number.isFinite(leg.recorded_sec)) return null;
  return leg.recorded_sec_estimated
    ? `Recorded ≈${formatDurationSec(leg.recorded_sec)} (estimated)`
    : `Recorded ${formatDurationSec(leg.recorded_sec)}`;
}

export const SessionLegRow = forwardRef<RecordingPlayerHandle, SessionLegRowProps>(
  function SessionLegRow({ leg, index, total, sessionId, onTimeUpdate, onPlayState }, ref) {
    const unobserved = leg.connected_to_source === 'unobserved';
    const recorded = recordedWords(leg);
    const playable = legPlayable(leg);
    return (
      <li className="py-3 first:pt-0 last:pb-0" data-leg-row="">
        <p className="text-sm text-[var(--c-ink)]">
          <span className="font-medium">{legTitle(index, total)}</span>
          <span aria-hidden="true" className="text-[var(--c-ink-secondary)]"> · </span>
          <span
            className="text-[var(--c-ink-secondary)]"
            title={attemptRawStatus(leg.outcome_class, leg.state, leg.abandon_reason)}
          >
            {attemptOutcomeLabel(leg.outcome_class, leg.state, leg.abandon_reason)}
          </span>
        </p>
        <p className="text-xs tabular-nums text-[var(--c-ink-secondary)]">
          {[connectedWords(leg), recorded].filter(Boolean).join(' · ')}
        </p>
        {/* Notes are words, never colour alone. */}
        {unobserved && (
          <p className="mt-1 text-xs text-[var(--c-ink-secondary)]" data-leg-note="unobserved">
            {leg.connected_to
              ? `Line dropped; end not observed (detected ${formatIstTime(leg.connected_to)} by timeout).`
              : 'Line dropped; end not observed.'}
          </p>
        )}
        {leg.tail_may_be_missing && (
          <p className="mt-1 text-xs text-[var(--c-ink-secondary)]" data-leg-note="tail">
            This recording may end a few seconds before the call did.
          </p>
        )}
        <div className="mt-2">
          {playable ? (
            <RecordingPlayer
              ref={ref}
              sessionId={sessionId}
              attemptId={leg.id}
              label={legName(index, total)}
              onTimeUpdate={onTimeUpdate}
              onPlayState={onPlayState}
            />
          ) : (
            <p className="text-xs text-[var(--c-ink-secondary)]">{legNoAudioLabel(leg.recording.reason)}</p>
          )}
          {leg.recording.state === 'processing' && (
            <p className="mt-1 text-xs text-[var(--c-ink-secondary)]">Recording processing; it may not play yet.</p>
          )}
        </div>
      </li>
    );
  },
);
