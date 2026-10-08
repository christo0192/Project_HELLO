"""Unit tests of the rehearsal harness (``app/voice-livekit/rehearsal``): offline, no network, no key.

The harness measures the learner, so it has to be right itself: the metrics on known good and
bad transcripts, the modelled clock, the ledger and the 402 stop, the key hygiene, the advisor
simulator's prompt (it must never see the persona), the judge's strict parsing, the offline
stand-ins (every model-voiced line must satisfy its own markers and pass the guard), the
scorecard's thresholds and the CLI end to end on scripted calls.

The owner session as a fixture, and the replay of it against the engine, are in
``test_r1_rehearsal_regression``.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from rehearsal import advisor, clock, judge, llm, metrics, run, scorecard
from rehearsal import scripted_advisor as sa
from rehearsal import scripted_learner as sl
from rehearsal.call import CallDeps, CallSpec, run_call
from r1_guard import FALLBACK_REPLIES, GuardContext, guard_text
from r1_negotiation import COUNTERS, SPECS, filled_markers
from r1_personas import PERSONAS, deep_need_topics_in, detect_followup, detect_probes, resolve_persona
from r1_prompts import turn_reminder
from r1_roleplay import RolePlayEngine
from r1_scheduler import PLAN, markers_match
from r1_tracker import parse_judge_output
from r1_world import FACTS, NET_PRICES_USD, PRICE_USD

FAKE_KEY = "unit-test-" + "k" * 24
REAL_LIVE_FACTORY = run.LiveFactory


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


HAS_HTTPX = _has_module("httpx")
HAS_LIVE_LEARNER = _has_module("livekit.plugins.openai")


def make_rows(pairs, pickup="Hello? Yes, this is Meera speaking."):
    """Role-play rows in the database export schema: the pickup, then (advisor, learner) pairs."""
    rows = [{"turn_index": 1, "phase": "roleplay", "speaker": "bot", "text": pickup, "interrupted": False}]
    index = 2
    for advisor_text, learner_text in pairs:
        rows.append(
            {"turn_index": index, "phase": "roleplay", "speaker": "candidate", "text": advisor_text, "interrupted": False}
        )
        rows.append(
            {"turn_index": index + 1, "phase": "roleplay", "speaker": "bot", "text": learner_text, "interrupted": False}
        )
        index += 2
    return rows


# ---------------------------------------------------------------------------------- metrics
class RepeatMetricTests(unittest.TestCase):
    def test_a_sentence_said_twice_is_one_extra_exact_repeat(self) -> None:
        found = metrics.repeat_metrics(["I tried some online stuff.", "Right. I tried some online stuff!"])
        self.assertEqual(found["exact_repeat_extra"], 1)
        self.assertFalse(found["long_exact_repeat"])  # five words: counted, but not a hard repeat
        self.assertEqual(found["exact_repeats"][0]["sentence"], "i tried some online stuff")

    def test_a_long_sentence_repeated_is_a_hard_repeat(self) -> None:
        text = "Honestly my schedule is pretty packed these days."
        found = metrics.repeat_metrics([text, "Okay.", text])
        self.assertTrue(found["long_exact_repeat"])
        self.assertIn("exact_repeat_sentence", metrics.hard_fails(found))

    def test_back_channels_never_count(self) -> None:
        found = metrics.repeat_metrics(["Okay.", "Okay.", "I see.", "I see.", "Mm-hmm, right."] * 3)
        self.assertEqual(found["exact_repeat_extra"], 0)
        self.assertEqual(found["near_repeat_count"], 0)

    def test_a_sentence_inside_a_longer_one_is_a_near_repeat(self) -> None:
        found = metrics.repeat_metrics(
            ["Just email me the details and I'll get back to you.", "Okay. Just email me the details."]
        )
        self.assertEqual(found["exact_repeat_extra"], 0)
        self.assertEqual(found["near_repeat_count"], 1)

    def test_a_reworded_sentence_is_a_near_repeat_but_a_new_one_is_not(self) -> None:
        near = metrics.repeat_metrics(
            ["I am not sure about the price today.", "I am not sure about the price now."]
        )
        self.assertEqual(near["near_repeat_count"], 1)
        fresh = metrics.repeat_metrics(
            ["I am not sure about the price today.", "What would I actually build in the course?"]
        )
        self.assertEqual(fresh["near_repeat_count"], 0)


class WeakAndDeflectionTests(unittest.TestCase):
    def test_the_weak_line_is_counted_per_reply_even_inside_a_longer_reply(self) -> None:
        replies = [
            "Let me think about it. Just email me the details and I'll get back to you.",
            "Okay, thanks. I'll look out for your email. Let me think about it. Just email me "
            "the details and I'll get back to you.",
            "That helps.",
        ]
        found = metrics.weak_metrics(replies)
        self.assertEqual(found["weak_line_count"], 2)
        self.assertEqual(found["weak_line_rows"], [0, 1])

    def test_stall_phrases_in_other_words_are_the_stall_family(self) -> None:
        found = metrics.weak_metrics(["I'll think about it.", "Please email me.", "Sure, whenever."])
        self.assertEqual(found["stall_family_rows"], 2)
        self.assertEqual(found["weak_line_count"], 0)

    def test_the_old_deflection_and_the_guard_fallbacks(self) -> None:
        found = metrics.weak_metrics(
            ["I'm not sure, I haven't thought about that. Is it live classes or recorded?", FALLBACK_REPLIES[1], "Fine."]
        )
        self.assertEqual(found["deflection_count"], 1)
        self.assertEqual(found["fallback_reply_count"], 1)


class FactErrorTests(unittest.TestCase):
    def test_the_decks_figures_and_the_anchor_are_not_errors(self) -> None:
        texts = [
            "The course is $9,000 and about six months, I read.",
            "I heard people paid around $7,000 for it.",
            "A $500 discount would still leave the price at $8,500.",
        ]
        self.assertEqual(metrics.fact_error_metrics(texts)["fact_error_count"], 0)

    def test_a_figure_the_advisor_said_may_be_repeated(self) -> None:
        advisor_texts = ["Let's make it 8.5, I mean $8500."]
        found = metrics.fact_error_metrics(["So the price would come to $8,500 then?"], advisor_texts)
        self.assertEqual(found["fact_error_count"], 0)

    def test_an_invented_price_a_wrong_duration_and_a_guarantee_are_errors(self) -> None:
        found = metrics.fact_error_metrics(
            [
                "I would pay $6,000 for it.",
                "The course takes twelve months, I think, so 12 months is long.",
                "They guaranteed a job after the course.",
            ]
        )
        self.assertEqual(found["fact_error_count"], 3)
        codes = {code for item in found["fact_errors"] for code in item["codes"]}
        self.assertEqual(codes, {"price_not_deck", "duration_not_deck", "guarantee_claim"})


class StyleAndInterviewerTests(unittest.TestCase):
    def test_style_numbers(self) -> None:
        replies = ["Okay, that makes sense.", "Hmm, how long is it?", "Mm-hmm.", "Word " * 41]
        found = metrics.style_metrics(replies)
        self.assertEqual(found["reply_count"], 4)
        self.assertEqual(found["over_cap_replies"], 0)
        self.assertAlmostEqual(found["question_rate"], 0.25)
        self.assertAlmostEqual(found["reaction_rate"], 0.75)
        self.assertAlmostEqual(found["neutral_ack_share"], 0.25)
        self.assertAlmostEqual(found["short_reply_share"], 0.75)
        self.assertEqual(found["reply_words_max"], 41)

    def test_a_role_play_only_call_has_no_interviewer_findings(self) -> None:
        found = metrics.interviewer_metrics(make_rows([("Hi", "Hello")]))
        self.assertIsNone(found["name_fallback"])
        self.assertIsNone(found["farewell_rows"])

    def test_a_clean_wrap_up_is_clean_and_a_bad_one_is_found(self) -> None:
        def wrap(rows_text):
            rows = make_rows([("Hi", "Hello")])
            index = 10
            for phase, text in rows_text:
                rows.append({"turn_index": index, "phase": phase, "speaker": "bot", "text": text, "interrupted": False})
                index += 1
            return rows

        clean = metrics.interviewer_metrics(
            wrap(
                [
                    ("roleplay_exit", "Let's pause the role-play here."),
                    ("wrapup", "Before we finish, do you have any questions about the role?"),
                    ("closing", "Thank you for your time today, Asha. The team will be in touch. Goodbye."),
                ]
            )
        )
        self.assertEqual((clean["name_fallback"], clean["farewell_rows"], clean["repeated_phrase_rows"]), (0, 1, 0))
        bad = metrics.interviewer_metrics(
            wrap(
                [
                    ("wrapup", "Thank you for your time today. The hiring team will review it and the hiring team will call."),
                    ("closing", "Thank you for your time today, there. Goodbye."),
                ]
            )
        )
        self.assertEqual(bad["name_fallback"], 1)
        self.assertEqual(bad["farewell_rows"], 2)
        self.assertEqual(bad["repeated_phrase_rows"], 1)


# ------------------------------------------------------------------------ exchange metrics
def exchange(n, r_sec, advisor_text, intent="other", topic="", spoken="Okay.", plan=None):
    return {
        "n": n,
        "r_sec": r_sec,
        "advisor": {"text": advisor_text, "intent": intent, "topic": topic},
        "learner": {"spoken": spoken, "raw": spoken, "plan": plan, "latency": {}},
    }


class DisclosureTests(unittest.TestCase):
    PERSONA = resolve_persona("p1_career_switcher", variant="v1")

    def test_a_probe_and_a_follow_up_disclose_the_deep_need(self) -> None:
        exchanges = [
            exchange(1, 10, "What made you look now?", "probe", "H1", "Honestly, things feel uncertain at work."),
            exchange(2, 30, "Tell me more.", "followup", "H1", "My plant is being consolidated next year."),
        ]
        found = metrics.disclosure_metrics(self.PERSONA, exchanges)
        self.assertEqual(found["needs_probed"], ["H1"])
        self.assertEqual(found["needs_dug"], ["H1"])
        self.assertEqual(found["needs_disclosed_after_dig"], ["H1"])
        self.assertEqual(found["disclosure_rate"], 1.0)
        self.assertEqual(found["unprompted_dump_count"], 0)
        self.assertEqual(found["deep_on_first_probe"], [])

    def test_a_probe_alone_is_not_digging_and_a_missed_reveal_is_a_miss(self) -> None:
        only_probe = [exchange(1, 10, "Why now?", "probe", "H1", "Just exploring.")]
        self.assertIsNone(metrics.disclosure_metrics(self.PERSONA, only_probe)["disclosure_rate"])
        missed = [
            exchange(1, 10, "Why now?", "probe", "H1", "Just exploring."),
            exchange(2, 30, "Tell me more.", "followup", "H1", "Not much to say."),
            exchange(3, 50, "And?", "pitch", "", "Okay."),
            exchange(4, 70, "Right.", "pitch", "", "Okay."),
        ]
        self.assertEqual(metrics.disclosure_metrics(self.PERSONA, missed)["disclosure_rate"], 0.0)

    def test_the_deep_need_with_no_question_about_it_is_an_unprompted_dump(self) -> None:
        exchanges = [
            exchange(1, 10, "Here is the course.", "pitch", "", "Okay."),
            exchange(2, 30, "It runs six months.", "pitch", "", "Well, I quit a free Python course after three weeks."),
        ]
        found = metrics.disclosure_metrics(self.PERSONA, exchanges)
        self.assertEqual(found["unprompted_dump_count"], 1)
        self.assertEqual(found["unprompted_dumps"], [{"exchange": 2, "topic": "H2"}])

    def test_the_deep_need_on_the_very_first_probe_is_recorded(self) -> None:
        exchanges = [exchange(1, 10, "Why now?", "probe", "H1", "My plant is being consolidated.")]
        self.assertEqual(metrics.disclosure_metrics(self.PERSONA, exchanges)["deep_on_first_probe"], ["H1"])


class CommitmentAndMisfireTests(unittest.TestCase):
    @staticmethod
    def commit_plan(level):
        return {"resolves": True, "commitment_level": level, "delivered_commitment": True}

    def test_an_earned_commitment_needs_an_ask_just_before(self) -> None:
        admin = {"commitment": {"level": "MEDIUM", "resolved": True, "asks": [{}]}}
        earned = [
            exchange(1, 560, "Would you like to book a call?", "close_ask"),
            exchange(2, 580, "Great.", "other", spoken="Let's book a call.", plan=self.commit_plan("MEDIUM")),
        ]
        self.assertTrue(metrics.commitment_metrics(earned, admin)["commitment_earned"])
        unasked = [
            exchange(1, 560, "More about the capstone.", "pitch"),
            exchange(2, 580, "Great.", "other", spoken="Let's book a call.", plan=self.commit_plan("MEDIUM")),
        ]
        found = metrics.commitment_metrics(unasked, admin)
        self.assertFalse(found["commitment_earned"])
        self.assertIn("unearned_commitment", metrics.hard_fails({**found}))

    def test_a_weak_resolution_needs_no_ask_and_a_missing_one_is_none(self) -> None:
        admin = {"commitment": {"level": "WEAK", "resolved": True}}
        self.assertIsNone(metrics.commitment_metrics([], admin)["commitment_earned"])
        self.assertIsNone(metrics.commitment_metrics([], {"commitment": {}})["commitment_level"])

    def test_a_commitment_before_9_00_is_premature(self) -> None:
        admin = {"commitment": {"level": "STRONG", "resolved": True}}
        early = [exchange(1, 300, "Enrol?", "close_ask", spoken="Send me the link.", plan=self.commit_plan("STRONG"))]
        found = metrics.commitment_metrics(early, admin)
        self.assertEqual(found["premature_commit_count"], 1)
        self.assertIn("premature_commit_or_concession", metrics.hard_fails(found))

    def test_misfires(self) -> None:
        exchanges = [
            exchange(1, 100, "Tell me about yourself.", "other", spoken="Oh, that's a nice surprise, thank you."),
            exchange(2, 200, "The course covers SQL.", "pitch", spoken="Oh wait, before you go... one thing."),
            exchange(3, 300, "I can do $500 off.", "discount", spoken="Oh, that's a nice surprise."),
            exchange(4, 400, "Goodbye then.", "farewell", spoken="Wait, before you go, one thing."),
            exchange(5, 450, "Shall we?", "other", spoken="I've only got a couple of minutes before my next call."),
            exchange(6, 700, "Thursday evening at 7 PM?", "callback", spoken="Let me think about it. Just email me the details and I'll get back to you."),
        ]
        found = metrics.misfire_metrics(exchanges)
        kinds = [(item["exchange"], item["kind"]) for item in found["misfires"]]
        self.assertEqual(
            kinds,
            [(1, "unwarranted_surprise"), (2, "no_one_leaving"), (5, "time_cue_too_early"), (6, "ignored_offer")],
        )


class ScheduleAndGuardMetricTests(unittest.TestCase):
    def test_families_slip_and_intent_fallback_rate(self) -> None:
        admin = {
            "schedule": {
                "families": {
                    "F1": {"delivered": True, "max_slip_sec": 12.5},
                    "F2": {"delivered": True, "max_slip_sec": 0.0},
                    "F3": {"delivered": False, "max_slip_sec": None},
                    "F4": {"delivered": True, "max_slip_sec": 40.0},
                },
                "moves": [{"id": "F4-PUSH", "forced": True, "status": "delivered"}],
                "exclusion_reasons": ["family_missing:F3"],
            },
            "intents": {"handed_to_model": {"F1-ANCHOR": 1, "F2-PRIMARY": 3}, "fallback_appended": {"F2-PRIMARY": 1}},
        }
        found = metrics.schedule_metrics(admin)
        self.assertEqual(found["families_delivered"], ["F1", "F2", "F4"])
        self.assertEqual(found["max_slip_sec"], 40.0)
        self.assertAlmostEqual(found["intent_fallback_rate"], 0.25)
        self.assertEqual(found["deadline_forced_moves"], ["F4-PUSH"])

    def test_commitment_hits_after_the_commitment_are_counted(self) -> None:
        admin = {
            "guard": {"hits": 2, "leak_hits": 2, "by_category": {"commitment": 2}, "flagged": False},
            "commitment": {"turn": 12, "level": "MEDIUM"},
            "turn_map": [{"roleplay_turn": 12, "transcript_turn": 26}],
            "fidelity": {"passes": False, "checks": {"r_reached_10_min": False, "stt_sanity": True}},
        }
        trips = [{"category": "commitment", "turn_index": 20}, {"category": "commitment", "turn_index": 30}]
        found = metrics.guard_metrics(admin, trips, [])
        self.assertEqual(found["commitment_hits_after_commitment"], 1)
        self.assertEqual(found["fidelity_failed_checks"], ["r_reached_10_min"])
        self.assertIn("guard_flagged", metrics.hard_fails(found))

    def test_hard_fails_of_a_clean_call_are_empty(self) -> None:
        self.assertEqual(metrics.hard_fails({"weak_line_count": 1, "commitment_earned": True}), [])

    def test_a_stall_reason_voiced_twice_is_found_and_fails_the_call(self) -> None:
        """R1-Q round 1: "I'd rather wait" (N-TIMING) then "not rush ... next batch" (F4-PRIMARY)
        is the stall loop in different words; the stall-phrase metric cannot see it."""
        admin = {"negotiation": {"reason_voicings": {"timing": 2, "decision_maker": 1, "money": 1}}}
        found = metrics.stall_reason_metrics(admin)
        self.assertEqual(found["stall_reason_repeats"], 1)
        self.assertEqual(found["stall_reason_repeated"], ["timing"])
        self.assertEqual(found["stall_reason_voicings"], {"timing": 2, "decision_maker": 1, "money": 1})
        self.assertIn("stall_reason_repeated", metrics.hard_fails(found))
        clean = metrics.stall_reason_metrics({"negotiation": {"reason_voicings": {"timing": 1}}})
        self.assertEqual((clean["stall_reason_repeats"], clean["stall_reason_repeated"]), (0, []))
        self.assertNotIn("stall_reason_repeated", metrics.hard_fails(clean))
        for admin in ({}, {"negotiation": {}}, {"negotiation": {"reason_voicings": None}}):
            self.assertEqual(metrics.stall_reason_metrics(admin)["stall_reason_repeats"], 0)

    def test_call_metrics_carry_the_stall_reason_counts(self) -> None:
        record = {
            "header": {"persona_id": "p1_career_switcher", "persona_variant": "v1", "seed": "x"},
            "rows": [],
            "exchanges": [],
            "admin_log": {"negotiation": {"reason_voicings": {"decision_maker": 3}}},
        }
        found = metrics.call_metrics(record)
        self.assertEqual(found["stall_reason_repeats"], 2)
        self.assertIn("stall_reason_repeated", metrics.hard_fails(found))

    def test_the_final_price_asked_twice_close_together_fails_the_call(self) -> None:
        """R1-Q round 2: the pleased anchor ("... Is that your final price?") and the met counter
        ("... Is this the final price?") are one question in different words, with no new advisor
        price between them; the near-repeat metric compares wording, so it cannot see it."""

        def exchanges(*lines: str):
            return [{"learner": {"spoken": line}} for line in lines]

        twice = exchanges(
            "I heard people got it for around $7,000, so that sounds about right. Is that your "
            "final price?",
            "Okay.",
            "Okay, that's closer to what I hoped. Is this the final price?",
        )
        found = metrics.final_price_metrics(twice)
        self.assertEqual(found["final_price_question_exchanges"], [1, 3])
        self.assertEqual(found["final_price_asked_twice"], 1)
        self.assertIn("final_price_asked_twice", metrics.hard_fails(found))
        once = metrics.final_price_metrics(exchanges(
            "That's right at the $7,000 I heard. What exactly does that price include?",
            "Okay.",
            "Oh, that would help a lot. Is that the final price, then?",
        ))
        self.assertEqual((once["final_price_questions"], once["final_price_asked_twice"]), (1, 0))
        self.assertNotIn("final_price_asked_twice", metrics.hard_fails(once))
        # Far apart, or not a question, is no repeat.
        far = metrics.final_price_metrics(exchanges(
            "Is that the final price?", "Hmm.", "Right.", "Mm.", "Sure.", "Is this the best price?",
        ))
        self.assertEqual((far["final_price_questions"], far["final_price_asked_twice"]), (2, 0))
        statement = metrics.final_price_metrics(exchanges(
            "That is the final price I heard.", "Is that the final price?",
        ))
        self.assertEqual(statement["final_price_questions"], 1)
        for empty in ([], [{}], [{"learner": None}]):
            self.assertEqual(metrics.final_price_metrics(empty)["final_price_questions"], 0)


class GoodCallTests(unittest.TestCase):
    """A hand-written good call passes every deterministic gate (research 4.7)."""

    PAIRS = [
        ("Hi Meera, this is Alex from Interview Kickstart. Is now a good time?", "I'm doing well, thanks. Yes, now is fine."),
        ("What made you start looking at data science now?", "Honestly, things at work feel a bit uncertain, and I've been in the same spot for a while."),
        ("Tell me more about that. What has been going on?", "Well, my plant is being consolidated next year, and my role has been stagnant for about three years."),
        ("That sounds stressful. Have you tried learning this on your own before?", "I did try once, but it didn't really go anywhere."),
        ("Could you walk me through that a bit?", "I quit a free Python course after three weeks, because there was no structure at all."),
        ("The course covers Python, SQL and machine learning with mentors and projects.", "Hmm. I can find a lot of this free on YouTube, so what would I be paying for?"),
        ("Free content is a good start; the difference is guidance and mock interviews.", "Okay, that makes sense. Would this really help me land a job with all these layoffs?"),
        ("Nobody can guarantee a job, but career support is built for this market.", "Fair enough. And my schedule is pretty packed, can I keep up for six months?"),
        ("The classes are flexible and recordings help you catch up.", "What happens if I fall behind then?"),
        ("Your mentor helps you catch up, so you are not on your own.", "Good. I heard people got it for around $7,000, though. Can you do that?"),
        ("The listed price is $9,000, I can take $500 off, so $8,500.", "That's better, but it's still a stretch for me. Is there any more room?"),
        ("That is the best I can offer with the payment plan.", "Okay. I'm not ready to decide today, I might wait for the next cohort."),
        ("Of course, what would help you feel ready?", "I'd also want to talk to my husband before deciding anything."),
        ("Would a call with your husband on Thursday at 7 PM help?", "Let's book a call on Thursday at 7 PM with my husband so we can decide."),
    ]

    def record(self):
        rows = make_rows(self.PAIRS)
        plan_fields = {"mode": "llm_reply", "reasons": ["free_reply"], "resolves": False, "commitment_level": None}
        exchanges = []
        intents = ["greet", "probe", "followup", "probe", "followup", "pitch", "answer_objection",
                   "answer_objection", "answer_objection", "answer_objection", "discount", "price",
                   "answer_objection", "callback"]
        topics = ["", "H1", "H1", "H2", "H2", "", "F3", "F3", "F2", "F2", "F1", "F1", "F4", "F4"]
        for i, (adv, lrn) in enumerate(self.PAIRS):
            plan = dict(plan_fields)
            if i == len(self.PAIRS) - 1:
                plan = {"mode": "say_only", "reasons": ["ask_in_window:grade_medium"], "resolves": True,
                        "commitment_level": "MEDIUM", "delivered_commitment": True}
            exchanges.append(exchange(i + 1, 40 * (i + 1) + 40, adv, intents[i], topics[i], lrn, plan))
        exchanges[-1]["r_sec"] = 600.0
        admin = {
            "commitment": {"level": "MEDIUM", "resolved": True, "asks": [{"turn": 14, "kind": "call"}], "turn": 14},
            "turn_map": [{"roleplay_turn": 14, "transcript_turn": 29}],
            "guard": {"hits": 0, "leak_hits": 0, "hygiene_hits": 0, "by_category": {}, "flagged": False},
            "schedule": {
                "families": {f: {"delivered": True, "max_slip_sec": 0.0} for f in ("F1", "F2", "F3", "F4")},
                "moves": [],
                "exclusion_reasons": [],
            },
            "intents": {"handed_to_model": {}, "fallback_appended": {}},
            "fidelity": {"passes": True, "checks": {}},
        }
        return {
            "header": {"persona_id": "p1_career_switcher", "persona_variant": "v1", "seed": "good", "candidate_name": "Rohan"},
            "rows": rows,
            "exchanges": exchanges,
            "admin_log": admin,
            "guard_trips": [],
            "roleplay_seconds": 640.0,
            "stop_reason": "early_exit",
            "error": None,
        }

    def test_nothing_is_flagged(self) -> None:
        record = self.record()
        found = metrics.call_metrics(record)
        self.assertEqual(metrics.hard_fails(found), [])
        self.assertEqual(found["weak_line_count"], 0)
        self.assertEqual(found["deflection_count"], 0)
        self.assertEqual(found["exact_repeat_extra"], 0)
        self.assertEqual(found["near_repeat_count"], 0)
        self.assertEqual(found["fact_error_count"], 0)
        self.assertEqual(found["misfire_count"], 0)
        self.assertEqual(found["commitment_level"], "MEDIUM")
        self.assertTrue(found["commitment_earned"])
        self.assertEqual(found["premature_commit_count"], 0)
        self.assertEqual(found["families_delivered_count"], 4)
        self.assertEqual(found["needs_dug"], ["H1", "H2"])
        self.assertEqual(found["disclosure_rate"], 1.0)
        self.assertGreaterEqual(found["question_rate"], 0.25)
        self.assertGreaterEqual(found["reaction_rate"], 0.3)

    def test_it_passes_the_judge_free_gates_of_a_strong_advisor(self) -> None:
        record = self.record()
        record["header"]["advisor_level"] = "strong"
        record["metrics"] = metrics.call_metrics(record)
        record["hard_fails"] = metrics.hard_fails(record["metrics"])
        card = scorecard.build_scorecard([record], offline=False)
        by = {g["gate"]: g["status"] for g in card["gates"] if g["level"] == "strong"}
        for gate in ("hard_fails", "families", "misfires", "disclosure", "dump", "commit_medium",
                     "near_repeat", "weak_once", "post_commit", "length_low", "length_high",
                     "length_p90", "question_low", "question_high"):
            with self.subTest(gate=gate):
                self.assertEqual(by[gate], "pass")
        self.assertEqual(by["commit_strong"], "fail")  # a MEDIUM call is not the STRONG half
        self.assertEqual(by["style"], "n/a")  # no judge ran


# --------------------------------------------------------------------------------- the clock
class ClockTests(unittest.TestCase):
    def test_the_same_seed_gives_the_same_clock(self) -> None:
        first = clock.TurnTimingModel("seed")
        second = clock.TurnTimingModel("seed")
        self.assertEqual([first.endpoint() for _ in range(5)], [second.endpoint() for _ in range(5)])
        self.assertNotEqual(clock.TurnTimingModel("other").endpoint(), clock.TurnTimingModel("seed").endpoint())

    def test_the_parts_of_an_exchange(self) -> None:
        model = clock.TurnTimingModel("x")
        self.assertAlmostEqual(model.advisor_speak(32), 10.0)
        self.assertEqual(model.advisor_speak(0), 1.0)
        self.assertAlmostEqual(model.learner_speak(27), 10.0)
        self.assertTrue(0.8 <= model.endpoint() <= 1.6)
        self.assertTrue(1.5 <= model.reaction() <= 5.0)
        self.assertEqual(model.learner_llm(None), 2.5)
        self.assertEqual(model.learner_llm(1.7), 1.7)

    def test_an_exchange_is_about_35_seconds_for_a_typical_advisor_turn(self) -> None:
        model = clock.TurnTimingModel("typical")
        total = model.advisor_speak(70) + model.endpoint() + model.after_learner(18, None)
        self.assertTrue(30 <= total <= 45, total)


# ------------------------------------------------------------------------- key and ledger
class KeyHandlingTests(unittest.TestCase):
    def test_dotenv_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(
                "# comment\nOTHER=1\nexport DEEPSEEK_API_KEY = 'abc123abc123abc123'  # trailing\nQUOTED=\"x y\"\n",
                encoding="utf-8",
            )
            self.assertEqual(llm.read_dotenv_value(path, "DEEPSEEK_API_KEY"), "abc123abc123abc123")
            self.assertEqual(llm.read_dotenv_value(path, "QUOTED"), "x y")
            self.assertIsNone(llm.read_dotenv_value(path, "MISSING"))
            self.assertEqual(llm.load_api_env(path), {"DEEPSEEK_API_KEY": "abc123abc123abc123"})

    def test_a_missing_key_is_a_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("OTHER=1\n", encoding="utf-8")
            with self.assertRaises(llm.MissingKey):
                llm.load_api_env(path)

    def test_the_env_file_is_found_from_the_main_checkout_above_a_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app" / "api").mkdir(parents=True)
            (root / "app" / "api" / ".env").write_text("DEEPSEEK_API_KEY=zzzzzzzzzzzz\n", encoding="utf-8")
            deep = root / ".claude" / "worktrees" / "w" / "app" / "voice-livekit" / "rehearsal" / "x.py"
            deep.parent.mkdir(parents=True)
            with mock.patch.dict("os.environ", {}, clear=False):
                with mock.patch.object(llm.os.environ, "get", side_effect=lambda name, default=None: None):
                    self.assertEqual(llm.find_env_file(deep), root / "app" / "api" / ".env")

    def test_the_scrubber_hides_the_key_and_bearer_shapes(self) -> None:
        scrub = llm.Scrubber([FAKE_KEY])
        text = scrub(f"failed with {FAKE_KEY} and Authorization: Bearer abcdefghij1234")
        self.assertNotIn(FAKE_KEY, text)
        self.assertNotIn("abcdefghij1234", text)
        self.assertNotIn(FAKE_KEY, repr(scrub))
        self.assertEqual(llm.describe_error(RuntimeError(FAKE_KEY), scrub), "RuntimeError: <redacted>")


class LedgerTests(unittest.TestCase):
    def test_cost_arithmetic_and_roles(self) -> None:
        ledger = llm.Ledger()
        ledger.record("learner", {"prompt": 1_000_000, "cached": 0, "completion": 0}, 1.0)
        ledger.record("advisor", {"prompt": 0, "cached": 0, "completion": 1_000_000}, 2.0)
        ledger.record("judge", {"prompt": 1_000_000, "cached": 1_000_000, "completion": 0}, 0.5)
        self.assertAlmostEqual(ledger.cost_usd, 0.30 + 1.20 + 0.03, places=6)
        self.assertEqual(ledger.calls, {"learner": 1, "advisor": 1, "judge": 1})
        self.assertEqual(ledger.summary()["seconds"], {"learner": 1.0, "advisor": 2.0, "judge": 0.5})

    def test_budget_and_fatal_and_merge(self) -> None:
        ledger = llm.Ledger(budget_usd=0.1)
        self.assertFalse(ledger.over_budget)
        ledger.record("x", {"prompt": 1_000_000, "cached": 0, "completion": 0}, 0)
        self.assertTrue(ledger.over_budget)
        other = llm.Ledger()
        other.record("x", {"prompt": 10, "cached": 0, "completion": 5}, 1)
        other.mark_fatal("insufficient_balance", "no balance")
        ledger.merge(other)
        self.assertEqual(ledger.calls["x"], 2)
        self.assertEqual(ledger.fatal, "insufficient_balance")
        ledger.mark_fatal("later", "ignored")
        self.assertEqual(ledger.fatal, "insufficient_balance")

    def test_usage_shapes(self) -> None:
        self.assertEqual(
            llm.usage_dict(SimpleNamespace(prompt_tokens=10, completion_tokens=4, prompt_cached_tokens=3)),
            {"prompt": 10, "cached": 3, "completion": 4},
        )
        self.assertEqual(
            llm.usage_dict({"prompt_tokens": 7, "completion_tokens": 2, "prompt_cache_hit_tokens": 5}),
            {"prompt": 7, "cached": 5, "completion": 2},
        )
        self.assertEqual(llm.usage_dict(None), {"prompt": 0, "cached": 0, "completion": 0})


class StatusTests(unittest.TestCase):
    def test_a_402_is_found_through_the_cause_chain_and_in_the_text(self) -> None:
        inner = SimpleNamespace(status_code=402)

        class Wrapped(RuntimeError):
            pass

        outer = Wrapped("llm failed")
        outer.error = inner  # type: ignore[attr-defined]
        self.assertTrue(llm.is_insufficient_balance(outer))
        self.assertTrue(llm.is_insufficient_balance(RuntimeError("Error: Insufficient Balance")))
        self.assertFalse(llm.is_insufficient_balance(RuntimeError("boom")))
        self.assertEqual(llm.status_of(SimpleNamespace()), None)


class RecordingProviderTests(unittest.TestCase):
    def test_it_keeps_raw_text_timing_and_usage(self) -> None:
        async def inner(_messages):
            yield SimpleNamespace(delta=SimpleNamespace(content="Hello "), usage=None)
            yield SimpleNamespace(
                delta=SimpleNamespace(content="there."),
                usage=SimpleNamespace(prompt_tokens=11, completion_tokens=3, prompt_cached_tokens=0),
            )

        ledger = llm.Ledger()
        provider = llm.RecordingProvider(inner, ledger)

        async def go():
            return [chunk async for chunk in provider([{"role": "user", "content": "hi"}])]

        chunks = asyncio.run(go())
        self.assertEqual(len(chunks), 2)
        (entry,) = provider.take()
        self.assertEqual(entry["raw"], "Hello there.")
        self.assertEqual(entry["usage"], {"prompt": 11, "cached": 0, "completion": 3})
        self.assertIsNotNone(entry["first_token"])
        self.assertEqual(provider.take(), [])
        self.assertEqual(ledger.calls["learner"], 1)
        self.assertEqual(ledger.prompt_tokens["learner"], 11)

    def test_a_402_marks_the_ledger_fatal_and_is_scrubbed(self) -> None:
        class PaymentRequired(Exception):
            status_code = 402

        async def inner(_messages):
            raise PaymentRequired(f"Insufficient Balance for {FAKE_KEY}")
            yield  # pragma: no cover

        ledger = llm.Ledger()
        provider = llm.RecordingProvider(inner, ledger, scrub=llm.Scrubber([FAKE_KEY]))

        async def go():
            async for _ in provider([]):
                pass

        with self.assertRaises(PaymentRequired):
            asyncio.run(go())
        self.assertEqual(ledger.fatal, "insufficient_balance")
        (entry,) = provider.take()
        self.assertNotIn(FAKE_KEY, entry["error"])
        self.assertNotIn(FAKE_KEY, " ".join(ledger.errors))


@unittest.skipUnless(HAS_HTTPX, "httpx is not installed")
class HttpClientTests(unittest.TestCase):
    def client(self, handler, ledger=None, **kwargs):
        import httpx

        ledger = ledger or llm.Ledger()
        return llm.HttpxDeepSeek(
            {llm.KEY_NAME: FAKE_KEY},
            ledger,
            transport=httpx.MockTransport(handler),
            sleep=self._sleep,
            **kwargs,
        ), ledger

    async def _sleep(self, seconds):
        self.slept.append(seconds)

    def setUp(self) -> None:
        self.slept: list[float] = []

    def test_a_completion_is_parsed_and_counted_and_the_request_is_shaped(self) -> None:
        import httpx

        seen = {}

        def handler(request):
            seen["auth"] = request.headers["authorization"]
            seen["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": '{"intent": "greet", "text": "Hi"}'}}],
                    "usage": {"prompt_tokens": 20, "completion_tokens": 6, "prompt_cache_hit_tokens": 8},
                },
            )

        client, ledger = self.client(handler)

        async def go():
            try:
                return await client.complete(
                    [{"role": "user", "content": "x"}],
                    model="deepseek-flash",
                    temperature=0.7,
                    max_tokens=100,
                    json_mode=True,
                )
            finally:
                await client.aclose()

        result = asyncio.run(go())
        self.assertEqual(result.text, '{"intent": "greet", "text": "Hi"}')
        self.assertEqual(result.usage, {"prompt": 20, "cached": 8, "completion": 6})
        self.assertEqual(seen["auth"], f"Bearer {FAKE_KEY}")
        self.assertEqual(seen["body"]["thinking"], {"type": "disabled"})
        self.assertEqual(seen["body"]["response_format"], {"type": "json_object"})
        self.assertFalse(seen["body"]["stream"])
        self.assertEqual(ledger.calls["advisor"], 1)
        self.assertNotIn(FAKE_KEY, repr(client))

    def test_a_402_is_final_marks_the_ledger_and_stops_every_later_call(self) -> None:
        import httpx

        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(402, json={"error": {"message": f"Insufficient Balance {FAKE_KEY}"}})

        client, ledger = self.client(handler)

        async def go():
            try:
                with self.assertRaises(llm.InsufficientBalance) as caught:
                    await client.complete([], model="m", temperature=0, max_tokens=5)
                with self.assertRaises(llm.InsufficientBalance):
                    await client.complete([], model="m", temperature=0, max_tokens=5)
                return str(caught.exception)
            finally:
                await client.aclose()

        message = asyncio.run(go())
        self.assertEqual(ledger.fatal, "insufficient_balance")
        self.assertEqual(len(calls), 1)  # the second call never left the machine
        self.assertIn("Top it up", message)
        self.assertNotIn(FAKE_KEY, message)

    def test_429_and_5xx_are_retried_with_backoff_then_succeed(self) -> None:
        import httpx

        answers = [httpx.Response(429, headers={"retry-after": "2"}), httpx.Response(503)]
        good = httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {}})

        def handler(request):
            return answers.pop(0) if answers else good

        client, ledger = self.client(handler)

        async def go():
            try:
                return await client.complete([], model="m", temperature=0, max_tokens=5)
            finally:
                await client.aclose()

        self.assertEqual(asyncio.run(go()).text, "ok")
        self.assertEqual(self.slept, [2.0, 2.0])

    def test_exhausted_retries_and_auth_failures_are_errors_without_the_key(self) -> None:
        import httpx

        client, _ledger = self.client(lambda request: httpx.Response(500), max_attempts=2)

        async def go(client):
            try:
                await client.complete([], model="m", temperature=0, max_tokens=5)
            finally:
                await client.aclose()

        with self.assertRaises(llm.ProviderError) as caught:
            asyncio.run(go(client))
        self.assertIn("gave up", str(caught.exception))
        auth, _ = self.client(lambda request: httpx.Response(401, text=FAKE_KEY))
        with self.assertRaises(llm.ProviderError) as caught:
            asyncio.run(go(auth))
        self.assertNotIn(FAKE_KEY, str(caught.exception))

    def test_a_bad_request_shows_a_scrubbed_body(self) -> None:
        import httpx

        client, _ledger = self.client(lambda request: httpx.Response(400, text=f"bad model {FAKE_KEY}"))

        async def go():
            try:
                await client.complete([], model="m", temperature=0, max_tokens=5)
            finally:
                await client.aclose()

        with self.assertRaises(llm.ProviderError) as caught:
            asyncio.run(go())
        self.assertIn("HTTP 400", str(caught.exception))
        self.assertNotIn(FAKE_KEY, str(caught.exception))

    def test_preflight_stops_on_an_empty_account_and_probes_models_otherwise(self) -> None:
        import httpx

        def empty(request):
            return httpx.Response(200, json={"is_available": False, "balance_infos": [{"total_balance": "-0.01"}]})

        client, ledger = self.client(empty)

        async def go(client, models=("deepseek-flash",)):
            try:
                return await llm.preflight(client, models)
            finally:
                await client.aclose()

        with self.assertRaises(llm.InsufficientBalance):
            asyncio.run(go(client))
        self.assertEqual(ledger.fatal, "insufficient_balance")

        def funded(request):
            if request.url.path.endswith("/user/balance"):
                return httpx.Response(200, json={"is_available": True, "balance_infos": [{"total_balance": "5.00"}]})
            model = json.loads(request.content)["model"]
            if model == "deepseek-missing":
                return httpx.Response(400, text="model not found")
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {}})

        client2, _ = self.client(funded)
        info = asyncio.run(go(client2, ("deepseek-flash", "deepseek-missing")))
        self.assertEqual(info["balance"]["total"], "5.00")
        self.assertEqual(info["models"]["deepseek-flash"], "ok")
        self.assertIn("HTTP 400", info["models"]["deepseek-missing"])


# --------------------------------------------------------------------------------- advisor
class AdvisorTests(unittest.TestCase):
    def test_the_prompt_never_holds_the_learner_persona(self) -> None:
        for level in advisor.ADVISOR_LEVELS:
            prompt = advisor.advisor_system_prompt(level)
            for persona in PERSONAS:
                for need in persona.needs:
                    self.assertNotIn(need.deep, prompt)
                    self.assertNotIn(need.surface, prompt)
                    self.assertNotIn(need.hint, prompt)
                for variant in persona.variants:
                    self.assertNotIn(variant.first_name, prompt)
            self.assertIn("$9000", prompt)
            self.assertIn("JSON", prompt)
        with self.assertRaises(ValueError):
            advisor.advisor_system_prompt("heroic")

    def test_roles_are_swapped_and_the_clock_hint_is_on_the_newest_learner_line(self) -> None:
        history = [
            {"who": "learner", "text": "Hello? Yes, this is Meera speaking."},
            {"who": "advisor", "text": "Hi Meera.", "intent": "greet", "topic": ""},
            {"who": "learner", "text": "I'm doing well."},
        ]
        messages = advisor.advisor_messages("strong", history, 442)
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(json.loads(messages[2]["content"]), {"intent": "greet", "topic": "", "text": "Hi Meera."})
        self.assertTrue(messages[3]["content"].endswith("[CALL CLOCK 07:22 of about 13:00]"))
        self.assertNotIn("CALL CLOCK", messages[1]["content"])
        nudged = advisor.advisor_messages("strong", history, 0, nudge="be the advisor")
        self.assertEqual(nudged[-1], {"role": "system", "content": "be the advisor"})

    def test_parsing(self) -> None:
        turn = advisor.parse_advisor_output('{"intent": "probe", "topic": "H2", "text": " What got in the way? "}')
        self.assertEqual((turn.intent, turn.topic, turn.text, turn.parse_ok), ("probe", "H2", "What got in the way?", True))
        coerced = advisor.parse_advisor_output('{"intent": "yodel", "topic": "H9", "text": "Hello"}')
        self.assertEqual((coerced.intent, coerced.topic), ("other", ""))
        plain = advisor.parse_advisor_output("Hello there, Meera.")
        self.assertFalse(plain.parse_ok)
        self.assertEqual(plain.text, "Hello there, Meera.")
        broken = advisor.parse_advisor_output('{"intent": "probe", "text": ')
        self.assertFalse(broken.parse_ok)
        self.assertEqual(broken.text, "...")

    def test_role_inversion_is_detected(self) -> None:
        for text in (
            "I'd also have to talk to my husband first.",
            "Why should I pay for this when it is free?",
            "My schedule is already packed right now.",
            "I heard people got it for $7,000, can you do that?",
        ):
            with self.subTest(text=text):
                self.assertTrue(advisor.looks_inverted(text))
        for text in (
            "Would it help to talk to your husband?",
            "The course is $9,000 and I can take $500 off.",
            "What does your schedule look like?",
        ):
            with self.subTest(text=text):
                self.assertFalse(advisor.looks_inverted(text))

    def test_the_live_advisor_retries_an_inverted_turn_once(self) -> None:
        completions = [
            '{"intent": "other", "topic": "", "text": "I need to talk to my husband first."}',
            '{"intent": "probe", "topic": "H3", "text": "Who else is part of the decision?"}',
        ]

        class Client:
            def __init__(self):
                self.calls = []

            async def complete(self, messages, **kwargs):
                self.calls.append(messages)
                return SimpleNamespace(text=completions[len(self.calls) - 1], usage={"prompt": 5}, seconds=0.1)

        client = Client()
        live = advisor.LLMAdvisor(client, "deepseek-flash", "strong")

        async def go():
            await live.start("Hello? Yes, this is Meera speaking.")
            return await live.next_turn(None, 12.0, 1)

        turn = asyncio.run(go())
        self.assertEqual(len(client.calls), 2)
        self.assertEqual((turn.intent, turn.topic, turn.inverted, turn.retries), ("probe", "H3", False, 1))
        self.assertEqual(client.calls[1][-1]["role"], "system")  # the nudge
        self.assertEqual(live.history[-1]["text"], "Who else is part of the decision?")

    def test_a_turn_that_stays_inverted_is_flagged_not_hidden(self) -> None:
        text = '{"intent": "other", "topic": "", "text": "I filled in a form last week."}'

        class Client:
            async def complete(self, messages, **kwargs):
                return SimpleNamespace(text=text, usage={}, seconds=0.0)

        live = advisor.LLMAdvisor(Client(), "m", "weak")

        async def go():
            await live.start("Hello?")
            return await live.next_turn(None, 0, 1)

        turn = asyncio.run(go())
        self.assertTrue(turn.inverted)
        self.assertEqual(turn.retries, 1)


# -------------------------------------------------------------------------------- stand-ins
class ScriptedStandInTests(unittest.TestCase):
    def test_the_models_voiced_lines_prove_their_own_move_and_are_not_the_scripted_variants(self) -> None:
        markers = {spec.id: spec.markers for spec in PLAN if spec.markers}
        markers.update({spec.id: spec.markers for spec in SPECS})
        counter_markers = markers["F1-COUNTER"]
        scripted: dict[str, set[str]] = {}
        for spec in PLAN:
            scripted.setdefault(spec.id, set()).update(v.replace("{decision_maker}", "{dm}") for v in (spec.line, *spec.variants))
        for spec in SPECS:
            scripted.setdefault(spec.id, set()).update(v.replace("{decision_maker}", "{dm}") for v in spec.variants)
        for counter in COUNTERS:
            scripted.setdefault("F1-COUNTER", set()).update(counter.variants)
        for bank_id, lines in sl.VOICED.items():
            base = "F1-COUNTER" if bank_id.startswith("F1-COUNTER") else bank_id
            for line in lines:
                for dm in sorted({p.decision_maker for p in PERSONAS}):
                    with self.subTest(bank=bank_id, line=line, dm=dm):
                        filled = line.format(dm=dm)
                        group = (
                            counter_markers
                            if base == "F1-COUNTER"
                            else filled_markers(markers[base], dm)
                        )
                        self.assertTrue(markers_match(group, filled))
                self.assertNotIn(line, scripted.get(base, set()))

    def test_every_voiced_line_and_every_free_line_passes_the_guard(self) -> None:
        for persona in PERSONAS:
            rendered = resolve_persona(persona.id, variant="v1")
            engine = RolePlayEngine(rendered, candidate_first_name="Rohan", seed="guard")
            ctx = engine.guard_context()
            ctx = GuardContext(**{**ctx.__dict__, "advisor_amounts": frozenset({7000, 8500, 9000})})
            lines = [
                f"{sl.REACTIONS[0]} {line.format(dm=persona.decision_maker)}"
                for bank in sl.VOICED.values()
                for line in bank
            ]
            lines += list(sl.FREE_REPLIES) + list(sl.NEXT_STEP_REPLIES) + list(sl.CHECKIN_REPLIES)
            lines += [sl.CHECKIN_DONE_REPLY, sl.SMALL_TALK, *sl.COMMIT_REACTIONS, *sl.CURIOSITY_QUESTIONS.values()]
            for line in lines:
                with self.subTest(persona=persona.id, line=line):
                    result = guard_text(line, ctx)
                    self.assertEqual([hit.rule for hit in result.hits], [])
                    self.assertEqual(result.text, line)

    def test_first_person_conversion(self) -> None:
        self.assertEqual(sl.first_person("your plant is being consolidated next year"), "my plant is being consolidated next year")
        self.assertEqual(sl.first_person("you worry you are too old to start coding"), "I worry I'm too old to start coding")
        self.assertEqual(sl.first_person("learning on your own is not working for you"), "learning on my own is not working for me")

    def _reminder(self, **kwargs):
        persona = resolve_persona("p1_career_switcher", variant="v1")
        return persona, turn_reminder(persona, r_sec=100, **kwargs)

    def _messages(self, reminder, advisor_text="Okay."):
        return [
            {"role": "system", "content": "prefix"},
            {"role": "assistant", "content": "Hello? Yes, this is Meera speaking."},
            {"role": "system", "content": reminder},
            {"role": "user", "content": advisor_text},
        ]

    def test_the_model_voices_an_intent_hint_and_facts_from_the_reminder(self) -> None:
        persona, reminder = self._reminder(intent_brief=PLAN[0].brief, first_probe_topics=("H2",))
        model = sl.ScriptedLearnerLLM("seed", miss_every=0)
        text = model.reply_for(self._messages(reminder))
        self.assertIn(persona.hint("H2"), text)  # the hint answers the probe ...
        self.assertTrue(markers_match(PLAN[0].markers, text))  # ... and the move is raised
        self.assertEqual(model.last_bank, "F3-PRIMARY")
        _persona, deep = self._reminder(intent_brief=PLAN[0].brief, unlocked_topics=("H1",))
        text = model.reply_for(self._messages(deep))
        self.assertIn("my plant is being consolidated", text)  # the facts, in the first person
        self.assertIn("H1", deep_need_topics_in(persona, text))
        self.assertTrue(markers_match(PLAN[0].markers, text))

    def test_a_cooperative_model_keeps_the_move_inside_the_reply_cap(self) -> None:
        persona, reminder = self._reminder(
            intent_brief=PLAN[0].brief, first_probe_topics=("H2",), unlocked_topics=("H1",)
        )
        text = sl.ScriptedLearnerLLM("seed", miss_every=0).reply_for(self._messages(reminder))
        self.assertLessEqual(len(text.split()), sl.MAX_WORDS)
        self.assertTrue(markers_match(PLAN[0].markers, text))  # the hint gives way, not the move
        self.assertIn("consolidated", text)

    def test_a_plain_hint_or_deep_reply_is_told_in_the_first_person(self) -> None:
        persona, hint_only = self._reminder(first_probe_topics=("H3",))
        text = sl.ScriptedLearnerLLM("seed").reply_for(self._messages(hint_only))
        self.assertEqual(text, persona.hint("H3"))
        _persona, deep_only = self._reminder(unlocked_topics=("H2",))
        text = sl.ScriptedLearnerLLM("seed").reply_for(self._messages(deep_only))
        self.assertIn("I quit a free Python course after three weeks", text)
        self.assertIn("H2", deep_need_topics_in(persona, text))

    def test_every_sixth_intent_misses_its_markers_so_the_scripted_variant_runs(self) -> None:
        _persona, reminder = self._reminder(intent_brief=PLAN[2].brief, must_say=("six months",))
        model = sl.ScriptedLearnerLLM("seed", miss_every=3)
        outcomes = [
            markers_match(PLAN[2].markers, model.reply_for(self._messages(reminder))) for _ in range(6)
        ]
        self.assertEqual(outcomes, [True, True, False, True, True, False])

    def test_redirect_curiosity_checkin_and_reaction_only(self) -> None:
        from r1_scheduler import REDIRECT_BRIEF

        persona, reminder = self._reminder(intent_brief=f"{REDIRECT_BRIEF} {PLAN[4].brief}")
        model = sl.ScriptedLearnerLLM("seed", miss_every=0)
        text = model.reply_for(self._messages(reminder))
        self.assertTrue(text.startswith(sl.REDIRECT_OPENER))
        self.assertTrue(markers_match(PLAN[4].markers, text))
        _persona, curious = self._reminder(curiosity="whether the classes are live or recorded")
        self.assertIn("Are the classes live or recorded?", model.reply_for(self._messages(curious)))
        from r1_prompts import CHECKIN_NOTE

        _persona, checkin = self._reminder(notes=(CHECKIN_NOTE,))
        self.assertIn("?", sl.ScriptedLearnerLLM("a").reply_for(self._messages(checkin)) + "?")
        _persona, only = self._reminder(intent_brief="x", reaction_only=True)
        reaction = model.reply_for(self._messages(only))
        self.assertIn(reaction, sl.COMMIT_REACTIONS)

    def test_free_replies_do_not_repeat_within_a_call_and_stay_short(self) -> None:
        model = sl.ScriptedLearnerLLM("seed")
        _persona, reminder = self._reminder()
        seen: list[str] = []
        for _ in range(len(sl.FREE_REPLIES)):
            messages = self._messages(reminder)
            messages[1:1] = [{"role": "assistant", "content": text} for text in seen]
            seen.append(model.reply_for(messages))
        self.assertEqual(len(set(seen)), len(seen))
        self.assertTrue(all(len(text.split()) <= sl.MAX_WORDS for text in seen))

    def test_the_scripted_stream_has_leading_space_tokens_like_a_real_model(self) -> None:
        async def go():
            return [c.delta.content async for c in sl.ScriptedLearnerLLM._stream("one two three")]

        self.assertEqual(asyncio.run(go()), ["one", " two", " three"])

    def test_the_scripted_advisors_probes_are_probes_to_the_engine(self) -> None:
        for topic, lines in sa.PROBES.items():
            for line in lines:
                with self.subTest(topic=topic, line=line):
                    self.assertIn(topic, detect_probes(line))
        for topic, lines in sa.FOLLOWUPS.items():
            for line in lines:
                with self.subTest(topic=topic, line=line):
                    self.assertTrue(detect_followup(line))

    def test_the_scripted_advisor_states_only_deck_figures_except_the_pushy_one(self) -> None:
        allowed = {PRICE_USD, 7000, 8500, 8000, 7500, 500, 1000, 1500, *NET_PRICES_USD}
        banks = [sa.GREET, *sa.PROBES.values(), *sa.FOLLOWUPS.values(), sa.PITCH, sa.VALUE, sa.URGENCY,
                 sa.CLOSE_STRONG, sa.CLOSE_AVERAGE, sa.WEAK_PITCHES, sa.WEAK_DISCOUNT]
        banks += list(sa.ANSWER_STRONG.values()) + list(sa.ANSWER_AVERAGE.values())
        for bank in banks:
            for line in bank:
                with self.subTest(line=line):
                    self.assertLessEqual(metrics._dollar_figures(line), allowed)
        pushy = set().union(*(metrics._dollar_figures(line) for line in sa.PUSHY_LINES))
        self.assertTrue(pushy - allowed)  # the pushy advisor does invent offers
        deck_text = " ".join(fact.text for fact in FACTS)
        self.assertIn("$9000", deck_text)

    def test_the_scripted_advisor_is_deterministic_and_tags_its_turns(self) -> None:
        async def run_level(level):
            a = sa.ScriptedAdvisor(level, "s")
            await a.start("Hello? Yes, this is Meera speaking.")
            turns, last = [], None
            for n in range(1, 9):
                turn = await a.next_turn(last, 60.0 * n, n)
                turns.append(turn)
                last = "Okay, I see."
            return turns

        for level in advisor.ADVISOR_LEVELS:
            first = asyncio.run(run_level(level))
            second = asyncio.run(run_level(level))
            self.assertEqual([t.as_dict() for t in first], [t.as_dict() for t in second])
            self.assertTrue(all(t.intent in advisor.INTENTS for t in first))
        strong = asyncio.run(run_level("strong"))
        self.assertEqual([t.intent for t in strong[:3]], ["greet", "probe", "followup"])
        self.assertEqual([t.topic for t in strong[1:3]], ["H1", "H1"])
        terse = asyncio.run(run_level("terse"))
        self.assertTrue(all(len(t.text.split()) <= 5 for t in terse if t.intent == "other"))
        weak = asyncio.run(run_level("weak"))
        self.assertTrue(all(t.intent in ("pitch", "discount") for t in weak))
        with self.assertRaises(ValueError):
            sa.ScriptedAdvisor("heroic", "s")

    def test_the_scripted_advisor_answers_a_commitment_and_then_says_goodbye(self) -> None:
        async def go():
            a = sa.ScriptedAdvisor("strong", "s")
            await a.start("Hello? Yes, this is Meera speaking.")
            await a.next_turn(None, 10, 1)
            commit = "Let's book a call on Thursday at 7 PM with my husband so we can decide."
            first = await a.next_turn(commit, 560, 2)
            second = await a.next_turn("Okay.", 580, 3)
            third = await a.next_turn("Okay.", 610, 4)
            return first, second, third

        first, second, third = asyncio.run(go())
        self.assertEqual(first.intent, "accept_callback")
        self.assertEqual(second.intent, "other")  # next steps until 10:00
        self.assertEqual(third.intent, "farewell")

    def test_the_shadow_judge_reads_the_advisors_tags_and_speaks_the_judges_json(self) -> None:
        shadow = sl.ScriptedShadowJudge()
        shadow.set_turn({"intent": "probe", "topic": "H2", "text": "What got in the way?"})
        raw = asyncio.run(shadow([]))
        parsed = parse_judge_output(raw)
        self.assertIsNotNone(parsed)
        self.assertEqual(set(parsed.probed_topics), {"H2"})
        shadow.set_turn({"intent": "pitch", "topic": "", "text": "Here is the course."})
        shadow.set_turn({"intent": "discount", "topic": "F1", "text": "I can do $500 off if you decide today."})
        parsed = parse_judge_output(asyncio.run(shadow([])))
        self.assertEqual(parsed.discount_offered_usd, 500)
        self.assertTrue(parsed.discount_conditional)
        self.assertEqual(parsed.family_quality["F1"], 1)


# ----------------------------------------------------------------------------------- judge
class JudgeTests(unittest.TestCase):
    GOOD = {
        "objections": [
            {"family": "F3", "turn": 8, "in_context": True, "canned_verbatim": False, "why": "follows the pitch"},
            {"family": "F2", "turn": 11, "in_context": False, "canned_verbatim": True, "why": "out of nowhere"},
            {"family": "F9", "turn": 12, "in_context": True},
        ],
        "disclosures": [
            {"need": "H1", "probe_turn": 2, "reveal_turn": 3, "emotional": True},
            {"need": "H2", "probe_turn": None, "reveal_turn": 6, "emotional": False},
            {"need": "H7", "probe_turn": 1, "reveal_turn": 2},
        ],
        "misfires": [{"turn": 5, "kind": "repeat"}, {"turn": 6, "kind": "mystery"}],
        "stall_loop": False,
        "style": {"reactions": 4, "followups": 3, "hesitation": 4, "continuity": 5, "variety": 4},
        "ignored_advisor_offers": [{"turn": 15, "offer": "a call tomorrow at 10"}],
    }

    def test_a_valid_verdict_is_normalised_and_junk_entries_are_dropped(self) -> None:
        verdict = judge.parse_verdict("noise " + json.dumps(self.GOOD) + " trailing")
        self.assertEqual(len(verdict["objections"]), 2)
        self.assertEqual(len(verdict["disclosures"]), 2)
        self.assertEqual(verdict["misfires"][1]["kind"], "other")
        found = judge.judge_metrics(verdict)
        self.assertEqual(found["judge_objections"], 2)
        self.assertAlmostEqual(found["judge_objections_in_context_rate"], 0.5)
        self.assertEqual(found["judge_canned_verbatim"], 1)
        self.assertEqual(found["judge_disclosures_probed"], 1)
        self.assertEqual(found["judge_disclosures_revealed"], 1)
        self.assertEqual(found["judge_emotional_reveals"], 1)
        self.assertEqual(found["judge_unprompted_reveals"], 1)
        self.assertEqual(found["judge_misfire_count"], 2)
        self.assertEqual(found["judge_ignored_offers"], 1)
        self.assertAlmostEqual(found["judge_style_mean"], 4.0)

    def test_anything_malformed_is_an_error_never_a_guess(self) -> None:
        for raw in ("", "no json here", "{broken", "[1, 2]", json.dumps({"objections": []}),
                    json.dumps({**self.GOOD, "style": {"reactions": 9, "followups": 3, "hesitation": 3, "continuity": 3, "variety": 3}})):
            with self.subTest(raw=raw[:30]):
                self.assertIn("error", judge.parse_verdict(raw))
        self.assertEqual(judge.judge_metrics({"error": "bad_json"}), {})

    def _record(self):
        return {
            "header": {"persona_id": "p1_career_switcher", "persona_variant": "v1", "seed": "s", "candidate_name": "Rohan"},
            "exchanges": [
                exchange(1, 10, "What made you look now?", "probe", "H1", "Just exploring."),
                exchange(2, 40, "Here is the course.", "pitch", "", None),
            ],
            "metrics": {"reaction_rate": 0.5, "question_rate": 0.2, "near_repeat_count": 0, "weak_line_count": 0, "misfires": []},
        }

    def test_the_judge_may_see_the_hidden_needs_and_the_deck_and_a_numbered_transcript(self) -> None:
        messages = judge.judge_messages(self._record())
        user = messages[1]["content"]
        persona = resolve_persona("p1_career_switcher", variant="v1")
        self.assertIn(persona.deep("H1"), user)
        self.assertIn("$9000", user)
        self.assertIn("[1] ADVISOR: What made you look now?", user)
        self.assertIn("[2] LEARNER: (no reply)", user)
        self.assertIn("Judge ONLY the LEARNER", messages[0]["content"])

    def test_the_live_judge_calls_the_model_at_temperature_zero_in_json_mode(self) -> None:
        seen = {}

        class Client:
            async def complete(self, messages, **kwargs):
                seen.update(kwargs)
                return SimpleNamespace(text=json.dumps(JudgeTests.GOOD), usage={}, seconds=0.0)

        result = asyncio.run(judge.RubricJudge(Client(), "deepseek-v4-pro").judge(self._record()))
        self.assertEqual((seen["temperature"], seen["json_mode"], seen["model"]), (0.0, True, "deepseek-v4-pro"))
        self.assertEqual(result["source"], "llm")
        self.assertEqual(result["metrics"]["judge_objections"], 2)

    def test_the_scripted_judge_returns_the_same_shape(self) -> None:
        record = self._record()
        record["exchanges"][1]["learner"]["plan"] = {"move_id": "F3-PRIMARY", "intent_forced": False}
        record["exchanges"][1]["learner"]["spoken"] = "Why pay when it's free?"
        result = asyncio.run(judge.ScriptedRubricJudge().judge(record))
        self.assertEqual(result["source"], "scripted")
        self.assertEqual(result["verdict"]["objections"][0]["family"], "F3")
        self.assertIn("judge_style_mean", result["metrics"])
        self.assertEqual(judge.parse_verdict(json.dumps(result["verdict"]))["style"], result["verdict"]["style"])


# ------------------------------------------------------------------------------- scorecard
def fake_record(level, *, fails=(), commitment="MEDIUM", slips=None, **extra):
    base = {
        "weak_line_count": 0,
        "roleplay_seconds": 620.0,
        "families_delivered_count": 4,
        "commitment_level": commitment,
        "reply_words_mean": 15.0,
        "reply_words_p90": 24.0,
        "short_reply_share": 0.35,
        "question_rate": 0.4,
        "reaction_rate": 0.6,
        "near_repeat_count": 0,
        "exact_repeat_extra": 0,
        "needs_dug": ["H1"],
        "needs_disclosed_after_dig": ["H1"],
        "unprompted_dump_count": 0,
        "misfire_count": 0,
        "commitment_hits_after_commitment": 0,
        "intents_handed_to_model": 10,
        "intents_fallback_appended": 1,
        "max_slip_sec_by_family": slips or {"F1": 0.0, "F2": 5.0, "F3": 0.0, "F4": 0.0},
        "guard_by_category": {"repeat": 1},
        "guard_hits_total": 1,
        "guard_leak_hits": 0,
        "guard_hygiene_hits": 1,
        "fidelity_passes": True,
        "exchanges": 25,
        "stop_reason": "early_exit",
    }
    base.update(extra)
    return {
        "header": {"advisor_level": level, "seed": f"{level}-{len(fails)}-{commitment}", "offline": False},
        "metrics": base,
        "hard_fails": list(fails),
        "exchanges": [{"advisor": {"inverted": False, "parse_ok": True}}],
        "judge": {
            "source": "llm",
            "metrics": {
                "judge_objections": 4,
                "judge_objections_in_context": 4,
                "judge_misfire_count": 0,
                "judge_style_mean": 4.2,
            },
        },
    }


class ScorecardTests(unittest.TestCase):
    def test_a_clean_live_strong_group_passes_every_gate(self) -> None:
        records = [fake_record("strong", commitment="STRONG") for _ in range(2)]
        card = scorecard.build_scorecard(records, offline=False)
        by = {(g["level"], g["gate"]): g["status"] for g in card["gates"]}
        self.assertEqual(by[("strong", "hard_fails")], "pass")
        self.assertEqual(by[("strong", "in_context")], "pass")
        self.assertEqual(by[("strong", "disclosure")], "pass")
        self.assertEqual(by[("strong", "commit_strong")], "pass")
        self.assertEqual(by[("strong", "fallback")], "pass")
        self.assertFalse(any(g["status"] == "fail" for g in card["gates"]))

    def test_a_weak_advisor_must_never_earn_a_strong_commitment(self) -> None:
        card = scorecard.build_scorecard([fake_record("weak", commitment="STRONG")], offline=False)
        by = {(g["level"], g["gate"]): g["status"] for g in card["gates"]}
        self.assertEqual(by[("weak", "no_strong")], "fail")
        self.assertEqual(by[("weak", "commit_cap")], "fail")

    def test_a_hard_fail_and_a_slow_family_show_up(self) -> None:
        records = [fake_record("average", fails=["weak_stall_repeated"], weak_line_count=2)]
        card = scorecard.build_scorecard(records, offline=False)
        group = card["aggregate"]["average"]
        self.assertEqual(group["hard_fail_rate"], 1.0)
        self.assertEqual(group["hard_fail_reasons"], {"weak_stall_repeated": 1})
        by = {(g["level"], g["gate"]): g["status"] for g in card["gates"]}
        self.assertEqual(by[("average", "hard_fails")], "fail")
        self.assertEqual(by[("average", "weak_once")], "fail")

    def test_an_unmeasured_gate_is_not_a_pass_and_an_offline_sweep_is_never_ready(self) -> None:
        record = fake_record("strong")
        record["judge"] = None
        record["header"]["offline"] = True
        card = scorecard.build_scorecard([record] * 25, offline=True)
        by = {(g["level"], g["gate"]): g["status"] for g in card["gates"]}
        self.assertEqual(by[("strong", "style")], "n/a")
        self.assertEqual(by[("strong", "in_context")], "n/a")
        self.assertFalse(card["readiness"]["ready"])
        self.assertTrue(any("offline" in reason for reason in card["readiness"]["reasons"]))

    def test_ready_needs_a_live_sweep_of_enough_calls_with_every_gate_measured_and_met(self) -> None:
        def sweep(calls_per_level, *, judged=True):
            records = []
            for level in ("strong", "average", "weak", "pushy", "terse"):
                commitment = "STRONG" if level == "strong" else "WEAK"
                for _ in range(calls_per_level):
                    record = fake_record(level, commitment=commitment)
                    if not judged:
                        record["judge"] = None
                    records.append(record)
            return scorecard.build_scorecard(records, offline=False)

        ready = sweep(5)
        self.assertEqual([g for g in ready["gates"] if g["status"] in ("fail", "n/a")], [])
        self.assertTrue(ready["readiness"]["ready"], ready["readiness"])
        self.assertFalse(sweep(3)["readiness"]["ready"])  # 15 calls: too few
        unjudged = sweep(5, judged=False)
        self.assertFalse(unjudged["readiness"]["ready"])
        self.assertTrue(any("not measured" in reason for reason in unjudged["readiness"]["reasons"]))

    def test_markdown_and_diff(self) -> None:
        records = [fake_record("strong", fails=["fact_error"], commitment="STRONG"), fake_record("weak")]
        card = scorecard.build_scorecard(records, offline=True, header={"content_sha256": "ab" * 32, "git_sha": "c" * 40, "harness_version": 1})
        text = scorecard.render_markdown(card, records)
        self.assertIn("OFFLINE", text)
        self.assertIn("| metric | strong | weak | all |", text)
        self.assertIn("Calls with hard fails", text)
        self.assertIn("fact_error", text)
        self.assertIn("Ready for an owner test: NO", text)
        diff = scorecard.diff_markdown(card, card)
        self.assertIn("| strong | hard_fail_rate |", diff)

    def test_guard_hits_per_call_are_a_gate_and_a_per_call_table(self) -> None:
        """R1-Q round 2 (R1-5): the reworded reaction prompts must be proved on a live sweep that
        reports guard hits per call; one call over the line fails the sweep's mean."""
        clean = [fake_record("strong", commitment="STRONG") for _ in range(2)]
        card = scorecard.build_scorecard(clean, offline=False)
        by = {(g["level"], g["gate"]): g for g in card["gates"]}
        self.assertEqual(by[("strong", "guard_per_call")]["status"], "pass")
        self.assertEqual(card["aggregate"]["strong"]["guard_hits_per_call"], 1.0)
        noisy = [
            fake_record("strong", commitment="STRONG", guard_hits_total=4,
                        guard_by_category={"invented_fact": 3, "repeat": 1}),
            fake_record("strong", commitment="STRONG", guard_hits_total=0, guard_by_category={}),
        ]
        card = scorecard.build_scorecard(noisy, offline=False)
        group = card["aggregate"]["strong"]
        self.assertEqual((group["guard_hits_per_call"], group["guard_hits_max_per_call"]), (2.0, 4.0))
        self.assertEqual(group["invented_fact_hits_per_call"], 1.5)
        by = {(g["level"], g["gate"]): g["status"] for g in card["gates"]}
        self.assertEqual(by[("strong", "guard_per_call")], "fail")
        self.assertFalse(card["readiness"]["ready"])
        text = scorecard.render_markdown(card, noisy)
        self.assertIn("## Guard hits per call", text)
        self.assertIn("| 4 | 0 | 1 | invented_fact 3, repeat 1 |", text)
        self.assertIn("guard hits / call (worst)", text)
        # An export without guard data is not measured, never a pass.
        bare = fake_record("strong", commitment="STRONG")
        for key in ("guard_hits_total", "guard_leak_hits", "guard_hygiene_hits"):
            del bare["metrics"][key]
        card = scorecard.build_scorecard([bare], offline=False)
        by = {(g["level"], g["gate"]): g["status"] for g in card["gates"]}
        self.assertEqual(by[("strong", "guard_per_call")], "n/a")
        self.assertNotIn("## Guard hits per call", scorecard.render_markdown(card, [bare]))

    def test_the_inversion_rate_is_only_measured_for_a_live_advisor(self) -> None:
        live = fake_record("strong")
        live["exchanges"] = [{"advisor": {"inverted": True, "parse_ok": True}}, {"advisor": {"inverted": False, "parse_ok": False}}]
        offline = fake_record("strong")
        offline["header"]["offline"] = True
        group = scorecard.aggregate([live, offline])["strong"]
        self.assertAlmostEqual(group["advisor_inversion_rate"], 0.5)
        self.assertAlmostEqual(group["advisor_parse_failure_rate"], 0.5)


