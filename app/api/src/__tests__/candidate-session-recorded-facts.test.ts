/**
 * M013 S02 (T07): the candidate detail's per-session header facts —
 * `recorded_total_sec`, `recorded_legs`, `connected_complete`,
 * `connected_total_sec` — built from the session's phone legs.
 *
 * WHY. The header said "7m 23s on the call" for 9f60523d from
 * `duration_sec` = 443 s: leg 1 to the reconciler's detection plus leg 2 up to
 * the lease reclaim, ~6 minutes after the candidate hung up. The audio that
 * exists is 53 s + 18 s. These facts let the header say "Recorded 1m 11s
 * across 2 calls" and show a connected time only when every leg's end is
 * known. Fixtures are synthetic: placeholder ids, real timings only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const { candidatesRouter } = await import('../routes/candidates.js');
const { supabase } = await import('../lib/supabase.js');

const CANDIDATE = '00000000-0000-4000-8000-000000000301';
const S_PHONE = '00000000-0000-4000-8000-000000000302';
const S_BROWSER = '00000000-0000-4000-8000-000000000303';
const S_OTHER = '00000000-0000-4000-8000-000000000304';
const LEG_A = '00000000-0000-4000-8000-0000000003a1';
const LEG_B = '00000000-0000-4000-8000-0000000003b2';

let sessions: Array<Record<string, unknown>>;
let legs: Array<Record<string, unknown>>;
let legsError: unknown;
let legFilters: string[];
let legLimits: number[];
let legSelects: string[];
/** phone_call_events rows the leg facts read (reconciler-detected ends). */
let events: Array<Record<string, unknown>>;

function chain(table: string): any {
  const self: any = {
    select(columns: string) {
      if (table === 'phone_call_attempts') legSelects.push(columns);
      return self;
    },
    eq: () => self,
    not: () => self,
    in: () => self,
    is: () => self,
    gte: () => self,
    order: () => self,
    range: () => self,
    or(filter: string) {
      if (table === 'phone_call_attempts') legFilters.push(filter);
      return self;
    },
    limit(n: number) {
      if (table === 'phone_call_attempts') legLimits.push(n);
      return self;
    },
    single: () => Promise.resolve({ data: { id: CANDIDATE, status: 'screening' }, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      const result = table === 'call_sessions'
        ? { data: sessions, error: null }
        : table === 'phone_call_attempts'
          ? (legsError ? { data: null, error: legsError } : { data: legs, error: null })
          : table === 'phone_call_events'
            ? { data: events, error: null }
            : { data: [], error: null };
      return Promise.resolve(result).then(res, rej);
    },
  };
  return self;
}

function app(role: 'admin' | 'viewer' | 'interviewer' = 'admin', id = 'user-1') {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id, appRole: role, active: true };
    next();
  });
  a.use('/api/candidates', candidatesRouter);
  a.use(finalErrorHandler);
  return a;
}

/** A legacy worker MP3 leg (size only), the 9f60523d shape. */
function leg(id: string, fields: Record<string, unknown>) {
  return {
    id,
    session_id: S_PHONE,
    recording_session_id: S_PHONE,
    abandon_reason: null,
    recording_object_key: `phone-${id}-worker.mp3`,
    recording_content_type: 'audio/mpeg',
    egress_id: `EG_worker_${id}`,
    egress_status: 'complete',
    observed_ended_at: null,
    recording_started_at_ms: null,
    recording_duration_ms: null,
    recording_tail_flushed: null,
    ...fields,
  };
}

const zeroAnswerLegs = () => [
  leg(LEG_A, {
    admitted_at: '2026-10-06T03:30:30.000Z',
    answered_at: '2026-10-06T03:30:46.822Z',
    ended_at: '2026-10-06T03:32:02.356Z',
    state: 'ended',
    outcome_class: 'disconnected',
    recording_size_bytes: 425_708,
  }),
  leg(LEG_B, {
    admitted_at: '2026-10-06T03:34:30.000Z',
    answered_at: '2026-10-06T03:34:49.612Z',
    ended_at: '2026-10-06T03:40:57.456Z',
    state: 'abandoned',
    outcome_class: null,
    recording_size_bytes: 140_972,
  }),
];

