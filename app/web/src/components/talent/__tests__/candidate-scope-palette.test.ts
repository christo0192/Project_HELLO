/**
 * The palette guard.
 *
 * Four independent layers, each with its own negative control, so a
 * regression has to defeat all four to ship:
 *
 *   1. Every `--c-*` name is pinned to its Logsheet token, and the file
 *      holds no colour of its own, so the palette has one source and a dark
 *      "variant" cannot appear here.
 *   2. A mechanical source scan: no stock Tailwind palette utility, no
 *      IK brand/accent utility, no raw colour literal and no `dark:`
 *      variant may appear anywhere in candidate-scoped source. The file
 *      list is explicit and asserted non-empty and existent, so a bad
 *      glob fails loudly instead of passing vacuously.
 *   3. Every out-of-scope palette utility that reaches the subtree
 *      through an embedded frozen component is re-derived from those
 *      components' source and asserted covered by the compatibility
 *      block — the block cannot silently fall behind.
 *   4. WCAG 2.1 contrast arithmetic over the pairs the design actually
 *      uses, computed from the token file itself.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const PALETTE = resolve(ROOT, 'src/styles/candidate-palette.css');

/** Every source file that renders inside `.candidate-scope`. */
const CANDIDATE_SCOPE_SOURCES = [
  'src/pages/CandidatesPage.tsx',
  'src/pages/CandidateDetailPage.tsx',
  'src/pages/R1InterviewsPage.tsx',
  'src/pages/AshbyScopedReviewPage.tsx',
  'src/components/talent/CandidateShell.tsx',
  'src/components/talent/ResumeReviewBadge.tsx',
  'src/components/talent/CandidateScorecard.tsx',
  'src/components/talent/CandidateOverviewSections.tsx',
  // Renders inside `.candidate-scope` via `CandidateHeader`'s `meta` slot, so
  // it is subject to the same palette rules. The list is hand-written rather
  // than discovered, which means a new file on the candidate surface sits
  // OUTSIDE this guard until someone remembers — a reviewer caught exactly
  // that for this one.
  'src/components/talent/CandidateHeadlineFacts.tsx',
  'src/components/talent/AshbyWorkflowCard.tsx',
  'src/components/talent/TranscriptionSyncWorkspace.tsx',
  // C3 (0114): the evidence-hold banner renders inside the Review tab.
  'src/components/talent/EvidenceHoldNotice.tsx',
  'src/components/talent/Tabs.tsx',
  'src/components/talent/RecordingPlayer.tsx',
  'src/components/talent/SeekableTranscript.tsx',
  // R1 (PR-7): the Send R1 card and rounds panel render inside the Candidate
  // Detail Overview, so they are candidate-scoped like everything above.
  'src/components/r1/R1Section.tsx',
  'src/components/r1/SendR1Controls.tsx',
  'src/components/r1/R1RoundsPanel.tsx',
  'src/components/r1/IssuedLink.tsx',
  // R1-REC: the recording player keeps to the same tokens, with no motion import.
  'src/components/r1/R1RecordingPlayer.tsx',
  // M013 S02: each call leg of a phone session on the Review tab.
  'src/components/talent/SessionLegRow.tsx',
  // M026: the Logsheet Review workspace.
  'src/components/talent/ReviewScorecard.tsx',
  'src/components/talent/ReviewTape.tsx',
  'src/components/talent/EvidenceMark.tsx',
  'src/components/recording/ReviewCallStrip.tsx',
  'src/components/session/VerdictMark.tsx',
  'src/components/design/SurfaceCard.tsx',
  'src/components/design/Meter.tsx',
  'src/components/design/Tag.tsx',
  'src/components/design/CandidateControls.tsx',
  'src/components/design/candidate.ts',
];

/**
 * Frozen, out-of-scope components that are nevertheless mounted inside the
 * Candidate Detail Overview. Their utilities must be covered by the
 * compatibility block in the palette file.
 */
const EMBEDDED_FROZEN_SOURCES = [
  'src/components/LiveCallPanel.tsx',
  'src/components/LiveKitCallCard.tsx',
  'src/components/ui.tsx',
];

const STOCK_PALETTES =
  'gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
const UTILITY_PREFIXES =
  'bg|text|border|ring|divide|from|via|to|outline|decoration|shadow|fill|stroke|placeholder|caret';

