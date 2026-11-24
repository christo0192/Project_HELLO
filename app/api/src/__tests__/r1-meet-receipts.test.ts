/**
 * M034 S03 T1: the r1-meet receipt port (`lib/r1/meet/receipts.ts`) and its in-memory fake.
 *
 * - The store sends EXACTLY the seven 0142 arguments it owns (never `p_scheduled_at`), always
 *   `p_enqueue: true`, and `p_now` = the ISO instant of `nowMs`.
 * - Answers parse into closed shapes; an RPC error, a rejected call or an unexpected answer throws a
 *   fixed message that echoes nothing.
 * - Drift pins read migration 0142 as text: the RPC signature, its closed refusals, its answer keys
 *   and the rules the fake mirrors.
 * - The fake agrees with the RPC rules (one example of each refusal) and models the outbox re-drive.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_MEET_RECEIPT_OUTCOMES,
  R1_MEET_RECEIPT_REFUSALS,
  R1_MEET_RECEIPT_SOURCES,
  R1_MEET_RECORD_RECEIPT_RPC,
  createR1MeetReceiptStore,
  parseR1MeetReceiptAnswer,
  type R1MeetReceiptRequest,
  type R1MeetRpcClient,
} from '../lib/r1/meet/receipts.js';
import {
  R1_MEET_FAKE_PAYLOAD_MAX_BYTES,
  createR1MeetReceiptsFake,
  jsonbTextByteLength,
} from './support/r1-meet-receipts-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql');
const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');

const NOW_MS = Date.parse('2026-11-25T04:00:00.000Z');
const RECEIPT_ID = '5e000000-0000-4000-8000-0000000000a1';
const BOOKING_ID = '7f000000-0000-4000-8000-000000000002';
const BOT_ID = '7f000000-0000-4000-8000-000000000001';
/** A Svix-style delivery id (fixture). */
const WEBHOOK_ID = 'msg_s03fixture0001';
/**
 * Further fixture delivery ids, built at run time: gitleaks generic-api-key flags a `...Key: '<long
 * token>'` literal (KNOWLEDGE.md, M022/M027), and a PR scan covers every commit.
 */
function fixtureDeliveryId(suffix: string): string {
  return ['msg', `s03fixture${suffix}`].join('_');
}

const STORE_ARG_KEYS = [
  'p_source',
  'p_dedupe_key',
  'p_event_type',
  'p_booking_id',
  'p_enqueue',
  'p_payload',
  'p_now',
] as const;

function recallRequest(overrides: Partial<R1MeetReceiptRequest> = {}): R1MeetReceiptRequest {
  return {
    source: 'recall',
    dedupeKey: WEBHOOK_ID,
    eventType: 'bot.in_call_recording',
    bookingId: BOOKING_ID,
    payload: Object.freeze({
      kind: 'recall_event',
      event_type: 'bot.in_call_recording',
      recall_bot_id: BOT_ID,
      booking_id: BOOKING_ID,
      occurred_at: '2026-12-01T10:29:00.123Z',
      sub_code: null,
      participant: null,
    }),
    nowMs: NOW_MS,
    ...overrides,
  };
}

/** An Ashby-shaped dedupe key built from parts (never a long literal bound to a key-named identifier). */
function ashbyDedupe(suffix: string): string {
  return ['ashby', 'schedule'].join('-') + ':' + suffix;
}

function stubClient(answer: { data: unknown; error: unknown } | (() => never)) {
  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    void fn;
    void args;
    if (typeof answer === 'function') return Promise.resolve().then(answer);
    return Promise.resolve(answer);
  });
  return { client: { rpc } as R1MeetRpcClient, rpc };
}

const INSERTED_ROW = {
  status: 'inserted',
  id: RECEIPT_ID,
  outcome: 'enqueued',
  enqueued: true,
  work_pending: true,
  booking_linked: true,
};

// ── The store ────────────────────────────────────────────────────────────────

