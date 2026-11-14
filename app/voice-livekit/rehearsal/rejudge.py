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
from typing import Any, Mapping, Sequence

from rehearsal import flags
from rehearsal.flow_judge import AXES, flow_scores, flow_summary, rubric_text


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


async def rejudge_runs(runs: Sequence[tuple[str, Sequence[Mapping[str, Any]]]], judge: Any) -> dict[str, Any]:
    """Ask ``judge`` (a ``FlowJudge``) once per record, on a copy; the means before and after per run."""
    report: dict[str, Any] = {"rubric": rubric_info(), "runs": []}
    for name, records in runs:
        after = []
        for record in records:
            copy = json.loads(json.dumps(record))
            copy["flow"] = await judge.judge(copy)
            after.append(copy)
        report["runs"].append(
            {
                "name": name,
                "calls": len(records),
                "before": flow_summary(records),
                "after": flow_summary(after),
                "per_call": [
                    {
                        "call": _seed(old),
                        "scenario": (old.get("header") or {}).get("scenario"),
                        "before": flow_scores(old),
                        "after": flow_scores(new),
                    }
                    for old, new in zip(records, after)
                ],
            }
        )
    return report


def _mean(summary: Mapping[str, Any], axis: str) -> str:
    value = (summary.get("means") or {}).get(axis)
    return "n/a" if value is None else f"{value:.2f}"


def render_rejudge_markdown(report: Mapping[str, Any]) -> list[str]:
    rubric = report.get("rubric") or {}
    lines = ["# Flow re-judge", "", f"Rubric {rubric.get('sha256')} with switches {rubric.get('switches')}.", ""]
    lines += ["| run | calls | when | " + " | ".join(AXES) + " |", "|" + "---|" * (len(AXES) + 3)]
    for run in report.get("runs") or []:
        for when in ("before", "after"):
            cells = " | ".join(_mean(run[when], axis) for axis in AXES)
            lines.append(f"| {run['name']} | {run['calls']} | {when} | {cells} |")
    return lines


def main(argv: Sequence[str] | None = None) -> int:
    from rehearsal.flow_judge import FlowJudge
    from rehearsal.full_run import DEFAULT_JUDGE_MODEL
    from rehearsal.llm import HttpxDeepSeek, Ledger, MissingKey, load_api_env

    parser = argparse.ArgumentParser(prog="python -m rehearsal.rejudge")
    parser.add_argument("runs", nargs="+", help="run directories holding calls/*.json")
    parser.add_argument("--out", required=True)
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--budget-usd", type=float, default=1.0)
    args = parser.parse_args(argv)
    runs = load_runs(args.runs)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    async def go() -> dict[str, Any]:
        ledger = Ledger(budget_usd=args.budget_usd)
        client = HttpxDeepSeek(load_api_env(), ledger)
        try:
            report = await rejudge_runs(runs, FlowJudge(client, args.judge_model))
        finally:
            await client.aclose()
        report["ledger"] = ledger.summary()
        return report

    try:
        report = asyncio.run(go())
    except MissingKey as exc:
        print(f"STOPPED: {exc}")
        return 2
    (out / "rejudge.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8", newline="\n")
    markdown = "\n".join(render_rejudge_markdown(report)) + "\n"
    (out / "rejudge.md").write_text(markdown, encoding="utf-8", newline="\n")
    print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
