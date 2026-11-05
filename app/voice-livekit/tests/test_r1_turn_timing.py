"""R1 turn timing data (migration 0136): voice, end times, played time and the playback log line.

Nothing here changes how a recording is made or what the phone lane does.  The real SDK facts these
rest on (the back-dated end of speech, the playback events) are pinned in ``test_r1_sdk_contract``.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import persistence
import r1_persistence
import r1_session
import r1_tts
from r1_latency import PlaybackMeter
from r1_persistence import R1TurnWriter
from tests.test_r1_core import (
    ROOM_NAME,
    SESSION_ID,
    Emitter,
    FakeChatMessage,
    FakeSpeechHandle,
    R1TestCase,
    capture_r1_logs,
    error_types,
)

T0 = 1_760_000_000.0  # a plausible wall-clock second
T0_MS = 1_760_000_000_000
NEW_COLUMNS = ("turn_ended_at_ms", "ai_voice", "ai_played_ms")


class RecordingTable:
    """The Supabase table seam: records every row, and fails the writes it is told to."""

    def __init__(self, *, fail_with_columns: tuple[str, ...] = (), error: object = None) -> None:
        self.rows: list[dict] = []
        self.attempts: list[dict] = []
        self.fail_with_columns = fail_with_columns
        self.error = error

    def insert(self, row: dict) -> SimpleNamespace:
        def execute() -> SimpleNamespace:
            self.attempts.append(dict(row))
            if any(column in row for column in self.fail_with_columns):
                if self.error is not None:
                    return SimpleNamespace(error=self.error)
                raise RuntimeError("PGRST204 column not found")
            self.rows.append(dict(row))
            return SimpleNamespace(error=None)

        return SimpleNamespace(execute=execute)


class TestPlaybackMeter(unittest.TestCase):
    """The silence inside one playback: finish, less the first frame, less the audio played."""

    def test_silence_is_the_wall_time_the_audio_does_not_account_for(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0 + 1.0)
        playback = meter.finished(2.0, interrupted=False, now=T0 + 5.5)
        self.assertAlmostEqual(playback.silence_seconds, 2.5)
        self.assertEqual(playback.played_seconds, 2.0)
        self.assertEqual(playback.finished_at, T0 + 5.5)
        self.assertFalse(playback.interrupted)

    def test_a_line_that_played_straight_through_has_no_silence_and_never_a_negative_one(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        self.assertEqual(meter.finished(3.0, interrupted=False, now=T0 + 2.9).silence_seconds, 0.0)

    def test_the_room_reports_again_after_a_resume_which_is_no_new_start(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.started(T0 + 4.0)
        meter.started(T0 + 6.0)
        playback = meter.finished(1.0, interrupted=False, now=T0 + 7.0)
        self.assertEqual(playback.resumes, 2)
        self.assertAlmostEqual(playback.silence_seconds, 6.0)

    def test_a_playback_cut_before_its_first_frame_is_nothing_anybody_heard(self) -> None:
        self.assertIsNone(PlaybackMeter().finished(0.0, interrupted=True, now=T0))

    def test_each_playback_starts_from_nothing(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.started(T0 + 1.0)
        meter.finished(1.0, interrupted=False, now=T0 + 2.0)
        self.assertIsNone(meter.finished(0.0, interrupted=True, now=T0 + 3.0))
        meter.started(T0 + 10.0)
        playback = meter.finished(1.0, interrupted=False, now=T0 + 11.0)
        self.assertEqual(playback.resumes, 0)
        self.assertEqual(playback.silence_seconds, 0.0)

    def test_a_line_paused_and_then_cut_stopped_at_the_pause_not_at_the_report(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.paused(T0 + 0.5)
        playback = meter.finished(0.75, interrupted=True, now=T0 + 3.0)
        self.assertEqual(playback.finished_at, T0 + 0.5)
        self.assertEqual(playback.paused_seconds, 2.5)
        self.assertEqual(playback.silence_seconds, 0.0)
        self.assertEqual(playback.played_seconds, 0.75)
        self.assertEqual(playback.resumes, 0)

    def test_a_pause_that_came_back_is_counted_and_moves_no_end(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.paused(T0 + 1.0)
        meter.resumed(T0 + 3.0)
        meter.started(T0 + 3.0)
        playback = meter.finished(3.0, interrupted=False, now=T0 + 6.5)
        self.assertEqual(playback.finished_at, T0 + 6.5)
        self.assertEqual(playback.paused_seconds, 2.0)
        self.assertAlmostEqual(playback.silence_seconds, 1.5)
        self.assertEqual(playback.resumes, 1)

    def test_a_line_cut_after_it_came_back_was_playing_until_the_cut(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.paused(T0 + 1.0)
        meter.resumed(T0 + 2.0)
        playback = meter.finished(2.0, interrupted=True, now=T0 + 4.0)
        self.assertEqual(playback.finished_at, T0 + 4.0)
        self.assertEqual(playback.paused_seconds, 1.0)
        self.assertAlmostEqual(playback.silence_seconds, 1.0)

    def test_pauses_add_up_and_a_repeated_report_keeps_the_moment_the_audio_stopped(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.paused(T0 + 1.0)
        meter.paused(T0 + 1.5)
        meter.resumed(T0 + 2.0)
        meter.paused(T0 + 3.0)
        playback = meter.finished(1.0, interrupted=True, now=T0 + 5.0)
        self.assertEqual(playback.finished_at, T0 + 3.0)
        self.assertEqual(playback.paused_seconds, 3.0)
        self.assertAlmostEqual(playback.silence_seconds, 1.0)

    def test_a_line_that_ran_out_while_paused_ended_when_it_ran_out(self) -> None:
        """Nothing was left to hold back: the queued tail played, and the room reports no cut."""
        meter = PlaybackMeter()
        meter.started(T0)
        meter.paused(T0 + 1.0)
        playback = meter.finished(1.2, interrupted=False, now=T0 + 1.2)
        self.assertEqual(playback.finished_at, T0 + 1.2)
        self.assertAlmostEqual(playback.paused_seconds, 0.2)

    def test_a_pause_with_no_playback_open_belongs_to_nothing(self) -> None:
        """The agent goes back to listening after every line: that is no pause of the next one."""
        meter = PlaybackMeter()
        meter.paused(T0)
        meter.started(T0 + 2.0)
        playback = meter.finished(1.0, interrupted=True, now=T0 + 3.0)
        self.assertEqual(playback.finished_at, T0 + 3.0)
        self.assertEqual(playback.paused_seconds, 0.0)

    def test_a_pause_never_reaches_the_next_playback(self) -> None:
        meter = PlaybackMeter()
        meter.started(T0)
        meter.paused(T0 + 1.0)
        meter.finished(1.0, interrupted=True, now=T0 + 2.0)
        meter.started(T0 + 10.0)
        playback = meter.finished(1.0, interrupted=True, now=T0 + 11.0)
        self.assertEqual(playback.finished_at, T0 + 11.0)
        self.assertEqual(playback.paused_seconds, 0.0)

    def test_an_unusable_report_is_read_as_no_report(self) -> None:
        for bad in (None, "soon", True, float("nan"), float("inf")):
            with self.subTest(created_at=bad):
                meter = PlaybackMeter()
                meter.started(bad)
                self.assertIsNone(meter.finished(1.0, interrupted=False, now=T0))
        for bad in (None, "soon", True, float("nan"), -1.0):
            with self.subTest(position=bad):
                meter = PlaybackMeter()
                meter.started(T0)
                self.assertEqual(meter.finished(bad, interrupted=True, now=T0 + 1.0).played_seconds, 0.0)


class TestTurnWriterColumns(unittest.IsolatedAsyncioTestCase):
    """``R1TurnWriter`` is the only writer of the 0136 columns, and never at the row's expense."""

    async def write(self, table: RecordingTable, *args, **kwargs) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        with mock.patch.object(persistence, "_table", lambda _name: table):
            await writer.save_turn(*args, **kwargs)

    async def test_a_bot_turn_stores_its_voice_end_and_played_time(self) -> None:
        table = RecordingTable()
        await self.write(
            table, 4, "bot", "hello", "roleplay",
            started_at_ms=T0_MS, ended_at_ms=T0_MS + 2_500, voice="learner", played_ms=2_300,
        )
        self.assertEqual(
            table.rows,
            [{
                "session_id": SESSION_ID, "turn_index": 4, "speaker": "bot", "text": "hello",
                "phase": "roleplay", "interrupted": False, "turn_started_at_ms": T0_MS,
                "turn_ended_at_ms": T0_MS + 2_500, "ai_voice": "learner", "ai_played_ms": 2_300,
            }],
        )

    async def test_a_candidate_turn_stores_its_end_and_never_an_ai_fact(self) -> None:
        table = RecordingTable()
        await self.write(
            table, 5, "candidate", "yes", "roleplay",
            started_at_ms=T0_MS, ended_at_ms=T0_MS + 900, voice="learner", played_ms=900,
        )
        self.assertEqual(table.rows[0]["turn_ended_at_ms"], T0_MS + 900)
        self.assertNotIn("ai_voice", table.rows[0])
        self.assertNotIn("ai_played_ms", table.rows[0])

    async def test_a_turn_with_none_of_them_inserts_exactly_the_old_row(self) -> None:
        table = RecordingTable()
        await self.write(table, 2, "candidate", " hi ", "icebreaker", interrupted=True)
        self.assertEqual(
            table.rows,
            [{"session_id": SESSION_ID, "turn_index": 2, "speaker": "candidate", "text": "hi",
              "phase": "icebreaker", "interrupted": True}],
        )

    async def test_a_value_outside_the_columns_check_is_dropped_never_risked(self) -> None:
        cases = [
            {"ended_at_ms": 0}, {"ended_at_ms": -5}, {"ended_at_ms": 4_102_444_800_000},
            {"ended_at_ms": True}, {"ended_at_ms": 1.76e12}, {"ended_at_ms": "1760000000123"},
            {"ended_at_ms": T0_MS - 1},  # before its own start
            {"voice": "christy"}, {"voice": ""}, {"voice": 1},
            {"played_ms": -1}, {"played_ms": True}, {"played_ms": 1.5}, {"played_ms": 86_400_001},
        ]
        for case in cases:
            with self.subTest(case=case):
                table = RecordingTable()
                await self.write(table, 7, "bot", "hello", "opening", started_at_ms=T0_MS, **case)
                self.assertEqual(table.attempts, table.rows)
                for column in NEW_COLUMNS:
                    self.assertNotIn(column, table.rows[0])

    async def test_an_end_equal_to_the_start_is_kept_and_an_end_needs_no_start(self) -> None:
        table = RecordingTable()
        await self.write(table, 1, "bot", "a", "opening", started_at_ms=T0_MS, ended_at_ms=T0_MS)
        await self.write(table, 2, "bot", "b", "opening", ended_at_ms=T0_MS)
        self.assertEqual([row["turn_ended_at_ms"] for row in table.rows], [T0_MS, T0_MS])

    def test_the_stored_voices_are_the_workers_own(self) -> None:
        self.assertEqual(r1_persistence.AI_VOICES, frozenset(r1_tts.VOICES))

    async def test_a_refused_extra_never_costs_the_row(self) -> None:
        """A database without 0136 (or a CHECK this code misjudged) still gets the transcript row."""
        for table in (
            RecordingTable(fail_with_columns=NEW_COLUMNS),
            RecordingTable(fail_with_columns=NEW_COLUMNS, error="PGRST204"),
        ):
            with self.subTest(error=table.error), capture_r1_logs() as lines:
                await self.write(
                    table, 9, "bot", "kept", "wrapup",
                    started_at_ms=T0_MS, ended_at_ms=T0_MS + 1, voice="interviewer", played_ms=1,
                )
                self.assertEqual(len(table.attempts), 2)
                self.assertEqual(
                    table.rows,
                    [{"session_id": SESSION_ID, "turn_index": 9, "speaker": "bot", "text": "kept",
                      "phase": "wrapup", "interrupted": False, "turn_started_at_ms": T0_MS}],
                )
                self.assertEqual(error_types(lines), ["r1_turn_timing_dropped"])
                self.assertNotIn("kept", json.dumps(lines))

    async def test_a_write_that_fails_without_the_extras_still_fails_as_before(self) -> None:
        table = RecordingTable(fail_with_columns=("session_id",))
        with self.assertRaises(RuntimeError):
            await self.write(table, 9, "bot", "x", "wrapup")
        self.assertEqual(len(table.attempts), 1)
        table = RecordingTable(fail_with_columns=("session_id",), error="boom")
        with self.assertRaises(persistence.LifecycleError):
            await self.write(table, 9, "bot", "x", "wrapup", voice="learner")
        self.assertEqual(len(table.attempts), 2)


