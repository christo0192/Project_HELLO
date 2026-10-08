"""M014 S02: endpointing, the pending-final hold and the per-phase minimum.

The 2026-10-08 interruption RCA: Sarvam is finals-only (a final arrives
~0.9-1.0 s after the candidate stops), so the SDK started or resumed the bot's
reply on 0.15-0.25 s of quiet, long before the words existed, and committed
stale text on a VAD end-of-speech. `turn_hold` holds the reply while the VAD
heard speech no STT final has covered yet, merges the late final into the
turn, and applies a longer minimum while the bot waits for an OPEN answer.

Synthetic text and timelines only: no candidate data. Runs on bare python3
(SDK stubbed via the shared `test_phone_gate` fixtures); the real-SDK facts
these tests rest on are pinned in `test_endpointing_sdk_contract.py`.
"""

from __future__ import annotations

import asyncio
import io
import os
import pathlib
import re
import sys
import time
import tomllib
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures

import turn_hold  # noqa: E402

agent_mod = fixtures.agent_mod
phone = fixtures.phone

_CTX = pathlib.Path(__file__).resolve().parent.parent  # app/voice-livekit
_REPO = _CTX.parent.parent

_ENV_KEYS = (
    "PHONE_OPEN_ANSWER_MIN_DELAY_SEC", "PHONE_PENDING_FINAL_HOLD_MAX_SEC",
    "PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC", "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC",
    "PHONE_DYNAMIC_ENDPOINTING", "PHONE_TURN_DETECTION",
)


class _Env:
    """Exactly ``env`` for the relevant keys, restored afterwards."""

    def __init__(self, env: dict | None = None):
        self._env = env or {}

    def __enter__(self):
        self._prior = {k: os.environ.get(k) for k in _ENV_KEYS}
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        os.environ.update(self._env)
        return self

    def __exit__(self, *exc):
        for k, v in self._prior.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


class _Stop(Exception):
    """Stand-in for livekit.agents.StopResponse."""


class _Log:
    def __init__(self):
        self.rows: list[tuple[str, dict]] = []

    def __call__(self, event, **meta):
        self.rows.append((meta.get("error_category"), meta))

    def categories(self) -> list:
        return [c for c, _ in self.rows]

    def meta(self, category):
        return [m for c, m in self.rows if c == category]


def _msg(text, anchor=None):
    return types.SimpleNamespace(
        text_content=text,
        content=[text],
        metrics={"started_speaking_at": anchor} if anchor is not None else {},
    )


def _make(*, active=True, cap=0.3, **kwargs):
    state = {"active": active}
    tracker = turn_hold.PendingFinalTracker(lambda: state["active"])
    log = _Log()
    kwargs.setdefault("stop_response", _Stop)
    hold = turn_hold.TurnHold(
        tracker, hold_max_sec=lambda: cap, log=log, **kwargs)
    return tracker, hold, log, state


def _pend(tracker, *, start_ago=1.0, end_ago=0.5):
    """Speech that ended `end_ago` s ago and that no final has covered."""
    now = time.time()
    tracker.on_speech_start(now - start_ago)
    tracker.on_speech_end(now - end_ago)


def _created(hold, **kwargs):
    """A generated reply is created and its first audio is released."""
    hold.on_speech_created(**kwargs)
    hold.first_audio_released()


def _count_waits(tracker) -> list:
    calls: list = []
    original = tracker.wait_change

    async def counted(timeout):
        calls.append(timeout)
        return await original(timeout)

    tracker.wait_change = counted
    return calls


# ── 4.1 readers and manifest ─────────────────────────────────────────────────

