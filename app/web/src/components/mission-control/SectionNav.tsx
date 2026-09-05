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
 * - Presentation: a segmented control — the selected tab carries a white
 *   pill that glides between tabs (shared `layoutId`, spring, collapses
 *   under reduced motion). The revealed panel rises in via an imperative
 *   `animate()` so the keep-alive tree is never remounted.
 * - Optional controlled selection (`selectedId` + `onSelect`) so the page
 *   can mirror the active section into the URL hash.
 */

import { LayoutGroup, animate } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { EASE_OUT_SOFT, useReducedMotion, useSelectionTransition } from '../../lib/motion';
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
  const reduced = useReducedMotion();
  const pillTransition = useSelectionTransition();

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

  // Panel entrance: rise the newly selected panel in place (no remount).
  const panelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const previousIndex = useRef(activeIndex);
  useEffect(() => {
    if (previousIndex.current === activeIndex) return;
    previousIndex.current = activeIndex;
    const node = panelRefs.current[activeIndex];
    if (!node || reduced) return;
    const controls = animate(
      node,
      { opacity: [0, 1], y: [6, 0] },
      { duration: 0.22, ease: EASE_OUT_SOFT },
    );
    return () => controls.stop();
  }, [activeIndex, reduced]);

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
      <LayoutGroup id={`${baseId}-tabs`}>
        <div
          role="tablist"
          aria-label={ariaLabel}
          className="glass-sunken inline-flex max-w-full items-center gap-0.5 overflow-x-auto p-1"
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
                  'relative h-8 shrink-0 whitespace-nowrap rounded-[10px] px-3.5 text-[13px] font-medium transition-colors duration-200 ease-soft sm:px-4',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-1',
                  selected ? 'text-ink' : 'text-ink-secondary hover:text-ink',
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="section-pill"
                    aria-hidden="true"
                    transition={pillTransition}
                    className="absolute inset-0 rounded-[10px] bg-white shadow-pill"
                  />
                )}
                <span className="relative z-10">{section.label}</span>
              </button>
            );
          })}
        </div>
      </LayoutGroup>

      {sections.map((section, index) => {
        const selected = index === activeIndex;
        const rendered = panels[section.id];
        return (
          <div
            key={section.id}
            ref={(node) => {
              panelRefs.current[index] = node;
            }}
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