class TimingCase(R1TestCase):
    """Play speeches the way the SDK reports them; ``self.kwargs`` is what each row was given."""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.kwargs: dict[int, dict] = {}
        save = self.writer.save_turn

        async def spy(index, speaker, text, phase, **kwargs) -> None:
            self.kwargs[index] = kwargs
            await save(index, speaker, text, phase, **kwargs)

        self.writer.save_turn = spy
        self.output = Emitter()
        self.session.output = SimpleNamespace(audio=self.output)
        self.interview._watch_playback()

    def begin(self, text: str = "a line", *, voice: str | None = "interviewer") -> FakeSpeechHandle:
        """The speech is created, tagged with its voice, and starts speaking."""
        handle = FakeSpeechHandle(text)
        self.session.current_speech = handle
        self.session.emit(
            "speech_created", SimpleNamespace(speech_handle=handle, source="say", user_initiated=True)
        )
        if voice is not None:
            self.interview._voices[str(handle.id)] = voice
        self.session.emit(
            "agent_state_changed",
            SimpleNamespace(old_state="listening", new_state="speaking", created_at=T0),
        )
        return handle

    def playback(self, start: float, finish: float, position: float, *, interrupted: bool = False) -> None:
        self.output.emit("playback_started", SimpleNamespace(created_at=T0 + start))
        self.playback_ends(finish, position, interrupted=interrupted)

    def playback_ends(self, finish: float, position: float, *, interrupted: bool = False) -> None:
        with mock.patch("r1_session.time.time", return_value=T0 + finish):
            self.output.emit(
                "playback_finished",
                SimpleNamespace(playback_position=position, interrupted=interrupted),
            )

    def agent_goes(self, state: str, at: float) -> None:
        """The agent's state changes: to ``listening`` when a voice pauses the line, and back."""
        with mock.patch("r1_session.time.time", return_value=T0 + at):
            self.session.emit("agent_state_changed", SimpleNamespace(new_state=state))

    def deliver(self, handle: FakeSpeechHandle, *, interrupted: bool = False, metrics=None) -> int:
        """The SDK reports the delivered line (after its playout), then the speech ends."""
        message = FakeChatMessage(handle.text, interrupted=interrupted)
        if metrics is not None:
            message.metrics = metrics
        handle.chat_items.append(message)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        self.session.current_speech = None
        return self.interview._turn_index

    def candidate_speaks(self, at: float | None) -> None:
        extra = {} if at is None else {"created_at": T0 + at}
        self.session.emit(
            "user_state_changed", SimpleNamespace(old_state="listening", new_state="speaking", **extra)
        )

    def candidate_stops(self, at: float | None) -> None:
        extra = {} if at is None else {"created_at": T0 + at}
        self.session.emit(
            "user_state_changed", SimpleNamespace(old_state="speaking", new_state="listening", **extra)
        )

    def candidate_final(self, text: str, at: float) -> int:
        self.session.emit(
            "user_input_transcribed",
            SimpleNamespace(is_final=True, transcript=text, created_at=T0 + at),
        )
        return self.interview._open_row.index


