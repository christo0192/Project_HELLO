"""The advisor-utterance corpus: every lexical detector of the learner engine, scored against labels.

R1-Q iteration 1.  The detectors that read the advisor's words (``r1_commitment.ask_acts``,
``r1_negotiation.detect_callback`` / ``detect_email_offer`` / ``parse_price_offers`` and
``r1_scheduler.is_close_attempt``) were patched case by case, and each fix broke another phrasing.
This module stops that: ``tests/fixtures/r1_advisor_corpus.jsonl`` holds labelled advisor turns and the
detectors are scored against it, per detector, with precision and recall.

Corpus entry: ``{id, text, labels, phase_hint, source}``.

* ``labels.price_offer``     the lowest net price the turn puts on the table (a whole dollar amount), or null.
* ``labels.call_proposal``   the advisor proposes (or asks about) a call, a time or a follow-up with THIS
                             learner.  A description of the programme ("you can book a slot with a mentor
                             every week", "we arrange a coaching session in the third month") is not one.
* ``labels.email_offer``     the advisor offers to e-mail or send information ("I'll email you the details").
* ``labels.enrol_ask``       the advisor asks the learner to enrol, pay or reserve a seat or a batch slot
                             ("shall I send the payment link?", "want me to hold a spot?").  Offering to
                             e-mail the curriculum is an e-mail offer, not an enrolment ask.
* ``labels.pitch_only``      the turn describes the programme and does nothing else (derived: no ask, offer,
                             price or farewell); the test checks that no detector fires on it.
* ``labels.farewell``        the turn ends the call (the scheduler's ``is_close_attempt`` at R = 5:45).
* ``labels.anchor_reply``    the turn answers the learner's $7,000 anchor with a price or a refusal.

A label of ``null`` means "not scored" (a confirmation of a call the learner already agreed to).
``phase_hint`` is ``pre_anchor`` (an amount needs a pricing word), ``post_anchor`` or ``any`` (read as
post-anchor).  ``source`` says where the label comes from: ``review:`` / ``iter1:`` / ``iter2:`` are the phrasings of the
review and verify rounds and of this iteration's live-sweep findings, ``owner:`` the real advisor turns of the
owner's test, ``sim:`` the advisor simulator's turns of the live sweeps (its own {intent, topic} JSON is the
ground truth for the label; the ambiguous ones were checked by hand).

Held-out set (R1-Q final review round 1): the tuned corpus above is built from the phrasings the detectors
were tuned on, so its 1.000 says nothing about wording the engine has not met.
``tests/fixtures/r1_advisor_heldout.jsonl`` holds fresh phrasings that were never used to tune a detector;
``HeldOutCorpusTests`` reports their recall and precision and holds recall floors (a miss there is reported,
never patched in on its own).

Targets: 100 % on the hand-labelled review cases, and at least 95 % recall and 98 % precision on the
simulator-labelled set for the proposals and offers.  A labelled case that passes may never fail again; a case
the detectors still get wrong is listed in ``KNOWN_FAILURES`` with the reason, and the list may only shrink
(``test_known_failures_still_fail`` fails when one starts to pass, so the entry is removed).
"""
from __future__ import annotations

import json
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from r1_negotiation import AdvisorActs, read_advisor_turn

CORPUS_PATH = HERE / "tests" / "fixtures" / "r1_advisor_corpus.jsonl"
HAND_PREFIXES = ("review:", "iter1:", "iter2:", "owner:")
SIM_PREFIX = "sim:"
RECALL_FLOOR = 0.95
PRECISION_FLOOR = 0.98
LABEL_KEYS = (
    "price_offer",
    "call_proposal",
    "email_offer",
    "enrol_ask",
    "pitch_only",
    "farewell",
    "anchor_reply",
)

# A labelled case the detectors still get wrong (id -> detector names, with the reason in the comment).
# The list may only shrink.
#
# Ship-gate round 1 (owner decision 2026-10-09, "ship what is proven better than main"): the two
# enrolment asks below say "send it so you can decide together / you and your dad can review it".
# The same words are the advisor sending information in 5 of 7 fresh sentences ("I'll send everything
# over so you can decide with your husband": an unearned scripted STRONG), and main reads none of the
# seven, so the pronoun rule keeps only the acting verbs (sign, enrol, lock, pay, reserve, secure).
# Both turns are missed on main as well: an accepted miss, not a regression.
KNOWN_FAILURES: dict[str, frozenset[str]] = {
    "c0716": frozenset({"enrol_ask"}),
    "c0719": frozenset({"enrol_ask"}),
}


@dataclass(frozen=True)
class Detector:
    """One scored detector: the label it is compared with and how the engine's reading answers it."""

    name: str
    label: str
    predict: Callable[[dict, AdvisorActs], object]
    proposals: bool = True  # scored against the 95 % / 98 % floors on the simulator set


