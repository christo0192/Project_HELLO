"""The conversational gate (0095) — the identity turn before consent.

WHAT THIS IS GUARDING AGAINST. On 2026-09-09 a model folded an identity
question onto the end of the consent opening. The candidate answered the
identity ("yes, this is Christo"), the strict consent classifier could not read
that as consent, and the gate timed out to MACHINE and tore the call down. The
whole LLM opener was switched off in response.

The lesson was not "never ask who you are speaking to" — it was ONE QUESTION
GETS ONE CLASSIFIER. So the assertions below are mostly about separation:
that the identity answer never reaches the consent parser, that the identity
question can never carry a consent ask, and that a generated line is verified
BEFORE it is spoken rather than after.

The second theme is the asymmetry of the two fail-safe directions. Consent
fails CLOSED (unreadable ⇒ do not proceed). Identity fails OPEN (unreadable ⇒
keep talking), because hanging up on the actual applicant is far more costly
than one wasted screening.
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


class TestIdentityVerifier(unittest.TestCase):
    """`_identity_is_verified` — the check that runs BEFORE anything is spoken."""

    def test_accepts_a_greeting_that_ends_on_the_identity_ask(self):
        for text in (
            "Hi, this is Christy from Interview Kickstart. Am I speaking to Priya?",
            "Hello! Am I speaking with Priya?",
            "Hi there — have I reached Priya?",
        ):
            self.assertTrue(phone._identity_is_verified(text), text)

    def test_rejects_a_line_that_folds_the_consent_ask_in(self):
        # THE 2026-09-09 SHAPE, with the roles reversed. If this were spoken,
        # the candidate's answer would be about recording and the name-mismatch
        # check would run against it.
        self.assertFalse(phone._identity_is_verified(
            "Hi, am I speaking to Priya, and is it okay to continue?"))
        self.assertFalse(phone._identity_is_verified(
            "Am I speaking to Priya? Is it okay if I record this and continue?"))

    def test_rejects_a_line_that_does_not_end_on_a_question(self):
        self.assertFalse(phone._identity_is_verified(
            "Am I speaking to Priya? This call is recorded."))
        self.assertFalse(phone._identity_is_verified("Hi Priya, good to reach you."))

    def test_rejects_empty_and_non_string(self):
        for bad in ("", "   ", None, 42, [], {}):
            self.assertFalse(phone._identity_is_verified(bad), repr(bad))


class TestMismatchDecision(unittest.TestCase):
    """Who gets hung up on — and, far more importantly, who does not."""

    def test_a_matching_or_unreadable_reply_proceeds(self):
        # `phone_name_mismatch` returns None for all of these, so the gate never
        # even reaches the re-ask. The last three matter most: a bare "yes",
        # silence, and a mumble are what most real candidates actually say.
        for reply in (
            "Yes, this is Priya.", "My name is Priya.", "Priya here.",
            "This is Preeya.",        # transliteration variant
            "My name is Sharma.",     # first/last ordering swap
            "Yes.", "Speaking.", "", "mm-hmm", "Who's this?",
        ):
            self.assertIsNone(phone.phone_name_mismatch(reply, NAME), reply)

    def test_only_an_extracted_different_name_reaches_the_reask(self):
        for reply in ("My name is Ravi.", "This is Ravi speaking.", "Myself Ravi."):
            self.assertIsNotNone(phone.phone_name_mismatch(reply, NAME), reply)

    def test_the_reask_hangs_up_only_on_an_explicit_denial_or_a_second_name(self):
        for reply in ("No, this is Ravi.", "No.", "Wrong number.",
                      "She's not here.", "No one by that name here.",
                      "My name is Ravi."):
            self.assertTrue(
                phone.phone_identity_reask_confirms_mismatch(reply, NAME), reply)

    def test_the_reask_keeps_talking_on_anything_else(self):
        # FAIL-OPEN, and each of these is a real thing a candidate says while
        # confirming they ARE the candidate. "No worries" is the one that would
        # bite a naive bare-negative match.
        for reply in ("Yes, that's me.", "Yeah, Priya here.", "Speaking.",
                      "No worries, that's me.", "I'm not sure what this is about, but yes.",
                      "", "mmm", "Sorry, could you repeat that?"):
            self.assertFalse(
                phone.phone_identity_reask_confirms_mismatch(reply, NAME), reply)


class TestGateFlowFlag(unittest.TestCase):
    def setUp(self):
        os.environ.pop("PHONE_GATE_FLOW", None)

    tearDown = setUp

    def test_default_is_deterministic_so_merging_changes_nothing(self):
        self.assertEqual(phone.phone_gate_flow(), "deterministic")

    def test_only_the_exact_token_opts_in(self):
        for raw in ("conversational", "CONVERSATIONAL", "  conversational  "):
            os.environ["PHONE_GATE_FLOW"] = raw
            self.assertEqual(phone.phone_gate_flow(), "conversational", raw)
        for raw in ("convo", "true", "1", "on", "yes", "llm", ""):
            os.environ["PHONE_GATE_FLOW"] = raw
            self.assertEqual(phone.phone_gate_flow(), "deterministic", raw)


class TestComposerSpeaksNothing(unittest.TestCase):
    """The composer returns TEXT. It is the reason verify-then-speak holds."""

    def test_it_returns_the_draft_and_never_touches_tts(self):
        async def fake_infer(_instruction):
            return "  Hi! Am I speaking to Priya?  "
        got = _run(phone.phone_compose_identity_line(NAME, infer=fake_infer))
        self.assertEqual(got, "Hi! Am I speaking to Priya?")

    def test_every_failure_returns_none_so_the_caller_speaks_its_fixed_line(self):
        async def boom(_i):
            raise RuntimeError("provider down")

        async def slow(_i):
            await asyncio.sleep(phone.PHONE_IDENTITY_COMPOSE_TIMEOUT_SEC + 0.5)
            return "too late"

        async def empty(_i):
            return "   "

        async def not_a_string(_i):
            return {"text": "nope"}

        for infer in (boom, slow, empty, not_a_string):
            self.assertIsNone(
                _run(phone.phone_compose_identity_line(NAME, infer=infer)),
                infer.__name__,
            )

    def test_no_usable_name_means_no_instruction_and_no_call(self):
        called = []

        async def spy(instruction):
            called.append(instruction)
            return "Hi?"

        for bad in (None, "", "   ", 42, "x" * 41):
            self.assertIsNone(_run(phone.phone_compose_identity_line(bad, infer=spy)))
        self.assertEqual(called, [], "the model was called with no name to ask about")

    def test_the_instruction_forbids_the_consent_ask(self):
        instruction = phone.phone_identity_instruction(NAME)
        self.assertIsNotNone(instruction)
        lowered = instruction.lower()
        self.assertIn("priya", lowered)
        self.assertIn("exactly one question", lowered)
        self.assertIn("do not mention recording", lowered)


class TestFixedFallbackCopy(unittest.TestCase):
    def test_the_fixed_identity_line_passes_its_own_verifier(self):
        # The fallback must satisfy the check that rejected the generated draft,
        # or a verification failure would speak something equally unusable.
        self.assertTrue(phone._identity_is_verified(phone.phone_identity_text(NAME)))
        self.assertTrue(phone._identity_is_verified(phone.phone_identity_text(None)))

    def test_it_names_us_before_it_asks_for_them(self):
        line = phone.phone_identity_text(NAME)
        self.assertLess(line.index("Christy"), line.index("Priya"))
        self.assertIn("Priya", line)
        self.assertNotIn("Sharma", line, "a full legal name reads as a debt collector")

    def test_neither_gate_line_mentions_recording(self):
        # Recording belongs to the consent turn. A disclosure that arrives one
        # turn early is a disclosure the candidate did not consent to yet.
        for line in (phone.phone_identity_text(NAME),
                     phone.phone_identity_text(None),
                     phone.phone_identity_reask_text(NAME),
                     phone.phone_identity_reask_text(None)):
            self.assertNotIn("record", line.lower(), line)

    def test_the_reask_is_a_closed_question_and_does_not_accuse(self):
        line = phone.phone_identity_reask_text(NAME)
        self.assertTrue(line.rstrip().endswith("?"))
        self.assertIn("Priya", line)


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
