/**
 * PR-7 read models: GET /api/interview-rounds/availability and
 * GET /api/admin/r1/usage, on the 0119 capacity model.
 *
 * What is pinned here:
 *  - role gates (viewer refused on both; interviewer refused on usage);
 *  - every availability state, in the documented precedence order, and that a
 *    state decided before the capacity check never reads the capacity RPC;
 *  - the capacity answer IS the 0119 snapshot's verdict (`admits`), asked with
 *    the Send hold: ready on the self-hosted target (Mode A) however large the
 *    Cloud pool estimate is, exhausted exactly when the snapshot does not admit,
 *    the Cloud target (Mode B) following the same snapshot, and a snapshot error
 *    or a missing verdict never reading as ready;
 *  - the RPC argument names and the snapshot keys read here exist in 0119, so a
 *    rename fails `npm test` instead of PGRST202 in production;
 *  - the usage figures come from the same snapshot: Mode A headroom is the R1
 *    allocation, the pool figures are informational there, and `sends_left`
 *    agrees with availability at the boundary;
 *  - the ledger-since-reading figure (informational) is summed across pages;
 *  - `R1_ENABLED` off is `not_deployed`, which is not the database switch;
 *  - nothing sensitive leaves either route (no digest, no link, no row id);
 *  - numeric strings from PostgREST are coerced, and a missing month row
 *    degrades to zeros instead of failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import { r1HrRouter } from '../routes/r1-hr.js';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const MONTH = `${new Date().toISOString().slice(0, 7)}-01`;
const READ_AT = '2026-10-06T10:00:00.000Z';
const BEFORE_READING = '2026-10-05T10:00:00.000Z';
const AFTER_READING = '2026-10-06T12:00:00.000Z';

/**
 * A query double with what the router uses: select, eq, gte, order, range and
 * maybeSingle. `range` honours its window, so paging is really exercised.
 */
