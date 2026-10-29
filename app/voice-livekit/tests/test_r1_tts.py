"""R1's early-flush text-to-speech node (plan 5.15).  Pure python: no SDK, no network.

The scanner is checked alone (where the first fragment ends, whatever the chunking) and the
driver is checked against a fake downstream node that records how many times it was called,
with what text, and when it started relative to the audio already delivered.
"""
from __future__ import annotations

import ast
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_tts
from r1_tts import (
    FirstFragmentScanner,
    aiter_text,
    flush_min_chars,
    flush_tts,
    r1_tts_kwargs,
    speakable,
)


def split_all(text: str, size: int, min_chars: int = 60) -> tuple[str, str] | None:
    """Feed ``text`` in ``size``-character chunks; return (fragment, everything after it)."""
    scanner = FirstFragmentScanner(min_chars)
    chunks = [text[i : i + size] for i in range(0, len(text), size)]
    for position, chunk in enumerate(chunks):
        found = scanner.feed(chunk)
        if found is not None:
            fragment, rest = found
            return fragment, rest + "".join(chunks[position + 1 :])
    return None


class TestScanner(unittest.TestCase):
    def test_a_sentence_ends_the_first_fragment(self) -> None:
        self.assertEqual(split_all("Hello there. How are you?", 100), ("Hello there.", " How are you?"))

    def test_a_boundary_at_the_end_of_a_chunk_waits_for_the_next_character(self) -> None:
        scanner = FirstFragmentScanner(60)
        self.assertIsNone(scanner.feed("Hello there."))  # the next character decides
        self.assertEqual(scanner.feed(" How"), ("Hello there.", " How"))

    def test_a_point_inside_a_number_is_not_a_boundary(self) -> None:
        text = "The cohort runs for 3.5 months in total. Then it ends"
        self.assertEqual(
            split_all(text, 100), ("The cohort runs for 3.5 months in total.", " Then it ends")
        )

    def test_a_thousands_comma_is_not_a_clause_pause(self) -> None:
        # alpha >= 14 before "$9," so the comma WOULD be a clause pause were it followed by a space.
        text = "The total program fee is about $9,000 for everyone"
        scanner = FirstFragmentScanner(60)
        self.assertIsNone(scanner.feed(text))
        self.assertEqual(scanner.finish(), text)

    def test_an_abbreviation_without_a_following_space_is_not_a_boundary(self) -> None:
        text = "We cover e.g.tools and more. Next"
        self.assertEqual(split_all(text, 100), ("We cover e.g.tools and more.", " Next"))

    def test_a_clause_pause_flushes_once_the_fragment_is_a_natural_unit(self) -> None:
        text = "Great question about the fees, let me explain how it works. More"
        self.assertEqual(
            split_all(text, 100),
            ("Great question about the fees,", " let me explain how it works. More"),
        )

    def test_a_short_leading_filler_merges_forward(self) -> None:
        text = "Mm, got it, thanks for sharing that. Next"
        self.assertEqual(
            split_all(text, 100), ("Mm, got it, thanks for sharing that.", " Next")
        )

    def test_a_fragment_without_a_letter_is_never_flushed(self) -> None:
        text = "2019. Great year to start. Then"
        self.assertEqual(split_all(text, 100), ("2019. Great year to start.", " Then"))

    def test_the_length_cap_backs_off_to_the_last_space_and_never_cuts_a_word(self) -> None:
        text = "Our program covers machine learning fundamentals and applied projects thoroughly"
        fragment, rest = split_all(text, 100, min_chars=30)
        self.assertTrue(fragment.endswith(" "))
        self.assertEqual(fragment, "Our program covers machine ")
        self.assertEqual(fragment + rest, text)  # nothing dropped, nothing reordered
        self.assertTrue(rest.startswith("lea"))  # the partial word goes forward whole

    def test_a_cap_with_no_natural_cut_waits_for_a_boundary(self) -> None:
        # No space to cut at and fewer than 14 letters in any head: do not cut mid-word.
        self.assertIsNone(split_all("Supercalifragilisticexpialidocious", 100, min_chars=10))

    def test_a_cap_of_zero_never_cuts_by_length(self) -> None:
        text = "word " * 40
        self.assertIsNone(split_all(text, 100, min_chars=0))

    def test_chunking_never_changes_the_split(self) -> None:
        texts = (
            "Hello there. How are you today? Fine.",
            "Great question about the fees, let me explain how it works. More",
            "The cohort runs for 3.5 months. It costs $9,000 in total, which includes everything.",
            "Mm, got it, thanks for sharing that. Next",
            "Our program covers machine learning fundamentals and applied projects thoroughly",
            "2019. Great year to start. Then",
            "Right? Okay, so what draws you to this role, honestly, at this point in time?",
        )
        for text in texts:
            reference = split_all(text, len(text))
            for size in (1, 2, 3, 5, 7, 16):
                with self.subTest(text=text, size=size):
                    self.assertEqual(split_all(text, size), reference)
            if reference is not None:
                self.assertEqual("".join(reference), text)

    def test_finish_returns_what_was_buffered(self) -> None:
        scanner = FirstFragmentScanner(60)
        self.assertIsNone(scanner.feed("Hello"))
        self.assertIsNone(scanner.feed(" there"))
        self.assertEqual(scanner.finish(), "Hello there")
        self.assertEqual(scanner.finish(), "")

    def test_speakable_needs_a_letter(self) -> None:
        self.assertTrue(speakable("2019, ok"))
        self.assertFalse(speakable("2019. $7,000 ... "))
        self.assertFalse(speakable("  "))


