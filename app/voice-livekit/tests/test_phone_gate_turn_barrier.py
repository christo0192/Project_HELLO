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
        # `_mark_question_asked` re-arms the anchor for each gate question, so
        # the reader must see the CURRENT one. Captured at call time, the second
        # question would be judged against the first question's anchor and the
        # first question's trailing answer would be read as the second's.
        anchor = {"ms": 1_000}
        turns: asyncio.Queue = asyncio.Queue()
        turns.put_nowait(("answer to question one", 2_000))
        got = await agent_mod._read_fresh_turn(
            turns, (lambda: anchor["ms"]), 0.05)
        self.assertEqual(got, "answer to question one")

        anchor["ms"] = 9_000          # question two is asked
        turns.put_nowait(("answer to question one", 2_000))
        self.assertEqual(
            await agent_mod._read_fresh_turn(
                turns, (lambda: anchor["ms"]), 0.05),
            "",
            "a stale answer was re-read against the NEXT question's anchor",
        )


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
