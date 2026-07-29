/**
 * SeededViolation — a deliberately inaccessible component.
 *
 * This component is used ONLY by the axe self-test to prove that:
 *   1. axe-core is loaded and running inside vitest/jsdom.
 *   2. The custom `toHaveNoViolations` matcher correctly detects and reports
 *      serious/critical violations.
 *   3. If axe were accidentally disabled, removed, or unresolved, this test
 *      would fail (a false-pass is not possible because known violations exist).
 *
 * Violations committed (all intentional, never displayed to users):
 *   - Unlabeled `<button>` with only an icon (no accessible name)
 *   - Redundant `role="button"` on a native `<button>`
 *   - Image with no alt attribute
 */

export function SeededViolation() {
  return (
    <div data-testid="seeded-violation">
      {/* Violation 1: <input> without an associated <label> */}
      <input
        type="text"
        placeholder="Your name"
        data-testid="unlabeled-input"
      />

      {/* Violation 2: <button> with no accessible name (icon-only, no aria-label) */}
      <button
        data-testid="icon-button"
        onClick={() => {
          /* no-op */
        }}
      >
        <svg
          data-testid="icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
        </svg>
      </button>

      {/* Violation 3: <img> without alt attribute */}
      <img
        src="https://example.com/photo.jpg"
        data-testid="no-alt-image"
      />
    </div>
  );
}
