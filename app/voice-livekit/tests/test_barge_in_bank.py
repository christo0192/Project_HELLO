"""The refused-barge-in bank: the word floor, and bounding how long it lives.

THE DEFECT THIS FILE DEFENDS AGAINST, stated once so the tests below read as
claims rather than as arithmetic.

`min_interruption_words` does not DISCARD an utterance that is too short to
interrupt the bot. `AudioRecognition._audio_transcript` is cleared only on the
COMMITTED branch (`audio_recognition.py:1543-1574`), so a refused fragment is
BANKED and the next fragment is appended to it (`:1076`). Both interruption
paths then read that bank — `agent_activity.py:2112-2124` (end-of-turn) and
`:1803-1812` via `current_transcript` (raw VAD energy).

At the old floor of two words, that made the guard mean "one word of
backchannel cannot cut the bot off, two can". On 2026-09-17 Deepti
backchannelled "Sure" 965 ms into Q1, one more token arrived, and the committed
turn reads "Sure Ee" — with Q1 recorded `[interrupted question]`, truncated
mid-sentence. Three more truncated bot turns followed and she hung up 54 s in.

Two independent repairs, tested independently:

  1. the floor is four, so a two-word backchannel cannot qualify at all;
  2. the bank is dropped when it goes stale, so fragments separated by a
     silence cannot be summed into a barge-in no matter how low the floor is.

Neither subsumes the other: (1) with an unbounded bank still fails on the
fourth unrelated noise; (2) with a floor of one still fails on the first.

Nothing here depends on the SDK being importable — CI does not install the
livekit packages (see the header of `test_phone_gate.py`), and sibling test
modules install a STUB `livekit` into `sys.modules`. The one test that does
touch the real package is guarded by `_real_sdk_available()` and skips. The
private attribute names are protected instead by
`test_sdk_pin_is_the_version_these_names_were_read_from`, which reads
`requirements.txt` and therefore DOES run in CI.
"""

from __future__ import annotations

import os
import pathlib
import re
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import phone  # noqa: E402


#: The SDK release whose `AudioRecognition` internals `phone.py` reaches into.
#: Bumping the pin without re-reading those fields is the failure this guards.
_VERIFIED_SDK_VERSION = "1.6.4"


def _real_sdk_available() -> bool:
    """True only when the GENUINE livekit-agents package can be imported.

    `importlib.util.find_spec("livekit")` is NOT usable here, and finding that
    out cost a full-suite red: sibling test modules install a stub `livekit`
    into `sys.modules` whose `__spec__` is None, and `find_spec` raises
    `ValueError` on that rather than answering None. Evaluated at class-body
    time, that is an ImportError for this whole module — but ONLY when the
    suite runs in discovery order, never when this file runs alone.
    """
    try:
        from livekit.agents.voice.audio_recognition import AudioRecognition
    except Exception:
        return False
    return hasattr(AudioRecognition, "clear_user_turn")


class _FakeRecognition:
    """The four fields of `AudioRecognition` the repair touches, and nothing else.

    Deliberately not a mock: the repair's contract is that it writes exactly
    these four and reads exactly one more, and a mock with auto-attributes
    would satisfy `hasattr` for fields that do not exist.
    """

    def __init__(self, *, transcript: str, stamp: object, confidences: list | None = None):
        self._audio_transcript = transcript
        self._audio_interim_transcript = "interim"
        self._audio_preflight_transcript = "preflight"
        self._last_final_transcript_time = stamp
        self._final_transcript_confidence = (
            [0.9, 0.8] if confidences is None else confidences
        )


class _FakeActivity:
    def __init__(self, recognition: object | None):
        self._audio_recognition = recognition


class _FakeSession:
    def __init__(self, recognition: object | None, *, with_activity: bool = True):
        self._activity = _FakeActivity(recognition) if with_activity else None


def _session(transcript: str, stamp: object, confidences: list | None = None) -> _FakeSession:
    return _FakeSession(_FakeRecognition(
        transcript=transcript, stamp=stamp, confidences=confidences))


