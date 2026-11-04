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
    expect(ashbyErrorCodeLabel('operation_error')).toBe('Operation error');
    expect(ashbyErrorCodeLabel(':leading')).toBe(':leading');
  });

  it('is empty for no code', () => {
    expect(ashbyErrorCodeLabel(null)).toBe('');
    expect(ashbyErrorCodeLabel(undefined)).toBe('');
    expect(ashbyErrorCodeLabel('')).toBe('');
  });
});
