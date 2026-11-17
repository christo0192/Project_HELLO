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
import os
import statistics
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence
from unittest.mock import patch

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
    spec_reply: str = "env"
    spec_hold: bool = False


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

        from rehearsal.seams import STREAM_SEAMS, check_seams, seam_client

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
            if name in STREAM_SEAMS:
                self._runners[name] = production_stream(
                    make_live_learner_provider(self.env, self.ledger)
                )
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
        "advisor_farewell_loop": metrics.get("advisor_farewell_loop"),
        "hard_fails": record.get("hard_fails"),
        "phase_checks_failed": checks.get("failed"),
        "flow": flow_line(record),
        "spec_reply": record.get("spec_reply"),
        "error": record.get("error"),
    }


def strict_failures(
    settings: FullSettings, records: Sequence[dict[str, Any]], card: dict[str, Any]
) -> list[str]:
    """Why ``--strict`` fails this run (empty: it passes).

    ``flow_unjudged``: the flow judge was on for a live run but a call has no verdict (a judge
    error: unreadable JSON twice, a bad model, the budget stop) or no call was judged at all.  A
    gate without a verdict is ``ok: None``, never a pass, so strict must not exit 0 on it.  Offline
    (``n/a``) and ``--no-judge`` runs have no flow gate to pass.
    """
    out: list[str] = []
    if any(r.get("hard_fails") for r in records):
        out.append("hard_fails")
    if card.get("phase_checks_failed"):
        out.append("phase_checks")
    flow = card.get("flow") or {}
    if flow.get("gates_failed"):
        out.append("flow_gates")
    if settings.judge and not settings.offline and records and not flow.get("offline"):
        if flow.get("unjudged") or not flow.get("judged"):
            out.append("flow_unjudged")
    return out


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
    factory: Any, specs: Sequence[FullCallSpec], out: Path, say: Callable[[str], None],
    settings: FullSettings,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, spec in enumerate(specs, start=1):
        if factory.ledger.fatal or factory.ledger.over_budget:
            break
        mode = settings.spec_reply
        env = {} if mode == "env" else {"R1_SPECULATIVE_REPLY": "1" if mode == "on" else "0"}
        with patch.dict(os.environ, env):
            deps = factory.make(spec)
            deps.spec_hold = settings.spec_hold
            record = await run_full_call(spec, deps)
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

    if settings.spec_reply == "both":
        return await run_spec_grid(settings, out, say, factory=factory)
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
    owned_factory = factory is None
    try:
        if factory is None:
            factory = OfflineFullFactory(settings) if settings.offline else LiveFullFactory(settings)
        try:
            run["start"] = await factory.start()
            records = await sweep_full(factory, specs, out, say, settings)
        finally:
            ledger = factory.ledger
            if owned_factory:
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
            code = EXIT_STRICT if strict_failures(settings, records, card) else EXIT_OK
    (out / "run.json").write_text(json.dumps(run, indent=1, default=str), encoding="utf-8", newline="\n")
    if run["stopped"]:
        say(f"STOPPED: {run['stopped']}. {run['message']}")
        say(f"{len(records)} of {len(specs)} planned calls finished; partial results are in {out}")
    else:
        say(f"Done: {len(records)} full calls in {run['wall_seconds']} s. Artifacts: {out}")
    return code


def text_rows(record: dict) -> list:
    """Return speaker and raw text for each row."""
    return [(row.get("voice") or row.get("speaker"), row.get("text"))
            for row in record.get("rows", [])]


def decisions(record: dict) -> tuple:
    """Return the outcome and decision fields for comparison."""
    metrics = record.get("metrics") or {}
    return (record.get("outcome"), record.get("stop_reason"), record.get("hard_fails"),
            (record.get("phase_checks") or {}).get("failed"),
            metrics.get("commitment_level"), metrics.get("families_delivered"))


