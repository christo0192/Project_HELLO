import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { candidatesRouter } from '../routes/candidates.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const { supabase } = await import('../lib/supabase.js');

const CANDIDATE = '00000000-0000-4000-8000-000000000101';
const ENGAGEMENT = '00000000-0000-4000-8000-000000000102';
const SESSION = '00000000-0000-4000-8000-000000000103';
const IDS = [
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-000000000113',
];
const TIED = '2026-09-25T13:00:00.000Z';

let attempts: Array<Record<string, unknown>>;
let cursorFilters: string[];
let turns: Array<Record<string, unknown>>;
let candidateVisible = true;
let sessionRows: Array<Record<string, unknown>>;
/** phone_call_events rows (M013 S02 D8 per-leg facts). */
let events: Array<Record<string, unknown>>;
let eventsError: unknown;
/** phone_appointments rows (0113 E4 booked-callback marker). */
let appointments: Array<Record<string, unknown>>;
/** Every `.in(column, values)` on phone_call_events, and every order on attempts. */
let eventIns: Array<[string, unknown[]]>;
let attemptOrders: Array<[string, unknown]>;

function chain(table: string, result: unknown): any {
  let output = result;
  let transcriptInterviewOnly = false;
  const self: any = {
    select: () => self,
    eq: (column: string, value: unknown) => {
      if (table === 'transcript_turns' && column === 'is_gate' && value === false) transcriptInterviewOnly = true;
      return self;
    },
    in: (column: string, values: unknown[]) => {
      if (table === 'phone_call_events') eventIns.push([column, values]);
      return self;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      if (table === 'phone_call_attempts') attemptOrders.push([column, options?.ascending]);
      return self;
    },
    limit: () => self,
    range: () => self,
    or: (filter: string) => {
      cursorFilters.push(filter);
      if (table === 'phone_call_attempts') {
        const id = filter.match(/id\.lt\.([0-9a-f-]{36})/)?.[1];
        const index = id ? (result as Array<{ id: string }>).findIndex((item) => item.id === id) : -1;
        if (index >= 0) output = (result as Array<unknown>).slice(index + 1);
      }
      return self;
    },
    maybeSingle: async () => ({
      data: table === 'candidates' && candidateVisible ? { id: CANDIDATE, owner_id: 'owner-1' } : null,
      error: null,
    }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(
      table === 'phone_engagements'
        ? { data: [{ id: ENGAGEMENT }], error: null }
        : table === 'phone_call_attempts'
          ? { data: output, error: null }
          : table === 'transcript_turns'
            ? { data: transcriptInterviewOnly ? [] : turns, error: null }
            : table === 'call_sessions'
              ? { data: sessionRows, error: null }
              : table === 'phone_call_events'
                ? (eventsError ? { data: null, error: eventsError } : { data: events, error: null })
                : table === 'phone_appointments'
                  ? { data: appointments, error: null }
                  : { data: [], error: null },
    ).then(resolve),
  };
  return self;
}

function app(role: 'admin' | 'viewer' | 'interviewer' = 'admin', id = 'owner-1') {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id, appRole: role, active: true };
    next();
  });
  a.use('/api/candidates', candidatesRouter);
  a.use(finalErrorHandler);
  return a;
}

function row(id: string, admitted_at: string, recording = false) {
  return {
    id,
    attempt_seq: 1,
    admitted_at,
    answered_at: admitted_at,
    ended_at: '2026-09-25T13:00:08.000Z',
    state: 'ended',
    outcome_class: 'abandoned_pre_disclosure',
    session_id: SESSION,
    recording_object_key: recording ? `phone-${id}-egress.mp3` : null,
    recording_sha256: recording ? 'a'.repeat(64) : null,
    recording_size_bytes: recording ? 10 : null,
    recording_content_type: recording ? 'audio/mpeg' : null,
    recording_ready: recording,
    recording_quarantined: false,
    recording_deleted_at: null,
  };
}

