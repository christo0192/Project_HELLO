/**
 * M034 S09 T3: the database port of Dex's scorecard feedback (lib/r1/meet/feedback-store.ts).
 *
 * Pinned here, with a recording query double (and, for the JSON-path alias, the update and the key
 * list, as the URL the real Supabase client builds):
 *  - every read's exact table, columns and filters: never `raw` of an assessment, only the decision
 *    string of a consent's `proof`, receipts only of source `ashby`;
 *  - the two receipt compare-and-sets: `processed` from recorded, enqueued or failed; `failed` from
 *    recorded or enqueued only;
 *  - the receipt key: `ashby-schedule:feedback:<booking>:<assessment>`, lower-cased, 97 characters,
 *    inside the 0142 key CHECK and source space, and NEVER of the S03 schedule-key shape
 *    `ashby-schedule:<uuid>:`, so S06's newer-delivery read can never see it;
 *  - `recordFeedback` is one `r1_meet_record_receipt` call whose payload has exactly three keys;
 *  - every failure is `r1_meet_db_error`, and the message is that code and nothing else.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { supabase } from '../lib/supabase.js';
import {
  R1_MEET_FEEDBACK_ASSESSMENT_COLUMNS,
  R1_MEET_FEEDBACK_EVENT_TYPE,
  R1_MEET_FEEDBACK_KEY_BATCH,
  R1_MEET_FEEDBACK_KEY_PREFIX,
  createR1MeetFeedbackStore,
  r1MeetFeedbackReceiptKey,
} from '../lib/r1/meet/feedback-store.js';
import { R1MeetJobError } from '../lib/r1/meet/jobs.js';

// ── The recording double ─────────────────────────────────────────────────────

type Answer = { data: unknown; error: unknown };
type Call = [op: string, ...args: unknown[]];

const CHAIN = ['select', 'update', 'eq', 'neq', 'in', 'not', 'lt', 'lte', 'gt', 'gte', 'like', 'order', 'limit'] as const;

/** Records every builder call and answers `answer` (an Error rejects; 'throw' throws at the first call). */
function fakeDb(answer: Answer | Error | 'throw' | ((call: number) => Answer) = { data: null, error: null }) {
  const calls: Call[] = [];
  let queries = 0;
  const settle = async (): Promise<Answer> => {
    queries += 1;
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer(queries);
    return answer as Answer;
  };
  const builder: Record<string, unknown> = {
    maybeSingle: () => {
      calls.push(['maybeSingle']);
      return settle();
    },
    then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) => settle().then(resolve, reject),
  };
  for (const op of CHAIN) {
    builder[op] = (...args: unknown[]) => {
      calls.push([op, ...args]);
      return builder;
    };
  }
  const db = {
    from: (table: string) => {
      if (answer === 'throw') throw new Error('driver detail that must not leak');
      calls.push(['from', table]);
      return builder;
    },
    rpc: (name: string, args: unknown) => {
      if (answer === 'throw') throw new Error('driver detail that must not leak');
      calls.push(['rpc', name, args]);
      return settle();
    },
  };
  return { store: createR1MeetFeedbackStore(db as unknown as typeof supabase), calls };
}

const rows = (data: unknown): Answer => ({ data, error: null });

async function expectCode(promise: Promise<unknown>, code: string, label?: string): Promise<void> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected ${code}, got ${JSON.stringify(value)} (${label ?? ''})`);
    },
    (reason: unknown) => reason,
  );
  expect(error, label).toBeInstanceOf(R1MeetJobError);
  expect((error as R1MeetJobError).code, label).toBe(code);
  expect((error as Error).message, label).toBe(code);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const id = (n: string): string => `7f000000-0000-4000-8000-0000000000${n}`;
const BOOKING = id('d1');
const ROUND = id('d2');
const SESSION = id('d4');
const ASSESSMENT = id('e1');
const CANDIDATE = id('c2');
const RECEIPT = id('c1');
const NOW = '2030-01-01T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const KEY = `ashby-schedule:feedback:${BOOKING}:${ASSESSMENT}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// ── The key ──────────────────────────────────────────────────────────────────

