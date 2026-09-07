"""Codex review Finding A (2026-09-07) — first-fragment synthesis must not
wait for the remainder.

THE REPRODUCED DEPENDENCY (verified against the real `phone.tts_node` with a
fake downstream synthesizer before the fix, exactly per §16.1): the
letter-free-remainder-lead fold read ahead into the remainder BEFORE
synthesizing the first fragment. When `llm_node`'s guarded incremental release
was still withholding the reply tail (full-draft validation), that read
blocked — so an already-authorized, complete first sentence did not start
downstream synthesis until the whole generation finished:

    Approved prefix available
      → TTS waits for remainder
      → guard withholds remainder until generation completes
      → first synthesis starts late

Pre-fix probe results (this module's shapes, run against the old code):
  terminator-ended sentence  → BLOCKED (no synthesis until tail release)
  comma-ended clause         → BLOCKED
  combined llm_node→tts_node → BLOCKED

THE FIX: a first fragment ending at a SENTENCE TERMINATOR synthesizes with NO
read-ahead (the fold never applied to a closed sentence anyway). A clause-
pause / min-chars fragment keeps the numeric-protection fold, but its
CROSS-CHUNK wait is bounded by `PHONE_TTS_TAIL_PEEK_TIMEOUT_SEC` — characters
already in hand are still folded for free. Cancellation/generation fencing,
instruction-echo protection (upstream in llm_node), bounded two-call
fragmentation, and the Sarvam letter-free-400 protection are all preserved and
asserted below.
"""

from __future__ import annotations

import asyncio
import re
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests.test_phone_gate import (  # noqa: E402
    FakeEventClient,
    _ATTEMPT_ID,
)

import phone  # noqa: E402


def _build_agent(downstream_chunks, streams=None, **kwargs):
    class BaseAgent:
        def __init__(self, instructions=""):
            self.instructions = instructions
            self.chat_ctx = types.SimpleNamespace(items=[])

        async def tts_node(self, text, model_settings):
            buf = []
            async for chunk in text:
                downstream_chunks.append(chunk)
                buf.append(chunk)
                yield chunk
            if streams is not None:
                streams.append("".join(buf))

    return phone.phone_agent_class(BaseAgent)(
        "sys", client=FakeEventClient(), attempt_id=_ATTEMPT_ID,
        say=AsyncMock(), on_user_turn=lambda *a, **k: None,
        native_turns=True, **kwargs,
    )


class _HeldTailHarness(unittest.IsolatedAsyncioTestCase):
    """Drive tts_node over a prefix + event-held tail; observe the downstream."""

    async def _probe(self, prefix, tail, *, env=None, settle=0.25):
        downstream: list[str] = []
        streams: list[str] = []
        agent = _build_agent(downstream, streams)
        release = asyncio.Event()

        async def src():
            yield prefix
            await release.wait()
            if tail:
                yield tail

        async def drive():
            out = []
            async for frame in agent.tts_node(src(), None):
                out.append(frame)
            return "".join(out)

        overrides = {"PHONE_TTS_FLUSH_MIN_CHARS": "60"}
        overrides.update(env or {})
        with patch.dict(phone.os.environ, overrides):
            task = asyncio.create_task(drive())
            await asyncio.sleep(settle)
            held_chunks = list(downstream)
            release.set()
            spoken = await asyncio.wait_for(task, timeout=5)
        return held_chunks, spoken, streams


