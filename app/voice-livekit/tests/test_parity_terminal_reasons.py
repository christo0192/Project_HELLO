"""Parity: the Python terminal-reason frozensets in persistence.py
(_FAILED_REASONS, _CANCELLED_REASONS, _EXPIRED_REASONS, _COMPLETED_REASONS) must
mirror the TypeScript VALID_REASONS_FOR_STATUS in
app/api/src/lib/session-lifecycle.ts exactly, per terminal status.

The TS source is parsed from disk at test time with an anchored, deterministic,
fail-closed parser using brace matching for the object body and `new Set([...])`
member extraction per status key. TS line comments are stripped before literal
extraction so comment-like decoys never parse as reasons. Negative controls
prove missing/extra members and decoys are detected, and that the equality
assertions are non-vacuous. `legacy_unknown` must be absent from all four
runtime Python frozensets (migration-only). No production files are modified.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from persistence import (  # noqa: E402
    _FAILED_REASONS,
    _CANCELLED_REASONS,
    _EXPIRED_REASONS,
    _COMPLETED_REASONS,
)

TS_PATH = os.path.join(os.path.dirname(__file__), '../../api/src/lib/session-lifecycle.ts')

STATUS_MAP = {
    'completed': _COMPLETED_REASONS,
    'failed': _FAILED_REASONS,
    'cancelled': _CANCELLED_REASONS,
    'expired': _EXPIRED_REASONS,
}


def parse_ts_reasons(content: str) -> dict[str, set[str]]:
    """Extract per-status reason sets from the TS VALID_REASONS_FOR_STATUS block.

    Fail-closed: raises ValueError when the declaration anchor, the object open
    brace, the closing `};`, or any per-status `key: new Set([...])` is
    missing/malformed. Brace matching scopes the block; TS line comments are
    stripped before literal extraction.
    """
    a = content.find('export const VALID_REASONS_FOR_STATUS')
    if a == -1:
        raise ValueError('Anchor missing')
    b = content.find('{', content.find('=', a))
    if b == -1:
        raise ValueError('Open brace missing')
    depth = 0
    end = -1
    for i, ch in enumerate(content[b:], start=b):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and content[i + 1] == ';':
                end = i
                break
    if end == -1:
        raise ValueError('Close brace missing')
    block = content[b + 1:end]
    # Strip TS line comments (whole-line and inline //-to-EOL) so
    # comment-like decoys never parse as reasons.
    block = '\n'.join(
        ln.split('//')[0]
        for ln in block.split('\n')
        if not ln.strip().startswith('//')
    )
    out: dict[str, set[str]] = {}
    for st in STATUS_MAP.keys():
        m = re.search(rf'{st}:\s*new\s+Set\(', block)
        if not m:
            raise ValueError(f'Status {st} missing')
        s = block.find('[', m.end())
        e = block.find(']', s)
        if s == -1 or e == -1:
            raise ValueError(f'Brackets missing for {st}')
        out[st] = set(re.findall(r"'([^']*)'", block[s + 1:e]))
    return out


class TestParityTerminalReasons(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TS_PATH, 'r', encoding='utf-8') as f:
            cls.src = f.read()
        cls.parsed = parse_ts_reasons(cls.src)

    def test_parse_is_non_empty(self):
        for st, py_set in STATUS_MAP.items():
            self.assertGreater(len(self.parsed[st]), 0, st)
            self.assertGreater(len(py_set), 0, st)

    def test_parity_per_status(self):
        for st, py_set in STATUS_MAP.items():
            self.assertEqual(self.parsed[st], set(py_set), st)

    def test_invariant_no_legacy_unknown_in_python_sets(self):
        for st, py_set in STATUS_MAP.items():
            self.assertNotIn('legacy_unknown', py_set, st)

    def test_control_missing_reason_detected(self):
        mod = self.src.replace("'room_create_error',", '')
        p = parse_ts_reasons(mod)
        self.assertNotEqual(p['failed'], self.parsed['failed'])

    def test_control_extra_reason_detected(self):
        mod = self.src.replace(
            "failed: new Set(['room_create_error',",
            "failed: new Set(['zzz_extra','room_create_error',"
        )
        p = parse_ts_reasons(mod)
        self.assertIn('zzz_extra', p['failed'])

    def test_control_comment_decoy_ignored(self):
        mod = self.src.replace(
            "failed: new Set(['room_create_error',",
            "failed: new Set([// 'decoy',\n'room_create_error',"
        )
        p = parse_ts_reasons(mod)
        self.assertNotIn('decoy', p['failed'])
        self.assertEqual(p['failed'], self.parsed['failed'])

    def test_control_fail_closed_on_missing_anchor(self):
        mod = self.src.replace('VALID_REASONS_FOR_STATUS', 'X')
        with self.assertRaises(ValueError):
            parse_ts_reasons(mod)

    def test_control_non_vacuous_assertion(self):
        m = set(self.parsed['failed'])
        m.discard('room_create_error')
        self.assertNotEqual(m, set(_FAILED_REASONS))


if __name__ == '__main__':
    unittest.main()
