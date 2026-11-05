/**
 * Pagination — bounded page navigation for tables and lists.
 *
 * `usePagination` slices any array; `Pagination` renders the range text,
 * a page-size picker and previous/next controls inside a `nav` landmark.
 * The range line is `role="status"` so page changes are announced.
 *
 * A list whose place must survive a trip to a record and back hands the page
 * and size to the URL through `control` (see `PaginationControl`).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Combobox } from './Combobox';
import { cx } from './cx';

export const PAGE_SIZES = [10, 25, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface PaginationState<T> {
  page: number;
  pageSize: PageSize;
  pageCount: number;
  total: number;
  /** 1-based inclusive range of the visible rows (0–0 when empty). */
  from: number;
  to: number;
  items: T[];
  setPage: (page: number) => void;
  setPageSize: (size: PageSize) => void;
}

/** Page and size held by the caller, usually the URL. */
export interface PaginationControl {
  page: number;
  pageSize: PageSize;
  onChange: (next: { page: number; pageSize: PageSize }) => void;
}

export function usePagination<T>(
  rows: ReadonlyArray<T>,
  initialSize: PageSize = 10,
  /** Changes here (a filter key) return the user to page 1. */
  resetKey?: string,
  control?: PaginationControl,
): PaginationState<T> {
  const [ownPage, setOwnPage] = useState(1);
  const [ownSize, setOwnSize] = useState<PageSize>(initialSize);
  const page = control ? control.page : ownPage;
  const pageSize = control ? control.pageSize : ownSize;
  const setPageState = (next: number) => {
    if (control) control.onChange({ page: next, pageSize });
    else setOwnPage(next);
  };
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const lastKey = useRef(resetKey);
  useEffect(() => {
    if (lastKey.current !== resetKey) {
      lastKey.current = resetKey;
      // A controlled page resets with the URL that changed the key.
      if (!control) setOwnPage(1);
    }
  }, [resetKey, control]);

  // Clamp when the data shrinks under the current page (filter, refresh).
  // Not a controlled page: rows that are still loading are not a reason to
  // rewrite the URL, and `safePage` below already bounds what is shown.
  useEffect(() => {
    if (!control && page > pageCount) setOwnPage(pageCount);
  }, [control, page, pageCount]);

  const safePage = Math.min(page, pageCount);
  const items = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [rows, safePage, pageSize],
  );
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = total === 0 ? 0 : Math.min(total, safePage * pageSize);

  return {
    page: safePage,
    pageSize,
    pageCount,
    total,
    from,
    to,
    items,
    // No upper clamp here: `pageCount` in this closure can be a render old
    // (paging to a row that the same update adds). `safePage` and the clamp
    // effect above bound it against the rows actually rendered.
    setPage: (next) => setPageState(Math.max(1, next)),
    setPageSize: (size) => {
      if (control) {
        control.onChange({ page: 1, pageSize: size });
      } else {
        setOwnSize(size);
        setOwnPage(1);
      }
    },
  };
}

export interface PaginationProps {
  state: Pick<PaginationState<unknown>, 'page' | 'pageSize' | 'pageCount' | 'total' | 'from' | 'to' | 'setPage' | 'setPageSize'>;
  /** Noun for the range line, e.g. "sessions". */
  noun: string;
  /** Hide the page-size select (fixed server pages). */
  hidePageSize?: boolean;
  className?: string;
}

export function Pagination({ state, noun, hidePageSize = false, className }: PaginationProps) {
  const { page, pageSize, pageCount, total, from, to, setPage, setPageSize } = state;
  const sizeId = `page-size-${useId().replace(/:/g, '-')}`;
  if (total === 0) return null;
  return (
    <nav
      aria-label={`${noun} pagination`}
      className={cx('flex flex-wrap items-center justify-between gap-3 px-1 pt-3', className)}
    >
      <p role="status" className="text-label tabular-nums text-ink-tertiary">
        Showing <span className="font-medium text-ink-secondary">{from}–{to}</span> of{' '}
        <span className="font-medium text-ink-secondary">{total}</span> {noun}
      </p>
      <div className="flex items-center gap-2">
        {!hidePageSize && (
          <div className="flex items-center gap-2 text-xs text-ink-tertiary">
            {/* Visible "Rows", accessible name "Rows per page": the visible
                text is a prefix of the name (WCAG 2.5.3 label-in-name). */}
            <span id={`-label`}>
              Rows<span className="sr-only"> per page</span>
            </span>
            {/* Upward: the pager is the foot of the page. */}
            <Combobox
              id={sizeId}
              labelId={`-label`}
              size="sm"
              searchable={false}
              floating="up"
              value={String(pageSize)}
              onChange={(next) => setPageSize(Number(next) as PageSize)}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
              placeholder={String(pageSize)}
              searchLabel="Rows per page"
              listLabel="Rows per page"
              className="w-[4.75rem]"
            />
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
            <ChevronIcon direction="left" />
          </Button>
          <span className="min-w-[4.5rem] text-center text-label tabular-nums text-ink-secondary" aria-hidden="true">
            {page} / {pageCount}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setPage(page + 1)} disabled={page >= pageCount} aria-label="Next page">
            <ChevronIcon direction="right" />
          </Button>
        </div>
      </div>
    </nav>
  );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  );
}
