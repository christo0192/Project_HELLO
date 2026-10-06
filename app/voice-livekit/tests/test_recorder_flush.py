"""M013 S02-1: the recording TAIL flush against the REAL livekit-agents 1.6.4
RecorderIO (encode thread, rtc resamplers, Opus/OGG mux) and a PyAV decode.

`recording._FlushingRecorderIO` reaches into RecorderIO internals, so the fakes
in test_recording.py can only prove the call order. These cases replay real
frame TIMINGS through the real recorder and decode the resulting OGG:

  1. generic: a pending 3 s utterance and the held-back candidate audio land;
  2. replay of session 9f60523d leg 1 (Q1 cut by the hang-up);
  3. replay of 9f60523d leg 2 (input-only tail after Q1 finished);
  4. replay of 32757295 (candidate speech in the last, held-back 2.5 s);
  5. late close: `close` 2.5 s after the leave, TTS still being captured —
     the file must not extend past the leave;
  6. anchor: a tone at a known wall time lands at
     (tone_wall - manifest.recording_started_at_ms) +/- 50 ms, with an
     output frame captured BEFORE begin();
  plus the close-latency bound (a 20 s pending tail closes well inside
  RECORDER_CLOSE_TIMEOUT_SEC) and the kill-switch control (the stock recorder
  reproduces today's truncation).

Every fixture is SYNTHETIC: sine tones or digital silence placed at the
timings measured on the real calls (sessions named by prefix only). No real
audio, names or numbers. The wall clock is a fake (`time.time` patched), so a
60 s call replays in well under a second.

The CI step "Test recording tail flush (real SDK)" runs this module in the
requirements.txt venv and FAILS if anything here is skipped; under bare python
(no livekit/av/numpy) the module skips.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

try:
    import av
    import numpy as np
    from livekit import rtc
    from livekit.agents.voice import io as lk_io

    _HAS_SDK = True
except Exception:  # noqa: BLE001 — bare python in the first CI step
    _HAS_SDK = False

import recording

_IN_RATE = 24_000  # the phone input/TTS rate; the recorder resamples to 48 kHz
_FRAME_SEC = 0.02
_SPF = int(_IN_RATE * _FRAME_SEC)
_OUT_RATE = 48_000
_SIP_IDENTITY = "phone-replay-attempt"
_T0 = 1_000_000.0  # fake epoch seconds at rec 0


def _tone_frame(freq: float) -> "rtc.AudioFrame":
    t = np.arange(_SPF) / _IN_RATE
    pcm = (0.3 * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16)
    return rtc.AudioFrame(
        data=pcm.tobytes(), sample_rate=_IN_RATE, num_channels=1,
        samples_per_channel=_SPF,
    )


def _silence_frame() -> "rtc.AudioFrame":
    return rtc.AudioFrame(
        data=b"\x00\x00" * _SPF, sample_rate=_IN_RATE, num_channels=1,
        samples_per_channel=_SPF,
    )


class _Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def time(self) -> float:
        return self.t


if _HAS_SDK:

    class _Source:
        """The room input: hands the recorder tap whatever frame is staged."""

        def __init__(self) -> None:
            self.next_frame = None

        def __aiter__(self):
            return self

        async def __anext__(self):
            return self.next_frame

    class _Sink(lk_io.AudioOutput):
        """The room output leaf: accepts frames, reports playback on demand."""

        def __init__(self) -> None:
            super().__init__(
                label="ReplaySink",
                capabilities=lk_io.AudioOutputCapabilities(pause=True),
            )

        async def capture_frame(self, frame) -> None:
            await super().capture_frame(frame)

        def flush(self) -> None:
            super().flush()

        def clear_buffer(self) -> None:
            pass


class _IO:
    def __init__(self, audio) -> None:
        self.audio = audio


class _Session:
    def __init__(self, source, sink) -> None:
        self.input = _IO(source)
        self.output = _IO(sink)
        self._handlers: dict[str, list] = {}

    def on(self, event, handler):
        self._handlers.setdefault(event, []).append(handler)
        return handler

    def off(self, event, handler):
        self._handlers.get(event, []).remove(handler)

    def emit(self, event, payload=None) -> None:
        for h in list(self._handlers.get(event, [])):
            h(payload)


class _Room:
    def __init__(self) -> None:
        self._handlers: dict[str, list] = {}

    def on(self, event, handler):
        self._handlers.setdefault(event, []).append(handler)
        return handler

    def off(self, event, handler):
        self._handlers.get(event, []).remove(handler)

    def emit(self, event, participant) -> None:
        for h in list(self._handlers.get(event, [])):
            h(participant)


class _Participant:
    def __init__(self, identity: str) -> None:
        self.identity = identity


def _in_any(t: float, windows) -> bool:
    return any(a <= t < b for a, b in windows)


class _Replay:
    """Drives one leg through a real InWorkerRecorder on a fake clock."""

    def __init__(self, *, tail_flush: bool = True) -> None:
        self.clock = _Clock(_T0)
        self.source = _Source()
        self.sink = _Sink()
        self.session = _Session(self.source, self.sink)
        self.room = _Room()
        self.uploads: list[tuple[str, bytes]] = []
        self.tail_flush = tail_flush
        self.recorder = None
        self.ogg: bytes | None = None
        self.manifest = None
        self._tone_in = _tone_frame(440.0)
        self._tone_out = _tone_frame(880.0)
        self._silence = _silence_frame()

    async def _upload(self, url, body, content_type="audio/mpeg"):
        self.uploads.append((content_type, body))

    async def _no_mp3(self, ogg, mp3):
        Path(mp3).write_bytes(b"")  # keep the raw OGG (the fallback path)

    def build(self, work_dir: Path) -> None:
        self.recorder = recording.InWorkerRecorder(
            self.session, work_dir=work_dir, transcode_fn=self._no_mp3,
            upload_fn=self._upload,
        )
        self.recorder.watch_leg_end(self.room, _SIP_IDENTITY)

    def at(self, rec_s: float) -> None:
        self.clock.t = _T0 + rec_s

    async def pull_input(self, frame) -> None:
        self.source.next_frame = frame
        await self.session.input.audio.__anext__()

    async def push_output(self, frame) -> None:
        await self.session.output.audio.capture_frame(frame)

    def playback_finished(self, position: float, *, interrupted: bool = False) -> None:
        self.session.output.audio.flush()
        self.sink.on_playback_finished(playback_position=position, interrupted=interrupted)

    async def run(
        self,
        *,
        until: float,
        bot: list[tuple[float, float, bool]],
        cand: list[tuple[float, float]],
        input_until: float | None = None,
        leave_at: float | None = None,
        close_at: float | None = None,
    ) -> None:
        """Tick 20 ms from rec 0 to ``until``. ``bot`` items are
        (start, end, finishes): frames pushed in [start, end); when
        ``finishes`` the sink reports playback finished at ``end``."""
        input_until = until if input_until is None else input_until
        n = int(round(until / _FRAME_SEC))
        finished = set()
        fired: set[str] = set()
        for i in range(n + 1):
            t = round(i * _FRAME_SEC, 6)
            self.at(t)
            for idx, (start, end, finishes) in enumerate(bot):
                if finishes and idx not in finished and t >= end:
                    finished.add(idx)
                    self.playback_finished(end - start)
            if leave_at is not None and "leave" not in fired and t >= leave_at:
                fired.add("leave")
                self.at(leave_at)  # the event's own wall time, off the 20 ms grid
                self.room.emit("participant_disconnected", _Participant(_SIP_IDENTITY))
                self.at(t)
            if close_at is not None and "close" not in fired and t >= close_at:
                fired.add("close")
                self.at(close_at)
                # The session's own close: interrupt the pending utterance
                # (its playback_finished), then the `close` event.
                for idx, (start, end, finishes) in enumerate(bot):
                    if not finishes and start <= close_at:
                        self.playback_finished(min(close_at, end) - start, interrupted=True)
                self.session.emit("close")
                self.at(t)
            if i == n:
                break
            if t < input_until:
                await self.pull_input(self._tone_in if _in_any(t, cand) else self._silence)
            if _in_any(t, [(s, e) for s, e, _f in bot]):
                await self.push_output(self._tone_out)

    async def finish(self) -> None:
        manifest = await self.recorder.finish("https://upload.test/put")
        assert manifest is not None, "the recording must upload"
        self.manifest = manifest
        oggs = [b for ct, b in self.uploads if ct == "audio/ogg"]
        assert oggs, "the durable OGG PUT must have happened"
        self.ogg = oggs[-1]


def _decode(ogg: bytes) -> "np.ndarray":
    """(2, n) float32 at 48 kHz: row 0 = candidate (left), 1 = bot (right)."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "replay.ogg"
        p.write_bytes(ogg)
        c = av.open(str(p))
        try:
            s = c.streams.audio[0]
            chunks = []
            for frame in c.decode(s):
                arr = frame.to_ndarray()
                if arr.ndim == 2 and arr.shape[0] == 1 and frame.format.is_packed:
                    arr = arr.reshape(-1, 2).T
                chunks.append(arr.astype(np.float32))
        finally:
            c.close()
    return np.concatenate(chunks, axis=1)


