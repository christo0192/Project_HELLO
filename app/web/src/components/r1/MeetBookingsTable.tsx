/**
 * The Meet bookings list: when, whom, where it is and why, where it came from (the public booking link
 * or Ashby), and when it was made and last changed.
 *
 * The read carries no name, so a row offers the way to the candidate and not who they are. It prints
 * words only: a status, a reason or a source by its code, an id and a version never reach the page. The
 * source is plain text with no colour: colour carries the four state families only. Every time is
 * India time and says so.
 */
import { Link } from 'react-router-dom';
import { TBody, THead, Table, Td, Th, Tr } from '../design';
import { Tag } from '../design/candidate';
import {
  meetBookingReasonText,
  meetBookingSlot,
  meetBookingSourceText,
  meetBookingStamp,
  meetBookingTerm,
} from '../../lib/r1-meet-bookings';
import type { R1MeetBooking } from '../../lib/r1-meet-bookings';

const ROW_LINK =
  'inline-flex min-h-6 items-center whitespace-nowrap font-medium text-ink underline underline-offset-2 hover:text-ink-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]';

const WIDE = 'hidden md:table-cell';

function Stamps({ booking }: { booking: R1MeetBooking }) {
  const created = meetBookingStamp(booking.created_at);
  const updated = meetBookingStamp(booking.updated_at);
  return (
    <>
      <p>Created {created}</p>
      {/* To the minute, as printed: a booking nobody has touched says one time, once. */}
      {updated !== created && <p>Updated {updated}</p>}
    </>
  );
}

function BookingRow({ booking }: { booking: R1MeetBooking }) {
  const { candidate_id: candidateId, round_id: roundId } = booking;
  const slot = meetBookingSlot(booking.start_at, booking.end_at);
  const term = meetBookingTerm(booking.status, booking.reason);
  const reason = meetBookingReasonText(booking.reason, booking.source);
  const source = meetBookingSourceText(booking.source);
  return (
    <Tr>
      <Td className="py-2.5">
        <p className="font-medium md:whitespace-nowrap">{slot.day}</p>
        <p className="text-label text-ink-secondary md:whitespace-nowrap">{slot.time}</p>
        {/* The columns this width has no room for. */}
        <div className="mt-0.5 text-meta text-ink-tertiary md:hidden">
          <p>Source: {source}</p>
          <Stamps booking={booking} />
        </div>
      </Td>
      <Td className="py-2.5">
        {candidateId === null ? (
          <span className="text-label text-ink-secondary">No candidate matched</span>
        ) : (
          // Every row says the same words, so each link carries its slot as its own name.
          <Link to={`/candidates/${candidateId}?tab=r1`} className={ROW_LINK}>
            Open candidate<span className="sr-only"> for {slot.text}</span>
          </Link>
        )}
        {roundId !== null && (
          <div className="mt-1">
            <Link to={`/interviews/${roundId}`} className={ROW_LINK}>
              Open R1 review<span className="sr-only"> for {slot.text}</span>
            </Link>
          </div>
        )}
      </Td>
      <Td className="py-2.5">
        <Tag tone={term.tone} srPrefix="Status:">{term.label}</Tag>
        {reason !== null && <p className="mt-1 max-w-xs text-meta text-ink-secondary">{reason}</p>}
      </Td>
      <Td className={`${WIDE} whitespace-nowrap py-2.5 text-label text-ink-secondary`}>{source}</Td>
      <Td className={`${WIDE} whitespace-nowrap py-2.5 text-label text-ink-secondary`}>
        <Stamps booking={booking} />
      </Td>
    </Tr>
  );
}

export function MeetBookingsTable({ bookings }: { bookings: readonly R1MeetBooking[] }) {
  return (
    <Table bare caption="Meet bookings" focusWhenScrolling>
      <THead>
        <tr>
          <Th>Slot (IST)</Th>
          <Th>Candidate</Th>
          <Th>Status</Th>
          <Th className={WIDE}>Source</Th>
          <Th className={WIDE}>Created and updated</Th>
        </tr>
      </THead>
      <TBody>
        {bookings.map((booking) => <BookingRow key={booking.id} booking={booking} />)}
      </TBody>
    </Table>
  );
}
