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
 * HOVER DETAIL. A stacked bar with a dozen thin colours is hard to read, so
 * hovering a segment shows "Label · count · pct%" in a bubble above the bar.
 * The bubble sits OUTSIDE the track (which is `overflow-hidden`) and is
 * clamped inside it. The legend entries drive the same bubble on hover AND
 * focus, so keyboard users get the detail without a new tab stop per
 * segment; the matching segment is highlighted and the rest dimmed. The
 * bubble is decorative (`aria-hidden`): the legend already carries the label
 * and count as text.
 *
 * Accessibility: the bar track is decorative (`aria-hidden`) and the legend
 * carries the meaning as real text. The swatch is the only thing linking legend
 * to bar, so every tone draws differently (pinned in PipelineBar.test.tsx). A
 * status list has more keys than there are tones, though, so two buckets can
 * still share one: each segment after the first is set off by a 2px paper gap,
 * or they would read as one block.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type PipelineTone =
  "accent" | "positive" | "caution" | "negative" | "neutral" | "voice";

/**
 * Fill per tone, on the ramp the approved mock draws. The bar is an outlined box
 * and a bucket darkens as people move through it, so "nobody dialled yet", the
 * usually-largest bucket, is the lightest block and not a heavy one. The outline
 * is the 3:1 boundary (WCAG 1.4.11), the gap between segments keeps neighbours
 * apart, and an outcome is not coloured good or bad.
 *
 * `voice` is the one hue on the ramp. Orange means the candidate's voice, so it
 * marks the on-a-call stage and nothing else.
 */
const FILL: Record<PipelineTone, string> = {
  neutral: "var(--c-border)",
  caution: "var(--c-control-border)",
  voice: "var(--voice-mark)",
  negative: "var(--c-ink-muted)",
  accent: "var(--c-ink-secondary)",
  positive: "var(--c-ink)",
};

/**
 * The legend's key: a printed box, so even the lightest fill has an edge.
 * `data-fill` goes on real fills only (see `fillClass`): a hollow key says there
 * is nothing to draw, and must stay hollow under forced colours.
 */
const SWATCH_CLASS =
  "h-2.5 w-3 shrink-0 rounded-sm border border-[var(--c-control-border)]";
const fillClass = `data-fill ${SWATCH_CLASS}`;

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
    "inline-flex min-h-9 items-center gap-1.5 rounded-control px-3 text-label font-medium transition-colors duration-hover [@media(pointer:coarse)]:min-h-11",
    // The offset is what shows on a selected chip: its fill and its ring are both ink.
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
    selected
      ? "bg-[var(--c-accent)] text-[var(--c-data-label-inside)]"
      : "bg-[var(--c-surface)] text-[var(--c-ink-secondary)] border border-[var(--c-control-border)] hover:bg-[var(--c-border-light)] hover:text-[var(--c-ink)]",
  ].join(" ");

