"""The gate turn barrier and the dropped-leg guard, in `agent.py`.

WHY THIS FILE EXISTS. An adversarial review replaced four load-bearing
mechanisms in `agent.py` with no-ops — the staleness rule, the question anchor,
the `RuntimeError` -> `PhoneParticipantGone` translation, and the purge post —
and ran the entire 1788-test suite: byte-identical result, zero failures. Every
one of them was invisible.

The reason is structural. `test_phone_conversational_gate.py` imports `phone`
and never `agent`, and re-implements the staleness rule inside its own harness;
`test_phone_gate.py` pins the scripted gate module-wide, so the barrier is
unreachable there. So the mechanisms that decide whether a candidate's answer is
heard, and whether a dropped leg destroys its pre-consent recording, had no test
at all — which is also how a review agent's mutation reached a commit unnoticed.

These tests import `agent` and drive the real functions.
"""

from __future__ import annotations

import asyncio
import time
import types
import unittest

# Reuse the phone-gate harness: its module bootstrap installs the stub SDK, which
# `agent` needs at import time. Same pattern as the other agent-importing tests
# (e.g. test_call_quality_call2_rca.py).
from tests.test_phone_gate import FakeEventClient  # noqa: F401,E402

import agent as agent_mod  # noqa: E402
import gate_judge  # noqa: E402
import phone  # noqa: E402

from unittest.mock import MagicMock, patch  # noqa: E402


def _msg(started_speaking_at: float | None = None, created_at: float | None = None):
    """A ChatMessage-shaped stub: `metrics` is a Mapping at runtime."""
    metrics = {} if started_speaking_at is None else {
        "started_speaking_at": started_speaking_at
    }
    return types.SimpleNamespace(metrics=metrics, created_at=created_at)


# ── a hand-driven gate capture (M013 S01 T01b) ────────────────────────────

_T0 = 1_800_000_000_000  # an arbitrary wall-clock origin, in ms


class _Clock:
    def __init__(self) -> None:
        self.ms = _T0

    def at(self, rel_ms: int) -> "_Clock":
        if _T0 + rel_ms < self.ms:
            raise AssertionError("the test clock only moves forward")
        self.ms = _T0 + rel_ms
        return self


class _Timers:
    """`call_later` on the test clock; `advance` fires what falls due."""

    def __init__(self, clock: _Clock) -> None:
        self.clock = clock
        self.pending: list[list] = []

    def call_later(self, delay_s, fn):
        entry = [self.clock.ms + int(round(delay_s * 1000)), fn, False]
        self.pending.append(entry)
        return types.SimpleNamespace(cancel=lambda: entry.__setitem__(2, True))

    def advance(self, rel_ms: int) -> None:
        target = _T0 + rel_ms
        while True:
            due = sorted((e for e in self.pending if not e[2] and e[0] <= target),
                         key=lambda e: e[0])
            if not due:
                break
            entry = due[0]
            entry[2] = True
            self.clock.ms = max(self.clock.ms, entry[0])
            entry[1]()
        self.clock.ms = max(self.clock.ms, target)


class _Rig:
    """One capture on a manual clock, recording what it emits and logs."""

    SETTLE_MS = 1050

    def __init__(self) -> None:
        self.clock = _Clock()
        self.timers = _Timers(self.clock)
        self.emitted: list = []
        self.logs: list[dict] = []
        self.capture = gate_judge.GateTurnCapture(
            emit=self.emitted.append,
            now_ms=lambda: self.clock.ms,
            settle_ms=lambda: self.SETTLE_MS,
            call_later=self.timers.call_later,
            log=lambda **fields: self.logs.append(fields),
        )

    def vad(self, rel_ms: int, kind: str, *, speech_ms: int = 0, silence_ms: int = 0,
            inference_ms: int = 0) -> None:
        self.timers.advance(rel_ms)
        self.capture.on_vad_event(types.SimpleNamespace(
            type=kind, speech_duration=speech_ms / 1000.0,
            silence_duration=silence_ms / 1000.0,
            inference_duration=inference_ms / 1000.0,
        ), self.clock.ms / 1000.0)

    def segment(self, start_rel: int, end_rel: int) -> None:
        """SDK-shaped start (detected 60 ms in) and end (256 ms of silence)."""
        self.vad(start_rel + 60, "start_of_speech", speech_ms=50, inference_ms=10)
        self.vad(end_rel + 256, "end_of_speech", speech_ms=end_rel - start_rel,
                 silence_ms=256)

    def final(self, rel_ms: int, text: str):
        self.timers.advance(rel_ms)
        return self.capture.on_final(text)

    def commit(self, rel_ms: int, text: str, sdk_anchor_rel: int | None = None):
        self.timers.advance(rel_ms)
        return self.capture.on_commit(
            text, None if sdk_anchor_rel is None else _T0 + sdk_anchor_rel)

    def rel(self, abs_ms: int | None) -> int | None:
        return None if abs_ms is None else abs_ms - _T0


class _LogSink:
    def __init__(self) -> None:
        self.records: list[tuple[str, dict]] = []

    def info(self, event, **fields):
        self.records.append(("info", fields))

    def warn(self, event, **fields):
        self.records.append(("warn", fields))

    error = debug = warn

    def of(self, error_type: str, category: str | None = None) -> list[dict]:
        return [f for _, f in self.records
                if f.get("error_type") == error_type
                and (category is None or f.get("error_category") == category)]


class TestQueuedTurnUnpacking(unittest.TestCase):
    """`_queued_turn` — the tolerance that keeps the older seam working."""

    def test_it_unpacks_the_pair_the_live_producer_enqueues(self):
        self.assertEqual(agent_mod._queued_turn(("hello", 1234)), ("hello", 1234))

    def test_it_unpacks_a_GATE_TURN_by_its_own_speech_start(self):
        # M013 S01: the live producer now enqueues a GateTurn; the anchor is
        # the paired VAD speech start, never the SDK's carried-over stamp.
        turn = gate_judge.GateTurn(
            text="Yes", utterance_idxs=(0,), segment_start_ms=5_000,
            segment_end_ms=5_500, segment_speech_ms=500, final_arrival_ms=6_000,
            committed=True, closed_by="commit", sdk_anchor_ms=1_000)
        self.assertEqual(agent_mod._queued_turn(turn), ("Yes", 5_000))
        untimed = gate_judge.GateTurn(
            text="Yes", utterance_idxs=(0,), segment_start_ms=None,
            segment_end_ms=None, segment_speech_ms=None, final_arrival_ms=6_000,
            committed=False, closed_by="settle")
        self.assertEqual(agent_mod._queued_turn(untimed), ("Yes", None))

    def test_a_BARE_STRING_still_works(self):
        # `_classify_phone_answer` has direct tests that hand it a plain
        # Queue[str]; widening the queue must not force them to learn a shape
        # they do not care about.
        self.assertEqual(agent_mod._queued_turn("hello"), ("hello", None))

    def test_junk_degrades_to_untimed_rather_than_raising(self):
        for junk in (None, 42, ("only-one",), ("text", "not-an-int"), ("t", True)):
            text, anchor = agent_mod._queued_turn(junk)
            self.assertIsNone(anchor, repr(junk))


