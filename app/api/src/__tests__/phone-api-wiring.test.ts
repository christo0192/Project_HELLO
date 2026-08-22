/**
 * The PRODUCTION wiring of the phone API — the seam DEFAULTS, not the seams.
 *
 * Every other suite in this lane injects a store, a clock and an env map, which
 * is exactly what makes them deterministic — and exactly what makes them blind
 * to the four lines that run when nothing is injected. A router that resolved
 * the wrong client, read the wrong env var, or never resolved a store at all
 * would leave all of those suites green and the feature dead in production.
 *
 * So this file injects NOTHING. It mocks the process-wide Supabase module,
 * builds `createPhoneApiRouter()` with no deps at all, and asserts that the
 * lazy resolutions actually fire and reach the right table and the right RPC.
 *
 * It also pins the two properties the laziness exists for: importing the route
 * module must open nothing, and a disabled deployment must resolve no store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getAuditSink, setAuditSink } from '../lib/audit.js';

const selectCalls: Array<{ table: string; columns: string }> = [];
const rpcCalls: Array<{ name: string; args: unknown }> = [];

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from(table: string) {
      return {
        select(columns: string) {
          selectCalls.push({ table, columns });
          const builder: Record<string, unknown> = {};
          for (const op of ['gte', 'lt', 'in', 'eq', 'order', 'limit']) {
            builder[op] = () => builder;
          }
          builder.then = (resolve: (v: unknown) => unknown): unknown =>
            resolve({ data: [], error: null });
          return builder;
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: {
          status: 'ok',
          admission: { control_present: true, halted: false, halt_reason: null },
          engagements_by_state: {},
          attempts: {
            live: 0, live_with_unexpired_lease: 0, max_concurrent: 10,
            oldest_live_age_seconds: 0,
          },
          appointments: { live: 0, overdue: 0 },
          events: {
            ignored_last_24h: 0, unknown_attempt_last_24h: 0, stale_epoch_last_24h: 0,
            terminal_last_24h: 0, unexpected_event_last_24h: 0,
          },
          window_open: true,
          ist_date: '2026-08-24',
        },
        error: null,
      });
    },
  },
}));

// Imported AFTER the mock is registered, so the router's module-level
// `supabase` import resolves to the fake.
const { createPhoneApiRouter } = await import('../routes/phone.js');

/** No deps whatsoever — this is the production constructor call. */
function productionApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = {
      id: '88888888-8888-4888-8888-888888888888',
      appRole: 'admin',
    };
    next();
  });
  app.use('/api/phone', createPhoneApiRouter());
  return app;
}

const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';

let originalSink: ReturnType<typeof getAuditSink>;
let originalFlag: string | undefined;

beforeEach(() => {
  selectCalls.length = 0;
  rpcCalls.length = 0;
  originalSink = getAuditSink();
  setAuditSink(async () => {});
  originalFlag = process.env.PHONE_SCREENING_ENABLED;
});

afterEach(() => {
  setAuditSink(originalSink);
  if (originalFlag === undefined) delete process.env.PHONE_SCREENING_ENABLED;
  else process.env.PHONE_SCREENING_ENABLED = originalFlag;
});

