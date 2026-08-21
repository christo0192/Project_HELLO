# Candidate experience — palette, primitives and the scorecard

Scope: the Candidates list, Candidate Detail (Overview + Review) and the
authenticated Ashby-scoped review (Overview + Review). Nothing else in the
app is affected, by construction rather than by convention — see
[Containment](#containment).

---

## 1. The palette

`app/web/src/styles/candidate-palette.css` is the **only** file in the
candidate experience allowed to name a colour. Values are the HR-approved
"IK Hiring Dashboard" palette, transcribed from the owner-supplied
screenshots of 2026-08-21.

| Role | Token | Value |
|---|---|---|
| Page ground | `--c-bg` | `#f4f6fb` |
| Card / surface | `--c-surface` | `#ffffff` |
| Border | `--c-border` | `#dbe1ec` |
| Border light / sunken fill | `--c-border-light` | `#eaeef6` |
| Primary text | `--c-ink` | `#0f172a` |
| Secondary text | `--c-ink-secondary` | `#334155` |
| Muted text (cards only) | `--c-ink-muted` | `#6b7391` |
| Accent | `--c-accent` / `--c-accent-light` | `#4E6BA6` / `#eaeef6` |
| Positive | `--c-positive` / `--c-positive-light` | `#398AA2` / `#eaf2f4` |
| Negative | `--c-negative` / `--c-negative-light` | `#b45a72` / `#f7edf0` |
| Caution | `--c-caution` / `--c-caution-light` | `#a16207` / `#fff8eb` |
| Categorical 1–12 + overflow | `--c-cat-1` … `--c-cat-12`, `--c-cat-other` | see the file |
| Chart support | `--c-gridline`, `--c-data-label-outside`, `--c-data-label-inside`, `--c-over-threshold` | see the file |
| Control boundary | `--c-control-border` | `var(--c-ink-muted)` |

**The palette is light-only and fixed.** The source says so explicitly, so
`.dark .candidate-scope` repeats the same values rather than inventing a
dark variant, and `.candidate-scope` sets `color-scheme: light` so native
controls do not flip. A test asserts the two blocks are equal.

### Contrast decisions

The palette is fixed, so where a pair could not reach WCAG AA the *pairing*
changed, never the value. Four such decisions, each with a test:

| Pair | Raw ratio | What changed |
|---|---|---|
| Muted ink on the page ground | 4.33:1 | The inherited `text-ink-tertiary` utility maps to `--c-ink-secondary` inside the scope; `--c-ink-muted` is used only on `--c-surface` (4.68:1). |
| Teal on its own tint (success badge) | 3.47:1 | The success **ink** is the deeper approved cyan `--c-cat-3` (4.62:1). The teal itself still fills meters, where 3.39:1 clears the 3:1 non-text bar. |
| Rose on its own tint (error badge) | 3.94:1 | The approved rose has no darker sibling, so the error **ground** is the card surface (4.52:1). Hue survives in the badge dot and ring. |
| Approved hairline as a control boundary | 1.31:1 | Inputs, selects, secondary buttons and filter toggles use `--c-control-border` (4.68:1). Decorative card hairlines keep `--c-border`. |

`Tag` labels are always `--c-ink-secondary` (≥8.9:1 on every tint); tone is
carried by the tint, the ring, a visible group label and an `srPrefix`.
Nothing in the candidate experience is distinguishable by hue alone.

---

## 2. Containment

`CandidateShell` puts `.candidate-scope` on exactly one element per surface
and every token is declared **on that element**. Descendants resolve them;
nothing else can. There is no Tailwind theme key, no global token value and
no shared primitive changed to make this work — `tailwind.config.js`,
`components/ui.tsx` and `components/Scorecard.tsx` are byte-identical to
`main`, and `src/index.css` gains exactly one `@import` line.

The shell also re-points the app's inherited semantic tokens (`--surface`,
`--ink`, `--line`, `--success`, …) at the candidate palette, so existing
`bg-surface` / `text-ink` / `border-line` utilities resolve to approved
values inside the subtree and are untouched everywhere else.

`variant="inset"` cancels and re-applies `Layout`'s content padding so the
candidate ground reaches the column edges without doubling padding;
`variant="standalone"` owns its own rhythm for the Ashby-scoped route,
which renders outside `Layout`.

### The one bounded exception

`LiveCallPanel` and `LiveKitCallCard` (and the `ui.Card` / `ui.Button` they
render) are shared with the interview surfaces and frozen by the acceptance
contract, yet they mount inside the Candidate Detail Overview. Their
palette utilities are re-pointed by an explicitly enumerated compatibility
block at the bottom of `candidate-palette.css`, scoped to
`.candidate-scope` so nothing outside is affected. Hover states use a
brightness filter rather than a new colour, so the file's literal set stays
exactly the approved palette. A test re-derives the utility list from those
three source files and fails if the block falls behind.

---

## 3. Primitives

