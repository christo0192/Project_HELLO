/**
 * What the Screening performance charts hand to ECharts, so that a colour's meaning is
 * asserted rather than a canvas jsdom cannot draw.
 *
 * The owner's review of 2026-11-06 found "Screening outcomes" backwards: qualified blue
 * and disqualified green, because each series took its place in the cycle. `LineChart`
 * honours a family it is given, which proves nothing about this chart, so this test
 * fails if this chart stops giving them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import type { EChartsOption } from 'echarts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreeningKpis } from './ScreeningKpis';

const drawn = vi.hoisted(() => ({ options: [] as EChartsOption[] }));

vi.mock('../charts/EChart', () => ({
  EChart: ({ option }: { option: EChartsOption }) => {
    drawn.options.push(option);
    return null;
  },
}));

const { getScreeningFunnel } = vi.hoisted(() => ({ getScreeningFunnel: vi.fn() }));

vi.mock('../../api', () => ({
  api: { getScreeningFunnel: (...args: unknown[]) => getScreeningFunnel(...args), listRoles: async () => [] },
  ApiError: class extends Error {},
}));

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const rootBlock = /:root \{([\s\S]*?)\n {2}\}/.exec(CSS)![1];
const value = (name: string) => new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(rootBlock)![1];

interface DrawnLine {
  name: string;
  lineStyle: { color: string; type?: unknown };
  itemStyle: { color: string };
  symbol: string;
}

/** The line this name was last drawn as. */
function line(name: string): DrawnLine {
  const lines = drawn.options.flatMap((option) => option.series as unknown as DrawnLine[]);
  const found = lines.filter((series) => series.name === name).at(-1);
  if (!found) throw new Error(`no series named "${name}" among ${lines.map((series) => series.name).join(', ')}`);
  return found;
}

const SERIES = [
  { cohort_day: '2026-09-14', dialed: 10, connected: 5, scored: 4, qualified: 1, disqualified: 3 },
  { cohort_day: '2026-09-15', dialed: 8, connected: 6, scored: 5, qualified: 3, disqualified: 2 },
];

let style: HTMLStyleElement;

beforeEach(() => {
  drawn.options = [];
  style = document.createElement('style');
  style.textContent = `:root {${rootBlock}}`;
  document.head.appendChild(style);
  getScreeningFunnel.mockResolvedValue({
    range: { from: '2026-08-18', to: '2026-09-16' },
    totals: { dialed: 18, connected: 11, scored: 9, qualified: 4, disqualified: 5 },
    conversions: { hr_advance_rate: null },
    series: SERIES,
    refreshed_at: '2026-09-16T06:00:00Z',
    meta: {
      hr_tracking_configured: true,
      schema_current: true,
      rollup_refreshed_at: '2026-09-16T06:00:00Z',
      rollup_freshness_known: true,
      refresh_window_days: 30,
    },
  });
});

afterEach(() => style.remove());

describe('Screening outcomes', () => {
  it('draws qualified as a ready result and disqualified as closed, never by a place in the cycle', async () => {
    render(<ScreeningKpis />);
    await waitFor(() => expect(line('Bot qualified').lineStyle.color).toBe(value('--ready')));
    expect(line('Bot qualified').itemStyle.color).toBe(value('--ready'));
    expect(line('Bot disqualified').lineStyle.color).toBe(value('--closed'));
    expect(line('Bot disqualified').itemStyle.color).toBe(value('--closed'));
  });

  it('keeps the two apart by more than colour: a dash and another marker', async () => {
    render(<ScreeningKpis />);
    await waitFor(() => expect(line('Bot disqualified')).toBeTruthy());
    expect(line('Bot disqualified').lineStyle.type).not.toEqual(line('Bot qualified').lineStyle.type);
    expect(line('Bot disqualified').symbol).not.toBe(line('Bot qualified').symbol);
  });
});

describe('Connect rate', () => {
  it('draws a call being worked as underway', async () => {
    render(<ScreeningKpis />);
    await waitFor(() => expect(line('Daily connect rate').lineStyle.color).toBe(value('--moving')));
  });
});
