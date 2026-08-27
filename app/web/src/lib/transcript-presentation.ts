const PLANNED_QUESTION_PREFIX = '[planned question] ';
const INTERRUPTED_QUESTION_PREFIX = '[interrupted question] ';

export interface TranscriptPresentation {
  text: string;
  label: 'Bot' | 'Candidate' | 'Interrupted question';
  plannedEvidence: boolean;
}

/**
 * Interrupted assistant speech is reconstructed from the immutable plan, not
 * claimed as words Christy actually spoke. Present that evidence explicitly
 * instead of rendering the internal storage marker as ordinary bot dialogue.
 */
export function presentTranscriptTurn(
  speaker: 'bot' | 'candidate',
  text: string,
): TranscriptPresentation {
  const plannedEvidence = speaker === 'bot'
    && (text.startsWith(PLANNED_QUESTION_PREFIX) || text.startsWith(INTERRUPTED_QUESTION_PREFIX));
  if (plannedEvidence) {
    const prefix = text.startsWith(INTERRUPTED_QUESTION_PREFIX)
      ? INTERRUPTED_QUESTION_PREFIX
      : PLANNED_QUESTION_PREFIX;
    return {
      text: text.slice(prefix.length),
      label: 'Interrupted question',
      plannedEvidence: true,
    };
  }
  return {
    text,
    label: speaker === 'bot' ? 'Bot' : 'Candidate',
    plannedEvidence: false,
  };
}
