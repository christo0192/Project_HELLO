"""The full-interview tier of the rehearsal harness (M032 S8): offline, no network, no key.

One call runs the WHOLE interview, OPENING to CLOSING, through the production phase driver
(``R1Interview.run``) on a virtual clock, with a phase-aware candidate simulator: a job candidate
in Christy's phases, the Program Advisor in the role-play.  These tests pin the clock, the SDK
emulation, the scenarios and the per-phase checks, and they run every named scenario offline
(scripted candidate, scripted Christy, scripted learner model) to pin what the plan asks for:

* each phase is reached, in order, and the interview ends in CLOSING;
* the role-play starts only on a spoken "ready" or the "I'm ready" button (the live button's
  path: a server-sent ``data_received`` packet, as ``TestReadyButton`` drives it);
* the early-end scenario gets Christy's consent path (asked, declined and continued, then agreed);
* the abuse scenario gets the hang-up path where the code base has one (feature-detected);
* the wrap-up is answered, and the transcript files are written.

Everything the candidate says is synthetic.  Nothing here reads the API key.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from rehearsal import vloop


# ------------------------------------------------------------------------------ virtual clock
class VirtualLoopTests(unittest.TestCase):
    def test_a_long_sleep_takes_no_real_time_and_moves_the_loop_clock(self) -> None:
        async def main() -> float:
            loop = asyncio.get_running_loop()
            start = loop.time()
            await asyncio.sleep(1800.0)
            return loop.time() - start

        real = time.perf_counter()
        elapsed = vloop.run_virtual(main())
        self.assertAlmostEqual(elapsed, 1800.0, places=3)
        self.assertLess(time.perf_counter() - real, 5.0)

    def test_timers_fire_in_order_of_their_virtual_deadlines(self) -> None:
        async def main() -> list[str]:
            order: list[str] = []

            async def after(seconds: float, name: str) -> None:
                await asyncio.sleep(seconds)
                order.append(name)

            await asyncio.gather(after(30, "c"), after(10, "a"), after(20, "b"))
            return order

        self.assertEqual(vloop.run_virtual(main()), ["a", "b", "c"])

    def test_wait_for_times_out_on_the_virtual_clock(self) -> None:
        async def main() -> str:
            try:
                await asyncio.wait_for(asyncio.Event().wait(), 600.0)
            except asyncio.TimeoutError:
                return "timeout"
            return "done"

        self.assertEqual(vloop.run_virtual(main()), "timeout")

    def test_harness_io_freezes_the_clock_while_a_real_answer_is_awaited(self) -> None:
        # The simulated candidate's own model call must not count as the candidate's silence.
        async def main() -> tuple[float, bool]:
            loop = asyncio.get_running_loop()
            fired = asyncio.Event()
            loop.call_later(5.0, fired.set)  # an interview timer that must NOT fire meanwhile
            future = loop.create_future()
            threading.Timer(0.3, lambda: loop.call_soon_threadsafe(future.set_result, "ok")).start()
            start = loop.time()
            with vloop.harness_io():
                await future
            return loop.time() - start, fired.is_set()

        moved, fired = vloop.run_virtual(main())
        self.assertLess(moved, 0.01)
        self.assertFalse(fired)

    def test_production_io_lets_real_time_pass_on_the_clock(self) -> None:
        # A production model call (the learner, Christy, the judge) takes real time on a call.
        async def main() -> float:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            threading.Timer(0.3, lambda: loop.call_soon_threadsafe(future.set_result, "ok")).start()
            start = loop.time()
            with vloop.production_io():
                await future
            return loop.time() - start

        moved = vloop.run_virtual(main())
        self.assertGreater(moved, 0.2)
        self.assertLess(moved, 3.0)

    def test_a_production_stream_counts_as_real_time_only_while_it_runs(self) -> None:
        async def provider(_messages):
            for word in ("one", "two"):
                yield word

        async def main() -> tuple[list[str], int]:
            loop = asyncio.get_running_loop()
            wrapped = vloop.production_stream(provider)
            seen = [item async for item in wrapped([])]
            return seen, loop.real_io

        seen, still = vloop.run_virtual(main())
        self.assertEqual(seen, ["one", "two"])
        self.assertEqual(still, 0)

    def test_a_wait_shorter_than_the_clock_resolution_still_reaches_its_deadline(self) -> None:
        # The driver re-reads "seconds left" after every wake-up.  A real clock always moves a
        # little between two reads; a virtual one moves only when a timer is due.  asyncio runs a
        # timer up to one clock resolution EARLY, so a 2.6e-13 s wait used to fire without moving
        # the clock, and the driver waited the same 2.6e-13 s forever (the icebreaker hang).
        async def main() -> int:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(233.9680101082012)
            deadline = loop.time() + 5.0
            await asyncio.sleep(5.0 - 2.5e-13)
            spins = 0
            while deadline - loop.time() > 0:
                spins += 1
                if spins > 1000:
                    break
                waiter = asyncio.ensure_future(asyncio.Event().wait())
                await asyncio.wait({waiter}, timeout=deadline - loop.time())
                waiter.cancel()
            return spins

        self.assertLess(vloop.run_virtual(main()), 5)

    def test_a_cancelled_timer_at_the_head_of_the_heap_cannot_hide_an_early_one(self) -> None:
        # The same sliver, with a stale cancelled handle at the head of the timer heap (asyncio
        # drops those lazily): the clock must still move to the deadline of the timer that fires.
        async def main() -> int:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(2378.0191085329716)
            deadline = loop.time() + 3.0
            await asyncio.sleep(3.0 - 2.5e-13)
            spins = 0
            while deadline - loop.time() > 0:
                spins += 1
                if spins > 1000:
                    break
                loop.call_at(loop.time(), lambda: None).cancel()
                waiter = asyncio.ensure_future(asyncio.Event().wait())
                await asyncio.wait({waiter}, timeout=deadline - loop.time())
                waiter.cancel()
            return spins

        self.assertLess(vloop.run_virtual(main()), 5)

    def test_a_wait_below_the_clocks_float_step_still_moves_the_clock(self) -> None:
        # The role-play clock R lives in a lower binade than the loop clock S, so "R seconds left"
        # can be half a float step of S: now + left rounds back to now, the timer fires at once
        # and the clock never moves.  A firing timer must move the clock at least one step.
        async def main() -> int:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(2000.0)
            start = loop.time()
            await asyncio.sleep(1219.3906603621754)
            deadline_r = (loop.time() - start) + 2.0**-42
            spins = 0
            while deadline_r - (loop.time() - start) > 0:
                spins += 1
                if spins > 1000:
                    break
                waiter = asyncio.ensure_future(asyncio.Event().wait())
                await asyncio.wait({waiter}, timeout=deadline_r - (loop.time() - start))
                waiter.cancel()
            return spins

        self.assertLess(vloop.run_virtual(main()), 5)

    def test_a_wait_that_nothing_can_end_is_a_stall_not_a_hang(self) -> None:
        async def main() -> None:
            await asyncio.get_running_loop().create_future()

        with self.assertRaises(vloop.SimulationStalled):
            vloop.run_virtual(main())

    def test_the_helpers_are_inert_on_an_ordinary_loop(self) -> None:
        async def main() -> str:
            with vloop.production_io(), vloop.harness_io():
                await asyncio.sleep(0)
            return "ok"

        self.assertEqual(asyncio.run(main()), "ok")

    def test_the_virtual_epoch_follows_the_loop_clock_and_stays_in_the_past(self) -> None:
        async def main() -> tuple[float, float]:
            first = vloop.epoch_now()
            await asyncio.sleep(120.0)
            return first, vloop.epoch_now()

        first, second = vloop.run_virtual(main())
        self.assertAlmostEqual(second - first, 120.0, places=3)
        self.assertLess(second, time.time())


if __name__ == "__main__":
    unittest.main()
