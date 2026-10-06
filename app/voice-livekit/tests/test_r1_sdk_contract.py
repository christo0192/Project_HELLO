"""Pinned LiveKit 1.6.4 contract for every SDK symbol used by the R1 worker.

Run this suite with the worktree's ``.r1-venv``.  Bare CI intentionally skips
it because production SDK behaviour must not be approximated by these tests.
"""
from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    from livekit import rtc
    from livekit.agents import APIConnectOptions, Agent, AgentSession, JobContext, StopResponse
    from livekit.agents.voice.agent_session import SessionConnectOptions
    from livekit.agents.voice.events import ErrorEvent
    from livekit.agents.voice.room_io import RoomOptions
except ImportError:
    rtc = None
    APIConnectOptions = Agent = AgentSession = ErrorEvent = JobContext = None
    SessionConnectOptions = StopResponse = RoomOptions = None


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

    def test_agent_and_job_context_hooks_exist(self) -> None:
        self.assertTrue(issubclass(StopResponse, Exception))
        for hook in ("on_enter", "on_user_turn_completed", "llm_node"):
            self.assertTrue(callable(getattr(Agent, hook)))
        callback_parameters = inspect.signature(JobContext.add_shutdown_callback).parameters
        self.assertIn("callback", callback_parameters)

    def test_room_event_signatures_and_track_muted_shape_are_pinned(self) -> None:
        room_source = inspect.getsource(rtc.Room)
        for event_name in (
            "participant_connected",
            "participant_disconnected",
            "track_muted",
            "track_unmuted",
        ):
            self.assertIn(event_name, room_source)
        self.assertIn("participant, publication", room_source)
        self.assertTrue(callable(getattr(rtc.Room, "on")))

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

    def test_room_metadata_and_local_attributes_contracts_exist(self) -> None:
        """Pin the room metadata property and lower-level participant attributes API."""
        self.assertIsInstance(inspect.getattr_static(rtc.Room, "metadata"), property)
        self.assertTrue(callable(getattr(rtc.LocalParticipant, "set_attributes")))
        attributes = inspect.signature(rtc.LocalParticipant.set_attributes).parameters
        self.assertIn("attributes", attributes)
