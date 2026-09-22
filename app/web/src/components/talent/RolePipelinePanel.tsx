/**
 * RolePipelinePanel — one stacked bar per role: where that role's candidates
 * actually are, from "not dialled yet" through to a scored screen.
 *
 * WHY THE SEGMENTS ARE NOT THE FUNNEL FIELDS. The funnel totals are NESTED
 * cohorts — every connected candidate was dialled, every scored candidate
 * connected. Stacking `dialed`, `connected` and `scored` side by side would
 * count the same person three times and draw a bar wider than the role's
 * cohort. So each stage is differenced into the bucket a candidate is
 * actually sitting in:
 *
 *     Not dialled        = candidates_total - dialed
 *     Dialled, no answer = dialed    - connected
 *     Connected          = connected - scored
 *     Screened           = scored
 *
 * Those partition the cohort, which is the only thing a stack may claim. The
 * stage TOTALS a recruiter asked to see are still legible: dialled is
 * everything but the first segment, connected is the last two.
 *
 * THE SELECTED SEGMENT CANNOT BE MEASURED. `reached_reference_check` is
 * derived from `ashby_application_links.external_stage_id`, which is written
 * once at import and never updated, and it additionally requires the
 * mapping's `reference_check_stage_id` — unset in production. So the number
 * is not "nobody was selected", it is "no signal exists yet". It is rendered
 * as an explicit caveat rather than a zero, because a zero here would read as
 * an outcome and quietly misinform every decision made from this panel.
 *
 * One request per role, in parallel: `/api/funnel/summary` aggregates a
 * single `role_id`, so there is no one-shot per-role breakdown to call
 * instead. Roles with no candidates in the window are dropped rather than
 * drawn as empty tracks.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import type { FunnelSummaryTotals, Role } from '../../types';
import { GlassPanel, InlineNotice } from '../design';
import { PipelineBar } from './PipelineBar';
import type { PipelineSegment } from './PipelineBar';

export interface RolePipelinePanelProps {
  roles: readonly Role[];
  /** When set, only this role is charted (mirrors the page's role filter). */
  roleId?: string | null;
}

interface RoleTotals {
  role: Role;
  totals: FunnelSummaryTotals;
}

/**
 * Cumulatively clamp the nested stages so each is inside the one before it.
 *
 * THIS IS THE LOAD-BEARING STEP, and the first cut got it wrong. Differencing
 * each pair independently with `max(0, outer - inner)` looks equivalent but is
 * not: every clamp that fires converts an inversion into an OVER-count. With
 * `total 5, dialed 2, connected 4, scored 0` it produced buckets of
 * 3 + 0 + 4 + 0 = SEVEN people in a five-person role, four of them labelled
 * "Connected" in a role where only two were ever dialled.
 *
 * Inversions are reachable — the funnel rollup and the candidate list are read
 * at different instants — so this is a live case, not a theoretical one.
 * Clamping down the chain first (`d ≤ total`, `c ≤ d`, `s ≤ c`) makes the four
 * buckets telescope to exactly `total` for every possible input.
 */
function clampChain(totals: FunnelSummaryTotals) {
  // `count` first: `Math.max(0, NaN)` is NaN and `Math.min(NaN, x)` is NaN, so
  // ONE non-numeric field from a partial payload poisoned the whole chain —
  // the role still passed the "has candidates" filter, then rendered no bar at
  // all and four legend figures reading "NaN".
  const total = count(totals.candidates_total);
  const dialed = Math.min(count(totals.dialed), total);
  const connected = Math.min(count(totals.connected), dialed);
  const scored = Math.min(count(totals.scored), connected);
  return { total, dialed, connected, scored };
}

/** A non-negative finite count, whatever the payload actually carried. */
function count(value: number | undefined | null): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The cumulative stage totals a recruiter actually asked for — dialled,
 * connected, screened — as figures rather than as stack segments.
 *
 * Nested totals are perfectly honest as LABELLED FIGURES; they are only
 * dishonest when stacked. The bar shows where people stopped, this line shows
 * how far they got, and between them nobody has to do arithmetic.
 */
export function stageTotals(totals: FunnelSummaryTotals) {
  return clampChain(totals);
}

/** At most this many funnel reads in flight at once. */
const MAX_PARALLEL_FUNNEL_READS = 6;