| Primitive | Contract |
|---|---|
| `SurfaceCard` | Two levels — `base` (bordered white card) and `sunken` (tinted well inside a card). A third nesting level **throws**; `MAX_SURFACE_DEPTH` is 2. |
| `Meter` | `role="meter"` with `aria-valuenow/min/max`, `aria-valuetext`, and an accessible name from its visible label. Always renders the number in monospace tabular figures **and** the band word (`Low` / `Fair` / `Strong`). Colour is the third signal. 8px track (12px for the overall score). |
| `Tag` | Tone as tint + ring, label as high-contrast ink, plus an optional screen-reader classification prefix. |
| `CandidateButton` / `CandidateInput` / `CandidateSelect` / `CandidateLabel` / states | Token-only stand-ins for the frozen `components/ui` primitives, same props and copy, 44px minimum targets. |
| `CandidateShell` / `CandidateHeader` | The scope boundary and the shared page rhythm. |

### The two-level card rule

Depth is enforced by React context, not by review. The scorecard's own
sections are level 1 and their sunken blocks level 2, so the Review tab
wraps the card in a plain `<section>` with a heading rather than a third
card.

---

## 4. The scorecard

`CandidateScorecard` is **additive**. `components/Scorecard.tsx` is rendered
by Session Detail, the live-call panel and Screening — all out of scope —
so it is untouched, and the redesign is wired in only through the shared
candidate `TranscriptionSyncWorkspace`. That single wiring point is what
makes normal Candidate Review and the Ashby-scoped Review identical
without duplicating any markup.

Defects fixed, each traced to the owner-supplied screenshot:

| Defect | Fix |
|---|---|
| Four sections in a three-column grid orphaned "Role fit" on a two-thirds-empty row | Explicit placement: one column under 640px; two columns from 640px with Communication and Role fit spanning both; from 1024px Communication spans the two short sections' rows in a 12-column grid and Role fit takes the full width. `items-start` keeps unrelated cards at their natural heights. |
| Weights baked into heading strings (`"Communication - 50%"`) | Headings are the section name; the weight is a data label beside it, and the full set is listed in the verdict band. |
| 1.5px hairlines whose colour was the only signal | `Meter`: number + band word + colour, on an 8px track. |
| No accessible semantics on any bar | Full ARIA meter contract on all 17 meters. |
| `text-xs` prose in a ~200px column (~22-character measure) | `text-sm leading-relaxed max-w-prose`, full width within its section, never in a column narrower than 5/12. |
| Tinted blocks nested three deep in the same fill | Level-1 section, level-2 sunken block, enforced. |
| Chips distinguishable only by hue | Visible group label plus a screen-reader prefix on every tag. |

**Deliberately not added:** any computed "contribution to the overall
score". The overall score comes from the model, not from summing the
weighted sections, so that arithmetic would be a fabricated metric. The
weights are shown as the data labels they are.

**Field parity** is the load-bearing guarantee: the same fixture is
rendered through the legacy card and the new one, and every value the
legacy card puts on screen is asserted present in both. The expectation is
derived from the fixture rather than hand-listed, and the legacy assertion
is what proves it is not vacuous. The `raw.*` fallback chain, both
empty-state strings and the legacy rounding are covered.

---

## 5. Frozen copy

These strings are asserted by existing suites and are **not** subject to
the "concise labels" licence:

- `Scorecard for this session`, `Latest scorecard`
- `Scorecards are suppressed while an appeal is under review.`
- `This review link is not available. It may have been removed, or your account may not have access to it.`
- `No candidate responses are available to assess communication.` / `… motivation.`
- `Detailed transcript playback and recording review require admin access. The session scorecard is shown below.`
- `Candidates in your pipeline`, `Upload & Parse`, `Loading candidates…`, `Loading candidate…`, `Loading review…`

---

## 6. Motion

No motion library is imported anywhere in candidate scope, and a test
enforces it. The only animation is the two loading spinners, both collapsed
by the global `prefers-reduced-motion` block in `index.css`. The meters
declare no transition at all.

---

## 7. What is verified, and what is not

Verified mechanically, on every run:

- exact palette literals, and `.dark` equality
- zero stock-Tailwind / brand / raw-literal / `dark:` colour sources in candidate-scoped code
- compatibility coverage for every utility the frozen embedded components use
- WCAG 2.1 contrast arithmetic over the pairs the design actually uses, with a failing weak-pair control and the published 21:1 / 1:1 reference values
- axe on the scorecard, the Candidates list, Candidate Detail and the scoped review, each also inside a `.dark` document
- meter semantics, two-level card depth (a third level throws), field parity, layout placement, prose measure, 44px targets
- the scoped route gaining no link, button or field

**Not** verified: pixel-level visual regression, and no screenshot of any
kind. `app/web` has no Playwright or screenshot runner and adding one is
out of scope. A run outside the project (Playwright installed to a temp
prefix, so `package.json` and the lockfile stay untouched) got as far as a
built harness page before the cached Chromium failed to start —
`libnspr4.so: cannot open shared object file` — and installing OS packages
is outside this lane's authorization. So the guarantees above are
structural and computed, not photographic. That is weaker than a pixel
diff, and no visual comparison at 1440 / 1024 / 390 was performed or is
claimed.