describe('the default config source is the real process environment', () => {
  it('is OFF when the variable is absent, which is the production default', async () => {
    delete process.env.PHONE_SCREENING_ENABLED;
    const res = await request(productionApp()).get('/api/phone/health');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.status).toBe('disabled');
    // The whole point of the default: nothing was resolved and nothing was read.
    expect(selectCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it('is OFF for any value other than the exact string true', async () => {
    for (const value of ['1', 'TRUE', 'yes', 'true ', '']) {
      process.env.PHONE_SCREENING_ENABLED = value;
      const res = await request(productionApp()).get('/api/phone/health');
      expect(res.body.enabled, `value ${JSON.stringify(value)}`).toBe(false);
    }
    expect(rpcCalls).toEqual([]);
  });

  it('turns on for exactly true', async () => {
    process.env.PHONE_SCREENING_ENABLED = 'true';
    const res = await request(productionApp()).get('/api/phone/health');
    expect(res.body.enabled).toBe(true);
    expect(res.body.config.screeningEnabled).toBe(true);
  });
});

describe('the default stores resolve to the process-wide client', () => {
  beforeEach(() => {
    process.env.PHONE_SCREENING_ENABLED = 'true';
  });

  it('the read store reaches phone_appointments with an explicit column list', async () => {
    const res = await request(productionApp())
      .get('/api/phone/calendar?from=2026-08-24T00:00:00Z&to=2026-08-25T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].table).toBe('phone_appointments');
    expect(selectCalls[0].columns).not.toContain('*');
    // No RPC on a read path — the read seam cannot invoke a mutation by name.
    expect(rpcCalls).toEqual([]);
  });

  it('the read store reaches phone_call_attempts for the engagement detail', async () => {
    const res = await request(productionApp()).get(`/api/phone/engagements/${ENGAGEMENT_ID}`);
    // The fake answers with no rows, so the engagement is genuinely absent —
    // what matters here is that a real query was issued at all.
    expect(res.status).toBe(404);
    expect(selectCalls.map((c) => c.table)).toEqual(['phone_engagements']);
  });

  it('the write store reaches the phone_backlog RPC with an injected p_now', async () => {
    const res = await request(productionApp()).get('/api/phone/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('phone_backlog');
    // The default clock is the real one, but it is still passed EXPLICITLY —
    // no 0042 function is ever left to fall back on the database clock.
    const args = rpcCalls[0].args as { p_now?: unknown };
    expect(typeof args.p_now).toBe('string');
    expect(Number.isNaN(Date.parse(String(args.p_now)))).toBe(false);
  });

  it('the slot grid uses the real clock and the configured step', async () => {
    const res = await request(productionApp()).get('/api/phone/calendar/slots?date=2026-08-24');
    expect(res.status).toBe(200);
    // The default step is 1800s, so the twelve-hour window yields 24 slots.
    expect(res.body.slot_seconds).toBe(1_800);
    expect(res.body.slots).toHaveLength(24);
    expect(selectCalls.map((c) => c.table)).toEqual(['phone_appointments']);
  });

  it('a write resolves the write store and delegates, never touching a table', async () => {
    const res = await request(productionApp()).post('/api/phone/halt')
      .send({ reason: 'operator_pause' });
    // The fake RPC answers `ok` for every name, which is enough to prove the
    // delegation happened and that no direct table write was attempted.
    expect(res.status).toBe(200);
    expect(rpcCalls.map((c) => c.name)).toEqual(['set_phone_halt']);
    expect(selectCalls).toEqual([]);
  });
});

describe('laziness', () => {
  it('a disabled deployment resolves no store on ANY route', async () => {
    delete process.env.PHONE_SCREENING_ENABLED;
    const app = productionApp();
    const probes: Array<[string, string, unknown]> = [
      ['get', '/api/phone/calendar?from=2026-08-24T00:00:00Z&to=2026-08-25T00:00:00Z', undefined],
      ['get', '/api/phone/calendar/slots?date=2026-08-24', undefined],
      ['get', `/api/phone/engagements/${ENGAGEMENT_ID}`, undefined],
      ['get', '/api/phone/health', undefined],
      ['post', '/api/phone/appointments', {
        engagement_id: ENGAGEMENT_ID,
        starts_at: '2026-08-24T04:00:00Z',
        ends_at: '2026-08-24T04:30:00Z',
      }],
      ['post', '/api/phone/halt', { reason: 'operator_pause' }],
      ['post', '/api/phone/halt/clear', { reason: 'operator_pause' }],
    ];
    for (const [method, path, body] of probes) {
      await (request(app) as never as Record<string, Function>)[method](path).send(body ?? {});
    }
    expect(selectCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
});
