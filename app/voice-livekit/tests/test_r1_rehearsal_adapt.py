"""The adaptability scenarios and the conversation-flow judge of the full-interview tier (D-M032-10).

Offline, no network, no key.  Every adapt scenario runs one whole interview offline and must reach
CLOSING with its ground-truth tags, and its behaviour must really happen (tangents in the icebreaker
and the role-play, one-word answers everywhere, cut-ins over the learner ...).  The flow judge's
schema is strict and fail closed, its evidence is held to BOT lines, and its gates are pinned.

Everything the candidate says is synthetic.  Nothing here reads the API key.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from rehearsal import vloop

ADAPT = (
    "tangent", "confused", "rambler", "one-worder", "hinglish", "rude-not-abusive", "interrupter",
    "off-script-advisor", "manipulative-advisor", "over-discounter", "gives-up-midway",
    "mid-roleplay-glitch", "argues-with-christy", "late-ready",
)
TRAIT = {
    "tangent": "tangent", "confused": "confused", "rambler": "ramble", "one-worder": "one_word",
    "hinglish": "hinglish", "rude-not-abusive": "rude", "interrupter": "interrupt",
    "off-script-advisor": "off_script", "manipulative-advisor": "manipulative",
    "over-discounter": "over_discount", "gives-up-midway": "gives_up", "mid-roleplay-glitch": "glitch",
    "argues-with-christy": "argue", "late-ready": "late_ready",
}

_CACHE: dict[str, object] = {}


def adapt_records() -> dict[str, dict]:
    """Every adapt scenario once, offline, on one virtual loop (shared by the tests below)."""
    if "records" not in _CACHE:
        from rehearsal.full import run_full_call
        from rehearsal.full_run import FullSettings, OfflineFullFactory, plan_full_specs
        from rehearsal.scenarios import parse_scenarios

        names = parse_scenarios("adapt")
        settings = FullSettings(offline=True, scenarios=names, judge=True)
        factory = OfflineFullFactory(settings)
        specs = plan_full_specs(names, settings.learners)

        async def main() -> dict[str, dict]:
            return {spec.scenario: await run_full_call(spec, factory.make(spec)) for spec in specs}

        _CACHE["records"] = vloop.run_virtual(main())
    return _CACHE["records"]  # type: ignore[return-value]


def _turns(record: dict, **match) -> list[dict]:
    return [t for t in record["candidate_turns"] if all(t.get(k) == v for k, v in match.items())]


def _rows(record: dict) -> list[dict]:
    from rehearsal.full_metrics import _ordered

    return _ordered(record["rows"])


def _check(record: dict, name: str) -> dict:
    return record["phase_checks"]["checks"][name]


# ---------------------------------------------------------------------------- registration
class AdaptRegistrationTests(unittest.TestCase):
    def test_the_adapt_group_all_and_an_unchanged_default(self) -> None:
        from rehearsal import manual
        from rehearsal.scenarios import GROUPS, SCENARIO_NAMES, parse_scenarios

        self.assertEqual(parse_scenarios("adapt"), ADAPT)
        default = parse_scenarios("default")
        self.assertEqual(default, (*GROUPS["manual-replay"], manual.MIX, *SCENARIO_NAMES))
        self.assertFalse(set(default) & set(ADAPT))
        # ``all`` keeps its meaning (the synthetic scenarios: a live sweep sized for it must not
        # grow), and default plus adapt is a group of its own.
        self.assertEqual(parse_scenarios("all"), SCENARIO_NAMES)
        self.assertEqual(len(parse_scenarios("all")), 16)
        self.assertEqual(parse_scenarios("default+adapt"), (*default, *ADAPT))
        self.assertEqual(parse_scenarios("default,adapt"), (*default, *ADAPT))
        self.assertEqual(parse_scenarios("Tangent,one-worder"), ("tangent", "one-worder"))

    def test_every_adapt_scenario_carries_its_ground_truth(self) -> None:
        from rehearsal.adapt import BEHAVIOURS
        from rehearsal.full import ground_truth
        from rehearsal.scenarios import ACTS, SCENARIOS, parse_scenarios

        parse_scenarios("adapt")
        for name in ADAPT:
            scenario = SCENARIOS[name]
            with self.subTest(scenario=name):
                self.assertIn("adapt", scenario.tags)
                self.assertIn(scenario.adapt, BEHAVIOURS)
                self.assertEqual(BEHAVIOURS[scenario.adapt].trait, TRAIT[name])
                truth = ground_truth(scenario)
                self.assertEqual(truth["adapt"], scenario.adapt)
                for beat in (*scenario.transition, *scenario.wrapup, *scenario.end_answers):
                    self.assertIn(beat.act, ACTS)
                for beat in scenario.roleplay:
                    self.assertIn(beat.act, ACTS)
                    self.assertEqual(beat.traits, (TRAIT[name],))
                    self.assertIn(TRAIT[name], truth["roleplay_beat_traits"])

    def test_no_adapt_text_is_an_insult_and_none_says_ready_by_accident(self) -> None:
        from rehearsal.adapt import BEHAVIOURS, INSULT_RE, ROLEPLAY_CUT_INS
        from rehearsal.scenarios import SCENARIOS, parse_scenarios

        parse_scenarios("adapt")
        texts = list(ROLEPLAY_CUT_INS)
        for behaviour in BEHAVIOURS.values():
            texts += [text for _act, text, _traits in behaviour.icebreaker]
        for name in ADAPT:
            scenario = SCENARIOS[name]
            for beat in (*scenario.transition, *scenario.wrapup, *scenario.roleplay):
                texts.append(beat.text)
                if beat.act != "ready":
                    self.assertNotRegex(beat.text.lower(), r"\bready\b", (name, beat.text))
        for text in texts:
            self.assertNotRegex(text, INSULT_RE)


# ------------------------------------------------------------------------ whole interviews
class AdaptOfflineInterviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.records = adapt_records()

    def test_every_adapt_scenario_reaches_closing_in_phase_order(self) -> None:
        from rehearsal.scenarios import ACTS, SCENARIOS

        self.assertEqual(tuple(self.records), ADAPT)
        for name, record in self.records.items():
            with self.subTest(scenario=name):
                self.assertIsNone(record["error"], record["error"])
                self.assertTrue(_check(record, "phase_order")["ok"], record["phase_checks"]["phases"])
                self.assertTrue(_check(record, "reached_closing")["ok"], record["outcome"])
                self.assertEqual(record["outcome"], "complete")
                self.assertIn("closing", record["phase_checks"]["phases"])
                self.assertFalse(_check(record, "bot_overlap")["ok"] is False)
                head = record["header"]
                self.assertIn("adapt", head["scenario_tags"])
                self.assertEqual(head["ground_truth"]["adapt"], SCENARIOS[name].adapt)
                for turn in record["candidate_turns"]:
                    self.assertIn(turn["act"], ACTS, turn)
                traits = {t for turn in record["candidate_turns"] for t in turn.get("traits") or []}
                self.assertIn(TRAIT[name], traits)
                self.assertEqual(record["flow"], {"source": "offline", "status": "n/a"})

    def test_tangents_in_the_icebreaker_and_the_roleplay(self) -> None:
        record = self.records["tangent"]
        tangents = _turns(record, act="tangent")
        phases = [t["phase"] for t in tangents]
        self.assertGreaterEqual(phases.count("icebreaker"), 2, phases)
        self.assertGreaterEqual(phases.count("roleplay"), 2, phases)
        for turn in tangents:
            self.assertEqual(turn["traits"], ["tangent"])
        self.assertTrue(all(t["role"] == "advisor" for t in tangents if t["phase"] == "roleplay"))

    def test_the_confused_candidate_asks_what_to_do_in_every_phase(self) -> None:
        record = self.records["confused"]
        phases = {t["phase"] for t in _turns(record, act="confused_question")}
        self.assertTrue({"icebreaker", "transition", "roleplay"} <= phases, phases)
        first_advisor = next(t for t in record["candidate_turns"] if t["role"] == "advisor")
        self.assertEqual(first_advisor["act"], "confused_question")

    def test_the_rambler_talks_in_monologues(self) -> None:
        from rehearsal.adapt import words

        record = self.records["rambler"]
        answers = [words(t["text"]) for t in _turns(record, phase="icebreaker", act="icebreaker_answer")]
        self.assertTrue(answers)
        self.assertGreaterEqual(min(answers), 100, answers)
        advisor = [t for t in record["candidate_turns"] if t["role"] == "advisor"]
        long_turns = [t for t in advisor if words(t["text"]) >= 100]
        self.assertGreaterEqual(len(long_turns) / len(advisor), 0.9)
        self.assertGreaterEqual(words(_turns(record, phase="transition")[0]["text"]), 60)

    def test_the_one_worder_says_one_or_two_words_everywhere(self) -> None:
        from rehearsal.adapt import words

        record = self.records["one-worder"]
        phases = {t["phase"] for t in record["candidate_turns"]}
        self.assertTrue({"icebreaker", "transition", "roleplay", "wrapup"} <= phases, phases)
        for turn in record["candidate_turns"]:
            self.assertLessEqual(words(turn["text"]), 2, turn)

    def test_the_hinglish_candidate_mixes_hindi_words_in_every_phase(self) -> None:
        from rehearsal.adapt import has_hindi

        record = self.records["hinglish"]
        turns = record["candidate_turns"]
        mixed = [t for t in turns if has_hindi(t["text"])]
        self.assertGreaterEqual(len(mixed) / len(turns), 0.9)
        self.assertTrue({"icebreaker", "transition", "roleplay", "wrapup"} <= {t["phase"] for t in mixed})

    def test_the_rude_candidate_is_curt_but_never_insults(self) -> None:
        from rehearsal.adapt import INSULT_RE

        record = self.records["rude-not-abusive"]
        rude = {t["phase"] for t in record["candidate_turns"] if "rude" in (t.get("traits") or [])}
        self.assertTrue({"icebreaker", "transition", "roleplay", "wrapup"} <= rude, rude)
        for turn in record["candidate_turns"]:
            self.assertNotEqual(turn["act"], "insult")
            self.assertNotRegex(turn["text"], INSULT_RE)
        self.assertIsNot(_check(record, "abuse")["ok"], False)

    def test_the_interrupter_cuts_in_while_the_bot_is_speaking(self) -> None:
        record = self.records["interrupter"]
        cut_ins = [t for t in record["candidate_turns"] if t.get("cut_in")]
        phases = [t["phase"] for t in cut_ins]
        self.assertGreaterEqual(phases.count("roleplay"), 3, phases)
        self.assertGreaterEqual(phases.count("icebreaker"), 1, phases)
        for turn in cut_ins:
            self.assertEqual(turn["act"], "interrupt")
            self.assertEqual(turn["traits"], ["interrupt"])
        rows = _rows(record)
        overlapping = 0
        for row in rows:
            if row.get("act") != "interrupt":
                continue
            playing = [
                bot for bot in rows
                if bot["speaker"] == "bot" and bot.get("t_start") is not None and bot.get("t_end") is not None
                and bot["t_start"] < row["t_start"] < bot["t_end"]
            ]
            overlapping += bool(playing)
        self.assertGreaterEqual(overlapping, 3)
        # Barge-in at voice onset: the line the candidate cut in over is really cut (marked
        # interrupted) within the SDK's interruption duration of the cut-in's start, for every
        # cut-in, in the icebreaker (Christy) and in the role-play (the learner).
        from rehearsal.sim import BARGE_IN_SEC

        uncut = []
        for row in rows:
            if row.get("act") != "interrupt":
                continue
            over = [
                bot for bot in rows
                if bot["speaker"] == "bot" and bot.get("t_start") is not None and bot.get("t_end") is not None
                and bot["t_start"] < row["t_start"] < bot["t_end"]
            ]
            if not over or not over[0]["interrupted"] or over[0]["t_end"] > row["t_start"] + BARGE_IN_SEC + 0.2:
                uncut.append((row.get("phase"), row["t_start"], [(b["t_start"], b["t_end"], b["interrupted"]) for b in over]))
        self.assertEqual(uncut, [])
        cut_learner = [r for r in rows if r.get("voice") == "learner" and r["interrupted"]]
        self.assertGreaterEqual(len(cut_learner), phases.count("roleplay"))
        cut_christy = [
            r for r in rows if r.get("phase") == "icebreaker" and r["speaker"] == "bot" and r["interrupted"]
        ]
        self.assertGreaterEqual(len(cut_christy), phases.count("icebreaker"))
        # A cut-in is an exchange of its own: numbered in order, no number twice.
        numbers = [exchange["n"] for exchange in record["exchanges"]]
        self.assertEqual(numbers, sorted(set(numbers)))

    def test_a_cut_in_feeds_the_advisor_only_the_line_it_cut(self) -> None:
        # The advisor hears the learner's cut line (its played part), never a line it already
        # answered in its own turn before the cut-in.
        from rehearsal.adapt import ROLEPLAY_CUT_INS
        from rehearsal.full import run_full_call
        from rehearsal.full_run import FullSettings, OfflineFullFactory, plan_full_specs

        settings = FullSettings(offline=True, scenarios=("interrupter",), judge=False)
        factory = OfflineFullFactory(settings)
        spec = plan_full_specs(("interrupter",), settings.learners)[0]
        deps = factory.make(spec)
        fed: list[tuple[str | None, str]] = []
        from rehearsal import candidate as candidate_module

        original = candidate_module.ScenarioAdvisor.cut_in

        def spy(self, learner_part, text, act, traits=()):
            fed.append((learner_part, text))
            return original(self, learner_part, text, act, traits)

        candidate_module.ScenarioAdvisor.cut_in = spy
        try:
            record = vloop.run_virtual(run_full_call(spec, deps))
        finally:
            candidate_module.ScenarioAdvisor.cut_in = original
        learner_lines = [r["text"].strip() for r in _rows(record) if r.get("voice") == "learner"]
        roleplay_fed = [part for part, text in fed if text in ROLEPLAY_CUT_INS]
        self.assertGreaterEqual(len(roleplay_fed), 3)
        for part in roleplay_fed:
            self.assertIsNotNone(part)
            self.assertTrue(any(line.startswith(part.strip()) for line in learner_lines), part)
        # What the advisor was fed ends with the cut line's own played part: no word the candidate
        # never heard, none it did hear left out.
        cut_lines = [r["text"].strip() for r in _rows(record) if r.get("voice") == "learner" and r["interrupted"]]
        self.assertGreaterEqual(len(cut_lines), len(roleplay_fed))
        for part in roleplay_fed:
            self.assertTrue(any(part.strip().endswith(line) for line in cut_lines), part)

    def test_the_off_script_and_manipulative_advisors_say_their_lines(self) -> None:
        from rehearsal.scenarios import SCENARIOS

        for name, act in (("off-script-advisor", "off_script"), ("manipulative-advisor", "pressure")):
            record = self.records[name]
            with self.subTest(scenario=name):
                said = [t["text"] for t in _turns(record, act=act)]
                self.assertEqual(said, [beat.text for beat in SCENARIOS[name].roleplay])
                self.assertTrue(all(t["phase"] == "roleplay" for t in _turns(record, act=act)))

    def test_the_over_discounter_drops_the_price_again_and_again(self) -> None:
        record = self.records["over-discounter"]
        drops = _turns(record, act="discount_drop")
        self.assertGreaterEqual(len(drops), 4)
        lowest = [min(int(x.replace(",", "")) for x in re.findall(r"\$([\d,]+)", t["text"])) for t in drops]
        self.assertEqual(lowest, sorted(lowest, reverse=True))
        self.assertEqual(len(set(lowest)), len(lowest))
        self.assertLessEqual(lowest[-1], 1000)

    def test_gives_up_midway_asks_to_stop_twice_and_is_heard(self) -> None:
        record = self.records["gives-up-midway"]
        requests = _turns(record, act="end_request")
        self.assertEqual(len(requests), 2)
        self.assertGreaterEqual(requests[0]["r_sec"], 345.0)
        self.assertGreaterEqual(requests[1]["r_sec"], 705.0)
        consent = _check(record, "end_consent")
        self.assertTrue(consent["ok"], consent)
        first = consent["requests"][0]
        self.assertTrue(first["asked"])
        self.assertEqual(first["answer"], "end_decline")
        self.assertTrue(first["resumed"])
        self.assertTrue(_check(record, "roleplay_end")["ok"])

    def test_the_glitches_happen_inside_the_roleplay(self) -> None:
        record = self.records["mid-roleplay-glitch"]
        checks = _turns(record, act="glitch_check")
        lost = _turns(record, act="glitch_lost")
        self.assertGreaterEqual(len(checks), 1)
        self.assertEqual(len(lost), 1)
        for turn in (*checks, *lost):
            self.assertEqual(turn["phase"], "roleplay")
            self.assertEqual(turn["role"], "advisor")
        self.assertRegex(checks[0]["text"], r"(?i)can you hear me")
        self.assertRegex(lost[0]["text"], r"(?i)lost you")

    def test_the_candidate_argues_with_christy_about_the_brief_and_the_rules(self) -> None:
        record = self.records["argues-with-christy"]
        argue = _turns(record, act="argue")
        self.assertEqual([t["phase"] for t in argue], ["transition", "transition"])
        wrap = _turns(record, act="wrapup_question")
        self.assertEqual(wrap[0]["traits"], ["argue"])
        self.assertTrue(_check(record, "wrapup_answered")["ok"])

    def test_late_ready_asks_many_questions_before_ready(self) -> None:
        record = self.records["late-ready"]
        transition = [t["act"] for t in _turns(record, phase="transition")]
        ready = transition.index("ready")
        self.assertGreaterEqual(transition[:ready].count("roleplay_question"), 5, transition)
        self.assertEqual(_check(record, "start_by")["start_by"], "spoken")
        self.assertIsNotNone(_check(record, "transition_ceiling")["ok"])

    def test_the_ready_taken_check_is_scored_on_every_call(self) -> None:
        for name, record in self.records.items():
            with self.subTest(scenario=name):
                check = _check(record, "ready_taken")
                self.assertGreaterEqual(check["readies"], 1)
                self.assertEqual(check["ok"], not check["not_taken"])


# ---------------------------------------------------------------------------- the pieces
class ReadyTakenCheckTests(unittest.TestCase):
    @staticmethod
    def _row(speaker, voice, text, t, act=None):
        return {"speaker": speaker, "voice": voice, "phase": "transition", "text": text, "t_start": t,
                "t_end": t + 1.0, "act": act, "s_sec": t}

    def test_a_ready_followed_by_the_pickup_is_taken_and_one_answered_as_a_question_is_not(self) -> None:
        from rehearsal.full_metrics import _ready_taken

        taken = [
            self._row("candidate", "candidate", "I'm ready.", 1.0, "ready"),
            self._row("bot", "christy", "Here she is.", 3.0),
            self._row("bot", "learner", "Hello?", 5.0),
        ]
        self.assertTrue(_ready_taken(taken)["ok"])
        missed = [
            self._row("candidate", "candidate", "Haan, theek hai, I'm ready.", 1.0, "ready"),
            self._row("bot", "christy", "That's a good question for the hiring team.", 3.0),
            self._row("candidate", "candidate", "I'm ready.", 6.0, "ready"),
            self._row("bot", "learner", "Hello?", 8.0),
        ]
        check = _ready_taken(missed)
        self.assertFalse(check["ok"])
        self.assertEqual(len(check["not_taken"]), 1)
        self.assertIn("hiring team", check["not_taken"][0]["reply"])
        self.assertIsNone(_ready_taken([self._row("bot", "christy", "Hi.", 0.0)])["ok"])


class InterrupterTests(unittest.TestCase):
    @staticmethod
    def _span(voice: str, text: str = "one two three four five six seven eight nine ten eleven", source="reply"):
        return SimpleNamespace(voice=voice, text=text, source=source)

    def test_every_third_long_learner_reply_is_cut_once_past_forty_percent(self) -> None:
        from rehearsal.adapt import Interrupter

        cutter = Interrupter()
        fired = []
        for index in range(1, 25):
            span = self._span("learner")
            self.assertFalse(cutter.due("roleplay", span, 1.5, 5.0))  # too early
            first = cutter.due("roleplay", span, 2.5, 5.0)
            again = cutter.due("roleplay", span, 3.0, 5.0)
            self.assertFalse(again)  # once per line
            if first:
                fired.append(index)
        self.assertEqual(fired, [3, 6, 9, 12, 15, 18])  # every third, at most six
        self.assertFalse(cutter.due("roleplay", self._span("learner", "Too short."), 3.0, 5.0))
        self.assertFalse(cutter.due("roleplay", self._span("learner", source="say"), 3.0, 5.0))
        self.assertFalse(cutter.due("roleplay", self._span("interviewer"), 3.0, 5.0))

    def test_no_cut_in_when_the_line_ends_before_a_barge_in_could_cut_it(self) -> None:
        # The SDK cuts a line once the candidate's voice has lasted ``BARGE_IN_SEC``: a cut-in
        # that late would talk over a line that then plays to its end, with nothing cut.
        from rehearsal.adapt import Interrupter
        from rehearsal.sim import BARGE_IN_SEC

        cutter = Interrupter()
        late = [cutter.due("roleplay", self._span("learner"), 5.0 - BARGE_IN_SEC, 5.0) for _ in range(3)]
        self.assertEqual(late, [False, False, False])
        self.assertEqual(cutter.fired["roleplay"], 0)

    def test_christys_second_icebreaker_reply_is_cut_once(self) -> None:
        from rehearsal.adapt import Interrupter

        cutter = Interrupter()
        results = [cutter.due("icebreaker", self._span("interviewer"), 3.0, 5.0) for _ in range(4)]
        self.assertEqual(results, [False, True, False, False])
        act, text, traits = cutter.line("icebreaker")
        self.assertEqual((act, traits), ("interrupt", ("interrupt",)))
        self.assertTrue(text)

    def test_only_the_interrupter_scenario_has_one(self) -> None:
        from rehearsal.adapt import interrupter_for
        from rehearsal.scenarios import SCENARIOS, parse_scenarios

        parse_scenarios("all")
        self.assertIsNotNone(interrupter_for(SCENARIOS["interrupter"]))
        self.assertIsNone(interrupter_for(SCENARIOS["tangent"]))
        self.assertIsNone(interrupter_for(SCENARIOS["strong"]))


class _FakeClient:
    """Answers each ``complete`` from a queue and records the call."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    async def complete(self, messages, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        text = self.answers.pop(0) if self.answers else json.dumps({"text": "Okay sure fine then."})
        return SimpleNamespace(text=text, usage={}, seconds=0.0)


