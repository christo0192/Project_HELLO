"""M013 S01 T02: a person who spoke is never "machine"; busy is never a yes/no re-ask.

Roadmap items 2 and 3. The rule, in legacy mode (the judge arrives in T04/T05):

* the call is "machine" only when nobody was heard at all, or when the
  legacy machine wording matched while no human-directed speech had been
  heard (`gate_judge.HumanSpeechLatch`);
* busy / call-me-back goes to the pre-consent callback flow, never to a
  re-ask;
* every other exit — silence or an unreadable reply after a person spoke, a
  classifier timeout, exception or unknown verdict, the gate wall-clock
  overrun — speaks a goodbye and posts `candidate.deferred_pre_disclosure`.

All candidate text here is synthetic.
"""

from __future__ import annotations

import asyncio
import os
import pathlib
import tomllib
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests import gate_replay as gr  # installs the SDK stub (via test_phone_gate)
from tests import test_phone_gate as tpg

import agent as agent_mod  # noqa: E402
import gate_judge  # noqa: E402
import phone  # noqa: E402

_WORKER = pathlib.Path(__file__).resolve().parent.parent

_REASKS = (
    phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT,
    phone.PHONE_CONSENT_REASK_SILENCE_TEXT,
    phone.PHONE_CONSENT_REASK_QUESTION_TEXT,
)

#: Carrier / IVR / voicemail wording, romanised and Devanagari. Both nukta
#: spellings of "chhodein" (precomposed U+095C and U+0921 U+093C).
_MACHINE_GREETINGS = (
    "Please leave a message after the tone.",
    "The person you are calling is not available right now.",
    "The number you have dialled is not available right now.",
    "The number you are calling is not reachable.",
    "The subscriber you have dialled is switched off.",
    "Hi, I'm not available right now, please leave a message after the beep.",
    "Press 1 for sales.",
    "aap jis number par call kar rahe hain vah abhi uplabdh nahi hai",
    # आप जिस नंबर पर कॉल कर रहे हैं वह अभी उपलब्ध नहीं है
    "आप जिस नंबर पर "
    "कॉल कर रहे हैं",
    # कृपया संदेश छोड़ें, precomposed nukta
    "कृपया संदेश "
    "छोड़ें",
    # कृपया संदेश छोड़ें, decomposed nukta
    "कृपया संदेश "
    "छोड़ें",
    # यह नंबर अभी पहुँच से बाहर है
    "यह नंबर अभी "
    "पहुँच से बाहर "
    "है",
)

#: Ways of saying "not now" at the consent question. Each is a request for
#: another time: the callback flow, never a re-ask, never consent.
_BUSY_REPLIES = (
    "I'm in a meeting, hold on",
    "Not now",
    "Not right now, sorry",
    "Maybe later",
    "This is not a good time",
    "Can you call me back?",
    "Call me later please",
    "Sure, but I'm driving",
    "Yes, but I'm busy right now",
    "Hold on, I'm driving",
    "abhi nahi",
    "baad mein call karo",
    "Can we reschedule, I'm out somewhere",
    "Sorry, I'm not available right now",
    "I'm not available at the moment",
    "Can we do this some other time?",
    "Uh, yes. For me some other time, busy right now",
)


def _run(coro):
    return asyncio.run(coro)


class _LogSink:
    """Collects `_log.*` calls as (level, fields) for assertions."""

    def __init__(self):
        self.records: list[tuple[str, dict]] = []

    def __getattr__(self, level):
        def _emit(_event, **fields):
            self.records.append((level, fields))
        return _emit

    def of(self, error_type, error_category=None):
        return [
            f for _lvl, f in self.records
            if f.get("error_type") == error_type
            and (error_category is None or f.get("error_category") == error_category)
        ]


# ── the classifier ─────────────────────────────────────────────────────────


