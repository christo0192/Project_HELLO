/**
 * ReviewTape: the call strip with its transport, above the two panes of the phone Review screen.
 *
 * "Play from" names the cued moment, and only a moment it can play: a cue with no audio reads "Play", and
 * so does one on a call before t = 0, which has no place on the strip to name and leaves the tape at its
 * start. Nothing plays until it or a moment is pressed: the recording's link is minted on that press and never
 * on load. The playhead and the clock live here, behind a handle, so a report from the audio four times
 * a second repaints this strip and not the transcript.
 *
 * The players sit in the transcript pane, which Review opens scrolled to the cued row, so this row is
 * the only place sure to be on screen after a press. It therefore says what the recording is doing:
 * loading, failed with Try again, or ready with Refresh link. For the same reason a call's consent tag
 * stands here too, word for word, beside the control that plays that call.
 */

import { forwardRef, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { ReviewCallStrip, ReviewCallStripLegend } from '../recording/ReviewCallStrip';
import type { ReviewCallStripProps } from '../recording/ReviewCallStrip';
import { timecode } from '../recording/callStripGeometry';
import { CandidateButton } from '../design/candidate';
import { plainErrorText } from '../../lib/api-error-copy';
import type { RecordingPlayerStatus } from './RecordingPlayer';

export interface ReviewTapeHandle {
  /** Move the playhead and the clock. No animation: a cue is instant. */
  setPosition: (sec: number, playable: boolean, consentTag: string | null) => void;
}

export interface ReviewTapeProps extends Omit<ReviewCallStripProps, 'positionSec'> {
  /** Where the tape stands when it first draws. */
  startSec: number;
  /** Whether "Play from" can name that moment: it has audio, and a place on the strip. */
  startPlayable: boolean;
  /** The consent tag of the call it stands on. */
  startConsentTag: string | null;
  /** A recording can be asked for. */
  canPlay: boolean;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  candidateName: string;
  candidateTalk: string | null;
  aiName: string;
  aiTalk: string | null;
  /** Said beside the clock: how the recording loads, or why there is none. */
  note: ReactNode;
  /** The recording the tape last asked for. */
  recording: RecordingPlayerStatus;
  onRetry: () => void;
  onRefresh: () => void;
}

const LOADING_RECORDING = 'Loading recording…';

export const ReviewTape = forwardRef<ReviewTapeHandle, ReviewTapeProps>(function ReviewTape(
  {
    startSec,
    startPlayable,
    startConsentTag,
    canPlay,
    playing,
    onPlay,
    onPause,
    candidateName,
    candidateTalk,
    aiName,
    aiTalk,
    note,
    recording,
    onRetry,
    onRefresh,
    ...strip
  },
  ref,
) {
  const [position, setPosition] = useState({ sec: startSec, playable: startPlayable, consentTag: startConsentTag });
  useImperativeHandle(
    ref,
    () => ({ setPosition: (sec, playable, consentTag) => setPosition({ sec, playable, consentTag }) }),
    [],
  );
  const at = timecode(position.sec);
  const failed = recording.phase === 'error' || (recording.phase === 'ready' && recording.message !== null);

  return (
    <section aria-label="Call recording and strip" className="border-b border-rule-2 px-6 pb-1 pt-1.5">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {canPlay && (
          <CandidateButton variant="secondary" size="sm" onClick={playing ? onPause : onPlay}>
            {playing ? (
              'Pause'
            ) : position.playable ? (
              <>
                Play from <span className="font-mono">{at}</span>
              </>
            ) : (
              'Play'
            )}
          </CandidateButton>
        )}
        <span data-tape-clock="" className="whitespace-nowrap font-mono text-label text-ink">
          {at}
          <span className="text-ink-tertiary"> / {timecode(strip.endSec)}</span>
        </span>
        {/* One status line. A failure is an alert, and the loading word replaces the note beside it. */}
        <div data-tape-status={recording.phase} className="flex min-w-40 flex-1 basis-0 flex-wrap items-baseline gap-x-2.5">
          {position.consentTag && (
            <p data-tape-consent="" className="text-meta font-medium text-ink">
              {position.consentTag}
            </p>
          )}
          {recording.phase === 'loading' ? (
            <p role="status" className="text-meta text-ink-secondary">
              {LOADING_RECORDING}
            </p>
          ) : failed ? (
            <p role="alert" className="text-meta text-ink">
              {plainErrorText(recording.message ?? '')}
            </p>
          ) : (
            <p className="text-meta text-ink-tertiary">{note}</p>
          )}
          {recording.phase === 'error' && (
            <button type="button" onClick={onRetry} className="textlink text-meta font-medium text-ink">
              Try again
            </button>
          )}
          {recording.phase === 'ready' && (
            <button type="button" onClick={onRefresh} className="textlink text-meta font-medium text-ink">
              Refresh link
            </button>
          )}
        </div>
        <ReviewCallStripLegend
          className="ml-auto"
          candidateName={candidateName}
          candidateTalk={candidateTalk}
          aiName={aiName}
          aiTalk={aiTalk}
        />
      </div>
      <ReviewCallStrip {...strip} positionSec={position.sec} className="mt-1.5" />
    </section>
  );
});