class TestReaders(unittest.TestCase):
    def test_open_answer_min_defaults_and_clamps(self):
        cases = (
            (None, 0.8), ("", 0.8), ("0.8", 0.8), ("0.1", 0.3), ("5", 1.2),
            ("nope", 0.8), ("nan", 0.8), ("inf", 0.8), ("0.5", 0.5),
        )
        for raw, expected in cases:
            env = {"PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "2.0"}
            if raw is not None:
                env["PHONE_OPEN_ANSWER_MIN_DELAY_SEC"] = raw
            with self.subTest(raw=raw), _Env(env):
                self.assertAlmostEqual(phone.phone_open_answer_min_delay(), expected)

    def test_open_answer_min_never_exceeds_the_max(self):
        with _Env({
            "PHONE_OPEN_ANSWER_MIN_DELAY_SEC": "1.0",
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "0.6",
        }):
            self.assertAlmostEqual(phone.phone_open_answer_min_delay(), 0.6)

    def test_pending_final_hold_defaults_and_clamps(self):
        cases = (
            (None, 2.0), ("", 2.0), ("2.0", 2.0), ("0", 0.0), ("-1", 0.0),
            ("9", 3.0), ("x", 2.0), ("nan", 2.0), ("1.5", 1.5),
        )
        for raw, expected in cases:
            with self.subTest(raw=raw), _Env(
                {} if raw is None else {"PHONE_PENDING_FINAL_HOLD_MAX_SEC": raw}
            ):
                self.assertAlmostEqual(phone.phone_pending_final_hold_max_sec(), expected)

    def test_the_toml_pins_the_four_values_and_no_secret_is_needed(self):
        env = tomllib.loads((_CTX / "fly.phone.toml").read_text(encoding="utf-8"))["env"]
        self.assertEqual(env["PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC"], "2.0")
        self.assertEqual(env["PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC"], "0.3")
        self.assertEqual(env["PHONE_OPEN_ANSWER_MIN_DELAY_SEC"], "0.8")
        self.assertEqual(env["PHONE_PENDING_FINAL_HOLD_MAX_SEC"], "2.0")
        # Honoured by the readers, not clamped away.
        with _Env({k: env[k] for k in (
            "PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC",
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC",
            "PHONE_OPEN_ANSWER_MIN_DELAY_SEC",
            "PHONE_PENDING_FINAL_HOLD_MAX_SEC",
        )}):
            self.assertAlmostEqual(phone.phone_static_endpointing_max_delay(), 2.0)
            self.assertAlmostEqual(phone.phone_static_endpointing_min_delay(), 0.3)
            self.assertAlmostEqual(phone.phone_open_answer_min_delay(), 0.8)
            self.assertAlmostEqual(phone.phone_pending_final_hold_max_sec(), 2.0)

    def test_the_schema_and_env_example_declare_both_new_names(self):
        import json
        schema = json.loads(
            (_REPO / "config" / "environment.schema.json").read_text(encoding="utf-8"))
        variables = schema["components"]["voice-livekit"]["variables"]
        example = (_CTX / ".env.example").read_text(encoding="utf-8")
        for name in ("PHONE_OPEN_ANSWER_MIN_DELAY_SEC", "PHONE_PENDING_FINAL_HOLD_MAX_SEC"):
            with self.subTest(name=name):
                self.assertIn(name, variables)
                self.assertFalse(variables[name]["requiredInProduction"])
                self.assertFalse(variables[name]["secret"])
                self.assertRegex(example, rf"(?m)^{name}=")

    def test_the_dockerfile_ships_the_new_module(self):
        dockerfile = (_CTX / "Dockerfile").read_text(encoding="utf-8")
        self.assertRegex(dockerfile, r"(?m)^COPY .*\bturn_hold\.py\b")

    def test_the_gate_consent_max_tightening_is_untouched(self):
        with _Env():
            self.assertAlmostEqual(phone.phone_consent_endpointing_max_delay(), 0.5)


# ── 4.2 classifier ───────────────────────────────────────────────────────────

class TestClassifier(unittest.TestCase):
    def test_the_table(self):
        table = (
            ("screening", "Tell me about your last role", "open"),
            ("screening",
             "Would you be comfortable working from the office and are you open to relocating?",
             "short"),
            ("screening", "When can you join?", "open"),
            ("screening", "Do you have a laptop?", "short"),
            ("name_confirm", "Do you have a laptop?", "short"),
            ("name_confirm", "Tell me about your last role", "short"),
            ("candidate_qna", "Do you have a laptop?", "open"),
            (None, "Tell me about your last role", "short"),
            ("callback", "When can we call you back?", "short"),
            ("closing", "", "short"),
            ("wind_down", "", "open"),
            ("resume_conflict", "", "open"),
            ("patience", "", "open"),
            ("post_interrupt_ack", "", "open"),
            ("something_new", "Tell me more", "short"),
        )
        for phase, objective, expected in table:
            with self.subTest(phase=phase, objective=objective):
                self.assertEqual(
                    turn_hold.classify_answer_endpointing(phase, objective), expected)

    def test_a_missing_objective_in_screening_is_open(self):
        self.assertEqual(turn_hold.classify_answer_endpointing("screening", None), "open")

    def test_yes_no_detection_edges(self):
        yes_no = (
            "Do you have a laptop?",
            "Great, are you currently employed?",
            "Okay. Can you start next month?",
            "Is that a hard requirement, or would you consider remote?",
        )
        for text in yes_no:
            with self.subTest(text=text):
                self.assertTrue(turn_hold.is_yes_no_question(text))
        not_yes_no = (
            "What is your notice period?",
            "How do you handle a late release?",
            "Walk me through your last project.",
            "Do you want to tell me about the team you led?",
            "",
            None,
        )
        for text in not_yes_no:
            with self.subTest(text=text):
                self.assertFalse(turn_hold.is_yes_no_question(text))


# ── 4.3 tracker truth table ──────────────────────────────────────────────────

class TestTrackerTruthTable(unittest.TestCase):
    def _t(self):
        return turn_hold.PendingFinalTracker(lambda: True)

    def test_covered_segment_is_not_pending(self):
        t = self._t()
        t.on_speech_start(0.0)
        t.on_speech_end(1.2)
        t.on_final(2.1, "hello there")
        self.assertFalse(t.pending(2.2))

    def test_uncovered_segment_after_the_last_final_is_pending(self):
        t = self._t()
        t.on_speech_start(0.0)
        t.on_speech_end(1.2)
        t.on_final(2.1, "hello there")
        t.on_speech_start(3.0)
        t.on_speech_end(3.9)
        self.assertTrue(t.pending(4.0))

    def test_a_final_too_soon_after_the_end_does_not_cover(self):
        t = self._t()
        t.on_speech_start(3.0)
        t.on_speech_end(3.9)
        t.on_final(4.1, "earlier words")  # < 3.9 + 0.4
        self.assertTrue(t.pending(4.2))

    def test_a_final_after_the_margin_covers(self):
        t = self._t()
        t.on_speech_start(3.0)
        t.on_speech_end(3.9)
        t.on_final(4.6, "those words")  # >= 3.9 + 0.4
        self.assertFalse(t.pending(4.7))

    def test_open_segment_threshold(self):
        t = self._t()
        t.on_speech_start(10.0)
        self.assertFalse(t.pending(10.2))
        self.assertTrue(t.pending(10.35))

    def test_a_stuck_open_segment_is_ignored_after_ten_seconds(self):
        self.assertEqual(turn_hold.OPEN_SEGMENT_STALE_SEC, 10.0)
        t = self._t()
        t.on_speech_start(10.0)            # its end event was lost
        self.assertTrue(t.pending(15.0))
        self.assertTrue(t.open_segment_stale(10.0 + turn_hold.OPEN_SEGMENT_STALE_SEC))
        self.assertFalse(t.open_segment_stale(15.0))
        self.assertFalse(t.pending(10.0 + turn_hold.OPEN_SEGMENT_STALE_SEC + 1.0))
        t.clock = lambda: 10.0 + turn_hold.OPEN_SEGMENT_STALE_SEC + 1.0
        self.assertFalse(t.candidate_speaking())
        self.assertFalse(t.needs_hold())

    def test_needs_hold_includes_a_young_open_segment(self):
        """An open segment always means hold, even before it is 0.3 s old (the
        first-audio hold must not release into the candidate's next sentence)."""
        t = self._t()
        t.on_speech_start(10.0)
        t.clock = lambda: 10.1
        self.assertFalse(t.pending(10.1))
        self.assertTrue(t.candidate_speaking())
        self.assertTrue(t.needs_hold())

    def test_a_blip_after_a_final_is_not_pending(self):
        t = self._t()
        t.on_speech_start(19.0)
        t.on_speech_end(19.8)
        t.on_final(20.3, "words")   # >= 19.8 + 0.4: covers the segment
        t.on_speech_start(20.5)
        t.on_speech_end(20.6)
        self.assertFalse(t.pending(20.7))

    def test_events_while_inactive_are_ignored_even_after_activation(self):
        state = {"active": False}
        t = turn_hold.PendingFinalTracker(lambda: state["active"])
        t.on_speech_start(1.0)
        t.on_speech_end(2.0)
        t.on_final(3.0, "gate words")
        state["active"] = True
        self.assertIsNone(t.armed_at)
        self.assertEqual(t.final_count, 0)
        self.assertFalse(t.pending(4.0))
        self.assertFalse(t.candidate_speaking())

    def test_speech_before_arming_is_never_pending(self):
        state = {"active": False}
        t = turn_hold.PendingFinalTracker(lambda: state["active"])
        t.on_speech_start(1.0)
        t.on_speech_end(2.0)
        state["active"] = True
        t.on_speech_start(10.0)
        t.on_speech_end(11.0)
        self.assertEqual(t.armed_at, 10.0)
        self.assertTrue(t.pending(11.1))
        t.on_final(12.0, "x")
        self.assertFalse(t.pending(12.1))

    def test_an_end_without_an_open_start_is_ignored(self):
        t = self._t()
        t.on_speech_end(5.0)
        self.assertIsNone(t.armed_at)
        self.assertFalse(t.pending(6.0))

    def test_an_empty_final_neither_counts_nor_covers(self):
        t = self._t()
        t.on_speech_start(3.0)
        t.on_speech_end(3.9)
        t.on_final(4.5, "   ")
        self.assertEqual(t.final_count, 0)
        self.assertIsNone(t.last_final_wall)
        self.assertTrue(t.pending(4.6))

    def test_a_wordless_closed_segment_expires_without_any_final(self):
        # The SDK never delivers an empty final, so a cough / breath segment is
        # released by time alone: end + PENDING_CLOSED_EXPIRY_SEC.
        t = self._t()
        t.on_speech_start(3.0)
        t.on_speech_end(3.5)
        edge = 3.5 + turn_hold.PENDING_CLOSED_EXPIRY_SEC
        self.assertTrue(t.pending(edge - 0.01))
        self.assertFalse(t.pending(edge + 0.01))
        # ...and it stays released (the history keeps it, pending() ignores it).
        self.assertFalse(t.pending(edge + 30.0))

    def test_the_expiry_never_releases_an_open_segment(self):
        t = self._t()
        t.on_speech_start(3.0)
        self.assertTrue(t.pending(3.0 + turn_hold.PENDING_CLOSED_EXPIRY_SEC + 5.0))

    def test_seconds_until_release_aims_at_the_nearest_expiry(self):
        t = self._t()
        self.assertIsNone(t.seconds_until_release(1.0))
        t.on_speech_start(3.0)
        self.assertIsNone(t.seconds_until_release(3.4))     # open: an event ends it
        t.on_speech_end(3.5)
        self.assertAlmostEqual(
            t.seconds_until_release(4.0), 3.5 + turn_hold.PENDING_CLOSED_EXPIRY_SEC - 4.0)
        t.on_final(5.5, "words")
        self.assertIsNone(t.seconds_until_release(5.6))     # covered

    def test_the_two_feeds_are_idempotent(self):
        t = self._t()
        t.on_speech_start(10.2)   # user-state fallback first
        t.on_speech_start(10.0)   # then the VAD's earlier, more accurate start
        t.on_speech_end(11.5)     # user-state fallback end
        t.on_speech_end(11.25)    # the VAD's accurate end refines it
        self.assertEqual(len(t._segments), 1)
        start, end = t._segments[0]
        self.assertGreaterEqual(start, t.armed_at)
        self.assertAlmostEqual(end, 11.25)
        self.assertTrue(t.pending(11.3))

    def test_history_is_bounded(self):
        t = self._t()
        for i in range(30):
            t.on_speech_start(float(i * 10))
            t.on_speech_end(float(i * 10) + 1.0)
        self.assertLessEqual(len(t._segments), turn_hold.SEGMENT_HISTORY)

    def test_a_broken_active_predicate_is_inert(self):
        def boom():
            raise RuntimeError("x")
        t = turn_hold.PendingFinalTracker(boom)
        t.on_speech_start(1.0)
        self.assertFalse(t.active())
        self.assertFalse(t.pending(5.0))


class TestUncommittedWords(unittest.IsolatedAsyncioTestCase):
    def test_count_words_matches_the_sdk_tokenizer_shape(self):
        self.assertEqual(turn_hold.count_words(""), 0)
        self.assertEqual(turn_hold.count_words("   "), 0)
        self.assertEqual(turn_hold.count_words(None), 0)
        self.assertEqual(turn_hold.count_words("yeah"), 1)
        self.assertEqual(turn_hold.count_words("yes I am"), 3)

    def test_finals_accumulate_until_a_commit_and_empty_text_adds_nothing(self):
        tracker = turn_hold.PendingFinalTracker(lambda: True)
        now = time.time()
        tracker.on_final(now, "yeah")
        tracker.on_final(now, "   ")
        tracker.on_final(now, "that works fine")
        self.assertEqual(tracker.uncommitted_words(), 4)
        tracker.note_commit()
        self.assertEqual(tracker.uncommitted_words(), 0)

    def test_words_are_not_counted_before_the_screening_phase(self):
        tracker = turn_hold.PendingFinalTracker(lambda: False)
        tracker.on_final(time.time(), "some gate words here")
        self.assertEqual(tracker.uncommitted_words(), 0)

    async def test_the_hook_resets_the_count_even_when_nothing_is_held(self):
        tracker, hold, _, _ = _make()
        tracker.on_final(time.time(), "an answer with words")
        self.assertEqual(tracker.uncommitted_words(), 4)
        await hold.before_turn(_msg("an answer with words"))
        self.assertEqual(tracker.uncommitted_words(), 0)


class TestWaitChange(unittest.IsolatedAsyncioTestCase):
    async def test_wakes_on_an_event_and_on_timeout(self):
        t = turn_hold.PendingFinalTracker(lambda: True)
        asyncio.get_running_loop().call_later(0.05, t.on_speech_start, time.time())
        started = time.monotonic()
        self.assertTrue(await t.wait_change(2.0))
        self.assertLess(time.monotonic() - started, 1.0)
        started = time.monotonic()
        self.assertFalse(await t.wait_change(0.05))
        self.assertGreaterEqual(time.monotonic() - started, 0.04)
        self.assertFalse(await t.wait_change(0))
        self.assertEqual(t._waiters, [])

    async def test_cancellation_propagates_and_leaves_no_waiter(self):
        t = turn_hold.PendingFinalTracker(lambda: True)
        task = asyncio.create_task(t.wait_change(5.0))
        await asyncio.sleep(0.02)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(t._waiters, [])


# ── 4.4 hook-time hold ───────────────────────────────────────────────────────

class TestHookTimeHold(unittest.IsolatedAsyncioTestCase):
    async def test_not_pending_returns_immediately_with_zero_waits(self):
        tracker, hold, log, _ = _make()
        waits = _count_waits(tracker)
        message = _msg("an answer", 100.0)
        started = time.monotonic()
        await hold.before_turn(message)
        self.assertLess(time.monotonic() - started, 0.05)
        self.assertEqual(waits, [])
        self.assertIsNone(hold.carry)
        self.assertEqual(message.content, ["an answer"])
        self.assertEqual(log.rows, [])

    async def test_a_covered_segment_is_not_pending(self):
        tracker, hold, _, _ = _make()
        now = time.time()
        tracker.on_speech_start(now - 3.0)
        tracker.on_speech_end(now - 2.0)
        tracker.on_final(now - 1.0, "covered words")
        waits = _count_waits(tracker)
        await hold.before_turn(_msg("covered words"))
        self.assertEqual(waits, [])

    async def test_pending_then_a_final_yields_and_carries(self):
        tracker, hold, log, _ = _make(cap=0.5)
        _pend(tracker)
        loop = asyncio.get_running_loop()
        loop.call_later(0.05, lambda: tracker.on_final(time.time(), "the rest"))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("first part", 100.0))
        self.assertEqual(hold.carry, ("first part", 100.0))
        self.assertIn("held_yield", log.categories())
        duration = log.meta("held_yield")[0]["duration_sec"]
        self.assertLess(duration, 0.4)
        # Only allowlisted keys, never text.
        for _, meta in log.rows:
            self.assertLessEqual(
                set(meta) - {"error_type", "error_category", "schema", "phase",
                             "duration_sec"}, set())
            self.assertNotIn("first part", str(meta))
        hold.on_close()

    async def test_the_next_turn_is_merged_and_keeps_its_own_newer_start(self):
        tracker, hold, log, _ = _make(cap=0.5)
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.05, lambda: tracker.on_final(time.time(), "the rest"))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("first part", 100.0))
        second = _msg("the rest", 104.0)
        await hold.before_turn(second)
        self.assertEqual(second.content, ["first part the rest"])
        self.assertEqual(second.text_content, "first part the rest")
        # The NEWER start: the older one would predate the current bot line and
        # `_native_turn_predates_question` would drop the whole merged answer.
        self.assertEqual(second.metrics["started_speaking_at"], 104.0)
        self.assertIsNone(hold.carry)
        self.assertIn("carry_merged", log.categories())
        self.assertIsNone(hold._orphan_task)

    async def test_merge_keeps_the_sdk_message_shape(self):
        """The real SDK message has read-only `text_content` and list content."""
        class _SdkLike:
            def __init__(self, text):
                self.content = [text]
                self.metrics = {"started_speaking_at": 50.0}

            @property
            def text_content(self):
                return "\n".join(c for c in self.content if isinstance(c, str))

        tracker, hold, _, _ = _make()
        hold.carry = ("earlier", 40.0)
        message = _SdkLike("later")
        await hold.before_turn(message)
        self.assertEqual(message.content, ["earlier later"])
        self.assertEqual(message.text_content, "earlier later")
        self.assertEqual(message.metrics["started_speaking_at"], 50.0)

    async def test_a_merged_turn_that_is_still_pending_yields_the_merged_text(self):
        tracker, hold, _, _ = _make(cap=0.5)
        hold.carry = ("part one", 10.0)
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.05, lambda: tracker.on_final(time.time(), "more"))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("part two", 12.0))
        self.assertEqual(hold.carry, ("part one part two", 12.0))
        hold.on_close()

    async def test_pending_that_clears_without_a_final_returns(self):
        tracker, hold, log, _ = _make(cap=1.0)
        # A wordless segment (no final will ever come: the SDK drops empty
        # finals) that ends its life 0.1 s from now.
        _pend(tracker, start_ago=2.0,
              end_ago=turn_hold.PENDING_CLOSED_EXPIRY_SEC - 0.1)
        started = time.monotonic()
        await hold.before_turn(_msg("answer"))
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 0.5)
        self.assertGreaterEqual(elapsed, 0.05)
        self.assertIsNone(hold.carry)
        self.assertIn("held_cleared", log.categories())

    async def test_a_noise_segment_costs_one_bounded_wait_across_both_seams(self):
        """Hook-time hold and first-audio hold share the segment's absolute
        expiry: the second one does not wait again (no stacked 2 x cap)."""
        tracker, hold, log, _ = _make(cap=2.0)
        _pend(tracker, start_ago=2.0,
              end_ago=turn_hold.PENDING_CLOSED_EXPIRY_SEC - 0.15)
        started = time.monotonic()
        await hold.before_turn(_msg("answer"))
        await asyncio.sleep(0.2)            # the reply is generated meanwhile
        await hold.before_first_audio()
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertEqual(log.categories().count("held_cleared"), 1)
        self.assertNotIn("held_cap_reached", log.categories())
        self.assertNotIn("audio_hold_cap_reached", log.categories())

    async def test_pending_throughout_returns_at_the_cap(self):
        tracker, hold, log, _ = _make(cap=0.3)
        _pend(tracker)
        started = time.monotonic()
        await hold.before_turn(_msg("answer"))
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.28)
        self.assertLess(elapsed, 0.3 + 0.2)
        self.assertIsNone(hold.carry)
        self.assertIn("held_cap_reached", log.categories())

    async def test_unrelated_events_do_not_extend_the_hold(self):
        tracker, hold, log, _ = _make(cap=0.3)
        _pend(tracker)

        async def chatter():
            for _ in range(10):
                await asyncio.sleep(0.04)
                tracker.on_speech_start(time.time())
                tracker.on_speech_end(time.time() + 0.001)

        task = asyncio.create_task(chatter())
        started = time.monotonic()
        await hold.before_turn(_msg("answer"))
        self.assertLess(time.monotonic() - started, 0.3 + 0.2)
        task.cancel()

    async def test_an_inactive_tracker_neither_holds_nor_merges(self):
        tracker, hold, log, state = _make()
        _pend(tracker)
        state["active"] = False
        hold.carry = ("stale", 1.0)
        waits = _count_waits(tracker)
        message = _msg("gate words")
        await hold.before_turn(message)
        self.assertEqual(waits, [])
        self.assertEqual(message.content, ["gate words"])
        self.assertEqual(hold.carry, ("stale", 1.0))
        self.assertEqual(log.rows, [])

    async def test_the_kill_switch_is_the_byte_identical_path(self):
        tracker, hold, log, _ = _make(cap=0)
        _pend(tracker)
        waits = _count_waits(tracker)
        message = _msg("answer", 5.0)
        await hold.before_turn(message)
        self.assertEqual(waits, [])
        self.assertIsNone(hold.carry)
        self.assertIsNone(hold._orphan_task)
        self.assertEqual(message.content, ["answer"])
        self.assertEqual(log.rows, [])

    async def test_an_empty_message_is_left_alone(self):
        tracker, hold, _, _ = _make()
        _pend(tracker)
        waits = _count_waits(tracker)
        await hold.before_turn(_msg(""))
        self.assertEqual(waits, [])

    async def test_the_orphan_backstop_speaks_once_after_the_bound(self):
        calls: list = []

        async def on_orphan():
            calls.append("orphan")

        with patch.object(turn_hold, "ORPHAN_EXTRA_SEC", 0.1):
            tracker, hold, log, _ = _make(
                cap=0.5, endpoint_max_sec=lambda: 0.1, on_orphan=on_orphan)
            _pend(tracker)
            asyncio.get_running_loop().call_later(
                0.03, lambda: tracker.on_final(time.time(), "late"))
            with self.assertRaises(_Stop):
                await hold.before_turn(_msg("first"))
            await asyncio.sleep(0.1)
            self.assertEqual(calls, [])        # inside the 0.2 s bound
            await asyncio.sleep(0.3)
            self.assertEqual(calls, ["orphan"])
            self.assertIn("carry_orphaned", log.categories())
            self.assertIsNone(hold.carry)
            await asyncio.sleep(0.3)
            self.assertEqual(calls, ["orphan"])  # exactly once

    async def test_the_orphan_bound_waits_while_the_candidate_speaks(self):
        calls: list = []

        with patch.object(turn_hold, "ORPHAN_EXTRA_SEC", 0.1):
            tracker, hold, log, _ = _make(
                cap=0.5, endpoint_max_sec=lambda: 0.1,
                on_orphan=lambda: calls.append("orphan"))
            _pend(tracker)
            asyncio.get_running_loop().call_later(
                0.03, lambda: tracker.on_final(time.time(), "late"))
            with self.assertRaises(_Stop):
                await hold.before_turn(_msg("first"))
            tracker.on_speech_start(time.time())    # the candidate keeps talking
            await asyncio.sleep(0.5)
            self.assertEqual(calls, [])
            tracker.on_speech_end(time.time())
            await asyncio.sleep(0.5)
            self.assertEqual(calls, ["orphan"])

    async def test_a_consumed_carry_cancels_the_backstop(self):
        calls: list = []
        with patch.object(turn_hold, "ORPHAN_EXTRA_SEC", 0.05):
            tracker, hold, log, _ = _make(
                cap=0.5, endpoint_max_sec=lambda: 0.05,
                on_orphan=lambda: calls.append("orphan"))
            _pend(tracker)
            asyncio.get_running_loop().call_later(
                0.03, lambda: tracker.on_final(time.time(), "late"))
            with self.assertRaises(_Stop):
                await hold.before_turn(_msg("first"))
            await hold.before_turn(_msg("late"))
            await asyncio.sleep(0.4)
            self.assertEqual(calls, [])
            self.assertNotIn("carry_orphaned", log.categories())

    async def test_close_logs_an_unmerged_carry_and_stops_the_watch(self):
        calls: list = []
        tracker, hold, log, _ = _make(
            cap=0.5, on_orphan=lambda: calls.append("orphan"))
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.03, lambda: tracker.on_final(time.time(), "late"))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("first"))
        hold.on_close()
        self.assertIn("carry_unmerged_at_close", log.categories())
        self.assertIsNone(hold.carry)
        await asyncio.sleep(0.05)
        self.assertEqual(calls, [])
        hold.on_close()   # idempotent
        self.assertEqual(log.categories().count("carry_unmerged_at_close"), 1)

    async def test_a_hold_restarts_the_previous_replys_watchdog_exactly_once(self):
        rearms: list = []

        async def rearm():
            rearms.append("rearm")

        tracker, hold, log, _ = _make(cap=0.2, rearm=rearm)
        _pend(tracker)
        await hold.before_turn(_msg("answer"))          # holds to the cap
        self.assertEqual(rearms, ["rearm"])
        self.assertIn("held_cap_reached", log.categories())

    async def test_no_hold_means_no_rearm(self):
        rearms: list = []
        tracker, hold, _, _ = _make(cap=0.2, rearm=lambda: rearms.append("rearm"))
        await hold.before_turn(_msg("answer"))          # nothing pending
        self.assertEqual(rearms, [])
        killed_tracker, killed, _, _ = _make(cap=0, rearm=lambda: rearms.append("rearm"))
        _pend(killed_tracker)
        await killed.before_turn(_msg("answer"))        # kill switch
        self.assertEqual(rearms, [])

    async def test_a_yield_suspends_the_previous_watchdog_and_only_a_yield_does(self):
        suspended: list = []
        tracker, hold, log, _ = _make(
            cap=0.5, suspend=lambda: suspended.append("suspend"))
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.05, lambda: tracker.on_final(time.time(), "the rest"))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("first part", 100.0))
        self.assertEqual(suspended, ["suspend"])
        hold.on_close()
        # A hold that ends at the cap, or by clearing, does not suspend.
        capped_tracker, capped, _, _ = _make(
            cap=0.15, suspend=lambda: suspended.append("capped"))
        _pend(capped_tracker)
        await capped.before_turn(_msg("answer"))
        self.assertEqual(suspended, ["suspend"])

    async def test_a_failing_suspend_never_prevents_the_yield(self):
        def boom():
            raise RuntimeError("suspend failed")

        tracker, hold, log, _ = _make(cap=0.5, suspend=boom)
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.05, lambda: tracker.on_final(time.time(), "the rest"))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("first part", 100.0))
        self.assertEqual(hold.carry, ("first part", 100.0))
        hold.on_close()

    async def test_a_failing_rearm_never_breaks_the_turn(self):
        def boom():
            raise RuntimeError("rearm failed")

        tracker, hold, log, _ = _make(cap=0.2, rearm=boom)
        _pend(tracker)
        await hold.before_turn(_msg("answer"))
        self.assertIn("held_cap_reached", log.categories())

    async def test_the_default_stop_response_is_the_sdks(self):
        # Resolved lazily from `livekit.agents` at the moment it is raised. The
        # attribute is installed here (create=True) because other test modules
        # may have replaced the stub module with a leaner one in a full run.
        tracker = turn_hold.PendingFinalTracker(lambda: True)
        hold = turn_hold.TurnHold(tracker, hold_max_sec=lambda: 0.5, log=_Log())
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.03, lambda: tracker.on_final(time.time(), "late"))
        with patch.object(
            sys.modules["livekit.agents"], "StopResponse", _Stop, create=True,
        ):
            with self.assertRaises(_Stop):
                await hold.before_turn(_msg("first"))
        hold.on_close()


