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
        # Production filters these at the producer (`on_candidate_turn`) by
        # comparing that start against the question anchor; the harness applies
        # the same rule at the reader, which is observably identical.
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
        # EXPLICIT now. Since the 2026-09-11 flip an unset selects the
        # conversational flow, so a test of the rollback path must set the
        # rollback token — popping it would silently test the new default.
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
        chunks = [
            "Hi, this is Christy calling about your application. ",
            "I can see you are a Senior Data Engineer at Infosys in Bengaluru ",
            "with four years of experience. Am I speaking to Priya?",
        ]
        spoken = await self._spoken(chunks)
        self.assertTrue(spoken.startswith("Hi, this is Christy"))
        self.assertNotIn("Infosys in Bengaluru with four years", spoken)

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
