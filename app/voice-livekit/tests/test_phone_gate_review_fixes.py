"""M013 S01: fixes from the two adversarial reviews of the gate branch.

Each class pins one finding, driven through the real code: the replay
harness (`tests/gate_replay.py`) on a virtual clock for the readers, the real
`gate_judge.GateTurnCapture` on a manual clock for pairing and quiescence, and
`gate_judge.judge_gate` with recorded responses for the verdict guards.

* the informed-consent rule (speech must begin at or after the recording
  sentence) applies to the LEGACY regex in legacy and shadow mode too, not
  only to the llm-mode fallback (blocker);
* words a reader skipped still mean a person is on the line (weak latch), so
  such a call is deferred with a goodbye, never hung up on as "machine";
* the quiescence wait waits for quiet, not for a new turn;
* the acoustic guard reads the longest paired segment, and pairing never
  moves a start later;
* suppressive judge verdicts (opt-out, wrong person, decline) need evidence
  spoken after the question.

All candidate text and names are synthetic.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import types
import unittest
import unittest.mock

from tests import gate_replay as gr  # installs the SDK stub first
from tests.test_phone_gate_judge import (
    _ENABLED, _Transport, _breaker, _request, _utt, _verdict,
)
from tests.test_phone_gate_judge_wiring import _busy, _fixture, _speech, _window
from tests.test_phone_gate_turn_barrier import _Rig

import agent as agent_mod  # noqa: E402,F401
import gate_judge  # noqa: E402
import phone  # noqa: E402

_MODES = (
    gate_judge.GATE_JUDGE_MODE_LEGACY,
    gate_judge.GATE_JUDGE_MODE_SHADOW,
    gate_judge.GATE_JUDGE_MODE_LLM,
)


def _replay(fixture, *, mode, responses=None, anchor_consent=True, state_toggles=True):
    return gr.replay(fixture, driver=gr.drive_with_judge(
        mode=mode, responses=responses if responses is not None else {
            "consent": [(gr.JUDGE_TIMEOUT, 0)] * 3},
        anchor_consent=anchor_consent, state_toggles=state_toggles,
        shadow_settle_ms=0,
    ))


class TestNoGrantBeforeTheRecordingSentence(unittest.TestCase):
    """BLOCKER: a "yes" spoken over part A of the consent line (the SDK drops
    its commit; the settle close recovers it) is never consent, in any mode,
    either gate flow (``anchor_consent``) and either SDK state behaviour
    between the two halves of the line (``state_toggles``)."""

    def _part_a_yes(self, **extra):
        speech = [_speech(5000, 5400, 5900, 5910, "Yes.")]
        speech.extend(extra.get("more", ()))
        return _fixture("part_a_yes", speech=speech)

    def test_a_part_a_yes_never_grants(self):
        for mode in _MODES:
            for anchor_consent in (True, False):
                for toggles in (True, False):
                    with self.subTest(mode=mode, anchor_consent=anchor_consent,
                                      toggles=toggles):
                        r = _replay(self._part_a_yes(), mode=mode,
                                    anchor_consent=anchor_consent, state_toggles=toggles)
                        a_end, _ = r.split_times
                        self.assertLess(5400, a_end, "the yes must be inside part A")
                        self.assertNotEqual(r.decision, phone.CLASSIFY_HUMAN)
                        # A person spoke: deferral with a goodbye, never machine.
                        self.assertEqual(r.decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
                        self.assertEqual(r.candidate_rows(), [], "no grant evidence row")

    def test_the_legacy_skip_is_logged_without_text(self):
        r = _replay(self._part_a_yes(), mode=gate_judge.GATE_JUDGE_MODE_LEGACY,
                    anchor_consent=False)
        skips = r.logs_of("phone_gate_turn_barrier", "legacy_grant_before_recording_anchor")
        self.assertEqual(len(skips), 1)
        self.assertEqual(r.leaked_text_in_logs(), [])

    def test_a_yes_after_the_question_still_grants_promptly(self):
        # The part-A "yes", then the real answer after the question: granted
        # on the second one, which is the evidence row.
        later = _speech(9600, 10300, 10800, 10810, "Yes, go ahead.")
        for mode in (gate_judge.GATE_JUDGE_MODE_LEGACY, gate_judge.GATE_JUDGE_MODE_SHADOW):
            for anchor_consent in (True, False):
                with self.subTest(mode=mode, anchor_consent=anchor_consent):
                    r = _replay(self._part_a_yes(more=[later]), mode=mode,
                                anchor_consent=anchor_consent)
                    self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
                    self.assertEqual([row[1] for row in r.candidate_rows()],
                                     ["Yes, go ahead."])
                    self.assertNotIn("reask", r.spoken_kinds())

    def test_a_part_a_yes_is_re_asked_promptly_not_after_the_whole_window(self):
        r = _replay(self._part_a_yes(), mode=gate_judge.GATE_JUDGE_MODE_LEGACY,
                    anchor_consent=False)
        consent_end = max(line.playout_end_ms for line in r.spoken if line.kind == "consent")
        reask = [line for line in r.spoken if line.kind == "reask"]
        self.assertTrue(reask)
        self.assertLessEqual(
            reask[0].start_ms - consent_end,
            int(agent_mod._PRE_RECORDING_YES_LISTEN_SEC * 1000) + 3000,
            "a candidate who thinks they answered is not left in silence")


class TestSkippedWordsAreAPerson(unittest.TestCase):
    """MAJOR: an identity reply STT never finalised (the 9f60523d shape), then
    a "Yes." over the consent line, then silence: a person, so a deferral
    with a goodbye, never ``machine`` (T02 rule a)."""

    def test_never_machine(self):
        for mode in _MODES:
            for toggles in (True, False):
                with self.subTest(mode=mode, toggles=toggles):
                    fx = _fixture(
                        "yes_over_consent",
                        speech=[_speech(11000, 11400, 11900, 11910, "Yes.")],
                        identity=(0, 1000, 2500), consent=(9000, 10300, 17000))
                    r = _replay(fx, mode=mode, state_toggles=toggles)
                    self.assertEqual(r.identity_reply, "")
                    self.assertEqual(r.decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)

    def test_a_voicemail_greeting_is_still_machine(self):
        fx = _fixture(
            "greeting",
            speech=[_speech(11000, 13400, 13900, 13910,
                            "The person you are calling is not available, please leave a message.")],
            identity=(0, 1000, 2500), consent=(9000, 10300, 17000))
        for mode in (gate_judge.GATE_JUDGE_MODE_LEGACY, gate_judge.GATE_JUDGE_MODE_SHADOW):
            with self.subTest(mode=mode):
                r = _replay(fx, mode=mode)
                self.assertEqual(r.decision, phone.CLASSIFY_MACHINE)


class TestQuiescenceWaitsForQuiet(unittest.TestCase):
    """MAJOR: one echo blip right after the reply used to add 6 s of dead air
    before a judge grant; continuous noise re-asked a consenting candidate."""

    _GRANT = {"consent": [(gr.judge_json("consent_granted", "Yes, go ahead"), 600)] * 3}

    def _fx(self, extra_vad=()):
        fx = _fixture("quiet", speech=[_speech(13000, 13800, 14300, 14310, "Yes, go ahead.")],
                      consent=(3000, 4300, 11000))
        if extra_vad:
            vad = sorted(list(fx.vad_events) + list(extra_vad), key=lambda e: e.t_ms)
            fx = dataclasses.replace(fx, vad_events=tuple(vad))
        return fx

    def test_a_short_blip_costs_no_dead_air(self):
        blip = (gr.VadEvent(14460, "start_of_speech", 50, 0, 10),
                gr.VadEvent(14456 + 256 + 150, "end_of_speech", 150, 256, 0))
        for extra in ((), blip):
            with self.subTest(blip=bool(extra)):
                r = _replay(self._fx(extra), mode=gate_judge.GATE_JUDGE_MODE_LLM,
                            responses=self._GRANT)
                self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
                self.assertLessEqual(r.decision_at_ms - 14310, 700)

    def test_continuous_noise_does_not_cost_the_grant(self):
        # A VAD segment opens right after the reply and never closes.
        noise = (gr.VadEvent(14460, "start_of_speech", 50, 0, 10),)
        r = _replay(self._fx(noise), mode=gate_judge.GATE_JUDGE_MODE_LLM,
                    responses=self._GRANT)
        self.assertEqual(r.decision, phone.CLASSIFY_HUMAN)
        self.assertLessEqual(
            r.decision_at_ms - 14400, gate_judge.GATE_OPEN_SEGMENT_BLOCK_MAX_MS + 1500)
        self.assertNotIn("reask", r.spoken_kinds())

    def test_real_speech_awaiting_its_final_still_holds_the_grant(self):
        # "Yes, go ahead." then real speech (600 ms) whose final is late: the
        # grant waits for it and re-judges the fuller window.
        fx = _fixture("more", speech=[
            _speech(13000, 13800, 14300, 14310, "Yes, go ahead."),
            _speech(14500, 15100, 16500, 16510, "But I'm driving, call me later."),
        ], consent=(3000, 4300, 11000))
        responses = {"consent": [
            (gr.judge_json("consent_granted", "Yes, go ahead"), 600),
            (gr.judge_json("not_now_busy", "call me later",
                           callback={"day_text": "", "time_text": "", "resolved_ist": None}), 600),
        ]}
        r = _replay(fx, mode=gate_judge.GATE_JUDGE_MODE_LLM, responses=responses)
        self.assertEqual(r.decision, phone.CLASSIFY_CALLBACK_REQUESTED)


class TestPairingAndTheAcousticGuard(unittest.TestCase):
    """MINOR: the acoustic guard reads the longest paired segment (never the
    sum), and a final's start can only move earlier, never later."""

    def test_a_click_plus_a_blip_do_not_add_up(self):
        rig = _Rig()
        rig.segment(5_000, 5_120)
        rig.segment(5_400, 5_600)
        utterance = rig.final(6_000, "yes")
        self.assertEqual(utterance.segment_speech_ms, 200)
        self.assertLess(utterance.segment_speech_ms, gate_judge.GRANT_MIN_SPEECH_DEFAULT_MS)

    def test_an_old_segment_running_into_the_reply_keeps_the_earlier_start(self):
        rig = _Rig()
        rig.segment(10_000, 12_000)   # ends 3.7 s before the final arrives
        rig.segment(12_800, 15_000)   # 800 ms later: the same utterance
        utterance = rig.final(15_700, "yes but let me first ask something about it")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 10_000)
        finals = [f for f in rig.logs if f.get("error_type") == "phone_gate_final"]
        self.assertEqual(finals[-1]["error_category"], "paired_chained")

    def test_an_unrelated_old_blip_still_expires(self):
        rig = _Rig()
        rig.segment(5_000, 5_200)     # a blip, long before
        rig.segment(12_800, 15_000)
        utterance = rig.final(15_700, "yes")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 12_800)

    def test_quiescence_ignores_a_blip_but_not_words(self):
        rig = _Rig()
        rig.segment(5_000, 5_600)
        first = rig.final(6_000, "yes")
        rig.segment(6_100, 6_220)     # 120 ms: an echo blip
        rig.timers.advance(6_500)
        self.assertIsNone(rig.capture.pending_speech(first.idx))
        rig.segment(6_600, 7_200)     # 600 ms: words, final still to come
        rig.timers.advance(7_600)
        self.assertEqual(rig.capture.pending_speech(first.idx), "awaiting_final")

    def test_an_open_segment_blocks_only_for_a_bounded_time(self):
        rig = _Rig()
        rig.segment(5_000, 5_600)
        first = rig.final(6_000, "yes")
        rig.vad(6_160, "start_of_speech", speech_ms=50, inference_ms=10)
        rig.timers.advance(7_000)
        self.assertEqual(rig.capture.pending_speech(first.idx), "open_segment")
        rig.timers.advance(6_100 + gate_judge.GATE_OPEN_SEGMENT_BLOCK_MAX_MS + 100)
        self.assertIsNone(rig.capture.pending_speech(first.idx))


