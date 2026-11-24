/**
 * ViaMeetTag: says an R1 round is held over Google Meet, on the queue, the candidate's R1 tab and the
 * review.
 *
 * It names a fact, not a state, so it is a neutral chip (design/tones): the words carry it, and its
 * `srPrefix` makes a screen reader hear "Interview: Via Meet" on its own. Only a round whose `channel`
 * is exactly `'meet'` gets one (`isMeetRound`); a browser round, a null or unknown channel, and every
 * round from an API that does not send the field render nothing, so those rows stay as they were.
 *
 * Renders inside `.candidate-scope` (`--c-*` tokens only, through `Tag`).
 */
import { Tag } from '../design/candidate';
import { isMeetRound } from '../../lib/r1';

export interface ViaMeetTagProps {
  /** The round's `channel`, as the API sent it (absent from every staff read today). */
  channel?: string | null;
  className?: string;
}

export function ViaMeetTag({ channel, className }: ViaMeetTagProps) {
  if (!isMeetRound({ channel })) return null;
  return (
    <Tag srPrefix="Interview:" className={className}>
      Via Meet
    </Tag>
  );
}
