"""R1-Q regression: the owner's 4/10 call (session b58c7d9c) against the current learner engine.

``tests/fixtures/r1_owner_b58c7d9c.json`` is that session as a database export.  Two things are
pinned here:

* the HARNESS can fail it: the deterministic metrics find exactly what the owner complained about
  (the WEAK stall six times, the catch-all deflection twice, "there" instead of a name three
  times, two goodbyes and "hiring team" twice in the wrap-up, a dozen repeated learner
  sentences).  A harness that cannot fail this transcript proves nothing.
* the ENGINE no longer does it: the advisor's turns are replayed through a real ``R1Interview``
  (``tests.test_r1_integration.Rig``, the same hooks the live session runs) with the scripted
  stand-in for the model.  The replayed learner never says the stall twice, never deflects,
  never meets the turn-34 discovery question with an objection, reacts to the turn-63 callback
  offer without the stall line or a day and time, does not say "before you go" to a trailing
  "Bye" and repeats no sentence word for word.

The fake model does not say what the real bot said, so the replayed timeline drifts from the
original after the first divergence; these are invariants, not a line-by-line match.  Offline,
no network, no key.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from rehearsal import metrics, replay
from rehearsal.scripted_learner import ScriptedLearnerLLM
from r1_commitment import stall_line
from r1_text import fuzzy_contains

OLD_WEAK_TURNS = [61, 67, 81, 87, 90, 92]
OLD_DEFLECTION_TURNS = [44, 69]
TURN_34_GROUP = 4  # rows 32-34, the "friction or blocker" discovery question
TURN_52_GROUP = 10  # row 51 ends "... So yeah. Bye": a trailing STT tail, not a farewell
CALLBACK_GROUP = 15  # rows 62-66, "Can we do a schedule to call back tomorrow? ... 10:00 a.m."
TIME_CUE_GROUP = 18  # rows 78: where the original learner's time cue (turn 79) landed
STALL_GROUP = 22  # the first group at or after 13:00 in the replay (original stall: turn 92)
CALLBACK_HUSBAND_GROUP = 18  # rows 78: "when you call me back, I can also talk to your husband ..."
WEAK = stall_line("")
FIXTURE = replay.load_fixture()


class OwnerSessionCalibrationTests(unittest.TestCase):
    """The metrics fail the 4/10 session for the reasons the owner gave."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = FIXTURE["rows"]
        cls.found = metrics.row_metrics(cls.rows)
        cls.replies = metrics.learner_replies(cls.rows)

    def test_the_stall_is_found_at_the_six_owner_turns(self) -> None:
        turns = [int(self.replies[index]["turn_index"]) for index in self.found["weak_line_rows"]]
        self.assertEqual(turns, OLD_WEAK_TURNS)
        self.assertEqual(self.found["weak_line_count"], 6)

    def test_the_catch_all_deflection_is_found_twice(self) -> None:
        turns = [int(self.replies[index]["turn_index"]) for index in self.found["deflection_rows"]]
        self.assertEqual(turns, OLD_DEFLECTION_TURNS)

    def test_twelve_sentences_were_repeated_word_for_word(self) -> None:
        self.assertGreaterEqual(self.found["exact_repeat_extra"], 12)
        repeated = {item["sentence"] for item in self.found["exact_repeats"]}
        self.assertIn("let me think about it", repeated)
        self.assertIn("just email me the details and ill get back to you", repeated)
        self.assertIn("ive tried a bit of online stuff before", repeated)
        self.assertTrue(self.found["long_exact_repeat"])

    def test_the_name_fallback_the_double_goodbye_and_the_repeated_phrase_are_found(self) -> None:
        self.assertEqual(self.found["name_fallback_rows"], [1, 16, 101])
        self.assertEqual(self.found["farewell_row_ids"], [100, 101])
        self.assertEqual(self.found["repeated_phrase_row_ids"], [97])

    def test_the_candidate_was_fragmented_into_two_rows_a_reply_and_seven_at_most(self) -> None:
        self.assertAlmostEqual(self.found["candidate_rows_per_reply_mean"], 2.125, places=3)
        self.assertEqual(self.found["candidate_rows_per_reply_max"], 7)

    def test_the_length_was_not_the_defect(self) -> None:
        self.assertEqual(self.found["reply_count"], 23)
        self.assertAlmostEqual(self.found["reply_words_mean"], 17.17, places=1)
        self.assertEqual(self.found["reply_words_p90"], 22.0)
        self.assertEqual(self.found["over_cap_replies"], 0)

    def test_the_call_has_no_fact_error(self) -> None:
        # The learner's mistakes were behavioural; its numbers were the deck's.
        self.assertEqual(self.found["fact_error_count"], 0)

    def test_every_hard_fail_that_applies_to_the_rows_fires(self) -> None:
        fails = metrics.hard_fails(self.found)
        for reason in (
            "weak_stall_repeated",
            "catch_all_deflection",
            "exact_repeat_sentence",
            "name_fallback",
            "double_goodbye",
            "repeated_phrase_in_row",
        ):
            with self.subTest(reason=reason):
                self.assertIn(reason, fails)