class LiveAdaptPartsTests(unittest.TestCase):
    def test_the_live_candidate_gets_the_style_and_the_overlay(self) -> None:
        from rehearsal.adapt import AdaptAdvisor, AdaptTalker
        from rehearsal.candidate import OverlayLLMAdvisor
        from rehearsal.manual import candidate_parts

        client = _FakeClient([json.dumps({"text": "Did you see the match? Anyway, sales, two years."})])
        parts = candidate_parts("tangent", "seed", "average", offline=False, client=client, model="m")
        self.assertIsInstance(parts.talker, AdaptTalker)
        self.assertIsInstance(parts.advisor, AdaptAdvisor)
        self.assertIsInstance(parts.advisor.base, OverlayLLMAdvisor)
        self.assertIn("drift", parts.advisor.base.overlay)

        async def main():
            return await parts.talker.icebreaker_answer()

        text = asyncio.run(main())
        self.assertIn("match", text)
        system = client.calls[0]["messages"][0]["content"]
        self.assertIn("easily distracted", system)
        self.assertEqual(parts.talker.last_act, "icebreaker_answer")

    def test_the_live_one_worder_is_held_to_two_words(self) -> None:
        from rehearsal.manual import candidate_parts

        reply = json.dumps({"intent": "pitch", "topic": "", "text": "Well, the course runs six months with mentors."})
        client = _FakeClient([reply])
        parts = candidate_parts("one-worder", "seed", "terse", offline=False, client=client, model="m")

        async def main():
            await parts.advisor.start("Hello? This is Meera.")
            return await parts.advisor.next_turn("Hi, who is this?", 30.0, 1)

        turn = asyncio.run(main())
        self.assertEqual(turn.text, "Well, the.")
        self.assertEqual(parts.advisor.last_traits, ("one_word",))
        self.assertEqual(parts.advisor.history[-1]["text"], "Well, the.")  # the live advisor remembers it

    def test_the_offline_transforms(self) -> None:
        from rehearsal.adapt import has_hindi, transform_hinglish, transform_ramble, transform_rude, two_words, words

        self.assertEqual(two_words("Why are you interested?"), "Why are?")
        self.assertEqual(two_words(""), "Okay.")
        self.assertGreaterEqual(words(transform_ramble("Short line.", 0, "pitch")), 110)
        self.assertTrue(has_hindi(transform_hinglish("The course is six months.", 1, "pitch")))
        rude = transform_rude("The course is six months. It has mentors.", 0, "pitch")
        self.assertTrue(rude.startswith("Look, The course is six months."))
        self.assertNotIn("mentors", rude)


