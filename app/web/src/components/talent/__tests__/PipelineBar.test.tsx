/**
 * PipelineBar + the role funnel decomposition.
 *
 * The load-bearing claim a stacked bar makes is that ITS PARTS SUM TO THE
 * WHOLE. The funnel totals it is fed do not satisfy that on their own —
 * `dialed`, `connected` and `scored` are nested cohorts — so most of this
 * file is about the arithmetic that turns them into disjoint buckets, and
 * about the one segment that must never render as a number at all.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PipelineBar } from '../PipelineBar';
import { segmentsFor } from '../RolePipelinePanel';
import { funnelTotals } from '../../../test/funnel';

/**
 * Segment widths from ONE bar.
 *
 * Scoped to a container and to the track's own data hook. The first version
 * queried `[aria-hidden="true"] > span` across the whole document, which
 * happens to be correct for a single bar but silently concatenates two — and
 * this file now renders components that draw one bar per role.
 */
function widths(container: HTMLElement): number[] {
  const track = container.querySelector('[data-pipeline-track]');
  if (!track) return [];
  return [...track.querySelectorAll<HTMLElement>(':scope > span')]
    .map((el) => Number.parseFloat(el.style.width))
    .filter((n) => Number.isFinite(n));
}

describe('segmentsFor — nested funnel stages become disjoint buckets', () => {
  it('SUMS TO THE COHORT, never double-counting a nested stage', () => {
    // The bug this exists to prevent: stacking dialed + connected + scored
    // side by side counts a screened candidate three times and draws a bar
    // 3x wider than the role's actual cohort.
    const totals = funnelTotals({
      candidates_total: 10,
      dialed: 8,
      connected: 6,
      scored: 4,
    });
    const segs = segmentsFor(totals);
    const counted = segs.filter((s) => !s.unavailable);
    expect(counted.reduce((n, s) => n + s.value, 0)).toBe(10);
  });

  it('puts each candidate in the bucket they actually stopped at', () => {
    // FOUR DISTINCT VALUES, deliberately. The old fixture (10/8/6/4) produced
    // 2, 2, 2, 4 — so permuting the bucket expressions was invisible, and a
    // verified mutation swapping `not_dialed` with `connected` passed all 277
    // tests. The sum-based assertions cannot catch it either: the telescoping
    // identity holds for ANY arrangement of the four expressions.
    const segs = segmentsFor(
      funnelTotals({ candidates_total: 30, dialed: 22, connected: 12, scored: 5 }),
    );
    const by = new Map(segs.map((s) => [s.key, s.value]));
    expect(by.get('not_dialed')).toBe(8); // 30 - 22
    expect(by.get('no_answer')).toBe(10); // 22 - 12
    expect(by.get('connected')).toBe(7); // 12 -  5
    expect(by.get('scored')).toBe(5);
  });

  it('never yields NaN from a NON-NUMERIC payload', () => {
    // The values here must be ones `?? 0` CANNOT rescue. The first version of
    // this test used `undefined` and `null`, which the pre-fix
    // `Math.max(0, x ?? 0)` already coerced to 0 — so the guard it was written
    // to defend could be deleted and the test stayed green.
    for (const partial of [
      { candidates_total: 10, dialed: NaN } as never,
      { candidates_total: 10, connected: 'many' } as never,
      { candidates_total: 10, scored: Infinity } as never,
      { candidates_total: 10, dialed: undefined, connected: null } as never,
    ]) {
      const segs = segmentsFor(partial);
      for (const seg of segs) expect(Number.isFinite(seg.value)).toBe(true);
      const counted = segs.filter((x) => !x.unavailable);
      expect(counted.reduce((n, x) => n + x.value, 0)).toBe(10);
    }
  });

  it('shares no LABEL WORD between the buckets and the stage line', () => {
    // Word-level, not exact-string. Asserting `!== 'Connected'` let
    // "Connected, not screened" through, re-creating the very collision the
    // check is named after.
    const stageWords = new Set(['dialled', 'connected', 'screened']);
    for (const seg of segmentsFor(funnelTotals({ candidates_total: 1 }))) {
      const words = seg.label.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      for (const w of words) expect(stageWords.has(w)).toBe(false);
    }
  });

  it('STILL SUMS TO THE COHORT WHEN A NESTED PAIR INVERTS', () => {
    // THE bug this suite exists for, and the one its earlier version walked
    // past by asserting only `value >= 0`. Differencing each pair
    // independently turns every inversion into an OVER-count: this exact input
    // used to produce 3 + 0 + 4 + 0 = SEVEN people in a five-person role, four
    // of them labelled "Connected" where only two were ever dialled.
    // Inversions are reachable — the rollup and the list are read at different
    // instants — so this is live, not theoretical.
    const segs = segmentsFor(
      funnelTotals({ candidates_total: 5, dialed: 2, connected: 4, scored: 0 }),
    );
    const counted = segs.filter((s) => !s.unavailable);
    for (const s of counted) expect(s.value).toBeGreaterThanOrEqual(0);
    expect(counted.reduce((n, s) => n + s.value, 0)).toBe(5);
  });

  it('sums to the cohort across a sweep of adversarial stage shapes', () => {
    // Property check rather than three hand-picked cases: any ordering of the
    // nested stages, including every inversion, must still partition exactly.
    for (const total of [0, 1, 5, 10]) {
      for (const dialed of [0, 2, 5, 12]) {
        for (const connected of [0, 3, 5, 12]) {
          for (const scored of [0, 1, 7, 12]) {
            const shape = { candidates_total: total, dialed, connected, scored };
            const counted = segmentsFor(funnelTotals(shape)).filter((s) => !s.unavailable);
            for (const s of counted) {
              expect(s.value, JSON.stringify(shape)).toBeGreaterThanOrEqual(0);
            }
            expect(
              counted.reduce((n, s) => n + s.value, 0),
              JSON.stringify(shape),
            ).toBe(total);
          }
        }
      }
    }
  });

  it('marks Selected UNAVAILABLE rather than zero', () => {
    // `reached_reference_check` is derived from a stage id written once at
    // import and never updated, and needs a mapping field that is unset in
    // production. A 0 here would read as "nobody was selected" — an outcome
    // — when the truth is that no signal exists.
    const selected = segmentsFor(funnelTotals({ candidates_total: 9, scored: 9 })).find(
      (s) => s.key === 'selected',
    );
    expect(selected?.unavailable).toBe('Not tracked yet');
  });
});

