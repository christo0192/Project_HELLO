"""M013 S01 T05: the gate judge wired into identity and consent.

Driven through the replay harness (`tests/gate_replay.py`, `drive_with_judge`)
with RECORDED judge responses on a virtual clock (no network), through the
real readers (`agent._read_fresh_turn`, `agent._classify_phone_answer`), the
real wiring (`agent._GateJudgeWiring`) and the real judge
(`gate_judge.judge_gate`), and through the real `phone.run_phone_gate` for the
split consent line and the reconnect leg.

Owner rules under test (S01-PLAN constraint 1 and T05):

* llm mode: a valid verdict acts; judge unavailable -> the legacy regex
  decides and may grant, but only on speech that began after the recording
  sentence; a valid non-grant verdict is never overridden by the regex;
* shadow mode: the legacy result acts, at the same time, and the judge only
  logs;
* the consent line is spoken split at the verbatim recording sentence, the
  same words, and the grant anchor is part B's start;
* no new AI wording: "is this an AI?" is answered with the verbatim first
  sentence of `phone_identity_text`; FAQ answers invent no numbers.

All candidate text and names are synthetic.
"""

from __future__ import annotations

import asyncio
import re
import types
import unittest
from unittest import mock

from tests import gate_replay as gr  # installs the SDK stub first
from tests.test_phone_conversational_gate import NAME, _GateHarness, _RecordingClient

import agent as agent_mod  # noqa: E402
import gate_judge  # noqa: E402
import phone  # noqa: E402

_BUSY_CB = {"day_text": "", "time_text": "", "resolved_ist": None}


def _speech(start, end, final, commit, text):
    return (start, end, final, commit, text)


def _fixture(name, *, speech=(), consent=(3000, 4300, 11000), identity=None,
             first_name="Neha"):
    """A synthetic replay fixture (SDK-shaped VAD events, relative ms)."""
    vad, finals, commits = [], [], []
    for start, end, final, commit, text in speech:
        vad.append(gr.VadEvent(start + 60, "start_of_speech", 50, 0, 10))
        vad.append(gr.VadEvent(end + 256, "end_of_speech", end - start, 256, 0))
        finals.append(gr.SttFinal(final, text))
        if commit is not None:
            commits.append(gr.CommittedTurn(commit, text, start, commit))
    lines = []
    if identity is not None:
        lines.append(gr.BotLine("identity", *identity))
    lines.append(gr.BotLine("consent", *consent))
    return gr.GateReplayFixture(
        name=f"synthetic_{name}", session_prefix="00000000",
        provenance="synthetic_shape", candidate_first_name=first_name,
        bot_lines=tuple(lines), vad_events=tuple(vad), stt_finals=tuple(finals),
        committed_turns=tuple(commits), judge_responses={"identity": []}, raw={},
    )


def _llm(fixture, responses, **kwargs):
    return gr.replay(fixture, driver=gr.drive_with_judge(mode="llm", responses=responses, **kwargs))


def _logs(result, error_type, category=None):
    return result.logs_of(error_type, category)


def _texts(result):
    return [line.text for line in result.spoken]


def _close_ms(fixture, text):
    return next(c.t_ms for c in fixture.committed_turns if c.text == text)


# â”€â”€ the four replays, llm mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


