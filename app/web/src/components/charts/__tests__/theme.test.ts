/**
 * Charts take every colour from the tokens, in one place, and never animate in.
 * The stylesheet is not loaded under jsdom, so the test declares the real
 * index.css :root block on the document before reading it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { chartPalette, chartTheme } from '..';

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const rootBlock = /:root \{([\s\S]*?)\n {2}\}/.exec(CSS)![1];

const value = (name: string) =>
  new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(rootBlock)![1];

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

  it('cycles through ink steps, and never the voice hue or a fault colour', () => {
    const { colors } = chartPalette();
    expect(colors.length).toBeGreaterThanOrEqual(4);
    expect(new Set(colors).size).toBe(colors.length);
    for (const colour of colors) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    for (const banned of ['--voice', '--voice-mark', '--danger', '--wash']) {
      expect(colors).not.toContain(value(banned));
    }
  });

  it('is the only chart file that names a colour', () => {
    const series = readFileSync(resolve(process.cwd(), 'src/components/charts/series.ts'), 'utf8');
    expect(series).not.toMatch(/#[0-9a-fA-F]{6}\b|\brgba?\(/);
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
