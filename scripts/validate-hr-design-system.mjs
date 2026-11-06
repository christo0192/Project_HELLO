#!/usr/bin/env node
/**
 * The design-system gate: Logsheet (docs/design/hello-glass-design-system.md).
 *
 * Offline and dependency-free. It reads the stylesheets and the web source and
 * refuses anything that would quietly undo the approved system. Each check here
 * is a port of the old gate or a rule the direction added:
 *
 *   palette anchors      every token at its approved value, the go green kept
 *   no alternate dark    no `.dark` rule, no `dark:` utility, no class strategy
 *   routed surfaces      every expected route still present in App.tsx
 *   visual references    any reference file passed on the command line exists
 *
 *   contrast             every declared pair, computed from the tokens
 *   one voice            the orange lives in one pair of tokens, in one file
 *   raw colour           no hex, rgb or hsl outside the tokens; no stock Tailwind hue
 *   verdicts             a verdict and a rating take their family, by the one map:
 *                        never crimson, never the voice, never `moving`
 *   surfaces             no blur, gradient or fixed ground; shadows float, in the
 *                        stylesheets and in source
 *   radii                sheet 8, box and control 4, chip 3, evidence 2, everywhere
 *   motion               no entrance, reveal, count-up or motion library, in any
 *                        stylesheet or in source; overlays kept
 *   shell                skip link, forced-colours rule, 2px ink focus ring
 *   type                 width axis, scale, weights, mono allow-list, no tracking,
 *                        no uppercase, in the stylesheets and in source
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKENS = {
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
  // `--go` / `--go-strong`: the "Resume calling" green, added at the owner's
  // request of 2026-09-29 ("resume button must read as green"). A fill for white
  // text only (5.23:1 / 6.14:1).
  '--go': '#2f7a4f',
  '--go-strong': '#2a6e47',
  // The four status families: the owner's request of 2026-11-06. Validated by the
  // dataviz validator on --paper; docs/design/logsheet-colour-decision-2026-11-06.md.
  '--moving': '#2f8bc3',
  '--moving-light': '#72baeb',
  '--moving-text': '#015e8c',
  '--moving-soft': '#ddf0fe',
  '--ready': '#0a693c',
  '--ready-light': '#349d62',
  '--ready-soft': '#dff3e5',
  '--unresolved': '#958d0f',
  '--unresolved-light': '#b7af47',
  '--unresolved-text': '#6b6620',
  '--unresolved-soft': '#efeed9',
  '--closed': '#5d408a',
  '--closed-light': '#ae96da',
  '--closed-soft': '#efe9fd',
};

/** [foreground, background, minimum]: text 4.5:1, marks and control edges 3:1. */
export const CONTRAST_PAIRS = [
  ['--ink', '--paper', 4.5],
  ['--ink', '--field', 4.5],
  ['--ink', '--desk', 4.5],
  ['--ink', '--wash', 4.5],
  ['--ink-2', '--paper', 4.5],
  ['--ink-2', '--field', 4.5],
  ['--ink-2', '--desk', 4.5],
  ['--ink-2', '--wash', 4.5],
  ['--ink-3', '--paper', 4.5],
  ['--ink-3', '--field', 4.5],
  ['--ink-3', '--desk', 4.5],
  ['--voice', '--paper', 4.5],
  ['--voice', '--field', 4.5],
  ['--paper', '--ink', 4.5],
  ['--danger', '--paper', 4.5],
  ['--paper', '--danger', 4.5],
  ['--control', '--paper', 3],
  ['--control', '--field', 3],
  ['--control', '--desk', 3],
  ['--voice-mark', '--paper', 3],
  ['--voice-mark', '--field', 3],
  ['--ai', '--paper', 3],
  // A family's text shade on every ground it is printed on, and on its own wash.
  ['--moving-text', '--paper', 4.5],
  ['--moving-text', '--field', 4.5],
  ['--moving-text', '--desk', 4.5],
  ['--moving-text', '--moving-soft', 4.5],
  ['--ready', '--paper', 4.5],
  ['--ready', '--field', 4.5],
  ['--ready', '--desk', 4.5],
  ['--ready', '--ready-soft', 4.5],
  ['--unresolved-text', '--paper', 4.5],
  ['--unresolved-text', '--field', 4.5],
  ['--unresolved-text', '--desk', 4.5],
  ['--unresolved-text', '--unresolved-soft', 4.5],
  ['--closed', '--paper', 4.5],
  ['--closed', '--field', 4.5],
  ['--closed', '--desk', 4.5],
  ['--closed', '--closed-soft', 4.5],
  // Paper may sit on these three marks and no other family mark.
  ['--paper', '--moving-text', 4.5],
  ['--paper', '--ready', 4.5],
  ['--paper', '--closed', 4.5],
  // A family's mark on paper: bars, lines and dots.
  ['--moving', '--paper', 3],
  ['--ready', '--paper', 3],
  ['--unresolved', '--paper', 3],
  ['--closed', '--paper', 3],
  // An evidence tag's resting edge is the mark, and it hovers onto the field.
  ['--unresolved', '--field', 3],
  // The verdict block: quiet text on its soft wash.
  ['--ink-2', '--ready-soft', 4.5],
  ['--ink-2', '--unresolved-soft', 4.5],
  ['--ink-2', '--closed-soft', 4.5],
  ['--ink-3', '--ready-soft', 4.5],
  ['--ink-3', '--unresolved-soft', 4.5],
  ['--ink-3', '--closed-soft', 4.5],
  // The ruler prints all three verdicts' words on whichever wash the verdict took.
  ['--unresolved-text', '--ready-soft', 4.5],
  ['--closed', '--ready-soft', 4.5],
  ['--ready', '--unresolved-soft', 4.5],
  ['--closed', '--unresolved-soft', 4.5],
  ['--ready', '--closed-soft', 4.5],
  ['--unresolved-text', '--closed-soft', 4.5],
  // A pressed evidence number: paper on the family's text shade.
  ['--paper', '--unresolved-text', 4.5],
  // The lightest step that clears 3:1 on paper. The other two rely on a printed label.
  ['--ready-light', '--paper', 3],
];

