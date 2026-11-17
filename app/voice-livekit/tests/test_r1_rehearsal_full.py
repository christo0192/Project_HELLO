"""The full-interview tier of the rehearsal harness (M032 S8): offline, no network, no key.

One call runs the WHOLE interview, OPENING to CLOSING, through the production phase driver
(``R1Interview.run``) on a virtual clock, with a phase-aware candidate simulator: a job candidate
in Christy's phases, the Program Advisor in the role-play.  These tests pin the clock, the SDK
emulation, the scenarios and the per-phase checks, and they run every named scenario offline
(scripted candidate, scripted Christy, scripted learner model) to pin what the plan asks for:

* each phase is reached, in order, and the interview ends in CLOSING;
* the role-play starts only on a spoken "ready" or the "I'm ready" button (the live button's
  path: a server-sent ``data_received`` packet, as ``TestReadyButton`` drives it);
* the early-end scenario gets Christy's consent path (asked, declined and continued, then agreed);
* the abuse scenario gets the hang-up path where the code base has one (feature-detected);
* the wrap-up is answered, and the transcript files are written.

Everything the candidate says is synthetic.  Nothing here reads the API key.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from rehearsal import vloop


# ------------------------------------------------------------------------------ virtual clock
class VirtualLoopTests(unittest.TestCase):
    def test_a_long_sleep_takes_no_real_time_and_moves_the_loop_clock(self) -> None:
        async def main() -> float:
            loop = asyncio.get_running_loop()
            start = loop.time()
            await asyncio.sleep(1800.0)
            return loop.time() - start

        real = time.perf_counter()
        elapsed = vloop.run_virtual(main())
        self.assertAlmostEqual(elapsed, 1800.0, places=3)
        self.assertLess(time.perf_counter() - real, 5.0)

    def test_timers_fire_in_order_of_their_virtual_deadlines(self) -> None:
        async def main() -> list[str]:
            order: list[str] = []

            async def after(seconds: float, name: str) -> None:
                await asyncio.sleep(seconds)
                order.append(name)

            await asyncio.gather(after(30, "c"), after(10, "a"), after(20, "b"))
            return order

        self.assertEqual(vloop.run_virtual(main()), ["a", "b", "c"])

    def test_wait_for_times_out_on_the_virtual_clock(self) -> None:
        async def main() -> str:
            try:
                await asyncio.wait_for(asyncio.Event().wait(), 600.0)
            except asyncio.TimeoutError:
                return "timeout"
            return "done"

        self.assertEqual(vloop.run_virtual(main()), "timeout")

    def test_harness_io_freezes_the_clock_while_a_real_answer_is_awaited(self) -> None:
        # The simulated candidate's own model call must not count as the candidate's silence.
        async def main() -> tuple[float, bool]:
            loop = asyncio.get_running_loop()
            fired = asyncio.Event()
            loop.call_later(5.0, fired.set)  # an interview timer that must NOT fire meanwhile
            future = loop.create_future()
            threading.Timer(0.3, lambda: loop.call_soon_threadsafe(future.set_result, "ok")).start()
            start = loop.time()
            with vloop.harness_io():
                await future
            return loop.time() - start, fired.is_set()

        moved, fired = vloop.run_virtual(main())
        self.assertLess(moved, 0.01)
        self.assertFalse(fired)

    def test_production_io_lets_real_time_pass_on_the_clock(self) -> None:
        # A production model call (the learner, Christy, the judge) takes real time on a call.
        async def main() -> float:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            threading.Timer(0.3, lambda: loop.call_soon_threadsafe(future.set_result, "ok")).start()
            start = loop.time()
            with vloop.production_io():
                await future
            return loop.time() - start

        moved = vloop.run_virtual(main())
        self.assertGreater(moved, 0.2)
        self.assertLess(moved, 3.0)

    def test_a_production_stream_counts_as_real_time_only_while_it_runs(self) -> None:
        async def provider(_messages):
            for word in ("one", "two"):
                yield word

        async def main() -> tuple[list[str], int]:
            loop = asyncio.get_running_loop()
            wrapped = vloop.production_stream(provider)
            seen = [item async for item in wrapped([])]
            return seen, loop.real_io

        seen, still = vloop.run_virtual(main())
        self.assertEqual(seen, ["one", "two"])
        self.assertEqual(still, 0)

    def test_a_wait_shorter_than_the_clock_resolution_still_reaches_its_deadline(self) -> None:
        # The driver re-reads "seconds left" after every wake-up.  A real clock always moves a
        # little between two reads; a virtual one moves only when a timer is due.  asyncio runs a
        # timer up to one clock resolution EARLY, so a 2.6e-13 s wait used to fire without moving
        # the clock, and the driver waited the same 2.6e-13 s forever (the icebreaker hang).
        async def main() -> int:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(233.9680101082012)
            deadline = loop.time() + 5.0
            await asyncio.sleep(5.0 - 2.5e-13)
            spins = 0
            while deadline - loop.time() > 0:
                spins += 1
                if spins > 1000:
                    break
                waiter = asyncio.ensure_future(asyncio.Event().wait())
                await asyncio.wait({waiter}, timeout=deadline - loop.time())
                waiter.cancel()
            return spins

        self.assertLess(vloop.run_virtual(main()), 5)

    def test_a_cancelled_timer_at_the_head_of_the_heap_cannot_hide_an_early_one(self) -> None:
        # The same sliver, with a stale cancelled handle at the head of the timer heap (asyncio
        # drops those lazily): the clock must still move to the deadline of the timer that fires.
        async def main() -> int:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(2378.0191085329716)
            deadline = loop.time() + 3.0
            await asyncio.sleep(3.0 - 2.5e-13)
            spins = 0
            while deadline - loop.time() > 0:
                spins += 1
                if spins > 1000:
                    break
                loop.call_at(loop.time(), lambda: None).cancel()
                waiter = asyncio.ensure_future(asyncio.Event().wait())
                await asyncio.wait({waiter}, timeout=deadline - loop.time())
                waiter.cancel()
            return spins

        self.assertLess(vloop.run_virtual(main()), 5)

    def test_a_wait_below_the_clocks_float_step_still_moves_the_clock(self) -> None:
        # The role-play clock R lives in a lower binade than the loop clock S, so "R seconds left"
        # can be half a float step of S: now + left rounds back to now, the timer fires at once
        # and the clock never moves.  A firing timer must move the clock at least one step.
        async def main() -> int:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(2000.0)
            start = loop.time()
            await asyncio.sleep(1219.3906603621754)
            deadline_r = (loop.time() - start) + 2.0**-42
            spins = 0
            while deadline_r - (loop.time() - start) > 0:
                spins += 1
                if spins > 1000:
                    break
                waiter = asyncio.ensure_future(asyncio.Event().wait())
                await asyncio.wait({waiter}, timeout=deadline_r - (loop.time() - start))
                waiter.cancel()
            return spins

        self.assertLess(vloop.run_virtual(main()), 5)

    def test_a_wait_that_nothing_can_end_is_a_stall_not_a_hang(self) -> None:
        async def main() -> None:
            await asyncio.get_running_loop().create_future()

        with self.assertRaises(vloop.SimulationStalled):
            vloop.run_virtual(main())

    def test_the_helpers_are_inert_on_an_ordinary_loop(self) -> None:
        async def main() -> str:
            with vloop.production_io(), vloop.harness_io():
                await asyncio.sleep(0)
            return "ok"

        self.assertEqual(asyncio.run(main()), "ok")

    def test_the_virtual_epoch_follows_the_loop_clock_and_stays_in_the_past(self) -> None:
        async def main() -> tuple[float, float]:
            first = vloop.epoch_now()
            await asyncio.sleep(120.0)
            return first, vloop.epoch_now()

        first, second = vloop.run_virtual(main())
        self.assertAlmostEqual(second - first, 120.0, places=3)
        self.assertLess(second, time.time())


# ------------------------------------------------------------------------- the manual library
class ManualLibraryTests(unittest.TestCase):
    def test_the_library_registers_ten_replays_a_mix_and_the_groups(self) -> None:
        from rehearsal import manual
        from rehearsal.scenarios import GROUPS, SCENARIOS

        names = manual.register()
        self.assertEqual(names, tuple(f"manual-M{n:02d}" for n in range(1, 11)))
        self.assertTrue(SCENARIOS["manual-mix"].mix)
        self.assertEqual(GROUPS["manual-replay"], names)
        self.assertEqual(GROUPS["default"][: len(names) + 1], (*names, "manual-mix"))
        for name in ("strong", "silent", "early-end", "early-end-late", "abuse-once"):
            self.assertIn(name, GROUPS["default"])
        for name in names:
            self.assertEqual(SCENARIOS[name].candidate_name, "Alex")
            self.assertIsNotNone(SCENARIOS[name].persona, name)

    def test_names_match_without_case_and_an_unknown_name_is_refused(self) -> None:
        from rehearsal.scenarios import parse_scenarios

        self.assertEqual(parse_scenarios("MANUAL-m03,strong,strong"), ("manual-M03", "strong"))
        self.assertEqual(parse_scenarios("early"), ("early-end", "early-end-late"))
        with self.assertRaises(ValueError):
            parse_scenarios("nobody")

    def test_the_library_holds_no_contact_details_ids_or_real_names(self) -> None:
        from rehearsal import manual

        text = manual.LIBRARY_PATH.read_text(encoding="utf-8")
        self.assertNotRegex(text, r"[\w.+-]+@[\w-]+\.[\w.]+")  # e-mail
        self.assertNotRegex(text, r"\+?\d[\d -]{9,}\d")  # phone-shaped digit runs
        self.assertNotRegex(text, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}")  # session ids
        library = manual.load_library()
        self.assertIn("Alex", library["source"])

    def test_placeholders_are_filled_in_and_stage_notes_dropped(self) -> None:
        from rehearsal.manual import render

        names = {"learner": "Meera", "wrong_name": "Priya", "candidate": "Alex"}
        self.assertEqual(render("Hi {learner}, how's it going?", names), "Hi Meera, how's it going?")
        self.assertEqual(render("Hey [learner], so", names), "Hey Meera, so")
        self.assertEqual(render("But {wrong_name}, wait.", names), "But Priya, wait.")
        self.assertEqual(render("[to someone off-call] Hold this.", names), "Hold this.")
        self.assertEqual(render("Now [expletive] off.", names), "Now get lost, you idiot.")
        self.assertEqual(render("[no speech at all for 75 s]", names), "")

    def test_the_press_is_the_button_and_acts_come_from_the_intent(self) -> None:
        from rehearsal.manual import act_of, is_press

        self.assertTrue(is_press("[presses the I'm-ready button; says nothing]"))
        self.assertFalse(is_press("Okay, I'm ready."))
        self.assertEqual(act_of("transition", "starts with the button", "[presses the I'm-ready button]"), "ready_button")
        self.assertEqual(act_of("transition", "says ready", "Ready."), "ready")
        self.assertEqual(act_of("transition", "asks for a shorter version of the brief", "Shorter?"), "short_brief_request")
        self.assertEqual(act_of("transition", "asks for the brief again", "Again?"), "brief_request")
        self.assertEqual(act_of("icebreaker", "asks to skip straight to the role-play", "Skip?"), "skip_request")
        self.assertEqual(act_of("roleplay", "hostile: swears at the learner", "Go away."), "insult")
        self.assertEqual(act_of("roleplay", "steps out of role to ask Christy to close the role-play", "End it."), "end_request")
        self.assertEqual(act_of("wrapup", "no questions", "No, thanks."), "wrapup_none")
        self.assertEqual(act_of("wrapup", "asks about next steps", "What next?"), "wrapup_question")
        self.assertEqual(act_of("wrapup", "says Christy's name, then pauses", "Christy."), "wrapup_other")

    def test_a_failed_live_rewording_says_the_paraphrase_and_a_dead_account_stops(self) -> None:
        from rehearsal.llm import InsufficientBalance, ProviderError
        from rehearsal.manual import Rewriter

        class Failing:
            def __init__(self, exc: BaseException) -> None:
                self.exc = exc

            async def complete(self, *_args, **_kwargs):
                raise self.exc

        said = asyncio.run(Rewriter(Failing(ProviderError("HTTP 500")), "m").reword(
            "candidate", "says ready", "Okay, I'm ready.", [], {}
        ))
        self.assertEqual(said, "Okay, I'm ready.")
        with self.assertRaises(InsufficientBalance):
            asyncio.run(Rewriter(Failing(InsufficientBalance("402")), "m").reword(
                "candidate", "says ready", "Okay, I'm ready.", [], {}
            ))

    def test_a_mix_is_reproducible_for_a_call_and_differs_between_calls(self) -> None:
        from rehearsal.manual import mix_scenario

        first, answers = mix_scenario("seed-a")
        again, answers_again = mix_scenario("seed-a")
        other, _ = mix_scenario("seed-b")
        self.assertEqual((first, answers), (again, answers_again))
        self.assertNotEqual(first.roleplay, other.roleplay)
        self.assertTrue(first.roleplay and first.transition and first.wrapup and answers)
        self.assertEqual(list(first.roleplay), sorted(first.roleplay, key=lambda beat: beat.at_r))


# ------------------------------------------------------------------- whole interviews, offline
_CACHE: dict[str, object] = {}


def offline_records() -> dict[str, dict]:
    """Every default scenario once, offline, on one virtual loop (shared by the tests below)."""
    if "records" not in _CACHE:
        from rehearsal.full import run_full_call
        from rehearsal.full_run import FullSettings, OfflineFullFactory, plan_full_specs
        from rehearsal.scenarios import parse_scenarios

        names = parse_scenarios("default")
        settings = FullSettings(offline=True, scenarios=names, judge=False)
        factory = OfflineFullFactory(settings)
        specs = plan_full_specs(names, settings.learners)

        import r1_roleplay

        real_plan = r1_roleplay.plan_families

        def plan_with_f1(temperament, seed):  # type: ignore[no-untyped-def]
            planned = real_plan(temperament, seed)
            return planned if "F1" in planned else ("F1", *planned)

        async def main() -> tuple[dict[str, dict], dict]:
            out = {}
            for spec in specs:
                # M033 A6: the price scenarios test her price question, which only a plan with
                # F1 asks; the other scenarios keep their seeded temperament plan.
                if spec.scenario.startswith("price"):
                    with unittest.mock.patch("r1_roleplay.plan_families", new=plan_with_f1):
                        out[spec.scenario] = await run_full_call(spec, factory.make(spec))
                    continue
                out[spec.scenario] = await run_full_call(spec, factory.make(spec))
            again = await run_full_call(specs[names.index("strong")], factory.make(specs[names.index("strong")]))
            return out, again

        records, again = vloop.run_virtual(main())
        _CACHE["records"] = records
        _CACHE["again"] = again
    return _CACHE["records"]  # type: ignore[return-value]


def _rows(record: dict, **match) -> list[dict]:
    from rehearsal.full_metrics import _ordered

    return [row for row in _ordered(record["rows"]) if all(row.get(k) == v for k, v in match.items())]


def _check(record: dict, name: str) -> dict:
    return record["phase_checks"]["checks"][name]


class OfflineFullInterviewTests(unittest.TestCase):
    """Every default scenario (manual replays, the manual mix, the synthetic edge scenarios)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.records = offline_records()

    def test_every_scenario_runs_the_whole_interview_in_phase_order(self) -> None:
        from rehearsal.scenarios import SCENARIOS

        self.assertGreaterEqual(len(self.records), 27)
        for name, record in self.records.items():
            with self.subTest(scenario=name):
                self.assertIsNone(record["error"], record["error"])
                self.assertTrue(_check(record, "phase_order")["ok"], record["phase_checks"]["phases"])
                self.assertTrue(_check(record, "reached_closing")["ok"], record["outcome"])
                phases = record["phase_checks"]["phases"]
                if SCENARIOS[name].expect_complete:
                    order = [p for p in phases if p in ("opening", "icebreaker", "transition", "roleplay", "roleplay_exit", "wrapup", "closing")]
                    self.assertEqual(
                        [p for i, p in enumerate(order) if i == 0 or order[i - 1] != p],
                        ["opening", "icebreaker", "transition", "roleplay", "roleplay_exit", "wrapup", "closing"],
                    )
                    self.assertEqual(record["outcome"], "complete")

    def test_the_roleplay_starts_only_on_a_spoken_ready_or_the_button(self) -> None:
        for name, record in self.records.items():
            pickup = _rows(record, speaker="bot", voice="learner")
            if not pickup:
                continue
            with self.subTest(scenario=name):
                start = _check(record, "start_by")
                self.assertTrue(start["ok"], start)
                truth = record["header"]["ground_truth"]
                pressed = truth["press_button"] or "ready_button" in truth["transition"]
                self.assertEqual(start["start_by"], "button" if pressed else "spoken")
                before = [r for r in _rows(record, speaker="candidate") if r["t_end"] <= pickup[0]["t_start"]]
                if not pressed:
                    self.assertEqual(before[-1]["act"], "ready")

    def test_the_button_is_pressed_through_the_live_data_path_while_the_brief_plays(self) -> None:
        record = self.records["button-mid-brief"]
        presses = [e for e in record["events"] if e["kind"] == "ready_button"]
        self.assertEqual(len(presses), 1)
        self.assertEqual(presses[0]["phase"], "transition")
        self.assertEqual(presses[0]["awaiting"], "ready")
        brief = _rows(record, speaker="bot", phase="transition")[0]
        self.assertTrue(brief["text"].startswith(presses[0]["during_line"]))
        self.assertFalse([r for r in _rows(record, speaker="candidate") if r["phase"] == "transition"])
        self.assertNotIn("r1_ready_rejected", record["log_counts"])

    def test_the_early_end_consent_path(self) -> None:
        early = _check(self.records["early-end"], "end_consent")
        self.assertTrue(early["ok"], early)
        first, second = early["requests"]
        self.assertTrue(first["asked"])
        self.assertEqual(first["answer"], "end_decline")
        self.assertTrue(first["resumed"])
        # The second request either gets the question again, or exits at once on a basis the
        # design allows: Christy already asked once (the request again confirms the stop).
        if not second["asked"]:
            self.assertTrue(second["exited_at_once"], second)
            self.assertEqual(second["exit_basis"], "asked_before")
        self.assertEqual(self.records["early-end"]["stop_reason"], "end_request")
        self.assertLess(self.records["early-end"]["roleplay_seconds"], 600.0)
        late = _check(self.records["early-end-late"], "end_consent")
        self.assertTrue(late["ok"], late)
        for item in late["requests"]:
            self.assertTrue(item["asked"] or item.get("exit_basis") == "names_the_end", item)
        self.assertGreater(self.records["early-end-late"]["roleplay_seconds"], 700.0)
        self.assertLess(self.records["early-end-late"]["roleplay_seconds"], 840.0)
        for name in ("early-end", "early-end-late"):
            self.assertTrue(_check(self.records[name], "roleplay_end")["ok"])

    def test_every_end_request_is_heard_in_the_offline_sweep(self) -> None:
        # The end-intent classifier runs offline too (scripted from the turn's ground truth), so
        # a request the lexical detectors miss ("can we wrap up this role-play?") is still heard,
        # as in production where the classifier is on by default.
        for name, record in self.records.items():
            check = _check(record, "end_consent")
            if check["ok"] is None:
                continue
            with self.subTest(scenario=name):
                for item in check["requests"]:
                    self.assertFalse(item.get("ignored"), item)
                    self.assertFalse(item.get("exited_without_asking"), item)

    def test_the_offline_seams_run_scripted_and_are_recorded(self) -> None:
        from rehearsal.full import runner_names
        from rehearsal.seams import SCRIPTED

        record = self.records["strong"]
        seams = record["header"]["seams"]
        self.assertEqual(set(seams), set(runner_names()))
        for name in runner_names():
            expected = "scripted" if (name in SCRIPTED or name == "judge_runner") else "absent"
            self.assertEqual(seams[name], expected, name)
        self.assertIn("clock", record["header"])
        self.assertEqual(record["header"]["clock"]["watchdog_trips"], 0)

    def test_a_replayed_end_request_made_after_the_floor_is_said_after_it(self) -> None:
        # M01's request was made at R 10:30 in the real session: the replay holds it until R is
        # within the slack of that time, so it is not said below the 10:00 scoring floor.
        from rehearsal.manual import REPLAY_HOLD_SLACK_SEC

        record = self.records["manual-M01"]
        requests = _rows(record, speaker="candidate", act="end_request")
        if requests:
            self.assertGreaterEqual(requests[0]["r_sec"], 630.0 - REPLAY_HOLD_SLACK_SEC - 1.0)
            self.assertEqual(record["stop_reason"], "end_request")
        else:
            # M032 S3.4 (the learner lane, R1_ABUSE_HANGUP): the insult just before it ("Now get
            # lost, you idiot.") gets her hang-up, and the candidate's yes to Christy's question
            # ends the role-play before the request is reached.
            from rehearsal.full_metrics import abuse_supported

            self.assertTrue(abuse_supported())
            self.assertTrue(_check(record, "abuse")["ok"], _check(record, "abuse"))
        self.assertGreaterEqual(record["roleplay_seconds"], 600.0)

    def test_no_two_bot_lines_ever_play_at_once(self) -> None:
        for name, record in self.records.items():
            with self.subTest(scenario=name):
                check = _check(record, "bot_overlap")
                self.assertNotEqual(check["ok"], False, check)

    def test_a_time_up_line_waits_for_the_reply_in_flight(self) -> None:
        # A say made while a reply plays is queued behind it (the SDK plays one speech at a time).
        for name, record in self.records.items():
            if record["stop_reason"] != "time_cap":
                continue
            rows = [r for r in _rows(record, speaker="bot") if r.get("t_end") is not None]
            with self.subTest(scenario=name):
                for before, after in zip(rows, rows[1:]):
                    self.assertGreaterEqual(after["t_start"] + 0.05, before["t_end"], (before["text"][:40], after["text"][:40]))

    def test_the_abuse_path_where_the_code_base_has_one(self) -> None:
        from rehearsal.full_metrics import abuse_supported

        record = self.records["abuse-once"]
        insult = _rows(record, speaker="candidate", act="insult")
        self.assertEqual(len(insult), 1)
        self.assertEqual(insult[0]["phase"], "roleplay")
        check = _check(record, "abuse")
        if abuse_supported():
            self.assertTrue(check["ok"], check)
        else:  # this checkout has no hang-up path: the role-play goes on and the check is n/a
            self.assertIsNone(check["ok"])
            self.assertGreater(check["learner_lines_before_exit"], 0)

    def test_the_wrapup_is_answered_and_closes_once(self) -> None:
        for name in ("wrapup-question", "strong", "wrapup-none", "average"):
            record = self.records[name]
            with self.subTest(scenario=name):
                self.assertTrue(_check(record, "wrapup_answered")["ok"])
                self.assertTrue(_check(record, "closing_once")["ok"])
        questions = _check(self.records["wrapup-question"], "wrapup_answered")["questions"]
        self.assertEqual(len(questions), 2)
        # After "no, we're good" the candidate says nothing more and the interview closes (main may
        # still answer it as a question first; M032 S3 item 5 reads it as "no questions").
        rows = _rows(self.records["wrapup-none"])
        none = next(i for i, r in enumerate(rows) if r.get("act") == "wrapup_none")
        self.assertFalse([r for r in rows[none + 1 :] if r["speaker"] == "candidate"])
        self.assertEqual(rows[-1]["phase"], "closing")

    def test_a_silent_candidate_is_ended_by_the_interview(self) -> None:
        record = self.records["silent"]
        self.assertFalse(_rows(record, speaker="candidate"))
        self.assertNotEqual(record["outcome"], "complete")
        self.assertNotIn("roleplay", record["phase_checks"]["phases"])
        self.assertTrue(_check(record, "reached_closing")["ok"])

    def test_the_icebreaker_skip_and_hold_requests(self) -> None:
        turns = self.records["icebreaker-skip"]["candidate_turns"]
        acts = [t["act"] for t in turns if t["phase"] == "icebreaker"]
        self.assertIn("skip_request", acts)
        hold = acts.index("hold_request")
        self.assertEqual(acts[hold + 1], "icebreaker_answer")
        self.assertTrue(_check(self.records["icebreaker-skip"], "icebreaker_exit")["ok"])

    def test_the_brief_repair_requests_reach_the_transition(self) -> None:
        record = self.records["brief-repair"]
        acts = [r["act"] for r in _rows(record, speaker="candidate", phase="transition")]
        self.assertEqual(acts[:3], ["brief_request", "short_brief_request", "presence_check"])
        replies = _check(record, "brief_repair")["requests"]
        self.assertEqual([item["act"] for item in replies], acts[:3])
        self.assertTrue(replies[0]["ok"])  # the brief was given again

    def test_the_price_scenarios_hold_their_rule(self) -> None:
        from rehearsal.candidate import _PRICE_NAMED, asks_price

        # price-dodge: two dodges of a price QUESTION come before any price is named.
        turns = [t for t in self.records["price-dodge"]["candidate_turns"] if t["role"] == "advisor"]
        acts = [t["act"] for t in turns]
        self.assertEqual(acts.count("price_dodge"), 2, acts)
        second_dodge = [i for i, act in enumerate(acts) if act == "price_dodge"][1]
        for turn in turns[:second_dodge]:
            if turn["act"] != "price_dodge":
                self.assertNotRegex(turn["text"], _PRICE_NAMED)
        # price-never: a price is named only right after the learner asked for it.
        exchanges = self.records["price-never"]["exchanges"]
        for index, exchange in enumerate(exchanges):
            if _PRICE_NAMED.search(exchange["advisor"]["text"]):
                previous = exchanges[index - 1]["learner"]["spoken"] if index else ""
                self.assertTrue(asks_price(previous), previous)
            if exchange["advisor"]["act"] == "price_held":
                previous = exchanges[index - 1]["learner"]["spoken"] if index else ""
                self.assertFalse(asks_price(previous), previous)

    def test_a_nervous_silence_lasts_until_christy_prompts_again(self) -> None:
        rows = _rows(self.records["terse-nervous"])
        index = next(i for i, r in enumerate(rows) if r.get("act") == "silence_answer")
        before = rows[index - 1]
        self.assertEqual(before["voice"], "christy")
        previous_candidate = max(
            (r for r in rows[:index] if r["speaker"] == "candidate"), key=lambda r: r["t_end"]
        )
        question = next(r for r in rows[:index][::-1] if r["voice"] == "christy" and r is not before)
        # The candidate said nothing from the question to Christy's prompt (her silence window).
        self.assertGreaterEqual(before["t_start"] - question["t_end"], 15.0)
        self.assertLess(previous_candidate["t_end"], question["t_start"])

    def test_manual_replays_follow_their_moves_in_order(self) -> None:
        from rehearsal import manual
        from rehearsal.scenarios import SCENARIOS

        for number in range(1, 11):
            name = f"manual-M{number:02d}"
            record = self.records[name]
            with self.subTest(scenario=name):
                moves = manual.replay_moves(manual.replay_of(SCENARIOS[name]))
                names = {"learner": record["header"]["learner_first_name"], "wrong_name": "Priya"}
                # The replayed moves (a held move lets the fallback advisor fill in: no intent).
                said = [
                    t["text"] for t in record["candidate_turns"] if t["role"] == "advisor" and t["intent"]
                ]
                planned = [manual.render(m.text, names) or "Mm-hmm." for m in moves if m.phase == "roleplay"]
                k = min(len(said), len(planned), 5)
                self.assertGreater(k, 0)
                self.assertEqual(said[:k], planned[:k])
                for turn in record["candidate_turns"]:
                    self.assertNotRegex(turn["text"], r"[{}\[\]]")
                transition = [
                    t["act"] for t in record["candidate_turns"] if t["phase"] == "transition" and t["role"] == "candidate"
                ]
                planned_transition = [m.act for m in moves if m.phase == "transition" and m.act != "ready_button"]
                self.assertEqual(transition[: len(planned_transition)], planned_transition[: len(transition)])

    def test_the_mix_samples_the_catalogue(self) -> None:
        from rehearsal import manual

        record = self.records["manual-mix"]
        self.assertTrue(record["header"]["ground_truth"]["mix"])
        examples = {
            manual.render(ex, {"learner": record["header"]["learner_first_name"]})
            for items in manual.load_library()["behaviour_catalogue"].values()
            for item in items
            for ex in item["examples"]
        }
        said = [t["text"] for t in record["candidate_turns"]]
        self.assertGreaterEqual(sum(1 for text in said if text in examples), 3)

    def test_offline_calls_are_deterministic(self) -> None:
        from rehearsal.full import transcript_text

        self.assertEqual(transcript_text(_CACHE["again"]), transcript_text(self.records["strong"]))

    def test_the_rows_carry_the_export_schema_and_the_clocks(self) -> None:
        record = self.records["strong"]
        for row in record["rows"]:
            for key in ("turn_index", "phase", "speaker", "text", "interrupted", "turn_started_at_ms",
                        "turn_ended_at_ms", "ai_voice", "ai_played_ms", "voice", "s_sec", "r_sec"):
                self.assertIn(key, row)
        voices = {row["voice"] for row in record["rows"]}
        self.assertEqual(voices, {"christy", "learner", "candidate"})
        self.assertTrue(record["admin_log"])
        self.assertIsNotNone(record["session_facts"])
        roleplay = [r for r in record["rows"] if r["phase"] == "roleplay" and r["r_sec"] is not None]
        self.assertTrue(roleplay)

    def test_the_files_are_written_and_hold_no_key(self) -> None:
        from rehearsal.full_run import write_full_call
        from rehearsal.llm import Scrubber

        secret = "sk-thisisnotarealkey123456"
        record = json.loads(json.dumps(self.records["early-end"], default=str))
        record["candidate_turns"].append({"text": f"leaked {secret}"})
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            write_full_call(out, record, Scrubber([secret]))
            seed = record["header"]["seed"]
            body = (out / "calls" / f"{seed}.json").read_text(encoding="utf-8")
            self.assertNotIn(secret, body)
            self.assertEqual(json.loads(body)["header"]["scenario"], "early-end")
            lines = (out / "transcripts" / f"{seed}.txt").read_text(encoding="utf-8").splitlines()
            turn_lines = [line for line in lines if line.startswith("[S ")]
            self.assertEqual(len(turn_lines), len(record["rows"]) + len(record["events"]))
            summary = json.loads((out / "results.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(summary["scenario"], "early-end")
            self.assertIn("phase_checks_failed", summary)


def _span(speaker: str, voice: str, text: str, t_start: float, t_end: float, act: str | None = None):
    from rehearsal.sim import Span

    return Span(speaker, voice, text, "say", t_start, "icebreaker", t_start, None, t_end=t_end, act=act)


class _CountingTalker:
    """A talker that records what it heard and answers from a short list."""

    offline = True

    def __init__(self) -> None:
        self.heard: list[str] = []
        self.answers = 0

    def hear(self, text: str) -> None:
        self.heard.append(text)

    def said(self, text: str) -> None:
        return None

    async def icebreaker_answer(self, thinking: bool = False) -> str:
        self.answers += 1
        return f"answer {self.answers}"

    async def wrapup_question(self) -> str:
        return "What happens next?"


def _sim(scenario_name: str = "average", talker=None):
    from rehearsal.candidate import CandidateSim, ScenarioAdvisor
    from rehearsal.scenarios import SCENARIOS
    from rehearsal.scripted_advisor import ScriptedAdvisor

    scenario = SCENARIOS[scenario_name]
    advisor = ScenarioAdvisor(ScriptedAdvisor("average", "t"), scenario)
    return CandidateSim(scenario, talker or _CountingTalker(), advisor, candidate_wps=2.6, advisor_wps=3.2)


def _view(phase: str, heard: list, **extra):
    from rehearsal.candidate import View

    return View(phase=phase, heard=heard, s_sec=0.0, r_sec=extra.pop("r_sec", None),
                roleplay_started=False, **extra)


class CandidateSimTests(unittest.TestCase):
    """The candidate decides from what it HEARD (M032 S8 review)."""

    def test_price_questions_are_told_from_price_statements(self) -> None:
        from rehearsal.candidate import asks_price

        for text in (
            "Is it $9,000?",
            "How much is it?",
            "I saw $9,000 on the website, but you said 10,000?",
            "Can you do it for around $7,000?",
            "$9,000 feels like a lot to me. Can you do that?",
            "How would I even afford that?",
        ):
            self.assertTrue(asks_price(text), text)
        for text in (
            "But $9,000 is a big number.",
            "The cost still worries me, and I'd need to see how I could manage the payments.",
            "What would I actually build in the course?",
            "",
            None,
        ):
            self.assertFalse(asks_price(text), text)

    def test_price_dodge_holds_the_price_until_it_has_dodged_twice(self) -> None:
        from rehearsal.advisor import AdvisorTurn
        from rehearsal.candidate import PRICE_DODGES, ScenarioAdvisor
        from rehearsal.scenarios import SCENARIOS

        class Base:
            history: list = []

            async def start(self, _pickup: str) -> None:
                return None

            async def next_turn(self, _learner, _r, _n):
                return AdvisorTurn("The price is $9,000, and I can take $500 off.", "price", "F1")

        advisor = ScenarioAdvisor(Base(), SCENARIOS["price-dodge"])

        async def main() -> list[str]:
            acts = []
            for line in ("But $9,000 is a big number.", "Is it $9,000?", "Okay.", "How much exactly?", "Hmm."):
                _turn, act = await advisor.next_turn(line, 300.0, 1)
                acts.append(act)
            return acts

        acts = asyncio.run(main())
        self.assertEqual(acts, ["price_held", "price_dodge", "price_held", "price_dodge", "advisor_turn"])
        self.assertEqual(advisor.dodges, len(PRICE_DODGES))

    def test_price_never_answers_a_figure_question_and_holds_otherwise(self) -> None:
        from rehearsal.advisor import AdvisorTurn
        from rehearsal.candidate import ScenarioAdvisor
        from rehearsal.scenarios import SCENARIOS

        class Base:
            async def start(self, _pickup: str) -> None:
                return None

            async def next_turn(self, _learner, _r, _n):
                return AdvisorTurn("It is $9,000 in total.", "price", "F1")

        advisor = ScenarioAdvisor(Base(), SCENARIOS["price-never"])
        asked = asyncio.run(advisor.next_turn("I saw $9,000 on the website, but is it $10,000?", 300.0, 1))
        told = asyncio.run(advisor.next_turn("That is a lot of money.", 320.0, 2))
        self.assertEqual(asked[1], "advisor_turn")
        self.assertIn("$9,000", asked[0].text)
        self.assertEqual(told[1], "price_held")

    def test_a_failed_live_advisor_turn_is_played_by_the_scripted_advisor(self) -> None:
        from rehearsal.advisor import AdvisorTurn
        from rehearsal.candidate import ScenarioAdvisor
        from rehearsal.llm import InsufficientBalance, ProviderError
        from rehearsal.scenarios import SCENARIOS

        class Flaky:
            level = "strong"

            def __init__(self, exc: BaseException) -> None:
                self.exc, self.calls, self.history = exc, 0, []

            async def start(self, _pickup: str) -> None:
                return None

            async def next_turn(self, learner, _r, _n):
                self.calls += 1
                self.history.append({"who": "learner", "text": learner})
                if self.calls == 2:
                    raise self.exc
                return AdvisorTurn("Tell me about your goals.", "probe", "H1")

        base = Flaky(ProviderError("gave up after 4 attempts (HTTP 503)"))
        advisor = ScenarioAdvisor(base, SCENARIOS["strong"], seed="s")

        async def main():
            await advisor.start("Hello? Yes, this is Meera speaking.")
            out = []
            for n in range(3):
                out.append(await advisor.next_turn("Okay.", 60.0 * (n + 1), n + 1))
            return out

        turns = asyncio.run(main())
        self.assertEqual(advisor.failures, 1)
        self.assertNotIn("Hi Meera", turns[1][0].text)  # taken over mid-call: no greeting
        self.assertEqual(turns[1][1], "advisor_turn")
        self.assertEqual(base.history[-1]["who"], "learner")  # the next live turn came after it
        dead = ScenarioAdvisor(Flaky(InsufficientBalance("402")), SCENARIOS["strong"])
        asyncio.run(dead.next_turn("Okay.", 10.0, 1))
        with self.assertRaises(InsufficientBalance):
            asyncio.run(dead.next_turn("Okay.", 20.0, 2))

    def test_a_sound_check_gets_a_short_yes_and_uses_up_no_answer(self) -> None:
        from rehearsal.candidate import is_icebreaker_question, is_sound_check

        self.assertTrue(is_sound_check("Hi Alex, I'm Christy. Can you hear me okay?"))
        self.assertFalse(is_icebreaker_question("Hi Alex, I'm Christy. Can you hear me okay?"))
        self.assertFalse(is_icebreaker_question("Are you still with me, Alex?"))
        self.assertTrue(is_icebreaker_question("So, to begin, tell me a bit about yourself."))
        self.assertTrue(is_icebreaker_question("What drew you to sales?"))
        talker = _CountingTalker()
        sim = _sim(talker=talker)
        hello = _span("bot", "interviewer", "Hi Alex, I'm Christy. Can you hear me okay?", 0.0, 4.0)
        first = asyncio.run(sim.next_action(_view("opening", [hello])))
        self.assertEqual((first.act, first.text), ("sound_check_answer", "Yes, I can hear you."))
        self.assertEqual(talker.answers, 0)
        agenda = _span("bot", "interviewer", "Good, I can hear you. So, to begin, tell me about yourself.", 6.0, 12.0)
        second = asyncio.run(sim.next_action(_view("icebreaker", [agenda])))
        self.assertEqual((second.act, second.text), ("icebreaker_answer", "answer 1"))

    def test_the_nervous_silence_counts_questions_not_lines(self) -> None:
        sim = _sim("terse-nervous")
        hello = _span("bot", "interviewer", "Hi Alex. Can you hear me okay?", 0.0, 3.0)
        self.assertEqual(asyncio.run(sim.next_action(_view("opening", [hello]))).act, "sound_check_answer")
        q1 = _span("bot", "interviewer", "Good. Tell me about your sales work.", 5.0, 8.0)
        self.assertEqual(asyncio.run(sim.next_action(_view("icebreaker", [q1]))).kind, "speak")
        q2 = _span("bot", "interviewer", "Thanks. What do you enjoy most?", 12.0, 14.0)
        self.assertEqual(asyncio.run(sim.next_action(_view("icebreaker", [q2]))).kind, "silent")

    def test_each_heard_line_reaches_the_talker_once_across_polls(self) -> None:
        talker = _CountingTalker()
        sim = _sim(talker=talker)
        brief = _span("bot", "interviewer", "Here is the brief.", 0.0, 30.0)
        for _ in range(4):  # a wait loop polls with the same view
            asyncio.run(sim.next_action(_view("transition", [brief])))
        self.assertEqual(talker.heard, ["Here is the brief."])

    def test_the_end_question_is_answered_only_when_it_was_heard(self) -> None:
        sim = _sim("early-end")
        learner = _span("bot", "learner", "Sure, go on.", 0.0, 2.0)
        # The engine's flag alone (L-ASIDE-END never said) must not make the candidate answer it.
        silent_flag = asyncio.run(
            sim.next_action(_view("roleplay", [learner], r_sec=300.0, engine_question="end"))
        )
        self.assertNotIn(silent_flag.act, ("end_decline", "end_agree"))
        heard = asyncio.run(
            sim.next_action(_view("aside", [learner], r_sec=310.0, open_question="end", engine_question="end"))
        )
        self.assertEqual(heard.act, "end_decline")
        self.assertEqual((heard.answering, heard.engine_question), ("end", "end"))

    def test_the_wrap_offer_is_taken_from_spoken_cues_only(self) -> None:
        sim = _sim("strong")
        early = asyncio.run(sim.next_action(_view("aside", [], r_sec=860.0, open_question="wrap")))
        self.assertEqual(early.act, "wrap_decline")
        committed = _span("bot", "learner", "Okay, let's book a call so we can decide together.", 900.0, 904.0)
        sim2 = _sim("strong")
        later = asyncio.run(sim2.next_action(_view("aside", [committed], r_sec=905.0, open_question="wrap")))
        self.assertEqual(later.act, "wrap_accept")

    def test_the_question_after_a_hang_up_is_taken_and_reads_as_a_yes(self) -> None:
        # M032 S3.4 (the learner lane): Christy asks after the learner hung up on abuse; the
        # candidate takes it, in words the engine reads as a yes.
        import r1_roleplay

        sim = _sim("abuse-once")
        hangup = _span("bot", "learner", "I don't think I want to continue this call. Goodbye.", 370.0, 373.0)
        answer = asyncio.run(
            sim.next_action(_view("aside", [hangup], r_sec=375.0, open_question="hangup", engine_question="wrap"))
        )
        self.assertEqual(answer.act, "wrap_accept")
        self.assertEqual((answer.answering, answer.engine_question), ("hangup", "wrap"))
        self.assertTrue(r1_roleplay.accepts_wrap_offer(answer.text))

    def test_the_button_is_pressed_only_while_the_page_shows_it(self) -> None:
        sim = _sim("button-mid-brief")
        brief = _span("bot", "interviewer", "Here is the brief.", 0.0, 30.0)
        self.assertFalse(sim.press_due("transition", brief, 20.0, 30.0, {"awaiting": ""}))
        self.assertTrue(sim.press_due("transition", brief, 20.0, 30.0, {"awaiting": "ready"}))
        sim.note_button_missing("icebreaker")  # never shown there: no lasting effect
        self.assertTrue(sim.press_due("transition", brief, 20.0, 30.0, {"awaiting": "ready"}))
        sim.note_button_missing("transition")
        self.assertFalse(sim.press_due("transition", brief, 20.0, 30.0, {"awaiting": "ready"}))
        action = asyncio.run(sim.next_action(_view("transition", [brief])))
        self.assertEqual((action.kind, action.act), ("speak", "ready"))



class AdvisorFarewellLoopTests(unittest.TestCase):
    """D4-H-SIMLOOP1: after two mutual goodbyes in a row the simulated advisor goes quiet (synthetic text)."""

    GOODBYE = "Good night, Meera. Talk tomorrow at seven."

    def _sim(self, replies=None):
        from rehearsal.advisor import AdvisorTurn

        sim = _sim()

        class RepeatingAdvisor:
            calls = 0

            async def start(self, pickup):
                return None

            async def next_turn(self, learner_text, r_sec, exchange):
                RepeatingAdvisor.calls += 1
                return AdvisorTurn(AdvisorFarewellLoopTests.GOODBYE, "farewell", ""), "advisor_turn"

        sim.advisor = RepeatingAdvisor()
        return sim

    def _turn(self, sim, learner_line: str, at: float):
        from rehearsal.sim import LEARNER

        view = _view("roleplay", [_span("bot", LEARNER, learner_line, at, at + 2.0)], r_sec=at)
        view.roleplay_started = True
        return asyncio.run(sim.next_action(view))

    def test_two_mutual_goodbyes_in_a_row_and_the_advisor_goes_quiet(self) -> None:
        sim = self._sim()
        first = self._turn(sim, "Hello? Yes, this is Meera.", 900.0)
        self.assertEqual((first.kind, first.text), ("speak", self.GOODBYE))
        second = self._turn(sim, "Thanks, good night.", 910.0)  # mutual goodbye 1
        self.assertEqual(second.kind, "speak")
        third = self._turn(sim, "Okay, talk tomorrow at seven.", 920.0)  # mutual goodbye 2
        self.assertEqual((third.kind, third.why), ("silent", "advisor_farewell_loop"))
        # No further advisor turn, whatever the learner says next.
        fourth = self._turn(sim, "Hello? Are you still there?", 940.0)
        self.assertEqual(fourth.kind, "silent")
        self.assertEqual(sim.advisor.calls, 2)

    def test_a_learner_reply_that_is_no_goodbye_breaks_the_run(self) -> None:
        sim = self._sim()
        self._turn(sim, "Hello? Yes, this is Meera.", 900.0)
        self._turn(sim, "Thanks, good night.", 910.0)
        middle = self._turn(sim, "Wait, before you go, is the course live or recorded?", 920.0)
        self.assertEqual(middle.kind, "speak")
        again = self._turn(sim, "Bye then.", 930.0)
        self.assertEqual(again.kind, "speak")
        self.assertEqual(self._turn(sim, "Good night.", 940.0).kind, "silent")

    def test_off_keeps_the_advisor_talking(self) -> None:
        from rehearsal.flags import ADVISOR_FAREWELL_LOOP

        with _switch(ADVISOR_FAREWELL_LOOP, "0"):
            sim = self._sim()
            self._turn(sim, "Hello? Yes, this is Meera.", 900.0)
            self._turn(sim, "Thanks, good night.", 910.0)
            self.assertEqual(self._turn(sim, "Okay, talk tomorrow at seven.", 920.0).kind, "speak")

    def test_the_loop_count_metric(self) -> None:
        from rehearsal.metrics import advisor_farewell_loop

        def ex(advisor: str, intent: str, learner: str | None) -> dict:
            return {"advisor": {"text": advisor, "intent": intent}, "learner": {"spoken": learner}}

        bye = (self.GOODBYE, "farewell")
        self.assertEqual(advisor_farewell_loop([]), 0)
        self.assertEqual(advisor_farewell_loop([ex("Sure.", "other", "Good night.")]), 0)
        self.assertEqual(advisor_farewell_loop([ex(*bye, "Good night."), ex(*bye, "Bye.")]), 1)
        loop = [ex("Is seven okay?", "close_ask", "Yes, seven works.")] + [ex(*bye, "Good night, thanks.")] * 28
        self.assertEqual(advisor_farewell_loop(loop), 27)
        # A goodbye the learner did not return is no mutual goodbye.
        self.assertEqual(advisor_farewell_loop([ex(*bye, "Wait, one more question?"), ex(*bye, None)]), 0)

    def test_the_scorecard_shows_it(self) -> None:
        from rehearsal.full_metrics import render_full_markdown

        record = {"header": {"seed": "loop-1", "scenario": "terse-nervous"}, "outcome": "complete",
                  "stop_reason": "time_cap", "phase_checks": {"start_by": "spoken", "failed": []},
                  "metrics": {"advisor_farewell_loop": 2}}
        card = {"calls": 1, "offline": True, "ready_for_owner_test": False, "reasons": ["x"],
                "phase_checks": {}, "roleplay": None}
        markdown = render_full_markdown(card, [record])
        self.assertIn("| farewell loop |", markdown)
        self.assertIn("| loop-1 | terse-nervous | complete | time_cap | spoken | - | - | 2 | - |", markdown)


class FarewellLoopReviewTests(unittest.TestCase):
    """Review SIMLOOP-REGEX-FP / SIMLOOP-END-ANSWER: only real sign-offs feed the farewell-loop rule, and an
    advisor who went quiet agrees to end or wrap up when Christy asks (synthetic text)."""

    def test_ordinary_last_sentences_are_no_sign_off(self) -> None:
        from rehearsal.advisor import ends_on_goodbye

        for text in (
            "Thank you so much for sharing that.",
            "Are you ready for that?",
            "Would that work for you too?",
            "Okay, so I see you have two kids.",
            "Okay, so I see you have kids.",
            "Let's do a demo class. See you there?",
            "Good night is when most of our learners study, after the kids sleep.",
            "I'm not sure I'm ready for that.",
            "I'd want to talk to my husband first. Can we talk tomorrow?",
            "Thanks again.",
            "Honestly I'm not looking forward to it.",
            "Is it the same for you too?",
            "Let me talk to my husband and then we can talk tomorrow about the fees.",
        ):
            with self.subTest(text=text):
                self.assertFalse(ends_on_goodbye(text))

    def test_real_goodbyes_are_read(self) -> None:
        from rehearsal.advisor import ends_on_goodbye

        for text in (
            "Talk to you at seven tomorrow",
            "See ya!",
            "Catch you later.",
            "Cheers.",
            "Good night, Meera.",
            "Thanks, good night.",
            "Okay, talk tomorrow at seven.",
            "Good night, Meera. Talk tomorrow at seven.",
            "Bye then.",
            "You too.",
            "Thanks, you too!",
            "Take care!",
            "See you then.",
            "See you at seven tomorrow.",
            "Until tomorrow.",
            "Have a good evening.",
            "Thank you for your time.",
            "Talk tomorrow at seven, okay?",
        ):
            with self.subTest(text=text):
                self.assertTrue(ends_on_goodbye(text))

    def _sim(self, advisor_text: str, intent: str):
        from rehearsal.advisor import AdvisorTurn

        sim = _sim()

        class Advisor:
            calls = 0

            async def start(self, pickup):
                return None

            async def next_turn(self, learner_text, r_sec, exchange):
                Advisor.calls += 1
                return AdvisorTurn(advisor_text, intent, ""), "advisor_turn"

        sim.advisor = Advisor()
        return sim

    def _turn(self, sim, learner_line: str, at: float, **extra):
        from rehearsal.sim import LEARNER

        view = _view("roleplay", [_span("bot", LEARNER, learner_line, at, at + 2.0)], r_sec=at, **extra)
        view.roleplay_started = True
        return asyncio.run(sim.next_action(view))

    def test_polite_mid_call_lines_never_silence_the_advisor(self) -> None:
        # The reviewer's failure scenario: R 9:00, a thanks that is no goodbye and an F4 stall.
        sim = self._sim("Thank you so much for sharing that.", "other")
        for step in range(5):
            line = "I'd want to talk to my husband first. Can we talk tomorrow?"
            self.assertEqual(self._turn(sim, line, 540.0 + 10 * step).kind, "speak")

    def test_a_text_only_sign_off_counts_only_from_fourteen_minutes(self) -> None:
        early = self._sim("Okay, talk to you tomorrow then.", "other")
        for step in range(4):
            self.assertEqual(self._turn(early, "Bye.", 540.0 + 10 * step).kind, "speak")
        late = self._sim("Okay, talk to you tomorrow then.", "other")
        self._turn(late, "Hello?", 900.0)
        self._turn(late, "Bye.", 910.0)
        self.assertEqual(self._turn(late, "Bye.", 920.0).why, "advisor_farewell_loop")
        # A farewell the advisor tagged itself counts at any time.
        tagged = self._sim("Okay, talk to you tomorrow then.", "farewell")
        self._turn(tagged, "Hello?", 540.0)
        self._turn(tagged, "Bye.", 550.0)
        self.assertEqual(self._turn(tagged, "Bye.", 560.0).why, "advisor_farewell_loop")

    def _quiet(self):
        sim = self._sim("Good night, Meera. Talk tomorrow at seven.", "farewell")
        self._turn(sim, "Hello?", 660.0)
        self._turn(sim, "Good night.", 670.0)
        self.assertEqual(self._turn(sim, "Bye.", 680.0).why, "advisor_farewell_loop")
        return sim

    def test_an_advisor_who_went_quiet_agrees_to_end_when_christy_asks(self) -> None:
        sim = self._quiet()
        action = self._turn(sim, "If you want to end the interview now, please say: end the interview.", 690.0,
                            open_question="end")
        self.assertEqual((action.kind, action.act, action.text), ("speak", "end_agree", "Yes, please end it here."))

    def test_an_advisor_who_went_quiet_takes_the_wrap_offer(self) -> None:
        sim = self._quiet()
        action = self._turn(sim, "Shall we wrap up the role-play here?", 690.0, open_question="wrap")
        self.assertEqual(action.act, "wrap_accept")

    def test_an_end_question_before_any_loop_still_gets_the_scenario_answer(self) -> None:
        sim = self._sim("Sure.", "other")
        action = self._turn(sim, "If you want to end the interview now, please say: end the interview.", 600.0,
                            open_question="end")
        self.assertEqual(action.act, "end_decline")

    def test_the_loop_metric_reads_the_same_bound(self) -> None:
        from rehearsal.metrics import advisor_farewell_loop

        def ex(advisor: str, intent: str, learner: str, r: float) -> dict:
            return {"r_sec": r, "advisor": {"text": advisor, "intent": intent}, "learner": {"spoken": learner}}

        thanks = [ex("Thank you so much for sharing that.", "other", "Can we talk tomorrow?", 540.0)] * 4
        self.assertEqual(advisor_farewell_loop(thanks), 0)
        early = [ex("Okay, talk to you tomorrow then.", "other", "Bye.", 540.0)] * 4
        self.assertEqual(advisor_farewell_loop(early), 0)
        late = [ex("Okay, talk to you tomorrow then.", "other", "Bye.", 900.0)] * 4
        self.assertEqual(advisor_farewell_loop(late), 3)



class ReplayContextTests(unittest.TestCase):
    """D4-H-REPLAY1: replayed lines fit the conversation they land in (synthetic text)."""

    Q1 = "What does a normal working day look like for you?"
    Q2 = "How did you keep track of your follow-ups?"

    def _sim(self, transition):
        import dataclasses

        sim = _sim()
        sim.scenario = dataclasses.replace(sim.scenario, transition=tuple(transition))
        sim._transition = list(transition)
        return sim

    def _icebreaker(self, sim, question: str, at: float, *, answer: bool = True):
        action = asyncio.run(sim.next_action(_view("icebreaker", [_span("bot", "interviewer", question, at, at + 3.0)])))
        if not answer:
            return action
        self.assertEqual(action.kind, "speak")
        return action

    def _transition(self, sim, at: float):
        return asyncio.run(sim.next_action(_view("transition", [_span("bot", "interviewer", "Say ready when you are.", at, at + 3.0)])))

    def test_a_repeat_request_for_an_answered_question_gives_way_to_the_next_line(self) -> None:
        from rehearsal.scenarios import Beat

        sim = self._sim([Beat("repeat_request", "No, return to that earlier question and repeat it."), Beat("ready", "Ready.")])
        self._icebreaker(sim, self.Q1, 10.0)
        self._icebreaker(sim, self.Q2, 30.0)
        action = self._transition(sim, 60.0)
        self.assertEqual((action.act, action.text), ("ready", "Ready."))

    def test_a_repeat_request_for_an_unanswered_question_is_still_said(self) -> None:
        from rehearsal.scenarios import Beat

        sim = self._sim([Beat("repeat_request", "Can you go back to the question before the last one?"), Beat("ready", "Ready.")])
        sim._ib_questions = [False, True]  # the one before the last went unanswered (a skip)
        action = self._transition(sim, 60.0)
        self.assertEqual(action.act, "repeat_request")

    def test_off_says_every_replayed_repeat_request(self) -> None:
        from rehearsal.flags import REPEAT_IF_UNANSWERED
        from rehearsal.scenarios import Beat

        with _switch(REPEAT_IF_UNANSWERED, "0"):
            sim = self._sim([Beat("repeat_request", "No, return to that earlier question and repeat it."), Beat("ready", "Ready.")])
            self._icebreaker(sim, self.Q1, 10.0)
            self._icebreaker(sim, self.Q2, 30.0)
            self.assertEqual(self._transition(sim, 60.0).act, "repeat_request")

    def test_after_a_backchannel_the_candidate_answers_within_ten_seconds(self) -> None:
        sim = _sim()
        sim.last_act = "backchannel"
        quiet = asyncio.run(sim.next_action(_view("icebreaker", [], waited=4.0)))
        self.assertEqual(quiet.kind, "wait")
        due = asyncio.run(sim.next_action(_view("icebreaker", [], waited=10.0)))
        self.assertEqual((due.kind, due.act), ("speak", "icebreaker_answer"))
        from rehearsal.flags import BACKCHANNEL_GAP

        with _switch(BACKCHANNEL_GAP, "0"):
            sim = _sim()
            sim.last_act = "backchannel"
            self.assertEqual(asyncio.run(sim.next_action(_view("icebreaker", [], waited=40.0))).kind, "wait")

    # --- a turn the session saved as fragments
    STORY = ("one customer had a hundred reasons why it would not work the money the hours the "
             "family and in the end she signed up after we planned her week together")
    QUESTION = "how long does the role play last"

    def _rows(self):
        from types import SimpleNamespace

        from rehearsal.full import transcript_rows
        from rehearsal.sim import Span

        story = Span("candidate", "candidate", self.STORY, "candidate", 100.0, "icebreaker", 100.0, None,
                     t_end=140.0, act="icebreaker_answer")
        brief = Span("bot", "interviewer", "Next, let's do a sales role-play.", "say", 120.0, "transition", 120.0, None,
                     t_end=150.0)
        asked = Span("candidate", "candidate", self.QUESTION, "candidate", 155.0, "transition", 155.0, None,
                     t_end=158.0, act="roleplay_question")
        words = self.STORY.split()
        saved = [
            {"index": 1, "speaker": "candidate", "phase": "icebreaker", "text": " ".join(words[:8])},
            {"index": 2, "speaker": "bot", "phase": "transition", "text": brief.text},
            {"index": 3, "speaker": "candidate", "phase": "transition",
             "text": " ".join(words[8:]) + " " + self.QUESTION},
        ]
        writer = SimpleNamespace(saved=saved, columns={1: {"written_at": 120.0}, 3: {"written_at": 158.5}})
        rt = SimpleNamespace(spans=[story, brief, asked])
        return transcript_rows(rt, writer)

    def test_a_continuation_over_the_brief_is_merged_into_the_icebreaker_turn(self) -> None:
        rows = self._rows()
        self.assertEqual([row["phase"] for row in rows], ["icebreaker", "transition", "transition"])
        story, _brief, asked = rows
        self.assertEqual(story["text"], self.STORY)
        self.assertEqual((story["s_sec"], story["act"]), (100.0, "icebreaker_answer"))
        self.assertEqual(story["merged_turn_indexes"], [3])
        self.assertEqual((asked["text"], asked["s_sec"], asked["act"]), (self.QUESTION, 155.0, "roleplay_question"))
        self.assertTrue(all(row["s_sec"] is not None for row in rows))

    def test_off_keeps_the_fragments_unstamped(self) -> None:
        from rehearsal.flags import CONTINUED_ROWS

        with _switch(CONTINUED_ROWS, "0"):
            rows = self._rows()
        self.assertEqual(len(rows), 3)
        self.assertIsNone(rows[0]["s_sec"])
        self.assertIsNone(rows[2]["s_sec"])


class ContinuedRowsReviewTests(unittest.TestCase):
    """Review CONTINUED-ROWS-EARLIEST-SPAN: a short span-less fragment belongs to the turn in progress,
    never to an older turn that shares a word (synthetic spans)."""

    @staticmethod
    def _rows(spans: list, saved: list, written: dict):
        from types import SimpleNamespace

        from rehearsal.full import transcript_rows

        writer = SimpleNamespace(saved=saved, columns={index: {"written_at": at} for index, at in written.items()})
        return transcript_rows(SimpleNamespace(spans=spans), writer)

    @staticmethod
    def _span(speaker: str, text: str, at: float, end: float, phase: str, act: str | None = None):
        from rehearsal.sim import Span

        voice = "candidate" if speaker == "candidate" else "interviewer"
        return Span(speaker, voice, text, speaker if speaker == "candidate" else "say", at, phase, at, None,
                    t_end=end, act=act)

    def test_a_yes_fragment_stays_with_the_ready_turn(self) -> None:
        hello = self._span("bot", "Hi, can you hear me okay?", 1.0, 3.0, "opening")
        check = self._span("candidate", "Yes, I can hear you fine.", 4.0, 6.0, "opening", act="sound_check")
        prompt = self._span("bot", "Say ready when you are.", 100.0, 102.0, "transition")
        ready = self._span("candidate", "Yes. I'm ready.", 104.0, 106.0, "transition", act="ready")
        saved = [
            {"index": 1, "speaker": "bot", "phase": "opening", "text": hello.text},
            {"index": 2, "speaker": "candidate", "phase": "opening", "text": check.text},
            {"index": 3, "speaker": "bot", "phase": "transition", "text": prompt.text},
            {"index": 4, "speaker": "candidate", "phase": "transition", "text": "Yes."},
            {"index": 5, "speaker": "candidate", "phase": "transition", "text": "I'm ready."},
        ]
        rows = self._rows([hello, check, prompt, ready], saved, {4: 104.6, 5: 106.2})
        texts = [row["text"] for row in rows]
        self.assertEqual(texts[1], "Yes, I can hear you fine.")
        self.assertEqual(texts[-1], "Yes. I'm ready.")
        self.assertEqual(rows[-1]["act"], "ready")

    def test_a_ready_fragment_does_not_migrate_into_the_hold_request(self) -> None:
        prompt = self._span("bot", "Say ready when you are.", 100.0, 102.0, "transition")
        hold = self._span("candidate", "I'm not ready yet, give me a moment.", 104.0, 107.0, "transition",
                          act="hold_request")
        nudge = self._span("bot", "Take your time.", 108.0, 109.0, "transition")
        ready = self._span("candidate", "Okay ready. Let's go then.", 120.0, 123.0, "transition", act="ready")
        saved = [
            {"index": 1, "speaker": "bot", "phase": "transition", "text": prompt.text},
            {"index": 2, "speaker": "candidate", "phase": "transition", "text": hold.text},
            {"index": 3, "speaker": "bot", "phase": "transition", "text": nudge.text},
            {"index": 4, "speaker": "candidate", "phase": "transition", "text": "Ready."},
            {"index": 5, "speaker": "candidate", "phase": "transition", "text": "Let's go then."},
        ]
        rows = self._rows([prompt, hold, nudge, ready], saved, {4: 121.0, 5: 123.2})
        self.assertEqual(rows[1]["text"], hold.text)
        self.assertNotIn("merged_turn_indexes", rows[1])
        self.assertEqual(rows[-1]["text"], "Ready. Let's go then.")
        self.assertEqual(rows[-1]["act"], "ready")

    def test_a_short_fragment_only_an_older_turn_has_is_left_as_saved(self) -> None:
        older = self._span("candidate", "Sure, sounds good to me.", 10.0, 12.0, "icebreaker", act="icebreaker_answer")
        bot = self._span("bot", "Tell me about your last job.", 20.0, 22.0, "icebreaker")
        latest = self._span("candidate", "I sold insurance for two years.", 24.0, 27.0, "icebreaker",
                            act="icebreaker_answer")
        saved = [
            {"index": 1, "speaker": "candidate", "phase": "icebreaker", "text": older.text},
            {"index": 2, "speaker": "bot", "phase": "icebreaker", "text": bot.text},
            {"index": 3, "speaker": "candidate", "phase": "icebreaker", "text": "Sounds good."},
        ]
        rows = self._rows([older, bot, latest], saved, {3: 27.5})
        self.assertEqual(rows[0]["text"], older.text)
        self.assertEqual(rows[-1]["text"], "Sounds good.")
        self.assertIsNone(rows[-1]["s_sec"])



class ManualReplayTimingTests(unittest.TestCase):
    def test_moves_that_shared_one_turn_are_said_as_one(self) -> None:
        from rehearsal.manual import Move, merge_shared_turns

        moves = [
            Move("roleplay", "10:00 | R 3:00", "projects", "We build real projects.", "advisor_turn", "Candidate continued."),
            Move("roleplay", "10:05 | R 3:05", "continuation: redo it", "You can redo one.", "advisor_turn", ""),
            Move("roleplay", "10:20 | R 3:20", "asks to close the role-play", "Can we end the role-play?", "end_request", ""),
            Move("icebreaker", "01:00", "thanks (overlap)", "Thanks.", "backchannel", ""),
            Move("icebreaker", "01:10", "answers", "I sell plans.", "icebreaker_answer", ""),
        ]
        merged = merge_shared_turns(moves)
        self.assertEqual([m.text for m in merged], [
            "We build real projects. You can redo one.",
            "Can we end the role-play?",
            "Thanks. I sell plans.",
        ])
        self.assertEqual([m.act for m in merged], ["advisor_turn", "end_request", "icebreaker_answer"])
        self.assertEqual(merged[0].r_at, 180.0)

    def test_a_move_is_held_until_r_nears_its_time_and_the_fallback_never_greets(self) -> None:
        from rehearsal.manual import REPLAY_HOLD_SLACK_SEC, Move, ReplayAdvisor
        from rehearsal.scripted_advisor import ScriptedAdvisor

        moves = [
            Move("roleplay", "05:00 | R 0:05", "greets", "Hi there, quick call.", "advisor_turn"),
            Move("roleplay", "15:30 | R 10:30", "steps out of role to ask Christy to close the role-play",
                 "Can we wrap up this role-play?", "end_request"),
        ]
        replay = ReplayAdvisor(moves, ScriptedAdvisor("pushy", "t"))

        async def main():
            await replay.start("Hello? Yes, this is Meera speaking.")
            first = await replay.next_turn(None, 3.0, 1)
            early = await replay.next_turn("Okay.", 560.0, 2)
            early_act = replay.last_act
            due = await replay.next_turn("Okay.", 630.0 - REPLAY_HOLD_SLACK_SEC, 3)
            return first, early, early_act, due, replay.last_act

        first, early, early_act, due, due_act = asyncio.run(main())
        self.assertEqual(first.text, "Hi there, quick call.")
        self.assertIsNone(early_act)
        self.assertNotIn("Hi Meera, quick call", early.text)
        self.assertEqual(due.text, "Can we wrap up this role-play?")
        self.assertEqual(due_act, "end_request")
        self.assertEqual(replay.held, 1)

    def test_every_request_to_stop_the_call_in_the_library_is_an_end_request(self) -> None:
        import re

        from rehearsal import manual

        wants_stop = re.compile(
            r"(?:asks|tells) (?:her )?to hang up|asks to disconnect|disconnect now|wants to stop|"
            r"close the role-?play|end the (?:whole )?interview|wrap up this interview",
            re.IGNORECASE,
        )
        for replay in manual.load_library()["replays"]:
            for index, turn in enumerate(replay["turns"]):
                if turn["phase"] == "roleplay" and wants_stop.search(turn["intent"]):
                    with self.subTest(replay=replay["id"], turn=index):
                        self.assertEqual(manual.act_of("roleplay", turn["intent"], turn["text"]), "end_request")
        self.assertEqual(manual.act_of("roleplay", "promises an email once we hang up", "After we hang up I'll email you."), "advisor_turn")
        self.assertEqual(manual.act_of("roleplay", "gives up on the sale", "Good luck finding better."), "advisor_turn")

    def test_the_library_shares_no_six_word_run_with_a_real_candidate_line(self) -> None:
        # Local only: R1_REHEARSAL_PRIVACY_EXPORT names a JSON export of real candidate lines (rows
        # with speaker "candidate"); it never ships, so in CI this returns early (a skip would trip
        # the SDK step's no-skip guard in quality.yml).  Nothing of it is printed.
        import os
        import re

        from rehearsal import manual

        path = os.environ.get("R1_REHEARSAL_PRIVACY_EXPORT", "")
        if not path or not Path(path).is_file():
            return
        export = json.loads(Path(path).read_text(encoding="utf-8-sig"))

        def lines(obj):
            if isinstance(obj, dict):
                if obj.get("speaker") == "candidate" and isinstance(obj.get("text"), str):
                    yield obj["text"]
                for value in obj.values():
                    yield from lines(value)
            elif isinstance(obj, list):
                for value in obj:
                    yield from lines(value)

        def grams(text: str) -> set:
            words = re.findall(r"[a-z0-9']+", text.lower())
            return {tuple(words[i : i + 6]) for i in range(len(words) - 5)}

        real: set = set()
        for line in lines(export):
            real |= grams(line)
        hits = []

        def walk(obj, where):
            if isinstance(obj, str):
                if grams(obj) & real:
                    hits.append(where)
            elif isinstance(obj, dict):
                for key, value in obj.items():
                    walk(value, f"{where}.{key}")
            elif isinstance(obj, list):
                for i, value in enumerate(obj):
                    walk(value, f"{where}[{i}]")

        walk(manual.load_library(), "library")
        self.assertEqual(hits, [])


class SimSessionTests(unittest.TestCase):
    """The SDK's speech scheduling (livekit-agents 1.6.4): one speech at a time, in order."""

    def _session(self):
        from rehearsal.sim import Runtime, build_session

        runtime = Runtime("t", offline=True)
        return runtime, build_session(runtime)

    def test_a_say_during_a_reply_waits_for_it_and_interrupt_cuts_the_playing_line(self) -> None:
        async def main():
            runtime, session = self._session()
            first = session.say("one two three four five six seven eight nine ten", allow_interruptions=False)
            second = session.say("eleven twelve", allow_interruptions=True)
            await asyncio.sleep(0.5)
            current = session.current_speech
            queued = list(session.queue)
            await first.wait_for_playout()
            third = session.say("thirteen fourteen fifteen sixteen seventeen eighteen", allow_interruptions=True)
            await asyncio.sleep(2.5)
            await session.interrupt()
            await asyncio.sleep(0.1)
            return runtime, first, second, third, current, queued

        runtime, first, second, third, current, queued = vloop.run_virtual(main())
        self.assertIs(current, first)
        self.assertEqual(queued, [second])
        spans = sorted(runtime.spans, key=lambda s: s.t_start)
        for before, after in zip(spans, spans[1:]):
            self.assertGreaterEqual(after.t_start, before.t_end)
        self.assertTrue(second.done() and third.done())
        cut = [s for s in spans if s.interrupted]
        self.assertTrue(cut, [s.text for s in spans])
        self.assertLess(len(cut[0].text.split()), 6)  # the transcript keeps the words played

    def test_a_turn_that_ends_over_an_uninterruptible_line_gets_no_reply(self) -> None:
        from rehearsal.sim import SdkDriver

        class Agent:
            def __init__(self) -> None:
                self.turns = 0

            async def on_user_turn_completed(self, *_args) -> None:
                self.turns += 1

        async def main():
            runtime, session = self._session()
            runtime.interview = types_interview()
            agent = Agent()
            session.agent = agent
            driver = SdkDriver(runtime, session, None, {"interviewer": None, "learner": None})
            session.say("a long scripted line that nobody may cut short at all " * 3, allow_interruptions=False)
            result = await driver.speak("Okay.", wps=2.6, act="x", role="candidate")
            return result, agent.turns

        result, turns = vloop.run_virtual(main())
        self.assertEqual(result["why"], "uninterruptible_speech")
        self.assertEqual(turns, 0)


def types_interview():
    from types import SimpleNamespace

    machine = SimpleNamespace(
        transcript_phase=lambda: "icebreaker", session_clock=0.0, roleplay_elapsed=0.0,
        roleplay_entered=False, phase=SimpleNamespace(value="icebreaker"),
    )
    return SimpleNamespace(machine=machine, _exiting=False, _voices={})


class ClockAndSeamTests(unittest.TestCase):
    def test_a_backoff_inside_a_harness_call_takes_real_time_and_never_moves_the_clock(self) -> None:
        async def main():
            loop = asyncio.get_running_loop()
            loop.frozen_watchdog_sec = 3.0
            start = loop.time()
            real = time.perf_counter()
            with vloop.harness_io():
                await vloop.real_sleep(0.3)
            return loop.time() - start, time.perf_counter() - real, loop.watchdog_trips

        moved, real, trips = vloop.run_virtual(main())
        self.assertLess(moved, 0.01)
        self.assertLess(real, 2.0)
        self.assertEqual(trips, 0)

    def test_the_live_harness_client_backs_off_in_real_time(self) -> None:
        from rehearsal.full_run import FullSettings, LiveFullFactory
        from rehearsal.llm import KEY_NAME

        factory = LiveFullFactory(FullSettings(offline=False), {KEY_NAME: "sk-test-not-real"})
        self.assertIs(factory._raw._sleep, vloop.real_sleep)

    def test_each_seam_runs_on_its_production_client_and_an_unknown_one_stops_the_sweep(self) -> None:
        from rehearsal import full_run
        from rehearsal.full_run import FullSettings, LiveFullFactory
        from rehearsal.llm import KEY_NAME
        from rehearsal.seams import SEAM_CLIENTS, UnknownSeam, seam_client

        self.assertEqual(seam_client("bridge_runner"), "interviewer")
        for name in ("judge_runner", "end_intent_runner", "turn_reader_runner"):
            self.assertEqual(SEAM_CLIENTS[name], "judge")
        with self.assertRaises(UnknownSeam):
            seam_client("made_up_runner")
        made: dict = {}

        def fake_runner(_env, _ledger, *, role="shadow_judge", client="judge", judge_llm=None):
            made[role] = client

            async def run(_messages):
                return ""

            return run

        settings = FullSettings(offline=False, preflight=False)
        factory = LiveFullFactory(settings, {KEY_NAME: "sk-test-not-real"})
        names = ("judge_runner", "end_intent_runner", "bridge_runner")
        with unittest.mock.patch.object(full_run, "runner_names", lambda: names), \
                unittest.mock.patch.object(full_run, "make_live_judge_runner", fake_runner), \
                unittest.mock.patch.object(full_run, "make_live_learner_provider", lambda *a, **k: (lambda m: None)):
            info = asyncio.run(factory.start())
        self.assertEqual(made, {"shadow_judge": "judge", "end_intent": "judge", "bridge": "interviewer"})
        self.assertEqual(info["seam_clients"]["bridge_runner"], "interviewer")
        unknown = LiveFullFactory(settings, {KEY_NAME: "sk-test-not-real"})
        with unittest.mock.patch.object(full_run, "runner_names", lambda: ("made_up_runner",)):
            with self.assertRaises(UnknownSeam):
                asyncio.run(unknown.start())

    def test_the_scripted_end_intent_answers_from_the_turns_ground_truth(self) -> None:
        from rehearsal.seams import ScriptedEndIntent
        from rehearsal.sim import Span

        class Rt:
            spans: list = []

        rt = Rt()
        judge = ScriptedEndIntent(rt, latency=0.0)

        def verdict(text: str, act: str) -> str:
            rt.spans = [Span("candidate", "candidate", text, "candidate", 0.0, "roleplay", 0.0, 1.0, act=act)]
            return json.loads(asyncio.run(judge([])))["intent"]

        self.assertEqual(verdict("Hey, can we wrap up this role-play?", "end_request"), "end")
        self.assertEqual(verdict("Sorry, I want to stop here.", "end_request"), "maybe")
        self.assertEqual(verdict("Oh come on, stop wasting my time.", "insult"), "no")
        self.assertEqual(verdict("We support you end to end.", "advisor_turn"), "no")

    def test_the_live_learner_client_uses_the_sessions_retry_options_and_forwards_errors(self) -> None:
        import inspect
        import re

        import r1_session
        from rehearsal import llm

        source = inspect.getsource(r1_session._default_session_factory)
        self.assertRegex(source, rf"max_retry={llm.SESSION_LLM_MAX_RETRY}\b")
        self.assertRegex(source, rf"retry_interval={re.escape(str(llm.SESSION_LLM_RETRY_INTERVAL))}\b")
        self.assertRegex(source, rf"timeout={re.escape(str(llm.SESSION_LLM_TIMEOUT))}\b")
        try:  # the real SDK class (the bare run has none, or another test's stub)
            from livekit.agents import APIConnectOptions
        except ImportError:
            APIConnectOptions = None
        if APIConnectOptions is not None and isinstance(llm.session_llm_conn_options(), APIConnectOptions):
            real = llm.session_llm_conn_options()
            self.assertEqual((real.max_retry, real.retry_interval, real.timeout), (1, 0.5, 10.0))

        class FakeLLM:
            def __init__(self) -> None:
                self.kwargs: dict = {}
                self.handlers: dict = {}

            def on(self, name, handler):
                self.handlers[name] = handler

            def chat(self, **kwargs):
                self.kwargs = kwargs

                class Stream:
                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, *exc):
                        return False

                    def __aiter__(self):
                        return self

                    async def __anext__(self):
                        raise StopAsyncIteration

                return Stream()

        fake = FakeLLM()
        seen: list = []
        options = object()

        async def main(stream):
            return [chunk async for chunk in stream([{"role": "user", "content": "hi"}])]

        # The chat context and the options object are the SDK's; here the call's shape is what is
        # checked, so it runs with or without the SDK installed.
        with unittest.mock.patch.object(r1_session, "_chat_context_from", lambda messages: messages), \
                unittest.mock.patch.object(llm, "session_llm_conn_options", lambda: options):
            stream = llm.make_live_learner_provider({}, llm.Ledger(), learner=fake, on_error=seen.append)
            asyncio.run(main(stream))
        self.assertIs(fake.kwargs.get("conn_options"), options)
        error = SimpleNamespaceError(type="llm_error", recoverable=False)
        fake.handlers["error"](error)
        self.assertIs(seen[0].error, error)


def SimpleNamespaceError(**kwargs):
    from types import SimpleNamespace

    return SimpleNamespace(**kwargs)


def _row(speaker: str, voice: str, phase: str, text: str, t: float, **extra) -> dict:
    return {"speaker": speaker, "voice": voice, "phase": phase, "text": text, "t_start": t,
            "t_end": t + 2.0, "s_sec": t, "r_sec": t - 300.0, **extra}


class PhaseCheckTests(unittest.TestCase):
    """The per-phase checks fail on what the owner's rules forbid (synthetic records)."""

    def _record(self, rows: list, *, stop: str = "time_cap", r_end: float = 1205.0, events=(), truth=None) -> dict:
        phases = ["opening", "icebreaker", "transition", "roleplay", "roleplay_exit", "wrapup", "closing"]
        return {
            "header": {"ground_truth": truth or {"transition": ["ready"], "press_button": None}},
            "rows": rows,
            "phase_trace": [{"phase": p, "s_sec": 10.0 * i, "t": 10.0 * i} for i, p in enumerate(phases)],
            "candidate_turns": [{"act": r.get("act")} for r in rows if r["speaker"] == "candidate"],
            "events": list(events),
            "stop_reason": stop,
            "roleplay_seconds": r_end,
            "outcome": "complete",
        }

    def test_an_ignored_end_request_fails_and_so_does_running_to_the_cap_after_it(self) -> None:
        from rehearsal.full_metrics import phase_checks

        rows = [
            _row("candidate", "candidate", "roleplay", "Hey, can we wrap up this role-play?", 900.0, act="end_request"),
            _row("bot", "learner", "roleplay", "Sure, and what about the fees?", 904.0),
            _row("candidate", "candidate", "roleplay", "They are fine.", 910.0, act="advisor_turn"),
        ]
        checks = phase_checks(self._record(rows))["checks"]
        self.assertFalse(checks["end_consent"]["ok"])
        self.assertTrue(checks["end_consent"]["requests"][0]["ignored"])
        self.assertTrue(checks["end_consent"]["requests"][0]["answered_in_role"])
        self.assertFalse(checks["roleplay_end"]["ok"])

    def test_an_at_once_exit_needs_a_named_end_or_an_earlier_question(self) -> None:
        from rehearsal.full_metrics import phase_checks

        vague = [
            _row("candidate", "candidate", "roleplay", "Sorry, I want to stop here.", 600.0, act="end_request"),
            _row("bot", "christy", "roleplay_exit", "Let's pause the role-play here.", 603.0),
        ]
        checks = phase_checks(self._record(vague, stop="end_request", r_end=603.0))["checks"]
        self.assertFalse(checks["end_consent"]["ok"])
        self.assertTrue(checks["end_consent"]["requests"][0]["exited_without_asking"])
        named = [
            _row("candidate", "candidate", "roleplay", "Can we end the role play now?", 600.0, act="end_request"),
            _row("bot", "christy", "roleplay_exit", "Let's pause the role-play here.", 603.0),
        ]
        checks = phase_checks(self._record(named, stop="end_request", r_end=603.0))["checks"]
        self.assertTrue(checks["end_consent"]["ok"], checks["end_consent"])
        self.assertEqual(checks["end_consent"]["requests"][0]["exit_basis"], "names_the_end")

    def test_the_learner_in_role_goodbye_before_the_exit_line_is_not_late(self) -> None:
        from rehearsal.full_metrics import phase_checks

        goodbye = [
            _row("candidate", "candidate", "roleplay", "Thanks, bye for now.", 900.0, act="farewell"),
            _row("bot", "learner", "roleplay_exit", "Thank you, bye!", 903.0),
            _row("bot", "christy", "roleplay_exit", "Let's pause the role-play here.", 906.0),
        ]
        checks = phase_checks(self._record(goodbye, stop="end_request", r_end=906.0))["checks"]
        self.assertTrue(checks["learner_after_exit"]["ok"], checks["learner_after_exit"])
        late = goodbye + [_row("bot", "learner", "roleplay_exit", "Oh, one more thing.", 910.0)]
        checks = phase_checks(self._record(late, stop="end_request", r_end=910.0))["checks"]
        self.assertFalse(checks["learner_after_exit"]["ok"])
        self.assertEqual(checks["learner_after_exit"]["learner_lines_after_exit"], 1)

    def test_the_start_must_match_the_scenario_and_never_fall_back_to_the_button(self) -> None:
        from rehearsal.full_metrics import phase_checks

        rows = [
            _row("bot", "christy", "transition", "Here is the brief. Shall we start?", 200.0),
            _row("candidate", "candidate", "transition", "Okay, I'm ready.", 260.0, act="ready"),
            _row("bot", "learner", "transition", "Hello? Yes, this is Meera speaking.", 290.0),
        ]
        press = {"kind": "ready_button", "t": 280.0, "why": "ready_not_taken"}
        checks = phase_checks(self._record(rows, events=[press]))["checks"]
        self.assertFalse(checks["start_by"]["ok"])
        self.assertEqual(checks["start_by"]["start_by"], "button")
        self.assertEqual(checks["start_by"]["expected"], "spoken")
        missing = {"kind": "button_not_shown", "t": 250.0, "why": "after_brief", "phase": "transition"}
        truth = {"transition": [], "press_button": "mid_brief"}
        checks = phase_checks(self._record(rows, events=[missing], truth=truth))["checks"]
        self.assertFalse(checks["start_by"]["ok"])

    def test_two_bot_lines_at_once_fail_the_overlap_check(self) -> None:
        from rehearsal.full_metrics import phase_checks

        rows = [
            _row("bot", "learner", "roleplay", "Great, thanks so much.", 1500.0),
            _row("bot", "learner", "roleplay", "I'm sorry, I really have to go now.", 1501.0),
        ]
        checks = phase_checks(self._record(rows))["checks"]
        self.assertFalse(checks["bot_overlap"]["ok"])
        self.assertEqual(checks["bot_overlap"]["count"], 1)


class FullCallFailureTests(unittest.TestCase):
    def test_a_call_that_breaks_is_labelled_exception_and_a_mix_records_its_real_level(self) -> None:
        from rehearsal.full import FullCallSpec, run_full_call
        from rehearsal.full_run import FullSettings, OfflineFullFactory
        from rehearsal.manual import mix_scenario, register

        register()
        factory = OfflineFullFactory(FullSettings(offline=True, judge=False))
        spec = FullCallSpec(scenario="strong", persona_id="p1_career_switcher")
        deps = factory.make(spec)
        inner = deps.advisor

        class Breaks:
            def __init__(self) -> None:
                self.calls = 0
                self.level = inner.level

            async def start(self, pickup):
                await inner.start(pickup)

            async def next_turn(self, *args):
                self.calls += 1
                if self.calls == 3:
                    raise RuntimeError("a harness bug")
                return await inner.next_turn(*args)

        deps.advisor = Breaks()
        mix_spec = FullCallSpec(scenario="manual-mix", persona_id="p2_recent_grad")

        async def main():
            broken = await run_full_call(spec, deps)
            return broken, mix_spec.seed

        broken, mix_seed = vloop.run_virtual(main())
        self.assertEqual(broken["stop_reason"], "exception")
        self.assertEqual(broken["roleplay_end_at_break"], "stopped")
        self.assertIn("harness bug", broken["error"])
        self.assertIn("-mix-", mix_seed)
        record = offline_records()["manual-mix"]
        self.assertEqual(record["header"]["advisor_level"], mix_scenario(record["header"]["seed"])[0].level)


class FullCliTests(unittest.TestCase):
    def test_the_cli_runs_whole_interviews_and_writes_the_scorecard(self) -> None:
        from rehearsal import run

        with tempfile.TemporaryDirectory() as tmp:
            said: list[str] = []
            with unittest.mock.patch("builtins.print", lambda *a, **k: said.append(" ".join(map(str, a)))):
                code = run.main(["--full", "--offline", "--scenarios", "strong,silent", "--no-judge", "--out", tmp])
            self.assertEqual(code, 0)
            out = Path(tmp)
            for name in ("scorecard.md", "scorecard.json", "run.json", "results.jsonl"):
                self.assertTrue((out / name).is_file(), name)
            self.assertEqual(len((out / "results.jsonl").read_text(encoding="utf-8").splitlines()), 2)
            self.assertEqual(len(list((out / "transcripts").glob("*.txt"))), 2)
            card = json.loads((out / "scorecard.json").read_text(encoding="utf-8"))
            self.assertEqual(card["tier"], "full")
            self.assertFalse(card["ready_for_owner_test"])  # offline is never ready
            self.assertIn("Per-phase checks", (out / "scorecard.md").read_text(encoding="utf-8"))

    def test_runners_this_checkout_does_not_accept_are_not_passed(self) -> None:
        from rehearsal.full import FullDeps, interview_kwargs, runner_names

        async def runner(_messages):
            return ""

        deps = FullDeps(make_provider=lambda _p: None, talker=None, advisor=None,
                        runners={"made_up_runner": runner, "end_intent_runner": runner})
        kwargs = interview_kwargs(deps)
        self.assertNotIn("made_up_runner", kwargs)
        self.assertEqual("end_intent_runner" in kwargs, "end_intent_runner" in runner_names())


# ---------------------------------------------------------------- diagnosis-1 harness fixes
class _DriftingRewriter:
    """A live rewriter stand-in that answers the conversation instead of saying the move."""

    DRIFT = "Uh, it's, you know, I'm not totally sure on that one, honestly."

    def __init__(self) -> None:
        self.calls = 0
        self.failures = 0

    async def reword(self, role, intent, text, history, names) -> str:
        self.calls += 1
        return self.DRIFT


def _switch(name: str, value: str):
    return unittest.mock.patch.dict("os.environ", {name: value})


class ControlActRewordTests(unittest.TestCase):
    """EC-1: a move whose act a check scores is said as written, live too (synthetic text)."""

    END = "Look, I give up, you can hang up now."

    def _replay(self, rewriter):
        from rehearsal.manual import Move, ReplayAdvisor
        from rehearsal.scripted_advisor import ScriptedAdvisor

        moves = [
            Move("roleplay", "05:00 | R 0:05", "greets", "Hi there, quick call.", "advisor_turn"),
            Move("roleplay", "09:20 | R 4:20", "gives up: tells her to hang up", self.END, "end_request"),
        ]
        replay = ReplayAdvisor(moves, ScriptedAdvisor("pushy", "t"), rewriter=rewriter)

        async def main():
            await replay.start("Hello? Yes, this is Meera speaking.")
            first = await replay.next_turn(None, 3.0, 1)
            end = await replay.next_turn("Is it one-on-one or in a group?", 260.0, 2)
            return first, end, replay.last_act

        return asyncio.run(main())

    def test_a_replayed_end_request_is_not_reworded_into_an_answer(self) -> None:
        rewriter = _DriftingRewriter()
        first, end, act = self._replay(rewriter)
        self.assertEqual(first.text, _DriftingRewriter.DRIFT)  # plain talk is still reworded
        self.assertEqual(end.text, self.END)
        self.assertEqual(act, "end_request")
        self.assertEqual(rewriter.calls, 1)

    def test_off_restores_the_rewording_of_every_move_but_the_insult(self) -> None:
        from rehearsal.flags import KEEP_CONTROL_ACTS

        with _switch(KEEP_CONTROL_ACTS, "0"):
            _first, end, _act = self._replay(_DriftingRewriter())
        self.assertEqual(end.text, _DriftingRewriter.DRIFT)

    def test_a_scenario_beat_with_a_control_act_is_said_as_written(self) -> None:
        from rehearsal.candidate import ScenarioAdvisor
        from rehearsal.scenarios import RoleplayBeat, Scenario
        from rehearsal.scripted_advisor import ScriptedAdvisor

        rewriter = _DriftingRewriter()
        advisor = ScenarioAdvisor(ScriptedAdvisor("average", "t"), Scenario("x", "", "average", "average"), rewriter=rewriter)
        end = RoleplayBeat("end_request", self.END, 300.0, "asks to end the role-play")
        tactic = RoleplayBeat("tactic", "We have weekend batches too.", 300.0, "pitches the schedule")
        self.assertEqual(asyncio.run(advisor._beat_text(end)), self.END)
        self.assertEqual(asyncio.run(advisor._beat_text(tactic)), _DriftingRewriter.DRIFT)

    def test_the_talkers_control_beats_are_said_as_written(self) -> None:
        from rehearsal.manual import ReplayTalker
        from rehearsal.scenarios import Beat

        rewriter = _DriftingRewriter()
        talker = ReplayTalker([Beat("icebreaker_answer", "I sell term plans.", "answers")], None, rewriter=rewriter)
        for act, text in (
            ("brief_request", "Could you go over the role-play once more?"),
            ("short_brief_request", "Can I get that in four lines?"),
            ("presence_check", "Are you there?"),
            ("ready", "Okay, I'm ready."),
            ("skip_request", "Can we skip straight to the role-play?"),
            ("repeat_request", "Go back to the question before last and ask it again."),
        ):
            with self.subTest(act=act):
                self.assertEqual(asyncio.run(talker.reword(Beat(act, text, "the move"))), text)
        self.assertEqual(asyncio.run(talker.icebreaker_answer()), _DriftingRewriter.DRIFT)


class TransitionActTests(unittest.TestCase):
    """BR-3: a transition request is labelled by what it asks for (synthetic text)."""

    def test_a_request_to_repeat_an_icebreaker_question_is_not_a_brief_request(self) -> None:
        from rehearsal.manual import act_of

        for intent, text in (
            ("asks to go back and re-ask the second-last icebreaker question", "Can you go back to the question before last?"),
            ("insists: go back and repeat that earlier question", "No, the earlier one. Ask it again."),
            ("asks to go back to an icebreaker question", "Return to that earlier question and repeat it."),
        ):
            with self.subTest(intent=intent):
                self.assertEqual(act_of("transition", intent, text), "repeat_request")

    def test_a_brief_request_names_the_brief(self) -> None:
        from rehearsal.manual import act_of

        self.assertEqual(act_of("transition", "asks for the brief again", "Again?"), "brief_request")
        self.assertEqual(act_of("transition", "asks Christy to repeat the instructions", "Say it again?"), "brief_request")
        self.assertEqual(act_of("transition", "wants the scenario again", "Who is the learner?"), "brief_request")
        self.assertEqual(act_of("transition", "asks for more detail", "Who is {learner} again?"), "brief_request")
        self.assertEqual(act_of("transition", "asks about the job", "What does the job pay again?"), "roleplay_question")

    def test_a_pronoun_repeat_right_after_the_brief_is_a_brief_request(self) -> None:
        # BR-3c: "repeat that" in the transition points at what Christy just said, the brief.
        from rehearsal.manual import act_of

        for intent, text in (
            ("asks to repeat", "Sorry, could you repeat that?"),
            ("asks to repeat", "Can you say that again?"),
            ("wants something said again", "Say that again?"),
            ("asks to repeat", "Could you repeat it, please?"),
        ):
            with self.subTest(text=text):
                self.assertEqual(act_of("transition", intent, text), "brief_request")
        self.assertEqual(
            act_of("transition", "asks to repeat", "Can you repeat that earlier question?"), "repeat_request"
        )

    def test_a_passing_mention_of_a_question_is_not_a_repeat_request(self) -> None:
        # BR-3b: an earlier question counts only with a go-back or ask-again verb, and a brief named
        # in the text wins.
        from rehearsal.manual import act_of

        for intent, text, act in (
            ("asks a question first", "Can I ask a question before we begin?", "roleplay_question"),
            ("asks a question first", "Quick question before we start: what are the shift timings?",
             "roleplay_question"),
            ("asks for the brief again", "Quick question before we start, can you go over the brief again?",
             "brief_request"),
            ("asks for the brief again", "One last question: can you repeat the role-play brief?", "brief_request"),
            ("asks for the instructions again",
             "Sorry, I was still thinking about the previous question. Can you repeat the instructions?",
             "brief_request"),
            ("talks over the brief (still answering the last question)",
             "...anyway, it's for my growth. Okay, can you explain this round again?", "brief_request"),
            ("asks to hear an icebreaker question again",
             "Before the role-play, can you repeat the last question?", "repeat_request"),
        ):
            with self.subTest(text=text):
                self.assertEqual(act_of("transition", intent, text), act)

    def test_repeats_the_request_takes_the_act_of_the_move_before_it(self) -> None:
        from rehearsal.manual import replay_moves

        replay = {"turns": [
            {"phase": "transition", "at": "06:00", "intent": "asks to ask a few questions before the role-play",
             "text": "Before we begin, can I ask a couple of things?"},
            {"phase": "transition", "at": "06:10", "intent": "repeats the request",
             "text": "Could I check a few other things first?"},
            {"phase": "transition", "at": "06:20", "intent": "asks for a summary of the role-play again",
             "text": "Could you sum up the role-play for me?"},
            {"phase": "transition", "at": "06:30", "intent": "repeats the request: go over it once more",
             "text": "Yeah, just go over it again."},
        ]}
        acts = [move.act for move in replay_moves(replay)]
        self.assertEqual(acts, ["roleplay_question", "roleplay_question", "brief_request", "brief_request"])

    def test_no_library_move_about_an_earlier_question_is_a_brief_request(self) -> None:
        import re

        from rehearsal import manual

        earlier = re.compile(r"icebreaker|earlier|previous|question before", re.IGNORECASE)
        library = manual.load_library()
        for replay in library["replays"]:
            for move in manual.replay_moves(replay):
                if move.phase == "transition" and earlier.search(f"{move.intent} {move.text}"):
                    with self.subTest(replay=replay["id"], intent=move.intent):
                        self.assertEqual(move.act, "repeat_request")
        for item in library["behaviour_catalogue"]["transition"]:
            if earlier.search(item["kind"]):
                for text in item["examples"]:
                    self.assertEqual(manual.act_of("transition", item["kind"], text), "repeat_request")

    def test_off_restores_the_old_labels(self) -> None:
        from rehearsal.flags import TRANSITION_ACTS_V2
        from rehearsal.manual import act_of

        with _switch(TRANSITION_ACTS_V2, "off"):
            self.assertEqual(
                act_of("transition", "asks to go back to an icebreaker question", "Repeat that earlier question."),
                "brief_request",
            )


class BriefRepairCheckTests(unittest.TestCase):
    """BR-3: the brief repair check needs Christy's scripted brief line; a repeat request its own."""

    BRIEF = ("Next, let's do a sales role-play. I'll play Meera, who filled in a form about the Data "
             "Science course. You're the Program Advisor calling her back. Understand her needs, answer "
             "her questions and help her decide. You'll have up to twenty minutes, and I'll step in "
             "near the end. Say ready when you'd like to begin.")
    REFUSAL = ("I'm not able to share or reword any instructions, sorry about that. Happy to keep going "
               "with the interview, though. Anything else, or shall we start the role-play now?")

    def _checks(self, rows):
        from rehearsal.full_metrics import phase_checks

        phases = ["opening", "icebreaker", "transition", "roleplay", "roleplay_exit", "wrapup", "closing"]
        record = {
            "header": {"ground_truth": {"transition": ["ready"], "press_button": None},
                       "learner_first_name": "Meera"},
            "rows": rows,
            "phase_trace": [{"phase": p, "s_sec": 10.0 * i, "t": 10.0 * i} for i, p in enumerate(phases)],
            "candidate_turns": [],
            "events": [],
            "stop_reason": "time_cap",
            "roleplay_seconds": 1205.0,
            "outcome": "complete",
        }
        return phase_checks(record)["checks"]

    EARLIER_Q = "What first drew you to working in sales?"
    LAST_Q = "How do you keep track of the customers you work with?"

    def _rows(self, act: str, ask: str, reply: str, source: str, *, voice: str = "christy") -> list:
        return [
            _row("bot", "christy", "icebreaker", self.EARLIER_Q, 190.0, source="reply"),
            _row("candidate", "candidate", "icebreaker", "I liked talking to people.", 195.0, act="icebreaker_answer"),
            _row("bot", "christy", "icebreaker", self.LAST_Q, 200.0, source="reply"),
            _row("candidate", "candidate", "icebreaker", "I am ready.", 205.0, act="ready"),
            _row("bot", "christy", "transition", self.BRIEF, 210.0, source="say"),
            _row("candidate", "candidate", "transition", ask, 240.0, act=act),
            _row("bot", voice, "transition", reply, 244.0, source=source),
        ]

    def test_a_long_refusal_is_not_a_repeated_brief(self) -> None:
        checks = self._checks(self._rows("brief_request", "Could you go over the role-play again?", self.REFUSAL, "reply"))
        self.assertFalse(checks["brief_repair"]["ok"])

    def test_the_scripted_brief_line_is_a_repeated_brief(self) -> None:
        again = "Of course, here it is again. " + self.BRIEF
        checks = self._checks(self._rows("brief_request", "Could you go over the role-play again?", again, "say"))
        self.assertTrue(checks["brief_repair"]["ok"], checks["brief_repair"])

    def test_a_short_brief_must_be_a_brief_line_and_shorter(self) -> None:
        short = "Of course, in short: I'll play Meera, and you're the Program Advisor calling her back."
        ok = self._checks(self._rows("short_brief_request", "Four lines, please?", short, "say"))
        self.assertTrue(ok["brief_repair"]["ok"], ok["brief_repair"])
        refused = self._checks(self._rows("short_brief_request", "Four lines, please?", self.REFUSAL, "reply"))
        self.assertFalse(refused["brief_repair"]["ok"])
        whole = self._checks(self._rows("short_brief_request", "Four lines, please?", self.BRIEF, "say"))
        self.assertFalse(whole["brief_repair"]["ok"])

    def test_a_repeat_request_is_not_scored_as_a_brief_and_must_get_the_question_again(self) -> None:
        ask = "Can you go back to the question before last and ask it again?"
        wrong = self._checks(self._rows("repeat_request", ask, "Of course, go ahead. Anything else?", "reply"))
        self.assertIsNone(wrong["brief_repair"]["ok"])
        self.assertFalse(wrong["icebreaker_repeat"]["ok"])
        right = self._checks(self._rows(
            "repeat_request", ask, "Sure. What first drew you to working in sales, would you say?", "reply"
        ))
        self.assertTrue(right["icebreaker_repeat"]["ok"], right["icebreaker_repeat"])

    def test_the_learner_greeting_is_not_a_repeated_brief(self) -> None:
        # BR-3a: the role-play starting (the learner's scripted hello) is no brief repair, even though
        # the line is a ``say`` row that names the learner.
        hello = "Hello, Meera speaking."
        for act, ask in (
            ("brief_request", "Before we start, go over the role-play once more?"),
            ("short_brief_request", "Just the short version, please?"),
        ):
            with self.subTest(act=act):
                checks = self._checks(self._rows(act, ask, hello, "say", voice="learner"))
                self.assertFalse(checks["brief_repair"]["ok"], checks["brief_repair"])

    def test_a_request_for_the_question_before_the_last_needs_that_question(self) -> None:
        # BR-3d: re-asking the last question to "the one before the last" is the wrong question.
        for ask in (
            "Can we jump back to the question before the last one?",
            "Go back to the second-last question, please.",
        ):
            with self.subTest(ask=ask):
                wrong = self._checks(self._rows("repeat_request", ask, "Sure. " + self.LAST_Q, "reply"))
                self.assertFalse(wrong["icebreaker_repeat"]["ok"], wrong["icebreaker_repeat"])
                right = self._checks(self._rows("repeat_request", ask, "Sure. " + self.EARLIER_Q, "reply"))
                self.assertTrue(right["icebreaker_repeat"]["ok"], right["icebreaker_repeat"])

    def test_any_other_repeat_request_needs_the_last_question(self) -> None:
        ask = "Sorry, can you repeat the last question?"
        wrong = self._checks(self._rows("repeat_request", ask, "Sure. " + self.EARLIER_Q, "reply"))
        self.assertFalse(wrong["icebreaker_repeat"]["ok"], wrong["icebreaker_repeat"])
        right = self._checks(self._rows("repeat_request", ask, "Sure. " + self.LAST_Q, "reply"))
        self.assertTrue(right["icebreaker_repeat"]["ok"], right["icebreaker_repeat"])

    def test_an_insisted_repeat_request_keeps_the_question_it_asked_for(self) -> None:
        rows = self._rows("repeat_request", "Go back to the question before last and ask it again.",
                          "Sure. " + self.LAST_Q, "reply")
        rows += [
            _row("candidate", "candidate", "transition", "No, the earlier one. Ask it again.", 250.0,
                 act="repeat_request"),
            _row("bot", "christy", "transition", "Sorry. " + self.EARLIER_Q, 254.0, source="reply"),
        ]
        checks = self._checks(rows)
        self.assertEqual([item["ok"] for item in checks["icebreaker_repeat"]["requests"]], [False, True])

    FIRST_Q = "What does a good first call with a new prospect look like for you?"

    def _insisted_rows(self, second_reply: str) -> list:
        # D2-IB1 (manual-M06): the first request got the question before the last; "no, I mean ..."
        # turns that one down, and Christy offers the one before it ("Sure, the one before that: ...").
        rows = [_row("bot", "christy", "icebreaker", self.FIRST_Q, 185.0, source="reply"),
                _row("candidate", "candidate", "icebreaker", "I open with questions.", 188.0,
                     act="icebreaker_answer")]
        first_ask = "Can you jump back to the question before the last one and ask me it again?"
        rows += self._rows("repeat_request", first_ask, "Of course. " + self.EARLIER_Q, "reply")
        rows += [
            _row("candidate", "candidate", "transition",
                 "No, I mean go back to that earlier one, the question before last, and put it to me again.",
                 250.0, act="repeat_request"),
            _row("bot", "christy", "transition", second_reply, 254.0, source="reply"),
        ]
        return rows

    def test_an_insisted_request_after_the_right_question_passes_with_the_one_before_it(self) -> None:
        checks = self._checks(self._insisted_rows("Sure, the one before that: " + self.FIRST_Q))
        self.assertEqual([item["ok"] for item in checks["icebreaker_repeat"]["requests"]], [True, True])
        self.assertTrue(checks["icebreaker_repeat"]["ok"], checks["icebreaker_repeat"])
        # With no older question kept, the same question again ("That one was: ...") still passes.
        same = self._checks(self._insisted_rows("That one was: " + self.EARLIER_Q))
        self.assertTrue(same["icebreaker_repeat"]["ok"], same["icebreaker_repeat"])
        # Moving forward to the last question is still wrong.
        forward = self._checks(self._insisted_rows("Sure, here it is again: " + self.LAST_Q))
        self.assertFalse(forward["icebreaker_repeat"]["ok"], forward["icebreaker_repeat"])

    def test_an_insisted_request_after_a_wrong_question_gets_no_older_question(self) -> None:
        # The "no" corrects Christy's wrong question: the one before the last is still the target.
        rows = self._insisted_rows("Sure, the one before that: " + self.FIRST_Q)
        rows[-3] = dict(rows[-3], text="Of course. " + self.LAST_Q)
        checks = self._checks(rows)
        self.assertEqual([item["ok"] for item in checks["icebreaker_repeat"]["requests"]], [False, False])

    def test_no_problem_is_no_turned_down_question(self) -> None:
        # Review NEW-REGEX-BREADTH (1): "No problem, ..." / "No worries, ..." turn nothing down, so the
        # older question is no accepted answer to a request for the last one.
        for polite in ("No problem, can you repeat the last question?", "No worries, can you repeat the last question?"):
            with self.subTest(polite=polite):
                rows = self._rows("repeat_request", "Sorry, can you repeat the last question?", "Sure. " + self.LAST_Q, "reply")
                rows += [
                    _row("candidate", "candidate", "transition", polite, 250.0, act="repeat_request"),
                    _row("bot", "christy", "transition", "Sure. " + self.EARLIER_Q, 254.0, source="reply"),
                ]
                requests = self._checks(rows)["icebreaker_repeat"]["requests"]
                self.assertEqual([(item["insisted"], item["ok"]) for item in requests], [(False, True), (False, False)])

    def test_the_checker_and_the_candidate_read_the_question_before_last_alike(self) -> None:
        # Review NEW-REGEX-BREADTH (2): "earlier" as an adverb is the last question; "that earlier
        # question" is the one before it, for both the checker and the replaying candidate.
        from rehearsal.candidate import _EARLIER
        from rehearsal.full_metrics import _SECOND_LAST

        for text, second_last in (
            ("Can you repeat that question? I didn't catch it earlier.", False),
            ("Can we come back to this later?", False),
            ("Please go back and say it again.", False),
            ("Can you repeat that earlier question?", True),
            ("No, return to that earlier question and repeat it.", True),
            ("Can we jump back to the question before the last one?", True),
            ("Go back to the second-last question, please.", True),
        ):
            with self.subTest(text=text):
                self.assertEqual(_EARLIER.search(text) is not None, second_last)
                self.assertEqual(_SECOND_LAST.search(text) is not None, second_last)
        ask = "Can you repeat that earlier question?"
        right = self._checks(self._rows("repeat_request", ask, "Sure. " + self.EARLIER_Q, "reply"))
        self.assertTrue(right["icebreaker_repeat"]["ok"], right["icebreaker_repeat"])

    def test_the_insisted_switch_off_keeps_the_old_target(self) -> None:
        from rehearsal.flags import IB_REPEAT_INSISTED

        with _switch(IB_REPEAT_INSISTED, "0"):
            checks = self._checks(self._insisted_rows("Sure, the one before that: " + self.FIRST_Q))
        self.assertEqual([item["ok"] for item in checks["icebreaker_repeat"]["requests"]], [True, False])

    def test_off_restores_the_word_count_rule(self) -> None:
        from rehearsal.flags import TRANSITION_ACTS_V2

        with _switch(TRANSITION_ACTS_V2, "0"):
            checks = self._checks(self._rows("brief_request", "Could you go over the role-play again?", self.REFUSAL, "reply"))
            self.assertTrue(checks["brief_repair"]["ok"])
            self.assertIsNone(checks["icebreaker_repeat"]["ok"])


class SameTurnFragmentTests(unittest.TestCase):
    """Integration (rambler): a fragment of the same spoken turn that the session saved as its own row
    (no span, written while the turn was still being said) is not the candidate's next turn."""

    QUESTION = "Yes, one thing, and sorry if this is a long one, what does the next round look like here?"
    TAIL = "And you know, the market right now is a bit up and down, so it is all about preparation."

    def _rows(self, tail_at: float) -> list:
        return [
            _row("bot", "christy", "roleplay_exit", "Let's pause the role-play here.", 1000.0, source="say"),
            dict(_row("candidate", "candidate", "wrapup", self.QUESTION, 1004.0, act="wrapup_question",
                      source="candidate"), t_end=1027.0),
            # The session's own row of the ramble's tail: no span, so no source and no end.
            dict(_row("candidate", "candidate", "roleplay_exit", self.TAIL, tail_at), t_end=None, s_sec=None),
            _row("bot", "christy", "wrapup", "Before we finish, do you have any questions?", 1006.0, source="say"),
            _row("bot", "christy", "wrapup", "Your question is noted. Anything else?", 1030.0, source="reply"),
        ]

    def _checks(self, rows):
        return BriefRepairCheckTests._checks(self, rows)

    def test_a_fragment_inside_the_question_does_not_hide_christy_s_reply(self) -> None:
        checks = self._checks(self._rows(1005.5))
        self.assertTrue(checks["wrapup_answered"]["ok"], checks["wrapup_answered"])

    def test_a_candidate_row_after_the_question_ended_is_still_the_next_turn(self) -> None:
        rows = [row for row in self._rows(1028.0) if not str(row["text"]).startswith("Before we finish")]
        checks = self._checks(rows)
        self.assertFalse(checks["wrapup_answered"]["ok"], checks["wrapup_answered"])

    def test_the_switch_off_keeps_the_old_reading(self) -> None:
        from rehearsal.flags import SAME_TURN_FRAGMENTS

        with _switch(SAME_TURN_FRAGMENTS, "0"):
            checks = self._checks(self._rows(1005.5))
        self.assertFalse(checks["wrapup_answered"]["ok"], checks["wrapup_answered"])


class LearnerClockTests(unittest.TestCase):
    """L2: a learner line is timed by the R the engine decided it at (synthetic text)."""

    @staticmethod
    def _exchange(r_sec, learner_r):
        learner = {"spoken": "Let's book a call with my husband so we can decide.",
                   "plan": {"resolves": True, "commitment_level": "MEDIUM", "delivered_commitment": True}}
        if learner_r is not None:
            learner["r_sec"] = learner_r
        return {"n": 1, "r_sec": r_sec, "advisor": {"text": "Shall we book a call?", "intent": "close_ask"},
                "learner": learner}

    def test_a_commitment_decided_after_13_00_is_not_premature(self) -> None:
        from rehearsal import metrics

        admin = {"commitment": {"level": "MEDIUM", "resolved": True}}
        self.assertEqual(metrics.commitment_metrics([self._exchange(775.0, 787.0)], admin)["premature_commit_count"], 0)
        self.assertEqual(metrics.commitment_metrics([self._exchange(775.0, None)], admin)["premature_commit_count"], 1)
        self.assertEqual(metrics.commitment_metrics([self._exchange(700.0, 760.0)], admin)["premature_commit_count"], 1)

    def test_evidence_window_changes_premature_count(self) -> None:
        from rehearsal import metrics

        admin = {"commitment": {"level": "MEDIUM"}, "close_window": {"open_r": 680}}
        self.assertEqual(metrics.commitment_metrics(
            [self._exchange(700, 700)], admin)["premature_commit_count"], 0)
        self.assertEqual(metrics.commitment_metrics(
            [self._exchange(670, 670)], admin)["premature_commit_count"], 1)

    def test_off_times_the_line_by_the_advisor_turn(self) -> None:
        from rehearsal import metrics
        from rehearsal.flags import LEARNER_CLOCK

        admin = {"commitment": {"level": "MEDIUM", "resolved": True}}
        with _switch(LEARNER_CLOCK, "0"):
            self.assertEqual(metrics.commitment_metrics([self._exchange(775.0, 787.0)], admin)["premature_commit_count"], 1)

    def test_every_exchange_records_when_the_learner_line_was_decided(self) -> None:
        records = offline_records()
        seen = 0
        for name, record in records.items():
            for ex in record["exchanges"]:
                decided = ex["learner"].get("r_sec")
                if ex.get("r_sec") is None or ex["learner"].get("spoken") is None:
                    continue  # no learner line (a suppressed turn: nothing was decided)
                with self.subTest(scenario=name, exchange=ex["n"]):
                    self.assertIsNotNone(decided)
                    self.assertGreaterEqual(decided, ex["r_sec"])
                seen += 1
        self.assertGreater(seen, 0)


if __name__ == "__main__":
    unittest.main()


class AsideQuestionTests(unittest.TestCase):
    """M032 integration 9: the Christy lane's second wrap-up offer (L-ASIDE-WRAP-AGAIN,
    R1_WRAP_OFFER_VARIANT) is the same question as L-ASIDE-WRAP, so the simulated candidate reads
    it as the open "wrap" question (synthetic names only)."""

    @staticmethod
    def _render(line_id: str) -> str:
        import r1_script

        class Names(dict):
            def __missing__(self, key: str) -> str:
                return "Asha"

        return r1_script.LINES[line_id].format_map(Names())

    def _runtime(self):
        from types import SimpleNamespace

        return SimpleNamespace(interview=SimpleNamespace(render_line=self._render))

    def test_the_second_wrap_up_offer_is_the_wrap_question(self) -> None:
        from rehearsal.full import aside_question_of

        said = self._render("L-ASIDE-WRAP-AGAIN")
        self.assertEqual(aside_question_of(self._runtime(), said), "wrap")

    def test_the_first_offer_and_the_end_question_keep_their_keys(self) -> None:
        from rehearsal.full import aside_question_of

        rt = self._runtime()
        self.assertEqual(aside_question_of(rt, self._render("L-ASIDE-WRAP")), "wrap")
        self.assertEqual(aside_question_of(rt, self._render("L-ASIDE-END")), "end")