# ------------------------------------------------------------------------------------ runner
class PlanningTests(unittest.TestCase):
    def test_levels_and_aliases(self) -> None:
        self.assertEqual(run.parse_levels("strong, pushy-discounter,short-answers,strong"), ("strong", "pushy", "terse"))
        self.assertEqual(run.parse_levels("all"), advisor.ADVISOR_LEVELS)
        with self.assertRaises(ValueError):
            run.parse_levels("heroic")
        with self.assertRaises(ValueError):
            run.parse_levels(" , ")

    def test_learner_personas_may_be_given_by_prefix(self) -> None:
        self.assertEqual(run.parse_learners("p1,p3_data_analyst"), ("p1_career_switcher", "p3_data_analyst"))
        self.assertEqual(len(run.parse_learners("all")), 4)
        with self.assertRaises(ValueError):
            run.parse_learners("p9")

    def test_a_sweep_covers_every_level_and_every_learner(self) -> None:
        specs = run.plan_specs(advisor.ADVISOR_LEVELS, [p.id for p in PERSONAS], 20)
        self.assertEqual({(s.advisor_level, s.persona_id) for s in specs}, {(l, p.id) for l in advisor.ADVISOR_LEVELS for p in PERSONAS})
        self.assertEqual(len({s.seed for s in specs}), 20)
        short = run.plan_specs(advisor.ADVISOR_LEVELS, [p.id for p in PERSONAS], 5)
        self.assertEqual([s.advisor_level for s in short], list(advisor.ADVISOR_LEVELS))
        again = run.plan_specs(advisor.ADVISOR_LEVELS, [p.id for p in PERSONAS], 40)
        self.assertEqual({s.persona_variant for s in again}, {"v1", "v2"})

    def test_the_matrix_presets(self) -> None:
        args = run.build_parser().parse_args(["--matrix", "smoke"])
        settings = run.settings_from_args(args)
        self.assertEqual((settings.calls, settings.levels), (4, ("strong",)))
        settings = run.settings_from_args(run.build_parser().parse_args(["--matrix", "sweep", "--calls", "7"]))
        self.assertEqual((settings.calls, settings.levels), (7, advisor.ADVISOR_LEVELS))
        with self.assertRaises(ValueError):
            run.settings_from_args(run.build_parser().parse_args(["--calls", "0"]))


