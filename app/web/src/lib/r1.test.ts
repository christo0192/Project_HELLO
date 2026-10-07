/**
 * R1 presentation rules: pure functions, so every branch is pinned directly.
 */
import { describe, expect, it } from 'vitest';
import {
  R1_AVAILABILITY_COPY,
  availabilityFixableInSettings,
  attemptsLabel,
  canActOnRound,
  canCancel,
  canGrantRetake,
  canReissue,
  currentMonthStart,
  draftFromSettings,
  formatMinutes,
  isAvailabilityRefusal,
  isLiveRound,
  isReadingStale,
  needsConfirmation,
  parseDashboardMinutes,
  percentOf,
  r1Ceiling,
  r1ErrorMessage,
  r1FreeMinutes,
  r1PoolMinutes,
  r1RunState,
  r1StatusLabel,
  r1StatusTone,
  readingMonthLabel,
  rebaseDraft,
  sendGate,
  sendGateNotice,
  settingsPatch,
  usageTone,
  validateSettingsDraft,
} from './r1';
import type { R1Round, R1Settings } from './r1-types';

function round(over: Partial<R1Round> = {}): R1Round {
  return {
    id: 'r',
    status: 'invited',
    expires_at: '2026-10-09T10:00:00.000Z',
    attempts_allowed: 2,
    attempts_counted: 0,
    recommendation: null,
    overall: null,
    created_at: '2026-10-06T10:00:00.000Z',
    ...over,
  };
}

const SETTINGS: R1Settings = {
  enabled: true,
  paused: false,
  auto_status_enabled: false,
  monthly_cap_minutes: 4000,
  pause_line_minutes: 4000,
  advance_threshold: 65,
  hold_threshold: 45,
  livekit_target: 'cloud',
  dashboard_minutes: 0,
  dashboard_read_at: null,
};

