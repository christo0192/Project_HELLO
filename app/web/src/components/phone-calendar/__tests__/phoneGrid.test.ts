/**
 * Placement decides whether a scheduled call is VISIBLE. A row that falls
 * through the grid is worse than a rendering bug: an operator concludes there
 * is no call at that time. These tests are mostly about the rows that do not
 * fit.
 */
import { describe, it, expect } from 'vitest';
import {
  FALLBACK_CLOSE_HOUR,
  FALLBACK_OPEN_HOUR,
  cellKey,
  groupByIstDay,
  parseIstHour,
  placeAppointments,
  windowBands,
} from '../phoneGrid';
import { istWeekDates } from '../../../lib/ist-datetime';
import { WINDOW, appointment } from './phoneFixtures';

const WEEK = istWeekDates('2026-08-24');

describe('parseIstHour', () => {
  it('reads the leading hour of a wall-clock string', () => {
    expect(parseIstHour('09:00:00')).toBe(9);
    expect(parseIstHour('21:00')).toBe(21);
    expect(parseIstHour(' 9:30 ')).toBe(9);
  });

  it('returns null rather than guessing', () => {
    expect(parseIstHour(null)).toBeNull();
    expect(parseIstHour(undefined)).toBeNull();
    expect(parseIstHour('morning')).toBeNull();
    expect(parseIstHour('99:00')).toBeNull();
  });
});

describe('windowBands', () => {
  it('derives twelve hourly bands from the approved window', () => {
    const bands = windowBands(WINDOW);
    expect(bands).toHaveLength(12);
    expect(bands[0]).toEqual({ startHour: 9, endHour: 10 });
    expect(bands[11]).toEqual({ startHour: 20, endHour: 21 });
  });

  it('follows the window the API reports rather than a compiled-in constant', () => {
    const bands = windowBands({ ...WINDOW, open_ist: '10:00:00', close_ist: '13:00:00' });
    expect(bands.map((b) => b.startHour)).toEqual([10, 11, 12]);
  });

  it('falls back to the documented window when the API window is unreadable', () => {
    for (const bad of [null, { ...WINDOW, open_ist: 'x', close_ist: 'y' }]) {
      const bands = windowBands(bad);
      expect(bands[0].startHour).toBe(FALLBACK_OPEN_HOUR);
      expect(bands[bands.length - 1].endHour).toBe(FALLBACK_CLOSE_HOUR);
    }
  });

  it('never returns an empty band list, even for an inverted window', () => {
    const bands = windowBands({ ...WINDOW, open_ist: '21:00:00', close_ist: '09:00:00' });
    expect(bands.length).toBeGreaterThan(0);
  });
});

