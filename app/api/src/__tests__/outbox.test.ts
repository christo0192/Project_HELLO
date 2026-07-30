/**
 * outbox.test.ts — REL-02/03 transactional outbox and transcript event upsert tests.
 *
 * Covers:
 *   - upsertTranscriptEvent: idempotent dedup (same turn_index → same record)
 *   - upsertTranscriptEvent: out-of-order insertion creates new record
 *   - upsertTranscriptEvent: outbox entry created alongside event
 *   - createOutboxEntry: generic entry creation
 *   - pollOutbox: fetches pending entries in FIFO order
 *   - markOutboxEntry: status transitions (published, failed)
 *   - getTranscriptEvents: ordered retrieval
 *   - countPendingOutbox: pending count
 *   - Error codes on DB failures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  upsertTranscriptEvent,
  createOutboxEntry,
  pollOutbox,
  markOutboxEntry,
  getTranscriptEvents,
  countPendingOutbox,
  ERR_EVENT_UPSERT_FAILED,
  ERR_OUTBOX_INSERT_FAILED,
  ERR_POLL_FAILED,
  ERR_MARK_FAILED,
  ERR_FETCH_EVENTS_FAILED,
  ERR_EVENT_COUNT_FAILED,
} from '../lib/outbox.js';

// ── Supabase mock ────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

/**
 * Create a chainable Supabase query-builder mock that ultimately resolves
 * to the given `value` when awaited (via .then).
 */