class TestBotRows(TimingCase):
    async def test_a_row_stores_who_spoke_when_it_finished_and_how_long_it_played(self) -> None:
        handle = self.begin(voice="learner")
        self.playback(0.0, 3.25, 3.0)
        index = self.deliver(handle)
        await self.flush()
        self.assertEqual(self.kwargs[index]["voice"], "learner")
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 3_250)
        self.assertEqual(self.kwargs[index]["played_ms"], 3_000)

    async def test_two_playbacks_of_one_speech_add_up_and_the_last_one_ends_the_row(self) -> None:
        handle = self.begin()
        self.playback(0.0, 1.0, 1.0)
        self.playback(1.5, 3.0, 1.25)
        index = self.deliver(handle)
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 3_000)
        self.assertEqual(self.kwargs[index]["played_ms"], 2_250)

    async def test_a_cut_line_stores_what_was_played_not_what_was_written(self) -> None:
        handle = self.begin()
        self.playback(0.0, 2.0, 1.5, interrupted=True)
        index = self.deliver(handle, interrupted=True)
        await self.flush()
        self.assertEqual(self.kwargs[index]["played_ms"], 1_500)
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 2_000)
        self.assertIs(self.kwargs[index]["interrupted"], True)

    async def test_a_line_the_candidates_voice_paused_and_then_cut_ends_where_the_audio_stopped(self) -> None:
        """The room reports the cut only after their barge-in: the row must not cover it."""
        handle = self.begin()
        self.output.emit("playback_started", SimpleNamespace(created_at=T0))
        self.agent_goes("listening", 0.51)
        self.playback_ends(3.0, 0.76, interrupted=True)
        index = self.deliver(handle, interrupted=True)
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 510)
        self.assertEqual(self.kwargs[index]["played_ms"], 760)
        self.assertIs(self.kwargs[index]["interrupted"], True)

    async def test_a_paused_line_that_came_back_ends_when_it_finished(self) -> None:
        handle = self.begin()
        self.output.emit("playback_started", SimpleNamespace(created_at=T0))
        self.agent_goes("listening", 1.0)
        self.agent_goes("speaking", 3.0)
        self.output.emit("playback_started", SimpleNamespace(created_at=T0 + 3.0))
        self.playback_ends(6.0, 3.0)
        index = self.deliver(handle)
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 6_000)

    async def test_the_agent_listening_again_after_a_line_moves_no_end(self) -> None:
        handle = self.begin()
        self.playback(0.0, 2.0, 2.0)
        self.agent_goes("listening", 2.1)
        index = self.deliver(handle)
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 2_000)

    async def test_the_playback_report_wins_over_the_sdks_metric(self) -> None:
        handle = self.begin()
        self.playback(0.0, 2.0, 2.0)
        index = self.deliver(handle, metrics={"stopped_speaking_at": T0 + 9.0})
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 2_000)

    async def test_without_a_playback_report_the_metric_ends_the_row_and_nothing_is_guessed(self) -> None:
        handle = self.begin()
        index = self.deliver(handle, metrics={"stopped_speaking_at": T0 + 4.0})
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 4_000)
        self.assertNotIn("played_ms", self.kwargs[index])

    async def test_with_neither_the_row_has_no_end_and_is_still_written(self) -> None:
        for bad in (None, {}, {"stopped_speaking_at": float("nan")}, {"stopped_speaking_at": "soon"}):
            with self.subTest(metrics=bad):
                handle = self.begin("still here")
                index = self.deliver(handle, metrics=bad)
                await self.flush()
                self.assertNotIn("ended_at_ms", self.kwargs[index])
                self.assertNotIn("played_ms", self.kwargs[index])
                self.assertEqual(self.writer.saved[-1]["text"], "still here")

    async def test_a_speech_nobody_tagged_stores_no_voice_rather_than_the_phase_guess(self) -> None:
        handle = self.begin(voice=None)
        index = self.deliver(handle)
        await self.flush()
        self.assertNotIn("voice", self.kwargs[index])
        self.assertEqual(self.interview._history[-1]["voice"], r1_tts.INTERVIEWER)  # the label still falls back

    async def test_a_reply_planned_in_the_aside_stores_the_learner_the_phase_would_have_called_christy(self) -> None:
        self.enter_roleplay()
        self.interview.machine.transition(r1_session.R1Phase.ASIDE)
        handle = FakeSpeechHandle("reply")
        self.session.current_speech = handle
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        self.session.emit(
            "agent_state_changed",
            SimpleNamespace(old_state="listening", new_state="speaking", created_at=T0),
        )
        index = self.deliver(handle)
        await self.flush()
        self.assertEqual(self.kwargs[index]["voice"], r1_tts.LEARNER)

    async def test_a_scripted_line_stores_the_voice_it_was_spoken_in(self) -> None:
        await self.interview.say("L-SIL-IB")
        await self.flush()
        self.assertEqual(self.kwargs[self.interview._turn_index]["voice"], r1_tts.INTERVIEWER)

    async def test_the_session_passes_nothing_it_does_not_have(self) -> None:
        """A writer that predates the columns (and a row with no facts) is called exactly as before."""
        handle = self.begin(voice=None)
        index = self.deliver(handle)
        await self.flush()
        self.assertEqual(set(self.kwargs[index]) & {"ended_at_ms", "voice", "played_ms"}, set())