def _rms(pcm: "np.ndarray", ch: int, a: float, b: float) -> float:
    seg = pcm[ch, int(a * _OUT_RATE):int(b * _OUT_RATE)]
    if seg.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(seg.astype(np.float64)))))


def _energy_everywhere(pcm, ch, a, b, step=0.5, floor=0.05) -> bool:
    t = a
    while t + step <= b + 1e-9:
        if _rms(pcm, ch, t, t + step) < floor:
            return False
        t += step
    return True


def _last_energy_end(pcm, ch, floor=0.05, step=0.02) -> float:
    n = pcm.shape[1]
    win = int(step * _OUT_RATE)
    last = 0.0
    for start in range(0, n - win + 1, win):
        seg = pcm[ch, start:start + win].astype(np.float64)
        if np.sqrt(np.mean(np.square(seg))) >= floor:
            last = (start + win) / _OUT_RATE
    return last


# ── Timings (recording seconds) measured on the real calls ───────────────────
# 9f60523d leg 1: rec 0 = answer + 1.05 s.
_LEG1_BOT = [
    (0.55, 6.25, True), (12.05, 19.55, True), (35.0, 39.3, True),
    (45.15, 52.85, True),       # the role line
    (54.66, 61.06, False),      # Q1 (6.4 s), cut by the hang-up
]
_LEG1_CAND = [(7.1, 8.35), (21.5, 23.5), (40.85, 42.45)]
_LEG1_LEAVE = 60.43
# 9f60523d leg 2 (reconnect): the candidate is silent for the whole leg.
_LEG2_BOT = [(2.1, 9.5, True), (10.4, 16.8, True)]
_LEG2_LEAVE = 17.99
# 32757295: no bot audio pending at the end; speech in the held-back tail.
_S3_BOT = [(1.1, 5.55, True), (11.0, 16.15, True), (21.9, 26.55, True)]
_S3_CAND = [(0.6, 1.15), (6.55, 8.85), (18.2, 19.5), (29.1, 32.2)]
_S3_LEAVE = 33.4


