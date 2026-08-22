/**
 * The child's stdout is a PROTOCOL CHANNEL, and a library was writing to it.
 *
 * WHAT WENT WRONG. `resume-parser-child.mjs` writes exactly one JSON line to
 * stdout, and the parent reads the WHOLE of stdout and `JSON.parse`s it — so a
 * single foreign byte destroys the result. `pdf.js` (bundled inside pdf-parse)
 * implements `warn()` and `info()` as `console.log('Warning: ' + msg)`, i.e.
 * to STDOUT, and its default verbosity level is `warnings`. A PDF with a stale
 * `startxref` offset is RECOVERED by pdf.js — it rebuilds the xref — but warns
 * while doing so. That warning line landed in front of the child's own valid
 * JSON, the parent's `JSON.parse` threw, and the ingestion recorded
 * `parse_bad_output`: a DOCUMENT VERDICT about a document that was never
 * judged, on a row whose real answer was sitting on the very next line.
 *
 * That is the same defect class the parse classification was written to
 * remove — our machine's problem written down as a statement about the
 * candidate's file — arriving through a different door. It is also permanent:
 * `parse_bad_output` is deliberately outside the recovery allowlist, so the
 * audited retry refuses the row for ever.
 *
 * WHAT MUST BE TRUE NOW. The console is detached from stdout before any
 * library can run, so stdout carries the protocol line and nothing else, and
 * the child's TRUE stable code survives.
 *
 * The fixture is a fully synthetic ~590-byte PDF built here in the test, byte
 * by byte, containing the literal word SYNTHETIC. No candidate document, no
 * resume text, and no binary fixture is committed — the corrupted variant
 * differs from the valid one ONLY in the `startxref` offset, which is what
 * makes the warning deterministic.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('../lib/resume-parser-child.mjs', import.meta.url));

/** A minimal, valid, entirely synthetic PDF. */
function buildSyntheticPdf(): string {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R '
    + '/Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = 'BT /F1 12 Tf 20 100 Td (SYNTHETIC) Tj ET';
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/**
 * The ONLY difference from the valid document: a `startxref` offset that does
 * not point at the xref table. pdf.js recovers by rebuilding the index — and
 * warns while doing it, which is the condition under test.
 */
function withStaleStartxref(pdf: string): string {
  const corrupted = pdf.replace(/startxref\n\d+/, 'startxref\n999999');
  expect(corrupted).not.toEqual(pdf);
  return corrupted;
}

interface ChildRun { stdout: string; stderr: string; code: number | null }

function runChild(body: string, mime = 'application/pdf'): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, mime, '26214400', '50000'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(Buffer.from(body, 'latin1'));
    child.stdin.end();
  });
}

const nonEmptyLines = (s: string): string[] => s.split('\n').filter((l) => l.trim().length > 0);

describe('resume parser child — stdout is the protocol channel and nothing else', () => {
  it('a warning-triggering PDF still yields exactly ONE parseable stdout line', async () => {
    const { stdout, code } = await runChild(withStaleStartxref(buildSyntheticPdf()));

    // The regression: this was TWO lines, the first of them `Warning: …`.
    expect(nonEmptyLines(stdout)).toHaveLength(1);

    // And the parent's exact operation — parse the WHOLE of stdout — succeeds.
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
    expect(code).toBe(0);
  }, 30_000);

  it('delivers the child\'s TRUE stable code, never a stdout-corruption artefact', async () => {
    const { stdout } = await runChild(withStaleStartxref(buildSyntheticPdf()));
    const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; error?: string };

    // Whatever the document turns out to be, the answer is the child's own —
    // one of its fixed literals — and never a verdict invented by a broken
    // channel. Before the fix the parent saw non-JSON and raised `bad_output`,
    // which the ingestion recorded as the document verdict `parse_bad_output`.
    if (parsed.ok === true) {
      expect(typeof (parsed as { text?: unknown }).text).toBe('string');
    } else {
      expect(['EXTRACT_FAILED', 'UNSUPPORTED_MIME', 'EMPTY_INPUT', 'INPUT_OVERFLOW', 'NO_MIME'])
        .toContain(parsed.error);
    }
  }, 30_000);

  it('routes the library diagnostic to stderr, which the parent drains and discards', async () => {
    const { stderr } = await runChild(withStaleStartxref(buildSyntheticPdf()));
    // Present, so a human running the child by hand still sees it; on stderr,
    // so it cannot reach the protocol channel. The parent never stores it.
    expect(stderr.length).toBeGreaterThan(0);
  }, 30_000);

  it('leaves the VALID document untouched — one line, one JSON object', async () => {
    const { stdout, code } = await runChild(buildSyntheticPdf());
    expect(nonEmptyLines(stdout)).toHaveLength(1);
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
    expect(code).toBe(0);
  }, 30_000);

  it('still emits a single stable line for a non-PDF mime', async () => {
    const { stdout } = await runChild('plain text resume placeholder', 'text/plain');
    expect(nonEmptyLines(stdout)).toHaveLength(1);
    const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; text?: string };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.text).toBe('string');
  }, 30_000);
});