class TestCandidateRows(TimingCase):
    """The end of a candidate row is the VAD's end of speech, as back-dated by the SDK."""

    async def test_the_row_ends_at_the_back_dated_end_of_speech_never_the_write_time(self) -> None:
        self.candidate_speaks(10.0)
        self.candidate_stops(14.5)
        index = self.candidate_final("my answer", 15.0)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertEqual(self.kwargs[index]["started_at_ms"], T0_MS + 10_000)
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 14_500)
        self.assertNotIn("voice", self.kwargs[index])
        self.assertNotIn("played_ms", self.kwargs[index])

    async def test_a_final_ahead_of_the_end_of_speech_still_gets_it_when_the_row_closes(self) -> None:
        self.candidate_speaks(10.0)
        index = self.candidate_final("my answer", 12.0)
        self.candidate_stops(12.5)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 12_500)

    async def test_a_pause_inside_the_answer_ends_it_at_the_last_end_of_speech(self) -> None:
        self.candidate_speaks(10.0)
        self.candidate_stops(11.0)
        index = self.candidate_final("first part", 11.5)
        self.candidate_speaks(12.0)
        self.candidate_stops(15.0)
        self.candidate_final("second part", 15.5)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 15_000)

    async def test_a_row_closed_while_they_are_still_speaking_has_no_end_yet(self) -> None:
        self.candidate_speaks(10.0)
        self.candidate_stops(11.0)
        self.candidate_speaks(12.0)
        index = self.candidate_final("still going", 13.0)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertNotIn("ended_at_ms", self.kwargs[index])

    async def test_an_end_of_speech_from_before_this_row_began_is_the_previous_answers(self) -> None:
        self.candidate_speaks(5.0)
        self.candidate_stops(6.0)
        self.candidate_final("earlier", 6.5)
        self.interview._flush_candidate_row()
        await self.flush()
        self.candidate_speaks(20.0)
        self.interview._user_state = "listening"  # the VAD never reported this answer's end
        index = self.candidate_final("later", 21.0)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertEqual(self.kwargs[index]["started_at_ms"], T0_MS + 20_000)
        self.assertNotIn("ended_at_ms", self.kwargs[index])

    async def test_a_row_with_no_start_gets_no_end_and_is_still_written(self) -> None:
        self.candidate_speaks(5.0)
        self.candidate_stops(6.0)
        self.candidate_final("earlier", 6.5)
        self.interview._flush_candidate_row()
        index = self.candidate_final("no speaking event for this one", 9.0)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertNotIn("started_at_ms", self.kwargs[index])
        self.assertNotIn("ended_at_ms", self.kwargs[index])
        self.assertEqual(self.writer.saved[-1]["text"], "no speaking event for this one")

    async def test_an_end_of_speech_with_no_usable_time_is_no_end(self) -> None:
        self.candidate_speaks(10.0)
        self.candidate_stops(None)
        index = self.candidate_final("plain", 11.0)
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertNotIn("ended_at_ms", self.kwargs[index])

    async def test_the_end_is_fixed_when_the_row_closes_not_when_it_is_written(self) -> None:
        self.candidate_speaks(10.0)
        self.candidate_stops(11.0)
        index = self.candidate_final("closed now", 11.5)
        row = self.interview._close_candidate_row()
        self.candidate_speaks(30.0)
        self.candidate_stops(31.0)  # the next answer
        self.interview._write_candidate_row(row)
        await self.flush()
        self.assertEqual(self.kwargs[index]["ended_at_ms"], T0_MS + 11_000)


