/**
 * The type system: typeface, scale, figures, sentence-case labels.
 *
 * jsdom does not lay out text or load fonts, so these pin the CONTRACT
 * rather than the pixels: which face every stack names first, that the
 * Inter-only feature settings stay gone, that the scale tokens carry the
 * agreed numbers, that data surfaces opt into tabular figures, and that no
 * owned stylesheet brings back an uppercase tracked label. Every file read
 * is CRLF-normalised: the Windows checkout uses CRLF, and a `\n`-anchored
 * pattern would otherwise pass or fail by platform.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionHeader } from '../SectionHeader';
import { StatusBadge } from '../StatusBadge';
import { Table, TBody, Td, Th, THead, Tr } from '../Table';
import { Tag } from '../Tag';

const WEB = process.cwd();
const read = (rel: string) => readFileSync(resolve(WEB, rel), 'utf8').replace(/\r\n/g, '\n');

interface TailwindConfig {
  theme: {
    extend: {
      fontFamily: Record<string, string[]>;
      fontSize: Record<string, [string, Record<string, string>]>;
    };
  };
}

async function tailwindConfig(): Promise<TailwindConfig> {
  // A runtime URL, so the type checker does not try to resolve a `.js`
  // module without declarations; vitest imports it like any ESM file.
  const url = pathToFileURL(resolve(WEB, 'tailwind.config.js')).href;
  const mod = (await import(/* @vite-ignore */ url)) as { default: TailwindConfig };
  return mod.default;
}

/* ── Typeface ─────────────────────────────────────────────────────── */

