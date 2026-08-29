/**
 * The selected appointment: what it is, and — for an admin — what may be
 * done to it.
 *
 * ── ONE PANEL, TWO ROLES, NO HIDDEN CONTROLS ──────────────────────────
 * An interviewer sees this panel in full and sees NO write controls: they are
 * not rendered disabled, they are not rendered at all. A disabled button is a
 * promise that the action exists for you and is momentarily unavailable,
 * which for a read-only role is untrue. The API is authoritative regardless —
 * every mutation is admin-gated server-side — so this is honesty about the
 * interface, not a security boundary.
 *
 * ── NOTHING IS APPLIED OPTIMISTICALLY ─────────────────────────────────
 * Both actions go through `ConfirmButton`, which shows the exact change,
 * awaits the real API call, and never mutates local state on its own. The
 * page re-reads the calendar after a success; this panel never edits a row it
 * is displaying. A calendar that shows a move before the substrate accepted
 * it is a calendar that can show a call at a time nothing will dial.
 *
 * ── THE VERSION TRAVELS WITH THE WRITE ────────────────────────────────
 * Reschedule and cancel both send the `version` of the row as displayed. That
 * is the whole point of the token: if anything changed underneath, the
 * substrate refuses with `version_conflict` rather than silently overwriting
 * a colleague's change.
 */

import { useState } from 'react';
import type {
  PhoneAppointmentCancelInput,
  PhoneAppointmentPatchInput,
  PhoneCalendarAppointment,
  PhoneOperatorCancelReason,
  PhoneSlot,
} from '../../types';
import { StatusBadge } from '../design';
import { ConfirmButton } from '../mission-control/ConfirmButton';
import { buttonClassNames } from '../mission-control/buttonStyles';
import {
  formatIstLongDayLabel,
  formatIstTimeRange,
  istDateOf,
  istToday,
  type IstDate,
} from '../../lib/ist-datetime';
import { PhoneSlotPicker } from './PhoneSlotPicker';
import {
  OPERATOR_CANCEL_REASONS,
  appointmentStatusTerm,
  cancelReasonLabel,
  candidateReferenceText,
  engagementStateTerm,
  isAttemptInFlight,
  isLiveAppointment,
} from './phoneVocabulary';

export interface PhoneAppointmentDetailProps {
  appointment: PhoneCalendarAppointment;
  /** True only for an admin. Interviewers get no write controls at all. */
  canWrite: boolean;
  /**
   * Both resolve with WHETHER THE WRITE SUCCEEDED and never reject — the page
   * owns error reporting. The boolean lets this panel avoid discarding the
   * operator's slot selection after a refusal they are being told to retry.
   */
  onReschedule: (id: string, input: PhoneAppointmentPatchInput) => Promise<boolean>;
  onCancel: (id: string, input: PhoneAppointmentCancelInput) => Promise<boolean>;
  today: IstDate;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function PhoneAppointmentDetail({
  appointment,
  canWrite,
  onReschedule,
  onCancel,
  today,
}: PhoneAppointmentDetailProps) {
  const apptDate = istDateOf(appointment.starts_at);
  const [slotDate, setSlotDate] = useState<IstDate>(apptDate ?? today ?? istToday());
  const [slot, setSlot] = useState<PhoneSlot | null>(null);
  /**
   * The slot picker fetches a day's grid on mount, so it stays closed until
   * an admin actually intends to move this call. Selecting an appointment to
   * READ it must not cost a second request.
   */
  const [rescheduling, setRescheduling] = useState(false);
  const [reason, setReason] = useState<PhoneOperatorCancelReason>('hr_cancelled');

  const rescheduleId = `reschedule-panel-${appointment.id}`;
  const statusTerm = appointmentStatusTerm(appointment.status);
  const stateTerm = engagementStateTerm(appointment.engagement_state);
  const live = isLiveAppointment(appointment.status);
  const inFlight = isAttemptInFlight(appointment.engagement_state);

  return (
    <section
      aria-label="Selected appointment"
      className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <h2 className="text-sm font-semibold text-ink">
        {candidateReferenceText(appointment.candidate)}
      </h2>
      <p className="mt-0.5 text-sm text-ink-secondary">
        {apptDate ? `${formatIstLongDayLabel(apptDate)}, ` : ''}
        {formatIstTimeRange(appointment.starts_at, appointment.ends_at)}
      </p>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Appointment">
          <StatusBadge tone={statusTerm.tone}>{statusTerm.label}</StatusBadge>
        </Field>
        <Field label="Engagement">
          <StatusBadge tone={stateTerm.tone}>{stateTerm.label}</StatusBadge>
        </Field>
        <Field label="Pipeline status">
          {appointment.candidate?.status ?? 'Unavailable'}
        </Field>
        <Field label="Booked by">
          {appointment.source === 'hr_manual'
            ? 'HR, manually'
            : appointment.source === 'candidate_voice'
              ? 'The candidate, during a call'
              : 'A system deferral'}
        </Field>
        {appointment.cancel_reason && (
          <Field label="Cancellation reason">
            {cancelReasonLabel(appointment.cancel_reason)}
          </Field>
        )}
      </dl>

      {appointment.source === 'candidate_voice' && appointment.confirmed_at && (
        <p className="mt-3 rounded-lg border border-success/30 bg-success-soft px-3 py-2 text-sm text-success">
          Candidate confirmed this callback on {new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
          }).format(new Date(appointment.confirmed_at))} India time. The ten-minute
          reservation is rechecked again when the callback becomes due.
        </p>
      )}