class TestPlaybackLine(TimingCase):
    """One structured line per AI playback, with the seconds of silence inside it."""

    def line(self, lines: list[dict]) -> dict:
        found = [entry for entry in lines if entry.get("error_type") == "r1_playback_silence"]
        self.assertEqual(len(found), 1, lines)
        return found[0]

    async def test_a_playback_logs_its_silence_voice_row_and_phase(self) -> None:
        with capture_r1_logs() as lines:
            handle = self.begin(voice="learner")
            self.playback(0.0, 6.5, 4.0)
        entry = self.line(lines)
        self.assertEqual(entry["duration_sec"], 2.5)
        self.assertEqual(entry["error_category"], "full")
        self.assertEqual(entry["paused_sec"], 0.0)
        self.assertEqual(entry["option_count"], 0)
        self.assertEqual(entry["schema"], "learner")
        self.assertEqual(entry["phase"], "icebreaker")
        self.assertEqual(entry["turn_index"], self.interview._speeches[handle.id].index)

    async def test_a_cut_playback_says_so_and_a_resume_is_counted(self) -> None:
        with capture_r1_logs() as lines:
            self.begin()
            self.output.emit("playback_started", SimpleNamespace(created_at=T0))
            self.output.emit("playback_started", SimpleNamespace(created_at=T0 + 3.0))
            self.playback_ends(5.0, 2.0, interrupted=True)
        entry = self.line(lines)
        self.assertEqual(entry["error_category"], "cut")
        self.assertEqual(entry["option_count"], 1)
        self.assertEqual(entry["duration_sec"], 3.0)

    async def test_a_barge_in_is_its_own_number_and_never_reads_as_a_fragment_wait(self) -> None:
        """A line paused and then cut never counts a resume, so the hold must show by itself."""
        with capture_r1_logs() as lines:
            self.begin()
            self.output.emit("playback_started", SimpleNamespace(created_at=T0))
            self.agent_goes("listening", 0.51)
            self.playback_ends(2.75, 0.76, interrupted=True)
        entry = self.line(lines)
        self.assertEqual(entry["error_category"], "cut")
        self.assertEqual(entry["option_count"], 0)
        self.assertEqual(entry["paused_sec"], 2.24)
        self.assertEqual(entry["duration_sec"], 0.0)

    async def test_a_hold_that_came_back_leaves_only_the_real_gap_in_the_silence(self) -> None:
        with capture_r1_logs() as lines:
            self.begin()
            self.output.emit("playback_started", SimpleNamespace(created_at=T0))
            self.agent_goes("listening", 1.0)
            self.agent_goes("speaking", 3.0)
            self.output.emit("playback_started", SimpleNamespace(created_at=T0 + 3.0))
            self.playback_ends(6.5, 3.0)
        entry = self.line(lines)
        self.assertEqual(entry["error_category"], "full")
        self.assertEqual(entry["option_count"], 1)
        self.assertEqual(entry["paused_sec"], 2.0)
        self.assertEqual(entry["duration_sec"], 1.5)

    async def test_every_playback_gets_its_own_line(self) -> None:
        with capture_r1_logs() as lines:
            self.begin()
            self.playback(0.0, 1.0, 1.0)
            self.playback(2.0, 4.0, 1.0)
        found = [e for e in lines if e.get("error_type") == "r1_playback_silence"]
        self.assertEqual([e["duration_sec"] for e in found], [0.0, 1.0])

    async def test_a_playback_nobody_heard_logs_nothing(self) -> None:
        with capture_r1_logs() as lines:
            self.begin()
            self.playback_ends(1.0, 0.0, interrupted=True)
        self.assertNotIn("r1_playback_silence", error_types(lines))

    async def test_a_playback_with_no_speech_to_tie_it_to_still_logs_its_silence(self) -> None:
        with capture_r1_logs() as lines:
            self.session.current_speech = None
            self.playback(0.0, 2.0, 1.0)
        entry = self.line(lines)
        self.assertEqual(entry["duration_sec"], 1.0)
        self.assertNotIn("turn_index", entry)
        self.assertNotIn("phase", entry)
        self.assertNotIn("schema", entry)

    async def test_the_line_carries_numbers_and_fixed_labels_only(self) -> None:
        """No transcript text and no personal data, whatever the line said and whoever heard it."""
        poison = "Quokka-utterance-7731"
        self.interview._candidate_name = "Zanzibarella"
        with capture_r1_logs() as lines:
            handle = self.begin(poison, voice="learner")
            self.playback(0.0, 2.0, 1.0, interrupted=True)
            self.deliver(handle, interrupted=True)
            await self.flush()
        entry = self.line(lines)
        self.assertLessEqual(
            set(entry),
            {"timestamp", "level", "component", "event", "correlationId", "error_type", "error_category",
             "duration_sec", "paused_sec", "option_count", "turn_index", "phase", "schema"},
        )
        blob = json.dumps(lines)
        for secret in (poison, "Zanzibarella", SESSION_ID, ROOM_NAME):
            self.assertNotIn(secret, blob)


