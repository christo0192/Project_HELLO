/**
 * Orphaned R1 sessions lapse. Admission's one-live-R1 rule is GLOBAL (`r1_in_flight`), so a
 * created/waiting/in_progress session that no worker owns blocked every R1 start forever. The
 * lapse runs in the existing r1-status loop, fails or expires the orphan with a terminal reason
 * far past anything a live session takes, writes ended_at as the LAST ACTIVITY (never now(), which
 * would book phantom minutes), and settles the attempt as an UNCOUNTED outcome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_ORPHAN_LAPSE_BOUNDS,
  lapseOrphanedR1Sessions,
  type R1OrphanLapseOptions,
} from '../lib/r1/orphan-lapse.js';
import { createR1Runtime, defaultR1DispatchLister } from '../lib/r1/runtime.js';
import type { DispatchListerLike } from '../lib/r1/worker-gate.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { isValidReasonForStatus, isValidTransition } from '../lib/session-lifecycle.js';
import {
  CANDIDATE_ID,
  ROUND_ID,
  baseTables,
  createFakeDb,
  type Row,
  type Tables,
} from './support/r1-fake-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-10-08T06:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const SID = (n: number): string => `70000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function session(n: number, patch: Row = {}): Row {
  return {
    id: SID(n), candidate_id: CANDIDATE_ID, role_id: null, interview_round_id: ROUND_ID, mode: 'browser',
    status: 'created', terminal_reason: null, started_at: minutesAgo(60), waiting_at: null,
    updated_at: minutesAgo(60), ended_at: null, ...patch,
  };
}

function tablesWith(...sessions: Row[]): Tables {
  const tables = baseTables();
  tables.call_sessions = sessions;
  tables.transcript_turns = [];
  tables.r1_usage_ledger = [];
  tables.interview_round_attempts = sessions.map((s, i) => ({
    session_id: s.id, round_id: ROUND_ID, attempt_number: i + 1, outcome: null, counted: false,
  }));
  return tables;
}

const settleRpc = (status = 'ok') => vi.fn((fn: string) =>
  (fn === 'r1_settle_attempt' ? { data: { status, counted: false } } : { data: { status: 'ok' } }));

async function lapse(tables: Tables, rpc = settleRpc()) {
  const db = createFakeDb(tables, rpc);
  const result = await lapseOrphanedR1Sessions(db.client as never, NOW);
  return { db, result, rpc };
}

const settleCalls = (db: ReturnType<typeof createFakeDb>) =>
  db.rpcCalls.filter((call) => call.fn === 'r1_settle_attempt');

describe('what lapses, and into what', () => {
  it('a `created` session untouched for over 15 minutes fails (room_create_error) and settles as no_show', async () => {
    const tables = tablesWith(session(1, { status: 'created', started_at: minutesAgo(16), updated_at: minutesAgo(16) }));
    const { db, result } = await lapse(tables);
    expect(result).toEqual({ scanned: 1, lapsed: 1, settled: 1, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({
      status: 'failed', terminal_reason: 'room_create_error', ended_at: minutesAgo(16),
    });
    expect(settleCalls(db)).toEqual([{
      fn: 'r1_settle_attempt',
      args: { p_session_id: SID(1), p_outcome: 'no_show', p_now: NOW.toISOString() },
    }]);
  });

  it('a `waiting` session with no worker for over 20 minutes expires (idle_timeout), as configuration_failed', async () => {
    const tables = tablesWith(session(1, {
      status: 'waiting', started_at: minutesAgo(40), waiting_at: minutesAgo(21), updated_at: minutesAgo(21),
    }));
    const { db, result } = await lapse(tables);
    expect(result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({
      status: 'expired', terminal_reason: 'idle_timeout', ended_at: minutesAgo(21),
    });
    expect(settleCalls(db)[0]!.args).toMatchObject({ p_outcome: 'configuration_failed' });
  });

  it('an `in_progress` session with no activity for over 45 minutes fails (worker_crash), as shutdown_forced', async () => {
    const tables = tablesWith(session(1, {
      status: 'in_progress', started_at: minutesAgo(180), waiting_at: minutesAgo(179), updated_at: minutesAgo(178),
    }));
    const { db, result } = await lapse(tables);
    expect(result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({
      status: 'failed', terminal_reason: 'worker_crash', ended_at: minutesAgo(178),
    });
    expect(settleCalls(db)[0]!.args).toMatchObject({ p_outcome: 'shutdown_forced' });
  });

  it('every lapse is a legal lifecycle transition with a legal terminal reason', () => {
    expect(isValidTransition('created', 'failed') && isValidReasonForStatus('room_create_error', 'failed')).toBe(true);
    expect(isValidTransition('waiting', 'expired') && isValidReasonForStatus('idle_timeout', 'expired')).toBe(true);
    expect(isValidTransition('in_progress', 'failed') && isValidReasonForStatus('worker_crash', 'failed')).toBe(true);
  });

  it('frees the global R1 slot: no live R1 session is left, so admission stops answering r1_in_flight', async () => {
    const tables = tablesWith(
      session(1, { status: 'created' }),
      session(2, { status: 'waiting', waiting_at: minutesAgo(50), updated_at: minutesAgo(50) }),
      session(3, { status: 'in_progress', updated_at: minutesAgo(120) }),
    );
    // Same rule as r1_admit_attempt (0119): count R1 sessions created, waiting or in_progress.
    const live = () => tables.call_sessions!.filter((s) =>
      s.interview_round_id && ['created', 'waiting', 'in_progress'].includes(s.status)).length;
    expect(live()).toBe(3);
    const { result } = await lapse(tables);
    expect(result).toMatchObject({ scanned: 3, lapsed: 3, settled: 3, errors: 0 });
    expect(live()).toBe(0);
  });
});

describe('what never lapses (a healthy session is never touched)', () => {
  it.each([
    ['created', { status: 'created', started_at: minutesAgo(14), updated_at: minutesAgo(14) }],
    ['waiting', { status: 'waiting', started_at: minutesAgo(30), waiting_at: minutesAgo(19), updated_at: minutesAgo(19) }],
    ['in_progress', { status: 'in_progress', started_at: minutesAgo(120), updated_at: minutesAgo(44) }],
    ['a fresh in_progress', { status: 'in_progress', started_at: minutesAgo(3), updated_at: minutesAgo(3) }],
  ])('a %s session inside its bound', async (_label, patch) => {
    const tables = tablesWith(session(1, patch as Row));
    const before = { ...tables.call_sessions![0]! };
    const { db, result } = await lapse(tables);
    expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 0 });
    expect(tables.call_sessions![0]).toEqual(before);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('an in_progress session whose worker is still writing turns or ledger rows stays alive', async () => {
    const old = { status: 'in_progress', started_at: minutesAgo(180), updated_at: minutesAgo(170) };
    const withTurn = tablesWith(session(1, old));
    withTurn.transcript_turns = [{ session_id: SID(1), turn_index: 1, created_at: minutesAgo(10) }];
    expect((await lapse(withTurn)).result).toMatchObject({ lapsed: 0, errors: 0 });
    expect(withTurn.call_sessions![0]!.status).toBe('in_progress');

    const withLedger = tablesWith(session(1, old));
    withLedger.r1_usage_ledger = [{ session_id: SID(1), occurred_at: minutesAgo(5) }];
    expect((await lapse(withLedger)).result).toMatchObject({ lapsed: 0, errors: 0 });
    expect(withLedger.call_sessions![0]!.status).toBe('in_progress');
  });

  it('uses the last real activity as ended_at when an in_progress worker went quiet', async () => {
    const tables = tablesWith(session(1, {
      status: 'in_progress', started_at: minutesAgo(180), updated_at: minutesAgo(175),
    }));
    tables.transcript_turns = [{ session_id: SID(1), turn_index: 1, created_at: minutesAgo(90) }];
    tables.r1_usage_ledger = [{ session_id: SID(1), occurred_at: minutesAgo(120) }];
    const { result } = await lapse(tables);
    expect(result).toMatchObject({ lapsed: 1, errors: 0 });
    // The newest evidence of life (the turn 90 minutes ago), never now(): no phantom minutes.
    expect(tables.call_sessions![0]).toMatchObject({ status: 'failed', ended_at: minutesAgo(90) });
  });

  it('never touches a phone session, a settled R1 session, or a row it cannot date', async () => {
    const phone = session(1, { status: 'in_progress', mode: 'live', interview_round_id: null, updated_at: minutesAgo(900) });
    const done = session(2, { status: 'completed', terminal_reason: 'conversation_complete', updated_at: minutesAgo(900) });
    const undated = session(3, { status: 'created', started_at: 'not a date', updated_at: minutesAgo(900) });
    const tables = tablesWith(phone, done, undated);
    const before = JSON.parse(JSON.stringify(tables.call_sessions));
    const { db, result } = await lapse(tables);
    expect(result).toMatchObject({ lapsed: 0, errors: 0 });
    expect(tables.call_sessions).toEqual(before);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('bounds sit far past the worker timings they must clear', () => {
    // 90 s rejoin grace, 120 s no-show, 1800 s residency (+ closing), 300 s attempt token.
    expect(R1_ORPHAN_LAPSE_BOUNDS.createdIdleSec).toBeGreaterThan(300 * 2);
    expect(R1_ORPHAN_LAPSE_BOUNDS.waitingIdleSec).toBeGreaterThan(120 * 5);
    expect(R1_ORPHAN_LAPSE_BOUNDS.inProgressIdleSec).toBeGreaterThan(1800 + 90 + 10 * 60);
  });
});

describe('races and failures', () => {
  it('a worker that settles the session first wins: zero rows is neither a lapse nor an error', async () => {
    const tables = tablesWith(session(1, { status: 'in_progress', updated_at: minutesAgo(120) }));
    const db = createFakeDb(tables, settleRpc());
    const racing = {
      ...db.client,
      from: (table: string) => {
        const q = db.client.from(table);
        if (table === 'call_sessions') {
          const update = q.update;
          q.update = (value: Row) => {
            tables.call_sessions![0]!.status = 'completed'; // the worker finished between read and write
            tables.call_sessions![0]!.terminal_reason = 'conversation_complete';
            return update(value);
          };
        }
        return q;
      },
    };
    const result = await lapseOrphanedR1Sessions(racing as never, NOW);
    expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({ status: 'completed', terminal_reason: 'conversation_complete' });
    expect(settleCalls(db)).toHaveLength(0);
  });

  it('a failed scan read is one error and changes nothing', async () => {
    const tables = tablesWith(session(1, { updated_at: minutesAgo(120) }));
    const db = createFakeDb(tables, settleRpc());
    const failing = {
      ...db.client,
      from: (table: string) => {
        if (table !== 'call_sessions') return db.client.from(table);
        const q: any = {};
        for (const method of ['select', 'not', 'eq', 'in', 'limit']) q[method] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'down' } });
        return q;
      },
    };
    expect(await lapseOrphanedR1Sessions(failing as never, NOW)).toEqual({ scanned: 0, lapsed: 0, settled: 0, errors: 1 });
    expect(tables.call_sessions![0]!.status).toBe('created');
  });

  it('a failed write is an error, the attempt is not settled, and the next pass retries', async () => {
    const tables = tablesWith(session(1, { updated_at: minutesAgo(120) }));
    const db = createFakeDb(tables, settleRpc());
    const failingWrite = {
      ...db.client,
      from: (table: string) => {
        const q = db.client.from(table);
        if (table === 'call_sessions') {
          q.update = () => {
            const u: any = {};
            for (const method of ['eq', 'lte', 'select']) u[method] = () => u;
            u.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'down' } });
            return u;
          };
        }
        return q;
      },
    };
    expect(await lapseOrphanedR1Sessions(failingWrite as never, NOW)).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 1 });
    expect(tables.call_sessions![0]!.status).toBe('created');
    expect(settleCalls(db)).toHaveLength(0);
    // The next pass, with a healthy database, lapses it.
    expect((await lapse(tables)).result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
  });

  it('cannot prove an in_progress session idle when its activity read fails: it is not lapsed', async () => {
    const tables = tablesWith(session(1, { status: 'in_progress', updated_at: minutesAgo(120) }));
    const db = createFakeDb(tables, settleRpc());
    const failing = {
      ...db.client,
      from: (table: string) => {
        if (table !== 'transcript_turns') return db.client.from(table);
        const q: any = {};
        for (const method of ['select', 'eq', 'order', 'limit']) q[method] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'down' } });
        return q;
      },
    };
    expect(await lapseOrphanedR1Sessions(failing as never, NOW)).toMatchObject({ lapsed: 0, errors: 1 });
    expect(tables.call_sessions![0]!.status).toBe('in_progress');
  });

  it('retries the settle once, counts a persistent failure, and leaves the (terminal) session terminal', async () => {
    const transient = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'blip' } })
      .mockResolvedValue({ data: { status: 'ok' }, error: null });
    const tablesA = tablesWith(session(1, { updated_at: minutesAgo(120) }));
    const dbA = createFakeDb(tablesA);
    const a = await lapseOrphanedR1Sessions({ ...dbA.client, rpc: transient } as never, NOW);
    expect(a).toEqual({ scanned: 1, lapsed: 1, settled: 1, errors: 0 });
    expect(transient).toHaveBeenCalledTimes(2);

    const tablesB = tablesWith(session(1, { updated_at: minutesAgo(120) }));
    const dbB = createFakeDb(tablesB);
    const always = vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } });
    const b = await lapseOrphanedR1Sessions({ ...dbB.client, rpc: always } as never, NOW);
    expect(b).toEqual({ scanned: 1, lapsed: 1, settled: 0, errors: 1 });
    expect(always).toHaveBeenCalledTimes(2);
    expect(tablesB.call_sessions![0]!.status).toBe('failed');
  });

  it.each(['ok', 'duplicate', 'attempt_not_found'])('treats r1_settle_attempt status %s as settled', async (status) => {
    const { result } = await lapse(tablesWith(session(1, { updated_at: minutesAgo(120) })), settleRpc(status));
    expect(result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
  });

  it('does not treat a refusal (session_not_settled) as settled', async () => {
    const { result } = await lapse(tablesWith(session(1, { updated_at: minutesAgo(120) })), settleRpc('session_not_settled'));
    expect(result).toMatchObject({ lapsed: 1, settled: 0, errors: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A `waiting` row is not lapsed under a worker that was just dispatched into it (P2).

const liveJob = { id: 'AJ_live', state: { status: 'JS_RUNNING' } };
const dispatchOf = (jobs: unknown[], id = 'AD_1') => ({
  id, agentName: 'browser-screener', state: { jobs, createdAt: 1n },
});

/** A dispatch lister that answers `listed` (or throws it), recording the rooms it was asked about. */
function listerOf(listed: unknown[] | Error) {
  const listDispatch = vi.fn(async (_room: string) => {
    if (listed instanceof Error) throw listed;
    return listed;
  });
  const lister = { listDispatch } as unknown as DispatchListerLike;
  return { listDispatch, lister, factory: vi.fn(() => lister) };
}

