/**
 * Pick an IST day, then a slot on it. Shared by booking and rescheduling.
 *
 * ── "REMAINING" IS A PROJECTION, NOT A RESERVATION ────────────────────
 * This is the single most misleading number on the whole surface if it is
 * rendered plainly, so it is never rendered plainly.
 *
 * Migration 0042 has NO per-slot capacity model. The fleet cap is consumed at
 * DIAL time, by `admit_phone_attempt`, not at booking time. So `remaining` is
 * arithmetic projecting a dial-time cap onto a booking-time grid: booking a
 * slot reserves nothing, and a slot reporting capacity can still fail to dial
 * because the fleet was busy at that instant. Every place this component
 * shows capacity, it says that in words — because an operator who believes
 * "2 remaining" is a reservation will promise a candidate a call we have not
 * actually secured.
 *
 * ── NULL IS UNKNOWN, AND ZERO IS A NUMBER ─────────────────────────────
 * `max_concurrent` is null while the feature is disabled. Null means we could
 * not learn the cap. Rendering it as `0` would say the fleet can make no
 * calls at all — a different, and false, statement. It is shown as "unknown".
 *
 * ── AN OPTIMISTIC "BOOKABLE" IS LABELLED AS SUCH ──────────────────────
 * When `occupancy_truncated` is true the day held more live appointments than
 * the projection counted, so `booked` is a LOWER bound and `remaining` an
 * UPPER one — which makes `bookable` optimistic. The banner says so rather
 * than letting the operator read a clean grid.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { PhoneSlot, PhoneSlotsResponse } from '../../types';
import { Field, TextField, cx } from '../design';
import { formatIstTimeRange, isIstDate } from '../../lib/ist-datetime';
import type { IstDate } from '../../lib/ist-datetime';
import { slotRefusalLabel } from './phoneVocabulary';
import { phoneErrorMessage } from './phoneErrors';

export interface PhoneSlotPickerProps {
  /** IST calendar date whose grid is shown. */
  date: IstDate;
  onDateChange: (date: IstDate) => void;
  /** `starts_at` of the chosen slot, or null. */
  value: string | null;
  onChange: (slot: PhoneSlot | null) => void;
  /** Distinguishes the two pickers' form control ids. */
  idPrefix: string;
  disabled?: boolean;
}

