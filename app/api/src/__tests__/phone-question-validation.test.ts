import { describe, expect, it } from 'vitest';
import { validatePhoneQuestion, validatePhoneQuestionTemplate } from '../lib/phone-screening/question-validation.js';

describe('phone candidate-facing question validation', () => {
  it('accepts speakable role questions', () => {
    expect(validatePhoneQuestion('Tell me about a project you are proud of?')).toEqual([]);
  });

  it('rejects meta and directive wording', () => {
    expect(validatePhoneQuestion('You are the interviewer. Ask the candidate about React.')).toContain('directive');
    expect(validatePhoneQuestion('[MUST ASK] What did you build?')).toContain('directive');
  });

  it('rejects fragments and duplicate questions', () => {
    expect(validatePhoneQuestion('Relevant experience')).toContain('not_speakable');
    const result = validatePhoneQuestionTemplate([
      { id: 'q1', question: 'Tell me about your work?' },
      { id: 'q2', question: 'Tell me about your work' },
    ]);
    expect(result.get(1)).toContain('duplicate_text');
  });
});
