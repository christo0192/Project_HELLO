/**
 * loadFunnelSummary — the single read behind BOTH funnel routes.
 *
 * The three `meta` facts are the reason this file exists. Every attempt to let
 * the dashboard deduce them from the numbers was wrong for the configuration
 * this system actually ships with, so they are now stated by the API — and a
 * stated fact that is stated WRONGLY is worse than an inferred one, because the
 * UI stops second-guessing it. These tests pin each fact to the read that
 * produces it, and pin the degradation path of each, since all three are
 * best-effort and a silent `false` would disable a whole band of the dashboard
 * permanently with no error anywhere.
 */

import { describe, it, expect } from 'vitest';
import { loadFunnelSummary, FUNNEL_MAX_SPAN_DAYS } from '../summary';

/** One recorded PostgREST call. */
interface Recorded {
  table: string;
  columns: string;
  ops: Array<[string, ...unknown[]]>;
}

type Result = { data: unknown; error: unknown };
type Handler = (q: Recorded, nth: number) => Result;

/**
 * Which query a recorded call IS. Dispatching on shape rather than on call
 * order is deliberate: the three reads are issued concurrently, so their
 * arrival order is an implementation detail, and a fake keyed on it would turn
 * a latency improvement into a fleet of unrelated test failures.
 */
function kindOf(rec: Recorded): 'window' | 'freshness' | 'links' | 'mappings' {
  if (rec.table === 'ashby_application_links') return 'links';
  if (rec.table === 'ashby_job_mappings') return 'mappings';
  if (rec.table === 'funnel_rollup_runs') return 'freshness';
  if (rec.table === 'funnel_stage_daily') return 'window';
  // THROW, never default. A silent fallback would serve one query's handler to
  // another and quietly make half the suite assert against the wrong read.
  throw new Error(`unexpected table in funnel summary: ${rec.table}`);
}

/**
 * A chainable, thenable PostgREST stand-in. Deliberately records the calls
 * rather than just returning rows: several of the properties under test are
 * about WHICH query was issued (scoped by role, ordered across the whole table,
 * naming the legacy columns), not about what it returned.
 */
type Kind = 'window' | 'freshness' | 'links' | 'mappings';

function makeReader(handlers: Partial<Record<Kind, Handler>>) {
  const calls: Recorded[] = [];
  const counts: Record<string, number> = {};

  function builder(rec: Recorded): Record<string, unknown> {
    const chain = (name: string) => (...args: unknown[]) => {
      rec.ops.push([name, ...args]);
      return proxy;
    };
    const proxy: Record<string, unknown> = {
      select: (columns: string) => {
        rec.columns = columns;
        return proxy;
      },
      eq: chain('eq'),
      gte: chain('gte'),
      lte: chain('lte'),
      not: chain('not'),
      in: chain('in'),
      order: chain('order'),
      limit: chain('limit'),
      // Thenable: `await q` resolves through here, exactly as PostgREST does.
      then: (
        resolve: (r: Result) => unknown,
        reject: (e: unknown) => unknown,
      ) => {
        // Resolved at AWAIT time, not at `.from()` time — the chain is only
        // fully recorded once the caller has finished building it.
        const kind = kindOf(rec);
        const h = handlers[kind];
        if (!h) return reject(new Error(`no handler for ${kind} (${rec.table})`));
        counts[kind] = (counts[kind] ?? 0) + 1;
        try {
          return resolve(h(rec, counts[kind]));
        } catch (e) {
          return reject(e);
        }
      },
    };
    return proxy;
  }

  return {
    calls,
    reader: {
      from(table: string) {
        const rec: Recorded = { table, columns: '', ops: [] };
        calls.push(rec);
        return builder(rec);
      },
    },
  };
}

/** Same classification the fake dispatches on, for assertions. */
const kindOfCall = kindOf;