async function lapseWith(tables: Tables, options: R1OrphanLapseOptions, rpc = settleRpc()) {
  const db = createFakeDb(tables, rpc);
  const result = await lapseOrphanedR1Sessions(db.client as never, NOW, options);
  return { db, result };
}

const staleWaiting = (n = 1, patch: Row = {}): Row => session(n, {
  status: 'waiting', started_at: minutesAgo(40), waiting_at: minutesAgo(25), updated_at: minutesAgo(25), ...patch,
});

describe('a stale waiting session whose worker is alive is not expired under it', () => {
  it('leaves it for the worker when the room has a dispatch with a live job, and asks about THAT room', async () => {
    const tables = tablesWith(staleWaiting());
    const before = { ...tables.call_sessions![0]! };
    const asked = listerOf([dispatchOf([liveJob])]);
    const { db, result } = await lapseWith(tables, { dispatches: asked.factory });
    expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 0 });
    expect(tables.call_sessions![0]).toEqual(before);
    expect(db.rpcCalls).toHaveLength(0);
    expect(asked.listDispatch).toHaveBeenCalledTimes(1);
    expect(asked.listDispatch).toHaveBeenCalledWith(`screening-${SID(1)}`);
  });

  it.each([
    ['no dispatch at all', []],
    ['a dispatch no worker accepted', [dispatchOf([])]],
    ['a finished job (JS_SUCCESS)', [dispatchOf([{ id: 'j', state: { status: 'JS_SUCCESS' } }])]],
    ['a failed job (JS_FAILED)', [dispatchOf([{ id: 'j', state: { status: 'JS_FAILED' } }])]],
    ['a job with an endedAt stamp', [dispatchOf([{ id: 'j', state: { status: 'JS_RUNNING', endedAt: 1_700_000_000n } }])]],
  ])('still expires it when the room has %s', async (_label, listed) => {
    const tables = tablesWith(staleWaiting());
    const { result } = await lapseWith(tables, { dispatches: listerOf(listed as unknown[]).factory });
    expect(result).toEqual({ scanned: 1, lapsed: 1, settled: 1, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({ status: 'expired', terminal_reason: 'idle_timeout' });
  });

  it('one live dispatch among dead ones is enough to spare it', async () => {
    const tables = tablesWith(staleWaiting());
    const listed = [dispatchOf([{ id: 'j', state: { status: 'JS_FAILED' } }], 'AD_dead'), dispatchOf([liveJob], 'AD_live')];
    const { result } = await lapseWith(tables, { dispatches: listerOf(listed).factory });
    expect(result).toMatchObject({ lapsed: 0, errors: 0 });
    expect(tables.call_sessions![0]!.status).toBe('waiting');
  });

  it('a room the SFU no longer knows (not_found) has no worker: the row expires', async () => {
    const gone = Object.assign(new Error('room does not exist'), { code: 'not_found', status: 404 });
    const tables = tablesWith(staleWaiting());
    const { result } = await lapseWith(tables, { dispatches: listerOf(gone).factory });
    expect(result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
  });

  it('an unreadable listing proves nothing: not expired, counted, and the next pass retries', async () => {
    const tables = tablesWith(staleWaiting());
    const first = await lapseWith(tables, { dispatches: listerOf(new Error('SFU down')).factory });
    expect(first.result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 1 });
    expect(tables.call_sessions![0]!.status).toBe('waiting');
    expect(first.db.rpcCalls).toHaveLength(0);

    const second = await lapseWith(tables, { dispatches: listerOf([]).factory });
    expect(second.result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
  });

  it('a listing that never answers is unreadable after the probe limit, and the pass still returns', async () => {
    vi.useFakeTimers();
    try {
      const tables = tablesWith(staleWaiting());
      const hung = { listDispatch: () => new Promise<never>(() => undefined) } as unknown as DispatchListerLike;
      const pending = lapseWith(tables, { dispatches: () => hung });
      await vi.advanceTimersByTimeAsync(R1_ORPHAN_LAPSE_BOUNDS.dispatchProbeMs + 1);
      const { result } = await pending;
      expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 1 });
      expect(tables.call_sessions![0]!.status).toBe('waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lister that cannot be built is an unreadable listing, not a crash', async () => {
    const tables = tablesWith(staleWaiting());
    const { result } = await lapseWith(tables, { dispatches: () => { throw new Error('bad url'); } });
    expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 1 });
    expect(tables.call_sessions![0]!.status).toBe('waiting');
  });

  it('with no R1 SFU to ask (no lister), the timestamps alone decide, as before', async () => {
    for (const options of [{}, { dispatches: () => null }]) {
      const tables = tablesWith(staleWaiting());
      const { result } = await lapseWith(tables, options);
      expect(result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
    }
  });

  it('defers only up to the ceiling: an hour idle expires it whatever the SFU says', async () => {
    const ceilingMin = R1_ORPHAN_LAPSE_BOUNDS.waitingLiveJobCeilingSec / 60;
    expect(ceilingMin).toBeGreaterThan(R1_ORPHAN_LAPSE_BOUNDS.waitingIdleSec / 60);
    const at = (min: number): Row => staleWaiting(1, {
      started_at: minutesAgo(min + 5), waiting_at: minutesAgo(min), updated_at: minutesAgo(min),
    });

    // Just inside the ceiling: a live job, and an unreadable listing, both defer.
    const inside = tablesWith(at(ceilingMin - 1));
    expect((await lapseWith(inside, { dispatches: listerOf([dispatchOf([liveJob])]).factory })).result)
      .toMatchObject({ lapsed: 0, errors: 0 });
    expect((await lapseWith(inside, { dispatches: listerOf(new Error('down')).factory })).result)
      .toMatchObject({ lapsed: 0, errors: 1 });
    expect(inside.call_sessions![0]!.status).toBe('waiting');

    // Past it: a zombie job and a dead SFU can no longer hold the global slot.
    for (const listed of [[dispatchOf([liveJob])], new Error('down')]) {
      const past = tablesWith(at(ceilingMin + 1));
      const asked = listerOf(listed);
      const { result } = await lapseWith(past, { dispatches: asked.factory });
      expect(result).toEqual({ scanned: 1, lapsed: 1, settled: 1, errors: 0 });
      expect(past.call_sessions![0]).toMatchObject({ status: 'expired', terminal_reason: 'idle_timeout' });
      expect(asked.factory).not.toHaveBeenCalled();
    }
  });

  it('asks the SFU only for a STALE waiting row: never for fresh, created or in_progress ones', async () => {
    const tables = tablesWith(
      staleWaiting(1, { waiting_at: minutesAgo(19), updated_at: minutesAgo(19) }),
      session(2, { status: 'created', started_at: minutesAgo(30), updated_at: minutesAgo(30) }),
      session(3, { status: 'in_progress', started_at: minutesAgo(180), updated_at: minutesAgo(120) }),
    );
    const asked = listerOf([dispatchOf([liveJob])]);
    const { result } = await lapseWith(tables, { dispatches: asked.factory });
    expect(result).toMatchObject({ scanned: 3, lapsed: 2, errors: 0 });
    expect(asked.factory).not.toHaveBeenCalled();
    expect(asked.listDispatch).not.toHaveBeenCalled();
    expect(tables.call_sessions!.map((s) => s.status)).toEqual(['waiting', 'failed', 'failed']);
  });

  it('builds the lister once per pass and asks once per stale waiting row', async () => {
    const tables = tablesWith(staleWaiting(1), staleWaiting(2));
    const asked = listerOf([dispatchOf([liveJob])]);
    const { result } = await lapseWith(tables, { dispatches: asked.factory });
    expect(result).toMatchObject({ scanned: 2, lapsed: 0, errors: 0 });
    expect(asked.factory).toHaveBeenCalledTimes(1);
    expect(asked.listDispatch.mock.calls.map((call) => call[0])).toEqual([`screening-${SID(1)}`, `screening-${SID(2)}`]);
  });
});

describe('a candidate retry is activity: it restarts the waiting window', () => {
  // The exchange stamps `updated_at` on every waiting rejoin (routes/r1-candidate.ts); the lapse reads it.
  const waitingMin = R1_ORPHAN_LAPSE_BOUNDS.waitingIdleSec / 60;
  const rejoinedAt = (minutesSinceRejoin: number): Row => staleWaiting(1, {
    started_at: minutesAgo(50), waiting_at: minutesAgo(40), updated_at: minutesAgo(minutesSinceRejoin),
  });

  it('a rejoin one minute inside the bound is not lapsed, however old the session is', async () => {
    const tables = tablesWith(rejoinedAt(waitingMin - 1));
    const before = { ...tables.call_sessions![0]! };
    const asked = listerOf([]);
    const { db, result } = await lapseWith(tables, { dispatches: asked.factory });
    expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 0 });
    expect(tables.call_sessions![0]).toEqual(before);
    expect(db.rpcCalls).toHaveLength(0);
    expect(asked.factory).not.toHaveBeenCalled();
  });

  it('the window is measured from the rejoin: one minute past it, the row lapses (last activity as ended_at)', async () => {
    const tables = tablesWith(rejoinedAt(waitingMin + 1));
    const { result } = await lapseWith(tables, { dispatches: listerOf([]).factory });
    expect(result).toMatchObject({ lapsed: 1, settled: 1, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({
      status: 'expired', terminal_reason: 'idle_timeout', ended_at: minutesAgo(waitingMin + 1),
    });
  });

  it('a rejoin that lands between the scan and the write wins: zero rows, no lapse, no error, no settle', async () => {
    const tables = tablesWith(staleWaiting());
    const db = createFakeDb(tables, settleRpc());
    const racing = {
      ...db.client,
      from: (table: string) => {
        const q = db.client.from(table);
        if (table === 'call_sessions') {
          const update = q.update;
          q.update = (value: Row) => {
            tables.call_sessions![0]!.updated_at = NOW.toISOString(); // the candidate retried just now
            return update(value);
          };
        }
        return q;
      },
    };
    const result = await lapseOrphanedR1Sessions(racing as never, NOW, { dispatches: listerOf([]).factory });
    expect(result).toEqual({ scanned: 1, lapsed: 0, settled: 0, errors: 0 });
    expect(tables.call_sessions![0]).toMatchObject({ status: 'waiting', terminal_reason: null, ended_at: null });
    expect(settleCalls(db)).toHaveLength(0);
  });
});

describe('the r1-status loop runs it', () => {
  const ENABLED = { enabled: true, status: 'enabled' as const };
  const makeQueue = () => {
    const clock = (): string => NOW.toISOString();
    return new Queue(new MemoryAdapter({ clock }), { clock });
  };

  it('lapses an orphan on the status tick, only while R1 is enabled, and reports it in the snapshot', async () => {
    const tables = tablesWith(session(1, { status: 'waiting', waiting_at: minutesAgo(30), updated_at: minutesAgo(30) }));
    const db = createFakeDb(tables, (fn) => (fn === 'r1_apply_due_pending_rejects' ? { data: 0 } : { data: { status: 'ok' } }));
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue: makeQueue(), now: () => NOW })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(tables.call_sessions![0]).toMatchObject({ status: 'expired', terminal_reason: 'idle_timeout' });
    expect(runtime.snapshot()).toMatchObject({ lastOrphansLapsed: 1, orphanLapseErrors: 0, statusLoopErrors: 0 });
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(['r1_apply_due_pending_rejects', 'r1_settle_attempt']);

    const off = tablesWith(session(1, { updated_at: minutesAgo(300) }));
    off.r1_settings![0]!.enabled = false;
    const offDb = createFakeDb(off);
    const offRuntime = createR1Runtime({ config: ENABLED, client: offDb.client as never, queue: makeQueue(), now: () => NOW })!;
    await offRuntime.tickAll();
    await offRuntime.runner.stop();
    expect(off.call_sessions![0]!.status).toBe('created');
    expect(offDb.rpcCalls).toHaveLength(0);
  });

  it('a failing pending-reject sweep never skips the lapse, and a failing lapse never breaks the sweep', async () => {
    const tables = tablesWith(session(1, { updated_at: minutesAgo(300) }));
    const db = createFakeDb(tables, (fn) =>
      (fn === 'r1_apply_due_pending_rejects' ? { error: { message: 'down' } } : { data: { status: 'ok' } }));
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue: makeQueue(), now: () => NOW })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(runtime.snapshot()).toMatchObject({ statusLoopErrors: 1, lastOrphansLapsed: 1, orphanLapseErrors: 0 });
    expect(tables.call_sessions![0]!.status).toBe('failed');

    const sweepOnly = createFakeDb(tablesWith(session(1, { updated_at: minutesAgo(300) })),
      (fn) => (fn === 'r1_apply_due_pending_rejects' ? { data: 3 } : { data: { status: 'ok' } }));
    const throwingLapse = {
      ...sweepOnly.client,
      from: (table: string) => {
        if (table === 'call_sessions') throw new Error('connection refused');
        return sweepOnly.client.from(table);
      },
    };
    const safe = createR1Runtime({ config: ENABLED, client: throwingLapse as never, queue: makeQueue(), now: () => NOW })!;
    await safe.tickAll();
    await safe.runner.stop();
    expect(safe.snapshot()).toMatchObject({ lastStatusApplied: 3, statusLoopErrors: 0, orphanLapseErrors: 1 });
  });

  it('hands the lapse its dispatch lister: a stale waiting row with a live worker survives the tick', async () => {
    const tables = tablesWith(staleWaiting());
    const db = createFakeDb(tables, (fn) => (fn === 'r1_apply_due_pending_rejects' ? { data: 0 } : { data: { status: 'ok' } }));
    const asked = listerOf([dispatchOf([liveJob])]);
    const runtime = createR1Runtime({
      config: ENABLED, client: db.client as never, queue: makeQueue(), now: () => NOW, dispatches: asked.factory,
    })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(tables.call_sessions![0]!.status).toBe('waiting');
    expect(asked.listDispatch).toHaveBeenCalledWith(`screening-${SID(1)}`);
    expect(runtime.snapshot()).toMatchObject({ lastOrphansLapsed: 0, orphanLapseErrors: 0 });
  });

  it('adds no loop and no queue: the runtime still has exactly r1-assessment and r1-status', () => {
    const runtime = createR1Runtime({ config: ENABLED, client: createFakeDb(baseTables()).client as never, queue: makeQueue() })!;
    expect(Object.keys(runtime.loopIntervalsMs)).toEqual(['r1-assessment', 'r1-status']);
    expect([...runtime.queues]).toEqual(['r1.assessment']);
  });
});

