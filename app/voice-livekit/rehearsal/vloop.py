"""A virtual-time event loop for the full-interview tier: a 30-minute interview in seconds.

The production phase driver (``R1Interview.run``) waits on the loop's clock everywhere: silence
windows, the icebreaker's 4:30 cap, the 6:00 transition ceiling, the wrap-up's 2:00, playouts and
settle windows.  The role-play-only tier side-stepped that (it calls the SDK hooks itself and never
runs the driver); the full tier runs the driver as it is, so the clock itself is simulated:

* ``VirtualTimeLoop.time()`` is a virtual clock.  When nothing is ready to run and no real I/O is
  in flight, the loop JUMPS to its next timer instead of sleeping, so ``asyncio.sleep(1200)`` takes
  no real time and every deadline fires in the same order it would on a call.
* A PRODUCTION model call (the learner, Christy, the shadow judge, the end-intent classifier, any
  other ``*_runner`` of the session) takes real time on a real call.  While one is in flight
  (``production_io`` / ``production_stream`` / ``production_runner``) the loop waits for real and
  the clock moves by the real seconds that passed: latency, cut-offs and HTTP timeouts are real.
* A HARNESS call (the simulated candidate's own model, the rubric judge, the preflight) is not part
  of the interview: its latency is not the candidate's silence.  While one is in flight (and no
  production call is), the loop waits for real but the clock stands still (``harness_io``).  A
  watchdog lets the clock run again after ``frozen_watchdog_sec`` of real waiting, so a hung
  connection still reaches its own timeout.
* A wait that nothing can end (no timer, no I/O in flight) raises ``SimulationStalled`` instead of
  hanging the test or the sweep.

The loop is a ``SelectorEventLoop`` (sockets only, which is all httpx needs) whose selector is
wrapped; nothing in the production code knows it runs on it.  ``epoch_now`` is the SDK-style wall
clock (``created_at`` of events) on the virtual clock, anchored thirty days in the past so the session's
"no anchor ahead of now" guard (``time.time()``) never trips on a fast-forwarded clock.
"""
from __future__ import annotations

import asyncio
import contextlib
import inspect
import selectors
import time
from typing import Any, AsyncIterator, Awaitable, Callable, Coroutine, TypeVar

T = TypeVar("T")

FROZEN_WATCHDOG_SEC = 90.0
FROZEN_POLL_SEC = 0.5
CLOCK_RESOLUTION_SEC = 1e-6
EPOCH_LAG_SEC = 30 * 86_400.0  # a whole sweep runs on one loop: room for hundreds of calls


class SimulationStalled(RuntimeError):
    """The simulation waits for something that can never happen (no timer, no I/O in flight)."""


class _VirtualSelector:
    """Delegates to the real selector; ``select`` decides whether time jumps, runs or stands."""

    def __init__(self, inner: selectors.BaseSelector, loop: "VirtualTimeLoop") -> None:
        self._inner = inner
        self._loop = loop

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def select(self, timeout: float | None = None) -> list[Any]:
        loop = self._loop
        if loop.real_io > 0:
            loop._frozen_since = None
            return loop._select_real(self._inner, timeout)
        if loop.frozen_io > 0:
            now = time.perf_counter()
            if loop._frozen_since is None:
                loop._frozen_since = now
            if now - loop._frozen_since > loop.frozen_watchdog_sec:
                if not loop._watchdog_open:
                    loop._watchdog_open = True
                    loop.watchdog_trips += 1
                return loop._select_real(self._inner, timeout)
            wait = FROZEN_POLL_SEC if timeout is None else min(timeout, FROZEN_POLL_SEC)
            return self._inner.select(wait)
        loop._frozen_since = None
        loop._watchdog_open = False
        events = self._inner.select(0)
        if events:
            return events
        if timeout is None:
            raise SimulationStalled(
                "the simulation is waiting with no timer scheduled and no I/O in flight"
            )
        loop._vtime += timeout
        loop.jumped_seconds += timeout
        return []


