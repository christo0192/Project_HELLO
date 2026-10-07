/**
 * R1 read models for the HR web (PR-7).
 *
 * Two read-only routes, added because the PR-2 surface cannot feed the UI:
 *
 *  - `GET /api/interview-rounds/availability` (interviewer+). The settings
 *    route is admin-only, so an interviewer's "Send R1" card had no way to
 *    learn that R1 is off, paused or out of allowance until a send failed.
 *    This answers with ONE coarse state and no figures.
 *  - `GET /api/admin/r1/usage` (admin). No existing route exposes the
 *    monthly budget row or the WebRTC minute estimate that Mission Control
 *    needs for its R1 tiles.
 *
 * Deploy footprint. This file changes `app/api`, so `deploy-fly.yml` treats
 * the merge as api=true and database=true: the API restarts (it hosts the
 * phone queue runtime) and migration convergence runs. It is NOT a web-only
 * merge. Plan §9's pre-merge gate therefore applies in full: merge inside
 * 07:00-08:30 IST, R1 paused 30 minutes ahead, and the read-only zero checks
 * (live R1 sessions, live phone attempts, `phone.dial` due, active
 * `phone.assessment`) before merging.
 *
 * Invariants:
 *  - Neither route writes, audits or returns a secret, a link or a digest.
 *  - The capacity RPCs (`r1_send_round`, `r1_admit_attempt`) stay the only
 *    authority, and the figures here are THEIR formula, not a lower bound:
 *
 *      guard     = max(dashboard_minutes + ledger since dashboard_read_at,
 *                      r1 + phone + legacy-browser minutes) * 1.15
 *      committed = max(minutes_used, guard) + minutes_reserved
 *      a send fits  <=>  committed + hold <= least(cap, pause line)
 *
 *    The cap bounds the SHARED WebRTC pool plus R1's holds, not R1's own
 *    minutes: phone minutes dominate `guard`. Answering from R1's own
 *    `minutes_used + minutes_reserved` alone would say `ready` while the
 *    RPC refuses every send, which leaves HR clicking a button that always
 *    fails. Keep `poolGuard` and `capacityFigures` in step with the RPC.
 *  - Numeric columns may arrive as strings (PostgREST `numeric`), so every
 *    figure goes through `num`.
 *  - Reads use `select('*')` on the budget and estimate sources and pick
 *    fields defensively, so a capacity-model migration that adds or renames
 *    a column degrades a figure to 0 instead of failing the request.
 *  - The availability guard is memoised for a minute: it reads a view that
 *    aggregates `call_sessions` and `phone_call_attempts`, and every
 *    candidate page asks. The usage route (admin, rare) is always fresh.
 */
import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { getR1Config } from '../lib/r1/config.js';
import { requireRole } from '../lib/rbac.js';

export const r1HrRouter = Router();

type Row = Record<string, unknown>;

