/**
 * The AI interviewer on the record. A name and an explicit AI marker: "Bot" read
 * like a chat log, and a bare first name would read as a person speaking.
 */
export const AI_SPEAKER_LABEL = 'Christy (AI)';

const PLANNED_QUESTION_PREFIX = '[planned question] ';
const INTERRUPTED_QUESTION_PREFIX = '[interrupted question] ';

export interface TranscriptPresentation {
  text: string;
  label: typeof AI_SPEAKER_LABEL | 'Candidate' | 'Interrupted question';
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
    label: speaker === 'bot' ? AI_SPEAKER_LABEL : 'Candidate',
    plannedEvidence: false,
  };
}
