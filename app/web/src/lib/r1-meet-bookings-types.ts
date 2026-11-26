/**
 * The Meet bookings wire shapes (M034 S10), as `GET /api/interview-rounds/meet-bookings` answers them
 * (app/api/src/lib/r1/meet/bookings-read.ts). Types and constant lists only, with no runtime import, so
 * the offline e2e harness can type its fixture against the same shapes the page reads (as
 * `impact-types.ts` and `r1-types.ts` do). The reader and the words are `r1-meet-bookings.ts`.
 */

/** The booking statuses, in the API's order. */
export const R1_MEET_BOOKING_STATUSES = [
  'pending',
  'unmatched_application',
  'unmapped_scheduler',
  'blocked',
  'bot_scheduled',
  'bot_joining',
  'human_present',
  'in_call',
  'completed',
  'cancelled',
  'failed',
  'drained',
] as const;
export type R1MeetBookingStatus = (typeof R1_MEET_BOOKING_STATUSES)[number];

/** The booking reasons, in the API's order. */
export const R1_MEET_BOOKING_REASONS = [
  'dex_absent',
  'cancelled',
  'in_past',
  'not_scheduled',
  'no_attester',
  'no_meet_link',
  'eligible',
  'application_unknown',
  'application_terminal',
  'scheduler_unmapped',
  'created_by_unknown',
  'disabled',
  'paused',
  'candidate_ineligible',
  'role_not_configured',
  'round_active',
  'phone_engagement_active',
  'phone_assessment_pending',
  'capacity_exhausted',
  'consent_template_unavailable',
  'slot_too_far',
  'bot_cap_reached',
  'bot_create_failed',
  'bot_fatal',
  'event_removed',
  'round_cancelled',
  'round_expired',
  'no_show',
  'admission_refused',
  'multiple_humans',
  'attempt_settled',
  'flag_off',
  'candidate_cancelled',
  'invite_undeliverable',
] as const;
export type R1MeetBookingReason = (typeof R1_MEET_BOOKING_REASONS)[number];

/** Where a booking came from, in the API's order: HR in Ashby, or the candidate on the public booking page. */
export const R1_MEET_BOOKING_SOURCES = ['ashby', 'public_page'] as const;
export type R1MeetBookingSource = (typeof R1_MEET_BOOKING_SOURCES)[number];

/** One booking. `status` and `reason` stay plain text: a newer API may know more than this page. */
export interface R1MeetBooking {
  id: string;
  candidate_id: string | null;
  round_id: string | null;
  status: string;
  reason: string;
  start_at: string;
  end_at: string;
  created_at: string;
  updated_at: string;
  /** The meeting bot's generation, and not a revision of the row: a status change leaves it as it was. */
  version: number;
  /**
   * Where the booking came from (M035): required, and only one of the two values. Unlike `status` and
   * `reason` this is not plain text, so a value this page does not know refuses the page.
   */
  source: R1MeetBookingSource;
}

export interface R1MeetBookingsBody {
  meet_enabled: boolean;
  bookings: R1MeetBooking[];
  next_cursor: string | null;
}

export interface R1MeetBookingsQuery {
  status?: R1MeetBookingStatus | null;
  /** Slots starting at or after this instant. */
  from?: string | null;
  /** Slots starting before this instant (exclusive). */
  to?: string | null;
  /** The `next_cursor` of the page before, unchanged, with the same filters. */
  cursor?: string | null;
}
