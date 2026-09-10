"""The conversational gate (0095) — the identity turn before consent.

WHAT THIS IS GUARDING AGAINST. On 2026-09-09 a model folded an identity
question onto the end of the consent opening. The candidate answered the
identity ("yes, this is Christo"), the strict consent classifier could not read
that as consent, and the gate timed out to MACHINE and tore the call down. The
whole LLM opener was switched off in response.

The lesson was not "never ask who you are speaking to" — it was ONE QUESTION
GETS ONE CLASSIFIER. So the assertions below are mostly about separation: that
the identity answer never reaches the consent parser, that the identity question
can never carry a consent ask, and that a line already SPOKEN is repaired rather
than restarted.

The second theme is the asymmetry of the two fail-safe directions. Consent fails
CLOSED (unreadable ⇒ do not proceed). Identity fails OPEN (unreadable ⇒ keep
talking), because hanging up on the actual applicant is far more costly than one
wasted screening.

THESE TESTS DRIVE `run_phone_gate` ITSELF. The predecessor tested helper
functions in isolation and asserted nothing about the gate; both of the defects
that blocked this branch (a classifier that let the wrong person through, and
two readers sharing one queue) lived on paths no test executed, which is why CI
was green while the feature was unshippable.
"""

import asyncio
import os
import types
import unittest
from unittest import mock

import phone


NAME = "Priya Sharma"


def _run(coro):
    """Drive one coroutine to completion.

    `asyncio.run`, not `get_event_loop` — the latter raises on Python 3.14,
    which is what the container runs.
    """
    return asyncio.run(coro)


def _verdict(value):
    """An `infer` that returns one fixed verdict word."""
    async def _infer(_prompt):
        return value
    return _infer


class TestIdentityLineShape(unittest.TestCase):
    """`_identity_line_asks_identity` — does the spoken line END on the ask?"""

    def test_a_line_ending_on_the_identity_question_passes(self):
        for text in (
            "Hi, this is Christy calling about your application. Am I speaking to Priya?",
            "Hello! Christy here from the hiring team — have I reached the right person?",
        ):
            self.assertTrue(phone._identity_line_asks_identity(text), text)

    def test_a_folded_consent_ask_is_rejected(self):
        # THE 2026-09-09 INCIDENT WITH THE ROLES REVERSED. If the identity line
        # ends on the consent question, the identity classifier reads an answer
        # that was about recording.
        self.assertFalse(phone._identity_line_asks_identity(
            "Hi, this is Christy. Am I speaking to Priya, and is it okay to continue?"))

    def test_a_line_that_does_not_end_on_a_question_is_rejected(self):
        self.assertFalse(phone._identity_line_asks_identity(
            "Am I speaking to Priya? Great, let me tell you why I'm calling."))
        self.assertFalse(phone._identity_line_asks_identity("Hi Priya, good to reach you."))

    def test_empty_and_non_string_are_rejected(self):
        for bad in (None, "", "   ", 42, [], {}):
            self.assertFalse(phone._identity_line_asks_identity(bad), repr(bad))


