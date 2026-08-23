/**
 * The write paths: booking, rescheduling, cancelling — and everything the
 * operator is told about them.
 *
 * The properties under test here are the ones that decide whether an operator
 * can trust the calendar:
 *   · nothing is applied optimistically, and every success is followed by a
 *     real re-read;
 *   · the version travels with every mutation;
 *   · a version conflict is explained, and the stale view is replaced;
 *   · a 429 reads as pacing, never as degraded service;
 *   · `max_concurrent: null` reads as unknown, never as zero;
 *   · capacity is stated as advisory, and booking is never described as
 *     guaranteeing a dial.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  ADMIN_ME,
  INTERVIEWER_ME,
  MockApiError,
  apiFns,
  appointment,
  calendarResponse,
  phoneApi,
  slot,
  slotsResponse,
} from '../components/phone-calendar/__tests__/phoneFixtures';
import { stubMatchMedia } from '../components/design/__tests__/helpers';

vi.mock('../api', () => ({ api: phoneApi.api, ApiError: phoneApi.ApiError }));

import { PhoneCalendarPage } from './PhoneCalendarPage';

const ENGAGEMENT_ID = '11111111-2222-4333-8444-555555555555';

function renderPage(search = '?week=2026-08-24') {
  return render(
    <MemoryRouter initialEntries={[`/phone-calendar${search}`]}>
      <PhoneCalendarPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFns.getMe.mockResolvedValue(ADMIN_ME);
  apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse());
  apiFns.getPhoneSlots.mockResolvedValue(slotsResponse());
  apiFns.createPhoneAppointment.mockResolvedValue({
    ok: true,
    appointment_id: 'new-1',
    version: 1,
    engagement_state: 'scheduled',
    prereqs_pending: false,
    superseded_appointment_id: null,
  });
  apiFns.reschedulePhoneAppointment.mockResolvedValue({
    ok: true,
    appointment_id: 'appt-1',
    version: 2,
    engagement_state: 'scheduled',
    prereqs_pending: false,
    superseded_appointment_id: 'appt-1',
  });
  apiFns.cancelPhoneAppointment.mockResolvedValue({
    ok: true,
    appointment_id: 'appt-1',
    version: 2,
    already_cancelled: false,
  });
  stubMatchMedia(false, '(max-width: 639px)');
});

/** Open the collapsed booking form and fill it in. */
async function openBookingForm() {
  await screen.findByRole('table');
  await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));
  const idField = await screen.findByLabelText('Engagement id');
  await userEvent.type(idField, ENGAGEMENT_ID);
  const radios = await screen.findAllByRole('radio');
  await userEvent.click(radios[0]);
}

/** Select the seeded appointment and open its reschedule form. */
async function openRescheduleForm() {
  await screen.findByRole('table');
  await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Reschedule…' }));
  const radios = await screen.findAllByRole('radio');
  await userEvent.click(radios[0]);
}

// ══════════════════════════════════════════════════════════════════════
//  Booking
// ══════════════════════════════════════════════════════════════════════

