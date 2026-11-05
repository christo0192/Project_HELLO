/**
 * The Logsheet design system, asserted from the source.
 *
 * jsdom has no layout, no canvas and no cascade, and axe cannot evaluate colour
 * contrast under it (candidate-scope-palette.test.ts pins that fact). So this
 * reads the stylesheets and the source directly: the approved token values,
 * every declared WCAG pair, the one pair of voice tokens, and the absence of
 * the materials and motion the direction removed.
 *
 * Source of the values: `.gsd/milestones/M026/directions/logsheet/DIRECTION.md`,
 * approved by the owner and the stakeholder on 2026-11-05.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const indexCss = read('src/index.css');
const STYLESHEETS = [
  'src/index.css',
  'src/styles/candidate-palette.css',
  'src/styles/candidate-experience.css',
  'src/styles/candidate-r1.css',
];

/** Every non-test source file under src/, relative, forward slashes. */
function sourceFiles(): string[] {
  const root = resolve(WEB, 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((rel) => `src/${rel.replace(/\\/g, '/')}`)
    .filter((rel) => /\.(ts|tsx)$/.test(rel))
    .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel));
}

const TOKENS: Record<string, string> = {
  '--desk': '#e9e7e0',
  '--paper': '#fbfaf6',
  '--field': '#f2f0ea',
  '--rule': '#e2dfd7',
  '--rule-2': '#cfcbc1',
  '--control': '#827d74',
  '--ink': '#1b1915',
  '--ink-2': '#48443d',
  '--ink-3': '#66615a',
  '--voice': '#a8460c',
  '--voice-mark': '#cf5a12',
  '--wash': '#fde0c5',
  '--ai': '#8c877e',
  '--danger': '#a01c3c',
  '--plate': '#ffffff',
};

/** A token's literal value in index.css, or null when it is not a 6-digit hex. */
function declared(name: string): string | null {
  const hit = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(indexCss);
  return hit ? hit[1].toLowerCase() : null;
}