class TestQueuedTurnStaleness(unittest.TestCase):
    """`_queued_turn_is_stale` — which utterance belongs to which question."""

    def test_speech_that_began_BEFORE_the_question_is_stale(self):
        self.assertTrue(agent_mod._queued_turn_is_stale(1_000, 2_000))

    def test_speech_that_began_AFTER_the_question_is_KEPT(self):
        # The live stage-2 defect: a barge-in answer must survive.
        self.assertFalse(agent_mod._queued_turn_is_stale(2_001, 2_000))

    def test_a_tie_is_KEPT(self):
        self.assertFalse(agent_mod._queued_turn_is_stale(2_000, 2_000))

    def test_an_untimed_turn_is_KEPT_either_way(self):
        # FAIL-OPEN. Losing a genuine answer costs the identity check; reading a
        # stale one costs a re-ask.
        self.assertFalse(agent_mod._queued_turn_is_stale(None, 2_000))
        self.assertFalse(agent_mod._queued_turn_is_stale(1_000, None))

    def test_a_WRONG_CLOCK_anchor_fails_OPEN_not_closed(self):
        # `normalize_turn_anchor_ms` accepts anything from 1ms to year 2100, so
        # a monotonic/uptime-shaped `started_speaking_at` (12345.678 -> 1970)
        # would otherwise mark EVERY turn stale: the identity reader returns "",
        # the consent classifier burns both attempts on skips, and every
        # consenting candidate is torn down as a machine.
        now_ms = 1_789_000_000_000
        self.assertFalse(agent_mod._queued_turn_is_stale(12_345_678, now_ms))

    def test_the_sane_lookback_is_far_wider_than_a_real_turn(self):
        now_ms = 1_789_000_000_000
        self.assertTrue(
            agent_mod._queued_turn_is_stale(now_ms - 30_000, now_ms),
            "a 30s-old utterance is a plausible late final and must stay filterable",
        )


class TestTurnAnchorSource(unittest.TestCase):
    """`_turn_anchor_ms` — what the barrier is actually comparing."""

    def test_the_vad_speech_start_is_preferred(self):
        self.assertEqual(agent_mod._turn_anchor_ms(_msg(1_723_000_000.0)),
                         1_723_000_000_000)

    def test_units_match_the_anchor_the_gate_writes(self):
        # A seconds/ms mismatch here would mark every turn stale or none.
        # The gate anchors with int(time.time()*1000); this must be the same
        # scale, via persistence.normalize_turn_anchor_ms.
        import time as _time
        now_s = _time.time()
        anchor_from_msg = agent_mod._turn_anchor_ms(_msg(now_s))
        anchor_from_gate = int(round(now_s * 1000))
        self.assertLess(abs(anchor_from_msg - anchor_from_gate), 5)

    def test_a_message_with_no_timing_at_all_is_untimed(self):
        self.assertIsNone(agent_mod._turn_anchor_ms(_msg()))

    def test_created_at_is_the_FALLBACK_and_is_a_different_instant(self):
        # Worth pinning because it is easy to read the call site as "VAD start
        # or nothing". It is not: with no VAD metrics the anchor becomes
        # `created_at`, the message-FINALISATION time, which is LATER than the
        # speech start it stands in for. That biases toward keeping a turn,
        # which is the fail-open direction the readers want — but a test that
        # only ever passes `created_at=None` never sees this path at all.
        self.assertEqual(
            agent_mod._turn_anchor_ms(_msg(created_at=1_723_000_000.0)),
            1_723_000_000_000,
        )
        # And VAD wins when both are present, or the barrier would compare
        # finalisation times against speech-start anchors.
        self.assertEqual(
            agent_mod._turn_anchor_ms(
                _msg(started_speaking_at=1_723_000_000.0,
                     created_at=1_723_000_009.0)),
            1_723_000_000_000,
        )

    def test_the_user_state_anchor_is_the_events_created_at(self):
        # M013 S01: `user_state_changed` -> speaking carries THIS segment's
        # start in `created_at`; the handler's own clock is later by the VAD
        # detection delay.
        now_s = 1_800_000_010.0
        event = types.SimpleNamespace(created_at=1_800_000_009.25)
        self.assertEqual(agent_mod._user_state_anchor_ms(event, now_s), 1_800_000_009_250)

    def test_an_implausible_created_at_falls_back_to_now(self):
        now_s = 1_800_000_010.0
        for junk in (None, True, "x", float("nan"), MagicMock(), now_s - 7_200.0, 12.5):
            with self.subTest(junk=repr(junk)):
                event = types.SimpleNamespace(created_at=junk)
                self.assertEqual(
                    agent_mod._user_state_anchor_ms(event, now_s), 1_800_000_010_000)


