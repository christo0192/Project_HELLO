/**
 * The week grid — a REAL table, not a grid of divs.
 *
 * ── WHY A SEMANTIC TABLE ──────────────────────────────────────────────
 * A calendar week is two-dimensional data: a call is identified by the
 * intersection of a day and a time band. A sighted operator reads that
 * intersection from position on screen. A screen-reader user gets it only if
 * the markup says so — which means `<th scope="col">` on every day, `<th
 * scope="row">` on every time band, and a `<caption>` naming what the table
 * is. Then "Wednesday 26 August, 14:00 to 15:00 IST" is announced with the
 * cell, and the position that sighted users read for free is available to
 * everyone (WCAG 1.3.1).
 *
 * Divs with `role="grid"` would have required us to re-implement all of that
 * by hand, and every appointment control would have needed its context
 * duplicated into an aria-label anyway.
 *
 * ── NOTHING IS EVER DROPPED ───────────────────────────────────────────
 * The bands are derived from the window the API reports, not from a constant
 * compiled into this file. If an appointment starts outside those bands — a
 * window that moved after the row was written, a substrate change this UI has
 * not been taught — it is collected into a trailing "outside the calling
 * window" row rather than falling through the grid unseen. A calendar that
 * silently hides a scheduled call is worse than one that looks untidy.
 */

import type { PhoneCalendarAppointment, PhoneWindow } from '../../types';
import { GlassPanel, Table, THead, TBody, Th, Td } from '../design';
import {
  formatIstBandLabel,
  formatIstDayLabel,
  formatIstLongDayLabel,
  type IstDate,
} from '../../lib/ist-datetime';
import { PhoneAppointmentButton } from './PhoneAppointmentButton';
import { cellKey, placeAppointments, windowBands } from './phoneGrid';

export interface PhoneWeekTableProps {
  weekDates: IstDate[];
  appointments: ReadonlyArray<PhoneCalendarAppointment>;
  window: PhoneWindow | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** IST date of "today", so the current column can be marked truthfully. */
  today: IstDate;
}

export function PhoneWeekTable({
  weekDates,
  appointments,
  window,
  selectedId,
  onSelect,
  today,
}: PhoneWeekTableProps) {
  const bands = windowBands(window);
  const { byCell, outside } = placeAppointments(appointments, weekDates, bands);

  return (
    /*
      One glass surface for the whole grid; the table itself is `bare` so the
      panel and the table are not two stacked materials. The inner scroll
      container keeps a seven-column week usable on a narrow viewport by
      scrolling it rather than clipping it (WCAG 1.4.10).
    */
    <GlassPanel padding="none" className="overflow-hidden">
      <Table bare caption="Phone screening week — calling times in India Standard Time down the rows, calendar days across the columns">
        <THead>
          <tr>
            {/*
              The corner cell of a two-axis table. It labels the row-header
              column, so it is a `col` header for those headers rather than an
              empty cell — and the text is visible, because "IST time" is
              exactly what an operator needs to know about that column.
            */}
            <Th scope="col" className="whitespace-nowrap">
              IST time
            </Th>
            {weekDates.map((date) => (
              <Th key={date} scope="col" className="whitespace-nowrap">
                {/*
                  The abbreviated label is shown; the unabbreviated one is what
                  assistive technology announces. "Mon 24 Aug" is scannable in a
                  narrow column, but "Mon" read aloud is a guess between Monday
                  and month.
                */}
                <span aria-hidden="true">{formatIstDayLabel(date)}</span>
                <span className="sr-only">{formatIstLongDayLabel(date)}</span>
                {date === today && (
                  <span className="ml-1.5 text-xs font-medium normal-case text-info">
                    Today
                  </span>
                )}
              </Th>
            ))}
          </tr>
        </THead>
        <TBody>
          {bands.map((band) => (
            <tr key={band.startHour} className="align-top">
              <Th
                scope="row"
                className="whitespace-nowrap border-r border-glass-ring text-left align-top"
              >
                {formatIstBandLabel(band.startHour, band.endHour)}
              </Th>
              {weekDates.map((date) => {
                const inCell = byCell.get(cellKey(date, band.startHour)) ?? [];
                return (
                  <Td key={date} className="min-w-[9rem] py-2 align-top">
                    {inCell.length > 0 && (
                      <ul className="flex flex-col gap-1.5">
                        {inCell.map((appt) => (
                          <li key={appt.id}>
                            <PhoneAppointmentButton
                              appointment={appt}
                              selected={appt.id === selectedId}
                              onSelect={onSelect}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                );
              })}
            </tr>
          ))}

          {outside.length > 0 && (
            /* Tinted, because these rows are outside the calling window. */
            <tr className="bg-ink/[0.03] align-top">
              <Th
                scope="row"
                className="whitespace-nowrap border-r border-glass-ring text-left align-top"
              >
                Outside the calling window
              </Th>
              <Td colSpan={weekDates.length} className="align-top">
                <p className="mb-2 text-[13px] leading-5 text-ink-tertiary">
                  These appointments start outside the {formatIstBandLabel(
                    bands[0].startHour,
                    bands[bands.length - 1].endHour,
                  )}{' '}
                  window reported by the API, or on a day outside this week. They
                  are listed here rather than hidden.
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {outside.map((appt) => (
                    <li key={appt.id}>
                      <PhoneAppointmentButton
                        appointment={appt}
                        selected={appt.id === selectedId}
                        onSelect={onSelect}
                        showDate
                      />
                    </li>
                  ))}
                </ul>
              </Td>
            </tr>
          )}
        </TBody>
      </Table>
    </GlassPanel>
  );
}
