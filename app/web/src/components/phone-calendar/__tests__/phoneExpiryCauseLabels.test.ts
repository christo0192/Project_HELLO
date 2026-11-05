/**
 * 0114 (C5): `expire_phone_appointments` now records WHY a slot was missed in
 * `cancel_reason` — `engagement_cancelled` (the engagement went terminal),
 * `emergency_stop` (the lane was halted when, or after, the slot began) or
 * `system_deferral_expired` (an ordinary miss). A `missed` row carrying any of
 * them must render operator English, never a bare snake_case code.
 */
import { describe, it, expect } from 'vitest';
import { cancelReasonLabel, missedAppointmentNote } from '../phoneVocabulary';

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

/**
 * The sweep returns a `scheduled` engagement to `eligible`, due at once, and the
 * dial loop picks it up with no booking. A terminal engagement is left alone.
 */
describe('what follows a missed slot', () => {
  it.each(['eligible', 'awaiting_retry'])('%s: it is called again, with no booking needed', (state) => {
    const note = missedAppointmentNote(state);
    expect(note).toMatch(/^This slot passed without a call\./);
    expect(note).toMatch(/back in the calling queue and will be called again without a booking/);
    expect(note).not.toMatch(/nothing will dial/i);
  });

  it('promises no time for that call', () => {
    expect(missedAppointmentNote('eligible')).toMatch(/in an open calling window when capacity allows/);
  });

  it.each(['completed', 'abandoned_no_answer', 'opted_out', 'wrong_number', 'failed', 'cancelled'])(
    '%s: the screening is over, and no booking is offered',
    (state) => {
      const note = missedAppointmentNote(state);
      expect(note).toMatch(/This screening has ended/);
      expect(note).not.toMatch(/book/i);
    },
  );

  it.each([
    ['scheduled', /Another time is already booked/],
    ['pending_prereqs', /prerequisites are met/],
    ['dialing', /in progress now/],
    ['in_call', /in progress now/],
    ['reconnecting', /in progress now/],
  ])('%s says where the screening is now', (state, words) => {
    expect(missedAppointmentNote(state)).toMatch(words);
  });

  it('claims nothing about a state it could not read', () => {
    const note = missedAppointmentNote(null);
    expect(note).toMatch(/Open the candidate/);
    expect(note).not.toMatch(/queue|ended|booked/);
  });
});