describe('structural', () => {
  it('only compare-and-sets live statuses: it never writes a terminal row or a phone session', () => {
    const text = readFileSync(path.resolve(here, '../lib/r1/orphan-lapse.ts'), 'utf8');
    expect(text).toContain(".eq('status', fromStatus)");
    expect(text).toContain(".lte('updated_at'");
    expect(text).toContain(".eq('mode', 'browser')");
    expect(text).toContain(".not('interview_round_id', 'is', null)");
    expect(text).toContain("const LIVE_STATUSES = Object.keys(PLANS)");
  });
});

describe('the default R1 dispatch lister', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is absent unless the browser lane targets the R1 SFU with all three credentials', () => {
    vi.stubEnv('BROWSER_LIVEKIT_TARGET', '');
    expect(defaultR1DispatchLister()).toBeNull();
    vi.stubEnv('BROWSER_LIVEKIT_TARGET', 'cloud');
    expect(defaultR1DispatchLister()).toBeNull();

    vi.stubEnv('BROWSER_LIVEKIT_TARGET', 'r1');
    vi.stubEnv('R1_LIVEKIT_URL', 'wss://r1.example.test');
    vi.stubEnv('R1_LIVEKIT_API_KEY', 'r1-test-key');
    vi.stubEnv('R1_LIVEKIT_API_SECRET', '');
    expect(defaultR1DispatchLister()).toBeNull();
  });

  it('is the R1 SFU agent-dispatch client once configured', () => {
    vi.stubEnv('BROWSER_LIVEKIT_TARGET', 'r1');
    vi.stubEnv('R1_LIVEKIT_URL', 'wss://r1.example.test');
    vi.stubEnv('R1_LIVEKIT_API_KEY', 'r1-test-key');
    vi.stubEnv('R1_LIVEKIT_API_SECRET', 's'.repeat(32));
    const lister = defaultR1DispatchLister();
    expect(lister).not.toBeNull();
    expect(typeof lister!.listDispatch).toBe('function');
  });
});
