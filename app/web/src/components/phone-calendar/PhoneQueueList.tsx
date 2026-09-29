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
 * ── ONE SURFACE, HAIRLINES BETWEEN ROWS ───────────────────────────────
 * Each day is a group of rows on the panel itself, separated by hairlines —
 * not a stack of floating white cards. A list reads as a list; the selected
 * row is the only one lifted onto a white chip.
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
      <ScrollArea maxHeight="40rem" label="Queue" className="px-2 sm:px-3">
        <div>
          {groups.map((group) => {
            const heading =
              group.date === null
                ? 'Outside this week'
                : formatIstLongDayLabel(group.date);
            return (
              <section key={group.date ?? 'outside'} className="mb-4 last:mb-0">
                {/*
                  Sticky so the day a row belongs to stays on screen while its
                  appointments scroll. The backdrop is opaque enough that the
                  rows passing underneath never show through the label.
                */}
                <h3 className="sticky top-0 z-10 mb-1 flex flex-wrap items-baseline gap-x-2 rounded-[10px] bg-white/85 px-3 py-1.5 text-label font-semibold text-ink backdrop-blur-sm">
                  {heading}
                  {group.date === today && (
                    <span className="text-meta font-medium text-info">Today</span>
                  )}
                  <span className="text-meta font-normal tabular-nums text-ink-tertiary">
                    {group.items.length === 1
                      ? '1 appointment'
                      : `${group.items.length} appointments`}
                  </span>
                </h3>
                <RevealGroup as="ul" className="flex flex-col divide-y divide-[var(--glass-ring)]">
                  {group.items.map((appt) => (
                    <RevealItem as="li" key={appt.id} className="py-1">
                      <PhoneAppointmentButton
                        appointment={appt}
                        selected={appt.id === selectedId}
                        onSelect={onSelect}
                        showDate={group.date === null}
                        layout="row"
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