class OfflineCallTests(unittest.TestCase):
    def test_one_scripted_call_end_to_end(self) -> None:
        settings = run.Settings(offline=True)
        factory = run.OfflineFactory(settings)
        spec = CallSpec("p2_recent_grad", "v1", "strong", 0, "Rohan")
        record = asyncio.run(run_call(spec, factory.make(spec)))
        self.assertIsNone(record["error"])
        self.assertEqual(record["stop_reason"], "early_exit")
        self.assertEqual(record["header"]["tier"], "rig")
        self.assertTrue(record["header"]["offline"])
        self.assertEqual(record["metrics"]["commitment_level"], "STRONG")
        self.assertEqual(record["hard_fails"], [])
        # rows are in the database export schema and carry their exchange number
        self.assertTrue(all({"turn_index", "phase", "speaker", "text", "interrupted", "exchange"} <= set(r) for r in record["rows"]))
        self.assertEqual(record["rows"][0]["speaker"], "bot")
        self.assertTrue(all(r["phase"] == "roleplay" for r in record["rows"]))
        # every exchange keeps the raw model text, the plan and the clock
        first = record["exchanges"][0]
        self.assertEqual(set(first), {"n", "r_sec", "advisor", "learner", "clock"})
        self.assertIn("raw", first["learner"])
        self.assertGreater(record["exchanges"][-1]["r_sec"], record["exchanges"][0]["r_sec"])
        # the posted events carry no pins and never a repeat (hygiene) guard row
        self.assertTrue(record["posted_events"])
        self.assertTrue(all("pins" not in e["payload"] for e in record["posted_events"]))
        self.assertTrue(all(e["payload"].get("kind") != "other" for e in record["posted_events"] if e["event_type"] == "guard_hit"))
        json.dumps(record)  # the record is JSON

    def test_the_clock_makes_the_schedule_and_the_close_window_happen(self) -> None:
        settings = run.Settings(offline=True)
        spec = CallSpec("p1_career_switcher", "v1", "average", 0, "Rohan")
        record = asyncio.run(run_call(spec, run.OfflineFactory(settings).make(spec)))
        self.assertGreaterEqual(record["metrics"]["families_delivered_count"], 4)
        self.assertGreaterEqual(record["roleplay_seconds"], 600)
        self.assertLessEqual(record["roleplay_seconds"], 840)
        self.assertEqual(record["admin_log"]["commitment"]["level"], "WEAK")

    def test_a_broken_advisor_is_a_recorded_failure_not_a_crash(self) -> None:
        class Boom:
            async def start(self, _pickup):
                return None

            async def next_turn(self, *_args):
                raise RuntimeError("simulator exploded")

        deps = run.OfflineFactory(run.Settings(offline=True)).make(CallSpec("p1_career_switcher"))
        deps.advisor = Boom()
        record = asyncio.run(run_call(CallSpec("p1_career_switcher"), deps))
        self.assertIn("simulator exploded", record["error"])
        self.assertEqual(record["stop_reason"], "exception")
        self.assertIn("exception", record["hard_fails"])
        self.assertTrue(record["rows"])  # the pickup line survived

    def test_a_402_mid_call_stops_the_call_cleanly(self) -> None:
        class PaidOut:
            async def start(self, _pickup):
                return None

            async def next_turn(self, *_args):
                raise llm.InsufficientBalance(llm.TOP_UP_MESSAGE)

        deps = run.OfflineFactory(run.Settings(offline=True)).make(CallSpec("p1_career_switcher"))
        deps.advisor = PaidOut()
        record = asyncio.run(run_call(CallSpec("p1_career_switcher"), deps))
        self.assertEqual(record["stop_reason"], "insufficient_balance")
        self.assertIsNone(record["error"])