const ok = (data: unknown): Result => ({ data, error: null });
const fail = (code: string): Result => ({ data: null, error: { code } });

/** A rollup row with every 0098 field, so a test only states what it varies. */
function row(over: Record<string, unknown> = {}) {
  return {
    cohort_day: '2026-09-10',
    role_id: 'role-a',
    entered_parse: 0, parsed_ok: 0, needs_review: 0, parse_failed: 0,
    dialed: 0, connected: 0, consent_passed: 0, consent_dropped: 0, answered_ge1: 0,
    scored: 0, qualified: 0, on_hold: 0, disqualified: 0, human_review: 0,
    reached_reference_check: 0, attempts_total: 0, connects_total: 0,
    total_call_seconds: 0,
    hr_qualified: 0, hr_disqualified: 0, hr_awaiting: 0, hr_unknown: 0,
    candidates_total: 0,
    median_ttfc_sec: null, p95_ttfc_sec: null,
    refreshed_at: '2026-09-16T06:00:00Z',
    ...over,
  };
}

/** Default handlers: healthy tenant, HR tracking wired, roll-up has run. */
function healthy(over: Partial<Record<Kind, Handler>> = {}) {
  return makeReader({
    window: () => ok([row()]),
    freshness: () => ok([{ ran_at: '2026-09-16T06:00:00Z' }]),
    mappings: () => ok([{ id: 'map-1' }]),
    links: () => ok([{ id: 'link-1' }]),
    ...over,
  });
}

