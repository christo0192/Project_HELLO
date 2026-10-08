"""R1's Sarvam request budget, 429 counter and scripted-line cache (plan 5.2, 5.15, risk 18).

Pure python: the synthesizer is a fake, the clock is manual, the disk is a temporary
directory.  What a real Sarvam round trip does is pinned separately, against the installed
SDK, in ``test_r1_sdk_contract``.
"""
from __future__ import annotations

import ast
import asyncio
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_linecache
from r1_linecache import (
    LANE_R1,
    LineCache,
    LineSpec,
    PcmClip,
    RateLimitCounter,
    SarvamSynthesizer,
    SynthesisBucket,
    build_line_cache,
    line_cache_enabled,
    read_wav,
    status_of,
    synths_per_minute,
    write_wav,
)

RATE = 22050


class FakeTime:
    """A manual clock whose ``sleep`` advances it, so waits cost nothing and can be read back."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(round(seconds, 6))
        self.now += seconds


class RateLimited(Exception):
    def __init__(self, status_code: int = 429) -> None:
        super().__init__(f"status {status_code}")
        self.status_code = status_code


def clip(seconds: float = 0.1, *, rate: int = RATE, channels: int = 1, fill: int = 1) -> PcmClip:
    samples = int(rate * seconds) * channels
    data = bytes([fill % 256, 0]) * samples
    return PcmClip(data, rate, channels)


class FakeSynthesizer:
    """Records every text it is asked for and answers from a script."""

    def __init__(self, *script) -> None:
        self.script = list(script)
        self.texts: list[str] = []
        self.closed = 0

    async def __call__(self, text: str) -> PcmClip:
        self.texts.append(text)
        step = self.script.pop(0) if self.script else clip()
        if isinstance(step, BaseException):
            raise step
        if callable(step):
            return await step()
        return step

    async def aclose(self) -> None:
        self.closed += 1


class Events:
    def __init__(self) -> None:
        self.items: list[tuple] = []

    def __call__(self, kind: str, line_id: str, **detail) -> None:
        self.items.append((kind, line_id, detail))

    def kinds(self) -> list[str]:
        return [item[0] for item in self.items]

    def of(self, kind: str) -> list[tuple]:
        return [item for item in self.items if item[0] == kind]


def make_cache(
    synthesizer,
    *,
    directory: Path | None = None,
    per_minute: int = 600,
    events: Events | None = None,
    counter: RateLimitCounter | None = None,
    time_source: FakeTime | None = None,
    **options,
) -> tuple[LineCache, Events, RateLimitCounter, FakeTime]:
    source = time_source or FakeTime()
    seen = events or Events()
    count = counter or RateLimitCounter()
    bucket = SynthesisBucket(per_minute, burst=100, clock=source, sleep=source.sleep)
    cache = LineCache(
        synthesizer,
        voice={"model": "bulbul:v3", "speaker": "simran", "pace": 1.0, "temperature": 0.8},
        sample_rate=RATE,
        directory=directory,
        bucket=bucket,
        counter=count,
        on_event=seen,
        clock=source,
        jitter=lambda: 0.5,
        **options,
    )
    return cache, seen, count, source


class TestSynthesisBucket(unittest.IsolatedAsyncioTestCase):
    async def test_the_first_synthesis_is_immediate_and_the_rest_are_paced(self) -> None:
        source = FakeTime()
        bucket = SynthesisBucket(5, clock=source, sleep=source.sleep)  # one start every 12 s
        self.assertEqual(bucket.interval, 12.0)
        await bucket.acquire()
        self.assertEqual(source.slept, [])
        await bucket.acquire()
        await bucket.acquire()
        self.assertEqual(source.slept, [12.0, 12.0])

    async def test_a_minute_never_holds_more_than_the_rate_allows(self) -> None:
        source = FakeTime()
        bucket = SynthesisBucket(5, clock=source, sleep=source.sleep)
        starts = []
        for _ in range(11):
            await bucket.acquire()
            starts.append(source.now)
        for index, start in enumerate(starts):
            window = [s for s in starts[index:] if s - start < 60.0]
            self.assertLessEqual(len(window), 5)

    async def test_idle_time_refills_only_up_to_the_burst(self) -> None:
        source = FakeTime()
        bucket = SynthesisBucket(5, burst=2, clock=source, sleep=source.sleep)
        await bucket.acquire()
        await bucket.acquire()
        source.now += 3600  # an hour idle
        await bucket.acquire()
        await bucket.acquire()
        self.assertEqual(source.slept, [])  # two tokens were back
        await bucket.acquire()
        self.assertEqual(source.slept, [12.0])  # but only two

    async def test_a_429_closes_the_bucket_for_the_back_off(self) -> None:
        source = FakeTime()
        bucket = SynthesisBucket(60, clock=source, sleep=source.sleep)  # 1 s apart
        await bucket.acquire()
        bucket.penalize(30.0)
        await bucket.acquire()
        self.assertGreaterEqual(sum(source.slept), 30.0)

    async def test_a_penalty_never_shortens_a_longer_one(self) -> None:
        source = FakeTime()
        bucket = SynthesisBucket(60, clock=source, sleep=source.sleep)
        bucket.penalize(40.0)
        bucket.penalize(5.0)
        await bucket.acquire()
        self.assertGreaterEqual(sum(source.slept), 40.0)

    async def test_waiters_are_served_one_at_a_time(self) -> None:
        source = FakeTime()
        bucket = SynthesisBucket(5, clock=source, sleep=source.sleep)
        order = []

        async def take(name: str) -> None:
            await bucket.acquire()
            order.append((name, source.now))

        await asyncio.gather(take("a"), take("b"), take("c"))
        self.assertEqual([name for name, _ in order], ["a", "b", "c"])
        self.assertEqual([when for _, when in order], [1000.0, 1012.0, 1024.0])

    async def test_a_cancelled_waiter_does_not_wedge_the_bucket(self) -> None:
        source = FakeTime()
        gate = asyncio.Event()

        async def never_wakes(_seconds: float) -> None:
            await gate.wait()

        bucket = SynthesisBucket(5, clock=source, sleep=never_wakes)
        await bucket.acquire()
        waiting = asyncio.ensure_future(bucket.acquire())
        await asyncio.sleep(0.01)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        bucket._sleep = source.sleep
        await asyncio.wait_for(bucket.acquire(), 1.0)


class TestRateLimitCounter(unittest.TestCase):
    def test_429s_are_counted_by_lane_and_component(self) -> None:
        counter = RateLimitCounter()
        self.assertEqual(counter.record("r1", "tts"), 1)
        self.assertEqual(counter.record("r1", "tts"), 2)
        self.assertEqual(counter.record("r1", "llm"), 1)
        self.assertEqual(counter.record("phone", "tts"), 1)
        self.assertEqual(counter.count("r1"), 3)
        self.assertEqual(counter.count("r1", "tts"), 2)
        self.assertEqual(counter.count("phone"), 1)
        self.assertEqual(counter.count("nobody"), 0)
        self.assertEqual(
            counter.snapshot(), {"phone": {"tts": 1}, "r1": {"llm": 1, "tts": 2}}
        )

    def test_the_lane_r1_records_under_is_r1(self) -> None:
        self.assertEqual(LANE_R1, "r1")


class TestStatusOf(unittest.TestCase):
    def test_the_status_is_found_directly_and_through_the_cause(self) -> None:
        self.assertEqual(status_of(RateLimited(429)), 429)
        try:
            try:
                raise RateLimited(503)
            except RateLimited as inner:
                raise RuntimeError("wrapped") from inner
        except RuntimeError as outer:
            self.assertEqual(status_of(outer), 503)

    def test_no_status_is_none_and_a_bool_is_not_a_status(self) -> None:
        self.assertIsNone(status_of(RuntimeError("x")))
        self.assertIsNone(status_of(None))
        error = RuntimeError("x")
        error.status_code = True  # type: ignore[attr-defined]
        self.assertIsNone(status_of(error))


class TestPcmClip(unittest.IsolatedAsyncioTestCase):
    def test_a_clip_knows_its_length_and_whether_it_is_well_formed(self) -> None:
        self.assertAlmostEqual(clip(0.5).seconds, 0.5, places=3)
        self.assertTrue(clip(0.5).valid())
        self.assertFalse(PcmClip(b"", RATE).valid())
        self.assertFalse(PcmClip(b"\x00\x00\x00", RATE).valid())  # an odd byte count
        self.assertFalse(PcmClip(b"\x00\x00", 0).valid())
        self.assertFalse(PcmClip(b"\x00\x00", RATE, 3).valid())

    async def test_frames_are_twenty_milliseconds_and_cover_the_clip_exactly(self) -> None:
        built = []

        def make(data, rate, channels, samples):
            built.append((len(data), rate, channels, samples))
            return ("frame", len(data))

        source = clip(0.105)  # 2315 samples: five 441-sample frames and a short tail
        frames = [frame async for frame in source.frames(make)]
        self.assertEqual(len(frames), 6)
        self.assertEqual(built[0], (882, RATE, 1, 441))
        self.assertEqual(built[-1][3], 2315 - 5 * 441)
        self.assertEqual(sum(size for size, *_ in built), len(source.pcm))

    async def test_stereo_samples_are_counted_per_channel(self) -> None:
        built = []

        def make(data, rate, channels, samples):
            built.append((len(data), samples))
            return None

        source = clip(0.02, channels=2)
        _ = [frame async for frame in source.frames(make)]
        self.assertEqual(built, [(len(source.pcm), len(source.pcm) // 4)])


class TestWavFiles(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.directory = Path(self._directory.name)

    def test_a_clip_round_trips(self) -> None:
        source = clip(0.25, fill=7)
        path = self.directory / "nested" / "a.wav"
        write_wav(path, source)
        self.assertEqual(read_wav(path, RATE, 1, 90.0), source)
        self.assertEqual([p.name for p in path.parent.iterdir()], ["a.wav"])  # no temp file left

    def test_a_clip_in_another_format_is_refused(self) -> None:
        path = self.directory / "a.wav"
        write_wav(path, clip(0.25))
        self.assertIsNone(read_wav(path, 16000, 1, 90.0))  # another sample rate
        self.assertIsNone(read_wav(path, RATE, 2, 90.0))  # another channel count

    def test_a_clip_longer_than_the_bound_is_refused(self) -> None:
        path = self.directory / "a.wav"
        write_wav(path, clip(2.0))
        self.assertIsNone(read_wav(path, RATE, 1, 1.0))

    def test_garbage_and_truncated_files_are_refused(self) -> None:
        garbage = self.directory / "garbage.wav"
        garbage.write_bytes(b"not a wav file at all")
        self.assertIsNone(read_wav(garbage, RATE, 1, 90.0))
        empty = self.directory / "empty.wav"
        empty.write_bytes(b"")
        self.assertIsNone(read_wav(empty, RATE, 1, 90.0))
        whole = self.directory / "whole.wav"
        write_wav(whole, clip(0.25))
        truncated = self.directory / "truncated.wav"
        truncated.write_bytes(whole.read_bytes()[:-500])
        self.assertIsNone(read_wav(truncated, RATE, 1, 90.0))

    def test_eight_bit_audio_is_refused(self) -> None:
        path = self.directory / "eight.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(1)
            handle.setframerate(RATE)
            handle.writeframes(b"\x80" * 1000)
        self.assertIsNone(read_wav(path, RATE, 1, 90.0))


class TestLineCacheWarm(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.directory = Path(self._directory.name)

    SPECS = (
        LineSpec("L-EXIT", "Let's pause the role-play here.", True),
        LineSpec("L-CLOSE", "Thank you for your time today, Asha.", False),
    )

    async def test_lines_are_synthesised_in_order_and_found_by_their_exact_text(self) -> None:
        synth = FakeSynthesizer()
        cache, events, _, _ = make_cache(synth, directory=self.directory)
        self.assertIsNone(cache.lookup(self.SPECS[0].text))
        stats = await cache.warm(self.SPECS)
        self.assertEqual(synth.texts, [spec.text for spec in self.SPECS])
        self.assertEqual(stats, {"memory": 0, "disk": 0, "synthesized": 2, "failed": 0})
        for spec in self.SPECS:
            self.assertIsNotNone(cache.lookup(spec.text))
        self.assertIsNone(cache.lookup(self.SPECS[0].text + " "))  # exact text only
        self.assertEqual(events.kinds(), ["synth_ok", "synth_ok", "warm_done"])
        self.assertEqual(events.of("warm_done")[0][2]["count"], 2)
        self.assertEqual(cache.size, 2)

    async def test_only_a_candidate_free_line_is_written_to_disk(self) -> None:
        cache, *_ = make_cache(FakeSynthesizer(), directory=self.directory)
        await cache.warm(self.SPECS)
        files = sorted(self.directory.glob("*.wav"))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].name, f"{cache.key(self.SPECS[0].text)}.wav")
        self.assertFalse((self.directory / f"{cache.key(self.SPECS[1].text)}.wav").exists())

    async def test_a_second_machine_run_reads_the_disk_instead_of_synthesising(self) -> None:
        first, *_ = make_cache(FakeSynthesizer(), directory=self.directory)
        await first.warm(self.SPECS)
        synth = FakeSynthesizer()
        second, events, _, _ = make_cache(synth, directory=self.directory)
        stats = await second.warm(self.SPECS)
        self.assertEqual(synth.texts, [self.SPECS[1].text])  # only the named line again
        self.assertEqual(stats["disk"], 1)
        self.assertEqual(events.kinds(), ["disk_hit", "synth_ok", "warm_done"])
        self.assertEqual(second.lookup(self.SPECS[0].text), first.lookup(self.SPECS[0].text))

    async def test_a_line_already_warm_is_not_synthesised_twice(self) -> None:
        synth = FakeSynthesizer()
        cache, *_ = make_cache(synth, directory=self.directory)
        await cache.warm(self.SPECS)
        stats = await cache.warm(self.SPECS)
        self.assertEqual(stats["memory"], 2)
        self.assertEqual(len(synth.texts), 2)

    async def test_the_key_depends_on_the_text_and_on_the_voice(self) -> None:
        cache, *_ = make_cache(FakeSynthesizer())
        other = LineCache(
            FakeSynthesizer(),
            voice={"model": "bulbul:v3", "speaker": "shubh", "pace": 1.0, "temperature": 0.8},
            sample_rate=RATE,
        )
        rate = LineCache(
            FakeSynthesizer(),
            voice={"model": "bulbul:v3", "speaker": "simran", "pace": 1.0, "temperature": 0.8},
            sample_rate=16000,
        )
        self.assertEqual(cache.key("a line"), cache.key("a line"))
        self.assertNotEqual(cache.key("a line"), cache.key("another line"))
        self.assertNotEqual(cache.key("a line"), other.key("a line"))
        self.assertNotEqual(cache.key("a line"), rate.key("a line"))

    async def test_a_corrupt_file_is_a_miss_that_is_removed_and_rebuilt(self) -> None:
        cache, events, _, _ = make_cache(FakeSynthesizer(), directory=self.directory)
        path = self.directory / f"{cache.key(self.SPECS[0].text)}.wav"
        path.write_bytes(b"corrupt")
        synth = FakeSynthesizer()
        rebuilt, events, _, _ = make_cache(synth, directory=self.directory)
        await rebuilt.warm(self.SPECS[:1])
        self.assertEqual(events.kinds(), ["disk_corrupt", "synth_ok", "warm_done"])
        self.assertEqual(synth.texts, [self.SPECS[0].text])
        self.assertIsNotNone(read_wav(path, RATE, 1, 90.0))  # the rebuilt clip replaced it

    async def test_a_disk_that_cannot_be_written_still_serves_the_clip_from_memory(self) -> None:
        blocker = self.directory / "not-a-directory"
        blocker.write_bytes(b"a file where the cache directory should be")
        cache, events, _, _ = make_cache(FakeSynthesizer(), directory=blocker / "cache")
        await cache.warm(self.SPECS[:1])
        self.assertIsNotNone(cache.lookup(self.SPECS[0].text))
        self.assertEqual(events.of("disk_write_failed")[0][2]["error"][-5:], "Error")

    async def test_a_full_cache_directory_stops_writing_but_not_serving(self) -> None:
        for number in range(3):
            write_wav(self.directory / f"old{number}.wav", clip(0.05))
        cache, events, _, _ = make_cache(
            FakeSynthesizer(), directory=self.directory, max_files=3
        )
        await cache.warm(self.SPECS[:1])
        self.assertIn("disk_full", events.kinds())
        self.assertIsNotNone(cache.lookup(self.SPECS[0].text))
        self.assertEqual(len(list(self.directory.glob("*.wav"))), 3)

    async def test_without_a_directory_nothing_touches_the_disk(self) -> None:
        cache, events, _, _ = make_cache(FakeSynthesizer(), directory=None)
        await cache.warm(self.SPECS)
        self.assertEqual(events.kinds(), ["synth_ok", "synth_ok", "warm_done"])

    async def test_a_clip_in_the_wrong_format_or_too_long_is_rejected(self) -> None:
        wrong_rate = clip(0.1, rate=16000)
        too_long = clip(2.0)
        empty = PcmClip(b"", RATE)
        cache, events, _, _ = make_cache(
            FakeSynthesizer(wrong_rate, too_long, empty, clip()),
            directory=self.directory,
            max_clip_seconds=1.0,
        )
        specs = [LineSpec(f"L-{n}", f"line number {n}", True) for n in range(4)]
        stats = await cache.warm(specs[:3])
        self.assertEqual(stats["failed"], 3)
        self.assertEqual(events.kinds().count("clip_rejected"), 3)
        for spec in specs[:3]:
            self.assertIsNone(cache.lookup(spec.text))

    async def test_a_slow_synthesis_times_out_and_is_only_a_miss(self) -> None:
        async def hangs() -> PcmClip:
            await asyncio.Event().wait()
            return clip()

        cache, events, _, _ = make_cache(
            FakeSynthesizer(hangs), directory=self.directory, synth_timeout=0.01
        )
        stats = await cache.warm(self.SPECS[:1])
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(events.of("synth_failed")[0][2]["error"], "TimeoutError")

    async def test_a_failing_synthesis_is_a_miss_and_the_next_line_still_runs(self) -> None:
        synth = FakeSynthesizer(RuntimeError("provider is down"))
        cache, events, _, _ = make_cache(synth, directory=self.directory)
        stats = await cache.warm(self.SPECS)
        self.assertEqual((stats["failed"], stats["synthesized"]), (1, 1))
        self.assertEqual(events.of("synth_failed")[0][2]["error"], "RuntimeError")
        self.assertIsNone(cache.lookup(self.SPECS[0].text))
        self.assertIsNotNone(cache.lookup(self.SPECS[1].text))

    async def test_three_failures_in_a_row_abort_the_warm_up(self) -> None:
        synth = FakeSynthesizer(*[RuntimeError("down")] * 5)
        cache, events, _, _ = make_cache(synth, directory=self.directory)
        specs = [LineSpec(f"L-{n}", f"line number {n}", True) for n in range(5)]
        await cache.warm(specs)
        self.assertEqual(len(synth.texts), 3)
        self.assertIn("warm_aborted", events.kinds())

    async def test_a_success_resets_the_run_of_failures(self) -> None:
        synth = FakeSynthesizer(
            RuntimeError("x"), RuntimeError("x"), clip(), RuntimeError("x"), RuntimeError("x"), clip()
        )
        cache, events, _, _ = make_cache(synth, directory=self.directory)
        specs = [LineSpec(f"L-{n}", f"line number {n}", True) for n in range(6)]
        stats = await cache.warm(specs)
        self.assertEqual((stats["failed"], stats["synthesized"]), (4, 2))
        self.assertNotIn("warm_aborted", events.kinds())

    async def test_cancelling_the_warm_up_is_not_swallowed(self) -> None:
        gate = asyncio.Event()

        async def blocks() -> PcmClip:
            await gate.wait()
            return clip()

        cache, *_ = make_cache(FakeSynthesizer(blocks), directory=self.directory)
        task = asyncio.ensure_future(cache.warm(self.SPECS))
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_a_broken_event_sink_never_disturbs_the_cache(self) -> None:
        def broken(*_args, **_kwargs) -> None:
            raise RuntimeError("sink bug")

        cache, *_ = make_cache(FakeSynthesizer(), directory=self.directory)
        cache.listen(broken)
        await cache.warm(self.SPECS)
        self.assertEqual(cache.size, 2)

    async def test_an_empty_cache_is_still_truthy(self) -> None:
        # Callers test ``is not None``; a cache that defined ``__len__`` would read as False
        # until its first line was warm and be silently skipped by any ``if cache:``.
        cache, *_ = make_cache(FakeSynthesizer())
        self.assertEqual(cache.size, 0)
        self.assertTrue(cache)

    async def test_closing_the_cache_closes_the_synthesizer(self) -> None:
        synth = FakeSynthesizer()
        cache, *_ = make_cache(synth)
        await cache.aclose()
        self.assertEqual(synth.closed, 1)


class TestRateLimitedSynthesis(unittest.IsolatedAsyncioTestCase):
    SPEC = LineSpec("L-EXIT", "Let's pause the role-play here.", False)

    async def test_a_429_is_counted_backed_off_and_retried(self) -> None:
        synth = FakeSynthesizer(RateLimited(429), clip())
        cache, events, counter, source = make_cache(synth, per_minute=60)
        stats = await cache.warm([self.SPEC])
        self.assertEqual(stats["synthesized"], 1)
        self.assertEqual(len(synth.texts), 2)
        self.assertEqual(counter.count(LANE_R1, "tts"), 1)
        limited = events.of("rate_limited")
        self.assertEqual(len(limited), 1)
        self.assertEqual(limited[0][2]["count"], 1)
        # attempt 0: base 5 s * (0.5 + jitter 0.5) = 5 s of back-off before the retry.
        self.assertEqual(limited[0][2]["seconds"], 5.0)
        self.assertGreaterEqual(sum(source.slept), 5.0)

    async def test_the_back_off_grows_and_is_capped(self) -> None:
        cache, *_ = make_cache(FakeSynthesizer())
        self.assertEqual([cache._backoff(n) for n in range(5)], [5.0, 10.0, 20.0, 40.0, 60.0])

    async def test_three_429s_give_up_on_the_line_and_all_three_are_counted(self) -> None:
        synth = FakeSynthesizer(RateLimited(), RateLimited(), RateLimited())
        cache, events, counter, _ = make_cache(synth, per_minute=60)
        stats = await cache.warm([self.SPEC])
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(counter.count(LANE_R1, "tts"), 3)
        self.assertEqual(events.kinds().count("rate_limited"), 3)
        self.assertIn("gave_up", events.kinds())
        self.assertIsNone(cache.lookup(self.SPEC.text))

    async def test_another_status_is_a_failure_not_a_429(self) -> None:
        synth = FakeSynthesizer(RateLimited(500))
        cache, events, counter, _ = make_cache(synth)
        await cache.warm([self.SPEC])
        self.assertEqual(counter.count(LANE_R1), 0)
        self.assertEqual(events.kinds()[0], "synth_failed")

    async def test_the_counter_can_be_shared_across_caches(self) -> None:
        counter = RateLimitCounter()
        for _ in range(2):
            cache, *_ = make_cache(FakeSynthesizer(RateLimited(), clip()), counter=counter)
            await cache.warm([self.SPEC])
        self.assertEqual(counter.count(LANE_R1, "tts"), 2)

    async def test_a_penalty_slows_the_lines_that_follow(self) -> None:
        synth = FakeSynthesizer(RateLimited(), clip(), clip())
        cache, _, _, source = make_cache(synth, per_minute=60)
        await cache.warm([LineSpec("A", "line a", False), LineSpec("B", "line b", False)])
        self.assertGreaterEqual(sum(source.slept), 5.0)


class TestSarvamSynthesizer(unittest.IsolatedAsyncioTestCase):
    async def test_a_line_is_collected_into_one_clip_from_its_own_tts(self) -> None:
        frame = SimpleNamespace(data=memoryview(bytearray(b"\x01\x00" * 100)).cast("h"), sample_rate=RATE, num_channels=1)
        built = []

        class FakeStream:
            closed = 0

            async def collect(self):
                return frame

            async def aclose(self):
                FakeStream.closed += 1

        class FakeTts:
            closed = 0

            def synthesize(self, text, **kwargs):
                built.append((text, kwargs))
                return FakeStream()

            async def aclose(self):
                FakeTts.closed += 1

        synthesizer = SarvamSynthesizer(
            {"model": "bulbul:v3"}, factory=lambda kwargs: built.append(kwargs) or FakeTts()
        )
        result = await synthesizer("Hello there.")
        self.assertEqual(result, PcmClip(b"\x01\x00" * 100, RATE, 1))
        self.assertEqual(built[0], {"model": "bulbul:v3"})  # the voice settings reached the TTS
        self.assertEqual(built[1][0], "Hello there.")
        self.assertEqual(FakeStream.closed, 1)
        await synthesizer("Again.")
        self.assertEqual(len([b for b in built if isinstance(b, dict)]), 1)  # built once
        await synthesizer.aclose()
        self.assertEqual(FakeTts.closed, 1)

    async def test_a_failed_synthesis_still_closes_the_stream_and_raises(self) -> None:
        class FakeStream:
            closed = 0

            async def collect(self):
                raise RateLimited(429)

            async def aclose(self):
                FakeStream.closed += 1

        class FakeTts:
            def synthesize(self, text, **kwargs):
                return FakeStream()

        synthesizer = SarvamSynthesizer({}, factory=lambda kwargs: FakeTts())
        with self.assertRaises(RateLimited):
            await synthesizer("x")
        self.assertEqual(FakeStream.closed, 1)


class TestBuildLineCache(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ("R1_LINE_CACHE", "R1_SYNTH_PER_MIN", "SARVAM_TTS_VOICE", "SARVAM_TTS_MODEL"):
            os.environ.pop(key, None)

    @staticmethod
    def session(rate=RATE, channels=1):
        return SimpleNamespace(tts=SimpleNamespace(sample_rate=rate, num_channels=channels))

    def factory(self, kwargs):
        self.seen = dict(kwargs)
        return FakeSynthesizer()

    def test_a_session_with_a_real_tts_gets_a_cache_in_its_audio_format(self) -> None:
        cache = build_line_cache(self.session(24000, 1), synthesizer_factory=self.factory)
        self.assertIsNotNone(cache)
        self.assertEqual((cache.sample_rate, cache.channels), (24000, 1))
        self.assertEqual(
            self.seen, {"model": "bulbul:v3", "speaker": "simran", "pace": 1.0, "temperature": 0.8}
        )

    def test_the_cache_is_off_when_the_switch_says_so(self) -> None:
        for value in ("off", "OFF", " 0 ", "false", "no"):
            with self.subTest(value=value):
                os.environ["R1_LINE_CACHE"] = value
                self.assertFalse(line_cache_enabled())
                self.assertIsNone(build_line_cache(self.session(), synthesizer_factory=self.factory))
        for value in ("on", "", "yes", "anything"):
            with self.subTest(value=value):
                os.environ["R1_LINE_CACHE"] = value
                self.assertTrue(line_cache_enabled())

    def test_a_session_without_a_tts_format_gets_no_cache(self) -> None:
        for session in (
            SimpleNamespace(),
            SimpleNamespace(tts=None),
            SimpleNamespace(tts=SimpleNamespace()),
            self.session(rate="22050"),
            self.session(rate=True),
            self.session(channels=None),
        ):
            with self.subTest(session=session):
                self.assertIsNone(build_line_cache(session, synthesizer_factory=self.factory))

    def test_the_request_budget_is_bounded(self) -> None:
        self.assertEqual(synths_per_minute(), 5)
        for raw, expected in {"12": 12, "0": 1, "-3": 1, "999": 30, "x": 5, "": 5, "1.5": 5}.items():
            with self.subTest(raw=raw):
                os.environ["R1_SYNTH_PER_MIN"] = raw
                self.assertEqual(synths_per_minute(), expected)


class TestModuleSurface(unittest.TestCase):
    def test_the_module_imports_no_phone_session_or_sdk_code_at_import_time(self) -> None:
        tree = ast.parse(Path(r1_linecache.__file__).read_text(encoding="utf-8"))
        top_level = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                top_level.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                top_level.add((node.module or "").split(".")[0])
        self.assertTrue(top_level.isdisjoint({"phone", "agent", "livekit", "r1_session"}))
        self.assertIn("r1_script", top_level)


if __name__ == "__main__":
    unittest.main()
