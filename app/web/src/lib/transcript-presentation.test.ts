import { describe, expect, it } from 'vitest';
import { presentTranscriptTurn } from './transcript-presentation';

describe('presentTranscriptTurn', () => {
  it('presents reconstructed plan evidence separately from Christy speech', () => {
    expect(presentTranscriptTurn('bot', '[planned question] Ask about experience.')).toEqual({
      text: 'Ask about experience.',
      label: 'Interrupted question',
      plannedEvidence: true,
    });
    expect(presentTranscriptTurn('bot', '[interrupted question] Tell me about this role.')).toEqual({
      text: 'Tell me about this role.',
      label: 'Interrupted question',
      plannedEvidence: true,
    });
  });

  it('leaves ordinary bot and candidate dialogue unchanged', () => {
    expect(presentTranscriptTurn('bot', 'Hello')).toEqual({
      text: 'Hello', label: 'Bot', plannedEvidence: false,
    });
    expect(presentTranscriptTurn('candidate', '[planned question] literal candidate text')).toEqual({
      text: '[planned question] literal candidate text',
      label: 'Candidate',
      plannedEvidence: false,
    });
  });
});
