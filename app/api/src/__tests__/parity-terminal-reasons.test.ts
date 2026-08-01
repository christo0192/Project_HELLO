import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: () => { throw new Error('unused') } },
}));

import { VALID_REASONS_FOR_STATUS } from '../lib/session-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_PATH = path.join(__dirname, '../../../voice-livekit/persistence.py');

const STATUS_KEYS = ['failed', 'cancelled', 'expired', 'completed'] as const;

/**
 * Parse the four Python terminal-reason frozensets (`_<STATUS>_REASONS:
 * frozenset([...])`). Deterministic and fail-closed: throws when an anchor is
 * missing or the list delimiters are malformed. The list ends at the FIRST `]`
 * after the open bracket (lists never nest), so the NOTE comment that follows
 * `_COMPLETED_REASONS` and the later `_NON_TERMINAL_STATUSES` block can never
 * leak members into a set. Comment lines (`#`) are stripped before literal
 * extraction.
 */
function parsePyReasons(content: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const s of STATUS_KEYS) {
    const anchor = `_${s.toUpperCase()}_REASONS: frozenset[str] = frozenset(`;
    const i = content.indexOf(anchor);
    if (i === -1) throw new Error(`Anchor ${s} missing`);
    let p = i + anchor.length;
    while (p < content.length && /\s/.test(content[p])) p++;
    const open = content[p];
    if (open !== '[' && open !== '{') throw new Error(`Bad open ${s}`);
    const closeCh = open === '[' ? ']' : '}';
    const e = content.indexOf(closeCh, p);
    if (e === -1) throw new Error(`Close ${s} missing`);
    const block = content.slice(p + 1, e);
    const set = new Set<string>();
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      for (const m of line.match(/"([^"]*)"/g) || []) set.add(m.slice(1, -1));
    }
    out[s] = set;
  }
  return out;
}

describe('parity-terminal-reasons', () => {
  const src = fs.readFileSync(PY_PATH, 'utf-8');
  const parsed = parsePyReasons(src);

  it('parses all four Python reason sets', () => {
    for (const k of STATUS_KEYS) expect(parsed[k].size).toBeGreaterThan(0);
  });

  it('Python reason frozensets mirror TS VALID_REASONS_FOR_STATUS per terminal status', () => {
    for (const k of STATUS_KEYS) {
      expect(parsed[k]).toEqual(VALID_REASONS_FOR_STATUS[k as keyof typeof VALID_REASONS_FOR_STATUS]);
    }
  });

  it('invariant: legacy_unknown is absent from every runtime TS set', () => {
    for (const s of Object.values(VALID_REASONS_FOR_STATUS)) {
      expect(s).not.toContain('legacy_unknown');
    }
  });

  it('control: parser detects a missing reason', () => {
    const mod = src.replace('"room_create_error",', '');
    expect(parsePyReasons(mod).failed).not.toEqual(parsed.failed);
  });

  it('control: parser detects an extra reason', () => {
    const listAnchor = '_FAILED_REASONS: frozenset[str] = frozenset([';
    const i = src.indexOf(listAnchor);
    // The list's opening '[' is the LAST char of the anchor; the ']' inside
    // `frozenset[str]` precedes it, so search from the list open onward.
    const j = src.indexOf(']', i + listAnchor.length - 1);
    const mod = src.slice(0, j) + ',"extra_fake"' + src.slice(j);
    expect(parsePyReasons(mod).failed).toContain('extra_fake');
  });

  it('control: comment-like decoy inside the block is not parsed as a reason', () => {
    const listAnchor = '_FAILED_REASONS: frozenset[str] = frozenset([';
    const i = src.indexOf(listAnchor);
    // The list's opening '[' is the LAST char of the anchor; the ']' inside
    // `frozenset[str]` precedes it, so search from the list open onward.
    const j = src.indexOf(']', i + listAnchor.length - 1);
    const mod = src.slice(0, j) + '\n        # "decoy_fake",' + src.slice(j);
    const p = parsePyReasons(mod);
    expect(p.failed).not.toContain('decoy_fake');
    expect(p.failed).toEqual(parsed.failed);
  });

  it('control: fails closed when an anchor is absent', () => {
    const mod = src.replace('_FAILED_REASONS', 'X');
    expect(() => parsePyReasons(mod)).toThrow();
  });

  it('control: equality assertion is non-vacuous', () => {
    const m = new Set(parsed.failed);
    m.delete('room_create_error');
    expect(m).not.toEqual(VALID_REASONS_FOR_STATUS.failed);
  });
});
