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
import time
import types
import unittest
from unittest import mock
from unittest.mock import patch

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

    def test_a_reflexive_pronoun_is_not_the_word_self(self):
        # THE MISREAD THAT MADE THIS FAIL UNSAFE. `self` is a substring of
        # himself / herself / myself / yourself / itself — the exact vocabulary
        # a model uses to describe who picked up a phone. Taking the first
        # `str.find` hit routed a THIRD PARTY into the recording disclosure and
        # the full screening. Each line below was reproduced against the old
        # parser and returned `self`.
        for raw, want in (
            ("He cannot come to the phone himself, so: unavailable",
             phone.PHONE_IDENTITY_UNAVAILABLE),
            ("She identified herself as the mother. other_person",
             phone.PHONE_IDENTITY_OTHER),
            ("The replier is not Priya herself, so other_person.",
             phone.PHONE_IDENTITY_OTHER),
        ):
            self.assertEqual(
                _run(phone.phone_classify_identity(
                    "No, this is her father.", NAME, infer=_verdict(raw))),
                want, raw,
            )

    def test_a_reasoning_body_resolves_to_its_FINAL_verdict(self):
        # An earlier fix rejected any multi-verdict body as "reasoning aloud".
        # That made `other_person` UNREACHABLE for a judge that reasons — the
        # shape this classifier documents as expected — so every one of these
        # returned `unclear`, proceeded to consent, and screened the wrong
        # person. A model that reasons puts its answer last.
        for raw in (
            "Options: self, other_person, unavailable, unclear. "
            "The answer is other_person",
            "This is not a self identification. other_person",
            "The reply says she is the mother, so this is not self; "
            "it is other_person.",
        ):
            self.assertEqual(
                _run(phone.phone_classify_identity(
                    "No, this is her father.", NAME, infer=_verdict(raw))),
                phone.PHONE_IDENTITY_OTHER, raw,
            )

    def test_a_body_naming_no_verdict_at_all_is_unclear(self):
        for raw in ("It is either way, hard to say", "", "   ", "no idea"):
            self.assertEqual(
                _run(phone.phone_classify_identity("hello", NAME, infer=_verdict(raw))),
                phone.PHONE_IDENTITY_UNCLEAR, raw,
            )

    def test_a_hyphenated_compound_is_not_a_verdict(self):
        # A hyphen is a non-word character, so `\bself\b` matched inside
        # "self-employed" — the same class of bug the word-boundary fix was
        # written for, one character over.
        for raw in ("self-employed", "the caller is self-employed"):
            self.assertEqual(
                _run(phone.phone_classify_identity("hello", NAME, infer=_verdict(raw))),
                phone.PHONE_IDENTITY_UNCLEAR, raw,
            )

    def test_the_deferral_terminal_is_not_consent_vocabulary(self):
        # `PHONE_CLASSIFICATIONS` is the CONSENT vocabulary, and the gate uses it
        # to coerce an unrecognised consent verdict to MACHINE — a fail-closed
        # guard. A non-consent terminal inside it would let a future classify
        # seam have a deferral waved through as a consent decision.
        self.assertNotIn(
            phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE, phone.PHONE_CLASSIFICATIONS)

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
                "PHONE_DETERMINISTIC_OPENER",
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

    def test_unset_is_deterministic_and_a_TYPO_FAILS_SAFE(self):
        # Production selects the conversational gate by SECRET; the code default
        # stays scripted. The second half is the point: a flipped default would
        # make `determinstic` — a plausible typo — select model-authored
        # pre-consent speech. Here every unrecognised token falls back.
        self.assertEqual(phone.phone_gate_flow(), "deterministic")
        self.assertTrue(phone.phone_deterministic_opener())
        for typo in ("determinstic", "deterministc", "scripted", "off", "0", ""):
            os.environ["PHONE_GATE_FLOW"] = typo
            self.assertEqual(phone.phone_gate_flow(), "deterministic", typo)

    def test_only_the_exact_token_enables_the_conversational_gate(self):
        for raw in ("conversational", "  Conversational  ", "CONVERSATIONAL"):
            os.environ["PHONE_GATE_FLOW"] = raw
            self.assertEqual(phone.phone_gate_flow(), "conversational", raw)

    def test_suppression_is_off_unless_explicitly_enabled(self):
        # Default OFF. Both settings post a purging terminal, so the purge is
        # no longer an argument for suppressing; what is left is evidence, and
        # the deterministic backstop misses the commonest correction shape
        # ("No, I'm Priya" extracts no name). Two model verdicts plus a
        # mis-heard name must not blocklist a number for every candidate and
        # every future application.
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

    def test_no_spoken_gate_line_before_consent_mentions_recording(self):
        # Recording belongs to the consent turn. A disclosure that arrives one
        # turn early is a disclosure the candidate did not consent to yet — and
        # it may be read to somebody who is not the candidate at all.
        #
        # The token is "record", not "recorded". Asserting the past tense let
        # "Hi, we record this call. Am I speaking to Priya?" pass — verified by
        # execution. And the list is SPOKEN LINES only: the two instruction
        # builders necessarily contain "record", because their job is to forbid
        # it, and mixing them in is what forced the narrower token in the first
        # place.
        for line in (phone.phone_identity_text(NAME),
                     phone.phone_identity_text(None),
                     phone.phone_identity_reask_text(NAME),
                     phone.phone_identity_reask_text(None),
                     phone.phone_identity_repair_text(NAME),
                     phone.phone_identity_repair_text(None)):
            self.assertNotIn("record", line.lower(), line)

    def test_the_instructions_forbid_recording_rather_than_mention_it(self):
        for instruction in (phone.phone_identity_instruction(NAME),
                            phone.phone_identity_reask_instruction(NAME)):
            lowered = instruction.lower()
            self.assertIn("do not mention recording", lowered, instruction)

    def test_the_reask_names_nobody(self):
        # It is spoken to a person who has just said they are NOT the candidate.
        # Naming her tells a parent, spouse or colleague that a recruiter is
        # calling her — the disclosure the identity check exists to avoid.
        line = phone.phone_identity_reask_text(NAME)
        self.assertTrue(line.rstrip().endswith("?"))
        self.assertNotIn("Priya", line)
        self.assertNotIn("Sharma", line)
        self.assertTrue(phone._identity_line_asks_identity(line), line)

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
        # TWO things, deliberately, because the defect lives in the difference.
        #
        # `queue` is the live STT buffer: utterances that were ALREADY finalised
        # when the reader looked — the callee's "Hello?" on pickup. It is
        # drainable, exactly as production's `user_turns` is.
        #
        # `replies` is what the candidate says IN RESPONSE to the question just
        # asked. It arrives after the drain by construction, which is what makes
        # "the barrier ate the real answer" a failure this harness can actually
        # observe rather than one it defines away.
        # Stale utterances, each with the ms at which its SPEECH STARTED.
        # Production filters these at the READER (`_next_candidate_turn` and
        # `_classify_phone_answer`), comparing that start against the anchor of
        # the question each reader itself asked — a producer-side filter cannot,
        # because only the reader knows which question is outstanding. The
        # harness applies the same rule in the same place.
        self.queue: list[tuple[str, int]] = []
        self.anchor_ms: int | None = None
        # A monotonic tick, not a wall clock. Production compares real
        # millisecond speech-start anchors; in a test that runs in under a
        # millisecond those collide, and a collision silently turns the
        # assertion into "kept" regardless of the code. A counter models the
        # ORDERING the rule actually depends on.
        self._tick = 0
        self.replies: list[str] = list(replies)
        self.verdicts: list[str] = list(verdicts)
        self.generated = generated
        self.classify_calls = 0
        self.consent_saw: str | None = None

    async def next_candidate_turn(self) -> str:
        while self.queue:
            text, started_ms = self.queue.pop(0)
            if self.anchor_ms is not None and started_ms < self.anchor_ms:
                continue          # predates the question — correctly rejected
            return text           # began after the question — a real answer
        return self.replies.pop(0) if self.replies else ""

    def speech(self, text: str) -> None:
        """Record an utterance as starting NOW (relative to the anchor)."""
        self._tick += 1
        self.queue.append((text, self._tick))

    def mark_question_asked(self) -> None:
        self._tick += 1
        self.anchor_ms = self._tick

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
        # READS THE SAME QUEUE, exactly as `_classify_phone_answer` does. A
        # harness whose consent classifier never touched the buffer could not
        # observe cross-contamination between the two readers at all — which is
        # the entire defect this flow was blocked on. `consent_saw` is what the
        # consent turn actually consumed.
        self.classify_calls += 1
        self.consent_saw = await self.next_candidate_turn()
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

    async def consent_and_start_assessment(self, _attempt, _session, _epoch):
        # Wiring this is what lets the tests reach the POST-CONSENT commit —
        # where the gate transcript is longest and where the server's 6-row
        # bound actually bites. Without it every test stopped at a terminal.
        return types.SimpleNamespace(
            ok=True, role_title=None, status="ok", assessment_id="as1",
            plan=None, questions=(), cursor=0, role_focus=None,
        )


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
            # Required alongside session_id for the gate to run the atomic
            # consent/start RPC — and therefore to reach the post-consent
            # transcript commit, where the server's 6-row bound bites.
            epoch=1,
            next_candidate_turn=harness.next_candidate_turn,
            speak_gate_line=harness.speak_gate_line,
            mark_question_asked=harness.mark_question_asked,
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
        self.assertEqual(result.outcome, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)

    async def test_a_confirmed_mismatch_defers_rather_than_blocklisting(self):
        h = _GateHarness(
            replies=["No, this is Ravi.", "Wrong number."],
            verdicts=["other_person", "other_person"],
        )
        await self._gate(h)
        self.assertIn("candidate.deferred_pre_disclosure", h.events)
        self.assertNotIn("candidate.wrong_number", h.events)

    async def test_suppression_can_be_switched_on(self):
        h = _GateHarness(
            replies=["No, this is Ravi.", "Wrong number."],
            verdicts=["other_person", "other_person"],
        )
        with mock.patch.dict(
            os.environ, {"PHONE_IDENTITY_MISMATCH_SUPPRESSES": "true"},
        ):
            await self._gate(h)
        self.assertIn("candidate.wrong_number", h.events)
        self.assertIn(phone.PHONE_WRONG_NUMBER_TEXT, h.spoken)

    async def test_every_identity_terminal_posts_a_purging_event(self):
        # Generalised, because "ends the call without posting anything" is the
        # shape of the bug, not one instance of it. Every PURGE_BEFORE_EVENTS
        # member destroys the pre-consent recording; a terminal outside that set
        # silently keeps it.
        purging = {"candidate.wrong_number", "candidate.deferred_pre_disclosure"}
        for label, replies, verdicts, env in (
            ("mismatch/suppressing", ["No, this is Ravi.", "Wrong number."],
             ["other_person", "other_person"], {}),
            ("mismatch/deferring", ["No, this is Ravi.", "Wrong number."],
             ["other_person", "other_person"],
             {"PHONE_IDENTITY_MISMATCH_SUPPRESSES": "false"}),
            ("unavailable", ["She's in a meeting."], ["unavailable"], {}),
        ):
            h = _GateHarness(replies=replies, verdicts=verdicts)
            with mock.patch.dict(os.environ, env):
                await self._gate(h)
            self.assertTrue(
                purging & set(h.events),
                f"{label}: terminal posted no purging event ({h.events})",
            )

    async def test_no_transcript_is_persisted_before_consent(self):
        # `main` had ONE `_commit_gate_turns` call site, after consent. An
        # earlier draft added pre-consent ones "as evidence" — which files a
        # bystander's words under the candidate's session labelled "candidate",
        # with no erasure route (the wrong_number purge deletes RECORDINGS only,
        # and the DSAR erase keys on a column `transcript_turns` does not have).
        # The verdicts live in the structured log instead.
        for replies, verdicts in (
            (["No, this is Ravi.", "Wrong number."], ["other_person", "other_person"]),
            (["She's in a meeting."], ["unavailable"]),
        ):
            h = _GateHarness(replies=replies, verdicts=verdicts)
            await self._gate(h)
            self.assertEqual(
                h.committed, [],
                f"persisted a transcript with no consent: {h.committed!r}",
            )

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
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["self"])
        h.speech("Hello?")   # spoken at pickup, BEFORE any question
        seen = []

        async def _spy(prompt):
            seen.append(prompt)
            return "self"

        h.infer = _spy
        await self._gate(h)
        self.assertEqual(len(seen), 1)
        self.assertIn("Yes, this is Priya.", seen[0])
        self.assertNotIn("Hello?", seen[0])

    async def test_an_answer_spoken_OVER_the_question_is_KEPT(self):
        # THE LIVE DEFECT, 2026-09-11. The first barrier drained the queue AFTER
        # playout, so a candidate who answered over the question's tail had the
        # reply discarded; the reader blocked to timeout and the verdict failed
        # open to `unclear`. The stage-2 transcript had NO candidate turn between
        # the identity question and consent, so the check verified nothing.
        #
        # Speech that STARTS after the question was asked is an answer, however
        # early it lands. It must survive.
        h = _GateHarness(replies=[], verdicts=["self"])
        real_speak = h.speak_gate_line

        async def _speak_then_bargein(instruction):
            out = await real_speak(instruction)
            h.speech("Yes, this is Priya.")     # starts AFTER the anchor
            return out

        h.speak_gate_line = _speak_then_bargein
        seen = []

        async def _spy(prompt):
            seen.append(prompt)
            return "self"

        h.infer = _spy
        await self._gate(h)
        self.assertEqual(len(seen), 1, "the barge-in answer was dropped")
        self.assertIn("Yes, this is Priya.", seen[0])

    async def test_a_stale_utterance_and_a_barge_in_are_told_apart(self):
        # Both land after the question STARTS; only their speech-start differs.
        # Arrival time cannot separate them, which is exactly why the first
        # attempt could not get both cases right at once.
        h = _GateHarness(replies=[], verdicts=["self"])
        h.speech("Hello?")                      # before the anchor
        real_speak = h.speak_gate_line

        async def _speak_then_bargein(instruction):
            out = await real_speak(instruction)
            h.speech("Yeah, Priya speaking.")   # after the anchor
            return out

        h.speak_gate_line = _speak_then_bargein
        seen = []

        async def _spy(prompt):
            seen.append(prompt)
            return "self"

        h.infer = _spy
        await self._gate(h)
        self.assertEqual(len(seen), 1)
        self.assertIn("Yeah, Priya speaking.", seen[0])
        self.assertNotIn("Hello?", seen[0])


    async def test_the_gate_transcript_is_bounded_to_what_the_server_accepts(self):
        # The route (`.max(6)`) and the RPC (`invalid_turns`) both refuse more
        # than six rows, and the conversational flow can produce seven: a
        # repaired identity ask (line + repair + reply), a re-ask (line + reply),
        # then the consent pair. Unbounded, the ENTIRE commit is rejected and the
        # transcript is lost on exactly the calls that need it.
        bad = "Hi, this is Christy, an AI voice assistant. Lovely weather."
        alsobad = "Sorry about that. Lovely weather though."
        h = _GateHarness(
            replies=["No, this is Ravi.", "Actually it's Priya, sorry."],
            verdicts=["other_person", "self"],
            generated=[bad, alsobad],
        )
        await self._gate(h)
        self.assertTrue(h.committed, "the post-consent commit did not run")
        self.assertLessEqual(
            len(h.committed[0]), 6,
            f"server refuses >6 rows; sent {len(h.committed[0])}",
        )
        # And truncation keeps the LAST rows, which is what makes it safe: the
        # consent evidence — the disclosure that was actually spoken — is the
        # newest row and must never be the one dropped.
        self.assertIn(
            phone.PHONE_DISCLOSURE_CONTINUATION_TEXT,
            [row["text"] for row in h.committed[0]],
            "truncation dropped the consent disclosure",
        )
        # EXACTLY at the cap, not merely under it. This flow produces SEVEN
        # rows — two repaired asks (line + repair + reply each) plus the
        # disclosure — so `== 6` only holds because truncation ran. Asserting
        # `<= 6` alone would pass against no truncation at all on any shorter
        # path, which is how an untested cap looks green.
        self.assertEqual(len(h.committed[0]), 6)

    async def test_a_late_identity_utterance_never_reaches_the_consent_parser(self):
        # THE CROSS-CONTAMINATION THE FLOW WAS BLOCKED ON, stated as a test.
        # The candidate answers the identity question in two STT finals
        # ("Yes, this is Priya." then "...how can I help?"). The first is
        # consumed as the identity answer; without a drain before the
        # disclosure, the SECOND is popped by the CONSENT classifier and read as
        # consent to being recorded.
        h = _GateHarness(
            replies=["Yes, this is Priya.", "Yes, that's fine."],
            verdicts=["self"],
        )
        real_next = h.next_candidate_turn
        fired = []

        async def _next_then_trailing():
            out = await real_next()
            if not fired:
                fired.append(1)
                h.speech("...how can I help?")
            return out

        h.next_candidate_turn = _next_then_trailing
        await self._gate(h)
        self.assertEqual(
            h.consent_saw, "Yes, that's fine.",
            f"the consent turn consumed the wrong utterance: {h.consent_saw!r}",
        )

    async def test_the_consent_question_gets_its_own_anchor(self):
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["self"])
        anchors = []
        real = h.mark_question_asked

        def _counting():
            anchors.append(len(h.spoken))
            real()

        h.mark_question_asked = _counting
        await self._gate(h)
        # ORDERING, not a count. One anchor must fall between the identity
        # answer and the consent disclosure, or the consent classifier inherits
        # the identity question's window. Counting alone would pass on two
        # anchors in the wrong places.
        self.assertTrue(anchors, "no question was ever anchored")
        before_disclosure = h.spoken.index(
            phone.PHONE_DISCLOSURE_CONTINUATION_TEXT)
        self.assertTrue(
            any(0 < a <= before_disclosure for a in anchors),
            f"no anchor between the identity answer and the disclosure: {anchors}",
        )


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
                mark_question_asked=h.mark_question_asked,
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

    async def test_SPOKEN_BUT_UNREADABLE_is_repaired_not_restarted(self):
        # THE CONTRACT THAT WAS BROKEN. `_speak_gate_generation` returns "" for
        # "audio went out, transcript never came back" — which the SDK does
        # routinely, and which every leak-veto abandon also produces. The gate
        # tested `spoken_line.strip()`, and "" is FALSY, so the one case the
        # contract exists for fell into the nothing-was-spoken arm and spoke the
        # full fixed opener over live audio: the 2026-09-09 double-opener,
        # reproduced by the code written to prevent it. No test passed "".
        h = await self._run_with([""])
        self.assertNotIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertIn(phone.phone_identity_repair_text(NAME), h.spoken)
        self.assertEqual(
            sum(1 for line in h.spoken if "AI voice assistant" in line), 0,
            f"re-introduced over live audio: {h.spoken!r}",
        )

    async def test_nothing_generated_speaks_the_fixed_line_exactly_once(self):
        h = await self._run_with([None])
        self.assertIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertNotIn(phone.phone_identity_repair_text(NAME), h.spoken)