# ── the phone.py hook seam ───────────────────────────────────────────────────

def _build_agent(*, frames=("f1", "f2", "f3"), on_user_turn=None):
    class BaseAgent:
        def __init__(self, instructions=""):
            self.instructions = instructions
            self.chat_ctx = types.SimpleNamespace(items=[])

        async def tts_node(self, text, model_settings):
            async for _chunk in text:
                pass
            for frame in frames:
                yield frame

    agent = phone.phone_agent_class(BaseAgent)(
        "sys", client=fixtures.FakeEventClient(), attempt_id=fixtures._ATTEMPT_ID,
        say=AsyncMock(),
        on_user_turn=on_user_turn or (lambda *a, **k: None),
        native_turns=True,
    )
    return agent


class TestPhoneHookSeam(unittest.IsolatedAsyncioTestCase):
    async def test_the_hook_holds_yields_then_merges_into_the_next_turn(self):
        seen: list = []

        async def on_user_turn(text, message, ctx):
            seen.append((text, getattr(message, "content", None)))

        agent = _build_agent(on_user_turn=on_user_turn)
        tracker, hold, log, _ = _make(cap=0.5)
        agent._turn_hold = hold
        _pend(tracker)
        asyncio.get_running_loop().call_later(
            0.04, lambda: tracker.on_final(time.time(), "the rest"))
        ctx = types.SimpleNamespace(items=[])
        with self.assertRaises(_Stop):
            await agent.on_user_turn_completed(ctx, _msg("first part", 10.0))
        self.assertEqual(seen, [], "a yielded turn never reaches the coordinator")
        self.assertIsNone(agent._generation_candidate_text)
        await agent.on_user_turn_completed(ctx, _msg("the rest", 12.0))
        self.assertEqual(seen, [("first part the rest", ["first part the rest"])])

    async def test_no_hold_attribute_is_the_pre_change_path(self):
        seen: list = []
        agent = _build_agent(on_user_turn=lambda t, m, c: seen.append(t))
        self.assertIsNone(getattr(agent, "_turn_hold", None))
        await agent.on_user_turn_completed(types.SimpleNamespace(items=[]), _msg("hello there"))
        self.assertEqual(seen, ["hello there"])


# ── 4.5 first-audio hold through the real tts_node ───────────────────────────

class _TtsHarness:
    """Drive the real ``PhoneScreeningAgent.tts_node`` over a fake downstream."""

    def __init__(self, *, cap=0.3, generation=3, **hold_kwargs):
        self.tracker, self.hold, self.log, self.state = _make(cap=cap, **hold_kwargs)
        self.agent = _build_agent()
        self.agent._turn_hold = self.hold
        self.rearms: list = []

        self.hold_flags: list = []

        async def reply_expected(*, rearm_only=False, hold=False):
            self.rearms.append(rearm_only)
            self.hold_flags.append(hold)

        self.agent._on_reply_expected = reply_expected
        if generation is not None:
            self.agent.arm_reply_generation(generation)
        self.frames: list = []
        self.t0 = time.monotonic()

    async def consume(self):
        async def src():
            yield "Nice, tell me about your last project."

        async for frame in self.agent.tts_node(src(), None):
            self.frames.append((frame, time.monotonic() - self.t0))