class TestClassifyPhoneAnswerSkipsStaleTurns(unittest.IsolatedAsyncioTestCase):
    """The CONSENT reader, driven directly.

    This is the shared-FIFO defect in its final form: a trailing fragment of the
    identity answer is legitimately enqueued under the identity anchor, then
    popped here. Only the reader knows its own question, so only the reader can
    reject it.
    """

    async def _classify(self, items, anchor):
        turns: asyncio.Queue = asyncio.Queue()
        for item in items:
            turns.put_nowait(item)
        said: list[str] = []
        consumed: list[str] = []

        async def _say(text):
            said.append(text)

        decision = await agent_mod._classify_phone_answer(
            turns, _say, answer_timeout_sec=0.05, consumed=consumed,
            question_anchor=(lambda: anchor),
        )
        return decision, said, consumed

    async def test_a_trailing_identity_fragment_is_NOT_read_as_consent(self):
        # Assert on what was CONSUMED, not just the verdict. Without the skip,
        # the stale fragment is read first, fails to classify, and a re-ask still
        # reaches HUMAN on the next turn — so the decision alone cannot tell the
        # two behaviours apart, and a decision-only assertion lets the bug live.
        decision, said, consumed = await self._classify(
            [("...how can I help?", 1_000), ("Yes, that's fine.", 3_000)],
            anchor=2_000,
        )
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertNotIn("...how can I help?", consumed)
        self.assertEqual(consumed, ["Yes, that's fine."])
        self.assertEqual(said, [], "a stale turn burned the single re-ask")

    async def test_a_genuine_answer_after_the_question_is_read(self):
        decision, _, consumed = await self._classify(
            [("Yes, that's fine.", 3_000)], anchor=2_000)
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(consumed, ["Yes, that's fine."])

    async def test_a_bare_string_queue_still_classifies(self):
        # Back-compat with the direct tests in test_phone_gate.py.
        decision, _, consumed = await self._classify(
            ["Yes, that's fine."], anchor=None)
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(consumed, ["Yes, that's fine."])

    async def test_only_stale_turns_defer_never_machine(self):
        # Review fix: stale words are never consent, but they are a person
        # (the weak latch), so the call is deferred with a goodbye, not hung
        # up on as a voicemail.
        decision, _, consumed = await self._classify(
            [("Hello?", 1_000), ("Hello?", 1_100)], anchor=5_000,
        )
        self.assertEqual(decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(consumed, [], "a stale turn was consumed as consent")

    async def test_only_stale_voicemail_wording_still_falls_closed_to_MACHINE(self):
        decision, _, consumed = await self._classify(
            [("Please leave a message after the tone.", 1_000)], anchor=5_000,
        )
        self.assertEqual(decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(consumed, [])

    @staticmethod
    def _turn(text, *, start, end=None, committed=True, closed_by="commit",
              vad_observed=True):
        return gate_judge.GateTurn(
            text=text, utterance_idxs=(3,), segment_start_ms=start,
            segment_end_ms=end, segment_speech_ms=None if start is None else 400,
            final_arrival_ms=9_000, committed=committed, closed_by=closed_by,
            vad_observed=vad_observed, segment_first_end_ms=end)

    async def test_a_turn_with_NO_SPEECH_TIMING_never_grants(self):
        # A reply the SDK dropped and the VAD never timed cannot be shown to
        # answer THIS question: it never becomes consent, and the skip is logged.
        sink = _LogSink()
        with patch.object(agent_mod, "_log", sink):
            decision, said, consumed = await self._classify(
                [self._turn("Yes", start=None, committed=False, closed_by="settle")],
                anchor=2_000)
        self.assertNotEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(consumed, [])
        skips = sink.of("phone_gate_turn_barrier", "consent_turn_not_grant_evidence")
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0]["phase"], gate_judge.TAG_NO_SEGMENT)
        # It was heard, so the re-ask says "unmatched", not "no_speech", and
        # is worded for an unclear reply rather than for silence (T02).
        self.assertIn(phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT, said)
        # A person spoke after the question: never "machine" (T02).
        self.assertEqual(decision, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(
            [f["error_category"] for f in sink.of("phone_consent_reask")], ["unmatched"])

    async def test_an_untimed_turn_can_still_REFUSE(self):
        # Only a grant needs evidence; a refusal never needs to be proven.
        decision, _, consumed = await self._classify(
            [self._turn("No, not interested.", start=None, committed=False,
                        closed_by="settle")],
            anchor=2_000)
        self.assertEqual(decision, phone.CLASSIFY_REFUSED)
        self.assertEqual(consumed, ["No, not interested."])

    async def test_the_grant_evidence_hook_receives_the_granting_turn(self):
        turns: asyncio.Queue = asyncio.Queue()
        granting = self._turn("Yes, go ahead.", start=3_000, end=3_500,
                              committed=False, closed_by="settle")
        turns.put_nowait(self._turn("Hello?", start=1_000, end=1_400))
        turns.put_nowait(granting)
        seen: list = []

        async def _say(_text):
            return None

        decision = await agent_mod._classify_phone_answer(
            turns, _say, answer_timeout_sec=0.05, question_anchor=(lambda: 2_000),
            on_grant_evidence=seen.append)
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(seen, [granting])

    async def test_a_broken_evidence_hook_never_blocks_consent(self):
        turns: asyncio.Queue = asyncio.Queue()
        turns.put_nowait(self._turn("Yes", start=3_000, end=3_400))

        async def _say(_text):
            return None

        def _boom(_item):
            raise RuntimeError("persist exploded")

        sink = _LogSink()
        with patch.object(agent_mod, "_log", sink):
            decision = await agent_mod._classify_phone_answer(
                turns, _say, answer_timeout_sec=0.05, question_anchor=(lambda: 2_000),
                on_grant_evidence=_boom)
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        self.assertEqual(
            len(sink.of("phone_gate_turn_barrier", "grant_evidence_record_failed")), 1)


class TestIdentityReaderSkipsStaleTurns(unittest.IsolatedAsyncioTestCase):
    """`_read_fresh_turn` — the IDENTITY side of the barrier, driven directly.

    This had no test at all, and a review proved it: deleting the staleness skip
    (`if False and _queued_turn_is_stale(...)`) and emptying
    `_mark_question_asked` each left the ENTIRE 1895-test suite green, while
    driving the real session showed the identity check reading the callee's
    pickup — `['Hello? Hello?']` instead of `['Yes, this is Christo.']`. That is
    precisely the live 2026-09-11 defect this branch exists to fix.

    The only thing that looked like coverage, `_GateHarness.next_candidate_turn`
    in `test_phone_conversational_gate.py`, RE-IMPLEMENTS the rule, so it tests
    its own copy. And no session test can reach the real one: the harness
    patches `persistence` with a bare `MagicMock`, so `normalize_turn_anchor_ms`
    returns a Mock that `_queued_turn` discards, and `_FakePhoneSession` stamps a
    fixed 2024 anchor that the one-hour sanity window reads as a wrong clock —
    two independent reasons the rule is invisible there.
    """

    async def _read(self, items, anchor, timeout=0.05):
        turns: asyncio.Queue = asyncio.Queue()
        for item in items:
            turns.put_nowait(item)
        return await agent_mod._read_fresh_turn(
            turns, (lambda: anchor), timeout)

    async def test_the_PICKUP_hello_is_skipped_and_the_answer_is_read(self):
        # The live defect, in one line. "Hello?" began 3 s before the gate asked;
        # the real answer began after it.
        self.assertEqual(
            await self._read(
                [("Hello?", 1_000), ("Yes, this is Christo.", 5_000)],
                anchor=4_000),
            "Yes, this is Christo.",
        )

    async def test_a_BARGE_IN_answer_over_the_question_is_KEPT(self):
        # Began 1 ms after the question was anchored — mid-playout. Dropping
        # this is what made the identity check verify nothing on the stage-2
        # call, so the barrier must not be "discard anything early".
        self.assertEqual(
            await self._read([("Yeah, speaking.", 4_001)], anchor=4_000),
            "Yeah, speaking.",
        )

    async def test_stale_turns_do_not_BUY_or_SPEND_the_answer_budget(self):
        # Skipped within the SAME budget: a stale utterance must not extend the
        # window, and must not consume it either. Only stale turns here, so the
        # reader must exhaust its budget and report nothing usable.
        started = time.monotonic()
        self.assertEqual(
            await self._read(
                [("Hello?", 1_000), ("Hello?", 1_100), ("Hello?", 1_200)],
                anchor=9_000, timeout=0.05),
            "",
        )
        self.assertLess(time.monotonic() - started, 1.0,
                        "stale turns extended the answer window")

    async def test_an_UNTIMED_turn_is_kept_rather_than_lost(self):
        # Fail-open: losing a real answer costs the identity check, reading a
        # stale one costs a re-ask.
        self.assertEqual(
            await self._read([("Yes, that's me.", None)], anchor=4_000),
            "Yes, that's me.")
        self.assertEqual(
            await self._read([("Yes, that's me.", 1_000)], anchor=None),
            "Yes, that's me.")

    async def test_a_WRONG_CLOCK_anchor_does_not_silence_the_candidate(self):
        # A monotonic-shaped `started_speaking_at` normalises to 1970. Without
        # the sanity window every turn reads as stale, the identity reader
        # returns "", and every consenting candidate is torn down as a machine.
        now_ms = int(round(time.time() * 1000))
        self.assertEqual(
            await self._read([("Yes, speaking.", 12_345_678)], anchor=now_ms),
            "Yes, speaking.",
        )

    async def test_a_skip_is_LOGGED_with_its_tag_and_deltas_and_no_text(self):
        sink = _LogSink()
        with patch.object(agent_mod, "_log", sink):
            got = await self._read(
                [("Hello there, who is this?", 1_000), ("Yes, speaking.", 5_000)],
                anchor=4_000)
        self.assertEqual(got, "Yes, speaking.")
        skips = sink.of("phone_gate_turn_barrier", "pre_question_turn_skipped")
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0]["phase"], gate_judge.TAG_PRE_QUESTION)
        self.assertEqual(skips[0]["schema"], "anchor_ms:-3000_final_ms:na_segment_ms:na")
        self.assertNotIn("Hello", str(skips[0]))

    async def test_an_EMPTY_queue_returns_nothing_rather_than_hanging(self):
        started = time.monotonic()
        self.assertEqual(await self._read([], anchor=4_000, timeout=0.05), "")
        self.assertLess(time.monotonic() - started, 1.0)

    async def test_the_anchor_is_read_LIVE_not_captured_once(self):
        # The anchor must be re-read on EVERY iteration, not once per call.
        #
        # AN EARLIER VERSION OF THIS TEST DID NOT PROVE THAT. It made two
        # separate calls with a fresh lambda each time, and a capture-once
        # implementation reads the right anchor at the top of each call — so it
        # passed either way, while its name, and the commit message citing it,
        # claimed otherwise. Exactly the defect this file exists to catch,
        # committed in the file that exists to catch it.
        #
        # To discriminate, the anchor has to move DURING a single call, which is
        # the real scenario: `_mark_question_asked` re-arms while this reader is
        # already waiting.
        anchor = {"ms": 1_000}

        class _ReArmingQueue(asyncio.Queue):
            async def get(self_inner):
                item = await super().get()
                # The gate asks its next question while the reader waits.
                anchor["ms"] = 9_000
                return item

        turns = _ReArmingQueue()
        turns.put_nowait(("trailing answer to question one", 2_000))
        turns.put_nowait(("answer to question two", 9_500))
        got = await agent_mod._read_fresh_turn(
            turns, (lambda: anchor["ms"]), 0.2)
        self.assertEqual(
            got, "answer to question two",
            "the anchor was captured at call time, so question one's trailing "
            "answer was read as question two's",
        )

    async def test_stale_turns_do_not_BUY_extra_time(self):
        # The other half of the budget property, and the half a pre-filled queue
        # cannot see: with every item already queued `get()` never blocks, the
        # deadline is consulted once, and a per-skip deadline RESET is invisible.
        # Dripping stale turns in slower than the budget makes it visible — with
        # the deadline reset on each skip the reader waits for ever.
        anchor = 9_000
        turns: asyncio.Queue = asyncio.Queue()

        # UNBOUNDED on purpose. A fixed number of stale turns lets even a
        # deadline-resetting reader finish once the drip dries up — which is how
        # the first version of this test passed against that exact mutation. The
        # drip must outlast the assertion, so the only way to return is to hold
        # the original budget.
        async def _drip():
            while True:
                await asyncio.sleep(0.04)
                turns.put_nowait(("Hello?", 1_000))

        drip = asyncio.ensure_future(_drip())
        self.addCleanup(drip.cancel)
        started = time.monotonic()
        got = await asyncio.wait_for(
            agent_mod._read_fresh_turn(turns, (lambda: anchor), 0.05),
            timeout=1.0,
        )
        self.assertEqual(got, "")
        self.assertLess(
            time.monotonic() - started, 0.9,
            "each stale turn bought the candidate a fresh answer budget",
        )


