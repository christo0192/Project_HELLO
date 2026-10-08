"""M014 PR-B: endpointing max 2.0 and the per-question minimum.

The 2026-10-08 interruption RCA: Sarvam is finals-only (a final arrives
~0.9-1.0 s after the candidate stops), so the SDK started or resumed the bot's
reply on 0.15-0.25 s of quiet, long before the words existed. PR-B raises the
screening endpointing max to 2.0 and applies a longer minimum
(`PHONE_OPEN_ANSWER_MIN_DELAY_SEC`, 0.8) while the bot waits for an OPEN answer.
The session STARTS at the gate max (the pre-M014 1.0 s,
`phone.phone_gate_endpointing_max_delay`) and the screening max is applied when
the screening phase is armed, so the pickup / identity / consent turns keep their
decision timing.

Synthetic text and timelines only: no candidate data. Runs on bare python3
(SDK stubbed via the shared `test_phone_gate` fixtures); the real-SDK facts
these tests rest on are pinned in `test_endpointing_sdk_contract.py`.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import pathlib
import re
import tomllib
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures

import endpointing_phase  # noqa: E402

agent_mod = fixtures.agent_mod
phone = fixtures.phone

_CTX = pathlib.Path(__file__).resolve().parent.parent  # app/voice-livekit
_REPO = _CTX.parent.parent

_ENV_KEYS = (
    "PHONE_OPEN_ANSWER_MIN_DELAY_SEC",
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


class _Log:
    def __init__(self):
        self.rows: list[tuple[str, dict]] = []

    def __call__(self, event, **meta):
        self.rows.append((meta.get("error_category"), meta))

    def categories(self) -> list:
        return [c for c, _ in self.rows]

    def meta(self, category):
        return [m for c, m in self.rows if c == category]


def _make(*, active=True, open_min=0.8, short_min=0.3):
    state = {"active": active}
    log = _Log()
    phase = endpointing_phase.PhoneEndpointingPhase(
        active=lambda: state["active"],
        open_min_sec=lambda: open_min,
        short_min_sec=lambda: short_min,
        log=log,
    )
    return phase, log, state


def _created(tracker, *, source, phase, objective, apply_min):
    """A reply is created and starts playing; its snapshot holds phase/objective."""
    tracker.on_speech_created(source=source, handle=None, apply_min=apply_min)
    tracker.reply_playing(phase=phase, objective=objective)


# ── readers, clamps and manifest pins ────────────────────────────────────────

class TestReaders(unittest.TestCase):
    def test_open_answer_min_defaults_and_clamps(self):
        cases = (
            (None, 0.8), ("", 0.8), ("0.8", 0.8), ("0.1", 0.3), ("5", 1.2),
            ("nope", 0.8), ("nan", 0.8), ("inf", 0.8), ("0.5", 0.5), ("0.3", 0.3),
        )
        for raw, expected in cases:
            env = {
                "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "2.0",
                "PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC": "0.3",
            }
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

    def test_open_answer_min_is_floored_at_the_static_min(self):
        """The rollback value 0.3 can only ever be a no-op, never an inversion."""
        with _Env({
            "PHONE_OPEN_ANSWER_MIN_DELAY_SEC": "0.3",
            "PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC": "0.5",
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "2.0",
        }):
            self.assertAlmostEqual(phone.phone_open_answer_min_delay(), 0.5)
        # Unset static min: the reader default (0.4) is the floor.
        with _Env({
            "PHONE_OPEN_ANSWER_MIN_DELAY_SEC": "0.3",
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": "2.0",
        }):
            self.assertAlmostEqual(
                phone.phone_open_answer_min_delay(),
                phone.phone_static_endpointing_min_delay())

    def test_the_gate_max_is_capped_at_the_pre_m014_ceiling(self):
        cases = (("2.0", 1.0), ("3.0", 1.0), ("1.0", 1.0), ("0.8", 0.8), ("0.5", 0.5))
        for raw, expected in cases:
            with self.subTest(raw=raw), _Env({"PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": raw}):
                self.assertAlmostEqual(phone.phone_gate_endpointing_max_delay(), expected)

    def test_static_max_clamp_admits_2_0(self):
        cases = (
            ("2.0", 2.0), ("0.1", 0.5), ("9", 3.0),
            ("", phone.PHONE_LOCAL_ENDPOINTING_MAX_DELAY_SEC),
        )
        for raw, expected in cases:
            with self.subTest(raw=raw), _Env({"PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": raw}):
                self.assertAlmostEqual(phone.phone_static_endpointing_max_delay(), expected)

    def test_the_toml_pins_the_three_values(self):
        env = tomllib.loads((_CTX / "fly.phone.toml").read_text(encoding="utf-8"))["env"]
        self.assertEqual(env["PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC"], "2.0")
        self.assertEqual(env["PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC"], "0.3")
        self.assertEqual(env["PHONE_OPEN_ANSWER_MIN_DELAY_SEC"], "0.8")
        # Honoured by the readers, not clamped away.
        with _Env({k: env[k] for k in (
            "PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC",
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC",
            "PHONE_OPEN_ANSWER_MIN_DELAY_SEC",
        )}):
            self.assertAlmostEqual(phone.phone_static_endpointing_max_delay(), 2.0)
            self.assertAlmostEqual(phone.phone_static_endpointing_min_delay(), 0.3)
            self.assertAlmostEqual(phone.phone_open_answer_min_delay(), 0.8)

    def test_the_schema_and_env_example_declare_the_new_name(self):
        schema = json.loads(
            (_REPO / "config" / "environment.schema.json").read_text(encoding="utf-8"))
        variables = schema["components"]["voice-livekit"]["variables"]
        example = (_CTX / ".env.example").read_text(encoding="utf-8")
        name = "PHONE_OPEN_ANSWER_MIN_DELAY_SEC"
        self.assertIn(name, variables)
        self.assertFalse(variables[name]["requiredInProduction"])
        self.assertFalse(variables[name]["secret"])
        self.assertRegex(example, rf"(?m)^{name}=")

    def test_the_dockerfile_ships_the_new_module_on_the_one_copy_line(self):
        dockerfile = (_CTX / "Dockerfile").read_text(encoding="utf-8")
        copies = re.findall(r"(?m)^COPY agent\.py .*\./\r?$", dockerfile)
        self.assertEqual(len(copies), 1)
        self.assertRegex(copies[0], r"\bendpointing_phase\.py\b")
        self.assertRegex(copies[0], r"\br1_tts\.py\b")

    def test_quality_workflow_compiles_the_module_and_runs_the_sdk_contract(self):
        workflow = (_REPO / ".github" / "workflows" / "quality.yml").read_text(encoding="utf-8")
        self.assertIn("app/voice-livekit/endpointing_phase.py", workflow)
        self.assertIn("ENDPOINTING_SDK_CONTRACT_REQUIRED=1", workflow)
        self.assertIn("tests.test_endpointing_sdk_contract", workflow)

    def test_the_consent_max_tightening_is_untouched(self):
        with _Env():
            self.assertAlmostEqual(phone.phone_consent_endpointing_max_delay(), 0.5)


# ── classifier ───────────────────────────────────────────────────────────────

class TestClassifier(unittest.TestCase):
    def test_the_table(self):
        table = (
            ("screening", "Tell me about your last role", "open"),
            ("screening",
             "Would you be comfortable working from the office and are you open to relocating?",
             "short"),
            ("screening", "When can you join?", "open"),
            ("screening", "Do you have a laptop?", "short"),
            ("screening", "Great. Do you have a laptop?", "short"),
            ("screening", "Great. Do you have a laptop at home?", "short"),
            ("screening", "Okay, so are you currently employed?", "short"),
            ("screening", "Great. What is your notice period?", "open"),
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
                    endpointing_phase.classify_answer_endpointing(phase, objective), expected)

    def test_a_missing_objective_in_screening_is_open(self):
        self.assertEqual(
            endpointing_phase.classify_answer_endpointing("screening", None), "open")

    def test_yes_no_detection_edges(self):
        yes_no = (
            "Do you have a laptop?",
            "Great, are you currently employed?",
            "Okay. Can you start next month?",
            "Great. Do you ever work weekends?",
            "Is that a hard requirement, or would you consider remote?",
            "Is your current notice period negotiable?",
            "Is the night shift okay for you?",
        )
        for text in yes_no:
            with self.subTest(text=text):
                self.assertTrue(endpointing_phase.is_yes_no_question(text))
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
                self.assertFalse(endpointing_phase.is_yes_no_question(text))


# ── class-change-only application, deferral, failures ───────────────────────

class TestPerPhaseMinimum(unittest.TestCase):
    def _phase(self, *, active=True):
        phase, log, _ = _make(active=active, open_min=0.8, short_min=0.3)
        applied: list = []
        return phase, log, applied, applied.append

    def test_the_minimum_waits_for_the_replys_first_audio(self):
        """Creating the reply must not change the minimum: the SDK is still
        deciding when to START it, using the class of the answer it follows."""
        phase, log, applied, apply = self._phase()
        phase.on_speech_created(source="generate_reply", handle=None, apply_min=apply)
        self.assertEqual(applied, [])
        self.assertEqual(log.rows, [])
        phase.reply_playing(phase="screening", objective="Tell me about your last role")
        self.assertEqual(applied, [0.8])
        phase.reply_playing(phase="screening", objective="Tell me about your last role")
        self.assertEqual(applied, [0.8])      # consumed: nothing is applied twice

    def test_the_class_is_read_when_the_reply_plays_not_when_it_is_created(self):
        """Preemptive generation creates the reply BEFORE the turn is authorized,
        so the snapshot still holds the previous question at creation time."""
        phase, _, applied, apply = self._phase()
        snapshot = {"phase": "screening", "objective": "Do you have a laptop?"}
        phase.on_speech_created(source="generate_reply", handle=None, apply_min=apply)
        snapshot.update(objective="Tell me about your last role")   # authorized later
        phase.reply_playing(phase=snapshot["phase"], objective=snapshot["objective"])
        self.assertEqual(applied, [0.8])

    def test_a_reply_that_never_plays_does_not_change_the_minimum(self):
        phase, _, applied, apply = self._phase()
        phase.on_speech_created(source="generate_reply", handle=None, apply_min=apply)
        # Cancelled before any audio; the next reply asks a yes/no question.
        phase.on_speech_created(source="generate_reply", handle=None, apply_min=apply)
        phase.reply_playing(phase="screening", objective="Do you have a laptop?")
        self.assertEqual(applied, [])

    def test_another_line_playing_first_does_not_consume_the_deferral(self):
        """A say() / recovery line that plays before the generated reply must not
        apply that reply's class early."""
        phase, _, applied, apply = self._phase()
        reply, say_line = object(), object()
        phase.on_speech_created(source="generate_reply", handle=reply, apply_min=apply)
        phase.reply_playing(
            playing_handle=say_line, phase="screening",
            objective="Tell me about your last role")
        self.assertEqual(applied, [])
        phase.reply_playing(
            playing_handle=reply, phase="screening",
            objective="Tell me about your last role")
        self.assertEqual(applied, [0.8])

    def test_a_finished_reply_that_never_played_drops_the_deferral(self):
        class _Done:
            def done(self):
                return True

        phase, _, applied, apply = self._phase()
        phase.on_speech_created(source="generate_reply", handle=_Done(), apply_min=apply)
        phase.reply_playing(
            playing_handle=object(), phase="screening",
            objective="Tell me about your last role")
        phase.reply_playing(
            playing_handle=object(), phase="screening",
            objective="Tell me about your last role")
        self.assertEqual(applied, [])

    def test_a_reply_with_no_phase_keeps_the_current_class(self):
        """The silence re-ask of an open question sets no snapshot: the class of
        the question being re-asked is unchanged, not reset to short."""
        phase, log, applied, apply = self._phase()
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=apply)
        _created(phase, source="generate_reply", phase=None,
                 objective=None, apply_min=apply)
        self.assertEqual(applied, [0.8])
        self.assertEqual(log.categories(), ["open"])

    def test_patience_and_qna_lines_are_open_withdrawal_and_callback_short(self):
        phase, _, applied, apply = self._phase()
        _created(phase, source="generate_reply", phase="patience",
                 objective=None, apply_min=apply)
        self.assertEqual(applied, [0.8])
        for short in ("callback", "withdrawal_confirm", "candidate_opt_out", "candidate_end"):
            with self.subTest(phase=short):
                p2, _, a2, ap2 = self._phase()
                _created(p2, source="generate_reply", phase="screening",
                         objective="Tell me about your last role", apply_min=ap2)
                _created(p2, source="generate_reply", phase=short,
                         objective=None, apply_min=ap2)
                self.assertEqual(a2, [0.8, 0.3])

    def test_open_then_the_same_class_is_applied_once(self):
        phase, log, applied, apply = self._phase()
        for _ in range(3):
            _created(
                phase, source="generate_reply", phase="screening",
                objective="Tell me about your last role", apply_min=apply)
        self.assertEqual(applied, [0.8])
        self.assertEqual(log.categories(), ["open"])
        meta = log.meta("open")[0]
        self.assertEqual(meta["error_type"], "phone_endpointing_phase")
        self.assertEqual(meta["phase"], "screening")
        self.assertAlmostEqual(meta["duration_sec"], 0.8)

    def test_a_yes_no_question_after_open_goes_back_to_the_static_minimum(self):
        phase, log, applied, apply = self._phase()
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=apply)
        _created(phase, source="generate_reply", phase="screening",
                 objective="Do you have a laptop?", apply_min=apply)
        self.assertEqual(applied, [0.8, 0.3])
        self.assertEqual(log.categories(), ["open", "short"])

    def test_a_greeting_led_yes_no_question_is_short(self):
        phase, _, applied, apply = self._phase()
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=apply)
        _created(phase, source="generate_reply", phase="screening",
                 objective="Great. Do you have a laptop?", apply_min=apply)
        self.assertEqual(applied, [0.8, 0.3])

    def test_name_confirm_after_open_is_short(self):
        phase, _, applied, apply = self._phase()
        _created(phase, source="generate_reply", phase="candidate_qna",
                 objective="", apply_min=apply)
        _created(phase, source="generate_reply", phase="name_confirm",
                 objective="Is that right?", apply_min=apply)
        self.assertEqual(applied, [0.8, 0.3])

    def test_callback_and_closing_are_short(self):
        for terminal in ("callback", "closing", "end", "close_scheduled"):
            with self.subTest(phase=terminal):
                phase, _, applied, apply = self._phase()
                _created(phase, source="generate_reply", phase="screening",
                         objective="Tell me about your last role", apply_min=apply)
                _created(phase, source="generate_reply", phase=terminal,
                         objective="", apply_min=apply)
                self.assertEqual(applied, [0.8, 0.3])

    def test_the_first_short_class_needs_no_call(self):
        phase, _, applied, apply = self._phase()
        _created(phase, source="generate_reply", phase="screening",
                 objective="Do you have a laptop?", apply_min=apply)
        self.assertEqual(applied, [])

    def test_say_lines_keep_the_current_class(self):
        phase, _, applied, apply = self._phase()
        _created(phase, source="say", phase="screening",
                 objective="Tell me about your last role", apply_min=apply)
        self.assertEqual(applied, [])
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=apply)
        _created(phase, source="say", phase="closing", objective="", apply_min=apply)
        self.assertEqual(applied, [0.8])

    def test_before_activation_nothing_is_applied(self):
        phase, log, applied, apply = self._phase(active=False)
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=apply)
        phase.set_phase_apply(apply)
        phase.note_spoken_question(phase="screening", objective="Tell me about your last role")
        self.assertEqual(applied, [])
        self.assertEqual(log.rows, [])

    def test_no_apply_callable_is_a_no_op(self):
        phase, log, _, _ = self._phase()
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=None)
        phase.note_spoken_question(phase="screening", objective="Tell me about your last role")
        self.assertEqual(log.rows, [])

    def test_the_first_spoken_question_applies_its_class(self):
        phase, log, applied, apply = self._phase()
        phase.set_phase_apply(apply)
        phase.note_spoken_question(phase="screening", objective="Tell me about your last role")
        self.assertEqual(applied, [0.8])
        phase.note_spoken_question(phase="screening", objective="Tell me about your last role")
        self.assertEqual(applied, [0.8])
        self.assertEqual(log.categories(), ["open"])

    def test_a_yes_no_first_spoken_question_applies_nothing(self):
        phase, log, applied, apply = self._phase()
        phase.set_phase_apply(apply)
        phase.note_spoken_question(phase="screening", objective="Do you have a laptop?")
        self.assertEqual(applied, [])
        self.assertEqual(log.rows, [])

    def test_a_failing_update_is_logged_swallowed_and_retried(self):
        phase, log, _, _ = self._phase()
        attempts: list = []

        def failing(value):
            attempts.append(value)
            raise RuntimeError("update_options failed")

        for _ in range(2):
            _created(phase, source="generate_reply", phase="screening",
                     objective="Tell me about your last role", apply_min=failing)
        self.assertEqual(attempts, [0.8, 0.8])
        self.assertEqual(log.categories(), ["apply_failed", "apply_failed"])
        good: list = []
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=good.append)
        self.assertEqual(good, [0.8])

    def test_a_failing_log_sink_never_raises(self):
        def broken_log(*args, **kwargs):
            raise RuntimeError("log sink down")

        phase = endpointing_phase.PhoneEndpointingPhase(
            active=lambda: True, open_min_sec=lambda: 0.8,
            short_min_sec=lambda: 0.3, log=broken_log)
        applied: list = []
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=applied.append)
        self.assertEqual(applied, [0.8])

    def test_a_failing_active_predicate_is_inactive(self):
        def boom():
            raise RuntimeError("state unavailable")

        phase = endpointing_phase.PhoneEndpointingPhase(
            active=boom, open_min_sec=lambda: 0.8, short_min_sec=lambda: 0.3)
        applied: list = []
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=applied.append)
        self.assertEqual(applied, [])

    def test_rollback_value_equal_to_the_static_min_sends_nothing(self):
        phase, log, _ = _make(open_min=0.3, short_min=0.3)
        applied: list = []
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me about your last role", apply_min=applied.append)
        _created(phase, source="generate_reply", phase="screening",
                 objective="Do you have a laptop?", apply_min=applied.append)
        self.assertEqual(applied, [])

    def test_an_unsafe_phase_value_is_not_logged_verbatim(self):
        phase, log, _, apply = self._phase()
        _created(phase, source="generate_reply", phase="screening",
                 objective="Tell me", apply_min=apply)
        self.assertEqual(log.meta("open")[0]["phase"], "screening")
        self.assertEqual(endpointing_phase._safe_phase("a b; drop"), "unknown")
        self.assertEqual(endpointing_phase._safe_phase(None), "unknown")

    def test_the_module_never_holds_or_delays_a_reply(self):
        """PR-B ships no hold: the module has no async surface and no timers."""
        source = (_CTX / "endpointing_phase.py").read_text(encoding="utf-8")
        self.assertNotIn("asyncio", source)
        self.assertNotIn("sleep", source)
        self.assertNotIn("StopResponse", source)


