/**
 * lib/funnel/summary.ts — the ONE implementation of the funnel summary read.
 *
 * Extracted from the admin route because the recruiter dashboard needs the same
 * numbers at a lower privilege. Copying the aggregation into a second handler
 * would let the two drift, and "the KPI card and the admin page disagree" is
 * the kind of defect nobody reports and everybody stops trusting the dashboard
 * over. Both routes call this; only the RBAC gate differs.
 *
 * Reads the STORED rollup (`funnel_stage_daily`), never the live views: the
 * rollup is what keeps this a single indexed scan regardless of corpus size.
 * It carries counts, opaque ids and sanitized codes only — no PII by
 * construction — which is what makes the wider exposure safe.
 */

/**
 * Narrow structural seam instead of `SupabaseClient`: this module only ever
 * calls `.from(...).select(...)`, and importing the full generic couples it to
 * whichever schema generic the caller's client happens to carry (they differ
 * across this codebase). A structural type also makes it trivially stubbable.
 */
export interface FunnelReader {
  from(table: string): {
    select(columns: string): {
      gte(column: string, value: string): any;
    };
  };
}

/**
 * Columns summed into `totals` and into each day of `series`.
 *
 * `hr_qualified` / `hr_disqualified` / `hr_awaiting` (0098) are the HR
 * disposition of a bot-screened candidate. `hr_awaiting` exists so a candidate
 * HR has not opened yet is never counted as a rejection — without it the
 * rejection rate rises whenever screening gets FASTER, which is an artefact
 * that reads exactly like an insight.
 */
export const FUNNEL_COUNT_FIELDS = [
  'entered_parse', 'parsed_ok', 'needs_review', 'parse_failed',
  'dialed', 'connected', 'consent_passed', 'consent_dropped', 'answered_ge1',
  'scored', 'qualified', 'on_hold', 'disqualified', 'human_review', 'reached_reference_check',
  'attempts_total', 'connects_total', 'total_call_seconds',
  'hr_qualified', 'hr_disqualified', 'hr_awaiting', 'hr_unknown', 'candidates_total',
] as const;

/** Defence in depth: a hand-crafted from/to cannot pull the whole history. */
export const FUNNEL_MAX_SPAN_DAYS = 400;

/** YYYY-MM-DD `days` before today (UTC). */
export function funnelDayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD `days` before the given YYYY-MM-DD (UTC). */
export function funnelDayBefore(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export interface FunnelSummaryInput {
  from?: string;
  to?: string;
  roleId?: string;
  /**
   * Drop the per-day latency percentiles from `series`.
   *
   * They are NOT aggregated when exactly one rollup row contributes to a day —
   * which a `role_id` filter guarantees, because the grain is unique on
   * (cohort_day, role_id). On a day where that role saw ONE candidate,
   * `median_ttfc_sec` is that individual's time-to-first-connect. Fine for an
   * admin; not something to widen to every interviewer.
   */
  omitTimings?: boolean;
}

export interface FunnelSummary {
  range: { from: string; to: string };
  totals: Record<string, number>;
  conversions: Record<string, number | null>;
  series: Array<Record<string, unknown>>;
  refreshed_at: string | null;
}

/** Fields 0098 adds. Absent until that migration is applied. */
const FUNNEL_FIELDS_0098 = [
  'hr_qualified', 'hr_disqualified', 'hr_awaiting', 'hr_unknown', 'candidates_total',
] as const;

const LEGACY_COUNT_FIELDS = FUNNEL_COUNT_FIELDS.filter(
  (f) => !(FUNNEL_FIELDS_0098 as readonly string[]).includes(f),
);

const SELECT_COLUMNS = `cohort_day, role_id, ${FUNNEL_COUNT_FIELDS.join(', ')}, median_ttfc_sec, p95_ttfc_sec, refreshed_at`;
const SELECT_COLUMNS_LEGACY = `cohort_day, role_id, ${LEGACY_COUNT_FIELDS.join(', ')}, median_ttfc_sec, p95_ttfc_sec, refreshed_at`;

/** PostgREST surfaces an unknown column as 42703. */
function isUndefinedColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42703';
}

/**
 * Load the funnel summary for a window. Throws on a read failure so the caller
 * owns the HTTP shape.
 */
