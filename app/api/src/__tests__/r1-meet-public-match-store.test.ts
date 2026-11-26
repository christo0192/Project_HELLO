/**
 * M035 S04 T2: the local match store of the public booking form
 * (lib/r1/meet/public/match-store.ts; S04-PLAN D-S04-16, D-S04-17, D-S04-18).
 *
 * Pinned here, with a recording query double that behaves like a tiny database (it filters each
 * table by the `.in` lists and applies `.limit`), and with the REAL Supabase client over a capturing
 * fetch for the query strings it sends:
 *  - exactly five plain one-table reads: candidates by email (ILIKE, `\ % _` escaped) and by phone
 *    (`phone_e164` equality), at most 21 each; their links (provider ashby) and DSAR holds (the 0130
 *    intake predicate), at most 101 per id batch; the links' mappings; every id list in batches of
 *    at most 100, and no read at all when neither typed value is usable;
 *  - never a PII column selected, and never a typed value in a row or an error;
 *  - the rows: one per (candidate, link), a fail-closed row for a candidate with no link, `both`
 *    when both sides matched, mapping/terminal/hold/block booleans, lower-cased candidate ids,
 *    verbatim Ashby ids, sorted, frozen, exactly eight keys, at most 21 (the 21st = "more than 20");
 *  - every failure is `r1_meet_db_error` and the message is that code alone;
 *  - parity with the migrations: the DSAR lists of 0130, the CHECK values of 0029, and every column
 *    the store names exists where its migration created it (0001, 0012, 0015, 0029, 0109).
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
/** `ashby_job_mappings.id` values. */
const mapping = (n: number): string => `0b6f3c1e-6666-4a00-8000-${hex(n)}`;

const C1 = cand(1);
const C2 = cand(2);
const C3 = cand(3);
const APP1 = app(1);
const APP2 = app(2);
const APP3 = app(3);
const ASHBY1 = ashby(1);
const ASHBY2 = ashby(2);
const M1 = mapping(1);
const M2 = mapping(2);

const EMAIL = 'test.person@example.com';
const PHONE = '+919812345670';
const TYPED = { email: EMAIL, phone: PHONE };
/** Substrings of the typed values that must never appear in a row or an error. */
const TYPED_FRAGMENTS = ['test.person', 'example.com', '@', '9812345670', '98123', '45670', 'first_last'];
const NOW = '2030-01-01T10:00:00.000Z';

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

const candidateRow = (id: string, blocked: string | null = null): Row => ({ id, decision_use_blocked_at: blocked });
const linkRow = (over: Row = {}): Row => ({
  candidate_id: C1,
  external_application_id: APP1,
  external_candidate_id: ASHBY1,
  terminal_state: null,
  job_mapping_id: M1,
  ...over,
});
const mappingRow = (over: Row = {}): Row => ({ id: M1, status: 'enabled', archived_at: null, ...over });
const holdRow = (candidateId: string): Row => ({ candidate_id: candidateId });

// ── The recording double ─────────────────────────────────────────────────────

type Answer = { data: unknown; error: unknown };
type Call = [op: string, ...args: unknown[]];
interface Query {
  readonly table: string;
  readonly calls: Call[];
}
type Responder = Answer | Error | ((query: Query) => Answer | Error);

const CHAIN = [
  'select', 'eq', 'neq', 'in', 'not', 'is', 'ilike', 'like', 'or', 'filter',
  'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range',
] as const;

const rows = (data: unknown): Answer => ({ data, error: null });
const failure = (): Answer => ({ data: null, error: { message: `relation does not exist near ${EMAIL} ${PHONE}` } });