# ── the same behaviour through a full phone session ─────────────────────────

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

    async def run(self, *, questions=None, replies=None, env=None, session_cls=None):
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
            session.emit_close()
            await asyncio.wait_for(task, timeout=8)
        return session, client


_OPEN_Q = {"key": "k1", "text": "Tell me about your last project.", "mandatory": True, "hint": None}
_YN_Q = {"key": "k2", "text": "Do you have a laptop?", "mandatory": False, "hint": None}
_YN_Q2 = {"key": "k3", "text": "Are you open to relocating?", "mandatory": False, "hint": None}


class TestPerPhaseMinimumThroughTheSession(unittest.IsolatedAsyncioTestCase):
    #: Production pins toolless; toolfirst is the explicit rollback. Preemptive
    #: generation is off (its production value is a Fly secret that cannot be read).
    MODES = ("toolless", "toolfirst")

    def _mode_env(self, mode, **more):
        return {"PHONE_TURN_MODE": mode, "PHONE_OBJECTIVE_PREEMPTIVE": "off", **more}

    async def test_open_questions_apply_the_open_minimum_once_and_closing_goes_back(self):
        # toolfirst applies the closing class too; toolless ends the call on the
        # closing line, so only the open class is ever applied there.
        expected = {"toolless": [0.8], "toolfirst": [0.8, 0.3]}
        for mode in self.MODES:
            with self.subTest(mode=mode):
                session, _ = await _SessionHarness(self).run(env=self._mode_env(mode))
                self.assertEqual(session.min_updates(), expected[mode])
                # The endpointing max updates (gate + screening) are a separate key.
                self.assertTrue(any(
                    "max_delay" in (u.get("endpointing_opts") or {})
                    for u in session.option_updates))
                for update in session.option_updates:
                    opts = update["endpointing_opts"]
                    self.assertTrue(
                        set(opts) == {"min_delay"} or set(opts) == {"max_delay"}, opts)

    async def test_gate_isolation_no_minimum_is_sent_before_screening(self):
        """Identity, pickup and consent turns never see a minimum update: every
        `min_delay` update comes after the last gate (consent) max update."""
        for mode in self.MODES:
            with self.subTest(mode=mode):
                session, _ = await _SessionHarness(self).run(env=self._mode_env(mode))
                kinds = [
                    "min" if "min_delay" in u["endpointing_opts"] else "max"
                    for u in session.option_updates
                ]
                self.assertIn("min", kinds)
                self.assertIn("max", kinds)
                self.assertLess(
                    max(i for i, k in enumerate(kinds) if k == "max"),
                    min(i for i, k in enumerate(kinds) if k == "min"),
                    kinds)

    async def test_the_session_starts_at_the_gate_max_and_screening_raises_it(self):
        """M014: pickup / identity / consent run at the pre-M014 1.0 s max, NOT the
        screening 2.0. The consent turn tightens to 0.5 and restores to 1.0, and
        the 2.0 arrives only when the screening phase is armed (after the gate,
        before the first screening reply)."""
        for mode in self.MODES:
            with self.subTest(mode=mode):
                session, _ = await _SessionHarness(self).run(env=self._mode_env(mode))
                self.assertEqual(session.ctor["max_endpointing_delay"], 1.0)
                self.assertEqual(session.ctor["min_endpointing_delay"], 0.3)
                maxes = [
                    u["endpointing_opts"]["max_delay"] for u in session.option_updates
                    if "max_delay" in u["endpointing_opts"]
                ]
                self.assertEqual(maxes, [0.5, 1.0, 2.0])

    async def test_the_rollback_max_never_raises_above_the_gate(self):
        session, _ = await _SessionHarness(self).run(
            env=self._mode_env("toolless", PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC="1.0"))
        self.assertEqual(session.ctor["max_endpointing_delay"], 1.0)
        maxes = [
            u["endpointing_opts"]["max_delay"] for u in session.option_updates
            if "max_delay" in u["endpointing_opts"]
        ]
        self.assertEqual(maxes, [0.5, 1.0])

    async def test_a_failed_screening_raise_leaves_the_gate_max_and_the_call_runs(self):
        class _NoRaise(_RecordingSession):
            def update_options(self, **kwargs):
                if (kwargs.get("endpointing_opts") or {}).get("max_delay") == 2.0:
                    raise RuntimeError("update_options failed")
                return super().update_options(**kwargs)

        session, client = await _SessionHarness(self).run(
            session_cls=_NoRaise, env=self._mode_env("toolless"))
        self.assertIn("assessment.completed", client.event_types)

    async def test_the_agent_seam_classifies_from_the_snapshot_when_the_reply_plays(self):
        """The class comes from the reply snapshot read at first audio: the
        phases/objectives the module sees are the question just asked."""
        seen: list = []
        real = endpointing_phase.PhoneEndpointingPhase.reply_playing

        def spy(self_, **kwargs):
            seen.append((kwargs.get("phase"), kwargs.get("objective")))
            return real(self_, **kwargs)

        for mode in self.MODES:
            seen.clear()
            with self.subTest(mode=mode), patch.object(
                endpointing_phase.PhoneEndpointingPhase, "reply_playing", spy,
            ):
                await _SessionHarness(self).run(
                    questions=[_OPEN_Q, _YN_Q, _YN_Q2],
                    replies=["I built it.", "Yes.", "No."],
                    env=self._mode_env(mode))
            phases = [p for p, _ in seen if p]
            self.assertIn("screening", phases)
            self.assertTrue(
                any(o and "laptop" in o for p, o in seen if p == "screening"), seen)

    async def test_an_open_first_question_gets_the_open_minimum_when_heard(self):
        """Q1 is a say() line, so no generated reply noted its class."""
        for mode in self.MODES:
            with self.subTest(mode=mode):
                session, _ = await _SessionHarness(self).run(
                    questions=[_OPEN_Q, _YN_Q, _YN_Q2],
                    replies=["I built it.", "Yes.", "No."],
                    env=self._mode_env(mode))
                self.assertEqual(session.min_updates()[:1], [0.8])
                # Q2 is a yes/no: back to the static minimum once it plays.
                self.assertEqual(session.min_updates()[:2], [0.8, 0.3])

    async def test_a_yes_no_first_question_never_touches_the_minimum(self):
        session, _ = await _SessionHarness(self).run(
            questions=[_YN_Q, _YN_Q2], replies=["Yes.", "No."])
        self.assertEqual(session.min_updates(), [])

    async def test_a_yes_no_question_returns_to_the_static_minimum(self):
        for mode in self.MODES:
            with self.subTest(mode=mode):
                session, _ = await _SessionHarness(self).run(
                    questions=[_YN_Q, _OPEN_Q, _YN_Q2],
                    replies=["Yes.", "I built it.", "No."],
                    env=self._mode_env(mode))
                self.assertEqual(session.min_updates()[:2], [0.8, 0.3])

    async def test_dynamic_endpointing_keeps_the_gate_max(self):
        """The opt-in dynamic lane is built at the gate max (1.0), not the 2.0
        screening max, so its gate timing and the 1250 ms settle stay paired."""
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_DYNAMIC_ENDPOINTING": "on"})
        endpointing = session.ctor["turn_handling"]["endpointing"]
        self.assertEqual(endpointing["mode"], "dynamic")
        self.assertEqual(endpointing["max_delay"], 1.0)

    async def test_dynamic_endpointing_is_not_touched(self):
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_DYNAMIC_ENDPOINTING": "on"})
        self.assertEqual(session.min_updates(), [])
        self.assertNotIn(2.0, [
            (u.get("endpointing_opts") or {}).get("max_delay")
            for u in session.option_updates])

    async def test_stt_turn_detection_is_not_touched(self):
        session, _ = await _SessionHarness(self).run(
            env={"PHONE_TURN_DETECTION": "stt"})
        self.assertEqual(session.min_updates(), [])
        self.assertNotIn(2.0, [
            (u.get("endpointing_opts") or {}).get("max_delay")
            for u in session.option_updates])

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