class TestFirstSentenceSynthesizesWithoutRemainder(_HeldTailHarness):

    async def test_indefinitely_held_remainder_first_sentence_synthesizes(self):
        # §3 acceptance, verbatim: hold the remainder; an already-authorized
        # complete first sentence must start downstream synthesis.
        held, spoken, _ = await self._probe(
            "Thanks for explaining that.", " What is your notice period?",
        )
        self.assertTrue(
            held, "the complete first sentence must synthesize while the tail is held",
        )
        self.assertEqual("".join(held), "Thanks for explaining that.")
        self.assertEqual(
            spoken.replace(" ", ""),
            "Thanksforexplainingthat.Whatisyournoticeperiod?".replace(" ", ""),
        )

    async def test_short_approved_acknowledgment_with_delayed_tail(self):
        # §3 acceptance: a short approved acknowledgment, delayed guarded tail.
        held, spoken, _ = await self._probe(
            "Got it, thanks for that!", " Could you walk me through your role?",
        )
        self.assertTrue(held)
        self.assertEqual("".join(held), "Got it, thanks for that!")
        self.assertIn("walk me through your role", spoken)

    async def test_comma_prefix_synthesizes_after_the_bounded_peek_budget(self):
        # A clause-pause fragment keeps the numeric-protection peek, but the
        # cross-chunk wait is BOUNDED: with the tail held past the budget the
        # fragment synthesizes unfolded instead of waiting forever.
        held, spoken, _ = await self._probe(
            "Thanks for walking me through that,",
            " what is your notice period?",
            env={"PHONE_TTS_TAIL_PEEK_TIMEOUT_SEC": "0.05"},
        )
        self.assertTrue(
            held, "the clause fragment must synthesize once the peek budget lapses",
        )
        self.assertEqual("".join(held), "Thanks for walking me through that,")
        self.assertIn("notice period", spoken)

    async def test_combined_guard_and_tts_path_no_longer_blocks(self):
        # §16.1: the COMBINED dependency — llm_node releases an authorized
        # prefix and withholds the tail until the draft validates; tts_node
        # must still synthesize the released sentence.
        downstream: list[str] = []
        agent = _build_agent(
            downstream, turn_mode=phone.PHONE_TURN_MODE_TOOLLESS,
        )
        release = asyncio.Event()

        class Chunk:
            def __init__(self, s):
                self.delta = types.SimpleNamespace(content=s)

        async def _llm_result():
            yield Chunk("Thanks for explaining that.")
            await release.wait()
            yield Chunk(" What is your notice period?")

        async def _fake_super_llm(self, chat_ctx, tools, model_settings):
            return _llm_result()

        agent._screening_authorized = True
        agent._turn_policy = "substantive"
        agent.authorize_generation(
            "What is your notice period?", allow_closing=False,
            control_text="React to the answer without revealing private controller rules.",
            phase="screening",
        )

        async def text_stream():
            async for chunk in agent.llm_node(
                types.SimpleNamespace(items=[]), [], None,
            ):
                content = getattr(getattr(chunk, "delta", None), "content", None)
                yield content if isinstance(content, str) else str(chunk)

        async def drive():
            out = []
            async for frame in agent.tts_node(text_stream(), None):
                out.append(frame)
            return "".join(out)

        base = type(agent).__mro__[1]
        with patch.dict(phone.os.environ, {"PHONE_TTS_FLUSH_MIN_CHARS": "60"}):
            with patch.object(base, "llm_node", new=_fake_super_llm, create=True):
                task = asyncio.create_task(drive())
                await asyncio.sleep(0.25)
                held = list(downstream)
                release.set()
                spoken = await asyncio.wait_for(task, timeout=5)
        self.assertTrue(
            held,
            "the guard-released first sentence must synthesize while the "
            "guarded tail is withheld",
        )
        self.assertIn("Thanks for explaining that.", "".join(held))
        self.assertIn("notice period", spoken)

    async def test_empty_remainder_opens_no_second_synthesis(self):
        downstream: list[str] = []
        streams: list[str] = []
        agent = _build_agent(downstream, streams)

        async def src():
            yield "That works for me."

        async def drive():
            return "".join([f async for f in agent.tts_node(src(), None)])

        with patch.dict(phone.os.environ, {"PHONE_TTS_FLUSH_MIN_CHARS": "60"}):
            spoken = await asyncio.wait_for(drive(), timeout=5)
        self.assertEqual(spoken, "That works for me.")
        # Exactly ONE downstream call — an empty remainder never opens an
        # empty second synthesis.
        self.assertEqual(streams, ["That works for me."])