def compare_records(left: dict, right: dict) -> dict:
    """Compare text and decisions and locate the first text difference."""
    a, b = text_rows(left), text_rows(right)
    first = next((i for i in range(max(len(a), len(b)))
                  if (a[i] if i < len(a) else None) != (b[i] if i < len(b) else None)), None)

    def previous_r(record: dict) -> Any:
        if first is None:
            return None
        return next((row.get("r_sec") for row in reversed(record.get("rows", [])[:first])
                     if row.get("speaker") == "candidate"), None)

    return {"identical_text": first is None,
            "identical_decisions": decisions(left) == decisions(right),
            "first_differing_row": first,
            "previous_candidate_r": [previous_r(left), previous_r(right)]}


def median_reply_gap(record: dict) -> float | None:
    """Return the median candidate-to-learner reply gap."""
    rows = record.get("rows", [])
    gaps = []
    for candidate, learner in zip(rows, rows[1:]):
        end, start = candidate.get("t_end"), learner.get("t_start")
        if (candidate.get("speaker") == "candidate" and learner.get("voice") == "learner"
                and isinstance(end, (int, float)) and isinstance(start, (int, float))):
            gaps.append(start - end)
    return round(statistics.median(gaps), 3) if gaps else None


async def run_spec_grid(
    settings: FullSettings, out: Path, say: Callable, *, factory: Any = None
) -> int:
    """Compare three sides; a supplied factory remains owned and reusable by its caller."""
    from dataclasses import replace

    codes = []
    sides = (("on", "on", False), ("held", "on", True), ("off", "off", False))
    for name, mode, hold in sides:
        side = replace(settings, spec_reply=mode, spec_hold=hold)
        codes.append(await run_full_all(side, out / f"spec-{name}", say, factory=factory))
    rows = []
    for spec in plan_full_specs(settings.scenarios, settings.learners, settings.calls):
        paths = [out / f"spec-{name}" / "calls" / f"{spec.seed}.json" for name, _, _ in sides]
        if not all(path.exists() for path in paths):
            codes.append(EXIT_STRICT)
            continue
        on, held, off = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
        drift = compare_records(held, off)
        if not drift["identical_text"] or not drift["identical_decisions"]:
            codes.append(EXIT_STRICT)
        data = on.get("spec_reply") or {}
        counts = data.get("by_category", {})
        started, adopted = counts.get("started", 0), counts.get("adopted", 0)
        rows.append({"call": spec.seed, "held_vs_off": drift,
                     "on_vs_off": compare_records(on, off), "counts": counts,
                     "started": started, "adopted": adopted,
                     "adoption_rate": adopted / started if started else None,
                     "spec_raw_calls": data.get("spec_raw_calls", 0),
                     "committed": data.get("committed", 0),
                     "uncommitted": data.get("uncommitted", 0),
                     "median_reply_gap": {"on": median_reply_gap(on),
                                          "held": median_reply_gap(held),
                                          "off": median_reply_gap(off)}})
    out.mkdir(parents=True, exist_ok=True)
    (out / "spec_grid.json").write_text(json.dumps(rows, indent=1), encoding="utf-8", newline="\n")
    lines = ["# Speculative reply grid", "",
             "| call | held text/decisions | on text/decisions | first held/on | "
             "previous candidate R on/off | counts | rate | raw/committed/uncommitted | "
             "median gap on/held/off |",
             "|---|---|---|---|---|---|---|---|---|"]
    for row in rows:
        held, on = row["held_vs_off"], row["on_vs_off"]
        lines.append(f"| {row['call']} | {held['identical_text']}/{held['identical_decisions']} | "
                     f"{on['identical_text']}/{on['identical_decisions']} | "
                     f"{held['first_differing_row']}/{on['first_differing_row']} | "
                     f"{on['previous_candidate_r']} | {row['counts']} | {row['adoption_rate']} | "
                     f"{row['spec_raw_calls']}/{row['committed']}/{row['uncommitted']} | "
                     f"{row['median_reply_gap']} |")
    (out / "spec_grid.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return max(codes)
