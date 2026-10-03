"""Synthetic callback protocol tests: proposal, explicit confirmation, and copy."""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
import unittest.mock
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import phone  # noqa: E402


class FakeClient:
    def __init__(self, outcome: phone.PhoneApiOutcome, proposal: phone.CallbackProposal | None):
        self.outcome = outcome
        self.proposal = proposal
        self.propose_calls: list[tuple[str, str]] = []

    async def propose_callback(self, attempt_id: str, starts_at: str):
        self.propose_calls.append((attempt_id, starts_at))
        return self.outcome, self.proposal


class CallbackProtocolTests(unittest.TestCase):
    def test_confirmation_is_deterministic_and_ambiguous_is_not_yes(self):
        self.assertEqual(phone.callback_confirmation_decision("Yes, that's correct"), "confirmed")
        self.assertEqual(phone.callback_confirmation_decision("No, please make it later"), "declined")
        self.assertIsNone(phone.callback_confirmation_decision("Maybe, let me think"))

    def test_proposal_reads_back_server_normalized_ist_without_booking(self):
        client = FakeClient(
            phone.PhoneApiOutcome(True, "proposal_valid"),
            phone.CallbackProposal({
                "starts_at": "2026-09-01T10:00:00.000Z",
                "ends_at": "2026-09-01T10:10:00.000Z",
                "weekday": "Tuesday",
                "ist_date": "2026-09-01",
                "ist_time": "15:30",
                "time_zone": "Asia/Kolkata",
            }),
        )
        turn, proposal = asyncio.run(phone.propose_callback_turn(
            client, "attempt-1", "2026-09-01T10:00:00Z"
        ))
        self.assertFalse(turn.booked)
        self.assertEqual(turn.status, "proposal_valid")
        self.assertIn("Tuesday, 2026-09-01 at 15:30 India time", turn.spoken)
        self.assertIn("Is that correct?", turn.spoken)
        self.assertIsNotNone(proposal)
        self.assertEqual(client.propose_calls, [("attempt-1", "2026-09-01T10:00:00Z")])

    def test_refused_proposal_never_speaks_a_booking(self):
        client = FakeClient(phone.PhoneApiOutcome(False, "lead_time_too_short"), None)
        turn, proposal = asyncio.run(phone.propose_callback_turn(
            client, "attempt-1", "2026-09-01T10:00:00Z"
        ))
        self.assertFalse(turn.booked)
        self.assertIsNone(proposal)
        self.assertNotIn("booked", turn.spoken.lower())

    def test_ten_minute_callback_copy_is_not_a_disconnect_timer(self):
        self.assertIn("ten-minute call", phone._CALLBACK_PROPOSAL_PROMPT)
        self.assertNotIn("disconnect", phone._CALLBACK_PROPOSAL_PROMPT.lower())


