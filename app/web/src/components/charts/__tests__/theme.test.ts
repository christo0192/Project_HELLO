/**
 * Chart theme palettes: light/dark derivation + reduced-motion animation gate.
 */
import { describe, it, expect } from 'vitest';
import { chartPalette, chartTheme } from '..';

describe('chartPalette', () => {
  it('uses the approved categorical cycle in light mode', () => {
    const light = chartPalette('light');
    expect(light.colors.slice(0, 4)).toEqual(['#4E6BA6', '#398AA2', '#1E7590', '#D8B5BE']);
    expect(light.text).toBe('#0f172a');
    expect(light.splitLine).toBe('#eaeef6');
  });

  it('keeps the approved palette under the legacy dark compatibility mode', () => {
    const dark = chartPalette('dark');
    expect(dark.colors[0]).toBe('#4E6BA6');
    expect(dark.text).toBe('#0f172a');
    expect(dark.splitLine).toBe('#eaeef6');
    expect(dark.tooltipBg).toBe('#ffffff');
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
