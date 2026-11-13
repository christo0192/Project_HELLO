"""The full-interview sweep: plan the calls, build their dependencies, run them, write the files.

    python -m rehearsal --full --scenarios manual-replay,strong --calls 12 --out <dir> [--offline]

One sweep runs on ONE virtual-time loop (``rehearsal.vloop``): the interviews' silence windows and
caps take no real time, while a production model call (the learner, Christy, the shadow judge, the
end-intent classifier) takes its real seconds on the clock and a harness call (the simulated
candidate, the rubric judge, the preflight) stands the clock still.

Offline (``--offline``): the scripted candidate (``rehearsal.candidate.ScriptedTalker`` plus
``scripted_advisor``), scripted Christy and learner models (``scripted_interviewer.PhaseRouter``),
the scripted shadow judge.  No key, no network, deterministic.

Live: DeepSeek plays the candidate (``LLMTalker`` to Christy, ``OverlayLLMAdvisor`` or
``ReplayAdvisor`` to the learner); the production clients voice Christy and the learner
(``r1_llm.build_r1_llm`` with the key in a dict), the production judge client runs the shadow judge
and the end-intent classifier.  The account is preflighted and the estimated spend is capped by
``--budget-usd``.  The key is never printed, logged or written.

Files under ``--out``: ``calls/<id>.json`` (the whole record), ``transcripts/<id>.txt`` (one line
per turn), ``results.jsonl`` (one summary line per call), ``scorecard.json`` / ``scorecard.md``
(the role-play scorecard plus the per-phase checks) and ``run.json``.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from rehearsal import HARNESS_VERSION
from rehearsal.call import DEFAULT_CANDIDATE_NAMES, git_sha
from rehearsal.full import FullCallSpec, FullDeps, run_full_call, runner_names, transcript_text
from rehearsal.llm import (
    KEY_NAME,
    TOP_UP_MESSAGE,
    HttpxDeepSeek,
    InsufficientBalance,
    Ledger,
    MissingKey,
    ProviderError,
    Scrubber,
    load_api_env,
    make_live_judge_runner,
    make_live_learner_provider,
    preflight,
)
from rehearsal.scenarios import SCENARIOS, parse_scenarios, scenario_persona
from rehearsal.seams import UnknownSeam
from r1_content import CONTENT_SHA256
from r1_personas import PERSONA_IDS

EXIT_OK, EXIT_ERROR, EXIT_NO_KEY, EXIT_NO_BALANCE, EXIT_BUDGET, EXIT_STRICT = 0, 1, 2, 3, 4, 5
ABORT_REASONS = frozenset({"insufficient_balance", "budget_exceeded"})
VARIANTS = ("v1", "v2", "v3")
DEFAULT_CANDIDATE_MODEL = "deepseek-flash"
DEFAULT_JUDGE_MODEL = "deepseek-v4-pro"
FALLBACK_JUDGE_MODEL = "deepseek-flash"


@dataclass
class FullSettings:
    offline: bool = False
    scenarios: tuple[str, ...] = ()
    calls: int | None = None  # None: one call per scenario
    learners: tuple[str, ...] = tuple(PERSONA_IDS)
    budget_usd: float = 3.0
    candidate_model: str = DEFAULT_CANDIDATE_MODEL
    judge_model: str = DEFAULT_JUDGE_MODEL
    judge: bool = True
    preflight: bool = True
    out: str = ""
    strict: bool = False


# ------------------------------------------------------------------------------- planning
def plan_full_specs(
    scenarios: Sequence[str], learners: Sequence[str], calls: int | None = None
) -> list[FullCallSpec]:
    """Scenario varies fastest, then the learner persona, then the repetition.

    A scenario that fixes its learner (a manual replay was run against one persona) keeps it.
    """
    parse_scenarios(",".join(scenarios))  # registers the manual library; raises on a bad name
    total = len(scenarios) if calls is None else calls
    specs: list[FullCallSpec] = []
    cycle = len(scenarios) * len(learners)
    for index in range(total):
        name = scenarios[index % len(scenarios)]
        persona = scenario_persona(name) or learners[(index // len(scenarios)) % len(learners)]
        rep = index // cycle if cycle else 0
        specs.append(
            FullCallSpec(
                scenario=name,
                persona_id=persona,
                persona_variant=VARIANTS[rep % len(VARIANTS)],
                rep=rep,
                candidate_name=SCENARIOS[name].candidate_name
                or DEFAULT_CANDIDATE_NAMES[index % len(DEFAULT_CANDIDATE_NAMES)],
            )
        )
    return specs


# --------------------------------------------------------------------------- dependencies
class OfflineFullFactory:
    """Scripted candidate, Christy, learner and judges: no key, no network, deterministic."""

    offline = True

    def __init__(self, settings: FullSettings) -> None:
        self.settings = settings
        self.ledger = Ledger(budget_usd=None)
        self.scrub = Scrubber()

    async def start(self) -> dict[str, Any]:
        return {"mode": "offline"}

    def make(self, spec: FullCallSpec) -> FullDeps:
        from rehearsal.flow_judge import ScriptedFlowJudge
        from rehearsal.judge import ScriptedRubricJudge
        from rehearsal.manual import candidate_parts
        from rehearsal.scripted_interviewer import PhaseRouter, ScriptedInterviewerLLM
        from rehearsal.scripted_learner import ScriptedLearnerLLM, ScriptedShadowJudge
        from rehearsal.seams import scripted_runners

        parts = candidate_parts(
            spec.scenario, spec.seed, spec.level, offline=True, candidate_name=spec.candidate_name
        )
        shadow = ScriptedShadowJudge()

        def make_provider(phase_of: Callable[[], str]) -> Callable[[list], Any]:
            return PhaseRouter(
                ScriptedLearnerLLM(spec.seed), ScriptedInterviewerLLM(spec.seed, phase_of)
            )

        # Production runs every model seam by default (the session has an LLM); the fake session
        # has none, so each known seam gets its scripted stand-in here (rehearsal.seams).
        names = [name for name in runner_names() if name != "judge_runner"]
        return FullDeps(
            make_provider=make_provider,
            talker=parts.talker,
            advisor=parts.advisor,
            scenario=parts.scenario,
            judge_runner=shadow,
            make_runners=lambda runtime: scripted_runners(runtime, names),
            seam_mode="scripted",
            ledger=self.ledger,
            scrub=self.scrub,
            offline=True,
            models={"candidate": "scripted", "christy": "scripted", "learner": "scripted"},
            shadow=shadow,
            rubric=ScriptedRubricJudge() if self.settings.judge else None,
            flow_judge=ScriptedFlowJudge() if self.settings.judge else None,
        )

    async def aclose(self) -> None:
        return None


class LiveFullFactory:
    """DeepSeek plays the candidate; the production clients voice Christy and the learner."""

    offline = False

    def __init__(self, settings: FullSettings, env: dict[str, str] | None = None, *, transport: Any = None) -> None:
        from rehearsal.vloop import FrozenClient, real_sleep

        self.settings = settings
        self.env = env if env is not None else load_api_env()
        self.ledger = Ledger(budget_usd=settings.budget_usd)
        self.scrub = Scrubber([self.env[KEY_NAME]])
        # Its retry backoff sleeps in real time: the clock stands still during a harness call.
        self._raw = HttpxDeepSeek(self.env, self.ledger, transport=transport, sleep=real_sleep)
        self.client = FrozenClient(self._raw)  # harness calls stand the interview clock still
        self.judge_model = settings.judge_model
        self._provider: Callable[[list], Any] | None = None
        self._judge_runner: Callable[[list], Any] | None = None
        self._runners: dict[str, Callable[[list], Any]] = {}
        self._session: Any = None  # the running call's session (calls run one at a time)

    async def check(self) -> dict[str, Any]:
        info: dict[str, Any] = {"mode": "live"}
        if self.settings.preflight:
            models = [self.settings.candidate_model]
            if self.settings.judge:
                models.append(self.judge_model)
            info["preflight"] = await preflight(self.client, models)
            judge_state = info["preflight"]["models"].get(self.judge_model)
            if self.settings.judge and judge_state not in (None, "ok"):
                info["judge_model_fallback"] = f"{self.judge_model}: {judge_state}"
                self.judge_model = FALLBACK_JUDGE_MODEL
            state = info["preflight"]["models"].get(self.settings.candidate_model)
            if state not in (None, "ok"):
                raise ProviderError(f"candidate model {self.settings.candidate_model}: {state}")
        return info

    async def start(self) -> dict[str, Any]:
        from rehearsal.vloop import production_runner, production_stream

        from rehearsal.seams import check_seams, seam_client

        check_seams(runner_names())  # an unmapped seam stops here, before any spend
        info = await self.check()
        self._provider = production_stream(
            make_live_learner_provider(self.env, self.ledger, on_error=self._forward_error)
        )
        self._judge_runner = production_runner(make_live_judge_runner(self.env, self.ledger))
        # Every other model seam of this checkout's R1Interview runs on the client it uses in
        # production (rehearsal.seams.SEAM_CLIENTS): the end-intent classifier and the turn reader
        # on R1's judge client (temperature 0), the transition bridge on Christy's own client (the
        # interviewer's settings).  Production reads the key from the process environment; the
        # harness keeps it in a dict, so it hands each seam its client explicitly.
        for name in runner_names():
            if name == "judge_runner":
                continue
            role = name[: -len("_runner")]
            client = seam_client(name)
            self._runners[name] = production_runner(
                make_live_judge_runner(self.env, self.ledger, role=role, client=client)
            )
        info["runners"] = sorted(self._runners)
        info["seam_clients"] = {name: seam_client(name) for name in runner_names()}
        return info

    def _forward_error(self, event: Any) -> None:
        """The learner and Christy client's SDK error events go to the running call's session, as
        AgentSession forwards its LLM's errors (``R1Interview._on_provider_error`` counts them)."""
        session = self._session
        if session is not None:
            session.emit("error", event)

    def bind_session(self, session: Any) -> None:
        self._session = session

    def make(self, spec: FullCallSpec) -> FullDeps:
        from rehearsal.flow_judge import FlowJudge
        from rehearsal.judge import RubricJudge
        from rehearsal.manual import candidate_parts

        assert self._provider is not None and self._judge_runner is not None
        provider = self._provider
        parts = candidate_parts(
            spec.scenario,
            spec.seed,
            spec.level,
            offline=False,
            client=self.client,
            model=self.settings.candidate_model,
            candidate_name=spec.candidate_name,
        )
        return FullDeps(
            make_provider=lambda _phase_of: provider,
            talker=parts.talker,
            advisor=parts.advisor,
            scenario=parts.scenario,
            judge_runner=self._judge_runner,
            runners=dict(self._runners),
            seam_mode="live",
            bind_session=self.bind_session,
            ledger=self.ledger,
            scrub=self.scrub,
            offline=False,
            models={
                "candidate": self.settings.candidate_model,
                "christy": "deepseek-flash (production client)",
                "learner": "deepseek-flash (production client)",
                "rubric_judge": self.judge_model if self.settings.judge else None,
                "flow_judge": self.judge_model if self.settings.judge else None,
            },
            rubric=RubricJudge(self.client, self.judge_model) if self.settings.judge else None,
            flow_judge=FlowJudge(self.client, self.judge_model) if self.settings.judge else None,
        )

    async def aclose(self) -> None:
        await self.client.aclose()


