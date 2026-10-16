"""Replay a real session's advisor turns against the CURRENT learner engine.

The regression fixture of R1-Q: the owner's 4/10 test (session b58c7d9c) as a database export
(``tests/fixtures/r1_owner_b58c7d9c.json``).  Its candidate rows, grouped the way the SDK
delivered them (everything the advisor said between two learner replies is one turn), are fed
through the same ``Rig`` seams as a rehearsal call, with the role-play clock R taken from the
original session's own word counts so the schedule lands where it did on the day: the time cue
at turn 79 and the stall at turn 92.  That call was made under the 14:00 role-play; the engine now
runs a 20:00 one, so the recorded R is stretched onto it (``stretch_14_to_20``, the same
piecewise-linear map the schedule's own constants moved by) and every turn lands in the window it
landed in on the day: the cue between 17:00 and 19:00, the stall after 19:00.  The CLI stretches
by default (``--raw-clock`` replays the recorded R as it is, for a fixture recorded under the
20:00 role-play); the library function only stretches when asked (``clock_map``).  The learner's
side is whatever provider you pass: the offline fake in CI, or ``--live`` for the real model.

    python -m rehearsal.replay [--fixture PATH] [--live] [--raw-clock]

The fake model does not say what the real bot said, so the replayed timeline drifts from the
original after the first divergence; the point is not a line-by-line match but the invariants the
4/10 call broke (see ``tests/test_r1_rehearsal_regression.py``).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping, Sequence

from rehearsal.call import _plan_summary
from rehearsal.clock import TimingParams
from rehearsal.llm import Ledger, RecordingProvider
from rehearsal.metrics import ROLEPLAY, row_metrics, stall_reason_metrics
from r1_text import word_count

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "r1_owner_b58c7d9c.json"
ENDPOINT_SEC = 1.2
LLM_SEC = 2.5
TTS_SEC = 0.9
REACTION_SEC = 3.25
# The 14:00 role-play's R onto the 20:00 one: (old R, new R) at every schedule constant that moved
# (owner decision: the objection deadlines stretch, the end game is anchored to the new end).
# Linear in between, and one second for one second after the old hard end.  Every slope is at
# least 1, so a stretched gap between two turns is never shorter than the recorded one.
ROLEPLAY_14_TO_20: tuple[tuple[float, float], ...] = (
    (0.0, 0.0),
    (210.0, 300.0),  # the F3 fallback opens: 3:30 -> 5:00
    (300.0, 430.0),  # the F3 deadlines: 5:00 -> 7:10
    (450.0, 640.0),  # the F2 deadlines: 7:30 -> 10:40
    (540.0, 780.0),  # the close window opens: 9:00 -> 13:00
    (570.0, 810.0),  # the F1 deadlines: 9:30 -> 13:30
    (600.0, 840.0),  # the early exit and the farewell redirect guard: 10:00 -> 14:00
    (630.0, 930.0),  # the F4 deadlines: 10:30 -> 15:30
    (660.0, 1020.0),  # the time cue: 11:00 -> 17:00
    (780.0, 1140.0),  # the WEAK stall: 13:00 -> 19:00
    (840.0, 1200.0),  # the hard end: 14:00 -> 20:00
)


@dataclass
class ReplayTurn:
    """One advisor turn of the original session and what the engine did with it now."""

    group: int
    candidate_rows: tuple[int, ...]
    advisor_text: str
    old_reply_row: int | None
    old_reply: str | None
    r_sec: float
    spoken: str | None = None
    plan: dict[str, Any] | None = None
    reminder: str | None = None
    mode: str | None = None


def load_fixture(path: Path | None = None) -> dict[str, Any]:
    return json.loads((path or FIXTURE).read_text(encoding="utf-8"))


def advisor_groups(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The role-play candidate rows grouped per learner reply, with the original reply."""
    groups: list[dict[str, Any]] = []
    pending: list[Mapping[str, Any]] = []
    for row in sorted(rows, key=lambda item: item["turn_index"]):
        if row.get("phase") != ROLEPLAY:
            continue
        if row["speaker"] == "candidate":
            pending.append(row)
        elif pending:
            groups.append(
                {
                    "rows": tuple(int(item["turn_index"]) for item in pending),
                    "text": " ".join(str(item["text"]).strip() for item in pending),
                    "old_reply_row": int(row["turn_index"]),
                    "old_reply": str(row["text"]),
                }
            )
            pending = []
    if pending:
        groups.append(
            {
                "rows": tuple(int(item["turn_index"]) for item in pending),
                "text": " ".join(str(item["text"]).strip() for item in pending),
                "old_reply_row": None,
                "old_reply": None,
            }
        )
    return groups


