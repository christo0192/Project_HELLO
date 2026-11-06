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
| Orange (`--voice`, `--voice-mark`) | The candidate's voice: strip segments, the speaker label, the on-a-call stage of the pipeline | Never buttons, links, verdicts or warnings |
| Highlighter wash (`--wash`) | Words cited as evidence | Never the only marker |
| Dashed pencil outline | Not firm: Provisional, Insufficient evidence, a week still filling in | |
| 1px diagonal hatch | The consent gate | |
| Small ink flag | A reviewer's note on the call strip | Human words, never labelled AI |
| Crimson (`--danger`) | Faults on our side, plus Halt all calling (filled) | |
| Ink fill | The one primary action on a screen, plus pressed or selected states | |

Verdicts are ink, never coloured: a Reject is not a fault, and a Select is not a success. Selection outcomes are not coloured good or bad. The same holds for every AI judgement about a candidate: a red flag or a high signal is ink, with the group label and the word carrying the meaning.

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
- **Plex Mono** is for timecodes, turn numbers and evidence numbers only: positions in a recording. Durations, scores and ids stay in Plex Sans. `SeekableTranscript`, both call strips (`CallStrip` on the R1 review page, `ReviewCallStrip` on the phone Review tab), the phone tape, the Review scorecard and the R1 review page print it today, and the design gate holds that list.

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
- **Sections:** `GlassPanel level="ruled"` (`.sheet-section`) is a section of the sheet: no box, one 1px `--rule-2` rule across the top. This is the default for a block on a page. A page reads as one sheet ruled into sections, as on a form.
- **Panels:** `GlassPanel` and `.glass` are printed boxes on the sheet: paper, a 1px `--rule-2` edge, radius 4. A block earns a box only when it is a separate task. `level="sunken"` is a shaded `--field` with no edge. Boxes never nest.
- **Shadows** exist on floating layers only: dialogs, drawers, menus, the combobox list, chart tooltips, the skip link and the captions' jump button (`--shadow-pop`, `.glass-modal`). A zero-blur ring or inset line is a printed edge, not a shadow.
- **Radii:** sheet 8, boxes and controls 4, chips 3, evidence boxes and highlights 2. Dots and toggles stay round. No arbitrary `rounded-[…]`.
- **Edges are real borders**, not inset shadows, because Windows contrast themes keep borders and drop shadows. The one exception is the rule under a tab row: the row scrolls sideways, so a tab overlapping a border by 1px would reserve a vertical scrollbar. That rule is an inset line, and the forced-colours block gives the row a border.
- **Spacing:** 4px base; sheet padding 24; control height 36, or 28 for small controls. A coarse pointer takes 44 (`[@media(pointer:coarse)]:min-h-11`).

## 5. Shell

- A 232px sidebar on the desk, sticky on desktop: the IK logo on its own white plate (never inverted), the HELLO wordmark, a scope line, the grouped nav, and the signed-in user with sign-out at the foot.
- The active nav item is a paper tab with a 3:1 `--control` edge, shown statically.
- A skip link to `#main-content`. A 2px ink focus ring on every control; a ring on an ink fill takes a paper offset or goes inset, and a scroller leaves it room. A forced-colours rule in `index.css` for every state drawn with a fill or a shadow.
- Under forced colours a selection, including the transcript turn being played, is `Highlight` with `HighlightText` on everything inside it. The option the arrow keys are on is a `Highlight` outline, a filled button keeps an edge through its transparent border, and a data fill (`.data-fill`: bars, meters, legend swatches) is `CanvasText`.
- A canvas keeps its author colours in every theme, so a chart and its legend key stay on paper (`.chart-paper`, `[data-series-key]`) and the logo stays on its white plate. Without that, a dark contrast theme puts carbon ink on black.
- The page is keyed on the path, so a read still in flight cannot land on the next record.
- A calling halt is in the shell for admins and interviewers, the two roles `GET /api/phone/health` answers: "Calling halted — operator pause", in crimson below the nav, or under the top bar on a narrow screen. A viewer's shell asks nothing, so there is no 403 on their routes. The rest of the calling state (window, on a call, queued) still needs a read that is safe for every role.

## 6. Primitives (`src/components/design`)

`GlassPanel` (`raised | strong | sunken | ruled`) · `SectionHeader` · `Button` (`primary | secondary | ghost | danger | danger-quiet | go`, `sm | md | lg`) · `Switch` · `TextField` · `SelectField` · `Combobox` · `Field` · `SegmentedControl` · `Pagination` + `usePagination` · `ScrollArea` · `InlineNotice` · `EmptyPanel` · `ErrorPanel` · `Dialog` / `SlideOver` (on `useModal`) · `MetricStrip`, `ChartCard` (`ruled`), `Table` (`flush`), `StatusBadge`, `PageHeader`, and `VerdictMark` in `src/components/session`.