describe('booking', () => {
  it('sends the UTC bounds of the chosen slot and no source field', async () => {
    renderPage();
    await openBookingForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(apiFns.createPhoneAppointment).toHaveBeenCalledTimes(1));
    const body = apiFns.createPhoneAppointment.mock.calls[0][0];
    expect(body).toEqual({
      engagement_id: ENGAGEMENT_ID,
      starts_at: '2026-08-26T09:00:00Z',
      ends_at: '2026-08-26T09:30:00Z',
    });
    // The create schema is strict and has no `source`; sending one is refused.
    expect(body).not.toHaveProperty('source');
    expect(body.starts_at.endsWith('Z')).toBe(true);
  });

  it('re-reads the calendar after a success rather than patching it locally', async () => {
    renderPage();
    await openBookingForm();
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Appointment booked.');
  });

  it('does not book until the confirmation is given', async () => {
    renderPage();
    await openBookingForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));

    // The confirmation panel is open; nothing has been sent.
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(apiFns.createPhoneAppointment).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiFns.createPhoneAppointment).not.toHaveBeenCalled();
  });

  it('states the prerequisites warning instead of reporting a plain success', async () => {
    // `ok_prereqs_pending` is a success WITH a warning: the slot is real, but
    // nothing will dial it. Collapsing it into "booked" would let an operator
    // believe a call is going to happen.
    apiFns.createPhoneAppointment.mockResolvedValue({
      ok: true,
      appointment_id: 'new-1',
      version: 1,
      engagement_state: 'pending_prereqs',
      prereqs_pending: true,
      superseded_appointment_id: null,
    });
    renderPage();
    await openBookingForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/prerequisites are not met/i));
    expect(status).toHaveTextContent(/nothing will dial/i);
  });

  it('refuses to send a malformed engagement id before any round trip', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));
    await userEvent.type(await screen.findByLabelText('Engagement id'), 'not-a-uuid');

    expect(screen.getByLabelText('Engagement id')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
    expect(apiFns.createPhoneAppointment).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Reschedule and cancel — the version is the point
// ══════════════════════════════════════════════════════════════════════

describe('reschedule', () => {
  it('sends the displayed version with the new bounds', async () => {
    renderPage();
    await openRescheduleForm();
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(apiFns.reschedulePhoneAppointment).toHaveBeenCalledTimes(1),
    );
    const [id, body] = apiFns.reschedulePhoneAppointment.mock.calls[0];
    expect(id).toBe('appt-1');
    expect(body).toEqual({
      starts_at: '2026-08-26T09:00:00Z',
      ends_at: '2026-08-26T09:30:00Z',
      version: 1,
    });
  });

  it('says the previous slot is superseded and cannot be restored', async () => {
    renderPage();
    await openRescheduleForm();
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));

    const panel = await screen.findByText(/cannot be restored/i);
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toMatch(/does not reserve dial capacity/i);
  });
});

