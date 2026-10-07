/**
 * R1 read models for the HR web (PR-7), on the 0119 capacity model.
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
 *  - Neither route owns a capacity rule. `screening_v2.r1_capacity_snapshot`
 *    (0119) is the single function behind `r1_send_round`, `r1_admit_attempt`,
 *    the reissue re-check and `v_r1_budget_month`, so asking it is the only way
 *    the card, Mission Control and a Send can never disagree. Its model:
 *
 *      monthly_cap_minutes  the R1 ALLOCATION, checked against R1's own
 *                           committed minutes, in both LiveKit targets;
 *      pause_line_minutes   the Cloud pool line, checked against the whole
 *                           shared pool ONLY while livekit_target = 'cloud'
 *                           (Mode B). On the self-hosted target ('r1', Mode A)
 *                           R1 uses no Cloud minutes, so the pool figures
 *                           (phone, legacy browser, the dashboard reading) are
 *                           informational and never gate a Send.
 *
 *    Availability asks for the verdict with the hold a Send adds and answers
 *    `capacity_exhausted` exactly when `admits` is not true, the same fail-closed
 *    test Send runs. It does not recompute anything: re-deriving the old 0117
 *    rule here (least(cap, pause line) against the pool guard) greyed out Send R1
 *    in production while the RPC admitted, because Cloud-pool minutes that Mode A
 *    never spends were counted against the R1 allocation.
 *  - Numeric columns may arrive as strings (PostgREST `numeric`), so every
 *    figure goes through `num`.
 *  - Reads of the budget and estimate sources use `select('*')` and pick fields
 *    defensively, so a capacity-model migration that adds or renames a column
 *    degrades a figure to 0 instead of failing the request.
 *  - There is no answer cache: the snapshot is the authority, and a memoised
 *    "ready" or "exhausted" is exactly the kind of second source of truth this
 *    file must not keep.
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

/** The jsonb `screening_v2.r1_capacity_snapshot` returns (0119); only the keys read here are named. */
type CapacitySnapshot = Row;

/**
 * The one capacity read. `p_extra_hold` is the change in outstanding holds the
 * caller is asking about: the Send hold (55) for "would a Send be admitted", 0
 * for "where do we stand". The parameter names are pinned against the 0119 SQL
 * by `r1-hr-routes.test.ts`; PostgREST answers PGRST202 for an unknown name.
 *
 * A database error throws (the route's `next(error)`), never an answer. A
 * missing payload comes back `null` and is the caller's to refuse.
 */
async function readCapacitySnapshot(extraHoldMinutes: number): Promise<CapacitySnapshot | null> {
  const { data, error } = await supabase.rpc('r1_capacity_snapshot', {
    p_now: new Date().toISOString(),
    p_extra_hold: extraHoldMinutes,
  });
  if (error) throw error;
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as CapacitySnapshot)
    : null;
}

/**
 * R1 ledger minutes recorded at or after the owner's last dashboard reading,
 * summed across PostgREST pages. Since 0119 this is informational (the pool
 * guard no longer adds it; it grows from a stamped estimate baseline), kept so
 * the usage response keeps its shape. With no reading there is no baseline: 0.
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

/**
 * Whole Sends that fit now, from the snapshot's own headrooms (taken with no
 * extra hold). A Send adds the same hold to both committed figures, so it fits
 * iff the R1 allocation has the hold to spare and, on the Cloud target only,
 * so does the pool: `sends_left >= 1` is the snapshot's `admits` for one Send.
 */
function sendsLeft(snapshot: CapacitySnapshot, hold: number): number {
  const r1Headroom = exact(num(snapshot.r1_headroom));
  const room =
    snapshot.pool_check_applies === true
      ? Math.min(r1Headroom, exact(num(snapshot.pool_headroom)))
      : r1Headroom;
  return Math.max(0, Math.floor(room / hold));
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

      // The capacity RPCs' own verdict for one more Send. Fail closed, as they
      // do: anything but an explicit true refuses.
      const snapshot = await readCapacitySnapshot(hold);
      if (snapshot?.admits !== true) return answer('capacity_exhausted', hold);
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
    const hold = num(settings?.admission_hold_minutes) || DEFAULT_HOLD_MINUTES;
    // Where R1 stands now (no extra hold), the call `v_r1_budget_month` makes.
    const [snapshot, ledgerSinceMinutes] = await Promise.all([
      readCapacitySnapshot(0),
      ledgerMinutesSinceReading(settings),
    ]);
    // Unlike availability, there is nothing honest to show without the figures.
    if (snapshot === null) throw new Error('r1_capacity_snapshot returned no figures');
    const poolCheckApplies = snapshot.pool_check_applies === true;
    res.json({
      month_start: monthStart,
      monthly_cap_minutes: num(settings?.monthly_cap_minutes),
      pause_line_minutes: num(settings?.pause_line_minutes),
      hold_minutes: hold,
      dashboard_minutes: num(settings?.dashboard_minutes),
      dashboard_read_at: settings?.dashboard_read_at ?? null,
      minutes_reserved: num(budget?.minutes_reserved),
      minutes_used: num(budget?.minutes_used),
      starts_admitted: num(budget?.starts_admitted),
      r1_minutes: num(estimate?.r1_minutes),
      phone_minutes: num(estimate?.phone_minutes),
      legacy_browser_minutes: num(estimate?.legacy_browser_minutes),
      estimated_minutes: num(estimate?.estimated_minutes),
      // Informational since 0119 (see `ledgerMinutesSinceReading`).
      ledger_since_minutes: exact(ledgerSinceMinutes),
      // The shared Cloud pool as the snapshot guards it. It gates a Send only
      // while `pool_check_applies` (Mode B); on the r1 target it is informational.
      guard_minutes: exact(num(snapshot.pool_guard)),
      // R1's committed minutes against the R1 allocation (`monthly_cap_minutes`):
      // max(minutes_used, R1 estimate) + outstanding holds. Not the pool.
      committed_minutes: exact(num(snapshot.r1_committed)),
      // Whole Sends that fit now: the R1 allocation's headroom, and on the Cloud
      // target also the pool's (see `sendsLeft`).
      sends_left: sendsLeft(snapshot, hold),
      // Added in 0119 terms. All optional for older clients.
      livekit_target: snapshot.livekit_target === 'cloud' ? 'cloud' : 'r1',
      pool_check_applies: poolCheckApplies,
      r1_headroom_minutes: exact(num(snapshot.r1_headroom)),
      pool_committed_minutes: exact(num(snapshot.pool_committed)),
      pool_headroom_minutes: exact(num(snapshot.pool_headroom)),
      runtime: getR1Config(),
    });
  } catch (error) {
    next(error);
  }
});
