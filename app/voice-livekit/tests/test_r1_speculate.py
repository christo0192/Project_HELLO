import ast
import asyncio
import unittest
from pathlib import Path

from r1_speculate import MAX_CHUNKS, SpeculationUnusable, SpeculativeReply, messages_equivalent


class Stream:
    def __init__(self, close_error=False):
        self.queue = asyncio.Queue()
        self.closed = 0
        self.close_error = close_error

    def feed(self, *items):
        for item in items:
            self.queue.put_nowait(item)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is StopAsyncIteration:
            raise StopAsyncIteration
        if isinstance(item, Exception):
            raise item
        return item

    async def aclose(self):
        self.closed += 1
        if self.close_error:
            raise ValueError("close")


async def wait_for(predicate):
    for _ in range(1000):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition not reached")


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_buffer_and_live(self):
        stream = Stream()
        stream.feed(1, 2)
        reply = SpeculativeReply(0, "hello")
        reply.start(lambda _: stream, [], lambda: 10)
        await wait_for(lambda: len(reply.chunks) == 2)
        received = []

        async def consume():
            async for chunk in reply.replay():
                received.append(chunk)

        task = asyncio.create_task(consume())
        await wait_for(lambda: len(received) == 2)
        stream.feed(3, 4, StopAsyncIteration)
        await task
        self.assertEqual(received, [1, 2, 3, 4])
        self.assertEqual(stream.closed, 1)
        with self.assertRaises(RuntimeError):
            async for _ in reply.replay():
                pass

    async def test_cancel_and_close(self):
        stream = Stream(close_error=True)
        reply = SpeculativeReply(0, "")
        reply.start(lambda _: stream, [], lambda: 0)
        await asyncio.sleep(0)
        reply.cancel()
        reply.cancel()
        await reply.aclose()
        await reply.aclose()
        self.assertEqual(stream.closed, 1)
        with self.assertRaises(SpeculationUnusable):
            async for _ in reply.replay():
                pass

    async def test_cancel_after_buffering_discards_chunks(self):
        stream = Stream()
        stream.feed(1, 2, StopAsyncIteration)
        reply = SpeculativeReply(0, "")
        reply.start(lambda _: stream, [], lambda: 0)
        await wait_for(lambda: reply.done)
        reply.cancel()
        seen = []
        with self.assertRaises(SpeculationUnusable):
            async for chunk in reply.replay():
                seen.append(chunk)
        self.assertEqual(seen, [])

    async def test_cancel_wakes_live_replay(self):
        stream = Stream()
        stream.feed(1)
        reply = SpeculativeReply(0, "")
        reply.start(lambda _: stream, [], lambda: 0)
        seen = []

        async def consume():
            async for chunk in reply.replay():
                seen.append(chunk)

        task = asyncio.create_task(consume())
        await wait_for(lambda: len(seen) == 1)
        await asyncio.sleep(0)
        reply.cancel()
        with self.assertRaises(SpeculationUnusable):
            await asyncio.wait_for(task, 1)
        self.assertEqual(seen, [1])
        await reply.aclose()

    async def test_closes_separate_iterator_and_iterable(self):
        class Iterable:
            def __init__(self):
                self.iterator = Stream(close_error=True)
                self.iterator.feed(StopAsyncIteration)
                self.closed = 0

            def __aiter__(self):
                return self.iterator

            async def aclose(self):
                self.closed += 1
                raise ValueError("iterable close")

        iterable = Iterable()
        reply = SpeculativeReply(0, "")
        reply.start(lambda _: iterable, [], lambda: 0)
        await wait_for(lambda: reply.done)
        self.assertEqual(iterable.iterator.closed, 1)
        self.assertEqual(iterable.closed, 1)
        self.assertEqual([x async for x in reply.replay()], [])

    async def test_iterator_without_aclose(self):
        class Iterator:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        reply = SpeculativeReply(0, "")
        reply.start(lambda _: Iterator(), [], lambda: 0)
        await wait_for(lambda: reply.done)
        self.assertEqual([x async for x in reply.replay()], [])

    async def test_errors(self):
        for chunks in ([], ["first"]):
            stream = Stream()
            error = ValueError("broken")
            stream.feed(*chunks, error)
            reply = SpeculativeReply(0, "")
            reply.start(lambda _: stream, [], lambda: 0)
            await wait_for(lambda: reply.done)
            seen = []
            with self.assertRaises(ValueError if chunks else SpeculationUnusable) as caught:
                async for chunk in reply.replay():
                    seen.append(chunk)
            self.assertEqual(seen, chunks)
            self.assertIs(caught.exception if chunks else caught.exception.__cause__, error)

    async def test_bound_and_awaitable_runner(self):
        stream = Stream()
        stream.feed(*range(MAX_CHUNKS + 50))

        async def runner(_):
            return stream

        reply = SpeculativeReply(0, "")
        reply.start(runner, [], lambda: 0)
        await wait_for(lambda: reply.done)
        self.assertTrue(reply.truncated)
        self.assertEqual(stream.closed, 1)
        self.assertEqual([x async for x in reply.replay()], list(range(MAX_CHUNKS)))
        self.assertEqual(stream.queue.qsize(), 50)

    async def test_start_copy_and_clock(self):
        stream = Stream()
        reply = SpeculativeReply(1, "key")
        self.assertEqual(reply.head_start(15), 0)
        messages = [{"role": "user", "content": "R=08:20"}]
        reply.start(lambda _: stream, messages, lambda: 10)
        messages[0]["content"] = "changed"
        self.assertTrue(reply.matches([{"role": "user", "content": "R=08:21"}]))
        self.assertEqual(reply.head_start(15), 5)
        self.assertEqual(reply.head_start(5), 0)
        with self.assertRaises(RuntimeError):
            reply.start(lambda _: stream, messages, lambda: 0)
        await reply.aclose()


