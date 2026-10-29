"""Pinned LiveKit 1.6.4 contract for every SDK symbol used by the R1 worker.

Run this suite with the worktree's ``.r1-venv``.  The bare-python CI step skips it (the
SDK is not installed there) because production SDK behaviour must not be approximated by
these tests; the isolated ``Test R1 SDK contract`` step in ``quality.yml`` installs
``livekit-agents==1.6.4`` and ``livekit==1.1.12`` in a venv, runs it, and fails if any
test was skipped.
"""
from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import os
import sys
import time
import typing
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    from livekit import rtc
    from livekit.agents import APIConnectOptions, Agent, AgentSession, JobContext, StopResponse
    from livekit.agents.llm import ChatContext, ChatMessage
    from livekit.agents.llm.chat_context import MetricsReport
    from livekit.agents.ipc import job_proc_lazy_main
    from livekit.agents.llm.llm import LLMError
    from livekit.agents.voice.agent_activity import AgentActivity
    from livekit.agents.voice.audio_recognition import AudioRecognition
    from livekit.agents.voice.agent_session import SessionConnectOptions
    from livekit.agents.voice.events import (
        AgentStateChangedEvent,
        UserStateChangedEvent,
        CloseEvent,
        ConversationItemAddedEvent,
        ErrorEvent,
        EventTypes,
        SpeechCreatedEvent,
        UserInputTranscribedEvent,
    )
    from livekit.agents.voice.room_io import RoomOptions
    from livekit.agents.voice.speech_handle import SpeechHandle
    from livekit.agents.worker import AgentServer
except ImportError:
    rtc = None
    APIConnectOptions = Agent = AgentSession = ErrorEvent = JobContext = None
    SessionConnectOptions = StopResponse = RoomOptions = None
    ChatMessage = LLMError = AgentActivity = CloseEvent = SpeechCreatedEvent = None
    AudioRecognition = None
    ChatContext = AgentStateChangedEvent = ConversationItemAddedEvent = None
    MetricsReport = UserStateChangedEvent = None
    UserInputTranscribedEvent = EventTypes = None
    SpeechHandle = AgentServer = job_proc_lazy_main = None

try:  # Import once at module load so the first async test is not flagged as slow.
    from livekit.plugins import sarvam as _sarvam_plugin  # noqa: F401
