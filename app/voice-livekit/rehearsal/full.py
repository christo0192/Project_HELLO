"""One FULL-interview rehearsal call: OPENING to CLOSING through the production phase driver.

``run_full_call`` builds a real ``R1Interview`` on the test fakes (``rehearsal.sim``), runs
``R1Interview.run()`` itself (the driver that speaks L-OPEN, judges the icebreaker's exit, waits for
"ready" or the button in the transition, runs the role-play, the exit, the wrap-up and the close),
and next to it the candidate loop: the phase-aware candidate simulator (``rehearsal.candidate``)
waits for the floor, hears what was said, and speaks through the SDK seams (``SdkDriver``).  Both
run on the virtual clock (``rehearsal.vloop``), so S and R advance as on a call and the whole
interview takes seconds offline.

The record is JSON: the transcript rows in the database export schema (``turn_index``, ``phase``,
``speaker``, ``text``, ``interrupted``, ``turn_started_at_ms``, ``turn_ended_at_ms``, ``ai_voice``,
``ai_played_ms``) with the harness's own columns (``voice`` christy / learner / candidate, ``t_start``,
``t_end``, ``s_sec``, ``r_sec``, the candidate's ground-truth ``act``), the role-play exchanges in the
role-play tier's schema (so every role-play metric and the rubric judge run unchanged), every
candidate turn, the events (button presses), the phase trace the page saw, the engine's
administration log, the administration rows the API would receive, ``session_facts``, the guard
trips and the structured log labels.  ``transcript_text`` renders it one line per turn.
"""
from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable, Mapping

from rehearsal import HARNESS_VERSION
from rehearsal.call import _plan_summary, _suppressed_why, git_sha
from rehearsal.candidate import CandidateSim, ScenarioAdvisor, View, heard_since
from rehearsal.llm import (
    BudgetExceeded,
    InsufficientBalance,
    Ledger,
    RecordingProvider,
    Scrubber,
    describe_error,
)
from rehearsal.metrics import call_metrics, hard_fails
from rehearsal.scenarios import SCENARIOS
from rehearsal.scripted_interviewer import is_learner_prompt
from rehearsal.sim import (
    LEARNER,
    ModelledLatency,
    Runtime,
    SdkDriver,
    build_context,
    build_session,
    build_writer,
    capture_logs,
)
from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_scheduler import PLAN_VERSION
from r1_text import normalize, word_count
from r1_world import WORLD_VERSION

FULL_TIER = "full"
MAX_SESSION_SEC = 2400.0  # virtual seconds: past the residency cap, so the driver ends first
FLOOR_POLL_SEC = 0.1
SPEECH_POLL_SEC = 0.25
NOISY_LOGS = frozenset({"r1_latency", "r1_playback_silence", "r1_turn_plan", "r1_turn_reason"})
VOICE_LABEL = {"interviewer": "christy", "learner": "learner", "candidate": "candidate"}


@dataclass(frozen=True)
class FullCallSpec:
    """Which scenario meets which learner, at which advisor level, and its repetition."""

    scenario: str
    persona_id: str
    persona_variant: str = "v1"
    advisor_level: str | None = None
    rep: int = 0
    candidate_name: str = "Alex"  # the scripted advisor and the manual library call him Alex

    @property
    def level(self) -> str:
        return self.advisor_level or SCENARIOS[self.scenario].level

    @property
    def seed(self) -> str:
        short = self.persona_id.split("_")[0]
        return f"full-{self.scenario}-{self.level}-{short}-{self.persona_variant}-{self.rep}"

    @property
    def call_id(self) -> str:
        return self.seed


@dataclass
class FullDeps:
    """The live or offline implementations a full call needs."""

    make_provider: Callable[[Callable[[], str]], Callable[[list], Any]]
    talker: Any
    advisor: Any
    judge_runner: Callable[[list], Any] | None = None
    runners: dict[str, Callable[[list], Any]] = field(default_factory=dict)
    ledger: Ledger = field(default_factory=Ledger)
    scrub: Callable[[object], str] = field(default_factory=Scrubber)
    offline: bool = True
    models: dict[str, Any] = field(default_factory=dict)
    shadow: Any = None
    rubric: Any = None
    # The call's own scenario when it differs from the registry's (a sampled manual mix).
    scenario: Any = None


