/**
 * PR-7 read models: GET /api/interview-rounds/availability and
 * GET /api/admin/r1/usage.
 *
 * What is pinned here:
 *  - role gates (viewer refused on both; interviewer refused on usage);
 *  - every availability state, in the documented precedence order;
 *  - the capacity answer is the RPC's own formula, not R1's minutes alone:
 *    `max(minutes_used, guard) + reserved + hold <= least(cap, line)` with
 *    `guard = max(dashboard + ledger since the reading, r1 + phone + legacy) * 1.15`
 *    (0117 `r1_send_round`). Phone minutes and the dashboard reading both
 *    reach `capacity_exhausted`; the exact boundary is `ready`;
 *  - the ledger is summed across PostgREST pages and only from the reading on;
 *  - the availability guard is memoised and keyed on the dashboard reading;
 *  - `R1_ENABLED` off is `not_deployed`, which is not the database switch;
 *  - nothing sensitive leaves either route (no digest, no link, no row id);
 *  - numeric strings from PostgREST are coerced, and a missing month row
 *    degrades to zeros instead of failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from } }));

import { __resetR1GuardCacheForTest, r1HrRouter } from '../routes/r1-hr.js';

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

function appFor(
  role: 'admin' | 'interviewer' | 'viewer',
  tables: Tables = baseTables(),
  failing: string[] = [],
) {
  const failingTables = new Set(failing);
  mocks.from.mockImplementation((table: string) => query(table, tables, failingTables));
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 'user-1', appRole: role };
    next();
  });
  app.use('/api', r1HrRouter);
  return app;
}

const AVAILABILITY = '/api/interview-rounds/availability';
const USAGE = '/api/admin/r1/usage';

function availability(
  role: 'admin' | 'interviewer' | 'viewer',
  tables?: Tables,
  failing?: string[],
) {
  return request(appFor(role, tables, failing)).get(AVAILABILITY);
}

function usage(tables: Tables) {
  return request(appFor('admin', tables)).get(USAGE);
}

/** How many times the router read the (expensive) estimate view. */
function estimateReads(): number {
  return mocks.from.mock.calls.filter(([table]) => table === 'v_webrtc_minutes_estimate').length;
}

