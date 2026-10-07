/**
 * M013 S02 (T04) — `stampWorkerAttemptLegTiming`, the DB adapter behind the
 * `/recording/complete` leg-timing stamp.
 *
 * The rule itself (sanity window, earliest end, first write) is pinned on the
 * pure planner in worker-recording.test.ts. This file pins what the ADAPTER
 * adds: it writes only the attempt row, only the planned columns, under a
 * compare-and-set on each of them; it refuses a session it is not bound to;
 * it re-plans once on a lost race; and it never throws.
 *
 * Synthetic timings shaped like 9f60523d leg 2. No real call data.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/env.js', () => ({
  env: { recordingsBucket: 'recordings_v2', recordingMaxBytes: 25 * 1024 * 1024 },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: {} }));

import { stampWorkerAttemptLegTiming } from '../lib/recording-egress.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = '99999999-8888-4777-8666-555555555555';
const OTHER_SESSION = '99999999-8888-4777-8666-666666666666';
const NOW = new Date('2026-10-05T03:35:10.000Z');
const REC_START = Date.parse('2026-10-05T03:34:50.650Z');
const LEG_END = Date.parse('2026-10-05T03:35:08.300Z');

type Row = Record<string, unknown>;

function attemptRow(over: Row = {}): Row {
  return {
    session_id: SESSION,
    recording_session_id: SESSION,
    admitted_at: '2026-10-05T03:34:30+00:00',
    answered_at: '2026-10-05T03:34:49.6+00:00',
    ended_at: null,
    observed_ended_at: null,
    recording_started_at_ms: null,
    recording_duration_ms: null,
    recording_tail_flushed: null,
    ...over,
  };
}

interface FakeOpts {
  reads: Array<{ data: Row | null; error?: { message: string } | null } | 'throw'>;
  /** Rows each update CAS returns, in order ([] = lost the race). */
  updateRows?: Row[][];
  updateError?: { message: string };
}

function fakeDb(opts: FakeOpts) {
  const tables: string[] = [];
  const updates: Array<{ payload: Row; filters: Array<[string, string, unknown]> }> = [];
  const reads = [...opts.reads];
  const updateRows = [...(opts.updateRows ?? [[{ id: ATTEMPT }]])];
  const from = vi.fn((table: string) => {
    tables.push(table);
    let current: { payload: Row; filters: Array<[string, string, unknown]> } | null = null;
    const chain: any = {
      select: vi.fn(() => chain),
      update: vi.fn((payload: Row) => {
        current = { payload, filters: [] };
        updates.push(current);
        return chain;
      }),
      eq: vi.fn((col: string, v: unknown) => { current?.filters.push(['eq', col, v]); return chain; }),
      is: vi.fn((col: string, v: unknown) => { current?.filters.push(['is', col, v]); return chain; }),
      maybeSingle: vi.fn(async () => {
        const next = reads.shift();
        if (next === 'throw') throw new Error('synthetic read failure');
        return next ?? { data: null, error: null };
      }),
      then: (resolve: (value: unknown) => void) => resolve(
        opts.updateError
          ? { data: null, error: opts.updateError }
          : { data: updateRows.shift() ?? [], error: null },
      ),
    };
    return chain;
  });
  return { db: { from } as any, tables, updates };
}

const REPORT = {
  recordingStartedAtMs: REC_START,
  legEndedAtMs: LEG_END,
  legEndSource: 'sip_left' as const,
  durationMs: 17_650,
  tailFlushed: true,
};

function stamp(db: unknown, over: { sessionId?: string; report?: typeof REPORT } = {}) {
  return stampWorkerAttemptLegTiming(
    { attemptId: ATTEMPT, sessionId: over.sessionId ?? SESSION, report: over.report ?? REPORT, now: NOW },
    { db: db as never },
  );
}

