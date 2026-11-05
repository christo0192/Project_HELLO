#!/usr/bin/env node
/**
 * Negative controls for the design gate: a gate that passes on the real tree
 * proves nothing unless it also fails on a tree with the fault in it. Each case
 * seeds one regression into a snapshot of this checkout and asserts the gate
 * names it. Run from the repository root.
 */
import assert from 'node:assert/strict';
import { checkDesignSystem, contrast, readSnapshot } from './validate-hr-design-system.mjs';

const clean = readSnapshot(process.cwd());
assert.deepEqual(checkDesignSystem(clean), [], 'the checkout itself must pass');

/** A copy of the snapshot with `file` run through `change`. */
function seeded(file, change) {
  const next = { ...clean, stylesheets: { ...clean.stylesheets }, sources: { ...clean.sources } };
  if (file === 'css') {
    next.css = change(next.css);
    next.stylesheets['src/index.css'] = next.css;
  } else if (file in next.stylesheets) {
    next.stylesheets[file] = change(next.stylesheets[file]);
  } else if (file in next.sources) {
    next.sources[file] = change(next.sources[file]);
  } else {
    next[file] = change(next[file]);
  }
  return next;
}

const LAYOUT = 'src/components/Layout.tsx';
const CASES = [
  ['a palette token drifts', 'css', (s) => s.replace('--paper: #fbfaf6', '--paper: #ffffff'), /--paper should be/],
  ['the go green disappears', 'css', (s) => s.replace('--go: #2f7a4f;', ''), /--go should be/],
  ['a .dark block returns', 'css', (s) => `${s}\n.dark { --paper: #000000; }`, /alternate dark rule/],
  ['a dark: utility appears', LAYOUT, (s) => `${s}\nconst x = 'dark:bg-ink';`, /dark: utilities/],
  ['the class strategy returns', 'tailwind', (s) => `${s}\n// darkMode: 'class'`, /dark-mode strategy/],
  ['a route goes missing', 'app', (s) => s.replace('path="/phone-calendar"', 'path="/calendar"'), /routed surfaces are missing/],
  ['a pair drops below its bar', 'css', (s) => s.replace('--ink-3: #66615a', '--ink-3: #a09a90'), /--ink-3 on --paper/],
  ['the voice is declared twice', 'css', (s) => `${s}\n:root {\n  --voice: #a8460c;\n}`, /--voice must be declared exactly once/],
  ['the voice hue is restated', 'src/styles/candidate-r1.css', (s) => `${s}\n.x { color: #a8460c; }`, /voice hue is restated/],
  ['a button goes orange', 'button', (s) => `${s}\nconst y = 'bg-voice-mark';`, /never a button/],
  ['blur comes back', 'css', (s) => `${s}\n.x { backdrop-filter: blur(4px); }`, /uses a blur/],
  ['a ground wash comes back', 'src/styles/candidate-experience.css', (s) => `${s}\n.x { background: linear-gradient(red, blue); }`, /paints a gradient/],
  ['a fixed ground comes back', 'css', (s) => `${s}\n.x { position: fixed; }`, /fixed-position ground/],
  ['a blur utility comes back', LAYOUT, (s) => `${s}\nconst z = 'backdrop-blur-sm';`, /blur or gradient utilities/],
  ['a resting shadow comes back', 'css', (s) => `${s}\n.glass { box-shadow: 0 1px 2px red; }`, /only the modal material/],
  ['a radius drifts', 'css', (s) => s.replace('--radius-card: 4px', '--radius-card: 20px'), /--radius-card should be 4px/],
  ['an arbitrary radius appears', LAYOUT, (s) => `${s}\nconst r = 'rounded-[14px]';`, /arbitrary radii/],
  ['a reveal comes back', LAYOUT, (s) => `${s}\nconst f = 'fade-up-stagger';`, /entrance, reveal or count-up/],
  ['motion is imported again', LAYOUT, (s) => `${s}\nimport { motion } from 'motion/react';`, /motion library is imported/],
  ['motion is depended on again', 'packageJson', (s) => s.replace('"echarts":', '"motion": "^12.0.0",\n    "echarts":'), /depends on motion/],
  ['overlay motion changes', 'css', (s) => s.replace('dialog-in 160ms', 'dialog-in 400ms'), /dialog-panel should stay 160ms/],
  ['press feedback changes', 'button', (s) => s.replace('active:scale-[0.97]', 'active:scale-95'), /stay at 0.97/],
  ['reduced motion stops being honoured', 'button', (s) => s.replace('motion-reduce:active:scale-100', ''), /ignores reduced motion/],
  ['a chart animates in', 'src/components/charts/theme.ts', (s) => s.replace('animation: false', 'animation: true'), /must not animate in/],
  ['the focus ring thins', 'css', (s) => s.replace('outline: 2px solid var(--ink)', 'outline: 1px solid var(--ink)'), /2px ink/],
  ['the forced-colours rule goes', 'css', (s) => s.replace('@media (forced-colors: active)', '@media print'), /forced-colours rule/],
  ['the logo is inverted', 'src/components/navigation/Brand.tsx', (s) => s.replaceAll('bg-plate', 'bg-plate invert'), /own white plate/],
  ['the width axis goes', 'main', (s) => s.replace("'@fontsource-variable/ibm-plex-sans/wdth.css'", "'@fontsource-variable/ibm-plex-sans'"), /width axis/],
  ['a font CDN appears', 'main', (s) => `${s}\n// https://fonts.googleapis.com/css`, /self-hosted/],
  ['form labels lose the width', 'css', (s) => s.replace('font-stretch: 87.5%', 'font-stretch: 100%'), /87\.5% width/],
  ['a weight goes off the scale', 'src/styles/candidate-r1.css', (s) => `${s}\n.x { font-weight: 750; }`, /uses weights 750/],
  ['an eyebrow comes back', 'src/styles/candidate-experience.css', (s) => `${s}\n.x { text-transform: uppercase; }`, /uppercases text/],
  ['a size goes off the scale', LAYOUT, (s) => `${s}\nconst t = 'text-[15px]';`, /arbitrary text sizes/],
  ['a bold class appears', LAYOUT, (s) => `${s}\nconst b = 'font-bold';`, /weights off the scale/],
  ['small text is tracked', LAYOUT, (s) => `${s}\nconst k = 'tracking-tight';`, /negative tracking/],
  ['mono spreads', LAYOUT, (s) => `${s}\nconst m = 'font-mono';`, /Plex Mono outside/],
];

for (const [name, file, change, expected] of CASES) {
  const errors = checkDesignSystem(seeded(file, change));
  assert.ok(errors.some((e) => expected.test(e)), `${name}: expected ${expected}, got ${JSON.stringify(errors)}`);
}

assert.equal(Number(contrast('#000000', '#ffffff').toFixed(2)), 21);
console.log(`design gate negative controls passed: ${CASES.length} seeded faults caught`);
