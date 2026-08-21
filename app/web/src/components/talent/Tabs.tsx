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
  className?: string;
}

export function Tabs({
  items,
  ariaLabel,
  defaultIndex = 0,
  className,
}: TabsProps) {
  const rawId = useId();
  const baseId = rawId.replace(/:/g, '-');
  const count = items.length;
  const [activeIndex, setActiveIndex] = useState(
    Math.min(Math.max(defaultIndex, 0), count - 1),
  );

  if (count === 0) return null;

  const tabId = (index: number) => `${baseId}-tab-${items[index].id}`;
  const panelId = (index: number) => `${baseId}-panel-${items[index].id}`;

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
        className="flex gap-1 overflow-x-auto border-b border-line"
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
                // 44px minimum touch target (WCAG 2.5.8).
                'shrink-0 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors sm:px-4',
                'min-h-11',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                selected
                  ? 'border-[var(--c-accent)] text-[var(--c-accent)]'
                  : 'border-transparent text-ink-secondary hover:bg-surface-tertiary hover:text-ink',
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
