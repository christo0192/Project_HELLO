/**
 * return-to allowlist — open-redirect posture.
 *
 * The allowlist is EXACT: only `/ashby/review/<uuid>`. Everything else — other
 * app paths, prefix look-alikes, absolute URLs, protocol-relative hosts,
 * anything carrying a query or fragment — fails closed to null.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeReturnTo,
  ashbyReviewPath,
  rememberReturnTo,
  consumeReturnTo,
  clearReturnTo,
  resetReturnToReplay,
} from './return-to';

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

/**
 * Parking a return-to across the SSO full-page redirect.
 *
 * `sanitizeReturnTo` remains the SOLE trust boundary: it runs on the write AND
 * on the read, so sessionStorage is storage, not authority. The entry is
 * single-use and expires, so it can never silently re-route a later visit.
 */
describe('rememberReturnTo / consumeReturnTo', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    resetReturnToReplay();
    window.sessionStorage.clear();
  });

  it('round-trips exactly the allowlisted path', () => {
    rememberReturnTo(`/ashby/review/${UUID}`, NOW);
    expect(consumeReturnTo(NOW + 1000)).toBe(`/ashby/review/${UUID}`);
  });

  it('is single-use — a second consume returns null', () => {
    rememberReturnTo(`/ashby/review/${UUID}`, NOW);
    expect(consumeReturnTo(NOW)).toBe(`/ashby/review/${UUID}`);
    resetReturnToReplay(); // past the StrictMode double-mount replay window
    expect(consumeReturnTo(NOW + 1)).toBeNull();
  });

  it('replays a successful consume briefly (StrictMode double mount), then stops', () => {
    rememberReturnTo(`/ashby/review/${UUID}`, NOW);
    expect(consumeReturnTo(NOW)).toBe(`/ashby/review/${UUID}`);
    expect(consumeReturnTo(NOW)).toBe(`/ashby/review/${UUID}`);
    expect(consumeReturnTo(NOW + 60_000)).toBeNull();
  });

  it('expires a stale entry rather than re-routing a later visit', () => {
    rememberReturnTo(`/ashby/review/${UUID}`, NOW);
    expect(consumeReturnTo(NOW + 11 * 60 * 1000)).toBeNull();
  });

  it.each([
    'https://evil.example/ashby/review/' + UUID,
    '//evil.example/',
    '/mission-control',
    `/ashby/review/${UUID}?next=https://evil.example`,
    'javascript:alert(1)',
  ])('never parks a non-allowlisted value (%s)', (value) => {
    rememberReturnTo(value, NOW);
    expect(window.sessionStorage.getItem('ashby.returnTo')).toBeNull();
    expect(consumeReturnTo(NOW)).toBeNull();
  });

  it('re-validates on READ, so a tampered storage entry is refused', () => {
    for (const hostile of [
      JSON.stringify({ p: 'https://evil.example/', t: NOW }),
      JSON.stringify({ p: '/mission-control', t: NOW }),
      JSON.stringify({ p: `/ashby/review/${UUID}` }), // no timestamp
      'not json',
    ]) {
      resetReturnToReplay();
      window.sessionStorage.setItem('ashby.returnTo', hostile);
      expect(consumeReturnTo(NOW)).toBeNull();
      // Refused entries are still cleared — they never accumulate.
      expect(window.sessionStorage.getItem('ashby.returnTo')).toBeNull();
    }
  });

  it('clears any parked value when the new return-to is absent', () => {
    rememberReturnTo(`/ashby/review/${UUID}`, NOW);
    rememberReturnTo(null, NOW);
    expect(consumeReturnTo(NOW)).toBeNull();
  });

  it('degrades quietly when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('storage disabled'); },
    });
    try {
      expect(() => rememberReturnTo(`/ashby/review/${UUID}`, NOW)).not.toThrow();
      expect(consumeReturnTo(NOW)).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});

/**
 * The destination page is the OTHER consume point.
 *
 * On the provider-honoured redirect path the browser lands directly on the deep
 * link and `PostAuthLanding` never runs, so without an explicit clear the parked
 * entry survived its full TTL and re-routed the next visit to `/`.
 */
describe('clearReturnTo — arrival kills the parked entry', () => {
  const UUID_ = '11111111-1111-4111-8111-111111111111';
  const NOW_ = 1_700_000_000_000;

  beforeEach(() => {
    resetReturnToReplay();
    window.sessionStorage.clear();
  });

  it('makes a later landing-route visit fall back instead of replaying', () => {
    rememberReturnTo(`/ashby/review/${UUID_}`, NOW_);
    clearReturnTo();
    expect(window.sessionStorage.getItem('ashby.returnTo')).toBeNull();
    // Well inside both the 10-minute TTL and the 5-second replay window.
    expect(consumeReturnTo(NOW_ + 1000)).toBeNull();
  });

  it('drops the StrictMode replay memo too, so a consumed value cannot replay', () => {
    rememberReturnTo(`/ashby/review/${UUID_}`, NOW_);
    expect(consumeReturnTo(NOW_)).toBe(`/ashby/review/${UUID_}`);
    // Without a clear this would replay for CONSUME_REPLAY_MS.
    expect(consumeReturnTo(NOW_ + 100)).toBe(`/ashby/review/${UUID_}`);
    clearReturnTo();
    expect(consumeReturnTo(NOW_ + 200)).toBeNull();
  });

  it('is idempotent and a no-op when nothing is parked', () => {
    expect(() => { clearReturnTo(); clearReturnTo(); }).not.toThrow();
    expect(consumeReturnTo(NOW_)).toBeNull();
  });

  it('degrades quietly when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('storage disabled'); },
    });
    try {
      expect(() => clearReturnTo()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
