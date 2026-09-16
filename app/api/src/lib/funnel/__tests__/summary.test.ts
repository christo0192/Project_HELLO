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
function kindOf(rec: Recorded): 'window' | 'freshness' | 'mappings' {
  if (rec.table === 'ashby_job_mappings') return 'mappings';
  return rec.ops.some(([op, col]) => op === 'gte' && col === 'cohort_day')
    ? 'window'
    : 'freshness';
}

/**
 * A chainable, thenable PostgREST stand-in. Deliberately records the calls
 * rather than just returning rows: several of the properties under test are
 * about WHICH query was issued (scoped by role, ordered across the whole table,
 * naming the legacy columns), not about what it returned.
 */
function makeReader(handlers: Partial<Record<'window' | 'freshness' | 'mappings', Handler>>) {
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
function healthy(over: Partial<Record<'window' | 'freshness' | 'mappings', Handler>> = {}) {
  return makeReader({
    window: () => ok([row()]),
    freshness: () => ok([{ refreshed_at: '2026-09-16T06:00:00Z' }]),
    mappings: () => ok([{ external_job_id: 'job-1' }]),
    ...over,
  });
}

describe('loadFunnelSummary — meta.rollup_refreshed_at', () => {
  it('reads freshness from the WHOLE table, not from the rows in range', async () => {
    // THE bug this field exists to kill. A quiet week (or a role with no
    // activity) returns no rows, so `refreshed_at` — the max over the returned
    // slice — is null. The dashboard read that as "never calculated" and
    // announced that a roll-up which ran an hour ago had never run.
    const { reader, calls } = makeReader({
      window: () => ok([]),
      freshness: () => ok([{ refreshed_at: '2026-09-16T06:00:00Z' }]),
      mappings: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);

    expect(out.refreshed_at).toBeNull();                       // empty window
    expect(out.meta.rollup_refreshed_at).toBe('2026-09-16T06:00:00Z'); // ran

    // The probe must not carry the window's date filters, or it would be the
    // same inference wearing a different name. Found by SHAPE, since the reads
    // are concurrent and their order is not part of the contract.
    const probe = calls.filter((c) => c.table === 'funnel_stage_daily')
      .find((c) => !c.ops.some(([op]) => op === 'gte'));
    expect(probe, 'no unfiltered freshness probe was issued').toBeDefined();
    expect(probe!.ops).toContainEqual(['order', 'refreshed_at', { ascending: false }]);
    expect(probe!.ops).toContainEqual(['limit', 1]);
    expect(probe!.columns).toBe('refreshed_at');
  });

  it('reports null only when the rollup table is genuinely empty', async () => {
    const { reader } = makeReader({
      window: () => ok([]),
      freshness: () => ok([]),
      mappings: () => ok([]),
    });
    expect((await loadFunnelSummary(reader)).meta.rollup_refreshed_at).toBeNull();
  });

  it('degrades to unknown rather than failing the whole summary', async () => {
    // The freshness probe is best-effort. An error here must not 500 a request
    // whose actual payload loaded fine.
    const { reader } = healthy({
      window: () => ok([row({ dialed: 4 })]),
      freshness: () => fail('42P01'),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.rollup_refreshed_at).toBeNull();
    expect(out.totals.dialed).toBe(4);
  });
});

describe('loadFunnelSummary — meta.hr_tracking_configured', () => {
  it('is false when no enabled mapping carries a reference-check stage', async () => {
    // How 0090 ships: the column exists but is NULL, so no HR DECISION is
    // reachable. `hr_awaiting` is still non-zero, which is exactly why the UI
    // could not infer this for itself.
    const { reader } = healthy({
      window: () => ok([row({ scored: 9, hr_awaiting: 9 })]),
      mappings: () => ok([]),
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.hr_tracking_configured).toBe(false);
    expect(out.totals.hr_awaiting).toBe(9); // …and the count is still truthful
  });

  it('is true when one does', async () => {
    const { reader } = healthy();
    expect((await loadFunnelSummary(reader)).meta.hr_tracking_configured).toBe(true);
  });

  it('asks only about enabled ashby mappings with a non-null stage', async () => {
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader);
    const probe = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(probe.ops).toContainEqual(['eq', 'provider', 'ashby']);
    expect(probe.ops).toContainEqual(['eq', 'status', 'enabled']);
    expect(probe.ops).toContainEqual(['not', 'reference_check_stage_id', 'is', null]);
    // Bounded: this runs on every dashboard load.
    expect(probe.ops).toContainEqual(['limit', 1]);
  });

  it('scopes the probe to the filtered role', async () => {
    // Without this, an org with ten roles where ONE is wired would report the
    // HR band as configured on all ten — and the other nine would then render
    // a structural zero as a measured "0% advanced".
    const { reader, calls } = healthy();
    await loadFunnelSummary(reader, { roleId: 'role-b' });
    const probe = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(probe.ops).toContainEqual(['eq', 'role_id', 'role-b']);
  });

  it('degrades to "not configured" when the probe fails', async () => {
    // Fails CLOSED: an unreadable mapping table must hide the HR band, never
    // license it to print zeros as fact.
    const { reader } = healthy({ mappings: () => fail('42501') });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.hr_tracking_configured).toBe(false);
  });

  it('survives a probe that throws rather than returning an error', async () => {
    const { reader } = healthy({
      mappings: () => {
        throw new Error('socket hang up');
      },
    });
    const out = await loadFunnelSummary(reader);
    expect(out.meta.hr_tracking_configured).toBe(false);
    expect(out.totals.dialed).toBe(0);
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
      freshness: () => ok([{ refreshed_at: '2026-09-16T06:00:00Z' }]),
      mappings: () => ok([]),
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
      mappings: () => ok([]),
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
    const { reader } = healthy();
    expect((await loadFunnelSummary(reader, { refreshWindowDays: 30 })).meta.refresh_window_days)
      .toBe(30);
    expect((await loadFunnelSummary(reader)).meta.refresh_window_days).toBe(30);
  });
});