class TestDeterministicFlowIsUntouched(unittest.IsolatedAsyncioTestCase):
    """The rollback target: with the flag unset, nothing new runs."""

    def setUp(self):
        self._saved = os.environ.get("PHONE_GATE_FLOW")
        # EXPLICIT, not popped. The default is `deterministic`, so popping
        # would pass for the wrong reason — it would test the DEFAULT rather
        # than the rollback token, and keep passing if the token stopped
        # working. A 2026-09-11 draft did flip the default; it was dropped.
        os.environ["PHONE_GATE_FLOW"] = "deterministic"

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("PHONE_GATE_FLOW", None)
        else:
            os.environ["PHONE_GATE_FLOW"] = self._saved

    async def test_no_identity_turn_no_anchor_no_classifier_call(self):
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["other_person"])
        anchored = []
        h.mark_question_asked = lambda: anchored.append(1)
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
                mark_question_asked=h.mark_question_asked,
                candidate_name=NAME,
            )
        self.assertEqual(spoke_gate_line, [])
        self.assertEqual(anchored, [], "the deterministic gate keeps its exact behaviour")
        self.assertNotIn(phone.phone_identity_text(NAME), h.spoken)
        self.assertIn(phone.PHONE_DISCLOSURE_TEXT, h.spoken)
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)


