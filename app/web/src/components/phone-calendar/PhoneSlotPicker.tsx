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
import { cx } from '../design';
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
      <div className="mb-3">
        <label
          htmlFor={dateFieldId}
          className="block text-xs font-medium text-ink-secondary"
        >
          Date (IST)
        </label>
        <input
          id={dateFieldId}
          type="date"
          value={date}
          disabled={disabled}
          onChange={(e) => {
            // A `type="date"` input reports '' while it is being cleared or
            // partially typed. Forwarding that would fire a request for
            // `?date=`, which the API refuses with a shape error the operator
            // cannot act on — so an incomplete date simply does not move the
            // grid.
            const next = e.target.value;
            if (!isIstDate(next)) return;
            onChange(null);
            onDateChange(next);
          }}
          className="mt-1 min-h-[44px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
        <p className="mt-1 text-xs text-ink-tertiary">
          Calling days are every day of the week. Times below are India
          Standard Time.
        </p>
      </div>

      {error && (
        <p
          role="status"
          className="rounded-lg border border-error/30 bg-error-soft px-3 py-2 text-sm text-error"
        >
          {error}
        </p>
      )}

      {!error && data === null && (
        <p className="text-sm text-ink-secondary">Loading slots…</p>
      )}

      {!error && data && !data.enabled && (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
        >
          Phone screening is turned off, so no slots can be offered.
        </p>
      )}

      {!error && data && data.enabled && (
        <fieldset disabled={disabled}>
          <legend id={groupLabelId} className="text-xs font-medium text-ink-secondary">
            Slot
          </legend>

          <p className="mt-1 text-xs text-ink-tertiary">
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
              className="mt-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning"
            >
              This day held more appointments than the projection could count,
              so the booked counts below are a lower bound and the remaining
              counts an upper one. Treat every slot marked available as
              optimistic.
            </p>
          )}

          {data.slots.length === 0 ? (
            <p className="mt-2 text-sm text-ink-secondary">
              No slots on this date.
            </p>
          ) : (
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.slots.map((slot) => {
                const chosen = slot.starts_at === value;
                const blocked = !slot.bookable;
                return (
                  <li key={slot.starts_at}>
                    <label
                      className={cx(
                        'flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                        blocked
                          ? 'cursor-not-allowed border-line bg-surface-secondary text-ink-tertiary'
                          : chosen
                            ? 'border-brand-500 bg-brand-50 text-ink ring-1 ring-brand-500 dark:bg-brand-950'
                            : 'border-line bg-surface text-ink hover:bg-surface-tertiary',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${idPrefix}-slot`}
                        value={slot.starts_at}
                        checked={chosen}
                        disabled={blocked || disabled}
                        onChange={() => select(slot)}
                        className="mt-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      />
                      <span>
                        <span className="block font-medium">
                          {formatIstTimeRange(slot.starts_at, slot.ends_at)}
                        </span>
                        <span className="block text-xs">
                          {/*
                            The word is always present; the styling only ever
                            reinforces it. "Available" and "at projected
                            capacity" both name themselves as projections here
                            and in the paragraph above.
                          */}
                          {blocked
                            ? slot.refusals.map(slotRefusalLabel).join(' · ')
                            : 'Available (projected)'}
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
