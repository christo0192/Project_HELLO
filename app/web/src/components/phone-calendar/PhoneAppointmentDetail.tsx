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
 *
 * ── TWO PLACEMENTS ────────────────────────────────────────────────────
 * `inline` is the week grid's detail row: no material of its own (it sits
 * inside the grid's panel, and glass never nests) and the full grid width to
 * use, so the summary and the change controls sit side by side. `panel` is a
 * glass panel of its own, for the queue's side column and for a phone, where
 * the two halves stack.
 */

import { useState, type ReactNode } from 'react';
import type {
  PhoneAppointmentCancelInput,
  PhoneAppointmentPatchInput,
  PhoneCalendarAppointment,
  PhoneOperatorCancelReason,
  PhoneSlot,
} from '../../types';
import {
  Button,
  Field,
  GlassPanel,
  SectionHeader,
  SelectField,
  StatusBadge,
  cx,
} from '../design';
import { ConfirmButton } from '../mission-control/ConfirmButton';
import { humanizeEnum } from '../../lib/humanize';
import {
  formatIstDateTime,
  formatIstLongDayLabel,
  formatIstTimeRange,
  istDateOf,
  istToday,
  type IstDate,
} from '../../lib/ist-datetime';
import { PhoneCloseButton } from './PhoneCloseButton';
import { PhoneSlotPicker } from './PhoneSlotPicker';
import {
  OPERATOR_CANCEL_REASONS,
  appointmentStatusTerm,
  cancelReasonLabel,
  candidateDisplay,
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
  /** `panel` (own glass panel) or `inline` (inside the week grid). */
  variant?: 'panel' | 'inline';
  /** Deselects the appointment; the page returns focus to its chip. */
  onClose?: () => void;
}

/** One read-only fact in the summary list. Sentence case, never shouted. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta font-medium text-ink-tertiary">{label}</dt>
      <dd className="mt-1 text-sm leading-5 text-ink">{children}</dd>
    </div>
  );
}

export function PhoneAppointmentDetail({
  appointment,
  canWrite,
  onReschedule,
  onCancel,
  today,
  variant = 'panel',
  onClose,
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
  const who = candidateDisplay(appointment.candidate);
  const pipelineStatus = appointment.candidate?.status ?? null;
  const inline = variant === 'inline';

  /*
    Where the change controls sit relative to the summary: beside it, behind
    a vertical hairline, when inline on a wide screen; under it, behind a
    horizontal one, everywhere else.
  */
  const splitClass = inline
    ? 'border-t border-glass-ring pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0'
    : 'mt-5 border-t border-glass-ring pt-4';

  const summary = (
    <div className="min-w-0">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Fact label="Appointment">
          <StatusBadge tone={statusTerm.tone}>{statusTerm.label}</StatusBadge>
        </Fact>
        <Fact label="Engagement">
          <StatusBadge tone={stateTerm.tone}>{stateTerm.label}</StatusBadge>
        </Fact>
        <Fact label="Pipeline status">
          {pipelineStatus ? (
            // Human words on screen; the raw value one hover away for an
            // operator who needs to quote it.
            <span title={pipelineStatus}>{humanizeEnum(pipelineStatus)}</span>
          ) : (
            'Unavailable'
          )}
        </Fact>
        <Fact label="Booked by">
          {appointment.source === 'hr_manual'
            ? 'HR, manually'
            : appointment.source === 'candidate_voice'
              ? 'The candidate, during a call'
              : 'A system deferral'}
        </Fact>
        {appointment.cancel_reason && (
          <Fact label="Cancellation reason">
            {cancelReasonLabel(appointment.cancel_reason)}
          </Fact>
        )}
      </dl>

      {appointment.source === 'candidate_voice' && appointment.confirmed_at && (
        <p className="mt-4 rounded-[14px] bg-success-soft px-3.5 py-2.5 text-sm leading-6 text-ink">
          Candidate confirmed this callback on {formatIstDateTime(appointment.confirmed_at)}. The
          ten-minute reservation is rechecked again when the callback becomes due.
        </p>
      )}
    </div>
  );

  let changeControls: ReactNode = null;
  if (canWrite && live) {
    changeControls = (
      <div className={cx('min-w-0', splitClass)}>
        <SectionHeader level={3} title="Change this appointment" />

        {inFlight ? (
          <p
            role="status"
            className="mt-3 rounded-[14px] bg-warning-soft px-3.5 py-2.5 text-sm leading-6 text-ink"
          >
            A call attempt is in progress for this engagement. Rescheduling
            and cancelling are refused while a call is live.
          </p>
        ) : (
          <>
            <div className="mt-3">
              <Button
                size="lg"
                variant="secondary"
                onClick={() => setRescheduling((v) => !v)}
                aria-expanded={rescheduling}
                aria-controls={rescheduling ? rescheduleId : undefined}
              >
                {rescheduling ? 'Close reschedule' : 'Reschedule…'}
              </Button>
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

            <div className="mt-5 border-t border-glass-ring pt-4">
              <Field
                id={`cancel-reason-${appointment.id}`}
                label="Cancellation reason"
                className="max-w-xs"
              >
                {({ id }) => (
                  <SelectField
                    id={id}
                    value={reason}
                    onChange={(e) =>
                      setReason(e.target.value as PhoneOperatorCancelReason)
                    }
                    className="min-h-[44px]"
                  >
                    {OPERATOR_CANCEL_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </SelectField>
                )}
              </Field>
              {/* Quiet until the confirmation step: red text, filled red
                  only on "Cancel it". A flex row, so the quiet trigger's
                  confirmation panel drops to its own line beneath it. */}
              <div className="mt-3 flex flex-wrap gap-2">
              <ConfirmButton
                quiet
                triggerSize="lg"
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
            </div>
          </>
        )}
      </div>
    );
  } else if (canWrite) {
    changeControls = (
      <p className={cx('text-label text-ink-tertiary', splitClass)}>
        This appointment is no longer live, so it cannot be rescheduled or
        cancelled.
      </p>
    );
  }

  /*
    The heading row is laid out here rather than by `SectionHeader`, whose
    actions wrap under a long title: in the 24rem side column that put
    "Close" on a line of its own. The close control is a fixed 44px square
    that never wraps; the title block takes the rest and wraps inside it.
    The name leads; the ATS reference sits beside it for quoting. Neither is
    ever replaced by an internal id.
  */
  const heading = (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="text-section text-ink">
            {who.primary}
          </h2>
          {who.reference && (
            <span className="text-label tabular-nums text-ink-tertiary">
              {who.reference}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-label tabular-nums text-ink-tertiary">
          {apptDate ? `${formatIstLongDayLabel(apptDate)}, ` : ''}
          {formatIstTimeRange(appointment.starts_at, appointment.ends_at)}
        </p>
      </div>
      {onClose && (
        <PhoneCloseButton
          label="Close appointment details"
          onClick={onClose}
          className="-mr-2 -mt-2"
        />
      )}
    </div>
  );

  if (inline) {
    return (
      <section aria-label="Selected appointment" className="px-4 py-4 sm:px-5 sm:py-5">
        {heading}
        <div
          className={cx(
            'mt-4 grid grid-cols-1 gap-4',
            changeControls !== null &&
              'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-6',
          )}
        >
          {summary}
          {changeControls}
        </div>
      </section>
    );
  }

  return (
    <GlassPanel as="section" aria-label="Selected appointment" padding="sm">
      {heading}
      <div className="mt-4">{summary}</div>
      {changeControls}
    </GlassPanel>
  );
}
