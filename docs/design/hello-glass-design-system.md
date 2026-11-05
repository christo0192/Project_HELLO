# HELLO design system: Logsheet

**Status:** adopted 2026-11-05 for the whole web app (`app/web`), recruiter and candidate-facing. See the decision record: [logsheet-decision-2026-11-05.md](logsheet-decision-2026-11-05.md).
**Replaces:** the frosted-glass system of 2026-09-05. The file keeps its old name, and `GlassPanel` and the `.glass*` classes keep theirs, so that every page re-skinned without a per-page edit. There is no glass.
**Gate:** `node scripts/validate-hr-design-system.mjs` in CI, and `app/web/src/__tests__/logsheet-tokens.test.ts`.

## 1. Intent

HELLO phones candidates for the Interview Kickstart talent team, interviews them in a named AI voice, records and transcribes the call, and scores it on the role's rubric. Recruiters see the evidence, and a person makes the decision in Ashby.

- **Character:** attentive, exact, answerable. It shows who spoke and for how long. It gives timecodes and counts, never a mood. It shows its working, marks what it could not score, and hands the decision to a person.
- **World:** a taped interview and its log sheet. One sheet of paper lies on a desk, typed in carbon ink. The lines are ruled. A highlighter marks the quote you would play to a colleague. It is not a courtroom, a KPI wall, a chat app or a magazine.
- **Material:** opaque and flat. No blur, no gradient, no glow, no fixed ground. Hierarchy comes from printed rules, weight and ink.
- **Motion:** none on arrival. Nothing enters, reveals or counts up.

## 2. Tokens (`src/index.css`)

The palette is the whole palette. Every semantic name points at one of these, so a hue changes in one place.

| Token | Value | Use |
|---|---|---|
| `--desk` | `#e9e7e0` | frame and sidebar: the desk the sheet lies on |
| `--paper` | `#fbfaf6` | the sheet: every working surface, opaque |
| `--field` | `#f2f0ea` | a shaded printed field |
| `--rule` | `#e2dfd7` | printed row rules (decorative) |
| `--rule-2` | `#cfcbc1` | sheet edge, box edges |
| `--control` | `#827d74` | control borders, 3:1 on desk, paper and field |
| `--ink` | `#1b1915` | carbon ink: names, words, figures, the primary fill, focus |
| `--ink-2` | `#48443d` | graphite: body text |
| `--ink-3` | `#66615a` | labels, meta, turn numbers |
| `--voice` | `#a8460c` | the candidate's voice as text |
| `--voice-mark` | `#cf5a12` | the same hue as a mark: strip segments, swatches |
| `--wash` | `#fde0c5` | highlighter swipe: words cited as evidence |
| `--ai` | `#8c877e` | the interviewer's segments on the call strip |
| `--danger` | `#a01c3c` | faults on our side, and Halt all calling (filled) |
| `--plate` | `#ffffff` | the IK logo's own plate, never inverted |
| `--go` / `--go-strong` | `#2f7a4f` / `#2a6e47` | the "Resume calling" button and nothing else (owner request, 2026-09-29) |

**The voice pair** is the only place the orange is declared. The stakeholder's choice of hue changes these two lines. It is never a button, a link, a verdict or a warning.

### Semantic names

The old names stay, mapped, so pages re-skin:

| Name | Maps to |
|---|---|
| `--surface` / `--surface-secondary` / `--surface-tertiary` | `--paper` / `--field` / `--desk` |
| `--ink-secondary` / `--ink-tertiary` / `--ink-muted` | `--ink-2` / `--ink-3` / `--control` |
| `--line` / `--line-strong` | `--rule` / `--rule-2` |
| `--info` / `--info-soft` | `--ink` / `--field` |
| `--success`, `--success-text` / `--success-soft` | `--ink-2` / `--field` |
| `--warning` / `--warning-text` / `--warning-soft` | `--ink-2` / `--ink` / `--field` |
| `--error`, `--error-text` / `--error-soft` | `--danger` / `--paper` |
| `--glass-ring` / `--glass-ring-strong` | `--rule` / `--rule-2` |

A status carries a word, so its tone needs no traffic light. Only a fault on our side takes a hue.

The `--c-*` names in `src/styles/candidate-palette.css` map the same way and hold no colour of their own.

### What each mark means

| Mark | Means | And nothing else |
|---|---|---|
| Orange (`--voice`, `--voice-mark`) | The candidate's voice | Never buttons, links, verdicts or warnings |
| Highlighter wash (`--wash`) | Words cited as evidence | Never the only marker |
| Dashed pencil outline | Not firm: Provisional, Insufficient evidence, a week still filling in | |
| 1px diagonal hatch | The consent gate | |
| Crimson (`--danger`) | Faults on our side, plus Halt all calling (filled) | |
| Ink fill | The one primary action on a screen, plus pressed or selected states | |

