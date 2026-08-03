/**
 * Mission Control internal section navigation (WAI-ARIA tabs, 1.2).
 *
 * - Roving tabindex + Arrow/Home/End keyboard navigation (focus AND
 *   selection move together).
 * - LAZY keep-alive: a section renders its content only on first
 *   activation (unvisited sections never fetch data) and the rendered
 *   tree is CACHED, so switching away and back never re-runs render()
 *   and live panel state survives.
 * - Unvisited panels exist as hidden placeholder tabpanels so every
 *   `aria-controls` target resolves in the DOM (axe-safe) without
 *   triggering their data loads.
 * - Horizontal scroll on narrow viewports (mobile-safe).
 */

import { useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../design/cx';

export interface MissionSectionItem {
  /** Stable id used to derive DOM ids and keep-alive keys. */
  id: string;
  label: string;
  /** Called once, on first activation. */
  render: () => ReactNode;
}

export interface MissionControlSectionsProps {
  sections: MissionSectionItem[];
  /** Accessible name for the tablist. */
  ariaLabel: string;
  defaultId?: string;
  className?: string;
}

export function MissionControlSections({
  sections,
  ariaLabel,
  defaultId,
  className,
}: MissionControlSectionsProps) {
  const rawId = useId();
  const baseId = rawId.replace(/:/g, '-');
  const count = sections.length;

  const [activeIndex, setActiveIndex] = useState(() => {
    if (count === 0) return 0;
    const idx = sections.findIndex((s) => s.id === defaultId);
    return idx >= 0 ? idx : 0;
  });
  const [panels, setPanels] = useState<Record<string, ReactNode>>(() => {
    if (count === 0) return {};
    const idx = sections.findIndex((s) => s.id === defaultId);
    const first = idx >= 0 ? idx : 0;
    return { [sections[first].id]: sections[first].render() };
  });

  if (count === 0) return null;

  const tabId = (index: number) => `${baseId}-tab-${sections[index].id}`;
  const panelId = (index: number) => `${baseId}-panel-${sections[index].id}`;

  function activate(index: number) {
    const next = (index + count) % count;
    setActiveIndex(next);
    setPanels((prev) =>
      prev[sections[next].id]
        ? prev
        : { ...prev, [sections[next].id]: sections[next].render() },
    );
  }

  function selectAndFocus(index: number) {
    const next = (index + count) % count;
    activate(next);
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
        {sections.map((section, index) => {
          const selected = index === activeIndex;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              id={tabId(index)}
              aria-selected={selected}
              aria-controls={panelId(index)}
              tabIndex={selected ? 0 : -1}
              onClick={() => activate(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                'shrink-0 whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors sm:px-4',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                selected
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-ink-secondary hover:bg-surface-tertiary hover:text-ink',
              )}
            >
              {section.label}
            </button>
          );
        })}
      </div>

      {sections.map((section, index) => {
        const selected = index === activeIndex;
        const rendered = panels[section.id];
        return (
          <div
            key={section.id}
            role="tabpanel"
            id={panelId(index)}
            aria-labelledby={tabId(index)}
            hidden={!selected}
            className="pt-6"
          >
            {rendered ?? null}
          </div>
        );
      })}
    </div>
  );
}