class Downstream:
    """A fake downstream ``tts_node``: records its calls and the order things happen in."""

    def __init__(self, frames_per_call: int = 2) -> None:
        self.frames_per_call = frames_per_call
        self.calls: list[str] = []
        self.events: list[str] = []
        self.closed = 0

    def __call__(self, stream):
        return self._run(stream)

    async def _run(self, stream):
        number = len(self.calls) + 1
        self.calls.append("")
        self.events.append(f"start {number}")
        try:
            parts = []
            async for chunk in stream:
                parts.append(chunk)
            self.calls[number - 1] = "".join(parts)
            for index in range(self.frames_per_call):
                yield f"frame {number}.{index}"
        finally:
            self.closed += 1
            self.events.append(f"end {number}")


async def drip(*chunks: str, gap: float = 0.0, closed: list | None = None):
    """A text source that releases ``chunks`` one at a time, like the output guard does."""
    try:
        for chunk in chunks:
            if gap:
                await asyncio.sleep(gap)
            else:
                await asyncio.sleep(0)
            yield chunk
    finally:
        if closed is not None:
            closed.append(True)


async def collect(generator) -> list:
    return [item async for item in generator]


class TestFlushDriver(unittest.IsolatedAsyncioTestCase):
    async def test_a_reply_is_synthesised_in_two_calls_and_loses_no_text(self) -> None:
        node = Downstream()
        frames = await collect(
            flush_tts(
                drip("Hello there. ", "How are you today? ", "Fine."), node, min_chars=60
            )
        )
        self.assertEqual(node.calls, ["Hello there.", " How are you today? Fine."])
        self.assertEqual("".join(node.calls), "Hello there. How are you today? Fine.")
        self.assertEqual(frames, ["frame 1.0", "frame 1.1", "frame 2.0", "frame 2.1"])

    async def test_the_remainder_starts_only_after_the_first_fragments_audio_is_out(self) -> None:
        node = Downstream()
        seen: list[str] = []
        async for frame in flush_tts(drip("Hello there. ", "More to say."), node, min_chars=60):
            seen.append(f"got {frame}")
            node.events.append(f"got {frame}")
        self.assertEqual(
            node.events,
            [
                "start 1",
                "got frame 1.0",
                "got frame 1.1",
                "end 1",
                "start 2",
                "got frame 2.0",
                "got frame 2.1",
                "end 2",
            ],
        )

    async def test_the_first_fragment_is_sent_before_the_rest_of_the_text_exists(self) -> None:
        # The point of the node: the first sentence is synthesised while the model is still
        # producing the second.  The second chunk is held until the first call has finished.
        release = asyncio.Event()
        node = Downstream()

        async def source():
            yield "Hello there. "
            await release.wait()
            yield "Second sentence."

        generator = flush_tts(source(), node, min_chars=60)
        first = await asyncio.wait_for(generator.__anext__(), 1.0)
        self.assertEqual(first, "frame 1.0")
        self.assertEqual(node.calls, ["Hello there."])  # call 1 is complete, call 2 not begun
        release.set()
        rest = await collect(generator)
        self.assertEqual(rest, ["frame 1.1", "frame 2.0", "frame 2.1"])
        self.assertEqual(node.calls, ["Hello there.", " Second sentence."])

    async def test_a_zero_cap_is_the_rollback_one_call_for_the_whole_stream(self) -> None:
        node = Downstream()
        frames = await collect(
            flush_tts(drip("Hello there. ", "More to say."), node, min_chars=0)
        )
        self.assertEqual(node.calls, ["Hello there. More to say."])
        self.assertEqual(frames, ["frame 1.0", "frame 1.1"])

    async def test_a_text_with_no_boundary_is_one_call(self) -> None:
        node = Downstream()
        await collect(flush_tts(drip("Hello", " there"), node, min_chars=60))
        self.assertEqual(node.calls, ["Hello there"])

    async def test_a_reply_that_ends_at_its_first_boundary_makes_no_empty_second_call(self) -> None:
        node = Downstream()
        await collect(flush_tts(drip("Hello there. "), node, min_chars=60))
        self.assertEqual(node.calls, ["Hello there."])

    async def test_a_remainder_with_no_letter_is_never_sent_alone(self) -> None:
        node = Downstream()
        await collect(flush_tts(drip("Hello there. ", "  "), node, min_chars=60))
        self.assertEqual(node.calls, ["Hello there."])

    async def test_a_letter_free_lead_of_the_remainder_waits_for_its_words(self) -> None:
        node = Downstream()
        await collect(flush_tts(drip("Done. ", "2019. ", "That was a good year."), node, min_chars=60))
        self.assertEqual(node.calls, ["Done.", " 2019. That was a good year."])

    async def test_a_text_with_no_letter_makes_no_call_at_all(self) -> None:
        node = Downstream()
        frames = await collect(flush_tts(drip("2019", "."), node, min_chars=60))
        self.assertEqual((node.calls, frames), ([], []))

    async def test_an_empty_text_makes_no_call(self) -> None:
        node = Downstream()
        self.assertEqual(await collect(flush_tts(drip(), node, min_chars=60)), [])
        self.assertEqual(node.calls, [])

    async def test_every_text_shape_the_sdk_may_hand_over_is_accepted(self) -> None:
        for source in ("Hello there. More.", ["Hello there. ", "More."], iter(["Hello there. More."])):
            with self.subTest(source=type(source).__name__):
                node = Downstream()
                await collect(flush_tts(source, node, min_chars=60))
                self.assertEqual("".join(node.calls).strip(), "Hello there. More.")

    async def test_a_downstream_node_that_must_be_awaited_is_accepted(self) -> None:
        node = Downstream()

        async def awaited(stream):
            return node(stream)

        frames = await collect(flush_tts(drip("Hello there. ", "More."), awaited, min_chars=60))
        self.assertEqual(len(frames), 4)

    async def test_the_callbacks_fire_once_and_in_order(self) -> None:
        node = Downstream()
        order: list[str] = []
        async for _frame in flush_tts(
            drip("Hello there. ", "More to say."),
            node,
            min_chars=60,
            on_first_text=lambda: order.append("text"),
            on_first_frame=lambda: order.append("frame"),
        ):
            pass
        self.assertEqual(order, ["text", "frame"])

    async def test_the_callbacks_fire_in_the_rollback_path_too(self) -> None:
        node = Downstream()
        order: list[str] = []
        await collect(
            flush_tts(
                drip("Hello there."),
                node,
                min_chars=0,
                on_first_text=lambda: order.append("text"),
                on_first_frame=lambda: order.append("frame"),
            )
        )
        self.assertEqual(order, ["text", "frame"])

    async def test_a_failing_callback_never_disturbs_the_audio(self) -> None:
        node = Downstream()

        def boom() -> None:
            raise RuntimeError("instrumentation bug")

        frames = await collect(
            flush_tts(
                drip("Hello there. ", "More."),
                node,
                min_chars=60,
                on_first_text=boom,
                on_first_frame=boom,
            )
        )
        self.assertEqual(len(frames), 4)

    async def test_stopping_early_closes_the_downstream_node(self) -> None:
        node = Downstream(frames_per_call=3)
        generator = flush_tts(drip("Hello there. ", "More to say."), node, min_chars=60)
        self.assertEqual(await generator.__anext__(), "frame 1.0")
        await generator.aclose()  # a barge-in tears the pipeline down
        self.assertEqual(node.closed, 1)  # closed now, not left for the garbage collector
        self.assertEqual(node.events[-1], "end 1")
        self.assertEqual(node.calls, ["Hello there."])  # the remainder was never started

    async def test_cancellation_is_not_swallowed(self) -> None:
        node = Downstream()
        gate = asyncio.Event()

        async def stuck():
            yield "Hello "
            await gate.wait()
            yield "there."

        task = asyncio.ensure_future(collect(flush_tts(stuck(), node, min_chars=60)))
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task