/** Records every builder call per query; `throwAt` makes `from(table)` itself throw. */
function fakeDb(answers: Record<string, Responder> = {}, options: { throwAt?: string } = {}) {
  const queries: Query[] = [];
  const db = {
    from(table: string) {
      if (options.throwAt === table) throw new Error(`driver detail ${EMAIL} ${PHONE}`);
      const query: Query = { table, calls: [] };
      queries.push(query);
      const settle = async (): Promise<Answer> => {
        const responder = answers[table] ?? rows([]);
        const answer = typeof responder === 'function' ? responder(query) : responder;
        if (answer instanceof Error) throw answer;
        return answer;
      };
      const builder: Record<string, unknown> = {
        then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) => settle().then(resolve, reject),
      };
      for (const op of CHAIN) {
        builder[op] = (...args: unknown[]) => {
          query.calls.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
    rpc() {
      throw new Error('the match store calls no RPC');
    },
  };
  return { db: db as unknown as typeof supabase, queries };
}

const callsOf = (query: Query, op: string): Call[] => query.calls.filter(([name]) => name === op);
const isEmailSide = (query: Query): boolean => callsOf(query, 'ilike').length > 0;
/** The list of `.in(column, list)`, lower-cased (uuid equality ignores case). */
function inList(query: Query, column: string): string[] {
  const call = query.calls.find(([op, col]) => op === 'in' && col === column);
  return call ? (call[2] as string[]).map((value) => value.toLowerCase()) : [];
}
function limitOf(query: Query): number {
  const call = callsOf(query, 'limit')[0];
  return call ? (call[1] as number) : Number.POSITIVE_INFINITY;
}
const lower = (value: unknown): string => String(value).toLowerCase();

interface World {
  email?: Row[];
  phone?: Row[];
  links?: Row[];
  holds?: Row[];
  mappings?: Row[];
}

/** A tiny database: each table filtered by its `.in` list and cut at its `.limit`. */
function world(w: World): Record<string, Responder> {
  const cut = (query: Query, list: Row[]): Answer => rows(list.slice(0, limitOf(query)));
  return {
    candidates: (query) => cut(query, isEmailSide(query) ? (w.email ?? []) : (w.phone ?? [])),
    ashby_application_links: (query) =>
      cut(query, (w.links ?? []).filter((row) => inList(query, 'candidate_id').includes(lower(row.candidate_id)))),
    data_subject_requests: (query) =>
      cut(query, (w.holds ?? []).filter((row) => inList(query, 'candidate_id').includes(lower(row.candidate_id)))),
    ashby_job_mappings: (query) =>
      cut(query, (w.mappings ?? []).filter((row) => inList(query, 'id').includes(lower(row.id)))),
  };
}

/** One bookable candidate on both sides: C1 with APP1 on the enabled M1. */
const ONE_PERSON: World = {
  email: [candidateRow(C1)],
  phone: [candidateRow(C1)],
  links: [linkRow()],
  mappings: [mappingRow()],
};

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

// ── The reads ────────────────────────────────────────────────────────────────

describe('findR1PublicLocalRows: the reads (D-S04-16)', () => {
  it('reads exactly five tables, with exact columns, filters and limits, in this order', async () => {
    const { db, queries } = fakeDb(world({
      email: [candidateRow(C1)],
      phone: [candidateRow(C1), candidateRow(C2)],
      links: [linkRow(), linkRow({ candidate_id: C2, external_application_id: APP2, job_mapping_id: null })],
      mappings: [mappingRow()],
    }));
    await findR1PublicLocalRows(db, TYPED);
    expect(queries.map((query) => [query.table, query.calls])).toEqual([
      ['candidates', [
        ['select', 'id,decision_use_blocked_at'],
        ['ilike', 'email', EMAIL],
        ['order', 'id', { ascending: true }],
        ['limit', 21],
      ]],
      ['candidates', [
        ['select', 'id,decision_use_blocked_at'],
        ['eq', 'phone_e164', PHONE],
        ['order', 'id', { ascending: true }],
        ['limit', 21],
      ]],
      ['ashby_application_links', [
        ['select', 'candidate_id,external_application_id,external_candidate_id,terminal_state,job_mapping_id'],
        ['eq', 'provider', 'ashby'],
        ['in', 'candidate_id', [C1, C2]],
        ['order', 'external_application_id', { ascending: true }],
        ['limit', 101],
      ]],
      ['data_subject_requests', [
        ['select', 'candidate_id'],
        ['in', 'candidate_id', [C1, C2]],
        ['in', 'request_type', ['correct', 'restrict', 'delete']],
        ['in', 'request_status', ['pending', 'in_progress', 'fulfilled']],
        ['limit', 101],
      ]],
      ['ashby_job_mappings', [
        ['select', 'id,status,archived_at'],
        ['in', 'id', [M1]],
      ]],
    ]);
  });

  it('normalises the typed values again before filtering on them', async () => {
    const { db, queries } = fakeDb(world({}));
    await findR1PublicLocalRows(db, { email: '  Test.Person@Example.COM\t', phone: '+91 98123 45670' });
    expect(callsOf(queries[0]!, 'ilike')).toEqual([['ilike', 'email', EMAIL]]);
    expect(callsOf(queries[1]!, 'eq')).toEqual([['eq', 'phone_e164', PHONE]]);
  });

  it('escapes backslash, percent and underscore, so the ILIKE is an equality', async () => {
    const { db, queries } = fakeDb(world({}));
    await findR1PublicLocalRows(db, { email: 'First_Last%X\\Y@Example.com', phone: null });
    expect(callsOf(queries[0]!, 'ilike')).toEqual([['ilike', 'email', 'first\\_last\\%x\\\\y@example.com']]);
  });

  type SkipCase = [name: string, input: { email: string | null; phone: string | null }, sides: string[]];
  it.each<SkipCase>([
    ['email null: the phone side only', { email: null, phone: PHONE }, ['phone']],
    ['phone null: the email side only', { email: EMAIL, phone: null }, ['email']],
    ['an email with * is never a like pattern: the phone side only', { email: 'a*b@example.com', phone: PHONE }, ['phone']],
    ['an email with * and no phone: no query', { email: 'a*b@example.com', phone: null }, []],
    ['both null: no query', { email: null, phone: null }, []],
    ['neither normalises (not an address, a landline): no query', { email: 'not-an-email', phone: '+91 22 2345 6789' }, []],
    ['a foreign mobile is not a phone here', { email: null, phone: '+44 7700 900123' }, []],
    ['blank values: no query', { email: '   ', phone: '' }, []],
  ])('%s', async (_name, input, sides) => {
    const { db, queries } = fakeDb(world(ONE_PERSON));
    const out = await findR1PublicLocalRows(db, input);
    const candidateReads = queries.filter((query) => query.table === 'candidates');
    expect(candidateReads.map((query) => (isEmailSide(query) ? 'email' : 'phone'))).toEqual(sides);
    if (sides.length === 0) {
      expect(queries).toEqual([]);
      expect(out).toEqual([]);
      expect(Object.isFrozen(out)).toBe(true);
    }
  });

  it('no candidate on either side: no link, hold or mapping read, and no rows', async () => {
    const { db, queries } = fakeDb(world({}));
    const out = await findR1PublicLocalRows(db, TYPED);
    expect(queries.map((query) => query.table)).toEqual(['candidates', 'candidates']);
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('links without a mapping: no mapping read', async () => {
    const { db, queries } = fakeDb(world({ ...ONE_PERSON, links: [linkRow({ job_mapping_id: null })] }));
    await findR1PublicLocalRows(db, TYPED);
    expect(queries.map((query) => query.table)).not.toContain('ashby_job_mappings');
  });

  it('never selects an email, name, phone, parsed or resume column', async () => {
    const { db, queries } = fakeDb(world(ONE_PERSON));
    await findR1PublicLocalRows(db, TYPED);
    const selects = queries.flatMap((query) => callsOf(query, 'select').map((call) => String(call[1])));
    expect(selects).toHaveLength(5);
    for (const select of selects) expect(select).not.toMatch(/email|name|phone|parsed|resume/i);
  });

  it('reads every id list in batches of at most 100 (the chunkIds pattern)', async () => {
    // A double that ignores the candidate limit, so the batching of the candidate ids is visible.
    const many = Array.from({ length: 150 }, (_, i) => candidateRow(cand(1000 + i)));
    const links = Array.from({ length: 101 }, (_, i) => linkRow({ external_application_id: app(i + 1), job_mapping_id: mapping(i + 1) }));
    const answers = world({ links, mappings: [] });
    answers.candidates = (query) => rows(isEmailSide(query) ? [candidateRow(C1), ...many] : []);
    const { db, queries } = fakeDb(answers);
    const out = await findR1PublicLocalRows(db, { email: EMAIL, phone: null });
    const sizes = (table: string, column: string) =>
      queries.filter((query) => query.table === table).map((query) => inList(query, column).length);
    expect(sizes('ashby_application_links', 'candidate_id')).toEqual([100, 51]);
    expect(sizes('data_subject_requests', 'candidate_id')).toEqual([100, 51]);
    expect(sizes('ashby_job_mappings', 'id')).toEqual([100, 1]);
    expect(out).toHaveLength(21);
  });
});

// ── As the real client sends them ────────────────────────────────────────────

describe('the queries as the real Supabase client builds them', () => {
  function realDb(answer: (table: string, query: Record<string, string>) => unknown) {
    const requests: Array<{ method: string; table: string; query: Record<string, string>; body: unknown }> = [];
    const client = createClient('https://db.example.test', 'k'.repeat(40), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'screening_v2' },
      global: {
        fetch: async (input: unknown, init?: { method?: string; body?: unknown }) => {
          const url = new URL(String(input));
          const table = url.pathname.split('/').pop()!;
          const query = Object.fromEntries(url.searchParams);
          requests.push({ method: init?.method ?? 'GET', table, query, body: init?.body ?? null });
          return new Response(JSON.stringify(answer(table, query)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    return { db: client as unknown as typeof supabase, requests };
  }

  it('sends five GETs whose decoded query strings are exactly the documented filters', async () => {
    const { db, requests } = realDb((table) => {
      if (table === 'candidates') return [candidateRow(C1)];
      if (table === 'ashby_application_links') return [linkRow()];
      if (table === 'ashby_job_mappings') return [mappingRow()];
      return [];
    });
    const out = await findR1PublicLocalRows(db, { email: 'first_last%x\\y@example.com', phone: '+91 98123 45670' });
    expect(out).toEqual([localRow()]);

    const find = (table: string, key: string) => requests.find((r) => r.table === table && key in r.query);
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.body).toBeNull();
    }
    expect(find('candidates', 'email')!.query).toEqual({
      select: 'id,decision_use_blocked_at',
      email: 'ilike.first\\_last\\%x\\\\y@example.com',
      order: 'id.asc',
      limit: '21',
    });
    expect(find('candidates', 'phone_e164')!.query).toEqual({
      select: 'id,decision_use_blocked_at',
      phone_e164: 'eq.+919812345670',
      order: 'id.asc',
      limit: '21',
    });
    expect(find('ashby_application_links', 'candidate_id')!.query).toEqual({
      select: 'candidate_id,external_application_id,external_candidate_id,terminal_state,job_mapping_id',
      provider: 'eq.ashby',
      candidate_id: `in.(${C1})`,
      order: 'external_application_id.asc',
      limit: '101',
    });
    expect(find('data_subject_requests', 'candidate_id')!.query).toEqual({
      select: 'candidate_id',
      candidate_id: `in.(${C1})`,
      request_type: 'in.(correct,restrict,delete)',
      request_status: 'in.(pending,in_progress,fulfilled)',
      limit: '101',
    });
    expect(find('ashby_job_mappings', 'id')!.query).toEqual({ select: 'id,status,archived_at', id: `in.(${M1})` });
  });
});

// ── The rows ─────────────────────────────────────────────────────────────────

describe('the rows (D-S04-18)', () => {
  it('matchedBy is email, phone or both by the side each candidate came back on', async () => {
    const { db } = fakeDb(world({
      email: [candidateRow(C1), candidateRow(C2)],
      phone: [candidateRow(C2), candidateRow(C3)],
      links: [
        linkRow(),
        linkRow({ candidate_id: C2, external_application_id: APP2 }),
        linkRow({ candidate_id: C3, external_application_id: APP3, external_candidate_id: ASHBY2 }),
      ],
      mappings: [mappingRow()],
    }));
    const out = await findR1PublicLocalRows(db, TYPED);
    expect(out).toEqual([
      localRow({ matchedBy: 'email' }),
      localRow({ candidateId: C2, applicationId: APP2 }),
      localRow({ candidateId: C3, matchedBy: 'phone', applicationId: APP3, ashbyCandidateId: ASHBY2 }),
    ]);
  });

  it('one row per link, sorted by application id; Ashby ids kept verbatim', async () => {
    const verbatim = 'Ab.C-12_x:Y';
    const { db } = fakeDb(world({
      ...ONE_PERSON,
      links: [
        linkRow({ external_application_id: APP2, external_candidate_id: verbatim }),
        linkRow({ external_application_id: APP1, external_candidate_id: null }),
      ],
    }));
    const out = await findR1PublicLocalRows(db, TYPED);
    expect(out).toEqual([
      localRow({ applicationId: APP1, ashbyCandidateId: null }),
      localRow({ applicationId: APP2, ashbyCandidateId: verbatim }),
    ]);
  });

  it('a candidate with no link is one fail-closed row', async () => {
    const { db } = fakeDb(world({ email: [candidateRow(C1)] }));
    expect(await findR1PublicLocalRows(db, TYPED)).toEqual([
      localRow({ matchedBy: 'email', applicationId: null, ashbyCandidateId: null, linkTerminal: true, mappingEnabled: false }),
    ]);
  });

  type MappingCase = [name: string, jobMappingId: string | null, mappings: Row[], enabled: boolean];
  it.each<MappingCase>([
    ['enabled and not archived', M1, [mappingRow()], true],
    ['paused', M1, [mappingRow({ status: 'paused' })], false],
    ['drift', M1, [mappingRow({ status: 'drift' })], false],
    ['archived (paused)', M1, [mappingRow({ status: 'paused', archived_at: NOW })], false],
    ['enabled but archived (never true by CHECK; still off)', M1, [mappingRow({ archived_at: NOW })], false],
    ['missing (deleted between the reads)', M1, [], false],
    ['another mapping enabled, this one not read', M2, [mappingRow()], false],
    ['no mapping on the link', null, [mappingRow()], false],
  ])('mappingEnabled: %s', async (_name, jobMappingId, mappings, enabled) => {
    const { db } = fakeDb(world({ ...ONE_PERSON, links: [linkRow({ job_mapping_id: jobMappingId })], mappings }));
    const [only] = await findR1PublicLocalRows(db, TYPED);
    expect(only!.mappingEnabled).toBe(enabled);
  });

  it.each<[terminalState: string | null, terminal: boolean]>([
    [null, false],
    ['withdrawn', true],
    ['deleted', true],
    ['manual_stage_cancel', true],
  ])('linkTerminal for terminal_state %s', async (terminalState, terminal) => {
    const { db } = fakeDb(world({ ...ONE_PERSON, links: [linkRow({ terminal_state: terminalState })] }));
    const [only] = await findR1PublicLocalRows(db, TYPED);
    expect(only!.linkTerminal).toBe(terminal);
  });

  it('a DSAR hold marks every row of that candidate and of no other', async () => {
    const { db } = fakeDb(world({
      email: [candidateRow(C1), candidateRow(C2)],
      links: [linkRow(), linkRow({ external_application_id: APP3 }), linkRow({ candidate_id: C2, external_application_id: APP2 })],
      holds: [holdRow(C1)],
      mappings: [mappingRow()],
    }));
    const out = await findR1PublicLocalRows(db, { email: EMAIL, phone: null });
    expect(out.map((row) => [row.candidateId, row.applicationId, row.dsarHold])).toEqual([
      [C1, APP1, true],
      [C1, APP3, true],
      [C2, APP2, false],
    ]);
  });

  it('a full DSAR answer (101 rows) holds every candidate of the batch (fail closed); 100 does not', async () => {
    const base: World = {
      email: [candidateRow(C1), candidateRow(C2)],
      links: [linkRow(), linkRow({ candidate_id: C2, external_application_id: APP2 })],
      mappings: [mappingRow()],
    };
    const full = fakeDb(world({ ...base, holds: Array.from({ length: 101 }, () => holdRow(C1)) }));
    expect((await findR1PublicLocalRows(full.db, TYPED)).map((row) => row.dsarHold)).toEqual([true, true]);
    const short = fakeDb(world({ ...base, holds: Array.from({ length: 100 }, () => holdRow(C1)) }));
    expect((await findR1PublicLocalRows(short.db, TYPED)).map((row) => row.dsarHold)).toEqual([true, false]);
  });

  it('decisionBlocked is decision_use_blocked_at set, on either side (fail closed)', async () => {
    const { db } = fakeDb(world({
      email: [candidateRow(C1, NOW), candidateRow(C2)],
      phone: [candidateRow(C1), candidateRow(C2, NOW)],
      links: [linkRow(), linkRow({ candidate_id: C2, external_application_id: APP2 })],
      mappings: [mappingRow()],
    }));
    const out = await findR1PublicLocalRows(db, TYPED);
    expect(out.map((row) => [row.candidateId, row.decisionBlocked])).toEqual([[C1, true], [C2, true]]);
    const clear = fakeDb(world(ONE_PERSON));
    expect((await findR1PublicLocalRows(clear.db, TYPED))[0]!.decisionBlocked).toBe(false);
  });

  it('lower-cases and sorts candidate ids, and freezes the rows and the list', async () => {
    const { db } = fakeDb(world({
      email: [candidateRow(C3.toUpperCase()), candidateRow(C1.toUpperCase())],
      links: [linkRow({ candidate_id: C3.toUpperCase(), external_application_id: APP3 }), linkRow({ candidate_id: C1 })],
      mappings: [mappingRow({ id: M1.toUpperCase() })],
    }));
    const out = await findR1PublicLocalRows(db, { email: EMAIL, phone: null });
    expect(out.map((row) => [row.candidateId, row.applicationId, row.mappingEnabled])).toEqual([
      [C1, APP1, true],
      [C3, APP3, true],
    ]);
    expect(Object.isFrozen(out)).toBe(true);
    for (const row of out) expect(Object.isFrozen(row)).toBe(true);
  });

  it('every row has exactly the eight fields, and no typed value is in any of them', async () => {
    const { db } = fakeDb(world({
      email: [candidateRow(C1), candidateRow(C2)],
      phone: [candidateRow(C1)],
      links: [linkRow(), linkRow({ external_application_id: APP2, terminal_state: 'withdrawn' })],
      holds: [holdRow(C2)],
      mappings: [mappingRow()],
    }));
    const out = await findR1PublicLocalRows(db, { email: 'first_last%x\\y@example.com', phone: PHONE });
    expect(out).toHaveLength(3);
    for (const row of out) expect(Object.keys(row)).toEqual([...ROW_KEYS]);
    const json = JSON.stringify(out);
    for (const fragment of TYPED_FRAGMENTS) expect(json, fragment).not.toContain(fragment);
  });
});

// ── Bounds ───────────────────────────────────────────────────────────────────

describe('bounds: at most 21 rows, and the 21st means "more than 20"', () => {
  it('21 candidates on one side: 21 rows, and the decision is ambiguous', async () => {
    const people = Array.from({ length: 25 }, (_, i) => candidateRow(cand(100 + i)));
    const { db } = fakeDb(world({ email: people }));
    const out = await findR1PublicLocalRows(db, { email: EMAIL, phone: null });
    expect(out).toHaveLength(21);
    expect(decideR1PublicLocal(out)).toEqual({ kind: 'not_found', reason: 'ambiguous' });
  });

  it('20 candidates: 20 rows, and the count alone is not a refusal', async () => {
    const people = Array.from({ length: 20 }, (_, i) => candidateRow(cand(100 + i)));
    const { db } = fakeDb(world({ email: people }));
    const out = await findR1PublicLocalRows(db, { email: EMAIL, phone: null });
    expect(out).toHaveLength(20);
    expect(decideR1PublicLocal(out)).toEqual({ kind: 'not_found', reason: 'no_bookable_application' });
  });

  it('101 links (the read limit) of one candidate: 21 rows, and the decision is ambiguous', async () => {
    const links = Array.from({ length: 150 }, (_, i) => linkRow({ external_application_id: app(i + 1) }));
    const { db, queries } = fakeDb(world({ ...ONE_PERSON, links }));
    const out = await findR1PublicLocalRows(db, TYPED);
    expect(out).toHaveLength(21);
    expect(out.map((row) => row.applicationId)).toEqual(Array.from({ length: 21 }, (_, i) => app(i + 1)));
    expect(limitOf(queries.find((query) => query.table === 'ashby_application_links')!)).toBe(101);
    expect(decideR1PublicLocal(out)).toEqual({ kind: 'not_found', reason: 'ambiguous' });
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

describe('failures: every one is r1_meet_db_error and nothing else', () => {
  type Read = [name: string, table: string, input: { email: string | null; phone: string | null }, side?: 'email' | 'phone'];
  const READS: Read[] = [
    ['candidates by email', 'candidates', { email: EMAIL, phone: null }, 'email'],
    ['candidates by phone', 'candidates', { email: null, phone: PHONE }, 'phone'],
    ['candidates by phone, the email side fine', 'candidates', TYPED, 'phone'],
    ['links', 'ashby_application_links', TYPED],
    ['DSAR holds', 'data_subject_requests', TYPED],
    ['mappings', 'ashby_job_mappings', TYPED],
  ];

  /** ONE_PERSON, with `bad` answering the chosen read. */
  function failingAt(table: string, bad: Answer | Error, side?: 'email' | 'phone'): Record<string, Responder> {
    const answers = world(ONE_PERSON);
    const good = answers[table] as (query: Query) => Answer;
    answers[table] = (query) => {
      if (side !== undefined && (isEmailSide(query) ? 'email' : 'phone') !== side) return good(query);
      return bad;
    };
    return answers;
  }

  it.each(READS)('%s: a DB error', async (name, table, input, side) => {
    await expectDbError(findR1PublicLocalRows(fakeDb(failingAt(table, failure(), side)).db, input), name);
  });

  it.each(READS)('%s: a rejected call', async (name, table, input, side) => {
    const rejected = new Error(`connect ECONNREFUSED for ${EMAIL} ${PHONE}`);
    await expectDbError(findR1PublicLocalRows(fakeDb(failingAt(table, rejected, side)).db, input), name);
  });

  it.each(READS)('%s: a throwing builder', async (name, table, input) => {
    await expectDbError(findR1PublicLocalRows(fakeDb(world(ONE_PERSON), { throwAt: table }).db, input), name);
  });

  const withoutTerminalState = (): Row => {
    const row = linkRow();
    delete row.terminal_state;
    return row;
  };

  // The table answers these rows as they are (no filter), so a row outside the filter reaches the store.
  type Drift = [name: string, table: string, answer: unknown[]];
  it.each<Drift>([
    ['a candidate id that is not a UUID', 'candidates', [candidateRow('candidate-1')]],
    ['a candidate id that is a number', 'candidates', [{ id: 7, decision_use_blocked_at: null }]],
    ['decision_use_blocked_at that is a number', 'candidates', [{ id: C1, decision_use_blocked_at: 1 }]],
    ['decision_use_blocked_at that is empty', 'candidates', [candidateRow(C1, '')]],
    ['decision_use_blocked_at missing', 'candidates', [{ id: C1 }]],
    ['a candidate row that is null', 'candidates', [null]],
    ['a candidate row that is an array', 'candidates', [[C1]]],
    ['a link candidate id that is not a UUID', 'ashby_application_links', [linkRow({ candidate_id: 'x' })]],
    ['a link with no candidate', 'ashby_application_links', [linkRow({ candidate_id: null })]],
    ['a link outside the candidate filter', 'ashby_application_links', [linkRow(), linkRow({ candidate_id: C2 })]],
    ['an application id with a space', 'ashby_application_links', [linkRow({ external_application_id: 'app 1' })]],
    ['an empty application id', 'ashby_application_links', [linkRow({ external_application_id: '' })]],
    ['an application id of 257 characters', 'ashby_application_links', [linkRow({ external_application_id: 'a'.repeat(257) })]],
    ['a null application id', 'ashby_application_links', [linkRow({ external_application_id: null })]],
    ['an Ashby candidate id that is a number', 'ashby_application_links', [linkRow({ external_candidate_id: 42 })]],
    ['a terminal state outside the CHECK', 'ashby_application_links', [linkRow({ terminal_state: 'archived' })]],
    ['a terminal state missing', 'ashby_application_links', [withoutTerminalState()]],
    ['a job mapping id that is not a UUID', 'ashby_application_links', [linkRow({ job_mapping_id: 'mapping-1' })]],
    ['a DSAR candidate id that is not a UUID', 'data_subject_requests', [holdRow('nope')]],
    ['a DSAR row outside the candidate filter', 'data_subject_requests', [holdRow(C2)]],
    ['a mapping id that is not a UUID', 'ashby_job_mappings', [mappingRow({ id: 'm1' })]],
    ['a mapping outside the id filter', 'ashby_job_mappings', [mappingRow(), mappingRow({ id: M2 })]],
    ['a mapping status outside the CHECK', 'ashby_job_mappings', [mappingRow({ status: 'disabled' })]],
    ['a mapping status missing', 'ashby_job_mappings', [{ id: M1, archived_at: null }]],
    ['archived_at that is a number', 'ashby_job_mappings', [mappingRow({ archived_at: 0 })]],
  ])('a row off the schema: %s', async (name, table, answer) => {
    const answers = world(ONE_PERSON);
    answers[table] = () => rows(answer);
    await expectDbError(findR1PublicLocalRows(fakeDb(answers).db, TYPED), name);
  });

  it('the same answers in shape pass (the drift table has a working control)', async () => {
    expect(await findR1PublicLocalRows(fakeDb(world(ONE_PERSON)).db, TYPED)).toEqual([localRow()]);
  });

  it.each<[name: string, data: unknown]>([
    ['an object', {}],
    ['null', null],
    ['a string', 'rows'],
  ])('an answer that is not a list (%s) is drift on every read', async (name, data) => {
    for (const [label, table, input, side] of READS) {
      await expectDbError(findR1PublicLocalRows(fakeDb(failingAt(table, rows(data), side)).db, input), `${label}: ${name}`);
    }
  });
});

// ── Parity with the migrations ───────────────────────────────────────────────

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

  it('every terminal state and mapping status the 0029 CHECKs allow is read without drift', async () => {
    const ashby = migration('0029');
    const terminal = quoted(/check \(terminal_state is null or terminal_state in \(([^)]*)\)\)/.exec(ashby)![1]!);
    const statuses = quoted(/constraint chk_ashby_job_mappings_status check \(status in \(([^)]*)\)\)/.exec(ashby)![1]!);
    expect(terminal).toEqual(['withdrawn', 'deleted', 'manual_stage_cancel']);
    expect(statuses).toEqual(['paused', 'enabled', 'drift']);
    for (const state of terminal) {
      const { db } = fakeDb(world({ ...ONE_PERSON, links: [linkRow({ terminal_state: state })] }));
      expect((await findR1PublicLocalRows(db, TYPED))[0]!.linkTerminal, state).toBe(true);
    }
    for (const status of statuses) {
      const { db } = fakeDb(world({ ...ONE_PERSON, mappings: [mappingRow({ status })] }));
      expect((await findR1PublicLocalRows(db, TYPED))[0]!.mappingEnabled, status).toBe(status === 'enabled');
    }
  });

  it('every column the store selects or filters on exists in the migration that made it', async () => {
    const { db, queries } = fakeDb(world(ONE_PERSON));
    await findR1PublicLocalRows(db, TYPED);
    const named: Record<string, Set<string>> = {};
    for (const query of queries) {
      const columns = (named[query.table] ??= new Set());
      for (const [op, ...args] of query.calls) {
        if (op === 'select') for (const column of String(args[0]).split(',')) columns.add(column);
        else if (op !== 'limit') columns.add(String(args[0]));
      }
    }
    const expected: Record<string, Record<string, string>> = {
      candidates: { id: '0001', decision_use_blocked_at: '0015', email: '0001', phone_e164: '0001' },
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
    expect(Object.fromEntries(Object.entries(named).map(([table, set]) => [table, [...set].sort()]))).toEqual(
      Object.fromEntries(Object.entries(expected).map(([table, columns]) => [table, Object.keys(columns).sort()])),
    );
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
});
