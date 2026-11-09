/**
 * CandidateShell — the one structural boundary of the candidate experience.
 *
 * Applying `.candidate-scope` here (and only here) is what makes the
 * HR-approved palette both *apply* and *contain*: every `--c-*` token is
 * declared on this element, so descendants resolve them and nothing
 * outside this subtree can. Mission Control, Login, Session Detail and the
 * live-call surfaces are unreachable by construction, not by convention.
 *
 * The shell also carries the shared page rhythm so the three candidate
 * surfaces read as one system rather than three pages that agree.
 *
 * The ground itself is transparent: inside the app the shell sits on the
 * sheet, so it paints nothing of its own.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ElementType, ReactNode, RefObject } from 'react';
import { cx } from '../design/cx';

export const CANDIDATE_SCOPE_CLASS = 'candidate-scope';

export interface CandidateShellProps {
  children: ReactNode;
  /** `main` for the standalone scoped shell, `div` inside the app Layout. */
  as?: ElementType;
  /**
   * `standalone` owns its own page rhythm (the Ashby-scoped route renders
   * outside `<Layout>`). `inset` cancels and re-applies `Layout`'s content
   * padding so the candidate ground reaches the column edges instead of
   * floating inside it — no padding is doubled and Layout is not touched.
   */
  variant?: 'standalone' | 'inset';
  /** Page width. `wide` for list/detail, `narrow` for single-message states. */
  width?: 'wide' | 'narrow';
  className?: string;
}

const RHYTHM: Record<'standalone' | 'inset', string> = {
  standalone: 'mx-auto w-full px-4 py-6 sm:px-6 sm:py-8',
  inset: '-mx-4 -my-6 px-4 py-6 sm:-mx-6 sm:-my-8 sm:px-6 sm:py-8',
};

export function CandidateShell({
  children,
  as,
  variant = 'standalone',
  width = 'wide',
  className,
}: CandidateShellProps) {
  const Component = (as ?? 'div') as ElementType;
  return (
    <Component
      data-candidate-shell={variant}
      className={cx(
        CANDIDATE_SCOPE_CLASS,
        'min-h-full bg-transparent text-[var(--c-ink)]',
        RHYTHM[variant],
        variant === 'standalone' && (width === 'wide' ? 'max-w-6xl' : 'max-w-3xl'),
        className,
      )}
    >
      {children}
    </Component>
  );
}

export interface CandidateHeaderProps {
  /** Small sentence-case label above the title. */
  eyebrow?: string;
  title: string;
  description?: string;
  /**
   * Rendered directly UNDER the name, before the tabs.
   *
   * The facts a manager wants before anything else — which role, how long the
   * call was — belong next to who the person is, not in a card further down
   * the page. Kept a slot rather than typed props so the header stays a
   * layout component.
   */
  meta?: ReactNode;
  actions?: ReactNode;
  /**
   * Rendered under the actions, top right (the candidate page's headline
   * score). Below `sm` the header is one column and it stacks under them.
   */
  aside?: ReactNode;
  /** Rule under the header — used by the standalone scoped shell. */
  divided?: boolean;
  /** One line for the name, the email and the facts: the Review tab needs the height for its panes. */
  compact?: boolean;
  /**
   * A compact header's place for the Phone screening tab's rating summary, handed over once it exists. A
   * slot, so this stays a layout component and the figures stay with the panel that gates them. Empty, it
   * takes no room. A host that does not ask gets the plain header.
   */
  onRatingsSlot?: (place: HTMLElement | null) => void;
}

export type RatingsFit = 'row' | 'line';

/**
 * The room the summary needs beside the name: three columns of a name, pips and a figure, after the
 * Provisional words. Measured on a real page: 607px with no email and 534px at 1366 both hold it, and the
 * 392px left beside an email does not.
 */
const RATINGS_ROW_MIN_PX = 500;
/** `sm:gap-x-4`: the gaps either side of the summary. */
const HEADER_GAP_PX = 16;

/** Whether the summary fits in the name row, by the room left there, whatever took the rest. */
export function ratingsFit(roomPx: number): RatingsFit {
  return roomPx >= RATINGS_ROW_MIN_PX ? 'row' : 'line';
}

/**
 * Measures the room beside the name, so a long name behaves as an email does. It reads the who block at
 * its natural width, because that is what the room depends on, and its box is stretched on the other
 * layout. Restored in the same task, so nothing is painted. Before paint, so it is right on first paint.
 */
