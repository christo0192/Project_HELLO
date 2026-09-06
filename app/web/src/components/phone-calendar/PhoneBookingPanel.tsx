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
import { Button, GlassPanel, SectionHeader, SelectField } from '../design';
import { ConfirmButton } from '../mission-control/ConfirmButton';
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
    <GlassPanel as="section" aria-label="Book a phone screening" padding="sm">
      <SectionHeader
        title="Book a phone screening"
        description="Choose a candidate and an IST slot. The server resolves the active cycle atomically."
      />

      <Button
        size="lg"
        variant="secondary"
        className="mt-4"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? formId : undefined}
      >
        {open ? 'Close booking form' : 'Book a screening'}
      </Button>

      {!open ? null : (
        <div id={formId}>
          <div className="mt-5">
            <label
              htmlFor={candidateFieldId}
              className="block text-[13px] font-medium text-ink-secondary"
            >
              Candidate
            </label>
            {candidateError ? (
              <p
                id={candidateHintId}
                role="status"
                className="mt-1.5 rounded-[14px] bg-error-soft px-3.5 py-2.5 text-sm text-ink"
              >
                Candidate list unavailable. Close and reopen to retry.
              </p>
            ) : candidates === null ? (
              <p id={candidateHintId} role="status" className="mt-1.5 text-sm text-ink-tertiary">
                Loading candidates…
              </p>
            ) : candidates.length === 0 ? (
              <p id={candidateHintId} role="status" className="mt-1.5 text-sm text-ink-tertiary">
                No candidates are available.
              </p>
            ) : (
              <>
                <SelectField
                  id={candidateFieldId}
                  value={candidateId}
                  onChange={(event) => { setCandidateId(event.target.value); setSlot(null); }}
                  aria-describedby={candidateHintId}
                  className="mt-1.5 min-h-[44px] sm:max-w-md"
                >
                  <option value="">Select a candidate</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name ?? 'Candidate'} · {candidate.status}
                    </option>
                  ))}
                </SelectField>
                <p id={candidateHintId} className="mt-1.5 text-xs leading-5 text-ink-tertiary">
                  The candidate's current phone-screening cycle will be resolved by the server.
                </p>
              </>
            )}
          </div>

          <div className="mt-5">
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
    </GlassPanel>
  );
}