      {canWrite && live && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            Change this appointment
          </h3>

          {inFlight ? (
            <p
              role="status"
              className="mt-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              A call attempt is in progress for this engagement. Rescheduling
              and cancelling are refused while a call is live.
            </p>
          ) : (
            <>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setRescheduling((v) => !v)}
                  aria-expanded={rescheduling}
                  aria-controls={rescheduling ? rescheduleId : undefined}
                  className={buttonClassNames('secondary', 'min-h-[44px]')}
                >
                  {rescheduling ? 'Close reschedule' : 'Reschedule…'}
                </button>
              </div>

              {rescheduling && (
              <div id={rescheduleId} className="mt-3">
                <PhoneSlotPicker
                  idPrefix={`reschedule-${appointment.id}`}
                  date={slotDate}
                  onDateChange={setSlotDate}
                  value={slot?.starts_at ?? null}
                  onChange={setSlot}
                />
                <ConfirmButton
                  className="mt-3"
                  label="Reschedule"
                  disabled={slot === null}
                  summary={
                    slot
                      ? `Move this appointment to ${formatIstLongDayLabel(
                          slotDate,
                        )}, ${formatIstTimeRange(
                          slot.starts_at,
                          slot.ends_at,
                        )}. The current slot is superseded and cannot be restored. Booking does not reserve dial capacity.`
                      : 'Pick a slot first.'
                  }
                  onConfirm={async () => {
                    if (!slot) return;
                    const moved = await onReschedule(appointment.id, {
                      starts_at: slot.starts_at,
                      ends_at: slot.ends_at,
                      version: appointment.version,
                    });
                    // Keep the chosen slot on a refusal the operator is being
                    // asked to retry; only close the form once it took.
                    if (!moved) return;
                    setSlot(null);
                    setRescheduling(false);
                  }}
                />
              </div>
              )}

              <div className="mt-5 border-t border-line pt-4">
                <label
                  htmlFor={`cancel-reason-${appointment.id}`}
                  className="block text-xs font-medium text-ink-secondary"
                >
                  Cancellation reason
                </label>
                <select
                  id={`cancel-reason-${appointment.id}`}
                  value={reason}
                  onChange={(e) =>
                    setReason(e.target.value as PhoneOperatorCancelReason)
                  }
                  className="mt-1 min-h-[44px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {OPERATOR_CANCEL_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <ConfirmButton
                  className="mt-3"
                  variant="danger"
                  label="Cancel appointment"
                  confirmLabel="Cancel it"
                  cancelLabel="Keep it"
                  summary={`Cancel this appointment, recording the reason "${
                    OPERATOR_CANCEL_REASONS.find((r) => r.value === reason)?.label ??
                    reason
                  }". Nothing will dial at this time afterwards.`}
                  onConfirm={async () => {
                    await onCancel(appointment.id, {
                      reason,
                      version: appointment.version,
                    });
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {canWrite && !live && (
        <p className="mt-4 border-t border-line pt-4 text-sm text-ink-secondary">
          This appointment is no longer live, so it cannot be rescheduled or
          cancelled.
        </p>
      )}
    </section>
  );
}
