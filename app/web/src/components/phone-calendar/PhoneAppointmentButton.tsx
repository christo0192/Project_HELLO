/**
 * One appointment, as a focusable control shared by both views.
 *
 * ── THE ACCESSIBLE NAME CARRIES EVERYTHING ────────────────────────────
 * Visually this is a compact glass chip: a time, a reference, a status badge.
 * Those three facts are legible together because they sit in a cell whose row
 * and column already say which day and which hour it is.
 *
 * None of that context survives being read aloud out of order, so the
 * control's accessible name restates it in full — who, when in IST, the
 * appointment status and the engagement state — via `aria-label`. The visible
 * text is then marked `aria-hidden` so the same facts are not announced
 * twice, once abbreviated and once in full.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ───────────────────────────────────
 * The status badge always renders its own word. The selected state is carried
 * by `aria-pressed` and by a ring, not by a fill an operator has to compare
 * against its neighbours.
 *
 * ── TOUCH TARGET ──────────────────────────────────────────────────────
 * `min-h-[44px]` keeps the control at the 44×44 CSS-pixel floor on touch
 * (WCAG 2.5.5), which a text-sized chip would otherwise miss by half. The
 * phone-calendar a11y gate looks for that literal class.
 */

import type { PhoneCalendarAppointment } from '../../types';
import { StatusBadge, cx } from '../design';
import { formatIstDayLabel, formatIstTimeRange, istDateOf } from '../../lib/ist-datetime';
import {
  appointmentAccessibleName,
  appointmentStatusTerm,
  candidateReferenceText,
} from './phoneVocabulary';

export interface PhoneAppointmentButtonProps {
  appointment: PhoneCalendarAppointment;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Show the IST day too — for lists where the row is not already a day. */
  showDate?: boolean;
}

export function PhoneAppointmentButton({
  appointment,
  selected,
  onSelect,
  showDate = false,
}: PhoneAppointmentButtonProps) {
  const term = appointmentStatusTerm(appointment.status);
  const date = istDateOf(appointment.starts_at);

  return (
    <button
      type="button"
      onClick={() => onSelect(appointment.id)}
      aria-pressed={selected}
      aria-label={appointmentAccessibleName(appointment)}
      className={cx(
        'flex w-full min-h-[44px] flex-col items-start justify-center gap-1 rounded-[10px] bg-white px-2.5 py-1.5 text-left shadow-pill',
        'transition-[box-shadow,background-color] duration-200 ease-soft',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        selected ? 'ring-2 ring-info' : 'hover:shadow-card-hover',
      )}
    >
      <span aria-hidden="true" className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink">
          {showDate && date ? `${formatIstDayLabel(date)} · ` : ''}
          {formatIstTimeRange(appointment.starts_at, appointment.ends_at)}
        </span>
        <StatusBadge tone={term.tone}>{term.label}</StatusBadge>
      </span>
      <span aria-hidden="true" className="block w-full truncate text-xs text-ink-tertiary">
        {candidateReferenceText(appointment.candidate)}
      </span>
    </button>
  );
}
