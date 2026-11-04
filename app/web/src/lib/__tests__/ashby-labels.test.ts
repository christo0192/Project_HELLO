import { describe, expect, it } from 'vitest';
import { ASHBY_ERROR_CODE_LABELS, ashbyErrorCodeLabel } from '../ashby-labels';

describe('ashbyErrorCodeLabel', () => {
  it('words a listed code exactly', () => {
    expect(ashbyErrorCodeLabel('ashby_tag_not_found')).toBe(ASHBY_ERROR_CODE_LABELS.ashby_tag_not_found);
    expect(ashbyErrorCodeLabel('provider_5xx')).toBe('Ashby server error');
  });

  it('words a code with a sanitized suffix by the part before the first colon', () => {
    expect(ashbyErrorCodeLabel('ashby_tag_write_rejected:tag_refused')).toBe('Ashby refused the tag change');
    expect(ashbyErrorCodeLabel('ashby_tag_write_rejected:a:b')).toBe('Ashby refused the tag change');
  });

  it('falls back to plain words when neither the code nor its prefix is listed', () => {
    expect(ashbyErrorCodeLabel('transient_x')).toBe('Transient x');
    expect(ashbyErrorCodeLabel(':leading')).toBe(':leading');
  });

  it('words the shared catch-all neutrally, as more than one lane records it', () => {
    expect(ashbyErrorCodeLabel('operation_error')).toBe('Unexpected error');
  });

  it.each(['ashby_tag_transient', 'ashby_tag_verdict_unreadable', 'ashby_tag_contended'])(
    '%s states the cause only: it is true while the operation waits and after its wait ran out',
    (code) => {
      const label = ashbyErrorCodeLabel(code);
      expect(label).not.toMatch(/\bretry\b|\bre-check\b|\bwill\b/i);
    },
  );

  it('pins the tag lane wording', () => {
    expect(ASHBY_ERROR_CODE_LABELS.ashby_tag_transient).toBe('Ashby was unavailable');
    expect(ASHBY_ERROR_CODE_LABELS.ashby_tag_verdict_unreadable).toBe('Christy verdict could not be read');
    expect(ASHBY_ERROR_CODE_LABELS.ashby_tag_contended).toBe('Christy tags changed during the update');
  });

  it('is empty for no code', () => {
    expect(ashbyErrorCodeLabel(null)).toBe('');
    expect(ashbyErrorCodeLabel(undefined)).toBe('');
    expect(ashbyErrorCodeLabel('')).toBe('');
  });
});
