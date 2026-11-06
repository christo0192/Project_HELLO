/**
 * Words cited as evidence: the highlighter wash, in a real `<mark>`.
 *
 * The wash means this and nothing else, and it is never the only marker: a cited turn also carries a
 * numbered box, a tick on the strip and a quote button. The cued quote adds an ink underline.
 */

import type { ReactNode } from 'react';
import { cx } from '../design/cx';

export function EvidenceMark({
  active = false,
  numbers,
  children,
}: {
  active?: boolean;
  /** The evidence numbers these words carry, for a test or a stylesheet to find. */
  numbers?: readonly number[];
  children: ReactNode;
}) {
  return (
    <mark
      data-evidence-mark={numbers?.join(' ')}
      className={cx(
        'rounded-evidence bg-wash text-ink [box-decoration-break:clone]',
        active && 'shadow-[inset_0_-2px_0_var(--ink)]',
      )}
    >
      {children}
    </mark>
  );
}
