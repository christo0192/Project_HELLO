#!/usr/bin/env python3
"""Offline accuracy and latency eval of R1's end-intent classifier (owner decision 2026-10-30).

The worker asks a quick model whether a role-play turn that the keyword prefilter hits means
"end the interview / role play now" (``r1_end_intent``).  This tool runs that exact path over
the labelled set ``tests/fixtures/r1_end_intent_labels.jsonl`` (the owner's end-request sweep
with the labels the design gave them, the answers after L-ASIDE-END, the tracker tests' in-role
negatives and real advisor turns) and reports what the worker would DO with each turn:

* ``label``: what the turn means (``end``, ``maybe``, ``no``); ``also_ok`` lists the other
  outcomes that are acceptable for it (after L-ASIDE-END, "end" and "maybe" both confirm).
* the decision is ``r1_tracker.end_intent_level(text, verdict)``, the worker's rails, where the
  verdict is the model's answer (or None when the worker would not ask: a prefilter miss, the
  lexical fast path, a bare yes after the question).

It prints the accuracy, the confusion matrix (label x decision), the CRITICAL false ends (an
in-role "no" turn the worker would end the role-play on, before any question and again as if an
earlier L-ASIDE-END had been asked and declined, where a request exits at once), the false
asides, the misses, the call
latency (p50 / p95 / max, timeouts at the worker's budget) and the prefilter hit rate on the advisor
corpus (what share of normal turns would call the model at all).

Usage (from app/voice-livekit; the live mode needs DEEPSEEK_API_KEY and R1's LLM settings):

    python tools/r1_end_intent_eval.py                 # the model, as the worker calls it
    python tools/r1_end_intent_eval.py --offline       # the lexical baseline, no key, no network
        [--limit N] [--concurrency 4] [--timeout 1.3] [--corpus] [--json results.json]

``--corpus`` adds every advisor-corpus turn the prefilter hits (label "no") that the fixture does
not hold yet.  ``--timeout`` defaults to ``R1_END_INTENT_TIMEOUT_SEC`` (1.3 s).  Exit code 0, or 1
with ``--strict`` when any critical false end (in either mode) is found.  Never imported by the
worker.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Sequence

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from r1_end_intent import (  # noqa: E402
    END_INTENT_LABELS,
    build_end_intent_messages,
    end_intent_timeout_sec,
    parse_end_intent,
    prefilter_hit,
)
from r1_tracker import (  # noqa: E402
    confirms_end,
    declines_end,
    end_intent_level,
    explicit_end_request,
    is_bare_yes,
)

FIXTURE = HERE / "tests" / "fixtures" / "r1_end_intent_labels.jsonl"
CORPUS = HERE / "tests" / "fixtures" / "r1_advisor_corpus.jsonl"
HELDOUT = HERE / "tests" / "fixtures" / "r1_advisor_heldout.jsonl"
CONTEXTS = ("roleplay", "after_aside")
# The interviewer's question as the candidate hears it (persona p1 v1), for the after-aside rows.
ASIDE_QUESTION = (
    "This is Christy, your interviewer. If you want to end the interview now, please say: end the "
    "interview. Otherwise, just carry on with Meera Iyer."
)


def load_rows(path: Path = FIXTURE) -> list[dict[str, Any]]:
    """The labelled rows (one JSON object per line)."""
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def validate_rows(rows: Sequence[dict[str, Any]]) -> list[str]:
    """Every problem with the labelled set (empty when it is well formed)."""
    problems: list[str] = []
    seen: set[str] = set()
    for row in rows:
        ident = row.get("id")
        if not isinstance(ident, str) or ident in seen:
            problems.append(f"bad or duplicate id: {ident!r}")
        seen.add(str(ident))
        if not isinstance(row.get("text"), str):
            problems.append(f"{ident}: text is not a string")
        if row.get("label") not in END_INTENT_LABELS:
            problems.append(f"{ident}: label {row.get('label')!r}")
        also = row.get("also_ok")
        if not isinstance(also, list) or any(item not in END_INTENT_LABELS for item in also):
            problems.append(f"{ident}: also_ok {also!r}")
        if row.get("context") not in CONTEXTS:
            problems.append(f"{ident}: context {row.get('context')!r}")
    return problems


def corpus_rows(known: Iterable[str], limit: int | None = None) -> list[dict[str, Any]]:
    """The advisor-corpus turns the prefilter hits, as "no" rows the fixture does not hold yet."""
    have = {text.strip().lower() for text in known}
    out: list[dict[str, Any]] = []
    for path in (CORPUS, HELDOUT):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line:
                continue
            text = json.loads(line)["text"]
            if prefilter_hit(text) and text.strip().lower() not in have:
                have.add(text.strip().lower())
                out.append({
                    "id": f"{path.stem}:{number}", "text": text, "label": "no", "also_ok": [],
                    "context": "roleplay", "source": path.stem,
                })
    return out[:limit] if limit is not None else out


def would_ask(row: dict[str, Any]) -> bool:
    """Whether the worker asks the model about this turn (``R1Interview._end_intent_wanted``)."""
    text = row["text"]
    if not prefilter_hit(text) or explicit_end_request(text):
        return False
    return not (row["context"] == "after_aside" and is_bare_yes(text))


def decide(
    row: dict[str, Any], verdict: str | None, *, after_closed_aside: bool = False
) -> str:
    """What the worker does with the turn: the rails over the verdict (None: lexical only).

    * Before any question (a ``roleplay`` row): ``end_intent_level`` as it stands, so "end" exits,
      "maybe" asks L-ASIDE-END and "no" stays in role.
    * While the question is open (an ``after_aside`` row): a settled bare yes (``is_bare_yes``),
      the plainest stop (``confirms_end``) and ANY end request ("maybe" as much as "end") exit,
      unless the answer declines (``declines_end``), so "maybe" reads "end" here (reviewed fix: it
      read as a mere question and was scored as harmless).
    * ``after_closed_aside`` (a ``roleplay`` row scored as if an earlier question had been asked
      and declined): a request then confirms the stop at once, so a "maybe" the candidate's own
      words make exits ("end"), while a model-only "maybe" is dropped (``RolePlayEngine.plan_turn``)
      and stays in role ("no").
    """
    text = row["text"]
    if row["context"] == "after_aside":
        if is_bare_yes(text) or confirms_end(text):
            return "end"
        if declines_end(text):
            return "no"
        return "end" if end_intent_level(text, verdict) != "no" else "no"
    level = end_intent_level(text, verdict)
    if not after_closed_aside:
        return level
    if declines_end(text):
        return "no"
    if level == "maybe" and end_intent_level(text, None) == "no":
        return "no"
    return "end" if level == "maybe" else level


def prefilter_rate(paths: Sequence[Path] = (CORPUS, HELDOUT)) -> dict[str, Any]:
    """Share of normal role-play turns that would call the model at all."""
    out: dict[str, Any] = {}
    for path in paths:
        texts = [json.loads(line)["text"] for line in path.read_text(encoding="utf-8").splitlines()
                 if line]
        hits = sum(1 for text in texts if prefilter_hit(text))
        out[path.stem] = {"turns": len(texts), "hits": hits,
                          "share": round(hits / len(texts), 4) if texts else None}
    return out


def _percentile(values: Sequence[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * q // 100))  # nearest rank
    return round(ordered[int(rank) - 1], 3)


def summarise(results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Accuracy, the confusion matrix and the error lists of a run (``results`` from ``run``)."""
    confusion: Counter[tuple[str, str]] = Counter()
    correct = 0
    critical: list[dict[str, Any]] = []
    false_aside: list[dict[str, Any]] = []
    misses: list[dict[str, Any]] = []
    # The same rows scored as if an earlier question had been asked and declined, where a request
    # exits at once (``decide(..., after_closed_aside=True)``): an in-role "no" ending there is as
    # critical as one ending before any question.
    critical_after: list[dict[str, Any]] = []
    for item in results:
        label, decision = item["label"], item["decision"]
        confusion[(label, decision)] += 1
        later = item.get("decision_after_closed_aside", decision)
        if label == "no" and later == "end" and "end" not in item.get("also_ok", []):
            critical_after.append(item)
        ok = decision == label or decision in item.get("also_ok", [])
        correct += ok
        if ok:
            continue
        if decision == "end" and label == "no":
            critical.append(item)
        elif decision == "maybe" and label == "no":
            false_aside.append(item)
        elif decision == "no" and label != "no":
            misses.append(item)
    latencies = [item["seconds"] for item in results if item.get("seconds") is not None]
    asked = [item for item in results if item.get("asked")]
    return {
        "rows": len(results),
        "accuracy": round(correct / len(results), 4) if results else None,
        "confusion": {f"{label}->{decision}": count
                      for (label, decision), count in sorted(confusion.items())},
        "critical_false_end": len(critical),
        "critical_false_end_texts": [item["text"] for item in critical],
        "critical_false_end_after_closed_aside": len(critical_after),
        "critical_false_end_after_closed_aside_texts": [item["text"] for item in critical_after],
        "false_aside": len(false_aside),
        "false_aside_texts": [item["text"] for item in false_aside],
        "missed": len(misses),
        "missed_texts": [item["text"] for item in misses],
        "asked_model": len(asked),
        "timeouts": sum(1 for item in asked if item.get("outcome") == "timeout"),
        "errors": sum(1 for item in asked if item.get("outcome") == "error"),
        "parse_failed": sum(1 for item in asked if item.get("outcome") == "parse_failed"),
        "call_p50_sec": _percentile(latencies, 50),
        "call_p95_sec": _percentile(latencies, 95),
        "call_max_sec": round(max(latencies), 3) if latencies else None,
    }


