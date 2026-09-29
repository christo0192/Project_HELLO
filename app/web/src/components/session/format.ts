/**
 * Date and time words for the session and screening pages.
 *
 * One format per page (design brief): `d MMM` within the current year,
 * `d MMM yyyy` otherwise, and a 24-hour `HH:mm`. `Intl` is deliberately NOT
 * used for the month: the viewer's locale decides whether September is
 * "Sep" or "Sept" (en-GB/en-IN print "Sept" since CLDR 38), and two sibling
 * pages must not disagree. Times are the viewer's local clock; the page
 * never claims a zone it did not convert to.
 */

import { toValidDate } from '../../lib/datetime';
import type { DateInput } from '../../lib/datetime';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15 Sep, 15:51" (this year) or "15 Sep 2025, 15:51"; null when the value is not a real instant. */
export function formatSessionWhen(value: DateInput, now: Date = new Date()): string | null {
  const date = toValidDate(value);
  if (!date) return null;
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}, ${hh}:${mm}`;
}