describe('round state', () => {
  it('treats only invited and in_progress as live', () => {
    expect(isLiveRound({ status: 'invited' })).toBe(true);
    expect(isLiveRound({ status: 'in_progress' })).toBe(true);
    for (const status of ['completed', 'expired', 'cancelled'] as const) {
      expect(isLiveRound({ status })).toBe(false);
    }
  });

  it('allows reissue only before anything has started, and cancel while live', () => {
    expect(canReissue({ status: 'invited' })).toBe(true);
    expect(canReissue({ status: 'in_progress' })).toBe(false);
    expect(canCancel({ status: 'invited' })).toBe(true);
    expect(canCancel({ status: 'in_progress' })).toBe(true);
    expect(canCancel({ status: 'completed' })).toBe(false);
  });

  it('mirrors the server retake rule: completed, one counted attempt, one left', () => {
    expect(canGrantRetake(round({ status: 'completed', attempts_counted: 1 }))).toBe(true);
    expect(canGrantRetake(round({ status: 'completed', attempts_counted: 2 }))).toBe(false);
    expect(canGrantRetake(round({ status: 'completed', attempts_counted: 0 }))).toBe(false);
    expect(
      canGrantRetake(round({ status: 'completed', attempts_counted: 1, attempts_allowed: 1 })),
    ).toBe(false);
    expect(canGrantRetake(round({ status: 'invited', attempts_counted: 1 }))).toBe(false);
  });

  it('gates Send: open, live, or completed (live wins over completed)', () => {
    expect(sendGate([])).toEqual({ kind: 'open' });
    expect(sendGate([round({ status: 'expired' }), round({ status: 'cancelled' })])).toEqual({
      kind: 'open',
    });
    const live = round({ id: 'live', status: 'in_progress' });
    const done = round({ id: 'done', status: 'completed' });
    expect(sendGate([done, live])).toEqual({ kind: 'live', round: live });
    expect(sendGate([round({ status: 'expired' }), done])).toEqual({
      kind: 'completed',
      round: done,
    });
  });

  describe('a round that ended without completing but counted an attempt (one-retake rule)', () => {
    // A granted retake the candidate never took expires with attempts_counted 1; a call
    // cancelled mid-way keeps its counted attempt. The server does not stop a new round,
    // so a second full attempt would get past the "one retake, granted by HR" rule.
    it.each(['expired', 'cancelled'] as const)('offers no Send after a counted %s', (status) => {
      const used = round({ id: 'used', status, attempts_counted: 1 });
      expect(sendGate([used])).toEqual({ kind: 'attempt_used', round: used });
    });

    it('still offers Send for an unused link that expired or was cancelled', () => {
      for (const status of ['expired', 'cancelled'] as const) {
        expect(sendGate([round({ status, attempts_counted: 0 })])).toEqual({ kind: 'open' });
      }
    });

    it('lets a live round (the granted retake itself) and a completed round win', () => {
      const used = round({ id: 'used', status: 'expired', attempts_counted: 1 });
      const retake = round({ id: 'retake', status: 'invited', attempts_counted: 1 });
      const done = round({ id: 'done', status: 'completed', attempts_counted: 1 });
      expect(sendGate([used, retake])).toEqual({ kind: 'live', round: retake });
      expect(sendGate([used, done])).toEqual({ kind: 'completed', round: done });
    });

    it('says why in words, and says nothing when Send is open or a round is live', () => {
      const used = round({ status: 'cancelled', attempts_counted: 1 });
      expect(sendGateNotice({ kind: 'attempt_used', round: used })).toMatch(
        /already used an R1 attempt.*cannot be sent/,
      );
      expect(sendGateNotice({ kind: 'completed', round: used })).toMatch(
        /completed R1.*cannot be sent.*grant it/,
      );
      expect(sendGateNotice({ kind: 'open' })).toBeNull();
      expect(sendGateNotice({ kind: 'live', round: used })).toBeNull();
    });
  });

  describe('who may act on a round (the API’s ownership rule)', () => {
    const mine = round({ created_by: 'user-1' });
    const theirs = round({ created_by: 'user-2' });

    it('lets an admin act on every round', () => {
      expect(canActOnRound(mine, 'admin', 'user-9')).toBe(true);
      expect(canActOnRound(theirs, 'admin', null)).toBe(true);
    });

    it('lets an interviewer act only on a round they created', () => {
      expect(canActOnRound(mine, 'interviewer', 'user-1')).toBe(true);
      expect(canActOnRound(theirs, 'interviewer', 'user-1')).toBe(false);
    });

    it('refuses an interviewer with no known id or a round with no known creator', () => {
      expect(canActOnRound(mine, 'interviewer', null)).toBe(false);
      expect(canActOnRound(round(), 'interviewer', 'user-1')).toBe(false);
    });

    it('never lets a viewer act', () => {
      expect(canActOnRound(mine, 'viewer', 'user-1')).toBe(false);
    });
  });

  it('words attempts truthfully, including a count above the allowance', () => {
    const label = (allowed: number, counted: number) =>
      attemptsLabel({ attempts_allowed: allowed, attempts_counted: counted });
    expect(label(2, 0)).toBe('0 of 2 attempts used');
    expect(label(2, 1)).toBe('1 of 2 attempts used');
    expect(label(1, 3)).toBe('3 of 3 attempts used');
  });

  it('labels statuses and falls back to the raw word for an unknown one', () => {
    expect(r1StatusLabel('invited')).toBe('Link sent');
    expect(r1StatusLabel('in_progress')).toBe('In progress');
    expect(r1StatusLabel('mystery')).toBe('mystery');
    expect(r1StatusTone('completed')).toBe('positive');
    expect(r1StatusTone('mystery')).toBe('neutral');
  });
});