def _price(entry: dict, acts: AdvisorActs) -> object:
    return acts.best_offer_usd


DETECTORS: tuple[Detector, ...] = (
    Detector("call_proposal", "call_proposal", lambda e, a: a.call),
    Detector("email_offer", "email_offer", lambda e, a: a.email_offer),
    Detector("enrol_ask", "enrol_ask", lambda e, a: a.enrol),
    Detector("price_offer", "price_offer", _price),
    Detector("farewell", "farewell", lambda e, a: a.close_attempt, proposals=False),
    Detector("anchor_reply", "anchor_reply", lambda e, a: a.price_answer, proposals=False),
)


def load_corpus() -> list[dict]:
    entries = []
    with CORPUS_PATH.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                entries.append(json.loads(line))
    return entries


def read(entry: dict) -> AdvisorActs:
    after_anchor = entry["phase_hint"] != "pre_anchor"
    return read_advisor_turn(entry["text"], after_anchor=after_anchor)


def outcome(entry: dict, acts: AdvisorActs, detector: Detector) -> str | None:
    """``tp`` / ``fp`` / ``fn`` / ``tn`` of ``detector`` on ``entry``, or None when the label is unscored."""
    label = entry["labels"][detector.label]
    predicted = detector.predict(entry, acts)
    if detector.label == "price_offer":  # null is a real label here: no price on the table
        if label is None and predicted is None:
            return "tn"
        if label is not None and predicted == label:
            return "tp"
        if label is None:
            return "fp"
        return "fn" if predicted is None else "fp+fn"
    if label is None:
        return None
    if detector.label == "anchor_reply" and entry["phase_hint"] == "pre_anchor":
        return None  # nobody has anchored yet, so nothing answers it
    if label and predicted:
        return "tp"
    if label and not predicted:
        return "fn"
    if not label and predicted:
        return "fp"
    return "tn"


def is_hand(entry: dict) -> bool:
    return entry["source"].startswith(HAND_PREFIXES)


def is_sim(entry: dict) -> bool:
    return entry["source"].startswith(SIM_PREFIX)


@dataclass
class Score:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0

    def add(self, result: str) -> None:
        if result == "fp+fn":  # a wrong price: one false positive and one miss
            self.fp += 1
            self.fn += 1
        else:
            setattr(self, result, getattr(self, result) + 1)

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else 1.0

    @property
    def precision(self) -> float:
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else 1.0


def evaluate(entries: Iterable[dict]) -> tuple[dict[str, Score], list[tuple[dict, Detector, str, AdvisorActs]]]:
    scores = {detector.name: Score() for detector in DETECTORS}
    failures: list[tuple[dict, Detector, str, AdvisorActs]] = []
    for entry in entries:
        acts = read(entry)
        for detector in DETECTORS:
            result = outcome(entry, acts, detector)
            if result is None:
                continue
            scores[detector.name].add(result)
            if result not in ("tp", "tn"):
                failures.append((entry, detector, result, acts))
    return scores, failures


def report(scores: dict[str, Score], title: str) -> str:
    lines = [f"{title}", f"  {'detector':<14} {'tp':>4} {'fp':>4} {'fn':>4} {'tn':>5} {'precision':>10} {'recall':>8}"]
    for detector in DETECTORS:
        score = scores[detector.name]
        lines.append(
            f"  {detector.name:<14} {score.tp:>4} {score.fp:>4} {score.fn:>4} {score.tn:>5} "
            f"{score.precision:>10.3f} {score.recall:>8.3f}"
        )
    return "\n".join(lines)


def describe(failure: tuple[dict, Detector, str, AdvisorActs]) -> str:
    entry, detector, result, acts = failure
    predicted = detector.predict(entry, acts)
    return (
        f"{entry['id']} [{detector.name}] {result}: label={entry['labels'][detector.label]!r} "
        f"got={predicted!r} ({entry['phase_hint']}) {entry['text'][:160]!r}"
    )


class CorpusShapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.entries = load_corpus()

    def test_the_corpus_is_big_enough_and_well_formed(self) -> None:
        entries = self.entries
        self.assertGreaterEqual(len(entries), 1000)
        ids = [entry["id"] for entry in entries]
        self.assertEqual(len(ids), len(set(ids)), "duplicate ids")
        for entry in entries:
            self.assertEqual(set(entry["labels"]), set(LABEL_KEYS), entry["id"])
            self.assertIn(entry["phase_hint"], ("pre_anchor", "post_anchor", "any"), entry["id"])
            self.assertTrue(entry["text"].strip(), entry["id"])
            self.assertTrue(entry["source"], entry["id"])
            price = entry["labels"]["price_offer"]
            self.assertTrue(price is None or (isinstance(price, int) and 1000 <= price <= 9000), entry["id"])

    def test_every_kind_of_label_has_enough_cases(self) -> None:
        for key in ("call_proposal", "email_offer", "enrol_ask", "farewell", "anchor_reply"):
            positives = sum(1 for entry in self.entries if entry["labels"][key])
            negatives = sum(1 for entry in self.entries if entry["labels"][key] is False)
            self.assertGreaterEqual(positives, 25, key)
            self.assertGreaterEqual(negatives, 100, key)
        prices = sum(1 for entry in self.entries if entry["labels"]["price_offer"] is not None)
        self.assertGreaterEqual(prices, 100)

    def test_the_sources_are_all_known(self) -> None:
        kinds = {entry["source"].split(":", 1)[0] + ":" for entry in self.entries}
        self.assertLessEqual(kinds, {"review:", "iter1:", "iter2:", "owner:", "sim:"})
        self.assertGreaterEqual(sum(1 for entry in self.entries if is_hand(entry)), 400)
        self.assertGreaterEqual(sum(1 for entry in self.entries if is_sim(entry)), 800)

    def test_a_pitch_label_means_no_other_label(self) -> None:
        for entry in self.entries:
            labels = entry["labels"]
            if labels["pitch_only"]:
                self.assertFalse(labels["call_proposal"], entry["id"])
                self.assertFalse(labels["email_offer"], entry["id"])
                self.assertFalse(labels["enrol_ask"], entry["id"])
                self.assertFalse(labels["farewell"], entry["id"])
                self.assertIsNone(labels["price_offer"], entry["id"])


class DetectorCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.entries = load_corpus()
        cls.hand_scores, cls.hand_failures = evaluate(e for e in cls.entries if is_hand(e))
        cls.sim_scores, cls.sim_failures = evaluate(e for e in cls.entries if is_sim(e))
        cls.all_failures = cls.hand_failures + cls.sim_failures
        print("\n" + report(cls.hand_scores, "hand-labelled review cases"))
        print(report(cls.sim_scores, "simulator-labelled live-sweep turns"))

    def _unexpected(self, failures) -> list[str]:
        return [
            describe(failure)
            for failure in failures
            if failure[1].name not in KNOWN_FAILURES.get(failure[0]["id"], frozenset())
        ]

    def test_every_hand_labelled_case_is_right(self) -> None:
        wrong = self._unexpected(self.hand_failures)
        self.assertEqual([], wrong, "\n" + "\n".join(wrong[:60]))

    def test_no_labelled_case_regresses(self) -> None:
        """Any failure that is not a documented known failure is a regression."""
        wrong = self._unexpected(self.all_failures)
        self.assertEqual([], wrong, "\n" + "\n".join(wrong[:60]))

    def test_known_failures_still_fail(self) -> None:
        failing = {(failure[0]["id"], failure[1].name) for failure in self.all_failures}
        stale = [
            f"{case} {name}"
            for case, names in KNOWN_FAILURES.items()
            for name in sorted(names)
            if (case, name) not in failing
        ]
        self.assertEqual([], stale, "these now pass: remove them from KNOWN_FAILURES")

    def test_simulator_set_meets_the_floors_for_proposals_and_offers(self) -> None:
        for detector in DETECTORS:
            score = self.sim_scores[detector.name]
            if detector.proposals:
                self.assertGreaterEqual(score.recall, RECALL_FLOOR, f"{detector.name} recall")
                self.assertGreaterEqual(score.precision, PRECISION_FLOOR, f"{detector.name} precision")

    def test_farewell_and_anchor_reply_floors(self) -> None:
        for name in ("farewell", "anchor_reply"):
            score = self.sim_scores[name]
            self.assertGreaterEqual(score.recall, RECALL_FLOOR, f"{name} recall")
            self.assertGreaterEqual(score.precision, PRECISION_FLOOR, f"{name} precision")

    def test_a_pitch_triggers_no_detector(self) -> None:
        """The worst error: a programme description graded as a proposal earns a commitment line."""
        offenders = []
        for entry in self.entries:
            if not entry["labels"]["pitch_only"] or not is_hand(entry):
                continue
            acts = read(entry)
            if acts.call or acts.enrol or acts.email_offer or acts.callback is not None:
                offenders.append(f"{entry['id']} {entry['text'][:120]!r}")
        self.assertEqual([], offenders, "\n" + "\n".join(offenders[:40]))


