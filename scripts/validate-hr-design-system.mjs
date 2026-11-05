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
 *   surfaces             no blur, gradient or fixed ground; shadows float
 *   radii                sheet 8, box and control 4, chip 3, evidence 2
 *   motion               no reveal, count-up or motion library; overlays kept
 *   shell                skip link, forced-colours rule, 2px ink focus ring
 *   type                 width axis, scale, weights, mono allow-list, no tracking
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
  '/dashboard', '/roles', '/candidates', '/candidates/:id',
  '/sessions/:sessionId', '/screening/:sessionId', '/phone-calendar',
  '/admin', '/admin/r1', '/mission-control', '/ashby-mission-control',
  '/ashby/review/:applicationLinkId', '/mfa/*',
];

/** The only file that may print Plex Mono: a position in a recording. */
export const MONO_ALLOWED = ['src/components/talent/SeekableTranscript.tsx'];
/** A hard-stop gradient is the only way to paint a WebKit range fill. */
export const GRADIENT_ALLOWED = ['src/components/design/Slider.tsx'];

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
  const shadowed = [...plainCss.matchAll(/([^{}]+)\{[^{}]*box-shadow:[^{}]*\}/g)].map((m) => m[1].trim());
  if (shadowed.join() !== '.glass-modal') {
    errors.push(`only the modal material may carry a shadow in index.css, found: ${shadowed.join(', ') || 'none'}`);
  }

  // ── Radii ─────────────────────────────────────────────────────────────
  for (const [name, value] of Object.entries(RADII)) {
    if (!new RegExp(`${name}:\\s*${value};`).test(plainCss)) errors.push(`${name} should be ${value}`);
  }
  const arbitraryRadii = offenders(/rounded-\[\d/);
  if (arbitraryRadii.length) errors.push(`arbitrary radii in ${arbitraryRadii.join(', ')}`);

  // ── Motion ────────────────────────────────────────────────────────────
  const reveals = offenders(
    /RevealGroup|RevealItem|PageTransition\b(?!Event)|RollingNumber|useCountUp|fade-up|rows-reveal|glass-interactive|ChartReveal|layoutId/,
  );
  if (reveals.length) errors.push(`entrance, reveal or count-up motion in ${reveals.join(', ')}`);
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
  }
  const offScale = offenders(/\btext-\[\d/);
  if (offScale.length) errors.push(`arbitrary text sizes in ${offScale.join(', ')}`);
  const heavy = offenders(/\bfont-(?:bold|extrabold|black|light|thin)\b/);
  if (heavy.length) errors.push(`weights off the scale in ${heavy.join(', ')}`);
  const tracked = offenders(/tracking-tight|tracking-\[-/);
  if (tracked.length) errors.push(`negative tracking below 24px in ${tracked.join(', ')}`);
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
