/**
 * The exported report is a standalone file, so it restates the app's tokens
 * instead of importing them. It is also the one place dark mode can still be
 * reached: a reader opens it in their own browser, under their own system theme.
 * So this pins the light values to index.css and checks both schemes for AA.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPORT_CSS } from './reportStyles';

const indexCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function appToken(name: string): string {
  const hit = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(indexCss);
  if (!hit) throw new Error(`${name} is not a hex in index.css`);
  return hit[1].toLowerCase();
}

/** The `--x: #hex;` declarations of one block of the report's stylesheet. */
function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const darkStart = REPORT_CSS.indexOf('@media (prefers-color-scheme: dark)');
const LIGHT = declarations(REPORT_CSS.slice(0, darkStart));
const DARK = declarations(REPORT_CSS.slice(darkStart, REPORT_CSS.indexOf('* { box-sizing')));

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Every text pair the report paints: [foreground, background]. */
const TEXT_PAIRS: Array<[string, string]> = [
  ['ink', 'bg'],
  ['ink', 'panel'],
  ['ink', 'sunken'],
  ['ink', 'active'],
  ['ink-2', 'bg'],
  ['ink-2', 'panel'],
  ['ink-2', 'sunken'],
  ['accent', 'panel'],
  ['accent', 'accent-bg'],
  ['pos', 'pos-bg'],
  ['warn', 'warn-bg'],
  ['neg', 'neg-bg'],
];

describe('the report stylesheet', () => {
  it.each([
    ['bg', '--desk'],
    ['panel', '--paper'],
    ['sunken', '--field'],
    ['ink', '--ink'],
    ['ink-2', '--ink-2'],
    ['line', '--rule-2'],
    ['active', '--rule'],
  ])('light --%s matches the app token %s', (reportName, token) => {
    expect(LIGHT[reportName]).toBe(appToken(token));
  });

  it('declares a dark counterpart for every light token', () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
    expect(Object.keys(LIGHT).length).toBeGreaterThanOrEqual(15);
  });

  it.each(TEXT_PAIRS)('%s on %s clears AA in both schemes', (fg, bg) => {
    expect(contrast(LIGHT[fg], LIGHT[bg]), 'light').toBeGreaterThanOrEqual(4.5);
    expect(contrast(DARK[fg], DARK[bg]), 'dark').toBeGreaterThanOrEqual(4.5);
  });

  it('keeps verdicts free of hue: positive, caution and negative are one ink', () => {
    for (const scheme of [LIGHT, DARK]) {
      expect(new Set([scheme.pos, scheme.warn, scheme.neg]).size).toBe(1);
    }
  });

  it('never uppercases a label or tracks one open', () => {
    expect(REPORT_CSS).not.toMatch(/text-transform:\s*uppercase/);
    const open = [...REPORT_CSS.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)].filter((m) => parseFloat(m[1]) > 0);
    expect(open).toEqual([]);
  });

  it('carries neither voice token: orange means the candidate speaking in the app', () => {
    expect(REPORT_CSS.toLowerCase()).not.toContain(appToken('--voice'));
    expect(REPORT_CSS.toLowerCase()).not.toContain(appToken('--voice-mark'));
  });
});