class TestTheGateAnchorRisesToFirstAudio(unittest.TestCase):
    """The barrier must anchor on when the question was HEARD, not composed.

    `_mark_question_asked` stamps when the gate begins a question, and its
    docstring used to argue that was sufficient. On 2026-09-12 it was not: the
    gate reached the identity line ~0.3s after the participant appeared, but
    first audio was ~15s later (bounded subscription wait, then generation).
    Everything said in that window counted as an answer to a question the
    candidate had not yet heard.

    Source-level because the raise lives inside `_run_phone_session`'s
    `agent_state_changed` closure; `_queued_turn_is_stale` covers the rule.
    """

    def test_the_speaking_transition_raises_the_gate_anchor(self):
        import inspect
        src = inspect.getsource(agent_mod._run_phone_session)
        # The AGENT handler, not the user one — both contain the same
        # `new_state == "speaking"` line and the first match is the wrong side.
        start = src.index("def _on_phone_agent_state_changed")
        block = src[start:start + 2600]
        self.assertIn("gate_question_anchor[0] is not None", block)
        self.assertIn("gate_question_anchor[0] = _first_audio_ms", block)

    def test_the_raise_is_ONE_WAY_only(self):
        # A late state change must never move the barrier BACKWARDS onto a turn
        # already judged, and it must never reach playout end — a barge-in answer
        # begins after first audio and has to survive, which is the guarantee
        # #289 restored.
        import inspect
        src = inspect.getsource(agent_mod._run_phone_session)
        start = src.index("def _on_phone_agent_state_changed")
        block = src[start:start + 2600]
        self.assertIn("_first_audio_ms > gate_question_anchor[0]", block)

    def test_the_stamp_docstring_no_longer_claims_generation_start_suffices(self):
        import inspect
        doc = inspect.getsource(agent_mod._run_phone_session)
        marker = "def _mark_question_asked()"
        body = doc[doc.index(marker):doc.index(marker) + 1200]
        self.assertIn("FLOOR", body)
        self.assertNotIn("deliberate and sufficient", body)

    def test_each_question_CLEARS_the_sdk_user_turn_guarded(self):
        # M013 S01 change 6. Clearing the SDK's pending turn at each question
        # stops a pre-question blip lending its start to the next commit. The
        # gate capture still holds every final, so nothing heard is lost.
        import inspect
        src = inspect.getsource(agent_mod._run_phone_session)
        mark = src[src.index("def _mark_question_asked()"):]
        mark = mark[:mark.index("def _clear_sdk_user_turn()")]
        self.assertIn("_clear_sdk_user_turn()", mark)
        clear = src[src.index("def _clear_sdk_user_turn()"):]
        clear = clear[:clear.index("def _clear_question_anchor()")]
        self.assertIn('getattr(session, "clear_user_turn", None)', clear)
        self.assertIn("clear_user_turn_unavailable", clear)
        self.assertIn("clear_user_turn_unavailable_logged[0] = True", clear)
        self.assertIn("except Exception", clear)


class TestRoleOpeningSayFailureIsAmbiguous(unittest.TestCase):
    """`speak_role_opening` must return `""`, not None, when `say` fails.

    THE WEAKNESS, STATED. `speak_role_opening` is a closure inside
    `_run_phone_session`, so nothing can call it directly; the caller-side
    contract is covered behaviourally by
    `TestConsentLatencyFixes.test_an_UNCERTAIN_role_say_does_not_announce_the_role_TWICE`,
    and this source check is all that is reachable for the PRODUCER. Verified by
    mutation: changing the caller branch is caught behaviourally, changing this
    return is caught only here.

    Why it matters: returning None would tell the gate nothing was said, and it
    would speak the fixed role line on top of an announcement the candidate may
    have just heard. `say` speaks and then awaits playout, so a fault can land
    either side of first audio — indistinguishable from outside.
    """

    def test_the_say_failure_path_returns_the_ambiguity_sentinel(self):
        import inspect
        src = inspect.getsource(agent_mod._run_phone_session)
        start = src.index("async def speak_role_opening")
        end = src.index("async def fetch_durable_consent")
        block = src[start:end]
        # The rejected-draft path returns None (nothing spoken, fixed line runs)
        self.assertIn("return None", block)
        # The say-failure path returns "" (may have been spoken, say no more)
        self.assertIn('return ""', block)
        self.assertIn("composed_role_say_failed", block)
        # And the two must not be confused: the `""` return has to sit inside
        # the exception handler, after the `say`.
        say_at = block.index("await say(composed)")
        self.assertGreater(
            block.index('return ""'), say_at,
            "the ambiguity sentinel moved above the say — it now means nothing",
        )


class TestInterruptionTuningIsSet(unittest.TestCase):
    """Barge-in must require WORDS, not raw energy.

    Left unset the SDK uses `min_interruption_words=0`, so a breath, a keyboard
    tap or line noise truncates the bot mid-sentence. Two live calls did exactly
    that: 2026-09-10 (Praveetha, 8/8 bot turns truncated) and 2026-09-12
    (session ffab6c2a) where "Ah, got it" and "Perfect, so you could" were cut
    off with the candidate silent. The 2026-09-10 RCA diagnosed it and the
    tuning was never actually added — these pin that it now is.
    """

    def test_the_defaults_require_words_and_are_rollbackable(self):
        for name, fn, default in (
            # RAISED 2 -> 3 on 2026-09-17: a refused fragment is BANKED, not
            # discarded, so a floor of 2 meant two words of backchannel could
            # cut the bot off. THREE and not four — four would also silence
            # "can you repeat" and would bank a short direct answer instead of
            # delivering it. See tests/test_barge_in_bank.py for the
            # transcript evidence.
            ("PHONE_MIN_INTERRUPTION_WORDS",
             phone.phone_min_interruption_words, 3),
            ("PHONE_MIN_INTERRUPTION_DURATION_SEC",
             phone.phone_min_interruption_duration_sec, 0.8),
        ):
            import os as _os
            from unittest.mock import patch as _patch
            with _patch.dict(_os.environ, {}, clear=False):
                _os.environ.pop(name, None)
                self.assertEqual(fn(), default, name)
            with _patch.dict(_os.environ, {name: "garbage"}):
                self.assertEqual(fn(), default, f"{name} typo must fail safe")
        # The SDK default is the documented rollback.
        import os as _os
        from unittest.mock import patch as _patch
        with _patch.dict(_os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "0"}):
            self.assertEqual(phone.phone_min_interruption_words(), 0)

    def test_EVERY_turn_detection_branch_carries_the_tuning(self):
        # THE FOOTGUN. `agent_session.py` ignores every deprecated kwarg the
        # moment `turn_handling` is passed — so tuning set in only one dialect is
        # either dropped itself, or silently drops the endpointing beside it.
        # Each branch must therefore carry a COMPLETE set in its own dialect.
        import inspect
        src = inspect.getsource(agent_mod._build_provider_session)
        start = src.index("turn_detection = phone.phone_turn_detection()")
        end = src.index('error_type="phone_turn_detection"')
        block = src[start:end]
        # deprecated dialect, used by the stt and local branches
        self.assertEqual(block.count('"min_interruption_words"'), 2, block)
        self.assertEqual(block.count('"min_interruption_duration"'), 2, block)
        # turn_handling dialect, used by the dynamic branch alongside endpointing
        self.assertIn('"interruption"', block)
        self.assertIn('"min_words"', block)
        self.assertIn('"min_duration"', block)
        # and the dynamic branch must still carry endpointing in the same dict
        self.assertIn('"endpointing"', block)