class TestEveryReplyPhaseIsClassified(unittest.TestCase):
    """Every `phase=` literal agent.py puts in a reply snapshot has a documented
    class, so a new phase cannot silently fall into the wrong one."""

    OPEN = {"candidate_qna", "patience", "post_interrupt_ack", "resume_conflict",
            "screening", "wind_down"}
    SHORT = {"callback", "candidate_end", "candidate_opt_out", "close_scheduled",
             "closing", "drop_or_timeout", "exception", "name_confirm",
             "revocation_confirm", "teardown", "withdrawal_confirm"}

    def test_the_phase_literals_in_agent_py(self):
        source = (_CTX / "agent.py").read_text(encoding="utf-8")
        found = set(re.findall(r'phase="([a-z_]+)"', source))
        # Phases passed through a variable (`_judge_phase = "a" if x else "b"`).
        for line in re.findall(r'^\s*\w*_phase = ("[^\r\n]+)$', source, re.M):
            found |= set(re.findall(r'"([a-z_]{3,})"', line))
        found.discard("unknown")
        self.assertGreater(len(found), 10)
        self.assertEqual(found - self.OPEN - self.SHORT, set(), "unclassified phase")
        for phase in sorted(found):
            with self.subTest(phase=phase):
                expected = "open" if phase in self.OPEN else "short"
                self.assertEqual(
                    endpointing_phase.classify_answer_endpointing(phase, None), expected)
        self.assertEqual(self.OPEN, set(endpointing_phase.OPEN_PHASES))