class TestIdentityClassifier(unittest.TestCase):
    """`phone_classify_identity` — the LLM verdict, and its two safety rails.

    Every case the REGEX predecessor got wrong is listed here explicitly, so a
    future regression back to pattern matching fails loudly. Those were not
    hypotheticals: each was reproduced by executing the old code.
    """

    def test_it_returns_the_models_verdict(self):
        for word in ("self", "other_person", "unavailable", "unclear"):
            self.assertEqual(
                _run(phone.phone_classify_identity("anything", NAME, infer=_verdict(word))),
                word,
            )

    def test_a_verdict_embedded_in_prose_is_still_read(self):
        self.assertEqual(
            _run(phone.phone_classify_identity(
                "no, wrong number", NAME, infer=_verdict("The answer is other_person."))),
            phone.PHONE_IDENTITY_OTHER,
        )

    def test_every_failure_mode_fails_open_to_unclear(self):
        async def _raises(_p):
            raise RuntimeError("provider down")

        async def _none(_p):
            return None

        async def _garbage(_p):
            return "I'm not sure what you mean"

        async def _wrong_type(_p):
            return 17

        for infer in (_raises, _none, _garbage, _wrong_type):
            self.assertEqual(
                _run(phone.phone_classify_identity("hello?", NAME, infer=infer)),
                phone.PHONE_IDENTITY_UNCLEAR,
                infer.__name__,
            )

    def test_an_empty_reply_never_reaches_the_model(self):
        called = []

        async def _spy(prompt):
            called.append(prompt)
            return "other_person"

        for empty in (None, "", "   ", 0, []):
            self.assertEqual(
                _run(phone.phone_classify_identity(empty, NAME, infer=_spy)),
                phone.PHONE_IDENTITY_UNCLEAR,
                repr(empty),
            )
        self.assertEqual(called, [], "silence must not cost a classifier call")

    def test_the_prompt_carries_the_first_name_and_the_reply_and_nothing_else(self):
        seen = []

        async def _spy(prompt):
            seen.append(prompt)
            return "self"

        _run(phone.phone_classify_identity("Yes, speaking.", NAME, infer=_spy))
        self.assertEqual(len(seen), 1)
        self.assertIn("Priya", seen[0])
        self.assertIn("Yes, speaking.", seen[0])
        self.assertNotIn("Sharma", seen[0], "the record's surname is not needed")

    def test_a_long_reply_is_bounded_before_it_reaches_the_model(self):
        seen = []

        async def _spy(prompt):
            seen.append(prompt)
            return "self"

        _run(phone.phone_classify_identity("x" * 5000, NAME, infer=_spy))
        self.assertLess(len(seen[0]), 1200, "an unbounded reply is a cost and an injection surface")

    def test_the_record_name_spoken_back_cannot_be_called_another_person(self):
        # THE REGRESSION THAT BLOCKED THIS BRANCH. `_IDENTITY_DENY_RE` hung up on
        # a candidate CORRECTING the bot, and `candidate.wrong_number` wrote a
        # permanent line-level DNC. Here the model is FORCED to say other_person
        # and the deterministic backstop must still keep the call alive.
        self.assertEqual(
            _run(phone.phone_classify_identity(
                "No no, this is Priya only.", NAME, infer=_verdict("other_person"))),
            phone.PHONE_IDENTITY_SELF,
        )

    def test_the_backstop_does_not_rescue_a_third_party(self):
        # The other half of the backstop's condition. "I am her father" extracts
        # NO name, so there is no record evidence to overrule the model with —
        # verified by execution: `phone_extract_introduced_name` fires on
        # "this is X" shapes, not on a bare "I am X". A backstop written as
        # "mismatch is None → self" would swallow all of these.
        for reply in (
            "I am her father, she is not available.",
            "Sorry, wrong number.",
            "There is nobody by that name here.",
            "I'm Ravi.",
        ):
            self.assertEqual(
                _run(phone.phone_classify_identity(
                    reply, NAME, infer=_verdict("other_person"))),
                phone.PHONE_IDENTITY_OTHER,
                reply,
            )

    def test_a_different_name_spoken_back_stays_other_person(self):
        self.assertEqual(
            _run(phone.phone_classify_identity(
                "No, this is Ravi.", NAME, infer=_verdict("other_person"))),
            phone.PHONE_IDENTITY_OTHER,
        )


class TestGateFlowFlag(unittest.TestCase):
    """The rollback contract: default OFF, and the exact tokens that turn it on."""

    def setUp(self):
        self._saved = {
            k: os.environ.get(k) for k in (
                "PHONE_GATE_FLOW", "PHONE_IDENTITY_MISMATCH_SUPPRESSES",
            )
        }
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_unset_is_deterministic(self):
        self.assertEqual(phone.phone_gate_flow(), "deterministic")

    def test_only_the_exact_token_enables_it(self):
        for raw in ("conversational", "  Conversational  ", "CONVERSATIONAL"):
            os.environ["PHONE_GATE_FLOW"] = raw
            self.assertEqual(phone.phone_gate_flow(), "conversational", raw)
        for raw in ("", "yes", "true", "1", "convo", "deterministic"):
            os.environ["PHONE_GATE_FLOW"] = raw
            self.assertEqual(phone.phone_gate_flow(), "deterministic", raw)

    def test_suppression_is_off_unless_explicitly_enabled(self):
        self.assertFalse(phone.phone_identity_mismatch_suppresses())
        for raw in ("false", "0", "no", "off", "", "maybe"):
            os.environ["PHONE_IDENTITY_MISMATCH_SUPPRESSES"] = raw
            self.assertFalse(phone.phone_identity_mismatch_suppresses(), raw)
        for raw in ("true", "1", "YES", " on "):
            os.environ["PHONE_IDENTITY_MISMATCH_SUPPRESSES"] = raw
            self.assertTrue(phone.phone_identity_mismatch_suppresses(), raw)


