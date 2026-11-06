/**
 * Candidate-profile-first booking for the global phone calendar.
 *
 * The old form required an operator to paste an internal engagement UUID. That
 * was both hard to discover and unsafe around initial-cycle creation. The
 * bounded candidate picker below delegates candidate-to-cycle resolution to
 * the API's atomic candidate booking operation; the global calendar remains
 * an operations view, not a second scheduler.
 *
 * ── OPENED FROM THE PAGE HEADER, NOT BESIDE THE GRID ──────────────────
 * This used to be a card in a side column next to the week grid, and that
 * column is what squeezed the grid to three visible days. The page now owns
 * the disclosure: "Book a screening" is the header's one primary action, and
 * this panel is rendered directly below the header only while it is open
 * (focus stays on that button, which the panel sits right under). With the
 * panel open, the form has the full content width, so the candidate and the
 * slot grid sit side by side instead of in a 24rem column.
 */

import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '../../api';
import { plainErrorText } from '../../lib/api-error-copy';
import type { Candidate, PhoneCandidateAppointmentCreateInput, PhoneSlot } from '../../types';
import { Combobox, ErrorPanel, GlassPanel, SectionHeader } from '../design';
import { ConfirmButton } from '../mission-control/ConfirmButton';
import { formatIstLongDayLabel, formatIstTimeRange, type IstDate } from '../../lib/ist-datetime';
import { candidateDisplayStatus } from '../talent/status';
import { PhoneCloseButton } from './PhoneCloseButton';
import { PhoneSlotPicker } from './PhoneSlotPicker';

export interface PhoneBookingPanelProps {
  /** Returns whether the candidate-scoped booking was accepted. */
  onCreate: (candidateId: string, input: PhoneCandidateAppointmentCreateInput) => Promise<boolean>;
  today: IstDate;
  /** The panel's id: the header button's `aria-controls` points here. */
  id: string;
  /** Closes the panel; the page returns focus to the header button. */
  onClose: () => void;
}

export function PhoneBookingPanel({ onCreate, today, id, onClose }: PhoneBookingPanelProps) {
  const rawId = useId();
  const idPrefix = `book-${rawId.replace(/:/g, '-')}`;
  const candidateFieldId = `${idPrefix}-candidate`;
  const candidateHintId = `${idPrefix}-candidate-hint`;

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  /** Bumped by Try again, which runs the read below once more. */
  const [candidateRead, setCandidateRead] = useState(0);
  const [candidateId, setCandidateId] = useState('');
  const [slotDate, setSlotDate] = useState<IstDate>(today);
  const [slot, setSlot] = useState<PhoneSlot | null>(null);

  // One candidate read per opening (the panel mounts when it opens), and one
  // more for each Try again.
  useEffect(() => {
    let live = true;
    setCandidateError(null);
    api
      .listCandidates()
      .then((rows) => { if (live) setCandidates(rows); })
      .catch((error: ApiError) => {
        if (live) setCandidateError(`The candidate list couldn't load. ${plainErrorText(error.message)}`);
      });
    return () => { live = false; };
  }, [candidateRead]);

  const selected = candidates?.find((candidate) => candidate.id === candidateId);
  const ready = selected !== undefined && slot !== null;

  return (
    <GlassPanel level="ruled" as="section" id={id} aria-label="Book a phone screening" padding="md" className="pb-5">
      {/* The close square never wraps under the heading; see PhoneCloseButton. */}
      <div className="flex items-start gap-3">
        <SectionHeader
          className="min-w-0 flex-1"
          title="Book a phone screening"
          description="Choose a candidate and a slot in India Standard Time. The call is added to the candidate's current screening cycle."
        />
        <PhoneCloseButton label="Close booking form" onClick={onClose} className="-mr-2 -mt-2" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <label
            htmlFor={candidateFieldId}
            id={`${candidateFieldId}-label`}
            className="block text-label font-medium text-ink-secondary"
          >
            Candidate
          </label>
          {candidateError ? (
            <ErrorPanel
              compact
              className="mt-1.5"
              message={candidateError}
              onRetry={() => setCandidateRead((read) => read + 1)}
            />
          ) : candidates === null ? (
            <p id={candidateHintId} role="status" className="mt-1.5 text-sm text-ink-tertiary">
              Loading candidates…
            </p>
          ) : candidates.length === 0 ? (
            <p id={candidateHintId} role="status" className="mt-1.5 text-sm text-ink-tertiary">
              No candidates are available.
            </p>
          ) : (
            // Searches name and email: hundreds of people in API order was a list
            // nobody could find anyone in. The email is a search term and is
            // never printed: this page keeps contact details out of the DOM, and
            // the booking list is open on calendars that get shared on a call.
            <Combobox
              id={candidateFieldId}
              labelId={`${candidateFieldId}-label`}
              size="md"
              value={candidateId}
              onChange={(next) => { setCandidateId(next); setSlot(null); }}
              options={candidates.map((candidate) => ({
                value: candidate.id,
                label: candidate.name ?? 'Candidate',
                description: candidateDisplayStatus(candidate).label,
                keywords: candidate.email ?? undefined,
              }))}
              placeholder="Select a candidate"
              searchLabel="Search by name or email"
              listLabel="Candidates"
              noun={['candidate', 'candidates']}
              noMatchText={(q) => `No candidate matches “${q}”.`}
              className="mt-1.5"
            />
          )}
        </div>

        <div className="min-w-0">
          <PhoneSlotPicker
            idPrefix={idPrefix}
            date={slotDate}
            onDateChange={(date) => { setSlotDate(date); setSlot(null); }}
            value={slot?.starts_at ?? null}
            onChange={setSlot}
            disabled={candidates === null || candidates.length === 0}
          />
        </div>
      </div>

      <ConfirmButton
        className="mt-5"
        label="Book"
        disabled={!ready}
        summary={
          ready && slot && selected
            ? `Book ${selected.name ?? 'the candidate'} on ${formatIstLongDayLabel(slotDate)}, ${formatIstTimeRange(slot.starts_at, slot.ends_at)}. Booking records the slot; dial capacity is applied when the call is placed.`
            : 'Select a candidate and a slot first.'
        }
        onConfirm={async () => {
          if (!selected || !slot) return;
          const created = await onCreate(selected.id, {
            starts_at: slot.starts_at,
            ends_at: slot.ends_at,
          });
          if (!created) return;
          setCandidateId('');
          setSlot(null);
        }}
      />
    </GlassPanel>
  );
}
