/**
 * The RPC contract, extracted from the migration rather than trusted.
 *
 * Three failure modes this exists to catch, each of which is silent otherwise:
 *   * A RENAMED or MISSING parameter is not a type error — PostgREST resolves
 *     an RPC by argument name, so it is a 404 at runtime.
 *   * A MISSING status member turns a benign refusal into a thrown error on a
 *     billable path. `halt_unreadable`, `attempt_required`,
 *     `ok_prereqs_pending`, `not_live` and `lease_lost` are the easy misses.
 *   * An EXTRA status member is a refusal we claim to handle and the database
 *     never produces, which reads as coverage and is not.
 */

import { describe, it, expect } from 'vitest';
import {
  PHONE_RPC_NAMES,
  PHONE_RPC_PARAMETERS,
  PHONE_RPC_RESULT_KEYS,
  PHONE_RPC_STATUSES,
  PHONE_RPC_STATUS_COUNT,
  PHONE_RPC_STATUS_UNION,
  PHONE_RPC_UNKNOWN_STATUS,
  narrowPhoneRpcStatus,
} from '../lib/phone-screening/rpc-contract.js';
import {
  CLOCK_FREE_RPCS,
  MIGRATION_0042,
  PHONE_MIGRATIONS_TEXT,
  RPC_NAMES,
  functionBody,
  functionParameters,
  functionStatuses,
} from './support/phone-migration.js';


