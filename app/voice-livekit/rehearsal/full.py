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

from rehearsal import HARNESS_VERSION, flags, flow_judge, vloop
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
    barge_in_sec,
    build_context,
    build_session,
    build_writer,
    capture_logs,
    played_part,
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
        """The advisor level the call id names.  A catalogue mix chooses its level per call (from
        the seed), so its id says ``mix``; the realized level is in the record's header."""
        if self.advisor_level:
            return self.advisor_level
        scenario = SCENARIOS[self.scenario]
        return "mix" if scenario.mix else scenario.level

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
    # The whole-transcript conversation-flow judge (``rehearsal.flow_judge``): live, an LLM; offline,
    # a stand-in that answers n/a.
    flow_judge: Any = None
    # The call's own scenario when it differs from the registry's (a sampled manual mix).
    scenario: Any = None
    # Seams built per call from its runtime (the offline stand-ins: ``rehearsal.seams``), and how
    # each seam runs ("live" or "scripted"; a seam passed nothing is "absent").
    make_runners: Callable[[Any], dict[str, Callable[[list], Any]]] | None = None
    spec_hold: bool = False
    seam_mode: str = "scripted"
    # Live: told the running call's session, so the production client's SDK error events reach
    # it as AgentSession forwards them (``R1Interview._on_provider_error``).
    bind_session: Callable[[Any], None] | None = None


def interview_kwargs(
    deps: FullDeps, extra: Mapping[str, Callable[[list], Any]] | None = None
) -> dict[str, Any]:
    """The ``*_runner`` seams this checkout's ``R1Interview`` accepts (feature detect)."""
    from r1_session import R1Interview

    accepted = set(inspect.signature(R1Interview.__init__).parameters)
    out: dict[str, Any] = {}
    if deps.judge_runner is not None and "judge_runner" in accepted:
        out["judge_runner"] = deps.judge_runner
    for name, runner in {**deps.runners, **dict(extra or {})}.items():
        if name in accepted and name not in out:
            out[name] = runner
    return out


