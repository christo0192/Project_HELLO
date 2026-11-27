import { useId, type Ref } from 'react';
import { R1_BOOK_COPY } from './r1-book-copy';

export interface R1BookErrorItem {
  /** The id of the control the message is about; its button moves focus there. */
  focusId: string;
  /** A copy constant (r1-book-copy.ts), never server text. */
  message: string;
}

interface R1BookErrorSummaryProps {
  items: readonly R1BookErrorItem[];
  /** React 19 ref-as-prop: the page focuses the summary when a check fails. */
  ref?: Ref<HTMLDivElement>;
}

/**
 * The list of what to fix, at the top of a booking form (M035 S07, decision D-S07-M11).
 *
 * The page focuses it (`tabIndex={-1}`) when its own checks fail, which announces it once; it is
 * NOT `role="alert"`, which would announce it a second time. It is a named group, so focusing it
 * reads its title. Each item is a button that moves focus to its control. There are no
 * `href="#id"` links: following one would write the control's id into the address bar.
 * Nothing renders when there is nothing to fix.
 */
export function R1BookErrorSummary({ items, ref }: R1BookErrorSummaryProps) {
  const titleId = useId();
  if (items.length === 0) return null;
  return (
    <div className="r1-book__summary" role="group" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
      <h2 id={titleId}>{R1_BOOK_COPY.errors.summaryTitle}</h2>
      <ul>
        {items.map((item, index) => (
          <li key={`${index}-${item.focusId}`}>
            <button type="button" onClick={() => document.getElementById(item.focusId)?.focus()}>
              {item.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
