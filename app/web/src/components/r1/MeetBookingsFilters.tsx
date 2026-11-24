/**
 * The Meet bookings filters: status, and the India days a slot may fall on. The page owns what they mean
 * and keeps it in the address; this only says what was chosen.
 *
 * A date keeps a draft of its own. A browser reports a date that is still being typed as no date, or as
 * one in the year 2, and a controlled field that refused those would put the old date back under the
 * typing hand, so the year could never be typed. The draft shows what is typed, and only a whole date in
 * range, or an emptied field, goes to the page.
 */
import { useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { Button, Combobox, Field, TextField } from '../design';
import type { IstDate } from '../../lib/ist-datetime';
import {
  MEET_FILTER_FIRST_DATE,
  MEET_FILTER_LAST_DATE,
  R1_MEET_STATUS_OPTIONS,
  isMeetFilterDate,
} from '../../lib/r1-meet-bookings';
import type { MeetFilters, R1MeetBookingStatus } from '../../lib/r1-meet-bookings';

const STATUS_OPTIONS = R1_MEET_STATUS_OPTIONS.map((option) => ({ ...option }));

interface DateFieldProps {
  id: string;
  label: string;
  /** The day the list is held to, or null for no limit on this side. */
  value: IstDate | null;
  error?: string | null;
  onCommit: (value: IstDate | null) => void;
}

function DateField({ id, label, value, error, onCommit }: DateFieldProps) {
  const committed = value ?? '';
  const [draft, setDraft] = useState(committed);
  const [followed, setFollowed] = useState(committed);
  // Reset, or the address: the box follows what the list is held to.
  if (followed !== committed) {
    setFollowed(committed);
    setDraft(committed);
  }

  const change = (next: string, halfTyped: boolean) => {
    setDraft(next);
    if (next === '' ? !halfTyped : isMeetFilterDate(next)) onCommit(next === '' ? null : next);
  };

  // Half a date, or one out of range, is not what the list shows, so it does not stay once the field is left.
  const leave = ({ currentTarget }: FocusEvent<HTMLInputElement>) => {
    if (currentTarget.validity.badInput || (draft !== '' && !isMeetFilterDate(draft))) setDraft(committed);
  };

  return (
    <Field id={id} label={label} error={error} className="w-full sm:w-44">
      {({ id: inputId, describedBy, invalid }) => (
        <TextField
          id={inputId}
          type="date"
          min={MEET_FILTER_FIRST_DATE}
          max={MEET_FILTER_LAST_DATE}
          value={draft}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={({ target }) => change(target.value, target.validity.badInput)}
          onBlur={leave}
          className="[@media(pointer:coarse)]:min-h-11"
        />
      )}
    </Field>
  );
}

export interface MeetBookingsFiltersProps {
  filters: MeetFilters;
  /** Why these dates cannot be asked for, said on the To field. */
  dateError: string | null;
  /** False while the address is the page as it opens, when there is nothing to reset. */
  canReset: boolean;
  onStatus: (status: R1MeetBookingStatus | null) => void;
  onFrom: (from: IstDate | null) => void;
  onTo: (to: IstDate | null) => void;
  onReset: () => void;
}

export function MeetBookingsFilters({ filters, dateError, canReset, onStatus, onFrom, onTo, onReset }: MeetBookingsFiltersProps) {
  const statusRef = useRef<HTMLButtonElement>(null);
  return (
    <div role="group" aria-label="Bookings to show" className="flex flex-wrap items-start gap-3">
      <Field id="meet-bookings-status" label="Status" className="w-full sm:w-56">
        {({ id, labelId }) => (
          <Combobox
            ref={statusRef}
            id={id}
            labelId={labelId}
            size="md"
            floating
            searchable={false}
            value={filters.status ?? ''}
            onChange={(next) => onStatus(next === '' ? null : (next as R1MeetBookingStatus))}
            options={STATUS_OPTIONS}
            placeholder="Any status"
            searchLabel="Status"
            listLabel="Booking statuses"
            className="w-full"
          />
        )}
      </Field>
      <DateField id="meet-bookings-from" label="From (IST)" value={filters.from} onCommit={onFrom} />
      <DateField id="meet-bookings-to" label="To (IST)" value={filters.to} error={dateError} onCommit={onTo} />
      {canReset && (
        <Button
          variant="ghost"
          // Level with the fields, under a label's height.
          className="sm:mt-[1.375rem]"
          onClick={() => {
            // Pressing it takes it away, so focus goes to the first of the filters it cleared.
            statusRef.current?.focus();
            onReset();
          }}
        >
          Reset filters
        </Button>
      )}
    </div>
  );
}