class TestReplaysInLlmMode(unittest.TestCase):

    def test_9f60523d_first_yes_is_granted_with_no_reask(self):
        fixture = gr.load_fixture("9f60523d")
        result = _llm(fixture, {
            "consent": [(gr.judge_json("consent_granted", "Yes, we can continue"), 700)],
        })
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertNotIn("reask", result.spoken_kinds())
        self.assertEqual(_logs(result, "phone_consent_reask"), [])
        # The decision lands within the judge latency of the turn closing.
        closed = _close_ms(fixture, "Yes, we can continue.")
        self.assertLessEqual(result.decision_at_ms - closed, 700 + 5)
        decisions = _logs(result, "phone_gate_decision")
        self.assertEqual([d.error_category for d in decisions], ["llm.consent_granted"])
        self.assertEqual(len(result.candidate_rows()), 1)
        self.assertEqual(result.glue.spoke.source, gate_judge.SPOKE_SOURCE_JUDGE)
        self.assertEqual(result.leaked_text_in_logs(), [])

    def test_32757295_busy_at_consent_is_the_callback_flow_never_machine(self):
        result = _llm("32757295", {
            "identity": [(gr.judge_json("unclear"), 800)],
            "consent": [(gr.judge_json(
                "not_now_busy", "I am busy right now", callback=_BUSY_CB), 900)],
        })
        self.assertEqual(result.identity_verdict, phone.PHONE_IDENTITY_UNCLEAR)
        self.assertEqual(result.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertEqual(result.consumed[-1], "I am busy right now")
        self.assertEqual(_logs(result, "phone_classify_fallback_machine"), [])
        self.assertNotIn("reask", result.spoken_kinds())
        self.assertEqual(result.leaked_text_in_logs(), [])

    def test_7a84dc44_second_utterance_during_the_verdict_is_rejudged_never_granted(self):
        # "Okay." then, while the first verdict is in flight, "can we
        # reschedule this, I'm out somewhere": the grant waits for the turn to
        # close, the fuller window is re-judged, and it is busy.
        fixture = gr.load_fixture("7a84dc44_shape").candidate_shifted(19000, -5600)
        result = _llm(fixture, {"consent": [
            (gr.judge_json("consent_granted", "Okay"), 1500),
            (gr.judge_json("not_now_busy", "Can we reschedule this", callback=_BUSY_CB), 800),
        ]})
        self.assertEqual(result.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertEqual(len(result.judge_transport.calls), 2)
        self.assertEqual(
            [u["text"] for u in result.judge_transport.calls[1][2]["utterances"]],
            ["Okay.", "Can we reschedule this, I'm out somewhere."])
        self.assertEqual(
            [r.error_category for r in _logs(result, "phone_gate_quiescence")], ["open_segment"])
        self.assertIn("reschedule", result.consumed[-1])
        decision = _logs(result, "phone_gate_decision")[-1]
        self.assertIn("_rj:1", decision.fields["schema"])

    def test_7a84dc44_unshifted_okay_is_granted_and_the_late_request_is_T07s(self):
        # CONTROL for the test above: the reschedule request begins only after
        # the grant was applied, so the consent read grants (T07's window
        # handles what follows).
        result = _llm("7a84dc44_shape", {"consent": [
            (gr.judge_json("consent_granted", "Okay"), 1500),
        ]})
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(len(result.judge_transport.calls), 1)

    def test_8b7df64a_hesitant_yes_then_busy_is_never_granted(self):
        result = _llm("8b7df64a_shape", {"consent": [
            (gr.judge_json("not_now_busy", "busy right now", callback=_BUSY_CB), 800),
        ]})
        self.assertEqual(result.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertNotEqual(result.decision, phone.CLASSIFY_HUMAN)


# â”€â”€ judge unavailable: the legacy fallback, with the recording anchor â”€â”€â”€â”€â”€


class TestJudgeTimeoutFallsBackToLegacy(unittest.TestCase):

    def _with_text(self, text):
        fixture = gr.load_fixture("9f60523d")
        return gr.replace(
            fixture, name=f"{fixture.name}[{text}]",
            stt_finals=tuple(gr.replace(f, text=text) if f.t_ms == 25618 else f
                             for f in fixture.stt_finals),
            committed_turns=tuple(gr.replace(c, text=text) if c.t_ms == 25625 else c
                                  for c in fixture.committed_turns),
        )

    def test_yes_go_ahead_is_granted_by_legacy_and_the_fallback_is_logged_once(self):
        result = _llm(self._with_text("Yes, go ahead."), {
            "consent": [(gr.JUDGE_TIMEOUT, 0)],
        })
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        fallbacks = _logs(result, "gate_judge_fallback_legacy")
        self.assertEqual(len(fallbacks), 1)
        self.assertEqual(fallbacks[0].error_category, "timeout")
        decision = _logs(result, "phone_gate_decision")[-1]
        self.assertEqual(decision.error_category, "legacy_fallback.consent_granted")
        # Bounded by the judge timeout (default 2.5 s).
        self.assertLessEqual(result.decision_at_ms - 25625, 2500 + 5)
        self.assertEqual(len(result.candidate_rows()), 1)

    def _yes_during(self, start):
        # The deterministic flow (no identity turn, no question anchor) with
        # the fixed disclosure: part A is the self-introduction, part B the
        # recording sentence and the question. A dropped-while-playing "Yes."
        # survives as its STT final, closed by silence.
        return _fixture(f"yes_at_{start}", speech=[
            _speech(start, start + 400, start + 900, start + 910, "Yes."),
        ])

    def test_yes_spoken_during_part_a_only_is_not_granted_and_is_reasked(self):
        result = _llm(self._yes_during(5000), {"consent": [(gr.JUDGE_TIMEOUT, 0)]},
                      anchor_consent=False)
        a_end, b_first = result.split_times
        self.assertLess(5000 + 400, a_end, "the fixture's yes must end inside part A")
        self.assertNotEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertIn("reask", result.spoken_kinds())
        self.assertEqual(
            len(_logs(result, "phone_gate_turn_barrier",
                      "legacy_grant_before_recording_anchor")), 1)
        self.assertEqual(result.candidate_rows(), [])

    def test_yes_spoken_during_part_b_after_the_notice_is_granted_by_legacy(self):
        # CONTROL: the same words after the recording sentence was heard.
        result = _llm(self._yes_during(9000), {"consent": [(gr.JUDGE_TIMEOUT, 0)]},
                      anchor_consent=False)
        _, b_first = result.split_times
        self.assertGreater(9000, b_first)
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(len(result.candidate_rows()), 1, "a dropped grant gets its row")

    def test_i_am_busy_routes_to_callback_through_legacy(self):
        result = _llm("32757295", {
            "identity": [(gr.JUDGE_TIMEOUT, 0)],
            "consent": [(gr.JUDGE_TIMEOUT, 0)],
        })
        self.assertEqual(result.identity_verdict, phone.PHONE_IDENTITY_UNCLEAR)
        self.assertEqual(result.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertEqual(len(_logs(result, "gate_judge_fallback_legacy")), 2)
        # The identity reader did not latch in llm mode; the fallback did.
        self.assertTrue(result.glue.spoke.spoke)

    def test_a_valid_non_grant_verdict_is_never_overridden_by_the_regex(self):
        # The regex would grant on "Yes, go ahead."; the judge said unclear.
        result = _llm(self._with_text("Yes, go ahead."), {"consent": [
            (gr.judge_json("unclear"), 500),
        ], "consent_retry": [(gr.judge_json("unclear"), 500)]})
        self.assertNotEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertIn("reask", result.spoken_kinds())
        self.assertEqual(_logs(result, "gate_judge_fallback_legacy"), [])

    def test_a_guard_rejected_judge_grant_is_unclear_never_a_fallback(self):
        # The judge grants on words that are not in the reply: unclear, and
        # the regex (which would grant) is not consulted.
        result = _llm(self._with_text("Yes, go ahead."), {"consent": [
            (gr.judge_json("consent_granted", "sure thing"), 500),
        ], "consent_retry": [(gr.judge_json("unclear"), 500)]})
        self.assertNotEqual(result.decision, phone.CLASSIFY_HUMAN)
        decision = _logs(result, "phone_gate_decision")[0]
        self.assertEqual(decision.error_category, "llm.unclear")
        self.assertEqual(decision.fields.get("rejection_reason"), "evidence_not_found")
        self.assertEqual(_logs(result, "gate_judge_fallback_legacy"), [])


# â”€â”€ shadow mode: the legacy outcome, at the legacy time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


class TestShadowMode(unittest.TestCase):

    CASES = {
        "9f60523d": {"consent": [(gr.judge_json("consent_granted", "Yes, we can continue"), 900)]},
        "32757295": {
            "identity": [(gr.judge_json("unclear"), 800)],
            "consent": [(gr.judge_json("not_now_busy", "I am busy right now",
                                       callback=_BUSY_CB), 900)],
        },
        "7a84dc44_shape": {"consent": [(gr.judge_json("consent_granted", "Okay"), 900)]},
        "8b7df64a_shape": {"consent": [(gr.judge_json("not_now_busy", "busy right now",
                                                      callback=_BUSY_CB), 900)]},
    }

    def test_the_outcome_and_its_timing_equal_legacy_and_the_judge_only_logs(self):
        for name, responses in self.CASES.items():
            with self.subTest(fixture=name):
                legacy = gr.replay(name, driver=gr.drive_with_judge(mode="legacy"))
                shadow = gr.replay(name, driver=gr.drive_with_judge(
                    mode="shadow", responses=responses))
                self.assertEqual(shadow.decision, legacy.decision)
                self.assertEqual(shadow.decision_at_ms, legacy.decision_at_ms)
                self.assertEqual(shadow.identity_verdict, legacy.identity_verdict)
                self.assertEqual(_texts(shadow), _texts(legacy))
                self.assertEqual(legacy.judge_transport.calls, [])
                # The judge ran and logged, but no acting decision was made.
                self.assertTrue(_logs(shadow, "phone_gate_shadow_decision"))
                self.assertTrue(_logs(shadow, "phone_gate_shadow"))
                self.assertEqual(_logs(shadow, "phone_gate_decision"), [])
                self.assertEqual(shadow.leaked_text_in_logs(), [])

    def test_agreement_is_logged_per_phase(self):
        result = gr.replay("32757295", driver=gr.drive_with_judge(
            mode="shadow", responses=self.CASES["32757295"]))
        rows = {(r.fields.get("phase"), r.error_category) for r in _logs(result, "phone_gate_shadow")}
        self.assertEqual(rows, {("identity", "agree"), ("consent", "agree")})

    def test_a_disagreeing_shadow_changes_nothing(self):
        responses = {"consent": [(gr.judge_json("not_now_busy", "Yes", callback=_BUSY_CB), 400)]}
        legacy = gr.replay("9f60523d", driver=gr.drive_with_judge(mode="legacy"))
        shadow = gr.replay("9f60523d", driver=gr.drive_with_judge(
            mode="shadow", responses=responses))
        self.assertEqual(shadow.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(shadow.decision_at_ms, legacy.decision_at_ms)
        self.assertEqual(
            [r.error_category for r in _logs(shadow, "phone_gate_shadow")], ["disagree"])


# â”€â”€ legacy mode: no judge at all â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


class TestLegacyModeCallsNoJudge(unittest.TestCase):

    def test_legacy_mode_never_calls_the_judge_and_matches_the_plain_driver(self):
        for name in ("9f60523d", "32757295", "8b7df64a_shape"):
            with self.subTest(fixture=name):
                wired = gr.replay(name, driver=gr.drive_with_judge(mode="legacy", split=False))
                plain = gr.replay(name)
                self.assertEqual(wired.judge_transport.calls, [])
                self.assertEqual(wired.decision, plain.decision)
                self.assertEqual(wired.decision_at_ms, plain.decision_at_ms)
                self.assertEqual(_texts(wired), _texts(plain))

    def test_the_session_default_mode_is_legacy(self):
        with mock.patch.dict("os.environ", {"PHONE_GATE_JUDGE": ""}):
            wiring = agent_mod._GateJudgeWiring(
                capture=agent_mod._new_gate_turn_capture(lambda _t: None),
                latch=gate_judge.HumanSpeechLatch(), question_anchor=lambda: None)
        self.assertEqual(wiring.mode, gate_judge.GATE_JUDGE_MODE_LEGACY)
        self.assertFalse(wiring.acting)
        self.assertFalse(wiring.shadowing)


# â”€â”€ the split consent line and the recording anchor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


class TestSplitConsentLine(unittest.TestCase):

    def test_the_parts_concatenate_to_the_original_line(self):
        sentence = phone.PHONE_DISCLOSURE_RECORDING_SENTENCE
        for line in (
            phone.PHONE_DISCLOSURE_TEXT,
            phone.PHONE_DISCLOSURE_CONTINUATION_TEXT,
            f"Great, thanks. {sentence} Shall we carry on?",
        ):
            part_a, part_b = phone.phone_split_consent_line(line)
            self.assertEqual(part_a + part_b, line)
            self.assertTrue(part_b.startswith(sentence))
            self.assertTrue(part_a.strip())
        opening = f"{sentence} Is it okay to continue?"
        self.assertEqual(phone.phone_split_consent_line(opening), ("", opening))
        self.assertEqual(phone.phone_split_consent_line("No notice here?"), ("", "No notice here?"))

    def test_the_anchor_is_part_b_first_audio_and_the_gap_is_within_150ms(self):
        result = _llm("9f60523d", {
            "consent": [(gr.judge_json("consent_granted", "Yes, we can continue"), 500)],
        }, gap_ms=120)
        a_end, b_first = result.split_times
        self.assertLessEqual(b_first - a_end, 150)
        anchor = result.glue.recording_anchor.value - result.glue.replay.epoch_ms
        self.assertEqual(anchor, b_first)
        self.assertEqual(
            [line.text for line in result.spoken if line.kind.startswith("consent")],
            [p.strip() if i == 0 else p for i, p in enumerate(
                phone.phone_split_consent_line(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT))],
        )

    def test_without_a_state_toggle_the_anchor_stays_at_part_a_end(self):
        result = _llm("9f60523d", {
            "consent": [(gr.judge_json("consent_granted", "Yes, we can continue"), 500)],
        }, state_toggles=False)
        a_end, _ = result.split_times
        self.assertEqual(result.glue.recording_anchor.value - result.glue.replay.epoch_ms, a_end)
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)

    def test_the_anchor_only_rises_to_part_b_never_to_a_later_line(self):
        anchor = agent_mod._GateRecordingAnchor()
        anchor.mark(10_000)
        anchor.on_first_audio(10_000 + agent_mod._RECORDING_ANCHOR_RAISE_MAX_MS + 1)
        self.assertEqual(anchor.value, 10_000)
        anchor.on_first_audio(10_100)  # disarmed after one first audio
        self.assertEqual(anchor.value, 10_000)
        anchor.mark(20_000)
        anchor.on_first_audio(19_000)  # never lowered
        self.assertEqual(anchor.value, 20_000)
        anchor.reset()
        self.assertIsNone(anchor.value)

    def test_a_draft_with_the_question_before_the_sentence_is_rejected(self):
        sentence = phone.PHONE_DISCLOSURE_RECORDING_SENTENCE
        draft = (f"Hi, this is Christy, an AI voice assistant calling from {phone._COMPANY}. "
                 f"Is it okay to continue? {sentence}")
        self.assertFalse(phone.phone_opening_draft_verified(draft))
        # The order check itself, reached past the end-on-the-question check.
        sink = []
        logger = types.SimpleNamespace(
            info=lambda *a, **f: sink.append(f), warn=lambda *a, **f: sink.append(f))
        with mock.patch.object(phone, "_opening_is_verified", return_value=True), \
                mock.patch.object(phone, "_log", logger):
            self.assertFalse(phone.phone_opening_draft_verified(draft))
        self.assertIn("rejected_order", [f.get("error_category") for f in sink])
        good = (f"Hi, this is Christy, an AI voice assistant calling from {phone._COMPANY}. "
                f"{sentence} Is it okay to continue?")
        self.assertTrue(phone.phone_opening_draft_verified(good))

    def test_the_split_halves_are_gate_copy_and_the_metric_starts_at_part_a(self):
        for line in (phone.PHONE_DISCLOSURE_TEXT, phone.PHONE_DISCLOSURE_CONTINUATION_TEXT):
            part_a, part_b = phone.phone_split_consent_line(line)
            self.assertTrue(phone.is_gate_copy(part_a.rstrip()))
            self.assertTrue(phone.is_gate_copy(part_b))
            self.assertTrue(phone.phone_disclosure_line_start(part_a.rstrip()))
            self.assertTrue(phone.phone_disclosure_line_start(line))
            self.assertFalse(phone.phone_disclosure_line_start(part_b))


class _SplitGate:
    """Drives the REAL `run_phone_gate` (deterministic flow) with the seam."""

    def __init__(self):
        self.calls = []
        self.events = []
        self.committed = []

    async def say(self, text):
        self.calls.append(("say", text))

    def mark(self):
        self.calls.append(("mark", None))

    async def classify(self):
        return phone.CLASSIFY_HUMAN

    async def commit_gate_turns(self, _session, turns, _key):
        self.committed.append(list(turns))
        return types.SimpleNamespace(ok=True)


class TestRunPhoneGateSpeaksTheSplitLine(unittest.IsolatedAsyncioTestCase):

    async def _run(self, gate, **extra):
        kwargs = dict(
            attempt_id="a1", client=_RecordingClient(gate),
            wait_for_participant=lambda: asyncio.sleep(0, result=object()),
            classify=gate.classify, say=gate.say, session_id="s1", epoch=1,
            mark_recording_sentence=gate.mark,
        )
        kwargs.update(extra)
        with mock.patch.dict("os.environ", {"PHONE_GATE_FLOW": ""}):
            return await phone.run_phone_gate(**kwargs)

    async def test_the_fixed_line_is_two_says_with_the_stamp_between(self):
        gate = _SplitGate()
        result = await self._run(gate)
        part_a, part_b = phone.phone_split_consent_line(phone.PHONE_DISCLOSURE_TEXT)
        self.assertEqual(gate.calls[:3], [("say", part_a.rstrip()), ("mark", None), ("say", part_b)])
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        # The transcript still records the whole line the candidate heard.
        self.assertEqual(gate.committed[0][0], {"speaker": "bot", "text": phone.PHONE_DISCLOSURE_TEXT})

    async def test_a_composed_line_is_split_too(self):
        gate = _SplitGate()
        sentence = phone.PHONE_DISCLOSURE_RECORDING_SENTENCE
        draft = (f"Hello! This is Christy, an AI voice assistant calling from {phone._COMPANY}. "
                 f"{sentence} Is it okay to continue?")

        async def compose():
            return draft

        await self._run(gate, compose_opening=compose)
        part_a, part_b = phone.phone_split_consent_line(draft)
        self.assertEqual(gate.calls[:3], [("say", part_a.rstrip()), ("mark", None), ("say", part_b)])

    async def test_without_the_seam_the_line_is_spoken_whole(self):
        gate = _SplitGate()
        await self._run(gate, mark_recording_sentence=None)
        self.assertEqual(gate.calls[0], ("say", phone.PHONE_DISCLOSURE_TEXT))
        self.assertNotIn(("mark", None), gate.calls)


# â”€â”€ fixed answers to a consent-turn question â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _question_then_okay(question):
    # Consent line 3000-11000; the question 12000-13200; "Okay" after the
    # answer and the re-ask have played.
    return _fixture("question", speech=[
        _speech(12000, 13200, 13700, 13710, question),
        _speech(24000, 24500, 25000, 25010, "Okay."),
    ])


class TestConsentQuestionsGetFixedAnswers(unittest.TestCase):

    def _run(self, kind, question="How long will it take?", role_title=None):
        return _llm(_question_then_okay(question), {"consent": [
            (gr.judge_json("question", question.rstrip("?"), question=kind), 600),
        ], "consent_retry": [
            (gr.judge_json("consent_granted", "Okay"), 500),
        ]}, role_title=role_title)

    def test_how_long_is_answered_without_a_number_then_asked_again(self):
        result = self._run("how_long")
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        reasks = [line.text for line in result.spoken if line.kind == "reask"]
        self.assertEqual(reasks, [phone.PHONE_CONSENT_FAQ_HOW_LONG_TEXT,
                                  phone.PHONE_CONSENT_REASK_AFTER_ANSWER_TEXT])
        self.assertIn(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE,
                      phone.PHONE_CONSENT_REASK_AFTER_ANSWER_TEXT)
        self.assertEqual([c[0] for c in result.judge_transport.calls], ["consent", "consent_retry"])

    def test_is_this_an_ai_reuses_the_verbatim_identity_sentence(self):
        result = self._run("is_ai", question="Is this an AI?")
        reasks = [line.text for line in result.spoken if line.kind == "reask"]
        sentence = phone.phone_ai_identity_sentence()
        self.assertEqual(reasks[0], sentence)
        self.assertTrue(phone.phone_identity_text(None).startswith(sentence))
        self.assertTrue(phone.phone_identity_text("Asha").startswith(sentence))
        self.assertEqual(
            sentence,
            f"Hi, this is Christy, an AI voice assistant calling from {phone._COMPANY}.")

    def test_what_role_names_the_server_role_only(self):
        result = self._run("what_role", question="Which role is this?",
                           role_title="Sales Program Advisor")
        reasks = [line.text for line in result.spoken if line.kind == "reask"]
        self.assertEqual(reasks[0], "It's about the Sales Program Advisor role you applied for.")
        self.assertTrue(phone.is_gate_copy(reasks[0]))
        self.assertEqual(phone.phone_consent_faq_text("what_role"),
                         phone.PHONE_CONSENT_FAQ_ROLE_UNKNOWN_TEXT)

    def test_an_other_question_gets_the_question_reask(self):
        result = self._run("other", question="Who gave you my number?")
        reasks = [line.text for line in result.spoken if line.kind == "reask"]
        self.assertEqual(reasks, [phone.PHONE_CONSENT_REASK_QUESTION_TEXT])

    def test_a_question_buys_one_more_round_at_most_two_reasks(self):
        fixture = _fixture("unclear_question_okay", speech=[
            _speech(12000, 12600, 13100, 13110, "Hmm."),
            _speech(20000, 21000, 21500, 21510, "How long is it?"),
            _speech(32000, 32500, 33000, 33010, "Okay."),
        ])
        result = _llm(fixture, {
            "consent": [(gr.judge_json("unclear"), 500)],
            "consent_retry": [
                (gr.judge_json("question", "How long is it", question="how_long"), 500),
                (gr.judge_json("consent_granted", "Okay"), 500),
            ],
        })
        self.assertEqual(result.decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(len(_logs(result, "phone_consent_reask")), 2)

    def test_two_questions_after_the_extension_end_in_a_deferral(self):
        fixture = _fixture("questions", speech=[
            _speech(12000, 12600, 13100, 13110, "How long?"),
            _speech(24000, 24600, 25100, 25110, "Who reviews it?"),
            _speech(36000, 36600, 37100, 37110, "What role?"),
        ])
        result = _llm(fixture, {
            "consent": [(gr.judge_json("question", "How long", question="how_long"), 500)],
            "consent_retry": [
                (gr.judge_json("question", "Who reviews it", question="who_reviews"), 500),
                (gr.judge_json("question", "What role", question="what_role"), 500),
            ],
        })
        self.assertEqual(result.decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(len(_logs(result, "phone_consent_reask")), 2)

    def test_the_fixed_answers_invent_no_numbers_and_add_no_ai_wording(self):
        answers = [
            phone.PHONE_CONSENT_FAQ_HOW_LONG_TEXT,
            phone.PHONE_CONSENT_FAQ_WHO_REVIEWS_TEXT,
            phone.PHONE_CONSENT_FAQ_ROLE_UNKNOWN_TEXT,
            phone.PHONE_CONSENT_REASK_AFTER_ANSWER_TEXT,
        ]
        for text in answers:
            self.assertIsNone(re.search(r"\d|minute|hour|second", text, re.IGNORECASE), text)
            self.assertNotRegex(text, r"\bAI\b|artificial|bot\b|assistant")
            self.assertTrue(phone.is_gate_copy(text))
        self.assertTrue(phone.is_gate_copy(phone.phone_ai_identity_sentence()))


# â”€â”€ voicemail at consent, and the latch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


class TestVoicemailAndTheLatch(unittest.TestCase):

    def test_a_judged_voicemail_with_nobody_heard_is_machine_and_does_not_latch(self):
        fixture = _fixture("voicemail", speech=[
            _speech(12000, 15000, 15500, 15510, "Please leave your message after the tone."),
        ])
        result = _llm(fixture, {"consent": [
            (gr.judge_json("voicemail_machine", "Please leave your message after the tone"), 500),
        ]})
        self.assertEqual(result.decision, phone.CLASSIFY_MACHINE)
        self.assertFalse(result.glue.spoke.spoke)

    def test_a_judged_voicemail_after_a_person_spoke_is_not_machine(self):
        fixture = _fixture("spoke_then_voicemail", identity=(0, 500, 4000), consent=(9000, 9500, 15000), speech=[
            _speech(5000, 5600, 6100, 6110, "Hello?"),
            _speech(16000, 19000, 19500, 19510, "Please leave your message after the tone."),
        ])
        result = _llm(fixture, {
            "identity": [(gr.judge_json("unclear"), 400)],
            "consent": [(gr.judge_json("voicemail_machine", "Please leave your message"), 500)],
        })
        self.assertTrue(result.glue.spoke.spoke)
        self.assertEqual(result.glue.spoke.source, gate_judge.SPOKE_SOURCE_JUDGE)
        self.assertNotEqual(result.decision, phone.CLASSIFY_MACHINE)

    def test_a_judged_voicemail_greeting_at_identity_does_not_latch(self):
        fixture = _fixture("identity_voicemail", identity=(0, 500, 4000), consent=(9000, 9500, 15000),
                           speech=[_speech(4200, 6000, 6500, 6510, "You have reached Neha, leave a message.")])
        result = _llm(fixture, {
            "identity": [(gr.judge_json("voicemail_machine", "leave a message"), 400)],
        })
        self.assertEqual(result.identity_verdict, phone.PHONE_IDENTITY_UNCLEAR)
        self.assertFalse(result.glue.spoke.spoke)
        # Silence at consent with nobody heard: machine (T02 rule a/b).
        self.assertEqual(result.decision, phone.CLASSIFY_MACHINE)


# â”€â”€ the identity turn through the real gate (extends TestGateIdentityFlow) â”€


class _Judge:
    def __init__(self, *intents, raise_exc=None):
        self.intents = list(intents)
        self.replies = []
        self.raise_exc = raise_exc

    async def __call__(self, reply):
        self.replies.append(reply)
        if self.raise_exc is not None:
            raise self.raise_exc
        return self.intents.pop(0) if self.intents else None


class TestIdentityJudgeThroughTheGate(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        patcher = mock.patch.dict("os.environ", {"PHONE_GATE_FLOW": "conversational"})
        patcher.start()
        self.addCleanup(patcher.stop)

    async def _gate(self, harness, judge, **overrides):
        routes = []
        kwargs = dict(
            attempt_id="a1", client=_RecordingClient(harness),
            wait_for_participant=lambda: asyncio.sleep(0, result=object()),
            classify=harness.classify, say=harness.say, session_id="s1", epoch=1,
            next_candidate_turn=harness.next_candidate_turn,
            speak_gate_line=harness.speak_gate_line,
            mark_question_asked=harness.mark_question_asked,
            candidate_name=NAME, judge_identity=judge,
            note_identity_route=routes.append,
        )
        kwargs.update(overrides)
        infer = mock.AsyncMock(side_effect=harness.infer)
        with mock.patch.object(phone, "_default_phone_identity_inference", infer):
            result = await phone.run_phone_gate(**kwargs)
        return result, infer, routes

    async def test_identity_confirmed_proceeds_without_the_identity_model(self):
        h = _GateHarness(replies=["Yes, speaking."], verdicts=["other_person"])
        result, infer, routes = await self._gate(h, _Judge("identity_confirmed"))
        infer.assert_not_awaited()
        self.assertEqual(routes, [])
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_wrong_person_twice_ends_the_call_and_never_once(self):
        h = _GateHarness(replies=["No, wrong person.", "No, I told you."], verdicts=[])
        result, infer, _ = await self._gate(h, _Judge("wrong_person", "wrong_person"))
        infer.assert_not_awaited()
        self.assertIn(phone.phone_identity_reask_text(NAME), h.spoken)
        self.assertIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)
        self.assertTrue(result.not_the_candidate)

    async def test_wrong_person_once_then_confirmed_proceeds(self):
        h = _GateHarness(replies=["No.", "Oh sorry, yes it's me."], verdicts=[])
        result, _, _ = await self._gate(h, _Judge("wrong_person", "identity_confirmed"))
        self.assertNotIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_a_judged_wrong_person_naming_the_record_is_downgraded_to_self(self):
        h = _GateHarness(replies=[f"No no, this is {NAME} only."], verdicts=[])
        result, _, _ = await self._gate(h, _Judge("wrong_person"))
        self.assertNotIn(phone.phone_identity_reask_text(NAME), h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_busy_or_unavailable_takes_the_callback_route(self):
        h = _GateHarness(replies=["She is not at home.", ""], verdicts=[])
        result, _, _ = await self._gate(h, _Judge("not_now_busy"))
        self.assertIn(phone.PHONE_CALLBACK_DEFERRAL_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)

    async def test_a_judged_third_party_unavailable_books_a_callback_before_consent(self):
        # Words the regex pre-check does not read as busy; the judge does.
        h = _GateHarness(replies=["She has gone to the temple.", "tomorrow at 3 pm"], verdicts=[])
        proposal = phone.CallbackProposal({
            "starts_at": "2026-10-07T09:30:00Z", "ends_at": "2026-10-07T09:45:00Z",
            "weekday": "Wednesday", "ist_date": "2026-10-07", "ist_time": "15:00",
            "time_zone": "Asia/Kolkata",
        })
        recording = _RecordingClient(h)
        client = types.SimpleNamespace(
            post_event=recording.post_event,
            commit_gate_turns=recording.commit_gate_turns,
            propose_callback=mock.AsyncMock(return_value=(
                phone.PhoneApiOutcome(True, "proposal_valid"), proposal)),
            confirm_callback=mock.AsyncMock(return_value=phone.PhoneApiOutcome(True, "ok")),
            consent_and_start_assessment=mock.AsyncMock(side_effect=AssertionError("no consent")),
        )
        self.assertIsNone(agent_mod.classify_answer_text("She has gone to the temple."))
        result, infer, _ = await self._gate(
            h, _Judge("not_now_busy"), client=client,
            classify_gate_reply=agent_mod.classify_answer_text,
        )
        infer.assert_not_awaited()
        self.assertNotIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.HALT_CALLBACK_SCHEDULED)
        client.confirm_callback.assert_awaited_once()

    async def test_voicemail_question_and_unclear_proceed_to_consent(self):
        for intent in ("voicemail_machine", "question", "unclear"):
            with self.subTest(intent=intent):
                h = _GateHarness(replies=["Hmm?"], verdicts=[])
                result, infer, _ = await self._gate(h, _Judge(intent))
                infer.assert_not_awaited()
                self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
                self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_opt_out_is_the_opt_out_terminal(self):
        h = _GateHarness(replies=["Never call me again."], verdicts=[])
        result, _, _ = await self._gate(h, _Judge("opt_out"))
        self.assertIn("candidate.opt_out", h.events)
        self.assertIn(phone.PHONE_OPT_OUT_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_OPT_OUT)

    async def test_end_call_and_declined_end_before_consent(self):
        for intent in ("end_call", "consent_declined"):
            with self.subTest(intent=intent):
                h = _GateHarness(replies=["Bye."], verdicts=[])
                result, _, _ = await self._gate(h, _Judge(intent))
                self.assertIn(phone.PHONE_CANDIDATE_END_TEXT, h.spoken)
                self.assertNotIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
                self.assertEqual(h.classify_calls, 0)

    async def test_no_verdict_or_a_broken_judge_is_the_legacy_path(self):
        for judge in (_Judge(None), _Judge(raise_exc=RuntimeError("down")), _Judge("not_an_intent")):
            with self.subTest(judge=judge):
                h = _GateHarness(replies=["Yes, this is me."], verdicts=["self"])
                result, infer, routes = await self._gate(h, judge)
                infer.assert_awaited_once()
                self.assertEqual(routes, [gate_judge.INTENT_IDENTITY_CONFIRMED])
                self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_the_legacy_precheck_route_is_reported_for_the_shadow(self):
        h = _GateHarness(replies=["I'm busy, call me later."], verdicts=[])
        _, _, routes = await self._gate(
            h, _Judge(None), classify_gate_reply=agent_mod.classify_answer_text)
        self.assertEqual(routes, [gate_judge.INTENT_NOT_NOW_BUSY])

    async def test_an_empty_reply_is_never_judged(self):
        h = _GateHarness(replies=[""], verdicts=[])
        judge = _Judge("wrong_person")
        await self._gate(h, judge)
        self.assertEqual(judge.replies, [])
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)

    async def test_a_reconnect_leg_calls_no_judge_and_asks_nothing(self):
        h = _GateHarness(replies=["Yes."], verdicts=["self"])
        judge = _Judge("identity_confirmed")
        classify = mock.AsyncMock(return_value=phone.CLASSIFY_HUMAN)

        async def durable():
            return types.SimpleNamespace(ok=True, gate_recorded=True)

        result, infer, _ = await self._gate(
            h, judge, classify=classify, fetch_durable_consent=durable)
        self.assertEqual(judge.replies, [])
        classify.assert_not_awaited()
        infer.assert_not_awaited()
        self.assertEqual(h.spoken, [])
        self.assertTrue(result.assessment_allowed)


if __name__ == "__main__":
    unittest.main()
