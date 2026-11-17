"""Pure, SDK-free speculative reply buffering for future T3c integration.

T3c will use this behind R1_SPECULATIVE_REPLY; nothing calls it yet. A speculative
stream is only replayed when messages_equivalent says the real prompt is the same.

The role-play clock also selects prompt text (r1_roleplay.py:3446, 3465), and
turn-dependent choices select text (r1_roleplay.py:6888-6897). Those changes are
NOT masked. No other per-turn clock, second count, turn counter, or timestamp is
rendered as a number in learner messages by r1_prompts.py, r1_replies.py, or
r1_roleplay.py; role-play r_sec values in metadata (e.g. r1_roleplay.py:3854)
are NOT masked if included in messages. The two reminder tokens are the only
exceptions to exact content comparison. r1_session.py was checked too: history
sequence counters (r1_session.py:6078, 9409) are metadata, not message content.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import re
from typing import Any, AsyncIterator, Awaitable, Callable, Mapping, Sequence

MAX_CHUNKS = 400
# Bound the cost of speculative calls: T3c enforces at most two starts per row,
# and after 150 starts in a session it uses only normal requests. This module
# declares the limits but does not enforce them.
SPEC_MAX_STARTS_PER_ROW = 2
SPEC_MAX_CALLS_PER_SESSION = 150

_TOKEN = re.compile(r"(?<!\w)R=(\d+):(\d{2})(?!\d)|(?<!\w)CANDIDATE_MONOLOGUE=(\d+)(?!\d)")


def _masked(content: str) -> tuple[list[str], list[tuple[str, int]]]:
    values = []
    segments = []
    end = 0
    for match in _TOKEN.finditer(content):
        segments.append(content[end:match.start()])
        end = match.end()
        if match.group(1) is not None:
            values.append(("clock", int(match.group(1)) * 60 + int(match.group(2))))
        else:
            values.append(("monologue", int(match.group(3))))
    segments.append(content[end:])
    return segments, values


def messages_equivalent(
    spec_msgs: Sequence[Mapping[str, Any]],
    real_msgs: Sequence[Mapping[str, Any]],
    *,
    clock_slack_sec: int = 2,
    monologue_slack_sec: int = 2,
) -> bool:
    """Compare role and content exactly except for the two bounded reminder tokens."""
    if (not isinstance(spec_msgs, Sequence) or isinstance(spec_msgs, (str, bytes))
            or not isinstance(real_msgs, Sequence) or isinstance(real_msgs, (str, bytes))
            or len(spec_msgs) != len(real_msgs)):
        return False
    for spec, real in zip(spec_msgs, real_msgs):
        if not isinstance(spec, Mapping) or not isinstance(real, Mapping):
            return False
        if not all(key in spec and key in real for key in ("role", "content")):
            return False
        if spec["role"] != real["role"]:
            return False
        left, right = spec["content"], real["content"]
        if not isinstance(left, str) or not isinstance(right, str):
            if left != right:
                return False
            continue
        left_masked, left_values = _masked(left)
        right_masked, right_values = _masked(right)
        if left_masked != right_masked or len(left_values) != len(right_values):
            return False
        for (kind, value), (other_kind, other) in zip(left_values, right_values):
            slack = clock_slack_sec if kind == "clock" else monologue_slack_sec
            if kind != other_kind or abs(value - other) > slack:
                return False
    return True


class SpeculationUnusable(Exception):
    """The speculative request produced no usable chunks."""


class SpeculativeReply:
    """Buffer one stream for a single replay; replay may only be called once.

    On reaching MAX_CHUNKS, stop reading and mark truncated, even if the stream
    would have ended at exactly that point. Replay ends at the buffered limit; check
    .truncated. Replay is once only: an error before a chunk raises SpeculationUnusable,
    an error after a chunk is re-raised, and cancellation raises SpeculationUnusable.
    """

    def __init__(self, row: int, key: str) -> None:
        self.row: int = row
        self.key: str = key
        self.messages: Sequence[Mapping[str, Any]] = []
        self.started_at: float | None = None
        self.task: asyncio.Task[None] | None = None
        self.chunks: list[Any] = []
        self.done: bool = False
        self.error: Exception | None = None
        self.truncated: bool = False
        self.event: asyncio.Event = asyncio.Event()
        self._replayed: bool = False
        self._cancelled: bool = False

    def start(
        self,
        runner: Callable[[Sequence[Mapping[str, Any]]], Any | Awaitable[Any]],
        messages: Sequence[Mapping[str, Any]],
        clock: Callable[[], float],
    ) -> None:
        """Start buffering a copied prompt once, recording the supplied clock time."""
        if self.task is not None:
            raise RuntimeError("speculation already started")
        self.messages = copy.deepcopy(messages)
        self.started_at = clock()
        self.task = asyncio.get_running_loop().create_task(self._drain(runner))
        self.task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[None]) -> None:
        # A task cancelled before its coroutine starts does not run its finally.
        self.done = True
        self.event.set()

    async def _drain(
        self, runner: Callable[[Sequence[Mapping[str, Any]]], Any | Awaitable[Any]]
    ) -> None:
        result: Any = None
        iterator: Any = None
        try:
            result = runner(copy.deepcopy(self.messages))
            if hasattr(result, "__await__"):
                result = await result
            iterator = result.__aiter__()
            while True:
                try:
                    chunk = await iterator.__anext__()
                except StopAsyncIteration:
                    break
                self.chunks.append(chunk)
                self.event.set()
                if len(self.chunks) >= MAX_CHUNKS:
                    self.truncated = True
                    break
        except Exception as exc:
            self.error = exc
        finally:
            for obj in (iterator, result if result is not iterator else None):
                with contextlib.suppress(Exception):
                    close = getattr(obj, "aclose", None)
                    if callable(close):
                        await close()
            self.done = True
            self.event.set()

    def matches(self, messages: Sequence[Mapping[str, Any]]) -> bool:
        """Return whether messages match the copied speculative prompt."""
        return messages_equivalent(self.messages, messages)

    async def replay(self) -> AsyncIterator[Any]:
        """Replay once, with cancellation, errors and truncation as described above."""
        if self._replayed:
            raise RuntimeError("speculative reply already replayed")
        self._replayed = True
        cursor = 0
        while True:
            if self._cancelled:
                raise SpeculationUnusable("speculation cancelled")
            while cursor < len(self.chunks):
                if self._cancelled:
                    raise SpeculationUnusable("speculation cancelled")
                chunk = self.chunks[cursor]
                cursor += 1
                yield chunk
            if self._cancelled:
                raise SpeculationUnusable("speculation cancelled")
            if self.done:
                if not cursor and self.error is not None:
                    raise SpeculationUnusable("speculation produced no chunks") from self.error
                if self.error is not None:
                    raise self.error
                return
            self.event.clear()
            if cursor < len(self.chunks) or self.done:
                continue
            await self.event.wait()

    def cancel(self) -> None:
        """Invalidate replay and cancel any running buffering task."""
        try:
            if not self._cancelled:
                self._cancelled = True
                self.event.set()
                if self.task is not None and not self.task.done():
                    self.task.cancel()
        except Exception:
            pass

    async def aclose(self) -> None:
        """Cancel speculation and wait for its buffering task to finish."""
        self.cancel()
        if self.task is not None:
            # asyncio.wait never raises the task's own outcome, and a cancel of the caller
            # still propagates (suppressing CancelledError here would swallow it).
            await asyncio.wait({self.task})

    def head_start(self, now: float) -> float:
        """Return nonnegative elapsed time since start, or zero if not started."""
        return 0.0 if self.started_at is None else max(0.0, now - self.started_at)
