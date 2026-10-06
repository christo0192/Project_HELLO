"""Gate replays (M013/S01 T01a): two real call timelines and two synthetic shapes.

The harness is ``tests/gate_replay.py``; the fixtures are
``tests/fixtures/gate_replays/``. Every replay drives the production readers on a
virtual clock, so a 45 s gate window runs in milliseconds.

RED MARKERS. Two tests are ``@unittest.expectedFailure`` on purpose: they state
what the gate MUST do on these calls, and origin/main does not do it yet.

* ``TestReplay9f60523dDroppedYes.test_the_first_yes_is_accepted_on_the_first_ask``
  — flipped by T01b (per-segment anchors / the stale-turn barrier).
* ``TestReplay32757295Busy.test_silence_at_consent_after_a_spoken_identity_reply_is_not_machine``
  — flipped by T02 (never "machine" after a person spoke).

The task that makes a marker pass removes its decorator and deletes the matching
``test_origin_main_reproduces_*`` characterisation, which pins today's failure
so the harness is proven to reproduce it rather than assumed to.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import pathlib
import re
import tempfile
import time
import unittest
from unittest.mock import patch

from tests import gate_replay as gr

import agent as agent_mod  # noqa: E402  (stub SDK installed by gate_replay)
import phone  # noqa: E402

_ANSWER_WINDOW_MS = 15_000  # phone.phone_classify_answer_timeout_sec() default


class TestReplayFixturesAreAnonymised(unittest.TestCase):
    """No candidate PII may enter the repo through a replay fixture."""

    EXPECTED = {
        "replay_9f60523d.json",
        "replay_32757295.json",
        "replay_7a84dc44_shape.json",
        "replay_8b7df64a_shape.json",
    }

    def test_the_four_fixtures_exist_and_validate(self):
        names = {p.name for p in gr.fixture_paths()}
        self.assertTrue(self.EXPECTED <= names, names)
        for name in names:
            with self.subTest(name=name):
                fixture = gr.load_fixture(name)
                self.assertIn(fixture.candidate_first_name, gr.SYNTHETIC_FIRST_NAMES)
                self.assertRegex(name, r"^replay_[0-9a-f]{8}(_shape)?\.json$")

    def test_shape_files_are_synthetic_and_real_ones_are_relative_timing_only(self):
        for path in gr.fixture_paths():
            with self.subTest(name=path.name):
                fixture = gr.load_fixture(path.name)
                if path.name.endswith("_shape.json"):
                    self.assertEqual(fixture.provenance, "synthetic_shape")
                else:
                    self.assertEqual(fixture.provenance, "real_timing_anonymised")

    def test_no_absolute_timestamps_ids_or_contact_data_in_the_file(self):
        # Relative milliseconds stay far below a million; an epoch stamp, a
        # phone number or a full id would not.
        for path in gr.fixture_paths():
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            # The 8-hex session prefix may itself be all digits; it is the one
            # identifier a fixture is allowed to carry.
            scanned = raw.replace(data["session_prefix"], "")
            with self.subTest(name=path.name):
                self.assertIsNone(re.search(r"\d{7,}", scanned), "absolute number in fixture")
                self.assertNotIn("@", raw)
                self.assertIsNone(
                    re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", raw), "a full uuid in fixture")
                self.assertEqual(data["time_origin"], "call.answered")

    def _write(self, directory: pathlib.Path, name: str, **overrides) -> None:
        data = json.loads((gr.FIXTURE_DIR / "replay_8b7df64a_shape.json").read_text(encoding="utf-8"))
        data.update(overrides)
        (directory / name).write_text(json.dumps(data), encoding="utf-8")

    def test_the_loader_REJECTS_unsafe_fixtures(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            cases = {
                "real name": ("replay_8b7df64a_shape.json", {"candidate_first_name": "Zxqv"}),
                "absolute ms": ("replay_8b7df64a_shape.json", {"committed_turns": [
                    {"t_ms": 1.5, "text": "Yes", "started_speaking_at_ms": 1, "created_at_ms": 1}]}),
                "digit run": ("replay_8b7df64a_shape.json", {"stt_finals": [
                    {"t_ms": 10, "text": "call me on 98450 12345"}]}),
                "provenance": ("replay_8b7df64a_shape.json", {"provenance": "real_timing_anonymised"}),
                "unknown key": ("replay_8b7df64a_shape.json", {"candidate_surname": "x"}),
            }
            for label, (name, overrides) in cases.items():
                with self.subTest(label):
                    self._write(directory, name, **overrides)
                    with self.assertRaises(gr.ReplayError):
                        gr.load_fixture(name, directory=directory)
            # A person's name in the FILE NAME is refused before it is read.
            self._write(directory, "replay_someone.json")
            with self.assertRaises(gr.ReplayError):
                gr.load_fixture("replay_someone.json", directory=directory)

    def test_no_replay_logs_candidate_words(self):
        for path in gr.fixture_paths():
            with self.subTest(name=path.name):
                result = gr.replay(path.name)
                self.assertEqual(result.leaked_text_in_logs(), [])

    def test_the_identity_model_sees_the_synthetic_first_name_only(self):
        result = gr.replay("32757295")
        self.assertEqual(len(result.identity_prompts), 1)
        prompt = result.identity_prompts[0]
        self.assertIn("Ravi", prompt)
        self.assertIn("Hello", prompt)


class TestReplayGlueMatchesOriginMain(unittest.TestCase):
    """`OriginMainGlue` mirrors closure code in `_run_phone_session`; pin it.

    If one of these fails, agent.py's gate glue changed: carry the change into
    `tests/gate_replay.py` (or move the glue to a module-level seam the harness
    can call), or every replay silently tests yesterday's producer.
    """

    @classmethod
    def setUpClass(cls):
        cls.src = inspect.getsource(agent_mod._run_phone_session)

    def test_the_producer_enqueues_text_with_the_sdk_speech_start(self):
        self.assertIn("user_turns.put_nowait((text, _turn_anchor_ms(message)))", self.src)

    def test_the_question_anchor_is_stamped_then_raised_one_way_to_first_audio(self):
        mark = self.src[self.src.index("def _mark_question_asked()"):]
        self.assertIn("gate_question_anchor[0] = int(round(time.time() * 1000))", mark[:1500])
        speaking = self.src[self.src.index("def _on_phone_agent_state_changed"):]
        self.assertIn("_first_audio_ms = int(round(first_audio_wall * 1000))", speaking[:2600])
        self.assertIn("if _first_audio_ms > gate_question_anchor[0]:", speaking[:2600])

    def test_the_readers_are_wired_as_the_replay_drives_them(self):
        self.assertIn("question_anchor=lambda: gate_question_anchor[0],", self.src)
        identity = self.src[self.src.index("async def _next_candidate_turn()"):]
        block = identity[:2200]
        self.assertIn("phone.phone_identity_answer_timeout_sec(),", block)
        self.assertIn('speaking=lambda: bool(candidate_speaking.get("value")),', block)
        self.assertIn("hard_timeout_sec=phone.phone_classify_answer_timeout_sec(),", block)

    def test_the_speaking_latch_follows_the_vad_stream(self):
        vad = self.src[self.src.index("def _on_phone_vad_event"):]
        self.assertIn('candidate_speaking["value"] = True', vad[:600])

    def test_gate_lines_are_non_interruptible_which_the_drop_model_assumes(self):
        self.assertIn("session.say(text, allow_interruptions=False)", self.src)


class TestHarnessDrivesTheRealCode(unittest.TestCase):
    """The replay must exercise production functions, not copies of them."""

    def test_a_45_second_gate_replays_in_well_under_a_second(self):
        gr.replay("9f60523d")  # warm
        started = time.monotonic()
        result = gr.replay("9f60523d")
        self.assertGreater(result.decision_at_ms, 44_000)
        self.assertLess(time.monotonic() - started, 2.0)

    def test_MUTATION_the_real_staleness_rule_is_in_the_path(self):
        # Neutralise the production barrier: the dropped yes is then read.
        with patch.object(agent_mod, "_queued_turn_is_stale", lambda *_a: False):
            result = gr.replay("9f60523d")
        self.assertEqual(result.consumed, ["Yes, we can continue."])
        self.assertNotIn("reask", result.spoken_kinds())

    def test_MUTATION_the_real_anchor_source_is_in_the_path(self):
        # An untimed turn is KEPT by the fail-open barrier, so replacing the
        # production anchor source changes the outcome: the yes is read.
        with patch.object(agent_mod, "_turn_anchor_ms", lambda _m: None):
            result = gr.replay("9f60523d")
        self.assertEqual(result.consumed, ["Yes, we can continue."])

    def test_MUTATION_the_real_classifier_is_in_the_path(self):
        with patch.object(agent_mod, "classify_answer_text", lambda _t: phone.CLASSIFY_REFUSED):
            result = gr.replay("32757295")
        self.assertEqual(result.decision, phone.CLASSIFY_REFUSED)

    def test_an_EXHAUSTED_recording_fails_loudly_not_open(self):
        # The identity classifier fails open on a model error; the harness must
        # not let that turn a missing recording into a quiet "unclear".
        fixture = dataclasses.replace(gr.load_fixture("32757295"), judge_responses={})
        with self.assertRaises(gr.ReplayError):
            gr.replay(fixture)

    def test_an_UNBOUNDED_wait_is_reported_as_a_deadlock(self):
        async def _hang(rt):
            await asyncio.Event().wait()

        with self.assertRaises(gr.ReplayError):
            gr.replay("8b7df64a_shape", driver=_hang)

    def test_a_turn_committed_during_a_gate_line_is_dropped_like_the_sdk_does(self):
        # SDK agent_activity.py:2186-2192. The reschedule request commits while
        # the role line plays, so it never reaches `on_candidate_turn`.
        async def _consent_then_role(rt):
            rt.glue.mark_question_asked()
            await rt.say(phone.PHONE_DISCLOSURE_TEXT, kind="consent")
            await rt.say("role line", kind="role")
            await rt.wait_until(23_000)
            return rt.result

        result = gr.replay("7a84dc44_shape", driver=_consent_then_role)
        self.assertEqual(result.dropped_commits, ["Can we reschedule this, I'm out somewhere."])
        self.assertEqual([t for t, _ in result.enqueued], ["Okay."])

    def test_the_fixture_segments_use_the_sdk_formula(self):
        segments = gr.load_fixture("9f60523d").segments()
        self.assertEqual((segments[0].start_ms, segments[0].end_ms), (1974, 2174))
        self.assertEqual(
            [(s.start_ms, s.end_ms) for s in segments[2:4]],
            [(22378, 23333), (23700, 24732)],
        )


class TestReplay9f60523dDroppedYes(unittest.TestCase):
    """The first "Yes, we can continue." is dropped and the candidate re-asked."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = gr.load_fixture("9f60523d")
        cls.result = gr.replay(cls.fixture)
        cls.consent = cls.fixture.lines_of("consent")[0]
        cls.first_yes_commit_ms = cls.fixture.committed_turns[0].t_ms

    def test_origin_main_reproduces_the_drop(self):
        """Today's failure, step by step. T01b deletes this when it flips the marker."""
        r = self.result
        # Identity: her reply produced no final, so the reader timed out empty.
        self.assertEqual(r.identity_reply, "")
        self.assertEqual(r.identity_verdict, phone.PHONE_IDENTITY_UNCLEAR)
        # The yes was enqueued with the blip's carried-over speech start, which
        # predates the consent line's first audio...
        first_text, first_anchor = r.enqueued[0]
        self.assertEqual(first_text, "Yes, we can continue.")
        self.assertLess(first_anchor, self.consent.first_audio_ms)
        # ...so the consent reader skipped it SILENTLY (no barrier log)...
        self.assertEqual(r.logs_of("phone_gate_turn_barrier"), [])
        # ...and re-asked with "no_speech" when its window ran out.
        reasks = r.logs_of("phone_consent_reask", "no_speech")
        self.assertEqual(len(reasks), 1)
        self.assertAlmostEqual(
            reasks[0].t_ms, self.consent.playout_end_ms + _ANSWER_WINDOW_MS, delta=5)
        self.assertEqual(r.spoken_kinds(), ["identity", "consent", "reask"])
        # The second yes was accepted, 19 s after the first was spoken.
        self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(r.consumed, ["Yes. Yes."])
        self.assertGreater(r.decision_at_ms - self.first_yes_commit_ms, 18_000)

    def test_the_replay_matches_what_production_logged(self):
        observed = {e["what"].split(" ")[0]: e["t_ms"]
                    for e in self.fixture.raw["observed_production"]["events"]}
        reask = self.result.logs_of("phone_consent_reask")[0]
        self.assertAlmostEqual(reask.t_ms, observed["phone_consent_reask/no_speech"], delta=5)
        self.assertAlmostEqual(
            self.result.decision_at_ms, observed["classify.human"], delta=150)

    @unittest.expectedFailure
    def test_the_first_yes_is_accepted_on_the_first_ask(self):
        """RED until T01b. The S01-PLAN T01b acceptance for this call."""
        r = self.result
        self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(r.consumed, ["Yes, we can continue."])
        self.assertNotIn("reask", r.spoken_kinds())
        self.assertEqual(r.logs_of("phone_consent_reask"), [])
        # Decided when the turn closed (legacy path), not after a timeout.
        self.assertLessEqual(r.decision_at_ms, self.first_yes_commit_ms + 100)


