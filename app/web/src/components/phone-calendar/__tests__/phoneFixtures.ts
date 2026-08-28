/**
 * Shared HOISTED api mock and fixtures for the phone calendar tests.
 *
 * Same pattern as `mission-control/__tests__/apiMock.ts`: `vi.hoisted`
 * guarantees the mock object exists before any static import of `../api`, and
 * the hoisted value is re-exported through a normal const because a hoisted
 * binding cannot itself be exported.
 *
 * Every fixture below is SYNTHETIC. In particular no fixture contains a phone
 * number, an email address, a SIP identifier, a room name or any other
 * provider or contact token — partly because the API never returns them, and
 * partly because a fixture that contained one would make the PII guard in
 * these suites pass for the wrong reason.
 */
import { vi } from 'vitest';
import type {
  Candidate,
  MeResponse,
  PhoneCalendarAppointment,
  PhoneCalendarResponse,
  PhoneSlot,
  PhoneSlotsResponse,
  PhoneWindow,
} from '../../../types';

const hoisted = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  const fns = {
    getMe: vi.fn(),
    getPhoneCalendar: vi.fn(),
    getPhoneSlots: vi.fn(),
    listCandidates: vi.fn(),
    scheduleCandidatePhoneAppointment: vi.fn(),
    createPhoneAppointment: vi.fn(),
    reschedulePhoneAppointment: vi.fn(),
    cancelPhoneAppointment: vi.fn(),
  };

  const api = {
    getMe: fns.getMe,
    getPhoneCalendar: fns.getPhoneCalendar,
    getPhoneSlots: fns.getPhoneSlots,
    listCandidates: fns.listCandidates,
    scheduleCandidatePhoneAppointment: fns.scheduleCandidatePhoneAppointment,
    createPhoneAppointment: fns.createPhoneAppointment,
    reschedulePhoneAppointment: fns.reschedulePhoneAppointment,
    cancelPhoneAppointment: fns.cancelPhoneAppointment,
  };

  return { api, fns, ApiError };
});

export const phoneApi = hoisted;
export const apiFns = hoisted.fns;
export const MockApiError = hoisted.ApiError;

/** Total calls across every mocked endpoint — for delta assertions. */
export function totalApiCalls(): number {
  return Object.values(apiFns).reduce((n, fn) => n + fn.mock.calls.length, 0);
}

// ── Roles ────────────────────────────────────────────────────────────

export const ADMIN_ME: MeResponse = {
  user_id: 'u-admin',
  email: 'admin@example.com',
  role: 'admin',
} as unknown as MeResponse;

export const INTERVIEWER_ME: MeResponse = {
  user_id: 'u-interviewer',
  email: 'interviewer@example.com',
  role: 'interviewer',
} as unknown as MeResponse;

export const VIEWER_ME: MeResponse = {
  user_id: 'u-viewer',
  email: 'viewer@example.com',
  role: 'viewer',
} as unknown as MeResponse;

export const PHONE_BOOKING_CANDIDATES: Candidate[] = [{
  id: 'cand-1',
  name: 'Asha Rao',
  email: null,
  phone_e164: null,
  phone_valid: false,
  skills: [],
  experience_years: null,
  status: 'screening',
  role_id: null,
  created_at: '2026-08-20T10:00:00Z',
}];

// ── The approved calling window ──────────────────────────────────────

export const WINDOW: PhoneWindow = {
  time_zone: 'Asia/Kolkata',
  open_ist: '09:00:00',
  close_ist: '21:00:00',
};

/**
 * A fixed week for every test: Monday 2026-08-24 IST through Sunday
 * 2026-08-30 IST. Pinned so no test depends on the day it is run.
 */
export const WEEK_START = '2026-08-24';

/**
 * 2026-08-26 is a Wednesday. 09:00 IST that day is 03:30 UTC, which is a
 * useful instant precisely because the UTC calendar date and the IST calendar
 * date agree; the fixtures below also include an instant where they do NOT.
 */
export function appointment(
  over: Partial<PhoneCalendarAppointment> = {},
): PhoneCalendarAppointment {
  return {
    id: 'appt-1',
    engagement_id: '11111111-2222-4333-8444-555555555555',
    starts_at: '2026-08-26T09:00:00Z',
    ends_at: '2026-08-26T09:30:00Z',
    ist_date: '2026-08-26',
    ist_start: '14:30',
    ist_end: '15:00',
    status: 'scheduled',
    source: 'hr_manual',
    confirmed_at: null,
    cancel_reason: null,
    version: 1,
    created_at: '2026-08-20T10:00:00Z',
    updated_at: '2026-08-20T10:00:00Z',
    engagement_state: 'scheduled',
    candidate: {
      id: 'cand-1',
      name: 'Asha Rao',
      status: 'screening',
      reference: 'ATS-4417',
    },
    ...over,
  };
}

export function calendarResponse(
  over: Partial<PhoneCalendarResponse> = {},
): PhoneCalendarResponse {
  const appointments = over.appointments ?? [appointment()];
  return {
    ok: true,
    enabled: true,
    range: { from: '2026-08-23T18:30:00Z', to: '2026-08-30T18:30:00Z' },
    window: WINDOW,
    count: appointments.length,
    truncated: false,
    ...over,
    appointments,
  };
}

export function slot(over: Partial<PhoneSlot> = {}): PhoneSlot {
  return {
    starts_at: '2026-08-26T09:00:00Z',
    ends_at: '2026-08-26T09:30:00Z',
    ist_start: '14:30',
    ist_end: '15:00',
    booked: 0,
    remaining: 2,
    bookable: true,
    refusals: [],
    ...over,
  };
}

export function slotsResponse(
  over: Partial<PhoneSlotsResponse> = {},
): PhoneSlotsResponse {
  const slots = over.slots ?? [slot()];
  return {
    ok: true,
    enabled: true,
    date: '2026-08-26',
    window: WINDOW,
    slot_seconds: 1800,
    max_concurrent: 2,
    booked_total: 0,
    occupancy_truncated: false,
    ...over,
    slots,
  };
}