def stretch_14_to_20(r_sec: float) -> float:
    """``r_sec`` on the 14:00 role-play's clock, moved onto the 20:00 one (``ROLEPLAY_14_TO_20``)."""
    points = ROLEPLAY_14_TO_20
    for (old_lo, new_lo), (old_hi, new_hi) in zip(points, points[1:]):
        if r_sec <= old_hi:
            return new_lo + (r_sec - old_lo) * (new_hi - new_lo) / (old_hi - old_lo)
    old_end, new_end = points[-1]
    return new_end + (r_sec - old_end)


def timeline(
    groups: Sequence[Mapping[str, Any]],
    params: TimingParams | None = None,
    clock_map: Callable[[float], float] | None = None,
) -> list[float]:
    """R at the moment the engine plans each turn, from the ORIGINAL session's word counts.

    advisor speaking + end of turn, then (for the next turn) the original learner reply's
    model time, TTS start, speaking time and the advisor's reaction.  Independent of any
    replayed model, so the schedule is the same whatever the learner says now.  ``clock_map``
    (e.g. ``stretch_14_to_20``) moves each recorded moment onto another role-play clock; the
    recorded R is used as it is without one.
    """
    params = params or TimingParams()
    out: list[float] = []
    clock = 0.0
    for group in groups:
        clock += word_count(group["text"]) / params.advisor_wps + ENDPOINT_SEC
        out.append(clock if clock_map is None else clock_map(clock))
        reply_words = word_count(group["old_reply"] or "")
        clock += LLM_SEC + TTS_SEC + reply_words / params.learner_wps + REACTION_SEC
    return out


async def replay(
    rows: Sequence[Mapping[str, Any]],
    provider: Callable[[list], Any],
    *,
    persona_id: str = "p1_career_switcher",
    persona_variant: str = "v1",
    seed: str = "replay-b58c7d9c",
    candidate_name: str = "Rohan",
    judge_runner: Callable[[list], Any] | None = None,
    params: TimingParams | None = None,
    ledger: Ledger | None = None,
    clock_map: Callable[[float], float] | None = None,
) -> dict[str, Any]:
    """Feed the grouped advisor turns to a fresh interview; return the turns and the rows.

    ``clock_map`` moves the recorded R onto the current role-play's clock (``timeline``); the
    stretch only lengthens the pauses before the advisor speaks, never the speaking itself.
    """
    from tests.test_r1_core import capture_r1_logs
    from tests.test_r1_integration import P1_CONTEXT, Rig

    params = params or TimingParams()
    groups = advisor_groups(rows)
    targets = timeline(groups, params, clock_map)
    ledger = ledger or Ledger()
    recorder = RecordingProvider(provider, ledger)
    context = {
        **P1_CONTEXT,
        "first_name": candidate_name,
        "attempt_id": seed,
        "attempt": {"persona_id": persona_id, "persona_variant": persona_variant},
    }
    turns: list[ReplayTurn] = []
    with capture_r1_logs():
        rig = Rig(context, judge=judge_runner, provider=recorder)
        await rig.start_roleplay()
        for number, (group, target) in enumerate(zip(groups, targets), start=1):
            words = word_count(group["text"])
            speak = words / params.advisor_wps
            idle = target - ENDPOINT_SEC - speak - float(rig.machine.roleplay_elapsed)
            rig.clock.advance(max(0.0, idle))
            rig.session.emit("user_state_changed", SimpleNamespace(new_state="speaking"))
            rig.clock.advance(speak)
            rig.session.emit("user_state_changed", SimpleNamespace(new_state="listening"))
            previous = rig.interview._last_reply
            spoken = await rig.converse(group["text"], advance=ENDPOINT_SEC, provider=recorder)
            await rig.flush()
            reply = rig.interview._last_reply
            plan = reply.plan if (reply is not None and reply is not previous) else None
            turns.append(
                ReplayTurn(
                    group=number,
                    candidate_rows=group["rows"],
                    advisor_text=group["text"],
                    old_reply_row=group["old_reply_row"],
                    old_reply=group["old_reply"],
                    r_sec=round(float(rig.machine.roleplay_elapsed), 1),
                    spoken=spoken,
                    plan=_plan_summary(plan, spoken) if plan is not None else None,
                    reminder=None if plan is None else plan.reminder,
                    mode=None if plan is None else plan.mode.value,
                )
            )
            if rig.interview._roleplay_over() or ledger.fatal:
                break
        admin = rig.engine.admin_log(final=True, r_end=float(rig.machine.roleplay_elapsed))
        saved = [
            {
                "turn_index": item["index"],
                "phase": item["phase"],
                "speaker": item["speaker"],
                "text": item["text"],
                "interrupted": bool(item.get("interrupted")),
            }
            for item in sorted(rig.writer.saved, key=lambda item: item["index"])
        ]
        guard_trips = [dict(trip) for trip in rig.interview._guard_trips]
    return {
        "turns": turns,
        "rows": saved,
        "admin_log": admin,
        "guard_trips": guard_trips,
        "metrics": {**row_metrics(saved), **stall_reason_metrics(admin)},
    }