class TestFixedFallbackCopy(unittest.TestCase):
    """The lines spoken when the model authors nothing."""

    def test_it_names_us_before_it_asks_for_them(self):
        line = phone.phone_identity_text(NAME)
        self.assertLess(line.index("Christy"), line.index("Priya"))
        self.assertIn("Priya", line)
        self.assertNotIn("Sharma", line, "a full legal name reads as a debt collector")

    def test_no_gate_line_before_consent_mentions_recording(self):
        # Recording belongs to the consent turn. A disclosure that arrives one
        # turn early is a disclosure the candidate did not consent to yet — and
        # it may be read to somebody who is not the candidate at all.
        for line in (phone.phone_identity_text(NAME),
                     phone.phone_identity_text(None),
                     phone.phone_identity_reask_text(NAME),
                     phone.phone_identity_reask_text(None),
                     phone.phone_identity_repair_text(NAME),
                     phone.phone_identity_repair_text(None),
                     phone.phone_identity_instruction(NAME),
                     phone.phone_identity_reask_instruction(NAME)):
            self.assertNotIn("recorded", line.lower(), line)

    def test_the_reask_is_a_closed_question_and_does_not_accuse(self):
        line = phone.phone_identity_reask_text(NAME)
        self.assertTrue(line.rstrip().endswith("?"))
        self.assertIn("Priya", line)

    def test_the_repair_line_does_not_introduce_us_a_second_time(self):
        # THE #279 "double-Hi" CLASS. The repair is appended to a line the
        # candidate has ALREADY heard, so it must not restart the greeting.
        for repair in (phone.phone_identity_repair_text(NAME),
                       phone.phone_identity_repair_text(None)):
            self.assertNotIn("Christy", repair, repair)
            self.assertNotIn("AI voice assistant", repair, repair)
            self.assertTrue(repair.rstrip().endswith("?"), repair)
        self.assertTrue(
            phone._identity_line_asks_identity(phone.phone_identity_repair_text(NAME)))

    def test_the_fixed_lines_are_valid_identity_asks(self):
        for line in (phone.phone_identity_text(NAME), phone.phone_identity_text(None),
                     phone.phone_identity_reask_text(NAME),
                     phone.phone_identity_reask_text(None)):
            self.assertTrue(phone._identity_line_asks_identity(line), line)


class _GateHarness:
    """Drives the REAL `run_phone_gate` with recording seams.

    Everything the gate needs is a callable, by design — the gate owns the
    ORDER and `agent.py` owns the machinery — so the turn sequence can be
    asserted end-to-end without a LiveKit session.
    """

    def __init__(self, *, replies, verdicts, generated=None):
        self.spoken: list[str] = []
        self.events: list[str] = []
        self.committed: list[list[dict]] = []
        self.queue: list[str] = list(replies)
        self.verdicts: list[str] = list(verdicts)
        self.generated = generated
        self.classify_calls = 0

    # -- the shared STT FIFO, and the drain that gives each question its own --
    async def next_candidate_turn(self) -> str:
        return self.queue.pop(0) if self.queue else ""

    def reset_turn_buffer(self) -> None:
        self.queue = [t for t in self.queue if not t.startswith("STALE:")]

    async def say(self, text: str) -> None:
        self.spoken.append(text)

    async def speak_gate_line(self, _instruction):
        if self.generated is None:
            return None
        line = self.generated.pop(0) if self.generated else None
        if line:
            self.spoken.append(line)
        return line

    async def classify(self) -> str:
        self.classify_calls += 1
        return phone.CLASSIFY_HUMAN

    async def infer(self, _prompt):
        return self.verdicts.pop(0) if self.verdicts else "unclear"

    async def commit_gate_turns(self, _session, turns, _key):
        self.committed.append(list(turns))
        return types.SimpleNamespace(ok=True)