class TestPatienceGateDoesNotSWALLOW_an_interrupted_turn(unittest.TestCase):
    """A filler after a CUT-OFF bot line must not be suppressed.

    `StopResponse` is how the patience gate stays quiet while a candidate thinks
    aloud, and that is right when the bot FINISHED speaking. After a barge-in it
    is the freeze: the SDK's `except StopResponse: return` emits no
    `conversation_item_added` at all, so the turn vanishes AND the reply is
    suppressed — the bot stops mid-sentence and waits for a turn that already
    happened. Live 2026-09-12: 8.3s and 9.4s of dead air, broken only when the
    candidate spoke again.

    Source-level because both sites live deep inside `on_native_turn`'s closure;
    the behavioural proof is the mutation battery.
    """

    def test_both_patience_suppressions_check_the_interrupt_latch(self):
        import inspect
        src = inspect.getsource(agent_mod._run_native_phone_screening)
        # One shared read, then both gates consult it.
        self.assertIn("prior_interrupted = bool(", src)
        # Count CODE, not the comment that explains it.
        code = "\n".join(
            line for line in src.splitlines()
            if "not prior_interrupted" in line and not line.lstrip().startswith("#")
        )
        self.assertEqual(
            code.count("not prior_interrupted"), 3,
            f"a patience suppression still swallows an interrupted turn:\n{code}",
        )
        # And the sibling coalesce guard still reads the raw signals.
        self.assertIn('not prior_turn_interrupted["value"]', src)


class TestIdentityReadHasItsOwnBudget(unittest.IsolatedAsyncioTestCase):
    """The identity read must bound SILENCE without cutting off a slow answer.

    On the live 2026-09-12 call the candidate answered, the answer never
    produced a turn, and this reader then sat on the CONSENT classifier's 15s
    budget while he heard nothing — he said "hello" into the gap and that became
    the identity answer. A timeout here is `unclear`, which proceeds to the
    disclosure, so waiting longer cannot improve the verdict; it only adds dead
    air.
    """

    def test_the_GATE_CALL_SITE_uses_the_identity_budget(self):
        # The behavioural tests below drive `_read_fresh_turn` directly with
        # explicit timeouts, so they cannot see WHICH reader the gate passes.
        # Without this, swapping the call site back to the consent classifier's
        # 15s budget is invisible — the exact regression this fix removes.
        import inspect
        src = inspect.getsource(agent_mod._run_phone_session)
        start = src.index("async def _next_candidate_turn()")
        block = src[start:start + 2000]
        self.assertIn("phone.phone_identity_answer_timeout_sec()", block)
        # And the hard cap must still be the OLD budget, so the extension can
        # never wait longer than the behaviour it replaced.
        self.assertIn(
            "hard_timeout_sec=phone.phone_classify_answer_timeout_sec()", block)
        self.assertIn("speaking=", block)

    def test_the_identity_budget_is_SHORTER_than_the_consent_one(self):
        # The whole point. If someone raises the identity default to the consent
        # value the silence comes back, and every behavioural test still passes
        # because they pass their own timeouts.
        self.assertLess(
            phone.phone_identity_answer_timeout_sec(),
            phone.phone_classify_answer_timeout_sec(),
        )

    async def test_a_silent_line_gives_up_on_the_SHORT_budget(self):
        turns: asyncio.Queue = asyncio.Queue()
        started = time.monotonic()
        got = await agent_mod._read_fresh_turn(
            turns, (lambda: None), 0.05,
            speaking=(lambda: False), hard_timeout_sec=5.0,
        )
        self.assertEqual(got, "")
        self.assertLess(
            time.monotonic() - started, 1.0,
            "a silent line waited on the long budget",
        )

    async def test_a_candidate_STILL_SPEAKING_is_not_cut_off(self):
        # The whole reason the short budget is safe. Speech arrives well after
        # the short budget would have expired; because they are audibly
        # speaking, the window extends and the answer is read.
        turns: asyncio.Queue = asyncio.Queue()
        speaking = {"value": True}

        async def _late():
            await asyncio.sleep(0.25)
            speaking["value"] = False
            turns.put_nowait(("Yes, this is Christo.", None))

        task = asyncio.ensure_future(_late())
        self.addCleanup(task.cancel)
        got = await agent_mod._read_fresh_turn(
            turns, (lambda: None), 0.05,
            speaking=(lambda: speaking["value"]), hard_timeout_sec=5.0,
        )
        self.assertEqual(got, "Yes, this is Christo.")

    async def test_the_extension_CANNOT_exceed_the_old_budget(self):
        # A noisy line that reads as "speaking" for ever must still terminate,
        # and never later than the budget this replaced.
        turns: asyncio.Queue = asyncio.Queue()
        started = time.monotonic()
        got = await agent_mod._read_fresh_turn(
            turns, (lambda: None), 0.05,
            speaking=(lambda: True), hard_timeout_sec=0.4,
        )
        self.assertEqual(got, "")
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0, "the speaking extension ran unbounded")
        self.assertGreater(elapsed, 0.2, "the hard cap was not honoured at all")

    async def test_a_BROKEN_speaking_probe_does_not_hang_the_call(self):
        turns: asyncio.Queue = asyncio.Queue()

        def _boom():
            raise RuntimeError("probe exploded")

        got = await agent_mod._read_fresh_turn(
            turns, (lambda: None), 0.05,
            speaking=_boom, hard_timeout_sec=5.0,
        )
        self.assertEqual(got, "")

    async def test_no_speaking_probe_is_the_OLD_behaviour(self):
        # Back-compat: every existing caller passes only a timeout.
        turns: asyncio.Queue = asyncio.Queue()
        got = await agent_mod._read_fresh_turn(turns, (lambda: None), 0.05)
        self.assertEqual(got, "")


class TestSayTranslatesADeadSession(unittest.IsolatedAsyncioTestCase):
    """The `RuntimeError` -> `PhoneParticipantGone` translation.

    The existing gate tests raise `PhoneParticipantGone` from a stub `say`, so
    they prove the gate does not swallow it — never that anything produces it.
    The match is on vendor prose, which is exactly the kind of thing that needs
    a test rather than a comment.
    """

    def test_the_sdk_message_is_translated(self):
        # Drives the REAL translation. The earlier version of this test built a
        # RuntimeError and asserted the string contained its own substring —
        # true of any string, executing no production code, while a mutation
        # that deleted the translation outright kept the whole suite green.
        for message in ("AgentSession isn't running",
                        "the session is not running",
                        "RuntimeError: AgentSession isn't running"):
            got = agent_mod._participant_gone_from(
                RuntimeError(message), category="participant_gone")
            self.assertIsInstance(got, phone.PhoneParticipantGone, message)

    def test_an_UNRELATED_runtime_error_must_not_be_swallowed(self):
        # Catching RuntimeError broadly here would hide real faults behind a
        # routine hang-up — a wedged event loop would look like a hang-up and
        # the attempt would be closed as `deferred_pre_disclosure`.
        for message in ("event loop is closed", "cannot reuse already awaited",
                        ""):
            with self.assertRaises(RuntimeError) as caught:
                agent_mod._participant_gone_from(
                    RuntimeError(message), category="participant_gone")
            self.assertEqual(str(caught.exception), message)

    def test_BOTH_call_sites_use_the_same_translation(self):
        # `say` and `wait_for_playout` each had their own copy of the match. The
        # playout one is the likelier of the two — a model-authored disclosure
        # plays for ten seconds while `session.say` occupies almost none — so a
        # divergence between them would fail on exactly the common case.
        import inspect
        source = inspect.getsource(agent_mod._run_phone_session)
        self.assertEqual(
            source.count("_participant_gone_from"), 2,
            "a call site stopped using the shared translation",
        )
        # Match the inlined COMPARISON, not the prose — the prose also appears
        # in a comment explaining the crash, and asserting on that would make
        # this test fail on documentation.
        self.assertNotIn(
            "not in str(exc)", source,
            "a call site re-inlined the vendor-prose match, which puts it back "
            "inside a closure where no test can reach it",
        )

    def test_the_signal_is_its_own_type(self):
        self.assertTrue(issubclass(phone.PhoneParticipantGone, Exception))
        self.assertFalse(issubclass(phone.PhoneParticipantGone, RuntimeError))


