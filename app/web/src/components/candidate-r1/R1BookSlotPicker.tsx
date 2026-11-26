import type { R1BookGrid, R1BookSlot } from '../../lib/r1/r1-book-api';
import { formatIstDayLabel, formatIstTimeRange } from '../../lib/ist-datetime';
import { R1_BOOK_COPY } from './r1-book-copy';

interface R1BookSlotPickerProps {
  grid: R1BookGrid;
  /** The IST date whose times are shown, or null. */
  day: string | null;
  /** A time on another day is never shown as chosen, so the page clears `value` on a new day. */
  onDay: (date: string) => void;
  /** The chosen slot's `start_at`, exactly as the grid sent it, or null. */
  value: string | null;
  onChange: (startAt: string) => void;
  /** The booking's own time when moving it: shown, never pickable. */
  currentStart?: string | null;
  /** Prefix of the radio group names and of the `${idPrefix}-slot-first` focus target. */
  idPrefix: string;
  disabled?: boolean;
  /** A field message (copy constant) about the time, tied to the time group. */
  error?: string;
  /** A one-line note above the picker, such as "That time was just taken". */
  notice?: string;
}

/**
 * Pick an IST day, then a time on it (M035 S07, decisions D-S07-M18 and D-S07-M20).
 *
 * The grid comes from the API and the picker only READS it: a time can be picked when the server
 * said `available: true` (and it is not the booking's current time); nothing about capacity is
 * computed, and no count of any kind is ever shown. Every unpickable chip says why in words
 * ("Not available", "Your current time", "No times left"), so the state never rests on styling;
 * a real space keeps that word apart from the time in the radio's accessible name.
 *
 * Each choice is a real radio in a real group (arrow keys move within it, Tab leaves it), painted
 * as a chip: the input is visually hidden inside its label and the chip draws the focus ring
 * (the PhoneSlotPicker.tsx pattern). The radio names hold the IST date and the grid's instant,
 * never anything the person typed.
 */
export function R1BookSlotPicker({
  grid,
  day,
  onDay,
  value,
  onChange,
  currentStart = null,
  idPrefix,
  disabled = false,
  error,
  notice,
}: R1BookSlotPickerProps) {
  const pickable = (slot: R1BookSlot): boolean =>
    slot.available && (currentStart === null || slot.start_at !== currentStart);

  const shownDay = grid.days.find((entry) => entry.date === day) ?? null;
  const slots = shownDay?.slots ?? [];
  const firstTime = slots.find(pickable) ?? null;
  const firstDay = firstTime ? null : (grid.days.find((entry) => entry.slots.some(pickable)) ?? null);
  const focusId = `${idPrefix}-slot-first`;
  const errorId = `${idPrefix}-slot-error`;

  return (
    <div>
      {notice ? <p className="r1-book__notice">{notice}</p> : null}

      <fieldset className="r1-book__field" disabled={disabled}>
        <legend className="candidate-field-label">{R1_BOOK_COPY.form.dayLegend}</legend>
        <ul className="r1-book__chips">
          {grid.days.map((entry) => {
            const open = entry.slots.some(pickable);
            const chosen = entry.date === day;
            return (
              <li key={entry.date}>
                <label
                  className="r1-book__chip"
                  data-checked={chosen ? 'true' : 'false'}
                  data-disabled={open ? 'false' : 'true'}
                >
                  <input
                    id={entry === firstDay ? focusId : undefined}
                    type="radio"
                    className="sr-only"
                    name={`${idPrefix}-day`}
                    value={entry.date}
                    checked={chosen}
                    disabled={!open}
                    onChange={() => onDay(entry.date)}
                  />
                  <span>{formatIstDayLabel(entry.date)}</span>
                  {open ? null : <>{' '}<small>{R1_BOOK_COPY.form.dayUnavailable}</small></>}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <fieldset
        className="r1-book__field"
        disabled={disabled}
        aria-describedby={error ? errorId : undefined}
      >
        <legend className="candidate-field-label">{R1_BOOK_COPY.form.timeLegend}</legend>
        {firstTime ? null : <p className="r1-book__hint">{R1_BOOK_COPY.form.noTimesOnDay}</p>}
        {slots.length > 0 ? (
          <ul className="r1-book__chips">
            {slots.map((slot) => {
              const current = currentStart !== null && slot.start_at === currentStart;
              const open = pickable(slot);
              const chosen = slot.start_at === value;
              const why = current
                ? R1_BOOK_COPY.form.currentTime
                : open
                  ? null
                  : R1_BOOK_COPY.form.timeUnavailable;
              return (
                <li key={slot.start_at}>
                  <label
                    className="r1-book__chip"
                    data-checked={chosen ? 'true' : 'false'}
                    data-disabled={open ? 'false' : 'true'}
                  >
                    <input
                      id={slot === firstTime ? focusId : undefined}
                      type="radio"
                      className="sr-only"
                      name={`${idPrefix}-time`}
                      value={slot.start_at}
                      checked={chosen}
                      disabled={!open}
                      onChange={() => onChange(slot.start_at)}
                    />
                    <span>{formatIstTimeRange(slot.start_at, slot.end_at)}</span>
                    {why ? <>{' '}<small>{why}</small></> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? (
          <p id={errorId} className="r1-book__field-error">
            {error}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