class TestParticipantGoneMidGate(unittest.IsolatedAsyncioTestCase):
    """A leg that drops while the gate is mid-await must not crash the job.

    LIVE INCIDENT 2026-09-11 06:11:06Z. The callee's leg ended 0.8 s after
    `call.answered`; the gate was inside its 8 s SIP output-subscription wait,
    came out of it, called `_say`, and the SDK raised
    `RuntimeError: AgentSession isn't running` — unhandled, so the job
    entrypoint died.

    The hang-up is ordinary. The CRASH is the defect: it skips every terminal,
    so no event posts, the pre-consent recording (the egress starts at
    `call.answered`) is never purged, and the engagement is left in `dialing`
    for the lease reaper. This predates the identity turn — `main` crashed the
    same way at `await _say(PHONE_DISCLOSURE_TEXT)`.
    """

    def setUp(self):
        self._saved = os.environ.get("PHONE_GATE_FLOW")
        os.environ["PHONE_GATE_FLOW"] = "conversational"

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("PHONE_GATE_FLOW", None)
        else:
            os.environ["PHONE_GATE_FLOW"] = self._saved

    async def test_a_dead_session_raises_the_typed_signal_not_a_bare_runtime_error(self):
        h = _GateHarness(replies=["Yes, this is Priya."], verdicts=["self"])

        async def _dead_say(_text):
            raise phone.PhoneParticipantGone()

        h.say = _dead_say
        with mock.patch.object(phone, "_default_phone_identity_inference", h.infer):
            with self.assertRaises(phone.PhoneParticipantGone):
                await phone.run_phone_gate(
                    attempt_id="a1",
                    client=_RecordingClient(h),
                    wait_for_participant=lambda: asyncio.sleep(0, result=object()),
                    classify=h.classify,
                    say=h.say,
                    session_id="s1",
                    epoch=1,
                    next_candidate_turn=h.next_candidate_turn,
                    speak_gate_line=h.speak_gate_line,
                    mark_question_asked=h.mark_question_asked,
                    candidate_name=NAME,
                )

    def test_the_signal_is_its_own_type_not_a_broad_runtime_catch(self):
        # Catching RuntimeError broadly here would swallow unrelated SDK faults
        # behind a routine hang-up.
        self.assertTrue(issubclass(phone.PhoneParticipantGone, Exception))
        self.assertFalse(issubclass(phone.PhoneParticipantGone, RuntimeError))

    def test_the_participant_left_outcome_exists_and_denies_assessment(self):
        result = phone.PhoneGateResult(
            phone.GATE_PARTICIPANT_LEFT, events=[], spoken=[])
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)