function value(name: string): string {
  const hex = declared(name);
  if (!hex) throw new Error(`${name} is not declared as a hex in index.css`);
  return hex;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** [foreground, background, minimum, stated ratio from DIRECTION.md, what it is]. */
const PAIRS: Array<[string, string, number, number, string]> = [
  ['--ink', '--paper', 4.5, 16.8, 'names, the candidate words, figures'],
  ['--ink', '--field', 4.5, 15.4, 'the active transcript row'],
  ['--ink', '--desk', 4.5, 14.18, 'sidebar text'],
  ['--ink', '--wash', 4.5, 13.91, 'highlighted quote text'],
  ['--ink-2', '--paper', 4.5, 9.27, 'body text'],
  ['--ink-2', '--field', 4.5, 8.49, 'the interviewer words on the active row'],
  ['--ink-2', '--desk', 4.5, 7.82, 'nav labels'],
  ['--ink-2', '--wash', 4.5, 7.67, 'the quote reference next to a highlight'],
  ['--ink-3', '--paper', 4.5, 5.87, 'labels, meta, turn numbers'],
  ['--ink-3', '--field', 4.5, 5.38, 'the turn number on the active row'],
  ['--ink-3', '--desk', 4.5, 4.96, 'nav group labels, the scope line'],
  ['--voice', '--paper', 4.5, 5.67, 'the candidate speaker label'],
  ['--voice', '--field', 4.5, 5.2, 'the speaker label on the active row'],
  ['--paper', '--ink', 4.5, 16.8, 'the primary button'],
  ['--danger', '--paper', 4.5, 7.38, 'fault text'],
  ['--paper', '--danger', 4.5, 7.38, 'Halt all calling, filled'],
  ['--control', '--paper', 3, 3.92, 'control borders'],
  ['--control', '--field', 3, 3.59, 'controls on a shaded field'],
  ['--control', '--desk', 3, 3.31, 'the active nav edge'],
  ['--voice-mark', '--paper', 3, 3.92, 'candidate segments'],
  ['--voice-mark', '--field', 3, 3.6, 'swatches on a field'],
  ['--ai', '--paper', 3, 3.42, 'interviewer segments'],
];

/** Below 3:1 on purpose; DIRECTION.md says why. Pinned so a change is noticed. */
const DECORATIVE_PAIRS: Array<[string, string, string]> = [
  ['--voice-mark', '--ai', 'told apart by height and speaker labels, not colour'],
  ['--wash', '--paper', 'every quote is also numbered, ticked and repeated as a button'],
  ['--rule', '--paper', 'a decorative printed rule; no state depends on it'],
  ['--rule-2', '--paper', 'a decorative printed rule; no state depends on it'],
];

describe('Logsheet tokens', () => {
  it.each(Object.entries(TOKENS))('%s is %s', (name, hex) => {
    expect(declared(name)).toBe(hex);
  });

  it('keeps the alpha-capable triples in step with their hex tokens', () => {
    for (const [triple, token] of [
      ['--ink-rgb', '--ink'],
      ['--info-rgb', '--ink'],
      ['--ink-muted-rgb', '--control'],
      ['--danger-rgb', '--danger'],
    ]) {
      const hit = new RegExp(`${triple}:\\s*(\\d+) (\\d+) (\\d+);`).exec(indexCss);
      expect(hit, `${triple} is not declared`).not.toBeNull();
      const hex = `#${[1, 2, 3].map((i) => Number(hit![i]).toString(16).padStart(2, '0')).join('')}`;
      expect(hex, triple).toBe(value(token));
    }
  });

  it.each([
    ['--surface', 'paper'],
    ['--surface-secondary', 'field'],
    ['--surface-tertiary', 'desk'],
    ['--ink-secondary', 'ink-2'],
    ['--ink-tertiary', 'ink-3'],
    ['--ink-muted', 'control'],
    ['--line', 'rule'],
    ['--line-strong', 'rule-2'],
    ['--info', 'ink'],
    ['--info-soft', 'field'],
    ['--success', 'ink-2'],
    ['--success-text', 'ink-2'],
    ['--success-soft', 'field'],
    ['--warning', 'ink-2'],
    ['--warning-text', 'ink'],
    ['--warning-soft', 'field'],
    ['--error', 'danger'],
    ['--error-text', 'danger'],
    ['--error-soft', 'paper'],
    ['--glass-ring', 'rule'],
    ['--glass-ring-strong', 'rule-2'],
  ])('maps the semantic name %s onto --%s', (semantic, token) => {
    const hit = new RegExp(`^\\s*${semantic}:\\s*var\\(--${token}\\)\\s*;`, 'm').exec(indexCss);
    expect(hit, `${semantic} should be var(--${token})`).not.toBeNull();
  });

  it('declares no colour literal outside the token block, the go green and the rgb triples', () => {
    const css = stripCssComments(indexCss);
    const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    const allowed = new Set([...Object.values(TOKENS), value('--go'), value('--go-strong')]);
    expect(hexes.filter((hex) => !allowed.has(hex.toLowerCase()))).toEqual([]);
  });
});

describe('Logsheet contrast (WCAG 2.x, computed)', () => {
  it.each(PAIRS)('%s on %s clears %s:1 (%s, %s)', (fg, bg, minimum, stated) => {
    const ratio = contrast(value(fg), value(bg));
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(minimum);
    // The figure the design record quotes, so the record cannot drift.
    expect(ratio).toBeCloseTo(stated, 1);
  });

  it.each(DECORATIVE_PAIRS)('%s on %s stays below 3:1 by design (%s)', (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeLessThan(3);
  });

  it('NEGATIVE CONTROL: the maths matches the published reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#827d74', '#827d74')).toBeCloseTo(1, 5);
    expect(contrast('#777777', '#888888')).toBeLessThan(3);
  });
});

