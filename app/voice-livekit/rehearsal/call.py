"""One rehearsal call: a simulated advisor against the real learner, through the real hooks.

The learner side is not re-implemented here.  ``tests.test_r1_integration.Rig`` drives a real
``R1Interview`` the way livekit-agents 1.6.4 drives it in production: a final transcript, then
``on_user_turn_completed`` (the plan), ``speech_created``, ``llm_node`` (the context filter, the
guarded stream, the intent tail), and ``conversation_item_added`` with what was delivered
(``record_spoken``).  This module only supplies the other voice, the clock and the bookkeeping:

1. the advisor simulator speaks (its words become the candidate's final transcript);
2. the modelled clock advances (``clock.TurnTimingModel``), so the role-play seconds R, and with
   them the schedule, the close window, the time cue and the 19:00 stall, behave as on a call;
3. the learner answers through the production code path with ``deps.provider`` (the production
   DeepSeek client, or the offline fake); the raw model text before the guard is kept;
4. the call stops on the engine's own end conditions (hard cap, early exit after a resolved
   commitment, a farewell exit) and never keeps talking after the advisor said goodbye.

The returned record is JSON: rows in the database export schema (so every row metric also runs
on a real session), one entry per exchange (advisor tags, the learner's plan, raw text, latency,
tokens), the engine's administration log, the guard trips, the events the API would receive, the
metrics and the hard fails.  Only the interviewer phases are outside this tier (dead air, the
double goodbye, the name fallback and the wrap-up wording need the full flow).
"""
from __future__ import annotations

import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping

from rehearsal import HARNESS_VERSION
from rehearsal.advisor import AdvisorTurn
from rehearsal.clock import TurnTimingModel
from rehearsal.llm import (
    BudgetExceeded,
    InsufficientBalance,
    Ledger,
    RecordingProvider,
    Scrubber,
    describe_error,
)
from rehearsal.metrics import call_metrics, hard_fails
from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_scheduler import PLAN_VERSION
from r1_text import fuzzy_contains, word_count
from r1_world import WORLD_VERSION

DEFAULT_CANDIDATE_NAMES = ("Rohan", "Sneha", "Vikram", "Anita", "Arjun", "Divya")
SILENT_TURN = "Mm-hmm."
FAREWELL_STOP = 2


@dataclass(frozen=True)
class CallSpec:
    """Which learner meets which advisor level, and how often it was repeated."""

    persona_id: str
    persona_variant: str = "v1"
    advisor_level: str = "strong"
    rep: int = 0
    candidate_name: str = "Rohan"
    max_exchanges: int = 86

    @property
    def seed(self) -> str:
        return f"{self.persona_id}-{self.persona_variant}-{self.advisor_level}-{self.rep}"

    @property
    def call_id(self) -> str:
        return self.seed


@dataclass
class CallDeps:
    """Everything a call needs from the outside (the live or the offline implementations)."""

    provider: Callable[[list], Any]
    advisor: Any
    judge_runner: Callable[[list], Any] | None = None
    ledger: Ledger = field(default_factory=Ledger)
    scrub: Callable[[object], str] = field(default_factory=Scrubber)
    offline: bool = True
    models: dict[str, Any] = field(default_factory=dict)
    on_advisor_turn: Callable[[Mapping[str, Any]], None] | None = None
    rubric: Any = None
    capture_logs: bool = True