HELDOUT_PATH = HERE / "tests" / "fixtures" / "r1_advisor_heldout.jsonl"
# The recall floors of the held-out set.  They are REGRESSION floors set just under what the detectors
# scored the first time they met these phrasings (call 0.861, e-mail 0.750, enrolment 0.857, price
# 1.000, farewell 0.857, anchor reply 0.833; precision 0.938 at worst): the honest estimate of how the
# lexical detectors do on wording they were not tuned on.  A miss here is reported, never patched
# into a grammar by itself; new held-out phrasings are added to a NEW fixture, not tuned on.
HELDOUT_RECALL_FLOORS = {
    "call_proposal": 0.80,
    "email_offer": 0.70,
    "enrol_ask": 0.80,
    "price_offer": 0.95,
    "farewell": 0.80,
    "anchor_reply": 0.75,
}
HELDOUT_PRECISION_FLOOR = 0.90


def load_heldout() -> list[dict]:
    with HELDOUT_PATH.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class HeldOutCorpusTests(unittest.TestCase):
    """Fresh advisor phrasings that no detector was tuned on (R1-Q final review round 1).

    The main corpus is built from the phrasings the detectors were tuned on, so its 1.000 precision and
    recall say nothing about real candidates.  This fixture holds wording written afterwards; its
    recall is what the engine can expect from a phrasing it has not seen.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.entries = load_heldout()
        cls.scores, cls.failures = evaluate(cls.entries)
        print("\n" + report(cls.scores, "held-out phrasings (not tuned on)"))
        for failure in cls.failures:
            print("  miss:", describe(failure))

    def test_the_heldout_set_is_well_formed_and_disjoint_from_the_tuned_corpus(self) -> None:
        ids = [entry["id"] for entry in self.entries]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(self.entries), 150)
        tuned = {" ".join(entry["text"].lower().split()) for entry in load_corpus()}
        for entry in self.entries:
            self.assertEqual(set(entry["labels"]), set(LABEL_KEYS), entry["id"])
            self.assertTrue(entry["source"].startswith("heldout:"), entry["id"])
            self.assertNotIn(" ".join(entry["text"].lower().split()), tuned, entry["id"])
        for key in ("call_proposal", "email_offer", "enrol_ask", "farewell", "anchor_reply"):
            self.assertGreaterEqual(sum(1 for e in self.entries if e["labels"][key]), 7, key)
            self.assertGreaterEqual(sum(1 for e in self.entries if e["labels"][key] is False), 40, key)

    def test_recall_and_precision_stay_above_the_floors(self) -> None:
        for detector in DETECTORS:
            score = self.scores[detector.name]
            with self.subTest(detector=detector.name):
                self.assertGreaterEqual(score.recall, HELDOUT_RECALL_FLOORS[detector.name], "recall")
                self.assertGreaterEqual(score.precision, HELDOUT_PRECISION_FLOOR, "precision")

    def test_a_pitch_triggers_no_detector_in_the_heldout_set_either(self) -> None:
        offenders = []
        for entry in self.entries:
            if not entry["labels"]["pitch_only"]:
                continue
            acts = read(entry)
            if acts.call or acts.enrol or acts.email_offer or acts.callback is not None:
                offenders.append(f"{entry['id']} {entry['text'][:100]!r}")
        self.assertEqual([], offenders, "\n" + "\n".join(offenders[:20]))


class HostileTextTests(unittest.TestCase):
    """The detectors read the advisor's speech-to-text, which can be long, repetitive or hostile: no
    pattern may go quadratic.  Each case is a whole advisor turn read at once (the engine's call)."""

    HOSTILE = (
        ("shall i send the payment link " * 600, "repeated enrolment asks"),
        ("we will call you back " * 900, "repeated call phrases"),
        ("i can send you the details " * 700, "repeated e-mail offers"),
        ("the price is $8,500 but i can do $7,500 " * 500, "repeated prices"),
        ("so, um, " * 3000 + "bye", "filler then a farewell"),
        ("$" + "9" * 30000, "one very long number"),
        ("," * 30000 + " ok?", "commas"),
        (("can we schedule a call " + "tomorrow " * 40) * 150, "long gaps inside a proposal"),
        (("let me check with my manager " + "and " * 60) * 120, "long hedges"),
        (("who else is involved " + "in the decision " * 60) * 100, "long decider questions"),
        ("7,000 " * 6000, "the anchor, repeated"),
        (". " * 8000, "only full stops (a farewell scan was quadratic in the sentences)"),
    )

    def test_every_hostile_turn_is_read_quickly(self) -> None:
        import time

        for text, why in self.HOSTILE:
            with self.subTest(why=why):
                started = time.perf_counter()
                read_advisor_turn(text)
                read_advisor_turn(text, after_anchor=False, r_sec=700.0)
                # Both readings together take well under a second on a laptop; the limit is for
                # a slow CI runner and still far below what a quadratic scan would need.
                self.assertLess(time.perf_counter() - started, 8.0, why)


if __name__ == "__main__":
    unittest.main()