class TestWatchingTheOutput(R1TestCase):
    async def test_the_watch_is_attached_after_the_session_starts_and_before_the_recorder_wraps_it(self) -> None:
        steps: list = []

        async def start_recorder(_identity) -> None:
            steps.append("recorder")

        self.interview._recorder_start = start_recorder
        original = self.interview._watch_playback

        def watch() -> None:
            steps.append("watch")
            original()

        async def start() -> None:
            steps.append("session")

        async def stop_here(*_args, **_kwargs):
            raise RuntimeError("the opening line: far enough")

        with mock.patch.object(self.interview, "_watch_playback", watch), mock.patch.object(
            self.interview, "_start", start
        ), mock.patch.object(self.interview, "say", stop_here), mock.patch.object(
            self.interview, "_wait_for_candidate", mock.AsyncMock(return_value=True)
        ), mock.patch.object(
            self.interview, "_activate", mock.AsyncMock(return_value=True)
        ), mock.patch.object(
            self.interview, "_finish", mock.AsyncMock(return_value="provider_error")
        ), mock.patch.object(
            self.interview, "_exit", mock.AsyncMock()
        ):
            self.interview.machine = r1_session.R1PhaseMachine(clock=self.clock)
            await self.interview.run()
        self.assertEqual(steps, ["session", "watch", "recorder"])

    async def test_a_session_with_no_output_is_noted_and_the_interview_goes_on(self) -> None:
        for output in (None, SimpleNamespace(), SimpleNamespace(audio=None), SimpleNamespace(audio=object())):
            with self.subTest(output=output), capture_r1_logs() as lines:
                self.session.output = output
                self.interview._watch_playback()
                self.assertEqual(error_types(lines), ["r1_playback_watch_unavailable"])