class TestFirstAudioHold(unittest.IsolatedAsyncioTestCase):
    async def test_pending_holds_the_first_frame_and_rearms_once(self):
        h = _TtsHarness(cap=0.3)
        _pend(h.tracker)
        task = asyncio.create_task(h.consume())
        await asyncio.sleep(0.12)
        self.assertEqual(h.frames, [], "no frame while speech is pending")
        self.assertEqual(h.rearms, [True])
        self.assertEqual(h.hold_flags, [True], "asked as a HOLD re-arm")
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual([f for f, _ in h.frames], ["f1", "f2", "f3"])
        first = h.frames[0][1]
        self.assertGreaterEqual(first, 0.27)
        self.assertLess(first, 0.3 + 0.2)
        self.assertEqual(h.rearms, [True], "re-armed exactly once")
        self.assertIn("audio_hold_cap_reached", h.log.categories())
        self.assertEqual(h.log.meta("audio_hold_cap_reached")[0]["schema"], "pending")
        self.assertIn("audio_hold", h.log.categories())

    async def test_not_pending_streams_at_once_with_zero_waits(self):
        h = _TtsHarness(cap=0.3)
        waits = _count_waits(h.tracker)
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertEqual([f for f, _ in h.frames], ["f1", "f2", "f3"])
        self.assertLess(h.frames[0][1], 0.1)
        self.assertEqual(waits, [])
        self.assertEqual(h.rearms, [])

    async def test_a_final_keeps_the_hold_for_the_commit_grace_then_releases(self):
        h = _TtsHarness(cap=1.0, endpoint_max_sec=lambda: 0.1)  # grace 0.4 s
        _pend(h.tracker)
        asyncio.get_running_loop().call_later(
            0.1, lambda: h.tracker.on_final(time.time(), "the late words"))
        await asyncio.wait_for(h.consume(), timeout=3)
        first = h.frames[0][1]
        self.assertGreaterEqual(first, 0.1 + 0.3, "held past the final")
        self.assertLess(first, 0.1 + 0.4 + 0.25)
        self.assertNotIn("audio_hold_cap_reached", h.log.categories())
        # Once at the start of the hold, once when the commit grace begins.
        self.assertEqual(h.rearms, [True, True])
        self.assertEqual(h.hold_flags, [True, True])

    async def test_a_late_final_keeps_its_commit_grace_past_the_cap(self):
        """A final landing at ~90% of the cap still gets the full commit grace:
        starting the reply at the cap would let the late commit cut it."""
        h = _TtsHarness(cap=0.5, endpoint_max_sec=lambda: 0.2)  # grace 0.5 s
        _pend(h.tracker)
        asyncio.get_running_loop().call_later(
            0.4, lambda: h.tracker.on_final(time.time(), "three late words"))
        await asyncio.wait_for(h.consume(), timeout=3)
        first = h.frames[0][1]
        self.assertGreaterEqual(first, 0.4 + 0.45, "held past the cap")
        self.assertLess(first, 0.4 + 0.5 + 0.25)
        self.assertNotIn("audio_hold_cap_reached", h.log.categories())

    async def test_a_short_final_the_sdk_will_not_commit_releases_at_once(self):
        """Round 2, major: the SDK refuses to commit fewer than
        PHONE_MIN_INTERRUPTION_WORDS words over the held (interruptible) reply,
        so a one-word final must NOT buy the 2.3 s commit grace."""
        h = _TtsHarness(cap=1.0, endpoint_max_sec=lambda: 1.0)  # grace would be 1.3 s
        _pend(h.tracker)
        asyncio.get_running_loop().call_later(
            0.1, lambda: h.tracker.on_final(time.time(), "yeah"))
        await asyncio.wait_for(h.consume(), timeout=3)
        first = h.frames[0][1]
        self.assertGreaterEqual(first, 0.08)
        self.assertLess(first, 0.1 + 0.3, "released as soon as the segment is covered")
        self.assertNotIn("audio_hold_cap_reached", h.log.categories())
        self.assertEqual(h.rearms, [True], "no commit grace, so no second re-arm")

    async def test_banked_short_finals_that_reach_the_word_floor_get_the_grace(self):
        """The SDK banks a refused fragment and appends the next: one word, then
        two more, commits.  The words are counted across finals."""
        h = _TtsHarness(cap=1.0, endpoint_max_sec=lambda: 0.1)  # grace 0.4 s
        _pend(h.tracker, start_ago=1.0, end_ago=0.3)
        loop = asyncio.get_running_loop()
        # An earlier 1-word final does not cover the segment (it ended after it).
        h.tracker.on_final(time.time() - 1.2, "yeah")
        loop.call_later(0.1, lambda: h.tracker.on_final(time.time(), "sure works"))
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertEqual(h.tracker.uncommitted_words(), 3)
        self.assertGreaterEqual(h.frames[0][1], 0.1 + 0.3, "the grace applied")

    async def test_repeated_committable_finals_hold_one_grace_after_the_last(self):
        """Each committable final re-opens the commit window (the SDK commits
        after the LAST one), so the hold ends one grace after the stream does."""
        h = _TtsHarness(cap=0.2, endpoint_max_sec=lambda: 0.2)  # grace 0.5 s
        _pend(h.tracker)
        loop = asyncio.get_running_loop()
        for i in range(1, 6):
            loop.call_later(
                0.15 * i, lambda: h.tracker.on_final(time.time(), "still talking here"))
        await asyncio.wait_for(h.consume(), timeout=5)
        first = h.frames[0][1]
        self.assertGreaterEqual(first, 0.75 + 0.5 - 0.05)
        self.assertLess(first, 0.75 + 0.5 + 0.25)
        self.assertNotIn("audio_hold_cap_reached", h.log.categories())

    async def test_repeated_short_finals_release_when_the_segment_is_covered(self):
        h = _TtsHarness(cap=0.2, endpoint_max_sec=lambda: 0.2)
        _pend(h.tracker)
        loop = asyncio.get_running_loop()
        # Two one-word finals stay below the word floor even if both land before
        # the loop wakes (a third would bank to three words and commit).
        for i in range(1, 3):
            loop.call_later(0.05 * i, lambda: h.tracker.on_final(time.time(), "hello"))
        await asyncio.wait_for(h.consume(), timeout=5)
        self.assertLess(h.frames[0][1], 0.2 + 0.15)

    async def test_the_min_words_floor_is_read_live_and_zero_always_commits(self):
        h = _TtsHarness(cap=1.0, endpoint_max_sec=lambda: 0.1, min_words=lambda: 0)
        _pend(h.tracker)
        asyncio.get_running_loop().call_later(
            0.1, lambda: h.tracker.on_final(time.time(), "yeah"))
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertGreaterEqual(h.frames[0][1], 0.1 + 0.3, "any final commits at 0")

    async def test_the_first_frame_does_not_apply_the_phase_minimum(self):
        """Round 2, minor: the minimum switches when the reply PLAYS, not when
        its first TTS frame is synthesized (the SDK pulls frames before it
        authorizes the reply)."""
        h = _TtsHarness(cap=0.3)
        applied: list = []
        h.hold.on_speech_created(
            source="generate_reply", phase="screening",
            objective="Tell me about your last role", apply_min=applied.append)
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertEqual(applied, [])
        h.hold.first_audio_released()        # the session's `speaking` state
        self.assertEqual(applied, [0.8])

    async def test_wordless_pending_releases_by_expiry_not_at_the_cap(self):
        h = _TtsHarness(cap=2.0)
        _pend(h.tracker, start_ago=2.0,
              end_ago=turn_hold.PENDING_CLOSED_EXPIRY_SEC - 0.1)
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertLess(h.frames[0][1], 0.5)
        self.assertNotIn("audio_hold_cap_reached", h.log.categories())

    async def test_cancel_during_the_hold_yields_zero_frames(self):
        h = _TtsHarness(cap=2.0)
        _pend(h.tracker)
        task = asyncio.create_task(h.consume())
        await asyncio.sleep(0.1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(h.frames, [])
        self.assertEqual(h.tracker._waiters, [])

    async def test_a_superseded_generation_yields_no_frame(self):
        h = _TtsHarness(cap=0.3)
        first_frames: list = []
        h.agent._on_tts_first_frame = lambda *a: first_frames.append(a)
        _pend(h.tracker)
        task = asyncio.create_task(h.consume())
        await asyncio.sleep(0.1)
        h.agent.arm_reply_generation(9)
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(h.frames, [])
        # The re-check after the hold must also keep the NEW generation's
        # first-audio bookkeeping untouched: reporting this dead line's first
        # frame under the new generation would silence its watchdog.
        self.assertEqual(first_frames, [])

    async def test_the_kill_switch_is_identical_to_main(self):
        baseline = _TtsHarness(cap=0.3)
        baseline.agent._turn_hold = None
        await asyncio.wait_for(baseline.consume(), timeout=3)
        killed = _TtsHarness(cap=0)
        _pend(killed.tracker)
        waits = _count_waits(killed.tracker)
        await asyncio.wait_for(killed.consume(), timeout=3)
        self.assertEqual(
            [f for f, _ in killed.frames], [f for f, _ in baseline.frames])
        self.assertLess(killed.frames[0][1], 0.1)
        self.assertEqual(waits, [])
        self.assertEqual(killed.rearms, [])
        self.assertEqual(killed.log.rows, [])

    async def test_the_gate_path_is_never_held(self):
        h = _TtsHarness(cap=0.3)
        _pend(h.tracker)
        h.state["active"] = False
        waits = _count_waits(h.tracker)
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertLess(h.frames[0][1], 0.1)
        self.assertEqual(waits, [])
        self.assertEqual(h.rearms, [])

    async def test_a_line_with_no_generation_holds_without_a_rearm(self):
        h = _TtsHarness(cap=0.2, generation=None)
        _pend(h.tracker)
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertGreaterEqual(h.frames[0][1], 0.17)
        self.assertEqual(h.rearms, [])

    async def test_only_the_first_frame_is_held(self):
        h = _TtsHarness(cap=0.2)
        _pend(h.tracker)
        await asyncio.wait_for(h.consume(), timeout=3)
        self.assertLess(h.frames[-1][1] - h.frames[0][1], 0.1)

    async def test_the_env_kill_switch_reads_through_the_real_reader(self):
        with _Env({"PHONE_PENDING_FINAL_HOLD_MAX_SEC": "0"}):
            tracker = turn_hold.PendingFinalTracker(lambda: True)
            hold = turn_hold.TurnHold(
                tracker, hold_max_sec=phone.phone_pending_final_hold_max_sec,
                log=_Log(), stop_response=_Stop)
            _pend(tracker)
            waits = _count_waits(tracker)
            await hold.before_turn(_msg("answer"))
            await hold.before_first_audio(rearm=lambda: self.fail("no rearm"))
            self.assertEqual(waits, [])


# ── 4.6 per-phase minimum ────────────────────────────────────────────────────

class TestPerPhaseMinimum(unittest.TestCase):
    def _hold(self, *, active=True):
        tracker, hold, log, state = _make(
            active=active, open_min_sec=lambda: 0.8, short_min_sec=lambda: 0.3)
        applied: list = []
        return hold, log, applied, applied.append

    def test_the_minimum_waits_for_the_replys_first_audio(self):
        """Creating the reply must not change the minimum: the SDK is still
        deciding when to START it, using the class of the answer it follows."""
        hold, log, applied, apply = self._hold()
        hold.on_speech_created(
            source="generate_reply", phase="screening",
            objective="Tell me about your last role", apply_min=apply)
        self.assertEqual(applied, [])
        self.assertEqual(log.rows, [])
        hold.first_audio_released()
        self.assertEqual(applied, [0.8])
        hold.first_audio_released()          # consumed: nothing is applied twice
        self.assertEqual(applied, [0.8])

    def test_a_reply_that_never_plays_does_not_change_the_minimum(self):
        hold, _, applied, apply = self._hold()
        hold.on_speech_created(
            source="generate_reply", phase="screening",
            objective="Tell me about your last role", apply_min=apply)
        # Cancelled before any audio; the next reply asks a yes/no question.
        hold.on_speech_created(
            source="generate_reply", phase="screening",
            objective="Do you have a laptop?", apply_min=apply)
        hold.first_audio_released()
        self.assertEqual(applied, [])

    def test_open_then_the_same_class_is_applied_once(self):
        hold, log, applied, apply = self._hold()
        for _ in range(3):
            _created(hold,
                source="generate_reply", phase="screening",
                objective="Tell me about your last role", apply_min=apply)
        self.assertEqual(applied, [0.8])
        self.assertEqual(log.categories(), ["open"])
        meta = log.meta("open")[0]
        self.assertEqual(meta["error_type"], "phone_endpointing_phase")
        self.assertEqual(meta["phase"], "screening")
        self.assertAlmostEqual(meta["duration_sec"], 0.8)

    def test_a_yes_no_question_after_open_goes_back_to_the_static_minimum(self):
        hold, log, applied, apply = self._hold()
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last role", apply_min=apply)
        _created(hold, source="generate_reply", phase="screening",
                               objective="Do you have a laptop?", apply_min=apply)
        self.assertEqual(applied, [0.8, 0.3])

    def test_name_confirm_after_open_is_short(self):
        hold, _, applied, apply = self._hold()
        _created(hold, source="generate_reply", phase="candidate_qna",
                               objective="", apply_min=apply)
        _created(hold, source="generate_reply", phase="name_confirm",
                               objective="Is that right?", apply_min=apply)
        self.assertEqual(applied, [0.8, 0.3])

    def test_the_first_short_class_needs_no_call(self):
        hold, _, applied, apply = self._hold()
        _created(hold, source="generate_reply", phase="screening",
                               objective="Do you have a laptop?", apply_min=apply)
        self.assertEqual(applied, [])

    def test_say_lines_keep_the_current_class(self):
        hold, _, applied, apply = self._hold()
        _created(hold, source="say", phase="screening",
                               objective="Tell me about your last role", apply_min=apply)
        self.assertEqual(applied, [])
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last role", apply_min=apply)
        _created(hold, source="say", phase="closing", objective="", apply_min=apply)
        self.assertEqual(applied, [0.8])

    def test_before_activation_nothing_is_applied(self):
        hold, log, applied, apply = self._hold(active=False)
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last role", apply_min=apply)
        self.assertEqual(applied, [])
        self.assertEqual(log.rows, [])

    def test_no_apply_callable_is_a_no_op(self):
        hold, log, _, _ = self._hold()
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last role", apply_min=None)
        self.assertEqual(log.rows, [])

    def test_a_failing_update_is_logged_swallowed_and_retried(self):
        hold, log, _, _ = self._hold()
        attempts: list = []

        def failing(value):
            attempts.append(value)
            raise RuntimeError("update_options failed")

        for _ in range(2):
            _created(hold, source="generate_reply", phase="screening",
                                   objective="Tell me about your last role",
                                   apply_min=failing)
        self.assertEqual(attempts, [0.8, 0.8])
        self.assertEqual(log.categories(), ["apply_failed", "apply_failed"])
        good: list = []
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last role",
                               apply_min=good.append)
        self.assertEqual(good, [0.8])

    def test_rollback_value_equal_to_the_static_min_makes_it_a_no_op(self):
        tracker, hold, log, _ = _make(
            open_min_sec=lambda: 0.3, short_min_sec=lambda: 0.3)
        applied: list = []
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last role",
                               apply_min=applied.append)
        self.assertEqual(applied, [])

    def test_an_unsafe_phase_value_is_not_logged_verbatim(self):
        hold, log, _, apply = self._hold()
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me", apply_min=apply)
        self.assertEqual(log.meta("open")[0]["phase"], "screening")
        self.assertEqual(turn_hold._safe_phase("a b; drop"), "unknown")
        self.assertEqual(turn_hold._safe_phase(None), "unknown")


class _RecordingSession(fixtures._FakePhoneSession):
    """The shared fake session plus an `update_options` recorder, and a
    `source` on every speech_created event (the stub omits it)."""

    update_raises = False

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.ctor = dict(kwargs)
        self.option_updates: list = []
        self._in_say = False

    def update_options(self, **kwargs):
        if type(self).update_raises and "min_delay" in (kwargs.get("endpointing_opts") or {}):
            raise RuntimeError("update_options failed")
        self.option_updates.append(kwargs)

    def generate_reply(self, *args, **kwargs):
        # The shared fake emits `agent_state_changed` -> `speaking` after
        # `speech_created`; that real handler (agent.py) applies the minimum.
        return super().generate_reply(*args, **kwargs)

    def say(self, text, **kwargs):
        self._in_say = True
        try:
            return super().say(text, **kwargs)
        finally:
            self._in_say = False

    def on(self, event):
        if event != "speech_created":
            return super().on(event)
        session = self

        def deco(fn):
            def adapted(ev):
                if not hasattr(ev, "source"):
                    ev.source = "say" if session._in_say else "generate_reply"
                return fn(ev)
            self.handlers[event] = adapted
            return fn
        return deco

    def min_updates(self) -> list:
        return [
            u["endpointing_opts"]["min_delay"] for u in self.option_updates
            if "min_delay" in (u.get("endpointing_opts") or {})
        ]


class _SessionHarness:
    """One full `_run_phone_session` over `_RecordingSession`."""

    def __init__(self, testcase: unittest.IsolatedAsyncioTestCase):
        self.testcase = testcase

    async def run(self, *, questions=None, replies=None, env=None, session_cls=None,
                  mid=None):
        fake = fixtures._FakePhoneSession
        fake.instances = []
        fake.default_answers = list(replies or ["Yes.", "An answer.", "Another."])
        fake.default_mid_turn_says = []
        fake.default_gate_user_turns = []
        fake.default_interruptions = []
        fake.default_silence_reply = None
        fake.default_emit_auto_speech = True
        fake.default_terminal_reply_interrupted = False
        fake.include_timing = False
        ctx = fixtures.FakeCtx(fixtures._PHONE_ROOM, participants=[fixtures._participant()])
        client = fixtures.FakeEventClient(
            start=fixtures._default_state(questions=questions) if questions else None)

        async def recording_seam():
            return None

        async def classifier(turns, say):
            return agent_mod.classify_answer_text("Yes, that's fine.") or phone.CLASSIFY_MACHINE

        # The production endpointing pins (fly.phone.toml), not the code defaults.
        overrides = {
            "PHONE_DETERMINISTIC_OPENER": "false",
            "PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC": "0.3",
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "2.0",
        }
        overrides.update(env or {})
        with patch.dict(os.environ, overrides), \
             patch.object(agent_mod, "AgentSession", session_cls or _RecordingSession), \
             patch.object(agent_mod, "persistence", MagicMock()), \
             patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
             patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", fixtures._HARNESS_RESIDENCY_SEC):
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID, fixtures._EPOCH,
                    client=client, classifier=classifier,
                )
            )
            await asyncio.sleep(0.01)
            session = fake.instances[-1]
            await fixtures._await_native_preloop(session, task)
            if mid is not None:
                # The call is still live (the candidate stopped answering).
                self.testcase.assertFalse(task.done(), "the call must still be live")
                await mid(session)
            session.emit_close()
            await asyncio.wait_for(task, timeout=8)
        return session, client


