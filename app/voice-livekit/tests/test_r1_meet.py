"""M034 S08: R1 over Google Meet, worker side (``r1_meet.py``), default OFF.

Pure tests first (no livekit): the explicit default-off flag, the channel resolver (browser,
Meet or a closed refusal reason, never an exception), the audio-only recording cap, the
objective profiles, and the env-contract and fence pins.  Then the session tests: the runner's
plumbing and identity binding (T3), and the Meet conversation (T4): the Meet lines and the
disclosure, no button or link wording, no "I'm ready" relay, and the mute and no-audio ladder.

Synthetic ids only: the distinctive session ``3f2a9c1e-5b7d-4e2a-9c1e-0123456789ab`` catches a
slice taken from the wrong end or of the wrong length.
"""
from __future__ import annotations

import ast
import copy
import dataclasses
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

HERE = Path(__file__).resolve().parents[1]  # app/voice-livekit
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
ROOT = HERE.parents[1]  # the repository root

import r1_meet
import r1_recorder
from r1_meet import (
    MEET_INVALID_REASONS,
    MEET_PROFILES,
    METADATA_MAX_CHARS,
    RECORDING_MODE_RANK,
    ChannelDecision,
    MeetChannel,
    MeetProfile,
    cap_recording_context,
    dispatch_metadata_of,
    expected_candidate_identity,
    meet_voice_enabled,
    parse_metadata_object,
    resolve_channel,
    room_metadata_of,
)

MEET_SESSION_ID = "3f2a9c1e-5b7d-4e2a-9c1e-0123456789ab"
MEET_ROOM = f"screening-{MEET_SESSION_ID}"
MEET_IDENTITY = "meet-3f2a9c1e"
FLAG = "R1_MEET_VOICE_ENABLED"
MEET_MODULE = HERE / "r1_meet.py"
# Built from parts so this file never carries the vendor tokens it bans from the worker.
VENDOR_TOKENS = ("recall" + ".ai", "leave" + "_call", "output" + "_media")


def dispatch(**overrides: Any) -> dict[str, Any]:
    """A valid Meet dispatch payload (contract section 5) with fields replaced or removed."""
    payload: dict[str, Any] = {
        "session_id": MEET_SESSION_ID,
        "channel": "meet",
        "candidate_identity": MEET_IDENTITY,
        "profile": "r1_dex_sales",
    }
    for key, value in overrides.items():
        if value is _ABSENT:
            payload.pop(key, None)
        else:
            payload[key] = value
    return payload


def mirror(**overrides: Any) -> dict[str, Any]:
    """The room metadata the API writes for a Meet round, mirroring channel and identity."""
    payload: dict[str, Any] = {
        "session_id": MEET_SESSION_ID,
        "room_name": MEET_ROOM,
        "correlation_id": "corr-synthetic",
        "lane": "r1",
        "channel": "meet",
        "candidate_identity": MEET_IDENTITY,
    }
    for key, value in overrides.items():
        if value is _ABSENT:
            payload.pop(key, None)
        else:
            payload[key] = value
    return payload


def browser_room() -> str:
    """The room metadata the API writes for a browser R1 round: no ``channel``, no identity."""
    return json.dumps(mirror(channel=_ABSENT, candidate_identity=_ABSENT))


_ABSENT = object()
_UNSET = object()


def make_ctx(
    dispatch_raw: Any = _UNSET,
    room_raw: Any = _UNSET,
    job_room_raw: Any = None,
    *,
    with_job: bool = True,
) -> SimpleNamespace:
    """A job context shaped like the SDK's: ``room.metadata`` and ``job.{metadata, room}``."""
    if dispatch_raw is _UNSET:
        dispatch_raw = json.dumps(dispatch())
    if room_raw is _UNSET:
        room_raw = json.dumps(mirror())
    ctx = SimpleNamespace(room=SimpleNamespace(name=MEET_ROOM, metadata=room_raw))
    if with_job:
        ctx.job = SimpleNamespace(metadata=dispatch_raw, room=SimpleNamespace(metadata=job_room_raw))
    return ctx


class Exploding:
    """A context any attribute read of which fails the test (and is not an AttributeError)."""

    def __getattribute__(self, name: str) -> Any:
        raise AssertionError(f"read {name}")


class RaisingJob:
    """A context whose ``job`` read raises a non-AttributeError error."""

    @property
    def job(self) -> Any:
        raise RuntimeError("job unavailable")


class MeetDispatchButRoomRaises:
    """A Meet dispatch whose room cannot be read: the failure comes after Meet is known."""

    def __init__(self) -> None:
        self.job = SimpleNamespace(metadata=json.dumps(dispatch()), room=None)

    @property
    def room(self) -> Any:
        raise RuntimeError("room unavailable")


def env_without_flag() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if key != FLAG}


class TestMeetFlag(unittest.TestCase):
    """``R1_MEET_VOICE_ENABLED`` is OFF unless it is exactly one of the four on-values."""

    def test_unset_is_off(self) -> None:
        with mock.patch.dict(os.environ, env_without_flag(), clear=True):
            self.assertFalse(meet_voice_enabled())

    def test_every_other_value_is_off(self) -> None:
        for value in ("", "   ", "0", "off", "false", "no", "2", "enabled", "y", "OFF", "nope"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {FLAG: value}):
                self.assertFalse(meet_voice_enabled())

    def test_the_on_values_are_on(self) -> None:
        for value in ("1", "true", "on", "yes", " TRUE ", "On", "YES"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {FLAG: value}):
                self.assertTrue(meet_voice_enabled())

    def test_the_reader_is_the_literal_explicit_default_off_getenv(self) -> None:
        source = MEET_MODULE.read_text(encoding="utf-8")
        # scripts/check-env-contract.mjs finds runtime variables by this literal call.
        self.assertIn('os.getenv("R1_MEET_VOICE_ENABLED")', source)
        self.assertEqual(r1_meet.R1_MEET_VOICE_FLAG, FLAG)
        names = {
            node.id if isinstance(node, ast.Name) else node.attr
            for node in ast.walk(ast.parse(source))
            if isinstance(node, (ast.Name, ast.Attribute))
        }
        # Both voice helpers default ON (critic C9): the Meet flag must never go through them.
        self.assertNotIn("_env_switch", names)
        self.assertNotIn("flag_on", names)
        self.assertNotIn("_env_switch", source)
        self.assertNotIn("flag_on", source)