/** "16%", "4.5%", or "<1%" for a real but tiny share. Same basis as the width. */
export function formatShare(value: number, denominator: number): string {
  if (denominator <= 0 || value <= 0) return "0%";
  const pct = (value / denominator) * 100;
  if (pct < 1) return "<1%";
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${Number(pct.toFixed(1))}%`;
}

/** Which segment is highlighted, and where the bubble anchors (px from track left; null = segment centre). */
interface ActiveSegment {
  key: string;
  x: number | null;
}

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
  const stated = typeof total === "number" && total > 0 ? total : sum;
  // Measure against whichever is LARGER. If the parts overflow the stated
  // cohort the bar stays in scale and the overflow is named, rather than the
  // browser shrinking flex children into a plausible full bar.
  const denominator = Math.max(stated, sum);
  const remainder = stated > sum ? stated - sum : 0;
  const overflow = sum > stated ? sum - stated : 0;

  const drawn = counted.filter((s) => s.value > 0);
  const selected = new Set(selectedKeys ?? []);
  const interactive = typeof onToggle === "function";

  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState<ActiveSegment | null>(null);
  const [tipLeft, setTipLeft] = useState<number | null>(null);

  const activeSegment = active
    ? (drawn.find((s) => s.key === active.key) ?? null)
    : null;
  // Centre of the active segment as a fraction of the track, for the
  // keyboard / legend case where there is no pointer position.
  let centreFraction = 0;
  if (activeSegment) {
    let before = 0;
    for (const s of drawn) {
      if (s.key === activeSegment.key) break;
      before += Math.max(0, s.value);
    }
    centreFraction = (before + activeSegment.value / 2) / denominator;
  }

  // Clamp the bubble inside the track once its width is known.
  useLayoutEffect(() => {
    if (!activeSegment || !active) {
      setTipLeft(null);
      return;
    }
    const wrap = wrapRef.current;
    const tip = tipRef.current;
    const trackWidth = wrap?.getBoundingClientRect().width ?? 0;
    const tipWidth = tip?.getBoundingClientRect().width ?? 0;
    const anchor = active.x ?? centreFraction * trackWidth;
    const half = tipWidth / 2;
    const min = half;
    const max = Math.max(min, trackWidth - half);
    setTipLeft(Math.min(Math.max(anchor, min), max));
  }, [active, activeSegment, centreFraction]);

  const showFrom = (key: string, x: number | null) => {
    if (!drawn.some((s) => s.key === key)) return;
    setActive((prev) =>
      prev && prev.key === key && prev.x === x ? prev : { key, x },
    );
  };
  const hide = () => setActive(null);
  const legendHover = (key: string) => ({
    onMouseEnter: () => showFrom(key, null),
    onMouseLeave: hide,
    onFocus: () => showFrom(key, null),
    onBlur: hide,
  });

  return (
    <div className={className}>
      {denominator > 0 && (
        <div ref={wrapRef} className="relative" onMouseLeave={hide}>
          <span
            aria-hidden="true"
            data-pipeline-track=""
            // A real border, not an inset shadow: forced colours keep borders.
            className="flex h-4 w-full overflow-hidden rounded-control border border-[var(--c-control-border)] bg-[var(--c-surface)] p-0.5"
          >
            {drawn.map((s, i) => (
              <span
                key={s.key}
                data-pipeline-segment={s.key}
                onMouseEnter={(e) =>
                  showFrom(s.key, pointerX(e, wrapRef.current))
                }
                onMouseMove={(e) =>
                  showFrom(s.key, pointerX(e, wrapRef.current))
                }
                // `shrink-0`: flex children default to shrinking, which is how an
                // over-sum used to renormalise into a believable full bar.
                // `min-w-1`: one person in hundreds is still a mark on the bar.
                className="data-fill block h-full min-w-1 shrink-0 transition-opacity duration-hover motion-reduce:transition-none"
                style={{
                  opacity: active && active.key !== s.key ? 0.45 : 1,
                  width: `${(s.value / denominator) * 100}%`,
                  backgroundColor: FILL[s.tone],
                  // The gap sits inside the segment, so its width stays exact,
                  // and it is a border so forced colours keep it. Two buckets
                  // may share a tone and would otherwise read as one block.
                  borderLeft:
                    i > 0 ? "2px solid var(--c-surface)" : undefined,
                }}
              />
            ))}
          </span>
          {activeSegment && (
            <span
              ref={tipRef}
              aria-hidden="true"
              data-pipeline-tooltip=""
              className="glass-modal pointer-events-none absolute bottom-full z-10 mb-2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-control px-2.5 py-1.5 text-xs font-medium text-[var(--c-ink)]"
              // Hidden until measured so the first frame never flashes at 0.
              style={{
                left: tipLeft ?? 0,
                visibility: tipLeft === null ? "hidden" : "visible",
              }}
            >
              <span
                className={fillClass}
                style={{ backgroundColor: FILL[activeSegment.tone] }}
              />
              <span>{activeSegment.label}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {activeSegment.value.toLocaleString()}
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums text-[var(--c-ink-secondary)]">
                {formatShare(activeSegment.value, denominator)}
              </span>
            </span>
          )}
        </div>
      )}

      <LegendShell interactive={interactive} label={label}>
        {segments.map((s) => {
          const isOn = selected.has(s.key);
          const body = (
            <>
              <span
                aria-hidden="true"
                className={s.unavailable ? SWATCH_CLASS : fillClass}
                style={{
                  // Hollow when unmeasured: a filled key would claim a block.
                  backgroundColor: s.unavailable ? undefined : FILL[s.tone],
                  // A ring in the pill's own text colour when pressed. The
                  // selected pill is filled with `--c-accent`, against which
                  // an ink swatch scores 1.00:1 — it disappeared exactly when
                  // the recruiter clicked it to find its block in the bar.
                  boxShadow: isOn
                    ? "0 0 0 1.5px var(--c-data-label-inside)"
                    : undefined,
                }}
              />
              <span
                className={
                  interactive ? undefined : "text-[var(--c-ink-secondary)]"
                }
              >
                {s.label}
              </span>
              {s.unavailable ? (
                <span className="italic text-[var(--c-ink-secondary)]">
                  {s.unavailable}
                </span>
              ) : (
                <span
                  className="font-semibold tabular-nums"
                  data-segment-value={s.key}
                >
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
                {...legendHover(s.key)}
              >
                {body}
              </button>
            );
          }
          // A `span` inside the interactive shell, never an `li`: the shell is
          // a `div role="group"` there, and an `li` outside a list is invalid
          // markup that assistive tech reports as an orphan listitem. Reached
          // by any unavailable segment on a filtering bar.
          const Tag = interactive ? "span" : "li";
          return (
            <Tag
              key={s.key}
              {...legendHover(s.key)}
              className={
                interactive
                  ? "inline-flex min-h-9 items-center gap-1.5 px-3 text-label [@media(pointer:coarse)]:min-h-11"
                  : "inline-flex items-center gap-1.5"
              }
            >
              {body}
            </Tag>
          );
        })}

        {remainder > 0 && (
          <DiscrepancyEntry
            interactive={interactive}
            swatch="var(--c-surface)"
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
        <p className="mt-1.5 text-xs leading-5 text-[var(--c-ink-secondary)]">
          {footnote}
        </p>
      )}
    </div>
  );
}

/** Pointer x relative to the wrapper's left edge. */
function pointerX(
  e: { clientX: number },
  wrap: HTMLElement | null,
): number | null {
  if (!wrap) return null;
  return e.clientX - wrap.getBoundingClientRect().left;
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
  const className =
    "mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-label";
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
        className={SWATCH_CLASS}
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
    ? "inline-flex min-h-9 items-center gap-1.5 px-3 text-label [@media(pointer:coarse)]:min-h-11"
    : "inline-flex items-center gap-1.5";
  return interactive ? (
    <span className={cls}>{body}</span>
  ) : (
    <li className={cls}>{body}</li>
  );
}