class ReplayTimelineTests(unittest.TestCase):
    """The replay clock reproduces the two moments the original schedule is anchored on."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.groups = replay.advisor_groups(FIXTURE["rows"])
        cls.targets = replay.timeline(cls.groups)

    def test_the_owner_call_is_23_answered_advisor_turns_and_a_last_one(self) -> None:
        self.assertEqual(len(self.groups), 24)
        # The 24th (row 93, "And then I just emailed you the details") got no learner reply:
        # the role-play ended on it.
        self.assertIsNone(self.groups[-1]["old_reply_row"])
        self.assertTrue(all(group["old_reply_row"] is not None for group in self.groups[:-1]))
        self.assertEqual(self.groups[TURN_34_GROUP - 1]["rows"], (32, 33, 34))
        self.assertEqual(self.groups[CALLBACK_GROUP - 1]["rows"], (62, 63, 64, 66))
        self.assertEqual(self.groups[TURN_52_GROUP - 1]["rows"], (51,))

    def test_the_time_cue_lands_in_its_window_and_the_stall_after_13_00(self) -> None:
        self.assertTrue(660 <= self.targets[TIME_CUE_GROUP - 1] < 780, self.targets[TIME_CUE_GROUP - 1])
        self.assertGreaterEqual(self.targets[-1], 780)
        self.assertGreaterEqual(self.targets[STALL_GROUP - 1], 780)

    def test_the_timeline_only_moves_forward(self) -> None:
        self.assertEqual(self.targets, sorted(self.targets))


class ReplayInvariantTests(unittest.TestCase):
    """The advisor turns of the 4/10 call, answered by the current engine."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.result = asyncio.run(
            replay.replay(FIXTURE["rows"], ScriptedLearnerLLM("replay-b58c7d9c"))
        )
        cls.turns = cls.result["turns"]
        cls.found = cls.result["metrics"]
        cls.spoken = [turn.spoken for turn in cls.turns if turn.spoken]

    def test_the_whole_call_is_replayed(self) -> None:
        # Round 1 tightened the e-mail and callback detectors (a pitch about recordings or "the next
        # session" is no offer or proposal), so the families finish earlier and the advisor's
        # turn-78 offer to include the husband earns the MEDIUM call at group 18; the role-play
        # ends there, as it does in a live call.
        self.assertGreaterEqual(len(self.turns), 17)
        self.assertTrue(all(turn.plan is not None for turn in self.turns))
        commitment = self.result["admin_log"]["commitment"]
        self.assertEqual((commitment["level"], commitment["resolved"]), ("MEDIUM", True))
        self.assertEqual(self.turns[-1].group, CALLBACK_HUSBAND_GROUP)
        self.assertEqual(self.turns[-1].mode, "say_only")

    def test_the_stall_is_never_said_twice(self) -> None:
        self.assertLessEqual(self.found["weak_line_count"], 1)
        said = [t for t in self.turns if t.spoken and fuzzy_contains(t.spoken, WEAK)]
        self.assertLessEqual(len(said), 1)
        for turn in said:
            # The one stall is the 13:00 end-game line: a reaction, then the line, resolved.
            self.assertGreaterEqual(turn.r_sec, 780)
            self.assertTrue(turn.plan["resolves"])

    def test_no_stall_phrase_before_the_close_window(self) -> None:
        for turn in self.turns:
            if turn.r_sec < 540 and turn.spoken:
                with self.subTest(group=turn.group):
                    self.assertFalse(fuzzy_contains(turn.spoken, WEAK))
                    self.assertNotIn("email me the details", turn.spoken.lower())

    def test_the_catch_all_deflection_is_gone(self) -> None:
        self.assertEqual(self.found["deflection_count"], 0)
        self.assertEqual(self.found["fallback_reply_count"], 0)

    def test_the_turn_34_discovery_question_gets_a_hint_not_an_objection(self) -> None:
        turn = self.turns[TURN_34_GROUP - 1]
        self.assertFalse((turn.plan["move_id"] or "").startswith("F3"), turn.plan)
        self.assertEqual(turn.mode, "llm_reply")
        # H2 ("friction or blocker") is probed for the first time: the hint layer.
        self.assertIn("first real question about", turn.reminder)
        self.assertIn("what has held you back", turn.reminder)
        # ... and H1 ("why are you looking at our programs") is probed again: the facts.
        self.assertIn("digging further into", turn.reminder)
        self.assertTrue(turn.spoken)
        self.assertNotIn("YouTube", turn.spoken)

    def test_the_callback_offer_is_met_with_a_reaction_not_the_stall(self) -> None:
        turn = self.turns[CALLBACK_GROUP - 1]
        plan = turn.plan
        recognised = ("stall_reason:", "ask_yields_to_owed_move", "ask_in_window:", "commitment_on_record")
        self.assertTrue(any(r.startswith(recognised) for r in plan["reasons"]), plan["reasons"])
        self.assertIn(turn.mode, ("intent", "llm_reply"))
        self.assertTrue(turn.spoken)
        self.assertFalse(fuzzy_contains(turn.spoken, WEAK))
        previous = self.turns[CALLBACK_GROUP - 2].spoken
        self.assertNotEqual(turn.spoken, previous)
        # The learner is never handed the day or the time to repeat (and agree to).
        for word in ("tomorrow", "10:00", "8:00"):
            self.assertNotIn(word, turn.reminder.lower())
        self.assertNotIn("tomorrow", turn.spoken.lower())

    def test_a_callback_that_yields_to_a_forced_move_still_gets_a_reaction(self) -> None:
        """Round 1: the callback of rows 62-66 was answered with a price question that ignored it.

        Whenever an ask or callback yields to an owed move that is not the F4 stall, the learner is
        also told to react to the proposal (in a few words, without agreeing)."""
        seen = 0
        for turn in self.turns:
            reasons = turn.plan["reasons"]
            if "ask_yields_to_owed_move" in reasons and not (turn.plan["move_id"] or "").startswith("F4"):
                seen += 1
                self.assertIn("The advisor just proposed a call or a next step", turn.reminder)
        callback = self.turns[CALLBACK_GROUP - 1]
        self.assertIn("ask_yields_to_owed_move", callback.plan["reasons"])
        self.assertTrue((callback.plan["move_id"] or "").startswith("F4") or seen >= 1)

    def test_no_stall_reason_is_voiced_twice(self) -> None:
        """Round 1: N-TIMING then F4-PRIMARY was "wait a little longer" twice in six turns."""
        voicings = self.result["admin_log"]["negotiation"]["reason_voicings"]
        self.assertTrue(voicings, "the F4 pair voices timing and the decision maker")
        for reason, count in voicings.items():
            with self.subTest(reason=reason):
                self.assertEqual(count, 1)
        self.assertEqual(self.found["stall_reason_repeats"], 0)
        self.assertNotIn("stall_reason_repeated", metrics.hard_fails(self.found))

    def test_no_pleasant_surprise_for_an_amount_that_was_already_offered(self) -> None:
        """Round 1: group 18 primed "a better price on the table: $8,500" after $8,500 was offered."""
        primed: list[str] = []
        for turn in self.turns:
            for line in (turn.reminder or "").splitlines():
                if "put a better price on the table" in line:
                    primed.append(line)
        self.assertEqual(len(primed), len(set(primed)), primed)
        offered = [offer["net_usd"] for offer in self.result["admin_log"]["negotiation"]["offers"]]
        self.assertEqual(offered, sorted(set(offered), reverse=True))

    def test_the_counter_follows_the_advisors_real_answer(self) -> None:
        counter = next(t for t in self.turns if t.plan["move_id"] == "F1-COUNTER")
        self.assertIn("came down a little", counter.reminder)  # $8,500: short of the ask
        self.assertEqual(self.result["admin_log"]["negotiation"]["price_situation"], "short")

    def test_a_trailing_bye_is_not_an_early_farewell(self) -> None:
        turn = self.turns[TURN_52_GROUP - 1]
        self.assertNotIn("close_attempt_redirect", turn.plan["reasons"])
        self.assertNotIn("before you go", (turn.spoken or "").lower())
        for other in self.turns:
            self.assertNotIn("before you go", (other.spoken or "").lower())

    def test_no_sentence_is_repeated_word_for_word(self) -> None:
        self.assertEqual(self.found["exact_repeat_extra"], 0)
        self.assertEqual(self.found["near_repeat_count"], 0)

    def test_no_guard_leak_and_no_commitment_the_gate_would_fail(self) -> None:
        guard = self.result["admin_log"]["guard"]
        self.assertFalse(guard["flagged"])
        for category in ("commitment", "concession"):
            self.assertEqual(guard["by_category"].get(category, 0), 0)

    def test_the_replayed_learner_keeps_its_voice(self) -> None:
        self.assertEqual(self.found["fact_error_count"], 0)
        self.assertGreaterEqual(self.found["question_rate"], 0.2)
        self.assertLessEqual(self.found["reply_words_p90"], 45)

    def test_all_four_objection_families_are_still_raised(self) -> None:
        families = self.result["admin_log"]["schedule"]["families"]
        for family in ("F1", "F2", "F3", "F4"):
            with self.subTest(family=family):
                self.assertTrue(families[family]["delivered"])
                self.assertLessEqual(families[family]["max_slip_sec"], 60)

    def test_the_replay_is_deterministic(self) -> None:
        again = asyncio.run(replay.replay(FIXTURE["rows"], ScriptedLearnerLLM("replay-b58c7d9c")))
        self.assertEqual([t.spoken for t in again["turns"]], [t.spoken for t in self.turns])