class DeterministicIstParserTests(unittest.TestCase):
    """`parse_callback_time_ist`: IST anchoring, relative phrases, garbage→None."""

    # Anchor: 2026-09-01 09:00 UTC == 14:30 IST, a Tuesday.
    NOW = datetime(2026, 9, 1, 9, 0, 0, tzinfo=timezone.utc)

    def test_relative_tomorrow_afternoon_is_ist_anchored(self):
        # "tomorrow at 3pm" IST → 2026-09-02 15:00 IST → 09:30Z.
        self.assertEqual(
            phone.parse_callback_time_ist("can you call me tomorrow at 3pm", self.NOW),
            "2026-09-02T09:30:00Z",
        )
        self.assertEqual(
            phone.parse_callback_time_ist("tomorrow 3pm", self.NOW),
            "2026-09-02T09:30:00Z",
        )

    def test_today_with_explicit_minutes(self):
        # "today at 5:30pm" IST == 17:30 IST == 12:00Z (still ahead of 14:30 IST).
        self.assertEqual(
            phone.parse_callback_time_ist("today at 5:30pm", self.NOW),
            "2026-09-01T12:00:00Z",
        )

    def test_weekday_resolves_to_next_occurrence(self):
        # Anchor is Tuesday; "monday at 10am" → next Monday 2026-09-07 10:00 IST.
        self.assertEqual(
            phone.parse_callback_time_ist("call me monday at 10am", self.NOW),
            "2026-09-07T04:30:00Z",
        )

    def test_bare_time_defaults_forward(self):
        # 4pm IST (16:00) is ahead of 14:30 IST → today; 1pm (13:00) has passed → tomorrow.
        self.assertEqual(
            phone.parse_callback_time_ist("call me at 4pm", self.NOW),
            "2026-09-01T10:30:00Z",
        )
        self.assertEqual(
            phone.parse_callback_time_ist("call me at 1pm", self.NOW),
            "2026-09-02T07:30:00Z",
        )

    def test_explicit_iso_date_with_time(self):
        self.assertEqual(
            phone.parse_callback_time_ist("on 2026-09-05 at 11am", self.NOW),
            "2026-09-05T05:30:00Z",
        )

    def test_daypart_word_without_ampm(self):
        self.assertEqual(
            phone.parse_callback_time_ist("3 in the afternoon tomorrow", self.NOW),
            "2026-09-02T09:30:00Z",
        )

    def test_garbage_and_no_time_return_none(self):
        for junk in [
            "call me back later",     # a callback request, but NO time
            "sometime next week",     # vague day, no clock time
            "garbage words here",
            "tomorrow",               # a day, but no clock time
            "yes that works",
            "",
            None,
            12345,
        ]:
            self.assertIsNone(phone.parse_callback_time_ist(junk, self.NOW), repr(junk))

    def test_naive_now_is_treated_as_utc(self):
        naive = datetime(2026, 9, 1, 9, 0, 0)  # no tzinfo
        self.assertEqual(
            phone.parse_callback_time_ist("tomorrow at 3pm", naive),
            "2026-09-02T09:30:00Z",
        )


class SlotFullAlternativesParseTests(unittest.TestCase):
    """The client surfaces the server's nearest-free `alternatives` on slot_full."""

    def _client(self, response_body):
        client = phone.PhoneEventClient.__new__(phone.PhoneEventClient)
        # The client unwraps the transport response via `_response_json`, which
        # calls `.json()`. Mirror that: `_post` returns an object exposing it.
        response = types.SimpleNamespace(json=lambda: response_body)

        async def _post(path, body, hint):
            return response

        client._post = _post  # type: ignore[attr-defined]
        return client

    def test_slot_full_carries_parsed_alternatives(self):
        body = {
            "ok": False,
            "status": "slot_full",
            "alternatives": [
                {"starts_at": "2026-09-02T10:30:00Z", "ends_at": "2026-09-02T10:40:00Z",
                 "ist_time": "16:00", "weekday": "Wednesday"},
                {"starts_at": "bad"},  # malformed → dropped, not raised
                {"starts_at": "2026-09-02T11:30:00Z", "ends_at": "2026-09-02T11:40:00Z",
                 "ist_time": "17:00", "weekday": "Wednesday"},
            ],
        }
        client = self._client(body)
        outcome, proposal = asyncio.run(client.propose_callback("a1", "2026-09-02T09:30:00Z"))
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.status, "slot_full")
        self.assertIsNone(proposal)
        self.assertEqual(len(outcome.alternatives), 2)
        self.assertEqual(outcome.alternatives[0].ist_time, "16:00")
        self.assertEqual(outcome.alternatives[1].ist_time, "17:00")

    def test_other_refusals_have_no_alternatives(self):
        body = {"ok": False, "status": "window_closed"}
        client = self._client(body)
        outcome, _ = asyncio.run(client.propose_callback("a1", "2026-09-02T09:30:00Z"))
        self.assertEqual(outcome.status, "window_closed")
        self.assertEqual(outcome.alternatives, [])

# ── M009 PR-C (C2): every terminal deferral ends HALT_CALLBACK_DEFERRED ──────

_DEF_NOW = datetime(2026, 9, 2, 6, 0, tzinfo=timezone.utc)
_DEF_TIME_TEXT = "on 2026-09-05 at 11am"


class _DeferralClient:
    """A scripted propose/confirm client. ``propose`` may be an outcome or an
    exception to raise; ``confirm`` likewise."""

    def __init__(self, propose=None, confirm=None):
        self._propose = propose
        self._confirm = confirm
        self.propose_calls: list[str] = []
        self.confirm_calls: list[str] = []

    async def propose_callback(self, attempt_id: str, starts_at: str):
        self.propose_calls.append(starts_at)
        if isinstance(self._propose, BaseException):
            raise self._propose
        return self._propose, None

    async def confirm_callback(self, attempt_id: str, starts_at: str):
        self.confirm_calls.append(starts_at)
        if isinstance(self._confirm, BaseException):
            raise self._confirm
        return self._confirm