class TestResolveChannel(unittest.TestCase):
    """R2 (which signal selects Meet) and R3 (Meet validation, fail closed, in order)."""

    def assertBrowser(self, decision: ChannelDecision) -> None:
        self.assertEqual(decision, ChannelDecision())
        self.assertIsNone(decision.meet)
        self.assertIsNone(decision.invalid_reason)

    def assertMeet(self, decision: ChannelDecision) -> None:
        self.assertEqual(
            decision, ChannelDecision(meet=MeetChannel(MEET_IDENTITY, MEET_PROFILES["r1_dex_sales"]))
        )

    def assertReason(self, decision: ChannelDecision, reason: str) -> None:
        self.assertIsNone(decision.meet)
        self.assertEqual(decision.invalid_reason, reason)
        self.assertIn(reason, MEET_INVALID_REASONS)

    def test_disabled_reads_nothing_from_the_context(self) -> None:
        self.assertBrowser(resolve_channel(Exploding(), MEET_SESSION_ID, enabled=False))
        # Even a fully valid Meet dispatch is the browser channel with the flag off.
        self.assertBrowser(resolve_channel(make_ctx(), MEET_SESSION_ID, enabled=False))

    def test_a_valid_meet_dispatch_resolves_to_the_exact_identity_and_profile(self) -> None:
        decision = resolve_channel(make_ctx(), MEET_SESSION_ID, enabled=True)
        self.assertMeet(decision)
        self.assertEqual(decision.meet.candidate_identity, "meet-3f2a9c1e")
        self.assertIs(decision.meet.profile, MEET_PROFILES["r1_dex_sales"])

    def test_utf8_bytes_metadata_is_read_like_a_string(self) -> None:
        ctx = make_ctx(json.dumps(dispatch()).encode("utf-8"), json.dumps(mirror()).encode("utf-8"))
        self.assertMeet(resolve_channel(ctx, MEET_SESSION_ID, enabled=True))

    def test_an_upper_case_room_session_id_still_derives_the_lower_case_identity(self) -> None:
        self.assertMeet(resolve_channel(make_ctx(), MEET_SESSION_ID.upper(), enabled=True))
        ctx = make_ctx(json.dumps(dispatch(session_id=MEET_SESSION_ID.upper())))
        self.assertMeet(resolve_channel(ctx, MEET_SESSION_ID, enabled=True))

    @staticmethod
    def not_meet_dispatches() -> dict[str, Any]:
        """Every dispatch metadata that is not exactly a ``channel`` ``"meet"`` object."""
        oversize = json.dumps({**dispatch(), "pad": "x" * METADATA_MAX_CHARS})
        assert len(oversize) > METADATA_MAX_CHARS
        return {
            "metadata None": None,
            "metadata empty": "",
            "not utf-8 bytes": b"\xff\xfe{\"channel\": \"meet\"}",
            "not json": "channel=meet",
            "json array": json.dumps([dispatch()]),
            "json null": "null",
            "json string": json.dumps("meet"),
            "json number": "7",
            "oversize": oversize,
            "oversize bytes": oversize.encode("utf-8"),
            "channel missing": json.dumps(dispatch(channel=_ABSENT)),
            "channel browser": json.dumps({"session_id": MEET_SESSION_ID, "channel": "browser"}),
            "channel MEET": json.dumps(dispatch(channel="MEET")),
            "channel leading space": json.dumps(dispatch(channel=" meet")),
            "channel trailing space": json.dumps(dispatch(channel="meet ")),
            "channel Meet": json.dumps(dispatch(channel="Meet")),
            "channel null": json.dumps(dispatch(channel=None)),
            "channel number": json.dumps(dispatch(channel=1)),
            "channel list": json.dumps(dispatch(channel=["meet"])),
            "channel object": json.dumps(dispatch(channel={"name": "meet"})),
            "not a string or bytes": 12345,
        }

    def test_everything_that_is_not_exactly_channel_meet_is_the_browser_channel(self) -> None:
        # In a room that is not a Meet mirror: today's browser room, one naming another channel,
        # or one with no metadata at all.
        rooms = {
            "browser room": (browser_room(), None),
            "room channel browser": (json.dumps(mirror(channel="browser")), None),
            "room channel phone": (json.dumps({"channel": "phone"}), None),
            "room channel MEET": (json.dumps(mirror(channel="MEET")), None),
            "no room metadata": (None, None),
            "room metadata not json": ("lane=r1", None),
        }
        for room_label, (room_raw, job_room_raw) in rooms.items():
            for label, raw in self.not_meet_dispatches().items():
                with self.subTest(room=room_label, dispatch=label):
                    ctx = make_ctx(raw, room_raw, job_room_raw)
                    self.assertBrowser(resolve_channel(ctx, MEET_SESSION_ID, enabled=True))

    def test_a_meet_room_mirror_without_a_meet_dispatch_fails_closed(self) -> None:
        # Review S08-3: the room says Meet and the dispatch does not (none at all, an unnamed
        # worker's empty job metadata, a stale or reused "browser" dispatch).  The binding facts
        # disagree, so the round is refused, never run as a browser round on the first standard
        # participant with the browser lines.
        rooms = {
            "room metadata says meet": (json.dumps(mirror()), None),
            "only the job's room copy says meet": (None, json.dumps(mirror())),
            "a meet mirror naming another identity": (
                json.dumps(mirror(candidate_identity="meet-deadbeef")), None
            ),
            "a meet mirror with no identity": (json.dumps(mirror(candidate_identity=_ABSENT)), None),
        }
        for room_label, (room_raw, job_room_raw) in rooms.items():
            for label, raw in self.not_meet_dispatches().items():
                with self.subTest(room=room_label, dispatch=label):
                    ctx = make_ctx(raw, room_raw, job_room_raw)
                    decision = resolve_channel(ctx, MEET_SESSION_ID, enabled=True)
                    self.assertReason(decision, "room_mirror_mismatch")
            with self.subTest(room=room_label, dispatch="no job at all"):
                ctx = make_ctx(room_raw=room_raw or json.dumps(mirror()), with_job=False)
                self.assertReason(
                    resolve_channel(ctx, MEET_SESSION_ID, enabled=True), "room_mirror_mismatch"
                )
        # The flag off still reads nothing and is today's browser round.
        self.assertBrowser(
            resolve_channel(make_ctx(json.dumps({"channel": "browser"})), MEET_SESSION_ID,
                            enabled=False)
        )

    def test_a_context_without_a_job_or_dispatch_metadata_is_the_browser_channel(self) -> None:
        self.assertBrowser(
            resolve_channel(make_ctx(room_raw=browser_room(), with_job=False), MEET_SESSION_ID,
                            enabled=True)
        )
        no_metadata = SimpleNamespace(room=SimpleNamespace(name=MEET_ROOM), job=SimpleNamespace())
        self.assertBrowser(resolve_channel(no_metadata, MEET_SESSION_ID, enabled=True))
        for ctx in (None, 5, "ctx", object()):
            with self.subTest(ctx=repr(ctx)):
                self.assertBrowser(resolve_channel(ctx, MEET_SESSION_ID, enabled=True))

    def test_a_failure_before_meet_is_known_is_the_browser_channel(self) -> None:
        self.assertBrowser(resolve_channel(RaisingJob(), MEET_SESSION_ID, enabled=True))
        self.assertBrowser(resolve_channel(Exploding(), MEET_SESSION_ID, enabled=True))

    def test_a_failure_after_meet_is_known_is_unreadable(self) -> None:
        decision = resolve_channel(MeetDispatchButRoomRaises(), MEET_SESSION_ID, enabled=True)
        self.assertReason(decision, "unreadable")

    def test_session_mismatch(self) -> None:
        rows = {
            "dispatch session id missing": (dispatch(session_id=_ABSENT), MEET_SESSION_ID),
            "dispatch session id different": (
                dispatch(session_id="00000000-5b7d-4e2a-9c1e-0123456789ab"), MEET_SESSION_ID
            ),
            "dispatch session id a prefix": (dispatch(session_id="3f2a9c1e"), MEET_SESSION_ID),
            "dispatch session id non-string": (dispatch(session_id=123), MEET_SESSION_ID),
            "dispatch session id null": (dispatch(session_id=None), MEET_SESSION_ID),
            "room gives no session id": (dispatch(), None),
            "room session id empty": (dispatch(), ""),
        }
        for label, (payload, session_id) in rows.items():
            with self.subTest(label):
                decision = resolve_channel(make_ctx(json.dumps(payload)), session_id, enabled=True)
                self.assertReason(decision, "session_mismatch")

    def test_identity_invalid(self) -> None:
        rows = {
            "upper-case hex": "meet-3F2A9C1E",
            "seven hex": "meet-3f2a9c1",
            "nine hex": "meet-3f2a9c1e5",
            "wrong prefix": "candidate-3f2a9c1e",
            "another session's prefix": "meet-deadbeef",
            "the last eight hex": "meet-456789ab",
            "trailing newline": "meet-3f2a9c1e\n",
            "leading space": " meet-3f2a9c1e",
            "empty": "",
            "non-string": 12345678,
            "null": None,
            "missing": _ABSENT,
        }
        for label, identity in rows.items():
            with self.subTest(label):
                ctx = make_ctx(
                    json.dumps(dispatch(candidate_identity=identity)),
                    json.dumps(mirror(candidate_identity=identity)),
                )
                self.assertReason(resolve_channel(ctx, MEET_SESSION_ID, enabled=True), "identity_invalid")

    def test_a_room_session_id_that_is_not_uuid_shaped_never_yields_an_identity(self) -> None:
        payload = dispatch(session_id="3f2a9c1e-not-a-uuid")
        decision = resolve_channel(make_ctx(json.dumps(payload)), "3f2a9c1e-not-a-uuid", enabled=True)
        self.assertReason(decision, "identity_invalid")

    def test_profile_unknown(self) -> None:
        for label, profile in {
            "missing": _ABSENT,
            "unknown": "r1_someone_else",
            "upper case": "R1_DEX_SALES",
            "null": None,
            "list": ["r1_dex_sales"],
            "object": {"id": "r1_dex_sales"},
        }.items():
            with self.subTest(label):
                ctx = make_ctx(json.dumps(dispatch(profile=profile)))
                self.assertReason(resolve_channel(ctx, MEET_SESSION_ID, enabled=True), "profile_unknown")

    def test_room_mirror_mismatch(self) -> None:
        rows = {
            "no room metadata anywhere": (None, None),
            "empty room metadata": ("", None),
            "room metadata not json": ("lane=r1", None),
            "room metadata an array": (json.dumps([mirror()]), None),
            "channel browser": (json.dumps(mirror(channel="browser")), None),
            "channel missing": (json.dumps(mirror(channel=_ABSENT)), None),
            "identity different": (json.dumps(mirror(candidate_identity="meet-deadbeef")), None),
            "identity missing": (json.dumps(mirror(candidate_identity=_ABSENT)), None),
            "identity non-string": (json.dumps(mirror(candidate_identity=1)), None),
            # ctx.room.metadata, when set, wins over the job's copy (the agent.py order).
            "room says browser, job room says meet": (
                json.dumps(mirror(channel="browser")), json.dumps(mirror())
            ),
        }
        for label, (room_raw, job_room_raw) in rows.items():
            with self.subTest(label):
                ctx = make_ctx(json.dumps(dispatch()), room_raw, job_room_raw)
                decision = resolve_channel(ctx, MEET_SESSION_ID, enabled=True)
                self.assertReason(decision, "room_mirror_mismatch")

    def test_room_metadata_only_on_the_job_room_is_accepted(self) -> None:
        self.assertMeet(resolve_channel(make_ctx(room_raw=None, job_room_raw=json.dumps(mirror())),
                                        MEET_SESSION_ID, enabled=True))
        self.assertMeet(resolve_channel(make_ctx(room_raw="", job_room_raw=json.dumps(mirror())),
                                        MEET_SESSION_ID, enabled=True))
        # The room's own metadata is read first; a stale job copy does not matter then.
        self.assertMeet(
            resolve_channel(
                make_ctx(job_room_raw=json.dumps(mirror(channel="browser"))), MEET_SESSION_ID, enabled=True
            )
        )

    def test_the_checks_run_in_the_stated_order(self) -> None:
        everything_wrong = dispatch(
            session_id="00000000-5b7d-4e2a-9c1e-0123456789ab",
            candidate_identity="meet-deadbeef",
            profile="unknown",
        )
        ctx = make_ctx(json.dumps(everything_wrong), json.dumps(mirror(channel="browser")))
        self.assertReason(resolve_channel(ctx, MEET_SESSION_ID, enabled=True), "session_mismatch")
        ctx = make_ctx(
            json.dumps(dispatch(candidate_identity="meet-deadbeef", profile="unknown")),
            json.dumps(mirror(channel="browser")),
        )
        self.assertReason(resolve_channel(ctx, MEET_SESSION_ID, enabled=True), "identity_invalid")
        ctx = make_ctx(json.dumps(dispatch(profile="unknown")), json.dumps(mirror(channel="browser")))
        self.assertReason(resolve_channel(ctx, MEET_SESSION_ID, enabled=True), "profile_unknown")

    def test_the_reasons_are_a_closed_set(self) -> None:
        self.assertEqual(
            MEET_INVALID_REASONS,
            (
                "session_mismatch",
                "identity_invalid",
                "profile_unknown",
                "room_mirror_mismatch",
                "context_identity_mismatch",
                "unreadable",
            ),
        )
        self.assertEqual(len(set(MEET_INVALID_REASONS)), len(MEET_INVALID_REASONS))
        seen = {
            resolve_channel(make_ctx(json.dumps(dispatch(session_id=_ABSENT))), MEET_SESSION_ID,
                            enabled=True).invalid_reason,
            resolve_channel(make_ctx(json.dumps(dispatch(candidate_identity="x"))), MEET_SESSION_ID,
                            enabled=True).invalid_reason,
            resolve_channel(make_ctx(json.dumps(dispatch(profile="x"))), MEET_SESSION_ID,
                            enabled=True).invalid_reason,
            resolve_channel(make_ctx(room_raw=None), MEET_SESSION_ID, enabled=True).invalid_reason,
            resolve_channel(MeetDispatchButRoomRaises(), MEET_SESSION_ID, enabled=True).invalid_reason,
        }
        self.assertLessEqual(seen, set(MEET_INVALID_REASONS))
        # context_identity_mismatch is the session's own check after the context fetch (R4).
        self.assertEqual(set(MEET_INVALID_REASONS) - seen, {"context_identity_mismatch"})

    def test_decisions_are_frozen(self) -> None:
        decision = resolve_channel(make_ctx(), MEET_SESSION_ID, enabled=True)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            decision.meet = None  # type: ignore[misc]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            decision.meet.candidate_identity = "meet-deadbeef"  # type: ignore[misc,union-attr]


