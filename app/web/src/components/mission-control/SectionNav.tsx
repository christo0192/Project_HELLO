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
 * - Presentation: printed tabs on a rule. The selected tab carries a 2px ink
 *   underline, shown statically. A panel appears at once: nothing rises in.
 * - Optional controlled selection (`selectedId` + `onSelect`) so the page
 *   can mirror the active section into the URL hash.
 */

import { useEffect, useId, useState } from 'react';
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
  /** Controlled selection — when set, `onSelect` must update it. */
  selectedId?: string;
  onSelect?: (id: string) => void;
  className?: string;
}

export function MissionControlSections({
  sections,
  ariaLabel,
  defaultId,
  selectedId,
  onSelect,
  className,
}: MissionControlSectionsProps) {
  const rawId = useId();
  const baseId = rawId.replace(/:/g, '-');
  const count = sections.length;

  const indexOf = (id: string | undefined) => {
    if (count === 0) return 0;
    const idx = sections.findIndex((s) => s.id === id);
    return idx >= 0 ? idx : 0;
  };

  const [internalIndex, setInternalIndex] = useState(() => indexOf(defaultId));
  const activeIndex = selectedId != null ? indexOf(selectedId) : internalIndex;

  const [panels, setPanels] = useState<Record<string, ReactNode>>(() => {
    if (count === 0) return {};
    const first = indexOf(selectedId ?? defaultId);
    return { [sections[first].id]: sections[first].render() };
  });

  // Controlled selection may land on a never-visited section (e.g. a deep
  // link) — mount it lazily, exactly like a click would.
  useEffect(() => {
    if (count === 0) return;
    const section = sections[activeIndex];
    setPanels((prev) => (prev[section.id] ? prev : { ...prev, [section.id]: section.render() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  if (count === 0) return null;

  const tabId = (index: number) => `${baseId}-tab-${sections[index].id}`;
  const panelId = (index: number) => `${baseId}-panel-${sections[index].id}`;

  function activate(index: number) {
    const next = (index + count) % count;
    setPanels((prev) =>
      prev[sections[next].id]
        ? prev
        : { ...prev, [sections[next].id]: sections[next].render() },
    );
    if (selectedId == null) setInternalIndex(next);
    onSelect?.(sections[next].id);
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
        className="flex max-w-full gap-6 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--line-strong)]"
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
                // The row's rule is an inset line, not a border the tabs overlap:
                // a tab past the box would reserve a scrollbar (see talent/Tabs).
                'h-9 shrink-0 whitespace-nowrap border-b-2 text-sm font-medium transition-colors duration-hover ease-out',
                // Inset: the tab row scrolls and would clip a ring drawn outside.
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-info',
                selected ? 'border-[var(--ink)] text-ink' : 'border-transparent text-ink-secondary hover:text-ink',
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
