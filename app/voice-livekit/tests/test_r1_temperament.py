"""Evidence and rollback tests for learner temperaments."""
import ast
import hashlib
import json
import re
import unittest
from pathlib import Path

import r1_temperament as temp
from r1_commitment import Level
from r1_personas import PERSONAS, deep_need_topics_in, resolve_persona
from tests.test_r1_learner_evidence import SOURCE, GENERIC_LEAK, corpus_strings, grams
from rehearsal.evidence.build_learner_evidence import load_app_data

HERE = Path(__file__).resolve().parents[1]
EVIDENCE = json.loads((HERE / "rehearsal/evidence/learner_evidence.json").read_text(
    encoding="utf-8"))["behaviour_types"]


class TemperamentTests(unittest.TestCase):
    def test_evidence(self):
        self.assertAlmostEqual(sum(t.weight for t in temp.TEMPERAMENTS), 1)
        shares = sum(v["share"] for k, v in EVIDENCE.items() if k != "disengaged")
        self.assertNotIn("disengaged", temp.TEMPERAMENT_BY_ID)
        for t in temp.TEMPERAMENTS:
            data = EVIDENCE[t.id]
            self.assertAlmostEqual(t.weight, data["share"] / shares, delta=0.01)
            rates = {f: sum(x["rate_per_lead"] for x in data["objection_mix"].values()
                            if x["r1_family"] == f) for f in ("F1", "F2", "F3")}
            self.assertEqual([f for f, _ in t.family_weights],
                             sorted(rates, key=rates.get, reverse=True))
            for f, w in t.family_weights:
                self.assertAlmostEqual(w, rates[f], delta=0.01)
            self.assertAlmostEqual(sum(w for _, w in t.count_weights), 1)
            self.assertTrue(all(2 <= n <= 4 for n, _ in t.count_weights))
            # The median is within the clipped quartiles even when a tail reaches three.
            cumulative = 0
            for n, w in sorted(t.count_weights):
                cumulative += w
                if cumulative >= 0.5:
                    break
            quartiles = data["objections_per_lead"]
            self.assertGreaterEqual(n, max(2, quartiles["p25"]))
            self.assertLessEqual(n, min(4, quartiles["p75"]))
            self.assertEqual(t.enrol_ceiling, Level.MEDIUM if t.id == "time_blocked"
                             else Level.STRONG)
            self.assertEqual(t.stall_rounds, 1 if t.id == "deep_evaluator" else 2)
            themes = {"family_approval": ["Needs Family Approval"],
                      "wants_time": ["Wants Time to Decide"],
                      "wants_time_or_no_need": ["Wants Time to Decide", "No current need"]}
            self.assertTrue(all(data["objection_mix"][name]["r1_family"] == "F4"
                                for name in themes[t.f4_theme]))
            hash(t)
            hash(resolve_persona(PERSONAS[0].id, temperament_on=True, temperament=t.id))
        self.assertEqual(min((EVIDENCE[t.id]["enrol_rate"], t.id)
                             for t in temp.TEMPERAMENTS)[1], "time_blocked")

    def test_pick(self):
        first = temp.pick_temperament("p", "seed")
        self.assertEqual(first, temp.pick_temperament("p", "seed"))
        self.assertEqual(first, temp.pick_temperament("p", "seed", "unknown"))
        self.assertEqual(temp.pick_temperament("p", "seed", "time_blocked").id, "time_blocked")
        picks = [temp.pick_temperament("p", f"seed-{i}").id for i in range(10000)]
        for t in temp.TEMPERAMENTS:
            self.assertAlmostEqual(picks.count(t.id) / len(picks), t.weight, delta=0.02)

    def test_imports_and_privacy(self):
        tree = ast.parse((HERE / "r1_temperament.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = ([n.name for n in node.names] if isinstance(node, ast.Import)
                         else [node.module or ""])
                self.assertFalse(any(n.startswith(("rehearsal", "r1_personas")) for n in names))
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                self.assertIsNone(GENERIC_LEAK.search(node.value))
        source = SOURCE / "app" / "data_3m.js"
        if not source.is_file():
            return
        corpus = {g for s in corpus_strings(load_app_data(source)) for g in grams(s)}
        for t in temp.TEMPERAMENTS:
            for s in (t.card_line, t.timeline_answer, *(v for _, v in t.family_themes)):
                self.assertFalse(set(grams(s)) & corpus)

    def test_cards_and_rollback(self):
        cards = []
        banned = re.compile(r"\b(?:weeks?|months?|price|cohort|hours|discount|instalment|emi|"
                            r"refund|guarantee|scholarship)\b|\d|\$", re.I)
        for p in PERSONAS:
            for v in p.variants:
                for probe in (False, True):
                    for timeline in (False, True):
                        off = resolve_persona(p.id, variant=v.id, temperament="time_blocked")
                        self.assertIsNone(off.temperament)
                        cards.append(off.public_card_text(probe_first=probe, timeline_v2=timeline))
                        for t in temp.TEMPERAMENTS:
                            rendered = resolve_persona(p.id, variant=v.id, temperament_on=True,
                                                       temperament=t.id)
                            self.assertEqual(rendered.temperament, t)
                            card = rendered.public_card_text(
                                probe_first=probe, timeline_v2=timeline)
                            self.assertEqual(card.count(temp.CARD_LINE_PREFIX), 1)
                            self.assertIn(t.timeline_answer, card)
                            self.assertNotIn("Within a couple of weeks.", card)
                            for text in (t.card_line, t.timeline_answer):
                                self.assertIsNone(banned.search(text))
                                self.assertFalse(deep_need_topics_in(rendered, text))
                                for topic in ("H1", "H2", "H3"):
                                    self.assertFalse(any(marker.search(text)
                                                         for marker in rendered.markers(topic)))
        self.assertEqual(hashlib.sha256("\0".join(cards).encode()).hexdigest(),
                         "1036dc4ba0d1522bebe8bfd374d0e10876c5e6c725ab38da38a081544729351f")
        p = PERSONAS[0].id
        self.assertEqual(resolve_persona(p, seed="s", temperament_on=True).temperament,
                         temp.pick_temperament(p, "s"))