class WordFloorTests(unittest.TestCase):
    """The floor is the first repair: a backchannel must not reach it."""

    def test_default_is_four(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_MIN_INTERRUPTION_WORDS", None)
            self.assertEqual(phone.phone_min_interruption_words(), 4)

    def test_every_utterance_that_truncated_a_live_bot_turn_is_below_the_floor(self):
        """The four candidate utterances that preceded an `[interrupted question]`.

        Verbatim from `screening_v2.transcript_turns`: Deepti session
        f84e2e51 turn 5, and Neelu session 7562d48f turns 10, 14, 20 and 31,
        all on 2026-09-17. Each is what the bank held when the bot was cut off.

        The assertion is `< 4`, i.e. the NEW floor refuses them. Under the old
        floor of 2, every one of these qualified.
        """
        floor = phone.phone_min_interruption_words()
        for text in ("Sure Ee", "Yes Okay", "Yeah", "Yeah.", "Got Sure"):
            with self.subTest(text=text):
                self.assertLess(
                    len(text.split()), floor,
                    f"{text!r} still reaches the floor of {floor}")

    def test_a_genuine_interruption_from_the_same_calls_still_qualifies(self):
        """The counterweight: raising the floor must not deafen the bot.

        Neelu, session 7562d48f turn 25 — a real mid-question interruption,
        and the SHORTEST genuine one in either transcript. It must stay above
        the floor, or the fix has traded one failure for its opposite.
        """
        text = "I want to understand about the leads everything because"
        self.assertGreaterEqual(
            len(text.split()), phone.phone_min_interruption_words())

    def test_zero_is_honoured_as_the_rollback_lever(self):
        with patch.dict(
            os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "0"}, clear=False,
        ):
            self.assertEqual(phone.phone_min_interruption_words(), 0)

    def test_a_decimal_truncates_rather_than_rounding(self):
        """`int(float(raw))`. "3.9" is 3, not 4 — i.e. LOWER than asked for."""
        with patch.dict(
            os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "3.9"}, clear=False,
        ):
            self.assertEqual(phone.phone_min_interruption_words(), 3)

    def test_unparseable_values_fall_back_to_the_default(self):
        for raw in ("", "banana", "4 words"):
            with self.subTest(raw=raw):
                with patch.dict(
                    os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": raw}, clear=False,
                ):
                    self.assertEqual(phone.phone_min_interruption_words(), 4)

    def test_out_of_range_values_CLAMP_they_do_not_fall_back(self):
        """`_bounded_int_env` clamps. Pinned because it is a sharp edge.

        An operator who types 99 gets 8, which is safe. An operator who types
        a NEGATIVE gets 0 — and 0 is not "a bit less strict", it is the SDK
        default, i.e. barge-in on raw VAD energy with no word gate at all
        (the 2026-09-10 Praveetha failure: 8/8 bot turns truncated with the
        candidate silent). Anyone changing the bounds must know that the floor
        of the range IS the kill switch.
        """
        for raw, expected in (("99", 8), ("9", 8), ("-1", 0), ("-99", 0)):
            with self.subTest(raw=raw):
                with patch.dict(
                    os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": raw}, clear=False,
                ):
                    self.assertEqual(phone.phone_min_interruption_words(), expected)

    def test_the_new_upper_bound_is_reachable(self):
        """8, not 5. An operator must be able to tune past the old ceiling."""
        with patch.dict(
            os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "8"}, clear=False,
        ):
            self.assertEqual(phone.phone_min_interruption_words(), 8)