def _judge_run(request, *responses):
    async def _t():
        transport = _Transport(*responses)
        return await gate_judge.judge_gate(
            request, transport=transport, config=_ENABLED, breaker=_breaker(),
            log=lambda **_: None, timeout_sec=2.5, min_speech_ms=250)

    return asyncio.run(_t())


class TestSuppressiveVerdictsNeedEvidence(unittest.TestCase):
    """MINOR: an opt-out, wrong-person or decline verdict suppresses the
    candidate, so it must cite their own words spoken after the question."""

    def test_no_evidence_is_unclear(self):
        for intent in sorted(gate_judge.SUPPRESSIVE_INTENTS):
            with self.subTest(intent=intent):
                d = _judge_run(_request(_utt(0, "hmm")), _verdict(intent, ""))
                self.assertEqual((d.intent, d.guard_rejected_reason), ("unclear", "no_evidence"))

    def test_evidence_not_said_or_a_label_is_unclear(self):
        d = _judge_run(_request(_utt(0, "hmm okay")), _verdict("opt_out", "never call me"))
        self.assertEqual((d.intent, d.guard_rejected_reason), ("unclear", "evidence_not_found"))
        d = _judge_run(_request(_utt(0, "say opt_out please")), _verdict("opt_out", "opt_out"))
        self.assertEqual((d.intent, d.guard_rejected_reason), ("unclear", "evidence_is_label"))

    def test_evidence_before_the_question_is_unclear(self):
        stale = _utt(0, "no no", tag=gate_judge.TAG_PRE_QUESTION, start=8_000)
        d = _judge_run(_request(stale, _utt(1, "hmm")), _verdict("consent_declined", "no no"))
        self.assertEqual((d.intent, d.guard_rejected_reason),
                         ("unclear", "evidence_not_post_question"))

    def test_grounded_verdicts_still_act(self):
        for intent, text, evidence in (
            ("opt_out", "Please don't call me again.", "don't call me again"),
            ("wrong_person", "Wrong number, there is no such person.", "Wrong number"),
            ("consent_declined", "No, I don't want to do this.", "I don't want to do this"),
        ):
            with self.subTest(intent=intent):
                d = _judge_run(_request(_utt(0, text)), _verdict(intent, evidence))
                self.assertEqual(d.intent, intent)
                self.assertEqual(d.evidence_idx, 0)

    def test_a_voicemail_verdict_must_cite_words_that_were_heard(self):
        # Round 2 (major): a judged voicemail is a silent hang-up at consent.
        for evidence, reason in (
            ("", "no_evidence"),
            ("voicemail_machine", "evidence_is_label"),
            ("leave a message after the tone", "evidence_not_found"),
        ):
            with self.subTest(evidence=evidence):
                d = _judge_run(_request(_utt(0, "Hello? Who is this? voicemail machine")),
                               _verdict("voicemail_machine", evidence))
                self.assertEqual((d.intent, d.guard_rejected_reason), ("unclear", reason))

    def test_a_grounded_voicemail_acts_even_before_the_question(self):
        # A greeting plays from pick-up and overlaps the bot's line: no
        # post_question requirement, only that the cited words were heard.
        greeting = _utt(0, "Please leave your message after the tone.",
                        tag=gate_judge.TAG_PRE_QUESTION, start=8_000)
        d = _judge_run(_request(greeting), _verdict("voicemail_machine", "leave your message"))
        self.assertEqual((d.intent, d.evidence_idx), ("voicemail_machine", 0))

    def test_non_suppressive_verdicts_are_unchanged(self):
        d = _judge_run(_request(_utt(0, "how long will it take")),
                       _verdict("question", "", question="how_long"))
        self.assertEqual(d.intent, "question")