async def _classify(
    client: Any, row: dict[str, Any], number: int, timeout: float
) -> dict[str, Any]:
    from r1_replies import delta_text
    from r1_session import _chat_context_from

    messages = build_end_intent_messages(
        row["text"],
        context=row["context"],
        learner_last="",
        question=ASIDE_QUESTION if row["context"] == "after_aside" else "",
        seed="r1-end-intent-eval",
        turn=number,
    )
    started = time.perf_counter()

    async def call() -> str:
        parts: list[str] = []
        async with client.chat(chat_ctx=_chat_context_from(messages)) as stream:
            async for chunk in stream:
                parts.append(delta_text(chunk))
        return "".join(parts)

    try:
        raw = await asyncio.wait_for(call(), timeout)
    except asyncio.TimeoutError:
        return {"verdict": None, "outcome": "timeout", "seconds": time.perf_counter() - started}
    except Exception as exc:  # noqa: BLE001 - an eval row, not a crash
        return {"verdict": None, "outcome": "error", "error": type(exc).__name__,
                "seconds": time.perf_counter() - started}
    verdict = parse_end_intent(raw)
    return {"verdict": verdict, "outcome": verdict or "parse_failed",
            "seconds": time.perf_counter() - started, "raw": raw[:200]}


async def run(
    rows: Sequence[dict[str, Any]], *, offline: bool, concurrency: int, timeout: float
) -> list[dict[str, Any]]:
    """Decide every row the way the worker would (the model is asked only where it would be)."""
    client = None
    if not offline:
        from r1_llm import build_r1_judge_llm

        client = build_r1_judge_llm()
    gate = asyncio.Semaphore(max(1, concurrency))

    async def one(number: int, row: dict[str, Any]) -> dict[str, Any]:
        item = {key: row[key] for key in ("id", "text", "label", "also_ok", "context")}
        item["asked"] = would_ask(row) and not offline
        item["model_verdict"] = None
        item["seconds"] = None
        if item["asked"]:
            async with gate:
                answer = await _classify(client, row, number, timeout)
            item.update({
                "model_verdict": answer["verdict"], "outcome": answer["outcome"],
                "seconds": round(answer["seconds"], 3),
            })
        item["decision"] = decide(row, item["model_verdict"])
        item["decision_after_closed_aside"] = (
            decide(row, item["model_verdict"], after_closed_aside=True)
            if row["context"] == "roleplay"
            else item["decision"]
        )
        return item

    return list(await asyncio.gather(*(one(n, row) for n, row in enumerate(rows, 1))))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--offline", action="store_true", help="lexical baseline, no model")
    parser.add_argument("--limit", type=int, default=None, help="only the first N rows")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=None, help="per-call budget (seconds)")
    parser.add_argument("--corpus", action="store_true", help="add the corpus prefilter hits")
    parser.add_argument("--json", dest="json_path", default=None, help="write per-row results")
    parser.add_argument("--strict", action="store_true", help="exit 1 on a critical false end")
    args = parser.parse_args(argv)
    rows = load_rows()
    problems = validate_rows(rows)
    if problems:
        print("fixture problems:", *problems, sep="\n  ")
        return 2
    if args.corpus:
        rows = rows + corpus_rows(row["text"] for row in rows)
    if args.limit is not None:
        rows = rows[: args.limit]
    timeout = end_intent_timeout_sec() if args.timeout is None else args.timeout
    results = asyncio.run(
        run(rows, offline=args.offline, concurrency=args.concurrency, timeout=timeout)
    )
    summary = summarise(results)
    summary["mode"] = "offline" if args.offline else "model"
    summary["timeout_sec"] = timeout
    summary["prefilter_rate"] = prefilter_rate()
    print(json.dumps(summary, indent=2, ensure_ascii=True))
    if args.json_path:
        Path(args.json_path).write_text(json.dumps(results, indent=1, ensure_ascii=True),
                                        encoding="utf-8")
    if args.strict and (
        summary["critical_false_end"] or summary["critical_false_end_after_closed_aside"]
    ):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
