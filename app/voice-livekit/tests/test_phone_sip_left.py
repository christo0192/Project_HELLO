"""M009 E3: a pre-consent SIP departure ends the phone gate quickly and
truthfully (`sip.participant_left`).

Drives the real ``_run_phone_session`` with the shared doubles from
``test_phone_gate``. The gate itself is a fixture here (as in
``test_phone_teardown_edges``): the subject is the entrypoint's new
``participant_disconnected`` listener, the guarded close it schedules, and the
terminal label ``_post_gate_failure_terminal`` chooses. Assertions are taken
from the durable-I/O seams (event posts, recording completion, room delete),
never from synthetic success markers.

No candidate data appears anywhere: identities are the attempt-keyed SIP
identity the dialer mints, reasons are LiveKit enum names.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures


agent = fixtures.agent_mod
phone = fixtures.phone

_SIP_IDENTITY = f"phone-{fixtures._ATTEMPT_ID}"
_KIND_SIP = 3
_KIND_STANDARD = 0

# The livekit rtc DisconnectReason values this lane can see.
_REASONS = {
    0: "UNKNOWN_REASON", 1: "CLIENT_INITIATED", 2: "DUPLICATE_IDENTITY",
    3: "SERVER_SHUTDOWN", 4: "PARTICIPANT_REMOVED", 5: "ROOM_DELETED",
    6: "STATE_MISMATCH", 7: "JOIN_FAILURE", 8: "MIGRATION", 9: "SIGNAL_CLOSE",
    10: "ROOM_CLOSED", 11: "USER_UNAVAILABLE", 12: "USER_REJECTED",
    13: "SIP_TRUNK_FAILURE",
}
_BY_NAME = {name: value for value, name in _REASONS.items()}


class _DisconnectReason:
    """Protobuf-enum shaped: ``Name(None)`` raises, like the real one."""

    @staticmethod
    def Name(value):  # noqa: N802 — protobuf API name
        if not isinstance(value, int):
            raise TypeError("enum value must be an int")
        if value not in _REASONS:
            raise ValueError("unknown enum value")
        return _REASONS[value]


_FAKE_RTC = types.SimpleNamespace(
    DisconnectReason=_DisconnectReason,
    ParticipantKind=types.SimpleNamespace(
        PARTICIPANT_KIND_STANDARD=_KIND_STANDARD,
        PARTICIPANT_KIND_SIP=_KIND_SIP,
    ),
)


class _Room:
    """The slice of ``rtc.Room`` the phone entrypoint touches."""

    def __init__(self, participants):
        self.name = fixtures._PHONE_ROOM
        self.metadata = None
        self.remote_participants = {p.identity: p for p in participants}
        self.handlers: dict[str, list] = {}
        self.off_calls: list[str] = []

    def on(self, event, callback=None):
        self.handlers.setdefault(event, []).append(callback)
        return callback

    def off(self, event, callback):
        self.off_calls.append(event)
        self.handlers.get(event, []).remove(callback)

    def emit(self, event, *args):
        for callback in list(self.handlers.get(event, [])):
            callback(*args)


class _WedgedSpeech:
    """A playout that never finishes: the RCA's wedge."""

    interrupted = False

    def interrupt(self, *, force=False):
        return self

    async def wait_for_playout(self):
        await asyncio.Event().wait()


class _Session(fixtures._FakePhoneSession):
    """Models the SDK close seam: ``aclose()`` -> ``_aclose_impl(reason=...)``."""

    sdk_closes: list = []
    wedge_say = True

    async def _aclose_impl(self, *, reason=None, **_kwargs):
        _Session.sdk_closes.append(reason)

    async def aclose(self):
        await self._aclose_impl(reason="user_initiated")

    def say(self, text, **kwargs):
        if _Session.wedge_say:
            self.spoken.append(text)
            return _WedgedSpeech()
        return super().say(text, **kwargs)


def _sip(identity=_SIP_IDENTITY, kind=_KIND_SIP, reason=_BY_NAME["USER_UNAVAILABLE"]):
    return types.SimpleNamespace(identity=identity, kind=kind, disconnect_reason=reason)