class _RecordingClient:
    def __init__(self, sink):
        self._sink = sink

    async def post_event(self, _attempt, event_type, **_kw):
        self._sink.events.append(event_type)
        return phone.PhoneApiOutcome(
            ok=True, status=phone.EVENT_STATUS_APPLIED,
        )

    async def commit_gate_turns(self, session, turns, key):
        return await self._sink.commit_gate_turns(session, turns, key)


class TestGateIdentityFlow(unittest.IsolatedAsyncioTestCase):
    """End-to-end through `run_phone_gate` under the conversational flow."""

    def setUp(self):
        self._saved = os.environ.get("PHONE_GATE_FLOW")
        os.environ["PHONE_GATE_FLOW"] = "conversational"

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("PHONE_GATE_FLOW", None)
        else:
            os.environ["PHONE_GATE_FLOW"] = self._saved

    async def _gate(self, harness, **overrides):
        kwargs = dict(
            attempt_id="a1",
            client=_RecordingClient(harness),
            wait_for_participant=lambda: asyncio.sleep(0, result=object()),
            classify=harness.classify,
            say=harness.say,
            session_id="s1",
            next_candidate_turn=harness.next_candidate_turn,
            speak_gate_line=harness.speak_gate_line,
            reset_turn_buffer=harness.reset_turn_buffer,
            candidate_name=NAME,
        )
        kwargs.update(overrides)
        with mock.patch.object(
            phone, "_default_phone_identity_inference", harness.infer,
        ):
            return await phone.run_phone_gate(**kwargs)

    async def test_self_proceeds_to_the_consent_disclosure(self):
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["self"])
        result = await self._gate(h)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertEqual(h.classify_calls, 1, "the consent classifier must still run")
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_the_consent_line_does_not_introduce_us_a_second_time(self):
        # THE DOUBLE-HI, one turn earlier than #279 found it. The identity turn
        # has just said "Hi, this is Christy, an AI voice assistant …"; the full
        # `PHONE_DISCLOSURE_TEXT` would say it again in the very next breath.
        # Found by this test, not by reading.
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["self"])
        await self._gate(h)
        self.assertEqual(
            sum(1 for line in h.spoken if "AI voice assistant" in line), 1,
            f"introduced twice: {h.spoken!r}",
        )
        # …and the recording notice and the consent question are still intact.
        consent = [l for l in h.spoken if l.endswith("Is it okay to continue?")]
        self.assertEqual(len(consent), 1)
        self.assertIn(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE, consent[0])

    async def test_unclear_proceeds_rather_than_hanging_up(self):
        # FAIL-OPEN. A mumble is not evidence of a wrong number.
        h = _GateHarness(replies=["mmhm"], verdicts=["unclear"])
        await self._gate(h)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)

    async def test_silence_proceeds_and_costs_no_classifier_call(self):
        h = _GateHarness(replies=[""], verdicts=[])
        await self._gate(h)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)

    async def test_one_other_person_verdict_re_asks_and_does_not_end_the_call(self):
        # A single verdict may never end a call: "no, this is her father" is
        # also what a candidate says when the bot mangles their name.
        h = _GateHarness(
            replies=["No, this is Ravi.", "Actually yes, it's Priya, sorry."],
            verdicts=["other_person", "self"],
        )
        result = await self._gate(h)
        self.assertIn(phone.phone_identity_reask_text(NAME), h.spoken)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)

    async def test_an_unclear_reask_still_proceeds(self):
        h = _GateHarness(
            replies=["No, this is Ravi.", "…"], verdicts=["other_person", "unclear"],
        )
        await self._gate(h)
        self.assertIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)

    async def test_a_reask_that_reveals_unavailability_takes_the_callback_path(self):
        # Found by mutating the gate: an earlier draft coerced every non-`other`
        # re-ask verdict to `self`, which read the recording disclosure to the
        # relative who had just explained the candidate was out.
        h = _GateHarness(
            replies=["No, this is her father.", "She's not back until six."],
            verdicts=["other_person", "unavailable"],
        )
        await self._gate(h)
        self.assertIn(phone.PHONE_CALLBACK_DEFERRAL_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)
        self.assertNotIn("candidate.wrong_number", h.events)

    async def test_two_other_person_verdicts_apologise_and_end_the_call(self):
        h = _GateHarness(
            replies=["No, this is Ravi.", "No, you have the wrong number."],
            verdicts=["other_person", "other_person"],
        )
        result = await self._gate(h)
        self.assertIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_WRONG_NUMBER)
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)

    async def test_a_confirmed_mismatch_does_not_suppress_the_number_by_default(self):
        # `candidate.wrong_number` moves the engagement AND writes a permanent
        # line-level suppression in the same transaction, blocking that number
        # for every candidate and every future application. Two model verdicts
        # on a noisy phone call are not grounds for that.
        h = _GateHarness(
            replies=["No, this is Ravi.", "Wrong number."],
            verdicts=["other_person", "other_person"],
        )
        await self._gate(h)
        self.assertNotIn("candidate.wrong_number", h.events)

    async def test_suppression_can_be_switched_back_on(self):
        h = _GateHarness(
            replies=["No, this is Ravi.", "Wrong number."],
            verdicts=["other_person", "other_person"],
        )
        with mock.patch.dict(
            os.environ, {"PHONE_IDENTITY_MISMATCH_SUPPRESSES": "true"},
        ):
            await self._gate(h)
        self.assertIn("candidate.wrong_number", h.events)

    async def test_the_confirmed_mismatch_commits_its_evidence(self):
        h = _GateHarness(
            replies=["No, this is Ravi.", "Wrong number."],
            verdicts=["other_person", "other_person"],
        )
        await self._gate(h)
        self.assertTrue(h.committed, "the exchange is the only evidence for ending the call")
        speakers = [t["speaker"] for t in h.committed[0]]
        self.assertEqual(speakers.count("candidate"), 2)

    async def test_not_available_now_takes_the_callback_path_not_the_wrong_number_one(self):
        # The regex predecessor classified "she is not available right now" as a
        # wrong number: it hung up AND wrote a permanent DNC for a candidate who
        # had merely stepped away.
        h = _GateHarness(
            replies=["She's in a meeting, can you call back after six?"],
            verdicts=["unavailable"],
        )
        result = await self._gate(h)
        self.assertIn(phone.PHONE_CALLBACK_DEFERRAL_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, h.spoken)
        self.assertNotIn(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, h.spoken)
        self.assertNotIn("candidate.wrong_number", h.events)
        self.assertFalse(result.assessment_allowed)

    async def test_a_stale_pickup_utterance_cannot_be_read_as_an_answer(self):
        # THE SHARED-QUEUE HOLE. STT is live before the gate speaks, so the
        # callee's "Hello?" on pickup is already queued. Without a barrier the
        # identity reader pops THAT and the real identity answer is popped by
        # the CONSENT classifier.
        h = _GateHarness(
            replies=["STALE:Hello?", "Yes, this is Priya."], verdicts=["self"],
        )
        seen = []

        async def _spy(prompt):
            seen.append(prompt)
            return "self"

        h.infer = _spy
        await self._gate(h)
        self.assertEqual(len(seen), 1)
        self.assertIn("Yes, this is Priya.", seen[0])
        self.assertNotIn("Hello?", seen[0])

    async def test_the_consent_turn_starts_from_a_drained_buffer(self):
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["self"])
        drains = []
        real = h.reset_turn_buffer

        def _counting():
            drains.append(len(h.queue))
            real()

        h.reset_turn_buffer = _counting
        await self._gate(h)
        # Once before the identity ask, once before the consent disclosure.
        self.assertGreaterEqual(len(drains), 2)


