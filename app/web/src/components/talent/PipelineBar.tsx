/**
 * PipelineBar — one horizontal bar split into proportional segments, with a
 * legend that is either plain text or, when `onToggle` is given, the FILTER
 * CONTROL ITSELF.
 *
 * Built because `ProportionBar` is a different shape: it draws one bar per
 * row, each measured against a total. This draws ONE bar whose segments
 * partition a total, which is what reads at a glance when a recruiter wants
 * "where is everyone" rather than six numbers to add up.
 *
 * ONE SURFACE, NOT TWO. The first cut drew this bar ABOVE the existing filter
 * chips, which left four rows of label+number where there had been two — the
 * legend is itself a row of chips, so "add a chart" had quietly meant "add a
 * second chip row". When `onToggle` is passed the legend entries ARE the
 * toggles: same `role="group"`, same `aria-pressed`, same 44px targets, same
 * URL contract, and the chip row goes away.
 *
 * THE SEGMENTS MUST BE DISJOINT AND MUST NOT EXCEED THE TOTAL. A stack
 * asserts that its parts sum to the whole. Two failures are possible and both
 * used to render as a confident, wrong picture:
 *   - parts < total → the bar stretched to fill the track. Now an explicit
 *     "Unaccounted" legend entry names the gap.
 *   - parts > total → worse. The segments are flex children, so the browser
 *     SHRANK them to fit and drew a full bar in the right ratios at the wrong
 *     scale. Now segments never shrink (`shrink-0`), the bar is measured
 *     against whichever is larger, and the discrepancy is named.
 *
 * Accessibility: the bar track is decorative (`aria-hidden`) and the legend
 * carries the meaning as real text. Adjacent segments get a hairline divider,
 * because two buckets can legitimately share a tone and would otherwise read
 * as one block to a sighted user — the swatch colour is the only thing
 * linking legend to bar, and it is not injective.
 */
import type { ReactNode } from 'react';

export type PipelineTone = 'accent' | 'positive' | 'caution' | 'negative' | 'neutral';

/** Fill per tone, in the candidate-surface palette (`--c-*`, candidate-palette.css). */
const FILL: Record<PipelineTone, string> = {
  accent: 'var(--c-accent)',
  positive: 'var(--c-positive)',
  caution: 'var(--c-caution)',
  negative: 'var(--c-negative)',
  // MEASURED, after two wrong guesses in opposite directions.
  // `--c-ink-secondary` (#334155) is an ink token: 8.90:1 on the track, so
  // "nobody dialled yet" drew as the heaviest block and read as a full worked
  // pipeline. `--c-border` (#dbe1ec) overshot the other way at 1.13:1 —
  // one step from the empty track itself, and identical to the `unavailable`
  // swatch, so the usually-dominant bucket became invisible.
  // `--c-ink-muted` is 4.03:1 on the track and 4.68:1 on the surface: clear of
  // the 3:1 floor a meaningful graphic needs (WCAG 1.4.11), without shouting.
  neutral: 'var(--c-ink-muted)',
};

export interface PipelineSegment {
  key: string;
  label: string;
  value: number;
  tone: PipelineTone;
  /**
   * Set when the number cannot be MEASURED yet rather than being genuinely
   * zero. The segment is kept out of the bar and out of the sum, and its
   * legend entry reads the caveat instead of a count — a measurement gap must
   * never render as an outcome.
   */
  unavailable?: string;
}

export interface PipelineBarProps {
  segments: readonly PipelineSegment[];
  /**
   * The cohort the segments partition. Defaults to their sum. Passing it
   * explicitly is what lets the bar report a gap or an overflow instead of
   * silently rescaling to whatever the parts happen to add up to.
   */
  total?: number;
  /** Accessible name for the legend — its list name, or its group name when interactive. */
  label: string;
  /** Makes the legend a filter control. Receives the segment key. */
  onToggle?: (key: string) => void;
  /** Which segment keys are currently active. Only meaningful with `onToggle`. */
  selectedKeys?: readonly string[];
  /** Rendered after the legend — a caveat, a stage summary, a timestamp. */
  footnote?: ReactNode;
  className?: string;
}

/** 44px minimum target, matching the filter pills this legend replaced. */
const TOGGLE_CLASS = (selected: boolean) =>
  [
    'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors duration-200',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]',
    selected
      ? 'bg-[var(--c-accent)] text-[var(--c-data-label-inside)] shadow-pill'
      : 'bg-[var(--c-surface)] text-[var(--c-ink-secondary)] shadow-[inset_0_0_0_1px_var(--c-border)] hover:bg-[var(--c-border-light)] hover:text-[var(--c-ink)]',
  ].join(' ');