class TestBusyIsACallbackNeverAReask(unittest.TestCase):
    def test_every_busy_reply_routes_to_the_callback_flow(self):
        for text in _BUSY_REPLIES:
            with self.subTest(text=text):
                got = agent_mod.classify_answer_text(text)
                self.assertEqual(got, phone.CLASSIFY_CALLBACK_REQUESTED)

    def test_a_human_not_available_is_never_voicemail_even_as_the_first_words(self):
        for text in ("Sorry, I'm not available right now",
                     "I am not available at the moment",
                     "Main abhi not available right now",
                     "She's not available right now, can you call later"):
            with self.subTest(text=text):
                self.assertFalse(agent_mod._is_machine_text(text))
                self.assertNotEqual(
                    agent_mod.classify_answer_text(text, candidate_spoke=False),
                    phone.CLASSIFY_MACHINE)

    def test_negations_and_refusals_are_not_scheduled(self):
        for text in ("I'm not busy", "I am busy in the mornings but free now",
                     "I was driving yesterday"):
            with self.subTest(text=text):
                self.assertNotEqual(
                    agent_mod.classify_answer_text(text), phone.CLASSIFY_CALLBACK_REQUESTED)
        # A refusal still wins over "not now": it is the stronger reading.
        self.assertEqual(
            agent_mod.classify_answer_text("No thanks, not now"), phone.CLASSIFY_REFUSED)
        # A recording objection next to a busy phrase is never consent and is
        # not something to schedule around.
        for text in ("I'm busy, and don't record this", "Not now, and no recording"):
            with self.subTest(text=text):
                got = agent_mod.classify_answer_text(text)
                self.assertNotIn(got, (phone.CLASSIFY_HUMAN, phone.CLASSIFY_CALLBACK_REQUESTED))

    def test_questions_back_still_reask_and_are_worded_as_a_question(self):
        for text in ("Who is this?", "What is this about", "um, who is this?"):
            with self.subTest(text=text):
                self.assertIsNone(agent_mod.classify_answer_text(text))
                self.assertEqual(
                    agent_mod._consent_reask_reason(text, heard=True),
                    phone.CONSENT_REASK_QUESTION)

    def test_a_busy_reply_at_consent_gets_no_reask(self):
        async def _t():
            turns: asyncio.Queue = asyncio.Queue()
            turns.put_nowait("Hold on, I'm driving")
            said: list[str] = []

            async def say(text):
                said.append(text)

            decision = await agent_mod._classify_phone_answer(turns, say, answer_timeout_sec=0.05)
            return decision, said

        decision, said = _run(_t())
        self.assertEqual(decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertEqual(said, [])


class TestMachineOnlyWhenNobodySpoke(unittest.TestCase):
    def test_machine_and_carrier_wording_is_machine_when_nobody_spoke(self):
        for text in _MACHINE_GREETINGS:
            with self.subTest(text=text):
                self.assertTrue(agent_mod._is_machine_text(text))
                self.assertEqual(
                    agent_mod.classify_answer_text(text), phone.CLASSIFY_MACHINE)

    def test_machine_wording_never_decides_once_a_person_spoke(self):
        for text in _MACHINE_GREETINGS + ("voice mail is full", "press 2 to repeat"):
            with self.subTest(text=text):
                self.assertNotEqual(
                    agent_mod.classify_answer_text(text, candidate_spoke=True),
                    phone.CLASSIFY_MACHINE)

    def test_the_latch_changes_only_the_machine_branch(self):
        for text in ("Yes, go ahead.", "No thanks.", "Don't call me again.",
                     "Wrong number.", "I'm busy", "Who is this?"):
            with self.subTest(text=text):
                self.assertEqual(
                    agent_mod.classify_answer_text(text, candidate_spoke=True),
                    agent_mod.classify_answer_text(text))


class TestReaskWording(unittest.TestCase):
    def test_the_yes_or_no_demand_is_gone_from_the_worker(self):
        for name in ("phone.py", "agent.py"):
            with self.subTest(file=name):
                source = (_WORKER / name).read_text(encoding="utf-8")
                self.assertNotIn("I just need a yes or a no", source)
        self.assertFalse(hasattr(phone, "PHONE_REASK_TEXT"))

    def test_reasons_map_to_their_lines(self):
        cases = (
            ("", False, phone.CONSENT_REASK_SILENCE),
            ("", True, phone.CONSENT_REASK_UNCLEAR),
            ("Right.", True, phone.CONSENT_REASK_UNCLEAR),
            ("Sorry, what?", True, phone.CONSENT_REASK_QUESTION),
            ("What is this regarding", True, phone.CONSENT_REASK_QUESTION),
        )
        for text, heard, want in cases:
            with self.subTest(text=text, heard=heard):
                self.assertEqual(agent_mod._consent_reask_reason(text, heard=heard), want)
        self.assertEqual(phone.phone_consent_reask_text(phone.CONSENT_REASK_SILENCE),
                         phone.PHONE_CONSENT_REASK_SILENCE_TEXT)
        self.assertEqual(phone.phone_consent_reask_text("nonsense"),
                         phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT)

    def test_the_new_lines_are_gate_copy_and_say_nothing_about_being_an_AI(self):
        for text in _REASKS + (phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT,):
            with self.subTest(text=text):
                self.assertTrue(phone.is_gate_copy(text))
                self.assertNotIn("AI", text)
                self.assertNotIn("assistant", text.lower())
                self.assertNotIn("yes or a no", text)
        for text in _REASKS:
            with self.subTest(text=text):
                self.assertTrue(text.endswith("?"))
                self.assertIn("record", text.lower())
        self.assertIn(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE,
                      phone.PHONE_CONSENT_REASK_QUESTION_TEXT)
        self.assertNotIn("?", phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT)

    def test_the_disclosure_wording_is_untouched(self):
        # Owner constraint 2: T02 changes gate copy only.
        self.assertEqual(
            phone.PHONE_DISCLOSURE_RECORDING_SENTENCE,
            "This call is recorded so the hiring team can review it.")
        self.assertTrue(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT.endswith(
            "This call is recorded so the hiring team can review it. Is it okay to continue?"))


# ── the latch ──────────────────────────────────────────────────────────────


class TestHumanSpeechLatch(unittest.TestCase):
    def test_latch_basics(self):
        latch = gate_judge.HumanSpeechLatch()
        self.assertFalse(latch.spoke)
        self.assertFalse(latch.note_reply("", machine_match=False, source="identity"))
        self.assertFalse(latch.note_reply("Leave a message", machine_match=True, source="identity"))
        self.assertTrue(latch.note_reply("Hello", machine_match=False, source="identity"))
        self.assertFalse(latch.mark("consent"), "the first source wins")
        self.assertEqual(latch.source, "identity")

    def _identity_read(self, items, *, question_ms=None):
        async def _t():
            turns: asyncio.Queue = asyncio.Queue()
            for item in items:
                turns.put_nowait(item)
            latch = gate_judge.HumanSpeechLatch()
            with patch.object(agent_mod, "_log", _LogSink()):
                reply = await agent_mod._read_fresh_turn(
                    turns, lambda: question_ms, 0.05, spoke=latch)
            return reply, latch

        return _run(_t())

    def test_the_identity_reply_of_a_person_sets_it(self):
        reply, latch = self._identity_read(["Hello?"])
        self.assertEqual(reply, "Hello?")
        self.assertTrue(latch.spoke)
        self.assertEqual(latch.source, gate_judge.SPOKE_SOURCE_IDENTITY)

    def test_a_voicemail_greeting_at_identity_does_not_set_it(self):
        for text in _MACHINE_GREETINGS:
            with self.subTest(text=text):
                _reply, latch = self._identity_read([text])
                self.assertFalse(latch.spoke)

    def test_a_stale_reply_does_not_set_it(self):
        reply, latch = self._identity_read([("Hello?", 1_000)], question_ms=2_000)
        self.assertEqual(reply, "")
        self.assertFalse(latch.spoke)

    def _consent(self, items, *, latch=None, timeout=0.05):
        async def _t():
            turns: asyncio.Queue = asyncio.Queue()
            for item in items:
                turns.put_nowait(item)
            said: list[str] = []

            async def say(text):
                said.append(text)

            sink = _LogSink()
            with patch.object(agent_mod, "_log", sink):
                decision = await agent_mod._classify_phone_answer(
                    turns, say, answer_timeout_sec=timeout, spoke=latch)
            return decision, said, sink

        return _run(_t())

    def test_silence_at_consent_after_a_person_spoke_is_a_deferral(self):
        latch = gate_judge.HumanSpeechLatch()
        latch.mark(gate_judge.SPOKE_SOURCE_IDENTITY)
        decision, said, sink = self._consent([], latch=latch)
        self.assertEqual(decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(said, [phone.PHONE_CONSENT_REASK_SILENCE_TEXT])
        self.assertEqual(sink.of("phone_classify_fallback_machine"), [])
        logged = sink.of("phone_classify_fallback_deferral", "no_speech_after_spoke")
        self.assertEqual(len(logged), 1)
        self.assertEqual(logged[0]["phase"], gate_judge.SPOKE_SOURCE_IDENTITY)

    def test_silence_on_a_line_where_nobody_spoke_is_still_machine(self):
        decision, said, sink = self._consent([], latch=gate_judge.HumanSpeechLatch())
        self.assertEqual(decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(said, [phone.PHONE_CONSENT_REASK_SILENCE_TEXT])
        self.assertEqual(len(sink.of("phone_classify_fallback_machine", "no_speech")), 1)

    def test_a_voicemail_greeting_at_consent_is_machine_without_a_reask(self):
        decision, said, _ = self._consent(
            ["Please leave a message after the beep."], latch=gate_judge.HumanSpeechLatch())
        self.assertEqual(decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(said, [])

    def test_an_unreadable_reply_sets_the_latch_and_defers(self):
        latch = gate_judge.HumanSpeechLatch()
        decision, said, sink = self._consent(["Hmm.", "Right."], latch=latch)
        self.assertEqual(decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(latch.source, gate_judge.SPOKE_SOURCE_CONSENT)
        self.assertEqual(said, [phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT])
        self.assertEqual(len(sink.of("phone_classify_fallback_deferral", "responsive_unmatched")), 1)

    def test_after_a_person_spoke_machine_words_are_not_machine(self):
        latch = gate_judge.HumanSpeechLatch()
        latch.mark(gate_judge.SPOKE_SOURCE_IDENTITY)
        decision, _said, _ = self._consent(
            ["Do I press 1 or something?", "voice mail"], latch=latch)
        self.assertNotEqual(decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)

    def test_a_late_yes_after_the_reask_still_grants(self):
        latch = gate_judge.HumanSpeechLatch()
        decision, said, _ = self._consent(["Sorry, what?", "Yes, go ahead."], latch=latch)
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(said, [phone.PHONE_CONSENT_REASK_QUESTION_TEXT])


# ── end to end through the real gate ───────────────────────────────────────


class _Gate:
    """`run_phone_gate` with the REAL readers on one queue and one latch."""

    def __init__(self, replies, *, confirm=True, say_gone_on=None):
        self.queue: asyncio.Queue = asyncio.Queue()
        for reply in replies:
            self.queue.put_nowait(reply)
        self.latch = gate_judge.HumanSpeechLatch()
        self.spoken: list[str] = []
        self.events: list[str] = []
        self.phases: dict = {}
        self.consumed: list[str] = []
        self.say_gone_on = say_gone_on
        proposal = phone.CallbackProposal({
            "starts_at": "2026-10-07T05:30:00Z", "ends_at": "2026-10-07T05:45:00Z",
            "weekday": "Wednesday", "ist_date": "2026-10-07", "ist_time": "11:00",
            "time_zone": "Asia/Kolkata",
        })

        async def post(_attempt, event, **_kw):
            self.events.append(event)
            return phone.PhoneApiOutcome(True, "applied")

        self.client = types.SimpleNamespace(
            post_event=post,
            propose_callback=AsyncMock(return_value=(
                phone.PhoneApiOutcome(True, "proposal_valid"), proposal)),
            confirm_callback=AsyncMock(return_value=phone.PhoneApiOutcome(
                confirm, "ok" if confirm else None)),
            consent_and_start_assessment=AsyncMock(side_effect=AssertionError("must not screen")),
        )

    async def say(self, text):
        self.spoken.append(text)
        if self.say_gone_on is not None and text == self.say_gone_on:
            raise phone.PhoneParticipantGone("synthetic hang-up")

    async def next_turn(self):
        return await agent_mod._read_fresh_turn(
            self.queue, lambda: None, 0.02, spoke=self.latch)

    async def next_callback_turn(self):
        return await agent_mod._read_fresh_turn(
            self.queue, lambda: None, 0.02, spoke=self.latch,
            spoke_source=gate_judge.SPOKE_SOURCE_CALLBACK)

    async def classify(self):
        return await agent_mod._classify_phone_answer(
            self.queue, self.say, consumed=self.consumed, answer_timeout_sec=0.02,
            spoke=self.latch)

    async def run(self, *, flow="conversational", classify=None):
        async def infer(_prompt):
            return "unclear"

        with patch.dict(os.environ, {"PHONE_GATE_FLOW": flow}), \
                patch.object(phone, "_default_phone_identity_inference", infer):
            return await phone.run_phone_gate(
                attempt_id="synthetic-attempt", client=self.client,
                wait_for_participant=AsyncMock(return_value=object()),
                classify=classify or self.classify, say=self.say,
                post_call_answered=True,
                next_candidate_turn=self.next_turn,
                next_callback_turn=self.next_callback_turn,
                consent_reply_out=self.consumed,
                classify_gate_reply=agent_mod.classify_answer_text,
                gate_phase_out=self.phases, candidate_name="Kiran Example",
                session_id="synthetic-session", epoch=1,
            )


class TestGateNeverMachineAfterSpeech(unittest.IsolatedAsyncioTestCase):
    def _assert_spoken_deferral(self, g, result):
        self.assertEqual(result.outcome, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)
        self.assertNotIn("classify.machine", g.events)
        self.assertNotIn("classify.human", g.events)
        self.assertNotIn("disclosure.delivered", g.events)
        self.assertEqual(g.events.count("candidate.deferred_pre_disclosure"), 1)
        self.assertEqual(g.spoken[-1], phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT)
        g.client.consent_and_start_assessment.assert_not_awaited()

    async def test_a_spoken_identity_reply_then_silence_at_consent_is_a_goodbye(self):
        """The 32757295 silent-consent variant, end to end."""
        g = _Gate(["Hello"])
        result = await g.run()
        self._assert_spoken_deferral(g, result)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, g.spoken)
        self.assertIn(phone.PHONE_CONSENT_REASK_SILENCE_TEXT, g.spoken)
        self.assertEqual(g.latch.source, gate_judge.SPOKE_SOURCE_IDENTITY)

    async def test_an_unreadable_consent_reply_is_a_goodbye_not_machine(self):
        g = _Gate(["Yes, this is Kiran", "Hmm.", "Right."])
        result = await g.run()
        self._assert_spoken_deferral(g, result)
        self.assertIn(phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT, g.spoken)

    async def test_a_voicemail_greeting_at_identity_then_silence_is_still_machine(self):
        g = _Gate(["Hi, I'm not available right now, please leave a message after the beep."])
        result = await g.run()
        self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)
        self.assertIn("classify.machine", g.events)
        self.assertNotIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, g.spoken)
        self.assertFalse(g.latch.spoke)

    async def test_an_indian_carrier_message_at_identity_then_silence_is_still_machine(self):
        for greeting in ("The number you are calling is not reachable.",
                         "aap jis number par call kar rahe hain vah abhi uplabdh nahi hai"):
            with self.subTest(greeting=greeting):
                g = _Gate([greeting])
                result = await g.run()
                self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)
                self.assertFalse(g.latch.spoke)

    async def test_nobody_at_all_is_still_machine(self):
        for flow in ("conversational", "deterministic"):
            with self.subTest(flow=flow):
                g = _Gate([])
                result = await g.run(flow=flow)
                self.assertEqual(result.outcome, phone.CLASSIFY_MACHINE)
                self.assertNotIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, g.spoken)

    async def test_a_human_not_available_first_utterance_is_never_voicemail(self):
        g = _Gate(["Sorry, I'm not available right now"])
        result = await g.run()
        self.assertNotEqual(result.outcome, phone.CLASSIFY_MACHINE)
        self.assertNotIn("classify.machine", g.events)
        self.assertIn("candidate.deferred_pre_disclosure", g.events)
        # It was the callback flow, which asked for a time, not a yes/no re-ask.
        self.assertFalse(any(r in g.spoken for r in _REASKS))
        self.assertTrue(phone.is_gate_copy(g.spoken[-1]), g.spoken[-1])

    async def test_busy_at_consent_books_the_callback_and_reads_it_back(self):
        """The 32757295 replay, legacy mode: busy -> time -> booked, no re-ask."""
        g = _Gate(["Hello", "I am busy right now", "tomorrow at 11 am"])
        result = await g.run()
        self.assertEqual(result.outcome, phone.HALT_CALLBACK_SCHEDULED)
        g.client.confirm_callback.assert_awaited_once()
        self.assertNotIn("classify.machine", g.events)
        self.assertFalse(any(r in g.spoken for r in _REASKS))
        self.assertTrue(g.spoken[-1].startswith(phone._CALLBACK_BOOKED_PREFIX), g.spoken[-1])

    async def test_busy_at_consent_then_silence_ends_with_a_goodbye(self):
        g = _Gate(["Hello", "I am busy right now"])
        result = await g.run()
        self.assertNotEqual(result.outcome, phone.CLASSIFY_MACHINE)
        self.assertNotIn("classify.machine", g.events)
        self.assertEqual(g.events.count("candidate.deferred_pre_disclosure"), 1)
        self.assertFalse(any(r in g.spoken for r in _REASKS))
        self.assertIn(g.spoken[-1], (phone.PHONE_CALLBACK_DEFERRAL_TEXT,
                                     phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT))

    async def test_busy_phrasings_at_consent_never_reask_in_either_flow(self):
        for flow in ("conversational", "deterministic"):
            for busy in ("Not a good time right now", "Maybe later", "Can you call me back?"):
                with self.subTest(flow=flow, busy=busy):
                    replies = (["Hello"] if flow == "conversational" else []) + [busy]
                    g = _Gate(replies)
                    result = await g.run(flow=flow)
                    self.assertNotEqual(result.outcome, phone.CLASSIFY_MACHINE)
                    self.assertFalse(any(r in g.spoken for r in _REASKS))
                    self.assertTrue(g.client.propose_callback.await_count
                                    or "candidate.deferred_pre_disclosure" in g.events)

    async def test_timeout_exception_and_unknown_verdicts_are_spoken_deferrals(self):
        async def hang():
            await asyncio.sleep(5)

        async def boom():
            raise RuntimeError("synthetic")

        async def unknown():
            return "definitely-not-a-verdict"

        async def callback_without_reply():
            return phone.CLASSIFY_CALLBACK_REQUESTED

        cases = (("timeout", hang), ("exception", boom), ("unknown", unknown),
                 ("callback_without_reply", callback_without_reply))
        for label, classify in cases:
            with self.subTest(case=label):
                g = _Gate(["Hello"])
                with patch.object(phone, "phone_classify_timeout_sec", lambda: 0.05):
                    result = await g.run(classify=classify)
                self._assert_spoken_deferral(g, result)

    async def test_a_hangup_during_the_goodbye_posts_one_terminal(self):
        g = _Gate(["Hello"], say_gone_on=phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT)
        result = await g.run()
        self._assert_spoken_deferral(g, result)