class TestGateSpokenLineRepair(unittest.IsolatedAsyncioTestCase):
    """What happens to a line that was STREAMED and then found wanting."""

    def setUp(self):
        self._saved = os.environ.get("PHONE_GATE_FLOW")
        os.environ["PHONE_GATE_FLOW"] = "conversational"

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("PHONE_GATE_FLOW", None)
        else:
            os.environ["PHONE_GATE_FLOW"] = self._saved

    async def _run_with(self, generated):
        h = _GateHarness(
            replies=["Yes, this is Priya."], verdicts=["self"], generated=generated,
        )
        with mock.patch.object(
            phone, "_default_phone_identity_inference", h.infer,
        ):
            await phone.run_phone_gate(
                attempt_id="a1",
                client=_RecordingClient(h),
                wait_for_participant=lambda: asyncio.sleep(0, result=object()),
                classify=h.classify,
                say=h.say,
                session_id="s1",
                next_candidate_turn=h.next_candidate_turn,
                speak_gate_line=h.speak_gate_line,
                reset_turn_buffer=h.reset_turn_buffer,
                candidate_name=NAME,
            )
        return h

    async def test_a_good_generated_line_is_spoken_alone(self):
        good = "Hi, this is Christy calling about your application. Am I speaking to Priya?"
        h = await self._run_with([good])
        self.assertIn(good, h.spoken)
        self.assertNotIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertNotIn(phone.phone_identity_repair_text(NAME), h.spoken)

    async def test_a_line_that_missed_the_ask_is_REPAIRED_not_restarted(self):
        # THE DOUBLE-OPENER. The words have already been heard; speaking the
        # full fixed opener on top introduces us twice. Only the short repair —
        # which carries no self-introduction — may follow.
        bad = "Hi, this is Christy, an AI voice assistant. Lovely weather today."
        h = await self._run_with([bad])
        self.assertIn(bad, h.spoken)
        self.assertIn(phone.phone_identity_repair_text(NAME), h.spoken)
        self.assertNotIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertEqual(
            sum(1 for line in h.spoken if "AI voice assistant" in line), 1,
            f"introduced twice: {h.spoken!r}",
        )

    async def test_nothing_generated_speaks_the_fixed_line_exactly_once(self):
        h = await self._run_with([None])
        self.assertIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertNotIn(phone.phone_identity_repair_text(NAME), h.spoken)


