# HELLO — glass design system (light-first, HR-approved palette)

**Status:** adopted 2026-09-05 for the recruiter/operator web app (`app/web`).
**Palette source:** the HR-approved "IK Hiring Dashboard" palette (light-only, fixed values). Every colour on every surface must be one of those values or an alpha/tint of white and the ink `#0f172a`. No new hues.

## 1. Intent

The previous shell was a flat admin template: every block a 1px-bordered white rectangle on an off-white ground, uppercase tracked eyebrow labels on everything, native form controls, unbounded tables, and forced equal-height cards with 300px of dead space. This system replaces it with a **layered, translucent, macOS-inspired** surface language:

- **Depth by material, not by borders.** Panels are frosted glass floating on a softly-lit ground. Hierarchy comes from blur, translucency and shadow, never from thick borders or coloured accent bars.
- **Quiet typography.** System stack (`-apple-system`, SF-like), tight negative tracking on titles, sentence case everywhere. No uppercase-tracked eyebrows.
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

Utility classes: `.glass`, `.glass-strong`, `.glass-rail`, `.glass-sunken`, `.glass-interactive`, `.hairline`, `.app-ground`, `.fade-up` (CSS-only reveal for motion-free scopes).

## 3. Primitives (`src/components/design`)

`GlassPanel` · `SectionHeader` · `Button` (`primary | secondary | ghost | danger`, `sm | md`) · `Switch` · `TextField` · `SelectField` · `Field` · `SegmentedControl` · `Pagination` + `usePagination` · `ScrollArea` · `InlineNotice` · `EmptyPanel` · `ErrorPanel` · `RevealGroup` / `RevealItem` · `PageTransition` · upgraded `KpiCard`, `ChartCard`, `Table`, `StatusBadge`, `PageHeader`.

Rules:
1. Never nest glass in glass. Inside a `GlassPanel`, use `.glass-sunken` wells or plain rows.
2. Section titles are `h2`/`h3` at 15px/600; descriptions are one sentence, 13px, tertiary ink.
3. Labels are sentence case. The only uppercase is a user's own acronym.
4. Small text never uses `--success`/`--warning`/`--error` directly; use the `*-text` tokens or the ink.
5. Controls are ≥ 36px tall (44px on touch surfaces), radius 12px, hairline border that clears 3:1.
6. Tables: sticky header inside the glass container, 44px rows, hover tint, paginated at 10 by default.
7. Any list longer than ~8 items lives in a `ScrollArea` or is paginated.
8. Candidate-scoped files (see `candidate-scope-palette.test.ts`) may not import `motion` or write raw colours — use the primitives and `.fade-up`.

## 4. Motion (`src/lib/motion.ts`)

- `SPRING_SNAPPY` — selection pills, switches, press feedback.
- `SPRING_GENTLE` — hover lift, panel settle.
- `pageVariants` — route enter (opacity + 8px rise, 320ms).
- `panelVariants` — tab panel enter (opacity + 6px rise, 220ms).
- `staggerContainer` / `listItemVariants` — card and row reveals (50ms stagger).
- `useInteractive()` — `whileHover` / `whileTap` props that vanish under reduced motion.
- Charts: 600ms `cubicOut` entrance, disabled under reduced motion (existing).

## 5. Accessibility contract

WAI-ARIA tabs for section navigation (roving tabindex, arrow keys); `role="switch"` for booleans; `aria-pressed` on segmented filters; `nav[aria-label]` for pagination; scroll regions are focusable and labelled; all glass text pairs clear WCAG AA against both the ground and the panel material (verified in Playwright with axe at reduced motion).