describe('cancel', () => {
  it('sends the chosen operator reason and the version', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));

    await userEvent.selectOptions(
      await screen.findByLabelText('Cancellation reason'),
      'candidate_request',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    await waitFor(() => expect(apiFns.cancelPhoneAppointment).toHaveBeenCalledTimes(1));
    expect(apiFns.cancelPhoneAppointment.mock.calls[0][1]).toEqual({
      reason: 'candidate_request',
      version: 1,
    });
  });

  it('offers only operator-initiated reasons', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));

    const select = await screen.findByLabelText('Cancellation reason');
    const values = within(select)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values.sort()).toEqual([
      'candidate_request',
      'emergency_stop',
      'engagement_cancelled',
      'hr_cancelled',
    ]);
    // Written only by the substrate — offering either would let an operator
    // write an audit trail that misdescribes what happened.
    expect(values).not.toContain('superseded');
    expect(values).not.toContain('system_deferral_expired');
  });

  it('reports an idempotent repeat as "nothing changed", not as a failure', async () => {
    apiFns.cancelPhoneAppointment.mockResolvedValue({
      ok: true,
      appointment_id: 'appt-1',
      version: 1,
      already_cancelled: true,
    });
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/already cancelled/i));
    expect(status).toHaveTextContent(/nothing changed/i);
  });

  it('hides both write actions while an attempt is in flight', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({ appointments: [appointment({ engagement_state: 'dialing' })] }),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));

    expect(await screen.findByText(/call attempt is in progress/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule…' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel appointment' }),
    ).not.toBeInTheDocument();
  });

  it('offers no write actions on an appointment that is no longer live', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({ appointments: [appointment({ status: 'cancelled' })] }),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));

    expect(await screen.findByText(/no longer live/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule…' })).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Version conflict — announced, and the stale view replaced
// ══════════════════════════════════════════════════════════════════════

describe('version conflict', () => {
  it('explains it in a polite live region and re-reads the calendar', async () => {
    apiFns.cancelPhoneAppointment.mockRejectedValue(
      new MockApiError('version_conflict', 409),
    );
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/changed since/i));
    expect(status).toHaveTextContent(/was refused/i);
    // NOT "nothing was changed" — see the dedicated test below: the
    // reschedule path can leave a stray appointment the API could not undo,
    // and the shared client discards the field that would distinguish it.
    expect(status).not.toHaveTextContent(/nothing was changed/i);

    // The stale view is replaced, so the operator's next attempt starts from
    // what is actually there.
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(2));
  });

  it('announces politely — role=status, never an assertive interruption', async () => {
    apiFns.cancelPhoneAppointment.mockRejectedValue(
      new MockApiError('version_conflict', 409),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).not.toHaveAttribute('aria-live', 'assertive');
    expect(status).not.toHaveAttribute('role', 'alert');
  });

  it('does not re-read for a refusal that leaves the view valid', async () => {
    apiFns.cancelPhoneAppointment.mockRejectedValue(new MockApiError('slot_in_past', 409));
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    await screen.findByRole('status');
    expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  429 is pacing, not a health signal
// ══════════════════════════════════════════════════════════════════════

describe('rate limiting', () => {
  it('reads a throttled load as retry-shortly, never as degraded', async () => {
    apiFns.getPhoneCalendar.mockRejectedValue(new MockApiError('rate_limited', 429));
    renderPage();

    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/wait a moment/i);
    expect(text).not.toMatch(/degraded|outage|unavailable|incident/i);
  });

  it('reads a throttled mutation the same way', async () => {
    apiFns.cancelPhoneAppointment.mockRejectedValue(new MockApiError('rate_limited', 429));
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/too many requests/i));
    expect(status).not.toHaveTextContent(/degraded/i);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Capacity is advisory, and null is unknown
// ══════════════════════════════════════════════════════════════════════

describe('capacity semantics', () => {
  it('states that booking does not guarantee dial capacity', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));

    // The phrase is split across an inline <strong>, so match on the whole
    // paragraph rather than on the emphasised fragment.
    const advisory = await screen.findByText(
      (_content, element) =>
        element?.tagName === 'P' &&
        /advisory projection/i.test(element.textContent ?? '') &&
        /not a reservation/i.test(element.textContent ?? ''),
    );
    expect(advisory.textContent).toMatch(/does not guarantee dial capacity/i);
    expect(advisory.textContent).toMatch(/applied when the call is dialled/i);
  });

  it('renders max_concurrent: null as UNKNOWN and never as zero', async () => {
    apiFns.getPhoneSlots.mockResolvedValue(slotsResponse({ max_concurrent: null }));
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));

    expect(await screen.findByText(/fleet limit is currently unknown/i)).toBeInTheDocument();
    // "0 concurrent calls" would say the fleet can make no calls at all — a
    // different, and false, statement.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/0 concurrent/);
    expect(text).not.toMatch(/limit is 0\b/);
  });

  it('labels an available slot as a projection, in words', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));
    expect(await screen.findByText(/Available \(projected\)/)).toBeInTheDocument();
  });

  it('names the refusal on a slot at projected capacity, and disables it', async () => {
    apiFns.getPhoneSlots.mockResolvedValue(
      slotsResponse({
        slots: [
          slot({ bookable: false, remaining: 0, booked: 2, refusals: ['at_projected_capacity'] }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));

    expect(await screen.findByText(/At projected capacity/)).toBeInTheDocument();
    expect((await screen.findAllByRole('radio'))[0]).toBeDisabled();
  });

  it('warns that a truncated occupancy makes every "available" optimistic', async () => {
    apiFns.getPhoneSlots.mockResolvedValue(slotsResponse({ occupancy_truncated: true }));
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));

    const warning = await screen.findByText(/lower bound/i);
    expect(warning.textContent).toMatch(/optimistic/i);
  });

  it('offers no slots at all while the feature is disabled', async () => {
    apiFns.getPhoneSlots.mockResolvedValue(
      slotsResponse({ enabled: false, slots: [], max_concurrent: null }),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));

    expect(
      await screen.findByText(/turned off, so no slots can be offered/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  An interviewer can reach none of this
// ══════════════════════════════════════════════════════════════════════

describe('interviewer', () => {
  it('is offered no mutation control and calls no mutation endpoint', async () => {
    apiFns.getMe.mockResolvedValue(INTERVIEWER_ME);
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await screen.findByRole('region', { name: 'Selected appointment' });

    expect(screen.queryByRole('button', { name: 'Book a screening' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel appointment' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cancellation reason')).not.toBeInTheDocument();

    expect(apiFns.createPhoneAppointment).not.toHaveBeenCalled();
    expect(apiFns.reschedulePhoneAppointment).not.toHaveBeenCalled();
    expect(apiFns.cancelPhoneAppointment).not.toHaveBeenCalled();
    // And never asks for slots, which only a booking flow needs.
    expect(apiFns.getPhoneSlots).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Regressions found by independent review
// ══════════════════════════════════════════════════════════════════════

describe('a failed mutation never says the wrong thing happened', () => {
  it('does not claim a change was undone when the API did not undo it', async () => {
    // `auditOrFail` only compensates where a `compensate` callback is
    // supplied, and NONE of the three appointment routes supplies one — only
    // POST /halt/clear does. So on this path the row really was written and
    // only its audit record is missing. Telling the operator it was "not
    // applied" would send them to book the same slot a second time.
    apiFns.createPhoneAppointment.mockRejectedValue(
      new MockApiError('phone_audit_write_failed', 500),
    );
    renderPage();
    await openBookingForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/may have been applied/i));
    expect(status).not.toHaveTextContent(/it was not applied/i);
    // And the view is re-read, because it can no longer be trusted.
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(2));
  });

  it('does not claim "nothing was changed" on a version conflict', async () => {
    // The reschedule path can leave a stray appointment behind when its
    // compensation fails, and the API reports that in `appointment_rolled_back`
    // — a field the shared client discards. Copy that cannot tell the two
    // cases apart must not assert the reassuring one.
    apiFns.reschedulePhoneAppointment.mockRejectedValue(
      new MockApiError('version_conflict', 409),
    );
    renderPage();
    await openRescheduleForm();
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/was refused/i));
    expect(status).not.toHaveTextContent(/nothing was changed/i);
  });

  it.each([
    ['attempt_in_flight'],
    ['engagement_terminal'],
  ])('re-reads after %s, because the loaded state must be stale', async (code) => {
    // The UI HIDES both write controls when it believes an engagement is in
    // flight or terminal, so being refused for either reason is proof the row
    // on screen no longer matches the substrate.
    apiFns.cancelPhoneAppointment.mockRejectedValue(new MockApiError(code, 409));
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    await waitFor(() => expect(apiFns.getPhoneCalendar).toHaveBeenCalledTimes(2));
  });
});

describe('a refusal does not throw away the operator input', () => {
  it('keeps the engagement id and the slot when booking is refused', async () => {
    // `window_closed` is not in REFRESH_REQUIRED, so the panel stays mounted
    // with a message telling the operator to try again. Clearing the fields
    // would discard a UUID they hand-copied from another surface.
    apiFns.createPhoneAppointment.mockRejectedValue(
      new MockApiError('window_closed', 409),
    );
    renderPage();
    await openBookingForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await screen.findByText(/outside the approved calling window/i);
    expect(screen.getByLabelText('Engagement id')).toHaveValue(ENGAGEMENT_ID);
    expect((await screen.findAllByRole('radio'))[0]).toBeChecked();
  });

  it('clears the form only after a booking actually succeeds', async () => {
    renderPage();
    await openBookingForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Engagement id')).toHaveValue(''),
    );
  });

  it('keeps the chosen slot when a reschedule is refused', async () => {
    apiFns.reschedulePhoneAppointment.mockRejectedValue(
      new MockApiError('slot_in_past', 409),
    );
    renderPage();
    await openRescheduleForm();
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await screen.findByText(/in the past/i);
    expect((await screen.findAllByRole('radio'))[0]).toBeChecked();
  });
});

describe('the live region is real', () => {
  it('is mounted and empty BEFORE any message exists', async () => {
    // A role=status element inserted together with its text is frequently not
    // announced at all — the assistive technology has to be observing the
    // region before the text arrives.
    renderPage();
    await screen.findByRole('table');

    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region.textContent).toBe('');
  });

  it('is the ONLY live region while a mutation re-reads the calendar', async () => {
    // The shared LoadingState is itself role=status. Blanking the view on a
    // same-week re-read would mount a second one that talks over the outcome.
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Appointment cancelled.'),
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('keeps the calendar on screen during a same-week re-read', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    // Never unmounted: no flash, and nothing that had focus is destroyed.
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('moves focus to the outcome instead of dropping it on the body', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the live region out of the normal tab order', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(screen.getByRole('status')).toHaveAttribute('tabindex', '-1');
  });
});

describe('the slot date field', () => {
  it('issues no request for an incomplete date', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));
    await screen.findAllByRole('radio');

    const before = apiFns.getPhoneSlots.mock.calls.length;
    expect(before).toBe(1);

    // Clearing a type="date" input reports ''. Forwarding it would request
    // `?date=` and earn a shape error the operator cannot act on.
    await userEvent.clear(screen.getByLabelText('Date (IST)'));
    expect(apiFns.getPhoneSlots).toHaveBeenCalledTimes(before);
    for (const [date] of apiFns.getPhoneSlots.mock.calls) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('stored cancel reasons read as English', () => {
  it('names a substrate-written reason rather than printing its code', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({
        appointments: [
          appointment({ status: 'superseded', cancel_reason: 'superseded' }),
        ],
      }),
    );
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));

    expect(await screen.findByText('Superseded by a reschedule')).toBeInTheDocument();
  });
});
