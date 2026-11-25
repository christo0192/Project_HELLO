/**
 * POST /api/internal/r1/attempt-outcome: the route the R1 worker core calls
 * after its durable terminal write (payload and outcome set read from
 * origin/r1/pr4a-worker-core: app/voice-livekit/r1_persistence.py).
 *
 * The count-or-not rule (plan D1) is applied by `r1_settle_attempt` in SQL;
 * here the route's contract is pinned: worker authentication, strict payload
 * validation, the stable response codes the worker logs against, and that it
 * is never gated on R1 switches.
 *
 * M034 S06: on `ok` or `duplicate` the route also queues the Meet bot's leave
 * (`notifyR1MeetAttemptEnded`, fire-and-forget). With Meet off it reads nothing
 * (every test above runs with the Meet flag unset); with Meet on it makes one
 * booking lookup and queues one `attempt_ended` job 5 s later, and nothing it
 * does can change the route's answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FAKE_RECALL_API_KEY } from './support/recall-fake.js';
import { createR1MeetFakeDb, type R1MeetFakeDb } from './support/r1-meet-fake-db.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
}));

import { r1InternalRouter } from '../routes/r1.js';

const SECRET = 'r'.repeat(32);
const ATTEMPT = '30000000-0000-4000-8000-0000000000e1';
/** OUTCOME_DISPOSITIONS keys in r1_persistence.py: the worker's complete outcome set. */
const WORKER_OUTCOMES = [
  'complete',
  'candidate_left',
  'no_show',
  'provider_error',
  'residency_timeout',
  'shutdown_forced',
  'configuration_failed',
  'context_failed',
];

function appFor() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/r1', r1InternalRouter);
  return app;
}

const send = (body: unknown, auth: string | null = `Bearer ${SECRET}`) => {
  const req = request(appFor()).post('/api/internal/r1/attempt-outcome');
  return (auth === null ? req : req.set('authorization', auth)).send(body as object);
};

beforeEach(() => {
  process.env.WORKER_CONTEXT_SECRET = SECRET;
  process.env.R1_ENABLED = 'true';
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.rpc.mockResolvedValue({ data: { status: 'ok', counted: true }, error: null });
});

describe('POST /api/internal/r1/attempt-outcome', () => {
  it('uses the same worker authentication as the other internal R1 routes', async () => {
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' }, null)).status).toBe(401);
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' }, 'Bearer wrong')).status)
      .toBe(403);
    delete process.env.WORKER_CONTEXT_SECRET;
    const unconfigured = await send({ attempt_id: ATTEMPT, outcome: 'complete' });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error).toBe('worker_auth_not_configured');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(WORKER_OUTCOMES)('settles the worker outcome %s with exact RPC args', async (outcome) => {
    const response = await send({ attempt_id: ATTEMPT, outcome });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true, counted: true, duplicate: false });
    expect(mocks.rpc).toHaveBeenCalledWith('r1_settle_attempt', {
      p_session_id: ATTEMPT,
      p_outcome: outcome,
    });
  });

  it.each([
    {},
    { outcome: 'complete' },
    { attempt_id: ATTEMPT },
    { attempt_id: 'not-a-uuid', outcome: 'complete' },
    { attempt_id: ATTEMPT, outcome: 'finished' },
    { attempt_id: ATTEMPT, outcome: 7 },
    { attempt_id: 7, outcome: 'complete' },
  ])('rejects the payload %j before any database work', async (body) => {
    const response = await send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_attempt_outcome' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers an identical replay with 200 and the stored count decision', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'duplicate', counted: false }, error: null });
    const response = await send({ attempt_id: ATTEMPT, outcome: 'no_show' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, counted: false, duplicate: true });
  });

  it('reports an uncounted first settlement', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'ok', counted: false }, error: null });
    const response = await send({ attempt_id: ATTEMPT, outcome: 'provider_error' });
    expect(response.status).toBe(201);
    expect(response.body.counted).toBe(false);
  });

  it('maps unknown attempt, conflicting outcome and rejected outcome to stable codes', async () => {
    const cases: Array<[string, number, string]> = [
      ['attempt_not_found', 404, 'r1_attempt_not_found'],
      ['outcome_conflict', 409, 'r1_outcome_conflict'],
      ['session_not_settled', 409, 'r1_session_not_settled'],
      ['invalid_outcome', 400, 'invalid_attempt_outcome'],
      ['anything_else', 503, 'service_unavailable'],
    ];
    for (const [status, http, error] of cases) {
      mocks.rpc.mockResolvedValueOnce({ data: { status }, error: null });
      const response = await send({ attempt_id: ATTEMPT, outcome: 'complete' });
      expect(response.status).toBe(http);
      expect(response.body).toEqual({ error });
    }
  });

  it('refuses an outcome for a session that is not settled (not a conflict)', async () => {
    // r1_settle_attempt answers `session_not_settled` for a live session, a
    // session of another round or mode, and `complete` for a failed session. The
    // worker (r1_persistence.py) logs any non-404 error and moves on, so the
    // attempt is simply not counted.
    mocks.rpc.mockResolvedValue({ data: { status: 'session_not_settled' }, error: null });
    for (const outcome of WORKER_OUTCOMES) {
      const response = await send({ attempt_id: ATTEMPT, outcome });
      expect(response.status, outcome).toBe(409);
      expect(response.body, outcome).toEqual({ error: 'r1_session_not_settled' });
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('answers 503 when the database fails, so the worker logs and moves on', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(503);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(503);
  });

  it('is never gated on the R1 master switch: a worker must always be able to settle', async () => {
    process.env.R1_ENABLED = 'false';
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(201);
    delete process.env.R1_ENABLED;
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(201);
  });

  it('ignores a room or any extra key and reads no table directly', async () => {
    const response = await send({
      attempt_id: ATTEMPT,
      outcome: 'complete',
      room: `screening-${ATTEMPT}`,
      persona_id: 'p1',
    });
    expect(response.status).toBe(201);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls[0]![1]).toEqual({ p_session_id: ATTEMPT, p_outcome: 'complete' });
  });
});