describe('the extractor itself is not over-broad', () => {
  // A drift test built on an over-captured body validates a different object
  // than it names, which is worse than no drift test: it stays green while the
  // thing it claims to guard changes.
  it('a name that PREFIXES another does not capture its neighbour', () => {
    // `phone_ist_window_open` is a strict prefix of `phone_ist_window_open_at`,
    // and 0042 declares the longer one FIRST.
    const predicate = functionBody('phone_ist_window_open');
    expect(predicate.split('\n')[0]).toContain('phone_ist_window_open(p_at timestamptz)');
    expect(predicate).not.toContain('phone_ist_window_open_at()\nreturns');
    expect(predicate).not.toContain('phone_max_concurrent()\nreturns');
    expect(predicate.length).toBeLessThan(1_000);
  });

  it('a one-line helper terminates at its own inline $$;', () => {
    for (const name of [
      'phone_ist_window_open_at', 'phone_ist_window_close_at', 'phone_max_concurrent',
    ]) {
      const body = functionBody(name);
      expect(body.split('\n')[0]).toContain(`screening_v2.${name}(`);
      expect(body.length).toBeLessThan(400);
    }
  });

  it('every extracted body contains exactly one function header', () => {
    for (const name of [...RPC_NAMES, 'phone_ist_window_open', 'phone_ist_date',
      'phone_next_window_open', 'phone_max_concurrent']) {
      const headers = [...functionBody(name)
        .matchAll(/create or replace function screening_v2\.\w+\(/g)];
      expect(headers, `${name} over-captured`).toHaveLength(1);
    }
  });

  it('the status extractor is not vacuous — it finds what is there', () => {
    // A silently-empty extraction would make every vocabulary assertion pass.
    expect(functionStatuses('admit_phone_attempt').size).toBe(26);
    expect(functionStatuses('schedule_phone_appointment')).toContain('ok_prereqs_pending');
    expect(() => functionStatuses('phone_ist_date')).toThrow(/no statuses extracted/);
    expect(() => functionBody('no_such_function')).toThrow(/no phone migration declares/);
  });
});

describe('the seventeen RPCs', () => {
  it('the TS list is exactly the migrations\' service-role RPC set', () => {
    expect(new Set(PHONE_RPC_NAMES)).toEqual(new Set(RPC_NAMES));
    // Ten from 0042, four from 0043.
    expect(PHONE_RPC_NAMES).toHaveLength(17);
    for (const name of PHONE_RPC_NAMES) {
      // Searched across BOTH migrations: the question here is "is this granted
      // anywhere in the phone schema", not "which declaration wins".
      expect(PHONE_MIGRATIONS_TEXT).toContain(
        `grant execute on function screening_v2.${name}`,
      );
      // Service-role only: nothing is granted to a browser role.
      expect(PHONE_MIGRATIONS_TEXT).toContain(
        `revoke all on function screening_v2.${name}`,
      );
      expect(PHONE_MIGRATIONS_TEXT).not.toMatch(
        new RegExp(`grant execute on function screening_v2\\.${name}[^;]*to (?:anon|authenticated|public)`),
      );
    }
  });

  it('parameter names match the migration signatures, in order', () => {
    for (const name of PHONE_RPC_NAMES) {
      expect(PHONE_RPC_PARAMETERS[name]).toEqual(functionParameters(name));
    }
  });

  it('every time-dependent RPC takes p_now as its FINAL parameter', () => {
    for (const name of PHONE_RPC_NAMES) {
      const params = PHONE_RPC_PARAMETERS[name];
      if (CLOCK_FREE_RPCS.includes(name)) {
        // A pure read that decides nothing time-dependent takes no clock. The
        // exemption is ENUMERATED, not inferred from "has no p_now" — which
        // would excuse exactly the mistake this test exists to catch.
        expect(params).not.toContain('p_now');
        continue;
      }
      expect(params[params.length - 1]).toBe('p_now');
    }
  });

  it('no RPC body reads the machine clock', () => {
    for (const name of PHONE_RPC_NAMES) {
      const body = functionBody(name);
      // Column DEFAULTs on tables deliberately keep now(); function BODIES
      // must not, or a boundary test passes in Asia and fails in CI.
      expect(body).not.toMatch(/\bclock_timestamp\(\)/);
      expect(body).not.toMatch(/\bcurrent_timestamp\b/);
      // `now()` appears EXACTLY once, and only as the `p_now` default in the
      // signature — never inside the body, where it would make the RPC read
      // the machine clock instead of the injected instant.
      if (CLOCK_FREE_RPCS.includes(name)) {
        // No clock at all — not even the signature default.
        expect([...body.matchAll(/\bnow\(\)/g)]).toHaveLength(0);
        continue;
      }
      expect([...body.matchAll(/\bnow\(\)/g)]).toHaveLength(1);
      expect(body).toMatch(/p_now\s+timestamptz default now\(\)/);
    }
  });
});

describe('the RESULT keys the API reads', () => {
  // `PHONE_RPC_PARAMETERS` pins what we SEND; these pin what we READ, and the
  // two are not the same risk. A renamed parameter is a PostgREST 404 — loud.
  // A renamed result key is silent, and one of them is load-bearing in a
  // DESTRUCTIVE direction: the calendar API treats a reschedule whose
  // `superseded_appointment_id` is null as a lost update and cancels the
  // appointment it just created. If 0042 renamed that key, every legitimate
  // reschedule would destroy its own slot and report `version_conflict`.

  it('every declared key appears in the body of the RPC that emits it', () => {
    const entries = Object.entries(PHONE_RPC_RESULT_KEYS);
    // Fail closed: an empty map would make the loop vacuous.
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const [rpc, keys] of entries) {
      const body = functionBody(rpc);
      expect(keys.length, `${rpc} declares no result keys`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(body, `${rpc} no longer emits ${key}`).toContain(`'${key}'`);
      }
    }
  });

  it('the destructive one is pinned by name, and by what makes its NULL meaningful', () => {
    // Spelled out because a future edit that trimmed the map would otherwise
    // remove this key silently and leave the loop above still passing.
    expect(PHONE_RPC_RESULT_KEYS.schedule_phone_appointment)
      .toContain('superseded_appointment_id');
    const body = functionBody('schedule_phone_appointment');
    // The key is emitted UNCONDITIONALLY in the success payload, and its value
    // is `v_live.id` — the row found by the live-appointment lookup, which is
    // NULL exactly when no live appointment existed. That is the whole basis of
    // the API's lost-update detector: the key is always THERE (so absent means
    // a contract break, never "superseded nothing"), and its null means "the
    // expected-version comparison never ran".
    expect(body).toMatch(/'superseded_appointment_id',\s*v_live\.id\s*\)/);
    // …and it is emitted from the ONE success return, not from a branch that
    // could be skipped.
    expect([...body.matchAll(/'superseded_appointment_id'/g)]).toHaveLength(1);
  });

  it('every RPC named here is one 0042 actually declares', () => {
    for (const rpc of Object.keys(PHONE_RPC_RESULT_KEYS)) {
      expect(PHONE_RPC_NAMES).toContain(rpc);
    }
  });
});

