/**
 * Book a new appointment. Admin only.
 *
 * ── WHY THE OPERATOR TYPES AN ENGAGEMENT ID ───────────────────────────
 * This is the one place the interface is less convenient than it looks like
 * it should be, and the reason is worth stating rather than papering over.
 *
 * The calendar read returns appointments. An engagement that has NO
 * appointment yet — exactly the engagement you would want to book — appears
 * in no read this API offers: there is no "engagements awaiting a call"
 * endpoint in the P6 contract. So a picker of bookable candidates cannot be
 * built from the data available, and building one from a different source
 * would mean showing a list this surface cannot verify.
 *
 * Rather than invent that list, the panel asks for the engagement id the
 * operator already has from the engagement view they came from. The id is
 * checked for shape here so an obvious typo is caught before a round trip,
 * but the substrate remains the authority on whether it names anything.
 *
 * ── SOURCE IS NOT A FIELD ─────────────────────────────────────────────
 * Every appointment booked here is `hr_manual` by definition, and the API's
 * create schema is strict: it has no `source` property and refuses a request
 * that sends one. So this panel does not offer it — the other two sources
 * describe events that did not happen here.
 */

import { useId, useState } from 'react';
import type { PhoneAppointmentCreateInput, PhoneSlot } from '../../types';
import { ConfirmButton } from '../mission-control/ConfirmButton';
import { buttonClassNames } from '../mission-control/buttonStyles';
import { formatIstLongDayLabel, formatIstTimeRange, type IstDate } from '../../lib/ist-datetime';
import { PhoneSlotPicker } from './PhoneSlotPicker';

/** Shape only. The substrate decides whether the id names a real engagement. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PhoneBookingPanelProps {
  /**
   * Performs the booking and RESOLVES WITH WHETHER IT SUCCEEDED. It must not
   * reject: the page owns error reporting, and a rejecting handler would put
   * an unhandled rejection through `ConfirmButton`'s catch. The boolean is
   * what tells this panel whether it may throw the operator's input away.
   */
  onCreate: (input: PhoneAppointmentCreateInput) => Promise<boolean>;
  today: IstDate;
}

export function PhoneBookingPanel({ onCreate, today }: PhoneBookingPanelProps) {
  const rawId = useId();
  const idPrefix = `book-${rawId.replace(/:/g, '-')}`;
  const formId = `${idPrefix}-form`;
  const engagementFieldId = `${idPrefix}-engagement`;
  const engagementHintId = `${idPrefix}-engagement-hint`;

  /**
   * Collapsed until asked for. The slot picker fetches a day's grid the
   * moment it mounts, so an always-open form would put a second request on
   * every admin page load — for a form most visits never use. Opening it is
   * an explicit intent, and that is when the fetch is warranted.
   */
  const [open, setOpen] = useState(false);
  const [engagementId, setEngagementId] = useState('');
  const [slotDate, setSlotDate] = useState<IstDate>(today);
  const [slot, setSlot] = useState<PhoneSlot | null>(null);

  const trimmed = engagementId.trim();
  const idLooksValid = UUID_PATTERN.test(trimmed);
  const showIdError = trimmed.length > 0 && !idLooksValid;
  const ready = idLooksValid && slot !== null;

  return (
    <section
      aria-label="Book a phone screening"
      className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <h2 className="text-sm font-semibold text-ink">Book a phone screening</h2>
      <p className="mt-0.5 text-xs text-ink-secondary">
        Books against an existing phone engagement. The engagement must already
        exist — this does not create one.
      </p>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? formId : undefined}
        className={buttonClassNames('secondary', 'mt-3 min-h-[44px]')}
      >
        {open ? 'Close booking form' : 'Book a screening'}
      </button>

      {!open ? null : (
      <div id={formId}>
      <div className="mt-4">
        <label
          htmlFor={engagementFieldId}
          className="block text-xs font-medium text-ink-secondary"
        >
          Engagement id
        </label>
        <input
          id={engagementFieldId}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={engagementId}
          onChange={(e) => setEngagementId(e.target.value)}
          aria-describedby={engagementHintId}
          aria-invalid={showIdError || undefined}
          className="mt-1 w-full min-h-[44px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:max-w-md"
        />
        <p id={engagementHintId} className="mt-1 text-xs text-ink-tertiary">
          {showIdError
            ? 'That is not a valid engagement id. Copy it from the engagement you want to book.'
            : 'Copy the engagement id from the engagement you want to book.'}
        </p>
      </div>

      <div className="mt-4">
        <PhoneSlotPicker
          idPrefix={idPrefix}
          date={slotDate}
          onDateChange={setSlotDate}
          value={slot?.starts_at ?? null}
          onChange={setSlot}
        />
      </div>

      <ConfirmButton
        className="mt-4"
        label="Book"
        disabled={!ready}
        summary={
          ready && slot
            ? `Book a phone screening on ${formatIstLongDayLabel(
                slotDate,
              )}, ${formatIstTimeRange(
                slot.starts_at,
                slot.ends_at,
              )}. Booking records the slot; it does not reserve dial capacity, which is applied when the call is placed.`
            : 'Enter a valid engagement id and pick a slot first.'
        }
        onConfirm={async () => {
          if (!slot || !idLooksValid) return;
          const created = await onCreate({
            engagement_id: trimmed,
            starts_at: slot.starts_at,
            ends_at: slot.ends_at,
          });
          // ONLY on success. Several refusals — a closed window, a slot that
          // has just passed, a terminal engagement, a rate limit — leave this
          // panel mounted with a message telling the operator to try again,
          // and clearing here would have thrown away the engagement id they
          // hand-copied and the slot they picked. The page's error handler
          // never rethrows, so the resolved boolean is the only signal
          // available.
          if (!created) return;
          setEngagementId('');
          setSlot(null);
        }}
      />
      </div>
      )}
    </section>
  );
}
