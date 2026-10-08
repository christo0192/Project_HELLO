"""M014 S02: the livekit-agents 1.6.4 behaviours the endpointing hold relies on.

Run against the REAL SDK, in CI's "Endpointing hold real-SDK contract" step (a
venv with requirements.txt, ``ENDPOINTING_SDK_CONTRACT_REQUIRED=1``, a skip is a
failure). The bare-python worker step stubs the SDK, so there these tests skip.

What `turn_hold` and its wiring assume, and where (turn_hold.py / phone.py /
agent.py):

1. ``AgentSession.update_options(endpointing_opts={"min_delay": x})`` merges PER
   KEY into the session options AND reaches the running ``AudioRecognition``, so
   the per-phase minimum does not clobber the consent turn's ``max_delay`` update
   (and vice versa) (`_set_phase_min_delay`, `_set_consent_endpointing_max`);
2. the end-of-turn task reads ``self._endpointing.min_delay`` / ``.max_delay``
   when it RUNS (source pin), so a live update governs the next commit;
3. the reply-start silence gate reads ``options.endpointing["min_delay"] / 2``
   live (behaviour + source pin): an open question's 0.8 s minimum makes a reply
   wait 0.4 s of quiet instead of 0.15 s;
4. ``on_end_of_turn`` refuses a final of fewer than ``min_words`` words while an
   interruptible speech is current (source pin): the stale-text rule the hold
   works around, and why a short backchannel is released at the end of the grace;
5. after a commit ``_audio_transcript`` is cleared, and a later FINAL with the
   VAD silent starts a NEW end-of-turn: the premise of "yield, then merge into
   the next turn" at hook time;
6. ``_user_turn_completed_task`` awaits the previous user-turn task before it
   calls the hook (the merge-order premise), the bot's current speech is already
   interrupted when the hook runs, ``StopResponse`` from the hook adds no chat
   item, and the message handed to the hook accepts the merge (``content`` is
   assignable and ``text_content`` follows it; ``metrics`` is a mutable mapping);
7. ``SpeechCreatedEvent.source`` is ``"say" | "generate_reply"``;
8. an EMPTY final is dropped before ``user_input_transcribed`` fires, so a
   wordless VAD segment can only be released by the tracker's own expiry;
9. a NON-interruptible line is played without waiting for the candidate's
   silence and no commit can cancel it, and ``AgentSession.current_speech``
   (public) is that line's handle while it plays with ``allow_interruptions``
   False: how the first-audio hold knows never to hold (or grace-wait) the fixed
   closing goodbye (`phone.py` `_line_interruptible`).

No candidate data: synthetic text and silent audio only.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import time
import typing
import unittest
from collections.abc import MutableMapping

_REQUIRED = os.environ.get("ENDPOINTING_SDK_CONTRACT_REQUIRED") == "1"


def _real_sdk():
    """The real livekit-agents modules, or None (bare python / the test stub)."""
    try:
        from livekit import rtc  # noqa: PLC0415
        import livekit.agents as agents  # noqa: PLC0415
        from livekit.agents import stt, vad  # noqa: PLC0415
        from livekit.agents.voice import agent_activity, audio_recognition, events  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(getattr(agents, "__version__", None), str):
        return None  # the test stub
    return {
        "rtc": rtc, "agents": agents, "stt": stt, "vad": vad, "events": events,
        "agent_activity": agent_activity, "audio_recognition": audio_recognition,
    }


_SDK = _real_sdk()


def setUpModule():  # noqa: N802
    if _SDK is None:
        if _REQUIRED:
            raise RuntimeError(
                "ENDPOINTING_SDK_CONTRACT_REQUIRED=1 but the real livekit-agents SDK is not importable")
        raise unittest.SkipTest("real livekit-agents SDK not installed (bare-python CI step)")


def _fake_audio_output():
    """An audio output that plays instantly-captured frames out in real time."""
    from livekit.agents.voice import io as vio  # noqa: PLC0415

    class _FakeAudioOutput(vio.AudioOutput):
        def __init__(self) -> None:
            super().__init__(label="contract", capabilities=vio.AudioOutputCapabilities(pause=False),
                             sample_rate=24000)
            self._pending = 0.0
            self._started = False
            self._tasks: set = set()

        async def capture_frame(self, frame) -> None:
            await super().capture_frame(frame)
            if not self._started:
                self._started = True
                self.on_playback_started(created_at=time.time())
            self._pending += frame.duration

        def flush(self) -> None:
            super().flush()
            duration, self._pending, self._started = self._pending, 0.0, False

            async def _finish() -> None:
                await asyncio.sleep(duration)
                self.on_playback_finished(playback_position=duration, interrupted=False)

            task = asyncio.ensure_future(_finish())
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        def clear_buffer(self) -> None:
            self._pending = 0.0

    return _FakeAudioOutput()


async def _silence(seconds: float):
    rtc = _SDK["rtc"]
    rate, per = 24000, 480
    for _ in range(int(round(seconds / 0.02))):
        yield rtc.AudioFrame(b"\x00\x00" * per, rate, 1, per)


def _final(text: str):
    stt = _SDK["stt"]
    return stt.SpeechEvent(
        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives=[stt.SpeechData(language="en", text=text, confidence=0.9)],
    )


class _ContractCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        agents = _SDK["agents"]
        test = self

        class _Agent(agents.Agent):
            async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
                await test.on_hook(turn_ctx, new_message)

        self.hooks: list = []          # (text, current_speech_interrupted)
        self.messages: list = []
        self.items: list = []
        self.agent = _Agent(instructions="contract test")
        self.session = agents.AgentSession()
        self.session.on("conversation_item_added", self.items.append)
        self.session.output.audio = _fake_audio_output()
        await self.session.start(self.agent)
        self.activity = self.session._activity  # noqa: SLF001
        self.recognition = self.activity._audio_recognition  # noqa: SLF001
        self.session.update_options(endpointing_opts={"min_delay": 0.05, "max_delay": 0.1})

    async def asyncTearDown(self) -> None:
        await self.session.aclose()

    async def on_hook(self, turn_ctx, new_message) -> None:
        speech = self.activity._current_speech  # noqa: SLF001
        self.hooks.append((new_message.text_content, None if speech is None else speech.interrupted))
        self.messages.append(new_message)

    async def feed_final(self, text: str) -> None:
        await self.recognition._on_stt_event(_final(text))  # noqa: SLF001

    async def wait_hooks(self, count: int, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while len(self.hooks) < count and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        self.assertGreaterEqual(len(self.hooks), count, self.hooks)


class TestPinnedVersion(unittest.TestCase):
    def test_the_pinned_sdk_is_what_these_contracts_were_measured_on(self):
        self.assertEqual(_SDK["agents"].__version__, "1.6.4")


class TestUpdateOptionsIsPerKey(_ContractCase):
    async def test_min_delay_alone_reaches_the_session_and_the_running_recognition(self):
        self.session.update_options(endpointing_opts={"max_delay": 2.0})
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.assertEqual(self.session.options.endpointing["min_delay"], 0.8)
        self.assertEqual(self.session.options.endpointing["max_delay"], 2.0)
        self.assertEqual(self.recognition._endpointing.min_delay, 0.8)  # noqa: SLF001
        self.assertEqual(self.recognition._endpointing.max_delay, 2.0)  # noqa: SLF001
        # The same recognition object keeps running (it is not rebuilt).
        self.assertIs(self.activity._audio_recognition, self.recognition)  # noqa: SLF001

    async def test_a_following_max_update_keeps_the_minimum(self):
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.session.update_options(endpointing_opts={"max_delay": 0.5})      # consent tightening
        self.assertEqual(self.session.options.endpointing["min_delay"], 0.8)
        self.assertEqual(self.recognition._endpointing.min_delay, 0.8)  # noqa: SLF001
        self.assertEqual(self.recognition._endpointing.max_delay, 0.5)  # noqa: SLF001
        self.session.update_options(endpointing_opts={"max_delay": 2.0})      # restored
        self.assertEqual(self.recognition._endpointing.min_delay, 0.8)  # noqa: SLF001
        self.assertEqual(self.recognition._endpointing.max_delay, 2.0)  # noqa: SLF001

    def test_the_signature_takes_endpointing_opts(self):
        params = inspect.signature(_SDK["agents"].AgentSession.update_options).parameters
        self.assertIn("endpointing_opts", params)


class TestEndpointingIsReadWhenTheCommitTaskRuns(unittest.TestCase):
    def test_source_pin(self):
        source = inspect.getsource(_SDK["audio_recognition"].AudioRecognition._run_eou_detection)  # noqa: SLF001
        self.assertIn("endpointing_delay = self._endpointing.min_delay", source)
        self.assertIn("endpointing_delay = self._endpointing.max_delay", source)


class TestReplyStartSilenceGate(_ContractCase):
    def _inference(self, silence: float):
        vad = _SDK["vad"]
        return vad.VADEvent(
            type=vad.VADEventType.INFERENCE_DONE, samples_index=0, timestamp=time.time(),
            speech_duration=0.0, silence_duration=silence, speaking=True,
            raw_accumulated_silence=silence,
        )

    async def test_the_gate_follows_the_live_minimum_over_two(self):
        # 0.3 s of quiet inside active speech.
        self.session.update_options(endpointing_opts={"min_delay": 0.3})
        self.activity.on_vad_inference_done(self._inference(0.3))  # noqa: SLF001
        self.assertTrue(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                        "0.3 > 0.3 / 2: a reply may start")
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.activity.on_vad_inference_done(self._inference(0.3))  # noqa: SLF001
        self.assertFalse(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                         "0.3 <= 0.8 / 2: the reply still waits")
        self.activity.on_vad_inference_done(self._inference(0.45))  # noqa: SLF001
        self.assertTrue(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                        "0.45 > 0.4: the reply may start")

    def test_source_pin(self):
        source = inspect.getsource(_SDK["agent_activity"].AgentActivity.on_vad_inference_done)
        self.assertIn('self._session.options.endpointing["min_delay"] / 2', source)


class TestShortFinalsAreRefusedWhileASpeechIsCurrent(unittest.TestCase):
    def test_source_pin(self):
        source = inspect.getsource(_SDK["agent_activity"].AgentActivity.on_end_of_turn)
        self.assertIn('self._session.options.interruption["min_words"] > 0', source)
        self.assertIn("self._current_speech.allow_interruptions", source)
        self.assertIn("not self._current_speech.interrupted", source)
        self.assertIn("return False", source)
        self.assertIn("split_words(info.new_transcript, split_character=True)", source)

    def test_the_hold_counts_words_the_way_the_sdk_does(self):
        """`turn_hold.count_words` decides whether a final can be committed, so
        it must agree with the SDK tokenizer the commit gate uses."""
        from livekit.agents.tokenize.basic import split_words  # noqa: PLC0415
        import turn_hold  # noqa: PLC0415

        for text in ("yeah", "yes I am", "Okay, sure.", "that is it", "uh-huh yes"):
            self.assertEqual(
                turn_hold.count_words(text),
                len(split_words(text, split_character=True)), text)


class TestALateFinalCommitsAsANewTurn(_ContractCase):
    async def test_commit_clears_the_transcript_and_a_later_final_starts_a_new_turn(self):
        await self.feed_final("first words")
        await self.wait_hooks(1)
        await asyncio.sleep(0.05)
        self.assertEqual(self.recognition._audio_transcript, "")  # noqa: SLF001
        await self.feed_final("second words")
        await self.wait_hooks(2)
        self.assertEqual([text for text, _ in self.hooks], ["first words", "second words"])
        self.assertEqual(self.recognition._audio_transcript, "")  # noqa: SLF001


class TestAnEmptyFinalNeverReachesTheSession(_ContractCase):
    """Why a wordless VAD segment is released by `turn_hold`'s expiry and not by
    an empty final: the SDK drops an empty FINAL_TRANSCRIPT before it is emitted
    as `user_input_transcribed` (audio_recognition._on_stt_event)."""

    async def test_an_empty_final_emits_no_user_input_transcribed(self):
        events: list = []
        self.session.on("user_input_transcribed", events.append)
        await self.feed_final("")
        await asyncio.sleep(0.2)
        self.assertEqual(events, [])
        self.assertEqual(self.hooks, [])
        # A whitespace-only final IS emitted; the worker's handler ignores it
        # (`transcript.strip()`) and the tracker never counts it.
        await self.feed_final("   ")
        await asyncio.sleep(0.1)
        self.assertEqual([e.transcript.strip() for e in events], [""])
        events.clear()
        # Control: a real final is emitted (the listener is wired).
        await self.feed_final("some words")
        await self.wait_hooks(1)
        self.assertEqual(
            [e.transcript for e in events if e.is_final], ["some words"])


class TestTheHookSeam(_ContractCase):
    async def test_the_next_turn_waits_for_the_previous_hook_and_a_stop_adds_no_chat_item(self):
        StopResponse = _SDK["agents"].StopResponse
        release = asyncio.Event()
        order: list = []

        async def hook(turn_ctx, new_message) -> None:
            order.append(("start", new_message.text_content))
            if new_message.text_content == "first words":
                await release.wait()
                order.append(("stop", new_message.text_content))
                raise StopResponse()
            order.append(("kept", new_message.text_content))

        self.on_hook = hook
        await self.feed_final("first words")
        # Poll (bounded) for the first hook: a fixed sleep misses it on a loaded
        # runner.  Only the NEGATIVE window below is a fixed wait, and a slow
        # machine can only make that one pass more easily, never fail.
        deadline = time.monotonic() + 5
        while ("start", "first words") not in order and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(order, [("start", "first words")])
        # The late final commits while the first hook is still held ...
        await self.feed_final("second words")
        await asyncio.sleep(0.5)
        # ... and its hook has NOT started: the new task awaits the old one.
        self.assertEqual(order, [("start", "first words")])
        release.set()
        deadline = time.monotonic() + 3
        while ("kept", "second words") not in order and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(
            order,
            [("start", "first words"), ("stop", "first words"),
             ("start", "second words"), ("kept", "second words")],
        )
        # The stopped turn never became a chat item.
        texts = [getattr(i, "text_content", None) for i in self.agent.chat_ctx.items]
        self.assertNotIn("first words", texts)
        self.assertNotIn(
            "first words",
            [getattr(getattr(e, "item", None), "text_content", None) for e in self.items])

    async def test_the_bot_is_already_cut_when_the_hook_runs(self):
        handle = self.session.say(
            "a long bot line", audio=_silence(2.0), allow_interruptions=True,
            add_to_chat_ctx=False)
        await asyncio.sleep(0.3)
        self.assertFalse(handle.interrupted)
        await self.feed_final("interrupting words")
        await self.wait_hooks(1)
        text, current_interrupted = self.hooks[0]
        self.assertEqual(text, "interrupting words")
        self.assertTrue(handle.interrupted, "the current speech is interrupted before the hook")
        self.assertIn(current_interrupted, (True, None))

    async def test_the_message_accepts_the_merge(self):
        await self.feed_final("later words")
        await self.wait_hooks(1)
        message = self.messages[0]
        self.assertIsInstance(message.metrics, MutableMapping)
        message.content = ["earlier words later words"]
        self.assertEqual(message.text_content, "earlier words later words")
        message.metrics["started_speaking_at"] = 123.5
        self.assertEqual(message.metrics["started_speaking_at"], 123.5)
        self.assertNotIn("text_content", vars(message))


class TestTurnHoldYieldsAndMergesOnTheRealSdk(_ContractCase):
    """`turn_hold.TurnHold` driven by the real SDK's own commit machinery."""

    async def test_a_late_final_is_yielded_to_and_merged_into_the_next_turn(self):
        import turn_hold  # noqa: PLC0415

        tracker = turn_hold.PendingFinalTracker(lambda: True)
        log: list = []
        hold = turn_hold.TurnHold(
            tracker, hold_max_sec=lambda: 2.0, endpoint_max_sec=lambda: 0.1,
            log=lambda event, **meta: log.append(meta.get("error_category")))
        merged: list = []

        async def hook(turn_ctx, new_message) -> None:
            await hold.before_turn(new_message)
            merged.append(new_message.text_content)

        self.on_hook = hook
        now = time.time()
        # The candidate resumed speaking; its final has not arrived yet.
        tracker.on_speech_start(now - 1.0)
        tracker.on_speech_end(now - 0.5)
        await self.feed_final("first words")          # the SDK commits the stale text
        await asyncio.sleep(0.25)
        self.assertEqual(merged, [], "held while the late final is pending")
        tracker.on_final(time.time(), "second words")  # `user_input_transcribed`
        await self.feed_final("second words")          # the same final reaches the SDK
        deadline = time.monotonic() + 3
        while not merged and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(merged, ["first words second words"])
        self.assertEqual(log, ["held_yield", "carry_merged"])
        self.assertIsNone(hold.carry)
        users = [getattr(i, "text_content", None) for i in self.agent.chat_ctx.items]
        self.assertNotIn("first words", users, "the yielded turn left no chat item")