# ── the gate at the production max of 2.0 ────────────────────────────────────

class TestGateReplaysAtProductionMax(unittest.TestCase):
    """The gate at the production screening max of 2.0.

    The session starts at the GATE max (`phone.phone_gate_endpointing_max_delay`,
    the pre-M014 1.0 s) and the screening max is applied only when the screening
    phase is armed, so the SDK's own commit timing on identity / pickup / consent
    turns is the pre-M014 timing too (the replay fixtures carry recorded commit
    times, so the replay alone cannot show that; the max the SDK is given is
    pinned in `TestPerPhaseMinimumThroughTheSession`). `gate_replay` strips the
    env override and runs on the code default (0.8); every replay case is re-run
    with that default patched to 2.0 (the gate itself still runs at the 1.0
    cap, so this shows the replays are unchanged when the screening max is 2.0).
    """

    #: Cases allowed to differ at 2.0 (none: the gate runs at its 1.0 cap, so a
    #: patched 2.0 default replays the same settle).
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

    def test_the_settle_follows_the_env_but_never_exceeds_the_gate_ceiling(self):
        for raw, expected in (("0.5", 750), ("1.0", 1250), ("2.0", 1250), ("3.0", 1250)):
            with self.subTest(raw=raw), _Env({"PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": raw}):
                self.assertEqual(agent_mod._gate_turn_settle_ms(), expected)

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

    def test_replayed_cases_reach_the_same_decisions_at_2_0(self):
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