except ImportError:
    _sarvam_plugin = None


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1SdkContract(unittest.TestCase):
    """Detect 1.6.4 SDK drift before R1 code reaches a worker image."""

    def test_agent_session_methods_and_events_exist(self) -> None:
        start = inspect.signature(AgentSession.start).parameters
        self.assertIn("room_options", start)
        self.assertIn("record", start)
        self.assertIn("user_away_timeout", inspect.signature(AgentSession).parameters)
        self.assertIn("conn_options", inspect.signature(AgentSession).parameters)
        self.assertIn("allow_interruptions", inspect.signature(AgentSession.say).parameters)
        self.assertIn("user_input", inspect.signature(AgentSession.generate_reply).parameters)
        self.assertIn("force", inspect.signature(AgentSession.interrupt).parameters)
        self.assertTrue(callable(getattr(AgentSession, "on")))
        self.assertTrue(callable(getattr(AgentSession, "aclose")))
        source = inspect.getsource(AgentSession)
        for event_name in (
            "user_input_transcribed",
            "user_state_changed",
            "agent_state_changed",
            "conversation_item_added",
            "error",
            "close",
        ):
            self.assertIn(event_name, source)
        # The SDK's own event vocabulary, including the speech lifecycle R1 orders rows by.
        self.assertIn("speech_created", typing.get_args(EventTypes))

    def test_say_adds_to_the_chat_context_by_default_and_reports_the_item(self) -> None:
        """R1 persists bot turns ONLY from conversation_item_added; say() must feed it."""
        say = inspect.signature(AgentSession.say).parameters["add_to_chat_ctx"]
        self.assertIs(say.default, True)
        activity = inspect.getsource(AgentActivity)
        self.assertIn("self._session._conversation_item_added(msg)", activity)
        self.assertIn("speech_handle._item_added([msg])", activity)

    def test_say_and_an_llm_reply_report_their_item_in_opposite_orders(self) -> None:
        """The 1.6.4 inconsistency R1's slot assignment must tolerate, pinned in BOTH directions.

        ``say()`` lists the item on ``speech_handle.chat_items`` first and fires
        ``conversation_item_added`` second; an LLM reply fires the event first and lists
        the item second.  If the SDK ever makes them consistent this test fails, and the
        ``current_speech`` fallback in ``R1Interview._slot_for_item`` can be reviewed.
        """
        say_path = inspect.getsource(AgentActivity._tts_task_impl)
        reply_path = inspect.getsource(AgentActivity._pipeline_reply_task_impl)
        listed = "speech_handle._item_added([msg])"
        event = "self._session._conversation_item_added(msg)"
        self.assertLess(say_path.index(listed), say_path.index(event))
        self.assertLess(reply_path.index(event), reply_path.index(listed))

    def test_the_session_exposes_the_current_speech_the_fallback_relies_on(self) -> None:
        self.assertIsInstance(inspect.getattr_static(AgentSession, "current_speech"), property)
        scheduler = inspect.getsource(AgentActivity._scheduling_task)
        # The speech stays current for its whole generation, which is when its item arrives.
        self.assertLess(
            scheduler.index("self._current_speech = speech"),
            scheduler.index("await speech._wait_for_generation()"),
        )

    def test_speech_events_and_handle_expose_what_the_transcript_ordering_needs(self) -> None:
        self.assertIn("speech_handle", SpeechCreatedEvent.model_fields)
        self.assertIn("source", SpeechCreatedEvent.model_fields)
        for attribute in ("id", "chat_items", "interrupted"):
            self.assertIsInstance(inspect.getattr_static(SpeechHandle, attribute), property)
        for method in ("add_done_callback", "wait_for_playout", "interrupt"):
            self.assertTrue(callable(getattr(SpeechHandle, method)))
        for field in ("id", "role", "interrupted"):
            self.assertIn(field, ChatMessage.model_fields)
        self.assertIsInstance(inspect.getattr_static(ChatMessage, "text_content"), property)

    def test_say_and_replies_share_one_serial_speech_queue(self) -> None:
        """Why the filler travels inside the reply stream rather than as a second say()."""
        scheduler = inspect.getsource(AgentActivity._scheduling_task)
        self.assertIn("heapq.heappop(self._speech_q)", scheduler)
        self.assertIn("await speech._wait_for_generation()", scheduler)

    def test_agent_and_job_context_hooks_exist(self) -> None:
        self.assertTrue(issubclass(StopResponse, Exception))
        for hook in ("on_enter", "on_user_turn_completed", "llm_node"):
            self.assertTrue(callable(getattr(Agent, hook)))
        callback_parameters = inspect.signature(JobContext.add_shutdown_callback).parameters
        self.assertIn("callback", callback_parameters)

    def test_a_stop_response_in_on_user_turn_completed_skips_the_reply(self) -> None:
        source = inspect.getsource(AgentActivity._user_turn_completed_task)
        self.assertIn("except StopResponse:", source)
        self.assertIn("on_user_turn_completed", source)

    def test_an_agent_level_override_turns_preemptive_generation_off_for_that_agent(self) -> None:
        # R1 decides the learner's reminder in on_user_turn_completed, AFTER the final
        # transcript, so a generation started before it must not happen (r1_session
        # ``_agent_turn_handling``).  The agent-level key wins over the session's value and
        # touches nothing else.
        self.assertIn("turn_handling", inspect.signature(Agent.__init__).parameters)
        override = {"preemptive_generation": {"enabled": False}}
        agent = Agent(instructions="x", turn_handling=override)
        session_options = {
            "enabled": True,
            "preemptive_tts": False,
            "max_speech_duration": 10.0,
            "max_retries": 3,
        }
        activity = AgentActivity.__new__(AgentActivity)
        activity._agent = agent
        activity._session = mock.Mock(options=mock.Mock(preemptive_generation=session_options))
        resolved = AgentActivity.preemptive_generation_opts.fget(activity)
        self.assertFalse(resolved["enabled"])
        self.assertEqual(resolved["max_retries"], 3)  # the session's other values survive
        plain = Agent(instructions="x")
        activity._agent = plain
        self.assertTrue(AgentActivity.preemptive_generation_opts.fget(activity)["enabled"])
        # No other turn option is overridden by the agent.
        self.assertEqual(agent._turn_handling, override)

    def test_the_filtered_context_reaches_the_provider_with_its_roles_unchanged(self) -> None:
        # DeepSeek rejects the ``developer`` role, so the per-turn reminder travels as a
        # ``system`` message in the middle of the conversation, and it must stay one.
        chat_ctx = ChatContext.empty()
        for role, content in (
            ("system", "prefix"),
            ("assistant", "pickup"),
            ("system", "reminder"),
            ("user", "hello"),
        ):
            chat_ctx.add_message(role=role, content=content)
        messages, _ = chat_ctx.to_provider_format("openai")
        self.assertEqual(
            [(m["role"], m["content"]) for m in messages],
            [
                ("system", "prefix"),
                ("assistant", "pickup"),
                ("system", "reminder"),
                ("user", "hello"),
            ],
        )

    def test_llm_node_returns_an_async_iterable_the_guard_can_wrap(self) -> None:
        self.assertTrue(inspect.isasyncgenfunction(Agent.default.llm_node))
        self.assertFalse(inspect.iscoroutinefunction(Agent.llm_node))

    def test_job_context_ends_a_job_with_delete_room_and_shutdown_not_close_room(self) -> None:
        """1.6.4 JobContext has NO close_room: the exit and refuse paths must not call it."""
        self.assertTrue(callable(JobContext.delete_room))
        self.assertTrue(callable(JobContext.shutdown))
        self.assertFalse(hasattr(JobContext, "close_room"))
        self.assertIn("room_name", inspect.signature(JobContext.delete_room).parameters)
        self.assertIn("reason", inspect.signature(JobContext.shutdown).parameters)

    def test_a_drain_reaches_a_running_job_only_as_a_cancellation_after_the_grace(self) -> None:
        """No drain signal ever reaches a live R1 interview except the entrypoint's cancel.

        ``AgentServer.drain`` only waits for the running jobs.  The job process awaits its
        shutdown request, gives the entrypoint 15 s, cancels it, closes the session and
        the room, and only THEN runs ``add_shutdown_callback`` callbacks.  So a callback
        can never wake ``R1Interview.run`` (R1 registers none), the drain is the
        ``CancelledError`` ``run`` handles, and the teardown budget is sized to
        ``shutdown_process_timeout - 15``.  If an SDK bump changes any of this, the
        teardown design must be revisited, not just this test.
        """
        import r1_session

        drain = inspect.getsource(AgentServer.drain)
        self.assertIn("proc.join()", drain)  # it waits for the jobs to finish by themselves
        self.assertNotIn("shutdown", drain.lower())  # ...and never tells them to stop
        run_job = inspect.getsource(job_proc_lazy_main._JobProc._run_job_task)
        steps = [
            "await self._shutdown_fut",
            "asyncio.shield(job_entry_task), timeout=15",
            "aio.cancel_and_wait(job_entry_task)",
            "session.aclose()",
            "self._room.disconnect()",
            "for callback in self._job_ctx._shutdown_callbacks",
        ]
        positions = [run_job.find(step) for step in steps]
        self.assertNotIn(-1, positions, dict(zip(steps, positions)))
        self.assertEqual(positions, sorted(positions), "the SDK reordered its shutdown steps")
        # The callbacks are consumed in exactly this one place.
        self.assertEqual(inspect.getsource(job_proc_lazy_main).count("_shutdown_callbacks"), 1)
        self.assertEqual(r1_session.SDK_ENTRYPOINT_GRACE_SECONDS, 15.0)

    def test_room_event_signatures_and_track_muted_shape_are_pinned(self) -> None:
        room_source = inspect.getsource(rtc.Room)
        for event_name in (
            "participant_connected",
            "participant_disconnected",
            "track_muted",
            "track_unmuted",
            "track_published",
            "track_unpublished",
            "disconnected",
            "data_received",
        ):
            self.assertIn(event_name, room_source)
        self.assertIn("participant, publication", room_source)
        # track_published/unpublished pass (publication, participant): the reverse order.
        self.assertIn('self.emit("track_published", rpublication, rparticipant)', room_source)
        self.assertIn('self.emit("track_unpublished", rpublication, rparticipant)', room_source)
        self.assertTrue(callable(getattr(rtc.Room, "on")))
        self.assertTrue(callable(getattr(rtc.Room, "isconnected")))

    def test_server_sent_data_reaches_the_ready_handler_in_the_sdk_shape(self) -> None:
        """The "I'm ready" button is a SERVER-sent data message (R1-Q): pin what the SDK delivers.

        ``Room`` emits ``data_received`` with one ``DataPacket`` whose ``participant`` is None
        when the message was sent by a server SDK (the API relay), and whose ``topic`` is the
        sender's topic.  The handler accepts exactly that and nothing a participant sent.
        """
        import dataclasses

        import r1_session
        from r1_phases import R1Phase

        room_source = inspect.getsource(rtc.Room)
        self.assertIn('"data_received"', room_source)
        self.assertIn("topic=packet.user.topic", room_source)
        self.assertIn("self._retrieve_remote_participant(packet.participant_identity)", room_source)
        self.assertEqual(
            [field.name for field in dataclasses.fields(rtc.DataPacket)],
            ["data", "kind", "participant", "topic"],
        )
        self.assertIn("None when sent by a server SDK", inspect.getsource(rtc.DataPacket))

        interview = r1_session.R1Interview(
            mock.Mock(room=None, spec_set=["room"]),
            {"first_name": "Asha", "candidate_identity": "candidate"},
            _RecordingSession(),
            _RecordingWriter(),
        )
        interview.machine.transition(R1Phase.OPENING)
        interview.machine.transition(R1Phase.ICEBREAKER)
        interview._enter(R1Phase.TRANSITION)
        payload = b'{"v":1,"kind":"ready"}'
        reliable = rtc.DataPacketKind.KIND_RELIABLE

        def packet(**over):
            fields = {"data": payload, "kind": reliable, "participant": None, "topic": "r1ready"}
            return rtc.DataPacket(**{**fields, **over})

        for refused in (
            packet(participant=mock.Mock(identity="candidate")),
            packet(topic="lk.chat"),
            packet(topic=None),
            packet(data=b'{"v":1,"kind":"ready","x":1}'),
        ):
            interview._on_data_received(refused)
            self.assertFalse(interview._ready_latched)
        interview._on_data_received(packet())
        self.assertTrue(interview._ready_latched)

    def test_publication_mute_state_and_participant_publications_are_readable(self) -> None:
        self.assertIsInstance(inspect.getattr_static(rtc.TrackPublication, "muted"), property)
        self.assertIsInstance(
            inspect.getattr_static(rtc.RemoteParticipant, "track_publications"), property
        )

    def test_candidate_kind_and_microphone_constants_exist(self) -> None:
        self.assertIsNotNone(rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)
        self.assertIsNotNone(rtc.TrackKind.KIND_AUDIO)
        self.assertIsNotNone(rtc.TrackSource.SOURCE_MICROPHONE)

    def test_room_options_match_r1_start_contract(self) -> None:
        options = RoomOptions(text_input=False, close_on_disconnect=False)
        self.assertFalse(options.text_input)
        self.assertFalse(options.close_on_disconnect)

    def test_r1_connection_and_error_contracts_exist(self) -> None:
        """Pin retry construction and ErrorEvent's nested provider-error shape."""
        api_options = APIConnectOptions(max_retry=1, retry_interval=0.5, timeout=10.0)
        session_options = SessionConnectOptions(llm_conn_options=api_options)
        self.assertEqual(session_options.llm_conn_options, api_options)
        self.assertIn("error", ErrorEvent.model_fields)
        self.assertIn("source", ErrorEvent.model_fields)
        self.assertIn("error", CloseEvent.model_fields)

    def test_provider_errors_say_whether_they_are_recoverable(self) -> None:
        for field in ("type", "recoverable", "error"):
            self.assertIn(field, LLMError.model_fields)
        error = LLMError(timestamp=0.0, label="t", error=RuntimeError("x"), recoverable=True)
        self.assertEqual(error.type, "llm_error")
        self.assertTrue(error.recoverable)

    def test_room_metadata_and_local_attributes_contracts_exist(self) -> None:
        """Pin the room metadata property and lower-level participant attributes API."""
        self.assertIsInstance(inspect.getattr_static(rtc.Room, "metadata"), property)
        self.assertTrue(callable(getattr(rtc.LocalParticipant, "set_attributes")))
        attributes = inspect.signature(rtc.LocalParticipant.set_attributes).parameters
        self.assertIn("attributes", attributes)


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1RecordingContract(unittest.IsolatedAsyncioTestCase):
    """The SDK symbols the in-worker recorder (``r1_recorder``) reaches into.

    ``R1RecorderIO`` subclasses the SDK's ``RecorderIO`` and replaces two of its private queues;
    the turn anchors read SDK timestamps; the camera is no longer subscribed at connect.  Every
    one of those is a fact about livekit-agents 1.6.4, pinned here so a bump fails CI instead of
    silently breaking a recording.
    """

    async def test_recorder_io_has_the_constructor_methods_and_queues_the_tee_replaces(self) -> None:
        import queue

        from livekit.agents.voice.recorder_io import recorder_io as rio

        params = inspect.signature(rio.RecorderIO.__init__).parameters
        self.assertEqual([n for n in params if n != "self"], ["agent_session", "sample_rate", "loop"])
        self.assertEqual(params["sample_rate"].default, 48000)
        start = inspect.signature(rio.RecorderIO.start).parameters
        self.assertIn("output_path", start)
        self.assertTrue(inspect.iscoroutinefunction(rio.RecorderIO.start))
        self.assertTrue(inspect.iscoroutinefunction(rio.RecorderIO.aclose))
        self.assertIsInstance(inspect.getattr_static(rio.RecorderIO, "recording"), property)
        for name in ("record_input", "record_output", "_write_cb", "_forward_task", "_encode_thread"):
            self.assertTrue(callable(getattr(rio.RecorderIO, name)), name)
        recorder = rio.RecorderIO(agent_session=object())
        # The two private queues the tee swaps for its own subclass, as plain thread queues.
        self.assertIsInstance(recorder._in_q, queue.Queue)
        self.assertIsInstance(recorder._out_q, queue.Queue)
        for attribute in ("_started", "_in_record", "_out_record", "_sample_rate"):
            self.assertTrue(hasattr(recorder, attribute), attribute)
        self.assertFalse(recorder.recording)
        self.assertEqual(rio.WRITE_INTERVAL, 2.5)

    def test_the_stock_recorder_writes_both_queues_in_lock_step_and_ends_them_with_none(self) -> None:
        from livekit.agents.voice.recorder_io import recorder_io as rio

        write = inspect.getsource(rio.RecorderIO._write_cb)
        self.assertLess(write.index("self._in_q.put_nowait"), write.index("self._out_q.put_nowait"))
        forward = inspect.getsource(rio.RecorderIO._forward_task)
        self.assertIn("self._in_q.put_nowait(input_buf)", forward)
        self.assertIn("self._out_q.put_nowait([])", forward)
        close = inspect.getsource(rio.RecorderIO.aclose)
        self.assertIn("self._in_q.put_nowait(None)", close)
        self.assertIn("self._out_q.put_nowait(None)", close)
        # The tee overrides ``put``; the SDK must keep using ``put_nowait`` (which calls it).
        self.assertNotIn(".put(", write + forward + close)

    def test_the_taps_expose_what_the_idle_tail_flush_and_the_wiring_use(self) -> None:
        from livekit.agents.voice.recorder_io import recorder_io as rio

        take = inspect.signature(rio.RecorderAudioInput.take_buf).parameters
        self.assertEqual(list(take), ["self", "pad_since"])
        self.assertIsInstance(inspect.getattr_static(rio.RecorderAudioOutput, "has_pending_data"), property)
        finished = inspect.signature(rio.RecorderAudioOutput.on_playback_finished).parameters
        self.assertEqual(
            list(finished), ["self", "playback_position", "interrupted", "synchronized_transcript"]
        )
        self.assertIn("_last_speech_end_time", inspect.getsource(rio.RecorderAudioOutput.__init__))
        # Capture stops when ``recording`` reads False.
        self.assertIn("self.__recording_io.recording", inspect.getsource(rio.RecorderAudioInput.__anext__))
        self.assertIn("self.__recording_io.recording", inspect.getsource(rio.RecorderAudioOutput.capture_frame))

    def test_the_first_input_chunk_is_padded_once_with_silence_the_mixer_can_recognise(self) -> None:
        """What the tee's trim of a chunk that is ahead of the clock relies on (review round 1).

        The SDK pads the candidate's FIRST input chunk, once, in front, with silence of the length
        (first microphone frame - end of the last agent line); the mixer has already filled that
        stretch from the wall clock.  It trims the duplicate, but only samples at or below
        ``SILENCE_LEVEL`` on both channels: the resampler turns the SDK's digital silence into +-1 LSB
        of dither, never more.
        """
        import numpy as np
        from livekit.agents.voice.recorder_io import recorder_io as rio

        import r1_recorder

        take = inspect.getsource(rio.RecorderAudioInput.take_buf)
        self.assertIn("self.__started_time - pad_since", take)
        self.assertIn("not self.__padded", take)
        self.assertIn("self.__padded = True", take)
        self.assertIn("_create_silence_frame(padding, frames[0].sample_rate, frames[0].num_channels)", take)
        self.assertLessEqual(r1_recorder.SILENCE_LEVEL, 4)
        silent = rtc.AudioFrame(
            data=bytes(2 * 24000 * 3), sample_rate=24000, num_channels=1, samples_per_channel=24000 * 3
        )
        converted = r1_recorder._ChannelResampler().convert([silent], flush=True)
        self.assertGreater(len(converted), 2 * 48000)
        self.assertLessEqual(int(np.abs(converted.astype(np.int32)).max()), r1_recorder.SILENCE_LEVEL)

    def test_the_session_accepts_a_replacement_audio_input_and_output_after_start(self) -> None:
        from livekit.agents.voice import io as lk_io

        for container in (lk_io.AgentInput, lk_io.AgentOutput):
            prop = inspect.getattr_static(container, "audio")
            self.assertIsInstance(prop, property)
            self.assertIsNotNone(prop.fset, container.__name__)
        self.assertIn("record", inspect.signature(AgentSession.start).parameters)

    def test_audio_only_is_the_connect_option_that_stops_the_camera_being_forwarded(self) -> None:
        from livekit.agents import AutoSubscribe
        from livekit.agents import job as lk_job

        self.assertEqual(AutoSubscribe.AUDIO_ONLY.value, "audio_only")
        connect = inspect.signature(JobContext.connect).parameters
        self.assertEqual(connect["auto_subscribe"].default, AutoSubscribe.SUBSCRIBE_ALL)
        source = inspect.getsource(JobContext.connect)
        # Anything but SUBSCRIBE_ALL turns the room's own auto-subscribe off ...
        self.assertIn("auto_subscribe=auto_subscribe == AutoSubscribe.SUBSCRIBE_ALL", source)
        self.assertIn("_apply_auto_subscribe_opts(self._room, auto_subscribe)", source)
        # ... and AUDIO_ONLY then subscribes audio publications (now and when they are published).
        apply = inspect.getsource(lk_job._apply_auto_subscribe_opts)
        self.assertIn(
            "auto_subscribe == AutoSubscribe.AUDIO_ONLY and pub.kind == rtc.TrackKind.KIND_AUDIO", apply
        )
        self.assertIn('room.on("track_published")', apply)
        self.assertTrue(callable(rtc.RemoteTrackPublication.set_subscribed))

    def test_the_speech_timestamps_the_turn_anchors_read_exist(self) -> None:
        hints = typing.get_type_hints(MetricsReport)
        self.assertIs(hints["started_speaking_at"], float)
        self.assertIn("metrics", ChatMessage.model_fields)
        for event in (UserStateChangedEvent, AgentStateChangedEvent, UserInputTranscribedEvent):
            self.assertIn("created_at", event.model_fields, event.__name__)
            self.assertIs(event.model_fields["created_at"].annotation, float)
        # created_at is the wall clock (time.time()) the recording's start time is taken from.
        default = UserStateChangedEvent(old_state="listening", new_state="speaking").created_at
        self.assertLess(abs(default - time.time()), 5.0)
        self.assertIn(
            'assistant_metrics["started_speaking_at"] = started_speaking_at',
            inspect.getsource(AgentActivity),
        )

    def test_the_camera_symbols_the_picture_capture_relies_on(self) -> None:
        import r1_recorder

        # The recorder compares plain numbers (it never imports the enums): they must be the SDK's.
        self.assertEqual(int(rtc.TrackKind.KIND_VIDEO), r1_recorder.KIND_VIDEO)
        self.assertEqual(int(rtc.TrackSource.SOURCE_CAMERA), r1_recorder.SOURCE_CAMERA)
        self.assertEqual(int(rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD), r1_recorder.PARTICIPANT_STANDARD)
        self.assertEqual(int(rtc.VideoBufferType.I420), r1_recorder.BUFFER_I420)
        self.assertEqual(
            {
                int(rtc.VideoRotation.VIDEO_ROTATION_0): 0,
                int(rtc.VideoRotation.VIDEO_ROTATION_90): 90,
                int(rtc.VideoRotation.VIDEO_ROTATION_180): 180,
                int(rtc.VideoRotation.VIDEO_ROTATION_270): 270,
            },
            r1_recorder.ROTATION_DEGREES,
        )
        # Publications: readable kind/source/subscribed/track, and a boolean subscription request.
        for name in ("kind", "source", "sid"):
            self.assertIsInstance(inspect.getattr_static(rtc.TrackPublication, name), property, name)
        for name in ("subscribed", "track"):
            self.assertIsInstance(inspect.getattr_static(rtc.RemoteTrackPublication, name), property, name)
        self.assertEqual(list(inspect.signature(rtc.RemoteTrackPublication.set_subscribed).parameters), ["self", "subscribed"])
        self.assertIsInstance(inspect.getattr_static(rtc.Track, "sid"), property)
        # Room events: the argument ORDER differs between them (track first for subscribe).
        room_source = inspect.getsource(rtc.Room)
        self.assertIn('self.emit("track_subscribed", remote_video_track, rpublication, rparticipant)', room_source)
        self.assertIn('self.emit("track_unsubscribed", rtrack, rpublication, rparticipant)', room_source)
        self.assertIn('self.emit("participant_connected", rparticipant)', room_source)
        self.assertIn('self.emit("participant_disconnected", rparticipant)', room_source)
        self.assertTrue(callable(rtc.Room.on) and callable(rtc.Room.off))
        # The decoded-frame stream: (track, loop, capacity, format), async iteration, aclose.
        params = inspect.signature(rtc.VideoStream.__init__).parameters
        self.assertEqual(list(params)[:5], ["self", "track", "loop", "capacity", "format"])
        self.assertEqual(params["capacity"].default, 0)
        self.assertTrue(inspect.iscoroutinefunction(rtc.VideoStream.aclose))
        self.assertTrue(hasattr(rtc.VideoStream, "__aiter__") and hasattr(rtc.VideoStream, "__anext__"))
        self.assertEqual(
            list(typing.get_type_hints(rtc.video_stream.VideoFrameEvent)), ["frame", "timestamp_us", "rotation", "metadata"]
        )
        self.assertIn("normalize_stride = True", inspect.getsource(rtc.VideoStream._create_owned_stream))

    def test_a_real_i420_frame_is_taken_as_tightly_packed_bytes_by_the_capture(self) -> None:
        import r1_recorder
        from types import SimpleNamespace

        planes = bytes(range(256)) * ((640 * 360 * 3 // 2) // 256 + 1)
        frame = rtc.VideoFrame(640, 360, rtc.VideoBufferType.I420, bytearray(planes[: 640 * 360 * 3 // 2]))
        self.assertEqual((frame.width, frame.height, int(frame.type)), (640, 360, r1_recorder.BUFFER_I420))
        for rotation, degrees in ((rtc.VideoRotation.VIDEO_ROTATION_0, 0), (rtc.VideoRotation.VIDEO_ROTATION_90, 90),
                                  (rtc.VideoRotation.VIDEO_ROTATION_270, 270)):
            picture = r1_recorder.CameraCapture._picture(SimpleNamespace(frame=frame, rotation=rotation))
            self.assertIsNotNone(picture)
            width, height, turn, data = picture
            self.assertEqual((width, height, turn), (640, 360, degrees))
            self.assertIsInstance(data, bytes)
            self.assertEqual(data, planes[: 640 * 360 * 3 // 2])
        # A frame in another pixel format is converted, by the SDK, before it is taken.
        rgba = rtc.VideoFrame(640, 360, rtc.VideoBufferType.RGBA, bytearray(640 * 360 * 4))
        converted = r1_recorder.CameraCapture._picture(SimpleNamespace(frame=rgba, rotation=rtc.VideoRotation.VIDEO_ROTATION_0))
        self.assertIsNotNone(converted)
        self.assertEqual(len(converted[3]), 640 * 360 * 3 // 2)

    def test_the_vad_metrics_the_picture_watchdog_reads_exist(self) -> None:
        from livekit.agents import vad as lk_vad
        from livekit.agents.metrics import VADMetrics

        self.assertIsInstance(inspect.getattr_static(AgentSession, "vad"), property)
        self.assertTrue(callable(lk_vad.VAD.on) and callable(lk_vad.VAD.off))
        for field in ("inference_duration_total", "inference_count"):
            self.assertIn(field, VADMetrics.model_fields, field)
        self.assertIn("update_interval", lk_vad.VADCapabilities.__dataclass_fields__)
        self.assertIn('self._vad.emit("metrics_collected", vad_metrics)', inspect.getsource(lk_vad.VADStream))

    def test_the_resampler_and_audio_frame_shapes_the_tee_relies_on(self) -> None:
        params = inspect.signature(rtc.AudioResampler.__init__).parameters
        for name in ("input_rate", "output_rate", "num_channels"):
            self.assertIn(name, params)
        self.assertTrue(callable(rtc.AudioResampler.push) and callable(rtc.AudioResampler.flush))
        frame = rtc.AudioFrame(
            data=b"\x00\x00" * 480, sample_rate=24000, num_channels=1, samples_per_channel=480
        )
        for name in ("sample_rate", "num_channels", "samples_per_channel", "data", "duration"):
            self.assertTrue(hasattr(frame, name), name)
        resampler = rtc.AudioResampler(input_rate=24000, output_rate=48000, num_channels=1)
        produced = list(resampler.push(frame)) + list(resampler.flush())
        self.assertGreater(sum(f.samples_per_channel for f in produced), 800)
        self.assertEqual({f.sample_rate for f in produced}, {48000})


class _RecordingSession:
    """Just the surface ``R1Interview.wire_events`` and the slot lookup use."""

    def __init__(self) -> None:
        self.handlers: dict = {}
        self.current_speech = None

    def on(self, name: str, callback) -> None:
        self.handlers.setdefault(name, []).append(callback)

    def emit(self, name: str, event) -> None:
        for callback in self.handlers.get(name, []):
            callback(event)


class _RecordingWriter:
    async def save_turn(self, index, speaker, text, phase, **kwargs) -> None:
        self.saved.append((index, speaker, text, kwargs.get("interrupted")))

    def __init__(self) -> None:
        self.saved: list = []


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1TranscriptOrderOnTheRealSdk(unittest.IsolatedAsyncioTestCase):
    """Drive R1's transcript handlers with the SDK's own handle, message and event classes."""

    async def assert_barge_in_rows(self, order: str) -> None:
        import r1_session

        session, writer = _RecordingSession(), _RecordingWriter()
        interview = r1_session.R1Interview(
            mock.Mock(room=None, spec_set=["room"]),
            {"first_name": "Asha", "candidate_identity": "candidate"},
            session,
            writer,
        )
        interview.wire_events()
        handle = SpeechHandle.create()
        session.emit(
            "speech_created",
            SpeechCreatedEvent(user_initiated=False, source="generate_reply", speech_handle=handle),
        )
        # The reply starts speaking, then the candidate talks over it.
        session.current_speech = handle
        session.emit(
            "agent_state_changed",
            AgentStateChangedEvent(old_state="listening", new_state="speaking"),
        )
        session.emit(
            "user_input_transcribed",
            UserInputTranscribedEvent(transcript="excuse me", is_final=True),
        )
        item = ChatContext().add_message(role="assistant", content="partial", interrupted=True)
        if order == "say":
            handle._item_added([item])  # the say() order
            session.emit("conversation_item_added", ConversationItemAddedEvent(item=item))
        else:
            session.emit("conversation_item_added", ConversationItemAddedEvent(item=item))
            handle._item_added([item])  # the LLM-reply order
        session.current_speech = None
        # The SDK commits the interrupting turn: its final becomes the candidate's one row.
        with contextlib.suppress(r1_session.StopResponse):
            interview.prepare_turn("excuse me")
        await interview._drain_background()
        rows = sorted(writer.saved)
        self.assertEqual(
            [(index, speaker) for index, speaker, _text, _interrupted in rows],
            [(1, "bot"), (2, "candidate")],
        )
        self.assertTrue(rows[0][3])  # the interrupted flag came from the real ChatMessage

    async def test_an_llm_reply_keeps_its_slot_before_the_interrupting_candidate(self) -> None:
        await self.assert_barge_in_rows("reply")

    async def test_a_scripted_line_keeps_its_slot_before_the_interrupting_candidate(self) -> None:
        await self.assert_barge_in_rows("say")


@unittest.skipUnless(
    AgentSession is not None and _sarvam_plugin is not None,
    "livekit-agents with the sarvam plugin is not installed (bare CI)",
)
class TestR1SessionFactory(unittest.IsolatedAsyncioTestCase):
    """The real factory must hand the SDK exactly the retry and away options R1 relies on."""

    async def test_default_factory_passes_llm_retry_options_and_disables_user_away(self) -> None:
        import livekit.agents as agents
        from livekit.plugins import sarvam

        import r1_latency
        import r1_llm
        import r1_session
        import r1_tts

        captured: dict = {}
        tts_kwargs: dict = {}
        stt_kwargs: dict = {}

        class RecordingSession:
            def __init__(self, **kwargs) -> None:
                captured.update(kwargs)

        def recording_tts(**kwargs):
            tts_kwargs.update(kwargs)
            return "tts"

        def recording_stt(**kwargs):
            stt_kwargs.update(kwargs)
            return "stt"

        # The flip at v3 is today's construction exactly (owner decision 2026-10-30).
        env = {"R1_TTS_PROFILE": "v3"}
        with mock.patch.dict(os.environ, env), mock.patch.object(
            agents, "AgentSession", RecordingSession
        ), mock.patch.object(sarvam, "STT", recording_stt), mock.patch.object(
            sarvam, "TTS", recording_tts
        ), mock.patch.object(
            r1_llm, "build_r1_llm", lambda: "llm"
        ):
            for key in ("R1_STT_MODEL", "SARVAM_STT_MODEL", "SARVAM_LANGUAGE"):
                os.environ.pop(key, None)
            await r1_session._default_session_factory(None, {})

        self.assertEqual(captured["stt"], "stt")
        self.assertEqual(captured["tts"], "tts")
        self.assertEqual(captured["llm"], "llm")
        self.assertIsNone(captured["user_away_timeout"])
        options = captured["conn_options"]
        self.assertIsInstance(options, SessionConnectOptions)
        self.assertEqual(
            options.llm_conn_options,
            APIConnectOptions(max_retry=1, retry_interval=0.5, timeout=10.0),
        )
        # Browser parity: no VAD and no turn DETECTOR override.  PR-4c gives the session R1's
        # turn timings (endpointing, interruption, preemptive generation off) and nothing else.
        self.assertNotIn("vad", captured)
        self.assertEqual(captured["turn_handling"], r1_latency.r1_turn_handling())
        self.assertNotIn("turn_detection", captured["turn_handling"])
        # The session's voice is the one the line cache synthesises with.
        self.assertEqual(tts_kwargs, r1_tts.r1_tts_kwargs())
        self.assertEqual(
            tts_kwargs,
            {"model": "bulbul:v3", "speaker": "simran", "pace": 1.0, "temperature": 0.8},
        )
        self.assertEqual(stt_kwargs, {"model": "saaras:v4", "language": "en-IN"})

    async def test_r1_agent_builds_on_the_real_agent_and_routes_its_llm_node(self) -> None:
        import r1_session

        interview = mock.Mock()
        agent = r1_session.R1Agent(interview)
        self.assertIsInstance(agent, Agent)
        self.assertIs(agent.interview, interview)
        # Only preemptive generation is overridden: it would start BEFORE the hook that
        # decides the learner's reminder, so it could answer without it.
        self.assertEqual(agent._turn_handling, {"preemptive_generation": {"enabled": False}})
        marker = object()
        interview.llm_node_stream.return_value = marker
        seen: dict = {}

        def inner(_self, chat_ctx, tools, model_settings):
            seen.update(ctx=chat_ctx, tools=tools, settings=model_settings)
            return "inner"

        with mock.patch.object(Agent, "llm_node", inner):
            sdk_ctx = object()
            self.assertIs(agent.llm_node(sdk_ctx, [object()], "settings"), marker)
            args = interview.llm_node_stream.call_args.args
            self.assertIs(args[0], sdk_ctx)
            # The provider starts the model call for exactly the filtered messages, with no
            # tools whatever the SDK passed, and the SDK chat context built from them alone.
            self.assertEqual(
                args[1](
                    [
                        {"role": "system", "content": "prefix"},
                        {"role": "user", "content": "hello"},
                    ]
                ),
                "inner",
            )
        self.assertEqual(seen["tools"], [])
        self.assertEqual(seen["settings"], "settings")
        self.assertEqual(
            [(item.role, item.text_content) for item in seen["ctx"].items],
            [("system", "prefix"), ("user", "hello")],
        )

    async def test_r1_agent_raises_the_sdks_stop_response_when_the_driver_owns_the_turn(
        self,
    ) -> None:
        import r1_session

        self.assertIs(r1_session.StopResponse, StopResponse)
        interview = mock.Mock()
        # The hook awaits the interview's async decision (owner decision 2026-10-30: a role-play
        # turn may wait for its end-intent verdict), and the SDK awaits the hook.
        interview.prepare_turn_async = mock.AsyncMock(side_effect=StopResponse())
        agent = r1_session.R1Agent(interview)
        with self.assertRaises(StopResponse):
            await agent.on_user_turn_completed(
                mock.Mock(), mock.Mock(text_content="ready", id="msg_1")
            )
        interview.prepare_turn_async.assert_awaited_once_with("ready", "msg_1")
        interview.prepare_turn.assert_not_called()
        interview.prepare_turn_async.side_effect = None
        await asyncio.wait_for(
            agent.on_user_turn_completed(mock.Mock(), mock.Mock(text_content="hello")), 1.0
        )


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1LlmNodeOnTheRealSdk(unittest.IsolatedAsyncioTestCase):
    """The REAL ``Agent.llm_node`` runs inside R1's guarded pipeline on the filtered context.

    ``r1_session`` calls ``Agent.llm_node(self, <filtered ChatContext>, [], settings)``; this
    drives that call through the SDK's own default node, a real ``llm.LLM`` subclass and the
    SDK's ``ChatChunk`` and ``ChatContext`` classes, so a signature or stream-shape drift
    fails here and not at the first real room.
    """

    def build(self, replies: list[str]):
        from livekit.agents import llm as agents_llm

        import r1_session
        from tests.test_r1_core import FakeContext, FakeSession, FakeWriter

        seen: dict = {"calls": []}

        class FakeStream:
            def __init__(self, text: str) -> None:
                self.text = text

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return False

            def __aiter__(self):
                return self._chunks()

            async def _chunks(self):
                for word in self.text.split(" "):
                    yield agents_llm.ChatChunk(
                        id="chunk",
                        delta=agents_llm.ChoiceDelta(role="assistant", content=word + " "),
                    )

        class FakeLLM(agents_llm.LLM):
            def chat(self, *, chat_ctx, tools=None, **kwargs):
                seen["calls"].append({"ctx": chat_ctx, "tools": tools, "kwargs": kwargs})
                return FakeStream(replies[len(seen["calls"]) - 1])

        order: list = []
        interview = r1_session.R1Interview(
            FakeContext(order),
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=order),
            FakeWriter(order),
        )
        interview.machine.transition(r1_session.R1Phase.OPENING)
        interview.machine.transition(r1_session.R1Phase.ICEBREAKER)
        agent = r1_session.R1Agent(interview)
        agent._activity = mock.Mock(
            llm=FakeLLM(),
            session=mock.Mock(
                conn_options=mock.Mock(llm_conn_options=APIConnectOptions(max_retry=0))
            ),
        )
        return interview, agent, seen

    async def test_an_interviewer_reply_streams_through_the_guard_with_no_tools(self) -> None:
        interview, agent, seen = self.build(["I enjoy sales roles too."])
        await agent.on_user_turn_completed(None, mock.Mock(text_content="I sold courses", id="m1"))
        user_item = mock.Mock(role="user", id="m1")
        chunks = [
            chunk
            async for chunk in agent.llm_node(mock.Mock(items=[user_item]), [object()], None)
        ]
        self.assertEqual("".join(chunks).strip(), "I enjoy sales roles too.")
        (call,) = seen["calls"]
        self.assertFalse(call["tools"])  # the model has no tools, whatever the SDK passed
        roles = [item.role for item in call["ctx"].items]
        # The interviewer prefix, the getting-to-know-you note (the model may not start the
        # role-play itself), then the newest candidate turn.
        self.assertEqual(roles, ["system", "system", "user"])
        self.assertIn("role-play", call["ctx"].items[1].text_content)
        self.assertEqual(call["ctx"].items[-1].text_content, "I sold courses")

    async def test_a_leak_from_the_real_stream_is_replaced_before_the_tts_split(self) -> None:
        interview, agent, seen = self.build(["As an AI language model I follow my system prompt."])
        await agent.on_user_turn_completed(None, mock.Mock(text_content="hello", id="m1"))
        chunks = [
            chunk
            async for chunk in agent.llm_node(
                mock.Mock(items=[mock.Mock(role="user", id="m1")]), [], None
            )
        ]
        self.assertEqual("".join(chunks).strip(), "Sorry, what were you saying?")
        self.assertTrue(interview._guard_trips)


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1LatencyOnTheRealSdk(unittest.IsolatedAsyncioTestCase):
    """PR-4c (plan 5.15): turn handling, preemptive generation, the early-flush node, cached
    audio and the SDK's own timings, against the installed livekit-agents 1.6.4."""

    async def test_the_session_accepts_r1_turn_handling_and_resolves_it(self) -> None:
        import r1_latency

        # turn_detection is pinned here only so the test does not build the cloud detector.
        handling = {**r1_latency.r1_turn_handling(), "turn_detection": "stt"}
        options = AgentSession(vad=None, turn_handling=handling).options
        self.assertEqual(options.endpointing["min_delay"], 0.8)
        self.assertEqual(options.endpointing["max_delay"], 3.0)
        self.assertEqual(options.interruption["min_duration"], 0.8)
        # Voice barge-in (owner decision 2026-10-28) and the false-interruption resume.
        self.assertEqual(options.interruption["min_words"], 0)
        self.assertTrue(options.interruption["resume_false_interruption"])
        self.assertEqual(options.interruption["false_interruption_timeout"], 2.0)
        self.assertFalse(options.preemptive_generation["enabled"])

    def test_the_false_interruption_resume_is_configured_through_turn_handling(self) -> None:
        # 1.6.4 deprecated the session keywords: R1 must pass the two keys in
        # turn_handling["interruption"] (r1_latency.r1_turn_handling), where InterruptionOptions
        # declares them.
        from livekit.agents.voice.turn import InterruptionOptions, _INTERRUPTION_DEFAULTS

        self.assertIn("resume_false_interruption", InterruptionOptions.__annotations__)
        self.assertIn("false_interruption_timeout", InterruptionOptions.__annotations__)
        self.assertTrue(_INTERRUPTION_DEFAULTS["resume_false_interruption"])
        self.assertEqual(_INTERRUPTION_DEFAULTS["false_interruption_timeout"], 2.0)
        init = inspect.getsource(AgentSession.__init__)
        for keyword in ("false_interruption_timeout", "resume_false_interruption"):
            self.assertIn(
                f'"{keyword}": "Use turn_handling=TurnHandlingOptions(...) instead"', init
            )
        self.assertIn("agent_false_interruption", typing.get_args(EventTypes))

    def test_a_pause_needs_the_resume_flag_a_timeout_and_an_output_that_can_pause(self) -> None:
        pause = inspect.getsource(AgentActivity._pause_enabled)
        for condition in (
            'interruption_options["resume_false_interruption"]',
            'interruption_options["false_interruption_timeout"] is not None',
            "self._session.output.audio.can_pause",
        ):
            self.assertIn(condition, pause)
        # R1's chain: the recorder tee (r1_recorder wraps the session's audio output) in front of
        # the room's output.  Both declare pause, and a chain can pause only if every link can.
        from livekit.agents.voice import io as voice_io
        from livekit.agents.voice.recorder_io.recorder_io import RecorderAudioOutput
        from livekit.agents.voice.room_io._output import _ParticipantAudioOutput

        pausable = "capabilities=io.AudioOutputCapabilities(pause=True)"
        self.assertIn(pausable, inspect.getsource(RecorderAudioOutput.__init__))
        self.assertIn(pausable, inspect.getsource(_ParticipantAudioOutput.__init__))
        self.assertIn(
            "self._capabilities.pause and (not self.next_in_chain or self.next_in_chain.can_pause)",
            inspect.getsource(voice_io.AudioOutput.can_pause.fget),
        )
        for output in (RecorderAudioOutput, _ParticipantAudioOutput):
            self.assertIn("def pause(", inspect.getsource(output))
            self.assertIn("def resume(", inspect.getsource(output))

    def test_with_no_vad_given_the_session_runs_the_sdks_default_detector(self) -> None:
        # R1 passes no vad (browser parity), so a VAD exists and min_duration is applied by it.
        init = inspect.getsource(AgentSession.__init__)
        self.assertIn("self._using_default_vad = not is_given(vad)", init)
        self.assertIn('vad = inference.VAD(model="silero")', init)

    def test_min_duration_gates_the_voice_detector_and_a_final_cuts_whatever_its_length(self) -> None:
        # The runbook's trade-off: 0.8 s of voice pauses a line (VAD path); a final transcript
        # always reaches _interrupt_by_audio_activity and then interrupts the paused line, so a
        # transcribed "yeah" cuts the learner even when it was shorter than 0.8 s.
        vad = inspect.getsource(AgentActivity.on_vad_inference_done)
        self.assertIn(
            'ev.speech_duration >= self._session.options.interruption["min_duration"]', vad
        )
        self.assertIn("self._interrupt_by_audio_activity()", vad)
        final = inspect.getsource(AgentActivity.on_final_transcript)
        self.assertNotIn("min_duration", final)
        self.assertLess(
            final.index("self._interrupt_by_audio_activity()"),
            final.index("self._cancel_speech_pause("),
        )
        cancel = inspect.getsource(AgentActivity._cancel_speech_pause)
        self.assertIn("interrupt: bool = True", cancel)
        self.assertIn("self._paused_speech.handle.interrupt()", cancel)
        # At min_words 0 the word check is skipped entirely; above 0 it reads the HELD transcript.
        barge = inspect.getsource(AgentActivity._interrupt_by_audio_activity)
        self.assertIn('interruption_options["min_words"] > 0', barge)
        # Paused, not cut, when resume is on; cut at once when it is off.
        self.assertLess(barge.index("if self._pause_enabled():"), barge.index("audio_output.pause()"))
        self.assertIn("self._current_speech.interrupt()", barge)
        # Only an interruptible speech that is not already cut is paused or cut.
        self.assertIn("and self._current_speech.allow_interruptions", barge)

    def test_a_pause_no_transcript_follows_resumes_the_same_line(self) -> None:
        # The timer starts when the candidate's speech ends and, unless a final or new speech
        # cancels it, resumes the paused audio of the SAME speech handle.
        end = inspect.getsource(AgentActivity.on_end_of_speech)
        self.assertIn("self._start_false_interruption_timer(self._paused_speech.timeout)", end)
        timer = inspect.getsource(AgentActivity._start_false_interruption_timer)
        self.assertIn("audio_output.resume()", timer)
        self.assertIn("not self._paused_speech.handle.done()", timer)
        self.assertIn('"agent_false_interruption", AgentFalseInterruptionEvent(resumed=resumed)', timer)
        start = inspect.getsource(AgentActivity.on_start_of_speech)
        self.assertIn("self._false_interruption_timer.cancel()", start)

    def test_the_cut_line_is_finished_before_r1_plans_the_turn_that_cut_it(self) -> None:
        # r1_roleplay relies on this: when the hook runs, the interrupted learner line has been
        # reported (record_spoken(interrupted=True)), so the engine knows the learner was cut.
        completed = inspect.getsource(AgentActivity._user_turn_completed_task)
        self.assertLess(
            completed.index("await current_speech.interrupt()"),
            completed.index("await self._agent.on_user_turn_completed("),
        )
        self.assertIn("await self.wait_for_playout()", inspect.getsource(SpeechHandle.__await__))

    def test_the_session_takes_a_new_endpointing_pair_while_it_runs(self) -> None:
        # r1_session._apply_endpointing: the transition phase runs 0.4 / 1.2 s through
        # AgentSession.update_options and the session's own pair is restored afterwards.
        import r1_latency

        self.assertIn("endpointing_opts", inspect.signature(AgentSession.update_options).parameters)
        session = AgentSession(
            vad=None, turn_handling={**r1_latency.r1_turn_handling(), "turn_detection": "stt"}
        )
        session.update_options(endpointing_opts=r1_latency.r1_transition_endpointing())
        self.assertEqual(session.options.endpointing["min_delay"], 0.4)
        self.assertEqual(session.options.endpointing["max_delay"], 1.2)
        session.update_options(endpointing_opts=r1_latency.r1_turn_handling()["endpointing"])
        self.assertEqual(session.options.endpointing["min_delay"], 0.8)
        self.assertEqual(session.options.endpointing["max_delay"], 3.0)
        # A running activity gets a fresh endpointing object built from the session's options.
        self.assertIn("self._opts.endpointing if is_given(endpointing_opts)", inspect.getsource(
            AgentSession.update_options
        ))
        activity = inspect.getsource(AgentActivity.update_options)
        self.assertIn("create_endpointing(endpointing_opts)", activity)
        self.assertIn("self._audio_recognition.update_options(", activity)

    def test_the_sdk_reads_interruption_options_from_the_session_not_the_agent(self) -> None:
        # So R1's interruption numbers must be on the AgentSession (r1_latency.r1_turn_handling),
        # and an agent-level "interruption" would silently do nothing for them.
        self.assertIn(
            'self._session.options.interruption["min_duration"]',
            inspect.getsource(AgentActivity.on_vad_inference_done),
        )
        self.assertIn(
            "interruption_options = self._session.options.interruption",
            inspect.getsource(AgentActivity._interrupt_by_audio_activity),
        )
        agent_init = inspect.getsource(Agent.__init__)
        self.assertNotIn("min_duration", agent_init)
        self.assertNotIn("min_words", agent_init)

    def test_a_short_turn_over_a_reply_the_sdk_may_cut_is_refused_and_its_words_are_banked(self) -> None:
        # The behaviour r1_session._fragment_held_back mirrors.  If any condition below changes,
        # the monologue clock is restarted for fragments the SDK now commits (or the reverse).
        refusal = inspect.getsource(AgentActivity.on_end_of_turn)
        for condition in (
            "self._current_speech is not None",
            "self._current_speech.allow_interruptions",
            "not self._current_speech.interrupted",
            'self._session.options.interruption["min_words"] > 0',
            "len(split_words(info.new_transcript, split_character=True))",
            '< self._session.options.interruption["min_words"]',
        ):
            self.assertIn(condition, refusal)
        refused = refusal[refusal.index('< self._session.options.interruption["min_words"]'):]
        self.assertLess(refused.index("return False"), refused.index("self._user_turn_completed_atask ="))
        # A refused turn leaves the transcript where it is: it is cleared only once committed,
        # so the words are prepended to the next turn.
        recognition = inspect.getsource(AudioRecognition._run_eou_detection)
        self.assertEqual(recognition.count('self._audio_transcript = ""'), 1)
        self.assertLess(
            recognition.index("if committed:"), recognition.index('self._audio_transcript = ""')
        )

    def test_r1_counts_words_the_way_the_sdk_applies_min_words(self) -> None:
        from livekit.agents.tokenize.basic import split_words

        import r1_latency

        cjk = chr(0x4E2D) + chr(0x6587)
        thai = chr(0x0E2A) + chr(0x0E27) + chr(0x0E31)
        quotes = chr(0x201C) + "Hi" + chr(0x201D) + " " + "ok" + chr(0x2026) + " " + chr(0x2014)
        for text in (
            "", "   ", "Yes.", "...", "yes please", "don't", "a - b", "x-y z_w", "$ 5 % ?",
            "Yes please do go on.", "a b  c", "abc" + cjk + "def", thai, quotes,
        ):
            with self.subTest(text=ascii(text)):
                self.assertEqual(
                    r1_latency.count_words(text), len(split_words(text, split_character=True))
                )

    def test_the_sdk_judges_the_interruption_before_it_adds_a_final_to_the_transcript(self) -> None:
        # Why barge-in needs a final of min_words words by itself: the check runs on the
        # transcript as it was BEFORE this final, and no interim fills the gap (next test).
        events = inspect.getsource(AudioRecognition._on_stt_event)
        self.assertLess(
            events.index("self._hooks.on_final_transcript("),
            events.index('self._audio_transcript += f" {transcript}"'),
        )
        self.assertIn(
            "self._audio_recognition.current_transcript",
            inspect.getsource(AgentActivity._interrupt_by_audio_activity),
        )

    @unittest.skipIf(_sarvam_plugin is None, "the sarvam plugin is not installed (bare CI)")
    def test_sarvam_streams_final_transcripts_only(self) -> None:
        # The runbook's statement that R1_INTERRUPT_MIN_DURATION_SEC does nothing while
        # R1_INTERRUPT_MIN_WORDS is above zero rests on this: no interim text ever reaches
        # the transcript the barge-in check reads.  The phone fixtures shadow the plugin with a
        # file-less stub when a mixed run collects them first; CI's SDK step does not, so there
        # the real plugin is always inspected.
        if getattr(_sarvam_plugin, "__file__", None) is not None:
            from livekit.plugins.sarvam import stt as sarvam_stt

            source = inspect.getsource(sarvam_stt)
            self.assertIn("SpeechEventType.FINAL_TRANSCRIPT", source)
            self.assertNotIn("INTERIM_TRANSCRIPT", source)

    def test_preemptive_generation_stays_off_because_the_sdk_cannot_see_the_decision(self) -> None:
        # The facts r1_session._agent_turn_handling gives for leaving it off.  If the SDK
        # changes any of them the decision is worth taking again, so this fails loudly.
        starter = inspect.getsource(AgentActivity.on_preemptive_generation)
        self.assertIn("_generate_reply(", starter)
        self.assertIn("schedule_speech=False", starter)  # the model call starts, speech waits
        completed = inspect.getsource(AgentActivity._user_turn_completed_task)
        hook = completed.index("await self._agent.on_user_turn_completed(")
        keep = completed.index("if preemptive := self._preemptive_generation:")
        self.assertLess(hook, keep)  # the hook runs AFTER the generation has begun
        # The SDK keeps a preemptive generation when the TEXT, the chat context and the tools
        # match.  R1 leaves turn_ctx alone, so nothing the engine decided can make them differ.
        self.assertIn("preemptive.info.new_transcript == user_message.text_content", completed)
        self.assertIn("preemptive.chat_ctx.is_equivalent(temp_mutable_chat_ctx)", completed)

    async def test_the_engines_decision_is_not_idempotent_so_it_cannot_be_run_twice(self) -> None:
        from r1_personas import resolve_persona
        from r1_roleplay import RolePlayEngine

        engine = RolePlayEngine(resolve_persona("p1_career_switcher", variant="v1"), seed="s")
        first = engine.plan_turn("Tell me about your goals for this course", 30.0, turn_index=1)
        second = engine.plan_turn("Tell me about your goals for this course", 30.0, turn_index=2)
        self.assertEqual((first.turn, second.turn), (1, 2))  # each call advances the engine

    def test_r1_agent_routes_its_tts_node_through_the_interview(self) -> None:
        import r1_session

        interview = mock.Mock()
        marker = object()
        interview.tts_node_stream.return_value = marker
        agent = r1_session.R1Agent(interview)
        seen: dict = {}

        def inner(_self, text, model_settings):
            seen.update(text=text, settings=model_settings)
            return "inner"

        with mock.patch.object(Agent, "tts_node", inner):
            text = object()
            self.assertIs(agent.tts_node(text, "settings"), marker)
            args = interview.tts_node_stream.call_args.args
            self.assertIs(args[0], text)
            self.assertEqual(args[1]("stream"), "inner")  # the downstream call is the SDK default
        self.assertEqual(seen["settings"], "settings")
        self.assertFalse(inspect.iscoroutinefunction(r1_session.R1Agent.tts_node))

    async def test_the_early_flush_node_runs_inside_the_sdks_tts_inference(self) -> None:
        from livekit.agents.voice.agent import ModelSettings
        from livekit.agents.voice.generation import perform_tts_inference

        import r1_session
        from tests.test_r1_core import FakeContext, FakeSession, FakeWriter

        order: list = []
        interview = r1_session.R1Interview(
            FakeContext(order),
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=order),
            FakeWriter(order),
        )
        agent = r1_session.R1Agent(interview)
        calls: list[str] = []

        def inner(_self, text, model_settings):
            async def frames():
                calls.append("".join([chunk async for chunk in text]))
                yield rtc.AudioFrame(b"\x01\x00" * 441, 22050, 1, 441)

            return frames()

        async def text():
            for chunk in ("Hello there. ", "How are you today? ", "Fine."):
                await asyncio.sleep(0.005)  # the guard releases a sentence at a time
                yield chunk

        with mock.patch.object(Agent, "tts_node", inner):
            task, data = perform_tts_inference(
                node=agent.tts_node, input=text(), model_settings=ModelSettings(), text_transforms=None
            )
            frames = [frame async for frame in data.audio_ch]
            self.assertTrue(await task)
        self.assertEqual(calls, ["Hello there.", " How are you today? Fine."])
        self.assertEqual(len(frames), 2)
        self.assertTrue(all(isinstance(frame, rtc.AudioFrame) for frame in frames))
        self.assertIsNotNone(data.ttfb)

    def test_say_plays_provided_audio_and_still_forwards_the_text(self) -> None:
        # The line cache plays a stored clip with session.say(text, audio=frames).
        self.assertIn("audio", inspect.signature(AgentSession.say).parameters)
        self.assertIn("audio", inspect.signature(AgentActivity.say).parameters)
        impl = inspect.getsource(AgentActivity._tts_task_impl)
        # Provided audio goes straight to the audio output, no TTS is run for it ...
        self.assertIn("audio_output=audio_output, tts_output=audio", impl)
        # ... and the text still becomes the transcript row (conversation_item_added).
        self.assertIn("self._agent.transcription_node(text_source", impl)
        self.assertIn("self._session._conversation_item_added(msg)", impl)

    async def test_cached_clip_frames_are_real_audio_frames(self) -> None:
        from r1_linecache import PcmClip

        clip = PcmClip(b"\x01\x00" * 4410, 22050, 1)
        frames = [frame async for frame in clip.frames()]
        self.assertTrue(all(isinstance(frame, rtc.AudioFrame) for frame in frames))
        self.assertEqual(sum(frame.samples_per_channel for frame in frames), 4410)
        self.assertEqual(b"".join(bytes(frame.data) for frame in frames), clip.pcm)
        self.assertEqual({(f.sample_rate, f.num_channels) for f in frames}, {(22050, 1)})

    def test_the_synthesis_surface_the_line_cache_relies_on_exists(self) -> None:
        from livekit.agents import APIStatusError
        from livekit.agents.tts import ChunkedStream

        import r1_linecache

        self.assertTrue(inspect.iscoroutinefunction(ChunkedStream.collect))
        self.assertTrue(inspect.iscoroutinefunction(ChunkedStream.aclose))
        self.assertEqual(
            {"max_retry", "timeout"} - set(APIConnectOptions.__dataclass_fields__), set()
        )
        # The phone fixtures (test_phone_gate) shadow the plugin with a file-less stub module when
        # a mixed run collects them first; only the REAL plugin has a __file__.  CI's SDK step
        # does not collect them, so there this always runs.
        if getattr(_sarvam_plugin, "__file__", None) is not None:
            self.assertIn("conn_options", inspect.signature(_sarvam_plugin.TTS.synthesize).parameters)
        frame = rtc.AudioFrame(b"\x01\x00" * 10, 22050, 1, 10)
        self.assertEqual(bytes(frame.data), b"\x01\x00" * 10)  # what the synthesizer stores
        error = APIStatusError("limited", status_code=429)
        self.assertEqual(r1_linecache.status_of(error), 429)
        self.assertTrue(error.retryable)  # the SDK retries a 429, so each one is in an error event

    def test_the_sdk_timings_r1_logs_are_fields_of_its_metrics_report(self) -> None:
        from livekit.agents.llm.chat_context import MetricsReport

        import r1_session

        fields = set(MetricsReport.__annotations__)
        for sdk_name, _schema in r1_session._SDK_METRICS:
            self.assertIn(sdk_name, fields)

    async def test_the_session_error_event_carries_the_429_status_the_counter_reads(self) -> None:
        from livekit.agents import APIStatusError
        from livekit.agents.tts import TTSError

        import r1_session

        error = TTSError(
            timestamp=0.0,
            label="sarvam",
            error=APIStatusError("limited", status_code=429),
            recoverable=True,
        )
        event = ErrorEvent(error=error, source=None)
        self.assertEqual(r1_session.R1Interview._provider_status(event), 429)
        self.assertEqual(error.type, "tts_error")


def _pipeline_kit():
    """Fakes for the providers and the audio output of a REAL ``AgentSession`` (offline).

    The same shapes ``test_gate_sdk_contract`` uses for its audio output; the streaming TTS
    records the text of every ``SynthesizeStream`` it is given, so a test can see exactly how
    many downstream calls R1 made and with what text.
    """
    import time

    from livekit.agents import llm as agents_llm
    from livekit.agents import tts as agents_tts
    from livekit.agents.voice import io as vio

    class Output(vio.AudioOutput):
        def __init__(self) -> None:
            super().__init__(
                label="r1-pipeline",
                capabilities=vio.AudioOutputCapabilities(pause=False),
                sample_rate=24000,
            )
            self.frames: list = []
            self.finished = 0
            self._pending = 0.0
            self._started = False
            self._tasks: set = set()

        async def capture_frame(self, frame) -> None:
            await super().capture_frame(frame)
            if not self._started:
                self._started = True
                self.on_playback_started(created_at=time.time())
            self._pending += frame.duration
            self.frames.append(frame)

        def flush(self) -> None:
            super().flush()
            duration, self._pending, self._started = self._pending, 0.0, False

            async def finish() -> None:
                await asyncio.sleep(min(duration, 0.05))
                self.finished += 1
                self.on_playback_finished(playback_position=duration, interrupted=False)

            task = asyncio.ensure_future(finish())
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        def clear_buffer(self) -> None:
            self._pending = 0.0

    class Stream(agents_tts.SynthesizeStream):
        async def _run(self, output_emitter) -> None:
            output_emitter.initialize(
                request_id="fake", sample_rate=24000, num_channels=1,
                mime_type="audio/pcm", stream=True,
            )
            output_emitter.start_segment(segment_id="segment")
            text = ""
            async for item in self._input_ch:
                if isinstance(item, self._FlushSentinel):
                    break
                text += item
            self._tts.texts.append(text)
            output_emitter.push(b"\x00\x00" * (480 * max(1, len(text) // 8)))
            output_emitter.end_segment()

    class Tts(agents_tts.TTS):
        def __init__(self) -> None:
            super().__init__(
                capabilities=agents_tts.TTSCapabilities(streaming=True),
                sample_rate=24000,
                num_channels=1,
            )
            self.texts: list[str] = []

        def synthesize(self, text, *, conn_options=None):
            raise NotImplementedError

        def stream(self, *, conn_options=None):
            return Stream(tts=self, conn_options=conn_options)

    class LlmStream:
        def __init__(self, text: str) -> None:
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        def __aiter__(self):
            return self._chunks()

        async def _chunks(self):
            # OpenAI-compatible streams (DeepSeek too) carry the space BEFORE a word.
            for index, word in enumerate(self.text.split(" ")):
                await asyncio.sleep(0.005)
                yield agents_llm.ChatChunk(
                    id="chunk",
                    delta=agents_llm.ChoiceDelta(
                        role="assistant", content=(" " if index else "") + word
                    ),
                )

    class Llm(agents_llm.LLM):
        def __init__(self, reply: str) -> None:
            super().__init__()
            self.reply = reply

        def chat(self, *, chat_ctx, tools=None, **kwargs):
            return LlmStream(self.reply)

    return Output, Tts, Llm


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1PipelineOnARealSession(unittest.IsolatedAsyncioTestCase):
    """PR-4c end to end on a REAL ``AgentSession``: a fake LLM, a fake streaming TTS and a fake
    audio output, with the SDK's own scheduling, pipelines and events in between.

    The turn is handed over through ``AgentActivity.on_end_of_turn`` (what audio recognition
    calls), so the SDK runs ``on_user_turn_completed``, the reply and the playout itself.
    """

    REPLY = "Okay, that makes sense. Tell me more about that."

    async def asyncSetUp(self) -> None:
        import r1_latency
        import r1_session
        from tests.test_r1_core import FakeContext, FakeWriter

        output_cls, tts_cls, llm_cls = _pipeline_kit()
        self.r1_session = r1_session
        self.order: list = []
        self.writer = FakeWriter(self.order)
        self.out = output_cls()
        self.tts = tts_cls()
        self.session = AgentSession(
            llm=llm_cls(self.REPLY),
            tts=self.tts,
            vad=None,
            # "manual" only so the test does not build the cloud turn detector.
            turn_handling={**r1_latency.r1_turn_handling(), "turn_detection": "manual"},
        )
        self.session.output.audio = self.out
        self.ctx = FakeContext(self.order)
        self.addAsyncCleanup(self.session.aclose)

    def build(self, **kwargs):
        interview = self.r1_session.R1Interview(
            self.ctx,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            self.session,
            self.writer,
            **kwargs,
        )
        interview.wire_events()
        interview.machine.transition(self.r1_session.R1Phase.OPENING)
        interview.machine.transition(self.r1_session.R1Phase.ICEBREAKER)
        return interview

    async def until(self, predicate, timeout: float = 10.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while not predicate():
            if asyncio.get_running_loop().time() > deadline:
                self.fail("condition not reached in time")
            await asyncio.sleep(0.01)

    def bot_rows(self) -> list[dict]:
        return [row for row in self.writer.saved if row["speaker"] == "bot"]

    async def candidate_turn(self, text: str) -> None:
        import time

        from livekit.agents.voice import audio_recognition

        self.session.emit(
            "user_input_transcribed", UserInputTranscribedEvent(transcript=text, is_final=True)
        )
        now = time.time()
        info = audio_recognition._EndOfTurnInfo(
            skip_reply=False,
            new_transcript=text,
            transcript_confidence=1.0,
            metrics=audio_recognition._EndOfTurnMetrics(
                started_speaking_at=now - 1.0,
                stopped_speaking_at=now - 0.4,
                transcription_delay=0.1,
                end_of_turn_delay=0.3,
            ),
        )
        self.assertTrue(self.session._activity.on_end_of_turn(info))

    async def test_a_reply_is_flushed_early_spoken_whole_and_timed(self) -> None:
        from tests.test_r1_core import capture_r1_logs

        interview = self.build()
        await self.session.start(self.r1_session.R1Agent(interview))
        with capture_r1_logs() as lines:
            await self.candidate_turn("I sold courses")
            await self.until(lambda: self.out.finished >= 1 and self.bot_rows())
            await interview._drain_background()
        # The first sentence went to the TTS alone, the rest in ONE further call.
        self.assertEqual(self.tts.texts[0], "Okay, that makes sense.")
        self.assertEqual(len(self.tts.texts), 2)
        self.assertEqual("".join(self.tts.texts).strip(), self.REPLY)
        # The audio of both calls reached the output, and the row is the whole reply.
        self.assertTrue(self.out.frames)
        self.assertEqual([row["text"].strip() for row in self.bot_rows()], [self.REPLY])
        # Every stage was stamped once, and R1's TTS stamp agrees with the SDK's own.
        stages = [
            (l["schema"], l["duration_sec"])
            for l in lines
            if l.get("error_type") == "r1_latency"
        ]
        names = [name for name, _ in stages]
        for stage in (
            "eou_to_turn_hook", "eou_to_llm_first_token", "llm_ttft", "eou_to_guard_release",
            "guard_hold", "eou_to_tts_first_frame", "tts_ttfb", "eou_to_first_audio",
            "sdk_tts_first_audio", "sdk_e2e", "sdk_end_of_turn",
        ):
            self.assertEqual(names.count(stage), 1, (stage, names))
        timings = dict(stages)
        self.assertLess(abs(timings["tts_ttfb"] - timings["sdk_tts_first_audio"]), 0.25)
        self.assertLessEqual(timings["eou_to_tts_first_frame"], timings["eou_to_first_audio"])

    async def test_a_barge_in_after_the_first_fragment_leaves_the_pipeline_usable(self) -> None:
        interview = self.build()
        errors: list = []
        self.session.on("error", errors.append)
        await self.session.start(self.r1_session.R1Agent(interview))
        await self.candidate_turn("I sold courses")
        await self.until(lambda: self.tts.texts)  # the first fragment has been synthesised
        await self.session.interrupt(force=True)  # the candidate cuts in
        await asyncio.sleep(0.2)
        before = len(self.tts.texts)
        await self.candidate_turn("As I was saying")
        await self.until(lambda: len(self.tts.texts) > before and self.out.finished >= 1)
        await self.until(lambda: len(self.bot_rows()) >= 2)
        self.assertEqual(errors, [])  # no provider error, no cancelled-generator noise
        self.assertEqual(interview._failures, 0)
        self.assertIsNone(interview._stop_outcome())

    async def test_the_rollback_switch_sends_a_reply_to_the_tts_in_one_call(self) -> None:
        interview = self.build()
        await self.session.start(self.r1_session.R1Agent(interview))
        with mock.patch.dict("os.environ", {"R1_TTS_FLUSH_MIN_CHARS": "0"}):
            await self.candidate_turn("I sold courses")
            await self.until(lambda: self.out.finished >= 1 and self.bot_rows())
        self.assertEqual(len(self.tts.texts), 1)
        self.assertEqual(self.tts.texts[0].strip(), self.REPLY)

    async def test_a_scripted_line_without_a_cache_reaches_the_tts_whole(self) -> None:
        from tests.test_r1_core import capture_r1_logs

        interview = self.build()
        await self.session.start(self.r1_session.R1Agent(interview))
        text = interview.render_line("L-WRAP")
        with capture_r1_logs() as lines:
            await asyncio.wait_for(interview.say("L-WRAP"), 15.0)
            await interview._drain_background()
        self.assertEqual(self.tts.texts, [text])  # one call, not split into two
        self.assertEqual([row["text"] for row in self.bot_rows()], [text])
        said = [l for l in lines if l.get("schema") == "say_to_first_audio"]
        self.assertEqual([l["error_category"] for l in said], ["L-WRAP"])

    async def test_a_cached_scripted_line_plays_without_touching_the_tts(self) -> None:
        from r1_linecache import LineCache, LineSpec, PcmClip, RateLimitCounter
        from tests.test_r1_core import capture_r1_logs
        from tests.test_r1_linecache import FakeSynthesizer

        one_second = PcmClip(b"\x01\x00" * 24000, 24000, 1)
        cache = LineCache(
            FakeSynthesizer(one_second),
            voice={"model": "bulbul:v3"},
            sample_rate=24000,
            counter=RateLimitCounter(),
        )
        interview = self.build(line_cache=cache)
        await self.session.start(self.r1_session.R1Agent(interview))
        text = interview.render_line("L-WRAP")
        await cache.warm([LineSpec("L-WRAP", text, False)])
        with capture_r1_logs() as lines:
            await asyncio.wait_for(interview.say("L-WRAP"), 15.0)
            await interview._drain_background()
        self.assertEqual(self.tts.texts, [])  # the TTS was never asked
        self.assertAlmostEqual(sum(frame.duration for frame in self.out.frames), 1.0, places=2)
        self.assertEqual([row["text"] for row in self.bot_rows()], [text])
        played = [l for l in lines if l.get("error_type") == "r1_line_cache_play"]
        self.assertEqual([l["error_category"] for l in played], ["cached"])
        said = [l for l in lines if l.get("schema") == "say_to_first_audio"]
        self.assertEqual([l["error_category"] for l in said], ["L-WRAP"])

    async def test_the_recorder_taps_a_real_sessions_audio_and_the_candidate_still_hears_everything(
        self,
    ) -> None:
        """R1-REC: wiring the recorder AFTER ``session.start`` (the SDK reassigns ``input.audio`` /
        ``output.audio``) must not change what reaches the candidate, and must capture both sides."""
        import tempfile
        from pathlib import Path

        import numpy as np
        from livekit.agents.voice import io as vio

        import r1_recorder
        from tests.test_r1_recorder import FakeApi, FakeEncoder, StubHttp

        class Mic(vio.AudioInput):
            """The room's microphone stand-in: 20 ms of a 300 Hz tone, in real time."""

            def __init__(self) -> None:
                super().__init__(label="mic")
                t = np.arange(480) / 24000
                self.pcm = (np.sin(2 * np.pi * 300 * t) * 6000).astype("<i2").tobytes()

            async def __anext__(self):
                await asyncio.sleep(0.02)
                return rtc.AudioFrame(
                    data=self.pcm, sample_rate=24000, num_channels=1, samples_per_channel=480
                )

        interview = self.build()
        await self.session.start(self.r1_session.R1Agent(interview))
        original_output = self.session.output.audio
        self.session.input.audio = Mic()
        events: list = []
        with tempfile.TemporaryDirectory(prefix="r1rec-real-", ignore_cleanup_errors=True) as tmp:
            spool = r1_recorder.Spool(Path(tmp) / "r", "00000000-0000-4000-8000-0000000000aa")
            spool.create()
            encoder = FakeEncoder(events, spool.dir)
            recorder = r1_recorder.R1Recorder(
                session=self.session,
                room="screening-00000000-0000-4000-8000-0000000000aa",
                session_id="00000000-0000-4000-8000-0000000000aa",
                mode="audio",
                spool=spool,
                encoder=encoder,
                api=FakeApi(events),
                http_client=StubHttp(),
                finish_seconds=10.0,
            )
            await recorder.start("candidate")
            chain, node = [], self.session.output.audio
            while node is not None:  # the SDK wraps what it is given in its own proxy
                chain.append(type(node).__name__)
                node = getattr(node, "next_in_chain", None)
            self.assertIn("RecorderAudioOutput", chain)  # tapped ...
            self.assertIsNot(self.session.output.audio, original_output)
            self.assertTrue(chain.index("RecorderAudioOutput") < len(chain) - 1)  # ... in line, not at the end
            pump_stop = asyncio.Event()

            async def pump() -> None:  # what the SDK's audio recognition does with the input
                async for _frame in self.session.input.audio:
                    if pump_stop.is_set():
                        return

            pump_task = asyncio.ensure_future(pump())
            await asyncio.sleep(0.3)
            await self.candidate_turn("I sold courses")
            await self.until(lambda: self.out.finished >= 1 and self.bot_rows())
            await interview._drain_background()
            heard = sum(frame.duration for frame in self.out.frames)
            self.assertGreater(heard, 0.05)  # the candidate heard the whole reply through the tap
            self.assertEqual([row["text"].strip() for row in self.bot_rows()], [self.REPLY])
            pump_stop.set()
            await asyncio.sleep(0.1)
            recorder.stop(None)
            pump_task.cancel()
            await asyncio.wait_for(recorder.finish(), 30)
            # Both sides were captured: the agent's line and the candidate's microphone reached the
            # tee as one timeline at least as long as the reply.
            total = sum(len(pcm) // 2 for _pts, pcm in encoder.audio)
            self.assertGreaterEqual(total / 48000, heard - 0.1)
            self.assertEqual(recorder.phase, "done")
            self.assertFalse(spool.dir.exists())


@unittest.skipUnless(
    AgentSession is not None and _sarvam_plugin is not None,
    "livekit-agents with the sarvam plugin is not installed (bare CI)",
)
class TestR1VoicesOnTheRealSdk(unittest.IsolatedAsyncioTestCase):
    """R1's two voices (owner decision 2026-10-30) on the pinned SDK and plugin.

    The voiced TTS reads two private seams: the plugin's per-stream copy of its options and the
    SDK's speech-handle variable.  Both are pinned here, with the order facts that make the
    per-speech binding race-free, so an SDK or plugin bump that moves them fails CI.
    """

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"SARVAM_API_KEY": "test-key-not-real"})
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in (
            "R1_TTS_PROFILE",
            "R1_TTS_INTERVIEWER_VOICE",
            "R1_TTS_LEARNER_VOICE",
            "R1_STT_MODEL",
            "SARVAM_STT_MODEL",
            "SARVAM_TTS_MODEL",
            "SARVAM_TTS_VOICE",
        ):
            os.environ.pop(key, None)

    async def test_default_factory_v4_gives_the_session_one_voiced_tts(self) -> None:
        import livekit.agents as agents
        from livekit.plugins import sarvam

        import r1_llm
        import r1_session
        from tests.test_r1_core import capture_r1_logs

        captured: dict = {}

        class RecordingSession:
            def __init__(self, **kwargs) -> None:
                captured.update(kwargs)

        raw = "learner_typo_value_xyz"
        os.environ["R1_TTS_LEARNER_VOICE"] = raw
        with capture_r1_logs() as lines, mock.patch.object(
            agents, "AgentSession", RecordingSession
        ), mock.patch.object(sarvam, "STT", lambda **kwargs: ("stt", kwargs)), mock.patch.object(
            r1_llm, "build_r1_llm", lambda: "llm"
        ):
            await r1_session._default_session_factory(None, {})
        tts = captured["tts"]
        try:
            self.assertIsInstance(tts, sarvam.TTS)
            self.assertEqual(type(tts).__name__, "R1SarvamTTS")
            self.assertEqual(tts.r1_voice_set.profile, "v4")
            self.assertEqual(tts.model, "bulbul:v4-flash")
            self.assertEqual(tts.r1_voice_set.speaker("learner"), "zarina_en_conversation")
            self.assertEqual(captured["stt"], ("stt", {"model": "saaras:v4", "language": "en-IN"}))
        finally:
            await tts.aclose()
        events = [(line.get("error_type"), line.get("error_category")) for line in lines]
        self.assertIn(("r1_tts_setting_rejected", "learner_voice_rejected"), events)
        self.assertIn(("r1_tts_profile", "v4"), events)
        voices = {
            line["error_category"]: line.get("schema")
            for line in lines
            if line.get("error_type") == "r1_tts_voice"
        }
        self.assertEqual(
            voices, {"interviewer": "simran_en_customer", "learner": "zarina_en_conversation"}
        )
        profile = next(line for line in lines if line.get("error_type") == "r1_tts_profile")
        self.assertEqual(profile.get("model"), "bulbul:v4-flash")
        self.assertIn(("r1_stt_model", None), events)
        self.assertNotIn(raw, json.dumps(lines))  # labels only, never a raw environment value

    async def test_a_v4_build_failure_gives_the_session_todays_voice_and_says_so(self) -> None:
        import livekit.agents as agents
        from livekit.plugins import sarvam

        import r1_llm
        import r1_sarvam
        import r1_session
        from tests.test_r1_core import capture_r1_logs

        captured: dict = {}

        class RecordingSession:
            def __init__(self, **kwargs) -> None:
                captured.update(kwargs)

        def broken(_voice_set):
            raise ValueError("cannot build")

        with capture_r1_logs() as lines, mock.patch.object(
            agents, "AgentSession", RecordingSession
        ), mock.patch.object(sarvam, "STT", lambda **_kwargs: "stt"), mock.patch.object(
            r1_llm, "build_r1_llm", lambda: "llm"
        ), mock.patch.object(r1_sarvam, "_voiced_tts_class", lambda: broken):
            await r1_session._default_session_factory(None, {})
        tts = captured["tts"]
        self.assertIs(type(tts), sarvam.TTS)
        self.assertEqual(tts._opts.speaker, "simran")
        self.assertEqual(tts.model, "bulbul:v3")
        events = [(line.get("error_type"), line.get("error_category")) for line in lines]
        self.assertIn(("r1_tts_profile_fallback", "ValueError"), events)
        self.assertIn(("r1_tts_profile", "v3"), events)  # what the session really speaks
        await tts.aclose()

    def test_the_seams_the_voiced_tts_reads_are_pinned(self) -> None:
        import re

        from livekit.agents import tts as agents_tts
        from livekit.agents.voice import generation
        from livekit.plugins.sarvam import tts as plugin_tts

        # Each stream copies the options, so setting its speaker never touches the instance.
        self.assertIn(
            "self._opts = replace(tts._opts)",
            inspect.getsource(plugin_tts.SynthesizeStream.__init__),
        )
        # The stream's main task is created in the base __init__, and cannot run before the
        # synchronous speaker assignment that follows ``super().stream()``.
        self.assertIn(
            "asyncio.create_task(", inspect.getsource(agents_tts.SynthesizeStream.__init__)
        )
        # Every segment sends the stream's speaker in its config, a pooled socket included.
        run_ws = inspect.getsource(plugin_tts.SynthesizeStream._run_ws)
        self.assertIn('"speaker": self._opts.speaker', run_ws)
        self.assertIn('"model": self._opts.model', run_ws)
        # Temperature is sent for the v3 names only (v4 ignores it, and R1 never sets it).
        gate = 'if self._opts.model in ("bulbul:v3", "bulbul:v3-beta"):'
        self.assertEqual(run_ws.count('data["temperature"]'), 1)
        self.assertLess(run_ws.index(gate), run_ws.index('data["temperature"]'))
        # stream() takes only conn_options (the subclass's override matches it).
        parameters = inspect.signature(plugin_tts.TTS.stream).parameters
        self.assertEqual(list(parameters), ["self", "conn_options"])
        self.assertIs(parameters["conn_options"].kind, inspect.Parameter.KEYWORD_ONLY)
        # bulbul:v4-flash is unknown to the plugin: no compatibility check (R1 allowlists).
        self.assertNotIn("bulbul:v4-flash", plugin_tts.MODEL_SPEAKER_COMPATIBILITY)
        # One pool per instance, keyed on the model: both voices must share the model.
        self.assertIn("?model={self._opts.model}", inspect.getsource(plugin_tts.TTS._connect_ws))
        init = inspect.signature(plugin_tts.TTS.__init__).parameters
        self.assertEqual(init["target_language_code"].default, "en-IN")
        self.assertEqual(init["speech_sample_rate"].default, 22050)
        # The SDK sets the speech handle for every speech task, and runs a say line's TTS only
        # after the speech is authorised (the voice is stored right after say() returns).
        self.assertIn(
            "_SpeechHandleContextVar.set(speech_handle)",
            inspect.getsource(AgentActivity._create_speech_task),
        )
        impl = inspect.getsource(AgentActivity._tts_task_impl)
        self.assertLess(
            impl.index("speech_handle._wait_for_authorization()"),
            impl.index("perform_tts_inference("),
        )
        # The node is called synchronously inside the TTS inference task: the binding R1 makes
        # at its top is that task's own.
        source = inspect.getsource(generation._tts_inference_task)
        self.assertRegex(source, re.escape("tts_node = node(input_tee[1], model_settings)"))
        self.assertIn(
            "asyncio.create_task(", inspect.getsource(generation.perform_tts_inference)
        )

    async def test_the_speech_voice_reaches_the_tts_node_inside_the_sdks_inference(self) -> None:
        from livekit.agents.voice.agent import ModelSettings
        from livekit.agents.voice.agent_activity import _SpeechHandleContextVar
        from livekit.agents.voice.generation import perform_tts_inference

        import r1_session
        import r1_tts
        from tests.test_r1_core import FakeContext, FakeSession, FakeWriter

        order: list = []
        interview = r1_session.R1Interview(
            FakeContext(order),
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=order),
            FakeWriter(order),
        )
        agent = r1_session.R1Agent(interview)
        learner, christy = SpeechHandle.create(), SpeechHandle.create()
        interview._voices[str(learner.id)] = "learner"
        interview._voices[str(christy.id)] = "interviewer"
        heard: dict[str, list] = {"learner": [], "interviewer": []}
        gate = asyncio.Event()

        def inner(_self, text, model_settings):
            async def frames():
                voice = r1_tts.current_voice()
                body = "".join([chunk async for chunk in text])
                heard[voice or "unbound"].append(body)
                yield rtc.AudioFrame(b"\x01\x00" * 441, 22050, 1, 441)

            return frames()

        async def text(chunks):
            for chunk in chunks:
                await gate.wait()  # both speeches are in flight before any text arrives
                await asyncio.sleep(0.003)
                yield chunk

        async def speech(handle, chunks) -> int:
            _SpeechHandleContextVar.set(handle)  # what _create_speech_task does
            task, data = perform_tts_inference(
                node=agent.tts_node, input=text(chunks), model_settings=ModelSettings(),
                text_transforms=None,
            )
            frames = [frame async for frame in data.audio_ch]
            self.assertTrue(await task)
            return len(frames)

        with mock.patch.object(Agent, "tts_node", inner):
            first = asyncio.create_task(
                speech(learner, ("Hmm, okay then. ", "Nine thousand feels a lot. ", "Why?"))
            )
            second = asyncio.create_task(
                speech(christy, ("Thank you, Asha. ", "Let us pause the role-play here."))
            )
            await asyncio.sleep(0.01)
            gate.set()
            self.assertEqual(await asyncio.gather(first, second), [2, 2])
        # Both of each speech's downstream calls (the early flush) in its own voice, never mixed.
        self.assertEqual(
            heard["learner"], ["Hmm, okay then.", " Nine thousand feels a lot. Why?"]
        )
        self.assertEqual(
            heard["interviewer"], ["Thank you, Asha.", " Let us pause the role-play here."]
        )
        self.assertNotIn("unbound", heard)

# ------------------------------------------------------------------------------------------------
# Owner decision 2026-10-30 (owner test 1eb18cd4, turns 33-41): an acknowledgement no longer cuts
# the learner.  R1 holds it back in ``R1Agent.stt_node``; these pin why that is enough on 1.6.4,
# and drive the REAL ``AgentActivity`` methods with stubs around them to prove it.
# ------------------------------------------------------------------------------------------------
class _PocAudio:
    can_pause = True

    def __init__(self) -> None:
        self.calls: list[str] = []

    def pause(self) -> None:
        self.calls.append("pause")

    def resume(self) -> None:
        self.calls.append("resume")


class _PocSession:
    """The AgentSession surface the interruption methods touch."""

    def __init__(self, min_words: int, timeout: float) -> None:
        from types import SimpleNamespace

        self._aec_warmup_remaining = 0
        self._aec_warmup_timer = None
        self.options = SimpleNamespace(
            interruption={
                "min_words": min_words,
                "min_duration": 0.8,
                "resume_false_interruption": True,
                "false_interruption_timeout": timeout,
            },
            endpointing={"min_delay": 0.8, "max_delay": 3.0},
        )
        self.output = SimpleNamespace(audio=_PocAudio())
        self.agent_state = "speaking"
        self.llm = object()
        self.stt = object()
        self._user_speaking_span = None
        self._loop = asyncio.get_running_loop()
        self._amd = None
        self._closing = False
        self._text_only = False
        self.transcribed: list[str] = []
        self.events: list[str] = []

    def _update_agent_state(self, state, otel_context=None) -> None:  # noqa: ANN001
        self.agent_state = state

    def _update_user_state(self, state, last_speaking_time=None) -> None:  # noqa: ANN001
        pass

    def _user_input_transcribed(self, ev) -> None:  # noqa: ANN001
        self.transcribed.append(ev.transcript)

    def emit(self, name, ev) -> None:  # noqa: ANN001
        self.events.append(name)


class _PocRecognition:
    def __init__(self) -> None:
        from types import SimpleNamespace

        self.current_transcript = ""
        self._endpointing = SimpleNamespace(overlapping=False)
        self.backchannel_boundary_active = False

    def _cancel_backchannel_boundary(self) -> None:
        pass

    def on_start_of_speech(self, **_kw) -> None:
        pass

    def on_end_of_speech(self, **_kw) -> None:
        pass

    def on_end_of_agent_speech(self, **_kw) -> None:
        pass

    def on_start_of_agent_speech(self, **_kw) -> None:
        pass


@unittest.skipUnless(AgentSession is not None, "livekit-agents is not installed (bare CI)")
class TestR1AckHoldOnTheRealSdk(unittest.IsolatedAsyncioTestCase):
    """What a final transcript does to the learner's line, and what holding it back does."""

    def setUp(self) -> None:
        import r1_session

        writer = r1_session._log._writer
        r1_session._log._writer = lambda _raw: None  # the r1_ack_held lines
        self.addCleanup(setattr, r1_session._log, "_writer", writer)

    def test_a_final_pauses_then_cancels_the_pause_which_interrupts(self) -> None:
        final = inspect.getsource(AgentActivity.on_final_transcript)
        self.assertLess(
            final.index("self._interrupt_by_audio_activity()"),
            final.index("self._cancel_speech_pause(old_task=self._cancel_speech_pause_task)"),
        )
        self.assertIn("self._session._user_input_transcribed(", final)
        barge = inspect.getsource(AgentActivity._interrupt_by_audio_activity)
        self.assertIn("text = self._audio_recognition.current_transcript", barge)
        self.assertIn('< interruption_options["min_words"]', barge)

    def test_no_transcript_means_no_turn(self) -> None:
        eou = inspect.getsource(AudioRecognition._run_eou_detection)
        self.assertIn(
            "if self._stt and not self._audio_transcript and self._turn_detection_mode", eou
        )
        stt_event = inspect.getsource(AudioRecognition._on_stt_event)
        self.assertLess(
            stt_event.index("self._hooks.on_final_transcript("),
            stt_event.index("self._audio_transcript +="),
        )

    def test_the_symbols_the_hold_and_the_fast_resume_use(self) -> None:
        from livekit.agents import stt

        import r1_session

        self.assertTrue(inspect.isasyncgenfunction(Agent.default.stt_node))
        self.assertEqual(
            list(inspect.signature(Agent.default.stt_node).parameters),
            ["agent", "audio", "model_settings"],
        )
        self.assertEqual(
            list(inspect.signature(Agent.stt_node).parameters), ["self", "audio", "model_settings"]
        )
        # A custom stt_node only stops the pipeline reuse across a handoff (R1 has none).
        self.assertIn(
            "type(self.agent).stt_node is Agent.stt_node", inspect.getsource(AgentActivity)
        )
        self.assertIn("self._activity: AgentActivity | None = None", inspect.getsource(
            AgentSession.__init__
        ))
        init = inspect.getsource(AgentActivity.__init__)
        self.assertIn("self._paused_speech: _PausedSpeechInfo | None = None", init)
        self.assertIn("self._false_interruption_timer: asyncio.TimerHandle | None = None", init)
        self.assertEqual(
            list(inspect.signature(AgentActivity._start_false_interruption_timer).parameters),
            ["self", "timeout"],
        )
        self.assertTrue(callable(getattr(asyncio.TimerHandle, "when", None)))
        self.assertIn("handle", inspect.getsource(AgentActivity._update_paused_speech))
        self.assertTrue(
            r1_session._HELD_STT_EVENTS
            <= {member.value for member in stt.SpeechEventType}
        )
        self.assertIn("agent_false_interruption", typing.get_args(EventTypes))
        self.assertIn(
            "agent_false_interruption", inspect.getsource(r1_session.R1Interview.wire_events)
        )

    def test_r1_agent_overrides_the_stt_node(self) -> None:
        import r1_session

        self.assertIsNot(r1_session.R1Agent.stt_node, Agent.stt_node)
        self.assertTrue(inspect.iscoroutinefunction(r1_session.R1Agent.on_user_turn_completed))

    # -------------------------------------------------------------- the real methods, driven
    def activity(self, min_words: int, timeout: float = 0.3):
        from livekit.agents.types import NOT_GIVEN
        from types import SimpleNamespace

        act = AgentActivity.__new__(AgentActivity)
        act._session = _PocSession(min_words, timeout)
        act._agent = SimpleNamespace(llm=NOT_GIVEN, stt=NOT_GIVEN)
        act._interruption_by_audio_activity_enabled = True
        act._default_interruption_by_audio_activity_enabled = True
        act._interruption_detection_enabled = False
        act._interruption_detected = False
        act._audio_recognition = _PocRecognition()
        act._rt_session = None
        act._turn_detection = None
        act._paused_speech = None
        act._false_interruption_timer = None
        act._cancel_speech_pause_task = None
        act._user_silence_event = asyncio.Event()
        act._stt_eos_received = False
        handle = SpeechHandle.create(allow_interruptions=True)
        act._current_speech = handle
        return act, handle

    def interview(self, act, handle):
        """A real R1Interview in the role-play whose session's current speech is ``handle``."""
        from types import SimpleNamespace

        import r1_session
        from r1_phases import R1Phase

        session = SimpleNamespace(current_speech=handle, _activity=act)
        interview = r1_session.R1Interview(
            SimpleNamespace(room=None), {}, session, SimpleNamespace(), clock=lambda: 0.0
        )
        for phase in (R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION, R1Phase.ROLEPLAY):
            interview.machine.transition(phase)
        return interview

    @staticmethod
    def final(text: str):
        from livekit.agents import stt

        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(language="en", text=text)],
        )

    @staticmethod
    def vad(duration: float, *, speaking: bool = True):
        from types import SimpleNamespace

        return SimpleNamespace(
            speech_duration=duration,
            raw_accumulated_silence=0.0,
            speaking=speaking,
            silence_duration=0.0,
            inference_duration=0.0,
        )

    def feed(self, interview, act, text: str) -> bool:
        """What ``R1Agent.stt_node`` does with a final: hold it, or pass it to the SDK."""
        event = self.final(text)
        held = interview.hold_ack_transcript(event)
        if not held:
            act.on_final_transcript(event)
        return held

    async def test_today_a_transcribed_okay_cuts_the_learner(self) -> None:
        act, handle = self.activity(0)
        act.on_final_transcript(self.final("Okay"))
        await asyncio.sleep(0.05)
        self.assertEqual(act._session.output.audio.calls[0], "pause")
        self.assertTrue(handle.interrupted)

    async def test_a_held_short_okay_never_pauses_her(self) -> None:
        # A plain "Okay" of about 0.3 s of voice: with the VAD's trailing silence its
        # speech_duration still stays under min_duration (see the test just below).
        act, handle = self.activity(0)
        interview = self.interview(act, handle)
        act.on_vad_inference_done(self.vad(0.4))
        self.assertTrue(self.feed(interview, act, "Okay"))
        await asyncio.sleep(0.4)
        self.assertEqual(act._session.output.audio.calls, [])
        self.assertFalse(handle.interrupted)
        self.assertEqual(act._session.transcribed, [])  # the SDK never saw it

    async def test_the_vad_counts_trailing_silence_so_a_medium_ack_reaches_min_duration(
        self,
    ) -> None:
        # Reviewed 2026-10-30: the default VAD (inference.VAD "silero", what R1 uses) keeps adding
        # to speech_duration through its 0.25 s min_silence_duration of trailing silence, so about
        # 0.55 s of voice ("Yeah, okay") reports 0.8 s and pauses her (the module docstring of
        # r1_session and the R1_ACK_HOLD runbook row say so).  The real state machine, driven by a
        # fake native model: 17 windows of 32 ms of voice (0.544 s), then silence.
        try:
            from livekit import rtc
            from livekit.agents import vad as base_vad
            from livekit.agents.inference import vad as inference_vad
        except ImportError as exc:  # pragma: no cover - no native VAD on this machine
            self.skipTest(f"inference VAD unavailable: {exc}")

        class Native:
            calls = 0

            def reset(self) -> None:
                pass

            def predict(self, _window) -> float:
                Native.calls += 1
                return 1.0 if Native.calls <= 17 else 0.0

        self.assertEqual(
            inspect.signature(inference_vad.VAD).parameters["min_silence_duration"].default, 0.25
        )
        with mock.patch.object(inference_vad, "_NativeVAD", Native):
            stream = inference_vad.VAD(model="silero").stream()
            for _ in range(40):
                stream.push_frame(rtc.AudioFrame(
                    data=bytes(512 * 2), sample_rate=16000, num_channels=1,
                    samples_per_channel=512,
                ))
            stream.end_input()
            reported, spoken = 0.0, None
            async for event in stream:
                if event.type == base_vad.VADEventType.INFERENCE_DONE:
                    reported = max(reported, event.speech_duration)
                elif event.type == base_vad.VADEventType.END_OF_SPEECH:
                    spoken = event.speech_duration
        self.assertAlmostEqual(spoken, 0.544, places=3)
        self.assertGreaterEqual(reported, 0.8 - 1e-6)  # the SDK's min_duration: she pauses
        # Paused, the held final still only brings the same line back (never a cut or restart).
        act, handle = self.activity(0, timeout=2.0)
        interview = self.interview(act, handle)
        act.on_vad_inference_done(self.vad(reported))
        act.on_end_of_speech(self.vad(0.0, speaking=False))
        with mock.patch.dict("os.environ", {"R1_ACK_RESUME_SEC": "0.1"}):
            self.assertTrue(self.feed(interview, act, "Yeah, okay"))
        await asyncio.sleep(0.3)
        self.assertEqual(act._session.output.audio.calls, ["pause", "resume"])
        self.assertFalse(handle.interrupted)

    async def test_a_held_long_ack_pauses_her_and_the_sdk_resumes_the_same_line(self) -> None:
        act, handle = self.activity(0, timeout=0.3)
        interview = self.interview(act, handle)
        with mock.patch.dict("os.environ", {"R1_ACK_RESUME_SEC": "0"}):
            act.on_vad_inference_done(self.vad(0.9))  # paused at 0.8 s of voice
            self.assertEqual(act._session.agent_state, "listening")
            act.on_end_of_speech(self.vad(0.0, speaking=False))
            self.assertTrue(self.feed(interview, act, "Yeah, okay, continue."))
            await asyncio.sleep(0.45)
        self.assertEqual(act._session.output.audio.calls, ["pause", "resume"])
        self.assertFalse(handle.interrupted)
        self.assertEqual(act._session.agent_state, "speaking")
        self.assertIn("agent_false_interruption", act._session.events)

    async def test_the_fast_resume_shortens_the_sdks_countdown(self) -> None:
        act, handle = self.activity(0, timeout=2.0)
        interview = self.interview(act, handle)
        act.on_vad_inference_done(self.vad(0.9))
        act.on_end_of_speech(self.vad(0.0, speaking=False))
        self.assertIsNotNone(act._false_interruption_timer)
        with mock.patch.dict("os.environ", {"R1_ACK_RESUME_SEC": "0.1"}):
            self.assertTrue(self.feed(interview, act, "Okay, continue."))
        await asyncio.sleep(0.3)  # far less than the SDK's 2.0 s
        self.assertEqual(act._session.output.audio.calls, ["pause", "resume"])
        self.assertFalse(handle.interrupted)

    async def test_a_real_interruption_still_cuts_her(self) -> None:
        act, handle = self.activity(0)
        interview = self.interview(act, handle)
        act.on_vad_inference_done(self.vad(0.9))
        act.on_end_of_speech(self.vad(0.0, speaking=False))
        for text in ("Hey, what is your name?",):
            self.assertFalse(self.feed(interview, act, text))
        await asyncio.sleep(0.05)
        self.assertTrue(handle.interrupted)

    async def test_at_three_words_two_acks_add_up_to_a_turn_today(self) -> None:
        from types import SimpleNamespace

        act, handle = self.activity(3)
        recognition = act._audio_recognition
        act.on_final_transcript(self.final("Okay"))  # the SDK checks the words it HOLDS: 0
        recognition.current_transcript = "Okay"
        act.on_final_transcript(self.final("Yeah, Okay"))  # 1 held word: still no pause
        await asyncio.sleep(0.05)
        self.assertFalse(handle.interrupted)
        recognition.current_transcript = "Okay Yeah, Okay"
        committed = []

        def create_speech_task(coro, name=None):  # noqa: ANN001
            coro.close()
            committed.append(name)

        act._create_speech_task = create_speech_task
        act._scheduling_paused = False
        act._new_turns_blocked = False
        act._preemptive_generation = None
        act._user_turn_completed_atask = None
        self.assertTrue(
            act.on_end_of_turn(SimpleNamespace(new_transcript="Okay Yeah, Okay", skip_reply=False))
        )
        # The committed turn interrupts the line and the hook plans a restart.
        self.assertEqual(committed, ["AgentActivity._user_turn_completed_task"])

    async def test_at_three_words_held_acks_never_reach_the_sdk(self) -> None:
        act, handle = self.activity(3)
        interview = self.interview(act, handle)
        with mock.patch.dict("os.environ", {"R1_INTERRUPT_MIN_WORDS": "3"}):
            held = [self.feed(interview, act, text) for text in ("Okay", "Yeah, Okay", "Hmm")]
        act.on_vad_inference_done(self.vad(1.2))  # nothing banked: the voice path refuses too
        await asyncio.sleep(0.05)
        self.assertEqual(held, [True, True, True])
        self.assertEqual(act._session.transcribed, [])
        self.assertEqual(act._session.output.audio.calls, [])
        self.assertFalse(handle.interrupted)