class TestTerminalClosingSurvivesAHangUp(unittest.IsolatedAsyncioTestCase):
    """A hang-up during a terminal's closing line must not post a SECOND terminal.

    `_terminal_outcome` posts its event BEFORE it speaks, deliberately, so the
    purge precedes the terminal. If the closing `_say` then escapes, the call
    site's participant-gone handler posts `candidate.deferred_pre_disclosure` on
    top of the refusal — on the commonest refusal path there is ("no thanks",
    then hang up).
    """

    async def test_a_refusal_posts_exactly_one_terminal(self):
        posted: list[str] = []

        class _Client:
            async def post_event(self, _attempt, event_type, **_kw):
                posted.append(event_type)
                return phone.PhoneApiOutcome(
                    ok=True, status=phone.EVENT_STATUS_APPLIED)

        spoken: list[str] = []

        async def _say(text):
            spoken.append(text)
            # The leg drops WHILE the refusal closing plays — the disclosure and
            # everything before it went out fine. Raising on every call instead
            # would never reach the terminal at all.
            if text == phone.PHONE_REFUSED_TEXT:
                raise phone.PhoneParticipantGone()

        async def _classify():
            return phone.CLASSIFY_REFUSED

        result = await phone.run_phone_gate(
            attempt_id="a1",
            client=_Client(),
            wait_for_participant=lambda: asyncio.sleep(0, result=object()),
            classify=_classify,
            say=_say,
            session_id="s1",
            epoch=1,
        )
        self.assertEqual(result.outcome, phone.CLASSIFY_REFUSED)
        self.assertEqual(
            posted.count("candidate.deferred_pre_disclosure"), 0,
            f"a second terminal was posted over the refusal: {posted}",
        )
        self.assertIn("disclosure.refused", posted)
        self.assertIn(phone.PHONE_REFUSED_TEXT, spoken)


# ═══════════════════════════════════════════════════════════════════════════
#  M013 S01 T01b — the gate's own capture: per-segment anchors, FIFO pairing,
#  closed turns, consume-once. Driven on `gate_judge.GateTurnCapture` with a
#  manual clock; the replays in test_phone_gate_replay.py drive the same code
#  through the real readers.
# ═══════════════════════════════════════════════════════════════════════════


class TestPerSegmentAnchors(unittest.TestCase):
    """Each reply is timed by the VAD speech that produced it."""

    def test_a_segment_starts_where_the_SDK_formula_says(self):
        # start = now - speech_duration - inference_duration (audio_recognition.py)
        rig = _Rig()
        rig.vad(5_060, "start_of_speech", speech_ms=50, inference_ms=10)
        rig.vad(5_756, "end_of_speech", speech_ms=500, silence_ms=256)
        utterance = rig.final(6_000, "Yes")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 5_000)
        self.assertEqual(rig.rel(utterance.segment_end_ms), 5_500)
        self.assertEqual(utterance.segment_speech_ms, 500)

    def test_the_commit_is_timed_by_its_segment_NOT_the_sdk_carried_start(self):
        # 9f60523d in miniature: a blip at 1000 never produced a final, so the
        # SDK still reports it as the reply's speech start.
        rig = _Rig()
        rig.segment(1_000, 1_200)
        rig.segment(9_000, 9_800)
        rig.final(10_300, "Yes, we can continue.")
        turn = rig.commit(10_310, "Yes, we can continue.", sdk_anchor_rel=1_000)
        self.assertEqual(rig.rel(turn.anchor_ms), 9_000)
        self.assertTrue(turn.grant_eligible)
        self.assertFalse(agent_mod._queued_turn_is_stale(turn.anchor_ms, _T0 + 5_000))

    def test_with_no_vad_on_the_call_the_sdk_start_is_the_fallback(self):
        # A test double or an SDK without the observed VAD stream: today's
        # behaviour, unchanged.
        rig = _Rig()
        turn = rig.commit(10_310, "Yes", sdk_anchor_rel=9_000)
        self.assertEqual(turn.closed_by, "commit_only")
        self.assertEqual(rig.rel(turn.anchor_ms), 9_000)
        self.assertTrue(turn.grant_eligible)

    def test_a_mock_sdk_anchor_is_ignored_not_trusted(self):
        rig = _Rig()
        turn = rig.capture.on_commit("Yes", MagicMock())
        self.assertIsNone(turn.anchor_ms)

    def test_every_final_logs_its_speech_duration_and_no_text(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Yes, go ahead.")
        finals = [f for f in rig.logs if f["error_type"] == "phone_gate_final"]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0]["error_category"], "paired")
        self.assertEqual(finals[0]["duration_sec"], 0.5)
        self.assertEqual(finals[0]["option_count"], 1)
        self.assertNotIn("go ahead", str(rig.logs))


class TestFifoPairing(unittest.TestCase):
    """A final takes the OLDEST unpaired closed segments that ended before it."""

    def test_one_final_covers_several_segments(self):
        rig = _Rig()
        rig.segment(22_378, 23_333)
        rig.segment(23_700, 24_732)
        utterance = rig.final(25_618, "Yes, we can continue.")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 22_378)
        self.assertEqual(rig.rel(utterance.segment_end_ms), 24_732)
        self.assertEqual(rig.rel(utterance.segment_first_end_ms), 23_333)
        # The LONGEST paired segment (review fix: never the sum, so blips
        # cannot add up to the acoustic minimum).
        self.assertEqual(utterance.segment_speech_ms, 1_032)

    def test_ATTACK_a_noise_segment_after_the_question_cannot_lend_its_start(self):
        # Identity "Yes" 2000-2600; consent question heard at 4000; noise
        # 4200-4400 with no final; the identity final lands at 4700. Pairing
        # with "the latest segment started before the final" would stamp it
        # 4200 and make it consent.
        rig = _Rig()
        rig.segment(2_000, 2_600)
        rig.segment(4_200, 4_400)
        utterance = rig.final(4_700, "Yes")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 2_000)
        tags = rig.capture.utterances.tagged(_T0 + 4_000)
        self.assertEqual(tags[0].tag, gate_judge.TAG_PRE_QUESTION)

    def test_a_blip_with_no_final_EXPIRES_and_never_shifts_a_later_pairing(self):
        rig = _Rig()
        rig.segment(1_974, 2_174)        # blip, no final
        rig.segment(8_150, 9_532)        # a reply STT never finalised
        rig.segment(22_378, 23_333)
        utterance = rig.final(23_900, "Yes")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 22_378)
        # ...and the expired ones are gone for good, not paired with the next.
        rig.segment(30_000, 30_400)
        second = rig.final(30_900, "Okay")
        self.assertEqual(rig.rel(second.segment_start_ms), 30_000)

    def test_two_finals_for_two_segments_pair_separately(self):
        rig = _Rig()
        rig.segment(5_000, 5_400)
        first = rig.final(5_800, "Yes")
        rig.segment(6_100, 7_600)
        second = rig.final(8_000, "but I'm busy right now")
        self.assertEqual(rig.rel(first.segment_start_ms), 5_000)
        self.assertEqual(rig.rel(second.segment_start_ms), 6_100)

    def test_a_final_mid_segment_shares_the_OPEN_segments_start(self):
        rig = _Rig()
        rig.vad(5_060, "start_of_speech", speech_ms=50, inference_ms=10)
        utterance = rig.final(7_000, "So the thing is")
        self.assertEqual(rig.rel(utterance.segment_start_ms), 5_000)
        self.assertIsNone(utterance.segment_end_ms)
        self.assertEqual(rig.capture.utterances.tagged(_T0 + 6_000)[0].tag,
                         gate_judge.TAG_DURING_QUESTION)

    def test_a_second_final_of_consumed_speech_shares_its_segment(self):
        rig = _Rig()
        rig.segment(5_000, 6_000)
        rig.final(6_500, "Yes")
        again = rig.final(6_900, "that is fine")
        self.assertEqual(rig.rel(again.segment_start_ms), 5_000)

    def test_a_final_with_NO_pairable_segment_is_never_grant_evidence(self):
        rig = _Rig()
        rig.segment(1_000, 1_200)
        utterance = rig.final(9_000, "Yes")          # 7.8 s later: expired
        self.assertIsNone(utterance.segment_start_ms)
        self.assertEqual(
            [f["error_category"] for f in rig.logs if f["error_type"] == "phone_gate_final"],
            [gate_judge.TAG_NO_SEGMENT])
        rig.timers.advance(20_000)                   # closed by silence
        turn = rig.emitted[0]
        self.assertEqual(turn.closed_by, "settle")
        self.assertIsNone(turn.anchor_ms)
        self.assertFalse(turn.grant_eligible)
        self.assertFalse(gate_judge.turn_is_grant_evidence(turn))
        self.assertTrue(gate_judge.turn_is_grant_evidence(("Yes", 1)))