describe('loadFunnelSummary — meta.rollup_refreshed_at', () => {
  it('reads the roll-up HEARTBEAT, not the data rows', async () => {
    // THE bug this field exists to kill, and the reason it moved off
    // `max(refreshed_at)`. The refresh is delete-then-insert over a trailing
    // window: a window with no rows writes nothing, and older rows are never
    // re-stamped. So the data can be months stale while the loop runs every 15
    // minutes — and reading freshness off the data reported the stale date.
    const { reader, calls } = makeReader({
      window: () => ok([]),
      freshness: () => ok([{ ran_at: '2026-09-16T06:00:00Z' }]),
      links: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);

    expect(out.refreshed_at).toBeNull();                       // empty window
    expect(out.meta.rollup_refreshed_at).toBe('2026-09-16T06:00:00Z');
    expect(out.meta.rollup_freshness_known).toBe(true);

    const probe = calls.find((c) => c.table === 'funnel_rollup_runs');
    expect(probe, 'freshness must come from the heartbeat table').toBeDefined();
    expect(probe!.ops).toContainEqual(['eq', 'id', 1]);
    // It must NOT be a scan of the data, or it is the same inference renamed.
    expect(probe!.ops.map(([op]) => op)).not.toContain('gte');
  });

  it('reports "never run" only when the heartbeat row is absent', async () => {
    const { reader } = makeReader({
      window: () => ok([]),
      freshness: () => ok([]),
      links: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.rollup_refreshed_at).toBeNull();
    expect(out.meta.rollup_freshness_known).toBe(true); // we asked, and we know
  });

  it('says freshness is UNKNOWN — not "never run" — when the probe errors', async () => {
    // A failed probe once became `null`, which the dashboard rendered as
    // "these figures have not been calculated yet — everything below will read
    // zero", printed directly above non-zero figures that had loaded fine.
    const { reader } = healthy({
      window: () => ok([row({ dialed: 4 })]),
      freshness: () => fail('42P01'),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.rollup_freshness_known).toBe(false);
    expect(out.meta.rollup_refreshed_at).toBeNull();
    expect(out.totals.dialed).toBe(4); // …and the payload still loaded
  });

  it('says UNKNOWN when the freshness probe THROWS', async () => {
    // Distinct from an error result: a throw is a programming error (wrong
    // column, client API change) and used to reject `Promise.all`, 500ing a
    // request whose payload was fine.
    const { reader } = healthy({
      window: () => ok([row({ dialed: 4 })]),
      freshness: () => { throw new Error('socket hang up'); },
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.rollup_freshness_known).toBe(false);
    expect(out.totals.dialed).toBe(4);
  });
});

describe('loadFunnelSummary — meta.hr_tracking_configured', () => {
  it('is false when no mapping names both stages', async () => {
    // Nothing to observe: an HR decision is not expressible at all, so the
    // link query must not even be issued.
    const { reader, calls } = healthy({
      window: () => ok([row({ scored: 9, hr_awaiting: 9 })]),
      mappings: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.hr_tracking_configured).toBe(false);
    expect(calls.find((c) => c.table === 'ashby_application_links')).toBeUndefined();
  });

  it('is false when no link has had its stage observed since import', async () => {
    // Today's production shape, and the reason the probe reads LINKS rather
    // than mapping ids: `external_stage_id` is written once at import and is
    // always the AI screening stage, so "a stage id is filled in" says nothing
    // about whether any candidate's real stage is knowable. `hr_awaiting` is
    // still non-zero here, which is exactly why the UI could not infer it.
    const { reader } = healthy({
      window: () => ok([row({ scored: 9, hr_awaiting: 9 })]),
      links: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.hr_tracking_configured).toBe(false);
    expect(out.totals.hr_awaiting).toBe(9); // …and the count is still truthful
  });

  it('is true once a synced link exists on a fully-mapped job', async () => {
    const { reader } = healthy();
    expect((await loadFunnelSummary(reader)).meta.hr_tracking_configured).toBe(true);
  });

  it('requires a SYNCED stage, on a mapping that names both stages', async () => {
    // Each clause is load-bearing. Drop `stage_synced_at` and the probe answers
    // "an id is filled in", which is true of every tenant that follows the
    // activation runbook and true of ZERO observed stages — the exact state in
    // which the band would render "Advanced 0 / Not advanced 0" as measurement.
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader);

    const maps = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(maps.ops).toContainEqual(['not', 'ai_screening_stage_id', 'is', null]);
    expect(maps.ops).toContainEqual(['not', 'reference_check_stage_id', 'is', null]);

    const probe = calls.find((c) => c.table === 'ashby_application_links')!;
    expect(probe.ops).toContainEqual(['not', 'stage_synced_at', 'is', null]);
    expect(probe.ops).toContainEqual(['not', 'external_stage_id', 'is', null]);
    // Restricted to the mappings the first query returned, not the whole table.
    expect(probe.ops).toContainEqual(['in', 'job_mapping_id', ['map-1']]);
    // Bounded: this runs on every dashboard load.
    expect(probe.ops).toContainEqual(['limit', 1]);
  });

  it('filters only on columns each table actually owns', async () => {
    // The single-query form embeds the mapping and filters it with dotted
    // paths — an idiom used nowhere else here, whose failure mode is an error
    // the catch turns into a permanent, silent "not configured".
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader, { roleId: 'role-b' });
    for (const c of calls) {
      for (const [op, col] of c.ops) {
        if (typeof col === 'string' && op !== 'order') {
          expect(col, `${c.table}.${op} filters an embedded column`).not.toContain('.');
        }
      }
      expect(c.columns).not.toContain('!inner');
    }
  });

  it('scopes the probe to the filtered role', async () => {
    // Several mappings legitimately share one role (the unique key is
    // provider+external_job_id). Without scoping, one wired job made the band
    // "configured" for candidates who all arrived through an unwired one — and
    // org-wide, one wired role out of ten armed the whole dashboard.
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader, { roleId: 'role-b' });
    const maps = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(maps.ops).toContainEqual(['eq', 'role_id', 'role-b']);
  });

  it('does not scope by role when no role filter was asked for', async () => {
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader);
    const maps = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(maps.ops.map(([op, col]) => `${op}:${col}`)).not.toContain('eq:role_id');
  });

  it('degrades to "not configured" when EITHER query fails', async () => {
    // Fails CLOSED: an unreadable table must hide the HR band, never license
    // it to print zeros as fact. Both legs, because an early return on the
    // first would otherwise go untested.
    const a = healthy({ mappings: () => fail('42501') });
    expect((await loadFunnelSummary(a.reader)).meta.hr_tracking_configured).toBe(false);

    const b = healthy({ links: () => fail('42501') });
    expect((await loadFunnelSummary(b.reader)).meta.hr_tracking_configured).toBe(false);
  });

  it('survives a probe that throws rather than returning an error', async () => {
    const { reader } = healthy({
      window: () => ok([row({ dialed: 4 })]),
      links: () => {
        throw new Error('socket hang up');
      },
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.hr_tracking_configured).toBe(false);
    // 4, not 0: `totals` is pre-seeded to zero for every field, so asserting 0
    // here passed whether or not the summary had loaded at all.
    expect(out.totals.dialed).toBe(4);
  });
});

describe('loadFunnelSummary — meta.schema_current', () => {
  it('falls back to the 0090 columns and SAYS the schema is behind', async () => {
    // The API image and the migration deploy separately. Without the fallback
    // this route 500s; without the flag the zero-filled columns are
    // indistinguishable from a genuinely empty pipeline, and the dashboard
    // would draw "Total candidates 0" above "Candidates dialled 80".
    const { reader, calls } = makeReader({
      // nth counts WINDOW reads only: 1st names 0098's columns and 42703s,
      // 2nd is the fallback.
      window: (_q, nth) => (nth === 1 ? fail('42703') : ok([row({ dialed: 80, connected: 20 })])),
      freshness: () => ok([{ ran_at: '2026-09-16T06:00:00Z' }]),
      links: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);

    expect(out.meta.schema_current).toBe(false);
    expect(out.totals.dialed).toBe(80);
    // The retry must actually drop the unknown columns, or it fails identically.
    const windows = calls.filter((c) => kindOfCall(c) === 'window');
    expect(windows).toHaveLength(2);
    expect(windows[0].columns).toContain('candidates_total');
    expect(windows[1].columns).not.toContain('candidates_total');
    expect(windows[1].columns).not.toContain('hr_unknown');
    expect(windows[1].columns).toContain('dialed');
    // Absent fields are still present as zero so the caller never reads
    // `undefined.toLocaleString()`.
    expect(out.totals.candidates_total).toBe(0);
    expect(out.totals.hr_unknown).toBe(0);
  });

  it('is true on a current schema', async () => {
    const { reader } = healthy();
    expect((await loadFunnelSummary(reader)).meta.schema_current).toBe(true);
  });

  it('does not retry — or claim a stale schema — on an unrelated error', async () => {
    // Only 42703 means "column does not exist". Treating every failure as
    // schema skew would turn a permissions or connectivity fault into a
    // permanently degraded dashboard that never says anything is wrong.
    const { reader, calls } = makeReader({
      window: () => fail('42501'),
      freshness: () => ok([]),
      links: () => ok([]),
    });
    await expect(loadFunnelSummary(reader)).rejects.toThrow(/failed to load funnel summary/);
    expect(calls.filter((c) => kindOfCall(c) === 'window')).toHaveLength(1);
  });
});

describe('loadFunnelSummary — figures', () => {
  it('rates the HR decision over DECIDED candidates only', async () => {
    // 2 advanced, 1 not, 7 untouched, 5 untrackable → 2/3, not 2/15.
    const { reader } = healthy({
      window: () =>
        ok([row({ scored: 15, hr_qualified: 2, hr_disqualified: 1, hr_awaiting: 7, hr_unknown: 5 })]),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.conversions.hr_advance_rate).toBeCloseTo(2 / 3, 10);
  });

  it('reports a rate with no denominator as null, never as zero', async () => {
    const { reader } = healthy();
    const out = await loadFunnelSummary(reader);
    expect(out.conversions.hr_advance_rate).toBeNull();
    expect(out.conversions.dial_to_connect).toBeNull();
  });

  it('clamps a hand-crafted range to the maximum span', async () => {
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader, { from: '2000-01-01', to: '2026-09-16' });
    const window = calls.find((c) => kindOfCall(c) === 'window')!;
    const gte = window.ops.find(([op]) => op === 'gte')!;
    expect(gte[2]).not.toBe('2000-01-01');

    const span =
      (Date.parse('2026-09-16T00:00:00Z') - Date.parse(`${gte[2] as string}T00:00:00Z`)) /
      86_400_000;
    expect(span).toBe(FUNNEL_MAX_SPAN_DAYS);
  });

  it('sums across roles per day and drops percentiles it cannot aggregate', async () => {
    // Percentiles are not summable. Carrying one role's median onto a day two
    // roles contributed to would attribute one team's latency to both.
    const { reader } = healthy({
      window: () =>
        ok([
          row({ cohort_day: '2026-09-10', role_id: 'a', dialed: 3, median_ttfc_sec: 11 }),
          row({ cohort_day: '2026-09-10', role_id: 'b', dialed: 4, median_ttfc_sec: 99 }),
          row({ cohort_day: '2026-09-11', role_id: 'a', dialed: 5, median_ttfc_sec: 7 }),
        ]),
    });
    const out = await loadFunnelSummary(reader);

    expect(out.series).toHaveLength(2);
    expect(out.series[0]).toMatchObject({ cohort_day: '2026-09-10', dialed: 7, median_ttfc_sec: null });
    expect(out.series[1]).toMatchObject({ cohort_day: '2026-09-11', dialed: 5, median_ttfc_sec: 7 });
    expect(out.totals.dialed).toBe(12);
  });

  it('omits per-day timings for the wider audience without dropping counts', async () => {
    // Under a role filter the grain is unique per day, so a day with one
    // candidate exposes that individual's time-to-first-connect.
    const { reader } = healthy({
      window: () => ok([row({ dialed: 1, median_ttfc_sec: 42, p95_ttfc_sec: 42 })]),
    });
    const out = await loadFunnelSummary(reader, { omitTimings: true, roleId: 'role-a' });

    expect(out.series[0]).not.toHaveProperty('median_ttfc_sec');
    expect(out.series[0]).not.toHaveProperty('p95_ttfc_sec');
    expect(out.series[0]).toMatchObject({ dialed: 1 });
  });

  it('passes the refresh window through so the UI can warn about frozen days', async () => {
    // 90, NOT 30. Asserting the default against the default passed with the
    // field hardcoded — and the window is operator-configurable 1..3650, so an
    // org running 90 got a staleness warning computed against the wrong
    // boundary and no test anywhere noticed.
    const { reader } = healthy();
    expect((await loadFunnelSummary(reader, { refreshWindowDays: 90 })).meta.refresh_window_days)
      .toBe(90);
    expect((await loadFunnelSummary(reader)).meta.refresh_window_days).toBe(30);
  });

  it('scopes the WINDOW read to the filtered role', async () => {
    // Nothing pinned this. Dropping the filter returns ORG-WIDE totals to an
    // interviewer who asked about one role — and simultaneously falsifies the
    // premise behind `omitTimings`, that a role filter yields one row per day.
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader, { roleId: 'role-b' });
    const window = calls.find((c) => kindOfCall(c) === 'window')!;
    expect(window.ops).toContainEqual(['eq', 'role_id', 'role-b']);
  });

  it('asks for exactly the requested window on a normal request', async () => {
    // The clamp test alone passed with `const from = minFrom`, i.e. with every
    // dashboard load silently scanning 400 days under a 30-day label.
    const { reader, calls } = healthy();
    const out = await loadFunnelSummary(reader, { from: '2026-09-10', to: '2026-09-16' });
    const window = calls.find((c) => kindOfCall(c) === 'window')!;
    expect(window.ops).toContainEqual(['gte', 'cohort_day', '2026-09-10']);
    expect(window.ops).toContainEqual(['lte', 'cohort_day', '2026-09-16']);
    expect(out.range).toEqual({ from: '2026-09-10', to: '2026-09-16' });
  });

  it('keeps the NEWEST in-window timestamp, not the oldest', async () => {
    const { reader } = healthy({
      window: () => ok([
        row({ cohort_day: '2026-09-10', refreshed_at: '2026-09-15T01:00:00Z' }),
        row({ cohort_day: '2026-09-11', refreshed_at: '2026-09-16T06:00:00Z' }),
      ]),
    });
    expect((await loadFunnelSummary(reader)).refreshed_at).toBe('2026-09-16T06:00:00Z');
  });

  it('sorts the series by day even when the rows arrive out of order', async () => {
    // Every other fixture supplies ascending rows, so the sort was dead code
    // under test while a chart could plot 16 Sep before 10 Sep.
    const { reader } = healthy({
      window: () => ok([
        row({ cohort_day: '2026-09-16', dialed: 2 }),
        row({ cohort_day: '2026-09-10', dialed: 1 }),
      ]),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.series.map((r) => r.cohort_day)).toEqual(['2026-09-10', '2026-09-16']);
  });

  it('coerces bigint columns that PostgREST returns as strings', async () => {
    // `total_call_seconds` is a bigint, and PostgREST sends those as strings.
    // Without `Number()` the totals CONCATENATE — "0600120" — and render as a
    // plausible six-figure duration.
    const { reader } = healthy({
      window: () => ok([
        row({ total_call_seconds: '600' as unknown as number }),
        row({ cohort_day: '2026-09-11', total_call_seconds: '120' as unknown as number }),
      ]),
    });
    expect((await loadFunnelSummary(reader)).totals.total_call_seconds).toBe(720);
  });

  it('withholds per-individual counters on a single-candidate day', async () => {
    // An interviewer may request one role and one day, so a day resolving to a
    // single candidate is a URL rather than an accident — and then
    // `total_call_seconds` IS that person's call duration and `attempts_total`
    // is how many times we rang them. Stripping only the percentiles was a
    // privacy control in name only.
    const { reader } = healthy({
      window: () => ok([row({
        candidates_total: 1, total_call_seconds: 412, attempts_total: 3, connects_total: 1,
      })]),
    });
    const out = await loadFunnelSummary(reader, { omitTimings: true, roleId: 'role-a' });
    expect(out.series[0]).not.toHaveProperty('total_call_seconds');
    expect(out.series[0]).not.toHaveProperty('attempts_total');
    expect(out.series[0]).not.toHaveProperty('connects_total');
    expect(out.series[0]).toMatchObject({ candidates_total: 1 });
    // The window TOTAL still reports it — it is the per-DAY row that resolves
    // to one person, and suppressing the total would gut the panel.
    expect(out.totals.total_call_seconds).toBe(412);
  });

  it('keeps those counters on a day with more than one candidate', async () => {
    const { reader } = healthy({
      window: () => ok([row({ candidates_total: 4, total_call_seconds: 900 })]),
    });
    const out = await loadFunnelSummary(reader, { omitTimings: true, roleId: 'role-a' });
    expect(out.series[0]).toMatchObject({ total_call_seconds: 900 });
  });

  it('nulls role_id on every series row', async () => {
    // The claim the route's docstring makes about the payload being
    // role-anonymous once aggregated. Untested until now.
    const { reader } = healthy({ window: () => ok([row({ role_id: 'role-a' })]) });
    const out = await loadFunnelSummary(reader, { omitTimings: true });
    expect(out.series[0]).toMatchObject({ role_id: null });
  });
});
