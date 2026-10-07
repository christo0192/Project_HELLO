"""Operator-run replay of the real S0-B advisor turns against ``r1_tracker.invented_offer_in``.

Not part of CI: the 1,278-turn S0-B full-run jsonl is not committed, so this module sits outside
the ``test_r1_*`` pattern (CI's discover step and the skip-guarded R1 steps never load it, and a
conditional skip cannot hide an import break there). Run it by hand:

    R1_S0B_RESULTS=/path/to/s0b-full-run.jsonl python -m unittest tests.replay_r1_s0b -v
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from r1_tracker import invented_offer_in  # noqa: E402


@unittest.skipUnless(
    os.environ.get("R1_S0B_RESULTS"),
    "set R1_S0B_RESULTS to the S0-B full-run jsonl to replay the real transcripts",
)
class S0BReplayTests(unittest.TestCase):
    """Opt-in replay of the 1,278 real S0-B advisor turns (not committed to this branch)."""

    def test_no_real_disclaimer_turn_is_flagged_as_an_invented_offer(self):
        rows = [
            json.loads(line)
            for line in Path(os.environ["R1_S0B_RESULTS"]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertGreater(len(rows), 1000)
        flagged = [row["advisor_text"] for row in rows if invented_offer_in(row["advisor_text"])]
        self.assertEqual(flagged, [])


if __name__ == "__main__":
    unittest.main()
