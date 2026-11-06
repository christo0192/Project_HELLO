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
 * approved by the owner and the stakeholder on 2026-11-05, and for the four status
 * families, the owner's request of 2026-11-06
 * (`docs/design/logsheet-colour-decision-2026-11-06.md`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { markVar } from '../components/design/tones';
import { CANDIDATE_STATUS_ORDER } from '../components/talent/candidateFilters';
import { candidateStatusMark } from '../components/talent/status';

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
  // The four status families. Each colour means one thing on every screen.
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

/** A token's hex, following a `var()` alias such as `--moving-deep`. */
function resolved(name: string): string {
  const hex = declared(name);
  if (hex) return hex;
  const alias = new RegExp(`^\\s*${name}:\\s*var\\((--[\\w-]+)\\)\\s*;`, 'm').exec(indexCss);
  if (!alias) throw new Error(`${name} is neither a hex nor an alias in index.css`);
  return resolved(alias[1]);
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
  // A family's text shade on every ground it is printed on, and on its own wash.
  ['--moving-text', '--paper', 4.5, 6.74, 'a figure, underway'],
  ['--moving-text', '--field', 4.5, 6.18, 'a figure on a shaded field'],
  ['--moving-text', '--desk', 4.5, 5.69, 'a figure on the desk'],
  ['--moving-text', '--moving-soft', 4.5, 6.03, 'a badge, underway'],
  ['--ready', '--paper', 4.5, 6.49, 'a figure, good or ready'],
  ['--ready', '--field', 4.5, 5.95, 'a figure on a shaded field'],
  ['--ready', '--desk', 4.5, 5.48, 'a figure on the desk'],
  ['--ready', '--ready-soft', 4.5, 5.84, 'a badge, good or ready'],
  ['--unresolved-text', '--paper', 4.5, 5.67, 'a figure, needs a second look'],
  ['--unresolved-text', '--field', 4.5, 5.2, 'a figure on a shaded field'],
  ['--unresolved-text', '--desk', 4.5, 4.79, 'a figure on the desk, the lowest of the four'],
  ['--unresolved-text', '--unresolved-soft', 4.5, 5.05, 'a badge, needs a second look'],
  ['--closed', '--paper', 4.5, 7.84, 'a figure, ended'],
  ['--closed', '--field', 4.5, 7.18, 'a figure on a shaded field'],
  ['--closed', '--desk', 4.5, 6.61, 'a figure on the desk'],
  ['--closed', '--closed-soft', 4.5, 6.92, 'a badge, ended'],
  // The only three marks that may carry paper text.
  ['--paper', '--moving-text', 4.5, 6.74, 'paper text on the deep underway mark'],
  ['--paper', '--ready', 4.5, 6.49, 'paper text on the ready mark'],
  ['--paper', '--closed', 4.5, 7.84, 'paper text on the closed mark'],
  // A family's mark on paper: bars, lines and dots.
  ['--moving', '--paper', 3, 3.59, 'the underway mark'],
  ['--unresolved', '--paper', 3, 3.3, 'the needs-a-second-look mark'],
  ['--unresolved', '--field', 3, 3.02, 'an evidence tag\'s resting edge, on its own hover field'],
  // The verdict block: labels and quiet text on its soft wash.
  ['--ink-2', '--ready-soft', 4.5, 8.34, 'body text on a Select wash'],
  ['--ink-2', '--unresolved-soft', 4.5, 8.25, 'body text on a Borderline wash'],
  ['--ink-2', '--closed-soft', 4.5, 8.18, 'body text on a Reject wash'],
  ['--ink-3', '--ready-soft', 4.5, 5.29, 'the /100 and the ruler\'s 100 on a Select wash'],
  ['--ink-3', '--unresolved-soft', 4.5, 5.23, 'the /100 and the ruler\'s 100 on a Borderline wash'],
  ['--ink-3', '--closed-soft', 4.5, 5.18, 'the /100 and the ruler\'s 100 on a Reject wash'],
  // The ruler prints all three verdicts' words on whichever wash the verdict took.
  ['--unresolved-text', '--ready-soft', 4.5, 5.1, 'the Borderline label on a Select wash'],
  ['--closed', '--ready-soft', 4.5, 7.05, 'the Reject label on a Select wash'],
  ['--ready', '--unresolved-soft', 4.5, 5.78, 'the Select label on a Borderline wash'],
  ['--closed', '--unresolved-soft', 4.5, 6.98, 'the Reject label on a Borderline wash'],
  ['--ready', '--closed-soft', 4.5, 5.73, 'the Select label on a Reject wash'],
  ['--unresolved-text', '--closed-soft', 4.5, 5.0, 'the Borderline label on a Reject wash'],
  // A pressed evidence number: paper on the family's text shade.
  ['--paper', '--unresolved-text', 4.5, 5.67, 'a pressed evidence number on a middling metric'],
  // The lightest step that still clears 3:1 on paper.
  ['--ready-light', '--paper', 3, 3.27, 'a ruler zone beside its printed label'],
];

/** Below 3:1 on purpose; DIRECTION.md says why. Pinned so a change is noticed. */
const DECORATIVE_PAIRS: Array<[string, string, string]> = [
  ['--voice-mark', '--ai', 'told apart by height and speaker labels, not colour'],
  ['--wash', '--paper', 'every quote is also numbered, ticked and repeated as a button'],
  ['--rule', '--paper', 'a decorative printed rule; no state depends on it'],
  ['--rule-2', '--paper', 'a decorative printed rule; no state depends on it'],
  // The relief rule: every segment in one of these has a printed, labelled chip with its count.
  ['--moving-light', '--paper', 'the lightest ramp step: its segment has a printed chip and count'],
  ['--unresolved-light', '--paper', 'the lightest ramp step: its segment has a printed chip and count'],
  ['--closed-light', '--paper', 'the lightest ramp step: its segment has a printed chip and count'],
  // The verdict block's wash. Each ruler zone has its printed label under it, and the circle has its word.
  ...(['--ready-soft', '--unresolved-soft', '--closed-soft'] as const).flatMap((wash): Array<[string, string, string]> => [
    ['--ready-light', wash, 'a ruler zone the score is not in: its printed label says which'],
    ['--unresolved-light', wash, 'a ruler zone the score is not in: its printed label says which'],
    ['--closed-light', wash, 'a ruler zone the score is not in: its printed label says which'],
    ['--unresolved', wash, 'the Borderline circle and zone: the word and the printed label carry them'],
  ]),
  // A dot, aria-hidden, and the printed word beside it carries the status.
  ['--unresolved', '--unresolved-soft', 'the olive dot on its own badge or notice wash: the word carries the status'],
  ['--unresolved', '--desk', 'the sidebar\'s Maintenance dot: the word carries the state'],
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
    ['--success', 'ready'],
    ['--success-text', 'ready-text'],
    ['--success-soft', 'ready-soft'],
    ['--warning', 'unresolved'],
    ['--warning-text', 'unresolved-text'],
    ['--warning-soft', 'unresolved-soft'],
    ['--moving-deep', 'moving-text'],
    ['--ready-text', 'ready'],
    ['--closed-text', 'closed'],
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

/*
 * The small port of the dataviz validator: Machado, Oliveira & Fernandes (2009)
 * at severity 1.0 and Euclidean OKLab x100. The validator itself is a dev tool on
 * one machine; this is what fails CI if a family token moves. The thresholds are
 * the validator's, calibrated to this simulation, so the model is part of the rule.
 */
const CVD: Record<'protan' | 'deutan', number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function linear(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

function oklab([r, g, b]: number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate(hex: string, kind?: 'protan' | 'deutan'): number[] {
  const rgb = linear(hex);
  if (!kind) return rgb;
  return CVD[kind].map((row) =>
    Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])),
  );
}

/** Delta E (OKLab x100) between two colours, under normal vision or a simulation. */
function deltaE(a: string, b: string, kind?: 'protan' | 'deutan'): number {
  const x = oklab(simulate(a, kind));
  const y = oklab(simulate(b, kind));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const allPairs = (hexes: string[]): Array<[string, string]> =>
  hexes.flatMap((a, i) => hexes.slice(i + 1).map((b): [string, string] => [a, b]));
const adjacentPairs = (hexes: string[]): Array<[string, string]> =>
  hexes.slice(1).map((b, i): [string, string] => [hexes[i], b]);
const worstCvd = (pairs: Array<[string, string]>) =>
  Math.min(...pairs.flatMap(([a, b]) => [deltaE(a, b, 'protan'), deltaE(a, b, 'deutan')]));
const worstNormal = (pairs: Array<[string, string]>) => Math.min(...pairs.map(([a, b]) => deltaE(a, b)));

/** OKLCH lightness and hue in degrees. */
function lightHue(hex: string): { lightness: number; hue: number } {
  const [lightness, a, b] = oklab(linear(hex));
  return { lightness, hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

describe('colour that carries meaning (validated on --paper)', () => {
  const FAMILIES = ['--moving', '--ready', '--unresolved', '--closed'];
  const FLOOR = { cvd: 8, normal: 15 };

  it('keeps the chart cycle apart for every reader, in every pair', () => {
    const pairs = allPairs(FAMILIES.map(value));
    expect(worstCvd(pairs)).toBeGreaterThanOrEqual(FLOOR.cvd);
    expect(worstNormal(pairs)).toBeGreaterThanOrEqual(FLOOR.normal);
    // The figures the decision record quotes, so the record cannot drift.
    expect(Number(worstCvd(pairs).toFixed(1))).toBe(14.5);
    expect(Number(worstNormal(pairs).toFixed(1))).toBe(20);
    for (const name of FAMILIES) {
      expect(contrast(value(name), value('--paper')), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps Select, Borderline and Reject apart in every pair', () => {
    const pairs = allPairs(['--ready', '--unresolved', '--closed'].map(value));
    expect(worstCvd(pairs)).toBeGreaterThanOrEqual(FLOOR.cvd);
    expect(worstNormal(pairs)).toBeGreaterThanOrEqual(FLOOR.normal);
  });

  describe('the Candidates status bar, from its real order and marks', () => {
    /** The colour a status draws on the bar, through the same functions the bar calls. */
    const statusHex = (status: string): string => {
      const fill = /^var\((--[\w-]+)\)$/.exec(markVar(candidateStatusMark(status)));
      if (!fill) throw new Error(`${status} does not fill with a token`);
      return resolved(fill[1]);
    };
    const underFloor = (a: string, b: string): boolean => {
      const [x, y] = [statusHex(a), statusHex(b)];
      return (
        deltaE(x, y) < FLOOR.normal ||
        Math.min(deltaE(x, y, 'protan'), deltaE(x, y, 'deutan')) < FLOOR.cvd
      );
    };
    const key = (a: string, b: string): string => `${a} | ${b}`;

    /*
     * The pairs that can touch under a floor, kept on purpose: the brief's tokens and
     * mapping stand, and each segment keeps its 2px gap and its labelled chip with a
     * count, so colour is not the only thing telling them apart. The same list, with
     * the same reasons, is in docs/design/logsheet-colour-decision-2026-11-06.md.
     */
    const SAME_STEP = [
      // Thirteen keys cannot all differ.
      ['consent_declined', 'opted_out'],
      ['consent_declined', 'phone_cancelled'],
      ['opted_out', 'phone_cancelled'],
      ['abandoned_no_answer', 'wrong_number'],
    ];
    const SAME_FAMILY = [
      // Two steps of one meaning: 11.0 under full colour vision.
      ['abandoned_no_answer', 'screening_abandoned'],
      ['screening_abandoned', 'wrong_number'],
    ];
    const TWO_FAMILIES = [
      // Only when every bucket between them is empty.
      ['new', 'consent_declined'],
      ['new', 'opted_out'],
      ['new', 'phone_cancelled'],
      ['queued', 'consent_declined'],
      ['queued', 'opted_out'],
      ['queued', 'phone_cancelled'],
      ['screening', 'advanced'],
      ['screening', 'rejected'],
      ['screened', 'abandoned_no_answer'],
      ['screened', 'wrong_number'],
      ['advanced', 'phone_failed'],
    ];

    it('keeps the eleven validated keys apart when every bucket has someone in it', () => {
      const eleven = CANDIDATE_STATUS_ORDER.filter((s) => s !== 'wrong_number' && s !== 'phone_cancelled');
      const pairs = adjacentPairs(eleven.map(statusHex));
      expect(worstNormal(pairs)).toBeGreaterThanOrEqual(FLOOR.normal);
      expect(worstCvd(pairs)).toBeGreaterThanOrEqual(FLOOR.cvd);
    });

    it('names the two neighbours under a floor on a bar with every bucket full', () => {
      const under = CANDIDATE_STATUS_ORDER.slice(1)
        .map((status, i) => [CANDIDATE_STATUS_ORDER[i], status] as const)
        .filter(([a, b]) => underFloor(a, b))
        .map(([a, b]) => key(a, b));
      expect(under).toEqual([key('screening_abandoned', 'wrong_number'), key('opted_out', 'phone_cancelled')]);
    });

    it('names every pair that can touch under a floor once the buckets between them are empty', () => {
      // A bar draws no segment for an empty bucket, so any two statuses can touch.
      const under = CANDIDATE_STATUS_ORDER.flatMap((a, i) =>
        CANDIDATE_STATUS_ORDER.slice(i + 1)
          .filter((b) => underFloor(a, b))
          .map((b) => key(a, b)),
      );
      expect(under.sort()).toEqual(
        [...SAME_STEP, ...SAME_FAMILY, ...TWO_FAMILIES].map(([a, b]) => key(a, b)).sort(),
      );
    });

    it('holds the same-step and same-family pairs to what each list says', () => {
      const family = (status: string) => /--([a-z]+)/.exec(markVar(candidateStatusMark(status)))![1];
      for (const [a, b] of SAME_STEP) expect(statusHex(a), key(a, b)).toBe(statusHex(b));
      for (const [a, b] of SAME_FAMILY) {
        expect(statusHex(a), key(a, b)).not.toBe(statusHex(b));
        expect(family(a), key(a, b)).toBe(family(b));
      }
      for (const [a, b] of TWO_FAMILIES) expect(family(a), key(a, b)).not.toBe(family(b));
    });
  });

  describe('a verdict ruler, neighbour against neighbour, in each of its states', () => {
    it.each([
      ['Reject', ['--closed', '--unresolved-light', '--ready-light'], 16.1, 9.9],
      ['Select', ['--closed-light', '--unresolved-light', '--ready'], 22.4, 20.6],
    ])('the %s state clears both floors', (_state, zones, normal, cvd) => {
      const pairs = adjacentPairs((zones as string[]).map(value));
      expect(worstNormal(pairs)).toBeGreaterThanOrEqual(FLOOR.normal);
      expect(worstCvd(pairs)).toBeGreaterThanOrEqual(FLOOR.cvd);
      expect(Number(worstNormal(pairs).toFixed(1))).toBe(normal);
      expect(Number(worstCvd(pairs).toFixed(1))).toBe(cvd);
    });

    it('the Borderline state clears them between Reject and Borderline', () => {
      const pair: Array<[string, string]> = [[value('--closed-light'), value('--unresolved')]];
      expect(worstNormal(pair)).toBeGreaterThanOrEqual(FLOOR.normal);
      expect(worstCvd(pair)).toBeGreaterThanOrEqual(FLOOR.cvd);
    });

    it('the Borderline state falls short between Borderline and Select, relieved by a gap and the labels', () => {
      // The one recorded exception (docs/design/logsheet-colour-decision-2026-11-06.md). The validator
      // calls CVD in the 6 to 8 band legal only with secondary encoding, so that encoding is pinned too.
      const pair: Array<[string, string]> = [[value('--unresolved'), value('--ready-light')]];
      expect(Number(worstNormal(pair).toFixed(1))).toBe(11);
      expect(Number(worstCvd(pair).toFixed(1))).toBe(6.7);
      const zones = read('src/components/session/RulerZones.tsx');
      expect(zones).toContain('border-l-2 border-transparent bg-clip-padding');
      // The gap is the wash showing through, and each zone has its word printed under it.
      for (const rel of ['src/components/talent/ReviewScorecard.tsx', 'src/components/r1-review/VerdictBlock.tsx']) {
        const code = read(rel);
        for (const family of ['closed', 'unresolved', 'ready']) expect(code, rel).toContain(`rulerLabelClass('${family}', current)`);
      }
    });
  });

  describe('an evidence tag, a bare number with no word to carry its family', () => {
    const FLOORED = allPairs(['--ready', '--unresolved', '--closed'].map(value));

    it('sets its resting edges apart in the marks, for every reader', () => {
      expect(worstCvd(FLOORED)).toBeGreaterThanOrEqual(FLOOR.cvd);
      expect(worstNormal(FLOORED)).toBeGreaterThanOrEqual(FLOOR.normal);
      // Borderline beside Select, in the validator's figures: the pair a tag must not lose.
      const pair: Array<[string, string]> = [[value('--unresolved'), value('--ready')]];
      expect(Number(worstNormal(pair).toFixed(1))).toBe(20);
      expect(Number(worstCvd(pair).toFixed(1))).toBe(15.5);
    });

    it('cannot lean on the text shades alone, which the validator fails', () => {
      // These are relieved by a printed word wherever one exists, and a tag has none.
      const pair: Array<[string, string]> = [[value('--unresolved-text'), value('--ready')]];
      expect(Number(worstNormal(pair).toFixed(1))).toBe(9.5);
      expect(Number(worstCvd(pair).toFixed(1))).toBe(3.7);
      expect(worstNormal(pair)).toBeLessThan(FLOOR.normal);
      expect(worstCvd(pair)).toBeLessThan(FLOOR.cvd);
    });

    it('draws each resting edge in the mark, and the digit and the pressed fill in the text shade', () => {
      const tones = stripJsComments(read('src/components/design/tones.ts'));
      for (const family of ['ready', 'unresolved', 'closed']) {
        expect(tones).toContain(`resting: 'border-${family} bg-paper text-${family}-text'`);
        expect(tones).toContain(`pressed: 'border-${family}-text bg-${family}-text text-paper'`);
      }
    });
  });

  it.each(FAMILIES)('%s stays 15 clear of the voice mark and of the fault colour under full colour vision', (name) => {
    expect(deltaE(value(name), value('--voice-mark'))).toBeGreaterThanOrEqual(FLOOR.normal);
    expect(deltaE(value(name), value('--danger'))).toBeGreaterThanOrEqual(FLOOR.normal);
  });

  it('names the reserved-colour pairs a colour-blind reader cannot tell apart by colour', () => {
    /*
     * Kept: the tokens are the validated ones, and the printed word carries the state
     * in all three, plus a fault's crimson edge on a badge. Each is stated in the
     * decision record, which puts it to the owner, and in the design system doc.
     */
    const KNOWN: Array<[string, string, number]> = [
      // Completed beside Failed on the Mission Control session mix, each on its own labelled row.
      ['--ready', '--danger', 2.1],
      // Orange marks a voice on a call strip, never a neighbouring status category.
      ['--ready', '--voice-mark', 7.0],
      ['--unresolved', '--voice-mark', 1.7],
    ];
    const found = FAMILIES.flatMap((name) =>
      ['--danger', '--voice-mark'].map((reserved): [string, string, number] => [
        name,
        reserved,
        Number(
          Math.min(
            deltaE(value(name), value(reserved), 'protan'),
            deltaE(value(name), value(reserved), 'deutan'),
          ).toFixed(1),
        ),
      ]),
    ).filter(([, , worst]) => worst < FLOOR.cvd);
    expect(found).toEqual(KNOWN);
    // The second signal the record relies on. If a fault loses its edge, this has to be argued again.
    expect(read('src/components/design/StatusBadge.tsx')).toContain(
      "danger: 'bg-error-soft text-error-text ring-1 ring-inset ring-error'",
    );
  });

  it.each([
    ['moving', ['--moving-light', '--moving', '--moving-text']],
    ['ready', ['--ready-light', '--ready']],
    ['unresolved', ['--unresolved-light', '--unresolved']],
    ['closed', ['--closed-light', '--closed']],
  ])('the %s ramp is one hue, stepping visibly darker, its light end at 2:1', (_family, steps) => {
    const ramp = steps.map((name) => lightHue(value(name)));
    ramp.slice(1).forEach((step, i) => {
      expect(ramp[i].lightness - step.lightness, steps[i]).toBeGreaterThanOrEqual(0.06);
    });
    const hues = ramp.map((step) => step.hue);
    expect(Math.max(...hues) - Math.min(...hues)).toBeLessThanOrEqual(40);
    expect(contrast(value(steps[0]), value('--paper'))).toBeGreaterThanOrEqual(2);
  });

  it('never prints text on the two marks too light to carry it', () => {
    // Paper on these is 3.59 and 3.30. `bg-warning` is the same mark as `bg-unresolved`.
    expect(contrast(value('--paper'), value('--moving'))).toBeLessThan(4.5);
    expect(contrast(value('--paper'), value('--unresolved'))).toBeLessThan(4.5);
    const fill = /['"`][^'"`\n]*(?<![\w-])bg-(?:moving|unresolved|warning)(?![\w-])[^'"`\n]*['"`]/g;
    const offenders = sourceFiles().filter((rel) =>
      [...stripJsComments(read(rel)).matchAll(fill)].some(([classes]) => /(?<![\w-])text-/.test(classes)),
    );
    expect(offenders).toEqual([]);
    // NEGATIVE CONTROL: the scan does catch one.
    expect([...`className="bg-warning text-surface"`.matchAll(fill)]).toHaveLength(1);
    expect([...`className="bg-warning-soft text-ink"`.matchAll(fill)]).toHaveLength(0);
  });

  it('points the ink names at ink, and leaves the reserved colours alone', () => {
    // `bg-info` is the primary fill in about 24 places, so `info` moves in the
    // tone maps of StatusBadge and BarList, never here.
    expect(indexCss).toMatch(/^\s*--info:\s*var\(--ink\)\s*;/m);
    expect(indexCss).toMatch(/^\s*--info-rgb:\s*27 25 21;/m);
    expect(value('--voice')).toBe('#a8460c');
    expect(value('--voice-mark')).toBe('#cf5a12');
    expect(value('--danger')).toBe('#a01c3c');
    expect(value('--go')).toBe('#2f7a4f');
  });

  it('NEGATIVE CONTROL: the port rejects what the validator rejected', () => {
    // Teal with plum collapses for colour-blind readers, and would be Select against Reject.
    const teal = '#12857a';
    const plum = '#9c4a8f';
    expect(Number(Math.min(deltaE(teal, plum, 'protan'), deltaE(teal, plum, 'deutan')).toFixed(1))).toBe(4.2);
    // Amber sits too near the voice orange, under full colour vision.
    expect(Number(deltaE('#b98500', value('--voice-mark')).toFixed(1))).toBe(10.6);
    // A colour against itself is nothing, in any vision.
    expect(deltaE('#2f8bc3', '#2f8bc3', 'protan')).toBe(0);
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

  it('stays out of the pipeline: the on-a-call stage is the deep underway mark', () => {
    for (const rel of [
      'src/pages/CandidatesPage.tsx',
      'src/components/talent/PipelineBar.tsx',
      'src/components/talent/RolePipelinePanel.tsx',
    ]) {
      expect(stripJsComments(read(rel)), rel).not.toMatch(/voice/i);
    }
    expect(read('src/components/talent/status.ts')).toContain("['screening', 'moving-deep']");
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

  it('hands a verdict\'s circle its word\'s forced colour, because an svg keeps its own otherwise', () => {
    const css = stripCssComments(indexCss);
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    const rule = /svg\[data-verdict-mark\] \{([^}]*)\}/.exec(block);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/color: inherit/);
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
    expect(users.sort()).toEqual([
      'src/components/r1-review/OverviewPanel.tsx',
      'src/components/r1-review/PlayerControls.tsx',
      'src/components/r1-review/ReviewNotes.tsx',
      'src/components/r1-review/ReviewTranscript.tsx',
      'src/components/recording/CallStrip.tsx',
      'src/components/recording/ReviewCallStrip.tsx',
      'src/components/talent/ReviewScorecard.tsx',
      'src/components/talent/ReviewTape.tsx',
      'src/components/talent/SeekableTranscript.tsx',
    ]);
  });

  it('allows no negative tracking below 24px', () => {
    const offenders = sourceFiles().filter((rel) => /tracking-tight|tracking-\[-/.test(stripJsComments(read(rel))));
    expect(offenders).toEqual([]);
  });
});

describe('a verdict takes its family', () => {
  it('maps each stored recommendation to one family, and Reject never to crimson', () => {
    const tones = read('src/components/design/tones.ts');
    expect(tones).toMatch(/advance: 'ready'/);
    expect(tones).toMatch(/hold: 'unresolved'/);
    expect(tones).toMatch(/reject: 'closed'/);
    const meta = read('src/components/session/scorecard-read.ts');
    expect(meta).toMatch(/advance: \{[^}]*tone: 'success'/);
    expect(meta).toMatch(/hold: \{[^}]*tone: 'warning'/);
    expect(meta).toMatch(/reject: \{[^}]*tone: 'closed'/);
    expect(meta).not.toMatch(/tone: 'danger'/);
  });

  it('rates by position on the scale: 0.75 and up is ready, 0.5 and up unresolved, the rest closed', () => {
    expect(read('src/components/design/tones.ts')).toMatch(
      /position >= 0\.75 \? 'ready' : position >= 0\.5 \? 'unresolved' : 'closed'/,
    );
  });

  it('gives an aggregate the same verdict colour, and Reject the closed family, never crimson', () => {
    const page = read('src/pages/CandidatesPage.tsx');
    expect(page).toMatch(/advance: "ready"/);
    expect(page).toMatch(/hold: "unresolved"/);
    expect(page).toMatch(/reject: "closed"/);
    const dashboard = read('src/pages/DashboardPage.tsx');
    expect(dashboard).toMatch(/advance: 'success'/);
    expect(dashboard).toMatch(/hold: 'warning'/);
    expect(dashboard).toMatch(/reject: 'closed'/);
  });

  it('says no score could be given in the unresolved family', () => {
    for (const rel of ['src/components/session/RoleScorecardView.tsx', 'src/components/r1-review/OverviewPanel.tsx']) {
      expect(read(rel), rel).toMatch(/<StatusBadge tone="warning">Insufficient evidence<\/StatusBadge>/);
    }
  });

  it('prints a provisional notice in the unresolved family, and a held card\'s notice in no family', () => {
    for (const rel of ['src/components/session/RoleScorecardView.tsx', 'src/components/r1-review/OverviewPanel.tsx']) {
      const notices = [...read(rel).matchAll(/<InlineNotice tone="([a-z]+)"/g)].map((match) => match[1]);
      expect(notices, rel).toEqual(['warning']);
    }
    expect(read('src/components/talent/EvidenceHoldNotice.tsx')).not.toMatch(/warning/);
  });

  it('draws no meter or score in the fault colour', () => {
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