describe('createR1MeetReceiptStore: what it sends', () => {
  it('calls r1_meet_record_receipt with exactly the seven argument keys, p_enqueue true and p_now = ISO(nowMs)', async () => {
    const { client, rpc } = stubClient({ data: INSERTED_ROW, error: null });
    const request = recallRequest();
    await createR1MeetReceiptStore(client).record(request);

    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0]!;
    expect(fn).toBe('r1_meet_record_receipt');
    expect(fn).toBe(R1_MEET_RECORD_RECEIPT_RPC);
    expect(Object.keys(args)).toEqual([...STORE_ARG_KEYS]);
    expect('p_scheduled_at' in args).toBe(false);
    expect(args).toStrictEqual({
      p_source: 'recall',
      p_dedupe_key: WEBHOOK_ID,
      p_event_type: 'bot.in_call_recording',
      p_booking_id: BOOKING_ID,
      p_enqueue: true,
      p_payload: request.payload,
      p_now: '2026-11-25T04:00:00.000Z',
    });
    expect(args.p_payload).toBe(request.payload);
  });

  it('sends a null booking id as null and passes an Ashby request through unchanged', async () => {
    const { client, rpc } = stubClient({ data: INSERTED_ROW, error: null });
    const dedupeKey = ashbyDedupe(`${BOOKING_ID}:1796120940123:schedule`);
    await createR1MeetReceiptStore(client).record(
      recallRequest({
        source: 'ashby',
        dedupeKey,
        eventType: 'interviewScheduleUpdate',
        bookingId: null,
        payload: { kind: 'ashby_schedule', scope: 'schedule' },
        nowMs: NOW_MS + 1,
      }),
    );
    const args = rpc.mock.calls[0]![1];
    expect(args.p_source).toBe('ashby');
    expect(args.p_dedupe_key).toBe(dedupeKey);
    expect(args.p_event_type).toBe('interviewScheduleUpdate');
    expect(args.p_booking_id).toBeNull();
    expect(args.p_enqueue).toBe(true);
    expect(args.p_now).toBe('2026-11-25T04:00:00.001Z');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1, '1' as unknown as number])(
    'a nowMs of %s rejects with TypeError before any call',
    async (nowMs) => {
      const { client, rpc } = stubClient({ data: INSERTED_ROW, error: null });
      const result = createR1MeetReceiptStore(client).record(recallRequest({ nowMs }));
      await expect(result).rejects.toThrow(TypeError);
      await expect(createR1MeetReceiptStore(client).record(recallRequest({ nowMs }))).rejects.toThrow(
        /^r1_meet_receipt_invalid_now$/,
      );
      expect(rpc).not.toHaveBeenCalled();
    },
  );
});