export const RADII = {
  '--radius-sheet': '8px',
  '--radius-card': '4px',
  '--radius-control': '4px',
  '--radius-chip': '3px',
  '--radius-evidence': '2px',
};

export const EXPECTED_ROUTES = [
  '/login', '/candidate/join', '/privacy-notice', '/status', '/appeal',
  '/dashboard', '/roles', '/candidates', '/candidates/:id', '/interviews', '/interviews/:roundId',
  '/sessions/:sessionId', '/screening/:sessionId', '/phone-calendar',
  '/admin', '/admin/r1', '/mission-control', '/ashby-mission-control',
  '/ashby/review/:applicationLinkId', '/mfa/*',
];

/** The only files that may print Plex Mono: a position in a recording. */
export const MONO_ALLOWED = [
  'src/components/talent/SeekableTranscript.tsx',
  'src/components/talent/ReviewScorecard.tsx',
  'src/components/talent/ReviewTape.tsx',
  'src/components/recording/CallStrip.tsx',
  'src/components/recording/ReviewCallStrip.tsx',
  'src/components/r1-review/OverviewPanel.tsx',
  'src/components/r1-review/PlayerControls.tsx',
  'src/components/r1-review/ReviewNotes.tsx',
  'src/components/r1-review/ReviewTranscript.tsx',
];
/** A hard-stop gradient is the only way to paint a WebKit range fill. */
export const GRADIENT_ALLOWED = ['src/components/design/Slider.tsx'];
/** Google's logo is Google's colours; an exported report cannot read the app's tokens. */
export const RAW_COLOUR_ALLOWED = ['src/pages/LoginPage.tsx', 'src/lib/candidate-report/reportStyles.ts'];
/** The floating layers: the only selectors that may carry a shadow, per stylesheet. */
export const SHADOW_ALLOWED = {
  'src/index.css': ['.glass-modal'],
  'src/styles/candidate-r1.css': ['.r1-captions__jump'],
};
/** The floating layers that take `shadow-pop` as a utility: the drawer, the list, the skip link. */
export const SHADOW_POP_ALLOWED = [
  'src/components/Layout.tsx',
  'src/components/design/Combobox.tsx',
  'src/components/navigation/SkipLink.tsx',
];
/** A swatch's zero-blur ring, which needs a value from JS. */
export const INLINE_SHADOW_ALLOWED = ['src/components/talent/PipelineBar.tsx'];
/** The animations that may exist: a loading pulse and the overlays. */
export const KEYFRAMES_ALLOWED = ['skeleton-pulse', 'slide-over-in', 'dialog-in', 'combobox-in'];
/** Where an AI verdict about a candidate is drawn. Each may use a verdict's family and no other colour. */
export const VERDICT_FILES = [
  'src/components/session/ScoreVerdict.tsx',
  'src/components/session/VerdictMark.tsx',
  'src/components/session/scorecard-read.ts',
  'src/components/talent/HeaderScore.tsx',
  'src/components/talent/ReviewScorecard.tsx',
  'src/components/talent/CandidateScorecard.tsx',
  'src/components/Scorecard.tsx',
  'src/components/r1-review/VerdictBlock.tsx',
  'src/components/session/RulerZones.tsx',
  'src/components/session/RoleScorecardView.tsx',
  'src/components/talent/EvidenceHoldNotice.tsx',
  'src/pages/R1InterviewsPage.tsx',
];
/** The same rule, but these print ratings beside a quote, so each may use the highlighter once, on that quote. */
export const VERDICT_FILES_WITH_A_QUOTE = ['src/components/r1-review/OverviewPanel.tsx'];
export const TYPE_SCALE_PX = [12, 13, 14, 16, 20, 24, 30];
export const SKELETON_RADII = [2, 3, 4, 8];
/** Tailwind's stock scales that index.css has no token for. */
const STOCK_HUES = 'orange|yellow|lime|green|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|zinc|neutral|stone';
/** Stock scales tailwind.config.js points at the tokens, so legacy markup re-skins. */
const REPOINTED_SCALES = ['gray: neutralScale', 'emerald: accentScale', 'amber: accentScale', 'red: dangerScale'];

