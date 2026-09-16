"""Owner report 2026-09-16 — background speech was transcribed as the candidate.

`_build_phone_vad` constructed `inference.VAD(model="silero")` with EVERY
parameter defaulted, so the phone lane ran Silero's close-mic tuning
(activation 0.5, min speech 0.05s) down a telephone line: a second person
talking in the room cleared the bar and their words landed in the transcript.

The load-bearing assertion here is NOT that the readers return nice numbers —
it is that the numbers actually REACH the factory. A tuning constant that is
computed and then not passed is the "guard that cannot fire" shape this repo
has shipped before, and it would look identical from the outside: the readers
would be green, the docstrings would describe a fix, and the live call would
behave exactly as it did before.
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

# Installs the shared SDK stubs (livekit plugins, dotenv) exactly as every other
# agent-importing test file does. Imported for the side effect only.
from tests.test_phone_gate import _ensure_stub_sdk  # noqa: E402

import phone

_ensure_stub_sdk()


class PhoneVadReaderTests(unittest.TestCase):
    """The two knobs, their defaults, and their bounds."""

    def test_the_defaults_moved_off_the_silero_close_mic_values(self) -> None:
        # The whole point of the change: if either of these equals the SDK
        # default, the phone lane is still tuned for a headset.
        with patch.dict("os.environ", {}, clear=False):
            for name in ("PHONE_VAD_ACTIVATION_THRESHOLD", "PHONE_VAD_MIN_SPEECH_SEC"):
                if name in __import__("os").environ:
                    del __import__("os").environ[name]
            self.assertGreater(
                phone.phone_vad_activation_threshold(),
                phone._SILERO_DEFAULT_ACTIVATION,
            )
            self.assertGreater(
                phone.phone_vad_min_speech_sec(),
                phone._SILERO_DEFAULT_MIN_SPEECH_SEC,
            )

    def test_the_activation_threshold_is_clamped_to_a_usable_range(self) -> None:
        # 0 makes every frame speech; 1.0 makes none. Both are ways to take a
        # phone call that never works.
        cases = {"0": 0.1, "-5": 0.1, "1.0": 0.95, "99": 0.95, "0.7": 0.7}
        for raw, want in cases.items():
            with patch.dict("os.environ", {"PHONE_VAD_ACTIVATION_THRESHOLD": raw}):
                self.assertAlmostEqual(phone.phone_vad_activation_threshold(), want)

    def test_the_min_speech_bound_refuses_to_swallow_one_word_answers(self) -> None:
        # Above ~0.4s a real "Yes." starts being discarded, so the ceiling is
        # low on purpose.
        with patch.dict("os.environ", {"PHONE_VAD_MIN_SPEECH_SEC": "9"}):
            self.assertAlmostEqual(phone.phone_vad_min_speech_sec(), 1.0)
        with patch.dict("os.environ", {"PHONE_VAD_MIN_SPEECH_SEC": "-1"}):
            self.assertAlmostEqual(phone.phone_vad_min_speech_sec(), 0.0)

    def test_a_malformed_value_falls_back_instead_of_killing_the_call(self) -> None:
        for raw in ("", "loud", "NaN"):
            with patch.dict("os.environ", {"PHONE_VAD_ACTIVATION_THRESHOLD": raw}):
                self.assertAlmostEqual(phone.phone_vad_activation_threshold(), 0.6)


class PhoneVadWiringTests(unittest.TestCase):
    """THE ASSERTION THAT MATTERS: the tuning reaches the SDK."""

    def _capture(self, env: dict[str, str]) -> dict[str, object]:
        """Build the VAD against a fake `inference` module and return kwargs."""
        seen: dict[str, object] = {}

        class _FakeVadModel:
            def stream(self) -> None:  # replaced by the observer wrapper
                return None

        def fake_vad(**kwargs: object) -> _FakeVadModel:
            seen.update(kwargs)
            return _FakeVadModel()

        fake_inference = types.ModuleType("livekit.agents.inference")
        fake_inference.VAD = fake_vad  # type: ignore[attr-defined]
        fake_agents = types.ModuleType("livekit.agents")
        fake_agents.inference = fake_inference  # type: ignore[attr-defined]

        import agent as agent_mod

        with patch.dict(sys.modules, {
            "livekit.agents": fake_agents,
            "livekit.agents.inference": fake_inference,
        }), patch.dict("os.environ", env):
            agent_mod._build_phone_vad()
        return seen

    def test_the_threshold_and_min_speech_are_PASSED_not_merely_computed(self) -> None:
        seen = self._capture({})
        self.assertEqual(seen.get("model"), "silero")
        # Reverting either argument leaves the docstrings and the readers green
        # while the live call is unchanged — so both are asserted by NAME.
        self.assertIn("activation_threshold", seen)
        self.assertIn("min_speech_duration", seen)
        self.assertAlmostEqual(float(seen["activation_threshold"]), 0.6)  # type: ignore[arg-type]
        self.assertAlmostEqual(float(seen["min_speech_duration"]), 0.20)  # type: ignore[arg-type]

    def test_an_operator_override_reaches_the_factory_too(self) -> None:
        seen = self._capture({
            "PHONE_VAD_ACTIVATION_THRESHOLD": "0.75",
            "PHONE_VAD_MIN_SPEECH_SEC": "0.30",
        })
        self.assertAlmostEqual(float(seen["activation_threshold"]), 0.75)  # type: ignore[arg-type]
        self.assertAlmostEqual(float(seen["min_speech_duration"]), 0.30)  # type: ignore[arg-type]

    def test_an_out_of_range_override_is_clamped_BEFORE_the_sdk_sees_it(self) -> None:
        # The SDK raises on some invalid values and silently accepts others; a
        # rejected VAD construction is a call that never answers, so the clamp
        # has to happen on our side of the boundary.
        seen = self._capture({"PHONE_VAD_ACTIVATION_THRESHOLD": "5"})
        self.assertAlmostEqual(float(seen["activation_threshold"]), 0.95)  # type: ignore[arg-type]

    def test_the_padding_and_silence_anchors_are_LEFT_ALONE(self) -> None:
        # `prefix_padding_duration` back-dates the segment, which is what makes
        # a longer activation requirement safe for the first word; and
        # `min_silence_duration` is the end-of-speech anchor the endpointing
        # stack is already tuned against. Passing either here would silently
        # retune turn-taking under the banner of a noise fix.
        seen = self._capture({})
        self.assertNotIn("prefix_padding_duration", seen)
        self.assertNotIn("min_silence_duration", seen)

    def test_barge_in_configuration_is_untouched(self) -> None:
        # The deferred barge-in work owns `min_interruption_words`. A noise fix
        # that also changed it could reintroduce the false-barge-in config that
        # truncated 8/8 bot turns on 2026-09-10.
        seen = self._capture({})
        self.assertNotIn("min_interruption_words", seen)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
