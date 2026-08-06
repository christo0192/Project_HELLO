/**
 * resolveWorkerContext — distinguishes a transient DB failure from a genuinely
 * absent session so the voice worker can retry instead of failing closed on a
 * cold-start blip (which left candidates joined with no bot).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-table result the chainable mock resolves at the terminal call.
let sessionResult: { data: unknown; error: unknown };
let candidateResult: { data: unknown; error: unknown };

function chainable(getResult: () => { data: unknown; error: unknown }): unknown {
  const p: Record<string, unknown> = {};
  const ret = () => p;
  p.select = ret;
  p.eq = ret;
  p.order = ret;
  p.limit = ret;
  p.is = ret;
  p.in = ret;
  p.single = () => Promise.resolve(getResult());
  p.maybeSingle = () => Promise.resolve(getResult());
  return p;
}

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table: string) =>
      chainable(() => (table === 'call_sessions' ? sessionResult : candidateResult)),
  },
}));

import {
  resolveWorkerContext,
  ERR_DB_FAILED,
  ERR_SESSION_NOT_FOUND,
  ERR_BINDING_MISMATCH,
  ERR_SESSION_NOT_ACTIVE,
} from '../lib/worker-context.js';

const SID = 'cf39174e-500f-42d4-a546-4e3d14f559df';
const ROOM = `screening-${SID}`;

describe('resolveWorkerContext', () => {
  beforeEach(() => {
    candidateResult = { data: { name: 'Rijo J John' }, error: null };
  });

  it('returns ERR_DB_FAILED (retryable) when the session query errors transiently', async () => {
    // A DB/connection blip: supabase returns an error, not a missing row.
    sessionResult = { data: null, error: { message: 'fetch failed' } };
    const r = await resolveWorkerContext(SID, ROOM);
    expect(r).toEqual({ ok: false, code: ERR_DB_FAILED });
  });

  it('returns ERR_SESSION_NOT_FOUND only when the row is genuinely absent', async () => {
    sessionResult = { data: null, error: null };
    const r = await resolveWorkerContext(SID, ROOM);
    expect(r).toEqual({ ok: false, code: ERR_SESSION_NOT_FOUND });
  });

  it('returns ERR_BINDING_MISMATCH when the room binding does not match', async () => {
    sessionResult = {
      data: { id: SID, candidate_id: 'c', role_id: null, status: 'waiting', external_call_id: 'screening-other' },
      error: null,
    };
    const r = await resolveWorkerContext(SID, ROOM);
    expect(r).toEqual({ ok: false, code: ERR_BINDING_MISMATCH });
  });

  it('returns ERR_SESSION_NOT_ACTIVE for a terminal-state session', async () => {
    sessionResult = {
      data: { id: SID, candidate_id: 'c', role_id: null, status: 'completed', external_call_id: ROOM },
      error: null,
    };
    const r = await resolveWorkerContext(SID, ROOM);
    expect(r).toEqual({ ok: false, code: ERR_SESSION_NOT_ACTIVE });
  });

  it('resolves ok for a waiting session with a matching binding', async () => {
    sessionResult = {
      data: { id: SID, candidate_id: 'cand-1', role_id: null, status: 'waiting', external_call_id: ROOM },
      error: null,
    };
    const r = await resolveWorkerContext(SID, ROOM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.candidate_name).toBe('Rijo J John');
      expect(r.context.status).toBe('waiting');
      expect(r.context.room_name).toBe(ROOM);
    }
  });
});
