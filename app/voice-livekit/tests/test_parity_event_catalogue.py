"""Parity: Python observability._ALLOWED_EVENTS must mirror the TypeScript
runtime event catalogue exactly (app/api/src/lib/logger.ts EVENT_NAMES_SET).

The TS source is parsed from disk at test time with an anchored, deterministic,
fail-closed parser: comment lines are stripped before literal extraction, and a
missing/malformed anchor raises instead of silently passing. Negative controls
prove the parser detects missing/extra members and ignores comment-like decoys,
and that the equality assertion itself is non-vacuous. No production files are
ever modified (controls mutate in-memory strings only).
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from observability import _ALLOWED_EVENTS  # noqa: E402

TS_PATH = os.path.join(os.path.dirname(__file__), '../../api/src/lib/logger.ts')

EVENT_ANCHOR = "export const EVENT_NAMES_SET = new Set<string>(["


def parse_ts_set(content: str, anchor: str) -> set[str]:
    """Extract the string members of a TS `new Set<string>([...]);` literal.

    Fail-closed: raises ValueError when the anchor or the closing `]);` is
    missing/malformed. Comment lines (`//`, `/*`, `*`) are stripped before
    literal extraction so comment-like decoys never parse as members.
    """
    i = content.find(anchor)
    if i == -1:
        raise ValueError('Anchor missing')
    s = i + len(anchor)
    e = content.find(']);', s)
    if e == -1:
        raise ValueError('Close missing')
    block = content[s:e]
    res: set[str] = set()
    for line in block.split('\n'):
        t = line.strip()
        if t.startswith('//') or t.startswith('/*') or t.startswith('*'):
            continue
        for m in re.findall(r"'([^']*)'", line):
            res.add(m)
    return res


class TestParityEventCatalogue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TS_PATH, 'r', encoding='utf-8') as f:
            cls.src = f.read()
        cls.parsed = parse_ts_set(cls.src, EVENT_ANCHOR)

    def test_parse_is_non_empty(self):
        self.assertGreater(len(self.parsed), 0)

    def test_parity_python_mirrors_ts(self):
        self.assertEqual(self.parsed, set(_ALLOWED_EVENTS))

    def test_control_missing_member_detected(self):
        mod = self.src.replace("'startup_listen',", '')
        p = parse_ts_set(mod, EVENT_ANCHOR)
        self.assertNotEqual(p, self.parsed)

    def test_control_extra_member_detected(self):
        i = self.src.find(EVENT_ANCHOR)
        j = self.src.find(']);', i)
        mod = self.src[:j] + "'zzz_fake_extra',\n" + self.src[j:]
        p = parse_ts_set(mod, EVENT_ANCHOR)
        self.assertIn('zzz_fake_extra', p)
        self.assertEqual(len(p), len(self.parsed) + 1)

    def test_control_comment_decoy_ignored(self):
        i = self.src.find(EVENT_ANCHOR)
        j = self.src.find(']);', i)
        mod = self.src[:j] + "// 'fake_decoy',\n" + self.src[j:]
        p = parse_ts_set(mod, EVENT_ANCHOR)
        self.assertNotIn('fake_decoy', p)
        self.assertEqual(p, self.parsed)

    def test_control_fail_closed_on_missing_anchor(self):
        mod = self.src.replace('EVENT_NAMES_SET', 'XEVENT_NAMES_SET')
        with self.assertRaises(ValueError):
            parse_ts_set(mod, EVENT_ANCHOR)

    def test_control_non_vacuous_assertion(self):
        m = set(self.parsed)
        m.discard('startup_listen')
        self.assertNotEqual(m, set(_ALLOWED_EVENTS))


if __name__ == '__main__':
    unittest.main()
