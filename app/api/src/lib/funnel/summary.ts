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

import { createLogger } from '../logger.js';

// The event-name union is closed and unknown names rewrite to 'unknown_event',
// so the distinguishing detail travels in `error_category` — the same shape
// lib/funnel/runtime.ts already uses for this subsystem.
const logger = createLogger('funnel-summary');

/**
 * Narrow structural seam instead of `SupabaseClient`: this module only ever
 * calls `.from(...).select(...)`, and importing the full generic couples it to
 * whichever schema generic the caller's client happens to carry (they differ
 * across this codebase). A structural type also makes it trivially stubbable.
 */
export interface FunnelReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
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
  /** Reported as `meta.refresh_window_days`; purely informational. */
  refreshWindowDays?: number;
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

/**
 * Facts the UI must NOT infer.
 *
 * Every guard in the dashboard that tried to deduce these from the numbers got
 * it wrong for the configuration this system actually ships with — an empty
 * date range looked identical to "never computed", and a mapping with a NULL
 * `reference_check_stage_id` produced `hr_awaiting > 0`, which defeated the
 * "unconfigured" check and rendered a structurally-unreachable "0 advanced /
 * 0 not advanced" as measured fact. These are stated, not guessed.
 */
export interface FunnelMeta {
  /**
   * True only when at least one Ashby application link in scope has had its
   * stage OBSERVED since import (`stage_synced_at`) on a mapping that names
   * both stages. False means HR disposition is not knowable at all, so the HR
   * cards must say "not tracked" rather than render zeros.
   *
   * Deliberately NOT "someone filled in a stage id". `external_stage_id` is
   * written once at import and is always the AI screening stage; nothing
   * updates it. Keying this on the id alone meant that performing the
   * documented activation step flipped the band on and rendered
   * "Advanced 0 / Not advanced 0" — structurally unreachable numbers — as
   * measurement, with the UI's own second-guessing switched off. See 0098 §0.
   */
  hr_tracking_configured: boolean;
  /**
   * False when 0098's columns are missing — i.e. the API shipped ahead of the
   * migration. The HR and candidate-total figures are then absent, NOT zero,
   * and the UI must suppress them instead of printing a fabricated 0.
   */
  schema_current: boolean;
  /**
   * When the ROLL-UP last ran, read from its heartbeat — not from the rows in
   * this window. A quiet week returns no rows, and inferring freshness from
   * that announced "never calculated" about a roll-up that ran an hour ago.
   *
   * Meaningful ONLY when `rollup_freshness_known` is true.
   */
  rollup_refreshed_at: string | null;
  /**
   * False when the freshness probe itself failed. Without this, a transient
   * error on a SEPARATE round-trip made a null indistinguishable from "never
   * run", and the panel announced "these figures have not been calculated yet —
   * everything below will read zero" directly above non-zero figures that had
   * loaded perfectly well. `null` must mean "never run"; "we could not find
   * out" needs its own answer.
   */
  rollup_freshness_known: boolean;
  /**
   * The trailing window each recompute reaches back over. Days older than this
   * are frozen at their last recompute: HR disposition changes weeks after
   * intake, so a longer range shows stale HR counts for its older portion.
   */
  refresh_window_days: number;
}

export interface FunnelSummary {
  range: { from: string; to: string };
  totals: Record<string, number>;
  conversions: Record<string, number | null>;
  series: Array<Record<string, unknown>>;
  refreshed_at: string | null;
  meta: FunnelMeta;
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

