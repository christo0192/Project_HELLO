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
  className?: string;
}

export function Tabs({
  items,
  ariaLabel,
  defaultIndex = 0,
  selectedId,
  onSelect,
  className,
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

  function selectAndFocus(index: number) {
    const next = (index + count) % count;
    setActiveIndex(next);
    document.getElementById(tabId(next))?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        selectAndFocus(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        selectAndFocus(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        selectAndFocus(0);
        break;
      case 'End':
        event.preventDefault();
        selectAndFocus(count - 1);
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
        className="flex max-w-full gap-6 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--c-border)]"
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
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                'h-9 shrink-0 border-b-2 text-sm font-medium',
                'transition-colors duration-hover ease-out',
                // Inset: the tab row scrolls and would clip a ring drawn outside.
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)]',
                selected
                  ? 'border-[var(--c-ink)] text-[var(--c-ink)]'
                  : 'border-transparent text-[var(--c-ink-secondary)] hover:text-[var(--c-ink)]',
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
          className="pt-6"
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