class _NoProposer:
    """A client without ``propose_callback`` (the proposer_missing exit)."""


def _alt(starts_at: str, ist_time: str) -> phone.CallbackAlternative:
    return phone.CallbackAlternative({
        "starts_at": starts_at, "ends_at": starts_at,
        "ist_time": ist_time, "weekday": "Friday",
    })


def _turn(flow, client, text):
    return asyncio.run(phone.run_callback_turn(
        flow, client, "attempt-1", text, _DEF_NOW,
    ))


class CallbackDeferralHaltTests(unittest.TestCase):
    """C2-P1: the deferral is its own halt, with a bounded sub_reason."""

    def setUp(self):
        self.logged: list[dict] = []
        real_info = phone._log.info

        def capture(event, **meta):
            self.logged.append(dict(meta))
            return real_info(event, **meta)

        patcher = unittest.mock.patch.object(phone._log, "info", side_effect=capture)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _assert_deferred(self, decision, sub_reason, flow=None):
        self.assertTrue(decision.terminal)
        self.assertFalse(decision.booked)
        self.assertEqual(decision.terminal_reason, phone.HALT_CALLBACK_DEFERRED)
        self.assertNotEqual(decision.terminal_reason, phone.HALT_CANDIDATE_ENDED)
        self.assertEqual(decision.sub_reason, sub_reason)
        self.assertFalse(phone.halt_is_retryable(decision.terminal_reason))
        if flow is not None:
            self.assertEqual(flow.phase, phone.CALLBACK_PHASE_DONE)
        deferred_logs = [
            meta.get("error_category") for meta in self.logged
            if meta.get("error_type") == "phone_callback_deferred"
        ]
        self.assertEqual(
            deferred_logs, [sub_reason],
            "the sub_reason must be logged exactly once, as error_category",
        )

    def test_the_halt_is_declared_and_not_retryable(self):
        self.assertEqual(phone.HALT_CALLBACK_DEFERRED, "callback_deferred_in_call")
        self.assertNotIn(phone.HALT_CALLBACK_DEFERRED, phone.RETRYABLE_HALTS)
        # RETRYABLE_HALTS is UNCHANGED by C2.
        self.assertEqual(phone.RETRYABLE_HALTS, frozenset({
            phone.HALT_PERSISTENCE, phone.HALT_SCORING,
            phone.HALT_LEASE_LOST, phone.HALT_LEASE_UNCONFIRMED,
            phone.HALT_CALLBACK_SCHEDULED, phone.HALT_CALLBACK_RECOVERY,
        }))

    # ── the seven exits ─────────────────────────────────────────────────
    def test_proposer_missing(self):
        flow = phone.CallbackFlowState()
        d = _turn(flow, _NoProposer(), _DEF_TIME_TEXT)
        self._assert_deferred(d, "proposer_missing", flow)
        self.assertEqual(d.spoken, phone.PHONE_CALLBACK_DEFERRAL_TEXT)

    def test_proposer_transport_on_a_raise(self):
        flow = phone.CallbackFlowState()
        d = _turn(flow, _DeferralClient(propose=RuntimeError("boom")), _DEF_TIME_TEXT)
        self._assert_deferred(d, "proposer_transport", flow)

    def test_proposer_transport_on_a_categorised_failure_with_no_status(self):
        flow = phone.CallbackFlowState()
        outcome = phone.PhoneApiOutcome(False, None, error_category="transport_error")
        d = _turn(flow, _DeferralClient(propose=outcome), _DEF_TIME_TEXT)
        self._assert_deferred(d, "proposer_transport", flow)

    def test_propose_status_code_for_a_non_actionable_refusal(self):
        flow = phone.CallbackFlowState()
        d = _turn(
            flow, _DeferralClient(propose=phone.PhoneApiOutcome(False, "unknown_attempt")),
            _DEF_TIME_TEXT,
        )
        self._assert_deferred(d, "propose_status_unknown_attempt", flow)
        self.assertEqual(d.spoken, phone.PHONE_CALLBACK_DEFERRAL_TEXT)

    def test_unparseable_after_the_one_clarification(self):
        flow = phone.CallbackFlowState()
        flow.phase = phone.CALLBACK_PHASE_AWAITING_CLARIFY
        client = _DeferralClient()
        d = _turn(flow, client, "Uh, whenever really.")
        self._assert_deferred(d, "unparseable", flow)
        self.assertEqual(client.propose_calls, [])

    def test_retime_spent_on_a_second_refusal(self):
        flow = phone.CallbackFlowState()
        flow.phase = phone.CALLBACK_PHASE_AWAITING_RETIME
        d = _turn(
            flow,
            _DeferralClient(propose=phone.PhoneApiOutcome(False, "slot_not_yet_eligible")),
            _DEF_TIME_TEXT,
        )
        self._assert_deferred(d, "retime_spent", flow)
        self.assertEqual(
            d.spoken, phone.schedule_terminal_deferral_text("slot_not_yet_eligible"),
        )

    def test_retime_spent_on_an_unparseable_retime_reply(self):
        flow = phone.CallbackFlowState()
        flow.phase = phone.CALLBACK_PHASE_AWAITING_RETIME
        d = _turn(flow, _DeferralClient(), "I don't know.")
        self._assert_deferred(d, "retime_spent", flow)

    def test_confirm_refusal_spent(self):
        flow = phone.CallbackFlowState()
        flow.phase = phone.CALLBACK_PHASE_AWAITING_RETIME
        d = _turn(
            flow,
            _DeferralClient(
                propose=phone.PhoneApiOutcome(True, "proposal_valid"),
                confirm=phone.PhoneApiOutcome(False, "daily_attempt_exists"),
            ),
            _DEF_TIME_TEXT,
        )
        self._assert_deferred(d, "confirm_refusal_spent", flow)
        self.assertEqual(
            d.spoken, phone.schedule_terminal_deferral_text("daily_attempt_exists"),
        )

    def test_alt_unpicked(self):
        flow = phone.CallbackFlowState()
        flow.phase = phone.CALLBACK_PHASE_AWAITING_ALT_PICK
        flow.alternatives = [
            _alt("2026-09-05T09:00:00Z", "14:30"),
            _alt("2026-09-05T10:00:00Z", "15:30"),
        ]
        client = _DeferralClient()
        d = _turn(flow, client, "Neither of those, sorry.")
        self._assert_deferred(d, "alt_unpicked", flow)
        self.assertEqual(client.propose_calls, [])

    def test_the_fixed_sub_reasons_are_declared(self):
        # Six fixed codes + the bounded `propose_status_<code>` family = 7.
        self.assertEqual(phone.CALLBACK_DEFERRAL_SUB_REASONS, frozenset({
            "proposer_missing", "proposer_transport", "unparseable",
            "retime_spent", "confirm_refusal_spent", "alt_unpicked",
        }))

    # ── the single-reply production shape (4352df89, ab6126e0) ──────────
    def test_single_reply_shape_only_a_failed_propose_terminates(self):
        """ONE candidate reply in AWAITING_TIME. The only terminating exits are
        a missing proposer, a propose transport failure, and a non-actionable
        propose status, and every one is HALT_CALLBACK_DEFERRED. A retryable
        refusal or an unparseable reply re-asks instead (not terminal)."""
        terminating = (
            (_NoProposer(), "proposer_missing"),
            (_DeferralClient(propose=RuntimeError("x")), "proposer_transport"),
            (_DeferralClient(propose=phone.PhoneApiOutcome(False, "engagement_terminal")),
             "propose_status_engagement_terminal"),
        )
        for client, expected in terminating:
            with self.subTest(expected=expected):
                self.logged.clear()
                flow = phone.CallbackFlowState()
                d = _turn(flow, client, _DEF_TIME_TEXT)
                self._assert_deferred(d, expected, flow)
        for status in sorted(phone._CALLBACK_RETRYABLE_REFUSALS):
            with self.subTest(status=status):
                flow = phone.CallbackFlowState()
                d = _turn(
                    flow, _DeferralClient(propose=phone.PhoneApiOutcome(False, status)),
                    _DEF_TIME_TEXT,
                )
                self.assertFalse(d.terminal)
        flow = phone.CallbackFlowState()
        self.assertFalse(_turn(flow, _DeferralClient(), "Can you call me later?").terminal)

    # ── what is NOT a deferral ──────────────────────────────────────────
    def test_a_confirm_transport_failure_stays_recovery_and_posts_nothing(self):
        flow = phone.CallbackFlowState()
        d = _turn(
            flow,
            _DeferralClient(
                propose=phone.PhoneApiOutcome(True, "proposal_valid"),
                confirm=phone.PhoneApiOutcome(False, None, error_category="transport_error"),
            ),
            _DEF_TIME_TEXT,
        )
        self.assertEqual(d.terminal_reason, phone.HALT_CALLBACK_RECOVERY)
        self.assertIsNone(d.sub_reason)
        self.assertTrue(phone.halt_is_retryable(d.terminal_reason))

    def test_a_booking_stays_scheduled(self):
        flow = phone.CallbackFlowState()
        d = _turn(
            flow,
            _DeferralClient(
                propose=phone.PhoneApiOutcome(True, "proposal_valid"),
                confirm=phone.PhoneApiOutcome(True, "ok"),
            ),
            _DEF_TIME_TEXT,
        )
        self.assertTrue(d.booked)
        self.assertEqual(d.terminal_reason, phone.HALT_CALLBACK_SCHEDULED)
        self.assertIsNone(d.sub_reason)

    def test_the_callback_flow_never_ends_candidate_ended(self):
        """HALT_CANDIDATE_ENDED belongs to the explicit end-call only."""
        import inspect as _inspect
        src = _inspect.getsource(phone)
        start = src.index("class CallbackDecision:")
        end = src.index("def resolve_function_tool(")
        self.assertNotIn("HALT_CANDIDATE_ENDED", src[start:end])