class TestAiterText(unittest.IsolatedAsyncioTestCase):
    async def test_chunks_are_normalised_to_strings_and_empties_dropped(self) -> None:
        self.assertEqual(await collect(aiter_text("abc")), ["abc"])
        self.assertEqual(await collect(aiter_text(["a", "", 3])), ["a", "3"])
        self.assertEqual(await collect(aiter_text(drip("x", "", "y"))), ["x", "y"])


class TestSettings(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ("R1_TTS_FLUSH_MIN_CHARS", "SARVAM_TTS_MODEL", "SARVAM_TTS_VOICE"):
            os.environ.pop(key, None)

    def test_the_default_cap_is_sixty_characters(self) -> None:
        self.assertEqual(flush_min_chars(), 60)

    def test_the_cap_can_be_set_disabled_and_is_bounded(self) -> None:
        cases = {"0": 0, "25": 25, "400": 400, "9999": 400, "-5": 0, " 80 ": 80}
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                os.environ["R1_TTS_FLUSH_MIN_CHARS"] = raw
                self.assertEqual(flush_min_chars(), expected)

    def test_a_malformed_cap_falls_back_to_the_default(self) -> None:
        for raw in ("", "  ", "abc", "1.5", "nan"):
            with self.subTest(raw=raw):
                os.environ["R1_TTS_FLUSH_MIN_CHARS"] = raw
                self.assertEqual(flush_min_chars(), 60)

    def test_the_voice_is_the_browser_lanes_voice(self) -> None:
        self.assertEqual(
            r1_tts_kwargs(),
            {"model": "bulbul:v3", "speaker": "simran", "pace": 1.0, "temperature": 0.8},
        )
        os.environ["SARVAM_TTS_MODEL"] = "bulbul:v2"
        os.environ["SARVAM_TTS_VOICE"] = "anushka"
        kwargs = r1_tts_kwargs()
        self.assertEqual((kwargs["model"], kwargs["speaker"]), ("bulbul:v2", "anushka"))


class TestModuleSurface(unittest.TestCase):
    def test_the_node_imports_nothing_from_phone_or_the_session(self) -> None:
        tree = ast.parse(Path(r1_tts.__file__).read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(
            imported,
            {"__future__", "contextlib", "contextvars", "dataclasses", "inspect", "os", "typing"},
        )


VOICE_ENV = (
    "R1_TTS_PROFILE",
    "R1_TTS_INTERVIEWER_VOICE",
    "R1_TTS_LEARNER_VOICE",
    "SARVAM_TTS_MODEL",
    "SARVAM_TTS_VOICE",
)
TODAY = {"model": "bulbul:v3", "speaker": "simran", "pace": 1.0, "temperature": 0.8}


class TestVoices(unittest.TestCase):
    """R1's two voices (owner decision 2026-10-30): one atomic switch, an allowlist, no mixing."""

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in VOICE_ENV:
            os.environ.pop(key, None)

    def test_the_v3_profile_is_todays_voice_exactly(self) -> None:
        os.environ["R1_TTS_PROFILE"] = "v3"
        os.environ["R1_TTS_INTERVIEWER_VOICE"] = "shalini_en_customer"  # ignored under v3
        os.environ["R1_TTS_LEARNER_VOICE"] = "neha_en_customer"
        voices = r1_tts.r1_voice_set()
        self.assertEqual(voices.profile, "v3")
        self.assertEqual(r1_tts_kwargs(), TODAY)
        for role in r1_tts.VOICES:
            self.assertEqual(voices.kwargs(role), TODAY)
        self.assertEqual(voices.notes, ())
        self.assertFalse(voices.distinct)
        # It still follows the browser lane's variables, exactly as today.
        os.environ["SARVAM_TTS_MODEL"] = "bulbul:v2"
        os.environ["SARVAM_TTS_VOICE"] = "anushka"
        voices = r1_tts.r1_voice_set()
        self.assertEqual(voices.kwargs("learner"), r1_tts_kwargs())
        self.assertEqual(voices.speaker("interviewer"), "anushka")
        self.assertEqual(voices.model, "bulbul:v2")

    def test_an_unset_profile_is_v4_with_the_owner_voices(self) -> None:
        os.environ["SARVAM_TTS_MODEL"] = "bulbul:v3"  # the screener's voice: ignored by v4
        os.environ["SARVAM_TTS_VOICE"] = "simran"
        for raw in (None, "", "v4", " V4 ", "v4\n"):
            with self.subTest(raw=raw):
                if raw is None:
                    os.environ.pop("R1_TTS_PROFILE", None)
                else:
                    os.environ["R1_TTS_PROFILE"] = raw
                voices = r1_tts.r1_voice_set()
                self.assertEqual(voices.profile, "v4")
                self.assertEqual(
                    voices.kwargs("interviewer"),
                    {"model": "bulbul:v4-flash", "speaker": "simran_en_customer", "pace": 1.0},
                )
                self.assertEqual(
                    voices.kwargs("learner"),
                    {"model": "bulbul:v4-flash", "speaker": "zarina_en_conversation", "pace": 1.0},
                )
                self.assertNotIn("temperature", voices.kwargs("learner"))
                self.assertEqual(voices.notes, ())
                self.assertTrue(voices.distinct)
        for raw in ("v3", " V3 ", "v3\n"):
            with self.subTest(raw=raw):
                os.environ["R1_TTS_PROFILE"] = raw
                self.assertEqual(r1_tts.r1_voice_set().profile, "v3")

    def test_an_unknown_profile_falls_back_to_v3_and_says_so(self) -> None:
        for raw in ("bulbul-v4", "4", "on", "v5", "bulbul:v4-flash"):
            with self.subTest(raw=raw):
                os.environ["R1_TTS_PROFILE"] = raw
                voices = r1_tts.r1_voice_set()
                self.assertEqual(voices.profile, "v3")
                self.assertEqual(voices.kwargs("learner"), TODAY)
                self.assertEqual(voices.notes, ("profile_unknown",))

    def test_voice_overrides_apply_in_v4_only_and_only_from_the_allowlist(self) -> None:
        os.environ["R1_TTS_LEARNER_VOICE"] = "neha_en_customer"
        os.environ["R1_TTS_INTERVIEWER_VOICE"] = " shalini_en_customer "
        voices = r1_tts.r1_voice_set()
        self.assertEqual(voices.speaker("learner"), "neha_en_customer")
        self.assertEqual(voices.speaker("interviewer"), "shalini_en_customer")
        self.assertEqual(voices.notes, ())
        for bad in ("simran", "nobody_en_test", "  ", "\t", "Zarina_en_conversation"):
            with self.subTest(bad=bad):
                os.environ["R1_TTS_LEARNER_VOICE"] = bad
                os.environ["R1_TTS_INTERVIEWER_VOICE"] = bad
                voices = r1_tts.r1_voice_set()
                self.assertEqual(voices.speaker("learner"), "zarina_en_conversation")
                self.assertEqual(voices.speaker("interviewer"), "simran_en_customer")
                self.assertEqual(
                    voices.notes, ("interviewer_voice_rejected", "learner_voice_rejected")
                )
        os.environ["R1_TTS_LEARNER_VOICE"] = ""
        os.environ["R1_TTS_INTERVIEWER_VOICE"] = ""
        voices = r1_tts.r1_voice_set()
        self.assertEqual(voices.notes, ())
        self.assertEqual(voices.speaker("learner"), "zarina_en_conversation")

    def test_both_voices_always_share_one_model(self) -> None:
        profiles = (None, "", "v4", "v3", "V3", "bogus")
        overrides = (None, "", "simran", "neha_en_customer", "nobody_en_test")
        for profile in profiles:
            for interviewer in overrides:
                for learner in overrides:
                    for key, value in (
                        ("R1_TTS_PROFILE", profile),
                        ("R1_TTS_INTERVIEWER_VOICE", interviewer),
                        ("R1_TTS_LEARNER_VOICE", learner),
                    ):
                        if value is None:
                            os.environ.pop(key, None)
                        else:
                            os.environ[key] = value
                    voices = r1_tts.r1_voice_set()
                    with self.subTest(profile=profile, interviewer=interviewer, learner=learner):
                        self.assertEqual(
                            voices.kwargs("interviewer")["model"], voices.kwargs("learner")["model"]
                        )
                        if voices.model == "bulbul:v4-flash":
                            # never a v3 short name on v4, the in-band 400 of a half-flip
                            for role in r1_tts.VOICES:
                                self.assertIn(voices.speaker(role), r1_tts.V4_SPEAKERS)
                        else:
                            self.assertEqual(voices.kwargs("learner"), r1_tts_kwargs())
        with self.assertRaises(ValueError):
            r1_tts.R1VoiceSet(
                "v4",
                {"model": "bulbul:v4-flash", "speaker": "simran_en_customer"},
                {"model": "bulbul:v3", "speaker": "simran"},
            )

    def test_the_default_ids_are_allowlisted_and_the_v3_short_name_is_not(self) -> None:
        self.assertEqual(r1_tts.V4_MODEL, "bulbul:v4-flash")
        self.assertEqual(
            dict(r1_tts.V4_DEFAULT_SPEAKERS),
            {"interviewer": "simran_en_customer", "learner": "zarina_en_conversation"},
        )
        for speaker in r1_tts.V4_DEFAULT_SPEAKERS.values():
            self.assertIn(speaker, r1_tts.V4_SPEAKERS)
        self.assertNotIn("simran", r1_tts.V4_SPEAKERS)
        self.assertNotIn("nobody_en_test", r1_tts.V4_SPEAKERS)
        for speaker in r1_tts.V4_SPEAKERS:
            self.assertRegex(speaker, r"^[a-z]+_en(hi)?_[a-z_]+$")

    def test_a_voice_set_hands_out_copies_and_an_unknown_role_is_the_interviewer(self) -> None:
        voices = r1_tts.r1_voice_set()
        copy = voices.kwargs("learner")
        copy["speaker"] = "mutated"
        self.assertEqual(voices.speaker("learner"), "zarina_en_conversation")
        self.assertEqual(voices.kwargs("narrator"), voices.kwargs("interviewer"))
        self.assertEqual(voices.kwargs(None), voices.kwargs("interviewer"))
        self.assertEqual(r1_tts.voice_role("learner"), "learner")
        self.assertEqual(r1_tts.voice_role("Learner"), "interviewer")
        self.assertEqual(r1_tts.legacy_voice_set().kwargs("learner"), r1_tts_kwargs())


class TestBoundVoice(unittest.IsolatedAsyncioTestCase):
    async def test_a_bound_voice_is_local_to_its_task(self) -> None:
        self.assertIsNone(r1_tts.current_voice())
        seen: dict[str, list] = {}
        gate = asyncio.Event()

        async def speech(name: str, voice: str) -> None:
            r1_tts.bind_voice(voice)
            seen.setdefault(name, []).append(r1_tts.current_voice())
            await gate.wait()  # the other speech binds its own voice meanwhile
            seen[name].append(r1_tts.current_voice())

            async def child() -> str | None:  # a task the speech starts inherits it
                return r1_tts.current_voice()

            seen[name].append(await asyncio.create_task(child()))

        first = asyncio.create_task(speech("a", "learner"))
        second = asyncio.create_task(speech("b", "interviewer"))
        await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(first, second)
        self.assertEqual(seen, {"a": ["learner"] * 3, "b": ["interviewer"] * 3})
        self.assertIsNone(r1_tts.current_voice())  # nothing leaked into this task

    async def test_an_unknown_voice_binds_nothing(self) -> None:
        async def speech() -> str | None:
            r1_tts.bind_voice("narrator")
            return r1_tts.current_voice()

        self.assertIsNone(await asyncio.create_task(speech()))


if __name__ == "__main__":
    unittest.main()
