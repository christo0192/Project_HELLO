"""Explicit, single-scheduler wind-down state machine for phone calls."""
from __future__ import annotations
from enum import Enum


class ClosingState(str, Enum):
    SCREENING = "screening"
    WIND_DOWN_PENDING = "wind_down_pending"
    CANDIDATE_QNA = "candidate_qna"
    CLOSING_PENDING = "closing_pending"
    CLOSING_PLAYED = "closing_played"


class ClosingStateMachine:
    def __init__(self) -> None:
        self.state = ClosingState.SCREENING

    def plan_completed(self) -> None:
        if self.state is not ClosingState.SCREENING:
            raise RuntimeError("closing_invalid_plan_transition")
        self.state = ClosingState.WIND_DOWN_PENDING

    def wind_down_delivered(self) -> None:
        if self.state is not ClosingState.WIND_DOWN_PENDING:
            raise RuntimeError("closing_invalid_wind_down_transition")
        self.state = ClosingState.CANDIDATE_QNA

    def candidate_questions_handled(self) -> None:
        if self.state is not ClosingState.CANDIDATE_QNA:
            raise RuntimeError("closing_invalid_qna_transition")
        self.state = ClosingState.CLOSING_PENDING

    def cancel_for_callback(self) -> None:
        """Cancel authored-but-unplayed closing when callback intent arrives."""
        if self.state not in {ClosingState.CANDIDATE_QNA, ClosingState.CLOSING_PENDING}:
            raise RuntimeError("closing_invalid_callback_transition")
        self.state = ClosingState.SCREENING

    def closing_delivered(self) -> None:
        if self.state is not ClosingState.CLOSING_PENDING:
            raise RuntimeError("closing_invalid_close_transition")
        self.state = ClosingState.CLOSING_PLAYED