class TestGateWindowLeakVeto(unittest.IsolatedAsyncioTestCase):
    """The `_gate_opening` branch of the REAL `llm_node`.

    This branch had NO test. Both `if False:` (veto can never fire) and
    `if True:` (veto always fires, so the gate window yields nothing on every
    call) survived the whole repository's suite — the always-veto mutant was
    *cleaner* than the baseline. It is the only new safety mechanism in this
    change, and it is the same shape as the three defects that blocked the
    previous round: a new guard on a path nothing executes.

    So these drive the real `llm_node` with `set_gate_opening(True)` and assert
    on the chunks that reach `tts_node`.
    """

    RESUME = (
        "Senior Data Engineer at Infosys in Bengaluru with four years of "
        "experience building Spark pipelines for retail analytics"
    )

    def _agent(self, chunks):
        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.chat_ctx = types.SimpleNamespace(items=[])

            def llm_node(self, chat_ctx, tools, model_settings):
                async def _gen():
                    for c in chunks:
                        yield c
                return _gen()

        agent = phone.phone_agent_class(BaseAgent)(
            "You are Christy, an AI voice assistant calling from the company "
            "about the candidate's job application.",
            client=None, attempt_id="a1", say=None,
            on_user_turn=lambda *a, **k: None, native_turns=True,
        )
        agent.set_gate_leak_control(self.RESUME)
        agent.set_gate_opening(True)
        return agent

    async def _spoken(self, chunks):
        agent = self._agent(chunks)
        out = []
        async for chunk in agent.llm_node(
            types.SimpleNamespace(items=[]), [], None,
        ):
            out.append(chunk)
        return "".join(out)

    async def test_a_clean_greeting_is_spoken_in_full(self):
        # THE FALSE-POSITIVE CASE, and the reason the veto scans the résumé
        # facts rather than the system prompt. This greeting shares six
        # contiguous tokens with the prompt ("an AI voice assistant calling
        # from") because the prompt is what tells the bot to say them. Scanned
        # against the prompt it was vetoed — silently replacing every authored
        # line with the fixed one.
        line = ("Hi, this is Christy, an AI voice assistant calling from the "
                "company about your job application. Am I speaking to Priya?")
        self.assertEqual(await self._spoken([line]), line)

    async def test_a_verbatim_resume_recital_is_vetoed_before_any_audio(self):
        leak = ("Hi there, I can see you are a Senior Data Engineer at Infosys "
                "in Bengaluru with four years of experience. Am I speaking to "
                "Priya?")
        self.assertEqual(await self._spoken([leak]), "")

    async def test_a_leak_in_the_TAIL_is_stopped_mid_stream(self):
        # The lead is clean, so it releases — and A0's F1/F2 review finding was
        # exactly that the remainder then streamed unchecked. The tail veto has
        # to truncate, not merely decline to start.
        #
        # With one chunk of lookahead the lead's LAST chunk is still in hand
        # when the recital arrives, so at this coarse granularity the whole lead
        # is withheld and the turn ends silent — `run_phone_gate` then speaks
        # its fixed line. Safer than truncating, so the assertion is on the
        # guarantee that matters rather than on which of the two happened.
        chunks = [
            "Hi, this is Christy calling about your application. ",
            "I can see you are a Senior Data Engineer at Infosys in Bengaluru ",
            "with four years of experience. Am I speaking to Priya?",
        ]
        spoken = await self._spoken(chunks)
        self.assertNotIn("Infosys in Bengaluru with four years", spoken)
        self.assertNotIn("Senior Data Engineer", spoken)

    async def test_a_premature_goodbye_is_vetoed(self):
        self.assertEqual(
            await self._spoken(["Thanks for your time, and goodbye."]), "",
        )

    async def test_the_lead_is_bounded_and_the_recital_is_truncated(self):
        # THE TRADE, STATED HONESTLY. The gate releases on exactly the rule a
        # screening turn uses — boundary or `_A0_LEADING_SEGMENT_MAX_CHARS` —
        # because holding longer cost ~8x the lead-in and the owner heard it as
        # dead air on a live stage-2 call.
        #
        # So a short lead CAN contain résumé words: the echo detector needs six
        # CONTIGUOUS verbatim ones and a 48-char lead may carry five. What is
        # guaranteed is that the recital does not CONTINUE — the tail veto
        # re-checks every chunk and truncates the moment six appear. This test
        # asserts that guarantee and the bound, not a stronger claim.
        chunks = ["Hi, ", "I can see you are a Senior Data Engineer at Infosys ",
                  "in Bengaluru with four years of experience. Am I speaking to Priya?"]
        spoken = await self._spoken(chunks)
        self.assertNotIn("in Bengaluru", spoken, f"recital continued: {spoken!r}")
        self.assertNotIn("four years", spoken, f"recital continued: {spoken!r}")
        self.assertLessEqual(
            len(spoken), phone._A0_LEADING_SEGMENT_MAX_CHARS + len(chunks[1]),
            f"lead was not bounded: {spoken!r}",
        )

    async def test_the_gate_lead_is_not_slower_than_a_screening_turn(self):
        # The latency regression the owner reported, pinned. The gate window and
        # the A0 screening path must release on the SAME rule; a floor or a
        # wider cap here is invisible in every other test and audible on every
        # call.
        self.assertEqual(
            phone._GATE_LEAK_HARD_CAP_CHARS, phone._A0_LEADING_SEGMENT_MAX_CHARS,
            "the gate would hold audio longer than a screening turn",
        )
        line = "Hi there, good morning! This is Christy calling from Interview Kickstart."
        spoken = await self._spoken([line])
        self.assertEqual(spoken, line)

    async def test_no_resume_token_escapes_on_a_boundaryless_recital(self):
        # The cap-release hole, stated directly: a recital with no punctuation
        # until the end must be held and checked whole, not released at 48 chars.
        chunks = ["I can see you are a Senior Data Engineer at Infosys in "
                  "Bengaluru with four years of experience. Am I speaking to Priya?"]
        self.assertEqual(await self._spoken(chunks), "")

    async def test_a_vetoed_stream_is_closed_not_abandoned_open(self):
        # A vetoed gate turn that leaves the provider stream open leaks a
        # connection and keeps billing tokens, on the most cost-sensitive path.
        closed = []

        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.chat_ctx = types.SimpleNamespace(items=[])

            def llm_node(self, chat_ctx, tools, model_settings):
                class _Stream:
                    def __aiter__(self_inner):
                        async def _gen():
                            yield ("Hi there, I can see you are a Senior Data "
                                   "Engineer at Infosys in Bengaluru.")
                        return _gen()

                    async def aclose(self_inner):
                        closed.append(True)

                return _Stream()

        agent = phone.phone_agent_class(BaseAgent)(
            "sys", client=None, attempt_id="a1", say=None,
            on_user_turn=lambda *a, **k: None, native_turns=True,
        )
        agent.set_gate_leak_control(self.RESUME)
        agent.set_gate_opening(True)
        out = []
        async for chunk in agent.llm_node(types.SimpleNamespace(items=[]), [], None):
            out.append(chunk)
        self.assertEqual("".join(out), "")
        self.assertEqual(closed, [True], "the vetoed provider stream was left open")

    async def test_a_generated_identity_line_may_not_disclose_recording(self):
        # The instruction asks the model not to; an instruction is not an
        # enforcement. These were accepted and spoken before the check existed.
        for line in (
            "Hi, this is Christy. This call is recorded for the hiring team. "
            "Am I speaking to Priya?",
            "Hi, Christy here. We record these calls. Have I reached the right "
            "person?",
        ):
            self.assertFalse(phone._identity_line_asks_identity(line), line)

    async def test_a_short_reply_with_no_boundary_is_still_checked(self):
        self.assertEqual(await self._spoken(["Goodbye"]), "")
        self.assertEqual(await self._spoken(["Hello?"]), "Hello?")

    async def test_an_empty_stream_yields_nothing_and_does_not_hang(self):
        self.assertEqual(await self._spoken([]), "")


def _token_chunks(text):
    """Split into TOKEN-sized chunks — the granularity production streams at.

    Every other test in this file feeds phrase- or line-sized chunks, and that
    is the blind spot: `phone_instruction_echo_detected` judges what it is
    GIVEN, so a whole line is vetoed before any audio while the same line
    arriving a word at a time has already spoken five words of it by the time
    the sixth makes the echo visible.
    """
    out, buf = [], ""
    for ch in text:
        buf += ch
        if ch == " ":
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


