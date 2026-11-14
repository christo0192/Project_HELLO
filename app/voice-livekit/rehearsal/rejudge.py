"""Judge saved full-interview records again with the current flow judge (D5-JUDGE1).

    python -m rehearsal.rejudge <run dir> [<run dir> ...] --out <dir> [--judge-model M] [--budget-usd 1]

Two rounds scored by different rubrics cannot be compared: round 4 ran with the first rubric and
round 5 with the design rules.  This tool reads every ``calls/*.json`` under each run directory and
asks ONLY the flow judge again (one call per record, no candidate, Christy or learner call), with the
rubric the ``REHEARSAL_FLOW_*`` switches choose now.  The saved records are never written; the report
(``rejudge.json`` and ``rejudge.md`` under ``--out``) puts each run's means before and after side by
side, so both rounds read under one rubric.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from rehearsal import flags
from rehearsal.flow_judge import AXES, flow_scores, flow_summary, rubric_text
from rehearsal.llm import BudgetExceeded, InsufficientBalance, Scrubber, describe_error


def load_runs(dirs: Sequence[Path | str]) -> list[tuple[str, list[dict[str, Any]]]]:
    """Each run directory's saved records (every ``calls/*.json`` under it), in file-name order."""
    runs = []
    for item in dirs:
        root = Path(item)
        paths = sorted((p for p in root.rglob("*.json") if p.parent.name == "calls"), key=lambda p: p.name)
        runs.append((root.name, [json.loads(p.read_text(encoding="utf-8")) for p in paths]))
    return runs


def rubric_info() -> dict[str, Any]:
    text = rubric_text()
    return {
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
        "switches": {
            name: flags.on(name)
            for name in (flags.FLOW_DESIGN_RULES, flags.FLOW_AGENDA_RULES, flags.FLOW_NA_AXES)
        },
    }


def _seed(record: Mapping[str, Any]) -> str:
    return str((record.get("header") or {}).get("seed"))


def judgeable(record: Mapping[str, Any]) -> bool:
    """The in-run rule (``full.py``): only a call with rows and no error was ever flow-judged."""
    return bool(record.get("rows")) and not record.get("error")


async def judge_one(judge: Any, record: Mapping[str, Any], scrub: Callable[[object], str]) -> dict[str, Any]:
    """One verdict; a failed call becomes an error verdict, as in the in-run judge (D5R-REJUDGE-ABORT)."""
    try:
        return await judge.judge(record)
    except (InsufficientBalance, BudgetExceeded) as exc:
        return {"source": "llm", "status": "error", "error": type(exc).__name__}
    except Exception as exc:  # noqa: BLE001
        return {"source": "llm", "status": "error", "error": describe_error(exc, scrub, 200)}


def _run_entry(name: str, records: Sequence[Mapping[str, Any]], after: Sequence[Mapping[str, Any]],
               skipped: Sequence[str]) -> dict[str, Any]:
    done = list(records[: len(after)])
    return {
        "name": name,
        "calls": len(records),
        "done": len(after),
        "skipped": list(skipped),
        "before": flow_summary(done),
        "after": flow_summary(after),
        "after_flow": [new.get("flow") for new in after],
        "per_call": [
            {
                "call": _seed(old),
                "scenario": (old.get("header") or {}).get("scenario"),
                "before": flow_scores(old),
                "after": flow_scores(new),
            }
            for old, new in zip(done, after)
        ],
    }


