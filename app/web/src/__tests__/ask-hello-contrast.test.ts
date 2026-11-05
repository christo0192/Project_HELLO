/**
 * The Ask Hello button's contrast and focus indicator, asserted from the CSS.
 *
 * WHY THIS FILE EXISTS. Three accessibility defects shipped in this button in
 * three consecutive review rounds, and each was introduced while fixing the
 * one before it:
 *
 *   1. `opacity-60` composited the whole subtree, so the white label faded
 *      with the fill: 2.82:1 for the entire ten minutes the button spends
 *      saying "Asking Hello…".
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
  // COMMENTS STRIPPED. Several scanners below have to read across newlines
  // to see a multi-line selector list, and a `.ask-hello` mentioned in prose
  // would otherwise let such a scan start in the middle of a comment and run
  // to some unrelated rule's brace.
  return `${imported}\n${src}`.replace(/\/\*[\s\S]*?\*\//g, '');
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
    ...CSS.matchAll(new RegExp(`(?:^|[\\s},>+~])${escaped}\\s*\\{([^}]*)\\}`, 'gm')),
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

/** A palette token's hex, read from the stylesheet rather than restated. */
function tokenHex(name: string): string {
  const m = CSS.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'));
  if (!m) throw new Error(`${name} is not declared as a 6-digit hex`);
  return m[1];
}

/**
 * The fill a rule paints, resolved to a hex. Throws rather than returning
 * nothing: a parser that silently drops what it cannot read is the failure mode
 * this file has had three times.
 */
function fillOf(selector: string): string {
  const m = ruleBody(selector).match(/background-color:\s*var\((--[\w-]+)\)/);
  if (!m) throw new Error(`${selector} paints no token fill`);
  return tokenHex(m[1]);
}

/**
 * The button's class list as WHOLE TOKENS.
 *
 * `expect(cls).toContain('text-white')` is a SUBSTRING test, and
 * `text-white/60` contains it. So does `focus-visible:ring-info/40`. Those
 * two one-character edits are the most natural way anyone "softens" this
 * button, and they reproduce defect 1 (label at 2.90:1 under the sheen) and
 * defect 2 (ring at 1.76:1 — worse than the 1.84:1 that defect 2 shipped)
 * with every assertion in this file green. Array `toContain` is
 * exact-element, so a modified utility is a different token and fails.
 */
function buttonTokens(): string[] {
  return buttonClassName().split(/\s+/).filter(Boolean);
}

/**
 * EVERY rule whose selector mentions `.ask-hello`, descendants included.
 *
 * `ruleBodies` requires `\s*\{` right after the selector, so it reads rules
 * ON the element and is blind to rules on its CHILDREN — and CSS opacity
 * composites a subtree, which is exactly how it does its damage.
 * `.ask-hello span { opacity: .6 }` fades the label to 2.82:1 and was
 * invisible to every check here.
 *
 * `@keyframes ask-hello-drift` is excluded because it has no dot.
 */