describe('availability copy', () => {
  it('has a title and detail for every blocked state, and none says "ready"', () => {
    for (const copy of Object.values(R1_AVAILABILITY_COPY)) {
      expect(copy.title.length).toBeGreaterThan(5);
      expect(copy.detail.length).toBeGreaterThan(20);
    }
    expect(Object.keys(R1_AVAILABILITY_COPY).sort()).toEqual([
      'capacity_exhausted',
      'config_invalid',
      'disabled',
      'not_deployed',
      'paused',
      'role_not_configured',
    ]);
  });

  it('tells a not-deployed server apart from the admin switch being off', () => {
    const notDeployed = R1_AVAILABILITY_COPY.not_deployed;
    const disabled = R1_AVAILABILITY_COPY.disabled;
    expect(notDeployed.title).toBe('R1 is not live on this server yet');
    expect(notDeployed.detail).toMatch(/R1 settings cannot change it/);
    // The switched-off copy invites an admin to flip the switch; the other must not.
    expect(disabled.detail).toMatch(/switch R1 on in R1 settings/);
    expect(notDeployed.detail).not.toMatch(/switch R1 on/);
  });

  it('points an admin at settings only for states settings can fix', () => {
    expect(availabilityFixableInSettings('disabled')).toBe(true);
    expect(availabilityFixableInSettings('paused')).toBe(true);
    expect(availabilityFixableInSettings('capacity_exhausted')).toBe(true);
    expect(availabilityFixableInSettings('role_not_configured')).toBe(false);
    expect(availabilityFixableInSettings('config_invalid')).toBe(false);
    expect(availabilityFixableInSettings('not_deployed')).toBe(false);
    expect(availabilityFixableInSettings('ready')).toBe(false);
  });
});

describe('API refusals in words', () => {
  it('maps known send codes and never echoes a code it does not know', () => {
    expect(r1ErrorMessage('india_location_attestation_required', 'send')).toMatch(/India/);
    expect(r1ErrorMessage('round_active', 'send')).toMatch(/already out/);
    expect(r1ErrorMessage('r1_capacity_exhausted', 'send')).toMatch(/allowance/);
    const unknown = r1ErrorMessage('zzz_unknown_code', 'send');
    expect(unknown).toMatch(/could not be sent/);
    expect(unknown).not.toContain('zzz_unknown_code');
  });

  it('maps round codes, with a different fallback from send', () => {
    expect(r1ErrorMessage('retake_not_allowed', 'round')).toMatch(/once/);
    expect(r1ErrorMessage('round_transition_conflict', 'round')).toMatch(/refreshed/);
    expect(r1ErrorMessage('', 'round')).toMatch(/could not be made/);
    expect(r1ErrorMessage('', 'send')).toMatch(/could not be sent/);
  });

  it('does not offer a send-only explanation for a round action', () => {
    expect(r1ErrorMessage('phone_engagement_active', 'round')).toMatch(/could not be made/);
  });

  it('recognises the refusals that mean availability is stale', () => {
    for (const code of [
      'r1_disabled',
      'r1_paused',
      'r1_capacity_exhausted',
      'r1_role_not_configured',
      'role_not_configured',
    ]) {
      expect(isAvailabilityRefusal(code)).toBe(true);
    }
    expect(isAvailabilityRefusal('round_active')).toBe(false);
    expect(isAvailabilityRefusal('')).toBe(false);
  });
});