class EquivalenceTests(unittest.TestCase):
    def test_comparisons(self):
        def msg(text):
            return [{"role": "user", "content": text}]

        pairs = [("R=08:20", "R=08:21", True), ("R=08:20", "R=08:23", False),
                 ("R=08:59", "R=09:00", True), ("R=61:05", "R=61:06", True),
                 ("CANDIDATE_MONOLOGUE=41", "CANDIDATE_MONOLOGUE=42", True),
                 ("CANDIDATE_MONOLOGUE=41", "CANDIDATE_MONOLOGUE=44", False),
                 ("CANDIDATE_MONOLOGUE=41", "", False),
                 ("turn 7", "turn 8", False), ("time 08:20", "time 08:21", False),
                 ("R=08:20 R=09:00", "R=08:21 R=09:03", False),
                 ("price 3,999", "price 3,998", False), ("FOOR=08:20", "FOOR=08:21", False)]
        for a, b, expected in pairs:
            with self.subTest(a=a, b=b):
                self.assertEqual(messages_equivalent(msg(a), msg(b)), expected)
        self.assertTrue(messages_equivalent(msg("R=08:20"), msg("R=08:23"),
                                            clock_slack_sec=3))
        self.assertFalse(messages_equivalent(msg("CANDIDATE_MONOLOGUE=41"),
                                             msg("CANDIDATE_MONOLOGUE=42"),
                                             monologue_slack_sec=0))
        base = [{"role": "system", "content": "You are a learner."},
                {"role": "user", "content": "ROLEPLAY NOTE (not spoken). R=08:20. Price 3,999"}]
        self.assertTrue(messages_equivalent(base, base))
        for index, position in [(0, 2), (1, 5), (1, 20), (1, -1)]:
            changed = [dict(m) for m in base]
            text = changed[index]["content"]
            position %= len(text)
            changed[index]["content"] = text[:position] + "X" + text[position + 1:]
            self.assertFalse(messages_equivalent(base, changed))
        self.assertFalse(messages_equivalent(base, base[:-1]))
        self.assertFalse(messages_equivalent(base, [{"role": "assistant", "content": "x"}]))
        self.assertFalse(messages_equivalent([{}], [{}]))
        self.assertTrue(messages_equivalent(msg([1]), msg([1])))

    def test_real_reminder(self):
        import r1_prompts
        from r1_personas import resolve_persona

        persona = resolve_persona("p1_career_switcher", variant="v1")

        def reminder(seconds, monologue):
            return [{"role": "system", "content": r1_prompts.turn_reminder(
                persona, r_sec=seconds, monologue_sec=monologue)}]

        self.assertTrue(messages_equivalent(reminder(500, 70), reminder(501, 71)))
        self.assertFalse(messages_equivalent(reminder(500, 70), reminder(510, 70)))

    def test_imports_are_stdlib(self):
        source = Path(__file__).resolve().parents[1] / "r1_speculate.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                names.add(node.module)
        self.assertLessEqual(names, {"__future__", "asyncio", "contextlib", "dataclasses",
                                     "inspect",
                                     "re", "copy",
                                     "collections.abc",
                                     "time", "typing"})
