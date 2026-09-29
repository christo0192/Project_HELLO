/**
 * MetricStrip — a group of related figures on ONE surface, divided by
 * hairlines, instead of a card per number.
 *
 * The dashboard used to give every figure its own glass card: eighteen of
 * them in five identical bands, 4,000px of page on a laptop and 15,000px on
 * a phone. A card says "this stands alone"; these figures do not. They are
 * read together (dialled, then reached, then the rate between them), so they
 * share a surface and are separated by the lightest line that still reads as
 * a boundary, the way a well-set report table is.
 *
 * Layout: one row at `sm` and up (`columns` fixes the column count so rows
 * of different lengths line up on a common grid), a two-column hairline grid
 * on a phone, where an odd last figure takes the full row rather than
 * leaving a hole.
 *
 * Hairlines without per-cell backgrounds: every cell draws its own top and
 * left rule, and the grid is pulled up and left by one pixel inside a
 * clipping box, so the rules on the outer edges fall outside it. That works
 * for any column count at any width, with no knowledge of which cell is
 * first in its row.
 *
 * Semantics: the whole strip is a group named by its heading (so a screen
 * reader hears "Reach, group" rather than eleven loose numbers). Static
 * figures are a description list (term = label, definition = figure); when
 * any figure drills down it becomes a list of links, because a link may not
 * sit inside a `<dl>`.
 */
import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from './cx';
import { RollingNumber } from './RollingNumber';
import { Skeleton } from './Skeleton';

export type MetricTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface MetricItem {
  /** Stable key; defaults to the label. */
  key?: string;
  label: string;
  /** A formatted figure ("1,204", "69%", "—") or a node (a status badge). */
  value: ReactNode;
  /** Small suffix after the figure ("/ 100"). */
  unit?: string;
  /** One short line under the figure: the formula, a delta, a caveat. */
  context?: ReactNode;
  /** A small dot before the label, for figures whose category has a meaning. */
  tone?: MetricTone;
  /** The figure itself needs attention (e.g. overdue > 0): warning ink. */
  attention?: boolean;
  /** Drill-down: the whole cell becomes a link. */
  href?: string;
  /** The link's accessible name. Defaults to "label: figure". */
  ariaLabel?: string;
  loading?: boolean;
  /** Raw value one hover away, for an operator. */
  title?: string;
}

export type MetricStripSize = 'hero' | 'default' | 'compact';

export interface MetricStripProps {
  /** Names the group (heading text and accessible name). */
  label: string;
  /** Keep the heading for assistive tech only (a panel title already says it). */
  hideLabel?: boolean;
  description?: ReactNode;
  items: ReadonlyArray<MetricItem | false | null | undefined>;
  size?: MetricStripSize;
  /** Columns at `sm` and up. Defaults to the number of items. */
  columns?: number;
  /** `aside` puts the heading in a left column at `lg` (report rows). */
  layout?: 'stacked' | 'aside';
  headingLevel?: 2 | 3 | 4;
  /** A line under the figures (e.g. who is deliberately NOT counted). */
  footnote?: ReactNode;
  /** Extra content under the figures (e.g. a notice). */
  children?: ReactNode;
  /**
   * Pull the cells out by their own padding, so the first figure lines up
   * with the text around the strip (a heading, a panel's padding) instead of
   * sitting one cell-gutter in.
   */
  bleed?: boolean;
  className?: string;
}

const DOT: Record<MetricTone, string> = {
  neutral: 'bg-ink-muted',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-error',
};

const FIGURE: Record<MetricStripSize, string> = {
  // The scale's hero step (30/36, -0.02em): one size for every page's lead figure.
  hero: 'text-stat',
  default: 'text-2xl leading-8 tracking-[-0.02em]',
  compact: 'text-xl leading-7 tracking-[-0.015em]',
};

const CELL_PAD: Record<MetricStripSize, string> = {
  hero: 'px-5 py-4',
  default: 'px-4 py-3',
  compact: 'px-3.5 py-2.5',
};

