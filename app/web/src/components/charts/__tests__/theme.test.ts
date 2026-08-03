/**
 * Chart theme palettes: light/dark derivation + reduced-motion animation gate.
 */
import { describe, it, expect } from 'vitest';
import { chartPalette, chartTheme } from '..';

describe('chartPalette', () => {
  it('uses logo cyan as the light primary', () => {
    const light = chartPalette('light');
    expect(light.colors[0]).toBe('#3996d2');
    expect(light.text).toBe('#101f31');
    expect(light.splitLine).toBe('#e2e8f0');
  });

  it('switches to bright navy-based colors in dark mode', () => {
    const dark = chartPalette('dark');
    expect(dark.colors[0]).toBe('#54a7d6');
    expect(dark.text).toBe('#e8eef5');
    expect(dark.splitLine).toBe('#1e3048');
    expect(dark.tooltipBg).toBe('#122032');
  });
});

describe('chartTheme', () => {
  it('disables animation under reduced motion', () => {
    expect(chartTheme('dark', true).base.animation).toBe(false);
    expect(chartTheme('light', true).base.animation).toBe(false);
  });

  it('enables animation by default', () => {
    expect(chartTheme('light', false).base.animation).toBe(true);
  });

  it('includes a themed tooltip base', () => {
    const { base, palette } = chartTheme('dark', false);
    const tooltip = base.tooltip as Record<string, unknown>;
    expect(tooltip.backgroundColor).toBe(palette.tooltipBg);
    expect(tooltip.borderColor).toBe(palette.tooltipBorder);
  });
});