class TestGateLeakVetoAtTokenGranularity(TestGateWindowLeakVeto):
    """Every leak assertion above, re-run one word at a time.

    WHY THIS CLASS EXISTS. `phone.py` documents the gate window as streaming
    "token by token through `llm_node` → `tts_node`", and `_A0_FIRST_FRAGMENT`
    notes real first fragments can be two characters. But every chunk list in
    the parent class is a whole phrase, so the parent proved the veto works on
    a granularity production never uses. Driven a word at a time, the same
    "vetoed before any audio" line put `Senior Data Engineer at Infosys` — five
    verbatim résumé words — in front of a listener whose identity the gate had
    not yet established, with the egress already recording.

    Subclassing re-runs the parent's cases through `_spoken`, which is
    overridden here to re-chunk. Cases that are already single short tokens are
    unaffected; the recital cases are the ones that change.
    """

    async def _spoken(self, chunks):
        return await super()._spoken(_token_chunks("".join(chunks)))

    async def test_a_verbatim_resume_recital_is_vetoed_before_any_audio(self):
        # The parent asserts NOTHING is spoken, which is achievable only by
        # holding the whole line — the 73-char hold the owner heard as dead air.
        # Word by word, the clean preamble is released on its first boundary
        # exactly as a screening turn would release it, and the hold begins when
        # the RUN does. So the guarantee at this granularity is narrower and is
        # the one that actually protects the candidate: not one résumé word.
        leak = ("Hi there, I can see you are a Senior Data Engineer at Infosys "
                "in Bengaluru with four years of experience. Am I speaking to "
                "Priya?")
        spoken = await self._spoken([leak])
        for word in ("Senior", "Data", "Engineer", "Infosys", "Bengaluru"):
            self.assertNotIn(word, spoken, f"résumé word spoken: {spoken!r}")
        self.assertNotIn("four years", spoken)

    async def test_a_premature_goodbye_is_vetoed(self):  # noqa: D102 — overrides
        # AN HONEST DOWNGRADE, recorded rather than hidden. Fed whole, this line
        # is vetoed before any audio. Word by word, "Thanks for your time, and "
        # releases on its comma before "goodbye" has arrived, so the closing
        # veto fires one word later and truncates instead of preventing.
        #
        # Accepted deliberately: this is the exposure a POST-consent screening
        # turn already carries — A0 releases on the same boundary-or-cap rule —
        # and the cost is a few words of filler before `run_phone_gate` speaks
        # its fixed line, not a disclosure. The résumé hold above is the part
        # that is pre-consent-specific, and that one is absolute.
        spoken = await self._spoken(["Thanks for your time, and goodbye."])
        self.assertNotIn("goodbye", spoken.casefold(),
                         f"the closing itself was spoken: {spoken!r}")
        self.assertLess(len(spoken), len("Thanks for your time, and goodbye."))

    async def test_the_lead_is_bounded_and_the_recital_is_truncated(self):
        # The parent's bound is `48 + len(chunks[1])`, which at phrase
        # granularity is 99 chars and is really "one chunk after release" — a
        # bound that says almost nothing. At token granularity the only bound
        # worth asserting is the one that matters: NO résumé word is spoken.
        chunks = ["Hi, ", "I can see you are a Senior Data Engineer at Infosys ",
                  "in Bengaluru with four years of experience. Am I speaking to Priya?"]
        spoken = await self._spoken(chunks)
        for word in ("Senior", "Data", "Engineer", "Infosys", "Bengaluru"):
            self.assertNotIn(word, spoken, f"résumé word spoken: {spoken!r}")

    async def test_a_pure_recital_speaks_NOTHING_word_by_word(self):
        # The worst shape: no preamble at all, and a comma five words in, so the
        # boundary rule alone would release the whole recital.
        line = ("Senior Data Engineer at Infosys, in Bengaluru with four years "
                "of experience. Am I speaking to Priya?")
        self.assertEqual(await self._spoken([line]), "")

    async def test_not_one_resume_word_escapes_on_any_recital_shape(self):
        for line in (
            "Hi there, I can see you are a Senior Data Engineer at Infosys in "
            "Bengaluru with four years of experience. Am I speaking to Priya?",
            "Hi, you are a Senior Data Engineer at Infosys in Bengaluru. "
            "Am I speaking to Priya?",
            "Senior Data Engineer at Infosys in Bengaluru with four years of "
            "experience — am I speaking to Priya?",
            "Bonjour, vous êtes Senior Data Engineer at Infosys in Bengaluru "
            "with four years of experience?",
        ):
            spoken = await self._spoken([line])
            for word in ("Senior", "Data", "Engineer", "Infosys", "Bengaluru",
                         "Spark"):
                self.assertNotIn(
                    word, spoken,
                    f"résumé word {word!r} reached a pre-consent listener from "
                    f"{line!r}: {spoken!r}",
                )

    #: A parsed-résumé blob as `agent.py` actually arms it — prose, near the
    #: 8000-char cap, containing the ordinary words a greeting is built from.
    #: The 122-char `RESUME` above is not a latency test: with only 18 distinct
    #: tokens it collides with almost nothing, and the hold never fires.
    PROD_RESUME = ((
        "Senior Data Engineer at Infosys in Bengaluru with four years of "
        "experience building Spark pipelines for retail analytics. Good "
        "communication skills and a track record of speaking with stakeholders "
        "every morning during standup. There is a strong preference for remote "
        "work. Previously Data Analyst at Wipro working with SQL and Python on "
        "customer segmentation. Holds a Bachelor of Engineering in Computer "
        "Science from Anna University. Notice period is sixty days. Open to "
        "relocating to Hyderabad or Pune for the right role. Speaks English, "
        "Hindi, Tamil and Kannada. Hobbies include long distance running and "
        "volunteering at a local school on Saturday mornings. Comfortable "
        "calling into early meetings with international clients. ") * 9)[:8000]

    async def _consumed_before_first_audio(self, line, control):
        """How much source was pulled before ANY audio escaped.

        Not `out[0]`: held chunks replay in source order, so the first EMITTED
        chunk is the first SOURCE chunk however long it was held. An assertion
        on it stays green while the whole line is withheld to end-of-stream —
        exactly the regression being guarded against.
        """
        chunks = _token_chunks(line)
        pulled: list[str] = []

        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions
                self.chat_ctx = types.SimpleNamespace(items=[])

            def llm_node(self, chat_ctx, tools, model_settings):
                async def _gen():
                    for c in chunks:
                        pulled.append(c)
                        yield c
                return _gen()

        agent = phone.phone_agent_class(BaseAgent)(
            "You are Christy, an AI voice assistant calling from the company.",
            client=None, attempt_id="a1", say=None,
            on_user_turn=lambda *a, **k: None, native_turns=True,
        )
        agent.set_gate_leak_control(control)
        agent.set_gate_opening(True)
        waited = None
        out = []
        async for chunk in agent.llm_node(
            types.SimpleNamespace(items=[]), [], None,
        ):
            if waited is None:
                waited = len("".join(pulled))
            out.append(chunk)
        return waited, "".join(out)

    async def test_a_PRODUCTION_SIZED_resume_does_not_delay_a_clean_line(self):
        # THE REGRESSION THE OWNER WOULD HEAR, pinned against a control the size
        # `agent.py` really arms. An earlier version of this hold fired on any
        # single shared token; because a real résumé contains "there" and
        # "morning", first audio slipped from 10 chars to 63 — worse than the
        # 73-char hold the whole change exists to remove, and invisible to every
        # other test in this file.
        for line in (
            "Hi there, good morning! This is Christy calling from Interview "
            "Kickstart. Am I speaking with Christo?",
            "Good morning, this is Christy from Interview Kickstart. Am I "
            "speaking with Christo?",
            "Hello, this is Christy, an AI voice assistant calling about your "
            "application. Have I reached Priya?",
        ):
            with_facts, spoken = await self._consumed_before_first_audio(
                line, self.PROD_RESUME)
            without, _ = await self._consumed_before_first_audio(line, "")
            self.assertEqual(spoken, line, f"a clean line was altered: {line!r}")
            self.assertEqual(
                with_facts, without,
                f"the résumé delayed a clean line by "
                f"{(with_facts or 0) - (without or 0)} chars: {line!r}",
            )

    async def test_a_recital_still_speaks_NOTHING_at_production_size(self):
        # The other half: the shorter hold must not have bought the latency back
        # by giving up the protection.
        _, spoken = await self._consumed_before_first_audio(
            "Hi there, I can see you are a Senior Data Engineer at Infosys in "
            "Bengaluru with four years of experience. Am I speaking to Priya?",
            self.PROD_RESUME,
        )
        for word in ("Senior", "Data", "Engineer", "Infosys", "Bengaluru"):
            self.assertNotIn(word, spoken, f"résumé word spoken: {spoken!r}")

    async def test_a_BOUNDARYLESS_lead_past_the_cap_is_released_not_swallowed(self):
        # The lead seam is handed the UNSTRIPPED text, because `segment` is
        # `.strip()`ed and so can never end in a separator — the mid-word test
        # would then read every lead as possibly-mid-word and hold it.
        #
        # This is the only shape that distinguishes the two, found by measuring
        # rather than by argument: a lead with no punctuation at all, longer
        # than the 48-char cap, followed by a recital. With the raw text the
        # clean lead is released; with the stripped one it is held to
        # end-of-stream and then vetoed whole, so the caller hears nothing where
        # they should hear the opener. Stripped never speaks MORE — both
        # directions are leak-safe — but "unobservable" was wrong.
        lead = "a" * 60
        spoken = await self._spoken(
            [lead + " Senior Data Engineer at Infosys in Bengaluru with four "
                    "years of experience"])
        self.assertTrue(
            spoken.startswith("a" * 10),
            f"the clean lead was swallowed rather than released: {spoken!r}",
        )
        for word in ("Senior", "Data", "Engineer", "Infosys", "Bengaluru"):
            self.assertNotIn(word, spoken, f"résumé word spoken: {spoken!r}")

    async def test_a_clean_line_is_spoken_WHOLE_and_is_not_delayed(self):
        # The other half of the trade. The hold must be specific to a forming
        # résumé run: a clean line must release on the first boundary, exactly
        # as a screening turn does, and must arrive complete.
        line = ("Hi there, good morning! This is Christy calling from Interview "
                "Kickstart. Am I speaking with Christo?")
        waited, spoken = await self._consumed_before_first_audio(
            line, self.RESUME)
        self.assertEqual(spoken, line, "a clean line was altered")
        # Released on the segment "Hi there," — the same point the A0 screening
        # path releases at — minus the one chunk of lookahead.
        self.assertLessEqual(waited, len("Hi there, good "))

    async def test_a_shared_phrase_that_BREAKS_is_released_not_swallowed(self):
        # The hold must end when the run stops growing, or a line that merely
        # brushes the résumé would be truncated mid-sentence — the false
        # positive that matters, since the role title is BOTH a résumé fact and
        # a natural thing for the opener to mention.
        line = "Hi there, am I speaking with the Senior Data Engineer we wrote to?"
        self.assertEqual(await self._spoken([line]), line)

    async def test_a_run_still_FORMING_at_the_end_is_flushed_not_dropped(self):
        # The other end of the same seam. Here the line STOPS inside the shared
        # phrase, so the hold is still open when the stream ends and there is no
        # further chunk to break it. Those words were withheld for a check that
        # can no longer fire — the full-text veto has already passed on them —
        # so they must be spoken. Dropped instead, the candidate hears the
        # question amputated: "Hi there, am I speaking with the".
        line = "Hi there, am I speaking with the Senior Data Engineer?"
        self.assertEqual(await self._spoken([line]), line)


