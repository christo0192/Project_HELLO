import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_APPLICATION,
  DUPLICATE_HOLD_NOTICE,
  duplicateHoldErrorMessage,
  isDuplicateApplicationHold,
} from './duplicate-hold';

describe('isDuplicateApplicationHold (0114, C8)', () => {
  const held = { state: 'pending_prereqs', state_reason: 'duplicate_application', terminal_at: null };

  it('is true only for a live pending_prereqs cycle held as duplicate_application', () => {
    expect(isDuplicateApplicationHold(held)).toBe(true);
    expect(isDuplicateApplicationHold({ ...held, state_reason: 'consent_missing' })).toBe(false);
    expect(isDuplicateApplicationHold({ ...held, state_reason: null })).toBe(false);
    expect(isDuplicateApplicationHold({ ...held, state: 'eligible' })).toBe(false);
    expect(isDuplicateApplicationHold({ ...held, terminal_at: '2026-10-03T00:00:00Z' })).toBe(false);
    expect(isDuplicateApplicationHold(null)).toBe(false);
    expect(isDuplicateApplicationHold(undefined)).toBe(false);
  });

  it('the code is the API literal', () => {
    expect(DUPLICATE_APPLICATION).toBe('duplicate_application');
  });
});

describe('duplicateHoldErrorMessage', () => {
  it.each([
    'duplicate_application',
    'phone_hold_not_held',
    'phone_hold_ambiguous',
    'phone_hold_not_found',
    'phone_release_unavailable',
    'actor_required',
  ])('%s has specific recruiter copy that is not the raw code', (code) => {
    const message = duplicateHoldErrorMessage(code);
    expect(message).toBeTruthy();
    expect(message).not.toBe(code);
    expect(message).not.toMatch(/_/);
  });

  it('returns null for any other code so the caller keeps its own message', () => {
    expect(duplicateHoldErrorMessage('window_closed')).toBeNull();
    expect(duplicateHoldErrorMessage('')).toBeNull();
  });

  it('the copy never names another record, number or email', () => {
    const all = [DUPLICATE_HOLD_NOTICE, duplicateHoldErrorMessage('duplicate_application') ?? ''].join(' ');
    expect(all).not.toMatch(/@|\+91|\d{6,}/);
  });
});