class CliTests(unittest.TestCase):
    def test_an_offline_sweep_writes_every_artifact_and_prints_the_scorecard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lines: list[str] = []
            settings = run.Settings(offline=True, calls=5, levels=advisor.ADVISOR_LEVELS, learners=("p4_research_scholar",))
            code = asyncio.run(run.run_all(settings, Path(tmp), lines.append))
            self.assertEqual(code, run.EXIT_OK)
            out = Path(tmp)
            self.assertEqual(sorted(p.name for p in (out / "calls").glob("*.json")), sorted(f"p4_research_scholar-v1-{lv}-0.json" for lv in advisor.ADVISOR_LEVELS))
            summaries = [json.loads(line) for line in (out / "results.jsonl").read_text().splitlines()]
            self.assertEqual(len(summaries), 5)
            card = json.loads((out / "scorecard.json").read_text())
            self.assertTrue(card["offline"])
            self.assertEqual(card["aggregate"]["all"]["calls"], 5)
            self.assertIn("OFFLINE", (out / "scorecard.md").read_text())
            runfile = json.loads((out / "run.json").read_text())
            self.assertIsNone(runfile["stopped"])
            self.assertEqual(runfile["completed_calls"], 5)
            self.assertTrue(any("Done: 5 calls" in line for line in lines))

    def test_main_returns_the_exit_codes_and_a_baseline_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "a"
            second = Path(tmp) / "b"
            argv = ["--offline", "--calls", "2", "--personas", "strong,weak", "--learners", "p1", "--out"]
            with mock.patch("builtins.print"):
                self.assertEqual(run.main([*argv, str(first)]), run.EXIT_OK)
                self.assertEqual(run.main([*argv, str(second), "--baseline", str(first)]), run.EXIT_OK)
                self.assertEqual(run.main(["--personas", "nope"]), run.EXIT_ERROR)
            self.assertTrue((second / "diff.md").is_file())
            self.assertEqual(
                [json.loads(l)["advisor_level"] for l in (first / "results.jsonl").read_text().splitlines()],
                ["strong", "weak"],
            )

    def test_strict_fails_when_a_hard_fail_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            settings = run.Settings(offline=True, calls=1, levels=("strong",), learners=("p1_career_switcher",), strict=True)
            with mock.patch.object(run, "run_call", new=_failing_call(run.run_call)):
                code = asyncio.run(run.run_all(settings, Path(tmp), lambda _line: None))
            self.assertEqual(code, run.EXIT_STRICT)

    def test_the_process_pool_runs_offline_calls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            settings = run.Settings(offline=True, calls=2, levels=("strong", "weak"), learners=("p3_data_analyst",), jobs=2)
            code = asyncio.run(run.run_all(settings, Path(tmp), lambda _line: None))
            self.assertEqual(code, run.EXIT_OK)
            self.assertEqual(len(list((Path(tmp) / "calls").glob("*.json"))), 2)