export async function loadFunnelSummary(
  supabase: FunnelReader,
  input: FunnelSummaryInput = {},
): Promise<FunnelSummary> {
  const to = input.to ?? funnelDayOffset(0);
  const requestedFrom = input.from ?? funnelDayOffset(29);
  const minFrom = funnelDayBefore(to, FUNNEL_MAX_SPAN_DAYS);
  const from = requestedFrom < minFrom ? minFrom : requestedFrom;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async (columns: string): Promise<{ data: unknown; error: unknown }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from('funnel_stage_daily')
      .select(columns)
      .gte('cohort_day', from)
      .lte('cohort_day', to)
      .order('cohort_day', { ascending: true });
    if (input.roleId) q = q.eq('role_id', input.roleId);
    return q;
  };

  let { data, error } = await run(SELECT_COLUMNS);
  // SCHEMA SKEW. The API image and the migration ship separately in this
  // project, and migrations are an operator-gated step that has lagged before.
  // Naming 0098's columns unconditionally would make `GET
  // /api/admin/funnel/summary` — a route that worked before this change — 500
  // during that window, with a sanitized message giving no hint why. Fall back
  // to the 0090 column set and report the new fields as zero, which is exactly
  // what they are until the rollup is recomputed.
  if (error && isUndefinedColumn(error)) {
    ({ data, error } = await run(SELECT_COLUMNS_LEGACY));
  }
  if (error) throw new Error('failed to load funnel summary');

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const totals: Record<string, number> = {};
  for (const f of FUNNEL_COUNT_FIELDS) totals[f] = 0;
  let refreshedAt: string | null = null;
  for (const r of rows) {
    for (const f of FUNNEL_COUNT_FIELDS) totals[f] += Number(r[f] ?? 0);
    const ra = r.refreshed_at as string | null | undefined;
    if (ra && (!refreshedAt || ra > refreshedAt)) refreshedAt = ra;
  }

  const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
  const conversions = {
    parse_to_dial: ratio(totals.dialed, totals.parsed_ok),
    dial_to_connect: ratio(totals.connected, totals.dialed),
    connect_to_consent: ratio(totals.consent_passed, totals.connected),
    consent_to_answered: ratio(totals.answered_ge1, totals.consent_passed),
    answered_to_scored: ratio(totals.scored, totals.answered_ge1),
    scored_to_qualified: ratio(totals.qualified, totals.scored),
    qualified_to_reference_check: ratio(totals.reached_reference_check, totals.qualified),
    // Share of the candidates HR has actually DECIDED on that HR advanced.
    // Excludes `hr_awaiting` (not looked at yet) and `hr_unknown` (stage not
    // observable), so neither an untouched backlog nor an unconfigured mapping
    // can move it.
    //
    // NOT named "agreement": nothing here compares HR's decision to the bot's
    // recommendation. A team that advanced every candidate the bot REJECTED —
    // maximal disagreement — would score 100%. `scored_to_qualified` and
    // `qualified_to_reference_check` above are the bot-vs-outcome pair.
    hr_advance_rate: ratio(totals.hr_qualified, totals.hr_qualified + totals.hr_disqualified),
  };

  // Aggregate the per-(day, role) rollup into a per-DAY trend, summing across
  // roles when no role filter is applied so a day is never double-plotted.
  // Percentiles cannot be summed, so they are carried only when exactly one
  // row contributes to that day.
  const byDay = new Map<string, Record<string, unknown> & { __n: number }>();
  for (const r of rows) {
    const day = r.cohort_day as string;
    let agg = byDay.get(day);
    if (!agg) {
      agg = {
        cohort_day: day,
        role_id: null,
        median_ttfc_sec: (r.median_ttfc_sec as number | null) ?? null,
        p95_ttfc_sec: (r.p95_ttfc_sec as number | null) ?? null,
        __n: 0,
      };
      for (const f of FUNNEL_COUNT_FIELDS) agg[f] = 0;
      byDay.set(day, agg);
    }
    for (const f of FUNNEL_COUNT_FIELDS) (agg[f] as number) += Number(r[f] ?? 0);
    agg.__n += 1;
    if (agg.__n > 1) {
      agg.median_ttfc_sec = null;
      agg.p95_ttfc_sec = null;
    }
  }
  const series = [...byDay.values()]
    .sort((a, b) => ((a.cohort_day as string) < (b.cohort_day as string) ? -1 : 1))
    .map(({ __n: _n, ...row }) => {
      if (!input.omitTimings) return row;
      const { median_ttfc_sec: _m, p95_ttfc_sec: _p, ...rest } = row;
      return rest;
    });

  return { range: { from, to }, totals, conversions, series, refreshed_at: refreshedAt };
}