function query(table: string, tables: Tables, failing: Set<string>) {
  const filters: Array<(row: Row) => boolean> = [];
  let sortKey: string | null = null;
  const matching = () => {
    const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    if (sortKey === null) return rows;
    const key = sortKey;
    return [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  };
  const q = {
    select: () => q,
    eq: (key: string, expected: unknown) => {
      filters.push((row) => row[key] === expected);
      return q;
    },
    gte: (key: string, expected: string) => {
      filters.push((row) => String(row[key]) >= expected);
      return q;
    },
    order: (key: string) => {
      sortKey = key;
      return q;
    },
    range: async (from: number, to: number) => {
      if (failing.has(table)) return { data: null, error: new Error(`${table} unavailable`) };
      return { data: matching().slice(from, to + 1), error: null };
    },
    maybeSingle: async () => {
      if (failing.has(table)) return { data: null, error: new Error(`${table} unavailable`) };
      return { data: matching()[0] ?? null, error: null };
    },
  };
  return q;
}

function baseTables(): Tables {
  return {
    r1_settings: [
      {
        singleton: true,
        enabled: true,
        paused: false,
        monthly_cap_minutes: 4000,
        pause_line_minutes: 4000,
        admission_hold_minutes: 55,
        dashboard_minutes: 0,
        dashboard_read_at: null,
      },
    ],
    roles: [{ id: 'role-r1', interview_kind: 'sales_r1' }],
    r1_budget_month: [
      { month_start: MONTH, minutes_used: 0, minutes_reserved: 0, starts_admitted: 0 },
    ],
    v_webrtc_minutes_estimate: [
      {
        month_start: MONTH,
        r1_minutes: 0,
        phone_minutes: 0,
        legacy_browser_minutes: 0,
        estimated_minutes: 0,
      },
    ],
    r1_usage_ledger: [],
  };
}

/** The estimate view for a month: the three lanes, and the view's own x1.15 total. */
function estimateOf(r1: number, phone: number, legacy = 0): Row {
  return {
    month_start: MONTH,
    r1_minutes: r1,
    phone_minutes: phone,
    legacy_browser_minutes: legacy,
    estimated_minutes: (r1 + phone + legacy) * 1.15,
  };
}

/**
 * What the 0119 snapshot is made of, before any extra hold. R1 is checked
 * against `cap` always; the pool against `line` only on the Cloud target.
 */
interface Capacity {
  target: 'r1' | 'cloud';
  cap: number;
  line: number;
  r1Committed: number;
  poolCommitted: number;
  poolGuard: number;
}

/** Mode A, 20 sessions allocated (20 x 55 = 1,100), one hold outstanding, an idle pool. */
function capacityOf(overrides: Partial<Capacity> = {}): Capacity {
  return {
    target: 'r1',
    cap: 1100,
    line: 4000,
    r1Committed: 55,
    poolCommitted: 55,
    poolGuard: 0,
    ...overrides,
  };
}

/**
 * The jsonb `r1_capacity_snapshot` answers for `p_extra_hold`. In the SQL the
 * hold lands on BOTH committed figures (`holds_post`), so headroom falls by
 * exactly the hold, and `admits` is the R1 test AND (Mode A, or the pool test).
 */
function snapshotFor(c: Capacity, extraHold: number): Row {
  const r1Committed = c.r1Committed + extraHold;
  const poolCommitted = c.poolCommitted + extraHold;
  const r1Ok = r1Committed <= c.cap;
  const poolOk = c.target !== 'cloud' || poolCommitted <= c.line;
  return {
    livekit_target: c.target,
    monthly_cap_minutes: c.cap,
    pause_line_minutes: c.line,
    pool_guard: c.poolGuard,
    r1_committed: r1Committed,
    pool_committed: poolCommitted,
    r1_headroom: c.cap - r1Committed,
    pool_headroom: c.line - poolCommitted,
    pool_check_applies: c.target === 'cloud',
    r1_ok: r1Ok,
    pool_ok: poolOk,
    admits: r1Ok && poolOk,
  };
}

interface RpcAnswer {
  data: unknown;
  error: Error | null;
}
type RpcBehaviour = (args: Row) => RpcAnswer | Promise<RpcAnswer>;

function withCapacity(c: Capacity): RpcBehaviour {
  return (args) => ({ data: snapshotFor(c, Number(args.p_extra_hold)), error: null });
}

/**
 * Production on 2026-10-08, target r1: the Cloud pool estimate holds 6,396
 * legacy-browser minutes (a session stuck in `waiting` for 2.5 days) and 412
 * phone minutes, far past the 4,000 pause line, while R1 itself has 1,045
 * minutes of its allocation left.
 */
const PRODUCTION_MODE_A = capacityOf({
  cap: 1100,
  line: 4000,
  r1Committed: 55,
  // (0 R1 + 412 phone + 6,396 legacy) x 1.15.
  poolGuard: 7829.2,
  poolCommitted: 7829.2 + 55,
});

function appFor(
  role: 'admin' | 'interviewer' | 'viewer',
  tables: Tables = baseTables(),
  failing: string[] = [],
  rpc: RpcBehaviour = withCapacity(capacityOf()),
) {
  const failingTables = new Set(failing);
  mocks.from.mockImplementation((table: string) => query(table, tables, failingTables));
  mocks.rpc.mockImplementation(async (fn: string, args: Row) => {
    if (fn !== 'r1_capacity_snapshot') throw new Error(`unexpected rpc ${fn}`);
    return rpc(args);
  });
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 'user-1', appRole: role };
    next();
  });
  app.use('/api', r1HrRouter);
  return app;
}