class TestBackstopCoversTheJudgesWaits(unittest.TestCase):
    """MINOR: in llm mode one consent attempt can spend re-judges and
    quiescence waits, and a question back buys a third round; the backstop
    floor must cover them or a consenting reply to the re-ask is cut off."""

    def _floor(self, mode):
        with unittest.mock.patch.dict(
                os.environ, {"PHONE_GATE_JUDGE": mode}, clear=False):
            for key in ("PHONE_CLASSIFY_ANSWER_TIMEOUT_SEC", "PHONE_GATE_JUDGE_TIMEOUT_SEC",
                        "PHONE_CLASSIFY_TIMEOUT_SEC"):
                os.environ.pop(key, None)
            return (phone.phone_classify_backstop_floor_sec(),
                    phone.phone_classify_timeout_sec())

    def test_legacy_and_shadow_are_unchanged(self):
        for mode in ("legacy", "shadow"):
            with self.subTest(mode):
                floor, effective = self._floor(mode)
                self.assertAlmostEqual(floor, 50.4)
                self.assertAlmostEqual(effective, 50.4)

    def test_llm_mode_counts_rejudges_waits_and_the_question_round(self):
        floor, effective = self._floor("llm")
        answer, judge = 15.0, gate_judge.GATE_JUDGE_TIMEOUT_DEFAULT_SEC
        waits = gate_judge.GATE_JUDGE_MAX_REJUDGES * gate_judge.GATE_QUIESCENCE_WAIT_MAX_SEC
        per_attempt = answer + 12.0 + (1 + gate_judge.GATE_JUDGE_MAX_REJUDGES) * judge + waits
        self.assertAlmostEqual(floor, 3 * per_attempt + 5.0)
        self.assertAlmostEqual(floor, 137.3)
        self.assertGreaterEqual(effective, floor)
        self.assertEqual(agent_mod._GATE_QUIESCENCE_WAIT_MAX_SEC,
                         gate_judge.GATE_QUIESCENCE_WAIT_MAX_SEC)


