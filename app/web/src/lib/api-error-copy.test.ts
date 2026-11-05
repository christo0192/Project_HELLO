/**
 * Error copy on the phoneErrors.ts allowlist model. Two rules carry the weight:
 *
 *   1. The mapped set is an ALLOWLIST: an unmapped failure gets one generic
 *      sentence, and its raw text is never printed.
 *   2. The status outranks the body: a 429 is a pacing limit and a 403 a role
 *      fact, whatever code the body happens to carry.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { API_ERROR_COPY, GENERIC_ERROR_COPY, apiErrorCopy, plainErrorText } from './api-error-copy';

const SNAKE_CASE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;

describe('every mapped code', () => {
  const codes = Object.keys(API_ERROR_COPY);

  it('covers what the API answers on the list, summary and identity reads (non-vacuous)', () => {
    for (const code of [
      'service_unavailable',
      'internal_error',
      'Internal server error',
      'authorization_error',
      'Insufficient permissions',
      'authentication_error',
      'rate_limit_exceeded',
      'maintenance_mode',
      'validation_error',
    ]) {
      expect(codes).toContain(code);
    }
  });

  it.each(codes)('%s reads as plain words and never echoes itself', (code) => {
    // A 500, so no status rule stands in for the code's own copy.
    const message = apiErrorCopy(new ApiError(code, 500, code));
    expect(message).toBe(API_ERROR_COPY[code]);
    expect(message).not.toContain(code);
    expect(message).not.toMatch(SNAKE_CASE);
    // A full sentence, in sentence case.
    expect(message).toMatch(/^[A-Z].*\.$/);
  });

  it('says what to do about the 503 the list and summary answer', () => {
    const message = apiErrorCopy(new ApiError('service_unavailable', 503, 'service_unavailable'));
    expect(message).toMatch(/could not be read/i);
    expect(message).toMatch(/try again/i);
  });
});

describe('finding the code', () => {
  it('prefers the code to the message when the API sent both', () => {
    const copy = apiErrorCopy(new ApiError('Something a developer wrote', 500, 'internal_error'));
    expect(copy).toBe(API_ERROR_COPY.internal_error);
  });

  it('falls back to the message, which is where older call sites keep the code', () => {
    expect(apiErrorCopy(new ApiError('service_unavailable', 503))).toBe(
      API_ERROR_COPY.service_unavailable,
    );
  });

  it('reads any error shaped like the client error, not only its class', () => {
    expect(apiErrorCopy({ code: 'service_unavailable', status: 503, message: 'x' })).toBe(
      API_ERROR_COPY.service_unavailable,
    );
  });
});

describe('the mapped set is an allowlist', () => {
  it.each([
    'some_future_code',
    'sip_call_id=abc-123 room=phone-room-9',
    'PGRST116',
    '500 Internal Server Error',
    'candidate jane@example.com is locked',
  ])('never echoes %s', (raw) => {
    expect(apiErrorCopy(new ApiError(raw, 500, raw))).toBe(GENERIC_ERROR_COPY);
    expect(apiErrorCopy(new ApiError(raw, 500))).toBe(GENERIC_ERROR_COPY);
  });

  it('reads as a plain sentence that says what to do', () => {
    expect(GENERIC_ERROR_COPY).toMatch(/could not be loaded/i);
    expect(GENERIC_ERROR_COPY).toMatch(/try again/i);
    expect(GENERIC_ERROR_COPY).not.toMatch(SNAKE_CASE);
  });

  it('does not resolve an inherited Object property as copy', () => {
    // A bare index returns Object.prototype.toString for a code of `toString`:
    // a Function typed as a string, which React refuses to render.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(apiErrorCopy(new ApiError(key, 500, key))).toBe(GENERIC_ERROR_COPY);
      expect(plainErrorText(key)).toBe(GENERIC_ERROR_COPY);
    }
  });

  it('handles anything else thrown without throwing itself', () => {
    for (const thrown of [new Error('boom'), new TypeError('x is undefined'), null, undefined, 'boom', 7, {}]) {
      expect(apiErrorCopy(thrown)).toBe(GENERIC_ERROR_COPY);
    }
  });
});

describe('the status outranks the body', () => {
  it('reads a 429 as a pacing limit, never as an outage', () => {
    const message = apiErrorCopy(new ApiError('service_unavailable', 429, 'service_unavailable'));
    expect(message).toMatch(/too many requests/i);
    expect(message).toMatch(/try again/i);
    expect(message).not.toMatch(/outage|degraded|unavailable|down\b/i);
  });

  it('states a 403 as a role fact', () => {
    const message = apiErrorCopy(new ApiError('Insufficient permissions', 403, 'authorization_error'));
    expect(message).toMatch(/your role/i);
    expect(message).not.toContain('Insufficient permissions');
  });

  it('asks for a new sign-in on a 401', () => {
    expect(apiErrorCopy(new ApiError('Authentication required', 401, 'authentication_error'))).toMatch(
      /sign in again/i,
    );
  });

  it('describes a failed fetch as unreachable and never prints the API origin', () => {
    const message = apiErrorCopy(
      new ApiError('Could not reach the server. Is the API running on http://localhost:8787?', 0),
    );
    expect(message).toMatch(/could not be reached/i);
    expect(message).not.toContain('localhost');
  });
});

describe('plainErrorText: the ErrorPanel guard, which only ever has a string', () => {
  it.each([
    'Could not load candidates.',
    'Broken.',
    'Session not found',
    'Role not found',
    'sessions down',
    'R1 settings could not be loaded.',
  ])('passes a caller’s own sentence through: %s', (sentence) => {
    expect(plainErrorText(sentence)).toBe(sentence);
  });

  it('translates a mapped code', () => {
    expect(plainErrorText('service_unavailable')).toBe(API_ERROR_COPY.service_unavailable);
    expect(plainErrorText('Internal server error')).toBe(API_ERROR_COPY['Internal server error']);
  });

  it.each([
    'some_future_code',
    'SOME_FUTURE_CODE',
    'PGRST116',
    'boom',
    'scorecard_invalid:evidence_refs_too_many',
    'not_found: candidate c-1',
    'candidate_ownership_conflict for c-1',
    '500 Internal Server Error',
    'Failed for jane@example.com',
    'Could not fetch https://storage.example.com/a.mp3?sig=abc',
    '',
    '   ',
  ])('replaces machine text with the generic sentence: %j', (raw) => {
    expect(plainErrorText(raw)).toBe(GENERIC_ERROR_COPY);
  });

  it('strips the API origin from the client’s own transport message', () => {
    const message = plainErrorText('Could not reach the server. Is the API running on http://localhost:8787?');
    expect(message).toMatch(/could not be reached/i);
    expect(message).not.toContain('localhost');
  });

  it('leaves every sentence this module writes untouched, so a double pass is harmless', () => {
    for (const copy of [GENERIC_ERROR_COPY, ...Object.values(API_ERROR_COPY)]) {
      expect(plainErrorText(copy)).toBe(copy);
    }
  });
});