class DeferralSubReasonBoundTests(unittest.TestCase):
    def test_fixed_codes_pass_through(self):
        for code in phone.CALLBACK_DEFERRAL_SUB_REASONS:
            self.assertEqual(phone._bounded_deferral_sub_reason(code), code)

    def test_propose_status_codes_are_bounded(self):
        bound = phone._bounded_deferral_sub_reason
        self.assertEqual(bound("propose_status_slot_full"), "propose_status_slot_full")
        for raw in (
            "propose_status_DROP TABLE x", "propose_status_" + "a" * 41,
            "propose_status_", "free text from a transcript", None, 7, "",
            "propose_status_+919999999999",
        ):
            with self.subTest(raw=raw):
                self.assertEqual(bound(raw), "propose_status_unknown")
        self.assertLessEqual(len(bound("propose_status_" + "a" * 40)), 64)

    def test_a_hostile_status_never_reaches_the_sub_reason(self):
        flow = phone.CallbackFlowState()
        d = _turn(
            flow,
            _DeferralClient(propose=phone.PhoneApiOutcome(False, "call me on 98765 43210")),
            _DEF_TIME_TEXT,
        )
        self.assertEqual(d.sub_reason, "propose_status_unknown")


# ── M009 PR-C (C5): parser gaps and the booked-line read-back ────────────────

