/**
 * Accessible keyboard tabs (ARIA tabs pattern, WAI-ARIA 1.2).
 *
 * - `role="tablist"` + `role="tab"` buttons with `aria-selected` and
 *   `aria-controls`.
 * - Roving tabindex: only the selected tab is in the tab order.
 * - Arrow keys move selection AND focus (Left/Right wrap, Home/End jump).
 * - Inactive panels keep `hidden` (removed from the accessibility tree) but
 *   stay mounted so panel state (live panels, loaded transcripts) survives
 *   tab switches.
 *
 * Native buttons only — no div-based click targets.
 *
 * Presentation: printed tabs on a rule. The selected tab carries a 2px ink
 * underline and full ink, shown statically; nothing slides.
 *
 * The rule is an inset line on the row, not a border the tabs overlap with a
 * negative margin: this row scrolls sideways, so `overflow-x` makes the other
 * axis scroll too, and a tab 1px past the box reserves a classic Windows
 * scrollbar. Forced colours drop the line, so index.css gives the row a border.
 */

import { useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../design/cx';

export interface TabItem {
  /** Stable id used to derive DOM ids. */
  id: string;
  label: string;
  panel: ReactNode;
  /** Cannot be selected, and the arrow keys step over it. The page says why. */
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  /** Accessible name for the tablist (announced by screen readers). */
  ariaLabel: string;
  defaultIndex?: number;
  /**
   * Controlled selection, by item id. Lets the host select a tab from
   * elsewhere on the page — the candidate header's "Review screening" opens
   * the Review tab — and remember it in the URL. Omit for the ordinary
   * uncontrolled tabs; an id that matches no item falls back to that state.
   */
  selectedId?: string;
  /** Called with the item id whenever the user selects a tab. */
  onSelect?: (id: string) => void;
  /**
   * Called when a tab is pressed, and not when the arrow keys move to one. The arrows keep focus on the
   * tabs, so this is the only moment a host may take focus into the panel.
   */
  onTabClick?: (id: string) => void;
  className?: string;
  /** Added to the row of tabs, for a host that insets its content. */
  listClassName?: string;
  /**
   * Replaces the panels' spacing, for tabs inside a tighter box than a page. Keep `display` out of it: a
   * class like `flex` beats the `hidden` attribute, and a closed panel would stay on screen.
   */
  panelClassName?: string;
}

export function Tabs({
  items,
  ariaLabel,
  defaultIndex = 0,
  selectedId,
  onSelect,
  onTabClick,
  className,
  listClassName,
  panelClassName = 'pt-6',
}: TabsProps) {
  const rawId = useId();
  const baseId = rawId.replace(/:/g, '-');
  const count = items.length;
  const [uncontrolledIndex, setUncontrolledIndex] = useState(
    Math.min(Math.max(defaultIndex, 0), count - 1),
  );
  const controlledIndex =
    selectedId === undefined ? -1 : items.findIndex((item) => item.id === selectedId);
  const activeIndex = controlledIndex >= 0 ? controlledIndex : uncontrolledIndex;

  if (count === 0) return null;

  const tabId = (index: number) => `${baseId}-tab-${items[index].id}`;
  const panelId = (index: number) => `${baseId}-panel-${items[index].id}`;

  function setActiveIndex(index: number) {
    setUncontrolledIndex(index);
    onSelect?.(items[index].id);
  }

  /** The first enabled tab after `from`, going `direction`, wrapping. */
  function nextEnabled(from: number, direction: 1 | -1): number {
    for (let step = 1; step <= count; step += 1) {
      const index = (from + direction * step + count * 2) % count;
      if (!items[index].disabled) return index;
    }
    return from;
  }

  function selectAndFocus(index: number) {
    const next = (index + count) % count;
    setActiveIndex(next);
    document.getElementById(tabId(next))?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        selectAndFocus(nextEnabled(index, 1));
        break;
      case 'ArrowLeft':
        event.preventDefault();
        selectAndFocus(nextEnabled(index, -1));
        break;
      case 'Home':
        event.preventDefault();
        selectAndFocus(nextEnabled(-1, 1));
        break;
      case 'End':
        event.preventDefault();
        selectAndFocus(nextEnabled(count, -1));
        break;
      default:
        break;
    }
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cx('flex max-w-full gap-6 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--c-border)]', listClassName)}
      >
        {items.map((item, index) => {
          const selected = index === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={tabId(index)}
              aria-selected={selected}
              aria-controls={panelId(index)}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => {
                setActiveIndex(index);
                onTabClick?.(item.id);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                'h-9 shrink-0 border-b-2 text-sm font-medium',
                'transition-colors duration-hover ease-out',
                // Inset: the tab row scrolls and would clip a ring drawn outside.
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)]',
                selected
                  ? 'border-[var(--c-ink)] text-[var(--c-ink)]'
                  : 'border-transparent text-[var(--c-ink-secondary)] enabled:hover:text-[var(--c-ink)]',
                'disabled:cursor-not-allowed disabled:text-[var(--c-ink-muted)]',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {items.map((item, index) => (
        <div
          key={item.id}
          role="tabpanel"
          id={panelId(index)}
          aria-labelledby={tabId(index)}
          hidden={index !== activeIndex}
          className={panelClassName}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