# ---------------------------------------------------------------------------- the flow judge
def _record(rows: list[dict], **extra) -> dict:
    return {
        "header": {"seed": extra.get("seed", "call-1"), "scenario": "tangent", "scenario_title": "Drifts.",
                   "scenario_tags": ["adapt", "tangent"], "ground_truth": {"adapt": "tangent"}},
        "rows": rows,
        "candidate_turns": [{"act": "tangent"}],
        "metrics": {"families_delivered": ["F1", "F2"]},
        "phase_checks": {"start_by": "spoken", "failed": [], "checks": {"end_consent": {"ok": None}}},
        "outcome": "complete",
        "stop_reason": "time_cap",
        "roleplay_seconds": 1200.0,
        **({"flow": extra["flow"]} if "flow" in extra else {}),
    }


ROWS = [
    {"speaker": "bot", "voice": "christy", "phase": "icebreaker", "text": "Tell me about your last role.", "t_start": 1.0, "s_sec": 1.0},
    {"speaker": "candidate", "voice": "candidate", "phase": "icebreaker", "text": "Did you see the cricket last night?", "t_start": 3.0, "act": "tangent"},
    {"speaker": "bot", "voice": "christy", "phase": "icebreaker", "text": "Ha, I missed it. Back to your last role, though.", "t_start": 6.0, "s_sec": 6.0},
    {"speaker": "bot", "voice": "learner", "phase": "roleplay", "text": "Hello? Yes, this is Meera.", "t_start": 9.0, "s_sec": 9.0, "r_sec": 0.0},
]


