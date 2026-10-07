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

        import r1_llm
        import r1_session

        captured: dict = {}

        class RecordingSession:
            def __init__(self, **kwargs) -> None:
                captured.update(kwargs)

        with mock.patch.object(agents, "AgentSession", RecordingSession), mock.patch.object(
            sarvam, "STT", lambda **_kwargs: "stt"
        ), mock.patch.object(sarvam, "TTS", lambda **_kwargs: "tts"), mock.patch.object(
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
        # Browser parity: no VAD and no turn handling override.
        self.assertNotIn("vad", captured)
        self.assertNotIn("turn_handling", captured)

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
