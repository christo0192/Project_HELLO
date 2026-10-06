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
import { Tag } from '../design/candidate';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle } from './RecordingPlayer';
import {
  LEG_TAIL_NOTE,
  legConnectedWords,
  legConsentTag,
  legName,
  legNoAudioLabel,
  legPlayable,
  legRecordedWords,
  legTitle,
  legUnobservedNote,
} from './sessionLegs';
import { attemptOutcomeLabel, attemptRawStatus } from './status';

export interface SessionLegRowProps {
  leg: CandidatePhoneAttempt;
  index: number;
  total: number;
  sessionId: string;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayState?: (playing: boolean) => void;
}

export const SessionLegRow = forwardRef<RecordingPlayerHandle, SessionLegRowProps>(
  function SessionLegRow({ leg, index, total, sessionId, onTimeUpdate, onPlayState }, ref) {
    const unobservedNote = legUnobservedNote(leg);
    const recorded = legRecordedWords(leg);
    const playable = legPlayable(leg);
    // Only a leg that has audio carries a consent tag: it describes the file.
    const consentTag = leg.recording.state !== 'unavailable' ? legConsentTag(leg.consent_stage) : null;
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
          {[legConnectedWords(leg), recorded].filter(Boolean).join(' · ')}
        </p>
        {consentTag && (
          <p className="mt-1" data-leg-consent={leg.consent_stage ?? ''}>
            <Tag tone="caution">{consentTag.label}</Tag>
          </p>
        )}
        {/* Notes are words, never colour alone. */}
        {unobservedNote && (
          <p className="mt-1 text-xs text-[var(--c-ink-secondary)]" data-leg-note="unobserved">
            {unobservedNote}
          </p>
        )}
        {leg.tail_may_be_missing && (
          <p className="mt-1 text-xs text-[var(--c-ink-secondary)]" data-leg-note="tail">
            {LEG_TAIL_NOTE}
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