/** The estimate view and budget table are keyed by the first day of the UTC month. */
function currentMonthStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Postgres adds these as exact numerics; shave the binary-float noise so ties compare as ties. */
function exact(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The hold a send reserves; mirrors the 0115 CHECK on `admission_hold_minutes`. */
const DEFAULT_HOLD_MINUTES = 55;
/** The safety margin both capacity RPCs apply to the pool figure (0117). */
const POOL_MARGIN = 1.15;
/** How long the availability guard is reused. */
const GUARD_CACHE_MS = 60_000;
/** PostgREST caps a response at 1000 rows by default, so the ledger is summed in pages. */
const LEDGER_PAGE_ROWS = 1000;
/** A runaway bound (100k rows), far beyond a month of R1 ledger events. */
const LEDGER_MAX_PAGES = 100;

export type R1AvailabilityState =
  | 'ready'
  | 'not_deployed'
  | 'disabled'
  | 'paused'
  | 'capacity_exhausted'
  | 'role_not_configured'
  | 'config_invalid';

/** The inputs of the RPCs' pool guard, and the guard itself, in minutes. */
interface PoolGuard {
  /** r1 + phone + legacy-browser minutes for the month, before the margin. */
  pureMinutes: number;
  /** R1 ledger minutes recorded at or after `dashboard_read_at`. */
  ledgerSinceMinutes: number;
  guardMinutes: number;
}

/**
 * The ledger since the owner's last dashboard reading. With no reading the
 * RPCs use "now" as the baseline, which no row satisfies, so the answer is 0.
 */
async function ledgerMinutesSinceReading(settings: Row | null): Promise<number> {
  const readAt = settings?.dashboard_read_at;
  if (typeof readAt !== 'string' || readAt === '') return 0;
  let seconds = 0;
  for (let page = 0; page < LEDGER_MAX_PAGES; page += 1) {
    const from = page * LEDGER_PAGE_ROWS;
    const { data, error } = await supabase
      .from('r1_usage_ledger')
      .select('seconds')
      .gte('occurred_at', readAt)
      .order('id', { ascending: true })
      .range(from, from + LEDGER_PAGE_ROWS - 1);
    if (error) throw error;
    const rows: Row[] = data ?? [];
    for (const row of rows) seconds += num(row.seconds);
    if (rows.length < LEDGER_PAGE_ROWS) break;
  }
  return seconds / 60;
}

async function readEstimate(monthStart: string): Promise<Row | null> {
  const { data, error } = await supabase
    .from('v_webrtc_minutes_estimate')
    .select('*')
    .eq('month_start', monthStart)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** `v_pure` and `v_guard` of `r1_send_round`, from an already-read estimate row. */
function poolGuard(
  settings: Row | null,
  estimate: Row | null,
  ledgerSinceMinutes: number,
): PoolGuard {
  const pureMinutes =
    num(estimate?.r1_minutes) +
    num(estimate?.phone_minutes) +
    num(estimate?.legacy_browser_minutes);
  const guardMinutes = exact(
    Math.max(num(settings?.dashboard_minutes) + ledgerSinceMinutes, pureMinutes) * POOL_MARGIN,
  );
  return {
    pureMinutes: exact(pureMinutes),
    ledgerSinceMinutes: exact(ledgerSinceMinutes),
    guardMinutes,
  };
}

let guardCache: { key: string; at: number; guard: PoolGuard } | null = null;

/** Test hook: the memo outlives a request, so suites that vary the tables reset it. */
export function __resetR1GuardCacheForTest(): void {
  guardCache = null;
}

/**
 * The guard for the availability answer. The key carries every setting the
 * guard reads, so recording a dashboard reading takes effect immediately; the
 * estimate itself may be up to a minute old, which is fine for a hint the RPC
 * re-checks.
 */
async function cachedPoolGuard(settings: Row, monthStart: string): Promise<PoolGuard> {
  const key = [
    monthStart,
    num(settings.dashboard_minutes),
    String(settings.dashboard_read_at ?? ''),
  ].join('|');
  const now = Date.now();
  if (guardCache && guardCache.key === key && now - guardCache.at < GUARD_CACHE_MS) {
    return guardCache.guard;
  }
  const [estimate, ledgerSince] = await Promise.all([
    readEstimate(monthStart),
    ledgerMinutesSinceReading(settings),
  ]);
  const guard = poolGuard(settings, estimate, ledgerSince);
  guardCache = { key, at: now, guard };
  return guard;
}

interface CapacityFigures {
  hold: number;
  /** `least(monthly_cap_minutes, pause_line_minutes)`, the line the RPCs enforce. */
  ceiling: number;
  /** `max(minutes_used, guard) + minutes_reserved`. */
  committed: number;
  /** Whole sends that still fit; the RPC admits one iff this is at least 1. */
  sendsLeft: number;
}

/** The RPC's capacity test, `committed + hold > ceiling`, as figures. */
function capacityFigures(settings: Row, month: Row | null, guard: PoolGuard): CapacityFigures {
  const hold = num(settings.admission_hold_minutes) || DEFAULT_HOLD_MINUTES;
  const ceiling = Math.min(num(settings.monthly_cap_minutes), num(settings.pause_line_minutes));
  const committed = exact(
    Math.max(num(month?.minutes_used), guard.guardMinutes) + num(month?.minutes_reserved),
  );
  const sendsLeft = Math.max(0, Math.floor(exact(ceiling - committed) / hold));
  return { hold, ceiling, committed, sendsLeft };
}

r1HrRouter.get(
  '/interview-rounds/availability',
  requireRole('interviewer'),
  async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const answer = (state: R1AvailabilityState, holdMinutes = DEFAULT_HOLD_MINUTES) =>
        res.json({ state, hold_minutes: holdMinutes });

      const config = getR1Config();
      if (config.status === 'invalid') return answer('config_invalid');
      // R1_ENABLED is unset or false: this server does not run R1 at all, which
      // is not the admin's database switch and is not fixable in R1 settings.
      if (!config.enabled) return answer('not_deployed');

      const { data: settings, error } = await supabase
        .from('r1_settings')
        .select('*')
        .eq('singleton', true)
        .maybeSingle();
      if (error) throw error;
      const hold = num(settings?.admission_hold_minutes) || DEFAULT_HOLD_MINUTES;
      if (!settings?.enabled) return answer('disabled', hold);
      if (settings.paused) return answer('paused', hold);

      // Same lookup, and same "no role means not configured", as Send R1.
      const { data: role } = await supabase
        .from('roles')
        .select('id')
        .eq('interview_kind', 'sales_r1')
        .maybeSingle();
      if (!role) return answer('role_not_configured', hold);

      const monthStart = currentMonthStart();
      const [monthResult, guard] = await Promise.all([
        supabase.from('r1_budget_month').select('*').eq('month_start', monthStart).maybeSingle(),
        cachedPoolGuard(settings, monthStart),
      ]);
      if (monthResult.error) throw monthResult.error;
      const figures = capacityFigures(settings, monthResult.data, guard);
      if (figures.sendsLeft < 1) return answer('capacity_exhausted', hold);
      return answer('ready', hold);
    } catch (error) {
      next(error);
    }
  },
);

