"""Synthetic callback protocol tests: proposal, explicit confirmation, and copy."""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
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


if __name__ == "__main__":
    unittest.main()
