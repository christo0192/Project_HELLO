"""R1 turn handling and the per-turn latency tracker (plan 5.15).  Pure python: no SDK.

``r1_turn_handling`` is the one place R1's turn-taking numbers live; ``LatencyTracker`` turns
the stamps of one candidate turn into the segments ``r1_session`` logs.  Both are tested here
with a manual clock, and the wiring into a session is tested in ``test_r1_integration``.
"""
from __future__ import annotations

import ast
import io
import json
import math
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_latency
from r1_latency import (
    STAGE_A_HEADLINE_P50_SEC,
    STAGE_A_HEADLINE_P95_SEC,
    STAGE_A_SCRIPTED_START_SEC,
    LatencyTracker,
    count_words,
    latency_records,
    percentile,
    r1_turn_handling,
    stage_a_report,
)

_ENV_KEYS = (
    "R1_ENDPOINT_MIN_DELAY_SEC",
    "R1_ENDPOINT_MAX_DELAY_SEC",
    "R1_INTERRUPT_MIN_DURATION_SEC",
    "R1_INTERRUPT_MIN_WORDS",
)


class Clock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def at(self, value: float) -> None:
        self.now = value


class Lines:
    """Collects what the tracker reports, rounded so the arithmetic reads exactly."""

    def __init__(self) -> None:
        self.items: list[tuple] = []

    def __call__(self, schema, seconds, *, category, phase, turn_index) -> None:
        self.items.append((schema, round(seconds, 3), category, phase, turn_index))

    def schemas(self) -> list[str]:
        return [item[0] for item in self.items]

    def get(self, schema: str) -> tuple:
        found = [item for item in self.items if item[0] == schema]
        assert len(found) == 1, (schema, self.items)
        return found[0]


class TestTurnHandling(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)  # restores whatever the test sets
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in _ENV_KEYS:
            os.environ.pop(key, None)

    def test_the_defaults_are_the_plans_numbers(self) -> None:
        # Plan 5.15 item 3: endpointing 0.7 / 3.5 s, interruption min_duration 0.7 s, min_words 2.
        self.assertEqual(
            r1_turn_handling(),
            {
                "endpointing": {"min_delay": 0.7, "max_delay": 3.5},
                "interruption": {"min_duration": 0.7, "min_words": 2},
                "preemptive_generation": {"enabled": False},
            },
        )

    def test_preemptive_generation_is_off_and_nothing_else_leaks_in(self) -> None:
        # No turn_detection key: the session keeps the browser lane's detector, and R1 only
        # changes the timings around it.
        handling = r1_turn_handling()
        self.assertEqual(handling["preemptive_generation"], {"enabled": False})
        self.assertEqual(
            set(handling), {"endpointing", "interruption", "preemptive_generation"}
        )

    def test_each_value_can_be_tuned_from_the_environment(self) -> None:
        os.environ.update(
            {
                "R1_ENDPOINT_MIN_DELAY_SEC": "0.5",
                "R1_ENDPOINT_MAX_DELAY_SEC": "4.5",
                "R1_INTERRUPT_MIN_DURATION_SEC": "1.0",
                "R1_INTERRUPT_MIN_WORDS": "3",
            }
        )
        handling = r1_turn_handling()
        self.assertEqual(handling["endpointing"], {"min_delay": 0.5, "max_delay": 4.5})
        self.assertEqual(handling["interruption"], {"min_duration": 1.0, "min_words": 3})

    def test_every_value_is_bounded(self) -> None:
        os.environ.update(
            {
                "R1_ENDPOINT_MIN_DELAY_SEC": "0.0",
                "R1_ENDPOINT_MAX_DELAY_SEC": "99",
                "R1_INTERRUPT_MIN_DURATION_SEC": "0.0",
                "R1_INTERRUPT_MIN_WORDS": "99",
            }
        )
        handling = r1_turn_handling()
        self.assertEqual(handling["endpointing"], {"min_delay": 0.2, "max_delay": 8.0})
        self.assertEqual(handling["interruption"], {"min_duration": 0.3, "min_words": 6})
        os.environ.update(
            {
                "R1_ENDPOINT_MIN_DELAY_SEC": "50",
                "R1_INTERRUPT_MIN_DURATION_SEC": "50",
                "R1_INTERRUPT_MIN_WORDS": "-4",
            }
        )
        handling = r1_turn_handling()
        self.assertEqual(handling["endpointing"]["min_delay"], 2.0)
        self.assertEqual(handling["interruption"], {"min_duration": 2.0, "min_words": 0})

    def test_a_malformed_value_falls_back_to_the_default(self) -> None:
        for bad in ("", "  ", "abc", "nan", "inf", "-inf", "1,5"):
            with self.subTest(value=bad):
                for key in _ENV_KEYS:
                    os.environ[key] = bad
                self.assertEqual(r1_turn_handling(), self._defaults())

    def test_the_maximum_delay_never_undercuts_the_minimum(self) -> None:
        os.environ["R1_ENDPOINT_MIN_DELAY_SEC"] = "2.0"
        os.environ["R1_ENDPOINT_MAX_DELAY_SEC"] = "1.0"
        endpointing = r1_turn_handling()["endpointing"]
        self.assertEqual(endpointing, {"min_delay": 2.0, "max_delay": 2.0})

    def test_each_call_returns_a_fresh_dict(self) -> None:
        first = r1_turn_handling()
        first["endpointing"]["min_delay"] = 99
        self.assertEqual(r1_turn_handling()["endpointing"]["min_delay"], 0.7)

    @staticmethod
    def _defaults() -> dict:
        return {
            "endpointing": {"min_delay": 0.7, "max_delay": 3.5},
            "interruption": {"min_duration": 0.7, "min_words": 2},
            "preemptive_generation": {"enabled": False},
        }


