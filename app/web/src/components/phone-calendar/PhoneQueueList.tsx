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
 *
 * ── BOUNDED, NOT ENDLESS ──────────────────────────────────────────────
 * A full week can run far past the fold, so the list lives in a focusable,
 * labelled `ScrollArea` and each IST day keeps a sticky label while its own
 * appointments scroll under it.
 */

import type { PhoneCalendarAppointment } from '../../types';
import { GlassPanel, RevealGroup, RevealItem, ScrollArea } from '../design';
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
    <GlassPanel padding="none" className="overflow-hidden">
      <ScrollArea maxHeight="40rem" label="Queue" className="px-4 sm:px-5">
        <div>
          {groups.map((group) => {
            const heading =
              group.date === null
                ? 'Outside this week'
                : formatIstLongDayLabel(group.date);
            return (
              <section key={group.date ?? 'outside'} className="mb-5 last:mb-0">
                {/*
                  Sticky so the day a row belongs to stays on screen while its
                  appointments scroll. The backdrop is opaque enough that the
                  chips passing underneath never show through the label.
                */}
                <h2 className="sticky top-0 z-10 -mx-1 mb-2 flex flex-wrap items-baseline gap-2 rounded-[10px] bg-white/80 px-1 py-1 text-[13px] font-medium text-ink backdrop-blur-sm">
                  {heading}
                  {group.date === today && (
                    <span className="text-xs font-medium text-info">Today</span>
                  )}
                  <span className="text-xs font-normal text-ink-tertiary">
                    {group.items.length === 1
                      ? '1 appointment'
                      : `${group.items.length} appointments`}
                  </span>
                </h2>
                <RevealGroup as="ul" className="flex flex-col gap-2">
                  {group.items.map((appt) => (
                    <RevealItem as="li" key={appt.id}>
                      <PhoneAppointmentButton
                        appointment={appt}
                        selected={appt.id === selectedId}
                        onSelect={onSelect}
                        showDate={group.date === null}
                      />
                    </RevealItem>
                  ))}
                </RevealGroup>
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </GlassPanel>
  );
}