class TestReplay32757295Busy(unittest.TestCase):
    """Busy at consent. Production 7bf036f re-asked, then hung up as "machine".

    ON ORIGIN/MAIN THE REAL WORDS NO LONGER REACH "machine". #334 routes
    "I am busy right now" to `callback_requested` before the ambiguous re-ask,
    so the replayed consent turn ends in the pre-consent callback flow. The
    `responsive_unmatched -> classify.machine` exit S01-PLAN T01a names is the
    7bf behaviour; on main the machine exits after a person spoke are the
    fallthroughs, and the silent-consent variant below reproduces one of them.
    """

    @classmethod
    def setUpClass(cls):
        cls.fixture = gr.load_fixture("32757295")
        cls.result = gr.replay(cls.fixture)
        cls.consent = cls.fixture.lines_of("consent")[0]
        cls.silent = gr.replay(cls.fixture.candidate_silent_after(cls.consent.ask_ms))

    def test_origin_main_routes_the_busy_reply_to_the_callback_flow(self):
        r = self.result
        self.assertEqual(r.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertEqual(r.consumed, ["I am busy right now"])
        self.assertNotIn("reask", r.spoken_kinds())
        self.assertEqual(r.logs_of("phone_classify_fallback_machine"), [])
        busy_commit = self.fixture.committed_turns[2]
        self.assertEqual(r.decision_at_ms, busy_commit.t_ms)

    def test_the_identity_turn_reads_hello_and_uses_the_recorded_verdict(self):
        r = self.result
        self.assertEqual(r.identity_reply, "Hello")
        self.assertEqual(r.identity_verdict, phone.PHONE_IDENTITY_UNCLEAR)
        observed = {e["what"].split(" ")[0]: e["t_ms"]
                    for e in self.fixture.raw["observed_production"]["events"]}
        self.assertAlmostEqual(
            r.identity_decided_at_ms, observed["phone_identity_verdict/unclear"], delta=5)
        skips = r.logs_of("phone_gate_turn_barrier", "pre_question_turn_skipped")
        self.assertEqual(len(skips), 1)
        self.assertAlmostEqual(
            skips[0].t_ms, observed["phone_gate_turn_barrier/pre_question_turn_skipped"], delta=5)

    def test_the_okay_skip_is_a_CORRECT_pre_question_skip(self):
        """Critique C7 resolved from the log: "Okay" is the pickup, not a reply.

        Only two STT finals exist in the identity window. "Okay" arrived DURING
        the identity line, and the only VAD segment closed before it is the
        pickup sound, which began before the question was audible. Its commit
        was merely held until after the line. FIFO pairing (T01b) therefore
        tags it pre_question; the post-question reply is "Hello".
        """
        identity = self.fixture.lines_of("identity")[0]
        okay = next(f for f in self.fixture.stt_finals if f.text == "Okay")
        self.assertGreater(okay.t_ms, identity.first_audio_ms)
        self.assertLess(okay.t_ms, identity.playout_end_ms)
        closed_before = [s for s in self.fixture.segments()
                         if s.end_ms is not None and s.end_ms <= okay.t_ms]
        self.assertEqual(len(closed_before), 1)
        self.assertLess(closed_before[0].start_ms, identity.first_audio_ms)
        verdict_at = self.result.identity_decided_at_ms
        finals_before_verdict = [f.t_ms for f in self.fixture.stt_finals if f.t_ms < verdict_at]
        self.assertEqual(len(finals_before_verdict), 2)

    def test_origin_main_reproduces_machine_after_a_spoken_identity_reply(self):
        """Today's failure. T02 deletes this when it flips the marker below."""
        r = self.silent
        self.assertEqual(r.identity_reply, "Hello")
        self.assertEqual(r.decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(len(r.logs_of("phone_classify_fallback_machine", "no_speech")), 1)
        self.assertEqual(r.spoken_kinds(), ["identity", "consent", "reask"])

    @unittest.expectedFailure
    def test_silence_at_consent_after_a_spoken_identity_reply_is_not_machine(self):
        """RED until T02. A person answered the identity question: never voicemail."""
        r = self.silent
        self.assertNotEqual(r.decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(r.logs_of("phone_classify_fallback_machine"), [])


class TestShapeReplays(unittest.TestCase):
    """The two synthetic shapes, as origin/main handles them today."""

    def test_7a84dc44_grants_on_okay_before_the_reschedule_request_starts(self):
        fixture = gr.load_fixture("7a84dc44_shape")
        result = gr.replay(fixture)
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(result.consumed, ["Okay."])
        reschedule = fixture.segments()[1]
        # The second utterance begins only after consent was decided: no
        # decision-time window can see it, so it is a revocation case (T07).
        self.assertGreater(reschedule.start_ms, result.decision_at_ms)

    def test_7a84dc44_can_be_shifted_into_the_verdict_window(self):
        # T05's variant: the reschedule request starts 240 ms after "Okay."
        # commits, i.e. while a ~1 s judge verdict would still be in flight.
        fixture = gr.load_fixture("7a84dc44_shape")
        okay_commit = fixture.committed_turns[0].t_ms
        second = fixture.segments()[1]
        moved = fixture.candidate_shifted(
            second.start_ms, (okay_commit + 240) - second.start_ms)
        self.assertEqual(moved.segments()[1].start_ms, okay_commit + 240)
        self.assertEqual(moved.segments()[0], fixture.segments()[0])
        self.assertEqual(moved.committed_turns[0], fixture.committed_turns[0])
        self.assertEqual(moved.committed_turns[1].started_speaking_at_ms, okay_commit + 240)

    def test_8b7df64a_is_a_legacy_false_grant(self):
        """origin/main grants on the leading "yes" (an offline-bank false grant).

        T05 (llm mode) must refuse it. The legacy regex is allowed to keep it as
        the judge-unavailable fallback (owner decision 1), so this pins today's
        legacy behaviour rather than marking it red.
        """
        result = gr.replay("8b7df64a_shape")
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)


if __name__ == "__main__":
    unittest.main()