@unittest.skipUnless(_HAS_SDK, "livekit-agents/av/numpy not installed (bare-python CI step)")
class TestRecorderTailFlushRealSdk(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.work = Path(self._tmp.name)
        self._env = unittest.mock.patch.dict(os.environ, {"PHONE_RECORDING_TAIL_FLUSH": "on"})
        self._env.start()
        # The replays keep the raw OGG on purpose (no MP3 upgrade), which logs
        # a warning with a traceback per case; keep the CI log readable. The
        # assertions (tail_flushed, decoded audio) carry the verdict.
        self._log_disabled = recording.logger.disabled
        recording.logger.disabled = True

    def tearDown(self) -> None:
        recording.logger.disabled = self._log_disabled
        self._env.stop()
        self._tmp.cleanup()

    def _run(self, replay: _Replay, scenario) -> "np.ndarray":
        async def main():
            with unittest.mock.patch("time.time", replay.clock.time):
                replay.build(self.work)
                replay.at(0.0)
                self.assertTrue(replay.recorder.wire())
                self.assertTrue(await replay.recorder.begin("phone/attempts/replay.mp3"))
                await scenario(replay)
                await replay.finish()

        asyncio.run(main())
        return _decode(replay.ogg)

    def test_sdk_is_the_verified_version(self):
        from livekit.agents import __version__

        self.assertEqual(__version__, recording._TAIL_FLUSH_SDK_VERSION)

    # 1 ────────────────────────────────────────────────────────────────────
    def test_generic_pending_utterance_and_held_input_land(self):
        replay = _Replay()

        async def scenario(r: _Replay):
            await r.run(until=5.0, bot=[(2.0, 5.0, False)], cand=[(0.0, 2.0)], leave_at=5.0)

        pcm = self._run(replay, scenario)
        duration = pcm.shape[1] / _OUT_RATE
        self.assertGreaterEqual(duration, 4.9, duration)
        self.assertTrue(_energy_everywhere(pcm, 1, 2.1, 4.9), "bot tail missing")
        self.assertTrue(_energy_everywhere(pcm, 0, 0.1, 1.9), "candidate audio missing")
        self.assertTrue(replay.recorder.tail_flushed)

    # 2 ────────────────────────────────────────────────────────────────────
    def test_replay_9f60523d_leg1_q1_cut_by_hangup(self):
        replay = _Replay()

        async def scenario(r: _Replay):
            await r.run(
                until=_LEG1_LEAVE + 0.06, bot=_LEG1_BOT, cand=_LEG1_CAND,
                input_until=_LEG1_LEAVE, leave_at=_LEG1_LEAVE,
            )

        pcm = self._run(replay, scenario)
        duration = pcm.shape[1] / _OUT_RATE
        self.assertGreaterEqual(duration, 60.3, f"today the file ends at 53.18 s; got {duration}")
        self.assertTrue(_energy_everywhere(pcm, 1, 54.7, 60.3), "Q1 up to the hang-up missing")
        # The earlier timeline is intact: role line on the right, both yeses left.
        self.assertTrue(_energy_everywhere(pcm, 1, 45.3, 52.7))
        self.assertTrue(_energy_everywhere(pcm, 0, 21.6, 23.4))
        self.assertTrue(_energy_everywhere(pcm, 0, 40.9, 42.4))
        self.assertEqual(replay.recorder.leg_end_source, "sip_left")
        # M013 S02 T02: the manifest reports the truth about this file.
        m = replay.manifest
        self.assertAlmostEqual(m.duration_ms / 1000.0, duration, delta=0.05)
        self.assertEqual(m.leg_ended_at_ms, int(round((_T0 + _LEG1_LEAVE) * 1000)))
        self.assertEqual(m.recording_started_at_ms, int(round(_T0 * 1000)))
        self.assertIs(m.tail_flushed, True)

    def test_kill_switch_control_reproduces_todays_truncation(self):
        with unittest.mock.patch.dict(os.environ, {"PHONE_RECORDING_TAIL_FLUSH": "off"}):
            replay = _Replay(tail_flush=False)

            async def scenario(r: _Replay):
                await r.run(
                    until=_LEG1_LEAVE + 0.06, bot=_LEG1_BOT, cand=_LEG1_CAND,
                    input_until=_LEG1_LEAVE, leave_at=_LEG1_LEAVE,
                )

            pcm = self._run(replay, scenario)
        duration = pcm.shape[1] / _OUT_RATE
        # The stock recorder drops Q1 and the held-back input: the file stops
        # at the role line's playback end (53.18 s on the real call).
        self.assertLess(duration, 53.6, duration)
        self.assertFalse(replay.recorder.tail_flushed)
        self.assertIs(replay.manifest.tail_flushed, False)
        self.assertAlmostEqual(replay.manifest.duration_ms / 1000.0, duration, delta=0.05)

    # 3 ────────────────────────────────────────────────────────────────────
    def test_replay_9f60523d_leg2_input_only_tail(self):
        replay = _Replay()

        async def scenario(r: _Replay):
            await r.run(
                until=_LEG2_LEAVE + 0.06, bot=_LEG2_BOT, cand=[],
                input_until=_LEG2_LEAVE, leave_at=_LEG2_LEAVE,
            )

        pcm = self._run(replay, scenario)
        duration = pcm.shape[1] / _OUT_RATE
        self.assertGreaterEqual(duration, 17.9, f"today 17.59 s; got {duration}")
        self.assertAlmostEqual(replay.manifest.duration_ms / 1000.0, duration, delta=0.05)
        self.assertTrue(_energy_everywhere(pcm, 1, 10.5, 16.7), "Q1 missing")

    # 4 ────────────────────────────────────────────────────────────────────
    def test_replay_32757295_held_back_candidate_speech(self):
        replay = _Replay()

        async def scenario(r: _Replay):
            await r.run(
                until=_S3_LEAVE + 0.06, bot=_S3_BOT, cand=_S3_CAND,
                input_until=_S3_LEAVE, leave_at=_S3_LEAVE,
            )

        pcm = self._run(replay, scenario)
        duration = pcm.shape[1] / _OUT_RATE
        self.assertGreaterEqual(duration, 33.3, duration)
        self.assertTrue(
            _energy_everywhere(pcm, 0, 29.2, 32.1),
            "the callback request in the held-back tail is missing",
        )
        self.assertGreaterEqual(_last_energy_end(pcm, 0), 32.1)

    # 5 ────────────────────────────────────────────────────────────────────
    def test_late_close_cut_follows_the_hangup_not_the_close(self):
        replay = _Replay()
        late = 2.5

        async def scenario(r: _Replay):
            # Q1 frames keep being captured and the line keeps delivering
            # (silent) input after the leave; the session closes 2.5 s later,
            # interrupting Q1 (its playback_finished) before `close`.
            await r.run(
                until=_LEG1_LEAVE + late + 0.04, bot=_LEG1_BOT, cand=_LEG1_CAND,
                input_until=_LEG1_LEAVE + late, leave_at=_LEG1_LEAVE,
                close_at=_LEG1_LEAVE + late,
            )

        pcm = self._run(replay, scenario)
        duration = pcm.shape[1] / _OUT_RATE
        self.assertLessEqual(duration, _LEG1_LEAVE + 0.3, f"extends past the leave: {duration}")
        self.assertGreaterEqual(duration, 60.3, duration)
        self.assertTrue(_energy_everywhere(pcm, 1, 54.7, 60.3))
        self.assertLessEqual(_last_energy_end(pcm, 1), _LEG1_LEAVE + 0.3)
        self.assertEqual(replay.recorder.leg_end_source, "sip_left")
        self.assertAlmostEqual(replay.recorder.leg_ended_at, _T0 + _LEG1_LEAVE, places=3)

    # 6 ────────────────────────────────────────────────────────────────────
    def test_anchor_maps_wall_time_to_file_time(self):
        replay = _Replay()
        tone_at = 3.0

        async def main():
            with unittest.mock.patch("time.time", replay.clock.time):
                replay.build(self.work)
                replay.at(0.0)
                self.assertTrue(replay.recorder.wire())
                # An output frame captured BEFORE begin(): the SDK stamps the
                # output start even when not recording, which must not pull
                # the anchor before the file's t = 0.
                replay.at(-1.0)
                await replay.push_output(replay._tone_out)
                replay.playback_finished(_FRAME_SEC)
                replay.at(0.0)
                self.assertTrue(await replay.recorder.begin("phone/attempts/replay.mp3"))
                await replay.run(
                    until=6.0, bot=[], cand=[(tone_at, tone_at + 0.5)], leave_at=6.0,
                )
                rec_io = replay.recorder._recorder
                started = rec_io.recording_started_at
                begun = replay.recorder._begun_at_ms / 1000.0
                self.assertLess(started, begun)  # the pre-begin frame moved the SDK anchor
                await replay.finish()

        asyncio.run(main())
        pcm = _decode(replay.ogg)
        # M013 S02 T02: the anchor is the manifest's own field, never before
        # begin() even though the SDK's combined value is.
        anchor = replay.manifest.recording_started_at_ms / 1000.0
        self.assertGreaterEqual(anchor, _T0)
        expected = (_T0 + tone_at) - anchor
        onset = None
        win = int(0.005 * _OUT_RATE)
        for start in range(0, pcm.shape[1] - win, win):
            seg = pcm[0, start:start + win].astype(np.float64)
            if np.sqrt(np.mean(np.square(seg))) >= 0.05:
                onset = start / _OUT_RATE
                break
        self.assertIsNotNone(onset)
        self.assertAlmostEqual(onset, expected, delta=0.05)

    # close-latency bound ───────────────────────────────────────────────────
    def test_twenty_second_pending_tail_closes_inside_the_bound(self):
        replay = _Replay()
        measured: dict[str, float] = {}

        async def main():
            with unittest.mock.patch("time.time", replay.clock.time):
                replay.build(self.work)
                replay.at(0.0)
                self.assertTrue(replay.recorder.wire())
                self.assertTrue(await replay.recorder.begin("phone/attempts/replay.mp3"))
                await replay.run(
                    until=20.0, bot=[(0.0, 20.0, False)], cand=[(0.0, 20.0)],
                    leave_at=20.0,
                )
                rec_io = replay.recorder._recorder
                t = time.perf_counter()
                await rec_io.aclose()
                measured["aclose_s"] = time.perf_counter() - t
                await replay.finish()

        asyncio.run(main())
        print(f"\n[tail-flush] aclose with a 20 s pending tail: {measured['aclose_s'] * 1000:.0f} ms")
        self.assertLess(measured["aclose_s"], 1.0)
        self.assertLess(measured["aclose_s"], recording.RECORDER_CLOSE_TIMEOUT_SEC)
        pcm = _decode(replay.ogg)
        self.assertGreaterEqual(pcm.shape[1] / _OUT_RATE, 19.9)
        self.assertTrue(_energy_everywhere(pcm, 1, 0.5, 19.5))


if __name__ == "__main__":
    unittest.main()