/**
 * Map with bounded concurrency, preserving input order in the result.
 *
 * NEVER REJECTS, and the try/catch is what guarantees it — `work` absorbing
 * its own rejections is not enough, because a synchronous throw escapes
 * before its `.catch` exists. The pool always settles so the caller can
 * report how many items it could not read.
 */
async function runPooled<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await work(items[i]);
      } catch {
        // `work` absorbs its own REJECTIONS, but a synchronous throw (an
        // undefined client method, an arg validator) happens before its
        // `.catch` is attached. Unguarded it rejected this worker, then
        // `Promise.all`, then the pool — and the panel, already switched to
        // `rows = null`, rendered nothing for ever with an unhandled rejection
        // in the console.
        out[i] = null as R;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function segmentsFor(totals: FunnelSummaryTotals): PipelineSegment[] {
  const { total, dialed, connected, scored } = clampChain(totals);
  return [
    // Labels say where a candidate STOPPED. They deliberately share no word
    // with the cumulative stage line underneath: "Connected 2" (this bucket)
    // sitting 20px above "Connected 6" (reached this stage) gave a recruiter
    // two defensible answers to one question from a single 40px block.
    { key: 'not_dialed', label: 'Awaiting first dial', value: total - dialed, tone: 'neutral' },
    { key: 'no_answer', label: 'Dialled, never answered', value: dialed - connected, tone: 'caution' },
    { key: 'connected', label: 'Answered, not screened', value: connected - scored, tone: 'accent' },
    { key: 'scored', label: 'Screening complete', value: scored, tone: 'positive' },
    {
      key: 'selected',
      label: 'Selected',
      value: 0,
      tone: 'positive',
      // NOT a zero. See the file header.
      unavailable: 'Not tracked yet',
    },
  ];
}

/**
 * The cumulative stage figures, under the bar.
 *
 * The stack shows where each candidate STOPPED, which is the only thing a
 * stack may claim. It cannot also show how far people GOT without
 * double-counting, so those totals are printed as figures instead — otherwise
 * answering "how many did we dial?" means adding three segments together.
 */
function StageTotals({ totals }: { totals: FunnelSummaryTotals }) {
  const { total, dialed, connected, scored } = stageTotals(totals);
  return (
    <span className="tabular-nums">
      Reached: dialled{' '}
      <strong className="font-semibold text-[var(--c-ink)]">{dialed}</strong>
      {' · '}connected <strong className="font-semibold text-[var(--c-ink)]">{connected}</strong>
      {' · '}screened <strong className="font-semibold text-[var(--c-ink)]">{scored}</strong>
      {' · '}of {total}
    </span>
  );
}

export function RolePipelinePanel({ roles, roleId }: RolePipelinePanelProps) {
  const [rows, setRows] = useState<RoleTotals[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * How many roles could not be read this pass.
   *
   * Without this a partial outage renders a CONFIDENT, INCOMPLETE chart: nine
   * of ten roles failing drew one bar under a heading saying "Pipeline by
   * role", and a missing role is indistinguishable from a role legitimately
   * dropped for having no candidates. A recruiter comparing roles would
   * conclude the other nine have no pipeline.
   */
  const [failedRoles, setFailedRoles] = useState(0);
  const headingId = useId();
  const bodyId = useId();
  /** Collapsed by default: see the disclosure comment in the render. */
  const [open, setOpen] = useState(false);

  const charted = useMemo(
    () => (roleId ? roles.filter((r) => r.id === roleId) : roles),
    [roles, roleId],
  );
  const chartedKey = charted.map((r) => r.id).join(',');

  // Generation counter: a slower earlier fan-out must never overwrite the
  // rows for the selection the recruiter is now looking at.
  const gen = useRef(0);
  useEffect(() => {
    // The counter is bumped BEFORE the early return, and the error cleared
    // with it. Returning early without doing both let an in-flight fan-out for
    // a previous selection satisfy `mine === gen.current` and repaint bars for
    // roles the recruiter is no longer looking at — and pinned a stale red
    // alert above the filter bar for a selection that charts nothing.
    const mine = ++gen.current;
    setError(null);
    setFailedRoles(0);
    if (charted.length === 0) {
      setRows([]);
      return;
    }
    setRows(null);
    // A BOUNDED pool, not `charted.map(...)` straight into `Promise.all`.
    // One funnel aggregate per role, unbounded, means a 40-role workspace
    // fires 40 concurrent rollup queries every time Candidates is opened — and
    // on HTTP/1.1 they queue ahead of whatever the page asks for next,
    // delaying the candidate list, which is the page's actual subject.
    // `/api/funnel/summary` takes a single role_id, so a pool is the fix
    // available here; a server-side all-roles breakdown would be better.
    runPooled(charted, MAX_PARALLEL_FUNNEL_READS, (role) =>
      api
        .getScreeningFunnel({ role_id: role.id })
        .then((res) => ({ role, totals: res.totals }))
        // One role failing must not blank the whole panel.
        .catch(() => null),
    )
      .then((settled) => {
        if (mine !== gen.current) return;
        const ok = settled.filter((r): r is RoleTotals => r !== null);
        setFailedRoles(settled.length - ok.length);
        if (ok.length === 0) {
          setError('Pipeline figures are unavailable right now.');
          setRows([]);
          return;
        }
        setRows(ok);
      });
    // No outer `.catch`: every inner promise is already caught to `null`, so
    // `Promise.all` cannot reject. A handler here would be dead code that
    // reads as safety.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartedKey]);

  // Roles nobody has applied to are noise on a pipeline chart.
  const populated = (rows ?? []).filter((r) => (r.totals.candidates_total ?? 0) > 0);

  // NOTHING while loading, deliberately. This panel is supplementary and
  // legitimately renders nothing at all (no role with candidates), so a
  // spinner here would often resolve to an empty space — a flash of noise
  // above the filter bar announcing a section that never arrives. The
  // candidate list below has its own loading state and is the page's subject.
  if (rows === null) return null;
  if (error) {
    // `status`, not `alert`. This panel is supplementary; an assertive
    // announcement would interrupt a recruiter before they reach the list they
    // came for, about a chart they did not ask for.
    return (
      <InlineNotice tone="warning" role="status" className="mt-6">
        {error}
      </InlineNotice>
    );
  }
  // NOT `populated.length === 0` alone. A partial outage whose surviving roles
  // happen to have no candidates would hide the entire panel — and silence
  // here reads as "no role has a pipeline", the exact failure `failedRoles`
  // was added to report.
  if (populated.length === 0 && failedRoles === 0) return null;

  return (
    <GlassPanel as="section" aria-labelledby={headingId} padding="sm" className="mt-6">
      {/* A DISCLOSURE, closed by default (owner request 2026-09-22). Expanded,
          this panel is ~290px for one role and over 1100px for six, which put
          the candidate table — the page's subject — below the fold and made
          the page LONGER than before the change that was meant to declutter
          it. The summary line carries the one number worth seeing closed. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2
          id={headingId}
          className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--c-ink)]"
        >
          Pipeline by role
        </h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] font-medium text-[var(--c-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
        >
          {open ? 'Hide' : `Show ${populated.length} ${populated.length === 1 ? 'role' : 'roles'}`}
        </button>
      </div>

      <div id={bodyId} hidden={!open}>
      <p className="mt-1 text-[13px] leading-5 text-[var(--c-ink-secondary)]">
        Each bar is one role&rsquo;s candidates, split by how far they got &mdash; the parts add up
        to the role&rsquo;s total, so nobody is counted twice. The line under each bar reads the
        other way: how many REACHED each stage. &ldquo;Selected&rdquo; is not tracked yet, because
        the stage a candidate sits in today is recorded once at import and never updated.
      </p>

      <div className="mt-4 flex flex-col gap-5">
        {populated.map(({ role, totals }) => (
          <div key={role.id} data-role-pipeline={role.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium text-[var(--c-ink)]">{role.title}</h3>
              <span className="text-[13px] tabular-nums text-[var(--c-ink-secondary)]">
                {totals.candidates_total.toLocaleString()} in pipeline
              </span>
            </div>
            <PipelineBar
              className="mt-2"
              label={`Pipeline for ${role.title}`}
              total={stageTotals(totals).total}
              segments={segmentsFor(totals)}
              footnote={<StageTotals totals={totals} />}
            />
          </div>
        ))}
      </div>

      {failedRoles > 0 && (
        // A chart that is MISSING roles must say so. Silence here reads as
        // "those roles have no pipeline".
        <p
          role="status"
          className="mt-4 text-xs leading-5 text-[var(--c-caution)]"
          data-failed-roles={failedRoles}
        >
          {failedRoles === 1
            ? '1 role could not be read, so it is missing from this chart.'
            : `${failedRoles} roles could not be read, so they are missing from this chart.`}
        </p>
      )}

      </div>
    </GlassPanel>
  );
}
