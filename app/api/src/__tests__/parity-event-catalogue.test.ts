import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_NAMES_SET } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_PATH = path.join(__dirname, '../../../voice-livekit/observability.py');

/**
 * Parse a Python `frozenset({...})` / `frozenset([...])` literal anchored on the
 * exact declaration marker. Deterministic and fail-closed: throws when the
 * anchor is missing, the open/close delimiters are malformed, or the file is
 * unreadable (read by the caller). Comment lines (`#`) are stripped before
 * literal extraction so comment-like decoys never parse as members.
 */
function parsePySet(content: string, anchor: string): Set<string> {
  const i = content.indexOf(anchor);
  if (i === -1) throw new Error('Anchor missing');
  let p = i + anchor.length;
  while (p < content.length && /\s/.test(content[p])) p++;
  const open = content[p];
  if (open !== '{' && open !== '[') throw new Error('Bad open char');
  const close = open === '{' ? '})' : '])';
  const e = content.indexOf(close, p);
  if (e === -1) throw new Error('Close missing');
  const block = content.slice(p + 1, e);
  const s = new Set<string>();
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#')) continue;
    for (const m of line.match(/"([^"]*)"/g) || []) s.add(m.slice(1, -1));
  }
  return s;
}

const ALLOWED_EVENTS_ANCHOR = '_ALLOWED_EVENTS: frozenset[str] = frozenset(';

describe('parity-event-catalogue', () => {
  const src = fs.readFileSync(PY_PATH, 'utf-8');
  const parsed = parsePySet(src, ALLOWED_EVENTS_ANCHOR);

  it('parses the Python _ALLOWED_EVENTS block', () => {
    expect(parsed.size).toBeGreaterThan(0);
  });

  it('Python _ALLOWED_EVENTS mirrors TS EVENT_NAMES_SET exactly', () => {
    expect(parsed).toEqual(EVENT_NAMES_SET);
  });

  it('control: parser detects a missing member', () => {
    const mod = src.replace('"startup_listen",', '');
    expect(parsePySet(mod, ALLOWED_EVENTS_ANCHOR)).not.toEqual(parsed);
  });

  it('control: parser detects an extra member', () => {
    const i = src.indexOf(ALLOWED_EVENTS_ANCHOR);
    const j = src.indexOf('})', i);
    const mod = src.slice(0, j) + '"zzz_fake_extra",\n' + src.slice(j);
    const p = parsePySet(mod, ALLOWED_EVENTS_ANCHOR);
    expect(p).toContain('zzz_fake_extra');
    expect(p.size).toBe(parsed.size + 1);
  });

  it('control: comment-like decoy inside the block is not parsed as a member', () => {
    const i = src.indexOf(ALLOWED_EVENTS_ANCHOR);
    const j = src.indexOf('})', i);
    const mod = src.slice(0, j) + '# "fake_decoy",\n' + src.slice(j);
    const p = parsePySet(mod, ALLOWED_EVENTS_ANCHOR);
    expect(p).not.toContain('fake_decoy');
    expect(p).toEqual(parsed);
  });

  it('control: fails closed when the anchor is absent', () => {
    const mod = src.replace('_ALLOWED_EVENTS', 'X');
    expect(() => parsePySet(mod, ALLOWED_EVENTS_ANCHOR)).toThrow();
  });

  it('control: equality assertion is non-vacuous', () => {
    const m = new Set(parsed);
    m.delete('startup_listen');
    expect(m).not.toEqual(EVENT_NAMES_SET);
  });
});
