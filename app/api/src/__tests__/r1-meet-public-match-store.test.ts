/**
 * M035 S04 T2: the local match store of the public booking form
 * (lib/r1/meet/public/match-store.ts; S04-PLAN D-S04-16, D-S04-17, D-S04-18, and the review F1 fix).
 *
 * Pinned here, with a recording RPC double and with the REAL Supabase client over a capturing fetch:
 *  - exactly ONE call, the read-only lookup RPC `r1_meet_public_local_rows` with the normalised
 *    email and phone and `p_limit` 21, and no call at all when neither typed value is usable;
 *  - as the real client sends it: one POST whose URL carries no query string and no typed value
 *    (the typed values are in the body only, so never in the API gateway's request log), and never
 *    a table read;
 *  - the rows: the eight RPC keys read strictly into ids and booleans, lower-cased candidate ids,
 *    verbatim Ashby ids, sorted, frozen, at most 21 (the 21st = "more than 20");
 *  - every failure is `r1_meet_db_error` and the message is that code alone, with no typed value;
 *  - parity with the migrations for the RPC S12's 0144 creates: the DSAR lists of 0130, the two
 *    indexes it must use, every column it reads, and (once declared) its signature and grants.
 * Every id, email and number below is synthetic.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { supabase } from '../lib/supabase.js';
import { R1MeetJobError } from '../lib/r1/meet/jobs.js';
import { decideR1PublicLocal, type R1PublicLocalRow } from '../lib/r1/meet/public/match.js';
import {
  R1_PUBLIC_DSAR_HOLD_STATUSES,
  R1_PUBLIC_DSAR_HOLD_TYPES,
  R1_PUBLIC_LOCAL_ROWS_RPC,
  R1_PUBLIC_LOCAL_ROW_COLUMNS,
  findR1PublicLocalRows,
} from '../lib/r1/meet/public/match-store.js';

// ── Synthetic identity ───────────────────────────────────────────────────────

const hex = (n: number): string => n.toString(16).padStart(12, '0');
/** Local `candidates.id` values. */
const cand = (n: number): string => `0b6f3c1e-1111-4a00-8000-${hex(n)}`;
/** Ashby application ids. */
const app = (n: number): string => `0b6f3c1e-2222-4a00-8000-${hex(n)}`;
/** Ashby candidate ids. */
const ashby = (n: number): string => `0b6f3c1e-3333-4a00-8000-${hex(n)}`;

const C1 = cand(1);
const C2 = cand(2);
const C3 = cand(3);
const APP1 = app(1);
const APP2 = app(2);
const APP3 = app(3);
const ASHBY1 = ashby(1);
const ASHBY2 = ashby(2);

const EMAIL = 'test.person@example.com';
const PHONE = '+919812345670';
const TYPED = { email: EMAIL, phone: PHONE };
/** Substrings of the typed values that must never appear in a URL, a row or an error. */
const TYPED_FRAGMENTS = ['test.person', 'example.com', '@', '9812345670', '98123', '45670', 'first_last'];

const ROW_KEYS = [
  'candidateId',
  'matchedBy',
  'applicationId',
  'ashbyCandidateId',
  'linkTerminal',
  'mappingEnabled',
  'dsarHold',
  'decisionBlocked',
] as const satisfies readonly (keyof R1PublicLocalRow)[];

type Row = Record<string, unknown>;

/** One RPC row (snake case, the 0144 answer); a bookable link of C1 by default. */
const rpcRow = (over: Row = {}): Row => ({
  candidate_id: C1,
  matched_by: 'both',
  application_id: APP1,
  ashby_candidate_id: ASHBY1,
  link_terminal: false,
  mapping_enabled: true,
  dsar_hold: false,
  decision_blocked: false,
  ...over,
});
/** The fail-closed row of a candidate with no link. */
const noLinkRow = (over: Row = {}): Row =>
  rpcRow({ application_id: null, ashby_candidate_id: null, link_terminal: true, mapping_enabled: false, ...over });
const ok = (rows: unknown): { data: unknown; error: null } => ({ data: { status: 'ok', rows }, error: null });