class TestThePhoneLaneWritesNothingNew(unittest.IsolatedAsyncioTestCase):
    """0136 belongs to R1: the phone writer's insert shape and every phone module stay as they were."""

    async def test_the_phone_writer_inserts_exactly_its_old_row(self) -> None:
        table = RecordingTable()
        with mock.patch.object(persistence, "_table", lambda _name: table):
            await persistence.save_turn(SESSION_ID, 3, "bot", " hello ", turn_started_at_ms=T0_MS)
            await persistence.save_turn(SESSION_ID, 4, "candidate", "hi")
        self.assertEqual(
            table.rows,
            [
                {"session_id": SESSION_ID, "turn_index": 3, "speaker": "bot", "text": "hello",
                 "turn_started_at_ms": T0_MS},
                {"session_id": SESSION_ID, "turn_index": 4, "speaker": "candidate", "text": "hi",
                 "turn_started_at_ms": None},
            ],
        )

    def test_no_module_outside_r1_names_a_new_column_or_the_playback_watch(self) -> None:
        tokens = (*NEW_COLUMNS, "PlaybackMeter", "r1_playback_silence", "_watch_playback", "played_ms")
        for path in sorted(HERE.glob("*.py")):
            if path.name.startswith("r1_"):
                continue
            source = path.read_text(encoding="utf-8")
            for token in tokens:
                with self.subTest(module=path.name, token=token):
                    self.assertNotIn(token, source)

    def test_only_the_r1_turn_writer_writes_the_new_columns(self) -> None:
        writers = [
            path.name
            for path in sorted(HERE.glob("r1_*.py"))
            if any(f'"{column}"' in path.read_text(encoding="utf-8") for column in NEW_COLUMNS)
        ]
        self.assertEqual(writers, ["r1_persistence.py"])


if __name__ == "__main__":
    unittest.main()
