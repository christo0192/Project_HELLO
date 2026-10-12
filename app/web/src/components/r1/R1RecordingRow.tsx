/**
 * R1RecordingRow: one attempt's recording on the R1 rounds panel (Overview tab), for every staff role.
 *
 * The row is a title ("Attempt 1 (counted)") over the player. It has no write controls, so it needs
 * no role branch: the API decides who may mint (admin and viewer any candidate, an interviewer only
 * their own) and the player shows the refusal in words.
 *
 * Staff-only, so it lives beside the panel and NOT in `components/candidate-r1/` (the candidate's
 * side, scanned by `pages/r1-structure.test.ts`). Renders inside `.candidate-scope` (`--c-*` tokens
 * only, no motion import).
 */
import { useId } from 'react';
import { R1RecordingPlayer } from './R1RecordingPlayer';
import type { R1AttemptSummary } from '../../lib/r1-types';

export interface R1RecordingRowProps {
  roundId: string;
  attempt: R1AttemptSummary;
  /** "Attempt 1 (counted)": names the group and the player's controls. */
  label: string;
  /** False pauses the media (the Overview tab is hidden but mounted). Default true. */
  active?: boolean;
  /** "Check again": the panel should re-read the rounds. */
  onNeedRefresh?: () => void;
}

export function R1RecordingRow({
  roundId,
  attempt,
  label,
  active = true,
  onNeedRefresh,
}: R1RecordingRowProps) {
  const headingId = `r1-recording-${useId().replace(/:/g, '')}`;
  return (
    <div role="group" aria-labelledby={headingId} className="glass-sunken mt-3 p-3">
      <h3 id={headingId} className="text-label font-medium text-ink">
        {label}
      </h3>
      <div className="mt-2">
        <R1RecordingPlayer
          roundId={roundId}
          sessionId={attempt.session_id}
          summary={attempt.recording}
          label={label}
          active={active}
          onNeedRefresh={onNeedRefresh}
        />
      </div>
    </div>
  );
}