class FixedModel:
    """A deliberately bad learner model: speaks the next line of a list, whatever it is asked."""

    def __init__(self, *lines: str) -> None:
        self.lines = lines
        self.calls = 0

    def __call__(self, messages):
        text = self.lines[self.calls % len(self.lines)]
        self.calls += 1
        return ScriptedLearnerLLM._stream(text)


class NegativeControlTests(unittest.TestCase):
    """The harness is sensitive: a learner that behaves like the 4/10 call is found."""

    STALLS = (
        "Let me think about it, just email me the details.",
        "I'll think about it and get back to you.",
        "Please email me the information and I will get back to you.",
        "Let me think it over, you can email me.",
        "Email me the details and I'll be in touch.",
        "Let me think about this and I'll get back to you soon.",
    )

    def _replay(self, *lines: str) -> dict:
        return asyncio.run(replay.replay(FIXTURE["rows"], FixedModel(*lines)))

    def test_a_model_that_keeps_stalling_in_new_words_fails_the_call(self) -> None:
        found = self._replay(*self.STALLS)["metrics"]
        self.assertGreater(found["stall_family_rows"], metrics.STALL_PHRASE_LIMIT)
        self.assertIn("stall_phrases_repeated", metrics.hard_fails(found))

    def test_a_model_that_deflects_fails_the_call(self) -> None:
        found = self._replay(metrics.LEGACY_DEFLECTION)["metrics"]
        self.assertGreaterEqual(found["deflection_count"], 1)
        self.assertIn("catch_all_deflection", metrics.hard_fails(found))

    def test_a_model_that_repeats_itself_is_stopped_by_the_guard_and_counted(self) -> None:
        result = self._replay("That is really interesting, tell me more about the mentors.")
        self.assertEqual(result["metrics"]["exact_repeat_extra"], 0)
        guard = result["admin_log"]["guard"]
        self.assertGreater(guard["by_category"].get("repeat", 0), 5)
        self.assertEqual(guard["leak_hits"], 0)  # hygiene, so it can never fail the API gate

    def test_a_model_that_agrees_to_a_time_is_blocked_and_flags_the_call(self) -> None:
        result = self._replay("Yes, tomorrow at 10 AM works for me, let's book a call.")
        guard = result["admin_log"]["guard"]
        self.assertGreater(guard["by_category"].get("commitment", 0), 0)
        self.assertNotIn("tomorrow at 10", " ".join(r["text"] for r in result["rows"] if r["speaker"] == "bot"))


if __name__ == "__main__":
    unittest.main()
