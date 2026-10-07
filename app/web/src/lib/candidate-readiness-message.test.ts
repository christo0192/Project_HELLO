import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { messageFor } from './candidate-readiness-message';
import { RETIRED_LINK_CANDIDATE_MESSAGE } from './browser-screening-retired';

describe('audio readiness error copy', () => {
  it('tells a candidate holding a retired link that it is no longer active, not to retry', () => {
    const text = messageFor(new ApiError('browser_screening_retired', 410));
    expect(text).toBe(RETIRED_LINK_CANDIDATE_MESSAGE);
    expect(text).not.toMatch(/retry|try again/i);
    expect(text).not.toContain('browser_screening_retired');
  });

  it('leaves the existing copy unchanged for other failures', () => {
    expect(messageFor(new ApiError('consent_required', 409))).toBe(
      'Your consent is no longer valid. Please return and review it again.',
    );
    expect(messageFor(new ApiError('screening_room_unavailable', 503))).toMatch(/still valid/);
    expect(messageFor(new Error('boom'))).toMatch(/minimum requirements/);
  });
});