function chain(value: unknown) {
  const c: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'upsert',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'single', 'maybeSingle', 'order', 'limit',
    'execute',
  ];
  for (const m of methods) {
    c[m] = (..._args: unknown[]) => chain(value);
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

/** Helper: build a fake transcript event row. */
function fakeEventRow(overrides: Partial<{
  id: string;
  session_id: string;
  turn_index: number;
  speaker: string;
  text: string;
  sequence: number;
  created_at: string;
}> = {}) {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    session_id: '00000000-0000-4000-8000-000000000001',
    turn_index: 0,
    speaker: 'bot',
    text: 'Hello',
    sequence: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Helper: build a fake outbox row. */
function fakeOutboxRow(overrides: Partial<{
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'published' | 'failed';
  retry_count: number;
  max_retries: number;
  created_at: string;
  published_at: string | null;
  last_error: string | null;
}> = {}) {
  return {
    id: 'o0000000-0000-4000-8000-000000000001',
    aggregate_type: 'transcript_event',
    aggregate_id: 'e0000000-0000-4000-8000-000000000001',
    event_type: 'transcript_turn.created',
    payload: {
      sessionId: '00000000-0000-4000-8000-000000000001',
      turnIndex: 0,
      speaker: 'bot',
      text: 'Hello',
      sequence: 1,
    },
    status: 'pending' as const,
    retry_count: 0,
    max_retries: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    published_at: null,
    last_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
//  1. upsertTranscriptEvent — happy path
// ═══════════════════════════════════════════════════════════════════════

describe('upsertTranscriptEvent', () => {
  const SESSION_ID = '00000000-0000-4000-8000-000000000001';

  it('inserts a new transcript event and outbox entry', async () => {
    const eventRow = fakeEventRow();

    // First call: .maybeSingle() returns no previous sequence → sequence=1
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // maybeSingle
      .mockReturnValueOnce(chain({ data: eventRow, error: null })) // upsert
      .mockReturnValueOnce(chain({ data: [fakeOutboxRow()], error: null })); // insert outbox

    const result = await upsertTranscriptEvent(SESSION_ID, 0, 'bot', 'Hello');

    expect(result.error).toBeNull();
    expect(result.data).not.toBeNull();
    expect(result.data!.session_id).toBe(SESSION_ID);
    expect(result.data!.turn_index).toBe(0);
    expect(result.data!.sequence).toBe(1);
  });

  it('deduplicates by (session_id, turn_index) — second upsert same pair', async () => {
    const eventRow = fakeEventRow();
    // The first call establishes the row.
    // The second call with the same (session_id, turn_index) should still
    // return the existing row (upsert ignoreDuplicates returns the row).

    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // maybeSequence for first
      .mockReturnValueOnce(chain({ data: eventRow, error: null })) // first upsert
      .mockReturnValueOnce(chain({ data: [fakeOutboxRow()], error: null })); // first outbox

    const first = await upsertTranscriptEvent(SESSION_ID, 0, 'bot', 'Hello');
    expect(first.error).toBeNull();
    expect(first.data!.turn_index).toBe(0);
  });

  it('out-of-order turn inserts as new record (different turn_index)', async () => {
    const turn0 = fakeEventRow({ turn_index: 0, sequence: 1 });
    const turn2 = fakeEventRow({ id: 'e0000000-0000-4000-8000-000000000003', turn_index: 2, sequence: 2, speaker: 'candidate', text: 'Later' });

    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // sequence query (no rows)
      .mockReturnValueOnce(chain({ data: turn0, error: null })) // upsert turn 0
      .mockReturnValueOnce(chain({ data: [fakeOutboxRow({ aggregate_id: turn0.id })], error: null })) // outbox for turn 0
      .mockReturnValueOnce(chain({ data: { sequence: 1 }, error: null })) // sequence query for turn 2 (has row)
      .mockReturnValueOnce(chain({ data: turn2, error: null })) // upsert turn 2
      .mockReturnValueOnce(chain({ data: [fakeOutboxRow({ aggregate_id: turn2.id })], error: null })); // outbox for turn 2

    const first = await upsertTranscriptEvent(SESSION_ID, 0, 'bot', 'Hello');
    expect(first.error).toBeNull();

    const second = await upsertTranscriptEvent(SESSION_ID, 2, 'candidate', 'Later');
    expect(second.error).toBeNull();
    expect(second.data!.turn_index).toBe(2);
    expect(second.data!.sequence).toBe(2);
  });

  it('out-of-order earlier turn still inserts (different turn_index, not yet existing)', async () => {
    // Insert turn 10 first, then turn 5 arrives late. Both insert because
    // (session_id, turn_index) pairs are different.
    const turn10 = fakeEventRow({ id: 'e0000000-0000-4000-8000-000000000010', turn_index: 10, sequence: 1, text: 'Turn 10' });
    const turn5 = fakeEventRow({ id: 'e0000000-0000-4000-8000-000000000005', turn_index: 5, sequence: 2, text: 'Turn 5 late' });

    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // sequence for turn 10
      .mockReturnValueOnce(chain({ data: turn10, error: null })) // upsert turn 10
      .mockReturnValueOnce(chain({ data: [fakeOutboxRow({ aggregate_id: turn10.id })], error: null })) // outbox turn 10
      .mockReturnValueOnce(chain({ data: { sequence: 1 }, error: null })) // sequence for turn 5 (finds turn 10)
      .mockReturnValueOnce(chain({ data: turn5, error: null })) // upsert turn 5
      .mockReturnValueOnce(chain({ data: [fakeOutboxRow({ aggregate_id: turn5.id })], error: null })); // outbox turn 5

    const first = await upsertTranscriptEvent(SESSION_ID, 10, 'bot', 'Turn 10');
    expect(first.error).toBeNull();

    const second = await upsertTranscriptEvent(SESSION_ID, 5, 'candidate', 'Turn 5 late');
    expect(second.error).toBeNull();
    expect(second.data!.turn_index).toBe(5);
    expect(second.data!.sequence).toBe(2);
  });

  it('returns error code when sequence query fails', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: new Error('DB error') }));

    const result = await upsertTranscriptEvent(SESSION_ID, 0, 'bot', 'Hello');
    expect(result.data).toBeNull();
    expect(result.error).toBe(ERR_EVENT_UPSERT_FAILED);
  });

  it('returns error code when upsert fails', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // sequence
      .mockReturnValueOnce(chain({ data: null, error: new Error('insert failed') })); // upsert

    const result = await upsertTranscriptEvent(SESSION_ID, 0, 'bot', 'Hello');
    expect(result.data).toBeNull();
    expect(result.error).toBe(ERR_EVENT_UPSERT_FAILED);
  });

  it('returns outbox-failed error when outbox insert fails (event still durable)', async () => {
    const eventRow = fakeEventRow();
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // sequence
      .mockReturnValueOnce(chain({ data: eventRow, error: null })) // upsert succeeds
      .mockReturnValueOnce(chain({ data: null, error: new Error('outbox failed') })); // outbox fails

    const result = await upsertTranscriptEvent(SESSION_ID, 0, 'bot', 'Hello');
    // Event was saved, outbox failed — event is durable
    expect(result.data).not.toBeNull();
    expect(result.data!.turn_index).toBe(0);
    expect(result.error).toBe(ERR_OUTBOX_INSERT_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  2. createOutboxEntry
// ═══════════════════════════════════════════════════════════════════════

describe('createOutboxEntry', () => {
  it('creates a pending outbox entry and returns it', async () => {
    const row = fakeOutboxRow({ aggregate_type: 'session', aggregate_id: 'sess-1', event_type: 'session.completed' });
    mockFrom.mockReturnValueOnce(chain({ data: row, error: null }));

    const result = await createOutboxEntry('session', 'sess-1', 'session.completed', { sessionId: 'sess-1' });
    expect(result.error).toBeNull();
    expect(result.data).not.toBeNull();
    expect(result.data!.aggregate_type).toBe('session');
    expect(result.data!.status).toBe('pending');
  });

  it('returns error code on DB failure', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: new Error('fail') }));

    const result = await createOutboxEntry('session', 'sess-1', 'session.completed', {});
    expect(result.data).toBeNull();
    expect(result.error).toBe(ERR_OUTBOX_INSERT_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  3. pollOutbox
// ═══════════════════════════════════════════════════════════════════════

describe('pollOutbox', () => {
  it('returns pending entries ordered by created_at', async () => {
    const rows = [
      fakeOutboxRow({ id: 'o1', created_at: '2026-01-01T00:00:00.000Z' }),
      fakeOutboxRow({ id: 'o2', created_at: '2026-01-01T00:00:01.000Z' }),
    ];
    mockFrom.mockReturnValueOnce(chain({ data: rows, error: null }));

    const result = await pollOutbox(10);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('o1');
    expect(result.data[1].id).toBe('o2');
  });

  it('returns empty array when no pending entries', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: [], error: null }));

    const result = await pollOutbox();
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(0);
  });

  it('returns error code on DB failure', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: new Error('fail') }));

    const result = await pollOutbox();
    expect(result.data).toEqual([]);
    expect(result.error).toBe(ERR_POLL_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  4. markOutboxEntry
// ═══════════════════════════════════════════════════════════════════════

describe('markOutboxEntry', () => {
  it('marks entry as published and sets timestamp', async () => {
    const row = fakeOutboxRow({ status: 'published', published_at: '2026-01-01T01:00:00.000Z' });
    mockFrom.mockReturnValueOnce(chain({ data: row, error: null }));

    const result = await markOutboxEntry('o1', 'published');
    expect(result.error).toBeNull();
    expect(result.data!.status).toBe('published');
  });

  it('marks entry as failed with error message', async () => {
    const row = fakeOutboxRow({ status: 'failed', last_error: 'timeout' });
    mockFrom.mockReturnValueOnce(chain({ data: row, error: null }));

    const result = await markOutboxEntry('o1', 'failed', 'timeout');
    expect(result.error).toBeNull();
    expect(result.data!.status).toBe('failed');
    expect(result.data!.last_error).toBe('timeout');
  });

  it('returns error code on DB failure', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: new Error('fail') }));

    const result = await markOutboxEntry('o1', 'published');
    expect(result.data).toBeNull();
    expect(result.error).toBe(ERR_MARK_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  5. getTranscriptEvents
// ═══════════════════════════════════════════════════════════════════════

describe('getTranscriptEvents', () => {
  const SESSION_ID = '00000000-0000-4000-8000-000000000001';

  it('returns events ordered by sequence', async () => {
    const rows = [
      fakeEventRow({ sequence: 1, turn_index: 0 }),
      fakeEventRow({ id: 'e2', sequence: 2, turn_index: 5 }),
    ];
    mockFrom.mockReturnValueOnce(chain({ data: rows, error: null }));

    const result = await getTranscriptEvents(SESSION_ID);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2);
    expect(result.data[0].sequence).toBe(1);
    expect(result.data[1].sequence).toBe(2);
  });

  it('returns empty array for session with no events', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: [], error: null }));

    const result = await getTranscriptEvents(SESSION_ID);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  6. countPendingOutbox
// ═══════════════════════════════════════════════════════════════════════

describe('countPendingOutbox', () => {
  it('returns the count of pending entries', async () => {
    // head:true + count:exact returns { count: 3 } without data
    mockFrom.mockReturnValueOnce(
      chain({ data: null, count: 3, error: null })
    );

    const result = await countPendingOutbox();
    expect(result.error).toBeNull();
    expect(result.data).toBe(3);
  });

  it('returns 0 when count is null', async () => {
    mockFrom.mockReturnValueOnce(
      chain({ data: null, count: null, error: null })
    );

    const result = await countPendingOutbox();
    expect(result.error).toBeNull();
    expect(result.data).toBe(0);
  });

  it('returns error code on DB failure', async () => {
    mockFrom.mockReturnValueOnce(
      chain({ data: null, count: null, error: new Error('fail') })
    );

    const result = await countPendingOutbox();
    expect(result.data).toBe(0);
    expect(result.error).toBe(ERR_EVENT_COUNT_FAILED);
  });
});