class TestLatencyTracker(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.lines = Lines()
        self.tracker = LatencyTracker(self.clock, self.lines)

    def speak(self, start: float, stop: float) -> None:
        self.clock.at(start)
        self.tracker.note_user_state("speaking")
        self.clock.at(stop)
        self.tracker.note_user_state("listening")

    def test_a_full_reply_reports_every_segment_from_the_end_of_speech(self) -> None:
        self.speak(10.0, 12.0)
        self.clock.at(12.2)
        self.tracker.note_final()
        self.clock.at(12.9)
        self.tracker.begin_turn(7, "roleplay")
        self.tracker.set_kind("llm_reply")
        self.clock.at(13.0)
        self.tracker.mark("llm_start")
        self.clock.at(13.5)
        self.tracker.mark("llm_first_token")
        self.clock.at(14.0)
        self.tracker.mark("guard_release")
        self.tracker.mark("tts_first_text")
        self.clock.at(14.25)
        self.tracker.mark("tts_first_frame")
        self.clock.at(14.5)
        self.tracker.first_audio()
        self.assertEqual(
            self.lines.items,
            [
                ("eou_to_turn_hook", 0.9, "vad", "roleplay", 7),
                ("eou_to_llm_first_token", 1.5, "llm_reply", "roleplay", 7),
                ("llm_ttft", 0.5, "llm_reply", "roleplay", 7),
                ("eou_to_guard_release", 2.0, "llm_reply", "roleplay", 7),
                ("guard_hold", 0.5, "llm_reply", "roleplay", 7),
                ("eou_to_tts_first_frame", 2.25, "llm_reply", "roleplay", 7),
                ("tts_ttfb", 0.25, "llm_reply", "roleplay", 7),
                ("eou_to_first_audio", 2.5, "llm_reply", "roleplay", 7),
            ],
        )

    def test_a_pause_inside_an_utterance_does_not_move_the_anchor(self) -> None:
        # speaking, a pause (stop at 5), speaking again, the real stop at 8
        self.speak(1.0, 5.0)
        self.clock.at(6.0)
        self.tracker.note_user_state("speaking")
        self.clock.at(8.0)
        self.tracker.note_user_state("listening")
        self.clock.at(9.0)
        self.tracker.begin_turn(1, "icebreaker")
        self.assertEqual(self.lines.get("eou_to_turn_hook")[1], 1.0)

    def test_a_resumed_utterance_is_not_anchored_on_the_earlier_stop(self) -> None:
        self.speak(1.0, 5.0)
        self.clock.at(6.0)
        self.tracker.note_user_state("speaking")  # still talking when the hook runs
        self.clock.at(6.5)
        self.tracker.note_final()
        self.clock.at(7.0)
        self.tracker.begin_turn(1, "icebreaker")
        # The anchor falls back to the final transcript, not the stale stop at 5.0.
        self.assertEqual(self.lines.get("eou_to_turn_hook"), ("eou_to_turn_hook", 0.5, "final", "icebreaker", 1))

    def test_without_a_speech_stop_the_final_transcript_is_the_anchor(self) -> None:
        self.clock.at(3.0)
        self.tracker.note_final()
        self.clock.at(4.0)
        self.tracker.begin_turn(2, "wrapup")
        self.assertEqual(self.lines.get("eou_to_turn_hook"), ("eou_to_turn_hook", 1.0, "final", "wrapup", 2))

    def test_without_either_the_hook_is_the_anchor_and_the_segment_is_zero(self) -> None:
        self.clock.at(4.0)
        self.tracker.begin_turn(None, "wrapup")
        self.assertEqual(
            self.lines.get("eou_to_turn_hook"), ("eou_to_turn_hook", 0.0, "hook", "wrapup", None)
        )

    def test_an_anchor_is_used_once(self) -> None:
        self.speak(1.0, 2.0)
        self.clock.at(2.5)
        self.tracker.begin_turn(1, "icebreaker")
        self.clock.at(10.0)
        self.tracker.note_final()
        self.clock.at(10.4)
        self.tracker.begin_turn(2, "icebreaker")
        second = [item for item in self.lines.items if item[0] == "eou_to_turn_hook"][1]
        self.assertEqual(second, ("eou_to_turn_hook", 0.4, "final", "icebreaker", 2))

    def test_an_anchor_never_lies_after_the_hook(self) -> None:
        self.speak(5.0, 9.0)
        self.clock.at(8.0)  # a clock that stepped back
        self.tracker.begin_turn(1, "icebreaker")
        self.assertEqual(self.lines.get("eou_to_turn_hook")[1], 0.0)

    def test_the_first_stamp_of_a_stage_wins(self) -> None:
        self.clock.at(1.0)
        self.tracker.begin_turn(1, "icebreaker")
        self.clock.at(2.0)
        self.tracker.mark("llm_first_token")
        self.clock.at(3.0)
        self.tracker.mark("llm_first_token")
        self.clock.at(4.0)
        self.tracker.first_audio()
        self.clock.at(5.0)
        self.tracker.first_audio()
        self.assertEqual(self.lines.schemas().count("eou_to_llm_first_token"), 1)
        self.assertEqual(self.lines.schemas().count("eou_to_first_audio"), 1)
        self.assertEqual(self.lines.get("eou_to_llm_first_token")[1], 1.0)
        self.assertEqual(self.lines.get("eou_to_first_audio")[1], 3.0)

    def test_a_segment_that_needs_a_missing_stamp_is_skipped(self) -> None:
        self.clock.at(1.0)
        self.tracker.begin_turn(1, "icebreaker")
        self.clock.at(2.0)
        self.tracker.mark("llm_first_token")  # no llm_start: no ttft
        self.tracker.mark("guard_release")  # fine: first token stamped
        self.tracker.mark("tts_first_frame")  # no tts_first_text: no ttfb
        self.assertEqual(
            self.lines.schemas(),
            [
                "eou_to_turn_hook",
                "eou_to_llm_first_token",
                "eou_to_guard_release",
                "guard_hold",
                "eou_to_tts_first_frame",
            ],
        )

    def test_the_acknowledgement_reports_its_outcome(self) -> None:
        for outcome in ("done", "cutoff", "failed"):
            with self.subTest(outcome=outcome):
                self.lines.items.clear()
                self.clock.at(10.0)
                self.tracker.begin_turn(1, "roleplay")
                self.tracker.set_kind("ack_then_say")
                self.clock.at(10.5)
                self.tracker.mark("llm_start")
                self.clock.at(12.0)
                self.tracker.mark("ack", outcome)
                self.assertEqual(self.lines.get("ack"), ("ack", 1.5, outcome, "roleplay", 1))

    def test_an_acknowledgement_without_a_model_call_reports_nothing(self) -> None:
        self.clock.at(1.0)
        self.tracker.begin_turn(1, "roleplay")
        self.clock.at(2.0)
        self.tracker.mark("ack", "failed")
        self.assertNotIn("ack", self.lines.schemas())

    def test_stamps_without_an_open_turn_do_nothing(self) -> None:
        self.tracker.mark("llm_first_token")
        self.tracker.first_audio()
        self.tracker.set_kind("llm_reply")
        self.assertEqual(self.lines.items, [])

    def test_a_new_turn_replaces_the_old_one(self) -> None:
        self.clock.at(1.0)
        self.tracker.begin_turn(1, "icebreaker")
        self.clock.at(5.0)
        self.tracker.begin_turn(2, "icebreaker")
        self.clock.at(6.0)
        self.tracker.first_audio()
        audio = self.lines.get("eou_to_first_audio")
        self.assertEqual((audio[1], audio[4]), (1.0, 2))

    def test_the_headline_names_the_kind_of_turn(self) -> None:
        for kind in ("llm_reply", "ack_then_say", "say_only", "reply"):
            with self.subTest(kind=kind):
                self.lines.items.clear()
                self.clock.at(1.0)
                self.tracker.begin_turn(1, "roleplay")
                self.tracker.set_kind(kind)
                self.clock.at(2.0)
                self.tracker.first_audio()
                self.assertEqual(self.lines.get("eou_to_first_audio")[2], kind)

    def test_negative_and_absurd_durations_are_never_reported(self) -> None:
        self.clock.at(100.0)
        self.tracker.note_final()
        self.clock.at(50.0)  # time ran backwards
        self.tracker.begin_turn(1, "roleplay")
        self.assertEqual(self.lines.items[0][1], 0.0)  # clamped by the anchor rule
        self.lines.items.clear()
        self.clock.at(10_000.0)  # an absurd gap
        self.tracker.first_audio()
        self.assertEqual(self.lines.items, [])
        self.clock.at(10.0)
        self.tracker.mark("llm_first_token")  # before the anchor: negative
        self.assertEqual(self.lines.items, [])

    def test_a_scripted_line_reports_the_delay_to_its_audio(self) -> None:
        self.clock.at(1.0)
        self.tracker.say_created("speech_1", "L-EXIT", "roleplay_exit")
        self.clock.at(1.4)
        self.assertTrue(self.tracker.say_audio("speech_1"))
        self.assertEqual(
            self.lines.items, [("say_to_first_audio", 0.4, "L-EXIT", "roleplay_exit", None)]
        )
        self.assertFalse(self.tracker.say_audio("speech_1"))  # reported once
        self.assertFalse(self.tracker.say_audio("speech_unknown"))

    def test_an_interrupted_scripted_line_is_forgotten_without_a_report(self) -> None:
        self.clock.at(1.0)
        self.tracker.say_created("speech_1", "L-WRAP", "wrapup")
        self.tracker.say_done("speech_1")
        self.clock.at(2.0)
        self.assertFalse(self.tracker.say_audio("speech_1"))
        self.assertEqual(self.lines.items, [])

    def test_unfinished_scripted_lines_are_bounded(self) -> None:
        for number in range(40):
            self.tracker.say_created(f"speech_{number}", "L-WRAP", "wrapup")
        self.assertFalse(self.tracker.say_audio("speech_0"))  # the oldest were dropped
        self.assertTrue(self.tracker.say_audio("speech_39"))

    def test_a_scripted_line_does_not_feed_the_open_turn(self) -> None:
        self.clock.at(1.0)
        self.tracker.begin_turn(1, "roleplay")
        self.tracker.say_created("speech_1", "L-ASIDE-COACH", "aside")
        self.clock.at(1.2)
        self.assertTrue(self.tracker.say_audio("speech_1"))
        self.assertNotIn("eou_to_first_audio", self.lines.schemas())

    def test_every_reported_value_is_finite(self) -> None:
        self.clock.at(math.inf)
        self.tracker.note_final()
        self.clock.at(1.0)
        self.tracker.begin_turn(1, "roleplay")
        self.assertTrue(all(math.isfinite(item[1]) for item in self.lines.items))


def log_line(schema: str, seconds, *, component: str = "r1", error_type: str = "r1_latency") -> dict:
    return {
        "timestamp": "2026-10-08T00:00:00.000Z",
        "level": "info",
        "component": component,
        "event": "unknown_event",
        "error_type": error_type,
        "schema": schema,
        "duration_sec": seconds,
    }


def headline(*seconds) -> list[dict]:
    return [log_line("eou_to_first_audio", value) for value in seconds]


class TestPercentile(unittest.TestCase):
    def test_nearest_rank(self) -> None:
        values = [5, 1, 4, 2, 3]
        self.assertEqual(percentile(values, 50), 3.0)
        self.assertEqual(percentile(values, 95), 5.0)
        self.assertEqual(percentile(values, 100), 5.0)
        self.assertEqual(percentile(values, 0), 1.0)
        self.assertEqual(percentile([7], 95), 7.0)
        self.assertEqual(percentile(range(1, 101), 95), 95.0)

    def test_only_finite_numbers_count(self) -> None:
        self.assertIsNone(percentile([], 50))
        self.assertIsNone(percentile([None, "x", True, math.nan, math.inf], 50))
        self.assertEqual(percentile([1, None, "x", 3, True], 50), 1.0)


class TestStageAReport(unittest.TestCase):
    def test_the_targets_are_the_plans(self) -> None:
        self.assertEqual(
            (STAGE_A_HEADLINE_P50_SEC, STAGE_A_HEADLINE_P95_SEC, STAGE_A_SCRIPTED_START_SEC),
            (1.8, 3.0, 0.5),
        )

    def test_a_session_inside_every_target_passes(self) -> None:
        lines = headline(1.2, 1.5, 1.7, 1.8, 2.9) + [log_line("say_to_first_audio", 0.3)]
        report = stage_a_report(lines)
        self.assertEqual(
            (report["headline_turns"], report["headline_p50_sec"], report["headline_p95_sec"]),
            (5, 1.7, 2.9),
        )
        self.assertTrue(report["passes"])
        self.assertTrue(report["scripted_ok"])

    def test_a_slow_median_or_a_slow_tail_fails(self) -> None:
        slow_median = stage_a_report(headline(1.9, 2.0, 2.1))
        self.assertFalse(slow_median["headline_p50_ok"])
        self.assertFalse(slow_median["passes"])
        slow_tail = stage_a_report(headline(*([1.0] * 18), 3.5, 3.6))
        self.assertTrue(slow_tail["headline_p50_ok"])
        self.assertFalse(slow_tail["headline_p95_ok"])
        self.assertFalse(slow_tail["passes"])

    def test_a_slow_scripted_line_fails_the_session(self) -> None:
        lines = headline(1.0, 1.1) + [log_line("say_to_first_audio", 0.9)]
        report = stage_a_report(lines)
        self.assertFalse(report["scripted_ok"])
        self.assertFalse(report["passes"])

    def test_a_session_with_no_scripted_line_is_judged_on_the_headline(self) -> None:
        report = stage_a_report(headline(1.0, 1.1))
        self.assertIsNone(report["scripted_ok"])
        self.assertTrue(report["passes"])

    def test_nothing_measured_is_not_a_pass(self) -> None:
        for lines in ([], [log_line("llm_ttft", 0.4)], headline(None, "x")):
            with self.subTest(lines=lines):
                report = stage_a_report(lines)
                self.assertIsNone(report["passes"])
                self.assertEqual(report["headline_turns"], 0)

    def test_only_r1_latency_lines_count(self) -> None:
        lines = (
            headline(1.0)
            + [log_line("eou_to_first_audio", 9.0, component="phone")]
            + [log_line("eou_to_first_audio", 9.0, error_type="voice_phone_headline_latency")]
            + [{"component": "r1", "error_type": "r1_fidelity_move", "duration_sec": 9.0}]
        )
        self.assertEqual(stage_a_report(lines)["headline_turns"], 1)

    def test_json_text_and_fly_wrapped_lines_are_read(self) -> None:
        plain = json.dumps(log_line("eou_to_first_audio", 1.0))
        wrapped = json.dumps({"instance": "i", "level": "info", "message": plain})
        stream = [plain, wrapped, "not json at all", "", json.dumps({"message": "nor this"}), b"{}"]
        self.assertEqual(len(list(latency_records(stream))), 2)
        self.assertEqual(stage_a_report(stream)["headline_turns"], 2)

    def test_the_command_line_reports_and_exits_by_the_verdict(self) -> None:
        cases = (
            (headline(1.0, 1.2), 0),
            (headline(2.5, 2.6), 1),
            ([], 2),
        )
        for lines, expected in cases:
            with self.subTest(expected=expected):
                stdin = io.StringIO(chr(10).join(json.dumps(line_) for line_ in lines))
                stdout = io.StringIO()
                with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", stdout):
                    self.assertEqual(r1_latency.main(), expected)
                report = json.loads(stdout.getvalue())
                self.assertEqual(report["targets"]["headline_p95_sec"], 3.0)


class TestCountWords(unittest.TestCase):
    """``count_words`` mirrors the SDK's ``split_words(..., split_character=True)`` for min_words.

    ``test_r1_sdk_contract`` compares the two on the real SDK; these pin the rules without it.
    """

    def test_words_are_whitespace_separated_tokens_that_hold_more_than_punctuation(self) -> None:
        cases = {
            "": 0,
            "   ": 0,
            "Yes.": 1,
            "...": 0,
            "yes please": 2,
            "Yes please do go on.": 5,
            "don't": 1,
            "a - b": 2,
            "x-y z_w": 2,
            "$ 5 % ?": 1,
            "a b  c": 3,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(count_words(text), expected)

    def test_typographic_punctuation_is_not_a_word(self) -> None:
        quotes = chr(0x201C) + "Hi" + chr(0x201D)
        self.assertEqual(count_words(quotes), 1)
        self.assertEqual(count_words("ok" + chr(0x2026)), 1)
        self.assertEqual(count_words("hello " + chr(0x2014) + " world"), 2)

    def test_each_letter_of_a_character_based_script_is_a_word(self) -> None:
        cjk = chr(0x4E2D) + chr(0x6587)
        self.assertEqual(count_words(cjk), 2)
        self.assertEqual(count_words("abc" + cjk + "def"), 4)
        self.assertEqual(count_words(chr(0x0E2A) + chr(0x0E27) + chr(0x0E31)), 3)


class TestModuleSurface(unittest.TestCase):
    def test_the_module_imports_only_the_standard_library(self) -> None:
        # No phone, session or SDK code: the tracker stays unit-testable and R1-only, and
        # the module reports through its ``emit`` callback instead of logging itself.
        tree = ast.parse(Path(r1_latency.__file__).read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(
            imported,
            {"__future__", "collections", "dataclasses", "json", "math", "os", "re", "sys", "typing"},
        )


if __name__ == "__main__":
    unittest.main()