describe('settings draft', () => {
  it('round-trips the saved values as the strings a form holds', () => {
    expect(draftFromSettings(SETTINGS)).toEqual({
      enabled: true,
      paused: false,
      auto_status_enabled: false,
      monthly_cap_minutes: '4000',
      pause_line_minutes: '4000',
      advance_threshold: '65',
      hold_threshold: '45',
    });
  });

  it('accepts valid values', () => {
    expect(validateSettingsDraft(draftFromSettings(SETTINGS))).toEqual({});
    const edge = {
      ...draftFromSettings(SETTINGS),
      advance_threshold: '100',
      hold_threshold: '0',
      monthly_cap_minutes: '1',
    };
    expect(validateSettingsDraft(edge)).toEqual({});
    const equal = { ...draftFromSettings(SETTINGS), advance_threshold: '50', hold_threshold: '50' };
    expect(validateSettingsDraft(equal)).toEqual({});
    const decimals = { ...draftFromSettings(SETTINGS), advance_threshold: '64.25' };
    expect(validateSettingsDraft(decimals)).toEqual({});
  });

  it.each([
    ['monthly_cap_minutes', ''],
    ['monthly_cap_minutes', '0'],
    ['monthly_cap_minutes', '-5'],
    ['monthly_cap_minutes', '1.5'],
    ['monthly_cap_minutes', '4e3'],
    ['monthly_cap_minutes', '4,000'],
    ['pause_line_minutes', 'abc'],
    ['advance_threshold', '101'],
    ['advance_threshold', '-1'],
    ['advance_threshold', '65.123'],
    ['hold_threshold', ''],
    ['hold_threshold', '1e1'],
  ])('rejects %s = %j', (key, value) => {
    const errors = validateSettingsDraft({ ...draftFromSettings(SETTINGS), [key]: value });
    expect(errors[key as keyof typeof errors]).toBeTruthy();
  });

  it('rejects a hold threshold above the advance threshold, naming the hold field', () => {
    const errors = validateSettingsDraft({
      ...draftFromSettings(SETTINGS),
      advance_threshold: '40',
      hold_threshold: '45',
    });
    expect(errors.hold_threshold).toMatch(/cannot be above/);
    expect(errors.advance_threshold).toBeUndefined();
  });

  it('builds a patch of only what changed, as numbers', () => {
    const draft = {
      ...draftFromSettings(SETTINGS),
      paused: true,
      monthly_cap_minutes: ' 3000 ',
      hold_threshold: '50.5',
    };
    expect(settingsPatch(draft, SETTINGS)).toEqual({
      paused: true,
      monthly_cap_minutes: 3000,
      hold_threshold: 50.5,
    });
    expect(settingsPatch(draftFromSettings(SETTINGS), SETTINGS)).toEqual({});
  });

  it('compares against numeric strings the database may return', () => {
    const saved = { ...SETTINGS, advance_threshold: '65.00' as unknown as number };
    expect(settingsPatch(draftFromSettings(saved), saved)).toEqual({});
  });

  it('returns an empty patch for an invalid draft rather than a partial one', () => {
    const draft = { ...draftFromSettings(SETTINGS), paused: true, monthly_cap_minutes: 'x' };
    expect(settingsPatch(draft, SETTINGS)).toEqual({});
  });

  it('asks for confirmation exactly when behaviour that matters changes', () => {
    expect(needsConfirmation({})).toEqual([]);
    expect(needsConfirmation({ monthly_cap_minutes: 10, paused: true })).toEqual([]);
    expect(needsConfirmation({ enabled: true })[0]).toMatch(/switch R1 on/);
    expect(needsConfirmation({ enabled: false })[0]).toMatch(/switch R1 off/);
    expect(needsConfirmation({ auto_status_enabled: true })[0]).toMatch(/change candidate status/);
    expect(needsConfirmation({ auto_status_enabled: false })[0]).toMatch(/stop R1 changing/);
    expect(needsConfirmation({ enabled: true, auto_status_enabled: true })).toHaveLength(2);
  });

  it('asks before RESUMING R1 (the step after a deploy-safety pause), never before pausing', () => {
    expect(needsConfirmation({ paused: false })[0]).toMatch(/resume R1/);
    expect(needsConfirmation({ paused: true })).toEqual([]);
  });

  describe('rebaseDraft: a saved row that changed under the form', () => {
    const base = draftFromSettings(SETTINGS);

    it('follows the server on every field the person has not touched', () => {
      // Another admin paused R1 and moved the cap; this person edited nothing.
      const next = { ...SETTINGS, paused: true, monthly_cap_minutes: 3000 };
      expect(rebaseDraft(base, SETTINGS, next)).toEqual(draftFromSettings(next));
    });

    it('keeps a field the person edited, and still follows the rest', () => {
      const edited = { ...base, advance_threshold: '70' };
      const next = { ...SETTINGS, paused: true, advance_threshold: 80 };
      expect(rebaseDraft(edited, SETTINGS, next)).toEqual({
        ...draftFromSettings(next),
        advance_threshold: '70',
      });
    });

    it('leaves nothing dirty after an unrelated change, so no stale value can be re-sent', () => {
      const next = { ...SETTINGS, paused: true };
      const rebased = rebaseDraft(base, SETTINGS, next);
      expect(settingsPatch(rebased, next)).toEqual({});
    });

    it('sends only the person’s own edit afterwards, never the other admin’s field', () => {
      const edited = { ...base, hold_threshold: '40' };
      const next = { ...SETTINGS, paused: true };
      const rebased = rebaseDraft(edited, SETTINGS, next);
      expect(settingsPatch(rebased, next)).toEqual({ hold_threshold: 40 });
    });

    it('treats typing the old saved value back as untouched', () => {
      // Typing the old value back is indistinguishable from not touching the field.
      const next = { ...SETTINGS, monthly_cap_minutes: 2500 };
      const retyped = { ...base, monthly_cap_minutes: '4000' };
      expect(rebaseDraft(retyped, SETTINGS, next).monthly_cap_minutes).toBe('2500');
    });
  });

  it('parses a dashboard reading strictly', () => {
    expect(parseDashboardMinutes('1234')).toBe(1234);
    expect(parseDashboardMinutes(' 1234.5 ')).toBe(1234.5);
    expect(parseDashboardMinutes('0')).toBe(0);
    for (const bad of ['', 'abc', '-1', '1.234', '1,234', '1e3', '123456789']) {
      expect(parseDashboardMinutes(bad)).toBeNull();
    }
  });
});