class TestFinalCapturedWhenCommitDropped(unittest.TestCase):
    """A turn the SDK drops (committed during a gate line) is not lost."""

    def test_a_final_with_no_commit_is_CLOSED_by_silence(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Yes, go ahead.")
        rig.timers.advance(6_000 + rig.SETTLE_MS - 1)
        self.assertEqual(rig.emitted, [], "closed before the endpointing ceiling")
        rig.timers.advance(6_000 + rig.SETTLE_MS)
        self.assertEqual(len(rig.emitted), 1)
        turn = rig.emitted[0]
        self.assertEqual((turn.text, turn.closed_by, turn.committed),
                         ("Yes, go ahead.", "settle", False))
        self.assertEqual(rig.rel(turn.anchor_ms), 5_000)

    def test_the_silence_close_waits_while_the_candidate_is_still_speaking(self):
        rig = _Rig()
        rig.segment(5_000, 5_400)
        rig.final(5_800, "Yes")
        rig.vad(6_160, "start_of_speech", speech_ms=50, inference_ms=10)
        rig.timers.advance(9_000)
        self.assertEqual(rig.emitted, [], "closed while a segment was open")
        rig.vad(9_256, "end_of_speech", speech_ms=2_900, silence_ms=256)
        rig.final(9_500, "but I'm busy right now")
        rig.timers.advance(9_500 + rig.SETTLE_MS)
        self.assertEqual([t.text for t in rig.emitted], ["Yes but I'm busy right now"])

    def test_the_grant_evidence_row_is_written_ONCE_and_only_for_an_uncommitted_turn(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Yes, go ahead.")
        rig.timers.advance(8_000)
        dropped = rig.emitted[0]
        keys: set[str] = set()
        row = agent_mod._gate_evidence_row(dropped, keys, rig.capture)
        self.assertEqual(row, ("candidate", "Yes, go ahead.", dropped.anchor_ms, "final-0"))
        self.assertIsNone(agent_mod._gate_evidence_row(dropped, keys), "written twice")
        self.assertEqual(agent_mod._gate_source_item_id("final-0"), "phone-gate-final-0")
        self.assertEqual(agent_mod._gate_source_item_id(7), "phone-gate-item-7")
        committed = dataclasses_replace(dropped, committed=True)
        self.assertIsNone(agent_mod._gate_evidence_row(committed, set()),
                          "a committed turn already has its conversation row")
        self.assertIsNone(agent_mod._gate_evidence_row(("Yes", 1), set()))

    def _granted_on_a_dropped_turn(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Yes, go ahead.")
        rig.timers.advance(8_000)
        keys: set[str] = set()
        row = agent_mod._gate_evidence_row(rig.emitted[0], keys, rig.capture)
        self.assertIsNotNone(row)
        return rig, keys

    def test_a_late_commit_AFTER_the_evidence_row_writes_no_second_row(self):
        rig, keys = self._granted_on_a_dropped_turn()
        self.assertIsNone(rig.commit(8_200, "Yes, go ahead.", sdk_anchor_rel=5_000))
        # The SDK then adds the kept commit to the chat context.
        self.assertTrue(agent_mod._gate_user_row_is_evidence_echo(
            "Yes, go ahead.", rig.capture, keys))
        # Consumed once: the same words said AGAIN later are written.
        rig.segment(12_000, 12_500)
        rig.final(13_000, "Yes, go ahead.")
        rig.commit(13_100, "Yes, go ahead.")
        self.assertFalse(agent_mod._gate_user_row_is_evidence_echo(
            "Yes, go ahead.", rig.capture, keys))

    def test_a_late_commit_BEFORE_the_grant_is_read_means_no_evidence_row(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Yes, go ahead.")
        rig.timers.advance(8_000)
        settled = rig.emitted[0]
        rig.commit(8_200, "Yes, go ahead.", sdk_anchor_rel=5_000)   # row written by SDK item
        keys: set[str] = set()
        self.assertFalse(agent_mod._gate_user_row_is_evidence_echo(
            "Yes, go ahead.", rig.capture, keys), "the only row was suppressed")
        self.assertIsNone(agent_mod._gate_evidence_row(settled, keys, rig.capture),
                          "the grant wrote a second row for words already written")

    def test_a_dropped_turn_never_committed_keeps_its_evidence_row(self):
        rig, keys = self._granted_on_a_dropped_turn()
        # A later, different utterance is written normally.
        rig.segment(12_000, 12_500)
        rig.final(13_000, "Okay")
        rig.commit(13_100, "Okay")
        self.assertFalse(agent_mod._gate_user_row_is_evidence_echo("Okay", rig.capture, keys))

    def test_a_dropped_hang_up_request_is_still_honoured(self):
        # `on_candidate_turn` honours an explicit end-call request; a dropped
        # turn never reaches it, so the session's emit does (source pin).
        import inspect
        src = inspect.getsource(agent_mod._run_phone_session)
        emit = src[src.index("def _emit_gate_turn("):]
        emit = emit[:emit.index("gate_capture = _new_gate_turn_capture")]
        self.assertIn('turn.closed_by == "settle"', emit)
        self.assertIn("phone.is_explicit_end_call_request(turn.text)", emit)
        self.assertIn("candidate_end_requested.set()", emit)


def dataclasses_replace(obj, **changes):
    import dataclasses
    return dataclasses.replace(obj, **changes)


class TestClosedTurnNotFragment(unittest.TestCase):
    """Readers classify CLOSED turns: "Yes" + "but I'm busy" is one reply."""

    def _two_finals(self) -> _Rig:
        rig = _Rig()
        rig.segment(5_000, 5_400)
        rig.final(5_800, "Yes")
        rig.segment(6_100, 7_600)
        rig.final(8_000, "but I'm busy right now")
        return rig

    def test_one_commit_of_two_finals_is_ONE_turn_and_routes_to_callback(self):
        rig = self._two_finals()
        turn = rig.commit(8_500, "Yes but I'm busy right now", sdk_anchor_rel=5_000)
        self.assertEqual(rig.emitted, [turn])
        self.assertEqual(turn.utterance_idxs, (0, 1))
        self.assertEqual(turn.text, "Yes but I'm busy right now")
        self.assertEqual(agent_mod.classify_answer_text(turn.text),
                         phone.CLASSIFY_CALLBACK_REQUESTED)

    def test_a_dropped_two_final_turn_also_closes_as_one(self):
        rig = self._two_finals()
        rig.timers.advance(20_000)
        self.assertEqual([t.text for t in rig.emitted], ["Yes but I'm busy right now"])
        self.assertNotEqual(agent_mod.classify_answer_text(rig.emitted[0].text),
                            phone.CLASSIFY_HUMAN)

    def test_a_commit_of_the_FIRST_final_only_leaves_the_second_open(self):
        # The SDK committed "Yes" on its own (its decision, today's behaviour);
        # the second final becomes its own turn, never merged into the first.
        rig = _Rig()
        rig.segment(5_000, 5_400)
        rig.final(5_800, "Yes")
        first = rig.commit(5_900, "Yes", sdk_anchor_rel=5_000)
        rig.segment(6_100, 7_600)
        rig.final(8_000, "but I'm busy right now")
        second = rig.commit(8_400, "but I'm busy right now", sdk_anchor_rel=6_100)
        self.assertEqual([t.text for t in rig.emitted], ["Yes", "but I'm busy right now"])
        self.assertEqual((first.utterance_idxs, second.utterance_idxs), ((0,), (1,)))


class TestConsumedOnce(unittest.IsolatedAsyncioTestCase):
    """Each final reaches a reader once; a late commit is never re-read."""

    def test_a_commit_after_the_silence_close_is_NOT_emitted_again(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Hmm")
        rig.timers.advance(8_000)
        self.assertEqual(len(rig.emitted), 1)
        self.assertIsNone(rig.commit(8_200, "Hmm", sdk_anchor_rel=5_000))
        self.assertEqual(len(rig.emitted), 1)
        self.assertEqual(
            [f["error_category"] for f in rig.logs
             if f["error_type"] == "phone_gate_turn_barrier"],
            ["commit_duplicate"])
        self.assertTrue(rig.capture.utterances.get(0).committed)

    def test_the_same_words_said_AGAIN_are_a_new_turn(self):
        rig = _Rig()
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Yes")
        rig.commit(6_100, "Yes")
        rig.segment(9_000, 9_400)
        rig.final(9_800, "Yes")
        rig.commit(9_900, "Yes")
        self.assertEqual([t.utterance_idxs for t in rig.emitted], [(0,), (1,)])

    async def test_a_re_ask_is_never_answered_by_the_ECHO_of_the_reply_that_caused_it(self):
        rig = _Rig()
        turns: asyncio.Queue = asyncio.Queue()
        rig.capture._emit = turns.put_nowait
        # "Hmm" over the consent line: dropped by the SDK, closed by silence.
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Hmm")
        rig.timers.advance(8_000)
        said: list[str] = []

        async def _say(text):
            said.append(text)
            # While the re-ask plays the SDK's late commit of "Hmm" lands; then
            # the candidate really answers.
            rig.commit(12_000, "Hmm", sdk_anchor_rel=5_000)
            rig.segment(14_000, 14_500)
            rig.final(15_000, "Yes, go ahead.")
            rig.commit(15_100, "Yes, go ahead.")

        consumed: list[str] = []
        decision = await agent_mod._classify_phone_answer(
            turns, _say, answer_timeout_sec=0.2, consumed=consumed,
            question_anchor=(lambda: _T0 + 4_000))
        self.assertEqual(said, [phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT])
        self.assertEqual(consumed, ["Hmm", "Yes, go ahead."])
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)

    def test_the_capture_stops_with_the_gate(self):
        rig = _Rig()
        rig.capture.stop()
        rig.segment(5_000, 5_500)
        self.assertIsNone(rig.final(6_000, "Yes"))
        rig.timers.advance(10_000)
        self.assertEqual(rig.emitted, [])
        # A commit after the gate passes straight through, as before.
        turn = rig.commit(10_100, "Yes", sdk_anchor_rel=5_000)
        self.assertEqual((turn.closed_by, rig.rel(turn.anchor_ms)), ("commit_only", 5_000))


class TestSkipIsLogged(unittest.IsolatedAsyncioTestCase):
    """No skip is silent: the consent reader's skip at 2959-2963 is now logged."""

    async def test_the_consent_reader_logs_every_skip_with_tag_and_deltas(self):
        rig = _Rig()
        turns: asyncio.Queue = asyncio.Queue()
        rig.capture._emit = turns.put_nowait
        rig.segment(2_000, 2_600)          # identity reply, before the question
        rig.final(3_000, "Yes, that's me.")
        rig.commit(3_100, "Yes, that's me.")
        rig.segment(5_000, 5_500)
        rig.final(6_000, "Sure, go ahead.")
        rig.commit(6_100, "Sure, go ahead.")
        sink = _LogSink()

        async def _say(_text):
            return None

        with patch.object(agent_mod, "_log", sink):
            decision = await agent_mod._classify_phone_answer(
                turns, _say, answer_timeout_sec=0.05,
                question_anchor=(lambda: _T0 + 4_000))
        self.assertEqual(decision, phone.CLASSIFY_HUMAN)
        skips = sink.of("phone_gate_turn_barrier", "consent_turn_skipped")
        self.assertEqual(len(skips), 1)
        self.assertEqual(skips[0]["phase"], gate_judge.TAG_PRE_QUESTION)
        self.assertEqual(skips[0]["schema"],
                         "anchor_ms:-2000_final_ms:-1000_segment_ms:-2000")
        self.assertNotIn("that's me", str(sink.records))

    def test_the_delta_schema_survives_the_structured_logger(self):
        # The logger allowlists its keys and drops non-identifier strings; the
        # skip's deltas must come through the REAL logger intact.
        import json
        import observability
        lines: list[str] = []
        logger = observability.StructuredLogger("voice-test", writer=lines.append)
        schema = gate_judge.delta_schema(anchor_ms=-3_600_000, final_ms=None, segment_ms=12)
        logger.info("unknown_event", error_type="phone_gate_turn_barrier",
                    error_category="consent_turn_skipped",
                    phase=gate_judge.TAG_DURING_QUESTION, schema=schema)
        entry = json.loads(lines[0])
        self.assertEqual(entry["schema"], schema)
        self.assertEqual(entry["phase"], "during_question")
        self.assertLessEqual(len(gate_judge.delta_schema(
            anchor_ms=-99_999_999, final_ms=-99_999_999, segment_ms=-99_999_999)), 64)

    def test_the_consent_skip_site_is_no_longer_a_bare_continue(self):
        import inspect
        src = inspect.getsource(agent_mod._classify_phone_answer)
        stale = src[src.index("_queued_turn_is_stale("):]
        self.assertIn('"consent_turn_skipped"', stale[:400])


class TestGateJudgeModuleIsStandalone(unittest.TestCase):
    """`gate_judge` imports without livekit and without phone/agent."""

    def test_it_imports_with_livekit_BLOCKED_and_pulls_in_no_worker_module(self):
        import os
        import subprocess
        import sys
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        code = (
            "import sys\n"
            "for name in ('livekit', 'livekit.agents', 'livekit.rtc'):\n"
            "    sys.modules[name] = None\n"
            "import gate_judge\n"
            "assert 'phone' not in sys.modules, 'gate_judge imported phone'\n"
            "assert 'agent' not in sys.modules, 'gate_judge imported agent'\n"
            "print('ok')\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=here, capture_output=True, text=True,
            timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ok", result.stdout)

    def test_normalisation_keeps_devanagari_matras(self):
        self.assertEqual(gate_judge.normalize_gate_text("  Yes,   GO ahead! "), "yes go ahead")
        self.assertEqual(gate_judge.normalize_gate_text("हाँ, ठीक है।"), "हाँ ठीक है")


if __name__ == "__main__":
    unittest.main()
