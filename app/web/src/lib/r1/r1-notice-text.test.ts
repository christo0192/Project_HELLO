import { describe, expect, it } from 'vitest';
import { consentLabel, parseNoticeBlocks, R1_CONSENT_FALLBACK_LABELS } from './r1-notice-text';

describe('parseNoticeBlocks', () => {
  it('splits headings, paragraphs and bullet lists', () => {
    const blocks = parseNoticeBlocks(
      [
        '# What we collect',
        '',
        'Camera video, voice, transcript',
        'and scores.',
        '',
        '- Sarvam AI (speech)',
        '- LiveKit Cloud (media relay)',
        '',
        '## Your choices',
        'You can withdraw at any time.',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'heading', text: 'What we collect' },
      { kind: 'paragraph', text: 'Camera video, voice, transcript and scores.' },
      { kind: 'list', items: ['Sarvam AI (speech)', 'LiveKit Cloud (media relay)'] },
      { kind: 'heading', text: 'Your choices' },
      { kind: 'paragraph', text: 'You can withdraw at any time.' },
    ]);
  });

  it('handles Windows line endings and numbered lists', () => {
    const blocks = parseNoticeBlocks('1. First\r\n2) Second\r\n\r\nDone');
    expect(blocks).toEqual([
      { kind: 'list', items: ['First', 'Second'] },
      { kind: 'paragraph', text: 'Done' },
    ]);
  });

  it('strips inline markers and HTML but keeps a link readable', () => {
    const [block] = parseNoticeBlocks(
      'Read **this** and `that`, <script>alert(1)</script> or [withdraw](https://example.test/w).',
    );
    expect(block).toEqual({
      kind: 'paragraph',
      text: 'Read this and that, alert(1) or withdraw (https://example.test/w).',
    });
  });

  it('never emits markup: every block is plain strings', () => {
    const blocks = parseNoticeBlocks('![x](http://e.test/a.png)\n\n<img src=x onerror=alert(1)>');
    const text = JSON.stringify(blocks);
    expect(text).not.toContain('<');
    expect(text).not.toContain('onerror');
  });

  it('returns nothing for empty input', () => {
    expect(parseNoticeBlocks('')).toEqual([]);
    expect(parseNoticeBlocks('\n\n  \n')).toEqual([]);
  });
});

describe('consentLabel', () => {
  it('prefers the template label', () => {
    expect(consentLabel('recording', 'Agree to recording')).toBe('Agree to recording');
  });

  it('falls back to the plan wording for the three named purposes', () => {
    expect(Object.keys(R1_CONSENT_FALLBACK_LABELS)).toEqual([
      'ai_interview',
      'recording',
      'ai_evaluation',
    ]);
    expect(consentLabel('ai_evaluation', undefined)).toMatch(/contest/);
    expect(consentLabel('recording', undefined)).toMatch(/video and audio/);
  });

  it('humanises an unknown purpose rather than showing nothing', () => {
    expect(consentLabel('exam_proctoring', undefined)).toBe('I agree to exam proctoring.');
  });
});
