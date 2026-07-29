# Accessibility Testing Runbook

> **Last updated:** 2026-07-29
> **Owner:** Platform team
> **Related:** TST-07
> **Status:** Engineering automation partial — manual AT, contrast, reflow, real-browser, and candidate consent/call-flow gates remain external/dependent. Not a launch gate until those checks pass.

## Overview

This runbook documents the automated accessibility test scaffold for the web application (`app/web`). Automated tests run as part of `npm test` (vitest + jsdom + axe-core + React Testing Library) in CI.

**TST-07 is NOT complete.** The automated scaffold covers:
- Unit-level axe WCAG 2.1 A/AA + best-practice rules (colour-contrast excluded — jsdom cannot compute colours)
- Keyboard focus assertions (within jsdom's capability — full tab order requires real browser)
- Fail-closed network trap (fetch, XMLHttpRequest, WebSocket, EventSource)
- Seeded violation self-test (proves axe is active)
- Console.error/warn trapping (unexpected diagnostics fail tests)

**Explicitly NOT covered and remaining external/dependent:**
- Colour contrast verification (requires real browser / Playwright)
- Screen reader / assistive technology (NVDA, VoiceOver, JAWS)
- 400% zoom / reflow at 1280px
- Real-browser focus indicators and tab order
- LiveKit call flow states (connecting, live, ending, error)
- Candidate consent accessibility (blocked on GOV-08/Legal)
- Lighthouse accessibility score ≥90 (requires deployed URL)
- Real audio/media testing

## Automated Coverage (vitest + axe-core)

All automated tests live under `app/web/src/`. They run in vitest with a jsdom environment.

### Test Files (11 files, 101 tests)

| File | Component(s) | axe tests | Keyboard/focus | Network trap | States tested | Notes |
|---|---|---|---|---|---|---|
| `src/test/SeededViolation.test.tsx` | SeededViolation (deliberately inaccessible) | ✅ Self-test | — | — | Violation detection | Proves axe is active; would fail if disabled |
| `src/test/NetworkTrap.test.tsx` | — | — | — | ✅ Self-test | 4 transports | Proves trap catches fetch/XHR/WS/EventSource |
| `src/components/ui.test.tsx` | Button, Card, Input, Select, Textarea, Label, Chip, Spinner, LoadingState, ErrorState, EmptyState, PageHeader | ✅ (all) | ✅ (Enter/Space) | — | 29 tests, 26+ tests | Keyboard: Enter, Space activation |
| `src/components/Layout.test.tsx` | Layout (sidebar, nav, main) | ✅ | ✅ (focus) | — | Landmarks, nav links, API status | Focus verification on nav links |
| `src/components/Scorecard.test.tsx` | Scorecard | ✅ | — | — | All recommendation states, conflicts, summary | 11 tests |
| `src/components/LiveCallPanel.test.tsx` | LiveCallPanel | ✅ | — | — | Empty/no-call state only | Connecting/live/ending states require LiveKit Room mock (not built) |
| `src/components/LiveKitCallCard.test.tsx` | LiveKitCallCard | ✅ | — | — | Idle/pre-call state only | Connecting/live/ending/error states require real or faked Room connection (not built) |
| `src/pages/RolesPage.test.tsx` | RolesPage | ✅ | ✅ (tab, Enter) | — | Empty, error, data, form, validation | Tab order, Enter submit, focus management |
| `src/pages/CandidatesPage.test.tsx` | CandidatesPage | ✅ | — | — | Empty, loading, table, upload card | 8 tests |
| `src/pages/CandidateDetailPage.test.tsx` | CandidateDetailPage | ✅ | — | — | Loading, error, profile, sessions, assessment | 7 tests |
| `src/pages/ScreeningPage.test.tsx` | ScreeningPage | ✅ | ✅ (Enter send) | — | Loading, error, transcript, composer, completed, empty | 10 tests |

### Test count breakdown

| Metric | Count |
|--------|-------|
| Test files | 11 |
| Total tests | 101 |
| axe `toHaveNoViolations` assertions | ~50 (each state or component variant) |
| Keyboard interaction tests | ~12 (tab, Enter, Space, Shift+Tab) |
| Network trap assertions | 6 (4 transports + 2 gate tests) |

### Running Tests

```bash
cd app/web
npm test                     # Single run (CI mode)
npm run test:typecheck       # TypeScript typecheck test files
npm run test:watch           # Watch mode for development
```

### Seeded Violation Self-Test

`SeededViolation.tsx` exports a component with deliberate accessibility violations:
- Icon-only `<button>` with no accessible name → axe rule `button-name`
- `<img>` without `alt` attribute → axe rule `image-alt`

The self-test in `SeededViolation.test.tsx` asserts that axe detects these violations. **If this test ever passes without finding violations, the axe integration is broken.**

### Network Trap (Fail-Closed)

The setup (`src/test/setup.ts`) replaces four transport constructors with counters:

| Transport | Trap method | afterEach enforcement |
|---|---|---|
| `fetch()` | Rejected promise + counter increment | Counter must be 0 |
| `XMLHttpRequest` | Sync throw + counter increment | Counter must be 0 |
| `WebSocket` | Constructor counter + async error | Counter must be 0 |
| `EventSource` | Constructor counter + async error | Counter must be 0 |

Any test that touches the network without mocking will fail the suite with:
```
NETWORK TRAP: X unexpected network call(s) detected.
```

The self-test in `NetworkTrap.test.tsx` proves all four transports are trapped.

### Console Error/Unhandled Rejection Trap

Unexpected `console.error` and `console.warn` calls fail the test. React `act()` warnings are allowed (informational in jsdom). Unhandled promise rejections are caught and fail the suite. Tests may permit expected diagnostics via `__allowConsole(/pattern/)`.

## Violation Policy

### `toHaveNoViolations` Matcher (Strict)

The custom matcher **fails on EVERY axe violation** (minor, moderate, serious, critical). There is no filtering by impact level. Any violation of the enabled rule set fails the test.

### axe Rules Suppressed in jsdom

These axe rules are disabled in tests because jsdom cannot compute pixel colours or paint layouts. They MUST be verified in a real browser before claiming WCAG conformance:

| Rule | Reason | Browser Test Required? |
|---|---|---|
| `color-contrast` | jsdom has no colour computation | ✅ Yes |
| `link-in-text-block` | Requires computed styles | ✅ Yes |
| `scrollable-region-focusable` | Requires layout/paint | ✅ Yes |

### Incomplete Checks

Axe may report rules it could not fully evaluate (incomplete). These are reported in test output but do NOT fail the test. Each incomplete check requires manual verification.

### Fixed Violations

All production components in the test suite pass `toHaveNoViolations()` with zero violations for the jsdom-enableable rule set. The RolesPage heading hierarchy was fixed (`h3` → `h2`) after the strict matcher caught a `heading-order` violation.

## Pending Manual Acceptance

The following **cannot be validated by unit tests** and require manual or browser-based testing:

### 1. Colour Contrast (REQUIRED before launch)
- All text/background combinations must meet WCAG 2.1 AA contrast ratios (4.5:1 normal, 3:1 large)
- Focus indicators must have sufficient contrast
- Status chips (green/amber/red) must not rely on colour alone

### 2. Screen Reader (NVDA / VoiceOver / JAWS)
- Navigate every page using only the screen reader (headings, landmarks, forms, tables)
- Verify that dynamic content updates are announced (aria-live regions)
- Test the screening chat flow end-to-end

### 3. Keyboard Navigation (real browser)
- Tab order must follow visual layout (no missing or unexpected focus stops)
- All interactive elements must be reachable and operable via keyboard (Enter, Space, Esc, Arrow keys)
- Focus must be visible (focus ring) on all controls

### 4. Zoom / Reflow (400% zoom, 1280px viewport)
- No horizontal scrolling or content truncation at 400% zoom
- Text must reflow without loss of information
- Responsive grid layouts (CandidateDetailPage) must degrade gracefully

### 5. Real Browser / Device Testing
- Cross-browser: Chrome, Firefox, Safari, Edge (latest two versions)
- Mobile: iOS Safari, Android Chrome (at minimum)

### 6. Lighthouse Accessibility Score
- Production URL must score ≥90 on Lighthouse accessibility audit
- Run Lighthouse CI as part of deployment pipeline

### 7. LiveKit Call Flow Accessibility
- Connecting, live, ending, error, retry, hang-up states require real audio context or faithful Playwright mock (not built)
- Candidate consent flow blocked on GOV-08/Legal

### 8. WCAG 2.1 AA Conformance (Deferred)
- Full WCAG 2.1 AA audit is deferred until the above manual checks pass
- Automated coverage serves as a regression safety net, not a conformance guarantee

## Tools Used

| Tool | Version | Purpose |
|---|---|---|
| vitest | ^3.1.1 | Test runner |
| jsdom | ^26.0.0 | DOM environment |
| @testing-library/react | ^16.2.0 | React component rendering |
| @testing-library/jest-dom | ^6.6.3 | DOM matchers (toBeInTheDocument, etc.) |
| @testing-library/user-event | ^14.6.1 | User interaction simulation |
| axe-core | ^4.10.3 | Accessibility rule engine |

## Dependencies Added for TST-07

The following devDependencies were added to `package.json`:
- `vitest` ^3.1.1
- `jsdom` ^26.0.0
- `axe-core` ^4.10.3
- `@testing-library/react` ^16.2.0
- `@testing-library/jest-dom` ^6.6.3
- `@testing-library/user-event` ^14.6.1

These are test-only dependencies; no production dependencies were changed.

## CI Integration

The accessibility tests run as part of the `quality` job in `.github/workflows/quality.yml`:

```yaml
- name: Install, lint, test, and build web
  working-directory: app/web
  run: npm ci && npm run lint && npm run test:typecheck && npm test && npm run build
```

The CI pipeline runs: lint → test typecheck → vitest → production build.
All 101 tests must pass for CI to be green.

## Adding a New Test

1. Place the test file next to the component: `src/components/MyComponent.test.tsx`
2. Import from `../test/helpers` for mock API data
3. Use `await expect(container).toHaveNoViolations()` for axe assertions
4. Use `expect(screen.getByRole(...)).toBeInTheDocument()` for DOM assertions
5. Never make real HTTP calls — mock external modules
6. Add keyboard interaction tests for new interactive elements
7. Run `npm run test:typecheck && npm test` before committing