describe('r1MeetFeedbackReceiptKey (D-S09-2)', () => {
  it('is ashby-schedule:feedback:<booking>:<assessment>, lower-cased, 97 characters', () => {
    const key = r1MeetFeedbackReceiptKey(BOOKING.toUpperCase(), ASSESSMENT.toUpperCase());
    expect(key).toBe(KEY);
    expect(key).toHaveLength(97);
    expect(key.startsWith(R1_MEET_FEEDBACK_KEY_PREFIX)).toBe(true);
    expect(R1_MEET_FEEDBACK_KEY_PREFIX).toBe('ashby-schedule:feedback:');
    expect(R1_MEET_FEEDBACK_EVENT_TYPE).toBe('scorecard_feedback');
  });

  it('fits the 0142 receipt CHECKs: key characters and length, and the ashby source space', () => {
    const keyCheck = /constraint chk_r1_meet_receipts_dedupe_key check \(\s*char_length\(dedupe_key\) between 1 and 256 and dedupe_key ~ '([^']+)'/.exec(migration);
    expect(keyCheck, 'the 0142 key CHECK').not.toBeNull();
    expect(KEY).toMatch(new RegExp(keyCheck![1]!));
    expect(KEY.length).toBeLessThanOrEqual(256);
    expect(migration).toContain("(source = 'ashby') = (dedupe_key like 'ashby-schedule:%')");
    expect(KEY.startsWith('ashby-schedule:')).toBe(true);
    // The event type CHECK too.
    const typeCheck = /constraint chk_r1_meet_receipts_event_type check \(event_type ~ '([^']+)'\)/.exec(migration);
    expect(R1_MEET_FEEDBACK_EVENT_TYPE).toMatch(new RegExp(typeCheck![1]!));
  });

  it('is never of the S03 schedule-key shape, so the S06 newer-delivery read never matches it', () => {
    for (const key of [KEY, r1MeetFeedbackReceiptKey(id('ff'), id('fe'))]) {
      expect(key).not.toMatch(/^ashby-schedule:[0-9a-f-]{36}:/);
      // S06 reads `like 'ashby-schedule:<schedule uuid>:%'`: the second segment here is the literal.
      expect(key.split(':')[1]).toBe('feedback');
    }
  });

  it.each([
    ['a non-UUID booking', 'not-a-uuid', ASSESSMENT],
    ['a non-UUID assessment', BOOKING, `${ASSESSMENT}x`],
    ['an empty id', '', ASSESSMENT],
    ['a number', 7 as unknown as string, ASSESSMENT],
  ])('throws a fixed TypeError for %s', (_label, booking, assessment) => {
    expect(() => r1MeetFeedbackReceiptKey(booking, assessment)).toThrow(new TypeError('r1_meet_feedback_invalid_key'));
  });
});

// ── The receipt ──────────────────────────────────────────────────────────────