describe('typeface', () => {
  it('names IBM Plex first in the Tailwind sans and mono stacks', async () => {
    const { fontFamily } = (await tailwindConfig()).theme.extend;
    expect(fontFamily.sans[0]).toBe('"IBM Plex Sans Variable"');
    expect(fontFamily.mono[0]).toBe('"IBM Plex Mono"');
    // A system fallback must remain behind it for the swap period.
    expect(fontFamily.sans).toContain('system-ui');
    expect(fontFamily.mono).toContain('monospace');
  });

  it('names IBM Plex Sans first on body, and no longer sets the Inter feature settings', () => {
    // Declarations only: the stylesheet's comments explain the removal.
    const css = read('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const body = /\n  body \{\n([\s\S]*?)\n  \}/.exec(css);
    expect(body, 'base-layer body rule not found').not.toBeNull();
    expect(body![1]).toMatch(/font-family:\s*'IBM Plex Sans Variable',/);
    // `cv11` / `ss01` are Inter's alternates; on any other face they switch
    // on arbitrary glyphs.
    expect(css).not.toMatch(/font-feature-settings\s*:/);
    expect(css).not.toMatch(/'cv11'|'ss01'/);
  });

  it('bundles the fonts from the app entry, never from a CDN (CSP font-src self)', () => {
    const main = read('src/main.tsx');
    expect(main).toMatch(/import '@fontsource-variable\/ibm-plex-sans';/);
    expect(main).toMatch(/import '@fontsource\/ibm-plex-mono\/400\.css';/);
    // The fonts load before the app stylesheet so its rules can name them.
    expect(main.indexOf("'@fontsource-variable/ibm-plex-sans'")).toBeLessThan(main.indexOf("'./index.css'"));
    for (const file of ['src/main.tsx', 'src/index.css', 'index.html']) {
      expect(read(file), `${file} reaches a font CDN`).not.toMatch(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr|unpkg\.com/);
    }
  });
});

/* ── Scale ────────────────────────────────────────────────────────── */

describe('type scale tokens', () => {
  it.each([
    // [token, size, line height, weight, tracking]
    ['title', '1.75rem', '2.125rem', '600', '-0.02em'],
    ['stat', '1.875rem', '2.25rem', '600', '-0.02em'],
    ['section', '0.9375rem', '1.25rem', '600', '-0.01em'],
    ['label', '0.8125rem', '1.25rem', undefined, undefined],
    ['meta', '0.75rem', '1rem', undefined, undefined],
  ])('text-%s is %s / %s', async (token, size, lineHeight, weight, tracking) => {
    const { fontSize } = (await tailwindConfig()).theme.extend;
    const [actualSize, options] = fontSize[token];
    expect(actualSize).toBe(size);
    expect(options.lineHeight).toBe(lineHeight);
    expect(options.fontWeight).toBe(weight);
    expect(options.letterSpacing).toBe(tracking);
  });

  it('no step is uppercase or tracked open', async () => {
    const { fontSize } = (await tailwindConfig()).theme.extend;
    for (const [token, [, options]] of Object.entries(fontSize)) {
      const tracking = options.letterSpacing ?? '0em';
      expect(parseFloat(tracking), `text-${token} tracks open`).toBeLessThanOrEqual(0);
    }
  });
});

/* ── Primitives ───────────────────────────────────────────────────── */

describe('primitives on the scale', () => {
  it('SectionHeader: section step at both levels; meta on the baseline in tabular figures', () => {
    const { rerender } = render(<SectionHeader title="Sessions" meta="20 total" description="Opaque ids only." />);
    const h2 = screen.getByRole('heading', { name: 'Sessions', level: 2 });
    expect(h2).toHaveClass('text-section');
    expect(h2.parentElement).toHaveClass('items-baseline');
    expect(screen.getByText('20 total')).toHaveClass('tabular-nums', 'text-label', 'text-ink-tertiary');
    expect(screen.getByText('Opaque ids only.')).toHaveClass('text-label', 'text-ink-tertiary');

    rerender(<SectionHeader title="Override" level={3} />);
    const h3 = screen.getByRole('heading', { name: 'Override', level: 3 });
    // Level is outline, not size: both levels share the section step.
    expect(h3).toHaveClass('text-section');
    expect(h3.className).toBe(h2.className);
  });

  it('SectionHeader: renders no meta wrapper when there is no meta', () => {
    render(<SectionHeader title="Plain" />);
    const heading = screen.getByRole('heading', { name: 'Plain' });
    expect(heading.parentElement?.children).toHaveLength(1);
  });

  it('Table: tabular figures across the table; header cells on the meta step', () => {
    render(
      <Table caption="Scores">
        <THead>
          <Tr>
            <Th>Score</Th>
          </Tr>
        </THead>
        <TBody>
          <Tr>
            <Td>11</Td>
          </Tr>
        </TBody>
      </Table>,
    );
    expect(screen.getByRole('table', { name: 'Scores' })).toHaveClass('tabular-nums', 'text-sm');
    expect(screen.getByRole('columnheader', { name: 'Score' })).toHaveClass('text-meta', 'font-medium');
  });

  it('StatusBadge and Tag: meta step, medium, tabular figures', () => {
    render(
      <>
        <StatusBadge tone="warning">Quota 92%</StatusBadge>
        <Tag tone="accent">5 yrs</Tag>
      </>,
    );
    expect(screen.getByText('Quota 92%')).toHaveClass('text-meta', 'font-medium', 'tabular-nums');
    expect(screen.getByText('5 yrs')).toHaveClass('text-meta', 'font-medium', 'tabular-nums');
  });
});

/* ── Sentence case ────────────────────────────────────────────────── */

describe('no uppercase tracked labels', () => {
  const STYLESHEETS = [
    'src/index.css',
    'src/styles/candidate-experience.css',
    'src/styles/candidate-palette.css',
  ];

  it.each(STYLESHEETS)('%s never uppercases text or tracks it open', (rel) => {
    const css = read(rel);
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    // Positive letter-spacing is the other half of an eyebrow. Negative
    // tracking on display type is fine.
    const open = [...css.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)].filter((m) => parseFloat(m[1]) > 0);
    expect(open.map((m) => m[0])).toEqual([]);
  });

  it.each([
    'SectionHeader.tsx',
    'GlassPanel.tsx',
    'StatusBadge.tsx',
    'Tag.tsx',
    'Field.tsx',
    'Table.tsx',
    'Notice.tsx',
    'Button.tsx',
    'SegmentedControl.tsx',
    'Skeleton.tsx',
  ])('%s carries no uppercase or open-tracking utility', (file) => {
    // Comments may NAME the rule ("no uppercase tracking"); only code counts.
    const code = read(`src/components/design/${file}`)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\buppercase\b|\btracking-(?:wide|wider|widest)\b/);
  });

  it('NEGATIVE CONTROL: the CSS guard catches a real eyebrow', () => {
    const eyebrow = '.x { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }';
    expect(eyebrow).toMatch(/text-transform:\s*uppercase/);
    expect([...eyebrow.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)].some((m) => parseFloat(m[1]) > 0)).toBe(true);
  });
});

/* ── Two regressions this pass fixed ──────────────────────────────── */

describe('fixed regressions', () => {
  it('the select chevron keeps its gutter over the control padding utility', () => {
    // `SelectField` carries `px-3` (a utility) and `.control-select` lives in
    // the components layer, so a bare class lost and the value ran under the
    // chevron: in the 76px "Rows" select it sat across the "0" of "10".
    const css = read('src/index.css');
    expect(css).toMatch(/select\.control-select \{\n\s*padding-right: 2\.25rem;/);
  });

  it('the candidate level meter animates transform, not height', () => {
    const css = read('src/styles/candidate-experience.css');
    const transitions = [...css.matchAll(/transition:\s*([^;}]+)/g)].map((m) => m[1]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) {
      expect(value, `layout property animated: ${value}`).not.toMatch(/\b(?:(?:max|min)-)?(?:height|width)\b|\bpadding\b|\bmargin\b/);
    }
    expect(css).toMatch(/\.candidate-level-meter i \{[^}]*transform-origin: 50% 100%/);
  });
});