r1HrRouter.get('/admin/r1/usage', requireRole('admin'), async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const monthStart = currentMonthStart();
    const [settingsResult, budgetResult, estimateResult] = await Promise.all([
      supabase.from('r1_settings').select('*').eq('singleton', true).maybeSingle(),
      supabase.from('r1_budget_month').select('*').eq('month_start', monthStart).maybeSingle(),
      supabase
        .from('v_webrtc_minutes_estimate')
        .select('*')
        .eq('month_start', monthStart)
        .maybeSingle(),
    ]);
    if (settingsResult.error) throw settingsResult.error;
    if (budgetResult.error) throw budgetResult.error;
    if (estimateResult.error) throw estimateResult.error;
    const settings: Row | null = settingsResult.data;
    const budget: Row | null = budgetResult.data;
    const estimate: Row | null = estimateResult.data;
    const guard = poolGuard(settings, estimate, await ledgerMinutesSinceReading(settings));
    const figures = capacityFigures(settings ?? {}, budget, guard);
    res.json({
      month_start: monthStart,
      monthly_cap_minutes: num(settings?.monthly_cap_minutes),
      pause_line_minutes: num(settings?.pause_line_minutes),
      hold_minutes: figures.hold,
      dashboard_minutes: num(settings?.dashboard_minutes),
      dashboard_read_at: settings?.dashboard_read_at ?? null,
      minutes_reserved: num(budget?.minutes_reserved),
      minutes_used: num(budget?.minutes_used),
      starts_admitted: num(budget?.starts_admitted),
      r1_minutes: num(estimate?.r1_minutes),
      phone_minutes: num(estimate?.phone_minutes),
      legacy_browser_minutes: num(estimate?.legacy_browser_minutes),
      estimated_minutes: num(estimate?.estimated_minutes),
      // The pool guard exactly as the capacity RPCs compute it (see the header).
      ledger_since_minutes: guard.ledgerSinceMinutes,
      guard_minutes: guard.guardMinutes,
      committed_minutes: figures.committed,
      sends_left: figures.sendsLeft,
      runtime: getR1Config(),
    });
  } catch (error) {
    next(error);
  }
});