_OPEN_Q = {"key": "k1", "text": "Tell me about your last project.", "mandatory": True, "hint": None}
_YN_Q = {"key": "k2", "text": "Do you have a laptop?", "mandatory": False, "hint": None}
_YN_Q2 = {"key": "k3", "text": "Are you open to relocating?", "mandatory": False, "hint": None}


class TestPerPhaseMinimumThroughTheSession(unittest.IsolatedAsyncioTestCase):
    async def test_open_questions_apply_the_open_minimum_once_and_closing_goes_back(self):
        session, _ = await _SessionHarness(self).run()
        # Q2 is open (0.8, once); the closing line is a short-answer phase (0.3).
        self.assertEqual(session.min_updates(), [0.8, 0.3])
        # The consent max update (gate) is a separate key and still happens.
        self.assertTrue(any(
            "max_delay" in (u.get("endpointing_opts") or {})
            for u in session.option_updates))
        for update in session.option_updates:
            opts = update["endpointing_opts"]
            self.assertTrue(set(opts) == {"min_delay"} or set(opts) == {"max_delay"}, opts)

    async def test_an_open_first_question_gets_the_open_minimum_when_heard(self):
        """Round 2: Q1 is a say() line, so no generated reply noted its class."""
        session, _ = await _SessionHarness(self).run(
            questions=[_OPEN_Q, _YN_Q, _YN_Q2], replies=["I built it.", "Yes.", "No."])
        self.assertEqual(session.min_updates()[:1], [0.8])
        # Q2 is a yes/no: back to the static minimum once it plays.
        self.assertEqual(session.min_updates()[:2], [0.8, 0.3])

    async def test_a_yes_no_first_question_never_touches_the_minimum(self):
        session, _ = await _SessionHarness(self).run(
            questions=[_YN_Q, _YN_Q2], replies=["Yes.", "No."])
        self.assertEqual(session.min_updates(), [])

    async def test_a_yes_no_question_returns_to_the_static_minimum(self):
        session, _ = await _SessionHarness(self).run(
            questions=[_YN_Q, _OPEN_Q, _YN_Q2], replies=["Yes.", "I built it.", "No."])
        self.assertEqual(session.min_updates(), [0.8, 0.3])

    async def test_only_yes_no_questions_never_touch_the_minimum(self):
        session, _ = await _SessionHarness(self).run(
            questions=[_YN_Q, _YN_Q2], replies=["Yes.", "No."])
        self.assertEqual(session.min_updates(), [])

    async def test_dynamic_endpointing_is_not_touched(self):
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_DYNAMIC_ENDPOINTING": "on"})
        self.assertEqual(session.min_updates(), [])

    async def test_stt_turn_detection_is_not_touched(self):
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_TURN_DETECTION": "stt"})
        self.assertEqual(session.min_updates(), [])

    async def test_a_failing_update_never_breaks_the_call(self):
        class _Failing(_RecordingSession):
            update_raises = True

        session, client = await _SessionHarness(self).run(session_cls=_Failing)
        self.assertEqual(session.min_updates(), [])
        self.assertIn("assessment.completed", client.event_types)

    async def test_the_rollback_value_is_a_no_op(self):
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_OPEN_ANSWER_MIN_DELAY_SEC": "0.3"})
        self.assertEqual(session.min_updates(), [])


# ── 4.7 replays shaped like the 2026-10-08 cases (virtual time) ──────────────

class _VClock:
    def __init__(self, t: float = 0.0):
        self.t = t

    def now(self) -> float:
        return self.t


class _VTracker(turn_hold.PendingFinalTracker):
    """A tracker whose waits run on a scripted virtual timeline.

    ``script`` is a list of ``(t, callable)``: each callable feeds the tracker
    at virtual time ``t``. A wait advances the clock to the next scripted event
    inside its window, or by its whole timeout.
    """

    def __init__(self, vc: _VClock, **kwargs):
        super().__init__(lambda: True, clock=vc.now, **kwargs)
        self.vc = vc
        self.script: list = []
        self.wait_calls = 0

    async def wait_change(self, timeout):
        self.wait_calls += 1
        deadline = self.vc.t + timeout
        self.script.sort(key=lambda event: event[0])
        woke = False
        if self.script and self.script[0][0] <= deadline:
            when, feed = self.script.pop(0)
            self.vc.t = max(self.vc.t, when)
            feed()
            woke = True
        else:
            self.vc.t = deadline
        await asyncio.sleep(0)   # a real suspension point: cancellation lands here
        return woke


def _virtual(cap=2.0, **kwargs):
    vc = _VClock()
    tracker = _VTracker(vc)
    log = _Log()
    kwargs.setdefault("stop_response", _Stop)
    hold = turn_hold.TurnHold(
        tracker, hold_max_sec=lambda: cap, log=log, monotonic=vc.now,
        endpoint_max_sec=lambda: 2.0, **kwargs)
    return vc, tracker, hold, log