def _piece_chunks(text, size):
    """Fixed-width pieces — the shape a BPE/SentencePiece delta stream has.

    Word-at-a-time is the FRIENDLY case. A model emits sub-word deltas, and
    `" Seni"` + `"or"` is an ordinary way for "Senior" to arrive.
    """
    return [text[i:i + size] for i in range(0, len(text), size)]


class TestGateLeakVetoAtSubWordGranularity(unittest.IsolatedAsyncioTestCase):
    """The leak guarantee must not depend on the provider's tokenizer.

    A review found that the word-granularity fix still leaked when chunks split
    WORDS: the final token of the accumulated text is then a fragment
    ("seni", "info") that matches no control run, so the hold released
    mid-recital. Measured against the real `llm_node`, "Senior Data Engineer at"
    reached the caller at four- and six-character chunks while the identical
    line split on spaces reached nobody.

    Nothing in the code enforces whole-word chunks, and `phone.py` already
    handles `tts_node` "cutting mid-word", so this granularity is not
    hypothetical.
    """

    RESUME = TestGateWindowLeakVeto.RESUME
    RESUME_WORDS = ("Senior", "Data", "Engineer", "Infosys", "Bengaluru",
                    "Spark")

    async def _spoken(self, text, size):
        agent = TestGateWindowLeakVeto._agent(self, _piece_chunks(text, size))
        out = []
        async for chunk in agent.llm_node(
            types.SimpleNamespace(items=[]), [], None,
        ):
            out.append(chunk)
        return "".join(out)

    async def test_no_resume_word_airs_at_ANY_chunk_size(self):
        recitals = (
            "Hi there, I can see you are a Senior Data Engineer at Infosys in "
            "Bengaluru with four years of experience. Am I speaking to Priya?",
            "Senior Data Engineer at Infosys, in Bengaluru with four years of "
            "experience. Am I speaking to Priya?",
            "Hi, you are a Senior Data Engineer at Infosys in Bengaluru. "
            "Am I speaking to Priya?",
        )
        # 1 = character at a time, the pathological floor.
        for size in (1, 2, 3, 4, 6, 9):
            for line in recitals:
                spoken = await self._spoken(line, size)
                for word in self.RESUME_WORDS:
                    self.assertNotIn(
                        word, spoken,
                        f"chunk size {size} put {word!r} on the wire: "
                        f"{spoken!r}",
                    )

    async def test_a_clean_line_survives_ANY_chunk_size_intact(self):
        # The hold must not start eating ordinary greetings just because the
        # chunks got smaller.
        line = ("Hi there, good morning! This is Christy calling from Interview "
                "Kickstart. Am I speaking with Christo?")
        for size in (1, 2, 3, 4, 6, 9):
            self.assertEqual(await self._spoken(line, size), line,
                             f"chunk size {size} altered a clean line")


class TestEmittedMeansAudioNotChunks(unittest.IsolatedAsyncioTestCase):
    """`_gate_stream_emitted` must mean TEXT went out, not "a chunk went out".

    A role-only first delta — `delta.content = None`, which every
    OpenAI-compatible stream opens with — carries no text. Held behind the
    lookahead it can be the ONLY thing yielded before a recital trips the tail
    veto: zero audio, but the flag set.

    What that costs is not cosmetic. `_speak_gate_generation` then returns `""`
    ("spoken, transcript unknown") instead of `None`, so `_ask_identity` takes
    the unreadable branch and speaks `phone_identity_repair_text` — "Sorry — am
    I speaking to Priya?" — as the FIRST audio of the call, in place of
    `phone_identity_text`, which names us before it asks for them precisely
    because a cold call from an unknown number that opens by demanding who you
    are is the shape of a scam call. The consent turn then speaks the
    CONTINUATION disclosure, which deliberately carries no self-introduction —
    so the bot never identifies itself or the company at all.

    And it fires exactly when the leak veto fires: on the one path the veto
    exists for.
    """

    RESUME = TestGateWindowLeakVeto.RESUME

    async def _run(self, chunks):
        agent = TestGateWindowLeakVeto._agent(self, chunks)
        out = []
        async for chunk in agent.llm_node(
            types.SimpleNamespace(items=[]), [], None,
        ):
            out.append(chunk)
        return "".join(out), agent._gate_stream_emitted

    async def test_an_EMPTY_leading_delta_is_not_counted_as_audio(self):
        spoken, emitted = await self._run([
            "",
            "Hi there, ",
            "I can see you are a Senior Data Engineer at Infosys in Bengaluru "
            "with four years of experience. Am I speaking to Priya?",
        ])
        self.assertEqual(spoken, "", "a résumé recital reached the caller")
        self.assertFalse(
            emitted,
            "nothing was spoken, but the gate recorded audio — it will skip its "
            "own opener and lead with the repair line",
        )

    async def test_a_stream_of_ONLY_empty_deltas_emits_nothing(self):
        spoken, emitted = await self._run(["", "", ""])
        self.assertEqual(spoken, "")
        self.assertFalse(emitted)

    async def test_a_LETTER_FREE_chunk_is_not_counted_as_audio(self):
        # Non-empty is not the same as audible. `tts_node` merges letter-free
        # fragments forward — "no letter-free text is ever handed downstream" —
        # so a whitespace- or markdown-only chunk passes a `_chunk_text` test and
        # still makes no sound. Behind the one-word lookahead it can be the ONLY
        # thing yielded before the tail veto ends the turn, which lands in the
        # same place as the empty-delta case: the gate skips its own opener and
        # leads with "Sorry — am I speaking to X?".
        #
        # The `not released` branch below already requires a letter; these sites
        # have to agree with it.
        # The middle chunk matters. Without a clean boundary the whole lead is
        # vetoed before anything is yielded, the latch is never reached, and the
        # test passes whatever the latch does — which is how the first version
        # of this test let the mutation live. Here "Hi there," releases, the
        # lookahead retains it, and the LETTER-FREE chunk is the only thing that
        # actually goes out before the recital trips the tail veto.
        for lead in ("  ", "**", " — ", "\n"):
            spoken, emitted = await self._run([
                lead,
                "Hi there, ",
                "I can see you are a Senior Data Engineer at Infosys in "
                "Bengaluru with four years of experience. Am I speaking to "
                "Priya?",
            ])
            self.assertFalse(
                any(ch.isalpha() for ch in spoken),
                f"résumé text reached the caller: {spoken!r}")
            self.assertFalse(
                emitted,
                f"a letter-free lead {lead!r} was recorded as audio; the gate "
                f"will skip its own introduction and open with the repair line",
            )

    async def test_a_PUNCTUATION_ONLY_lead_does_not_veto_the_whole_line(self):
        # An em-dash-led opener. "— " ends with a boundary character, so the
        # release rule fires on it; `phone_streamed_leading_segment_safe` then
        # rejects letter-free text and the entire authored line is thrown away.
        # Fed as ONE chunk the same line is spoken in full — a granularity
        # difference, which is exactly the class of bug this file exists for.
        # The six-token floor used to mask it by never releasing that early.
        line = "— Hi there, this is Christy. Am I speaking with Christo?"
        for chunks in ([line], _token_chunks(line)):
            agent = TestGateWindowLeakVeto._agent(self, chunks)
            out = []
            async for chunk in agent.llm_node(
                types.SimpleNamespace(items=[]), [], None,
            ):
                out.append(chunk)
            self.assertEqual("".join(out), line,
                             f"a punctuation lead lost the line: {chunks!r}")
            self.assertTrue(agent._gate_stream_emitted)

    async def test_NON_LATIN_speech_counts_as_audio(self):
        # The latch tests `str.isalpha()`, which is Unicode-aware, while
        # `_COVERAGE_TOKEN_RE` is ASCII `[a-z0-9]+`. If the latch had used the
        # tokeniser instead, a Devanagari or Tamil line would go out with the
        # latch False and `run_phone_gate` would speak its fixed opener OVER live
        # audio — the 2026-09-09 double-opener. This bot calls Indian candidates;
        # the name and role fields are not reliably Latin.
        for line in (
            "नमस्ते, क्या मैं प्रिया से बात कर रहा हूँ?",
            "வணக்கம், நான் ப்ரியாவுடன் பேசுகிறேனா?",
            "Bonjour, êtes-vous Chloé Dubois?",
        ):
            spoken, emitted = await self._run(_token_chunks(line))
            self.assertEqual(spoken, line)
            self.assertTrue(emitted, f"non-Latin speech was not counted: {line!r}")

    async def test_a_LETTER_FREE_reply_speaks_nothing_at_all(self):
        # The other half of the same coherence rule. Letter-free text makes no
        # audio, so yielding it while leaving the latch False is the worst of
        # both: `run_phone_gate` speaks its fixed opener believing nothing went
        # out, and anything that did reach the wire lands underneath it.
        spoken, emitted = await self._run(["1234 5678 9012 3456 7890"])
        self.assertEqual(spoken, "")
        self.assertFalse(emitted)

    async def test_real_text_DOES_still_count_as_audio(self):
        # The guard must not swing the other way: a line that really is spoken
        # has to report so, or `run_phone_gate` speaks its fixed opener OVER the
        # top of it — the 2026-09-09 double-opener.
        line = ("Hi there, good morning! This is Christy calling from Interview "
                "Kickstart. Am I speaking with Christo?")
        spoken, emitted = await self._run(["", line])
        self.assertEqual(spoken, line)
        self.assertTrue(emitted)