def _failing_call(real):
    async def wrapper(spec, deps):
        record = await real(spec, deps)
        record["hard_fails"] = ["fact_error"]
        return record

    return wrapper


@unittest.skipUnless(HAS_HTTPX and HAS_LIVE_LEARNER, "httpx or the livekit openai plugin is missing")
class MockDeepSeekEndToEndTests(unittest.TestCase):
    """The LIVE code path (production client class, SSE parsing, usage, the judge client) against
    an in-process stand-in for the DeepSeek API: the nearest thing to a funded run without one."""

    def _clients(self, requests):
        import httpx
        import openai
        from livekit.plugins import openai as lk_openai

        if not hasattr(lk_openai.LLM, "chat"):
            # Another test module (test_instrumentation, through the routing tests' phone fixtures)
            # replaces the plugin with a stand-in in a shared pytest process.
            self.skipTest("livekit.plugins.openai is a stand-in in this process")

        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            messages = body["messages"]
            if "strict, silent observer" in messages[0]["content"]:
                text = json.dumps({"probed_topics": [], "family_handled_quality": {}, "urgency_lever": False})
            else:
                text = sl.ScriptedLearnerLLM("stub", miss_every=0).reply_for(messages)
            events = []
            words = text.split(" ")
            for index, word in enumerate(words):
                delta = {"content": word if index == 0 else " " + word}
                if index == 0:
                    delta["role"] = "assistant"
                events.append({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
            events.append({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            events.append(
                {
                    "choices": [],
                    "usage": {"prompt_tokens": 120, "completion_tokens": len(words), "total_tokens": 120 + len(words),
                              "prompt_tokens_details": {"cached_tokens": 40}},
                }
            )
            payload = "".join(f"data: {json.dumps({'id': 'x', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'deepseek-flash', **event})}\n\n" for event in events)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=(payload + "data: [DONE]\n\n").encode())

        def build(temperature):
            client = openai.AsyncClient(
                api_key=FAKE_KEY,
                base_url="https://api.deepseek.com/v1",
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            )
            return lk_openai.LLM(
                model="deepseek-flash",
                client=client,
                temperature=temperature,
                reasoning_effort="none",
                extra_body={"thinking": {"type": "disabled"}, "max_tokens": 300},
            )

        return build(0.6), build(0.0)

    def test_a_call_through_the_production_client_class_is_recorded_and_costed(self) -> None:
        requests: list[dict] = []
        learner, judge_llm = self._clients(requests)
        ledger = llm.Ledger()
        env = {llm.KEY_NAME: FAKE_KEY}
        spec = CallSpec("p3_data_analyst", "v1", "strong", 0, "Rohan", max_exchanges=7)
        deps = CallDeps(
            provider=llm.make_live_learner_provider(env, ledger, learner=learner),
            advisor=sa.ScriptedAdvisor("strong", spec.seed),
            judge_runner=llm.make_live_judge_runner(env, ledger, judge_llm=judge_llm),
            ledger=ledger,
            scrub=llm.Scrubber([FAKE_KEY]),
            offline=False,
        )
        record = asyncio.run(run_call(spec, deps))
        self.assertIsNone(record["error"])
        self.assertEqual(record["stop_reason"], "max_exchanges")
        self.assertEqual(len(record["exchanges"]), 7)
        spoken = [ex["learner"]["spoken"] for ex in record["exchanges"]]
        self.assertTrue(all(spoken))
        # the raw model text and the token usage were captured from the real chunk objects
        self.assertTrue(all(ex["learner"]["raw"] for ex in record["exchanges"]))
        self.assertEqual(ledger.calls["learner"], 7)
        self.assertEqual(ledger.prompt_tokens["learner"], 7 * 120)
        self.assertEqual(ledger.cached_tokens["learner"], 7 * 40)
        self.assertGreater(ledger.calls["shadow_judge"], 0)
        self.assertGreater(ledger.cost_usd, 0)
        self.assertGreater(record["metrics"]["learner_ttft_p50"], 0)
        # the request is the production request: the model, thinking off, the sampling per role
        learner_calls = [r for r in requests if "strict, silent observer" not in r["messages"][0]["content"]]
        judge_calls = [r for r in requests if "strict, silent observer" in r["messages"][0]["content"]]
        self.assertEqual(len(learner_calls), 7)
        for body in learner_calls:
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["temperature"], 0.6)
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertTrue(body["stream"])
            self.assertNotIn("tools", body)
            self.assertNotIn("developer", {m["role"] for m in body["messages"]})
        for body in judge_calls:
            self.assertEqual(body["temperature"], 0.0)
        # the engine saw the judge's verdicts through the live runner
        self.assertGreater(record["admin_log"]["tracker"]["judge"]["applied"], 0)
        self.assertNotIn(FAKE_KEY, json.dumps(record))

    def test_the_live_judge_runner_survives_a_provider_error_and_marks_a_402(self) -> None:
        class PaymentRequired(Exception):
            status_code = 402

        class Broken:
            def chat(self, **_kwargs):
                raise PaymentRequired("Insufficient Balance")

        ledger = llm.Ledger()
        runner = llm.make_live_judge_runner({llm.KEY_NAME: FAKE_KEY}, ledger, judge_llm=Broken())
        with self.assertRaises(PaymentRequired):
            asyncio.run(runner([{"role": "user", "content": "x"}]))
        self.assertEqual(ledger.fatal, "insufficient_balance")


@unittest.skipUnless(HAS_HTTPX, "httpx is not installed")
class NoBalanceTests(unittest.TestCase):
    """HTTP 402 / insufficient balance stops a live sweep cleanly, with a clear message."""

    ENV = {llm.KEY_NAME: FAKE_KEY}

    @staticmethod
    def handler(*, balance_ok: bool):
        import httpx

        def handle(request):
            if request.url.path.endswith("/user/balance"):
                return httpx.Response(200, json={"is_available": balance_ok, "balance_infos": [{"currency": "USD", "total_balance": "-0.01"}]})
            return httpx.Response(402, json={"error": {"message": f"Insufficient Balance ({FAKE_KEY})"}})

        return handle

    def _run(self, out, *, balance_ok, preflight):
        import httpx

        settings = run.Settings(
            offline=False, calls=3, levels=("strong",), learners=("p1_career_switcher",), preflight=preflight
        )
        transport = httpx.MockTransport(self.handler(balance_ok=balance_ok))
        real = REAL_LIVE_FACTORY
        lines: list[str] = []
        with mock.patch.object(run, "LiveFactory", lambda s: real(s, self.ENV, transport=transport)):
            code = asyncio.run(run.run_all(settings, out, lines.append))
        return code, lines

    def test_the_preflight_stops_before_any_call(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, lines = self._run(Path(tmp), balance_ok=False, preflight=True)
            self.assertEqual(code, run.EXIT_NO_BALANCE)
            runfile = json.loads((Path(tmp) / "run.json").read_text())
            self.assertEqual(runfile["stopped"], "insufficient_balance")
            self.assertEqual(runfile["completed_calls"], 0)
            self.assertIn("Top it up", runfile["message"])
            self.assertTrue(any("STOPPED: insufficient_balance" in line for line in lines))
            self.assertFalse((Path(tmp) / "calls").exists())
            self._assert_no_key(Path(tmp), lines)

    @unittest.skipUnless(HAS_LIVE_LEARNER, "the livekit openai plugin is not installed")
    def test_a_402_on_the_first_advisor_call_stops_the_sweep_with_partial_results(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, lines = self._run(Path(tmp), balance_ok=True, preflight=False)
            self.assertEqual(code, run.EXIT_NO_BALANCE)
            runfile = json.loads((Path(tmp) / "run.json").read_text())
            self.assertEqual(runfile["stopped"], "insufficient_balance")
            self.assertEqual(runfile["completed_calls"], 0)  # the cut-short call is not a result
            self.assertEqual(runfile["aborted_calls"], 1)
            self.assertEqual(runfile["planned_calls"], 3)
            self.assertFalse((Path(tmp) / "scorecard.json").exists())  # nothing to score
            record = json.loads(next((Path(tmp) / "calls").glob("*.json")).read_text())
            self.assertEqual(record["stop_reason"], "insufficient_balance")
            self.assertIsNone(record["error"])
            self.assertTrue(record["rows"])  # the pickup line is there
            self._assert_no_key(Path(tmp), lines)

    def test_a_missing_key_is_exit_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            settings = run.Settings(offline=False, calls=1)
            with mock.patch.object(run, "load_api_env", side_effect=llm.MissingKey("no key")):
                code = asyncio.run(run.run_all(settings, Path(tmp), lambda _l: None))
            self.assertEqual(code, run.EXIT_NO_KEY)
            self.assertEqual(json.loads((Path(tmp) / "run.json").read_text())["stopped"], "missing_key")

    @staticmethod
    def _assert_no_key(folder: Path, lines) -> None:
        for path in folder.rglob("*"):
            if path.is_file():
                assert FAKE_KEY not in path.read_text(encoding="utf-8", errors="replace"), path
        assert not any(FAKE_KEY in line for line in lines)


if __name__ == "__main__":
    unittest.main()
