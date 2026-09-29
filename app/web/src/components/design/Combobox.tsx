/**
 * Combobox — a searchable single-choice picker.
 *
 * WHY NOT `<select>`. A native select opens the OPERATING SYSTEM's list: on
 * Windows that is a full-height grey sheet that ignores the design entirely,
 * cannot be searched, and cannot say anything about an option beyond one
 * line of text. A picker over forty Ashby jobs needs search, a second line
 * (when a job opened, which agent a role uses), and a way to show that an
 * option exists but is taken.
 *
 * WHY IT EXPANDS INLINE instead of floating. The pickers live inside
 * `Dialog` and `SlideOver`, whose panels scroll (`overflow-y-auto`) and carry
 * an entrance transform. An absolutely positioned popover is clipped by the
 * first, and the second turns `position: fixed` into "fixed to the panel", so
 * a floating list would be cut off exactly where it is needed most — near
 * the bottom of a dialog on a phone. The list therefore opens IN FLOW,
 * attached to its trigger like one control, and pushes what follows down.
 *
 * THE KEYBOARD CONTRACT (WAI-ARIA APG, "combobox with listbox popup"):
 *   - The trigger is a button (`aria-haspopup="listbox"`, `aria-expanded`).
 *     Enter / Space / ArrowDown open it; focus moves into the search field.
 *   - The search field is the `role="combobox"`: typing filters, ArrowUp /
 *     ArrowDown move the active option (`aria-activedescendant` — options are
 *     never focused), Enter picks it, Escape closes and returns focus to the
 *     trigger. Disabled options are skipped by the arrows.
 *   - ESCAPE BELONGS TO THE LIST FIRST. `useModal` decides Escape on the
 *     document in the capture phase; a listener on the WINDOW in the capture
 *     phase runs before it, so while the list is open this one takes the key
 *     and stops it — the list closes, the dialog around it stays.
 *   - Enter never submits the surrounding form while the list is open.
 *   - Leaving the control (Tab, or a click elsewhere) closes the list.
 *
 * `value` is an opaque string the caller owns. The picker never renders it,
 * so a caller that must keep an id out of the DOM can pass a position.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { ButtonSpinner } from './Button';
import { cx } from './cx';

export interface ComboboxOption {
  /** Opaque key. Never rendered. */
  value: string;
  /** The option's name: searched, shown, and its accessible name. */
  label: string;
  /** A quieter second line — also searched. */
  description?: string;
  /** Listed but not choosable (e.g. a job that is already mapped). */
  disabled?: boolean;
  /** A short tag at the end of the row, e.g. "Mapped". */
  tag?: string;
  /** Options sharing a group are listed together under this heading. */
  group?: string;
}