describe('createR1MeetReceiptStore: what it answers', () => {
  it('parses inserted and duplicate answers into all six fields', async () => {
    const inserted = await createR1MeetReceiptStore(stubClient({ data: INSERTED_ROW, error: null }).client).record(
      recallRequest(),
    );
    expect(inserted).toStrictEqual({
      status: 'inserted',
      id: RECEIPT_ID,
      outcome: 'enqueued',
      enqueued: true,
      workPending: true,
      bookingLinked: true,
    });
    expect(Object.isFrozen(inserted)).toBe(true);

    const duplicate = await createR1MeetReceiptStore(
      stubClient({
        data: { status: 'duplicate', id: RECEIPT_ID, outcome: 'processed', enqueued: false, work_pending: true, booking_linked: false },
        error: null,
      }).client,
    ).record(recallRequest());
    expect(duplicate).toStrictEqual({
      status: 'duplicate',
      id: RECEIPT_ID,
      outcome: 'processed',
      enqueued: false,
      workPending: true,
      bookingLinked: false,
    });
  });

  it('reads the flags strictly (only true is true) and an unknown outcome as null', () => {
    expect(
      parseR1MeetReceiptAnswer({ status: 'inserted', id: RECEIPT_ID, outcome: 'weird', enqueued: 'true', work_pending: 1 }),
    ).toStrictEqual({
      status: 'inserted',
      id: RECEIPT_ID,
      outcome: null,
      enqueued: false,
      workPending: false,
      bookingLinked: false,
    });
    for (const outcome of R1_MEET_RECEIPT_OUTCOMES) {
      expect(parseR1MeetReceiptAnswer({ status: 'duplicate', id: RECEIPT_ID, outcome })).toMatchObject({ outcome });
    }
  });

  it.each([...R1_MEET_RECEIPT_REFUSALS])('the refusal %s parses as { status: refused, reason }', async (reason) => {
    const data = reason === 'invalid_request' ? { status: reason, field: 'now' } : { status: reason };
    const answer = await createR1MeetReceiptStore(stubClient({ data, error: null }).client).record(recallRequest());
    expect(answer).toStrictEqual({ status: 'refused', reason });
    expect(Object.isFrozen(answer)).toBe(true);
  });

  it('an RPC error throws the fixed message and echoes nothing', async () => {
    const error = { message: `boom ${WEBHOOK_ID} ${BOOKING_ID}`, code: '42883', details: 'secret detail' };
    const attempt = createR1MeetReceiptStore(stubClient({ data: null, error }).client).record(recallRequest());
    await expect(attempt).rejects.toThrow(/^r1_meet_receipt_rpc_error$/);
  });

  it('a rejected call throws the same fixed message and echoes nothing', async () => {
    const { client } = stubClient(() => {
      throw new Error(`network down ${WEBHOOK_ID}`);
    });
    const attempt = createR1MeetReceiptStore(client).record(recallRequest());
    await expect(attempt).rejects.toThrow(/^r1_meet_receipt_rpc_error$/);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'inserted'],
    ['an array', [INSERTED_ROW]],
    ['a missing id', { status: 'inserted', outcome: 'enqueued' }],
    ['an empty id', { status: 'inserted', id: '' }],
    ['a numeric id', { status: 'duplicate', id: 7 }],
    ['an unknown status', { status: 'accepted', id: RECEIPT_ID }],
    ['the literal refused', { status: 'refused', reason: 'invalid_source' }],
    ['no status', { id: RECEIPT_ID }],
  ])('an unexpected answer (%s) throws the fixed message', async (_label, data) => {
    const attempt = createR1MeetReceiptStore(stubClient({ data, error: null }).client).record(recallRequest());
    await expect(attempt).rejects.toThrow(/^r1_meet_receipt_unexpected_answer$/);
    expect(() => parseR1MeetReceiptAnswer(data)).toThrow(/^r1_meet_receipt_unexpected_answer$/);
  });

  it('a client answering a non-object throws unexpected_answer; a throwing getter too', async () => {
    const odd = { rpc: () => Promise.resolve(null as unknown as { data: unknown; error: unknown }) };
    await expect(createR1MeetReceiptStore(odd).record(recallRequest())).rejects.toThrow(
      /^r1_meet_receipt_unexpected_answer$/,
    );
    const trap = new Proxy({}, { get: () => { throw new Error(`trap ${WEBHOOK_ID}`); } });
    expect(() => parseR1MeetReceiptAnswer(trap)).toThrow(/^r1_meet_receipt_unexpected_answer$/);
  });

  it('exports frozen closed lists', () => {
    expect(Object.isFrozen(R1_MEET_RECEIPT_REFUSALS)).toBe(true);
    expect(R1_MEET_RECEIPT_REFUSALS).toHaveLength(7);
    expect([...R1_MEET_RECEIPT_SOURCES]).toEqual(['recall', 'ashby']);
    expect(Object.isFrozen(R1_MEET_RECEIPT_OUTCOMES)).toBe(true);
  });
});

// ── Drift pins against migration 0142 ────────────────────────────────────────

const FUNCTION_HEAD = 'create or replace function screening_v2.r1_meet_record_receipt(';