describe('the voice hue', () => {
  it('is defined in exactly one pair of tokens, in one file', () => {
    const css = stripCssComments(indexCss);
    expect(css.match(/--voice:\s/g)).toHaveLength(1);
    expect(css.match(/--voice-mark:\s/g)).toHaveLength(1);
    const elsewhere = [...sourceFiles(), ...STYLESHEETS.slice(1)].filter((rel) =>
      /#a8460c|#cf5a12/i.test(read(rel)),
    );
    expect(elsewhere).toEqual([]);
  });

  it('never fills a button, a link or a verdict', () => {
    const offenders = sourceFiles().filter((rel) => {
      const code = stripJsComments(read(rel));
      return (
        (rel.endsWith('design/Button.tsx') || rel.endsWith('session/scorecard-read.ts')) &&
        /voice/.test(code)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('marks only the on-a-call stage in the pipeline', () => {
    const page = stripJsComments(read('src/pages/CandidatesPage.tsx'));
    expect(page.match(/^\s*\w+: "voice",$/gm)?.map((line) => line.trim())).toEqual(['screening: "voice",']);
    expect(stripJsComments(read('src/components/talent/RolePipelinePanel.tsx'))).not.toMatch(/voice/);
  });
});

describe('text links: the accent is ink, so hue cannot say "link"', () => {
  it('prints the underline at rest, in the control tone', () => {
    const rule = /\.textlink \{([^}]*)\}/.exec(stripCssComments(indexCss));
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/text-decoration-line: underline/);
    expect(rule![1]).toMatch(/text-decoration-color: var\(--control\)/);
    expect(rule![1]).toMatch(/text-underline-offset: 3px/);
  });

  it('leaves no action link that is underlined only on hover', () => {
    // A name in a list keeps the hover underline, as the mock draws it: its place
    // in the row says what it is. These are the actions.
    const actions = [
      'src/components/talent/CandidateOverviewSections.tsx',
      'src/components/talent/RecordingPlayer.tsx',
      'src/components/talent/RecordingCard.tsx',
      'src/components/talent/TranscriptionSyncWorkspace.tsx',
    ];
    for (const rel of actions) {
      const code = stripJsComments(read(rel));
      expect(code, rel).toContain('textlink');
      expect(code, rel).not.toMatch(/hover:underline/);
    }
  });
});

describe('crimson means a fault on our side', () => {
  it('never colours an AI judgement about a candidate', () => {
    const card = stripJsComments(read('src/components/talent/CandidateScorecard.tsx'));
    expect(card).not.toMatch(/tone="negative"|: 'negative'/);
    const legacy = stripJsComments(read('src/components/Scorecard.tsx'));
    expect(legacy).not.toMatch(/label="Red flags"[^\n]*tone="danger"/);
    expect(legacy).not.toMatch(/high: 'danger'/);
  });
});

describe('an ink fill is a primary action, so a transcript turn never takes one', () => {
  it.each(['src/pages/ScreeningPage.tsx', 'src/components/LiveCallPanel.tsx'])('%s', (rel) => {
    const code = stripJsComments(read(rel));
    expect(code).not.toMatch(/bg-info px-4 py-2\.5|rounded-tr-sm bg-accent-600/);
    expect(code).toMatch(/border border-line-strong bg-surface[^"]*text-ink/);
  });
});

describe('surfaces: opaque, flat, printed', () => {
  it.each(STYLESHEETS)('%s has no blur, gradient, glow or fixed ground', (rel) => {
    const css = stripCssComments(read(rel));
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/\bfilter:\s*blur/);
    expect(css).not.toMatch(/(?:radial|linear|conic)-gradient\(/);
    expect(css).not.toMatch(/position:\s*fixed/);
  });

  it('no source file writes a blur or a gradient utility', () => {
    // Slider.tsx is the one exception: a hard-stop gradient is the only way to
    // paint a WebKit range fill, and it renders as two flat fills.
    const offenders = sourceFiles()
      .filter((rel) => rel !== 'src/components/design/Slider.tsx')
      .filter((rel) =>
        /backdrop-blur|backdrop-filter|bg-gradient|(?:radial|linear|conic)-gradient\(/.test(
          stripJsComments(read(rel)),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('declares the radius family: sheet 8, box and control 4, chip 3, evidence 2', () => {
    expect(indexCss).toMatch(/--radius-sheet:\s*8px;/);
    expect(indexCss).toMatch(/--radius-card:\s*4px;/);
    expect(indexCss).toMatch(/--radius-control:\s*4px;/);
    expect(indexCss).toMatch(/--radius-chip:\s*3px;/);
    expect(indexCss).toMatch(/--radius-evidence:\s*2px;/);
  });

  it('writes no arbitrary radius outside that family', () => {
    const offenders = sourceFiles().filter((rel) => /rounded-\[\d/.test(stripJsComments(read(rel))));
    expect(offenders).toEqual([]);
  });

  it('keeps shadows to floating layers: one shadow token, on the modal material', () => {
    const css = stripCssComments(indexCss);
    expect(css).toMatch(/--shadow-pop:/);
    expect(css).not.toMatch(/--shadow-glass/);
    const shadowed = [...css.matchAll(/([^{}]+)\{[^{}]*box-shadow:\s*var\(--shadow-pop\)[^{}]*\}/g)];
    expect(shadowed.map((m) => m[1].trim())).toEqual(['.glass-modal']);
  });

  it('paints the logo plate on its own white, never a surface token', () => {
    const brand = stripJsComments(read('src/components/navigation/Brand.tsx'));
    expect(brand).toContain('bg-plate');
    expect(brand).not.toMatch(/invert/);
  });
});

describe('motion: nothing enters, reveals or counts up', () => {
  it.each(['src/components/design/Reveal.tsx', 'src/components/design/RollingNumber.tsx'])(
    '%s is gone',
    (rel) => {
      expect(existsSync(resolve(WEB, rel))).toBe(false);
    },
  );

  it('no source file uses a reveal, a count-up or a page rise', () => {
    const offenders = sourceFiles().filter((rel) =>
      /RevealGroup|RevealItem|PageTransition\b(?!Event)|RollingNumber|useCountUp|fade-up|rows-reveal|glass-interactive|ChartReveal|layoutId/.test(
        stripJsComments(read(rel)),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('removes the motion library altogether', () => {
    const offenders = sourceFiles().filter((rel) => /from ['"]motion|lib\/motion/.test(read(rel)));
    expect(offenders).toEqual([]);
    expect(existsSync(resolve(WEB, 'src/lib/motion.ts'))).toBe(false);
    expect(read('package.json')).not.toMatch(/"motion":/);
  });

  it('keeps the overlay motion at its stated durations', () => {
    const css = stripCssComments(indexCss);
    expect(css).toMatch(/\.dialog-panel \{\s*animation: dialog-in 160ms/);
    expect(css).toMatch(/\.slide-over-panel \{\s*animation: slide-over-in 220ms/);
    expect(css).toMatch(/\.combobox-panel \{\s*animation: combobox-in 140ms/);
    expect(css).toMatch(/\.disclosure-body \{\s*animation: combobox-in 180ms/);
  });

  it('keeps press feedback at 0.97 and turns it off under reduced motion', () => {
    const button = read('src/components/design/Button.tsx');
    expect(button).toContain('active:scale-[0.97]');
    expect(button).toContain('motion-reduce:active:scale-100');
  });

  it('honours prefers-reduced-motion for everything that is left', () => {
    const css = stripCssComments(indexCss);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation-duration: 0\.01ms !important/);
    expect(css).toMatch(/transition-duration: 0\.01ms !important/);
  });

  it('never draws a chart in: no entrance animation at any setting', () => {
    const theme = stripJsComments(read('src/components/charts/theme.ts'));
    expect(theme).toMatch(/animation:\s*false/);
    expect(theme).not.toMatch(/animationDuration/);
  });
});

describe('shell and accessibility', () => {
  it('sets a 2px ink focus ring with no radius side effect', () => {
    const css = stripCssComments(indexCss);
    const rule = /:focus-visible \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/outline: 2px solid var\(--ink\)/);
    expect(rule![1]).not.toMatch(/border-radius/);
  });

  it('has a forced-colours rule for every state drawn with a fill or a shadow', () => {
    const css = stripCssComments(indexCss);
    const start = css.indexOf('@media (forced-colors: active)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start);
    for (const selector of [
      '[role=\'switch\']',
      '[aria-current=\'page\']',
      '[aria-current=\'true\']',
      '[aria-pressed=\'true\']',
      '[aria-selected=\'true\']',
      '[role=\'option\'][data-active=\'true\']',
      '[aria-invalid=\'true\']',
      '.glass',
    ]) {
      expect(block, selector).toContain(selector);
    }
    expect(block).toMatch(/Highlight/);
    expect(read('src/components/design/Combobox.tsx')).toContain('data-active=');
  });

  it('leaves a chart, its legend key and every logo plate on their own ground', () => {
    // The colours inside a canvas are not forced, so a dark theme would put carbon
    // ink on black. forced-color-adjust inherits, which keeps a tooltip on paper too.
    const css = stripCssComments(indexCss);
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    const paper = /\.chart-paper,\s*\[data-series-key\] \{([^}]*)\}/.exec(block);
    expect(paper).not.toBeNull();
    expect(paper![1]).toMatch(/forced-color-adjust: none/);
    expect(paper![1]).toMatch(/background-color: var\(--paper\)/);
    expect(block).toMatch(/\.bg-plate \{\s*forced-color-adjust: none/);
    expect(read('src/components/charts/EChart.tsx')).toContain('chart-paper');
    // An SVG keeps its author stroke under forcing too: the arc was 1.2:1 on black.
    expect(read('src/pages/DashboardPage.tsx')).toMatch(/className="chart-paper [^"]*-rotate-90/);
    expect(read('src/components/charts/LineChart.tsx')).toContain('data-series-key');
    expect(stripCssComments(read('src/styles/candidate-experience.css'))).toMatch(
      /@media \(forced-colors: active\) \{[^@]*\.candidate-brand img, \.candidate-aura__logo-plate \{ forced-color-adjust: none; \}/,
    );
  });

  it('gives every filled button a transparent border, the edge forced colours can paint', () => {
    for (const rel of [
      'src/components/roles/AskHelloButton.tsx',
      'src/components/mission-control/MetricAskHello.tsx',
      'src/pages/RolesPage.tsx',
    ]) {
      expect(read(rel), rel).toMatch(/`ask-hello [^`]*border border-transparent/);
    }
    for (const [rel, selector] of [
      ['src/styles/candidate-experience.css', '.candidate-primary-cta'],
      ['src/styles/candidate-r1.css', '.r1-ready__button'],
      ['src/styles/candidate-r1.css', '.r1-captions__jump'],
    ]) {
      const rule = new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(read(rel));
      expect(rule, selector).not.toBeNull();
      expect(rule![1], selector).toContain('border: 1px solid transparent');
    }
  });

  it('hands a selection\'s colours to its children, which keep their own otherwise', () => {
    // `forced-color-adjust: none` has to stay, or forced text gets a Canvas
    // backplate on the fill. It inherits, so without the second rule a selected
    // chip held its name at 1.16:1 on Highlight.
    const css = stripCssComments(indexCss);
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    const selection = /\[aria-current='page'\],[^{]*\{([^}]*)\}/.exec(block);
    expect(selection).not.toBeNull();
    expect(selection![1]).toMatch(/forced-color-adjust: none/);
    expect(selection![1]).toMatch(/color: HighlightText/);
    const children = /\[aria-current='page'\] \*,[^{]*\{([^}]*)\}/.exec(block);
    expect(children).not.toBeNull();
    expect(children![1]).toMatch(/color: HighlightText !important/);
    expect(children![1]).toMatch(/background-color: transparent !important/);
  });

  it('draws focus on a selection itself, because `forced-color-adjust: none` keeps the outline transparent', () => {
    // The rule has to reach all four states, or a focused selection falls back to
    // `focus:outline-none` and a ring shadow in its author colour.
    const css = stripCssComments(indexCss);
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    const focus = /\[aria-current='page'\]:focus-visible,[^{]*\{([^}]*)\}/.exec(block);
    expect(focus).not.toBeNull();
    for (const selector of ['[aria-current=\'true\']', '[aria-pressed=\'true\']', '[aria-selected=\'true\']']) {
      expect(focus![0], selector).toContain(`${selector}:focus-visible`);
    }
    // Tailwind prints `focus:outline-none` after this file at the same specificity.
    expect(focus![1]).toMatch(/outline: 2px solid HighlightText !important/);
    expect(focus![1]).toMatch(/outline-offset: -4px !important/);
    expect(focus![1]).toMatch(/box-shadow: none !important/);
    // This control keeps its own fill, so HighlightText is not sure to show on it.
    const candidate = stripCssComments(read('src/styles/candidate-experience.css'));
    const pressed = /@media \(forced-colors: active\) \{[^@]*\.candidate-interview__controls button\[aria-pressed="true"\]:focus-visible \{([^}]*)\}/.exec(candidate);
    expect(pressed).not.toBeNull();
    expect(pressed![1]).toMatch(/outline: 2px solid CanvasText !important/);
    expect(pressed![1]).toMatch(/outline-offset: 2px !important/);
  });

  it('keeps every data fill and every filled button visible under forced colours', () => {
    const css = stripCssComments(indexCss);
    expect(css.slice(css.indexOf('@media (forced-colors: active)'))).toMatch(/\.data-fill \{/);
    for (const rel of [
      'src/components/talent/PipelineBar.tsx',
      'src/components/charts/BarList.tsx',
      'src/components/design/ProportionBar.tsx',
      'src/components/design/Meter.tsx',
      'src/components/Scorecard.tsx',
    ]) {
      expect(read(rel), rel).toContain('data-fill');
    }
    const button = stripJsComments(read('src/components/design/Button.tsx'));
    for (const fill of ['bg-info', 'bg-error', 'bg-[var(--go)]']) {
      expect(button).toContain(`border border-transparent ${fill}`);
    }
  });
});

describe('type', () => {
  it('imports the width axis, so font-stretch has something to move', () => {
    const main = read('src/main.tsx');
    expect(main).toContain("import '@fontsource-variable/ibm-plex-sans/wdth.css';");
    expect(main).toContain("import '@fontsource-variable/ibm-plex-sans/wdth-italic.css';");
  });

  it('sets 12px form labels at font-stretch 87.5%', () => {
    const css = stripCssComments(indexCss);
    const rule = /\.form-label \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/font-size: 0\.75rem/);
    expect(rule![1]).toMatch(/font-stretch: 87\.5%/);
    expect(read('src/components/design/Field.tsx')).toContain('form-label');
    expect(read('src/components/design/Table.tsx')).toContain('form-label');
  });

  it('keeps every weight to 400, 500 or 600', () => {
    for (const rel of STYLESHEETS) {
      const weights = [...stripCssComments(read(rel)).matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
      expect(weights.filter((w) => ![400, 500, 600].includes(w)), rel).toEqual([]);
    }
    const bold = sourceFiles().filter((rel) => /\bfont-(?:bold|extrabold|black|light|thin)\b/.test(read(rel)));
    expect(bold).toEqual([]);
  });

  it('keeps every written size on the scale: no arbitrary text sizes in source', () => {
    const offenders = sourceFiles().filter((rel) => /\btext-\[\d/.test(stripJsComments(read(rel))));
    expect(offenders).toEqual([]);
  });

  it('allows Plex Mono only where a position in a recording is printed', () => {
    const users = sourceFiles().filter((rel) => /\bfont-mono\b/.test(stripJsComments(read(rel))));
    expect(users).toEqual([
      'src/components/r1-review/OverviewPanel.tsx',
      'src/components/r1-review/PlayerControls.tsx',
      'src/components/r1-review/ReviewNotes.tsx',
      'src/components/r1-review/ReviewTranscript.tsx',
      'src/components/recording/CallStrip.tsx',
      'src/components/talent/SeekableTranscript.tsx',
    ]);
  });

  it('allows no negative tracking below 24px', () => {
    const offenders = sourceFiles().filter((rel) => /tracking-tight|tracking-\[-/.test(stripJsComments(read(rel))));
    expect(offenders).toEqual([]);
  });
});

describe('verdicts stay in ink', () => {
  it.each([
    ['src/components/session/scorecard-read.ts', /reject: \{[^}]*tone: 'neutral'/],
    ['src/pages/DashboardPage.tsx', /reject: 'neutral'/],
    ['src/pages/CandidatesPage.tsx', /reject: "neutral"/],
  ])('%s gives Reject no fault colour', (rel, pattern) => {
    expect(read(rel)).toMatch(pattern);
  });

  it('draws no meter or score in a hue', () => {
    const meter = read('src/components/design/Meter.tsx');
    expect(meter).not.toMatch(/--c-negative|--c-positive|--c-caution/);
    const card = read('src/components/talent/CandidateScorecard.tsx');
    expect(card).not.toMatch(/var\(--c-negative\)|var\(--c-positive\)|var\(--c-caution\)/);
  });
});

describe('dark mode is retired: production has only ever rendered light', () => {
  it.each(['src/lib/theme.tsx', 'src/components/design/ThemeToggle.tsx'])('%s is gone', (rel) => {
    expect(existsSync(resolve(WEB, rel))).toBe(false);
  });

  it('leaves no .dark rule, no dark: utility and no class strategy', () => {
    for (const rel of STYLESHEETS) expect(stripCssComments(read(rel)), rel).not.toMatch(/\.dark\b/);
    expect(sourceFiles().filter((rel) => /\bdark:/.test(stripJsComments(read(rel))))).toEqual([]);
    expect(read('tailwind.config.js')).not.toMatch(/darkMode/);
    expect(read('src/index.css')).toMatch(/color-scheme: light/);
  });
});
