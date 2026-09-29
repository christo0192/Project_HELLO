# HELLO — glass design system (light-first, HR-approved palette)

**Status:** adopted 2026-09-05 for the recruiter/operator web app (`app/web`).
**Palette source:** the HR-approved "IK Hiring Dashboard" palette (light-only, fixed values). Every colour on every surface must be one of those values or an alpha/tint of white and the ink `#0f172a`. No new hues.

## 1. Intent

The previous shell was a flat admin template: every block a 1px-bordered white rectangle on an off-white ground, uppercase tracked eyebrow labels on everything, native form controls, unbounded tables, and forced equal-height cards with 300px of dead space. This system replaces it with a **layered, translucent, macOS-inspired** surface language:

- **Depth by material, not by borders.** Panels are frosted glass floating on a softly-lit ground. Hierarchy comes from blur, translucency and shadow, never from thick borders or coloured accent bars.
- **Quiet typography.** One self-hosted product face (IBM Plex Sans), a short fixed scale, tight negative tracking on titles, tabular figures for data, sentence case everywhere. No uppercase-tracked eyebrows. See §3.
- **Motion that explains.** Springs, not linear tweens. Sliding-pill selection, staggered reveals, count-ups, press feedback. Every animation collapses under `prefers-reduced-motion`; every translucency collapses under `prefers-reduced-transparency` or missing `backdrop-filter`.
- **Bounded data.** Tables paginate (10/25/50) or scroll inside a fade-masked region. Nothing renders 34 rows down a page.

## 2. Tokens (`src/index.css`)

| Token | Value | Use |
|---|---|---|
| `--surface-secondary` | `#f4f6fb` | page ground base |
| `--surface` | `#ffffff` | opaque fallback surface |
| `--ink` / `--ink-secondary` | `#0f172a` / `#334155` | primary / secondary text |
| `--ink-tertiary` | `#5f6785` | small muted text (AA on ground and glass) |
| `--ink-muted` | `#6b7391` | dots, borders, ≥18px numerals only |
| `--info` (accent) | `#4e6ba6` | primary action, selection, links |
| `--success` / `--success-text` | `#398aa2` / `#2f7488` | fills / small text |
| `--warning` / `--warning-text` | `#a16207` / `#955b06` | fills / small text |
| `--error` / `--error-text` | `#b45a72` / `#9f4d63` | fills / small text |
| `--glass-bg` | `rgba(255,255,255,.66)` | panel material |
| `--glass-bg-strong` | `rgba(255,255,255,.82)` | topbar / dialogs |
| `--glass-rail` | `rgba(255,255,255,.58)` | sidebar |
| `--glass-ring` | `rgba(15,23,42,.07)` | hairline around glass |
| `--radius-card` / `--radius-control` | `20px` / `12px` | panels / inputs & buttons |

Utility classes: `.glass`, `.glass-strong`, `.glass-rail`, `.glass-sunken`, `.glass-interactive`, `.hairline`, `.app-ground`, `.fade-up` (CSS-only reveal for motion-free scopes), `.glass-modal` (opaque modal material for `Dialog` and `SlideOver` — translucent glass over the dimmed backdrop read grey and failed small-text contrast).

## 3. Typography

### Typeface: IBM Plex Sans + IBM Plex Mono

Self-hosted from `@fontsource-variable/ibm-plex-sans` (variable weight axis 100–700) and `@fontsource/ibm-plex-mono` (400, 500), SIL OFL 1.1, imported once in `src/main.tsx`. Tailwind's `fontFamily.sans` / `fontFamily.mono` and the `body` rule in `index.css` name it first; the system stack behind it is only the `font-display: swap` fallback for the moment before the woff2 arrives.

Why this face:

- **One face, everywhere.** The old system stack rendered a different font per platform (SF, Segoe UI, Roboto, whatever CI had), and the `'cv11', 'ss01'` feature settings written for Inter switched on arbitrary alternates in those faces. Plex is one drawing on every machine, with no feature settings.
- **Not the default AI-dashboard face.** Geist was tried first (M007) and dropped: it, Inter and a handful of others are what generated dashboards converge on, which is the "made by AI" read the stakeholder objected to. Plex is an engineered grotesque drawn for technical, operational work; it reads as a precise instrument, which is what an HR screening console is.
- **It holds up small.** A large x-height and open apertures keep 12–13px labels legible on translucent glass, and the capitals give a 28px page title presence without a display face. Product UI needs one well-tuned sans, not a pairing.
- **Self-hosted because of the CSP.** `font-src 'self'` rules out a font CDN. Vite emits every subset as a hashed same-origin woff2 (each is over the 4 KiB inline limit, so none becomes a `data:` URI the CSP would block). Each `@font-face` has a `unicode-range`, so in practice a page downloads only the Latin subset: a few tens of KB per face. The drawn italic is imported too, for the few places that set italic.
- **Mono is for identifiers**, the strings an operator reads character by character (session ids, codes). Figures are never set in mono; they use tabular sans (below).

Plex sets wider than Segoe UI or Arial at the same size. Leave slack in fixed-width controls and never size a column to the exact width of today's text.

### Figures

Plex draws every digit at one width, so figures line up by default. Anything compared down a column or updated in place still says so with `tabular-nums`, which keeps it aligned under the fallback face during `font-display: swap`:

- `Table` sets it on the whole table (counts, scores, dates, times line up).
- `StatusBadge`, `Tag`, the `SectionHeader` meta slot, `SegmentedControl` counts, and every `text-stat` figure (`MetricStrip` etc.) set it.
- Nothing sets `font-feature-settings` globally.

### Scale

A fixed `rem` scale (no fluid type in product UI). Hierarchy comes from size, weight and ink (`ink` / `ink-secondary` / `ink-tertiary`), not from boxes. Weights: 400, 500, 600. Nothing below 12px.

| Step | Tailwind | Size / line, weight, tracking | Use |
|---|---|---|---|
| Title | `text-title` | 28/34, 600, −0.02em | page `h1` (`PageHeader`) |
| Figure | `text-stat` + `tabular-nums` | 30/36, 600, −0.02em | hero numbers (keep hero figures in the 28–32px band) |
| Section | `text-section` | 15/20, 600, −0.01em | `h2`/`h3` via `SectionHeader`, at both levels (level is outline, not size) |
| Body | `text-sm` | 14/20, 400 | table cells, notices, prose |
| Label | `text-label` | 13/20, 500 for labels, 400 for descriptions | field labels (`ink-secondary`), one-line descriptions (`ink-tertiary`) |
| Meta | `text-meta` | 12/16, 500 | table headers, badges, tags, captions |

### Labels are sentence case

No label anywhere is uppercase plus letter-spacing: not the app, not the candidate experience (`.candidate-eyebrow` is 13/20 sentence case in the accent; the live-transcript speaker label is 12/16). A label's job is done by its size, weight and ink. The only uppercase is an acronym as the user or the source writes it (IST, SLO).

## 4. Primitives (`src/components/design`)

`GlassPanel` · `SectionHeader` · `Button` (`primary | secondary | ghost | danger | danger-quiet`, `sm | md | lg`) · `Switch` · `TextField` · `SelectField` · `Combobox` · `Field` · `SegmentedControl` · `Pagination` + `usePagination` · `ScrollArea` · `InlineNotice` · `EmptyPanel` · `ErrorPanel` · `RevealGroup` / `RevealItem` · `PageTransition` · `Dialog` / `SlideOver` (on `useModal`) · upgraded `KpiCard`, `ChartCard`, `Table`, `StatusBadge`, `PageHeader`.

- **`Combobox`** — the picker for any list an admin must search or read a second line of (jobs, roles, library metrics). Opens INLINE (panels scroll and animate, so a floating popover would clip); APG "combobox with listbox popup" keyboard contract; Escape closes the list, not the modal around it; option values are never rendered. Use `SelectField` only for short, fixed, self-explanatory choices.
- **`danger-quiet`** — a destructive action that is not the point of its surface ("Archive" beside "Edit", "Delete"/"Cancel" on list rows). The filled `danger` is for the confirmation step itself.

Rules:
1. Never nest glass in glass. Inside a `GlassPanel`, use `.glass-sunken` wells or plain rows.
2. Section titles are `h2`/`h3` at 15/20, 600 (`text-section`); descriptions are one sentence, 13/20 (`text-label`), tertiary ink.
3. Labels are sentence case. The only uppercase is a user's own acronym.
4. Small text never uses `--success`/`--warning`/`--error` directly; use the `*-text` tokens or the ink.
5. Controls are ≥ 36px tall (44px on touch surfaces), radius 12px, hairline border that clears 3:1.
6. Tables: sticky header inside the glass container, 44px rows, hover tint, paginated at 10 by default.
7. Any list longer than ~8 items lives in a `ScrollArea` or is paginated.
8. Candidate-scoped files (see `candidate-scope-palette.test.ts`) may not import `motion` or write raw colours — use the primitives and `.fade-up`.
9. **A strip, not a card wall.** Related figures share ONE `GlassPanel` and are separated by hairlines inside it (`divide-y divide-[var(--glass-ring)]`, or `gap-px` on a ring-coloured ground as `RubricScale` does), never a grid of identical cards. A block earns its own panel only when it is a separate task. The 18-card dashboard wall is the anti-reference.
10. **Danger stays quiet until the confirmation.** One `primary` per surface; everything else `secondary` or `ghost`. A destructive action on a row or beside other actions is `danger-quiet`; the filled `danger` appears only on the confirmation step itself (the dialog's confirm button). A filled red button on every row is banned.

## 5. Motion (`src/lib/motion.ts`)

- `SPRING_SNAPPY` — selection pills, switches, press feedback.
- `SPRING_GENTLE` — hover lift, panel settle.
- `pageVariants` — route enter (opacity + 8px rise, 320ms).
- `panelVariants` — tab panel enter (opacity + 6px rise, 220ms).
- `staggerContainer` / `listItemVariants` — card and row reveals (50ms stagger).
- `useInteractive()` — `whileHover` / `whileTap` props that vanish under reduced motion.
- Charts: 600ms `cubicOut` entrance, disabled under reduced motion (existing).

## 6. Accessibility contract

WAI-ARIA tabs for section navigation (roving tabindex, arrow keys); `role="switch"` for booleans; `aria-pressed` on segmented filters; `nav[aria-label]` for pagination; scroll regions are focusable and labelled; all glass text pairs clear WCAG AA against both the ground and the panel material (verified in Playwright with axe at reduced motion).