class TestNonInterruptibleLinesAreNotGatedOnSilence(_ContractCase):
    async def test_the_current_speech_handle_says_whether_the_playing_line_can_be_interrupted(self):
        for allow in (False, True):
            handle = self.session.say(
                "a synthetic closing line", audio=_silence(0.4), allow_interruptions=allow)
            deadline = time.monotonic() + 3
            while self.session.current_speech is not handle and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            self.assertIs(self.session.current_speech, handle)
            self.assertEqual(self.session.current_speech.allow_interruptions, allow)
            await asyncio.wait_for(handle.wait_for_playout(), timeout=5)

    def test_source_pin_the_silence_wait_is_only_added_for_interruptible_speech(self):
        source = inspect.getsource(_SDK["agent_activity"].AgentActivity._tts_task_impl)  # noqa: SLF001
        self.assertIn("if speech_handle.allow_interruptions:", source)
        self.assertIn("self._user_silence_event.wait()", source)

    def test_source_pin_a_commit_over_a_non_interruptible_line_is_skipped(self):
        source = inspect.getsource(_SDK["agent_activity"].AgentActivity._user_turn_completed_task)  # noqa: SLF001
        self.assertIn("cannot be interrupted", source)


class TestSpeechCreatedSource(unittest.TestCase):
    def test_source_is_say_or_generate_reply(self):
        annotation = _SDK["events"].SpeechCreatedEvent.model_fields["source"].annotation
        self.assertEqual(set(typing.get_args(annotation)), {"say", "generate_reply"})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
