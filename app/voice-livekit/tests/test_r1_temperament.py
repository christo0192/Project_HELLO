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


class TemperamentPlanTests(unittest.TestCase):
    def test_plans_are_deterministic_and_ordered(self):
        from r1_temperament import TEMPERAMENTS, plan_families

        for temperament in TEMPERAMENTS:
            minutes = dict(temperament.family_minutes)
            for index in range(100):
                plan = plan_families(temperament, str(index))
                self.assertEqual(plan, plan_families(temperament, str(index)))
                self.assertIn(len(plan), (2, 3, 4))
                self.assertEqual(plan[-1], "F4")
                self.assertEqual(len(plan), len(set(plan)))
                self.assertEqual(list(plan[:-1]), sorted(
                    plan[:-1],
                    key=lambda family: (minutes[family], ("F3", "F2", "F1").index(family))
                ))

    def test_minutes_from_evidence(self):
        for temperament in temp.TEMPERAMENTS:
            mix = EVIDENCE[temperament.id]["objection_mix"].values()
            for family, minute in temperament.family_minutes:
                theme = max((item for item in mix if item["r1_family"] == family),
                            key=lambda item: item["rate_per_lead"])
                self.assertAlmostEqual(minute, theme["median_minute"], delta=0.05)

    def test_distribution_matches_weighted_draws(self):
        import itertools

        for temperament in temp.TEMPERAMENTS:
            weights = dict(temperament.family_weights)
            expected = {family: 0.0 for family in weights}
            for count, count_weight in temperament.count_weights:
                for order in itertools.permutations(weights, count - 1):
                    probability = count_weight
                    remaining = sum(weights.values())
                    for family in order:
                        probability *= weights[family] / remaining
                        remaining -= weights[family]
                    for family in order:
                        expected[family] += probability
            plans = [temp.plan_families(temperament, str(i)) for i in range(10000)]
            for count, weight in temperament.count_weights:
                self.assertAlmostEqual(sum(len(plan) == count for plan in plans) / len(plans),
                                       weight, delta=0.02)
            for family, probability in expected.items():
                self.assertAlmostEqual(sum(family in plan for plan in plans) / len(plans),
                                       probability, delta=0.03)


class ThemePickTests(unittest.TestCase):
    def test_pick_is_deterministic_and_weighted(self):
        for temperament in temp.TEMPERAMENTS:
            for family, weights in temperament.theme_weights:
                picks = [dict(temp.pick_themes(temperament, str(i), (family,)))[family]
                         for i in range(10000)]
                self.assertAlmostEqual(picks.count(weights[0][0]) / len(picks),
                                       weights[0][1] / sum(w for _, w in weights), delta=0.02)
                self.assertEqual(temp.pick_themes(temperament, "x", (family,)),
                                 temp.pick_themes(temperament, "x", (family,)))

    def test_deep_evaluator_f3_picks_both_top_themes(self):
        temperament = next(t for t in temp.TEMPERAMENTS if t.id == "deep_evaluator")
        picks = {dict(temp.pick_themes(temperament, str(seed), ("F3",)))["F3"]
                 for seed in range(200)}
        self.assertEqual(picks, {"pays_off", "confirm_fit"})

    def test_weights_follow_evidence(self):
        from r1_scheduler import OBJECTION_THEMES
        names = {
            "Considering Alternatives": "alternatives",
            "Doubts the Program Will Pay Off": "pays_off",
            "Needs to Confirm Fit First": "confirm_fit",
            "Teaching Format or Pace Concern": "format_pace",
            "Distrust of the company or advisor": "trust",
            "Program Schedule Does Not Fit": "schedule",
            "Unavailable for the Next Step Now": "unavailable_now",
            "Fee Feels Too High": "fee_high",
            "Can't Afford It Right Now": "cannot_afford",
            "Wants Time to Decide": "wants_time",
            "No current need": "no_need",
            "Needs Family Approval": "family_approval",
        }
        for temperament in temp.TEMPERAMENTS:
            mix = EVIDENCE[temperament.id]["objection_mix"]
            for family, weights in temperament.theme_weights:
                ranked = sorted(((names[name], item["rate_per_lead"])
                                 for name, item in mix.items()
                                 if name in names and item["r1_family"] == family),
                                key=lambda item: item[1], reverse=True)[:2]
                self.assertEqual([x[0] for x in weights], [x[0] for x in ranked])
                for (ident, rate), (_, expected) in zip(weights, ranked):
                    self.assertIn((family, ident), OBJECTION_THEMES)
                    self.assertAlmostEqual(rate, expected, delta=0.0005)