# ------------------------------------------------------------------------------- artifacts
def full_summary(record: dict[str, Any]) -> dict[str, Any]:
    metrics = record.get("metrics") or {}
    header = record["header"]
    checks = record.get("phase_checks") or {}
    return {
        "call_id": header["seed"],
        "tier": header.get("tier"),
        "scenario": header.get("scenario"),
        "scenario_tags": header.get("scenario_tags"),
        "advisor_level": header["advisor_level"],
        "persona_id": header["persona_id"],
        "persona_variant": header["persona_variant"],
        "outcome": record.get("outcome"),
        "roleplay_end": record.get("stop_reason"),
        "phases": checks.get("phases"),
        "start_by": checks.get("start_by"),
        "session_seconds": record.get("session_seconds"),
        "roleplay_seconds": record.get("roleplay_seconds"),
        "exchanges": metrics.get("exchanges"),
        "commitment_level": metrics.get("commitment_level"),
        "families_delivered": metrics.get("families_delivered"),
        "hard_fails": record.get("hard_fails"),
        "phase_checks_failed": checks.get("failed"),
        "flow": flow_line(record),
        "error": record.get("error"),
    }


def flow_line(record: dict[str, Any]) -> dict[str, Any]:
    """The flow judge's per-call scores for ``results.jsonl`` (``status`` n/a offline, or error)."""
    flow = record.get("flow")
    if not flow:
        return {"status": "absent"}
    out: dict[str, Any] = {"status": flow.get("status")}
    if flow.get("status") == "ok":
        out["scores"] = flow.get("scores")
        out["worst_turns"] = [item.get("turn") for item in flow.get("worst_moments") or []]
    elif flow.get("error"):
        out["error"] = flow.get("error")
    return out