# ── the consent backstop ───────────────────────────────────────────────────


class TestConsentBackstop(unittest.TestCase):
    _KEYS = ("PHONE_CLASSIFY_TIMEOUT_SEC", "PHONE_CLASSIFY_ANSWER_TIMEOUT_SEC",
             "PHONE_GATE_JUDGE_TIMEOUT_SEC")

    def _with(self, **values):
        saved = {k: os.environ.get(k) for k in self._KEYS}
        for key in self._KEYS:
            os.environ.pop(key, None)
        os.environ.update({k: v for k, v in values.items()})
        self.addCleanup(self._restore, saved)

    @staticmethod
    def _restore(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_the_derived_floor_with_defaults(self):
        self._with()
        self.assertAlmostEqual(phone.phone_classify_backstop_floor_sec(),
                               2 * (15.0 + 6.0 + 2.5) + 5.0)
        self.assertAlmostEqual(phone.phone_classify_timeout_sec(), 52.0)

    def test_the_fly_phone_toml_value_cannot_cut_a_consent_read_short(self):
        toml = tomllib.loads((_WORKER / "fly.phone.toml").read_text(encoding="utf-8"))
        configured = toml["env"].get("PHONE_CLASSIFY_TIMEOUT_SEC")
        self._with(**({"PHONE_CLASSIFY_TIMEOUT_SEC": configured} if configured else {}))
        effective = phone.phone_classify_timeout_sec()
        self.assertGreaterEqual(effective, phone.phone_classify_backstop_floor_sec())
        # Two full answer windows plus a re-ask and a judge call per attempt.
        self.assertGreater(effective, 2 * phone.phone_classify_answer_timeout_sec() + 6.0)

    def test_an_explicit_value_can_only_raise_it(self):
        self._with(PHONE_CLASSIFY_TIMEOUT_SEC="90")
        self.assertEqual(phone.phone_classify_timeout_sec(), 90.0)
        self._with(PHONE_CLASSIFY_TIMEOUT_SEC="5")
        self.assertAlmostEqual(phone.phone_classify_timeout_sec(),
                               phone.phone_classify_backstop_floor_sec())

    def test_the_floor_tracks_the_answer_window_and_judge_timeout(self):
        self._with(PHONE_CLASSIFY_ANSWER_TIMEOUT_SEC="20", PHONE_GATE_JUDGE_TIMEOUT_SEC="4")
        self.assertAlmostEqual(phone.phone_classify_backstop_floor_sec(),
                               2 * (20.0 + 6.0 + 4.0) + 5.0)

    def test_the_judge_timeout_reader_is_bounded(self):
        for raw, want in (("0.1", 1.0), ("9", 4.0), ("2", 2.0), ("nan", 2.5),
                          ("junk", 2.5), ("", 2.5)):
            with self.subTest(raw=raw):
                self._with(PHONE_GATE_JUDGE_TIMEOUT_SEC=raw)
                self.assertEqual(gate_judge.judge_timeout_sec(), want)

    def test_the_gate_wall_clock_still_covers_the_backstop(self):
        self._with()
        self.assertGreater(agent_mod.PHONE_GATE_MAX_SECONDS,
                           phone.phone_classify_timeout_sec())


# ── the gate wall-clock overrun ───────────────────────────────────────────


class TestOverrunGoodbye(unittest.IsolatedAsyncioTestCase):
    async def test_interrupts_then_speaks(self):
        order: list[str] = []

        class Session:
            def interrupt(self, *, force=False):
                order.append(f"interrupt:{force}")
                fut = asyncio.get_running_loop().create_future()
                fut.set_result(None)
                return fut

        async def say(text):
            order.append(f"say:{text}")

        with patch.object(agent_mod, "_log", _LogSink()):
            outcome = await agent_mod._speak_gate_goodbye_bounded(Session(), say, "bye")
        self.assertEqual(outcome, "spoken")
        self.assertEqual(order, ["interrupt:True", "say:bye"])

    async def test_is_bounded_and_never_raises(self):
        async def hang(_text):
            await asyncio.sleep(3600)

        async def broken(_text):
            raise RuntimeError("AgentSession isn't running")

        class BadInterrupt:
            def interrupt(self, *, force=False):
                raise RuntimeError("AgentSession isn't running")

        sink = _LogSink()
        with patch.object(agent_mod, "_log", sink):
            loop = asyncio.get_running_loop()
            started = loop.time()
            self.assertEqual(await agent_mod._speak_gate_goodbye_bounded(
                object(), hang, "bye", timeout_sec=0.05), "timeout")
            self.assertLess(loop.time() - started, 1.0)
            self.assertEqual(await agent_mod._speak_gate_goodbye_bounded(
                object(), broken, "bye"), "failed")
            said: list[str] = []

            async def ok(text):
                said.append(text)

            self.assertEqual(await agent_mod._speak_gate_goodbye_bounded(
                BadInterrupt(), ok, "bye"), "spoken")
            self.assertEqual(said, ["bye"])
        categories = [f["error_category"] for f in sink.of("phone_gate_overrun_goodbye")]
        self.assertEqual(categories, ["timeout", "failed", "spoken"])

    async def test_the_in_flight_gate_line_is_interrupted_and_drained_first(self):
        order: list[str] = []

        class Speech:
            def interrupt(self, *, force=False):
                order.append(f"speech_interrupt:{force}")

            async def wait_for_playout(self):
                order.append("drained")

        async def say(text):
            order.append(f"say:{text}")

        with patch.object(agent_mod, "_log", _LogSink()):
            outcome = await agent_mod._speak_gate_goodbye_bounded(
                object(), say, "bye", pending_speech=Speech())
        self.assertEqual(outcome, "spoken")
        self.assertEqual(order, ["speech_interrupt:True", "drained", "say:bye"])

    async def test_a_WEDGED_playout_skips_the_goodbye_quickly(self):
        # A line still playing after a forced interrupt is a wedge; a goodbye
        # queued behind it would wedge too, so it is skipped, not awaited.
        class Wedged:
            def interrupt(self, *, force=False):
                return self

            async def wait_for_playout(self):
                await asyncio.Event().wait()

        said: list[str] = []

        async def say(text):
            said.append(text)

        sink = _LogSink()
        with patch.object(agent_mod, "_log", sink):
            loop = asyncio.get_running_loop()
            started = loop.time()
            outcome = await agent_mod._speak_gate_goodbye_bounded(
                object(), say, "bye", pending_speech=Wedged(), drain_sec=0.05)
        self.assertEqual(outcome, "skipped_wedged")
        self.assertEqual(said, [])
        self.assertLess(loop.time() - started, 1.0)
        self.assertEqual(len(sink.of("phone_gate_overrun_goodbye", "skipped_wedged")), 1)

    async def test_the_goodbye_fits_its_bound(self):
        # ~15 characters a second of TTS: the line must play inside the bound.
        self.assertLessEqual(len(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT) / 15.0,
                             agent_mod._GATE_GOODBYE_BOUND_SEC + 1.0)

    async def test_a_cancellation_is_not_swallowed(self):
        async def hang(_text):
            await asyncio.sleep(3600)

        with patch.object(agent_mod, "_log", _LogSink()):
            task = asyncio.ensure_future(
                agent_mod._speak_gate_goodbye_bounded(object(), hang, "bye", timeout_sec=10))
            await asyncio.sleep(0.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task


class TestOverrunGoodbyeInTheSession(unittest.IsolatedAsyncioTestCase):
    """The wedged gate, through the real `_run_phone_session` harness."""

    setUp = tpg.TestPhoneSessionFlow.setUp
    _run_session = tpg.TestPhoneSessionFlow._run_session

    async def _wedged(self, phases: dict):
        async def _never_returns(*_a, **kw):
            out = kw.get("gate_phase_out")
            if isinstance(out, dict):
                out.update(phases)
            await asyncio.sleep(3600)

        with patch.object(agent_mod, "PHONE_GATE_MAX_SECONDS", 0.05), \
                patch.object(agent_mod.phone, "phone_participant_wait_sec", lambda: 0.0), \
                patch.object(agent_mod.phone, "phone_bounce_mode", lambda: False), \
                patch.object(phone, "run_phone_gate", _never_returns):
            result, client, _rec, _delete, session, _spy = await self._run_session(
                answers=("Yes, that's fine.",), close_after=False)
        return result, client, session

    async def test_a_wedged_gate_says_goodbye_before_teardown(self):
        result, client, session = await self._wedged({})
        self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
        self.assertIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, session.spoken)
        self.assertIn("candidate.deferred_pre_disclosure", client.event_types)
        self.assertNotIn("classify.machine", client.event_types)

    async def test_nothing_is_spoken_after_durable_consent(self):
        _result, _client, session = await self._wedged({"consent_durable": True})
        self.assertNotIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, session.spoken)

    async def test_nothing_is_spoken_before_the_call_was_answered(self):
        _result, _client, session = await self._wedged({"answer_seam": True})
        self.assertNotIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, session.spoken)

    async def test_spoken_once_the_call_was_answered(self):
        _result, _client, session = await self._wedged(
            {"answer_seam": True, "answer_observed": True})
        self.assertIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, session.spoken)

    async def test_nothing_is_spoken_after_a_terminal_already_posted(self):
        _result, _client, session = await self._wedged({"terminal_posted": True})
        self.assertNotIn(phone.PHONE_GATE_DEFERRAL_GOODBYE_TEXT, session.spoken)


# ── the replay ─────────────────────────────────────────────────────────────


class TestReplay32757295NeverMachine(unittest.TestCase):
    """The real 32757295 timeline on the real readers (legacy mode)."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = gr.load_fixture("32757295")
        cls.busy = gr.replay(cls.fixture)
        consent = cls.fixture.lines_of("consent")[0]
        cls.silent = gr.replay(cls.fixture.candidate_silent_after(consent.ask_ms))

    def test_busy_goes_to_the_callback_flow_without_a_reask(self):
        self.assertEqual(self.busy.decision, phone.CLASSIFY_CALLBACK_REQUESTED)
        self.assertNotIn("reask", self.busy.spoken_kinds())
        self.assertEqual(self.busy.logs_of("phone_classify_fallback_machine"), [])

    def test_silence_after_the_spoken_identity_reply_defers(self):
        self.assertEqual(self.silent.decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(self.silent.spoken[-1].text, phone.PHONE_CONSENT_REASK_SILENCE_TEXT)
        self.assertEqual(self.silent.leaked_text_in_logs(), [])


if __name__ == "__main__":
    unittest.main()