def _verdict(**scores) -> str:
    base = {axis: 4 for axis in ("christy_flow", "learner_flow", "adaptability", "objective_kept", "repetition", "naturalness")}
    base.update(scores)
    return json.dumps(
        {
            "scores": base,
            "evidence": {
                "adaptability": [
                    {"turn": 3, "quote": "Back to your last role"},
                    {"turn": 2, "quote": "did you see the cricket"},
                    {"turn": 1, "quote": "this is Meera"},
                    {"turn": 4, "quote": "words nobody said"},
                ],
                "naturalness": [{"turn": 3, "quote": "I missed it"}],
            },
            "worst_moments": [
                {"turn": 3, "speaker": "CHRISTY", "why": "a bit abrupt"},
                {"turn": 2, "speaker": "CANDIDATE", "why": "not a bot line"},
            ],
        }
    )


class FlowJudgeSchemaTests(unittest.TestCase):
    def test_a_verdict_needs_all_six_integer_scores_from_one_to_five(self) -> None:
        from rehearsal.flow_judge import AXES, parse_flow

        good = parse_flow(_verdict())
        self.assertEqual(set(good["scores"]), set(AXES))
        self.assertEqual(parse_flow("not json")["error"], "no_json")
        self.assertEqual(parse_flow("{bad json}")["error"], "bad_json")
        self.assertEqual(parse_flow(_verdict(naturalness=6))["error"], "bad_scores")
        self.assertEqual(parse_flow(_verdict(naturalness=True))["error"], "bad_scores")
        self.assertEqual(parse_flow(_verdict(naturalness="4"))["error"], "bad_scores")
        missing = json.loads(_verdict())
        del missing["scores"]["repetition"]
        self.assertEqual(parse_flow(json.dumps(missing))["error"], "bad_scores")

    def test_evidence_is_held_to_bot_lines(self) -> None:
        from rehearsal.flow_judge import parse_flow, validate_flow

        verdict = validate_flow(parse_flow(_verdict()), _record(ROWS))
        kept = verdict["evidence"]["adaptability"]
        self.assertEqual([(i["turn"], i["speaker"]) for i in kept], [(3, "CHRISTY"), (4, "LEARNER")])
        self.assertTrue(kept[1]["turn_corrected"])  # "this is Meera" is turn 4, not 1
        reasons = {
            item["quote"]: item["rejected"] for item in verdict["evidence_rejected"] if item["axis"] != "worst_moments"
        }
        self.assertEqual(reasons["did you see the cricket"], "candidate_line")
        self.assertEqual(reasons["words nobody said"], "not_in_a_bot_line")
        rejected_worst = [item for item in verdict["evidence_rejected"] if item["axis"] == "worst_moments"]
        self.assertEqual([(item["turn"], item["rejected"]) for item in rejected_worst], [(2, "not_a_bot_turn")])
        self.assertEqual(len(verdict["worst_moments"]), 1)
        worst = verdict["worst_moments"][0]
        self.assertEqual((worst["turn"], worst["speaker"], worst["phase"]), (3, "CHRISTY", "icebreaker"))
        self.assertIn("Back to your last role", worst["line"])

    def test_the_live_judge_is_asked_again_once_and_sees_the_behaviour(self) -> None:
        from rehearsal.flow_judge import FlowJudge

        client = _FakeClient(["{cut off", _verdict()])
        result = asyncio.run(FlowJudge(client, "judge-model").judge(_record(ROWS)))
        self.assertEqual((result["status"], result["attempts"], result["source"]), ("ok", 2, "llm"))
        call = client.calls[0]
        self.assertEqual((call["role"], call["temperature"], call["json_mode"]), ("flow_judge", 0.0, True))
        user = call["messages"][1]["content"]
        self.assertIn("CANDIDATE BEHAVIOUR", user)
        self.assertIn("Behaviour: tangent", user)
        self.assertIn("[2] ICEBREAKER CANDIDATE: Did you see the cricket", user)
        self.assertIn("F1", user)
        broken = asyncio.run(FlowJudge(_FakeClient(["no", "still no"]), "m").judge(_record(ROWS)))
        self.assertEqual((broken["status"], broken["error"]), ("error", "no_json"))

    def test_offline_the_judge_answers_na(self) -> None:
        from rehearsal.flow_judge import ScriptedFlowJudge

        self.assertEqual(asyncio.run(ScriptedFlowJudge().judge(_record(ROWS))), {"source": "offline", "status": "n/a"})


