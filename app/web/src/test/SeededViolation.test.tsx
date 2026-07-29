/**
 * Axe self-test: proves axe-core is active in vitest/jsdom.
 *
 * This test would fail if:
 *   - axe-core were removed from dependencies.
 *   - jsdom were removed or broken.
 *   - The custom `toHaveNoViolations` matcher were disabled.
 *
 * The SeededViolation component is deliberately non-accessible and must
 * produce at least one serious or critical axe violation. If it doesn't,
 * the test fails — meaning something in the axe integration is broken.
 */

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SeededViolation } from './SeededViolation';

describe('axe self-test / seeded violation', () => {
  it('detects known accessibility violations in SeededViolation', async () => {
    const { container } = render(<SeededViolation />);

    // Run axe on the seeded-violation container
    const { violations } = await (
      await import('./setup')
    ).runAxe(container);

    const violationIds = violations.map((v) => v.id);

    // In jsdom, axe can detect:
    // - "button-name": button with no accessible name (icon-only button)
    // - "image-alt": img without alt attribute
    // Both are serious violations.

    // The button-name violation should be present
    expect(violationIds).toContain('button-name');

    // The image-alt violation should be present
    expect(violationIds).toContain('image-alt');

    // Sanity: there should be at least 2 violations
    expect(violations.length).toBeGreaterThanOrEqual(2);

    // Ensure at least one is serious
    const seriousViolations = violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(seriousViolations.length).toBeGreaterThanOrEqual(1);

    // Prove the custom matcher works by expecting it to FAIL on this container
    // (the container has violations, so toHaveNoViolations should reject)
    await expect(container).not.toHaveNoViolations();
  });

  it('custom matcher passes on a clean element', async () => {
    const { container } = render(
      <main>
        <h1>Hello</h1>
        <p>Accessible content.</p>
      </main>,
    );

    // A simple semantic structure should have no serious/critical violations
    await expect(container).toHaveNoViolations();
  });
});
