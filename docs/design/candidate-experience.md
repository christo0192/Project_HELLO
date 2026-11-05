# Candidate experience — palette, primitives and the scorecard

Scope: the Candidates list, Candidate Detail (Overview + Review) and the
authenticated Ashby-scoped review (Overview + Review). Nothing else in the
app is affected, by construction rather than by convention — see
[Containment](#containment).

---

## 1. The palette

`app/web/src/styles/candidate-palette.css` maps the `--c-*` names onto the
Logsheet tokens in `src/index.css`
([hello-glass-design-system.md](hello-glass-design-system.md)). It holds no colour
of its own, so the palette has one source.

| Role | Token | Maps to |
|---|---|---|
| Page ground | `--c-bg` | `--desk` |
| Card / surface | `--c-surface` | `--paper` |
| Border | `--c-border` | `--rule-2` |
| Shaded field | `--c-border-light` | `--field` |
| Primary text | `--c-ink` | `--ink` |
| Secondary text | `--c-ink-secondary` | `--ink-2` |
| Muted text | `--c-ink-muted` | `--ink-3` |
| Accent | `--c-accent` / `--c-accent-light` | `--ink` / `--field` |
| Positive | `--c-positive` / `--c-positive-light` | `--ink-2` / `--field` |
| Caution | `--c-caution` / `--c-caution-light` | `--ink-2` / `--field` |
| Negative | `--c-negative` / `--c-negative-light` | `--danger` / `--paper` |
| Label on a fill | `--c-data-label-inside` | `--paper` |
| Control boundary | `--c-control-border` | `--control` |

**The palette is light-only.** `.candidate-scope` sets `color-scheme: light` so
native controls do not flip, and no dark variant exists.

### Contrast decisions

Every pair the candidate surfaces paint is computed by
`candidate-scope-palette.test.ts`. Two rules carry over from the old palette:

- `Tag` labels are always `--c-ink-secondary`; tone is carried by the tint, the
  ring, a visible group label and an `srPrefix`. Nothing in the candidate
  experience is distinguishable by hue alone.
- `--c-negative` and `--c-positive` are banned outright as text utilities
  anywhere in candidate scope by a source guard. Tone fills, rings and borders;
  ink writes.

Verdicts are ink: a score, a meter and a recommendation take no hue. Crimson
means a fault on our side.

---

## 2. Containment

`CandidateShell` puts `.candidate-scope` on exactly one element per surface
and every `--c-*` name is declared **on that element**. Descendants resolve
them; nothing else can. The app's semantic tokens (`--surface`, `--ink`,
`--line`, …) are already Logsheet at `:root`, so `bg-surface`, `text-ink` and
`border-line` resolve the same inside the subtree as outside it.

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
`.candidate-scope` so nothing outside is affected. A test re-derives the utility list from those
three source files and fails if the block falls behind.

---

## 3. Primitives

| Primitive | Contract |
|---|---|
| `SurfaceCard` | Two levels — `base` (a printed box on the sheet) and `sunken` (a shaded field inside a box). A third nesting level is reported and clamped; `MAX_SURFACE_DEPTH` is 2. |
| `Meter` | `role="meter"` with `aria-valuenow/min/max`, `aria-valuetext`, and an accessible name from its visible label. Always renders the number in monospace tabular figures **and** the band word (`Low` / `Fair` / `Strong`). Colour is the third signal. 8px track (12px for the overall score). |
| `Tag` | Tone as tint + ring, label as high-contrast ink, plus an optional screen-reader classification prefix. |
| `CandidateButton` / `CandidateInput` / `CandidateSelect` / `CandidateLabel` / states | Token-only stand-ins for the frozen `components/ui` primitives, same props and copy, 44px minimum targets. |
| `CandidateShell` / `CandidateHeader` | The scope boundary and the shared page rhythm. |

### The two-level card rule

Depth is enforced by React context, not by review. The scorecard's own
sections are level 1 and their sunken blocks level 2, so the Review tab
wraps the card in a plain `<section>` with a heading rather than a third
card.

An overflowing level is **reported and clamped, never fatal**. The test
harness fails on an unexpected `console.error`, so a composition mistake
stops CI exactly as a thrown error would, while a production page keeps
rendering — blanking a recruiter's candidate view over a visual-hierarchy
rule would be a far worse outcome than one card too many. Gating a throw on
`import.meta.env.DEV` was tried and rejected: `scripts/check-env-contract.mjs`
treats every `import.meta.env.X` read as a schema obligation, so the guard
would have added a fake runtime variable to the environment contract.

### Where the primitives live

They are exported from `components/design/candidate.ts`, **not** from the
shared `components/design` barrel. That barrel is imported by Mission
Control, Session Detail, the Dashboard and the auth pages, none of which
render inside `.candidate-scope`; re-exporting from there would make all of
them load modules they can never use, and would stop `design/index.ts` being
identical to `main` for no benefit.

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

### axe cannot check contrast here — so the arithmetic list is the whole guard

axe-core's `color-contrast` rule needs a canvas to resolve computed colours.
Under jsdom it aborts and reports the node as **incomplete**, and
`toHaveNoViolations` asserts only on `violations`. Probed directly against
this repo's own axe-core with a deliberately failing pair: `violations: 0,
incomplete: 1, passes: 0`.

Every axe suite in this repo is therefore **structurally incapable of failing
on contrast**. That is not a theoretical gap: a 3.94:1 error-state pairing
shipped past four green axe suites, and only an independent arithmetic
re-derivation caught it.

Two consequences, both now enforced:

1. The pinned pair list is not a sample — it must enumerate **every**
   foreground/background pair the components actually render, including the
   tinted grounds.
2. A source guard bans the two tone colours as text outright, because the
   arithmetic list can only check pairs the design *intends*; a component is
   free to pair two others, which is exactly what happened.

The limitation itself is pinned by a test, so if axe ever gains this
capability under jsdom, that test fails and tells us.

Verified mechanically, on every run:

- every `--c-*` name pinned to its Logsheet token, and no colour of its own in the file
- WCAG 2.1 arithmetic over every rendered pair, **plus** the rejected pairings
  asserted to be below AA, so each re-pairing decision stays falsifiable
- the two tone colours never appearing as a text utility in candidate source
- the environment contract (`scripts/check-env-contract.mjs`), which the
  candidate code adds no runtime variable to
- zero stock-Tailwind / brand / raw-literal / `dark:` colour sources in candidate-scoped code
- compatibility coverage for every utility the frozen embedded components use
- WCAG 2.1 contrast arithmetic over the pairs the design actually uses, with a failing weak-pair control and the published 21:1 / 1:1 reference values
- axe on the scorecard, the Candidates list, Candidate Detail and the scoped review
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