def interview_kwargs(deps: FullDeps) -> dict[str, Any]:
    """The ``*_runner`` seams this checkout's ``R1Interview`` accepts (feature detect)."""
    from r1_session import R1Interview

    accepted = set(inspect.signature(R1Interview.__init__).parameters)
    out: dict[str, Any] = {}
    if deps.judge_runner is not None and "judge_runner" in accepted:
        out["judge_runner"] = deps.judge_runner
    for name, runner in deps.runners.items():
        if name in accepted and name not in out:
            out[name] = runner
    return out


def runner_names() -> tuple[str, ...]:
    """Every ``*_runner`` keyword of this checkout's ``R1Interview`` (judge and classifiers ...)."""
    from r1_session import R1Interview

    return tuple(
        name
        for name, parameter in inspect.signature(R1Interview.__init__).parameters.items()
        if name.endswith("_runner") and parameter.kind is inspect.Parameter.KEYWORD_ONLY
    )


async def run_full_call(spec: FullCallSpec, deps: FullDeps) -> dict[str, Any]:
    """Run one whole interview and return its record (never raises: failures are recorded)."""
    scenario = deps.scenario or SCENARIOS[spec.scenario]
    record: dict[str, Any] = {
        "header": {
            "harness_version": HARNESS_VERSION,
            "git_sha": git_sha(),
            "content_sha256": CONTENT_SHA256,
            "content_version": CONTENT_VERSION,
            "world_version": WORLD_VERSION,
            "plan_version": PLAN_VERSION,
            "tier": FULL_TIER,
            "scenario": scenario.name,
            "scenario_title": scenario.title,
            "scenario_tags": list(scenario.tags),
            "ground_truth": ground_truth(scenario),
            "persona_id": spec.persona_id,
            "persona_variant": spec.persona_variant,
            "advisor_level": spec.level,
            "seed": spec.seed,
            "rep": spec.rep,
            "candidate_name": spec.candidate_name,
            "offline": deps.offline,
            "models": dict(deps.models),
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "rows": [],
        "exchanges": [],
        "candidate_turns": [],
        "events": [],
        "phase_trace": [],
        "admin_log": {},
        "admin_events": [],
        "session_facts": None,
        "guard_trips": [],
        "log_counts": {},
        "log_events": [],
        "outcome": None,
        "stop_reason": None,
        "error": None,
        "roleplay_seconds": None,
        "session_seconds": None,
    }
    wall = time.perf_counter()
    try:
        await _drive(spec, deps, record)
    except InsufficientBalance:
        record["stop_reason"] = "insufficient_balance"
    except BudgetExceeded:
        record["stop_reason"] = "budget_exceeded"
    except Exception as exc:  # noqa: BLE001 - a broken call is a result, not a crash
        record["stop_reason"] = record["stop_reason"] or "exception"
        record["error"] = describe_error(exc, deps.scrub, 300)
    record["wall_seconds"] = round(time.perf_counter() - wall, 2)
    _score(record, deps)
    if deps.rubric is not None and record["exchanges"] and not record["error"]:
        try:
            record["judge"] = await deps.rubric.judge(record)
        except (InsufficientBalance, BudgetExceeded) as exc:
            record["judge"] = {"error": type(exc).__name__}
        except Exception as exc:  # noqa: BLE001
            record["judge"] = {"error": describe_error(exc, deps.scrub, 200)}
    return record


def _score(record: dict[str, Any], deps: FullDeps) -> None:
    from rehearsal.full_metrics import phase_checks

    try:
        record["metrics"] = call_metrics(record)
        record["hard_fails"] = hard_fails(record["metrics"])
    except Exception as exc:  # noqa: BLE001
        record["metrics"] = {"error": describe_error(exc, deps.scrub, 300)}
        record["hard_fails"] = ["metrics_failed"]
    try:
        record["phase_checks"] = phase_checks(record)
    except Exception as exc:  # noqa: BLE001
        record["phase_checks"] = {"error": describe_error(exc, deps.scrub, 300), "failed": ["checks_failed"]}


async def _drive(spec: FullCallSpec, deps: FullDeps, record: dict[str, Any]) -> None:
    from r1_session import R1Interview
    from tests.test_r1_integration import P1_CONTEXT

    loop = asyncio.get_running_loop()
    scenario = deps.scenario or SCENARIOS[spec.scenario]
    runtime = Runtime(spec.seed, offline=deps.offline)
    session = build_session(runtime)
    ctx = build_context(runtime)
    writer = build_writer(runtime)
    context = {
        **P1_CONTEXT,
        "first_name": spec.candidate_name,
        "attempt_id": spec.seed,
        "attempt": {"persona_id": spec.persona_id, "persona_variant": spec.persona_variant},
    }
    inner = deps.make_provider(lambda: runtime.clocks()[0])
    if deps.offline:
        timing = runtime.timing
        inner = ModelledLatency(
            inner,
            lambda m: timing.offline_learner_llm_sec
            if is_learner_prompt(m)
            else timing.offline_interviewer_llm_sec,
        )
    recorders = {
        "learner": RecordingProvider(inner, deps.ledger, scrub=deps.scrub, role="learner"),
        "interviewer": RecordingProvider(inner, deps.ledger, scrub=deps.scrub, role="interviewer"),
    }
    kwargs = interview_kwargs(deps)
    record["header"]["runners"] = sorted(kwargs)
    with capture_logs(loop.time) as lines:
        interview = R1Interview(ctx, context, session, writer, clock=loop.time, **kwargs)
        runtime.interview = interview
        driver = SdkDriver(runtime, session, ctx, recorders)
        candidate = CandidateSim(
            scenario,
            deps.talker,
            ScenarioAdvisor(deps.advisor, scenario, rewriter=getattr(deps.talker, "rewriter", None)),
            candidate_wps=runtime.timing.candidate_wps,
            advisor_wps=runtime.timing.advisor_wps,
            shadow=deps.shadow,
        )
        candidate.bind(call_names(interview, spec))
        run_task = asyncio.ensure_future(interview.run())
        loop_task = asyncio.ensure_future(_candidate_loop(runtime, driver, candidate, record, run_task))
        try:
            done, _ = await asyncio.wait(
                {run_task, loop_task}, timeout=MAX_SESSION_SEC, return_when=asyncio.FIRST_COMPLETED
            )
            if loop_task in done and not run_task.done():
                run_task.cancel()  # the candidate side broke (no balance, budget, a bug): stop
            if not done:
                record["stop_reason"] = "session_cap"
                run_task.cancel()
            await asyncio.gather(run_task, return_exceptions=True)
            if not run_task.cancelled() and run_task.exception() is None:
                record["outcome"] = run_task.result()
            elif not run_task.cancelled():
                raise run_task.exception()  # type: ignore[misc]
        finally:
            if not loop_task.done():
                loop_task.cancel()
            results = await asyncio.gather(loop_task, return_exceptions=True)
            try:
                _collect(runtime, interview, writer, record, lines)
            except Exception as exc:  # noqa: BLE001 - never mask the call's own failure
                record["collect_error"] = describe_error(exc, deps.scrub, 200)
        failure = results[0] if results else None
        if isinstance(failure, BaseException) and not isinstance(failure, asyncio.CancelledError):
            raise failure


def call_names(interview: Any, spec: FullCallSpec) -> dict[str, str]:
    """The names a library text fills in: the learner's first name, two wrong ones, the candidate's."""
    learner = str(getattr(interview.persona, "first_name", "") or "")
    wrong = [name for name in ("Priya", "Neha", "Kavya") if name != learner]
    return {
        "learner": learner,
        "wrong_name": wrong[0],
        "other_wrong_name": wrong[1],
        "candidate": spec.candidate_name,
    }


def ground_truth(scenario: Any) -> dict[str, Any]:
    """What the scenario will do, phase by phase (the tags the checks compare with)."""
    return {
        "style": scenario.style,
        "icebreaker_plan": list(scenario.icebreaker),
        "silent_after_question": scenario.silent_after_question,
        "transition": [beat.act for beat in scenario.transition],
        "press_button": scenario.press_button,
        "roleplay_beats": [{"act": beat.act, "at_r": beat.at_r} for beat in scenario.roleplay],
        "end_answers": [beat.act for beat in scenario.end_answers],
        "price": scenario.price,
        "wrapup": [beat.act for beat in scenario.wrapup],
        "silent_all": scenario.silent_all,
        "expect_complete": scenario.expect_complete,
        "replay_id": scenario.replay_id,
        "mix": scenario.mix,
    }


# ----------------------------------------------------------------------- the candidate loop
async def _candidate_loop(
    rt: Runtime,
    driver: SdkDriver,
    sim: CandidateSim,
    record: dict[str, Any],
    run_task: asyncio.Future,
) -> None:
    since = rt.now()
    waited = 0.0
    while not run_task.done():
        await _wait_floor(rt, sim, driver, rt.rng.reaction(), run_task)
        if run_task.done():
            return
        view = _view(rt, since, waited)
        action = await sim.next_action(view)
        if action.kind == "press":
            sim.pressed = True
            driver.press_ready(action.why or "candidate")
            since, waited = rt.now(), 0.0
            # The page only shows the button while the worker waits for "ready": a press made
            # elsewhere is a no-op there too, so the candidate then waits to hear something.
            await _wait_new_speech(rt, since, 30.0, run_task)
            continue
        if action.kind in ("wait", "silent"):
            limit = None if action.kind == "silent" else action.wait
            heard = await _wait_new_speech(rt, since, limit, run_task)
            waited = 0.0 if heard else waited + (action.wait or 0.0)
            continue
        if not view.heard:
            since_before = since
        else:
            since_before = since
        result = await driver.speak(
            action.text, wps=action.wps, act=action.act, role=action.role, intent=action.intent
        )
        span = result.get("span")
        since = span.t_end if span is not None and span.t_end is not None else rt.now()
        waited = 0.0
        _note_turn(rt, sim, record, action, result, since_before)


async def _wait_floor(
    rt: Runtime, sim: CandidateSim, driver: SdkDriver, reaction: float, run_task: asyncio.Future
) -> None:
    """Until nobody has spoken for ``reaction`` seconds (pressing the button when it is due)."""
    quiet_since: float | None = None
    while not run_task.done():
        playing = rt.now_playing
        if playing is not None:
            phase = rt.interview.machine.phase.value
            if sim.press_due(phase, playing, rt.now() - playing.t_start, rt.now_playing_seconds):
                sim.pressed = True
                driver.press_ready("mid_brief")
        if rt.floor_free:
            if quiet_since is None:
                quiet_since = rt.now()
            if rt.now() - quiet_since >= reaction:
                return
        else:
            quiet_since = None
        await asyncio.sleep(FLOOR_POLL_SEC)


async def _wait_new_speech(
    rt: Runtime, since: float, limit: float | None, run_task: asyncio.Future
) -> bool:
    """Until a bot line that began after ``since`` is over (True), or ``limit`` seconds (False)."""
    started = rt.now()
    while not run_task.done():
        if heard_since(rt.spans, since) and rt.floor_free:
            return True
        if limit is not None and rt.now() - started >= limit:
            return False
        await asyncio.sleep(SPEECH_POLL_SEC)
    return False


def _view(rt: Runtime, since: float, waited: float) -> View:
    interview = rt.interview
    machine = interview.machine
    phase = machine.phase.value
    open_question = None
    resolved = False
    engine = getattr(interview, "_engine", None)
    if engine is not None and phase in ("roleplay", "aside"):
        if getattr(engine, "end_question_open", False):
            open_question = "end"
        elif getattr(engine, "wrap_question_open", False):
            open_question = "wrap"
        resolved = bool(getattr(engine, "commitment_resolved", False))
    return View(
        phase=phase,
        heard=heard_since(rt.spans, since),
        s_sec=float(machine.session_clock),
        r_sec=float(machine.roleplay_elapsed) if machine.roleplay_entered else None,
        roleplay_started=any(span.speaker == "bot" and span.voice == LEARNER for span in rt.spans),
        open_question=open_question,
        commitment_resolved=resolved,
        waited=waited,
        page=dict(rt.page),
    )


def _note_turn(
    rt: Runtime,
    sim: CandidateSim,
    record: dict[str, Any],
    action: Any,
    result: Mapping[str, Any],
    since: float,
) -> None:
    span = result.get("span")
    interview = rt.interview
    turn = {
        "n": len(record["candidate_turns"]) + 1,
        "act": action.act,
        "intent": action.intent,
        "role": action.role,
        "text": action.text,
        "phase": None if span is None else span.phase,
        "t_start": None if span is None else round(span.t_start, 2),
        "t_end": None if span is None or span.t_end is None else round(span.t_end, 2),
        "s_sec": None if span is None else round(span.s_sec, 1),
        "r_sec": None if span is None or span.r_sec is None else round(span.r_sec, 1),
        "suppressed": result.get("why") if result.get("suppressed") else None,
        "reply": result.get("spoken"),
    }
    record["candidate_turns"].append(turn)
    if action.role != "advisor" or action.advisor is None:
        return
    calls = list(result.get("calls") or [])
    spoken = result.get("spoken")
    plan = result.get("plan")
    learner: dict[str, Any] = {
        "spoken": spoken,
        "raw": "".join(call["raw"] for call in calls),
        "model_calls": len(calls),
        "errors": [call["error"] for call in calls if call["error"]],
        "latency": {"first_token": _first(calls, "first_token"), "total": _first(calls, "total")},
        "tokens": _tokens(calls),
        "plan": _plan_summary(plan, spoken) if plan is not None else None,
        "suppressed": None,
    }
    if spoken is None:
        learner["suppressed"] = _suppressed_why(
            SimpleNamespace(engine=interview.engine, machine=interview.machine)
        )
    record["exchanges"].append(
        {
            "n": sim.exchanges,
            "r_sec": turn["r_sec"],
            "advisor": {
                **action.advisor.as_dict(),
                "text": action.text,
                "words": word_count(action.text),
                "act": action.act,
            },
            "learner": learner,
            "clock": {"s_sec": turn["s_sec"], "t_start": turn["t_start"]},
        }
    )


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


# --------------------------------------------------------------------------- collection
def _collect(rt: Runtime, interview: Any, writer: Any, record: dict[str, Any], lines: list) -> None:
    machine = interview.machine
    engine = getattr(interview, "_engine", None)
    record["roleplay_seconds"] = round(float(machine.roleplay_elapsed), 1)
    record["session_seconds"] = round(float(machine.session_clock), 1)
    record["header"]["learner_first_name"] = getattr(interview.persona, "first_name", None)
    record["header"]["persona_variant"] = getattr(interview.persona, "variant_id", record["header"]["persona_variant"])
    if engine is not None:
        record["admin_log"] = engine.admin_log(final=True, r_end=float(machine.roleplay_elapsed))
    record["guard_trips"] = [dict(trip) for trip in getattr(interview, "_guard_trips", [])]
    record["rows"] = transcript_rows(rt, writer)
    record["phase_trace"] = [
        {"phase": item["attributes"]["phase"], "t": item["t"], "s_sec": item["s_sec"]}
        for item in rt.attributes
        if "phase" in item["attributes"]
    ]
    record["page_attributes"] = rt.attributes
    record["events"] = list(rt.events)
    events = []
    for event in getattr(writer, "admin_events", []):
        payload = {k: v for k, v in (event.get("payload") or {}).items() if k != "pins"}
        events.append({**{k: v for k, v in event.items() if k != "payload"}, "payload": payload})
    record["admin_events"] = events
    facts = [event["payload"] for event in events if event.get("event_type") == "session_facts"]
    record["session_facts"] = facts[-1] if facts else None
    counts: dict[str, int] = {}
    kept: list[dict[str, Any]] = []
    for line in lines:
        kind = str(line.get("error_type") or "")
        if not kind.startswith("r1_"):
            continue
        counts[kind] = counts.get(kind, 0) + 1
        if kind in NOISY_LOGS:
            continue
        kept.append(
            {
                "t": line.get("_t"),
                "type": kind,
                "category": line.get("error_category"),
                "phase": line.get("phase"),
            }
        )
    record["log_counts"] = counts
    record["log_events"] = kept
    record["stop_reason"] = record["stop_reason"] or roleplay_end(record, interview)


def roleplay_end(record: Mapping[str, Any], interview: Any) -> str:
    """How the role-play ended: end_request, wrap_accepted, farewell_exit, time_cap, or none."""
    machine = interview.machine
    engine = getattr(interview, "_engine", None)
    if not machine.roleplay_entered:
        return "no_roleplay"
    if engine is not None and getattr(engine, "end_confirmed", False):
        return "end_request"
    if engine is not None and getattr(engine, "exit_requested", False):
        acts = [turn.get("act") for turn in record.get("candidate_turns") or []]
        return "wrap_accepted" if "wrap_accept" in acts else "farewell_exit"
    if machine.roleplay_finished:
        return "time_cap"
    return "stopped"


def transcript_rows(rt: Runtime, writer: Any) -> list[dict[str, Any]]:
    """The persisted rows (database export schema) joined with who spoke when (the spans)."""
    pools: dict[tuple[str, str], list[Any]] = {}
    for span in rt.spans:
        pools.setdefault((span.speaker, normalize(span.text)), []).append(span)
    columns = getattr(writer, "columns", {})
    rows: list[dict[str, Any]] = []
    exchange = 0
    for saved in sorted(writer.saved, key=lambda item: item["index"]):
        speaker = saved["speaker"]
        if speaker == "candidate" and saved["phase"] == "roleplay":
            exchange += 1
        extra = columns.get(saved["index"], {})
        row: dict[str, Any] = {
            "turn_index": saved["index"],
            "phase": saved["phase"],
            "speaker": speaker,
            "text": saved["text"],
            "interrupted": bool(saved.get("interrupted")),
            "turn_started_at_ms": extra.get("started_at_ms"),
            "turn_ended_at_ms": extra.get("ended_at_ms"),
            "ai_voice": extra.get("voice") if speaker == "bot" else None,
            "ai_played_ms": extra.get("played_ms") if speaker == "bot" else None,
            "exchange": exchange,
        }
        pool = pools.get((speaker, normalize(saved["text"])))
        span = pool.pop(0) if pool else None
        voice = row["ai_voice"] or (None if span is None else span.voice)
        if speaker == "candidate":
            voice = "candidate"
        elif voice is None:
            voice = "learner" if saved["phase"] == "roleplay" else "interviewer"
        row["voice"] = VOICE_LABEL.get(voice, voice)
        if span is not None:
            row.update(
                {
                    "t_start": round(span.t_start, 2),
                    "t_end": None if span.t_end is None else round(span.t_end, 2),
                    "s_sec": round(span.s_sec, 1),
                    "r_sec": None if span.r_sec is None else round(span.r_sec, 1),
                    "act": span.act,
                    "intent": span.intent,
                    "source": span.source,
                }
            )
        else:
            row.update({"t_start": extra.get("written_at"), "t_end": None, "s_sec": None, "r_sec": None})
        rows.append(row)
    return rows


# ------------------------------------------------------------------------------ rendering
def _clock(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)):
        return "  -  "
    value = max(0, int(seconds))
    return f"{value // 60:02d}:{value % 60:02d}"