/** Three to a row on a phone: a narrower gutter so the labels still fit. */
const CELL_PAD_THREE_UP: Record<MetricStripSize, string> = {
  hero: 'px-3 py-4 sm:px-5',
  default: 'px-3 py-3 sm:px-4',
  compact: 'px-2.5 py-2.5 sm:px-3.5',
};

const SKELETON: Record<MetricStripSize, { width: number; height: number }> = {
  hero: { width: 72, height: 32 },
  default: { width: 56, height: 26 },
  compact: { width: 48, height: 22 },
};

const BLEED: Record<MetricStripSize, string> = {
  hero: '-mx-5',
  default: '-mx-4',
  compact: '-mx-3.5',
};

const BLEED_THREE_UP: Record<MetricStripSize, string> = {
  hero: '-mx-3 sm:-mx-5',
  default: '-mx-3 sm:-mx-4',
  compact: '-mx-2.5 sm:-mx-3.5',
};

/** One cell's rules: top and left, clipped at the strip's outer edges. */
const CELL_RULES = 'min-w-0 border-l border-t border-glass-ring';

/**
 * Every cell spans three rows of the strip's grid (label, figure, context)
 * and adopts them as a subgrid, so when one label wraps to two lines the
 * figures beside it still sit on one line instead of stepping down.
 */
const SUBGRID = 'row-span-3 grid grid-rows-subgrid content-start';