function localRow(over: Partial<R1PublicLocalRow> = {}): R1PublicLocalRow {
  return {
    candidateId: C1,
    matchedBy: 'both',
    applicationId: APP1,
    ashbyCandidateId: ASHBY1,
    linkTerminal: false,
    mappingEnabled: true,
    dsarHold: false,
    decisionBlocked: false,
    ...over,
  };
}

// ── The recording double ─────────────────────────────────────────────────────

type Answer = { data: unknown; error: unknown };
type Responder = Answer | Error | (() => Answer | Error);
interface RpcCall {
  readonly name: string;
  readonly args: unknown;
  readonly options: unknown;
}

/** Records every `rpc` call; any table read throws; `throwOnCall` makes `rpc` itself throw. */
function fakeDb(responder: Responder = ok([]), options: { throwOnCall?: boolean } = {}) {
  const calls: RpcCall[] = [];
  const db = {
    from() {
      throw new Error('the match store reads no table');
    },
    rpc(name: string, args: unknown, rpcOptions?: unknown) {
      if (options.throwOnCall) throw new Error(`driver detail ${EMAIL} ${PHONE}`);
      calls.push({ name, args, options: rpcOptions });
      const answer = typeof responder === 'function' ? responder() : responder;
      return {
        then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
          (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)).then(resolve, reject),
      };
    },
  };
  return { db: db as unknown as typeof supabase, calls };
}