describe('receipt and settleReceipt', () => {
  it('reads one ashby receipt by its key', async () => {
    const { store, calls } = fakeDb(rows({ id: RECEIPT.toUpperCase(), outcome: 'enqueued' }));
    expect(await store.receipt(KEY)).toEqual({ id: RECEIPT, outcome: 'enqueued' });
    expect(calls).toEqual([
      ['from', 'r1_meet_receipts'],
      ['select', 'id,outcome'],
      ['eq', 'source', 'ashby'],
      ['eq', 'dedupe_key', KEY],
      ['maybeSingle'],
    ]);
  });

  it('answers null for no receipt, and refuses a drifted row', async () => {
    expect(await fakeDb(rows(null)).store.receipt(KEY)).toBeNull();
    await expectCode(fakeDb(rows({ id: RECEIPT, outcome: 'done' })).store.receipt(KEY), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({ id: 'r-1', outcome: 'processed' })).store.receipt(KEY), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({ outcome: 'processed' })).store.receipt(KEY), 'r1_meet_db_error');
    await expectCode(fakeDb(rows([{ id: RECEIPT, outcome: 'processed' }])).store.receipt(KEY), 'r1_meet_db_error');
  });

  it('settles processed from recorded, enqueued or failed (a re-post ends a failed receipt)', async () => {
    const { store, calls } = fakeDb(rows([{ id: RECEIPT }]));
    expect(await store.settleReceipt(RECEIPT, 'processed', NOW)).toBe(true);
    expect(calls).toEqual([
      ['from', 'r1_meet_receipts'],
      ['update', { outcome: 'processed', processed_at: NOW }],
      ['eq', 'id', RECEIPT],
      ['eq', 'source', 'ashby'],
      ['in', 'outcome', ['recorded', 'enqueued', 'failed']],
      ['select', 'id'],
    ]);
  });

  it('settles failed from recorded or enqueued only (a posted card is never marked failed)', async () => {
    const { store, calls } = fakeDb(rows([]));
    expect(await store.settleReceipt(RECEIPT, 'failed', NOW)).toBe(false);
    expect(calls).toContainEqual(['update', { outcome: 'failed', processed_at: NOW }]);
    expect(calls).toContainEqual(['in', 'outcome', ['recorded', 'enqueued']]);
  });

  it('refuses any other outcome before a query', async () => {
    const { store, calls } = fakeDb(rows([]));
    await expect(store.settleReceipt(RECEIPT, 'ignored' as never, NOW)).rejects.toThrow(new RangeError('r1_meet_feedback_invalid_outcome'));
    expect(calls).toEqual([]);
  });
});

// ── The round, the assessment, the candidate and the consents ───────────────

describe('round', () => {
  it('reads the candidate, channel and current assessment of one round', async () => {
    const { store, calls } = fakeDb(rows({ id: ROUND, candidate_id: CANDIDATE, channel: 'meet', assessment_id: ASSESSMENT.toUpperCase() }));
    expect(await store.round(ROUND)).toEqual({ id: ROUND, candidateId: CANDIDATE, channel: 'meet', assessmentId: ASSESSMENT });
    expect(calls).toEqual([
      ['from', 'interview_rounds'],
      ['select', 'id,candidate_id,channel,assessment_id'],
      ['eq', 'id', ROUND],
      ['maybeSingle'],
    ]);
  });

  it('a browser round, a round without an assessment, no round; a drifted channel is an error', async () => {
    expect(await fakeDb(rows({ id: ROUND, candidate_id: CANDIDATE, channel: 'browser', assessment_id: null })).store.round(ROUND))
      .toEqual({ id: ROUND, candidateId: CANDIDATE, channel: 'browser', assessmentId: null });
    expect(await fakeDb(rows(null)).store.round(ROUND)).toBeNull();
    await expectCode(fakeDb(rows({ id: ROUND, candidate_id: CANDIDATE, channel: 'phone', assessment_id: null })).store.round(ROUND), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({ id: ROUND, candidate_id: CANDIDATE, channel: 'meet' })).store.round(ROUND), 'r1_meet_db_error');
  });
});