export function MetricStrip({
  label,
  hideLabel = false,
  description,
  items: rawItems,
  size = 'default',
  columns,
  layout = 'stacked',
  headingLevel = 3,
  footnote,
  children,
  bleed = false,
  className,
}: MetricStripProps) {
  const uid = useId().replace(/:/g, '');
  const headingId = `metric-strip-${uid}`;
  const descId = description ? `${headingId}-desc` : undefined;
  // `false` entries are conditional figures the caller withheld on purpose;
  // they must not leave an empty cell that reads as a figure that failed.
  const items = rawItems.filter((item): item is MetricItem => Boolean(item));
  const linked = items.some((item) => item.href);
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  const cols = columns ?? Math.max(items.length, 1);
  // Three figures sit three to a row even on a phone: two-and-a-lone-one
  // cost a whole extra row per group, and the scoreboard has three of them.
  const threeUp = items.length === 3;
  const pad = (threeUp ? CELL_PAD_THREE_UP : CELL_PAD)[size];
  const gridStyle = { '--metric-cols': cols } as CSSProperties;
  const gridClass = cx(
    '-ml-px -mt-px grid',
    threeUp ? 'grid-cols-3' : 'grid-cols-2',
    // Up to four figures fit one row from `sm`; five or six need the room of
    // `xl` and sit three to a row in between.
    cols > 4
      ? 'sm:grid-cols-3 xl:[grid-template-columns:repeat(var(--metric-cols),minmax(0,1fr))]'
      : 'sm:[grid-template-columns:repeat(var(--metric-cols),minmax(0,1fr))]',
    // A lone last figure on the two-column phone grid takes the whole row.
    !threeUp &&
      '[&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1',
  );

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-describedby={descId}
      className={cx(
        layout === 'aside' && 'lg:grid lg:grid-cols-[9rem_minmax(0,1fr)] lg:gap-x-5',
        className,
      )}
    >
      <div className={cx(hideLabel ? 'sr-only' : layout === 'aside' ? 'mb-1 lg:mb-0 lg:pt-3' : 'mb-1')}>
        <Heading id={headingId} className="text-label font-semibold leading-5 text-ink">
          {label}
        </Heading>
        {description && (
          <p id={descId} className="mt-0.5 max-w-prose text-meta text-ink-tertiary">
            {description}
          </p>
        )}
      </div>

      <div className="min-w-0">
        <div className={cx('overflow-hidden', bleed && (threeUp ? BLEED_THREE_UP : BLEED)[size])}>
          {linked ? (
            <ul role="list" className={gridClass} style={gridStyle}>
              {items.map((item, i) => (
                <li key={item.key ?? item.label} className={cx(CELL_RULES, SUBGRID)}>
                  {item.href ? (
                    <Link
                      to={item.href}
                      aria-label={item.ariaLabel ?? defaultName(item)}
                      // The name is "label: figure" (it starts with the
                      // visible label, WCAG 2.5.3); the context line under
                      // the figure is its description, not dropped.
                      aria-describedby={item.context && !item.loading ? `${headingId}-c${i}` : undefined}
                      className={cx(
                        'group/metric transition-colors duration-150 ease-out',
                        SUBGRID,
                        'hover:bg-ink/[0.025] focus:outline-none focus-visible:bg-info/[0.06] focus-visible:shadow-[inset_0_0_0_2px_var(--info)]',
                        pad,
                      )}
                    >
                      <MetricBody item={item} size={size} linked contextId={`${headingId}-c${i}`} />
                    </Link>
                  ) : (
                    <div className={cx(SUBGRID, pad)}>
                      <MetricBody item={item} size={size} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <dl className={gridClass} style={gridStyle}>
              {items.map((item) => (
                <div key={item.key ?? item.label} className={cx(CELL_RULES, SUBGRID, pad)}>
                  <MetricBody item={item} size={size} asTerms />
                </div>
              ))}
            </dl>
          )}
        </div>
        {footnote && <p className="mt-2 text-meta text-ink-tertiary">{footnote}</p>}
        {children}
      </div>
    </div>
  );
}

function defaultName(item: MetricItem): string {
  const figure = typeof item.value === 'string' || typeof item.value === 'number' ? String(item.value) : '';
  return [item.label, figure && `${figure}${item.unit ? ` ${item.unit}` : ''}`].filter(Boolean).join(': ');
}

/**
 * Label, figure, context. Rendered as `dt`/`dd` inside a description list and
 * as plain blocks inside a link (where the link's name carries the meaning).
 */
function MetricBody({
  item,
  size,
  asTerms = false,
  linked = false,
  contextId,
}: {
  item: MetricItem;
  size: MetricStripSize;
  asTerms?: boolean;
  linked?: boolean;
  /** Id for the context line, so a drill-down link can use it as its description. */
  contextId?: string;
}) {
  const Term = asTerms ? 'dt' : 'p';
  const Def = asTerms ? 'dd' : 'p';
  const figure =
    typeof item.value === 'string' ? (
      <RollingNumber text={item.value} />
    ) : typeof item.value === 'number' ? (
      <RollingNumber text={item.value.toLocaleString()} />
    ) : (
      item.value
    );

  return (
    <>
      {/* `items-start` + a nudged dot: a wrapped label keeps its dot on the
          first line instead of floating between the two. */}
      <Term className="flex min-w-0 items-start gap-1.5 self-start text-label font-medium leading-5 text-ink-secondary">
        {item.tone && (
          <span aria-hidden="true" className={cx('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', DOT[item.tone])} />
        )}
        {/* Wraps rather than truncates: a clipped label is a figure with
            half a name. */}
        <span className="min-w-0">{item.label}</span>
        {linked && <ChevronIcon />}
      </Term>
      <Def
        className={cx(
          'mt-1 font-semibold tabular-nums',
          FIGURE[size],
          item.attention ? 'text-warning-text' : 'text-ink',
        )}
        title={item.title}
      >
        {item.loading ? (
          <>
            <Skeleton
              width={SKELETON[size].width}
              height={SKELETON[size].height}
              radius={8}
              className="inline-block align-middle"
            />
            <span className="sr-only">Loading</span>
          </>
        ) : item.value === '—' ? (
          // A figure that could not be read is a dash on screen and words
          // to a screen reader, never a silent glyph.
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not available</span>
          </>
        ) : (
          <>
            {figure}
            {item.unit && (
              <span className="ml-1 text-label font-normal tracking-normal text-ink-tertiary">{item.unit}</span>
            )}
          </>
        )}
      </Def>
      {item.context && !item.loading && (
        <Def id={contextId} className="mt-0.5 text-meta text-ink-tertiary">
          {item.context}
        </Def>
      )}
    </>
  );
}

/** Drill-down cue: appears on hover and keyboard focus, never alone carries meaning. */
function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ml-auto mt-[3px] h-3.5 w-3.5 shrink-0 text-ink-tertiary opacity-0 transition-opacity duration-150 ease-out group-hover/metric:opacity-100 group-focus-visible/metric:opacity-100"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
