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
const PAGE = 'src/pages/CandidatesPage.tsx';
const R1_CSS = 'src/styles/candidate-r1.css';
const CANDIDATE_CSS = 'src/styles/candidate-experience.css';
const R1_OVERVIEW = 'src/components/r1-review/OverviewPanel.tsx';
const CASES = [
  ['a palette token drifts', 'css', (s) => s.replace('--paper: #fbfaf6', '--paper: #ffffff'), /--paper should be/],
  ['a family token drifts', 'css', (s) => s.replace('--ready: #0a693c', '--ready: #12857a'), /--ready should be/],
  ['a family loses a step', 'css', (s) => s.replace('--closed-light: #ae96da;', ''), /--closed-light should be/],
  ['a family text falls below its bar', 'css', (s) => s.replace('--unresolved-text: #6b6620', '--unresolved-text: #958d0f'), /--unresolved-text should be/],
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
  ['a resting shadow comes back', 'css', (s) => `${s}\n.glass { box-shadow: 0 1px 2px red; }`, /only floating layers may carry a shadow in src\/index.css/],
  ['a candidate card takes a shadow', CANDIDATE_CSS, (s) => `${s}\n.candidate-glass-card { box-shadow: 0 1px 2px red; }`, /only floating layers may carry a shadow in src\/styles\/candidate-experience/],
  ['a shadow utility rests on a page', LAYOUT, (s) => `${s}\nconst a = 'shadow-lg';`, /resting shadow utilities/],
  ['the bare shadow utility appears', LAYOUT, (s) => `${s}\nconst a = 'p-2 shadow rounded';`, /resting shadow utilities/],
  ['a hover shadow appears', PAGE, (s) => `${s}\nconst a = 'hover:shadow-md';`, /resting shadow utilities/],
  ['an arbitrary shadow with blur appears', LAYOUT, (s) => `${s}\nconst a = 'shadow-[0_1px_2px_var(--ink)]';`, /resting shadow utilities/],
  ['the floating shadow lands on a page', PAGE, (s) => `${s}\nconst a = 'shadow-pop';`, /resting shadow utilities/],
  ['a drop shadow appears', LAYOUT, (s) => `${s}\nconst a = 'drop-shadow-md';`, /resting shadow utilities/],
  ['an inline shadow appears', LAYOUT, (s) => `${s}\nconst a = { boxShadow: '0 4px 12px var(--ink)' };`, /inline shadows/],
  ['a radius drifts', 'css', (s) => s.replace('--radius-card: 4px', '--radius-card: 20px'), /--radius-card should be 4px/],
  ['an arbitrary radius appears', LAYOUT, (s) => `${s}\nconst r = 'rounded-[14px]';`, /arbitrary radii/],
  ['a pill radius comes back', R1_CSS, (s) => `${s}\n.x { border-radius: 999px; }`, /radii off the scale: 999px/],
  ['a skeleton goes round', LAYOUT, (s) => `${s}\nconst a = <Skeleton radius={999} />;`, /radii off the scale in/],
  ['a reveal comes back', LAYOUT, (s) => `${s}\nconst f = 'fade-up-stagger';`, /entrance, reveal or count-up/],
  ['an animation utility appears', LAYOUT, (s) => `${s}\nconst a = 'animate-bounce';`, /entrance motion utilities/],
  ['an entrance reaches a candidate page', CANDIDATE_CSS, (s) => `${s}\n@keyframes rise { from { opacity: 0; } }`, /declares entrance motion: rise/],
  ['a candidate element animates', R1_CSS, (s) => `${s}\n.x { animation: rise 1s both; }`, /declares entrance motion: rise/],
  ['a new keyframe joins the overlays', 'css', (s) => `${s}\n@keyframes stagger { to { opacity: 1; } }`, /declares entrance motion: stagger/],
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
  ['a stylesheet goes off the scale', R1_CSS, (s) => `${s}\n.x { font-size: 15px; }`, /sizes off the type scale: 15px/],
  ['a relative size slips through', CANDIDATE_CSS, (s) => `${s}\n.x { font-size: 1.1em; }`, /sizes off the type scale: 1\.1em/],
  ['a stock large size appears', LAYOUT, (s) => `${s}\nconst a = 'text-4xl';`, /sizes off the type scale in/],
  ['a chart size goes off the scale', LAYOUT, (s) => `${s}\nconst a = { fontSize: 15 };`, /sizes off the type scale in/],
  ['a bold class appears', LAYOUT, (s) => `${s}\nconst b = 'font-bold';`, /weights off the scale/],
  ['small text is tracked', LAYOUT, (s) => `${s}\nconst k = 'tracking-tight';`, /negative tracking/],
  ['an uppercase utility appears', LAYOUT, (s) => `${s}\nconst a = 'uppercase';`, /uppercase utilities/],
  ['an eyebrow is tracked open', LAYOUT, (s) => `${s}\nconst a = 'tracking-wide';`, /open tracking/],
  ['a stock hue appears', LAYOUT, (s) => `${s}\nconst a = 'bg-green-600 text-blue-700';`, /stock hue utilities/],
  ['a fault is printed with a colour that does not exist', PAGE, (s) => `${s}\nconst a = 'text-danger';`, /-danger utilities compile to nothing/],
  ['a fault is filled with a colour that does not exist', LAYOUT, (s) => `${s}\nconst a = 'bg-danger';`, /-danger utilities compile to nothing/],
  ['a re-pointed scale is dropped', 'tailwind', (s) => s.replace('red: dangerScale', 'crimson: dangerScale'), /re-points the stock scale red/],
  ['a raw hex lands in a page', PAGE, (s) => `${s}\nconst a = '#123456';`, /raw colours in/],
  ['a raw rgb lands in a page', PAGE, (s) => `${s}\nconst a = 'rgb(1, 2, 3)';`, /raw colours in/],
  ['a raw hex lands in a candidate sheet', CANDIDATE_CSS, (s) => `${s}\n.x { color: #123456; }`, /raw colours in/],
  ['a verdict goes crimson', 'src/components/session/ScoreVerdict.tsx', (s) => `${s}\nconst a = 'text-error-text';`, /a verdict takes a colour outside its family/],
  ['a verdict takes the voice', 'src/components/session/VerdictMark.tsx', (s) => `${s}\nconst a = 'text-voice';`, /a verdict takes a colour outside its family/],
  ['a verdict block takes the underway wash', 'src/components/talent/ReviewScorecard.tsx', (s) => `${s}\nconst a = 'bg-moving-soft';`, /a verdict takes a colour outside its family/],
  ['a figure takes the fault token', 'src/components/talent/HeaderScore.tsx', (s) => `${s}\nconst a = 'var(--danger)';`, /a verdict takes a colour outside its family/],
  ['a recommendation takes the fault tone', 'src/components/session/scorecard-read.ts', (s) => s.replace("tone: 'closed' }", "tone: 'danger' }"), /a verdict takes a colour outside its family/],
  ['a ruler zone goes crimson', 'src/components/session/RulerZones.tsx', (s) => `${s}\nconst a = 'bg-danger text-error-text';`, /a verdict takes a colour outside its family in [^\n]*RulerZones/],
  ['a role scorecard rating goes crimson', 'src/components/session/RoleScorecardView.tsx', (s) => `${s}\nconst a = 'text-error-text';`, /a verdict takes a colour outside its family in [^\n]*RoleScorecardView/],
  ['an R1 rating goes crimson', R1_OVERVIEW, (s) => `${s}\nconst a = 'text-error-text';`, /a verdict takes a colour outside its family in [^\n]*OverviewPanel/],
  ['an R1 rating takes the voice', R1_OVERVIEW, (s) => `${s}\nconst a = 'text-voice';`, /a verdict takes a colour outside its family in [^\n]*OverviewPanel/],
  ['an R1 rating takes the underway wash', R1_OVERVIEW, (s) => `${s}\nconst a = 'bg-moving-soft';`, /a verdict takes a colour outside its family in [^\n]*OverviewPanel/],
  ['the highlighter leaves its one quote on the R1 overview', R1_OVERVIEW, (s) => `${s}\nconst a = 'bg-wash';`, /a verdict takes a colour outside its family in [^\n]*OverviewPanel/],
  ['Select stops being ready', 'src/components/design/tones.ts', (s) => s.replace("advance: 'ready'", "advance: 'unresolved'"), /the verdict advance should be the ready family/],
  ['Reject goes back to no family', 'src/components/design/tones.ts', (s) => s.replace("reject: 'closed',", ''), /the verdict reject should be the closed family/],
  ['a rating moves its cut-off', 'src/components/design/tones.ts', (s) => s.replace('position >= 0.75', 'position >= 0.7'), /a rating should be ready from 0\.75/],
  ['the mark drops the family', 'src/components/session/VerdictMark.tsx', (s) => s.replace('verdictFamily(recommendation)', 'null'), /VerdictMark.tsx no longer prints the verdict's family/],
  ['the Review panel drops the family', 'src/components/talent/ReviewScorecard.tsx', (s) => s.replace('verdictFamily(scorecard.recommendation)', 'null'), /ReviewScorecard.tsx no longer prints the verdict's family/],
  ['a provisional chip takes the underway tag', 'src/components/talent/HeaderScore.tsx', (s) => `${s}\nconst a = <Tag tone="moving">Provisional</Tag>;`, /a verdict takes a colour outside its family in [^\n]*HeaderScore/],
  ['a matched skill takes the underway tag', 'src/components/talent/CandidateScorecard.tsx', (s) => `${s}\nconst a = <Tag tone="moving">Matched skills</Tag>;`, /a verdict takes a colour outside its family in [^\n]*CandidateScorecard/],
  ['the provisional notice takes the crimson wash', 'src/components/session/RoleScorecardView.tsx', (s) => `${s}\nconst a = 'bg-error-soft';`, /a verdict takes a colour outside its family in [^\n]*RoleScorecardView/],
  ['the evidence hold goes crimson', 'src/components/talent/EvidenceHoldNotice.tsx', (s) => `${s}\nconst a = 'text-error-text';`, /a verdict takes a colour outside its family in [^\n]*EvidenceHoldNotice/],
  ['the evidence hold takes a family', 'src/components/talent/EvidenceHoldNotice.tsx', (s) => `${s}\nconst a = 'text-warning-text';`, /a held card's notice takes a family/],
  ['mono spreads', LAYOUT, (s) => `${s}\nconst m = 'font-mono';`, /Plex Mono outside/],
];

for (const [name, file, change, expected] of CASES) {
  const errors = checkDesignSystem(seeded(file, change));
  assert.ok(errors.some((e) => expected.test(e)), `${name}: expected ${expected}, got ${JSON.stringify(errors)}`);
}

assert.equal(Number(contrast('#000000', '#ffffff').toFixed(2)), 21);
console.log(`design gate negative controls passed: ${CASES.length} seeded faults caught`);