def write_full_call(out: Path, record: dict[str, Any], scrub: Callable[[object], str]) -> None:
    """``calls/<id>.json``, ``transcripts/<id>.txt`` and a ``results.jsonl`` line (all scrubbed)."""
    calls, transcripts = out / "calls", out / "transcripts"
    calls.mkdir(parents=True, exist_ok=True)
    transcripts.mkdir(parents=True, exist_ok=True)
    seed = record["header"]["seed"]
    text = scrub(json.dumps(record, indent=1, default=str, ensure_ascii=True))
    (calls / f"{seed}.json").write_text(text, encoding="utf-8", newline="\n")
    (transcripts / f"{seed}.txt").write_text(scrub(transcript_text(record)), encoding="utf-8", newline="\n")
    with (out / "results.jsonl").open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(scrub(json.dumps(full_summary(record), default=str)) + "\n")


def full_progress_line(done: int, total: int, record: dict[str, Any]) -> str:
    head = record["header"]
    checks = record.get("phase_checks") or {}
    failed = checks.get("failed") or []
    return (
        f"[{done}/{total}] {head['scenario']:<18} {head['persona_id'].split('_')[0]}.{head['persona_variant']} "
        f"outcome={record.get('outcome')} rp_end={record.get('stop_reason')} "
        f"S={record.get('session_seconds') or 0:>5.0f}s R={record.get('roleplay_seconds') or 0:>5.0f}s "
        f"checks_failed={failed or 'none'} hard_fails={record.get('hard_fails') or 'none'}"
        + (f" ERROR {record['error']}" if record.get("error") else "")
    )