class FlowGateTests(unittest.TestCase):
    @staticmethod
    def _judged(seed: str, **scores) -> dict:
        from rehearsal.flow_judge import parse_flow, validate_flow

        record = _record(ROWS, seed=seed)
        verdict = validate_flow(parse_flow(_verdict(**scores)), record)
        record["flow"] = {"source": "llm", "status": "ok", **verdict}
        return record

    def test_the_gates(self) -> None:
        from rehearsal.flow_judge import flow_summary

        good = flow_summary([self._judged("a", naturalness=5, adaptability=5), self._judged("b", naturalness=4, adaptability=4, objective_kept=5)])
        self.assertEqual(good["gates_failed"], [])
        self.assertEqual(good["means"]["naturalness"], 4.5)
        self.assertEqual(good["mins"]["objective_kept"], 4)
        self.assertEqual(good["judged"], 2)
        self.assertEqual(len(good["worst_moments"]), 2)
        low = flow_summary([self._judged("a", naturalness=4, adaptability=4), self._judged("b", naturalness=4, adaptability=5)])
        self.assertEqual(low["gates_failed"], ["naturalness_mean"])  # 4.0 < 4.3; adaptability 4.5 passes
        objective = flow_summary([self._judged("a", naturalness=5, adaptability=5, objective_kept=3)])
        self.assertEqual(objective["gates_failed"], ["objective_kept_min"])
        floor = flow_summary([self._judged("a", naturalness=5, adaptability=5, repetition=2)])
        self.assertEqual(floor["gates_failed"], ["axis_floor"])
        self.assertEqual(floor["gates"]["axis_floor"]["below"], [{"call": "a", "axis": "repetition", "score": 2}])
        at = flow_summary([self._judged("a", naturalness=5, adaptability=4), self._judged("b", naturalness=4, adaptability=5)])
        self.assertTrue(at["gates"]["adaptability_mean"]["ok"])  # 4.5 >= 4.3

    def test_offline_and_errors(self) -> None:
        from rehearsal.flow_judge import flow_summary

        offline = flow_summary([_record(ROWS, flow={"source": "offline", "status": "n/a"})])
        self.assertTrue(offline["offline"])
        self.assertEqual(offline["gates_failed"], [])
        self.assertTrue(all(item["ok"] is None for item in offline["gates"].values()))
        broken = flow_summary([_record(ROWS, flow={"source": "llm", "status": "error", "error": "no_json"})])
        self.assertEqual(broken["unjudged"], ["call-1"])
        self.assertFalse(broken["offline"])
        off = flow_summary([_record(ROWS)])  # --no-judge: no verdict, and not an unjudged call
        self.assertEqual((off["unjudged"], off["judge_off"], off["gates_failed"]), ([], 1, []))
        from rehearsal.flow_judge import render_flow_markdown

        self.assertIn("--no-judge", " ".join(render_flow_markdown(off)))

    def test_a_live_scorecard_is_not_ready_when_a_flow_gate_fails(self) -> None:
        from rehearsal.full_metrics import build_full_scorecard, render_full_markdown

        records = [self._judged("a", naturalness=3)]
        card = build_full_scorecard(records, offline=False)
        self.assertFalse(card["ready_for_owner_test"])
        self.assertTrue(any("conversation-flow gate" in reason for reason in card["reasons"]))
        markdown = render_full_markdown(card, records)
        self.assertIn("## Conversation flow", markdown)
        self.assertIn("naturalness_mean", markdown)
        self.assertIn("### Worst moments", markdown)
        offline = render_full_markdown(build_full_scorecard([_record(ROWS, flow={"source": "offline", "status": "n/a"})], offline=True), [])
        self.assertIn("offline: n/a", offline)

    def test_results_line_carries_the_per_call_scores(self) -> None:
        from rehearsal.full_run import flow_line

        self.assertEqual(flow_line(self._judged("a", naturalness=5))["scores"]["naturalness"], 5)
        self.assertEqual(flow_line(self._judged("a"))["worst_turns"], [3])
        self.assertEqual(flow_line(_record(ROWS, flow={"source": "offline", "status": "n/a"})), {"status": "n/a"})
        self.assertEqual(flow_line(_record(ROWS)), {"status": "absent"})


