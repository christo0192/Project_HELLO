"""Gate replays (M013/S01 T01a): two real call timelines and two synthetic shapes.

The harness is ``tests/gate_replay.py``; the fixtures are
``tests/fixtures/gate_replays/``. Every replay drives the production readers on a
virtual clock, so a 45 s gate window runs in milliseconds.

RED MARKERS. ``@unittest.expectedFailure`` marks a test that states what the
gate MUST do on a call and that the code does not do yet.

* ``TestReplay9f60523dDroppedYes.test_the_first_yes_is_accepted_on_the_first_ask``
  — FLIPPED by T01b (per-final capture, FIFO segment pairing). Its origin/main
  characterisation is replaced by ``test_without_vad_timing_the_gate_falls_back_to_origin_main``,
  which still reproduces production to the millisecond: with no VAD timing
  the gate falls back to the SDK's speech start, i.e. origin/main.
* ``TestReplay32757295Busy.test_silence_at_consent_after_a_spoken_identity_reply_is_not_machine``
  — FLIPPED by T02 (never "machine" after a person spoke). Its origin/main
  characterisation (identity "Hello", silent consent, re-ask, MACHINE) is
  deleted; the flipped test asserts the deferral that replaced it.

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
import gate_judge  # noqa: E402
import phone  # noqa: E402

_ANSWER_WINDOW_MS = 15_000  # phone.phone_classify_answer_timeout_sec() default
_EPOCH_MS = int(round(gr.REPLAY_EPOCH_S * 1000))


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


class TestReplayGlueMatchesAgent(unittest.TestCase):
    """`SessionGlue` mirrors closure code in `_run_phone_session`; pin it.

    If one of these fails, agent.py's gate glue changed: carry the change into
    `tests/gate_replay.py` (or move the glue to a module-level seam the harness
    can call), or every replay silently tests yesterday's producer.
    """

    @classmethod
    def setUpClass(cls):
        cls.src = inspect.getsource(agent_mod._run_phone_session)

    def test_the_producer_is_the_gate_capture_built_by_the_module_seam(self):
        self.assertIn("gate_capture = _new_gate_turn_capture(_emit_gate_turn)", self.src)
        emit = self.src[self.src.index("def _emit_gate_turn("):]
        self.assertIn("user_turns.put_nowait(turn)", emit[:700])
        self.assertIn('turn.closed_by == "settle"', emit[:700])
        # The commit no longer enqueues directly with the SDK speech start.
        self.assertNotIn("user_turns.put_nowait((text, _turn_anchor_ms(message)))", self.src)
        self.assertIn("gate_capture.on_commit(text, _turn_anchor_ms(message))", self.src)

    def test_vad_events_and_stt_finals_reach_the_capture(self):
        vad = self.src[self.src.index("def _on_phone_vad_event"):]
        self.assertIn("gate_capture.on_vad_event(event, time.time())", vad[:700])
        transcript = self.src[self.src.index("def _on_phone_transcript_activity"):]
        self.assertIn("gate_capture.on_final(", transcript[:1400])
        self.assertIn('bool(getattr(event, "is_final", False))', transcript[:1400])

    def test_the_user_state_anchor_uses_the_module_seam(self):
        self.assertIn(
            "latest_candidate_anchor[0] = _user_state_anchor_ms(event, time.time())",
            self.src)

    def test_the_grant_evidence_and_transcript_rows_use_the_module_seams(self):
        self.assertIn("on_grant_evidence=_record_gate_grant_evidence,", self.src)
        record = self.src[self.src.index("def _record_gate_grant_evidence("):]
        self.assertIn(
            "_gate_evidence_row(item, gate_evidence_keys, gate_capture)", record[:600])
        item = self.src[self.src.index("def _on_phone_item("):]
        self.assertIn("if not _gate_user_row_is_evidence_echo(", item[:4000])
        self.assertIn("text, gate_capture, gate_evidence_keys):", item[:4000])

    def test_the_capture_stops_with_the_gate(self):
        clear = self.src[self.src.index("def _clear_question_anchor()"):]
        self.assertIn("gate_capture.stop()", clear[:500])

    def test_the_question_anchor_is_stamped_then_raised_one_way_to_first_audio(self):
        mark = self.src[self.src.index("def _mark_question_asked()"):]
        self.assertIn("gate_question_anchor[0] = int(round(time.time() * 1000))", mark[:2000])
        self.assertIn("_clear_sdk_user_turn()", mark[:2200])
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
        # T02: one "a person spoke" latch per call, shared by every reader.
        self.assertIn("gate_spoke = gate_judge.HumanSpeechLatch()", self.src)
        # T05: in llm mode the identity judge latches instead of the reader.
        self.assertIn("spoke=None if gate_judge_wiring.acting else gate_spoke,", block)
        classify = self.src[self.src.index("async def classify() -> str:"):]
        self.assertIn("spoke=gate_spoke,", classify[:700])
        # T05: the consent reader is handed the call's judge wiring.
        self.assertIn("judge=gate_judge_wiring,", classify[:900])
        self.assertIn("bot_line=lambda: gate_last_line[0],", classify[:900])

    def test_the_judge_wiring_and_recording_anchor_use_the_module_seams(self):
        # T05: built from the call's own capture, latch, anchors and budget.
        wiring = self.src[self.src.index("gate_judge_wiring = _GateJudgeWiring("):]
        for line in (
            "capture=gate_capture, latch=gate_spoke,",
            "question_anchor=lambda: gate_question_anchor[0],",
            "recording_anchor=lambda: gate_recording_anchor.value,",
            "budget=gate_budget,",
        ):
            self.assertIn(line, wiring[:600])
        self.assertIn("gate_recording_anchor = _GateRecordingAnchor()", self.src)
        mark = self.src[self.src.index("def _mark_question_asked()"):]
        self.assertIn("gate_recording_anchor.reset()", mark[:2200])
        record = self.src[self.src.index("def _mark_recording_sentence()"):]
        self.assertIn(
            "gate_recording_anchor.mark(int(round(time.time() * 1000)))", record[:300])
        speaking = self.src[self.src.index("def _on_phone_agent_state_changed"):]
        self.assertIn(
            "gate_recording_anchor.on_first_audio(int(round(first_audio_wall * 1000)))",
            speaking[:3000])
        clear = self.src[self.src.index("def _clear_question_anchor()"):]
        self.assertIn("gate_judge_wiring.stop()", clear[:500])
        say = self.src[self.src.index("    async def say(text: str) -> None:"):]
        self.assertIn("gate_last_line[0] = text", say[:400])
        gate = self.src[self.src.index("return await phone.run_phone_gate("):]
        self.assertIn("judge_identity=_judge_identity,", gate)
        self.assertIn("mark_recording_sentence=_mark_recording_sentence,", gate)

    def test_the_speaking_latch_follows_the_vad_stream(self):
        vad = self.src[self.src.index("def _on_phone_vad_event"):]
        self.assertIn('candidate_speaking["value"] = True', vad[:600])

    def test_gate_lines_are_non_interruptible_which_the_drop_model_assumes(self):
        self.assertIn("session.say(text, allow_interruptions=False)", self.src)


class TestHarnessDrivesTheRealCode(unittest.TestCase):
    """The replay must exercise production functions, not copies of them."""

    def test_a_45_second_gate_replays_in_well_under_a_second(self):
        fixture = gr.load_fixture("32757295")
        silent = fixture.candidate_silent_after(fixture.lines_of("consent")[0].ask_ms)
        gr.replay(silent)  # warm
        started = time.monotonic()
        result = gr.replay(silent)
        self.assertGreater(result.decision_at_ms, 44_000)
        self.assertLess(time.monotonic() - started, 2.0)

    def test_MUTATION_the_real_staleness_rule_is_in_the_path(self):
        # Neutralise the production barrier: the pickup "Okay" (which began
        # before the identity line was heard) is then read as the identity
        # answer instead of "Hello".
        with patch.object(agent_mod, "_queued_turn_is_stale", lambda *_a: False):
            result = gr.replay("32757295")
        self.assertEqual(result.identity_reply, "Okay")
        self.assertEqual(gr.replay("32757295").identity_reply, "Hello")

    def test_MUTATION_the_real_fifo_pairing_window_is_in_the_path(self):
        # With no expiry, the identity-line blip and the identity reply (both
        # finals that never came) are still unpaired when the consent "yes"
        # arrives, so they lend it a start before the consent question: the
        # 9f60523d drop, back again.
        with patch.object(gate_judge, "GATE_STT_PAIRING_WINDOW_MS", 10 ** 9):
            result = gr.replay("9f60523d")
        self.assertEqual(result.enqueued[0], ("Yes, we can continue.", 1974))
        self.assertIn("reask", result.spoken_kinds())
        self.assertEqual(result.consumed, ["Yes. Yes."])

    def test_the_sdk_speech_start_is_ignored_when_vad_timing_exists(self):
        # The carried-over SDK stamp (1974) is what dropped the yes. With VAD
        # timing the gate never reads it, so even a garbage SDK anchor changes
        # nothing.
        with patch.object(agent_mod, "_turn_anchor_ms", lambda _m: 1):
            result = gr.replay("9f60523d")
        self.assertEqual(result.consumed, ["Yes, we can continue."])
        self.assertNotIn("reask", result.spoken_kinds())

    def test_MUTATION_the_real_classifier_is_in_the_path(self):
        with patch.object(agent_mod, "classify_answer_text",
                          lambda _t, **_kw: phone.CLASSIFY_REFUSED):
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
        # T01b: the dropped turn is NOT lost. Its STT final was captured and the
        # turn was closed by silence (never committed), after the commit the
        # SDK kept.
        self.assertEqual(
            [(t.text, t.closed_by, t.committed) for t in result.gate_turns],
            [("Okay.", "commit", True),
             ("Can we reschedule this, I'm out somewhere.", "settle", False)])

    def test_the_fixture_segments_use_the_sdk_formula(self):
        segments = gr.load_fixture("9f60523d").segments()
        self.assertEqual((segments[0].start_ms, segments[0].end_ms), (1974, 2174))
        self.assertEqual(
            [(s.start_ms, s.end_ms) for s in segments[2:4]],
            [(22378, 23333), (23700, 24732)],
        )


class TestReplay9f60523dDroppedYes(unittest.TestCase):
    """The first "Yes, we can continue." was dropped and the candidate re-asked.

    Flipped by T01b: the gate now times the reply by its own VAD speech (two
    segments starting 22378, FIFO-paired with the 25618 final), not by the
    SDK's speech start carried over from a blip during the identity line.
    """

    @classmethod
    def setUpClass(cls):
        cls.fixture = gr.load_fixture("9f60523d")
        cls.result = gr.replay(cls.fixture)
        cls.consent = cls.fixture.lines_of("consent")[0]
        cls.first_yes_commit_ms = cls.fixture.committed_turns[0].t_ms
        # The same call, as a gate with no VAD timing sees it: origin/main.
        cls.no_vad = gr.replay(dataclasses.replace(cls.fixture, vad_events=()))

    def test_the_first_yes_is_accepted_on_the_first_ask(self):
        """The S01-PLAN T01b acceptance for this call (was RED on origin/main)."""
        r = self.result
        self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(r.consumed, ["Yes, we can continue."])
        self.assertNotIn("reask", r.spoken_kinds())
        self.assertEqual(r.logs_of("phone_consent_reask"), [])
        self.assertEqual(r.logs_of("phone_classify_fallback_machine"), [])
        # Decided when the turn closed (legacy path), not after a timeout.
        self.assertLessEqual(r.decision_at_ms, self.first_yes_commit_ms + 100)

    def test_the_yes_is_timed_by_its_own_speech_after_the_consent_question(self):
        turn = self.result.gate_turns[0]
        self.assertEqual(turn.text, "Yes, we can continue.")
        self.assertEqual(turn.anchor_ms - _EPOCH_MS, 22378)
        self.assertEqual(turn.segment_start_ms, turn.anchor_ms)
        self.assertEqual(
            turn.tag_for(_EPOCH_MS + self.consent.first_audio_ms),
            gate_judge.TAG_POST_QUESTION)
        # Two VAD segments, one final.
        self.assertEqual(turn.segment_speech_ms, 955 + 1032)
        self.assertEqual(turn.closed_by, "commit")

    def test_exactly_one_candidate_row_holds_the_grant(self):
        rows = self.result.candidate_rows()
        self.assertEqual([row[1] for row in rows], ["Yes, we can continue."])

    def test_without_vad_timing_the_gate_falls_back_to_origin_main(self):
        """Production (7bf036f), reproduced: proof the harness reproduces it.

        With no VAD event on the call the gate falls back to the SDK's speech
        start for a committed turn, which is the origin/main producer. The
        replay then matches what production logged.
        """
        r = self.no_vad
        observed = {e["what"].split(" ")[0]: e["t_ms"]
                    for e in self.fixture.raw["observed_production"]["events"]}
        # Identity: her reply produced no final, so the reader timed out empty.
        self.assertEqual(r.identity_reply, "")
        self.assertEqual(r.identity_verdict, phone.PHONE_IDENTITY_UNCLEAR)
        # The yes carries the blip's speech start, before the consent line...
        first_text, first_anchor = r.enqueued[0]
        self.assertEqual(first_text, "Yes, we can continue.")
        self.assertLess(first_anchor, self.consent.first_audio_ms)
        # ...so it is skipped (now LOGGED, with its tag)...
        skips = r.logs_of("phone_gate_turn_barrier", "consent_turn_skipped")
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0].fields["phase"], gate_judge.TAG_PRE_QUESTION)
        # ...and re-asked with "no_speech" exactly when production did.
        reasks = r.logs_of("phone_consent_reask", "no_speech")
        self.assertEqual(len(reasks), 1)
        self.assertAlmostEqual(reasks[0].t_ms, observed["phone_consent_reask/no_speech"], delta=5)
        self.assertEqual(r.spoken_kinds(), ["identity", "consent", "reask"])
        self.assertEqual(r.consumed, ["Yes. Yes."])
        self.assertAlmostEqual(r.decision_at_ms, observed["classify.human"], delta=150)


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
        # T01b: the pickup "Okay" is now closed by silence while the identity
        # line plays (its commit was held until 9480), so the reader skips it
        # the moment it starts reading at playout end, not at the commit.
        identity = self.fixture.lines_of("identity")[0]
        self.assertEqual(skips[0].t_ms, identity.playout_end_ms)
        self.assertLess(skips[0].t_ms, observed["phone_gate_turn_barrier/pre_question_turn_skipped"])
        self.assertEqual(skips[0].fields["phase"], gate_judge.TAG_PRE_QUESTION)
        # The SDK's later commit of the same words is not read a second time.
        self.assertEqual(len(r.logs_of("phone_gate_turn_barrier", "commit_duplicate")), 1)
        self.assertEqual([t.text for t in r.gate_turns][:2], ["Okay", "Hello"])

    def test_c7_okay_is_pre_question_and_hello_is_the_post_question_reply(self):
        """T01b acceptance (C7), as corrected by T01a: nothing is skipped silently."""
        r = self.result
        identity = self.fixture.lines_of("identity")[0]
        anchor = _EPOCH_MS + identity.first_audio_ms
        okay, hello = r.gate_turns[0], r.gate_turns[1]
        self.assertEqual(okay.tag_for(anchor), gate_judge.TAG_PRE_QUESTION)
        self.assertEqual(okay.anchor_ms - _EPOCH_MS, 740)
        self.assertEqual(hello.tag_for(anchor), gate_judge.TAG_POST_QUESTION)
        self.assertEqual(hello.anchor_ms - _EPOCH_MS, 7730)
        # Every skip is logged, with its tag and deltas but no words.
        for log in r.logs_of("phone_gate_turn_barrier"):
            self.assertNotIn("Okay", str(log.fields))

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

    def test_silence_at_consent_after_a_spoken_identity_reply_is_not_machine(self):
        """FLIPPED by T02. A person answered the identity question: never voicemail.

        origin/main read "Hello" at identity, heard nothing at consent, re-asked
        "I just need a yes or a no", heard nothing again and ended the call as
        MACHINE in silence. Now the identity reply latches "a person spoke",
        the re-ask is worded for silence, and the reader returns the deferral
        (the gate then speaks the goodbye and posts
        `candidate.deferred_pre_disclosure`; see test_phone_gate_no_machine).
        """
        r = self.silent
        self.assertEqual(r.identity_reply, "Hello")
        self.assertTrue(r.glue.spoke.spoke)
        self.assertEqual(r.glue.spoke.source, gate_judge.SPOKE_SOURCE_IDENTITY)
        self.assertNotEqual(r.decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(r.decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(r.logs_of("phone_classify_fallback_machine"), [])
        deferrals = r.logs_of("phone_classify_fallback_deferral", "no_speech_after_spoke")
        self.assertEqual(len(deferrals), 1)
        self.assertEqual(deferrals[0].fields["phase"], gate_judge.SPOKE_SOURCE_IDENTITY)
        self.assertEqual(r.spoken_kinds(), ["identity", "consent", "reask"])
        self.assertEqual(r.spoken[-1].text, phone.PHONE_CONSENT_REASK_SILENCE_TEXT)

    def test_the_busy_reply_is_never_a_reask_and_never_machine(self):
        """T02 acceptance (legacy mode): busy goes to the callback flow."""
        r = self.result
        self.assertEqual(r.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertNotIn("reask", r.spoken_kinds())
        self.assertEqual(r.logs_of("phone_classify_fallback_machine"), [])
        self.assertEqual(r.logs_of("phone_consent_reask"), [])


def _vad(start_ms: int, end_ms: int) -> tuple:
    """SDK-shaped start/end events for one VAD segment [start_ms, end_ms]."""
    return (
        gr.VadEvent(t_ms=start_ms + 60, type="start_of_speech", speech_duration_ms=50,
                    silence_duration_ms=0, inference_duration_ms=10),
        gr.VadEvent(t_ms=end_ms + 256, type="end_of_speech",
                    speech_duration_ms=end_ms - start_ms, silence_duration_ms=256,
                    inference_duration_ms=0),
    )


def _synthetic(name: str, *, consent: tuple[int, int, int], segments=(), finals=(),
               commits=()) -> gr.GateReplayFixture:
    """An in-memory synthetic shape (consent line only), never written to disk."""
    return gr.GateReplayFixture(
        name=name, session_prefix="00000000", provenance="synthetic_shape",
        candidate_first_name="Kiran",
        bot_lines=(gr.BotLine("consent", *consent),),
        vad_events=tuple(ev for seg in segments for ev in _vad(*seg)),
        stt_finals=tuple(gr.SttFinal(t, text) for t, text in finals),
        committed_turns=tuple(
            gr.CommittedTurn(t, text, started, t) for t, text, started in commits),
        judge_responses={}, raw={},
    )


def _then_wait(until_ms: int):
    async def _driver(rt):
        await gr.drive_identity_then_consent(rt)
        await rt.wait_until(until_ms)
        return rt.result
    return _driver


class TestT01bAcceptanceReplays(unittest.TestCase):
    """S01-PLAN T01b acceptance cases, as synthetic shapes on the real readers.

    The consent question is heard at 4000 (first audio) in every shape.
    """

    CONSENT_HEARD = 4000

    def test_a_late_identity_final_is_pre_question_and_never_grants(self):
        # The identity "Yes" was spoken 2000-2600, before the consent line was
        # heard; its STT final only lands at 4500, during the consent line (so
        # its commit is dropped too).
        fixture = _synthetic(
            "late_identity_final", consent=(3000, 4000, 9000),
            segments=[(2000, 2600)], finals=[(4500, "Yes")],
            commits=[(4600, "Yes", 2000)])
        r = gr.replay(fixture)
        turn = r.gate_turns[0]
        self.assertEqual(turn.anchor_ms - _EPOCH_MS, 2000)
        self.assertEqual(turn.tag_for(_EPOCH_MS + self.CONSENT_HEARD), gate_judge.TAG_PRE_QUESTION)
        skips = r.logs_of("phone_gate_turn_barrier", "consent_turn_skipped")
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0].fields["phase"], gate_judge.TAG_PRE_QUESTION)
        self.assertNotEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(r.consumed, [])
        self.assertEqual(r.candidate_rows(), [])

    def test_PAIRING_ATTACK_a_post_question_noise_segment_cannot_lend_its_start(self):
        # Critique §3.1: identity "Yes" 2000-2600 (before the consent question);
        # a noise segment with no final starts AFTER the question (4200); the
        # identity final then arrives late (4700). "Latest segment start before
        # the final" would stamp the yes 4200 and make it consent. FIFO pairs
        # it with the oldest segment, so it stays pre-question.
        fixture = _synthetic(
            "pairing_attack", consent=(3000, 4000, 9000),
            segments=[(2000, 2600), (4200, 4400)], finals=[(4700, "Yes")])
        r = gr.replay(fixture)
        turn = r.gate_turns[0]
        self.assertGreater(4200, self.CONSENT_HEARD)
        self.assertEqual(turn.anchor_ms - _EPOCH_MS, 2000)
        self.assertEqual(turn.tag_for(_EPOCH_MS + self.CONSENT_HEARD), gate_judge.TAG_PRE_QUESTION)
        self.assertNotEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(r.consumed, [])

    def test_a_yes_committed_while_the_consent_line_plays_is_captured_once(self):
        # Spoken 5000-5500 over the non-interruptible consent line (heard from
        # 4000, playing until 12000). The SDK drops the 6600 commit.
        fixture = _synthetic(
            "yes_over_line", consent=(3000, 4000, 12000),
            segments=[(5000, 5500)], finals=[(6000, "Yes, go ahead.")],
            commits=[(6600, "Yes, go ahead.", 5000)])
        r = gr.replay(fixture)
        self.assertEqual(r.dropped_commits, ["Yes, go ahead."])
        self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(r.consumed, ["Yes, go ahead."])
        self.assertNotIn("reask", r.spoken_kinds())
        # Decided as the reader starts at playout end: the turn closed before.
        self.assertEqual(r.decision_at_ms, 12000)
        self.assertEqual([(t.closed_by, t.committed) for t in r.gate_turns],
                         [("settle", False)])
        # Persisted exactly once, as grant evidence.
        rows = r.candidate_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "Yes, go ahead.")
        self.assertEqual(rows[0][3], "final-0")
        self.assertEqual(agent_mod._gate_source_item_id(rows[0][3]), "phone-gate-final-0")

    def test_a_late_commit_of_a_closed_grant_is_neither_reread_nor_rewritten(self):
        # The SDK commits (and keeps) the turn only after the gate already
        # closed it by silence and granted on it.
        fixture = _synthetic(
            "late_commit", consent=(3000, 4000, 4800),
            segments=[(5000, 5500)], finals=[(6000, "Yes, go ahead.")],
            commits=[(7400, "Yes, go ahead.", 5000)])
        r = gr.replay(fixture, driver=_then_wait(8000))
        self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(len(r.gate_turns), 1)
        self.assertEqual(len(r.logs_of("phone_gate_turn_barrier", "commit_duplicate")), 1)
        self.assertEqual([row[1] for row in r.candidate_rows()], ["Yes, go ahead."])

    def test_yes_then_busy_is_ONE_reply_never_a_grant(self):
        # "Yes" (5000-5400, final 5800) then "but I'm busy right now"
        # (6100-7600, final 8000): one turn, committed once.
        for label, commits in (
            ("committed", [(8500, "Yes but I'm busy right now", 5000)]),
            ("dropped", []),
        ):
            with self.subTest(label):
                fixture = _synthetic(
                    f"yes_then_busy_{label}", consent=(3000, 4000, 4800),
                    segments=[(5000, 5400), (6100, 7600)],
                    finals=[(5800, "Yes"), (8000, "but I'm busy right now")],
                    commits=commits)
                r = gr.replay(fixture)
                self.assertEqual(len(r.gate_turns), 1)
                self.assertEqual(r.consumed, ["Yes but I'm busy right now"])
                self.assertEqual(r.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
                self.assertNotIn("reask", r.spoken_kinds())


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

    def test_8b7df64a_is_no_longer_a_legacy_false_grant(self):
        """origin/main granted on the leading "yes" (an offline-bank false grant).

        T02's busy group ("some other time", "busy right now") is checked
        before the anchored affirmative, so even the legacy regex now routes
        this turn to the callback flow instead of recording on "Uh, yes". T05
        (llm mode) must refuse it too.
        """
        result = gr.replay("8b7df64a_shape")
        self.assertNotEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(result.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertNotIn("reask", result.spoken_kinds())


if __name__ == "__main__":
    unittest.main()