class TestNumericProtectionPreserved(_HeldTailHarness):
    """§3 acceptance: preserve numeric fragments, including the historical
    Sarvam alphabetic-character rejection cases — the fold still guards every
    stream against a letter-free sentence when the text is available."""

    def _assert_no_letter_free_sentence(self, streams):
        self.assertTrue(streams)
        for stream in streams:
            for sentence in re.split(r"[.!?]", stream):
                if sentence.strip() == "":
                    continue
                self.assertTrue(
                    any(c.isalpha() for c in sentence),
                    msg=f"letter-free sentence {sentence!r} in {stream!r}",
                )

    async def _run(self, chunks, env=None):
        downstream: list[str] = []
        streams: list[str] = []
        agent = _build_agent(downstream, streams)

        async def src():
            for chunk in chunks:
                yield chunk

        overrides = {"PHONE_TTS_FLUSH_MIN_CHARS": "40"}
        overrides.update(env or {})
        with patch.dict(phone.os.environ, overrides):
            spoken = "".join(
                [f async for f in agent.tts_node(src(), None)],
            )
        return spoken, streams

    async def test_call28_short_letter_free_tail_still_folds(self):
        spoken, streams = await self._run(["Great question, 2019."])
        self._assert_no_letter_free_sentence(streams)
        self.assertIn("2019", spoken)
        self.assertEqual(spoken.replace(" ", ""), "Greatquestion,2019.")

    async def test_cross_chunk_digit_tail_folds_within_the_budget(self):
        # The digit tail arrives as its own PROMPT chunk: the bounded peek
        # still folds it — the budget only bounds a WITHHELD tail.
        spoken, streams = await self._run(["Great question,", " 2019."])
        self._assert_no_letter_free_sentence(streams)
        self.assertIn("2019", spoken)
        self.assertEqual(spoken.replace(" ", ""), "Greatquestion,2019.")

    async def test_closed_sentence_never_folds_a_following_number(self):
        # "Wow. 2019." — the letter-free run is the LLM's OWN sentence; it must
        # stay on the remainder (the fold never INTRODUCES a letter-free
        # sentence into the first stream), matching the single-call baseline.
        spoken, streams = await self._run(["Wow. 2019. We shipped it."])
        self.assertIn("2019", spoken)
        self.assertEqual(spoken.replace(" ", ""), "Wow.2019.Weshippedit.")
        # The FIRST stream is exactly the closed sentence, unfolded.
        self.assertEqual(streams[0], "Wow.")

    async def test_zero_budget_still_folds_characters_already_in_hand(self):
        # PHONE_TTS_TAIL_PEEK_TIMEOUT_SEC=0 disables only the CROSS-CHUNK
        # wait; a same-chunk letter-free tail is still folded for free.
        spoken, streams = await self._run(
            ["Great question, 2019."],
            env={"PHONE_TTS_TAIL_PEEK_TIMEOUT_SEC": "0"},
        )
        self._assert_no_letter_free_sentence(streams)
        self.assertEqual(spoken.replace(" ", ""), "Greatquestion,2019.")


class TestCancellationAndFencing(unittest.IsolatedAsyncioTestCase):
    """§3 acceptance: cancellation must not release stale speech."""

    async def test_stale_generation_stops_frames(self):
        downstream: list[str] = []
        agent = _build_agent(downstream)
        agent.arm_reply_generation(1)
        gate = asyncio.Event()

        async def src():
            yield "Thanks for explaining that."
            await gate.wait()
            yield " What is your notice period?"

        frames: list[str] = []

        async def drive():
            async for frame in agent.tts_node(src(), None):
                frames.append(frame)

        with patch.dict(phone.os.environ, {"PHONE_TTS_FLUSH_MIN_CHARS": "60"}):
            task = asyncio.create_task(drive())
            await asyncio.sleep(0.1)
            frames_before = list(frames)
            # The controller moves to a NEW reply generation: everything
            # buffered for the old one is stale and must not be released.
            agent.arm_reply_generation(2)
            gate.set()
            await asyncio.wait_for(task, timeout=5)
        self.assertEqual(frames, frames_before)
        self.assertNotIn("notice period", "".join(frames))

    async def test_external_close_mid_hold_leaves_no_pending_task(self):
        # Barge-in: the SDK closes the tts_node generator while the tail is
        # still held. The bounded peek's in-flight chunk read must be cleaned
        # up (cancelled), never leaked to warn at loop shutdown.
        downstream: list[str] = []
        agent = _build_agent(downstream)
        release = asyncio.Event()

        async def src():
            yield "Thanks for walking me through that,"
            await release.wait()
            yield " and one more thing."

        gen = agent.tts_node(src(), None)

        async def consume_one():
            frames = []
            async for frame in gen:
                frames.append(frame)
                break
            return frames

        with patch.dict(phone.os.environ, {
            "PHONE_TTS_FLUSH_MIN_CHARS": "60",
            "PHONE_TTS_TAIL_PEEK_TIMEOUT_SEC": "0.02",
        }):
            frames = await asyncio.wait_for(consume_one(), timeout=5)
            self.assertTrue(frames)
            await gen.aclose()
            # Let cancellation callbacks run; the loop must be quiet.
            await asyncio.sleep(0.05)
            pending = [
                t for t in asyncio.all_tasks()
                if t is not asyncio.current_task() and not t.done()
            ]
            self.assertEqual(pending, [])


class TestRollbackPathUnchanged(unittest.IsolatedAsyncioTestCase):

    async def test_min_chars_zero_is_single_call_passthrough(self):
        downstream: list[str] = []
        streams: list[str] = []
        agent = _build_agent(downstream, streams)

        async def src():
            for chunk in ("Hello there, ", "how are you today? ", "Good."):
                yield chunk

        with patch.dict(phone.os.environ, {"PHONE_TTS_FLUSH_MIN_CHARS": "0"}):
            spoken = "".join([f async for f in agent.tts_node(src(), None)])
        self.assertEqual(spoken, "Hello there, how are you today? Good.")
        self.assertEqual(len(streams), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