@lru_cache(maxsize=1)
def git_sha() -> str:
    """The checkout's commit (best effort; empty when git is unavailable)."""
    here = Path(__file__).resolve().parent
    try:
        out = subprocess.run(
            ["git", "-C", str(here), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def _plan_summary(plan: Any, spoken: str | None) -> dict[str, Any]:
    delivered_commitment = bool(
        plan.resolves_commitment
        and plan.commitment_level is not None
        and plan.scripted_text
        and spoken
        and fuzzy_contains(spoken, plan.scripted_text)
    )
    summary: dict[str, Any] = {
        "mode": plan.mode.value,
        "reasons": list(plan.reasons),
        "move_id": plan.move_id,
        "negotiation_id": plan.negotiation_id,
        "commitment_level": None if plan.commitment_level is None else plan.commitment_level.name,
        "resolves": bool(plan.resolves_commitment),
        "aside": bool(plan.aside),
        "delivered_commitment": delivered_commitment,
    }
    if plan.intent is not None:
        summary["intent_kind"] = plan.intent.kind
        summary["intent_forced"] = bool(plan.intent.forced)
        summary["fallback_appended"] = bool(spoken) and any(
            spoken.endswith(variant) for variant in plan.intent.fallbacks
        )
    return summary


def _log_counts(lines: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for line in lines:
        kind = str(line.get("error_type") or "")
        if kind.startswith("r1_") and kind not in ("r1_turn_plan",):
            counts[kind] = counts.get(kind, 0) + 1
    return counts


async def run_call(spec: CallSpec, deps: CallDeps) -> dict[str, Any]:
    """Run one call and return its record (never raises: failures are recorded in it)."""
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    record: dict[str, Any] = {
        "header": {
            "harness_version": HARNESS_VERSION,
            "git_sha": git_sha(),
            "content_sha256": CONTENT_SHA256,
            "content_version": CONTENT_VERSION,
            "world_version": WORLD_VERSION,
            "plan_version": PLAN_VERSION,
            "persona_id": spec.persona_id,
            "persona_variant": spec.persona_variant,
            "advisor_level": spec.advisor_level,
            "seed": spec.seed,
            "rep": spec.rep,
            "candidate_name": spec.candidate_name,
            "tier": "rig",
            "offline": deps.offline,
            "models": dict(deps.models),
            "started_at": started_at,
        },
        "rows": [],
        "exchanges": [],
        "admin_log": {},
        "guard_trips": [],
        "posted_events": [],
        "log_counts": {},
        "stop_reason": None,
        "error": None,
        "roleplay_seconds": None,
    }
    wall_started = time.perf_counter()
    try:
        await _drive(spec, deps, record)
    except InsufficientBalance:
        record["stop_reason"] = "insufficient_balance"
    except BudgetExceeded:
        record["stop_reason"] = "budget_exceeded"
    except Exception as exc:  # noqa: BLE001 - a broken call is a result, not a crash
        record["stop_reason"] = "exception"
        record["error"] = describe_error(exc, deps.scrub, 300)
    record["wall_seconds"] = round(time.perf_counter() - wall_started, 2)
    try:
        record["metrics"] = call_metrics(record)
        record["hard_fails"] = hard_fails(record["metrics"])
    except Exception as exc:  # noqa: BLE001
        record["metrics"] = {"error": describe_error(exc, deps.scrub, 300)}
        record["hard_fails"] = ["metrics_failed"]
    if deps.rubric is not None and record["exchanges"] and not record["error"]:
        try:
            record["judge"] = await deps.rubric.judge(record)
        except (InsufficientBalance, BudgetExceeded) as exc:
            record["judge"] = {"error": type(exc).__name__}
        except Exception as exc:  # noqa: BLE001
            record["judge"] = {"error": describe_error(exc, deps.scrub, 200)}
    return record


async def _drive(spec: CallSpec, deps: CallDeps, record: dict[str, Any]) -> None:
    # The fakes live with the tests; they are imported lazily so that importing this module
    # (and the metrics, the scorecard ...) needs neither the SDK nor the test package.
    from tests.test_r1_core import capture_r1_logs
    from tests.test_r1_integration import P1_CONTEXT, Rig

    context = {
        **P1_CONTEXT,
        "first_name": spec.candidate_name,
        "attempt_id": spec.seed,
        "attempt": {"persona_id": spec.persona_id, "persona_variant": spec.persona_variant},
    }
    recorder = RecordingProvider(deps.provider, deps.ledger, scrub=deps.scrub)
    timing = TurnTimingModel(spec.seed)
    with capture_r1_logs() as lines:
        rig = Rig(context, judge=deps.judge_runner, provider=recorder)
        try:
            await _play(spec, deps, record, rig, recorder, timing)
        finally:
            # Whatever happened, keep what the call produced so far.
            try:
                _collect(rig, record)
            except Exception as exc:  # noqa: BLE001 - never mask the call's own failure
                record["collect_error"] = describe_error(exc, deps.scrub, 200)
            record["log_counts"] = _log_counts(list(lines))


async def _play(
    spec: CallSpec,
    deps: CallDeps,
    record: dict[str, Any],
    rig: Any,
    recorder: RecordingProvider,
    timing: TurnTimingModel,
) -> None:
    record["header"]["persona_variant"] = rig.persona.variant_id
    await rig.start_roleplay()
    pickup = rig.writer.saved[0]["text"] if rig.writer.saved else ""
    await deps.advisor.start(pickup)
    learner_last: str | None = None
    farewells = 0
    for number in range(1, spec.max_exchanges + 1):
        if deps.ledger.fatal == "insufficient_balance":
            record["stop_reason"] = "insufficient_balance"
            return
        r_before = float(rig.machine.roleplay_elapsed)
        turn: AdvisorTurn = await deps.advisor.next_turn(learner_last, r_before, number)
        said = turn.text if re.search(r"[A-Za-z0-9]", turn.text) else SILENT_TURN
        if deps.on_advisor_turn is not None:
            deps.on_advisor_turn({**turn.as_dict(), "text": said})
        exchange = await _exchange(rig, recorder, timing, deps, number, turn, said)
        record["exchanges"].append(exchange)
        spoken = exchange["learner"]["spoken"]
        learner_last = spoken if spoken is not None else "..."
        if turn.intent == "farewell":
            farewells += 1
        stop = _stop_reason(rig, farewells)
        if stop:
            record["stop_reason"] = stop
            return
    record["stop_reason"] = "max_exchanges"


def _collect(rig: Any, record: dict[str, Any]) -> None:
    """The engine's final log, the rows and the events, from whatever state the call reached."""
    elapsed = float(rig.machine.roleplay_elapsed)
    admin = rig.engine.admin_log(final=True, r_end=elapsed)
    record["roleplay_seconds"] = round(elapsed, 1)
    record["admin_log"] = admin
    record["guard_trips"] = [dict(trip) for trip in rig.interview._guard_trips]
    record["rows"] = _rows(rig, record["exchanges"])
    record["posted_events"] = _posted(rig, admin)
    record["header"]["learner_first_name"] = rig.persona.first_name


async def _exchange(
    rig: Any,
    recorder: RecordingProvider,
    timing: TurnTimingModel,
    deps: CallDeps,
    number: int,
    turn: AdvisorTurn,
    said: str,
) -> dict[str, Any]:
    advisor_words = word_count(said)
    speak = timing.advisor_speak(advisor_words)
    endpoint = timing.endpoint()
    rig.session.emit("user_state_changed", SimpleNamespace(new_state="speaking"))
    rig.clock.advance(speak)
    rig.session.emit("user_state_changed", SimpleNamespace(new_state="listening"))
    previous = rig.interview._last_reply
    recorder.take()
    spoken = await rig.converse(said, advance=endpoint, provider=recorder)
    await rig.flush()
    r_plan = float(rig.machine.roleplay_elapsed)
    calls = recorder.take()
    reply = rig.interview._last_reply
    plan = reply.plan if (reply is not None and reply is not previous) else None
    learner: dict[str, Any] = {
        "spoken": spoken,
        "raw": "".join(call["raw"] for call in calls),
        "model_calls": len(calls),
        "errors": [call["error"] for call in calls if call["error"]],
        "latency": {
            "first_token": _first(calls, "first_token"),
            "total": _first(calls, "total"),
        },
        "tokens": _tokens(calls),
        "plan": _plan_summary(plan, spoken) if plan is not None else None,
        "suppressed": None,
    }
    if spoken is None:
        learner["suppressed"] = _suppressed_why(rig)
    measured = learner["latency"]["total"] if not deps.offline else None
    after = timing.after_learner(word_count(spoken or ""), measured)
    rig.clock.advance(after)
    return {
        "n": number,
        "r_sec": round(r_plan, 1),
        "advisor": {**turn.as_dict(), "text": said, "words": advisor_words},
        "learner": learner,
        "clock": {
            "advisor_speak_s": round(speak, 1),
            "endpoint_s": round(endpoint, 1),
            "after_learner_s": round(after, 1),
        },
    }


def _first(calls: list[dict[str, Any]], key: str) -> float | None:
    for call in calls:
        value = call.get(key)
        if isinstance(value, (int, float)):
            return round(float(value), 3)
    return None


def _tokens(calls: list[dict[str, Any]]) -> dict[str, int]:
    total = {"prompt": 0, "cached": 0, "completion": 0}
    for call in calls:
        for key, value in (call.get("usage") or {}).items():
            total[key] = total.get(key, 0) + int(value)
    return total


def _suppressed_why(rig: Any) -> str:
    interview = rig.interview
    if rig.engine.exit_requested:
        return "farewell_exit"
    if rig.engine.end_confirmed:
        return "end_request"
    if interview._early_exit_due():
        return "early_exit"
    if rig.machine.roleplay_should_end():
        return "time_cap"
    if getattr(rig.engine, "_asides", None) or getattr(rig.engine, "_end_aside", None):
        return "aside"
    return "other"


def _stop_reason(rig: Any, farewells: int) -> str | None:
    interview = rig.interview
    if rig.engine.exit_requested:
        return "farewell_exit"
    if rig.engine.end_confirmed:
        return "end_request"  # the candidate_left close (owner test 7f2a25e6)
    if interview._early_exit_due():
        return "early_exit"
    if rig.machine.roleplay_should_end():
        return "time_cap"
    if farewells >= FAREWELL_STOP:
        return "advisor_farewell"
    return None


def _rows(rig: Any, exchanges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The persisted rows (database export schema), each tagged with its exchange number."""
    rows: list[dict[str, Any]] = []
    exchange = 0
    for saved in sorted(rig.writer.saved, key=lambda item: item["index"]):
        if saved["speaker"] == "candidate" and saved["phase"] == "roleplay":
            exchange += 1
        rows.append(
            {
                "turn_index": saved["index"],
                "phase": saved["phase"],
                "speaker": saved["speaker"],
                "text": saved["text"],
                "interrupted": bool(saved.get("interrupted")),
                "exchange": exchange,
            }
        )
    return rows


def _posted(rig: Any, admin: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The administration rows the API would receive for this call (pins stripped)."""
    from r1_replies import fidelity_events, fidelity_pins

    pins = fidelity_pins(rig.interview.persona_choice)
    events = fidelity_events(admin, pins, rig.interview._guard_trips)
    out = []
    for event in events:
        payload = {k: v for k, v in event["payload"].items() if k != "pins"}
        out.append({**{k: v for k, v in event.items() if k != "payload"}, "payload": payload})
    return out
