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
    expect(light.splitLine).toBe('#f1f5f9'); // spec: chart-support gridline
  });

  it('keeps the approved palette under the legacy dark compatibility mode', () => {
    const dark = chartPalette('dark');
    expect(dark.colors[0]).toBe('#4E6BA6');
    expect(dark.text).toBe('#0f172a');
    expect(dark.splitLine).toBe('#f1f5f9');
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
    // Glass tooltip: translucent white over the hairline ring; the opaque
    // palette values remain available for chart chrome (slice borders).
    expect(String(tooltip.backgroundColor)).toMatch(/^rgba\(255, 255, 255/);
    expect(palette.tooltipBg).toBe('#ffffff');
  });
});