beforeEach(() => {
  attempts = [row(IDS[0], TIED), row(IDS[1], TIED), row(IDS[2], '2026-09-24T13:00:00.000Z')];
  turns = [{ session_id: SESSION, is_gate: true }];
  cursorFilters = [];
  candidateVisible = true;
  sessionRows = [];
  events = [];
  eventsError = null;
  appointments = [];
  eventIns = [];
  attemptOrders = [];
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const result = table === 'phone_call_attempts' ? attempts : [];
    return chain(table, result) as never;
  });
});

describe('candidate phone-attempt history', () => {
  it('uses stable timestamp+id keyset pagination and omits storage/provider metadata', async () => {
    const first = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.attempts.map((a: { id: string }) => a.id)).toEqual([IDS[0], IDS[1]]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    expect(first.body.attempts[0]).not.toHaveProperty('recording_object_key');
    expect(first.body.attempts[0].recording.state).toBe('unavailable');
    expect(first.body.attempts[0].transcript.kind).toBe('gate_only');

    const second = await request(app())
      .get(`/api/candidates/${CANDIDATE}/phone-attempts?limit=2&before=${encodeURIComponent(first.body.next_cursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.attempts.map((a: { id: string }) => a.id)).toEqual([IDS[2]]);
    expect(cursorFilters.some((filter) => filter.includes(`id.lt.${IDS[1]}`))).toBe(true);
  });

  it('does not reveal another candidate to an interviewer', async () => {
    candidateVisible = false;
    const res = await request(app('interviewer', 'other-owner'))
      .get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('attempts');
  });

  it('keeps historic null-bound attempts visible without inventing recording or transcript links', async () => {
    attempts = [{ ...row(IDS[0], TIED), session_id: null, recording_session_id: null }];
    turns = [];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'no_recording' });
    expect(res.body.attempts[0].transcript).toBeNull();
  });

  it('does not call a terminal failed capture processing', async () => {
    attempts = [{
      ...row(IDS[0], TIED, true),
      recording_ready: false,
      egress_status: 'failed',
    }];
    turns = [];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'recording_failed' });
  });

  it('selects abandon_reason and returns it so an infra defer and a lease reclaim can be told apart', async () => {
    const selects: string[] = [];
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      const c = chain(table, table === 'phone_call_attempts' ? attempts : []);
      const select = c.select;
      c.select = (columns: string) => {
        if (table === 'phone_call_attempts') selects.push(columns);
        return select(columns);
      };
      return c as never;
    });
    attempts = [
      { ...row(IDS[0], TIED), state: 'abandoned', outcome_class: null, abandon_reason: 'infra_deferred' },
      { ...row(IDS[1], TIED), state: 'abandoned', outcome_class: null, abandon_reason: null },
      row(IDS[2], '2026-09-24T13:00:00.000Z'),
    ];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(selects.some((columns) => columns.split(',').includes('abandon_reason'))).toBe(true);
    expect(res.body.attempts.map((a: { abandon_reason: unknown }) => a.abandon_reason))
      .toEqual(['infra_deferred', null, null]);
  });

  it('never echoes an abandon_reason outside the 0083 CHECK allowlist', async () => {
    attempts = [
      { ...row(IDS[0], TIED), state: 'abandoned', outcome_class: null, abandon_reason: 'free text from somewhere' },
      { ...row(IDS[1], TIED), state: 'abandoned', outcome_class: null },
    ];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].abandon_reason).toBeNull();
    // A row from a select that somehow lacks the column still serializes the
    // key (null), so the required openapi property is always present.
    expect(res.body.attempts[1]).toHaveProperty('abandon_reason', null);
  });
});

describe('candidate phone-attempt history: recordings made before consent (M011 F2)', () => {
  function parent(overrides: Record<string, unknown> = {}) {
    return {
      id: SESSION,
      owner_id: null,
      status: 'expired',
      recording_revoked_at: null,
      recording_quarantined: false,
      recording_deleted_at: null,
      ...overrides,
    };
  }

  it('reports a ready pre-consent worker clip as playable and before_consent, with no key or URL', async () => {
    sessionRows = [parent()];
    attempts = [{
      ...row(IDS[0], TIED, true),
      session_id: null,
      recording_session_id: SESSION,
      egress_status: 'complete',
    }];
    for (const role of ['admin', 'viewer'] as const) {
      const res = await request(app(role)).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
      expect(res.status).toBe(200);
      const attempt = res.body.attempts[0];
      expect(attempt.recording).toEqual({ state: 'ready' });
      expect(attempt.consent_stage).toBe('before_consent');
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('egress.mp3');
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toContain('a'.repeat(64));
    }
  });

  it('marks a consent-bound leg after_consent', async () => {
    sessionRows = [parent({ status: 'completed' })];
    attempts = [{ ...row(IDS[0], TIED, true), outcome_class: 'completed' }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].consent_stage).toBe('after_consent');
  });

  it('keeps a pre-consent outcome before_consent even when a later leg completed the parent', async () => {
    sessionRows = [parent({ status: 'completed' })];
    attempts = [{ ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].consent_stage).toBe('before_consent');
  });

  it('does not guess for a NULL-bound leg with a non-pre-consent outcome under a completed parent', async () => {
    // Pre-0107 legs could consent without binding session_id; their parent
    // completed. Reported as unknown rather than "before consent".
    sessionRows = [parent({ status: 'completed' })];
    attempts = [{
      ...row(IDS[0], TIED, true),
      session_id: null,
      recording_session_id: SESSION,
      outcome_class: 'completed',
    }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].consent_stage).toBeNull();
  });

  it('runs no transcript probe for a viewer to classify consent', async () => {
    const tables: string[] = [];
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      tables.push(table);
      return chain(table, table === 'phone_call_attempts' ? attempts : []) as never;
    });
    sessionRows = [parent()];
    attempts = [{ ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION }];
    const res = await request(app('viewer')).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].consent_stage).toBe('before_consent');
    expect(res.body.attempts[0].transcript).toBeNull();
    expect(tables).not.toContain('transcript_turns');
  });

  it('reports a deleted recording as deleted and a quarantined one as quarantined, never ready', async () => {
    sessionRows = [parent()];
    attempts = [
      { ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION, recording_deleted_at: '2026-09-27T00:00:00.000Z' },
      { ...row(IDS[1], TIED, true), session_id: null, recording_session_id: SESSION, recording_ready: false, recording_quarantined: true },
    ];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'deleted' });
    expect(res.body.attempts[1].recording).toEqual({ state: 'unavailable', reason: 'quarantined' });
  });

  it('inherits a deleted or quarantined parent session', async () => {
    sessionRows = [parent({ recording_quarantined: true })];
    attempts = [{ ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION }];
    let res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'quarantined' });

    sessionRows = [parent({ recording_deleted_at: '2026-09-27T00:00:00.000Z' })];
    res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'deleted' });
  });

  it('tells a non-owning interviewer only that access is unavailable, never the lifecycle', async () => {
    sessionRows = [parent({ owner_id: 'someone-else', recording_quarantined: true })];
    attempts = [{ ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION }];
    const res = await request(app('interviewer', 'owner-1')).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'access_unavailable' });
    // ...nor how its audio was captured.
    expect(res.body.attempts[0].consent_stage).toBeNull();
  });

  it('names a recording on a consent-revoked parent "revoked", not "no recording"', async () => {
    sessionRows = [parent({ recording_revoked_at: '2026-09-28T00:00:00.000Z' })];
    attempts = [{ ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts[0].recording).toEqual({ state: 'unavailable', reason: 'revoked' });
  });
});

// ── M013 S02 T07: per-leg truth, multi-leg listing, consent flags ─────────
// Every fixture is synthetic: placeholder ids, real TIMINGS only (the
// 9f60523d and 32757295 shapes from the S02 research), no names or numbers.
describe('candidate phone-attempt history: per-leg truth (M013 S02 T07)', () => {
  const LEG_A = '00000000-0000-4000-8000-0000000000a1';
  const LEG_B = '00000000-0000-4000-8000-0000000000b2';
  const LEG_C = '00000000-0000-4000-8000-0000000000c3';
  const OTHER_SESSION = '00000000-0000-4000-8000-000000000203';

  function parentSession(overrides: Record<string, unknown> = {}) {
    return {
      id: SESSION,
      owner_id: null,
      status: 'completed',
      recording_revoked_at: null,
      recording_quarantined: false,
      recording_deleted_at: null,
      ...overrides,
    };
  }

  /** A legacy (pre-T01/T02) worker MP3 leg: size only, no 0125 facts. */
  function workerLeg(id: string, fields: Record<string, unknown>) {
    return {
      id,
      attempt_seq: 1,
      abandon_reason: null,
      session_id: SESSION,
      recording_session_id: SESSION,
      recording_object_key: `phone-${id}-worker.mp3`,
      recording_sha256: 'b'.repeat(64),
      recording_content_type: 'audio/mpeg',
      recording_ready: true,
      recording_quarantined: false,
      recording_deleted_at: null,
      egress_id: `EG_worker_${id}`,
      egress_status: 'complete',
      observed_ended_at: null,
      recording_started_at_ms: null,
      recording_duration_ms: null,
      recording_tail_flushed: null,
      ...fields,
    };
  }

  /**
   * The 9f60523d shape (newest first, as the default listing orders):
   * leg C a reconnect dial that never answered; leg B the reconnect leg ended
   * only by the lease reclaim; leg A the first leg, ended by the reconciler.
   */
  function zeroAnswerShape() {
    return [
      {
        ...workerLeg(LEG_C, {}),
        attempt_seq: 10,
        admitted_at: '2026-10-06T03:43:09.900Z',
        answered_at: null,
        ended_at: '2026-10-06T03:44:03.349Z',
        state: 'ended',
        outcome_class: 'provider_error',
        session_id: null,
        recording_session_id: null,
        recording_object_key: null,
        recording_sha256: null,
        recording_size_bytes: null,
        recording_content_type: null,
        recording_ready: false,
        egress_id: null,
        egress_status: null,
      },
      workerLeg(LEG_B, {
        attempt_seq: 9,
        admitted_at: '2026-10-06T03:34:30.000Z',
        answered_at: '2026-10-06T03:34:49.612Z',
        ended_at: '2026-10-06T03:40:57.456Z',
        state: 'abandoned',
        outcome_class: null,
        recording_size_bytes: 140_972,
      }),
      workerLeg(LEG_A, {
        attempt_seq: 8,
        admitted_at: '2026-10-06T03:30:30.000Z',
        answered_at: '2026-10-06T03:30:46.822Z',
        ended_at: '2026-10-06T03:32:02.356Z',
        state: 'ended',
        outcome_class: 'disconnected',
        recording_size_bytes: 425_708,
      }),
    ];
  }

  it('9f60523d shape: detected end + estimated length on leg A, unobserved leg B, no reclaim span as a length', async () => {
    sessionRows = [parentSession({ ended_at: '2026-10-06T03:43:59.622Z' })];
    attempts = zeroAnswerShape();
    // As in production: leg A's end is our reconciler's applied
    // sip.participant_left, i.e. its DETECTION time (review round 2 nit).
    events = [{ attempt_id: LEG_A, event_type: 'sip.participant_left', source: 'reconciliation', applied: true }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    const [c, b, a] = res.body.attempts;

    expect(a).toMatchObject({
      connected_from: '2026-10-06T03:30:46.822Z',
      connected_to: '2026-10-06T03:32:02.356Z',
      connected_to_source: 'detected',
      connected_sec: null,
      duration_sec: null,
      recorded_sec: 53.2,
      recorded_sec_estimated: true,
      recording_started_at_ms: null,
      tail_may_be_missing: true,
      session_ref: SESSION,
    });

    // The reclaim-ended leg: its end is the DETECTION time and it has no
    // length — not the 6 min between the hang-up and the sweep.
    expect(b).toMatchObject({
      connected_from: '2026-10-06T03:34:49.612Z',
      connected_to: '2026-10-06T03:40:57.456Z',
      connected_to_source: 'unobserved',
      connected_sec: null,
      duration_sec: null,
      recorded_sec: 17.6,
      recorded_sec_estimated: true,
      session_ref: SESSION,
    });

    expect(c).toMatchObject({
      connected_from: null,
      connected_to: null,
      connected_to_source: null,
      connected_sec: null,
      recorded_sec: null,
      recorded_sec_estimated: false,
      tail_may_be_missing: false,
      session_ref: null,
    });

    // No field of any leg carries a reclaim-based length (367.8 s / 443 s).
    for (const attempt of res.body.attempts) {
      for (const key of ['duration_sec', 'connected_sec', 'recorded_sec']) {
        expect([null, 53.2, 17.6]).toContain(attempt[key]);
      }
    }
    // Neither provider ids nor storage keys cross the boundary.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('EG_worker_');
    expect(body).not.toContain('worker.mp3');
  });

  it('a leg reclaimed after its completed session ended is bounded by the session end (0125 §3a)', async () => {
    const reclaimedLate = workerLeg(LEG_A, {
      admitted_at: '2026-10-07T04:00:00.000Z',
      answered_at: '2026-10-07T04:00:10.000Z',
      ended_at: '2026-10-07T04:04:10.000Z',
      // The worker's heartbeat still held the lease when it completed the
      // session at 04:02:00.
      lease_expires_at: '2026-10-07T04:02:05.000Z',
      state: 'abandoned',
      outcome_class: null,
      recording_size_bytes: 480_000,
    });
    attempts = [reclaimedLate];
    sessionRows = [parentSession({ ended_at: '2026-10-07T04:02:00.000Z' })];
    let res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0]).toMatchObject({
      connected_to: '2026-10-07T04:02:00.000Z',
      connected_to_source: 'ledger',
      connected_sec: 110,
      duration_sec: 110,
    });
    // The lease expiry is read, never returned.
    expect(JSON.stringify(res.body)).not.toContain('lease_expires_at');
    // Finalize-before-reclaim (review round 3): the lease lapsed at 04:00:40
    // and the partial-finalize sweep completed the session at 04:03:41, past
    // its 180 s grace. That end is the sweep's clock, not the call's: the
    // leg stays unobserved rather than ~3 minutes of possible dead air.
    attempts = [{ ...reclaimedLate, lease_expires_at: '2026-10-07T04:00:40.000Z' }];
    sessionRows = [parentSession({ ended_at: '2026-10-07T04:03:41.000Z' })];
    res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0]).toMatchObject({
      connected_to: '2026-10-07T04:04:10.000Z',
      connected_to_source: 'unobserved',
      connected_sec: null,
      duration_sec: null,
    });
    attempts = [reclaimedLate];
    // A session that is not completed gives no bound: the reclaim stays
    // unobserved (SQL computes no duration for it either).
    sessionRows = [parentSession({ status: 'failed', ended_at: '2026-10-07T04:02:00.000Z' })];
    res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0]).toMatchObject({ connected_to_source: 'unobserved', connected_sec: null });
  });

  it('a 0125 leg: observed end, true audio length, anchor and a flushed tail', async () => {
    sessionRows = [parentSession()];
    attempts = [workerLeg(LEG_A, {
      admitted_at: '2026-10-07T04:00:00.000Z',
      answered_at: '2026-10-07T04:00:10.000Z',
      // The reconciler saw it ~14 s later; the observed leave wins.
      ended_at: '2026-10-07T04:01:24.000Z',
      observed_ended_at: '2026-10-07T04:01:10.500Z',
      state: 'ended',
      outcome_class: 'disconnected',
      recording_size_bytes: 480_000,
      recording_duration_ms: 59_450,
      recording_started_at_ms: 1_791_345_611_050,
      recording_tail_flushed: true,
    })];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0]).toMatchObject({
      connected_to: '2026-10-07T04:01:10.500Z',
      connected_to_source: 'observed',
      connected_sec: 60.5,
      recorded_sec: 59.45,
      recorded_sec_estimated: false,
      recording_started_at_ms: 1_791_345_611_050,
      tail_may_be_missing: false,
    });
  });

  it('a leg the RECONCILER ended reads detected: detection time kept, no exact length, not "ledger"', async () => {
    sessionRows = [parentSession()];
    attempts = zeroAnswerShape();
    events = [
      { attempt_id: LEG_A, event_type: 'sip.participant_left', source: 'reconciliation', applied: true },
      // A webhook post, or a reconciler post that did not apply, says nothing.
      { attempt_id: LEG_B, event_type: 'sip.participant_left', source: 'livekit', applied: true },
    ];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    const a = res.body.attempts.find((x: { id: string }) => x.id === LEG_A);
    expect(a).toMatchObject({
      connected_from: '2026-10-06T03:30:46.822Z',
      connected_to: '2026-10-06T03:32:02.356Z',
      connected_to_source: 'detected',
      connected_sec: null,
      duration_sec: null,
      recorded_sec: 53.2,
    });
    const b = res.body.attempts.find((x: { id: string }) => x.id === LEG_B);
    expect(b.connected_to_source).toBe('unobserved');
  });

  it('a reconciler post that did NOT apply leaves the ledger end as it was', async () => {
    sessionRows = [parentSession()];
    attempts = zeroAnswerShape();
    events = [{ attempt_id: LEG_A, event_type: 'sip.participant_left', source: 'reconciliation', applied: false }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    const a = res.body.attempts.find((x: { id: string }) => x.id === LEG_A);
    expect(a).toMatchObject({ connected_to_source: 'ledger', connected_sec: 75.534 });
  });

  it('a leg whose recording is unavailable (erased, revoked, quarantined) states no recorded length or tail note', async () => {
    for (const lifecycle of [
      { recording_deleted_at: '2026-10-07T00:00:00.000Z' },
      { recording_revoked_at: '2026-10-07T00:00:00.000Z' },
      { recording_quarantined: true },
    ]) {
      sessionRows = [parentSession(lifecycle)];
      attempts = zeroAnswerShape();
      const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
      for (const attempt of res.body.attempts) {
        expect(attempt.recording.state).toBe('unavailable');
        expect(attempt).toMatchObject({ recorded_sec: null, recorded_sec_estimated: false, tail_may_be_missing: false });
      }
      // The connected window is a call fact and stays.
      expect(res.body.attempts.find((x: { id: string }) => x.id === LEG_A).connected_sec).toBe(75.534);
    }
  });

  it('a 0125 leg whose fail-open flush was skipped still says the tail may be missing', async () => {
    sessionRows = [parentSession()];
    attempts = [workerLeg(LEG_A, {
      admitted_at: '2026-10-07T04:00:00.000Z',
      answered_at: '2026-10-07T04:00:10.000Z',
      ended_at: '2026-10-07T04:01:24.000Z',
      observed_ended_at: '2026-10-07T04:01:10.500Z',
      state: 'ended',
      outcome_class: 'disconnected',
      recording_size_bytes: 400_000,
      // The duration is known; the flush is independent of it.
      recording_duration_ms: 50_000,
      recording_tail_flushed: false,
    })];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0]).toMatchObject({ recorded_sec: 50, tail_may_be_missing: true });
  });

  it('32757295 shape: listed via recording_session_id, before consent, outcome as recorded, no truncation note', async () => {
    sessionRows = [parentSession({ id: OTHER_SESSION, status: 'waiting' })];
    attempts = [workerLeg(LEG_A, {
      admitted_at: '2026-10-05T05:00:00.000Z',
      answered_at: '2026-10-05T05:00:20.000Z',
      ended_at: '2026-10-05T05:00:54.600Z',
      state: 'ended',
      outcome_class: 'voicemail',
      session_id: null,
      recording_session_id: OTHER_SESSION,
      recording_size_bytes: 261_600,
    })];
    const res = await request(app())
      .get(`/api/candidates/${CANDIDATE}/phone-attempts?session_id=${OTHER_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toMatchObject({
      outcome_class: 'voicemail',
      consent_stage: 'before_consent',
      session_ref: OTHER_SESSION,
      connected_to_source: 'ledger',
      connected_sec: 34.6,
      recorded_sec: 32.7,
      recorded_sec_estimated: true,
      // 34.6 - 32.7 < 3 s: the recording covers the call.
      tail_may_be_missing: false,
    });
    // The session filter is applied, oldest first.
    expect(cursorFilters).toContain(`session_id.eq.${OTHER_SESSION},recording_session_id.eq.${OTHER_SESSION}`);
    expect(attemptOrders).toEqual([['admitted_at', true], ['id', true]]);
  });

  it('keeps the default listing newest first and combines a session filter with the cursor in ONE tree', async () => {
    attempts = zeroAnswerShape();
    await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(attemptOrders).toEqual([['admitted_at', false], ['id', false]]);
    expect(cursorFilters).toEqual([]);

    attemptOrders = [];
    const cursor = Buffer.from(JSON.stringify({ admitted_at: '2026-10-06T03:30:30.000Z', id: LEG_A }), 'utf8')
      .toString('base64url');
    const res = await request(app())
      .get(`/api/candidates/${CANDIDATE}/phone-attempts?session_id=${SESSION}&before=${cursor}`);
    expect(res.status).toBe(200);
    expect(cursorFilters).toEqual([
      `and(or(session_id.eq.${SESSION},recording_session_id.eq.${SESSION}),`
        + `or(admitted_at.gt.2026-10-06T03:30:30.000Z,and(admitted_at.eq.2026-10-06T03:30:30.000Z,id.gt.${LEG_A})))`,
    ]);
  });

  it('rejects a session filter that is not a uuid before any read', async () => {
    const tables: string[] = [];
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      tables.push(table);
      return chain(table, []) as never;
    });
    const res = await request(app())
      .get(`/api/candidates/${CANDIDATE}/phone-attempts?session_id=${encodeURIComponent('x),id.not.is.null')}`);
    expect(res.status).toBe(400);
    expect(tables).not.toContain('phone_call_attempts');
  });

  it('withdrawn: a consented leg with its OWN candidate.opt_out event (C7-a lost race keeps it disconnected)', async () => {
    sessionRows = [parentSession({ status: 'cancelled' })];
    attempts = [{ ...row(IDS[0], TIED, true), outcome_class: 'disconnected' }];
    events = [{ attempt_id: IDS[0], event_type: 'candidate.opt_out' }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].consent_stage).toBe('consent_withdrawn');
    // Recording kept and playable: the stage only labels it.
    expect(res.body.attempts[0].recording).toEqual({ state: 'ready' });
  });

  it('withdrawn: a consented leg that ended opt_out', async () => {
    sessionRows = [parentSession({ status: 'cancelled' })];
    attempts = [{ ...row(IDS[0], TIED, true), outcome_class: 'opt_out' }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].consent_stage).toBe('consent_withdrawn');
  });

  it('deferred: a consented leg ending callback_deferred, or named by callback.deferred_in_call, is not "withdrawn"', async () => {
    sessionRows = [parentSession({ status: 'in_progress' })];
    attempts = [
      { ...row(IDS[0], TIED, true), outcome_class: 'callback_deferred' },
      { ...row(IDS[1], TIED, true), outcome_class: 'disconnected' },
    ];
    events = [{ attempt_id: IDS[1], event_type: 'callback.deferred_in_call' }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts.map((a: { consent_stage: unknown }) => a.consent_stage))
      .toEqual(['deferred_after_consent', 'deferred_after_consent']);
  });

  it('deferred: a consented leg on which the candidate BOOKED a voice callback (0113 E4) is deferred_after_consent', async () => {
    sessionRows = [parentSession({ status: 'in_progress' })];
    attempts = [
      { ...row(IDS[0], TIED, true), outcome_class: 'disconnected' },
      { ...row(IDS[1], TIED, true), outcome_class: 'disconnected' },
    ];
    appointments = [{ confirmed_from_attempt_id: IDS[0] }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts.map((a: { consent_stage: unknown }) => a.consent_stage))
      .toEqual(['deferred_after_consent', 'after_consent']);
  });

  it('an EARLIER consented leg of an engagement that later opted out on another leg stays after_consent', async () => {
    sessionRows = [parentSession({ status: 'cancelled' })];
    attempts = [
      { ...row(IDS[0], TIED, true), outcome_class: 'opt_out' },
      { ...row(IDS[2], '2026-09-24T13:00:00.000Z', true), outcome_class: 'disconnected' },
    ];
    events = [{ attempt_id: IDS[0], event_type: 'candidate.opt_out' }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts.map((a: { consent_stage: unknown }) => a.consent_stage))
      .toEqual(['consent_withdrawn', 'after_consent']);
  });

  it('a refused disclosure (opt_out) on an unbound leg is before consent, even under a completed parent', async () => {
    sessionRows = [parentSession({ status: 'completed' })];
    attempts = [{ ...row(IDS[0], TIED, true), session_id: null, recording_session_id: SESSION, outcome_class: 'opt_out' }];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0].consent_stage).toBe('before_consent');
  });

  it('loads the leg facts in ONE batched events query over every shown leg (+ one appointments query)', async () => {
    sessionRows = [parentSession()];
    attempts = [
      row(IDS[0], TIED, true),
      row(IDS[1], TIED, true),
      { ...row(IDS[2], '2026-09-24T13:00:00.000Z', true), session_id: null, recording_session_id: SESSION },
    ];
    const tables: string[] = [];
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      tables.push(table);
      return chain(table, table === 'phone_call_attempts' ? attempts : []) as never;
    });
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    expect(tables.filter((t) => t === 'phone_call_events')).toHaveLength(1);
    expect(tables.filter((t) => t === 'phone_appointments')).toHaveLength(1);
    // Every leg: an unbound reconnect leg can still have a reconciler-detected end.
    expect(eventIns).toEqual([
      ['attempt_id', [IDS[0], IDS[1], IDS[2]]],
      ['event_type', ['candidate.opt_out', 'callback.deferred_in_call', 'sip.participant_left']],
    ]);
  });

  it('fails the page (503) rather than calling a leg "after consent" when its facts cannot be read', async () => {
    sessionRows = [parentSession()];
    attempts = [row(IDS[0], TIED, true)];
    eventsError = { message: 'pooler reset' };
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(503);
    expect(res.body).not.toHaveProperty('attempts');
  });

  it('tells a non-owning interviewer nothing about the recording: no length, anchor or tail note', async () => {
    sessionRows = [parentSession({ owner_id: 'someone-else' })];
    attempts = zeroAnswerShape();
    const res = await request(app('interviewer', 'owner-1')).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.status).toBe(200);
    for (const attempt of res.body.attempts) {
      expect(attempt).toMatchObject({
        recorded_sec: null,
        recorded_sec_estimated: false,
        recording_started_at_ms: null,
        tail_may_be_missing: false,
      });
    }
    // The connected window is a call fact, as duration_sec always was.
    expect(res.body.attempts[2].connected_sec).toBe(75.534);
  });

  it('a failed capture has no recorded length and no tail note', async () => {
    sessionRows = [parentSession()];
    attempts = [workerLeg(LEG_A, {
      admitted_at: TIED,
      answered_at: TIED,
      ended_at: '2026-09-25T13:01:00.000Z',
      state: 'ended',
      outcome_class: 'disconnected',
      recording_size_bytes: 100_000,
      recording_duration_ms: 12_000,
      recording_ready: false,
      egress_status: 'failed',
    })];
    const res = await request(app()).get(`/api/candidates/${CANDIDATE}/phone-attempts`);
    expect(res.body.attempts[0]).toMatchObject({
      recorded_sec: null,
      tail_may_be_missing: false,
      recording: { state: 'unavailable', reason: 'recording_failed' },
    });
  });
});