class TestMetadataHelpers(unittest.TestCase):
    """The pure readers under the resolver: bounded, typed, never raising."""

    def test_expected_candidate_identity(self) -> None:
        self.assertEqual(expected_candidate_identity(MEET_SESSION_ID), MEET_IDENTITY)
        self.assertEqual(expected_candidate_identity(MEET_SESSION_ID.upper()), MEET_IDENTITY)
        for value in (None, "", "3f2a9c1e", "not-a-uuid", 12345, MEET_SESSION_ID + "\n",
                      MEET_SESSION_ID + "0", "g" * 8 + MEET_SESSION_ID[8:]):
            with self.subTest(value=repr(value)):
                self.assertIsNone(expected_candidate_identity(value))  # type: ignore[arg-type]

    def test_parse_metadata_object(self) -> None:
        self.assertEqual(parse_metadata_object('{"a": 1}'), {"a": 1})
        self.assertEqual(parse_metadata_object(b'{"a": 1}'), {"a": 1})
        self.assertEqual(parse_metadata_object(bytearray(b'{"a": 1}')), {"a": 1})
        at_bound = '{"a": "' + "x" * (METADATA_MAX_CHARS - 9) + '"}'
        self.assertEqual(len(at_bound), METADATA_MAX_CHARS)
        self.assertEqual(parse_metadata_object(at_bound)["a"], "x" * (METADATA_MAX_CHARS - 9))
        over = '{"a": "' + "x" * (METADATA_MAX_CHARS - 8) + '"}'
        self.assertEqual(parse_metadata_object(over), {})
        self.assertEqual(parse_metadata_object(over.encode("utf-8")), {})
        # Multi-byte characters are counted as characters, not bytes.
        wide = '{"a": "' + "é" * (METADATA_MAX_CHARS - 9) + '"}'
        self.assertEqual(len(parse_metadata_object(wide.encode("utf-8"))["a"]), METADATA_MAX_CHARS - 9)
        for raw in (None, "", "   ", "[1]", "null", "true", "1", '"x"', "{", b"\xff", 1, 1.5,
                    ["{}"], {"a": 1}, "[" * 4000 + "]" * 4000):
            with self.subTest(raw=repr(raw)[:40]):
                self.assertEqual(parse_metadata_object(raw), {})
        # A huge integer is refused by newer Pythons' digit limit; either way nothing raises.
        self.assertIsInstance(parse_metadata_object('{"a": ' + "1" * 5000 + "}"), dict)

    def test_parse_metadata_object_returns_a_fresh_dict(self) -> None:
        first = parse_metadata_object('{"a": 1}')
        first["a"] = 2
        self.assertEqual(parse_metadata_object('{"a": 1}'), {"a": 1})

    def test_dispatch_and_room_metadata_readers(self) -> None:
        ctx = make_ctx("D", "R", "J")
        self.assertEqual(dispatch_metadata_of(ctx), "D")
        self.assertEqual(room_metadata_of(ctx), "R")
        self.assertEqual(room_metadata_of(make_ctx("D", None, "J")), "J")
        self.assertEqual(room_metadata_of(make_ctx("D", "", "J")), "J")
        self.assertIsNone(dispatch_metadata_of(make_ctx(with_job=False)))
        self.assertIsNone(room_metadata_of(make_ctx(room_raw=None, with_job=False)))
        self.assertIsNone(dispatch_metadata_of(None))
        self.assertIsNone(room_metadata_of(SimpleNamespace()))


class TestRecordingCap(unittest.TestCase):
    """R9: a Meet round records audio only; the cap never mutates the fetched context."""

    def test_av_is_lowered_to_audio(self) -> None:
        context = {"session_id": MEET_SESSION_ID, "recording": {"mode": "av", "extra": 1}, "x": [1]}
        before = copy.deepcopy(context)
        capped = cap_recording_context(context, "audio")
        self.assertEqual(capped["recording"], {"mode": "audio", "extra": 1})
        self.assertEqual(capped["session_id"], MEET_SESSION_ID)
        self.assertEqual(capped["x"], [1])
        self.assertEqual(context, before)
        self.assertIsNot(capped, context)
        self.assertIsNot(capped["recording"], context["recording"])

    def test_modes_at_or_below_the_cap_pass_through(self) -> None:
        for mode in ("audio", "off"):
            with self.subTest(mode=mode):
                context = {"recording": {"mode": mode}, "k": "v"}
                capped = cap_recording_context(context, "audio")
                self.assertEqual(capped, context)
                self.assertIsNot(capped, context)

    def test_missing_or_malformed_recording_passes_through(self) -> None:
        for context in (
            {},
            {"k": "v"},
            {"recording": None},
            {"recording": "av"},
            {"recording": ["av"]},
            {"recording": {}},
            {"recording": {"mode": "AV"}},
            {"recording": {"mode": 2}},
            {"recording": {"mode": None}},
        ):
            with self.subTest(context=repr(context)):
                before = copy.deepcopy(context)
                self.assertEqual(cap_recording_context(context, "audio"), before)
                self.assertEqual(context, before)

    def test_an_off_cap_or_an_unknown_cap_records_nothing(self) -> None:
        for cap in ("off", "video", "", None, 3):
            for mode in ("av", "audio"):
                with self.subTest(cap=cap, mode=mode):
                    capped = cap_recording_context({"recording": {"mode": mode}}, cap)  # type: ignore[arg-type]
                    self.assertEqual(capped["recording"]["mode"], "off")

    def test_a_context_that_is_not_a_mapping_gives_an_empty_one(self) -> None:
        for context in (None, [], "av", 5):
            with self.subTest(context=repr(context)):
                self.assertEqual(cap_recording_context(context, "audio"), {})  # type: ignore[arg-type]

    def test_the_rank_is_the_recorders(self) -> None:
        self.assertEqual(dict(RECORDING_MODE_RANK), dict(r1_recorder._MODE_RANK))

    def test_the_recorder_then_records_audio_only(self) -> None:
        env = {"R1_RECORDING": "on", "R1_VIDEO_RECORDING": "on"}
        context_av = {"recording": {"mode": "av"}}
        self.assertEqual(r1_recorder.effective_mode(context_av, env=env), "av")  # not vacuous
        profile = MEET_PROFILES["r1_dex_sales"]
        capped = cap_recording_context(context_av, profile.max_recording_mode)
        self.assertEqual(r1_recorder.effective_mode(capped, env=env), "audio")
        self.assertEqual(
            r1_recorder.effective_mode(capped, env={"R1_RECORDING": "on", "R1_VIDEO_RECORDING": "off"}),
            "audio",
        )
        self.assertEqual(r1_recorder.effective_mode(capped, env={"R1_RECORDING": "off"}), "off")


class TestMeetProfiles(unittest.TestCase):
    """R12: the pluggable objective profiles; today exactly one, Dex sales."""

    def test_the_only_profile_is_dex_sales(self) -> None:
        self.assertEqual(set(MEET_PROFILES), {"r1_dex_sales"})
        self.assertEqual(
            MEET_PROFILES["r1_dex_sales"],
            MeetProfile(id="r1_dex_sales", max_recording_mode="audio", ready_button=False,
                        track_mute_aside=False),
        )

    def test_every_profile_is_audio_only_buttonless_and_ignores_track_mutes(self) -> None:
        for key, profile in MEET_PROFILES.items():
            with self.subTest(profile=key):
                self.assertEqual(profile.id, key)
                self.assertIn(profile.max_recording_mode, {"off", "audio"})
                self.assertIs(profile.ready_button, False)
                self.assertIs(profile.track_mute_aside, False)

    def test_the_registry_and_profiles_are_read_only(self) -> None:
        with self.assertRaises(TypeError):
            MEET_PROFILES["other"] = MEET_PROFILES["r1_dex_sales"]  # type: ignore[index]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            MEET_PROFILES["r1_dex_sales"].ready_button = True  # type: ignore[misc]

    def test_every_profile_id_is_one_the_api_knows(self) -> None:
        profiles_ts = ROOT / "app" / "api" / "src" / "lib" / "r1" / "meet" / "profiles.ts"
        if not profiles_ts.is_file():
            self.skipTest("the API sources are not part of this checkout")
        source = profiles_ts.read_text(encoding="utf-8")
        for key in MEET_PROFILES:
            with self.subTest(profile=key):
                self.assertIn(f"'{key}'", source)


class TestMeetEnvContractAndFences(unittest.TestCase):
    """R13-R15: the env contract, the deploy configs, no vendor calls, a pure module."""

    def schema(self) -> dict[str, Any]:
        path = ROOT / "config" / "environment.schema.json"
        if not path.is_file():
            self.skipTest("the env contract is not part of this checkout")
        return json.loads(path.read_text(encoding="utf-8"))

    def test_the_flag_is_in_the_voice_block_only(self) -> None:
        components = self.schema()["components"]
        self.assertEqual(
            components["voice-livekit"]["variables"][FLAG],
            {"requiredInProduction": False, "secret": False},
        )
        for name, component in components.items():
            if name == "voice-livekit":
                continue
            with self.subTest(component=name):
                self.assertNotIn(FLAG, component.get("variables", {}))

    def test_the_env_example_ships_it_off(self) -> None:
        lines = (HERE / ".env.example").read_text(encoding="utf-8").splitlines()
        self.assertIn(f"{FLAG}=0", lines)
        self.assertEqual(sum(1 for line in lines if line.startswith(f"{FLAG}=")), 1)

    def test_the_env_example_and_the_reader_state_the_rollback_order(self) -> None:
        # Review S08-1: off, the worker runs a Meet dispatch as a browser round (no recording
        # disclosure, the button and window lines), so the API's R1_MEET_ENABLED goes off FIRST.
        lines = (HERE / ".env.example").read_text(encoding="utf-8").splitlines()
        index = lines.index(f"{FLAG}=0")
        block: list[str] = []
        for line in reversed(lines[:index]):
            if not line.startswith("#"):
                break
            block.insert(0, line.lstrip("# "))
        comment = " ".join(block)
        self.assertIn("Set it before the API's R1_MEET_ENABLED", comment)
        self.assertIn(
            "Rollback order: turn the API's R1_MEET_ENABLED off FIRST, and only then unset this.",
            comment,
        )
        self.assertIn("no recording disclosure", comment)
        doc = " ".join((meet_voice_enabled.__doc__ or "").split())
        self.assertIn(
            "Roll back in the reverse order: the API's ``R1_MEET_ENABLED`` off FIRST", doc
        )

    def test_no_fly_config_sets_it(self) -> None:
        for name in ("fly.toml", "fly.phone.toml"):
            path = HERE / name
            if not path.is_file():
                continue
            with self.subTest(config=name):
                self.assertNotIn(FLAG, path.read_text(encoding="utf-8"))

    def test_no_worker_module_names_a_vendor_call(self) -> None:
        modules = sorted(HERE.glob("*.py"))
        self.assertIn(MEET_MODULE, modules)
        for path in modules:
            source = path.read_text(encoding="utf-8", errors="replace").lower()
            for token in VENDOR_TOKENS:
                with self.subTest(module=path.name, token=token):
                    self.assertNotIn(token, source)

    def test_the_meet_module_is_pure(self) -> None:
        tree = ast.parse(MEET_MODULE.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module or "")
            elif isinstance(node, ast.Name):
                self.assertNotEqual(node.id, "_log", node.lineno)
            elif isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, {"debug", "info", "warn", "warning", "error"}, node.lineno)
        self.assertFalse({name for name in imported if name.startswith("r1_")})
        self.assertLessEqual(
            imported,
            {"__future__", "json", "os", "re", "collections.abc", "dataclasses", "types", "typing"},
        )