const FORBIDDEN = {
  'stock Tailwind palette utility': new RegExp(
    `\\b(?:${UTILITY_PREFIXES})-(?:${STOCK_PALETTES})(?:-\\d{2,3})?(?:\\/\\d{1,3})?\\b`,
  ),
  'IK brand/accent utility': new RegExp(
    `\\b(?:${UTILITY_PREFIXES})-(?:brand|accent)-\\d{2,3}(?:\\/\\d{1,3})?\\b`,
  ),
  'raw colour literal': /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/,
  'dark: variant': /\bdark:/,
  'motion library import': /from\s+['"]motion/,
};

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

/** Declarations of a top-level rule whose selector is exactly `selector`. */
function ruleDeclarations(rawCss: string, selector: string): Record<string, string> {
  const css = rawCss.replace(/\r\n/g, '\n');
  const start = css.indexOf(`\n${selector} {\n`);
  expect(start, `rule "${selector}" not found`).toBeGreaterThan(-1);
  const bodyStart = css.indexOf('{', start) + 1;
  const bodyEnd = css.indexOf('\n}', bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  const out: Record<string, string> = {};
  for (const line of css.slice(bodyStart, bodyEnd).split('\n')) {
    const m = /^\s*([\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * The mapping onto Logsheet. These pairs are the contract: if the file drifts
 * from them, this test is the thing that says so. The hex values themselves
 * live once, in src/index.css, and are pinned by logsheet-tokens.test.ts.
 */
const TOKEN_MAP: Record<string, string> = {
  '--c-bg': 'var(--desk)',
  '--c-surface': 'var(--paper)',
  '--c-border': 'var(--rule-2)',
  '--c-border-light': 'var(--field)',
  '--c-ink': 'var(--ink)',
  '--c-ink-secondary': 'var(--ink-2)',
  '--c-ink-muted': 'var(--ink-3)',
  '--c-accent': 'var(--ink)',
  '--c-accent-light': 'var(--field)',
  '--c-positive': 'var(--ink-2)',
  '--c-positive-light': 'var(--field)',
  '--c-negative': 'var(--danger)',
  '--c-negative-light': 'var(--paper)',
  '--c-caution': 'var(--ink-2)',
  '--c-caution-light': 'var(--field)',
  '--c-data-label-inside': 'var(--paper)',
  '--c-control-border': 'var(--control)',
};

const paletteCss = readFileSync(PALETTE, 'utf8');
const lightRule = ruleDeclarations(paletteCss, '.candidate-scope');
const rootRule = (() => {
  const css = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');
  const body = /:root \{\n([\s\S]*?)\n {2}\}/.exec(css);
  expect(body, ':root block not found').not.toBeNull();
  const out: Record<string, string> = {};
  for (const m of body![1].matchAll(/^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/gm)) out[m[1]] = m[2];
  return out;
})();

/* ── 1. Exact literals, and no dark variant ───────────────────────── */

describe('candidate palette tokens', () => {
  it('maps every name onto its Logsheet token exactly', () => {
    for (const [name, value] of Object.entries(TOKEN_MAP)) {
      expect(lightRule[name], `${name} drifted`).toBe(value);
    }
  });

  it('holds no colour of its own: every value is a token', () => {
    expect(paletteCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });

  it('defines no dark variant', () => {
    expect(paletteCss).not.toMatch(/^\s*\.dark\b/m);
  });

  it('forces a light colour-scheme so native controls do not go dark', () => {
    expect(lightRule['color-scheme']).toBe('light');
  });

  it('leaves the app-wide semantic names alone: they are already Logsheet', () => {
    for (const name of ['--surface', '--ink', '--ink-secondary', '--ink-tertiary', '--line', '--info']) {
      expect(lightRule[name], `${name} is re-pointed`).toBeUndefined();
    }
  });
});

/* ── 2. Mechanical source guard, with a non-vacuous negative fixture ─ */

describe('candidate-scope source guard', () => {
  it('has a non-empty file list and every file exists', () => {
    expect(CANDIDATE_SCOPE_SOURCES.length).toBeGreaterThanOrEqual(15);
    for (const rel of CANDIDATE_SCOPE_SOURCES) {
      expect(existsSync(resolve(ROOT, rel)), `${rel} is missing`).toBe(true);
    }
    expect(existsSync(PALETTE)).toBe(true);
  });

  it.each(CANDIDATE_SCOPE_SOURCES)('%s uses no forbidden colour source', (rel) => {
    const source = read(rel);
    expect(source.length).toBeGreaterThan(0);
    for (const [what, pattern] of Object.entries(FORBIDDEN)) {
      const hit = pattern.exec(source);
      expect(hit?.[0] ?? null, `${rel} contains a ${what}`).toBeNull();
    }
  });

  it('NEGATIVE CONTROL: the guard actually matches known-bad source', () => {
    const bad = [
      'className="bg-gray-100 text-emerald-700"',
      'className="text-brand-700 dark:text-brand-300"',
      'const c = "#ff0000"; const d = rgba(0,0,0,.5);',
      "import { motion } from 'motion/react';",
    ].join('\n');
    const matched = Object.entries(FORBIDDEN)
      .filter(([, pattern]) => pattern.test(bad))
      .map(([what]) => what);
    expect(matched.sort()).toEqual(
      [
        'IK brand/accent utility',
        'dark: variant',
        'motion library import',
        'raw colour literal',
        'stock Tailwind palette utility',
      ].sort(),
    );
  });

  /**
   * The semantic tone colours may fill, ring and border. They may NOT be text.
   *
   * Tone is carried by tint, ring and border; the label is always ink. A tone
   * written as a text colour is how a status starts reading as a traffic light,
   * so neither is a text colour anywhere in candidate scope.
   *
   * SCOPE: this reads `text-[var(--c-…)]` utilities only. A colour applied
   * through an inline `style` — the 36px overall score is the one such site —
   * is invisible here and is covered by the pair list above instead. Both
   * halves are needed; neither is sufficient alone.
   *
   * This is the guard that would have caught `CandidateErrorState`, which
   * painted its message in the negative tone on the negative tint
   * while `Tag` — one file away, under the same written rule — did not. The
   * arithmetic list above cannot catch it on its own, because the tokens it
   * pins are the ones the design INTENDS to pair; a component is free to pair
   * two others. Only reading the source closes that gap.
   */
  const TONE_TOKENS_BANNED_AS_TEXT = ['--c-negative', '--c-positive'] as const;

  /**
   * Assembled by concatenation, never written out as one literal.
   *
   * `tailwind.config.js` scans every `.ts`/`.tsx` under `src` — test files and
   * COMMENTS included — and generates a rule for any complete arbitrary-value
   * class candidate it finds. Interpolating the token name into that form
   * produced a class whose declaration contained the un-substituted
   * placeholder, which is not valid CSS, and lightningcss failed the
   * production build on it. Building the needle from parts means the scanner
   * never sees a candidate. For the same reason this comment describes the
   * shape in prose rather than spelling it out.
   */
  const textUtilityFor = (tokenName: string) => 'text-[var(' + tokenName + ')]';

  it.each(TONE_TOKENS_BANNED_AS_TEXT)('%s is never used as a text colour', (tokenName) => {
    const needle = textUtilityFor(tokenName);
    const offenders = CANDIDATE_SCOPE_SOURCES.filter((rel) => read(rel).includes(needle));
    expect(offenders).toEqual([]);
  });

  it('NEGATIVE CONTROL: that ban matches the exact string it forbids', () => {
    const needle = textUtilityFor('--c-negative');
    const bad = '<p className="text-sm ' + needle + '">boom</p>';
    expect(bad.includes(needle)).toBe(true);
    // …and the needle really is the utility form, not a near-miss.
    expect(needle).toBe(['text-[var(', '--c-negative', ')]'].join(''));
  });

  it('candidate-scoped source consumes the palette through --c-* tokens', () => {
    const consumers = CANDIDATE_SCOPE_SOURCES.filter((f) => f.endsWith('.tsx'));
    const using = consumers.filter((rel) => /var\(--c-[\w-]+\)/.test(read(rel)));
    expect(using.length).toBeGreaterThanOrEqual(10);
  });
});

/* ── 3. The embedded-frozen-component compatibility block ─────────── */

describe('embedded out-of-scope compatibility block', () => {
  const utilityPattern = new RegExp(
    `(?:hover:|focus:|focus-visible:|disabled:|placeholder:)?\\b(?:${UTILITY_PREFIXES})-(?:${STOCK_PALETTES}|brand|accent)(?:-\\d{2,3})?(?:\\/\\d{1,3})?\\b`,
    'g',
  );

  it('covers every palette utility the frozen embedded components use', () => {
    const used = new Set<string>();
    for (const rel of EMBEDDED_FROZEN_SOURCES) {
      for (const hit of read(rel).matchAll(utilityPattern)) used.add(hit[0]);
    }
    expect(used.size).toBeGreaterThan(10);

    const uncovered = [...used].filter((utility) => {
      // Tailwind escapes `:` and `/` in generated class names.
      const escaped = utility.replace(/:/g, '\\:').replace(/\//g, '\\/');
      return !paletteCss.includes(`.candidate-scope .${escaped}`);
    });
    expect(uncovered.sort()).toEqual([]);
  });
});

/* ── 4. WCAG 2.1 contrast, computed from the token file ───────────── */

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a `--c-*` name to the hex its Logsheet token declares. */
function token(name: string): string {
  const raw = lightRule[name];
  expect(raw, `${name} is not declared`).toBeTruthy();
  const alias = /^var\((--[\w-]+)\)$/.exec(raw);
  expect(alias, `${name} should be a token`).not.toBeNull();
  const hex = rootRule[alias![1]];
  expect(hex, `${alias![1]} is not a hex in index.css`).toBeTruthy();
  return hex;
}

/** [foreground, background, minimum ratio, what it is]. */
const CONTRAST_PAIRS: Array<[string, string, number, string]> = [
  // Body text, 4.5:1 (WCAG 1.4.3).
  ['--c-ink', '--c-surface', 4.5, 'primary text on a card'],
  ['--c-ink', '--c-bg', 4.5, 'primary text on the desk'],
  ['--c-ink', '--c-border-light', 4.5, 'primary text in a shaded field'],
  ['--c-ink-secondary', '--c-surface', 4.5, 'secondary text on a card'],
  ['--c-ink-secondary', '--c-bg', 4.5, 'secondary text on the desk'],
  ['--c-ink-secondary', '--c-border-light', 4.5, 'secondary text in a shaded field'],
  ['--c-ink-secondary', '--c-border', 4.5, 'label on a disabled candidate button'],
  ['--c-ink-muted', '--c-surface', 4.5, 'muted text on a card'],
  ['--c-ink-muted', '--c-bg', 4.5, 'muted text on the desk'],
  ['--c-ink-muted', '--c-border-light', 4.5, 'muted text in a shaded field'],
  ['--c-accent', '--c-surface', 4.5, 'links on a card'],
  ['--c-accent', '--c-bg', 4.5, 'links on the desk'],
  ['--c-data-label-inside', '--c-accent', 4.5, 'label on a primary button'],
  ['--c-data-label-inside', '--c-negative', 4.5, 'label on a filled fault'],
  ['--c-caution', '--c-caution-light', 4.5, 'caution badge text'],
  ['--c-negative', '--c-negative-light', 4.5, 'fault text on its ground'],
  ['--c-negative', '--c-surface', 4.5, 'fault text on a card'],
  // Non-text UI, 3:1 (WCAG 1.4.11).
  ['--c-negative', '--c-bg', 3, 'error-state border vs the desk'],
  ['--c-ink', '--c-border-light', 3, 'strong meter fill vs its track'],
  ['--c-ink-secondary', '--c-border-light', 3, 'fair meter fill vs its track'],
  ['--c-ink-muted', '--c-border-light', 3, 'low meter fill vs its track'],
  ['--c-control-border', '--c-border-light', 3, 'pipeline fill vs its track'],
  ['--c-control-border', '--c-surface', 3, 'input/select/button boundary'],
  ['--c-control-border', '--c-bg', 3, 'control boundary on the desk'],
  ['--c-accent', '--c-surface', 3, 'focus ring vs the card'],
];

/**
 * A pairing this design DELIBERATELY does not use, with the sub-threshold
 * number that is the reason. A rule kept only in a comment is a rule that gets
 * broken; asserting the rejected number keeps the ban checkable.
 */
const REJECTED_TEXT_PAIRS: Array<[string, string, string]> = [
  ['--c-border', '--c-surface', 'the hairline as a control boundary'],
  ['--c-control-border', '--c-surface', 'the control edge as small text'],
];

describe('candidate palette contrast (WCAG 2.1)', () => {
  it.each(CONTRAST_PAIRS)(
    '%s on %s clears %s:1 (%s)',
    (fg, bg, minimum) => {
      const ratio = contrastRatio(token(fg), token(bg));
      expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(minimum);
    },
  );

  it.each(REJECTED_TEXT_PAIRS)(
    'REJECTED: %s on %s is below AA for normal text (%s)',
    (fg, bg) => {
      // If one ever clears 4.5 the palette changed underneath us.
      expect(contrastRatio(token(fg), token(bg))).toBeLessThan(4.5);
    },
  );

  it('NEGATIVE CONTROL: a deliberately weak pair fails the same assertion', () => {
    const ratio = contrastRatio('#777777', '#888888');
    expect(ratio).toBeLessThan(4.5);
    expect(ratio).toBeLessThan(3);
  });

  it('NEGATIVE CONTROL: the maths matches the published reference values', () => {
    // WCAG's own worked examples: black on white is exactly 21:1, and a
    // colour against itself is exactly 1:1.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#4E6BA6', '#4E6BA6')).toBeCloseTo(1, 5);
  });
});

/* ── 5. The frozen shared primitives stay independent ─────────────── */

describe('frozen shared files', () => {
  const FROZEN = [
    'src/components/Scorecard.tsx',
    'src/components/ui.tsx',
    'tailwind.config.js',
  ];

  it('exists and knows nothing about the candidate scope', () => {
    for (const rel of FROZEN) {
      expect(existsSync(resolve(ROOT, rel)), `${rel} is missing`).toBe(true);
      const source = read(rel);
      expect(source).not.toMatch(/candidate-scope/);
      expect(source).not.toMatch(/--c-[\w-]+/);
      expect(source).not.toMatch(/SurfaceCard|CandidateScorecard|\bMeter\b/);
    }
  });

  it('is not imported by any candidate-scoped component', () => {
    for (const rel of CANDIDATE_SCOPE_SOURCES) {
      const source = read(rel);
      expect(source, `${rel} still imports the frozen ui primitives`).not.toMatch(
        /from\s+['"][./]*(?:components\/)?ui['"]/,
      );
      expect(source, `${rel} still renders the legacy Scorecard`).not.toMatch(
        /from\s+['"][./]*(?:components\/)?Scorecard['"]/,
      );
    }
  });

  it('the app-wide token file imports the palette and nothing else', () => {
    const indexCss = read('src/index.css');
    const imports = indexCss.match(/^@import .+$/gm) ?? [];
    expect(imports).toEqual(["@import './styles/candidate-palette.css';"]);
  });
});

/* ── 6. Motion budget ─────────────────────────────────────────────── */

describe('motion budget', () => {
  it('animates nothing in candidate scope but the loading spinner', () => {
    const animated: string[] = [];
    for (const rel of CANDIDATE_SCOPE_SOURCES) {
      for (const hit of read(rel).matchAll(/\banimate-[\w-]+/g)) {
        animated.push(`${rel}:${hit[0]}`);
      }
    }
    expect(animated).toEqual([
      'src/components/talent/RecordingPlayer.tsx:animate-spin',
      'src/components/design/CandidateControls.tsx:animate-spin',
    ]);
  });

  it('inherits the global reduced-motion collapse', () => {
    const indexCss = read('src/index.css');
    expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(indexCss).toMatch(/animation-duration: 0\.01ms !important/);
    expect(indexCss).toMatch(/transition-duration: 0\.01ms !important/);
  });

  it('adds no keyframes or transition of its own to the palette file', () => {
    expect(paletteCss).not.toMatch(/@keyframes|animation:|transition:/);
  });
});

/* ── 7. Why this arithmetic is the ONLY contrast guard ────────────── */

describe('axe cannot check contrast under jsdom', () => {
  /**
   * This is not a disclaimer, it is a pinned fact.
   *
   * axe-core's `color-contrast` rule needs a canvas to resolve computed
   * colours, so under jsdom it aborts and reports the node as INCOMPLETE
   * rather than as a violation. `toHaveNoViolations` asserts only on
   * `violations`, which means every axe suite in this repo is structurally
   * incapable of failing on contrast — a genuinely failing pair sails
   * through all four of them. That is exactly how `CandidateErrorState`
   * shipped a 3.94:1 pairing past four green axe suites.
   *
   * So the pair list above is not a convenience, it is the whole guard, and
   * it must enumerate every pair the components actually render.
   *
   * Asserting the limitation keeps it honest in both directions: if axe ever
   * gains this capability under jsdom, THIS test fails and tells us the
   * arithmetic list is no longer the only line of defence.
   */
  it('reports a genuinely failing pair as incomplete, never as a violation', async () => {
    const { default: axe } = await import('axe-core');
    document.body.innerHTML =
      '<div style="background-color:#f7edf0">' +
      '<p style="color:#b45a72;font-size:14px">rose on its own tint</p>' +
      '</div>';
    const result = await axe.run(document.body, { runOnly: ['color-contrast'] });
    document.body.innerHTML = '';

    // The pair really is below AA.
    expect(contrastRatio('#b45a72', '#f7edf0')).toBeLessThan(4.5);
    // …and axe still finds nothing to fail on.
    expect(result.violations).toHaveLength(0);
    expect(result.incomplete.length).toBeGreaterThan(0);
  });
});