#: Anchor: 2026-10-03 08:30 UTC == 14:00 IST, a Saturday.
_C5_NOW = datetime(2026, 10, 3, 8, 30, tzinfo=timezone.utc)
#: Expected instants, as IST wall clock -> UTC (IST = UTC+05:30).
_SUN = "2026-10-04"


def _ist_on(date: str, hh: int, mm: int = 0) -> str:
    """An IST wall-clock time on ``date`` as the parser's UTC ``...Z`` form."""
    local = datetime.fromisoformat(f"{date}T{hh:02d}:{mm:02d}:00+05:30")
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class C5ParserTableTests(unittest.TestCase):
    """The design's parser table, anchored at 2026-10-03 14:00 IST (Saturday)."""

    TABLE: list[tuple[str, str | None]] = [
        # "same time" / "this time": resolved day + no explicit clock only.
        ("tomorrow same time", _ist_on(_SUN, 14)),
        ("same time tomorrow", _ist_on(_SUN, 14)),
        ("Can you call me tomorrow at the same time?", _ist_on(_SUN, 14)),
        ("this time Monday", _ist_on("2026-10-05", 14)),
        ("same time", None),                      # no day: never guessed
        ("call me at this time", None),
        # An explicit clock wins over "same time".
        ("tomorrow same time, no, make it 4pm", _ist_on(_SUN, 16)),
        # Bare 1-6 is PM; bare 7/8 and h:mm before 09:00 are None.
        ("tomorrow at 3", _ist_on(_SUN, 15)),
        ("tomorrow 3:30", _ist_on(_SUN, 15, 30)),
        ("tomorrow at 6", _ist_on(_SUN, 18)),
        ("tomorrow at 3 o'clock", _ist_on(_SUN, 15)),
        ("at 7 tomorrow", None),
        ("tomorrow at 8", None),
        ("tomorrow 7:30", None),
        ("tomorrow 07:30", None),
        ("tomorrow 8:45", None),
        ("tomorrow at 10", _ist_on(_SUN, 10)),
        ("tomorrow at 12", _ist_on(_SUN, 12)),
        ("tomorrow 15:30", _ist_on(_SUN, 15, 30)),
        # noon / midday.
        ("tomorrow noon", _ist_on(_SUN, 12)),
        ("tomorrow at 12 noon", _ist_on(_SUN, 12)),
        ("midday tomorrow", _ist_on(_SUN, 12)),
        ("tomorrow afternoon", None),             # "afternoon" is not "noon"
        # half past / quarter past / quarter to.
        ("half past three tomorrow", _ist_on(_SUN, 15, 30)),
        ("tomorrow at half past 10", _ist_on(_SUN, 10, 30)),
        ("quarter past 4 tomorrow", _ist_on(_SUN, 16, 15)),
        ("quarter to five tomorrow", _ist_on(_SUN, 16, 45)),
        ("quarter to nine tomorrow", None),       # 08:45, before the window
        ("half past 7 tomorrow", None),           # bare 7 stays ambiguous
        ("half past 7 pm tomorrow", _ist_on(_SUN, 19, 30)),
        # Number words one..twelve in clock context.
        ("tomorrow at three", _ist_on(_SUN, 15)),
        ("three pm tomorrow", _ist_on(_SUN, 15)),
        ("tomorrow four thirty pm", _ist_on(_SUN, 16, 30)),
        ("eleven in the morning tomorrow", _ist_on(_SUN, 11)),
        ("tomorrow at eleven", _ist_on(_SUN, 11)),
        ("at one point tomorrow I'm free", None),  # not clock context
        ("one of those days tomorrow", None),
        # Dayparts bind only as phrases.
        ("good morning, call me tomorrow at 3", _ist_on(_SUN, 15)),
        ("tomorrow morning at 10", _ist_on(_SUN, 10)),
        ("tomorrow morning at 3", None),          # 03:00 is outside
        ("tomorrow evening at 6", _ist_on(_SUN, 18)),
        ("tomorrow evening 6", _ist_on(_SUN, 18)),
        ("Monday evening at seven", _ist_on("2026-10-05", 19)),
        ("tonight at 8", _ist_on("2026-10-03", 20)),
        ("tomorrow morning or in the evening at 5", None),  # disagreeing phrases
        ("tomorrow 3pm in the morning", None),    # contradictory
        # Unresolved dates and relative offsets are None, never today/tomorrow.
        ("on the 5th at 4pm", None),
        ("on the fifth at 4pm", None),
        ("October 5 at 4pm", None),
        ("5 May at 4pm", None),
        ("next week at 4pm", None),
        ("this weekend at 11am", None),
        ("in two days at 4pm", None),
        ("in 2 hours", None),
        ("in half an hour", None),
        ("after 30 minutes", None),
        ("call me in an hour", None),
        # Outside 09:00-21:00 IST.
        ("tomorrow at 9pm", None),
        ("tomorrow at 8:59pm", _ist_on(_SUN, 20, 59)),
        ("tomorrow at 9am", _ist_on(_SUN, 9)),
        ("tomorrow at 8am", None),
        ("tomorrow at 11pm", None),
        ("on 2026-10-06 at 10pm", None),
        # Words that merely LOOK like months or dates stay neutral.
        ("you may call tomorrow at 4pm", _ist_on(_SUN, 16)),
        ("on 2026-10-06 at 11am", _ist_on("2026-10-06", 11)),
    ]

    def test_parser_table(self):
        for text, expected in self.TABLE:
            with self.subTest(text=text):
                self.assertEqual(phone.parse_callback_time_ist(text, _C5_NOW), expected)

    def test_same_time_rounds_up_to_five_minutes(self):
        cases = [
            (datetime(2026, 10, 3, 8, 30, 0, tzinfo=timezone.utc), _ist_on(_SUN, 14, 0)),
            (datetime(2026, 10, 3, 8, 30, 1, tzinfo=timezone.utc), _ist_on(_SUN, 14, 5)),
            (datetime(2026, 10, 3, 8, 32, 0, tzinfo=timezone.utc), _ist_on(_SUN, 14, 5)),
            (datetime(2026, 10, 3, 8, 34, 59, tzinfo=timezone.utc), _ist_on(_SUN, 14, 5)),
            (datetime(2026, 10, 3, 8, 35, 0, tzinfo=timezone.utc), _ist_on(_SUN, 14, 5)),
        ]
        for now, expected in cases:
            with self.subTest(now=now.isoformat()):
                self.assertEqual(phone.parse_callback_time_ist("tomorrow same time", now), expected)

    def test_same_time_outside_the_window_is_none(self):
        # 21:58 IST now -> "same time" would be 22:00 tomorrow: refused.
        late = datetime(2026, 10, 3, 16, 28, tzinfo=timezone.utc)
        self.assertIsNone(phone.parse_callback_time_ist("tomorrow same time", late))
        # 07:00 IST now -> 07:00 tomorrow: before the window.
        early = datetime(2026, 10, 3, 1, 30, tzinfo=timezone.utc)
        self.assertIsNone(phone.parse_callback_time_ist("same time tomorrow", early))

    def test_existing_parser_results_are_unchanged(self):
        # Every pre-C5 pinned result, re-asserted under the new rules.
        now = datetime(2026, 9, 1, 9, 0, 0, tzinfo=timezone.utc)
        pinned = {
            "can you call me tomorrow at 3pm": "2026-09-02T09:30:00Z",
            "tomorrow 3pm": "2026-09-02T09:30:00Z",
            "today at 5:30pm": "2026-09-01T12:00:00Z",
            "call me monday at 10am": "2026-09-07T04:30:00Z",
            "call me at 4pm": "2026-09-01T10:30:00Z",
            "call me at 1pm": "2026-09-02T07:30:00Z",
            "on 2026-09-05 at 11am": "2026-09-05T05:30:00Z",
            "3 in the afternoon tomorrow": "2026-09-02T09:30:00Z",
        }
        for text, expected in pinned.items():
            with self.subTest(text=text):
                self.assertEqual(phone.parse_callback_time_ist(text, now), expected)
        self.assertEqual(
            phone.parse_callback_time_ist(
                "Can you schedule a call tomorrow at 10:00 AM?",
                datetime(2026, 8, 31, 16, 47, tzinfo=timezone.utc),
            ),
            "2026-09-01T04:30:00Z",
        )
        self.assertIsNotNone(phone.parse_callback_time_ist(
            "Today at 1 PM.", datetime(2026, 9, 15, 6, 55, tzinfo=timezone.utc),
        ))