describe('run state', () => {
  const runtime = { enabled: true, status: 'enabled' as const };

  it('is On only when both switches agree and R1 is not paused', () => {
    expect(r1RunState(SETTINGS, runtime)).toMatchObject({ label: 'On', tone: 'success' });
  });

  it('puts a configuration error ahead of everything else', () => {
    const invalid = { enabled: false, status: 'invalid' as const, reason: 'bad' };
    expect(r1RunState({ ...SETTINGS, paused: true }, invalid)).toMatchObject({
      label: 'Configuration error',
      tone: 'danger',
    });
  });

  it('says Off at the API when only the database switch is on', () => {
    const off = { enabled: false, status: 'disabled' as const };
    const state = r1RunState(SETTINGS, off);
    expect(state.label).toBe('Off at the API');
    expect(state.detail).toMatch(/R1_ENABLED/);
  });

  it('says Off, then Paused, from the database switches', () => {
    expect(r1RunState({ ...SETTINGS, enabled: false }, runtime).label).toBe('Off');
    expect(r1RunState({ ...SETTINGS, paused: true }, runtime).label).toBe('Paused');
    expect(r1RunState({ ...SETTINGS, enabled: false, paused: true }, runtime).label).toBe('Off');
  });

  it('copes with an API that did not report its runtime status', () => {
    expect(r1RunState(SETTINGS, undefined).label).toBe('On');
  });

  it('reports the automatic-status switch in the detail', () => {
    expect(r1RunState(SETTINGS, runtime).detail).toMatch(/off/);
    expect(r1RunState({ ...SETTINGS, auto_status_enabled: true }, runtime).detail).toMatch(/on/);
  });
});

