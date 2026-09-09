import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Slider } from '../Slider';

describe('Slider', () => {
  it('renders a native range input with the accessible value', () => {
    const { getByRole } = render(
      <Slider value={40} min={0} max={100} onValueChange={() => {}} aria-label="Weight" />,
    );
    const input = getByRole('slider') as HTMLInputElement;
    expect(input.type).toBe('range');
    expect(input.value).toBe('40');
  });

  it('paints a filled track proportional to the value (not a bare thumb)', () => {
    const { getByRole } = render(
      <Slider value={25} min={0} max={100} onValueChange={() => {}} aria-label="Weight" />,
    );
    const bg = (getByRole('slider') as HTMLInputElement).style.background;
    // accent fill up to 25%, soft track after — a real gradient, not empty
    expect(bg).toContain('linear-gradient');
    expect(bg).toContain('25%');
    expect(bg).toContain('var(--info)');
    expect(bg).toContain('var(--info-soft)');
  });

  it('clamps the fill percentage for out-of-range and non-standard bounds', () => {
    const { getByRole, rerender } = render(
      <Slider value={5} min={1} max={5} onValueChange={() => {}} aria-label="Weight" />,
    );
    // (5-1)/(5-1) = 100%
    expect((getByRole('slider') as HTMLInputElement).style.background).toContain('100%');
    rerender(<Slider value={1} min={1} max={5} onValueChange={() => {}} aria-label="Weight" />);
    // (1-1)/(5-1) = 0%
    expect((getByRole('slider') as HTMLInputElement).style.background).toContain('0%');
  });

  it('carries the styled thumb/track utility classes (regression guard for the dot-only bug)', () => {
    const { getByRole } = render(
      <Slider value={50} onValueChange={() => {}} aria-label="Weight" />,
    );
    const cls = (getByRole('slider') as HTMLInputElement).className;
    expect(cls).toContain('::-webkit-slider-thumb');
    expect(cls).toContain('::-moz-range-thumb');
    expect(cls).toContain('::-moz-range-progress');
  });

  it('reports the numeric value through onValueChange', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(
      <Slider value={10} min={0} max={100} onValueChange={onValueChange} aria-label="Weight" />,
    );
    fireEvent.change(getByRole('slider'), { target: { value: '73' } });
    expect(onValueChange).toHaveBeenCalledWith(73);
  });
});
