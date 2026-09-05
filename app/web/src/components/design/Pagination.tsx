/**
 * Pagination — bounded page navigation for tables and lists.
 *
 * `usePagination` slices any array; `Pagination` renders the range text,
 * a page-size select and previous/next controls inside a `nav` landmark.
 * The range line is `role="status"` so page changes are announced.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from './Button';
import { SelectField } from './Field';
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

export function usePagination<T>(rows: ReadonlyArray<T>, initialSize: PageSize = 10): PaginationState<T> {
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState<PageSize>(initialSize);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Clamp when the data shrinks under the current page (filter, refresh).
  useEffect(() => {
    if (page > pageCount) setPageState(pageCount);
  }, [page, pageCount]);

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
    setPage: (next) => setPageState(Math.min(pageCount, Math.max(1, next))),
    setPageSize: (size) => {
      setPageSizeState(size);
      setPageState(1);
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
  if (total === 0) return null;
  return (
    <nav
      aria-label={`${noun} pagination`}
      className={cx('flex flex-wrap items-center justify-between gap-3 px-1 pt-3', className)}
    >
      <p role="status" className="text-[13px] tabular-nums text-ink-tertiary">
        Showing <span className="font-medium text-ink-secondary">{from}–{to}</span> of{' '}
        <span className="font-medium text-ink-secondary">{total}</span> {noun}
      </p>
      <div className="flex items-center gap-2">
        {!hidePageSize && (
          <label className="flex items-center gap-2 text-xs text-ink-tertiary">
            {/* Visible "Rows", accessible name "Rows per page" — the visible
                text is a prefix of the name (WCAG 2.5.3 label-in-name). */}
            <span>
              Rows<span className="sr-only"> per page</span>
            </span>
            <SelectField
              size="sm"
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value) as PageSize)}
              className="w-[4.75rem]"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </SelectField>
          </label>
        )}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
            <ChevronIcon direction="left" />
          </Button>
          <span className="min-w-[4.5rem] text-center text-[13px] tabular-nums text-ink-secondary" aria-hidden="true">
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
