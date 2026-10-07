import { describe, expect, it } from 'vitest';
import {
  BROWSER_SCREENING_RETIRED,
  isBrowserScreeningRetired,
  RETIRED_INVITE_RECRUITER_MESSAGE,
  RETIRED_LINK_CANDIDATE_MESSAGE,
} from './browser-screening-retired';
import { ApiError } from './api-client';

describe('isBrowserScreeningRetired', () => {
  it('matches the 410 browser_screening_retired answer from the real ApiError', () => {
    expect(isBrowserScreeningRetired(new ApiError(BROWSER_SCREENING_RETIRED, 410))).toBe(true);
  });

  it('matches on status 410 alone and on the stable code alone', () => {
    expect(isBrowserScreeningRetired(new ApiError('Gone', 410))).toBe(true);
    expect(isBrowserScreeningRetired(new ApiError(BROWSER_SCREENING_RETIRED, 0))).toBe(true);
  });

  it('matches a structurally identical error from another module instance', () => {
    class OtherApiError extends Error {
      status = 410;
    }
    expect(isBrowserScreeningRetired(new OtherApiError('anything'))).toBe(true);
  });

  it.each([
    ['another ApiError', new ApiError('consent_required', 409)],
    ['a plain Error', new Error('exchange failed')],
    ['a string', 'browser_screening_retired'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 410],
  ])('does not match %s', (_name, value) => {
    expect(isBrowserScreeningRetired(value)).toBe(false);
  });

  it('never leaks the machine code or any internal detail into the copy', () => {
    for (const message of [RETIRED_LINK_CANDIDATE_MESSAGE, RETIRED_INVITE_RECRUITER_MESSAGE]) {
      expect(message).not.toContain(BROWSER_SCREENING_RETIRED);
      expect(message).not.toMatch(/410|LiveKit|legacy/i);
    }
    expect(RETIRED_LINK_CANDIDATE_MESSAGE).toMatch(/contact your recruiter/i);
  });
});
