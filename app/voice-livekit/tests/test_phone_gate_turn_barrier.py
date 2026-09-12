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
import phone  # noqa: E402


def _msg(started_speaking_at: float | None = None, created_at: float | None = None):
    """A ChatMessage-shaped stub: `metrics` is a Mapping at runtime."""
    metrics = {} if started_speaking_at is None else {
        "started_speaking_at": started_speaking_at
    }
    return types.SimpleNamespace(metrics=metrics, created_at=created_at)


class TestQueuedTurnUnpacking(unittest.TestCase):
    """`_queued_turn` — the tolerance that keeps the older seam working."""

    def test_it_unpacks_the_pair_the_live_producer_enqueues(self):
        self.assertEqual(agent_mod._queued_turn(("hello", 1234)), ("hello", 1234))

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
        self.assertNotIn(phone.PHONE_REASK_TEXT, said,
                         "a stale turn burned the single re-ask")

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

    async def test_only_stale_turns_falls_closed_to_MACHINE(self):
        decision, _, consumed = await self._classify(
            [("Hello?", 1_000), ("Hello?", 1_100)], anchor=5_000,
        )
        self.assertEqual(decision, phone.CLASSIFY_MACHINE)
        self.assertEqual(consumed, [], "a stale turn was consumed as consent")


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
            ("PHONE_MIN_INTERRUPTION_WORDS",
             phone.phone_min_interruption_words, 2),
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
            code.count("not prior_interrupted"), 2,
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


if __name__ == "__main__":
    unittest.main()
