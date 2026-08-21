/**
 * return-to allowlist — open-redirect posture.
 *
 * The allowlist is EXACT: only `/ashby/review/<uuid>`. Everything else — other
 * app paths, prefix look-alikes, absolute URLs, protocol-relative hosts,
 * anything carrying a query or fragment — fails closed to null.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeReturnTo, ashbyReviewPath } from './return-to';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('sanitizeReturnTo', () => {
  it('accepts exactly the scoped review path', () => {
    expect(sanitizeReturnTo(`/ashby/review/${UUID}`)).toBe(`/ashby/review/${UUID}`);
    expect(sanitizeReturnTo(ashbyReviewPath(UUID))).toBe(`/ashby/review/${UUID}`);
  });

  it.each([
    'https://evil.example/ashby/review/' + UUID,
    '//evil.example/ashby/review/' + UUID,
    'http://localhost:5173/ashby/review/' + UUID,
    `/ashby/review/${UUID}?next=https://evil.example`,
    `/ashby/review/${UUID}#token`,
    `/ashby/review/${UUID}/extra`,
    `/ashby/review/${UUID}@evil.example`,
    '/ashby/review/not-a-uuid',
    '/ashby/review/',
    '/candidates',
    '/mission-control',
    '\\\\evil.example',
    'javascript:alert(1)',
    '',
  ])('rejects %s', (value) => {
    expect(sanitizeReturnTo(value)).toBeNull();
  });

  it('rejects non-string values', () => {
    for (const v of [null, undefined, 42, {}, [`/ashby/review/${UUID}`]]) {
      expect(sanitizeReturnTo(v)).toBeNull();
    }
  });
});
