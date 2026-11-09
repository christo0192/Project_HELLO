/**
 * SessionLegRow — one call leg of a phone session on the Review tab (M013 S02).
 *
 * Says which call it was ("Call 2 of 2 · reconnect"), how it ended, when it
 * was connected and how much of it was recorded, with the truthful notes:
 * a dropped line whose end nobody observed, and a recording that may stop a
 * few seconds before the call did. Its player is the workspace
 * `RecordingPlayer` in leg mode: the signed URL is minted only on an explicit
 * click, through the attempt download route the call-attempt list uses.
 *
 * On one call with a working tape the block folds (Review congestion Stage 6), inside exactly the scope
 * Legal approved on 2026-11-09: the connected-time line, Load recording and "Recording processing; it may
 * not play yet." sit behind one press, word for word. The consent tag and every note about a dropped
 * call, an approximate end time, a missing end or missing audio stay in view, so closed the block reads
 * title, outcome, recorded length, then those. The player stays mounted, so the tape plays through it.
 * Only Load recording is behind the press: once a load is asked for, its progress, the player with Download
 * file and Refresh link, or the reason it failed are in view, open or closed. Anything more behind the press
 * needs Legal again.
 */

import { forwardRef, useId, useState } from 'react';
import type { CandidatePhoneAttempt } from '../../types';
import { Tag } from '../design/candidate';
import { cx } from '../design/cx';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle, RecordingPlayerStatus } from './RecordingPlayer';
import {
  LEG_TAIL_NOTE,
  legConnectedWords,
  legConsentTag,
  legName,
  legNoAudioLabel,
  legPlayable,
  legRecordedWords,
  legRecordingShown,
  legTitle,
  legUnobservedNote,
} from './sessionLegs';
import { attemptOutcomeLabel, attemptRawStatus } from './status';

export interface SessionLegRowProps {
  leg: CandidatePhoneAttempt;
  index: number;
  total: number;
  /** This call was reached through a real drop (`reconnectedLegs`). */
  reconnect?: boolean;
  sessionId: string;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayState?: (playing: boolean) => void;
  onEnded?: () => void;
  onStatus?: (status: RecordingPlayerStatus) => void;
  /** See `RecordingPlayerProps.tapeDriven`. */
  tapeDriven?: boolean;
  /**
   * The block may fold: the session's only call, with a working tape to play it from. The host decides,
   * because several calls or no tape keep the full block.
   */
  foldable?: boolean;
  /** The call sits before the clock, so its own player is the only way to play it: it opens by default. */
  beforeClock?: boolean;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      className={cx(
        'ml-1 inline-block shrink-0 align-[-2px] text-ink-tertiary transition-transform duration-150 ease-soft',
        open && 'rotate-180',
      )}
    >
      <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const SessionLegRow = forwardRef<RecordingPlayerHandle, SessionLegRowProps>(
  function SessionLegRow(
    { leg, index, total, reconnect = false, sessionId, onTimeUpdate, onPlayState, onEnded, onStatus, tapeDriven, foldable = false, beforeClock = false },
    ref,
  ) {
    const unobservedNote = legUnobservedNote(leg);
    // A deleted, withdrawn or blocked recording states no length and no tail
    // note, exactly as the Overview list (legRecordingShown).
    const recordingShown = legRecordingShown(leg);
    const recorded = recordingShown ? legRecordedWords(leg) : null;
    const playable = legPlayable(leg);
    // Only a leg that has audio carries a consent tag: it describes the file.
    const consentTag = leg.recording.state !== 'unavailable' ? legConsentTag(leg.consent_stage) : null;

    // Open by default when the call cannot play, or sits before the clock, where Load recording is the only
    // way to play it. A load that fails opens it too, so its reason and Try again are in view.
    const [open, setOpen] = useState(() => !playable || beforeClock);
    // What the player is doing. Legal's yes covers Load recording, not what it turns into: once a load is
    // asked for, from here or from the tape, its progress, the player with Download file and Refresh link,
    // or the reason it failed stay in view, whatever the arrow says.
    const [playerPhase, setPlayerPhase] = useState<RecordingPlayerStatus['phase']>('idle');
    const handleStatus = (status: RecordingPlayerStatus) => {
      setPlayerPhase(status.phase);
      if (status.message !== null) setOpen(true);
      onStatus?.(status);
    };
    const closed = foldable && !open;
    // Only an idle player, which is Load recording, folds with the connected-time line.
    const playerFolds = playable && playerPhase === 'idle';
    const connectedId = useId();
    const audioId = useId();

    const outcome = (
      <span
        className="text-[var(--c-ink-secondary)]"
        title={attemptRawStatus(leg.outcome_class, leg.state, leg.abandon_reason)}
      >
        {attemptOutcomeLabel(leg.outcome_class, leg.state, leg.abandon_reason)}
      </span>
    );

    return (
      <li className="py-3 first:pt-0 last:pb-0" data-leg-row="">
        <p className="text-sm text-[var(--c-ink)]">
          {foldable ? (
            // The arrow is the whole first line, so its name is the words on it. The separators are read,
            // because a name runs inline spans together.
            <button
              type="button"
              onClick={() => setOpen((was) => !was)}
              aria-expanded={!closed}
              aria-controls={playerFolds ? `${connectedId} ${audioId}` : connectedId}
              className="text-left"
            >
              <span className="font-medium">{legTitle(index, total, reconnect)}</span>
              <span className="text-[var(--c-ink-secondary)]"> · </span>
              {outcome}
              {/* Closed, the length the connected-time line prints comes up here, in its own words. Open, it
                  is printed on that line, and stays in the arrow's name only, so the name never changes. */}
              {recorded && <span className={cx('text-[var(--c-ink-secondary)]', !closed && 'sr-only')}> · {recorded}</span>}
              <Chevron open={!closed} />
            </button>
          ) : (
            <>
              <span className="font-medium">{legTitle(index, total, reconnect)}</span>
              <span aria-hidden="true" className="text-[var(--c-ink-secondary)]"> · </span>
              {outcome}
            </>
          )}
        </p>
        <p id={connectedId} hidden={closed} className="text-xs tabular-nums text-[var(--c-ink-secondary)]">
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
        {recordingShown && leg.tail_may_be_missing && (
          <p className="mt-1 text-xs text-[var(--c-ink-secondary)]" data-leg-note="tail">
            {LEG_TAIL_NOTE}
          </p>
        )}
        {/* Closed, Load recording is hidden and still mounted, so the tape plays through it, and what it
            loads comes into view. A call with no audio has its reason here instead, and that stays in view. */}
        <div id={audioId} hidden={closed && playerFolds} className="mt-2">
          {playable ? (
            <RecordingPlayer
              ref={ref}
              sessionId={sessionId}
              attemptId={leg.id}
              label={legName(index, total)}
              onTimeUpdate={onTimeUpdate}
              onPlayState={onPlayState}
              onEnded={onEnded}
              onStatus={handleStatus}
              tapeDriven={tapeDriven}
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
