/**
 * M009 E2 — the per-machine phone agent-name helpers
 * (`integrations/livekit-phone-dial/agent-name.ts`) and the agent-join budget
 * (`PHONE_AGENT_JOIN_TIMEOUT_SEC` + `effectivePhoneAgentJoinTimeoutSec`).
 *
 * Properties under test:
 *   - real Fly machine ids are accepted; anything outside the narrow
 *     `[0-9a-z]{8,32}` class is rejected, so it can never reach a dispatch name;
 *   - `isReportedAgentNameFor` is EXACT equality: any suffix/base mismatch fails;
 *   - `AGENT_NAME_RE` mirrors the 0112 CHECK constraint, read from the migration
 *     itself when it is present, so the API cannot accept a name the column
 *     rejects;
 *   - the join timeout is bounded at load and clamped against the lease budget
 *     at use, and a short budget warns ONCE.
 *
 * Machine ids below are synthetic hex, not identifiers of anyone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  AGENT_NAME_RE,
  PER_MACHINE_ID_RE,
  isReportedAgentNameFor,
  phoneMachineAgentName,
} from '../integrations/livekit-phone-dial/agent-name.js';
import {
  PHONE_DIAL_BOUNDS,
  effectivePhoneAgentJoinTimeoutSec,
  loadPhoneDialConfig,
  resetPhoneAgentJoinBudgetWarningForTests,
  warnPhoneAgentJoinBudgetOnce,
} from '../integrations/livekit-phone-dial/config.js';

const BASE = 'phone-screener';

describe('PER_MACHINE_ID_RE / phoneMachineAgentName', () => {
  it.each(['d895472c499e38', '7812736a540d58', '12345678', 'z'.repeat(32)])(
    'accepts %s',
    (id) => {
      expect(PER_MACHINE_ID_RE.test(id)).toBe(true);
      expect(phoneMachineAgentName(BASE, id)).toBe(`${BASE}-${id}`);
    },
  );

  it.each([
    ['empty', ''],
    ['uppercase', 'ABC'],
    ['uppercase hex', 'D895472C499E38'],
    ['33 chars', 'a'.repeat(33)],
    ['7 chars', 'abcdefg'],
    ['dot', 'a.b'],
    ['hyphen', 'ab-cdefgh'],
    ['underscore', 'ab_cdefgh'],
    ['whitespace', 'd895472c 499e38'],
    ['trailing newline', 'd895472c499e38\n'],
  ])('rejects %s', (_label, id) => {
    expect(PER_MACHINE_ID_RE.test(id)).toBe(false);
    expect(phoneMachineAgentName(BASE, id)).toBeNull();
  });

  it('never falls back to the shared base for an invalid id', () => {
    expect(phoneMachineAgentName(BASE, 'a.b')).not.toBe(BASE);
  });

  it('refuses a base that would make an unstorable name', () => {
    expect(phoneMachineAgentName('', 'd895472c499e38')).toBeNull();
    expect(phoneMachineAgentName('x'.repeat(65), 'd895472c499e38')).toBeNull();
    expect(phoneMachineAgentName('bad base', 'd895472c499e38')).toBeNull();
  });

  it('every name it produces satisfies AGENT_NAME_RE', () => {
    for (const id of ['d895472c499e38', '7812736a540d58', '12345678']) {
      expect(AGENT_NAME_RE.test(phoneMachineAgentName(BASE, id)!)).toBe(true);
    }
  });
});

describe('isReportedAgentNameFor — exact equality only', () => {
  const ID = 'd895472c499e38';

  it('accepts exactly <base>-<machineId>', () => {
    expect(isReportedAgentNameFor(BASE, ID, `${BASE}-${ID}`)).toBe(true);
  });

  it.each([
    ['another machine', `${BASE}-7812736a540d58`],
    ['suffix extended', `${BASE}-${ID}0`],
    ['suffix truncated', `${BASE}-${ID.slice(0, -1)}`],
    ['bare base', BASE],
    ['different base', `browser-screener-${ID}`],
    ['base prefix only', `phone-${ID}`],
    ['extra prefix', `x${BASE}-${ID}`],
    ['case changed', `${BASE}-${ID.toUpperCase()}`],
    ['empty', ''],
  ])('rejects %s', (_label, reported) => {
    expect(isReportedAgentNameFor(BASE, ID, reported)).toBe(false);
  });

  it('rejects null / undefined reports', () => {
    expect(isReportedAgentNameFor(BASE, ID, null)).toBe(false);
    expect(isReportedAgentNameFor(BASE, ID, undefined)).toBe(false);
  });

  it('rejects when the LEASE machine id is itself invalid, even if strings match', () => {
    expect(isReportedAgentNameFor(BASE, 'a.b', `${BASE}-a.b`)).toBe(false);
  });
});

describe('AGENT_NAME_RE mirrors the 0112 CHECK constraint', () => {
  it('matches the route/DB contract on a fixture list', () => {
    expect(AGENT_NAME_RE.test('phone-screener-d895472c499e38')).toBe(true);
    expect(AGENT_NAME_RE.test(`${'a'.repeat(64)}-12345678`)).toBe(true);
    expect(AGENT_NAME_RE.test(`${'a'.repeat(65)}-12345678`)).toBe(false);
    expect(AGENT_NAME_RE.test('phonescreener')).toBe(false);
    // NOTE: the bare shared name IS shape-valid ('phone' + '-' + an 8-char
    // [0-9a-z] tail), so the shape alone cannot bind a name to a machine. That
    // binding is the exact-suffix check — `isReportedAgentNameFor` here and
    // the right(name, len(machine)+1) check in set_voice_worker_agent_name.
    expect(AGENT_NAME_RE.test('phone-screener')).toBe(true);
    expect(isReportedAgentNameFor(BASE, 'd895472c499e38', 'phone-screener')).toBe(false);
    expect(AGENT_NAME_RE.test('phone-screener-1234567')).toBe(false);
    expect(AGENT_NAME_RE.test('phone.screener-12345678')).toBe(false);
  });

  it('is the same pattern literal the 0112 migration constrains the column with (when present)', () => {
    const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
    const file = existsSync(dir)
      ? readdirSync(dir).find((f) => f.startsWith('0112_') && f.endsWith('.sql'))
      : undefined;
    if (file === undefined) {
      // 0112 lands in the same PR from another lane; until it exists there is
      // nothing to compare, and the fixture test above still pins the shape.
      return;
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const m = sql.match(/registered_agent_name\s*~\s*'([^']+)'/);
    expect(m, '0112 must constrain registered_agent_name with a ~ pattern').not.toBeNull();
    expect(m![1]).toBe(AGENT_NAME_RE.source);
  });
});

describe('PHONE_AGENT_JOIN_TIMEOUT_SEC', () => {
  it('defaults to 20 and clamps into [5, 60]; malformed reads as the default', () => {
    expect(PHONE_DIAL_BOUNDS.agentJoinTimeoutSec).toEqual({ def: 20, min: 5, max: 60 });
    const load = (v: string | undefined) =>
      loadPhoneDialConfig({ PHONE_AGENT_JOIN_TIMEOUT_SEC: v } as NodeJS.ProcessEnv)
        .agentJoinTimeoutSec;
    expect(load(undefined)).toBe(20);
    expect(load('30')).toBe(30);
    expect(load('1')).toBe(5);
    expect(load('600')).toBe(60);
    expect(load('-3')).toBe(20);
    expect(load('abc')).toBe(20);
    expect(load('12.5')).toBe(20);
  });

  it('keeps a literal process.env read for the env-contract scanner', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../integrations/livekit-phone-dial/config.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('process.env.PHONE_AGENT_JOIN_TIMEOUT_SEC');
  });
});

describe('effectivePhoneAgentJoinTimeoutSec — clamp against the lease budget', () => {
  beforeEach(() => resetPhoneAgentJoinBudgetWarningForTests());

  it('production defaults (lease 240, ready 120) keep the configured 20', () => {
    expect(effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 20, originateLeaseSec: 240, workerReadyTimeoutSec: 120,
    })).toEqual({ seconds: 20, budgetShort: false });
  });

  it('a tight lease clamps the wait to lease − ready − 5', () => {
    expect(effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 60, originateLeaseSec: 150, workerReadyTimeoutSec: 120,
    })).toEqual({ seconds: 25, budgetShort: false });
  });

  it('exactly the floor is met: not short', () => {
    expect(effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 20, originateLeaseSec: 130, workerReadyTimeoutSec: 120,
    })).toEqual({ seconds: 5, budgetShort: false });
  });

  it('below the floor: returns the floor and flags budgetShort', () => {
    expect(effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 20, originateLeaseSec: 120, workerReadyTimeoutSec: 120,
    })).toEqual({ seconds: 5, budgetShort: true });
  });

  it('an out-of-bounds configured value is re-clamped; NaN reads as the default', () => {
    expect(effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 600, originateLeaseSec: 900, workerReadyTimeoutSec: 30,
    }).seconds).toBe(60);
    expect(effectivePhoneAgentJoinTimeoutSec({
      configuredSec: Number.NaN, originateLeaseSec: 240, workerReadyTimeoutSec: 120,
    }).seconds).toBe(20);
  });

  it('warns ONCE per process, with an event kind only, and only when short', () => {
    const kinds: string[] = [];
    const ok = effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 20, originateLeaseSec: 240, workerReadyTimeoutSec: 120,
    });
    expect(warnPhoneAgentJoinBudgetOnce(ok, (k) => kinds.push(k))).toBe(false);
    const short = effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 20, originateLeaseSec: 60, workerReadyTimeoutSec: 120,
    });
    expect(warnPhoneAgentJoinBudgetOnce(short, (k) => kinds.push(k))).toBe(true);
    expect(warnPhoneAgentJoinBudgetOnce(short, (k) => kinds.push(k))).toBe(false);
    expect(kinds).toEqual(['phone_agent_join_budget_short']);
  });

  it('a throwing warn sink never breaks the caller', () => {
    const short = effectivePhoneAgentJoinTimeoutSec({
      configuredSec: 20, originateLeaseSec: 60, workerReadyTimeoutSec: 120,
    });
    expect(() => warnPhoneAgentJoinBudgetOnce(short, () => { throw new Error('sink'); }))
      .not.toThrow();
  });
});
