/**
 * The queue view — the same week, read as a chronological work list.
 *
 * ── WHY A SECOND VIEW AT ALL ──────────────────────────────────────────
 * The grid answers "what does Wednesday afternoon look like". The queue
 * answers "what is next, and what did we miss" — which is the question an
 * operator working through the day actually has. They are two renderings of
 * ONE fetch, over one filtered row set, sharing one selection; switching
 * between them issues no request and cannot show different data.
 *
 * It is also the honest small-screen answer. A seven-column grid on a phone
 * either scrolls horizontally or lies about its layout; this view has one
 * column by construction, so on a narrow viewport it is the default rather
 * than a degraded fallback.
 */

import type { PhoneCalendarAppointment } from '../../types';
import { formatIstLongDayLabel, type IstDate } from '../../lib/ist-datetime';
import { PhoneAppointmentButton } from './PhoneAppointmentButton';
import { groupByIstDay } from './phoneGrid';

export interface PhoneQueueListProps {
  weekDates: IstDate[];
  appointments: ReadonlyArray<PhoneCalendarAppointment>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  today: IstDate;
}

export function PhoneQueueList({
  weekDates,
  appointments,
  selectedId,
  onSelect,
  today,
}: PhoneQueueListProps) {
  const groups = groupByIstDay(appointments, weekDates);

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5">
      {groups.map((group) => {
        const heading =
          group.date === null
            ? 'Outside this week'
            : formatIstLongDayLabel(group.date);
        return (
          <section key={group.date ?? 'outside'} className="mb-5 last:mb-0">
            <h2 className="mb-2 text-sm font-semibold text-ink">
              {heading}
              {group.date === today && (
                <span className="ml-2 text-xs font-medium text-brand-600 dark:text-brand-400">
                  Today
                </span>
              )}
              <span className="ml-2 text-xs font-normal text-ink-tertiary">
                {group.items.length === 1
                  ? '1 appointment'
                  : `${group.items.length} appointments`}
              </span>
            </h2>
            <ul className="flex flex-col gap-2">
              {group.items.map((appt) => (
                <li key={appt.id}>
                  <PhoneAppointmentButton
                    appointment={appt}
                    selected={appt.id === selectedId}
                    onSelect={onSelect}
                    showDate={group.date === null}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