  // ── The two facts the UI must not infer, started BEFORE the main read ──
  // Both are independent of the window query and of each other, so they fly
  // alongside it rather than adding two serial round-trips to every dashboard
  // load. Each is bounded, and each degrades to the CONSERVATIVE answer — not
  // configured / freshness unknown — never to a confident one, because a
  // wrongly-confident `true` here would license the UI to print structural
  // zeros as measurement.
  const hrTrackingConfiguredP: Promise<boolean> = (async () => {
    try {
      // Asks the question the dashboard actually needs answered: "is there any
      // candidate whose Ashby stage we have genuinely OBSERVED?" — not "has
      // someone filled in a stage id".
      //
      // Three ways the id-only version got this wrong, all reachable today:
      //  * `ashby_job_mappings` is unique on (provider, external_job_id), so
      //    several mappings share one role. One wired mapping made the band
      //    "configured" for candidates who all arrived through an UNWIRED one,
      //    whose states can only be `unknown` — printing 0/0 as measurement.
      //  * Unscoped (the default org-wide view), one wired role out of ten
      //    armed the band for the whole dashboard.
      //  * It filtered `status = 'enabled'` while the view joins mappings
      //    regardless of status, so pausing a mapping made a populated HR band
      //    vanish behind "Not tracked yet" — an untrue explanation.
      //
      // Reading the LINKS makes the probe and the view agree by construction:
      // both require a synced link whose mapping names both stages.
      //
      // TWO PLAIN QUERIES, not one clever one. The obvious single-query form
      // embeds the mapping (`ashby_job_mappings!inner(...)`) and filters on it
      // with dotted paths (`.eq('ashby_job_mappings.role_id', …)`). That is
      // valid PostgREST, but it is an idiom used nowhere else in this codebase,
      // and its failure mode here is the precise one this whole change exists
      // to remove: a malformed embed ERRORS, the catch below turns it into a
      // conservative `false`, and the HR band is "not configured" forever with
      // nothing but a warn line to show for it. Two queries built from filters
      // this codebase already proves in production is the cheaper bet.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mq: any = supabase
        .from('ashby_job_mappings')
        .select('id')
        .not('ai_screening_stage_id', 'is', null)
        .not('reference_check_stage_id', 'is', null)
        // Bounded. Only a false NEGATIVE is possible past this limit, and only
        // if every synced link in the org lives on a fully-wired mapping beyond
        // the first 200 — at which point the band under-reports rather than
        // over-claims, which is the direction this code always errs in.
        .limit(200);
      // Scoped to the filtered role: several mappings legitimately share one
      // role, so one wired job must not arm the band for candidates who all
      // arrived through an unwired one.
      if (input.roleId) mq = mq.eq('role_id', input.roleId);
      const { data: mapRows, error: mapErr } = await mq;
      if (mapErr) {
        // Distinguishable from "nothing observed": a broken probe must be
        // visible, not silently indistinguishable from an unconfigured tenant.
        logger.warn('unknown_event', { error_category: 'funnel_hr_probe_error' });
        return false;
      }
      const mappingIds = (Array.isArray(mapRows) ? mapRows : [])
        .map((m) => (m as { id?: string }).id)
        .filter((id): id is string => typeof id === 'string');
      // No mapping names both stages ⇒ no HR decision is expressible at all.
      // Skip the second round-trip rather than send `in.()`, which PostgREST
      // rejects as malformed rather than treating as an empty set.
      if (mappingIds.length === 0) return false;

      const { data: linkRows, error: linkErr } = await supabase
        .from('ashby_application_links')
        .select('id')
        .in('job_mapping_id', mappingIds)
        .not('stage_synced_at', 'is', null)
        .not('external_stage_id', 'is', null)
        .limit(1);
      if (linkErr) {
        logger.warn('unknown_event', { error_category: 'funnel_hr_probe_error' });
        return false;
      }
      return Array.isArray(linkRows) && linkRows.length > 0;
    } catch {
      // A THROW here is a programming error (wrong column, client API change),
      // not a configuration state. Without this log it disappears into a
      // conservative `false` and permanently hides a band with no signal.
      logger.warn('unknown_event', { error_category: 'funnel_hr_probe_throw' });
      return false;
    }
  })();

  const rollupRefreshedAtP: Promise<string | null | undefined> = (async () => {
    try {
      // The roll-up's own HEARTBEAT (0098), not its data. Reading
      // `max(refreshed_at)` over `funnel_stage_daily` answers "when was a row
      // last written", which is a different question: the refresh is
      // delete-then-insert over a trailing window, so a window that produces no
      // rows writes nothing, and older rows are never re-stamped. A tenant with
      // a month of no intake had a loop running every 15 minutes and a
      // dashboard reporting a date from last quarter.
      const { data: freshRows, error: freshErr } = await supabase
        .from('funnel_rollup_runs')
        .select('ran_at')
        .eq('id', 1)
        .limit(1);
      if (freshErr) {
        // 42P01 here means the heartbeat table is missing, i.e. 0098 is not
        // applied — which `schema_current` already reports. Either way this is
        // "we could not find out", never "it has never run".
        logger.warn('unknown_event', { error_category: 'funnel_freshness_error' });
        return undefined;
      }
      if (Array.isArray(freshRows) && freshRows.length > 0) {
        return (freshRows[0] as { ran_at?: string }).ran_at ?? null;
      }
      // Table present, no row: the roll-up genuinely has never completed a pass.
      return null;
    } catch {
      logger.warn('unknown_event', { error_category: 'funnel_freshness_throw' });
      return undefined;
    }
  })();

  let schemaCurrent = true;
  let { data, error } = await run(SELECT_COLUMNS);
  // SCHEMA SKEW. The API image and the migration ship separately in this
  // project, and migrations are an operator-gated step that has lagged before.
  // Naming 0098's columns unconditionally would make `GET
  // /api/admin/funnel/summary` — a route that worked before this change — 500
  // during that window, with a sanitized message giving no hint why. Fall back
  // to the 0090 column set and report the new fields as zero, which is exactly
  // what they are until the rollup is recomputed.
  if (error && isUndefinedColumn(error)) {
    schemaCurrent = false;
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

  const [hrTrackingConfigured, rollupRefreshedAt] = await Promise.all([
    hrTrackingConfiguredP,
    rollupRefreshedAtP,
  ]);

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
      // The percentiles were never the only per-INDIVIDUAL quantity here. On a
      // day whose `candidates_total` is 1, `total_call_seconds` IS that
      // person's call duration and `attempts_total` is how many times we rang
      // them — and an interviewer can ask for any single role and any single
      // day, so producing such a day is a URL, not an accident. Stripping the
      // percentiles while leaving these was a privacy control in name only.
      if (Number(rest.candidates_total ?? 0) === 1) {
        const { total_call_seconds: _s, attempts_total: _a, connects_total: _c, ...coarse } = rest;
        return coarse;
      }
      return rest;
    });

  return {
    range: { from, to },
    totals,
    conversions,
    series,
    refreshed_at: refreshedAt,
    meta: {
      hr_tracking_configured: hrTrackingConfigured,
      schema_current: schemaCurrent,
      rollup_refreshed_at: rollupRefreshedAt ?? null,
      rollup_freshness_known: rollupRefreshedAt !== undefined,
      refresh_window_days: input.refreshWindowDays ?? 30,
    },
  };
}