def render(result: Mapping[str, Any]) -> str:
    lines: list[str] = []
    for turn in result["turns"]:
        plan = turn.plan or {}
        lines.append(
            f"--- {turn.group} (rows {turn.candidate_rows[0]}-{turn.candidate_rows[-1]}, "
            f"R={turn.r_sec:.0f}s) advisor: {turn.advisor_text[:100]}"
        )
        lines.append(f"    then : {turn.old_reply}")
        lines.append(
            f"    now  : [{plan.get('mode')} {plan.get('move_id') or plan.get('negotiation_id') or ''} "
            f"{plan.get('reasons')}] {turn.spoken}"
        )
    metrics = result["metrics"]
    lines.append("")
    lines.append(
        "now: WEAK line {weak_line_count}, deflection {deflection_count}, exact repeats "
        "{exact_repeat_extra}, near repeats {near_repeat_count}, reply words mean "
        "{reply_words_mean:.1f}".format(**{k: metrics[k] or 0 for k in (
            "weak_line_count", "deflection_count", "exact_repeat_extra", "near_repeat_count", "reply_words_mean"
        )})
    )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rehearsal.replay")
    parser.add_argument("--fixture", default=str(FIXTURE))
    parser.add_argument("--live", action="store_true", help="use the real DeepSeek learner (needs balance)")
    parser.add_argument(
        "--raw-clock",
        action="store_true",
        help="replay the recorded R as it is instead of stretching a 14:00 role-play onto the 20:00 one",
    )
    args = parser.parse_args(argv)
    fixture = load_fixture(Path(args.fixture))
    persona = fixture.get("persona") or {}
    ledger = Ledger()
    if args.live:
        from rehearsal.llm import load_api_env, make_live_learner_provider

        provider = make_live_learner_provider(load_api_env(), ledger)
    else:
        from rehearsal.scripted_learner import ScriptedLearnerLLM

        provider = ScriptedLearnerLLM("replay-b58c7d9c")
    result = asyncio.run(
        replay(
            fixture["rows"],
            provider,
            persona_id=persona.get("persona_id", "p1_career_switcher"),
            persona_variant=persona.get("persona_variant", "v1"),
            ledger=ledger,
            clock_map=None if args.raw_clock else stretch_14_to_20,
        )
    )
    print(render(result))
    if ledger.fatal:
        print(f"STOPPED: {ledger.fatal_message}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
