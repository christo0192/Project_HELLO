/**
 * One appointment, as a focusable control shared by both views.
 *
 * ── THE ACCESSIBLE NAME CARRIES EVERYTHING ────────────────────────────
 * Visually this is compact: a time, a name, a status. Those facts are legible
 * together because they sit in a cell (or under a day heading) that already
 * says which day and which hour it is.
 *
 * None of that context survives being read aloud out of order, so the
 * control's accessible name restates it in full — who, when in IST, the
 * appointment status and the engagement state — via `aria-label`. The visible
 * text is then marked `aria-hidden` so the same facts are not announced
 * twice, once abbreviated and once in full.
 *
 * ── TWO SHAPES, ONE CONTROL ───────────────────────────────────────────
 * `cell` is the week grid's chip: stacked (time, name, status) so it reads in
 * a day column only ~110px wide without clipping anything. The time shows the
 * start alone until the column is wide enough for the whole range (`xl`);
 * the full range is always in the accessible name and in the detail.
 * `row` is the queue's line: time, name, status across one row, separated
 * from its neighbours by hairlines rather than floating as a card of its own.
 *
 * The NAME leads, not the ATS reference: a recruiter recognises "Meera Iyer",
 * and a reference cut to fit ("ASHBY-10428 — Me…") is neither. The reference
 * is shown beside the name where there is room (the queue) and is always in
 * the accessible name and the detail heading.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ───────────────────────────────────
 * The status badge always renders its own word. The selected state is carried
 * by `aria-pressed` and by a ring, not by a fill an operator has to compare
 * against its neighbours.
 *
 * ── SELECTED AND FOCUSED ARE TWO DIFFERENT LOOKS ──────────────────────
 * Both used to be a 2px #4E6BA6 ring, so a keyboard operator could not tell
 * the chip they were ON from the chip that was OPEN. Now:
 *   selected — the accent tint fill and a 1px accent ring hugging the edge
 *              (#4E6BA6 on white is ~5.3:1, over the 3:1 a state boundary
 *              needs). The tint alone is too faint to carry the state; the
 *              ring does, and the fill is what survives the focus ring.
 *   focused  — a 2px accent ring standing 2px OFF the chip on a white gap
 *              (`ring-offset-2`), the same detached ring every `Button` in
 *              the app wears. A focused, selected chip therefore shows the
 *              tint AND the detached ring, and reads as both.
 *

 * ── TOUCH TARGET ──────────────────────────────────────────────────────
 * `min-h-[44px]` keeps the control at the 44×44 CSS-pixel floor on touch
 * (WCAG 2.5.5), which a text-sized chip would otherwise miss by half. The
 * phone-calendar a11y gate looks for that literal class.
 */

import type { PhoneCalendarAppointment } from '../../types';
import { StatusBadge, cx } from '../design';
import { formatIstDayLabel, formatIstTime, istDateOf } from '../../lib/ist-datetime';
import {
  appointmentAccessibleName,
  appointmentStatusTerm,
  candidateDisplay,
} from './phoneVocabulary';

export interface PhoneAppointmentButtonProps {
  appointment: PhoneCalendarAppointment;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Show the IST day too — for lists where the row is not already a day. */
  showDate?: boolean;
  /** `cell` for the week grid (stacked), `row` for the queue (one line). */
  layout?: 'cell' | 'row';
}

/** `14:30` from `14:30 IST`: the zone is stated once, by the page and the grid corner. */
function clock(iso: string): string {
  return formatIstTime(iso).replace(/ IST$/, '');
}

export function PhoneAppointmentButton({
  appointment,
  selected,
  onSelect,
  showDate = false,
  layout = 'cell',
}: PhoneAppointmentButtonProps) {
  const term = appointmentStatusTerm(appointment.status);
  const date = istDateOf(appointment.starts_at);
  const who = candidateDisplay(appointment.candidate);
  const start = clock(appointment.starts_at);
  const end = clock(appointment.ends_at);
  const day = showDate && date ? `${formatIstDayLabel(date)} · ` : '';
  /*
    A cancelled or superseded slot will never dial. It stays on the calendar
    (hiding it would hide history), but it steps back: no lift, quieter name,
    so the calls that will happen are what the eye lands on. The badge still
    says which it is in words.
  */
  const withdrawn = appointment.status === 'cancelled' || appointment.status === 'superseded';

  const shared = cx(
    'w-full min-h-[44px] text-left',
    'transition-[box-shadow,background-color] duration-200 ease-soft',
    // Detached from the chip by a white gap, so focus never looks like the
    // hugging 1px ring that means "selected" (see the header comment).
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
  );
  /** Tint + a 1px ring on the edge: the "this one is open" look. */
  const selectedLook = 'bg-info-soft ring-1 ring-info';

  if (layout === 'row') {
    return (
      <button
        type="button"
        data-appointment-id={appointment.id}
        onClick={() => onSelect(appointment.id)}
        aria-pressed={selected}
        aria-label={appointmentAccessibleName(appointment)}
        className={cx(
          shared,
          'flex items-center gap-3 rounded-[10px] px-3 py-2',
          selected ? selectedLook : 'hover:bg-white/70',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'shrink-0 text-label font-medium tabular-nums text-ink-secondary',
            !showDate && 'w-[5.75rem]',
          )}
        >
          {day}
          {start}–{end}
        </span>
        <span aria-hidden="true" className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium text-ink">{who.primary}</span>
          {who.reference && (
            <span className="block text-meta tabular-nums text-ink-tertiary">{who.reference}</span>
          )}
        </span>
        <span aria-hidden="true" className="shrink-0">
          <StatusBadge tone={term.tone}>{term.label}</StatusBadge>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-appointment-id={appointment.id}
      onClick={() => onSelect(appointment.id)}
      aria-pressed={selected}
      aria-label={appointmentAccessibleName(appointment)}
      className={cx(
        shared,
        'flex flex-col items-start gap-1 rounded-[10px] px-2 py-1.5',
        // One fill per state, never two fill classes on one element: which of
        // two `bg-*` utilities wins is decided by stylesheet order, not by the
        // order they are written here.
        selected
          ? selectedLook
          : withdrawn
            ? 'bg-white/55 shadow-[inset_0_0_0_1px_var(--glass-ring)] hover:bg-white hover:shadow-card-hover'
            : 'bg-white shadow-pill hover:shadow-card-hover',
      )}
    >
      <span aria-hidden="true" className="text-meta font-medium tabular-nums text-ink-tertiary">
        {day}
        {start}
        <span className="hidden xl:inline">–{end}</span>
      </span>
      <span
        aria-hidden="true"
        className={cx(
          'w-full text-meta break-words',
          withdrawn ? 'font-medium text-ink-secondary' : 'font-semibold text-ink',
        )}
      >
        {who.primary}
      </span>
      {/* A tighter pill than the default badge, so the longest status word
          ("Superseded") still sits inside a ~100px day column at 1280px. */}
      <span aria-hidden="true" className="flex max-w-full">
        <StatusBadge tone={term.tone} className="!gap-1 !px-1.5">
          {term.label}
        </StatusBadge>
      </span>
    </button>
  );
}