async function expectDbError(promise: Promise<unknown>, label?: string): Promise<void> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected r1_meet_db_error, got ${JSON.stringify(value)} (${label ?? ''})`);
    },
    (reason: unknown) => reason,
  );
  expect(error, label).toBeInstanceOf(R1MeetJobError);
  expect((error as R1MeetJobError).code, label).toBe('r1_meet_db_error');
  expect((error as Error).message, label).toBe('r1_meet_db_error');
  const shown = [String(error), JSON.stringify(error), (error as Error).message].join(' ');
  for (const fragment of TYPED_FRAGMENTS) expect(shown, `${label ?? ''}: ${fragment}`).not.toContain(fragment);
}

// ── The one call ─────────────────────────────────────────────────────────────

describe('findR1PublicLocalRows: one read-only RPC (review F1)', () => {
  it('makes exactly one call: the lookup RPC with the normalised values and limit 21, no table read', async () => {
    const { db, calls } = fakeDb(ok([rpcRow()]));
    expect(await findR1PublicLocalRows(db, TYPED)).toEqual([localRow()]);
    expect(R1_PUBLIC_LOCAL_ROWS_RPC).toBe('r1_meet_public_local_rows');
    expect(calls).toEqual([
      { name: 'r1_meet_public_local_rows', args: { p_email: EMAIL, p_phone: PHONE, p_limit: 21 }, options: undefined },
    ]);
  });

  it('normalises the typed values again before sending them', async () => {
    const { db, calls } = fakeDb();
    await findR1PublicLocalRows(db, { email: '  Test.Person@Example.COM\t', phone: '+91 98123 45670' });
    expect(calls.map((call) => call.args)).toEqual([{ p_email: EMAIL, p_phone: PHONE, p_limit: 21 }]);
  });

  it('sends an address with *, % or _ as it is (an equality in SQL, never a pattern)', async () => {
    const { db, calls } = fakeDb();
    await findR1PublicLocalRows(db, { email: 'First_Last%X*Y@Example.com', phone: null });
    expect(calls.map((call) => call.args)).toEqual([{ p_email: 'first_last%x*y@example.com', p_phone: null, p_limit: 21 }]);
  });

  type SkipCase = [name: string, input: { email: string | null; phone: string | null }, args: unknown];
  it.each<SkipCase>([
    ['email null: the phone only', { email: null, phone: PHONE }, { p_email: null, p_phone: PHONE, p_limit: 21 }],
    ['phone null: the email only', { email: EMAIL, phone: null }, { p_email: EMAIL, p_phone: null, p_limit: 21 }],
    ['a landline: the email only', { email: EMAIL, phone: '+91 22 2345 6789' }, { p_email: EMAIL, p_phone: null, p_limit: 21 }],
    ['an unusable email: the phone only', { email: 'not-an-email', phone: PHONE }, { p_email: null, p_phone: PHONE, p_limit: 21 }],
    ['both null: no call', { email: null, phone: null }, null],
    ['neither normalises (not an address, a landline): no call', { email: 'not-an-email', phone: '+91 22 2345 6789' }, null],
    ['a foreign mobile is not a phone here', { email: null, phone: '+44 7700 900123' }, null],
    ['blank values: no call', { email: '   ', phone: '' }, null],
  ])('%s', async (_name, input, args) => {
    const { db, calls } = fakeDb(ok([rpcRow()]));
    const out = await findR1PublicLocalRows(db, input);
    if (args === null) {
      expect(calls).toEqual([]);
      expect(out).toEqual([]);
      expect(Object.isFrozen(out)).toBe(true);
    } else {
      expect(calls.map((call) => call.args)).toEqual([args]);
    }
  });

  it('an empty answer: no rows, frozen', async () => {
    const out = await findR1PublicLocalRows(fakeDb(ok([])).db, TYPED);
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

// ── As the real client sends it ──────────────────────────────────────────────

describe('the call as the real Supabase client sends it', () => {
  function realDb(answer: unknown) {
    const requests: Array<{ method: string; url: URL; body: unknown }> = [];
    const client = createClient('https://db.example.test', 'k'.repeat(40), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'screening_v2' },
      global: {
        fetch: async (input: unknown, init?: { method?: string; body?: unknown }) => {
          requests.push({ method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ?? null });
          return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    return { db: client as unknown as typeof supabase, requests };
  }

  it('sends one POST to the RPC; the typed values are in the body only, never in the URL', async () => {
    const { db, requests } = realDb({ status: 'ok', rows: [rpcRow()] });
    const out = await findR1PublicLocalRows(db, { email: 'first_last%x*y@example.com', phone: '+91 98123 45670' });
    expect(out).toEqual([localRow()]);

    expect(requests).toHaveLength(1);
    const [request] = requests as [(typeof requests)[number]];
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/rest/v1/rpc/r1_meet_public_local_rows');
    expect(request.url.search).toBe('');
    const url = decodeURIComponent(request.url.href);
    for (const fragment of TYPED_FRAGMENTS) expect(url, fragment).not.toContain(fragment);
    expect(JSON.parse(String(request.body))).toEqual({
      p_email: 'first_last%x*y@example.com',
      p_phone: PHONE,
      p_limit: 21,
    });
  });
});

// ── The rows ─────────────────────────────────────────────────────────────────

describe('the rows (D-S04-18)', () => {
  it('maps the eight RPC keys to the eight row fields, as they are', async () => {
    const answer = [
      rpcRow({ matched_by: 'email' }),
      rpcRow({ candidate_id: C2, application_id: APP2, link_terminal: true, mapping_enabled: false, dsar_hold: true }),
      noLinkRow({ candidate_id: C3, matched_by: 'phone', decision_blocked: true }),
    ];
    expect(await findR1PublicLocalRows(fakeDb(ok(answer)).db, TYPED)).toEqual([
      localRow({ matchedBy: 'email' }),
      localRow({ candidateId: C2, applicationId: APP2, linkTerminal: true, mappingEnabled: false, dsarHold: true }),
      localRow({
        candidateId: C3,
        matchedBy: 'phone',
        applicationId: null,
        ashbyCandidateId: null,
        linkTerminal: true,
        mappingEnabled: false,
        decisionBlocked: true,
      }),
    ]);
  });

  it('sorts by candidate id, then application id (no link last), lower-cases candidate ids, keeps Ashby ids verbatim', async () => {
    const verbatim = 'Ab.C-12_x:Y';
    const answer = [
      rpcRow({ candidate_id: C3.toUpperCase(), application_id: APP3 }),
      rpcRow({ application_id: APP2, ashby_candidate_id: verbatim }),
      rpcRow({ application_id: APP1, ashby_candidate_id: null }),
      noLinkRow({ candidate_id: C2 }),
    ];
    const out = await findR1PublicLocalRows(fakeDb(ok(answer)).db, TYPED);
    expect(out.map((row) => [row.candidateId, row.applicationId, row.ashbyCandidateId])).toEqual([
      [C1, APP1, null],
      [C1, APP2, verbatim],
      [C2, null, null],
      [C3, APP3, ASHBY1],
    ]);
  });

  it('freezes the rows and the list; every row has exactly the eight fields and no typed value', async () => {
    const answer = [rpcRow(), rpcRow({ application_id: APP2, link_terminal: true }), noLinkRow({ candidate_id: C2, matched_by: 'email', dsar_hold: true })];
    const out = await findR1PublicLocalRows(fakeDb(ok(answer)).db, { email: 'first_last%x\\y@example.com', phone: PHONE });
    expect(out).toHaveLength(3);
    expect(Object.isFrozen(out)).toBe(true);
    for (const row of out) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.keys(row)).toEqual([...ROW_KEYS]);
    }
    const json = JSON.stringify(out);
    for (const fragment of TYPED_FRAGMENTS) expect(json, fragment).not.toContain(fragment);
  });

  it('the RPC keys are pinned and frozen', () => {
    expect([...R1_PUBLIC_LOCAL_ROW_COLUMNS]).toEqual([
      'candidate_id',
      'matched_by',
      'application_id',
      'ashby_candidate_id',
      'link_terminal',
      'mapping_enabled',
      'dsar_hold',
      'decision_blocked',
    ]);
    expect(Object.isFrozen(R1_PUBLIC_LOCAL_ROW_COLUMNS)).toBe(true);
  });
});

// ── Bounds ───────────────────────────────────────────────────────────────────

describe('bounds: at most 21 rows, and the 21st means "more than 20"', () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => noLinkRow({ candidate_id: cand(100 + i), matched_by: 'email' }));

  it('21 rows are read, and the decision is ambiguous', async () => {
    const out = await findR1PublicLocalRows(fakeDb(ok(people(21))).db, TYPED);
    expect(out).toHaveLength(21);
    expect(decideR1PublicLocal(out)).toEqual({ kind: 'not_found', reason: 'ambiguous' });
  });

  it('20 rows: the count alone is not a refusal', async () => {
    const out = await findR1PublicLocalRows(fakeDb(ok(people(20))).db, TYPED);
    expect(out).toHaveLength(20);
    expect(decideR1PublicLocal(out)).toEqual({ kind: 'not_found', reason: 'no_bookable_application' });
  });

  it('22 rows break the RPC contract: r1_meet_db_error', async () => {
    await expectDbError(findR1PublicLocalRows(fakeDb(ok(people(22))).db, TYPED));
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

describe('failures: every one is r1_meet_db_error and nothing else', () => {
  it('a DB error (the RPC missing until 0144 is one)', async () => {
    const missing = { data: null, error: { message: `Could not find the function for ${EMAIL} ${PHONE}`, code: 'PGRST202' } };
    await expectDbError(findR1PublicLocalRows(fakeDb(missing).db, TYPED));
  });

  it('a rejected call', async () => {
    await expectDbError(findR1PublicLocalRows(fakeDb(new Error(`connect ECONNREFUSED for ${EMAIL} ${PHONE}`)).db, TYPED));
  });

  it('a throwing builder', async () => {
    await expectDbError(findR1PublicLocalRows(fakeDb(ok([]), { throwOnCall: true }).db, TYPED));
  });

  type Drift = [name: string, data: unknown];
  it.each<Drift>([
    ['an invalid_request answer', { status: 'invalid_request' }],
    ['no status', { rows: [] }],
    ['rows not a list', { status: 'ok', rows: {} }],
    ['rows missing', { status: 'ok' }],
    ['the answer null', null],
    ['the answer a list', [rpcRow()]],
    ['the answer a string', 'ok'],
  ])('an answer off the contract: %s', async (name, data) => {
    await expectDbError(findR1PublicLocalRows(fakeDb({ data, error: null }).db, TYPED), name);
  });

  const without = (column: string): Row => {
    const row = rpcRow();
    delete row[column];
    return row;
  };

  it.each<Drift>([
    ['a row that is null', [null]],
    ['a row that is a list', [[C1]]],
    ['an extra key (an email column)', [{ ...rpcRow(), email: EMAIL }]],
    ['an extra key (a name column)', [{ ...rpcRow(), name: 'Test Person' }]],
    ...R1_PUBLIC_LOCAL_ROW_COLUMNS.map((column): Drift => [`a missing ${column}`, [without(column)]]),
    ['a candidate id that is not a UUID', [rpcRow({ candidate_id: 'candidate-1' })]],
    ['a candidate id that is a number', [rpcRow({ candidate_id: 7 })]],
    ['an unknown matched_by', [rpcRow({ matched_by: 'name' })]],
    ['an application id with a space', [rpcRow({ application_id: 'app 1' })]],
    ['an empty application id', [rpcRow({ application_id: '' })]],
    ['an application id of 257 characters', [rpcRow({ application_id: 'a'.repeat(257) })]],
    ['an Ashby candidate id that is a number', [rpcRow({ ashby_candidate_id: 42 })]],
    ['a flag given as a string', [rpcRow({ dsar_hold: 'false' })]],
    ['a flag given as a number', [rpcRow({ mapping_enabled: 1 })]],
    ['a flag that is null', [rpcRow({ decision_blocked: null })]],
    ['a no-link row with an Ashby candidate id', [noLinkRow({ ashby_candidate_id: ASHBY1 })]],
    ['a no-link row that is not terminal', [noLinkRow({ link_terminal: false })]],
    ['a no-link row on an enabled mapping', [noLinkRow({ mapping_enabled: true })]],
    ['rows of one candidate that disagree on matched_by', [rpcRow(), rpcRow({ application_id: APP2, matched_by: 'email' })]],
    ['rows of one candidate that disagree on the hold', [rpcRow(), rpcRow({ application_id: APP2, dsar_hold: true })]],
    ['rows of one candidate that disagree on the block', [rpcRow(), rpcRow({ application_id: APP2, decision_blocked: true })]],
    ['the same link twice', [rpcRow(), rpcRow()]],
    ['a no-link row beside a link row of the same candidate', [rpcRow(), noLinkRow()]],
    ['a link row after a no-link row of the same candidate', [noLinkRow(), rpcRow()]],
  ])('a row off the contract: %s', async (name, rows) => {
    await expectDbError(findR1PublicLocalRows(fakeDb(ok(rows)).db, TYPED), name);
  });

  it('the same answers in shape pass (the drift table has a working control)', async () => {
    expect(await findR1PublicLocalRows(fakeDb(ok([rpcRow(), rpcRow({ application_id: APP2 })])).db, TYPED)).toEqual([
      localRow(),
      localRow({ applicationId: APP2 }),
    ]);
  });
});

// ── Parity with the migrations (what S12's 0144 RPC must read and how) ────────

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../supabase/migrations');
function migration(prefix: string): string {
  const file = readdirSync(MIGRATIONS).find((name) => name.startsWith(`${prefix}_`) && name.endsWith('.sql'));
  expect(file, prefix).toBeDefined();
  return readFileSync(path.join(MIGRATIONS, file!), 'utf8').replace(/\r\n/g, '\n');
}
const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

describe('parity with the migrations', () => {
  it('the DSAR hold lists are the 0130 intake predicate (every occurrence), inside the 0012 CHECKs', () => {
    const intake = migration('0130');
    const step = intake.indexOf('-- 7. A correction, restriction or erasure request (0012) holds every');
    expect(step).toBeGreaterThan(0);
    const predicates = [...intake.matchAll(/d\.request_type in \(([^)]*)\)\s*and d\.request_status in \(([^)]*)\)/g)];
    expect(predicates.length).toBeGreaterThanOrEqual(2);
    expect(predicates.some((m) => m.index! > step && m.index! < step + 400)).toBe(true);
    for (const match of predicates) {
      expect(quoted(match[1]!)).toEqual([...R1_PUBLIC_DSAR_HOLD_TYPES]);
      expect(quoted(match[2]!)).toEqual([...R1_PUBLIC_DSAR_HOLD_STATUSES]);
    }
    expect(Object.isFrozen(R1_PUBLIC_DSAR_HOLD_TYPES)).toBe(true);
    expect(Object.isFrozen(R1_PUBLIC_DSAR_HOLD_STATUSES)).toBe(true);

    const governance = migration('0012');
    const types = quoted(/constraint chk_dsar_request_type check \(\s*request_type in \(([^)]*)\)/.exec(governance)![1]!);
    const statuses = quoted(/constraint chk_dsar_request_status check \(\s*request_status in \(([^)]*)\)/.exec(governance)![1]!);
    for (const value of R1_PUBLIC_DSAR_HOLD_TYPES) expect(types).toContain(value);
    for (const value of R1_PUBLIC_DSAR_HOLD_STATUSES) expect(statuses).toContain(value);
  });

  it('the two indexes the RPC must use exist: lower(btrim(email)) (0114) and phone_e164 (0001)', () => {
    expect(migration('0114')).toMatch(
      /create index if not exists idx_v2_candidates_email_norm\s+on screening_v2\.candidates \(lower\(btrim\(email\)\)\)\s+where email is not null;/,
    );
    expect(migration('0001')).toContain(
      'create index if not exists idx_v2_candidates_phone on screening_v2.candidates(phone_e164);',
    );
  });

  it('every column the RPC reads exists in the migration that made it', () => {
    const expected: Record<string, Record<string, string>> = {
      candidates: { id: '0001', email: '0001', phone_e164: '0001', decision_use_blocked_at: '0015' },
      ashby_application_links: {
        candidate_id: '0029',
        external_application_id: '0029',
        external_candidate_id: '0029',
        terminal_state: '0029',
        job_mapping_id: '0029',
        provider: '0029',
      },
      data_subject_requests: { candidate_id: '0012', request_type: '0012', request_status: '0012' },
      ashby_job_mappings: { id: '0029', status: '0029', archived_at: '0109' },
    };
    for (const [table, columns] of Object.entries(expected)) {
      for (const [column, prefix] of Object.entries(columns)) {
        const sql = migration(prefix);
        const start = sql.indexOf(`create table if not exists screening_v2.${table} (`);
        const created = start >= 0
          && new RegExp(`\\n\\s+${column}\\s+(uuid|text|timestamptz)\\b`).test(sql.slice(start, sql.indexOf('\n);', start)));
        const added = new RegExp(
          `alter table screening_v2\\.${table}\\s+(?:add column if not exists \\w+ [^,;]+,\\s*)*add column if not exists ${column}\\s+(uuid|text|timestamptz)\\b`,
        ).test(sql);
        expect(created || added, `${table}.${column} in ${prefix}`).toBe(true);
      }
    }
  });

  it('once a migration declares the RPC it is 0144, with the signature, grants and row keys the store reads', () => {
    const declaring = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .filter((name) => readFileSync(path.join(MIGRATIONS, name), 'utf8').includes(`function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(`));
    // Not on main yet (S12 owns it); this pins the hand-off the moment it lands.
    expect(declaring.length).toBeLessThanOrEqual(1);
    if (declaring.length === 0) return;
    expect(declaring[0]).toMatch(/^0144_/);
    const sql = migration('0144');
    expect(sql).toMatch(
      new RegExp(`create or replace function screening_v2\\.${R1_PUBLIC_LOCAL_ROWS_RPC}\\(\\s*p_email text,\\s*p_phone text,\\s*p_limit integer default 21\\s*\\)\\s*returns jsonb`),
    );
    expect(sql).toContain(`revoke all on function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(text, text, integer) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function screening_v2.${R1_PUBLIC_LOCAL_ROWS_RPC}(text, text, integer) to service_role;`);
    for (const column of R1_PUBLIC_LOCAL_ROW_COLUMNS) expect(sql, column).toContain(`'${column}'`);
  });
});
