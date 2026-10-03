/**
 * session-lifecycle-insert-pgcode.test.ts — M009 E1.
 *
 * `createSession` keeps its ERR_INSERT_FAILED contract (browser session
 * creation matches on it) and gains ONE additive optional field, `pgCode`:
 * the SQLSTATE the insert failed with. The phone session port logs it so a
 * 23505 on `uq_call_sessions_phone_engagement` is visible instead of masked.
 * Only a five-character SQLSTATE may travel — never the driver's message,
 * details, hint or a PostgREST code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspect } from 'node:util';
import { createSession, ERR_INSERT_FAILED } from '../lib/session-lifecycle.js';

const mockFrom = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

function chain(value: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'single']) {
    c[m] = () => chain(value);
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  return c;
}

const CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';

const DRIVER_SENTINELS = [
  'SENTINEL-STATEMENT',
  'SENTINEL-DETAILS-ROW',
  'SENTINEL-HINT',
];

function failWith(error: Record<string, unknown>) {
  mockFrom.mockReturnValue(chain({ data: null, error }));
  return createSession({ candidate_id: CANDIDATE_ID, role_id: null, mode: 'live' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSession insert error: ERR_INSERT_FAILED plus an optional SQLSTATE', () => {
  it('a 23505 keeps the stable message and exposes pgCode 23505', async () => {
    const result = await failWith({
      code: '23505',
      message: 'duplicate key value violates unique constraint SENTINEL-STATEMENT',
      details: 'SENTINEL-DETAILS-ROW',
      hint: 'SENTINEL-HINT',
    });

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe(ERR_INSERT_FAILED);
    expect(result.error!.pgCode).toBe('23505');
    const rendered = [
      String(result.error),
      JSON.stringify(result.error, Object.getOwnPropertyNames(result.error)),
      inspect(result.error, { depth: null, showHidden: true }),
    ].join('\n');
    for (const sentinel of DRIVER_SENTINELS) {
      expect(rendered, `driver payload ${sentinel} escaped`).not.toContain(sentinel);
    }
  });

  it('no code, or a non-SQLSTATE code, leaves pgCode absent', async () => {
    for (const error of [
      { message: 'insert failed' },
      { code: 'PGRST116', message: 'x' },
      { code: 'SENTINEL-STATEMENT', message: 'x' },
      { code: 23505, message: 'x' },
    ]) {
      const result = await failWith(error);
      expect(result.error!.message).toBe(ERR_INSERT_FAILED);
      expect(result.error!.pgCode, JSON.stringify(error)).toBeUndefined();
      expect('pgCode' in result.error!).toBe(false);
    }
  });

  it('the browser-route guard shape is unchanged: a truthy error, a null row', async () => {
    // routes/screening.ts and routes/livekit.ts test `insertErr || !session`.
    const result = await failWith({ code: '23505', message: 'x' });
    expect(Boolean(result.error)).toBe(true);
    expect(result.data).toBeNull();
  });
});
