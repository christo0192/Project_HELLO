/**
 * SkipLink — WCAG 2.4.1 keyboard bypass.
 *
 * The only visible-at-focus element on every app page. Targets
 * `#main-content` (rendered by Layout with `tabIndex={-1}` so programmatic
 * focus lands on the main landmark, not the page top).
 */

export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:border focus:border-line-strong focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-card"
    >
      Skip to main content
    </a>
  );
}