- **`Combobox`:** every picker on a recruiter or admin screen, because a native select opens the operating system's list. Opens INLINE; APG "combobox with listbox popup" keyboard contract; Escape closes the list, not the modal around it; option values are never rendered. `searchable={false}` drops the search box for a short fixed list. `floating` is for a page toolbar only, so opening it moves nothing below; `floating="up"` at the foot of a page. Never float one inside a `Dialog`, a `SlideOver` or a `Table`, which clip it. `no-native-select.test.ts` fails on a new `<select>`. `SelectField` stays for the pages a candidate opens on their own device.
- **`VerdictMark`:** every AI verdict: a circle in ink beside the word, full for Select, half for Borderline, empty for Reject, with the score after it. The word is the name; the circle is decoration.
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
12. **An action written as words is underlined at rest** (`.textlink`: a `--control` underline, offset 3px, darkening on hover). The accent is ink, so hue cannot say "link". A name in a list keeps the hover underline: its place in the row says what it is.
13. **A control on paper needs an edge.** With no fill to separate it from its cell, a calendar chip takes a `--control` edge and a hover fill; a withdrawn one has neither at rest, so the calls that will happen lead.

## 7. What each screen is for

Each screen answers one question and leads with one element.

| Screen | The question | It leads with |
|---|---|---|
| Dashboard | Who needs me today? | The review queue |
| Candidates | Where is this person, and who is next? | The list, with its filters above it |
| Review | Should this person move on, and why? | The call, drawn to scale, beside the scorecard |
| Session detail | What happened on this call? | The scorecard, with the call's record beside it |
| Agents | What does each agent ask, and how is it scored? | The list of agents |
| Phone calendar | What is next, and what did we miss? | The week |
| Ashby Live Jobs | Which jobs are live, and what is stuck? | The job mappings |
| Mission Control | Is anything off, and can I stop it? | Halt all calling, and the figures |

Halt all calling lives in Mission Control and nowhere else. It is filled there, and no recruiter screen carries it.

## 8. Words

**Voice.** Copy says what the reader can do or must know. It never names an API, an HTTP code, a table, a PII class or a guard. A failure names the block, in the form "The audit log couldn't load", and says what to do.

**Glossary.**

| Say | Not | Meaning |
|---|---|---|
| Select, Borderline, Reject | Advance, Hold | The AI recommendation. The stored values stay `advance`, `hold`, `reject` |
| AI recommendation | Decision, verdict | What the AI suggests. A person decides in Ashby |
| Review | Review & decide | The action on a screened candidate. HELLO records no decision |
| Christy (AI) | Bot, a bare first name | The AI interviewer on the record. Consent text keeps its own wording |
| Agent | Role, where the agent is meant | What screens candidates for one job |
| Phone rang | Phone reached | A call that rang, whether or not anyone answered |
| Finished | Terminal | A session or cycle that can't change |
| Calling limit | Fleet limit | How many calls can run at once |
| Open calling window, free line | Call gates, admission gates | What a call waits for |
| Viewer, Interviewer, Admin | viewer, interviewer, admin | The access roles |

Status labels keep the stored words: that is the owner's decision, and they are not merged into headline states. Consent, recording, opt-out, appeal and jurisdiction wording changes only with Legal.

## 9. Charts (`src/components/charts/theme.ts`)

Every chart colour comes from the tokens, in one place: `chartPalette()` reads the computed custom properties. The categorical cycle is ink steps, not hues, so a series is told apart by its printed label, its dash and its marker shape, and an outcome is not coloured good or bad. Markers are hidden past 20 points, so the dash is what holds on a dense series, and the legend prints each line's own dash and marker. The voice hue never appears in a chart. Lines are straight, bars start from zero, and a chart is printed, not drawn in: `animation: false` at every setting.

`PipelineBar` is an outlined box on the ramp the mock draws: `--rule-2` for the lightest bucket (nobody dialled yet, or Reject on the recommendation bar), then `--control`, `--ink-3`, `--ink-2` and `--ink`, with `--voice-mark` for the on-a-call stage alone. Every tone draws differently, because the swatch is the only link from legend to bar, and a 2px paper gap sets each segment off.

## 10. Motion

- No entrance, no reveal and no count-up anywhere.
- Hover changes colour in 120ms (`duration-hover`). Press scales to 0.97. Chevrons rotate in 150ms.
- Overlay motion stays: dialog 160ms, slide-over 220ms, combobox 140ms, disclosure 180ms.
- `prefers-reduced-motion` removes all of it, including the press scale.
- There is no motion library. Everything left is CSS.

## 11. Dark mode

Retired. `main.tsx` forced the light theme in production, so no user could ever reach a dark app, and no direction defines one. `lib/theme.tsx`, `ThemeToggle`, every `.dark` rule and the Tailwind class strategy are gone.

The one exception is the **exported candidate report**. It is a standalone file a reader opens in their own browser, so it does follow `prefers-color-scheme`. Its dark block maps every Logsheet token to a warm dark counterpart, and `reportStyles.test.ts` checks every text pair for AA in both schemes.

## 12. Accessibility contract

WAI-ARIA tabs for section navigation (roving tabindex, arrow keys); `role="switch"` for booleans; `aria-pressed` on segmented filters; `nav[aria-label]` for pagination; scroll regions are focusable and labelled; all text pairs clear WCAG AA against every ground they sit on (computed, and verified in Playwright with axe at reduced motion).
