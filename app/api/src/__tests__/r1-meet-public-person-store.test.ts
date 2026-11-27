/**
 * M035 S12 fix round (F3): the book path's person-wide "no R1 yet" check
 * (lib/r1/meet/public/person-store.ts, migration 0144 §9).
 *
 * One call, two keys, ids only; a strict reader of the three closed answers; every failure is the
 * one bare `r1_meet_db_error`; and the store's vocabulary equals the migration's. The SQL
 * behaviour runs in supabase-ci (app/supabase/tests/r1_meet_public_import_assert.sql, section I).
 * Synthetic ids only; no network, no database.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { supabase } from '../lib/supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../lib/r1/meet/jobs.js';
import {
  R1_PUBLIC_PERSON_R1_INVALID_FIELDS,
  R1_PUBLIC_PERSON_R1_REFUSAL_CODES,
  R1_PUBLIC_PERSON_R1_RPC,
  checkR1PublicPersonR1,
} from '../lib/r1/meet/public/person-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.resolve(here, '../../../supabase/migrations/0144_r1_meet_public_import.sql'), 'utf8')
  .replace(/\r\n/g, '\n');

const CANDIDATE_ID = '7f144000-0000-4000-8000-001000000301';
const APPLICATION_ID = '7f144000-0000-4000-8000-002200000301';
const INPUT = { candidateId: CANDIDATE_ID, applicationId: APPLICATION_ID };

type Answer = { data: unknown; error: unknown };
type Responder = Answer | Error;

/** Records every `rpc` call; any table read throws; `throwOnCall` makes `rpc` itself throw. */
function fakeDb(responder: Responder, options: { throwOnCall?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    from() {
      throw new Error('the person check reads no table');
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (options.throwOnCall) throw new Error(`driver detail ${CANDIDATE_ID}`);
      calls.push({ name, args });
      return {
        then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
          (responder instanceof Error ? Promise.reject(responder) : Promise.resolve(responder)).then(resolve, reject),
      };
    },
  };
  return { db: db as unknown as typeof supabase, calls };
}

const ok = (data: unknown): Answer => ({ data, error: null });

async function expectDbError(promise: Promise<unknown>, label: string): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, label).toBeInstanceOf(R1MeetJobError);
  expect((caught as Error).message, label).toBe(R1_MEET_DB_ERROR);
  expect((caught as Error).message, label).not.toContain(CANDIDATE_ID);
}

describe('person-store: the call', () => {
  it('makes ONE rpc call to the 0144 §9 function with exactly the two id keys, and reads no table', async () => {
    const { db, calls } = fakeDb(ok({ status: 'eligible' }));
    await checkR1PublicPersonR1(db, { ...INPUT, email: 'x@example.test' } as never);
    expect(calls).toEqual([
      { name: 'r1_meet_public_person_r1_check', args: { p_candidate_id: CANDIDATE_ID, p_ashby_application_id: APPLICATION_ID } },
    ]);
    expect(R1_PUBLIC_PERSON_R1_RPC).toBe('r1_meet_public_person_r1_check');
  });
});

describe('person-store: the answers, read strictly', () => {
  it('eligible', async () => {
    const out = await checkR1PublicPersonR1(fakeDb(ok({ status: 'eligible' })).db, INPUT);
    expect(out).toEqual({ status: 'eligible' });
    expect(Object.isFrozen(out)).toBe(true);
  });

  for (const code of R1_PUBLIC_PERSON_R1_REFUSAL_CODES) {
    it(`refused ${code}`, async () => {
      const out = await checkR1PublicPersonR1(fakeDb(ok({ status: 'refused', code })).db, INPUT);
      expect(out).toEqual({ status: 'refused', code });
      expect(Object.isFrozen(out)).toBe(true);
    });
  }

  for (const field of R1_PUBLIC_PERSON_R1_INVALID_FIELDS) {
    it(`invalid_request ${field}`, async () => {
      const out = await checkR1PublicPersonR1(fakeDb(ok({ status: 'invalid_request', field })).db, INPUT);
      expect(out).toEqual({ status: 'invalid_request', field });
    });
  }

  it('the vocabulary is closed and frozen', () => {
    expect([...R1_PUBLIC_PERSON_R1_REFUSAL_CODES]).toEqual(['application_unknown', 'r1_completed']);
    expect([...R1_PUBLIC_PERSON_R1_INVALID_FIELDS]).toEqual(['candidate_id', 'application_id']);
    expect(Object.isFrozen(R1_PUBLIC_PERSON_R1_REFUSAL_CODES)).toBe(true);
    expect(Object.isFrozen(R1_PUBLIC_PERSON_R1_INVALID_FIELDS)).toBe(true);
  });
});

describe('person-store: every failure is the one bare r1_meet_db_error', () => {
  const drift: Array<[string, Responder]> = [
    ['a database error', { data: null, error: { message: `boom ${CANDIDATE_ID}` } }],
    ['a rejected call', new Error(`rejected ${CANDIDATE_ID}`)],
    ['no data', ok(null)],
    ['an array', ok([{ status: 'eligible' }])],
    ['a string', ok('eligible')],
    ['an unknown status', ok({ status: 'ok' })],
    ['eligible with an extra key', ok({ status: 'eligible', candidate_id: CANDIDATE_ID })],
    ['refused with an unknown code', ok({ status: 'refused', code: 'already_booked' })],
    ['refused without a code', ok({ status: 'refused' })],
    ['refused with an extra key', ok({ status: 'refused', code: 'r1_completed', other: 1 })],
    ['invalid_request with an unknown field', ok({ status: 'invalid_request', field: 'now' })],
    ['invalid_request with a non-string field', ok({ status: 'invalid_request', field: 1 })],
  ];
  for (const [label, responder] of drift) {
    it(label, async () => {
      await expectDbError(checkR1PublicPersonR1(fakeDb(responder).db, INPUT), label);
    });
  }

  it('a builder that throws', async () => {
    await expectDbError(checkR1PublicPersonR1(fakeDb(ok({ status: 'eligible' }), { throwOnCall: true }).db, INPUT), 'throw');
  });
});

describe('person-store: in step with migration 0144 §9', () => {
  const start = MIGRATION.indexOf(`create or replace function screening_v2.${R1_PUBLIC_PERSON_R1_RPC}(`);
  const body = MIGRATION.slice(start, MIGRATION.indexOf('\n$$;\n', start));

  it('the migration declares the function once, with the two parameters the store sends', () => {
    expect(start).toBeGreaterThan(-1);
    expect(MIGRATION.indexOf(`create or replace function screening_v2.${R1_PUBLIC_PERSON_R1_RPC}(`, start + 1)).toBe(-1);
    expect(body).toMatch(/\(\n {2}p_candidate_id uuid,\n {2}p_ashby_application_id text\n\)\n/);
  });

  it('its codes and fields are exactly the store\'s, in order', () => {
    const codes = [...body.matchAll(/'code', '([a-z0-9_]+)'/g)].map((m) => m[1]);
    const fields = [...body.matchAll(/'field', '([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(codes).toEqual([...R1_PUBLIC_PERSON_R1_REFUSAL_CODES]);
    expect(fields).toEqual([...R1_PUBLIC_PERSON_R1_INVALID_FIELDS]);
  });
});
