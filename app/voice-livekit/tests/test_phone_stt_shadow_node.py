"""M015 PR-1: the stt_node tee and the on-vs-off byte-identical guarantee.

`phone.phone_agent_class(Base, stt_shadow=...)` installs an `stt_node` override
ONLY when a shadow is passed. These tests drive it over a fake base whose
`stt_node` is an async generator, in four socket modes (healthy, slow, broken,
garbage), and assert the frames the base receives and the events it yields are
the SAME OBJECTS in the SAME ORDER, with no added wall time. Synthetic data only.
"""

from __future__ import annotations

import asyncio
import time
import types
import unittest

import phone
import phone_stt_shadow as pss

from tests.test_phone_stt_shadow import (
    Clock, Frame, FakeWs, PassResampler, SENTINELS, make_shadow, settle,
)

N_FRAMES = 300


class Base:
    """A stand-in for the SDK ``Agent``: an overridable async-generator stt_node."""

    def __init__(self, instructions=""):
        self.instructions = instructions

    async def stt_node(self, audio, model_settings):
        raise NotImplementedError


def make_base(received: list, events: list, closed: list):
    class FakeBase(Base):
        async def stt_node(self, audio, model_settings):
            try:
                n = 0
                async for frame in audio:
                    received.append(frame)
                    n += 1
                    if n % 50 == 0:
                        yield events[n // 50 - 1]
                for ev in events[(n // 50):]:
                    yield ev
            finally:
                closed.append(True)

    return FakeBase


def scripted_events():
    final = types.SimpleNamespace(
        type=types.SimpleNamespace(value="final_transcript"),
        alternatives=[types.SimpleNamespace(text=SENTINELS[0] + " two three")])
    return [
        types.SimpleNamespace(type=types.SimpleNamespace(value="start_of_speech")),
        types.SimpleNamespace(type=types.SimpleNamespace(value="interim_transcript"),
                              alternatives=[types.SimpleNamespace(text=SENTINELS[1])]),
        final,
        types.SimpleNamespace(type=types.SimpleNamespace(value="recognition_usage")),
        types.SimpleNamespace(type=types.SimpleNamespace(value="end_of_speech")),
        types.SimpleNamespace(type=types.SimpleNamespace(value="final_transcript"),
                              alternatives=[]),
    ]


async def audio_source(frames, hook=None):
    for i, f in enumerate(frames):
        if hook:
            hook(i)
        yield f
        if i % 20 == 0:
            await asyncio.sleep(0)


async def run_node(cls, frames, hook=None):
    agent = object.__new__(cls)
    out = []
    t0 = time.perf_counter()
    node = cls.stt_node(agent, audio_source(frames, hook), None)
    if asyncio.iscoroutine(node):
        node = await node
    async for ev in node:
        out.append(ev)
    return out, time.perf_counter() - t0


def phone_cls(base, shadow=None):
    return phone.phone_agent_class(base, stt_shadow=shadow) if shadow is not None \
        else phone.phone_agent_class(base)


class TestClassShape(unittest.TestCase):
    def test_off_is_byte_identical_at_class_level(self):
        a = phone.phone_agent_class(Base)
        b = phone.phone_agent_class(Base, stt_shadow=None)
        for cls in (a, b):
            self.assertNotIn("stt_node", vars(cls))
            self.assertIs(cls.stt_node, Base.stt_node)
        self.assertEqual(sorted(vars(a)), sorted(vars(b)))

    def test_a_shadow_adds_only_stt_node(self):
        off = phone.phone_agent_class(Base)
        shadow, *_ = make_shadow(FakeWs())
        on = phone.phone_agent_class(Base, stt_shadow=shadow)
        self.assertEqual(set(vars(on)) - set(vars(off)), {"stt_node"})
        self.assertEqual(set(vars(off)) - set(vars(on)), set())
        self.assertIsNot(on.stt_node, Base.stt_node)

    def test_install_failure_leaves_the_class_untouched(self):
        class NoSttBase:
            def __init__(self, instructions=""):
                pass

        shadow, *_ = make_shadow(FakeWs())
        cls = phone.phone_agent_class(NoSttBase, stt_shadow=shadow)
        self.assertNotIn("stt_node", vars(cls))

    def test_the_override_is_a_plain_def_returning_an_async_iterable(self):
        import inspect
        shadow, *_ = make_shadow(FakeWs())
        cls = phone.phone_agent_class(Base, stt_shadow=shadow)
        self.assertFalse(inspect.iscoroutinefunction(vars(cls)["stt_node"]))


class TestByteIdentical(unittest.IsolatedAsyncioTestCase):
    async def _run(self, shadow=None, hook=None):
        received, closed = [], []
        events = scripted_events()
        cls = phone_cls(make_base(received, events, closed), shadow)
        frames = [Frame() for _ in range(N_FRAMES)]
        out, took = await run_node(cls, frames, hook)
        return frames, received, events, out, closed, took

    def _assert_same(self, frames, received, events, out, closed):
        self.assertEqual(len(received), N_FRAMES)
        self.assertTrue(all(a is b for a, b in zip(frames, received)))
        self.assertEqual(len(out), len(events))
        self.assertTrue(all(a is b for a, b in zip(events, out)))
        self.assertEqual(closed, [True])

    async def test_off_baseline(self):
        self._assert_same(*(await self._run())[:5])

    async def _on_mode(self, ws=None, factory=None, arm_at=None):
        flag = [arm_at is None]

        def hook(i):
            if arm_at is not None and i == arm_at:
                flag[0] = True

        shadow, rec, *_ = make_shadow(ws, armed=flag, factory=factory)
        off = await self._run()
        on = await self._run(shadow, hook)
        self._assert_same(*on[:5])
        self.assertLess(on[5], off[5] + 0.05)
        await settle(0.05)
        return shadow, rec

    async def test_on_healthy_socket(self):
        ws = FakeWs()
        shadow, rec = await self._on_mode(ws)
        self.assertGreater(shadow.counters["frames_offered"], 0)
        self.assertTrue(shadow._closed)

    async def test_on_armed_mid_stream(self):
        ws = FakeWs()
        shadow, rec = await self._on_mode(ws, arm_at=150)
        self.assertLessEqual(shadow.counters["frames_offered"], N_FRAMES - 150)

    async def test_on_slow_socket_never_returning_sends(self):
        ws = FakeWs(hang_send=True)
        shadow, rec = await self._on_mode(ws)
        self.assertGreater(shadow.counters["frames_dropped"] + shadow.counters["frames_offered"], 0)

    async def test_on_broken_socket(self):
        async def factory(url, headers):
            raise ConnectionError(SENTINELS[0])

        shadow, rec = await self._on_mode(factory=factory)
        self.assertEqual(shadow.counters["unrecovered_death"], 1)

    async def test_on_garbage_socket(self):
        ws = FakeWs([pss.SocketMessage(pss.MSG_TEXT, "not json " + SENTINELS[0]),
                     pss.SocketMessage(pss.MSG_BINARY, None)] * 20)
        shadow, rec = await self._on_mode(ws)
        self.assertGreater(shadow.counters["rt_unparsed"], 0)

    async def test_main_final_reaches_the_tracker_as_a_word_count(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        received, closed = [], []
        cls = phone_cls(make_base(received, scripted_events(), closed), shadow)
        shadow.on_local_vad("start")            # ignored: not armed yet
        await run_node(cls, [Frame() for _ in range(N_FRAMES)])
        self.assertEqual(shadow.counters["main_finals"], 2)
        self.assertEqual(shadow.counters["main_finals_empty"], 1)


class TestFaultsInTheTap(unittest.IsolatedAsyncioTestCase):
    async def test_faults_never_propagate_and_sequences_are_unchanged(self):
        shadow, *_ = make_shadow(FakeWs())

        def boom(*a, **k):
            raise RuntimeError(SENTINELS[0])

        shadow.offer = boom
        shadow.observe_main = boom
        shadow.close_nowait = boom
        received, closed = [], []
        events = scripted_events()
        cls = phone_cls(make_base(received, events, closed), shadow)
        frames = [Frame() for _ in range(N_FRAMES)]
        out, _ = await run_node(cls, frames)
        self.assertTrue(all(a is b for a, b in zip(frames, received)))
        self.assertEqual(len(received), N_FRAMES)
        self.assertTrue(all(a is b for a, b in zip(events, out)))
        self.assertEqual(closed, [True])


class _Spy:
    def __init__(self):
        self.closes = 0
        self.frames = 0
        self.events = 0

    def offer(self, f):
        self.frames += 1

    def observe_main(self, e):
        self.events += 1

    def close_nowait(self):
        self.closes += 1


class TestLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_cancelling_the_consumer_closes_the_inner_node_and_the_shadow(self):
        spy = _Spy()
        received, closed = [], []

        class SlowBase(Base):
            async def stt_node(self, audio, model_settings):
                try:
                    async for frame in audio:
                        received.append(frame)
                        yield types.SimpleNamespace(type="x")
                        await asyncio.sleep(0.01)
                finally:
                    closed.append(True)

        cls = phone.phone_agent_class(SlowBase, stt_shadow=spy)
        agent = object.__new__(cls)

        async def consume():
            async for _ in cls.stt_node(agent, audio_source([Frame() for _ in range(1000)]), None):
                pass

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(closed, [True])
        self.assertEqual(spy.closes, 1)

    async def test_aclose_on_the_outer_generator_closes_the_inner_node(self):
        spy = _Spy()
        closed = []

        class B(Base):
            async def stt_node(self, audio, model_settings):
                try:
                    async for _ in audio:
                        yield types.SimpleNamespace(type="x")
                finally:
                    closed.append(True)

        cls = phone.phone_agent_class(B, stt_shadow=spy)
        gen = cls.stt_node(object.__new__(cls), audio_source([Frame() for _ in range(10)]), None)
        await gen.__anext__()
        await gen.aclose()
        self.assertEqual(closed, [True])
        self.assertEqual(spy.closes, 1)

    async def test_normal_end_closes_once(self):
        spy = _Spy()
        cls = phone.phone_agent_class(make_base([], scripted_events(), []), stt_shadow=spy)
        await run_node(cls, [Frame() for _ in range(60)])
        self.assertEqual(spy.closes, 1)
        self.assertEqual(spy.frames, 60)

    async def test_base_returning_a_coroutine_or_none(self):
        spy = _Spy()
        ev = types.SimpleNamespace(type="x")

        async def agen():
            yield ev

        class CoroBase(Base):
            def stt_node(self, audio, model_settings):
                async def go():
                    return agen()
                return go()

        class NoneBase(Base):
            def stt_node(self, audio, model_settings):
                async def go():
                    return None
                return go()

        out, _ = await run_node(phone.phone_agent_class(CoroBase, stt_shadow=spy), [Frame()])
        self.assertEqual(out, [ev])
        out, _ = await run_node(phone.phone_agent_class(NoneBase, stt_shadow=spy), [Frame()])
        self.assertEqual(out, [])
        self.assertEqual(spy.closes, 2)


if __name__ == "__main__":
    unittest.main()