export function PipelineBar({
  segments,
  total,
  label,
  onToggle,
  selectedKeys,
  footnote,
  className,
}: PipelineBarProps) {
  const counted = segments.filter((s) => !s.unavailable);
  const sum = counted.reduce((n, s) => n + Math.max(0, s.value), 0);
  const stated = typeof total === 'number' && total > 0 ? total : sum;
  // Measure against whichever is LARGER. If the parts overflow the stated
  // cohort the bar stays in scale and the overflow is named, rather than the
  // browser shrinking flex children into a plausible full bar.
  const denominator = Math.max(stated, sum);
  const remainder = stated > sum ? stated - sum : 0;
  const overflow = sum > stated ? sum - stated : 0;

  const drawn = counted.filter((s) => s.value > 0);
  const selected = new Set(selectedKeys ?? []);
  const interactive = typeof onToggle === 'function';

  return (
    <div className={className}>
      {denominator > 0 && (
        <span
          aria-hidden="true"
          data-pipeline-track=""
          className="flex h-2.5 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: 'var(--c-border-light)' }}
        >
          {drawn.map((s, i) => (
            <span
              key={s.key}
              // `shrink-0`: flex children default to shrinking, which is how an
              // over-sum used to renormalise into a believable full bar.
              className="block h-full shrink-0 first:rounded-l-full"
              style={{
                width: `${(s.value / denominator) * 100}%`,
                backgroundColor: FILL[s.tone],
                // Hairline between neighbours: two buckets may share a tone
                // (new/queued, screened/advanced) and would read as one block.
                boxShadow: i > 0 ? 'inset 1px 0 0 0 var(--c-surface)' : undefined,
                // Only cap the right edge when the bar genuinely ends here; a
                // rounded cap over an unaccounted gap reads as complete.
                borderTopRightRadius:
                  remainder === 0 && i === drawn.length - 1 ? 9999 : undefined,
                borderBottomRightRadius:
                  remainder === 0 && i === drawn.length - 1 ? 9999 : undefined,
              }}
            />
          ))}
        </span>
      )}

      <LegendShell interactive={interactive} label={label}>
        {segments.map((s) => {
          const isOn = selected.has(s.key);
          const body = (
            <>
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: s.unavailable ? 'var(--c-border)' : FILL[s.tone],
                  // A ring in the pill's own text colour when pressed. The
                  // selected pill is filled with `--c-accent`, against which
                  // the accent swatch scores 1.00:1 — it disappeared exactly
                  // when the recruiter clicked it to find its block in the bar.
                  boxShadow: isOn ? '0 0 0 1.5px var(--c-data-label-inside)' : undefined,
                }}
              />
              <span className={interactive ? undefined : 'text-[var(--c-ink-secondary)]'}>
                {s.label}
              </span>
              {s.unavailable ? (
                <span className="italic text-[var(--c-ink-secondary)]">{s.unavailable}</span>
              ) : (
                <span className="font-semibold tabular-nums" data-segment-value={s.key}>
                  {s.value.toLocaleString()}
                </span>
              )}
            </>
          );

          // An unmeasurable segment is never a filter: there is nothing to
          // filter TO, and a pressed state would imply a cohort exists.
          if (interactive && !s.unavailable) {
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onToggle!(s.key)}
                aria-pressed={isOn}
                className={TOGGLE_CLASS(isOn)}
              >
                {body}
              </button>
            );
          }
          // A `span` inside the interactive shell, never an `li`: the shell is
          // a `div role="group"` there, and an `li` outside a list is invalid
          // markup that assistive tech reports as an orphan listitem. Reached
          // by any unavailable segment on a filtering bar.
          const Tag = interactive ? 'span' : 'li';
          return (
            <Tag
              key={s.key}
              className={
                interactive
                  ? 'inline-flex min-h-11 items-center gap-1.5 px-3 text-[13px]'
                  : 'inline-flex items-center gap-1.5'
              }
            >
              {body}
            </Tag>
          );
        })}

        {remainder > 0 && (
          <DiscrepancyEntry
            interactive={interactive}
            swatch="var(--c-border-light)"
            label="Unaccounted"
            value={remainder}
            valueKey="__remainder"
          />
        )}
        {overflow > 0 && (
          <DiscrepancyEntry
            interactive={interactive}
            swatch="var(--c-negative)"
            // Names the contradiction instead of drawing around it. Reachable
            // when the funnel rollup and the candidate list are read at
            // different instants.
            label="Figures disagree, over by"
            value={overflow}
            valueKey="__overflow"
          />
        )}
      </LegendShell>

      {footnote && (
        <p className="mt-1.5 text-xs leading-5 text-[var(--c-ink-secondary)]">{footnote}</p>
      )}
    </div>
  );
}

/**
 * A `group` of buttons when the legend filters, an explicit `role="list"`
 * otherwise.
 *
 * The role is spelled out rather than left to the `ul` tag: Tailwind's
 * preflight sets `list-style: none` and this legend is `display: flex`, and
 * WebKit drops the implicit list role in exactly that combination. Since the
 * bar is `aria-hidden`, the legend is the ENTIRE accessible representation,
 * so losing its grouping loses the chart.
 */
function LegendShell({
  interactive,
  label,
  children,
}: {
  interactive: boolean;
  label: string;
  children: ReactNode;
}) {
  const className = 'mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]';
  if (interactive) {
    return (
      <div role="group" aria-label={label} className={className}>
        {children}
      </div>
    );
  }
  return (
    <ul role="list" aria-label={label} className={className}>
      {children}
    </ul>
  );
}

/** A named gap or overflow — never a silent rescale. */
function DiscrepancyEntry({
  interactive,
  swatch,
  label,
  value,
  valueKey,
}: {
  interactive: boolean;
  swatch: string;
  label: string;
  value: number;
  valueKey: string;
}) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: swatch }}
      />
      <span className="text-[var(--c-ink-secondary)]">{label}</span>
      <span
        className="font-semibold tabular-nums text-[var(--c-ink)]"
        data-segment-value={valueKey}
      >
        {value.toLocaleString()}
      </span>
    </>
  );
  const cls = interactive
    ? 'inline-flex min-h-11 items-center gap-1.5 px-3 text-[13px]'
    : 'inline-flex items-center gap-1.5';
  return interactive ? (
    <span className={cls}>{body}</span>
  ) : (
    <li className={cls}>{body}</li>
  );
}
