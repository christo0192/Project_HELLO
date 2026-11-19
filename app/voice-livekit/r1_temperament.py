"""M033 A5 (R1_TEMPERAMENT): rounded, paraphrased learner aggregates.

The shares, family rates, objection counts and enrolment rates come from
rehearsal/evidence/learner_evidence.json, which is never read at runtime. Tests compare
these constants with that committed file. The disengaged type has no objections and is
excluded by owner decision; the other four shares are renormalised. US learner and USD
stay (D-M033-3): only ratios and patterns are adapted.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from r1_commitment import Level


@dataclass(frozen=True)
class Temperament:
    id: str
    label: str
    weight: float
    count_weights: tuple[tuple[int, float], ...]
    family_weights: tuple[tuple[str, float], ...]
    family_themes: tuple[tuple[str, str], ...]
    f4_theme: str
    enrol_ceiling: Level
    stall_rounds: int
    key_criterion: str
    card_line: str
    timeline_answer: str
    family_minutes: tuple[tuple[str, float], ...] = ()
    theme_weights: tuple[tuple[str, tuple[tuple[str, float], ...]], ...] = ()

    # Practical questions seen late in calls from learners warming up.
    signals: tuple[str, ...] = ()

    def count_weight(self, count: int) -> float:
        return dict(self.count_weights).get(count, 0.0)

    def family_weight(self, family: str) -> float:
        return dict(self.family_weights).get(family, 0.0)


DEFAULT_SIGNALS = ("N-SIG-PLAN",)

CARD_LINE_PREFIX = "How you are as a buyer: "
# Unbanked goal mismatch, payment method, discount and uncategorized objections are excluded;
# there is no instalment plan, and the counter already covers discounts.
TEMPERAMENTS: tuple[Temperament, ...] = (
    Temperament(
        "deep_evaluator", "Deep evaluator", 0.40, ((2, 0.35), (3, 0.35), (4, 0.30)),
        (("F3", 1.07), ("F1", 0.56), ("F2", 0.44)),
        (("F3", "doubts it will pay off"), ("F1", "fee feels high"),
         ("F2", "schedule may not fit")),
        "family_approval", Level.STRONG, 1, "reassurance_and_fit",
        "You want to understand properly before you spend this much: whether it fits you "
        "and will pay off. When your questions are answered well, you can decide on the call.",
        "Once my questions are answered, I can decide quickly.",
        (("F1", 4.9), ("F2", 5.5), ("F3", 8.0)),
        (
            ("F3", (("pays_off", 0.279), ("confirm_fit", 0.172))),
            ("F2", (("schedule", 0.270), ("unavailable_now", 0.168))),
            ("F1", (("fee_high", 0.214), ("cannot_afford", 0.180))),
            ("F4", (("wants_time", 0.208), ("family_approval", 0.054))),
        ),
        signals=("N-SIG-FORMAT", "N-SIG-PLAN"),
    ),
    Temperament(
        "price_negotiator", "Price negotiator", 0.21, ((2, 0.5), (3, 0.4), (4, 0.1)),
        (("F3", 0.70), ("F1", 0.69), ("F2", 0.33)),
        (("F3", "doubts it will pay off"), ("F1", "fee feels high"),
         ("F2", "schedule may not fit")),
        "wants_time", Level.STRONG, 2, "money_path",
        "You like the idea, but the money side decides it. You push on cost and want a way "
        "to pay that works for you; once you see one, you can say yes on the call.",
        "As soon as I know how I would pay for it.",
        (("F1", 2.6), ("F2", 3.3), ("F3", 5.3)),
        (
            ("F3", (("pays_off", 0.174), ("alternatives", 0.156))),
            ("F2", (("schedule", 0.196), ("unavailable_now", 0.135))),
            ("F1", (("fee_high", 0.300), ("cannot_afford", 0.289))),
            ("F4", (("wants_time", 0.210), ("no_need", 0.066))),
        ),
        signals=("N-SIG-PLAN", "N-SIG-DISCOUNT"),
    ),
    Temperament(
        "steady_enquirer", "Steady enquirer", 0.29, ((2, 1.0),),
        (("F3", 0.49), ("F2", 0.23), ("F1", 0.03)),
        (("F3", "unsure it matches goals"), ("F2", "unavailable to take the next step"),
         ("F1", "cannot afford it now")),
        "wants_time_or_no_need", Level.STRONG, 2, "schedule_or_format_clarity",
        "You are calm and curious, and ask practical questions about how this would fit "
        "around your job. Once that is clear, you are open to going ahead.",
        "Once I know how it would fit around my job.",
        (("F1", 2.8), ("F2", 3.8), ("F3", 3.0)),
        (
            ("F3", (("alternatives", 0.095), ("confirm_fit", 0.080))),
            ("F2", (("unavailable_now", 0.193), ("schedule", 0.041))),
            ("F1", (("cannot_afford", 0.014), ("fee_high", 0.010))),
            ("F4", (("no_need", 0.099), ("wants_time", 0.087))),
        ),
        signals=("N-SIG-FORMAT",),
    ),
    Temperament(
        "time_blocked", "Time blocked", 0.10, ((2, 0.6), (3, 0.4)),
        (("F2", 0.81), ("F3", 0.51), ("F1", 0.03)),
        (("F2", "unavailable to take the next step"), ("F3", "unsure it matches goals"),
         ("F1", "cannot afford it now")),
        "wants_time", Level.MEDIUM, 2, "timing",
        "Work is very heavy right now; you like the idea but cannot start anything new soon.",
        "Not soon, honestly; work is too heavy right now.",
        (("F1", 4.8), ("F2", 2.1), ("F3", 3.7)),
        (
            ("F3", (("alternatives", 0.111), ("confirm_fit", 0.103))),
            ("F2", (("unavailable_now", 0.436), ("schedule", 0.378))),
            ("F1", (("cannot_afford", 0.023), ("fee_high", 0.002))),
            ("F4", (("wants_time", 0.251), ("no_need", 0.092))),
        ),
    ),
)
TEMPERAMENT_BY_ID = {item.id: item for item in TEMPERAMENTS}


def pick_temperament(persona_id: str, seed: str, override: str | None = None) -> Temperament:
    if override in TEMPERAMENT_BY_ID:
        return TEMPERAMENT_BY_ID[override]
    digest = hashlib.sha256(f"temperament:{persona_id}:{seed}".encode()).digest()
    value = int.from_bytes(digest[:8], "big") / 2**64
    cumulative = 0.0
    for item in TEMPERAMENTS:
        cumulative += item.weight
        if value < cumulative:
            return item
    return TEMPERAMENTS[-1]


def plan_families(temperament: Temperament, seed: str) -> tuple[str, ...]:
    """Plan which families she raises and their order.

    Wording, markers and the graded meaning of each family are unchanged.
    """
    prefix = f"plan:{temperament.id}:{seed}"
    digest = hashlib.sha256(prefix.encode()).digest()
    values = iter(int.from_bytes(digest[i:i + 8], "big") / 2**64 for i in range(0, 32, 8))

    def draw(weights: tuple[tuple[object, float], ...]) -> object:
        target = next(values) * sum(weight for _, weight in weights)
        for item, weight in weights:
            target -= weight
            if target < 0:
                return item
        return weights[-1][0]

    count = int(draw(temperament.count_weights))
    remaining = list(temperament.family_weights)
    chosen = []
    for _ in range(count - 1):
        family = draw(tuple(remaining))
        chosen.append(family)
        remaining = [(name, weight) for name, weight in remaining if name != family]
    minutes = dict(temperament.family_minutes)
    chosen.sort(key=lambda family: (minutes[family], ("F3", "F2", "F1").index(family)))
    return (*chosen, "F4")


def pick_themes(
    temperament: Temperament, seed: str, families: tuple[str, ...],
) -> tuple[tuple[str, str], ...]:
    """Pick independently from ranked themes; never change which families are raised."""
    picks = []
    for family in families:
        weights = dict(temperament.theme_weights)[family]
        digest = hashlib.sha256(f"theme:{temperament.id}:{seed}:{family}".encode()).digest()
        target = int.from_bytes(digest[:8], "big") / 2**64 * sum(w for _, w in weights)
        for theme, weight in weights:
            target -= weight
            if target < 0:
                break
        picks.append((family, theme))
    return tuple(picks)