describe('assessment', () => {
  const ROW = {
    id: ASSESSMENT,
    session_id: SESSION,
    schema_version: 2,
    recommendation: 'hold',
    overall_score: '55.00',
    weighted_score_5: 2.65,
    score_scale_max: 4,
    metric_results: [{ metric: { key: 'k', name: 'K' }, score: 3, evidenceStatus: 'scored' }],
  };

  it('selects the card inputs only: never raw', async () => {
    expect(R1_MEET_FEEDBACK_ASSESSMENT_COLUMNS).toBe(
      'id,session_id,schema_version,recommendation,overall_score,weighted_score_5,score_scale_max,metric_results',
    );
    expect(R1_MEET_FEEDBACK_ASSESSMENT_COLUMNS).not.toMatch(/raw|evidence|transcript/);
    const { store, calls } = fakeDb(rows(ROW));
    const read = await store.assessment(ASSESSMENT);
    expect(calls).toEqual([
      ['from', 'assessments'],
      ['select', R1_MEET_FEEDBACK_ASSESSMENT_COLUMNS],
      ['eq', 'id', ASSESSMENT],
      ['maybeSingle'],
    ]);
    expect(read).toEqual({
      id: ASSESSMENT,
      sessionId: SESSION,
      row: {
        schema_version: 2,
        recommendation: 'hold',
        overall_score: '55.00',
        weighted_score_5: 2.65,
        score_scale_max: 4,
        metric_results: ROW.metric_results,
      },
    });
  });

  it('carries on exactly the six card columns, even if the database answers more', async () => {
    const read = await fakeDb(rows({ ...ROW, raw: { transcript: 'SENTINEL' }, candidate_name: 'SENTINEL' })).store.assessment(ASSESSMENT);
    expect(Object.keys(read!.row).sort()).toEqual(
      ['metric_results', 'overall_score', 'recommendation', 'schema_version', 'score_scale_max', 'weighted_score_5'],
    );
    expect(JSON.stringify(read)).not.toContain('SENTINEL');
  });

  it('a null session and null scores are values; an absent column or a bad id is drift', async () => {
    const nulls = await fakeDb(rows({ ...ROW, session_id: null, recommendation: null, weighted_score_5: null })).store.assessment(ASSESSMENT);
    expect(nulls).toMatchObject({ sessionId: null, row: { recommendation: null, weighted_score_5: null } });
    expect(await fakeDb(rows(null)).store.assessment(ASSESSMENT)).toBeNull();
    const { metric_results: _dropped, ...withoutMetrics } = ROW;
    await expectCode(fakeDb(rows(withoutMetrics)).store.assessment(ASSESSMENT), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({ ...ROW, id: 'nope' })).store.assessment(ASSESSMENT), 'r1_meet_db_error');
  });
});

describe('decisionUseBlocked', () => {
  it('reads the candidate block; an open appeal blocks, and a candidate that cannot be found blocks too', async () => {
    const open = fakeDb(rows({ id: CANDIDATE, decision_use_blocked_at: null }));
    expect(await open.store.decisionUseBlocked(CANDIDATE)).toBe(false);
    expect(open.calls).toEqual([
      ['from', 'candidates'],
      ['select', 'id,decision_use_blocked_at'],
      ['eq', 'id', CANDIDATE],
      ['maybeSingle'],
    ]);
    expect(await fakeDb(rows({ id: CANDIDATE, decision_use_blocked_at: NOW })).store.decisionUseBlocked(CANDIDATE)).toBe(true);
    expect(await fakeDb(rows(null)).store.decisionUseBlocked(CANDIDATE)).toBe(true);
    await expectCode(fakeDb(rows({ id: CANDIDATE })).store.decisionUseBlocked(CANDIDATE), 'r1_meet_db_error');
  });
});

describe('consentWithdrawn', () => {
  it('reads only the withdrawn consents and only the decision string of proof', async () => {
    const { store, calls } = fakeDb(rows([]));
    expect(await store.consentWithdrawn(ROUND)).toBe(false);
    expect(calls).toEqual([
      ['from', 'interview_round_consents'],
      ['select', 'withdrawn_at,decision:proof->>decision'],
      ['eq', 'round_id', ROUND],
      ['not', 'withdrawn_at', 'is', null],
    ]);
  });

  it.each([
    [[{ withdrawn_at: NOW, decision: 'withdrawn' }], true],
    [[{ withdrawn_at: NOW, decision: 'declined' }], true],
    [[{ withdrawn_at: NOW, decision: 'superseded' }, { withdrawn_at: NOW, decision: 'declined' }], true],
    [[{ withdrawn_at: NOW, decision: 'superseded' }], false],
    [[{ withdrawn_at: NOW, decision: null }], false],
    [[{ withdrawn_at: NOW, decision: 'WITHDRAWN' }], false],
  ])('%j is a withdrawal: %s (a superseded consent is not)', async (data, expected) => {
    expect(await fakeDb(rows(data)).store.consentWithdrawn(ROUND)).toBe(expected);
  });

  it('a row without the decision column is drift', async () => {
    await expectCode(fakeDb(rows([{ withdrawn_at: NOW }])).store.consentWithdrawn(ROUND), 'r1_meet_db_error');
    await expectCode(fakeDb(rows(null)).store.consentWithdrawn(ROUND), 'r1_meet_db_error');
  });
});