describe('the status vocabulary', () => {
  for (const name of RPC_NAMES) {
    it(`${name}: the TS union is exactly the migration's`, () => {
      expect(new Set(PHONE_RPC_STATUSES[name])).toEqual(functionStatuses(name));
    });
  }

  it('the distinct-status count is exactly what the migrations declare', () => {
    const fromMigration = new Set(RPC_NAMES.flatMap((n) => [...functionStatuses(n)]));
    expect(fromMigration.size).toBe(PHONE_RPC_STATUS_COUNT);
    expect(new Set(PHONE_RPC_STATUS_UNION)).toEqual(fromMigration);
  });

  it('the easy-to-miss benign refusals are all carried', () => {
    for (const status of [
      'halt_unreadable', 'attempt_required', 'ok_prereqs_pending', 'not_live', 'lease_lost',
    ]) {
      expect(PHONE_RPC_STATUS_UNION).toContain(status);
    }
    expect(PHONE_RPC_STATUSES.clear_phone_halt).toContain('halt_unreadable');
    expect(PHONE_RPC_STATUSES.admit_phone_attempt).toContain('halt_unreadable');
    expect(PHONE_RPC_STATUSES.apply_phone_event).toContain('attempt_required');
    expect(PHONE_RPC_STATUSES.schedule_phone_appointment).toContain('ok_prereqs_pending');
    expect(PHONE_RPC_STATUSES.cancel_phone_appointment).toContain('not_live');
    expect(PHONE_RPC_STATUSES.heartbeat_phone_attempt).toContain('lease_lost');
  });

  it('apply_phone_event has no "ok" — it answers applied or ignored', () => {
    expect(PHONE_RPC_STATUSES.apply_phone_event).not.toContain('ok');
    expect(PHONE_RPC_STATUSES.apply_phone_event).toContain('applied');
    expect(PHONE_RPC_STATUSES.apply_phone_event).toContain('ignored');
  });
});

describe('narrowing an answer', () => {
  it('accepts a declared status for that RPC only', () => {
    expect(narrowPhoneRpcStatus('admit_phone_attempt', { status: 'window_closed' }))
      .toBe('window_closed');
    // `lease_lost` is real, but not an answer admission can give.
    expect(narrowPhoneRpcStatus('admit_phone_attempt', { status: 'lease_lost' }))
      .toBe(PHONE_RPC_UNKNOWN_STATUS);
  });

  it('malformed and unknown bodies narrow to a STABLE sanitized value', () => {
    for (const body of [
      null,
      undefined,
      {},
      { status: null },
      { status: 42 },
      { status: '' },
      { status: 'a_status_from_a_future_migration' },
      { status: { nested: 'ok' } },
      [{ status: 'ok' }],
      'ok',
      { STATUS: 'ok' },
    ]) {
      expect(narrowPhoneRpcStatus('admit_phone_attempt', body)).toBe(PHONE_RPC_UNKNOWN_STATUS);
    }
  });

  it('the unknown marker is not a member of any RPC vocabulary', () => {
    // A caller must never confuse "the database refused" with "we never got an
    // answer", so the marker cannot collide with a real refusal.
    for (const name of PHONE_RPC_NAMES) {
      expect(PHONE_RPC_STATUSES[name]).not.toContain(PHONE_RPC_UNKNOWN_STATUS);
    }
    expect(PHONE_RPC_STATUS_UNION).not.toContain(PHONE_RPC_UNKNOWN_STATUS);
  });

  it('narrowing never throws, whatever it is handed', () => {
    for (const name of PHONE_RPC_NAMES) {
      expect(() => narrowPhoneRpcStatus(name, Symbol('x'))).not.toThrow();
      expect(() => narrowPhoneRpcStatus(name, new Error('x'))).not.toThrow();
    }
  });
});