describe('M034 S06: the Meet bot leaves after a settled attempt (dark)', () => {
  interface Inserted {
    name: string;
    payload: Record<string, unknown>;
    dedup_key: string;
    max_attempts: number;
    scheduled_at: string;
    created_at: string;
  }
  let fake: R1MeetFakeDb;
  let inserted: Inserted[];
  let insertFails: boolean;
  let warnings: string[];

  function meetOn(): void {
    vi.stubEnv('R1_MEET_ENABLED', 'true');
    vi.stubEnv('RECALL_API_KEY', FAKE_RECALL_API_KEY);
    // Built at run time: never a secret-shaped literal.
    vi.stubEnv('RECALL_WEBHOOK_SECRET', 'whsec' + '_' + Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('R1_MEET_ASHBY_DEX_USER_ID', '7f000000-0000-4000-8000-0000000000d1');
    vi.stubEnv('WEB_ORIGIN', 'https://hello.example.test');
  }

  /** A Meet booking in a call, bound to the attempt's session. */
  function meetBooking(): string {
    const round = fake.addRound();
    const row = fake.seedBooking({
      status: 'in_call',
      reason: 'eligible',
      round_id: round.id,
      recall_bot_id: '7f000000-0000-4000-8000-0000000000a1',
      session_id: ATTEMPT,
    });
    return row.id as string;
  }

  beforeEach(() => {
    fake = createR1MeetFakeDb();
    inserted = [];
    insertFails = false;
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    mocks.from.mockImplementation((table: string) => {
      if (table !== 'job_queue') return fake.client.from(table);
      return {
        insert: (row: Inserted) => ({
          select: () => ({
            single: async () => {
              if (insertFails) return { data: null, error: { code: 'XX000', message: 'down' } };
              inserted.push(row);
              return { data: { id: 'job-1', status: 'pending', priority: 0, attempts: 0, ...row }, error: null };
            },
          }),
        }),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('Meet off: ok and duplicate read no table at all', async () => {
    meetBooking();
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(201);
    mocks.rpc.mockResolvedValue({ data: { status: 'duplicate', counted: true }, error: null });
    expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.from).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['ok', 201],
    ['duplicate', 200],
  ])('Meet on, settled %s: one lookup, one attempt_ended job 5 s later, ids only', async (status, http) => {
    meetOn();
    const bookingId = meetBooking();
    mocks.rpc.mockResolvedValue({ data: { status, counted: true }, error: null });
    const response = await send({ attempt_id: ATTEMPT, outcome: 'complete' });
    expect(response.status).toBe(http);
    await vi.waitFor(() => expect(inserted).toHaveLength(1));
    const [job] = inserted;
    expect(job!.name).toBe('r1-meet');
    expect(job!.payload).toEqual({ kind: 'attempt_ended', booking_id: bookingId, session_id: ATTEMPT });
    expect(job!.dedup_key).toBe(`r1-meet:attempt-ended:${ATTEMPT}`);
    expect(job!.max_attempts).toBe(10);
    const delay = Date.parse(job!.scheduled_at) - Date.parse(job!.created_at);
    expect(delay).toBeGreaterThan(4000);
    expect(delay).toBeLessThanOrEqual(5000);
    expect(fake.calls.filter((call) => call.kind === 'from').map((call) => call.name)).toEqual(['r1_meet_bookings']);
    expect(warnings).toEqual([]);
  });

  it('Meet on, a browser session: the lookup only, nothing queued', async () => {
    meetOn();
    const response = await send({ attempt_id: ATTEMPT, outcome: 'complete' });
    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inserted).toEqual([]);
    expect(mocks.from.mock.calls.map((call) => call[0])).toEqual(['r1_meet_bookings']);
  });

  it('a failed lookup or enqueue never changes the answer: one closed warning, no id', async () => {
    meetOn();
    meetBooking();
    fake.failNext('r1_meet_bookings');
    const first = await send({ attempt_id: ATTEMPT, outcome: 'complete' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true, counted: true, duplicate: false });
    await vi.waitFor(() => expect(warnings).toHaveLength(1));

    insertFails = true;
    const second = await send({ attempt_id: ATTEMPT, outcome: 'complete' });
    expect(second.status).toBe(201);
    await vi.waitFor(() => expect(warnings).toHaveLength(2));
    for (const line of warnings) {
      expect(JSON.parse(line)).toMatchObject({ level: 'warn', component: 'r1-meet', error_category: 'r1_meet_attempt_ended_enqueue_failed' });
      expect(line).not.toContain(ATTEMPT);
    }
    expect(inserted).toEqual([]);
  });

  it('a refused, unknown or failed settlement queues nothing and reads nothing', async () => {
    meetOn();
    meetBooking();
    for (const [data, http] of [
      [{ status: 'outcome_conflict' }, 409],
      [{ status: 'session_not_settled' }, 409],
      [{ status: 'attempt_not_found' }, 404],
      [{ status: 'invalid_outcome' }, 400],
      [null, 503],
    ] as const) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null });
      expect((await send({ attempt_id: ATTEMPT, outcome: 'complete' })).status).toBe(http);
    }
    expect((await send({ attempt_id: 'not-a-uuid', outcome: 'complete' })).status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.from).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });
});
