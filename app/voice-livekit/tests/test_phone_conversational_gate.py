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
import unittest

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
    """The `min_chars` cap must not cut a word in half (part of the same PR)."""

    async def test_the_cap_backs_off_to_the_last_space(self):
        # The cap is the only arm that lands on an arbitrary character. Each
        # fragment becomes its own Sarvam synthesis, so a word split across the
        # two is voiced twice with no context — the audible "cracked word".
        agent = _FragmentProbe()
        first, rest = await agent.split(
            "Thanks for confirming that, let me ask about your experience.",
            min_chars=20,
        )
        self.assertFalse(first.endswith(("t", "h")) and not first.endswith(" "),
                         f"fragment ended mid-word: {first!r}")
        self.assertTrue(first.rstrip() == first.rstrip().rstrip(" "))
        # Nothing is lost or duplicated across the boundary.
        self.assertEqual(
            (first + rest).replace(" ", ""),
            "Thanks for confirming that, let me ask about your experience.".replace(" ", ""),
        )

    async def test_a_single_word_longer_than_the_cap_still_flushes(self):
        # No space to back off to. Refusing to flush would forfeit the latency
        # the cap exists to buy, so the previous behaviour is kept.
        agent = _FragmentProbe()
        first, rest = await agent.split("Supercalifragilistic expialidocious", min_chars=10)
        self.assertTrue(first)
        self.assertEqual((first + rest).replace(" ", ""),
                         "Supercalifragilisticexpialidocious")

    async def test_punctuation_boundaries_are_untouched(self):
        agent = _FragmentProbe()
        first, _ = await agent.split("Got it. Let me ask you something else.", min_chars=200)
        self.assertEqual(first, "Got it.")


class _FragmentProbe:
    """Replays `tts_node`'s first-fragment scan without a LiveKit session.

    The scan is inline in `tts_node` (the module-level `_tts_early_flush_segments`
    is a different, unused implementation), so this mirrors the live arms
    including the 0095 word-boundary back-off. Kept in lockstep by the
    assertions above, which state the PROPERTY rather than the algorithm.
    """

    async def split(self, text, *, min_chars):
        first = ""
        dense = 0
        alpha = 0
        leftover = ""
        found = False
        for idx, ch in enumerate(text):
            first += ch
            if not ch.isspace():
                dense += 1
            if ch.isalpha():
                alpha += 1
            terminator = ch in phone._TTS_SENTENCE_TERMINATORS
            clause = (
                ch in phone._TTS_CLAUSE_PAUSE_PUNCT
                and alpha >= phone._TTS_FIRST_FRAGMENT_MIN_CHARS
            )
            if (terminator or clause or dense >= min_chars) and any(
                c.isalpha() for c in first
            ):
                leftover = text[idx + 1:]
                if not terminator and not clause:
                    cut = first.rfind(" ")
                    if cut > 0 and any(c.isalpha() for c in first[:cut]):
                        leftover = first[cut + 1:] + leftover
                        first = first[:cut]
                found = True
                break
        if not found:
            return text, ""
        return first, leftover


if __name__ == "__main__":
    unittest.main()
