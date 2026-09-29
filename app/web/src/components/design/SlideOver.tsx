/**
 * SlideOver — a right-edge modal drawer.
 *
 * The behaviour here is NOT new. It is `PhoneSlotDialog`'s modal contract
 * lifted into the design system, because that component paid for every rule
 * in production bugs and a second hand-rolled modal would pay for them again.
 * `PhoneSlotDialog` is deliberately NOT refactored onto this: it is a
 * candidate-facing dialog with its own suite, and rewriting it to prove a
 * shared abstraction is risk with no user on the other end.
 *
 * The contract itself — focus on open, focus RETURN by caller-owned ref, the
 * real Tab trap, body scroll lock, capture-phase Escape honouring `busy` —
 * lives in `useModal`, shared with `Dialog`, and its header says why each
 * rule exists. What stays here is the drawer's own markup, and one rule that
 * belongs to markup rather than behaviour:
 *
 *   - `style={{ margin: 0 }}` INLINE. With no portal the overlay is a plain
 *     child of whatever stack renders it, and a `space-y-*` parent's sibling
 *     selector (specificity 0,3,0) outranks any `m-0` utility. That margin
 *     shrinks a `top:0; bottom:0` box and shifts it down, leaving the app
 *     header un-dimmed and still clickable behind an `aria-modal` dialog.
 */

import type { ReactNode } from 'react';
import { cx } from './cx';
import { useModal } from './useModal';

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog, rendered as its heading. */
  title: string;
  /** Optional line under the title; also the dialog's accessible description. */
  description?: string;
  /** Namespace for the generated `id`s. Must be unique on the page. */
  idPrefix: string;
  /**
   * The control that opened the drawer. Focus returns here on close, and it is
   * the CALLER that owns it — see `useModal` for why
   * `document.activeElement` is not good enough.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * While true, Escape and the backdrop refuse to close. For a save in flight.
   * Tab is still trapped but never swallowed — see `useModal`'s handler.
   */
  busy?: boolean;
  children: ReactNode;
}

export function SlideOver({
  open,
  onClose,
  title,
  description,
  idPrefix,
  returnFocusRef,
  busy = false,
  children,
}: SlideOverProps) {
  const panelRef = useModal({ open, onClose, returnFocusRef, busy });
  const titleId = `${idPrefix}-slideover-title`;
  const descId = `${idPrefix}-slideover-desc`;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ margin: 0 }}>
      {/* Backdrop. A plain div, not a button: a click-focusable control inside
          `aria-hidden` is an axe "needs review" and a nameless button one edit
          away from a violation. Esc and Close are the accessible exits. */}
      <div
        aria-hidden="true"
        onClick={() => {
          if (!busy) onClose();
        }}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          // `glass-modal`, not `glass`: see its note in index.css — the
          // translucent panel read grey over the dimmed page and failed
          // small-text contrast.
          'slide-over-panel glass-modal relative z-10 flex h-full w-full max-w-2xl flex-col',
          'overflow-y-auto p-5 outline-none sm:p-6',
        )}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0 pt-1">
            {/* Explicit type, not `text-heading` — that class was never
                defined, so the drawer's title rendered as plain body text. */}
            <h2
              id={titleId}
              className="text-[17px] font-semibold leading-6 tracking-[-0.01em] text-ink"
            >
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 max-w-prose text-[13px] leading-5 text-ink-secondary">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            // `disabled` is correct here and `aria-disabled` is not: this is
            // the drawer's only visible exit, and a busy drawer that still
            // LOOKS closable is worse than one that plainly is not. Escape and
            // the backdrop are refused on the same condition.
            disabled={busy}
            // An icon, so the NAME is spelled out: "Close" is what a screen
            // reader says and what every caller and test looks it up by.
            aria-label="Close"
            className="-mr-1.5 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-tertiary transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden="true"
              className="h-[18px] w-[18px]"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
