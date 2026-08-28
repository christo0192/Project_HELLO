/**
 * Candidate-profile-first booking for the global phone calendar.
 *
 * The old form required an operator to paste an internal engagement UUID. That
 * was both hard to discover and unsafe around initial-cycle creation. The
 * bounded candidate picker below delegates candidate-to-cycle resolution to
 * the API's atomic candidate booking operation; the global calendar remains
 * an operations view, not a second scheduler.
 */

import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '../../api';
import type { Candidate, PhoneCandidateAppointmentCreateInput, PhoneSlot } from '../../types';
import { ConfirmButton } from '../mission-control/ConfirmButton';
import { buttonClassNames } from '../mission-control/buttonStyles';
import { formatIstLongDayLabel, formatIstTimeRange, type IstDate } from '../../lib/ist-datetime';
import { PhoneSlotPicker } from './PhoneSlotPicker';

export interface PhoneBookingPanelProps {
  /** Returns whether the candidate-scoped booking was accepted. */
  onCreate: (candidateId: string, input: PhoneCandidateAppointmentCreateInput) => Promise<boolean>;
  today: IstDate;
}

export function PhoneBookingPanel({ onCreate, today }: PhoneBookingPanelProps) {
  const rawId = useId();
  const idPrefix = `book-${rawId.replace(/:/g, '-')}`;
  const formId = `${idPrefix}-form`;
  const candidateFieldId = `${idPrefix}-candidate`;
  const candidateHintId = `${idPrefix}-candidate-hint`;

  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [slotDate, setSlotDate] = useState<IstDate>(today);
  const [slot, setSlot] = useState<PhoneSlot | null>(null);

  useEffect(() => {
    if (!open || candidates !== null) return;
    let live = true;
    setCandidateError(null);
    api
      .listCandidates()
      .then((rows) => { if (live) setCandidates(rows); })
      .catch((error: ApiError) => { if (live) setCandidateError(error.message); });
    return () => { live = false; };
  }, [open, candidates]);

  const selected = candidates?.find((candidate) => candidate.id === candidateId);
  const ready = selected !== undefined && slot !== null;

  return (
    <section
      aria-label="Book a phone screening"
      className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <h2 className="text-sm font-semibold text-ink">Book a phone screening</h2>
      <p className="mt-0.5 text-xs text-ink-secondary">
        Choose a candidate and an IST slot. The server resolves the active cycle atomically.
      </p>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? formId : undefined}
        className={buttonClassNames('secondary', 'mt-3 min-h-[44px]')}
      >
        {open ? 'Close booking form' : 'Book a screening'}
      </button>

      {!open ? null : (
        <div id={formId}>
          <div className="mt-4">
            <label htmlFor={candidateFieldId} className="block text-xs font-medium text-ink-secondary">
              Candidate
            </label>
            {candidateError ? (
              <p id={candidateHintId} role="status" className="mt-1 text-sm text-error">
                Candidate list unavailable. Close and reopen to retry.
              </p>
            ) : candidates === null ? (
              <p id={candidateHintId} role="status" className="mt-1 text-sm text-ink-tertiary">Loading candidates…</p>
            ) : candidates.length === 0 ? (
              <p id={candidateHintId} role="status" className="mt-1 text-sm text-ink-secondary">No candidates are available.</p>
            ) : (
              <>
                <select
                  id={candidateFieldId}
                  value={candidateId}
                  onChange={(event) => { setCandidateId(event.target.value); setSlot(null); }}
                  aria-describedby={candidateHintId}
                  className="mt-1 min-h-[44px] w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:max-w-md"
                >
                  <option value="">Select a candidate</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name ?? 'Candidate'} · {candidate.status}
                    </option>
                  ))}
                </select>
                <p id={candidateHintId} className="mt-1 text-xs text-ink-tertiary">
                  The candidate's current phone-screening cycle will be resolved by the server.
                </p>
              </>
            )}
          </div>

          <div className="mt-4">
            <PhoneSlotPicker
              idPrefix={idPrefix}
              date={slotDate}
              onDateChange={(date) => { setSlotDate(date); setSlot(null); }}
              value={slot?.starts_at ?? null}
              onChange={setSlot}
              disabled={candidates === null || candidates.length === 0}
            />
          </div>

          <ConfirmButton
            className="mt-4"
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
        </div>
      )}
    </section>
  );
}