class VirtualTimeLoop(asyncio.SelectorEventLoop):
    """An event loop whose ``time()`` is virtual (see the module docstring)."""

    def __init__(self, *, start: float = 0.0, frozen_watchdog_sec: float = FROZEN_WATCHDOG_SEC) -> None:
        super().__init__(selectors.DefaultSelector())
        self._vtime = float(start)
        self.real_io = 0
        self.frozen_io = 0
        self.frozen_watchdog_sec = float(frozen_watchdog_sec)
        self.watchdog_trips = 0
        self.real_seconds = 0.0
        self.jumped_seconds = 0.0
        self._frozen_since: float | None = None
        self._watchdog_open = False
        self._epoch_base = time.time() - EPOCH_LAG_SEC - self._vtime
        self._selector = _VirtualSelector(self._selector, self)  # type: ignore[assignment]
        # A virtual clock has no tick: timers may fire at most this much before their deadline.
        self._clock_resolution = CLOCK_RESOLUTION_SEC

    def time(self) -> float:  # noqa: D401 - the loop's clock
        return self._vtime

    def _run_once(self) -> None:
        # asyncio runs a timer up to one clock resolution EARLY.  A real clock has moved on by the
        # time the callback reads it; a virtual one has not, so a caller that re-reads "seconds
        # left" (the driver does after every wake-up) would wait the same sub-resolution sliver
        # forever.  A timer that fires early therefore moves the clock to its own deadline.  The
        # heap is scanned (it is small): a cancelled handle asyncio has not dropped yet may sit at
        # its head and hide the one that fires.
        horizon = self._vtime + self._clock_resolution
        due = [
            handle._when
            for handle in self._scheduled
            if not handle._cancelled and self._vtime < handle._when < horizon
        ]
        if due:
            self._vtime = max(due)
        super()._run_once()  # type: ignore[misc]

    def epoch(self) -> float:
        """SDK-style wall-clock seconds (``created_at``) on the virtual clock."""
        return self._epoch_base + self._vtime

    def _select_real(self, inner: selectors.BaseSelector, timeout: float | None) -> list[Any]:
        started = time.perf_counter()
        events = inner.select(timeout)
        spent = time.perf_counter() - started
        self._vtime += spent
        self.real_seconds += spent
        return events


def current() -> VirtualTimeLoop | None:
    """The running loop when it is a ``VirtualTimeLoop`` (None on an ordinary loop or none)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return loop if isinstance(loop, VirtualTimeLoop) else None


def epoch_now() -> float:
    """``created_at`` for an emulated SDK event: virtual on a virtual loop, else ``time.time()``."""
    loop = current()
    return loop.epoch() if loop is not None else time.time()


@contextlib.contextmanager
def production_io():
    """A production call is in flight: real seconds pass on the clock (inert on other loops)."""
    loop = current()
    if loop is None:
        yield
        return
    loop.real_io += 1
    try:
        yield
    finally:
        loop.real_io -= 1


@contextlib.contextmanager
def harness_io():
    """A harness call is in flight: the clock stands still while it is awaited."""
    loop = current()
    if loop is None:
        yield
        return
    loop.frozen_io += 1
    try:
        yield
    finally:
        loop.frozen_io -= 1


def production_stream(provider: Callable[[list], Any]) -> Callable[[list], AsyncIterator[Any]]:
    """Wrap a streaming ``provider(messages)`` so the stream counts as production I/O."""

    def call(messages: list) -> AsyncIterator[Any]:
        return _counted_stream(provider, messages)

    return call


async def _counted_stream(provider: Callable[[list], Any], messages: list) -> AsyncIterator[Any]:
    with production_io():
        source = provider(messages)
        if inspect.isawaitable(source):
            source = await source
        async for item in source:
            yield item


def production_runner(
    runner: Callable[[list], Awaitable[Any]],
) -> Callable[[list], Coroutine[Any, Any, Any]]:
    """Wrap a coroutine ``runner(messages)`` (judge, classifier ...) as production I/O."""

    async def run(messages: list) -> Any:
        with production_io():
            return await runner(messages)

    return run


class FrozenClient:
    """A harness HTTP client (``HttpxDeepSeek``) whose calls stand the clock still."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def __repr__(self) -> str:
        return f"FrozenClient({self._inner!r})"

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    async def complete(self, *args: Any, **kwargs: Any) -> Any:
        with harness_io():
            return await self._inner.complete(*args, **kwargs)

    async def balance(self) -> Any:
        with harness_io():
            return await self._inner.balance()

    async def aclose(self) -> None:
        with harness_io():
            await self._inner.aclose()


def run_virtual(main: Coroutine[Any, Any, T], *, start: float = 0.0) -> T:
    """Run ``main`` to completion on a fresh ``VirtualTimeLoop`` and close it cleanly."""
    loop = VirtualTimeLoop(start=start)
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(main)
    finally:
        try:
            _cancel_all(loop)
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.frozen_io += 1  # the default executor's threads finish on real time
            loop.run_until_complete(loop.shutdown_default_executor())
        finally:
            loop.frozen_io = 0
            asyncio.set_event_loop(None)
            loop.close()


def _cancel_all(loop: asyncio.AbstractEventLoop) -> None:
    pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
    if not pending:
        return
    for task in pending:
        task.cancel()
    with contextlib.suppress(SimulationStalled):
        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