// ── recordFeedback ───────────────────────────────────────────────────────────

describe('recordFeedback (D-S09-2, D-S09-8)', () => {
  it('is one r1_meet_record_receipt call; the payload is exactly the kind and the two ids', async () => {
    const answer = { status: 'inserted', id: RECEIPT, outcome: 'enqueued', enqueued: true, work_pending: true, booking_linked: true };
    const { store, calls } = fakeDb(rows(answer));
    expect(await store.recordFeedback(BOOKING.toUpperCase(), ASSESSMENT.toUpperCase(), NOW_MS)).toEqual({
      status: 'inserted',
      id: RECEIPT,
      outcome: 'enqueued',
      enqueued: true,
      workPending: true,
      bookingLinked: true,
    });
    expect(calls).toHaveLength(1);
    const [op, name, args] = calls[0]!;
    expect([op, name]).toEqual(['rpc', 'r1_meet_record_receipt']);
    expect(args).toStrictEqual({
      p_source: 'ashby',
      p_dedupe_key: KEY,
      p_event_type: 'scorecard_feedback',
      p_booking_id: BOOKING,
      p_enqueue: true,
      p_payload: { kind: 'scorecard_feedback', booking_id: BOOKING, assessment_id: ASSESSMENT },
      p_now: NOW,
    });
    expect(Object.keys((args as { p_payload: object }).p_payload)).toHaveLength(3);
    // The RPC declares these parameters (0142 §18).
    for (const parameter of Object.keys(args as object)) expect(migration).toContain(`  ${parameter} `);
  });

  it('answers a refusal as it is (the caller decides), and a duplicate after a terminal outcome', async () => {
    expect(await fakeDb(rows({ status: 'invalid_dedupe_key' })).store.recordFeedback(BOOKING, ASSESSMENT, NOW_MS))
      .toEqual({ status: 'refused', reason: 'invalid_dedupe_key' });
    expect(await fakeDb(rows({ status: 'duplicate', id: RECEIPT, outcome: 'processed', enqueued: false, work_pending: true, booking_linked: true }))
      .store.recordFeedback(BOOKING, ASSESSMENT, NOW_MS)).toMatchObject({ status: 'duplicate', outcome: 'processed', enqueued: false });
  });

  it('an RPC error, a rejected call, an unknown answer or a bad clock is r1_meet_db_error', async () => {
    await expectCode(fakeDb({ data: null, error: { message: 'boom' } }).store.recordFeedback(BOOKING, ASSESSMENT, NOW_MS), 'r1_meet_db_error');
    await expectCode(fakeDb(new Error('socket hang up at 10.0.0.1')).store.recordFeedback(BOOKING, ASSESSMENT, NOW_MS), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({ status: 'weird' })).store.recordFeedback(BOOKING, ASSESSMENT, NOW_MS), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({})).store.recordFeedback(BOOKING, ASSESSMENT, Number.NaN), 'r1_meet_db_error');
  });

  it('a non-UUID id throws the fixed key error before any call', async () => {
    const { store, calls } = fakeDb(rows({}));
    await expect(store.recordFeedback('nope', ASSESSMENT, NOW_MS)).rejects.toThrow(new TypeError('r1_meet_feedback_invalid_key'));
    expect(calls).toEqual([]);
  });
});

// ── The re-drive reads (S09 T4) ──────────────────────────────────────────────

