import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('global palette', () => {
  it('declares one light :root and no alternate token block', () => {
    expect(css).toMatch(/:root \{\n\s+color-scheme: light;/);
    expect(css).not.toMatch(/\.dark\b/);
  });

  it('points the old status names at their families, not at ink', () => {
    expect(css).toMatch(/^\s*--success:\s*var\(--ready\);/m);
    expect(css).toMatch(/^\s*--success-text:\s*var\(--ready-text\);/m);
    expect(css).toMatch(/^\s*--success-soft:\s*var\(--ready-soft\);/m);
    expect(css).toMatch(/^\s*--warning:\s*var\(--unresolved\);/m);
    expect(css).toMatch(/^\s*--warning-text:\s*var\(--unresolved-text\);/m);
    expect(css).toMatch(/^\s*--warning-soft:\s*var\(--unresolved-soft\);/m);
  });

  it('keeps `info` on ink: it is the primary fill, whatever a tone map does with the word', () => {
    expect(css).toMatch(/^\s*--info:\s*var\(--ink\);/m);
    expect(css).toMatch(/^\s*--info-soft:\s*var\(--field\);/m);
  });

  it('holds the public pages on ink, with the same values the old names had', () => {
    const rule = /\.keep-ink \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    for (const [name, token] of [
      ['--success', 'ink-2'],
      ['--success-text', 'ink-2'],
      ['--success-soft', 'field'],
      ['--warning', 'ink-2'],
      ['--warning-text', 'ink'],
      ['--warning-soft', 'field'],
    ]) {
      expect(rule![1]).toMatch(new RegExp(`${name}:\\s*var\\(--${token}\\);`));
    }
    for (const page of ['pages/AppealPage.tsx', 'pages/StatusPage.tsx']) {
      const source = readFileSync(resolve(process.cwd(), 'src', page), 'utf8');
      expect(source, page).toMatch(/<div className="app-ground keep-ink /);
    }
  });
});

/* ── The "Resume calling" green ─────────────────────────────────────────
 * The owner asked (2026-09-29) for the resume button to read as GREEN. The
 * first cut filled it with `--success-text` (#2f7488, hue ~193°), which reads
 * as blue. These pin the replacement: it IS green, its white label clears
 * 4.5:1 at rest and on hover/press, and it paints exactly one action. */

function tokenValue(name: string): string {
  // CRLF-safe: the value is read up to the `;`, never to the line end.
  const m = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(css);
  expect(m, `${name} is not declared as a 6-digit hex in index.css`).not.toBeNull();
  return m![1].toLowerCase();
}

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** HSL hue in degrees, and chroma (0–1). */
function hueOf(hex: string): { hue: number; chroma: number } {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma === 0) return { hue: 0, chroma };
  let hue =
    max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue *= 60;
  return { hue: hue < 0 ? hue + 360 : hue, chroma };
}

/** Every non-test source file under src/, relative, with forward slashes. */
function sourceFiles(): string[] {
  const root = resolve(process.cwd(), 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((rel) => rel.replace(/\\/g, '/'))
    .filter((rel) => /\.(ts|tsx)$/.test(rel))
    .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel));
}

describe('the "Resume calling" green (--go)', () => {
  it('stays its own colour: the ready family does not borrow it, and it does not mean ready', () => {
    expect(tokenValue('--ready')).not.toBe(tokenValue('--go'));
    expect(tokenValue('--ready')).not.toBe(tokenValue('--go-strong'));
  });

  it('is actually green — not the teal that read as blue', () => {
    for (const name of ['--go', '--go-strong']) {
      const { hue, chroma } = hueOf(tokenValue(name));
      // Green sits roughly 90°–165°; the rejected --success-text is ~193°.
      expect(hue, `${name} hue`).toBeGreaterThanOrEqual(90);
      expect(hue, `${name} hue`).toBeLessThanOrEqual(165);
      expect(chroma, `${name} is too grey to read as a colour`).toBeGreaterThan(0.15);
    }
    // Negative control: the teal it replaced fails the same band.
    expect(hueOf('#2f7488').hue).toBeGreaterThan(165);
  });

  it('keeps its white label at or above 4.5:1 at rest AND on hover/press', () => {
    const rest = contrast('#ffffff', tokenValue('--go'));
    const pressed = contrast('#ffffff', tokenValue('--go-strong'));
    expect(Number(rest.toFixed(2))).toBeGreaterThanOrEqual(4.5);
    expect(Number(pressed.toFixed(2))).toBeGreaterThanOrEqual(4.5);
    // Hover/press only ever darkens the fill, so contrast only rises.
    expect(pressed).toBeGreaterThan(rest);
    // The numbers the Button and index.css comments quote.
    expect(rest.toFixed(2)).toBe('5.23');
    expect(pressed.toFixed(2)).toBe('6.14');
  });

  it('is painted by the Button `go` variant only, and that variant by the halt control only', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const read = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');

    const tokenUsers = files.filter((rel) => /var\(--go(?:-strong)?\)/.test(read(rel)));
    expect(tokenUsers).toEqual(['components/design/Button.tsx']);

    const variantUsers = files.filter((rel) =>
      /buttonClass\(\s*'go'|variant=(?:"go"|\{[^}]*'go'[^}]*\})/.test(read(rel)),
    );
    expect(variantUsers).toEqual(['components/mission-control/OperatorHaltControl.tsx']);
  });
});