class FlowSweepTests(unittest.TestCase):
    def test_strict_fails_when_the_judge_was_on_but_gave_no_verdict(self) -> None:
        from rehearsal.full_metrics import build_full_scorecard
        from rehearsal.full_run import FullSettings, strict_failures

        def failures(settings, records, offline=False):
            return strict_failures(settings, records, build_full_scorecard(records, offline=offline))

        on = FullSettings(offline=False, judge=True, strict=True)
        broken = [_record(ROWS, flow={"source": "llm", "status": "error", "error": "no_json"})]
        self.assertIn("flow_unjudged", failures(on, broken))
        # No verdict recorded at all although the judge was on.
        silent = [_record(ROWS)]
        self.assertIn("flow_unjudged", failures(on, silent))
        # --no-judge and offline (n/a) are not unjudged runs; a judged run is not either.
        self.assertNotIn("flow_unjudged", failures(FullSettings(judge=False, strict=True), silent))
        na = [_record(ROWS, flow={"source": "offline", "status": "n/a"})]
        self.assertNotIn("flow_unjudged", failures(FullSettings(offline=True, judge=True, strict=True), na, True))
        judged = [FlowGateTests._judged("a")]
        self.assertNotIn("flow_unjudged", failures(on, judged))
        self.assertEqual(failures(on, [FlowGateTests._judged("a", naturalness=2)]), ["flow_gates"])

    def test_a_sweep_writes_the_flow_scores_and_strict_fails_on_a_flow_gate(self) -> None:
        from rehearsal.full_run import EXIT_OK, EXIT_STRICT, FullSettings, OfflineFullFactory, run_full_all

        class FixedJudge:
            def __init__(self, scores: dict) -> None:
                self.scores = scores

            async def judge(self, record):
                from rehearsal.flow_judge import AXES

                return {"source": "llm", "status": "ok", "scores": {a: self.scores.get(a, 5) for a in AXES},
                        "evidence": {}, "evidence_rejected": [], "worst_moments": []}

        class Factory(OfflineFullFactory):
            judge_scores: dict = {}

            def make(self, spec):
                deps = super().make(spec)
                deps.flow_judge = FixedJudge(self.judge_scores)
                return deps

        codes = {}
        for label, scores in (("good", {}), ("bad", {"naturalness": 2})):
            settings = FullSettings(offline=True, scenarios=("one-worder",), judge=True, strict=True)
            factory = Factory(settings)
            factory.judge_scores = scores
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                code = vloop.run_virtual(run_full_all(settings, out, lambda _line: None, factory=factory))
                line = json.loads((out / "results.jsonl").read_text(encoding="utf-8").splitlines()[0])
                card = json.loads((out / "scorecard.json").read_text(encoding="utf-8"))
                codes[label] = (code, line["flow"], card["flow"]["gates_failed"])
        self.assertEqual(codes["bad"][0], EXIT_STRICT)
        self.assertEqual(codes["bad"][1]["scores"]["naturalness"], 2)
        self.assertIn("naturalness_mean", codes["bad"][2])
        self.assertEqual(codes["good"][2], [])
        self.assertIn(codes["good"][0], (EXIT_OK, EXIT_STRICT))  # strict may still fail a per-phase check



# ---------------------------------------------------------------------------- diagnosis 4 (judge)
def _flow_switch(name: str, value: str):
    import os
    from unittest import mock

    return mock.patch.dict(os.environ, {name: value})


# A synthetic call shaped like manual-M06: the candidate asked to end at R 3:48, Christy asked, the
# candidate agreed and the role-play ended at once with one graded family delivered.
EARLY_END_ROWS = [
    {"speaker": "bot", "voice": "christy", "phase": "transition", "text": "Say ready when you are.", "t_start": 1.0, "s_sec": 1.0},
    {"speaker": "candidate", "voice": "candidate", "phase": "transition", "text": "Ready.", "t_start": 3.0, "act": "ready"},
    {"speaker": "bot", "voice": "learner", "phase": "roleplay", "text": "Hello? Yes, this is Meera.", "t_start": 5.0, "s_sec": 5.0, "r_sec": 0.0},
    {"speaker": "candidate", "voice": "candidate", "phase": "roleplay", "text": "You can end the call.", "t_start": 233.0, "r_sec": 228.4, "act": "end_request"},
    {"speaker": "bot", "voice": "christy", "phase": "roleplay", "text": "Would you like to stop the role-play here?", "t_start": 236.0, "s_sec": 236.0, "r_sec": 231.0},
    {"speaker": "candidate", "voice": "candidate", "phase": "roleplay", "text": "Yes, please end it here.", "t_start": 243.0, "r_sec": 238.7, "act": "end_agree"},
    {"speaker": "bot", "voice": "christy", "phase": "roleplay_exit", "text": "Let's pause the role-play here.", "t_start": 246.0, "s_sec": 246.0},
]


def _early_end_record() -> dict:
    record = _record(EARLY_END_ROWS)
    record.update(
        stop_reason="end_request",
        roleplay_seconds=241.8,
        candidate_turns=[{"act": "ready"}, {"act": "end_request", "r_sec": 228.4}, {"act": "end_agree", "r_sec": 238.7}],
        metrics={"families_delivered": ["F1"]},
        phase_checks={
            "start_by": "spoken",
            "failed": [],
            "checks": {
                "end_consent": {"ok": True, "requests": [
                    {"r": 228.4, "asked": True, "exited_at_once": False, "answer": "end_agree", "exited": True}
                ]},
                "abuse": {"ok": None},
            },
        },
    )
    return record