class TestDeterministicFlowIsUntouched(unittest.IsolatedAsyncioTestCase):
    """The rollback target: with the flag unset, nothing new runs."""

    def setUp(self):
        self._saved = os.environ.get("PHONE_GATE_FLOW")
        os.environ.pop("PHONE_GATE_FLOW", None)

    def tearDown(self):
        if self._saved is not None:
            os.environ["PHONE_GATE_FLOW"] = self._saved

    async def test_no_identity_turn_no_drain_no_classifier_call(self):
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["other_person"])
        drained = []
        h.reset_turn_buffer = lambda: drained.append(1)
        spoke_gate_line = []

        async def _spy_line(_i):
            spoke_gate_line.append(1)
            return None

        h.speak_gate_line = _spy_line

        async def _never(_p):
            raise AssertionError("the classifier must not run in deterministic flow")

        with mock.patch.object(phone, "_default_phone_identity_inference", _never):
            result = await phone.run_phone_gate(
                attempt_id="a1",
                client=_RecordingClient(h),
                wait_for_participant=lambda: asyncio.sleep(0, result=object()),
                classify=h.classify,
                say=h.say,
                session_id="s1",
                next_candidate_turn=h.next_candidate_turn,
                speak_gate_line=h.speak_gate_line,
                reset_turn_buffer=h.reset_turn_buffer,
                candidate_name=NAME,
            )
        self.assertEqual(spoke_gate_line, [])
        self.assertEqual(drained, [], "the deterministic gate keeps its exact behaviour")
        self.assertNotIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)


