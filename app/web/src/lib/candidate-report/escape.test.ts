import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { escapeHtml, reportFilename, slugForFilename } from './escape';
import { bytesToBase64, cspScriptHash, sha256Bytes } from './sha256';

describe('escapeHtml', () => {
  it('escapes every character that can open markup or leave an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml(`Tom & 'Jerry' \`x\``)).toBe('Tom &amp; &#39;Jerry&#39; &#96;x&#96;');
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain('<');
    expect(escapeHtml('</script><script>evil()</script>')).not.toMatch(/<\/?script/);
  });

  it('escapes the ampersand first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('renders null and undefined as empty and numbers as text', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(2.5)).toBe('2.5');
  });

  it('drops control characters but keeps tabs, newlines and non-Latin text', () => {
    expect(escapeHtml('a\u0000b\u0007c\u001fd')).toBe('abcd');
    expect(escapeHtml('line1\nline2\ttab')).toBe('line1\nline2\ttab');
    expect(escapeHtml('नमस्ते résumé')).toBe('नमस्ते résumé');
  });
});

describe('slugForFilename / reportFilename', () => {
  it('keeps only [a-z0-9-] and strips accents', () => {
    expect(slugForFilename('José  Núñez-O\'Brien')).toBe('jose-nunez-o-brien');
    expect(slugForFilename('../../etc/passwd')).toBe('etc-passwd');
    expect(slugForFilename('<b>Bob</b>"; rm -rf')).toBe('b-bob-b-rm-rf');
    expect(slugForFilename('日本語')).toBe('');
    expect(slugForFilename(null)).toBe('');
  });

  it('caps the slug length without a trailing dash', () => {
    const slug = slugForFilename('a'.repeat(39) + ' b'.repeat(20), 40);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('builds screening-report-<slug>-<YYYY-MM-DD>.html', () => {
    const when = new Date('2026-10-07T23:59:00.000Z');
    expect(reportFilename('Shrinidhi Handigund', 'aaaa-bbbb', when)).toBe(
      'screening-report-shrinidhi-handigund-2026-10-07.html',
    );
  });

  it('falls back to a short candidate reference, then to "candidate", never to the whole id', () => {
    const when = new Date('2026-10-07T00:00:00.000Z');
    expect(reportFilename(null, '11111111-2222-4333-8444-555555555555', when)).toBe(
      'screening-report-11111111-2026-10-07.html',
    );
    expect(reportFilename('日本語', '---', when)).toBe('screening-report-candidate-2026-10-07.html');
  });

  it('never lets a name inject path or header characters', () => {
    const name = reportFilename('a/b\\c"d\r\ne.html', 'x', new Date('2026-10-07T00:00:00.000Z'));
    expect(name).toMatch(/^screening-report-[a-z0-9-]+-2026-10-07\.html$/);
  });
});

describe('sha256 (pure) matches node crypto', () => {
  const inputs = [
    '',
    'abc',
    'The quick brown fox jumps over the lazy dog',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(1000),
    'नमस्ते 🙂 résumé',
  ];
  it.each(inputs)('hashes %j like node', (text) => {
    const expected = createHash('sha256').update(text, 'utf8').digest('base64');
    expect(bytesToBase64(sha256Bytes(text))).toBe(expected);
  });

  it('formats a CSP source expression', () => {
    expect(cspScriptHash('abc')).toBe(`'sha256-${createHash('sha256').update('abc').digest('base64')}'`);
  });

  it('base64 of large buffers matches Buffer', () => {
    const bytes = new Uint8Array(200_003).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
