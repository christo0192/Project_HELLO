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

Ship restore (owner decision 2026-10-09: ship only what is proven better than production).  The
enrolment-ask reading is production's own, verbatim (``r1_commitment._ENROL_ASK``): the structural grammar
that replaced it did not converge in five review rounds.  Its misses and its false positives are
production's, so the ``enrol_ask`` labels are no longer a target.  Every row stays in the fixtures and
is still scored and printed; ``enrol_ask`` is not held to the per-case, recall and precision floors,
and ``ProductionEnrolmentReadingTests`` pins its confusion counts to production's instead, so the
reading cannot drift unnoticed.

Ship restore round 1 (owner decision 2026-10-09): the engine's call reading is the structural reader
(``r1_commitment.call_proposal_in``, kept for the proposals production misses) OR production's own
``_CALL_ASK`` (verbatim), so a call proposal production reads is never lost.  The ``call_proposal``
detector below scores the STRUCTURAL reader alone and keeps its floors (its own quality is still
measured); ``call_engine`` is the engine's union, held to production's confusion counts by
``ProductionCallReadingTests``, which also pins that the structural reader adds no false positive on a
labelled row that production lacks.
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

from r1_commitment import call_proposal_in, production_call_ask_in
from r1_negotiation import AdvisorActs, read_advisor_turn
from r1_text import split_sentences

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
# Ship restore (owner decision 2026-10-09): the cases below are call proposals that production
# misses too, so each is an accepted miss equal to production, not a regression.  c0976 ("Would a
# weekend slot work better for you both?"): the part-of-the-day alternatives of the head-only time-ask
# were deleted because they read "a flexible evening and weekend schedule" as a call.  Ship restore
# round 1: c0380 and c0840 ("So two o'clock tomorrow works?"), the head-only "<day or clock> ... works?"
# question, was deleted because it read a programme's schedule pitch ("Most of our learners study on
# Saturday mornings, would that work for you?") as a call; c1491 (the owner's turn 78, "I can also talk
# to your husband"), the head-only "talk to your husband" call object, was deleted because it read
# "Talk to your husband tonight and let me know" as a call.  The enrolment cases the earlier rounds
# listed here (c0716, c0719) are covered by the production reading below.  c0598 and c0838 ("how about
# tomorrow morning ...") and c1504 ("Do you have ten minutes on Saturday ...") went with the head-only
# time-ask alternatives "how about / what about <day>" and "do you have <time> <day>", deleted because
# they read "How about I email you the brochure tomorrow?" and "Do you have an hour in the mornings?"
# as calls.  Production misses all of them.
# Ship restore round 2: c1503 ("... look like this week for a quick conversation?"), c1722 ("... have a
# quick word on Saturday morning?") and c1744 ("... around for a quick conversation Saturday?") went with the
# head-only call nouns "conversation" and "word" (and "meeting", "check-in", "huddle", "catch-up",
# "discussion"), deleted because they read advice to the learner ("Have a conversation with your husband
# tonight and let me know", "Could you have a word with your husband tonight?") as a call; c1724 ("How's
# Sunday at 11 for a quick three-way chat?") went with the head-only "how does / how's" lead of the
# time-ask, deleted because it read "How does your weekend usually go?" as a call.  Production misses all
# four.  c1746 ("... is tomorrow night okay?") went with the head-only "is <day> ...?" lead of the
# fit-check question ("Is Saturday best for your assignments?"); c0172 ("We'll get back to you tomorrow.")
# went with the head-only "get back to you" / "come back to you" / "loop back" follow-ups, deleted because
# they read the advisor's promise of an ANSWER ("Let me check with my manager tomorrow and get back to you on
# the discount") as a call.  Production reads c1746 and c0172, so the engine still does and the structural
# reader alone no longer does.
KNOWN_FAILURES: dict[str, frozenset[str]] = {
    "c0172": frozenset({"call_proposal"}),
    "c0976": frozenset({"call_proposal"}),
    "c0380": frozenset({"call_proposal"}),
    "c0840": frozenset({"call_proposal"}),
    "c1491": frozenset({"call_proposal"}),
    "c0598": frozenset({"call_proposal"}),
    "c0838": frozenset({"call_proposal"}),
    "c1504": frozenset({"call_proposal"}),
    "c1503": frozenset({"call_proposal"}),
    "c1722": frozenset({"call_proposal"}),
    "c1724": frozenset({"call_proposal"}),
    "c1744": frozenset({"call_proposal"}),
    "c1746": frozenset({"call_proposal"}),
}


@dataclass(frozen=True)
class Detector:
    """One scored detector: the label it is compared with and how the engine's reading answers it."""

    name: str
    label: str
    predict: Callable[[dict, AdvisorActs], object]
    proposals: bool = True  # scored against the 95 % / 98 % floors on the simulator set
    # Production's own reading, verbatim (ship restore): scored and printed, not held to the labels or
    # the floors; its confusion counts are pinned to production's by ProductionEnrolmentReadingTests.
    production: bool = False


