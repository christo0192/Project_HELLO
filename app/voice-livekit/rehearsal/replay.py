"""Replay a real session's advisor turns against the CURRENT learner engine.

The regression fixture of R1-Q: the owner's 4/10 test (session b58c7d9c) as a database export
(``tests/fixtures/r1_owner_b58c7d9c.json``).  Its candidate rows, grouped the way the SDK
delivered them (everything the advisor said between two learner replies is one turn), are fed
through the same ``Rig`` seams as a rehearsal call, with the role-play clock R taken from the
original session's own word counts so the schedule lands where it did on the day: the time cue
at turn 79 and the 13:00 stall at turn 92.  The learner's side is whatever provider you pass: the
offline fake in CI, or ``--live`` for the real model.

    python -m rehearsal.replay [--fixture PATH] [--live]

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
from rehearsal.metrics import ROLEPLAY, row_metrics
from r1_text import word_count

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "r1_owner_b58c7d9c.json"
ENDPOINT_SEC = 1.2
LLM_SEC = 2.5
TTS_SEC = 0.9
REACTION_SEC = 3.25


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


def timeline(
    groups: Sequence[Mapping[str, Any]], params: TimingParams | None = None
) -> list[float]:
    """R at the moment the engine plans each turn, from the ORIGINAL session's word counts.

    advisor speaking + end of turn, then (for the next turn) the original learner reply's
    model time, TTS start, speaking time and the advisor's reaction.  Independent of any
    replayed model, so the schedule is the same whatever the learner says now.
    """
    params = params or TimingParams()
    out: list[float] = []
    clock = 0.0
    for group in groups:
        clock += word_count(group["text"]) / params.advisor_wps + ENDPOINT_SEC
        out.append(clock)
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
) -> dict[str, Any]:
    """Feed the grouped advisor turns to a fresh interview; return the turns and the rows."""
    from tests.test_r1_core import capture_r1_logs
    from tests.test_r1_integration import P1_CONTEXT, Rig

    params = params or TimingParams()
    groups = advisor_groups(rows)
    targets = timeline(groups, params)
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
        "metrics": row_metrics(saved),
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
        )
    )
    print(render(result))
    if ledger.fatal:
        print(f"STOPPED: {ledger.fatal_message}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