class C5BookedReadBackTests(unittest.TestCase):
    """The booked line names the weekday and time it booked, and is gate copy."""

    def test_booked_text_names_ist_weekday_and_time(self):
        self.assertEqual(
            phone._callback_booked_text("2026-10-04T08:30:00Z"),
            "Done, I've booked you for Sunday at 2:00 pm India time. Someone will "
            "call you back then. Thanks for your time, and goodbye.",
        )
        self.assertIn(
            "Monday at 10:30 am India time",
            phone._callback_booked_text("2026-10-05T05:00:00.000Z"),
        )
        self.assertIn(
            "Sunday at 12:00 pm India time",
            phone._callback_booked_text("2026-10-04T06:30:00Z"),
        )

    def test_unreadable_instant_falls_back_to_the_timeless_line(self):
        for bad in (None, "", "tomorrow", "2026-10-04 08:30", 7, "2026-13-40T08:30:00Z"):
            with self.subTest(bad=bad):
                self.assertEqual(phone._callback_booked_text(bad), phone._SCHEDULE_CONFIRMED_TEXT)

    def test_booked_line_is_gate_copy_and_old_line_stays_registered(self):
        line = phone._callback_booked_text("2026-10-04T08:30:00Z")
        self.assertTrue(phone.is_gate_copy(line))
        self.assertTrue(phone.is_gate_copy("  " + line + "  "))
        self.assertIn(phone._SCHEDULE_CONFIRMED_TEXT, phone.gate_copy_texts())
        self.assertTrue(phone.is_gate_copy(phone._SCHEDULE_CONFIRMED_TEXT))
        # The prefix is unique to the booked line: no refusal or terminal line
        # carries it, so prefix matching cannot swallow a screening turn's copy.
        others = [
            *phone._SCHEDULE_REFUSAL_TEXT.values(),
            *phone._SCHEDULE_TERMINAL_TEXT.values(),
            phone._SCHEDULE_REFUSAL_FALLBACK,
            phone.PHONE_CALLBACK_DEFERRAL_TEXT,
        ]
        for text in others:
            self.assertFalse(text.startswith(phone._CALLBACK_BOOKED_PREFIX), text)
        self.assertFalse(phone.is_gate_copy("Done, I've worked there for 3 years."))

    def test_booked_line_never_mentions_calendar_or_email(self):
        lowered = phone._CALLBACK_BOOKED_TEMPLATE.lower()
        for banned in ("google", "calendar", "email", "e-mail", "invite"):
            self.assertNotIn(banned, lowered)

    def test_run_callback_turn_tomorrow_same_time_books_and_reads_back(self):
        flow = phone.CallbackFlowState()
        client = _DeferralClient(
            propose=phone.PhoneApiOutcome(True, "proposal_valid"),
            confirm=phone.PhoneApiOutcome(True, "ok"),
        )
        d = asyncio.run(phone.run_callback_turn(
            flow, client, "attempt-1", "Okay, call me tomorrow same time.", _C5_NOW,
        ))
        self.assertTrue(d.booked)
        self.assertTrue(d.terminal)
        self.assertEqual(d.terminal_reason, phone.HALT_CALLBACK_SCHEDULED)
        self.assertEqual(client.propose_calls, ["2026-10-04T08:30:00Z"])
        self.assertEqual(client.confirm_calls, ["2026-10-04T08:30:00Z"])
        self.assertTrue(d.spoken.startswith(
            "Done, I've booked you for Sunday at 2:00 pm India time."
        ))
        self.assertTrue(phone.is_gate_copy(d.spoken))

    def test_on_the_5th_asks_exactly_one_clarification(self):
        flow = phone.CallbackFlowState()
        client = _DeferralClient(
            propose=phone.PhoneApiOutcome(True, "proposal_valid"),
            confirm=phone.PhoneApiOutcome(True, "ok"),
        )
        first = asyncio.run(phone.run_callback_turn(
            flow, client, "attempt-1", "Call me on the 5th at 4pm", _C5_NOW,
        ))
        self.assertFalse(first.terminal)
        self.assertFalse(first.booked)
        self.assertEqual(first.spoken, phone._CALLBACK_ASK_TIME_TEXT)
        self.assertEqual(flow.phase, phone.CALLBACK_PHASE_AWAITING_CLARIFY)
        self.assertEqual(client.propose_calls, [])
        # Repeating the unresolved date spends the one clarification: deferral.
        second = asyncio.run(phone.run_callback_turn(
            flow, client, "attempt-1", "the 5th, at 4pm", _C5_NOW,
        ))
        self.assertTrue(second.terminal)
        self.assertFalse(second.booked)
        self.assertEqual(second.sub_reason, "unparseable")
        self.assertEqual(client.propose_calls, [])

    def test_schedule_callback_turn_reads_back_the_booked_instant(self):
        class _Booker:
            async def book_appointment(self, attempt_id, starts_at, duration):
                return phone.PhoneApiOutcome(True, "ok")

        turn = asyncio.run(phone.schedule_callback_turn(
            _Booker(), "attempt-1", " 2026-10-04T10:00:00Z ", 900,
        ))
        self.assertTrue(turn.booked)
        self.assertIn("Sunday at 3:30 pm India time", turn.spoken)


if __name__ == "__main__":
    unittest.main()
