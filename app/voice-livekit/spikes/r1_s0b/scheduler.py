"""Deterministic text-harness version of the R1 owed-move scheduler."""
from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Iterable

from .content import COMMITMENT_LINES, OBJECTION_LINES, SCRIPTED_LINES, Persona


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", text.lower()).strip()


def fuzzy_contains(actual: str, expected: str) -> bool:
    """Conservative ordered-token fuzzy check used to confirm a delivered line."""
    words = [w for w in normalize(expected).split() if len(w) > 2]
    actual_words = normalize(actual).split()
    if not words:
        return False
    position = 0
    matched = 0
    for word in words:
        try:
            position = actual_words.index(word, position) + 1
            matched += 1
        except ValueError:
            continue
    return matched / len(words) >= 0.78


@dataclass(frozen=True)
class OwedMove:
    id: str
    text: str
    opened_at_sec: int
    deadline_sec: int | None


@dataclass
class Delivery:
    move: OwedMove
    delivered_at_sec: int
    slip_sec: int
    confirmed: bool


@dataclass
class OwedMoveScheduler:
    persona: Persona
    avg_turn_seconds: int = 105
    turn_count: int = 0
    covered_format: bool = False
    covered_projects: bool = False
    pitch_seen: bool = False
    candidate_turns_after: dict[str, int] = field(default_factory=dict)
    delivered: list[Delivery] = field(default_factory=list)
    pending: OwedMove | None = None
    price_answer_count: int = 0
    price_quoted_first: bool = False
    early_close_used: bool = False
    commitment_emitted: bool = False

    @property
    def r_seconds(self) -> int:
        return self.turn_count * self.avg_turn_seconds

    def _done(self, move_id: str) -> bool:
        return any(item.move.id == move_id and item.confirmed for item in self.delivered)

    def _family_done(self, family: str) -> bool:
        required = {
            "F3": ("F3_PRIMARY", "F3_PUSH"),
            "F2": ("F2_PRIMARY", "F2_PUSH"),
            "F1": ("F1_ANCHOR", "F1_COUNTER"),
            "F4": ("F4_PRIMARY", "F4_PUSH"),
        }[family]
        return all(self._done(item) for item in required)

    def _move(self, ident: str, opens: int, deadline: int | None = None) -> OwedMove:
        if ident == "L-TIME-CUE":
            text = SCRIPTED_LINES[ident]
        elif ident.startswith("COMMIT_"):
            text = COMMITMENT_LINES[ident.split("_", 1)[1]].format(decision_maker=self.persona.decision_maker)
        else:
            text = OBJECTION_LINES[ident].format(decision_maker=self.persona.decision_maker)
        return OwedMove(ident, text, opens, deadline)

    def observe_candidate(self, text: str) -> None:
        """Advance simulated R and record only deterministic scheduling signals."""
        self.turn_count += 1
        lowered = normalize(text)
        self.covered_format |= any(word in lowered for word in ("live", "recorded", "format", "class"))
        self.covered_projects |= any(word in lowered for word in ("project", "build", "capstone"))
        self.pitch_seen |= any(word in lowered for word in ("course", "program", "module", "instructor", "curriculum", "offer", "value"))
        self.price_quoted_first |= ("$" in text or "price" in lowered or "9000" in lowered) and not self._done("F1_ANCHOR")
        if self._done("F1_ANCHOR") and any(word in lowered for word in ("discount", "off", "cannot", "can do", "price")):
            self.price_answer_count += 1
        for delivery in self.delivered:
            if delivery.confirmed:
                self.candidate_turns_after[delivery.move.id] = self.candidate_turns_after.get(delivery.move.id, 0) + 1

    def next_owed(self) -> OwedMove | None:
        """Return one forced/eligible move in the plan's fixed order."""
        if self.pending is not None:
            return self.pending
        r = self.r_seconds
        if not self._done("Q-A") and not self.covered_format and r >= 120:
            return self._set("Q-A", 120, 210)
        if not self._done("F3_PRIMARY") and (self.pitch_seen or r >= 210):
            return self._set("F3_PRIMARY", r, 300)
        if self._done("F3_PRIMARY") and not self._done("F3_PUSH"):
            return self._set("F3_PUSH", r, 300)
        if self._done("F3_PUSH") and not self._done("F2_PRIMARY") and self.candidate_turns_after.get("F3_PUSH", 0) >= 2:
            return self._set("F2_PRIMARY", r, 420)
        if self._done("F2_PRIMARY") and not self._done("F2_PUSH"):
            return self._set("F2_PUSH", r, 420)
        if not self._done("F1_ANCHOR") and ((self._done("F2_PUSH") and self.candidate_turns_after.get("F2_PUSH", 0) >= 2) or self.price_quoted_first):
            return self._set("F1_ANCHOR", r, 540)
        if self._done("F1_ANCHOR") and not self._done("F1_COUNTER") and self.price_answer_count >= 1:
            return self._set("F1_COUNTER", r, 540)
        if self._family_done("F1") and not self._done("Q-B") and not self.covered_projects:
            return self._set("Q-B", r, 585)
        f1_and_qb = self._family_done("F1") and (self._done("Q-B") or self.covered_projects)
        if f1_and_qb and not self._done("F4_PRIMARY") and self.candidate_turns_after.get("Q-B", 0) >= 2:
            return self._set("F4_PRIMARY", r, 630)
        if self._done("F4_PRIMARY") and not self._done("F4_PUSH"):
            return self._set("F4_PUSH", r, 630)
        # It is a scripted time cue, so it takes priority once no earlier
        # deadline is currently owed.  A pending earlier move stays atomic.
        if not self._done("L-TIME-CUE") and r >= 660:
            return self._set("L-TIME-CUE", 660, None)
        if all(self._family_done(family) for family in ("F1", "F2", "F3", "F4")) and r >= 780 and not self.commitment_emitted:
            return self._set("COMMIT_WEAK", 780, 780)
        return None

    def _set(self, ident: str, opens: int, deadline: int | None) -> OwedMove:
        self.pending = self._move(ident, opens, deadline)
        return self.pending

    def record_learner_text(self, text: str) -> Delivery | None:
        if self.pending is None:
            return None
        move = self.pending
        confirmed = fuzzy_contains(text, move.text)
        if confirmed:
            delivery = Delivery(move, self.r_seconds, max(0, self.r_seconds - (move.deadline_sec or self.r_seconds)), True)
            self.delivered.append(delivery)
            self.pending = None
            if move.id.startswith("COMMIT_"):
                self.commitment_emitted = True
            return delivery
        return Delivery(move, self.r_seconds, max(0, self.r_seconds - (move.deadline_sec or self.r_seconds)), False)

    def pre_stated_commitment(self, grade: str = "WEAK") -> str:
        return COMMITMENT_LINES[grade].format(decision_maker=self.persona.decision_maker)

    def delivery_summary(self) -> dict[str, object]:
        required = ("Q-A", "F3_PRIMARY", "F3_PUSH", "F2_PRIMARY", "F2_PUSH", "F1_ANCHOR", "F1_COUNTER", "Q-B", "F4_PRIMARY", "F4_PUSH")
        items = [item for item in self.delivered if item.move.id in required]
        return {
            "required": len(required),
            "delivered": len({item.move.id for item in items if item.confirmed}),
            "within_60_seconds": sum(1 for item in items if item.confirmed and item.slip_sec <= 60),
            "late_or_missing": [ident for ident in required if not self._done(ident)] + [item.move.id for item in items if item.slip_sec > 60],
        }
