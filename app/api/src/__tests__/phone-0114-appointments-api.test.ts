/**
 * 0114 §5 (C5), the API side (P4): the two new booking refusals, the expiry
 * sweep's `held` / `released` counts, and the post-call backstop's recovery
 * record. The SQL itself is pinned by `phone-0114-appointments.test.ts` and
 * the policy suite; this file pins what the API does with what the SQL says.
 *
 *   1. The registry resolves 0114 first, so every extractor below reads the
 *      0114 bodies rather than 0042's.
 *   2. Contract drift: `SCHEDULE_PHONE_APPOINTMENT_STATUSES` carries both new
 *      refusals and is exactly the 0114 body's set; `expire_phone_appointments`
 *      emits `held` / `released`; the union count does not move.
 *   3. Stores: the two refusals narrow to themselves (before P4 they narrowed
 *      to `unknown_status`, which every route reports as a 500 "we never got
 *      an answer"), and `held` / `released` map, absent -> undefined.
 *   4. The runtime's `phone_expire_sweep` line is count-only and bounded.
 *   5. The candidate-profile routes answer 409 with the refusal as the code,
 *      and a refused reschedule never cancels the existing slot.
 *
 * No database, no network, no clock.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPhoneStores } from '../lib/phone-screening/stores.js';
import {
  PHONE_RPC_RESULT_KEYS,
  PHONE_RPC_STATUSES,
  PHONE_RPC_STATUS_COUNT,
  PHONE_RPC_STATUS_UNION,
  PHONE_RPC_UNKNOWN_STATUS,
  SCHEDULE_PHONE_APPOINTMENT_STATUSES,
} from '../lib/phone-screening/rpc-contract.js';
import { phoneExpireSweepMeta } from '../lib/phone-runtime/runtime.js';
import { createLogger } from '../lib/logger.js';
import {
  MIGRATION_0114,
  MIGRATION_0114_PATH,
  PHONE_MIGRATIONS,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const { supabase } = await import('../lib/supabase.js');
const { candidatesRouter } = await import('../routes/candidates.js');
const { finalErrorHandler } = await import('../lib/validation.js');

const NEW_REFUSALS = ['slot_not_yet_eligible', 'daily_attempt_exists'] as const;
const NOW = new Date('2026-10-03T08:30:00.000Z');

// ── 1. registry ─────────────────────────────────────────────────────────

describe('the migration registry', () => {
  it('lists 0114 newest-first directly after 0125 (M013 S02), ahead of 0113 and 0112', () => {
    expect(PHONE_MIGRATIONS[0].name).toBe('0125');
    expect(PHONE_MIGRATIONS[1].name).toBe('0114');
    expect(PHONE_MIGRATIONS[1].sql).toBe(MIGRATION_0114);
    const names = PHONE_MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0114')).toBeLessThan(names.indexOf('0113'));
    expect(names.indexOf('0114')).toBeLessThan(names.indexOf('0112'));
    expect(MIGRATION_0114_PATH).toMatch(/0114_phone_outcome_integrity\.sql$/);
  });

  it('resolves schedule_phone_appointment and expire_phone_appointments to their 0114 bodies', () => {
    for (const name of ['schedule_phone_appointment', 'expire_phone_appointments']) {
      const body = functionBody(name);
      expect(MIGRATION_0114, `${name} is not the 0114 body`).toContain(body);
    }
    expect(functionBody('schedule_phone_appointment')).toContain("'slot_not_yet_eligible'");
    expect(functionBody('expire_phone_appointments')).toContain("'held'");
  });
});

// ── 2. contract drift ───────────────────────────────────────────────────

describe('the contract carries the 0114 booking refusals', () => {
  it('SCHEDULE_PHONE_APPOINTMENT_STATUSES is exactly the 0114 body\'s set', () => {
    expect(new Set(SCHEDULE_PHONE_APPOINTMENT_STATUSES)).toEqual(
      functionStatuses('schedule_phone_appointment'),
    );
    for (const s of NEW_REFUSALS) {
      expect(SCHEDULE_PHONE_APPOINTMENT_STATUSES).toContain(s);
      expect(PHONE_RPC_STATUSES.schedule_phone_appointment).toContain(s);
    }
  });

  it('neither refusal is new to the union, so the status count does not move', () => {
    for (const s of NEW_REFUSALS) {
      expect(PHONE_RPC_STATUSES.confirm_candidate_voice_callback).toContain(s);
      expect(PHONE_RPC_STATUS_UNION).toContain(s);
    }
    expect(PHONE_RPC_STATUS_UNION).toHaveLength(PHONE_RPC_STATUS_COUNT);
  });

  it('expire_phone_appointments still answers only ok, and emits held/released', () => {
    expect(functionStatuses('expire_phone_appointments')).toEqual(new Set(['ok']));
    expect(PHONE_RPC_RESULT_KEYS.expire_phone_appointments).toEqual([
      'expired', 'held', 'released',
    ]);
    const body = functionBody('expire_phone_appointments');
    for (const key of ['expired', 'held', 'released']) {
      expect(body).toMatch(new RegExp(String.raw`'${key}',\s*v_`));
    }
  });
});

// ── 3. stores ───────────────────────────────────────────────────────────

function fakeClient(answer: unknown): { client: SupabaseClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    rpc(name: string) {
      calls.push(name);
      return Promise.resolve({ data: answer, error: null });
    },
    from() {
      throw new Error('phone stores must never reach a table directly');
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('the stores adapter', () => {
  it.each(NEW_REFUSALS)('narrows %s to itself, not to unknown_status', async (status) => {
    const fx = fakeClient({ status, next_eligible_at: '2026-10-04T03:30:00+00:00' });
    const result = await createPhoneStores(fx.client).scheduleAppointment({
      engagementId: 'e1',
      startsAt: new Date('2026-10-03T10:00:00.000Z'),
      endsAt: new Date('2026-10-03T10:15:00.000Z'),
      source: 'hr_manual',
      now: NOW,
    });
    expect(fx.calls).toEqual(['schedule_phone_appointment']);
    expect(result.status).toBe(status);
    expect(result.status).not.toBe(PHONE_RPC_UNKNOWN_STATUS);
  });

  it('maps held and released from the expiry sweep', async () => {
    const fx = fakeClient({
      status: 'ok', expired: 1, grace_seconds: 900, limit: 50, held: 3, released: 2,
    });
    expect(await createPhoneStores(fx.client).expireAppointments({ now: NOW })).toEqual({
      status: 'ok', expired: 1, graceSeconds: 900, limit: 50, held: 3, released: 2,
    });
  });

  it('leaves held and released undefined (never 0) on a pre-0114 answer', async () => {
    const fx = fakeClient({ status: 'ok', expired: 0, grace_seconds: 900, limit: 50 });
    const result = await createPhoneStores(fx.client).expireAppointments({ now: NOW });
    expect(result.held).toBeUndefined();
    expect(result.released).toBeUndefined();
  });
});

// ── 4. the runtime's sweep line ─────────────────────────────────────────

describe('phone_expire_sweep', () => {
  it('says nothing for an idle pass or a non-ok answer', () => {
    expect(phoneExpireSweepMeta({ status: 'ok', expired: 0, held: 0, released: 0 })).toBeNull();
    expect(phoneExpireSweepMeta({ status: 'ok' })).toBeNull();
    expect(phoneExpireSweepMeta({ status: 'unknown_status', expired: 4 })).toBeNull();
  });

  it('reports the three counts, and -1 for a count the RPC did not send', () => {
    expect(phoneExpireSweepMeta({ status: 'ok', expired: 2, held: 1, released: 0 })).toEqual({
      error_type: 'phone_expire_sweep',
      error_category: 'phone_expire_sweep:x2:h1:r0',
    });
    expect(phoneExpireSweepMeta({ status: 'ok', expired: 1 })?.error_category)
      .toBe('phone_expire_sweep:x1:h-1:r-1');
  });

  it('is bounded under the 64-char cap and survives the real logger', () => {
    const meta = phoneExpireSweepMeta({
      status: 'ok', expired: 1e12, held: 1e12, released: 1e12,
    })!;
    expect(meta.error_category).toBe('phone_expire_sweep:x999:h999:r999');
    expect(meta.error_category.length).toBeLessThanOrEqual(64);
    expect(meta.error_category).not.toMatch(/\d{10,}/);

    const lines: string[] = [];
    const logger = createLogger('phone-runtime', {
      writer: (line: string) => { lines.push(line); },
      clock: () => '2026-10-03T08:30:00.000Z',
      correlationIdGetter: () => null,
    });
    logger.info('unknown_event', meta);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.error_type).toBe('phone_expire_sweep');
    expect(parsed.error_category).toBe('phone_expire_sweep:x999:h999:r999');
  });

  it('is emitted from the phone-maintain tick, from counts alone', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../lib/phone-runtime/runtime.ts', import.meta.url)),
      'utf8',
    );
    const tick = src.slice(src.indexOf("name: 'phone-maintain'"));
    const end = tick.indexOf("name: 'phone-dayroll'");
    const body = tick.slice(0, end);
    expect(body).toContain('phoneExpireSweepMeta(expired)');
    expect(body).toMatch(/logger\.info\('unknown_event', sweepMeta\)/);
    // No identifier of any kind reaches this line.
    expect(body).not.toMatch(/engagement_id|appointment_id|candidate|session_id|phone_e164/);
  });
});

// ── 5. the candidate-profile routes ─────────────────────────────────────

const CANDIDATE = '00000000-0000-4000-8000-000000000201';
const ENGAGEMENT = '00000000-0000-4000-8000-000000000202';
const APPOINTMENT = '00000000-0000-4000-8000-000000000203';

function single(data: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) self[m] = () => self;
  self.maybeSingle = async () => ({ data, error: null });
  return self;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = {
      id: '00000000-0000-4000-8000-0000000000aa', appRole: 'admin', active: true,
    };
    next();
  });
  a.use('/api/candidates', candidatesRouter);
  a.use(finalErrorHandler);
  return a;
}

describe('candidate-profile booking refusals', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    vi.mocked(supabase.rpc).mockReset();
    process.env.PHONE_SCREENING_ENABLED = 'true';
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === 'candidates') return single({ id: CANDIDATE, owner_id: 'o' }) as never;
      if (table === 'phone_appointments') {
        return single({ id: APPOINTMENT, engagement_id: ENGAGEMENT, status: 'scheduled', version: 4 }) as never;
      }
      if (table === 'phone_engagements') return single({ candidate_id: CANDIDATE }) as never;
      return single(null) as never;
    });
  });

  it.each(NEW_REFUSALS)('POST answers 409 %s', async (status) => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { status }, error: null } as never);
    const res = await request(app())
      .post(`/api/candidates/${CANDIDATE}/phone-appointments`)
      .send({ starts_at: '2026-10-05T05:00:00.000Z', ends_at: '2026-10-05T05:15:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: status });
    expect(vi.mocked(supabase.rpc).mock.calls[0][0]).toBe('schedule_candidate_phone_appointment');
  });

  it.each(NEW_REFUSALS)('PATCH answers 409 %s and never cancels the existing slot', async (status) => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { status }, error: null } as never);
    const res = await request(app())
      .patch(`/api/candidates/${CANDIDATE}/phone-appointments/${APPOINTMENT}`)
      .send({
        starts_at: '2026-10-05T05:00:00.000Z',
        ends_at: '2026-10-05T05:15:00.000Z',
        version: 4,
      });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: status });
    const rpcNames = vi.mocked(supabase.rpc).mock.calls.map((c) => c[0]);
    expect(rpcNames).toEqual(['schedule_phone_appointment']);
    expect(rpcNames).not.toContain('cancel_phone_appointment');
  });
});