# --------------------------------------------------------------------------------- driver
async def sweep_full(
    factory: Any, specs: Sequence[FullCallSpec], out: Path, say: Callable[[str], None]
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, spec in enumerate(specs, start=1):
        if factory.ledger.fatal or factory.ledger.over_budget:
            break
        record = await run_full_call(spec, factory.make(spec))
        write_full_call(out, record, factory.scrub)
        records.append(record)
        say(full_progress_line(index, len(specs), record))
        if factory.ledger.fatal:
            break
    return records


async def run_full_all(
    settings: FullSettings,
    out: Path,
    say: Callable[[str], None],
    *,
    factory: Any = None,
) -> int:
    """The whole sweep (run it on a virtual loop: ``vloop.run_virtual``); returns the exit code."""
    from rehearsal.full_metrics import build_full_scorecard, render_full_markdown

    specs = plan_full_specs(settings.scenarios, settings.learners, settings.calls)
    out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    run: dict[str, Any] = {
        "harness_version": HARNESS_VERSION,
        "tier": "full",
        "git_sha": git_sha(),
        "content_sha256": CONTENT_SHA256,
        "settings": asdict(settings),
        "planned_calls": len(specs),
        "stopped": None,
        "message": "",
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    code = EXIT_OK
    records: list[dict[str, Any]] = []
    ledger = Ledger()
    try:
        if factory is None:
            factory = OfflineFullFactory(settings) if settings.offline else LiveFullFactory(settings)
        try:
            run["start"] = await factory.start()
            records = await sweep_full(factory, specs, out, say)
        finally:
            ledger = factory.ledger
            await factory.aclose()
    except MissingKey as exc:
        run["stopped"], run["message"], code = "missing_key", str(exc), EXIT_NO_KEY
    except UnknownSeam as exc:
        run["stopped"], run["message"], code = "unknown_seam", str(exc), EXIT_ERROR
    except InsufficientBalance:
        run["stopped"], run["message"], code = "insufficient_balance", TOP_UP_MESSAGE, EXIT_NO_BALANCE
    except ProviderError as exc:
        run["stopped"], run["message"], code = "provider_error", str(exc), EXIT_ERROR
    if ledger.fatal == "insufficient_balance" and code == EXIT_OK:
        run["stopped"], run["message"], code = "insufficient_balance", TOP_UP_MESSAGE, EXIT_NO_BALANCE
    elif ledger.over_budget and code == EXIT_OK and len(records) < len(specs):
        run["stopped"] = "budget_exceeded"
        run["message"] = f"estimated spend ${ledger.cost_usd:.3f} passed --budget-usd {settings.budget_usd}"
        code = EXIT_BUDGET
    aborted = [r for r in records if r.get("stop_reason") in ABORT_REASONS]
    records = [r for r in records if r.get("stop_reason") not in ABORT_REASONS]
    run["completed_calls"] = len(records)
    run["aborted_calls"] = len(aborted)
    run["wall_seconds"] = round(time.time() - started, 1)
    run["ledger"] = ledger.summary()
    if records:
        card = build_full_scorecard(
            records,
            offline=settings.offline,
            header={"content_sha256": CONTENT_SHA256, "git_sha": git_sha(), "harness_version": HARNESS_VERSION},
        )
        (out / "scorecard.json").write_text(json.dumps(card, indent=1, default=str), encoding="utf-8", newline="\n")
        markdown = render_full_markdown(card, records)
        (out / "scorecard.md").write_text(markdown, encoding="utf-8", newline="\n")
        say("")
        say(markdown)
        if settings.strict and code == EXIT_OK:
            failed = (
                any(r.get("hard_fails") for r in records)
                or bool(card.get("phase_checks_failed"))
                or bool((card.get("flow") or {}).get("gates_failed"))
            )
            code = EXIT_STRICT if failed else EXIT_OK
    (out / "run.json").write_text(json.dumps(run, indent=1, default=str), encoding="utf-8", newline="\n")
    if run["stopped"]:
        say(f"STOPPED: {run['stopped']}. {run['message']}")
        say(f"{len(records)} of {len(specs)} planned calls finished; partial results are in {out}")
    else:
        say(f"Done: {len(records)} full calls in {run['wall_seconds']} s. Artifacts: {out}")
    return code