beforeEach(() => {
  sessions = [{ id: S_PHONE, owner_id: null, status: 'completed', duration_sec: 443 }];
  legs = zeroAnswerLegs();
  legsError = null;
  legFilters = [];
  legLimits = [];
  legSelects = [];
  events = [];
  vi.mocked(supabase.from).mockImplementation((t: string) => chain(t) as never);
});
afterEach(() => vi.restoreAllMocks());

const get = (role?: 'admin' | 'viewer' | 'interviewer', id?: string) =>
  request(app(role, id)).get(`/api/candidates/${CANDIDATE}`);

describe('candidate detail: per-session recorded facts (M013 S02 T07)', () => {
  it('9f60523d shape: recorded 70.8 s across 2 legs, connected NOT complete, no 443-based length', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const session = res.body.sessions[0];
    expect(session).toMatchObject({
      recorded_total_sec: 70.8,
      recorded_legs: 2,
      connected_complete: false,
      connected_total_sec: null,
    });
    // duration_sec is passed through untouched (0125 recomputes it); the new
    // facts never repeat it as a call length.
    for (const key of ['recorded_total_sec', 'connected_total_sec']) {
      expect(session[key]).not.toBe(443);
    }
  });

  it('reads every session\'s legs in ONE bounded query, by either binding', async () => {
    sessions = [
      { id: S_PHONE, owner_id: null, status: 'completed' },
      { id: S_OTHER, owner_id: null, status: 'waiting' },
    ];
    await get();
    expect(legFilters).toEqual([
      `session_id.in.(${S_PHONE},${S_OTHER}),recording_session_id.in.(${S_PHONE},${S_OTHER})`,
    ]);
    expect(legLimits).toEqual([501]);
    // The columns the per-leg rule needs; nothing that would leak.
    const columns = legSelects[0].split(',');
    for (const c of ['observed_ended_at', 'recording_duration_ms', 'recording_tail_flushed', 'egress_id', 'abandon_reason']) {
      expect(columns).toContain(c);
    }
  });

  it('every leg end known: connected_complete with the connected total (observed end preferred)', async () => {
    legs = [
      leg(LEG_A, {
        admitted_at: '2026-10-07T04:00:00.000Z',
        answered_at: '2026-10-07T04:00:10.000Z',
        ended_at: '2026-10-07T04:01:24.000Z',
        observed_ended_at: '2026-10-07T04:01:10.500Z',
        state: 'ended',
        outcome_class: 'disconnected',
        recording_size_bytes: 480_000,
        recording_duration_ms: 59_450,
        recording_tail_flushed: true,
      }),
      leg(LEG_B, {
        admitted_at: '2026-10-07T04:03:00.000Z',
        answered_at: '2026-10-07T04:03:10.000Z',
        ended_at: '2026-10-07T04:05:10.000Z',
        state: 'ended',
        outcome_class: 'completed',
        recording_size_bytes: 950_000,
        recording_duration_ms: 119_000,
        recording_tail_flushed: true,
      }),
    ];
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({
      recorded_total_sec: 178.45,
      recorded_legs: 2,
      connected_complete: true,
      connected_total_sec: 180.5,
    });
  });

  it('a pre-consent leg bound only by recording_session_id belongs to its session (32757295 shape)', async () => {
    sessions = [{ id: S_OTHER, owner_id: null, status: 'waiting' }];
    legs = [leg(LEG_A, {
      session_id: null,
      recording_session_id: S_OTHER,
      admitted_at: '2026-10-05T05:00:00.000Z',
      answered_at: '2026-10-05T05:00:20.000Z',
      ended_at: '2026-10-05T05:00:54.600Z',
      state: 'ended',
      outcome_class: 'voicemail',
      recording_size_bytes: 261_600,
    })];
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({
      recorded_total_sec: 32.7,
      recorded_legs: 1,
      connected_complete: true,
      connected_total_sec: 34.6,
    });
  });

  it('a session with no phone legs (browser) reports every fact as null', async () => {
    sessions = [{ id: S_BROWSER, owner_id: null, status: 'completed', mode: 'browser', duration_sec: 300 }];
    legs = [];
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({
      duration_sec: 300,
      recorded_total_sec: null,
      recorded_legs: null,
      connected_complete: null,
      connected_total_sec: null,
    });
  });

  it('a phone session whose legs have no known recording: 0 legs recorded, total null (never 0 s)', async () => {
    legs = zeroAnswerLegs().map((l) => ({ ...l, recording_object_key: null, recording_size_bytes: null, egress_id: null }));
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({ recorded_total_sec: null, recorded_legs: 0 });
  });

  it('an unread or possibly truncated leg read is UNKNOWN, never a confident short total, and never fails the page', async () => {
    legsError = { message: 'pooler reset' };
    let res = await get();
    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toMatchObject({
      recorded_total_sec: null,
      recorded_legs: null,
      connected_complete: null,
      connected_total_sec: null,
    });

    legsError = null;
    legs = Array.from({ length: 501 }, (_, i) => leg(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, {
      admitted_at: '2026-10-06T03:30:30.000Z',
      answered_at: null,
      ended_at: null,
      state: 'ended',
      outcome_class: 'no_answer',
      recording_size_bytes: 8000,
    }));
    res = await get();
    expect(res.body.sessions[0]).toMatchObject({ recorded_total_sec: null, recorded_legs: null });
  });

  it('an interviewer who does not own the session gets no recorded facts; connected facts stay', async () => {
    sessions = [{ id: S_PHONE, owner_id: 'someone-else', status: 'completed' }];
    const res = await get('interviewer', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toMatchObject({
      recorded_total_sec: null,
      recorded_legs: null,
      connected_complete: false,
    });

    sessions = [{ id: S_PHONE, owner_id: 'user-1', status: 'completed' }];
    const own = await get('interviewer', 'user-1');
    expect(own.body.sessions[0]).toMatchObject({ recorded_total_sec: 70.8, recorded_legs: 2 });
  });

  it('a session whose recording was erased, revoked or quarantined counts no recorded audio (review, S02)', async () => {
    for (const lifecycle of [
      { recording_deleted_at: '2026-10-07T00:00:00.000Z' },
      { recording_revoked_at: '2026-10-07T00:00:00.000Z' },
      { recording_quarantined: true },
    ]) {
      sessions = [{ id: S_PHONE, owner_id: null, status: 'completed', ...lifecycle }];
      const res = await get();
      expect(res.body.sessions[0]).toMatchObject({
        recorded_total_sec: null,
        recorded_legs: 0,
        recorded_unknown_legs: 0,
        // Call facts are not audio facts: they stay.
        connected_complete: false,
      });
    }
    // An erased or quarantined LEG on a live session drops only that leg.
    sessions = [{ id: S_PHONE, owner_id: null, status: 'completed' }];
    legs = zeroAnswerLegs().map((l, i) => (i === 0 ? { ...l, recording_deleted_at: '2026-10-07T00:00:00.000Z' } : l));
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({ recorded_total_sec: 17.6, recorded_legs: 1 });
  });

  it('a leg with audio of unknown length is reported, so the total is not presented as complete', async () => {
    legs = zeroAnswerLegs().map((l, i) => (i === 0
      ? { ...l, recording_content_type: 'audio/ogg', recording_object_key: `phone-${LEG_A}-worker.ogg` }
      : l));
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({ recorded_total_sec: 17.6, recorded_legs: 1, recorded_unknown_legs: 1 });
  });

  it('a reconciler-detected leg end leaves connected incomplete: no "on the call" figure', async () => {
    legs = [leg(LEG_A, {
      admitted_at: '2026-10-07T04:00:00.000Z',
      answered_at: '2026-10-07T04:00:10.000Z',
      ended_at: '2026-10-07T04:01:24.000Z',
      state: 'ended',
      outcome_class: 'disconnected',
      recording_size_bytes: 480_000,
    })];
    events = [{ attempt_id: LEG_A, event_type: 'sip.participant_left', source: 'reconciliation', applied: true }];
    const res = await get();
    expect(res.body.sessions[0]).toMatchObject({ connected_complete: false, connected_total_sec: null });
  });

  it('never returns a storage key or provider id through the new facts', async () => {
    const res = await get();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('EG_worker_');
    expect(body).not.toContain('worker.mp3');
  });
});