def _price(entry: dict, acts: AdvisorActs) -> object:
    return acts.best_offer_usd


def structural_call(entry: dict, acts: AdvisorActs) -> bool:
    """The structural reader's own call reading: ``call_proposal_in`` on a sentence, or a callback."""
    return acts.callback is not None or any(
        call_proposal_in(sentence) is not None for sentence in split_sentences(entry["text"])
    )


def production_call(entry: dict) -> bool:
    """Production's reading: a sentence of the turn matches origin/main's ``_CALL_ASK``."""
    return any(production_call_ask_in(sentence) is not None for sentence in split_sentences(entry["text"]))


DETECTORS: tuple[Detector, ...] = (
    Detector("call_proposal", "call_proposal", structural_call),
    Detector("call_engine", "call_proposal", lambda e, a: a.call, production=True),
    Detector("email_offer", "email_offer", lambda e, a: a.email_offer),
    Detector("enrol_ask", "enrol_ask", lambda e, a: a.enrol, production=True),
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
            if not failure[1].production
            and failure[1].name not in KNOWN_FAILURES.get(failure[0]["id"], frozenset())
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
            if detector.proposals and not detector.production:
                self.assertGreaterEqual(score.recall, RECALL_FLOOR, f"{detector.name} recall")
                self.assertGreaterEqual(score.precision, PRECISION_FLOOR, f"{detector.name} precision")

    def test_farewell_and_anchor_reply_floors(self) -> None:
        for name in ("farewell", "anchor_reply"):
            score = self.sim_scores[name]
            self.assertGreaterEqual(score.recall, RECALL_FLOOR, f"{name} recall")
            self.assertGreaterEqual(score.precision, PRECISION_FLOOR, f"{name} precision")

    def test_a_pitch_triggers_no_detector(self) -> None:
        """The worst error: a programme description graded as a proposal earns a commitment line.

        The enrolment reading is production's, so its false positives on a pitch are production's
        (``ProductionEnrolmentReadingTests`` pins their number), and so is the call floor
        (``ProductionCallReadingTests``); the structural call reader, the e-mail and the callback
        readings are still held to none.
        """
        offenders = []
        for entry in self.entries:
            if not entry["labels"]["pitch_only"] or not is_hand(entry):
                continue
            acts = read(entry)
            if structural_call(entry, acts) or acts.email_offer or acts.callback is not None:
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
            if detector.production:
                continue  # production's reading: pinned by ProductionEnrolmentReadingTests
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
            # enrol and the call floor are production's
            if structural_call(entry, acts) or acts.email_offer or acts.callback is not None:
                offenders.append(f"{entry['id']} {entry['text'][:100]!r}")
        self.assertEqual([], offenders, "\n" + "\n".join(offenders[:20]))


# Production's enrolment reading (ship restore, owner decision 2026-10-09).  ``_ENROL_ASK`` is
# origin/main's tuple verbatim, so its misses and false positives on the labelled fixtures are
# production's.  The counts below are what production scores, recorded on 2026-10-09; a change here
# means the reading is no longer production's.
PRODUCTION_ENROL_PATTERNS_SHA256 = "e0be65282070c59f08fe49e43be7cb627167a9246ca68ba1df368ec389aae731"
PRODUCTION_ENROL_COUNTS = {  # (tp, fp, fn)
    "hand": (47, 23, 13),
    "sim": (76, 13, 35),
    "heldout": (7, 3, 7),
}


class ProductionEnrolmentReadingTests(unittest.TestCase):
    def test_the_patterns_are_productions_verbatim(self) -> None:
        import hashlib

        import r1_commitment

        source = "\n".join(pattern.pattern for pattern in r1_commitment._ENROL_ASK)
        self.assertEqual(len(r1_commitment._ENROL_ASK), 18)
        self.assertEqual(
            hashlib.sha256(source.encode("utf-8")).hexdigest(),
            PRODUCTION_ENROL_PATTERNS_SHA256,
            "the enrolment reading is no longer origin/main's _ENROL_ASK",
        )

    def test_its_misses_and_false_positives_are_productions(self) -> None:
        corpus = load_corpus()
        sets = {
            "hand": evaluate(e for e in corpus if is_hand(e))[0],
            "sim": evaluate(e for e in corpus if is_sim(e))[0],
            "heldout": evaluate(load_heldout())[0],
        }
        for name, scores in sets.items():
            score = scores["enrol_ask"]
            with self.subTest(set=name):
                self.assertEqual((score.tp, score.fp, score.fn), PRODUCTION_ENROL_COUNTS[name])


# Production's call reading and learner classifier (ship restore round 1, owner decision 2026-10-09).
# ``_CALL_ASK`` is origin/main's tuple verbatim and ``ask_acts`` reads a call when the structural reader OR
# this tuple reads it, so a call proposal production reads is never lost; ``_STRONG`` / ``_MEDIUM`` /
# ``_WEAK`` are origin/main's, searched plainly (no negation or condition exemption).
PRODUCTION_CALL_PATTERNS_SHA256 = "53765f1618dc98592528863776d17d78d36a1903b4837f995ec91414f53e271f"
PRODUCTION_CLASSIFIER_PATTERNS_SHA256 = {
    "_STRONG": ("f24a87ff07610165e2b66d42d1b17c740e17af271764a60e1b9fc898925d4ad5", 12),
    "_MEDIUM": ("bd1cfc0ccb128a1dc167cb4bdb63d790f551cfbfe736d174d0ffb561149c2005", 9),
    "_WEAK": ("bb233211a520f96e41b8552fbd1d70e1b5b4e6d6fd1650d3392ec6b6820de6d3", 5),
}
# The engine's call reading (the union) on the labelled fixtures: (tp, fp, fn).  Production's own reading
# scores hand 66/61/53, simulator 54/4/41, held-out 18/2/18; the union keeps production's false
# positives and adds only true positives.
PRODUCTION_CALL_COUNTS = {  # (tp, fp, fn); round 2 deleted four head-only gains production misses
    "hand": (112, 61, 7),
    "sim": (91, 4, 4),
    "heldout": (31, 2, 5),
}


class ProductionCallReadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = load_corpus()
        cls.heldout = load_heldout()

    def test_the_call_patterns_are_productions_verbatim(self) -> None:
        import hashlib

        import r1_commitment

        source = "\n".join(pattern.pattern for pattern in r1_commitment._CALL_ASK)
        self.assertEqual(len(r1_commitment._CALL_ASK), 11)
        self.assertEqual(
            hashlib.sha256(source.encode("utf-8")).hexdigest(),
            PRODUCTION_CALL_PATTERNS_SHA256,
            "the call floor is no longer origin/main's _CALL_ASK",
        )

    def test_the_classifier_patterns_are_productions_verbatim(self) -> None:
        import hashlib

        import r1_commitment

        for name, (digest, count) in PRODUCTION_CLASSIFIER_PATTERNS_SHA256.items():
            patterns = getattr(r1_commitment, name)
            with self.subTest(patterns=name):
                self.assertEqual(len(patterns), count)
                source = "\n".join(pattern.pattern for pattern in patterns)
                self.assertEqual(hashlib.sha256(source.encode("utf-8")).hexdigest(), digest)

    def test_the_engine_reads_every_call_production_reads(self) -> None:
        missed = [
            f"{entry['id']} {entry['text'][:100]!r}"
            for entry in self.corpus + self.heldout
            if production_call(entry) and not read(entry).call
        ]
        self.assertEqual([], missed, "\n" + "\n".join(missed[:20]))

    def test_the_structural_reader_adds_no_false_positive_production_lacks(self) -> None:
        """The structural reader's extra recall is kept only where it adds no false positive: on every
        labelled row that is NOT a call proposal, it reads nothing production does not also read."""
        offenders = [
            f"{entry['id']} {entry['text'][:100]!r}"
            for entry in self.corpus + self.heldout
            if entry["labels"]["call_proposal"] is False
            and structural_call(entry, read(entry))
            and not production_call(entry)
        ]
        self.assertEqual([], offenders, "\n" + "\n".join(offenders[:20]))

    def test_the_engine_gains_true_positives_and_keeps_production_s_false_positives(self) -> None:
        sets = {
            "hand": [e for e in self.corpus if is_hand(e)],
            "sim": [e for e in self.corpus if is_sim(e)],
            "heldout": self.heldout,
        }
        engine = next(d for d in DETECTORS if d.name == "call_engine")
        for name, entries in sets.items():
            with self.subTest(set=name):
                tp = fp = fn = ptp = pfp = pfn = 0
                for entry in entries:
                    label = entry["labels"]["call_proposal"]
                    if label is None:
                        continue
                    ours = bool(engine.predict(entry, read(entry)))
                    theirs = production_call(entry)
                    tp += label and ours
                    fp += (not label) and ours
                    fn += label and not ours
                    ptp += label and theirs
                    pfp += (not label) and theirs
                    pfn += label and not theirs
                self.assertEqual(fp, pfp, "the engine reads no false positive production does not")
                self.assertGreaterEqual(tp, ptp)
                self.assertLessEqual(fn, pfn)
                self.assertEqual((tp, fp, fn), PRODUCTION_CALL_COUNTS[name])


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