function askHelloRules(): Array<{ selector: string; body: string }> {
  return [...CSS.matchAll(/([^{}]*\.ask-hello[^{}]*)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}

const WHITE = '#ffffff';
/** 14px semibold is not WCAG "large text", so the bar is 4.5:1, not 3:1. */
const TEXT_BAR = 4.5;

describe('Ask Hello — label contrast, from the stylesheet', () => {
  it('reads the fills out of the CSS at all', () => {
    // Without this, a renamed class would leave every assertion below passing.
    expect(fillOf('.ask-hello')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(fillOf('.ask-hello--idle')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('CLEARS 4.5:1 on the fill', () => {
    expect(contrast(fillOf('.ask-hello'), WHITE)).toBeGreaterThanOrEqual(TEXT_BAR);
  });

  it('CLEARS 4.5:1 on the idle fill', () => {
    // The flat colour that replaced `opacity-60`. Fading the button faded the
    // LABEL with it, which is how defect 1 happened.
    expect(contrast(fillOf('.ask-hello--idle'), WHITE)).toBeGreaterThanOrEqual(TEXT_BAR);
  });

  it('CLEARS 4.5:1 on hover', () => {
    const hover = CSS.match(/\.ask-hello:hover[^{]*\{[^}]*background-color:\s*var\((--[\w-]+)\)/);
    expect(hover, 'the hover rule should change the fill').not.toBeNull();
    expect(contrast(tokenHex(hover![1]), WHITE)).toBeGreaterThanOrEqual(TEXT_BAR);
  });

  it('paints no gradient and runs no animation: the label carries the progress', () => {
    for (const { selector, body } of askHelloRules()) {
      expect(body, `${selector} paints a gradient`).not.toMatch(/gradient\(/);
      expect(body, `${selector} animates`).not.toMatch(/(?:^|[;{\s])animation\s*:/);
    }
    expect(BUTTON).not.toContain('ask-hello__sheen');
  });

  it('applies NO opacity to the button — that is what broke it the first time', () => {
    // NOT LINE-ANCHORED. `/^\s*opacity:/m` only saw a declaration that began
    // its own line, and nothing in this repo reformats CSS — `npm run lint`
    // is oxlint, JS and TS only. Writing it second on an existing line
    // (`background-position: 0 0; opacity: .6`) reinstated defect 1 verbatim
    // at 2.82:1 with all sixteen tests green.
    expect(ruleBody('.ask-hello')).not.toMatch(/(?:^|[;{\s])opacity\s*:/);
  });

  it('NOTHING in the subtree fades or recolours the label', () => {
    // Rules on the CHILDREN, which `ruleBodies` cannot see at all.
    // `.ask-hello span { opacity: .6 }` is the same 2.82:1 defect one
    // selector to the right, and `.ask-hello { color: #9db0d6 }` is 3.22:1
    // while every ratio computed in this file assumes the label is white.
    //
    // A PARTIAL opacity is the defect; `opacity: 0` is not. The
    // reduced-motion rule hides the decorative sheen outright and must stay
    // legal, so the bar is "strictly between 0 and 1", not "absent".
    const rules = askHelloRules();
    expect(rules.length, 'the rule scanner must find the stylesheet').toBeGreaterThanOrEqual(3);
    for (const { selector, body } of rules) {
      const fade = body.match(/(?:^|[;{\s])opacity\s*:\s*([\d.]+)/);
      if (fade) {
        const value = Number(fade[1]);
        expect(value === 0 || value === 1, `${selector} fades the label to ${value}`).toBe(true);
      }

      // FADING IS NOT ONLY `opacity:`. `filter: opacity(.6)` composites the
      // identical 2.82:1 result and has no colon after the word, so the
      // declaration guard above never saw it. `mix-blend-mode` and
      // `backdrop-filter` change the composite too. None of them has any
      // business on this button, so none is allowed rather than parsed.
      expect(body, `${selector} composites the label away`).not.toMatch(
        /(?:^|[;{\s])(?:filter|backdrop-filter|mix-blend-mode)\s*:/,
      );

      // RECOLOURING IS NOT ONLY `color:`. `-webkit-text-fill-color` paints
      // the glyphs in every Chromium and WebKit browser and evaded the old
      // check because the character before `color` is `-`, not whitespace.
      // So every `*color` property is examined and only the ones that cannot
      // touch the label are let through — an allowlist, because the next
      // vendor-prefixed text-colour property has not been invented yet.
      const SAFE_COLOUR_PROPERTIES =
        /^(?:background|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|outline|column-rule|caret|text-decoration|text-emphasis|accent|flood|lighting|stop|--tw-[a-z-]*)-color$/;
      for (const [, property] of body.matchAll(/(?:^|[;{\s])([-a-z]*color)\s*:/gi)) {
        expect(
          SAFE_COLOUR_PROPERTIES.test(property.toLowerCase()),
          `${selector} sets ${property}, which can repaint the label`,
        ).toBe(true);
      }
    }
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
    const hoverSelectors = [...CSS.matchAll(/(?:^|[\s},>+~])(\.ask-hello:hover[^{]*)\{/g)].map(
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
    // SELECTOR LISTS SPAN LINES, and `[^{\n]*` could not cross the newline
    // after a comma — so in
    //
    //     .ask-hello[aria-disabled='true'],
    //     .ask-hello.is-busy { box-shadow: none; }
    //
    // the only selector this scanner ever examined was the harmless second
    // one, while the first erased the ring for the whole draft. Defect 3,
    // unwrapped, through a formatting choice that is completely ordinary.
    // Newlines allowed now, and each comma-separated part tested on its own.
    // `,` IS IN THE BOUNDARY CLASS. Splitting selector lists on commas was
    // only half of it: `.zz-noop,.ask-hello[aria-busy='true']{box-shadow:none}`
    // — a list written without a space, which minifiers and plenty of people
    // produce — never matched at all, because the character before
    // `.ask-hello` was a comma and the prefix wanted whitespace or `}`. That
    // rule is (0,2,0), later in source order, unlayered: defect 3 verbatim.
    // COMBINATORS ARE BOUNDARY CHARACTERS. `,` was added when a comma with no
    // space walked through; `.candidate-scope>.ask-hello:hover { box-shadow:
    // none }` walked through the same hole one character over, because `>`
    // was not in the class either. `+` and `~` are the remaining two.
    const rules = [...CSS.matchAll(/(?:^|[\s},>+~])(\.ask-hello[^{]*)\{([^}]*)\}/g)];
    const parts = rules.flatMap(([, rawSelector, body]) =>
      rawSelector.split(',').map((one) => [one, body] as const),
    );
    expect(parts.length, 'the state-rule scanner must find the stylesheet').toBeGreaterThan(0);
    for (const [rawSelector, body] of parts) {
      const selector = rawSelector.trim();
      if (!selector.startsWith('.ask-hello')) continue;
      // `:focus-visible` IS IN THE STATEFUL SET. Exempting it was the hole:
      // `.ask-hello:focus-visible { box-shadow: … }` is (0,2,0), equal to the
      // Tailwind ring utility and later in source order, so it REPLACES the
      // ring rather than adding to it — defect 3 through a different door,
      // and green. The stylesheet has no business setting box-shadow on a
      // focus-visible selector at all; the ring is Tailwind's.
      //
      // The base `.ask-hello` and `.ask-hello--idle` rules do set box-shadow
      // and carry no state, so they stay exempt — at (0,1,0) they lose to the
      // ring on specificity and cannot erase it.
      const isStateful = /:hover|:active|:focus|\[aria-|\[data-/.test(selector);
      // `--tw-ring-*` IS THE RING. Tailwind compiles the ring to
      // `box-shadow: … var(--tw-ring-color)`, so
      // `.ask-hello[aria-busy='true'] { --tw-ring-color: transparent }` is
      // (0,2,0), later in source order, and makes the indicator vanish for
      // the entire draft — without the string `box-shadow` appearing
      // anywhere. Gating on the property name alone read the implementation
      // and missed the mechanism.
      if (isStateful && /box-shadow|--tw-ring-/.test(body)) {
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
    expect(buttonTokens()).toContain('focus-visible:ring-info');
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
    expect(buttonTokens()).toContain('text-white');
  });

  it('carries NO ALPHA MODIFIER on the two utilities every figure here assumes', () => {
    // `text-white/60` and `focus-visible:ring-info/40` are one character
    // each. They paint 2.90:1 and 1.76:1 — both worse than the defects this
    // file was written to stop — and a substring assertion cannot tell them
    // from the utilities they modify. The token checks above already reject
    // them; this says WHY out loud and covers the whole component, not just
    // the button element, so the same edit on the label span is caught too.
    const source = BUTTON.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(source).not.toMatch(/(?:text-white|ring-info|ring-offset-white)\/\d/);
  });

  it('carries a visible focus ring at all', () => {
    const tokens = buttonTokens();
    expect(tokens).toContain('focus-visible:ring-2');
    expect(tokens).toContain('focus-visible:ring-offset-2');
  });

  it('the ring COLOUR clears 3:1 against the offset — a name is not a ratio', () => {
    // Defect 2 was a CONTRAST failure and its guard was a spelling check.
    // `ring-info` resolves through `--info-rgb`, and repointing that token at
    // a paler existing palette value drops the ring to 2.56:1 against the
    // white offset — SC 1.4.11 wants 3:1 — with every name-based assertion
    // still green. So compute it.
    // EVERY DECLARATION, not the first. `CSS.match` is first-match-only, so
    // appending `:root { --info-rgb: 147 197 253 }` won the cascade and
    // painted a 1.80:1 ring — worse than the 1.84:1 defect 2 actually
    // shipped — while this test went on reading the original value. That is
    // the identical bug already fixed in `ruleBody` ("a guard that reads only
    // the first is reading the one that loses"), left standing here.
    //
    // Checking all of them rather than only the last is deliberate: a token
    // that fails the bar has no business in the file under any selector.
    const declared = [...CSS.matchAll(/--info-rgb:\s*(\d+)\s+(\d+)\s+(\d+)/g)];
    expect(
      declared.length,
      '--info-rgb must be declared for `ring-info` to resolve',
    ).toBeGreaterThan(0);
    for (const m of declared) {
      const hex =
        '#' +
        [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
      // The ring offset is Tailwind's preflight default, white.
      expect(contrast(hex, WHITE), `--info-rgb: ${m[1]} ${m[2]} ${m[3]}`).toBeGreaterThanOrEqual(3);
    }
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

/**
 * THE SCOREBAR'S ASK HELLO wears the same fill, so it carries the same three
 * risks — and this file only ever read `AskHelloButton.tsx`. The stylesheet
 * maths above covers every `.ask-hello` element; what it cannot see is a
 * utility in THIS component's class list, which is exactly where defects 1
 * and 2 lived. So the class-list guards run here too.
 */
describe('Ask Hello — the Scorebar metric button (MetricAskHello)', () => {
  const SOURCE = readFileSync(
    path.resolve(HERE, '../components/mission-control/MetricAskHello.tsx'),
    'utf8',
  );
  // Comments stripped for the reason given at `buttonClassName`.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * The `className={…}` expression of the `data-ask-hello` element, found by
   * BRACE MATCHING rather than by a Prettier-depth delimiter: this component's
   * expression is a template literal with a nested `${…}`, and throwing on a
   * missing close is the same guard `buttonClassName` needed.
   */
  function metricClassName(): string {
    const start = CODE.indexOf('data-ask-hello=""');
    if (start < 0) throw new Error('could not find the metric Ask Hello button element');
    const open = CODE.indexOf('className={', start);
    if (open < 0) throw new Error('could not find the metric button className');
    let depth = 0;
    for (let i = open + 'className='.length; i < CODE.length; i += 1) {
      if (CODE[i] === '{') depth += 1;
      if (CODE[i] === '}') {
        depth -= 1;
        if (depth === 0) return CODE.slice(open, i + 1);
      }
    }
    throw new Error('could not find the end of the metric button className');
  }

  /** Whole tokens, so `text-white/60` is not mistaken for `text-white`. */
  function metricTokens(): string[] {
    return metricClassName()
      .split(/[\s`'"{}$?:()]+/)
      .filter(Boolean);
  }

  it('finds the button and its className at all', () => {
    const cls = metricClassName();
    expect(cls).toContain('ask-hello');
    expect(cls.length).toBeGreaterThan(80);
  });

  it('applies NO opacity utility anywhere in the component', () => {
    expect(CODE).not.toMatch(/\bopacity-\d/);
  });

  it('keeps the white label, the app-scope ring and a visible focus ring', () => {
    // `split` on `:` would cut `focus-visible:ring-info` in two, so the ring
    // utilities are checked on the raw expression with a word boundary.
    const cls = metricClassName();
    expect(metricTokens()).toContain('text-white');
    expect(cls).toMatch(/(?:^|\s)focus-visible:ring-info(?=\s|$|`|')/);
    expect(cls).toMatch(/(?:^|\s)focus-visible:ring-2(?=\s|$|`|')/);
    expect(cls).toMatch(/(?:^|\s)focus-visible:ring-offset-2(?=\s|$|`|')/);
    expect(cls).not.toMatch(new RegExp('ring-' + '\\[var\\(--c-'));
  });

  it('carries NO ALPHA MODIFIER on the utilities the contrast figures assume', () => {
    expect(CODE).not.toMatch(/(?:text-white|ring-info|ring-offset-white)\/\d/);
  });

  it('shows "unavailable" with the MEASURED idle fill, not a fade', () => {
    expect(metricTokens()).toContain('ask-hello--idle');
  });
});