class TestGateUnsafeTailAccounting(unittest.TestCase):
    """`phone_gate_unsafe_tail_chars` / `phone_gate_split_ready`.

    The retained amount is counted in CHARACTERS because chunk size is the
    provider's choice. Holding "one chunk" recalls a whole word from a
    word-at-a-time stream and a single LETTER from a character-at-a-time one —
    the same code, the same line, two different guarantees.
    """

    def test_the_final_whole_word_is_retained(self):
        # "a Senior" -> the last token starts 6 chars from the end.
        self.assertEqual(phone.phone_gate_unsafe_tail_chars("you are a Senior"),
                         len("Senior"))

    def test_a_trailing_separator_still_retains_the_word_before_it(self):
        # The word is complete, but it can still OPEN a run with whatever comes
        # next, so it is not yet safe to speak.
        self.assertEqual(
            phone.phone_gate_unsafe_tail_chars("you are a Senior "),
            len("Senior "))

    def test_text_with_no_complete_token_retains_everything(self):
        for text in ("", "   ", "--- ,,, "):
            self.assertEqual(phone.phone_gate_unsafe_tail_chars(text),
                             len(text), repr(text))

    def test_non_strings_retain_nothing_rather_than_raising(self):
        for bad in (None, 42, [], {"a": 1}):
            self.assertEqual(phone.phone_gate_unsafe_tail_chars(bad), 0)

    def test_the_split_rounds_toward_RETAINING(self):
        # Chunks are what gets yielded, so a chunk straddling the boundary must
        # be held, not split.
        self.assertEqual(phone.phone_gate_split_ready([5, 5, 5], 0), 3)
        self.assertEqual(phone.phone_gate_split_ready([5, 5, 5], 5), 2)
        self.assertEqual(phone.phone_gate_split_ready([5, 5, 5], 6), 1)
        self.assertEqual(phone.phone_gate_split_ready([5, 5, 5], 15), 0)
        # More unsafe than exists: retain everything rather than under-retain.
        self.assertEqual(phone.phone_gate_split_ready([5, 5, 5], 999), 0)
        self.assertEqual(phone.phone_gate_split_ready([], 4), 0)

    def test_one_character_chunks_still_retain_a_whole_word(self):
        # The regression this replaced: a one-CHUNK lookahead recalls one
        # character here, and "Senior" went out a letter at a time.
        lengths = [1] * len("you are a Senior")
        cut = phone.phone_gate_split_ready(
            lengths, phone.phone_gate_unsafe_tail_chars("you are a Senior"))
        self.assertEqual(cut, len("you are a "))


class TestRoleOpeningIsComposedNotStreamed(unittest.IsolatedAsyncioTestCase):
    """The role line must never ask a question. Live defect, 2026-09-12.

    The gate's model-authored role opening ended "To get us started, can you
    tell me a little about what you are doing right now?", the planned Q1 was
    asked a second later, and the candidate was asked two different things ~1s
    apart. The first reached no transcript row, so no scorer and no recruiter
    ever saw a question he had answered.

    The prompt caused it — it said "lead into the first question" AND "not with
    a question" — but the prompt is a request. `phone_role_opening_faithful`
    checks one thing, the verbatim role title, so a question-ending line passed
    it. The identity line has had a hard predicate since #288; this is the role
    line's.
    """

    ROLE = "Sales Program Advisor"

    def test_the_INSTRUCTION_no_longer_contradicts_itself(self):
        text = phone.phone_role_opening_instruction(self.ROLE)
        self.assertIsNotNone(text)
        low = text.lower()
        self.assertNotIn(
            "lead into the first question", low,
            "the instruction still tells the model to introduce the question",
        )
        self.assertIn("do not ask", low)
        # The role must still be demanded verbatim — that is the F1/call-24
        # guarantee and it is what the fallback exists to protect.
        self.assertIn(self.ROLE, text)

    def test_the_EXACT_live_line_is_rejected(self):
        live = ("Lovely, this chat is about the Sales Program Advisor role at "
                "Interview Kickstart. To get us started, can you tell me a "
                "little about what you are doing right now?")
        self.assertTrue(
            phone.phone_role_opening_faithful(live, self.ROLE),
            "the old check passed this line — that is why it shipped",
        )
        self.assertFalse(phone.phone_role_opening_clean(live, self.ROLE))

    def test_an_IMPERATIVE_request_with_no_question_mark_is_rejected(self):
        # Punctuation is not intent. "Tell me about X." asks just as hard as
        # "Can you tell me about X?" and a question-mark check misses it.
        line = ("This is about the Sales Program Advisor role. Tell me a little "
                "about your most recent job.")
        self.assertFalse(phone.phone_role_opening_clean(line, self.ROLE))

    def test_a_clean_role_line_is_ACCEPTED(self):
        line = ("Great — this chat is about the Sales Program Advisor role at "
                "Interview Kickstart, and I'm glad you could hop on.")
        self.assertTrue(phone.phone_role_opening_clean(line, self.ROLE))

    def test_a_RENAMED_role_is_still_rejected(self):
        line = "This is about the Engineering role, glad you could hop on."
        self.assertFalse(phone.phone_role_opening_clean(line, self.ROLE))

    async def test_compose_returns_None_rather_than_speaking_a_question(self):
        async def _asks(_instruction):
            return ("This is about the Sales Program Advisor role. So to start, "
                    "what are you working on right now?")
        self.assertIsNone(
            await phone.phone_compose_role_opening(self.ROLE, infer=_asks),
            "a question-ending draft must be withheld, not spoken then judged",
        )

    async def test_compose_returns_a_clean_draft(self):
        async def _clean(_instruction):
            return ("Lovely — this chat is about the Sales Program Advisor role "
                    "at Interview Kickstart, and I'm glad you could hop on.")
        got = await phone.phone_compose_role_opening(self.ROLE, infer=_clean)
        self.assertIsNotNone(got)
        self.assertIn(self.ROLE, got)

    async def test_compose_fails_SAFE_on_a_timeout_or_a_broken_provider(self):
        async def _hangs(_instruction):
            await asyncio.sleep(60)

        async def _explodes(_instruction):
            raise RuntimeError("provider down")

        async def _junk(_instruction):
            return {"not": "a string"}

        with patch.object(phone, "PHONE_ROLE_OPENING_COMPOSE_TIMEOUT_SEC", 0.05):
            self.assertIsNone(
                await phone.phone_compose_role_opening(self.ROLE, infer=_hangs))
        for bad in (_explodes, _junk):
            self.assertIsNone(
                await phone.phone_compose_role_opening(self.ROLE, infer=bad))

    async def test_no_role_title_composes_nothing(self):
        async def _never(_instruction):
            raise AssertionError("must not be called without a role")
        for role in (None, "", "   "):
            self.assertIsNone(
                await phone.phone_compose_role_opening(role, infer=_never))