describe('placeAppointments', () => {
  const bands = windowBands(WINDOW);

  it('places a call in the cell its IST start falls in', () => {
    // 03:30 UTC == 09:00 IST on Wednesday the 26th.
    const appt = appointment({ starts_at: '2026-08-26T03:30:00Z' });
    const { byCell, outside } = placeAppointments([appt], WEEK, bands);
    expect(outside).toHaveLength(0);
    expect(byCell.get(cellKey('2026-08-26', 9))).toEqual([appt]);
  });

  it('files a late-evening UTC instant under the NEXT IST day', () => {
    // 20:30 UTC Tuesday is 02:00 IST Wednesday — outside the window, so it
    // must appear in `outside` rather than under Tuesday.
    const appt = appointment({ starts_at: '2026-08-25T20:30:00Z' });
    const { byCell, outside } = placeAppointments([appt], WEEK, bands);
    expect(byCell.size).toBe(0);
    expect(outside).toEqual([appt]);
  });

  it('places by the instant, not by the nullable display fields', () => {
    // `ist_start` is null here. Deriving from it would drop the row.
    const appt = appointment({
      starts_at: '2026-08-26T03:30:00Z',
      ist_start: null,
      ist_end: null,
      ist_date: '',
    });
    const { byCell, outside } = placeAppointments([appt], WEEK, bands);
    expect(outside).toHaveLength(0);
    expect(byCell.get(cellKey('2026-08-26', 9))).toEqual([appt]);
  });

  it('surfaces rather than drops a row outside the window or the week', () => {
    const beforeOpen = appointment({ id: 'a', starts_at: '2026-08-26T01:00:00Z' });
    const nextWeek = appointment({ id: 'b', starts_at: '2026-09-02T03:30:00Z' });
    const unreadable = appointment({ id: 'c', starts_at: 'not-an-instant' });
    const { byCell, outside } = placeAppointments(
      [beforeOpen, nextWeek, unreadable],
      WEEK,
      bands,
    );
    expect(byCell.size).toBe(0);
    expect(outside.map((a) => a.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps every row: placed plus outside always equals the input', () => {
    const input = [
      appointment({ id: 'a', starts_at: '2026-08-26T03:30:00Z' }),
      appointment({ id: 'b', starts_at: '2026-08-26T13:00:00Z' }),
      appointment({ id: 'c', starts_at: '2026-08-25T20:30:00Z' }),
      appointment({ id: 'd', starts_at: 'nope' }),
    ];
    const { byCell, outside } = placeAppointments(input, WEEK, bands);
    const placed = [...byCell.values()].flat();
    expect(placed.length + outside.length).toBe(input.length);
    expect([...placed, ...outside].map((a) => a.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('orders a shared cell by start then id, stably', () => {
    const later = appointment({ id: 'z', starts_at: '2026-08-26T03:45:00Z' });
    const earlyB = appointment({ id: 'b', starts_at: '2026-08-26T03:30:00Z' });
    const earlyA = appointment({ id: 'a', starts_at: '2026-08-26T03:30:00Z' });
    const { byCell } = placeAppointments([later, earlyB, earlyA], WEEK, bands);
    expect(byCell.get(cellKey('2026-08-26', 9))?.map((a) => a.id)).toEqual([
      'a',
      'b',
      'z',
    ]);
  });

  it('keeps a call whose end falls after the close, since only the start is bounded', () => {
    // Starts 20:30 IST, ends 21:00 IST — legal, and must be in the last band.
    const appt = appointment({
      starts_at: '2026-08-26T15:00:00Z',
      ends_at: '2026-08-26T15:30:00Z',
    });
    const { byCell, outside } = placeAppointments([appt], WEEK, bands);
    expect(outside).toHaveLength(0);
    expect(byCell.get(cellKey('2026-08-26', 20))).toEqual([appt]);
  });
});

describe('groupByIstDay', () => {
  it('groups in week order and sorts within a day', () => {
    const wedLate = appointment({ id: 'w2', starts_at: '2026-08-26T10:00:00Z' });
    const wedEarly = appointment({ id: 'w1', starts_at: '2026-08-26T03:30:00Z' });
    const mon = appointment({ id: 'm1', starts_at: '2026-08-24T05:00:00Z' });
    const groups = groupByIstDay([wedLate, wedEarly, mon], WEEK);
    expect(groups.map((g) => g.date)).toEqual(['2026-08-24', '2026-08-26']);
    expect(groups[1].items.map((a) => a.id)).toEqual(['w1', 'w2']);
  });

  it('omits days with nothing on them rather than rendering empty groups', () => {
    const groups = groupByIstDay([appointment({ starts_at: '2026-08-26T03:30:00Z' })], WEEK);
    expect(groups).toHaveLength(1);
  });

  it('collects unplaceable rows into a trailing null-dated group', () => {
    const outsideWeek = appointment({ id: 'x', starts_at: '2026-09-10T03:30:00Z' });
    const groups = groupByIstDay(
      [appointment({ id: 'in', starts_at: '2026-08-26T03:30:00Z' }), outsideWeek],
      WEEK,
    );
    expect(groups[groups.length - 1].date).toBeNull();
    expect(groups[groups.length - 1].items.map((a) => a.id)).toEqual(['x']);
  });

  it('keeps every row', () => {
    const input = [
      appointment({ id: 'a', starts_at: '2026-08-26T03:30:00Z' }),
      appointment({ id: 'b', starts_at: '2026-09-10T03:30:00Z' }),
      appointment({ id: 'c', starts_at: 'nope' }),
    ];
    const groups = groupByIstDay(input, WEEK);
    expect(groups.flatMap((g) => g.items).map((a) => a.id).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
