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

        async def main() -> tuple[dict[str, dict], dict]:
            out = {}
            for spec in specs:
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
        self.assertTrue(second.get("exited") or second["exited_at_once"], second)
        self.assertEqual(self.records["early-end"]["stop_reason"], "end_request")
        self.assertLess(self.records["early-end"]["roleplay_seconds"], 600.0)
        late = _check(self.records["early-end-late"], "end_consent")
        self.assertTrue(late["ok"], late)
        self.assertGreater(self.records["early-end-late"]["roleplay_seconds"], 700.0)
        self.assertLess(self.records["early-end-late"]["roleplay_seconds"], 840.0)
        for name in ("early-end", "early-end-late"):
            self.assertTrue(_check(self.records[name], "roleplay_end")["ok"])

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
        from rehearsal.candidate import _PRICE_ASK, _PRICE_NAMED

        dodges = [t for t in self.records["price-dodge"]["candidate_turns"] if t["act"] == "price_dodge"]
        self.assertTrue(dodges)
        exchanges = self.records["price-never"]["exchanges"]
        for index, exchange in enumerate(exchanges):
            if _PRICE_NAMED.search(exchange["advisor"]["text"]):
                previous = exchanges[index - 1]["learner"]["spoken"] if index else ""
                self.assertRegex(previous or "", _PRICE_ASK)

    def test_manual_replays_follow_their_moves_in_order(self) -> None:
        from rehearsal import manual
        from rehearsal.scenarios import SCENARIOS

        for number in range(1, 11):
            name = f"manual-M{number:02d}"
            record = self.records[name]
            with self.subTest(scenario=name):
                moves = manual.replay_moves(manual.replay_of(SCENARIOS[name]))
                names = {"learner": record["header"]["learner_first_name"], "wrong_name": "Priya"}
                said = [t["text"] for t in record["candidate_turns"] if t["role"] == "advisor"]
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


if __name__ == "__main__":
    unittest.main()