export interface ComboboxProps {
  /** Id of the trigger button — point the visible `<label htmlFor>` here. */
  id: string;
  /** Id of that visible label; the trigger is named "label + current value". */
  labelId?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  /** Trigger text when nothing is chosen. */
  placeholder: string;
  /** Accessible name and placeholder of the search field, e.g. "Search jobs". */
  searchLabel: string;
  /** Accessible name of the option list, e.g. "Ashby jobs". */
  listLabel: string;
  /** What a no-match search says; receives the query. */
  noMatchText?: (query: string) => string;
  /** Noun for the result count, singular/plural, e.g. ['job', 'jobs']. */
  noun?: [string, string];
  disabled?: boolean;
  /** Shows a spinner in the trigger and keeps it closed. */
  loading?: boolean;
  /** Decorative glyph in the trigger's leading tile. */
  icon?: ReactNode;
  'aria-describedby'?: string;
  /** Reaches the trigger button (e.g. to move focus onto it after a retry). */
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

/** Case- and accent-insensitive match key. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function Combobox({
  id,
  labelId,
  value,
  onChange,
  options,
  placeholder,
  searchLabel,
  listLabel,
  noMatchText = (q) => `Nothing matches “${q}”.`,
  noun = ['option', 'options'],
  disabled = false,
  loading = false,
  icon,
  'aria-describedby': describedBy,
  ref,
  className,
}: ComboboxProps) {
  const uid = useId().replace(/:/g, '');
  const listboxId = `${id}-listbox-${uid}`;
  const searchId = `${id}-search-${uid}`;
  const valueId = `${id}-value-${uid}`;
  const optionId = (index: number) => `${id}-option-${uid}-${index}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // One element, two owners: this component needs the trigger to return
  // focus to it, and the caller may need it too (see `ref`).
  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
    },
    [ref],
  );

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return options;
    return options.filter((o) => fold(`${o.label} ${o.description ?? ''}`).includes(q));
  }, [options, query]);

  const enabledIndexes = useMemo(
    () => filtered.flatMap((o, i) => (o.disabled ? [] : [i])),
    [filtered],
  );

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActive(-1);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openList = useCallback(() => {
    if (disabled || loading) return;
    setOpen(true);
  }, [disabled, loading]);

  // On open: focus the search field and start on the chosen option, or the
  // first one that can be chosen.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const chosen = filtered.findIndex((o) => o.value === value && !o.disabled);
    setActive(chosen >= 0 ? chosen : (enabledIndexes[0] ?? -1));
    // Only on the transition to open; re-running on every filter would yank
    // the active option back while the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Typing re-anchors the active option to the first match.
  useEffect(() => {
    if (!open) return;
    setActive(enabledIndexes[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Keep the active option in view. `scrollIntoView` is absent in jsdom.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = document.getElementById(optionId(active));
    el?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  // Escape must close THIS list and not the modal around it — see header.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Mid-composition (IME), Escape cancels the composition, not the list.
      if (e.isComposing) return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  /**
   * A CLICK outside closes it — on `click`, not `pointerdown`. The list sits
   * in flow, so closing it on the press collapses the space it took and the
   * thing under the pointer moves before the release: the first click on the
   * control below (the Role picker, Cancel) was swallowed. Closing after the
   * click lets that click land where it was aimed.
   *
   * `pressing` covers the blur that a press causes in between: while a press
   * is in progress the search field's blur does not close the list — the
   * click (outside) or nothing (inside) decides.
   */
  const pressing = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (): void => {
      pressing.current = true;
    };
    const onClick = (e: MouseEvent): void => {
      pressing.current = false;
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onUp = (): void => {
      // A press that ends without a click (a drag off, a scrollbar) still ends.
      window.setTimeout(() => {
        pressing.current = false;
      }, 0);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('click', onClick);
    };
  }, [open, close]);

  // The list cannot outlive the control being switched off under it.
  useEffect(() => {
    if ((disabled || loading) && open) close(false);
  }, [disabled, loading, open, close]);

  function pick(index: number) {
    const option = filtered[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  }

  function move(delta: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const at = enabledIndexes.indexOf(active);
    const next =
      at === -1
        ? delta === 1
          ? enabledIndexes[0]
          : enabledIndexes[enabledIndexes.length - 1]
        : enabledIndexes[Math.min(enabledIndexes.length - 1, Math.max(0, at + delta))];
    setActive(next);
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    // An IME composition owns the keyboard until it commits: Enter there
    // confirms the characters, it must not pick an option.
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Enter':
        // Never let Enter fall through to the form's submit.
        e.preventDefault();
        if (active >= 0) pick(active);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  }

  function onTriggerKey(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openList();
    }
  }

  // Groups in order of first appearance; ungrouped options first.
  const sections = useMemo(() => {
    const order: Array<string | null> = [];
    const byGroup = new Map<string | null, number[]>();
    filtered.forEach((o, i) => {
      const key = o.group ?? null;
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        order.push(key);
      }
      byGroup.get(key)!.push(i);
    });
    order.sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
    return order.map((key) => ({ key, indexes: byGroup.get(key)! }));
  }, [filtered]);

  const count = filtered.length;
  const countText = `${count} ${count === 1 ? noun[0] : noun[1]}`;
  const trimmedQuery = query.trim();

  // What the live region says: the count once typing settles; nothing while
  // closed. 400ms is long enough to skip intermediate keystrokes and short
  // enough to answer "did that match?" before the next thought.
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!open) {
      setAnnouncement('');
      return;
    }
    const next = count === 0 ? noMatchText(trimmedQuery) : countText;
    const t = window.setTimeout(() => setAnnouncement(next), 400);
    return () => window.clearTimeout(t);
    // `noMatchText` is usually an inline arrow; its identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, count, countText, trimmedQuery]);

  return (
    <div ref={rootRef} className={cx('relative min-w-0', className)}>
      <button
        ref={setTriggerRef}
        id={id}
        type="button"
        disabled={disabled || loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={labelId ? `${labelId} ${valueId}` : undefined}
        aria-describedby={describedBy}
        aria-busy={loading || undefined}
        onClick={() => (open ? close(true) : openList())}
        // Safari and Firefox-on-Mac do not focus a button on click, so the
        // press would blur the search field and close the list, and the click
        // would then REOPEN it. Holding focus where it is keeps "click the
        // trigger to close" a close.
        onMouseDown={(e) => {
          if (open) e.preventDefault();
        }}
        onKeyDown={onTriggerKey}
        className={cx(
          // 40px, the same height as the form's text inputs: one control
          // vocabulary per form. A selected option with a description grows.
          'group flex min-h-10 w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left',
          'bg-white transition-[background-color,box-shadow] duration-200 ease-soft',
          // Keyboard focus is the design system's 2px ring with offset — the
          // same as every button — so it is never mistaken for "open".
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          'disabled:cursor-not-allowed disabled:bg-ink/[0.04] disabled:text-ink-tertiary',
          // The border lives in ONE branch each: two arbitrary shadows on the
          // same element resolve by stylesheet order, not class order, and the
          // grey one won — the open trigger did not match its blue panel.
          open
            ? 'rounded-t-control shadow-[inset_0_0_0_1.5px_var(--info)]'
            : 'rounded-control shadow-[inset_0_0_0_1px_var(--ink-muted)]',
        )}
      >
        {icon && (
          <span
            aria-hidden="true"
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-200',
              selected ? 'bg-info/[0.12] text-info' : 'bg-ink/[0.05] text-ink-tertiary',
            )}
          >
            {icon}
          </span>
        )}
        <span id={valueId} className="flex min-w-0 flex-1 flex-col">
          {loading ? (
            <span className="text-sm text-ink-tertiary">{placeholder}</span>
          ) : selected ? (
            <>
              {/* Wraps like the option rows: what tells two same-titled
                  choices apart is at the END, where an ellipsis would cut. */}
              <span className="line-clamp-2 break-words text-sm font-medium text-ink">{selected.label}</span>
              {selected.description && (
                <span className="line-clamp-2 break-words text-xs text-ink-tertiary">{selected.description}</span>
              )}
            </>
          ) : (
            <span className="truncate text-sm text-ink-tertiary">{placeholder}</span>
          )}
        </span>
        {loading ? (
          <ButtonSpinner className="h-4 w-4 shrink-0 text-ink-tertiary" />
        ) : (
          <ChevronIcon
            className={cx(
              'h-4 w-4 shrink-0 text-ink-tertiary transition-transform duration-200 ease-soft',
              'group-disabled:opacity-40',
              open && 'rotate-180 text-info',
            )}
          />
        )}
      </button>

      {open && (
        <div
          // A press on anything in the panel that is not the search field —
          // the scrollbar, a group heading, the count, the padding — must not
          // move focus out of the search field (focus would fall to the
          // dialog and the blur would close the list mid-scroll).
          onMouseDown={(e) => {
            if (e.target !== searchRef.current) e.preventDefault();
          }}
          className="combobox-panel -mt-px overflow-hidden rounded-b-control bg-white shadow-[inset_0_0_0_1.5px_var(--info),0_14px_30px_-18px_rgba(15,23,42,0.35)]"
        >
          <div className="flex items-center gap-2 border-b border-ink/[0.08] px-3">
            <SearchIcon className="h-4 w-4 shrink-0 text-ink-tertiary" />
            <input
              ref={searchRef}
              id={searchId}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              aria-label={searchLabel}
              placeholder={searchLabel}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              onBlur={(e) => {
                // A pointer press decides via the document click handler;
                // only a keyboard/programmatic move out closes here.
                if (pressing.current) return;
                if (!rootRef.current?.contains(e.relatedTarget as Node | null)) close(false);
              }}
              className="h-11 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-tertiary focus:outline-none"
            />
            <span className="shrink-0 text-xs tabular-nums text-ink-tertiary" aria-hidden="true">
              {countText}
            </span>
          </div>

          {/* No matches: said OUTSIDE the listbox. A listbox may only own
              options (and groups of them); a bare paragraph inside one is an
              axe `aria-required-children` violation. */}
          {count === 0 && (
            <p className="px-3 py-6 text-center text-sm text-ink-tertiary">
              {noMatchText(query.trim())}
            </p>
          )}

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={listLabel}
            className={cx('max-h-72 overflow-y-auto overscroll-contain', count > 0 && 'p-1.5')}
          >
            {count > 0 &&
              sections.map(({ key, indexes }) => {
                const headingId = key ? `${listboxId}-group-${fold(key).replace(/[^a-z0-9]+/g, '-')}` : undefined;
                const rows = indexes.map((i) => (
                  <ComboboxRow
                    key={filtered[i].value}
                    id={optionId(i)}
                    option={filtered[i]}
                    query={query.trim()}
                    active={i === active}
                    selected={filtered[i].value === value}
                    onHover={() => {
                      if (!filtered[i].disabled) setActive(i);
                    }}
                    onPick={() => pick(i)}
                  />
                ));
                return key ? (
                  // Named by `aria-label`; the visible heading is hidden from
                  // assistive tech so the group name is not read twice.
                  <div key={key} role="group" aria-label={key} className="mt-1 first:mt-0">
                    <p
                      id={headingId}
                      aria-hidden="true"
                      className="px-2.5 pb-1 pt-2.5 text-xs font-medium text-ink-tertiary"
                    >
                      {key}
                    </p>
                    {rows}
                  </div>
                ) : (
                  <div key="__ungrouped" role="presentation">
                    {rows}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* The result count for a screen reader. ALWAYS mounted (a live region
          announces reliably only if it exists before its text changes) and
          DEBOUNCED, so typing "sales" is one announcement, not five. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function ComboboxRow({
  id,
  option,
  query,
  active,
  selected,
  onHover,
  onPick,
}: {
  id: string;
  option: ComboboxOption;
  query: string;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      // Keep focus in the search field: a mousedown would otherwise blur it
      // and close the list before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={cx(
        'flex min-h-11 items-center gap-3 rounded-[10px] px-2.5 py-2 transition-[background-color,box-shadow] duration-150',
        option.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        // The ACTIVE option is the only focus indicator inside the list
        // (focus stays in the search field), so it needs a 3:1 cue — a 2px
        // accent ring — not just a faint tint (WCAG 1.4.11 / 2.4.7).
        active && !option.disabled && 'bg-info/[0.08] shadow-[inset_0_0_0_2px_var(--info)]',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Wraps (to two lines) rather than truncating: on a phone the part
            that tells two same-titled jobs apart is at the END of the name,
            exactly where an ellipsis would cut it. */}
        <span
          className={cx(
            'line-clamp-2 break-words text-sm',
            option.disabled ? 'text-ink-tertiary' : 'text-ink',
            selected && 'font-medium',
          )}
        >
          <Highlight text={option.label} query={query} />
        </span>
        {option.description && (
          <span className="truncate text-xs text-ink-tertiary">{option.description}</span>
        )}
      </span>
      {option.tag && (
        <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
          {option.tag}
        </span>
      )}
      <CheckIcon
        className={cx('h-4 w-4 shrink-0 text-info', selected ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  );
}

/**
 * Marks the matched part of a label. The match runs on the ORIGINAL string
 * with a case-insensitive regex, so offsets are the label's own: lowercasing
 * first can change a string's length ("İ" lowercases to two code units) and
 * mark the wrong span. A match that exists only after folding accents goes
 * unmarked rather than guess.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped, 'iu').exec(text);
  if (!match) return <>{text}</>;
  const at = match.index;
  const end = at + match[0].length;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-info/[0.14] px-px text-ink">{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