describe('the re-drive reads', () => {
  it('listRecentCompleted: completed bookings in the start window, newest first, limited', async () => {
    const { store, calls } = fakeDb(rows([
      { id: BOOKING.toUpperCase(), round_id: ROUND, session_id: SESSION },
      { id: id('d9'), round_id: null, session_id: null },
    ]));
    const from = '2029-12-31T08:00:00.000Z';
    const to = '2030-01-01T09:40:00.000Z';
    expect(await store.listRecentCompleted({ startAfter: from, startBefore: to, limit: 10 })).toEqual([
      { id: BOOKING, roundId: ROUND, sessionId: SESSION },
      { id: id('d9'), roundId: null, sessionId: null },
    ]);
    expect(calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', 'id,round_id,session_id'],
      ['eq', 'status', 'completed'],
      ['gte', 'start_at', from],
      ['lt', 'start_at', to],
      ['order', 'start_at', { ascending: false }],
      ['limit', 10],
    ]);
  });

  it.each([0, -1, 101, 1.5, Number.NaN])('listRecentCompleted refuses the limit %s before a query', async (limit) => {
    const { store, calls } = fakeDb(rows([]));
    await expect(store.listRecentCompleted({ startAfter: NOW, startBefore: NOW, limit }))
      .rejects.toThrow(new RangeError('r1_meet_feedback_invalid_limit'));
    expect(calls).toEqual([]);
  });

  it('roundAssessmentIds: batches of 100 ids, rounds without an assessment left out', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `7f000000-0000-4000-8000-${(0x1000 + i).toString(16).padStart(12, '0')}`);
    const { store, calls } = fakeDb((query) => rows(query === 1
      ? [{ id: ids[0], assessment_id: ASSESSMENT.toUpperCase() }, { id: ids[1], assessment_id: null }]
      : [{ id: ids[120], assessment_id: id('e2') }]));
    const map = await store.roundAssessmentIds([...ids, ids[0]!]);
    expect([...map.entries()]).toEqual([[ids[0], ASSESSMENT], [ids[120], id('e2')]]);
    const reads = calls.filter((call) => call[0] === 'in');
    expect(reads.map((call) => (call[2] as string[]).length)).toEqual([100, 50]);
    expect(calls.filter((call) => call[0] === 'select')).toEqual([['select', 'id,assessment_id'], ['select', 'id,assessment_id']]);
    expect(reads[0]![1]).toBe('id');
  });

  it('roundAssessmentIds and existingFeedbackKeys read nothing for nothing', async () => {
    const { store, calls } = fakeDb(rows([]));
    expect((await store.roundAssessmentIds([])).size).toBe(0);
    expect((await store.existingFeedbackKeys([])).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('existingFeedbackKeys: ashby receipts by key, in batches of at most 50 keys', async () => {
    expect(R1_MEET_FEEDBACK_KEY_BATCH).toBe(50);
    const keys = Array.from({ length: 60 }, (_, i) => r1MeetFeedbackReceiptKey(BOOKING, `7f000000-0000-4000-8000-${(0x2000 + i).toString(16).padStart(12, '0')}`));
    const { store, calls } = fakeDb((query) => rows(query === 1 ? [{ dedupe_key: keys[3] }] : [{ dedupe_key: keys[55] }]));
    expect([...(await store.existingFeedbackKeys(keys))]).toEqual([keys[3], keys[55]]);
    expect(calls.slice(0, 4)).toEqual([
      ['from', 'r1_meet_receipts'],
      ['select', 'dedupe_key'],
      ['eq', 'source', 'ashby'],
      ['in', 'dedupe_key', keys.slice(0, 50)],
    ]);
    expect(calls.filter((call) => call[0] === 'in').map((call) => (call[2] as string[]).length)).toEqual([50, 10]);
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe('every failure is r1_meet_db_error, with no driver text', () => {
  const methods: Array<[string, (store: ReturnType<typeof createR1MeetFeedbackStore>) => Promise<unknown>]> = [
    ['receipt', (s) => s.receipt(KEY)],
    ['settleReceipt', (s) => s.settleReceipt(RECEIPT, 'processed', NOW)],
    ['round', (s) => s.round(ROUND)],
    ['assessment', (s) => s.assessment(ASSESSMENT)],
    ['decisionUseBlocked', (s) => s.decisionUseBlocked(CANDIDATE)],
    ['consentWithdrawn', (s) => s.consentWithdrawn(ROUND)],
    ['recordFeedback', (s) => s.recordFeedback(BOOKING, ASSESSMENT, NOW_MS)],
    ['listRecentCompleted', (s) => s.listRecentCompleted({ startAfter: NOW, startBefore: NOW, limit: 10 })],
    ['roundAssessmentIds', (s) => s.roundAssessmentIds([ROUND])],
    ['existingFeedbackKeys', (s) => s.existingFeedbackKeys([KEY])],
  ];

  it.each(methods)('%s: a DB error, a rejected call and a throwing builder', async (label, call) => {
    await expectCode(call(fakeDb({ data: null, error: { message: 'relation does not exist' } }).store), 'r1_meet_db_error', `${label} error`);
    await expectCode(call(fakeDb(new Error('connect ECONNREFUSED 10.0.0.1')).store), 'r1_meet_db_error', `${label} reject`);
    await expectCode(call(fakeDb('throw').store), 'r1_meet_db_error', `${label} throw`);
  });

  it('a list read that answers no array is drift', async () => {
    await expectCode(fakeDb(rows(null)).store.settleReceipt(RECEIPT, 'failed', NOW), 'r1_meet_db_error');
    await expectCode(fakeDb(rows({})).store.listRecentCompleted({ startAfter: NOW, startBefore: NOW, limit: 1 }), 'r1_meet_db_error');
    await expectCode(fakeDb(rows(null)).store.existingFeedbackKeys([KEY]), 'r1_meet_db_error');
  });
});

// ── As the real client sends them ────────────────────────────────────────────

describe('the queries as the real Supabase client builds them', () => {
  function realStore(body: string) {
    const requests: Array<{ method: string; table: string; query: Record<string, string>; body: unknown }> = [];
    const client = createClient('https://db.example.test', 'k'.repeat(40), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'screening_v2' },
      global: {
        fetch: async (input: unknown, init?: { method?: string; body?: unknown }) => {
          const url = new URL(String(input));
          requests.push({
            method: init?.method ?? 'GET',
            table: url.pathname.split('/').pop()!,
            query: Object.fromEntries(url.searchParams),
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
          });
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    return { store: createR1MeetFeedbackStore(client as unknown as typeof supabase), requests };
  }

  it('the consent read selects the decision through a JSON path, and filters withdrawn rows', async () => {
    const { store, requests } = realStore(JSON.stringify([{ withdrawn_at: NOW, decision: 'declined' }]));
    expect(await store.consentWithdrawn(ROUND)).toBe(true);
    expect(requests).toEqual([{
      method: 'GET',
      table: 'interview_round_consents',
      query: { select: 'withdrawn_at,decision:proof->>decision', round_id: `eq.${ROUND}`, withdrawn_at: 'not.is.null' },
      body: null,
    }]);
  });

  it('the settle is one PATCH guarded by the outcome set', async () => {
    const { store, requests } = realStore(JSON.stringify([{ id: RECEIPT }]));
    expect(await store.settleReceipt(RECEIPT, 'processed', NOW)).toBe(true);
    expect(requests).toEqual([{
      method: 'PATCH',
      table: 'r1_meet_receipts',
      query: { id: `eq.${RECEIPT}`, source: 'eq.ashby', outcome: 'in.(recorded,enqueued,failed)', select: 'id' },
      body: { outcome: 'processed', processed_at: NOW },
    }]);
  });

  it('the key list reads the keys as sent', async () => {
    const { store, requests } = realStore(JSON.stringify([{ dedupe_key: KEY }]));
    expect([...(await store.existingFeedbackKeys([KEY]))]).toEqual([KEY]);
    expect(requests[0]!.query).toEqual({ select: 'dedupe_key', source: 'eq.ashby', dedupe_key: `in.(${KEY})` });
  });
});