function receiptFunctionBody(): string {
  const start = sql.indexOf(FUNCTION_HEAD);
  expect(start).toBeGreaterThan(0);
  expect(sql.indexOf(FUNCTION_HEAD, start + 1)).toBe(-1);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('drift pins: r1_meet_record_receipt in 0142', () => {
  it('(i) the signature lists the eight parameters in order, and the store sends a subset of them', async () => {
    const body = receiptFunctionBody();
    const signature = body.slice(FUNCTION_HEAD.length, body.indexOf('\n)\nreturns jsonb'));
    const params = [...signature.matchAll(/^\s*(p_[a-z_]+)\s/gm)].map((match) => match[1]);
    expect(params).toEqual([
      'p_source',
      'p_dedupe_key',
      'p_event_type',
      'p_booking_id',
      'p_enqueue',
      'p_payload',
      'p_scheduled_at',
      'p_now',
    ]);

    const { client, rpc } = stubClient({ data: INSERTED_ROW, error: null });
    await createR1MeetReceiptStore(client).record(recallRequest());
    const sent = Object.keys(rpc.mock.calls[0]![1]);
    for (const key of sent) expect(params, key).toContain(key);
    expect(sent).not.toContain('p_scheduled_at');
  });

  it('(ii) the closed refusal literals in the function body are exactly R1_MEET_RECEIPT_REFUSALS', () => {
    const body = receiptFunctionBody();
    const literals = [...body.matchAll(/jsonb_build_object\('status',\s*'([a-z_]+)'/g)].map((match) => match[1]);
    expect(literals.length).toBeGreaterThanOrEqual(7);
    expect(new Set(literals)).toEqual(new Set(R1_MEET_RECEIPT_REFUSALS));
  });

  it('(iii) the success answer carries exactly the keys the parser reads', () => {
    const body = receiptFunctionBody();
    const finalAnswer = body.slice(body.lastIndexOf('return jsonb_build_object('));
    const keys = [...finalAnswer.matchAll(/'([a-z_]+)',\s/g)].map((match) => match[1]);
    expect(keys).toEqual(['status', 'id', 'outcome', 'enqueued', 'work_pending', 'booking_linked']);
    expect(finalAnswer).toMatch(/case when v_created then 'inserted' else 'duplicate' end/);
  });

  it('(iv) the rules the fake mirrors are still the migration rules', () => {
    const body = receiptFunctionBody();
    expect(body).toContain("p_source not in ('recall', 'ashby')");
    expect(body).toContain('char_length(p_dedupe_key) not between 1 and 256');
    expect(body).toContain("p_dedupe_key !~ '^[A-Za-z0-9_.:-]+$'");
    expect(body).toContain("(p_source = 'ashby') <> (p_dedupe_key like 'ashby-schedule:%')");
    expect(body).toContain("p_event_type !~ '^[A-Za-z0-9_.:-]{1,128}$'");
    expect(body).toContain("(p_payload ->> 'kind') !~ '^[a-z][a-z0-9_]{0,39}$'");
    expect(body).toContain(`octet_length(p_payload::text) > ${R1_MEET_FAKE_PAYLOAD_MAX_BYTES}`);
    expect(body).toContain("p_payload || jsonb_build_object('receipt_id', v_id, 'source', p_source)");
    expect(body).toContain("'r1-meet', p_payload");
    expect(body).toContain("'r1-meet:receipt:' || v_id::text");
    expect(body).toContain("v_outcome in ('processed', 'ignored', 'failed')");
    // The source and outcome CHECKs of the receipts table match the exported lists.
    expect(sql).toContain("check (source in ('recall', 'ashby'))");
    expect(sql).toContain("outcome in ('recorded', 'enqueued', 'processed', 'ignored', 'failed')");
  });
});

// ── The fake ────────────────────────────────────────────────────────────────

describe('r1-meet receipts fake: agrees with the RPC rules', () => {
  // Five of the seven refusals are reachable through the port. `invalid_request` (a null p_now) is
  // pre-empted by the store's TypeError guard (tested below), and `invalid_scheduled_at` needs a
  // `p_scheduled_at`, which the port never sends.
  const longKey = 'm'.repeat(257);
  const cases: Array<[string, Partial<R1MeetReceiptRequest>, string]> = [
    ['an unknown source', { source: 'zoom' as never }, 'invalid_source'],
    ['an empty dedupe key', { dedupeKey: '' }, 'invalid_dedupe_key'],
    ['a dedupe key over 256 characters', { dedupeKey: longKey }, 'invalid_dedupe_key'],
    ['a dedupe key with a space', { dedupeKey: 'msg s03' }, 'invalid_dedupe_key'],
    ['a Recall key in the Ashby space', { dedupeKey: ashbyDedupe('x') }, 'invalid_dedupe_key'],
    ['an Ashby key outside the Ashby space', { source: 'ashby', dedupeKey: WEBHOOK_ID }, 'invalid_dedupe_key'],
    ['an empty event type', { eventType: '' }, 'invalid_event_type'],
    ['an event type over 128 characters', { eventType: 'e'.repeat(129) }, 'invalid_event_type'],
    ['an event type with a space', { eventType: 'bot done' }, 'invalid_event_type'],
    ['a payload without kind', { payload: { event_type: 'bot.done' } as never }, 'invalid_payload'],
    ['an upper-case kind', { payload: { kind: 'Recall_event' } }, 'invalid_payload'],
    ['a numeric kind', { payload: { kind: 7 } as never }, 'invalid_payload'],
    ['a kind over 40 characters', { payload: { kind: 'k'.repeat(41) } }, 'invalid_payload'],
    ['an array payload', { payload: [{ kind: 'recall_event' }] as never }, 'invalid_payload'],
    ['a payload over 4096 bytes', { payload: { kind: 'recall_event', pad: 'p'.repeat(4096) } }, 'payload_too_large'],
  ];

  it.each(cases)('%s is refused with %s and changes nothing', async (_label, overrides, reason) => {
    const fake = createR1MeetReceiptsFake();
    const answer = await fake.record(recallRequest(overrides));
    expect(answer).toStrictEqual({ status: 'refused', reason });
    expect(fake.jobs()).toEqual([]);
    expect(fake.receipts()).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it('accepts the boundaries: a 256-character key, a 128-character event type, a 40-character kind', async () => {
    const fake = createR1MeetReceiptsFake();
    const answer = await fake.record(
      recallRequest({ dedupeKey: 'm'.repeat(256), eventType: 'e'.repeat(128), payload: { kind: 'k'.repeat(40) } }),
    );
    expect(answer).toMatchObject({ status: 'inserted', enqueued: true, workPending: true });
  });

  it('measures the payload like octet_length(jsonb::text): a space after every colon and comma', async () => {
    const payload = { kind: 'recall_event', a: [1, 2], b: { c: null } };
    expect(jsonbTextByteLength(payload)).toBe(
      Buffer.byteLength('{"kind": "recall_event", "a": [1, 2], "b": {"c": null}}', 'utf8'),
    );
    // A payload whose JSON.stringify fits but whose jsonb text does not is refused, like the RPC.
    const fields: Record<string, unknown> = { kind: 'recall_event' };
    for (let i = 0; i < 400; i += 1) fields[`f${String(i).padStart(3, '0')}`] = 0;
    expect(Buffer.byteLength(JSON.stringify(fields), 'utf8')).toBeLessThanOrEqual(R1_MEET_FAKE_PAYLOAD_MAX_BYTES);
    expect(jsonbTextByteLength(fields)).toBeGreaterThan(R1_MEET_FAKE_PAYLOAD_MAX_BYTES);
    const fake = createR1MeetReceiptsFake();
    expect(await fake.record(recallRequest({ payload: fields as never }))).toStrictEqual({
      status: 'refused',
      reason: 'payload_too_large',
    });
  });

  it('a non-UUID booking id fails like the RPC cast (throws), ahead of any refusal', async () => {
    const fake = createR1MeetReceiptsFake();
    await expect(fake.record(recallRequest({ bookingId: 'not-a-uuid' }))).rejects.toThrow(/^r1_meet_receipt_rpc_error$/);
    await expect(fake.record(recallRequest({ bookingId: 'not-a-uuid', source: 'zoom' as never }))).rejects.toThrow(
      /^r1_meet_receipt_rpc_error$/,
    );
    expect(fake.receipts()).toEqual([]);
  });

  it('a non-finite nowMs rejects with TypeError like the store', async () => {
    const fake = createR1MeetReceiptsFake();
    await expect(fake.record(recallRequest({ nowMs: Number.NaN }))).rejects.toThrow(TypeError);
    expect(fake.receipts()).toEqual([]);
  });
});

describe('r1-meet receipts fake: insert, duplicate and the outbox re-drive', () => {
  it('inserts the receipt and one live job carrying receipt_id and source', async () => {
    const fake = createR1MeetReceiptsFake();
    const request = recallRequest();
    const answer = await fake.record(request);
    expect(answer).toMatchObject({ status: 'inserted', outcome: 'enqueued', enqueued: true, workPending: true, bookingLinked: false });
    if (answer.status === 'refused') throw new Error('unexpected refusal');
    expect(fake.jobs()).toEqual([
      { dedupeKey: WEBHOOK_ID, payload: { ...request.payload, receipt_id: answer.id, source: 'recall' } },
    ]);
    expect(fake.receipts()).toEqual([
      {
        id: answer.id,
        source: 'recall',
        dedupeKey: WEBHOOK_ID,
        eventType: 'bot.in_call_recording',
        bookingId: null,
        outcome: 'enqueued',
      },
    ]);
  });

  it('links a known booking (case-insensitive) and keeps the first delivery link on duplicates', async () => {
    const fake = createR1MeetReceiptsFake({ knownBookingIds: [BOOKING_ID.toUpperCase()] });
    expect(await fake.record(recallRequest())).toMatchObject({ bookingLinked: true });
    expect(await fake.record(recallRequest({ bookingId: null }))).toMatchObject({ status: 'duplicate', bookingLinked: true });
    expect(await fake.record(recallRequest({ dedupeKey: fixtureDeliveryId('0002'), bookingId: null }))).toMatchObject({
      status: 'inserted',
      bookingLinked: false,
    });
  });

  it('a duplicate with a live job answers enqueued false, work pending, the same id, and adds no job', async () => {
    const fake = createR1MeetReceiptsFake();
    const first = await fake.record(recallRequest());
    const second = await fake.record(recallRequest());
    expect(second).toStrictEqual({ ...first, status: 'duplicate', enqueued: false });
    expect(fake.jobs()).toHaveLength(1);
    expect(fake.receipts()).toHaveLength(1);
  });

  it('a dropped job is re-driven by the next duplicate, with that delivery payload', async () => {
    const fake = createR1MeetReceiptsFake();
    const first = await fake.record(recallRequest());
    if (first.status === 'refused') throw new Error('unexpected refusal');
    fake.dropJob(first.id);
    expect(fake.jobs()).toEqual([]);
    const redrive = await fake.record(
      recallRequest({ payload: { kind: 'recall_event', event_type: 'bot.in_call_recording', marker: 2 } }),
    );
    expect(redrive).toMatchObject({ status: 'duplicate', enqueued: true, workPending: true, id: first.id });
    expect(fake.jobs()).toEqual([
      {
        dedupeKey: WEBHOOK_ID,
        payload: { kind: 'recall_event', event_type: 'bot.in_call_recording', marker: 2, receipt_id: first.id, source: 'recall' },
      },
    ]);
  });

  it('a settled receipt answers work pending on a duplicate and inserts nothing', async () => {
    const fake = createR1MeetReceiptsFake();
    const first = await fake.record(recallRequest());
    if (first.status === 'refused') throw new Error('unexpected refusal');
    fake.settle(first.id, 'processed');
    expect(fake.jobs()).toEqual([]);
    expect(await fake.record(recallRequest())).toStrictEqual({
      status: 'duplicate',
      id: first.id,
      outcome: 'processed',
      enqueued: false,
      workPending: true,
      bookingLinked: false,
    });
    expect(fake.jobs()).toEqual([]);
    expect(() => fake.settle('5e000000-0000-4000-8000-00000000ffff', 'failed')).toThrow(/unknown receipt/);
  });

  it('throwNext fails before committing; loseAnswerNext commits then fails; answerNext answers verbatim', async () => {
    const fake = createR1MeetReceiptsFake();
    fake.throwNext(2);
    await expect(fake.record(recallRequest())).rejects.toThrow(/^r1_meet_receipt_rpc_error$/);
    await expect(fake.record(recallRequest())).rejects.toThrow(/^r1_meet_receipt_rpc_error$/);
    expect(fake.receipts()).toEqual([]);

    fake.loseAnswerNext();
    await expect(fake.record(recallRequest())).rejects.toThrow(/^r1_meet_receipt_rpc_error$/);
    expect(fake.jobs()).toHaveLength(1);
    expect(await fake.record(recallRequest())).toMatchObject({ status: 'duplicate', enqueued: false, workPending: true });

    const canned = Object.freeze({
      status: 'inserted' as const,
      id: RECEIPT_ID,
      outcome: 'enqueued' as const,
      enqueued: false,
      workPending: false,
      bookingLinked: false,
    });
    fake.answerNext(canned);
    fake.answerNext({ status: 'refused', reason: 'invalid_payload' });
    expect(await fake.record(recallRequest({ dedupeKey: fixtureDeliveryId('0003') }))).toBe(canned);
    expect(await fake.record(recallRequest({ dedupeKey: fixtureDeliveryId('0004') }))).toStrictEqual({
      status: 'refused',
      reason: 'invalid_payload',
    });
    expect(fake.receipts()).toHaveLength(1);
    // Two thrown, one lost, one duplicate, two canned: every request is recorded.
    expect(fake.calls).toHaveLength(6);
  });

  it('keeps the Recall and Ashby key spaces apart', async () => {
    const fake = createR1MeetReceiptsFake();
    const ashby = await fake.record(
      recallRequest({
        source: 'ashby',
        dedupeKey: ashbyDedupe(`${BOOKING_ID}:1796120940123:schedule`),
        eventType: 'interviewScheduleUpdate',
        bookingId: null,
        payload: { kind: 'ashby_schedule' },
      }),
    );
    expect(ashby).toMatchObject({ status: 'inserted' });
    expect(fake.jobs()[0]!.payload.source).toBe('ashby');
  });
});