class TestPreloopSkipsBackchannels(unittest.IsolatedAsyncioTestCase):
    """NIT: a back-channel during the role line ("okay", "hmm") delayed Q1
    by up to the judge timeout in llm mode; it can never be a revocation."""

    async def test_a_backchannel_does_not_delay_q1(self):
        window, transport, _ = _window({}, timeout=1.6, latency_sec=1.2)
        for text in ("Okay.", "Hmm", "Yes", "Thank you"):
            window.on_final(text)
        started = asyncio.get_running_loop().time()
        self.assertIsNone(await window.read_preloop())
        self.assertLess(asyncio.get_running_loop().time() - started, 0.2)
        window.close("test")

    async def test_a_substantive_final_is_still_waited_for(self):
        busy = "Actually I'm driving right now, call me later"
        window, _, _ = _window({busy: _busy("call me later")}, timeout=1.6, latency_sec=0.2)
        window.on_final("Okay.")
        window.on_final(busy)
        found = await window.read_preloop()
        self.assertIsNotNone(found)
        decision, text = found
        self.assertEqual(decision.intent, gate_judge.INTENT_NOT_NOW_BUSY)
        self.assertEqual(text, busy)
        window.close("test")


def _gate_turn(text, idx, *, timed):
    start = 20_000 + idx * 1000 if timed else None
    return gate_judge.GateTurn(
        text=text, utterance_idxs=(idx,), segment_start_ms=start,
        segment_end_ms=(start + 600) if timed else None,
        segment_speech_ms=600 if timed else None, final_arrival_ms=None,
        committed=True, closed_by="commit",
    )