async def rejudge_runs(
    runs: Sequence[tuple[str, Sequence[Mapping[str, Any]]]],
    judge: Any,
    *,
    scrub: Callable[[object], str] | None = None,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Ask ``judge`` (a ``FlowJudge``) once per judgeable record, on a copy; the means before and after.

    A record the in-run judge would not have judged (an error, no rows) is carried over unjudged, so
    "before" and "after" cover the same calls.  A failed judge call is an error verdict and the run goes
    on.  ``progress`` gets the report so far (``partial: True``) after every record.
    """
    scrub = scrub or Scrubber()
    report: dict[str, Any] = {"rubric": rubric_info(), "partial": True, "runs": []}
    for name, records in runs:
        after: list[dict[str, Any]] = []
        skipped: list[str] = []
        report["runs"].append(_run_entry(name, records, after, skipped))
        for record in records:
            copy = json.loads(json.dumps(record))
            if judgeable(record):
                copy["flow"] = await judge_one(judge, copy, scrub)
            else:
                skipped.append(_seed(record))
            after.append(copy)
            report["runs"][-1] = _run_entry(name, records, after, skipped)
            if progress is not None:
                progress({**report, "runs": list(report["runs"])})  # a snapshot, not the live dict
    report["partial"] = False
    return report


def _mean(summary: Mapping[str, Any], axis: str) -> str:
    value = (summary.get("means") or {}).get(axis)
    return "n/a" if value is None else f"{value:.2f}"


def render_rejudge_markdown(report: Mapping[str, Any]) -> list[str]:
    rubric = report.get("rubric") or {}
    lines = ["# Flow re-judge", "", f"Rubric {rubric.get('sha256')} with switches {rubric.get('switches')}.", ""]
    if report.get("partial"):
        lines += ["PARTIAL: the re-judge has not finished; the means cover the records judged so far.", ""]
    for run in report.get("runs") or []:
        if run.get("skipped"):
            lines.append(f"{run['name']}: {len(run['skipped'])} broken or empty call(s) carried over unjudged, "
                         "as in the run.")
    if any(run.get("skipped") for run in report.get("runs") or []):
        lines.append("")
    lines += ["| run | calls | when | " + " | ".join(AXES) + " |", "|" + "---|" * (len(AXES) + 3)]
    for run in report.get("runs") or []:
        for when in ("before", "after"):
            cells = " | ".join(_mean(run[when], axis) for axis in AXES)
            lines.append(f"| {run['name']} | {run['calls']} | {when} | {cells} |")
    return lines


def main(argv: Sequence[str] | None = None) -> int:
    from rehearsal import llm
    from rehearsal.flow_judge import FlowJudge
    from rehearsal.full_run import DEFAULT_JUDGE_MODEL

    parser = argparse.ArgumentParser(prog="python -m rehearsal.rejudge")
    parser.add_argument("runs", nargs="+", help="run directories holding calls/*.json")
    parser.add_argument("--out", required=True)
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--budget-usd", type=float, default=1.0)
    args = parser.parse_args(argv)
    runs = load_runs(args.runs)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    ledger = llm.Ledger(budget_usd=args.budget_usd)
    scrub: Callable[[object], str] = llm.Scrubber()
    latest: dict[str, Any] = {}

    def save(report: Mapping[str, Any]) -> str:
        """Both files, scrubbed; written after every record so a stop never loses paid verdicts."""
        full = {**report, "ledger": ledger.summary()}
        latest.clear()
        latest.update(full)
        (out / "rejudge.json").write_text(
            scrub(json.dumps(full, indent=1, default=str)), encoding="utf-8", newline="\n"
        )
        markdown = scrub("\n".join(render_rejudge_markdown(full)) + "\n")
        (out / "rejudge.md").write_text(markdown, encoding="utf-8", newline="\n")
        return markdown

    async def go() -> dict[str, Any]:
        nonlocal scrub
        env = llm.load_api_env()
        scrub = llm.Scrubber([env[llm.KEY_NAME]])
        client = llm.HttpxDeepSeek(env, ledger)
        try:
            return await rejudge_runs(runs, FlowJudge(client, args.judge_model), scrub=scrub, progress=save)
        finally:
            await client.aclose()

    try:
        report = asyncio.run(go())
    except llm.MissingKey as exc:
        print(f"STOPPED: {exc}")
        return 2
    except BaseException:
        if latest:  # what was judged before the stop is already on disk; say so
            print(f"STOPPED after {sum(run.get('done', 0) for run in latest.get('runs') or [])} records; "
                  f"partial report in {out}")
        raise
    print(save(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