beforeEach(() => {
  mocks.from.mockReset();
  __resetR1GuardCacheForTest();
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

  it('reports ready, with the hold, when R1 is on and has allowance left', async () => {
    const response = await availability('interviewer');
    expect(response.body).toEqual({ state: 'ready', hold_minutes: 55 });
  });

  it('reports not_deployed when the environment switch is off, reading no table', async () => {
    process.env.R1_ENABLED = 'false';
    const response = await availability('interviewer');
    expect(response.body.state).toBe('not_deployed');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('reports not_deployed when R1_ENABLED is unset (production today)', async () => {
    delete process.env.R1_ENABLED;
    const response = await availability('interviewer');
    expect(response.body).toEqual({ state: 'not_deployed', hold_minutes: 55 });
    expect(mocks.from).not.toHaveBeenCalled();
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
  });

  it.each([
    ['database switch off', (t: Tables) => { t.r1_settings[0]!.enabled = false; }, 'disabled'],
    ['no settings row', (t: Tables) => { t.r1_settings = []; }, 'disabled'],
    ['paused', (t: Tables) => { t.r1_settings[0]!.paused = true; }, 'paused'],
    ['no seeded R1 role', (t: Tables) => { t.roles = []; }, 'role_not_configured'],
    [
      'allowance used',
      (t: Tables) => { t.r1_budget_month[0]!.minutes_used = 3946; },
      'capacity_exhausted',
    ],
    [
      'allowance reserved by outstanding sends',
      (t: Tables) => { t.r1_budget_month[0]!.minutes_reserved = 3946; },
      'capacity_exhausted',
    ],
  ])('reports %s', async (_name, arrange, state) => {
    const tables = baseTables();
    arrange(tables);
    const response = await availability('interviewer', tables);
    expect(response.body.state).toBe(state);
  });

  it('uses the lower of the cap and the pause line as the ceiling', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.monthly_cap_minutes = 5000;
    tables.r1_settings[0]!.pause_line_minutes = 100;
    tables.r1_budget_month[0]!.minutes_used = 46;
    const response = await availability('interviewer', tables);
    expect(response.body.state).toBe('capacity_exhausted');
  });

  it('is ready when one send exactly fits', async () => {
    const tables = baseTables();
    tables.r1_budget_month[0]!.minutes_used = 3945;
    const response = await availability('interviewer', tables);
    expect(response.body.state).toBe('ready');
  });

  it('is ready for a new month that has no budget row yet', async () => {
    const tables = baseTables();
    tables.r1_budget_month = [];
    const response = await availability('interviewer', tables);
    expect(response.body.state).toBe('ready');
  });

  it('coerces numeric strings from PostgREST', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.monthly_cap_minutes = '4000.00';
    tables.r1_settings[0]!.pause_line_minutes = '4000.00';
    tables.r1_budget_month[0]!.minutes_used = '3946.00';
    const response = await availability('interviewer', tables);
    expect(response.body.state).toBe('capacity_exhausted');
  });

  it('exposes no figure beyond the hold and no identifier', async () => {
    const response = await availability('admin');
    expect(Object.keys(response.body).sort()).toEqual(['hold_minutes', 'state']);
  });

  it('fails closed with a 5xx when the settings read fails', async () => {
    const app = appFor('interviewer', baseTables(), ['r1_settings']);
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: 'internal' });
    });
    const response = await request(app).get(AVAILABILITY);
    expect(response.status).toBe(500);
  });

  it.each(['v_webrtc_minutes_estimate', 'r1_usage_ledger', 'r1_budget_month'])(
    'fails with a 5xx, not a guess, when the %s read fails',
    async (table) => {
      const tables = baseTables();
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      const app = appFor('interviewer', tables, [table]);
      app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ error: 'internal' });
      });
      expect((await request(app).get(AVAILABILITY)).status).toBe(500);
    },
  );

  describe('the shared-pool guard the RPC applies (P1)', () => {
    it('is capacity_exhausted when phone minutes alone fill the pool', async () => {
      // 3,450 phone minutes x 1.15 = 3,967.5; plus the 55-minute hold is 4,022.5 > 4,000.
      // R1's own used and reserved minutes are 0, which the old answer looked at.
      const tables = baseTables();
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 3450)];
      const response = await availability('interviewer', tables);
      expect(response.body).toEqual({ state: 'capacity_exhausted', hold_minutes: 55 });
    });

    it('stays ready while the guard plus the hold still fits', async () => {
      // 3,430 x 1.15 = 3,944.5; plus 55 is 3,999.5 <= 4,000.
      const tables = baseTables();
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 3430)];
      expect((await availability('interviewer', tables)).body.state).toBe('ready');
    });

    it('adds the three lanes of the estimate, not just phone', async () => {
      const tables = baseTables();
      tables.v_webrtc_minutes_estimate = [estimateOf(900, 1500, 1100)];
      expect((await availability('interviewer', tables)).body.state).toBe('capacity_exhausted');
    });

    it('is capacity_exhausted past the line by dashboard reading plus ledger', async () => {
      // (3,000 + 500 ledger minutes since the reading) x 1.15 = 4,025 > 4,000 - 55.
      const tables = baseTables();
      tables.r1_settings[0]!.dashboard_minutes = 3000;
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      tables.r1_usage_ledger = [
        { id: 'a', seconds: '15000.00', occurred_at: AFTER_READING },
        { id: 'b', seconds: 15000, occurred_at: AFTER_READING },
      ];
      expect((await availability('interviewer', tables)).body.state).toBe('capacity_exhausted');
    });

    it('ignores ledger rows recorded before the reading', async () => {
      const tables = baseTables();
      tables.r1_settings[0]!.dashboard_minutes = 3000;
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      tables.r1_usage_ledger = [{ id: 'a', seconds: 600000, occurred_at: BEFORE_READING }];
      // 3,000 x 1.15 = 3,450; plus 55 fits.
      expect((await availability('interviewer', tables)).body.state).toBe('ready');
    });

    it('reads no ledger when no reading was recorded', async () => {
      const tables = baseTables();
      tables.r1_usage_ledger = [{ id: 'a', seconds: 600000, occurred_at: AFTER_READING }];
      expect((await availability('interviewer', tables)).body.state).toBe('ready');
      expect(mocks.from.mock.calls.map(([t]) => t)).not.toContain('r1_usage_ledger');
    });

    it('takes the larger of dashboard and pure estimate, never their sum', async () => {
      // max(1,000, 2,000) x 1.15 = 2,300. A sum would be 3,450 x 1.15 = 3,967.5 and refuse.
      const tables = baseTables();
      tables.r1_settings[0]!.dashboard_minutes = 1000;
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 2000)];
      expect((await availability('interviewer', tables)).body.state).toBe('ready');
    });

    it('counts the guard against used minutes with max, and holds on top of it', async () => {
      // used 1,000 < guard 2,300, so the guard governs; reserved 1,645 is added on top.
      const exactFit = baseTables();
      exactFit.v_webrtc_minutes_estimate = [estimateOf(0, 2000)];
      exactFit.r1_budget_month[0]!.minutes_used = 1000;
      exactFit.r1_budget_month[0]!.minutes_reserved = 1645;
      // 2,300 + 1,645 + 55 = 4,000: exactly fits.
      expect((await availability('interviewer', exactFit)).body.state).toBe('ready');

      const oneOver = baseTables();
      oneOver.v_webrtc_minutes_estimate = [estimateOf(0, 2000)];
      oneOver.r1_budget_month[0]!.minutes_used = 1000;
      oneOver.r1_budget_month[0]!.minutes_reserved = 1646;
      expect((await availability('interviewer', oneOver)).body.state).toBe('capacity_exhausted');
    });

    it('lets admitted minutes govern when they exceed the guard', async () => {
      const tables = baseTables();
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 100)];
      tables.r1_budget_month[0]!.minutes_used = 3946;
      expect((await availability('interviewer', tables)).body.state).toBe('capacity_exhausted');
    });

    it('sums the ledger across PostgREST pages, not just the first 1,000 rows', async () => {
      // 2,500 rows x 60 s = 2,500 minutes. (1,000 + 2,500) x 1.15 = 4,025 refuses.
      // Only the first page (1,000 minutes) would give 2,300 and say ready.
      const tables = baseTables();
      tables.r1_settings[0]!.dashboard_minutes = 1000;
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      tables.r1_usage_ledger = Array.from({ length: 2500 }, (_, i) => ({
        id: `row-${String(i).padStart(5, '0')}`,
        seconds: 60,
        occurred_at: AFTER_READING,
      }));
      expect((await availability('interviewer', tables)).body.state).toBe('capacity_exhausted');
    });

    it('treats a ledger of exactly one page as complete (no phantom second page)', async () => {
      const tables = baseTables();
      tables.r1_settings[0]!.dashboard_minutes = 1000;
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      tables.r1_usage_ledger = Array.from({ length: 1000 }, (_, i) => ({
        id: `row-${String(i).padStart(5, '0')}`,
        seconds: 60,
        occurred_at: AFTER_READING,
      }));
      expect((await availability('interviewer', tables)).body.state).toBe('ready');
    });
  });

  describe('the memoised guard', () => {
    function phoneHeavyTables(): Tables {
      const tables = baseTables();
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 100)];
      return tables;
    }

    it('reads the estimate view once for repeated asks inside a minute', async () => {
      const app = appFor('interviewer', phoneHeavyTables());
      await request(app).get(AVAILABILITY);
      await request(app).get(AVAILABILITY);
      await request(app).get(AVAILABILITY);
      expect(estimateReads()).toBe(1);
    });

    it('reads it again once the minute is over', async () => {
      const app = appFor('interviewer', phoneHeavyTables());
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      await request(app).get(AVAILABILITY);
      clock.mockReturnValue(start + 59_000);
      await request(app).get(AVAILABILITY);
      expect(estimateReads()).toBe(1);
      clock.mockReturnValue(start + 61_000);
      await request(app).get(AVAILABILITY);
      expect(estimateReads()).toBe(2);
    });

    it('is busted by a new dashboard reading, so recording one takes effect at once', async () => {
      const tables = phoneHeavyTables();
      const app = appFor('interviewer', tables);
      expect((await request(app).get(AVAILABILITY)).body.state).toBe('ready');
      tables.r1_settings[0]!.dashboard_minutes = 3600;
      tables.r1_settings[0]!.dashboard_read_at = READ_AT;
      expect((await request(app).get(AVAILABILITY)).body.state).toBe('capacity_exhausted');
      expect(estimateReads()).toBe(2);
    });

    it('still reads live settings and budget every time (only the guard is reused)', async () => {
      const tables = phoneHeavyTables();
      const app = appFor('interviewer', tables);
      expect((await request(app).get(AVAILABILITY)).body.state).toBe('ready');
      tables.r1_settings[0]!.paused = true;
      expect((await request(app).get(AVAILABILITY)).body.state).toBe('paused');
      tables.r1_settings[0]!.paused = false;
      tables.r1_budget_month[0]!.minutes_reserved = 3946;
      expect((await request(app).get(AVAILABILITY)).body.state).toBe('capacity_exhausted');
      expect(estimateReads()).toBe(1);
    });
  });
});

