/**
 * The Ask Hello button's contrast and focus indicator, asserted from the CSS.
 *
 * WHY THIS FILE EXISTS. Three accessibility defects shipped in this button in
 * three consecutive review rounds, and each was introduced while fixing the
 * one before it:
 *
 *   1. `opacity-60` composited the whole subtree, so the white label faded
 *      with the fill: 2.82:1, and 2.39:1 under the sheen — for the entire ten
 *      minutes the button spends saying "Asking Hello…".
 *   2. the focus ring used `var(--c-accent)`, which is declared only under
 *      `.candidate-scope`. The Roles page does not apply that class, so the
 *      custom property was invalid at computed-value time and Tailwind's
 *      preflight default took over: 1.84:1, against the 3:1 SC 1.4.11 needs.
 *   3. `.ask-hello:hover:not([aria-disabled='true'])` is specificity (0,3,0)
 *      against the ring utility's (0,2,0), so a button that was BOTH hovered
 *      and focus-visible lost its entire ring box-shadow to the hover glow.
 *
 * Every one was caught by a human reading the diff. None was caught by CI, and
 * none could have been: the DOM tests assert behaviour, and jsdom-axe cannot
 * evaluate colour contrast at all. So this reads the stylesheet itself.
 *
 * IT READS BOTH FILES, and the first version did not — which made its own
 * docstring false. Defects 1 and 2 were never CSS declarations: they were
 * Tailwind utilities in the component's `className` (`disabled:opacity-60`
 * and `focus-visible:ring-[var(--c-accent)]`). A test that reads only
 * `index.css` cannot see either, and a reviewer proved it by restoring
 * `opacity-60` to the class list — 7/7 green, label back at 2.82:1.
 *
 * So the contrast maths runs over the stylesheet, and a second block asserts
 * the class list of the element that actually carries these utilities.
 *
 * It is deliberately narrow. It is not a general a11y gate — it pins the
 * three things that have actually broken, in the one component where they
 * broke, on whichever side of the CSS/TSX line each one lived.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `index.css` PLUS everything it `@import`s.
 *
 * Reading one file was a hole: appending `.ask-hello { opacity: .6 }` to
 * `styles/candidate-palette.css`, which `index.css` imports on line 1, put
 * the label back at 2.83:1 with this gate green. The cascade does not care
 * which file a rule was written in.
 */
function loadCss(entry: string, seen = new Set<string>()): string {
  const resolved = path.resolve(entry);
  if (seen.has(resolved)) return '';
  seen.add(resolved);
  const src = readFileSync(resolved, 'utf8');
  const dir = path.dirname(resolved);
  const imported = [...src.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith('.') || spec.startsWith('/'))
    .map((spec) => loadCss(path.resolve(dir, spec), seen))
    .join('\n');
  return `${imported}\n${src}`;
}

const CSS = loadCss(path.resolve(HERE, '../index.css'));
const BUTTON = readFileSync(
  path.resolve(HERE, '../components/roles/AskHelloButton.tsx'),
  'utf8',
);

/**
 * The button element's className expression, comments stripped.
 *
 * Comments matter here: this file's own subject comment contains the string
 * `opacity-60`, and matching it would make the guard below fail on a correct
 * component — a false positive is as useless as a false negative.
 */
