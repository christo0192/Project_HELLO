/**
 * 0114 (C5): `expire_phone_appointments` now records WHY a slot was missed in
 * `cancel_reason` — `engagement_cancelled` (the engagement went terminal),
 * `emergency_stop` (the lane was halted when, or after, the slot began) or
 * `system_deferral_expired` (an ordinary miss). A `missed` row carrying any of
 * them must render operator English, never a bare snake_case code.
 */
import { describe, it, expect } from 'vitest';
import { cancelReasonLabel } from '../phoneVocabulary';

describe('expiry cause labels', () => {
  it.each([
    ['engagement_cancelled', 'Engagement cancelled'],
    ['emergency_stop', 'Emergency stop'],
    ['system_deferral_expired', 'A system deferral expired'],
  ])('%s renders as operator English', (reason, label) => {
    expect(cancelReasonLabel(reason)).toBe(label);
    expect(cancelReasonLabel(reason)).not.toContain('_');
  });
});
