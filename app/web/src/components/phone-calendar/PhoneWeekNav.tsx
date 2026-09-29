/**
 * The calendar's own header: which week is on screen, and how to move it.
 *
 * It lives in the toolbar's top band rather than in the page header because
 * it is a CALENDAR control (the page header keeps the page's one primary
 * action). The week is named as a heading, in the page's one date format
 * (`Mon 14 Sept`), with the year added only when the week is not in the
 * current one. Previous / next are chevron buttons whose accessible names say
 * exactly what they do; "This week" is the only word-button.
 *
 * Refresh sits here too, quietly: it re-reads the week on screen, which is
 * what this band is about.
 */

import { Button } from '../design';
import { addIstDays, formatIstDayLabel, type IstDate } from '../../lib/ist-datetime';

export interface PhoneWeekNavProps {
  weekStart: IstDate;
  today: IstDate;
  onPrevious: () => void;
  onThisWeek: () => void;
  onNext: () => void;
  onRefresh: () => void;
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d={direction === 'left' ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'} />
    </svg>
  );
}

/** `Mon 14 Sept – Sun 20 Sept`, with the year only when it is not this one. */
function phoneWeekHeading(weekStart: IstDate, today: IstDate): string {
  const end = addIstDays(weekStart, 6);
  const range = `${formatIstDayLabel(weekStart)} – ${formatIstDayLabel(end)}`;
  const endYear = end.slice(0, 4);
  return endYear === today.slice(0, 4) ? range : `${range} ${endYear}`;
}

export function PhoneWeekNav({
  weekStart,
  today,
  onPrevious,
  onThisWeek,
  onNext,
  onRefresh,
}: PhoneWeekNavProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav aria-label="Week" className="flex items-center gap-1.5">
        <Button
          size="lg"
          variant="secondary"
          onClick={onPrevious}
          aria-label="Previous week"
          className="w-11 !px-0"
        >
          <Chevron direction="left" />
        </Button>
        <Button size="lg" variant="secondary" onClick={onThisWeek}>
          This week
        </Button>
        <Button
          size="lg"
          variant="secondary"
          onClick={onNext}
          aria-label="Next week"
          className="w-11 !px-0"
        >
          <Chevron direction="right" />
        </Button>
      </nav>
      <h2 className="text-section text-ink tabular-nums">
        {phoneWeekHeading(weekStart, today)}
      </h2>
      <Button size="lg" variant="ghost" onClick={onRefresh} className="!px-3">
        Refresh
      </Button>
    </div>
  );
}