Verdicts are ink, never coloured: a Reject is not a fault, and a Select is not a success. Selection outcomes are not coloured good or bad.

### Contrast

Computed from the tokens by `logsheet-tokens.test.ts` and the CI gate.

| Foreground | Background | Ratio | Needs | Used for |
|---|---|---|---|---|
| ink | paper / field / desk / wash | 16.80 / 15.40 / 14.18 / 13.91 | 4.5 | names, figures, sidebar text, highlighted quotes |
| ink-2 | paper / field / desk / wash | 9.27 / 8.49 / 7.82 / 7.67 | 4.5 | body text, nav labels |
| ink-3 | paper / field / desk | 5.87 / 5.38 / 4.96 | 4.5 | labels, meta, nav group labels |
| voice | paper / field | 5.67 / 5.20 | 4.5 | the candidate's speaker label |
| paper | ink | 16.80 | 4.5 | the primary button |
| danger, paper | paper, danger | 7.38 | 4.5 | fault text, Halt all calling |
| control | paper / field / desk | 3.92 / 3.59 / 3.31 | 3 | control borders, the active nav edge |
| voice-mark | paper / field | 3.92 / 3.60 | 3 | candidate segments, swatches |
| ai | paper | 3.42 | 3 | interviewer segments |

Below 3:1 on purpose: voice-mark against ai (told apart by height and speaker labels), wash on paper (every quote is also numbered, ticked and repeated as a button), and the two rules on paper or desk (decorative; no state depends on them).

Status is never carried by colour alone: every status has a word, and a fault has a word and an edge.

## 3. Typography

### Typeface: IBM Plex Sans + IBM Plex Mono

Self-hosted from `@fontsource-variable/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (SIL OFL 1.1), imported once in `src/main.tsx`. The Sans is the width-axis build (`wdth.css`: weight 100-700, width 75-100). The CSP is `font-src 'self'`, so no CDN: Vite emits each subset as a hashed same-origin woff2, and a browser downloads only the subsets a page renders.

- **Form labels** are 12px at `font-stretch: 87.5%` (`.form-label`), like the condensed labels printed on a form. `Field`, `Th` and the `MetricStrip` labels use it.
- **Plex Mono** is for timecodes, turn numbers and evidence numbers only: positions in a recording. Durations, scores and ids stay in Plex Sans. Only `SeekableTranscript` prints it today.

### Figures

`body` sets `font-variant-numeric: tabular-nums`, so every figure in a column lines up. Nothing sets `font-feature-settings`.

### Scale

12 / 13 / 14 / 16 / 20 / 24 / 30, in a fixed `rem` scale. Weights 400, 500 and 600 only. No negative tracking below 24px. Nothing below 12px. No arbitrary `text-[…]` sizes.

| Step | Tailwind | Size / line, weight | Use |
|---|---|---|---|
| Figure | `text-stat` | 30/36, 600 | the one answer figure on a screen |
| Title | `text-title` | 24/32, 600 | page `h1` (`PageHeader`) |
| Large figure | `text-2xl` | 24/32 | a figure in a strip |
| Figure | `text-xl` | 20/28 | a compact figure |
| Section | `text-section` | 16/24, 600 | `h2`/`h3`, at both levels (level is outline, not size) |
| Body | `text-sm` | 14/20, 400 | table cells, notices, prose |
| Label | `text-label` | 13/20 | labels (+ `font-medium`), descriptions |
| Meta | `text-meta` | 12/16 | badges, tags, captions |

### Labels are sentence case

No label is uppercase, on any surface, including the exported report. The only uppercase is an acronym as the source writes it (IST, SLO), and the HELLO wordmark.

## 4. Surfaces

- **The sheet:** one opaque page on the desk, inset 8px from the window, with a 1px `--rule-2` edge, radius 8, no shadow (`.sheet`).
- **Panels:** `GlassPanel` and `.glass` are printed boxes on the sheet: paper, a 1px `--rule-2` edge, radius 4. `level="sunken"` is a shaded `--field` with no edge. Boxes never nest.
- **Shadows** exist on floating layers only: dialogs, drawers, menus, the combobox list, chart tooltips (`--shadow-pop`, `.glass-modal`).
- **Radii:** sheet 8, boxes and controls 4, chips 3, evidence boxes and highlights 2. Dots and toggles stay round. No arbitrary `rounded-[…]`.
- **Edges are real borders**, not inset shadows, because Windows contrast themes keep borders and drop shadows.
- **Spacing:** 4px base; sheet padding 24; control height 36, or 28 for small controls.

## 5. Shell

- A 232px sidebar on the desk, sticky on desktop: the IK logo on its own white plate (never inverted), the HELLO wordmark, a scope line, the grouped nav, and the signed-in user with sign-out at the foot.
- The active nav item is a paper tab with a 3:1 `--control` edge, shown statically.
- A skip link to `#main-content`. A 2px ink focus ring on every control. A forced-colours rule in `index.css` for every state drawn with a fill.
- The calling state is not in the shell yet. Its only read, `GET /api/phone/health`, is limited to interviewers and above, so a viewer would get a 403 on every route. It needs a read that is safe for every role.