/** `appFor` plus an error handler, so a thrown read is observable as a 500. */
function appWithErrorHandler(...args: Parameters<typeof appFor>) {
  const app = appFor(...args);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

const AVAILABILITY = '/api/interview-rounds/availability';
const USAGE = '/api/admin/r1/usage';

function availability(
  role: 'admin' | 'interviewer' | 'viewer',
  tables?: Tables,
  failing?: string[],
  rpc?: RpcBehaviour,
) {
  return request(appFor(role, tables, failing, rpc)).get(AVAILABILITY);
}

function usage(tables: Tables, capacity: Capacity = capacityOf()) {
  return request(appFor('admin', tables, [], withCapacity(capacity))).get(USAGE);
}

/** Tables the availability route read, in order. */
function tablesRead(): string[] {
  return mocks.from.mock.calls.map(([table]) => String(table));
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  process.env.R1_ENABLED = 'true';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/interview-rounds/availability', () => {
  it('is closed to viewers and open to interviewers and admins', async () => {
    expect((await availability('viewer')).status).toBe(403);
    for (const role of ['interviewer', 'admin'] as const) {
      const response = await availability(role);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
    }
  });

  it('reports ready, with the hold, when R1 is on and the snapshot admits', async () => {
    const response = await availability('interviewer');
    expect(response.body).toEqual({ state: 'ready', hold_minutes: 55 });
  });

  it('reports not_deployed when the environment switch is off, reading no table', async () => {
    process.env.R1_ENABLED = 'false';
    const response = await availability('interviewer');
    expect(response.body.state).toBe('not_deployed');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('reports not_deployed when R1_ENABLED is unset (production today)', async () => {
    delete process.env.R1_ENABLED;
    const response = await availability('interviewer');
    expect(response.body).toEqual({ state: 'not_deployed', hold_minutes: 55 });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('keeps the database switch apart from the environment switch', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.enabled = false;
    const response = await availability('interviewer', tables);
    expect(response.body.state).toBe('disabled');
  });

  it('reports config_invalid for a malformed environment value', async () => {
    process.env.R1_ENABLED = 'maybe';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await availability('interviewer');
    errors.mockRestore();
    expect(response.body.state).toBe('config_invalid');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  // Precedence: config_invalid, not_deployed, disabled, paused, role_not_configured, then
  // capacity. The snapshot here does NOT admit, so a state that wins over it must have been
  // decided without the capacity read, which is also asserted.
  describe('keeps the precedence of the states decided before capacity', () => {
    const refusing = (): RpcBehaviour =>
      withCapacity(capacityOf({ cap: 1100, r1Committed: 1100, poolCommitted: 1100 }));

    it.each([
      ['database switch off', (t: Tables) => { t.r1_settings[0]!.enabled = false; }, 'disabled'],
      ['no settings row', (t: Tables) => { t.r1_settings = []; }, 'disabled'],
      ['paused', (t: Tables) => { t.r1_settings[0]!.paused = true; }, 'paused'],
      [
        'disabled beats paused',
        (t: Tables) => { t.r1_settings[0]!.enabled = false; t.r1_settings[0]!.paused = true; },
        'disabled',
      ],
      ['no seeded R1 role', (t: Tables) => { t.roles = []; }, 'role_not_configured'],
      [
        'paused beats a missing role',
        (t: Tables) => { t.r1_settings[0]!.paused = true; t.roles = []; },
        'paused',
      ],
    ])('reports %s over an exhausted allowance', async (_name, arrange, state) => {
      const tables = baseTables();
      arrange(tables);
      const response = await availability('interviewer', tables, [], refusing());
      expect(response.body.state).toBe(state);
      expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('reports not_deployed over an exhausted allowance', async () => {
      process.env.R1_ENABLED = 'false';
      const response = await availability('interviewer', baseTables(), [], refusing());
      expect(response.body.state).toBe('not_deployed');
      expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('reaches the capacity check only when everything before it passes', async () => {
      const response = await availability('interviewer', baseTables(), [], refusing());
      expect(response.body.state).toBe('capacity_exhausted');
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });
  });

  describe('answers from the 0119 capacity snapshot (Mode A, the self-hosted target)', () => {
    it('is ready on the r1 target however large the Cloud pool estimate is (production, 2026-10-08)', async () => {
      // The reported bug. admits = true and r1_headroom = 1,045 (at hold 0), while the pool
      // estimate holds 6,396 legacy-browser and 412 phone minutes. The old rule counted the pool
      // against least(cap, pause line) and answered capacity_exhausted.
      const tables = baseTables();
      tables.r1_settings[0]!.monthly_cap_minutes = 1100;
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 412, 6396)];
      const response = await availability(
        'interviewer',
        tables,
        [],
        withCapacity(PRODUCTION_MODE_A),
      );
      expect(response.body).toEqual({ state: 'ready', hold_minutes: 55 });
      // The pool is past the line by thousands of minutes, and does not matter here.
      const asked = snapshotFor(PRODUCTION_MODE_A, 0);
      expect(asked.pool_headroom as number).toBeLessThan(0);
      expect(asked.r1_headroom).toBe(1045);
    });

    it('reads no pool source itself: settings, the role, then the snapshot', async () => {
      await availability('interviewer', baseTables(), [], withCapacity(PRODUCTION_MODE_A));
      expect(tablesRead()).toEqual(['r1_settings', 'roles']);
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });

    it('is capacity_exhausted when the R1 allocation has no room for the hold, pool idle', async () => {
      // 1,046 committed + the 55 hold = 1,101 > the 1,100-minute allocation; the pool is idle.
      const response = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(capacityOf({ cap: 1100, r1Committed: 1046, poolGuard: 0, poolCommitted: 1046 })),
      );
      expect(response.body).toEqual({ state: 'capacity_exhausted', hold_minutes: 55 });
    });

    it('is ready when one Send exactly fits the allocation, and not one hair over', async () => {
      const fits = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(capacityOf({ cap: 1100, r1Committed: 1045 })),
      );
      expect(fits.body.state).toBe('ready');
      const over = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(capacityOf({ cap: 1100, r1Committed: 1045.01 })),
      );
      expect(over.body.state).toBe('capacity_exhausted');
    });
  });

  describe('follows the same snapshot on the Cloud target (Mode B)', () => {
    const cloud = (overrides: Partial<Capacity>) => capacityOf({ target: 'cloud', ...overrides });

    it('is ready when both the allocation and the pool have the hold to spare', async () => {
      const response = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(cloud({ cap: 1100, r1Committed: 55, line: 4000, poolCommitted: 3000 })),
      );
      expect(response.body.state).toBe('ready');
    });

    it('is capacity_exhausted when the pool line is the binding limit', async () => {
      // R1 itself has 1,045 minutes of room; the Cloud pool (phone heavy) has 10.
      const response = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(cloud({ cap: 1100, r1Committed: 55, line: 4000, poolCommitted: 3990 })),
      );
      expect(response.body.state).toBe('capacity_exhausted');
    });

    it('is ready when the pool has exactly the hold to spare', async () => {
      const response = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(cloud({ cap: 1100, r1Committed: 55, line: 4000, poolCommitted: 3945 })),
      );
      expect(response.body.state).toBe('ready');
    });

    it('is capacity_exhausted when the allocation is spent even though the pool is idle', async () => {
      const response = await availability(
        'interviewer',
        baseTables(),
        [],
        withCapacity(cloud({ cap: 1100, r1Committed: 1100, line: 4000, poolCommitted: 100 })),
      );
      expect(response.body.state).toBe('capacity_exhausted');
    });
  });

  describe('is exactly the snapshot verdict, and never ready on a failure', () => {
    it.each([
      ['admits is false', { admits: false }],
      ['admits is missing', { r1_headroom: 5000 }],
      ['admits is the string "true"', { admits: 'true' }],
      ['admits is null', { admits: null }],
      ['the payload is empty', {}],
    ])('is capacity_exhausted when %s (fail closed, like Send)', async (_name, payload) => {
      const response = await availability('interviewer', baseTables(), [], () => ({
        data: payload,
        error: null,
      }));
      expect(response.body).toEqual({ state: 'capacity_exhausted', hold_minutes: 55 });
    });

    it.each([
      ['no payload', null],
      ['a non-object payload', 'ok'],
      ['an array payload', [{ admits: true }]],
    ])('is capacity_exhausted for %s', async (_name, payload) => {
      const response = await availability('interviewer', baseTables(), [], () => ({
        data: payload,
        error: null,
      }));
      expect(response.body.state).toBe('capacity_exhausted');
    });

    it('fails with a 5xx, not ready, when the snapshot RPC returns an error', async () => {
      const response = await request(
        appWithErrorHandler('interviewer', baseTables(), [], () => ({
          data: null,
          error: new Error('rpc unavailable'),
        })),
      ).get(AVAILABILITY);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('state');
    });

    it('fails with a 5xx, not ready, when the snapshot RPC throws', async () => {
      const response = await request(
        appWithErrorHandler('interviewer', baseTables(), [], () => {
          throw new Error('network down');
        }),
      ).get(AVAILABILITY);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('state');
    });
  });

  it('asks the snapshot once, for the Send hold, with a current timestamp', async () => {
    const before = Date.now();
    await availability('interviewer');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0]!;
    expect(fn).toBe('r1_capacity_snapshot');
    expect(Object.keys(args as Row).sort()).toEqual(['p_extra_hold', 'p_now']);
    expect((args as Row).p_extra_hold).toBe(55);
    expect(new Date(String((args as Row).p_now)).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('is not memoised: a changed snapshot changes the very next answer', async () => {
    let capacity = capacityOf();
    const app = appFor('interviewer', baseTables(), [], (args) => withCapacity(capacity)(args));
    expect((await request(app).get(AVAILABILITY)).body.state).toBe('ready');
    capacity = capacityOf({ r1Committed: 1100 });
    expect((await request(app).get(AVAILABILITY)).body.state).toBe('capacity_exhausted');
    capacity = capacityOf({ r1Committed: 0 });
    expect((await request(app).get(AVAILABILITY)).body.state).toBe('ready');
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it('still reads live settings every time', async () => {
    const tables = baseTables();
    const app = appFor('interviewer', tables);
    expect((await request(app).get(AVAILABILITY)).body.state).toBe('ready');
    tables.r1_settings[0]!.paused = true;
    expect((await request(app).get(AVAILABILITY)).body.state).toBe('paused');
  });

  it('coerces a numeric-string hold from PostgREST', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.admission_hold_minutes = '55.00';
    const response = await availability('interviewer', tables);
    expect(response.body).toEqual({ state: 'ready', hold_minutes: 55 });
    expect(mocks.rpc.mock.calls[0]![1]).toMatchObject({ p_extra_hold: 55 });
  });

  it('exposes no figure beyond the hold and no identifier', async () => {
    const response = await availability('admin');
    expect(Object.keys(response.body).sort()).toEqual(['hold_minutes', 'state']);
  });

  it('fails closed with a 5xx when the settings read fails', async () => {
    const app = appWithErrorHandler('interviewer', baseTables(), ['r1_settings']);
    const response = await request(app).get(AVAILABILITY);
    expect(response.status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('the 0119 contract this file depends on', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const SQL = readFileSync(
    path.resolve(here, '../../../supabase/migrations/0119_r1_capacity_model.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const ROUTE = readFileSync(path.resolve(here, '../routes/r1-hr.ts'), 'utf8');

  const FN = 'create or replace function screening_v2.r1_capacity_snapshot(';
  const start = SQL.indexOf(FN);

  function sqlParamNames(): string[] {
    const open = SQL.indexOf('(', start);
    const close = SQL.indexOf('\n) returns', open);
    return SQL.slice(open + 1, close)
      .split(/,\s*\n/)
      .map((line) => line.trim().split(/\s+/)[0] as string)
      .filter(Boolean);
  }

  it('defines r1_capacity_snapshot with the parameters the route can name', () => {
    expect(start).toBeGreaterThan(-1);
    expect(sqlParamNames()).toEqual(['p_now', 'p_extra_hold', 'p_extra_used', 'p_extra_actual']);
  });

  it('calls it with names the SQL declares (an unknown name is PGRST202)', () => {
    const call = /rpc\('r1_capacity_snapshot', \{([^}]*)\}/.exec(ROUTE);
    expect(call, 'the route must call r1_capacity_snapshot').not.toBeNull();
    const used = [...call![1]!.matchAll(/(p_\w+):/g)].map((match) => match[1] as string);
    expect(used.sort()).toEqual(['p_extra_hold', 'p_now']);
    for (const name of used) expect(sqlParamNames()).toContain(name);
  });

  it('returns every key the routes read', () => {
    const body = SQL.slice(start, SQL.indexOf('\n$$;', start));
    for (const key of [
      'admits',
      'livekit_target',
      'pool_check_applies',
      'pool_guard',
      'r1_committed',
      'pool_committed',
      'r1_headroom',
      'pool_headroom',
    ]) {
      expect(body, key).toMatch(new RegExp(`'${key}'\\s*,`));
    }
  });

  it('is the verdict r1_send_round itself uses, with the same 55-minute hold', () => {
    expect(SQL).toMatch(
      /coalesce\(\(screening_v2\.r1_capacity_snapshot\(p_now, 55\)->>'admits'\)::boolean, false\) is not true then return jsonb_build_object\('status','capacity_exhausted'\)/,
    );
  });

  it('only applies the pause line on the Cloud target and checks the cap against R1 alone', () => {
    expect(SQL).toMatch(/v_r1_ok := v_r1_committed <= v_settings\.monthly_cap_minutes;/);
    expect(SQL).toMatch(
      /v_pool_ok := \(not v_cloud\) or v_pool_committed <= v_settings\.pause_line_minutes;/,
    );
  });
});

describe('GET /api/admin/r1/usage', () => {
  it('is admin-only', async () => {
    for (const role of ['viewer', 'interviewer'] as const) {
      expect((await request(appFor(role)).get(USAGE)).status).toBe(403);
    }
    expect((await request(appFor('admin')).get(USAGE)).status).toBe(200);
  });

  it('returns the month figures, the pool split, the snapshot figures and the runtime status', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_minutes = '1200.50';
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    tables.r1_budget_month[0] = {
      month_start: MONTH,
      minutes_used: '110.00',
      minutes_reserved: '55.00',
      starts_admitted: 2,
    };
    tables.v_webrtc_minutes_estimate[0] = {
      month_start: MONTH,
      r1_minutes: '40.5',
      phone_minutes: '900',
      legacy_browser_minutes: '10',
      estimated_minutes: '1093.575',
    };
    tables.r1_usage_ledger = [{ id: 'a', seconds: '1800.00', occurred_at: AFTER_READING }];
    // Mode A: cap 4,000 allocated, R1 committed 165 (110 used + 55 held), pool guard 1,415.075.
    const capacity = capacityOf({
      cap: 4000,
      line: 4000,
      r1Committed: 165,
      poolGuard: 1415.075,
      poolCommitted: 1470.075,
    });
    const response = await usage(tables, capacity);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      month_start: MONTH,
      monthly_cap_minutes: 4000,
      pause_line_minutes: 4000,
      hold_minutes: 55,
      dashboard_minutes: 1200.5,
      dashboard_read_at: READ_AT,
      minutes_reserved: 55,
      minutes_used: 110,
      starts_admitted: 2,
      r1_minutes: 40.5,
      phone_minutes: 900,
      legacy_browser_minutes: 10,
      estimated_minutes: 1093.575,
      // Informational: 30 R1 ledger minutes since the reading.
      ledger_since_minutes: 30,
      // The snapshot's pool guard; informational on the r1 target.
      guard_minutes: 1415.075,
      // The snapshot's r1_committed: R1's own committed minutes against the R1 allocation.
      committed_minutes: 165,
      // floor((4,000 - 165) / 55) = 69, the R1 allocation alone on the r1 target.
      sends_left: 69,
      livekit_target: 'r1',
      pool_check_applies: false,
      r1_headroom_minutes: 3835,
      pool_committed_minutes: 1470.075,
      pool_headroom_minutes: 2529.925,
      runtime: { enabled: true, status: 'enabled' },
    });
  });

  it('asks the snapshot where R1 stands now: no extra hold', async () => {
    await usage(baseTables());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0]![0]).toBe('r1_capacity_snapshot');
    expect(mocks.rpc.mock.calls[0]![1]).toMatchObject({ p_extra_hold: 0 });
  });

  it('no longer reports the old `guarded_minutes` (no ledger, no margin)', async () => {
    const response = await usage(baseTables());
    expect(response.body).not.toHaveProperty('guarded_minutes');
  });

  describe('Mode A: headroom is the R1 allocation, the pool is informational (production, 2026-10-08)', () => {
    it('reports 19 sends left from the 1,045-minute allocation headroom while the pool is far past the line', async () => {
      const tables = baseTables();
      tables.r1_settings[0]!.monthly_cap_minutes = 1100;
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 412, 6396)];
      const response = await usage(tables, PRODUCTION_MODE_A);
      expect(response.body).toMatchObject({
        livekit_target: 'r1',
        pool_check_applies: false,
        committed_minutes: 55,
        r1_headroom_minutes: 1045,
        sends_left: 19,
        // Still shown, so the owner can see the Cloud pool, but it gates nothing.
        guard_minutes: 7829.2,
        phone_minutes: 412,
        legacy_browser_minutes: 6396,
      });
      expect(response.body.pool_headroom_minutes).toBeLessThan(0);
    });

    it('does not let a full Cloud pool lower sends_left on the r1 target', async () => {
      const idle = await usage(baseTables(), capacityOf({ cap: 1100, r1Committed: 55, poolCommitted: 55 }));
      const full = await usage(
        baseTables(),
        capacityOf({ cap: 1100, r1Committed: 55, poolCommitted: 9000, poolGuard: 9000 }),
      );
      expect(full.body.sends_left).toBe(idle.body.sends_left);
      expect(full.body.sends_left).toBe(19);
    });
  });

  describe('Mode B: the Cloud pool also limits the sends that fit', () => {
    it('takes the smaller of the allocation headroom and the pool headroom', async () => {
      // R1: 1,100 - 55 = 1,045 (19 sends). Pool: 4,000 - 3,100 = 900 (16 sends).
      const response = await usage(
        baseTables(),
        capacityOf({ target: 'cloud', cap: 1100, line: 4000, r1Committed: 55, poolCommitted: 3100 }),
      );
      expect(response.body).toMatchObject({
        livekit_target: 'cloud',
        pool_check_applies: true,
        r1_headroom_minutes: 1045,
        pool_headroom_minutes: 900,
        sends_left: 16,
      });
    });

    it('leaves no sends when the pool is past the line, whatever R1 has left', async () => {
      const response = await usage(
        baseTables(),
        capacityOf({ target: 'cloud', cap: 4000, line: 4000, r1Committed: 0, poolCommitted: 3967.5, poolGuard: 3967.5 }),
      );
      expect(response.body).toMatchObject({
        guard_minutes: 3967.5,
        committed_minutes: 0,
        r1_headroom_minutes: 4000,
        sends_left: 0,
      });
    });
  });

  it('reports the ledger since the reading (informational) and counts nothing older', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_minutes = 2000;
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    tables.r1_usage_ledger = [
      { id: 'old', seconds: 90000, occurred_at: BEFORE_READING },
      { id: 'new', seconds: 6000, occurred_at: AFTER_READING },
    ];
    const response = await usage(tables);
    expect(response.body.ledger_since_minutes).toBe(100);
    // The ledger is not a guard term any more: the guard is the snapshot's alone.
    expect(response.body.guard_minutes).toBe(0);
  });

  it('reads no ledger when no reading was recorded', async () => {
    const tables = baseTables();
    tables.r1_usage_ledger = [{ id: 'a', seconds: 600000, occurred_at: AFTER_READING }];
    const response = await usage(tables);
    expect(response.body.ledger_since_minutes).toBe(0);
    expect(tablesRead()).not.toContain('r1_usage_ledger');
  });

  it('sums the ledger across PostgREST pages, not just the first 1,000 rows', async () => {
    // 2,500 rows x 60 s = 2,500 minutes. Only the first page would give 1,000.
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    tables.r1_usage_ledger = Array.from({ length: 2500 }, (_, i) => ({
      id: `row-${String(i).padStart(5, '0')}`,
      seconds: 60,
      occurred_at: AFTER_READING,
    }));
    expect((await usage(tables)).body.ledger_since_minutes).toBe(2500);
  });

  it('treats a ledger of exactly one page as complete (no phantom second page)', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    tables.r1_usage_ledger = Array.from({ length: 1000 }, (_, i) => ({
      id: `row-${String(i).padStart(5, '0')}`,
      seconds: 60,
      occurred_at: AFTER_READING,
    }));
    expect((await usage(tables)).body.ledger_since_minutes).toBe(1000);
  });

  it('agrees with the availability answer at the boundary, in both targets', async () => {
    // sends_left is the number of Sends the snapshot would admit; availability is ready iff >= 1.
    const cases: Array<[Partial<Capacity>, 'ready' | 'capacity_exhausted']> = [
      [{ target: 'r1', cap: 1100, r1Committed: 1045 }, 'ready'],
      [{ target: 'r1', cap: 1100, r1Committed: 1045.01 }, 'capacity_exhausted'],
      [{ target: 'cloud', cap: 4000, r1Committed: 0, line: 4000, poolCommitted: 3945 }, 'ready'],
      [
        { target: 'cloud', cap: 4000, r1Committed: 0, line: 4000, poolCommitted: 3945.01 },
        'capacity_exhausted',
      ],
      [{ target: 'cloud', cap: 1100, r1Committed: 1046, line: 4000, poolCommitted: 100 }, 'capacity_exhausted'],
    ];
    for (const [overrides, expected] of cases) {
      const capacity = capacityOf(overrides);
      const figures = (await usage(baseTables(), capacity)).body;
      expect(figures.sends_left >= 1, JSON.stringify(overrides)).toBe(expected === 'ready');
      const state = (
        await availability('interviewer', baseTables(), [], withCapacity(capacity))
      ).body.state;
      expect(state, JSON.stringify(overrides)).toBe(expected);
    }
  });

  it('never reports a negative sends_left', async () => {
    const response = await usage(
      baseTables(),
      capacityOf({ cap: 1100, r1Committed: 5000, poolCommitted: 5000 }),
    );
    expect(response.body.sends_left).toBe(0);
    // The headroom itself keeps its sign: negative means over the allocation.
    expect(response.body.r1_headroom_minutes).toBe(-3900);
  });

  it('degrades a month with no rows to zeros instead of failing', async () => {
    const tables = baseTables();
    tables.r1_budget_month = [];
    tables.v_webrtc_minutes_estimate = [];
    const response = await usage(tables, capacityOf({ cap: 4000, r1Committed: 0, poolCommitted: 0 }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      minutes_reserved: 0,
      minutes_used: 0,
      starts_admitted: 0,
      r1_minutes: 0,
      phone_minutes: 0,
      legacy_browser_minutes: 0,
      estimated_minutes: 0,
      ledger_since_minutes: 0,
      guard_minutes: 0,
      committed_minutes: 0,
      sends_left: 72,
    });
  });

  it('coerces numeric strings in the snapshot', async () => {
    const response = await request(
      appFor('admin', baseTables(), [], () => ({
        data: {
          livekit_target: 'cloud',
          pool_check_applies: true,
          pool_guard: '3967.50',
          r1_committed: '55.00',
          pool_committed: '4022.50',
          r1_headroom: '3945.00',
          pool_headroom: '-22.50',
        },
        error: null,
      })),
    ).get(USAGE);
    expect(response.body).toMatchObject({
      guard_minutes: 3967.5,
      committed_minutes: 55,
      pool_headroom_minutes: -22.5,
      sends_left: 0,
    });
  });

  it('fails with a 5xx, not zeros, when the snapshot RPC returns an error', async () => {
    const response = await request(
      appWithErrorHandler('admin', baseTables(), [], () => ({
        data: null,
        error: new Error('rpc unavailable'),
      })),
    ).get(USAGE);
    expect(response.status).toBe(500);
  });

  it('fails with a 5xx, not zeros, when the snapshot comes back empty', async () => {
    const response = await request(
      appWithErrorHandler('admin', baseTables(), [], () => ({ data: null, error: null })),
    ).get(USAGE);
    expect(response.status).toBe(500);
  });

  it('fails with a 5xx when the ledger read fails', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    const response = await request(appWithErrorHandler('admin', tables, ['r1_usage_ledger'])).get(
      USAGE,
    );
    expect(response.status).toBe(500);
  });

  it('reports a disabled runtime without hiding the figures', async () => {
    process.env.R1_ENABLED = 'false';
    const response = await request(appFor('admin')).get(USAGE);
    expect(response.body.runtime).toEqual({ enabled: false, status: 'disabled' });
    expect(response.body.monthly_cap_minutes).toBe(4000);
  });

  it('returns no row ids, tokens or digests', async () => {
    const response = await request(appFor('admin')).get(USAGE);
    expect(JSON.stringify(response.body)).not.toMatch(/digest|token|secret|"id"/i);
  });
});
