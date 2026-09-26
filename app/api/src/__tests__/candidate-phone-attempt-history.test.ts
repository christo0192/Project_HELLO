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

function chain(table: string, result: unknown): any {
  let output = result;
  let transcriptInterviewOnly = false;
  const self: any = {
    select: () => self,
    eq: (column: string, value: unknown) => {
      if (table === 'transcript_turns' && column === 'is_gate' && value === false) transcriptInterviewOnly = true;
      return self;
    },
    in: () => self,
    order: () => self,
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
});