class BankMaxAgeTests(unittest.TestCase):
    def test_default_is_three_seconds(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_BARGE_IN_BANK_MAX_AGE_SEC", None)
            self.assertEqual(phone.phone_barge_in_bank_max_age_sec(), 3.0)

    def test_zero_disables_and_is_reachable(self):
        with patch.dict(
            os.environ, {"PHONE_BARGE_IN_BANK_MAX_AGE_SEC": "0"}, clear=False,
        ):
            self.assertEqual(phone.phone_barge_in_bank_max_age_sec(), 0.0)


class DropStaleBargeInBankTests(unittest.TestCase):
    def test_a_stale_bank_is_dropped_and_reported(self):
        session = _session("Sure", stamp=100.0)
        dropped = phone.drop_stale_barge_in_bank(
            session, now=104.0, max_age_sec=3.0)
        self.assertEqual(dropped, "Sure")
        recognition = session._activity._audio_recognition
        self.assertEqual(recognition._audio_transcript, "")
        self.assertEqual(recognition._audio_interim_transcript, "")
        self.assertEqual(recognition._audio_preflight_transcript, "")

    def test_the_stale_turns_confidences_go_with_its_text(self):
        """Leaving them would skew the NEXT turn's confidence average."""
        session = _session("Sure", stamp=100.0, confidences=[0.4, 0.5])
        phone.drop_stale_barge_in_bank(session, now=104.0, max_age_sec=3.0)
        self.assertEqual(
            session._activity._audio_recognition._final_transcript_confidence, [])

    def test_a_fresh_bank_is_left_alone(self):
        """The candidate is still mid-utterance. Dropping it would eat a real answer."""
        session = _session("Sure", stamp=100.0)
        dropped = phone.drop_stale_barge_in_bank(
            session, now=102.0, max_age_sec=3.0)
        self.assertEqual(dropped, "")
        self.assertEqual(
            session._activity._audio_recognition._audio_transcript, "Sure")

    def test_the_boundary_is_inclusive_at_exactly_max_age(self):
        session = _session("Sure", stamp=100.0)
        self.assertEqual(
            phone.drop_stale_barge_in_bank(session, now=103.0, max_age_sec=3.0),
            "Sure")

    def test_an_empty_bank_is_not_a_drop(self):
        for banked in ("", "   "):
            with self.subTest(banked=banked):
                session = _session(banked, stamp=100.0)
                self.assertEqual(
                    phone.drop_stale_barge_in_bank(
                        session, now=999.0, max_age_sec=3.0),
                    "")

    def test_zero_max_age_disables_the_repair_entirely(self):
        session = _session("Sure", stamp=100.0)
        self.assertEqual(
            phone.drop_stale_barge_in_bank(session, now=999.0, max_age_sec=0.0),
            "")
        self.assertEqual(
            session._activity._audio_recognition._audio_transcript, "Sure")

    def test_an_unstamped_bank_has_no_age_and_is_not_dropped(self):
        """No stamp means no proof of staleness. A repair must not guess."""
        for stamp in (None, "not-a-number", True):
            with self.subTest(stamp=stamp):
                session = _session("Sure", stamp=stamp)
                self.assertEqual(
                    phone.drop_stale_barge_in_bank(
                        session, now=999.0, max_age_sec=3.0),
                    "")
                self.assertEqual(
                    session._activity._audio_recognition._audio_transcript, "Sure")

    def test_a_bool_stamp_is_refused_even_though_bools_are_ints(self):
        """`isinstance(True, int)` is True. Explicit, because it is a real trap."""
        session = _session("Sure", stamp=True)
        self.assertEqual(
            phone.drop_stale_barge_in_bank(session, now=999.0, max_age_sec=3.0), "")


class SdkShapeTests(unittest.TestCase):
    """A repair that cannot verify what it writes must not write."""

    def test_no_activity_is_a_no_op(self):
        session = _FakeSession(None, with_activity=False)
        self.assertIsNone(phone.barge_in_bank_recognition(session))
        self.assertEqual(
            phone.drop_stale_barge_in_bank(session, now=999.0, max_age_sec=3.0), "")

    def test_no_recognition_is_a_no_op(self):
        session = _FakeSession(None)
        self.assertIsNone(phone.barge_in_bank_recognition(session))
        self.assertEqual(
            phone.drop_stale_barge_in_bank(session, now=999.0, max_age_sec=3.0), "")

    def test_every_required_field_is_individually_load_bearing(self):
        """Remove any ONE field and the repair must decline.

        This is the mutation control for the shape check: a guard that only
        looked at the first field would pass a partial rename and then write
        into an SDK it does not understand.
        """
        required = (
            *phone._BARGE_IN_BANK_TEXT_FIELDS,
            phone._BARGE_IN_BANK_STAMP_FIELD,
            phone._BARGE_IN_BANK_CONFIDENCE_FIELD,
        )
        self.assertEqual(len(required), 5, "the shape check must cover 5 fields")
        for missing in required:
            with self.subTest(missing=missing):
                recognition = _FakeRecognition(transcript="Sure", stamp=100.0)
                delattr(recognition, missing)
                session = _FakeSession(recognition)
                self.assertIsNone(phone.barge_in_bank_recognition(session))
                self.assertEqual(
                    phone.drop_stale_barge_in_bank(
                        session, now=999.0, max_age_sec=3.0),
                    "",
                    f"dropped the bank with {missing} absent")

    def test_sdk_pin_is_the_version_these_names_were_read_from(self):
        """THE GUARD THAT ACTUALLY FIRES IN CI.

        The livekit packages are not installed in CI, so nothing here can
        assert against the real `AudioRecognition`. What CI can read is the
        pin. `phone.py` reaches into private state that was verified by
        reading livekit-agents 1.6.4 source; if the pin moves, those five
        names must be re-read before this repair is trusted again.

        Going red on an SDK bump is the POINT, not an inconvenience. Update
        `_VERIFIED_SDK_VERSION` only after re-reading
        `voice/audio_recognition.py` in the new release.
        """
        requirements = (
            pathlib.Path(__file__).resolve().parent.parent / "requirements.txt"
        ).read_text(encoding="utf-8")
        match = re.search(r"^livekit-agents==([0-9][^\s#]*)", requirements, re.M)
        self.assertIsNotNone(match, "livekit-agents is not pinned in requirements.txt")
        self.assertEqual(
            match.group(1), _VERIFIED_SDK_VERSION,
            "livekit-agents pin moved: re-read AudioRecognition's private "
            "fields (see phone._BARGE_IN_BANK_TEXT_FIELDS) before bumping "
            "_VERIFIED_SDK_VERSION in this test",
        )

    @unittest.skipUnless(
        _real_sdk_available(),
        "real livekit-agents not importable (expected in CI)",
    )
    def test_the_real_sdk_still_has_these_fields(self):
        """Belt and braces where the SDK IS installed (image, dev machine).

        Skipped in CI by design — the version pin above is the CI-effective
        guard, and this one exists so a local run against the real package
        catches a rename the pin would not (a yanked-and-republished release).
        """
        from livekit.agents.voice.audio_recognition import AudioRecognition

        source = AudioRecognition.__init__.__qualname__  # sanity: real class
        self.assertTrue(source)
        for field in (
            *phone._BARGE_IN_BANK_TEXT_FIELDS,
            phone._BARGE_IN_BANK_STAMP_FIELD,
            phone._BARGE_IN_BANK_CONFIDENCE_FIELD,
        ):
            with self.subTest(field=field):
                self.assertIn(
                    field,
                    AudioRecognition.__init__.__code__.co_names
                    + AudioRecognition.clear_user_turn.__code__.co_names,
                    f"{field} no longer set by AudioRecognition",
                )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
