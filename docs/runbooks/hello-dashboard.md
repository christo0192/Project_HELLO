# HELLO Dashboard — Integration Runbook

Scope: the integrated HELLO premium web dashboard — routes, navigation,
theme system, responsive shell, lazy chunks, accessibility and verification.
This runbook is **truthful**: it documents what the app actually does, the
intentional boundaries, and exactly how it was verified (including the
visual-browser limitation — no browser binary exists in the build/test
environment, so no screenshots are claimed anywhere).

Companion runbooks: `dashboard-access.md` (allowlist/OAuth access model),
`phase9-operations.md` (admin operations), `accessibility-testing.md`
(axe/keyboard methodology).

---

## 1. Routes (integration wiring)

| Route | Page | Notes |
|-------|------|-------|
| `/` | → redirect `/dashboard` | primary TA/HR landing |
| `/dashboard` | `DashboardPage` | **lazy chunk** |
| `/candidates` | `CandidatesPage` | legacy preserved |
| `/candidates/:id` | `CandidateDetailPage` | **lazy chunk** (tabbed, existing tests untouched) |
| `/sessions/:sessionId` | `SessionDetailPage` | **lazy chunk** — read-only post-session review |
| `/screening/:sessionId` | `ScreeningPage` | live call — preserved |
| `/roles` | `RolesPage` | preserved |
| `/mission-control` | `MissionControlPage` | **lazy chunk**, admin-gated |
| `/admin` | → redirect `/mission-control` | safe alias |
| `/login`, `/mfa/*`, `/unauthorized`, `/privacy-notice`, `/candidate/join`, `/status`, `/appeal` | public/auth | preserved |
| unknown paths | authenticated → `/dashboard`; unauthenticated → `NotFoundPage` | truthful 404 |

- Lazy routes are `React.lazy` with a `<Suspense>` fallback inside the app
  shell (per-route loading state).
- Route protection remains `ProtectedRoute` (AAL2 + optional admin role) —
  a UX gate only; **the server enforces authorization** (see
  `dashboard-access.md`).
- All candidate/call/consent/appeal/login behavior is preserved unchanged.

## 2. Navigation (TA/HR-first information architecture)

Primary navigation emphasizes daily TA/HR work:

- **Workspace**: Dashboard · Candidates · Roles
- **Operations** (admin-only, visually separated): Mission Control

Admin-only items are never rendered for non-admins. Active routes get a
branded pill + `aria-current="page"`.

## 3. Theme system

- `lib/theme.tsx` `ThemeProvider` mounted in `main.tsx` **before** pages
  render (charts and ThemeToggle throw without it).
- Class strategy on `<html>`: `.dark` + `color-scheme`; modes
  light/dark/system with live OS-follow; persisted under `hello.theme` —
  kept in sync with the pre-paint bootstrap script in `index.html`
  (no white flash; safe pure-DOM script).
- Semantic tokens (`index.css`): brand cyan `#3996d2` / navy `#344158`
  derived from the authorized logo; surfaces/ink/line/status switch per
  theme; amber reserved for semantic warnings.

## 4. Layout / responsive shell

- Desktop (≥1024px): fixed sidebar (brand, nav groups, status, user, role
  chip, sign-out) + sticky topbar (theme toggle) + `#main-content`.
- Mobile: off-canvas drawer with hamburger toggle
  (`aria-expanded`/`aria-controls`), backdrop, **Escape-to-close**, focus
  moved into the drawer on open and returned to the toggle on close, body
  scroll lock, and `inert` while closed (removed from tab order + a11y tree).
- Skip link → `#main-content` (WCAG 2.4.1); 2px focus rings everywhere.
- Restrained route fade via `lib/motion` `usePageVariants()`; collapses to
  static values under `prefers-reduced-motion` (global CSS block also kills
  all animation/transition).

## 5. Branding

- Sidebar/404/login render the **authorized** `public/ik-logo.png`
  (byte-identical to the SIP-dashboard source, md5
  `b3440bdbd91a65946c05928ba7f74e8a`) on a **neutral plate** — the logo is
  never CSS-inverted in dark mode.
- Wordmark: **HELLO** + "Talent Workspace & Mission Control" tagline.

## 6. Chunking / bundle

- Route-level lazy chunks split ECharts/motion-heavy pages out of the main
  bundle.
- `vite.config.ts` manual chunks: `charts-vendor` (echarts + zrender
  subset — tree-shaken in `src/components/charts/echarts.ts`) and
  `motion-vendor` (motion), shared by every route that imports them;
  `chunkSizeWarningLimit` raised to 900 kB so the genuinely large vendor
  chunk is reported, not the app bundle. No other over-splitting.

## 7. Verification

### Automated (deterministic, run in the full matrix)

- `src/App.test.tsx` — route wiring: `/` → `/dashboard`; `/admin` →
  `/mission-control`; admin gating; 404 for unknown public paths; legacy
  login preserved; shell landmarks + axe.
- `src/components/Layout.test.tsx` — shell: landmarks, skip link, brand
  (no invert), nav groups, admin gating, status, user/role, theme toggle;
  mobile drawer: inert-when-closed, open/aria-expanded, backdrop close,
  Escape + focus return, scroll lock, close-on-nav; axe (closed + open).
- `src/components/navigation/__tests__/navigation.test.tsx` — SkipLink,
  Brand, NavGroup, NavLinkItem active state (`aria-current`) + onNavigate.
- Page suites (Lanes 3/4) cover Dashboard/Mission Control/Session detail
  states, charts sr-only tables, reduced motion, and dark render.

### Manual visual checklist (browser required — **no screenshots claimed**)

Because no browser binary exists in this environment, the following must be
verified by the owner/reviewer in a real browser (Vercel preview or local
`npm run dev`):

- [ ] 1440px desktop: sidebar + topbar, Workspace/Operations groups,
      active pill, logo plate in both themes (logo colors preserved).
- [ ] 1024px: sidebar static, content reflows single-column where intended.
- [ ] 390px mobile: hamburger opens drawer, backdrop dims, Escape closes,
      focus returns to toggle; tables scroll horizontally; charts resize.
- [ ] Light/dark/system theme toggle persists across reload; no white
      flash on dark load; charts use the theme palette.
- [ ] OS reduced-motion: all animations/chart animations off.
- [ ] Loading / empty / error states on Dashboard, Session detail,
      Mission Control (kill the API to see error + retry).
- [ ] Long email/text truncation in sidebar and tables.
- [ ] Console clean (no errors) while exercising routes above.

## 8. Residuals / boundaries (truthful)

- No screenshots: the environment has no browser binary; deterministic
  DOM/axe/keyboard/responsive assertions replace them (see §7).
- `/admin` redirects to `/mission-control`; the legacy `AdminDashboardPage`
  module remains in the repo (its tests still pass) but is no longer routed.
- ECharts renders to Canvas — not keyboard-accessible by itself; every
  chart pairs with a sr-only data table and an `aria-label` summary
  (no Canvas keyboard claims anywhere).
- Theme storage key `hello.theme` must stay in sync between
  `lib/theme.tsx` and the `index.html` bootstrap script (change together).