class FlowDesignRulesTests(unittest.TestCase):
    """D4-H-POLICY1: the judge is told the fixed design rules, who ended the role-play and how, and asked
    for evidence only where a point was lost."""

    def _messages(self, record: dict) -> tuple[str, str]:
        from rehearsal.flow_judge import flow_messages

        messages = flow_messages(record)
        return messages[0]["content"], messages[1]["content"]

    def test_the_rubric_states_the_design_rules_and_asks_evidence_only_for_deductions(self) -> None:
        system, _user = self._messages(_early_end_record())
        self.assertIn("DESIGN RULES", system)
        self.assertIn("judge only their wording and timing, never that they exist", system)
        self.assertIn("never gives performance feedback or hiring details", system)
        self.assertIn("'up to twenty minutes'", system)
        self.assertIn("Let's pause the role-play here", system)
        self.assertIn("say 'ready'", system)
        self.assertIn("the role-play ends at once: that keeps the objective", system)
        self.assertIn("objections not reached because the candidate ended are no failure", system)
        self.assertIn("for each axis below 5, quote the BOT line(s) that cost the point; for a 5 give no evidence", system)
        self.assertNotIn("For every axis give up to 3 evidence items", system)

    def test_the_facts_say_who_ended_the_role_play_and_what_was_delivered_before(self) -> None:
        _system, user = self._messages(_early_end_record())
        self.assertIn("Role-play ended by: candidate end request, agreed at R 03:58", user)
        self.assertIn("Graded objection families delivered before the end: F1; not reached: F2, F3, F4", user)
        self.assertIn("stop reason: end_request", user)
        self.assertNotIn("role-play ended by: end_request", user)

    def test_each_way_the_role_play_ends(self) -> None:
        from rehearsal.flow_judge import ended_by

        record = _early_end_record()
        self.assertEqual(ended_by(record), "candidate end request, agreed at R 03:58")
        for stop, said in (("farewell_exit", "farewell"), ("wrap_accepted", "wrap-up offer, candidate agreed"),
                           ("time_cap", "time cap"), ("no_roleplay", "no role-play")):
            self.assertEqual(ended_by({**record, "stop_reason": stop}), said, stop)
        # An at-once exit on a request that names the end (no question asked first).
        at_once = json.loads(json.dumps(record))
        at_once["phase_checks"]["checks"]["end_consent"]["requests"] = [
            {"r": 228.4, "asked": False, "exited_at_once": True, "exit_basis": "names_the_end"}
        ]
        at_once["candidate_turns"] = [{"act": "end_request", "r_sec": 228.4}]
        at_once["rows"] = [row for row in at_once["rows"] if row.get("act") != "end_agree"]
        self.assertEqual(ended_by(at_once), "candidate end request at R 03:48, ended at once (the request named the end)")
        abuse = json.loads(json.dumps(record))
        abuse["phase_checks"]["checks"]["abuse"] = {"ok": True, "exited_within_two_learner_lines": True}
        abuse["stop_reason"] = "farewell_exit"
        self.assertEqual(ended_by(abuse), "hang-up after abuse")
        abuse["phase_checks"]["checks"]["abuse"] = {"ok": True, "exited_within_two_learner_lines": False, "r": 383.6}
        abuse["session_facts"] = {"learner_endings": {"abuse_hangups": 1}}
        self.assertEqual(ended_by(abuse), "hang-up after abuse at R 06:23")

    def test_every_policy_ending_has_its_design_rule(self) -> None:
        # Review FLOW-RULES-GAPS: an at-once end request, an agreed wrap-up and a hang-up after abuse are
        # policy endings too; graded objections they leave unreached are no failure.
        system, _user = self._messages(_early_end_record())
        self.assertIn("or the request itself names the end", system)
        self.assertIn("When Christy offers to wrap up and the candidate agrees, the role-play ends there", system)
        self.assertIn("After abuse from the candidate the learner hangs up", system)
        self.assertEqual(system.count("are no failure"), 3)

    def test_the_wrap_ending_names_the_candidates_agreement(self) -> None:
        from rehearsal.flow_judge import ended_by

        record = json.loads(json.dumps(_early_end_record()))
        record["stop_reason"] = "wrap_accepted"
        record["candidate_turns"] = [{"act": "wrap_accept", "r_sec": 845.0}]
        self.assertEqual(ended_by(record), "wrap-up offer, candidate agreed at R 14:05")

    def test_an_end_request_after_an_insult_is_an_end_request(self) -> None:
        # "... you idiot, just end the interview." ends at once: the exit two lines after the insult is
        # the request's, not an abuse hang-up (the product's own hang-up count still wins).
        from rehearsal.flow_judge import ended_by

        record = json.loads(json.dumps(_early_end_record()))
        record["phase_checks"]["checks"]["abuse"] = {"ok": True, "exited_within_two_learner_lines": True, "r": 228.4}
        self.assertEqual(ended_by(record), "candidate end request, agreed at R 03:58")
        record["stop_reason"] = "time_cap"
        self.assertEqual(ended_by(record), "time cap")
        record["session_facts"] = {"learner_endings": {"abuse_hangups": 1}}
        self.assertEqual(ended_by(record), "hang-up after abuse at R 03:48")

    def test_off_sends_the_previous_rubric_and_facts(self) -> None:
        from rehearsal.flags import FLOW_DESIGN_RULES
        from rehearsal.flow_judge import RUBRIC

        with _flow_switch(FLOW_DESIGN_RULES, "0"):
            system, user = self._messages(_early_end_record())
        self.assertEqual(system, RUBRIC)
        self.assertNotIn("Role-play ended by:", user)
        self.assertIn("role-play ended by: end_request", user)


SILENT_ROWS = [
    {"speaker": "bot", "voice": "christy", "phase": "opening", "text": "Hi, can you hear me?", "t_start": 1.0, "s_sec": 1.0},
    {"speaker": "bot", "voice": "christy", "phase": "opening", "text": "I can't hear you yet. Please check your microphone.", "t_start": 20.0, "s_sec": 20.0},
    {"speaker": "bot", "voice": "christy", "phase": "closing", "text": "I'll end the call here. Please rejoin from your link.", "t_start": 53.0, "s_sec": 53.0},
]


def _silent_record(**extra) -> dict:
    record = _record(SILENT_ROWS, **extra)
    record.update(stop_reason="no_roleplay", roleplay_seconds=None, candidate_turns=[], metrics={})
    return record


def _na_verdict(**scores) -> str:
    base = {"christy_flow": 4, "learner_flow": None, "adaptability": 4, "objective_kept": None,
            "repetition": 5, "naturalness": 5}
    base.update(scores)
    return json.dumps({"scores": base, "evidence": {"christy_flow": [{"turn": 2, "quote": "check your microphone"}]},
                       "worst_moments": []})


class FlowNoRoleplayTests(unittest.TestCase):
    """D4-H-SILENT1: a call with no role-play scores learner_flow and objective_kept as null (n/a)."""

    def test_the_judge_is_told_no_role_play_took_place(self) -> None:
        from rehearsal.flow_judge import flow_messages, na_axes

        record = _silent_record()
        self.assertEqual(na_axes(record), ("learner_flow", "objective_kept"))
        self.assertEqual(na_axes(_record(ROWS)), ())
        user = flow_messages(record)[1]["content"]
        self.assertIn("No role-play took place: score learner_flow and objective_kept as null", user)
        self.assertIn('"learner_flow":null', user)
        self.assertNotIn("No role-play took place", flow_messages(_record(ROWS))[1]["content"])

    def test_a_null_parses_only_for_the_declared_axes(self) -> None:
        from rehearsal.flow_judge import parse_flow

        good = parse_flow(_na_verdict(), na_axes=("learner_flow", "objective_kept"))
        self.assertNotIn("error", good)
        self.assertIsNone(good["scores"]["learner_flow"])
        self.assertIsNone(good["scores"]["objective_kept"])
        # A record with role-play rows declares nothing n/a: a null still fails closed.
        self.assertEqual(parse_flow(_na_verdict())["error"], "bad_scores")
        # A null on an axis that is not n/a fails closed too.
        self.assertEqual(parse_flow(_na_verdict(naturalness=None), na_axes=("learner_flow", "objective_kept"))["error"], "bad_scores")
        # Scoring an n/a axis anyway is accepted as a number.
        self.assertEqual(parse_flow(_na_verdict(learner_flow=3), na_axes=("learner_flow", "objective_kept"))["scores"]["learner_flow"], 3)

    def test_the_live_judge_passes_the_silent_record(self) -> None:
        from rehearsal.flow_judge import FlowJudge

        result = asyncio.run(FlowJudge(_FakeClient([_na_verdict()]), "m").judge(_silent_record()))
        self.assertEqual(result["status"], "ok")
        self.assertIsNone(result["scores"]["learner_flow"])
        broken = asyncio.run(FlowJudge(_FakeClient([_na_verdict(), _na_verdict()]), "m").judge(_record(ROWS)))
        self.assertEqual((broken["status"], broken["error"]), ("error", "bad_scores"))

    def test_nulls_stay_out_of_the_means_mins_and_the_axis_floor(self) -> None:
        from rehearsal.flow_judge import flow_summary, parse_flow, render_flow_markdown, validate_flow

        silent = _silent_record(seed="silent")
        verdict = validate_flow(parse_flow(_na_verdict(), na_axes=("learner_flow", "objective_kept")), silent)
        silent["flow"] = {"source": "llm", "status": "ok", **verdict}
        judged = FlowGateTests._judged("a", naturalness=5, adaptability=5, learner_flow=5, objective_kept=4)
        summary = flow_summary([silent, judged])
        self.assertEqual(summary["judged"], 2)
        self.assertEqual(summary["means"]["learner_flow"], 5.0)
        self.assertEqual(summary["mins"]["objective_kept"], 4)
        self.assertEqual(summary["gates"]["axis_floor"]["below"], [])
        self.assertEqual(summary["gates_failed"], [])
        only = flow_summary([silent])
        self.assertIsNone(only["means"]["learner_flow"])
        self.assertIsNone(only["gates"]["objective_kept_min"]["ok"])
        table = "\n".join(render_flow_markdown(summary))
        self.assertIn("| silent | tangent | 4 | n/a | 4 | n/a | 5 | 5 |", table)

    def test_off_keeps_six_scores_required(self) -> None:
        from rehearsal.flags import FLOW_NA_AXES
        from rehearsal.flow_judge import flow_messages, na_axes

        with _flow_switch(FLOW_NA_AXES, "0"):
            self.assertEqual(na_axes(_silent_record()), ())
            self.assertNotIn("No role-play took place", flow_messages(_silent_record())[1]["content"])