export function PhoneSlotPicker({
  date,
  onDateChange,
  value,
  onChange,
  idPrefix,
  disabled = false,
}: PhoneSlotPickerProps) {
  const [data, setData] = useState<PhoneSlotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dateFieldId = `${idPrefix}-date`;
  const groupLabelId = `${idPrefix}-slots-label`;

  useEffect(() => {
    // See `api.getPhoneSlots`: an abort surfaces as a generic network
    // ApiError, so this latch — not the signal — is what decides whether a
    // response still belongs to the current date.
    let live = true;
    const controller = new AbortController();
    setData(null);
    setError(null);
    api
      .getPhoneSlots(date, controller.signal)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((e: ApiError) => {
        if (live) setError(phoneErrorMessage(e));
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [date]);

  const select = useCallback(
    (slot: PhoneSlot) => {
      onChange(slot.starts_at === value ? null : slot);
    },
    [onChange, value],
  );

  return (
    <div>
      <Field
        id={dateFieldId}
        label="Date (IST)"
        hint="Calling days are every day of the week. Times below are India Standard Time."
        className="mb-4 max-w-xs"
      >
        {({ id, describedBy }) => (
          <TextField
            id={id}
            type="date"
            value={date}
            disabled={disabled}
            aria-describedby={describedBy}
            onChange={(e) => {
              // A `type="date"` input reports '' while it is being cleared or
              // partially typed. Forwarding that would fire a request for
              // `?date=`, which the API refuses with a shape error the
              // operator cannot act on — so an incomplete date simply does
              // not move the grid.
              const next = e.target.value;
              if (!isIstDate(next)) return;
              onChange(null);
              onDateChange(next);
            }}
            className="min-h-[44px]"
          />
        )}
      </Field>

      {error && (
        <p role="status" className="rounded-[14px] bg-error-soft px-3.5 py-2.5 text-sm text-ink">
          {error}
        </p>
      )}

      {!error && data === null && (
        <p className="text-sm text-ink-tertiary">Loading slots…</p>
      )}

      {!error && data && !data.enabled && (
        <p role="status" className="rounded-[14px] bg-warning-soft px-3.5 py-2.5 text-sm text-ink">
          Phone screening is turned off, so no slots can be offered.
        </p>
      )}

      {!error && data && data.enabled && (
        <fieldset disabled={disabled}>
          <legend id={groupLabelId} className="text-[13px] font-medium text-ink-secondary">
            Slot
          </legend>

          {/* One line on screen (the full sentence stays in the DOM and in
              the tooltip): the same caveat is repeated by every host well. */}
          <p
            className="mt-1 truncate text-xs text-ink-tertiary"
            title={`Capacity below is an advisory projection, not a reservation. The fleet limit is applied when the call is dialled, not when it is booked, so booking a slot does not guarantee dial capacity at that time. ${
              data.max_concurrent === null
                ? 'The fleet limit is currently unknown.'
                : `The fleet limit is ${data.max_concurrent} concurrent ${
                    data.max_concurrent === 1 ? 'call' : 'calls'
                  }.`
            }`}
          >
            Capacity below is an <strong className="font-semibold">advisory
            projection</strong>, not a reservation. The fleet limit is applied
            when the call is dialled, not when it is booked, so booking a slot
            does not guarantee dial capacity at that time.{' '}
            {data.max_concurrent === null
              ? 'The fleet limit is currently unknown.'
              : `The fleet limit is ${data.max_concurrent} concurrent ${
                  data.max_concurrent === 1 ? 'call' : 'calls'
                }.`}
          </p>

          {data.occupancy_truncated && (
            <p
              role="status"
              className="mt-2 rounded-[14px] bg-warning-soft px-3.5 py-2.5 text-xs leading-5 text-ink"
            >
              This day held more appointments than the projection could count,
              so the booked counts below are a lower bound and the remaining
              counts an upper one. Treat every slot marked available as
              optimistic.
            </p>
          )}

          {data.slots.length === 0 ? (
            <p className="mt-2 text-sm text-ink-tertiary">
              No slots on this date.
            </p>
          ) : (
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.slots.map((slot) => {
                const chosen = slot.starts_at === value;
                const blocked = !slot.bookable;
                const refusalText = slot.refusals.map(slotRefusalLabel).join(' · ');
                return (
                  <li key={slot.starts_at}>
                    {/*
                      A chip, but still a radio. Picking a slot is a
                      choose-exactly-one decision, so the control stays a real
                      radio in a real group — it is only painted as a chip,
                      with the input visually hidden and the chip carrying the
                      focus ring on its behalf.
                    */}
                    <label
                      title={blocked ? refusalText : undefined}
                      className={cx(
                        'flex min-h-[44px] items-start gap-2 rounded-control px-3 py-2 text-sm',
                        'transition-[box-shadow,background-color] duration-200 ease-soft',
                        'focus-within:ring-2 focus-within:ring-info focus-within:ring-offset-2 focus-within:ring-offset-surface-secondary',
                        blocked
                          ? 'cursor-not-allowed bg-ink/[0.04] text-ink-tertiary'
                          : chosen
                            ? 'cursor-pointer bg-white text-ink shadow-pill ring-2 ring-info'
                            : 'cursor-pointer bg-white/70 text-ink shadow-[inset_0_0_0_1px_var(--glass-ring-strong)] hover:bg-white',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${idPrefix}-slot`}
                        value={slot.starts_at}
                        checked={chosen}
                        disabled={blocked || disabled}
                        onChange={() => select(slot)}
                        className="sr-only"
                      />
                      <span>
                        <span className="block font-medium">
                          {formatIstTimeRange(slot.starts_at, slot.ends_at)}
                        </span>
                        <span className="block text-xs text-ink-tertiary">
                          {/*
                            The word is always present; the styling only ever
                            reinforces it. "Available" and "at projected
                            capacity" both name themselves as projections here
                            and in the paragraph above.
                          */}
                          {blocked ? refusalText : 'Available (projected)'}
                          {' · '}
                          {slot.booked} booked
                          {data.max_concurrent === null
                            ? ' · fleet limit unknown'
                            : ` · ${slot.remaining} projected free`}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      )}
    </div>
  );
}
