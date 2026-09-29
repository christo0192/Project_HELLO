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
 * ── SEVEN DAYS, ALWAYS ────────────────────────────────────────────────
 * The table is `table-fixed` across the full content width from `sm` up: the
 * time gutter takes a fixed 4.5rem and the seven days share the rest equally,
 * so a busy Wednesday cannot push Sunday out of view (it used to: auto layout
 * plus a 9rem minimum per day showed Mon–Wed at 1440px and scrolled the rest).
 * Appointment chips stack their content to fit the column instead. Below
 * `sm` the grid is not the default view; if a deep link asks for it there, it
 * keeps a minimum width and scrolls inside its panel rather than crushing
 * seven columns into a phone (WCAG 1.4.10 — scroll, never clip).
 *
 * ── THE DETAIL OPENS WHERE YOU CLICKED ────────────────────────────────
 * When `detail` is given, it is rendered as a full-width row directly under
 * the band that holds the selected appointment (or under the "outside the
 * calling window" row). The operator's eye does not travel to another part of
 * the page, the chip they pressed does not move, and in tab order the detail
 * follows the band it describes instead of the whole week. The row carries no
 * row header on purpose: it is not a time band, and it names itself as a
 * region ("Selected appointment").
 *
 * ── NOTHING IS EVER DROPPED ───────────────────────────────────────────
 * The bands are derived from the window the API reports, not from a constant
 * compiled into this file. If an appointment starts outside those bands — a
 * window that moved after the row was written, a substrate change this UI has
 * not been taught — it is collected into a trailing "outside the calling
 * window" row rather than falling through the grid unseen. A calendar that
 * silently hides a scheduled call is worse than one that looks untidy.
 */

import { Fragment, type ReactNode } from 'react';
import type { PhoneCalendarAppointment, PhoneWindow } from '../../types';
import { GlassPanel, Table, THead, TBody, Th, Td, cx } from '../design';
import {
  formatIstBandLabel,
  formatIstDayLabel,
  formatIstLongDayLabel,
  type IstDate,
} from '../../lib/ist-datetime';
import { PhoneAppointmentButton } from './PhoneAppointmentButton';
import { cellKey, placeAppointments, windowBands, type PhoneTimeBand } from './phoneGrid';

export interface PhoneWeekTableProps {
  weekDates: IstDate[];
  appointments: ReadonlyArray<PhoneCalendarAppointment>;
  window: PhoneWindow | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** IST date of "today", so the current column can be marked truthfully. */
  today: IstDate;
  /**
   * The selected appointment's detail, rendered inline under its band. Omit
   * it to render the detail elsewhere (the page does so on a narrow screen,
   * where this table scrolls sideways and an inline row would scroll with it).
   */
  detail?: ReactNode;
}

/**
 * The band's row header: `09:00` on screen, the full `09:00 to 10:00 IST`
 * spoken. The visible start time is how every calendar labels an hour row;
 * the rest is in the DOM for assistive technology (and a row header's text is
 * still the complete band label, which a test pins).
 */
function BandLabel({ band }: { band: PhoneTimeBand }) {
  const full = formatIstBandLabel(band.startHour, band.endHour);
  const shown = `${String(band.startHour).padStart(2, '0')}:00`;
  if (!full.startsWith(shown)) return <>{full}</>;
  return (
    <>
      {shown}
      <span className="sr-only">{full.slice(shown.length)}</span>
    </>
  );
}

export function PhoneWeekTable({
  weekDates,
  appointments,
  window,
  selectedId,
  onSelect,
  today,
  detail,
}: PhoneWeekTableProps) {
  const bands = windowBands(window);
  const { byCell, outside } = placeAppointments(appointments, weekDates, bands);

  // Which row the inline detail follows: the band holding the selection, or
  // the overflow row. Found from the same placement the cells use, so the
  // detail can never open under a band the chip is not in.
  const detailBand =
    detail && selectedId
      ? bands.find((band) =>
          weekDates.some((date) =>
            (byCell.get(cellKey(date, band.startHour)) ?? []).some((a) => a.id === selectedId),
          ),
        ) ?? null
      : null;
  const detailAfterOutside =
    Boolean(detail && selectedId) && outside.some((a) => a.id === selectedId);

  const detailRow = (
    <tr className="align-top">
      <td colSpan={weekDates.length + 1} className="border-b border-glass-ring bg-white/75 p-0">
        {detail}
      </td>
    </tr>
  );

  return (
    /*
      One glass surface for the whole grid; the table itself is `bare` so the
      panel and the table are not two stacked materials.
    */
    <GlassPanel padding="none" className="overflow-hidden">
      <Table
        bare
        caption="Phone screening week — calling times in India Standard Time down the rows, calendar days across the columns"
        className="table-fixed max-sm:!min-w-[46rem]"
      >
        <colgroup>
          <col className="w-[4.5rem]" />
          {weekDates.map((date) => (
            <col key={date} />
          ))}
        </colgroup>
        <THead>
          <tr>
            {/*
              The corner cell of a two-axis table. It labels the row-header
              column, so it is a `col` header for those headers rather than an
              empty cell. "IST" is exactly what an operator needs to know about
              that column, and it is the one place the zone is shown in the
              grid; the long form is what is announced.
            */}
            <Th scope="col" className="whitespace-nowrap !px-3">
              <span aria-hidden="true">IST</span>
              <span className="sr-only">IST time</span>
            </Th>
            {weekDates.map((date) => {
              const isToday = date === today;
              return (
                <Th
                  key={date}
                  scope="col"
                  className={cx(
                    'whitespace-nowrap border-l border-glass-ring !px-2.5',
                    isToday && '!bg-white',
                  )}
                >
                  {/*
                    The abbreviated label is shown; the unabbreviated one is
                    what assistive technology announces. "Mon 24 Aug" is
                    scannable in a narrow column, but "Mon" read aloud is a
                    guess between Monday and month.
                  */}
                  <span
                    aria-hidden="true"
                    className={cx(
                      'text-meta font-medium tabular-nums',
                      isToday ? 'font-semibold text-ink' : 'text-ink-secondary',
                    )}
                  >
                    {formatIstDayLabel(date)}
                  </span>
                  <span className="sr-only">{formatIstLongDayLabel(date)}</span>
                  {isToday && (
                    <span className="ml-1.5 text-meta font-medium normal-case text-info">
                      Today
                    </span>
                  )}
                </Th>
              );
            })}
          </tr>
        </THead>
        <TBody>
          {bands.map((band) => (
            <Fragment key={band.startHour}>
              <tr className="align-top">
                <Th
                  scope="row"
                  className="whitespace-nowrap !bg-transparent !px-3 !pt-2 text-left !align-top tabular-nums"
                >
                  <BandLabel band={band} />
                </Th>
                {weekDates.map((date) => {
                  const inCell = byCell.get(cellKey(date, band.startHour)) ?? [];
                  return (
                    <Td
                      key={date}
                      className={cx(
                        'border-l !px-1.5 !py-1.5 !align-top',
                        date === today && 'bg-white/45',
                      )}
                    >
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
              {detailBand === band && detailRow}
            </Fragment>
          ))}

          {outside.length > 0 && (
            /* Tinted, because these rows are outside the calling window. */
            <tr className="bg-ink/[0.03] align-top">
              <Th
                scope="row"
                className="whitespace-normal !bg-transparent !px-3 !pt-2 text-left !align-top leading-4"
              >
                Outside the calling window
              </Th>
              <Td colSpan={weekDates.length} className="border-l !px-2.5 !py-2 !align-top">
                <p className="mb-2 max-w-[70ch] text-label text-ink-tertiary">
                  These appointments start outside the {formatIstBandLabel(
                    bands[0].startHour,
                    bands[bands.length - 1].endHour,
                  )}{' '}
                  window reported by the API, or on a day outside this week. They
                  are listed here rather than hidden.
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {outside.map((appt) => (
                    <li key={appt.id} className="w-48">
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
          {detailAfterOutside && detailRow}
        </TBody>
      </Table>
    </GlassPanel>
  );
}
