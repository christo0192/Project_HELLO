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
 * It is deliberately narrow. It does not try to be a general a11y gate — it
 * pins the three things that have actually broken, in the one component where
 * they broke.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8',
);

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
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

/** The `.ask-hello` gradient stops, read from the CSS rather than restated. */
function gradientStops(): string[] {
  return [...ruleBody('.ask-hello').matchAll(/#([0-9a-f]{6})\s+\d+%/gi)].map((m) => `#${m[1]}`);
}

/** The sheen's white alpha, read from the CSS. */
function sheenAlpha(): number {
  const m = ruleBody('.ask-hello__sheen').match(/rgb\(255 255 255 \/ ([\d.]+)\)/);
  if (!m) throw new Error('could not read the sheen alpha');
  return Number(m[1]);
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
    const hoverSelectors = [...CSS.matchAll(/^(\.ask-hello:hover[^{]*)\{/gm)].map((m) =>
      m[1].trim(),
    );
    expect(hoverSelectors.length).toBeGreaterThan(0);
    for (const selector of hoverSelectors) {
      expect(selector, `${selector} must not out-specify the focus ring`).toContain(
        ':not(:focus-visible)',
      );
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
