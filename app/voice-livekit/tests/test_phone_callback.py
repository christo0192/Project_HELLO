"""Synthetic callback protocol tests: proposal, explicit confirmation, and copy."""

from __future__ import annotations

import asyncio
import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