class TestReplays(unittest.IsolatedAsyncioTestCase):
    async def test_dcc88ab5_8_cancelled_reply_yields_zero_frames(self):
        frames: list = []
        vc, tracker, hold, log = _virtual(cap=2.0)
        agent = _build_agent()
        agent._turn_hold = hold
        agent.arm_reply_generation(1)
        tracker.on_speech_start(0.0)
        tracker.on_speech_end(3.0)
        tracker.on_final(3.95, "and then we shipped it")
        tracker.on_speech_start(4.7)
        tracker.on_speech_end(5.3)
        vc.t = 5.55

        async def consume():
            async def src():
                yield "Nice, tell me about the launch."
            async for frame in agent.tts_node(src(), None):
                frames.append((frame, vc.t))

        task = asyncio.create_task(consume())
        tracker.script.append((6.3, lambda: tracker.on_final(6.3, "so that was the launch")))
        tracker.script.append((6.65, task.cancel))   # the SDK commits and cuts the reply
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(frames, [])
        self.assertGreaterEqual(vc.t, 6.65)

    async def test_dcc88ab5_8_control_without_the_hold_talks_over_the_candidate(self):
        frames: list = []
        vc, tracker, hold, log = _virtual(cap=0)
        agent = _build_agent()
        agent._turn_hold = hold
        agent.arm_reply_generation(1)
        tracker.on_speech_start(0.0)
        tracker.on_speech_end(3.0)
        tracker.on_final(3.95, "and then we shipped it")
        tracker.on_speech_start(4.7)
        tracker.on_speech_end(5.3)
        vc.t = 5.55

        async def src():
            yield "Nice, tell me about the launch."

        async for frame in agent.tts_node(src(), None):
            frames.append((frame, vc.t))
        self.assertEqual(frames[0][1], 5.55)
        self.assertTrue(tracker.pending(5.55), "the candidate's words are still on the way")

    async def test_dcc88ab5_8_held_reply_never_plays_while_the_candidate_is_still_speaking(self):
        """The SDK authorizes a reply once and never re-checks that the
        candidate is silent, so the hold outlasts the cap while a VAD segment
        is open (no dead air: they are talking) ... up to the absolute ceiling."""
        frames: list = []
        vc, tracker, hold, log = _virtual(cap=2.0)
        agent = _build_agent()
        agent._turn_hold = hold
        agent.arm_reply_generation(1)
        rearms: list = []

        async def reply_expected(*, rearm_only=False, hold=False):
            rearms.append((vc.t, rearm_only, hold))

        agent._on_reply_expected = reply_expected
        tracker.on_speech_start(4.7)          # still talking: no end, no final
        tracker.script.append((8.0, lambda: tracker.on_speech_end(8.0)))
        vc.t = 5.55

        async def src():
            yield "Nice, tell me about the launch."

        async for frame in agent.tts_node(src(), None):
            frames.append((frame, vc.t))
        # Several times the cap of continuous speech: nothing before it ends,
        # and then only the closed segment's own expiry (no final ever comes).
        release = 8.0 + turn_hold.PENDING_CLOSED_EXPIRY_SEC
        self.assertGreaterEqual(frames[0][1], release)
        self.assertLess(frames[0][1], release + 0.1)
        self.assertNotIn("audio_hold_cap_reached", log.categories())
        self.assertNotIn("audio_hold_ceiling_reached", log.categories())
        # The watchdog was re-armed through the whole talk, as a HOLD re-arm.
        self.assertGreaterEqual(len([r for r in rearms if r[0] < 8.0]), 2)
        self.assertTrue(all(r[1] and r[2] for r in rearms))

    async def test_continuing_speech_of_six_to_eight_seconds_is_never_talked_over(self):
        """No absolute ceiling: the RCA's main pattern is a candidate who keeps
        going for several seconds.  Both seams hold for as long as the segment
        is open, and the watchdog is re-armed through the whole talk."""
        for talk_end in (12.0, 12.5, 13.0):         # 6.3 s .. 8.3 s of speech
            frames: list = []
            vc, tracker, hold, log = _virtual(cap=2.0)
            agent = _build_agent()
            agent._turn_hold = hold
            agent.arm_reply_generation(1)
            rearms: list = []

            async def reply_expected(*, rearm_only=False, hold=False):
                rearms.append(vc.t)

            agent._on_reply_expected = reply_expected
            tracker.on_speech_start(4.7)
            tracker.script.append((talk_end, lambda t=talk_end: tracker.on_speech_end(t)))
            vc.t = 5.55

            async def src():
                yield "Nice, tell me about the launch."

            async for frame in agent.tts_node(src(), None):
                frames.append((frame, vc.t))
            release = talk_end + turn_hold.PENDING_CLOSED_EXPIRY_SEC
            self.assertGreaterEqual(frames[0][1], release - 1e-6, talk_end)
            self.assertLess(frames[0][1], release + 0.1, talk_end)
            self.assertGreaterEqual(len([t for t in rearms if t < talk_end]), 5)
            self.assertNotIn("audio_hold_open_segment_stale", log.categories())

    async def test_the_hook_time_hold_also_waits_out_continuing_speech(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.0)
        tracker.script.append((12.0, lambda: tracker.on_speech_end(12.0)))
        tracker.script.append((13.0, lambda: tracker.on_final(13.0, "and it took about six months")))
        vc.t = 5.0
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("i led the migration at my last company", 100.0))
        self.assertAlmostEqual(vc.t, 13.0)
        self.assertEqual(log.categories(), ["held_yield"])
        hold.on_close()

    async def test_a_mid_speech_final_does_not_start_the_commit_grace_while_they_talk(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.7)
        tracker.script.append((6.5, lambda: tracker.on_final(6.5, "and then we shipped it")))
        tracker.script.append((8.0, lambda: tracker.on_speech_end(8.0)))
        vc.t = 5.55
        await hold.before_first_audio()
        # Never released during the speech (a grace started by the mid-speech
        # final would have run out at 6.5 + 2.3); at the segment's end the SDK
        # re-runs end-of-turn detection on the banked words, so the commit is
        # awaited from there, for one commit grace at most.
        self.assertGreaterEqual(vc.t, 8.0 + 2.0)
        self.assertLessEqual(vc.t, 8.0 + 2.3 + 0.1)

    async def test_a_stuck_vad_segment_cannot_hold_a_reply_forever(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(0.0)          # the end event never arrives
        vc.t = 1.0
        await hold.before_first_audio()
        stale_at = turn_hold.OPEN_SEGMENT_STALE_SEC
        self.assertGreaterEqual(vc.t, stale_at)
        self.assertLessEqual(vc.t, stale_at + 0.1)
        self.assertEqual(log.categories().count("audio_hold_open_segment_stale"), 1)

    async def test_a_stuck_vad_segment_releases_the_hook_time_hold_too(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(0.0)
        vc.t = 1.0
        await hold.before_turn(_msg("an answer", 100.0))
        self.assertGreaterEqual(vc.t, turn_hold.OPEN_SEGMENT_STALE_SEC)
        self.assertLessEqual(vc.t, turn_hold.OPEN_SEGMENT_STALE_SEC + 0.1)
        self.assertEqual(log.categories(), ["held_open_segment_stale"])
        self.assertIsNone(hold.carry)

    async def test_the_hook_time_hold_also_outlasts_the_cap_while_they_talk(self):
        rearms: list = []
        vc, tracker, hold, log = _virtual(
            cap=2.0, rearm=lambda: rearms.append(vc.t))
        tracker.on_speech_start(4.0)          # a continuing answer
        tracker.script.append((7.0, lambda: tracker.on_speech_end(7.0)))
        tracker.script.append((7.95, lambda: tracker.on_final(7.95, "and it took about six months")))
        vc.t = 5.0
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("i led the migration at my last company", 100.0))
        self.assertAlmostEqual(vc.t, 7.95)
        self.assertEqual(log.categories(), ["held_yield"])
        self.assertGreaterEqual(len([t for t in rearms if t < 7.0]), 2)

    async def test_a_wordless_segment_releases_the_reply_at_its_expiry_not_the_cap(self):
        frames: list = []
        vc, tracker, hold, log = _virtual(cap=2.0)
        agent = _build_agent()
        agent._turn_hold = hold
        agent.arm_reply_generation(1)
        tracker.on_speech_start(4.7)
        tracker.on_speech_end(5.3)            # a cough: no final will ever come
        vc.t = 5.55

        async def src():
            yield "Nice, tell me about the launch."

        async for frame in agent.tts_node(src(), None):
            frames.append((frame, vc.t))
        release = 5.3 + turn_hold.PENDING_CLOSED_EXPIRY_SEC
        self.assertGreaterEqual(frames[0][1], release)
        self.assertLess(frames[0][1], release + 0.1)
        self.assertLess(frames[0][1], 5.55 + 2.0)
        self.assertNotIn("audio_hold_cap_reached", log.categories())

    async def test_rca_cause_4_stale_commit_is_held_yielded_and_merged_keeping_the_newer_start(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        # Final A is waiting; segment B starts and ends; the VAD end-of-speech of
        # B triggers a commit carrying A only, at t=4.3.
        tracker.on_speech_start(0.0)
        tracker.on_speech_end(2.0)
        tracker.on_final(3.0, "i led the migration at my last company")
        tracker.on_speech_start(3.2)
        tracker.on_speech_end(4.0)
        vc.t = 4.3
        tracker.script.append((5.0, lambda: tracker.on_final(5.0, "and it took about six months")))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("i led the migration at my last company", 100.0))
        self.assertAlmostEqual(vc.t, 5.0)
        self.assertEqual(
            hold.carry, ("i led the migration at my last company", 100.0))
        # The SDK then commits B's final as the next turn.
        vc.t = 5.35
        second = _msg("and it took about six months", 103.0)
        await hold.before_turn(second)
        self.assertEqual(
            second.content,
            ["i led the migration at my last company and it took about six months"])
        # The newer start survives: an older one would predate the bot's current
        # question and `_native_turn_predates_question` would drop the answer.
        self.assertEqual(second.metrics["started_speaking_at"], 103.0)
        self.assertEqual(log.categories(), ["held_yield", "carry_merged"])

    async def test_7f48fcb8_23_an_open_screening_question_sets_the_open_minimum_first(self):
        class _Opts:
            def __init__(self):
                self.endpointing = {"min_delay": 0.3, "max_delay": 2.0}

            def update_options(self, *, endpointing_opts):
                self.endpointing.update(endpointing_opts)

        opts = _Opts()
        tracker, hold, _, _ = _make(open_min_sec=lambda: 0.8, short_min_sec=lambda: 0.3)
        # Before the candidate's short reply: the bot asked an open question.
        _created(hold,
            source="generate_reply", phase="screening",
            objective="Tell me about your last project.",
            apply_min=lambda v: opts.update_options(endpointing_opts={"min_delay": v}))
        self.assertAlmostEqual(opts.endpointing["min_delay"], 0.8)
        # The SDK's reply-start silence gate reads min_delay / 2 live.
        self.assertAlmostEqual(opts.endpointing["min_delay"] / 2, 0.4)
        self.assertAlmostEqual(opts.endpointing["max_delay"], 2.0, msg="max untouched")

    async def test_4ab3b64d_31_35_a_question_split_across_a_pause_is_one_message(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        # A question split by a 1.2 s pause (synthetic words): the first commit
        # (a stale final) is read while the second segment's final is still on
        # the way.
        tracker.on_speech_start(0.0)
        tracker.on_speech_end(2.0)
        tracker.on_final(3.0, "I wanted to ask how the onboarding buddy")
        tracker.on_speech_start(3.2)
        tracker.on_speech_end(4.6)
        vc.t = 5.0
        tracker.script.append(
            (5.6, lambda: tracker.on_final(5.6, "works with the new hires?")))
        with self.assertRaises(_Stop):
            await hold.before_turn(_msg("I wanted to ask how the onboarding buddy", 200.0))
        vc.t = 5.95
        merged = _msg("works with the new hires?", 203.0)
        await hold.before_turn(merged)
        self.assertEqual(
            merged.content,
            ["I wanted to ask how the onboarding buddy works with the new hires?"])

    async def test_gate_isolation_identity_and_consent_timelines_do_nothing(self):
        vc = _VClock()
        state = {"active": False}
        tracker = _VTracker(vc)
        tracker._active = lambda: state["active"]
        log = _Log()
        hold = turn_hold.TurnHold(
            tracker, hold_max_sec=lambda: 2.0, log=log, monotonic=vc.now,
            stop_response=_Stop)
        applied: list = []
        # Identity "Yes, speaking" then consent "Yes", with a pending-looking
        # trailing segment: none of it may hold, merge or re-time.
        tracker.on_speech_start(1.0)
        tracker.on_speech_end(2.0)
        tracker.on_final(3.0, "Yes, speaking")
        tracker.on_speech_start(6.0)
        tracker.on_speech_end(6.8)
        vc.t = 7.0
        msg = _msg("Yes")
        await hold.before_turn(msg)
        _created(hold, source="generate_reply", phase="screening",
                               objective="Tell me about your last project.",
                               apply_min=applied.append)
        await hold.before_first_audio(rearm=lambda: applied.append("rearm"))
        self.assertEqual(tracker.wait_calls, 0)
        self.assertEqual(applied, [])
        self.assertIsNone(hold.carry)
        self.assertEqual(msg.content, ["Yes"])
        self.assertEqual(log.rows, [])
        self.assertEqual(vc.t, 7.0)


# ── round 6: no absolute ceiling (an open segment holds; one cumulative budget) ──

def _noise_bursts(tracker, *, first=4.0, on=0.8, off=0.7, until=40.0):
    """Recurring wordless VAD segments (line or background noise), scripted."""
    t = first
    while t < until:
        tracker.script.append((t, lambda t=t: tracker.on_speech_start(t)))
        tracker.script.append((t + on, lambda t=t + on: tracker.on_speech_end(t)))
        t += on + off


def _burst_overlap(first, on, off, start, end, until=40.0):
    """Seconds of [start, end] covered by the scripted noise bursts."""
    total, t = 0.0, first
    while t < until:
        total += max(0.0, min(end, t + on) - max(start, t))
        t += on + off
    return total


class TestHoldBudget(unittest.IsolatedAsyncioTestCase):
    """No absolute ceiling: an open segment always holds, the wait for a final
    after speech ended is one cumulative budget per reply."""

    async def test_recurring_wordless_noise_costs_the_cap_plus_the_bursts_at_the_first_audio(self):
        for on, off in ((0.8, 0.7), (1.5, 1.0), (0.4, 0.5)):
            vc, tracker, hold, log = _virtual(cap=2.0)
            rearms: list = []
            tracker.on_speech_start(4.9)       # a wordless segment just closed when the line is ready
            tracker.on_speech_end(5.5)
            _noise_bursts(tracker, first=6.0, on=on, off=off)
            vc.t = 5.55
            await hold.before_first_audio(rearm=lambda: rearms.append(vc.t))
            quiet = (vc.t - 5.55) - _burst_overlap(6.0, on, off, 5.55, vc.t)
            self.assertAlmostEqual(quiet, 2.0, delta=0.05, msg=(on, off))
            self.assertIn("audio_hold_cap_reached", log.categories())
            self.assertTrue(rearms)

    async def test_recurring_wordless_noise_costs_the_cap_plus_the_bursts_at_the_hook(self):
        for on, off in ((0.8, 0.7), (1.5, 1.0), (0.4, 0.5)):
            vc, tracker, hold, log = _virtual(cap=2.0)
            tracker.on_speech_start(4.9)
            tracker.on_speech_end(5.5)
            _noise_bursts(tracker, first=6.0, on=on, off=off)
            vc.t = 5.55
            await hold.before_turn(_msg("i led the migration at my last company", 100.0))
            quiet = (vc.t - 5.55) - _burst_overlap(6.0, on, off, 5.55, vc.t)
            self.assertAlmostEqual(quiet, 2.0, delta=0.05, msg=(on, off))
            self.assertEqual(log.categories(), ["held_cap_reached"])
            self.assertIsNone(hold.carry, "released without yielding: no final ever came")

    async def test_the_two_seams_of_one_reply_share_one_budget(self):
        on, off = 0.8, 0.7
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.9)
        tracker.on_speech_end(5.5)
        _noise_bursts(tracker, first=6.0, on=on, off=off)
        vc.t = 5.55
        await hold.before_turn(_msg("i led the migration at my last company", 100.0))
        await hold.before_first_audio()
        quiet = (vc.t - 5.55) - _burst_overlap(6.0, on, off, 5.55, vc.t)
        self.assertAlmostEqual(quiet, 2.0, delta=0.05,
                               msg="the second hold did not wait another cap")
        self.assertIn("held_cap_reached", log.categories())
        self.assertIn("audio_hold_cap_reached", log.categories())

    async def test_the_budget_is_fresh_for_the_next_reply(self):
        on, off = 0.8, 0.7
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.9)
        tracker.on_speech_end(5.5)
        _noise_bursts(tracker, first=6.0, on=on, off=off)
        vc.t = 5.55
        await hold.before_first_audio()                  # reply 1 released
        mark = vc.t
        await hold.before_turn(_msg("another answer", 101.0))   # reply 2: new hook
        quiet = (vc.t - mark) - _burst_overlap(6.0, on, off, mark, vc.t)
        self.assertAlmostEqual(quiet, 2.0, delta=0.05)

    async def test_the_kill_switch_never_waits_and_never_logs(self):
        vc, tracker, hold, log = _virtual(cap=0)
        tracker.on_speech_start(4.0)            # a live open segment
        vc.t = 5.0
        await hold.before_turn(_msg("answer", 100.0))
        await hold.before_first_audio(rearm=lambda: self.fail("no rearm"))
        await hold.before_first_audio(interruptible=False)   # not even a "skipped" log
        self.assertEqual(vc.t, 5.0)
        self.assertEqual(tracker.wait_calls, 0)
        self.assertEqual(log.rows, [])

    async def test_a_young_open_segment_holds_the_first_audio_when_the_previous_final_lands(self):
        """The previous sentence's final lands 0.1 s into the next sentence:
        the first-audio hold must keep holding (an open segment always holds),
        not release into it."""
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.0)
        tracker.on_speech_end(5.0)
        tracker.script.append((6.0, lambda: tracker.on_speech_start(6.0)))
        tracker.script.append((6.1, lambda: tracker.on_final(6.1, "yes")))     # covers 4.0-5.0
        tracker.script.append((9.0, lambda: tracker.on_speech_end(9.0)))
        tracker.script.append((9.9, lambda: tracker.on_final(9.9, "and then we shipped it")))
        vc.t = 5.55
        await hold.before_first_audio()
        self.assertGreaterEqual(vc.t, 9.0, "not released into the candidate's next sentence")

    async def test_a_young_open_segment_alone_holds_the_first_audio(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(5.5)            # 0.05 s old: not "pending" by the 0.3 s rule
        tracker.script.append((6.5, lambda: tracker.on_speech_end(6.5)))
        vc.t = 5.55
        await hold.before_first_audio()
        self.assertGreaterEqual(vc.t, 6.5)

    async def test_a_cough_without_any_further_speech_is_still_released_by_its_expiry(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(5.0)
        tracker.on_speech_end(5.5)
        vc.t = 5.55
        await hold.before_first_audio()
        self.assertLess(vc.t, 5.55 + 2.0 + 0.1)
        self.assertNotIn("audio_hold_cap_reached", log.categories())

    async def test_a_committable_final_grace_is_one_grace_after_the_final(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.0)
        tracker.on_speech_end(5.0)
        tracker.script.append((5.9, lambda: tracker.on_final(5.9, "i led the migration at my last company")))
        vc.t = 5.55
        await hold.before_first_audio()
        self.assertGreaterEqual(vc.t, 5.9 + 2.0, "the SDK's commit window is still waited out")
        self.assertLessEqual(vc.t, 5.9 + 2.3 + 0.05)

    async def test_noise_after_a_committable_final_cannot_reopen_the_grace_forever(self):
        """Banked words + recurring wordless noise: every segment end re-opens
        the commit window, but the quiet time spent in it is cumulative since
        the last final."""
        on, off = 0.8, 0.7
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.0)
        tracker.on_speech_end(5.0)
        tracker.script.append((5.6, lambda: tracker.on_final(5.6, "i led the migration at my last company")))
        _noise_bursts(tracker, first=6.0, on=on, off=off)
        vc.t = 5.55
        await hold.before_first_audio()
        quiet = (vc.t - 5.55) - _burst_overlap(6.0, on, off, 5.55, vc.t)
        self.assertLessEqual(quiet, 0.05 + 0.05 + 2.3 + 0.05, "one grace of quiet, however many bursts")
        self.assertLess(vc.t, 20.0)

    async def test_the_orphan_watch_counts_quiet_time_cumulatively(self):
        """Noise bursts used to reset the quiet deadline forever."""
        calls: list = []
        vc, tracker, hold, log = _virtual(cap=2.0, on_orphan=lambda: calls.append(vc.t))
        _noise_bursts(tracker, first=1.0, on=0.8, off=0.7)
        hold.carry = ("first part", 100.0)
        vc.t = 0.0
        await hold._watch_orphan()
        bound = hold._orphan_bound()             # endpoint max 2.0 + 2.0
        self.assertEqual(len(calls), 1)
        quiet = calls[0] - _burst_overlap(1.0, 0.8, 0.7, 0.0, calls[0])
        self.assertAlmostEqual(quiet, bound, delta=0.05)
        self.assertIn("carry_orphaned", log.categories())
        self.assertIsNone(hold.carry)

    async def test_the_orphan_watch_has_an_absolute_bound_too(self):
        calls: list = []
        vc, tracker, hold, log = _virtual(cap=2.0, on_orphan=lambda: calls.append(vc.t))
        _noise_bursts(tracker, first=0.5, on=5.0, off=0.05)   # almost no quiet time
        hold.carry = ("first part", 100.0)
        vc.t = 0.0
        await hold._watch_orphan()
        self.assertEqual(len(calls), 1)
        self.assertGreaterEqual(calls[0], turn_hold.ORPHAN_ABSOLUTE_SEC - 1e-6)
        self.assertLessEqual(calls[0], turn_hold.ORPHAN_ABSOLUTE_SEC + 1.05)

    async def test_a_stuck_open_segment_does_not_stall_the_orphan_watch(self):
        calls: list = []
        vc, tracker, hold, log = _virtual(cap=2.0, on_orphan=lambda: calls.append(vc.t))
        tracker.on_speech_start(0.0)              # the end event never arrives
        hold.carry = ("first part", 100.0)
        vc.t = 1.0
        await hold._watch_orphan()
        stale_at = turn_hold.OPEN_SEGMENT_STALE_SEC
        self.assertGreaterEqual(calls[0], stale_at + hold._orphan_bound() - 0.05)
        self.assertLess(calls[0], stale_at + hold._orphan_bound() + 1.05)


class TestNonInterruptibleLinesAreNeverHeld(unittest.IsolatedAsyncioTestCase):
    def _agent(self, hold, *, allow):
        agent = _build_agent()
        agent._turn_hold = hold
        agent.session = types.SimpleNamespace(
            current_speech=types.SimpleNamespace(allow_interruptions=allow))
        return agent

    async def _play(self, agent, vc):
        frames: list = []

        async def src():
            yield "Thank you for your time. We will be in touch shortly. Goodbye."

        async for frame in agent.tts_node(src(), None):
            frames.append((frame, vc.t))
        return frames

    async def test_the_fixed_closing_plays_at_once_over_a_talking_candidate(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        agent = self._agent(hold, allow=False)
        tracker.on_speech_start(4.7)               # still talking for 8 s, a committable final banked
        tracker.script.append((12.0, lambda: tracker.on_speech_end(12.0)))
        tracker.on_final(5.0, "yes I do have that experience")
        vc.t = 5.55
        frames = await self._play(agent, vc)
        self.assertEqual([f for f, _ in frames], ["f1", "f2", "f3"])
        self.assertEqual(frames[0][1], 5.55, "no hold and no commit grace for a line nothing can cancel")
        self.assertEqual(tracker.wait_calls, 0)
        self.assertNotIn("audio_hold", log.categories())
        self.assertEqual(log.meta("audio_hold_skipped")[0]["schema"], "non_interruptible")

    async def test_the_same_line_is_held_when_it_can_be_interrupted(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        agent = self._agent(hold, allow=True)
        tracker.on_speech_start(4.7)
        tracker.script.append((6.5, lambda: tracker.on_speech_end(6.5)))
        vc.t = 5.55
        frames = await self._play(agent, vc)
        self.assertGreaterEqual(frames[0][1], 6.5 + turn_hold.PENDING_CLOSED_EXPIRY_SEC)
        self.assertNotIn("audio_hold_skipped", log.categories())

    async def test_an_unknown_current_speech_is_treated_as_interruptible(self):
        # No session at all, and a session with no current speech.
        for session in (None, types.SimpleNamespace(current_speech=None)):
            vc, tracker, hold, log = _virtual(cap=2.0)
            agent = _build_agent()
            agent._turn_hold = hold
            if session is not None:
                agent.session = session
            tracker.on_speech_start(4.7)
            tracker.script.append((6.0, lambda: tracker.on_speech_end(6.0)))
            vc.t = 5.55
            frames = await self._play(agent, vc)
            self.assertGreaterEqual(frames[0][1], 6.0)

    async def test_a_broken_session_never_breaks_the_line(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        agent = _build_agent()
        agent._turn_hold = hold

        class _Boom:
            @property
            def current_speech(self):
                raise RuntimeError("no activity")

        agent.session = _Boom()
        tracker.on_speech_start(4.7)
        tracker.script.append((6.0, lambda: tracker.on_speech_end(6.0)))
        vc.t = 5.55
        frames = await self._play(agent, vc)
        self.assertEqual([f for f, _ in frames], ["f1", "f2", "f3"])

    async def test_the_hold_itself_skips_a_non_interruptible_line_and_stays_quiet_when_nothing_pends(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        vc.t = 5.0
        await hold.before_first_audio(interruptible=False)
        self.assertEqual(log.rows, [])             # nothing pending: no log noise
        tracker.on_speech_start(4.0)
        await hold.before_first_audio(interruptible=False)
        self.assertEqual(vc.t, 5.0)


class TestCommitGraceReopensAfterAWordlessSegment(unittest.IsolatedAsyncioTestCase):
    async def test_a_wordless_segment_after_a_committable_final_keeps_the_commit_window(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.0)
        tracker.on_speech_end(5.0)
        tracker.script.append((5.6, lambda: tracker.on_final(5.6, "i led the migration at my last company")))
        tracker.script.append((5.9, lambda: tracker.on_speech_start(5.9)))   # a cough
        tracker.script.append((6.4, lambda: tracker.on_speech_end(6.4)))
        vc.t = 5.55
        await hold.before_first_audio()
        # The SDK re-runs end-of-turn detection at 6.4 and may commit up to the
        # endpoint max (2.0) later: not released at the segment's own expiry (7.9).
        self.assertGreaterEqual(vc.t, 6.4 + 2.0 - 1e-6)
        self.assertLessEqual(vc.t, 6.4 + 2.3 + 0.05)

    async def test_a_wordless_segment_with_nothing_banked_still_releases_at_its_expiry(self):
        vc, tracker, hold, log = _virtual(cap=2.0)
        tracker.on_speech_start(4.0)
        tracker.on_speech_end(5.0)
        tracker.script.append((5.2, lambda: tracker.on_speech_start(5.2)))   # a cough
        tracker.script.append((5.3, lambda: tracker.on_final(5.3, "yes")))   # 1 word: cannot commit
        tracker.script.append((5.8, lambda: tracker.on_speech_end(5.8)))
        vc.t = 5.1
        await hold.before_first_audio()
        self.assertGreaterEqual(vc.t, 5.8 + turn_hold.PENDING_CLOSED_EXPIRY_SEC - 1e-6)
        self.assertLess(vc.t, 5.8 + turn_hold.PENDING_CLOSED_EXPIRY_SEC + 0.1)


class TestWiringIsolation(unittest.IsolatedAsyncioTestCase):
    async def test_gate_phase_events_never_reach_the_tracker_but_screening_events_do(self):
        class _GateEventSession(_RecordingSession):
            """Fires VAD + a final + a user-state change on every gate line."""

            vad_callback = None

            def say(self, text, **kwargs):
                speech = super().say(text, **kwargs)
                if not getattr(self.agent, "_screening_authorized", False):
                    self._candidate_noise()
                return speech

            def _candidate_noise(self):
                callback = type(self).vad_callback
                if callback is not None:
                    callback(types.SimpleNamespace(
                        type="start_of_speech", speech_duration=1.0,
                        inference_duration=0.0))
                    callback(types.SimpleNamespace(
                        type="end_of_speech", speech_duration=0.9,
                        inference_duration=0.0, silence_duration=0.3))
                state = self.handlers.get("user_state_changed")
                if state is not None:
                    state(types.SimpleNamespace(
                        old_state="listening", new_state="speaking", created_at=time.time()))
                    state(types.SimpleNamespace(
                        old_state="speaking", new_state="listening", created_at=time.time()))
                self.handlers["user_input_transcribed"](
                    types.SimpleNamespace(transcript="Yes, speaking", is_final=True))
                self.handlers["user_input_transcribed"](
                    types.SimpleNamespace(transcript="", is_final=True))

        def build_vad(callback):
            _GateEventSession.vad_callback = callback
            return None

        self.addCleanup(setattr, _GateEventSession, "vad_callback", None)
        with patch.object(agent_mod, "_build_phone_vad", build_vad):
            session, _ = await _SessionHarness(self).run(session_cls=_GateEventSession)
        hold = session.agent._turn_hold
        tracker = hold._tracker
        # Everything the gate fired was ignored: not armed, nothing recorded.
        self.assertIsNone(tracker.armed_at)
        self.assertEqual(tracker.final_count, 0)
        self.assertEqual(len(tracker._segments), 0)
        self.assertFalse(tracker.pending(time.time()))
        # And the wiring is real: the same events are recorded once armed.
        self.assertTrue(tracker.active())
        now = time.time()
        _GateEventSession.vad_callback(types.SimpleNamespace(
            type="start_of_speech", speech_duration=2.0, inference_duration=0.0))
        _GateEventSession.vad_callback(types.SimpleNamespace(
            type="end_of_speech", speech_duration=0.9, inference_duration=0.0,
            silence_duration=1.0))
        self.assertEqual(len(tracker._segments), 1)
        self.assertTrue(tracker.pending(time.time() + 0.1))
        session.handlers["user_input_transcribed"](
            types.SimpleNamespace(transcript="a later final", is_final=True))
        self.assertEqual(tracker.final_count, 1)
        self.assertFalse(tracker.pending(time.time() + 1.0))

    async def test_the_hold_rearm_and_orphan_backstop_reach_the_coordinators_watchdog(self):
        calls: list = []

        async def mid(session):
            hold = session.agent._turn_hold

            async def reply_expected(*, rearm_only=False, hold=False):
                calls.append((rearm_only, hold))

            session.agent._on_reply_expected = reply_expected
            await hold._rearm()
            calls.append("backstop")
            await hold._on_orphan()

        await _SessionHarness(self).run(
            questions=[_OPEN_Q, _YN_Q, _YN_Q2], replies=["An answer."], mid=mid)
        self.assertEqual(
            calls,
            [(True, True), "backstop", (False, False)],
            "the hold restarts the SAME generation as a hold re-arm; the "
            "orphan backstop arms a fresh watchdog",
        )

    async def test_the_yield_suspend_reaches_the_coordinators_watchdog(self):
        called: list = []

        async def mid(session):
            hold = session.agent._turn_hold
            original = session.agent._on_turn_hold_suspend
            session.agent._on_turn_hold_suspend = lambda: (
                called.append("suspend"), original())
            hold._suspend()

        await _SessionHarness(self).run(
            questions=[_OPEN_Q, _YN_Q, _YN_Q2], replies=["An answer."], mid=mid)
        self.assertEqual(called, ["suspend"])

    async def test_the_orphan_backstop_resets_the_empty_generation_latch(self):
        resets: list = []

        async def mid(session):
            original = session.agent._on_turn_hold_reset
            session.agent._on_turn_hold_reset = lambda: (
                resets.append("reset"), original())

            async def reply_expected(*, rearm_only=False, hold=False):
                resets.append("expected")

            session.agent._on_reply_expected = reply_expected
            await session.agent._turn_hold._on_orphan()

        await _SessionHarness(self).run(
            questions=[_OPEN_Q, _YN_Q, _YN_Q2], replies=["An answer."], mid=mid)
        self.assertEqual(resets, ["reset", "expected"], "reset BEFORE the watchdog arms")

    async def test_after_the_session_closes_the_orphan_backstop_stays_quiet(self):
        session, _ = await _SessionHarness(self).run()
        calls: list = []

        async def reply_expected(*, rearm_only=False, hold=False):
            calls.append((rearm_only, hold))

        session.agent._on_reply_expected = reply_expected
        await session.agent._turn_hold._on_orphan()
        self.assertEqual(calls, [])

    async def test_the_session_attaches_the_hold_and_closes_it(self):
        session, _ = await _SessionHarness(self).run()
        hold = getattr(session.agent, "_turn_hold", None)
        self.assertIsInstance(hold, turn_hold.TurnHold)
        self.assertIsNone(hold.carry)

    async def test_closing_the_session_closes_the_hold(self):
        """A carry still pending when the call ends is logged and its orphan
        watch stopped (deleting the `on_close` call in the close handler fails
        this)."""
        holds: list = []

        async def mid(session):
            hold = session.agent._turn_hold
            holds.append(hold)
            hold.carry = ("unmerged words", 1.0)
            hold._start_orphan_watch()
            self.assertIsNotNone(hold._orphan_task)

        with patch.object(turn_hold.TurnHold, "_emit", autospec=True) as emit:
            await _SessionHarness(self).run(
                questions=[_OPEN_Q, _YN_Q, _YN_Q2], replies=["An answer."], mid=mid)
        self.assertIsNone(holds[0].carry)
        self.assertIsNone(holds[0]._orphan_task)
        self.assertIn(
            "carry_unmerged_at_close", [c.args[2] for c in emit.call_args_list])

    async def test_the_gate_keeps_its_1_0_commit_timing_and_screening_gets_2_0(self):
        """Round 1, major: the identity / pickup / consent turns must commit on
        the gate-era max (1.0), not the screening 2.0; the consent turn tightens
        to 0.5 and restores to the gate max; screening raises it to 2.0."""
        session, _ = await _SessionHarness(self).run()
        self.assertAlmostEqual(session.ctor["max_endpointing_delay"], 1.0)
        maxes = [
            u["endpointing_opts"]["max_delay"] for u in session.option_updates
            if "max_delay" in (u.get("endpointing_opts") or {})
        ]
        self.assertEqual(maxes, [0.5, 1.0, 2.0])

    async def test_the_opt_in_dynamic_lane_keeps_the_gate_max_throughout(self):
        """Round 3, minor: with PHONE_DYNAMIC_ENDPOINTING on, the identity and
        consent turns must not run on the screening 2.0 either; the screening
        raise is local-mode only, so this lane stays on today's 1.0 timing."""
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_DYNAMIC_ENDPOINTING": "on"})
        self.assertAlmostEqual(
            session.ctor["turn_handling"]["endpointing"]["max_delay"], 1.0)
        maxes = [
            u["endpointing_opts"]["max_delay"] for u in session.option_updates
            if "max_delay" in (u.get("endpointing_opts") or {})
        ]
        self.assertNotIn(2.0, maxes)

    async def test_the_screening_max_follows_the_rollback_pin(self):
        """With the max pinned back to 1.0 the session never raises it."""
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "1.0"})
        self.assertAlmostEqual(session.ctor["max_endpointing_delay"], 1.0)
        maxes = [
            u["endpointing_opts"]["max_delay"] for u in session.option_updates
            if "max_delay" in (u.get("endpointing_opts") or {})
        ]
        self.assertNotIn(2.0, maxes)


# ── the watchdog seams, on the REAL coordinator (round 1 review) ─────────────

class TestWatchdogHoldSeams(unittest.IsolatedAsyncioTestCase):
    """`on_reply_expected(hold=True)`, the yield suspend and the orphan reset.

    The watchdog's monitor needs ~0.1 s on Windows to act on a 0.05 s deadline,
    so every positive assertion polls (bounded) instead of sleeping a guess.
    """

    TIMEOUT = 0.3

    async def _coordinator(self):
        agent, session, _, _, hooks = await fixtures._make_native_coordinator(
            turn_mode="toolless", state=fixtures._default_state(),
            coverage_judge_enabled=False)
        hooks["reply_started"].set()
        hooks["speech_first_audio"].clear()
        self.addCleanup(lambda: hooks["close_event"].set())
        return agent, session, hooks

    def _timeout(self):
        return patch.object(
            agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", self.TIMEOUT)

    @staticmethod
    async def _until(predicate, timeout=3.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.01)
        return predicate()

    async def test_a_hold_rearm_restarts_the_deadline_of_a_stalled_reply(self):
        agent, session, hooks = await self._coordinator()
        with self._timeout():
            before = len(session.spoken)
            await agent._on_reply_expected()
            await asyncio.sleep(0.2)
            await agent._on_reply_expected(rearm_only=True, hold=True)
            await asyncio.sleep(0.2)       # past the ORIGINAL 0.3 s deadline
            self.assertEqual(len(session.spoken), before, "the clock restarted")
            self.assertTrue(await self._until(lambda: len(session.spoken) == before + 1))

    async def test_a_hold_rearm_never_loops_on_a_fallback_that_is_held(self):
        """Round 1, major: the fallback's own first frame is held while speech
        is pending; its hold re-arm used to force-interrupt it and speak another
        fallback, once per Sarvam TTS call, until the candidate spoke."""
        agent, session, hooks = await self._coordinator()
        with self._timeout():
            before = len(session.spoken)
            agent._on_generation_empty("rejected")
            await agent._on_reply_expected()     # fires at once: generation empty
            self.assertTrue(await self._until(lambda: len(session.spoken) == before + 1))
            hooks["reply_handle"][0] = fixtures._FakeSpeech()   # the held say() line
            for _ in range(4):
                await agent._on_reply_expected(rearm_only=True, hold=True)
                await asyncio.sleep(0.1)
            self.assertEqual(len(session.spoken), before + 1, "still exactly one")
            self.assertEqual(hooks["reply_handle"][0].interrupt_calls, [])
            # Control: the plain re-arm (what the first-audio hold used to call)
            # does restart the watchdog and speaks a second fallback.
            await agent._on_reply_expected(rearm_only=True)
            self.assertTrue(await self._until(lambda: len(session.spoken) == before + 2))

    async def test_a_hold_rearm_is_a_no_op_once_first_audio_arrived(self):
        agent, session, hooks = await self._coordinator()
        with self._timeout():
            before = len(session.spoken)
            await agent._on_reply_expected()
            hooks["speech_first_audio"].set()
            await agent._on_reply_expected(rearm_only=True, hold=True)
            await asyncio.sleep(0.6)
            self.assertEqual(len(session.spoken), before)

    async def test_the_yield_suspend_stops_the_previous_replys_fallback(self):
        """Round 1, major: after a hook-time yield the previous reply's watchdog
        must not speak a stale fallback into the candidate's end-of-speech gap."""
        agent, session, hooks = await self._coordinator()
        with self._timeout():
            before = len(session.spoken)
            await agent._on_reply_expected()
            agent._on_turn_hold_suspend()
            await asyncio.sleep(0.7)
            self.assertEqual(len(session.spoken), before, "suspended")
            # Control: the same watchdog without the suspend does speak.
            await agent._on_reply_expected()
            self.assertTrue(await self._until(lambda: len(session.spoken) == before + 1))

    async def test_a_committable_final_near_the_cap_does_not_trigger_the_fallback(self):
        """Round 2, major: the commit grace runs past the cap, so the watchdog
        is re-armed when the grace begins; the real coordinator must not speak
        its fallback over the held reply."""
        agent, session, hooks = await self._coordinator()
        tracker, hold, log, _ = _make(cap=0.2, endpoint_max_sec=lambda: 0.2)
        rearm_calls: list = []

        def rearm():
            rearm_calls.append(time.monotonic())
            return agent._on_reply_expected(rearm_only=True, hold=True)

        with patch.object(agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", 0.7):
            before = len(session.spoken)
            await agent._on_reply_expected()
            _pend(tracker)
            asyncio.get_running_loop().call_later(
                0.18, lambda: tracker.on_final(time.time(), "three late words"))
            started = time.monotonic()
            await hold.before_first_audio(rearm=rearm)
            held = time.monotonic() - started
            self.assertGreaterEqual(held, 0.18 + 0.4, "the grace ran past the cap")
            self.assertEqual(len(rearm_calls), 2, "start of hold + start of grace")
            self.assertEqual(len(session.spoken), before, "no fallback during the hold")

    async def test_the_suspend_leaves_a_fallback_that_is_already_speaking(self):
        agent, session, hooks = await self._coordinator()
        with self._timeout():
            before = len(session.spoken)
            await agent._on_reply_expected()
            self.assertTrue(await self._until(lambda: len(session.spoken) == before + 1))
            agent._on_turn_hold_suspend()   # must not raise or cancel anything
            await asyncio.sleep(0.1)
            self.assertEqual(len(session.spoken), before + 1)

    async def test_the_suspend_does_not_cancel_the_task_of_a_claimed_fallback(self):
        """The guard is on the watchdog TASK, which `spoken` cannot show: a
        fallback that is playing keeps its task, a watchdog that has not claimed
        a fallback is stood down."""
        agent, session, hooks = await self._coordinator()
        playing = asyncio.Event()
        release = asyncio.Event()
        outcome: list = []

        class _Speech:
            async def wait_for_playout(self_inner):
                playing.set()
                try:
                    await release.wait()
                    outcome.append("finished")
                except asyncio.CancelledError:
                    outcome.append("cancelled")
                    raise

        session.say = lambda text, **kw: (session.spoken.append(text), _Speech())[1]
        with self._timeout():
            await agent._on_reply_expected()
            await asyncio.wait_for(playing.wait(), timeout=3)
            agent._on_turn_hold_suspend()
            await asyncio.sleep(0.05)
            self.assertEqual(outcome, [], "the playing fallback was left alone")
            release.set()
            self.assertTrue(await self._until(lambda: outcome == ["finished"]))

    async def test_the_suspend_stands_down_a_watchdog_that_has_not_fired(self):
        agent, session, hooks = await self._coordinator()
        before = len(session.spoken)
        with self._timeout():
            await agent._on_reply_expected()    # armed with the short test timeout
            agent._on_turn_hold_suspend()
            await asyncio.sleep(self.TIMEOUT * 3)
        self.assertEqual(len(session.spoken), before, "a suspended watchdog never speaks")

    async def test_control_an_unsuspended_watchdog_does_speak(self):
        agent, session, hooks = await self._coordinator()
        before = len(session.spoken)
        with self._timeout():
            await agent._on_reply_expected()
            self.assertTrue(await self._until(lambda: len(session.spoken) == before + 1))

    async def test_the_orphan_reset_clears_a_stale_empty_generation(self):
        """Round 1, nit: without the per-turn reset the backstop's watchdog fires
        at once as `generation_completed_empty` for a generation that never ran."""
        agent, session, hooks = await self._coordinator()

        def categories():
            return [
                c.kwargs.get("error_category") for c in hooks["log"].warn.call_args_list
                if c.kwargs.get("error_type") == "phone_speech_lifecycle"
            ]

        with self._timeout():
            agent._on_generation_empty("stale_reason")
            agent._on_turn_hold_reset()
            hooks["log"].reset_mock()
            await agent._on_reply_expected()
            self.assertTrue(await self._until(lambda: bool(categories())))
        self.assertNotIn("generation_completed_empty", categories())
        self.assertIn("no_first_audio", categories())


# ── 4.8 the gate replays at the production max (AC 6) ────────────────────────

class TestGateReplaysAtProductionMax(unittest.TestCase):
    """The gate at the production max of 2.0 (AC 6).

    `gate_replay` strips the env override and so runs on the code default
    (0.8). Every replay case is re-run with that default patched to 2.0.

    M014 decision (AC 6): an uncapped settle (max + 250 ms) changed the closing
    path of two cases at max >= ~1.2. The gate settle is pinned to the old 1.0
    max (`agent.GATE_SETTLE_MAX_CEILING_SEC`), so the gate keeps today's
    timing and every replay case passes at 2.0.
    """

    KNOWN_DIVERGENT = frozenset()

    def test_the_gate_settle_keeps_the_1_0_timing_at_2_0(self):
        with _Env():
            with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 2.0):
                at_2_0 = agent_mod._gate_turn_settle_ms()
            with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 1.0):
                at_1_0 = agent_mod._gate_turn_settle_ms()
            with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 0.8):
                at_0_8 = agent_mod._gate_turn_settle_ms()
        self.assertEqual(at_2_0, 1250)
        self.assertEqual(at_1_0, 1250)
        self.assertEqual(at_0_8, 1050)

    def _suite(self):
        import tests.test_phone_gate_replay as replay_tests

        loader = unittest.TestLoader()
        suite = unittest.TestSuite()
        for name in dir(replay_tests):
            obj = getattr(replay_tests, name)
            if (
                isinstance(obj, type) and issubclass(obj, unittest.TestCase)
                and obj.__module__ == replay_tests.__name__
            ):
                suite.addTests(loader.loadTestsFromTestCase(obj))
        return suite

    def test_every_replay_case_passes_at_2_0(self):
        suite = self._suite()
        self.assertGreater(suite.countTestCases(), 20, "not vacuous")
        stream = io.StringIO()
        with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 2.0):
            with _Env():
                self.assertAlmostEqual(phone.phone_static_endpointing_max_delay(), 2.0)
                result = unittest.TextTestRunner(stream=stream, verbosity=0).run(suite)
        failed = {
            ".".join(test.id().split(".")[-2:])
            for test, _ in list(result.failures) + list(result.errors)
        }
        self.assertEqual(failed, set(self.KNOWN_DIVERGENT), stream.getvalue()[-3000:])

    def test_the_diverging_cases_reach_the_same_decisions(self):
        import tests.gate_replay as gr
        import tests.test_phone_gate_replay as replay_tests

        def outcome(result):
            return (
                result.decision, list(result.consumed), list(result.spoken_kinds()),
                [t.text for t in result.gate_turns],
                [row[1] for row in result.candidate_rows()],
            )

        recorded = gr.load_fixture("32757295")
        shape = replay_tests._synthetic(
            "late_commit", consent=(3000, 4000, 4800),
            segments=[(5000, 5500)], finals=[(6000, "Yes, go ahead.")],
            commits=[(7400, "Yes, go ahead.", 5000)])
        for label, run in (
            ("recorded 32757295", lambda: gr.replay(recorded)),
            ("late-commit shape", lambda: gr.replay(
                shape, driver=replay_tests._then_wait(8000))),
        ):
            with self.subTest(label):
                with _Env():
                    with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 0.8):
                        before = run()
                    with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 2.0):
                        after = run()
                self.assertEqual(outcome(after), outcome(before))
        # And the recorded call's identity decision lands at the same instant.
        with _Env():
            with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 0.8):
                before = gr.replay(recorded)
            with patch.object(phone, "PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC", 2.0):
                after = gr.replay(recorded)
        self.assertEqual(after.identity_verdict, before.identity_verdict)
        self.assertEqual(after.identity_decided_at_ms, before.identity_decided_at_ms)
        self.assertEqual(after.decision_at_ms, before.decision_at_ms)


if __name__ == "__main__":
    unittest.main()