def seam_modes(deps: FullDeps, passed: Mapping[str, Any]) -> dict[str, str]:
    """How each model seam of this checkout ran: live, scripted, or absent (off, as with no LLM)."""
    return {name: (deps.seam_mode if name in passed else "absent") for name in runner_names()}


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
    # The level the advisor really played: a catalogue mix samples it per call, and the role-play
    # scorecard groups and gates calls by this header field.
    level = scenario.level if (scenario.mix and not spec.advisor_level) else spec.level
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
            "advisor_level": level,
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
    counters = vloop.clock_counters()
    try:
        await _drive(spec, deps, record)
    except InsufficientBalance:
        record["stop_reason"] = "insufficient_balance"
    except BudgetExceeded:
        record["stop_reason"] = "budget_exceeded"
    except Exception as exc:  # noqa: BLE001 - a broken call is a result, not a crash
        # The collection already named how the role-play stood ("stopped" ...); a call that broke
        # is labelled as broken whatever that was, and the role-play's state is kept beside it.
        record["roleplay_end_at_break"] = record["stop_reason"]
        record["stop_reason"] = "exception"
        record["error"] = describe_error(exc, deps.scrub, 300)
    record["wall_seconds"] = round(time.perf_counter() - wall, 2)
    after = vloop.clock_counters()
    # How this call's clock moved: by real time (production calls, a tripped watchdog) or by jumps.
    # A watchdog trip means a harness call stood the clock still for too long and then let it run.
    record["header"]["clock"] = {
        key: round(after[key] - counters[key], 3) for key in ("watchdog_trips", "real_seconds", "jumped_seconds")
    }
    _score(record, deps)
    if deps.rubric is not None and record["exchanges"] and not record["error"]:
        try:
            record["judge"] = await deps.rubric.judge(record)
        except (InsufficientBalance, BudgetExceeded) as exc:
            record["judge"] = {"error": type(exc).__name__}
        except Exception as exc:  # noqa: BLE001
            record["judge"] = {"error": describe_error(exc, deps.scrub, 200)}
    if deps.flow_judge is not None and record["rows"] and not record["error"]:
        try:
            record["flow"] = await deps.flow_judge.judge(record)
        except (InsufficientBalance, BudgetExceeded) as exc:
            record["flow"] = {"source": "llm", "status": "error", "error": type(exc).__name__}
        except Exception as exc:  # noqa: BLE001
            record["flow"] = {"source": "llm", "status": "error", "error": describe_error(exc, deps.scrub, 200)}
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
    if deps.bind_session is not None:
        deps.bind_session(session)
    ctx = build_context(runtime)
    writer = build_writer(runtime)
    context = {
        **P1_CONTEXT,
        "first_name": spec.candidate_name,
        "attempt_id": spec.seed,
        "attempt": {"persona_id": spec.persona_id, "persona_variant": spec.persona_variant},
    }
    inner = deps.make_provider(lambda: runtime.clocks()[0])
    memo = None
    spec_runner = deps.runners.get("spec_reply_runner")
    if deps.offline:
        from rehearsal.seams import SpecReplyMemo

        timing = runtime.timing
        memo = SpecReplyMemo(inner)
        spec_runner = ModelledLatency(memo.spec_runner, lambda _m: timing.offline_learner_llm_sec)
        inner = ModelledLatency(
            memo.provider,
            lambda m: timing.offline_learner_llm_sec
            if is_learner_prompt(m)
            else timing.offline_interviewer_llm_sec,
        )
    recorders = {
        "learner": RecordingProvider(inner, deps.ledger, scrub=deps.scrub, role="learner"),
        "interviewer": RecordingProvider(inner, deps.ledger, scrub=deps.scrub, role="interviewer"),
    }
    extra = deps.make_runners(runtime) if deps.make_runners is not None else {}
    if spec_runner is not None:
        spec_recorder = RecordingProvider(
            spec_runner, deps.ledger, scrub=deps.scrub, role="spec_reply", clock=loop.time
        )
        recorders["spec_reply"] = spec_recorder
        extra["spec_reply_runner"] = spec_recorder
    kwargs = interview_kwargs(deps, extra)
    record["header"]["runners"] = sorted(kwargs)
    record["header"]["seams"] = seam_modes(deps, kwargs)
    with capture_logs(loop.time) as lines:
        interview = R1Interview(ctx, context, session, writer, clock=loop.time, **kwargs)
        runtime.interview = interview
        driver = SdkDriver(runtime, session, ctx, recorders)
        driver.spec_memo = memo
        driver.hold_adopted = deps.spec_hold
        candidate = CandidateSim(
            scenario,
            deps.talker,
            ScenarioAdvisor(
                deps.advisor, scenario, rewriter=getattr(deps.talker, "rewriter", None), seed=spec.seed
            ),
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
                calls = memo.spec_raw_calls if memo else 0
                committed = memo.committed if memo else 0
                record["spec_reply"].update(spec_raw_calls=calls, committed=committed,
                                            uncommitted=calls - committed)
            except Exception as exc:  # noqa: BLE001 - never mask the call's own failure
                record["collect_error"] = describe_error(exc, deps.scrub, 200)
            talker = deps.talker
            record["candidate_failures"] = {
                "advisor": int(getattr(candidate.advisor, "failures", 0) or 0),
                "talker": int(
                    getattr(talker, "failures", 0)
                    or getattr(getattr(talker, "fallback", None), "failures", 0)
                    or 0
                ),
                "rewriter": int(getattr(getattr(talker, "rewriter", None), "failures", 0) or 0),
            }
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
        "adapt": getattr(scenario, "adapt", None),
        "roleplay_beat_traits": sorted({t for beat in scenario.roleplay for t in getattr(beat, "traits", ())}),
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
        cut = await _wait_floor(rt, sim, driver, rt.rng.reaction(), run_task)
        if run_task.done():
            return
        view = _view(rt, since, waited)
        if cut is not None:
            # The interrupter cuts in over the line that is playing, and its voice cuts that line
            # (voice barge-in, ``SdkDriver.speak(barge_in=True)``).
            playing, heard_part, phase = cut
            action = await sim.interrupt_action(view, phase, heard_part)
            since_before = since
            result = await driver.speak(
                action.text, wps=action.wps, act=action.act, role=action.role, intent=action.intent,
                barge_in=True,
            )
            span = result.get("span")
            ends = [rt.now() if span is None or span.t_end is None else span.t_end]
            if playing.t_end is not None:
                ends.append(playing.t_end)  # the cut line is heard already: never fed again
            since, waited = max(ends), 0.0
            _note_turn(rt, sim, record, action, result, since_before)
            continue
        action = await sim.next_action(view)
        if action.kind == "press":
            since, waited = rt.now(), 0.0
            if not _button_shown(rt):
                # The page shows the button only while the worker waits for "ready" (``awaiting``):
                # a candidate cannot press what is not there.  Recorded, and they say it instead.
                rt.note_event("button_not_shown", why=action.why or "candidate", awaiting=rt.page.get("awaiting"))
                sim.note_button_missing(rt.interview.machine.phase.value)
                continue
            sim.pressed = True
            driver.press_ready(action.why or "candidate")
            await _wait_new_speech(rt, since, 30.0, run_task)
            continue
        if action.kind == "silent":
            # Silence lasts until Christy speaks AGAIN: the line that prompted it (already over,
            # and in the view) must not count, or the "silence" ends at once.
            since, waited = rt.now(), 0.0
            await _wait_new_speech(rt, since, None, run_task)
            continue
        if action.kind == "wait":
            heard = await _wait_new_speech(rt, since, action.wait, run_task)
            waited = 0.0 if heard else waited + (action.wait or 0.0)
            continue
        since_before = since
        if sim.interrupter is not None:
            since = await _speak_watching_cut_ins(rt, driver, sim, record, action, since_before)
            waited = 0.0
            continue
        result = await driver.speak(
            action.text, wps=action.wps, act=action.act, role=action.role, intent=action.intent
        )
        span = result.get("span")
        since = span.t_end if span is not None and span.t_end is not None else rt.now()
        waited = 0.0
        _note_turn(rt, sim, record, action, result, since_before)


async def _speak_watching_cut_ins(
    rt: Runtime, driver: SdkDriver, sim: CandidateSim, record: dict[str, Any], action: Any, since: float
) -> float:
    """The interrupter's turn: the reply to it plays inside ``driver.speak``, so the cut-in is
    watched for while that turn is still waiting on its reply, and said over the reply, which its
    voice cuts (voice barge-in, ``SdkDriver.speak(barge_in=True)``).  Returns the new ``since``."""
    exchange = sim.exchanges
    task = asyncio.ensure_future(
        driver.speak(action.text, wps=action.wps, act=action.act, role=action.role, intent=action.intent)
    )
    cut: tuple[Any, Any, int, float] | None = None
    while not task.done():
        reply = getattr(rt, "reply_playing", None)
        if cut is None and reply is not None and not rt.candidate_speaking:
            phase = rt.interview.machine.phase.value
            played = rt.now() - reply.t_start
            total = float(getattr(rt, "reply_playing_seconds", 0.0) or 0.0)
            current = getattr(driver.session, "current_speech", None)
            interruptible = bool(
                current is not None and not current.done() and getattr(current, "allow_interruptions", False)
            )
            if sim.interrupt_due(phase, reply, played, total, interruptible):
                # Heard since the candidate's own turn ended (not since before it: those lines
                # were already answered, and a live advisor must not be fed them again).
                turn_end = max(
                    (s.t_end for s in rt.spans if s.speaker == "candidate" and s.t_end is not None),
                    default=since,
                )
                view = _view(rt, max(since, turn_end), 0.0)
                second = await sim.interrupt_action(view, phase, _heard_before_cut(reply.text, played, total))
                second_task = asyncio.ensure_future(
                    driver.speak(
                        second.text, wps=second.wps, act=second.act, role=second.role, intent=second.intent,
                        barge_in=True,
                    )
                )
                cut = (second, second_task, sim.exchanges, rt.now())
        await asyncio.sleep(FLOOR_POLL_SEC)
    result = task.result()
    span = result.get("span")
    new_since = span.t_end if span is not None and span.t_end is not None else rt.now()
    _note_turn(rt, sim, record, action, result, since, exchange=exchange)
    if cut is not None:
        second, second_task, second_exchange, started = cut
        second_result = await second_task
        second_span = second_result.get("span")
        ends = [new_since, rt.now() if second_span is None or second_span.t_end is None else second_span.t_end]
        new_since = max(ends)
        _note_turn(rt, sim, record, second, second_result, started, exchange=second_exchange)
    return new_since


def _heard_before_cut(text: str, played: float, total: float) -> str:
    """The part of a line the candidate will have heard when their cut-in's voice cuts it (the
    cut-in starts now, and the line stops ``barge_in_sec`` later: ``SdkDriver.speak``).  At the
    ``min_words`` rollback no voice cuts it, and the part played so far is what was heard."""
    return played_part(text, played + (barge_in_sec() or 0.0), total)


async def _wait_floor(
    rt: Runtime, sim: CandidateSim, driver: SdkDriver, reaction: float, run_task: asyncio.Future
) -> tuple[Any, str, str] | None:
    """Until nobody has spoken for ``reaction`` seconds (pressing the button when it is due).

    Returns None, or ``(span, heard part, phase)`` when the interrupter cuts in over a bot line
    that is still playing (``CandidateSim.interrupt_due``).
    """
    quiet_since: float | None = None
    while not run_task.done():
        playing = rt.now_playing
        if playing is not None:
            phase = rt.interview.machine.phase.value
            played = rt.now() - playing.t_start
            if sim.press_due(phase, playing, played, rt.now_playing_seconds, rt.page):
                sim.pressed = True
                driver.press_ready("mid_brief")
        reply = getattr(rt, "reply_playing", None)
        if reply is not None and not rt.candidate_speaking:
            phase = rt.interview.machine.phase.value
            played = rt.now() - reply.t_start
            total = float(getattr(rt, "reply_playing_seconds", 0.0) or 0.0)
            current = getattr(driver.session, "current_speech", None)
            interruptible = bool(
                current is not None and not current.done() and getattr(current, "allow_interruptions", False)
            )
            if sim.interrupt_due(phase, reply, played, total, interruptible):
                return reply, _heard_before_cut(reply.text, played, total), phase
        if rt.floor_free:
            if quiet_since is None:
                quiet_since = rt.now()
            if rt.now() - quiet_since >= reaction:
                return None
        else:
            quiet_since = None
        await asyncio.sleep(FLOOR_POLL_SEC)
    return None


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


def _button_shown(rt: Runtime) -> bool:
    """The page shows the "I'm ready" button only while the worker waits for it."""
    return rt.page.get("awaiting") == "ready"


# M032 S3 (the learner lane): Christy's question before an in-role close ends the role-play early
# (L-ASIDE-EARLY-CLOSE and its "we still have time" wording) is answered like the offer to wrap
# up, and her question after the learner hung up on abuse (L-ASIDE-HANGUP) gets its own answer.
# Simulation diagnosis 3 (the learner lane, R1_END_ASIDE_V2 and its early-close wording): the
# reworded questions are the same questions, so they are read the same way while those flags are on.
# Diagnosis 5 (the Christy lane, R1_WRAP_OFFER_VARIANT): a later offer to wrap up is
# L-ASIDE-WRAP-AGAIN, the same question in other words, so it is read as "wrap" too.
ASIDE_QUESTIONS = (
    ("end", "L-ASIDE-END"),
    ("end", "L-ASIDE-END-2"),
    ("wrap", "L-ASIDE-WRAP"),
    ("wrap", "L-ASIDE-WRAP-AGAIN"),
    ("wrap", "L-ASIDE-EARLY-CLOSE"),
    ("wrap", "L-ASIDE-EARLY-CLOSE-2"),
    ("wrap", "L-ASIDE-EARLY-CLOSE-TIME"),
    ("hangup", "L-ASIDE-HANGUP"),
)


def aside_texts(rt: Runtime) -> list[tuple[str, str]]:
    """Christy's in-role questions as this call renders them (``(key, normalised text)``), rendered
    once; a line this checkout does not have is left out."""
    cached = getattr(rt, "_aside_texts", None)
    if cached is not None:
        return cached
    out: list[tuple[str, str]] = []
    for key, line_id in ASIDE_QUESTIONS:
        try:
            out.append((key, normalize(rt.interview.render_line(line_id))))
        except Exception:  # noqa: BLE001 - a line this checkout does not have
            continue
    rt._aside_texts = out  # type: ignore[attr-defined]
    return out


def heard_question(rt: Runtime, heard: list[Any]) -> str | None:
    """The in-role question the candidate just HEARD: the last bot line is one of Christy's
    ``ASIDE_QUESTIONS`` ("end", "wrap", "hangup"), as it was said; else None."""
    bots = [span for span in heard if span.speaker == "bot"]
    if not bots or bots[-1].voice == LEARNER:
        return None
    return aside_question_of(rt, bots[-1].text)


def aside_question_of(rt: Runtime, text: str) -> str | None:
    """"end", "wrap" or "hangup" when ``text`` is one of Christy's in-role questions as said
    (``ASIDE_QUESTIONS``), else None."""
    said = normalize(text)
    if not said:
        return None
    for key, line in aside_texts(rt):
        if line and (line in said or (len(said) >= 30 and line.startswith(said))):
            return key
    return None


def _view(rt: Runtime, since: float, waited: float) -> View:
    interview = rt.interview
    machine = interview.machine
    phase = machine.phase.value
    heard = heard_since(rt.spans, since)
    engine_question = None
    engine = getattr(interview, "_engine", None)
    if engine is not None and phase in ("roleplay", "aside"):
        if getattr(engine, "end_question_open", False):
            engine_question = "end"
        elif getattr(engine, "wrap_question_open", False):
            engine_question = "wrap"
    return View(
        phase=phase,
        heard=heard,
        s_sec=float(machine.session_clock),
        r_sec=float(machine.roleplay_elapsed) if machine.roleplay_entered else None,
        roleplay_started=any(span.speaker == "bot" and span.voice == LEARNER for span in rt.spans),
        open_question=heard_question(rt, heard) if phase in ("roleplay", "aside") else None,
        engine_question=engine_question,
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
    *,
    exchange: int | None = None,
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
    if action.traits:
        turn["traits"] = list(action.traits)
    if action.cut_in:
        turn["cut_in"] = True
    if action.answering is not None:
        # What the candidate answered (heard) next to the engine's own flag (cross-check).
        turn["answering"] = action.answering
        turn["engine_question"] = action.engine_question
    record["candidate_turns"].append(turn)
    if action.role != "advisor" or action.advisor is None:
        return
    calls = list(result.get("calls") or [])
    spoken = result.get("spoken")
    plan = result.get("plan")
    learner: dict[str, Any] = {
        "speculative": bool(result.get("speculative")),
        "spoken": spoken,
        "raw": "".join(call["raw"] for call in calls),
        "model_calls": len(calls),
        "errors": [call["error"] for call in calls if call["error"]],
        "latency": {"first_token": _first(calls, "first_token"), "total": _first(calls, "total")},
        "tokens": _tokens(calls),
        "plan": _plan_summary(plan, spoken) if plan is not None else None,
        "suppressed": None,
        # When the engine decided the line (the window checks time it by this, not by the
        # advisor turn's start: ``rehearsal.metrics._learner_r``).
        "r_sec": None if result.get("decided_r_sec") is None else round(float(result["decided_r_sec"]), 1),
    }
    if spoken is None:
        learner["suppressed"] = _suppressed_why(
            SimpleNamespace(engine=interview.engine, machine=interview.machine)
        )
    record["exchanges"].append(
        {
            "n": sim.exchanges if exchange is None else exchange,
            # The engine's own role-play turn after this line (the needs ledger counts these; the
            # harness count drifts when the session splits or joins candidate turns).
            "engine_turn": _engine_turn(interview),
            "r_sec": turn["r_sec"],
            "advisor": {
                **action.advisor.as_dict(),
                "text": action.text,
                "words": word_count(action.text),
                "act": action.act,
                "traits": list(action.traits),
            },
            "learner": learner,
            "clock": {"s_sec": turn["s_sec"], "t_start": turn["t_start"]},
        }
    )


def _engine_turn(interview: Any) -> int | None:
    """The role-play engine's own turn counter (None before the engine exists); never builds one."""
    turn = getattr(getattr(interview, "_engine", None), "turn", None)
    return turn if isinstance(turn, int) and not isinstance(turn, bool) else None


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
    spec_counts: dict[str, int] = {}
    by_phase: dict[str, dict[str, int]] = {}
    for line in lines:
        if line.get("error_type") == "r1_spec_reply":
            category = str(line.get("error_category") or "unknown")
            phase = str(line.get("phase") or "unknown")
            spec_counts[category] = spec_counts.get(category, 0) + 1
            phase_counts = by_phase.setdefault(phase, {})
            phase_counts[category] = phase_counts.get(category, 0) + 1
    summary = {
        str(line.get("error_category")): line.get("option_count")
        for line in lines if line.get("schema") == "summary_spec"
    }
    record["spec_reply"] = {"by_category": spec_counts, "by_phase": by_phase}
    if summary:
        record["spec_reply"]["summary_matches"] = summary == spec_counts
    record["header"]["spec_reply"] = {
        "flag": "on" if getattr(interview, "_spec_enabled", False) else "off",
        "counts": spec_counts,
    }
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
    span_rows: dict[int, int] = {}  # id(span) -> index in ``rows`` of the row it was matched to
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
        if span is not None:
            span_rows[id(span)] = len(rows)
        voice = row["ai_voice"] or (None if span is None else span.voice)
        if speaker == "candidate":
            voice = "candidate"
        elif voice is None:
            voice = "learner" if saved["phase"] == "roleplay" else "interviewer"
        row["voice"] = VOICE_LABEL.get(voice, voice)
        if row["voice"] == "christy" and saved["phase"] in ("aside", "roleplay"):
            # Which in-role question this Christy line is ("end", "wrap", "hangup"; None for any
            # other).
            row["question"] = aside_question_of(rt, saved["text"])
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
            if speaker == "candidate" and flags.on(flags.CONTINUED_ROWS):
                if not _continued_row(row, rows, rt.spans, span_rows):
                    continue  # all of it belonged to turns that already have their rows
        rows.append(row)
    return rows


def _span_timing(span: Any) -> dict[str, Any]:
    return {
        "t_start": round(span.t_start, 2),
        "t_end": None if span.t_end is None else round(span.t_end, 2),
        "s_sec": round(span.s_sec, 1),
        "r_sec": None if span.r_sec is None else round(span.r_sec, 1),
        "act": span.act,
        "intent": span.intent,
        "source": span.source,
    }


def _pieces(words: list[str], spans: list[tuple[Any, list[str]]]) -> list[tuple[Any, int, int]]:
    """The row's words as consecutive runs of the candidate's spoken turns: ``(span, start, end)``."""
    def run(pos: int, said: list[str]) -> int:
        best = 0
        for offset in range(len(said)):
            length = 0
            while (
                pos + length < len(words)
                and offset + length < len(said)
                and said[offset + length] == words[pos + length]
            ):
                length += 1
            best = max(best, length)
        return best

    out: list[tuple[Any, int, int]] = []
    pos, first = 0, 0
    latest = len(spans) - 1
    while pos < len(words):
        # The spoken turn (from the last one used on) that carries the longest run from here; on a tie
        # the LATEST one, since a fragment belongs to the turn in progress (review
        # CONTINUED-ROWS-EARLIEST-SPAN: "Yes." went to the opening sound check).
        scored = [(run(pos, said), index) for index, (_span, said) in enumerate(spans) if index >= first]
        if not scored:
            return []
        best, index = max(scored)
        if not best or (best < 3 and pos + best < len(words)):
            return []
        if best < 3 and index != latest:
            return []  # one or two common words are no evidence for an older turn
        out.append((spans[index][0], pos, pos + best))
        pos, first = pos + best, index
    return out


def _cut(text: str, counts: list[int]) -> list[str]:
    """``text`` cut into parts of ``counts`` normalized words each, keeping its own spelling."""
    tokens = text.split()
    parts: list[list[str]] = [[] for _ in counts]
    index, seen = 0, 0
    for token in tokens:
        if index < len(counts) - 1 and seen >= counts[index]:
            index, seen = index + 1, 0
        parts[index].append(token)
        seen += len(normalize(token).split())
    return [" ".join(part) for part in parts]


def _continued_row(
    row: dict[str, Any], rows: list[dict[str, Any]], spans: list[Any], span_rows: dict[int, int]
) -> bool:
    """D4-H-REPLAY1: a candidate row the session saved without a span is a fragment of a longer spoken
    turn (a ramble, or a turn's tail joined to the next one).  Each part of it that belongs to a turn
    which already has its row is merged into that row (a tail said over the brief joins the icebreaker
    answer); the rest keeps this row, with the timing of the spoken turn it came from (no "S -" row).
    Returns False when nothing is left of this row.  A row that matches no spoken turn is left as is.
    """
    words = normalize(row.get("text")).split()
    written = row.get("t_start")
    said = [
        (span, normalize(span.text).split())
        for span in sorted(spans, key=lambda item: item.t_start)
        if span.speaker == "candidate" and (not isinstance(written, (int, float)) or span.t_start <= written + 1.0)
    ]
    pieces = _pieces(words, said) if words else []
    if not pieces:
        return True
    parts = _cut(str(row.get("text") or ""), [end - start for _span, start, end in pieces])
    kept: list[tuple[Any, str]] = []
    for (span, _start, _end), part in zip(pieces, parts):
        owner = span_rows.get(id(span))
        if owner is not None and part:
            target = rows[owner]
            target["text"] = f"{target['text']} {part}".strip()
            target.setdefault("merged_turn_indexes", []).append(row["turn_index"])
        elif part:
            kept.append((span, part))
    if not kept:
        return False
    row["text"] = " ".join(part for _span, part in kept)
    row.update(_span_timing(kept[0][0]))
    span_rows[id(kept[0][0])] = len(rows)
    return True


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
        speaker = flow_judge.speakers().get(
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