const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJs = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Every shadow utility in `code` that would rest on the page. A zero-blur ring or
 * inset line is a printed edge, not an elevation, and `shadow-none` is nothing.
 */
function restingShadows(code, floating) {
  const printed = /^shadow-\[(?:inset_)?-?[\d.]+(?:px)?_-?[\d.]+(?:px)?_0(?:px)?_[^\]]+\]$/;
  const bare = /['"`][^'"`\n]*(?<![\w-])shadow(?![\w-])[^'"`\n]*['"`]/.test(code) ? ['shadow'] : [];
  return [...bare, ...[...code.matchAll(/(?<![\w-])shadow-[^\s'"`]+/g)].map(([utility]) => utility)]
    .filter((utility) => utility !== 'shadow-none' && !printed.test(utility))
    .filter((utility) => !(floating && utility === 'shadow-pop'));
}

/** A font-size in px, or NaN when it is not a px or rem length. */
function fontPx(value) {
  const hit = /^([\d.]+)(px|rem)$/.exec(value.trim());
  if (!hit) return NaN;
  return hit[2] === 'rem' ? Number(hit[1]) * 16 : Number(hit[1]);
}

/** A token's literal value in the stylesheet, lower-cased, or null. */
function declared(css, name) {
  const hit = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(css);
  return hit ? hit[1].toLowerCase() : null;
}

/**
 * Every problem with a snapshot of the web app.
 *
 * @param {{ css: string, stylesheets: Record<string, string>, app: string,
 *           tailwind: string, main: string, packageJson: string, button: string,
 *           sources: Record<string, string> }} input
 * @returns {string[]}
 */
export function checkDesignSystem({ css, stylesheets, app, tailwind, main, packageJson, button, sources }) {
  const errors = [];
  const plainCss = stripCss(css);
  const code = Object.entries(sources).map(([rel, text]) => [rel, stripJs(text)]);
  const offenders = (pattern, allowed = []) =>
    code.filter(([rel, text]) => pattern.test(text) && !allowed.includes(rel)).map(([rel]) => rel);

  // ── Palette anchors ───────────────────────────────────────────────────
  for (const [name, hex] of Object.entries(TOKENS)) {
    const value = declared(css, name);
    if (value !== hex) errors.push(`palette anchor ${name} should be ${hex}, found ${value ?? 'nothing'}`);
  }

  // ── No alternate dark surface ─────────────────────────────────────────
  for (const [rel, text] of Object.entries(stylesheets)) {
    if (/\.dark\b/.test(stripCss(text))) errors.push(`${rel} defines an alternate dark rule`);
  }
  if (/darkMode/.test(tailwind)) errors.push('tailwind.config.js keeps a dark-mode strategy');
  const darkUsers = offenders(/\bdark:/);
  if (darkUsers.length) errors.push(`dark: utilities in ${darkUsers.join(', ')}`);
  if (!/color-scheme:\s*light/.test(plainCss)) errors.push('index.css no longer pins color-scheme: light');

  // ── Routed surfaces ───────────────────────────────────────────────────
  const missingRoutes = EXPECTED_ROUTES.filter((route) => !app.includes(`path="${route}"`));
  if (missingRoutes.length) errors.push(`expected routed surfaces are missing: ${missingRoutes.join(', ')}`);

  // ── Contrast, computed from the declared tokens ───────────────────────
  for (const [fg, bg, minimum] of CONTRAST_PAIRS) {
    const [a, b] = [declared(css, fg), declared(css, bg)];
    if (!a || !b) continue; // already reported as a palette anchor
    const ratio = Number(contrast(a, b).toFixed(2));
    if (ratio < minimum) errors.push(`${fg} on ${bg} is ${ratio}:1, needs ${minimum}:1`);
  }

  // ── One voice ─────────────────────────────────────────────────────────
  for (const name of ['--voice', '--voice-mark']) {
    const count = (plainCss.match(new RegExp(`${name}:\\s`, 'g')) ?? []).length;
    if (count !== 1) errors.push(`${name} must be declared exactly once, found ${count}`);
  }
  const hue = /#a8460c|#cf5a12/i;
  const restated = [
    ...Object.entries(stylesheets).filter(([rel, text]) => rel !== 'src/index.css' && hue.test(text)).map(([rel]) => rel),
    ...Object.entries(sources).filter(([, text]) => hue.test(text)).map(([rel]) => rel),
  ];
  if (restated.length) errors.push(`the voice hue is restated in ${restated.join(', ')}`);
  if (/voice/.test(stripJs(button))) errors.push('Button.tsx uses the voice hue, which is never a button');

  // ── Raw colour ────────────────────────────────────────────────────────
  const rawInSource = offenders(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/, RAW_COLOUR_ALLOWED);
  if (rawInSource.length) errors.push(`raw colours in ${rawInSource.join(', ')}`);
  for (const [rel, text] of Object.entries(stylesheets)) {
    if (rel !== 'src/index.css' && /#[0-9a-fA-F]{3,8}\b/.test(stripCss(text))) errors.push(`raw colours in ${rel}`);
  }
  const stockHues = offenders(
    new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|caret|placeholder|shadow)-(?:${STOCK_HUES})-\\d`),
  );
  if (stockHues.length) errors.push(`stock hue utilities in ${stockHues.join(', ')}`);
  // Tailwind's colour map has `error`, not `danger`, so these compile to nothing: a
  // fault written with one silently prints in whatever ink it inherits.
  const noSuchColour = offenders(/(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|decoration)-danger(?![\w-])/);
  if (noSuchColour.length) errors.push(`-danger utilities compile to nothing, use -error or -error-text, in ${noSuchColour.join(', ')}`);
  for (const scale of REPOINTED_SCALES) {
    if (!tailwind.includes(scale)) errors.push(`tailwind.config.js no longer re-points the stock scale ${scale.split(':')[0]}`);
  }

  // ── A verdict takes its family, and no other colour ───────────────────
  // Crimson is a fault on our side and orange the candidate's voice, and a verdict is
  // neither. Nothing about one is underway, so `moving` is out too.
  const misused = /\b(?:bg|text|border|ring|fill|stroke|outline|decoration)-(?:error|danger|red-\d|voice|wash|moving)|var\(--(?:danger|error|voice|wash|moving)|tone:\s*'(?:danger|info|moving)'|tone=["{']+(?:danger|info|moving)/;
  const verdicts = [
    ...VERDICT_FILES.filter((rel) => misused.test(stripJs(sources[rel] ?? ''))),
    // Only the first `bg-wash` is forgiven, so a second one still fails.
    ...VERDICT_FILES_WITH_A_QUOTE.filter((rel) => misused.test(stripJs(sources[rel] ?? '').replace(/(?<![\w-])bg-wash(?![\w-])/, ''))),
  ];
  if (verdicts.length) errors.push(`a verdict takes a colour outside its family in ${verdicts.join(', ')}`);
  const tones = stripJs(sources['src/components/design/tones.ts'] ?? '');
  for (const [value, family] of [['advance', 'ready'], ['hold', 'unresolved'], ['reject', 'closed']]) {
    if (!tones.includes(`${value}: '${family}'`)) errors.push(`the verdict ${value} should be the ${family} family`);
  }
  if (!tones.includes("position >= 0.75 ? 'ready' : position >= 0.5 ? 'unresolved' : 'closed'")) {
    errors.push('a rating should be ready from 0.75 of its scale, unresolved from 0.5, closed below');
  }
  for (const rel of [
    'src/components/session/VerdictMark.tsx',
    'src/components/session/ScoreVerdict.tsx',
    'src/components/talent/HeaderScore.tsx',
    'src/components/talent/ReviewScorecard.tsx',
    'src/components/talent/CandidateScorecard.tsx',
  ]) {
    if (!/\bverdictFamily\(/.test(stripJs(sources[rel] ?? ''))) errors.push(`${rel} no longer prints the verdict's family`);
  }
  // A held card has no hue, so the notice that says it is held has none either.
  const heldNotice = stripJs(sources['src/components/talent/EvidenceHoldNotice.tsx'] ?? '');
  if (/\b(?:bg|text|border|ring|fill|stroke|outline|decoration)-(?:ready|unresolved|closed|success|warning)|var\(--(?:ready|unresolved|closed|success|warning)/.test(heldNotice)) {
    errors.push("a held card's notice takes a family in src/components/talent/EvidenceHoldNotice.tsx");
  }

  // ── Surfaces ──────────────────────────────────────────────────────────
  for (const [rel, text] of Object.entries(stylesheets)) {
    const plain = stripCss(text);
    if (/backdrop-filter|\bfilter:\s*blur/.test(plain)) errors.push(`${rel} uses a blur`);
    if (/(?:radial|linear|conic)-gradient\(/.test(plain)) errors.push(`${rel} paints a gradient`);
    if (/position:\s*fixed/.test(plain)) errors.push(`${rel} has a fixed-position ground`);
  }
  const blurred = offenders(/backdrop-blur|backdrop-filter|bg-gradient/);
  if (blurred.length) errors.push(`blur or gradient utilities in ${blurred.join(', ')}`);
  const gradients = offenders(/(?:radial|linear|conic)-gradient\(/, GRADIENT_ALLOWED);
  if (gradients.length) errors.push(`gradients in ${gradients.join(', ')}`);
  for (const [rel, text] of Object.entries(stylesheets)) {
    const shadowed = [...stripCss(text).matchAll(/([^{}]+)\{[^{}]*box-shadow:(?!\s*none)[^{}]*\}/g)].map((m) => m[1].trim());
    const allowed = SHADOW_ALLOWED[rel] ?? [];
    if (shadowed.join() !== allowed.join()) {
      errors.push(`only floating layers may carry a shadow in ${rel}, found: ${shadowed.join(', ') || 'none'}`);
    }
    if (/drop-shadow\(/.test(stripCss(text))) errors.push(`${rel} uses a drop shadow`);
  }
  for (const [rel, text] of code) {
    const resting = restingShadows(text, SHADOW_POP_ALLOWED.includes(rel));
    if (resting.length) errors.push(`resting shadow utilities in ${rel}: ${[...new Set(resting)].join(', ')}`);
  }
  const dropped = offenders(/\bdrop-shadow\b/);
  if (dropped.length) errors.push(`resting shadow utilities in ${dropped.join(', ')}`);
  const inlineShadows = offenders(/\bboxShadow\s*:/, INLINE_SHADOW_ALLOWED);
  if (inlineShadows.length) errors.push(`inline shadows in ${inlineShadows.join(', ')}`);

  // ── Radii ─────────────────────────────────────────────────────────────
  for (const [name, value] of Object.entries(RADII)) {
    if (!new RegExp(`${name}:\\s*${value};`).test(plainCss)) errors.push(`${name} should be ${value}`);
  }
  const arbitraryRadii = offenders(/rounded-\[\d/);
  if (arbitraryRadii.length) errors.push(`arbitrary radii in ${arbitraryRadii.join(', ')}`);
  for (const [rel, text] of Object.entries(stylesheets)) {
    const off = [...stripCss(text).matchAll(/border(?:-[a-z]+)*-radius:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((value) => !/^var\(--radius-(?:sheet|card|control|chip|evidence)\)$/.test(value) && !['50%', '0'].includes(value));
    if (off.length) errors.push(`${rel} has radii off the scale: ${[...new Set(off)].join(', ')}`);
  }
  const roundSkeletons = code
    .filter(([, text]) => [...text.matchAll(/\bradius=\{(\d+)\}/g)].some((m) => !SKELETON_RADII.includes(Number(m[1]))))
    .map(([rel]) => rel);
  if (roundSkeletons.length) errors.push(`radii off the scale in ${roundSkeletons.join(', ')}`);

  // ── Motion ────────────────────────────────────────────────────────────
  const reveals = offenders(
    /RevealGroup|RevealItem|PageTransition\b(?!Event)|RollingNumber|useCountUp|fade-up|rows-reveal|glass-interactive|ChartReveal|layoutId/,
  );
  if (reveals.length) errors.push(`entrance, reveal or count-up motion in ${reveals.join(', ')}`);
  const animated = offenders(/\banimate-(?!spin\b|ping\b|none\b)[a-z]/);
  if (animated.length) errors.push(`entrance motion utilities in ${animated.join(', ')}`);
  for (const [rel, text] of Object.entries(stylesheets)) {
    const plain = stripCss(text);
    const allowed = rel === 'src/index.css' ? KEYFRAMES_ALLOWED : [];
    const off = [
      ...[...plain.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]),
      ...[...plain.matchAll(/\banimation(?:-name)?:\s*([\w-]+)/g)].map((m) => m[1]),
    ].filter((name) => name !== 'none' && !allowed.includes(name));
    if (off.length) errors.push(`${rel} declares entrance motion: ${[...new Set(off)].join(', ')}`);
  }
  const motionUsers = offenders(/from ['"]motion/);
  if (motionUsers.length) errors.push(`the motion library is imported by ${motionUsers.join(', ')}`);
  if (/"motion":/.test(packageJson)) errors.push('package.json still depends on motion');
  for (const [selector, keyframes, duration] of [
    ['dialog-panel', 'dialog-in', '160ms'],
    ['slide-over-panel', 'slide-over-in', '220ms'],
    ['combobox-panel', 'combobox-in', '140ms'],
    ['disclosure-body', 'combobox-in', '180ms'],
  ]) {
    if (!new RegExp(`\\.${selector} \\{\\s*animation: ${keyframes} ${duration}`).test(plainCss)) {
      errors.push(`overlay motion .${selector} should stay ${duration}`);
    }
  }
  if (!button.includes('active:scale-[0.97]')) errors.push('press feedback should stay at 0.97');
  if (!button.includes('motion-reduce:active:scale-100')) errors.push('press feedback ignores reduced motion');
  if (!/@media \(prefers-reduced-motion: reduce\)/.test(plainCss)) errors.push('index.css lost the reduced-motion rule');
  const chartTheme = stripJs(sources['src/components/charts/theme.ts'] ?? '');
  if (!/animation:\s*false/.test(chartTheme)) errors.push('charts must not animate in');

  // ── Shell ─────────────────────────────────────────────────────────────
  const focus = /:focus-visible \{([^}]*)\}/.exec(plainCss);
  if (!focus || !/outline: 2px solid var\(--ink\)/.test(focus[1])) errors.push('the focus ring should be 2px ink');
  if (!plainCss.includes('@media (forced-colors: active)')) errors.push('index.css lost the forced-colours rule');
  if (!(sources['src/components/navigation/SkipLink.tsx'] ?? '').includes('#main-content')) {
    errors.push('the skip link lost its target');
  }
  const brand = stripJs(sources['src/components/navigation/Brand.tsx'] ?? '');
  if (!brand.includes('bg-plate') || /invert/.test(brand)) errors.push('the IK logo must sit on its own white plate');

  // ── Type ──────────────────────────────────────────────────────────────
  if (!main.includes("'@fontsource-variable/ibm-plex-sans/wdth.css'")) errors.push('main.tsx must import the width axis');
  if (/fonts\.(?:googleapis|gstatic)\.com/.test(main + css)) errors.push('fonts must stay self-hosted (CSP font-src self)');
  if (!/\.form-label \{[^}]*font-stretch: 87\.5%/.test(plainCss)) errors.push('.form-label should be set at 87.5% width');
  for (const [rel, text] of Object.entries(stylesheets)) {
    const plain = stripCss(text);
    const weights = [...plain.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
    const offWeights = weights.filter((weight) => ![400, 500, 600].includes(weight));
    if (offWeights.length) errors.push(`${rel} uses weights ${[...new Set(offWeights)].join(', ')}`);
    if (/text-transform:\s*uppercase/.test(plain)) errors.push(`${rel} uppercases text`);
    const offSizes = [...plain.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((value) => value !== 'inherit' && !TYPE_SCALE_PX.includes(fontPx(value)));
    if (offSizes.length) errors.push(`${rel} has sizes off the type scale: ${[...new Set(offSizes)].join(', ')}`);
  }
  const offScale = offenders(/\btext-\[\d/);
  if (offScale.length) errors.push(`arbitrary text sizes in ${offScale.join(', ')}`);
  const oversized = code
    .filter(
      ([, text]) =>
        /\btext-[4-9]xl\b/.test(text) ||
        [...text.matchAll(/\bfontSize:\s*(\d+)/g)].some((m) => !TYPE_SCALE_PX.includes(Number(m[1]))),
    )
    .map(([rel]) => rel);
  if (oversized.length) errors.push(`sizes off the type scale in ${oversized.join(', ')}`);
  const heavy = offenders(/\bfont-(?:bold|extrabold|black|light|thin)\b/);
  if (heavy.length) errors.push(`weights off the scale in ${heavy.join(', ')}`);
  const tracked = offenders(/tracking-tight|tracking-\[-/);
  if (tracked.length) errors.push(`negative tracking below 24px in ${tracked.join(', ')}`);
  const open = offenders(/\btracking-(?:wide|wider|widest|\[\.|\[\d)/);
  if (open.length) errors.push(`open tracking in ${open.join(', ')}`);
  const shouting = offenders(/(?<![\w-])uppercase(?![\w-])/);
  if (shouting.length) errors.push(`uppercase utilities in ${shouting.join(', ')}`);
  const mono = offenders(/\bfont-mono\b/, MONO_ALLOWED);
  if (mono.length) errors.push(`Plex Mono outside a recording position in ${mono.join(', ')}`);

  return errors;
}

/** Read the snapshot `checkDesignSystem` needs from a repository checkout. */
export function readSnapshot(root) {
  const web = resolve(root, 'app/web');
  const text = (rel) => readFileSync(resolve(web, rel), 'utf8').replace(/\r\n/g, '\n');
  const stylesheets = Object.fromEntries(
    [
      'src/index.css',
      'src/styles/candidate-palette.css',
      'src/styles/candidate-experience.css',
      'src/styles/candidate-r1.css',
    ].map((rel) => [rel, text(rel)]),
  );
  const sources = Object.fromEntries(
    readdirSync(resolve(web, 'src'), { recursive: true, encoding: 'utf8' })
      .map((rel) => `src/${rel.replace(/\\/g, '/')}`)
      .filter((rel) => /\.(ts|tsx)$/.test(rel))
      .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel))
      .map((rel) => [rel, text(rel)]),
  );
  return {
    css: stylesheets['src/index.css'],
    stylesheets,
    app: text('src/App.tsx'),
    tailwind: text('tailwind.config.js'),
    main: text('src/main.tsx'),
    packageJson: text('package.json'),
    button: text('src/components/design/Button.tsx'),
    sources,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const errors = checkDesignSystem(readSnapshot(root));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }

  const refs = process.argv.slice(2);
  const absentRefs = refs.filter((path) => !existsSync(resolve(path)));
  if (absentRefs.length) {
    console.error(`visual reference files not found: ${absentRefs.join(', ')}`);
    process.exit(1);
  }

  console.log(
    `Logsheet design validation passed: ${Object.keys(TOKENS).length} palette anchors, ` +
      `${CONTRAST_PAIRS.length} contrast pairs, ${EXPECTED_ROUTES.length} routed surfaces`,
  );
  if (refs.length) console.log(`visual references present: ${refs.length}`);
}