class _FallbackAfterWaitWiring:
    """A wiring double whose judge grants, waits for the open turn, then is
    unavailable on the re-judge: `legacy()` decides on the joined reply."""

    def __init__(self):
        self.latch = gate_judge.HumanSpeechLatch()
        self.capture = types.SimpleNamespace(
            utterances=types.SimpleNamespace(all=lambda: ()))
        self._pending = ["open_segment"]

    def window(self):
        return ()

    def recording_anchor_ms(self):
        return 10_000

    def pending_speech(self, after_idx):
        return self._pending.pop(0) if self._pending else None

    async def decide(self, phase, bot_line, *, legacy, wait_for_more=None):
        await wait_for_more("open_segment")
        intent = legacy()
        return gate_judge.GateDecision(intent=intent, source=gate_judge.SOURCE_LEGACY_FALLBACK)


class TestLegacyFallbackNeverGrantsOnAnUntimedTurn(unittest.IsolatedAsyncioTestCase):
    """Round 2 (minor): after a quiescence wait, the llm-mode legacy fallback
    must not let an appended turn with no speech timing make up a grant."""

    async def _run(self, *, timed):
        turns: asyncio.Queue = asyncio.Queue()
        await turns.put(_gate_turn("yes.", 1, timed=timed))
        return await agent_mod._judge_consent_reply(
            _FallbackAfterWaitWiring(), gate_judge.PHASE_CONSENT, "line",
            text="Hello,", chosen=_gate_turn("Hello,", 0, timed=True), turns=turns,
            question_anchor=lambda: 15_000, budget=None, spoke_before=True,
        )

    async def test_an_untimed_appended_turn_does_not_complete_a_regex_grant(self):
        self.assertEqual(agent_mod.classify_answer_text("Hello, yes.", candidate_spoke=True),
                         phone.CLASSIFY_HUMAN)
        self.assertIsNone(agent_mod.classify_answer_text("Hello,", candidate_spoke=True))
        judged = await self._run(timed=False)
        self.assertIsNone(judged.decision)
        self.assertEqual(judged.text, "Hello, yes.")

    async def test_a_timed_appended_turn_still_counts(self):
        judged = await self._run(timed=True)
        self.assertEqual(judged.decision, phone.CLASSIFY_HUMAN)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