describe('stampWorkerAttemptLegTiming — data-only, attempt-only, compare-and-set', () => {
  it('stamps the four columns on the attempt row under a NULL guard for each', async () => {
    const f = fakeDb({ reads: [{ data: attemptRow() }] });
    const result = await stamp(f.db);
    expect(result).toEqual({ status: 'stamped', dropped: [] });
    // Only the attempt table is touched — never call_sessions, never an RPC.
    expect(new Set(f.tables)).toEqual(new Set(['phone_call_attempts']));
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].payload).toEqual({
      observed_ended_at: '2026-10-05T03:35:08.300Z',
      recording_started_at_ms: REC_START,
      recording_duration_ms: 17_650,
      recording_tail_flushed: true,
    });
    expect(f.updates[0].filters).toEqual([
      ['eq', 'id', ATTEMPT],
      ['is', 'observed_ended_at', null],
      ['is', 'recording_started_at_ms', null],
      ['is', 'recording_duration_ms', null],
      ['is', 'recording_tail_flushed', null],
    ]);
  });

  it('an earlier end over an existing one is guarded by the EXISTING value, not by NULL', async () => {
    const f = fakeDb({
      reads: [{
        data: attemptRow({
          observed_ended_at: '2026-10-05T03:35:12+00:00',
          recording_started_at_ms: String(REC_START),
          recording_duration_ms: 17_650,
          recording_tail_flushed: false,
        }),
      }],
    });
    const result = await stamp(f.db);
    expect(result.status).toBe('stamped');
    expect(f.updates[0].payload).toEqual({ observed_ended_at: '2026-10-05T03:35:08.300Z' });
    expect(f.updates[0].filters).toEqual([
      ['eq', 'id', ATTEMPT],
      ['eq', 'observed_ended_at', '2026-10-05T03:35:12+00:00'],
    ]);
  });

  it('a second report with a LATER leg end writes nothing (unchanged)', async () => {
    const f = fakeDb({
      reads: [{
        data: attemptRow({
          observed_ended_at: '2026-10-05T03:35:08.3+00:00',
          recording_started_at_ms: REC_START,
          recording_duration_ms: 17_650,
          recording_tail_flushed: true,
        }),
      }],
    });
    const result = await stamp(f.db, { report: { ...REPORT, legEndedAtMs: LEG_END + 2_500 } });
    expect(result).toEqual({ status: 'unchanged', dropped: [] });
    expect(f.updates).toHaveLength(0);
  });

  it('refuses an attempt bound to a DIFFERENT session and writes nothing', async () => {
    const f = fakeDb({ reads: [{ data: attemptRow() }] });
    const result = await stamp(f.db, { sessionId: OTHER_SESSION });
    expect(result.status).toBe('attempt_mismatch');
    expect(f.updates).toHaveLength(0);
  });

  it('accepts the legacy binding (session_id) when recording_session_id is NULL', async () => {
    const f = fakeDb({ reads: [{ data: attemptRow({ recording_session_id: null }) }] });
    expect((await stamp(f.db)).status).toBe('stamped');
  });

  it('an unknown attempt is attempt_not_found', async () => {
    const f = fakeDb({ reads: [{ data: null }] });
    expect(await stamp(f.db)).toEqual({ status: 'attempt_not_found', dropped: [] });
  });

  it('a lost race re-reads and re-plans ONCE against the winner (no clobber)', async () => {
    const winner = attemptRow({
      observed_ended_at: '2026-10-05T03:35:08.3+00:00',
      recording_started_at_ms: REC_START,
      recording_duration_ms: 17_650,
      recording_tail_flushed: true,
    });
    const f = fakeDb({ reads: [{ data: attemptRow() }, { data: winner }], updateRows: [[]] });
    const result = await stamp(f.db);
    expect(result.status).toBe('unchanged');
    expect(f.updates).toHaveLength(1);
  });

  it('two lost races in a row report conflict, never a false success', async () => {
    const f = fakeDb({ reads: [{ data: attemptRow() }, { data: attemptRow() }], updateRows: [[], []] });
    expect((await stamp(f.db)).status).toBe('conflict');
    expect(f.updates).toHaveLength(2);
  });

  it('a dropped value is reported and not written; the rest still lands', async () => {
    const f = fakeDb({ reads: [{ data: attemptRow() }] });
    const result = await stamp(f.db, { report: { ...REPORT, legEndedAtMs: NOW.getTime() + 61_000 } });
    expect(result).toEqual({ status: 'stamped', dropped: ['leg_ended_at_out_of_window'] });
    expect(f.updates[0].payload.observed_ended_at).toBeUndefined();
    expect(f.updates[0].payload.recording_duration_ms).toBe(17_650);
  });

  it('never throws: a read error, a thrown read and an update error are store_error', async () => {
    expect((await stamp(fakeDb({ reads: [{ data: null, error: { message: 'x' } }] }).db)).status)
      .toBe('store_error');
    expect((await stamp(fakeDb({ reads: ['throw'] }).db)).status).toBe('store_error');
    expect((await stamp(fakeDb({ reads: [{ data: attemptRow() }], updateError: { message: 'x' } }).db)).status)
      .toBe('store_error');
  });
});
