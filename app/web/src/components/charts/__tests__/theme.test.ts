/**
 * Charts take every colour from the tokens, in one place, and never animate in.
 * The stylesheet is not loaded under jsdom, so the test declares the real
 * index.css :root block on the document before reading it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { chartPalette, chartTheme } from '..';

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const rootBlock = /:root \{([\s\S]*?)\n {2}\}/.exec(CSS)![1];

const value = (name: string) =>
  new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(rootBlock)![1];

/** Every file that draws a chart or feeds one a series, without its tests. */
const CHART_SOURCES = ['src/components/charts', 'src/components/dashboard'].flatMap((dir) =>
  readdirSync(resolve(process.cwd(), dir), { recursive: true, encoding: 'utf8' })
    .map((rel) => `${dir}/${rel.replace(/\\/g, '/')}`)
    .filter((rel) => /\.tsx?$/.test(rel) && !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel)),
);

const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('chart colours come from the tokens', () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = `:root {${rootBlock}}`;
    document.head.appendChild(style);
  });
  afterEach(() => style.remove());

  it('reads text, axes and surfaces from index.css', () => {
    const palette = chartPalette();
    expect(palette.text).toBe(value('--ink'));
    expect(palette.subtext).toBe(value('--ink-3'));
    expect(palette.splitLine).toBe(value('--rule'));
    expect(palette.axisLine).toBe(value('--rule-2'));
    expect(palette.surface).toBe(value('--paper'));
    expect(palette.tooltipBg).toBe(value('--paper'));
    expect(palette.tooltipBorder).toBe(value('--rule-2'));
  });

  it('cycles through the ink steps in order, and never the voice hue or a fault colour', () => {
    const { colors } = chartPalette();
    expect(colors).toEqual(['--ink', '--ink-3', '--ai', '--ink-2', '--control'].map(value));
    expect(new Set(colors).size).toBe(colors.length);
    for (const banned of ['--voice', '--voice-mark', '--danger', '--wash']) {
      expect(colors).not.toContain(value(banned));
    }
  });

  it('reads the whole chart folder and the dashboard', () => {
    expect(CHART_SOURCES).toEqual(
      expect.arrayContaining(['src/components/charts/series.ts', 'src/components/dashboard/ScreeningKpis.tsx']),
    );
  });

  it.each(CHART_SOURCES)('%s names no colour of its own', (rel) => {
    const code = withoutComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/);
  });
});

describe('chartTheme', () => {
  it('never animates, at any setting', () => {
    const { base } = chartTheme();
    expect(base.animation).toBe(false);
    expect(base).not.toHaveProperty('animationDuration');
  });

  it('gives the tooltip an opaque ground and no blur', () => {
    const tooltip = chartTheme().base.tooltip as Record<string, unknown>;
    expect(String(tooltip.extraCssText)).not.toMatch(/blur/);
    expect(String(tooltip.backgroundColor)).not.toMatch(/rgba/);
  });
});