function useRatingsFit(
  enabled: boolean,
  rowRef: RefObject<HTMLDivElement | null>,
  whoRef: RefObject<HTMLDivElement | null>,
  actionsRef: RefObject<HTMLDivElement | null>,
): RatingsFit {
  const [fit, setFit] = useState<RatingsFit>('line');
  const measure = useCallback(() => {
    const row = rowRef.current;
    const who = whoRef.current;
    if (!row || !who) return;
    const width = who.style.width;
    who.style.width = 'max-content';
    const whoWidth = who.getBoundingClientRect().width;
    who.style.width = width;
    const actionsWidth = actionsRef.current?.getBoundingClientRect().width ?? 0;
    setFit(ratingsFit(row.clientWidth - whoWidth - actionsWidth - 2 * HEADER_GAP_PX));
  }, [rowRef, whoRef, actionsRef]);

  // Every commit: the chips and the actions change with the page's own state.
  useLayoutEffect(() => {
    if (enabled) measure();
  });

  useLayoutEffect(() => {
    if (!enabled) return;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (rowRef.current) observer?.observe(rowRef.current);
    if (actionsRef.current) observer?.observe(actionsRef.current);
    let live = true;
    // A name's width changes when its font arrives, and on the stretched layout no box says so.
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [enabled, measure, rowRef, actionsRef]);

  return fit;
}

/**
 * Candidate page header. Additive rather than a change to the shared
 * `design/PageHeader`, which eight out-of-scope pages render and which
 * paints its eyebrow with the IK brand scale.
 */
export function CandidateHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  aside,
  divided = false,
  compact = false,
  onRatingsSlot,
}: CandidateHeaderProps) {
  const withRatings = compact && onRatingsSlot !== undefined;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const whoRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const fit = useRatingsFit(withRatings, rowRef, whoRef, actionsRef);
  const ownLine = withRatings && fit === 'line';

  return (
    <div
      ref={rowRef}
      data-ratings-fit={withRatings ? fit : undefined}
      className={cx(
        withRatings
          ? cx(
              // A grid, so nothing can run over Export report: each has its own track.
              'group/header grid grid-cols-1 gap-y-3 sm:items-start sm:gap-x-4 sm:gap-y-0',
              ownLine ? 'sm:grid-cols-[minmax(0,1fr)_auto]' : 'sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto]',
            )
          : 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        divided && 'border-b border-[var(--c-border)] pb-5',
      )}
    >
      <div ref={whoRef} data-header-who="" className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-label font-medium text-[var(--c-ink-secondary)]">
            {eyebrow}
          </p>
        )}
        {/* Wraps, never truncates. A name cut to "Rohan Deshpa…" or a page
            description cut mid-word ("…through screen…") was one of the
            review's tells; `break-words` keeps a long unbroken name inside
            the column at 390px instead. */}
        <h1 className={cx('break-words text-title text-[var(--c-ink)]', compact && 'inline')}>{title}</h1>
        {description && (
          <p
            className={cx(
              'max-w-[70ch] text-pretty break-words text-[var(--c-ink-secondary)]',
              compact ? 'ml-3 inline text-label' : 'mt-1 text-sm',
            )}
          >
            {description}
          </p>
        )}
        {meta && <div className={compact ? 'ml-3 inline-block' : 'mt-3'}>{meta}</div>}
      </div>
      {/* In the reading order after the name whichever way it sits, so a change of fit moves no focus.
          Below the actions on a phone, and on its own line under them when the row has no room. */}
      {withRatings && (
        <div
          ref={onRatingsSlot}
          data-header-ratings=""
          className={cx('order-last min-w-0 empty:hidden sm:order-none', ownLine ? 'sm:col-span-2 sm:row-start-2' : 'sm:self-center')}
        />
      )}
      {aside ? (
        <div ref={actionsRef} data-header-actions="" className="flex shrink-0 flex-col gap-2 sm:items-end sm:pt-1">
          {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
          {aside}
        </div>
      ) : (
        actions && (
          <div
            ref={actionsRef}
            data-header-actions=""
            className={cx(
              'flex shrink-0 flex-wrap items-center gap-2 sm:pt-1',
              // Named tracks, because an empty place is out of the grid, and these would land in its track
              // and stretch: the room measured would then change with the layout it decides. On its own
              // line the summary sits straight under them, and with no summary the row is as it always was.
              withRatings && (ownLine ? 'sm:col-start-2 sm:row-start-1 sm:group-has-[[data-header-ratings]:not(:empty)]/header:pt-0' : 'sm:col-start-3'),
            )}
          >
            {actions}
          </div>
        )
      )}
    </div>
  );
}