describe('usage figures', () => {
  // The capacity figures are the API's (the RPCs' shared-pool arithmetic); this module only
  // shows them. committed_minutes already includes the pool guard and the held links.
  const usage = {
    monthly_cap_minutes: 4000,
    pause_line_minutes: 3500,
    minutes_reserved: 55,
    committed_minutes: 1205,
  };

  it('takes the lower of the cap and the pause line as the ceiling', () => {
    expect(r1Ceiling(usage)).toBe(3500);
    expect(r1Ceiling({ ...usage, monthly_cap_minutes: 100 })).toBe(100);
  });

  it('leaves free what the committed pool and held links have not claimed', () => {
    expect(r1FreeMinutes(usage)).toBe(3500 - 1205);
  });

  it('never reports negative free minutes when the pool is past the line', () => {
    expect(r1FreeMinutes({ ...usage, committed_minutes: 3967.5, pause_line_minutes: 3000 })).toBe(
      0,
    );
  });

  it('separates the pool from the held links inside the committed minutes', () => {
    expect(r1PoolMinutes(usage)).toBe(1150);
    expect(r1PoolMinutes({ ...usage, committed_minutes: 20 })).toBe(0);
  });

  it('shows phone-dominated use as claimed, not as free (the review’s figures)', () => {
    // 3,450 phone minutes: the guard is 3,967.5, R1 itself used and held nothing.
    const phoneHeavy = { ...usage, pause_line_minutes: 4000, minutes_reserved: 0 };
    const figures = { ...phoneHeavy, committed_minutes: 3967.5 };
    expect(r1PoolMinutes(figures)).toBe(3967.5);
    expect(r1FreeMinutes(figures)).toBe(32.5);
  });

  it('bands the pool at 60, 75 and 90 percent', () => {
    expect(usageTone(null)).toBe('neutral');
    expect(usageTone(0)).toBe('success');
    expect(usageTone(59)).toBe('success');
    expect(usageTone(60)).toBe('info');
    expect(usageTone(74)).toBe('info');
    expect(usageTone(75)).toBe('warning');
    expect(usageTone(89)).toBe('warning');
    expect(usageTone(90)).toBe('danger');
    expect(usageTone(250)).toBe('danger');
  });

  it('computes a percentage only against a real whole', () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(300, 200)).toBe(150);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(5, -1)).toBeNull();
    expect(percentOf(Number.NaN, 10)).toBeNull();
  });

  it('formats minutes as whole numbers', () => {
    expect(formatMinutes(1234.6)).toBe('1,235');
    expect(formatMinutes(0)).toBe('0');
  });
});

describe('a dashboard reading from an earlier month', () => {
  // The capacity guard adds the reading in every month until a new one is recorded.
  it('is stale when it was read in an earlier UTC month than the API’s current one', () => {
    expect(isReadingStale('2026-09-30T23:59:00.000Z', '2026-10-01')).toBe(true);
    expect(isReadingStale('2025-12-15T10:00:00.000Z', '2026-01-01')).toBe(true);
  });

  it('is current when read this month, whatever the day', () => {
    expect(isReadingStale('2026-10-01T00:00:00.000Z', '2026-10-01')).toBe(false);
    expect(isReadingStale('2026-10-31T23:59:59.000Z', '2026-10-01')).toBe(false);
  });

  it('reads the UTC month of an offset timestamp, as PostgREST may return it', () => {
    // 1 Oct 02:00 at +05:30 is 30 Sep 20:30 UTC: September.
    expect(isReadingStale('2026-10-01T02:00:00+05:30', '2026-10-01')).toBe(true);
  });

  it('is not stale with no reading, or one that cannot be read', () => {
    expect(isReadingStale(null, '2026-10-01')).toBe(false);
    expect(isReadingStale('not a date', '2026-10-01')).toBe(false);
  });

  it('is not stale when the reading is in a later month than the clock says (skew)', () => {
    expect(isReadingStale('2026-11-01T00:00:00.000Z', '2026-10-01')).toBe(false);
  });

  it('names the API’s month the way the API does, and the reading’s month in words', () => {
    expect(currentMonthStart(new Date('2026-10-07T12:00:00.000Z'))).toBe('2026-10-01');
    expect(currentMonthStart(new Date('2026-12-31T23:59:59.000Z'))).toBe('2026-12-01');
    expect(readingMonthLabel('2026-09-30T20:00:00.000Z')).toBe('September 2026');
  });
});
