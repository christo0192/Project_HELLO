"""Pinned LiveKit 1.6.4 contract for every SDK symbol used by the R1 worker.

Run this suite with the worktree's ``.r1-venv``.  The bare-python CI step skips it (the
SDK is not installed there) because production SDK behaviour must not be approximated by
these tests; the isolated ``Test R1 SDK contract`` step in ``quality.yml`` installs
``livekit-agents==1.6.4`` and ``livekit==1.1.12`` in a venv, runs it, and fails if any
test was skipped.
"""
from __future__ import annotations

import asyncio
import inspect
import sys
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
    from livekit.agents.ipc import job_proc_lazy_main
    from livekit.agents.llm.llm import LLMError
    from livekit.agents.voice.agent_activity import AgentActivity
    from livekit.agents.voice.agent_session import SessionConnectOptions
    from livekit.agents.voice.events import (
        AgentStateChangedEvent,
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
    ChatContext = AgentStateChangedEvent = ConversationItemAddedEvent = None
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
        ):
            self.assertIn(event_name, room_source)
        self.assertIn("participant, publication", room_source)
        # track_published/unpublished pass (publication, participant): the reverse order.
        self.assertIn('self.emit("track_published", rpublication, rparticipant)', room_source)
        self.assertIn('self.emit("track_unpublished", rpublication, rparticipant)', room_source)
        self.assertTrue(callable(getattr(rtc.Room, "on")))
        self.assertTrue(callable(getattr(rtc.Room, "isconnected")))

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

        class RecordingSession:
            def __init__(self, **kwargs) -> None:
                captured.update(kwargs)

        def recording_tts(**kwargs):
            tts_kwargs.update(kwargs)
            return "tts"

        with mock.patch.object(agents, "AgentSession", RecordingSession), mock.patch.object(
            sarvam, "STT", lambda **_kwargs: "stt"
        ), mock.patch.object(sarvam, "TTS", recording_tts), mock.patch.object(
            r1_llm, "build_r1_llm", lambda: "llm"
        ):
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
        interview.prepare_turn.side_effect = StopResponse()
        agent = r1_session.R1Agent(interview)
        with self.assertRaises(StopResponse):
            await agent.on_user_turn_completed(
                mock.Mock(), mock.Mock(text_content="ready", id="msg_1")
            )
        interview.prepare_turn.assert_called_once_with("ready", "msg_1")
        interview.prepare_turn.side_effect = None
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
        self.assertEqual(options.endpointing["min_delay"], 0.7)
        self.assertEqual(options.endpointing["max_delay"], 3.5)
        self.assertEqual(options.interruption["min_duration"], 0.7)
        self.assertEqual(options.interruption["min_words"], 2)
        self.assertFalse(options.preemptive_generation["enabled"])

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