# --------------------------------------------------------------------------------------------
# T3: the session plumbing (``r1_session.run_r1_session`` and ``R1Interview``).
# --------------------------------------------------------------------------------------------

import asyncio  # noqa: E402 - the session tests below need the event loop and the session fakes
import contextlib  # noqa: E402
import inspect  # noqa: E402

import r1_session  # noqa: E402
from r1_session import R1Interview, run_r1_session  # noqa: E402
from tests.test_r1_core import (  # noqa: E402
    FakeContext,
    FakeParticipant,
    FakeSession,
    FakeWriter,
    capture_r1_logs,
    error_types,
)

MEET_CHANNEL = MeetChannel(MEET_IDENTITY, MEET_PROFILES["r1_dex_sales"])
BROWSER_ROOM_OPTIONS = {"text_input": False, "close_on_disconnect": False}
MEET_ROOM_OPTIONS = {**BROWSER_ROOM_OPTIONS, "participant_identity": MEET_IDENTITY}
# Strings that must never reach a log line: the session id, the identity, metadata values.
NEVER_LOGGED = (
    MEET_SESSION_ID,
    MEET_SESSION_ID[:8],
    MEET_IDENTITY,
    "deadbeef",
    "corr-synthetic",
    "r1_unknown_profile",
    "Quokka-meta-4471",
)


def linked_identity(room_options: Any) -> str | None:
    """The identity a started session's room options link (None: the SDK's first eligible one)."""
    value = getattr(room_options, "participant_identity", None)
    return value if isinstance(value, str) else None


class RaisingMetadataRoom:
    """Mixin: the room's metadata cannot be read (the failure comes after Meet is known)."""

    @property
    def metadata(self) -> Any:
        raise RuntimeError("Quokka-meta-4471 room metadata unavailable")


class MeetRunnerRig:
    """Mixin: ``run_r1_session`` over the session fakes, with a Meet (or browser) job context.

    ``rig`` builds the context, the fetched worker context, the writer, the session and the
    patches (``fetch_context``, ``R1TurnWriter``, a spy on ``R1Interview.__init__`` and the
    recorder builder); ``patched`` applies them with the flag (and any other variable) set.
    """

    def rig(
        self,
        *,
        dispatch_raw: Any = _UNSET,
        room_raw: Any = _UNSET,
        with_job: bool = True,
        participants: tuple[str, ...] = (MEET_IDENTITY,),
        activate_ok: bool = False,
        context: dict[str, Any] | None = None,
        raising_room_metadata: bool = False,
    ) -> SimpleNamespace:
        order: list = []
        ctx = FakeContext(order)
        if raising_room_metadata:
            ctx.room.__class__ = type("RaisingRoom", (RaisingMetadataRoom, type(ctx.room)), {})
        else:
            ctx.room.metadata = json.dumps(mirror()) if room_raw is _UNSET else room_raw
        ctx.room.name = MEET_ROOM
        if with_job:
            ctx.job = SimpleNamespace(
                metadata=json.dumps(dispatch()) if dispatch_raw is _UNSET else dispatch_raw,
                room=SimpleNamespace(metadata=None),
            )
        for identity in participants:
            ctx.room.remote_participants[identity] = FakeParticipant(identity)
        fetched = (
            context
            if context is not None
            else {
                "first_name": "Asha",
                "round_id": "round",
                "attempt_id": "attempt",
                "attempt": {},
                "settings": {},
                "recording": {"mode": "av"},
            }
        )
        rig = SimpleNamespace(
            ctx=ctx,
            order=order,
            writer=FakeWriter(order, activate_ok=activate_ok),
            session=FakeSession(log=order),
            fetched=fetched,
            fetches=[],
            factories=[],
            built=[],  # (instance, args, kwargs) of every R1Interview the runner constructs
            recorder_contexts=[],
        )

        async def fetch(room):
            rig.fetches.append(room)
            return rig.fetched

        async def factory(_ctx, _context):
            rig.factories.append(_context)
            return rig.session

        original = R1Interview.__init__

        def spy(self_, *args, **kwargs):
            rig.built.append((self_, args, dict(kwargs)))
            original(self_, *args, **kwargs)

        def build_recorder(_ctx, recorder_context, *_args, **_kwargs):
            rig.recorder_contexts.append(recorder_context)
            return None

        import r1_recorder as recorder_module

        rig.fetch, rig.factory, rig.spy = fetch, factory, spy
        rig.patches = (
            mock.patch.object(r1_session, "fetch_context", fetch),
            mock.patch.object(r1_session, "R1TurnWriter", lambda *_a, **_k: rig.writer),
            mock.patch.object(R1Interview, "__init__", spy),
            mock.patch.object(recorder_module, "build_r1_recorder", build_recorder),
        )
        return rig

    @contextlib.contextmanager
    def patched(
        self, rig: SimpleNamespace, *, flag: str | None, extra_env: dict[str, str] | None = None
    ):
        env = env_without_flag()
        if flag is not None:
            env[FLAG] = flag
        env.update(extra_env or {})
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
            for patch in rig.patches:
                stack.enter_context(patch)
            yield

    async def run_session(self, rig: SimpleNamespace, *, flag: str | None) -> tuple[str, list]:
        with self.patched(rig, flag=flag), capture_r1_logs() as logs:
            outcome = await asyncio.wait_for(
                run_r1_session(rig.ctx, session_factory=rig.factory), 10.0
            )
        return outcome, logs

    def main_interview(self, rig: SimpleNamespace) -> tuple[Any, tuple, dict]:
        mains = [built for built in rig.built if built[1][2] is rig.session]
        self.assertEqual(len(mains), 1)
        return mains[0]

    async def until(self, predicate, timeout: float = 5.0) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while not predicate():
            if loop.time() > deadline:
                self.fail("condition not reached in time")
            await asyncio.sleep(0.01)


