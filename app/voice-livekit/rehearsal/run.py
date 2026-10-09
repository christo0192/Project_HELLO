"""The rehearsal CLI: plan the calls, run them, write the artifacts, print the scorecard.

    python -m rehearsal --calls 20 --personas strong,average,weak,pushy,terse --out <dir>
    python -m rehearsal --offline --calls 20 --out <dir>      # scripted, no network, no key
    python -m rehearsal --matrix smoke                         # 4 strong calls, one per learner

``--personas`` names the ADVISOR simulator behaviours (strong, average, weak, pushy or
pushy-discounter, terse or short-answers); ``--learners`` picks the learner personas (default all
four).  Calls are planned advisor-level first, then learner persona, then repetition, so a short
run still meets every advisor level.

Live runs: the key is read from ``app/api/.env`` into a dict (see ``llm``), a preflight checks
``GET /user/balance`` and one tiny chat per model, and a DeepSeek HTTP 402 (no balance) stops the
sweep cleanly with a message and exit code 3 after writing what finished.  The estimated spend is
capped by ``--budget-usd`` (exit code 4).

Artifacts under ``--out``: ``calls/<call-id>.json`` (the whole record), ``results.jsonl`` (one
summary line per call), ``scorecard.json`` / ``scorecard.md`` and ``run.json`` (settings, ledger,
stop reason).  The default ``--out`` is under ``.gsd/`` (gitignored).  Nothing written holds the key.

Exit codes: 0 ok, 1 usage or unexpected error, 2 no key, 3 insufficient balance, 4 budget exceeded,
5 hard fails or failed gates with ``--strict``.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import multiprocessing
import os
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from rehearsal import HARNESS_VERSION
from rehearsal.advisor import ADVISOR_LEVELS
from rehearsal.call import DEFAULT_CANDIDATE_NAMES, CallDeps, CallSpec, git_sha, run_call
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
from rehearsal.scorecard import build_scorecard, diff_markdown, render_markdown
from r1_content import CONTENT_SHA256
from r1_personas import PERSONA_IDS

EXIT_OK, EXIT_ERROR, EXIT_NO_KEY, EXIT_NO_BALANCE, EXIT_BUDGET, EXIT_STRICT = 0, 1, 2, 3, 4, 5
ABORT_REASONS = frozenset({"insufficient_balance", "budget_exceeded"})
LEVEL_ALIASES = {"pushy-discounter": "pushy", "short-answers": "terse", "short": "terse"}
VARIANTS = ("v1", "v2", "v3")
MATRICES = {
    "smoke": {"calls": 4, "levels": ("strong",)},
    "sweep": {"calls": 20, "levels": ADVISOR_LEVELS},
    "confirm": {"calls": 60, "levels": ADVISOR_LEVELS},
}
DEFAULT_JUDGE_MODEL = "deepseek-v4-pro"
DEFAULT_ADVISOR_MODEL = "deepseek-flash"
FALLBACK_JUDGE_MODEL = "deepseek-flash"


@dataclass
class Settings:
    offline: bool = False
    calls: int = 4
    levels: tuple[str, ...] = ADVISOR_LEVELS
    learners: tuple[str, ...] = tuple(PERSONA_IDS)
    jobs: int = 1
    budget_usd: float = 3.0
    advisor_model: str = DEFAULT_ADVISOR_MODEL
    judge_model: str = DEFAULT_JUDGE_MODEL
    judge: bool = True
    preflight: bool = True
    max_exchanges: int = 60
    out: str = ""
    strict: bool = False
    baseline: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


# ------------------------------------------------------------------------------- planning
def parse_levels(text: str) -> tuple[str, ...]:
    levels: list[str] = []
    for token in (part.strip().lower() for part in text.split(",") if part.strip()):
        if token == "all":
            return ADVISOR_LEVELS
        token = LEVEL_ALIASES.get(token, token)
        if token not in ADVISOR_LEVELS:
            raise ValueError(f"unknown advisor level {token!r}; use {', '.join(ADVISOR_LEVELS)}")
        if token not in levels:
            levels.append(token)
    if not levels:
        raise ValueError("no advisor level given")
    return tuple(levels)


def parse_learners(text: str) -> tuple[str, ...]:
    if text.strip().lower() == "all":
        return tuple(PERSONA_IDS)
    chosen: list[str] = []
    for token in (part.strip() for part in text.split(",") if part.strip()):
        matches = [pid for pid in PERSONA_IDS if pid == token or pid.startswith(token)]
        if len(matches) != 1:
            raise ValueError(f"unknown learner persona {token!r}; use {', '.join(PERSONA_IDS)}")
        chosen.append(matches[0])
    if not chosen:
        raise ValueError("no learner persona given")
    return tuple(chosen)


def plan_specs(
    levels: Sequence[str], learners: Sequence[str], calls: int, max_exchanges: int = 60
) -> list[CallSpec]:
    """Advisor level varies fastest, then the learner persona, then the repetition."""
    specs: list[CallSpec] = []
    cycle = len(levels) * len(learners)
    for index in range(calls):
        level = levels[index % len(levels)]
        persona = learners[(index // len(levels)) % len(learners)]
        rep = index // cycle
        specs.append(
            CallSpec(
                persona_id=persona,
                persona_variant=VARIANTS[rep % len(VARIANTS)],
                advisor_level=level,
                rep=rep,
                candidate_name=DEFAULT_CANDIDATE_NAMES[index % len(DEFAULT_CANDIDATE_NAMES)],
                max_exchanges=max_exchanges,
            )
        )
    return specs


def repo_root(start: Path | None = None) -> Path:
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        if (parent / ".git").exists():
            return parent
    return Path.cwd()


def default_out_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return repo_root() / ".gsd" / "milestones" / "R1-Q" / "rehearsal" / "runs" / stamp


# --------------------------------------------------------------------------- dependencies
class OfflineFactory:
    """Scripted learner model, advisor, shadow judge and rubric judge: no key, no network."""

    offline = True

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.ledger = Ledger(budget_usd=None)
        self.scrub = Scrubber()

    async def start(self) -> dict[str, Any]:
        return {"mode": "offline"}

    def make(self, spec: CallSpec) -> CallDeps:
        from rehearsal.judge import ScriptedRubricJudge
        from rehearsal.scripted_advisor import ScriptedAdvisor
        from rehearsal.scripted_learner import ScriptedLearnerLLM, ScriptedShadowJudge

        shadow = ScriptedShadowJudge()
        return CallDeps(
            provider=ScriptedLearnerLLM(spec.seed),
            advisor=ScriptedAdvisor(spec.advisor_level, spec.seed),
            judge_runner=shadow,
            ledger=self.ledger,
            scrub=self.scrub,
            offline=True,
            models={"learner": "scripted", "advisor": "scripted", "judge": "scripted"},
            on_advisor_turn=shadow.set_turn,
            rubric=ScriptedRubricJudge() if self.settings.judge else None,
        )

    async def aclose(self) -> None:
        return None


class LiveFactory:
    """The production learner client, the DeepSeek-played advisor and the rubric judge."""

    offline = False

    def __init__(
        self, settings: Settings, env: dict[str, str] | None = None, *, transport: Any = None
    ) -> None:
        self.settings = settings
        self.env = env if env is not None else load_api_env()
        self.ledger = Ledger(budget_usd=settings.budget_usd)
        self.scrub = Scrubber([self.env[KEY_NAME]])
        self.client = HttpxDeepSeek(self.env, self.ledger, transport=transport)
        self._provider: Callable[[list], Any] | None = None
        self._judge_runner: Callable[[list], Any] | None = None
        self.judge_model = settings.judge_model

    async def check(self) -> dict[str, Any]:
        """The account preflight only (no client is built): balance, then one probe per model."""
        info: dict[str, Any] = {"mode": "live"}
        if self.settings.preflight:
            models = [self.settings.advisor_model]
            if self.settings.judge:
                models.append(self.judge_model)
            info["preflight"] = await preflight(self.client, models)
            judge_state = info["preflight"]["models"].get(self.judge_model)
            if self.settings.judge and judge_state not in (None, "ok"):
                info["judge_model_fallback"] = f"{self.judge_model}: {judge_state}"
                self.judge_model = FALLBACK_JUDGE_MODEL
            advisor_state = info["preflight"]["models"].get(self.settings.advisor_model)
            if advisor_state not in (None, "ok"):
                raise ProviderError(f"advisor model {self.settings.advisor_model}: {advisor_state}")
        return info

    async def start(self) -> dict[str, Any]:
        info = await self.check()
        self._provider = make_live_learner_provider(self.env, self.ledger)
        self._judge_runner = make_live_judge_runner(self.env, self.ledger)
        return info

    def make(self, spec: CallSpec) -> CallDeps:
        from rehearsal.advisor import LLMAdvisor
        from rehearsal.judge import RubricJudge

        assert self._provider is not None and self._judge_runner is not None
        return CallDeps(
            provider=self._provider,
            advisor=LLMAdvisor(self.client, self.settings.advisor_model, spec.advisor_level),
            judge_runner=self._judge_runner,
            ledger=self.ledger,
            scrub=self.scrub,
            offline=False,
            models={
                "learner": "deepseek-flash",
                "learner_temperature": 0.6,
                "judge_temperature": 0.0,
                "advisor": self.settings.advisor_model,
                "rubric_judge": self.judge_model if self.settings.judge else None,
            },
            rubric=RubricJudge(self.client, self.judge_model) if self.settings.judge else None,
        )

    async def aclose(self) -> None:
        await self.client.aclose()


# ------------------------------------------------------------------------------- artifacts
def call_summary(record: dict[str, Any]) -> dict[str, Any]:
    metrics = record.get("metrics") or {}
    header = record["header"]
    return {
        "call_id": header["seed"],
        "advisor_level": header["advisor_level"],
        "persona_id": header["persona_id"],
        "persona_variant": header["persona_variant"],
        "exchanges": metrics.get("exchanges"),
        "roleplay_seconds": record.get("roleplay_seconds"),
        "stop_reason": record.get("stop_reason"),
        "commitment_level": metrics.get("commitment_level"),
        "families_delivered": metrics.get("families_delivered"),
        "weak_line_count": metrics.get("weak_line_count"),
        "hard_fails": record.get("hard_fails"),
        "error": record.get("error"),
    }


def write_call(out: Path, record: dict[str, Any], scrub: Callable[[object], str]) -> None:
    folder = out / "calls"
    folder.mkdir(parents=True, exist_ok=True)
    text = scrub(json.dumps(record, indent=1, default=str, ensure_ascii=True))
    (folder / f"{record['header']['seed']}.json").write_text(text, encoding="utf-8", newline="\n")
    with (out / "results.jsonl").open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(call_summary(record), default=str) + "\n")


def progress_line(done: int, total: int, record: dict[str, Any]) -> str:
    head = record["header"]
    metrics = record.get("metrics") or {}
    fails = record.get("hard_fails") or []
    return (
        f"[{done}/{total}] {head['persona_id'].split('_')[0]}.{head['persona_variant']} x "
        f"{head['advisor_level']:<7} {metrics.get('exchanges', 0):>2} exchanges, "
        f"R={record.get('roleplay_seconds') or 0:>5.0f}s, stop={record.get('stop_reason')}, "
        f"commit={metrics.get('commitment_level')}, families={metrics.get('families_delivered_count')}, "
        f"hard_fails={fails or 'none'}" + (f", ERROR {record['error']}" if record.get("error") else "")
    )


# ---------------------------------------------------------------------- sequential sweep
async def sweep_sequential(
    factory: Any,
    specs: Sequence[CallSpec],
    out: Path,
    say: Callable[[str], None],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, spec in enumerate(specs, start=1):
        if factory.ledger.fatal or factory.ledger.over_budget:
            break
        record = await run_call(spec, factory.make(spec))
        write_call(out, record, factory.scrub)
        records.append(record)
        say(progress_line(index, len(specs), record))
        if factory.ledger.fatal:
            break
    return records


# ---------------------------------------------------------------------- process pool
_PROCESS: dict[str, Any] = {}


def _pool_worker(job: dict[str, Any]) -> dict[str, Any]:
    """One call in a worker process (module-level so it pickles); one loop per process."""
    settings = Settings(**job["settings"])
    settings.preflight = False  # the parent checked the account once
    spec = CallSpec(**job["spec"])
    if "factory" not in _PROCESS:
        _PROCESS["loop"] = asyncio.new_event_loop()
        factory = OfflineFactory(settings) if settings.offline else LiveFactory(settings)
        _PROCESS["factory"] = factory
        _PROCESS["loop"].run_until_complete(factory.start())
    factory = _PROCESS["factory"]
    loop = _PROCESS["loop"]
    record = loop.run_until_complete(run_call(spec, factory.make(spec)))
    out = Path(job["out"])
    write_call(out, record, factory.scrub)
    return {"record": record, "ledger": factory.ledger.summary(), "pid": os.getpid()}


def sweep_pool(
    settings: Settings, specs: Sequence[CallSpec], out: Path, say: Callable[[str], None]
) -> tuple[list[dict[str, Any]], Ledger]:
    records: list[dict[str, Any]] = []
    latest: dict[int, dict[str, Any]] = {}
    total = Ledger(budget_usd=None if settings.offline else settings.budget_usd)
    pending = list(specs)
    settings_dict = asdict(settings)
    with ProcessPoolExecutor(max_workers=settings.jobs, mp_context=multiprocessing.get_context("spawn")) as pool:
        in_flight: set[Any] = set()

        def refill() -> None:
            while pending and len(in_flight) < settings.jobs and not total.fatal and not total.over_budget:
                spec = pending.pop(0)
                job = {"spec": asdict(spec), "settings": settings_dict, "out": str(out)}
                in_flight.add(pool.submit(_pool_worker, job))

        refill()
        while in_flight:
            done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
            for future in done:
                in_flight.discard(future)
                result = future.result()
                records.append(result["record"])
                summary = result["ledger"]
                latest[int(result["pid"])] = summary  # cumulative per worker process
                total = Ledger(budget_usd=total.budget_usd)
                for item in latest.values():
                    total.merge(item)
                say(progress_line(len(records), len(specs), result["record"]))
            refill()
    return records, total


# --------------------------------------------------------------------------------- driver
async def run_all(settings: Settings, out: Path, say: Callable[[str], None]) -> int:
    specs = plan_specs(settings.levels, settings.learners, settings.calls, settings.max_exchanges)
    out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    run: dict[str, Any] = {
        "harness_version": HARNESS_VERSION,
        "git_sha": git_sha(),
        "content_sha256": CONTENT_SHA256,
        "settings": {k: v for k, v in asdict(settings).items() if k != "extra"},
        "planned_calls": len(specs),
        "stopped": None,
        "message": "",
    }
    code = EXIT_OK
    records: list[dict[str, Any]] = []
    ledger = Ledger()
    try:
        if settings.jobs > 1:
            if not settings.offline:
                # Preflight once in the parent so a dead account never starts a pool.
                parent = LiveFactory(settings)
                try:
                    run["preflight"] = await parent.check()
                    settings.judge_model = parent.judge_model  # a fallback applies to every worker
                finally:
                    await parent.aclose()
            records, ledger = sweep_pool(settings, specs, out, say)
        else:
            factory = OfflineFactory(settings) if settings.offline else LiveFactory(settings)
            try:
                run["start"] = await factory.start()
                records = await sweep_sequential(factory, specs, out, say)
            finally:
                ledger = factory.ledger
                await factory.aclose()
    except MissingKey as exc:
        run["stopped"], run["message"], code = "missing_key", str(exc), EXIT_NO_KEY
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
    # A call cut short by the account (402) or the budget is not a result: it stays on disk
    # but is not scored, so it cannot count against the learner.
    aborted = [r for r in records if r.get("stop_reason") in ABORT_REASONS]
    records = [r for r in records if r.get("stop_reason") not in ABORT_REASONS]
    run["completed_calls"] = len(records)
    run["aborted_calls"] = len(aborted)
    run["wall_seconds"] = round(time.time() - started, 1)
    run["ledger"] = ledger.summary()
    card = None
    if records:
        card = build_scorecard(
            records,
            offline=settings.offline,
            header={
                "content_sha256": CONTENT_SHA256,
                "git_sha": git_sha(),
                "harness_version": HARNESS_VERSION,
            },
        )
        (out / "scorecard.json").write_text(
            json.dumps(card, indent=1, default=str), encoding="utf-8", newline="\n"
        )
        markdown = render_markdown(card, records)
        (out / "scorecard.md").write_text(markdown, encoding="utf-8", newline="\n")
        if settings.baseline:
            base = Path(settings.baseline) / "scorecard.json"
            if base.is_file():
                before = json.loads(base.read_text(encoding="utf-8"))
                (out / "diff.md").write_text(diff_markdown(before, card), encoding="utf-8", newline="\n")
        say("")
        say(markdown)
        if settings.strict and code == EXIT_OK:
            failed = any(r.get("hard_fails") for r in records) or any(
                g["status"] == "fail" for g in card["gates"] if g["severity"] == "gate"
            )
            code = EXIT_STRICT if failed else EXIT_OK
    (out / "run.json").write_text(json.dumps(run, indent=1, default=str), encoding="utf-8", newline="\n")
    if run["stopped"]:
        say(f"STOPPED: {run['stopped']}. {run['message']}")
        say(
            f"{len(records)} of {len(specs)} planned calls finished"
            + (f" (+{len(aborted)} cut short, not scored)" if aborted else "")
            + f"; partial results are in {out}"
        )
    else:
        say(f"Done: {len(records)} calls in {run['wall_seconds']} s. Artifacts: {out}")
    return code


# ------------------------------------------------------------------------------------ CLI
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rehearsal",
        description="Simulated advisor calls against the real R1 learner engine.",
    )
    parser.add_argument("--calls", type=int, default=None, help="number of calls (default 4)")
    parser.add_argument(
        "--personas",
        "--advisors",
        dest="advisors",
        default="all",
        help="advisor simulator levels, comma separated: strong,average,weak,pushy,terse or all",
    )
    parser.add_argument("--learners", default="all", help="learner persona ids (or prefixes) or all")
    parser.add_argument("--matrix", choices=sorted(MATRICES), help="preset: smoke (4), sweep (20), confirm (60)")
    parser.add_argument("--out", default="", help="output directory (default under .gsd/, gitignored)")
    parser.add_argument("--offline", action="store_true", help="scripted stand-ins, no key, no network")
    parser.add_argument("--jobs", type=int, default=1, help="worker processes (default 1)")
    parser.add_argument("--budget-usd", type=float, default=3.0, help="stop when the estimate passes it")
    parser.add_argument("--advisor-model", default=DEFAULT_ADVISOR_MODEL)
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--no-judge", action="store_true", help="skip the rubric judge")
    parser.add_argument("--no-preflight", action="store_true", help="skip the balance check and model probe")
    parser.add_argument("--max-exchanges", type=int, default=60)
    parser.add_argument("--baseline", default="", help="a previous run directory: writes diff.md")
    parser.add_argument("--strict", action="store_true", help="exit 5 on any hard fail or failed gate")
    return parser


def settings_from_args(args: argparse.Namespace) -> Settings:
    preset = MATRICES.get(args.matrix or "", {})
    if args.advisors != "all":
        levels = parse_levels(args.advisors)
    elif preset:
        levels = tuple(preset["levels"])
    else:
        levels = ADVISOR_LEVELS
    calls = args.calls if args.calls is not None else int(preset.get("calls", 4))
    if calls < 1:
        raise ValueError("--calls must be at least 1")
    return Settings(
        offline=bool(args.offline),
        calls=calls,
        levels=levels,
        learners=parse_learners(args.learners),
        jobs=max(1, int(args.jobs)),
        budget_usd=float(args.budget_usd),
        advisor_model=args.advisor_model,
        judge_model=args.judge_model,
        judge=not args.no_judge,
        preflight=not args.no_preflight,
        max_exchanges=int(args.max_exchanges),
        out=args.out,
        strict=bool(args.strict),
        baseline=args.baseline,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        settings = settings_from_args(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    out = Path(settings.out) if settings.out else default_out_dir()
    try:
        return asyncio.run(run_all(settings, out, print))
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return EXIT_ERROR