function buttonClassName(): string {
  const start = BUTTON.indexOf('data-ask-hello=""');
  if (start < 0) throw new Error('could not find the Ask Hello button element');
  const open = BUTTON.indexOf('className={', start);
  if (open < 0) throw new Error('could not find the button className');
  // THROWS rather than returning -1. `slice(open, -1)` is not an error: it
  // returns everything from the className to the end of the file, so the
  // CANCEL button's class list — which also carries `ring-info`,
  // `ring-offset-2` and `ring-2` — satisfied every `toContain` below. Deleting
  // the main button's focus ring entirely then passed. The delimiter is
  // Prettier's output at this JSX depth, so a single nesting change would have
  // done it, and the `length > 80` scaffolding guard catches an EMPTY match,
  // never an over-long one.
  const end = BUTTON.indexOf('\n        >', open);
  if (end < 0) throw new Error('could not find the end of the button className');
  return BUTTON.slice(open, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** WCAG relative luminance, at the 8-bit precision a browser actually paints. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const toRgb = (hex: string) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (rgb: number[]) =>
  '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

/** Two colours mixed, rounded to 8 bits the way compositing does. */
const mix = (a: string, b: string, t: number) =>
  toHex(toRgb(a).map((c, i) => Math.round(c * (1 - t) + toRgb(b)[i] * t)));

/** `over` painted on `under` at `alpha`. */
const over = (under: string, colour: string, alpha: number) => mix(under, colour, alpha);

/**
 * The body of a rule whose selector is EXACTLY `selector`, at a line start.
 *
 * Anchored, because a substring search finds the wrong rule: looking for
 * `.ask-hello__sheen {` matched inside `.ask-hello--idle .ask-hello__sheen {`
 * first, whose body is `display: none` and contains no colour at all. The
 * scaffolding test below is what caught that — which is the point of having
 * one.
 */
function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ANCHORED ON A BOUNDARY, not on the start of a line. Every rule nested in
  // an at-rule is indented, so a `^`-anchored match never read the
  // `@media (prefers-reduced-motion: reduce)` block at all — and that block
  // contains a `.ask-hello` rule. Adding `opacity: .6` there hit every
  // motion-sensitive reader at 2.83:1 with this gate green.
  //
  // `(?:^|[\s}])` still refuses to match `.ask-hello--idle`, which is the
  // mis-match the original `^` was protecting against. It DOES now match a
  // descendant selector — `.candidate-scope .ask-hello` satisfies the `[\s]`
  // — which is over-broad in the SAFE direction: every match is concatenated,
  // so a descendant rule can only ADD declarations the guards then object to,
  // never hide one. Both halves verified by execution, not assumed.
  const found = [
    ...CSS.matchAll(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`, 'gm')),
  ].map((m) => m[1]);
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found;
}

/**
 * EVERY rule for a selector, concatenated — not just the first.
 *
 * The first version returned `CSS.match(...)[1]`, i.e. the first rule only,
 * and was therefore blind to any later override. A reviewer walked straight
 * through it: appending `.ask-hello { opacity: .6 }` after the block
 * reinstated defect 1 with this file green. In CSS the last declaration at
 * equal specificity wins, so a guard that reads only the first is reading the
 * one that loses.
 */
function ruleBody(selector: string): string {
  return ruleBodies(selector).join('\n');
}

/** The `.ask-hello` gradient stops, read from the CSS rather than restated. */
function gradientStops(): string[] {
  return [...ruleBody('.ask-hello').matchAll(/#([0-9a-f]{6})\s+\d+%/gi)].map((m) => `#${m[1]}`);
}

/**
 * The sheen's HEAVIEST white stop.
 *
 * The maximum, not the first: a second, brighter stop added anywhere in that
 * gradient darkens the label further, and reading only the first would miss
 * it. The worst case is what the contrast bar has to clear.
 */
function sheenAlpha(): number {
  const alphas = [
    ...ruleBody('.ask-hello__sheen').matchAll(/rgb\(255 255 255 \/ ([\d.]+)\)/g),
  ].map((m) => Number(m[1]));
  if (alphas.length === 0) throw new Error('could not read the sheen alpha');
  return Math.max(...alphas);
}

const WHITE = '#ffffff';
/** 14px semibold is not WCAG "large text", so the bar is 4.5:1, not 3:1. */
const TEXT_BAR = 4.5;

describe('Ask Hello — label contrast, from the stylesheet', () => {
  it('reads the gradient and the sheen out of the CSS at all', () => {
    // Without this, a renamed class or a reformatted gradient would leave
    // every assertion below sweeping an empty array and passing.
    const stops = gradientStops();
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(new Set(stops).size).toBeGreaterThanOrEqual(3);
    expect(sheenAlpha()).toBeGreaterThan(0);
  });

  it('CLEARS 4.5:1 EVERYWHERE ALONG THE RAMP, under the sheen', () => {
    // Sampled between stops, not just at them: the minimum sits partway along
    // a ramp, and checking only the declared colours would miss it.
    const stops = gradientStops();
    const alpha = sheenAlpha();
    let worst = Infinity;
    let worstAt = '';
    for (let i = 0; i < stops.length - 1; i += 1) {
      for (let step = 0; step <= 200; step += 1) {
        const fill = mix(stops[i], stops[i + 1], step / 200);
        const ratio = contrast(over(fill, WHITE, alpha), WHITE);
        if (ratio < worst) {
          worst = ratio;
          worstAt = fill;
        }
      }
    }
    expect(worst, `worst point on the running button is ${worstAt}`).toBeGreaterThanOrEqual(
      TEXT_BAR,
    );
  });

  it('CLEARS 4.5:1 with no sheen — the reduced-motion state', () => {
    const stops = gradientStops();
    const worst = Math.min(...stops.map((s) => contrast(s, WHITE)));
    expect(worst).toBeGreaterThanOrEqual(TEXT_BAR);
  });

  it('CLEARS 4.5:1 on the idle fill', () => {
    // The flat colour that replaced `opacity-60`. Fading the button faded the
    // LABEL with it, which is how defect 1 happened.
    const m = ruleBody('.ask-hello--idle').match(/background-color:\s*(#[0-9a-f]{6})/i);
    expect(m, 'the idle fill should be a flat declared colour').not.toBeNull();
    expect(contrast(m![1], WHITE)).toBeGreaterThanOrEqual(TEXT_BAR);
  });

  it('applies NO opacity to the button — that is what broke it the first time', () => {
    expect(ruleBody('.ask-hello')).not.toMatch(/^\s*opacity:/m);
  });
});

describe('Ask Hello — the focus indicator survives hover', () => {
  it('the hover rule EXCLUDES the focus-visible state', () => {
    // Defect 3, pinned as itself. `.ask-hello:hover:not([aria-disabled='true'])`
    // is (0,3,0) and the Tailwind ring utility is (0,2,0), so without this the
    // hover glow replaces the ring's box-shadow entirely and the indicator
    // disappears for anyone whose pointer rests over a focused button.
    // BOUNDARY-ANCHORED, for the reason `ruleBodies` is. `^` here meant a
    // hover rule nested in ANY at-rule was invisible to this guard.
    const hoverSelectors = [...CSS.matchAll(/(?:^|[\s}])(\.ask-hello:hover[^{]*)\{/g)].map(
      (m) => m[1].trim(),
    );
    expect(hoverSelectors.length).toBeGreaterThan(0);
    for (const selector of hoverSelectors) {
      expect(selector, `${selector} must not out-specify the focus ring`).toContain(
        ':not(:focus-visible)',
      );
    }
  });

  it('no OTHER state rule on the button clobbers box-shadow either', () => {
    // The hover guard was scoped to `:hover` alone, so
    // `.ask-hello[aria-busy='true'] { box-shadow: none }` (0,2,0) or an
    // `:active` rule (0,3,0) would erase the ring and pass. Any `.ask-hello`
    // rule carrying a state and setting box-shadow has to exclude
    // `:focus-visible`, whatever the state is.
    // BOUNDARY-ANCHORED. While `ruleBodies` was widened this one was left on
    // `^`, so defect 3 stayed reachable verbatim through a wrapper:
    // `@media (min-width: 1px) { .ask-hello[aria-busy='true'] { box-shadow:
    // none } }` is (0,2,0) at equal specificity and later source order, it
    // erases the ring, and all sixteen tests here stayed green. Half-widening
    // a guard is the shape of every repair this file has needed.
    const rules = [...CSS.matchAll(/(?:^|[\s}])(\.ask-hello[^{\n]*)\{([^}]*)\}/g)];
    for (const [, rawSelector, body] of rules) {
      const selector = rawSelector.trim();
      // `:focus-visible` is EXCLUDED from the stateful set: a rule that styles
      // the focus ring itself is the thing being protected, not a threat to
      // it. Requiring `:not(:focus-visible)` there would reject the correct
      // fix.
      const isStateful =
        /:hover|:active|\[aria-|\[data-/.test(selector) && !/:focus-visible/.test(selector);
      if (isStateful && /box-shadow/.test(body)) {
        expect(selector, `${selector} can erase the focus ring`).toContain(
          ':not(:focus-visible)',
        );
      }
    }
  });

  it('every hover rule that sets box-shadow carries that exclusion', () => {
    // Narrower and more direct: it is specifically `box-shadow` that collides
    // with the ring, because Tailwind implements the ring as one.
    const rules = [...CSS.matchAll(/(\.ask-hello:hover[^{]*)\{([^}]*)\}/g)];
    for (const [, selector, body] of rules) {
      if (/box-shadow/.test(body)) {
        expect(selector).toContain(':not(:focus-visible)');
      }
    }
  });
});

describe('Ask Hello — the class list, where two of the three defects lived', () => {
  it('finds the button and its className at all', () => {
    // Same scaffolding rule as the CSS side: a parser that matches nothing
    // makes every assertion below pass against an empty string.
    const cls = buttonClassName();
    expect(cls).toContain('ask-hello');
    expect(cls.length).toBeGreaterThan(80);
  });

  it('applies NO opacity utility ANYWHERE in the component', () => {
    // Scoping this to the button element was a hole. `opacity-60` moved onto
    // the label `<span className="relative">` fades exactly the same text —
    // 2.91-3.19:1 under the sheen — and the button-element check saw nothing.
    // CSS opacity composites a subtree; so does this assertion now.
    //
    // The file's own prose mentions `opacity-60` when explaining the history,
    // so comments are stripped before matching: a false positive on a correct
    // component is as useless as a false negative on a broken one.
    const source = BUTTON.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(source).not.toMatch(/\bopacity-\d/);
  });

  it('applies NO opacity utility on the button element itself — defect 1 verbatim', () => {
    // `disabled:opacity-60` on this element faded the whole subtree, label
    // included: 2.82-3.05:1, and 2.39-2.53:1 under the sheen, for the entire
    // ten minutes the button spends saying "Asking Hello…". The stylesheet
    // guard cannot see this, because the utility never appears there.
    expect(buttonClassName()).not.toMatch(/\bopacity-\d/);
  });

  it('uses an APP-SCOPE ring token — defect 2, also never in the CSS', () => {
    // `focus-visible:ring-[var(--c-accent)]` is declared only under
    // `.candidate-scope`, which the Roles page does not apply. Off-scope the
    // custom property is invalid at computed-value time and Tailwind's
    // preflight default takes over at 1.84:1, against the 3:1 SC 1.4.11
    // needs. Any candidate-scoped ring token here is the same bug wearing a
    // different name. (Written in prose deliberately: a glob-shaped
    // arbitrary value in a comment is still a Tailwind candidate, and an
    // asterisk inside one is what broke the production CSS build.)
    const cls = buttonClassName();
    expect(cls).toContain('focus-visible:ring-info');
    // ASSEMBLED, not written as one literal. Tailwind's content globs include
    // `src/**/*.{ts,tsx}`, tests included, and its extractor pulled the
    // INCOMPLETE arbitrary value `ring-[var(--c-` straight out of this file's
    // source and generated broken CSS from it — lightningcss then failed the
    // production build with `Unexpected token Delim('*')`. The complete forms
    // elsewhere in the codebase (`ring-[var(--c-accent)]`) are fine; a
    // truncated one is not, and a regex is the one place you write one.
    const scopedRingToken = new RegExp('ring-' + '\\[var\\(--c-');
    expect(cls).not.toMatch(scopedRingToken);
  });

  it('keeps the label WHITE — every contrast figure above assumes it', () => {
    // The stylesheet maths is all "white text on the gradient". A label
    // recoloured in the class list would silently invalidate all of it.
    expect(buttonClassName()).toContain('text-white');
  });

  it('carries a visible focus ring at all', () => {
    const cls = buttonClassName();
    expect(cls).toContain('focus-visible:ring-2');
    expect(cls).toContain('focus-visible:ring-offset-2');
  });

  it('the ring COLOUR clears 3:1 against the offset — a name is not a ratio', () => {
    // Defect 2 was a CONTRAST failure and its guard was a spelling check.
    // `ring-info` resolves through `--info-rgb`, and repointing that token at
    // a paler existing palette value drops the ring to 2.56:1 against the
    // white offset — SC 1.4.11 wants 3:1 — with every name-based assertion
    // still green. So compute it.
    const m = CSS.match(/--info-rgb:\s*(\d+)\s+(\d+)\s+(\d+)/);
    expect(m, '--info-rgb must be declared for `ring-info` to resolve').not.toBeNull();
    const hex =
      '#' +
      [1, 2, 3].map((i) => Number(m![i]).toString(16).padStart(2, '0')).join('');
    // The ring offset is Tailwind's preflight default, white.
    expect(contrast(hex, WHITE)).toBeGreaterThanOrEqual(3);
  });

  it('declares `--info-rgb` at :root, not only inside a scope', () => {
    // The whole of defect 2: `--c-accent` exists only under
    // `.candidate-scope`, which the Roles page does not apply, so the custom
    // property was invalid at computed-value time and Tailwind's preflight
    // default took over at 1.84:1.
    const rootBlock = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('--info-rgb') + 40);
    expect(rootBlock).toContain('--info-rgb');
    expect(rootBlock).not.toContain('.candidate-scope');
  });
});