describe('PipelineBar', () => {
  const SEGMENTS = [
    { key: 'a', label: 'Alpha', value: 3, tone: 'accent' as const },
    { key: 'b', label: 'Beta', value: 1, tone: 'positive' as const },
  ];

  it('sizes each segment against the stated total, not the parts', () => {
    const { container } = render(<PipelineBar label="t" total={8} segments={SEGMENTS} />);
    // 3/8 and 1/8 — NOT 3/4 and 1/4. Rescaling to the parts would draw a full
    // bar for a half-empty cohort.
    expect(widths(container)).toEqual([37.5, 12.5]);
  });

  it('names the UNACCOUNTED remainder instead of stretching to fill', () => {
    const { container } = render(<PipelineBar label="t" total={8} segments={SEGMENTS} />);
    expect(screen.getByText('Unaccounted')).toBeInTheDocument();
    expect(
      container.querySelector('[data-segment-value="__remainder"]')?.textContent,
    ).toBe('4');
  });

  it('draws no remainder when the parts do add up', () => {
    render(<PipelineBar label="t" total={4} segments={SEGMENTS} />);
    expect(screen.queryByText('Unaccounted')).not.toBeInTheDocument();
  });

  it('keeps a zero segment in the LEGEND but out of the bar', () => {
    // "Rejected 0" is a fact worth reading; a zero-width sliver is a
    // rendering artifact.
    const { container } = render(
      <PipelineBar
        label="t"
        segments={[...SEGMENTS, { key: 'z', label: 'Zero', value: 0, tone: 'negative' as const }]}
      />,
    );
    expect(screen.getByText('Zero')).toBeInTheDocument();
    expect(container.querySelector('[data-segment-value="z"]')?.textContent).toBe('0');
    expect(widths(container)).toHaveLength(2); // only Alpha and Beta are drawn
  });

  it('EXCLUDES AN UNAVAILABLE SEGMENT THAT CARRIES A VALUE', () => {
    // The case the `unavailable` filter actually protects. A stale or
    // placeholder number on an unmeasurable segment must not reach the bar:
    // it would take width from the real segments and render an outcome that
    // was explicitly declared unknowable. (An unavailable segment valued 0 —
    // what `segmentsFor` produces today — exercises none of this, which is
    // why the earlier version of this test passed with the filter deleted.)
    render(
      <PipelineBar
        label="t"
        total={4}
        segments={[
          ...SEGMENTS,
          { key: 'u', label: 'Selected', value: 99, tone: 'positive' as const, unavailable: 'Not tracked yet' },
        ]}
      />,
    );
    expect(screen.getByText('Not tracked yet')).toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
    // ...and it must not inflate the sum, or the remainder would vanish.
    expect(document.querySelector('[data-segment-value="__remainder"]')).toBeNull();
  });

  it('exposes the legend as a named list, since the bar is decorative', () => {
    const { container } = render(
      <PipelineBar label="Pipeline for Sales" total={4} segments={SEGMENTS} />,
    );
    expect(screen.getByRole('list', { name: 'Pipeline for Sales' })).toBeInTheDocument();
    // Asserted on THE TRACK specifically. `document.querySelector('span[aria-hidden]')`
    // matched any legend swatch, so removing aria-hidden from the track — which
    // makes a screen reader read every segment twice — left the test green.
    const track = container.querySelector('[data-pipeline-track]');
    expect(track).not.toBeNull();
    expect(track).toHaveAttribute('aria-hidden', 'true');
  });

  it('SURFACES an over-sum instead of letting flexbox squash it into a full bar', () => {
    // Segments are flex children; with the default `flex-shrink: 1` a 140%
    // sum was quietly renormalised to a plausible, proportionally wrong bar —
    // the exact failure the component documents that it prevents.
    const { container } = render(
      <PipelineBar
        label="t"
        total={5}
        segments={[
          { key: 'a', label: 'Alpha', value: 3, tone: 'accent' },
          { key: 'b', label: 'Beta', value: 4, tone: 'positive' },
        ]}
      />,
    );
    expect(screen.getByText('Figures disagree, over by')).toBeInTheDocument();
    expect(container.querySelector('[data-segment-value="__overflow"]')?.textContent).toBe('2');
    // Scaled against the SUM (7), exactly — `toBeLessThanOrEqual(100)` was
    // one-sided and a half-scale mutation passed it.
    const drawn = widths(container);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toBeCloseTo((3 / 7) * 100, 6);
    expect(drawn[1]).toBeCloseTo((4 / 7) * 100, 6);
    expect(drawn.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    // jsdom applies no CSS, so the flex behaviour this guards cannot be
    // observed by layout here. The class is the only assertable proxy, and
    // without it the browser silently squashes an over-sum into a full bar.
    const track = container.querySelector('[data-pipeline-track]');
    expect(track?.firstElementChild?.className).toContain('shrink-0');
  });

  it('makes the legend THE FILTER when onToggle is given', () => {
    // Replaces the old chip row rather than sitting above it.
    const onToggle = vi.fn();
    render(
      <PipelineBar
        label="Filter by status"
        total={4}
        segments={SEGMENTS}
        onToggle={onToggle}
        selectedKeys={['a']}
      />,
    );
    const group = screen.getByRole('group', { name: 'Filter by status' });
    const alpha = within(group).getByRole('button', { name: /Alpha/ });
    expect(alpha).toHaveAttribute('aria-pressed', 'true');
    // The 44px target the filter contract requires survives the move.
    expect(alpha.className).toContain('min-h-11');
    expect(within(group).getByRole('button', { name: /Beta/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(alpha);
    expect(onToggle).toHaveBeenCalledWith('a');
  });

  it('never offers an UNMEASURABLE segment as a filter', () => {
    // There is nothing to filter to, and a pressed state would imply a cohort.
    const onToggle = vi.fn();
    render(
      <PipelineBar
        label="Filter by status"
        total={4}
        segments={[
          ...SEGMENTS,
          { key: 'u', label: 'Selected', value: 0, tone: 'positive', unavailable: 'Not tracked yet' },
        ]}
        onToggle={onToggle}
      />,
    );
    const group = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(group).queryByRole('button', { name: /Selected/ })).toBeNull();
    expect(screen.getByText('Not tracked yet')).toBeInTheDocument();
    // ...and it is not an ORPHAN LISTITEM. The interactive shell is a
    // `div role="group"`, so an `li` here is invalid markup that AT reports
    // as a listitem outside any list.
    expect(group.querySelector('li')).toBeNull();
    expect(within(group).queryAllByRole('listitem')).toHaveLength(0);
  });
});