def transcript_text(record: Mapping[str, Any]) -> str:
    """One line per turn (and per button press): phase, S, R, speaker, text."""
    head = record.get("header") or {}
    lines = [
        f"# {head.get('seed')}  scenario={head.get('scenario')}  level={head.get('advisor_level')}  "
        f"persona={head.get('persona_id')}.{head.get('persona_variant')}  "
        f"{'OFFLINE' if head.get('offline') else 'LIVE'}",
        f"# outcome={record.get('outcome')}  role-play end={record.get('stop_reason')}  "
        f"R={_clock(record.get('roleplay_seconds'))}  S={_clock(record.get('session_seconds'))}",
        "# synthetic candidate text; S = interview clock, R = role-play clock",
        "",
    ]
    items: list[tuple[float, int, str]] = []
    for order, row in enumerate(record.get("rows") or []):
        speaker = {"christy": "CHRISTY", "learner": "LEARNER", "candidate": "CANDIDATE"}.get(
            str(row.get("voice")), str(row.get("speaker")).upper()
        )
        act = f" [{row['act']}]" if row.get("act") and row.get("speaker") == "candidate" else ""
        cut = " (cut)" if row.get("interrupted") else ""
        t = row.get("t_start") if isinstance(row.get("t_start"), (int, float)) else float(order)
        r_text = _clock(row.get("r_sec")) if row.get("r_sec") is not None else "  -  "
        items.append(
            (
                float(t),
                order,
                f"[S {_clock(row.get('s_sec'))} | R {r_text}] {str(row.get('phase')):<12} "
                f"{speaker:<9}{act}{cut}: {row.get('text')}",
            )
        )
    for event in record.get("events") or []:
        items.append(
            (
                float(event.get("t") or 0.0),
                -1,
                f"[S {_clock(event.get('s_sec'))} | R {_clock(event.get('r_sec'))}] "
                f"{str(event.get('phase')):<12} -- {event.get('kind')} ({event.get('why', '')})",
            )
        )
    items.sort(key=lambda item: (item[0], item[1]))
    lines.extend(item[2] for item in items)
    return "\n".join(lines) + "\n"