class TestWordBoundaryFlush(unittest.IsolatedAsyncioTestCase):
    """The `min_chars` cap must not cut a word in half.

    These drive the REAL `PhoneScreeningAgent.tts_node`, not a copy of its
    algorithm. An earlier version of this file reimplemented the scan inside
    the test; deleting the production fix left every assertion passing, which
    is the definition of a test that guards nothing. The harness below is the
    one `test_codex_a_tts_first_fragment.py` already uses: a base agent whose
    `tts_node` records each downstream synthesis as a separate string, so the
    assertions can talk about what Sarvam actually receives.
    """

    def _agent(self, streams):
        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.chat_ctx = types.SimpleNamespace(items=[])

            async def tts_node(self, text, model_settings):
                buf = []
                async for chunk in text:
                    buf.append(chunk)
                    yield chunk
                streams.append("".join(buf))

        return phone.phone_agent_class(BaseAgent)(
            "sys", client=None, attempt_id="a1",
            say=None, on_user_turn=lambda *a, **k: None, native_turns=True,
        )

    async def _synthesized(self, text, *, min_chars):
        streams = []
        agent = self._agent(streams)
        with mock.patch.dict(
            phone.os.environ, {"PHONE_TTS_FLUSH_MIN_CHARS": str(min_chars)},
        ):
            async def _src():
                yield text
            async for _ in agent.tts_node(_src(), None):
                pass
        return streams

    async def test_the_cap_does_not_split_a_word(self):
        # 20 dense chars lands inside "confirming". The first synthesis must
        # end on a whole word, and the partial must travel to the second.
        streams = await self._synthesized(
            "Thanks for confirming that, let me ask about your experience.",
            min_chars=20,
        )
        self.assertTrue(streams)
        first = streams[0]
        self.assertTrue(
            first.endswith((" ", ".", ",", "!", "?")) or first == first.rstrip(),
            f"fragment ended mid-token: {first!r}",
        )
        self.assertNotIn("confirmin", first.replace("confirming", ""))

    async def test_no_character_is_lost_or_duplicated_across_the_join(self):
        # SPACES INCLUDED. Comparing with whitespace stripped is exactly what
        # hid the earlier defect, where the separator at the cut belonged to
        # neither fragment and the tail-peek then glued the halves together
        # ("the range is 1250000." -> "...is1250000.").
        source = "Thanks for sharing that, the budgeted range is 1250000 rupees."
        for cap in (20, 40, 60):
            streams = await self._synthesized(source, min_chars=cap)
            self.assertEqual("".join(streams), source, f"min_chars={cap}")

    async def test_a_digit_run_after_the_cap_keeps_its_leading_space(self):
        # The exact reported shape: the cap lands inside a long number.
        source = "Sure, the number to reach me on is 9876543210 any time."
        streams = await self._synthesized(source, min_chars=30)
        self.assertEqual("".join(streams), source)
        self.assertNotIn("is9876543210", "".join(streams))

    async def test_the_backoff_DECLINES_rather_than_emit_a_tiny_fragment(self):
        # v114: a sub-14-letter first synthesis re-primes Sarvam's prosody and
        # stutters. "Sure," followed by a long spaceless run is the trap — the
        # nearest word boundary is only 4 letters in, so backing off to it
        # would trade a mid-word cut for a worse artefact.
        #
        # The property this asserts is the DECLINE, not a floor on the cap
        # itself: the cap arm has never had one, and giving it one would delay
        # first audio, which is the latency the cap exists to buy. So the
        # fragment here is still whatever the cap produced — what must NOT
        # happen is the back-off shrinking it to "Sure,".
        streams = await self._synthesized(
            "Sure, 9876543210 is the number to call.", min_chars=20,
        )
        self.assertTrue(streams)
        self.assertNotEqual(streams[0].strip(), "Sure,")
        self.assertIn("9876543210", streams[0])
        self.assertEqual(
            "".join(streams), "Sure, 9876543210 is the number to call.",
        )

    async def test_punctuation_boundaries_are_untouched(self):
        streams = await self._synthesized(
            "Got it. Let me ask you something else.", min_chars=200,
        )
        self.assertEqual(streams[0], "Got it.")


if __name__ == "__main__":
    unittest.main()