## 6. Primitives (`src/components/design`)

`GlassPanel` · `SectionHeader` · `Button` (`primary | secondary | ghost | danger | danger-quiet | go`, `sm | md | lg`) · `Switch` · `TextField` · `SelectField` · `Combobox` · `Field` · `SegmentedControl` · `Pagination` + `usePagination` · `ScrollArea` · `InlineNotice` · `EmptyPanel` · `ErrorPanel` · `Dialog` / `SlideOver` (on `useModal`) · `MetricStrip`, `ChartCard`, `Table`, `StatusBadge`, `PageHeader`.

- **`Combobox`:** the picker for any list an admin must search or read a second line of (jobs, roles, library metrics). Opens INLINE; APG "combobox with listbox popup" keyboard contract; Escape closes the list, not the modal around it; option values are never rendered. Use `SelectField` only for short, fixed, self-explanatory choices.
- **`danger-quiet`:** a destructive action that is not the point of its surface ("Archive" beside "Edit"). The filled `danger` is for the confirmation step itself.

Rules:
1. Never nest a box in a box. Inside a `GlassPanel`, use `.glass-sunken` wells or plain rows.
2. Section titles are `h2`/`h3` at 16/24, 600 (`text-section`); descriptions are one sentence, 13/20 (`text-label`), tertiary ink.
3. Labels are sentence case. The only uppercase is a user's own acronym.
4. Small text never uses a mark colour: `--control`, `--voice-mark` and `--ai` are below 4.5:1.
5. Controls are at least 36px tall (28 for small, 44 on touch surfaces), radius 4, with a `--control` border that clears 3:1.
6. Tables: sticky header inside the box, 44px rows, no zebra, no header band, hover tint, paginated at 10 by default.
7. Any list longer than about 8 items lives in a `ScrollArea` or is paginated.
8. Candidate-scoped files (see `candidate-scope-palette.test.ts`) may not write raw colours; use the primitives and the `--c-*` names.
9. **A strip, not a card wall.** Related figures share ONE box and are separated by rules inside it, never a grid of identical cards. A block earns its own box only when it is a separate task.
10. **Danger stays quiet until the confirmation.** One `primary` per surface; everything else `secondary` or `ghost`. A destructive action on a row or beside other actions is `danger-quiet`; the filled `danger` appears only on the confirmation step itself, and on Halt all calling.
11. **Loading, failed and empty are three different states.** A block shows its empty copy only after its read succeeded. While loading it shows its frame at its final size. When its read fails it names what is missing, says what to do and offers a Retry (`RetryButton`, which keeps focus in the panel) that re-runs that read alone; a failed figure is a dash and never a 0. It never prints a raw API code: words come from `lib/api-error-copy.ts`, and `ErrorPanel` replaces any machine text it is handed. A failure stays in the panels that needed that read. Only an identity failure (`/api/me`) may take the whole page. A failed write is not a failed read: it says what did not happen, and has no Retry that reloads a list.

## 7. Charts (`src/components/charts/theme.ts`)

Every chart colour comes from the tokens, in one place: `chartPalette()` reads the computed custom properties. The categorical cycle is ink steps, not hues, so a series is told apart by its printed label and its marker shape, and an outcome is not coloured good or bad. The voice hue never appears in a chart. Lines are straight, bars start from zero, and a chart is printed, not drawn in: `animation: false` at every setting.

## 8. Motion

- No entrance, no reveal and no count-up anywhere.
- Hover changes colour in 120ms (`duration-hover`). Press scales to 0.97. Chevrons rotate in 150ms.
- Overlay motion stays: dialog 160ms, slide-over 220ms, combobox 140ms, disclosure 180ms.
- `prefers-reduced-motion` removes all of it, including the press scale.
- There is no motion library. Everything left is CSS.

## 9. Dark mode

Retired. `main.tsx` forced the light theme in production, so no user could ever reach a dark app, and no direction defines one. `lib/theme.tsx`, `ThemeToggle`, every `.dark` rule and the Tailwind class strategy are gone.

The one exception is the **exported candidate report**. It is a standalone file a reader opens in their own browser, so it does follow `prefers-color-scheme`. Its dark block maps every Logsheet token to a warm dark counterpart, and `reportStyles.test.ts` checks every text pair for AA in both schemes.

## 10. Accessibility contract

WAI-ARIA tabs for section navigation (roving tabindex, arrow keys); `role="switch"` for booleans; `aria-pressed` on segmented filters; `nav[aria-label]` for pagination; scroll regions are focusable and labelled; all text pairs clear WCAG AA against every ground they sit on (computed, and verified in Playwright with axe at reduced motion).