describe('GET /api/admin/r1/usage', () => {
  it('is admin-only', async () => {
    for (const role of ['viewer', 'interviewer'] as const) {
      expect((await request(appFor(role)).get(USAGE)).status).toBe(403);
    }
    expect((await request(appFor('admin')).get(USAGE)).status).toBe(200);
  });

  it('returns the month figures, the pool split, the guard and the runtime status', async () => {
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
    const response = await usage(tables);
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
      // max(1,200.5 + 30 ledger minutes since the reading, 950.5 pure) x 1.15.
      ledger_since_minutes: 30,
      guard_minutes: 1415.075,
      // max(used 110, guard 1,415.075) + reserved 55.
      committed_minutes: 1470.075,
      // floor((4,000 - 1,470.075) / 55) = 45.
      sends_left: 45,
      runtime: { enabled: true, status: 'enabled' },
    });
  });

  it('no longer reports the old `guarded_minutes` (no ledger, no margin)', async () => {
    const response = await usage(baseTables());
    expect(response.body).not.toHaveProperty('guarded_minutes');
  });

  it('reports the shared-pool guard, so phone minutes leave no sends (P2)', async () => {
    // The finding's figures: 3,450 phone minutes, R1 used and reserved 0. The old tile
    // said 72 more sends fit while the RPC refused every send.
    const tables = baseTables();
    tables.v_webrtc_minutes_estimate = [estimateOf(0, 3450)];
    const response = await usage(tables);
    expect(response.body).toMatchObject({
      guard_minutes: 3967.5,
      committed_minutes: 3967.5,
      sends_left: 0,
    });
  });

  it('counts the dashboard reading at x1.15 with the ledger since it (P2)', async () => {
    // Dashboard 3,600 read today and a pure estimate of 3,000: the RPC guard is 4,140.
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_minutes = 3600;
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    tables.v_webrtc_minutes_estimate = [estimateOf(0, 3000)];
    const response = await usage(tables);
    expect(response.body).toMatchObject({ guard_minutes: 4140, sends_left: 0 });
  });

  it('adds the ledger since the reading to the dashboard figure, and nothing older', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_minutes = 2000;
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    tables.r1_usage_ledger = [
      { id: 'old', seconds: 90000, occurred_at: BEFORE_READING },
      { id: 'new', seconds: 6000, occurred_at: AFTER_READING },
    ];
    const response = await usage(tables);
    expect(response.body.ledger_since_minutes).toBe(100);
    expect(response.body.guard_minutes).toBe(2415);
  });

  it('answers sends_left from the ceiling, the committed minutes and the hold', async () => {
    const tables = baseTables();
    tables.v_webrtc_minutes_estimate = [estimateOf(0, 1500)];
    tables.r1_budget_month[0]!.minutes_reserved = 55;
    const response = await usage(tables);
    // guard 1,725; committed 1,725 + 55 = 1,780; floor(2,220 / 55) = 40.
    expect(response.body).toMatchObject({
      guard_minutes: 1725,
      committed_minutes: 1780,
      sends_left: 40,
    });
  });

  it('agrees with the availability answer at the boundary', async () => {
    // sends_left is the number of sends the RPC would admit; availability is ready iff >= 1.
    for (const [reserved, expected] of [
      [1645, 'ready'],
      [1646, 'capacity_exhausted'],
    ] as const) {
      __resetR1GuardCacheForTest();
      const tables = baseTables();
      tables.v_webrtc_minutes_estimate = [estimateOf(0, 2000)];
      tables.r1_budget_month[0]!.minutes_reserved = reserved;
      const figures = (await usage(tables)).body;
      expect(figures.sends_left >= 1).toBe(expected === 'ready');
      expect((await availability('interviewer', tables)).body.state).toBe(expected);
    }
  });

  it('never reports a negative sends_left', async () => {
    const tables = baseTables();
    tables.r1_budget_month[0]!.minutes_used = 9000;
    expect((await usage(tables)).body.sends_left).toBe(0);
  });

  it('degrades a month with no rows to zeros instead of failing', async () => {
    const tables = baseTables();
    tables.r1_budget_month = [];
    tables.v_webrtc_minutes_estimate = [];
    const response = await usage(tables);
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

  it('is never served from the availability memo', async () => {
    const tables = baseTables();
    tables.v_webrtc_minutes_estimate = [estimateOf(0, 100)];
    await availability('interviewer', tables);
    tables.v_webrtc_minutes_estimate = [estimateOf(0, 3450)];
    expect((await usage(tables)).body.guard_minutes).toBe(3967.5);
  });

  it('fails with a 5xx when the ledger read fails', async () => {
    const tables = baseTables();
    tables.r1_settings[0]!.dashboard_read_at = READ_AT;
    const app = appFor('admin', tables, ['r1_usage_ledger']);
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: 'internal' });
    });
    expect((await request(app).get(USAGE)).status).toBe(500);
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