class TestControlRunForming(unittest.TestCase):
    """`phone_control_run_forming` — the hold predicate, on its own.

    It exists because `phone_instruction_echo_detected` is blind until the
    sixth copied word. Its whole job is to say "a run is mid-growth, keep
    holding", so the two directions it can be wrong in are: never holding (the
    leak returns) and always holding (the gate goes mute).
    """

    RESUME = TestGateWindowLeakVeto.RESUME

    def test_a_run_in_progress_HOLDS(self):
        for tail in ("Senior Data", "Senior Data Engineer",
                     "Senior Data Engineer at", "Senior Data Engineer at Infosys"):
            self.assertTrue(
                phone.phone_control_run_forming(f"Hi there, you are a {tail} ",
                                                self.RESUME), tail)

    def test_a_SINGLE_shared_word_does_not_hold(self):
        # The measured reason for `_GATE_CONTROL_RUN_MIN_TOKENS = 2`. A real
        # résumé blob is prose and contains ordinary words, so holding on one
        # shared token holds every greeting built from ordinary words: with a
        # production-sized control, "Hi there, good morning! This is Christy
        # calling from Interview Kickstart." waited 63 chars for first audio —
        # worse than the 73-char hold this change exists to remove.
        #
        # Nothing is lost by it: the lookahead keeps the opening word of a run
        # recallable, so a recital is still stopped with NOTHING spoken.
        for tail in ("Senior", "Infosys", "Bengaluru", "experience"):
            self.assertFalse(
                phone.phone_control_run_forming(f"Are you the {tail} ",
                                                self.RESUME), tail)

    def test_text_that_touches_NOTHING_in_the_control_releases(self):
        for tail in ("Hi there,", "Hi there, good morning! This is Christy ",
                     "Am I speaking to Priya?"):
            self.assertFalse(phone.phone_control_run_forming(tail, self.RESUME),
                             tail)

    def test_a_BROKEN_run_releases(self):
        # "Senior Data Engineer" is in the résumé; "we" is not, so the run has
        # ended and the held words are provably outside any six-word window.
        self.assertFalse(phone.phone_control_run_forming(
            "the Senior Data Engineer we ", self.RESUME))

    def test_a_run_at_the_very_END_of_the_control_cannot_hold(self):
        # A run that matches only the control's last few tokens can never grow
        # into a six-word window — there are not six tokens left to match — so
        # holding for it is pure delay with no protection bought. The index
        # therefore only takes start positions with room for a full window.
        control = ("alpha bravo charlie delta echo foxtrot golf hotel "
                   "india juliet zulu quebec")
        # Same pair, early enough that six tokens can follow: HOLD.
        self.assertTrue(
            phone.phone_control_run_forming("you said alpha bravo ", control))
        # The final pair: nothing can follow it, so there is nothing to wait for.
        self.assertFalse(
            phone.phone_control_run_forming("you said zulu quebec ", control))

    def test_an_EMPTY_or_short_control_never_holds(self):
        # Below six control tokens the echo detector is inert, so holding for it
        # would mute the gate forever for no possible benefit.
        for control in ("", "Senior Data Engineer", "   "):
            self.assertFalse(
                phone.phone_control_run_forming("you are a Senior ", control),
                repr(control))

    def test_non_strings_do_not_raise(self):
        for bad in (None, 42, [], {"a": 1}):
            self.assertFalse(phone.phone_control_run_forming(bad, self.RESUME))
            self.assertFalse(phone.phone_control_run_forming("Senior", bad))

    def test_it_is_CASE_and_PUNCTUATION_insensitive_like_the_detector(self):
        # Or a recital in different case would stream straight through the hold
        # and then be caught (or not) by a detector that folds case anyway.
        self.assertTrue(phone.phone_control_run_forming(
            "you are a SENIOR DATA ENGINEER,", self.RESUME))

    def test_text_that_may_end_MID_WORD_always_holds(self):
        # THE SUB-WORD LEAK. Providers split words — this file's own `tts_node`
        # notes guard against "cutting mid-word" — and a chunk ending inside one
        # leaves a FRAGMENT as the final token. "Seni" matches no run, so the
        # hold released in the middle of the recital it was holding for:
        # measured against the real `llm_node`, word-piece chunks put "Senior
        # Data Engineer at" on the wire while the same line split on spaces put
        # out nothing.
        #
        # So a prefix that may be mid-word is UNDECIDABLE and holds. The cost is
        # the rest of one word.
        for partial in ("you are a Seni", "you are a Senior Dat",
                        "Hi there, good mor"):
            self.assertTrue(
                phone.phone_control_run_forming(partial, self.RESUME), partial)
        # A separator proves the last token is whole, and then the ordinary rule
        # applies — otherwise this would hold every line forever.
        self.assertFalse(
            phone.phone_control_run_forming("Hi there, good morning! ",
                                            self.RESUME))


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
        # `first == first.rstrip()` was the original assertion here and it is
        # TRUE FOR EVERY STRING that does not end in whitespace — including
        # "Thanks for confirmin", the exact mid-word cut this test exists to
        # catch (verified by execution). It read as a guarantee and enforced
        # nothing. The property that actually holds: the fragment ends on a
        # word boundary, so its last token is a whole token of the source.
        self.assertTrue(first.strip(), first)
        # `assertIn(token, SOURCE_STRING)` was the previous attempt and it is
        # SUBSTRING containment — true for every prefix of every word, i.e. for
        # exactly the mid-word family it claimed to exclude ("Thanks for
        # confir" passed it). Split the source into WORDS so the membership
        # test means what it says.
        source = "Thanks for confirming that, let me ask about your experience."
        words = {w.strip(".,!?;:") for w in source.split()}
        last_token = first.split()[-1].strip(".,!?;:")
        self.assertIn(
            last_token, words,
            f"fragment ended mid-token: {first!r}",
        )
        # And the character the cut fell on is a boundary in the source, not
        # the middle of a token.
        cut = len(first.rstrip())
        self.assertTrue(
            cut >= len(source) or source[cut].isspace(),
            f"cut is not at a word boundary: {first!r}",
        )

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
        # THE PROPERTY THAT MATTERS, and the one nothing asserted: the digit run
        # must live INSIDE ONE synthesis. Deleting the back-off entirely used to
        # leave this class green while splitting the number into "987" +
        # "6543210" across two Sarvam calls — worse than the defect the back-off
        # was written for, and invisible to every assertion here.
        self.assertTrue(
            any("9876543210" in chunk for chunk in streams),
            f"the digit run was split across syntheses: {streams!r}",
        )

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