class TestMeetSessionPlumbing(MeetRunnerRig, unittest.IsolatedAsyncioTestCase):
    """The runner resolves the channel once, fails closed, binds one identity, records audio only.

    Every browser case (flag off, or any channel value but exactly "meet" in a room that is not a
    Meet mirror) is today's behaviour exactly: no ``meet`` keyword, the first standard participant,
    the browser room options, the original context to the recorder, and no ``r1_meet_*`` log line.
    A Meet room mirror without a Meet dispatch fails closed (``room_mirror_mismatch``).
    """

    def assert_settled_before_connect(self, rig: SimpleNamespace, outcome: str) -> None:
        """The shape of ``TestRunR1SessionFailurePaths.assert_settled``, with nothing started."""
        self.assertEqual(outcome, "configuration_failed")
        self.assertEqual(rig.ctx.connects, 0)
        self.assertEqual(rig.fetches, [])
        self.assertEqual(rig.factories, [])
        self.assertEqual(rig.writer.activations, 0)
        self.assertEqual(rig.writer.terminals, [("configuration_failed", {"activated": False})])
        self.assertEqual(rig.writer.outcomes, ["configuration_failed"])
        self.assertEqual(rig.ctx.deleted_rooms, [None])
        self.assertEqual(rig.ctx.shutdowns, ["r1_exit"])
        names = [item for item in rig.order if isinstance(item, str)]
        self.assertEqual(names, ["ledger", "terminal", "outcome"])

    def assert_no_meet_log(self, logs: list) -> None:
        self.assertFalse([kind for kind in error_types(logs) if kind.startswith("r1_meet")])

    def assert_nothing_identifying_logged(self, logs: list) -> None:
        blob = json.dumps(logs)
        for value in NEVER_LOGGED:
            self.assertNotIn(value, blob)

    # ------------------------------------------------------------ construction

    def test_meet_is_a_keyword_only_seam_that_defaults_to_none(self) -> None:
        parameter = inspect.signature(R1Interview.__init__).parameters["meet"]
        self.assertIs(parameter.kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIsNone(parameter.default)

    def test_the_room_options_are_exact_for_each_channel(self) -> None:
        ctx = FakeContext()
        browser = R1Interview(ctx, {}, FakeSession(), FakeWriter([]))
        self.assertIsNone(browser._meet)
        self.assertIsNone(browser._candidate_identity)
        self.assertEqual(browser._room_options_kwargs(), BROWSER_ROOM_OPTIONS)
        meet = R1Interview(ctx, {}, FakeSession(), FakeWriter([]), meet=MEET_CHANNEL)
        self.assertIs(meet._meet, MEET_CHANNEL)
        self.assertEqual(meet._candidate_identity, MEET_IDENTITY)
        self.assertEqual(meet._room_options_kwargs(), MEET_ROOM_OPTIONS)
        # A context identity still binds a browser round exactly as before.
        context_bound = R1Interview(ctx, {"candidate_identity": "candidate"}, FakeSession(), FakeWriter([]))
        self.assertEqual(context_bound._candidate_identity, "candidate")
        self.assertEqual(context_bound._room_options_kwargs(), BROWSER_ROOM_OPTIONS)

    def test_a_meet_interview_ignores_every_other_standard_participant(self) -> None:
        interview = R1Interview(FakeContext(), {}, FakeSession(), FakeWriter([]), meet=MEET_CHANNEL)
        for identity in ("intruder", "meet-deadbeef", "MEET-3F2A9C1E", "meet-3f2a9c1e "):
            interview._on_participant_connected(FakeParticipant(identity))
            self.assertEqual(interview._candidate_identity, MEET_IDENTITY)
            self.assertFalse(interview._candidate_present)
        bridge = FakeParticipant(MEET_IDENTITY)
        interview._on_participant_connected(bridge)
        self.assertTrue(interview._candidate_present)
        self.assertIs(interview._candidate_seen, bridge)
        # An unrelated departure never looks like the bridge leaving.
        interview._on_participant_disconnected(FakeParticipant("intruder"))
        self.assertTrue(interview._candidate_present)

    # ------------------------------------------------------------ identity binding

    async def test_the_bridge_identity_is_bound_and_linked_never_an_earlier_intruder(self) -> None:
        rig = self.rig(participants=("intruder",), activate_ok=True)
        with self.patched(rig, flag="1"), capture_r1_logs() as logs:
            task = asyncio.create_task(run_r1_session(rig.ctx, session_factory=rig.factory))
            await self.until(
                lambda: any(b[1][2] is rig.session for b in rig.built)
                and "participant_connected" in rig.ctx.room.handlers
            )
            interview = self.main_interview(rig)[0]
            await asyncio.sleep(0.05)
            # The intruder was in the room first: it is never selected, and nothing is activated.
            self.assertEqual(interview._candidate_identity, MEET_IDENTITY)
            self.assertFalse(interview._candidate_present)
            self.assertEqual(rig.writer.activations, 0)
            bridge = FakeParticipant(MEET_IDENTITY)
            rig.ctx.room.remote_participants[MEET_IDENTITY] = bridge
            rig.ctx.room.emit("participant_connected", bridge)
            await self.until(lambda: rig.session.started is not None)
            # A later look-alike is never bound either.
            other = FakeParticipant("meet-deadbeef")
            rig.ctx.room.remote_participants["meet-deadbeef"] = other
            rig.ctx.room.emit("participant_connected", other)
            self.assertEqual(interview._candidate_identity, MEET_IDENTITY)
            self.assertIs(interview._candidate_seen, bridge)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(task, 10.0)
        self.assertEqual(rig.writer.activations, 1)
        self.assertEqual(self.main_interview(rig)[2].get("meet"), MEET_CHANNEL)
        options = rig.session.started["room_options"]
        self.assertEqual(linked_identity(options), MEET_IDENTITY)
        self.assertFalse(options.text_input)
        self.assertFalse(options.close_on_disconnect)
        self.assertEqual(interview._room_options_kwargs(), MEET_ROOM_OPTIONS)
        meet_logs = [line for line in logs if line.get("error_type") == "r1_meet_channel"]
        self.assertEqual(len(meet_logs), 1)
        self.assertEqual(meet_logs[0]["error_category"], "meet")
        self.assertEqual(meet_logs[0]["schema"], "r1_dex_sales")
        self.assertNotIn("r1_meet_channel_invalid", error_types(logs))
        self.assert_nothing_identifying_logged(logs)

    async def test_only_an_intruder_present_is_a_no_show(self) -> None:
        rig = self.rig(participants=("intruder",))
        with mock.patch.object(r1_session, "NO_SHOW_SECONDS", 0.05):
            outcome, logs = await self.run_session(rig, flag="1")
        self.assertEqual(outcome, "no_show")
        interview = self.main_interview(rig)[0]
        self.assertEqual(interview._candidate_identity, MEET_IDENTITY)
        self.assertFalse(interview._candidate_ever_present)
        self.assertEqual(rig.writer.activations, 0)
        self.assertIsNone(rig.session.started)
        self.assertEqual([terminal[0] for terminal in rig.writer.terminals], ["no_show"])
        self.assert_nothing_identifying_logged(logs)

    # ------------------------------------------------------------ fail closed

    async def test_every_invalid_meet_dispatch_settles_before_connecting(self) -> None:
        other_session = "00000000-0000-4000-8000-000000000001"
        cases = {
            "session_mismatch": {"dispatch_raw": json.dumps(dispatch(session_id=other_session))},
            "identity_invalid": {
                "dispatch_raw": json.dumps(dispatch(candidate_identity="meet-deadbeef"))
            },
            "profile_unknown": {"dispatch_raw": json.dumps(dispatch(profile="r1_unknown_profile"))},
            "room_mirror_mismatch": {
                "room_raw": json.dumps(mirror(candidate_identity="meet-deadbeef"))
            },
            "unreadable": {"raising_room_metadata": True},
        }
        self.assertEqual(set(cases) | {"context_identity_mismatch"}, set(MEET_INVALID_REASONS))
        for reason, overrides in cases.items():
            with self.subTest(reason=reason):
                rig = self.rig(activate_ok=True, **overrides)
                outcome, logs = await self.run_session(rig, flag="1")
                self.assert_settled_before_connect(rig, outcome)
                invalid = [line for line in logs if line.get("error_type") == "r1_meet_channel_invalid"]
                self.assertEqual(len(invalid), 1)
                self.assertEqual(invalid[0]["error_category"], reason)
                self.assertEqual(invalid[0]["level"], "error")
                self.assertNotIn("r1_meet_channel", error_types(logs))
                # Only the settle interview was built: no Meet seam, no session.
                self.assertTrue(all("meet" not in built[2] for built in rig.built))
                self.assertIsNone(rig.session.started)
                self.assert_nothing_identifying_logged(logs)

    async def test_a_meet_room_without_a_meet_dispatch_settles_before_connecting(self) -> None:
        # Review S08-3: the room's mirror says Meet, the dispatch does not.  Never a browser round
        # on the first standard participant (the intruder below is in the room first).
        cases = {
            "channel browser": {
                "dispatch_raw": json.dumps({"session_id": MEET_SESSION_ID, "channel": "browser"})
            },
            "channel missing": {"dispatch_raw": json.dumps(dispatch(channel=_ABSENT))},
            "empty dispatch metadata (an unnamed worker)": {"dispatch_raw": ""},
            "no job": {"with_job": False},
        }
        for label, overrides in cases.items():
            with self.subTest(case=label):
                rig = self.rig(
                    activate_ok=True, participants=("intruder", MEET_IDENTITY), **overrides
                )
                outcome, logs = await self.run_session(rig, flag="1")
                self.assert_settled_before_connect(rig, outcome)
                invalid = [line for line in logs if line.get("error_type") == "r1_meet_channel_invalid"]
                self.assertEqual([line["error_category"] for line in invalid], ["room_mirror_mismatch"])
                self.assertEqual(invalid[0]["level"], "error")
                self.assertIsNone(rig.session.started)
                self.assertTrue(all("meet" not in built[2] for built in rig.built))
                self.assert_nothing_identifying_logged(logs)

    async def test_a_context_naming_someone_else_is_refused_before_the_providers(self) -> None:
        rig = self.rig(
            activate_ok=True,
            context={"first_name": "Asha", "candidate_identity": "candidate", "attempt": {}, "settings": {}},
            participants=(MEET_IDENTITY, "candidate"),
        )
        outcome, logs = await self.run_session(rig, flag="1")
        self.assertEqual(outcome, "configuration_failed")
        self.assertEqual(rig.ctx.connects, 1)
        self.assertEqual(len(rig.fetches), 1)
        self.assertEqual(rig.factories, [])
        self.assertEqual(rig.writer.activations, 0)
        self.assertEqual(rig.writer.terminals, [("configuration_failed", {"activated": False})])
        self.assertEqual(rig.writer.outcomes, ["configuration_failed"])
        self.assertEqual(rig.ctx.shutdowns, ["r1_exit"])
        invalid = [line for line in logs if line.get("error_type") == "r1_meet_channel_invalid"]
        self.assertEqual([line["error_category"] for line in invalid], ["context_identity_mismatch"])
        self.assertTrue(all("meet" not in built[2] for built in rig.built))
        self.assert_nothing_identifying_logged(logs)

    async def test_a_context_naming_the_bridge_or_nobody_proceeds(self) -> None:
        for context_identity in (MEET_IDENTITY, None, ""):
            with self.subTest(context_identity=context_identity):
                context = {"first_name": "Asha", "attempt": {}, "settings": {}}
                if context_identity is not None:
                    context["candidate_identity"] = context_identity
                rig = self.rig(context=context)
                outcome, logs = await self.run_session(rig, flag="1")
                # Activation is refused by the fake writer: the run got past every Meet check.
                self.assertEqual(outcome, "configuration_failed")
                self.assertEqual(len(rig.factories), 1)
                self.assertEqual(rig.writer.activations, 1)
                self.assertNotIn("r1_meet_channel_invalid", error_types(logs))
                interview, _args, kwargs = self.main_interview(rig)
                self.assertEqual(kwargs["meet"], MEET_CHANNEL)
                self.assertEqual(interview._candidate_identity, MEET_IDENTITY)

    # ------------------------------------------------------------ recording

    async def test_a_meet_round_records_audio_only_without_touching_the_context(self) -> None:
        rig = self.rig()
        await self.run_session(rig, flag="1")
        self.assertEqual(len(rig.recorder_contexts), 1)
        given = rig.recorder_contexts[0]
        self.assertIsNot(given, rig.fetched)
        self.assertEqual(given["recording"], {"mode": "audio"})
        self.assertEqual(rig.fetched["recording"], {"mode": "av"})  # not mutated
        self.assertEqual({k: v for k, v in given.items() if k != "recording"},
                         {k: v for k, v in rig.fetched.items() if k != "recording"})
        # The interview itself still gets the context the API sent.
        self.assertIs(self.main_interview(rig)[1][1], rig.fetched)

    async def test_a_browser_round_hands_the_recorder_the_very_same_context(self) -> None:
        rig = self.rig(dispatch_raw=json.dumps({"session_id": MEET_SESSION_ID, "channel": "browser"}),
                       room_raw=browser_room(), participants=("candidate",))
        await self.run_session(rig, flag="1")
        self.assertEqual(len(rig.recorder_contexts), 1)
        self.assertIs(rig.recorder_contexts[0], rig.fetched)
        self.assertEqual(rig.fetched["recording"], {"mode": "av"})

    # ------------------------------------------------------------ browser equivalence

    async def test_every_browser_case_is_todays_behaviour_exactly(self) -> None:
        browser_dispatch = {"session_id": MEET_SESSION_ID, "channel": "browser"}
        room = browser_room()  # today's browser room metadata: no channel, no identity
        cases = {
            "flag off, valid meet metadata": {"flag": None, "rig": {}},
            "flag 0, valid meet metadata": {"flag": "0", "rig": {}},
            "flag off, meet room, browser dispatch": {
                "flag": None,
                "rig": {"dispatch_raw": json.dumps(browser_dispatch)},
            },
            "flag on, channel browser": {
                "flag": "1",
                "rig": {"dispatch_raw": json.dumps(browser_dispatch), "room_raw": room},
            },
            "flag on, channel missing": {
                "flag": "1",
                "rig": {"dispatch_raw": json.dumps(dispatch(channel=_ABSENT)), "room_raw": room},
            },
            "flag on, channel MEET": {
                "flag": "1",
                "rig": {"dispatch_raw": json.dumps(dispatch(channel="MEET")), "room_raw": room},
            },
            "flag on, empty dispatch metadata": {
                "flag": "1",
                "rig": {"dispatch_raw": "", "room_raw": room},
            },
            "flag on, no job": {"flag": "1", "rig": {"with_job": False, "room_raw": room}},
        }
        for name, case in cases.items():
            with self.subTest(case=name):
                rig = self.rig(participants=("candidate", MEET_IDENTITY), activate_ok=True, **case["rig"])
                with self.patched(rig, flag=case["flag"]), capture_r1_logs() as logs:
                    task = asyncio.create_task(run_r1_session(rig.ctx, session_factory=rig.factory))
                    await self.until(lambda: rig.session.started is not None)
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await asyncio.wait_for(task, 10.0)
                interview, args, kwargs = self.main_interview(rig)
                self.assertNotIn("meet", kwargs)
                self.assertEqual(set(kwargs), {"line_cache"})
                self.assertIs(args[1], rig.fetched)
                self.assertIsNone(interview._meet)
                # The first standard participant is bound, exactly as before.
                self.assertEqual(interview._candidate_identity, "candidate")
                self.assertEqual(interview._room_options_kwargs(), BROWSER_ROOM_OPTIONS)
                options = rig.session.started["room_options"]
                self.assertIsNone(linked_identity(options))
                self.assertFalse(options.text_input)
                self.assertFalse(options.close_on_disconnect)
                self.assertEqual(len(rig.recorder_contexts), 1)
                self.assertIs(rig.recorder_contexts[0], rig.fetched)
                self.assertEqual(rig.ctx.connects, 1)
                self.assert_no_meet_log(logs)


# --------------------------------------------------------------------------------------------
# T4: the Meet conversation (the lines, the ready relay, the mute and no-audio ladder).
# --------------------------------------------------------------------------------------------

import re  # noqa: E402

from r1_phases import R1Phase  # noqa: E402
from r1_script import LINES, MEET_LINES, active_line_id, line, meet_line_id  # noqa: E402
from tests.test_r1_core import (  # noqa: E402
    Clock,
    FakePublication,
    R1TestCase,
    append,
    final_event,
    ready_packet,
)

# Wording a Meet candidate cannot act on: they never see our page (S08 plan section 2).
BANNED = re.compile(
    r"\b(?:button|click|press|tap|link|refresh|reload|window|browser|tab|screen|page|"
    r"selected)\b",
    re.IGNORECASE,
)
OPENING_IDS = ("L-OPEN", "L-OPEN-HELLO", "L-OPEN-HI")
NOT_OPENING_IDS = (
    "L-TRANSITION-REASK-2", "L-SYSTEM-STOP", "L-CLOSE", "L-CLOSE-SHORT", "L-SIL-NOAUDIO",
)
# Every id a Meet round speaks at its edges: the openings and the sound check's hello-again, the
# closes, the system stop, the no-audio ladder and the transition's last reask.
EDGE_IDS = (*OPENING_IDS, "L-OPEN-HELLO-AGAIN", *NOT_OPENING_IDS, "L-SIL-END-NOAUDIO")
MUTE_IDS = ("L-MUTE", "L-MUTE-RP", "L-MUTE-IV")
# The persona flags -> who introduces themself: Lexy (the default, owner 2026-11-27), Dex
# (R1_INTERVIEWER_LEXY=0) and Christy (R1_INTERVIEWER_DEX=0).
INTERVIEWERS = (
    ({"R1_INTERVIEWER_DEX": "1", "R1_INTERVIEWER_LEXY": "1"}, "Lexy"),
    ({"R1_INTERVIEWER_DEX": "1", "R1_INTERVIEWER_LEXY": "0"}, "Dex"),
    ({"R1_INTERVIEWER_DEX": "0"}, "Christy"),
)


def shrinking(seconds: float):
    """A phase budget that really runs out as wall time passes (``TestPhaseDriver.shrinking``)."""
    started = asyncio.get_running_loop().time()
    return lambda: max(0.0, seconds - (asyncio.get_running_loop().time() - started))


class MeetCase(R1TestCase):
    """``R1TestCase`` with a Google Meet interview whose bound participant is the bridge.

    ``spoken_line`` renders a line as a Meet round does; ``browser_line`` as a browser round of
    the same context (and so the same persona) does; ``text_of`` fills a line's own text with no
    routing at all.  ``browser_interview`` builds today's control.
    """

    LINE_CONTEXT = {"first_name": "Asha"}

    async def asyncSetUp(self) -> None:
        self.clock = Clock()
        self.order: list = []
        self.ctx = FakeContext(self.order)
        self.session = FakeSession(log=self.order)
        self.writer = FakeWriter(self.order)
        self.interview = R1Interview(
            self.ctx,
            dict(self.LINE_CONTEXT),
            self.session,
            self.writer,
            clock=self.clock,
            recorder_finish=lambda: append(self.order, "recording"),
            meet=MEET_CHANNEL,
        )
        self.interview.wire_events()
        self.ctx.room.emit("participant_connected", self.bridge())
        self.interview.machine.transition(R1Phase.OPENING)
        self.interview.machine.transition(R1Phase.ICEBREAKER)

    @staticmethod
    def bridge() -> FakeParticipant:
        return FakeParticipant(MEET_IDENTITY)

    def spoken_line(self, line_id: str) -> str:
        interview = R1Interview(
            self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer, meet=MEET_CHANNEL
        )
        return interview.render_line(line_id)

    def browser_line(self, line_id: str) -> str:
        interview = R1Interview(self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer)
        return interview.render_line(line_id)

    def text_of(self, line_id: str) -> str:
        return line(
            line_id,
            first_name=self.interview._first_name(),
            **self.interview.persona.line_values,
        )

    def browser_interview(self) -> tuple[R1Interview, FakeSession]:
        """Today's browser round, its candidate already in, in the icebreaker (the control)."""
        ctx = FakeContext(self.order)
        session = FakeSession(log=self.order)
        interview = R1Interview(
            ctx, {"first_name": "Asha", "candidate_identity": "candidate"}, session, self.writer,
            clock=Clock(),
        )
        interview.wire_events()
        ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        interview.machine.transition(R1Phase.OPENING)
        interview.machine.transition(R1Phase.ICEBREAKER)
        return interview, session

    @staticmethod
    def record_markers(interview: R1Interview) -> list[tuple[str, str]]:
        """Record the (marker, text) of every scripted line ``interview`` speaks from now on."""
        said: list[tuple[str, str]] = []
        original = interview._say_text

        async def recording(text: str, **kwargs: Any) -> None:
            said.append((kwargs.get("marker", "llm"), text))
            await original(text, **kwargs)

        interview._say_text = recording
        return said


class TestMeetRendering(MeetCase):
    """``render_line``: a Meet round speaks the Meet text of the nine ``MEET_LINES`` ids and
    the browser text of every other id; a browser round renders exactly as it did."""

    FLAG_STATES = tuple(
        {**persona, "R1_BRIEF_WORDING_V2": wording}
        for persona, _name in INTERVIEWERS
        for wording in ("1", "0")
    )

    def pair(self) -> tuple[R1Interview, R1Interview]:
        meet = R1Interview(
            self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer, meet=MEET_CHANNEL
        )
        browser = R1Interview(self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer)
        return meet, browser

    async def test_the_meet_ids_speak_the_meet_text_and_every_other_id_the_browser_text(
        self,
    ) -> None:
        for env in self.FLAG_STATES:
            with self.subTest(**env), mock.patch.dict(os.environ, env):
                meet, browser = self.pair()
                self.assertEqual(meet.persona.line_values, browser.persona.line_values)
                values = {"first_name": meet._first_name(), **meet.persona.line_values}
                for line_id in LINES:
                    if line_id in MEET_LINES:
                        expected = line(MEET_LINES[line_id], **values)
                        self.assertEqual(meet.render_line(line_id), expected, line_id)
                        self.assertNotEqual(browser.render_line(line_id), expected, line_id)
                    else:
                        self.assertEqual(
                            meet.render_line(line_id), browser.render_line(line_id), line_id
                        )

    async def test_a_browser_round_renders_exactly_as_before(self) -> None:
        for env in self.FLAG_STATES:
            with self.subTest(**env), mock.patch.dict(os.environ, env):
                _meet, browser = self.pair()
                self.assertIsNone(browser._meet)
                values = {"first_name": browser._first_name(), **browser.persona.line_values}
                for line_id in LINES:
                    self.assertEqual(
                        browser.render_line(line_id), line(active_line_id(line_id), **values),
                        line_id,
                    )

    async def test_the_meet_openings_name_the_interviewer_the_flag_picks(self) -> None:
        for persona, name in INTERVIEWERS:
            with self.subTest(interviewer=name), mock.patch.dict(os.environ, persona):
                self.assertEqual(
                    self.spoken_line("L-OPEN-HI"),
                    f"Hi Asha, I'm {name}, an AI interviewer from Interview Kickstart. Just so "
                    "you know, this call is recorded.",
                )
                self.assertEqual(
                    self.spoken_line("L-OPEN-HELLO"),
                    f"Hi Asha, I'm {name}, an AI interviewer from Interview Kickstart. Just so "
                    "you know, this call is recorded. Can you hear me okay?",
                )

    async def test_the_warm_up_keeps_the_base_ids_and_their_persistence(self) -> None:
        browser = R1Interview(self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer)
        order = self.interview._warm_order()
        self.assertEqual(order, browser._warm_order())
        self.assertFalse([line_id for line_id in order if line_id.endswith("-MEET")])
        self.assertTrue(set(order) & set(MEET_LINES))  # the comparison below is not vacuous
        for candidate_free in (True, False):
            with self.subTest(candidate_free=candidate_free):
                meet_specs = self.interview._warm_specs(candidate_free=candidate_free)
                browser_specs = browser._warm_specs(candidate_free=candidate_free)
                self.assertEqual(
                    [(spec.line_id, spec.persist, spec.voice) for spec in meet_specs],
                    [(spec.line_id, spec.persist, spec.voice) for spec in browser_specs],
                )
                for meet_spec, browser_spec in zip(meet_specs, browser_specs):
                    self.assertEqual(meet_spec.text, self.spoken_line(meet_spec.line_id))
                    if meet_spec.line_id in MEET_LINES:
                        self.assertNotEqual(meet_spec.text, browser_spec.text)
                    else:
                        self.assertEqual(meet_spec.text, browser_spec.text)


class TestMeetDisclosure(MeetRunnerRig, unittest.IsolatedAsyncioTestCase):
    """Owner: "Dex still discloses he is an AI and that the call is recorded."

    Through the real runner, the FIRST line a Meet round speaks carries both, in every opening
    configuration and with either interviewer.  A browser round's first line is today's, with no
    recording notice.
    """

    OPENINGS = (
        ({"R1_OPENING_SOUND_CHECK": "0"}, "L-OPEN"),
        ({"R1_OPENING_SOUND_CHECK": "1", "R1_OPENING_NO_HEARING_CHECK": "0"}, "L-OPEN-HELLO"),
        ({"R1_OPENING_SOUND_CHECK": "1", "R1_OPENING_NO_HEARING_CHECK": "1"}, "L-OPEN-HI"),
    )

    async def first_line(
        self, rig: SimpleNamespace, *, flag: str | None, extra_env: dict[str, str], base: str
    ) -> tuple[str, SimpleNamespace]:
        """Run the session until its first line has played, then cancel it.

        Returns that line and ``base`` filled as the session's own interview fills it, in the
        same environment: its browser text and its Meet text.
        """
        with self.patched(rig, flag=flag, extra_env=extra_env):
            task = asyncio.create_task(run_r1_session(rig.ctx, session_factory=rig.factory))
            try:
                await self.until(
                    lambda: bool(rig.session.spoken)
                    and ("play_end", rig.session.spoken[0]) in rig.session.log
                )
                interview = self.main_interview(rig)[0]
                values = {"first_name": interview._first_name(), **interview.persona.line_values}
                first = rig.session.spoken[0]
                expected = SimpleNamespace(
                    interview=interview,
                    browser=line(base, **values),
                    meet=line(meet_line_id(base), **values),
                )
            finally:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.wait_for(task, 10.0)
        return first, expected

    async def test_the_first_meet_line_discloses_the_ai_and_the_recording(self) -> None:
        for env, base in self.OPENINGS:
            for persona, name in INTERVIEWERS:
                with self.subTest(opening=base, interviewer=name):
                    rig = self.rig(activate_ok=True)
                    first, expected = await self.first_line(
                        rig, flag="1", extra_env={**env, **persona}, base=base
                    )
                    self.assertEqual(expected.interview._meet, MEET_CHANNEL)
                    self.assertEqual(first, expected.meet)
                    self.assertIn("AI interviewer", first)
                    self.assertIn("this call is recorded", first)
                    self.assertTrue(first.startswith(f"Hi Asha, I'm {name}, "), first)
                    self.assertIsNone(BANNED.search(first), first)

    async def test_the_first_browser_line_is_todays_with_no_recording_notice(self) -> None:
        browser_dispatch = json.dumps({"session_id": MEET_SESSION_ID, "channel": "browser"})
        cases = (
            ("flag off, valid meet metadata", None, {}),
            (
                "flag on, channel browser",
                "1",
                {"dispatch_raw": browser_dispatch, "room_raw": browser_room()},
            ),
        )
        for env, base in self.OPENINGS:
            for persona, name in INTERVIEWERS:
                for case, flag, overrides in cases:
                    with self.subTest(opening=base, interviewer=name, case=case):
                        rig = self.rig(activate_ok=True, participants=("candidate",), **overrides)
                        first, expected = await self.first_line(
                            rig, flag=flag, extra_env={**env, **persona},
                            base=base,
                        )
                        self.assertIsNone(expected.interview._meet)
                        self.assertEqual(first, expected.browser)
                        self.assertNotIn("recorded", first)
                        self.assertTrue(first.startswith(f"Hi Asha, I'm {name}, "), first)


class TestMeetSoundCheckRepeat(R1TestCase):
    """Review S08-2: in Meet the spoken disclosure is the candidate's only recording notice (no
    consent page), so when the candidate says they could not hear the hello that carried it, the
    hello-again repeats the AI and recording disclosure.  The sound check runs with
    ``R1_OPENING_NO_HEARING_CHECK=0`` (a documented rollback).  Timings as
    ``TestTheOpeningSoundCheck``; a browser round's hello-again is today's text."""

    DISCLOSURE = "Just so you know, I'm an AI interviewer and this call is recorded."

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        patcher = mock.patch.dict(
            os.environ, {"R1_OPENING_SOUND_CHECK": "1", "R1_OPENING_NO_HEARING_CHECK": "0"}
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in (
            ("OPEN_CHECK_SILENCE_SECONDS", 0.2),
            ("OPEN_HELLO_FOLLOW_SECONDS", 0.6),
            ("NO_AUDIO_END_SECONDS", 0.2),
            ("ICEBREAKER_PROMPT_SECONDS", 30.0),
            ("MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0),
        ):
            patcher = mock.patch.object(r1_session, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def opening(self, *, meet: MeetChannel | None) -> SimpleNamespace:
        ctx = FakeContext(self.order)
        identity = MEET_IDENTITY if meet is not None else "candidate"
        ctx.room.remote_participants[identity] = FakeParticipant(identity)
        context: dict[str, Any] = {"first_name": "Asha"}
        if meet is None:
            context["candidate_identity"] = "candidate"
        session = FakeSession(log=self.order)
        interview = R1Interview(ctx, context, session, self.writer, clock=Clock(), meet=meet)
        task = asyncio.create_task(interview.run())
        run = SimpleNamespace(interview=interview, session=session, task=task)
        self.addCleanup(self.stop, run)
        await self.until(lambda: session.agent is not None)
        return run

    async def stop(self, run: SimpleNamespace) -> None:
        if not run.task.done():
            run.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await run.task

    def played(self, run: SimpleNamespace, line_id: str) -> bool:
        return ("play_end", run.interview.render_line(line_id)) in self.order

    async def reply(self, run: SimpleNamespace, text: str) -> None:
        """A reply the way the SDK delivers it: the final, then the committed turn (no reply)."""
        run.session.emit("user_input_transcribed", final_event(text))
        await self.settle()
        with self.assertRaises(r1_session.StopResponse):
            await run.session.agent.on_user_turn_completed(
                None, SimpleNamespace(text_content=text, id=f"msg_meet_{len(self.order)}")
            )
        await self.settle()

    async def cant_hear_then_yes(self, run: SimpleNamespace) -> list[str]:
        await self.until(lambda: self.played(run, "L-OPEN-HELLO"))
        await self.settle()
        await self.reply(run, "Sorry, I can't hear you.")
        await self.until(lambda: self.played(run, "L-OPEN-HELLO-AGAIN"))
        await self.settle()
        await self.reply(run, "Yes, now I can.")
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        return list(run.session.spoken)

    async def test_the_meet_hello_again_repeats_the_ai_and_recording_disclosure(self) -> None:
        run = await self.opening(meet=MEET_CHANNEL)
        spoken = await self.cant_hear_then_yes(run)
        values = {"first_name": run.interview._first_name(), **run.interview.persona.line_values}
        self.assertEqual(
            spoken,
            [
                line("L-OPEN-HELLO-MEET", **values),
                line("L-OPEN-HELLO-AGAIN-MEET", **values),
                line(active_line_id("L-OPEN-AGENDA"), **values),
            ],
        )
        again = spoken[1]
        self.assertIn(self.DISCLOSURE, again)
        self.assertIn("this call is recorded", again)
        self.assertIn("AI interviewer", again)
        self.assertTrue(again.endswith("Can you hear me now?"), again)
        self.assertIsNone(BANNED.search(again), again)

    async def test_a_browser_hello_again_is_todays_text(self) -> None:
        run = await self.opening(meet=None)
        spoken = await self.cant_hear_then_yes(run)
        values = {"first_name": run.interview._first_name(), **run.interview.persona.line_values}
        self.assertEqual(spoken[1], line("L-OPEN-HELLO-AGAIN", **values))
        self.assertEqual(
            spoken[1],
            "Sorry about that. Please check your speaker or headphone volume. Can you hear me now?",
        )
        self.assertNotIn("recorded", spoken[1])


class TestMeetNoButtonOrLinkWording(MeetCase):
    """A Meet round never asks for a button, a link, a window or a refresh, and the routed lines
    keep their base ids for everything but the spoken text."""

    async def test_the_last_reask_speaks_the_meet_text_and_keeps_the_start_question(self) -> None:
        said = self.record_markers(self.interview)
        self.interview._enter(R1Phase.TRANSITION)
        await self.interview.say("L-TRANSITION-REASK-2")
        text = self.text_of("L-TRANSITION-REASK-2-MEET")
        self.assertEqual(self.session.spoken, [text])
        self.assertIn("say 'ready'", text)
        self.assertIsNone(BANNED.search(text))
        self.assertEqual(said, [("L-TRANSITION-REASK-2", text)])  # the marker is the base id
        self.assertEqual(
            self.interview._start_question,
            r1_session._START_QUESTION_OF_LINE["L-TRANSITION-REASK-2"],
        )
        self.assertEqual(self.interview._start_question_line, "L-TRANSITION-REASK-2")
        self.assertEqual(self.interview._last_transition_line, "L-TRANSITION-REASK-2")
        self.assertEqual(self.interview._transition_said, ["L-TRANSITION-REASK-2"])
        # The browser round's bookkeeping is the same; only its text differs.
        browser, session = self.browser_interview()
        browser._enter(R1Phase.TRANSITION)
        await browser.say("L-TRANSITION-REASK-2")
        self.assertEqual(session.spoken, [self.browser_line("L-TRANSITION-REASK-2")])
        self.assertNotEqual(session.spoken, self.session.spoken)
        for attribute in (
            "_start_question", "_start_question_line", "_last_transition_line", "_transition_said",
        ):
            self.assertEqual(getattr(browser, attribute), getattr(self.interview, attribute))

    async def test_a_system_stop_speaks_the_meet_text(self) -> None:
        said = self.record_markers(self.interview)
        await self.interview._finish("provider_error", system=True)
        text = self.text_of("L-SYSTEM-STOP-MEET")
        self.assertEqual(self.session.spoken, [text])
        self.assertEqual(said, [("L-SYSTEM-STOP", text)])
        self.assertIn("in touch to arrange a new time", text)
        self.assertIsNone(BANNED.search(text))

    async def test_the_normal_close_speaks_the_meet_text(self) -> None:
        for short, base, meet_id in (
            (False, "L-CLOSE", "L-CLOSE-MEET"),
            (True, "L-CLOSE-SHORT", "L-CLOSE-SHORT-MEET"),
        ):
            with self.subTest(close=base):
                await self.asyncSetUp()  # a fresh interview per close
                said = self.record_markers(self.interview)
                self.interview._close_short = short
                await self.interview._finish("complete")
                text = self.text_of(meet_id)
                self.assertEqual(self.session.spoken, [text])
                self.assertEqual(said, [(base, text)])
                self.assertIn("You can leave the call now.", text)
                self.assertIsNone(BANNED.search(text))

    async def test_nothing_a_meet_round_speaks_asks_for_a_button_a_link_or_a_page(self) -> None:
        for env in (
            {},
            {"R1_INTERVIEWER_LEXY": "0"},
            {"R1_INTERVIEWER_DEX": "0"},
            {"R1_BRIEF_WORDING_V2": "0", "R1_TRANSITION_REPAIR": "0"},
            {"R1_OPENING_SOUND_CHECK": "0", "R1_MUTE_ASIDE_V2": "0"},
        ):
            with self.subTest(**env), mock.patch.dict(os.environ, env):
                for line_id in (*self.interview._warm_order(), *EDGE_IDS):
                    text = self.interview.render_line(line_id)
                    self.assertIsNone(BANNED.search(text), f"{line_id}: {text}")
        # Not vacuous: a browser round still says those words in the five non-opening ids.
        for line_id in NOT_OPENING_IDS:
            self.assertIsNotNone(BANNED.search(self.browser_line(line_id)), line_id)


class TestMeetReadyRelay(MeetCase):
    """No button exists in Meet: the page's "I'm ready" relay is refused (``meet_channel``) and
    never latched; a spoken "ready" works as in a browser round, whose relay still latches."""

    async def start_transition(self, interview: R1Interview) -> asyncio.Task:
        interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(interview._run_transition())
        self.addCleanup(task.cancel)
        await self.settle()
        return task

    @staticmethod
    def rejected(logs: list[dict]) -> list[tuple[str, str]]:
        return [
            (line_.get("error_category", ""), line_.get("level", ""))
            for line_ in logs
            if line_.get("error_type") == "r1_ready_rejected"
        ]

    async def test_the_relay_is_never_a_press_in_a_meet_round(self) -> None:
        task = await self.start_transition(self.interview)
        self.assertTrue(self.interview._awaiting_ready)
        with self.capture_logs() as logs:
            self.ctx.room.emit("data_received", ready_packet())
            await self.settle()
        self.assertFalse(self.interview._ready_latched)
        self.assertTrue(self.interview._awaiting_ready)  # what the bridge tile was told stands
        self.assertFalse(task.done())
        self.assertEqual(self.session.spoken, [])
        self.assertEqual(self.rejected(logs), [("meet_channel", "warn")])
        self.assertNotIn("r1_ready_button", error_types(logs))
        # A spoken "ready" still starts the role-play, exactly as in a browser round.
        self.final_transcript("ok, ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])
        self.assertFalse(self.interview._ready_latched)

    async def test_every_relay_is_refused_before_any_other_check(self) -> None:
        # Outside the transition, or naming a sender: still the Meet refusal, never a latch.
        with self.capture_logs() as logs:
            self.ctx.room.emit("data_received", ready_packet())
            self.ctx.room.emit("data_received", ready_packet(participant=self.bridge()))
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.rejected(logs), [("meet_channel", "warn")] * 2)

    async def test_a_browser_round_still_latches_the_relay(self) -> None:
        browser, session = self.browser_interview()
        task = await self.start_transition(browser)
        with self.capture_logs() as logs:
            browser.ctx.room.emit("data_received", ready_packet())
            self.assertTrue(browser._ready_latched)
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(session.spoken, [browser.render_line("L-PICKUP")])
        self.assertIn("r1_ready_button", error_types(logs))
        self.assertEqual(self.rejected(logs), [])


class TestMeetMuteAndNoAudioLadder(MeetCase):
    """The bridge publishes the mixed Meet audio: a track mute is not the candidate's microphone.

    In a Meet round a track mute or unmute changes nothing (``_muted`` stays False; one
    ``r1_meet_mute_ignored`` line per session), so silence of every cause takes the existing
    bounded ladders: never heard -> the Meet no-audio line, then L-SIL-END-NOAUDIO and
    ``candidate_left``; heard then silent -> L-SIL-IB, L-SIL-END; the bridge gone -> the rejoin
    grace, then ``candidate_left``.  Each ends within two prompts.  The browser round keeps its
    mute aside.  Timings as ``TestTheNoAudioLadder``.
    """

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        for name, value in (
            ("ICEBREAKER_PROMPT_SECONDS", 0.05),
            ("ICEBREAKER_END_SECONDS", 0.05),
            ("NO_AUDIO_END_SECONDS", 0.05),
            ("MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0),
        ):
            patcher = mock.patch.object(r1_session, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def mute(self, muted: bool = True) -> None:
        event = "track_muted" if muted else "track_unmuted"
        self.ctx.room.emit(event, self.bridge(), FakePublication())

    def mute_texts(self) -> list[str]:
        texts = {self.spoken_line(i) for i in MUTE_IDS} | {self.browser_line(i) for i in MUTE_IDS}
        return [text for text in self.session.spoken if text in texts]

    def no_audio_ladder(self) -> list[str]:
        return [self.text_of("L-SIL-NOAUDIO-MEET"), self.text_of("L-SIL-END-NOAUDIO")]

    async def run_icebreaker(self) -> str | None:
        return await asyncio.wait_for(self.interview._run_icebreaker(), 10.0)

    def assert_the_mute_changed_nothing(self) -> None:
        self.assertFalse(self.interview._muted)
        self.assertIsNone(self.interview._muted_since)
        self.assertIsNone(self.interview._mute_resume_phase)
        self.assertFalse(self.interview._mute_announced)
        self.assertFalse(self.interview._mute_pending())

    async def assert_a_track_mute_is_silence(self) -> None:
        with self.capture_logs() as logs:
            self.mute()
            self.assert_the_mute_changed_nothing()
            self.mute(False)
            self.mute()
            self.assert_the_mute_changed_nothing()
            outcome = await self.run_icebreaker()
        self.assertEqual(outcome, "candidate_left")
        self.assertEqual(self.session.spoken, self.no_audio_ladder())
        self.assertEqual(self.mute_texts(), [])
        self.assertTrue(self.interview._goodbye_spoken)  # no L-CLOSE after it
        ignored = [row for row in logs if row.get("error_type") == "r1_meet_mute_ignored"]
        self.assertEqual(len(ignored), 1)  # once per session, whatever the number of mutes
        self.assertEqual((ignored[0]["level"], ignored[0]["phase"]), ("info", "icebreaker"))
        self.assertNotIn(MEET_IDENTITY, json.dumps(logs))
        self.assertNotIn("Asha", json.dumps(logs))

    async def test_a_track_mute_is_silence_and_gets_the_meet_no_audio_ladder(self) -> None:
        await self.assert_a_track_mute_is_silence()

    async def test_the_same_with_the_mute_aside_v2_off(self) -> None:
        with mock.patch.dict(os.environ, {"R1_MUTE_ASIDE_V2": "0"}):
            await self.assert_a_track_mute_is_silence()

    async def test_a_published_muted_track_is_silence_too(self) -> None:
        # A bridge that (re)joins with its track already muted: the room's own view is ignored.
        bridge = FakeParticipant(
            MEET_IDENTITY, track_publications={"TR_mic": FakePublication(muted=True)}
        )
        with self.capture_logs() as logs:
            self.ctx.room.emit("participant_connected", bridge)
            self.ctx.room.emit("track_published", FakePublication(muted=True), bridge)
        self.assert_the_mute_changed_nothing()
        self.assertEqual(error_types(logs).count("r1_meet_mute_ignored"), 1)
        self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.no_audio_ladder())

    async def test_silent_from_the_start_gets_the_meet_no_audio_ladder(self) -> None:
        with self.capture_logs() as logs:
            self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.no_audio_ladder())
        self.assertIn("muted in Google Meet", self.session.spoken[0])
        self.assertNotIn("r1_meet_mute_ignored", error_types(logs))
        self.assertIn("r1_no_audio", error_types(logs))

    async def test_heard_then_silent_is_todays_ladder(self) -> None:
        self.final_transcript("Hello")
        self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(
            self.session.spoken, [self.spoken_line("L-SIL-IB"), self.spoken_line("L-SIL-END")]
        )
        self.assertEqual(
            self.session.spoken, [self.browser_line("L-SIL-IB"), self.browser_line("L-SIL-END")]
        )

    async def test_heard_then_muted_is_still_todays_ladder_with_no_mute_line(self) -> None:
        self.final_transcript("Hello")
        await self.settle()
        self.mute()
        self.assert_the_mute_changed_nothing()
        self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(
            self.session.spoken, [self.spoken_line("L-SIL-IB"), self.spoken_line("L-SIL-END")]
        )
        self.assertEqual(self.mute_texts(), [])

    async def test_a_track_mute_in_the_role_play_never_enters_the_aside(self) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        self.addCleanup(turn.cancel)
        await self.settle()
        self.mute()
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)  # the clock keeps running
        self.assert_the_mute_changed_nothing()
        await asyncio.sleep(0.1)
        self.mute(False)
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.final_transcript("back now")
        self.assertIsNone(await asyncio.wait_for(turn, 10.0))
        self.assertEqual(self.mute_texts(), [])
        self.assertEqual(self.session.spoken, [])

    async def test_the_bridge_leaving_the_role_play_ends_after_the_rejoin_grace(self) -> None:
        self.enter_roleplay()
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
            turn = asyncio.create_task(self.interview._roleplay_turn())
            await self.settle()
            self.ctx.room.emit("participant_disconnected", self.bridge())
            self.assertEqual(await asyncio.wait_for(turn, 10.0), "candidate_left")
        self.assertLessEqual(len(self.session.spoken), 2)
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)
        self.assertEqual(self.mute_texts(), [])

    async def test_a_browser_round_still_gets_the_mute_aside(self) -> None:
        browser, session = self.browser_interview()
        browser.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.assertTrue(browser._muted)
        budget = shrinking(0.3)
        with mock.patch.object(
            browser.machine, "remaining_icebreaker_seconds", budget
        ), mock.patch.object(browser.machine, "icebreaker_should_end", lambda: budget() <= 0):
            self.assertIsNone(await asyncio.wait_for(browser._run_icebreaker(), 10.0))
        self.assertEqual(session.spoken, [browser.render_line("L-MUTE-IV")])


if __name__ == "__main__":
    unittest.main()