class _Harness:
    def __init__(self):
        self.client = fixtures.FakeEventClient()
        self.participant = _sip()
        self.room = _Room([self.participant])
        self.ctx = fixtures.FakeCtx(fixtures._PHONE_ROOM)
        self.ctx.room = self.room
        self.gate_ready = asyncio.Event()
        self.log = MagicMock()

        client = self.client

        class Recorder:
            def __init__(self, _session):
                self.active = False

            def wire(self):
                return True

            async def begin(self, *_args, **_kwargs):
                self.active = True
                return True

            async def finish(self, _url):
                self.active = False
                client.timeline.append("recording.uploaded")
                return types.SimpleNamespace(sha256="sha", size_bytes=3, duration_ms=7)

            async def discard(self):
                self.active = False

            async def audio_health_heartbeat(self):
                await asyncio.Event().wait()

        self.recorder_cls = Recorder

    def disconnect(self, participant=None):
        self.room.emit("participant_disconnected", participant or self.participant)

    def sip_left_logs(self):
        return [
            c.kwargs for c in self.log.info.call_args_list
            if c.kwargs.get("error_type") == "phone_sip_left_pre_consent"
        ]

    async def run(self, gate, *, wall_clock=5.0, drive=None, expect=None):
        _Session.instances = []
        _Session.sdk_closes = []

        async def prepare(*_args):
            return {"object_key": "phone/test.ogg", "upload_url": "https://put"}

        async def complete(*_args, **_kwargs):
            self.client.timeline.append("recording.completed")

        with patch.object(agent, "AgentSession", _Session), \
             patch.object(agent, "persistence", MagicMock()), \
             patch.object(agent, "_log", self.log), \
             patch.object(agent, "_livekit_rtc", lambda: _FAKE_RTC), \
             patch.object(
                 agent, "_delete_livekit_room", new_callable=AsyncMock,
                 side_effect=lambda _room: self.client.timeline.append("room.delete"),
             ), \
             patch.object(agent, "_phone_gate_wall_clock_seconds", lambda: wall_clock), \
             patch.object(agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(agent.recording, "InWorkerRecorder", self.recorder_cls), \
             patch.object(agent.recording_api, "prepare_recording", prepare), \
             patch.object(agent.recording_api, "complete_recording", complete), \
             patch.object(agent.recording_api, "fail_recording", AsyncMock(return_value=True)), \
             patch.object(agent, "SESSION_MAX_RESIDENCY_SEC", 1.0), \
             patch.object(phone, "run_phone_gate", gate):
            task = asyncio.create_task(agent._run_phone_session(
                self.ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                fixtures._EPOCH, client=self.client,
            ))
            await asyncio.wait_for(self.gate_ready.wait(), timeout=2.0)
            if drive is not None:
                drive()
            result = None
            try:
                result = await asyncio.wait_for(task, timeout=3.0)
            except BaseException as exc:  # noqa: BLE001 — compared below
                if expect is None or not isinstance(exc, expect):
                    raise
            else:
                if expect is not None:
                    raise AssertionError(f"expected {expect.__name__}")
            # Let a scheduled guarded close finish its SDK step.
            for _ in range(20):
                await asyncio.sleep(0.005)
        return result


def _wedged_gate(h: _Harness, *, before_wedge=None):
    async def gate(**kwargs):
        await kwargs["wait_for_participant"]()
        await kwargs["begin_recording_at_answer"]()
        if before_wedge is not None:
            before_wedge(kwargs)
        h.gate_ready.set()
        # The fixed disclosure, wedged in its playout.
        await kwargs["say"](phone.PHONE_DISCLOSURE_TEXT)
        raise AssertionError("a wedged playout must never return")
    return gate


class TestSipDepartureEndsTheGate(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _Session.wedge_say = True

    async def test_user_unavailable_closes_through_the_guard_and_posts_sip_left_once(self):
        h = _Harness()
        result = await h.run(_wedged_gate(h), drive=h.disconnect)

        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        # The close went through the GUARD (the SDK close ran once, after the
        # coordinator), not straight to the SDK.
        self.assertEqual(_Session.sdk_closes, ["user_initiated"])
        self.assertEqual(h.client.event_types.count("sip.participant_left"), 1)
        self.assertNotIn("candidate.deferred_pre_disclosure", h.client.event_types)
        # Evidence, then terminal, then room delete.
        timeline = h.client.timeline
        self.assertLess(timeline.index("recording.uploaded"),
                        timeline.index("event:sip.participant_left"))
        self.assertLess(timeline.index("recording.completed"),
                        timeline.index("event:sip.participant_left"))
        self.assertLess(timeline.index("event:sip.participant_left"),
                        timeline.index("room.delete"))
        self.assertEqual(h.sip_left_logs(), [{
            "error_type": "phone_sip_left_pre_consent",
            "error_category": "USER_UNAVAILABLE",
            "phase": "close_scheduled",
        }])
        # Deregistered when the gate ended.
        self.assertIn("participant_disconnected", h.room.off_calls)
        self.assertEqual(h.room.handlers.get("participant_disconnected"), [])

    async def test_each_terminal_reason_schedules_the_close(self):
        for name in ("USER_REJECTED", "SIP_TRUNK_FAILURE", "CLIENT_INITIATED"):
            with self.subTest(reason=name):
                h = _Harness()
                h.participant.disconnect_reason = _BY_NAME[name]
                result = await h.run(_wedged_gate(h), drive=h.disconnect)
                self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
                self.assertEqual(_Session.sdk_closes, ["user_initiated"])
                self.assertEqual(h.client.event_types, ["sip.participant_left"])

    async def test_none_reason_is_unknown_never_name_none_and_closes(self):
        h = _Harness()
        h.participant.disconnect_reason = None  # rtc maps UNKNOWN_REASON to None
        result = await h.run(_wedged_gate(h), drive=h.disconnect)

        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(_Session.sdk_closes, ["user_initiated"])
        self.assertEqual(h.client.event_types, ["sip.participant_left"])
        self.assertEqual(h.sip_left_logs()[0]["error_category"], "UNKNOWN")
        self.assertFalse(any(
            c.kwargs.get("error_category") == "handler_failed"
            for c in h.log.warn.call_args_list
        ))

    async def test_signal_close_and_migration_never_close(self):
        for name in ("SIGNAL_CLOSE", "MIGRATION"):
            with self.subTest(reason=name):
                h = _Harness()
                h.participant.disconnect_reason = _BY_NAME[name]
                # Nothing closes the session, so only the gate's own wall
                # clock ends it.
                result = await h.run(_wedged_gate(h), drive=h.disconnect, wall_clock=0.2)
                self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
                self.assertEqual(_Session.sdk_closes, [])
                self.assertEqual(h.sip_left_logs(), [{
                    "error_type": "phone_sip_left_pre_consent",
                    "error_category": name,
                    "phase": "no_close",
                }])
                # The departure was still observed, so the exit is named for it.
                self.assertEqual(h.client.event_types, ["sip.participant_left"])

    async def test_other_identity_or_non_sip_kind_is_ignored(self):
        cases = (
            ("other identity", _sip(identity="phone-00000000-0000-4000-8000-000000000000")),
            ("non-sip kind", _sip(kind=_KIND_STANDARD)),
            ("kind missing", types.SimpleNamespace(
                identity=_SIP_IDENTITY, disconnect_reason=_BY_NAME["USER_UNAVAILABLE"],
            )),
        )
        for label, departed in cases:
            with self.subTest(case=label):
                h = _Harness()
                result = await h.run(
                    _wedged_gate(h), drive=lambda h=h, p=departed: h.disconnect(p),
                    wall_clock=0.2,
                )
                self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
                self.assertEqual(_Session.sdk_closes, [])
                self.assertEqual(h.sip_left_logs(), [])
                self.assertEqual(h.client.event_types, ["candidate.deferred_pre_disclosure"])

    async def test_without_rtc_the_listener_is_inert(self):
        h = _Harness()
        gate = _wedged_gate(h)

        async def gate_without_rtc(**kwargs):
            # `run` installs the fake rtc; nest the absent-SDK shape over it
            # for the gate's lifetime, which is when the departure arrives.
            with patch.object(agent, "_livekit_rtc", lambda: None):
                return await gate(**kwargs)

        result = await h.run(gate_without_rtc, drive=h.disconnect, wall_clock=0.2)
        self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
        self.assertEqual(_Session.sdk_closes, [])
        self.assertEqual(h.client.event_types, ["candidate.deferred_pre_disclosure"])


def _consent_durable(kwargs):
    kwargs["gate_phase_out"]["consent_durable"] = True


class TestPostConsentGateFailurePostsNothing(unittest.IsolatedAsyncioTestCase):
    """M009 PR-C (R4): after durable consent, a gate drop, timeout or
    exception posts NO terminal at all. Not `assessment.aborted` (that failed
    an interrupted engagement) and not `sip.participant_left` (CloseReason.ERROR
    can fire with SIP still alive, and that event grants a reconnect redial
    onto a live line). Evidence still settles before the room delete."""

    def setUp(self):
        _Session.wedge_say = True

    def _unposted_phases(self, h):
        return [
            c.kwargs.get("phase") for c in h.log.info.call_args_list
            if c.kwargs.get("error_category") == "post_consent_failure_unposted"
        ]

    def _assert_nothing_posted_and_evidence_first(self, h):
        self.assertEqual(h.client.event_types, [])
        self.assertFalse(
            any(item.startswith("event:") for item in h.client.timeline),
            h.client.timeline,
        )
        timeline = h.client.timeline
        self.assertIn("recording.completed", timeline)
        self.assertIn("room.delete", timeline)
        self.assertLess(
            timeline.index("recording.completed"), timeline.index("room.delete"),
        )

    async def test_post_consent_timeout_posts_nothing(self):
        h = _Harness()
        result = await h.run(
            _wedged_gate(h, before_wedge=_consent_durable), wall_clock=0.2,
        )
        self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
        self._assert_nothing_posted_and_evidence_first(h)
        self.assertEqual(self._unposted_phases(h), ["drop_or_timeout"])

    async def test_post_consent_drop_posts_nothing(self):
        h = _Harness()
        result = await h.run(
            _wedged_gate(h, before_wedge=_consent_durable),
            drive=h.disconnect, wall_clock=0.2,
        )
        self.assertIn(
            result.outcome, {phone.GATE_TIMED_OUT, phone.GATE_PARTICIPANT_LEFT},
        )
        self.assertNotIn("sip.participant_left", h.client.event_types)
        self._assert_nothing_posted_and_evidence_first(h)

    async def test_post_consent_exception_posts_nothing(self):
        h = _Harness()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["begin_recording_at_answer"]()
            kwargs["gate_phase_out"]["consent_durable"] = True
            h.gate_ready.set()
            raise RuntimeError("gate provider failed")

        await h.run(gate, expect=RuntimeError)
        self._assert_nothing_posted_and_evidence_first(h)
        self.assertEqual(self._unposted_phases(h), ["exception"])

    async def test_pre_consent_exception_is_unchanged(self):
        h = _Harness()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["begin_recording_at_answer"]()
            h.gate_ready.set()
            raise RuntimeError("gate provider failed")

        await h.run(gate, expect=RuntimeError)
        self.assertEqual(h.client.event_types, ["consent.failed"])
        self.assertEqual(self._unposted_phases(h), [])

    async def test_pre_consent_timeout_is_unchanged(self):
        h = _Harness()
        result = await h.run(_wedged_gate(h), wall_clock=0.2)
        self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
        self.assertEqual(h.client.event_types, ["candidate.deferred_pre_disclosure"])

class TestSipDepartureLeavesOtherPathsAlone(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _Session.wedge_say = True

    async def test_after_consent_durable_nothing_is_posted(self):
        """M009 PR-C (R4): after consent_durable a gate drop posts NOTHING.

        It used to post `assessment.aborted`. Neither that nor a worker
        `sip.participant_left` is truthful here: the server ends the leg via
        the webhook/reconciliation drop or reclaim + E3 hold + partial-finalize.
        """
        h = _Harness()
        departed = asyncio.Event()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            kwargs["gate_phase_out"]["consent_durable"] = True
            h.gate_ready.set()
            await departed.wait()
            # The SDK's own close surfaces as the typed participant-gone signal.
            raise phone.PhoneParticipantGone("participant_gone")

        def drive():
            h.disconnect()
            departed.set()

        result = await h.run(gate, drive=drive)
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(_Session.sdk_closes, [])
        self.assertEqual(h.sip_left_logs(), [])
        self.assertNotIn("sip.participant_left", h.client.event_types)
        self.assertNotIn("assessment.aborted", h.client.event_types)
        self.assertEqual(h.client.event_types, [])

    async def test_lease_halt_cancellation_still_posts_nothing(self):
        h = _Harness()
        departed = asyncio.Event()
        # A non-closing reason is RECORDED, then the lease owner cancels.
        h.participant.disconnect_reason = _BY_NAME["SIGNAL_CLOSE"]

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["begin_recording_at_answer"]()
            h.gate_ready.set()
            await departed.wait()
            raise asyncio.CancelledError

        def drive():
            h.disconnect()
            departed.set()

        await h.run(gate, drive=drive, expect=asyncio.CancelledError)
        self.assertEqual(h.sip_left_logs()[0]["error_category"], "SIGNAL_CLOSE")
        self.assertEqual(_Session.sdk_closes, [])
        self.assertFalse(
            any(item.startswith("event:") for item in h.client.timeline),
            h.client.timeline,
        )
        # Evidence still settles on the lease-halt path.
        self.assertIn("recording.completed", h.client.timeline)

    async def test_terminal_already_posted_is_never_posted_again(self):
        h = _Harness()
        departed = asyncio.Event()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            # The gate's own terminal already landed (e.g. a machine verdict).
            kwargs["gate_phase_out"]["terminal_posted"] = True
            h.gate_ready.set()
            await departed.wait()
            raise phone.PhoneParticipantGone("participant_gone")

        def drive():
            h.disconnect()
            departed.set()

        result = await h.run(gate, drive=drive)
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(_Session.sdk_closes, [])
        self.assertEqual(h.sip_left_logs(), [])
        self.assertEqual(h.client.event_types, [])

    async def test_departure_after_terminal_requested_keeps_the_gate_decision(self):
        # A decision made BEFORE the leg left (here the identity-mismatch
        # deferral) is preserved over the departure label.
        h = _Harness()
        departed = asyncio.Event()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            kwargs["gate_phase_out"][
                "terminal_requested:candidate.deferred_pre_disclosure"] = True
            h.gate_ready.set()
            await departed.wait()
            raise phone.PhoneParticipantGone("participant_gone")

        def drive():
            h.disconnect()
            departed.set()

        await h.run(gate, drive=drive)
        self.assertEqual(h.client.event_types, ["candidate.deferred_pre_disclosure"])

    async def test_participant_left_without_sip_reason_keeps_deferral_and_discard_flag(self):
        h = _Harness()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            kwargs["gate_phase_out"]["not_the_candidate"] = True
            h.gate_ready.set()
            raise phone.PhoneParticipantGone("participant_gone")

        result = await h.run(gate)
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(h.client.event_types, ["candidate.deferred_pre_disclosure"])
        self.assertIn(("candidate.deferred_pre_disclosure", True), h.client.discard_flags)
        self.assertNotIn("sip.participant_left", h.client.event_types)


class TestReasonNaming(unittest.TestCase):
    def test_none_maps_to_unknown_without_calling_name(self):
        rtc = types.SimpleNamespace(DisconnectReason=MagicMock())
        self.assertEqual(
            agent._sip_disconnect_reason_name(rtc, _sip(reason=None)), "UNKNOWN",
        )
        rtc.DisconnectReason.Name.assert_not_called()

    def test_known_and_unmapped_values(self):
        self.assertEqual(
            agent._sip_disconnect_reason_name(_FAKE_RTC, _sip(reason=11)),
            "USER_UNAVAILABLE",
        )
        self.assertEqual(
            agent._sip_disconnect_reason_name(_FAKE_RTC, _sip(reason=999)),
            "UNMAPPED",
        )
        self.assertEqual(
            agent._sip_disconnect_reason_name(
                types.SimpleNamespace(), _sip(reason=11)),
            "UNMAPPED",
        )

    def test_identity_mirrors_the_dialer(self):
        self.assertEqual(
            agent._phone_participant_identity(fixtures._ATTEMPT_ID), _SIP_IDENTITY,
        )

    def test_close_set_excludes_transport_reasons(self):
        self.assertEqual(
            agent._PHONE_SIP_LEFT_CLOSE_REASONS,
            frozenset({"USER_UNAVAILABLE", "USER_REJECTED", "SIP_TRUNK_FAILURE",
                       "CLIENT_INITIATED", "UNKNOWN"}),
        )


if __name__ == "__main__":
    unittest.main()