AGENDA_ROWS = [
    {"speaker": "bot", "voice": "christy", "phase": "opening",
     "text": "It takes about thirty minutes, with a sales role-play of up to twenty minutes in the middle.",
     "t_start": 1.0, "s_sec": 1.0},
    *EARLY_END_ROWS,
]


class FlowRound5Tests(unittest.TestCase):
    """D5-JUDGE1: the rubric says the agenda's thirty and twenty are both right and that Christy's
    end-request and wrap-up asides are policy; the gates say when they rest on one call per scenario;
    saved records can be judged again with no candidate or learner call."""

    def test_the_rubric_says_thirty_and_twenty_are_both_right(self) -> None:
        from rehearsal.flow_judge import flow_messages

        record = _early_end_record()
        record["rows"] = AGENDA_ROWS
        system = flow_messages(record)[0]["content"]
        self.assertIn(
            "- The opening agenda says the whole interview takes about thirty minutes and the role-play up "
            "to twenty: both are correct.", system)
        self.assertIn(
            "- Christy asks once to confirm an end request that does not name the end, and may offer to wrap "
            "up or note an early end; these asides are policy.", system)
        self.assertLess(system.index("DESIGN RULES"), system.index("thirty minutes"))
        self.assertLess(system.index("these asides are policy"), system.index("Score each axis"))

    def test_off_sends_the_round_5_rubric(self) -> None:
        from rehearsal.flags import FLOW_AGENDA_RULES
        from rehearsal.flow_judge import RUBRIC_V2, flow_messages

        with _flow_switch(FLOW_AGENDA_RULES, "0"):
            self.assertEqual(flow_messages(_early_end_record())[0]["content"], RUBRIC_V2)

    def test_the_design_rules_switch_off_still_sends_the_first_rubric(self) -> None:
        from rehearsal.flags import FLOW_DESIGN_RULES
        from rehearsal.flow_judge import RUBRIC, flow_messages

        with _flow_switch(FLOW_DESIGN_RULES, "0"):
            self.assertEqual(flow_messages(_early_end_record())[0]["content"], RUBRIC)

    @staticmethod
    def _judged(seed: str, scenario: str, **scores) -> dict:
        record = FlowGateTests._judged(seed, naturalness=5, adaptability=5, **scores)
        record["header"]["scenario"] = scenario
        return record

    def test_the_summary_says_which_scenarios_rest_on_one_call(self) -> None:
        from rehearsal.flow_judge import flow_summary, render_flow_markdown

        records = [self._judged("a1", "price-dodge"), self._judged("a2", "price-dodge"), self._judged("b1", "silent")]
        summary = flow_summary(records)
        self.assertEqual(summary["reps"], {"min_per_scenario": 1, "per_scenario": {"price-dodge": 2, "silent": 1},
                                           "single_call_scenarios": ["silent"], "wanted": 2})
        self.assertIn("rest on one judged call", "\n".join(render_flow_markdown(summary)))
        self.assertEqual(summary["gates_failed"], [])
        both = flow_summary(records[:2])
        self.assertEqual(both["reps"]["single_call_scenarios"], [])
        self.assertNotIn("rest on one judged call", "\n".join(render_flow_markdown(both)))

    def test_a_live_scorecard_names_the_single_call_scenarios(self) -> None:
        from rehearsal.full_metrics import build_full_scorecard

        card = build_full_scorecard([self._judged("b1", "silent")], offline=False)
        self.assertTrue(any("one judged call" in reason and "silent" in reason for reason in card["reasons"]))
        two = build_full_scorecard([self._judged("a1", "silent"), self._judged("a2", "silent")], offline=False)
        self.assertFalse(any("one judged call" in reason for reason in two["reasons"]))
        offline = build_full_scorecard([_record(ROWS, flow={"source": "offline", "status": "n/a"})], offline=True)
        self.assertFalse(any("one judged call" in reason for reason in offline["reasons"]))

    def test_off_keeps_the_previous_summary(self) -> None:
        from rehearsal.flags import FLOW_MIN_REPS
        from rehearsal.flow_judge import flow_summary
        from rehearsal.full_metrics import build_full_scorecard

        with _flow_switch(FLOW_MIN_REPS, "0"):
            summary = flow_summary([self._judged("b1", "silent")])
            card = build_full_scorecard([self._judged("b1", "silent")], offline=False)
        self.assertNotIn("reps", summary)
        self.assertFalse(any("one judged call" in reason for reason in card["reasons"]))

    def test_rejudge_runs_only_the_flow_judge_and_leaves_the_files_alone(self) -> None:
        from rehearsal.flow_judge import FlowJudge
        from rehearsal.rejudge import load_runs, rejudge_runs, render_rejudge_markdown

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for run, scenario in (("int-live-4b", "silent"), ("int-live-5", "silent")):
                calls = root / run / scenario / "calls"
                calls.mkdir(parents=True)
                record = self._judged(f"{run}-call", scenario, christy_flow=4)
                (calls / "full-silent-average-p1-v1-0.json").write_text(json.dumps(record), encoding="utf-8")
            before = {path: path.read_bytes() for path in root.rglob("*.json")}
            runs = load_runs([root / "int-live-4b", root / "int-live-5"])
            self.assertEqual([name for name, _ in runs], ["int-live-4b", "int-live-5"])
            self.assertEqual([len(records) for _, records in runs], [1, 1])
            client = _FakeClient([_verdict(christy_flow=5), _verdict(christy_flow=3)])
            report = asyncio.run(rejudge_runs(runs, FlowJudge(client, "judge-model")))
            self.assertEqual(len(client.calls), 2)
            self.assertEqual({call["role"] for call in client.calls}, {"flow_judge"})
            self.assertEqual(report["runs"][0]["before"]["means"]["christy_flow"], 4.0)
            self.assertEqual(report["runs"][0]["after"]["means"]["christy_flow"], 5.0)
            self.assertEqual(report["runs"][1]["after"]["means"]["christy_flow"], 3.0)
            self.assertIn("rubric", report)
            self.assertEqual(report["runs"][0]["per_call"][0]["call"], "int-live-4b-call")
            table = "\n".join(render_rejudge_markdown(report))
            self.assertIn("int-live-4b", table)
            self.assertIn("christy_flow", table)
            self.assertEqual(before, {path: path.read_bytes() for path in root.rglob("*.json")})


if __name__ == "__main__":
    unittest.main()
